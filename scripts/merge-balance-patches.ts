/**
 * Fold duplicate detected balance patches into one.
 *
 *   npx tsx scripts/merge-balance-patches.ts <db> <keepId> <dropId,dropId,...> [--apply]
 *
 * Every round, metric context row and per-server sighting of a dropped patch
 * moves to the kept one, every server's current state points at it (with the
 * kept patch's inventory, so the next matching sighting raises no alert), and
 * the dropped patches are deleted. Dry run unless --apply; refuses while a
 * match is live, since a live match can tag rounds mid-merge.
 *
 * Written for 2026-09-24: l4d2_spec_stays_spec coming and going between maps,
 * and a comment-only difference in server_custom_convars.cfg, split one config
 * into patches 6, 7, 8 and 9.
 */
import Database from 'better-sqlite3';

const [dbPath, keepArg, dropArg, flag] = process.argv.slice(2);
if (!dbPath || !keepArg || !dropArg) {
  console.error('usage: merge-balance-patches.ts <db> <keepId> <dropId,...> [--apply]');
  process.exit(2);
}
const keep = Number(keepArg);
const drop = dropArg.split(',').map(Number);
if (!Number.isInteger(keep) || drop.some((d) => !Number.isInteger(d) || d === keep)) {
  console.error('ids must be integers and keepId must not be dropped');
  process.exit(2);
}
const apply = flag === '--apply';
const db = new Database(dbPath);

const live = db.prepare("SELECT COUNT(*) AS n FROM matches WHERE state = 'live'").get() as { n: number };
if (apply && live.n > 0) {
  console.error(`${live.n} match(es) live; run again when none are`);
  process.exit(1);
}

const kept = db.prepare('SELECT id, inputs_json FROM balance_patches WHERE id = ?').get(keep) as
  { id: number; inputs_json: string | null } | undefined;
if (!kept?.inputs_json) throw new Error(`patch ${keep} missing or has no inputs`);
for (const d of drop) {
  if (!db.prepare('SELECT 1 FROM balance_patches WHERE id = ?').get(d)) throw new Error(`patch ${d} does not exist`);
}

const q = drop.map(() => '?').join(',');
const count = (sql: string) => (db.prepare(sql).get(...drop) as { n: number }).n;
console.log(`keep #${keep}, drop ${drop.map((d) => `#${d}`).join(' ')}`);
console.log(`  match_rounds to move:         ${count(`SELECT COUNT(*) n FROM match_rounds WHERE patch_id IN (${q})`)}`);
console.log(`  round_metric_context to move: ${count(`SELECT COUNT(*) n FROM round_metric_context WHERE patch_id IN (${q})`)}`);
console.log(`  server sightings to fold:     ${count(`SELECT COUNT(*) n FROM balance_patch_servers WHERE patch_id IN (${q})`)}`);
console.log(`  server states to repoint:     ${count(`SELECT COUNT(*) n FROM balance_server_state WHERE patch_id IN (${q})`)}`);

const DRY = 'dry run, rolled back';
try {
  db.transaction(() => {
    db.prepare(`UPDATE match_rounds SET patch_id = ? WHERE patch_id IN (${q})`).run(keep, ...drop);
    db.prepare(`UPDATE round_metric_context SET patch_id = ? WHERE patch_id IN (${q})`).run(keep, ...drop);
    db.prepare(`INSERT INTO balance_patch_servers (patch_id, server_id, first_seen_at, last_seen_at)
                SELECT ?, server_id, MIN(first_seen_at), MAX(last_seen_at) FROM balance_patch_servers
                WHERE patch_id IN (${q}) GROUP BY server_id
                ON CONFLICT (patch_id, server_id) DO UPDATE SET
                  first_seen_at = MIN(first_seen_at, excluded.first_seen_at),
                  last_seen_at  = MAX(last_seen_at, excluded.last_seen_at)`).run(keep, ...drop);
    db.prepare(`DELETE FROM balance_patch_servers WHERE patch_id IN (${q})`).run(...drop);
    // Every server, not only those on a dropped patch: the kept inventory is the
    // one they will all report once the cfg is in sync and the plugin ignored.
    db.prepare('UPDATE balance_server_state SET patch_id = ?, inventory_json = ?').run(keep, kept.inputs_json);
    db.prepare(`DELETE FROM balance_patches WHERE id IN (${q})`).run(...drop);
    if (!apply) throw new Error(DRY);
  })();
  console.log('applied');
} catch (err) {
  if ((err as Error).message !== DRY) throw err;
  console.log(DRY);
}
