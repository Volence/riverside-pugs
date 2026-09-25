import { createHash } from 'node:crypto';
import type { DB } from './db.js';
import { publishAdminEvent } from './adminFeed.js';
import { currentOrdinal } from './liveView.js';
import { foldInto, resolvePatch } from './balanceFold.js';
import { triageInfo, type Lists } from './balanceTriage.js';

type Inventory = Record<string, string>;

/** A plugin key's file name: a plugin loaded from a subfolder
 *  (plugins/optional/) reports as "p:optional/<file>". */
export const pluginFile = (key: string): string => key.slice(2).split('/').pop()!;

/** Whether an inventory key is a plugin on `list` (bare file names), matched
 *  by file name so a plugin in a subfolder is on the list too. */
export function onPluginList(list: string[]): (key: string) => boolean {
  const names = new Set(list);
  return (key) => key.startsWith('p:') && names.has(pluginFile(key));
}

/** Stable 16-hex fingerprint. A versionless plugin contributes its presence
 *  only, so updating pug-match does not start a new balance patch. */
export function fingerprintOf(inv: Inventory, versionless: string[]): string {
  const skip = onPluginList(versionless);
  const lines = Object.keys(inv).sort().map((k) => (skip(k) ? `${k}=present` : `${k}=${inv[k]}`));
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}

/** The inventory without ignored plugins: they never reach the fingerprint,
 *  the stored inventory or the drift alert. */
export function withoutIgnored(inv: Inventory, ignored: string[]): Inventory {
  const skip = onPluginList(ignored);
  return Object.fromEntries(Object.entries(inv).filter(([k]) => !skip(k)));
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

/** Whether a to b only adds or removes watched keys (the watch list changed,
 *  not the game): no key both sides have changed value, apart from a
 *  versionless plugin's build, and every added or removed key is a cvar,
 *  missing-cvar marker, weapon key, file or directory. */
export function watchListOnly(a: Inventory, b: Inventory, versionless: string[]): boolean {
  const skip = onPluginList(versionless);
  const d = diffInventories(a, b);
  const oneSided = [...d.added, ...d.removed];
  // A cvar that vanished (c:x removed, x:x added) or appeared (the reverse) is
  // a real change in the game, not the watch list: same name on both sides.
  const cvarNames = (keys: string[]) => new Set(keys.filter((k) => /^[cx]:/.test(k)).map((k) => k.slice(2)));
  const added = cvarNames(d.added), removed = cvarNames(d.removed);
  if ([...added].some((n) => removed.has(n))) return false;
  return d.changed.every((c) => skip(c.key)) && oneSided.length > 0 && oneSided.every((k) => /^[cxwfd]:/.test(k));
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
  /** The patch a control panel rollout expects on this server: its first
   *  sighting is the change the panel made, so it updates the state without
   *  an alert. */
  expectedPatchId?: number | null;
}): {
  /** The patch whose fingerprint was seen (a rollout's patch is always one). */
  patchId: number;
  /** The patch the round counts for: patchId, or where patchId is folded into. */
  effectivePatchId: number;
  newPatch: boolean; serverChanged: boolean;
  /** The patch this server reported before this sighting (null on its first). */
  previousPatchId: number | null;
} {
  const inventory = withoutIgnored(s.inventory, s.ignored ?? []);
  // SQLite's datetime('now') format, so it sorts against match_rounds.started_at.
  const now = s.now ?? new Date().toISOString().replace('T', ' ').slice(0, 19);
  const fp = fingerprintOf(inventory, s.versionless);
  const invJson = JSON.stringify(Object.fromEntries(Object.entries(inventory).sort()));

  return db.transaction(() => {
    const prev = s.serverId === null ? undefined
      : db.prepare('SELECT patch_id, inventory_json FROM balance_server_state WHERE server_id = ?')
        .get(s.serverId) as { patch_id: number; inventory_json: string } | undefined;
    let newPatch = false;
    let row = db.prepare('SELECT id FROM balance_patches WHERE fingerprint = ?').get(fp) as { id: number } | undefined;
    if (!row) {
      // Every new detected config waits for an admin's triage; it remembers
      // the patch this server was on, the default it is judged against.
      const id = Number(db.prepare(
        "INSERT INTO balance_patches (fingerprint, source, inputs_json, first_seen_at, triage, came_from_patch_id) VALUES (?, 'detected', ?, ?, 'pending', ?)",
      ).run(fp, invJson, now, prev ? resolvePatch(db, prev.patch_id) : null).lastInsertRowid);
      row = { id };
      newPatch = true;
    }
    const patchId = row.id;
    // Watching one more value (or one fewer) changes the fingerprint without
    // anything in the game changing: never asks for triage and never alerts.
    let watchOnly = false;
    if (prev) {
      let before: Inventory | null = null;
      try { before = withoutIgnored(JSON.parse(prev.inventory_json) as Inventory, s.ignored ?? []); } catch { before = null; }
      watchOnly = before !== null && watchListOnly(before, inventory, s.versionless);
      if (watchOnly && newPatch) {
        const target = resolvePatch(db, prev.patch_id);
        if (target !== patchId) foldInto(db, patchId, target);
      }
    }
    // A folded patch's rounds count for the patch it was folded into.
    const effectivePatchId = resolvePatch(db, patchId);

    db.prepare('UPDATE match_rounds SET patch_id = ?, sighted_patch_id = ? WHERE match_id = ? AND ordinal = ? AND half = ?')
      .run(effectivePatchId, patchId, s.matchId, currentOrdinal(db, s.matchId), s.half);

    let serverChanged = false;
    if (s.serverId !== null) {
      db.prepare(`INSERT INTO balance_patch_servers (patch_id, server_id, first_seen_at, last_seen_at)
                  VALUES (?, ?, ?, ?)
                  ON CONFLICT (patch_id, server_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`)
        .run(patchId, s.serverId, now, now);
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
        if (!watchOnly && (s.expectedPatchId == null || patchId !== s.expectedPatchId)) {
          // Same time-ordered number the admin page shows (see listPatches), not
          // the raw row id: a historical patch inserted later would otherwise
          // make the alert and the page disagree about which patch "#N" is.
          const patchNumber = (db.prepare(`
            SELECT number FROM (
              SELECT id, ROW_NUMBER() OVER (ORDER BY first_seen_at, id) AS number FROM balance_patches
            ) WHERE id = ?`).get(patchId) as { number: number }).number;
          const pending = (db.prepare('SELECT triage FROM balance_patches WHERE id = ?').get(patchId) as { triage: string | null }).triage === 'pending';
          publishAdminEvent({
            kind: 'problem', text: alertText(db, s.serverId, patchNumber, newPatch, pending, prev, inventory),
            ...(pending ? { link: { label: 'Triage it', path: '/admin/balance/patches' } } : {}),
          });
        }
      }
    }
    return { patchId, effectivePatchId, newPatch, serverChanged, previousPatchId: prev?.patch_id ?? null };
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
 *  or more patches now hash the same, the oldest balance patch (else the
 *  oldest; first_seen_at, then id) keeps the fingerprint and the others are
 *  set to NULL and folded into it: their rounds count for the keeper and new
 *  sightings go to it. If the new fingerprint is already held by a patch
 *  this step does not recompute (an announced patch, say), that holder keeps
 *  it and every recomputed patch landing on it is folded into it. One admin
 *  'problem' event lists all the merges. A NULLed patch is skipped on the
 *  next run, so running this again with the same lists changes nothing and
 *  posts nothing. Merged patches from before triage (triage NULL) are folded
 *  into the holder of their fingerprint here, or become balance.
 *
 *  Also run when an admin adds or removes a plugin on the site ignore list.
 *
 *  Called from buildServer right after balance/knobs.json loads (that is
 *  where the lists are known; openDb has no knobs). */
export function refingerprintPatches(db: DB, versionless: string[], ignored: string[],
  publish: (e: { kind: 'problem'; text: string }) => void = publishAdminEvent,
): { updated: number; merged: { keep: number; into: number[] }[] } {
  return db.transaction(() => {
    const rows = db.prepare(`SELECT id, fingerprint, inputs_json, first_seen_at, triage FROM balance_patches
      WHERE source = 'detected' AND inputs_json IS NOT NULL AND fingerprint IS NOT NULL
      ORDER BY first_seen_at, id`).all() as { id: number; fingerprint: string; inputs_json: string; first_seen_at: string; triage: string | null }[];
    const mine = new Set(rows.map((r) => r.id));
    const triageOf = new Map(rows.map((r) => [r.id, r.triage ?? 'balance']));
    const rolloutPatch = (db.prepare('SELECT patch_id FROM balance_rollouts WHERE superseded_at IS NULL ORDER BY id DESC LIMIT 1')
      .get() as { patch_id: number } | undefined)?.patch_id;
    const published = new Set((db.prepare('SELECT id FROM balance_patches WHERE published_at IS NOT NULL').all() as { id: number }[]).map((r) => r.id));
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
      // Who keeps the fingerprint, in order: a holder this step does not
      // recompute; the knob panel's active rollout patch (its confirmation
      // waits for that fingerprint); a published patch (folding would take it
      // off the public page); a balance patch over an older pending or folded
      // one, so ignoring a plugin in triage never folds the balance patch into
      // the one being triaged; else the oldest.
      const keep = holder && !mine.has(holder.id) ? holder.id
        : ids.find((id) => id === rolloutPatch)
          ?? ids.find((id) => published.has(id))
          ?? ids.find((id) => triageOf.get(id) === 'balance')
          ?? ids[0];
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
    // A merge is a fold: the merged patch's rounds now count for the keeper.
    for (const m of merged) {
      for (const id of m.into) {
        if (resolvePatch(db, m.keep) === id) continue; // the keeper is already folded into it: one patch already
        foldInto(db, id, m.keep);
      }
    }
    // Merged patches from before triage existed (the openDb backfill leaves
    // them NULL): fold each into whoever holds its fingerprint now, else call
    // it balance, as it was treated before.
    const leftovers = db.prepare(`SELECT id, inputs_json FROM balance_patches
      WHERE source = 'detected' AND fingerprint IS NULL AND triage IS NULL AND inputs_json IS NOT NULL`)
      .all() as { id: number; inputs_json: string }[];
    for (const l of leftovers) {
      let holder: { id: number } | undefined;
      try {
        holder = holderOf.get(fingerprintOf(withoutIgnored(JSON.parse(l.inputs_json) as Inventory, ignored), versionless)) as { id: number } | undefined;
      } catch {
        holder = undefined;
      }
      if (holder && resolvePatch(db, holder.id) !== l.id) foldInto(db, l.id, holder.id);
    }
    db.prepare("UPDATE balance_patches SET triage = 'balance' WHERE source = 'detected' AND fingerprint IS NULL AND triage IS NULL").run();
    if (merged.length > 0) {
      const num = patchNumbers(db);
      const tag = (id: number) => `#${num.get(id)} (id ${id})`;
      const text = 'Balance patches merged after the versionless/ignored plugin lists changed: '
        + merged.map((m) => `${m.into.map(tag).join(', ')} into ${tag(m.keep)}`).join('; ')
        + '. The merged patches are folded into the patch they were merged into: their rounds now count for it.';
      console.warn(`[balance] ${text}`);
      publish({ kind: 'problem', text });
    }
    return { updated: changed.filter(([, fp]) => fp !== null).length, merged };
  })();
}

export type PatchSource = 'announced' | 'detected' | 'historical';
export type TriageState = 'pending' | 'balance' | 'folded';
export interface PatchSummary {
  id: number; number: number; name: string | null; notes: string; source: PatchSource;
  firstSeenAt: string; reviewed: boolean;
  /** Every round tagged with this patch, live, voided and unfinished included. */
  rounds: number;
  /** Rounds the balance comparison actually uses: computed rounds of
   *  completed, non-voided matches (the compare filter). */
  countedRounds: number;
  /** Folded (by triage or by the refingerprint merging it): its rounds count
   *  for `foldedInto`. Kept for older web builds; same as triage === 'folded'. */
  merged: boolean;
  triage: TriageState;
  foldedInto: number | null;
  /** Pending or folded: the patch it is judged against (the default fold
   *  target) or folded into, the differences in plain words, the plugins
   *  among them, and whether plugins are all that differ. Empty for a
   *  balance patch. */
  triageBase: { id: number; number: number; name: string | null } | null;
  changes: string[];
  plugins: string[];
  onlyPluginsChanged: boolean;
  /** The release that produced this config, when one did. */
  releaseId: number | null;
  servers: { serverId: number; name: string; lastSeenAt: string }[];
  /** When the patch was put on the public page; null when it is not public. */
  publishedAt: string | null;
}

/** Every known patch, numbered in time order (ROW_NUMBER over first_seen_at,
 *  id) so a historical patch inserted after the fact still slots into its
 *  place rather than getting the highest number. */
export function listPatches(db: DB, lists: Lists = { versionless: [], ignored: [] }): PatchSummary[] {
  const rows = db.prepare(`
    SELECT p.id, p.name, p.notes, p.source, p.first_seen_at, p.reviewed, p.published_at,
           COALESCE(p.triage, 'balance') AS triage, p.folded_into, p.release_id,
           ROW_NUMBER() OVER (ORDER BY p.first_seen_at, p.id) AS number,
           (SELECT COUNT(*) FROM match_rounds r WHERE r.patch_id = p.id) AS rounds,
           (SELECT COUNT(*) FROM round_metric_context c JOIN matches m ON m.id = c.match_id
             WHERE c.patch_id = p.id AND m.state = 'completed' AND m.voided_at IS NULL) AS counted_rounds
    FROM balance_patches p ORDER BY number`).all() as {
      id: number; name: string | null; notes: string; source: PatchSource; first_seen_at: string;
      reviewed: number; published_at: string | null; triage: TriageState; folded_into: number | null; release_id: number | null;
      number: number; rounds: number; counted_rounds: number }[];
  const servers = db.prepare(`SELECT bps.patch_id, bps.server_id, s.name, bps.last_seen_at
    FROM balance_patch_servers bps JOIN servers s ON s.id = bps.server_id`).all() as {
      patch_id: number; server_id: number; name: string; last_seen_at: string }[];
  return rows.map((r) => {
    const info = r.triage === 'balance' ? null : triageInfo(db, r.id, lists);
    return {
      id: r.id, number: r.number, name: r.name, notes: r.notes, source: r.source,
      firstSeenAt: r.first_seen_at, reviewed: r.reviewed === 1, rounds: r.rounds, countedRounds: r.counted_rounds,
      merged: r.triage === 'folded', triage: r.triage, foldedInto: r.folded_into, releaseId: r.release_id,
      triageBase: info?.base ?? null, changes: info?.changes ?? [], plugins: info?.plugins ?? [],
      onlyPluginsChanged: info?.onlyPluginsChanged ?? false,
      servers: servers.filter((s) => s.patch_id === r.id)
        .map((s) => ({ serverId: s.server_id, name: s.name, lastSeenAt: s.last_seen_at })),
      publishedAt: r.published_at,
    };
  });
}

/** One patch, with its raw inputs and a diff against the previous patch that
 *  actually carried inputs (a historical patch may have none). */
export function patchDetail(db: DB, id: number, lists?: Lists): (PatchSummary & {
  inputs: Record<string, string> | null; diffVsPrevious: ReturnType<typeof diffInventories> | null;
}) | null {
  const all = listPatches(db, lists);
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
export function serverDrift(db: DB, ignored: string[] = []): {
  serverId: number; name: string; patchId: number; since: string;
  differsFrom: { name: string; diff: string }[];
}[] {
  const rows = db.prepare(`SELECT st.server_id, s.name, st.patch_id, st.since, st.inventory_json
    FROM balance_server_state st JOIN servers s ON s.id = st.server_id ORDER BY s.id`).all() as {
      server_id: number; name: string; patch_id: number; since: string; inventory_json: string }[];
  // A stored inventory may predate a plugin joining the ignored list.
  const inv = (json: string) => withoutIgnored(JSON.parse(json) as Inventory, ignored);
  return rows.map((r) => ({
    serverId: r.server_id, name: r.name, patchId: r.patch_id, since: r.since,
    differsFrom: rows.filter((o) => o.server_id !== r.server_id)
      .map((o) => ({ name: o.name, d: diffInventories(inv(o.inventory_json), inv(r.inventory_json)) }))
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

function alertText(db: DB, serverId: number, patchNumber: number, newPatch: boolean, pending: boolean,
  prev: { inventory_json: string } | undefined, inv: Inventory): string {
  const name = serverName(db, serverId);
  const head = newPatch
    ? `Balance config on ${name} is a new patch (#${patchNumber}, needs triage).`
    : prev
      ? `Balance config on ${name} changed (still patch #${patchNumber}${pending ? ', needs triage' : ''}).`
      : `Balance config on ${name} seen for the first time (patch #${patchNumber}${pending ? ', needs triage' : ''}).`;
  const vsOwn = prev ? ` Changed: ${formatDiff(diffInventories(JSON.parse(prev.inventory_json) as Inventory, inv))}.` : '';
  // A box that has not played since may simply not have had the change yet,
  // so each drift clause says when that box was last seen.
  const others = db.prepare(`SELECT st.server_id, st.inventory_json,
      (SELECT MAX(ps.last_seen_at) FROM balance_patch_servers ps WHERE ps.server_id = st.server_id) AS last_seen
    FROM balance_server_state st WHERE st.server_id != ?`)
    .all(serverId) as { server_id: number; inventory_json: string; last_seen: string | null }[];
  const drift = others
    .map((o) => ({ who: serverName(db, o.server_id), seen: o.last_seen, d: diffInventories(JSON.parse(o.inventory_json) as Inventory, inv) }))
    .filter((o) => o.d.added.length + o.d.removed.length + o.d.changed.length > 0)
    .map((o) => ` Now differs from ${o.who}${o.seen ? ` (last seen ${o.seen.slice(0, 16)} UTC)` : ''}: ${formatDiff(o.d, 5)}.`);
  return head + vsOwn + drift.join('');
}
