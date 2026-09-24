import type { DB } from '../../db.js';

/**
 * One merged list of everything known about a player, in time order.
 *
 * Each source is a small adapter rather than a branch in one query, so a
 * future source (per-tick aim metrics, say) is one file and no screen work.
 * Adapters never throw at the caller: playerTimeline catches, logs and
 * carries on, because a file that renders nine sources is worth far more
 * than one that renders none.
 */
export type TimelineSource =
  | 'input' | 'lilac' | 'analyzer' | 'drop' | 'ticket' | 'penalty' | 'ban'
  | 'note' | 'steam' | 'discord_link' | 'cvar' | 'conduct';

/** The sources that mean somebody should take a look. Needs a look is built
 *  from these and nothing else: a ban or a note is a record of a decision
 *  already taken, not something waiting for one. */
export type EvidenceSource = 'input' | 'lilac' | 'analyzer' | 'drop' | 'steam' | 'cvar' | 'conduct';

export interface TimelineItem {
  at: string;
  source: TimelineSource;
  /** Source-specific, e.g. 'pistol_rate', 'aimbot', 'clip'. */
  kind: string;
  /** One line, written server-side so every surface says the same thing. */
  summary: string;
  matchId: number | null;
  replay: { ordinal: number; half: number; tMs: number } | null;
  /** What to open, when there is something. */
  ref: { type: string; id: number | string } | null;
  /** On the file for the record, but settled by a league ruling rather than
   *  waiting on anyone: never evidence, whatever its source. */
  allowed?: true;
}

export interface TimelineCtx {
  db: DB;
  /** The canonical id, after alias resolution. */
  steamid: string;
  /** The canonical id plus every alias folded into it. The evidence tables
   *  carry no foreign key on players, so a merged alt's rows can still sit
   *  under its own id: every adapter queries the whole list, never one id. */
  ids: string[];
  /** Who is looking. Ticket rows obey the tickets rules for this person. */
  viewer: string;
}

export interface TimelineAdapter {
  source: TimelineSource;
  items(ctx: TimelineCtx): TimelineItem[];
  /** One row per steamid: the newest evidence this source holds for it.
   *  Only evidence sources have one, and needsALook folds them together.
   *  Deliberately one row per player rather than all of them: the question
   *  is "is there anything newer than the last review", not "how much". */
  evidence?(db: DB): { steamid: string; at: string }[];
}

/** Rows per adapter. A file shows a history, not an archive. */
export const ROW_LIMIT = 200;

/** SQLite writes some columns with datetime('now') ("2026-09-21 10:00:00")
 *  and the app writes others as ISO. One reader for both, so sorting a
 *  merged list never compares a space against a T. */
export function toIso(raw: string): string {
  const t = Date.parse(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`);
  return Number.isNaN(t) ? raw : new Date(t).toISOString();
}

/** Placeholders for an id list: the ids are bound, never interpolated. */
export function marks(ids: string[]): string {
  return ids.map(() => '?').join(', ');
}

/** Whether an item counts towards "needs a look". A single connect drop is
 *  retry noise and a cancelled loading screen looks identical, so only the
 *  repeat rule counts; drops.ts marks those with kind 'repeat'. */
export function isEvidence(item: TimelineItem): boolean {
  if (item.allowed) return false;
  if (item.source === 'drop') return item.kind === 'repeat';
  // A cvar fix (kind ending _fixed, see cvar.ts) is on the timeline, not evidence.
  if (item.source === 'cvar') return !item.kind.endsWith('_fixed');
  return item.source === 'input' || item.source === 'lilac'
    || item.source === 'analyzer' || item.source === 'steam' || item.source === 'conduct';
}
