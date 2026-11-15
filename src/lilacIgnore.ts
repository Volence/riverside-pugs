import type { DB } from './db.js';

/**
 * LilAC aimlock flags that are kept on the file but never count as a cheat
 * signal (owner ruling 2026-11-15).
 *
 *   readyup   raised inside a ready-up window (match_readyups). Ghost
 *             infected float in front of the saferoom and a survivor looking
 *             at one trips aimlock: 21 of the 24 ghost aimlocks on record
 *             were in a ready-up.
 *   infected  the flagged player was infected (the reporter's lself_team=3).
 *             Infected see survivors through walls by design, so a lock on
 *             one means nothing.
 *
 * Only aimlock. An aimbot (Aim-Snap) flag on an infected player still counts.
 * The row is never deleted: integrity_flags.ignored holds the reason, the
 * admin file shows it as "ignored (ready-up)" / "ignored (infected)", and
 * every cheat-signal reader (fingerprint cheat_flag sign, needs a look, the
 * admin feed) skips it.
 */
export type LilacIgnored = 'readyup' | 'infected';

export const IGNORED_LABEL: Record<LilacIgnored, string> = {
  readyup: 'ignored (ready-up)',
  infected: 'ignored (infected)',
};

/** f.at (ISO) inside one of the ready-ups on the flag's match, or, for a
 *  flag filed on no match, of any match on the flag's server. An open
 *  ready-up (ended_at NULL) runs to the match's end, or is still open while
 *  the match has not ended: rows of a finished match are often left open. */
const IN_READYUP = `EXISTS (
  SELECT 1 FROM match_readyups r JOIN matches m ON m.id = r.match_id
   WHERE (r.match_id = f.match_id
          OR (f.match_id IS NULL AND f.server_id IS NOT NULL AND m.server_id = f.server_id))
     AND datetime(f.at) >= r.started_at
     AND (COALESCE(r.ended_at, m.ended_at) IS NULL OR datetime(f.at) <= COALESCE(r.ended_at, m.ended_at)))`;

/** The canonical detail (logParse lilacReasonDetail) is space separated
 *  key=value, so pad it to match a whole field. */
const ON_INFECTED = `(' ' || f.detail || ' ') LIKE '% lself_team=3 %'`;

/**
 * Mark the aimlock flags that should be ignored and are not yet marked: the
 * one row `id`, or every row when it is omitted (the boot backfill). Never
 * clears a mark. Returns how many rows got each reason.
 */
export function markIgnoredLilac(db: DB, id?: number): Record<LilacIgnored, number> {
  const scope = `f.source = 'lilac' AND f.kind = 'aimlock' AND f.ignored IS NULL${id === undefined ? '' : ' AND f.id = ?'}`;
  const args = id === undefined ? [] : [id];
  // A flag in a ready-up is "ready-up" even when the player was also
  // infected: the window is the stronger reason, it covers ghosts too.
  const readyup = db.prepare(
    `UPDATE integrity_flags AS f SET ignored = 'readyup' WHERE ${scope} AND ${IN_READYUP}`,
  ).run(...args).changes;
  const infected = db.prepare(
    `UPDATE integrity_flags AS f SET ignored = 'infected' WHERE ${scope} AND ${ON_INFECTED}`,
  ).run(...args).changes;
  return { readyup, infected };
}

/** The reason one stored flag is ignored, or null when it counts. */
export function ignoredOf(db: DB, id: number): LilacIgnored | null {
  const row = db.prepare('SELECT ignored FROM integrity_flags WHERE id = ?').get(id) as { ignored: string | null } | undefined;
  return row?.ignored === 'readyup' || row?.ignored === 'infected' ? row.ignored : null;
}
