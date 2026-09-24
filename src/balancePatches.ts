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

/** Whether a stored inventory, read as JSON, equals `invJson` once the
 *  ignored plugins are dropped from it. Unreadable JSON is never equal. */
function sameAfterIgnored(storedJson: string, invJson: string, ignored: string[]): boolean {
  try {
    const inv = withoutIgnored(JSON.parse(storedJson) as Inventory, ignored);
    return JSON.stringify(Object.fromEntries(Object.entries(inv).sort())) === invJson;
  } catch {
    return false;
  }
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
      // The stored inventory may predate a plugin joining the ignored list;
      // compare it the way the fingerprint sees it, so that alone never alerts.
      const prevJson = prev && sameAfterIgnored(prev.inventory_json, invJson, s.ignored ?? []) ? invJson : prev?.inventory_json;
      if (prev && prevJson === invJson && (prev.patch_id !== patchId || prev.inventory_json !== invJson)) {
        // Same inventory, different patch: the boot refingerprint merged the
        // patch this server was on into an older one. Nothing about the box
        // changed, so follow the patch silently rather than alert.
        db.prepare('UPDATE balance_server_state SET patch_id = ?, inventory_json = ? WHERE server_id = ?')
          .run(patchId, invJson, s.serverId);
      }
      if (!prev || prevJson !== invJson) {
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

const patchNumbers = (db: DB): Map<number, number> => new Map((db.prepare(
  'SELECT id, ROW_NUMBER() OVER (ORDER BY first_seen_at, id) AS number FROM balance_patches',
).all() as { id: number; number: number }[]).map((r) => [r.id, r.number]));

/** Boot step: recompute every detected patch's fingerprint under the current
 *  versionless and ignored plugin lists, so a knobs.json change to either
 *  list takes effect on patches already in the database, not only on new
 *  sightings (otherwise the next sighting of an unchanged box would hash
 *  differently and open a spurious new patch).
 *
 *  Only detected patches that still hold a fingerprint and have inputs are
 *  recomputed. A fingerprint that stays unique is updated in place. When two
 *  or more patches now hash the same, the oldest (first_seen_at, then id)
 *  keeps the fingerprint and the others are set to NULL: they keep their
 *  already-tagged rounds and their history, but new sightings go to the
 *  keeper. If the new fingerprint is already held by a patch this step does
 *  not recompute (an announced patch, say), that holder keeps it and every
 *  recomputed patch landing on it is merged into it. One admin 'problem'
 *  event lists all the merges. A NULLed patch is skipped on the next run, so
 *  running this again with the same lists changes nothing and posts nothing.
 *
 *  Called from buildServer right after balance/knobs.json loads (that is
 *  where the lists are known; openDb has no knobs). */
export function refingerprintPatches(db: DB, versionless: string[], ignored: string[],
  publish: (e: { kind: 'problem'; text: string }) => void = publishAdminEvent,
): { updated: number; merged: { keep: number; into: number[] }[] } {
  return db.transaction(() => {
    const rows = db.prepare(`SELECT id, fingerprint, inputs_json, first_seen_at FROM balance_patches
      WHERE source = 'detected' AND inputs_json IS NOT NULL AND fingerprint IS NOT NULL
      ORDER BY first_seen_at, id`).all() as { id: number; fingerprint: string; inputs_json: string; first_seen_at: string }[];
    const mine = new Set(rows.map((r) => r.id));
    const groups = new Map<string, number[]>();
    for (const r of rows) {
      let fp: string;
      try {
        fp = fingerprintOf(withoutIgnored(JSON.parse(r.inputs_json) as Inventory, ignored), versionless);
      } catch {
        continue; // unreadable inputs: leave the patch exactly as it is
      }
      const g = groups.get(fp) ?? [];
      g.push(r.id);
      groups.set(fp, g);
    }
    const current = new Map(rows.map((r) => [r.id, r.fingerprint]));
    const holderOf = db.prepare('SELECT id FROM balance_patches WHERE fingerprint = ?');
    const want = new Map<number, string | null>();
    const merged: { keep: number; into: number[] }[] = [];
    for (const [fp, ids] of groups) {
      const holder = holderOf.get(fp) as { id: number } | undefined;
      const keep = holder && !mine.has(holder.id) ? holder.id : ids[0];
      for (const id of ids) want.set(id, id === keep ? fp : null);
      const others = ids.filter((id) => id !== keep);
      if (others.length > 0) merged.push({ keep, into: others });
    }
    const changed = [...want].filter(([id, fp]) => current.get(id) !== fp);
    // Clear first, then set, so a fingerprint moving from one row to another
    // never trips the UNIQUE constraint halfway through.
    const setFp = db.prepare('UPDATE balance_patches SET fingerprint = ? WHERE id = ?');
    for (const [id] of changed) setFp.run(null, id);
    for (const [id, fp] of changed) if (fp !== null) setFp.run(fp, id);
    if (merged.length > 0) {
      const num = patchNumbers(db);
      const tag = (id: number) => `#${num.get(id)} (id ${id})`;
      const text = 'Balance patches merged after the versionless/ignored plugin lists changed: '
        + merged.map((m) => `${m.into.map(tag).join(', ')} into ${tag(m.keep)}`).join('; ')
        + '. The merged patches keep the rounds already tagged with them; new rounds go to the patch they were merged into.';
      console.warn(`[balance] ${text}`);
      publish({ kind: 'problem', text });
    }
    return { updated: changed.filter(([, fp]) => fp !== null).length, merged };
  })();
}

export type PatchSource = 'announced' | 'detected' | 'historical';
export interface PatchSummary {
  id: number; number: number; name: string | null; notes: string; source: PatchSource;
  firstSeenAt: string; reviewed: boolean;
  /** Every round tagged with this patch, live, voided and unfinished included. */
  rounds: number;
  /** Rounds the balance comparison actually uses: computed rounds of
   *  completed, non-voided matches (the compare filter). */
  countedRounds: number;
  /** A detected patch the boot refingerprint merged into another (its
   *  fingerprint was cleared): it keeps the rounds already tagged with it, but
   *  new sightings of its config go to the patch it was merged into. */
  merged: boolean;
  servers: { serverId: number; name: string; lastSeenAt: string }[];
}

/** Every known patch, numbered in time order (ROW_NUMBER over first_seen_at,
 *  id) so a historical patch inserted after the fact still slots into its
 *  place rather than getting the highest number. */
export function listPatches(db: DB): PatchSummary[] {
  const rows = db.prepare(`
    SELECT p.id, p.name, p.notes, p.source, p.first_seen_at, p.reviewed,
           (p.source = 'detected' AND p.fingerprint IS NULL) AS merged,
           ROW_NUMBER() OVER (ORDER BY p.first_seen_at, p.id) AS number,
           (SELECT COUNT(*) FROM match_rounds r WHERE r.patch_id = p.id) AS rounds,
           (SELECT COUNT(*) FROM round_metric_context c JOIN matches m ON m.id = c.match_id
             WHERE c.patch_id = p.id AND m.state = 'completed' AND m.voided_at IS NULL) AS counted_rounds
    FROM balance_patches p ORDER BY number`).all() as {
      id: number; name: string | null; notes: string; source: PatchSource; first_seen_at: string;
      reviewed: number; merged: number; number: number; rounds: number; counted_rounds: number }[];
  const servers = db.prepare(`SELECT bps.patch_id, bps.server_id, s.name, bps.last_seen_at
    FROM balance_patch_servers bps JOIN servers s ON s.id = bps.server_id`).all() as {
      patch_id: number; server_id: number; name: string; last_seen_at: string }[];
  return rows.map((r) => ({
    id: r.id, number: r.number, name: r.name, notes: r.notes, source: r.source,
    firstSeenAt: r.first_seen_at, reviewed: r.reviewed === 1, rounds: r.rounds, countedRounds: r.counted_rounds,
    merged: r.merged === 1,
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
    ? `Balance config on ${name} is a new patch (#${patchNumber}, unnamed; name it in Admin > Balance > Patches).`
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
