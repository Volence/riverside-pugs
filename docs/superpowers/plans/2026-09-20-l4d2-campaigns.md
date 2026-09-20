# L4D2 Campaigns in the Rotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the eight L4D2 campaigns from the dlc4 mappack into the PUG campaign pool, gated so a match can never land on a server that does not have the maps.

**Architecture:** These ride the *stock* mission path, not the custom-campaign uploader. `parseMission()` already reads a mission file's `versus` block, and the eight campaigns are plain `.txt` mission files in `left4dead_dlc4/missions/`, so they need no VPK, no `addonsTransport` upload and no install rows. The work is: teach `campaignForMap` the `c1m1_hotel` naming, read a second missions directory, add a per-server "has dlc4" fact proved by probing the file system through each server's own transport, and gate the pool on it.

**Tech Stack:** TypeScript, Node, `tsx` (the server runs `src/` directly; `npm run build` is only the Vite web bundle), better-sqlite3, Fastify, Preact, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-20-l4d2-campaigns-design.md`

## Global Constraints

- **No em dashes** anywhere in code, comments, commit messages or copy.
- **Comments explain *why*, not *what*.** Match the density and voice of the surrounding file; this codebase writes substantial explanatory comments on non-obvious decisions and that is the house style.
- **TDD.** Every task writes the failing test first and runs it to watch it fail before implementing.
- **Never write to `master`.** All work happens on branch `worktree-l4d2-maps` in worktree `/home/volence/l4d/pug/.claude/worktrees/l4d2-maps`. Other sessions use the main checkout concurrently.
- **Run the full suite before each commit:** `npm test`. Baseline is green; leave it green.
- **Type check with `npx tsc --noEmit`** before committing any task that changes a type.
- **The eight dlc4 slugs, verbatim:** `dead_center`, `dark_carnival`, `swamp_fever`, `hard_rain`, `the_parish`, `the_passing`, `cold_stream`, `the_last_stand`.
- **The dlc4 campaign-number map, verbatim:** 1 dead_center, 2 dark_carnival, 3 swamp_fever, 4 hard_rain, 5 the_parish, 6 the_passing, 13 cold_stream, 14 the_last_stand.
- **Do not touch live servers.** Tasks 1 to 10 are code only. The server-side work is the Runbook at the end and needs the owner's explicit go-ahead each time.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/campaigns.ts` | Modify: the eight slugs, the `c<N>m<N>` matcher, `DLC4_CAMPAIGNS` | 1 |
| `tests/campaigns.test.ts` | Modify: an existing test asserts `c5m1_waterfront` is null | 1 |
| `src/stockMissions.ts` | Modify: read a list of directories | 2 |
| `src/config.ts` | Modify: add `dlc4MissionsDir` | 2 |
| `tests/stockMissions.test.ts`, `tests/config.test.ts` | Modify | 2 |
| `src/campaignRegistry.ts` | Modify: `STOCK_FIRST` entries, `requiresDlc4`, `setMissionsDirs` | 3 |
| `src/db.ts` | Modify: `servers.has_dlc4` column | 4 |
| `src/dlc4.ts` | **Create**: derive the dlc4 maps dir, probe a server for it | 4 |
| `tests/dlc4.test.ts` | **Create** | 4 |
| `src/addonsTransport.ts` | Modify: `transportFor` takes an optional dir override | 4 |
| `src/serverPool.ts` | Modify: `setHasDlc4`, `serversMissingDlc4` | 5 |
| `src/routes/settings.ts` | Modify: `validateSetting` for `map_pool` | 5 |
| `src/routes/servers.ts` | Modify: a re-check endpoint | 6 |
| `web/src/routes/admin.tsx` (settings + servers panels) | Modify: show why a campaign is unavailable | 6 |
| `web/src/format.ts` | Modify: the 32 map names, `chapterOrdinal`, `qualifiedMapName` | 7 |
| `src/playerQueries.ts` | Modify: enrich `byMap` rows with campaign | 8 |
| `web/src/routes/Profile.tsx` | Modify: qualified labels in the Bars list | 8 |
| `scripts/upload-mappack.ts` | **Create** | 9 |
| `web/src/routes/HowToPlay.tsx` | Modify: the install section | 10 |

Tasks 1 to 3 are the registry and must land in order. Task 4 is independent of 1 to 3 and can run in parallel. Tasks 5 and 6 need 3 and 4. Tasks 7 and 8 are independent of everything else. Tasks 9 and 10 are independent of everything else.

---

### Task 1: Teach `campaignForMap` the L4D2 naming

**Files:**
- Modify: `src/campaigns.ts`
- Test: `tests/campaigns.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CAMPAIGNS` gains eight keys. `campaignForMap(map: string): string | null` now resolves `c<N>m<N>_*` names. New export `DLC4_CAMPAIGNS: ReadonlySet<string>`.

- [ ] **Step 1: Write the failing test**

In `tests/campaigns.test.ts`, add these blocks inside the existing `describe('campaignForMap')`:

```typescript
  // The L4D2 ports use L4D2's own map naming, which shares nothing with the
  // l4d_<word><nn> scheme. Versus and coop are the SAME bsp on these, so there
  // is no vs_ variant to test.
  it.each([
    ['c1m1_hotel', 'dead_center'],
    ['c1m4_atrium', 'dead_center'],
    ['c2m1_highway', 'dark_carnival'],
    ['c2m5_concert', 'dark_carnival'],
    ['c3m1_plankcountry', 'swamp_fever'],
    ['c3m4_plantation', 'swamp_fever'],
    ['c4m1_milltown_a', 'hard_rain'],
    ['c4m5_milltown_escape', 'hard_rain'],
    ['c5m1_waterfront', 'the_parish'],
    ['c5m5_bridge', 'the_parish'],
    ['c6m1_riverbank', 'the_passing'],
    ['c6m3_port', 'the_passing'],
    ['c13m1_alpinecreek', 'cold_stream'],
    ['c13m4_cutthroatcreek', 'cold_stream'],
    ['c14m1_junkyard', 'the_last_stand'],
    ['c14m2_lighthouse', 'the_last_stand'],
  ])('maps dlc4 map %s to %s', (map, expected) => {
    expect(campaignForMap(map)).toBe(expected);
  });

  it('is case insensitive for dlc4 names too', () => {
    expect(campaignForMap('C1M1_HOTEL')).toBe('dead_center');
  });

  // A campaign number we do not ship must not be invented into a slug.
  it('returns null for an unknown dlc4 campaign number', () => {
    expect(campaignForMap('c7m1_somewhere')).toBeNull();
    expect(campaignForMap('c99m1_nope')).toBeNull();
  });

  it('every dlc4 slug exists in CAMPAIGNS', () => {
    for (const slug of DLC4_CAMPAIGNS) expect(Object.keys(CAMPAIGNS)).toContain(slug);
  });
```

Change the import line at the top of the file to:

```typescript
import { CAMPAIGNS, DLC4_CAMPAIGNS, campaignForMap } from '../src/campaigns.js';
```

**An existing test now asserts the opposite of what we want.** In the `returns null for an unknown map rather than guessing` test, delete this line:

```typescript
    expect(campaignForMap('c5m1_waterfront')).toBeNull();
```

and replace it with a name that is still genuinely unknown:

```typescript
    expect(campaignForMap('de_dust2')).toBeNull();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/campaigns.test.ts`
Expected: FAIL. `DLC4_CAMPAIGNS` is not exported, and the dlc4 name cases return `null`.

- [ ] **Step 3: Write minimal implementation**

Replace the whole of `src/campaigns.ts` with:

```typescript
export const CAMPAIGNS: Record<string, { name: string }> = {
  no_mercy: { name: 'No Mercy' },
  death_toll: { name: 'Death Toll' },
  dead_air: { name: 'Dead Air' },
  blood_harvest: { name: 'Blood Harvest' },
  dead_center: { name: 'Dead Center' },
  dark_carnival: { name: 'Dark Carnival' },
  swamp_fever: { name: 'Swamp Fever' },
  hard_rain: { name: 'Hard Rain' },
  the_parish: { name: 'The Parish' },
  the_passing: { name: 'The Passing' },
  cold_stream: { name: 'Cold Stream' },
  the_last_stand: { name: 'The Last Stand' },
};

/**
 * The campaigns that live in `left4dead_dlc4` rather than in the base game.
 *
 * A const set rather than something derived from which missions directory the
 * campaign was read from. Deriving it would make the pool gate collapse to
 * "allowed" whenever MISSIONS_DIR is unconfigured, which is failing open on the
 * one check that stops a match landing on a server with no maps. This fails
 * closed and does not depend on config at all.
 */
export const DLC4_CAMPAIGNS: ReadonlySet<string> = new Set([
  'dead_center', 'dark_carnival', 'swamp_fever', 'hard_rain',
  'the_parish', 'the_passing', 'cold_stream', 'the_last_stand',
]);

/**
 * L4D1 map names embed their campaign as a fixed word after the `l4d_` or
 * `l4d_vs_` prefix: `l4d_vs_airport01_greenhouse` is Dead Air. Matching on that
 * word is stable across all five chapters and across the coop/versus variants.
 *
 * Needed because a match started in-game with `!load_4v4p` reports the map it
 * is standing on: the plugin has no campaign table and should not grow one.
 *
 * Returns null rather than a default for anything unrecognised. Guessing would
 * silently file a custom map under a real campaign.
 */
const CAMPAIGN_BY_MAP_WORD: Record<string, string> = {
  hospital: 'no_mercy',
  smalltown: 'death_toll',
  airport: 'dead_air',
  farm: 'blood_harvest',
};

/**
 * The dlc4 ports keep L4D2's own naming, `c<campaign>m<chapter>_<place>`, which
 * shares no structure with the L4D1 scheme above and so needs its own table.
 *
 * Note the numbers are not contiguous: Cold Stream is 13 and The Last Stand is
 * 14, matching L4D2's own campaign ids. A range check would be wrong.
 */
const CAMPAIGN_BY_DLC4_NUMBER: Record<string, string> = {
  1: 'dead_center',
  2: 'dark_carnival',
  3: 'swamp_fever',
  4: 'hard_rain',
  5: 'the_parish',
  6: 'the_passing',
  13: 'cold_stream',
  14: 'the_last_stand',
};

export function campaignForMap(map: string): string | null {
  const lower = map.toLowerCase();

  const dlc4 = /^c(\d+)m\d+/.exec(lower);
  if (dlc4) return CAMPAIGN_BY_DLC4_NUMBER[dlc4[1]] ?? null;

  const m = /^l4d_(?:vs_)?([a-z]+)\d*/.exec(lower);
  if (!m) return null;
  return CAMPAIGN_BY_MAP_WORD[m[1]] ?? null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/campaigns.test.ts`
Expected: PASS.

Then run the whole suite, because `CAMPAIGNS` is read at import time by the Discord command module and other tests assert against it:

Run: `npm test`
Expected: PASS. If a Discord command test fails on the number of campaign choices, that test is asserting the old four and must be updated to the new twelve. Read the failure before changing anything.

- [ ] **Step 5: Commit**

```bash
git add src/campaigns.ts tests/campaigns.test.ts
git commit -m "Teach campaignForMap the L4D2 map naming

The dlc4 ports use L4D2's own c<campaign>m<chapter> scheme, which the
l4d_<word><nn> matcher does not touch at all, so every L4D2 map resolved
to null. Campaign numbers are not contiguous (13 and 14), so this is a
table rather than a range."
```

---

### Task 2: Read a second missions directory

**Files:**
- Modify: `src/stockMissions.ts`, `src/config.ts`
- Test: `tests/stockMissions.test.ts`, `tests/config.test.ts`

**Interfaces:**
- Consumes: `campaignForMap` from Task 1, which must already resolve dlc4 names.
- Produces: `readStockMissions(dirs: string[])` now takes an array. `Config` gains `dlc4MissionsDir: string`.

**Why an array rather than a second call:** the registry builds one map keyed by slug. Two calls would mean the caller merging two maps and deciding precedence, which is a decision with no right answer that would then live in the wrong file. Slugs cannot collide across the two directories, so the reader folding them is both simpler and unambiguous.

- [ ] **Step 1: Write the failing test**

In `tests/stockMissions.test.ts`, add a second temp directory and these cases. Add `let dlc4Dir: string;` beside the existing `let dir: string;`, and extend the hooks:

```typescript
const DEAD_CENTER = `"mission"
{
  "Name" "DeadCenter"
  "DisplayTitle" "Dead Center"
  "modes"
  {
    "coop"
    {
      "1" { "Map" "c1m1_hotel" "DisplayName" "Hotel" }
    }
    "versus"
    {
      "1" { "Map" "c1m1_hotel" "DisplayName" "Hotel (VS)" }
      "2" { "Map" "c1m2_streets" "DisplayName" "Streets (VS)" }
      "3" { "Map" "c1m3_mall" "DisplayName" "Mall (VS)" }
      "4" { "Map" "c1m4_atrium" "DisplayName" "Atrium (VS)" }
    }
  }
}
`;
```

Add to `beforeEach`, after the existing writes:

```typescript
  dlc4Dir = mkdtempSync(join(tmpdir(), 'missions-dlc4-'));
  mkdirSync(dlc4Dir, { recursive: true });
  writeFileSync(join(dlc4Dir, 'DeadCenter.txt'), DEAD_CENTER);
```

Add to `afterEach`:

```typescript
  rmSync(dlc4Dir, { recursive: true, force: true });
```

Then add these tests:

```typescript
  it('reads campaigns from every directory it is given', () => {
    const got = readStockMissions([dir, dlc4Dir]);
    expect(got.get('dead_air')?.map((c) => c.map)).toEqual([
      'l4d_vs_airport01_greenhouse', 'l4d_vs_airport02_offices',
      'l4d_vs_airport03_garage', 'l4d_vs_airport04_terminal',
      'l4d_vs_airport05_runway',
    ]);
    expect(got.get('dead_center')?.map((c) => c.map)).toEqual([
      'c1m1_hotel', 'c1m2_streets', 'c1m3_mall', 'c1m4_atrium',
    ]);
  });

  // The versus block is what the site plays. A mission file also carries coop,
  // and coop's chapter 1 has a different DisplayName, so reading the wrong
  // block is silently wrong rather than an error.
  it('takes the versus block, not coop', () => {
    const got = readStockMissions([dlc4Dir]);
    expect(got.get('dead_center')?.[0].display).toBe('Hotel (VS)');
  });

  it('skips a directory that does not exist without losing the others', () => {
    const got = readStockMissions([dir, join(dlc4Dir, 'nope')]);
    expect(got.has('dead_air')).toBe(true);
    expect(got.size).toBe(1);
  });

  it('returns empty for an empty list', () => {
    expect(readStockMissions([]).size).toBe(0);
  });
```

**Every existing call in that file passes a bare string** and must become a single-element array: `readStockMissions(dir)` becomes `readStockMissions([dir])`. Update all of them.

In `tests/config.test.ts`, add:

```typescript
  it('reads DLC4_MISSIONS_DIR, defaulting to empty', () => {
    expect(loadConfig({ DLC4_MISSIONS_DIR: '/srv/left4dead_dlc4/missions' }).dlc4MissionsDir)
      .toBe('/srv/left4dead_dlc4/missions');
    expect(loadConfig({}).dlc4MissionsDir).toBe('');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/stockMissions.test.ts tests/config.test.ts`
Expected: FAIL. `readStockMissions` rejects an array, and `dlc4MissionsDir` does not exist.

- [ ] **Step 3: Write minimal implementation**

In `src/stockMissions.ts`, change the signature and wrap the existing body in a loop. Replace the function with:

```typescript
export function readStockMissions(dirs: string[]): Map<string, StockChapter[]> {
  const out = new Map<string, StockChapter[]>();
  for (const dir of dirs) {
    if (!dir) continue;
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.txt'));
    } catch {
      // A directory that is not there is how a feature is turned off, not an
      // error, and one bad path must not cost us the campaigns in the others.
      continue;
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
  }
  return out;
}
```

Update the doc comment above it: the parameter is now a list of directories, walked in order, and slugs do not collide across them.

In `src/config.ts`, add `dlc4MissionsDir: string;` to the `Config` interface beside `missionsDir`, add to `loadConfig`:

```typescript
    dlc4MissionsDir: env.DLC4_MISSIONS_DIR ?? '',
```

and add it to the `missingDirs` pairs so a typo in the path is reported the same way the others are:

```typescript
    ['MISSIONS_DIR', cfg.missionsDir], ['DLC4_MISSIONS_DIR', cfg.dlc4MissionsDir],
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/stockMissions.test.ts tests/config.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: one error, at the `readStockMissions(missionsDir)` call in `src/campaignRegistry.ts`. **Leave it.** Task 3 fixes it. Do not patch it here with a throwaway array, because Task 3 replaces that whole code path.

- [ ] **Step 5: Commit**

```bash
git add src/stockMissions.ts src/config.ts tests/stockMissions.test.ts tests/config.test.ts
git commit -m "Read mission files from a list of directories

The dlc4 campaigns live in their own missions directory alongside the base
game's. The reader folds them because slugs cannot collide across the two,
so making the caller merge two maps would only move an unambiguous decision
into a file with no business making it."
```

---

### Task 3: The eight campaigns in the registry

**Files:**
- Modify: `src/campaignRegistry.ts`
- Test: `tests/campaignRegistry.test.ts`

**Interfaces:**
- Consumes: `DLC4_CAMPAIGNS` (Task 1), `readStockMissions(dirs)` (Task 2), `Config.dlc4MissionsDir` (Task 2).
- Produces: `setMissionsDirs(dirs: string[]): void` replaces `setMissionsDir(dir: string)`. `CampaignEntry` gains `requiresDlc4: boolean`.

- [ ] **Step 1: Write the failing test**

In `tests/campaignRegistry.test.ts`, add:

```typescript
import { setMissionsDirs } from '../src/campaignRegistry.js';

describe('dlc4 campaigns in the registry', () => {
  it('lists all twelve campaigns with no missions directory configured', () => {
    setMissionsDirs([]);
    invalidateCampaignCache();
    const reg = campaignRegistry(db);
    expect(reg.size).toBe(12);
    // Chapter lists come from mission files, so they are empty here. The
    // campaign still exists, which is what makes the pool gate meaningful
    // even when the paths are unset.
    expect(reg.get('dead_center')?.maps).toEqual([]);
  });

  it('marks exactly the dlc4 campaigns as requiring dlc4', () => {
    setMissionsDirs([]);
    invalidateCampaignCache();
    const reg = campaignRegistry(db);
    expect(reg.get('dead_center')?.requiresDlc4).toBe(true);
    expect(reg.get('the_last_stand')?.requiresDlc4).toBe(true);
    expect(reg.get('no_mercy')?.requiresDlc4).toBe(false);
  });

  it('gives a dlc4 campaign its own first map, with no vs_ infix', () => {
    setMissionsDirs([]);
    invalidateCampaignCache();
    expect(firstMapOf(db, 'dead_center')).toBe('c1m1_hotel');
    expect(firstMapOf(db, 'the_parish')).toBe('c5m1_waterfront');
    expect(firstMapOf(db, 'no_mercy')).toBe('l4d_vs_hospital01_apartment');
  });

  it('resolves a dlc4 map to its campaign', () => {
    setMissionsDirs([]);
    invalidateCampaignCache();
    expect(resolveCampaignForMap(db, 'c2m3_coaster')).toBe('dark_carnival');
  });

  // A published custom campaign must never be marked as needing dlc4: it has
  // its own VPK and its own install rows, and conflating the two gates would
  // make every custom campaign unpoolable the moment one server lacked dlc4.
  it('never marks a custom campaign as requiring dlc4', () => {
    publish();
    setMissionsDirs([]);
    invalidateCampaignCache();
    expect(campaignRegistry(db).get('dbd')?.requiresDlc4).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/campaignRegistry.test.ts`
Expected: FAIL. `setMissionsDirs` is not exported and `requiresDlc4` does not exist.

- [ ] **Step 3: Write minimal implementation**

In `src/campaignRegistry.ts`:

Add `DLC4_CAMPAIGNS` to the import from `./campaigns.js`.

Add to the `CampaignEntry` interface:

```typescript
  /** Lives in left4dead_dlc4, so a server without the mappack cannot load it.
   *  Gated separately from `custom`, which means "has its own VPK to install". */
  requiresDlc4: boolean;
```

Extend `STOCK_FIRST` and amend its comment. Replace the const and its comment with:

```typescript
/** The map a match changelevels into, per campaign.
 *
 *  For the base game these MUST be the `l4d_vs_` BSPs. The plain `l4d_` names
 *  are the coop maps, which load a coop mission and cannot be played versus.
 *
 *  The dlc4 ports are the exception and take their plain names: those campaigns
 *  ship ONE bsp per chapter serving both modes, and the mission file's versus
 *  block names the same maps its coop block does. There is no `c1m1_vs_hotel`
 *  to reach for. Verified against the real mission files 2026-09-20. */
const STOCK_FIRST: Record<string, string> = {
  no_mercy: 'l4d_vs_hospital01_apartment',
  death_toll: 'l4d_vs_smalltown01_caves',
  dead_air: 'l4d_vs_airport01_greenhouse',
  blood_harvest: 'l4d_vs_farm01_hilltop',
  dead_center: 'c1m1_hotel',
  dark_carnival: 'c2m1_highway',
  swamp_fever: 'c3m1_plankcountry',
  hard_rain: 'c4m1_milltown_a',
  the_parish: 'c5m1_waterfront',
  the_passing: 'c6m1_riverbank',
  cold_stream: 'c13m1_alpinecreek',
  the_last_stand: 'c14m1_junkyard',
};
```

Replace `missionsDir` and `setMissionsDir` with:

```typescript
let missionsDirs: string[] = [];

/** Where campaign chapter lists live: the base game's `missions/` and dlc4's.
 *  Set once at startup from config. Module state rather than a parameter
 *  because campaignRegistry(db) is called from a dozen places that have no
 *  business knowing about the game directory. */
export function setMissionsDirs(dirs: string[]): void {
  missionsDirs = dirs.filter(Boolean);
  cache = null;
}
```

In `build()`, change the read and the stock loop:

```typescript
  const stockMissions = readStockMissions(missionsDirs);
  for (const [slug, c] of Object.entries(CAMPAIGNS)) {
    registry.set(slug, {
      slug, name: c.name, firstMap: STOCK_FIRST[slug],
      maps: (stockMissions.get(slug) ?? []).map((ch) => ch.map), custom: false,
      requiresDlc4: DLC4_CAMPAIGNS.has(slug),
    });
  }
```

In the custom-campaign loop, add `requiresDlc4: false` to the `registry.set` call. A custom campaign carries its own VPK and its own install rows; that is a different gate and conflating the two would make every custom campaign unpoolable the moment one server lacked dlc4.

Also add the dlc4 maps to `byMap`. Today `resolveCampaignForMap` answers stock maps through `campaignForMap`, which Task 1 already taught the dlc4 names, so **no change is needed there** and the test above passes through the existing path. Do not add a second lookup.

Finally, update the caller in `src/index.ts` (or wherever `setMissionsDir` is called at startup) to:

```typescript
setMissionsDirs([cfg.missionsDir, cfg.dlc4MissionsDir]);
```

Find it with `grep -rn "setMissionsDir" src/`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/campaignRegistry.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: clean. The Task 2 error is now resolved.

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/campaignRegistry.ts src/index.ts tests/campaignRegistry.test.ts
git commit -m "Put the eight dlc4 campaigns in the registry

They ride the stock path: mission files, no VPK, no install rows. Their
first maps take the plain name rather than an l4d_vs_ one, because these
ports ship one bsp per chapter serving both modes."
```

---

### Task 4: Prove a server has dlc4

**Files:**
- Create: `src/dlc4.ts`
- Modify: `src/addonsTransport.ts`, `src/db.ts`
- Test: `tests/dlc4.test.ts`

**Interfaces:**
- Consumes: `AddonsTransport`, `transportFor` from `src/addonsTransport.ts`; `ServerRow` from `src/serverPool.ts`.
- Produces:
  - `transportFor(server: ServerRow, dirOverride?: string): AddonsTransport | null`
  - `dlc4MapsDir(addonsDir: string | null | undefined): string | null`
  - `DLC4_PROBE_FILE = 'c1m1_hotel.bsp'`
  - `serverHasDlc4(server: ServerRow): Promise<boolean>`
  - `servers.has_dlc4` column, `INTEGER NOT NULL DEFAULT 0`

**Why probe rather than trust a checkbox:** a flag an admin ticks by hand drifts from the disk, and the consequence of drift is a match that dies on a missing map. Probing through the server's own configured transport gives one code path covering local, ftp and sftp, and makes the flag evidence.

**Why derive the path rather than configure it:** every server's `addons_dir` is `<gameroot>/left4dead/addons` (Dallas `/home/l4d/l4d1-server/left4dead/addons`, Chicago `/left4dead/addons`, Riverside `/home/l4d/l4d1-a/left4dead/addons`). The dlc4 maps directory is `<gameroot>/left4dead_dlc4/maps` in every case. A derived path cannot drift from the transport it is probed with; a second config field can.

- [ ] **Step 1: Write the failing test**

Create `tests/dlc4.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { dlc4MapsDir, serverHasDlc4, DLC4_PROBE_FILE } from '../src/dlc4.js';
import type { ServerRow } from '../src/serverPool.js';

const base = {
  id: 1, name: 'Test', host: '127.0.0.1', port: 27015, enabled: 1,
} as unknown as ServerRow;

describe('dlc4MapsDir', () => {
  it.each([
    ['/home/l4d/l4d1-server/left4dead/addons', '/home/l4d/l4d1-server/left4dead_dlc4/maps'],
    ['/left4dead/addons', '/left4dead_dlc4/maps'],
    ['/home/l4d/l4d1-a/left4dead/addons', '/home/l4d/l4d1-a/left4dead_dlc4/maps'],
  ])('derives %s to %s', (addons, expected) => {
    expect(dlc4MapsDir(addons)).toBe(expected);
  });

  it('tolerates a trailing slash', () => {
    expect(dlc4MapsDir('/left4dead/addons/')).toBe('/left4dead_dlc4/maps');
  });

  // Returning null rather than guessing: a path we cannot reason about must
  // read as "cannot prove it", which fails the gate closed.
  it.each([
    ['', null],
    [null, null],
    [undefined, null],
    ['/somewhere/else', null],
    ['/left4dead/addons/nested', null],
  ])('returns null for %s', (addons, expected) => {
    expect(dlc4MapsDir(addons as string | null | undefined)).toBe(expected);
  });
});

describe('serverHasDlc4', () => {
  it('is true when the probe file has a size', async () => {
    const server = { ...base, addons_transport: 'local', addons_dir: '/left4dead/addons' } as ServerRow;
    const seen: string[] = [];
    const got = await serverHasDlc4(server, () => ({
      put: async () => {},
      size: async (name: string) => { seen.push(name); return 137; },
      remove: async () => {},
    }));
    expect(got).toBe(true);
    expect(seen).toEqual([DLC4_PROBE_FILE]);
  });

  it('is false when the probe file is absent', async () => {
    const server = { ...base, addons_transport: 'local', addons_dir: '/left4dead/addons' } as ServerRow;
    const got = await serverHasDlc4(server, () => ({
      put: async () => {}, size: async () => null, remove: async () => {},
    }));
    expect(got).toBe(false);
  });

  // A server we cannot reach is not a server we may assume is fine.
  it('is false when there is no usable transport', async () => {
    const server = { ...base, addons_transport: 'local', addons_dir: '' } as ServerRow;
    expect(await serverHasDlc4(server, () => null)).toBe(false);
  });

  // A dead box throws rather than returning null, and an exception must not
  // take down whatever is iterating servers.
  it('is false when the transport throws', async () => {
    const server = { ...base, addons_transport: 'local', addons_dir: '/left4dead/addons' } as ServerRow;
    const got = await serverHasDlc4(server, () => ({
      put: async () => {},
      size: async () => { throw new Error('host unreachable'); },
      remove: async () => {},
    }));
    expect(got).toBe(false);
  });
});
```

Add to `tests/db.test.ts`:

```typescript
  it('gives servers a has_dlc4 column defaulting to 0', () => {
    const db = openDb(':memory:');
    const cols = db.prepare('PRAGMA table_info(servers)').all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('has_dlc4');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dlc4.test.ts tests/db.test.ts`
Expected: FAIL. `src/dlc4.js` does not exist; `has_dlc4` is not a column.

- [ ] **Step 3: Write minimal implementation**

In `src/addonsTransport.ts`, give `transportFor` an optional directory override. Replace its first lines:

```typescript
/** @param dirOverride probe or write somewhere other than the addons directory,
 *  keeping this one function as the only place that knows how each box is
 *  reached. Used by the dlc4 probe, which must look at left4dead_dlc4/maps. */
export function transportFor(server: ServerRow, dirOverride?: string): AddonsTransport | null {
  const row = server as ServerRow & {
    addons_transport?: string | null; addons_dir?: string | null;
    ftp_host?: string | null; ftp_port?: number | null;
    ftp_user?: string | null; ftp_password?: string | null;
    ssh_key_path?: string | null;
  };
  const dir = dirOverride ?? row.addons_dir;
  if (!dir) return null;
```

then replace every remaining use of `row.addons_dir` in that function body with `dir` (there are three, one per transport branch).

Create `src/dlc4.ts`:

```typescript
import type { ServerRow } from './serverPool.js';
import { transportFor, type AddonsTransport } from './addonsTransport.js';

/**
 * Whether a game server carries the L4D2 mappack.
 *
 * Proved by looking at the far side's disk through that server's own configured
 * transport, not asserted by an admin ticking a box. A flag set by hand drifts
 * from the disk, and the cost of that drift is a live match dying on a map the
 * server cannot load. Probing gives one code path across local, ftp and sftp.
 */

/** A file that exists on every correct install and on no incorrect one. The
 *  first chapter of the first campaign, so a partial copy that got as far as
 *  c1m1 and stopped is the only false positive available, and a partial copy
 *  is not a state any of our install paths can leave behind. */
export const DLC4_PROBE_FILE = 'c1m1_hotel.bsp';

/**
 * Where a server keeps its dlc4 maps, derived from where it keeps its addons.
 *
 * Every box lays out as `<gameroot>/left4dead/addons`, so `<gameroot>` is the
 * part before `/left4dead/addons` and the maps sit at
 * `<gameroot>/left4dead_dlc4/maps`. Derived rather than configured because a
 * derived path cannot drift from the transport it is probed with, and a second
 * config field can. Null for anything that does not match, so a layout we
 * cannot reason about reads as "cannot prove it" and fails the gate closed.
 */
export function dlc4MapsDir(addonsDir: string | null | undefined): string | null {
  if (!addonsDir) return null;
  const m = /^(.*)\/left4dead\/addons\/?$/.exec(addonsDir);
  return m ? `${m[1]}/left4dead_dlc4/maps` : null;
}

export async function serverHasDlc4(
  server: ServerRow,
  // Injected so the tests do not need a real box. Production always uses the
  // real transportFor.
  makeTransport: (s: ServerRow, dir: string) => AddonsTransport | null = transportFor,
): Promise<boolean> {
  const dir = dlc4MapsDir((server as ServerRow & { addons_dir?: string | null }).addons_dir);
  if (!dir) return false;
  const t = makeTransport(server, dir);
  if (!t) return false;
  try {
    return (await t.size(DLC4_PROBE_FILE)) !== null;
  } catch {
    // An unreachable box is not a box we may assume is fine, and an exception
    // here must not take down whatever is iterating servers.
    return false;
  }
}
```

In `src/db.ts`, beside the other `ensureColumn` calls for `servers` (they sit around lines 638 to 670), add:

```typescript
  ensureColumn(db, 'servers', 'has_dlc4', 'INTEGER NOT NULL DEFAULT 0');
```

**Do not also add it to `SCHEMA`.** Every server column past the original six (`enabled`, `addons_transport`, `ssh_key_path` and the rest) is added through `ensureColumn` alone; the `CREATE TABLE` block is deliberately frozen at its original shape. Adding it in both places would be the only column in the file with two definitions to keep in step.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dlc4.test.ts tests/db.test.ts tests/addonsTransport.test.ts`
Expected: PASS. The existing addonsTransport tests must still pass; the override is optional and changes no existing call.

Run: `npm test` and `npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/dlc4.ts src/addonsTransport.ts src/db.ts tests/dlc4.test.ts tests/db.test.ts
git commit -m "Prove whether a server carries the dlc4 mappack

Probed through the server's own transport rather than asserted by an admin
checkbox: a hand-set flag drifts from the disk and the cost of that drift is
a live match dying on a map the server cannot load. The maps directory is
derived from the addons directory so the two cannot disagree."
```

---

### Task 5: Gate the pool on dlc4

**Files:**
- Modify: `src/campaignRegistry.ts`, `src/serverPool.ts`, `src/routes/settings.ts`
- Test: `tests/campaignRegistry.test.ts`, `tests/adminSettings.test.ts`

**Interfaces:**
- Consumes: `CampaignEntry.requiresDlc4` (Task 3), `servers.has_dlc4` (Task 4).
- Produces: `setHasDlc4(db, serverId, has): void`, `serversMissingDlc4(db): string[]` (names, for the admin panel), and `poolableCampaigns` now filters on dlc4.

- [ ] **Step 1: Write the failing test**

In `tests/campaignRegistry.test.ts`:

```typescript
import { poolableCampaigns } from '../src/campaignRegistry.js';
import { addServer, setHasDlc4, serversMissingDlc4 } from '../src/serverPool.js';

// Goes through the real addServer because `servers` has NOT NULL rcon_port and
// rcon_password with no defaults, then sets the two flags the base insert does
// not take. `enabled` and `has_dlc4` are both ensureColumn additions and so
// carry their own defaults (1 and 0).
const seedServer = (name: string, enabled = 1, hasDlc4 = 0): number => {
  const id = addServer(db, {
    name, host: '127.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x',
  });
  db.prepare('UPDATE servers SET enabled = ?, has_dlc4 = ? WHERE id = ?')
    .run(enabled, hasDlc4, id);
  return id;
};

describe('poolableCampaigns and dlc4', () => {
  beforeEach(() => { setMissionsDirs([]); invalidateCampaignCache(); });

  it('offers the base four but no dlc4 campaign when a server lacks the pack', () => {
    seedServer('Dallas', 1, 1);
    seedServer('Chicago', 1, 0);
    const slugs = poolableCampaigns(db).map((c) => c.slug);
    expect(slugs).toContain('no_mercy');
    expect(slugs).not.toContain('dead_center');
  });

  it('offers dlc4 campaigns once every enabled server has the pack', () => {
    seedServer('Dallas', 1, 1);
    seedServer('Chicago', 1, 1);
    const slugs = poolableCampaigns(db).map((c) => c.slug);
    expect(slugs).toContain('dead_center');
    expect(slugs).toContain('the_last_stand');
  });

  // A disabled server is not going to host a match, so it must not hold the
  // pool hostage. Same rule isInstalledEverywhere already uses.
  it('ignores a disabled server without the pack', () => {
    seedServer('Dallas', 1, 1);
    seedServer('Old box', 0, 0);
    expect(poolableCampaigns(db).map((c) => c.slug)).toContain('dead_center');
  });

  // Same reason alsoAllow exists for custom campaigns: a campaign already in
  // the pool must not make the settings page unsavable when a server loses it.
  it('keeps offering a dlc4 campaign already in the pool via alsoAllow', () => {
    seedServer('Dallas', 1, 1);
    seedServer('Chicago', 1, 0);
    const slugs = poolableCampaigns(db, { alsoAllow: ['dead_center'] }).map((c) => c.slug);
    expect(slugs).toContain('dead_center');
  });

  it('names the servers that are missing the pack', () => {
    seedServer('Dallas', 1, 1);
    seedServer('Chicago', 1, 0);
    seedServer('Riverside #3', 1, 0);
    seedServer('Retired', 0, 0);
    expect(serversMissingDlc4(db)).toEqual(['Chicago', 'Riverside #3']);
  });

  it('setHasDlc4 records the probe result', () => {
    const id = seedServer('Dallas', 1, 0);
    setHasDlc4(db, id, true);
    expect(serversMissingDlc4(db)).toEqual([]);
    setHasDlc4(db, id, false);
    expect(serversMissingDlc4(db)).toEqual(['Dallas']);
  });
});
```

In `tests/adminSettings.test.ts`, add a case asserting that a PUT of `map_pool` containing `dead_center` is rejected while a server lacks the pack. Follow the file's existing pattern for building an authenticated admin request; read a neighbouring rejection test and mirror it exactly.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/campaignRegistry.test.ts tests/adminSettings.test.ts`
Expected: FAIL. `setHasDlc4` and `serversMissingDlc4` do not exist, and dlc4 campaigns are offered unconditionally.

- [ ] **Step 3: Write minimal implementation**

In `src/serverPool.ts`:

```typescript
export function setHasDlc4(db: DB, serverId: number, has: boolean): void {
  db.prepare('UPDATE servers SET has_dlc4 = ? WHERE id = ?').run(has ? 1 : 0, serverId);
}

/** Enabled servers without the mappack, by name, for telling an admin exactly
 *  which box is holding the L4D2 campaigns out of the pool. */
export function serversMissingDlc4(db: DB): string[] {
  return (db
    .prepare('SELECT name FROM servers WHERE enabled = 1 AND has_dlc4 = 0 ORDER BY id')
    .all() as { name: string }[]).map((s) => s.name);
}

/** True when every enabled server carries the mappack. */
export function allServersHaveDlc4(db: DB): boolean {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM servers WHERE enabled = 1 AND has_dlc4 = 0')
    .get() as { n: number };
  return row.n === 0;
}
```

In `src/campaignRegistry.ts`, import `allServersHaveDlc4` and extend `poolableCampaigns`:

```typescript
export function poolableCampaigns(
  db: DB, opts: { alsoAllow?: Iterable<string> } = {},
): CampaignEntry[] {
  const serverIds = enabledServerIds(db);
  const already = new Set(opts.alsoAllow ?? []);
  // Read once rather than per campaign: eight of the twelve ask the same
  // question and the answer cannot change inside one call.
  const dlc4Everywhere = allServersHaveDlc4(db);
  return [...campaignRegistry(db).values()].filter((c) => {
    if (already.has(c.slug)) return true;
    // A dlc4 campaign on a server without the mappack is a match that dies on
    // the first changelevel, so this gate is the same kind of thing as the
    // install check below and not a nicety.
    if (c.requiresDlc4 && !dlc4Everywhere) return false;
    return !c.custom || isInstalledEverywhere(db, c.slug, serverIds);
  });
}
```

Update the doc comment above it to say what the dlc4 arm does and why `alsoAllow` still wins.

In `src/routes/settings.ts`, `validateSetting` for `map_pool` already checks membership against `poolableCampaigns`. Confirm it passes the current pool as `alsoAllow`; if it does, the new gate is enforced with no further change and the test proves it. If it does not, make it call `poolableCampaigns(db, { alsoAllow: getCampaignPool(db) })` so the panel and the API agree.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/campaignRegistry.test.ts tests/adminSettings.test.ts`
Expected: PASS.

Run: `npm test` and `npx tsc --noEmit`
Expected: PASS, clean. **Watch for existing tests that create servers without `has_dlc4` and then expect a dlc4 campaign to be poolable.** There should be none, because dlc4 campaigns are new, but a test that asserts a total campaign count will need updating.

- [ ] **Step 5: Commit**

```bash
git add src/campaignRegistry.ts src/serverPool.ts src/routes/settings.ts tests/
git commit -m "Keep dlc4 campaigns out of the pool until every server has the pack

poolableCampaigns let every non-custom campaign through because the base
four are on every install by definition. That is not true of the dlc4
campaigns, and inheriting the free pass is how the pool would hand a server
a map it cannot load."
```

---

### Task 6: Surface it in the admin panel

**Files:**
- Modify: `src/routes/servers.ts`, `web/src/routes/admin.tsx`
- Test: `tests/adminServers.test.ts` (or the nearest existing server-routes test), `web/src/routes/admin.test.tsx`

**Interfaces:**
- Consumes: `serverHasDlc4` (Task 4), `setHasDlc4`, `serversMissingDlc4` (Task 5).
- Produces: `POST /api/admin/servers/dlc4-check` returning `{ results: { id: number; name: string; hasDlc4: boolean }[] }`.

- [ ] **Step 1: Write the failing test**

Server side, in the server-routes test file:

```typescript
  it('probes every server and records the result', async () => {
    // two servers, one with the pack and one without
    const res = await app.inject({
      method: 'POST', url: '/api/admin/servers/dlc4-check', cookies: adminCookie,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toEqual([
      { id: 1, name: 'Dallas', hasDlc4: true },
      { id: 2, name: 'Chicago', hasDlc4: false },
    ]);
    // and it persisted, so the pool gate sees it
    expect(serversMissingDlc4(db)).toEqual(['Chicago']);
  });

  it('refuses a non-admin', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/servers/dlc4-check' });
    expect(res.statusCode).toBe(401);
  });
```

Build the two servers and inject a fake prober following the file's existing pattern for faking a transport; read `tests/campaignInstall.test.ts` for how `installTargets` is injected and mirror that approach rather than inventing a new one.

Web side, in `web/src/routes/admin.test.tsx`:

```typescript
  it('says which servers are missing the mappack next to the campaign pool', async () => {
    renderAdmin({ settings: { map_pool: ['no_mercy'] }, serversMissingDlc4: ['Chicago'] });
    expect(await screen.findByText(/Chicago/)).toBeTruthy();
    expect(screen.getByText(/needs the L4D2 mappack/i)).toBeTruthy();
  });
```

Mirror the file's existing `renderAdmin` helper signature rather than inventing one.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/adminServers.test.ts web/src/routes/admin.test.tsx`
Expected: FAIL. The route is 404 and the copy is absent.

- [ ] **Step 3: Write minimal implementation**

Add the route in `src/routes/servers.ts`:

```typescript
  // Probing is a network round trip per server, so this is an explicit admin
  // action rather than something that runs on page load. The result is stored,
  // and the pool gate reads the stored value.
  app.post('/api/admin/servers/dlc4-check', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const rows = listServers(db);
    const results = [];
    for (const s of rows) {
      const hasDlc4 = await probe(s);
      setHasDlc4(db, s.id, hasDlc4);
      results.push({ id: s.id, name: s.name, hasDlc4 });
    }
    logAdmin(db, adminId, 'server_dlc4_check', null, { results });
    return { results };
  });
```

where `probe` defaults to `serverHasDlc4` and is injectable for tests, matching how `installTargets` is injected in `src/routes/campaigns.ts`.

In the admin settings panel, when `serversMissingDlc4` is non-empty, render a line under the Campaign pool heading naming the servers and saying the L4D2 campaigns are unavailable until every server has the mappack, with a button that POSTs to the new route and refreshes. Write the copy from the reader's side: name the servers, say what is missing, say what to do.

Add `serversMissingDlc4` to whatever payload already feeds the admin settings page.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/adminServers.test.ts web/src/routes/admin.test.tsx`
Expected: PASS.

Run: `npm test` and `npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/routes/servers.ts web/src/routes/admin.tsx tests/ web/src/routes/admin.test.tsx
git commit -m "Let an admin probe for the mappack and see what is blocking the pool

A campaign silently missing from the pool is the failure mode this whole
gate risks, so the panel names the server that is missing the pack rather
than leaving an admin to guess why Dead Center is not on the list."
```

---

### Task 7: Names for the 32 L4D2 maps, and chapter ordinals

**Files:**
- Modify: `web/src/format.ts`
- Test: `web/src/format.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `mapName()` resolves all 32 dlc4 maps. New exports `chapterOrdinal(map: string): number | null` and `qualifiedMapName(map: string, campaignName: string | null): string`.

**Display names come from the mission files, with the `(VS)` suffix dropped.** Every chapter this site shows is versus, so the suffix carries no information and doubles the length of every label.

- [ ] **Step 1: Write the failing test**

In `web/src/format.test.ts`:

```typescript
describe('mapName for dlc4 maps', () => {
  it.each([
    ['c1m1_hotel', 'Hotel'],
    ['c1m2_streets', 'Streets'],
    ['c1m3_mall', 'Mall'],
    ['c1m4_atrium', 'Atrium'],
    ['c2m1_highway', 'Highway'],
    ['c2m5_concert', 'Concert'],
    ['c3m1_plankcountry', 'Plank Country'],
    ['c4m1_milltown_a', 'Milltown'],
    ['c4m3_sugarmill_b', 'Sugar Mill'],
    ['c5m1_waterfront', 'Waterfront'],
    ['c5m5_bridge', 'Bridge'],
    ['c13m1_alpinecreek', 'Alpine Creek'],
    ['c14m1_junkyard', 'Junkyard'],
    ['c14m2_lighthouse', 'Lighthouse'],
  ])('names %s as %s', (map, expected) => {
    expect(mapName(map)).toBe(expected);
  });

  // Hard Rain runs the same two places forwards then back, so the four
  // milltown chapters must not all read identically.
  it('distinguishes the Hard Rain return legs', () => {
    expect(mapName('c4m4_milltown_b')).not.toBe(mapName('c4m1_milltown_a'));
    expect(mapName('c4m5_milltown_escape')).toBe('Milltown Escape');
  });
});

describe('chapterOrdinal', () => {
  it.each([
    ['c1m3_mall', 3],
    ['c13m4_cutthroatcreek', 4],
    ['l4d_vs_airport02_offices', 2],
    ['l4d_hospital05_rooftop', 5],
    ['rombu03', 3],
  ])('reads %s as chapter %s', (map, expected) => {
    expect(chapterOrdinal(map)).toBe(expected);
  });

  it('returns null when there is no number to read', () => {
    expect(chapterOrdinal('deadbeforedawn')).toBeNull();
    expect(chapterOrdinal('')).toBeNull();
  });
});

describe('qualifiedMapName', () => {
  it('puts the campaign and chapter number in front', () => {
    expect(qualifiedMapName('c1m2_streets', 'Dead Center')).toBe('Dead Center 2 · Streets');
    expect(qualifiedMapName('l4d_vs_farm01_hilltop', 'Blood Harvest'))
      .toBe('Blood Harvest 1 · The Woods');
  });

  it('omits the number when the map name has none', () => {
    expect(qualifiedMapName('deadbeforedawn', 'Dead Before Dawn'))
      .toBe('Dead Before Dawn · Deadbeforedawn');
  });

  // An unattributed map is the case this whole helper exists for, so it must
  // degrade to the bare name rather than printing "null".
  it('falls back to the bare chapter name with no campaign', () => {
    expect(qualifiedMapName('c1m2_streets', null)).toBe('Streets');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run web/src/format.test.ts`
Expected: FAIL. `chapterOrdinal` and `qualifiedMapName` are not exported; dlc4 names fall through to the generic prefix stripper and read wrongly.

- [ ] **Step 3: Write minimal implementation**

In `web/src/format.ts`, replace the `C6M_NAMES` table with a full dlc4 table. Keep it separate from `MAP_NAMES` for the reason the existing comment gives: the `l4d_` prefix strip does not apply to these.

```typescript
/** dlc4 map names, which carry no `l4d_` prefix at all: they are L4D2-style
 *  `c<campaign>m<chapter>` names, mounted from left4dead_dlc4. Kept separate
 *  from MAP_NAMES only because the prefix strip does not apply.
 *
 *  Taken from the mission files' versus DisplayName with the "(VS)" suffix
 *  dropped: every chapter this site shows is versus, so the suffix carries no
 *  information and doubles the length of every label. */
const DLC4_NAMES: Record<string, string> = {
  c1m1_hotel: 'Hotel',
  c1m2_streets: 'Streets',
  c1m3_mall: 'Mall',
  c1m4_atrium: 'Atrium',
  c2m1_highway: 'Highway',
  c2m2_fairgrounds: 'Fairgrounds',
  c2m3_coaster: 'Coaster',
  c2m4_barns: 'Barns',
  c2m5_concert: 'Concert',
  c3m1_plankcountry: 'Plank Country',
  c3m2_swamp: 'Swamp',
  c3m3_shantytown: 'Shantytown',
  c3m4_plantation: 'Plantation',
  c4m1_milltown_a: 'Milltown',
  c4m2_sugarmill_a: 'Sugar Mill',
  c4m3_sugarmill_b: 'Sugar Mill',
  c4m4_milltown_b: 'Milltown Return',
  c4m5_milltown_escape: 'Milltown Escape',
  c5m1_waterfront: 'Waterfront',
  c5m2_park: 'Park',
  c5m3_cemetery: 'Cemetery',
  c5m4_quarter: 'Quarter',
  c5m5_bridge: 'Bridge',
  c6m1_riverbank: 'The Riverbank',
  c6m2_bedlam: 'Underground',
  c6m3_port: 'Port',
  c13m1_alpinecreek: 'Alpine Creek',
  c13m2_southpinestream: 'South Pine Stream',
  c13m3_memorialbridge: 'Memorial Bridge',
  c13m4_cutthroatcreek: 'Cut Throat Creek',
  c14m1_junkyard: 'Junkyard',
  c14m2_lighthouse: 'Lighthouse',
};
```

In `mapName`, replace the `C6M_NAMES` lookup with `DLC4_NAMES`:

```typescript
  if (DLC4_NAMES[lower]) return DLC4_NAMES[lower];
```

Then add, after `mapName`:

```typescript
/**
 * Which chapter of its campaign a map is, read off the map name.
 *
 * Three shapes, because three naming schemes are in play: dlc4's `c1m3_mall`,
 * L4D1's `l4d_vs_airport02_offices`, and custom campaigns which mostly just end
 * in a number (`rombu03`). Null when there is nothing to read, so the caller
 * prints a campaign-qualified label without a number rather than a wrong one.
 */
export function chapterOrdinal(map: string): number | null {
  if (!map) return null;
  const lower = map.toLowerCase();
  const dlc4 = /^c\d+m(\d+)/.exec(lower);
  if (dlc4) return Number(dlc4[1]);
  const l4d1 = /^l4d_(?:vs_)?[a-z]+(\d+)_/.exec(lower);
  if (l4d1) return Number(l4d1[1]);
  const trailing = /(\d+)$/.exec(lower);
  return trailing ? Number(trailing[1]) : null;
}

/**
 * A map label that identifies itself outside its campaign's own heading.
 *
 * Under a campaign heading a bare chapter name is enough and the campaign name
 * on every row is noise, so this is only for lists that mix campaigns. There it
 * is not cosmetic: Dead Center has a chapter called Streets and so does City of
 * the Dead Redux, Dead Center has a Hotel against the existing Hospital, and
 * Hard Rain's chapters are milltown variants that read almost identically. A
 * bare chapter name stops being a unique label once the dlc4 campaigns are in.
 */
export function qualifiedMapName(map: string, campaignName: string | null): string {
  const chapter = mapName(map);
  if (!campaignName) return chapter;
  const n = chapterOrdinal(map);
  return n === null ? `${campaignName} · ${chapter}` : `${campaignName} ${n} · ${chapter}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run web/src/format.test.ts`
Expected: PASS.

Run: `npm test` and `npx tsc --noEmit`
Expected: PASS, clean. If an existing test asserts `mapName('c6m2_bedlam')`, it still returns `'Underground'`; the table was extended, not changed.

- [ ] **Step 5: Commit**

```bash
git add web/src/format.ts web/src/format.test.ts
git commit -m "Name the 32 dlc4 maps, and qualify a chapter with its campaign

A bare chapter name stops being unique once these land: Dead Center has a
Streets and so does City of the Dead Redux, and Hard Rain's four milltown
chapters read almost identically. Qualified labels are only for lists that
mix campaigns; under a campaign heading the campaign name is noise."
```

---

### Task 8: Qualified labels where campaigns are mixed

**Files:**
- Modify: `src/playerQueries.ts`, `web/src/routes/Profile.tsx`
- Test: `tests/playerQueries.test.ts` (or the nearest existing test covering `playerMapBreakdown` consumers), `web/src/routes/Profile.test.tsx`

**Interfaces:**
- Consumes: `qualifiedMapName` (Task 7), `resolveCampaignForMap` and `campaignDisplayName` from `src/campaignRegistry.ts`.
- Produces: each `byMap` row gains `campaignName: string | null`.

**Enrich in `playerQueries.ts`, not in `playerStats.ts`.** `playerStats.ts` is pure statistics over the database and has no campaign import today; adding one there would pull the registry (and through it `customCampaigns`) into the hot stats path for a presentation concern. `playerQueries.ts` is already the assembly point.

- [ ] **Step 1: Write the failing test**

Server side:

```typescript
  it('tells each by-map row which campaign it belongs to', () => {
    // seed a completed match on a dlc4 map and one on a stock map
    const got = playerProfile(db, ME).byMap;
    const dc = got.find((r) => r.map === 'c1m2_streets');
    expect(dc?.campaignName).toBe('Dead Center');
    const nm = got.find((r) => r.map === 'l4d_vs_hospital01_apartment');
    expect(nm?.campaignName).toBe('No Mercy');
  });

  // An unattributable map must not break the row or invent a campaign.
  it('leaves campaignName null for a map it cannot place', () => {
    const got = playerProfile(db, ME).byMap;
    expect(got.find((r) => r.map === 'de_dust2')?.campaignName).toBeNull();
  });
```

Use the file's existing seeding helpers (`seedMatch` and friends from `tests/playerStats.test.ts`) rather than writing new ones, and replace `playerProfile` with whatever the real exported name in `playerQueries.ts` is.

Web side, in `web/src/routes/Profile.test.tsx`:

```typescript
  it('qualifies by-map rows with their campaign', async () => {
    renderProfile({ byMap: [
      { map: 'c1m2_streets', campaignName: 'Dead Center', games: 3, wins: 1, losses: 2 },
    ] });
    expect(await screen.findByText(/Dead Center 2 · Streets/)).toBeTruthy();
  });
```

Mirror the file's existing render helper and row shape exactly.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/playerQueries.test.ts web/src/routes/Profile.test.tsx`
Expected: FAIL. `campaignName` is undefined and the row renders the bare name.

- [ ] **Step 3: Write minimal implementation**

In `src/playerQueries.ts`, at line 146, replace:

```typescript
    byMap: playerMapBreakdown(db, steamid),
```

with:

```typescript
    // Campaign resolved here rather than inside playerMapBreakdown: that module
    // is pure statistics over the database and has no campaign import, and
    // pulling the registry into it for a presentation concern would drag
    // customCampaigns into the stats path too.
    byMap: playerMapBreakdown(db, steamid).map((r) => {
      const slug = resolveCampaignForMap(db, r.map);
      return { ...r, campaignName: slug ? campaignDisplayName(db, slug) : null };
    }),
```

and import `resolveCampaignForMap` and `campaignDisplayName` from `./campaignRegistry.js`.

Add `campaignName: string | null` to whatever type describes a by-map row in the profile response.

In `web/src/routes/Profile.tsx`, change the `BarRow` name prop:

```typescript
                    name={qualifiedMapName(r.map, r.campaignName ?? null)}
```

and add `qualifiedMapName` to the import from `../format`.

**Do not change the campaign stats table.** Under a campaign heading the campaign name on every row is noise, and the owner asked for this only where campaigns are mixed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/playerQueries.test.ts web/src/routes/Profile.test.tsx`
Expected: PASS.

Run: `npm test` and `npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/playerQueries.ts web/src/routes/Profile.tsx tests/ web/src/routes/Profile.test.tsx
git commit -m "Qualify by-map rows with their campaign

The by-map list mixes every campaign a player has touched, so a bare chapter
name there identifies nothing. Resolved server side because the client has
no way to look up a custom campaign's name."
```

---

### Task 9: Upload the mappack to R2

**Files:**
- Create: `scripts/upload-mappack.ts`
- Test: manual, documented below. No unit test: this is a one-shot operator script whose only logic is argument handling, and `src/r2.ts` is already covered.

**Interfaces:**
- Consumes: `loadR2Config` and `put` from `src/r2.ts` (read the file for the exact exported names before writing).
- Produces: an object at `mappack/L4D2-Maps-for-L4D1-v3.1e.zip`.

**A single PUT is correct here:** `put()` streams from disk with `UNSIGNED-PAYLOAD`, and R2's single-PUT ceiling is 5 GB against this file's 3.4 GB. No multipart needed.

- [ ] **Step 1: Write the script**

Create `scripts/upload-mappack.ts`, modelled on `scripts/upload-overviews.ts` (read it first and match its config loading, error messages and exit codes):

```typescript
/**
 * Put the L4D2 mappack in R2 for players to download.
 *
 * One object, uploaded once per pack version. The inner zip of the gamemaps
 * download, not the wrapper: the wrapper holds a ReadMe, two JPGs and this
 * file, so hosting it would make every player unzip twice for no gain.
 *
 * Usage: npx tsx scripts/upload-mappack.ts <path-to-l4d2-in-l4d1.zip>
 */
const KEY = 'mappack/L4D2-Maps-for-L4D1-v3.1e.zip';
```

The body: load the R2 config, exit 1 with the same message `upload-overviews.ts` uses when it is missing, `stat` the local file and refuse anything under 3 GB (a truncated download is the failure worth catching), `put()` it with `contentType: 'application/zip'`, a one year immutable `cacheControl` since the version is in the key, and `contentDisposition` naming `L4D2-Maps-for-L4D1-v3.1e.zip`. Then read the size back with the module's existing size helper and refuse to report success unless it matches the local size.

- [ ] **Step 2: Verify it fails safely with no credentials**

Run: `npx tsx scripts/upload-mappack.ts /tmp/nope.zip`
Expected: exits non-zero naming the missing env vars, and does not throw a stack trace.

- [ ] **Step 3: Verify the size guard**

Run: `head -c 1000000 ~/Downloads/l4d2onl4d1/l4d2-in-l4d1.zip > /tmp/short.zip && npx tsx scripts/upload-mappack.ts /tmp/short.zip`
Expected: refuses, naming the size. Nothing uploaded.

- [ ] **Step 4: Commit**

```bash
git add scripts/upload-mappack.ts
git commit -m "Add a script to put the L4D2 mappack in R2

Uploads the inner zip rather than the gamemaps wrapper, so players unzip
once. A single PUT is enough: R2 takes 5 GB and this is 3.4 GB."
```

**The real upload is an operator step, not part of this task.** It needs the owner's go-ahead and runs from the box where the R2 credentials live. See the Runbook.

---

### Task 10: The install guide on How to Play

**Files:**
- Modify: `web/src/routes/HowToPlay.tsx`
- Test: `web/src/routes/HowToPlay.test.tsx` if one exists; otherwise no test, this is static copy.

**Interfaces:**
- Consumes: the R2 public URL for the key from Task 9.
- Produces: nothing other code reads.

The approved content is the published guide at https://claude.ai/artifact/LFPudYpTrvPhjB9w3KjycQ. Port it into the existing page's components and classes rather than pasting its stylesheet; it was written against this site's own tokens so the structure maps directly.

- [ ] **Step 1: Read the existing page**

Read `web/src/routes/HowToPlay.tsx` in full and note the component it uses for a section, a step list, a callout and a code sample. Reuse those. Do not introduce new styling.

- [ ] **Step 2: Write the section**

Five steps in this order, and do not reorder them:

1. Download `L4D2-Maps-for-L4D1-v3.1e.zip`, 3.4 GB, linking the R2 URL.
2. Open the Left 4 Dead folder: Steam, right-click Left 4 Dead, Manage, Browse local files. Say what they should see (`left4dead` and `hl2`) so they know they are in the right place.
3. Drag everything from the zip in and say yes to replacing. Say what they end up with (`left4dead_dlc4` beside `left4dead`).
4. Options, Video, Advanced, Shader Detail, Medium or lower, **in a warning callout**. The pack's ReadMe buries this at step 4 of 5, but on High these maps crash, so it gets visual weight.
5. Verify with `map c1m1_hotel` in console, and say what a failure means (files in the wrong folder, redo step 2).

Then three collapsed details, matching the existing page's pattern if it has one:

- **Previous install:** delete the old `left4dead_dlc4`, and delete `thelaststand.vpk` and `[L4D] Campaign pack l4d2.vpk` from `left4dead\addons`.
- **Turning it off:** comment the dlc4 line in `left4dead\gameinfo.txt` with `//`, showing the SearchPaths block.
- **Version check:** `left4dead_dlc4\dlc4_version.inf`, first line `DLCVersion=`, ours is v3.1e.

- [ ] **Step 3: Check it renders**

Run: `npm run dev` and open the How to Play page. Confirm the steps read in order, the warning stands out, and the page still works at phone width.

- [ ] **Step 4: Run the suite**

Run: `npm test` and `npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/HowToPlay.tsx
git commit -m "Add the L4D2 mappack install guide to How to Play

Five steps. Shader Detail gets a warning callout rather than the ReadMe's
buried step 4, because on High these maps crash, and a verification step
was added because 'did it work' with no answer generates the support
traffic this page exists to prevent."
```

---

## Runbook: the server-side work

**None of this is a code task and none of it may run without the owner's explicit go-ahead each time.** Players are often on these boxes.

### R1. Riverside sftp rows

Unblocks publishing to all four servers, and is independent of everything else. The sftp transport is already live on the box; only the rows were never filled in.

For servers 3 and 4, set `addons_transport='sftp'`, `ftp_host='66.59.208.5'`, `ftp_user='l4d'`, `ssh_key_path='/home/pug/.ssh/id_riverside_addons'`, and `addons_dir` to `/home/l4d/l4d1-a/left4dead/addons` and `/home/l4d/l4d1-b/left4dead/addons` respectively.

Back up `/home/pug/app/data/pug.db` first. Verify by hitting Reinstall on an already-published campaign and watching both rows reach `installed`.

Then re-check City 17: its install rows for servers 3 and 4 were written by hand during an earlier cleanup, so the database claims Riverside has it and a re-upload would not actually reach those boxes.

### R2. dlc4 onto Riverside

`rsync` `left4dead_dlc4/` from Dallas to `/home/l4d/shared/left4dead_dlc4` over the pug key, then point each instance's `left4dead_dlc4` at it with a symlink. 94 GB free, so space is not a concern.

Add `Game left4dead_dlc4` to each instance's `left4dead/gameinfo.txt` as the **first** search path, above `left4dead_dlc3`.

### R3. dlc4 onto Chicago

Push over FTP with `ftpsync.py`. Takes the box from 9.26 GB to about 15.3 GB against a hard 20 GB cap. Same `gameinfo.txt` edit.

If headroom is wanted first, Chicago carries about 1.25 GB of localized audio it will never use (`left4dead_french`, `german`, `russian`, `spanish` at 270 MB each, plus thirteen smaller). `ftpsync.py` never deletes, so that is a by-hand job and needs its own go-ahead.

### R4. Mission file parity

**Every server must carry identical mission files.** pug-web reads them from Dallas's disk and assumes the others agree. Dallas's `ThePassing.txt` is the Passifice five-chapter override, and Riverside already matches it; Chicago will get whatever is pushed. Confirm all four match after R2 and R3.

`install-mappack.sh` re-copies dlc4 wholesale and deletes the Passifice override, so it must not be re-run on a live box without re-running `deploy.sh` afterwards.

### R5. Restart

R2, R3 and R4 all need a restart to take effect, so they happen on empty servers.

### R6. Set the config and deploy the web app

Add to `/home/pug/app/.env`:

```
MISSIONS_DIR=/home/l4d/l4d1-server/left4dead/missions
DLC4_MISSIONS_DIR=/home/l4d/l4d1-server/left4dead_dlc4/missions
```

**`MISSIONS_DIR` is not currently set at all**, which is a live bug independent of this work: `readStockMissions` returns empty, so the stock four have no chapter list, `stopAfterMap()` returns null before it reads `getMapsToPlay`, and the admin "maps to play" setting is silently inert for No Mercy, Death Toll, Dead Air and Blood Harvest. Setting these paths fixes that too, so check that setting on a stock campaign afterwards.

Then `./deploy-web.sh`.

### R7. Probe, then upload, then tick

Run the dlc4 check from the admin panel and confirm all four servers report the pack. Run `scripts/upload-mappack.ts` from the box. Then the owner ticks campaigns into the pool.

### R8. First match

Before ticking anything, run one full Dead Center match on each server and confirm chapter transitions, score carry, and that the match closes with its maps attributed to `dead_center`.

---

## Out of scope

- Overviews for the 32 new maps. `overviewFor()` returns null and the viewer auto-fits.
- Extending the file-consistency enforced list to dlc4 content.
- Which campaigns are ticked into the pool, including whether The Passing goes in at all given that `c6m2_bedlam` segfaults about half its loads, and whether The Last Stand's two chapters want a `campaign_play_rules` entry.
- Any client-readiness detection. The owner decided against it.
