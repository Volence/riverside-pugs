# Balance Watch File Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** pug-match reads the balance watch list (cvars, files, dirs, weapon keys) from `addons/sourcemod/data/pug_balance_watch.txt`, which the site writes; watch-list-only fingerprint changes fold silently.

**Architecture:** `src/balanceWatch.ts` renders the file from `balance/knobs.json` and a `BalanceWatchWriter` keeps it on every box (write only when different, remember what was verified). `recordBalanceSighting` folds a new patch into the server's previous one when the only differences are keys present on one side (`c: x: w: f: d:`). The plugin parses the file at map start (fallback: the compiled list), reports weapon keys from the info editor file as `w:` items, and tags `BALANCE_END` with `watch=file|builtin`.

**Tech Stack:** TypeScript, SourcePawn 1.12 (`plugin/build.sh`), vitest.

**Spec:** `docs/superpowers/specs/2026-09-24-balance-watch-file-design.md`

## Global Constraints

- Written while the owner was away: nothing deployed, nothing pushed, no live server touched. Plugin tested only by compiling and, if possible, on the local test server.
- A box without the watch file must report exactly what it reports today (compiled fallback).
- The writer never runs in dev mode and never writes a busy box.
- Plugin version `0.3.12`.

---

### Task 1: Site: render, parse `w:`, writer, wiring

**Files:** Create `src/balanceWatch.ts`, `tests/balanceWatch.test.ts`; modify `src/logParse.ts` (`BAL_ITEM_RE = /^[cxpfdw]:/`), `src/balanceKnobs.ts` (optional `weapons?: { weapon: string; key: string; label: string }[]` in `BalanceKnobs`, validated), `src/server.ts` (construct, start/stop, chain into the releaser hook).

**Interfaces:**
- `WATCH_FILE = 'pug_balance_watch.txt'`
- `renderWatchFile(k: BalanceKnobs): string` (header comment, then `cvar`, `file`, `dir <path> <ext>`, `weapon <classname> <key>` lines in knobs order, trailing newline)
- `dataDirOf(server): string | null` (`<addons_dir>/sourcemod/data`)
- `class BalanceWatchWriter({ db, content: () => string | null, transport?, intervalMs?, timeoutMs? })` with `sync(): Promise<{ serverId: number; server: string; ok: boolean; wrote?: boolean; skipped?: string; error?: string }[]>`, `writeForRelease(serverId): Promise<void>` (never rejects), `start()`, `stop()`. A box is skipped while not idle (except `offline` in the release hook); a verified (server, content) pair is not re-read for 6 hours; failures post one `problem` per server until it succeeds again.

Tests: render output for the fixture knobs (with a weapon entry); parser keeps a `w:` item; writer writes when missing, does not write when equal, rewrites when content changes, skips a live box, isolates a failing box, posts one problem for repeated failures, does nothing when `content()` is null.

### Task 2: Site: watch-list-only changes fold at sighting

**Files:** modify `src/balancePatches.ts` (`recordBalanceSighting`), `tests/balancePatches.test.ts`.

Rule: on a **new** patch with a previous server state, diff the server's previous inventory (after the ignored list) against the new one, dropping changed versionless-plugin builds. If nothing changed value and every added or removed key starts with `c:`, `x:`, `w:`, `f:` or `d:`, fold the new patch into the previous patch (resolved) before tagging the round, and publish no alert. Tests: added cvar folds silently; removed weapon key folds; a changed cvar value opens a pending patch and alerts as before; a plugin added does not fold.

### Task 3: Plugin

**Files:** modify `plugin/pug-balance.inc`, `plugin/pug-match.sp` (version `0.3.12`).

- Globals: `ArrayList g_hWatchCvars, g_hWatchFiles, g_hWatchDirs, g_hWatchDirExt, g_hWatchWeapons` (weapon entries stored as `"classname key"`), `bool g_bWatchFromFile`.
- `BalanceLoadWatch()` at the top of `BalanceScanStatic()`: clear the lists; read `BuildPath(Path_SM, "data/pug_balance_watch.txt")` line by line (`ReadLine`, `TrimString`, skip empty and `//`), split on spaces (`ExplodeString`, up to 3 parts), fill by kind with the spec's limits; if no entries were read, copy the compiled arrays and set `g_bWatchFromFile = false`.
- Scan files and dirs from the lists. Weapons: `KeyValues kv = new KeyValues("weapon_info"); kv.ImportFromFile(<data/l4d_info_editor_weapons.cfg>)`; per entry `kv.Rewind(); kv.JumpToKey("all") && kv.JumpToKey(classname)` then `GetString(key, val, sizeof(val), "")`, empty = `default`; `BalPush("w", "classname.key", value)`.
- `EmitBalance()` iterates `g_hWatchCvars`; `BALANCE_END ... watch=file|builtin`.
- Compile with `plugin/build.sh`; if a local test server is available, check the BALANCE lines with the file present, missing, and with a weapon entry.
