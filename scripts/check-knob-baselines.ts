// Compare every adjustable knob's baseline with the live value on the latest
// queue-match patch in a database (a production snapshot). Read-only.
import Database from 'better-sqlite3';
import { adjustableKnobs, loadBalanceKnobs } from '../src/balanceKnobs.js';
import { baseInventory } from '../src/balanceControl.js';
import type { DB } from '../src/db.js';

const path = process.argv[2];
if (!path) { console.error('usage: check-knob-baselines.ts <db>'); process.exit(2); }
const db = new Database(path, { readonly: true, fileMustExist: true }) as unknown as DB;
const base = baseInventory(db);
if (!base) { console.error('no tagged queue round in this database'); process.exit(2); }
let bad = 0;
for (const k of adjustableKnobs(loadBalanceKnobs())) {
  const live = base.inventory[`c:${k.cvar}`];
  const ok = live === k.baseline;
  if (!ok) bad++;
  console.log(`${ok ? 'OK      ' : 'MISMATCH'} ${k.cvar} baseline=${k.baseline} live=${live ?? '(absent)'}`);
}
console.log(`patch id ${base.patchId}: ${bad === 0 ? 'all baselines match' : `${bad} mismatch(es)`}`);
process.exit(bad === 0 ? 0 : 1);
