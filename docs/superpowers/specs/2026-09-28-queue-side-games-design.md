# Queue side games (2v2 / 3v3 while the queue fills)

Date: 2026-09-28. Status: design, awaiting owner review.

## Why

Players have asked (twice so far) for real 2v2s and 3v3s to play while the
PUG queue fills. They want the competitive small-team Rotoblin rules, not a
casual warmup. Side games are practice and fun: nothing about them is
recorded or shown anywhere.

## What the owner decided

- Opt-in. Only queued players who ask for side games count.
- Rulesets: `rotoblin_hardcore_2v2` and `rotoblin_hardcore_3v3`, as they are.
- Teams are balanced by the site from SR and locked in game.
- Size changes (2v2 to 3v3 and back) happen only between maps.
- Odd numbers rotate: the extra player sits out a map, and the longest
  sitter comes in for the longest player at each map change.
- At 8 the side game ends immediately, mid-round, and the server is set up
  for the real match as normal.
- The ready check and the campaign vote can both be answered in game.
- Nothing is recorded: no match row, no SR, no replay, no dump, no stats,
  no Discord post, no site history.

## Player experience

1. Queue panel (site) and the Discord queue card get a toggle:
   "Play 2v2/3v3 while I wait". It is per queue entry and clears when the
   player leaves the queue.
2. When 4 opted-in players are queued and a server is free, the site opens a
   side game. The queue panel shows "Side game open: 2v2, 4 playing" with the
   usual connect button and console line (side-game password). Discord shows
   the same line on the queue card. Players who did not opt in see
   "Side game running (4 players)" and no connect details.
3. In game, the site places everyone on their team. Rotoblin ready-up runs
   as usual, so the map goes live when both teams ready.
4. More people opt in mid-map: they connect and spectate. At the next map
   change the site rebalances, picks the new size and loads that config.
5. At 8 in the queue: the side game stops at once. Everyone in it gets a
   center-screen and chat notice: "QUEUE POPPED: type !ready (120 s)". The
   campaign vote then appears as an in-game menu. Both are also on the site
   and Discord exactly as today.
6. If the ready check fails, the queue drops below 8 again. The side game
   resumes (new map, rebalanced) if 4 or more opted-in players remain.
7. When the match is set up, it goes onto the side-game server. The 8 are
   already connected and stay connected through the changelevel.

## Sizes and rotation

| Opted-in players | Game | Sitting out |
|---|---|---|
| 0-3 | none (a running game closes, see below) | - |
| 4 | 2v2 | 0 |
| 5 | 2v2 | 1 |
| 6 | 3v3 | 0 |
| 7 | 3v3 | 1 |
| 8 | the queue has popped | - |

"Opted-in players" means queued players with the toggle on, whether or not
they have connected yet. Connection matters only when choosing who sits out:
a player who is not connected sits out first.

Rotation at a map change: the player who has sat out longest comes in, and
the player who has played the most consecutive maps sits out. Ties are
broken by queue position (earlier queued plays).

A game that drops below 4 (someone left the queue) finishes the current map
if it is live, then closes. The server goes back to idle. It stays reserved
for 3 minutes after dropping below 4, in case someone rejoins, before it is
released.

## Server lifecycle

New `servers.status` value: `sidegame`.

- **Open:** needs `settings.sidegames_enabled = 1`, 4 opted-in players, an
  idle enabled server (`claimIdle`), and no configuring match waiting for a
  server. Then status goes to `sidegame`.
- **Pre-emption:** a configuring match that finds no idle server may take a
  `sidegame` server. The side game ends, and its players stay in the queue.
  Only the pop of the side game's own queue normally ends it, because every
  side-game player is in that queue.
- **Pop to match:** `setupMatch` prefers the `sidegame` server when one
  exists. It sends `sm_side_stop`, then runs the normal sequence (`exec
  pug_match`, new `sv_password`, `sm_pug_match`, roster, changelevel).
  Connected clients survive the password change and the changelevel.
  Anyone connected who is not in the roster is kicked with "Queue match
  starting" (not spectated, unlike a normal match).
- **Restart-after-match** does not apply: no match ended.
- **Close:** `sm_side_stop`, `exec secrets.cfg` (the standing password, as
  `ServerReleaser` does today), set `sm_pug_auto_track` back to 1, change
  level to the idle map, status back to `idle`.
- **Boot:** `reconcileServers` treats `sidegame` like `reserved`: the
  in-memory side game is gone after a web restart, so the box is closed and
  released. The queue itself survives restarts (`matchmaker_state`), so the
  side game simply reopens if the conditions still hold. The opt-in flag is
  added to `matchmaker_state` so it survives too.

## Components

### Site: `src/sideGames.ts` (new)
Owns side-game state: which server, participants, per-player maps played and
maps sat out, current size, and the roster for the next map. Pure functions
for size choice and rotation (unit tested). It listens to matchmaker queue
changes and to `PUGSIDE` log lines. It talks to the box through
`SideGameOrchestrator` below. In memory only, like the matchmaker, plus the
opt-in flag in `matchmaker_state`.

### Site: balance
`balanceTeams` accepts 4 or 6 players as well as 8 (`src/balance.ts:16`).
It enumerates splits with player 0 on team A, and the 8-player path stays
identical so ranked balancing does not change.

### Site: `SideGameOrchestrator` (in `src/sideGames.ts` or its own file)
Rcon sequences:
- open/next map: `sm_pug_auto_track 0`, `sv_password "side_<token8>"`,
  `exec rotoblin_hardcore_{2v2|3v3}`, `sm_side_start <token>`,
  `sm_side_roster "<steamid>:<A|B|S>"` per player, `changelevel <map>`.
- stop: `sm_side_stop <token>`.
- pop: `sm_side_popped <readySeconds>`, then `sm_side_vote <token>
  <campaign>...` when the vote phase starts.
The side-game password reuses `serverPasswordFor` with a separate token so
strangers stay out (the standing `sv_password` rule in the web-queue memory
still holds: never blank it).

Map choice: the first map is a random `l4d_vs_` map 1 from the stock
campaigns every server carries; later maps follow the campaign, and after
the finale a new random campaign starts. Custom campaigns are skipped.

### Plugin: `plugin/pug-sidegame.sp` (new, separate from pug-match)
Kept out of `pug-match.sp` on purpose: that plugin is the ranked core, and a
side-game bug must not be able to touch a real match.
- Team lock for the side roster (same approach as `Timer_TeamLock`: place
  rostered players, keep `S` players and strangers in spectate).
- `sm_side_popped`: center text plus a chat line every 15 s until the player
  types `!ready`. Each `!ready` logs `PUGSIDE READY <token> <steamid>`.
- `sm_side_vote`: shows a menu of the campaigns; a pick logs
  `PUGSIDE VOTE <token> <steamid> <campaign>`.
- Map end (both halves done) logs `PUGSIDE MAPEND <token> <map>` so the site
  can rebalance and change level.
- Connect and disconnect log `PUGSIDE JOIN|PART <token> <steamid>`.
- `sm_side_stop` clears everything and removes the team lock.
Lines go through the existing signed log channel (`pug-logauth.inc`), and
`logParse.ts` gets a `PUGSIDE ` branch like `PUGCALL `.

### Site: in-game ready and vote
`PUGSIDE READY` calls `matchmaker.ready(steamid)`, the same path as the web
button, so the voice gate (`readyGate`) applies unchanged. If the gate
blocks, the plugin is told (`sm_side_notice <steamid> "<reason>"`) so the
player sees why in game. `PUGSIDE VOTE` calls `lobby.castVote`. The token
must match the current side game, or the line is ignored.

### Site and Discord UI
- Queue panel: the toggle, and the side-game line with connect details for
  opted-in players.
- Discord queue card: a "Side games" toggle button and the status line.
- Admin settings: `sidegames_enabled` (default 0) and `sidegames_min_players`
  (default 4, min 4).

## Nothing is recorded: how that is enforced

- `sm_pug_auto_track 0` for the whole side game (and `sm_pug_auto_min_players`
  is 8, which a side game never reaches, as a second guard).
- No `matches` row and no call to anything in `matchResult`, `rating`,
  `replays` or `weeklyAwards`.
- Log lines from a `sidegame` server that are not `PUGSIDE` (conduct,
  input stats, LilAC, mod calls) are still handled: they are about people,
  not matches. Conduct alerts and mod calls should still work in a side
  game. Implementation check: the input-stats and macro detectors must not
  record side games as match data.

## Error handling

- Rcon failure while opening: release the server, log it, try again on the
  next queue change (at most once a minute).
- Rcon failure while stopping at pop: `setupMatch` falls back to `claimIdle`
  for another server, and the side-game box is closed in the background.
- The 8th player joins the queue during a side-game map change: the pop
  wins. The pending rebalance is dropped.
- Web restart: see Boot above.

## Testing

- Unit: size choice, rotation order, `balanceTeams` for 4/6/8 (8 unchanged
  against the existing tests), `PUGSIDE` parsing, token mismatch ignored,
  voice gate on the in-game ready path.
- Integration (fake rcon): open at 4, 5 sits one out, grow to 6 at map end,
  pop at 8 prefers the side-game server, ready-fail resumes the side game,
  pre-emption by a waiting match, boot reconcile of `sidegame`.
- Local server (`l4d1-ds`, shared, check `status` first): the plugin's team
  lock, `!ready`, the vote menu, map-end line, and that no match or replay
  appears. Then a supervised first run on Dallas with the setting on.

## Out of scope

- Any record of side games (owner: not wanted).
- Rulesets other than hardcore 2v2/3v3, and player-chosen rulesets.
- 1v1, uneven teams, or bots filling slots.
- More than one side game per queue.
