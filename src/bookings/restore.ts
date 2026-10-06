import type { DB } from '../db.js';
import { campaignRegistry } from '../campaignRegistry.js';
import { isMapName } from '../campaigns.js';
import { matchPlayersRoster, tournamentRoster } from './tournamentGames.js';

/**
 * Putting a booking game back after its srcds restarted (plan 5). The plugin
 * lost everything it held in memory, so the site rebuilds the game from its
 * own record: the finished maps from match_rounds (written from the ROUND
 * lines as they happened), the roster from match_players. The map the game
 * was on is replayed from its start (ruling 1); player stats cover only the
 * maps from there on (ruling 2), which restored_at_map records.
 */

export interface RestoreSnapshot {
  matchId: number;
  token: string;
  campaign: string;
  /** The game's first map: the plugin's g_sCampaign for the SameCampaign check. */
  firstMap: string;
  /** Finished maps in order, with each team's score. */
  maps: { map: string; a: number; b: number }[];
  /** The map to load: the one the game was on, replayed from its start (ruling 1). */
  map: string;
  /** Which match team survives first on `map`: the higher total, a tie keeps the previous map's half-1 order, and team a on map 1. */
  firstSurv: 'a' | 'b';
  roster: { steamid: string; team: 'a' | 'b'; joinedMap: number }[];
  /** One above the highest event seq the site holds for this game. */
  nextSeq: number;
}

/** opts.replayFrom (plan T3c Ruling 12): the desk's "replay a chapter", the
 *  0-based ordinal of a chapter to replay from its start. The finished maps
 *  before it stand; it and every map after it are dropped. At most the
 *  count of finished maps (the chapter being played); the finale rule still
 *  applies. Absent, this is crash recovery: every finished map stands and
 *  the map the game was on is replayed. */
export function restoreSnapshot(db: DB, matchId: number, opts: { replayFrom?: number } = {}): RestoreSnapshot | null {
  const m = db.prepare("SELECT id, campaign, token FROM matches WHERE id = ? AND state = 'live'").get(matchId) as
    { id: number; campaign: string; token: string | null } | undefined;
  if (!m || !m.token) return null;
  const entry = campaignRegistry(db).get(m.campaign);
  if (!entry) return null;

  const rounds = db.prepare('SELECT ordinal, half, surv_team, score, ended_at FROM match_rounds WHERE match_id = ? ORDER BY ordinal, half')
    .all(matchId) as { ordinal: number; half: number; surv_team: 'a' | 'b'; score: number; ended_at: string | null }[];
  const liveMaps = new Map((db.prepare('SELECT ordinal, map FROM match_live_maps WHERE match_id = ?').all(matchId) as { ordinal: number; map: string }[])
    .map((r) => [r.ordinal, r.map] as const));
  const current = (db.prepare('SELECT current_map FROM match_live WHERE match_id = ?').get(matchId) as { current_map: string | null } | undefined)?.current_map ?? null;

  // Finished ordinals: a contiguous run from 0, each with an ended half 2.
  const done: { a: number; b: number; half1Surv: 'a' | 'b' | null }[] = [];
  for (let o = 0; ; o++) {
    const rows = rounds.filter((r) => r.ordinal === o);
    if (!rows.some((r) => r.half === 2 && r.ended_at !== null)) break;
    const a = rows.filter((r) => r.surv_team === 'a').reduce((n, r) => n + r.score, 0);
    const b = rows.filter((r) => r.surv_team === 'b').reduce((n, r) => n + r.score, 0);
    done.push({ a, b, half1Surv: rows.find((r) => r.half === 1)?.surv_team ?? null });
  }

  const inCampaign = (map: string | null | undefined): map is string => !!map && entry.maps.includes(map);
  const firstMap = inCampaign(liveMaps.get(0)) ? liveMaps.get(0)!
    : done.length === 0 && inCampaign(current) ? current : entry.maps[0];
  const start = entry.maps.indexOf(firstMap);
  // Plan T3c: replay from an earlier chapter. The maps before it stand; it
  // and anything after it are dropped (prepareRestore deletes their rows).
  // After firstMap and start, which need the real count of finished maps.
  if (opts.replayFrom !== undefined) {
    if (!Number.isInteger(opts.replayFrom) || opts.replayFrom < 0 || opts.replayFrom > done.length) return null;
    done.length = opts.replayFrom;
  }
  const maps = done.map((d, i) => ({ map: inCampaign(liveMaps.get(i)) ? liveMaps.get(i)! : entry.maps[start + i], a: d.a, b: d.b }));
  const finished = new Set(maps.map((x) => x.map));
  const map = opts.replayFrom !== undefined
    ? (inCampaign(liveMaps.get(opts.replayFrom)) ? liveMaps.get(opts.replayFrom)! : entry.maps[start + opts.replayFrom])
    : inCampaign(current) && !finished.has(current) ? current : entry.maps[start + done.length];
  if (!map) return null;
  // Never the finale: replaying it from the start would run the game past the
  // plugin's finale backstop. A game lost on its finale is aborted instead.
  if (map === entry.maps.at(-1)) return null;

  const totA = maps.reduce((n, x) => n + x.a, 0);
  const totB = maps.reduce((n, x) => n + x.b, 0);
  const prev = done.at(-1)?.half1Surv ?? null;
  // L4D1 (verified on 906 of 910 map starts): the higher total survives
  // first; a tie keeps the previous map's order; map 1 is team a.
  const firstSurv: 'a' | 'b' = totA > totB ? 'a' : totB > totA ? 'b' : prev ?? 'a';

  // A tournament game: the current four of each side, so a sub survives the
  // restore and the subbed-out player stays a stats row only (plan T3c
  // final review). Any other game: every match_players row.
  const roster = (tournamentRoster(db, matchId) ?? matchPlayersRoster(db, matchId))
    // A replay from an earlier chapter drops the maps a later sub joined on,
    // so their joined map comes back to the replayed one: they play it now.
    .map((r) => ({ ...r, joinedMap: opts.replayFrom !== undefined ? Math.min(r.joinedMap, maps.length) : r.joinedMap }));
  const maxSeq = (db.prepare('SELECT MAX(seq) AS s FROM match_live_events WHERE match_id = ?').get(matchId) as { s: number | null }).s ?? 0;

  return { matchId, token: m.token, campaign: m.campaign, firstMap, maps, map, firstSurv, roster, nextSeq: maxSeq + 1 };
}

/** The chapters of a live game that may be replayed from their start
 *  (plan T3c Ruling 12): every finished one and the one being played, the
 *  finale never (restoreSnapshot refuses it). In order. */
export function replayableChapters(db: DB, matchId: number): { ordinal: number; map: string }[] {
  const out: { ordinal: number; map: string }[] = [];
  for (let k = 0; k < 16; k++) {
    const s = restoreSnapshot(db, matchId, { replayFrom: k });
    if (!s) break;
    out.push({ ordinal: k, map: s.map });
  }
  return out;
}

/** The plugin lines that resume it (pug-match 0.3.19, Task 5). */
export function resumeLines(s: RestoreSnapshot): string[] {
  if (!/^[A-Za-z0-9]+$/.test(s.token)) throw new Error('restore token has unexpected characters');
  for (const x of [s.firstMap, s.map, ...s.maps.map((y) => y.map)]) {
    if (!isMapName(x)) throw new Error(`restore map ${JSON.stringify(x)} has unexpected characters`);
  }
  return [
    `sm_pug_resume ${s.matchId} ${s.token} ${s.firstMap} ${s.firstSurv} ${s.nextSeq}`,
    ...s.maps.map((x) => `sm_pug_resume_map ${x.map} ${Math.trunc(x.a)} ${Math.trunc(x.b)}`),
    // Quoted: Source's console tokenizer splits unquoted arguments on ':',
    // so an unquoted roster arg reaches the plugin as a bare steamid and is
    // refused (as orchestrator.ts already quotes its own sm_pug_roster call).
    ...s.roster.filter((r) => /^\d{17}$/.test(r.steamid)).map((r) => `sm_pug_roster "${r.steamid}:${r.team}:${r.joinedMap}"`),
    'sm_pug_resume_commit',
  ];
}

/** Delete the interrupted map's partial rows and stamp restored_at_map. */
export function prepareRestore(db: DB, s: RestoreSnapshot): void {
  db.transaction(() => {
    db.prepare('DELETE FROM match_rounds WHERE match_id = ? AND ordinal >= ?').run(s.matchId, s.maps.length);
    db.prepare('DELETE FROM match_live_maps WHERE match_id = ? AND ordinal >= ?').run(s.matchId, s.maps.length);
    // The first restore decides: stats cover from there on, even after a second one.
    db.prepare('UPDATE matches SET restored_at_map = COALESCE(restored_at_map, ?) WHERE id = ?').run(s.maps.length, s.matchId);
  })();
}
