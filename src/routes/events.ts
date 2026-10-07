import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import type { CommunityStore } from '../community/store.js';
import { bannerType } from '../community/validate.js';
import { getPlayer } from '../players.js';
import { makeOptionalViewer, makeRequireActive } from './guards.js';
import { competitiveAccess, competitivePublic } from '../teams/access.js';
import * as E from '../events/events.js';
import { getEventBySlug } from '../events/events.js';
import * as D from '../events/drafts.js';
import * as N from '../events/entries.js';
import * as P from '../events/play.js';
import * as R from '../events/room.js';
import * as S from '../events/schedule.js';
import { matchRoomView, prefsView } from '../events/roomViews.js';
import * as V from '../events/validate.js';
import { eventListItems, eventView, myEventView, signupView } from '../events/views.js';
import { tellReschedule, tellRosterAdded, tellTimeLocked } from '../events/notices.js';
import type { Notifier } from '../notify/notify.js';
import type { RoomClock } from '../events/roomClock.js';

const NOT_FOUND = { error: 'not found' };
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The public side of events (tournaments plan T1a/T1b): the list, one event
 * page, the viewer's own entries and teams to register, and the entry
 * mutation routes. Behind competitive_enabled exactly as the team pages are:
 * a signed-in viewer goes through competitiveAccess, a signed-out one is let
 * in only once the switch is at everyone. A draft is for staff, admins and
 * mods (Ruling 14): to anyone else it answers the very same 404 as a slug
 * that does not exist, so whether a draft exists cannot be read off the answer.
 */
export async function eventRoutes(
  app: FastifyInstance, opts: {
    db: DB; store: () => CommunityStore; notifier?: Notifier; publicUrl?: string; rooms?: RoomClock;
    /** The series engine (plan T3b): a pick on a live match hands the series
     *  on; confirm and dispute run the result's confirm window. */
    series?: {
      confirm(matchId: number, steamid: string): Promise<V.Checked<unknown>>;
      dispute(matchId: number, steamid: string, reason: unknown): V.Checked<unknown>;
      afterPick(matchId: number): void;
      reset(matchId: number, by: string): V.Checked<unknown>;
    };
  },
): Promise<void> {
  const { db } = opts;
  const optionalViewer = makeOptionalViewer(db);
  const allowedViewer = (req: FastifyRequest, reply: FastifyReply): { viewer: string | null } | null => {
    const viewer = optionalViewer(req);
    const allowed = viewer ? competitiveAccess(db, viewer) : competitivePublic(db);
    if (!allowed) { reply.code(404).send(NOT_FOUND); return null; }
    return { viewer };
  };
  const isStaff = (viewer: string | null): boolean => {
    const p = viewer ? getPlayer(db, viewer) : undefined;
    return !!p && (p.is_admin === 1 || p.is_mod === 1);
  };
  const requireActive = makeRequireActive(db);
  /** An active player the switch lets in, or the reply sent: the closed
   *  switch answers 404 before the login check, as the team routes do. */
  const allowedActive = (req: FastifyRequest, reply: FastifyReply): string | null => {
    if (!competitiveAccess(db, optionalViewer(req))) { reply.code(404).send(NOT_FOUND); return null; }
    return requireActive(req, reply);
  };
  const visibleEvent = (slug: string, viewer: string | null): E.EventRow | undefined => {
    const ev = getEventBySlug(db, slug);
    return ev && (ev.status !== 'draft' || isStaff(viewer)) ? ev : undefined;
  };
  const refuse = (reply: FastifyReply, r: { error: V.EventError; detail?: V.EntryProblem[] }) =>
    reply.code(V.EVENT_ERRORS[r.error].status).send({
      error: V.EVENT_ERRORS[r.error].text,
      ...(r.detail ? { problems: r.detail.map((p) => ({ steamid: p.steamid, name: getPlayer(db, p.steamid)?.name ?? p.steamid, problems: p.problems })) } : {}),
    });
  const entryIn = (ev: E.EventRow, raw: string): N.EntryRow | undefined => {
    const id = Number(raw);
    const e = Number.isInteger(id) ? N.getEntry(db, id) : undefined;
    return e && e.event_id === ev.id ? e : undefined;
  };
  /** Ruling 11: tell players someone else put on a roster. Never fails the request. */
  const tellAdded = (ev: E.EventRow, entryId: number, by: string, added: N.Added) => tellRosterAdded(opts, ev.id, entryId, by, added);
  type SlugId = { slug: string; id: string };

  app.get('/api/events', async (req, reply) => {
    const v = allowedViewer(req, reply);
    if (!v) return;
    return { events: eventListItems(db, { staff: isStaff(v.viewer) }) };
  });

  /** A banner, only while an event this viewer may see holds it (Ruling 4):
   *  a draft's banner is staff only, like the draft. Served as the type its
   *  bytes are, with the same lockdown headers as a team logo. */
  app.get('/api/events/banners/:key', async (req, reply) => {
    const v = allowedViewer(req, reply);
    if (!v) return;
    const key = (req.params as { key: string }).key;
    if (!HEX64.test(key)) return reply.code(404).send(NOT_FOUND);
    const holders = db.prepare('SELECT status FROM events WHERE banner_key = ?').all(key) as { status: string }[];
    if (!holders.some((h) => h.status !== 'draft' || isStaff(v.viewer))) return reply.code(404).send(NOT_FOUND);
    const bytes = opts.store().readBanner(key);
    const type = bytes ? bannerType(bytes) : null;
    if (!bytes || !type) return reply.code(404).send(NOT_FOUND);
    return reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'public, max-age=3600')
      .type(type === 'png' ? 'image/png' : 'image/webp').send(bytes);
  });

  app.get('/api/events/:slug', async (req, reply) => {
    const v = allowedViewer(req, reply);
    if (!v) return;
    const ev = getEventBySlug(db, (req.params as { slug: string }).slug);
    if (!ev || (ev.status === 'draft' && !isStaff(v.viewer))) return reply.code(404).send(NOT_FOUND);
    return eventView(db, ev);
  });

  app.get('/api/events/:slug/mine', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const ev = visibleEvent((req.params as { slug: string }).slug, me);
    if (!ev) return reply.code(404).send(NOT_FOUND);
    return myEventView(db, ev, me);
  });

  app.post('/api/events/:slug/entries', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const ev = visibleEvent((req.params as { slug: string }).slug, me);
    if (!ev) return reply.code(404).send(NOT_FOUND);
    const body = (req.body ?? {}) as { teamId?: unknown; roster?: unknown };
    const teamId = Number(body.teamId);
    if (!Number.isInteger(teamId)) return refuse(reply, { error: 'team_not_found' });
    const r = N.registerEntry(db, { eventId: ev.id, teamId, by: me, roster: body.roster });
    if (!r.ok) return refuse(reply, r);
    tellAdded(ev, r.value.entry.id, me, r.value.added);
    return { id: r.value.entry.id };
  });

  app.post('/api/events/:slug/entries/:id/roster', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const p = req.params as SlugId;
    const ev = visibleEvent(p.slug, me);
    const entry = ev && entryIn(ev, p.id);
    if (!ev || !entry) return refuse(reply, { error: 'entry_not_found' });
    const r = N.setEntryRoster(db, { entryId: entry.id, by: me, roster: ((req.body ?? {}) as { roster?: unknown }).roster });
    if (!r.ok) return refuse(reply, r);
    tellAdded(ev, entry.id, me, r.value.added);
    return {};
  });

  for (const action of ['withdraw', 'checkin', 'leave'] as const) {
    app.post(`/api/events/:slug/entries/:id/${action}`, async (req, reply) => {
      const me = allowedActive(req, reply);
      if (!me) return;
      const p = req.params as SlugId;
      const ev = visibleEvent(p.slug, me);
      const entry = ev && entryIn(ev, p.id);
      if (!ev || !entry) return refuse(reply, { error: 'entry_not_found' });
      const r = action === 'withdraw' ? N.withdrawEntry(db, { entryId: entry.id, by: me })
        : action === 'checkin' ? N.checkInEntry(db, { entryId: entry.id, by: me })
          : N.leaveEntry(db, { entryId: entry.id, steamid: me });
      if (!r.ok) return refuse(reply, r);
      return {};
    });
  }

  /** Draft signups (drafts plan D1): one per player, with a captain
   *  preference and an optional private note, while signups are open. A team
   *  event answers not_draft, and an unpublished one 404 like any draft. */
  app.post('/api/events/:slug/signup', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const ev = visibleEvent((req.params as { slug: string }).slug, me);
    if (!ev || ev.status === 'draft') return reply.code(404).send(NOT_FOUND);
    const body = (req.body ?? {}) as { captainPref?: unknown; note?: unknown };
    if (!D.CAPTAIN_PREFS.includes(body.captainPref as D.CaptainPref)) return refuse(reply, { error: 'bad_captain_pref' });
    if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') return refuse(reply, { error: 'bad_note' });
    const r = D.signUp(db, { eventId: ev.id, steamid: me, captainPref: body.captainPref as D.CaptainPref, note: (body.note as string | null | undefined) ?? null, now: new Date() });
    if (!r.ok) return refuse(reply, r);
    return { ok: true, signup: signupView(ev, r.value) };
  });

  app.post('/api/events/:slug/withdraw-signup', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const ev = visibleEvent((req.params as { slug: string }).slug, me);
    if (!ev || ev.status === 'draft') return reply.code(404).send(NOT_FOUND);
    const r = D.withdrawSignup(db, { eventId: ev.id, steamid: me, now: new Date() });
    if (!r.ok) return refuse(reply, r);
    return { ok: true };
  });

  /** The offered player's answer to a captaincy offer (drafts plan D1
   *  Ruling 6). Anyone else, or an offer gone, answers no_offer. */
  app.post('/api/events/:slug/captain-offer', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const ev = visibleEvent((req.params as { slug: string }).slug, me);
    if (!ev || ev.status === 'draft') return reply.code(404).send(NOT_FOUND);
    const accept = ((req.body ?? {}) as { accept?: unknown }).accept;
    if (typeof accept !== 'boolean') return refuse(reply, { error: 'bad_request' });
    const r = D.answerOffer(db, { eventId: ev.id, steamid: me, accept, now: new Date() });
    if (!r.ok) return refuse(reply, r);
    return { ok: true };
  });

  /** The match room (plan T3a). A match of another event answers like one
   *  that does not exist. Every write pushes the room to its two rosters. */
  const matchIn = (ev: E.EventRow, raw: string): P.MatchRow | undefined => {
    const id = Number(raw);
    const m = Number.isInteger(id) ? P.getMatch(db, id) : undefined;
    return m && m.event_id === ev.id ? m : undefined;
  };

  app.get('/api/events/:slug/matches/:id', async (req, reply) => {
    const v = allowedViewer(req, reply);
    if (!v) return;
    const p = req.params as SlugId;
    const ev = visibleEvent(p.slug, v.viewer);
    const m = ev && matchIn(ev, p.id);
    if (!ev || !m) return reply.code(404).send(NOT_FOUND);
    return matchRoomView(db, ev, m, v.viewer, isStaff(v.viewer));
  });

  for (const action of ['ready', 'veto', 'lineup', 'confirm', 'dispute'] as const) {
    app.post(`/api/events/:slug/matches/:id/${action}`, async (req, reply) => {
      const me = allowedActive(req, reply);
      if (!me) return;
      const p = req.params as SlugId;
      const ev = visibleEvent(p.slug, me);
      const m = ev && matchIn(ev, p.id);
      if (!ev || !m) return refuse(reply, { error: 'match_not_found' });
      const body = (req.body ?? {}) as { step?: unknown; action?: unknown; campaign?: unknown; steamids?: unknown; reason?: unknown };
      const timers = R.roomTimers(db);
      let r: V.Checked<unknown>;
      if (action === 'ready') r = R.readyUp(db, { matchId: m.id, steamid: me, timers });
      else if (action === 'veto') {
        if (typeof body.step !== 'number' || !Number.isInteger(body.step)) return refuse(reply, { error: 'bad_veto_action' });
        r = R.actVeto(db, { matchId: m.id, steamid: me, step: body.step, action: body.action, campaign: body.campaign ?? null, timers });
      } else if (action === 'confirm') {
        if (!opts.series) return reply.code(404).send(NOT_FOUND);
        r = await opts.series.confirm(m.id, me);
      } else if (action === 'dispute') {
        if (!opts.series) return reply.code(404).send(NOT_FOUND);
        r = opts.series.dispute(m.id, me, body.reason);
      } else r = R.lockLineup(db, { matchId: m.id, steamid: me, steamids: body.steamids, timers });
      if (!r.ok) return refuse(reply, r);
      // T3b Ruling 4: a pick on a live match may have settled the next game.
      // The pick is committed by now, so a throw here is logged, never a 500.
      if (action === 'veto' && P.getMatch(db, m.id)?.status === 'live') {
        try { opts.series?.afterPick(m.id); } catch (err) { console.error(`[events] scheduling match ${m.id} after the pick failed:`, err instanceof Error ? err.message : err); }
      }
      opts.rooms?.pushChange(m.id);
      return {};
    });
  }

  /** Reschedule proposals (plan T4 Ruling 7). The DM goes to the side that
   *  must act next (a withdrawal to both sides, Task 4 ruling; an accept
   *  tells both rosters the time locked); every change pushes the room. */
  for (const action of ['propose', 'respond', 'counter', 'withdraw'] as const) {
    app.post(`/api/events/:slug/matches/:id/${action}`, async (req, reply) => {
      const me = allowedActive(req, reply);
      if (!me) return;
      const p = req.params as SlugId;
      const ev = visibleEvent(p.slug, me);
      const m = ev && matchIn(ev, p.id);
      if (!ev || !m) return refuse(reply, { error: 'match_not_found' });
      const body = (req.body ?? {}) as { time?: unknown; note?: unknown; accept?: unknown };
      if (action === 'propose' || action === 'counter') {
        const rules = S.scheduleRules(db);
        const r = action === 'propose'
          ? S.proposeTime(db, { matchId: m.id, by: me, time: body.time, note: body.note, rules })
          : S.counterProposal(db, { matchId: m.id, by: me, time: body.time, note: body.note, rules });
        if (!r.ok) return refuse(reply, r);
        tellReschedule(opts, ev.id, m.id, action === 'propose' ? 'proposed' : 'countered', r.value.id);
      } else if (action === 'respond') {
        if (typeof body.accept !== 'boolean') return refuse(reply, { error: 'bad_request' });
        const r = S.respondProposal(db, { matchId: m.id, by: me, accept: body.accept });
        if (!r.ok) return refuse(reply, r);
        if (body.accept) tellTimeLocked(opts, ev.id, m.id);
        else tellReschedule(opts, ev.id, m.id, 'declined', r.value.proposal.id);
      } else {
        const r = S.withdrawProposal(db, { matchId: m.id, by: me });
        if (!r.ok) return refuse(reply, r);
        tellReschedule(opts, ev.id, m.id, 'withdrawn', r.value.id);
      }
      opts.rooms?.pushChange(m.id);
      return {};
    });
  }

  /** A team's preferences for the timers: its managers and staff only. */
  const prefsEntry = (req: FastifyRequest, reply: FastifyReply): { me: string; ev: E.EventRow; entry: N.EntryRow } | null => {
    const me = allowedActive(req, reply);
    if (!me) return null;
    const p = req.params as SlugId;
    const ev = visibleEvent(p.slug, me);
    const entry = ev && entryIn(ev, p.id);
    if (!ev || !entry) { refuse(reply, { error: 'entry_not_found' }); return null; }
    if (!isStaff(me) && !N.managersOf(db, entry.team_id).includes(me)) { refuse(reply, { error: 'not_manager' }); return null; }
    return { me, ev, entry };
  };

  app.get('/api/events/:slug/entries/:id/prefs', async (req, reply) => {
    const c = prefsEntry(req, reply);
    if (!c) return;
    return prefsView(db, c.ev, c.entry.id);
  });

  app.post('/api/events/:slug/entries/:id/prefs', async (req, reply) => {
    const c = prefsEntry(req, reply);
    if (!c) return;
    const r = R.savePrefs(db, { entryId: c.entry.id, by: c.me, staff: isStaff(c.me), prefs: req.body ?? null });
    if (!r.ok) return refuse(reply, r);
    return {};
  });

  /** An entry's logo snapshot, only while an entry of an event this viewer
   *  may see holds the key (Review Focus). Same headers as a team logo. */
  app.get('/api/events/logos/:file', async (req, reply) => {
    const v = allowedViewer(req, reply);
    if (!v) return;
    const m = /^([0-9a-f]{64})\.png$/.exec((req.params as { file: string }).file);
    if (!m) return reply.code(404).send(NOT_FOUND);
    const holders = db.prepare(
      "SELECT e.status FROM event_entries x JOIN events e ON e.id = x.event_id WHERE x.logo_key = ? AND x.status <> 'dropped'",
    ).all(m[1]) as { status: string }[];
    if (!holders.some((h) => h.status !== 'draft' || isStaff(v.viewer))) return reply.code(404).send(NOT_FOUND);
    const bytes = opts.store().readLogo(m[1]!);
    if (!bytes) return reply.code(404).send(NOT_FOUND);
    return reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'public, max-age=3600')
      .type('image/png').send(bytes);
  });
}
