import { ROW_LIMIT, marks, toIso, type TimelineAdapter, type TimelineItem } from './types.js';

interface Row {
  id: number; discord_id: string; discord_name: string; linked_at: string; linked_by: string;
  unlinked_at: string | null; unlinked_by: string | null;
}

/** Every Discord account this Steam account has held, linked and unlinked.
 *  One Discord passing between Steam accounts is the plainest sign of an alt
 *  this site has, which is why both ends of each link are listed. */
export const discordLinksAdapter: TimelineAdapter = {
  source: 'discord_link',
  items({ db, ids }): TimelineItem[] {
    const rows = db.prepare(
      `SELECT id, discord_id, discord_name, linked_at, linked_by, unlinked_at, unlinked_by
       FROM discord_link_history WHERE steamid IN (${marks(ids)}) ORDER BY id DESC LIMIT ?`,
    ).all(...ids, ROW_LIMIT) as Row[];
    const out: TimelineItem[] = [];
    for (const r of rows) {
      const who = `${r.discord_name || 'unknown'} (${r.discord_id})`;
      out.push({
        at: toIso(r.linked_at),
        source: 'discord_link',
        kind: 'linked',
        summary: r.linked_by === 'backfill'
          ? `Discord ${who} was already linked when the history began.`
          : `Linked Discord ${who}.`,
        matchId: null,
        replay: null,
        ref: { type: 'discord_link', id: r.id },
      });
      if (r.unlinked_at) {
        out.push({
          at: toIso(r.unlinked_at),
          source: 'discord_link',
          kind: 'unlinked',
          summary: `Unlinked Discord ${who}${r.unlinked_by === 'merge' ? ', by a merge' : ''}.`,
          matchId: null,
          replay: null,
          ref: { type: 'discord_link', id: r.id },
        });
      }
    }
    return out;
  },
};
