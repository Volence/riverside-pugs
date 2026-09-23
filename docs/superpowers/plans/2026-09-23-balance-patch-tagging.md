# Balance Patch Tagging (piece 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every PUG round records which balance configuration it was played on, config drift between the four servers raises an admin alert, and the plugin starts sending the per-round data the metrics engine (piece 2) needs.

**Architecture:** The plugin sends an inventory of its balance-relevant state (watched cvars, loaded plugins with content hashes, hashed config files) as a few `BALANCE` lines at every go-live. The backend reassembles them, computes a fingerprint, upserts a `balance_patches` row, tags the round, and compares the server's inventory with its previous one and with the other servers. The same plugin release adds `ROUND_STAT` (per-round per-player deltas including per-weapon damage and kills) and `ROUND_MARK` (panic and finale markers).

**Tech Stack:** SourcePawn 1.12 (plugin, compiled by `plugin/build.sh` under wine), TypeScript + better-sqlite3 + Fastify (backend), Preact (admin page), vitest.

**Spec:** `docs/superpowers/specs/2026-09-23-balance-analytics-design.md` (sections "1. Patch tagging" and "Plugin additions").

## Global Constraints

- No em dashes anywhere: code, comments, docs, commit messages.
- Every `db` function takes `db: DB` as its first argument; there is no global handle.
- Schema changes go in `openDb` (`src/db.ts`) using `CREATE TABLE IF NOT EXISTS` and `ensureColumn`; no migration framework.
- Every admin route starts with `requireAdmin` and every admin change ends with `logAdmin`.
- Plugin strings built at runtime are emitted as `EmitPug("%s", line)`, never as the format string.
- A plugin line body stays under 600 bytes (the `EmitSkillLive` rule), because `EmitPug` caps the body at 767 and truncates silently.
- A missing value is absent, never zero (stats that need skill_detect are omitted when it is not loaded).
- Work only in the worktree `/home/volence/l4d/pug/.claude/worktrees/balance-analytics` on branch `worktree-balance-analytics`. Other sessions rewrite master.
- Nothing is deployed by this plan's tasks. Task 14 is the ship checklist and needs the owner's standing "deploy when empty" rules (server empty, checked with an A2S query).

## Decisions made while planning (deviations from the spec, all small)

1. **Plugins are identified by content hash, not mtime.** FTP uploads to Chicago reset mtime, so mtime would report false drift. The plugin hashes file contents with FNV-1a 32 (about 3 operations per byte, fast enough for ~3 MB at map start; SHA-1 in pure SourcePawn is roughly 20 times slower). This is change detection, not security, so a non-cryptographic hash is fine. The cache is keyed by (filename, size, mtime) so an unchanged file is not rehashed on every map.
2. **Per-map stripper configs are hashed as one directory entry**, not "the current map's file". Hashing only the current map's file would make every map its own patch.
3. **The fingerprint ignores versions of non-balance plugins** listed in `balance/knobs.json` `versionless` (pug-match, anti-cheat, telemetry). Their presence still counts. Otherwise every pug-match deploy would start a new "patch". The drift alert still compares the FULL inventory, so a server running an older pug-match is still reported.
4. **Game type:** `matches` has no type today, and standalone `!mix` sessions never become matches (their lines are dropped at the listener). This plan adds `matches.origin` = `'queue'` (created by the matchmaker) or `'in_game'` (self-started or auto-tracked). Standalone mixes are not counted, which matches what the backend records today anyway.
5. **Finales are rarely inside a match** (a match ends before the finale loads), so the `finale_*` markers will be rare. Panic events are the main content of the `event` phase.
6. **The admin alert reuses the existing `problem` feed kind**, so no new Discord plumbing is needed.
7. **The patch number is computed on read** (`ROW_NUMBER() OVER (ORDER BY first_seen_at, id)`), not stored, so historical patches inserted later still number in time order.

## File map

| File | Responsibility |
|---|---|
| `balance/knobs.json` | The watched list: cvars, files, directories, versionless plugins |
| `src/balanceKnobs.ts` | Load and validate knobs.json; render the plugin include |
| `scripts/gen-balance-list.ts` | Writes `plugin/pug-balance-list.inc` from knobs.json |
| `plugin/pug-balance-list.inc` | GENERATED. Cvar, file and dir lists for the plugin |
| `plugin/pug-balance.inc` | Inventory scan (hashing), BALANCE emission |
| `plugin/pug-roundstats.inc` | Per-round deltas, per-weapon counters, ROUND_STAT, ROUND_MARK |
| `src/logParse.ts` | Parse BALANCE, BALANCE_END, ROUND_STAT, ROUND_STATS_END, ROUND_MARK |
| `src/balanceAssembler.ts` | Pure in-memory reassembly of BALANCE parts |
| `src/balance.ts` | Fingerprint, inventory diff, record a patch sighting, alert text, queries |
| `src/roundStats.ts` | Store ROUND_STAT, ROUND_STATS_END, ROUND_MARK |
| `src/db.ts` | New tables and columns, origin backfill |
| `src/matchmaker.ts`, `src/selfStarted.ts` | Stamp `matches.origin` |
| `src/mergePlayers.ts` | Include `match_round_stats` |
| `src/server.ts` | Wire the new kinds |
| `scripts/backfill-historical-patches.ts` | Create historical patches and tag old rounds |
| `src/routes/admin.ts` | Patch and drift API |
| `web/src/api.ts`, `web/src/routes/admin/adminRoutes.ts`, `web/src/routes/Admin.tsx`, `web/src/routes/admin/AdminPatches.tsx` | Admin "Patches" tab |

## Wire grammar (shared by plugin and backend)

```
BALANCE half=<1|2> part=<0..> <item> <item> ...
BALANCE_END half=<1|2> parts=<N> items=<M>
ROUND_STAT half=<1|2> steamid=<17 digits> <key>=<int> ...
ROUND_STATS_END half=<1|2> players=<N> sd=<0|1>
ROUND_MARK half=<1|2> kind=<panic|finale_start|finale_radio> t=<ms>
```

Item keys carry a one-letter prefix so they can never collide with `half` or `part`:

- `c:<cvar>=<value>`: a watched cvar's current value
- `x:<cvar>=missing`: a watched cvar that does not exist on this server
- `p:<plugin file relative to plugins/>=<size>.<fnv hex8>`: a RUNNING plugin
- `f:<path relative to the game dir>=<size>.<fnv hex8>` or `=missing`
- `d:<dir relative to the game dir>=<file count>.<fnv hex8>`: all files with the listed extension, names sorted, each name and content folded into one hash

Values and keys are percent-encoded for exactly two characters: `%` becomes `%25` and space becomes `%20`. Nothing else is encoded.

---

### Task 1: Watched list and generated plugin include

**Files:**
- Create: `balance/knobs.json`
- Create: `src/balanceKnobs.ts`
- Create: `scripts/gen-balance-list.ts`
- Create (generated): `plugin/pug-balance-list.inc`
- Test: `tests/balanceKnobs.test.ts`

**Interfaces:**
- Produces: `interface BalanceKnobs { cvars: { cvar: string; label: string; group: string; min?: number; max?: number }[]; files: { path: string; label: string }[]; dirs: { path: string; ext: string; label: string }[]; versionless: string[] }`, `loadBalanceKnobs(path?: string): BalanceKnobs`, `renderBalanceListInc(k: BalanceKnobs): string`, `BALANCE_KNOBS_PATH: string`.

- [ ] **Step 1: Write `balance/knobs.json`**

```json
{
  "cvars": [
    { "cvar": "z_tank_health", "label": "Tank base health", "group": "tank" },
    { "cvar": "versus_tank_bonus_health", "label": "Tank versus health multiplier", "group": "tank" },
    { "cvar": "z_tank_speed_vs", "label": "Tank speed (versus)", "group": "tank" },
    { "cvar": "z_tank_damage_slow_min_range", "label": "Tank slow min range", "group": "tank" },
    { "cvar": "z_tank_damage_slow_max_range", "label": "Tank slow max range", "group": "tank" },
    { "cvar": "l4d_tank_burn_cap", "label": "Tank burn damage cap", "group": "tank" },
    { "cvar": "z_witch_health", "label": "Witch health", "group": "witch" },
    { "cvar": "z_witch_speed", "label": "Witch speed", "group": "witch" },
    { "cvar": "z_witch_damage_per_kill_hit", "label": "Witch damage per hit", "group": "witch" },
    { "cvar": "z_pounce_damage", "label": "Pounce damage", "group": "hunter" },
    { "cvar": "z_pounce_damage_interrupt", "label": "Damage to interrupt a pounce", "group": "hunter" },
    { "cvar": "z_pounce_stumble_radius", "label": "Pounce stumble radius", "group": "hunter" },
    { "cvar": "versus_shove_hunter_fov_pouncing", "label": "Shove FOV vs pouncing hunter", "group": "hunter" },
    { "cvar": "l4d_skypounce_enable", "label": "Sky pounce fix enabled", "group": "hunter" },
    { "cvar": "l4d_skypounce_mode", "label": "Sky pounce fix mode", "group": "hunter" },
    { "cvar": "z_vomit_interval", "label": "Boomer vomit interval", "group": "boomer" },
    { "cvar": "tongue_hit_delay", "label": "Tongue cooldown", "group": "smoker" },
    { "cvar": "tongue_break_from_damage_amount", "label": "Damage to break a tongue", "group": "smoker" },
    { "cvar": "tongue_choke_damage_amount", "label": "Choke damage", "group": "smoker" },
    { "cvar": "tongue_drag_damage_amount", "label": "Drag damage", "group": "smoker" },
    { "cvar": "z_ghost_delay_minspawn", "label": "Minimum ghost spawn delay", "group": "infected" },
    { "cvar": "z_mob_spawn_min_size", "label": "Horde min size", "group": "horde" },
    { "cvar": "z_mob_spawn_max_size", "label": "Horde max size", "group": "horde" },
    { "cvar": "z_mob_spawn_min_interval_normal", "label": "Horde min interval", "group": "horde" },
    { "cvar": "z_mob_spawn_max_interval_normal", "label": "Horde max interval", "group": "horde" },
    { "cvar": "l4d_antibaiter_delay", "label": "Anti-bait delay", "group": "horde" },
    { "cvar": "l4d_antibaiter_horde_timer", "label": "Anti-bait horde timer", "group": "horde" },
    { "cvar": "survivor_max_incapacitated_count", "label": "Incaps before black and white", "group": "survivor" },
    { "cvar": "survivor_revive_duration", "label": "Revive duration", "group": "survivor" },
    { "cvar": "survivor_ledge_grab_health", "label": "Ledge hang health", "group": "survivor" },
    { "cvar": "rotoblin_health_style", "label": "Rotoblin health style", "group": "items" },
    { "cvar": "rotoblin_weapon_style", "label": "Rotoblin weapon style", "group": "items" },
    { "cvar": "rotoblin_limit_pumpshotgun", "label": "Pump shotgun limit", "group": "items" },
    { "cvar": "rotoblin_limit_autoshotgun", "label": "Auto shotgun limit", "group": "items" },
    { "cvar": "rotoblin_limit_smg", "label": "Uzi limit", "group": "items" },
    { "cvar": "rotoblin_limit_rifle", "label": "Rifle limit", "group": "items" },
    { "cvar": "rotoblin_limit_huntingrifle", "label": "Hunting rifle limit", "group": "items" },
    { "cvar": "director_pain_pill_density", "label": "Pill density", "group": "items" },
    { "cvar": "versus_boss_flow_min", "label": "Boss flow min", "group": "bosses" },
    { "cvar": "versus_boss_flow_max", "label": "Boss flow max", "group": "bosses" },
    { "cvar": "versus_tank_chance", "label": "Tank chance", "group": "bosses" },
    { "cvar": "versus_witch_chance", "label": "Witch chance", "group": "bosses" },
    { "cvar": "l4d_saferoom_lock", "label": "Saferoom lock enabled", "group": "map" }
  ],
  "files": [
    { "path": "addons/sourcemod/data/l4d_info_editor_weapons.cfg", "label": "Weapon stat overrides" },
    { "path": "addons/stripper/Roto-AZMod/global_filters.cfg", "label": "Stripper global filters" },
    { "path": "cfg/rotoblin_pug_4v4.cfg", "label": "4v4 match config" },
    { "path": "cfg/rotoblin_pug_4v4_map.cfg", "label": "4v4 per-map config" },
    { "path": "cfg/pug_match.cfg", "label": "PUG match config" },
    { "path": "cfg/Reloadables/server_custom_convars.cfg", "label": "Custom convars" },
    { "path": "cfg/server_shared_convars.cfg", "label": "Shared convars" }
  ],
  "dirs": [
    { "path": "addons/stripper/Roto-AZMod/maps", "ext": ".cfg", "label": "Stripper per-map configs" }
  ],
  "versionless": [
    "pug-match.smx", "lilac.smx", "lilac_report.smx", "l4d_inputstats.smx",
    "l4d_cvarwatch.smx", "l4d_consistency.smx", "l4d_tickstats.smx", "l4d_ping.smx"
  ]
}
```

Before committing, check each `versionless` filename against the live plugin list in `deploy/snapshots` or the Dallas `plugins/` directory listing in the deploy repo (`/home/volence/l4d/deploy`), and correct any name that differs. A wrong name here only means that plugin's updates count as patches, which is noisy but safe.

- [ ] **Step 2: Write the failing test**

```ts
// tests/balanceKnobs.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadBalanceKnobs, renderBalanceListInc, BALANCE_KNOBS_PATH } from '../src/balanceKnobs.js';

describe('balance knobs', () => {
  it('loads and validates the checked-in list', () => {
    const k = loadBalanceKnobs(BALANCE_KNOBS_PATH);
    expect(k.cvars.length).toBeGreaterThan(10);
    expect(k.cvars.every((c) => /^[a-z0-9_]{1,63}$/.test(c.cvar))).toBe(true);
    expect(new Set(k.cvars.map((c) => c.cvar)).size).toBe(k.cvars.length);
  });

  it('rejects a path with a space or a leading slash', () => {
    const bad = { cvars: [], files: [{ path: '/etc/passwd', label: 'x' }], dirs: [], versionless: [] };
    expect(() => loadBalanceKnobs(undefined, bad)).toThrow(/path/);
  });

  it('the checked-in plugin include matches knobs.json', () => {
    const k = loadBalanceKnobs(BALANCE_KNOBS_PATH);
    const onDisk = readFileSync(new URL('../plugin/pug-balance-list.inc', import.meta.url), 'utf8');
    expect(onDisk).toBe(renderBalanceListInc(k));
  });
});
```

- [ ] **Step 3: Run it and see it fail**

Run: `npx vitest run tests/balanceKnobs.test.ts`
Expected: FAIL, cannot find module `../src/balanceKnobs.js`.

- [ ] **Step 4: Implement `src/balanceKnobs.ts`**

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface BalanceKnobs {
  cvars: { cvar: string; label: string; group: string; min?: number; max?: number }[];
  files: { path: string; label: string }[];
  dirs: { path: string; ext: string; label: string }[];
  versionless: string[];
}

export const BALANCE_KNOBS_PATH = fileURLToPath(new URL('../balance/knobs.json', import.meta.url));

const CVAR_RE = /^[a-z0-9_]{1,63}$/;
// Relative, forward slashes, no spaces, no parent traversal.
const PATH_RE = /^(?!\/)(?!.*\.\.)[A-Za-z0-9_\-./]{1,200}$/;

/** Load and validate the watched list. `raw` lets tests validate an object
 *  without touching the disk. Throws on anything the plugin could not use. */
export function loadBalanceKnobs(path: string = BALANCE_KNOBS_PATH, raw?: unknown): BalanceKnobs {
  const k = (raw ?? JSON.parse(readFileSync(path, 'utf8'))) as BalanceKnobs;
  for (const c of k.cvars) if (!CVAR_RE.test(c.cvar)) throw new Error(`bad cvar name: ${c.cvar}`);
  for (const f of k.files) if (!PATH_RE.test(f.path)) throw new Error(`bad file path: ${f.path}`);
  for (const d of k.dirs) {
    if (!PATH_RE.test(d.path)) throw new Error(`bad dir path: ${d.path}`);
    if (!/^\.[a-z0-9]{1,8}$/.test(d.ext)) throw new Error(`bad dir ext: ${d.ext}`);
  }
  if (new Set(k.cvars.map((c) => c.cvar)).size !== k.cvars.length) throw new Error('duplicate cvar');
  return k;
}

/** The plugin include. Deterministic, so the parity test can compare bytes. */
export function renderBalanceListInc(k: BalanceKnobs): string {
  const arr = (name: string, items: string[]) =>
    `static const char ${name}[][] = {\n${items.map((s) => `\t"${s}"`).join(',\n')}\n};\n`;
  return [
    '// GENERATED by scripts/gen-balance-list.ts from balance/knobs.json. Do not edit.',
    '// tests/balanceKnobs.test.ts fails when this file and knobs.json disagree.',
    '',
    arr('g_sBalCvars', k.cvars.map((c) => c.cvar)),
    arr('g_sBalFiles', k.files.map((f) => f.path)),
    arr('g_sBalDirs', k.dirs.map((d) => d.path)),
    arr('g_sBalDirExt', k.dirs.map((d) => d.ext)),
  ].join('\n');
}
```

- [ ] **Step 5: Implement `scripts/gen-balance-list.ts` and generate the include**

```ts
import { writeFileSync } from 'node:fs';
import { loadBalanceKnobs, renderBalanceListInc } from '../src/balanceKnobs.js';

const out = new URL('../plugin/pug-balance-list.inc', import.meta.url);
writeFileSync(out, renderBalanceListInc(loadBalanceKnobs()));
console.log('wrote', out.pathname);
```

Run: `npx tsx scripts/gen-balance-list.ts`
Expected: `wrote .../plugin/pug-balance-list.inc`

- [ ] **Step 6: Run the tests and see them pass**

Run: `npx vitest run tests/balanceKnobs.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add balance/knobs.json src/balanceKnobs.ts scripts/gen-balance-list.ts plugin/pug-balance-list.inc tests/balanceKnobs.test.ts
git commit -m "balance: watched list and generated plugin include"
```

---

### Task 2: Plugin inventory scan and BALANCE emission

**Files:**
- Create: `plugin/pug-balance.inc`
- Modify: `plugin/pug-match.sp` (include after `pug-stats.inc` at :292; call from `OnMapStart` :2917 and from the go-live block after `EmitPug("ROUND_START ...")` at :3150)
- Modify: `plugin/build.sh` (add both new `.inc` files to the `cp` list at :8-17 and to `CLEANUP` at :23)
- Modify: `plugin/README.md` (wire grammar section, :104-222)

**Interfaces:**
- Consumes: `g_sBalCvars`, `g_sBalFiles`, `g_sBalDirs`, `g_sBalDirExt` from Task 1; `EmitPug`, `g_iHalf`.
- Produces: `void BalanceScanStatic()` (map start), `void EmitBalance()` (go-live); the wire lines in the grammar above.

- [ ] **Step 1: Write `plugin/pug-balance.inc`**

```c
// Balance inventory: what this server is running, sent at every go-live so
// the backend can tag the round with a patch and spot drift between servers.
// See docs/superpowers/specs/2026-09-23-balance-analytics-design.md.
//
// Files are hashed with FNV-1a 32, not SHA-1: this is change detection, not
// security, and pure-SourcePawn SHA-1 is about twenty times slower per byte.
// The static part (plugins, files, dirs) is scanned at map start and cached by
// (name, size, mtime), so an unchanged file is read once per server boot.

#include "pug-balance-list.inc"

#define BAL_FNV_OFFSET -2128831035   // 0x811C9DC5 as a signed cell
#define BAL_FNV_PRIME  16777619
#define BAL_LINE_MAX   600

ArrayList g_hBalStatic;      // "p:..=..", "f:..=..", "d:..=.." items, rebuilt each map
StringMap g_hBalCache;       // path -> "size.mtime.hash8" so unchanged files are not reread
int g_iBalBuf[4096];         // global, not local: 16 KB is too big for the plugin stack

static int BalFold(int h, int b)
{
	h ^= (b & 0xFF);
	return h * BAL_FNV_PRIME;
}

static int BalFoldString(int h, const char[] s)
{
	for (int i = 0; s[i] != '\0'; i++) h = BalFold(h, s[i]);
	return h;
}

/** Fold a file's bytes into h. Returns the byte count, or -1 if unreadable. */
static int BalFoldFile(const char[] path, int &h)
{
	File f = OpenFile(path, "rb");
	if (f == null) return -1;
	int size = 0, n;
	while ((n = f.Read(g_iBalBuf, sizeof(g_iBalBuf), 1)) > 0)
	{
		for (int i = 0; i < n; i++) h = BalFold(h, g_iBalBuf[i]);
		size += n;
	}
	delete f;
	return size;
}

/** "size.hash8" for one file, from the cache when size and mtime are unchanged. */
static bool BalFileValue(const char[] path, char[] out, int maxlen)
{
	if (!FileExists(path)) return false;
	int size = FileSize(path);
	int mtime = GetFileTime(path, FileTime_LastChange);
	char cached[64], keyv[32];
	Format(keyv, sizeof(keyv), "%d.%d.", size, mtime);
	if (g_hBalCache.GetString(path, cached, sizeof(cached)) && StrContains(cached, keyv) == 0)
	{
		Format(out, maxlen, "%d.%s", size, cached[strlen(keyv)]);
		return true;
	}
	int h = BAL_FNV_OFFSET;
	int got = BalFoldFile(path, h);
	if (got < 0) return false;
	Format(cached, sizeof(cached), "%s%08x", keyv, h);
	g_hBalCache.SetString(path, cached);
	Format(out, maxlen, "%d.%08x", got, h);
	return true;
}

/** Percent-encode exactly '%' and ' ' (the backend decodes exactly those). */
static void BalEncode(const char[] src, char[] dst, int maxlen)
{
	int j = 0;
	for (int i = 0; src[i] != '\0' && j < maxlen - 4; i++)
	{
		if (src[i] == '%') { dst[j++] = '%'; dst[j++] = '2'; dst[j++] = '5'; }
		else if (src[i] == ' ') { dst[j++] = '%'; dst[j++] = '2'; dst[j++] = '0'; }
		else dst[j++] = src[i];
	}
	dst[j] = '\0';
}

static void BalPush(const char[] prefix, const char[] key, const char[] value)
{
	char k[256], v[128], item[400];
	BalEncode(key, k, sizeof(k));
	BalEncode(value, v, sizeof(v));
	Format(item, sizeof(item), "%s:%s=%s", prefix, k, v);
	g_hBalStatic.PushString(item);
}

/** Map start: plugins, listed files and listed directories. */
void BalanceScanStatic()
{
	if (g_hBalStatic == null) g_hBalStatic = new ArrayList(ByteCountToCells(400));
	if (g_hBalCache == null) g_hBalCache = new StringMap();
	g_hBalStatic.Clear();
	float t0 = GetEngineTime();

	char name[PLATFORM_MAX_PATH], path[PLATFORM_MAX_PATH], value[64];
	Handle it = GetPluginIterator();
	while (MorePlugins(it))
	{
		Handle pl = ReadPlugin(it);
		if (GetPluginStatus(pl) != Plugin_Running) continue;
		GetPluginFilename(pl, name, sizeof(name));
		BuildPath(Path_SM, path, sizeof(path), "plugins/%s", name);
		if (BalFileValue(path, value, sizeof(value))) BalPush("p", name, value);
	}
	delete it;

	for (int i = 0; i < sizeof(g_sBalFiles); i++)
	{
		if (!BalFileValue(g_sBalFiles[i], value, sizeof(value))) strcopy(value, sizeof(value), "missing");
		BalPush("f", g_sBalFiles[i], value);
	}

	for (int i = 0; i < sizeof(g_sBalDirs); i++)
	{
		BalScanDir(g_sBalDirs[i], g_sBalDirExt[i], value, sizeof(value));
		BalPush("d", g_sBalDirs[i], value);
	}

	PugDebug("balance scan: %d items in %.1f ms", g_hBalStatic.Length, (GetEngineTime() - t0) * 1000.0);
}

/** "count.hash8" over every file with the extension, names sorted, each name
 *  and its bytes folded in, so a rename, an edit, an add or a delete all show. */
static void BalScanDir(const char[] dir, const char[] ext, char[] out, int maxlen)
{
	ArrayList names = new ArrayList(ByteCountToCells(PLATFORM_MAX_PATH));
	DirectoryListing dl = OpenDirectory(dir);
	if (dl != null)
	{
		char entry[PLATFORM_MAX_PATH];
		FileType ft;
		while (dl.GetNext(entry, sizeof(entry), ft))
		{
			if (ft == FileType_File && StrEndsWith(entry, ext)) names.PushString(entry);
		}
		delete dl;
	}
	names.SortCustom(BalSortNames);
	int h = BAL_FNV_OFFSET;
	char entry2[PLATFORM_MAX_PATH], full[PLATFORM_MAX_PATH];
	for (int i = 0; i < names.Length; i++)
	{
		names.GetString(i, entry2, sizeof(entry2));
		h = BalFoldString(h, entry2);
		h = BalFold(h, 0);
		Format(full, sizeof(full), "%s/%s", dir, entry2);
		BalFoldFile(full, h);
	}
	Format(out, maxlen, "%d.%08x", names.Length, h);
	delete names;
}

static int BalSortNames(int a, int b, ArrayList arr, Handle hndl)
{
	char x[PLATFORM_MAX_PATH], y[PLATFORM_MAX_PATH];
	arr.GetString(a, x, sizeof(x));
	arr.GetString(b, y, sizeof(y));
	return strcmp(x, y);
}

static bool StrEndsWith(const char[] s, const char[] suffix)
{
	int ls = strlen(s), lx = strlen(suffix);
	return ls >= lx && StrEqual(s[ls - lx], suffix, false);
}

/** Append one item, flushing the line first when it would pass BAL_LINE_MAX. */
static void BalAppend(char[] line, int maxlen, const char[] item, int &part, int &items, bool &dirty)
{
	if (dirty && strlen(line) + strlen(item) + 1 > BAL_LINE_MAX)
	{
		EmitPug("%s", line);
		part++;
		Format(line, maxlen, "BALANCE half=%d part=%d", g_iHalf, part);
		dirty = false;
	}
	StrCat(line, maxlen, " ");
	StrCat(line, maxlen, item);
	items++;
	dirty = true;
}

/** Go-live: cvars read now (they can change over rcon between rounds), the
 *  static items as scanned at map start. */
void EmitBalance()
{
	if (g_hBalStatic == null) BalanceScanStatic();
	char line[768], item[400], val[128], enc[256];
	int part = 0, items = 0;
	bool dirty = false;
	Format(line, sizeof(line), "BALANCE half=%d part=%d", g_iHalf, part);

	for (int i = 0; i < sizeof(g_sBalCvars); i++)
	{
		ConVar cv = FindConVar(g_sBalCvars[i]);
		if (cv == null) Format(item, sizeof(item), "x:%s=missing", g_sBalCvars[i]);
		else
		{
			cv.GetString(val, sizeof(val));
			BalEncode(val, enc, sizeof(enc));
			Format(item, sizeof(item), "c:%s=%s", g_sBalCvars[i], enc);
		}
		BalAppend(line, sizeof(line), item, part, items, dirty);
	}
	for (int i = 0; i < g_hBalStatic.Length; i++)
	{
		g_hBalStatic.GetString(i, item, sizeof(item));
		BalAppend(line, sizeof(line), item, part, items, dirty);
	}
	if (dirty) { EmitPug("%s", line); part++; }
	EmitPug("BALANCE_END half=%d parts=%d items=%d", g_iHalf, part, items);
}
```

- [ ] **Step 2: Wire it into `pug-match.sp`**

After `#include "pug-stats.inc"` (:292) add:

```c
#include "pug-balance.inc"
```

At the end of `OnMapStart()` add (the scan is cheap after the first map because of the cache, and doing it here keeps it off the go-live frame):

```c
	BalanceScanStatic();
```

In the go-live block, directly after the two `ROUND_START` `EmitPug` lines (:3149-3150) and before `RosterLateJoiners();`:

```c
		EmitBalance();
```

- [ ] **Step 3: Add the includes to `plugin/build.sh`**

Add `pug-balance.inc pug-balance-list.inc` to the `cp` list and to `CLEANUP`, matching how `pug-stats.inc` appears in both.

- [ ] **Step 4: Compile**

Run: `cd plugin && ./build.sh`
Expected: `pug-match.smx` written, no errors and no new warnings. To tell new warnings from old ones, build a scratch copy of master first and compare the two outputs.

- [ ] **Step 5: Document the grammar**

In `plugin/README.md`, in the wire grammar section, add the five lines from this plan's "Wire grammar" block with the prefix list and the percent-encoding rule, under a heading `### Balance inventory and per-round data`.

- [ ] **Step 6: Commit**

```bash
git add plugin/pug-balance.inc plugin/pug-match.sp plugin/build.sh plugin/README.md
git commit -m "plugin: balance inventory scan and BALANCE lines at go-live"
```

---

### Task 3: Plugin per-round stats, per-weapon counters and markers

**Files:**
- Create: `plugin/pug-roundstats.inc`
- Modify: `plugin/pug-match.sp` (include after `pug-balance.inc`; hooks in the go-live block, `Event_RoundEnd` :3258, `Event_PlayerHurt` :3654-3690, `Event_PlayerDeath` :3789-3794, `Event_InfectedDeath` :3797-3805, and the `HookEventEx` block :481-533)
- Modify: `plugin/build.sh` (add `pug-roundstats.inc`)
- Modify: `tests/eventKindsParity.test.ts` only if it scans includes by list (it scans `pug-match.sp` and `pug-stats.inc`; no change needed because ROUND_MARK is a verb, not an EVENT kind)

**Interfaces:**
- Consumes: `g_iSkill`, `g_sStatKey`, `StatNeedsSkillDetect`, `g_bSkillDetect`, core arrays `g_iStatCk/SiDmg/SiKill/Ff/Rev`, `g_iClientRoster`, `g_sRosterId`, `g_iRosterCount`, `RoundMs()`, `StatsActive()`.
- Produces: `RoundStatsBegin()`, `EmitRoundStats(int half)`, `RoundWpnAdd(int attacker, const char[] weapon, int stat, int amount)`, `RoundWpnAddActive(int attacker, int stat, int amount)`; wire lines `ROUND_STAT`, `ROUND_STATS_END`, `ROUND_MARK`.

- [ ] **Step 1: Write `plugin/pug-roundstats.inc`**

```c
// Per-round data for the balance metrics engine. Match totals already exist;
// what is new is (1) the same counters as per-round deltas, (2) damage and
// kills split by weapon, and (3) panic/finale markers for the event phase.

enum { WS_SiDmg = 0, WS_TankDmg, WS_SiKill, WS_CiKill, WS_MAX }
static const char g_sWsKey[WS_MAX][8] = { "sidmg", "tankdmg", "sikill", "cikill" };

#define WPN_COUNT 9
static const char g_sWpnKey[WPN_COUNT][16] = {
	"pistol", "smg", "pumpshotgun", "autoshotgun", "rifle",
	"hunting_rifle", "molotov", "pipe_bomb", "other"
};

int g_iSkillAtLive[MAX_ROSTER][PS_MAX];
int g_iCoreAtLive[MAX_ROSTER][5];      // ck, sidmg, sikill, ff, rev
int g_iRoundWpn[MAX_ROSTER][WPN_COUNT][WS_MAX];

static int WpnIndex(const char[] raw)
{
	char w[32];
	strcopy(w, sizeof(w), raw);
	ReplaceString(w, sizeof(w), "weapon_", "", false);
	if (StrEqual(w, "inferno") || StrEqual(w, "entityflame") || StrEqual(w, "molotov")) return 6;
	for (int i = 0; i < WPN_COUNT - 1; i++) if (StrEqual(w, g_sWpnKey[i])) return i;
	return WPN_COUNT - 1;
}

/** Go-live: snapshot the match counters so round end can send deltas. */
void RoundStatsBegin()
{
	for (int r = 0; r < MAX_ROSTER; r++)
	{
		for (int s = 0; s < view_as<int>(PS_MAX); s++) g_iSkillAtLive[r][s] = g_iSkill[r][s];
		g_iCoreAtLive[r][0] = g_iStatCk[r];
		g_iCoreAtLive[r][1] = g_iStatSiDmg[r];
		g_iCoreAtLive[r][2] = g_iStatSiKill[r];
		g_iCoreAtLive[r][3] = g_iStatFf[r];
		g_iCoreAtLive[r][4] = g_iStatRev[r];
		for (int w = 0; w < WPN_COUNT; w++) for (int k = 0; k < WS_MAX; k++) g_iRoundWpn[r][w][k] = 0;
	}
}

void RoundWpnAdd(int attacker, const char[] weapon, int stat, int amount)
{
	if (!StatsActive() || attacker < 1 || attacker > MaxClients) return;
	int slot = g_iClientRoster[attacker];
	if (slot == -1) return;
	g_iRoundWpn[slot][WpnIndex(weapon)][stat] += amount;
}

/** For events that carry no weapon (infected_death): the attacker's held gun. */
void RoundWpnAddActive(int attacker, int stat, int amount)
{
	if (attacker < 1 || attacker > MaxClients || !IsClientInGame(attacker)) return;
	char w[32];
	GetClientWeapon(attacker, w, sizeof(w));
	RoundWpnAdd(attacker, w, stat, amount);
}

static void RsAppend(char[] line, int maxlen, const char[] prefix, const char[] kv)
{
	if (strlen(line) + strlen(kv) > 600)
	{
		EmitPug("%s", line);
		strcopy(line, maxlen, prefix);
	}
	StrCat(line, maxlen, kv);
}

/** Round end, called synchronously right after g_bRoundEnded latches, so the
 *  counters are frozen and the round's half is still current. Only nonzero
 *  values go out; ROUND_STATS_END carries sd= so the backend can tell
 *  "skill_detect absent" from "zero". */
void EmitRoundStats(int half)
{
	static const char coreKey[5][8] = { "ck", "sidmg", "sikill", "ff", "rev" };
	int players = 0;
	for (int r = 0; r < g_iRosterCount; r++)
	{
		char prefix[64], line[768], kv[48];
		Format(prefix, sizeof(prefix), "ROUND_STAT half=%d steamid=%s", half, g_sRosterId[r]);
		strcopy(line, sizeof(line), prefix);
		int core[5];
		core[0] = g_iStatCk[r]; core[1] = g_iStatSiDmg[r]; core[2] = g_iStatSiKill[r];
		core[3] = g_iStatFf[r]; core[4] = g_iStatRev[r];
		for (int c = 0; c < 5; c++)
		{
			int d = core[c] - g_iCoreAtLive[r][c];
			if (d == 0) continue;
			Format(kv, sizeof(kv), " %s=%d", coreKey[c], d);
			RsAppend(line, sizeof(line), prefix, kv);
		}
		for (int s = 0; s < view_as<int>(PS_MAX); s++)
		{
			if (!g_bSkillDetect && StatNeedsSkillDetect(view_as<PugStat>(s))) continue;
			int d = g_iSkill[r][s] - g_iSkillAtLive[r][s];
			if (d == 0) continue;
			Format(kv, sizeof(kv), " %s=%d", g_sStatKey[s], d);
			RsAppend(line, sizeof(line), prefix, kv);
		}
		for (int w = 0; w < WPN_COUNT; w++)
		{
			for (int k = 0; k < WS_MAX; k++)
			{
				if (g_iRoundWpn[r][w][k] == 0) continue;
				Format(kv, sizeof(kv), " w_%s_%s=%d", g_sWpnKey[w], g_sWsKey[k], g_iRoundWpn[r][w][k]);
				RsAppend(line, sizeof(line), prefix, kv);
			}
		}
		if (strlen(line) > strlen(prefix)) EmitPug("%s", line);
		players++;
	}
	EmitPug("ROUND_STATS_END half=%d players=%d sd=%d", half, players, g_bSkillDetect ? 1 : 0);
}

static void EmitRoundMark(const char[] kind)
{
	if (g_State != MS_Live || g_bRoundEnded || g_fRoundLiveAt <= 0.0) return;
	EmitPug("ROUND_MARK half=%d kind=%s t=%d", g_iHalf, kind, RoundMs());
}

public void Event_PanicMark(Event event, const char[] name, bool dontBroadcast) { EmitRoundMark("panic"); }
public void Event_FinaleStartMark(Event event, const char[] name, bool dontBroadcast) { EmitRoundMark("finale_start"); }
public void Event_FinaleRadioMark(Event event, const char[] name, bool dontBroadcast) { EmitRoundMark("finale_radio"); }
```

- [ ] **Step 2: Wire it into `pug-match.sp`**

Include after `pug-balance.inc`:

```c
#include "pug-roundstats.inc"
```

In the `HookEventEx` block (:481-533), following the existing pattern of logging when an event is missing:

```c
	if (!HookEventEx("create_panic_event", Event_PanicMark))
		LogMessage("[pug] create_panic_event not on this engine; no panic markers");
	if (!HookEventEx("finale_start", Event_FinaleStartMark))
		LogMessage("[pug] finale_start not on this engine");
	if (!HookEventEx("finale_radio_start", Event_FinaleRadioMark))
		LogMessage("[pug] finale_radio_start not on this engine");
```

In the go-live block, next to `EmitBalance();` (Task 2):

```c
		RoundStatsBegin();
```

In `Event_RoundEnd`, directly after `int half = g_iHalf;` (:3266):

```c
	EmitRoundStats(half);
```

In `Event_PlayerHurt`, inside the tank branch (after `AddStat(attacker, PS_TankDamage, damage);`) add:

```c
		char wpnT[32];
		event.GetString("weapon", wpnT, sizeof(wpnT));
		RoundWpnAdd(attacker, wpnT, WS_TankDmg, damage);
```

and in the final `else if (siVictim && remaining > 0)` branch, after `g_iStatSiDmg[slot] += damage;`:

```c
		char wpnS[32];
		event.GetString("weapon", wpnS, sizeof(wpnS));
		RoundWpnAdd(attacker, wpnS, WS_SiDmg, damage);
```

In `Event_PlayerDeath`, after `g_iStatSiKill[slot]++;`:

```c
	char wpnK[32];
	event.GetString("weapon", wpnK, sizeof(wpnK));
	RoundWpnAdd(attacker, wpnK, WS_SiKill, 1);
```

In `Event_InfectedDeath`, after `g_iStatCk[slot]++;`:

```c
	if (event.GetBool("blast")) RoundWpnAdd(attacker, "pipe_bomb", WS_CiKill, 1);
	else RoundWpnAddActive(attacker, WS_CiKill, 1);
```

- [ ] **Step 3: Add `pug-roundstats.inc` to `plugin/build.sh`** (cp list and CLEANUP).

- [ ] **Step 4: Compile**

Run: `cd plugin && ./build.sh`
Expected: `pug-match.smx` written, no new errors.

- [ ] **Step 5: Commit**

```bash
git add plugin/pug-roundstats.inc plugin/pug-match.sp plugin/build.sh
git commit -m "plugin: per-round stat deltas, per-weapon damage and kills, panic and finale markers"
```

---

### Task 4: Parse the new lines

**Files:**
- Modify: `src/logParse.ts` (LogEvent union :35-155, switch :409-584)
- Test: `tests/logParse.test.ts`

**Interfaces:**
- Produces (added to `LogEvent`):
  - `{ kind: 'balance_part'; token: string; half: 1 | 2; part: number; items: Record<string, string> }`
  - `{ kind: 'balance_end'; token: string; half: 1 | 2; parts: number; items: number }`
  - `{ kind: 'round_stat'; token: string; half: 1 | 2; steamid: string; stats: Record<string, number> }`
  - `{ kind: 'round_stats_end'; token: string; half: 1 | 2; players: number; skillDetect: boolean }`
  - `{ kind: 'round_mark'; token: string; half: 1 | 2; mark: 'panic' | 'finale_start' | 'finale_radio'; tMs: number }`
  - exported helper `pctDecode(s: string): string`

- [ ] **Step 1: Write the failing tests** (append to `tests/logParse.test.ts`, which already defines `TOKEN` and `framed`)

```ts
describe('balance and per-round lines', () => {
  it('parses a BALANCE part, decoding %20 and %25 and keeping only prefixed items', () => {
    const ev = parseLogDatagram(framed(
      `PUG ${TOKEN} BALANCE half=1 part=0 c:z_tank_health=4000 c:sv_tags=a%20b%25 p:l4d_skypounce.smx=1234.0a0b0c0d x:l4d_nope=missing junk=1`,
    ));
    expect(ev).toEqual({
      kind: 'balance_part', token: TOKEN, half: 1, part: 0,
      items: {
        'c:z_tank_health': '4000', 'c:sv_tags': 'a b%',
        'p:l4d_skypounce.smx': '1234.0a0b0c0d', 'x:l4d_nope': 'missing',
      },
    });
  });

  it('parses BALANCE_END', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} BALANCE_END half=2 parts=3 items=71`))).toEqual({
      kind: 'balance_end', token: TOKEN, half: 2, parts: 3, items: 71,
    });
  });

  it('rejects BALANCE with a bad half', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} BALANCE half=3 part=0 c:a=1`))).toBeNull();
  });

  it('parses ROUND_STAT and drops non-integer values', () => {
    const ev = parseLogDatagram(framed(
      `PUG ${TOKEN} ROUND_STAT half=1 steamid=76561198000000001 crowns=1 w_pumpshotgun_sidmg=250 bad=x`,
    ));
    expect(ev).toEqual({
      kind: 'round_stat', token: TOKEN, half: 1, steamid: '76561198000000001',
      stats: { crowns: 1, w_pumpshotgun_sidmg: 250 },
    });
  });

  it('parses ROUND_STATS_END', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} ROUND_STATS_END half=1 players=8 sd=1`))).toEqual({
      kind: 'round_stats_end', token: TOKEN, half: 1, players: 8, skillDetect: true,
    });
  });

  it('parses ROUND_MARK and rejects an unknown mark', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} ROUND_MARK half=2 kind=panic t=91234`))).toEqual({
      kind: 'round_mark', token: TOKEN, half: 2, mark: 'panic', tMs: 91234,
    });
    expect(parseLogDatagram(framed(`PUG ${TOKEN} ROUND_MARK half=2 kind=boom t=1`))).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/logParse.test.ts -t "balance and per-round"`
Expected: FAIL (parser returns null for unknown verbs).

- [ ] **Step 3: Implement**

Add the five members to the `LogEvent` union next to `round_end` (:91). Add near `kv`:

```ts
/** The plugin encodes exactly '%' and ' ' in balance keys and values. */
export function pctDecode(s: string): string {
  return s.replace(/%20/g, ' ').replace(/%25/g, '%');
}
const BAL_ITEM_RE = /^[cxpfd]:/;
const STAT_KEY_RE = /^[a-z0-9_]{1,40}$/;
const ROUND_MARKS = new Set(['panic', 'finale_start', 'finale_radio']);
```

Add cases to the switch before `default:`:

```ts
    case 'BALANCE': {
      const half = halfOf(rest.half);
      const part = intOf(rest.part);
      if (half === null || part === null || part < 0) return null;
      const items: Record<string, string> = {};
      for (const [k, v] of Object.entries(rest)) {
        if (BAL_ITEM_RE.test(k)) items[pctDecode(k)] = pctDecode(v);
      }
      return { kind: 'balance_part', token, half, part, items };
    }
    case 'BALANCE_END': {
      const half = halfOf(rest.half);
      const parts = intOf(rest.parts);
      const items = intOf(rest.items);
      if (half === null || parts === null || items === null || parts < 0 || items < 0) return null;
      return { kind: 'balance_end', token, half, parts, items };
    }
    case 'ROUND_STAT': {
      const half = halfOf(rest.half);
      if (half === null || !/^\d{17}$/.test(rest.steamid ?? '')) return null;
      const stats: Record<string, number> = {};
      for (const [k, v] of Object.entries(rest)) {
        if (k === 'half' || k === 'steamid' || !STAT_KEY_RE.test(k)) continue;
        const n = intOf(v);
        if (n !== null) stats[k] = n;
      }
      return { kind: 'round_stat', token, half, steamid: rest.steamid, stats };
    }
    case 'ROUND_STATS_END': {
      const half = halfOf(rest.half);
      const players = intOf(rest.players);
      if (half === null || players === null || (rest.sd !== '0' && rest.sd !== '1')) return null;
      return { kind: 'round_stats_end', token, half, players, skillDetect: rest.sd === '1' };
    }
    case 'ROUND_MARK': {
      const half = halfOf(rest.half);
      const tMs = intOf(rest.t);
      if (half === null || tMs === null || tMs < 0 || !ROUND_MARKS.has(rest.kind ?? '')) return null;
      return { kind: 'round_mark', token, half, mark: rest.kind as 'panic' | 'finale_start' | 'finale_radio', tMs };
    }
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/logParse.test.ts`
Expected: PASS, including every pre-existing test.

- [ ] **Step 5: Commit**

```bash
git add src/logParse.ts tests/logParse.test.ts
git commit -m "logParse: BALANCE, ROUND_STAT, ROUND_STATS_END and ROUND_MARK lines"
```

---

### Task 5: Schema, match origin and merge coverage

**Files:**
- Modify: `src/db.ts` (inside `openDb`, after the last `ensureColumn` block, before `seed(db)`)
- Modify: `src/matchmaker.ts:383`, `src/selfStarted.ts:354`
- Modify: `src/mergePlayers.ts:75` (the keep-one-row table list)
- Test: `tests/balanceSchema.test.ts`

**Interfaces:**
- Produces tables: `balance_patches`, `balance_patch_servers`, `balance_server_state`, `match_round_stats`, `match_round_marks`; columns `match_rounds.patch_id`, `match_rounds.variant`, `match_rounds.skill_detect`, `matches.origin`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/balanceSchema.test.ts
import { describe, expect, it } from 'vitest';
import { openDb, ORIGIN_BACKFILL_SQL } from '../src/db.js';

const cols = (db: ReturnType<typeof openDb>, t: string) =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);

describe('balance schema', () => {
  it('creates the tables and columns', () => {
    const db = openDb(':memory:');
    expect(cols(db, 'balance_patches')).toEqual(expect.arrayContaining(
      ['id', 'fingerprint', 'name', 'notes', 'source', 'inputs_json', 'first_seen_at', 'reviewed']));
    expect(cols(db, 'balance_patch_servers')).toEqual(expect.arrayContaining(
      ['patch_id', 'server_id', 'first_seen_at', 'last_seen_at']));
    expect(cols(db, 'balance_server_state')).toEqual(expect.arrayContaining(
      ['server_id', 'patch_id', 'inventory_json', 'since']));
    expect(cols(db, 'match_round_stats')).toEqual(expect.arrayContaining(
      ['match_id', 'ordinal', 'half', 'player_id', 'stat', 'value']));
    expect(cols(db, 'match_round_marks')).toEqual(expect.arrayContaining(
      ['match_id', 'ordinal', 'half', 'kind', 't_ms']));
    expect(cols(db, 'match_rounds')).toEqual(expect.arrayContaining(['patch_id', 'variant', 'skill_detect']));
    expect(cols(db, 'matches')).toContain('origin');
  });

  it('backfills origin from the roster source', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO players (steamid, name) VALUES ('76561198000000001', 'a')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign) VALUES (1, 1, 'completed', 'x'), (2, 1, 'completed', 'x')").run();
    db.prepare("INSERT INTO match_players (match_id, player_id, team, source) VALUES (1, '76561198000000001', 'a', 'web'), (2, '76561198000000001', 'a', 'udp')").run();
    db.prepare('UPDATE matches SET origin = NULL').run();
    // Re-running the backfill statement is what openDb does on the next boot.
    db.prepare(ORIGIN_BACKFILL_SQL).run();
    const rows = db.prepare('SELECT id, origin FROM matches ORDER BY id').all();
    expect(rows).toEqual([{ id: 1, origin: 'queue' }, { id: 2, origin: 'in_game' }]);
  });
});
```

If the `players` table requires more NOT NULL columns than `steamid, name`, copy the minimal player insert used in `tests/mergePlayers.test.ts`.

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/balanceSchema.test.ts`
Expected: FAIL (`no such table: balance_patches`).

- [ ] **Step 3: Implement in `src/db.ts`**

Export near `ensureColumn`:

```ts
/** A match whose roster came from the site was made by the queue; anything
 *  else was started in game. Idempotent: only fills NULLs. */
export const ORIGIN_BACKFILL_SQL = `UPDATE matches SET origin = CASE
    WHEN EXISTS (SELECT 1 FROM match_players mp WHERE mp.match_id = matches.id AND mp.source = 'web')
    THEN 'queue' ELSE 'in_game' END
  WHERE origin IS NULL`;
```

Inside `openDb`, before `seed(db)`:

```ts
  // Balance analytics, piece 1: which config each round ran on.
  // docs/superpowers/specs/2026-09-23-balance-analytics-design.md
  db.exec(`
    CREATE TABLE IF NOT EXISTS balance_patches (
      id            INTEGER PRIMARY KEY,
      fingerprint   TEXT UNIQUE,
      name          TEXT,
      notes         TEXT NOT NULL DEFAULT '',
      source        TEXT NOT NULL CHECK (source IN ('announced','detected','historical')),
      inputs_json   TEXT,
      first_seen_at TEXT NOT NULL,
      reviewed      INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS balance_patch_servers (
      patch_id      INTEGER NOT NULL REFERENCES balance_patches(id),
      server_id     INTEGER NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at  TEXT NOT NULL,
      PRIMARY KEY (patch_id, server_id)
    );
    CREATE TABLE IF NOT EXISTS balance_server_state (
      server_id      INTEGER PRIMARY KEY,
      patch_id       INTEGER NOT NULL REFERENCES balance_patches(id),
      inventory_json TEXT NOT NULL,
      since          TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS match_round_stats (
      match_id  INTEGER NOT NULL REFERENCES matches(id),
      ordinal   INTEGER NOT NULL,
      half      INTEGER NOT NULL,
      player_id TEXT    NOT NULL,
      stat      TEXT    NOT NULL,
      value     INTEGER NOT NULL,
      PRIMARY KEY (match_id, ordinal, half, player_id, stat)
    );
    CREATE TABLE IF NOT EXISTS match_round_marks (
      match_id INTEGER NOT NULL REFERENCES matches(id),
      ordinal  INTEGER NOT NULL,
      half     INTEGER NOT NULL,
      kind     TEXT    NOT NULL,
      t_ms     INTEGER NOT NULL,
      PRIMARY KEY (match_id, ordinal, half, kind, t_ms)
    );
  `);
  ensureColumn(db, 'match_rounds', 'patch_id', 'INTEGER REFERENCES balance_patches(id)');
  ensureColumn(db, 'match_rounds', 'variant', 'TEXT');
  ensureColumn(db, 'match_rounds', 'skill_detect', 'INTEGER');
  ensureColumn(db, 'matches', 'origin', "TEXT CHECK (origin IN ('queue','in_game'))");
  db.prepare(ORIGIN_BACKFILL_SQL).run();
```

- [ ] **Step 4: Stamp origin at creation**

`src/matchmaker.ts:383`:

```ts
          "INSERT INTO matches (season_id, state, campaign, origin) VALUES (?, 'configuring', ?, 'queue')",
```

`src/selfStarted.ts:354`:

```ts
              `INSERT INTO matches (season_id, state, campaign, server_id, token, origin)
               VALUES (?, 'live', ?, ?, ?, 'in_game')`,
```

- [ ] **Step 5: Cover the new player table in the merge**

In `src/mergePlayers.ts`, add to the list that contains `['match_live_map_stats', 'player_id']` (:75):

```ts
  // Per-round deltas (balance analytics). Two accounts in one round is the
  // alt-account case itself; the survivor's row is kept, as for the rows above.
  ['match_round_stats', 'player_id'],
```

If `tests/mergePlayers.test.ts` has a test asserting every table with a player column is covered, it now passes with this line; if it fails without it, that confirms the line is needed.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/balanceSchema.test.ts tests/mergePlayers.test.ts tests/matchmaker.test.ts tests/selfStarted.test.ts`
Expected: PASS. (If a test file name differs, run `npx vitest run -t origin` and the full suite in Step 7.)

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/db.ts src/matchmaker.ts src/selfStarted.ts src/mergePlayers.ts tests/balanceSchema.test.ts
git commit -m "db: balance patch tables, per-round stats and marks, match origin"
```

---

### Task 6: BALANCE reassembly

**Files:**
- Create: `src/balanceAssembler.ts`
- Test: `tests/balanceAssembler.test.ts`

**Interfaces:**
- Produces: `class BalanceAssembler { constructor(maxAgeMs?: number); part(token: string, half: 1 | 2, part: number, items: Record<string, string>, now?: number): void; end(token: string, half: 1 | 2, parts: number, count: number, now?: number): Record<string, string> | null }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/balanceAssembler.test.ts
import { describe, expect, it } from 'vitest';
import { BalanceAssembler } from '../src/balanceAssembler.js';

const T = 'a'.repeat(32);

describe('BalanceAssembler', () => {
  it('joins parts when the END counts match', () => {
    const a = new BalanceAssembler();
    a.part(T, 1, 0, { 'c:x': '1' }, 0);
    a.part(T, 1, 1, { 'c:y': '2', 'p:z.smx': '3.aa' }, 1);
    expect(a.end(T, 1, 2, 3, 2)).toEqual({ 'c:x': '1', 'c:y': '2', 'p:z.smx': '3.aa' });
  });

  it('returns null when a part is missing or the item count is off', () => {
    const a = new BalanceAssembler();
    a.part(T, 1, 1, { 'c:y': '2' }, 0);
    expect(a.end(T, 1, 2, 1, 1)).toBeNull();
    a.part(T, 2, 0, { 'c:y': '2' }, 0);
    expect(a.end(T, 2, 1, 5, 1)).toBeNull();
  });

  it('a duplicated datagram does not double count', () => {
    const a = new BalanceAssembler();
    a.part(T, 1, 0, { 'c:x': '1' }, 0);
    a.part(T, 1, 0, { 'c:x': '1' }, 0);
    expect(a.end(T, 1, 1, 1, 1)).toEqual({ 'c:x': '1' });
  });

  it('forgets a round after END and drops stale partials', () => {
    const a = new BalanceAssembler(1000);
    a.part(T, 1, 0, { 'c:x': '1' }, 0);
    expect(a.end(T, 1, 1, 1, 5000)).toBeNull(); // too old
    expect(a.end(T, 1, 1, 1, 5001)).toBeNull(); // already forgotten
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/balanceAssembler.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/balanceAssembler.ts`**

```ts
/** Reassembles one go-live's BALANCE parts. Pure and in memory: a lost part
 *  loses that round's tag, and the next round resends the whole inventory. */
interface Pending { parts: Map<number, Record<string, string>>; firstAt: number }

export class BalanceAssembler {
  private pending = new Map<string, Pending>();
  constructor(private readonly maxAgeMs = 5 * 60 * 1000) {}

  part(token: string, half: 1 | 2, part: number, items: Record<string, string>, now = Date.now()): void {
    this.prune(now);
    const key = `${token}:${half}`;
    let p = this.pending.get(key);
    if (!p) { p = { parts: new Map(), firstAt: now }; this.pending.set(key, p); }
    p.parts.set(part, items);
  }

  end(token: string, half: 1 | 2, parts: number, count: number, now = Date.now()): Record<string, string> | null {
    const key = `${token}:${half}`;
    const p = this.pending.get(key);
    this.pending.delete(key);
    if (!p || now - p.firstAt > this.maxAgeMs) return null;
    if (p.parts.size !== parts) return null;
    const out: Record<string, string> = {};
    for (let i = 0; i < parts; i++) {
      const items = p.parts.get(i);
      if (!items) return null;
      Object.assign(out, items);
    }
    return Object.keys(out).length === count ? out : null;
  }

  private prune(now: number): void {
    for (const [k, p] of this.pending) if (now - p.firstAt > this.maxAgeMs) this.pending.delete(k);
  }
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `npx vitest run tests/balanceAssembler.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/balanceAssembler.ts tests/balanceAssembler.test.ts
git commit -m "balance: reassemble BALANCE parts per go-live"
```

---

### Task 7: Fingerprint, patch sighting, drift detection

**Files:**
- Create: `src/balance.ts`
- Modify: `src/liveView.ts` (export `currentOrdinal`, :554)
- Test: `tests/balance.test.ts`

**Interfaces:**
- Consumes: `BalanceKnobs.versionless` (Task 1), `currentOrdinal(db, matchId)` from `src/liveView.ts`, `publishAdminEvent` from `src/adminFeed.ts`, `getServer(db, id)` from `src/serverPool.ts`.
- Produces:
  - `fingerprintOf(inventory: Record<string, string>, versionless: string[]): string` (16 hex)
  - `diffInventories(a: Record<string, string>, b: Record<string, string>): { added: string[]; removed: string[]; changed: { key: string; from: string; to: string }[] }`
  - `formatDiff(d: ReturnType<typeof diffInventories>, max?: number): string`
  - `recordBalanceSighting(db: DB, s: { matchId: number; serverId: number | null; half: 1 | 2; inventory: Record<string, string>; versionless: string[]; now?: string }): { patchId: number; newPatch: boolean; serverChanged: boolean }`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/balance.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { subscribeAdminEvents } from '../src/adminFeed.js';
import { diffInventories, fingerprintOf, formatDiff, recordBalanceSighting } from '../src/balance.js';

const INV = { 'c:z_tank_health': '4000', 'p:l4d_skypounce.smx': '100.aaaa0001', 'p:pug-match.smx': '200.bbbb0001' };

describe('fingerprintOf', () => {
  it('ignores key order', () => {
    const b = { 'p:pug-match.smx': '200.bbbb0001', 'p:l4d_skypounce.smx': '100.aaaa0001', 'c:z_tank_health': '4000' };
    expect(fingerprintOf(INV, [])).toBe(fingerprintOf(b, []));
    expect(fingerprintOf(INV, [])).toMatch(/^[0-9a-f]{16}$/);
  });
  it('changes on any value change', () => {
    expect(fingerprintOf({ ...INV, 'c:z_tank_health': '3750' }, [])).not.toBe(fingerprintOf(INV, []));
  });
  it('ignores the version but not the presence of a versionless plugin', () => {
    const v = ['pug-match.smx'];
    expect(fingerprintOf({ ...INV, 'p:pug-match.smx': '999.ffff0000' }, v)).toBe(fingerprintOf(INV, v));
    const { ['p:pug-match.smx']: _gone, ...without } = INV;
    expect(fingerprintOf(without, v)).not.toBe(fingerprintOf(INV, v));
  });
});

describe('diffInventories', () => {
  it('reports added, removed and changed keys', () => {
    const d = diffInventories({ a: '1', b: '2' }, { b: '3', c: '4' });
    expect(d).toEqual({ added: ['c'], removed: ['a'], changed: [{ key: 'b', from: '2', to: '3' }] });
    expect(formatDiff(d)).toBe('added c; removed a; b 2 -> 3');
  });
});

describe('recordBalanceSighting', () => {
  let db: ReturnType<typeof openDb>;
  let problems: string[];
  let unsub: () => void;
  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, token) VALUES (1, 1, 'live', 'x', ?)").run('b'.repeat(32));
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team) VALUES (1, 0, 1, 'a')").run();
    addServer(db, { name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    addServer(db, { name: 'chicago', host: '10.0.0.2', port: 27015, rconPort: 27015, rconPassword: 'x' });
    problems = [];
    unsub = subscribeAdminEvents((e) => { if (e.kind === 'problem') problems.push(e.text); });
  });
  afterEach(() => unsub());

  it('creates a detected patch, tags the round and alerts once', () => {
    const r = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: INV, versionless: [] });
    expect(r).toMatchObject({ newPatch: true, serverChanged: true });
    const round = db.prepare('SELECT patch_id FROM match_rounds WHERE match_id = 1').get() as { patch_id: number };
    expect(round.patch_id).toBe(r.patchId);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/dallas/);

    const again = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: INV, versionless: [] });
    expect(again).toMatchObject({ patchId: r.patchId, newPatch: false, serverChanged: false });
    expect(problems).toHaveLength(1);
  });

  it('reports what changed and which servers now differ', () => {
    recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: INV, versionless: [] });
    recordBalanceSighting(db, { matchId: 1, serverId: 2, half: 1, inventory: INV, versionless: [] });
    problems.length = 0;
    const changed = { ...INV, 'p:l4d_itemlimiter.smx': '50.cccc0001' };
    const r = recordBalanceSighting(db, { matchId: 1, serverId: 2, half: 1, inventory: changed, versionless: [] });
    expect(r.newPatch).toBe(true);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/chicago/);
    expect(problems[0]).toMatch(/added p:l4d_itemlimiter\.smx/);
    expect(problems[0]).toMatch(/differs from dallas/);
  });

  it('alerts on a versionless plugin update without making a new patch', () => {
    const v = ['pug-match.smx'];
    const first = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: INV, versionless: v });
    problems.length = 0;
    const bumped = { ...INV, 'p:pug-match.smx': '201.bbbb0002' };
    const r = recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: bumped, versionless: v });
    expect(r).toMatchObject({ patchId: first.patchId, newPatch: false, serverChanged: true });
    expect(problems[0]).toMatch(/pug-match\.smx/);
  });
});
```

If `addServer`'s input field names differ, match the call in `tests/logAuthWiring.test.ts`.

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run tests/balance.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Export `currentOrdinal`** in `src/liveView.ts:554` (`function` becomes `export function`).

- [ ] **Step 4: Implement `src/balance.ts`**

```ts
import { createHash } from 'node:crypto';
import type { DB } from './db.js';
import { publishAdminEvent } from './adminFeed.js';
import { currentOrdinal } from './liveView.js';

type Inventory = Record<string, string>;

/** Stable 16-hex fingerprint. A versionless plugin contributes its presence
 *  only, so updating pug-match does not start a new balance patch. */
export function fingerprintOf(inv: Inventory, versionless: string[]): string {
  const skip = new Set(versionless.map((f) => `p:${f}`));
  const lines = Object.keys(inv).sort().map((k) => (skip.has(k) ? `${k}=present` : `${k}=${inv[k]}`));
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}

export function diffInventories(a: Inventory, b: Inventory) {
  const added = Object.keys(b).filter((k) => !(k in a)).sort();
  const removed = Object.keys(a).filter((k) => !(k in b)).sort();
  const changed = Object.keys(b).filter((k) => k in a && a[k] !== b[k]).sort()
    .map((key) => ({ key, from: a[key], to: b[key] }));
  return { added, removed, changed };
}

export function formatDiff(d: ReturnType<typeof diffInventories>, max = 10): string {
  const parts = [
    ...d.added.map((k) => `added ${k}`),
    ...d.removed.map((k) => `removed ${k}`),
    ...d.changed.map((c) => `${c.key} ${c.from} -> ${c.to}`),
  ];
  const shown = parts.slice(0, max).join('; ');
  return parts.length > max ? `${shown}; and ${parts.length - max} more` : shown;
}

const serverName = (db: DB, id: number): string =>
  (db.prepare('SELECT name FROM servers WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? `server ${id}`;

/** One go-live's inventory arrived: find or create its patch, tag the round,
 *  and tell admins when this server's inventory changed. */
export function recordBalanceSighting(db: DB, s: {
  matchId: number; serverId: number | null; half: 1 | 2; inventory: Inventory; versionless: string[]; now?: string;
}): { patchId: number; newPatch: boolean; serverChanged: boolean } {
  // SQLite's datetime('now') format, so it sorts against match_rounds.started_at.
  const now = s.now ?? new Date().toISOString().replace('T', ' ').slice(0, 19);
  const fp = fingerprintOf(s.inventory, s.versionless);
  const invJson = JSON.stringify(Object.fromEntries(Object.entries(s.inventory).sort()));

  return db.transaction(() => {
    let newPatch = false;
    let row = db.prepare('SELECT id FROM balance_patches WHERE fingerprint = ?').get(fp) as { id: number } | undefined;
    if (!row) {
      const id = Number(db.prepare(
        "INSERT INTO balance_patches (fingerprint, source, inputs_json, first_seen_at) VALUES (?, 'detected', ?, ?)",
      ).run(fp, invJson, now).lastInsertRowid);
      row = { id };
      newPatch = true;
    }
    const patchId = row.id;

    db.prepare('UPDATE match_rounds SET patch_id = ? WHERE match_id = ? AND ordinal = ? AND half = ?')
      .run(patchId, s.matchId, currentOrdinal(db, s.matchId), s.half);

    let serverChanged = false;
    if (s.serverId !== null) {
      db.prepare(`INSERT INTO balance_patch_servers (patch_id, server_id, first_seen_at, last_seen_at)
                  VALUES (?, ?, ?, ?)
                  ON CONFLICT (patch_id, server_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`)
        .run(patchId, s.serverId, now, now);
      const prev = db.prepare('SELECT patch_id, inventory_json FROM balance_server_state WHERE server_id = ?')
        .get(s.serverId) as { patch_id: number; inventory_json: string } | undefined;
      if (!prev || prev.inventory_json !== invJson) {
        serverChanged = true;
        db.prepare(`INSERT INTO balance_server_state (server_id, patch_id, inventory_json, since) VALUES (?, ?, ?, ?)
                    ON CONFLICT (server_id) DO UPDATE SET patch_id = excluded.patch_id,
                      inventory_json = excluded.inventory_json, since = excluded.since`)
          .run(s.serverId, patchId, invJson, now);
        publishAdminEvent({ kind: 'problem', text: alertText(db, s.serverId, patchId, newPatch, prev, s.inventory) });
      }
    }
    return { patchId, newPatch, serverChanged };
  })();
}

function alertText(db: DB, serverId: number, patchId: number, newPatch: boolean,
  prev: { inventory_json: string } | undefined, inv: Inventory): string {
  const name = serverName(db, serverId);
  const head = newPatch
    ? `Balance config on ${name} is a new patch (#${patchId}, unnamed; name it in Admin > Setup > Patches).`
    : `Balance config on ${name} changed (still patch #${patchId}).`;
  const vsOwn = prev ? ` Changed: ${formatDiff(diffInventories(JSON.parse(prev.inventory_json) as Inventory, inv))}.` : ' First sighting.';
  const others = db.prepare('SELECT server_id, inventory_json FROM balance_server_state WHERE server_id != ?')
    .all(serverId) as { server_id: number; inventory_json: string }[];
  const drift = others
    .map((o) => ({ who: serverName(db, o.server_id), d: diffInventories(JSON.parse(o.inventory_json) as Inventory, inv) }))
    .filter((o) => o.d.added.length + o.d.removed.length + o.d.changed.length > 0)
    .map((o) => ` Now differs from ${o.who}: ${formatDiff(o.d, 5)}.`);
  return head + vsOwn + drift.join('');
}
```

Note: the displayed `#patchId` is the row id here; the admin page shows the time-ordered number. The Discord line says "name it in Admin" so the id mismatch is harmless. If a reviewer wants the ordered number in Discord, compute it with the same query Task 11 uses.

- [ ] **Step 5: Run and see them pass**

Run: `npx vitest run tests/balance.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/balance.ts src/liveView.ts tests/balance.test.ts
git commit -m "balance: fingerprint, patch sighting, round tag and drift alert"
```

---

### Task 8: Store per-round stats and markers

**Files:**
- Create: `src/roundStats.ts`
- Test: `tests/roundStats.test.ts`

**Interfaces:**
- Consumes: `currentOrdinal` (Task 7), the LogEvent members from Task 4.
- Produces: `recordRoundStat(db, matchId, ev)`, `recordRoundStatsEnd(db, matchId, ev)`, `recordRoundMark(db, matchId, ev)`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/roundStats.test.ts
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { recordRoundMark, recordRoundStat, recordRoundStatsEnd } from '../src/roundStats.js';

const T = 'b'.repeat(32);
function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  db.prepare("INSERT INTO matches (id, season_id, state, campaign, token) VALUES (1, 1, 'live', 'x', ?)").run(T);
  db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team) VALUES (1, 0, 2, 'b')").run();
  return db;
}

describe('round stats', () => {
  it('upserts per-round stats so a duplicate datagram does not double count', () => {
    const db = setup();
    const ev = { kind: 'round_stat' as const, token: T, half: 2 as const, steamid: '76561198000000001', stats: { crowns: 1, w_smg_sidmg: 90 } };
    recordRoundStat(db, 1, ev);
    recordRoundStat(db, 1, ev);
    const rows = db.prepare('SELECT stat, value FROM match_round_stats ORDER BY stat').all();
    expect(rows).toEqual([{ stat: 'crowns', value: 1 }, { stat: 'w_smg_sidmg', value: 90 }]);
  });

  it('records whether skill_detect was loaded on the round', () => {
    const db = setup();
    recordRoundStatsEnd(db, 1, { kind: 'round_stats_end', token: T, half: 2, players: 8, skillDetect: true });
    expect(db.prepare('SELECT skill_detect FROM match_rounds').get()).toEqual({ skill_detect: 1 });
  });

  it('stores markers', () => {
    const db = setup();
    recordRoundMark(db, 1, { kind: 'round_mark', token: T, half: 2, mark: 'panic', tMs: 1234 });
    expect(db.prepare('SELECT ordinal, half, kind, t_ms FROM match_round_marks').all())
      .toEqual([{ ordinal: 0, half: 2, kind: 'panic', t_ms: 1234 }]);
  });
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run tests/roundStats.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/roundStats.ts`**

```ts
import type { DB } from './db.js';
import type { LogEvent } from './logParse.js';
import { currentOrdinal } from './liveView.js';

type Ev<K extends LogEvent['kind']> = Extract<LogEvent, { kind: K }>;

/** Per-round deltas for the balance metrics. Upsert, never add: UDP can
 *  duplicate a datagram and the plugin sends each value once per round. */
export function recordRoundStat(db: DB, matchId: number, ev: Ev<'round_stat'>): void {
  const ordinal = currentOrdinal(db, matchId);
  const ins = db.prepare(`INSERT INTO match_round_stats (match_id, ordinal, half, player_id, stat, value)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (match_id, ordinal, half, player_id, stat) DO UPDATE SET value = excluded.value`);
  db.transaction(() => {
    for (const [stat, value] of Object.entries(ev.stats)) ins.run(matchId, ordinal, ev.half, ev.steamid, stat, value);
  })();
}

export function recordRoundStatsEnd(db: DB, matchId: number, ev: Ev<'round_stats_end'>): void {
  db.prepare('UPDATE match_rounds SET skill_detect = ? WHERE match_id = ? AND ordinal = ? AND half = ?')
    .run(ev.skillDetect ? 1 : 0, matchId, currentOrdinal(db, matchId), ev.half);
}

export function recordRoundMark(db: DB, matchId: number, ev: Ev<'round_mark'>): void {
  db.prepare(`INSERT OR IGNORE INTO match_round_marks (match_id, ordinal, half, kind, t_ms) VALUES (?, ?, ?, ?, ?)`)
    .run(matchId, currentOrdinal(db, matchId), ev.half, ev.mark, ev.tMs);
}
```

Ordinal note: ROUND_STAT is sent from `Event_RoundEnd` BEFORE `MAP_RESULT` (which is sent after half 2 finalizes), so `currentOrdinal` still names this map. This is the same assumption `recordRoundStart` makes. The UDP wiring test in Task 9 covers the half-2 case.

- [ ] **Step 4: Run and see it pass**

Run: `npx vitest run tests/roundStats.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/roundStats.ts tests/roundStats.test.ts
git commit -m "roundStats: store per-round stats, skill_detect flag and markers"
```

---

### Task 9: Wire into the log listener

**Files:**
- Modify: `src/server.ts` (the `else if` chain at :879-911, plus one `BalanceAssembler` and knobs load near the listener at :620)
- Test: `tests/balanceWiring.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 6, 7, 8. `serverOf(source, meta)` (server.ts:620). `loadBalanceKnobs` (Task 1).

- [ ] **Step 1: Write the failing test**, modelled on `tests/logAuthWiring.test.ts` (copy its `freeUdpPort`, `send` and `settle` helpers verbatim from that file):

```ts
// tests/balanceWiring.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { addServer } from '../src/serverPool.js';
// freeUdpPort, send, settle: copied from tests/logAuthWiring.test.ts

const T = 'c'.repeat(32);

describe('balance lines end to end', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); });

  it('tags the round, stores per-round stats and markers', async () => {
    const port = await freeUdpPort();
    const db = openDb(':memory:');
    const sid = addServer(db, { name: 'dallas', host: '127.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, server_id, token) VALUES (1, 1, 'live', 'x', ?, ?)").run(sid, T);
    db.prepare("INSERT INTO match_live (match_id, current_map, last_seen) VALUES (1, 'm', datetime('now'))").run();
    const app = await buildServer({ config: { ...loadConfig({}), devMode: false, logListenPort: port }, db });
    close = () => app.close();

    send(port, `PUG ${T} ROUND_START map=m half=1 surv=a`);
    await settle();
    send(port, `PUG ${T} BALANCE half=1 part=0 c:z_tank_health=4000`);
    send(port, `PUG ${T} BALANCE half=1 part=1 p:l4d_skypounce.smx=100.aaaa0001`);
    send(port, `PUG ${T} BALANCE_END half=1 parts=2 items=2`);
    send(port, `PUG ${T} ROUND_MARK half=1 kind=panic t=5000`);
    send(port, `PUG ${T} ROUND_STAT half=1 steamid=76561198000000001 crowns=1`);
    send(port, `PUG ${T} ROUND_STATS_END half=1 players=1 sd=1`);
    await settle();

    const round = db.prepare('SELECT patch_id, skill_detect FROM match_rounds WHERE match_id = 1').get() as { patch_id: number; skill_detect: number };
    expect(round.patch_id).toBeGreaterThan(0);
    expect(round.skill_detect).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_round_marks').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT value FROM match_round_stats').get()).toEqual({ value: 1 });
    expect(db.prepare('SELECT server_id FROM balance_server_state').get()).toEqual({ server_id: sid });
  });
});
```

If `addServer` returns a row rather than an id, use its `.id`. If the test's `send` needs the sending port to equal the server's `port` for `resolveServerBySource`, bind as `logAuthWiring.test.ts` does; the balance code prefers `matches.server_id` anyway (Step 3).

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run tests/balanceWiring.test.ts`
Expected: FAIL (patch_id null).

- [ ] **Step 3: Implement the wiring in `src/server.ts`**

Near `serverOf` (:620):

```ts
  const balanceAssembler = new BalanceAssembler();
  const balanceKnobs = loadBalanceKnobs();
  const liveMatchRow = (token: string) =>
    deps.db.prepare("SELECT id, server_id FROM matches WHERE token = ? AND state = 'live'")
      .get(token) as { id: number; server_id: number | null } | undefined;
```

In the chain, before `else if (ev.kind === 'round_start')`:

```ts
          else if (ev.kind === 'balance_part') {
            balanceAssembler.part(ev.token, ev.half, ev.part, ev.items);
            return; // nothing visible changed yet; no broadcast
          }
          else if (ev.kind === 'balance_end') {
            const inv = balanceAssembler.end(ev.token, ev.half, ev.parts, ev.items);
            const m = liveMatchRow(ev.token);
            if (!inv || !m) return;
            // The match knows its server; the source address is the fallback
            // (Riverside #3 and #4 share one IP, see resolveServerBySource).
            recordBalanceSighting(deps.db, {
              matchId: m.id, serverId: m.server_id ?? serverOf(source, meta), half: ev.half,
              inventory: inv, versionless: balanceKnobs.versionless,
            });
            return;
          }
          else if (ev.kind === 'round_stat' || ev.kind === 'round_stats_end' || ev.kind === 'round_mark') {
            const m = liveMatchRow(ev.token);
            if (!m) return;
            if (ev.kind === 'round_stat') recordRoundStat(deps.db, m.id, ev);
            else if (ev.kind === 'round_stats_end') recordRoundStatsEnd(deps.db, m.id, ev);
            else recordRoundMark(deps.db, m.id, ev);
            return;
          }
```

Add the imports at the top of `src/server.ts`:

```ts
import { BalanceAssembler } from './balanceAssembler.js';
import { loadBalanceKnobs } from './balanceKnobs.js';
import { recordBalanceSighting } from './balance.js';
import { recordRoundMark, recordRoundStat, recordRoundStatsEnd } from './roundStats.js';
```

Check the variable names `source` and `meta` against the listener callback signature at :622 (`(raw, source, meta) =>`) and use whatever it names them.

`balance/knobs.json` must ship with the web deploy. Check `deploy-web.sh` for how files outside `dist/` reach the box (it rsyncs the repo or specific dirs); if `balance/` would not be copied, add it to that list in this task.

- [ ] **Step 4: Run and see it pass, then the full suite**

Run: `npx vitest run tests/balanceWiring.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/balanceWiring.test.ts deploy-web.sh
git commit -m "server: route BALANCE, ROUND_STAT and ROUND_MARK lines"
```

---

### Task 10: Historical patches for the existing rounds

**Files:**
- Create: `src/historicalPatches.ts`
- Create: `scripts/backfill-historical-patches.ts`
- Test: `tests/historicalPatches.test.ts`

**Interfaces:**
- Produces: `HISTORICAL_PATCHES: { name: string; from: string; notes: string }[]`, `applyHistoricalPatches(db: DB, opts?: { dryRun?: boolean }): { created: number; tagged: number }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/historicalPatches.test.ts
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { applyHistoricalPatches, HISTORICAL_PATCHES } from '../src/historicalPatches.js';

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  db.prepare("INSERT INTO matches (id, season_id, state, campaign) VALUES (1, 1, 'completed', 'x')").run();
  const ins = db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, started_at) VALUES (1, ?, 1, 'a', ?)");
  ins.run(0, '2026-09-11 10:00:00');   // baseline
  ins.run(1, '2026-09-21 21:00:00');   // after sky pounce
  ins.run(2, '2026-09-23 01:00:00');   // after saferoom lock
  return db;
}

describe('historical patches', () => {
  it('creates one patch per boundary and tags rounds by start time', () => {
    const db = setup();
    const r = applyHistoricalPatches(db);
    expect(r.created).toBe(HISTORICAL_PATCHES.length);
    expect(r.tagged).toBe(3);
    const names = db.prepare(`SELECT r.ordinal, p.name FROM match_rounds r JOIN balance_patches p ON p.id = r.patch_id ORDER BY r.ordinal`).all();
    expect(names).toEqual([
      { ordinal: 0, name: 'Baseline' },
      { ordinal: 1, name: 'Sky pounce fix' },
      { ordinal: 2, name: 'Saferoom lock' },
    ]);
  });

  it('is idempotent and never overwrites a detected tag', () => {
    const db = setup();
    db.prepare("INSERT INTO balance_patches (id, fingerprint, source, inputs_json, first_seen_at) VALUES (99, 'f', 'detected', '{}', '2026-09-23 00:30:00')").run();
    db.prepare('UPDATE match_rounds SET patch_id = 99 WHERE ordinal = 2').run();
    applyHistoricalPatches(db);
    const second = applyHistoricalPatches(db);
    expect(second).toEqual({ created: 0, tagged: 0 });
    expect(db.prepare('SELECT patch_id FROM match_rounds WHERE ordinal = 2').get()).toEqual({ patch_id: 99 });
  });

  it('dry run changes nothing', () => {
    const db = setup();
    const r = applyHistoricalPatches(db, { dryRun: true });
    expect(r.created).toBe(HISTORICAL_PATCHES.length);
    expect(db.prepare('SELECT COUNT(*) AS n FROM balance_patches').get()).toEqual({ n: 0 });
  });
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run tests/historicalPatches.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/historicalPatches.ts`**

Times are UTC in SQLite's `datetime('now')` format, because `match_rounds.started_at` is written with `datetime('now')`.

```ts
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
        "INSERT INTO balance_patches (fingerprint, name, notes, source, inputs_json, first_seen_at) VALUES (NULL, ?, ?, 'historical', NULL, ?)",
      ).run(p.name, p.notes, p.from).lastInsertRowid);
      const to = HISTORICAL_PATCHES[i + 1]?.from ?? '9999-12-31 00:00:00';
      const end = firstDetected && firstDetected < to ? firstDetected : to;
      tagged += db.prepare(
        'UPDATE match_rounds SET patch_id = ? WHERE patch_id IS NULL AND started_at >= ? AND started_at < ?',
      ).run(id, p.from, end).changes;
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
```

Every `first_seen_at` is in SQLite's `YYYY-MM-DD HH:MM:SS` UTC format (Task 7 writes it that way too), so it compares correctly against `match_rounds.started_at`.

- [ ] **Step 4: Implement `scripts/backfill-historical-patches.ts`**

```ts
import { openDb } from '../src/db.js';
import { applyHistoricalPatches } from '../src/historicalPatches.js';

const path = process.argv[2];
const apply = process.argv.includes('--apply');
if (!path) { console.error('usage: tsx scripts/backfill-historical-patches.ts <pug.db> [--apply]'); process.exit(2); }
const db = openDb(path);
const r = applyHistoricalPatches(db, { dryRun: !apply });
console.log(`${apply ? 'applied' : 'dry run'}: ${r.created} patches, ${r.tagged} rounds tagged`);
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/historicalPatches.test.ts tests/balance.test.ts`
Expected: PASS.

- [ ] **Step 6: Dry run against a copy of production**

```bash
scp root@45.32.199.85:/home/pug/app/data/pug.db /tmp/claude-1000/pug-prod-copy.db
npx tsx scripts/backfill-historical-patches.ts /tmp/claude-1000/pug-prod-copy.db
```

Expected: `dry run: 5 patches, N rounds tagged` with N close to the total round count (922 on 2026-09-22 plus whatever was played since). Read-only on the box; the copy is local.

- [ ] **Step 7: Commit**

```bash
git add src/historicalPatches.ts scripts/backfill-historical-patches.ts tests/historicalPatches.test.ts
git commit -m "balance: historical patches for rounds played before fingerprints"
```

---

### Task 11: Admin API for patches and drift

**Files:**
- Modify: `src/balance.ts` (queries)
- Modify: `src/routes/admin.ts` (routes, next to the seasons routes :719-739)
- Test: `tests/balanceAdmin.test.ts`

**Interfaces:**
- Produces:
  - `listPatches(db): PatchSummary[]` where `PatchSummary = { id: number; number: number; name: string | null; notes: string; source: 'announced' | 'detected' | 'historical'; firstSeenAt: string; reviewed: boolean; rounds: number; servers: { serverId: number; name: string; lastSeenAt: string }[] }`
  - `patchDetail(db, id): (PatchSummary & { inputs: Record<string, string> | null; diffVsPrevious: ReturnType<typeof diffInventories> | null }) | null`
  - `serverDrift(db): { serverId: number; name: string; patchId: number; since: string; differsFrom: { name: string; diff: string }[] }[]`
  - `editPatch(db, id, patch: { name?: string | null; notes?: string; reviewed?: boolean }): boolean`
  - Routes: `GET /api/admin/balance/patches`, `GET /api/admin/balance/patches/:id`, `POST /api/admin/balance/patches/:id`, `GET /api/admin/balance/drift`.

- [ ] **Step 1: Write the failing test** (pattern from `tests/seasons.test.ts:31-46`)

```ts
// tests/balanceAdmin.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { addServer } from '../src/serverPool.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { recordBalanceSighting } from '../src/balance.js';

const ADMIN = '76561198000000009';

describe('balance admin API', () => {
  let db: ReturnType<typeof openDb>;
  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, token) VALUES (1, 1, 'live', 'x', ?)").run('d'.repeat(32));
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team) VALUES (1, 0, 1, 'a')").run();
    addServer(db, { name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    addServer(db, { name: 'chicago', host: '10.0.0.2', port: 27015, rconPort: 27015, rconPassword: 'x' });
    recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: { 'c:a': '1' }, versionless: [] });
    recordBalanceSighting(db, { matchId: 1, serverId: 2, half: 1, inventory: { 'c:a': '2' }, versionless: [] });
  });

  async function app() {
    const a = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
    const cookies = await authedCookie(a, db, ADMIN);
    db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
    return { a, cookies };
  }

  it('lists patches in time order with numbers and round counts', async () => {
    const { a, cookies } = await app();
    const res = await a.inject({ method: 'GET', url: '/api/admin/balance/patches', cookies });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { patches: { number: number; source: string; rounds: number }[] };
    expect(body.patches.map((p) => p.number)).toEqual([1, 2]);
    expect(body.patches[1].rounds).toBe(1); // the round was retagged by the second sighting
  });

  it('shows drift between servers', async () => {
    const { a, cookies } = await app();
    const res = await a.inject({ method: 'GET', url: '/api/admin/balance/drift', cookies });
    const body = res.json() as { servers: { name: string; differsFrom: { name: string; diff: string }[] }[] };
    const chicago = body.servers.find((s) => s.name === 'chicago')!;
    expect(chicago.differsFrom[0]).toEqual({ name: 'dallas', diff: 'c:a 1 -> 2' });
  });

  it('renames a patch and marks it reviewed, audited', async () => {
    const { a, cookies } = await app();
    const res = await a.inject({ method: 'POST', url: '/api/admin/balance/patches/1', cookies, payload: { name: 'Tank 7500', reviewed: true } });
    expect(res.statusCode).toBe(200);
    expect(db.prepare('SELECT name, reviewed FROM balance_patches WHERE id = 1').get()).toEqual({ name: 'Tank 7500', reviewed: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'edit_patch'").get()).toEqual({ n: 1 });
  });

  it('refuses a non-admin', async () => {
    const a = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
    const cookies = await authedCookie(a, db, '76561198000000010');
    const res = await a.inject({ method: 'GET', url: '/api/admin/balance/patches', cookies });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run tests/balanceAdmin.test.ts`
Expected: FAIL (404).

- [ ] **Step 3: Implement the queries in `src/balance.ts`**

```ts
export type PatchSource = 'announced' | 'detected' | 'historical';
export interface PatchSummary {
  id: number; number: number; name: string | null; notes: string; source: PatchSource;
  firstSeenAt: string; reviewed: boolean; rounds: number;
  servers: { serverId: number; name: string; lastSeenAt: string }[];
}

export function listPatches(db: DB): PatchSummary[] {
  const rows = db.prepare(`
    SELECT p.id, p.name, p.notes, p.source, p.first_seen_at, p.reviewed,
           ROW_NUMBER() OVER (ORDER BY p.first_seen_at, p.id) AS number,
           (SELECT COUNT(*) FROM match_rounds r WHERE r.patch_id = p.id) AS rounds
    FROM balance_patches p ORDER BY number`).all() as {
      id: number; name: string | null; notes: string; source: PatchSource; first_seen_at: string;
      reviewed: number; number: number; rounds: number }[];
  const servers = db.prepare(`SELECT bps.patch_id, bps.server_id, s.name, bps.last_seen_at
    FROM balance_patch_servers bps JOIN servers s ON s.id = bps.server_id`).all() as {
      patch_id: number; server_id: number; name: string; last_seen_at: string }[];
  return rows.map((r) => ({
    id: r.id, number: r.number, name: r.name, notes: r.notes, source: r.source,
    firstSeenAt: r.first_seen_at, reviewed: r.reviewed === 1, rounds: r.rounds,
    servers: servers.filter((s) => s.patch_id === r.id)
      .map((s) => ({ serverId: s.server_id, name: s.name, lastSeenAt: s.last_seen_at })),
  }));
}

export function patchDetail(db: DB, id: number) {
  const all = listPatches(db);
  const i = all.findIndex((p) => p.id === id);
  if (i < 0) return null;
  const inputsOf = (pid: number) => {
    const row = db.prepare('SELECT inputs_json FROM balance_patches WHERE id = ?').get(pid) as { inputs_json: string | null };
    return row.inputs_json ? (JSON.parse(row.inputs_json) as Record<string, string>) : null;
  };
  const inputs = inputsOf(id);
  const prevWithInputs = all.slice(0, i).reverse().find((p) => inputsOf(p.id) !== null);
  const prevInputs = prevWithInputs ? inputsOf(prevWithInputs.id) : null;
  return { ...all[i], inputs, diffVsPrevious: inputs && prevInputs ? diffInventories(prevInputs, inputs) : null };
}

export function serverDrift(db: DB) {
  const rows = db.prepare(`SELECT st.server_id, s.name, st.patch_id, st.since, st.inventory_json
    FROM balance_server_state st JOIN servers s ON s.id = st.server_id ORDER BY s.id`).all() as {
      server_id: number; name: string; patch_id: number; since: string; inventory_json: string }[];
  return rows.map((r) => ({
    serverId: r.server_id, name: r.name, patchId: r.patch_id, since: r.since,
    differsFrom: rows.filter((o) => o.server_id !== r.server_id)
      .map((o) => ({ name: o.name, d: diffInventories(JSON.parse(o.inventory_json), JSON.parse(r.inventory_json)) }))
      .filter((o) => o.d.added.length + o.d.removed.length + o.d.changed.length > 0)
      .map((o) => ({ name: o.name, diff: formatDiff(o.d) })),
  }));
}

export function editPatch(db: DB, id: number, p: { name?: string | null; notes?: string; reviewed?: boolean }): boolean {
  const cur = db.prepare('SELECT id FROM balance_patches WHERE id = ?').get(id);
  if (!cur) return false;
  if (p.name !== undefined) db.prepare('UPDATE balance_patches SET name = ? WHERE id = ?').run(p.name, id);
  if (p.notes !== undefined) db.prepare('UPDATE balance_patches SET notes = ? WHERE id = ?').run(p.notes, id);
  if (p.reviewed !== undefined) db.prepare('UPDATE balance_patches SET reviewed = ? WHERE id = ?').run(p.reviewed ? 1 : 0, id);
  return true;
}
```

- [ ] **Step 4: Add the routes in `src/routes/admin.ts`**, after the seasons routes:

```ts
  // Balance patches (balance analytics piece 1).
  app.get('/api/admin/balance/patches', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return { patches: listPatches(db) };
  });

  app.get('/api/admin/balance/patches/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const d = patchDetail(db, Number((req.params as { id: string }).id));
    return d ?? reply.code(404).send({ error: 'no such patch' });
  });

  app.get('/api/admin/balance/drift', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return { servers: serverDrift(db) };
  });

  app.post('/api/admin/balance/patches/:id', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as { name?: unknown; notes?: unknown; reviewed?: unknown };
    const edit: { name?: string | null; notes?: string; reviewed?: boolean } = {};
    if (b.name !== undefined) {
      if (b.name !== null && (typeof b.name !== 'string' || b.name.trim().length > 60)) {
        return reply.code(400).send({ error: 'a patch name is up to 60 characters' });
      }
      edit.name = b.name === null || b.name.trim() === '' ? null : b.name.trim();
    }
    if (b.notes !== undefined) {
      if (typeof b.notes !== 'string' || b.notes.length > 2000) return reply.code(400).send({ error: 'notes are up to 2000 characters' });
      edit.notes = b.notes;
    }
    if (b.reviewed !== undefined) {
      if (typeof b.reviewed !== 'boolean') return reply.code(400).send({ error: 'reviewed is true or false' });
      edit.reviewed = b.reviewed;
    }
    if (!editPatch(db, id, edit)) return reply.code(404).send({ error: 'no such patch' });
    logAdmin(db, adminId, 'edit_patch', id, edit);
    return { ok: true };
  });
```

Import `listPatches, patchDetail, serverDrift, editPatch` from `../balance.js`.

- [ ] **Step 5: Run and see it pass**

Run: `npx vitest run tests/balanceAdmin.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/balance.ts src/routes/admin.ts tests/balanceAdmin.test.ts
git commit -m "admin: balance patch list, detail, edit and server drift API"
```

---

### Task 12: Admin "Patches" tab

**Files:**
- Modify: `web/src/api.ts` (`adminApi` at :1225)
- Modify: `web/src/routes/admin/adminRoutes.ts` (`SETUP_TABS` :41-46)
- Modify: `web/src/routes/Admin.tsx` (import and render line near :121)
- Create: `web/src/routes/admin/AdminPatches.tsx`
- Test: `web/src/routes/admin/adminRoutes.test.ts` (tab parses), `web/src/routes/admin/AdminPatches.test.tsx`

**Interfaces:**
- Consumes: the four routes from Task 11.

- [ ] **Step 1: Write the failing tests**

In `web/src/routes/admin/adminRoutes.test.ts` add:

```ts
it('parses the patches setup tab', () => {
  expect(parseAdminPath('/admin/setup/patches')).toMatchObject({ desk: 'setup', section: 'patches' });
});
```

Create `web/src/routes/admin/AdminPatches.test.tsx`, following the render and fetch-mock pattern already used in `web/src/routes/admin.test.tsx` (copy its mock setup for `fetch`):

```tsx
import { render, screen, waitFor } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { AdminPatches } from './AdminPatches';

describe('AdminPatches', () => {
  it('lists patches with an approximate badge and shows drift', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
      url.includes('/drift')
        ? { servers: [{ serverId: 2, name: 'chicago', patchId: 2, since: 'x', differsFrom: [{ name: 'dallas', diff: 'added p:l4d_itemlimiter.smx' }] }] }
        : { patches: [
          { id: 1, number: 1, name: 'Baseline', notes: '', source: 'historical', firstSeenAt: '2000-01-01 00:00:00', reviewed: true, rounds: 900, servers: [] },
          { id: 2, number: 2, name: null, notes: '', source: 'detected', firstSeenAt: '2026-09-24 01:00:00', reviewed: false, rounds: 3, servers: [] },
        ] },
    ))));
    render(<AdminPatches />);
    await waitFor(() => expect(screen.getByText('Baseline')).toBeTruthy());
    expect(screen.getByText('approximate')).toBeTruthy();
    expect(screen.getByText('Unnamed patch 2')).toBeTruthy();
    expect(screen.getByText(/chicago differs from dallas/)).toBeTruthy();
  });
});
```

If `admin.test.tsx` uses a different render helper than `@testing-library/preact`, use that one instead.

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run web/src/routes/admin`
Expected: FAIL.

- [ ] **Step 3: Implement**

`web/src/api.ts`, inside `adminApi`:

```ts
  balancePatches: () => get<{ patches: PatchSummary[] }>('/api/admin/balance/patches'),
  balancePatch: (id: number) => get<PatchDetail>(`/api/admin/balance/patches/${id}`),
  balanceDrift: () => get<{ servers: DriftRow[] }>('/api/admin/balance/drift'),
  editBalancePatch: (id: number, body: { name?: string | null; notes?: string; reviewed?: boolean }) =>
    post(`/api/admin/balance/patches/${id}`, body),
```

with the types declared in `web/src/api.ts` next to the other admin types:

```ts
export interface PatchSummary {
  id: number; number: number; name: string | null; notes: string;
  source: 'announced' | 'detected' | 'historical'; firstSeenAt: string; reviewed: boolean; rounds: number;
  servers: { serverId: number; name: string; lastSeenAt: string }[];
}
export interface PatchDetail extends PatchSummary {
  inputs: Record<string, string> | null;
  diffVsPrevious: { added: string[]; removed: string[]; changed: { key: string; from: string; to: string }[] } | null;
}
export interface DriftRow { serverId: number; name: string; patchId: number; since: string; differsFrom: { name: string; diff: string }[] }
```

`web/src/routes/admin/adminRoutes.ts`, add to `SETUP_TABS`:

```ts
  { key: 'patches', label: 'Patches', path: '/admin/setup/patches' },
```

`web/src/routes/admin/AdminPatches.tsx`:

```tsx
import { useState } from 'preact/hooks';
import { adminApi, type PatchDetail } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Panel } from '../../components/bits';
import { useAction } from './useAction';

const label = (p: { number: number; name: string | null }) => p.name ?? `Unnamed patch ${p.number}`;

export function AdminPatches() {
  const patches = useFetch(() => adminApi.balancePatches(), []);
  const drift = useFetch(() => adminApi.balanceDrift(), []);
  const [open, setOpen] = useState<PatchDetail | null>(null);
  const { busy, error, run } = useAction(() => patches.reload());
  const [name, setName] = useState('');

  const differing = (drift.data?.servers ?? []).flatMap((s) =>
    s.differsFrom.map((d) => `${s.name} differs from ${d.name}: ${d.diff}`));

  return (
    <div>
      <Panel title="Server drift">
        {differing.length === 0
          ? <p>All servers are running the same balance config.</p>
          : <ul>{differing.map((t) => <li key={t}>{t}</li>)}</ul>}
      </Panel>
      <Panel title="Patches">
        {error && <p class="error">{error}</p>}
        <table class="admin-table">
          <thead><tr><th>#</th><th>Name</th><th>Source</th><th>Since</th><th>Rounds</th><th>Servers</th><th /></tr></thead>
          <tbody>
            {(patches.data?.patches ?? []).map((p) => (
              <tr key={p.id} class={!p.reviewed && p.source === 'detected' ? 'unreviewed' : ''}>
                <td>{p.number}</td>
                <td>{label(p)}</td>
                <td>{p.source === 'historical' ? <span class="badge">approximate</span> : p.source}</td>
                <td>{p.firstSeenAt}</td>
                <td>{p.rounds}</td>
                <td>{p.servers.map((s) => s.name).join(', ')}</td>
                <td><button class="btn" onClick={() => void adminApi.balancePatch(p.id).then(setOpen)}>Details</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      {open && (
        <Panel title={label(open)}>
          <form class="admin-form" onSubmit={(e) => {
            e.preventDefault();
            void run(() => adminApi.editBalancePatch(open.id, { name: name.trim() || null, reviewed: true })).then(() => setOpen(null));
          }}>
            <input value={name} placeholder="Patch name" aria-label="Patch name" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
            <button class="btn" type="submit" disabled={busy}>Save and mark reviewed</button>
          </form>
          {open.diffVsPrevious
            ? <ul>
              {open.diffVsPrevious.added.map((k) => <li key={`a${k}`}>added {k}</li>)}
              {open.diffVsPrevious.removed.map((k) => <li key={`r${k}`}>removed {k}</li>)}
              {open.diffVsPrevious.changed.map((c) => <li key={`c${c.key}`}>{c.key}: {c.from} to {c.to}</li>)}
            </ul>
            : <p>No recorded inventory to compare (historical or first patch).</p>}
        </Panel>
      )}
    </div>
  );
}
```

Match `useFetch`'s real signature and `.reload` name from `AdminSeasons.tsx`; adjust the two `useFetch` calls if they differ.

`web/src/routes/Admin.tsx`: import `AdminPatches` and add next to the seasons line:

```tsx
{r.desk === 'setup' && r.section === 'patches' && <AdminPatches />}
```

- [ ] **Step 4: Run and see them pass; typecheck and build**

Run: `npx vitest run web/src/routes/admin && npm run typecheck && npm run build`
Expected: PASS, no type errors, build succeeds. (Use the typecheck script name from `package.json` if it differs.)

- [ ] **Step 5: Commit**

```bash
git add web/src/api.ts web/src/routes/admin/adminRoutes.ts web/src/routes/admin/adminRoutes.test.ts web/src/routes/Admin.tsx web/src/routes/admin/AdminPatches.tsx web/src/routes/admin/AdminPatches.test.tsx
git commit -m "admin: Patches tab with drift, patch list and review"
```

---

### Task 13: Plugin verification on the local test server

**Files:**
- Modify: `plugin/TESTING.md` (new section "Balance inventory verification")

This task produces evidence, not code. It must pass before Task 14.

- [ ] **Step 1: Start an isolated local server with the full Rotoblin plugin set**

Use the skypounce rig as the model: `plugin/skypounce/rig/run.sh roto` runs `/home/volence/l4d1-ds-skyprobe/server` on port 27045 and loads the whole Rotoblin set, which is what a realistic hashing benchmark needs. Copy the newly built `plugin/pug-match.smx` into that instance's plugins set the same way the rig copies its plugin under test.

- [ ] **Step 2: Measure the scan**

With `sm_pug_debug 1`, change map twice. Read the `balance scan: N items in X ms` line. Expected: first map under 250 ms, later maps under 20 ms (cache hits). If the first map is slower than 250 ms, stop and report; the fallback is slicing the scan across frames, which needs its own small design.

- [ ] **Step 3: Check the wire output**

Start a solo self-started match (`sm_pug_min_orient 1`, `!load_4v4p` as in `plugin/TESTING.md`), go live, and capture the log lines (the rig writes the server console log). Confirm:
- `BALANCE` parts are each under 700 bytes and `BALANCE_END items=` equals the item count across parts
- every `c:` cvar in knobs.json appears, as `c:` or `x:`
- `p:pug-match.smx` and `d:addons/stripper/Roto-AZMod/maps` appear
- after one round end with some damage done to a bot infected: `ROUND_STAT` with `w_<weapon>_sidmg` keys whose weapon names are in the plugin's list (not all `other`). If they all read `other`, print the raw `weapon` string from `player_hurt` with a temporary `PugDebug` and fix `WpnIndex`
- trigger a panic event (a car alarm or a crescendo button) and see `ROUND_MARK kind=panic`

- [ ] **Step 4: Round trip through the backend parser**

Paste three captured lines into a scratch test (not committed) that runs `parseLogDatagram(framed(line))` and check each parses to the expected kind.

- [ ] **Step 5: Write the section in `plugin/TESTING.md`** recording the measured times, the commands used and the checks above, then commit.

```bash
git add plugin/TESTING.md
git commit -m "testing: balance inventory verification recipe and measured scan cost"
```

---

### Task 14: Ship (needs the server empty; owner's standing deploy-when-empty rules apply)

No code. The order matters: the web must understand the new lines before the plugin sends them, and historical patches must exist before the first detected one.

- [ ] **Step 1:** Merge `worktree-balance-analytics` into master following `feedback-one-session-per-checkout` (check `git reflog` and `git status` in the main checkout first; other sessions write there).
- [ ] **Step 2:** Back up the production DB on the box: `cp /home/pug/app/data/pug.db /home/pug/pug.db.pre-balance-$(date +%Y%m%d-%H%M)`.
- [ ] **Step 3:** `./deploy-web.sh`. Verify with the deploy verification recipe (tree hash, the new columns exist: `sqlite3 -readonly ... "PRAGMA table_info(match_rounds)"` shows `patch_id`).
- [ ] **Step 4:** On the box, dry run then apply the historical backfill: `npx tsx scripts/backfill-historical-patches.ts /home/pug/app/data/pug.db`, check the counts, then rerun with `--apply`.
- [ ] **Step 5:** Deploy `pug-match.smx` to all four servers, each only when it is empty (A2S query, not rcon): `plugin/stage.sh` for Dallas, the deploy repo's tooling for Chicago and Riverside #3/#4 as used for the pug-match 0.3.5 rollout (`c7e360a`). Bump `PLUGIN_VERSION` first.
- [ ] **Step 6:** Re-assert `auto_track` and `roster_at_live` after the plugin reload (PUG audit hardening ship order).
- [ ] **Step 7:** After the first real match on each server, check: `match_rounds.patch_id` is set on its rounds, `balance_server_state` has a row per server, the Discord admin channel got one "first sighting" line per server, and Admin > Setup > Patches shows no drift (or shows real drift worth reading).
- [ ] **Step 8:** Update the memory note `pug-balance-analytics.md` with what shipped and when.

---

## Self-review notes

- Spec coverage: fingerprint inputs (Tasks 1, 2), patch table and sources (5, 7, 10), unannounced fingerprint alert and drift (7, 11, 12), per-round tagging (7), historical approximate patches (10), split-test readiness (`variant` column, Task 5), plugin additions: per-weapon (3), markers (3), per-round crowns (3, via ROUND_STAT deltas of every skill stat), game type (5, as `origin`). The metrics engine and dashboard are pieces 2 and 3, planned separately.
- Known risk: FNV-1a scan time on the first map (Task 13 Step 2 gates it).
- Known risk: `player_hurt` weapon strings on L4D1 are unverified (Task 13 Step 3 checks them).
