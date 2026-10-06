import type { DB } from '../db.js';
import { getCampaignPool } from '../settings.js';
import { poolableCampaigns } from '../campaignRegistry.js';
import { parseRules, rulesForKind } from '../rulesets.js';
import { isPug } from '../rulesetStore.js';
import { presetConfig, type VetoConfig } from './vetoConfig.js';
import * as V from './validate.js';

/**
 * Every write to events, event_stages and event_log (tournaments plan T1a).
 *
 * Each mutation is one better-sqlite3 transaction that re-reads the event,
 * checks its rules inside, writes, and adds its event_log row before it
 * commits. If the audit row cannot be written, nothing is: the insert throws
 * and the transaction rolls back (tests/eventLogGuard.test.ts pins this and
 * that nothing else in src/ writes these tables). A refusal returns before
 * any write, so it leaves no trace. Results are { ok, value } or
 * { ok: false, error } with error a key of V.EVENT_ERRORS, the same shape as
 * src/teams/teams.ts, so the routes map them to a status and a sentence.
 */

export interface EventRow {
  id: number; slug: string; name: string; banner_key: string | null; region: string; organizer_steamid: string;
  official: number; entry_kind: V.EntryKind; status: V.EventStatus; starts_at: string; description: string;
  eligibility_json: string; team_cap: number | null; checkin_json: string; roster_json: string;
  created_at: string; updated_at: string; finished_at: string | null; cancelled_at: string | null; cancel_reason: string | null;
  locked_at: string | null;
  live_at: string | null;
}
export interface StageRow {
  id: number; event_id: number; ordinal: number; type: V.StageType; config_json: string; ruleset_id: number;
  rules_json: string | null; game_config: string; campaign_pool_json: string; veto_type: V.VetoType; veto_json: string | null;
  chapters: number | null; scheduling: V.Scheduling; advance_count: number | null; status: 'pending' | 'live' | 'finished';
  created_at: string; updated_at: string;
  entrants_json: string | null; bracket_json: string | null; bracket_rev: number; started_at: string | null; finished_at: string | null;
  /** Plan T4: the per-round schedule (validate.ts RoundSchedule rows), or null. */
  schedule_json: string | null;
}
export interface EventLogRow { id: number; event_id: number; at: string; actor: string | null; action: string; detail: string }
export type EventResult<T> = V.Checked<T>;

export function getEvent(db: DB, id: number): EventRow | undefined {
  return db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined;
}
export function getEventBySlug(db: DB, slug: string): EventRow | undefined {
  return db.prepare('SELECT * FROM events WHERE slug = ?').get(slug) as EventRow | undefined;
}
export function getStage(db: DB, id: number): StageRow | undefined {
  return db.prepare('SELECT * FROM event_stages WHERE id = ?').get(id) as StageRow | undefined;
}
export function stagesOf(db: DB, eventId: number): StageRow[] {
  return db.prepare('SELECT * FROM event_stages WHERE event_id = ? ORDER BY ordinal').all(eventId) as StageRow[];
}
export function eventLog(db: DB, eventId: number): EventLogRow[] {
  return db.prepare('SELECT * FROM event_log WHERE event_id = ? ORDER BY id').all(eventId) as EventLogRow[];
}

/** The JSON columns were written by this module from validated values. */
export function fieldsOf(ev: EventRow): V.EventFields {
  return {
    name: ev.name, startsAt: ev.starts_at, entryKind: ev.entry_kind, official: ev.official === 1, teamCap: ev.team_cap,
    description: ev.description,
    eligibility: JSON.parse(ev.eligibility_json) as V.Eligibility,
    checkin: JSON.parse(ev.checkin_json) as V.Checkin,
    roster: JSON.parse(ev.roster_json) as V.RosterRules,
  };
}

export function stageSettingsOf(s: StageRow): V.StageSettings {
  let config = JSON.parse(s.config_json) as V.StageConfig;
  if (s.type === 'league') {
    // T1a stored weeks; plan T2 counts matches (owner, 2026-10-05).
    const c = config as Partial<V.StageConfigs['league']> & { weeks?: number };
    config = {
      matches: c.matches ?? (c.weeks !== undefined ? c.weeks * (c.matchesPerWeek ?? 1) : 16), matchesPerWeek: c.matchesPerWeek ?? 1,
      pairing: c.pairing ?? 'swiss', seasonStart: c.seasonStart ?? null,
    };
  }
  const pool = JSON.parse(s.campaign_pool_json) as string[];
  // Stages made before plan T3a have no veto_json: their veto_type names a preset.
  const veto: VetoConfig = s.veto_json ? JSON.parse(s.veto_json) as VetoConfig : presetConfig(s.veto_type, pool.length);
  return {
    type: s.type, config, rulesetId: s.ruleset_id, gameConfig: s.game_config,
    campaignPool: pool, vetoType: s.veto_type, veto, chapters: s.chapters,
    scheduling: s.scheduling, advanceCount: s.advance_count,
  };
}

/** The per-round schedule (plan T4 Ruling 2), empty when none was set. */
export function scheduleOf(s: StageRow): V.RoundSchedule[] {
  return s.schedule_json ? JSON.parse(s.schedule_json) as V.RoundSchedule[] : [];
}

/** The lists a stage is checked against, read now (Ruling 20). PUG is left
 *  out of rulesetIds (it is for PUGs, not events) and named separately so a
 *  stage that picks it gets its own refusal, not a generic "no such ruleset". */
export function stageContext(db: DB): V.StageContext {
  const campaigns = new Set(poolableCampaigns(db).map((c) => c.slug));
  const rulesets = db.prepare('SELECT id, template, name FROM rulesets WHERE archived_at IS NULL').all() as
    { id: number; template: number; name: string }[];
  const pug = rulesets.find((r) => isPug(r));
  return {
    campaigns,
    rulesetIds: new Set(rulesets.filter((r) => !isPug(r)).map((r) => r.id)),
    pugRulesetId: pug ? pug.id : null,
    gameConfigs: new Set((db.prepare('SELECT key FROM game_configs WHERE enabled = 1').all() as { key: string }[]).map((r) => r.key)),
    defaultPool: getCampaignPool(db).filter((s) => campaigns.has(s)).slice(0, V.POOL_MAX),
  };
}

const iso = (now?: Date): string => (now ?? new Date()).toISOString();

/** Inside the caller's transaction, always. Exported for src/events/entries.ts
 *  only: tests/eventLogGuard.test.ts holds every caller to one row per
 *  successful mutation. */
export function logEvent(db: DB, eventId: number, actor: string | null, action: string, at: string, detail: object = {}): void {
  db.prepare('INSERT INTO event_log (event_id, at, actor, action, detail) VALUES (?, ?, ?, ?, ?)')
    .run(eventId, at, actor, action, JSON.stringify(detail));
}

function touch(db: DB, eventId: number, at: string): void {
  db.prepare('UPDATE events SET updated_at = ? WHERE id = ?').run(at, eventId);
}

/** Unique over every event ever made (Ruling 9), fixed at creation. */
function slugFor(db: DB, name: string): string {
  const base = V.eventSlugBase(name);
  const taken = db.prepare('SELECT 1 FROM events WHERE slug = ?');
  if (!V.RESERVED_EVENT_SLUGS.has(base) && !taken.get(base)) return base;
  for (let n = 2; ; n++) {
    const s = `${base}-${n}`;
    if (!taken.get(s)) return s;
  }
}

/** Ruling 7: the ruleset as a tournament plays it, or null if it is gone,
 *  unreadable, or PUG (stageContext already keeps a stage off PUG, but this
 *  is the last line before a snapshot is written, so it checks again). */
function rulesSnapshot(db: DB, rulesetId: number): string | null {
  const row = db.prepare('SELECT rules_json, template, name FROM rulesets WHERE id = ? AND archived_at IS NULL').get(rulesetId) as
    { rules_json: string; template: number; name: string } | undefined;
  if (!row || isPug(row)) return null;
  try {
    return JSON.stringify(rulesForKind('tournament', parseRules(row.rules_json)));
  } catch {
    return null;
  }
}

/** Ordinals 1..n in the given order. Through negatives first, so the unique
 *  (event_id, ordinal) index never sees two stages on one number, whatever
 *  order SQLite visits the rows in. */
function renumber(db: DB, eventId: number, ids: number[]): void {
  db.prepare('UPDATE event_stages SET ordinal = -ordinal WHERE event_id = ?').run(eventId);
  const set = db.prepare('UPDATE event_stages SET ordinal = ? WHERE id = ?');
  ids.forEach((id, i) => set.run(i + 1, id));
}

function ownStage(db: DB, eventId: number, stageId: number): StageRow | undefined {
  const s = getStage(db, stageId);
  return s && s.event_id === eventId ? s : undefined;
}

function insertStage(db: DB, eventId: number, ordinal: number, s: V.StageSettings, rules: string | null, at: string): number {
  return Number(db.prepare(
    `INSERT INTO event_stages (event_id, ordinal, type, config_json, ruleset_id, rules_json, game_config, campaign_pool_json,
       veto_type, veto_json, chapters, scheduling, advance_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(eventId, ordinal, s.type, JSON.stringify(s.config), s.rulesetId, rules, s.gameConfig, JSON.stringify(s.campaignPool),
    s.vetoType, JSON.stringify(s.veto), s.chapters, s.scheduling, s.advanceCount, at, at).lastInsertRowid);
}

function writeStage(db: DB, id: number, s: V.StageSettings, rules: string | null, at: string): void {
  db.prepare(
    `UPDATE event_stages SET type = ?, config_json = ?, ruleset_id = ?, rules_json = ?, game_config = ?, campaign_pool_json = ?,
       veto_type = ?, veto_json = ?, chapters = ?, scheduling = ?, advance_count = ?, updated_at = ? WHERE id = ?`,
  ).run(s.type, JSON.stringify(s.config), s.rulesetId, rules, s.gameConfig, JSON.stringify(s.campaignPool),
    s.vetoType, JSON.stringify(s.veto), s.chapters, s.scheduling, s.advanceCount, at, id);
}

/** The stage chain as it stands, for publish and open registration (Ruling 16). */
/** The stage chain as it stands now (Ruling 16); also re-checked when play
 *  starts, since stages can change after registration opens. */
export function chainOf(db: DB, ev: EventRow): V.Checked<null> {
  const f = fieldsOf(ev);
  return V.checkChain(stagesOf(db, ev.id).map((s) => ({ type: s.type, advanceCount: s.advance_count })), { teamCap: f.teamCap, roster: f.roster });
}

export function createEvent(db: DB, o: { by: string; fields: unknown; now?: Date }): EventResult<EventRow> {
  const at = iso(o.now);
  const parsed = V.parseEventFields(o.fields, null);
  if (!parsed.ok) return parsed;
  const f = parsed.value;
  if (f.startsAt <= at) return V.fail('start_passed');
  return db.transaction((): EventResult<EventRow> => {
    const id = Number(db.prepare(
      `INSERT INTO events (slug, name, organizer_steamid, official, entry_kind, starts_at, description,
         eligibility_json, team_cap, checkin_json, roster_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(slugFor(db, f.name), f.name, o.by, f.official ? 1 : 0, f.entryKind, f.startsAt, f.description,
      JSON.stringify(f.eligibility), f.teamCap, JSON.stringify(f.checkin), JSON.stringify(f.roster), at, at).lastInsertRowid);
    logEvent(db, id, o.by, 'created', at, { name: f.name, startsAt: f.startsAt, entryKind: f.entryKind });
    return V.ok(getEvent(db, id)!);
  })();
}

export function updateEvent(db: DB, o: { eventId: number; by: string; fields: unknown; now?: Date }): EventResult<EventRow> {
  const at = iso(o.now);
  return db.transaction((): EventResult<EventRow> => {
    const ev = getEvent(db, o.eventId);
    if (!ev) return V.fail('not_found');
    if (!V.EVENT_EDITABLE.has(ev.status)) return V.fail('wrong_status');
    // With check-in off an event stays in registration after its list is
    // final; the cap, rules and start must not move under a final list.
    if (ev.locked_at !== null) return V.fail('entries_locked');
    const before = fieldsOf(ev);
    const parsed = V.parseEventFields(o.fields, before);
    if (!parsed.ok) return parsed;
    const f = parsed.value;
    if (f.entryKind !== before.entryKind && ev.status !== 'draft') return V.fail('kind_locked');
    if (f.startsAt !== before.startsAt && f.startsAt <= at) return V.fail('start_passed');
    const changed = (Object.keys(f) as (keyof V.EventFields)[]).filter((k) => JSON.stringify(f[k]) !== JSON.stringify(before[k]));
    if (changed.length === 0) return V.ok(ev);
    db.prepare(
      `UPDATE events SET name = ?, official = ?, entry_kind = ?, starts_at = ?, description = ?, eligibility_json = ?,
         team_cap = ?, checkin_json = ?, roster_json = ?, updated_at = ? WHERE id = ?`,
    ).run(f.name, f.official ? 1 : 0, f.entryKind, f.startsAt, f.description, JSON.stringify(f.eligibility),
      f.teamCap, JSON.stringify(f.checkin), JSON.stringify(f.roster), at, ev.id);
    logEvent(db, ev.id, o.by, 'edited', at, { changed });
    return V.ok(getEvent(db, ev.id)!);
  })();
}

export function addStage(db: DB, o: { eventId: number; by: string; stage: unknown; now?: Date }): EventResult<StageRow> {
  const at = iso(o.now);
  const ctx = stageContext(db);
  return db.transaction((): EventResult<StageRow> => {
    const ev = getEvent(db, o.eventId);
    if (!ev) return V.fail('not_found');
    if (V.STAGES_LOCKED.has(ev.status)) return V.fail('stages_locked');
    const count = stagesOf(db, ev.id).length;
    if (count >= V.STAGES_MAX) return V.fail('too_many_stages');
    const p = V.parseStage(o.stage, ctx);
    if (!p.ok) return p;
    const rules = ev.status === 'draft' ? null : rulesSnapshot(db, p.value.rulesetId);
    if (ev.status !== 'draft' && rules === null) return V.fail('bad_ruleset');
    const id = insertStage(db, ev.id, count + 1, p.value, rules, at);
    touch(db, ev.id, at);
    logEvent(db, ev.id, o.by, 'stage_added', at, { stageId: id, ordinal: count + 1, type: p.value.type });
    return V.ok(getStage(db, id)!);
  })();
}

export function updateStage(db: DB, o: { eventId: number; stageId: number; by: string; stage: unknown; now?: Date }): EventResult<StageRow> {
  const at = iso(o.now);
  const ctx = stageContext(db);
  return db.transaction((): EventResult<StageRow> => {
    const ev = getEvent(db, o.eventId);
    if (!ev) return V.fail('not_found');
    if (V.STAGES_LOCKED.has(ev.status)) return V.fail('stages_locked');
    const s = ownStage(db, ev.id, o.stageId);
    if (!s) return V.fail('stage_not_found');
    const p = V.parseStage(o.stage, ctx);
    if (!p.ok) return p;
    const rules = ev.status === 'draft' ? null : rulesSnapshot(db, p.value.rulesetId);
    if (ev.status !== 'draft' && rules === null) return V.fail('bad_ruleset');
    writeStage(db, s.id, p.value, rules, at);
    touch(db, ev.id, at);
    logEvent(db, ev.id, o.by, 'stage_edited', at, { stageId: s.id, ordinal: s.ordinal, type: p.value.type });
    return V.ok(getStage(db, s.id)!);
  })();
}

/** Ruling 18: a stage has nothing hanging off it yet, so it is deleted. */
export function removeStage(db: DB, o: { eventId: number; stageId: number; by: string; now?: Date }): EventResult<null> {
  const at = iso(o.now);
  return db.transaction((): EventResult<null> => {
    const ev = getEvent(db, o.eventId);
    if (!ev) return V.fail('not_found');
    if (V.STAGES_LOCKED.has(ev.status)) return V.fail('stages_locked');
    const s = ownStage(db, ev.id, o.stageId);
    if (!s) return V.fail('stage_not_found');
    db.prepare('DELETE FROM event_stages WHERE id = ?').run(s.id);
    renumber(db, ev.id, stagesOf(db, ev.id).map((x) => x.id));
    touch(db, ev.id, at);
    logEvent(db, ev.id, o.by, 'stage_removed', at, { stageId: s.id, ordinal: s.ordinal, type: s.type });
    return V.ok(null);
  })();
}

export function reorderStages(db: DB, o: { eventId: number; by: string; order: unknown; now?: Date }): EventResult<StageRow[]> {
  const at = iso(o.now);
  return db.transaction((): EventResult<StageRow[]> => {
    const ev = getEvent(db, o.eventId);
    if (!ev) return V.fail('not_found');
    if (V.STAGES_LOCKED.has(ev.status)) return V.fail('stages_locked');
    const ids = stagesOf(db, ev.id).map((s) => s.id);
    const order = o.order;
    if (!Array.isArray(order) || order.length !== ids.length || new Set(order).size !== ids.length
      || !order.every((x) => typeof x === 'number' && ids.includes(x))) {
      return V.fail('bad_order');
    }
    renumber(db, ev.id, order as number[]);
    touch(db, ev.id, at);
    logEvent(db, ev.id, o.by, 'stages_reordered', at, { order });
    return V.ok(stagesOf(db, ev.id));
  })();
}

/** A schedule may change while the event runs (a league's later weeks, a
 *  Swiss round paired later), so this is not behind STAGES_LOCKED: only a
 *  finished or cancelled event, or a finished stage, refuses it. The rows
 *  are stamped onto matches by src/events/play.ts (insertRound for rounds
 *  written later, applySchedule for the ones that exist). */
const SCHEDULE_LOCKED: ReadonlySet<V.EventStatus> = new Set<V.EventStatus>(['finished', 'cancelled']);

export function setRoundSchedule(db: DB, o: { eventId: number; stageId: number; by: string; rounds: unknown; now?: Date }): EventResult<StageRow> {
  const at = iso(o.now);
  return db.transaction((): EventResult<StageRow> => {
    const ev = getEvent(db, o.eventId);
    if (!ev) return V.fail('not_found');
    if (SCHEDULE_LOCKED.has(ev.status)) return V.fail('schedule_locked');
    const s = ownStage(db, ev.id, o.stageId);
    if (!s) return V.fail('stage_not_found');
    if (s.status === 'finished') return V.fail('schedule_locked');
    const p = V.parseRoundSchedule(o.rounds, s.scheduling);
    if (!p.ok) return p;
    db.prepare('UPDATE event_stages SET schedule_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(p.value), at, s.id);
    touch(db, ev.id, at);
    logEvent(db, ev.id, o.by, 'schedule_set', at, { stageId: s.id, ordinal: s.ordinal, rounds: p.value.map((r) => r.round) });
    return V.ok(getStage(db, s.id)!);
  })();
}

/** draft -> announced. Every stage is checked again against the lists of
 *  this moment (Ruling 20) and its ruleset snapshotted (Ruling 7). */
export function publishEvent(db: DB, o: { eventId: number; by: string; now?: Date }): EventResult<EventRow> {
  const at = iso(o.now);
  const ctx = stageContext(db);
  return db.transaction((): EventResult<EventRow> => {
    const ev = getEvent(db, o.eventId);
    if (!ev) return V.fail('not_found');
    if (!V.nextStatusAllowed(ev.status, 'announced')) return V.fail('wrong_status');
    if (ev.starts_at <= at) return V.fail('start_passed');
    const chain = chainOf(db, ev);
    if (!chain.ok) return chain;
    const snapshots: [number, string][] = [];
    for (const s of stagesOf(db, ev.id)) {
      const p = V.parseStage(stageSettingsOf(s), ctx);
      if (!p.ok) return p;
      const rules = rulesSnapshot(db, s.ruleset_id);
      if (rules === null) return V.fail('bad_ruleset');
      snapshots.push([s.id, rules]);
    }
    const snap = db.prepare('UPDATE event_stages SET rules_json = ?, updated_at = ? WHERE id = ?');
    for (const [id, rules] of snapshots) snap.run(rules, at, id);
    db.prepare("UPDATE events SET status = 'announced', updated_at = ? WHERE id = ?").run(at, ev.id);
    logEvent(db, ev.id, o.by, 'published', at, { stages: snapshots.length });
    return V.ok(getEvent(db, ev.id)!);
  })();
}

/** announced -> registration, team events only (Ruling 15). */
export function openRegistration(db: DB, o: { eventId: number; by: string; now?: Date }): EventResult<EventRow> {
  const at = iso(o.now);
  return db.transaction((): EventResult<EventRow> => {
    const ev = getEvent(db, o.eventId);
    if (!ev) return V.fail('not_found');
    if (!V.nextStatusAllowed(ev.status, 'registration')) return V.fail('wrong_status');
    if (ev.entry_kind === 'draft') return V.fail('draft_signups_later');
    if (ev.starts_at <= at) return V.fail('start_passed');
    const chain = chainOf(db, ev);
    if (!chain.ok) return chain;
    db.prepare("UPDATE events SET status = 'registration', updated_at = ? WHERE id = ?").run(at, ev.id);
    logEvent(db, ev.id, o.by, 'registration_opened', at);
    return V.ok(getEvent(db, ev.id)!);
  })();
}

/** registration -> checkin (T1b Ruling 4): the runner calls it at
 *  starts_at - opensMinutes with by null; an admin may call it early. */
export function openCheckin(db: DB, o: { eventId: number; by: string | null; now?: Date }): EventResult<EventRow> {
  const at = iso(o.now);
  return db.transaction((): EventResult<EventRow> => {
    const ev = getEvent(db, o.eventId);
    if (!ev) return V.fail('not_found');
    if (!fieldsOf(ev).checkin.enabled) return V.fail('no_checkin');
    if (!V.nextStatusAllowed(ev.status, 'checkin') || ev.locked_at !== null) return V.fail('wrong_status');
    db.prepare("UPDATE events SET status = 'checkin', updated_at = ? WHERE id = ?").run(at, ev.id);
    logEvent(db, ev.id, o.by, 'checkin_opened', at);
    return V.ok(getEvent(db, ev.id)!);
  })();
}

export function cancelEvent(db: DB, o: { eventId: number; by: string; reason: unknown; now?: Date }): EventResult<EventRow> {
  const at = iso(o.now);
  const reason = V.normalizeReason(o.reason);
  if (!reason.ok) return reason;
  return db.transaction((): EventResult<EventRow> => {
    const ev = getEvent(db, o.eventId);
    if (!ev) return V.fail('not_found');
    if (!V.nextStatusAllowed(ev.status, 'cancelled')) return V.fail('wrong_status');
    db.prepare("UPDATE events SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, updated_at = ? WHERE id = ?")
      .run(at, reason.value, at, ev.id);
    logEvent(db, ev.id, o.by, 'cancelled', at, { from: ev.status, reason: reason.value });
    return V.ok(getEvent(db, ev.id)!);
  })();
}

const BANNER_KEY = /^[0-9a-f]{64}$/;

/** Set or clear the banner (Ruling 4). Any status: a finished event's page
 *  keeps a banner, and a new one may still go up for the archive. The file is
 *  already in the community store; setting the key that is there already
 *  writes nothing. */
export function setEventBanner(db: DB, o: { eventId: number; by: string; bannerKey: string | null; now?: Date }): EventResult<EventRow> {
  const at = iso(o.now);
  if (o.bannerKey !== null && !BANNER_KEY.test(o.bannerKey)) return V.fail('bad_request');
  return db.transaction((): EventResult<EventRow> => {
    const ev = getEvent(db, o.eventId);
    if (!ev) return V.fail('not_found');
    if (ev.banner_key === o.bannerKey) return V.ok(ev);
    db.prepare('UPDATE events SET banner_key = ?, updated_at = ? WHERE id = ?').run(o.bannerKey, at, ev.id);
    logEvent(db, ev.id, o.by, o.bannerKey ? 'banner_set' : 'banner_removed', at, { bannerKey: o.bannerKey, previous: ev.banner_key });
    return V.ok(getEvent(db, ev.id)!);
  })();
}

/**
 * Delete a draft outright: it was never public, so there is nothing to keep
 * (cancelling it would publish it under Past). One transaction removes its
 * event_log rows, its stages and the event row, in that order for the
 * foreign keys. This is the one write here that adds no event_log row, as the
 * rows it would add to are the ones it deletes; the admin audit row the route
 * writes (event_delete, with the name and slug) is the record that it
 * existed. tests/eventLogGuard.test.ts holds it to leaving no row behind and
 * to writing nothing when any delete fails. A draft cannot have entries; if
 * one somehow does, it is refused rather than orphaned.
 */
export function deleteDraftEvent(db: DB, o: { eventId: number; by: string }): EventResult<EventRow> {
  return db.transaction((): EventResult<EventRow> => {
    const ev = getEvent(db, o.eventId);
    if (!ev) return V.fail('not_found');
    if (ev.status !== 'draft') return V.fail('wrong_status');
    if (db.prepare('SELECT 1 FROM event_entries WHERE event_id = ? LIMIT 1').get(ev.id)) return V.fail('has_entries');
    db.prepare('DELETE FROM event_log WHERE event_id = ?').run(ev.id);
    db.prepare('DELETE FROM event_stages WHERE event_id = ?').run(ev.id);
    db.prepare('DELETE FROM events WHERE id = ?').run(ev.id);
    return V.ok(ev);
  })();
}
