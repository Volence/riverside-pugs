import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import { makeOptionalViewer, makeRequireActive } from './guards.js';
import { getPlayer } from '../players.js';
import { competitiveAccess } from '../teams/access.js';
import { inGoodStanding } from '../standing.js';
import { liveTeams, myTeams } from '../teams/teams.js';
import { getCampaignPool, settingNumber } from '../settings.js';
import { campaignRegistry } from '../campaignRegistry.js';
import { bookingLimits, estimateOptions, typicalCampaignMinutes } from '../bookings/rules.js';
import { canUse, seesBooking } from '../bookings/bookings.js';
import type { BookingRunner } from '../bookings/runner.js';
import type { Notifier } from '../notify/notify.js';
import * as S from '../scrims/scrims.js';
import { scrimMessage, scrimSideManagers, teamManagers, type ScrimNotifyType } from '../scrims/messages.js';
import { nightWindow } from '../scrims/night.js';
import { showSr } from '../scrims/rules.js';
import { BLOCK_ERRORS, blocksOf, blockTarget, managesBlockParty, unblock, type BlockParty } from '../scrims/blocks.js';

export interface ScrimRoutesOpts {
  db: DB;
  /** Null only in tests that build the routes bare. */
  runner: BookingRunner | null;
  notifier: Notifier;
  publicUrl: string;
}

const NOT_FOUND = { error: 'not found' };

/**
 * The scrim board's routes (spec part 4; scrim board plan 1, Task 3). Every
 * route answers 404 to a viewer the competitive switch keeps out (staff in
 * good standing excepted), before anything else, exactly as
 * src/routes/bookings.ts does. The domain module (src/scrims/scrims.ts)
 * decides everything; these only translate, and send the notices its result
 * calls for.
 */
export async function scrimRoutes(app: FastifyInstance, opts: ScrimRoutesOpts): Promise<void> {
  const { db, runner, notifier, publicUrl } = opts;
  const optionalViewer = makeOptionalViewer(db);
  const requireActive = makeRequireActive(db);
  const isStaff = (steamid: string): boolean => {
    const p = getPlayer(db, steamid);
    return !!p && (p.is_admin === 1 || p.is_mod === 1);
  };
  /** Staff in good standing pass whatever the switch says, as in bookings. */
  const allowed = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const viewer = optionalViewer(req);
    const staffViewer = !!viewer && isStaff(viewer) && inGoodStanding(db, viewer);
    if (!staffViewer && !competitiveAccess(db, viewer)) { reply.code(404).send(NOT_FOUND); return null; }
    return requireActive(req, reply);
  };
  const refuse = (reply: FastifyReply, r: { error: S.ScrimError; text?: string; nearestSlot?: string | null }) => {
    const def = S.SCRIM_ERRORS[r.error];
    const out: Record<string, unknown> = { error: r.text ?? def.text };
    if (r.error === 'no_capacity') out.nearestSlot = r.nearestSlot ?? null;
    return reply.code(def.status).send(out);
  };
  const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>;
  /** The id path param, or null for anything that is not a positive integer
   *  (never handed to a prepared statement, which rejects NaN outright). */
  const idParam = (req: FastifyRequest): number | null => {
    const id = Number((req.params as { id: string }).id);
    return Number.isInteger(id) && id > 0 ? id : null;
  };
  /** Never throws: a notice runs after a committed write, and a failure to
   *  word or send it must not undo the caller's work (the route's answer). */
  const tell = (steamids: Iterable<string>, type: ScrimNotifyType, postId: number, extra: Parameters<typeof scrimMessage>[4] = {}) => {
    try {
      const payload = scrimMessage(db, publicUrl, postId, type, extra);
      if (payload) notifier.send(steamids, type, payload);
    } catch (err) {
      console.warn(`[scrims] ${type} notice failed:`, err instanceof Error ? err.message : err);
    }
  };

  app.get('/api/scrims/options', async (req, reply) => {
    const me = allowed(req, reply);
    if (!me) return;
    const registry = campaignRegistry(db);
    const limits = bookingLimits(db);
    const team = (t: { id: number; slug: string; name: string; tag: string }) => ({ id: t.id, slug: t.slug, name: t.name, tag: t.tag });
    const campaigns = getCampaignPool(db).filter((slug) => registry.get(slug));
    return {
      campaigns: campaigns.map((slug) => ({ slug, name: registry.get(slug)!.name, minutes: typicalCampaignMinutes(db, slug) })),
      limits: {
        daysAhead: limits.daysAhead, playlistMax: limits.playlistMax, noteMax: S.NOTE_MAX,
        acceptCampaignsMax: settingNumber(db, 'scrim_accept_campaigns_max', 2, { integer: true, min: 0, max: 4 }),
      },
      // A post's block is estimated from its campaigns, as a booking's slot is.
      estimate: estimateOptions(db, campaigns),
      myTeams: myTeams(db, me).filter((t) => t.role !== 'member').map(team),
      teams: liveTeams(db).map(team),
      // scrim_show_sr: off, the page hides the SR range, the fit filter and
      // every SR figure.
      showSr: showSr(db),
    };
  });

  app.get('/api/scrims', async (req, reply) => {
    const me = allowed(req, reply);
    if (!me) return;
    reply.header('Cache-Control', 'no-store');
    const q = req.query as { fitsOnly?: string };
    return {
      posts: S.board(db, { steamid: me, staff: isStaff(me) }, { fitsOnly: q.fitsOnly === '1' }),
      // Plan 2 Ruling 7: the board's banner, null while scrim night is off.
      night: nightWindow(db),
      showSr: showSr(db),
    };
  });

  app.post('/api/scrims', async (req, reply) => {
    const me = allowed(req, reply);
    if (!me) return;
    const b = body(req);
    const r = S.createPost(db, {
      by: me, teamId: b.teamId, startsAt: b.startsAt, campaigns: b.campaigns,
      srRange: b.srRange, note: b.note, targetTeamId: b.targetTeamId,
    });
    if (!r.ok) return refuse(reply, r);
    if (typeof b.targetTeamId === 'number' && Number.isInteger(b.targetTeamId)) {
      // Only managers who could actually use the board get the DM: one who
      // fails canUse (the same gate createPost and acceptPost check) would
      // open a page that 404s for them.
      const recipients = teamManagers(db, b.targetTeamId).filter((m) => canUse(db, m));
      tell(recipients, 'scrim_challenge', r.value.id);
    }
    return reply.code(201).send({ id: r.value.id });
  });

  app.post('/api/scrims/repost/:bookingId', async (req, reply) => {
    const me = allowed(req, reply);
    if (!me) return;
    const bookingId = Number((req.params as { bookingId: string }).bookingId);
    if (!Number.isInteger(bookingId) || bookingId <= 0) return reply.code(404).send(NOT_FOUND);
    // Someone the booking is hidden from gets the same flat 404 as the
    // booking routes give, so the refusals below never tell a stranger
    // whether a booking exists or what state it is in.
    if (!seesBooking(db, bookingId, { steamid: me, staff: isStaff(me) })) return reply.code(404).send(NOT_FOUND);
    const r = S.repostFromBooking(db, { bookingId, by: me });
    if (!r.ok) return refuse(reply, r);
    return reply.code(201).send({ id: r.value.id });
  });

  // ---------- blocks (scrim blocks plan) ----------
  // The side is a team the viewer manages (teamId), or, without one, the
  // viewer as a pickup captain. Only the side's managers ever see its list.

  /** The party a block route acts for, or undefined for a teamId that is
   *  not a positive integer. */
  const blockParty = (raw: unknown, me: string): BlockParty | undefined => {
    if (raw === undefined || raw === null || raw === '') return { captain: me };
    const id = typeof raw === 'string' ? Number(raw) : raw;
    return Number.isInteger(id) && (id as number) > 0 ? { teamId: id as number } : undefined;
  };
  const refuseBlock = (reply: FastifyReply, error: keyof typeof BLOCK_ERRORS) =>
    reply.code(BLOCK_ERRORS[error].status).send({ error: BLOCK_ERRORS[error].text });

  app.get('/api/scrims/blocks', async (req, reply) => {
    const me = allowed(req, reply);
    if (!me) return;
    const party = blockParty((req.query as { teamId?: string }).teamId, me);
    if (!party || !managesBlockParty(db, party, me)) return reply.code(404).send(NOT_FOUND);
    reply.header('Cache-Control', 'no-store');
    return { blocks: blocksOf(db, party) };
  });

  app.post('/api/scrims/blocks', async (req, reply) => {
    const me = allowed(req, reply);
    if (!me) return;
    const b = body(req);
    const party = blockParty(b.teamId, me);
    if (!party) return reply.code(404).send(NOT_FOUND);
    const r = blockTarget(db, { by: me, party, target: b.target });
    if (!r.ok) return refuseBlock(reply, r.error);
    // Ruling 5: the blocked side's acceptances declined here get the
    // ordinary decline notice, which names no block.
    for (const acceptId of r.value.declinedAcceptIds) {
      const accept = S.getAccept(db, acceptId);
      if (accept) tell(scrimSideManagers(db, accept), 'scrim_declined', accept.post_id);
    }
    return { added: r.value.added };
  });

  app.post('/api/scrims/blocks/remove', async (req, reply) => {
    const me = allowed(req, reply);
    if (!me) return;
    const b = body(req);
    const party = blockParty(b.teamId, me);
    if (!party) return reply.code(404).send(NOT_FOUND);
    const r = unblock(db, { by: me, party, target: b.target });
    if (!r.ok) return refuseBlock(reply, r.error);
    return r.value;
  });

  app.post('/api/scrims/:id/withdraw', async (req, reply) => {
    const me = allowed(req, reply);
    if (!me) return;
    const id = idParam(req);
    if (id === null) return reply.code(404).send(NOT_FOUND);
    const r = S.withdrawPost(db, { postId: id, by: me });
    if (!r.ok) return refuse(reply, r);
    for (const acceptId of r.value.acceptIds) {
      const accept = S.getAccept(db, acceptId);
      if (accept) tell(scrimSideManagers(db, accept), 'scrim_declined', id, { reason: 'the post was withdrawn' });
    }
    return r.value;
  });

  app.post('/api/scrims/:id/accept', async (req, reply) => {
    const me = allowed(req, reply);
    if (!me) return;
    const id = idParam(req);
    if (id === null) return reply.code(404).send(NOT_FOUND);
    const b = body(req);
    const r = S.acceptPost(db, { postId: id, by: me, teamId: b.teamId, campaigns: b.campaigns });
    if (!r.ok) return refuse(reply, r);
    const post = S.getPost(db, id);
    if (post) tell(scrimSideManagers(db, post), 'scrim_accepted', id, { acceptId: r.value.id });
    return reply.code(200).send(r.value);
  });

  app.post('/api/scrims/accepts/:id/withdraw', async (req, reply) => {
    const me = allowed(req, reply);
    if (!me) return;
    const id = idParam(req);
    if (id === null) return reply.code(404).send(NOT_FOUND);
    const r = S.withdrawAccept(db, { acceptId: id, by: me });
    if (!r.ok) return refuse(reply, r);
    return r.value;
  });

  app.post('/api/scrims/accepts/:id/decline', async (req, reply) => {
    const me = allowed(req, reply);
    if (!me) return;
    const id = idParam(req);
    if (id === null) return reply.code(404).send(NOT_FOUND);
    // Read before declineAccept writes: its own side, for the notice.
    const accept = S.getAccept(db, id);
    const r = S.declineAccept(db, { acceptId: id, by: me });
    if (!r.ok) return refuse(reply, r);
    if (accept) tell(scrimSideManagers(db, accept), 'scrim_declined', accept.post_id);
    return r.value;
  });

  app.post('/api/scrims/accepts/:id/confirm', async (req, reply) => {
    const me = allowed(req, reply);
    if (!me) return;
    const id = idParam(req);
    if (id === null) return reply.code(404).send(NOT_FOUND);
    // Read before confirmAccept writes: neither row's side fields (team_id,
    // captain_steamid) change in the write, only status and responded_at.
    const accept = S.getAccept(db, id);
    const post = accept ? S.getPost(db, accept.post_id) : undefined;
    const r = S.confirmAccept(db, { acceptId: id, by: me });
    if (!r.ok) {
      // The slot was taken from under this acceptance: the poster sees the
      // refusal and its nearestSlot right here in this response. The
      // acceptance itself stays pending (the poster can try again, or pick
      // another), so the accepter is not DMed about it: that DM would read
      // as final and would repeat on every further Confirm click.
      return refuse(reply, r);
    }
    const { bookingId, takenAcceptIds } = r.value;
    // The booking is already created AND confirmed inside confirmAccept's own
    // transaction; onCreated/onConfirmed would send booking_invite and
    // booking_confirmed DMs that are stale or duplicate here (scrim_booked,
    // below, is the one notice this flow sends). allocate() still runs, as
    // every booking needs its box claimed; a throw there must not cost the
    // response or the notices below, which is why it is caught here.
    try {
      runner?.allocate();
    } catch (err) {
      console.error('[scrims] allocate() after confirm failed:', err instanceof Error ? err.message : err);
    }
    if (post && accept) {
      tell([...scrimSideManagers(db, post), ...scrimSideManagers(db, accept)], 'scrim_booked', post.id, { bookingId });
    }
    for (const takenId of takenAcceptIds) {
      const taken = S.getAccept(db, takenId);
      if (taken) tell(scrimSideManagers(db, taken), 'scrim_taken', taken.post_id);
    }
    return reply.code(200).send({ bookingId });
  });
}
