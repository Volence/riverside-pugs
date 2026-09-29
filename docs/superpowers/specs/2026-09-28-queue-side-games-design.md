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
- Growing (2v2 to 3v3) happens only between maps. Shrinking is handled at
  once: a sitter subs in, or the map restarts at the smaller size, or the
  game ends below 4 (see "When someone leaves").
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
   player leaves the queue. It only appears once 4 or more are queued (on
   the site it also stays visible for anyone already opted in, so a queue
   dipping to 3 does not hide their tick; the opt-in itself is kept).
2. When 4 opted-in players are queued and a server is free, the site opens a
   side game. The queue panel shows "Side game open: 2v2, 4 playing" with the
   usual connect button and console line (side-game password). Discord shows
   the same line on the queue card. Players who did not opt in see
   "Side game running (4 players)" and no connect details.
3. In game, the site places everyone on their team. Rotoblin ready-up runs
   as usual, so the map goes live when both teams ready.
4. More people opt in mid-map: they connect and spectate. At the next map
   change the site rebalances, picks the new size and loads that config.
5. At 8 in the queue: the side game stops at once. The plugin moves every
   player to spectator and shows a center-screen and chat notice: "QUEUE
   POPPED: type !ready". `!ready` is intercepted while popped (Rotoblin's
   ready-up has no use for it then) and goes to the site. The campaign vote
   then appears as an in-game menu. Both are also on the site and Discord
   exactly as today.
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

## When someone leaves

Growing waits for the map to end, because the running game is still fair.
Shrinking is handled at once, because the running game is already broken
and nothing is recorded, so there is no score to protect.

What counts as leaving:
- **Disconnects but is still queued** (crash, game restart): a 90 s grace.
  A bot covers a survivor slot; an infected team plays one short. On
  reconnect the team lock puts them back in their slot.
- **Leaves the queue, or the 90 s grace runs out:** gone. Someone still in
  the server after leaving the queue is moved to spectate and dropped from
  the roster.

Then, in order:
1. **Someone is sitting out:** the longest sitter subs into the empty slot
   straight away, mid-round. No restart; the size does not change.
2. **Nobody is sitting out and 4 or more remain** (for example 6 to 5):
   the current map restarts straight away at the new size. The site
   rebalances, execs the matching config and changes level to the same map.
3. **3 or fewer remain:** the game ends straight away. The server stays
   held for 3 minutes in case someone opts in or reconnects, then is closed
   and released.

Growing and rotation are computed at map end and applied at the next map
start: the site pushes the new roster, and if the size changed it execs the
new config, whose `sm_restartmap` restarts the fresh map before anyone has
played it. An exec AT map end would restart the map just finished.

## Server lifecycle

A side game holds its box through a row in a new `side_games` table, NOT a
`servers.status` value. This follows the `practice_leases` precedent in
`src/db.ts`: status has a CHECK constraint SQLite can only change by
rebuilding a table other tables reference, and `reconcileServers` frees every
`reserved` row with no live match at boot, which would run `sm_pug_abort` and
`exec secrets.cfg` into a running side game. The held box stays `idle`, and
`NOT_LEASED_SQL` (`src/serverPool.ts`) now also excludes boxes with an open
side game, so `claimIdle`, practice leases, the balance writer and the release
engine all leave it alone.

- **Open:** needs `sidegames_enabled = 1`, `sidegames_min_players` (default 4)
  opted-in players, no configuring match waiting for a server, and a
  claimable box. It takes the LOWEST id claimable box, the one `claimIdle`
  would give the match.
- **Pre-emption:** a configuring match that finds no idle server may take a
  server holding a side game. The side game ends, and its players stay in the
  queue. Only the pop of the side game's own queue normally ends it, because
  every side-game player is in that queue.
- **Pop to match:** the side game claimed its box with the same `claimIdle`
  a match uses, so it holds the server the match would have taken anyway.
  `setupMatch` takes the side game's server instead of claiming a fresh one.
  It sends `sm_side_stop`, then runs the normal sequence (`exec pug_match`,
  new `sv_password`, `sm_pug_match`, roster, changelevel). Connected clients
  survive the password change and the changelevel.
  The one exception: if the voted campaign cannot run there (custom campaign
  not installed, or dlc4 missing), which the pool rules normally prevent,
  `setupMatch` closes the side game and falls back to `claimIdle` as today;
  players then reconnect to the new box with the link the site already shows.
- **Restart-after-match** does not apply: no match ended.
- **Close:** `ServerReleaser.release(id, { restart: true, forceRestart: true })`
  (srcds restarts in 1-4 s, which clears the 2v2/3v3 config; the releaser's
  cleaner ends with `exec secrets.cfg`), then the row is ended.
- **Boot:** every open `side_games` row is closed the same way. The queue and
  the opt-ins survive in `matchmaker_state`, so the game reopens by itself.

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
Rcon sequences (see `src/sideGames.ts` for the exact commands sent):
- open (also a re-open after a close-grace restart): `sv_password
  "side_<token8>"`, `exec rotoblin_hardcore_{2v2|3v3}`, `sm_side_start
  <token> <password>`, `sm_side_roster <id64>:<A|B|S> ...` (one command,
  all seats), `changelevel <map>`. The site never sends `sm_pug_auto_track`;
  the plugin itself saves, zeroes and restores `sm_pug_auto_track` for as
  long as a side game is active.
- grow, shrink, or rotate to a new map: `exec rotoblin_hardcore_{2v2|3v3}`
  (only when the size changes) followed by a fresh `sm_side_roster ...`.
- pop: `sm_side_popped` (no argument), then, once the map vote starts,
  `sm_side_vote "<slug>=<Display Name>" ...` (one command, one quoted
  `slug=Name` pair per campaign).
- resume: `sm_side_resume`, sent when a failed lobby returns players to the
  queue and the side game keeps its box.
- notice: `sm_side_notice <id64> "<text>"`, sent when an in-game `!ready` is
  refused.
- stop: `sm_side_stop <token>`.
The side-game password follows the same `<prefix>_<token8>` shape as a
match's (`serverPasswordFor`), but with its own `side_` prefix and its own
token, so strangers stay out and a side-game token can never double as a
match password (the standing `sv_password` rule in the web-queue memory
still holds: never blank it).

Map choice: the first map is a random `l4d_vs_` map 1 from the stock
campaigns every server carries; later maps follow the campaign, and after
the finale a new random campaign starts. Custom campaigns are skipped.

### Plugin: `plugin/pug-sidegame.sp` (new, separate from pug-match)
Kept out of `pug-match.sp` on purpose: that plugin is the ranked core, and a
side-game bug must not be able to touch a real match.
- Team lock for the side roster (same approach as `Timer_TeamLock`: place
  rostered players, keep `S` players and strangers in spectate).
- `sm_side_start <token> <password>`: the plugin stores the side-game password
  and re-asserts `sv_password` in OnConfigsExecuted while a game is active,
  because server.cfg re-execs on every map change and restores the standing
  password (pug-match does the same).
- `sm_side_popped`: center text plus a chat line every 15 s until the player
  types `!ready`. Each `!ready` logs `PUGSIDE READY <token> <steamid>`.
- `sm_side_vote`: shows a menu of the campaigns; a pick logs
  `PUGSIDE VOTE <token> <steamid> <campaign>`.
- Map end (both halves done) logs `PUGSIDE MAPEND <token> <map>` so the site
  can rebalance and change level.
- Connect and disconnect log `PUGSIDE JOIN|PART <token> <steamid>`. The site
  runs the 90 s reconnect grace and sends `sm_side_roster` for a sub-in;
  the plugin moves the sub into the open slot mid-round.
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
- Log lines from a server holding a side game that are not `PUGSIDE` (conduct,
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
  pre-emption by a waiting match, boot closes any open `side_games` row.
- Local server (`l4d1-ds`, shared, check `status` first): the plugin's team
  lock, `!ready`, the vote menu, map-end line, and that no match or replay
  appears. Then a supervised first run on Dallas with the setting on.

## Out of scope

- Any record of side games (owner: not wanted).
- Rulesets other than hardcore 2v2/3v3, and player-chosen rulesets.
- 1v1, uneven teams, or bots filling slots.
- More than one side game per queue.
