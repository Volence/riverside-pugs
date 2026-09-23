# SourceTV Watch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every SourceTV spectator on every server is recorded (name, hashed connection, match, join/leave times and leave reason, plus SourceTV server start/stop), admins see it on the match page, and a spectator on the same connection as a player in that live match is posted to the admin feed.

**Architecture:** A SourceMod plugin (`plugin/l4d_tvwatch.sp`) built on the `sourcetvmanager` extension emits signed `PUGTV` log lines. `src/logParse.ts` parses them into a `sourcetv` event; `src/sourcetvSessions.ts` keeps `sourcetv_sessions` rows (hash only, never the raw IP) and raises the admin alert; `/api/matches/:id` carries the sessions for admins and `MatchDetail.tsx` shows them.

**Tech Stack:** TypeScript (Node 22, ESM, `.js` import suffixes), Fastify, better-sqlite3, vitest, Preact; SourcePawn 1.12 (compiled with the Linux `spcomp` of the local test server).

**Spec:** `docs/superpowers/specs/2026-09-23-sourcetv-watch-design.md`. Findings since the spec (2026-09-23 local spike): the extension loads beside `sourcetvsupport` and reports spectators; an empty server hibernates and a spectator connecting wakes it, which reloads the map and drops them ("Server shutting down"); on a normal map change SourceTV stayed up and carried the spectator over. The drop diagnosis now comes from real matches via the `leave` reason and `start`/`stop` lines this plan records.

## Global Constraints

- The raw spectator IP is never stored. Only `hashIp(db, ip)` from `src/playerNetworks.ts` (the same HMAC `PUGNET` uses).
- `PUGTV` lines are trusted exactly like `PUGNET`: the marker must open the line right after the engine's stamp (no player text can reach it), and the name is always LAST on the line so a name cannot forge an earlier field.
- Likely accounts are evidence, not proof; admin copy says so ("same connection as", never "is").
- Admin only: the sessions never appear in a non-admin API response.
- The alert fires only when a likely account is rostered in the match live on that same server at join time; at most once per session.
- Listener safety: every new handler in `src/server.ts` is wrapped in try/catch like the `player_net` branch, because the listener also carries `match_end`.
- Never use em dashes in code, comments, docs or commits.
- Before each commit: `npx vitest run` and `npx tsc --noEmit -p .`. In the worktree first `ln -s /home/volence/l4d/pug/node_modules node_modules` and `ln -s /home/volence/l4d/pug/dist dist`; never commit those links (stage files by name).

## File structure

- Modify `src/logParse.ts`: `PUGTV` parsing, new `sourcetv` event type.
- Create `src/sourcetvSessions.ts`: table access, session open/close, likely accounts, alert trigger.
- Modify `src/db.ts`: `sourcetv_sessions` table.
- Modify `src/adminFeed.ts`: `sourcetv_watch` event kind + `FEED_SETTING` entry.
- Modify `src/discord/adminFeedPoster.ts`: text for the new kind.
- Modify `src/server.ts`: route the `sourcetv` event.
- Modify `src/routes/stats.ts` (`GET /api/matches/:id`): admin-only `sourcetv` field.
- Modify `web/src/api.ts`, `web/src/routes/MatchDetail.tsx`: types and the admin-only section.
- Create `plugin/l4d_tvwatch.sp`, `plugin/build-tvwatch.sh`, and vendor `plugin/include/sourcetvmanager.inc`.
- Tests: `tests/logParse*.test.ts` (follow the file that already tests `PUGNET`), `tests/sourcetvSessions.test.ts`, additions to the match route test and the MatchDetail test.

---

### Task 1: Parse `PUGTV` lines

**Files:** Modify `src/logParse.ts` (beside the `PUGNET` branch, ~line 408, and the event union type). Test: the existing test file that covers `PUGNET` (find with `grep -ln PUGNET tests`).

**Interfaces:**
- Produces the event variant:
  ```ts
  | { kind: 'sourcetv'; event: 'join'; slot: number; ip: string; country: string | null; name: string }
  | { kind: 'sourcetv'; event: 'leave'; slot: number; reason: string; name: string }
  | { kind: 'sourcetv'; event: 'start' | 'stop' }
  ```

Line formats emitted by the plugin (Task 5), marker first, name last:
```
PUGTV event=join slot=3 ip=203.0.113.7 cc=US name=some name here
PUGTV event=leave slot=3 reason=Disconnect by user. name=some name here
PUGTV event=start
PUGTV event=stop
```
`reason` is free text, so for `leave` the parser takes `reason=` up to ` name=` and the name after the first ` name=`, like `MATCH_ROSTER` does (`name=` is the last field, and the reason sits between `reason=` and ` name=`). Keys before `reason=` (`event`, `slot`) come from a `kv()` over the slice before `reason=` only.

- [ ] **Step 1: Failing tests**, one per case:
  - a join line parses to the join event (country upper-cased; a non two-letter `cc` becomes null);
  - a join line whose NAME contains ` slot=9 ip=1.2.3.4 cc=RU` keeps slot, ip and cc from the real fields;
  - a leave line with a multi-word reason and a name containing ` reason=x` parses both correctly;
  - `start` and `stop` parse;
  - a join with a malformed ip (`ip=abc`), a missing slot, or a negative slot returns null;
  - `PUGTV` not at the start of the body (after the engine stamp) is not parsed, the same protection test `PUGNET` has.
- [ ] **Step 2:** run, see them fail.
- [ ] **Step 3:** implement, mirroring the `PUGNET` branch's shape checks (IPv4 regex, two-letter country), slot an integer 0..255, name cut to 128 characters, reason to 128.
- [ ] **Step 4:** run the file, then full suite and typecheck.
- [ ] **Step 5:** commit `Parse PUGTV lines: SourceTV spectators joining and leaving, and SourceTV starting and stopping`.

---

### Task 2: `sourcetv_sessions` and the session keeper

**Files:** Modify `src/db.ts` (new table beside `player_networks`); create `src/sourcetvSessions.ts`; modify `src/server.ts` (a `sourcetv` branch next to `player_net`, ~line 781). Test: `tests/sourcetvSessions.test.ts`.

**Interfaces:**
- Consumes: the Task 1 event; `hashIp(db, ip)` from `src/playerNetworks.ts`.
- Produces:
  - `recordSourceTv(db: DB, serverId: number, ev: SourceTvEvent, nowIso?: string): { opened?: number }` (returns the new row id on a join)
  - `sessionsForMatch(db: DB, matchId: number): SourceTvSession[]`
  - `likelyAccounts(db: DB, ipHash: string): { steamid: string; name: string | null }[]`
  - type `SourceTvSession = { id: number; name: string; country: string | null; joinedAt: string; leftAt: string | null; leaveReason: string | null; accounts: { steamid: string; name: string | null }[] }`

Table:
```sql
CREATE TABLE IF NOT EXISTS sourcetv_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id    INTEGER NOT NULL,
  match_id     INTEGER REFERENCES matches(id),
  slot         INTEGER NOT NULL,
  name         TEXT NOT NULL,
  ip_hash      TEXT NOT NULL,
  country      TEXT,
  joined_at    TEXT NOT NULL DEFAULT (datetime('now')),
  left_at      TEXT,
  leave_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_stv_match ON sourcetv_sessions(match_id);
CREATE INDEX IF NOT EXISTS idx_stv_open ON sourcetv_sessions(server_id, slot) WHERE left_at IS NULL;
```
Also record server start/stop so the drop diagnosis has them: a second table
```sql
CREATE TABLE IF NOT EXISTS sourcetv_server_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('start','stop')), at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Rules:
- **join:** first close any open row on the same `server_id` and `slot` (`left_at = now`, `leave_reason = 'replaced'`), then insert. `match_id` = the match with `state = 'live'` and `server_id = ?` at that moment, else null. `ip_hash = hashIp(db, ip)`; the raw ip goes nowhere else.
- **leave:** close the open row for that server and slot (reason stored). No open row: ignore.
- **stop:** insert the server event, and close every open row on that server with `leave_reason = 'SourceTV stopped'`.
- **start:** insert the server event.
- `likelyAccounts`: the steamids in `player_networks` whose hash equals `ipHash` (read `src/playerNetworks.ts` for the column names and reuse its query shape), with `players.name`.
- Check `src/mergePlayers.ts`: these tables have no player column, so nothing to add there; say so in the report.

`src/server.ts`: `if (ev.kind === 'sourcetv') { try { const sid = serverOf(source, meta); if (sid !== null) onSourceTv(deps.db, sid, ev); } catch (err) { console.error('[sourcetv] failed to record:', err); } return; }` where `onSourceTv` is exported from `src/sourcetvSessions.ts` and calls `recordSourceTv` then (Task 3) the alert.

- [ ] **Step 1: Failing tests:** join opens a row with the hash and not the raw ip anywhere in the table (assert no column contains the ip string); join picks the live match on that server and not one on another server; leave closes it with the reason; a second join on an open slot closes the stale row as `replaced`; stop closes all open rows on that server only and records the event; start records the event; `likelyAccounts` returns the players whose recorded network matches and nobody else.
- [ ] **Step 2-4:** fail, implement, pass; full suite and typecheck.
- [ ] **Step 5:** commit `SourceTV sessions: who watched, from which connection, and when, hashed like player connections`.

---

### Task 3: Admin feed alert

**Files:** Modify `src/adminFeed.ts` (union + `FEED_SETTING`), `src/discord/adminFeedPoster.ts` (message text), `src/sourcetvSessions.ts` (`onSourceTv` publishes). Test: `tests/sourcetvSessions.test.ts` and the poster's existing test file.

**Interfaces:**
- New `AdminEvent` variant: `{ kind: 'sourcetv_watch'; matchId: number; serverId: number; spectatorName: string; steamid: string }` with `FEED_SETTING.sourcetv_watch = 'admin_feed_problems'`.

Rule: after a join is recorded, if `match_id` is set, for each `likelyAccounts` steamid that is in `match_players` for that match, publish one event (per steamid, per session). Nothing for a spectator matching nobody or only players outside that match.

Poster text (follow the style of the `signon_drop` / `lilac_flag` entries): "SourceTV spectator **<spectatorName>** is on the same connection as **<player>**, who is playing match #<id>. Same connection is evidence, not proof." with the match link the other kinds use.

- [ ] **Step 1: Failing tests:** alert published for a rostered likely account; none for no match, none for a likely account not in that match, none twice for the same session; poster renders the text with the player's name.
- [ ] **Step 2-4:** fail, implement, pass; full suite and typecheck.
- [ ] **Step 5:** commit `Post to the admin feed when a SourceTV spectator shares a connection with a player in that match`.

---

### Task 4: Admins see the watchers on the match page

**Files:** Modify `src/routes/stats.ts` (`GET /api/matches/:id`), `web/src/api.ts` (response type), `web/src/routes/MatchDetail.tsx`. Tests: the existing route test for `/api/matches/:id` and `web/src/routes/MatchDetail` test (find with grep).

- Response gains `sourcetv?: SourceTvSession[]` ONLY when `viewerOf(req)` is an admin (find how the route or its neighbours already decide admin for a viewer; reuse that, do not invent a new check). Non-admins get no field at all.
- `MatchDetail.tsx`: when `sourcetv` is present, an admin-only panel "SourceTV watchers" listing each session: name, country, joined and left times (local time, the format the page already uses), leave reason, and "same connection as" followed by account links (profile links the page already uses) or "no known account". Empty list: "Nobody watched on SourceTV." Follow the page's existing panel components and CSS; no new styles unless unavoidable.

- [ ] **Step 1: Failing tests:** route: admin gets `sourcetv` with the sessions; non-admin gets no `sourcetv` key; page: renders the panel with a session and its account link when present, renders nothing when the field is absent.
- [ ] **Step 2-4:** fail, implement, pass; full suite and typecheck.
- [ ] **Step 5:** commit `Show admins who watched a match on SourceTV`.

---

### Task 5: The plugin

**Files:** Create `plugin/l4d_tvwatch.sp`, `plugin/build-tvwatch.sh`, `plugin/include/sourcetvmanager.inc` (copy of `/home/volence/l4d/sourcetv/sourcetvmanager/build-u22/package/addons/sourcemod/scripting/include/sourcetvmanager.inc`).

Read `plugin/pug-logauth.inc` (how `PugLog` signs a line and how `PugLogAuth_Init` is called), how `pug-match.sp` emits `PUGNET` (GeoIP country lookup, ~line 620), and `plugin/build.sh` (how includes are copied into the scripting tree and compiled).

Behaviour:
- `OnPluginStart`: `PugLogAuth_Init()`.
- `SourceTV_OnServerStart(instance)` -> `PugLog("PUGTV event=start")`; `SourceTV_OnServerShutdown` -> `PugLog("PUGTV event=stop")`.
- `SourceTV_OnSpectatorConnected(client)`: skip if `SourceTV_IsClientProxy(client)`; get name and IP with `SourceTV_GetClientName`/`SourceTV_GetClientIP`; the IP may carry `:port`, strip it; country via GeoIP the same way `PUGNET` does (omit `cc=` when unknown); `PugLog("PUGTV event=join slot=%d ip=%s cc=%s name=%s", ...)` with the name sanitised exactly as pug-match sanitises names for its lines (bytes < 32 and 127 removed).
- `SourceTV_OnSpectatorDisconnected(client, reason)`: `PugLog("PUGTV event=leave slot=%d reason=%s name=%s", ...)`; the name read in the disconnect forward may already be gone, so cache names per slot at connect and use the cache.
- `plugin/build-tvwatch.sh`: compile with the same spcomp and include arrangement as `plugin/build.sh`, output `plugin/l4d_tvwatch.smx`.

- [ ] **Step 1:** write the plugin and build script; compile clean (warnings only from the SourceMod headers, as today's builds).
- [ ] **Step 2:** commit `l4d_tvwatch: signed PUGTV lines for SourceTV spectators and SourceTV start and stop`. (The controller load-tests it on the local server with a real spectator before rollout; the implementer does not need a game client.)

---

## Rollout (controller, with the owner's go-ahead and empty servers)

1. Merge, `deploy-web.sh` (DB backup first).
2. Local server: load extension + plugin, one real spectator join/leave, confirm the lines land and a session appears on a local site or in the parsed log.
3. Stage extension (`sourcetvmanager.ext.2.l4d.so` + `gamedata/sourcetvmanager.games.txt`) and `l4d_tvwatch.smx` on Dallas empty; confirm `sm exts list` and a `PUGTV event=start` after a map change; then Riverside #3/#4 and Chicago. Add both to `deploy/overrides` and the nfo stage so deploys keep them.
4. Only after 3: `tv_delay 0` on all four (Dallas/Riverside cfg overrides, Chicago cfg), takes effect next map.
5. After a few real matches: read `sourcetv_sessions.leave_reason` and `sourcetv_server_events` around map changes; bring the drop findings to the owner.
