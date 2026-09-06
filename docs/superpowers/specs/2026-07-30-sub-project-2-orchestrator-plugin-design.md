# Sub-project 2 Design: Orchestrator + `pug-match` Plugin + Deploy

**Date:** 2026-07-30
**Status:** Approved design, pre-implementation
**Builds on:** sub-project 1 (backend core) at `/home/volence/l4d/pug`
**Parent spec:** `2026-07-30-l4d1-pug-system-design.md`

## Goal

Make a real match actually happen: the backend claims a game server, configures a
match on it over RCON, the `pug-match` plugin enforces the roster and runs the
campaign-minus-finale on top of Rotoblin, and the backend receives authoritative
per-map scores and per-player stats to move the match out of `configuring` →
`live` → `completed`. (SR updates, stats pages, and Discord are sub-project 3.)

## Research findings that shaped this design

Investigation of the local Rotoblin-AZMod and L4D1_2-Plugins clones (2026-07-30):

1. **Rotoblin already implements the match internals.** Layer on it; do not
   reimplement.
   - `l4dready.sp` exposes forwards `OnRoundIsLivePre()` / `OnRoundIsLive()` and
     natives `IsInReady()` / `IsReady(client)`, the go-live signal.
   - `l4dscores.sp` tracks versus scores via `L4D_GetTeamScore(logical_team,
     campaign_score)` and the `left4dhooks` forwards `L4D_OnSetCampaignScores`
     (fires after the 2nd round of a map) and `L4D_OnClearTeamScores` (fires at
     each chapter start). It also owns the **logical-team ↔ current-team swap
     bookkeeping** (`l4dscores.sp:2117-2246`), the trickiest part of L4D versus
     scoring, already solved.
   - `l4dcompstats.sp` (1388 lines) already captures SI damage, SI kills, common
     kills, FF (derived from `player_hurt`), and more, with correct
     `IsInReady()` / round-end guards. It is the reference to port/trim.
2. **Finale detection is one native**: `L4D_IsMissionFinalMap(true)` at
   `OnMapStart` (real `SDKCall`, confirmed in `l4dd_natives.sp`).
3. **`LogToGame`, not `LogMessage`/`LogAction`, is the only native that reaches
   the `logaddress` UDP stream.** SourceMod's own logging natives write to a
   separate per-plugin file and never leave the box. This is the single
   easiest-to-get-wrong fact in the whole sub-project.
4. **`left4dhooks` is already loaded on the live config** as part of Rotoblin, so
   depending on its natives adds **zero new extension risk**, it is not a new
   dependency we introduce, it is one already proven on this exact server.
5. **Roster/team-lock has a proven local pattern**: `l4d_team_unscramble.sp`
   stores SteamID→team in a Trie and enforces via `FakeClientCommand(client,
   "sm_sur"/"sm_inf")` (Rotoblin's own `!survivor`/`!infected`) with a
   retry-with-attempt-cap loop. Forcing Survivor directly needs the bot-takeover
   dance (`L4D_SetHumanSpec` + `L4D_TakeOverBot`); the FakeClientCommand path
   avoids it.
6. **`logaddress` is lossy and non-durable.** Unauthenticated connectionless UDP,
   no delivery guarantee, and the subscription list is **wiped on any srcds
   process restart** (crash + `Restart=always` respawn included). A dropped
   `MAP_RESULT`/`STAT` line silently never arrives. The box has a known
   CPU-steal/crash history (see [[l4d1-128-tick-crashes]]).
7. **RCON is confirmed working** via `deploy/rcon.py` (raw Source RCON over TCP,
   SSH-tunnelled; live host `45.32.199.85:27015`). Full console authority,
   ordered delivery. Keep each command well under ~1 KB; pass the roster as one
   small command per player, not one giant command.
8. **A second srcds instance is real infrastructure**, not a config toggle: its
   own ~8 GB install dir, systemd unit, port pair, `secrets.cfg`, ufw rules, and
   a fix to `steal-monitor.sh` (which `pgrep`s the wrong process when two servers
   run). Disk headroom on the 2-vCPU/4 GB box is unconfirmed, verify first.

## Key design decision: RCON pull is the source of truth, UDP is the live view

Because UDP is lossy and non-durable (finding 6), **ratings and stats never depend
on the UDP stream.** Two channels with distinct jobs:

- **UDP `logaddress` stream → live spectator view only.** The plugin emits
  `LogToGame` lines (match start, per-map result, heartbeat, player connect/leave)
  for a real-time match page. Loss here is cosmetic, the page just misses an
  update until the next one.
- **RCON pull → authoritative record.** At match end (after the last non-finale
  map), the backend calls `sm_pug_dump <token>` and the plugin replies over the
  **RCON response body** (TCP, ordered, reliable) with the complete, final
  per-map scores and per-player stats as structured lines. This is what gets
  persisted and, in sub-project 3, drives SR. The backend can re-call `sm_pug_dump`
  idempotently if a response looks truncated.

The per-match secret **token** still gates both channels: UDP lines without the
token for an active match are dropped (anti-spoof), and `sm_pug_dump` refuses a
wrong token.

## Component breakdown (three separately-shippable pieces)

### 2a: Backend Orchestrator (pure TypeScript, buildable/testable in isolation)

Replaces `DevOrchestrator`. All new code under `src/`, tested with a fake RCON
server + synthetic log samples, no live server contact. Units:

- **`src/rcon.ts`**: a minimal Source RCON client (TCP): auth, exec-command,
  multi-packet response read (mirrors `deploy/rcon.py`'s framing). Interface:
  `connect()`, `exec(cmd): Promise<string>`, `close()`. Injectable socket factory
  for tests.
- **`src/serverPool.ts`**: claims/releases `servers` rows: `claimIdle()` marks a
  row `reserved` and returns it (atomic via a transaction); `release(id)` →
  `idle`; `markLive/markOffline`. Reads RCON creds from the row.
- **`src/logListener.ts`**: a UDP socket bound to a configured port; parses
  incoming datagrams into structured events (strips the `\xFF\xFF\xFF\xFFR`
  header and `L MM/DD/YYYY - HH:MM:SS:` prefix, then the `PUG <token> <VERB>
  key=val…` body). Emits typed events; drops lines whose token doesn't match a
  known live match. Pure parser split into `src/logParse.ts` for unit testing
  against captured samples.
- **`src/matchToken.ts`**: generate/verify per-match tokens (crypto random).
- **`src/orchestrator.ts`** (real impl), implements the existing `Orchestrator`
  interface. `setupMatch(matchId)`: claim a server, `logaddress_add` the backend,
  exec the PUG config + `sv_password`, push `sm_pug_match`/`sm_pug_roster` ×8 +
  token, `changelevel` to map 1, mark match `live`. Provides `finishMatch(matchId)`
  via the RCON `sm_pug_dump` pull, persists final scores/stats, resets the server,
  marks `completed`. Heartbeat-timeout + RCON-reconnect logic (re-issues
  `logaddress_add` after any reconnect, per finding 6).
- **Wiring**: `buildServer` constructs the real orchestrator when not in dev mode
  (dev keeps the stub); config gains RCON/UDP settings and the backend's own
  reachable host:port for `logaddress_add`.

**The log line grammar (contract shared with 2b):**
```
PUG <token> MATCH_START map=<map1>
PUG <token> MAP_RESULT map=<map> a=<score> b=<score>
PUG <token> HEARTBEAT
PUG <token> PLAYER steamid=<id64> event=connect|disconnect
PUG <token> MATCH_END a=<total> b=<total> winner=a|b|draw
```
`sm_pug_dump <token>` RCON response body (authoritative):
```
DUMP match=<id>
MAP map=<map> a=<score> b=<score>          (one per completed map)
STAT steamid=<id64> team=a|b sidmg=<n> sikill=<n> ck=<n> ff=<n> rev=<n>   (×8)
END winner=a|b|draw a=<total> b=<total>
```
Stats stay key=value so new keys land in the `match_players.stats_json` column
with no schema change (per parent spec).

### 2b: `pug-match` SourcePawn plugin (needs a live/staging server to test)

A thin plugin that **layers on Rotoblin**, targeting SourceMod 1.12 with
`#pragma newdecls required` (house style). Responsibilities:

- **Match definition intake** via RCON-issued commands: `sm_pug_match <matchid>
  <token> <campaign>`, `sm_pug_roster <steamid64>:<a|b>` (×8), `sm_pug_abort`,
  `sm_pug_dump <token>`.
- **Roster enforcement**: in `OnClientAuthorized`, `KickClient` any SteamID64 not
  on the roster; lock rostered players to their assigned team using the
  `l4d_team_unscramble.sp` FakeClientCommand pattern.
- **Match flow**: hook Rotoblin's `OnRoundIsLive` to know the match is live; hook
  `L4D_OnSetCampaignScores` / `L4D_OnClearTeamScores` (or read `L4D_GetTeamScore`
  at round end) for per-map scores; use `L4D_IsMissionFinalMap(true)` at
  `OnMapStart` to stop before the finale and declare the match complete.
- **Stat capture**: port/trim `l4dcompstats.sp`'s handlers for the core five
  (SI damage, SI kills, common kills, FF, revives), guarded by `IsInReady()` and
  round-end flags. Keyed by SteamID64.
- **Emission**: `LogToGame` for the live-view lines; build the authoritative
  `sm_pug_dump` response from accumulated per-map/per-player state.
- **Business logic stays in the backend**: the plugin enforces and reports;
  it does not compute SR or decide match validity.

Build/deploy exactly like the user's existing plugins: `spcomp pug-match.sp -o
pug-match.smx`, drop the `.smx` into
`deploy/overrides/left4dead/addons/sourcemod/plugins/`, ship via `deploy.sh`.

### 2c: Infrastructure, the PUG srcds instance (touches the production box)

- A second srcds instance on the Dallas box: its own `SERVER_DIR` (reuse the
  idempotent `install-server.sh`, parameterized), `-port 27016`, its own
  `secrets.cfg`/RCON password, a new `l4d1-pug.service` unit.
- `ufw`: open `27016/udp` publicly, keep `27016/tcp` (RCON) closed to the
  internet (SSH-tunnel only, mirroring `harden.sh`).
- Fix `steal-monitor.sh` to select the srcds process by port/working-dir instead
  of `pgrep -f srcds_linux | head -1`.
- Seed the `servers` table with this instance's row.
- **Verify first**: disk headroom for a second ~8 GB install, and CPU headroom
  for casual + one live 100-tick PUG match on 2 vCPU (parent spec already flags
  this; fallback is the planned second box).

## Build order and where autonomy stops

1. **2a first**, pure backend, TDD, no production contact. Safe to build now.
2. **2b then 2c together, with the user**, both require the live/staging server:
   deploying a plugin and running a second instance where people may be playing,
   plus firewall changes, are hard-to-reverse outward-facing actions. Design is
   done here; execution is a hands-on-the-box session with the user, including an
   RCON dry-run to **capture real `logaddress` samples** (parent-spec research
   item #1) that the 2a `logParse.ts` tests are then pinned against.

## Testing

- **2a**: unit tests for `logParse.ts` (fed synthetic and, once captured, real
  srcds log lines), `rcon.ts` (against a fake RCON TCP server), `serverPool.ts`
  (in-memory DB, concurrent-claim safety), `matchToken.ts`; one integration test
  driving `orchestrator.setupMatch`→`finishMatch` against a fake RCON server + a
  scripted UDP source through a full match to `completed`.
- **2b**: manual checklist on a staging srcds instance (SourcePawn isn't sanely
  unit-testable); the plugin is kept thin to make this tractable.
- **End-to-end**: an RCON dry-run capturing real log samples, then a full match
  with the user's friends on staging before calling it live.

## Open items (resolve during 2b/2c, none block 2a)

1. Capture real `logaddress` line format from the L4D1 binary → pin `logParse.ts`
   tests. (Was parent research item #1.)
2. Confirm RCON response-body size is enough for the `sm_pug_dump` payload
   (~10 lines, comfortably small) and inbound command-length ceiling.
3. Confirm disk + CPU headroom on the box for a second instance.
4. Confirm the plugin can read final per-map scores cleanly at the pre-finale
   boundary given Rotoblin's team-swap bookkeeping, the trickiest plugin risk.
