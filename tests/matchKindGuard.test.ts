// tests/matchKindGuard.test.ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Any raw "state = 'completed'" or "state IN (... 'completed' ...)" outside
 * this allowlist is a query that would count scrims and tournament matches as
 * PUGs. Use completedPug() from src/matchKinds.ts instead, or, if the code is
 * operational and must see every kind, add the file here with the reason.
 * Counts are per file so a second raw filter in an allowed file still fails.
 */
const ALLOWED: Record<string, number> = {
  'src/db.ts': 1,                   // matches.state CHECK constraint, valid for every kind
  'src/matchResult.ts': 1,          // the result writer
  'src/demoOffload.ts': 1,          // offload demos of every kind
  'src/replayOffload.ts': 1,        // offload replays of every kind
  'src/replayPrune.ts': 1,          // prune replays of every kind
  'src/playerNames.ts': 1,          // name scratch cleanup
  'src/reindex.ts': 1,              // relink files
  'src/nameBackfill.ts': 1,         // log token to match
  'src/tickets/filing.ts': 1,       // reports about any shared match
  'src/discord/reportButton.ts': 1, // co-players from any match
  'src/discord/voice.ts': 1,        // voice sweep
  'src/admin/matches.ts': 1,        // staff list
  'src/admin/conduct.ts': 1,        // IN (...) plus kind = 'pug'
  'src/routes/people.ts': 1,        // staff chat log
  'src/routes/replays.ts': 2,       // gated by canViewMatch
  'src/routes/stats.ts': 2,         // gated by visibleMatchesSql / canViewMatch
  'src/discord/commands.ts': 1,     // public matches only
  'src/matchArchive.ts': 1,         // comment
};

const RAW = /state\s*=\s*'completed'|state\s+IN\s*\([^)]*'completed'/g;

describe('completed-match filters', () => {
  it('only allowlisted files keep raw filters, and no more of them than allowed', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.ts') ? [`${dir}/${e.name}`] : []));
    const found: Record<string, number> = {};
    for (const f of walk('src')) {
      const n = (readFileSync(join(root, f), 'utf8').match(RAW) ?? []).length;
      if (n > 0) found[f] = n;
    }
    const offenders = Object.entries(found).filter(([f, n]) => n > (ALLOWED[f] ?? 0));
    expect(offenders).toEqual([]);
  });
});
