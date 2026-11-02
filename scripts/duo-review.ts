/**
 * Duo queue trial review (spec section 9). Read-only, on a COPY of the
 * production database:
 *
 *   cp pug.db /tmp/pug-copy.db && npx tsx scripts/duo-review.ts /tmp/pug-copy.db
 *
 * Run ~2 weeks after the Season 1 flip, then again at 40 duo matches (or 4
 * weeks, whichever is later). Baseline is Season 1 non-duo matches only;
 * draws are left out so win rates and predictions compare.
 */
import { pathToFileURL } from 'node:url';
import { openDb, type DB } from '../src/db.js';
import { matchForecast } from '../src/rating.js';

export interface DuoMatchRow {
  duoTeam: 'a' | 'b' | 'both' | null;
  winner: 'a' | 'b' | 'draw';
  pPlain: number;
  pDuo: number | null;
  margin: number;
  forfeit: boolean;
  abandons: number;
  fourStack: boolean;
  band: 'low' | 'mid' | 'high' | null;
}

interface Bucket { matches: number; duoWinRate: number; predictedPlain: number; predictedWithBonus: number; meanMargin: number; forfeitRate: number; abandonRate: number }

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function bucket(rows: DuoMatchRow[]): Bucket {
  // The duo team's own view: its win, and its chance plain and with the bonus.
  // A match with a duo on both sides is counted from team A's side.
  const side = (r: DuoMatchRow) => (r.duoTeam === 'b' ? 'b' : 'a');
  const own = (p: number, r: DuoMatchRow) => (side(r) === 'a' ? p : 1 - p);
  return {
    matches: rows.length,
    duoWinRate: mean(rows.map((r) => (r.winner === side(r) ? 1 : 0))),
    predictedPlain: mean(rows.map((r) => own(r.pPlain, r))),
    predictedWithBonus: mean(rows.map((r) => own(r.pDuo ?? r.pPlain, r))),
    meanMargin: mean(rows.map((r) => r.margin)),
    forfeitRate: mean(rows.map((r) => (r.forfeit ? 1 : 0))),
    abandonRate: mean(rows.map((r) => (r.abandons > 0 ? 1 : 0))),
  };
}

export function summarizeDuoMatches(rows: DuoMatchRow[]) {
  const duo = rows.filter((r) => r.duoTeam !== null);
  return {
    duo: bucket(duo),
    solo: bucket(rows.filter((r) => r.duoTeam === null)),
    fourStack: bucket(duo.filter((r) => r.fourStack)),
    byBand: {
      low: bucket(duo.filter((r) => r.band === 'low')),
      mid: bucket(duo.filter((r) => r.band === 'mid')),
      high: bucket(duo.filter((r) => r.band === 'high')),
    },
  };
}

export interface StintRow { playerId: string; joinedMs: number; endedMs: number; outcome: 'popped' | 'left'; requeued: boolean }
export interface DuoSpan { playerA: string; playerB: string; createdMs: number; endedMs: number | null }

/**
 * Queue stints split by whether the player had a duo active over the whole
 * stint, with the popped wait (requeued stints left out: their clock carries
 * over) and ready fails per popped stint. A ready fail counts as duo when the
 * player was in an active duo at the penalty time.
 */
export function summarizeStints(stints: StintRow[], duos: DuoSpan[], readyFails: { playerId: string; atMs: number }[]) {
  const spans = (id: string) => duos.filter((d) => d.playerA === id || d.playerB === id);
  const inDuo = (id: string, from: number, to: number) =>
    spans(id).some((d) => d.createdMs <= from && (d.endedMs === null || d.endedMs >= to));
  const duo = stints.filter((s) => inDuo(s.playerId, s.joinedMs, s.endedMs));
  const solo = stints.filter((s) => !inDuo(s.playerId, s.joinedMs, s.endedMs));
  const duoFails = readyFails.filter((f) => inDuo(f.playerId, f.atMs, f.atMs)).length;
  const group = (xs: StintRow[], fails: number) => {
    const popped = xs.filter((s) => s.outcome === 'popped');
    return {
      stints: xs.length,
      meanPoppedWaitMinutes: mean(popped.filter((s) => !s.requeued).map((s) => (s.endedMs - s.joinedMs) / 60000)),
      readyFails: fails,
      readyFailRate: popped.length ? fails / popped.length : 0,
    };
  };
  return {
    stints: stints.length,
    duoShare: stints.length ? duo.length / stints.length : 0,
    duo: group(duo, duoFails),
    solo: group(solo, readyFails.length - duoFails),
  };
}

/** ISO text, or SQLite datetime('now') text (UTC without a zone), to ms. */
const toMs = (t: string) => Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t.replace(' ', 'T')}Z`);

function load(db: DB, seasonId: number): DuoMatchRow[] {
  const minSr = Number((db.prepare("SELECT value FROM settings WHERE key = 'duo_bonus_min_sr'").get() as { value: string } | undefined)?.value ?? 50);
  const maxSr = Number((db.prepare("SELECT value FROM settings WHERE key = 'duo_bonus_max_sr'").get() as { value: string } | undefined)?.value ?? 200);
  const third = (maxSr - minSr) / 3;
  const matches = db.prepare(
    `SELECT id, winner, team_a_score, team_b_score, forfeit_why FROM matches
     WHERE season_id = ? AND state = 'completed' AND kind = 'pug' AND winner IN ('a','b')`,
  ).all(seasonId) as { id: number; winner: 'a' | 'b'; team_a_score: number; team_b_score: number; forfeit_why: string | null }[];
  const out: DuoMatchRow[] = [];
  for (const m of matches) {
    const f = matchForecast(db, m.id);
    if (!f) continue;
    const duos = db.prepare('SELECT team, duo_bonus FROM match_players WHERE match_id = ? AND duo_partner IS NOT NULL').all(m.id) as { team: 'a' | 'b'; duo_bonus: number }[];
    const teams = new Set(duos.map((d) => d.team));
    const duoTeam = teams.size === 0 ? null : teams.size === 2 ? 'both' : [...teams][0];
    const perTeam = (t: 'a' | 'b') => duos.filter((d) => d.team === t).length;
    const top = Math.max(0, ...duos.map((d) => d.duo_bonus * 100));
    out.push({
      duoTeam,
      winner: m.winner,
      pPlain: f.winProbA,
      pDuo: f.winProbAWithDuo,
      margin: Math.abs(m.team_a_score - m.team_b_score),
      forfeit: m.forfeit_why === 'gg',
      abandons: (db.prepare('SELECT COUNT(*) AS n FROM match_abandons WHERE match_id = ? AND restored_at IS NULL').get(m.id) as { n: number }).n,
      fourStack: perTeam('a') >= 4 || perTeam('b') >= 4,
      band: duos.length === 0 ? null : top < minSr + third ? 'low' : top < minSr + 2 * third ? 'mid' : 'high',
    });
  }
  return out;
}

/** Duos passed over at a pop (did not fit, not swapped in) since `sinceMs`. */
export function duoPopSkipsSince(db: DB, sinceMs: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM duo_pop_skips WHERE kind = 'skipped' AND at >= ?").get(new Date(sinceMs).toISOString()) as { n: number }).n;
}

/** Held pops forced through after duo_hold_max_minutes since `sinceMs`: how
 *  many, how many solos they bumped to the front, and the mean hold. */
export function duoHoldBumpsSince(db: DB, sinceMs: number): { pops: number; bumpedSolos: number; avgHeldMinutes: number | null } {
  const rows = db.prepare("SELECT bumped, held_ms FROM duo_pop_skips WHERE kind = 'forced' AND at >= ?")
    .all(new Date(sinceMs).toISOString()) as { bumped: string | null; held_ms: number | null }[];
  const bumpedSolos = rows.reduce((n, r) => n + (r.bumped ? r.bumped.split(',').length : 0), 0);
  const held = rows.filter((r) => r.held_ms !== null);
  const avgHeldMinutes = held.length === 0 ? null : held.reduce((n, r) => n + r.held_ms!, 0) / held.length / 60000;
  return { pops: rows.length, bumpedSolos, avgHeldMinutes };
}

function queueHealth(db: DB, sinceMs: number) {
  const since = new Date(sinceMs).toISOString();
  const duosOpen = (db.prepare('SELECT COUNT(*) AS n FROM duos WHERE ended_at IS NULL').get() as { n: number }).n;
  const formed = (db.prepare('SELECT COUNT(*) AS n FROM duos WHERE created_at >= ?').get(since) as { n: number }).n;
  const bySource = db.prepare("SELECT source, COUNT(*) AS n FROM duo_invites WHERE outcome = 'accepted' AND created_at >= ? GROUP BY source").all(since);
  const lengths = db.prepare('SELECT AVG(julianday(ended_at) - julianday(created_at)) AS days FROM duos WHERE ended_at IS NOT NULL').get();
  const stints = (db.prepare('SELECT player_id, joined_at, ended_at, outcome, requeued FROM queue_stints WHERE ended_at >= ?').all(sinceMs) as
    { player_id: string; joined_at: number; ended_at: number; outcome: 'popped' | 'left'; requeued: number }[])
    .map((r) => ({ playerId: r.player_id, joinedMs: r.joined_at, endedMs: r.ended_at, outcome: r.outcome, requeued: !!r.requeued }));
  const duos = (db.prepare('SELECT player_a, player_b, created_at, ended_at FROM duos').all() as
    { player_a: string; player_b: string; created_at: string; ended_at: string | null }[])
    .map((d) => ({ playerA: d.player_a, playerB: d.player_b, createdMs: toMs(d.created_at), endedMs: d.ended_at === null ? null : toMs(d.ended_at) }));
  const readyFails = (db.prepare("SELECT player_id, created_at FROM penalties WHERE kind = 'ready_fail' AND created_at >= ?").all(since) as
    { player_id: string; created_at: string }[])
    .map((p) => ({ playerId: p.player_id, atMs: toMs(p.created_at) }));
  return {
    duosOpen, formed, acceptedBySource: bySource, avgDuoLifeDays: lengths,
    stints: summarizeStints(stints, duos, readyFails),
    skippedAtPop: duoPopSkipsSince(db, sinceMs),
    forcedHeldPops: duoHoldBumpsSince(db, sinceMs),
  };
}

/**
 * Mean SR movement per game (rating_history, mu_after - mu_before, x100):
 * duo members in their duo games vs the same players' solo games, and the
 * opponents of a duo vs those players' games where they neither were in a
 * duo nor faced one. In a match with a duo on both sides a duo member
 * counts as a duo member, not as an opponent.
 */
function srMovement(db: DB, seasonId: number) {
  const rows = db.prepare(
    `SELECT rh.player_id, rh.mu_after - rh.mu_before AS d, mp.duo_partner IS NOT NULL AS duo,
            EXISTS (SELECT 1 FROM match_players o WHERE o.match_id = rh.match_id
                    AND o.team != mp.team AND o.duo_partner IS NOT NULL) AS vs_duo
     FROM rating_history rh
     JOIN match_players mp ON mp.match_id = rh.match_id AND mp.player_id = rh.player_id
     JOIN matches m ON m.id = rh.match_id
     WHERE m.season_id = ? AND m.state = 'completed' AND m.kind = 'pug'`,
  ).all(seasonId) as { player_id: string; d: number; duo: number; vs_duo: number }[];
  const opp = (r: (typeof rows)[number]) => !r.duo && !!r.vs_duo;
  const members = new Set(rows.filter((r) => r.duo).map((r) => r.player_id));
  const opponents = new Set(rows.filter(opp).map((r) => r.player_id));
  const sr = (xs: typeof rows) => ({ games: xs.length, meanSr: Math.round(mean(xs.map((r) => r.d)) * 100 * 10) / 10 });
  return {
    duoMembers: {
      players: members.size,
      inDuo: sr(rows.filter((r) => r.duo)),
      solo: sr(rows.filter((r) => members.has(r.player_id) && !r.duo)),
    },
    opponents: {
      players: opponents.size,
      vsDuo: sr(rows.filter(opp)),
      other: sr(rows.filter((r) => opponents.has(r.player_id) && !r.duo && !r.vs_duo)),
    },
  };
}

function main(): void {
  const path = process.argv[2];
  if (!path || !path.includes('copy')) {
    console.error('usage: duo-review.ts <path containing "copy">');
    process.exit(2);
  }
  const db = openDb(path);
  const season = db.prepare('SELECT id, started_at FROM seasons WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1').get() as { id: number; started_at: string };
  const startedMs = toMs(season.started_at);
  const rows = load(db, season.id);
  console.log(JSON.stringify({
    season: season.id,
    summary: summarizeDuoMatches(rows),
    queue: queueHealth(db, startedMs),
    srMovement: srMovement(db, season.id),
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
