import type { DB } from '../db.js';
import { completedPug } from '../matchKinds.js';
import { currentSeasonId, getPlayer } from '../players.js';
import { displaySr, seasonSr } from '../rating.js';
import { STAT_DEFS } from '../statKeys.js';

/**
 * A draft player card (drafts plan D2b1 Ruling 3, spec section 3): numbers
 * the profile already shows publicly, from completed, unvoided PUGs only
 * (completedPug), never scrims or tournament games. Read only. The signup
 * note and "Chemistry with you" are private and are added by the room view
 * for the viewers allowed them, never here.
 */

export const TREND_LEN = 10;
export const FORM_LEN = 10;
export type SiClass = 'hunter' | 'smoker' | 'boomer' | 'tank';

export interface PlayerCard {
  steamid: string; name: string; avatar: string | null;
  /** Current-season display SR, rounded. */
  sr: number;
  /** SR after each of the last TREND_LEN rated games this season, oldest first. */
  trend: number[];
  /** Completed PUGs played. */
  pugs: number;
  /** Newest first, up to FORM_LEN: W, L or D from this player's side. */
  form: ('W' | 'L' | 'D')[];
  /** Per completed PUG, one decimal. */
  survivor: { siDamage: number; commonKills: number };
  infected: { damageAsSi: number; dpsLanded: number };
  /** The class this player has dealt the most damage as, all time in PUGs. */
  bestClass: { cls: SiClass; damage: number } | null;
  /** The skill_detect counters a high value of which is good, with totals above 0, in registry order. */
  skills: { key: string; label: string; total: number }[];
}

const CLASS_STATS: [SiClass, string][] = [['hunter', 'dmg_as_hunter'], ['smoker', 'dmg_as_smoker'], ['boomer', 'dmg_as_boomer'], ['tank', 'dmg_as_tank']];
const SKILLS = STAT_DEFS.filter((d) => d.visibility === 'public' && d.direction === 'high_good' && d.needsSkillDetect);

export function playerCard(db: DB, steamid: string, season = currentSeasonId(db)): PlayerCard {
  const p = getPlayer(db, steamid);
  const done = `${completedPug('m')} AND m.voided_at IS NULL`;
  const trend = (db.prepare('SELECT mu_after, sigma_after FROM rating_history WHERE player_id = ? AND season_id = ? ORDER BY id DESC LIMIT ?')
    .all(steamid, season, TREND_LEN) as { mu_after: number; sigma_after: number }[])
    .reverse().map((h) => Math.round(displaySr(h.mu_after, h.sigma_after)));
  const games = db.prepare(
    `SELECT m.winner, mp.team, mp.si_damage, mp.common_kills FROM match_players mp JOIN matches m ON m.id = mp.match_id
     WHERE mp.player_id = ? AND ${done} ORDER BY m.id DESC`,
  ).all(steamid) as { winner: string | null; team: string; si_damage: number; common_kills: number }[];
  const totals = new Map((db.prepare(
    `SELECT s.stat, SUM(s.value) AS total FROM match_player_stats s JOIN matches m ON m.id = s.match_id
     WHERE s.player_id = ? AND ${done} GROUP BY s.stat`,
  ).all(steamid) as { stat: string; total: number }[]).map((r) => [r.stat, r.total]));
  const total = (k: string) => totals.get(k) ?? 0;
  const n = games.length;
  const per = (v: number) => (n > 0 ? Math.round((v / n) * 10) / 10 : 0);
  let bestClass: PlayerCard['bestClass'] = null;
  for (const [cls, key] of CLASS_STATS) {
    if (total(key) > 0 && (!bestClass || total(key) > bestClass.damage)) bestClass = { cls, damage: total(key) };
  }
  return {
    steamid, name: p?.name ?? steamid, avatar: p?.avatar ?? null,
    sr: Math.round(seasonSr(db, steamid, season)), trend, pugs: n,
    form: games.slice(0, FORM_LEN).map((g) => (g.winner === 'draw' || g.winner === null ? 'D' : g.winner === g.team ? 'W' : 'L')),
    survivor: { siDamage: per(games.reduce((t, g) => t + g.si_damage, 0)), commonKills: per(games.reduce((t, g) => t + g.common_kills, 0)) },
    infected: { damageAsSi: per(total('damage_as_si')), dpsLanded: per(total('dps_landed')) },
    bestClass,
    skills: SKILLS.map((d) => ({ key: d.key, label: d.label, total: total(d.key) })).filter((s) => s.total > 0),
  };
}
