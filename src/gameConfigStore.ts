import type { DB } from './db.js';
import { OPEN_STATES_SQL } from './bookings/rules.js';
import { logAdmin } from './admin/audit.js';

/**
 * The Game configs desk: the balance layers staff approve for bookings and
 * events (spec part 1, Rulesets). A config's cfg is what setup runs as
 * `exec <cfg>` on the booked box (src/bookings/runner.ts), so it is held to
 * lowercase letters, digits and underscores: nothing that could end the
 * command or name a path. The file itself must already be on every pool
 * server; this module cannot check that.
 *
 * Every write is one transaction with its logAdmin row (before and after).
 * 'standard' is the default every picker falls back to, so it is never
 * turned off or deleted. A config an open booking or an unfinished event uses
 * cannot be deleted; turning one off only takes it out of the pickers, and
 * what already uses it keeps running it.
 */

export const GAME_CONFIG_ERRORS = {
  not_found: { status: 404, text: 'No such game config.' },
  bad_key: { status: 400, text: 'A key is 2 to 32 lowercase letters, digits or underscores.' },
  key_taken: { status: 409, text: 'That key is already a game config.' },
  bad_label: { status: 400, text: 'A label is 3 to 60 characters.' },
  bad_cfg: { status: 400, text: 'A cfg name is lowercase letters, digits and underscores, without .cfg.' },
  bad_enabled: { status: 400, text: 'Enabled is on or off.' },
  standard_locked: { status: 409, text: 'The standard config cannot be turned off or deleted.' },
  in_use: { status: 409, text: 'Open bookings or unfinished events use this config, so it cannot be deleted.' },
} as const satisfies Record<string, { status: number; text: string }>;
export type GameConfigError = keyof typeof GAME_CONFIG_ERRORS;
export type GameConfigResult<T> = { ok: true; value: T } | { ok: false; error: GameConfigError };
const ok = <T>(value: T): GameConfigResult<T> => ({ ok: true, value });
const fail = (error: GameConfigError): { ok: false; error: GameConfigError } => ({ ok: false, error });

export const KEY_RE = /^[a-z0-9_]{2,32}$/;
export const CFG_RE = /^[a-z0-9_]+$/;
const CFG_MAX = 64;

export interface GameConfigRow { key: string; label: string; cfg: string; enabled: number }
export interface GameConfigListItem {
  key: string; label: string; cfg: string; enabled: boolean; locked: boolean; inUse: { bookings: number; events: number };
}

export function getGameConfig(db: DB, key: string): GameConfigRow | undefined {
  return db.prepare('SELECT * FROM game_configs WHERE key = ?').get(key) as GameConfigRow | undefined;
}

export function gameConfigInUse(db: DB, key: string): { bookings: number; events: number } {
  const bookings = (db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE game_config = ? AND state IN ${OPEN_STATES_SQL}`).get(key) as { n: number }).n;
  const events = (db.prepare(
    `SELECT COUNT(DISTINCT e.id) AS n FROM event_stages s JOIN events e ON e.id = s.event_id
     WHERE s.game_config = ? AND e.status NOT IN ('finished', 'cancelled')`,
  ).get(key) as { n: number }).n;
  return { bookings, events };
}

export function gameConfigList(db: DB): GameConfigListItem[] {
  const rows = db.prepare("SELECT * FROM game_configs ORDER BY key <> 'standard', key").all() as GameConfigRow[];
  return rows.map((r) => ({
    key: r.key, label: r.label, cfg: r.cfg, enabled: r.enabled === 1, locked: r.key === 'standard', inUse: gameConfigInUse(db, r.key),
  }));
}

function readLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const label = raw.trim();
  return label.length >= 3 && label.length <= 60 && !/[\u0000-\u001f\u007f]/.test(label) ? label : null;
}

const plain = (r: GameConfigRow) => ({ label: r.label, cfg: r.cfg, enabled: r.enabled === 1 });

export function createGameConfig(db: DB, o: { by: string; key: unknown; label: unknown; cfg: unknown }): GameConfigResult<{ key: string }> {
  return db.transaction((): GameConfigResult<{ key: string }> => {
    if (typeof o.key !== 'string' || !KEY_RE.test(o.key)) return fail('bad_key');
    const label = readLabel(o.label);
    if (!label) return fail('bad_label');
    if (typeof o.cfg !== 'string' || !CFG_RE.test(o.cfg) || o.cfg.length > CFG_MAX) return fail('bad_cfg');
    if (getGameConfig(db, o.key)) return fail('key_taken');
    db.prepare('INSERT INTO game_configs (key, label, cfg, enabled) VALUES (?, ?, ?, 1)').run(o.key, label, o.cfg);
    logAdmin(db, o.by, 'game_config_create', o.key, { after: { label, cfg: o.cfg, enabled: true } });
    return ok({ key: o.key });
  })();
}

/** The label and whether pickers offer it. The cfg never changes: a new cfg
 *  is a new config, so what a key meant stays readable in the audit log. */
export function updateGameConfig(db: DB, o: { by: string; key: string; label: unknown; enabled: unknown }): GameConfigResult<null> {
  return db.transaction((): GameConfigResult<null> => {
    const row = getGameConfig(db, o.key);
    if (!row) return fail('not_found');
    const label = readLabel(o.label);
    if (!label) return fail('bad_label');
    if (typeof o.enabled !== 'boolean') return fail('bad_enabled');
    if (row.key === 'standard' && !o.enabled) return fail('standard_locked');
    db.prepare('UPDATE game_configs SET label = ?, enabled = ? WHERE key = ?').run(label, o.enabled ? 1 : 0, row.key);
    logAdmin(db, o.by, 'game_config_update', row.key, { before: plain(row), after: { label, cfg: row.cfg, enabled: o.enabled } });
    return ok(null);
  })();
}

export function deleteGameConfig(db: DB, o: { by: string; key: string }): GameConfigResult<null> {
  return db.transaction((): GameConfigResult<null> => {
    const row = getGameConfig(db, o.key);
    if (!row) return fail('not_found');
    if (row.key === 'standard') return fail('standard_locked');
    const use = gameConfigInUse(db, row.key);
    if (use.bookings > 0 || use.events > 0) return fail('in_use');
    db.prepare('DELETE FROM game_configs WHERE key = ?').run(row.key);
    logAdmin(db, o.by, 'game_config_delete', row.key, { before: plain(row), after: null });
    return ok(null);
  })();
}
