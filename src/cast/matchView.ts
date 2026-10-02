import type { DB } from '../db.js';
import { campaignDisplayName, campaignRegistry } from '../campaignRegistry.js';
import { stopAfterMap } from '../stopPoint.js';
import { phaseFor, roundInProgress, currentOrdinal } from '../liveView.js';
import { displaySr } from '../rating.js';
import { currentSeasonId } from '../players.js';
import { completedPug } from '../matchKinds.js';
import { getSetting } from '../settings.js';
import { sideRow, sideName } from '../bookings/bookings.js';
import { getTeam } from '../teams/teams.js';
import { statDef } from '../statKeys.js';
import type {
  CastChapter, CastMatchView, CastPlayer, CastSide, CastTeam, StudioState, TeamOverride,
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

function career(db: DB, steamid: string): CastPlayer['career'] {
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
    skeets: sum('skeets'), dpsLanded: sum('dps_landed'), tankDamage: sum('tank_damage'),
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
  const season = currentSeasonId(db);
  const srOn = showSr(db, m.kind);
  const srOf = db.prepare('SELECT mu, sigma FROM player_ratings WHERE player_id = ? AND season_id = ?');
  const player = (r: (typeof ps)[number]): CastPlayer => {
    let stats: Record<string, number>;
    if (completed) {
      stats = parseStats(r.stats_json);
      for (const [k, col] of Object.entries(CORE_COLUMNS)) stats[k] = r[col];
    } else {
      stats = liveStats.get(r.steamid) ?? {};
    }
    const rating = srOn ? srOf.get(r.steamid, season) as { mu: number; sigma: number } | undefined : undefined;
    return {
      steamid: r.steamid, name: r.name, avatar: r.avatar, stats,
      sr: rating ? displaySr(rating.mu, rating.sigma) : null,
      career: career(db, r.steamid),
    };
  };

  // Names: a booked game's sides, else Team A / Team B.
  const teamBase = (t: 'a' | 'b') => {
    let name = t === 'a' ? 'Team A' : 'Team B';
    let tag = t === 'a' ? 'A' : 'B';
    let logoUrl: string | null = null;
    if (m.booking_id !== null) {
      const bookingSide = (m.booking_side_a ?? 'a') === 'a' ? t : (t === 'a' ? 'b' : 'a');
      const s = sideRow(db, m.booking_id, bookingSide);
      if (s) {
        name = sideName(db, s);
        const team = s.team_id !== null ? getTeam(db, s.team_id) : undefined;
        tag = team?.tag ?? tagFrom(name);
        if (team?.logo_key) logoUrl = `${team.logo_key}.png`;
      }
    }
    return { name, tag, logoUrl };
  };
  const liveTotals = { a: scored.reduce((n, s) => n + s.a, 0), b: scored.reduce((n, s) => n + s.b, 0) };
  const team = (t: 'a' | 'b'): CastTeam => {
    const base = teamBase(t);
    const score = completed ? (t === 'a' ? m.team_a_score : m.team_b_score) : liveTotals[t];
    const o = applyOverride({ name: base.name, tag: base.tag, color: DEFAULT_TEAM_COLORS[t], score }, studio.overrides[t]);
    return {
      key: t, name: o.name, tag: o.tag, color: o.color, score: o.score, overridden: o.overridden,
      logoUrl: base.logoUrl, side: completed ? null : sideOf(t),
      players: ps.filter((p) => p.team === t).map(player),
    };
  };

  const phase = completed ? null : phaseFor(db, matchId);
  const nameOf = new Map(ps.map((p) => [p.steamid, p.name]));
  const events = completed ? [] : (db.prepare(
    'SELECT kind, actor, target, value FROM match_live_events WHERE match_id = ? ORDER BY seq DESC LIMIT 12',
  ).all(matchId) as { kind: string; actor: string; target: string | null; value: number }[]).map((e) => ({
    kind: e.kind, actor: nameOf.get(e.actor) ?? e.actor, target: e.target ? nameOf.get(e.target) ?? e.target : null, value: e.value,
  }));

  return {
    id: m.id, kind: m.kind, state: m.state, campaign: m.campaign, campaignName: campaignDisplayName(db, m.campaign),
    currentMap, mapNumber, mapCount: chapters.length > 0 ? chapters.length : null,
    half: rip?.half ?? null, phase: phase?.state ?? null, phaseSinceMs: phase?.sinceMs ?? null,
    winner: completed ? m.winner : null,
    teams: { a: team('a'), b: team('b') },
    chapters, events, game,
  };
}
