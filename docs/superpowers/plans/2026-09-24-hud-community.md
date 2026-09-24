# Community HUDs and crosshairs: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to carry this plan out task by task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** a `/community` page where players share up to 2 HUDs and 2 crosshairs made in the HUD editor
and the crosshair maker. Others browse, like, open in the editor, download (rebuilt in the browser), and
report them. Staff can remove them.

**Spec:** `docs/superpowers/specs/2026-09-24-hud-community-design.md`. Read it first. The allowlist
section is the heart of the feature.

**Architecture:**

- **Shared code.** A pure shared module, `src/hudFiles.ts`, holds the HUD file allowlist, the content
  checks and `hudId`. Both the Fastify server and the Preact web use it. `readVPK` moves to an
  import-free `src/vpkRead.ts`, so the server can read the uploaded import.
- **Server.** New `community_entries` and `community_likes` tables, and `src/community/{validate,store,sweep}.ts`.
  Routes live in `src/routes/community.ts`, with files on local disk under `COMMUNITY_DIR` (default
  `data/community`). Moderation reuses tickets through a `ticket_reports.community_entry_id` column, and
  `logAdmin`.
- **Web.**
  - `web/src/community/` holds the API client, the publish helpers, and `openCommunity`, which fetches,
    verifies, stores and registers a community import.
  - `web/src/routes/Community.tsx` is the page and card; `CommunityEntry.tsx` is the entry page.
  - A share dialog is wired into the HUD editor and the crosshair page.
  - `/hud?community=` and `/hud?xhair=` open flows.
  - A Profile panel.

**Tech:** TypeScript, Fastify 5, better-sqlite3, `@fastify/multipart`, Preact with preact-iso, and
vitest 4. Server tests run in node (`tests/**`); web tests run in happy-dom (`web/**`), both from the root
`vitest.config.ts`.

## Rules for every implementer (put these FIRST in every dispatch)

1. **NEVER run `git stash` in any form.** Never `checkout`, `switch`, `reset` or `rebase`, and never move
   HEAD except by committing. Commit only your own files, with explicit paths. Never `git add -A` or
   `git add .`.
2. **Never deploy, push, ssh, rcon, or touch any production box, database or R2 bucket.**
3. **Never use em dashes** (the long dash) in code, comments, docs, commit messages or replies. Use
   commas, colons or separate sentences.
4. Work only in `/home/volence/l4d/pug/.claude/worktrees/hud-community`. `node_modules` is a symlink to
   the hud-editor worktree's; do not run `npm install` or `npm ci`.
5. **Test-driven development:** write the failing test, run it and watch it fail, implement, run it and
   watch it pass, then commit. Run the named test files with `npx vitest run <files>`, and typecheck with
   `npm run typecheck`.
6. Before each commit, run the whole suite once (`npx vitest run`), and stop if anything that was green
   is red.
7. Match the house style: comments that explain *why*; one-line user-facing error sentences; no CHECK
   constraints on sets that grow.

## Baseline

- **Before Task 0** (branch `hud-community` at 248754a, 2026-09-24): `npx vitest run` gives **259 files,
  4179 tests, all passing**, and `npm run typecheck` is clean.
- **After Task 0** (the master merge), the controller records the new baseline here:
  **371 files, 5506 tests, all passing** (merge 79c1da8), and `npm run typecheck` is clean.
  `tests/server.test.ts` "a malformed URL" needs a built frontend (`dist/public/index.html`); run
  `npm run build` once in a fresh worktree or that one test fails with 400 instead of 404.

Every later task must end with the full suite at or above that count and all green.

## File map

| File | New or changed | Responsibility |
|---|---|---|
| `src/hudFiles.ts` | new | The allowlist (`hudPathProblem`), the per-file content checks (`hudFileProblem`), the set caps (`hudSetProblem`), `shareableHudFiles`, `hudId`, and the PNG sniffer `pngSize`. No imports. |
| `src/vpkRead.ts` | new (moved) | `readVPK`, `isVpk`, `decodeVTF`, moved from `web/src/vpk/read.ts` unchanged. |
| `web/src/vpk/read.ts` | changed | Becomes `export * from '../../../src/vpkRead';`. |
| `web/tsconfig.json` | changed | Add `../src/hudFiles.ts` and `../src/vpkRead.ts` to `include`. |
| `web/src/hud/upload.ts` | changed | `hudId` re-exported from `src/hudFiles.ts`. |
| `web/src/hud/base/index.ts` | changed | `registerImport(id, files, opts?: { community?: boolean })` and `isCommunityImport(key)`. |
| `web/src/hud/build.ts` | changed | `buildHud` guard for community imports. |
| `web/src/hud/hudStore.ts` | changed | `StoredHud.community?: { entryId: number }`. |
| `src/community/schema.ts` | new | `ensureCommunitySchema(db)`. |
| `src/db.ts` | changed | Call `ensureCommunitySchema`; add the `ticket_reports.community_entry_id` column; add `DEFAULT_SETTINGS`. |
| `src/settingsSchema.ts` | changed | Five `community_*` settings in a new `Community` group. |
| `src/config.ts` | changed | `communityDir` (`COMMUNITY_DIR`, default `<dirname(DB_PATH)>/community`). |
| `src/mergePlayers.ts` | changed | `PLAIN` and `KEYED` entries, plus dropping self-likes. |
| `src/profileFields.ts` | changed | Export `hasUnsafeChars` and `LINKISH`. |
| `src/community/validate.ts` | new | Text, crosshair art, design structure, preview and import checks. |
| `src/community/store.ts` | new | The on-disk layout, atomic writes, the budget, free space, file reads. |
| `src/community/sweep.ts` | new | Purges tombstones older than 30 days and orphaned files. |
| `src/community/entries.ts` | new | DB queries: list, get, mine, insert, tombstone, like, caps. |
| `src/routes/community.ts` | new | All `/api/community` routes. |
| `src/server.ts` | changed | Register `communityRoutes`; run the sweep at start and daily. |
| `src/tickets/filing.ts`, `src/tickets/views.ts` | changed | `entryId` on reports; `entry` in `ticketDetail`. |
| `web/src/api.ts` | changed | `communityApi` and types; `fileReport` gets `entryId`. |
| `web/src/community/open.ts` | new | `openCommunityImport(entry)`: fetch, verify, store, register. |
| `web/src/community/publish.ts` | new | `renderPreview(design)`, `prepareHudShare(design)`, `shareHud`, `shareCrosshair`. |
| `web/src/community/download.ts` | new | `downloadCommunityHud(entry)` and `downloadCommunityCrosshair(entry)`. |
| `web/src/hud/assets.ts` | new (moved) | `assetsFor` and `decodeUpload`, moved out of `routes/Hud.tsx`. |
| `web/src/crosshair/download.ts` | new (moved) | `crosshairAddon(name, art)`, factored out of `Crosshair.tsx`'s download. |
| `web/src/components/ShareDialog.tsx` | new | The share dialog, for both kinds. |
| `web/src/components/CommunityCard.tsx` | new | The HUD and crosshair cards (full and compact). |
| `web/src/routes/Community.tsx`, `web/src/routes/CommunityEntry.tsx` | new | The gallery and the entry page. |
| `web/src/main.tsx`, `web/src/components/Nav.tsx` | changed | Routes and nav link. |
| `web/src/routes/Hud.tsx`, `web/src/routes/hud/Toolbar.tsx`, `web/src/routes/hud/CrosshairControls.tsx`, `web/src/routes/Crosshair.tsx` | changed | Share buttons and the `?community=` / `?xhair=` flows. |
| `web/src/components/ReportPlayer.tsx` | changed | The optional `entry` prop. |
| `web/src/routes/admin/AdminTicket.tsx` | changed | The entry link on a report. |
| `web/src/routes/Profile.tsx` | changed | The Shared panel. |
| `vite.config.ts` | changed | `API_PORT` env for the proxy (headless check). |
| `scripts/shoot-community.mjs` | new | The headless check. |

---

## Task 0: bring master into `hud-community` (CONTROLLER, not an implementer)

**Why:** `hud-community` is 375 commits behind master. `src/slurs.ts`, tickets phase 3 (`ticketDetail`
in `src/tickets/views.ts`, the widened reporter identity) and the current `mergePlayers` lists exist only
on master. `git merge-tree --write-tree HEAD master` shows exactly one conflict, in `web/src/main.tsx`.

- [ ] **Step 1:** Check that the worktree is clean (`git status --short` shows only the untracked
  `node_modules` symlink). Check `git log -1` is still `248754a` plus this plan's own commits.
- [ ] **Step 2:** Run `git merge --no-ff master -m "Merge master into hud-community"`. This is a commit,
  not a checkout, and it touches no other worktree.
- [ ] **Step 3:** Resolve `web/src/main.tsx` by keeping both sides' routes and lazy imports. Do not
  reorder anything else. Then run `git add web/src/main.tsx` and `git commit --no-edit`.
- [ ] **Step 4:** The `package-lock.json` may have changed. If `git diff 248754a HEAD -- package-lock.json`
  is non-empty, the symlinked `node_modules` (from hud-editor) may be stale. Compare
  `package-lock.json` with the main checkout's (`/home/volence/l4d/pug/package-lock.json`, which is on
  master). If they match, re-point the symlink with
  `ln -sfn /home/volence/l4d/pug/node_modules node_modules`.
- [ ] **Step 5:** Run `npx vitest run` and `npm run typecheck`. Both must be green. Record the counts in
  "Baseline" above and commit that edit to the plan.

If the merge shows any conflict beyond `main.tsx`, stop and leave it for the owner. Do not resolve server
code by guesswork.

---

## Task 1: the shared allowlist module and the reader move

**Files:**
- Create: `src/hudFiles.ts`, `src/vpkRead.ts`, `tests/hudFiles.test.ts`
- Modify: `web/src/vpk/read.ts`, `web/tsconfig.json`, `web/src/hud/upload.ts`

- [ ] **Step 1: Move the reader.**
  1. `git mv web/src/vpk/read.ts src/vpkRead.ts`.
  2. Create a new `web/src/vpk/read.ts` containing `export * from '../../../src/vpkRead';` and one
     comment line saying why: the server reads uploaded imports with the same code.
  3. Add `"../src/vpkRead.ts"` and `"../src/hudFiles.ts"` to `web/tsconfig.json`'s `include`.

  `src/vpkRead.ts` has no imports, so the server's NodeNext resolution is happy. Run
  `npx vitest run web/src/vpk` and `npm run typecheck`: green, with nothing else changed.

- [ ] **Step 2: Write the failing tests** in `tests/hudFiles.test.ts`.

  **Base-file cases.** Load the stock and Modern base files from disk (`web/src/hud/base/{stock,modern}/**`,
  with `readdirSync` walking and `readFileSync` reading):
  - every one passes `hudPathProblem` and `hudFileProblem`;
  - the whole stock set passes `hudSetProblem`.

  **Path cases.**
  - Refused, each by `hudPathProblem` with a message naming the path:
    - `cfg/autoexec.cfg`
    - `addoninfo.txt`
    - `gameinfo.txt`
    - `sound/ui/x.wav`
    - `models/x.mdl`
    - `scripts/weapon_rifle.txt`
    - `resource/gamemenu.res`
    - `resource/english.txt`
    - `resource/ui/optionssubkeyboard.res`
    - `materials/models/x.vtf`
    - `materials/vgui/x.vpk`
    - `resource/../cfg/a.cfg`
    - `Resource/ClientScheme.res` (upper case)
    - `resource/ui/hud/.res`
  - Allowed:
    - `resource/ui/hud/sub/panel.res`
    - `resource/fonts/my font.ttf`: **refused**, because the space is not in `[a-z0-9_.-]`; test the
      refusal.
    - `resource/fonts/myfont.ttf`
    - `materials/vgui/hud/hudeditor/clear.vtf`
    - `materials/vgui/hud/altcrosshair.vmt`

  **Content cases** (`hudFileProblem(path, bytes)`):
  - a `.res` with a NUL byte;
  - a `.res` with `"command" "engine bind w kill"`;
  - a `.res` with `command engine quit` (bare);
  - a `hudanimations.txt` holding `FireCommand 0.0 "x"`, and one holding `PlaySound 0 "x.wav"`;
  - a `hudanimations.txt` using `RunEvent`, `SetVisible` and comments passes;
  - a `.ttf` starting `00 01 00 00` passes, one starting `PK` is refused;
  - a `.otf` starting `OTTO` passes;
  - a `.vfont` ending `VFONT1` passes;
  - a `.vtf` with `VTF\0` and 256x256 passes, 4096x16 is refused, and a bad magic is refused;
  - a `.vmt` of 16 KB + 1 is refused;
  - a `.res` of 512 KB + 1 is refused.

  **Set cases** (`hudSetProblem`):
  - no `scripts/hudlayout.res`;
  - 401 files;
  - 20 MB + 1 in total.

  **`shareableHudFiles` case.** A map with the stock files plus `cfg/autoexec.cfg`, `addoninfo.txt` and a
  bad-magic `resource/x.ttf` gives:
  - `kept`: the stock files;
  - `left`: the three sorted paths, each with its reason.

  **`hudId` case.** The same map in two insertion orders gives the same 64-hex string. It equals a
  hard-coded value computed once from a tiny two-file map, which pins the algorithm:
  `path\0len\0bytes`, paths sorted, SHA-256.

  **`pngSize` case.** A real 1x1 PNG (build the bytes in the test) gives `{ w: 1, h: 1 }`. Garbage, and
  a PNG signature with a missing IHDR, give `null`.

  Run `npx vitest run tests/hudFiles.test.ts`. Expect FAIL (module missing).

- [ ] **Step 3: Implement `src/hudFiles.ts`.** It has no imports. The API:

  ```ts
  export const HUD_CAPS = { files: 400, totalBytes: 20 * 1024 * 1024, text: 512 * 1024, vmt: 16 * 1024,
    font: 4 * 1024 * 1024, texture: 8 * 1024 * 1024, textureSide: 2048 } as const;
  export type HudFileKind = 'text' | 'animations' | 'vmt' | 'font' | 'texture';
  /** Null when allowed, else "cfg/autoexec.cfg is not a HUD file". */
  export function hudPathProblem(path: string): string | null;
  /** hudPathProblem, then the size and content checks for that kind. */
  export function hudFileProblem(path: string, data: Uint8Array): string | null;
  /** Every file's problem, then the set caps and hudlayout.res. The first problem, or null. */
  export function hudSetProblem(files: ReadonlyMap<string, Uint8Array>): string | null;
  /** The allowed files, and the refused ones as "path: reason", sorted. Set caps are NOT applied here. */
  export function shareableHudFiles(files: ReadonlyMap<string, Uint8Array>): { kept: Map<string, Uint8Array>; left: string[] };
  /** Moved from web/src/hud/upload.ts unchanged: SHA-256 over sorted `path\0len\0` + bytes. Uses globalThis.crypto.subtle. */
  export async function hudId(files: ReadonlyMap<string, Uint8Array>): Promise<string>;
  /** Width and height from a PNG's IHDR, or null when the bytes are not a PNG. */
  export function pngSize(b: Uint8Array): { w: number; h: number } | null;
  ```

  **The path rule.** Split on `/`. Every segment must match `^[a-z0-9_.-]+$` and must not be `.` or `..`.
  Then:
  - the exact sets from the spec table (the four HUD scripts, the two schemes, the seven named UI
    panels);
  - `^resource/ui/hud/([a-z0-9_]+/)*[a-z0-9_]+\.res$`;
  - `^resource/([a-z0-9_.-]+/)*[a-z0-9_.-]+\.(ttf|otf|vfont)$`;
  - `^materials/vgui/([a-z0-9_.-]+/)*[a-z0-9_.-]+\.(vtf|vmt)$`.

  **The `engine` check** decodes the text as latin1, strips `//` comments per line, and tests
  `/(^|["\s])engine\s/i` against each quoted token and each bare value token. The simplest correct
  version is to tokenize each line into quoted strings and bare words, then test whether any token
  matches `/^\s*engine\s/i`.

  **The animations rule** decodes the file and strips comments. On each non-empty line whose first token
  is not `{` or `}`, the first bare word, case-insensitively, must be in the allowed set: `event`,
  `animate`, `runevent`, `runeventchild`, `stopevent`, `stopanimation`, `stoppanelanimations`,
  `setvisible`, `setfont`, `settexture`, `setstring`.

  **The VTF header:** bytes 0..3 are `VTF\0`; width is the uint16 LE at offset 16, height at 18.

  **The vfont:** the last six bytes are `VFONT1`.

- [ ] **Step 4:** In `web/src/hud/upload.ts`, delete the local `hudId` and add
  `export { hudId } from '../../../src/hudFiles';`. Run
  `npx vitest run tests/hudFiles.test.ts web/src/hud`. Both must pass, including the existing upload
  tests that pin ids.
- [ ] **Step 5:** Run `npm run typecheck`, then the full suite.
- [ ] **Step 6: Commit.**
  `git add src/hudFiles.ts src/vpkRead.ts tests/hudFiles.test.ts web/src/vpk/read.ts web/tsconfig.json web/src/hud/upload.ts`
  `git commit -m "Add the shared HUD file allowlist and move readVPK where the server can use it"`

---

## Task 2: build-time enforcement

**Files:**
- Modify: `web/src/hud/base/index.ts`, `web/src/hud/build.ts`, `web/src/hud/hudStore.ts`
- Create: `web/src/hud/community.build.test.ts`

- [ ] **Step 1: Write the failing tests** in `web/src/hud/community.build.test.ts`.

  1. **The generated-path invariant.** For each of stock, Modern, `advanced: true`, and an imported
     fixture (use `importFixtures.ts`'s helpers, as `imported.build.test.ts` does), build with
     `buildHud` using a design that switches on everything the editor can write:
     - `font: 'roboto'`, only on non-imported designs;
     - every style slot in `SLOTS` set to `kind: 'image'`, with an image of the slot's size;
     - weapons: `boxActive` rounded, `boxInactive` flat, `weaponIcons: false`, `itemIcons: false`,
       `clipFont: 30`;
     - `crosshair: 'bundle'` with a built `xhairArt`;
     - a teammate child font edit.

     Pass `BuildAssets` with fake font bytes, image pixels and crosshair pixels of the right sizes (see
     `Hud.assets.test.tsx` for how the page builds them). Every output path except `addoninfo.txt` must
     have `hudPathProblem(path) === null`. `addoninfo.txt` is the editor's own and is allowed at build
     only. Name the test so a new generated path outside the list fails loudly.
  2. **The runtime guard.**
     - `registerImport(id, filesWithCfg, { community: true })`, where `filesWithCfg` is the fixture plus
       `cfg/autoexec.cfg`. Then `buildHud(designOn(id))` throws
       `This community HUD would ship a file outside the HUD folders: cfg/autoexec.cfg`.
     - The same files registered without the flag build and pass `cfg/autoexec.cfg` through. This pins
       the private-import promise.
  3. **`isCommunityImport`** reports the flag, and `unregisterImport` clears it.

- [ ] **Step 2:** Run the file. Expect FAIL.
- [ ] **Step 3: Implement.**
  - `base/index.ts`:
    - add `const COMMUNITY = new Set<string>()`;
    - `registerImport(id, files, opts: { community?: boolean } = {})` adds to it when the flag is set,
      and never removes on a later unflagged register of the same id: same hash, same files, so the
      flag is sticky;
    - `unregisterImport` deletes it;
    - add `export function isCommunityImport(key: BaseKey): boolean`.
  - `build.ts` `buildHud`, in the imported branch, before the return:

    ```ts
    if (isCommunityImport(key)) {
      const bad = [...out.keys()].find((p) => p !== 'addoninfo.txt' && hudPathProblem(p) !== null);
      if (bad) throw new Error(`This community HUD would ship a file outside the HUD folders: ${bad}`);
    }
    ```

    Import `hudPathProblem` from `'../../../src/hudFiles'`.
  - `hudStore.ts`: add `community?: { entryId: number }` to `StoredHud` and carry it in `meta()`. Extend
    `hudStore.test.ts` with a round trip of the field.
- [ ] **Step 4:** Run `npx vitest run web/src/hud`, `npm run typecheck`, then the full suite.
- [ ] **Step 5: Commit.**
  `git add web/src/hud/base/index.ts web/src/hud/build.ts web/src/hud/hudStore.ts web/src/hud/hudStore.test.ts web/src/hud/community.build.test.ts`
  `git commit -m "Refuse to build a community HUD that would ship a file outside the allowlist"`

---

## Task 3: schema, settings, config, merge

**Files:**
- Create: `src/community/schema.ts`, `tests/communitySchema.test.ts`
- Modify: `src/db.ts`, `src/settingsSchema.ts`, `src/config.ts`, `src/mergePlayers.ts`,
  `tests/mergePlayers.test.ts`, `tests/config.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - `tests/communitySchema.test.ts`:
    - `openDb(':memory:')` has `community_entries` and `community_likes` with the spec's columns (check
      `PRAGMA table_info`);
    - `ticket_reports` has `community_entry_id`;
    - opening the same file-backed DB twice (in a temp dir) is idempotent;
    - the five settings exist with their defaults: `community_uploads` `'1'`, `community_huds_per_player`
      `'2'`, `community_crosshairs_per_player` `'2'`, `community_shares_per_day` `'6'`,
      `community_store_mb` `'1024'`;
    - `validateSetting` accepts and refuses at the bounds.
  - `tests/config.test.ts`: `loadConfig({ DB_PATH: '/x/y/pug.db' }).communityDir === '/x/y/community'`,
    and `COMMUNITY_DIR` overrides it.
  - `tests/mergePlayers.test.ts`:
    - the existing FK coverage test must pass once the tables exist (it fails first, which is the point);
    - a new case: player A has an entry and a like on B's entry, and B has a like on A's entry. After
      merging A into B, the entry's author is B, B keeps no like on their own entry, and A's like on B's
      entry is gone because it would be a self-like.
- [ ] **Step 2:** Run them. Expect FAIL.
- [ ] **Step 3: Implement.**
  - `src/community/schema.ts` holds the spec's DDL verbatim, in one `db.exec`, with a header comment on
    tombstones and purge.
  - In `src/db.ts` `openDb`:
    - call `ensureCommunitySchema(db)` after the `players` table exists and before tickets;
    - after `widenTicketIdentity(db); migrateLegacyReports(db);`, add
      `ensureColumn(db, 'ticket_reports', 'community_entry_id', 'INTEGER')`, with a comment saying why it
      must come after the rebuild;
    - add the five defaults to `DEFAULT_SETTINGS`.
  - `src/settingsSchema.ts`:
    - add `'Community'` to the `group` union;
    - add the five `SettingDef`s with the spec's help text;
    - check the web admin settings page lists groups from the data rather than a hard-coded list
      (`grep -n "Penalties" web/src/routes/admin`); if it is hard-coded, add `'Community'` there too.
  - `src/config.ts`: add
    `communityDir: env.COMMUNITY_DIR?.trim() || join(dirname(dbPath), 'community')`, as
    `ticketAttachmentsDir` does.
  - `src/mergePlayers.ts`:
    - `PLAIN` gets `['community_entries', 'author_id']` and `['community_entries', 'deleted_by']`;
    - `KEYED` gets `['community_likes', 'player_id']`;
    - after the KEYED pass, run
      `DELETE FROM community_likes WHERE player_id = ? AND entry_id IN (SELECT id FROM community_entries WHERE author_id = ?)`
      with `(into, into)`, and add its count to the plan's summary if the plan reports per-table
      counts.
- [ ] **Step 4:** Run `npx vitest run tests/communitySchema.test.ts tests/config.test.ts tests/mergePlayers.test.ts tests/db.test.ts tests/adminSettings.test.ts`,
  then the full suite.
- [ ] **Step 5: Commit** the listed files:
  `git commit -m "Add the community tables, settings and data directory, and teach them to mergePlayers"`

---

## Task 4: server-side validation

**Files:**
- Create: `src/community/validate.ts`, `tests/communityValidate.test.ts`
- Modify: `src/profileFields.ts` (export `hasUnsafeChars` and `LINKISH`)

- [ ] **Step 1: Write the failing tests.**

  **`checkTitle(raw)`:**
  - `'ab'` is refused as too short;
  - 41 characters are refused;
  - a newline is refused;
  - a zero-width space is refused;
  - `'my n1gga hud'` is refused with exactly `That title is not allowed here.`;
  - `'Clean HUD'` returns `'Clean HUD'`, trimmed.

  **`checkDescription(raw)`:**
  - `''` is ok;
  - 281 characters are refused;
  - five lines are refused;
  - `'see twitch.tv/x'` is refused as a link;
  - a slur is refused;
  - CRLF is normalised.

  **`checkCrosshairArt(raw, caps)`, with community caps `{ side: 128, b64: 100_000 }`:**
  - a built art with an unknown shape is refused;
  - a built art with NaN is refused;
  - a colour of `'red'` is refused;
  - an out-of-range `len` is clamped;
  - an image art whose data URL IHDR says 64x64 while `w`/`h` say 128 is refused;
  - 129x129 is refused;
  - a good 128x128 PNG passes.

  **Crosshair parity.** Import `readArt` from `web/src/crosshair/model.ts` and run it over the same
  built-art cases (vitest resolves the web module in node). Accept and refuse must agree, and clamped
  values must be equal. If importing the web module in the node project fails, move the case table into
  `web/src/crosshair/model.test.ts` and assert the server function there instead, importing
  `../../../src/community/validate`.

  **`checkHudDesign(json, { importId })`:**
  - not JSON is refused;
  - over 2 MB is refused;
  - `v: 2` is refused;
  - an unknown preset is refused;
  - an unknown aspect is refused;
  - preset `imported` without `imported.id` is refused;
  - `imported.id` that is not `importId` is refused;
  - an `importId` given for a stock design is refused;
  - an `images.panelBg.png` that is not a PNG is refused;
  - a 600-wide image is refused;
  - `xhairArt` at 512 passes, and at 513 is refused;
  - it returns `{ json, preset, aspect, advanced, importName }`, with `name` rewritten to
    `safeName(title)`.

  **`checkPreview(bytes, aspect)`:**
  - 960x540 with `16:9` passes;
  - 960x540 with `4:3` is refused;
  - 1.5 MB + 1 is refused;
  - not a PNG is refused.

  **`checkImport(bytes, claimedId, designImportId)`:**
  - a VPK from `encodeVPK` (import it from `web/src/vpk/index.ts` in the test) of the stock files passes,
    and the result holds `id` and `files`;
  - the same VPK with 3 extra bytes appended is refused as "not laid out as the editor writes it"
    (amended after review: see the tightness check below);
  - a VPK holding `cfg/autoexec.cfg` is refused, with the message naming it;
  - a claimed id mismatch is refused;
  - a design id mismatch is refused;
  - a VPK version 2 header is refused (only v1, which is what the editor writes);
  - 20 MB + 1 is refused;
  - a split archive (any entry with archive index other than `0x7FFF`, which `readVPK` puts in `split`)
    is refused.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3: Implement** `src/community/validate.ts`.
  - Each function returns `{ ok: true, value } | { ok: false, status: 400 | 413, error: string }`, the
    `Validated` shape from `profileFields`, widened with a status.
  - `findSlurs` comes from `../slurs.js`; `hasUnsafeChars` and `LINKISH` from `../profileFields.js`
    (export them there, with no behaviour change; `tests/profileFields.test.ts` stays green).
  - Port `safeName` from `web/src/hud/design.ts` (8 lines), and add a test asserting it gives the same
    output for five inputs as the web one, imported the same way as the crosshair parity test.
  - Crosshair `LIMITS`, `DRAWN` and the backdrop and resolution lists: copy them into a `const` here,
    with a comment naming `web/src/crosshair/model.ts`. The parity test keeps them honest.
  - `checkImport` uses `readVPK` from `../vpkRead.js`, `hudSetProblem` and `hudId` from `../hudFiles.js`.
    The tightness check is `canonicalVpkProblem(bytes, files)` from `../vpkRead.js`: the upload must be
    byte for byte what `encodeVPK` (moved to `src/vpkWrite.ts`) writes for the files `readVPK` returned,
    and `readVPK` refuses two paths that differ only in case. (Amended after review: the first version used
    `bytes.length === 12 + treeSize + sum(file lengths)`, which two entries over the same bytes pass.)
- [ ] **Step 4:** Run the file, then the full suite and typecheck.
- [ ] **Step 5: Commit.** `git commit -m "Validate community entries on the server: text, crosshair, design, preview, import"`

---

## Task 5: the disk store and the sweep

**Files:**
- Create: `src/community/store.ts`, `src/community/sweep.ts`, `tests/communityStore.test.ts`

- [ ] **Step 1: Write the failing tests.** Use a temp dir from `mkdtempSync(join(tmpdir(), 'community-'))`,
  removed in `afterEach`.

  **`CommunityStore`:**
  - `new CommunityStore({ dir, freeBytes, maxBytes })` creates `imports/` and `previews/`.
  - `putPreview(bytes)` returns the sha256 hex and writes `previews/<sha>.png`. Writing the same bytes
    twice writes once: the mtime is unchanged and it returns `wrote: false`.
  - `putImport(id, bytes)` writes `imports/<id>.vpk`, and returns `wrote: false` when the file exists.
  - The write is atomic: the temp name is in the same dir, and a thrown rename leaves no file behind.
    Simulate with an injected `rename` that throws.
  - `usedBytes()` sums both folders.
  - `canTake(extra)`:
    - false when `usedBytes() + extra > maxBytes`;
    - false when `freeBytes() - extra < 12 GiB`;
    - true otherwise.
  - `readPreview(sha)` and `readImport(id)` refuse anything but 64-hex names and return null when
    missing.
  - `remove(kind, name)` is idempotent.

  **`sweepCommunity(db, store, now)`:**
  - a tombstone deleted 31 days ago gets its payload set to `''`, `purged_at` set, and its preview file
    deleted;
  - its import blob is deleted only when no live entry references the same `import_id`;
  - a tombstone deleted 29 days ago is untouched;
  - a file in `previews/` referenced by no row and older than one hour is deleted, and one younger than
    an hour is kept (inject `now`, and set mtimes with `utimesSync`).
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3: Implement.**
  - `freeBytes` defaults to `statfs(dir)` (`bsize * bavail`), as `campaigns.ts` does.
  - `maxBytes` comes from the `community_store_mb` setting at call time: the route passes a getter, so a
    settings change needs no restart.
  - `FLOOR_BYTES = 12 * 1024 ** 3`, with a comment pointing at the replay floor note.
- [ ] **Step 4:** Run the file, then the full suite.
- [ ] **Step 5: Commit.** `git commit -m "Add the community file store with a size budget, a disk floor and a purge sweep"`

---

## Task 6: routes, part 1 (crosshairs, listing, likes, delete)

**Files:**
- Create: `src/community/entries.ts`, `src/routes/community.ts`, `tests/communityRoutes.test.ts`
- Modify: `src/server.ts`

- [ ] **Step 1: Write the failing tests.**
  - Build the app as `tests/ticketRoutes.test.ts` does (`openDb(':memory:')`, `buildServer({...})`), with
    `config.communityDir` pointing at a temp dir and injected `communityFreeBytes: async () => 100 * GiB`.
  - Use `authedCookie` for players A, B and MOD. Set `is_mod = 1` for MOD. Create a pending player with
    `authedCookie(app, db, P, { active: false })`.

  Cases:
  - **Anonymous `POST /api/community/crosshairs`** gets 401. Pending gets 403.
  - **A shares a built crosshair** and gets 200 `{ id }`.
    - `GET /api/community?kind=crosshair` lists it with `author.steamid === A`, `likes: 0`, and `art`
      included.
    - `GET /api/community/:id` returns it.
  - **Caps.**
    - A's third crosshair gets 409 with `You are sharing 2 crosshairs already. Delete one to share another.`
    - After `DELETE` of one, A can share again.
    - The seventh share in 24 h gets 429, even after deletes.
    - `community_uploads = '0'` gets 403 `Sharing is switched off right now.`
  - **Validation passes through:** a slur title gets 400 with the exact sentence.
  - **Likes.**
    - B `PUT .../like` twice gives `likes: 1`.
    - A liking their own entry gets 400.
    - B `DELETE .../like` gives 0.
    - The list with B's cookie shows `likedByMe`.
  - **Sort `top`:** the entry with 2 likes comes before the newer one with 0. Ties go newest first.
  - **Paging:** 30 entries across players give 24, then 6. `page` is clamped to 0..100.
  - **`author=`** filters to that player.
  - **Banned author:** after `UPDATE players SET status = 'banned'` for A, A's entries leave the list,
    but still show to A in `/mine`. (A banned player cannot log in anyway; assert through the DB query
    helper directly if the guard stops the request.)
  - **Delete.**
    - B deleting A's entry gets 403.
    - A deleting it gets 200; then public `GET /:id` gets 404, and MOD `GET /:id` gets 200 with
      `removed: { by: A, reason: null }`.
  - **`/mine`** returns `{ entries, caps: { huds: 2, crosshairs: 2, perDay: 6, sharedToday: n } }`, with
    staff-removed tombstones included and self-deleted ones left out.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3: Implement.**
  - `src/community/entries.ts` holds pure DB functions taking `db`: `listEntries`, `getEntry`,
    `mineEntries`, `countLive`, `sharesSince`, `insertEntry`, `tombstone`, `like`, `unlike`.
    - The list query joins `players` for name and avatar, and `LEFT JOIN`s a like count and a
      liked-by-viewer flag.
    - It never selects `payload` for HUDs.
    - For crosshairs it selects `payload` as `art`, parsed.
  - `src/routes/community.ts` exports `communityRoutes(app, { db, store, now? })`.
    - It uses `makeOptionalViewer`, `makeRequireActive` and `makeRequireMod` from `./guards.js`.
    - The crosshair `POST` sets `bodyLimit: 256 * 1024`.
    - Reading settings goes through `getSetting`.
  - Register it in `src/server.ts` after `campaignRoutes`, building
    `new CommunityStore({ dir: deps.config.communityDir, freeBytes: deps.communityFreeBytes, maxBytes: () => Number(getSetting(db, 'community_store_mb')) * 2 ** 20 })`.
    Add `communityFreeBytes?: () => Promise<number>` to `ServerDeps`. Warn at start, through
    `missingDirs`, only if creating the dir fails.
- [ ] **Step 4:** Run the file, then the full suite and typecheck.
- [ ] **Step 5: Commit.** `git commit -m "Serve community crosshairs: share, list, like, delete"`

---

## Task 7: routes, part 2 (HUD upload and files)

**Files:**
- Modify: `src/routes/community.ts`, `src/server.ts`, `tests/communityRoutes.test.ts`
- Create: `tests/fixtures/community/` (built in-test; nothing large is committed)

- [ ] **Step 1: Write the failing tests.** Build multipart bodies in-test with the global
  `FormData`/`Blob` and `app.inject({ payload: form })`. If Fastify inject does not accept `FormData` in
  this version, use the small manual multipart builder `campaignRoutes`' tests use
  (`grep -n "boundary" tests/campaignRoutes.test.ts`).

  - **A Modern design** plus a 960x540 PNG preview, with no import part, gives 200.
    - The list shows `preset: 'modern'`, `aspect: '16:9'`, and
      `previewUrl: /api/community/files/previews/<sha>.png`.
    - `GET` of that URL gives 200, `content-type: image/png`, `x-content-type-options: nosniff`, and
      `content-security-policy: default-src 'none'; sandbox`.
  - **An imported design** plus a preview plus a VPK from `encodeVPK` of the stock files, whose `hudId`
    matches `design.imported.id` and `meta.importId`, gives 200.
    - `GET /api/community/files/imports/<id>.vpk` gives the bytes, with `content-disposition: attachment`.
    - A second player sharing a different design on the same import gives 200, and the blob is written
      once (check the store's file count).
  - **Refusals:**
    - an import holding `cfg/autoexec.cfg` gets 400 naming it;
    - trailing bytes get 400;
    - an import that is not byte for byte `encodeVPK`'s output (two entries over the same bytes, built
      with `handMade` from `web/src/vpk/fixtures.ts` or an equivalent in-test writer) gets 400;
    - an import with two paths that differ only in case gets 400;
    - an id mismatch gets 400;
    - an import part on a stock design gets 400;
    - an imported design with no import part gets 400;
    - a preview of the wrong aspect gets 400;
    - over 20 MB gets 413;
    - `permission` not `true` gets 400 `Tick the box to confirm you may share this.`
  - **Budget:** with `community_store_mb = 100` (the minimum) and the store already holding just under
    100 MB of fake files, the next share gets 507 `The community shelf is full right now.` With injected
    free bytes of 12 GiB + 1 KB, a 2 KB share gets 507.
  - **The HUD cap:** a third HUD gets 409 with the HUD sentence.
  - **Failed insert cleanup:** force the insert to throw by passing an injected `insertEntry` that
    throws. The preview and blob written by this request are gone afterwards, and a pre-existing shared
    blob stays.
  - **Files of a tombstone:** after A deletes the entry, both file URLs give 404 to the public and 200 to
    MOD.
  - **The sweep runs at start:** build the server with a tombstone older than 30 days in the DB, then
    check it is purged (the sweep is called in `buildServer`).
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3: Implement.**
  - Inside `communityRoutes`, run
    `await app.register(multipart, { throwFileSizeLimit: false, limits: { fileSize: 20 * 2 ** 20, files: 2, fields: 1, fieldSize: 2.5 * 2 ** 20, parts: 3 } })`.
    Registered inside the plugin, it applies to these routes only.
  - `POST /api/community/huds`:
    1. Iterate `req.parts()`, reading each file with `toBuffer()`, and check `part.file.truncated`
       (413).
    2. Parse `meta`, then run `checkTitle`, `checkDescription`, the permission check, `checkHudDesign`,
       `checkPreview`, and `checkImport` when present. `checkImport` is the whole VPK check: it runs
       `readVPK` (which refuses paths that differ only in case) and then `canonicalVpkProblem`, so the
       route must not add a length rule of its own or accept anything `checkImport` did not return.
    3. Check the caps and `store.canTake(total)`.
    4. Run `putPreview` and `putImport`.
    5. Run `insertEntry` in a transaction that re-checks the caps.
    6. On any throw after a write, remove what this request wrote and nothing else.
  - The file routes validate `:sha`/`:id` against `^[0-9a-f]{64}$` before touching the disk. They look
    up a live reference, or whether the viewer is staff, and set the three headers.
    `Cache-Control: public, max-age=31536000, immutable` applies only to live references. Staff views of
    tombstone files get `no-store`.
  - Server start: run `sweepCommunity(db, store, new Date())` once in `buildServer` (inside a
    try/catch, logged with the pattern `purgeRemovedFiles` uses on master), plus a 24 h `setInterval`
    that is cleared on `app.addHook('onClose')`.
- [ ] **Step 4:** Run the file, then the full suite and typecheck.
- [ ] **Step 5: Commit.** `git commit -m "Accept community HUD uploads with preview and verified import, and serve their files safely"`

---

## Task 8: moderation (staff remove and entry reports)

**Files:**
- Modify: `src/routes/community.ts`, `src/tickets/filing.ts`, `src/tickets/views.ts`,
  `src/routes/tickets.ts` (only if `FileBody` is passed through by field name),
  `tests/communityRoutes.test.ts`, `tests/ticketFiling.test.ts`, `tests/ticketRoutes.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - **`POST /api/community/:id/remove`:**
    - by B (not staff) gets 403;
    - by MOD without a reason gets 400;
    - by MOD with `{ reason: 'offensive preview' }` gives 200, and then:
      - the entry leaves the list;
      - an `admin_actions` row exists with action `community_remove`, target A, and detail
        `{ entryId, kind, title, reason }`;
      - A's `/mine` shows it with `removedByStaff: 'offensive preview'`.
    - Removing again gets 404.
  - **`fileReport` with `entryId`** (in `tests/ticketFiling.test.ts`):
    - B reports A with `entryId` of A's entry, category `toxicity`, and gets `ok`. The row's
      `community_entry_id` is set.
    - The same again gets 409 `you already reported this`.
    - B can still file a plain report about A (no `entryId`), because the entry report does not count
      toward the open-report duplicate rule. Assert that this second one succeeds.
    - `entryId` naming C's entry while the target is A gets 400 `that entry is not theirs`.
    - A missing or removed entry gets 404 `no such entry`.
    - A non-integer gets 400.
  - **`ticketDetail`** (in `tests/ticketRoutes.test.ts`): the report carries
    `entry: { id, kind, title, removed: false }`, and after staff removal `removed: true`. Reports without
    one carry `entry: null`.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3: Implement.**
  - The remove route uses `makeRequireMod`. `tombstone(db, id, { by: staff, reason })` runs in a
    transaction, then `logAdmin(db, staff, 'community_remove', entry.author_id, {...})`.
  - `filing.ts`:
    - add `entryId?: unknown` to `FileBody`;
    - validate it after the target is known: it must be an integer, the entry must exist with no
      `deleted_at`, and `author_id` must equal the target's steamid (a Discord-only target cannot have
      entries, so 400 there);
    - the duplicate query branches: with an entry, the rule is
      `SELECT 1 FROM ticket_reports r WHERE <REPORTER_KEY_SQL> = ? AND r.community_entry_id = ?`;
    - the no-match open-report rule adds `AND r.community_entry_id IS NULL`, so entry reports do not
      block a plain one;
    - add `community_entry_id` to the INSERT column list.
  - `views.ts` `ticketDetail`:
    - `LEFT JOIN community_entries ce ON ce.id = r.community_entry_id`;
    - select `ce.id, ce.kind, ce.title, ce.deleted_at`;
    - map to `entry`.
  - Check the route passes the body straight through. If it picks fields, add `entryId`.
- [ ] **Step 4:** Run the three test files, then the full suite and typecheck.
- [ ] **Step 5: Commit.** `git commit -m "Let staff remove community entries, and file reports about a shared entry"`

---

## Task 9: web client plumbing (API, open, publish, download)

**Files:**
- Modify: `web/src/api.ts`, `web/src/routes/Hud.tsx` (move-only), `web/src/routes/Crosshair.tsx`
  (move-only)
- Create:
  - `web/src/community/open.ts`, `open.test.ts`
  - `web/src/community/publish.ts`, `publish.test.ts`
  - `web/src/community/download.ts`, `download.test.ts`
  - `web/src/hud/assets.ts`
  - `web/src/crosshair/download.ts`

- [ ] **Step 1: Move-only refactors first, as their own commit.**
  1. Move `assetsFor`, `decodeUpload` and `fontBytes` from `routes/Hud.tsx` into `web/src/hud/assets.ts`,
     and re-export them from `Hud.tsx` so `Hud.assets.test.tsx` keeps importing from where it does.
  2. Factor `Crosshair.tsx`'s download body into
     `crosshair/download.ts` `crosshairAddon(name: string, art: CrosshairArt): Promise<{ filename; bytes }>`.
     It uses `artPixels(art)` and `buildVPK(safe, TEX, TEX, px, HUDLAYOUT)`, and the page calls it.
  3. Run `npx vitest run web/src/routes web/src/crosshair` and typecheck. Both must be green.
  4. Commit: `git commit -m "Move assetsFor and the crosshair download into modules the community page can share"`
- [ ] **Step 2: Write the failing tests.**
  - **`api.ts`:**
    - `communityApi.list({ kind, sort, page, author })`
    - `communityApi.get(id)`
    - `communityApi.mine()`
    - `communityApi.shareCrosshair(body)`
    - `communityApi.shareHud(form: FormData)`
    - `communityApi.like(id)` and `unlike(id)`
    - `communityApi.remove(id, reason)` and `delete(id)`

    Add the types `CommunityEntry`, `CommunityList` and `CommunityMine`, and `api.fileReport` accepting
    `entryId`. Web tests of the api layer are thin; cover them through the users below.
  - **`open.test.ts`.** Mock `fetch` with `vi.stubGlobal`, and use `_setHudStore(memoryStore())`.
    - A good blob (an `encodeVPK` of the stock files, with its `hudId`) is:
      - registered with `isCommunityImport` true;
      - stored with `community: { entryId }` and `name` = the entry title through `safeName`;
      - returned as `{ id }`.
    - A blob already in the store is not fetched: assert `fetch` was not called.
    - A blob with `cfg/autoexec.cfg` inside is refused with `This community HUD failed its safety check`,
      and nothing is registered or stored.
    - A blob whose hash is not the entry's `import_id` is refused the same way.
    - A 404 gives `This community HUD's files are no longer available.`
  - **`publish.test.ts`:**
    - `prepareHudShare(design)` on a Modern design gives `{ design, importFiles: null, left: [] }`.
    - On an imported design with `cfg/autoexec.cfg` in the registered import, it gives:
      - `left` listing it;
      - `importFiles` without it;
      - `design.imported.id` equal to `hudId(importFiles)`, and different from the original id;
      - the new set registered, so `importProblem` ran. Spy on it or assert through `hasImport`.
    - A set that breaks a cap after filtering throws the cap sentence.
    - `renderPreview(design)` returns a PNG `Blob` of 960x540 for 16:9 and 720x540 for 4:3. Stub canvas
      as `Crosshair.test.tsx` does, and assert the requested canvas size and the `toBlob` type.
    - `buildHudForm({ title, description, permission, prepared, preview })` produces a `FormData` with
      exactly the parts `meta`, `preview`, and `import` (only when `importFiles`), where the import
      bytes are `encodeVPK` of the files.
  - **`download.test.ts`:**
    - `downloadCommunityHud(entry)` on a Modern entry calls `packHud` with a `validateDesign`-ed design
      and returns `{ filename: '<safeName>.vpk' }`;
    - on an imported entry it calls `openCommunityImport` first;
    - `downloadCommunityCrosshair(entry)` returns a `.vpk` whose files are the crosshair page's own. Read
      it back with `readVPK`.
- [ ] **Step 3: Implement.**
  - **`open.ts`:**
    1. Check `hudStore().get(id)`; if it is missing, `fetch(/api/community/files/imports/<id>.vpk)`.
    2. Run `readVPK`, reject `split`, then `hudSetProblem` and `hudId`. On any mismatch throw the safety
       sentence.
    3. `registerImport(id, files, { community: true })`, then `importProblem(id)`. On a problem,
       unregister and throw `This community HUD cannot be shown: <problem>`.
    4. `hudStore().put(...)`. A put failure is non-fatal and gets the same "kept only until this page
       closes" note the import flow has.
  - **`publish.ts`:**
    - `renderPreview` draws with `drawBackdrop(ctx, w, h, 'scene', null, null)` and then
      `drawHud(ctx, w, h, design, 'survivor', null, onAsset, { state: 'healthy', held: 'primary' })`.
    - It repaints on each `onAsset`, and resolves after 300 ms with no asset or after 3 s in all.
    - It awaits `document.fonts?.ready` first.
    - Sizes: `{ '16:9': 960, '16:10': 864, '4:3': 720 }` x 540.
  - **`download.ts`** lazy-imports nothing itself. The page lazy-imports this module, which is what keeps
    the editor bundle off the gallery's first load.
- [ ] **Step 4:** Run `npx vitest run web/src/community web/src/hud web/src/crosshair`, then the full
  suite and typecheck.
- [ ] **Step 5: Commit.** `git commit -m "Add the web side of community sharing: api, open, publish and download"`

---

## Task 10: the community pages, cards and nav

**Files:**
- Create:
  - `web/src/components/CommunityCard.tsx`
  - `web/src/routes/Community.tsx`, `web/src/routes/Community.test.tsx`
  - `web/src/routes/CommunityEntry.tsx`, `web/src/routes/CommunityEntry.test.tsx`
- Modify: `web/src/main.tsx`, `web/src/components/Nav.tsx`, `web/src/components/ReportPlayer.tsx`,
  `web/src/routes/admin/AdminTicket.tsx`, `web/src/styles/app.css`, `web/src/routes/routes.test.tsx`

- [ ] **Step 1: Write the failing tests.** Mock `../api` as `routes/tickets.test.tsx` does.
  - **`Community.test.tsx`:**
    - it renders HUD cards from `communityApi.list`: the title as text, the author link
      `/player/<steamid>`, the preview `img` src, and the badge text `Modern`;
    - a title of `<img src=x onerror=alert(1)>` renders as literal text: assert
      `container.querySelector('img[src="x"]')` is null;
    - switching to Crosshairs calls `list` with `kind: 'crosshair'` and draws a canvas per card;
    - the sort toggle calls with `sort: 'top'`;
    - Next calls with `page: 1`;
    - the like button:
      - anonymous: disabled, with the title `Sign in to like`;
      - active: calls `like` and then shows the count + 1;
      - on your own entry: no button;
    - **Remove** shows only for `isMod || isAdmin`, asks for a reason with a prompt dialog, and calls
      `remove`;
    - **Report** opens `ReportPlayer` with the author fixed and the text
      `About their shared HUD '<title>'`;
    - **Open in the HUD editor** is a link to `/hud?community=<id>`;
    - **Download** calls the lazy module (mock `../community/download`).
  - **`CommunityEntry.test.tsx`:**
    - it renders one entry;
    - a 404 renders `This entry was removed.`;
    - staff see the removal line.
  - **`routes.test.tsx`:** the `/community` and `/community/:id` routes resolve. The nav has a
    `Community` link.
  - **`AdminTicket`:** a report with `entry` shows a link `/community/<id>` with the title, and
    `(removed)` when removed. Extend `routes/tickets.test.tsx`.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3: Implement.**
  - **Cards.** Use `Panel` from `components/bits.tsx`, and `PlayerLink` for the author. Crosshair cards
    draw with `drawArt` into a 96x96 canvas over `drawBackdrop(..., 'scene')`.
  - **Styles.** Add them to `app.css` under a `.community` block, following the site's poster look:
    - the card grid is `repeat(auto-fill, minmax(280px, 1fr))`;
    - at phone width, one column with no horizontal overflow (the shoot script flags overflow).
  - **Routes in `main.tsx`:**
    - `<Route path="/community" component={Community} session={session} />`
    - `<Route path="/community/:id" component={CommunityEntry} session={session} />`

    Both are lazy, as `Hud` is.
  - **Nav:** add `['/community', 'Community']` after `HUD` in `NAV_LINKS`.
  - **`ReportPlayer`:** add `entry?: { id: number; kind: 'hud' | 'crosshair'; title: string }`. With an
    entry:
    - show the "About their shared HUD" or "About their shared crosshair" line;
    - pass `entryId` to `api.fileReport`;
    - hide the match picker.
- [ ] **Step 4:** Run the files, then the full suite and typecheck.
- [ ] **Step 5: Commit.** `git commit -m "Add the community page, entry page, cards, nav link and entry reports"`

---

## Task 11: sharing from the editors, and opening into them

**Files:**
- Create: `web/src/components/ShareDialog.tsx`, `web/src/components/ShareDialog.test.tsx`
- Modify: `web/src/routes/Hud.tsx`, `web/src/routes/hud/Toolbar.tsx`,
  `web/src/routes/hud/CrosshairControls.tsx`, `web/src/routes/Crosshair.tsx`, `web/src/routes/Hud.test.tsx`,
  `web/src/routes/Crosshair.test.tsx`, `web/src/main.tsx` (pass `session` to `/hud` and `/crosshair`)

- [ ] **Step 1: Write the failing tests.**
  - **`ShareDialog.test.tsx`** (props: `kind`, `session`, `prepare: () => Promise<Prepared>`,
    `onShared(id)`):
    - Anonymous shows `Sign in with Steam to share.` and a link to `/auth/steam`.
    - Active at the cap (`mine` says 2 HUDs) shows the cap sentence, links to both entries, and disables
      Share.
    - With `left: ['cfg/autoexec.cfg: not a HUD file']`, it shows `Left out when sharing:` and the line.
    - Share is disabled until the title has 3 or more characters and the permission box is ticked.
    - On Share it calls `shareHud` with the form, then shows `Shared. See it on the community page.`
      with a link to `/community/<id>`.
    - A server error shows its message in `.error`.
  - **`Hud.test.tsx`:**
    - The toolbar has `Share to community...`. It is disabled while the design is locked, meaning its
      import is missing.
    - With `?community=5` in the URL, mock `communityApi.get` to return a Modern design entry. The page
      asks `Load the HUD design from this link?` (the same confirm as the share link). On Load, the
      design matches the entry's design after `validateDesign`, Undo returns the previous design, and
      the query parameter is gone from `location.search`.
    - With `?community=6` for an imported entry, mock `openCommunityImport`. It is called before the
      design applies, and on its throw the status shows the sentence and the design is unchanged.
    - With `?xhair=7` (a crosshair entry): one undoable step sets `crosshair: 'bundle'` and `xhairArt` to
      the entry's art, and selects `xhair`, like `?from=crosshair`.
  - **`Crosshair.test.tsx`:**
    - The page has `Share to community...`.
    - With `?community=7` and a built art, it asks before replacing, then the builder shows the entry's
      state (a slider value) and `localStorage.xhair` holds it.
    - With an image art, `xhairImage` holds the PNG and the shape is `image`.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3: Implement.**
  - The dialog follows the site's existing modal (`grep -rn "role=\"dialog\"" web/src/components`) and
    reads `communityApi.mine()` on open.
  - For a HUD, the `prepare` callback runs `prepareHudShare(current design)` and then `renderPreview`,
    and shows the preview as an `<img>` of an object URL (revoked on close).
  - In `Hud.tsx`, add the two mount effects after the existing `#d=` and `?from=crosshair` effects. Each
    strips its parameter with `history.replaceState`, as those do.
- [ ] **Step 4:** Run the files, then the full suite and typecheck.
- [ ] **Step 5: Commit.** `git commit -m "Share HUDs and crosshairs from the editors, and open community entries in them"`

---

## Task 12: the Profile panel

**Files:**
- Modify: `web/src/routes/Profile.tsx`, `web/src/routes/routes.test.tsx` (or a new
  `web/src/routes/Profile.community.test.tsx`)

- [ ] **Step 1: Write the failing test.**
  - With `communityApi.list({ author })` returning two entries, the profile shows a `Shared` panel with
    two compact cards linking to `/community/<id>`.
  - With none, there is no `Shared` heading.
  - A list failure hides the panel. It is decoration and must never break the profile.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3: Implement.** Add a `<SharedPanel steamid={steamid} />` after `EndorsementCounts`. It
  uses `useFetch` and `CommunityCard` in compact mode.
- [ ] **Step 4:** Run, then the full suite and typecheck.
- [ ] **Step 5: Commit.** `git commit -m "Show a player's shared HUDs and crosshairs on their profile"`

---

## Task 13: final checks and the headless browser pass (CONTROLLER or one implementer)

**Files:**
- Modify: `vite.config.ts`
- Create: `scripts/shoot-community.mjs`

- [ ] **Step 1: Let the dev proxy point at a spare API port.** In `vite.config.ts`, add
  `const api = \`http://localhost:${process.env.API_PORT ?? 8080}\`` and use it for `/api` and `/auth`,
  and the ws form for `/ws`. The default behaviour is unchanged. Commit:
  `git commit -m "Let the dev proxy target another API port"`.
- [ ] **Step 2: Run the full suite and typecheck.** Record the final counts in the report.
- [ ] **Step 3: Start the API and vite on spare ports** with a scratch DB and store, never the real
  `data/`. Do not use :5199 (the owner's HUD test server) or :8080/:5173 (other sessions).

  ```bash
  S=/tmp/claude-1000/-home-volence-l4d/<session>/scratchpad/community-check; mkdir -p $S
  cd /home/volence/l4d/pug/.claude/worktrees/hud-community
  DEV_MODE=1 PORT=8098 DB_PATH=$S/pug.db COMMUNITY_DIR=$S/community REPLAY_DIR=$S/replays \
    setsid nohup npx tsx src/index.ts > $S/api.log 2>&1 &
  API_PORT=8098 setsid nohup npx vite --port 5198 --strictPort --host 127.0.0.1 > $S/vite.log 2>&1 &
  ```

  If `src/index.ts` needs more env to boot in dev mode, copy what `npm run dev:api` sets. Check
  `src/config.ts` for required keys: a dev cookie secret and the like.
- [ ] **Step 4: Write `scripts/shoot-community.mjs`,** modelled on `scripts/shoot-pages.mjs` (raw CDP,
  headless Chrome, its own `--user-data-dir` under the scratchpad, debugging port 9341). It:
  1. `POST`s `/api/dev/login` with `{ steamid: '76561198000000001' }` through `Runtime.evaluate`
     `fetch` in the page, so the cookie lands in the browser.
  2. Shares a crosshair through `fetch('/api/community/crosshairs', ...)`.
  3. Opens `/hud`, sets `localStorage.hud` to a Modern design JSON, reloads, clicks
     `Share to community...`, fills the title, ticks the box, and clicks Share. It waits for
     `Shared.`.
  4. Opens `/community` at 1400 and 390 wide. It screenshots each to `$S/shots/`, and fails on empty
     cards or horizontal overflow (copy the checks from `shoot-pages.mjs`).
  5. Clicks the HUD card's **Open in the HUD editor**, accepts the confirm, and checks that the editor's
     canvas is drawn. Read it with `canvas.toDataURL()`, not a CDP capture: the memory note says CDP
     `captureBeyondViewport` shifts the page 7 px. Checking that it is not all one colour is enough.
  6. Clicks **Download** on the HUD card and checks, through
     `Page.setDownloadBehavior({ behavior: 'allow', downloadPath: $S/dl })`, that a `.vpk` lands. Reads
     it back with node (`import { readVPK } from '../src/vpkRead.ts'` via tsx) and asserts every path
     passes `hudPathProblem` or is `addoninfo.txt`.

  Any file input must use a fixture under `/home/volence/l4d/`. Headless Chrome cannot read files under
  `/tmp/claude-1000` (see the HUD editor memory note). Copy one there first if the imported-HUD path is
  exercised, and delete it afterwards.
- [ ] **Step 5:** Run `node scripts/shoot-community.mjs`. It must exit 0. Look at the four screenshots
  yourself.
- [ ] **Step 6: Stop both servers** by the PIDs you started. Never kill by name. Other sessions and the
  owner run vite and srcds on this machine. Remove the scratch dir.
- [ ] **Step 7:** Commit the script:
  `git add scripts/shoot-community.mjs && git commit -m "Add a headless check for the community page"`.
- [ ] **Step 8: Final whole-feature review** (superpowers:requesting-code-review) over
  `248754a..HEAD` minus the master merge (`git diff <merge-commit>..HEAD`). Pay particular attention to:
  - the allowlist and its three enforcement points;
  - the file-route headers;
  - `fileReport`'s duplicate-rule change;
  - `mergePlayers`.

**Not in this plan:** merging into `worktree-hud-editor` or master, deploying, and the owner's check. All
three wait for the owner.

## Owner check (after approval, not part of the implementation)

1. Share a Modern HUD, an imported HUD and a crosshair from a real account on a local run.
2. Download each from a second account.
3. Install the HUD download in game, on campaign Expert map 2
   (`sv_cheats 1; z_difficulty impossible; map l4d_hospital02_subway`).
4. Confirm the VPK holds only HUD files: open it with the editor's import and read the file list.
