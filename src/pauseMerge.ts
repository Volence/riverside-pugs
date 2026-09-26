import type { DB } from './db.js';

/**
 * Join pause ledger rows that recordPhase used to split. Before the fix, a
 * pause whose leave flag changed (a player dropping or returning mid-pause,
 * or a disconnect pause going into its unpause countdown) was closed and a
 * new row opened in the same second, so one pause read as two or three.
 *
 * A split is two rows of one match, map, half and team (null included) where
 * the second starts the second the first ended AND the leave flag differs.
 * The flag test keeps a genuine re-pause apart: that comes after a live phase,
 * starts with the flag off, and follows a pause that ended with it off.
 */
export interface PauseChain { matchId: number; ids: number[] }

interface Row {
  id: number; match_id: number; map_ordinal: number; half: number | null; team: string | null;
  leave_pause: number; started_at: string; ended_at: string | null; called_by: string | null;
}

export function planPauseMerge(db: DB): PauseChain[] {
  const rows = db.prepare('SELECT * FROM match_pauses ORDER BY match_id, id').all() as Row[];
  const chains: PauseChain[] = [];
  let cur: Row[] = [];
  const flush = () => {
    if (cur.length > 1) chains.push({ matchId: cur[0].match_id, ids: cur.map((r) => r.id) });
    cur = [];
  };
  for (const r of rows) {
    const last = cur[cur.length - 1];
    const joins = last !== undefined && last.match_id === r.match_id && last.map_ordinal === r.map_ordinal
      && last.half === r.half && last.team === r.team && last.ended_at !== null
      && last.ended_at === r.started_at && last.leave_pause !== r.leave_pause;
    if (!joins) flush();
    cur.push(r);
  }
  flush();
  return chains;
}

/** The first row of each chain takes the last row's end, the leave flag if
 *  any row had it, and the first caller named; the rest are deleted. */
export function applyPauseMerge(db: DB, chains: PauseChain[]): void {
  const get = db.prepare('SELECT * FROM match_pauses WHERE id = ?');
  const upd = db.prepare('UPDATE match_pauses SET ended_at = ?, leave_pause = ?, called_by = ? WHERE id = ?');
  const del = db.prepare('DELETE FROM match_pauses WHERE id = ?');
  db.transaction(() => {
    for (const c of chains) {
      const rows = c.ids.map((id) => get.get(id) as Row);
      const head = rows[0];
      upd.run(
        rows[rows.length - 1].ended_at,
        rows.some((r) => r.leave_pause === 1) ? 1 : 0,
        rows.find((r) => r.called_by !== null)?.called_by ?? null,
        head.id,
      );
      for (const r of rows.slice(1)) del.run(r.id);
    }
  })();
}
