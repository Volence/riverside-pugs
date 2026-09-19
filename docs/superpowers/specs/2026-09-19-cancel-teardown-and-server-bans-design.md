# Cancelled matches end properly, and bans reach every game server

Status: **design approved 2026-09-19, not implemented.** Written after the first real PUG
night (2026-09-18/19) surfaced both problems in one incident.

Related: `2026-09-18-file-consistency-design.md` (content-swap enforcement, a separate
sub-project), `2026-09-17-integrity-design.md` (the replay analyzer).

## Why

Two failures from the first night, one incident:

1. A rostered player left and did not reconnect in time. The backend did the right thing:
   marked the match aborted, banned the leaver, released the server. In game, nothing
   happened. The chat said the match was cancelled and then everyone carried on standing
   there, frozen. The leaver could simply rejoin. The box had to be reset by hand over RCON
   before it was usable again.
2. That ban existed only on the website. Nothing stopped the banned player walking back onto
   the game server, because no game server has ever been told about a ban.

The owner's framing: "it should end the game there", and "any ban from queue should also be
a ban in the servers, right? Same with it lifting."

## Root cause of the stuck server

`pug-leave.inc` auto-pauses the game when a rostered player disconnects. When the leave
allowance runs out, the backend sends `sm_pug_abort <token>`, which calls `ResetMatchState()`,
which calls `PauseReset()`.

`PauseReset()` (`plugin/pug-pause.inc:71`) only zeroes the plugin's own bookkeeping:
`g_iPauseUsed`, `g_iPauseOwner`, `g_bPauseSeen` and friends. **It never issues an unpause.**

So the teardown throws away the only state that knew the game was paused, while the game
stays paused. Nothing left on the box can unpause it, because as far as the plugin is
concerned there is no match and no pause. The roster sits frozen on the match map until a
human intervenes. That is precisely the manual reset that was needed.

This is not a cosmetic bug. A server left in that state and then handed to the next match
would have been broken for that match too.

## Scope

**In:**
- A single teardown sequence every cancel path uses, which unpauses, announces, kicks and
  resets the map.
- Propagation of the `bans` table to every enabled game server, including lifting.
- One new admin setting for the reset map.

**Out:**
- The short ready-check and no-show penalty timeouts (the `penalties` table). Those stay
  queue-only. A five minute lockout from casual play for a queue offense is noise, and the
  owner chose bans only.
- Voice-chat enforcement and file consistency. Separate sub-projects, separate specs.
- Any change to how bans are decided, escalated or surfaced. This spec only changes where an
  existing ban is enforced.

## Half 1: teardown

### The sequence

A new module, `src/matchTeardown.ts`, holds the sequence. Three call sites abort a match
today and none of them touch the game:

| path | file |
|---|---|
| abandon (leave allowance exhausted) | `src/abandon.ts:60` |
| no-show / no-round reaper | `src/noShow.ts:75` |
| admin abort | `src/orchestrator.ts:265` |

All three already funnel into `ServerReleaser.release()`, which opens exactly one RCON
connection in `cleanServer` (`src/server.ts:275`). The teardown goes there, so it costs no
extra connection.

**But `release()` is also the path a normally completed match takes, and that match must not
be torn down.** After a clean finish people stay on the box to talk and the server goes back
to casual play; kicking all eight and changelevelling would be a regression, not a fix. So
the releaser has to be told which kind of ending this is:

    release(serverId, opts?: { teardown?: boolean })
    type ServerCleaner = (server, token, opts: { teardown: boolean }) => Promise<void>

Defaulting to `false` keeps every existing caller correct as written, including both reapers
and `reconcileServers`, and makes the three cancel paths name the new behaviour explicitly.
The no-show reaper and the admin abort pass `true`; `handleAbandon` passes `true`;
`reconcileServers` passes `false`, because a stranded box at boot has no match and nobody on
it worth kicking.

Order on that one connection:

1. `sm_pug_abort <token> teardown`
2. `exec secrets.cfg` (restore the standing password)

Everything interesting is inside step 1, and it must be, for two reasons. The plugin is the
only thing that can unpause, because Rotoblin's pause is not SourceMod's and `sm_unpause`
does not touch it. And `src/server.ts:313` records that `exec secrets.cfg` re-sets
`rcon_password`, which drops the RCON session, so nothing may follow it on that connection.
Keeping the teardown to one command before it means one thing that can time out instead of
five.

### The plugin side

`Cmd_Abort` (`plugin/pug-match.sp:2029`) grows an optional second argument. Without it,
behaviour is byte-for-byte what it is today, so every existing caller and the manual
recovery path are unaffected. With `teardown`, before `ResetMatchState()`:

1. **Unpause**, unconditionally and defensively. Do not branch on `g_bPauseSeen`: the whole
   bug is that the plugin's idea of whether it is paused can be wrong. Issue the unpause and
   let an already-unpaused server ignore it.
2. **Announce** in chat, naming the match and the reason, so the kick that follows is not
   unexplained.
3. **Kick every connected client**, roster and spectators alike, with a reason string that
   surfaces in the client's disconnect dialog.
4. `ResetMatchState()` as today.

Then the backend issues the `changelevel` to the reset map. That is deliberately on the
backend side rather than in the plugin: the plugin has just reset its state and has no
business knowing what an idle box should be sitting on, and the map is an admin setting the
plugin cannot read.

Note the ordering constraint: the changelevel must come after the kick, not before. A
changelevel with clients still connected drags them through the transition, which is the
slow path and re-fires `PLAYER connect` lines for a match that no longer exists.

### The reset map

There is no idle-map convention on the box today; it sits on whatever was played last. So
this is a choice, not a lookup.

New setting `reset_map`, group `Match`, type string, default `l4d_hospital01_apartment`
(No Mercy 1, the stock default). Validated through `validateSetting` like every other
setting, for the reason `noShow.ts` documents at length about hand-edited values.

### Announcement text

The kick reason has to be short enough to survive the client's disconnect dialog. Two
variants, because the two causes are not the same event and telling a no-show crowd they
abandoned the match would be wrong:

- abandon: `Match #N cancelled: a player did not reconnect in time.`
- no-show / no-round / admin abort: `Match #N cancelled.`

## Half 2: bans reach every game server

### What propagates

The `bans` table only. It has exactly three writers, all in `src/admin/players.ts`:
`banPlayer`, `unbanPlayer`, `liftExpiredBans`. Every entry point funnels through them: the
admin panel ban endpoint (`src/routes/admin.ts:80`), the report resolution flow, which uses
that same endpoint and has no ban path of its own, and the automatic abandon ban
(`src/abandon.ts:68`).

That matters for the owner's requirement that a ban from anywhere is a ban everywhere. It
holds by construction rather than by remembering to add a call, because the sweep below
derives what each box should have from the table itself and is never told.

### Mechanism

SourceMod's own ban system over RCON. `basebans.smx` is present, so there is no new plugin
code for this half.

- ban: `sm_addban <minutes> "<authid>" "<reason>"`, where `0` minutes means permanent
- lift: `sm_unban "<authid>"`

`sm_addban` reaches the engine's `banid`, which kicks a matching connected client, so a
player who is standing on the box when the ban lands is removed by the same command. No
separate kick is needed.

### SteamID conversion

We store SteamID64 (`players.steamid`, e.g. `76561198030413993`). `sm_addban` rejects that:
it validates for `STEAM_` with a colon at index 7, or a leading `[U:`
(`plugins/basebans.sp:296`).

Convert to the modern form, which is unambiguous and needs no universe or instance guessing:

    [U:1:<id64 - 76561197960265728>]

Verified against a known pair: `76561198030413993` gives `[U:1:70148265]`, and the live logs
show that same account as `STEAM_1:1:35074132`, where `35074132 * 2 + 1 == 70148265`.

A small pure function with unit tests, in `src/steamId.ts`. Pure, total, trivially testable,
and the one place a conversion bug could hide.

### Why a periodic sweep is load-bearing, not belt-and-braces

This is the finding that decides the architecture, and it is not obvious.

`BanIdentity` in SourceMod core issues `writeid` **only when `ban_time == 0`**
(`core/logic/smn_banning.cpp:168`). Permanent bans are written to `banned_user.cfg`. Timed
bans are not written anywhere. The engine holds them in memory alone.

Our abandon bans are 1, 3 and 7 days. **Every one of them is lost when the game server
restarts.**

So a design that pushes on ban and trusts the box to remember is wrong for the most common
kind of ban we issue. A restarted box is indistinguishable from one that never heard, which
means the repair has to be unconditional. That also removes the reason for the delta-tracking
table this design originally carried: there is no believed state worth recording, because it
can be invalidated at any moment by a restart we never observe.

### The sync

`src/serverBans.ts`:

- **Immediate push.** `banPlayer` and `unbanPlayer` trigger a push to every enabled server.
  Best effort, never allowed to fail the ban itself, logged on failure. This exists purely
  to cut latency from up to one sweep interval down to instant. Correctness does not rest
  on it.
- **Sweep.** On a timer, push the full set of currently open bans to every enabled server.
  Unconditional: no delta, no memory of what a box was told. `sm_addban` on an already
  banned id is harmless, so the sweep is idempotent. This is what heals a box that was
  offline, restarted, or rebuilt.
- **Unban sweep.** Also push `sm_unban` for bans lifted in the last 24 hours. Narrower than
  the ban sweep on purpose: a box that restarted has already lost the ban, so the only case
  needing repair is a box that stayed up and missed the immediate push. Twenty-four hours
  bounds that generously.
- **Setup push.** `setupMatch` (`src/orchestrator.ts:120`) already holds an RCON connection
  before a match goes live. Push the ban set there too, so a box about to host a ranked match
  has a current list regardless of where the sweep happens to be in its cycle.

Sweep interval: a new setting is not worth it. Five minutes, a module constant, documented.
The 60 second reaper tick is too frequent for what is a repair mechanism, and the immediate
push already covers the latency case.

### Failure behaviour

A server that cannot be reached is logged and skipped, never retried in a tight loop, and
never allowed to block a ban being recorded in the database. The website is the source of
truth; the game servers are replicas that converge. If RCON to a box is down for an hour,
that box is out of date for an hour and then repairs itself.

One admin-feed event on repeated failure, so a permanently unreachable box does not stay
silently out of date. Rate-limited to once per server per hour, following the precedent in
`VoiceChannels` where `this.failed` and `this.reported` exist specifically to stop a
recurring failure spamming the feed.

## Testing

Both halves are testable without a game server, but not via `tests/fakes`, which has no RCON
fake. The existing seam is dependency injection: `deps.serverCleaner` (`src/server.ts:275`)
replaces the whole RCON body, and `tests/abandon.test.ts:35` stubs the releaser outright.
Teardown tests capture the command sequence through an injected `ServerCleaner`; ban-sync
tests take an injected exec function of the same shape.

- `steamId.ts` conversion: unit tests, including the verified known pair.
- Teardown: assert the exact command sequence and its order against a fake RCON, for each of
  the three cancel paths. The order matters and is easy to regress.
- Ban sync: assert the immediate push, the sweep pushing to a server that missed a ban, the
  unban sweep window, and that a failing server neither throws nor blocks the database write.

**A constraint that must be recorded before anyone tries to test this in game:**
`sm_addban` silently does nothing on a LAN server. `BanIdentity` returns 0 without issuing
any command when `gamehelpers->IsLANServer()` (`core/logic/smn_banning.cpp:174`). The local
test server at `/home/volence/l4d1-ds` runs `sv_lan 1`, so **half 2 cannot be verified
there**. It will look like a complete no-op with nothing logged. Half 1 can be tested
locally; half 2 needs an authenticating server.

## Before this ships

1. Verify `basebans.smx` is actually loaded on the Dallas box. It was found staged for the
   NFO box only. One read-only `sm plugins list` over RCON answers it. If it is not loaded
   there, half 2 needs the pug plugin to own the ban list instead, and the estimate changes.
2. Deploy order, per the precedent in the PUG audit hardening work: web first, then the
   plugin on an empty server.
3. The live box has players on it most evenings. Nothing here goes out without an explicit
   go-ahead and an empty server.

## Open question deliberately left open

Whether a server ban should also block SourceTV spectators. Leaving it as is for now: a
banned player watching is not the problem anyone reported, and `banid` covers players.
