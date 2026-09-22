import type { DB } from '../../db.js';
import { ROW_LIMIT, marks, toIso, type TimelineAdapter, type TimelineItem } from './types.js';

interface Row { kind: string; marker: string; match_id: number | null; at: string }

/** Alerts raised from what Steam says about the account. Hedged here as they
 *  are hedged everywhere else: a ban in another game is not a ban in this
 *  one, and a borrowed library is how a household shares a PC. The marker is
 *  the ban count for recent_ban and the lender's id for banned_lender, which
 *  is what makes a second ban news while the same ban is not. */
export const steamAdapter: TimelineAdapter = {
  source: 'steam',
  items({ db, ids }): TimelineItem[] {
    const rows = db.prepare(
      `SELECT kind, marker, match_id, at FROM steam_signal_alerts
       WHERE player_id IN (${marks(ids)}) ORDER BY at DESC LIMIT ?`,
    ).all(...ids, ROW_LIMIT) as Row[];
    return rows.map((r) => ({
      at: toIso(r.at),
      source: 'steam' as const,
      kind: r.kind,
      summary: r.kind === 'recent_ban'
        ? `Steam shows ${r.marker} ban${r.marker === '1' ? '' : 's'} on this account, the newest of them recent. Steam does not say which game, so this is context and not a finding about the PUG.`
        : `Playing on a copy of the game shared from ${r.marker}, an account banned here. Households share libraries, so this is a reason to look and nothing more.`,
      matchId: r.match_id,
      replay: null,
      ref: { type: 'steam_alert', id: `${r.kind}:${r.marker}` },
    }));
  },
  evidence(db: DB) {
    return db.prepare(
      'SELECT player_id AS steamid, MAX(at) AS at FROM steam_signal_alerts GROUP BY player_id',
    ).all() as { steamid: string; at: string }[];
  },
};
