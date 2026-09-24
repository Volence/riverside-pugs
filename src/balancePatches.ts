import { createHash } from 'node:crypto';
import type { DB } from './db.js';
import { publishAdminEvent } from './adminFeed.js';
import { currentOrdinal } from './liveView.js';

type Inventory = Record<string, string>;

/** Stable 16-hex fingerprint. A versionless plugin contributes its presence
 *  only, so updating pug-match does not start a new balance patch. */
export function fingerprintOf(inv: Inventory, versionless: string[]): string {
  const skip = new Set(versionless.map((f) => `p:${f}`));
  const lines = Object.keys(inv).sort().map((k) => (skip.has(k) ? `${k}=present` : `${k}=${inv[k]}`));
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}

/** The inventory without ignored plugins: they never reach the fingerprint,
 *  the stored inventory or the drift alert. */
export function withoutIgnored(inv: Inventory, ignored: string[]): Inventory {
  const skip = new Set(ignored.map((f) => `p:${f}`));
  return Object.fromEntries(Object.entries(inv).filter(([k]) => !skip.has(k)));
}

export function diffInventories(a: Inventory, b: Inventory) {
  const added = Object.keys(b).filter((k) => !(k in a)).sort();
  const removed = Object.keys(a).filter((k) => !(k in b)).sort();
  const changed = Object.keys(b).filter((k) => k in a && a[k] !== b[k]).sort()
    .map((key) => ({ key, from: a[key], to: b[key] }));
  return { added, removed, changed };
}

export function formatDiff(d: ReturnType<typeof diffInventories>, max = 10): string {
  const parts = [
    ...d.added.map((k) => `added ${k}`),
    ...d.removed.map((k) => `removed ${k}`),
    ...d.changed.map((c) => `${c.key} ${c.from} -> ${c.to}`),
  ];
  const shown = parts.slice(0, max).join('; ');
  return parts.length > max ? `${shown}; and ${parts.length - max} more` : shown;
}

const serverName = (db: DB, id: number): string =>
  (db.prepare('SELECT name FROM servers WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? `server ${id}`;

/** One go-live's inventory arrived: find or create its patch, tag the round,
 *  and tell admins when this server's inventory changed. */
export function recordBalanceSighting(db: DB, s: {
  matchId: number; serverId: number | null; half: 1 | 2; inventory: Inventory; versionless: string[];
  ignored?: string[]; now?: string;
}): { patchId: number; newPatch: boolean; serverChanged: boolean } {
  const inventory = withoutIgnored(s.inventory, s.ignored ?? []);
  // SQLite's datetime('now') format, so it sorts against match_rounds.started_at.
  const now = s.now ?? new Date().toISOString().replace('T', ' ').slice(0, 19);
  const fp = fingerprintOf(inventory, s.versionless);
  const invJson = JSON.stringify(Object.fromEntries(Object.entries(inventory).sort()));

  return db.transaction(() => {
    let newPatch = false;
    let row = db.prepare('SELECT id FROM balance_patches WHERE fingerprint = ?').get(fp) as { id: number } | undefined;
    if (!row) {
      const id = Number(db.prepare(
        "INSERT INTO balance_patches (fingerprint, source, inputs_json, first_seen_at) VALUES (?, 'detected', ?, ?)",
      ).run(fp, invJson, now).lastInsertRowid);
      row = { id };
      newPatch = true;
    }
    const patchId = row.id;

    db.prepare('UPDATE match_rounds SET patch_id = ? WHERE match_id = ? AND ordinal = ? AND half = ?')
      .run(patchId, s.matchId, currentOrdinal(db, s.matchId), s.half);

    let serverChanged = false;
    if (s.serverId !== null) {
      db.prepare(`INSERT INTO balance_patch_servers (patch_id, server_id, first_seen_at, last_seen_at)
                  VALUES (?, ?, ?, ?)
                  ON CONFLICT (patch_id, server_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`)
        .run(patchId, s.serverId, now, now);
      const prev = db.prepare('SELECT patch_id, inventory_json FROM balance_server_state WHERE server_id = ?')
        .get(s.serverId) as { patch_id: number; inventory_json: string } | undefined;
      if (!prev || prev.inventory_json !== invJson) {
        serverChanged = true;
        db.prepare(`INSERT INTO balance_server_state (server_id, patch_id, inventory_json, since) VALUES (?, ?, ?, ?)
                    ON CONFLICT (server_id) DO UPDATE SET patch_id = excluded.patch_id,
                      inventory_json = excluded.inventory_json, since = excluded.since`)
          .run(s.serverId, patchId, invJson, now);
        // Same time-ordered number the admin page shows (see listPatches), not
        // the raw row id: a historical patch inserted later would otherwise
        // make the alert and the page disagree about which patch "#N" is.
        const patchNumber = (db.prepare(`
          SELECT number FROM (
            SELECT id, ROW_NUMBER() OVER (ORDER BY first_seen_at, id) AS number FROM balance_patches
          ) WHERE id = ?`).get(patchId) as { number: number }).number;
        publishAdminEvent({ kind: 'problem', text: alertText(db, s.serverId, patchNumber, newPatch, prev, inventory) });
      }
    }
    return { patchId, newPatch, serverChanged };
  })();
}

export type PatchSource = 'announced' | 'detected' | 'historical';
export interface PatchSummary {
  id: number; number: number; name: string | null; notes: string; source: PatchSource;
  firstSeenAt: string; reviewed: boolean; rounds: number;
  servers: { serverId: number; name: string; lastSeenAt: string }[];
}

/** Every known patch, numbered in time order (ROW_NUMBER over first_seen_at,
 *  id) so a historical patch inserted after the fact still slots into its
 *  place rather than getting the highest number. */
export function listPatches(db: DB): PatchSummary[] {
  const rows = db.prepare(`
    SELECT p.id, p.name, p.notes, p.source, p.first_seen_at, p.reviewed,
           ROW_NUMBER() OVER (ORDER BY p.first_seen_at, p.id) AS number,
           (SELECT COUNT(*) FROM match_rounds r WHERE r.patch_id = p.id) AS rounds
    FROM balance_patches p ORDER BY number`).all() as {
      id: number; name: string | null; notes: string; source: PatchSource; first_seen_at: string;
      reviewed: number; number: number; rounds: number }[];
  const servers = db.prepare(`SELECT bps.patch_id, bps.server_id, s.name, bps.last_seen_at
    FROM balance_patch_servers bps JOIN servers s ON s.id = bps.server_id`).all() as {
      patch_id: number; server_id: number; name: string; last_seen_at: string }[];
  return rows.map((r) => ({
    id: r.id, number: r.number, name: r.name, notes: r.notes, source: r.source,
    firstSeenAt: r.first_seen_at, reviewed: r.reviewed === 1, rounds: r.rounds,
    servers: servers.filter((s) => s.patch_id === r.id)
      .map((s) => ({ serverId: s.server_id, name: s.name, lastSeenAt: s.last_seen_at })),
  }));
}

/** One patch, with its raw inputs and a diff against the previous patch that
 *  actually carried inputs (a historical patch may have none). */
export function patchDetail(db: DB, id: number): (PatchSummary & {
  inputs: Record<string, string> | null; diffVsPrevious: ReturnType<typeof diffInventories> | null;
}) | null {
  const all = listPatches(db);
  const i = all.findIndex((p) => p.id === id);
  if (i < 0) return null;
  const inputsOf = (pid: number) => {
    const row = db.prepare('SELECT inputs_json FROM balance_patches WHERE id = ?').get(pid) as { inputs_json: string | null };
    return row.inputs_json ? (JSON.parse(row.inputs_json) as Record<string, string>) : null;
  };
  const inputs = inputsOf(id);
  const prevWithInputs = all.slice(0, i).reverse().find((p) => inputsOf(p.id) !== null);
  const prevInputs = prevWithInputs ? inputsOf(prevWithInputs.id) : null;
  return { ...all[i], inputs, diffVsPrevious: inputs && prevInputs ? diffInventories(prevInputs, inputs) : null };
}

/** Every server's current patch and how its live inventory differs from each
 *  other server's, for spotting a box that fell behind or ahead. */
export function serverDrift(db: DB): {
  serverId: number; name: string; patchId: number; since: string;
  differsFrom: { name: string; diff: string }[];
}[] {
  const rows = db.prepare(`SELECT st.server_id, s.name, st.patch_id, st.since, st.inventory_json
    FROM balance_server_state st JOIN servers s ON s.id = st.server_id ORDER BY s.id`).all() as {
      server_id: number; name: string; patch_id: number; since: string; inventory_json: string }[];
  return rows.map((r) => ({
    serverId: r.server_id, name: r.name, patchId: r.patch_id, since: r.since,
    differsFrom: rows.filter((o) => o.server_id !== r.server_id)
      .map((o) => ({ name: o.name, d: diffInventories(JSON.parse(o.inventory_json) as Inventory, JSON.parse(r.inventory_json) as Inventory) }))
      .filter((o) => o.d.added.length + o.d.removed.length + o.d.changed.length > 0)
      .map((o) => ({ name: o.name, diff: formatDiff(o.d) })),
  }));
}

/** Rename, renote or mark a patch reviewed. Returns false if the patch does
 *  not exist. Caller (the admin route) is responsible for logAdmin. */
export function editPatch(db: DB, id: number, p: { name?: string | null; notes?: string; reviewed?: boolean }): boolean {
  const cur = db.prepare('SELECT id FROM balance_patches WHERE id = ?').get(id);
  if (!cur) return false;
  if (p.name !== undefined) db.prepare('UPDATE balance_patches SET name = ? WHERE id = ?').run(p.name, id);
  if (p.notes !== undefined) db.prepare('UPDATE balance_patches SET notes = ? WHERE id = ?').run(p.notes, id);
  if (p.reviewed !== undefined) db.prepare('UPDATE balance_patches SET reviewed = ? WHERE id = ?').run(p.reviewed ? 1 : 0, id);
  return true;
}

function alertText(db: DB, serverId: number, patchNumber: number, newPatch: boolean,
  prev: { inventory_json: string } | undefined, inv: Inventory): string {
  const name = serverName(db, serverId);
  const head = newPatch
    ? `Balance config on ${name} is a new patch (#${patchNumber}, unnamed; name it in Admin > Setup > Patches).`
    : `Balance config on ${name} changed (still patch #${patchNumber}).`;
  const vsOwn = prev ? ` Changed: ${formatDiff(diffInventories(JSON.parse(prev.inventory_json) as Inventory, inv))}.` : ' First sighting.';
  const others = db.prepare('SELECT server_id, inventory_json FROM balance_server_state WHERE server_id != ?')
    .all(serverId) as { server_id: number; inventory_json: string }[];
  const drift = others
    .map((o) => ({ who: serverName(db, o.server_id), d: diffInventories(JSON.parse(o.inventory_json) as Inventory, inv) }))
    .filter((o) => o.d.added.length + o.d.removed.length + o.d.changed.length > 0)
    .map((o) => ` Now differs from ${o.who}: ${formatDiff(o.d, 5)}.`);
  return head + vsOwn + drift.join('');
}
