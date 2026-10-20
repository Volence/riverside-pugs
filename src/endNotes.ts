import type { DB } from './db.js';
import type { RequeueResult } from './matchRequeue.js';
import { playerSeasonState, rankView, seasonRules, type LadderEntry } from './seasonRules.js';

/**
 * The line each player gets for themselves when a match ends (owner ask
 * 2026-10-20): their SR change after every match, the rank when it moved,
 * placement progress while placing, and whether !rq put them back in the
 * queue. Shown in their own chat and in their own disconnect dialog
 * (sm_pug_endnote, pug-match 0.3.38), never to anyone else, so nobody's rank
 * is read out to the lobby.
 *
 * Plain ASCII: the L4D1 chat and kick dialog fonts are not to be trusted with
 * anything else, and the text crosses rcon as a command argument.
 */

export type StandingSnapshot = Map<string, LadderEntry | null>;

/** Each rostered player's season standing right now. Taken just before the
 *  match is rated, and again just after, to say what the match did. */
export function standingSnapshot(db: DB, matchId: number): StandingSnapshot {
  const m = db.prepare('SELECT season_id FROM matches WHERE id = ?').get(matchId) as { season_id: number | null } | undefined;
  const out: StandingSnapshot = new Map();
  if (!m || m.season_id === null) return out;
  const ids = (db.prepare('SELECT player_id FROM match_players WHERE match_id = ?').all(matchId) as { player_id: string }[]).map((r) => r.player_id);
  for (const id of ids) out.set(id, playerSeasonState(db, m.season_id, id));
  return out;
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

/** The rating part of one player's note, or null when the match did not rate
 *  them (an unrated match, or they were not on it). */
export function ratingNote(placementGames: number, before: LadderEntry | null, after: LadderEntry | null): string | null {
  if (!after || after.games === (before?.games ?? 0)) return null;
  if (!after.placed) return `Placement ${after.games} of ${placementGames} done.`;
  const rank = after.rankIdx === null ? null : rankView(after.rankIdx).name;
  if (!before || !before.placed) {
    return rank ? `Placed: ${rank} (${after.sr} SR).` : `Placed at ${after.sr} SR.`;
  }
  const head = `${signed(after.sr - before.sr)} SR, now ${after.sr}`;
  if (after.rankIdx === null || before.rankIdx === null || after.rankIdx === before.rankIdx) {
    return rank ? `${head} (${rank}).` : `${head}.`;
  }
  return after.rankIdx > before.rankIdx ? `${head}. Promoted to ${rank}!` : `${head}. Down to ${rank}.`;
}

function requeueNote(r: RequeueResult | undefined): string | null {
  if (!r) return null;
  return r.ok ? 'You are back in the queue.' : `Not requeued: ${r.error}.`;
}

/** Keep the text safe as one rcon argument and short enough for the kick
 *  dialog: printable ASCII, no quotes or semicolons. */
export function cleanNote(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, '').replace(/["';\\]/g, '').slice(0, 120).trim();
}

/** One note per rostered player who has anything to be told. */
export function endNotes(
  db: DB, matchId: number, before: StandingSnapshot, requeued: Map<string, RequeueResult> = new Map(),
): { steamid: string; text: string }[] {
  const m = db.prepare('SELECT season_id FROM matches WHERE id = ?').get(matchId) as { season_id: number | null } | undefined;
  if (!m || m.season_id === null) return [];
  const rules = seasonRules(db, m.season_id);
  const after = standingSnapshot(db, matchId);
  const out: { steamid: string; text: string }[] = [];
  for (const [id, now] of after) {
    const parts = [ratingNote(rules.placementGames, before.get(id) ?? null, now), requeueNote(requeued.get(id))].filter((p): p is string => p !== null);
    if (parts.length > 0) out.push({ steamid: id, text: cleanNote(parts.join(' ')) });
  }
  return out;
}
