import type { DB } from '../db.js';
import { campaignRegistry } from '../campaignRegistry.js';
import { stopAfterMap } from '../stopPoint.js';
import * as E from './events.js';
import * as R from './room.js';

/** The map a stage's game on this campaign stops after: the stage's chapter
 *  count when it sets one, else the campaign's own stop point. */
export function stageStopMap(db: DB, stage: E.StageRow, campaign: string): string | null {
  const s = E.stageSettingsOf(stage);
  if (s.chapters === null) return stopAfterMap(db, campaign);
  const maps = campaignRegistry(db).get(campaign)?.maps ?? [];
  return maps[Math.min(s.chapters, maps.length) - 1] ?? null;
}

/** The stop map a tournament game (a matches.id) was started with (the
 *  series engine's sm_pug_match line): a tiebreak's one map, else the
 *  stage's. Null for any other game, which was started with none. Crash
 *  recovery and the chapter replay send it on sm_pug_resume, so a resumed
 *  game still ends where it should (audit 2026-10-09 D1). */
export function gameStopMap(db: DB, gameMatchId: number): string | null {
  const row = db.prepare(
    `SELECT em.id AS eventMatchId, em.stage_id AS stageId
       FROM matches m JOIN event_matches em ON em.booking_id = m.booking_id
      WHERE m.id = ? AND m.booking_id IS NOT NULL AND m.kind = 'tournament'`,
  ).get(gameMatchId) as { eventMatchId: number; stageId: number } | undefined;
  if (!row) return null;
  const g = R.gamesOf(db, row.eventMatchId).find((x) => x.match_id === gameMatchId);
  if (!g) return null;
  if (g.tiebreak_of !== null) return g.map;
  const stage = E.getStage(db, row.stageId);
  return stage ? stageStopMap(db, stage, g.campaign) : null;
}
