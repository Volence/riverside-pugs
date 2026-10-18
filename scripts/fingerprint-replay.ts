// History replay for the evader fingerprint (spec section 5): what every rule
// would have done at every match end on record, as if the setting were 'full'.
// Spec: docs/superpowers/specs/2026-10-17-evader-fingerprints-design.md
//
// NEVER against the live database. Give it a backup copy; it then copies that
// again through SQLite's backup API from a read-only handle, works only on the
// second copy (under $TMPDIR), and deletes it at the end. It refuses the path
// in DB_PATH (or the app's default data/pug.db), a missing file and a flag
// without its value.
//
//   npx tsx scripts/fingerprint-replay.ts --db /path/to/pug-backup.db --required
//   npx tsx scripts/fingerprint-replay.ts --db /path/to/pug-backup.db [--exclude <steamid>]... [--json]
//
// --required runs the two checks the spec needs before the setting goes on:
// indianstreetfood and nepmir, each taken out of the dethisa seed, must come
// out at least as an alert against dethisa. Exit code 1 if either does not.
// The numbers go to the owner before anything is turned on.
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { REPLAY_REQUIRED, SEED_PEOPLE, DETHISA } from '../src/evaderSeed.js';
import {
  REPLAY_LIMITS, caughtAs, copyForReplay, parseReplayArgs, replayHistory, type ReplayArgs, type ReplayReport,
} from '../src/fingerprintReplay.js';

let args: ReplayArgs;
try {
  args = parseReplayArgs(process.argv.slice(2));
} catch (err) {
  console.error((err as Error).message);
  process.exit(2);
}
if (!existsSync(args.db)) {
  console.error(`no such file: ${args.db} (nothing was created)`);
  process.exit(2);
}
// The live file, by DB_PATH or the app's default path, is refused outright.
const real = (p: string): string => (existsSync(p) ? realpathSync(p) : resolve(p));
const live = process.env.DB_PATH ?? 'data/pug.db';
if (real(args.db) === real(live)) {
  console.error(`refusing: ${args.db} is the live database (${live}). Give it a backup copy.`);
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'fp-replay-'));
let failed = false;
try {
  const db = await copyForReplay(args.db, join(dir, 'replay.db'));
  try {
    const byName = (names: readonly string[]) => names.flatMap((n) =>
      (db.prepare('SELECT steamid FROM players WHERE name = ?').all(n) as { steamid: string }[]).map((r) => r.steamid));
    const people = SEED_PEOPLE.map((p) => ({ label: p.label, steam: [...new Set([...p.steam, ...byName(p.steamByName)])] }));
    const asnLoaded = (db.prepare('SELECT COUNT(*) AS n FROM player_networks WHERE asn IS NOT NULL').get() as { n: number }).n > 0;
    const runs = args.required
      ? REPLAY_REQUIRED.map((r) => ({ title: `${r.name} taken out of the ${DETHISA.label} seed`, exclude: [r.steamid], expect: r.steamid as string | null }))
      : [{ title: 'replay', exclude: args.exclude, expect: null as string | null }];

    for (const run of runs) {
      const r = replayHistory(db, { people, exclude: new Set(run.exclude), asnLoaded });
      print(run.title, r, asnLoaded);
      if (run.expect) {
        const caught = caughtAs(r, run.expect, DETHISA.label);
        if (caught) {
          console.log(`PASS: caught as a ${DETHISA.label} ${caught.level} at match ${caught.matchId}`);
        } else {
          const other = r.excluded.find((e) => e.steamid === run.expect);
          console.log(`FAIL: never alerted as ${DETHISA.label}${other?.level ? ` (fired against another person at match ${other.matchId})` : ''}`);
          failed = true;
        }
      }
    }
  } finally {
    db.close();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;

function print(title: string, r: ReplayReport, asnLoaded: boolean): void {
  if (args.json) {
    console.log(JSON.stringify({ title, limits: REPLAY_LIMITS, ...r }, null, 2));
    return;
  }
  console.log(`\n== ${title} ==`);
  console.log(`${r.matches} match ends, ${r.candidateChecks} candidate checks, ${(r.ms / 1000).toFixed(1)} s`
    + (asnLoaded ? '' : ' (no ASN data in this copy: the VPN sign never counts)'));
  console.log(`honest top-5 rate on first check: ${r.honestTop5Rate === null ? 'n/a' : `${(r.honestTop5Rate * 100).toFixed(1)}%`} (spec baseline 3%)`);
  const holds = r.events.filter((e) => e.level === 'hold');
  console.log(`holds from sign 2 (fresh identity) ALONE: ${r.freshOnlyHolds} of ${holds.length} `
    + `(honest: ${r.honestFreshOnlyHolds} of ${holds.filter((e) => e.honest).length})`);
  console.log('limits:');
  for (const l of REPLAY_LIMITS) console.log(`  - ${l}`);
  console.log('week        alerts holds honest-alerts honest-holds');
  for (const w of r.weeks) {
    console.log(`${w.week}  ${String(w.alerts).padStart(6)} ${String(w.holds).padStart(5)} ${String(w.honestAlerts).padStart(13)} ${String(w.honestHolds).padStart(12)}`);
  }
  for (const e of r.events) {
    console.log(`  match ${e.matchId} ${e.at.slice(0, 10)} ${e.steamid} ${e.level} vs ${e.person}: #${e.rank}, `
      + `${e.distance.toFixed(3)} <= ${e.threshold.toFixed(3)}${e.signs.length ? `, ${e.signs.join(', ')}` : ''}${e.honest ? '' : ' (known)'}`);
  }
}
