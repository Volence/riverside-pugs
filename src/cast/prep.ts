import type { DB } from '../db.js';
import { completedPug } from '../matchKinds.js';
import { campaignDisplayName } from '../campaignRegistry.js';

/**
 * The caster prep sheet (plan ruling 17): talking points for one match from
 * PUG history only (completedPug, never voided), so scrims and tournament
 * games stay private and never feed it. Shown in the panel, never on air.
 */

export interface PrepPlayer {
  steamid: string;
  name: string;
  team: 'a' | 'b';
  matches: number;
  /** Newest first, up to ten: W, L or D from this player's side. */
  form: ('W' | 'L' | 'D')[];
  /** Per completed PUG. */
  avg: { sidmg: number; ck: number; skeets: number; dps: number; tankDmg: number };
  /** Best single-match marks, with the match they came from. */
  best: { label: string; value: number; matchId: number }[];
  /** Most played campaigns. */
  campaigns: { name: string; played: number; won: number }[];
}

export interface PrepRivalry {
  a: string;
  b: string;
  /** PUGs the two played on opposite sides, and how many the team A player won. */
  met: number;
  aWon: number;
}

export interface PrepSheet {
  players: PrepPlayer[];
  /** Pairs across the two rosters who met most often, up to six. */
  rivalries: PrepRivalry[];
  /** Pairs within one roster who played together most, up to six. */
  duos: { team: 'a' | 'b'; a: string; b: string; together: number; won: number }[];
}

const BEST: { key: string; label: string; column?: string }[] = [
  { key: 'skeets', label: 'Skeets' },
  { key: 'dps_landed', label: 'DPs landed' },
  { key: 'tank_damage', label: 'Tank damage' },
  { key: 'sidmg', label: 'SI damage', column: 'si_damage' },
  { key: 'ck', label: 'Common kills', column: 'common_kills' },
];

function resultFor(team: string, winner: string | null): 'W' | 'L' | 'D' {
  if (winner === 'draw' || winner === null) return 'D';
  return winner === team ? 'W' : 'L';
}

export function prepSheet(db: DB, matchId: number): PrepSheet {
  const roster = db.prepare(
    `SELECT mp.player_id AS steamid, mp.team, p.name FROM match_players mp JOIN players p ON p.steamid = mp.player_id
     WHERE mp.match_id = ? ORDER BY mp.team, p.name COLLATE NOCASE`,
  ).all(matchId) as { steamid: string; team: 'a' | 'b'; name: string }[];
  const done = `${completedPug('m')} AND m.voided_at IS NULL AND m.id <> ?`;

  const players: PrepPlayer[] = roster.map((r) => {
    const history = db.prepare(
      `SELECT m.id, m.winner, m.campaign, mp.team, mp.si_damage, mp.common_kills, mp.stats_json
       FROM match_players mp JOIN matches m ON m.id = mp.match_id
       WHERE mp.player_id = ? AND ${done} ORDER BY m.id DESC`,
    ).all(r.steamid, matchId) as { id: number; winner: string | null; campaign: string; team: string; si_damage: number; common_kills: number; stats_json: string }[];
    const stat = (statKey: string) => db.prepare(
      `SELECT s.match_id AS id, s.value FROM match_player_stats s JOIN matches m ON m.id = s.match_id
       WHERE s.player_id = ? AND s.stat = ? AND ${done}`,
    ).all(r.steamid, statKey, matchId) as { id: number; value: number }[];
    const n = history.length;
    const sumStat = (k: string) => stat(k).reduce((t, x) => t + x.value, 0);
    const per = (v: number) => (n > 0 ? Math.round((v / n) * 10) / 10 : 0);
    const best: PrepPlayer['best'] = [];
    for (const b of BEST) {
      let top: { id: number; value: number } | null = null;
      if (b.column) {
        for (const h of history) {
          const v = b.column === 'si_damage' ? h.si_damage : h.common_kills;
          if (!top || v > top.value) top = { id: h.id, value: v };
        }
      } else {
        for (const x of stat(b.key)) if (!top || x.value > top.value) top = x;
      }
      if (top && top.value > 0) best.push({ label: b.label, value: top.value, matchId: top.id });
    }
    const byCampaign = new Map<string, { played: number; won: number }>();
    for (const h of history) {
      const c = byCampaign.get(h.campaign) ?? { played: 0, won: 0 };
      c.played++;
      if (h.winner === h.team) c.won++;
      byCampaign.set(h.campaign, c);
    }
    return {
      steamid: r.steamid, name: r.name, team: r.team, matches: n,
      form: history.slice(0, 10).map((h) => resultFor(h.team, h.winner)),
      avg: {
        sidmg: per(history.reduce((t, h) => t + h.si_damage, 0)),
        ck: per(history.reduce((t, h) => t + h.common_kills, 0)),
        skeets: per(sumStat('skeets')),
        dps: per(sumStat('dps_landed')),
        tankDmg: per(sumStat('tank_damage')),
      },
      best,
      campaigns: [...byCampaign.entries()].sort((x, y) => y[1].played - x[1].played).slice(0, 3)
        .map(([slug, c]) => ({ name: campaignDisplayName(db, slug), ...c })),
    };
  });

  const pair = db.prepare(
    `SELECT COUNT(*) AS met, COALESCE(SUM(CASE WHEN m.winner = x.team THEN 1 ELSE 0 END), 0) AS xWon
     FROM match_players x JOIN match_players y ON y.match_id = x.match_id AND y.player_id = ?
     JOIN matches m ON m.id = x.match_id
     WHERE x.player_id = ? AND ${done} AND x.team <> y.team`,
  );
  const together = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN m.winner = x.team THEN 1 ELSE 0 END), 0) AS won
     FROM match_players x JOIN match_players y ON y.match_id = x.match_id AND y.player_id = ?
     JOIN matches m ON m.id = x.match_id
     WHERE x.player_id = ? AND ${done} AND x.team = y.team`,
  );
  const rivalries: PrepRivalry[] = [];
  const duos: PrepSheet['duos'] = [];
  for (const x of roster) {
    for (const y of roster) {
      if (x.team === 'a' && y.team === 'b') {
        const r = pair.get(y.steamid, x.steamid, matchId) as { met: number; xWon: number };
        if (r.met > 0) rivalries.push({ a: x.name, b: y.name, met: r.met, aWon: r.xWon });
      } else if (x.team === y.team && x.steamid < y.steamid) {
        const r = together.get(y.steamid, x.steamid, matchId) as { n: number; won: number };
        if (r.n > 0) duos.push({ team: x.team, a: x.name, b: y.name, together: r.n, won: r.won });
      }
    }
  }
  rivalries.sort((p, q) => q.met - p.met);
  duos.sort((p, q) => q.together - p.together);
  return { players, rivalries: rivalries.slice(0, 6), duos: duos.slice(0, 6) };
}
