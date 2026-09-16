# Runbook: the first website-to-playing match

This is the first time the web queue -> matchmaker -> RCON orchestration path
runs against the real game server. Every match the server has ever run before
this was started in-game with `!load_4v4p` and only adopted by the backend
afterward. The whole `RealOrchestrator.setupMatch` / server-claim / roster /
teardown path has so far only ever run against the fake RCON server in the
test suite. The plugin side of this work (placement instead of kicking, the
new `teamLock` status field, the end-of-match kick-to-menu) is compile-verified
only; there is no SourcePawn test harness. This runbook is the first real
verification of any of it, and every check below states what to expect,
because "verify it works" is useless at 2am with eight people in a Discord
call asking if it's working yet.

**Read this whole document before starting.** Do not start pulling people into
a queue until you have done Step 1.

**WARNING: this changes the live server.** Real players are often connected.
Get the owner's explicit go-ahead before starting, even if you are the owner
reading this to yourself.

Shorthand used below: `R "<cmd>"` means `/home/volence/l4d/deploy/rcon.py
"<cmd>"`, same as `plugin/TESTING.md`. It needs `L4D_RCON_PW` in the
environment; `plugin/stage.sh` sources it automatically, but a bare `R` call
does not:

    export L4D_RCON_PW=$(sed -n 's/^ *rcon_password *"\([^"]*\)".*/\1/p' \
      /home/volence/l4d/deploy/overrides/left4dead/cfg/secrets.cfg | head -1)

`sqlite3 data/pug.db "..."` below assumes you are either on the box at
`/home/pug/app` or have pulled a copy of `pug.db` locally; adjust the path to
match wherever you are actually running it from.

## 1. Preconditions (do this first, before anything else)

This step exists because of the single most likely way tonight goes wrong
silently: a match that finds no idle server now **waits forever** instead of
failing loudly. If the server row is not `idle` before you start, the queue
will pop, the match will sit in `configuring`, nobody will get a connect
button, and there will be no error anywhere. It will look exactly like a
hung queue. Catch it here, not after eight people are already waiting.

1. Confirm nobody is on the server:

       R "status"

   Expected: `players : 0 humans, 0 bots` (SourceTV, if connected, does not
   count as a human player).

2. Confirm there is no match already mid-flight:

       sqlite3 data/pug.db "SELECT id, state FROM matches WHERE state IN ('configuring','live');"

   Expected: no rows. Any row here means a previous match is still open;
   resolve it (see Step 8, Rollback) before starting a new one.

3. **Confirm the server row is claimable.** This is the trap:

       sqlite3 data/pug.db "SELECT id, name, status FROM servers;"

   Expected: `status` reads `idle` for the Dallas box's row. If it reads
   anything else, read the table below before doing anything else.

   | status seen | what it means | what to do |
   |---|---|---|
   | `idle` | claimable, proceed | nothing, you're clear |
   | `offline` | the schema's default for a freshly-inserted row; nothing in production ever promotes this to `idle` on its own | this is the box's actual row if it has never yet been released by a real match. Restart `pug-web` (boot runs `reconcileServers`, see below) and re-check; if it is still `offline`, manually set it: `sqlite3 data/pug.db "UPDATE servers SET status='idle' WHERE id=<id>;"` only after you have independently confirmed via `R "status"` that no match owns the box |
   | `reserved` or `live` with no owning match | stranded from a crash | restart `pug-web`. Its boot sequence calls `reconcileServers`, which frees any server marked `reserved` or `live` that no `configuring`/`live` match row owns. Re-run the query in this step after the restart to confirm it moved to `idle` |
   | `reserved` or `live` with a real owning match | genuinely in use | do not touch it; that match needs to finish or be rolled back first (Step 8) |

   Do not skip ahead assuming this is fine. The failure mode is silent by
   design (see Task 12 background): a match with no free server logs a
   warning server-side and just waits. Nobody in the Discord call will see
   an error.

4. Get the owner's explicit go-ahead to proceed. Do not deploy or stage
   anything before this.

## 2. Ship order

Order matters here specifically because staging the plugin **resets every
plugin cvar to its compiled default**, and those defaults do not match what
production needs. The map-change exec (`pug_match.cfg` / the pub config) is
what normally re-asserts them; you have not changed maps yet at this point,
so nothing will reset them for you.

1. Deploy the web app:

       ./deploy-web.sh

   Expected: rsync summary, `npm ci` / `npm run build` succeed on the remote,
   `pug-web` restarts, and the script's own check prints `HTTP 200`. If it
   prints anything else, do not proceed to step 2; the web half is what owns
   the queue and the server-claim logic you just verified in Step 1.

2. Confirm the server is still empty (people can join between Step 1 and now):

       R "status"

   Expected: 0 humans, same as Step 1.3.

3. Build and stage the plugin:

       plugin/build.sh
       plugin/stage.sh

   `pug-match.smx` is gitignored, so `build.sh` must run first even if you
   built it earlier in this session on a different checkout; do not assume a
   stale local `.smx` is current. Expected from `stage.sh`: `Plugin PUG Match
   reloaded successfully` (or a fresh `load` if it wasn't loaded), and it
   refuses on its own if it sees anyone connected, so a nonzero player count
   here is itself the signal something joined between steps.

4. Re-assert the cvars the reload just reset:

       R "sm_pug_auto_track 1"
       R "sm_pug_roster_at_live 1"

   `sm_pug_auto_track` defaults to `0` at compile time; production needs it
   at `1`. `sm_pug_roster_at_live` defaults to `1`, so this second line is
   belt-and-suspenders, but set both anyway rather than trusting which
   default happens to already match. Confirm both landed:

       R "sm_pug_auto_track"
       R "sm_pug_roster_at_live"

   Expected: both print `1`.

## 3. Let the queue pop

Have the owner (or you) queue up on the site as normal, eight ranked
players, through to the campaign vote and team balance. Do not join the game
server yet. Watch `GET /api/queue` on the site (no sign-in needed) if you
want to narrate progress to the Discord call without giving away connect
details early; it never carries connect info, only who is queued.

Once the queue pops, the backend runs `setupMatch`: claims the server,
writes a token, execs `pug_match`, sets `sv_password`, sends `sm_pug_match`
and eight `sm_pug_roster` lines over rcon, then `changelevel`s into the
first map of the voted campaign.

1. Confirm the match left `configuring`:

       sqlite3 data/pug.db "SELECT id, state, server_id, token FROM matches ORDER BY id DESC LIMIT 1;"

   Expected: `state = live`, `server_id` and `token` both non-null. If
   `state` is still `configuring` and `server_id` is null, the match is
   **waiting**, almost certainly because of the Step 1 trap: re-check
   `SELECT status FROM servers`. If it now reads `idle` and the match is
   still waiting, check the `pug-web` service log for `[orchestrator] no
   idle server` or `[pendingMatches]` lines.

## 4. Roster identity check, before anyone connects

This is the single pairing that has never once been exercised against the
real backend. Do this before telling anyone to click Join.

1.       R "sm_pug_status"

   Expected fields to read off the `STATUS state=...` and `STATUS
   roster slot=... steamid=... team=... connected=0 ...` lines:

   - `state=live`
   - `match=<id>` matching the id from Step 3.1
   - eight `STATUS roster` lines, each `connected=0` (nobody has joined yet)
   - `teamLock=1` on the `STATUS selfStarted=... teamLock=... recordDemos=...`
     line

   **If `teamLock=0`, stop and do not tell anyone to connect.** Rostered
   players will not be placed onto their assigned sides if they join, and the
   match is not worth starting until this reads 1. (`enforceRoster` is not a
   field any more; do not look for it. Non-rostered joins are never kicked,
   by design, so its absence is expected and not a regression.)

2. Compare the eight `steamid=` values from `sm_pug_status` against the
   database:

       sqlite3 data/pug.db "SELECT player_id, team FROM match_players WHERE match_id = <id>;"

   Expected: the same eight SteamID64s, same team letters, in the plugin's
   roster as in `match_players`. A mismatch here means the `sm_pug_roster`
   calls in `setupMatch` did not land as sent (check for a quoting problem;
   the `steamid:team` argument must arrive quoted, an old bug from
   2026-08-29 where an unquoted arg gets split on `:` by Source's console
   tokenizer and the plugin rejects the line). Do not let people connect
   until this matches exactly.

## 5. Connect

Each of the eight uses the site's "Join server" button
(`steam://connect/<host>:<port>/pug_<token8>`), or the copyable console line
if Steam's protocol handler misbehaves for them, which happens.

1. Confirm all eight land and are visible in-game (voice comms, or ask in
   Discord). A ninth, non-rostered person may also join; this is fine and
   expected.

2. Confirm the ninth person is **not** kicked:

       R "sm_pug_status"

   Expected: still exactly eight `STATUS roster` lines (the roster is fixed
   at eight; a spectator does not get a ninth line), each rostered slot now
   showing `connected=1` for the seven or eight who have joined so far, and
   the non-rostered client simply present in-game as a spectator, untouched.
   The plugin no longer kicks anyone who isn't on the roster; if you see a
   kick, that is new and wrong, not expected behavior.

## 6. Placement

Rostered players are moved onto their assigned side by `Timer_TeamLock`,
without typing anything.

1. Turn on verbose logging if you have not already (this is separate from
   `stage.sh --solo`, which you should not use tonight since that also sets
   `min_orient=1`, a testing value):

       R "sm_pug_debug 1"

2. Watch the SourceMod log:

       ssh root@$L4D_HOST 'tail -f /home/l4d/l4d1-server/left4dead/addons/sourcemod/logs/L*.log' | grep -i pug

   Expected within a few seconds of each rostered player connecting: a line
   like `lock moving <name> to <side> (attempt N)` for each one that needed
   moving. **Silence here is the signal that placement is not happening**
   even though `teamLock=1` read correctly in Step 4; if nobody moves and
   nothing logs, do not assume it will catch up on its own, escalate now
   rather than after people have been sitting on the wrong team for a while.

3. Confirm in-game: each of the eight is on their assigned side (`team=` in
   `sm_pug_status`'s roster lines matches what they're actually standing on),
   and the ninth non-rostered person, if present, is left alone and can
   freely spectate or pick a side without being moved back.

4. Set debug back off once you've confirmed this, so the log doesn't fill
   with noise for the rest of the match:

       R "sm_pug_debug 0"

## 7. Play and end

Play the match normally, or shortcut it. The chat command is `!endpug`
(admin only); the equivalent over rcon is:

    R "sm_endpug"

1. Expected chat line when the match ends, from either a real finale or
   `!endpug`:

       [PUG] Match ended. <campaign>: Team A wins <a> to <b>. Reporting to the site.

2. Eight seconds later, expected: everyone still connected (rostered or not)
   is kicked to the main menu, with the disconnect/kick dialog showing the
   same result string, e.g. `blood_harvest: Team A wins 1247 to 980`. This
   is new behavior this branch adds; previously nobody was kicked at match
   end. If people are not kicked after roughly 8 seconds, that is a
   regression worth flagging even though it does not block the match from
   having completed correctly on the backend.

## 8. Teardown checks

Do all four. Do not stop at the first one that looks right.

1. Password cleared:

       R "sv_password"

   Expected: empty value (no password set). If it still shows
   `pug_<token8>`, the `ServerReleaser` did not clear it; casual players will
   not be able to join the box until this is fixed by hand
   (`R "sv_password \"\""`) and the underlying bug investigated.

2. Server row freed:

       sqlite3 data/pug.db "SELECT id, status FROM servers WHERE id = <id>;"

   Expected: `status = idle`.

3. Match row completed:

       sqlite3 data/pug.db "SELECT id, state, winner, team_a_score, team_b_score, ended_at FROM matches WHERE id = <id>;"

   Expected: `state = completed`, `winner` and both scores populated,
   `ended_at` non-null.

4. Leaderboard moved:

       curl -s https://riversidepug.com/api/leaderboard | python3 -m json.tool | head -40

   Expected: the eight rostered players' entries reflect the match (SR
   changed from whatever it was before kickoff). Cross-check one player you
   know the pre-match SR for if you have it handy; a leaderboard that looks
   identical to before the match means rating never ran, which is a separate
   and serious problem from anything the teardown checks above cover.

If all four pass, the first real web-to-server match is confirmed working
end to end. Tell the Discord call. Go to bed.

## 9. Rollback

If the plugin misbehaves at any point after staging (wrong placement, no
kicks, roster mismatch, whatever), the fix is:

1. Stage the previous `.smx`. You need the old build; if you don't have it
   saved, check out the previous commit of `plugin/pug-match.sp` and
   `plugin/build.sh` it, or restore a backed-up `.smx` if one exists on the
   box or locally, then:

       plugin/stage.sh

2. Abort the specific match that's misbehaving:

       R "sm_pug_abort <token>"

   Use the actual token for that match, from `sqlite3 data/pug.db "SELECT
   token FROM matches WHERE id = <id>;"`.

**Never run a blanket update.** Do not, under any circumstance, run:

    UPDATE matches SET state='aborted' WHERE state='live'

This has already killed a match the owner had just started, on a previous
occasion. It touches every live match on the box, not just the one that's
broken. Always target a specific match id, and always go through
`sm_pug_abort <token>` first so the plugin's own state (and the server's
`sv_password`, via the release path) gets cleaned up too, rather than editing
the database out from under a plugin that still thinks it owns that match.

After an abort, confirm the server actually freed:

    sqlite3 data/pug.db "SELECT status FROM servers WHERE id = <id>;"

Expected: `idle`. If not, fall back to Step 1.3's stranded-row handling.
