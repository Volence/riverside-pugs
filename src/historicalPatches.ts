import type { DB } from './db.js';

/** Balance-relevant changes before rounds carried a fingerprint, reconstructed
 *  from the deploy repo log and the ops notes. Approximate by definition: the
 *  admin page badges every one of these. The owner confirmed the list
 *  2026-09-23 ("we were all over"). */
export const HISTORICAL_PATCHES: { name: string; from: string; notes: string }[] = [
  { name: 'Baseline', from: '2000-01-01 00:00:00', notes: 'Everything before the first recorded change.' },
  { name: 'Anti-bait horde and stumble door', from: '2026-09-12 00:00:00',
    notes: 'Stall horde re-enabled (delay 15, timer 30); l4d_tank_stumble_door 1.1 replaced the door-break plugin. Time of day unknown.' },
  { name: 'Map fixes', from: '2026-09-20 09:44:00',
    notes: 'Bedlam and City 17 map 4 stripper fixes. Map-specific.' },
  { name: 'Sky pounce fix', from: '2026-09-21 20:10:00', notes: 'l4d_skypounce 0.4.0 on all four servers.' },
  { name: 'Saferoom lock', from: '2026-09-22 21:36:00', notes: 'l4d_saferoom_lock 1.2 on all four servers (Dallas last).' },
];

export function applyHistoricalPatches(db: DB, opts: { dryRun?: boolean } = {}): { created: number; tagged: number } {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM balance_patches WHERE source = 'historical'").get() as { n: number };
  if (existing.n > 0) return { created: 0, tagged: 0 };

  // Stop where fingerprints take over: nothing at or after the first detected
  // sighting is guessed at.
  const firstDetected = (db.prepare(
    "SELECT MIN(first_seen_at) AS t FROM balance_patches WHERE source != 'historical'",
  ).get() as { t: string | null }).t;

  const run = () => {
    let tagged = 0;
    HISTORICAL_PATCHES.forEach((p, i) => {
      const id = Number(db.prepare(
        "INSERT INTO balance_patches (fingerprint, name, notes, source, inputs_json, first_seen_at, triage) VALUES (NULL, ?, ?, 'historical', NULL, ?, 'balance')",
      ).run(p.name, p.notes, p.from).lastInsertRowid);
      const to = HISTORICAL_PATCHES[i + 1]?.from ?? '9999-12-31 00:00:00';
      const end = firstDetected && firstDetected < to ? firstDetected : to;
      tagged += db.prepare(
        'UPDATE match_rounds SET patch_id = ?, sighted_patch_id = ? WHERE patch_id IS NULL AND started_at >= ? AND started_at < ?',
      ).run(id, id, p.from, end).changes;
    });
    return tagged;
  };

  if (opts.dryRun) {
    // Run for real inside a transaction, then throw to roll it all back.
    let tagged = 0;
    try { db.transaction(() => { tagged = run(); throw new Error('dry run'); })(); } catch { /* rolled back */ }
    return { created: HISTORICAL_PATCHES.length, tagged };
  }
  const tagged = db.transaction(run)();
  return { created: HISTORICAL_PATCHES.length, tagged };
}
