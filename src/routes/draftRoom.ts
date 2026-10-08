// src/routes/draftRoom.ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import { currentSeasonId, getPlayer } from '../players.js';
import { makeOptionalViewer, makeRequireActive, makeRequireAdmin, makeRequireMod } from './guards.js';
import { competitiveAccess, competitivePublic } from '../teams/access.js';
import { logAdmin } from '../admin/audit.js';
import * as E from '../events/events.js';
import * as D from '../events/drafts.js';
import * as DR from '../events/draftRoom.js';
import * as V from '../events/validate.js';
import { playerCard, type PlayerCard } from '../events/draftCards.js';
import { chemistryFor, draftRoomView, notesFor } from '../events/draftRoomView.js';
import { tellDraftRoomOpen } from '../events/notices.js';
import type { DraftClock } from '../events/draftClock.js';
import type { Notifier } from '../notify/notify.js';

const NOT_FOUND = { error: 'not found' };
/** Ruling 21: cards are memoized per event this long. */
const CARD_TTL_MS = 60_000;
/** The body fields a desk room action may carry into the admin audit. */
const AUDIT_KEYS = ['captain', 'on', 'firstPick', 'pickSeconds'];

/**
 * The live draft room (drafts plan D2b1 Ruling 12). Public routes sit behind
 * competitive_enabled exactly as src/routes/events.ts does; a draft-status
 * (unpublished) event answers 404 as the signup routes do. The desk routes
 * follow the Events desk: mods read, admins write, logAdmin after commit.
 * Every room change pushes draft:<eventId> through the clock.
 */
export async function draftRoomRoutes(
  app: FastifyInstance, opts: { db: DB; clock: DraftClock; notifier?: Notifier; publicUrl?: string },
): Promise<void> {
  const { db, clock } = opts;
  const optionalViewer = makeOptionalViewer(db);
  const requireActive = makeRequireActive(db);
  const requireAdmin = makeRequireAdmin(db);
  const requireStaff = makeRequireMod(db);
  const isStaff = (s: string | null): boolean => {
    const p = s ? getPlayer(db, s) : undefined;
    return !!p && (p.is_admin === 1 || p.is_mod === 1);
  };
  const refuse = (reply: FastifyReply, error: V.EventError) =>
    reply.code(V.EVENT_ERRORS[error].status).send({ error: V.EVENT_ERRORS[error].text });
  const active = (req: FastifyRequest, reply: FastifyReply): string | null => {
    if (!competitiveAccess(db, optionalViewer(req))) { reply.code(404).send(NOT_FOUND); return null; }
    return requireActive(req, reply);
  };
  /** A published draft-kind event with its cut published, or the reply sent. */
  const draftBySlug = (reply: FastifyReply, slug: string): E.EventRow | null => {
    const ev = E.getEventBySlug(db, slug);
    if (!ev || ev.status === 'draft') { reply.code(404).send(NOT_FOUND); return null; }
    if (ev.entry_kind !== 'draft') { refuse(reply, 'not_draft'); return null; }
    if (ev.cut_at === null) { refuse(reply, 'cut_not_published'); return null; }
    return ev;
  };
  const memo = new Map<number, { at: number; cards: Map<string, PlayerCard> }>();
  const cardsOf = (eventId: number) => (ids: string[]): PlayerCard[] => {
    const nowMs = Date.now();
    let m = memo.get(eventId);
    if (!m || nowMs - m.at > CARD_TTL_MS) {
      const season = currentSeasonId(db);
      const pool = D.activeSignups(db, eventId).filter((s) => s.role === 'pool');
      m = { at: nowMs, cards: new Map(pool.map((s) => [s.steamid, playerCard(db, s.steamid, season)])) };
      memo.set(eventId, m);
    }
    const cards = m.cards;
    return ids.map((id) => cards.get(id) ?? playerCard(db, id));
  };
  const viewFor = (ev: E.EventRow, steamid: string | null, staff: boolean) => draftRoomView(db, ev, { steamid, staff }, clock.nowDate(), cardsOf(ev.id));
  type Slug = { slug: string };

  app.get('/api/events/:slug/draft', async (req, reply) => {
    const viewer = optionalViewer(req);
    if (!(viewer ? competitiveAccess(db, viewer) : competitivePublic(db))) return reply.code(404).send(NOT_FOUND);
    const ev = draftBySlug(reply, (req.params as Slug).slug);
    if (!ev) return;
    return viewFor(ev, viewer, isStaff(viewer));
  });

  app.post('/api/events/:slug/draft/pick', async (req, reply) => {
    const me = active(req, reply);
    if (!me) return;
    const ev = draftBySlug(reply, (req.params as Slug).slug);
    if (!ev) return;
    const body = (req.body ?? {}) as { player?: unknown; pickNo?: unknown };
    if (typeof body.player !== 'string' || typeof body.pickNo !== 'number' || !Number.isInteger(body.pickNo)) return refuse(reply, 'bad_request');
    clock.heartbeat(ev.id, me); // a pick is presence too (Ruling 8)
    const r = DR.makePick(db, { eventId: ev.id, steamid: me, player: body.player, pickNo: body.pickNo, now: clock.nowDate(), present: clock.present(ev.id) });
    if (!r.ok) return refuse(reply, r.error);
    clock.push(ev.id);
    return { pickNo: r.value.pickNo, done: r.value.done };
  });

  /** Ruling 8: a captain's or delegate's room page beats every 10 s; anyone
   *  else's beat is accepted and ignored, so the page need not know. */
  app.post('/api/events/:slug/draft/heartbeat', async (req, reply) => {
    const me = active(req, reply);
    if (!me) return;
    const ev = draftBySlug(reply, (req.params as Slug).slug);
    if (!ev) return;
    if (DR.captainFor(db, ev.id, me)) clock.heartbeat(ev.id, me);
    return { ok: true };
  });

  app.get('/api/events/:slug/draft/list', async (req, reply) => {
    const me = active(req, reply);
    if (!me) return;
    const ev = draftBySlug(reply, (req.params as Slug).slug);
    if (!ev) return;
    // Ruling P4: the list is the captain's alone; a delegate is refused.
    if (D.signupOf(db, ev.id, me)?.role !== 'captain') return refuse(reply, 'not_a_captain');
    return { list: DR.pickListOf(db, ev.id, me) };
  });

  /** No push: a list is private, so no other page needs to refetch. */
  app.put('/api/events/:slug/draft/list', async (req, reply) => {
    const me = active(req, reply);
    if (!me) return;
    const ev = draftBySlug(reply, (req.params as Slug).slug);
    if (!ev) return;
    const r = DR.savePickList(db, { eventId: ev.id, steamid: me, list: ((req.body ?? {}) as { list?: unknown }).list, now: clock.nowDate() });
    if (!r.ok) return refuse(reply, r.error);
    return { list: r.value };
  });

  /** Every pool card (picked or not) for the list drawer, with the notes;
   *  chemistry with the viewer for a captain or delegate (Ruling 3). */
  app.get('/api/events/:slug/draft/cards', async (req, reply) => {
    const me = active(req, reply);
    if (!me) return;
    const ev = draftBySlug(reply, (req.params as Slug).slug);
    if (!ev) return;
    const captain = DR.captainFor(db, ev.id, me);
    if (!captain && !isStaff(me) && me !== ev.organizer_steamid) return refuse(reply, 'not_a_captain');
    const pool = D.activeSignups(db, ev.id).filter((s) => s.role === 'pool');
    return {
      cards: cardsOf(ev.id)(pool.map((s) => s.steamid)),
      notes: notesFor(pool),
      chemistry: captain ? chemistryFor(db, me, pool) : null,
    };
  });

  // The desk (Ruling 12).
  const eventOf = (raw: unknown): E.EventRow | undefined => {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? E.getEvent(db, n) : undefined;
  };
  app.get('/api/admin/events/:id/draft/room', async (req, reply) => {
    const me = requireStaff(req, reply);
    if (!me) return;
    const ev = eventOf((req.params as { id: string }).id);
    if (!ev) return refuse(reply, 'not_found');
    if (ev.entry_kind !== 'draft') return refuse(reply, 'not_draft');
    return viewFor(ev, me, true);
  });
  const roomPost = <T>(
    path: string, run: (ev: E.EventRow, me: string, body: Record<string, unknown>) => V.Checked<T> | null, after?: (ev: E.EventRow, value: T) => void,
  ) => app.post(`/api/admin/events/:id/draft/room/${path}`, async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const ev = eventOf((req.params as { id: string }).id);
    if (!ev) return refuse(reply, 'not_found');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const r = run(ev, me, body);
    if (r === null) return refuse(reply, 'bad_request');
    if (!r.ok) return refuse(reply, r.error);
    logAdmin(db, me, `event_draft_room_${path}`, ev.id, { slug: ev.slug, ...Object.fromEntries(AUDIT_KEYS.filter((k) => k in body).map((k) => [k, body[k]])) });
    clock.push(ev.id);
    after?.(ev, r.value);
    return { ok: true };
  });
  const staffOpts = (ev: E.EventRow, me: string) => ({ eventId: ev.id, actor: me, now: clock.nowDate() });
  roomPost('start', (ev, me) => DR.startRoom(db, { ...staffOpts(ev, me), present: clock.present(ev.id) }),
    (ev, v) => tellDraftRoomOpen(opts, ev.id, v.order));
  roomPost('pause', (ev, me) => DR.pauseRoom(db, staffOpts(ev, me)));
  roomPost('resume', (ev, me) => DR.resumeRoom(db, staffOpts(ev, me)));
  roomPost('undo', (ev, me) => DR.undoPick(db, staffOpts(ev, me)));
  roomPost('reset', (ev, me) => DR.resetRoom(db, staffOpts(ev, me)));
  roomPost('delegate', (ev, me, b) => (typeof b.captain !== 'string' || typeof b.on !== 'boolean' ? null
    : DR.setDelegate(db, { ...staffOpts(ev, me), captain: b.captain, on: b.on })));
  roomPost('settings', (ev, me, b) => D.setRoomSettings(db, { ...staffOpts(ev, me), settings: b }));
}
