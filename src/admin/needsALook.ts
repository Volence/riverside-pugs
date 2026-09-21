import type { DB } from '../db.js';
import { resolveAlias } from '../aliases.js';
import { getPlayer } from '../players.js';
import { ticketsAbout } from '../tickets/views.js';
import { analyzerRanks, type AnalyzerRank } from './analyzerRanks.js';
import { canOpenFile, type FileViewer } from './fileAccess.js';
import { ADAPTERS } from './playerTimeline.js';
import { lastReviewOf } from './reviews.js';
import { toIso, type EvidenceSource, type TimelineAdapter } from './timeline/types.js';

export interface NeedsALookRow {
  steamid: string;
  name: string;
  avatar: string | null;
  status: string;
  newestEvidenceAt: string;
  sources: EvidenceSource[];
  lastReviewAt: string | null;
  /** The reviewer as a person reads them: their name, or their id when the
   *  site has never seen one. */
  lastReviewBy: string | null;
  openTickets: number;
  analyzer: AnalyzerRank | null;
}

/**
 * Players whose newest evidence is newer than their newest review.
 *
 * The only question asked of each source is "what is the newest thing you
 * hold about this id", which is why an adapter contributes one row per
 * player rather than all of them. A single connect drop is not evidence and
 * drops.ts already answers accordingly.
 *
 * An id with no player row is left off: it has no file to open, and a row
 * that 404s when clicked is worse than an absent one. The evidence is still
 * on the file of whoever that id was merged into, because ids are resolved
 * here before anything is compared.
 */
export function needsALook(
  db: DB, viewer: FileViewer, adapters: TimelineAdapter[] = ADAPTERS,
): NeedsALookRow[] {
  const newest = new Map<string, { at: string; sources: Set<EvidenceSource> }>();
  for (const adapter of adapters) {
    if (!adapter.evidence) continue;
    let rows: { steamid: string; at: string }[];
    try {
      rows = adapter.evidence(db);
    } catch (err) {
      console.error(`[needs a look] the ${adapter.source} source failed:`, err);
      continue;
    }
    for (const row of rows) {
      const id = resolveAlias(db, row.steamid);
      const at = toIso(row.at);
      const seen = newest.get(id) ?? { at: '', sources: new Set<EvidenceSource>() };
      // Only an adapter that offers evidence() gets here, and those are
      // exactly the evidence sources.
      seen.sources.add(adapter.source as EvidenceSource);
      if (at > seen.at) seen.at = at;
      newest.set(id, seen);
    }
  }

  const ranks = analyzerRanks(db);
  const out: NeedsALookRow[] = [];
  for (const [steamid, { at, sources }] of newest) {
    const player = getPlayer(db, steamid);
    if (!player) continue;
    if (!canOpenFile(db, viewer, steamid)) continue;
    const review = lastReviewOf(db, steamid);
    if (review && review.reviewedAt >= at) continue;
    out.push({
      steamid,
      name: player.name,
      avatar: player.avatar,
      status: player.status,
      newestEvidenceAt: at,
      sources: [...sources].sort(),
      lastReviewAt: review?.reviewedAt ?? null,
      lastReviewBy: review === null ? null : (review.reviewedByName ?? review.reviewedBy),
      openTickets: ticketsAbout(db, steamid, viewer.steamid).filter((t) => t.status === 'open').length,
      analyzer: ranks.get(steamid) ?? null,
    });
  }
  return out.sort((a, b) => (a.newestEvidenceAt < b.newestEvidenceAt ? 1 : -1));
}
