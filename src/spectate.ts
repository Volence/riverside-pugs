import type { DB } from './db.js';

/** SourceTV's broadcast delay, in seconds. Matches tv_delay on the game
 *  servers: it is what stops a live spectator ghosting for their team. */
export const SPECTATE_DELAY_SECONDS = 30;

export interface SpectateInfo {
  host: string;
  port: number;
  /** Empty when the server's SourceTV has no password. */
  password: string;
  delay: number;
}

/**
 * How to watch a match on a given server, or null when that server has no
 * SourceTV switched on.
 *
 * Public on purpose (the owner's call, 2026-09-17): the 30 second delay is what
 * makes live spectating safe, not secrecy, so the connect details ride along on
 * the public live payload.
 */
export function spectateFor(db: DB, serverId: number | null): SpectateInfo | null {
  if (serverId === null) return null;
  const row = db.prepare('SELECT host, tv_port, tv_password, tv_enabled FROM servers WHERE id = ?')
    .get(serverId) as { host: string; tv_port: number | null; tv_password: string | null; tv_enabled: number } | undefined;
  if (!row || row.tv_enabled !== 1 || !row.tv_port) return null;
  return { host: row.host, port: row.tv_port, password: row.tv_password ?? '', delay: SPECTATE_DELAY_SECONDS };
}
