import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import { makeOptionalViewer, makeRequireActive } from './guards.js';
import { getPlayer } from '../players.js';
import { competitiveAccess } from '../teams/access.js';
import { inGoodStanding } from '../standing.js';
import { liveTeams, myTeams } from '../teams/teams.js';
import { getCampaignPool } from '../settings.js';
import { campaignRegistry } from '../campaignRegistry.js';
import * as B from '../bookings/bookings.js';
import { bookingLimits, typicalCampaignMinutes, STEP_MINUTES } from '../bookings/rules.js';
import { isNotifyType, prefsOf, setPref } from '../notify/notify.js';
import type { BookingRunner } from '../bookings/runner.js';

export interface BookingRoutesOpts {
  db: DB;
  /** Null only in tests that build the routes bare. */
  runner: BookingRunner | null;
}

const NOT_FOUND = { error: 'not found' };

/**
 * Server bookings for players (plan 4a). Every route answers 404 to a viewer
 * the competitive switch keeps out (staff in good standing excepted), before
 * anything else, so nothing says the routes exist. Every /:id route answers 404 to a viewer the booking is
 * not shown to (bookingView null), so a stranger cannot learn which ids exist.
 * The domain module decides everything; these only translate.
 */
export async function bookingRoutes(app: FastifyInstance, opts: BookingRoutesOpts): Promise<void> {
  const { db, runner } = opts;
  const optionalViewer = makeOptionalViewer(db);
  const requireActive = makeRequireActive(db);
  const isStaff = (steamid: string): boolean => {
    const p = getPlayer(db, steamid);
    return !!p && (p.is_admin === 1 || p.is_mod === 1);
  };
  /** Staff in good standing pass whatever the switch says, so a moderator
   *  can open a booking page under 'admins' or 'off' (the domain still
   *  decides what they may do there). */
  const allowed = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const viewer = optionalViewer(req);
    const staffViewer = !!viewer && isStaff(viewer) && inGoodStanding(db, viewer);
    if (!staffViewer && !competitiveAccess(db, viewer)) { reply.code(404).send(NOT_FOUND); return null; }
    return requireActive(req, reply);
  };
  const refuse = (reply: FastifyReply, error: B.BookingError) =>
    reply.code(B.BOOKING_ERRORS[error].status).send({ error: B.BOOKING_ERRORS[error].text });
  /** The booking id from the URL and the viewer, when the viewer may see it. */
  const visible = (req: FastifyRequest, reply: FastifyReply): { me: string; id: number } | null => {
    const me = allowed(req, reply);
    if (!me) return null;
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id < 1 || !B.bookingView(db, id, { steamid: me, staff: isStaff(me) })) {
      reply.code(404).send(NOT_FOUND);
      return null;
    }
    return { me, id };
  };
  const view = (me: string, id: number) => B.bookingView(db, id, { steamid: me, staff: isStaff(me) });
  const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>;

  app.get('/api/bookings/options', async (req, reply) => {
    const me = allowed(req, reply);
    if (!me) return;
    const registry = campaignRegistry(db);
    const limits = bookingLimits(db);
    const team = (t: { id: number; slug: string; name: string; tag: string }) => ({ id: t.id, slug: t.slug, name: t.name, tag: t.tag });
    return {
      campaigns: getCampaignPool(db).filter((slug) => registry.get(slug))
        .map((slug) => ({ slug, name: registry.get(slug)!.name, minutes: typicalCampaignMinutes(db, slug) })),
      rulesets: db.prepare('SELECT id, name FROM rulesets WHERE archived_at IS NULL ORDER BY id').all(),
      gameConfigs: db.prepare('SELECT key, label FROM game_configs WHERE enabled = 1 ORDER BY key').all(),
      limits: {
        minMinutes: limits.minMinutes, maxMinutes: limits.maxMinutes, daysAhead: limits.daysAhead,
        playlistMax: limits.playlistMax, stepMinutes: STEP_MINUTES, extendMinutes: limits.extendMinutes,
      },
      myTeams: myTeams(db, me).filter((t) => t.role !== 'member').map(team),
      teams: liveTeams(db).map(team),
    };
  });

  app.get('/api/bookings/mine', async (req, reply) => {
    const me = allowed(req, reply);
    if (!me) return;
    return { ...B.myBookings(db, me), prefs: prefsOf(db, me) };
  });

  app.post('/api/bookings/prefs', async (req, reply) => {
    const me = allowed(req, reply);
    if (!me) return;
    const { type, enabled } = body(req);
    if (!isNotifyType(type) || typeof enabled !== 'boolean') return reply.code(400).send({ error: 'A preference is a known type and on or off.' });
    setPref(db, me, type, enabled);
    return { prefs: prefsOf(db, me) };
  });

  app.post('/api/bookings', async (req, reply) => {
    const me = allowed(req, reply);
    if (!me) return;
    const b = body(req);
    const r = B.createBooking(db, {
      by: me, teamId: b.teamId, opponent: b.opponent, startsAt: b.startsAt, minutes: b.minutes,
      playlist: b.playlist, rulesetId: b.rulesetId, gameConfig: b.gameConfig,
    });
    if (!r.ok) return refuse(reply, r.error);
    runner?.onCreated(r.value.id);
    return reply.code(201).send({ id: r.value.id });
  });

  app.get('/api/bookings/:id', async (req, reply) => {
    const v = visible(req, reply);
    if (!v) return;
    reply.header('Cache-Control', 'no-store');
    return view(v.me, v.id);
  });

  /** One POST action on a booking: run it, then the follow-up, then the fresh view. */
  const action = (path: string, run: (me: string, id: number, req: FastifyRequest) => B.Result<unknown>, after?: (me: string, id: number, value: unknown, req: FastifyRequest) => void) => {
    app.post(`/api/bookings/:id/${path}`, async (req, reply) => {
      const v = visible(req, reply);
      if (!v) return;
      const r = run(v.me, v.id, req);
      if (!r.ok) return refuse(reply, r.error);
      after?.(v.me, v.id, r.value, req);
      return view(v.me, v.id);
    });
  };

  action('confirm', (me, id) => B.confirmBooking(db, { bookingId: id, by: me }), (_me, id) => { runner?.onConfirmed(id); runner?.allocate(); });
  action('decline', (me, id) => B.declineBooking(db, { bookingId: id, by: me }), (me, id) => runner?.onCancelled(id, me, null));
  action('accept', (me, id) => B.respondPerson(db, { bookingId: id, steamid: me, accept: true }));
  action('leave', (me, id) => {
    const row = db.prepare("SELECT status FROM booking_people WHERE booking_id = ? AND steamid = ?").get(id, me) as { status: string } | undefined;
    return row?.status === 'invited'
      ? B.respondPerson(db, { bookingId: id, steamid: me, accept: false })
      : B.removePerson(db, { bookingId: id, by: me, steamid: me });
  });
  action('cancel', (me, id, req) => B.cancelBooking(db, { bookingId: id, by: me, reason: body(req).reason }),
    (me, id) => runner?.onCancelled(id, me, B.getBooking(db, id)?.cancel_reason ?? null));
  action('extend', (me, id) => B.extendBooking(db, { bookingId: id, by: me }), (_me, id) => runner?.onExtended(id));
  action('no-show', (me, id) => B.claimNoShow(db, { bookingId: id, by: me }),
    (_me, id, value) => runner?.onNoShow(id, (value as { absent: B.Side }).absent));
  action('end', (me, id) => B.endBooking(db, { bookingId: id, by: me }), (_me, id) => runner?.settle(id));
  action('people', (me, id, req) => {
    const b = body(req);
    return B.addPerson(db, { bookingId: id, by: me, side: b.side, steamid: b.steamid, role: b.role });
  }, (me, id, _value, req) => runner?.onPersonAdded(id, String(body(req).steamid), me));

  app.post('/api/bookings/:id/people/:steamid/remove', async (req, reply) => {
    const v = visible(req, reply);
    if (!v) return;
    const r = B.removePerson(db, { bookingId: v.id, by: v.me, steamid: (req.params as { steamid: string }).steamid });
    if (!r.ok) return refuse(reply, r.error);
    return view(v.me, v.id);
  });
}
