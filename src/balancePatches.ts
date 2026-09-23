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
  matchId: number; serverId: number | null; half: 1 | 2; inventory: Inventory; versionless: string[]; now?: string;
}): { patchId: number; newPatch: boolean; serverChanged: boolean } {
  // SQLite's datetime('now') format, so it sorts against match_rounds.started_at.
  const now = s.now ?? new Date().toISOString().replace('T', ' ').slice(0, 19);
  const fp = fingerprintOf(s.inventory, s.versionless);
  const invJson = JSON.stringify(Object.fromEntries(Object.entries(s.inventory).sort()));

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
        publishAdminEvent({ kind: 'problem', text: alertText(db, s.serverId, patchId, newPatch, prev, s.inventory) });
      }
    }
    return { patchId, newPatch, serverChanged };
  })();
}

function alertText(db: DB, serverId: number, patchId: number, newPatch: boolean,
  prev: { inventory_json: string } | undefined, inv: Inventory): string {
  const name = serverName(db, serverId);
  const head = newPatch
    ? `Balance config on ${name} is a new patch (#${patchId}, unnamed; name it in Admin > Setup > Patches).`
    : `Balance config on ${name} changed (still patch #${patchId}).`;
  const vsOwn = prev ? ` Changed: ${formatDiff(diffInventories(JSON.parse(prev.inventory_json) as Inventory, inv))}.` : ' First sighting.';
  const others = db.prepare('SELECT server_id, inventory_json FROM balance_server_state WHERE server_id != ?')
    .all(serverId) as { server_id: number; inventory_json: string }[];
  const drift = others
    .map((o) => ({ who: serverName(db, o.server_id), d: diffInventories(JSON.parse(o.inventory_json) as Inventory, inv) }))
    .filter((o) => o.d.added.length + o.d.removed.length + o.d.changed.length > 0)
    .map((o) => ` Now differs from ${o.who}: ${formatDiff(o.d, 5)}.`);
  return head + vsOwn + drift.join('');
}
