# Cancelled matches end properly, and bans reach every game server

Status: **implemented on master (unreleased); see the ship checklist in
`docs/superpowers/notes/2026-09-19-teardown-and-bans-ship-checklist.md`.** Written after the
first real PUG night (2026-09-18/19) surfaced both problems in one incident. Revised the
same day after a local spike; see "What the spike established".

Related: `2026-09-18-file-consistency-design.md` (content-swap enforcement, a separate
sub-project), `2026-09-17-integrity-design.md` (the replay analyzer).

## Why

Two failures from the first night, one incident:

1. A rostered player left and did not reconnect in time. The backend did the right thing:
   marked the match aborted, banned the leaver, released the server. In game, nothing useful
   happened. Chat said the match was cancelled and everyone stayed where they were, and the
   leaver could simply rejoin. The box had to be reset by hand before it was usable again.
2. That ban existed only on the website. Nothing stopped the banned player walking back onto
   the game server, because no game server has ever been told about a ban.

The owner's framing: "it should end the game there", and "any ban from queue should also be
a ban in the servers, right? Same with it lifting."

## What is actually known about the stuck server

Be precise here, because the first draft of this spec was not.

**Certain, from the code.** On a cancel the backend sends `sm_pug_abort <token>` and restores
the standing `sv_password`. Nothing kicks anyone, nothing changes the map, and the standing
password is the one every regular already has, so the leaver walks back in. Whatever else
happened, that alone is enough to need a manual reset before the box could host a match.

**Likely, from the code, not confirmed.** `pug-leave.inc` pauses the game when a rostered
player drops. The abort path does try to unpause: `ResetMatchState` calls `LeaveReset`, which
calls `LeaveUnpauseNow` (`plugin/pug-leave.inc:54`). But that unpause is best effort through
Rotoblin's cooperative flow, and it has several ways to fail silently, each leaving the engine
paused with nothing left that knows it:

| failure | why |
|---|---|
| an admin had used `!forcepause` | Rotoblin sets `g_bWasForced`; `sm_ready` from a non-admin is refused (`rotoblin.pause.sp:515`) |
| one side has no connected client | `LeaveUnpauseNow` sends `sm_ready` from one survivor and one infected; with a side empty only one team readies and `CheckFullReady()` never passes |
| clients gone before the countdown lands | Rotoblin unpauses on a 3 second countdown, and its `Unpause()` needs an in-game client to issue the engine command (`rotoblin.pause.sp:754`); with nobody left it clears its own flags and the engine stays paused, so `IsInPause()` then reads false and no command can recover it |
| `IsInPause` native missing | `LeaveUnpauseNow` returns before sending anything; it is exported by `rotoblin-az.sp:119`, so this one is a build-drift risk, not a live one |

**Unknown.** Which of these, if any, was the state on the night. No transcript from the last
five days contains an RCON reset, so the recollection that it was done over RCON is
unverified. The Dallas console log would settle it, and reading it is a read-only action the
owner can authorise if certainty is wanted. The design below does not depend on the answer:
it has to leave the box usable from every one of those states.

## Scope

**In:**
- A single teardown every cancel path uses: cooperative unpause with a bounded wait, kick,
  change to a reset map.
- Propagation of the `bans` table to every enabled game server as permanent engine bans, with
  the website owning expiry and lifting.
- One new admin setting for the reset map.

**Out:**
- The short ready-check and no-show penalty timeouts (the `penalties` table). Queue-only.
  A five minute lockout from casual play for a queue offense is noise, and the owner chose
  bans only.
- Voice-chat enforcement and file consistency. Separate sub-projects, separate specs.
- Any change to how bans are decided, escalated or surfaced. Only where they are enforced.

## Half 1: teardown

### Call sites

Three paths abort a match today and none of them touch the game:

| path | file |
|---|---|
| abandon (leave allowance exhausted) | `src/abandon.ts:60` |
| no-show / no-round reaper | `src/noShow.ts:75` |
| admin abort | `src/orchestrator.ts:265` |

All three already funnel into `ServerReleaser.release()`, which opens exactly one RCON
connection in `cleanServer` (`src/server.ts:275`). The teardown rides that connection.

### The backend side

`release()` is also the path a completed match and a boot-time reconcile take, so the
releaser is told which kind of ending this is:

    release(serverId, opts?: { teardown?: boolean })
    type ServerCleaner = (server, token, opts: { teardown: boolean }) => Promise<void>

Defaulting to `false` keeps every existing caller correct as written. The three cancel paths
pass `true`. `reconcileServers` and the setup-failure release in `setupMatch` pass `false`:
a box stranded at boot, or one where setup failed before the changelevel, may have casual
players on it who have nothing to do with a match, and kicking them is not a fix for
anything. A completed match passes `false` too, but not because anyone should stay: the
plugin already kicks everyone at the end of a backend match (`ArmEndKick`,
`plugin/pug-match.sp:1809`), so there is nobody left to tear down. (Changing the completed
path to also land on the reset map would be a one-line follow-up, not part of this.)

Order on the one connection, with teardown:

1. `sm_pug_abort <token> teardown <reset_map>`
2. `exec secrets.cfg` (restore the standing password; must stay last, `src/server.ts:313`)

Everything interesting is inside step 1, deliberately. `exec secrets.cfg` re-sets
`rcon_password` and drops the session, so nothing may follow it, and one command before it
is one thing that can time out rather than five. The reset map is passed in because the
plugin cannot read an admin setting and should not guess what an idle box sits on.

### The plugin side

`Cmd_Abort` (`plugin/pug-match.sp:2029`) grows two optional arguments. With none, behaviour is
byte-for-byte what it is today, so the routine post-report abort, the manual recovery path
and every existing test are untouched. With `teardown <map>`, before `ResetMatchState()`:

1. **Announce** in chat, naming the match and why it ended.
2. **Cooperative unpause**, then wait for it to land. Send `sm_ready` from one connected
   survivor and one connected infected (the existing `LeaveUnpauseNow` does exactly this),
   then poll `IsInPause()` on a 0.5 second repeating timer for up to 10 seconds. Timers are
   driven by engine time and fire while paused (proven in the spike). If it never lands, log
   a `PUG PROBLEM` line the backend surfaces in the admin feed, and carry on: an unpaused
   box is preferred, an empty box on a fresh map is required.
3. **Kick every human**, roster and spectators alike, never bots and never the SourceTV
   relay. `IsEndKickTarget` (`plugin/pug-match.sp:1843`) already encodes that rule and the
   reason it matters (the relay writes every later match's demo). Reason string as below.
   Disconnects during a pause are routine, which is the whole leave-tracking scenario, so
   the kick does not depend on step 2 having worked.
4. `ResetMatchState()` as today.
5. **`ForceChangeLevel(map, reason)`** from a short timer once the kicks have had a frame to
   land, for the reason `Timer_EndKick` documents: a kick does not necessarily drop the
   client in the frame it is issued. Rotoblin clears all three of its pause flags on map end
   and round start (`rotoblin.pause.sp:105,218`), so the new map starts clean whatever state
   the old one was in.

Never `FakeClientCommand` a **fake** client to pause or unpause. The spike did, and it
segfaulted srcds. Rotoblin only ever does it through real clients.

### The reset map

There is no idle-map convention on the box; it sits on whatever was played last. So this is
a choice. New setting `reset_map`, group `Match`, type string, default
`l4d_hospital01_apartment`. Validated through `validateSetting` like every other setting.

### Kick reason text

Short enough for the client's disconnect dialog, and different per cause, because telling a
no-show crowd they abandoned the match would be wrong:

- abandon: `Match #N cancelled: a player did not reconnect in time.`
- no-show / no-round / admin abort: `Match #N cancelled.`

## Half 2: bans reach every game server

### What propagates

The `bans` table only. It has exactly three writers, all in `src/admin/players.ts`:
`banPlayer`, `unbanPlayer`, `liftExpiredBans`. Every entry point funnels through them: the
admin panel ban endpoint (`src/routes/admin.ts:80`), report resolution, which uses that same
endpoint and has no ban path of its own, and the automatic abandon ban (`src/abandon.ts:68`).

That is what makes the owner's requirement, a ban from anywhere is a ban everywhere, hold by
construction. The sweep below derives what each box should have from the table itself; it is
never told, so there is no call anyone can forget to add.

### Mechanism: permanent engine bans, expiry owned by the website

SourceMod's `basebans.smx` over RCON. No new plugin code for this half.

- ban: `sm_addban 0 "<authid>" "<reason>"`, always `0`, meaning permanent on the box
- lift: `sm_unban "<authid>"`

Why permanent, when most of our bans are timed: `BanIdentity` in SourceMod core issues
`writeid` **only when the duration is 0** (`core/logic/smn_banning.cpp:168`). A timed
engine ban lives in memory alone and is lost on server restart; a permanent one is written to
`banned_user.cfg`, which both boxes `exec` from `autoexec.cfg` at startup. So a permanent ban
survives a restart and a timed one does not. The website already knows when every ban ends
(`liftExpiredBans` runs on the 60 second reaper), so it lifts on the box at the same moment
it lifts on the site, and there is one clock rather than two.

`sm_unban` reaches `RemoveBan`, which issues `removeid` **and** `writeid`
(`smn_banning.cpp:229`), so a lift persists across a restart too. Without that a lifted ban
would resurrect on the next restart; checked, it does not.

`sm_addban` reaches the engine's `banid`, which drops a matching connected client, so a
player standing on the box when the ban lands is removed by the same command.

### SteamID format

We store SteamID64 (`players.steamid`, e.g. `76561198030413993`). `sm_addban` rejects that.
SourceMod's own validation accepts `STEAM_X:Y:Z` or `[U:1:N]`, but SourceMod passes the
string straight through to the engine's `banid`, and **this engine only parses
`STEAM_%u:%u:%u`** (`strings bin/engine.so`; it has no SteamID3 parser). So the conversion
target is the classic form, with the universe digit the engine itself logs:

    acc = id64 - 76561197960265728
    STEAM_1:(acc % 2):(acc / 2)

Verified against a known account: `76561198030413993` gives `STEAM_1:1:35074132`, which is
exactly how the live logs print that player. A small pure function with unit tests in
`src/steamId.ts`, the one place a conversion bug could hide.

### The sync

`src/serverBans.ts`:

- **Immediate push.** `banPlayer` and `unbanPlayer` trigger a push to every enabled server.
  Best effort, never allowed to fail the database write, logged on failure. Exists to cut
  latency from one sweep interval to instant; correctness does not rest on it.
- **Ban sweep.** On a timer, `sm_addban 0` every currently open ban to every enabled
  server. Unconditional: no memory of what a box was told. `sm_addban` on an already banned
  id is harmless, so this is idempotent. It heals a box that was offline when a ban landed,
  or was rebuilt and lost `banned_user.cfg`.
- **Unban sweep.** In the same pass, `sm_unban` every ban lifted in the last 30 days. Wider
  than the ban side needs to be, on purpose: a permanent ban on disk survives however long a
  box is down, so the window must cover the longest plausible outage. A box down longer than
  a month is being rebuilt anyway.
- **Setup push.** `setupMatch` (`src/orchestrator.ts:120`) already holds an RCON connection
  before a match goes live; push the open set there too, so a box about to host a ranked
  match has a current list wherever the sweep is in its cycle.

Sweep interval: five minutes, a module constant, documented. Not the 60 second reaper: this
is a repair mechanism and the immediate push already covers latency.

### Failure behaviour

The website is the source of truth; the boxes are replicas that converge. A server that
cannot be reached is logged and skipped, never retried in a tight loop, never allowed to
block a ban being recorded. Because bans on the box are permanent, the failure mode of a
missed lift is over-enforcement: a player whose ban has ended stays locked out of that box
until the next sweep, at most five minutes. Visible and self-correcting, which is the right
way round for a lockout.

One admin-feed event on repeated failure, rate-limited to once per server per hour, so a
permanently unreachable box does not stay silently out of date and does not spam either.
`VoiceChannels` sets the precedent with its `failed` and `reported` sets.

## What the spike established (local test server, 2026-09-19)

Run headless with a throwaway probe plugin against `/home/volence/l4d1-ds`, then removed.

| question | answer | how |
|---|---|---|
| do SourceMod timers fire while the game is paused | **yes** | a 2 s timer fired with game time frozen and engine time advancing; SM timers run on engine time |
| does game time advance with zero clients | no | L4D1 does not simulate an empty server; a fake client makes it simulate, so game time is a valid pause indicator only with a client present |
| does console `setpause` pause a dedicated L4D1 server | **no** | with both pause-command listeners unloaded and `sv_pausable 1`, game time kept advancing |
| can a fake client issue `pause` | **no, it crashes srcds** | connection reset, fresh process 25 s later |
| does `changelevel` execute while paused | **not established** | it executed every time, but a real pause could not be induced headlessly, so the runs are not evidence |

That last row is why step 2 of the teardown exists. If changelevel while paused works, the
bounded wait is a few seconds of delay in the failure cases only. If it does not, the wait is
what makes the common case work. Either way it must be checked in staging with a real client
before this ships.

## Testing

Both halves are testable without a game server, but not via `tests/fakes`, which has no RCON
fake. The existing seam is dependency injection: `deps.serverCleaner` (`src/server.ts:275`)
replaces the whole RCON body, and `tests/abandon.test.ts:35` stubs the releaser outright.

- `steamId.ts`: unit tests, including the verified known pair.
- Teardown: assert the exact command sequence and order through an injected `ServerCleaner`
  for each of the three cancel paths, and that completed, reconcile and setup-failure
  releases send no teardown.
- Ban sync: the immediate push; the sweep catching a server that missed a ban; the 30 day
  unban window; a failing server neither throwing nor blocking the database write; the
  once-per-hour feed rate limit.
- Plugin: the `teardown` argument path on the local server with a real client, including a
  paused game. This is the one thing the suite cannot cover.

**Half 2 cannot be tested on the local server.** `sm_addban` and `sm_unban` do nothing on a
LAN server: `BanIdentity` returns 0 without issuing any command when
`gamehelpers->IsLANServer()` (`smn_banning.cpp:174`). `/home/volence/l4d1-ds` runs
`sv_lan 1`, so it will look like a working no-op with nothing logged. It needs an
authenticating server.

## Before this ships

1. Verify `basebans.smx` is loaded on the Dallas box (found staged for NFO only). One
   read-only `sm plugins list`. If it is not, half 2 has to move into the pug plugin.
2. Verify `sv_banid_enabled` is on. The cvar exists in this engine and would silently
   disable `banid`.
3. Verify changelevel-while-paused, and the whole teardown, on the local server with a real
   client. See the spike table.
4. Deploy order, per the audit-hardening precedent: web first, then the plugin on an empty
   server.
5. The live box has players on it most evenings. Nothing goes out without an explicit
   go-ahead and an empty server.

## Deliberately left open

Whether a server ban should also block SourceTV spectators. `banid` covers players, which is
the problem anyone reported.
