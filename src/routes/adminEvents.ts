import { randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DB } from '../db.js';
import type { CommunityStore } from '../community/store.js';
import { BANNER_MAX_BYTES, bannerType, checkBanner } from '../community/validate.js';
import { makeRequireAdmin, makeRequireMod } from './guards.js';
import { logAdmin } from '../admin/audit.js';
import { getPlayer } from '../players.js';
import { campaignRegistry } from '../campaignRegistry.js';
import * as E from '../events/events.js';
import * as N from '../events/entries.js';
import * as P from '../events/play.js';
import * as R from '../events/room.js';
import * as V from '../events/validate.js';
import { recordResultFlow, settleEvent, startEventFlow } from '../events/flow.js';
import { stageSummary } from '../events/format.js';
import { adminEntryViews } from '../events/views.js';
import { stagePlayViews, type StagePlayView } from '../events/playViews.js';
import { rulesetOptions } from '../rulesetStore.js';
import type { Notifier } from '../notify/notify.js';
import { tellCheckinOpen, tellDropped, tellRoomOpen, tellRosterAdded, tellStaffAction } from '../events/notices.js';
import type { StaffAction } from '../events/messages.js';
import { higherSide, type RoomClock } from '../events/roomClock.js';

export interface AdminEventRow {
  id: number; slug: string; name: string; status: V.EventStatus; entryKind: V.EntryKind; startsAt: string; stages: number; updatedAt: string;
}
export interface AdminEventStage {
  id: number; ordinal: number; summary: string; settings: V.StageSettings; rulesSnapshotted: boolean;
  /** Plan T4: the stage's round schedule rows, and how many rounds it will have when known. */
  schedule: V.RoundSchedule[]; roundsKnown: number | null;
}
export interface AdminEventDetail {
  id: number; slug: string; status: V.EventStatus; fields: V.EventFields; bannerKey: string | null;
  cancelReason: string | null; createdAt: string; updatedAt: string;
  stages: AdminEventStage[];
  log: { at: string; actorName: string | null; action: string; detail: Record<string, unknown> }[];
}
export interface AdminEventPlay { status: V.EventStatus; lockedAt: string | null; startsAt: string; seeded: number; stages: StagePlayView[] }
export interface AdminEventOptions {
  campaigns: { slug: string; name: string }[]; defaultPool: string[];
  rulesets: { id: number; name: string; summary: string }[]; defaultRulesetId: number | null;
  gameConfigs: { key: string; label: string }[];
  defaults: { eligibility: V.Eligibility; checkin: V.Checkin; roster: V.RosterRules };
}

export function adminEventDetail(db: DB, ev: E.EventRow): AdminEventDetail {
  return {
    id: ev.id, slug: ev.slug, status: ev.status, fields: E.fieldsOf(ev), bannerKey: ev.banner_key, cancelReason: ev.cancel_reason,
    createdAt: ev.created_at, updatedAt: ev.updated_at,
    stages: E.stagesOf(db, ev.id).map((s) => {
      const settings = E.stageSettingsOf(s);
      const ms = P.matchesOf(db, s.id);
      // Swiss rounds or a league's matches; else the highest round played so far, or unknown.
      const known = P.totalRounds(s) ?? (settings.type === 'league' ? (settings.config as V.StageConfigs['league']).matches : null)
        ?? (ms.length > 0 ? Math.max(...ms.map((m) => m.round)) : null);
      return {
        id: s.id, ordinal: s.ordinal, summary: stageSummary(settings.type, settings.config, settings.advanceCount), settings, rulesSnapshotted: s.rules_json !== null,
        schedule: E.scheduleOf(s), roundsKnown: known,
      };
    }),
    log: E.eventLog(db, ev.id).map((l) => ({
      at: l.at, actorName: l.actor ? getPlayer(db, l.actor)?.name ?? l.actor : null, action: l.action,
      detail: JSON.parse(l.detail) as Record<string, unknown>,
    })),
  };
}

/**
 * The Events desk (tournaments plan T1a). Staff read it, admins write it
 * (Ruling 2): every GET takes an admin or a mod, every POST an admin only, so
 * a mod gets a 403 on any write. Not behind competitive_enabled (Ruling 13),
 * so events can be prepared while the switch is off. Every rule lives in
 * src/events/events.ts; a route maps the refusal to its status and sentence,
 * and on success adds logAdmin (Ruling 10) after the event's own transaction
 * has committed its event_log row. The entry steps send the same DMs as the
 * clock and the public routes do (src/events/notices.ts), never failing the
 * request over one.
 */
export async function adminEventRoutes(
  app: FastifyInstance, opts: {
    db: DB; store: () => CommunityStore; notifier?: Notifier; publicUrl?: string; rooms?: RoomClock;
    /** The series engine (plan T3b): a result entered here ends the match's
     *  running booking, and a room reset cancels its booking first. */
    series?: {
      confirm(matchId: number, steamid: string): Promise<V.Checked<unknown>>;
      dispute(matchId: number, steamid: string, reason: unknown): V.Checked<unknown>;
      afterPick(matchId: number): void;
      reset(matchId: number, by: string): V.Checked<unknown>;
      staffResult(matchId: number, by: string): void;
      /** Plan T3c: the desk tools. */
      freeze(matchId: number, by: string, on: boolean): Promise<V.Checked<unknown>>;
      replayCheck(matchId: number, ordinal: unknown): V.Checked<unknown>;
      replayInBackground(matchId: number, by: string, ordinal: unknown): Promise<void>;
      moveServer(matchId: number, by: string): Promise<V.Checked<unknown>>;
      extendGrace(matchId: number, by: string, minutes: unknown): V.Checked<unknown>;
      releaseHold(matchId: number, by: string): V.Checked<unknown>;
      reopenVeto(matchId: number, by: string): V.Checked<unknown>;
    };
  },
): Promise<void> {
  const { db } = opts;
  const requireAdmin = makeRequireAdmin(db);
  const requireStaff = makeRequireMod(db);
  const refuse = (reply: FastifyReply, error: V.EventError) =>
    reply.code(V.EVENT_ERRORS[error].status).send({ error: V.EVENT_ERRORS[error].text });
  const idOf = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  app.get('/api/admin/events', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    const rows = db.prepare(
      `SELECT e.*, (SELECT COUNT(*) FROM event_stages s WHERE s.event_id = e.id) AS stage_count
       FROM events e ORDER BY e.starts_at DESC, e.id DESC`,
    ).all() as (E.EventRow & { stage_count: number })[];
    const events: AdminEventRow[] = rows.map((e) => ({
      id: e.id, slug: e.slug, name: e.name, status: e.status, entryKind: e.entry_kind, startsAt: e.starts_at, stages: e.stage_count, updatedAt: e.updated_at,
    }));
    return { events };
  });

  app.get('/api/admin/events/options', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    const ctx = E.stageContext(db);
    const registry = campaignRegistry(db);
    const rulesets = rulesetOptions(db);
    const cup = rulesets.find((r) => r.name === 'Standard Cup');
    const options: AdminEventOptions = {
      campaigns: [...ctx.campaigns].map((slug) => ({ slug, name: registry.get(slug)?.name ?? slug })),
      defaultPool: ctx.defaultPool,
      rulesets,
      defaultRulesetId: cup?.id ?? rulesets[0]?.id ?? null,
      gameConfigs: db.prepare('SELECT key, label FROM game_configs WHERE enabled = 1 ORDER BY key').all() as { key: string; label: string }[],
      defaults: { eligibility: V.defaultEligibility(), checkin: V.defaultCheckin(), roster: V.defaultRoster() },
    };
    return options;
  });

  app.get('/api/admin/events/:id', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    const id = idOf((req.params as { id: string }).id);
    const ev = id === null ? undefined : E.getEvent(db, id);
    if (!ev) return refuse(reply, 'not_found');
    return adminEventDetail(db, ev);
  });

  /** The event's current banner for the desk itself. The public banner route
   *  sits behind competitive_enabled and hides drafts from mods while the
   *  switch is at admins, and the desk is not behind the switch (Ruling 13),
   *  so it reads the bytes here: staff only, same lockdown headers, private. */
  app.get('/api/admin/events/:id/banner', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    const id = idOf((req.params as { id: string }).id);
    const key = id === null ? null : E.getEvent(db, id)?.banner_key ?? null;
    const bytes = key ? opts.store().readBanner(key) : null;
    const type = bytes ? bannerType(bytes) : null;
    if (!bytes || !type) return refuse(reply, 'not_found');
    return reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, max-age=3600')
      .type(type === 'png' ? 'image/png' : 'image/webp').send(bytes);
  });

  app.post('/api/admin/events', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const r = E.createEvent(db, { by: me, fields: req.body ?? {} });
    if (!r.ok) return refuse(reply, r.error);
    logAdmin(db, me, 'event_create', r.value.id, { slug: r.value.slug, name: r.value.name });
    return reply.code(201).send({ id: r.value.id, slug: r.value.slug });
  });

  type Body = Record<string, unknown>;
  /** The event's matches in a room state (open, held, booked and on). */
  const roomMatches = (eventId: number): P.MatchRow[] =>
    E.stagesOf(db, eventId).flatMap((s) => P.matchesOf(db, s.id)).filter((m) => P.ROOM_OPEN.has(m.status));
  /** One admin action on one event (and maybe one of its stages): call the
   *  store, refuse or audit, answer { ok: true }. */
  const action = (
    path: string,
    name: string,
    call: (me: string, id: number, body: Body, stageId: number | null) => V.Checked<unknown>,
    detail: (body: Body, stageId: number | null) => object = () => ({}),
    after?: (me: string, id: number) => void,
  ) => {
    app.post(path, async (req, reply) => {
      const me = requireAdmin(req, reply);
      if (!me) return;
      const p = req.params as { id: string; stageId?: string };
      const id = idOf(p.id);
      if (id === null) return refuse(reply, 'not_found');
      const stageId = p.stageId === undefined ? null : idOf(p.stageId);
      if (p.stageId !== undefined && stageId === null) return refuse(reply, 'stage_not_found');
      const body = (req.body ?? {}) as Body;
      const r = call(me, id, body, stageId);
      if (!r.ok) return refuse(reply, r.error);
      after?.(me, id);
      logAdmin(db, me, name, id, detail(body, stageId));
      return { ok: true };
    });
  };

  action('/api/admin/events/:id', 'event_edit',
    (me, id, body) => E.updateEvent(db, { eventId: id, by: me, fields: body }),
    (body) => ({ fields: Object.keys(body) }));
  action('/api/admin/events/:id/stages', 'event_stage_add',
    (me, id, body) => E.addStage(db, { eventId: id, by: me, stage: body }),
    (body) => ({ type: body.type }));
  action('/api/admin/events/:id/stages/order', 'event_stages_reorder',
    (me, id, body) => E.reorderStages(db, { eventId: id, by: me, order: body.order }),
    (body) => ({ order: body.order }));
  action('/api/admin/events/:id/stages/:stageId', 'event_stage_edit',
    (me, id, body, stageId) => E.updateStage(db, { eventId: id, stageId: stageId!, by: me, stage: body }),
    (_body, stageId) => ({ stageId }));
  action('/api/admin/events/:id/stages/:stageId/remove', 'event_stage_remove',
    (me, id, _body, stageId) => E.removeStage(db, { eventId: id, stageId: stageId!, by: me }),
    (_body, stageId) => ({ stageId }));
  action('/api/admin/events/:id/publish', 'event_publish',
    (me, id) => E.publishEvent(db, { eventId: id, by: me }));
  action('/api/admin/events/:id/open-registration', 'event_open_registration',
    (me, id) => E.openRegistration(db, { eventId: id, by: me }));
  action('/api/admin/events/:id/cancel', 'event_cancel',
    (me, id, body) => E.cancelEvent(db, { eventId: id, by: me, reason: body.reason }),
    (body) => ({ reason: typeof body.reason === 'string' ? body.reason.slice(0, V.CANCEL_REASON_MAX) : null }),
    // cancelEvent writes only the event (room.ts owns the room columns), so
    // every open room goes back to waiting here and is pushed: its clock
    // stopped with the event (final review).
    // A room holding a server goes through the series engine when it is
    // wired, which cancels the running booking first (plan T3b). The push
    // is sent here either way, as the reset-room route does.
    (me, id) => {
      for (const m of roomMatches(id)) {
        try {
          const r = opts.series ? opts.series.reset(m.id, me) : R.resetRoom(db, { matchId: m.id, by: me });
          if (r.ok) opts.rooms?.pushChange(m.id);
          else console.error(`[events] room reset of match ${m.id} after cancelling event ${id} refused: ${r.error}`);
        } catch (err) {
          console.error(`[events] room reset of match ${m.id} after cancelling event ${id} failed:`, err instanceof Error ? err.message : err);
        }
      }
    });

  /** Upload a banner (Ruling 4): base64 of the browser's 1600 x 400 PNG or
   *  WebP, checked, stored content addressed, then set on the event. */
  app.post('/api/admin/events/:id/banner', { bodyLimit: Math.ceil(BANNER_MAX_BYTES * 1.4) + 1024 }, async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const id = idOf((req.params as { id: string }).id);
    if (id === null || !E.getEvent(db, id)) return refuse(reply, 'not_found');
    const raw = ((req.body ?? {}) as { image?: unknown }).image;
    if (typeof raw !== 'string') return reply.code(400).send({ error: 'The banner is missing.' });
    const bytes = Buffer.from(raw, 'base64');
    const checked = checkBanner(bytes);
    if (!checked.ok) return reply.code(checked.status).send({ error: checked.error });
    const store = opts.store();
    if (!(await store.canTake(bytes.length))) return reply.code(507).send({ error: 'The community shelf is full right now.' });
    const { name } = store.putBanner(bytes);
    const r = E.setEventBanner(db, { eventId: id, by: me, bannerKey: name });
    if (!r.ok) return refuse(reply, r.error);
    logAdmin(db, me, 'event_banner', id, { bannerKey: name });
    return { bannerKey: name };
  });

  /** A draft is deleted, not cancelled (cancelling would publish it). The
   *  name and slug go in the audit row, the only record left of it. */
  app.post('/api/admin/events/:id/delete', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const id = idOf((req.params as { id: string }).id);
    if (id === null) return refuse(reply, 'not_found');
    const r = E.deleteDraftEvent(db, { eventId: id, by: me });
    if (!r.ok) return refuse(reply, r.error);
    logAdmin(db, me, 'event_delete', id, { name: r.value.name, slug: r.value.slug });
    return { ok: true };
  });

  action('/api/admin/events/:id/banner/remove', 'event_banner_remove',
    (me, id) => E.setEventBanner(db, { eventId: id, by: me, bannerKey: null }));

  const eventOf = (raw: unknown): E.EventRow | undefined => { const id = idOf(raw); return id ? E.getEvent(db, id) : undefined; };
  const entryOf = (ev: E.EventRow, raw: unknown): N.EntryRow | undefined => {
    const id = idOf(raw);
    const e = id ? N.getEntry(db, id) : undefined;
    return e && e.event_id === ev.id ? e : undefined;
  };
  const refuseWith = (reply: FastifyReply, r: { error: V.EventError; detail?: V.EntryProblem[] }) =>
    reply.code(V.EVENT_ERRORS[r.error].status).send({
      error: V.EVENT_ERRORS[r.error].text,
      ...(r.detail ? { problems: r.detail.map((p) => ({ steamid: p.steamid, name: getPlayer(db, p.steamid)?.name ?? p.steamid, problems: p.problems })) } : {}),
    });

  /**
   * The desk's entries view and staff actions (tournaments plan T1b): staff
   * read the list with rosters, SR and eligibility problems; admins open
   * check-in, finalise the list, reorder seeds, and edit a roster,
   * disqualify or restore one entry as staff.
   */
  app.get('/api/admin/events/:id/entries', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    const ev = eventOf((req.params as { id: string }).id);
    if (!ev) return refuse(reply, 'not_found');
    return { lockedAt: ev.locked_at, entries: adminEntryViews(db, ev) };
  });

  app.post('/api/admin/events/:id/open-checkin', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const ev = eventOf((req.params as { id: string }).id);
    if (!ev) return refuse(reply, 'not_found');
    const r = E.openCheckin(db, { eventId: ev.id, by: me });
    if (!r.ok) return refuse(reply, r.error);
    logAdmin(db, me, 'event_open_checkin', ev.id, { slug: ev.slug });
    tellCheckinOpen(opts, ev.id);
    return {};
  });

  app.post('/api/admin/events/:id/lock-entries', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const ev = eventOf((req.params as { id: string }).id);
    if (!ev) return refuse(reply, 'not_found');
    const r = N.lockEntries(db, { eventId: ev.id, by: me });
    if (!r.ok) return refuse(reply, r.error);
    logAdmin(db, me, 'event_lock_entries', ev.id, { slug: ev.slug, kept: r.value.kept.length, dropped: r.value.dropped.length });
    tellDropped(opts, ev.id, r.value.dropped);
    return r.value;
  });

  app.post('/api/admin/events/:id/seeds', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const ev = eventOf((req.params as { id: string }).id);
    if (!ev) return refuse(reply, 'not_found');
    const r = N.reorderSeeds(db, { eventId: ev.id, by: me, order: ((req.body ?? {}) as { order?: unknown }).order });
    if (!r.ok) return refuse(reply, r.error);
    logAdmin(db, me, 'event_seeds', ev.id, { order: r.value });
    return {};
  });

  app.post('/api/admin/events/:id/entries/:entryId/:action', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const p = req.params as { id: string; entryId: string; action: string };
    const ev = eventOf(p.id);
    const entry = ev && entryOf(ev, p.entryId);
    if (!ev || !entry) return refuse(reply, 'entry_not_found');
    const body = (req.body ?? {}) as { roster?: unknown; reason?: unknown };
    let r: V.Checked<unknown>;
    let action: string;
    let added: N.Added = [];
    switch (p.action) {
      case 'roster': {
        const s = N.setEntryRoster(db, { entryId: entry.id, by: me, roster: body.roster, staff: true });
        if (s.ok) added = s.value.added;
        r = s; action = 'event_entry_roster'; break;
      }
      case 'disqualify': r = N.disqualifyEntry(db, { entryId: entry.id, by: me, reason: body.reason }); action = 'event_entry_disqualify'; break;
      case 'restore': r = N.restoreEntry(db, { entryId: entry.id, by: me }); action = 'event_entry_restore'; break;
      default: return refuse(reply, 'bad_request');
    }
    if (!r.ok) return refuseWith(reply, r);
    if (p.action === 'disqualify' && E.getEvent(db, ev.id)?.status === 'live') {
      // The settle forfeits the team's open rooms; each one is pushed after.
      const rooms = roomMatches(ev.id);
      try {
        await settleEvent(db, { eventId: ev.id });
      } catch (err) {
        // The disqualification already committed; a settle failure after it
        // (bad stage data, a library throw) must not turn a saved
        // disqualification into a rejected call, which would answer with a
        // 500, skip logAdmin and tellRosterAdded below, and have a retry
        // read as entry_out (fix round 1, same pattern as
        // recordResultFlow in src/events/flow.ts).
        console.error(`[events] settle after a disqualification in event ${ev.id} failed:`, err instanceof Error ? err.message : err);
      }
      // T3b final review: a room the settle forfeited while its booking ran
      // (a series mid-game) ends that booking as a staff end, as a staff
      // result does; staffResult leaves every other room alone.
      for (const m of rooms) {
        try { opts.series?.staffResult(m.id, me); } catch (err) { console.error(`[events] ending the booking of match ${m.id} after a disqualification failed:`, err instanceof Error ? err.message : err); }
      }
      for (const m of rooms) opts.rooms?.pushChange(m.id);
    }
    logAdmin(db, me, action, ev.id, { entryId: entry.id, name: entry.name, ...(p.action === 'disqualify' ? { reason: body.reason } : {}) });
    tellRosterAdded(opts, ev.id, entry.id, me, added);
    return {};
  });

  /**
   * Play (tournaments plan T2): staff read the stages that have started with
   * every match; admins start the event early once its list is final and
   * enter or correct a result. Every rule is in src/events/flow.ts and
   * play.ts; the route maps a refusal to its sentence and adds logAdmin.
   */
  app.get('/api/admin/events/:id/play', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    const ev = eventOf((req.params as { id: string }).id);
    if (!ev) return refuse(reply, 'not_found');
    const out: AdminEventPlay = {
      status: ev.status, lockedAt: ev.locked_at, startsAt: ev.starts_at, seeded: P.activeSeeded(db, ev.id).length, stages: stagePlayViews(db, ev, { staff: true }),
    };
    return out;
  });

  app.post('/api/admin/events/:id/start', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const ev = eventOf((req.params as { id: string }).id);
    if (!ev) return refuse(reply, 'not_found');
    const r = await startEventFlow(db, { eventId: ev.id, by: me });
    if (!r.ok) return refuse(reply, r.error);
    logAdmin(db, me, 'event_start', ev.id, { slug: ev.slug });
    return {};
  });

  app.post('/api/admin/events/:id/matches/:matchId/result', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const p = req.params as { id: string; matchId: string };
    const ev = eventOf(p.id);
    const matchId = idOf(p.matchId);
    if (!ev || matchId === null) return refuse(reply, 'match_not_found');
    // A result closes its room, and a correction may reset a downstream room
    // still in its ready check (flow.ts report): push them all.
    const rooms = new Set([matchId, ...roomMatches(ev.id).map((m) => m.id)]);
    const r = await recordResultFlow(db, { eventId: ev.id, matchId, by: me, result: req.body ?? {} });
    if (!r.ok) return refuse(reply, r.error);
    // T3b ledger ruling: a result entered while the match's booking still runs ends that booking as a staff end.
    try { opts.series?.staffResult(matchId, me); } catch (err) { console.error(`[events] ending the booking of match ${matchId} after a staff result failed:`, err instanceof Error ? err.message : err); }
    for (const id of rooms) opts.rooms?.pushChange(id);
    logAdmin(db, me, 'event_result', ev.id, {
      matchId, winner: r.value.winner_entry, scoreA: r.value.score_a, scoreB: r.value.score_b, source: r.value.result_source,
    });
    return {};
  });

  /** Plan T3a Ruling 13: open a room by hand (any waiting match with both
   *  teams, window stages included), reset one to waiting, or hold one. */
  const roomAction = (action: 'open-room' | 'reset-room' | 'hold', audit: string) =>
    app.post(`/api/admin/events/:id/matches/:matchId/${action}`, async (req, reply) => {
      const me = requireAdmin(req, reply);
      if (!me) return;
      const p = req.params as { id: string; matchId: string };
      const ev = eventOf(p.id);
      const matchId = idOf(p.matchId);
      const m = ev && matchId !== null ? P.getMatch(db, matchId) : undefined;
      if (!ev || !m || m.event_id !== ev.id) return refuse(reply, 'match_not_found');
      // The hold reason shows on the public room page: one clean line, 3 to 300 characters.
      const nr = action === 'hold' ? V.normalizeReason(((req.body ?? {}) as { reason?: unknown }).reason) : V.ok(null);
      const reason = nr.ok ? nr.value ?? '' : '';
      if (action === 'hold' && reason.length < 3) return refuse(reply, 'bad_reason');
      const r = action === 'open-room'
        ? R.openRoom(db, { matchId: m.id, by: me, higher: higherSide(db, m), seed: randomInt(2 ** 31), timers: R.roomTimers(db) })
        : action === 'reset-room' ? (opts.series ? opts.series.reset(m.id, me) : R.resetRoom(db, { matchId: m.id, by: me })) : R.holdMatch(db, { matchId: m.id, by: me, reason });
      if (!r.ok) return refuse(reply, r.error);
      if (action === 'open-room') tellRoomOpen(opts, ev.id, m.id);
      opts.rooms?.pushChange(m.id);
      logAdmin(db, me, audit, ev.id, { matchId: m.id, ...(action === 'hold' ? { reason } : {}) });
      return {};
    });
  roomAction('open-room', 'event_room_open');
  roomAction('reset-room', 'event_room_reset');
  roomAction('hold', 'event_hold');

  /** Plan T3c Ruling 10: staff act as a team. One route, three kinds. */
  app.post('/api/admin/events/:id/matches/:matchId/act', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const p = req.params as { id: string; matchId: string };
    const ev = eventOf(p.id);
    const matchId = idOf(p.matchId);
    const m = ev && matchId !== null ? P.getMatch(db, matchId) : undefined;
    if (!ev || !m || m.event_id !== ev.id) return refuse(reply, 'match_not_found');
    const body = (req.body ?? {}) as { kind?: unknown; side?: unknown; step?: unknown; action?: unknown; campaign?: unknown; steamids?: unknown };
    const side = body.side;
    if (side !== 'a' && side !== 'b') return refuse(reply, 'bad_side');
    const staff: R.StaffAct = { by: me, side };
    const timers = R.roomTimers(db);
    let r: V.Checked<P.MatchRow>;
    let what: StaffAction;
    if (body.kind === 'ready') {
      r = R.readyUp(db, { matchId: m.id, steamid: null, staff, timers });
      what = 'ready';
    } else if (body.kind === 'veto') {
      if (typeof body.step !== 'number' || !Number.isInteger(body.step)) return refuse(reply, 'bad_veto_action');
      r = R.actVeto(db, { matchId: m.id, steamid: null, staff, step: body.step, action: body.action, campaign: body.campaign ?? null, timers });
      what = 'veto';
    } else if (body.kind === 'lineup') {
      r = R.lockLineup(db, { matchId: m.id, steamid: null, staff, steamids: body.steamids, timers });
      what = 'lineup';
    } else return refuse(reply, 'bad_request');
    if (!r.ok) return refuse(reply, r.error);
    // A pick on a live match hands on to the series, as the captain's route does (T3b).
    if (what === 'veto' && r.value.status === 'live') {
      try { opts.series?.afterPick(m.id); } catch (err) { console.error(`[events] scheduling match ${m.id} after the desk's pick failed:`, err instanceof Error ? err.message : err); }
    }
    opts.rooms?.pushChange(m.id);
    const teamName = N.getEntry(db, R.entryOn(m, side))?.name ?? (side === 'a' ? 'team A' : 'team B');
    tellStaffAction(opts, ev.id, m.id, what, `for ${teamName}`);
    logAdmin(db, me, 'event_act_for_team', ev.id, {
      matchId: m.id, kind: body.kind, side,
      ...(what === 'veto' ? { step: body.step, action: body.action, campaign: body.campaign ?? null } : {}),
      ...(what === 'lineup' ? { steamids: body.steamids } : {}),
    });
    return {};
  });

  /** Plan T3c Rulings 11 to 15 and 9: one route per desk tool, each through
   *  the series engine, which tells both rosters itself. Without the engine
   *  the routes answer 404, as confirm and dispute do. */
  const deskTool = (
    action: 'reopen-veto' | 'move-server' | 'extend-grace' | 'release-hold' | 'freeze' | 'unfreeze', audit: string,
    call: (s: NonNullable<typeof opts.series>, matchId: number, me: string, body: Record<string, unknown>) => Promise<V.Checked<unknown>> | V.Checked<unknown>,
    detail: (body: Record<string, unknown>) => object = () => ({}),
  ) =>
    app.post(`/api/admin/events/:id/matches/:matchId/${action}`, async (req, reply) => {
      const me = requireAdmin(req, reply);
      if (!me) return;
      const p = req.params as { id: string; matchId: string };
      const ev = eventOf(p.id);
      const matchId = idOf(p.matchId);
      const m = ev && matchId !== null ? P.getMatch(db, matchId) : undefined;
      if (!ev || !m || m.event_id !== ev.id) return refuse(reply, 'match_not_found');
      if (!opts.series) return reply.code(404).send({ error: 'not found' });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const r = await call(opts.series, m.id, me, body);
      if (!r.ok) return refuse(reply, r.error);
      opts.rooms?.pushChange(m.id);
      logAdmin(db, me, audit, ev.id, { matchId: m.id, ...detail(body) });
      return {};
    });
  deskTool('reopen-veto', 'event_veto_reopen', (s, id, me) => s.reopenVeto(id, me));
  // Plan T3c final review: a replay can take a minute or more (a dropped one
  // is tried three times), so the route answers once the quick refusals are
  // past, audits first, and the outcome reaches staff on the admin feed.
  app.post('/api/admin/events/:id/matches/:matchId/replay-chapter', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const p = req.params as { id: string; matchId: string };
    const ev = eventOf(p.id);
    const matchId = idOf(p.matchId);
    const m = ev && matchId !== null ? P.getMatch(db, matchId) : undefined;
    if (!ev || !m || m.event_id !== ev.id) return refuse(reply, 'match_not_found');
    if (!opts.series) return reply.code(404).send({ error: 'not found' });
    const ordinal = ((req.body ?? {}) as Record<string, unknown>).ordinal;
    const c = opts.series.replayCheck(m.id, ordinal);
    if (!c.ok) return refuse(reply, c.error);
    logAdmin(db, me, 'event_chapter_replay', ev.id, { matchId: m.id, ordinal });
    const rooms = opts.rooms;
    void opts.series.replayInBackground(m.id, me, ordinal).then(() => rooms?.pushChange(m.id));
    return { started: true };
  });
  deskTool('move-server', 'event_server_move', (s, id, me) => s.moveServer(id, me));
  deskTool('extend-grace', 'event_grace_extend', (s, id, me, body) => s.extendGrace(id, me, body.minutes), (body) => ({ minutes: body.minutes }));
  deskTool('release-hold', 'event_hold_release', (s, id, me) => s.releaseHold(id, me));
  deskTool('freeze', 'event_freeze', (s, id, me) => s.freeze(id, me, true));
  deskTool('unfreeze', 'event_unfreeze', (s, id, me) => s.freeze(id, me, false));
}
