import type { DB } from '../db.js';
import { getPlayer } from '../players.js';
import { inGoodStanding } from '../standing.js';
import * as T from '../teams/teams.js';
import * as E from './events.js';
import * as N from './entries.js';
import * as V from './validate.js';
import { KEEP_MAJORITY, KEEP_OFFER_DAYS, KEEP_VOTE_HOURS } from './draftRules.js';

/**
 * Keep this team (drafts plan D3b, spec part 3 section 7): every write to
 * draft_keeps and draft_keep_answers. Each mutation is one transaction that
 * re-reads, checks, writes and adds exactly one event_log row; a refusal
 * writes nothing. The team itself is made by src/teams/teams.ts
 * (createDraftTeam, addDraftMember) inside settleKeep's and answerKeep's
 * transactions, so a failed audit row leaves no team behind.
 */

export type KeepStatus = 'offered' | 'voting' | 'made' | 'lapsed';
export interface KeepRow {
  id: number; event_id: number; entry_id: number; captain_steamid: string; players_json: string; status: KeepStatus;
  name: string | null; tag: string | null; offered_at: string; started_at: string | null; expires_at: string; team_id: number | null; closed_at: string | null;
}
/** What a settle did: made the team, or closed the keep because its captain
 *  is no longer in good standing (no team; the DM layer tells the players). */
export type SettleOutcome =
  | { made: true; teamId: number; slug: string; joined: string[]; left: string[] }
  | { made: false; closed: 'captain_standing' };
export interface KeepAnswerRow { keep_id: number; steamid: string; answer: 'accept' | 'decline'; answered_at: string; joined: number }
export interface MyKeepView {
  keepId: number; status: KeepStatus; captain: boolean; team: string; name: string | null; tag: string | null;
  /** What the captain's form starts from: the draft entry's name and tag. */
  defaults: { name: string; tag: string }; expiresAt: string; closed: boolean;
  players: { name: string; captain: boolean; answer: 'accept' | 'decline' | null }[];
  myAnswer: 'accept' | 'decline' | null; teamSlug: string | null;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const due = (k: KeepRow, now: Date): boolean => now.getTime() >= Date.parse(k.expires_at);

// ---------- reads ----------

export function keepOf(db: DB, id: number): KeepRow | undefined {
  return db.prepare('SELECT * FROM draft_keeps WHERE id = ?').get(id) as KeepRow | undefined;
}
export function keepOfEntry(db: DB, entryId: number): KeepRow | undefined {
  return db.prepare('SELECT * FROM draft_keeps WHERE entry_id = ?').get(entryId) as KeepRow | undefined;
}
export function keepsOf(db: DB, eventId: number): KeepRow[] {
  return db.prepare('SELECT * FROM draft_keeps WHERE event_id = ? ORDER BY id').all(eventId) as KeepRow[];
}
/** Keeps the tick still looks at. */
export function openKeeps(db: DB): KeepRow[] {
  return db.prepare('SELECT * FROM draft_keeps WHERE closed_at IS NULL ORDER BY id').all() as KeepRow[];
}
export function answersOf(db: DB, keepId: number): KeepAnswerRow[] {
  return db.prepare('SELECT * FROM draft_keep_answers WHERE keep_id = ? ORDER BY answered_at, steamid').all(keepId) as KeepAnswerRow[];
}
/** The four at the offer, captain first. */
export function playersOf(k: KeepRow): string[] {
  return JSON.parse(k.players_json) as string[];
}
/** Ruling 8: the event a kept team was formed at, with the entry's placement. */
export function keptFrom(db: DB, teamId: number): { eventSlug: string; eventName: string; placement: number | null } | null {
  const row = db.prepare(
    `SELECT e.slug, e.name, x.placement FROM draft_keeps k JOIN events e ON e.id = k.event_id JOIN event_entries x ON x.id = k.entry_id
      WHERE k.team_id = ?`,
  ).get(teamId) as { slug: string; name: string; placement: number | null } | undefined;
  return row ? { eventSlug: row.slug, eventName: row.name, placement: row.placement } : null;
}
/** The viewer's keep in this event: only for one of its four. */
export function myKeepView(db: DB, eventId: number, viewer: string, now: Date): MyKeepView | null {
  const k = keepsOf(db, eventId).find((x) => playersOf(x).includes(viewer));
  if (!k) return null;
  const entry = N.getEntry(db, k.entry_id);
  const answers = new Map(answersOf(db, k.id).map((a) => [a.steamid, a.answer]));
  const team = k.team_id !== null ? T.getTeam(db, k.team_id) : undefined;
  return {
    keepId: k.id, status: k.status, captain: k.captain_steamid === viewer, team: entry?.name ?? '', name: k.name, tag: k.tag,
    defaults: { name: entry?.name ?? '', tag: entry?.tag ?? '' }, expiresAt: k.expires_at, closed: k.closed_at !== null || due(k, now),
    players: playersOf(k).map((s) => ({ name: getPlayer(db, s)?.name ?? s, captain: s === k.captain_steamid, answer: answers.get(s) ?? null })),
    myAnswer: answers.get(viewer) ?? null, teamSlug: team?.slug ?? null,
  };
}

// ---------- mutations ----------

/** Rulings 1 and 2: the tick offers a finished draft team's captain, within KEEP_OFFER_DAYS of the finish. */
export function offerKeep(db: DB, o: { entryId: number; now: Date }): V.Checked<{ keepId: number }> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<{ keepId: number }> => {
    const entry = N.getEntry(db, o.entryId);
    if (!entry || entry.captain_steamid === null || !N.isActive(entry)) return V.fail('keep_not_open');
    const ev = E.getEvent(db, entry.event_id)!;
    if (ev.entry_kind !== 'draft' || ev.status !== 'finished' || ev.finished_at === null) return V.fail('keep_not_open');
    if (keepOfEntry(db, entry.id)) return V.fail('keep_started');
    const ends = Date.parse(ev.finished_at) + KEEP_OFFER_DAYS * DAY;
    if (o.now.getTime() >= ends) return V.fail('keep_closed');
    const captain = entry.captain_steamid;
    const players = [captain, ...N.rosterOf(db, entry.id).starters.filter((s) => s !== captain)];
    if (players.length < KEEP_MAJORITY) return V.fail('keep_not_open');
    const id = Number(db.prepare(
      `INSERT INTO draft_keeps (event_id, entry_id, captain_steamid, players_json, status, offered_at, expires_at)
       VALUES (?, ?, ?, ?, 'offered', ?, ?)`,
    ).run(ev.id, entry.id, captain, JSON.stringify(players), at, new Date(ends).toISOString()).lastInsertRowid);
    E.logEvent(db, ev.id, null, 'keep_offered', at, { keepId: id, entryId: entry.id });
    return V.ok({ keepId: id });
  })();
}

/** Ruling 4: the captain presses Keep with the team's name and tag. They
 *  count as the first accept; voting runs KEEP_VOTE_HOURS. */
export function startKeep(db: DB, o: { entryId: number; steamid: string; name: unknown; tag: unknown; now: Date }): V.Checked<{ keepId: number }> {
  const at = o.now.toISOString();
  const n = T.normalizeName(o.name);
  if (!n.ok) return V.fail(n.error === 'name_not_allowed' ? 'name_not_allowed' : 'bad_entry_name');
  const t = T.normalizeTag(o.tag);
  if (!t.ok) return V.fail(t.error === 'tag_not_allowed' ? 'tag_not_allowed' : 'bad_tag');
  return db.transaction((): V.Checked<{ keepId: number }> => {
    const k = keepOfEntry(db, o.entryId);
    if (!k) return V.fail('keep_not_open');
    if (k.captain_steamid !== o.steamid) return V.fail('not_captain');
    if (k.status === 'lapsed' || k.closed_at !== null || due(k, o.now)) return V.fail('keep_closed');
    if (k.status !== 'offered') return V.fail('keep_started');
    if (!getPlayer(db, o.steamid) || !inGoodStanding(db, o.steamid, o.now)) return V.fail('not_player');
    if (T.nameTaken(db, n.key)) return V.fail('keep_name_taken');
    if (T.tagTaken(db, t.key)) return V.fail('keep_tag_taken');
    if (T.activeMembershipCount(db, o.steamid) >= T.membershipCap(db)) return V.fail('keep_cap');
    if (!T.canCreate(db, o.steamid)) return V.fail('keep_created_cap');
    const expires = new Date(o.now.getTime() + KEEP_VOTE_HOURS * HOUR).toISOString();
    db.prepare("UPDATE draft_keeps SET status = 'voting', name = ?, tag = ?, started_at = ?, expires_at = ? WHERE id = ?").run(n.name, t.tag, at, expires, k.id);
    db.prepare("INSERT INTO draft_keep_answers (keep_id, steamid, answer, answered_at) VALUES (?, ?, 'accept', ?)").run(k.id, o.steamid, at);
    E.logEvent(db, k.event_id, o.steamid, 'keep_started', at, { keepId: k.id, name: n.name, tag: t.tag });
    return V.ok({ keepId: k.id });
  })();
}

/** One of the other three answers (Rulings 3 and 6). An accept at the cap is
 *  refused with nothing written. After the team is made, an accept joins it
 *  at once (Review Focus 1). */
export function answerKeep(db: DB, o: { keepId: number; steamid: string; accept: boolean; now: Date }): V.Checked<{ joined: boolean }> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<{ joined: boolean }> => {
    const k = keepOf(db, o.keepId);
    if (!k) return V.fail('keep_not_open');
    if (!playersOf(k).includes(o.steamid) || o.steamid === k.captain_steamid) return V.fail('keep_not_player');
    if (k.status === 'offered') return V.fail('keep_not_open');
    if (k.status === 'lapsed' || k.closed_at !== null || due(k, o.now)) return V.fail('keep_closed');
    if (answersOf(db, k.id).some((a) => a.steamid === o.steamid)) return V.fail('keep_answered');
    if (o.accept && T.activeMembershipCount(db, o.steamid) >= T.membershipCap(db)) return V.fail('keep_cap');
    let joined = false;
    if (o.accept && k.status === 'made' && k.team_id !== null) {
      const add = T.addDraftMember(db, { teamId: k.team_id, steamid: o.steamid, now: o.now });
      if (!add.ok) return V.fail(add.error === 'their_cap' ? 'keep_cap' : add.error === 'already_member' ? 'keep_answered' : add.error === 'not_player' ? 'not_player' : add.error === 'roster_full' ? 'roster_full' : 'keep_closed');
      joined = true;
    }
    db.prepare('INSERT INTO draft_keep_answers (keep_id, steamid, answer, answered_at, joined) VALUES (?, ?, ?, ?, ?)')
      .run(k.id, o.steamid, o.accept ? 'accept' : 'decline', at, joined ? 1 : 0);
    E.logEvent(db, k.event_id, o.steamid, 'keep_answered', at, { keepId: k.id, accept: o.accept, joined });
    return V.ok({ joined });
  })();
}

/** Ruling 3: once three accepters can join, the team is made (an accepter at
 *  the cap is left out). keep_waiting while fewer can. A captain no longer in
 *  good standing closes the keep with no team (one log row) and returns
 *  { made: false }, as a success, so refusals still write nothing. A made or closed keep
 *  is keep_closed, so two settles never make two teams (Review Focus 4). */
export function settleKeep(db: DB, o: { keepId: number; now: Date }): V.Checked<SettleOutcome> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<SettleOutcome> => {
    const k = keepOf(db, o.keepId);
    if (!k || k.status !== 'voting' || k.closed_at !== null || due(k, o.now)) return V.fail('keep_closed');
    if (!getPlayer(db, k.captain_steamid) || !inGoodStanding(db, k.captain_steamid, o.now)) {
      // The captain lost standing since pressing Keep: no team is made and
      // the keep closes with one log row.
      db.prepare("UPDATE draft_keeps SET status = 'lapsed', closed_at = ? WHERE id = ?").run(at, k.id);
      E.logEvent(db, k.event_id, null, 'keep_closed', at, { keepId: k.id, status: 'lapsed', why: 'captain_standing' });
      return V.ok({ made: false, closed: 'captain_standing' });
    }
    const accepted = answersOf(db, k.id).filter((a) => a.answer === 'accept').map((a) => a.steamid);
    if (accepted.length < KEEP_MAJORITY) return V.fail('keep_waiting');
    const entry = N.getEntry(db, k.entry_id)!;
    const made = T.createDraftTeam(db, {
      captain: k.captain_steamid, members: accepted, name: k.name!, tag: k.tag!, logoKey: entry.logo_key, eventId: k.event_id, min: KEEP_MAJORITY, now: o.now,
    });
    if (!made.ok) return V.fail(made.error === 'your_cap' || made.error === 'created_cap' ? 'keep_captain_cap' : 'keep_waiting');
    db.prepare("UPDATE draft_keeps SET status = 'made', team_id = ? WHERE id = ?").run(made.value.id, k.id);
    const join = db.prepare('UPDATE draft_keep_answers SET joined = 1 WHERE keep_id = ? AND steamid = ?');
    for (const s of made.value.joined) join.run(k.id, s);
    E.logEvent(db, k.event_id, null, 'keep_team_made', at, {
      keepId: k.id, teamId: made.value.id, name: made.value.name, tag: made.value.tag, joined: made.value.joined, left: made.value.left,
    });
    return V.ok({ made: true, teamId: made.value.id, slug: made.value.slug, joined: made.value.joined, left: made.value.left });
  })();
}

/** Ruling 2: the tick closes a keep past its window. An offer or a vote
 *  lapses; a made team keeps its status and stops taking late accepts. */
export function closeKeep(db: DB, o: { keepId: number; now: Date }): V.Checked<{ status: KeepStatus }> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<{ status: KeepStatus }> => {
    const k = keepOf(db, o.keepId);
    if (!k || k.closed_at !== null) return V.fail('keep_closed');
    if (!due(k, o.now)) return V.fail('keep_open');
    const status: KeepStatus = k.status === 'made' ? 'made' : 'lapsed';
    db.prepare('UPDATE draft_keeps SET status = ?, closed_at = ? WHERE id = ?').run(status, at, k.id);
    E.logEvent(db, k.event_id, null, 'keep_closed', at, { keepId: k.id, status });
    return V.ok({ status });
  })();
}
