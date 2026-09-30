// tests/serverHoldGuard.test.ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A box held by a practice lease or a side game (and, later, a booking) is
 * 'idle' in servers.status. Any SQL that picks or takes an idle box without
 * ${NOT_HELD_SQL} would hand a held box to a match. The allowlist is for a
 * holder acting on its OWN held box, with the reason; counts are per file so
 * a second such statement in an allowed file still fails.
 */
const ALLOWED: Record<string, number> = {
  'src/sideGames.ts': 1, // takeForMatch: the side game hands its own box to the match its pop became
};

const STRINGS = /`[^`]*`|"(?:[^"\\\n]|\\.)*"/g;
const IDLE_FILTER = /\b(WHERE|AND)\s+status\s*=\s*'idle'/i;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.ts') ? [`${dir}/${e.name}`] : []));

describe('server hold guard', () => {
  it('every statement that filters on idle servers also excludes held ones', () => {
    const found: Record<string, number> = {};
    for (const f of walk('src')) {
      const bare = (readFileSync(join(root, f), 'utf8').match(STRINGS) ?? [])
        .filter((s) => IDLE_FILTER.test(s) && !s.includes('${NOT_HELD_SQL}'));
      if (bare.length > 0) found[f] = bare.length;
    }
    const offenders = Object.entries(found).filter(([f, n]) => n > (ALLOWED[f] ?? 0));
    expect(offenders).toEqual([]);
  });

  it('the per-table helpers are gone', () => {
    const hits = walk('src').filter((f) => /\b(NOT_LEASED_SQL|isLeased|isSideHeld)\b/.test(readFileSync(join(root, f), 'utf8')));
    expect(hits).toEqual([]);
  });
});
