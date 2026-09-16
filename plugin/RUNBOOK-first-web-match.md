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

A couple of steps below also `ssh` to the box directly (to tail the
SourceMod log), which needs `L4D_HOST` set:

    . /home/volence/l4d/deploy/server.env   # sets L4D_HOST

`sqlite3 data/pug.db "..."` below assumes you are either on the box at
`/home/pug/app` or have pulled a copy of `pug.db` locally; adjust the path to
match wherever you are actually running it from.

### Before you restart `pug-web`

Several recovery steps below tell you to restart `pug-web`. **Every one of
them has the same precondition: srcds must already be answering rcon.**
Confirm it, every time, immediately before the restart:

    R "status"

If that times out or errors, wait for srcds and re-check. Do not restart
`pug-web` until it answers.

Why: boot drains the pending list through `setupMatch`, and `setupMatch`
treats an rcon failure as fatal and **aborts the match**. Start `pug-web`
while srcds is down or mid-`changelevel` (a whole-box restart, or a restart
timed into a map change) and a match that was merely waiting for a box is
killed outright instead of waiting a little longer. That trade is deliberate,
since a match stuck in `configuring` locks its eight players out of the queue
entirely, but it does mean the restart is only safe once the game server is
back.

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
   resolve it (see Step 9, Rollback) before starting a new one.

3. **Confirm the server row is claimable.** This is the trap:

       sqlite3 data/pug.db "SELECT id, name, status FROM servers;"

   Expected: `status` reads `idle` for the Dallas box's row. If it reads
   anything else, read the table below before doing anything else.

   | status seen | what it means | what to do |
   |---|---|---|
   | `idle` | claimable, proceed | nothing, you're clear |
   | `offline` | the schema's default for a freshly-inserted row; nothing in production ever promotes this to `idle` on its own | this is the box's actual row if it has never yet been released by a real match. Confirm srcds answers `R "status"` (see **Before you restart `pug-web`**), restart `pug-web` (boot runs `reconcileServers`, see below) and re-check; if it is still `offline`, manually set it: `sqlite3 data/pug.db "UPDATE servers SET status='idle' WHERE id=<server id>;"` only after you have independently confirmed via `R "status"` that no match owns the box |
   | `reserved` or `live` with no owning match | stranded from a crash | confirm srcds answers `R "status"` (see **Before you restart `pug-web`**), then restart `pug-web`. Its boot sequence calls `reconcileServers`, which frees any server marked `reserved` or `live` that no **`live`** match row owns. Re-run the query in this step after the restart to confirm it moved to `idle` |
   | `reserved` or `live` owned by a `configuring` match | a crash between `setupMatch` writing `server_id` and `setupMatch` flipping the match to `live`. The match is holding the only box and can never claim one again by itself | confirm srcds answers `R "status"` (see **Before you restart `pug-web`**), then restart `pug-web`. `reconcileServers` frees the box (a `configuring` match no longer protects one) and the boot drain hands it straight back to that same match, which should read `live` within a few seconds. Re-run both this query and the match query in item 2 to confirm |
   | `reserved` or `live` with a real `live` match | genuinely in use | do not touch it; that match needs to finish or be rolled back first (Step 9) |

   **If you set a row to `idle` by hand, restart `pug-web` afterward** (srcds
   answering rcon first, as always: see **Before you restart `pug-web`**). A row
   that simply becomes idle in place fires no release, and releases are what
   normally wake a waiting match. Boot now also drains the pending list once,
   which is the only thing that will pair an already-idle box with a match
   that was already waiting.

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
   prints anything else, do not proceed to Step 2's item 2 below; the web
   half is what owns the queue and the server-claim logic you just verified
   in Step 1.

2. Confirm the server is still empty (people can join between Step 1 and
   now):

       R "status"

   Expected: 0 humans, same check as Step 1.1.

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

   Expected: a raw cvar query, not a bare value, so look for the `1` inside
   it: `"sm_pug_auto_track" = "1"` and `"sm_pug_roster_at_live" = "1"`.

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
   idle server` or `[pendingMatches]` lines. If `state` is `configuring` but
   `server_id` is **not** null, setup died partway through; see "Two strand
   modes that are not the plugin misbehaved" in Step 9.

   One case here is expected rather than wrong: a SECOND queue popping while
   the first match is still live waits exactly like this, because there is
   only one server. See Step 8b before touching it.

   **Write down both numbers from this row and keep them straight for the
   rest of the night.** The `id` column is the *match id*, referred to below
   as `<match id>`. The `server_id` column is a different number from a
   different table (`servers`), referred to below as `<server id>`. They are
   not interchangeable; a query against `servers` needs `<server id>`, a
   query against `matches` or `match_players` needs `<match id>`.

## 4. Roster identity check, before anyone connects

This is the single pairing that has never once been exercised against the
real backend. Do this before telling anyone to click Join.

1.       R "sm_pug_status"

   Expected fields to read off the output (lines start with `STATUS state=...`
   and `STATUS roster slot=... steamid=... team=... connected=0 ...`):

   - `state=live`
   - `match=<match id>` matching the match id from Step 3.1
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

       sqlite3 data/pug.db "SELECT player_id, team FROM match_players WHERE match_id = <match id>;"

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
   end.

   **Pass/fail:** everyone is out of the server within about 8 seconds on the
   `!endpug` path. On a **finale** path the first attempt lands while the
   finale map is still loading and most clients are not yet in game, so give
   it up to about 40 seconds: the kick retries every 8 seconds for 5 passes
   and stops as soon as the box is empty. Anyone still connected after that,
   or a `status` that still shows humans, is a real regression.

   This expectation used to be a near-certain false alarm and is now
   reliable, so treat a failure as real. The kick was keyed off the same
   buffer `ResetMatchState()` blanks, and the backend sends `sm_pug_abort`
   (which resets that state) within a few hundred milliseconds of a
   successful report, so the kick was cancelled long before its 8 second
   timer fired and only ever ran when **reporting failed**. It now holds its
   own timer and reason, survives the backend's routine abort, and is
   cancelled only where a genuinely new match begins (`sm_pug_match`,
   `!load_4v4p`, auto-track adoption).

   **Backend-driven matches only.** A self-started (`!load_4v4p`) or
   auto-tracked match prints the same result line and kicks nobody. Ending
   one of those is what an ordinary friend-group night does at every campaign
   change, and emptying the box each time is not wanted. So do not expect this
   check to pass on an in-game night, and do not "fix" it if it does not.

3. Confirm the box is actually empty before anyone tries to queue again:

       R "status"

   Expected: `0 humans`. A non-empty box here does not corrupt the result,
   which is already recorded, but the next queue pop will `changelevel`
   whoever is left.

## 8. Teardown checks

Do all four. Do not stop at the first one that looks right.

1. Standing password restored:

       R "sv_password"

   Expected: **the box's standing password from `secrets.cfg`, not an empty
   value.** An earlier draft of this runbook said to expect empty; that was
   written before `74f7230`, which changed release to `exec secrets.cfg`
   rather than blanking the password. This box carries a standing
   `sv_password` (exec'd by `local.cfg`) and that is what keeps strangers
   off it, so an EMPTY value here is now the bug, not the pass condition.

   If it still shows `pug_<token8>`, the `ServerReleaser` never ran its
   restore; re-assert by hand with `R "exec secrets.cfg"` (never a literal,
   the file is the single source of truth) and investigate.

2. Server row freed:

       sqlite3 data/pug.db "SELECT id, status FROM servers WHERE id = <server id>;"

   Expected: `status = idle`.

3. Match row completed:

       sqlite3 data/pug.db "SELECT id, state, winner, team_a_score, team_b_score, ended_at FROM matches WHERE id = <match id>;"

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

## 8b. A second queue while the first match is live

This is expected behaviour with one server, not a fault. Worth reading before
the night starts so nobody debugs it live.

The queue does not freeze at 8/8 when it pops. `maybeStartLobby` calls
`queue.takeBatch(8)`, which is a `splice`, so the eight leave the queue
immediately and a ninth person joining lands in a fresh `1/8`. That part
needs no intervention.

What follows is the part to explain to people out loud. When that second
queue fills and its lobby completes, `onLobbyComplete` inserts the match as
`configuring` and calls `setupMatch`, which finds no idle box because match 1
holds the only one. `onNoServer` puts it in `PendingMatches` and those eight
see **"Waiting for a server"**. They stay there until match 1 releases, and
the release drains exactly one pending match. Correct, by design.

Three consequences, all of them things that look like bugs at 1am:

- **A waiting match has no timeout.** `reapNoShowMatches` selects only
  `state='live' AND went_live_at IS NOT NULL` (`src/noShow.ts`). A match
  waiting for a box is `configuring` with `server_id IS NULL`, so nothing
  reaps it. It waits indefinitely.
- **Those eight cannot leave.** `hasOpenMatch` counts `configuring`, so
  `/api/queue/join` refuses them, and `/api/queue/leave` does nothing because
  they are not in the queue. There is no in-product way for them to back out.
- **There is no admin cancel route.** Production registers six routes
  (`queue/join`, `queue/leave`, `lobby/ready`, `lobby/vote`, `state`,
  `queue`). The only abort lives in `src/routes/dev.ts` behind `DEV_MODE=1`,
  which is deliberately not set on the box.

So the escape hatch is by hand, and it must be **targeted at one id**. The
blanket form is what killed a match the owner had just started:

    # Find it first. Never abort without reading this output.
    sqlite3 /home/pug/app/data/pug.db \
      "SELECT id, state, campaign, server_id, created_at FROM matches
       WHERE state = 'configuring';"

    # Confirm it is the WAITING one: server_id must be NULL. If server_id is
    # set, this is a match mid-setup that owns a box, and section 9 applies
    # instead.

    # Then, one id only:
    sqlite3 /home/pug/app/data/pug.db \
      "UPDATE matches SET state='aborted', ended_at=datetime('now')
       WHERE id=<match id> AND state='configuring' AND server_id IS NULL;"

The `AND` clauses are not decoration: they make the statement a no-op rather
than a disaster if the match moved on between your SELECT and your UPDATE.

Restart `pug-web` afterward so `PendingMatches.rebuildFromDb` drops it from
the in-memory waiting list. Without that, the aborted id stays in `waiting`
until the next drain, where it is skipped harmlessly (`drain` re-reads state
and continues past anything not `configuring`), so the restart is tidiness
rather than a repair. The eight players can re-queue as soon as the row is
`aborted`, restart or not, because `hasOpenMatch` reads the database directly.

**If you would rather not deal with any of this:** hold the second queue.
Tell people not to fill it until match 1 is close to ending.

## 9. Rollback

If the plugin misbehaves at any point after staging (wrong placement, no
kicks, roster mismatch, whatever):

1. Stage the previous `.smx`. You need the old build; if you don't have it
   saved, check out the previous commit of `plugin/pug-match.sp` and
   `plugin/build.sh` it, or restore a backed-up `.smx` if one exists on the
   box or locally, then:

       plugin/stage.sh

2. Abort the specific match that's misbehaving:

       R "sm_pug_abort <token>"

   Use the actual token for that match, from `sqlite3 data/pug.db "SELECT
   token FROM matches WHERE id = <match id>;"`.

**`sm_pug_abort` only resets the plugin's own in-memory state.** `Cmd_Abort`
in `plugin/pug-match.sp` calls `ResetMatchState()` and nothing else: it never
touches the database and never restores `sv_password`. Immediately after a bare
`sm_pug_abort`, expect the match row to still read `state = live` and the
server row to still be non-idle. That is correct, not a bug, and the next two
paragraphs are what actually closes it out. Do not stop at `sm_pug_abort`
and consider the box recovered.

**Path A, automatic (takes 10 to 11 minutes, no further action needed):**
`Timer_Heartbeat` in the plugin only emits `HEARTBEAT` while
`g_State != MS_None`, and `ResetMatchState()` sets `g_State = MS_None`, so the
heartbeat stops the instant `sm_pug_abort` runs. `match_live.last_seen` then
goes stale, and `reapOrphanedMatches` in `src/liveView.ts` aborts any `live`
match whose heartbeat has been silent for `ORPHAN_AFTER_MS` (600000ms, i.e.
10 minutes). That reaper runs on a 60 second interval alongside
`reapNoShowMatches` (`src/server.ts`), so worst case is 10 minutes plus
just under 60 seconds, roughly 10 to 11 minutes total. When it fires it goes
through the same `ServerReleaser` as every other path, so the standing
`sv_password` is restored as part of it. If you can afford to wait that long, running
`sm_pug_abort` and then leaving it alone is enough; just say so out loud in
the Discord call so nobody re-tries the same match in the meantime.

**Path B, manual (when you will not wait):** update the match row yourself,
then restart the web service so the boot-time reconciler picks up the now-
freed row. **The order below matters; do not restart first.**

    sqlite3 data/pug.db "UPDATE matches SET state='aborted', ended_at=datetime('now') WHERE id=<match id>;"

Then confirm srcds is answering rcon (`R "status"`; see **Before you restart
`pug-web`**) and restart `pug-web`. Its boot sequence calls `reconcileServers`
(`src/serverRelease.ts`), which frees any server marked `reserved` or
`live` whose match is **not** `live` any more. Restarting before the update
is a no-op: `reconcileServers` excludes a server whose match is still
`live`, which is exactly the state the match is in right after a bare
`sm_pug_abort` and before this update runs. Do the update first, always.

(`configuring` used to be excluded here too, and is not any more. That is a
deliberate fix, not a widening you need to work around: a `configuring`
match only ever holds a `server_id` because `setupMatch` crashed between
claiming the box and going live, and a match that is merely waiting for a
box has `server_id IS NULL` and so is never touched.)

The `reapOrphanedMatches` / `reapNoShowMatches` pair in `src/liveView.ts`
and `src/noShow.ts` are the correct pattern this scoped update imitates:
update one specific match row to `aborted`, then let the release path
(directly via the reaper, or via `reconcileServers` on next boot) restore
`sv_password` and free the server. Never skip straight to touching
`servers.status` by hand; go through a match-state change and let a
reaper or `reconcileServers` do the release, so the release logic only
ever lives in one place.

**Never run a blanket update.** Do not, under any circumstance, run:

    UPDATE matches SET state='aborted' WHERE state='live'

This has already killed a match the owner had just started, on a previous
occasion. It touches every live match on the box, not just the one that's
broken. Always target a specific match id, exactly as the scoped statement
above does.

After Path A or Path B, confirm the server actually freed:

    sqlite3 data/pug.db "SELECT status FROM servers WHERE id = <server id>;"

Expected: `idle`. If Path B's restart still leaves this non-idle, re-check
that the `UPDATE matches` statement actually ran (`SELECT state FROM matches
WHERE id = <match id>;` should read `aborted`) before assuming
`reconcileServers` itself is broken.

### Two strand modes that are not "the plugin misbehaved"

Both of these pin the box with the plugin behaving perfectly, so neither is
found by staging the old `.smx`. Both now self-heal; the checks below are how
you confirm that rather than what you have to do by hand.

**A match stuck in `configuring`, and nobody can queue.**

    sqlite3 data/pug.db "SELECT id, state, server_id FROM matches WHERE state = 'configuring';"

Symptom in the Discord call: the queue pops, the ready check passes, and then
nothing. No connect button, no error anywhere. Everyone on that roster is also
locked out of re-queueing, because `hasOpenMatch` (`src/matchmaker.ts`) counts
`configuring`, and each later pop mints another one of these and locks out
another eight people.

- `server_id` **not null**: a crash mid-`setupMatch`. Restart `pug-web` once
  srcds answers rcon (see **Before you restart `pug-web`**);
  `reconcileServers` frees the box and the boot drain hands it back. Expect
  the row to read `live` within a few seconds of the restart.
- `server_id` **null**: it is genuinely waiting for a box. Free one (finish or
  roll back whatever owns it) and it drains on the next release. If no match
  owns any box, restart `pug-web` once srcds answers rcon (see **Before you
  restart `pug-web`**): the boot drain is the only thing that pairs
  an already-idle server with an already-waiting match.

Pass condition either way: after the restart, no row remains in `configuring`
for more than a few seconds.

**A match that was played but never reported.**

    journalctl -u pug-web | grep INCIDENT

This is the `MATCH_END`-arrives-but-`sm_pug_dump`-times-out case (match 8,
2026-09-11). It is invisible to both reapers: the plugin keeps heartbeating in
`MS_Ended`, so `reapOrphanedMatches` never sees heartbeat loss, and
`reapNoShowMatches` matches neither rule because those players connected and
rounds were recorded. It used to leave the match `live` and the box `live`
indefinitely, which now means every later queue pop pends behind it.

`finishWithRetry` (`src/server.ts`) retries for about four minutes and then
aborts the match and releases the box through the `ServerReleaser`, logging a
line beginning `[orchestrator] INCIDENT:` with the match id and token.

- Expected after roughly four minutes: match `aborted`, server `idle`,
  `sv_password` back to the standing value from `secrets.cfg`, box empty.
- **The result is lost**: no scores, no rating movement for those eight. Say so
  in the Discord call; it is an incident, not a tidy-up.
- **Recover it from the log, not from the box.** The INCIDENT line carries the
  match's final dump inline, on the lines right after it: `finishWithRetry`
  pulls it one last time before releasing. Feed that body to
  `scripts/recover-match.ts`.

  Do not go and run `sm_pug_dump <token>` yourself; it will answer `PUGERR`.
  The release that follows the INCIDENT line sends `sm_pug_abort` for that
  same token, and the plugin discards its result on that, so the log copy is
  the only one left. If the INCIDENT line says the dump could NOT be collected
  either (the box was unreachable at that moment too), the result really is
  gone for good.

One consequence worth knowing for both paths above: `ServerReleaser.release`
now sends a best-effort `sm_pug_abort` alongside the `sv_password` restore, so
any automatic release also drops the plugin's match. That is why the box stops
heartbeating on its own after a reaper fires, where previously you had to run
`sm_pug_abort` yourself.
