import type { DB } from '../db.js';
import { getCampaignPool } from '../settings.js';
import { poolableCampaigns } from '../campaignRegistry.js';
import { parseRules, rulesForKind } from '../rulesets.js';
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
}
export interface StageRow {
  id: number; event_id: number; ordinal: number; type: V.StageType; config_json: string; ruleset_id: number;
  rules_json: string | null; game_config: string; campaign_pool_json: string; veto_type: V.VetoType;
  chapters: number | null; scheduling: V.Scheduling; advance_count: number | null; status: 'pending' | 'live' | 'finished';
  created_at: string; updated_at: string;
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
  return {
    type: s.type, config: JSON.parse(s.config_json) as V.StageConfig, rulesetId: s.ruleset_id, gameConfig: s.game_config,
    campaignPool: JSON.parse(s.campaign_pool_json) as string[], vetoType: s.veto_type, chapters: s.chapters,
    scheduling: s.scheduling, advanceCount: s.advance_count,
  };
}

/** The lists a stage is checked against, read now (Ruling 20). */
export function stageContext(db: DB): V.StageContext {
  const campaigns = new Set(poolableCampaigns(db).map((c) => c.slug));
  return {
    campaigns,
    rulesetIds: new Set((db.prepare('SELECT id FROM rulesets WHERE archived_at IS NULL').all() as { id: number }[]).map((r) => r.id)),
    gameConfigs: new Set((db.prepare('SELECT key FROM game_configs WHERE enabled = 1').all() as { key: string }[]).map((r) => r.key)),
    defaultPool: getCampaignPool(db).filter((s) => campaigns.has(s)).slice(0, V.POOL_MAX),
  };
}

const iso = (now?: Date): string => (now ?? new Date()).toISOString();

/** Inside the caller's transaction, always. */
function logEvent(db: DB, eventId: number, actor: string | null, action: string, at: string, detail: object = {}): void {
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

/** Ruling 7: the ruleset as a tournament plays it, or null if it is gone or unreadable. */
function rulesSnapshot(db: DB, rulesetId: number): string | null {
  const row = db.prepare('SELECT rules_json FROM rulesets WHERE id = ? AND archived_at IS NULL').get(rulesetId) as { rules_json: string } | undefined;
  if (!row) return null;
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
       veto_type, chapters, scheduling, advance_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(eventId, ordinal, s.type, JSON.stringify(s.config), s.rulesetId, rules, s.gameConfig, JSON.stringify(s.campaignPool),
    s.vetoType, s.chapters, s.scheduling, s.advanceCount, at, at).lastInsertRowid);
}

function writeStage(db: DB, id: number, s: V.StageSettings, rules: string | null, at: string): void {
  db.prepare(
    `UPDATE event_stages SET type = ?, config_json = ?, ruleset_id = ?, rules_json = ?, game_config = ?, campaign_pool_json = ?,
       veto_type = ?, chapters = ?, scheduling = ?, advance_count = ?, updated_at = ? WHERE id = ?`,
  ).run(s.type, JSON.stringify(s.config), s.rulesetId, rules, s.gameConfig, JSON.stringify(s.campaignPool),
    s.vetoType, s.chapters, s.scheduling, s.advanceCount, at, id);
}

/** The stage chain as it stands, for publish and open registration (Ruling 16). */
function chainOf(db: DB, ev: EventRow): V.Checked<null> {
  const f = fieldsOf(ev);
  return V.checkChain(stagesOf(db, ev.id).map((s) => ({ advanceCount: s.advance_count })), { teamCap: f.teamCap, roster: f.roster });
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
