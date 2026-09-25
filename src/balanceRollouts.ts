import type { DB } from './db.js';
import type { BalanceKnobs } from './balanceKnobs.js';
import {
  diffIgnoringVersionless, patchNumber, predictInventory, previewKnobs, renderBalanceCfg, type Inventory, type KnobPreview,
} from './balanceControl.js';

/** SQLite's datetime('now') format, so it sorts against the other balance times. */
const sqlNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/** `name` is the patch's name after the apply; `notesSet` says whether this
 *  apply wrote the notes (always for a new patch, only when they were empty
 *  for a reused one). */
export type ApplyResult = { ok: true; rolloutId: number; patchId: number; reused: boolean; name: string | null; notesSet: boolean; preview: KnobPreview }
  | { ok: false; status: 400 | 409; error: string; preview?: KnobPreview };

export interface RolloutRow {
  id: number; patch_id: number; values_json: string; content: string; created_by: string; created_at: string; superseded_at: string | null;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Announce the patch, then open a rollout for every enabled server. One
 *  transaction, so a rollout never exists without its patch and two applies
 *  cannot interleave. Writing to the boxes is the writer's job. */
export function applyKnobs(db: DB, knobs: BalanceKnobs, req: {
  values: unknown; name: unknown; notes: unknown; adminId: string; now?: string;
}): ApplyResult {
  const now = req.now ?? sqlNow();
  return db.transaction((): ApplyResult => {
    const preview = previewKnobs(db, knobs, req.values);
    if (preview.errors.length) return { ok: false, status: 400, error: preview.errors.join('; '), preview };
    if (!preview.base) return { ok: false, status: 409, error: 'No queue match has been seen with a balance fingerprint yet, so there is nothing to predict from.', preview };
    if (preview.missing.length) return { ok: false, status: 409, error: `Not reported by the servers: ${preview.missing.join(', ')}.`, preview };
    if (preview.blocking.length) {
      return { ok: false, status: 409, preview,
        error: `Servers differ in more than knob values: ${preview.blocking.map((b) => `${b.name} (${b.diff})`).join('; ')}. Disable a server or fix it first.` };
    }
    const name = text(req.name);
    const notes = typeof req.notes === 'string' ? req.notes.trim() : '';
    if (name.length > 60) return { ok: false, status: 400, error: 'A patch name is up to 60 characters.', preview };
    if (notes.length > 2000) return { ok: false, status: 400, error: 'Notes are up to 2000 characters.', preview };

    let patchId: number;
    let notesSet = false;
    const reused = preview.existingPatch !== null;
    if (preview.existingPatch) {
      const p = preview.existingPatch;
      if (p.triage === 'folded') {
        return { ok: false, status: 409, preview,
          error: `This config was folded into another patch as not a balance change. Unfold patch #${p.number} in the Patches tab first.` };
      }
      patchId = p.id;
      if (!p.name) {
        if (!name) return { ok: false, status: 400, error: 'This config is an unnamed patch: give it a name.', preview };
        // Naming a patch in the panel is reviewing it, as a new patch is.
        db.prepare('UPDATE balance_patches SET name = ?, reviewed = 1 WHERE id = ?').run(name, patchId);
      }
      if (!p.notes && notes) {
        db.prepare('UPDATE balance_patches SET notes = ? WHERE id = ?').run(notes, patchId);
        notesSet = true;
      }
      // Choosing this config in the panel is deciding it is a balance patch.
      db.prepare("UPDATE balance_patches SET triage = 'balance' WHERE id = ? AND triage = 'pending'").run(patchId);
    } else {
      if (!name) return { ok: false, status: 400, error: 'A new patch needs a name.', preview };
      if (!notes) return { ok: false, status: 400, error: 'A new patch needs notes saying what changed and why.', preview };
      const base = db.prepare('SELECT inputs_json FROM balance_patches WHERE id = ?').get(preview.base.patchId) as { inputs_json: string };
      const inv = predictInventory(JSON.parse(base.inputs_json) as Inventory, knobs, preview.values);
      const invJson = JSON.stringify(Object.fromEntries(Object.entries(inv).sort()));
      patchId = Number(db.prepare(`INSERT INTO balance_patches (fingerprint, name, notes, source, inputs_json, first_seen_at, reviewed, triage)
        VALUES (?, ?, ?, 'announced', ?, ?, 1, 'balance')`).run(preview.fingerprint, name, notes, invJson, now).lastInsertRowid);
      notesSet = true;
    }
    const patchName = (db.prepare('SELECT name FROM balance_patches WHERE id = ?').get(patchId) as { name: string | null }).name;
    const content = renderBalanceCfg(knobs, preview.values, { number: patchNumber(db, patchId), name: patchName });
    db.prepare('UPDATE balance_rollouts SET superseded_at = ? WHERE superseded_at IS NULL').run(now);
    const rolloutId = Number(db.prepare(`INSERT INTO balance_rollouts (patch_id, values_json, content, created_by, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(patchId, JSON.stringify(preview.values), content, req.adminId, now).lastInsertRowid);
    ensureServerRows(db, rolloutId);
    return { ok: true, rolloutId, patchId, reused, name: patchName, notesSet, preview };
  })();
}

export function activeRollout(db: DB): RolloutRow | null {
  return (db.prepare('SELECT * FROM balance_rollouts WHERE superseded_at IS NULL ORDER BY id DESC LIMIT 1').get() as RolloutRow | undefined) ?? null;
}

/** A pending row for every enabled server that has none, so a box enabled
 *  after the apply still gets the file. */
export function ensureServerRows(db: DB, rolloutId: number): void {
  db.prepare(`INSERT OR IGNORE INTO balance_rollout_servers (rollout_id, server_id, state)
    SELECT ?, id, 'pending' FROM servers WHERE enabled = 1`).run(rolloutId);
}

export function markWritten(db: DB, rolloutId: number, serverId: number, now: string = sqlNow()): void {
  db.prepare(`UPDATE balance_rollout_servers SET state = 'written', written_at = ?, last_error = NULL
    WHERE rollout_id = ? AND server_id = ? AND state IN ('pending', 'failed')`).run(now, rolloutId, serverId);
}

/** True when this is the first failure since the row was last pending or
 *  written, so the caller alerts once rather than on every retry. */
export function markFailed(db: DB, rolloutId: number, serverId: number, error: string): boolean {
  const prev = db.prepare('SELECT state FROM balance_rollout_servers WHERE rollout_id = ? AND server_id = ?')
    .get(rolloutId, serverId) as { state: string } | undefined;
  db.prepare("UPDATE balance_rollout_servers SET state = 'failed', last_error = ? WHERE rollout_id = ? AND server_id = ?")
    .run(error.slice(0, 500), rolloutId, serverId);
  return prev !== undefined && prev.state !== 'failed';
}

/** Back to pending, for a box whose file no longer matches (boot check). */
export function markPending(db: DB, rolloutId: number, serverId: number, reason: string): void {
  db.prepare(`UPDATE balance_rollout_servers SET state = 'pending', last_error = ?, written_at = NULL, confirmed_at = NULL
    WHERE rollout_id = ? AND server_id = ?`).run(reason, rolloutId, serverId);
}

/** The patch a sighting from this server is expected to carry, so the
 *  "config changed" alert stays quiet for the change the panel made. */
export function expectedPatchFor(db: DB, serverId: number): number | null {
  const r = db.prepare(`SELECT ro.patch_id FROM balance_rollouts ro
    JOIN balance_rollout_servers rs ON rs.rollout_id = ro.id AND rs.server_id = ?
    WHERE ro.superseded_at IS NULL ORDER BY ro.id DESC LIMIT 1`).get(serverId) as { patch_id: number } | undefined;
  return r?.patch_id ?? null;
}

/** Whether a patch's recorded inventory carries every value this rollout
 *  wrote. The knob keys are the only ones the rollout sets: a watch list that
 *  grew, or a release that changed a plugin in the same between-match gap,
 *  gives the sighting a fingerprint the prediction never had, and neither
 *  says anything about whether pug_balance.cfg landed. */
export function knobValuesMatch(db: DB, ro: Pick<RolloutRow, 'patch_id' | 'values_json'>, patchId: number): boolean {
  if (patchId === ro.patch_id) return true;
  const values = JSON.parse(ro.values_json) as Record<string, string>;
  const keys = Object.keys(values);
  if (keys.length === 0) return false;
  const r = db.prepare('SELECT inputs_json FROM balance_patches WHERE id = ?').get(patchId) as { inputs_json: string | null } | undefined;
  if (!r?.inputs_json) return false;
  const inv = JSON.parse(r.inputs_json) as Inventory;
  return keys.every((k) => inv[`c:${k}`] === values[k]);
}

/** A BALANCE sighting from this server: confirm the active rollout's row when
 *  the file is written and the sighting carries the rollout's knob values;
 *  always remember what was seen after the write, for "expected X, saw Y".
 *
 *  Only a queue match counts. Those always run the pinned PUG config the
 *  rollout predicted from (see baseInventory); an in-game match may be a 2v2
 *  or a casual config, which would read as a box that lost its values. */
export function confirmOnSighting(db: DB, s: { serverId: number; matchId: number; patchId: number; now?: string }): void {
  const now = s.now ?? sqlNow();
  const m = db.prepare('SELECT origin FROM matches WHERE id = ?').get(s.matchId) as { origin: string | null } | undefined;
  if (m?.origin !== 'queue') return;
  const ro = activeRollout(db);
  if (!ro) return;
  const row = db.prepare('SELECT state FROM balance_rollout_servers WHERE rollout_id = ? AND server_id = ?')
    .get(ro.id, s.serverId) as { state: string } | undefined;
  if (!row || (row.state !== 'written' && row.state !== 'confirmed')) return;
  db.prepare('UPDATE balance_rollout_servers SET seen_patch_id = ?, seen_at = ? WHERE rollout_id = ? AND server_id = ?')
    .run(s.patchId, now, ro.id, s.serverId);
  if (row.state === 'written' && knobValuesMatch(db, ro, s.patchId)) {
    db.prepare("UPDATE balance_rollout_servers SET state = 'confirmed', confirmed_at = ? WHERE rollout_id = ? AND server_id = ?")
      .run(now, ro.id, s.serverId);
  }
}

export interface RolloutServer {
  serverId: number; name: string; state: 'pending' | 'written' | 'confirmed' | 'failed';
  lastError: string | null; writtenAt: string | null; confirmedAt: string | null;
  seen: { patchId: number; number: number; at: string } | null;
  /** What the last sighting differed in, when it was not the expected patch. */
  mismatch: string | null;
}
export interface RolloutSummary {
  id: number; patchId: number; patchNumber: number; patchName: string | null; values: Record<string, string>;
  createdBy: string; createdByName: string | null; createdAt: string; supersededAt: string | null; servers: RolloutServer[];
}

export function listRollouts(db: DB, knobs: BalanceKnobs, limit = 20): RolloutSummary[] {
  const rows = db.prepare(`SELECT ro.*, p.name AS patch_name, pl.name AS admin_name FROM balance_rollouts ro
    JOIN balance_patches p ON p.id = ro.patch_id LEFT JOIN players pl ON pl.steamid = ro.created_by
    ORDER BY ro.id DESC LIMIT ?`).all(limit) as (RolloutRow & { patch_name: string | null; admin_name: string | null })[];
  const inputsOf = (id: number): Inventory | null => {
    const r = db.prepare('SELECT inputs_json FROM balance_patches WHERE id = ?').get(id) as { inputs_json: string | null } | undefined;
    return r?.inputs_json ? (JSON.parse(r.inputs_json) as Inventory) : null;
  };
  return rows.map((ro) => {
    const servers = db.prepare(`SELECT rs.*, s.name FROM balance_rollout_servers rs JOIN servers s ON s.id = rs.server_id
      WHERE rs.rollout_id = ? ORDER BY s.id`).all(ro.id) as {
        server_id: number; name: string; state: RolloutServer['state']; last_error: string | null; written_at: string | null;
        confirmed_at: string | null; seen_patch_id: number | null; seen_at: string | null }[];
    const expected = inputsOf(ro.patch_id);
    return {
      id: ro.id, patchId: ro.patch_id, patchNumber: patchNumber(db, ro.patch_id), patchName: ro.patch_name,
      values: JSON.parse(ro.values_json) as Record<string, string>, createdBy: ro.created_by, createdByName: ro.admin_name,
      createdAt: ro.created_at, supersededAt: ro.superseded_at,
      servers: servers.map((s) => {
        const seen = s.seen_patch_id !== null && s.seen_at !== null
          ? { patchId: s.seen_patch_id, number: patchNumber(db, s.seen_patch_id), at: s.seen_at } : null;
        const seenInv = seen && seen.patchId !== ro.patch_id ? inputsOf(seen.patchId) : null;
        return {
          serverId: s.server_id, name: s.name, state: s.state, lastError: s.last_error, writtenAt: s.written_at,
          confirmedAt: s.confirmed_at, seen,
          // A sighting that carries the rollout's values is not a mismatch,
          // whatever else (a longer watch list, a release) changed with it.
          mismatch: seen && !knobValuesMatch(db, ro, seen.patchId)
            ? (expected && seenInv ? diffIgnoringVersionless(expected, seenInv, knobs.versionless) : 'a different patch')
            : null,
        };
      }),
    };
  });
}
