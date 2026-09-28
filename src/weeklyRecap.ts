import type { DB } from './db.js';
import { campaignDisplayName } from './campaignRegistry.js';
import { WEEK_MATCHES, WEEK_START_HOUR, weekBounds, weeklyMinGames } from './weeklyAwards.js';

/**
 * The numbers behind the weekly recap message, modelled on the owner's hand
 * written "Friday recap" that players liked: how busy the week was, the best
 * single games (each naming its match), hot streaks as W-L records, the
 * iron players and the closest game.
 */

export interface RecapPlayer { steamid: string; name: string }
export interface Highlight { key: string; verb: string; label: string; player: RecapPlayer; value: number; matchId: number }
export interface WeekTotal { key: string; label: string; value: number; leader: (RecapPlayer & { value: number }) | null }
export interface Recap {
  matches: number;
  players: number;
  peakConcurrent: number;
  busiestDay: { date: string; matches: number } | null;
  highlights: Highlight[];
  mostQuads: { matchId: number; quads: number } | null;
  totals: WeekTotal[];
  streaks: (RecapPlayer & { w: number; l: number })[];
  iron: (RecapPlayer & { games: number })[];
  closest: { matchId: number; campaign: string; a: number; b: number } | null;
}

/** Best single game of the week for each of these, in this order. */
const HIGHLIGHTS: { key: string; verb: string; label: string; fixed?: string; stat?: string }[] = [
  { key: 'skeets', verb: 'landed', label: 'skeets', stat: 'skeets' },
  { key: 'tank_damage', verb: 'did', label: 'tank damage', stat: 'tank_damage' },
  { key: 'common_kills', verb: 'mowed down', label: 'common', fixed: 'common_kills' },
  { key: 'rock_skeets', verb: 'skeeted', label: 'rocks', stat: 'rock_skeets' },
  { key: 'boomer_pops', verb: 'popped', label: 'boomers', stat: 'boomer_pops' },
  { key: 'dps_landed', verb: 'landed', label: 'damage pounces', stat: 'dps_landed' },
];

const STREAKS_SHOWN = 4;

export function computeRecap(db: DB, week: string): Recap {
  const { from, to } = weekBounds(week);
  const inWeek = `(${WEEK_MATCHES})`;
  const one = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).get(from, to, ...args) as T | undefined;
  const many = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).all(from, to, ...args) as T[];

  const matches = one<{ n: number }>(`SELECT COUNT(*) AS n FROM matches WHERE id IN ${inWeek}`)!.n;
  const players = one<{ n: number }>(`SELECT COUNT(DISTINCT player_id) AS n FROM match_players WHERE match_id IN ${inWeek}`)!.n;

  // Peak: for each match's start, how many matches were running at that moment.
  const spans = many<{ s: string; e: string }>(
    `SELECT went_live_at AS s, ended_at AS e FROM matches WHERE id IN ${inWeek} AND went_live_at IS NOT NULL`,
  );
  const peakConcurrent = spans.reduce((best, x) => Math.max(best, spans.filter((y) => y.s <= x.s && y.e > x.s).length), 0);

  // Bucketed by the session, not the UTC calendar day: shifting back by the
  // same WEEK_START_HOUR that turns weeks over means a Friday-night US
  // session that ends after midnight UTC still counts as Friday.
  const busy = one<{ date: string; matches: number }>(
    `SELECT substr(datetime(ended_at, '-${WEEK_START_HOUR} hours'), 1, 10) AS date, COUNT(*) AS matches
     FROM matches WHERE id IN ${inWeek} GROUP BY date ORDER BY matches DESC, date LIMIT 1`,
  );

  const highlights: Highlight[] = [];
  for (const h of HIGHLIGHTS) {
    const row = h.fixed
      ? one<{ steamid: string; name: string; value: number; matchId: number }>(
        `SELECT mp.player_id AS steamid, p.name, mp.${h.fixed} AS value, mp.match_id AS matchId
         FROM match_players mp JOIN players p ON p.steamid = mp.player_id
         WHERE mp.match_id IN ${inWeek} ORDER BY value DESC, mp.match_id LIMIT 1`)
      : one<{ steamid: string; name: string; value: number; matchId: number }>(
        `SELECT s.player_id AS steamid, p.name, s.value, s.match_id AS matchId
         FROM match_player_stats s JOIN players p ON p.steamid = s.player_id
         WHERE s.match_id IN ${inWeek} AND s.stat = ? ORDER BY s.value DESC, s.match_id LIMIT 1`, h.stat);
    if (row && row.value > 0) {
      highlights.push({ key: h.key, verb: h.verb, label: h.label, player: { steamid: row.steamid, name: row.name }, value: row.value, matchId: row.matchId });
    }
  }

  // quad_caps credits every infected player in the quad, so summing a match
  // counts each quad four times. The highest on each team is that team's
  // count; the two teams play infected in their own halves.
  const quads = one<{ matchId: number; quads: number }>(
    `SELECT match_id AS matchId, SUM(best) AS quads FROM (
       SELECT s.match_id, mp.team, MAX(s.value) AS best
       FROM match_player_stats s JOIN match_players mp ON mp.match_id = s.match_id AND mp.player_id = s.player_id
       WHERE s.match_id IN ${inWeek} AND s.stat = 'quad_caps' GROUP BY s.match_id, mp.team)
     GROUP BY match_id ORDER BY quads DESC, match_id LIMIT 1`,
  );

  const total = (key: string, label: string, sql: string, ...args: unknown[]): WeekTotal => {
    const rows = many<{ steamid: string; name: string; value: number }>(sql, ...args);
    const value = rows.reduce((s, r) => s + r.value, 0);
    const top = rows[0];
    return { key, label, value, leader: top && top.value > 0 ? { steamid: top.steamid, name: top.name, value: top.value } : null };
  };
  const statTotal = (stats: string[]) =>
    `SELECT s.player_id AS steamid, p.name, SUM(s.value) AS value FROM match_player_stats s JOIN players p ON p.steamid = s.player_id
     WHERE s.match_id IN ${inWeek} AND s.stat IN (${stats.map(() => '?').join(',')}) GROUP BY s.player_id ORDER BY value DESC, p.name`;
  const totals = [
    total('crowns', 'witch crowns', statTotal(['crowns', 'draw_crowns']), 'crowns', 'draw_crowns'),
    total('skeets', 'skeets', statTotal(['skeets']), 'skeets'),
    total('common_kills', 'common infected',
      `SELECT mp.player_id AS steamid, p.name, SUM(mp.common_kills) AS value FROM match_players mp JOIN players p ON p.steamid = mp.player_id
       WHERE mp.match_id IN ${inWeek} GROUP BY mp.player_id ORDER BY value DESC, p.name`),
  ];

  const min = weeklyMinGames(db);
  const records = many<{ steamid: string; name: string; w: number; l: number; games: number }>(
    `SELECT mp.player_id AS steamid, p.name,
            SUM(m.winner = mp.team) AS w,
            SUM(m.winner IN ('a','b') AND m.winner != mp.team) AS l,
            COUNT(*) AS games
     FROM match_players mp JOIN matches m ON m.id = mp.match_id JOIN players p ON p.steamid = mp.player_id
     WHERE m.id IN ${inWeek} GROUP BY mp.player_id`,
  );
  const streaks = records
    .filter((r) => r.w + r.l >= min && r.w > r.l)
    .sort((a, b) => b.w / (b.w + b.l) - a.w / (a.w + a.l) || b.w - a.w || a.name.localeCompare(b.name))
    .slice(0, STREAKS_SHOWN)
    .map(({ steamid, name, w, l }) => ({ steamid, name, w, l }));

  const counts = [...new Set(records.map((r) => r.games))].sort((a, b) => b - a).slice(0, 2);
  const iron = records
    .filter((r) => counts.includes(r.games))
    .sort((a, b) => b.games - a.games || a.name.localeCompare(b.name))
    .map(({ steamid, name, games }) => ({ steamid, name, games }));

  const close = one<{ matchId: number; campaign: string; a: number; b: number }>(
    `SELECT id AS matchId, campaign, team_a_score AS a, team_b_score AS b FROM matches WHERE id IN ${inWeek}
     ORDER BY ABS(team_a_score - team_b_score), id LIMIT 1`,
  );

  return {
    matches, players, peakConcurrent,
    busiestDay: busy ?? null,
    highlights,
    mostQuads: quads && quads.quads > 0 ? quads : null,
    totals, streaks, iron,
    closest: close ? { ...close, campaign: campaignDisplayName(db, close.campaign) } : null,
  };
}
