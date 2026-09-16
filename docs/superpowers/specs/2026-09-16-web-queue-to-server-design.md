# Website queue to live server: design

Date: 2026-09-16
Status: approved in chat, pending spec review

## Goal

Make the full website path work end to end for the first time: sign in, join
the queue, ready up, vote a campaign, get balanced teams, receive a connect
handoff, play, get sent to the main menu with the result when map 4 ends, and
have the match report itself so everyone can requeue.

Every match on the box so far (14 through 26) was started in game with
`!load_4v4p` and *adopted* by the backend. That path never touches
`RealOrchestrator.setupMatch`, so the entire web orchestration leg has only
ever run against the fake RCON server in the test suite. This is the first run
from website to actually playing.

## What already exists

Do not rebuild any of this. The plan should read it first.

- `src/queue.ts`, `src/lobby.ts` (ready check with a fail phase, then map vote),
  `src/matchmaker.ts` (OpenSkill-balanced teams), `src/serverPool.ts`,
  `src/orchestrator.ts::setupMatch` (rcon: `exec pug_match`, `sv_password`,
  `sm_pug_match`, `sm_pug_roster` per player, `changelevel`).
- `web/src/routes/Play.tsx`: sign-in, invite gate, 8-slot queue with join and
  leave, ready check with countdown, campaign vote with tiles, teams panel.
- `plugin/pug-match.sp::Timer_TeamLock`: every two seconds, moves rostered
  players onto their assigned side with a retry cap, and leaves non-rostered
  clients alone.
- Server claiming already refuses a box running a pug of either kind:
  `selfStarted.ts:189` and `markLive` both set `servers.status = 'live'`, and
  `claimIdle` only selects `status = 'idle'`.

## The nine pieces

### 1. Connect handoff

`StateSnapshot.match` gains `connect: { host, port, password } | null`.

The password is **derived, never stored twice**: `pug_` + `matches.token`
sliced to 8 characters, the same expression `setupMatch:107` uses to set it.
A second stored copy is a second thing that can drift from what the server
actually has. Host and port come from the `servers` row (`port`, which is
27015, not `rcon_port`).

Populated only when the viewer is on that match's roster and the match state is
`live`. `/api/state` is already viewer-relative and behind `requireActive`, so
this rides existing gating rather than inventing any. Before `live` the panel
keeps saying "Setting up server", because the box is still mid-`changelevel`.

`Play.tsx` renders a `steam://connect/<host>:<port>/<password>` button plus the
copyable `connect <host>:<port>; password <password>` console line beneath it.
Both, because a broken protocol handler on one person's machine must not be a
locked door: `sv_password` means this is the only way in.

### 2. `sv_password` teardown

**Live bug.** `sv_password` is set at `setupMatch:107` and cleared nowhere. The
first web match that completes leaves the Dallas box locked to `pug_<token8>`
permanently, shutting out every casual player until someone rcons
`sv_password ""` by hand.

Clear it everywhere a server stops being ours, which is piece 3's chokepoint.
Best effort and non-fatal: a match result is never allowed to fail over a
password reset, so it is wrapped and logged the way `sm_pug_abort` already is.
The orphan reaper matters most here, since a crashed match is exactly the case
where nobody is watching.

### 3. One release chokepoint, and waiting for a server

Today `setupMatch:78` aborts the match outright when `claimIdle` returns null.
Per the owner's ruling it should wait instead: if a box is free it is claimable,
if none are free the pug waits until one is.

There are four places a server stops being ours, and they do not agree:

- `orchestrator.ts:90` and `:121`, setup failure paths, call `release()`.
- `orchestrator.ts:212`, `finishMatch`, calls `release()`.
- `liveView.ts:438`, the orphan reaper, writes `servers.status = 'idle'` with
  raw SQL and never dials rcon at all.

**Decision: introduce one `releaseServer(db, serverId)` chokepoint** that clears
`sv_password`, marks the row idle, and wakes any waiting match. All four sites
route through it. Without this, the reaper silently skips both piece 2 and the
wake, and the crash case is the one that needs them most.

Two approaches for the wait itself:

- **(a) Drain on release (recommended).** A match that cannot claim stays in
  `configuring` and is added to a pending list. `releaseServer` drains it. One
  place a server ever becomes free, so the reaction is immediate and there is no
  polling. Risk: a pending entry lost on process restart, which is the same
  class of bug as the in-memory token registry that deafened in-flight matches
  until `server.ts` learned to re-register `state='live'` tokens on boot. Same
  fix applies: rebuild the pending list from `state='configuring'` rows at boot.
- **(b) Retry timer.** `setupMatch` retries `claimIdle` on an interval. Simpler
  and stateless, but reacts late and adds a third timer to a file that already
  has a reaper and a prune.

Recommendation is (a), with the boot rebuild included from the start rather than
learned the hard way a second time.

The state snapshot exposes the waiting condition so the eight players see
"waiting for a free server" instead of a silent hang.

### 4. Who is in the queue

`StateSnapshot.queue` gains `players: NamedPlayer[]` carrying avatars, and
`Slots` renders faces and names in the filled slots. The existing comment on
`Slots` stays true: a half-full queue should still look half full, so only the
filled slots change and the empty ones remain the information.

### 5. Public queue view

`/api/state` cannot simply be unlocked: it is entirely viewer-relative (are
*you* queued, *your* lobby, *your* vote) and would be meaningless to an
anonymous caller. So this is a new public `GET /api/queue` returning the count,
the queued players, and the lobby phase. No viewer-relative fields, and
categorically no connect block: piece 1's password must never be reachable from
an unauthenticated route.

The anonymous Play page shows the live queue above the sign-in panel.

### 6. Persona backfill

`fetchPersona` is called from exactly one place, the login callback at
`routes/auth.ts:27`. Players created from roster snapshots keep their in-game
nickname and a null avatar: 16 of the 18 rows on the box today. Pieces 4 and 5
put names and faces on screen, so this stops being cosmetic.

Backfill players with a null avatar through `GetPlayerSummaries`, which accepts
up to 100 steamids per call, so the whole table is a single request. Must not
clobber a persona that is already real. Best effort: a missing key or a Steam
outage leaves the nicknames exactly as they are today, which is the current
behaviour and is survivable.

`STEAM_API_KEY` **is** set on the box. An earlier note claiming otherwise was
stale; the two players who signed in through Steam OpenID both have real
personas and avatars, which proves the key works.

### 7. Placement instead of kicking

Owner's ruling: the rostered eight belong in the correct team slots, and anyone
else who wants to spectate may spectate.

Two changes, both in `plugin/pug-match.sp`:

- **Drop the kick for backend matches.** `OnClientPostAdminCheck:2090` currently
  kicks any non-rostered client in a backend-driven match with "You are not on
  this match's roster". The self-started path deliberately skips this. Make the
  backend path behave the same way: non-rostered clients stay, unscored, as
  spectators. This also removes the first-run failure mode where a roster
  mismatch bounces all eight players at the door with no in-game recourse.
- **Let a backend roster lock teams even under auto-track.**
  `Timer_TeamLock` returns early on
  `if (!g_cvTeamLock.BoolValue || g_cvAutoTrack.BoolValue)`, and
  `sm_pug_auto_track` is persisted to 1 on the live box in
  `Reloadables/server_custom_convars.cfg`. As the box sits today a
  backend-driven match would place nobody. Auto-track exists to catch in-game
  mixes that have no authoritative roster; a backend match has one, so the
  auto-track half of that gate must not apply to it. The `sm_pug_team_lock`
  half stays, since that is the deliberate testing switch.

### 8. Match end sends everyone to the main menu with the result

The "game over, team X wins" moment happens **in game, not on the website**.
When the match ends, the final score prints in chat, and a few seconds later
every client is kicked with the result as the kick reason, which Source shows
in the dialog on the main menu:

    Blood Harvest: Team A wins 1247 to 980

Everyone, spectators included, so the box is left completely empty and ready for
the next queue pop. The short delay exists so the score can be read in game
first rather than only in the menu dialog.

This is safe for reporting, which was checked before choosing it: `WriteDump`
reads only the roster-slot arrays (`g_sRosterId`, `g_iStat*`, `g_iMapScore*`)
and nothing about connected clients, so the backend can still pull a complete
dump from an empty server. The kick must not wait on the backend either; the
data lives in the plugin until `sm_pug_abort`.

Hooks into `EndMatchNow`, which already fires on `L4D_IsMissionFinalMap`
(`pug-match.sp:2291`) and on `!endpug`.

**No website result panel.** `stateFor` returns a null match the moment the
match completes, so the Play page falls back to the queue, which is the right
thing for someone about to requeue. Completed matches already live on
`/matches` with per-map scores and SR deltas.

### 9. No-show timeout

`Timer_Heartbeat` emits whenever `g_State != MS_None`, so it beats whether or
not a single human is connected, and the orphan reaper only catches heartbeat
*loss*. A match where the eight never connect therefore heartbeats forever,
stays `live` forever, and pins `servers.status = 'live'` forever.

Today that costs a manual cleanup. **Piece 3 turns it into a deadlock**: once
"no free box" means "wait" instead of "abort", every future queue pop waits on a
server that will never free. So piece 3 cannot ship without this.

The plugin already emits `PLAYER steamid=... event=connect`, which is the signal
the backend needs. Proposed rule, with both thresholds as `settings` rows so
they are tunable without a deploy:

- If ten minutes after going live fewer than six of the eight rostered players
  have ever connected, abort the match and release the server.
- As a backstop, if thirty minutes pass with no round ever recorded, abort and
  release regardless of who connected. This catches the case where everyone
  arrives and then nobody readies up.

Both paths go through piece 3's `releaseServer`, so the password is cleared and
any waiting match is woken.

## Testing

- Unit and integration in the existing suite (1094 tests currently green):
  connect block present for a rostered viewer and absent for everyone else,
  `/api/queue` carries no connect field, a match that cannot claim waits rather
  than aborts and then starts when `releaseServer` runs, password cleared on all
  four release paths including the reaper, backfill does not clobber a real
  persona and survives a missing key, a match with too few connects is aborted
  and its server released at the threshold while a fully attended one is not.
- Plugin changes need staging on an empty box, per the usual rule.
- The steam:// handoff itself cannot be unit tested. It is verified in the
  first-run runbook.

## First-run runbook

Written as its own document during implementation, covering at minimum: confirm
the box is empty, confirm the roster SteamID64s match `sm_pug_status` output
before anyone connects, confirm team placement happens, and confirm
`sv_password` is clear afterwards.

Ship order follows the rule learned on 2026-09-15: `./deploy-web.sh` first, then
`plugin/stage.sh` with the server empty, then re-assert the cvars, since a
plugin reload resets every cvar until the next map change.

## Known gap: mid-match abandonment, its own spec next

If someone quits on map 2, nothing here detects it: the match plays out
short-handed and rates normally. Piece 9 covers only the case where a match
never gets going at all, because that one pins the server.

Deliberately sequenced after this spec rather than bundled into it. The first
website-to-playing run does not depend on abandonment handling, and eight people
actually playing one will teach us more about what to build than guessing now.

Rules already decided by the owner, recorded here so the next spec starts from
them rather than re-asking:

- A rostered player disconnecting mid-match **pauses the game**.
- If they are not back within **five minutes**, they are **banned for one day**
  and the match **ends**.
- The ending is a **forfeit**: the abandoner's team takes the loss and SR moves
  accordingly. The seven who stayed get something for their time, and quitting
  is never a way to dodge a loss.

Groundwork that already exists: rotoblin provides `sm_pause`, plus `forcepause`
and `forceunpause` for admins, and its unpause requires both teams to `!ready`.
So the plugin can force-pause on the drop and let the normal consent flow resume
it once the player is back and loaded, rather than fighting rotoblin's state
machine. On the backend side `players.status` accepts `'banned'` but carries no
expiry, reason or history, so a one-day ban needs real storage: a `bans` table
rather than a status flag, since the admin panel (roadmap item 3) will want to
list and lift them.

## Out of scope

- A second srcds instance. One server is fine for testing.
- An occupancy guard that refuses to claim a box with casual players on it.
  Testing will be done on an empty box for now.
- Queue activity notifications (browser, title flash, Discord ping). That
  belongs with the Discord bot, which is the next roadmap item.
- Captains draft, suspensions, admin tooling. Those remain 4d, 4e, 4f.
