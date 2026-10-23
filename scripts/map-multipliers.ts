/**
 * Per-map score multipliers for the next season, from the saferoom rate of
 * the season that just ended (rules in src/mapMultipliers.ts). Read-only, on
 * a COPY of the production database:
 *
 *   npx tsx scripts/map-multipliers.ts /tmp/pug-copy.db --season 1 \
 *     --missions ../deploy/overrides/left4dead/addons/l4d1_mission_nav.vpk \
 *     --name "Season 1" [--out balance/map-multipliers.json]
 *
 * --season is the id of the season that ENDED (its rounds set the numbers).
 * --missions is the mission VPK the servers load today, or a folder of
 * mission .txt files; it gives each campaign's chapters and current numbers.
 * Optional: --min-matches 50 --min 0.75 --max 1.75 --step 0.05.
 *
 * Prints the table; --out also writes the JSON the site serves. The servers
 * get the numbers from the deploy repo (tools/season-multipliers), fed the
 * same JSON.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import {
  computeMultipliers, foldMirrors, SEASON_MULTIPLIER_RULES, SEASON_RATES_SQL, versusLadder,
  type LadderMap, type MapRate, type MultiplierRules, type SeasonMultiplierTable,
} from '../src/mapMultipliers.js';
import { openVpk } from '../src/vpk.js';

/** Every versus chapter in a mission VPK or a folder of mission files. */
export function readLadder(path: string): LadderMap[] {
  const texts: string[] = [];
  if (statSync(path).isDirectory()) {
    for (const n of readdirSync(path).sort()) {
      if (n.toLowerCase().endsWith('.txt')) texts.push(readFileSync(join(path, n), 'latin1'));
    }
  } else {
    const vpk = openVpk(path);
    if (!vpk) throw new Error(`${path} is not a VPK`);
    for (const e of vpk.entries) {
      if (/^missions\/[^/]+\.txt$/i.test(e.path)) texts.push(vpk.read(e).toString('latin1'));
    }
  }
  return texts.flatMap(versusLadder);
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const pct = (x: number | null) => (x === null ? '   n/a' : `${(x * 100).toFixed(1).padStart(5)}%`);

function main(): void {
  const argv = process.argv.slice(2);
  const dbPath = argv[0];
  const season = Number(arg(argv, '--season'));
  const missions = arg(argv, '--missions');
  if (!dbPath || dbPath.startsWith('--') || !Number.isInteger(season) || !missions) {
    console.error('usage: map-multipliers.ts <db> --season <ended season id> --missions <vpk|dir> [--name "Season N"] [--out file.json]');
    process.exit(2);
  }
  const num = (name: string, dflt: number) => (arg(argv, name) === undefined ? dflt : Number(arg(argv, name)));
  const rules: MultiplierRules = {
    minMatches: num('--min-matches', SEASON_MULTIPLIER_RULES.minMatches),
    min: num('--min', SEASON_MULTIPLIER_RULES.min),
    max: num('--max', SEASON_MULTIPLIER_RULES.max),
    step: num('--step', SEASON_MULTIPLIER_RULES.step),
  };

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const seasonRow = db.prepare('SELECT name FROM seasons WHERE id = ?').get(season) as { name: string } | undefined;
  if (!seasonRow) throw new Error(`no season ${season}`);
  const rates = db.prepare(SEASON_RATES_SQL).all(season) as MapRate[];
  db.close();

  const ladder = readLadder(missions);
  const known = new Set(ladder.map((l) => l.map.toLowerCase()));
  const rows = computeMultipliers(ladder, foldMirrors(rates, known), rules);

  let mission = '';
  console.log(`map multipliers from ${seasonRow.name} (rules ${JSON.stringify(rules)})`);
  console.log('map                              before  after   exact  saferoom  rounds  matches');
  for (const r of rows) {
    if (r.mission !== mission) {
      mission = r.mission;
      const group = rows.filter((g) => g.mission === mission);
      const sum = (k: 'before' | 'after') => group.reduce((a, g) => a + g[k], 0).toFixed(2);
      console.log(`-- ${mission} (sum ${sum('before')} -> ${sum('after')})`);
    }
    console.log(
      `${r.map.padEnd(32)} ${r.before.toFixed(2).padStart(6)} ${r.after.toFixed(2).padStart(6)} `
      + `${r.exact === null ? '      -' : r.exact.toFixed(3).padStart(7)}   ${pct(r.saferoomRate)} `
      + `${String(r.rounds).padStart(7)} ${String(r.matches).padStart(8)}${r.recalculated ? '' : '  (kept)'}`,
    );
  }

  const out = arg(argv, '--out');
  if (out) {
    const table: SeasonMultiplierTable = {
      season: arg(argv, '--name') ?? `after ${seasonRow.name}`,
      basedOn: seasonRow.name,
      computedAt: new Date().toISOString(),
      rules,
      maps: rows,
    };
    writeFileSync(out, `${JSON.stringify(table, null, 2)}\n`);
    console.log(`wrote ${out}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
