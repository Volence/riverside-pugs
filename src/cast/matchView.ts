import type { DB } from '../db.js';
import { campaignDisplayName, campaignRegistry } from '../campaignRegistry.js';
import { stopAfterMap } from '../stopPoint.js';
import { phaseFor, roundInProgress, currentOrdinal } from '../liveView.js';
import { displaySr } from '../rating.js';
import { currentSeasonId } from '../players.js';
import { completedPug } from '../matchKinds.js';
import { getSetting } from '../settings.js';
import { sideRow, sideName } from '../bookings/bookings.js';
import { activeMembers, getTeam } from '../teams/teams.js';
import { statDef } from '../statKeys.js';
import { STREAK_MIN, streakRuns } from '../skeetStreaks.js';
import { boomerRate } from './types.js';
import { liveWinLine } from '../winProb.js';
import type {
  CastChapter, CastEvent, CastMatchView, CastRoundResult, CastPlayer, CastRole, CastSide, CastTeam, StudioState, TeamOverride,
} from './types.js';

/**
 * Everything the overlays say about one match, from data the site already
 * holds: the match row, the live UDP feed (match_live*, match_rounds) while
 * it runs and the final tables once it has completed. Producer overrides are
 * applied here, so every scene reads one already-decided value.
 */

/** Team colours before any override (plan ruling 5): kept clear of the
 *  survivor teal and infected red, since teams swap sides every half. */
export const DEFAULT_TEAM_COLORS = { a: '#5b8fd9', b: '#d9913f' } as const;

interface MatchRow {
  id: number; kind: 'pug' | 'scrim' | 'tournament'; state: CastMatchView['state']; campaign: string;
  winner: 'a' | 'b' | 'draw' | null; team_a_score: number; team_b_score: number;
  booking_id: number | null; booking_side_a: 'a' | 'b' | null;
}

/** Live keys the plugin sends without a registry entry, and the
 *  match_players columns the final dump fills for the same numbers. */
const CORE_COLUMNS = { sidmg: 'si_damage', sikill: 'si_kills', ck: 'common_kills', ff: 'ff_dealt', rev: 'revives' } as const;

function parseStats(json: string | null | undefined): Record<string, number> {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(v)) {
      // Self-only stats never go on air, the same filter the live feed applies.
      if (typeof n === 'number' && Number.isFinite(n) && statDef(k)?.visibility !== 'self') out[k] = n;
    }
    return out;
  } catch {
    return {};
  }
}

function showSr(db: DB, kind: MatchRow['kind']): boolean {
  if (kind === 'pug') return true;
  if (kind === 'scrim') return getSetting(db, 'scrim_show_sr') === 'on';
  return false;
}

/** Career numbers change once per finished match, and every overlay poll
 *  would otherwise sum a player's whole history: a minute's cache. */
const CAREER_TTL_MS = 60_000;
const careerCache = new WeakMap<DB, Map<string, { at: number; value: CastPlayer['career'] }>>();

function career(db: DB, steamid: string, nowMs = Date.now()): CastPlayer['career'] {
  let byDb = careerCache.get(db);
  if (!byDb) { byDb = new Map(); careerCache.set(db, byDb); }
  const hit = byDb.get(steamid);
  if (hit && nowMs - hit.at < CAREER_TTL_MS) return hit.value;
  const value = careerUncached(db, steamid);
  byDb.set(steamid, { at: nowMs, value });
  return value;
}

function careerUncached(db: DB, steamid: string): CastPlayer['career'] {
  const wl = db.prepare('SELECT COALESCE(SUM(wins), 0) AS w, COALESCE(SUM(losses), 0) AS l FROM player_ratings WHERE player_id = ?')
    .get(steamid) as { w: number; l: number };
  const played = db.prepare(
    `SELECT COUNT(*) AS n FROM match_players mp JOIN matches m ON m.id = mp.match_id
     WHERE mp.player_id = ? AND ${completedPug('m')} AND m.voided_at IS NULL`,
  ).get(steamid) as { n: number };
  const sum = (stat: string): number => (db.prepare(
    `SELECT COALESCE(SUM(s.value), 0) AS v FROM match_player_stats s JOIN matches m ON m.id = s.match_id
     WHERE s.player_id = ? AND s.stat = ? AND ${completedPug('m')} AND m.voided_at IS NULL`,
  ).get(steamid, stat) as { v: number }).v;
  return {
    matches: played.n, wins: wl.w, losses: wl.l,
    skeets: sum('skeets') + sum('team_skeets'), dps: sum('dps_landed'),
    boomerRate: boomerRate({ boomer_spawns: sum('boomer_spawns'), boom_successes: sum('boom_successes') }),
  };
}

function applyOverride(base: { name: string; tag: string; color: string; score: number }, o: TeamOverride) {
  const overridden: (keyof TeamOverride)[] = [];
  const out = { ...base };
  if (o.name !== undefined) { out.name = o.name; overridden.push('name'); }
  if (o.tag !== undefined) { out.tag = o.tag; overridden.push('tag'); }
  if (o.color !== undefined) { out.color = o.color; overridden.push('color'); }
  if (o.score !== undefined) { out.score = o.score; overridden.push('score'); }
  return { ...out, overridden };
}

/** Short tag from a name: initials of up to three words, else the first three letters. */
export function tagFrom(name: string): string {
  // A pickup side is "<captain>'s group": tag it by the captain.
  const pickup = /^(.+?)['’]s group$/i.exec(name);
  if (pickup) return pickup[1]!.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || '?';
  const words = name.replace(/['’]s\b/gi, '').split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w));
  const t = words.length >= 2 ? words.slice(0, 3).map((w) => w.replace(/[^A-Za-z0-9]/g, '')[0] ?? '').join('') : (words[0] ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 3);
  return t.toUpperCase() || '?';
}

export function buildMatchView(
  db: DB, matchId: number, studio: Pick<StudioState, 'overrides'>, game: CastMatchView['game'] = null,
): CastMatchView | null {
  const m = db.prepare(
    `SELECT id, kind, state, campaign, winner, team_a_score, team_b_score, booking_id, booking_side_a
     FROM matches WHERE id = ?`,
  ).get(matchId) as MatchRow | undefined;
  if (!m) return null;
  const completed = m.state === 'completed';

  // Chapters: the campaign's maps up to the stop point, plus anything played
  // past it (a custom chapter count on a booking).
  const allMaps = campaignRegistry(db).get(m.campaign)?.maps ?? [];
  const stop = stopAfterMap(db, m.campaign);
  const stopAt = stop ? allMaps.findIndex((x) => x.toLowerCase() === stop.toLowerCase()) : -1;
  const scored = (completed
    ? db.prepare('SELECT ordinal, map, team_a_score AS a, team_b_score AS b FROM match_maps WHERE match_id = ? ORDER BY ordinal')
    : db.prepare('SELECT ordinal, map, team_a_score AS a, team_b_score AS b FROM match_live_maps WHERE match_id = ? ORDER BY ordinal')
  ).all(matchId) as { ordinal: number; map: string; a: number; b: number }[];
  let planned = stopAt >= 0 ? allMaps.slice(0, stopAt + 1) : allMaps.slice();
  for (const s of scored) {
    if (!planned.some((x) => x.toLowerCase() === s.map.toLowerCase())) planned = [...planned, s.map];
  }
  const live = db.prepare('SELECT current_map AS currentMap FROM match_live WHERE match_id = ?').get(matchId) as { currentMap: string | null } | undefined;
  const currentMap = completed ? null : live?.currentMap ?? null;

  const rounds = db.prepare('SELECT ordinal, half, surv_team AS survTeam FROM match_rounds WHERE match_id = ? ORDER BY ordinal, half')
    .all(matchId) as { ordinal: number; half: number; survTeam: 'a' | 'b' }[];
  const chapters: CastChapter[] = planned.map((map, i) => {
    const s = scored.find((x) => x.map.toLowerCase() === map.toLowerCase());
    const first = s ? rounds.find((r) => r.ordinal === s.ordinal && r.half === 1) : rounds.find((r) => r.ordinal === i && r.half === 1);
    const playing = !s && currentMap !== null && currentMap.toLowerCase() === map.toLowerCase();
    return {
      number: i + 1, map, a: s ? s.a : null, b: s ? s.b : null,
      firstSurvivor: first?.survTeam ?? null,
      state: s ? 'done' : playing ? 'playing' : 'next',
    };
  });
  const playingAt = chapters.findIndex((c) => c.state === 'playing');
  const mapNumber = playingAt >= 0 ? playingAt + 1 : Math.min(scored.length + (completed ? 0 : 1), Math.max(chapters.length, 1));

  // Sides: the round being played, else the newest round on record.
  const rip = completed ? null : roundInProgress(db, matchId);
  const ord = completed ? -1 : currentOrdinal(db, matchId);
  const sideRound = rip
    ? rounds.find((r) => r.ordinal === rip.ordinal && r.half === rip.half)
    : rounds.filter((r) => r.ordinal === ord).at(-1);
  const sideOf = (t: 'a' | 'b'): CastSide | null =>
    !sideRound ? null : sideRound.survTeam === t ? 'survivor' : 'infected';

  // Rosters and stats.
  const ps = db.prepare(
    `SELECT mp.player_id AS steamid, mp.team, p.name, p.avatar, mp.si_damage, mp.si_kills, mp.common_kills,
            mp.ff_dealt, mp.revives, mp.stats_json
     FROM match_players mp JOIN players p ON p.steamid = mp.player_id
     WHERE mp.match_id = ? ORDER BY p.name COLLATE NOCASE`,
  ).all(matchId) as {
    steamid: string; team: 'a' | 'b'; name: string; avatar: string | null; si_damage: number; si_kills: number;
    common_kills: number; ff_dealt: number; revives: number; stats_json: string;
  }[];
  const liveStats = new Map((db.prepare('SELECT player_id, stats_json FROM match_live_players WHERE match_id = ?')
    .all(matchId) as { player_id: string; stats_json: string }[]).map((r) => [r.player_id, parseStats(r.stats_json)]));
  const finalStats = new Map<string, Record<string, number>>();
  if (completed) {
    for (const row of db.prepare('SELECT player_id, stat, value FROM match_player_stats WHERE match_id = ?').all(matchId) as { player_id: string; stat: string; value: number }[]) {
      if (statDef(row.stat)?.visibility === 'self') continue;
      const bag = finalStats.get(row.player_id) ?? {};
      bag[row.stat] = row.value;
      finalStats.set(row.player_id, bag);
    }
  }
  const season = currentSeasonId(db);
  const srOn = showSr(db, m.kind);
  const srOf = db.prepare('SELECT mu, sigma FROM player_ratings WHERE player_id = ? AND season_id = ?');
  const player = (r: (typeof ps)[number]): CastPlayer => {
    let stats: Record<string, number>;
    if (completed) {
      // The final box score: the fixed columns plus the skill stats, which
      // finishMatch writes to match_player_stats (stats_json holds only the
      // fixed five, as strings).
      stats = { ...parseStats(r.stats_json), ...(finalStats.get(r.steamid) ?? {}) };
      for (const [k, col] of Object.entries(CORE_COLUMNS)) stats[k] = r[col];
    } else {
      stats = liveStats.get(r.steamid) ?? {};
    }
    const rating = srOn ? srOf.get(r.steamid, season) as { mu: number; sigma: number } | undefined : undefined;
    return {
      steamid: r.steamid, name: r.name, avatar: r.avatar, stats,
      sr: rating ? displaySr(rating.mu, rating.sigma) : null,
      // PUG numbers only on a PUG (owner, 2026-10-02): a scrim or a
      // tournament lineup is the team's roster, not anyone's PUG record.
      career: m.kind === 'pug' ? career(db, r.steamid) : null,
      role: null,
    };
  };

  // Names: a booked game's sides, else Team A / Team B.
  const teamBase = (t: 'a' | 'b') => {
    let name = t === 'a' ? 'Team A' : 'Team B';
    let tag = t === 'a' ? 'A' : 'B';
    let logoUrl: string | null = null;
    const roles = new Map<string, CastRole>();
    if (m.booking_id !== null) {
      const bookingSide = (m.booking_side_a ?? 'a') === 'a' ? t : (t === 'a' ? 'b' : 'a');
      const s = sideRow(db, m.booking_id, bookingSide);
      if (s) {
        name = sideName(db, s);
        const team = s.team_id !== null ? getTeam(db, s.team_id) : undefined;
        // A draft side has no site team: its tag and logo were snapshotted
        // from the entry at booking (NULL on a team side).
        tag = s.tag ?? team?.tag ?? tagFrom(name);
        const logo = s.logo_key ?? team?.logo_key;
        if (logo) logoUrl = `${logo}.png`;
        // Roles: the team's own, else a pickup side's captain.
        if (team) for (const mem of activeMembers(db, team.id)) roles.set(mem.steamid, mem.role);
        else roles.set(s.captain_steamid, 'captain');
      }
    }
    return { name, tag, logoUrl, roles };
  };
  const liveTotals = { a: scored.reduce((n, s) => n + s.a, 0), b: scored.reduce((n, s) => n + s.b, 0) };
  const team = (t: 'a' | 'b'): CastTeam => {
    const base = teamBase(t);
    const score = completed ? (t === 'a' ? m.team_a_score : m.team_b_score) : liveTotals[t];
    const o = applyOverride({ name: base.name, tag: base.tag, color: DEFAULT_TEAM_COLORS[t], score }, studio.overrides[t]);
    return {
      key: t, name: o.name, tag: o.tag, color: o.color, score: o.score, overridden: o.overridden,
      logoUrl: base.logoUrl, side: completed ? null : sideOf(t),
      players: ps.filter((p) => p.team === t).map(player).map((p) => ({ ...p, role: base.roles.get(p.steamid) ?? null })),
    };
  };

  const phase = completed ? null : phaseFor(db, matchId);
  const nameOf = new Map(ps.map((p) => [p.steamid, p.name]));
  const teamOf = new Map(ps.map((p) => [p.steamid, p.team]));
  const events = completed ? [] : highlightEvents(db, matchId, nameOf, teamOf);

  const teams = { a: team('a'), b: team('b') };
  let winChanceA: number | null = null;
  if (m.state === 'live' && !teams.a.overridden.includes('score') && !teams.b.overridden.includes('score')) {
    try {
      const line = liveWinLine(db, matchId, m.campaign);
      winChanceA = line ? line.points[line.points.length - 1].pA : null;
    } catch {
      // Odds are garnish; a fault here must not blank the overlay.
    }
  }

  return {
    id: m.id, kind: m.kind, state: m.state, campaign: m.campaign, campaignName: campaignDisplayName(db, m.campaign),
    currentMap, mapNumber, mapCount: chapters.length > 0 ? chapters.length : null,
    half: rip?.half ?? null, phase: phase?.state ?? null, phaseSinceMs: phase?.sinceMs ?? null,
    winner: completed ? m.winner : null,
    teams,
    chapters, events, game,
    lastRound: lastRoundResult(db, matchId, planned, scored, nameOf, teamOf),
    winChanceA,
  };
}

/** The newest finished round (ended_at set) and the halves of its map. */
function lastRoundResult(
  db: DB, matchId: number, planned: string[], scored: { ordinal: number; map: string }[],
  nameOf: Map<string, string>, teamOf: Map<string, 'a' | 'b'>,
): CastRoundResult | null {
  type R = { ordinal: number; half: number; survTeam: 'a' | 'b'; score: number; alive: number | null; startedAt: string | null; endedAt: string | null };
  const cols = `ordinal, half, surv_team AS survTeam, score, survivors_alive AS alive, started_at AS startedAt, ended_at AS endedAt`;
  const last = db.prepare(`SELECT ${cols} FROM match_rounds WHERE match_id = ? AND ended_at IS NOT NULL ORDER BY ordinal DESC, half DESC LIMIT 1`)
    .get(matchId) as R | undefined;
  if (!last || (last.half !== 1 && last.half !== 2)) return null;
  const halves = (db.prepare(`SELECT ${cols} FROM match_rounds WHERE match_id = ? AND ordinal = ? AND ended_at IS NOT NULL AND half <= ? ORDER BY half`)
    .all(matchId, last.ordinal, last.half) as R[])
    .filter((r) => r.half === 1 || r.half === 2)
    .map((r) => {
      const a = r.startedAt ? Date.parse(`${r.startedAt.replace(' ', 'T')}Z`) : NaN;
      const b = r.endedAt ? Date.parse(`${r.endedAt.replace(' ', 'T')}Z`) : NaN;
      const seconds = Number.isFinite(a) && Number.isFinite(b) && b >= a ? Math.round((b - a) / 1000) : null;
      return { half: r.half as 1 | 2, survTeam: r.survTeam, score: r.score, alive: r.alive, seconds };
    });
  const bags = new Map<string, Record<string, number>>();
  for (const row of db.prepare('SELECT player_id, stat, value FROM match_round_stats WHERE match_id = ? AND ordinal = ? AND half = ?')
    .all(matchId, last.ordinal, last.half) as { player_id: string; stat: string; value: number }[]) {
    const bag = bags.get(row.player_id) ?? {};
    bag[row.stat] = row.value;
    bags.set(row.player_id, bag);
  }
  const players = [...bags].flatMap(([steamid, stats]) => {
    const team = teamOf.get(steamid);
    return team ? [{ steamid, name: nameOf.get(steamid) ?? steamid, team, stats }] : [];
  });
  const map = scored.find((s) => s.ordinal === last.ordinal)?.map ?? planned[last.ordinal] ?? '';
  return { mapNumber: last.ordinal + 1, map, half: last.half as 1 | 2, halves, players };
}

/** Newest-first events for the highlight list, with skeets folded into runs
 *  by the Discord streak rules (src/skeetStreaks.ts streakRuns: same player,
 *  same map half, each skeet within 5 s of the run's first). A run is one
 *  entry, at its newest skeet, so the producer sees one "Double skeet" that
 *  replaces the "Skeet" it grew from. */
function highlightEvents(
  db: DB, matchId: number, nameOf: Map<string, string>, teamOf: Map<string, 'a' | 'b'>,
): CastEvent[] {
  type Row = { seq: number; kind: string; actor: string; target: string | null; value: number; mapOrdinal: number; half: number; tMs: number };
  const recent = db.prepare(
    `SELECT seq, kind, actor, target, value, map_ordinal AS mapOrdinal, half, t_ms AS tMs
     FROM match_live_events WHERE match_id = ? ORDER BY seq DESC LIMIT 24`,
  ).all(matchId) as Row[];
  // Every skeet of this match, to place each recent one in its run.
  const skeets = db.prepare(
    `SELECT seq, actor, target, map_ordinal AS mapOrdinal, half, t_ms AS tMs FROM match_live_events
     WHERE match_id = ? AND kind = 'skeet' AND t_ms != -1 ORDER BY actor, map_ordinal, half, t_ms, seq`,
  ).all(matchId) as Pick<Row, 'seq' | 'actor' | 'target' | 'mapOrdinal' | 'half' | 'tMs'>[];
  // Runs per player and map half: the Discord triples first (STREAK_MIN, so
  // a TRIPLE here is a triple there), then doubles among the skeets left.
  const runOf = new Map<number, number>();
  const runs: { seqs: number[]; targets: string[] }[] = [];
  const groups = new Map<string, typeof skeets>();
  for (const k of skeets) {
    const key = `${k.actor}|${k.mapOrdinal}|${k.half}`;
    groups.set(key, [...(groups.get(key) ?? []), k]);
  }
  for (const g of groups.values()) {
    const place = (list: typeof skeets, min: number): typeof skeets => {
      const taken = new Set<number>();
      for (const [i, j] of streakRuns(list.map((k) => k.tMs), min)) {
        const members = list.slice(i, j + 1);
        runs.push({ seqs: members.map((k) => k.seq), targets: members.flatMap((k) => (k.target ? [nameOf.get(k.target) ?? k.target] : [])) });
        for (const k of members) { runOf.set(k.seq, runs.length - 1); taken.add(k.seq); }
      }
      return list.filter((k) => !taken.has(k.seq));
    };
    const rest = place(place(g, STREAK_MIN), 2);
    for (const k of rest) {
      runs.push({ seqs: [k.seq], targets: k.target ? [nameOf.get(k.target) ?? k.target] : [] });
      runOf.set(k.seq, runs.length - 1);
    }
  }
  // Booms: one vomit (or a popped boomer) catches several survivors, each its
  // own event; a boomer's booms within the same window are one bile with
  // every survivor it caught (Double / Triple / Quad bile).
  const booms = db.prepare(
    `SELECT seq, actor, target, map_ordinal AS mapOrdinal, half, t_ms AS tMs FROM match_live_events
     WHERE match_id = ? AND kind = 'boom' AND t_ms != -1 ORDER BY actor, map_ordinal, half, t_ms, seq`,
  ).all(matchId) as typeof skeets;
  const boomGroups = new Map<string, typeof skeets>();
  for (const k of booms) {
    const key = `${k.actor}|${k.mapOrdinal}|${k.half}`;
    boomGroups.set(key, [...(boomGroups.get(key) ?? []), k]);
  }
  for (const g of boomGroups.values()) {
    for (const [i, j] of streakRuns(g.map((k) => k.tMs), 1)) {
      const members = g.slice(i, j + 1);
      const targets = [...new Set(members.flatMap((k) => (k.target ? [nameOf.get(k.target) ?? k.target] : [])))];
      runs.push({ seqs: members.map((k) => k.seq), targets });
      for (const k of members) runOf.set(k.seq, runs.length - 1);
    }
  }
  const out: CastEvent[] = [];
  const shownRuns = new Set<number>();
  for (const e of recent) {
    const base: CastEvent = {
      seq: e.seq, kind: e.kind, actor: nameOf.get(e.actor) ?? e.actor, actorTeam: teamOf.get(e.actor) ?? null,
      target: e.target ? nameOf.get(e.target) ?? e.target : null, value: e.value,
    };
    const r = e.kind === 'skeet' || e.kind === 'boom' ? runOf.get(e.seq) : undefined;
    if (r !== undefined) {
      if (shownRuns.has(r)) continue; // an older event of a run already listed
      shownRuns.add(r);
      const run = runs[r]!;
      // A skeet run counts skeets; a bile counts the survivors it caught.
      base.streak = { count: e.kind === 'boom' ? Math.max(1, run.targets.length) : run.seqs.length, targets: run.targets };
    }
    out.push(base);
    if (out.length >= 12) break;
  }
  return out;
}
