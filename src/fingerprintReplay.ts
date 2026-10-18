import Database from 'better-sqlite3';
import { openDb, type DB } from './db.js';
import {
  MIN_CANDIDATE_HOLDS, TOP_RANK, addBurst, holdTotal, matchPersons, mergeInto, personThreshold, pooled,
  type BurstHoldRow, type FieldEntry, type Fingerprint, type PersonModel, type SecondSign,
} from './fingerprint.js';
import { BASE_BURST_SQL } from './fingerprintData.js';
import { activeBanAt, dbTimeMs, isNewAccount, secondSigns } from './fingerprintSigns.js';
import { extraVpnAsns } from './networkKinds.js';
import { resolveAlias } from './aliases.js';
import { personOf } from './evaderPeople.js';

/**
 * What the evader fingerprint rules would have done over everything on
 * record (spec section 5). Required before the setting goes on: with
 * indianstreetfood taken out of the dethisa seed, the replay must alert or
 * hold indianstreetfood; likewise nepmir. It also counts honest alerts and
 * holds per week, where the target is near zero holds.
 *
 * Read-only: fingerprints are accumulated in memory as match ends go by, so
 * each decision sees only what existed then, and nothing is written. It is
 * still only ever run on a COPY (scripts/fingerprint-replay.ts makes one).
 * Decisions are as if the setting were 'full', including what the live
 * check does around a hold: an account held at one match end is out of every
 * later check (live, its alt_hold ban makes activeBanAt skip it), and a hold
 * live would refuse (staff, an open hold by then, no players row) counts as
 * 'loud'. Accounts the live check never looks at (database person members and
 * aliases of any member) are skipped here too, except the account under test.
 */

export type ReplayLevel = 'alert' | 'loud' | 'hold';
const LEVEL_RANK: Record<ReplayLevel, number> = { alert: 1, loud: 2, hold: 3 };

export interface ReplayPerson { label: string; steam: readonly string[] }
export interface ReplayOptions { people: readonly ReplayPerson[]; exclude: ReadonlySet<string>; asnLoaded: boolean }
export interface ReplayEvent {
  matchId: number; at: string; steamid: string; person: string; level: ReplayLevel;
  distance: number; threshold: number; rank: number; signs: SecondSign[]; honest: boolean;
}
export interface ReplayWeek {
  week: string; alerts: number; louds: number; holds: number; honestAlerts: number; honestLouds: number; honestHolds: number;
}
export interface ReplayReport {
  matches: number;
  candidateChecks: number;
  events: ReplayEvent[];
  weeks: ReplayWeek[];
  /** Each excluded account: the highest level it reached and the match it first fired at. */
  excluded: { steamid: string; level: ReplayLevel | null; matchId: number | null }[];
  /** Share of honest candidates (first check with enough data) that had any
   *  person in their top 5, threshold aside. The spec's baseline is 3%. */
  honestTop5Rate: number | null;
  /** Holds whose only second sign was fresh_identity (sign 2). Its last
   *  branch, "Discord never linked elsewhere AND site account under 7 days",
   *  is true of nearly every honest first-week player, and the replay reads
   *  Steam privacy and Discord links as of today, so these are the holds the
   *  owner should weigh separately. */
  freshOnlyHolds: number;
  honestFreshOnlyHolds: number;
  ms: number;
}

/** What the replay cannot know about the past. Printed with every report so
 *  the numbers are read for what they are. */
export const REPLAY_LIMITS: readonly string[] = [
  'membership is the seed as of today, not as each account was discovered',
  'Steam privacy, Steam account age and Discord links are read as of today, not as of each match: '
    + 'sign 2 (fresh identity) can be overstated, see the sign-2-only hold count',
  'sign 2\'s "Discord never linked elsewhere AND site account under 7 days" is true of nearly every honest first-week player',
  'staff flags (is_admin, is_mod) are read as of today',
  'candidates are drawn only from players with base-class bursts in the match (live looks at every player in the match\'s input_bursts, '
    + 'but one without base-class holds has too little data to be checked anyway unless earlier matches gave them enough)',
  'only completed and aborted matches are walked, and bursts without a match id are left out '
    + '(the live check also counts those in a player\'s whole history)',
];

/** The first time `steamid` fired against the person labelled `person`, and
 *  the highest level it reached there; null if it never did. The required
 *  checks ask "caught as a dethisa candidate", not "caught as anyone". */
export function caughtAs(
  report: ReplayReport, steamid: string, person: string,
): { level: ReplayLevel; matchId: number } | null {
  const mine = report.events.filter((e) => e.steamid === steamid && e.person === person);
  if (mine.length === 0) return null;
  return { level: highest(mine), matchId: mine[0].matchId };
}

function highest(events: readonly ReplayEvent[]): ReplayLevel {
  return events.reduce<ReplayLevel>((best, e) => (LEVEL_RANK[e.level] > LEVEL_RANK[best] ? e.level : best), 'alert');
}

export interface ReplayArgs { db: string; required: boolean; exclude: string[]; json: boolean }

export const REPLAY_USAGE = 'usage: fingerprint-replay.ts --db <backup copy> [--required] [--exclude <steamid>]... [--json]';

/** The script's flags. A flag that takes a value and has none (or is followed
 *  by another flag) is an error: "--db --required" must never read the path
 *  "--required", and a dropped "--exclude" would quietly replay the wrong
 *  question. */
export function parseReplayArgs(argv: readonly string[]): ReplayArgs {
  const out: ReplayArgs = { db: '', required: false, exclude: [], json: false };
  let sawDb = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--required') { out.required = true; continue; }
    if (a === '--json') { out.json = true; continue; }
    if (a === '--db' || a === '--exclude') {
      const v = argv[i + 1];
      if (v === undefined || v === '' || v.startsWith('--')) throw new Error(`${a} needs a value. ${REPLAY_USAGE}`);
      i += 1;
      if (a === '--db') {
        if (sawDb) throw new Error(`--db may be given once. ${REPLAY_USAGE}`);
        sawDb = true;
        out.db = v;
      } else {
        out.exclude.push(v);
      }
      continue;
    }
    throw new Error(`unknown argument ${a}. ${REPLAY_USAGE}`);
  }
  if (!sawDb) throw new Error(REPLAY_USAGE);
  return out;
}

/** Copy `src` to `dest` with SQLite's backup API from a READ-ONLY handle and
 *  open the copy. The source must exist (fileMustExist: a typo never creates
 *  an empty database and replays nothing) and is never opened for writing;
 *  openDb's schema upgrades land on the copy only. */
export async function copyForReplay(src: string, dest: string): Promise<DB> {
  const source = new Database(src, { readonly: true, fileMustExist: true });
  try {
    await source.backup(dest);
  } finally {
    source.close();
  }
  return openDb(dest);
}

export function weekOf(at: Date): string {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function entry<K, V>(map: Map<K, V>, key: K, init: () => V): V {
  let v = map.get(key);
  if (v === undefined) { v = init(); map.set(key, v); }
  return v;
}

export function replayHistory(db: DB, opts: ReplayOptions): ReplayReport {
  const started = Date.now();
  const matches = db.prepare(
    `SELECT id, COALESCE(ended_at, created_at) AS endedAt FROM matches
      WHERE state IN ('completed', 'aborted') ORDER BY COALESCE(ended_at, created_at), id`,
  ).all() as { id: number; endedAt: string }[];
  const burstsOf = db.prepare(`SELECT steamid, kind, weapon, holds FROM input_bursts WHERE match_id = ? AND ${BASE_BURST_SQL}`);
  const whole = new Map<string, Fingerprint>();
  const perMatch = new Map<string, Fingerprint[]>();
  const people = opts.people.map((p, i) => ({ id: i + 1, label: p.label, members: p.steam.filter((s) => !opts.exclude.has(s)) }));
  const members = new Set(people.flatMap((p) => p.members));
  const known = new Set(opts.people.flatMap((p) => p.steam));
  const extraVpn = extraVpnAsns(db);
  // As candidatesOf: a member of a database person, or an alias of any
  // member, is never looked at. The account under test is exempt (the
  // database seed holds it too, which is the point of taking it out).
  const elsewhere = (id: string): boolean => {
    if (opts.exclude.has(id)) return false;
    const canon = resolveAlias(db, id);
    return members.has(canon) || personOf(db, 'steam', id) !== null || personOf(db, 'steam', canon) !== null;
  };
  const isKnown = (id: string): boolean => known.has(id) || known.has(resolveAlias(db, id)) || elsewhere(id);
  const openHoldAt = db.prepare(
    'SELECT 1 FROM alt_holds WHERE steamid = ? AND created_at <= ? AND (resolved_at IS NULL OR resolved_at > ?) LIMIT 1',
  );
  const playerRow = db.prepare('SELECT is_admin, is_mod FROM players WHERE steamid = ?');
  /** Whether live placeFingerprintHold would refuse a hold at `at` (it then
   *  sends a loud alert instead). The 'cleared' refusal needs real person ids
   *  and is not modelled. */
  const refusesHold = (id: string, at: Date): boolean => {
    const iso = at.toISOString();
    if (heldInReplay.has(id) || openHoldAt.get(id, iso, iso)) return true;
    const p = playerRow.get(id) as { is_admin: number; is_mod: number } | undefined;
    return !p || p.is_admin === 1 || p.is_mod === 1;
  };
  /** Accounts the replay itself held: out of every later match, as live. */
  const heldInReplay = new Set<string>();
  const fired = new Map<string, { level: ReplayLevel; matchId: number }>();
  const events: ReplayEvent[] = [];
  const firstChecked = new Set<string>();
  let candidateChecks = 0;
  let honestChecks = 0;
  let honestTop5 = 0;

  for (const m of matches) {
    const ms = dbTimeMs(m.endedAt);
    if (ms === null) continue;
    const at = new Date(ms);
    const thisMatch = new Map<string, Fingerprint>();
    for (const r of burstsOf.iterate(m.id) as IterableIterator<BurstHoldRow & { steamid: string }>) {
      addBurst(entry(thisMatch, r.steamid, () => ({})), r);
    }
    for (const [id, fp] of thisMatch) {
      mergeInto(entry(whole, id, () => ({})), fp);
      entry(perMatch, id, () => []).push(fp);
    }
    const models: PersonModel[] = people.map((p) => ({
      id: p.id, label: p.label, members: p.members,
      pooled: pooled(p.members.map((id) => whole.get(id) ?? {})),
      threshold: personThreshold(p.members.flatMap((id) => perMatch.get(id) ?? [])),
    }));
    const field: FieldEntry[] = [
      ...[...whole].filter(([, fp]) => holdTotal(fp) >= MIN_CANDIDATE_HOLDS).map(([id, fp]) => ({ subject: `steam:${id}`, fp })),
      ...models.map((p) => ({ subject: `person:${p.id}`, fp: p.pooled })),
    ];
    for (const steamid of thisMatch.keys()) {
      if (members.has(steamid) || heldInReplay.has(steamid) || elsewhere(steamid)) continue;
      if (activeBanAt(db, steamid, at) || !isNewAccount(db, steamid, at)) continue;
      const hits = matchPersons(whole.get(steamid)!, steamid, field, models);
      if (hits.length === 0) continue;
      candidateChecks += 1;
      const honest = !isKnown(steamid);
      if (honest && !firstChecked.has(steamid)) {
        firstChecked.add(steamid);
        honestChecks += 1;
        if (hits.some((h) => h.rank <= TOP_RANK)) honestTop5 += 1;
      }
      for (const hit of hits) {
        if (!hit.matched) continue;
        const person = models.find((p) => p.id === hit.personId)!;
        if (person.members.length === 0) continue;
        const signs = secondSigns(db, steamid, { members: person.members, membersInTop10: hit.membersInTop10, asnLoaded: opts.asnLoaded, extraVpn }, at);
        let level: ReplayLevel = signs.length > 0 ? 'hold' : 'alert';
        const key = `${steamid}/${person.id}`;
        const before = fired.get(key);
        if (before && LEVEL_RANK[before.level] >= LEVEL_RANK[level]) continue;
        if (level === 'hold') {
          if (refusesHold(steamid, at)) {
            level = 'loud';
            if (before && LEVEL_RANK[before.level] >= LEVEL_RANK.loud) continue;
          } else {
            heldInReplay.add(steamid);
          }
        }
        fired.set(key, { level, matchId: before?.matchId ?? m.id });
        events.push({
          matchId: m.id, at: at.toISOString(), steamid, person: person.label, level,
          distance: hit.distance, threshold: hit.threshold, rank: hit.rank, signs, honest,
        });
      }
    }
  }

  const weeks = new Map<string, ReplayWeek>();
  for (const e of events) {
    const w = entry(weeks, weekOf(new Date(e.at)), () => ({
      week: weekOf(new Date(e.at)), alerts: 0, louds: 0, holds: 0, honestAlerts: 0, honestLouds: 0, honestHolds: 0,
    }));
    if (e.level === 'alert') { w.alerts += 1; if (e.honest) w.honestAlerts += 1; }
    else if (e.level === 'loud') { w.louds += 1; if (e.honest) w.honestLouds += 1; }
    else { w.holds += 1; if (e.honest) w.honestHolds += 1; }
  }
  const freshOnly = events.filter((e) => e.level === 'hold' && e.signs.length === 1 && e.signs[0] === 'fresh_identity');
  const excluded = [...opts.exclude].map((steamid) => {
    const mine = events.filter((e) => e.steamid === steamid);
    return { steamid, level: mine.length > 0 ? highest(mine) : null, matchId: mine[0]?.matchId ?? null };
  });
  return {
    matches: matches.length, candidateChecks, events,
    weeks: [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week)),
    excluded, honestTop5Rate: honestChecks > 0 ? honestTop5 / honestChecks : null,
    freshOnlyHolds: freshOnly.length, honestFreshOnlyHolds: freshOnly.filter((e) => e.honest).length,
    ms: Date.now() - started,
  };
}
