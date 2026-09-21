import type { DB } from './db.js';
import { getSetting } from './settings.js';

/**
 * Post-match endorsements: every rule lives here, and both surfaces (the HTTP
 * route and the Discord button) call these functions, so the site and the bot
 * cannot disagree about who may endorse whom.
 *
 * Aggregate and anonymous. Nothing exported from this module returns a
 * from_id, except endorseState handing a giver their OWN list for one match.
 * The moment a profile shows who endorsed whom it becomes a public record of
 * who likes whom, which is the opposite of the intent.
 *
 * There is no negative kind, so there is nothing to aim at whoever out
 * fragged you.
 */

export const ENDORSE_KINDS = ['caller', 'clutch', 'vibes'] as const;
export type EndorseKind = typeof ENDORSE_KINDS[number];

export const ENDORSE_LABEL: Record<EndorseKind, string> = {
  caller: 'Caller',
  clutch: 'Clutch',
  vibes: 'Good vibes',
};

export type EndorseError =
  | 'bad_kind' | 'self' | 'no_match' | 'not_completed' | 'not_rostered'
  | 'target_not_rostered' | 'closed' | 'duplicate' | 'budget';

/** One sentence per refusal, shared by the site and the bot. */
export const ENDORSE_ERROR_TEXT: Record<EndorseError, string> = {
  bad_kind: 'That is not a kind of endorsement.',
  self: 'You cannot endorse yourself.',
  no_match: 'There is no such match.',
  not_completed: 'Only a completed match can be endorsed.',
  not_rostered: 'You were not in this match.',
  target_not_rostered: 'That player was not in this match.',
  closed: 'Endorsing for this match has closed.',
  duplicate: 'You already endorsed that player for this match.',
  budget: 'You have no endorsements left for this match.',
};

export type EndorseCounts = Record<EndorseKind, number>;

export interface EndorseState {
  /** May this player endorse on this match at all. Budget aside: a player who
   *  has spent everything is still eligible, with `remaining` 0. */
  eligible: boolean;
  reason: EndorseError | null;
  /** UTC, `YYYY-MM-DD HH:MM:SS`. Null when there is no such match. */
  closesAt: string | null;
  budget: number;
  remaining: number;
  /** What THIS player gave on this match. Their own choices, nobody else's. */
  given: { to: string; kind: EndorseKind }[];
  candidates: { steamid: string; name: string; team: 'a' | 'b' }[];
}

export interface EndorsementSummary {
  counts: EndorseCounts;
  total: number;
  /** Received per completed match played, to two places. */
  perMatch: number;
  title: EndorseKind | null;
}

/** A positive integer setting. A blank or mangled value falls back rather
 *  than reading as 0, which would close every window or zero every budget. */
function intSetting(db: DB, key: string, fallback: number): number {
  const n = Math.trunc(Number(getSetting(db, key)));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const isKind = (k: string): k is EndorseKind => (ENDORSE_KINDS as readonly string[]).includes(k);

const rostered = (db: DB, matchId: number, steamid: string): boolean =>
  db.prepare('SELECT 1 FROM match_players WHERE match_id = ? AND player_id = ?').get(matchId, steamid) !== undefined;

const usedBy = (db: DB, matchId: number, steamid: string): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM endorsements WHERE match_id = ? AND from_id = ?')
    .get(matchId, steamid) as { n: number }).n;

/** Everything that must hold before `steamid` may endorse on this match,
 *  checked in the order a person would want to be told about it. */
function gate(db: DB, matchId: number, steamid: string):
  { ok: true; closesAt: string } | { ok: false; error: EndorseError; closesAt: string | null } {
  const hours = intSetting(db, 'endorse_window_hours', 24);
  // The window is compared inside SQLite so ended_at and "now" are the same
  // kind of value. A NULL ended_at yields NULL, which is not open.
  const m = db.prepare(
    `SELECT state,
            datetime(ended_at, '+' || ? || ' hours') AS closesAt,
            datetime(ended_at, '+' || ? || ' hours') > datetime('now') AS open
     FROM matches WHERE id = ?`,
  ).get(hours, hours, matchId) as { state: string; closesAt: string | null; open: number | null } | undefined;
  if (!m) return { ok: false, error: 'no_match', closesAt: null };
  if (m.state !== 'completed') return { ok: false, error: 'not_completed', closesAt: m.closesAt };
  if (!rostered(db, matchId, steamid)) return { ok: false, error: 'not_rostered', closesAt: m.closesAt };
  if (!m.open || !m.closesAt) return { ok: false, error: 'closed', closesAt: m.closesAt };
  return { ok: true, closesAt: m.closesAt };
}

/**
 * Give one endorsement. `from` must already be the authenticated player: the
 * session steamid on the site, the linked player on Discord, never a value
 * the client supplied.
 *
 * The checks and the insert share one immediate transaction, so a double
 * submitted click cannot spend three from a budget of two.
 */
export function giveEndorsement(
  db: DB, o: { matchId: number; from: string; to: string; kind: string },
): { ok: true; remaining: number } | { ok: false; error: EndorseError } {
  const { matchId, from, to, kind } = o;
  if (!isKind(kind)) return { ok: false, error: 'bad_kind' };
  if (from === to) return { ok: false, error: 'self' };
  const run = db.transaction((): { ok: true; remaining: number } | { ok: false; error: EndorseError } => {
    const g = gate(db, matchId, from);
    if (!g.ok) return { ok: false, error: g.error };
    if (!rostered(db, matchId, to)) return { ok: false, error: 'target_not_rostered' };
    const dup = db.prepare('SELECT 1 FROM endorsements WHERE match_id = ? AND from_id = ? AND to_id = ?').get(matchId, from, to);
    if (dup) return { ok: false, error: 'duplicate' };
    const budget = intSetting(db, 'endorse_budget', 2);
    const used = usedBy(db, matchId, from);
    if (used >= budget) return { ok: false, error: 'budget' };
    db.prepare(
      "INSERT INTO endorsements (match_id, from_id, to_id, kind, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
    ).run(matchId, from, to, kind);
    return { ok: true, remaining: budget - used - 1 };
  });
  return run.immediate();
}

/** What the endorse panel needs for one player on one match. */
export function endorseState(db: DB, matchId: number, steamid: string): EndorseState {
  const budget = intSetting(db, 'endorse_budget', 2);
  const g = Number.isInteger(matchId) ? gate(db, matchId, steamid) : { ok: false as const, error: 'no_match' as const, closesAt: null };
  if (!g.ok) {
    return { eligible: false, reason: g.error, closesAt: g.closesAt, budget, remaining: 0, given: [], candidates: [] };
  }
  const given = db.prepare('SELECT to_id AS "to", kind FROM endorsements WHERE match_id = ? AND from_id = ? ORDER BY created_at, to_id')
    .all(matchId, steamid) as { to: string; kind: EndorseKind }[];
  const candidates = db.prepare(
    `SELECT mp.player_id AS steamid, p.name, mp.team
     FROM match_players mp JOIN players p ON p.steamid = mp.player_id
     WHERE mp.match_id = ? AND mp.player_id != ?
     ORDER BY mp.team, p.name, mp.player_id`,
  ).all(matchId, steamid) as { steamid: string; name: string; team: 'a' | 'b' }[];
  return {
    eligible: true, reason: null, closesAt: g.closesAt, budget,
    remaining: Math.max(0, budget - given.length), given, candidates,
  };
}

/**
 * The title a set of counts earns, or null.
 *
 * All three must hold: enough games, enough of the kind, and that kind the
 * STRICT plurality. A tie shows nothing, which is also what stops a title
 * flickering between two kinds from one match to the next.
 */
export function titleFromCounts(
  counts: EndorseCounts, games: number, minCount: number, minGames: number,
): EndorseKind | null {
  if (games < minGames) return null;
  const ranked = ENDORSE_KINDS.map((k) => [k, counts[k]] as const).sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  if (top[1] < minCount || top[1] === second[1]) return null;
  return top[0];
}

const emptyCounts = (): EndorseCounts => ({ caller: 0, clutch: 0, vibes: 0 });

/** Counts and the title for one profile. Only endorsements whose match is
 *  still completed count, so voiding a match takes its endorsements with it. */
export function endorsementSummary(db: DB, steamid: string): EndorsementSummary {
  const counts = emptyCounts();
  const rows = db.prepare(
    `SELECT e.kind, COUNT(*) AS n
     FROM endorsements e JOIN matches m ON m.id = e.match_id AND m.state = 'completed'
     WHERE e.to_id = ? GROUP BY e.kind`,
  ).all(steamid) as { kind: EndorseKind; n: number }[];
  for (const r of rows) counts[r.kind] = r.n;
  const { games } = db.prepare(
    `SELECT COUNT(*) AS games FROM match_players mp
     JOIN matches m ON m.id = mp.match_id AND m.state = 'completed'
     WHERE mp.player_id = ?`,
  ).get(steamid) as { games: number };
  const total = counts.caller + counts.clutch + counts.vibes;
  return {
    counts, total,
    perMatch: games > 0 ? Math.round((total / games) * 100) / 100 : 0,
    title: titleFromCounts(
      counts, games, intSetting(db, 'endorse_title_min', 5), intSetting(db, 'endorse_title_min_games', 10),
    ),
  };
}

/** Every player who currently holds a title, for rosters and the leaderboard.
 *  Two grouped queries for the whole table rather than one lookup per row. */
export function allTitles(db: DB): Map<string, EndorseKind> {
  const minCount = intSetting(db, 'endorse_title_min', 5);
  const minGames = intSetting(db, 'endorse_title_min_games', 10);
  const byPlayer = new Map<string, EndorseCounts>();
  const rows = db.prepare(
    `SELECT e.to_id AS steamid, e.kind, COUNT(*) AS n
     FROM endorsements e JOIN matches m ON m.id = e.match_id AND m.state = 'completed'
     GROUP BY e.to_id, e.kind`,
  ).all() as { steamid: string; kind: EndorseKind; n: number }[];
  for (const r of rows) {
    const c = byPlayer.get(r.steamid) ?? emptyCounts();
    c[r.kind] = r.n;
    byPlayer.set(r.steamid, c);
  }
  const out = new Map<string, EndorseKind>();
  if (byPlayer.size === 0) return out;
  const games = new Map((db.prepare(
    `SELECT mp.player_id AS steamid, COUNT(*) AS games FROM match_players mp
     JOIN matches m ON m.id = mp.match_id AND m.state = 'completed'
     GROUP BY mp.player_id`,
  ).all() as { steamid: string; games: number }[]).map((r) => [r.steamid, r.games]));
  for (const [steamid, counts] of byPlayer) {
    const title = titleFromCounts(counts, games.get(steamid) ?? 0, minCount, minGames);
    if (title) out.set(steamid, title);
  }
  return out;
}

/** Open matches where this player still has endorsements to give, newest
 *  first. Drives the quiet bar at the top of the site. */
export function pendingEndorsements(db: DB, steamid: string): { matchId: number; remaining: number }[] {
  const budget = intSetting(db, 'endorse_budget', 2);
  const hours = intSetting(db, 'endorse_window_hours', 24);
  const rows = db.prepare(
    `SELECT m.id AS matchId,
            (SELECT COUNT(*) FROM endorsements e WHERE e.match_id = m.id AND e.from_id = mp.player_id) AS used
     FROM matches m JOIN match_players mp ON mp.match_id = m.id AND mp.player_id = ?
     WHERE m.state = 'completed' AND datetime(m.ended_at, '+' || ? || ' hours') > datetime('now')
     ORDER BY m.id DESC`,
  ).all(steamid, hours) as { matchId: number; used: number }[];
  return rows.filter((r) => r.used < budget).map((r) => ({ matchId: r.matchId, remaining: budget - r.used }));
}
