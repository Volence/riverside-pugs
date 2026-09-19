# Campaign Stop Point Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin chooses how many maps a campaign plays, so a finale can be played or a campaign cut short, for stock and custom campaigns alike.

**Architecture:** One stored number per campaign. The backend resolves it to the name of the map to stop after and passes that as a fourth argument to `sm_pug_match`; the plugin ends the match when that map completes, reusing the `EndMatchNow()` path `!endpug` already uses. Nothing touches a mission file, a VPK, or the engine's chapter list.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, Preact, Vitest, SourcePawn.

**Spec:** `docs/superpowers/specs/2026-09-18-custom-campaign-chapters-design.md`

## Global Constraints

- **No row means today's behaviour.** A campaign with no rule plays every chapter except the last, exactly as it does now. Nothing about existing matches may change on deploy.
- **Self-started and auto-tracked matches must be untouched.** They get no backend argument and must keep ending on `NextMapIsFinale()`.
- `src/campaigns.ts` stays a pure const with no DB dependency. `tests/config.test.ts:40` asserts its exact keys.
- **No migration framework.** `src/db.ts` uses `CREATE TABLE IF NOT EXISTS` in `SCHEMA` plus the `ensureColumn` helper.
- Comments explain **why**, not what. **No em dashes** anywhere, including commit messages.
- Tests verify real behavior, not mocks.
- **The plugin change is not deployed by this plan.** It is built and unit-tested here; staging on an empty server is Task 6's runbook.

---

### Task 1: Store the rule

**Files:**
- Modify: `src/db.ts` (append to `SCHEMA`)
- Create: `src/campaignRules.ts`
- Test: `tests/campaignRules.test.ts`

**Interfaces:**
- Produces:
  - `getMapsToPlay(db: DB, slug: string): number | null` (null when no rule)
  - `setMapsToPlay(db: DB, slug: string, maps: number): void`
  - `clearMapsToPlay(db: DB, slug: string): void`
  - `allMapsToPlay(db: DB): Map<string, number>`

- [ ] **Step 1: Write the failing test**

Create `tests/campaignRules.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import {
  getMapsToPlay, setMapsToPlay, clearMapsToPlay, allMapsToPlay,
} from '../src/campaignRules.js';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

describe('campaign play rules', () => {
  // Absent is the default, and the default is today's behaviour. This is the
  // one that protects every match the site already runs.
  it('has no rule for a campaign nobody configured', () => {
    expect(getMapsToPlay(db, 'dead_air')).toBeNull();
  });

  it('stores and reads a rule', () => {
    setMapsToPlay(db, 'dead_air', 3);
    expect(getMapsToPlay(db, 'dead_air')).toBe(3);
  });

  // The admin panel writes this on every change, not only the first.
  it('overwrites an existing rule', () => {
    setMapsToPlay(db, 'dead_air', 3);
    setMapsToPlay(db, 'dead_air', 5);
    expect(getMapsToPlay(db, 'dead_air')).toBe(5);
  });

  // Clearing returns the campaign to the default rather than storing a zero,
  // which would mean "play no maps" and is not a thing.
  it('clears a rule back to absent', () => {
    setMapsToPlay(db, 'dead_air', 3);
    clearMapsToPlay(db, 'dead_air');
    expect(getMapsToPlay(db, 'dead_air')).toBeNull();
  });

  it('reads every rule at once', () => {
    setMapsToPlay(db, 'dead_air', 3);
    setMapsToPlay(db, 'no_mercy', 5);
    expect(allMapsToPlay(db)).toEqual(new Map([['dead_air', 3], ['no_mercy', 5]]));
  });

  // Stock and custom campaigns share this table on purpose: a stock finale is
  // excluded for the same reason a custom one is, and a second mechanism for
  // stock is how the two-switch confusion started.
  it('holds stock and custom slugs alike', () => {
    setMapsToPlay(db, 'no_mercy', 4);
    setMapsToPlay(db, 'city17_v2_8', 5);
    expect(getMapsToPlay(db, 'city17_v2_8')).toBe(5);
    expect(getMapsToPlay(db, 'no_mercy')).toBe(4);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/campaignRules.test.ts`
Expected: FAIL, cannot resolve `../src/campaignRules.js`.

- [ ] **Step 3: Add the schema**

In `src/db.ts`, append to the `SCHEMA` template string:

```sql
CREATE TABLE IF NOT EXISTS campaign_play_rules (
  slug TEXT PRIMARY KEY,
  maps_to_play INTEGER NOT NULL
);
```

No foreign key to `custom_campaigns`: stock campaigns have no row there and a
constraint would make a stock rule impossible to store.

- [ ] **Step 4: Write the store**

Create `src/campaignRules.ts`:

```ts
import type { DB } from './db.js';

/**
 * How many maps a campaign plays, when an admin has said.
 *
 * Absent is the default and the default is what the site has always done:
 * every chapter except the last. So a fresh install, and every campaign nobody
 * has configured, behaves exactly as before.
 *
 * Stock and custom campaigns share one table. A stock finale is excluded for
 * the same reason a custom one is, and giving stock campaigns their own
 * mechanism is how the pool ended up with two switches nobody could tell apart.
 */

export function getMapsToPlay(db: DB, slug: string): number | null {
  const row = db
    .prepare('SELECT maps_to_play FROM campaign_play_rules WHERE slug = ?')
    .get(slug) as { maps_to_play: number } | undefined;
  return row?.maps_to_play ?? null;
}

export function setMapsToPlay(db: DB, slug: string, maps: number): void {
  db.prepare(
    `INSERT INTO campaign_play_rules (slug, maps_to_play) VALUES (?, ?)
     ON CONFLICT(slug) DO UPDATE SET maps_to_play = excluded.maps_to_play`,
  ).run(slug, maps);
}

export function clearMapsToPlay(db: DB, slug: string): void {
  db.prepare('DELETE FROM campaign_play_rules WHERE slug = ?').run(slug);
}

export function allMapsToPlay(db: DB): Map<string, number> {
  const rows = db
    .prepare('SELECT slug, maps_to_play FROM campaign_play_rules')
    .all() as { slug: string; maps_to_play: number }[];
  return new Map(rows.map((r) => [r.slug, r.maps_to_play]));
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/campaignRules.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS. The schema change touches every test that opens a database.

- [ ] **Step 7: Commit**

```bash
git add src/db.ts src/campaignRules.ts tests/campaignRules.test.ts
git commit -m "Store how many maps a campaign plays"
```

---

### Task 2: Stock campaigns get their chapter lists

**Files:**
- Create: `src/stockMissions.ts`
- Modify: `src/campaignRegistry.ts` (populate `maps` for stock entries)
- Modify: `src/config.ts` (add `missionsDir`)
- Test: `tests/stockMissions.test.ts`

**Interfaces:**
- Consumes: `parseMission` from `src/vpk.js` (plan 1), which returns `{ name, displayTitle, chapters: { map, display }[] }`
- Produces:
  - `readStockMissions(dir: string): Map<string, { map: string; display: string | null }[]>` keyed by the SITE SLUG, not the mission's own name

**Background.** The registry carries `maps: []` for the stock four, because the orchestrator only ever needed each one's first map. The stop point needs full lists. They are already on disk as plain files: the spike confirmed `left4dead/missions/` holds `airport.txt`, `farm.txt`, `hospital.txt`, `smalltown.txt` and others. Read them rather than hardcoding four lists, which would drift from whatever the server actually runs.

Mission `Name` values are the campaign words (`airport`, `farm`, `hospital`, `smalltown`), not the site's slugs (`dead_air`, `blood_harvest`, `no_mercy`, `death_toll`). The mapping already exists in `src/campaigns.ts` as `CAMPAIGN_BY_MAP_WORD`; do not write a second one.

- [ ] **Step 1: Write the failing test**

Create `tests/stockMissions.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStockMissions } from '../src/stockMissions.js';

let dir: string;

const AIRPORT = `"mission"
{
  "Name" "airport"
  "DisplayTitle" "Dead Air"
  "modes"
  {
    "versus"
    {
      "1" { "Map" "l4d_vs_airport01_greenhouse" "DisplayName" "The Greenhouse" }
      "2" { "Map" "l4d_vs_airport02_offices" "DisplayName" "The Crane" }
      "3" { "Map" "l4d_vs_airport03_garage" "DisplayName" "The Garage" }
      "4" { "Map" "l4d_vs_airport04_terminal" "DisplayName" "The Terminal" }
      "5" { "Map" "l4d_vs_airport05_runway" "DisplayName" "The Runway" }
    }
  }
}
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'missions-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'airport.txt'), AIRPORT);
  // Not a mission: the reader must skip it rather than throw.
  writeFileSync(join(dir, 'credits.txt'), 'this is not a mission file');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('readStockMissions', () => {
  // Keyed by the site's slug, not the mission's own Name: the file calls
  // itself "airport" and this site calls it "dead_air".
  it('reads a mission file into its versus chapter list', () => {
    const got = readStockMissions(dir);
    expect(got.get('dead_air')!.map((c) => c.map)).toEqual([
      'l4d_vs_airport01_greenhouse', 'l4d_vs_airport02_offices',
      'l4d_vs_airport03_garage', 'l4d_vs_airport04_terminal',
      'l4d_vs_airport05_runway',
    ]);
  });

  it('keeps the chapter display names', () => {
    expect(readStockMissions(dir).get('dead_air')![0].display).toBe('The Greenhouse');
  });

  // credits.txt sits in this directory on a real install and is not a mission.
  it('skips a file that is not a mission', () => {
    expect(readStockMissions(dir).has('credits')).toBe(false);
    expect(readStockMissions(dir).size).toBe(1);
  });

  // An unset or wrong path must not take the site down at startup.
  it('returns nothing for a directory that is not there', () => {
    expect(readStockMissions(join(dir, 'nope')).size).toBe(0);
  });

  it('returns nothing for an empty path', () => {
    expect(readStockMissions('').size).toBe(0);
  });
});

```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/stockMissions.test.ts`
Expected: FAIL, cannot resolve `../src/stockMissions.js`.

- [ ] **Step 3: Write the reader**

Create `src/stockMissions.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMission } from './vpk.js';
import { campaignForMap } from './campaigns.js';

/**
 * The stock campaigns' chapter lists, read off disk.
 *
 * The registry carries `maps: []` for the stock four because the orchestrator
 * only ever needed each one's first map. Choosing where a campaign stops needs
 * the whole list, and it is already sitting in `left4dead/missions/` as plain
 * text on every install.
 *
 * Read rather than hardcoded on purpose: a hardcoded list is a second source of
 * truth that drifts from whatever the server is actually running, and the
 * consequence of that drift is a match ending on the wrong map.
 *
 * Every failure here is silent and empty. A missing directory, an unreadable
 * file or a file that is not a mission must not stop the site booting; the
 * campaign simply has no known chapters and keeps today's behaviour.
 */

export interface StockChapter { map: string; display: string | null }

export function readStockMissions(dir: string): Map<string, StockChapter[]> {
  const out = new Map<string, StockChapter[]>();
  if (!dir) return out;
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.txt'));
  } catch {
    return out;
  }
  for (const name of names) {
    let mission;
    try {
      mission = parseMission(readFileSync(join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (!mission || mission.chapters.length === 0) continue;
    // Keyed by the SITE's slug, not the mission's own Name. A mission calls
    // itself "airport" where this site says "dead_air", and campaignForMap
    // already knows that mapping from the campaign word embedded in every
    // stock map name. Deriving it from the first chapter avoids a second
    // lookup table that would have to be kept in step with the first.
    const slug = campaignForMap(mission.chapters[0].map);
    if (slug) out.set(slug, mission.chapters);
  }
  return out;
}

```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/stockMissions.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Add the config and wire the registry**

In `src/config.ts`, beside `addonsDir`:

```ts
  /** The game's missions directory, holding the stock campaigns' chapter
   *  lists. Empty means the stock four have no known chapters, which leaves
   *  every campaign on its default stop point: the same reason demoDir and
   *  addonsDir default to empty rather than to a guess. */
  missionsDir: string;
```

and in the loader: `missionsDir: env.MISSIONS_DIR ?? '',`

Add it to `missingDirs` alongside the others, so a wrong path says so at startup:

```ts
  const pairs: [string, string][] = [
    ['REPLAY_DIR', cfg.replayDir], ['DEMO_DIR', cfg.demoDir], ['ADDONS_DIR', cfg.addonsDir],
    ['MISSIONS_DIR', cfg.missionsDir],
  ];
```

In `src/campaignRegistry.ts`, `build()` currently sets `maps: []` for stock entries. Give the module a settable missions directory rather than importing config, so tests can point it at a fixture and the registry keeps its single-argument shape:

```ts
let missionsDir = '';

/** Where the stock campaigns' chapter lists live. Set once at startup from
 *  config. Module state rather than a parameter because campaignRegistry(db) is
 *  called from a dozen places that have no business knowing about the game
 *  directory. */
export function setMissionsDir(dir: string): void {
  missionsDir = dir;
  cache = null;
}
```

and in `build()`, replace `maps: []` with a lookup:

```ts
  const stockMissions = readStockMissions(missionsDir);
```

then `maps: (stockMissions.get(slug) ?? []).map((c) => c.map)` in the stock loop.

Call `setMissionsDir(deps.config.missionsDir)` in `buildServer`, beside the other startup wiring in `src/server.ts`.

- [ ] **Step 6: Write the registry test**

Append to `tests/campaignRegistry.test.ts`:

```ts
describe('stock chapter lists', () => {
  it('is empty when no missions directory is configured', async () => {
    const { setMissionsDir, campaignRegistry } = await import('../src/campaignRegistry.js');
    setMissionsDir('');
    expect(campaignRegistry(db).get('dead_air')!.maps).toEqual([]);
  });
});
```

Add a fixture-backed case too, writing an `airport.txt` into a temp directory exactly as `tests/stockMissions.test.ts` does, calling `setMissionsDir(dir)`, and asserting `campaignRegistry(db).get('dead_air')!.maps` has five entries. Reset with `setMissionsDir('')` in an `afterEach` so one test's directory cannot leak into another's registry cache.

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/stockMissions.ts src/campaignRegistry.ts src/config.ts src/server.ts tests/stockMissions.test.ts tests/campaignRegistry.test.ts
git commit -m "Read the stock campaigns' chapters off disk"
```

---

### Task 3: Resolve the stop-after map

**Files:**
- Create: `src/stopPoint.ts`
- Test: `tests/stopPoint.test.ts`

**Interfaces:**
- Consumes: `campaignRegistry` from `src/campaignRegistry.js`; `getMapsToPlay` from `src/campaignRules.js`
- Produces: `stopAfterMap(db: DB, slug: string): string | null`

**The rule.** Take the campaign's maps in order. With a rule of N, the stop map is the Nth. With no rule, it is the second from last, which is today's behaviour. Null when the campaign has no known maps, which means the plugin gets no argument and keeps using its own logic.

- [ ] **Step 1: Write the failing test**

Create `tests/stopPoint.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { insertDraft, publishCampaign } from '../src/customCampaigns.js';
import { invalidateCampaignCache, setMissionsDir } from '../src/campaignRegistry.js';
import { setMapsToPlay } from '../src/campaignRules.js';
import { stopAfterMap } from '../src/stopPoint.js';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  setMissionsDir('');
  invalidateCampaignCache();
  insertDraft(db, {
    slug: 'five', name: 'Five', vpkFilename: 'five.vpk',
    sizeBytes: 1, sha256: 'a'.repeat(64), uploadedBy: null,
  }, [1, 2, 3, 4, 5].map((n) => ({ map: `m${n}`, display: null, isFinale: n === 5 })));
  publishCampaign(db, 'five', 'Five');
  invalidateCampaignCache();
});
afterEach(() => { setMissionsDir(''); invalidateCampaignCache(); });

describe('stopAfterMap', () => {
  // The default is today's behaviour, and this is the assertion that protects
  // every match the site already runs.
  it('stops one before the last when there is no rule', () => {
    expect(stopAfterMap(db, 'five')).toBe('m4');
  });

  it('stops after the Nth map when a rule says N', () => {
    setMapsToPlay(db, 'five', 3);
    expect(stopAfterMap(db, 'five')).toBe('m3');
  });

  // The case the owner actually asked for, and the one the plugin has never
  // exercised: play the whole campaign including its finale.
  it('stops after the finale when the rule names every map', () => {
    setMapsToPlay(db, 'five', 5);
    expect(stopAfterMap(db, 'five')).toBe('m5');
  });

  // A rule left over from a campaign that was re-uploaded shorter must not
  // index off the end.
  it('clamps a rule naming more maps than the campaign has', () => {
    setMapsToPlay(db, 'five', 99);
    expect(stopAfterMap(db, 'five')).toBe('m5');
  });

  // Zero or negative is not a thing. Fall back to the default rather than
  // inventing a match with no maps.
  it.each([0, -1])('ignores a nonsense rule of %s', (n) => {
    setMapsToPlay(db, 'five', n);
    expect(stopAfterMap(db, 'five')).toBe('m4');
  });

  // No known maps means no argument, and the plugin keeps its own logic. This
  // is the stock case until a missions directory is configured.
  it('is null for a campaign with no known maps', () => {
    expect(stopAfterMap(db, 'dead_air')).toBeNull();
  });

  it('is null for a campaign nothing knows about', () => {
    expect(stopAfterMap(db, 'nope')).toBeNull();
  });

  // A one-chapter campaign has no "one before the last". Play the one map
  // rather than returning nothing.
  it('handles a single-map campaign', () => {
    insertDraft(db, {
      slug: 'one', name: 'One', vpkFilename: 'one.vpk',
      sizeBytes: 1, sha256: 'b'.repeat(64), uploadedBy: null,
    }, [{ map: 'solo', display: null, isFinale: true }]);
    publishCampaign(db, 'one', 'One');
    invalidateCampaignCache();
    expect(stopAfterMap(db, 'one')).toBe('solo');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/stopPoint.test.ts`
Expected: FAIL, cannot resolve `../src/stopPoint.js`.

- [ ] **Step 3: Write it**

Create `src/stopPoint.ts`:

```ts
import type { DB } from './db.js';
import { campaignRegistry } from './campaignRegistry.js';
import { getMapsToPlay } from './campaignRules.js';

/**
 * The map a match on this campaign should stop after.
 *
 * Null means "we do not know", and the backend then sends the plugin nothing,
 * leaving it on NextMapIsFinale() exactly as before. That is the honest answer
 * for a campaign whose chapter list we cannot see, and it is what keeps this
 * change inert until a missions directory is configured.
 *
 * The default with no rule is the second from last map, which is what the
 * plugin already does on its own. Matching it here rather than special casing
 * means the backend and the plugin cannot disagree about an unconfigured
 * campaign.
 */
export function stopAfterMap(db: DB, slug: string): string | null {
  const maps = campaignRegistry(db).get(slug)?.maps ?? [];
  if (maps.length === 0) return null;

  const rule = getMapsToPlay(db, slug);
  // A rule of zero or less would mean a match with no maps. Treat it as
  // unconfigured rather than obeying it.
  const wanted = rule !== null && rule > 0 ? rule : Math.max(maps.length - 1, 1);
  return maps[Math.min(wanted, maps.length) - 1];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/stopPoint.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/stopPoint.ts tests/stopPoint.test.ts
git commit -m "Work out which map a campaign stops after"
```

---

### Task 4: Send it to the plugin

**Files:**
- Modify: `src/orchestrator.ts:135`
- Test: `tests/orchestrator.test.ts` (extend)

**Interfaces:**
- Consumes: `stopAfterMap` from `src/stopPoint.js`

**Background.** The orchestrator currently sends:

```ts
await expectPugOk(rcon, `sm_pug_match ${matchId} ${token} ${match.campaign}`);
```

Source's console tokenizer splits unquoted arguments on `:`, which is why `tests/helpers.ts`'s `pugReply` models quoting. Map names contain no colons, so a bare fourth argument is safe, but follow whatever quoting the surrounding call already uses.

- [ ] **Step 1: Write the failing test**

Append to `tests/orchestrator.test.ts`, following the existing `setupMatch` tests' harness:

```ts
import { insertDraft, publishCampaign } from '../src/customCampaigns.js';
import { invalidateCampaignCache, setMissionsDir } from '../src/campaignRegistry.js';

describe('stop-after map', () => {
  const publishFive = (db: DB) => {
    insertDraft(db, {
      slug: 'five', name: 'Five', vpkFilename: 'five.vpk',
      sizeBytes: 1, sha256: 'a'.repeat(64), uploadedBy: null,
    }, [1, 2, 3, 4, 5].map((n) => ({ map: `m${n}`, display: null, isFinale: n === 5 })));
    publishCampaign(db, 'five', 'Five');
    invalidateCampaignCache();
  };

  const matchCmd = (cmds: string[]) => cmds.find((c) => c.startsWith('sm_pug_match')) ?? '';

  it('sends the stop map as a fourth argument when one is known', async () => {
    const sent: string[] = [];
    const { db, orchestrator, server } = harness((cmd) => { sent.push(cmd); });
    publishFive(db);
    await orchestrator.setupMatch(matchOn(db, 'five', server.id));
    // Default rule: one before the last, so the fourth of five.
    expect(matchCmd(sent).endsWith(' m4')).toBe(true);
  });

  // This is the regression guard for every match the site already runs. A
  // stock campaign has no known chapters until a missions directory is
  // configured, so the command must keep its exact old shape: three arguments,
  // no trailing anything.
  it('sends three arguments when no stop map is known', async () => {
    const sent: string[] = [];
    const { db, orchestrator, server } = harness((cmd) => { sent.push(cmd); });
    setMissionsDir('');
    invalidateCampaignCache();
    await orchestrator.setupMatch(matchOn(db, 'dead_air', server.id));
    expect(matchCmd(sent)).toMatch(/^sm_pug_match \d+ \S+ dead_air$/);
  });
});
```

`harness(onCmd)` and `matchOn(db, campaign, serverId)` are placeholders for whatever the existing `setupMatch` tests in this file actually call: reuse that file's rcon fake and match-row builder rather than writing new ones, renaming these two references to match. Do not build a parallel harness.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/orchestrator.test.ts`
Expected: FAIL, the fourth argument is never sent.

- [ ] **Step 3: Send it**

In `src/orchestrator.ts`, replace the `sm_pug_match` line:

```ts
      // The map to stop after, when we know the campaign's chapters. Omitted
      // rather than guessed when we do not: the plugin then keeps using its own
      // NextMapIsFinale(), which is what every self-started match relies on and
      // what every match did before this argument existed.
      const stopMap = stopAfterMap(this.db, match.campaign);
      const stopArg = stopMap ? ` ${stopMap}` : '';
      await expectPugOk(rcon, `sm_pug_match ${matchId} ${token} ${match.campaign}${stopArg}`);
```

with the import added at the top.

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.ts tests/orchestrator.test.ts
git commit -m "Tell the plugin which map ends the match"
```

---

### Task 5: The plugin honours it

**Files:**
- Modify: `plugin/pug-match.sp`

**Background.** This is the only SourcePawn change. It is built and compiled here; it is **not** staged on a server by this task. There is no unit test framework for this plugin; correctness comes from reading it and from Task 6's live test.

Current state, all confirmed by reading:
- `Cmd_Match` (`plugin/pug-match.sp:1476`) requires `args < 3` and reads three with `GetCmdArg`.
- `FinishSecondHalf` (`:3063`) calls `FinalizeMap()` then ends if `NextMapIsFinale()`.
- `ResetMatchState` (`:2157`) clears the per-match globals, including `g_sCampaign`.
- `EndMatchNow` (`:1756`) is the shared end path, used by `!endpug`.

- [ ] **Step 1: Add the global**

Beside `g_sCampaign` at `plugin/pug-match.sp:91`:

```sourcepawn
char g_sStopAfterMap[64];               // backend-supplied last scored map; empty = use NextMapIsFinale
```

- [ ] **Step 2: Clear it on reset**

In `ResetMatchState`, beside `g_sCampaign[0] = '\0';`:

```sourcepawn
	g_sStopAfterMap[0] = '\0';
```

Missing this would leak one match's stop map into the next, which is the kind
of bug that only shows up on the second match of a night.

- [ ] **Step 3: Accept the fourth argument**

In `Cmd_Match`, after the existing `GetCmdArg(3, ...)`:

```sourcepawn
	// Optional fourth argument: the map after which this match ends. The
	// backend sends it only when it knows the campaign's chapter list, so an
	// absent argument means "decide for yourself", which is what every match
	// did before this existed and what every self-started match still does.
	if (args >= 4) GetCmdArg(4, g_sStopAfterMap, sizeof(g_sStopAfterMap));
```

Leave the `args < 3` check and the usage string's required part alone; update
the usage text to `sm_pug_match <matchid> <token> <campaign> [stopaftermap]` in
both places it appears (`:346` and `:1480`).

- [ ] **Step 4: End on that map**

Replace the body of `FinishSecondHalf`:

```sourcepawn
void FinishSecondHalf()
{
	// g_sCurrentMap is read before FinalizeMap so the comparison is against the
	// map that was just played, not whatever a pending changelevel has set.
	char justPlayed[64];
	strcopy(justPlayed, sizeof(justPlayed), g_sCurrentMap);

	FinalizeMap();
	if (g_State != MS_Live) return;

	// A backend-supplied stop map wins outright. It is the whole point of the
	// argument: it can name the finale, which NextMapIsFinale() can never
	// report because chapter == chapters - 1 is false on the last chapter.
	if (g_sStopAfterMap[0] != '\0')
	{
		if (StrEqual(justPlayed, g_sStopAfterMap, false)) EndMatchNow("stop map done");
		return;
	}

	if (NextMapIsFinale()) EndMatchNow("last scored map done");
}
```

The early `return` after the stop-map branch matters: with a stop map supplied,
`NextMapIsFinale()` must not also fire, or a campaign set to play its finale
would still end one map early.

**This also answers the spec's open question about short campaigns.**
`NextMapIsFinale()` refuses anything with `chapters < 3`, because its comment
says a bad chapter read "ends a live match early". With a stop map supplied that
guard is never consulted, so a campaign cut to two maps ends on the map the
backend named rather than falling through to a guard that would never fire. The
guard keeps protecting exactly the case it was written for, which is a match
with no backend-supplied stop map and an implausible chapter read. Do not
loosen it.

- [ ] **Step 5: Log it**

In `NextMapIsFinale`'s existing `LogMessage` there is already a per-map line. Add one where the stop map is set, in `Cmd_Match`:

```sourcepawn
	if (g_sStopAfterMap[0] != '\0')
		LogMessage("[pug] match %d stops after %s", matchId, g_sStopAfterMap);
```

Task 6 reads this to confirm the argument arrived.

- [ ] **Step 6: Compile**

Run: `cd plugin && ./build.sh`
Expected: compiles with no errors. Read any warning; a SourcePawn warning about an unused variable here means a branch was not wired.

- [ ] **Step 7: Commit**

```bash
git add plugin/pug-match.sp plugin/pug-match.smx
git commit -m "End the match on the backend's stop map when it sends one"
```

---

### Task 6: Admin control, and the runbook

**Files:**
- Modify: `src/routes/campaigns.ts` (add the rule route, include rules and stock campaigns in the admin list)
- Modify: `web/src/api.ts`, `web/src/routes/admin/AdminCampaigns.tsx`
- Modify: `docs/CUSTOM_CAMPAIGNS.md`
- Test: `tests/campaignRoutes.test.ts`, `web/src/routes/admin.test.tsx`

**Interfaces:**
- Produces:
  - `POST /api/admin/campaigns/:slug/maps-to-play` body `{ maps: number | null }`
  - `mapsToPlay: number | null`, `maps: string[]` and `stock: boolean` on each admin campaign row
  - `adminApi.setMapsToPlay(slug: string, maps: number | null): Promise<{ ok: true }>`

- [ ] **Step 1: Write the failing route test**

Append to `tests/campaignRoutes.test.ts`:

```ts
describe('POST /api/admin/campaigns/:slug/maps-to-play', () => {
  const publishFive = () => {
    insertDraft(db, {
      slug: 'five', name: 'Five', vpkFilename: 'five.vpk',
      sizeBytes: 9, sha256: 'a'.repeat(64), uploadedBy: null,
    }, [1, 2, 3, 4, 5].map((n) => ({ map: `m${n}`, display: null, isFinale: n === 5 })));
    publishCampaign(db, 'five', 'Five');
  };

  const post = (app: FastifyInstance, slug: string, body: unknown, steamid = '76561198000000001') =>
    app.inject({
      method: 'POST', url: `/api/admin/campaigns/${slug}/maps-to-play`,
      cookies: authedCookie(app, db, steamid), payload: body,
    });

  it('stores a rule and reports it back', async () => {
    publishFive();
    const app = await buildTestApp({ db, addonsDir: addons });
    expect((await post(app, 'five', { maps: 3 })).statusCode).toBe(200);
    expect(getMapsToPlay(db, 'five')).toBe(3);
    const list = await app.inject({
      method: 'GET', url: '/api/admin/campaigns',
      cookies: authedCookie(app, db, '76561198000000001'),
    });
    const row = list.json().campaigns.find((c: { slug: string }) => c.slug === 'five');
    expect(row.mapsToPlay).toBe(3);
  });

  it('clears the rule when given null', async () => {
    publishFive();
    setMapsToPlay(db, 'five', 3);
    const app = await buildTestApp({ db, addonsDir: addons });
    expect((await post(app, 'five', { maps: null })).statusCode).toBe(200);
    expect(getMapsToPlay(db, 'five')).toBeNull();
  });

  // Stock campaigns are configurable here too and have no custom_campaigns row.
  it('accepts a stock campaign', async () => {
    const app = await buildTestApp({ db, addonsDir: addons });
    expect((await post(app, 'dead_air', { maps: 5 })).statusCode).toBe(200);
    expect(getMapsToPlay(db, 'dead_air')).toBe(5);
  });

  it('refuses a campaign nothing knows about', async () => {
    const app = await buildTestApp({ db, addonsDir: addons });
    expect((await post(app, 'nope', { maps: 2 })).statusCode).toBe(404);
  });

  // Zero would mean a match with no maps. Refuse rather than store it and rely
  // on stopAfterMap quietly ignoring it later.
  it.each([0, -1, 2.5])('refuses a nonsense rule of %s', async (maps) => {
    publishFive();
    const app = await buildTestApp({ db, addonsDir: addons });
    expect((await post(app, 'five', { maps })).statusCode).toBe(400);
    expect(getMapsToPlay(db, 'five')).toBeNull();
  });

  it('refuses a non-admin', async () => {
    publishFive();
    const app = await buildTestApp({ db, addonsDir: addons });
    expect((await post(app, 'five', { maps: 3 }, '76561198000000009')).statusCode).toBe(403);
    expect(getMapsToPlay(db, 'five')).toBeNull();
  });
});
```

Import `getMapsToPlay` and `setMapsToPlay` from `../src/campaignRules.js` at the
top of the file. `authedCookie` promotes a player but does not make them admin;
follow the pattern already in this file for granting `is_admin`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/campaignRoutes.test.ts`
Expected: FAIL, 404 on an unknown route.

- [ ] **Step 3: Add the route**

In `src/routes/campaigns.ts`, beside the other admin mutations:

```ts
  app.post('/api/admin/campaigns/:slug/maps-to-play', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const { slug } = req.params as { slug: string };
    // Stock campaigns are configurable here too and have no custom_campaigns
    // row, so validate against the registry rather than that table.
    if (!campaignRegistry(db).has(slug)) return reply.code(404).send({ error: 'no such campaign' });

    const raw = (req.body as { maps?: number | null } | undefined)?.maps ?? null;
    if (raw === null) {
      clearMapsToPlay(db, slug);
      logAdmin(db, adminId, 'campaign_maps_to_play', slug, { maps: null });
      return { ok: true };
    }
    if (!Number.isInteger(raw) || raw < 1) {
      return reply.code(400).send({ error: 'maps must be a whole number of at least 1' });
    }
    setMapsToPlay(db, slug, raw);
    logAdmin(db, adminId, 'campaign_maps_to_play', slug, { maps: raw });
    return { ok: true };
  });
```

Note this route does **not** call `invalidateCampaignCache()`: the rule is read
per match by `stopAfterMap`, not cached in the registry.

- [ ] **Step 4: Include stock campaigns and rules in the admin list**

`GET /api/admin/campaigns` currently returns only `custom_campaigns` rows. Extend it so each row carries `mapsToPlay` and `maps`, and so stock campaigns appear as entries with no install controls. The shape each row gains:

```ts
  mapsToPlay: number | null;
  maps: string[];
  stock: boolean;
```

Stock rows have `state: 'published'`, empty `installs`, and their `maps` from
the registry. The UI keys off `stock` to hide upload, reinstall and delete.

- [ ] **Step 5: Write the UI test**

Append to `web/src/routes/admin.test.tsx`: a campaign with `maps` of five and
`mapsToPlay: null` shows the default described as four maps; choosing five calls
`adminApi.setMapsToPlay(slug, 5)`; a stock row renders without Reinstall or
Delete buttons. Follow that file's existing mocking pattern and use
`toHaveProperty('disabled', true)` rather than `toBeDisabled()`, which is not
wired into this project.

- [ ] **Step 6: Build the control**

Add the client call in `web/src/api.ts`, beside the other campaign mutations:

```ts
  setMapsToPlay: (slug: string, maps: number | null) =>
    post<{ ok: true }>(`/api/admin/campaigns/${encodeURIComponent(slug)}/maps-to-play`, { maps }),
```

In `AdminCampaigns.tsx`, per campaign:

```tsx
/** How many maps this campaign plays. The empty value is the default, which is
 *  every chapter but the last: the same thing the plugin does unprompted, so an
 *  unconfigured campaign and a campaign explicitly set to its default behave
 *  identically rather than taking different code paths. */
function MapsToPlay(
  { c, busy, run }: { c: AdminCampaign; busy: boolean; run: Run },
) {
  if (c.maps.length === 0) {
    return <p class="muted">Chapters unknown, so this campaign plays its default.</p>;
  }
  return (
    <label>
      Plays{' '}
      <select
        aria-label="Maps to play"
        disabled={busy}
        value={c.mapsToPlay === null ? '' : String(c.mapsToPlay)}
        onChange={(e) => {
          const v = (e.target as HTMLSelectElement).value;
          run(() => adminApi.setMapsToPlay(c.slug, v === '' ? null : Number(v)));
        }}
      >
        <option value="">Default ({Math.max(c.maps.length - 1, 1)} maps, no finale)</option>
        {c.maps.map((_m, i) => (
          <option key={i} value={String(i + 1)}>
            {i + 1} map{i === 0 ? '' : 's'}{i + 1 === c.maps.length ? ' (includes the finale)' : ''}
          </option>
        ))}
      </select>
      {' '}
      <span class="muted">Takes effect next match. Nothing is reinstalled.</span>
    </label>
  );
}
```

Dim the chapters this drops, in the existing `ChapterList`, by passing it the
count that will be played and applying `muted` to the rest. Render `MapsToPlay`
in both the published card and a new stock card, and hide upload, reinstall and
delete when `c.stock` is true.

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run && npx tsc --noEmit && npx tsc --noEmit -p web/tsconfig.json`
Expected: all pass.

- [ ] **Step 8: Write the runbook section**

Add to `docs/CUSTOM_CAMPAIGNS.md` a section covering: `MISSIONS_DIR` must point
at `/home/l4d/l4d1-server/left4dead/missions`; the plugin change must be staged
with `plugin/stage.sh` on an **empty** server before any match uses a non-default
rule; and the live verification sequence, which is the real test of this feature:

1. Set a campaign to stop one map early, play it, confirm the match ends there
   and the dump reports the right number of maps.
2. Set a campaign to play its finale. **This path has never run.** Confirm the
   finale loads, is scored, and ends the match.
3. Confirm a campaign with no rule behaves exactly as before.
4. Confirm a self-started match still ends on its own.

Note that `[pug] match N stops after <map>` in the server log is how to tell the
argument arrived.

- [ ] **Step 9: Commit**

```bash
git add src/routes/campaigns.ts web/src docs/CUSTOM_CAMPAIGNS.md tests web/src/routes/admin.test.tsx
git commit -m "Let an admin choose how many maps a campaign plays"
```
