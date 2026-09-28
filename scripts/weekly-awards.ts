import { openDb } from '../src/db.js';
import { computeWeek } from '../src/weeklyAwards.js';
import { computeRecap } from '../src/weeklyRecap.js';
import { freezeWeek, frozenWeek, type FrozenWeek } from '../src/weeklyStore.js';
import { renderAwards, renderRecap } from '../src/discord/weeklyCard.js';

/**
 * Print a week's recap and awards as they would be posted, or freeze a week
 * by hand (weeks from before the feature shipped are never frozen
 * automatically). Run against a COPY of the prod database for a dry run:
 * openDb creates missing tables, which is a write.
 */
const [path, week, flag] = process.argv.slice(2);
if (!path || !/^\d{4}-\d{2}-\d{2}$/.test(week ?? '')) {
  console.error('usage: tsx scripts/weekly-awards.ts <db-path> <YYYY-MM-DD> [--freeze]');
  process.exit(2);
}
const db = openDb(path);
let f: FrozenWeek;
if (flag === '--freeze') {
  try {
    console.log(freezeWeek(db, week) ? 'frozen' : 'already frozen');
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  }
  const frozen = frozenWeek(db, week);
  if (!frozen) throw new Error(`could not read frozen week ${week}`);
  f = frozen;
} else {
  f = { week, frozenAt: '', postedAt: null, awards: computeWeek(db, week), recap: computeRecap(db, week) };
}
const url = process.env.PUBLIC_URL ?? 'https://riversidepug.com';
console.log(renderRecap(f, url).content);
console.log('\n----- awards -----\n');
const a = renderAwards(f, url);
console.log(a ? `${a.embeds[0].title}\n\n${a.embeds[0].description}` : '(no awards)');
