import { penaltyHistory } from '../../penalties.js';
import { ROW_LIMIT, toIso, type TimelineAdapter, type TimelineItem } from './types.js';

/** No-shows and missed ready checks. These are what the queue timeout ladder
 *  counts, so they belong on the file even though each one is ordinary. */
export const penaltiesAdapter: TimelineAdapter = {
  source: 'penalty',
  items({ db, ids }): TimelineItem[] {
    const out: TimelineItem[] = [];
    for (const id of ids) {
      for (const p of penaltyHistory(db, id, ROW_LIMIT)) {
        out.push({
          at: toIso(p.createdAt),
          source: 'penalty',
          kind: p.kind,
          summary: `${p.kind === 'no_show' ? 'Did not connect to the match' : 'Missed a ready check'}`
            + `${p.clearedAt ? `, cleared since by ${p.clearedBy ?? 'an admin'}` : ''}.`,
          matchId: p.matchId,
          replay: null,
          ref: { type: 'penalty', id: p.id },
        });
      }
    }
    return out;
  },
};
