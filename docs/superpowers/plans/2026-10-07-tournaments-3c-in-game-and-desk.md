# Tournaments plan T3c: in-game subs and staff calls, the staff freeze, and the Events desk tools

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A captain on a tournament box can type `!sub <out> <in>` between chapters and have a registered member of the entry take a locked player's place, within the stage's limit, with the swap logged and carried into every later game of the series. A player can type `!admin` and get staff: one call through the existing mod-call path with a new `admin` reason, and the game frozen in a pause that only staff can lift, in game with `!lift` or from the Events desk, which can also freeze a game on its own. The Events desk gains the tools staff were promised in the spec's section 6: act for a team (ready, a veto step, a lineup), reopen the veto before any game started, replay a chapter from its start through the crash-recovery restore path, move the match to another server through the foundation's relocate path, extend the grace to connect, release a hold back to the phase it came from, and see the hold reason, the dispute and the freeze on the desk. Every desk action writes `admin_actions`, one `event_log` row, and a DM to both entries. Nothing is deployed by this plan; production stays behind `competitive_enabled = 'admins'`, and the plugin build is staged on servers by the owner alone.

**Architecture:** The plugin side is one new include, `plugin/pug-tourney.inc` (pug-match 0.3.25), gated on a new cvar `sm_pug_tournament` that the booking runner pushes as 1 on a tournament box and clears with the booking (so a PUG box never sees any of it). It judges "between chapters" itself (it knows the round state to the tick), resolves the two names of a `!sub`, and sends one signed `PUG <token> SUB` line; the site decides who may sub whom and answers with `sm_pug_sub <token> <out> <in>`. `!admin` writes a `PUGCALL reason=admin` line (the mod-call card, with a Match room link) and freezes the game through Rotoblin's own `sm_pause` from a rostered client, unbudgeted like the leave module's pause; a command listener refuses every non-staff `sm_ready`, `sm_r` and `sm_unpause` while the freeze holds, and `PUG <token> ADMINPAUSE` lines tell the site every change so the desk, the room page and the plugin agree. On the site, every state change still goes through `src/events/room.ts` (one `event_log` row each): new mutations for the sub, the freeze flag, the reopened veto, the extended grace, the released hold (a new `hold_from` column remembers the phase a hold came from) and two note-only rows for a replay and a move. The series engine (`src/events/series.ts`) owns the parts that touch the box or the booking: it approves subs, mirrors the freeze, replays a chapter through `restoreSnapshot` (now with a `replayFrom` chapter) and a new `BookingRunner.replayGame`, moves a booking through `beginMove` plus the runner's existing `relocate` and `recover`, and sends the desk's DMs. The desk routes in `src/routes/adminEvents.ts` map each tool to one engine or room call, `logAdmin`, a push and the DM. No new table; three columns on `event_matches`; one new DM type.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Fastify 5, better-sqlite3, vitest (`npm test`, `npx vitest run <file>`), `npm run typecheck` (server and web), `npm run build`; Preact + preact-iso + @testing-library/preact (happy-dom) for the web. SourcePawn 1.12 for `plugin/pug-match.sp` and its includes, compiled with `plugin/build.sh` (wine + the Rotoblin tree's spcomp). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-30-competitive-tournaments-design.md` section 4 (Subs during a match; In-game help), section 6 (Admin tools: replay a chapter or half, move to another server, swap a player, extend grace, reopen the veto, put on or release `admin_hold`; every action writes `admin_actions` and notifies both entries). Foundation spec `docs/superpowers/specs/2026-09-30-competitive-foundation-design.md` section 3 (Player control, Side-locked spectating: a probe comes first) and section 4 (Crash recovery: the restore and the move). Mod calls: `docs/superpowers/specs/2026-09-24-mod-call-design.md` (the PUGCALL line, text last, the card). T3a (`docs/superpowers/plans/2026-10-06-tournaments-3a-match-room.md`, branch `tournaments-t3a`) built the room; T3b (`docs/superpowers/plans/2026-10-07-tournaments-3b-match-servers.md`, branch `tournaments-t3b`) built the series engine this plan extends. Read both ledgers (`.superpowers/sdd/*/progress.md` under each worktree) and T3b's Rulings before this plan's.

**T3b as built (checked against branch `tournaments-t3b` at 3bb2a965, the head that carries its final review wave, 2026-10-07; this plan's snippets follow the code):** `SeriesEngine` (`src/events/series.ts`) takes `SeriesDeps { db, runner: SeriesRunner, notifier?, publicUrl?, push?, registerToken?, now? }` where `SeriesRunner` is `{ announce, settle, onCancelled }`; it exposes `tick`, `gameLines`, `pendingLines`, `ready`, `presence`, `gameStarted`, `ended`, `gameLost`, `gameEnded`, `continueSeries`, `afterPick`, `finalize`, `confirm`, `dispute`, `reset`, `staffResult`, and `hooks()` builds the runner's `TournamentHooks`. `server.ts` builds the runner with `tournament: lateHooks(() => seriesRef)`, then the engine, then `RoomClock` with `series`, and passes `series` to both route plugins, whose `opts.series` is a narrow structural type (widen it, never replace it). `room.ts` has `holdMatch` (`HOLDABLE`), `RESETTABLE`, `resetRoom` (refuses `booking_open` while the booking has no `ending_at`), `resumeDeadline`, the series mutations (`attachBooking` ... `disputeMatch`), `actVeto` (`steamid: null` is the clock, `auto = 1`), `lockLineup` (`steamid: null` with `side` is the clock), `lineupFour` (game 1 carries the series), `seriesGames`, `matchOfBooking`, `sideOf`, `playableOf`, `isParticipant`, `ROOM_LIVE_SQL`. `playViews.ts` owns `RoomPhase`, `phaseOf`, `PlayMatch`, `stagePlayViews(db, ev)` (the public event page and the desk both call it). `roomViews.ts` has `MatchRoomView` with `server`, `series`, `confirm`, `dispute`, `holdReason`. The runner (`src/bookings/runner.ts`) has `gameLines(db, b, server, logAddress?, withSecret?)` pushing `sm_pug_auto_track 0` and `TOURNAMENT_LINES` on a tournament box, `CLEAR_LINES` (ending with `sm_pug_end_kick 1`), a private `push(id, server, lines: () => string[], what)` (the lines are a thunk), `announce(bookingId, text)`, `running(id)` (ready or active, no end started, a box), `hook(id, what, fn)`, `forgetToken(id, token)`, a private `relocate()`, `recover(id)` and `recoverOnce(b, server)` (a `freshBox` set makes it restart a box it just moved to), `giveUp`, `windDown`, `track(id, work)`, `busy`, and a private `boxLacksGame(id, server, pending)` that asks `sm_pug_status` before the minute re-push of a pending game and reads the reply with the pure `boxNeedsGame(body, matchId)` of `tournamentGames.ts`. `pickBox(b)` takes the highest-id idle box in the region that is held by nothing; a booked box stays `idle` in `servers.status` and is held only through the `open_server_holds` view (`bookings.server_id`). `bookings.ts` has `beginRecovery`, `dropBox` (marks the box offline, for a gone box only), `reholdBox` (needs `server_id` null, `waiting_since` and `recovering_at`; it also moves the live game's `matches.server_id`), `finishRecovery`, `recordPresence`, `acceptedPeople`, a private `insertPerson` and a private `logEvent` (exported as `logBookingEvent`), `ok`/`fail` returning `Result<T>`, `PersonRole`, and `close()`, which stamps `ended_at` at once only for a booking with no box and no `waiting_since`. `restore.ts` has `restoreSnapshot(db, matchId)` (a `RestoreSnapshot` with `matchId`, `token`, `campaign`, `firstMap`, `maps`, `map`, `firstSurv`, `roster`, `nextSeq`; `firstMap` falls back to the box's current map only when no map is finished), `resumeLines`, `prepareRestore` (deletes `match_rounds` and `match_live_maps` rows at or past `maps.length`). `match_live_maps` rows need `team_a_score` and `team_b_score` (NOT NULL). `logParse.ts` parses `PUG <token> <VERB> k=v...` lines in a `switch (verb)` and the token-less `PUGCALL` (text last, `MOD_CALL_REASONS`), `PUGBOOK` lines; every line's signature trailer (` lseq=<boot>.<seq> mac=<8 hex>`, what `pug-logauth.inc`'s `PugLog` appends once `sm_pug_log_secret` is pushed) is stripped by `parseLogDatagram` and checked by `src/logAuth.ts` in the listener before dispatch, so a new `PUG` verb emitted through `EmitPug` (which calls `PugLog`) is signed with no parser work. `modCalls.ts` has `REASON_LABELS` and `CATEGORY` (both `Record<ModCallReason, ...>`, so a new reason must be added to both or the typecheck fails) and `handleModCall`; `modCallCard.ts` renders the card. `tests/seriesFixture.ts` builds a room driven to `booking` (the default ban to one on a two-campaign pool: game 1 is no_mercy, Bats survive first, so match team a is Bats and `booking_side_a` is `'b'`), one idle server, the runner on a fake box (`f.sent`, `f.box` with `map`, `humans`, `down`, `marker`, `type` and the plugin model `pug: { state, match }` answering `sm_pug_status`), the engine and the clock on one clock (`f.t`), a `release` fake that sets the box idle at once, with `goLive`, `endGame`, `tick`, `match`, `booking`, `gameOf`, `close`. The plugin: `pug-match.sp` (`PLUGIN_VERSION "0.3.24"`) includes `pug-leave.inc`, `pug-pause.inc`, `pug-modcall.inc`, `pug-staffchat.inc` and `pug-gg.inc` at its very end (lines 5285-5290), so an include may call any function of the .sp and of the includes before it, but may read only globals declared before it; `OnClientSayCommand` lives in `pug-modcall.inc`, calls `StaffChat_OnSay` first and returns `Plugin_Stop` for a line it consumed; `PauseAllowInternal()` lets one `sm_pause` through unbudgeted; `LeaveRotoblinPaused()`, `LeaveUnpauseNow()` (its first line clears `g_bLeavePaused`, then it fakes `sm_ready` from one client a side), `LeaveAnyTeamClient(team)` (0 = either side), `LeaveAnyAbsent()`, `LeaveNameOf(slot, out, maxlen)` (a connected client's name, else the name they left with, else the SteamID64: never empty), `LeaveTracking()` (false while `sm_pug_leave_budget` is 0, which `TOURNAMENT_LINES` pushes on every tournament box, so the leave module never pauses or clocks anyone there), `InReadyUp()`, `TokenArgOk(args)`, `RosterIndexOfId(id)`, `ModCall_AuthId(client, id, maxlen)`, `ModCall_TriggerEnd(text, trigger)` (the index after the trigger, or -1), `SanitizeChat(text, maxlen)`, `EmitPug` (returns at once while `g_State == MS_None`, else `PugLog("PUG %s %s", g_sToken, body)`), `PugLog` (signs the line), `RoundMs()` exist; `g_sRosterId` is `[MAX_ROSTER][32]`, `g_iRosterTeam` is 1 for pug team a and 2 for b, `MAX_ROSTER` is 12; the pause clock (`pug-pause.inc` `PauseClockTick`) charges a new pause to `g_iPausePendingTeam` unless `g_bLeavePaused`, and runs its ceiling only for owner 1 or 2; Rotoblin's pause module (`rotoblin.pause.sp`) registers `sm_pause`, `sm_unpause`, `sm_r`, `sm_ready` with `RegConsoleCmd` (so an `AddCommandListener` runs first), refuses `sm_pause` from the server and during a ready-up, and its `forcepause`/`forceunpause` are admin-only chat commands the site cannot drive. `plugin/README.md` has no version history: versions are noted per row ("0.3.x and later") in its RCON commands and Cvars tables. **T3b's final review wave is committed as 3bb2a965** (pug-match 0.3.24 with `sm_pug_end_kick`; `TOURNAMENT_LINES` = `['sm_pug_leave_budget 0', 'sm_pug_end_kick 0']` in `tournamentGames.ts`, pushed in the booking lines and at the head of every game burst; `CLEAR_LINES` ending with `sm_pug_end_kick 1`; the runner's `boxLacksGame` asking `sm_pug_status` before a pending re-push; `isUnstartedGame` and `gameLines` re-pushing an unstarted game; `handleAbandon` refusing any booked game; `SeriesEngine.sweepAborted` in `tick`, holding a connect or live match whose linked, unended game's row is `aborted` as `game_aborted` once; `gameEnded` recording the game of a held match (`recordGame` with `held: true`) and moving the series no further; the DQ route calling `staffResult` for each open room; the fixture's `box.pug` model). Branch `tournaments-t3c` from that commit; where this plan's snippets and the code disagree, the code wins.

## Global Constraints

- Team events only (`entry_kind = 'team'`).
- Every write to `event_matches` stays in `src/events/play.ts` and `src/events/room.ts`; every write to `event_games`, `event_vetoes`, `event_lineups` and the two prefs tables stays in `src/events/room.ts`. Each mutation is one transaction writing exactly one `event_log` row on success and nothing on refusal (`tests/eventLogGuard.test.ts`). The series engine and the routes never write those tables themselves.
- Every write to the four booking tables stays in `src/bookings/bookings.ts` (one `booking_events` row per change). The exception stays as in T3b: `matches` and `match_players` rows of a tournament game are written by `src/bookings/tournamentGames.ts` and, in this plan, the sub's `match_players` row by the series engine through the same helper file.
- The plugin never decides who may sub or who is staff on the site's behalf: it forwards a signed line and acts on the site's answer (`sm_pug_sub`, `sm_pug_adminpause`), the same split as `!allow` and PUGBOOK. The one judgement it keeps is "between chapters", which only it can make.
- Compiled plugins are staged on servers only by the owner, later. This plan never stages, restarts, rcons or otherwise touches a live box or `/home/volence/l4d1-ds`; the implementer may run `plugin/build.sh` to prove the plugin compiles (it writes only into the Rotoblin scripting tree and `plugin/`), and reports the `.smx` as built, not deployed.
- Connect details (host, port, password) reach only the booking's accepted people and staff; the new DM type carries none. A sub joins the booking's people with the role the swap gives them and is already on the allowlist (a registered member of the entry is a booking spectator since T3b Ruling 2).
- Lineups stay secret until both are locked (T3a); a sub happens only after both are, in `connect` or `live`.
- Tournament games never move SR (`src/rating.ts` refuses `kind != 'pug'`).
- Never write em dashes in code, comments, copy, commits or docs.
- Commit messages follow the repo style (a plain sentence). Do not push. Do not deploy.
- Several Claude sessions use `/home/volence/l4d/pug`: work in a worktree branch (`tournaments-t3c`, made with superpowers:using-git-worktrees, branched from `tournaments-t3b` at or after the commit that lands its final review wave, see the as-built paragraph). Run `npm ci` inside the worktree (never symlink `node_modules`). Check `git reflog -10` and `git status` before any write on master.

## Rulings this plan makes (for the owner to confirm)

1. **Scope (owner, 2026-10-07).** T3c is in-game `!sub` between chapters, in-game `!admin` with a staff-only freeze, staff freeze and unfreeze from the desk, and the desk tools: act for a team, reopen the veto, replay a chapter, move server, extend grace, release a hold, and the hold reason, dispute and freeze shown on the desk. Side-locked spectating is out (Not in this plan).
2. **A tournament box knows it is one.** `TOURNAMENT_LINES` (`src/bookings/tournamentGames.ts`, from T3b's final review wave) gains `sm_pug_tournament 1`, so a tournament booking's booking lines and every game burst carry it, and `CLEAR_LINES` sets it back to 0, so the plugin's `!sub`, `!admin`, `!lift` and the freeze exist only there. A PUG box, with the cvar at its default 0, behaves exactly as today (`!admin` still opens SourceMod's admin menu for admins and says "no access" to everyone else).
3. **"Between chapters" is the plugin's call.** A `!sub` is taken when the match is still pending its first round, when the current map's first half has not gone live yet (the ready-up before a chapter), or when its second half has ended (the map is about to change); it is refused during a live half, during a pause and at half time, with one chat line. The site does not second-guess the timing.
4. **Who may sub whom.** `by` must be a captain or co-captain of the entry whose locked four holds `out` (`N.managersOf`); `in` must be a starter or sub of that entry (never the coach), not already in the four; each side may make at most `subs.perMatch` subs per match (the stage's rules snapshot, `MatchRules.subs.perMatch`, default 2 and added to the three templates; `parseRules` defaults it to 2 when a stored ruleset or snapshot predates the field, so nothing re-saves; `src/rulesetStore.ts`'s `EditableRules` is an `Omit` of `MatchRules` and so carries it too: `readEditableRules` reads it when sent and `updateRuleset` keeps a ruleset's stored value when the editor, which has no field for it yet, sends none). Subs are counted from the match's `player_subbed` log rows per side. Refusals are said on the box as `[Match] Sub refused: <the site's sentence>`.
5. **What a sub changes.** The game-1 `event_lineups` row is rewritten with `in` for `out` (T3b Ruling 6: game 1 carries the series, so every later game is rostered with the sub); the `event_log` keeps who replaced whom, in which game, and the count; the booking's people swap roles (`in` becomes `player`, `out` becomes `spectator`, so `present_now` counts the right four and `out` may stay and watch); a `match_players` row for `in` is inserted (`source = 'web'`, `joined_map` = maps finished so far) so the dump's STAT line finds a roster row; and the plugin is sent `sm_pug_sub <token> <out> <in>` plus a chat line. On the plugin, `out`'s slot keeps its stats and is marked out: the team lock stops placing them and moves them to spectators whenever they sit on a side, the leave clock forgets them (a safeguard only: `TOURNAMENT_LINES` pushes `sm_pug_leave_budget 0`, so on a tournament box the leave module tracks nobody), `!gg` neither counts them nor lets them start a vote, and the roster watchdog ignores them; `in` gets a new slot (or their old one back) on `out`'s team with `joined_map` = the maps finished so far, and the lock places them within two seconds. The plugin sends no `MATCH_ROSTER` line for the new slot: the site already wrote the sub's `match_players` row itself. No DM for a sub: the room push and the chat lines cover it.
6. **Names in `!sub`.** `out` is matched by name against the team's rostered players: a connected one by their current name, a disconnected one by the name the leave module saw them leave with (`g_sLeaveName`), a unique substring match as `!allow` does; `in` must be connected (a sub connects as a spectator first, then the captain types the sub). More than one match or none is a chat refusal naming the problem.
7. **`!admin`.** On a tournament box a non-staff player's `!admin [why]`, `/admin [why]` (and the `sm_admin` these map to) sends one `PUGCALL ... reason=admin target=none text=<why>` line through the mod-call path: no menus, the same 180 s per-account cooldown as `/mod`, no ticket (`CATEGORY.admin = null`, like `broke`), the card titled "In-game call: Tournament: admin needed" with a new **Match room** link button when the game is a tournament game. Then the plugin freezes the game (Ruling 8) and says so in chat. Staff in game are not caught (their `!admin` is still the admin menu); staff freeze from the desk. "Staff" on the box is one check everywhere in the module, `Tourney_IsStaff(client)` = `CheckCommandAccess(client, "sm_pug_lift", ADMFLAG_GENERIC)`, the same access `sm_pug_lift` itself needs (website admins hold SourceMod root on every box through the generated admins.cfg).
8. **The freeze.** The plugin pauses through Rotoblin's own `sm_pause` from a rostered client with `PauseAllowInternal()`, so the pause is unbudgeted and has no ceiling (pug-pause.inc charges nobody: owner 0), exactly as the leave module's disconnect pause. While the freeze holds, a non-staff client's `sm_ready`, `sm_r` and `sm_unpause` are refused with "Staff froze the game. Only staff can lift it (!lift in game, or the Events desk)"; staff (`Tourney_IsStaff`) keep theirs. If `!admin` lands during a ready-up, between rounds or at a map change, the freeze is applied one second after the next go-live instead (`OnRoundIsLive`, in its `MS_Live` branch), and the flag holds meanwhile. A pause already in place (a team's or the leave module's) is simply held. The pause clock (`pug-pause.inc`) treats a pause begun under the freeze as nobody's (owner 0, no `PAUSE` line, nothing charged, no ceiling), and runs no ceiling at all while the freeze holds, so a team's own pause held by the freeze cannot run out under it. Lifting it: staff in game type `!lift` (or `sm_pug_lift`, `ADMFLAG_GENERIC`), or the desk sends `sm_pug_adminpause <token> off`; the plugin then unpauses through the both-teams-ready path (`LeaveUnpauseNow`) unless the leave module is still waiting for a dropped player (never on a tournament box, where its budget is 0; kept so the module is right on a box where it is not), in which case that module unpauses when they are back. Any match reset or abort (`ResetMatchState`, `sm_pug_abort`) lifts the freeze first so a box is never left paused.
9. **The site mirrors the freeze from signed lines.** Every change emits `PUG <token> ADMINPAUSE state=on|off by=<steamid|site> cause=call|staff|reset`; the engine sets or clears `event_matches.admin_pause_at`/`admin_pause_by` through `room.ts` (`match_frozen` / `match_unfrozen` log rows, idempotent), pushes the room, and on `cause=call` posts a feed alert linking the room (the Discord card is the mod-call poster's). The desk's Freeze and Unfreeze buttons send `sm_pug_adminpause <token> on|off "<staff name>"` and set the column on the `PUGOK` reply; the plugin's own ADMINPAUSE line then arrives and is a no-op. `PHASE` and `HEARTBEAT` lines carry `admin=1` while the freeze holds (parsed into `Phase.admin`); the pause ledger is otherwise untouched (a `team` of null already reads as an admin pause).
10. **Act for a team.** The desk may press Ready, take the pending veto step, or lock a lineup as either team. Each goes through the same `room.ts` mutation as the captain's own action with a `staff: { by, side }` argument: the actor logged is the admin, `auto = 0` (the room page shows no "(automatic)"), `locked_by` is the admin, and the veto step must be the side's turn (`not_your_turn` otherwise). A veto step on a live match hands on to `afterPick` as the captain's route does.
11. **Reopen the veto.** Allowed while no game has a `matches` row (no `event_games.match_id`), from `veto` (both ready), `lineup`, `booking`, or an `admin_hold` taken from one of those: the veto, game and lineup rows are deleted, the match goes back to `veto` with both ready flags kept and the first step's deadline (or straight to `lineup` when no step is a person's), and a booking made meanwhile is cancelled first by the engine, as a reset does. A game already pushed to a box is refused with the new `game_started` key, checked before the phase so a connect or live match answers it too: reset the room or enter a result instead.
12. **Replay a chapter.** On a live game only, on the same box: the desk picks a chapter from the list the view offers (the chapters this game has played or is playing, the finale excluded as `restore.ts` already refuses it); the engine builds `restoreSnapshot(db, gameMatchId, { replayFrom: ordinal })` (the earlier chapters' scores kept, that chapter and anything after it dropped), and the runner sends `sm_pug_abort <token>`, the `sm_pug_resume` burst and a `changelevel` to that chapter, verifies the map and re-pushes the booking and game lines. The site's `matches` row stays live under the same token; `prepareRestore` deletes the dropped chapters' rows only once the plugin answered `PUGOK resumed`. If the plugin does not take the resume, the game is aborted as `server_lost` and the match held (`game_lost`), as crash recovery does. "Replay a half" is not in this plan (Not in this plan: the plugin restores whole maps only, and the engine score cannot be seeded for one half).
13. **Move server.** The foundation's relocate path, driven by hand: `beginMove` puts the booking into recovery with no box (`recover_reason = 'gone'`, `waiting_since` now; the old box is NOT marked offline, it goes back to the pool through the releaser's forced restart), the runner's `relocate()` takes the first idle box in the region at once, `recover()` restarts it, replays setup and restores the live game from `match_rounds` (`booking_recovered` DM with the new connect line, `moved: true`), and the engine logs `server_moved`. With no idle box the booking waits as after a crash and is given up after `booking_recover_wait_minutes`, which holds the match (`booking_server_lost`); the desk text says so. Allowed in `connect` and `live` with a running booking that has a box and is not already recovering.
14. **Extend grace.** In `connect` only, 1 to 60 whole minutes added to the deadline (from now if it has already passed); logged with the minutes; said on the box.
15. **Release a hold.** A new `event_matches.hold_from` records the status a hold came from (`holdMatch` from any `HOLDABLE` status; a dispute from `confirming`). Release puts the match back there with a fresh full-length deadline for that phase: the ready check (`readyMinutes`) or the veto step (`stepSeconds`) for `veto`, `lineupMinutes` for `lineup`, none for `booking`, the booking's grace from now for `connect`, the step length for `live` when a pick is open else none, and `confirmMinutes` for `confirming`. The dispute columns are cleared (kept in the log row). Refused with the new `hold_not_releasable` key when `hold_from` is null (a hold from before this plan, or one whose match was corrected since) or when the phase needs a box (`connect`, `live`, `confirming`) and the match's booking is no longer running: staff reset the room or enter the result then. Releasing a `no_show_both` hold restarts the grace; a side still short at its end is held again.
16. **Desk view.** `stagePlayViews(db, ev, { staff: true })` adds a `desk` object to each `PlayMatch` (`holdReason`, `dispute`, `frozen`, `graceEndsAt`, `booking` state and server name, `liveGame` with its replayable chapters); the public event page keeps calling it without the flag and gets no `desk`, so a dispute reason never reaches a public page except the room page, where T3b already shows it to everyone (unchanged).
17. **One DM type for every desk action.** `event_match_staff` goes to both rosters (starters, subs, coach) after each desk action with one plain sentence ("staff pressed Ready for Rats", "staff had chapter 3 replayed from its start", "staff moved the match to another server; a new connect line follows", ...), linking the room. Players turn it off like the others. In-game `!sub` and `!admin` send no DM.
18. **Audit.** Every desk route: `logAdmin` (`event_act_for_team`, `event_veto_reopen`, `event_chapter_replay`, `event_server_move`, `event_grace_extend`, `event_hold_release`, `event_freeze`, `event_unfreeze`), the mutation's own `event_log` row, `rooms.pushChange`, the DM. Admins only (mods read).
19. **Errors.** New keys in `validate.ts`: `game_started`, `hold_not_releasable`, `not_in_lineup`, `sub_not_member`, `sub_limit`, `bad_minutes`, `no_live_game`, `chapter_not_replayable`, `no_box`, `replay_failed`, `not_frozen`, `already_frozen`, `bad_side`.
20. **Plugin version and files.** `pug-match.sp` 0.3.24 (T3b's final review wave: `sm_pug_end_kick`) -> 0.3.25 with the new `pug-tourney.inc` (included last) and small hooks in the .sp, `pug-leave.inc`, `pug-pause.inc`, `pug-modcall.inc` and `pug-gg.inc`; `plugin/build.sh` copies the new include; `plugin/README.md` gets table rows ("0.3.25 and later") for the two new RCON commands and the new cvar, since it keeps no version history. `l4d_booking.sp` is not changed (its `!allow` and allowlist already cover the sub).

## Not in this plan (and why)

- **Side-locked spectating.** The foundation spec (section 3, Side-locked spectating) requires a probe on the local server with the owner's own game client first (camera lock, the half-time swap, the ghost filter on a spectator); until that probe is done and written up, nothing here builds on it. Tournament games stay `participants` with ordinary spectating.
- **Replay a half.** `sm_pug_resume_map` takes finished maps only and `!setscores` never writes the engine score (pug-match 0.3.18 notes), so a half cannot be restored; the desk offers chapters.
- **A desk "swap a player" tool.** The owner scoped subs to the in-game command; the lineup half of "act for a team" covers a lineup that was never locked, not one in play.
- **Editing `subs.perMatch` in the Rulesets editor.** The parser default and the templates carry it; a stage snapshot may set another value by hand. The editor field is a one-line follow-up; until then the web's `MatchRules` mirror (`web/src/api.ts`) is left without the field (the web never reads it), and `updateRuleset` keeps a ruleset's stored value when the editor sends none.
- **Casters' relay password for tournament boxes, the public delayed live viewer, windows and reschedules, Discord channel posts:** foundation and rollout plans 4 and 5, unchanged.
- **Staff freezing from inside the game.** Rotoblin's own `!forcepause` already exists for admins; it is not mirrored to the site. Staff who want the site to know use the desk.

## Review Focus

- **The freeze can never strand a box paused.** `Tourney_Reset` (from `ResetMatchState`) and the top of `Cmd_Abort` lift the freeze before anything else; `LeaveUnpauseNow` refuses only while the flag is set; the listener lets the module's own fake `sm_ready` through (`g_bTourneyInternal`). Task 5 reads every unpause path.
- **A sub that the plugin took but the site refused, or the reverse.** The plugin changes nothing on a `!sub` (it only emits the line); the site writes its rows first and sends `sm_pug_sub` after. A lost command is not re-sent by the minute re-push: Task 6 sends the sub burst with a `PUGOK sub` check and says a line when the box did not take it, so a captain types the `!sub` again; the lineup rows are then already swapped, the engine recognises the recorded sub and re-sends the command instead of refusing, and the plugin command is idempotent (`in` already rostered on `out`'s team with `out` marked out answers `PUGOK sub already`). Task 6 tests the retry.
- **Replay a chapter on a game the plugin no longer runs.** `sm_pug_abort` succeeds even when the plugin had no match; the resume burst's last reply decides. If it is not `PUGOK resumed` the game is aborted (`server_lost`) and the match held, never left half-restored. Task 4 tests both replies.
- **A move with no box free.** `beginMove` must leave the booking in exactly the shape `relocate()` and `giveUp()` expect (`waiting_since`, `recovering_at`, `server_id` null) so the existing wait and give-up apply unchanged. Task 3 and Task 7 test the wait.
- **A released hold and a stale deadline.** `releaseHold` always writes a fresh deadline for the phase and the clock's `expireOne` re-reads the row, so a hold released a minute after its old deadline cannot be forfeited on the same tick. Task 2 tests each `hold_from`.

---

## File map

| File | Responsibility |
|---|---|
| `src/rulesets.ts`, `src/rulesetStore.ts` | `MatchRules.subs.perMatch` (default 2, templates); `readEditableRules` and `unratedRules` carry it, `updateRuleset` keeps the stored value when none is sent. |
| `src/logParse.ts` | `admin` mod-call reason; `SUB` and `ADMINPAUSE` verbs; `Phase.admin`. |
| `src/modCalls.ts`, `src/discord/modCallCard.ts` | The `admin` reason's label and category; the Match room link on the card. |
| `src/db.ts` | `event_matches.hold_from`, `admin_pause_at`, `admin_pause_by`. |
| `src/events/validate.ts` | New error keys. |
| `src/events/play.ts` | `MatchRow` new columns. |
| `src/events/room.ts` | `subPlayer`, `subsUsed`, `setAdminPause`, `reopenVeto`, `extendGrace`, `releaseHold`, `noteReplay`, `noteMove`; `staff` on `readyUp`, `actVeto`, `lockLineup`; `hold_from` on `holdMatch` and `disputeMatch`; `resetRoom` clears the new columns. |
| `src/events/playViews.ts`, `src/events/roomViews.ts` | `PlayMatch.desk` (staff only); `MatchRoomView.frozen`. |
| `src/bookings/bookings.ts` | `swapPlayer`, `beginMove`. |
| `src/bookings/restore.ts` | `restoreSnapshot(db, matchId, { replayFrom })`. |
| `src/bookings/tournamentGames.ts` | `addTournamentSub` (the sub's `match_players` row). |
| `src/bookings/runner.ts` | `sm_pug_tournament` line and `CLEAR_LINES`; `send`, `replayGame`, `moveBooking`. |
| `src/events/series.ts` | `subRequested`, `adminPauseLine`, `freeze`, `replayable`, `replayChapter`, `moveServer`, `extendGrace`, `releaseHold`, `reopenVeto`; `SeriesRunner` widened. |
| `src/events/messages.ts`, `src/events/notices.ts`, `src/notify/notify.ts` | The `event_match_staff` DM. |
| `src/routes/adminEvents.ts` | The desk routes. |
| `src/server.ts` | Dispatches `sub_request` and `admin_pause` lines to the engine. |
| `plugin/pug-tourney.inc` (new), `plugin/pug-match.sp`, `plugin/pug-leave.inc`, `plugin/pug-pause.inc`, `plugin/pug-modcall.inc`, `plugin/build.sh` | `!sub`, `!admin`, `!lift`, the freeze, `sm_pug_sub`, `sm_pug_adminpause`, `sm_pug_tournament`; version 0.3.25. |
| `tests/seriesFixture.ts` | `line()` feeds a plugin line to the engine the way `server.ts` does; `liveGame()`. |
| `web/src/api.ts`, `web/src/routes/admin/events/PlayPanel.tsx`, `web/src/routes/event/room/ServerPanel.tsx`, `web/src/styles/app.css` (and the six test builders of `MatchRoomView`: `EventMatch.test.tsx`, `ServerPanel.test.tsx`, `LineupPanel.test.tsx`, `VetoBoard.test.tsx`, `ConfirmPanel.test.tsx`, `roomText.test.ts`) | The desk tools and the desk fields; the frozen line on the room page. |

---
### Task 1: Rules, the log grammar and the staff call reason

**Files:**
- Modify: `src/rulesets.ts`, `src/rulesetStore.ts`, `src/logParse.ts`, `src/modCalls.ts`, `src/discord/modCallCard.ts`
- Test: `tests/rulesets.test.ts`, `tests/logParse.test.ts`, `tests/modCallParse.test.ts`, `tests/modCalls.test.ts`, `tests/modCallPoster.test.ts`

**Interfaces:**
- Consumes: `MatchRules`, `parseRules`, `TEMPLATES`, the file's `fail(field)` thrower (`src/rulesets.ts`); `EditableRules` (an `Omit<MatchRules, 'rated' | 'penalties'>`), `readEditableRules`, `unratedRules`, `updateRuleset`, `rulesOf`, `whole` (`src/rulesetStore.ts`); `parseLogDatagram`, `LogEvent`, `MOD_CALL_REASONS`, `Phase`, `phaseOf(state, rest)`, `kv`, `intOf`, `steamId64Of` (`src/logParse.ts`, the last imported from `./steamId.js`); `REASON_LABELS`, `CATEGORY` (file-private), `handleModCall` (`src/modCalls.ts`); `renderModCallCard`, `handlerLabel` (`src/discord/modCallCard.ts`).
- Produces:
  - `MatchRules.subs: { perMatch: number }`; `parseRules` reads `subs.perMatch` (an integer 0 to 4) and defaults `{ perMatch: 2 }` when `subs` is absent; every `TEMPLATES` entry carries `subs: { perMatch: 2 }`.
  - `src/rulesetStore.ts`: `readEditableRules` returns `subs` too (read and range-checked when the body carries `subs`, `{ perMatch: 2 }` when it does not; a bad value is `bad_rules`); `unratedRules` copies `e.subs`; `updateRuleset` keeps the row's stored `subs` when the request body has none, so the editor (no field yet) never resets a value set by hand.
  - `MOD_CALL_REASONS` gains `'admin'`.
  - `LogEvent` gains `{ kind: 'sub_request'; token: string; by: string; out: string; in: string; map: number }` (verb `SUB`) and `{ kind: 'admin_pause'; token: string; on: boolean; by: string | null; cause: 'call' | 'staff' | 'reset' }` (verb `ADMINPAUSE`).
  - `Phase.admin?: boolean` (`admin=1` on a paused PHASE or HEARTBEAT).
  - `REASON_LABELS.admin = 'Tournament: admin needed'`; `CATEGORY.admin = null`; `handleModCall` forces `target_kind = 'none'` for `admin` as it does for `broke`.
  - `roomLinkFor(db, matchId: number | null): string | null` in `modCallCard.ts`: the room path of the event match whose `event_games.match_id` is this game, or null; the card gets a `{ kind: 'link', label: 'Match room', url }` button after Replay moment when it is not null.

- [ ] **Step 1: Write the failing tests**

Append to `tests/rulesets.test.ts` (inside `describe('rulesets')`):

```ts
  it('reads subs.perMatch and defaults it to 2 for rules saved before the field (plan T3c)', () => {
    const old = JSON.stringify({ ...TEMPLATES['Standard Cup'], subs: undefined });
    expect(parseRules(old).subs).toEqual({ perMatch: 2 });
    expect(parseRules(JSON.stringify({ ...TEMPLATES['Standard Cup'], subs: { perMatch: 1 } })).subs).toEqual({ perMatch: 1 });
    expect(() => parseRules(JSON.stringify({ ...TEMPLATES['Standard Cup'], subs: { perMatch: 9 } }))).toThrow('invalid rules: subs.perMatch');
    expect(() => parseRules(JSON.stringify({ ...TEMPLATES['Standard Cup'], subs: { perMatch: 'two' } }))).toThrow('invalid rules: subs.perMatch');
    for (const t of Object.values(TEMPLATES)) expect(t.subs).toEqual({ perMatch: 2 });
  });
```

Append to `tests/logParse.test.ts` (inside `describe('parseLogDatagram')`; `TOKEN` and `framed` exist):

```ts
  it('parses a SUB request and an ADMINPAUSE change (plan T3c)', () => {
    const P = '76561199048276493';
    const Q = '76561199122132251';
    const BY = '76561199000000801';
    expect(parseLogDatagram(framed(`PUG ${TOKEN} SUB by=${BY} out=${P} in=${Q} map=2`)))
      .toEqual({ kind: 'sub_request', token: TOKEN, by: BY, out: P, in: Q, map: 2 });
    expect(parseLogDatagram(framed(`PUG ${TOKEN} SUB by=${BY} out=${P} in=nobody map=2`))).toBeNull();
    expect(parseLogDatagram(framed(`PUG ${TOKEN} SUB by=${BY} out=${P} in=${Q} map=x`))).toBeNull();
    expect(parseLogDatagram(framed(`PUG ${TOKEN} ADMINPAUSE state=on by=${BY} cause=call`)))
      .toEqual({ kind: 'admin_pause', token: TOKEN, on: true, by: BY, cause: 'call' });
    expect(parseLogDatagram(framed(`PUG ${TOKEN} ADMINPAUSE state=off by=site cause=staff`)))
      .toEqual({ kind: 'admin_pause', token: TOKEN, on: false, by: null, cause: 'staff' });
    expect(parseLogDatagram(framed(`PUG ${TOKEN} ADMINPAUSE state=off by=site cause=whatever`)))
      .toEqual({ kind: 'admin_pause', token: TOKEN, on: false, by: null, cause: 'staff' });
    expect(parseLogDatagram(framed(`PUG ${TOKEN} ADMINPAUSE state=maybe by=site cause=call`))).toBeNull();
  });

  it('reads admin=1 on a paused phase (plan T3c)', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} PHASE state=paused team=0 limit=0 leave=0 admin=1`));
    expect(ev).toMatchObject({ kind: 'phase', phase: { state: 'paused', team: null, admin: true } });
    const plain = parseLogDatagram(framed(`PUG ${TOKEN} PHASE state=paused team=1 limit=120 leave=0`));
    expect(plain).toMatchObject({ kind: 'phase', phase: { state: 'paused', team: 'a' } });
    expect((plain as { phase: { admin?: boolean } }).phase.admin).toBeUndefined();
  });
```

Append to `tests/modCallParse.test.ts` (inside `describe('PUGCALL parsing')`; `P`, `full`, `parse` exist):

```ts
  it('reads the admin reason of a tournament box call (plan T3c)', () => {
    expect(parse(full().replace('reason=cheating', 'reason=admin').replace(`target=${T}`, 'target=none'))).toMatchObject({ reason: 'admin', target: 'none', steamid: P });
  });
```

Append to `tests/modCalls.test.ts` (inside `describe('handleModCall')`; `call`, `db`, `IDS` exist):

```ts
  it('stores an admin call with no ticket and no target, folding a second one within the window (plan T3c)', () => {
    const row = call({ reason: 'admin', target: IDS[5], text: 'the tank is stuck' });
    expect(row).toMatchObject({ reason: 'admin', target_kind: 'none', target_steamid: null, ticket_id: null, pinged: 1, post_state: 'pending' });
    expect(db.prepare('SELECT COUNT(*) n FROM ticket_reports').get()).toEqual({ n: 0 });
    const again = call({ reason: 'admin', target: 'none', steamid: IDS[1] }, 60_000);
    expect(again.folded_into).toBe(row.id);
  });
```

Append to `tests/modCallPoster.test.ts` (inside `describe('ModCallPoster')`; `call`, `db`, `matchId`, `inAdmin`, `poster`, `renderModCallCard` exist):

```ts
  it('titles an admin call and links the match room when the game is a tournament game (plan T3c)', async () => {
    // The NOT NULL columns of events and event_stages as src/db.ts declares them (checked 2026-10-07); the JSON blobs are never read by the card.
    const eventId = Number(db.prepare(
      `INSERT INTO events (slug, name, organizer_steamid, entry_kind, status, starts_at, eligibility_json, checkin_json, roster_json, created_at, updated_at)
       VALUES ('cup', 'Cup', ?, 'team', 'live', '2026-10-10T20:00:00.000Z', '{}', '{}', '{}', '2026-10-01', '2026-10-01')`,
    ).run(IDS[7]).lastInsertRowid);
    const stageId = Number(db.prepare(
      `INSERT INTO event_stages (event_id, ordinal, type, config_json, ruleset_id, campaign_pool_json, veto_type, scheduling, status, created_at, updated_at)
       VALUES (?, 1, 'swiss', '{}', 1, '[]', 'ban_to_one', 'rolling', 'live', '2026-10-01', '2026-10-01')`,
    ).run(eventId).lastInsertRowid);
    const emId = Number(db.prepare("INSERT INTO event_matches (event_id, stage_id, round, slot, status, created_at) VALUES (?, ?, 1, 1, 'live', '2026-10-01')").run(eventId, stageId).lastInsertRowid);
    db.prepare("INSERT INTO event_games (event_match_id, ordinal, campaign, match_id, created_at) VALUES (?, 1, 'no_mercy', ?, '2026-10-01')").run(emId, matchId);
    call({ reason: 'admin', target: 'none', text: 'need a ref' }); await poster.idle();
    const card = renderModCallCard(db, getModCall(db, 1)!, 'https://pug.test');
    expect(card.embeds[0]!.title).toBe('In-game call: Tournament: admin needed');
    expect(card.components[0]).toContainEqual({ kind: 'link', label: 'Match room', url: `https://pug.test/event/cup/match/${emId}` });
  });
```

(`ruleset_id` 1 is the first seeded template; `events.organizer_steamid` references `players`, which is why IDS[7] is used. If the insert still fights the schema, build the rows through `tests/roomFixture.ts`'s `roomFixture()` instead and link `matchId` to its game 1 with `R.linkGame`.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/rulesets.test.ts tests/logParse.test.ts tests/modCallParse.test.ts tests/modCalls.test.ts tests/modCallPoster.test.ts`
Expected: FAIL (`subs` undefined, the SUB and ADMINPAUSE lines parse to null, `admin` is refused by the parser, no Match room button).

- [ ] **Step 3: rulesets.ts**

In `MatchRules` add, after `spectate`:

```ts
  /** Tournaments plan T3c: substitutions a side may make per match (in-game !sub between chapters). */
  subs: { perMatch: number };
```

Add `subs: { perMatch: 2 },` to each of the three `TEMPLATES` entries after their `spectate` line. In `parseRules`, after the `spectate` check and before the `return`:

```ts
  // Tournaments plan T3c. Absent in every ruleset and stage snapshot saved
  // before the field existed: read as the default rather than failing them.
  let subsPerMatch = 2;
  if (r.subs !== undefined) {
    if (typeof r.subs !== 'object' || r.subs === null) fail('subs');
    const subs = r.subs as Record<string, unknown>;
    if (!Number.isInteger(subs.perMatch) || (subs.perMatch as number) < 0 || (subs.perMatch as number) > 4) fail('subs.perMatch');
    subsPerMatch = subs.perMatch as number;
  }
```

and `subs: { perMatch: subsPerMatch },` in the returned object. (`fail` is the file's existing thrower: `throw new Error(\`invalid rules: ${field}\`)`.)

In `src/rulesetStore.ts` (`EditableRules` is `Omit<MatchRules, 'rated' | 'penalties'>`, so it now carries `subs` and the typecheck fails until these three follow): in `readEditableRules`, before the `return ok({...})`:

```ts
  // Tournaments plan T3c: the editor has no field for subs yet, so a body
  // without them reads as the default; one with them is range-checked.
  const subs = r.subs as Record<string, unknown> | null | undefined;
  if (subs !== undefined && (typeof subs !== 'object' || subs === null || !whole(subs.perMatch, 0, 4))) return fail('bad_rules');
```

and `subs: { perMatch: subs ? (subs.perMatch as number) : 2 },` in the returned object; in `unratedRules`, `subs: e.subs,` after `spectate: e.spectate`; in `updateRuleset`, the read becomes

```ts
    // A body without subs keeps the ruleset's stored value (the editor sends none, plan T3c).
    const stored = rulesOf(row)?.subs;
    const body = typeof o.rules === 'object' && o.rules !== null && !('subs' in o.rules) && stored ? { ...(o.rules as object), subs: stored } : o.rules;
    const edited = readEditableRules(body);
```

(`rulesOf` and `whole` are the file's own helpers.) `createRuleset` copies through `parseRules`, which fills the default, so it needs nothing.

- [ ] **Step 4: logParse.ts**

`MOD_CALL_REASONS` becomes `['cheating', 'toxicity', 'griefing', 'afk', 'english', 'broke', 'other', 'admin'] as const` (update its comment: `admin` is a tournament box's `!admin`). Add to `Phase`:

```ts
  /** The staff freeze of a tournament box holds this pause (pug-match 0.3.25, plan T3c). */
  admin?: boolean;
```

In `phaseOf`, after the `by` line: `if (state === 'paused' && rest.admin === '1') phase.admin = true;`.

Add to the `LogEvent` union, next to `gg`:

```ts
  /** A captain's !sub on a tournament box (pug-match 0.3.25, plan T3c): the
   *  plugin resolved the names and judged the moment; the site decides. */
  | { kind: 'sub_request'; token: string; by: string; out: string; in: string; map: number }
  /** The staff freeze of a tournament box changed (plan T3c). by is null for
   *  the site's own command. */
  | { kind: 'admin_pause'; token: string; on: boolean; by: string | null; cause: 'call' | 'staff' | 'reset' }
```

In `parseLogDatagram`'s `switch (verb)`, after the `ABANDON` case:

```ts
    case 'SUB': {
      const by = steamId64Of(rest.by ?? '');
      const out = steamId64Of(rest.out ?? '');
      const inId = steamId64Of(rest.in ?? '');
      const map = intOf(rest.map);
      if (!by || !out || !inId || map === null || map < 0) return null;
      return { kind: 'sub_request', token, by, out, in: inId, map };
    }
    case 'ADMINPAUSE': {
      if (rest.state !== 'on' && rest.state !== 'off') return null;
      const by = rest.by === 'site' || rest.by === undefined ? null : steamId64Of(rest.by);
      if (rest.by !== undefined && rest.by !== 'site' && !by) return null;
      const cause = rest.cause === 'call' || rest.cause === 'reset' ? rest.cause : 'staff';
      return { kind: 'admin_pause', token, on: rest.state === 'on', by, cause };
    }
```

- [ ] **Step 5: modCalls.ts and the card**

`REASON_LABELS` gains `admin: 'Tournament: admin needed'`; `CATEGORY` gains `admin: null`. In `handleModCall`, the target line becomes:

```ts
  // `broke` is about the server and `admin` (a tournament box's !admin,
  // plan T3c) about the match: whoever the line named is not the subject.
  const targetKind: ModCallRow['target_kind'] = ev.reason === 'broke' || ev.reason === 'admin'
    ? 'none'
    : ev.target === 'team' || ev.target === 'general' || ev.target === 'none' ? ev.target : 'player';
```

In `src/discord/modCallCard.ts` add, after `handlerLabel`:

```ts
/** The match room of the tournament match this game belongs to (plan T3c),
 *  or null for any other game. The path only; the caller adds publicUrl. */
export function roomLinkFor(db: DB, matchId: number | null): string | null {
  if (matchId === null) return null;
  const row = db.prepare(
    `SELECT e.slug AS slug, m.id AS id FROM event_games g
       JOIN event_matches m ON m.id = g.event_match_id JOIN events e ON e.id = m.event_id
      WHERE g.match_id = ? LIMIT 1`,
  ).get(matchId) as { slug: string; id: number } | undefined;
  return row ? `/event/${row.slug}/match/${row.id}` : null;
}
```

and in `renderModCallCard`, right after the Replay moment button is pushed (before the Ticket button):

```ts
  const room = roomLinkFor(db, call.match_id);
  if (room) row.push({ kind: 'link', label: 'Match room', url: `${publicUrl}${room}` });
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/rulesets.test.ts tests/logParse.test.ts tests/modCallParse.test.ts tests/modCalls.test.ts tests/modCallPoster.test.ts tests/adminRulesetRoutes.test.ts tests/rulesetStore.test.ts`
Expected: PASS (the ruleset editor tests still pass: a saved body without `subs` keeps the stored value and a copied ruleset gets the default through `parseRules`). Then `npm run typecheck` (server) clean: `REASON_LABELS` and `CATEGORY` are `Record<ModCallReason, ...>`, so both must carry `admin`.

- [ ] **Step 7: Commit**

```bash
git add src/rulesets.ts src/rulesetStore.ts src/logParse.ts src/modCalls.ts src/discord/modCallCard.ts tests/rulesets.test.ts tests/logParse.test.ts tests/modCallParse.test.ts tests/modCalls.test.ts tests/modCallPoster.test.ts
git commit -m "Tournaments T3c: rules carry subs per match, the log grammar reads SUB and ADMINPAUSE lines, and an admin call has its own reason with a match room link on the card"
```

---
### Task 2: Schema, the room writer's new mutations, and the views

**Files:**
- Modify: `src/db.ts` (the `ensureColumn` block after the T3b lines 1874-1887), `src/events/validate.ts` (error keys), `src/events/play.ts` (`MatchRow`), `src/events/room.ts`, `src/events/playViews.ts`, `src/events/roomViews.ts`, `src/bookings/restore.ts` (`replayableChapters` only; the `replayFrom` option itself is Task 3, so this task adds the export with a one-line body that Task 3 completes, see Step 5)
- Test: `tests/eventsSchema.test.ts`, `tests/room.test.ts`, `tests/eventLogGuard.test.ts` (the `ROOM_MUTATIONS` and `ROOM_READS` lists), `tests/roomViews.test.ts`

**Interfaces:**
- Consumes: T3b `room.ts` (`liveMatch`, `advance`, `roomState`, `lineupsOf`, `playableOf`, `gamesOf`, `HOLDABLE`, `plus`, `iso`), `N.managersOf`, `N.getEntry`, `E.logEvent`, `isHumanStep`.
- Produces columns: `event_matches.hold_from TEXT`, `admin_pause_at TEXT`, `admin_pause_by TEXT`.
- Produces in `play.ts`: `MatchRow` gains `hold_from: MatchStatus | null; admin_pause_at: string | null; admin_pause_by: string | null`.
- Produces in `validate.ts`: the keys of Ruling 19.
- Produces in `room.ts`:
  - `interface StaffAct { by: string; side: Side }`; `readyUp(db, { matchId, steamid: string | null, staff?: StaffAct, timers, now? })`, `actVeto(db, { ..., staff?: StaffAct })`, `lockLineup(db, { ..., staff?: StaffAct })` (Ruling 10).
  - `GRACE_EXTEND_MAX = 60`.
  - reads: `subsUsed(db, m: P.MatchRow, side: Side): number`.
  - mutations (each one `event_log` row): `subPlayer(db, { matchId, by, outId, inId, limit, gameId: number | null, now? }): V.Checked<{ m: P.MatchRow; side: Side; entryId: number; four: string[]; used: number }>` (`player_subbed`); `setAdminPause(db, { matchId, on: boolean, by: string | null, cause: 'call' | 'staff' | 'reset', now? })` (`match_frozen` / `match_unfrozen`); `reopenVeto(db, { matchId, by, timers, now? })` (`veto_reopened`); `extendGrace(db, { matchId, by, minutes: unknown, now? })` (`grace_extended`); `releaseHold(db, { matchId, by, timers, graceMinutes, now? })` (`hold_released`); `noteReplay(db, { matchId, by, gameId, ordinal, map, now? })` (`chapter_replayed`); `noteMove(db, { matchId, by, fromServerId, now? })` (`server_moved`).
  - `holdMatch` writes `hold_from = <the status held>`; `disputeMatch` writes `hold_from = 'confirming'`; `resetRoom` clears the three new columns.
- Produces in `playViews.ts`: `interface PlayMatchDesk { holdReason: string | null; holdFrom: string | null; dispute: { side: 'a' | 'b'; byName: string; reason: string; at: string } | null; frozen: boolean; graceEndsAt: string | null; booking: { id: number; state: string; serverName: string | null; recovering: boolean } | null; liveGame: { matchId: number; campaign: string; chapters: { ordinal: number; map: string }[] } | null; subs: { a: number; b: number } }`; `PlayMatch.desk?: PlayMatchDesk`; `stagePlayViews(db, ev, opts: { staff?: boolean } = {})` fills `desk` only with `staff: true` (Ruling 16).
- Produces in `roomViews.ts`: `MatchRoomView.frozen: boolean`.
- Produces in `restore.ts`: `replayableChapters(db, matchId): { ordinal: number; map: string }[]`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/eventsSchema.test.ts`:

```ts
  it('has the hold origin and the staff freeze columns (plan T3c)', () => {
    const db = openDb(':memory:');
    const cols = (db.prepare('PRAGMA table_info(event_matches)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['hold_from', 'admin_pause_at', 'admin_pause_by']));
  });
```

Append to `tests/room.test.ts` (it has `at`, `ok`, `open`, `lastAction`, `bothReady`, `veto`, `toBooking` (T3b), `game`; `fakeBooking`, `fakeMatch`, `TIMERS`, `A`, `B`, `ADMIN` are imported):

```ts
describe('staff act for a team (plan T3c)', () => {
  it('readies, takes the veto step and locks a lineup as a team, logged as the admin and never automatic', async () => {
    const f = await roomFixture();
    open(f);
    expect(R.readyUp(f.db, { matchId: f.matchId, steamid: null, timers: TIMERS, now: at(1) })).toEqual({ ok: false, error: 'bad_request' });
    ok(R.readyUp(f.db, { matchId: f.matchId, steamid: null, staff: { by: ADMIN, side: 'a' }, timers: TIMERS, now: at(1) }));
    expect(lastAction(f)).toEqual({ action: 'room_ready', actor: ADMIN });
    ok(R.readyUp(f.db, { matchId: f.matchId, steamid: B[0]!, timers: TIMERS, now: at(1) }));
    expect(R.actVeto(f.db, { matchId: f.matchId, steamid: null, staff: { by: ADMIN, side: 'b' }, step: 0, action: 'first', campaign: null, timers: TIMERS, now: at(2) })).toEqual({ ok: false, error: 'not_your_turn' });
    ok(R.actVeto(f.db, { matchId: f.matchId, steamid: null, staff: { by: ADMIN, side: 'a' }, step: 0, action: 'first', campaign: null, timers: TIMERS, now: at(2) }));
    expect(f.db.prepare('SELECT by_steamid, auto FROM event_vetoes WHERE event_match_id = ? AND step = 0').get(f.matchId)).toEqual({ by_steamid: ADMIN, auto: 0 });
    ok(R.actVeto(f.db, { matchId: f.matchId, steamid: A[0]!, step: 1, action: 'ban', campaign: 'dead_air', timers: TIMERS, now: at(2) }));
    ok(R.actVeto(f.db, { matchId: f.matchId, steamid: B[0]!, step: 2, action: 'survivors', campaign: null, timers: TIMERS, now: at(2) }));
    const m = ok(R.lockLineup(f.db, { matchId: f.matchId, steamid: null, staff: { by: ADMIN, side: 'b' }, steamids: B.slice(0, 4), timers: TIMERS, now: at(4) }));
    expect(m.status).toBe('lineup');
    expect(R.lineupsOf(f.db, f.matchId).map((l) => [l.entry_id, l.locked_by, l.auto])).toEqual([[f.entryB, ADMIN, 0]]);
    expect(lastAction(f)).toEqual({ action: 'lineup_locked', actor: ADMIN });
  });
});

describe('subs (plan T3c)', () => {
  const live = async () => {
    const f = await toBooking();
    ok(R.attachBooking(f.db, { matchId: f.matchId, bookingId: fakeBooking(f, at(5)), now: at(5) }));
    ok(R.startConnect(f.db, { matchId: f.matchId, graceMinutes: 15, now: at(5) }));
    ok(R.linkGame(f.db, { matchId: f.matchId, gameId: game(f, 1).id, gameMatchId: fakeMatch(f), now: at(6) }));
    ok(R.startLive(f.db, { matchId: f.matchId, now: at(7) }));
    return f;
  };
  it('swaps a locked player for a registered member of the entry, counted per side against the limit', async () => {
    const f = await live();
    const sub = (by: string, outId: string, inId: string, limit = 2) => R.subPlayer(f.db, { matchId: f.matchId, by, outId, inId, limit, gameId: game(f, 1).id, now: at(20) });
    expect(sub(B[0]!, A[3]!, A[4]!)).toEqual({ ok: false, error: 'not_manager' });
    expect(sub(A[0]!, A[4]!, A[3]!)).toEqual({ ok: false, error: 'not_in_lineup' });
    expect(sub(A[0]!, A[3]!, B[4]!)).toEqual({ ok: false, error: 'sub_not_member' });
    expect(sub(A[0]!, A[3]!, A[2]!)).toEqual({ ok: false, error: 'sub_not_member' });
    expect(sub(A[0]!, A[3]!, A[4]!, 0)).toEqual({ ok: false, error: 'sub_limit' });
    const r = ok(sub(A[1]!, A[3]!, A[4]!));
    expect(r).toMatchObject({ side: 'a', entryId: f.entryA, four: [A[0], A[1], A[2], A[4]], used: 1 });
    expect(R.lineupFour(f.db, f.matchId, f.entryA)).toEqual([A[0], A[1], A[2], A[4]]);
    expect(lastAction(f)).toEqual({ action: 'player_subbed', actor: A[1] });
    expect(R.subsUsed(f.db, P.getMatch(f.db, f.matchId)!, 'a')).toBe(1);
    expect(R.subsUsed(f.db, P.getMatch(f.db, f.matchId)!, 'b')).toBe(0);
    // The replaced player is a registered member: they may come back as a sub, within the limit.
    expect(sub(A[0]!, A[4]!, A[3]!, 1)).toEqual({ ok: false, error: 'sub_limit' });
    expect(ok(sub(A[0]!, A[4]!, A[3]!, 2)).used).toBe(2);
  });

  it('freezes and unfreezes a live match once each way, from a call or staff', async () => {
    const f = await live();
    expect(R.setAdminPause(f.db, { matchId: f.matchId, on: false, by: null, cause: 'staff', now: at(8) })).toEqual({ ok: false, error: 'not_frozen' });
    const m = ok(R.setAdminPause(f.db, { matchId: f.matchId, on: true, by: A[2]!, cause: 'call', now: at(8) }));
    expect(m).toMatchObject({ admin_pause_at: at(8).toISOString(), admin_pause_by: A[2] });
    expect(lastAction(f)).toEqual({ action: 'match_frozen', actor: A[2] });
    expect(R.setAdminPause(f.db, { matchId: f.matchId, on: true, by: ADMIN, cause: 'staff', now: at(9) })).toEqual({ ok: false, error: 'already_frozen' });
    expect(ok(R.setAdminPause(f.db, { matchId: f.matchId, on: false, by: ADMIN, cause: 'staff', now: at(9) })).admin_pause_at).toBeNull();
    expect(lastAction(f)).toEqual({ action: 'match_unfrozen', actor: ADMIN });
  });
});

describe('desk tools on the room (plan T3c)', () => {
  it('extends the grace to connect by whole minutes from the later of now and the deadline', async () => {
    const f = await toBooking();
    ok(R.attachBooking(f.db, { matchId: f.matchId, bookingId: fakeBooking(f, at(5)), now: at(5) }));
    expect(R.extendGrace(f.db, { matchId: f.matchId, by: ADMIN, minutes: 5, now: at(5) })).toEqual({ ok: false, error: 'not_connect_phase' });
    ok(R.startConnect(f.db, { matchId: f.matchId, graceMinutes: 15, now: at(5) }));
    for (const bad of [0, 61, 2.5, '5', null]) expect(R.extendGrace(f.db, { matchId: f.matchId, by: ADMIN, minutes: bad, now: at(6) })).toEqual({ ok: false, error: 'bad_minutes' });
    expect(ok(R.extendGrace(f.db, { matchId: f.matchId, by: ADMIN, minutes: 5, now: at(6) })).deadline).toBe(at(25).toISOString());
    expect(ok(R.extendGrace(f.db, { matchId: f.matchId, by: ADMIN, minutes: 10, now: at(40) })).deadline).toBe(at(50).toISOString());
    expect(lastAction(f)).toEqual({ action: 'grace_extended', actor: ADMIN });
  });

  it('remembers where a hold came from and releases it there with a fresh deadline', async () => {
    const f = await roomFixture();
    open(f);
    ok(R.holdMatch(f.db, { matchId: f.matchId, by: ADMIN, reason: 'Checking', now: at(3) }));
    expect(P.getMatch(f.db, f.matchId)).toMatchObject({ status: 'admin_hold', hold_from: 'veto' });
    expect(R.extendGrace(f.db, { matchId: f.matchId, by: ADMIN, minutes: 5, now: at(4) })).toEqual({ ok: false, error: 'not_connect_phase' });
    const back = ok(R.releaseHold(f.db, { matchId: f.matchId, by: ADMIN, timers: TIMERS, graceMinutes: 15, now: at(30) }));
    expect(back).toMatchObject({ status: 'veto', hold_reason: null, hold_from: null, deadline: at(40).toISOString() });
    expect(lastAction(f)).toEqual({ action: 'hold_released', actor: ADMIN });
    expect(R.releaseHold(f.db, { matchId: f.matchId, by: ADMIN, timers: TIMERS, graceMinutes: 15, now: at(31) })).toEqual({ ok: false, error: 'not_held' });
    // A veto step: the step length again.
    bothReady(f);
    ok(R.holdMatch(f.db, { matchId: f.matchId, by: ADMIN, reason: 'Checking', now: at(35) }));
    expect(ok(R.releaseHold(f.db, { matchId: f.matchId, by: ADMIN, timers: TIMERS, graceMinutes: 15, now: at(36) })).deadline).toBe(new Date(at(36).getTime() + 60_000).toISOString());
    // A hold whose origin is unknown is not releasable.
    ok(R.holdMatch(f.db, { matchId: f.matchId, by: ADMIN, reason: 'Checking', now: at(37) }));
    f.db.prepare('UPDATE event_matches SET hold_from = NULL WHERE id = ?').run(f.matchId);
    expect(R.releaseHold(f.db, { matchId: f.matchId, by: ADMIN, timers: TIMERS, graceMinutes: 15, now: at(38) })).toEqual({ ok: false, error: 'hold_not_releasable' });
  });

  it('releases a connect hold to a fresh grace only while the booking runs, and a dispute hold back to a fresh confirm window', async () => {
    const f = await toBooking();
    const bookingId = fakeBooking(f, at(5));
    ok(R.attachBooking(f.db, { matchId: f.matchId, bookingId, now: at(5) }));
    ok(R.startConnect(f.db, { matchId: f.matchId, graceMinutes: 15, now: at(5) }));
    ok(R.holdMatch(f.db, { matchId: f.matchId, by: null, reason: 'no_show_both', now: at(20) }));
    // fakeBooking rows are 'scheduled': not running.
    expect(R.releaseHold(f.db, { matchId: f.matchId, by: ADMIN, timers: TIMERS, graceMinutes: 15, now: at(21) })).toEqual({ ok: false, error: 'hold_not_releasable' });
    f.db.prepare("UPDATE bookings SET state = 'active' WHERE id = ?").run(bookingId);
    expect(ok(R.releaseHold(f.db, { matchId: f.matchId, by: ADMIN, timers: TIMERS, graceMinutes: 10, now: at(21) }))).toMatchObject({ status: 'connect', deadline: at(31).toISOString() });
    ok(R.linkGame(f.db, { matchId: f.matchId, gameId: game(f, 1).id, gameMatchId: fakeMatch(f), now: at(22) }));
    ok(R.startLive(f.db, { matchId: f.matchId, now: at(23) }));
    ok(R.recordGame(f.db, { matchId: f.matchId, gameId: game(f, 1).id, scoreA: 400, scoreB: 900, forfeit: null, now: at(60) }));
    ok(R.startConfirm(f.db, { matchId: f.matchId, timers: TIMERS, now: at(61) }));
    ok(R.disputeMatch(f.db, { matchId: f.matchId, steamid: A[0]!, reason: 'They had five', now: at(62) }));
    expect(P.getMatch(f.db, f.matchId)).toMatchObject({ status: 'admin_hold', hold_reason: 'dispute', hold_from: 'confirming', dispute_side: 'a' });
    const back = ok(R.releaseHold(f.db, { matchId: f.matchId, by: ADMIN, timers: TIMERS, graceMinutes: 15, now: at(70) }));
    expect(back).toMatchObject({ status: 'confirming', deadline: at(85).toISOString(), dispute_side: null, dispute_reason: null, hold_from: null });
    const row = f.db.prepare("SELECT detail FROM event_log WHERE action = 'hold_released' ORDER BY id DESC LIMIT 1").get() as { detail: string };
    expect(JSON.parse(row.detail)).toMatchObject({ to: 'confirming', reason: 'dispute', dispute: { side: 'a', by: A[0], reason: 'They had five' } });
  });

  it('reopens the veto before any game started, keeping both ready, and refuses once a game was pushed', async () => {
    const f = await roomFixture();
    bothReady(f);
    ok(veto(f, A[0]!, 0, 'first'));
    ok(veto(f, A[0]!, 1, 'ban', 'dead_air'));
    const m = ok(R.reopenVeto(f.db, { matchId: f.matchId, by: ADMIN, timers: TIMERS, now: at(5) }));
    expect(m).toMatchObject({ status: 'veto', deadline: new Date(at(5).getTime() + 60_000).toISOString() });
    expect(m.ready_a_at).not.toBeNull();
    expect(R.vetoActions(f.db, f.matchId)).toEqual([]);
    expect(R.gamesOf(f.db, f.matchId)).toEqual([]);
    expect(lastAction(f)).toEqual({ action: 'veto_reopened', actor: ADMIN });
    // From a hold taken in the lineup phase too.
    ok(veto(f, A[0]!, 0, 'first', null, 6));
    ok(veto(f, A[0]!, 1, 'ban', 'dead_air', 6));
    ok(veto(f, B[0]!, 2, 'survivors', null, 6));
    ok(R.holdMatch(f.db, { matchId: f.matchId, by: ADMIN, reason: 'Checking', now: at(7) }));
    expect(ok(R.reopenVeto(f.db, { matchId: f.matchId, by: ADMIN, timers: TIMERS, now: at(8) })).status).toBe('veto');
    // A pushed game closes the door.
    const g = await toBooking();
    ok(R.attachBooking(g.db, { matchId: g.matchId, bookingId: fakeBooking(g, at(5)), now: at(5) }));
    expect(R.reopenVeto(g.db, { matchId: g.matchId, by: ADMIN, timers: TIMERS, now: at(6) })).toEqual({ ok: false, error: 'booking_open' });
    g.db.prepare("UPDATE bookings SET ending_at = ?").run(at(6).toISOString());
    ok(R.linkGame(g.db, { matchId: g.matchId, gameId: game(g, 1).id, gameMatchId: fakeMatch(g), now: at(6) }));
    expect(R.reopenVeto(g.db, { matchId: g.matchId, by: ADMIN, timers: TIMERS, now: at(7) })).toEqual({ ok: false, error: 'game_started' });
  });

  it('notes a replay and a move with one log row each', async () => {
    const f = await toBooking();
    ok(R.attachBooking(f.db, { matchId: f.matchId, bookingId: fakeBooking(f, at(5)), now: at(5) }));
    ok(R.startConnect(f.db, { matchId: f.matchId, graceMinutes: 15, now: at(5) }));
    expect(R.noteReplay(f.db, { matchId: f.matchId, by: ADMIN, gameId: game(f, 1).id, ordinal: 1, map: 'l4d_vs_hospital02_subway', now: at(6) })).toEqual({ ok: false, error: 'not_live_phase' });
    expect(ok(R.noteMove(f.db, { matchId: f.matchId, by: ADMIN, fromServerId: 3, now: at(6) })).status).toBe('connect');
    expect(lastAction(f)).toEqual({ action: 'server_moved', actor: ADMIN });
    ok(R.linkGame(f.db, { matchId: f.matchId, gameId: game(f, 1).id, gameMatchId: fakeMatch(f), now: at(6) }));
    ok(R.startLive(f.db, { matchId: f.matchId, now: at(7) }));
    ok(R.noteReplay(f.db, { matchId: f.matchId, by: ADMIN, gameId: game(f, 1).id, ordinal: 1, map: 'l4d_vs_hospital02_subway', now: at(8) }));
    expect(lastAction(f)).toEqual({ action: 'chapter_replayed', actor: ADMIN });
  });
});
```

In `tests/eventLogGuard.test.ts`, add `'subsUsed'` to `ROOM_READS` and these entries to `ROOM_MUTATIONS` (the file has `connecting`, `linked`, `playing`, `confirming`, `bothReady`, `toLineups`, `driveToBooking`, `fakeBooking`, `fakeMatch`, `game1`, `must`, `ADMIN`, `A`, `B`, `TIMERS`):

```ts
      subPlayer: {
        action: 'player_subbed', actor: A[0]!, setup: playing,
        run: (f) => R.subPlayer(f.db, { matchId: f.matchId, by: A[0]!, outId: A[3]!, inId: A[4]!, limit: 2, gameId: game1(f).id, now: at(20) }),
      },
      setAdminPause: { action: 'match_frozen', actor: ADMIN, setup: playing, run: (f) => R.setAdminPause(f.db, { matchId: f.matchId, on: true, by: ADMIN, cause: 'staff', now: at(20) }) },
      reopenVeto: { action: 'veto_reopened', actor: ADMIN, setup: toLineups, run: (f) => R.reopenVeto(f.db, { matchId: f.matchId, by: ADMIN, timers: TIMERS, now: at(5) }) },
      extendGrace: { action: 'grace_extended', actor: ADMIN, setup: connecting, run: (f) => R.extendGrace(f.db, { matchId: f.matchId, by: ADMIN, minutes: 5, now: at(6) }) },
      releaseHold: {
        action: 'hold_released', actor: ADMIN,
        setup: (f) => { open(f); must(R.holdMatch(f.db, { matchId: f.matchId, by: ADMIN, reason: 'Checking', now: at(3) })); },
        run: (f) => R.releaseHold(f.db, { matchId: f.matchId, by: ADMIN, timers: TIMERS, graceMinutes: 15, now: at(4) }),
      },
      noteReplay: {
        action: 'chapter_replayed', actor: ADMIN, setup: playing,
        run: (f) => R.noteReplay(f.db, { matchId: f.matchId, by: ADMIN, gameId: game1(f).id, ordinal: 1, map: 'l4d_vs_hospital02_subway', now: at(20) }),
      },
      noteMove: { action: 'server_moved', actor: ADMIN, setup: connecting, run: (f) => R.noteMove(f.db, { matchId: f.matchId, by: ADMIN, fromServerId: 1, now: at(6) }) },
```

(In the guard's room describe, `open(f)` opens the room, `bothReady`, `toLineups`, `connecting`, `linked`, `playing`, `confirming` drive it on, `game1(f)` is game 1's row and `must` unwraps; the guard enumerates only the exported functions of `room.ts`, so the new `GRACE_EXTEND_MAX` constant and the `StaffAct` type need no listing.)

Append to `tests/roomViews.test.ts`:

```ts
  it('says when staff froze the game (plan T3c)', async () => {
    const f = await seriesFixture();
    await f.tick();
    f.goLive(f.gameOf(1).match_id!);
    expect(view(f, null).frozen).toBe(false);
    R.setAdminPause(f.db, { matchId: f.matchId, on: true, by: A[0], cause: 'call', now: at(20) });
    expect(view(f, A[3]).frozen).toBe(true);
    f.close();
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/eventsSchema.test.ts tests/room.test.ts tests/eventLogGuard.test.ts tests/roomViews.test.ts`
Expected: FAIL (missing columns, `R.subPlayer` and friends are not functions, `frozen` undefined).

- [ ] **Step 3: Schema, error keys, MatchRow**

In `src/db.ts`, after the T3b `ensureColumn` lines for `event_games`:

```ts
  // Tournaments plan T3c: where a hold came from (releaseHold puts the match
  // back there) and the staff freeze mirrored from the box.
  ensureColumn(db, 'event_matches', 'hold_from', 'TEXT');
  ensureColumn(db, 'event_matches', 'admin_pause_at', 'TEXT');
  ensureColumn(db, 'event_matches', 'admin_pause_by', 'TEXT');
```

In `src/events/validate.ts` `EVENT_ERRORS`, after `already_confirmed`:

```ts
  game_started: { status: 409, text: 'A game of this match was already sent to a server; reset the room or enter the result instead.' },
  hold_not_releasable: { status: 409, text: 'This hold cannot be released to where it came from (the server is gone, or the hold predates release). Reset the room or enter the result.' },
  not_held: { status: 409, text: 'This match is not on hold.' },
  not_in_lineup: { status: 400, text: 'That player is not in a locked lineup of this match.' },
  sub_not_member: { status: 400, text: 'A sub must be a starter or sub of the same entry who is not already playing.' },
  sub_limit: { status: 409, text: 'That team has used every substitution the rules allow for this match.' },
  bad_minutes: { status: 400, text: 'Minutes is a whole number from 1 to 60.' },
  no_live_game: { status: 409, text: 'No game of this match is being played right now.' },
  chapter_not_replayable: { status: 409, text: 'That chapter cannot be replayed (the finale, or a chapter this game has not reached).' },
  no_box: { status: 409, text: 'This match has no running server to send that to.' },
  replay_failed: { status: 502, text: 'The server did not take the replay. The game was aborted and the match is on hold.' },
  not_frozen: { status: 409, text: 'The game is not frozen.' },
  already_frozen: { status: 409, text: 'The game is already frozen.' },
  bad_side: { status: 400, text: 'A side is a or b.' },
```

In `src/events/play.ts` `MatchRow`, after `disputed_at`:

```ts
  /** Plan T3c: the status a hold came from, and the staff freeze mirrored from the box. */
  hold_from: MatchStatus | null; admin_pause_at: string | null; admin_pause_by: string | null;
```

- [ ] **Step 4: room.ts**

Add after `RoomTimers`:

```ts
/** Staff acting for a team on the Events desk (plan T3c Ruling 10): the
 *  side taken and the admin logged as actor; never automatic. */
export interface StaffAct { by: string; side: Side }
/** The most an extended grace adds at once, in minutes (Ruling 14). */
export const GRACE_EXTEND_MAX = 60;
```

`readyUp` becomes:

```ts
export function readyUp(db: DB, o: { matchId: number; steamid: string | null; staff?: StaffAct; timers: RoomTimers; now?: Date }): V.Checked<P.MatchRow> {
  const now = o.now ?? new Date();
  const at = iso(now);
  if (o.steamid === null && !o.staff) return V.fail('bad_request');
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (m.status !== 'veto' || (m.ready_a_at !== null && m.ready_b_at !== null)) return V.fail('not_ready_phase');
    if (m.deadline !== null && at >= m.deadline) return V.fail('room_closed');
    const side = o.staff ? o.staff.side : sideOf(db, m, o.steamid!);
    if (!side) return V.fail('not_manager');
    if ((side === 'a' ? m.ready_a_at : m.ready_b_at) !== null) return V.fail('already_ready');
    db.prepare(`UPDATE event_matches SET ${side === 'a' ? 'ready_a_at' : 'ready_b_at'} = ? WHERE id = ?`).run(at, m.id);
    if ((side === 'a' ? m.ready_b_at : m.ready_a_at) !== null) advance(db, m.id, o.timers, now);
    const actor = o.staff ? o.staff.by : o.steamid;
    E.logEvent(db, ev.id, actor, 'room_ready', at, { matchId: m.id, side, ...(o.staff ? { staff: true } : {}) });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}
```

`holdMatch`'s UPDATE becomes `"UPDATE event_matches SET status = 'admin_hold', hold_reason = ?, hold_from = ?, deadline = NULL WHERE id = ?"` run with `(reason, m.status, m.id)`. `disputeMatch`'s UPDATE adds `hold_from = 'confirming',` after `hold_reason = 'dispute',`. `resetRoom`'s UPDATE adds `hold_from = NULL, admin_pause_at = NULL, admin_pause_by = NULL,` after `hold_reason = NULL,`.

`actVeto`'s signature gains `staff?: StaffAct` and its side block becomes:

```ts
    let side: Side;
    if (o.staff) {
      // Staff act as a team (Ruling 10): the step must be that team's.
      if (o.staff.side !== st.next.by) return V.fail('not_your_turn');
      side = o.staff.side;
    } else if (o.steamid === null) {
      side = st.next.by;
    } else {
      const s = sideOf(db, m, o.steamid);
      if (!s) return V.fail('not_manager');
      side = s;
    }
```

then `const actor = o.staff ? o.staff.by : o.steamid;`, the action is `{ side, action: ..., campaign: ..., auto: o.steamid === null && !o.staff }`, the INSERT's `by_steamid` is `actor`, and the log call logs `actor` with `{ ..., auto: a.auto, ...(o.staff ? { staff: true } : {}) }`.

`lockLineup`'s signature gains `staff?: StaffAct`; its side line becomes `const side = o.staff ? o.staff.side : o.steamid === null ? o.side ?? null : sideOf(db, m, o.steamid);`, the INSERT runs with `locked_by = o.staff ? o.staff.by : o.steamid` and `auto = o.steamid === null && !o.staff ? 1 : 0`, and the log actor is `o.staff ? o.staff.by : o.steamid` with `auto` the same boolean and `...(o.staff ? { staff: true } : {})`.

Add after `disputeMatch`:

```ts
// ---------- subs, the freeze and the desk tools (plan T3c) ----------

const SUB_PHASES: ReadonlySet<P.MatchStatus> = new Set<P.MatchStatus>(['connect', 'live']);
/** Phases that need a running box: a hold from them is released only while the booking runs (Ruling 15). */
const BOX_PHASES: ReadonlySet<P.MatchStatus> = new Set<P.MatchStatus>(['connect', 'live', 'confirming']);
const REOPENABLE: ReadonlySet<P.MatchStatus> = new Set<P.MatchStatus>(['veto', 'lineup', 'booking']);

/** Subs a side has made in this match: its player_subbed log rows (Ruling 4). */
export function subsUsed(db: DB, m: P.MatchRow, side: Side): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM event_log WHERE event_id = ? AND action = 'player_subbed'
       AND json_extract(detail, '$.matchId') = ? AND json_extract(detail, '$.side') = ?`,
  ).get(m.event_id, m.id, side) as { n: number }).n;
}

/** Ruling 5: a captain or co-captain swaps one of their locked four for a
 *  starter or sub of the entry, within `limit`; the game-1 lineup row is
 *  rewritten so every later game follows. The engine does the booking,
 *  matches and plugin halves around this. */
export function subPlayer(
  db: DB, o: { matchId: number; by: string; outId: string; inId: string; limit: number; gameId: number | null; now?: Date },
): V.Checked<{ m: P.MatchRow; side: Side; entryId: number; four: string[]; used: number }> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<{ m: P.MatchRow; side: Side; entryId: number; four: string[]; used: number }> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (!SUB_PHASES.has(m.status)) return V.fail('not_live_phase');
    const row = lineupsOf(db, m.id).find((l) => l.game === 1 && (JSON.parse(l.steamids) as string[]).includes(o.outId));
    if (!row) return V.fail('not_in_lineup');
    const side: Side = row.entry_id === m.entry_a ? 'a' : 'b';
    const entry = N.getEntry(db, row.entry_id)!;
    if (!N.managersOf(db, entry.team_id).includes(o.by)) return V.fail('not_manager');
    const four = JSON.parse(row.steamids) as string[];
    if (!playableOf(db, entry.id).includes(o.inId) || four.includes(o.inId)) return V.fail('sub_not_member');
    const used = subsUsed(db, m, side);
    if (used >= o.limit) return V.fail('sub_limit');
    const next = four.map((s) => (s === o.outId ? o.inId : s));
    db.prepare('UPDATE event_lineups SET steamids = ? WHERE id = ?').run(JSON.stringify(next), row.id);
    E.logEvent(db, ev.id, o.by, 'player_subbed', at, { matchId: m.id, side, out: o.outId, in: o.inId, gameId: o.gameId, used: used + 1, limit: o.limit });
    return V.ok({ m: P.getMatch(db, m.id)!, side, entryId: entry.id, four: next, used: used + 1 });
  })();
}

/** Ruling 9: the staff freeze as the box reports it (or as the desk sent it). Idempotent each way. */
export function setAdminPause(
  db: DB, o: { matchId: number; on: boolean; by: string | null; cause: 'call' | 'staff' | 'reset'; now?: Date },
): V.Checked<P.MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (!SUB_PHASES.has(m.status)) return V.fail('not_live_phase');
    if (o.on === (m.admin_pause_at !== null)) return V.fail(o.on ? 'already_frozen' : 'not_frozen');
    db.prepare('UPDATE event_matches SET admin_pause_at = ?, admin_pause_by = ? WHERE id = ?').run(o.on ? at : null, o.on ? o.by : null, m.id);
    E.logEvent(db, ev.id, o.by, o.on ? 'match_frozen' : 'match_unfrozen', at, { matchId: m.id, cause: o.cause });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

/** Ruling 11: back to the first veto step, both ready flags kept, before any
 *  game was pushed. A booking made meanwhile must already be ending (the
 *  engine cancels it first, as a reset does). */
export function reopenVeto(db: DB, o: { matchId: number; by: string; timers: RoomTimers; now?: Date }): V.Checked<P.MatchRow> {
  const now = o.now ?? new Date();
  const at = iso(now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    // A game on a box closes the door whatever the phase (Ruling 11): checked first, so a connect or live match says why.
    if (gamesOf(db, m.id).some((g) => g.match_id !== null)) return V.fail('game_started');
    const from = m.status === 'admin_hold' ? m.hold_from : m.status;
    if (from === null || !REOPENABLE.has(from)) return V.fail('wrong_status');
    if (m.ready_a_at === null || m.ready_b_at === null) return V.fail('not_ready_phase');
    if (m.booking_id !== null) {
      const b = db.prepare('SELECT ending_at FROM bookings WHERE id = ?').get(m.booking_id) as { ending_at: string | null } | undefined;
      if (b && b.ending_at === null) return V.fail('booking_open');
    }
    db.prepare('DELETE FROM event_vetoes WHERE event_match_id = ?').run(m.id);
    db.prepare('DELETE FROM event_games WHERE event_match_id = ?').run(m.id);
    db.prepare('DELETE FROM event_lineups WHERE event_match_id = ?').run(m.id);
    db.prepare(
      `UPDATE event_matches SET status = 'veto', deadline = NULL, hold_reason = NULL, hold_from = NULL, booking_id = NULL, booked_at = NULL,
         server_alerted_at = NULL, admin_pause_at = NULL, admin_pause_by = NULL WHERE id = ?`,
    ).run(m.id);
    // The first step's deadline, or straight to lineups when no step is a person's (as readyUp does).
    advance(db, m.id, o.timers, now);
    E.logEvent(db, ev.id, o.by, 'veto_reopened', at, { matchId: m.id, from });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

/** Ruling 14: more time to connect, from the later of now and the deadline. */
export function extendGrace(db: DB, o: { matchId: number; by: string; minutes: unknown; now?: Date }): V.Checked<P.MatchRow> {
  const now = o.now ?? new Date();
  const at = iso(now);
  if (!Number.isInteger(o.minutes) || (o.minutes as number) < 1 || (o.minutes as number) > GRACE_EXTEND_MAX) return V.fail('bad_minutes');
  const minutes = o.minutes as number;
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (m.status !== 'connect') return V.fail('not_connect_phase');
    const base = m.deadline !== null && m.deadline > at ? new Date(m.deadline) : now;
    const deadline = plus(base, minutes * 60_000);
    db.prepare('UPDATE event_matches SET deadline = ? WHERE id = ?').run(deadline, m.id);
    E.logEvent(db, ev.id, o.by, 'grace_extended', at, { matchId: m.id, minutes, deadline });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

/** Ruling 15: back to the phase the hold came from, with that phase's full
 *  deadline from now; the dispute columns are cleared into the log row. */
export function releaseHold(
  db: DB, o: { matchId: number; by: string; timers: RoomTimers; graceMinutes: number; now?: Date },
): V.Checked<P.MatchRow> {
  const now = o.now ?? new Date();
  const at = iso(now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (m.status !== 'admin_hold') return V.fail('not_held');
    const to = m.hold_from;
    if (to === null || !HOLDABLE.has(to)) return V.fail('hold_not_releasable');
    if (BOX_PHASES.has(to)) {
      const b = m.booking_id === null ? undefined
        : db.prepare('SELECT state, ending_at FROM bookings WHERE id = ?').get(m.booking_id) as { state: string; ending_at: string | null } | undefined;
      if (!b || b.ending_at !== null || (b.state !== 'ready' && b.state !== 'active')) return V.fail('hold_not_releasable');
    }
    let deadline: string | null = null;
    if (to === 'veto') {
      if (m.ready_a_at === null || m.ready_b_at === null) deadline = plus(now, o.timers.readyMinutes * 60_000);
      else if (isHumanStep(roomState(db, m).next)) deadline = plus(now, o.timers.stepSeconds * 1000);
    } else if (to === 'lineup') deadline = plus(now, o.timers.lineupMinutes * 60_000);
    else if (to === 'connect') deadline = plus(now, o.graceMinutes * 60_000);
    else if (to === 'confirming') deadline = plus(now, o.timers.confirmMinutes * 60_000);
    else if (to === 'live' && isHumanStep(roomState(db, m).next)) deadline = plus(now, o.timers.stepSeconds * 1000);
    db.prepare(
      `UPDATE event_matches SET status = ?, deadline = ?, hold_reason = NULL, hold_from = NULL,
         dispute_side = NULL, dispute_by = NULL, dispute_reason = NULL, disputed_at = NULL WHERE id = ?`,
    ).run(to, deadline, m.id);
    E.logEvent(db, ev.id, o.by, 'hold_released', at, {
      matchId: m.id, to, reason: m.hold_reason,
      dispute: m.dispute_side === null ? null : { side: m.dispute_side, by: m.dispute_by, reason: m.dispute_reason, at: m.disputed_at },
    });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

/** Ruling 12: the record of a replayed chapter (the engine did the work). */
export function noteReplay(db: DB, o: { matchId: number; by: string; gameId: number; ordinal: number; map: string; now?: Date }): V.Checked<P.MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (m.status !== 'live') return V.fail('not_live_phase');
    E.logEvent(db, ev.id, o.by, 'chapter_replayed', at, { matchId: m.id, gameId: o.gameId, ordinal: o.ordinal, map: o.map });
    return V.ok(m);
  })();
}

/** Ruling 13: the record of a move to another server (the runner did the work). */
export function noteMove(db: DB, o: { matchId: number; by: string; fromServerId: number; now?: Date }): V.Checked<P.MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (!SUB_PHASES.has(m.status)) return V.fail('not_live_phase');
    E.logEvent(db, ev.id, o.by, 'server_moved', at, { matchId: m.id, fromServerId: o.fromServerId });
    return V.ok(m);
  })();
}
```

- [ ] **Step 5: The views and the chapter list**

In `src/bookings/restore.ts` add (Task 3 gives `restoreSnapshot` its `replayFrom` option; until then this returns at most the current chapter, which is what today's `restoreSnapshot` describes):

```ts
/** The chapters of a live game that may be replayed from their start
 *  (plan T3c Ruling 12): every finished one and the one being played, the
 *  finale never (restoreSnapshot refuses it). In order. */
export function replayableChapters(db: DB, matchId: number): { ordinal: number; map: string }[] {
  const out: { ordinal: number; map: string }[] = [];
  for (let k = 0; k < 16; k++) {
    const s = restoreSnapshot(db, matchId, { replayFrom: k });
    if (!s) break;
    out.push({ ordinal: k, map: s.map });
  }
  return out;
}
```

and give `restoreSnapshot` the signature `restoreSnapshot(db: DB, matchId: number, opts: { replayFrom?: number } = {})` with, for now, `if (opts.replayFrom !== undefined && opts.replayFrom !== done.length) return null;` placed right after `start` is computed (Task 3 replaces that line with the real cut, in that same place: after `firstMap` and `start`, which must read the untruncated `done`).

In `src/events/playViews.ts`:

```ts
import { getServer } from '../serverPool.js';
import * as B from '../bookings/bookings.js';
import { replayableChapters } from '../bookings/restore.js';
import { getPlayer } from '../players.js';
import * as R from './room.js';
```

(check for a cycle: `room.ts` does not import `playViews.ts`, and `roomViews.ts` imports both; fine.) Add the types:

```ts
/** What only the Events desk sees of a match (plan T3c Ruling 16). */
export interface PlayMatchDesk {
  holdReason: string | null; holdFrom: string | null;
  dispute: { side: 'a' | 'b'; byName: string; reason: string; at: string } | null;
  frozen: boolean; graceEndsAt: string | null;
  booking: { id: number; state: string; serverName: string | null; recovering: boolean } | null;
  liveGame: { matchId: number; campaign: string; chapters: { ordinal: number; map: string }[] } | null;
  subs: { a: number; b: number };
}
```

`PlayMatch` gains `desk?: PlayMatchDesk;`. `stagePlayViews(db: DB, ev: E.EventRow, opts: { staff?: boolean } = {})` and, inside the match loop, after `phase: phaseOf(m)` build the row as before and then `if (opts.staff) row.desk = deskOf(db, m);` with:

```ts
function deskOf(db: DB, m: P.MatchRow): PlayMatchDesk {
  const booking = m.booking_id !== null ? B.getBooking(db, m.booking_id) : undefined;
  const server = booking && booking.server_id !== null ? getServer(db, booking.server_id) : undefined;
  const live = R.gamesOf(db, m.id).find((g) => g.match_id !== null && g.ended_at === null
    && !!db.prepare("SELECT 1 FROM matches WHERE id = ? AND state = 'live'").get(g.match_id));
  return {
    holdReason: m.status === 'admin_hold' ? m.hold_reason : null, holdFrom: m.status === 'admin_hold' ? m.hold_from : null,
    dispute: m.dispute_side !== null ? { side: m.dispute_side, byName: getPlayer(db, m.dispute_by ?? '')?.name ?? 'a captain', reason: m.dispute_reason ?? '', at: m.disputed_at ?? '' } : null,
    frozen: m.admin_pause_at !== null,
    graceEndsAt: m.status === 'connect' ? m.deadline : null,
    booking: booking ? { id: booking.id, state: B.isOpen(booking) ? booking.state : 'ended', serverName: server?.name ?? null, recovering: booking.recovering_at !== null } : null,
    liveGame: live && m.status === 'live' ? { matchId: live.match_id!, campaign: live.campaign, chapters: replayableChapters(db, live.match_id!) } : null,
    subs: { a: R.subsUsed(db, m, 'a'), b: R.subsUsed(db, m, 'b') },
  };
}
```

In `src/routes/adminEvents.ts` the play route calls `stagePlayViews(db, ev, { staff: true })`; `src/events/views.ts` keeps `stagePlayViews(db, ev)`.

In `src/events/roomViews.ts` add `frozen: boolean;` to `MatchRoomView` (after `dispute`) and `frozen: m.admin_pause_at !== null,` to the returned object.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/eventsSchema.test.ts tests/room.test.ts tests/eventLogGuard.test.ts tests/roomViews.test.ts tests/roomClock.test.ts tests/series.test.ts tests/eventRoomRoutes.test.ts`
Expected: PASS (the guard's "one row, nothing on refusal" runs over the seven new mutations; T3b's suites still pass with the wider `readyUp`).

- [ ] **Step 7: Commit**

```bash
git add src/db.ts src/events/validate.ts src/events/play.ts src/events/room.ts src/events/playViews.ts src/events/roomViews.ts src/bookings/restore.ts src/routes/adminEvents.ts tests/eventsSchema.test.ts tests/room.test.ts tests/eventLogGuard.test.ts tests/roomViews.test.ts
git commit -m "Tournaments T3c: the room writer takes subs, the staff freeze, a reopened veto, an extended grace and a released hold, staff may act as a team, and the desk view carries the hold, the dispute and the freeze"
```

---
### Task 3: Bookings, the restore snapshot's chapter cut, and the sub's game row

**Files:**
- Modify: `src/bookings/bookings.ts`, `src/bookings/restore.ts`, `src/bookings/tournamentGames.ts`
- Test: `tests/tournamentBooking.test.ts`, `tests/bookingRestore.test.ts`

**Interfaces:**
- Consumes: `insertPerson`, `logEvent`, `getBooking`, `isOpen`, `sideRow` (`bookings.ts`); `restoreSnapshot` internals (`done`, `liveMaps`, `entry.maps`, `start`); `logBookingEvent` (`tournamentGames.ts`).
- Produces in `bookings.ts`:
  - `swapPlayer(db, { bookingId, side: Side, outId, inId, now? }): Result<null>` (`player_swapped`): `outId` must be an accepted `player` of `side`, `inId` an accepted person of `side`; roles swap (`in` -> `player`, `out` -> `spectator`); refused `wrong_state` on a booking that is not open, `not_person` otherwise.
  - `beginMove(db, id, now): number | null` (`box_moved_by_staff`): a ready or active booking with a box and no recovery running lets go of its box (`server_id` null, `waiting_since` now, `recovering_at` now, `recover_reason = 'gone'`); returns the old server id, or null. The server row is not touched (Ruling 13).
- Produces in `restore.ts`: `restoreSnapshot(db, matchId, { replayFrom? })`: with `replayFrom = k` (0-based, at most the count of finished maps), the finished maps are the first `k`, `map` is the k-th chapter of the campaign (the map the game played there when known from `match_live_maps`), `firstSurv` is computed from those `k` maps, and null when `k` exceeds the finished count or the chosen map is the finale.
- Produces in `tournamentGames.ts`: `addTournamentSub(db, { matchId, inId, team: 'a' | 'b', now? }): { joinedMap: number }`: `INSERT OR IGNORE` the sub's `match_players` row with `source = 'web'` and `joined_map` = the count of maps this game has finished (`match_rounds` ordinals with an ended half 2), logging `sub_added` on the booking.

- [ ] **Step 1: Write the failing tests**

Append to `tests/tournamentBooking.test.ts` (it has `db`, `P`, `NOW`, `sides()`; add `swapPlayer`, `beginMove`, `holdBox`, `markSetup`, `markReady` to the import from `bookings.js` and `addTournamentSub` to the one from `tournamentGames.js`; add `import { addServer } from '../src/serverPool.js'` if it is not there):

```ts
describe('swapPlayer and beginMove (plan T3c)', () => {
  const booked = () => {
    const r = createTournamentBooking(db, { region: 'na', campaign: 'no_mercy', rulesJson: '{}', rulesetId: null, gameConfig: 'standard', createdBy: P[9]!, sides: [sides()[0], sides()[1]], now: NOW });
    if (!r.ok) throw new Error(r.error);
    return r.value.id;
  };
  it('swaps a locked player and a spectator of the same side', () => {
    const id = booked();
    expect(swapPlayer(db, { bookingId: id, side: 'a', outId: P[8]!, inId: P[0]!, now: NOW })).toEqual({ ok: false, error: 'not_person' });
    expect(swapPlayer(db, { bookingId: id, side: 'a', outId: P[0]!, inId: P[4]!, now: NOW })).toEqual({ ok: false, error: 'not_person' });
    expect(swapPlayer(db, { bookingId: id, side: 'a', outId: P[0]!, inId: P[8]!, now: NOW })).toEqual({ ok: true, value: null });
    expect(peopleOf(db, id).filter((p) => p.side === 'a').map((p) => `${p.steamid}:${p.role}`).sort())
      .toEqual([`${P[0]}:spectator`, `${P[1]}:player`, `${P[2]}:player`, `${P[3]}:player`, `${P[8]}:player`].sort());
    expect(db.prepare("SELECT detail FROM booking_events WHERE booking_id = ? AND event = 'player_swapped'").get(id)).toEqual({ detail: JSON.stringify({ side: 'a', out: P[0], in: P[8] }) });
  });

  it('lets a running booking go of its box without marking the box offline', () => {
    const id = booked();
    const serverId = addServer(db, { name: 'box', host: '10.0.0.1', port: 27015, rconPort: 1, rconPassword: 'x' });
    db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(serverId);
    expect(beginMove(db, id, NOW)).toBeNull();
    expect(holdBox(db, id, serverId, NOW)).toBe(true);
    markSetup(db, id, NOW);
    markReady(db, id, NOW);
    expect(beginMove(db, id, NOW)).toBe(serverId);
    expect(getBooking(db, id)).toMatchObject({ server_id: null, recovering_at: NOW.toISOString(), recover_reason: 'gone', waiting_since: NOW.toISOString(), state: 'ready' });
    expect(db.prepare('SELECT status, gone_since FROM servers WHERE id = ?').get(serverId)).toEqual({ status: 'idle', gone_since: null });
    expect(beginMove(db, id, NOW)).toBeNull();
  });

  it('adds a sub to a tournament game with the maps finished so far', () => {
    const id = booked();
    const serverId = addServer(db, { name: 'box', host: '10.0.0.1', port: 27015, rconPort: 1, rconPassword: 'x' });
    const g = createTournamentGame(db, { bookingId: id, serverId, campaign: 'no_mercy', teams: { a: P.slice(0, 4), b: P.slice(4, 8) }, bookingSideA: 'a', now: NOW });
    const round = db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, ended_at) VALUES (?, ?, ?, 'a', 100, '2026-10-07 20:30:00')");
    round.run(g.matchId, 0, 1); round.run(g.matchId, 0, 2); round.run(g.matchId, 1, 1);
    expect(addTournamentSub(db, { matchId: g.matchId, inId: P[8]!, team: 'a', now: NOW })).toEqual({ joinedMap: 1 });
    expect(db.prepare('SELECT team, joined_map, source FROM match_players WHERE match_id = ? AND player_id = ?').get(g.matchId, P[8]!)).toEqual({ team: 'a', joined_map: 1, source: 'web' });
    // Again: the row stays as it was.
    expect(addTournamentSub(db, { matchId: g.matchId, inId: P[8]!, team: 'b', now: NOW })).toEqual({ joinedMap: 1 });
    expect(db.prepare('SELECT team FROM match_players WHERE match_id = ? AND player_id = ?').get(g.matchId, P[8]!)).toEqual({ team: 'a' });
  });
});
```

Append to `tests/bookingRestore.test.ts` (inside `describe('restoreSnapshot')`; it has `db`, `m`, `round`):

```ts
  it('replays an earlier chapter when asked: the maps before it stand, it and everything after it are dropped (plan T3c)', () => {
    round(0, 1, 'a', 400); round(0, 2, 'b', 350);
    round(1, 1, 'a', 200); round(1, 2, 'b', 500);
    round(2, 1, 'b', 100);
    db.prepare("INSERT INTO match_live (match_id, current_map, last_seen) VALUES (?, 'l4d_vs_hospital03_sewers', '2026-10-02 21:00:00')").run(m);
    const s = restoreSnapshot(db, m, { replayFrom: 1 })!;
    expect(s.maps).toEqual([{ map: 'l4d_vs_hospital01_apartment', a: 400, b: 350 }]);
    expect(s).toMatchObject({ map: 'l4d_vs_hospital02_subway', firstSurv: 'a' });
    expect(restoreSnapshot(db, m, { replayFrom: 2 })!.map).toBe('l4d_vs_hospital03_sewers');
    expect(restoreSnapshot(db, m, { replayFrom: 0 })!.maps).toEqual([]);
    expect(restoreSnapshot(db, m, { replayFrom: 3 })).toBeNull();
    expect(restoreSnapshot(db, m, { replayFrom: 4 })).toBeNull();
    prepareRestore(db, s);
    expect(db.prepare('SELECT MAX(ordinal) AS o FROM match_rounds WHERE match_id = ?').get(m)).toEqual({ o: 0 });
  });

  it('lists the replayable chapters, never the finale (plan T3c)', () => {
    round(0, 1, 'a', 400); round(0, 2, 'b', 350);
    round(1, 1, 'a', 200); round(1, 2, 'b', 500);
    round(2, 1, 'a', 200); round(2, 2, 'b', 500);
    round(3, 1, 'a', 200); round(3, 2, 'b', 500);
    db.prepare("INSERT INTO match_live (match_id, current_map, last_seen) VALUES (?, 'l4d_vs_hospital05_rooftop', '2026-10-02 21:00:00')").run(m);
    expect(replayableChapters(db, m)).toEqual([
      { ordinal: 0, map: 'l4d_vs_hospital01_apartment' }, { ordinal: 1, map: 'l4d_vs_hospital02_subway' },
      { ordinal: 2, map: 'l4d_vs_hospital03_sewers' }, { ordinal: 3, map: 'l4d_vs_hospital04_interior' },
    ]);
  });
```

(add `replayableChapters` to the import from `restore.js`.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/tournamentBooking.test.ts tests/bookingRestore.test.ts`
Expected: FAIL (`swapPlayer`, `beginMove`, `addTournamentSub` are not exported; `replayFrom` 1 answers null).

- [ ] **Step 3: bookings.ts**

After `appendTournamentGame`:

```ts
/** A substitution on a tournament booking (plan T3c Ruling 5): the sub, an
 *  accepted person of the side already, becomes a player and the replaced
 *  player a spectator, so present_now counts the right four and the
 *  replaced player may stay and watch. */
export function swapPlayer(db: DB, o: { bookingId: number; side: Side; outId: string; inId: string; now?: Date }): Result<null> {
  const now = o.now ?? new Date();
  return db.transaction((): Result<null> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    if (!isOpen(b)) return fail('wrong_state');
    const person = (id: string) => db.prepare("SELECT role FROM booking_people WHERE booking_id = ? AND side = ? AND steamid = ? AND status = 'accepted'")
      .get(b.id, o.side, id) as { role: PersonRole } | undefined;
    const out = person(o.outId);
    const inn = person(o.inId);
    if (!out || out.role !== 'player' || !inn || inn.role === 'player') return fail('not_person');
    const set = db.prepare('UPDATE booking_people SET role = ? WHERE booking_id = ? AND steamid = ?');
    set.run('player', b.id, o.inId);
    set.run('spectator', b.id, o.outId);
    logEvent(db, b.id, null, 'player_swapped', { side: o.side, out: o.outId, in: o.inId }, now);
    return ok(null);
  })();
}
```

After `reholdBox` (in the crash recovery section):

```ts
/** Staff move the booking to another box (plan T3c Ruling 13): the same
 *  shape a gone box leaves behind (so relocate, recover and the give-up
 *  apply unchanged), except the box itself is left alone: the runner gives
 *  it back through the releaser. Returns the box let go of, or null when
 *  the booking is not running on one or is already recovering. */
export function beginMove(db: DB, id: number, now: Date): number | null {
  return db.transaction(() => {
    const b = db.prepare(
      "SELECT server_id FROM bookings WHERE id = ? AND state IN ('ready','active') AND ending_at IS NULL AND recovering_at IS NULL AND server_id IS NOT NULL",
    ).get(id) as { server_id: number } | undefined;
    if (!b) return null;
    db.prepare("UPDATE bookings SET server_id = NULL, waiting_since = ?, recovering_at = ?, recover_reason = 'gone' WHERE id = ?")
      .run(now.toISOString(), now.toISOString(), id);
    logEvent(db, id, null, 'box_moved_by_staff', { serverId: b.server_id }, now);
    return b.server_id;
  })();
}
```

- [ ] **Step 4: restore.ts**

Replace the Task 2 placeholder line with the real cut. It stays where the placeholder was: after `firstMap` and `start` (both read `done.length` as the box's real count: with the cut before them, a replay from chapter 0 would take the box's current map as the first map and the list of replayable chapters would come out empty), and before `maps`, `finished` and `map`, which must see the truncated `done`:

```ts
  // Plan T3c: replay from an earlier chapter. The maps before it stand; it
  // and anything after it are dropped (prepareRestore deletes their rows).
  // After firstMap and start, which need the real count of finished maps.
  if (opts.replayFrom !== undefined) {
    if (!Number.isInteger(opts.replayFrom) || opts.replayFrom < 0 || opts.replayFrom > done.length) return null;
    done.length = opts.replayFrom;
  }
```

and the `map` line becomes:

```ts
  const map = opts.replayFrom !== undefined
    ? (inCampaign(liveMaps.get(opts.replayFrom)) ? liveMaps.get(opts.replayFrom)! : entry.maps[start + opts.replayFrom])
    : inCampaign(current) && !finished.has(current) ? current : entry.maps[start + done.length];
```

(`finished` and `maps` are built from the truncated `done`, so a replay from chapter 1 keeps map 0's score only.) Update the file comment: `replayFrom` is the desk's "replay a chapter"; the finale rule still applies.

- [ ] **Step 5: tournamentGames.ts**

```ts
/** A sub's roster row on a tournament game (plan T3c Ruling 5): source web,
 *  joined_map the maps finished so far, so the dump's STAT line finds a row
 *  and the rating of a pug never applies anyway (kind tournament). A second
 *  call for the same player changes nothing. */
export function addTournamentSub(db: DB, o: { matchId: number; inId: string; team: 'a' | 'b'; now?: Date }): { joinedMap: number } {
  const now = o.now ?? new Date();
  return db.transaction(() => {
    const row = db.prepare('SELECT booking_id FROM matches WHERE id = ?').get(o.matchId) as { booking_id: number | null } | undefined;
    if (!row) throw new Error(`match ${o.matchId} does not exist`);
    const joinedMap = (db.prepare(
      'SELECT COUNT(DISTINCT ordinal) AS n FROM match_rounds WHERE match_id = ? AND half = 2 AND ended_at IS NOT NULL',
    ).get(o.matchId) as { n: number }).n;
    const existing = db.prepare('SELECT joined_map FROM match_players WHERE match_id = ? AND player_id = ?').get(o.matchId, o.inId) as { joined_map: number } | undefined;
    if (existing) return { joinedMap: existing.joined_map };
    db.prepare("INSERT INTO match_players (match_id, player_id, team, joined_map, source) VALUES (?, ?, ?, ?, 'web')").run(o.matchId, o.inId, o.team, joinedMap);
    if (row.booking_id !== null) logBookingEvent(db, row.booking_id, null, 'sub_added', { matchId: o.matchId, steamid: o.inId, team: o.team, joinedMap }, now);
    return { joinedMap };
  })();
}
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/tournamentBooking.test.ts tests/bookingRestore.test.ts tests/bookingRecovery.test.ts tests/bookings.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/bookings/bookings.ts src/bookings/restore.ts src/bookings/tournamentGames.ts tests/tournamentBooking.test.ts tests/bookingRestore.test.ts
git commit -m "Tournaments T3c: a booking swaps a sub in and lets go of its box for a move, the restore snapshot can replay from an earlier chapter, and a sub gets a roster row on the game"
```

---

### Task 4: The booking runner: the tournament cvar, a send, a replay and a move

**Files:**
- Modify: `src/bookings/runner.ts`, `src/bookings/tournamentGames.ts` (`TOURNAMENT_LINES`)
- Test: `tests/bookingRunner.test.ts`, `tests/series.test.ts` (one runner-level test through the series fixture; the engine calls come in Task 7)

**Interfaces:**
- Consumes: T3b's final review wave as committed: `TOURNAMENT_LINES` in `tournamentGames.ts` (`sm_pug_leave_budget 0`, `sm_pug_end_kick 0`), `gameLines` spreading it on a tournament booking, `CLEAR_LINES` with `sm_pug_end_kick 1`, the runner's `boxLacksGame`; `prepareRestore`, `resumeLines`, `RestoreSnapshot`; `beginMove`; `abortBookingGame`, `liveBookingGame` (`games.ts`); `MAP_SETTLE_MS`; `this.track`, `this.busy`, `this.push` (a lines thunk), `this.running`, `this.relocate`, `this.pickBox`, `this.hook`, `this.forgetToken`, `this.deps.release` (`src/serverRelease.ts` `release()` with `forceRestart`: it marks the box `offline` synchronously, inside the deps wrapper's Promise executor, before its first await, and the box comes back `idle` only once its restart answers).
- Produces:
  - `TOURNAMENT_LINES` gains `'sm_pug_tournament 1'` (first); `CLEAR_LINES` gains `'sm_pug_tournament 0'` (last) (Ruling 2).
  - `BookingRunner.send(bookingId: number, lines: string[], what: string): Promise<string[] | null>`: one burst to the booking's running box, the replies, or null when the booking has no running box or the burst failed (logged with the secrets redacted).
  - `BookingRunner.replayGame(bookingId: number, gameMatchId: number, snap: RestoreSnapshot): Promise<'ok' | 'refused' | 'busy'>` (Ruling 12): tracked; `sm_pug_abort <token>`, the resume burst, `prepareRestore` once the plugin answered `PUGOK resumed`, `changelevel <snap.map>`, the map check, the booking and game lines again plus a chat line; `'refused'` (and the game aborted as `server_lost` with the `gameLost` hook) when the plugin did not take the resume; `'busy'` without touching anything when the booking is busy, not running, or not running this game.
  - `BookingRunner.moveBooking(bookingId: number): Promise<number | null>` (Ruling 13): `beginMove`, the old box given back through `deps.release` (not awaited past its start), then `relocate()`; the old server id, or null when the booking is not running, is busy, or is already recovering. The order matters: a booked box is `idle` in `servers.status` and held only through the bookings view, so the moment `beginMove` clears `server_id` the old box is a free idle box again; `release()` (forced restart) marks it `offline` synchronously before returning, so the `relocate()` that follows never sees it idle and cannot hand the booking back the box it is leaving. It comes back `idle` only once its restart answers, by which time the booking holds another box or is waiting.

- [ ] **Step 1: Write the failing tests**

In `tests/bookingRunner.test.ts`, the `CLEAR_LINES` assertion (search `expect(CLEAR_LINES).toEqual([`) gains `'sm_pug_tournament 0'` as its last line. Add to the tournament section of that file, or to `tests/tournamentBooking.test.ts`, whichever holds the `TOURNAMENT_LINES` assertion from T3b's wave: expect `TOURNAMENT_LINES[0]` to be `'sm_pug_tournament 1'`.

Append to `tests/series.test.ts` a new describe (it has `f`, `seriesFixture`, `A`, `BATS`, `MIN`, `B`):

```ts
describe('BookingRunner on a tournament box (plan T3c)', () => {
  it('pushes sm_pug_tournament 1 with the booking lines and sends a burst to the running box only', async () => {
    f = await seriesFixture();
    expect(await f.runner.send(999, ['say hi'], 'nothing')).toBeNull();
    await f.tick();
    expect(f.sent).toContain('sm_pug_tournament 1');
    const replies = await f.runner.send(f.booking().id, ['sm_pug_status'], 'a look');
    expect(replies).toHaveLength(1);
    expect(f.sent.at(-1)).toBe('sm_pug_status');
    f.box.down = true;
    expect(await f.runner.send(f.booking().id, ['say hi'], 'a line')).toBeNull();
  });

  it('replays a chapter: abort, resume, prepare, changelevel, the lines again; aborts the game when the plugin refuses', async () => {
    f = await seriesFixture();
    await f.tick();
    const g1 = f.gameOf(1).match_id!;
    f.goLive(g1, 'l4d_vs_hospital02_subway');
    const token = (f.db.prepare('SELECT token FROM matches WHERE id = ?').get(g1) as { token: string }).token;
    const round = f.db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, ended_at) VALUES (?, ?, ?, ?, ?, datetime('now'))");
    round.run(g1, 0, 1, 'a', 300); round.run(g1, 0, 2, 'b', 200); round.run(g1, 1, 1, 'a', 50);
    // match_live_maps keys on (match_id, map) and needs both scores (NOT NULL).
    f.db.prepare("INSERT INTO match_live_maps (match_id, ordinal, map, team_a_score, team_b_score) VALUES (?, 0, 'l4d_vs_hospital01_apartment', 300, 200), (?, 1, 'l4d_vs_hospital02_subway', 0, 0)").run(g1, g1);
    const { restoreSnapshot } = await import('../src/bookings/restore.js');
    const snap = restoreSnapshot(f.db, g1, { replayFrom: 1 })!;
    expect(snap.map).toBe('l4d_vs_hospital02_subway');
    f.box.resumeOk = true;
    f.sent.length = 0;
    expect(await f.runner.replayGame(f.booking().id, g1, snap)).toBe('ok');
    const i = (p: string) => f.sent.findIndex((c) => c.startsWith(p));
    expect(i(`sm_pug_abort ${token}`)).toBeGreaterThanOrEqual(0);
    expect(i('sm_pug_resume ')).toBeGreaterThan(i(`sm_pug_abort ${token}`));
    expect(i('sm_pug_resume_commit')).toBeLessThan(i('changelevel l4d_vs_hospital02_subway'));
    expect(f.sent.filter((c) => c.startsWith('sm_pug_resume_map '))).toEqual(['sm_pug_resume_map l4d_vs_hospital01_apartment 300 200']);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM match_rounds WHERE match_id = ? AND ordinal >= 1').get(g1)).toEqual({ n: 0 });
    expect(f.db.prepare('SELECT state FROM matches WHERE id = ?').get(g1)).toEqual({ state: 'live' });
    expect(f.sent.some((c) => c.startsWith('say [Match] Staff replayed'))).toBe(true);
    // The plugin refuses: the game is aborted, the match held.
    round.run(g1, 1, 1, 'a', 50);
    f.box.resumeOk = false;
    const again = restoreSnapshot(f.db, g1, { replayFrom: 1 })!;
    expect(await f.runner.replayGame(f.booking().id, g1, again)).toBe('refused');
    expect(f.db.prepare('SELECT state, abort_cause FROM matches WHERE id = ?').get(g1)).toEqual({ state: 'aborted', abort_cause: 'server_lost' });
    expect(f.match()).toMatchObject({ status: 'admin_hold', hold_reason: 'game_lost' });
  });

  it('moves a booking: the old box goes back, a fresh one is taken and set up again with the game restored', async () => {
    f = await seriesFixture();
    await f.tick();
    const old = f.booking().server_id!;
    const second = f.addServer('box2');
    const g1 = f.gameOf(1).match_id!;
    f.goLive(g1, 'l4d_vs_hospital01_apartment');
    f.box.resumeOk = true;
    expect(await f.runner.moveBooking(f.booking().id)).toBe(old);
    // Taken at once by the relocate pass (pickBox: highest id first, so the second box).
    expect(f.booking().server_id).toBe(second);
    await f.runner.idle();
    expect(f.booking()).toMatchObject({ server_id: second, recovering_at: null, waiting_since: null });
    expect(f.db.prepare('SELECT server_id FROM matches WHERE id = ?').get(g1)).toEqual({ server_id: second });
    expect(f.db.prepare('SELECT status FROM servers WHERE id = ?').get(old)).toEqual({ status: 'idle' });
    expect(f.sent.some((c) => c.startsWith('sm_pug_resume '))).toBe(true);
    expect(f.send).toHaveBeenCalledWith(expect.arrayContaining([A[0]]), 'booking_recovered', expect.objectContaining({ content: expect.stringContaining('moved') }));
    expect(await f.runner.moveBooking(f.booking().id)).toBeNull();
    // No other box free: the booking waits as after a crash (the old box is not idle: the releaser is restarting it).
    f.db.prepare("UPDATE servers SET status = 'offline' WHERE id = ?").run(old);
    expect(await f.runner.moveBooking(f.booking().id)).toBe(second);
    expect(f.booking()).toMatchObject({ server_id: null, recovering_at: expect.any(String), waiting_since: expect.any(String) });
  });
});
```

(The last lines stand in for what the real releaser does to the box being left: `serverRelease.ts` `release()` marks it `offline` synchronously, so the fixture sets `old` offline by hand before the second move; the fixture's own `release` fake sets a box idle at once, which is why the first move leans on `pickBox`'s highest-id order to land on the second box.)

For these, `tests/seriesFixture.ts` gains: `box.resumeOk: boolean` (default false) and the rcon fake answers `'PUGOK resumed maps=0 roster=8'` to `sm_pug_resume_commit` when it is true and `'PUGERR resume incomplete'` otherwise; `addServer(name): number` on the fixture (an idle, dlc4 box the move can take, with a lower id than nothing: `pickBox` takes the highest id first, so the fixture's second box is the one a move picks; the `restart` fake resets `box` the same way for it); and `f.sent` keeps collecting across both boxes (the fake ignores the server argument). `booking_recovered`'s wording with `moved: true` is "The server for ... went down, so the booking moved to another server." (`src/bookings/messages.ts`), which the `stringContaining('moved')` matches.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/bookingRunner.test.ts tests/tournamentBooking.test.ts tests/series.test.ts`
Expected: FAIL (`sm_pug_tournament` absent, `send`, `replayGame`, `moveBooking` are not functions).

- [ ] **Step 3: Implement in `src/bookings/runner.ts` and `tournamentGames.ts`**

`TOURNAMENT_LINES` becomes `['sm_pug_tournament 1', 'sm_pug_leave_budget 0', 'sm_pug_end_kick 0']` with a comment line: `sm_pug_tournament` turns on `!sub`, `!admin` and the staff freeze (pug-match 0.3.25, plan T3c). `CLEAR_LINES` gains `'sm_pug_tournament 0',` after the `sm_pug_end_kick 1` line.

Add the import `import { addTournamentSub, TOURNAMENT_LINES, boxNeedsGame } from './tournamentGames.js';` only if `addTournamentSub` is used here (it is not; leave that import to the engine). Add `import type { RestoreSnapshot } from './restore.js';` next to the existing restore import.

In the class, after `announce`:

```ts
  /** One burst from the series engine or the desk to a running tournament
   *  box, with the replies (plan T3c: the freeze, a sub, a chat line). Null
   *  when the booking has no running box or the burst failed; the failure is
   *  logged with the secrets redacted, never thrown. */
  async send(bookingId: number, lines: string[], what: string): Promise<string[] | null> {
    const b = this.running(bookingId);
    const server = b ? getServer(this.db, b.server_id!) : undefined;
    if (!b || !server) return null;
    try {
      return await this.deps.rcon(server, lines);
    } catch (err) {
      const secrets = [server.log_secret, b.password, b.tv_password];
      console.warn(`[booking] ${bookingId}: ${what} on ${server.name} failed:`, hideAllowIds(redactSecrets(err instanceof Error ? err.message : String(err), secrets)));
      return null;
    }
  }

  /** Staff replay a chapter of a live tournament game (plan T3c Ruling 12),
   *  on the same box, through the plugin's restore: the match is dropped and
   *  rebuilt from the snapshot, then the chapter loads from its start. The
   *  site's rows for the dropped chapters go only once the plugin took the
   *  resume. A refused resume aborts the game as server_lost (the engine
   *  holds the match through gameLost), as a failed recovery does. */
  async replayGame(bookingId: number, gameMatchId: number, snap: RestoreSnapshot): Promise<'ok' | 'refused' | 'busy'> {
    const live = liveBookingGame(this.db, bookingId);
    if (this.busy.has(bookingId) || !this.running(bookingId) || !live || live.id !== gameMatchId || live.token !== snap.token) return 'busy';
    let result: 'ok' | 'refused' = 'refused';
    this.track(bookingId, async () => { result = (await this.replayOnce(bookingId, gameMatchId, snap)) ? 'ok' : 'refused'; });
    await this.busy.get(bookingId);
    return result;
  }

  /** True once the plugin took the resume (the replay is on its way); false
   *  when it refused, in which case the game has been aborted. */
  private async replayOnce(id: number, gameMatchId: number, snap: RestoreSnapshot): Promise<boolean> {
    const b = this.running(id);
    const server = b ? getServer(this.db, b.server_id!) : undefined;
    if (!b || !server) return false;
    const live = liveBookingGame(this.db, id);
    if (!live || live.id !== gameMatchId || live.token !== snap.token) return false;
    const resume = resumeLines(snap);
    let replies: string[];
    try {
      await this.deps.rcon(server, [`sm_pug_abort ${snap.token}`]);
      replies = await this.deps.rcon(server, resume);
    } catch (err) {
      console.warn(`[booking] ${id}: the replay burst on ${server.name} failed:`, redactSecrets(err instanceof Error ? err.message : String(err), [server.log_secret, snap.token]));
      replies = [];
    }
    if (!(replies[resume.length - 1] ?? '').trim().startsWith('PUGOK resumed')) {
      const token = abortBookingGame(this.db, live.id, new Date(this.now()), 'server_lost');
      if (token) this.forgetToken(id, token);
      if (token && b.purpose === 'tournament') this.hook(id, 'gameLost', () => this.deps.tournament?.gameLost?.(id, live.id));
      publishAdminEvent({ kind: 'problem', matchId: live.id, text: `Booking ${id}: game #${live.id} could not be rebuilt on ${server.name} for a chapter replay (pug-match did not take sm_pug_resume). It is aborted.` });
      return false;
    }
    prepareRestore(this.db, snap);
    try {
      await this.deps.rcon(server, [`changelevel ${snap.map}`]);
    } catch {
      // A changelevel can drop the connection it came in on; the map check decides.
    }
    await this.sleep(MAP_SETTLE_MS);
    let onMap: string | null = null;
    try {
      const [st] = await this.deps.rcon(server, ['status']);
      onMap = parseStatusMap(st);
    } catch {
      // No answer: reported below; the next minute watch re-pushes the lines.
    }
    if (onMap !== snap.map) {
      publishAdminEvent({ kind: 'problem', matchId: live.id, text: `Booking ${id}: ${server.name} was sent ${snap.map} for a chapter replay but is on ${onMap ?? 'no map'}. The game is rebuilt on the box; load the map by hand or replay again.` });
      return true;
    }
    const fresh = this.running(id);
    if (fresh) {
      const name = campaignRegistry(this.db).get(snap.campaign)?.name ?? snap.campaign;
      await this.push(id, server, () => [
        ...bookingLines(this.db, fresh), ...gameLines(this.db, fresh, server, this.deps.logPublicAddress),
        `say [Match] ${consoleText(`Staff replayed chapter ${snap.maps.length + 1} of ${name} from its start. Ready up when everyone is back.`, 200)}`,
      ], 'the replay lines');
    }
    console.log(`[booking] ${id}: game #${live.id} replays ${snap.map} on ${server.name}`);
    return true;
  }

  /** Staff move a running booking to another box (plan T3c Ruling 13): the
   *  booking lets go of its box, the box goes back through the releaser's
   *  forced restart (not awaited: the move must not wait on it), and the
   *  relocate pass takes the first idle box, after which recover() restarts
   *  it, replays setup and restores the live game. The old box, or null. */
  async moveBooking(bookingId: number): Promise<number | null> {
    const b = this.running(bookingId);
    if (!b || this.busy.has(bookingId)) return null;
    const old = beginMove(this.db, bookingId, new Date(this.now()));
    if (old === null) return null;
    const server = getServer(this.db, old);
    console.log(`[booking] ${bookingId}: staff moved it off ${server?.name ?? old}`);
    // The box is idle and unheld from this moment (a booked box is idle in
    // status and held only through the bookings view). release() marks it
    // offline before it returns, so the relocate pass below cannot hand the
    // booking the box it is leaving: release first, relocate second.
    this.deps.release(old).catch((err) => {
      console.error(`[booking] ${bookingId}: giving back ${server?.name ?? old} after a move failed:`, err);
    });
    this.relocate();
    return old;
  }
```

Add `beginMove` to the `bookings.js` import list. `liveBookingGame` returns `{ id, token, campaign }` already (games.ts).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/bookingRunner.test.ts tests/tournamentBooking.test.ts tests/series.test.ts tests/bookingRecovery.test.ts`
Expected: PASS. (`relocate()` picks `box2` because `pickBox` takes the highest id first; the fixture's `release` fake sets the old box idle synchronously, where the real releaser marks it offline, so in the fixture the old box is still a candidate and the order decides. The test's last lines set it offline by hand to show the wait.)

- [ ] **Step 5: Commit**

```bash
git add src/bookings/runner.ts src/bookings/tournamentGames.ts tests/bookingRunner.test.ts tests/tournamentBooking.test.ts tests/series.test.ts tests/seriesFixture.ts
git commit -m "Tournaments T3c: a tournament box is told it is one, and the booking runner can send a burst, replay a chapter through the plugin's restore and move a booking to another box"
```

---
### Task 5: The plugin: `!sub`, `!admin`, `!lift` and the staff freeze (pug-match 0.3.25)

**Files:**
- Create: `plugin/pug-tourney.inc`
- Modify: `plugin/pug-match.sp`, `plugin/pug-leave.inc`, `plugin/pug-pause.inc`, `plugin/pug-modcall.inc`, `plugin/pug-gg.inc`, `plugin/build.sh`, `plugin/README.md` (table rows for the two RCON commands and the cvar, "0.3.25 and later")
- Test: none automated (SourcePawn). `plugin/build.sh` must compile clean; `tests/eventKindsParity.test.ts` still passes (no new `EmitEvent` kinds). The in-game checks are the owner's (Step 5).

**Interfaces:**
- Consumes (declared before the include, so readable): `g_State`, `MS_None`/`MS_Pending`/`MS_Live`/`MS_Ended`, `g_iMatchId`, `g_sToken`, `g_iHalf`, `g_bHalfWasLive`, `g_bRoundEnded`, `g_fRoundLiveAt`, `g_iMapCount`, `g_iRplMapSeq`, `g_sRosterId` (`[MAX_ROSTER][32]`), `g_iRosterTeam` (1 = a, 2 = b), `g_iRosterJoinedMap`, `g_iRosterCount`, `g_iClientRoster`, `g_iLockAttempts`, `MAX_ROSTER` (12), `TEAM_SURVIVOR`, `TEAM_INFECTED`, `TEAM_SPEC`, `g_bLeavePaused` (pug-leave.inc), `g_smCooldown` (a `StringMap`) and `MODCALL_COOLDOWN` (180, pug-modcall.inc); functions `EmitPug`, `PugLog`, `TokenArgOk`, `RosterIndexOfId`, `RoundMs`, `SanitizeChat`, `InReadyUp`, `ModCall_AuthId`, `ModCall_TriggerEnd`, `LeaveRotoblinPaused`, `LeaveUnpauseNow`, `LeaveAnyTeamClient`, `LeaveAnyAbsent`, `LeaveNameOf`, `PauseAllowInternal`; SourceMod's `CheckCommandAccess`, `StripQuotes`, `IsClientSourceTV`.
- Produces in `pug-tourney.inc`: cvar `sm_pug_tournament` (0/1); server commands `sm_pug_sub <token> <out64> <in64>` (answers `PUGOK sub out=<id> in=<id> slot=<n>`, `PUGOK sub already`, or `PUGERR ...`) and `sm_pug_adminpause <token> on|off ["by"]` (`PUGOK adminpause=<state> frozen=<0|1>`); admin command `sm_pug_lift` (`ADMFLAG_GENERIC`); chat `!sub`, `/sub`, `!admin`, `/admin`, `!lift`, `/lift`; listeners on `sm_admin`, `sm_ready`, `sm_r`, `sm_unpause`; signed lines `PUG <token> SUB by= out= in= map=` and `PUG <token> ADMINPAUSE state= by= cause=` (through `EmitPug`, so `PugLog` signs them), and `PUGCALL ... reason=admin target=none ... text=` (through `PugLog`); functions the rest of the plugin calls: `Tourney_Init()`, `Tourney_Reset()`, `Tourney_OnDisconnect(client)`, `Tourney_OnRoundLive()`, `Tourney_OnSay(client, text): bool`, `Tourney_SlotOut(slot): bool`, `TourneyFrozen(): bool`, `Tourney_IsStaff(client): bool`, `Tourney_Lift(by, cause, who)`, `Tourney_Status()`.
- Produces in `pug-leave.inc`: `LeaveForget(slot)`; `LeaveUnpauseNow` returns at once while `TourneyFrozen()`; a subbed-out slot's disconnect is not tracked. (All three are safeguards on a tournament box: `TOURNAMENT_LINES` sets `sm_pug_leave_budget 0`, so `LeaveTracking()` is false there and the module tracks and pauses nobody; `LeaveUnpauseNow` and `LeaveRotoblinPaused` work regardless of tracking.)
- Produces in `pug-pause.inc`: `admin=1` on the paused PHASE/HEARTBEAT fields while frozen; a pause first seen under the freeze is owner 0 (nothing charged, no `PAUSE` line, no `by=`); the ceiling never runs while `TourneyFrozen()`.
- Produces in `pug-match.sp`: `PLUGIN_VERSION "0.3.25"`, `ConVar g_cvTournament`, the include, the hook calls listed in Step 2.

- [ ] **Step 1: Write `plugin/pug-tourney.inc`**

```sourcepawn
// ---------- tournament boxes: !sub, !admin, !lift and the staff freeze (plan T3c) ----------
//
// Spec: docs/superpowers/specs/2026-09-30-competitive-tournaments-design.md,
// section 4 (Subs during a match; In-game help); plan T3c Rulings 2 to 9.
//
// Everything here is gated on sm_pug_tournament, which the site's booking
// runner sets to 1 with the booking lines of a tournament booking and back to
// 0 when the booking ends (CLEAR_LINES). A PUG box never sees any of it.
//
// !sub <out> <in>: a captain swaps one of the four between chapters. This
// module judges the moment (it knows the round state to the tick) and
// resolves the two names; the site decides who may sub whom and the limit,
// and answers with sm_pug_sub <token> <out> <in>. Nothing changes here until
// that answer arrives.
//
// !admin [why]: a player calls staff. One signed PUGCALL line with
// reason=admin (the mod-call card on the web), no menus, and the game is
// frozen: a Rotoblin pause from a rostered client, unbudgeted like the leave
// module's, that only staff lift (!lift in game, or the site's
// sm_pug_adminpause <token> off). Every change of the freeze goes out as a
// signed ADMINPAUSE line so the site's desk and room page agree with the box.
//
// WHY THE PAUSE IS ROTOBLIN'S OWN sm_pause AND NOT forcepause. Rotoblin's
// forcepause and forceunpause refuse client 0 (the server) and demand admin
// flags on the client that types them, so neither the site nor a fake client
// command on a player's behalf can drive them. sm_pause from a rostered
// client is the path the leave module already proved (LeaveTryPause), and
// the "staff only" part is this module's own listener on the unpause
// commands, which Rotoblin registers with RegConsoleCmd so a listener runs
// first (the same trick pug-pause.inc plays on sm_pause).

#define TOURNEY_FREEZE_DELAY 1.0   // seconds after a go-live before a deferred freeze is applied
#define TOURNEY_REOPEN_GUARD 0.5   // seconds a second !admin from the same client is ignored (the say forward and the sm_admin listener can both fire)

bool g_bTourneyFrozen;                 // the staff freeze holds (applied, or waiting for the next go-live)
bool g_bTourneyInternal;               // this module is issuing sm_pause / sm_ready itself: the listener lets it through
bool g_bTourneySlotOut[MAX_ROSTER];    // the slot was subbed out: no lock, no leave clock, no !gg vote
float g_fTourneyLastAdmin[MAXPLAYERS + 1];

void Tourney_Init()
{
	g_cvTournament = CreateConVar("sm_pug_tournament", "0",
		"1 = a tournament box (the site's booking runner sets it): !sub, !admin, !lift and the staff freeze are on.",
		FCVAR_NOTIFY, true, 0.0, true, 1.0);
	RegServerCmd("sm_pug_sub", Cmd_PugSub, "sm_pug_sub <token> <out64> <in64> - the site approved a substitution");
	RegServerCmd("sm_pug_adminpause", Cmd_AdminPause, "sm_pug_adminpause <token> on|off [\"by\"] - the staff freeze, from the site");
	RegAdminCmd("sm_pug_lift", Cmd_Lift, ADMFLAG_GENERIC, "Lift the staff freeze (chat: !lift)");
	// Rotoblin registers these with RegConsoleCmd: a listener runs first and
	// can refuse them while the freeze holds (pug-pause.inc does the same for sm_pause).
	AddCommandListener(Listener_TourneyUnpause, "sm_ready");
	AddCommandListener(Listener_TourneyUnpause, "sm_r");
	AddCommandListener(Listener_TourneyUnpause, "sm_unpause");
	// SourceMod's own admin menu: on a tournament box a player's !admin is a staff call.
	AddCommandListener(Listener_TourneyAdmin, "sm_admin");
}

bool TourneyOn()
{
	return g_cvTournament != null && g_cvTournament.BoolValue && g_State != MS_None;
}

/** Read by pug-leave.inc (LeaveUnpauseNow) and pug-pause.inc (the PHASE line, the pause owner, the ceiling). */
bool TourneyFrozen()
{
	return g_bTourneyFrozen;
}

/** Staff on the box: one check for !admin (not caught), !lift and the
 *  unpause listener, the same access sm_pug_lift itself needs. */
bool Tourney_IsStaff(int client)
{
	return CheckCommandAccess(client, "sm_pug_lift", ADMFLAG_GENERIC);
}

/** Read by the team lock, the leave module, !gg and the roster watchdog. */
bool Tourney_SlotOut(int slot)
{
	return slot >= 0 && slot < MAX_ROSTER && g_bTourneySlotOut[slot];
}

/** From ResetMatchState, first thing: a new, resumed or aborted match lifts
 *  the freeze (the line goes out while the token still stands) and forgets
 *  who was subbed out. */
void Tourney_Reset()
{
	if (g_bTourneyFrozen) Tourney_Lift("site", "reset", "");
	g_bTourneyInternal = false;
	for (int i = 0; i < MAX_ROSTER; i++) g_bTourneySlotOut[i] = false;
}

void Tourney_OnDisconnect(int client)
{
	g_fTourneyLastAdmin[client] = 0.0;
}

/** STATUS line for sm_pug_status. */
void Tourney_Status()
{
	PrintToServer("tourney on=%d frozen=%d", TourneyOn() ? 1 : 0, g_bTourneyFrozen ? 1 : 0);
}

// ---------- between chapters ----------

/** Before the first round of the match, before the current map's first half
 *  has gone live (its ready-up), or after its second half ended (the map is
 *  about to change). Never during a live half, a pause or half time. */
bool Tourney_BetweenChapters()
{
	if (g_State == MS_Pending) return true;
	if (g_State != MS_Live) return false;
	if (!g_bHalfWasLive) return true;
	return g_bRoundEnded && g_iHalf == 2;
}

// ---------- the say hook ----------

/** From OnClientSayCommand (pug-modcall.inc), after /staff: true when the
 *  line was a tournament command and has been handled (the caller drops it). */
bool Tourney_OnSay(int client, const char[] text)
{
	if (!TourneyOn()) return false;
	int rest = ModCall_TriggerEnd(text, "!sub");
	if (rest < 0) rest = ModCall_TriggerEnd(text, "/sub");
	if (rest >= 0)
	{
		Tourney_Sub(client, text[rest]);
		return true;
	}
	rest = ModCall_TriggerEnd(text, "!admin");
	if (rest < 0) rest = ModCall_TriggerEnd(text, "/admin");
	if (rest >= 0)
	{
		// Staff keep SourceMod's own !admin (the menu): nothing to drop here.
		if (Tourney_IsStaff(client)) return false;
		Tourney_AdminCall(client, text[rest]);
		return true;
	}
	rest = ModCall_TriggerEnd(text, "!lift");
	if (rest < 0) rest = ModCall_TriggerEnd(text, "/lift");
	if (rest >= 0)
	{
		Tourney_LiftFromGame(client);
		return true;
	}
	return false;
}

/** SourceMod maps a player's !admin and /admin to sm_admin (the admin menu).
 *  On a tournament box a non-staff player's is a staff call; the say forward
 *  usually got there first, and the reopen guard drops this second open. */
public Action Listener_TourneyAdmin(int client, const char[] command, int argc)
{
	if (!TourneyOn() || client < 1 || client > MaxClients || !IsClientInGame(client) || IsFakeClient(client)) return Plugin_Continue;
	if (Tourney_IsStaff(client)) return Plugin_Continue;
	char details[256];
	GetCmdArgString(details, sizeof(details));
	Tourney_AdminCall(client, details);
	return Plugin_Handled;
}

// ---------- !sub ----------

void Tourney_Sub(int client, const char[] args)
{
	if (client < 1 || client > MaxClients || !IsClientInGame(client) || IsFakeClient(client)) return;
	char outName[MAX_NAME_LENGTH], inName[MAX_NAME_LENGTH];
	int pos = BreakString(args, outName, sizeof(outName));
	if (pos != -1) strcopy(inName, sizeof(inName), args[pos]);
	TrimString(outName);
	TrimString(inName);
	if (outName[0] == '\0' || inName[0] == '\0')
	{
		PrintToChat(client, "[Match] Usage: !sub <player out> <player in>. Between chapters only; the sub connects first.");
		return;
	}
	if (!Tourney_BetweenChapters())
	{
		PrintToChat(client, "[Match] Subs are made between chapters, not during one. Try again at the next ready-up.");
		return;
	}
	char by[24];
	if (!ModCall_AuthId(client, by, sizeof(by)))
	{
		PrintToChat(client, "[PUG] Your Steam ID is not verified yet, try again in a moment.");
		return;
	}
	char outId[24], inId[24];
	int outSlot = Tourney_FindRostered(outName, outId, sizeof(outId));
	if (outSlot == -2)
	{
		PrintToChat(client, "[Match] More than one rostered player matches \"%s\"; type more of the name.", outName);
		return;
	}
	if (outSlot < 0)
	{
		PrintToChat(client, "[Match] No rostered player matches \"%s\".", outName);
		return;
	}
	int inClient = Tourney_FindConnected(inName, inId, sizeof(inId));
	if (inClient == -2)
	{
		PrintToChat(client, "[Match] More than one player on the server matches \"%s\"; type more of the name.", inName);
		return;
	}
	if (inClient < 0)
	{
		PrintToChat(client, "[Match] \"%s\" is not on the server. The sub connects (as a spectator) first, then you !sub.", inName);
		return;
	}
	if (StrEqual(outId, inId))
	{
		PrintToChat(client, "[Match] That is the same player.");
		return;
	}
	EmitPug("SUB by=%s out=%s in=%s map=%d", by, outId, inId, g_iMapCount);
	PrintToChat(client, "[Match] Asking the site to put %N in. It answers in chat.", inClient);
}

/** A rostered player, not already subbed out, by a unique substring of the
 *  name they have now (connected) or had when they left (LeaveNameOf: a
 *  connected client's name, else the leave module's, else the SteamID64, so
 *  a captain may also type digits of the id). The slot, -1 for none, -2 for
 *  more than one; `id` gets the SteamID64 on a hit. */
int Tourney_FindRostered(const char[] query, char[] id, int maxlen)
{
	int found = -1, count = 0;
	char name[MAX_NAME_LENGTH];
	for (int slot = 0; slot < g_iRosterCount; slot++)
	{
		if (g_bTourneySlotOut[slot]) continue;
		LeaveNameOf(slot, name, sizeof(name));
		if (StrContains(name, query, false) == -1) continue;
		found = slot;
		count++;
	}
	if (count > 1) return -2;
	if (count == 0) return -1;
	strcopy(id, maxlen, g_sRosterId[found]);
	return found;
}

/** A connected human by a unique substring of their name. The client, -1
 *  for none, -2 for more than one; `id` gets the SteamID64 on a hit. */
int Tourney_FindConnected(const char[] query, char[] id, int maxlen)
{
	int found = -1, count = 0;
	char name[MAX_NAME_LENGTH], sid[24];
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c) || IsFakeClient(c) || IsClientSourceTV(c)) continue;
		GetClientName(c, name, sizeof(name));
		if (StrContains(name, query, false) == -1) continue;
		if (!ModCall_AuthId(c, sid, sizeof(sid))) continue;
		found = c;
		count++;
	}
	if (count > 1) return -2;
	if (count == 0) return -1;
	ModCall_AuthId(found, id, maxlen);
	return found;
}

/** sm_pug_sub <token> <out64> <in64>: the site approved it (plan T3c
 *  Ruling 5). The outgoing slot keeps its stats and is marked out; the
 *  incoming player gets a new slot (or their old one back) on the same
 *  team, rostered from the maps finished so far, and the team lock places
 *  them within two seconds. Idempotent: a sub already in place answers
 *  PUGOK again. */
public Action Cmd_PugSub(int args)
{
	if (!TokenArgOk(args)) return Plugin_Handled;
	if (args < 3)
	{
		PrintToServer("PUGERR usage: sm_pug_sub <token> <out64> <in64>");
		return Plugin_Handled;
	}
	char outId[32], inId[32];
	GetCmdArg(2, outId, sizeof(outId));
	GetCmdArg(3, inId, sizeof(inId));
	if (StrEqual(outId, inId))
	{
		PrintToServer("PUGERR same player");
		return Plugin_Handled;
	}
	int outSlot = RosterIndexOfId(outId);
	int inSlot = RosterIndexOfId(inId);
	if (outSlot == -1)
	{
		PrintToServer("PUGERR not rostered");
		return Plugin_Handled;
	}
	int team = g_iRosterTeam[outSlot];
	if (g_bTourneySlotOut[outSlot])
	{
		// The sub already stands (a re-sent command, Review Focus 2): say so and change nothing.
		if (inSlot != -1 && !g_bTourneySlotOut[inSlot] && g_iRosterTeam[inSlot] == team)
		{
			PrintToServer("PUGOK sub already");
			return Plugin_Handled;
		}
		PrintToServer("PUGERR already out");
		return Plugin_Handled;
	}
	// An active rostered player (either team) is never moved by a sub: the
	// site only ever names a member of the entry who is not in the four.
	if (inSlot != -1 && !g_bTourneySlotOut[inSlot])
	{
		PrintToServer("PUGERR already rostered");
		return Plugin_Handled;
	}
	if (inSlot == -1)
	{
		if (g_iRosterCount >= MAX_ROSTER)
		{
			PrintToServer("PUGERR roster full");
			return Plugin_Handled;
		}
		inSlot = g_iRosterCount++;
		strcopy(g_sRosterId[inSlot], 32, inId);
		g_iRosterJoinedMap[inSlot] = g_iMapCount;
	}
	g_bTourneySlotOut[inSlot] = false;
	g_iRosterTeam[inSlot] = team;
	g_bTourneySlotOut[outSlot] = true;
	LeaveForget(outSlot);
	int outClient = -1, inClient = -1;
	char sid[24];
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c) || IsFakeClient(c)) continue;
		if (g_iClientRoster[c] == outSlot) outClient = c;
		if (g_iClientRoster[c] == inSlot) inClient = c;
		else if (inClient == -1 && ModCall_AuthId(c, sid, sizeof(sid)) && StrEqual(sid, inId))
		{
			g_iClientRoster[c] = inSlot;
			g_iLockAttempts[c] = 0;
			inClient = c;
		}
	}
	char outName[MAX_NAME_LENGTH];
	if (outClient != -1)
	{
		GetClientName(outClient, outName, sizeof(outName));
		int t = GetClientTeam(outClient);
		if (t == TEAM_SURVIVOR || t == TEAM_INFECTED) ChangeClientTeam(outClient, TEAM_SPEC);
	}
	else
	{
		LeaveNameOf(outSlot, outName, sizeof(outName));
	}
	if (inClient != -1) PrintToChatAll("\x04[Match]\x01 %N replaces %s for Team %s.", inClient, outName, team == 1 ? "A" : "B");
	else PrintToChatAll("\x04[Match]\x01 A sub replaces %s for Team %s; they are placed when they connect.", outName, team == 1 ? "A" : "B");
	LogMessage("[tourney] sub: %s out, %s in (team %s, slot %d, map %d)", outId, inId, team == 1 ? "a" : "b", inSlot, g_iMapCount);
	PrintToServer("PUGOK sub out=%s in=%s slot=%d", outId, inId, inSlot);
	return Plugin_Handled;
}

// ---------- !admin and the freeze ----------

void Tourney_AdminCall(int client, const char[] details)
{
	if (client < 1 || client > MaxClients || !IsClientInGame(client) || IsFakeClient(client)) return;
	float now = GetEngineTime();
	if (g_fTourneyLastAdmin[client] > 0.0 && now - g_fTourneyLastAdmin[client] < TOURNEY_REOPEN_GUARD) return;
	g_fTourneyLastAdmin[client] = now;
	char id[24];
	if (!ModCall_AuthId(client, id, sizeof(id)))
	{
		PrintToChat(client, "[PUG] Your Steam ID is not verified yet, try again in a moment.");
		return;
	}
	// The same cooldown as /mod, in the same map, so the two cannot be used in turn.
	int last;
	if (g_smCooldown.GetValue(id, last))
	{
		int left = MODCALL_COOLDOWN - (GetTime() - last);
		if (left > 0)
		{
			PrintToChat(client, "[Match] You can call staff again in %d:%02d.%s", left / 60, left % 60, g_bTourneyFrozen ? " The game is already frozen." : "");
			return;
		}
	}
	char text[256];
	strcopy(text, sizeof(text), details);
	StripQuotes(text);
	TrimString(text);
	SanitizeChat(text, sizeof(text));
	// The map rides on the line so the card says where; before text=, which must stay last.
	char map[64];
	GetCurrentMap(map, sizeof(map));
	char line[512];
	Format(line, sizeof(line), "PUGCALL steamid=%s target=none tteam=%d reason=admin match=%d ord=%d half=%d tms=%d via=game map=%s text=%s",
		id, GetClientTeam(client), g_iMatchId, g_iRplMapSeq, g_iHalf, RoundMs(), map, text);
	PugLog("%s", line);
	LogMessage("[tourney] %s", line);
	g_smCooldown.SetValue(id, GetTime());
	PrintToChatAll("\x04[Match]\x01 %N called staff. The game is frozen until staff lift it.", client);
	Tourney_Freeze(id, "call");
}

/** Set the freeze (and tell the site once); pause now if a round is live,
 *  else at the next go-live (Tourney_OnRoundLive). */
void Tourney_Freeze(const char[] by, const char[] cause)
{
	bool was = g_bTourneyFrozen;
	g_bTourneyFrozen = true;
	if (!was) Tourney_Emit(true, by, cause);
	Tourney_Apply();
}

void Tourney_Apply()
{
	if (!g_bTourneyFrozen) return;
	if (g_State != MS_Live || InReadyUp() || g_bRoundEnded || g_fRoundLiveAt <= 0.0) return;
	// A pause already in place (a team's, or the leave module's) is held as it is.
	if (LeaveRotoblinPaused()) return;
	int c = LeaveAnyTeamClient(0);
	if (c == -1) return;
	// Unbudgeted and without a ceiling, as the leave module's pause (pug-pause.inc).
	PauseAllowInternal();
	g_bTourneyInternal = true;
	FakeClientCommand(c, "sm_pause");
	g_bTourneyInternal = false;
}

/** From OnRoundIsLive: a freeze that waited through a ready-up lands now. */
void Tourney_OnRoundLive()
{
	if (g_bTourneyFrozen) CreateTimer(TOURNEY_FREEZE_DELAY, Timer_TourneyApply, _, TIMER_FLAG_NO_MAPCHANGE);
}

public Action Timer_TourneyApply(Handle timer)
{
	Tourney_Apply();
	return Plugin_Stop;
}

/** Clear the freeze (and tell the site), say who did it when `who` is not
 *  empty, and unpause unless the leave module is still waiting for someone:
 *  it unpauses on its own when they are back. */
void Tourney_Lift(const char[] by, const char[] cause, const char[] who)
{
	if (!g_bTourneyFrozen) return;
	g_bTourneyFrozen = false;
	Tourney_Emit(false, by, cause);
	bool waiting = LeaveAnyAbsent();
	if (who[0] != '\0')
	{
		PrintToChatAll("\x04[Match]\x01 %s lifted the freeze.%s", who,
			!LeaveRotoblinPaused() ? "" : waiting ? " The game stays paused until the dropped player is back." : " Unpausing.");
	}
	if (LeaveRotoblinPaused() && !waiting)
	{
		g_bTourneyInternal = true;
		LeaveUnpauseNow();
		g_bTourneyInternal = false;
	}
}

void Tourney_Emit(bool on, const char[] by, const char[] cause)
{
	EmitPug("ADMINPAUSE state=%s by=%s cause=%s", on ? "on" : "off", by, cause);
}

/** sm_pug_adminpause <token> on|off ["by"]: the desk's Freeze and Unfreeze. */
public Action Cmd_AdminPause(int args)
{
	if (!TokenArgOk(args)) return Plugin_Handled;
	if (args < 2)
	{
		PrintToServer("PUGERR usage: sm_pug_adminpause <token> on|off [\"by\"]");
		return Plugin_Handled;
	}
	char state[8], who[64];
	GetCmdArg(2, state, sizeof(state));
	if (args >= 3) GetCmdArg(3, who, sizeof(who));
	SanitizeChat(who, sizeof(who));
	TrimString(who);
	if (who[0] == '\0') strcopy(who, sizeof(who), "Staff");
	if (StrEqual(state, "on"))
	{
		if (!g_bTourneyFrozen) PrintToChatAll("\x04[Match]\x01 %s froze the game from the site. Only staff can lift it.", who);
		Tourney_Freeze("site", "staff");
	}
	else if (StrEqual(state, "off"))
	{
		Tourney_Lift("site", "staff", who);
	}
	else
	{
		PrintToServer("PUGERR adminpause state is on or off");
		return Plugin_Handled;
	}
	PrintToServer("PUGOK adminpause=%s frozen=%d", state, g_bTourneyFrozen ? 1 : 0);
	return Plugin_Handled;
}

/** sm_pug_lift / !lift from a staff member in game. */
public Action Cmd_Lift(int client, int args)
{
	Tourney_LiftFromGame(client);
	return Plugin_Handled;
}

void Tourney_LiftFromGame(int client)
{
	if (client < 1 || client > MaxClients || !IsClientInGame(client)) return;
	if (!Tourney_IsStaff(client))
	{
		PrintToChat(client, "[Match] Only staff can lift the freeze.");
		return;
	}
	if (!g_bTourneyFrozen)
	{
		PrintToChat(client, "[Match] The game is not frozen.");
		return;
	}
	char id[24], name[MAX_NAME_LENGTH];
	if (!ModCall_AuthId(client, id, sizeof(id))) strcopy(id, sizeof(id), "site");
	GetClientName(client, name, sizeof(name));
	Tourney_Lift(id, "staff", name);
}

/** Rotoblin's unpause commands (sm_ready, sm_r, sm_unpause): refused from
 *  non-staff while the freeze holds a real pause. During a ready-up nothing
 *  is paused and sm_ready is readyup's own, so it passes; so does the
 *  module's own fake command. */
public Action Listener_TourneyUnpause(int client, const char[] command, int argc)
{
	if (!g_bTourneyFrozen || g_bTourneyInternal) return Plugin_Continue;
	if (client < 1 || client > MaxClients || !IsClientInGame(client)) return Plugin_Continue;
	if (!LeaveRotoblinPaused()) return Plugin_Continue;
	if (Tourney_IsStaff(client)) return Plugin_Continue;
	PrintToChat(client, "[Match] Staff froze the game. Only staff can lift it: !lift in game, or the Events desk.");
	return Plugin_Handled;
}
```

- [ ] **Step 2: Hook it into `pug-match.sp` and the other includes**

`pug-match.sp`:
- `#define PLUGIN_VERSION "0.3.25"` (T3b's final review wave took 0.3.24 for `sm_pug_end_kick`; if that wave is not on the branch yet, this is 0.3.24 and the hand-off says so).
- Next to `ConVar g_cvEndKick;`: `ConVar g_cvTournament;                   // 1 = a tournament box: !sub, !admin and the staff freeze (pug-tourney.inc)`.
- In `OnPluginStart`, after `Gg_Init();`: `Tourney_Init();`.
- `ResetMatchState()`: first line `Tourney_Reset();` (before the `g_bReplayFailed = false;` line and `LeaveReset()`, so the lift's line goes out while `g_State` still holds the match (`EmitPug` sends nothing in `MS_None`) and the unpause runs unguarded).
- `Cmd_Abort`: right after `if (!TokenArgOk(args)) return Plugin_Handled;`, before the teardown arguments are read: `Tourney_Lift("site", "reset", "");` with the comment: a teardown unpauses through `LeaveUnpauseNow` (`BeginTeardown`), which the freeze would otherwise refuse.
- `Timer_TeamLock`'s loop: after `if (slot == -1 || !IsClientInGame(c)) continue;` add

```sourcepawn
		if (Tourney_SlotOut(slot))
		{
			// Subbed out (pug-tourney.inc, Ruling 5): never placed, and taken off a side whenever they sit on one.
			int t = GetClientTeam(c);
			if (t == TEAM_SURVIVOR || t == TEAM_INFECTED) ChangeClientTeam(c, TEAM_SPEC);
			continue;
		}
```

  (a plain skip would leave a replaced player free to rejoin a side and play on their old slot; `RosterLateJoiners` already leaves them alone because `g_iClientRoster` is set).
- `CheckRosterMismatch`'s loop: `if (slot == -1 || !IsClientInGame(c) || Tourney_SlotOut(slot)) { continue; }`.
- `OnRoundIsLive`: inside its `MS_Live` branch, right after `RplOpen();` (the `RosterLateJoiners(); CheckRosterMismatch(); RplOpen();` trio), add `Tourney_OnRoundLive();` (not as the function's last statement: that is the `MS_Ended` replay branch, and an early `return` sits above it).
- `OnClientDisconnect`: after `StaffChat_OnDisconnect(client);`: `Tourney_OnDisconnect(client);`.
- `Cmd_Status`: after `PauseStatus();` and before `DumpLine("STATUS end");`: `Tourney_Status();`.
- The includes at the end (lines 5285-5290): `#include "pug-tourney.inc"` after `#include "pug-gg.inc"`, with the comment `// Last: reads pug-leave.inc's pause state and pug-modcall.inc's cooldown.`

`pug-leave.inc`:
- `Event_LeaveDisconnect`: the slot check becomes `if (slot < 0 || g_fAbsentSince[slot] > 0.0 || Tourney_SlotOut(slot)) return Plugin_Continue;`.
- `LeaveUnpauseNow`: first line `if (TourneyFrozen()) return;` with the comment: the staff freeze holds the pause; `Tourney_Lift` calls this once lifted, so nothing is lost.
- After `LeaveRelease`:

```sourcepawn
/** A slot subbed out (pug-tourney.inc): whatever it was spending or holding
 *  is forgotten, so a replaced player who never comes back is not an
 *  abandon. If the pause was waiting for them alone, it is handed to the
 *  teams to lift. */
void LeaveForget(int slot)
{
	if (slot < 0 || slot >= MAX_ROSTER) return;
	g_fAbsentSince[slot] = 0.0;
	g_fHoldSince[slot] = 0.0;
	g_iLeaveWarned[slot] = 0;
	if (g_bLeavePaused && !LeaveAnyAbsent())
	{
		g_bLeavePaused = false;
		g_bLeaveUnpausing = false;
		PrintToChatAll("\x04[PUG]\x01 Nobody is missing any more. Both teams type \x05!ready\x01 to unpause.");
	}
}
```

`pug-pause.inc`:
- `PhaseFields`, the paused branch: after the `Format(out, len, "%s=%s team=%d limit=%d leave=%d", ...)` line add `if (TourneyFrozen()) Format(out, len, "%s admin=1", out);` (before the `by=` line; the comment: the staff freeze, plan T3c, so the site's pause ledger and live page know).
- `PauseClockTick`, where a pause is first seen: `g_iPauseOwner = g_bLeavePaused ? 0 : g_iPausePendingTeam;` becomes `g_iPauseOwner = (g_bLeavePaused || TourneyFrozen()) ? 0 : g_iPausePendingTeam;` and the `by=` condition `if (g_bLeavePaused || GetEngineTime() - g_fPausePendingAt > PAUSE_BY_WINDOW)` gains `|| TourneyFrozen()`, with the comment: a pause the staff freeze caused is nobody's either (plan T3c); `g_iPausePendingTeam` may hold a stale request Rotoblin refused, which must not be charged for it.
- `PauseClockTick`, the ceiling: `if (ceiling <= 0 || g_iPauseOwner == 0) return;` becomes `if (ceiling <= 0 || g_iPauseOwner == 0 || TourneyFrozen()) return;` with the comment: a team's pause held by the staff freeze does not run out under it (the expiry path would call `LeaveUnpauseNow`, which the freeze refuses, say "Unpausing." and emit `PAUSE_EXPIRED` for nothing); the freeze decides when the game resumes, and the clock picks up again once it is lifted.

`pug-modcall.inc`, `OnClientSayCommand`: after the `StaffChat_OnSay` line add:

```sourcepawn
	// A tournament box's !sub, !admin and !lift (pug-tourney.inc); a pending /mod detail line still wins below.
	if (!g_bAwaitDetails[client] && Tourney_OnSay(client, text)) return Plugin_Stop;
```

`pug-gg.inc`: `Gg_Count`: `if (slot == -1 || g_iRosterTeam[slot] != g_iGgTeam || Tourney_SlotOut(slot)) continue;`; `Cmd_Gg`'s refusal `if (slot == -1 || (gt != TEAM_SURVIVOR && gt != TEAM_INFECTED))` becomes `if (slot == -1 || Tourney_SlotOut(slot) || (gt != TEAM_SURVIVOR && gt != TEAM_INFECTED))` (a replaced player can neither start nor carry a forfeit vote).

`plugin/build.sh`: add `cp pug-tourney.inc "$SCRIPTING/pug-tourney.inc"` after the `pug-gg.inc` copy and `$SCRIPTING/pug-tourney.inc` to the one-line `CLEANUP`.

`plugin/README.md` keeps no version history (versions sit per row as "0.3.x and later"): add to the RCON commands table a `sm_pug_sub` row (`<token> <out64> <in64>`, 0.3.25 and later, the site's answer to a captain's `!sub` on a tournament box: the outgoing slot keeps its stats and is marked out, the sub is rostered on the same team from the maps finished so far; answers `PUGOK sub ...`, `PUGOK sub already` or `PUGERR ...`) and a `sm_pug_adminpause` row (`<token> on|off ["by"]`, 0.3.25 and later, the staff freeze from the Events desk; answers `PUGOK adminpause=<state> frozen=<0|1>`), and to the Cvars table a `sm_pug_tournament` row (default `0`, 0.3.25 and later: `1` is a tournament box, set by the site's booking runner; turns on `!sub`, `!admin` with the staff-only freeze and `!lift`; `0` leaves `!admin` to SourceMod).

- [ ] **Step 3: Compile**

Run: `plugin/build.sh`
Expected: `pug-match.smx` compiles with no errors; warnings only ones the file already had. Read the compiler's output for unused-variable or tag warnings in the new include and fix them. Then `npx vitest run tests/eventKindsParity.test.ts tests/statKeysParity.test.ts` (both still pass: no new event kinds, no new stat keys).

- [ ] **Step 4: Read-through**

Before committing, read every unpause path once more against Review Focus 1: `LeaveUnpauseNow` (guarded before its first line, so `g_bLeavePaused` is left as it was), `Tourney_Lift` (unguards first), `Tourney_Reset` from `ResetMatchState` (before `LeaveReset`), `Cmd_Abort` (before `BeginTeardown`), `PauseClockTick` (owner 0 for a pause begun under the freeze, and no ceiling at all while frozen, so neither the freeze's pause nor a team's pause it holds can expire under it), `Timer_LeaveUnpause` (calls `LeaveUnpauseNow`: refused while frozen; `g_bLeavePaused` stays true and `Tourney_Lift` then unpauses because nobody is absent). Also the `sm_admin` listener: SourceMod's adminmenu registers `sm_admin` with `RegAdminCmd`, and whether a listener fires for a non-admin before the access check, or a chat trigger still reaches the command after the say forward returned `Plugin_Stop`, is not documented (pug-modcall.inc's header says the same of `!mod`); the 0.5 s reopen guard makes either answer harmless, and the owner's in-game check (Step 5) settles it.

- [ ] **Step 5: The owner's in-game checks (written into the hand-off, not run by this plan)**

On the local server with `rotoblin_cheats_4v4` and `sm_pug_tournament 1` pushed by hand, with a backend match loaded through `sm_pug_match`: `!sub` during a live half is refused; at a ready-up it emits the SUB line (visible in the server log) and `sm_pug_sub <token> <out> <in>` from the console moves the sub onto the right side within two seconds and the replaced player to spectators; `!admin why` from a non-admin freezes the game (pause panel up), `!ready` from a player is refused with the staff line, `!lift` from an admin unpauses on Rotoblin's countdown; `sm_pug_adminpause <token> on` and `off` from the console do the same and answer `PUGOK`; `!admin` during a ready-up freezes one second after the round goes live; `sm_pug_abort <token>` while frozen leaves the box unpaused; on a box with `sm_pug_tournament 0`, `!admin` still opens the admin menu for an admin and says "no access" to a player, and `!sub` is just chat.

- [ ] **Step 6: Commit**

```bash
git add plugin/pug-tourney.inc plugin/pug-match.sp plugin/pug-leave.inc plugin/pug-pause.inc plugin/pug-modcall.inc plugin/pug-gg.inc plugin/build.sh plugin/README.md
git commit -m "pug-match 0.3.25: tournament boxes take !sub between chapters, !admin calls staff and freezes the game until staff lift it, and the site drives the freeze and the sub over rcon"
```

---
### Task 6: The series engine, part 1: subs, the freeze, the staff DM, and the server's dispatch

**Files:**
- Modify: `src/events/series.ts`, `src/events/messages.ts`, `src/events/notices.ts`, `src/notify/notify.ts`, `src/server.ts`
- Test: `tests/series.test.ts`, `tests/seriesFixture.ts`, `tests/notify.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 5; `R.subPlayer`, `R.setAdminPause`, `B.swapPlayer`, `addTournamentSub`, `runner.send`, `parseLogDatagram`, `handleModCall`, `quoted`, `consoleText` (`src/serverSetup.ts`), `getPlayer`.
- Produces in `messages.ts`: `type StaffAction = 'ready' | 'veto' | 'lineup' | 'veto_reopened' | 'chapter_replayed' | 'server_moved' | 'grace_extended' | 'hold_released' | 'frozen' | 'unfrozen'`; `EventNotifyType` gains `'event_match_staff'`; `eventMessage(..., 'event_match_staff', { matchId, what, detail? })`.
- Produces in `notices.ts`: `tellStaffAction(d, eventId, matchId, what: StaffAction, detail?: string)` to both rosters.
- Produces in `notify.ts`: `NotifyType` and `NOTIFY_TYPES` gain `event_match_staff` with the label `Staff act on a tournament match of mine (a freeze, a reopened veto, a replayed chapter, a moved server, more time, a released hold)`.
- Produces in `series.ts`:
  - `SeriesRunner` gains `send(bookingId, lines, what): Promise<string[] | null>`, `replayGame(bookingId, gameMatchId, snap: RestoreSnapshot): Promise<'ok' | 'refused' | 'busy'>`, `moveBooking(bookingId): Promise<number | null>`.
  - `subRequested(token: string, by: string, outId: string, inId: string): Promise<void>` (Rulings 4 to 6; Review Focus 2).
  - `adminPauseLine(token: string, on: boolean, by: string | null, cause: 'call' | 'staff' | 'reset'): void` (Ruling 9).
  - `freeze(matchId: number, by: string, on: boolean): Promise<V.Checked<P.MatchRow>>` (the desk's Freeze and Unfreeze).
- Produces in `server.ts`: `sub_request` lines go to `seriesRef.subRequested`, `admin_pause` lines to `seriesRef.adminPauseLine`, each guarded.
- Produces in `tests/seriesFixture.ts`: `line(body: string): Promise<void>` (parses `PUG <token> ...` or `PUGCALL ...` as the listener would and dispatches as `server.ts` does); `box.subOk` and `box.freezeOk` (default true) answering `PUGOK sub out=...` and `PUGOK adminpause=...` or `PUGERR ...`; `liveGameToken(): string`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/notify.test.ts`'s type-list test (next to the `event_match_connect` pair):

```ts
    expect(NOTIFY_TYPES.find((t) => t.type === 'event_match_staff')).toEqual({
      type: 'event_match_staff', label: 'Staff act on a tournament match of mine (a freeze, a reopened veto, a replayed chapter, a moved server, more time, a released hold)',
    });
```

Append to `tests/series.test.ts` (`ADMIN`, `A`, `BATS`, `MIN`, `R`, `B` (the bookings module) are imported there; add `import { EVENT_ERRORS } from '../src/events/validate.js';`):

```ts
describe('SeriesEngine: subs from the box (plan T3c)', () => {
  const live = async () => {
    f = await seriesFixture();
    await f.tick();
    f.box.humans = [...A.slice(0, 4), ...BATS.slice(0, 4), A[4]!];
    f.goLive(f.gameOf(1).match_id!);
    return f.liveGameToken();
  };
  it('puts a registered member in for a locked player: lineup, booking people, the game roster, the box, a chat line', async () => {
    const token = await live();
    const g1 = f.gameOf(1).match_id!;
    f.sent.length = 0;
    await f.line(`PUG ${token} SUB by=${A[1]} out=${A[3]} in=${A[4]} map=0`);
    expect(R.lineupFour(f.db, f.matchId, f.entryA)).toEqual([A[0], A[1], A[2], A[4]]);
    expect(B.peopleOf(f.db, f.booking().id).filter((p) => p.side === 'a').map((p) => [p.steamid, p.role]).sort()).toEqual([[A[0], 'player'], [A[1], 'player'], [A[2], 'player'], [A[3], 'spectator'], [A[4], 'player']].sort());
    expect(f.db.prepare('SELECT team, joined_map, source FROM match_players WHERE match_id = ? AND player_id = ?').get(g1, A[4]!)).toEqual({ team: 'b', joined_map: 0, source: 'web' });
    expect(f.sent).toContain(`sm_pug_sub ${token} ${A[3]} ${A[4]}`);
    expect(f.sent.some((c) => /^say \[Match\] .+ is in for .+ \(Rats, sub 1 of 2\)\.$/.test(c))).toBe(true);
    expect(f.pushes).toContain(f.matchId);
    expect(f.send).not.toHaveBeenCalledWith(expect.anything(), 'event_match_staff', expect.anything());
    // Later games are rostered with the sub.
    f.endGame(g1, [{ map: 'm1', a: 100, b: 900 }]);
    expect(f.match().status).toBe('confirming');
  });

  it('refuses on the box with the site\'s sentence, and re-sends a sub the box did not take', async () => {
    const token = await live();
    f.sent.length = 0;
    await f.line(`PUG ${token} SUB by=${BATS[0]} out=${A[3]} in=${A[4]} map=0`);
    expect(f.sent.some((c) => c.startsWith(`say [Match] Sub refused: ${EVENT_ERRORS.not_manager.text}`))).toBe(true);
    expect(R.lineupFour(f.db, f.matchId, f.entryA)).toEqual(A.slice(0, 4));
    await f.line(`PUG ${token} SUB by=${A[0]} out=${A[3]} in=${BATS[0]} map=0`);
    expect(f.sent.some((c) => c.startsWith(`say [Match] Sub refused: ${EVENT_ERRORS.sub_not_member.text}`))).toBe(true);
    f.box.subOk = false;
    await f.line(`PUG ${token} SUB by=${A[0]} out=${A[3]} in=${A[4]} map=0`);
    expect(R.lineupFour(f.db, f.matchId, f.entryA)).toEqual([A[0], A[1], A[2], A[4]]);
    expect(f.sent.some((c) => c.includes('the server did not take it'))).toBe(true);
    f.box.subOk = true;
    f.sent.length = 0;
    await f.line(`PUG ${token} SUB by=${A[0]} out=${A[3]} in=${A[4]} map=0`);
    expect(f.sent).toContain(`sm_pug_sub ${token} ${A[3]} ${A[4]}`);
    expect(R.subsUsed(f.db, f.match(), 'a')).toBe(1);
  });

  it('counts the stage\'s limit and refuses the third sub of a side', async () => {
    const token = await live();
    await f.line(`PUG ${token} SUB by=${A[0]} out=${A[3]} in=${A[4]} map=0`);
    await f.line(`PUG ${token} SUB by=${A[0]} out=${A[4]} in=${A[3]} map=0`);
    f.sent.length = 0;
    await f.line(`PUG ${token} SUB by=${A[0]} out=${A[3]} in=${A[4]} map=0`);
    expect(f.sent.some((c) => c.startsWith(`say [Match] Sub refused: ${EVENT_ERRORS.sub_limit.text}`))).toBe(true);
  });
});

describe('SeriesEngine: the staff freeze (plan T3c)', () => {
  const live = async () => {
    f = await seriesFixture();
    await f.tick();
    f.goLive(f.gameOf(1).match_id!);
    return f.liveGameToken();
  };
  it('mirrors the box\'s ADMINPAUSE lines, alerting staff on a call', async () => {
    const token = await live();
    await f.line(`PUG ${token} ADMINPAUSE state=on by=${A[2]} cause=call`);
    expect(f.match()).toMatchObject({ admin_pause_at: new Date(f.t.t).toISOString(), admin_pause_by: A[2] });
    expect(f.alerts.filter((a) => a.kind === 'problem' && a.text.includes('called staff from the server'))).toHaveLength(1);
    await f.line(`PUG ${token} ADMINPAUSE state=on by=${A[2]} cause=call`);
    expect(f.alerts.filter((a) => a.kind === 'problem' && a.text.includes('called staff'))).toHaveLength(1);
    await f.line(`PUG ${token} ADMINPAUSE state=off by=site cause=reset`);
    expect(f.match().admin_pause_at).toBeNull();
    await f.line(`PUG ${'0'.repeat(32)} ADMINPAUSE state=on by=site cause=staff`);
    expect(f.match().admin_pause_at).toBeNull();
  });

  it('freezes and unfreezes from the desk through the box, telling both rosters', async () => {
    const token = await live();
    f.sent.length = 0;
    const r = await f.series.freeze(f.matchId, ADMIN, true);
    expect(r.ok).toBe(true);
    expect(f.sent.find((c) => c.startsWith('sm_pug_adminpause '))).toBe(`sm_pug_adminpause ${token} on "boss"`);
    expect(f.match().admin_pause_by).toBe(ADMIN);
    expect(f.send).toHaveBeenCalledWith(expect.arrayContaining([A[0], BATS[0]]), 'event_match_staff', expect.objectContaining({ content: expect.stringContaining('staff froze the game') }));
    expect(await f.series.freeze(f.matchId, ADMIN, true)).toEqual({ ok: false, error: 'already_frozen' });
    // The box's own line for the same change is a no-op.
    await f.line(`PUG ${token} ADMINPAUSE state=on by=site cause=staff`);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE action = 'match_frozen'").get()).toEqual({ n: 1 });
    f.box.down = true;
    expect(await f.series.freeze(f.matchId, ADMIN, false)).toEqual({ ok: false, error: 'no_box' });
    f.box.down = false;
    expect((await f.series.freeze(f.matchId, ADMIN, false)).ok).toBe(true);
    expect(f.match().admin_pause_at).toBeNull();
    f.endGame(f.gameOf(1).match_id!, [{ map: 'm1', a: 100, b: 900 }]);
    expect(await f.series.freeze(f.matchId, ADMIN, true)).toEqual({ ok: false, error: 'not_live_phase' });
  });
});
```

(`ADMIN` is named `boss` in `tests/eventFixture.ts` and `tests/entryFixture.ts`; in `series.test.ts` `B` is the bookings module and the Bats players are `BATS`, hence `BATS[0]` above.)

- [ ] **Step 2: Extend the fixture**

In `tests/seriesFixture.ts`: `box` gains `subOk: true, freezeOk: true, resumeOk: false` (Task 4 added `resumeOk`); the rcon fake answers `` `PUGOK sub out=x in=y slot=8` `` or `'PUGERR not rostered'` to a line starting `sm_pug_sub `, `` `PUGOK adminpause=${on} frozen=${on === 'on' ? 1 : 0}` `` or `'PUGERR no match configured'` to `sm_pug_adminpause `, and `'PUGOK resumed maps=0 roster=8'` or `'PUGERR resume incomplete'` to `sm_pug_resume_commit`. Add to the returned object:

```ts
    liveGameToken: () => (db.prepare("SELECT token FROM matches WHERE booking_id = ? AND state = 'live' ORDER BY id DESC LIMIT 1").get(P.getMatch(db, f.matchId)!.booking_id!) as { token: string }).token,
    async line(body) {
      const head = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]);
      const ev = parseLogDatagram(Buffer.concat([head, Buffer.from(`L 10/07/2026 - 20:00:00: ${body}\n`, 'utf8')]));
      if (!ev) throw new Error(`fixture line did not parse: ${body}`);
      if (ev.kind === 'sub_request') await series!.subRequested(ev.token, ev.by, ev.out, ev.in);
      else if (ev.kind === 'admin_pause') series!.adminPauseLine(ev.token, ev.on, ev.by, ev.cause);
      else if (ev.kind === 'call') handleModCall(db, ev, serverId, { adminSteamIds: [], now: new Date(t.t) });
      else throw new Error(`fixture line is not dispatched here: ${ev.kind}`);
      await settle();
    },
```

with `import { parseLogDatagram } from '../src/logParse.js';` and `import { handleModCall } from '../src/modCalls.js';`.

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run tests/series.test.ts tests/notify.test.ts`
Expected: FAIL (`subRequested`, `adminPauseLine`, `freeze` are not functions; the DM type is unknown).

- [ ] **Step 4: The DM type**

`src/notify/notify.ts`: add `| 'event_match_staff'` to `NotifyType` and `{ type: 'event_match_staff', label: 'Staff act on a tournament match of mine (a freeze, a reopened veto, a replayed chapter, a moved server, more time, a released hold)' }` at the end of `NOTIFY_TYPES`.

`src/events/messages.ts`: `EventNotifyType` gains `| 'event_match_staff'`; add

```ts
/** What staff did on the desk (plan T3c Ruling 17), one sentence each. */
export type StaffAction = 'ready' | 'veto' | 'lineup' | 'veto_reopened' | 'chapter_replayed' | 'server_moved' | 'grace_extended' | 'hold_released' | 'frozen' | 'unfrozen';
const STAFF_TEXT: Record<StaffAction, string> = {
  ready: 'pressed Ready for a team', veto: 'took a veto step for a team', lineup: 'locked a lineup for a team',
  veto_reopened: 'reopened the veto; the room starts again from the first step',
  chapter_replayed: 'had a chapter replayed from its start', server_moved: 'moved the match to another server; a new connect line follows',
  grace_extended: 'extended the time to connect', hold_released: 'released the hold on the match',
  frozen: 'froze the game; only staff can unfreeze it', unfrozen: 'unfroze the game',
};
```

`eventMessage`'s `extra` type gains `what?: StaffAction; detail?: string`, and the `case 'event_match_connect': case 'event_match_result':` group gains `case 'event_match_staff':` with, inside, before the connect branch:

```ts
      if (type === 'event_match_staff') {
        const detail = extra.detail ? ` (${escapeName(extra.detail)})` : '';
        content = `${a} vs ${b} in ${event}: staff ${STAFF_TEXT[extra.what ?? 'hold_released']}${detail}.`;
      } else if (type === 'event_match_connect') {
```

(the existing `if (type === 'event_match_connect') { ... } else { ... }` becomes this three-way chain; the return with the room link is shared.)

`src/events/notices.ts`:

```ts
/** A desk action (plan T3c Ruling 17): both rosters, one sentence. */
export function tellStaffAction(d: NoticeDeps, eventId: number, matchId: number, what: StaffAction, detail?: string): void {
  tell(d, rostersOf(d, matchId), eventId, 'event_match_staff', { matchId, what, detail });
}
```

with `StaffAction` imported from `./messages.js`.

- [ ] **Step 5: series.ts, part 1**

Imports: `import { addTournamentSub, createTournamentGame, gameLinesOf, isPendingGame } from '../bookings/tournamentGames.js';` (extend the existing line), `import { replayableChapters, restoreSnapshot, type RestoreSnapshot } from '../bookings/restore.js';`, `import { consoleText, quoted } from '../serverSetup.js';`, `import { getServer } from '../serverPool.js';`, and `tellStaffAction` added to the `./notices.js` import. `SeriesRunner` becomes:

```ts
export interface SeriesRunner {
  announce(bookingId: number, text: string): void;
  settle(bookingId: number): void;
  onCancelled(bookingId: number, by: string | null, reason: string | null): void;
  /** Plan T3c: one burst with the replies, a chapter replay, a move. */
  send(bookingId: number, lines: string[], what: string): Promise<string[] | null>;
  replayGame(bookingId: number, gameMatchId: number, snap: RestoreSnapshot): Promise<'ok' | 'refused' | 'busy'>;
  moveBooking(bookingId: number): Promise<number | null>;
}
```

Add to the class, after `staffResult`:

```ts
  // ---------- subs, the freeze and the desk tools (plan T3c) ----------

  /** The event match a tournament game's token belongs to, with its game row. */
  private matchOfToken(token: string): { m: P.MatchRow; game: R.GameRow; gameMatchId: number } | null {
    const row = this.db.prepare("SELECT id, booking_id FROM matches WHERE token = ? AND kind = 'tournament'").get(token) as { id: number; booking_id: number | null } | undefined;
    if (!row || row.booking_id === null) return null;
    const m = R.matchOfBooking(this.db, row.booking_id);
    if (!m) return null;
    const game = R.gamesOf(this.db, m.id).find((g) => g.match_id === row.id);
    return game ? { m, game, gameMatchId: row.id } : null;
  }

  /** The game of this match being played right now (a live matches row), or null. */
  private liveGameOf(m: P.MatchRow): { game: R.GameRow; token: string } | null {
    for (const game of R.gamesOf(this.db, m.id)) {
      if (game.match_id === null || game.ended_at !== null) continue;
      const row = this.db.prepare("SELECT token FROM matches WHERE id = ? AND state = 'live'").get(game.match_id) as { token: string | null } | undefined;
      if (row?.token) return { game, token: row.token };
    }
    return null;
  }

  /** The booking of a match while it runs on a box and is not being recovered, or null. */
  private runningBooking(m: P.MatchRow): B.BookingRow | null {
    const b = m.booking_id !== null ? B.getBooking(this.db, m.booking_id) : undefined;
    return b && B.isOpen(b) && b.server_id !== null && (b.state === 'ready' || b.state === 'active') && b.recovering_at === null ? b : null;
  }

  private playerName(steamid: string): string {
    return consoleText(getPlayer(this.db, steamid)?.name ?? steamid, 40);
  }

  /** A captain's !sub, forwarded by the box (Rulings 4 to 6). Everything the
   *  site decides is decided here, in room.ts; the box hears the answer in
   *  chat. A sub already recorded (the box did not take the command the first
   *  time) is sent again rather than refused (Review Focus 2). */
  async subRequested(token: string, by: string, outId: string, inId: string): Promise<void> {
    const found = this.matchOfToken(token);
    if (!found) return;
    const { m, game, gameMatchId } = found;
    const b = m.booking_id !== null ? B.getBooking(this.db, m.booking_id) : undefined;
    if (!b || !B.isOpen(b) || b.server_id === null) return;
    const now = new Date(this.now());
    const say = (text: string) => this.deps.runner.announce(b.id, text);
    const limit = stageRules(this.db, E.getStage(this.db, m.stage_id)!).subs.perMatch;
    const recorded = this.db.prepare(
      `SELECT json_extract(detail, '$.side') AS side, json_extract(detail, '$.used') AS used FROM event_log
        WHERE event_id = ? AND action = 'player_subbed' AND json_extract(detail, '$.matchId') = ? AND json_extract(detail, '$.out') = ? AND json_extract(detail, '$.in') = ?
        ORDER BY id DESC LIMIT 1`,
    ).get(m.event_id, m.id, outId, inId) as { side: Side; used: number } | undefined;
    const inFour = recorded !== undefined && (R.lineupFour(this.db, m.id, R.entryOn(m, recorded.side)) ?? []).includes(inId);
    let side: Side;
    let used: number;
    if (inFour) {
      side = recorded!.side;
      used = recorded!.used;
    } else {
      const r = R.subPlayer(this.db, { matchId: m.id, by, outId, inId, limit, gameId: game.id, now });
      if (!r.ok) {
        say(`Sub refused: ${V.EVENT_ERRORS[r.error].text}`);
        return;
      }
      side = r.value.side;
      used = r.value.used;
      const swapped = B.swapPlayer(this.db, { bookingId: b.id, side, outId, inId, now });
      if (!swapped.ok) console.error(`[series] match ${m.id}: booking ${b.id} did not swap ${outId} for ${inId} (${swapped.error})`);
      const team = (this.db.prepare('SELECT team FROM match_players WHERE match_id = ? AND player_id = ?').get(gameMatchId, outId) as { team: 'a' | 'b' } | undefined)?.team;
      if (team) addTournamentSub(this.db, { matchId: gameMatchId, inId, team, now });
    }
    const replies = await this.deps.runner.send(b.id, [`sm_pug_sub ${token} ${outId} ${inId}`], 'the sub');
    const took = (replies?.[0] ?? '').trim().startsWith('PUGOK');
    if (took) say(`${this.playerName(inId)} is in for ${this.playerName(outId)} (${this.name(m, side)}, sub ${used} of ${limit}).`);
    else say(`The site put ${this.playerName(inId)} in for ${this.playerName(outId)}, but the server did not take it; type the !sub again.`);
    console.log(`[series] match ${m.id}: ${inId} in for ${outId} on side ${side} (game ${game.ordinal}; the box ${took ? 'took it' : 'did not take it'})`);
    this.push(m.id);
  }

  /** The box's ADMINPAUSE line (Ruling 9): the freeze as it stands there. A
   *  call alerts staff on the feed (the Discord card is the mod-call poster's). */
  adminPauseLine(token: string, on: boolean, by: string | null, cause: 'call' | 'staff' | 'reset'): void {
    const found = this.matchOfToken(token);
    if (!found) return;
    const { m } = found;
    const r = R.setAdminPause(this.db, { matchId: m.id, on, by, cause, now: new Date(this.now()) });
    if (!r.ok) return;
    if (on && cause === 'call') {
      const who = by ? getPlayer(this.db, by)?.name ?? by : 'a player';
      this.alert(m, `${who} called staff from the server with !admin. The game is frozen until staff lift it (Unfreeze on the Events desk, or !lift in game).`);
    }
    this.push(m.id);
  }

  /** The desk's Freeze and Unfreeze (Ruling 9): the box first, then the
   *  column, then both rosters. The box's own line for the same change
   *  arrives after and changes nothing. */
  async freeze(matchId: number, by: string, on: boolean): Promise<V.Checked<P.MatchRow>> {
    const m = P.getMatch(this.db, matchId);
    if (!m) return V.fail('match_not_found');
    if (m.status !== 'connect' && m.status !== 'live') return V.fail('not_live_phase');
    if (on === (m.admin_pause_at !== null)) return V.fail(on ? 'already_frozen' : 'not_frozen');
    const live = this.liveGameOf(m);
    if (!live) return V.fail('no_live_game');
    const b = m.booking_id !== null ? B.getBooking(this.db, m.booking_id) : undefined;
    if (!b || b.server_id === null || !B.isOpen(b)) return V.fail('no_box');
    const who = consoleText(getPlayer(this.db, by)?.name ?? 'Staff', 40);
    const replies = await this.deps.runner.send(b.id, [`sm_pug_adminpause ${live.token} ${on ? 'on' : 'off'} ${quoted(who)}`], on ? 'the freeze' : 'the unfreeze');
    if (!(replies?.[0] ?? '').trim().startsWith('PUGOK')) return V.fail('no_box');
    const r = R.setAdminPause(this.db, { matchId: m.id, on, by, cause: 'staff', now: new Date(this.now()) });
    if (!r.ok && r.error !== 'already_frozen' && r.error !== 'not_frozen') return r;
    tellStaffAction(this.deps, m.event_id, m.id, on ? 'frozen' : 'unfrozen');
    this.push(m.id);
    return V.ok(P.getMatch(this.db, m.id)!);
  }
```

(`Side` is already imported from `./veto.js`.)

- [ ] **Step 6: server.ts**

In the log event handler, right after the `if (ev.kind === 'gg') { ... return; }` block:

```ts
        if (ev.kind === 'sub_request') {
          // A captain's !sub on a tournament box (plan T3c): the series engine decides and answers on the box.
          seriesRef?.subRequested(ev.token, ev.by, ev.out, ev.in).catch((err) => { console.error('[series] sub request failed:', err); });
          return;
        }
        if (ev.kind === 'admin_pause') {
          try { seriesRef?.adminPauseLine(ev.token, ev.on, ev.by, ev.cause); } catch (err) { console.error('[series] admin pause line failed:', err); }
          return;
        }
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/series.test.ts tests/notify.test.ts tests/eventRoomRoutes.test.ts tests/adminEventRoutes.test.ts`
Expected: PASS (the route plugins' structural `series` types are untouched by this task).

- [ ] **Step 8: Commit**

```bash
git add src/events/series.ts src/events/messages.ts src/events/notices.ts src/notify/notify.ts src/server.ts tests/series.test.ts tests/seriesFixture.ts tests/notify.test.ts
git commit -m "Tournaments T3c: the series engine approves subs from the box and answers it, mirrors the staff freeze from the box's lines, freezes and unfreezes from the desk, and tells both rosters what staff did"
```

---

### Task 7: The series engine, part 2: replay a chapter, move server, extend grace, release a hold, reopen the veto

**Files:**
- Modify: `src/events/series.ts`
- Test: `tests/series.test.ts`

**Interfaces:**
- Consumes: Tasks 2 to 6; `restoreSnapshot`, `replayableChapters`; `runner.replayGame`, `runner.moveBooking`; `R.noteReplay`, `R.noteMove`, `R.extendGrace`, `R.releaseHold`, `R.reopenVeto`; `B.bookingRules`, `B.cancelBooking`; `campaignDisplayName`; `getServer`.
- Produces in `series.ts`:
  - `replayable(matchId: number): { ordinal: number; map: string }[]`.
  - `replayChapter(matchId: number, by: string, ordinal: unknown): Promise<V.Checked<{ map: string }>>` (Ruling 12).
  - `moveServer(matchId: number, by: string): Promise<V.Checked<P.MatchRow>>` (Ruling 13).
  - `extendGrace(matchId: number, by: string, minutes: unknown): V.Checked<P.MatchRow>` (Ruling 14).
  - `releaseHold(matchId: number, by: string): V.Checked<P.MatchRow>` (Ruling 15).
  - `reopenVeto(matchId: number, by: string): V.Checked<P.MatchRow>` (Ruling 11; cancels an open booking first).

- [ ] **Step 1: Write the failing tests**

Append to `tests/series.test.ts`:

```ts
describe('SeriesEngine: the desk tools (plan T3c)', () => {
  it('replays a chapter of the live game through the box and tells both rosters; refuses the finale and a chapter not reached', async () => {
    f = await seriesFixture();
    await f.tick();
    const g1 = f.gameOf(1).match_id!;
    f.goLive(g1, 'l4d_vs_hospital03_sewers');
    const round = f.db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, ended_at) VALUES (?, ?, ?, ?, ?, datetime('now'))");
    round.run(g1, 0, 1, 'a', 300); round.run(g1, 0, 2, 'b', 200); round.run(g1, 1, 1, 'a', 100); round.run(g1, 1, 2, 'b', 150); round.run(g1, 2, 1, 'a', 10);
    f.db.prepare("INSERT INTO match_live_maps (match_id, ordinal, map, team_a_score, team_b_score) VALUES (?, 0, 'l4d_vs_hospital01_apartment', 300, 200), (?, 1, 'l4d_vs_hospital02_subway', 100, 150), (?, 2, 'l4d_vs_hospital03_sewers', 0, 0)").run(g1, g1, g1);
    expect(f.series.replayable(f.matchId)).toEqual([
      { ordinal: 0, map: 'l4d_vs_hospital01_apartment' }, { ordinal: 1, map: 'l4d_vs_hospital02_subway' }, { ordinal: 2, map: 'l4d_vs_hospital03_sewers' },
    ]);
    expect(await f.series.replayChapter(f.matchId, ADMIN, 3)).toEqual({ ok: false, error: 'chapter_not_replayable' });
    expect(await f.series.replayChapter(f.matchId, ADMIN, 'x')).toEqual({ ok: false, error: 'chapter_not_replayable' });
    f.box.resumeOk = true;
    f.sent.length = 0;
    expect(await f.series.replayChapter(f.matchId, ADMIN, 1)).toEqual({ ok: true, value: { map: 'l4d_vs_hospital02_subway' } });
    expect(f.sent).toContain('changelevel l4d_vs_hospital02_subway');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM match_rounds WHERE match_id = ?').get(g1)).toEqual({ n: 2 });
    expect(f.db.prepare("SELECT detail FROM event_log WHERE action = 'chapter_replayed'").get()).toEqual({ detail: JSON.stringify({ matchId: f.matchId, gameId: f.gameOf(1).id, ordinal: 1, map: 'l4d_vs_hospital02_subway' }) });
    expect(f.send).toHaveBeenCalledWith(expect.arrayContaining([A[0], BATS[0]]), 'event_match_staff', expect.objectContaining({ content: expect.stringContaining('replayed from its start (chapter 2 of No Mercy)') }));
    expect(f.match().status).toBe('live');
    // The plugin refuses: aborted, held, the route hears replay_failed.
    f.box.resumeOk = false;
    expect(await f.series.replayChapter(f.matchId, ADMIN, 0)).toEqual({ ok: false, error: 'replay_failed' });
    expect(f.match()).toMatchObject({ status: 'admin_hold', hold_reason: 'game_lost', hold_from: 'live' });
    expect(await f.series.replayChapter(f.matchId, ADMIN, 0)).toEqual({ ok: false, error: 'not_live_phase' });
  });

  it('moves the match to another server and notes it; refuses with no spare box only once the wait runs out', async () => {
    f = await seriesFixture();
    await f.tick();
    f.goLive(f.gameOf(1).match_id!, 'l4d_vs_hospital01_apartment');
    f.box.resumeOk = true;
    const old = f.booking().server_id!;
    f.addServer('box2');
    const r = await f.series.moveServer(f.matchId, ADMIN);
    expect(r.ok).toBe(true);
    await f.runner.idle();
    expect(f.booking().server_id).not.toBe(old);
    expect(f.db.prepare("SELECT detail FROM event_log WHERE action = 'server_moved'").get()).toEqual({ detail: JSON.stringify({ matchId: f.matchId, fromServerId: old }) });
    expect(f.send).toHaveBeenCalledWith(expect.arrayContaining([A[0], BATS[0]]), 'event_match_staff', expect.objectContaining({ content: expect.stringContaining('moved the match to another server') }));
    expect(f.match().status).toBe('live');
    // Recovering: a second move is refused.
    f.db.prepare("UPDATE bookings SET recovering_at = ? WHERE id = ?").run(new Date(f.t.t).toISOString(), f.booking().id);
    expect(await f.series.moveServer(f.matchId, ADMIN)).toEqual({ ok: false, error: 'no_box' });
  });

  it('extends the grace and says so on the box; releases a hold back where it came from; reopens the veto and cancels the booking', async () => {
    f = await seriesFixture();
    await f.tick();
    expect(f.series.extendGrace(f.matchId, ADMIN, 61)).toEqual({ ok: false, error: 'bad_minutes' });
    const before = f.match().deadline!;
    const r = f.series.extendGrace(f.matchId, ADMIN, 10);
    expect(r.ok && r.value.deadline).toBe(new Date(Date.parse(before) + 10 * MIN).toISOString());
    expect(f.sent.some((c) => c.startsWith('say [Match] Staff gave both teams 10 more minutes to connect'))).toBe(true);
    expect(f.send).toHaveBeenCalledWith(expect.anything(), 'event_match_staff', expect.objectContaining({ content: expect.stringContaining('extended the time to connect (10 minutes)') }));
    // A hold from connect releases to a fresh grace from the booking's rules.
    R.holdMatch(f.db, { matchId: f.matchId, by: ADMIN, reason: 'Checking', now: new Date(f.t.t) });
    f.t.t += 3 * MIN;
    const released = f.series.releaseHold(f.matchId, ADMIN);
    const grace = B.bookingRules(f.booking())!.noShowGraceMinutes;
    expect(released.ok && released.value).toMatchObject({ status: 'connect', deadline: new Date(f.t.t + grace * MIN).toISOString() });
    expect(f.send).toHaveBeenCalledWith(expect.anything(), 'event_match_staff', expect.objectContaining({ content: expect.stringContaining('released the hold') }));
    expect(f.series.releaseHold(f.matchId, ADMIN)).toEqual({ ok: false, error: 'not_held' });
    // Reopen: a booked room with no game pushed yet (the game row exists, so it is refused) and a room before booking.
    expect(f.series.reopenVeto(f.matchId, ADMIN)).toEqual({ ok: false, error: 'game_started' });
    expect(f.booking().ending_at).toBeNull();
    f.close();
    f = await seriesFixture();
    f.db.prepare("UPDATE servers SET status = 'live'").run();
    await f.tick();
    expect(f.match().status).toBe('booking');
    expect(f.booking().state).toBe('scheduled');
    const reopened = f.series.reopenVeto(f.matchId, ADMIN);
    expect(reopened.ok && reopened.value.status).toBe('veto');
    expect(f.db.prepare('SELECT state FROM bookings').get()).toEqual({ state: 'cancelled' });
    expect(f.match().booking_id).toBeNull();
    expect(f.send).toHaveBeenCalledWith(expect.anything(), 'event_match_staff', expect.objectContaining({ content: expect.stringContaining('reopened the veto') }));
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/series.test.ts`
Expected: FAIL (the five methods and `replayable` are not functions).

- [ ] **Step 3: series.ts, part 2**

Add to the class, after `freeze`:

```ts
  /** The chapters the desk may replay (Ruling 12): empty unless a game is live. */
  replayable(matchId: number): { ordinal: number; map: string }[] {
    const m = P.getMatch(this.db, matchId);
    if (!m || m.status !== 'live') return [];
    const live = this.liveGameOf(m);
    return live ? replayableChapters(this.db, live.game.match_id!) : [];
  }

  /** Ruling 12: the live game is rebuilt on its box from the chapters before
   *  `ordinal` and that chapter loads from its start. A refused resume has
   *  aborted the game and the gameLost hook has held the match by the time
   *  this answers replay_failed. */
  async replayChapter(matchId: number, by: string, ordinal: unknown): Promise<V.Checked<{ map: string }>> {
    const m = P.getMatch(this.db, matchId);
    if (!m) return V.fail('match_not_found');
    if (m.status !== 'live') return V.fail('not_live_phase');
    const live = this.liveGameOf(m);
    if (!live) return V.fail('no_live_game');
    const b = this.runningBooking(m);
    if (!b) return V.fail('no_box');
    if (!Number.isInteger(ordinal) || (ordinal as number) < 0) return V.fail('chapter_not_replayable');
    const snap = restoreSnapshot(this.db, live.game.match_id!, { replayFrom: ordinal as number });
    if (!snap) return V.fail('chapter_not_replayable');
    const r = await this.deps.runner.replayGame(b.id, live.game.match_id!, snap);
    if (r === 'busy') return V.fail('changed');
    if (r === 'refused') return V.fail('replay_failed');
    const noted = R.noteReplay(this.db, { matchId: m.id, by, gameId: live.game.id, ordinal: snap.maps.length, map: snap.map, now: new Date(this.now()) });
    if (!noted.ok) console.error(`[series] match ${m.id}: the replay of ${snap.map} was not noted (${noted.error})`);
    tellStaffAction(this.deps, m.event_id, m.id, 'chapter_replayed', `chapter ${snap.maps.length + 1} of ${campaignDisplayName(this.db, snap.campaign)}`);
    console.log(`[series] match ${m.id}: staff ${by} replayed ${snap.map} of game ${live.game.ordinal}`);
    this.push(m.id);
    return V.ok({ map: snap.map });
  }

  /** Ruling 13: the booking lets go of its box and takes the first idle one
   *  through the runner's recovery; the game is restored there. */
  async moveServer(matchId: number, by: string): Promise<V.Checked<P.MatchRow>> {
    const m = P.getMatch(this.db, matchId);
    if (!m) return V.fail('match_not_found');
    if (m.status !== 'connect' && m.status !== 'live') return V.fail('not_live_phase');
    const b = this.runningBooking(m);
    if (!b) return V.fail('no_box');
    const old = await this.deps.runner.moveBooking(b.id);
    if (old === null) return V.fail('no_box');
    const r = R.noteMove(this.db, { matchId: m.id, by, fromServerId: old, now: new Date(this.now()) });
    if (!r.ok) return r;
    this.alert(m, `staff moved it off ${getServer(this.db, old)?.name ?? `server ${old}`}. It takes the first idle box in its region and the game is restored there; with none free it waits, then is held.`);
    tellStaffAction(this.deps, m.event_id, m.id, 'server_moved');
    this.push(m.id);
    return r;
  }

  /** Ruling 14. */
  extendGrace(matchId: number, by: string, minutes: unknown): V.Checked<P.MatchRow> {
    const r = R.extendGrace(this.db, { matchId, by, minutes, now: new Date(this.now()) });
    if (!r.ok) return r;
    const m = r.value;
    if (m.booking_id !== null) this.deps.runner.announce(m.booking_id, `Staff gave both teams ${minutes as number} more minutes to connect (until ${m.deadline!.slice(11, 16)} UTC).`);
    tellStaffAction(this.deps, m.event_id, m.id, 'grace_extended', `${minutes as number} minutes`);
    this.push(m.id);
    return r;
  }

  /** Ruling 15: the grace of a released connect hold is the booking's. */
  releaseHold(matchId: number, by: string): V.Checked<P.MatchRow> {
    const m = P.getMatch(this.db, matchId);
    if (!m) return V.fail('match_not_found');
    const b = m.booking_id !== null ? B.getBooking(this.db, m.booking_id) : undefined;
    const grace = b ? B.bookingRules(b)?.noShowGraceMinutes ?? 15 : 15;
    const r = R.releaseHold(this.db, { matchId, by, timers: R.roomTimers(this.db), graceMinutes: grace, now: new Date(this.now()) });
    if (!r.ok) return r;
    if (b && B.isOpen(b) && (r.value.status === 'connect' || r.value.status === 'live')) this.deps.runner.announce(b.id, 'Staff released the hold on this match. Play on.');
    tellStaffAction(this.deps, m.event_id, m.id, 'hold_released');
    this.push(m.id);
    return r;
  }

  /** Ruling 11: a booking made meanwhile is cancelled first, as a reset does;
   *  the room's own refusals are checked before anything is cancelled. */
  reopenVeto(matchId: number, by: string): V.Checked<P.MatchRow> {
    const m = P.getMatch(this.db, matchId);
    if (!m) return V.fail('match_not_found');
    // The same checks room.ts makes, in the same order, before any booking is cancelled.
    if (R.gamesOf(this.db, m.id).some((g) => g.match_id !== null)) return V.fail('game_started');
    const from = m.status === 'admin_hold' ? m.hold_from : m.status;
    if (from !== 'veto' && from !== 'lineup' && from !== 'booking') return V.fail('wrong_status');
    if (m.ready_a_at === null || m.ready_b_at === null) return V.fail('not_ready_phase');
    const now = new Date(this.now());
    let cancelled: number | null = null;
    if (m.booking_id !== null) {
      const b = B.getBooking(this.db, m.booking_id);
      if (b && B.isOpen(b)) {
        const c = B.cancelBooking(this.db, { bookingId: b.id, by, staff: true, reason: 'The veto was reopened', now });
        if (!c.ok) return V.fail('booking_open');
        cancelled = b.id;
      }
    }
    const r = R.reopenVeto(this.db, { matchId, by, timers: R.roomTimers(this.db), now });
    if (cancelled !== null) this.deps.runner.onCancelled(cancelled, by, 'The veto was reopened');
    if (!r.ok) return r;
    tellStaffAction(this.deps, m.event_id, m.id, 'veto_reopened');
    this.push(m.id);
    return r;
  }
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/series.test.ts tests/roomClock.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/events/series.ts tests/series.test.ts
git commit -m "Tournaments T3c: the series engine replays a chapter through the box, moves a match to another server, extends the grace, releases a hold where it came from and reopens the veto, telling both rosters each time"
```

---
### Task 8: The desk routes

**Files:**
- Modify: `src/routes/adminEvents.ts`, `src/routes/events.ts` (the `opts.series` type only, widened), `src/server.ts` (nothing new: `series` is already passed; check)
- Test: `tests/eventRoomRoutes.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 6, 7; `logAdmin`, `tellStaffAction`, `R.readyUp`/`actVeto`/`lockLineup` with `staff`, `stagePlayViews(db, ev, { staff: true })` (Task 2 already switched the play route).
- Produces, all `POST /api/admin/events/:id/matches/:matchId/...`, admin only, `{}` on success, `EVENT_ERRORS` sentences on refusal, one `logAdmin` each (Ruling 18), a push, and the staff DM:
  - `act` body `{ kind: 'ready' | 'veto' | 'lineup'; side: 'a' | 'b'; step?: number; action?: string; campaign?: string | null; steamids?: string[] }` -> `event_act_for_team`; a veto step on a live match continues the series (`afterPick`).
  - `reopen-veto` -> `series.reopenVeto`, `event_veto_reopen`.
  - `replay-chapter` body `{ ordinal: number }` -> `series.replayChapter`, `event_chapter_replay`.
  - `move-server` -> `series.moveServer`, `event_server_move`.
  - `extend-grace` body `{ minutes: number }` -> `series.extendGrace`, `event_grace_extend`.
  - `release-hold` -> `series.releaseHold`, `event_hold_release`.
  - `freeze` and `unfreeze` -> `series.freeze(on)`, `event_freeze` / `event_unfreeze`.
  - `GET /api/admin/events/:id/play` rows carry `desk` (Task 2).
- `opts.series` on `adminEventRoutes` gains `freeze(matchId, by, on): Promise<V.Checked<unknown>>; replayChapter(matchId, by, ordinal: unknown): Promise<V.Checked<unknown>>; moveServer(matchId, by): Promise<V.Checked<unknown>>; extendGrace(matchId, by, minutes: unknown): V.Checked<unknown>; releaseHold(matchId, by): V.Checked<unknown>; reopenVeto(matchId, by): V.Checked<unknown>` (every one optional-safe: without `series` the routes answer 404 as confirm and dispute do).

- [ ] **Step 1: Write the failing tests**

Append to `tests/eventRoomRoutes.test.ts` (it builds the app with `buildServer`, which wires the real runner, engine and clock on `f.db`; `get(url, as?)`, `post(url, as, body?)`, `room()`, `f`, `A`, `B`, `ADMIN`, `TIMERS` exist; add `import { EVENT_ERRORS } from '../src/events/validate.js';`; `MOD` is a local of the final review describe, so this describe declares its own and gives it a cookie and the mod flag in a `beforeEach`, exactly as that describe's 403 test does):

```ts
describe('the desk tools (plan T3c)', () => {
  const MOD = '76561199000000711';
  const base = () => `/api/admin/events/${f.eventId}/matches/${f.matchId}`;
  const audit = () => (f.db.prepare("SELECT action FROM admin_actions WHERE action LIKE 'event_%' ORDER BY id").all() as { action: string }[]).map((a) => a.action);
  beforeEach(() => {
    cookies[MOD] = authedCookie(app, f.db, MOD);
    f.db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  });

  it('acts for a team: ready, a veto step and a lineup, each audited and logged as the admin', async () => {
    R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS });
    expect((await post(`${base()}/act`, ADMIN, { kind: 'ready', side: 'c' })).statusCode).toBe(400);
    expect((await post(`${base()}/act`, ADMIN, { kind: 'ready', side: 'a' })).statusCode).toBe(200);
    expect((await post(`${base()}/act`, ADMIN, { kind: 'ready', side: 'b' })).statusCode).toBe(200);
    expect((await post(`${base()}/act`, ADMIN, { kind: 'veto', side: 'b', step: 0, action: 'first' })).json()).toEqual({ error: EVENT_ERRORS.not_your_turn.text });
    expect((await post(`${base()}/act`, ADMIN, { kind: 'veto', side: 'a', step: 0, action: 'first' })).statusCode).toBe(200);
    expect((await post(`${base()}/act`, ADMIN, { kind: 'veto', side: 'a', step: 1, action: 'ban', campaign: 'dead_air' })).statusCode).toBe(200);
    expect((await post(`${base()}/act`, ADMIN, { kind: 'veto', side: 'b', step: 2, action: 'survivors' })).statusCode).toBe(200);
    expect((await post(`${base()}/act`, ADMIN, { kind: 'lineup', side: 'a', steamids: A.slice(0, 4) })).statusCode).toBe(200);
    expect((await post(`${base()}/act`, ADMIN, { kind: 'lineup', side: 'b', steamids: B.slice(0, 4) })).statusCode).toBe(200);
    expect(P.getMatch(f.db, f.matchId)!.status).toBe('booking');
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE actor = ? AND action IN ('room_ready','veto_action','lineup_locked')").get(ADMIN)).toEqual({ n: 7 });
    expect(audit().filter((a) => a === 'event_act_for_team')).toHaveLength(7);
    expect((await post(`${base()}/act`, MOD, { kind: 'ready', side: 'a' })).statusCode).toBe(403);
  });

  it('shows the hold reason, the dispute and the freeze to the desk only, and reopens, extends, releases and freezes through the routes', async () => {
    R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS });
    for (const s of [A[0], B[0]]) await post(`${room()}/ready`, s);
    expect((await post(`${base()}/hold`, ADMIN, { reason: 'Checking something' })).statusCode).toBe(200);
    const play = (await get(`/api/admin/events/${f.eventId}/play`, MOD)).json();
    const row = play.stages[0].rounds[0].matches.find((m: { id: number }) => m.id === f.matchId);
    expect(row.desk).toMatchObject({ holdReason: 'Checking something', holdFrom: 'veto', dispute: null, frozen: false, liveGame: null, subs: { a: 0, b: 0 } });
    const pub = (await get(`/api/events/${f.slug}`)).json();
    expect(pub.play[0].rounds[0].matches[0].desk).toBeUndefined();
    expect((await post(`${base()}/release-hold`, ADMIN)).statusCode).toBe(200);
    expect(P.getMatch(f.db, f.matchId)!.status).toBe('veto');
    expect((await post(`${base()}/release-hold`, ADMIN)).json()).toEqual({ error: EVENT_ERRORS.not_held.text });
    await post(`${room()}/veto`, A[0], { step: 0, action: 'first' });
    expect((await post(`${base()}/reopen-veto`, ADMIN)).statusCode).toBe(200);
    expect(R.vetoActions(f.db, f.matchId)).toEqual([]);
    expect((await post(`${base()}/extend-grace`, ADMIN, { minutes: 5 })).json()).toEqual({ error: EVENT_ERRORS.not_connect_phase.text });
    expect((await post(`${base()}/freeze`, ADMIN)).json()).toEqual({ error: EVENT_ERRORS.not_live_phase.text });
    expect((await post(`${base()}/move-server`, ADMIN)).json()).toEqual({ error: EVENT_ERRORS.not_live_phase.text });
    expect((await post(`${base()}/replay-chapter`, ADMIN, { ordinal: 0 })).json()).toEqual({ error: EVENT_ERRORS.not_live_phase.text });
    expect(audit()).toEqual(['event_hold', 'event_hold_release', 'event_veto_reopen']);
    for (const action of ['act', 'reopen-veto', 'replay-chapter', 'move-server', 'extend-grace', 'release-hold', 'freeze', 'unfreeze']) {
      expect((await post(`${base()}/${action}`, MOD, { kind: 'ready', side: 'a', ordinal: 0, minutes: 5 })).statusCode, action).toBe(403);
    }
  });
});
```

(Both tests open the room through `R.openRoom` directly, so no `event_room_open` audit row exists; the `play` row shape follows `stagePlayViews`.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/eventRoomRoutes.test.ts`
Expected: FAIL (404 on the new routes; `desk` missing from the play rows if Task 2's route change was skipped).

- [ ] **Step 3: adminEvents.ts**

Widen `opts.series`:

```ts
    series?: {
      confirm(matchId: number, steamid: string): Promise<V.Checked<unknown>>;
      dispute(matchId: number, steamid: string, reason: unknown): V.Checked<unknown>;
      afterPick(matchId: number): void;
      reset(matchId: number, by: string): V.Checked<unknown>;
      staffResult(matchId: number, by: string): void;
      /** Plan T3c: the desk tools. */
      freeze(matchId: number, by: string, on: boolean): Promise<V.Checked<unknown>>;
      replayChapter(matchId: number, by: string, ordinal: unknown): Promise<V.Checked<unknown>>;
      moveServer(matchId: number, by: string): Promise<V.Checked<unknown>>;
      extendGrace(matchId: number, by: string, minutes: unknown): V.Checked<unknown>;
      releaseHold(matchId: number, by: string): V.Checked<unknown>;
      reopenVeto(matchId: number, by: string): V.Checked<unknown>;
    };
```

Add `tellStaffAction` to the `../events/notices.js` import and `type StaffAction` from `../events/messages.js`. After `roomAction(...)`:

```ts
  /** Plan T3c Ruling 10: staff act as a team. One route, three kinds. */
  app.post('/api/admin/events/:id/matches/:matchId/act', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const p = req.params as { id: string; matchId: string };
    const ev = eventOf(p.id);
    const matchId = idOf(p.matchId);
    const m = ev && matchId !== null ? P.getMatch(db, matchId) : undefined;
    if (!ev || !m || m.event_id !== ev.id) return refuse(reply, 'match_not_found');
    const body = (req.body ?? {}) as { kind?: unknown; side?: unknown; step?: unknown; action?: unknown; campaign?: unknown; steamids?: unknown };
    if (body.side !== 'a' && body.side !== 'b') return refuse(reply, 'bad_side');
    const staff = { by: me, side: body.side };
    const timers = R.roomTimers(db);
    let r: V.Checked<P.MatchRow>;
    let what: StaffAction;
    if (body.kind === 'ready') { r = R.readyUp(db, { matchId: m.id, steamid: null, staff, timers }); what = 'ready'; }
    else if (body.kind === 'veto') {
      if (typeof body.step !== 'number' || !Number.isInteger(body.step)) return refuse(reply, 'bad_veto_action');
      r = R.actVeto(db, { matchId: m.id, steamid: null, staff, step: body.step, action: body.action, campaign: body.campaign ?? null, timers });
      what = 'veto';
    } else if (body.kind === 'lineup') { r = R.lockLineup(db, { matchId: m.id, steamid: null, staff, steamids: body.steamids, timers }); what = 'lineup'; }
    else return refuse(reply, 'bad_request');
    if (!r.ok) return refuse(reply, r.error);
    // A pick on a live match hands on to the series, as the captain's route does (T3b).
    if (what === 'veto' && r.value.status === 'live') {
      try { opts.series?.afterPick(m.id); } catch (err) { console.error(`[events] scheduling match ${m.id} after the desk's pick failed:`, err instanceof Error ? err.message : err); }
    }
    opts.rooms?.pushChange(m.id);
    const teamName = N.getEntry(db, R.entryOn(m, body.side))?.name ?? (body.side === 'a' ? 'team A' : 'team B');
    tellStaffAction(opts, ev.id, m.id, what, `for ${teamName}`);
    logAdmin(db, me, 'event_act_for_team', ev.id, {
      matchId: m.id, kind: body.kind, side: body.side,
      ...(what === 'veto' ? { step: body.step, action: body.action, campaign: body.campaign ?? null } : {}),
      ...(what === 'lineup' ? { steamids: body.steamids } : {}),
    });
    return {};
  });

  /** Plan T3c Rulings 11 to 15 and 9: one route per desk tool, each through the series engine. */
  const deskTool = (
    action: 'reopen-veto' | 'replay-chapter' | 'move-server' | 'extend-grace' | 'release-hold' | 'freeze' | 'unfreeze', audit: string,
    call: (s: NonNullable<typeof opts.series>, matchId: number, me: string, body: Record<string, unknown>) => Promise<V.Checked<unknown>> | V.Checked<unknown>,
    detail: (body: Record<string, unknown>) => object = () => ({}),
  ) =>
    app.post(`/api/admin/events/:id/matches/:matchId/${action}`, async (req, reply) => {
      const me = requireAdmin(req, reply);
      if (!me) return;
      const p = req.params as { id: string; matchId: string };
      const ev = eventOf(p.id);
      const matchId = idOf(p.matchId);
      const m = ev && matchId !== null ? P.getMatch(db, matchId) : undefined;
      if (!ev || !m || m.event_id !== ev.id) return refuse(reply, 'match_not_found');
      if (!opts.series) return reply.code(404).send({ error: 'not found' });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const r = await call(opts.series, m.id, me, body);
      if (!r.ok) return refuse(reply, r.error);
      opts.rooms?.pushChange(m.id);
      logAdmin(db, me, audit, ev.id, { matchId: m.id, ...detail(body) });
      return {};
    });
  deskTool('reopen-veto', 'event_veto_reopen', (s, id, me) => s.reopenVeto(id, me));
  deskTool('replay-chapter', 'event_chapter_replay', (s, id, me, body) => s.replayChapter(id, me, body.ordinal), (body) => ({ ordinal: body.ordinal }));
  deskTool('move-server', 'event_server_move', (s, id, me) => s.moveServer(id, me));
  deskTool('extend-grace', 'event_grace_extend', (s, id, me, body) => s.extendGrace(id, me, body.minutes), (body) => ({ minutes: body.minutes }));
  deskTool('release-hold', 'event_hold_release', (s, id, me) => s.releaseHold(id, me));
  deskTool('freeze', 'event_freeze', (s, id, me) => s.freeze(id, me, true));
  deskTool('unfreeze', 'event_unfreeze', (s, id, me) => s.freeze(id, me, false));
```

The engine sends the DM for the six tools itself (Tasks 6 and 7); the `act` route sends its own because it does not go through the engine. `src/server.ts` passes the whole `series` object to `adminEventRoutes` already; nothing to change there (verify with `grep -n 'adminEventRoutes' src/server.ts`). `src/routes/events.ts`'s `series` type is left as it is.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/eventRoomRoutes.test.ts tests/adminEventRoutes.test.ts tests/eventPlayRoutes.test.ts tests/eventRoutes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/adminEvents.ts tests/eventRoomRoutes.test.ts
git commit -m "Tournaments T3c: the Events desk acts for a team, reopens the veto, replays a chapter, moves the server, extends the grace, releases a hold and freezes or unfreezes the game, each audited, logged and told to both teams"
```

---
### Task 9: The desk's tools and the room page's frozen line

**Files:**
- Modify: `web/src/api.ts`, `web/src/routes/admin/events/PlayPanel.tsx`, `web/src/routes/event/room/ServerPanel.tsx`, `web/src/styles/app.css` (a `.desktools` block)
- Test: `web/src/routes/admin/events/PlayPanel.test.tsx`, `web/src/routes/event/room/ServerPanel.test.tsx`, and `frozen: false` added to every typed `MatchRoomView` builder (the web tsconfig typechecks the tests): `web/src/routes/EventMatch.test.tsx` (`view`), `web/src/routes/event/room/ServerPanel.test.tsx` (`base`), `LineupPanel.test.tsx` (`v`), `VetoBoard.test.tsx` (`base`), `ConfirmPanel.test.tsx` (`view`), `roomText.test.ts` (`v`)

**Interfaces:**
- Consumes: Task 2's `PlayMatchDesk` and `MatchRoomView.frozen`, Task 8's routes, `useAction`'s `Run` (`(fn, ask?: string | ConfirmOptions) => Promise<void>`, `ConfirmOptions` being `{ title; body?; confirmLabel?; cancelLabel?; danger? }`), `confirm` (`components/Confirm`, mocked in the PlayPanel test), `PHASE_TEXT` (`routes/event/room/roomText.ts`, a `Record<RoomPhase, string>` already imported by `PlayPanel.tsx`), `MatchRow({ eventId, s, m, canEdit, run, busy, slug })` with its local `editable`, `ROOM_LIVE`, `useState` (already imported), `post(path, body?)` in `api.ts` (a bodyless post is fine).
- Produces in `api.ts`: `PlayMatchDesk` (mirror of `src/events/playViews.ts`), `PlayMatch.desk?: PlayMatchDesk`, `MatchRoomView.frozen: boolean`; `adminApi.actForTeam(id, matchId, body)`, `reopenEventVeto(id, matchId)`, `replayEventChapter(id, matchId, ordinal)`, `moveEventServer(id, matchId)`, `extendEventGrace(id, matchId, minutes)`, `releaseEventHold(id, matchId)`, `freezeEventMatch(id, matchId)`, `unfreezeEventMatch(id, matchId)`.
- Produces in `PlayPanel.tsx`: on each match in a room phase, for `canEdit`: a line with the hold reason and origin, the dispute (who, which team, the reason) and "Frozen by staff" when set; a `<details class="desktools">` "Staff tools: A vs B" holding: Act for a team (side select, Ready / Lock a lineup with four checkboxes from the entry's roster? no: the desk does not know rosters here, so a lineup is four SteamID64s typed into one field, split on whitespace or commas), Reopen veto (phases ready, veto, lineup, server, hold), Replay chapter (a select over `desk.liveGame.chapters`, live only), Move server (connect, live), Extend grace (minutes input, connect only), Release hold (hold only), Freeze / Unfreeze (connect, live). Every button goes through `run` with a confirm sentence. A mod sees the desk line but no tools (`canEdit` false).
- Produces in `ServerPanel.tsx`: `{v.frozen && <p class="warning">Staff have frozen the game. Only staff can unfreeze it.</p>}` at the top of the running-server view.

- [ ] **Step 1: Write the failing tests**

In `web/src/routes/admin/events/PlayPanel.test.tsx`, extend `mockAdmin` with `actForTeam, reopenEventVeto, replayEventChapter, moveEventServer, extendEventGrace, releaseEventHold, freezeEventMatch, unfreezeEventMatch` (all `vi.fn()`), and append:

```tsx
  const desk = (over: Partial<NonNullable<PlayMatch['desk']>> = {}): NonNullable<PlayMatch['desk']> => ({
    holdReason: null, holdFrom: null, dispute: null, frozen: false, graceEndsAt: null, booking: null, liveGame: null, subs: { a: 0, b: 0 }, ...over,
  });

  it('shows the hold reason, the dispute and the freeze on the desk (plan T3c)', async () => {
    mockAdmin.eventPlay.mockResolvedValue(play({ stages: [{ ...play().stages[0]!, rounds: [{ group: 1, round: 1, label: 'Final', dates: null, matches: [
      m({ status: 'admin_hold', phase: 'hold', desk: desk({ holdReason: 'dispute', holdFrom: 'confirming', dispute: { side: 'b', byName: 'Bob', reason: 'They had five', at: '2026-10-10T21:00:00.000Z' } }) }),
      m({ id: 8, slot: 2, a: team(3, 'Cats'), b: team(4, 'Dogs'), status: 'live', phase: 'live', desk: desk({ frozen: true, subs: { a: 1, b: 0 } }) }),
    ] }] }] }));
    render(<PlayPanel eventId={9} canEdit={false} />);
    expect(await screen.findByText(/On hold \(dispute, from Confirming\)/)).toBeTruthy();
    expect(screen.getByText(/Disputed by Bob for Bats: They had five/)).toBeTruthy();
    expect(screen.getByText(/Frozen by staff/)).toBeTruthy();
    expect(screen.getByText(/Subs: Cats 1, Dogs 0/)).toBeTruthy();
    expect(screen.queryByText(/Staff tools/)).toBeNull();
  });

  it('offers the tools an admin may use in each phase and calls the right routes (plan T3c)', async () => {
    mockAdmin.eventPlay.mockResolvedValue(play({ stages: [{ ...play().stages[0]!, rounds: [{ group: 1, round: 1, label: 'Final', dates: null, matches: [
      m({ status: 'live', phase: 'live', desk: desk({ liveGame: { matchId: 44, campaign: 'no_mercy', chapters: [{ ordinal: 0, map: 'l4d_vs_hospital01_apartment' }, { ordinal: 1, map: 'l4d_vs_hospital02_subway' }] } }) }),
    ] }] }] }));
    for (const fn of Object.values(mockAdmin)) if (fn !== mockAdmin.eventPlay) (fn as Mock).mockResolvedValue({});
    render(<PlayPanel eventId={9} canEdit />);
    fireEvent.click(await screen.findByText('Staff tools: Rats vs Bats'));
    fireEvent.click(screen.getByRole('button', { name: 'Freeze' }));
    await waitFor(() => expect(mockAdmin.freezeEventMatch).toHaveBeenCalledWith(9, 7));
    fireEvent.change(screen.getByLabelText('Chapter to replay'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replay chapter' }));
    await waitFor(() => expect(mockAdmin.replayEventChapter).toHaveBeenCalledWith(9, 7, 1));
    fireEvent.click(screen.getByRole('button', { name: 'Move server' }));
    await waitFor(() => expect(mockAdmin.moveEventServer).toHaveBeenCalledWith(9, 7));
    fireEvent.change(screen.getByLabelText('Act as'), { target: { value: 'b' } });
    fireEvent.change(screen.getByLabelText('Veto step'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Veto action'), { target: { value: 'pick' } });
    fireEvent.input(screen.getByLabelText('Campaign'), { target: { value: 'dead_air' } });
    fireEvent.click(screen.getByRole('button', { name: 'Take the veto step' }));
    await waitFor(() => expect(mockAdmin.actForTeam).toHaveBeenCalledWith(9, 7, { kind: 'veto', side: 'b', step: 7, action: 'pick', campaign: 'dead_air' }));
    expect(screen.queryByRole('button', { name: 'Extend grace' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Release hold' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reopen veto' })).toBeNull();
    expect(confirm).toHaveBeenCalled();
  });

  it('offers Extend grace in connect, Release hold on a hold, and Reopen veto before a game (plan T3c)', async () => {
    mockAdmin.eventPlay.mockResolvedValue(play({ stages: [{ ...play().stages[0]!, rounds: [{ group: 1, round: 1, label: 'Final', dates: null, matches: [
      m({ status: 'connect', phase: 'connect', desk: desk({ graceEndsAt: '2026-10-10T21:00:00.000Z' }) }),
      m({ id: 8, slot: 2, a: team(3, 'Cats'), b: team(4, 'Dogs'), status: 'admin_hold', phase: 'hold', desk: desk({ holdReason: 'no_show_both', holdFrom: 'connect' }) }),
      m({ id: 9, slot: 3, a: team(5, 'Emus'), b: team(6, 'Foxes'), status: 'lineup', phase: 'lineup', desk: desk() }),
    ] }] }] }));
    for (const fn of Object.values(mockAdmin)) if (fn !== mockAdmin.eventPlay) (fn as Mock).mockResolvedValue({});
    render(<PlayPanel eventId={9} canEdit />);
    fireEvent.click(await screen.findByText('Staff tools: Rats vs Bats'));
    fireEvent.input(screen.getByLabelText('Minutes'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Extend grace' }));
    await waitFor(() => expect(mockAdmin.extendEventGrace).toHaveBeenCalledWith(9, 7, 10));
    fireEvent.click(screen.getByText('Staff tools: Cats vs Dogs'));
    fireEvent.click(screen.getByRole('button', { name: 'Release hold' }));
    await waitFor(() => expect(mockAdmin.releaseEventHold).toHaveBeenCalledWith(9, 8));
    fireEvent.click(screen.getByText('Staff tools: Emus vs Foxes'));
    fireEvent.click(screen.getByRole('button', { name: 'Reopen veto' }));
    await waitFor(() => expect(mockAdmin.reopenEventVeto).toHaveBeenCalledWith(9, 9));
    fireEvent.input(screen.getByLabelText('Four SteamID64s'), { target: { value: '76561199000000821 76561199000000822, 76561199000000823 76561199000000824' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lock the lineup' }));
    await waitFor(() => expect(mockAdmin.actForTeam).toHaveBeenCalledWith(9, 9, { kind: 'lineup', side: 'a', steamids: ['76561199000000821', '76561199000000822', '76561199000000823', '76561199000000824'] }));
  });
```

In `web/src/routes/event/room/ServerPanel.test.tsx` add a case: a view with `server.state = 'ready'`, `frozen: true` renders "Staff have frozen the game." (the file's builder is `base(over: Partial<MatchRoomView>)`, its argument required; add `frozen: false` to its defaults). Add `frozen: false` to the other five `MatchRoomView` builders named in Files as well, or the web typecheck fails.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run web/src/routes/admin/events/PlayPanel.test.tsx web/src/routes/event/room/ServerPanel.test.tsx`
Expected: FAIL (typecheck: `desk`, `frozen` unknown; no Staff tools).

- [ ] **Step 3: api.ts**

Next to `PlayMatch`:

```ts
/** What only the Events desk sees of a match (mirrors src/events/playViews.ts PlayMatchDesk, plan T3c). */
export interface PlayMatchDesk {
  holdReason: string | null; holdFrom: string | null;
  dispute: { side: 'a' | 'b'; byName: string; reason: string; at: string } | null;
  frozen: boolean; graceEndsAt: string | null;
  booking: { id: number; state: string; serverName: string | null; recovering: boolean } | null;
  liveGame: { matchId: number; campaign: string; chapters: { ordinal: number; map: string }[] } | null;
  subs: { a: number; b: number };
}
```

`PlayMatch` gains `desk?: PlayMatchDesk;`; `MatchRoomView` gains `frozen: boolean;`. In `adminApi`, after `holdEventMatch`:

```ts
  /** The desk tools (plan T3c). */
  actForTeam: (id: number, matchId: number, body: { kind: 'ready' | 'veto' | 'lineup'; side: 'a' | 'b'; step?: number; action?: string; campaign?: string | null; steamids?: string[] }) =>
    post(`/api/admin/events/${id}/matches/${matchId}/act`, body),
  reopenEventVeto: (id: number, matchId: number) => post(`/api/admin/events/${id}/matches/${matchId}/reopen-veto`),
  replayEventChapter: (id: number, matchId: number, ordinal: number) => post(`/api/admin/events/${id}/matches/${matchId}/replay-chapter`, { ordinal }),
  moveEventServer: (id: number, matchId: number) => post(`/api/admin/events/${id}/matches/${matchId}/move-server`),
  extendEventGrace: (id: number, matchId: number, minutes: number) => post(`/api/admin/events/${id}/matches/${matchId}/extend-grace`, { minutes }),
  releaseEventHold: (id: number, matchId: number) => post(`/api/admin/events/${id}/matches/${matchId}/release-hold`),
  freezeEventMatch: (id: number, matchId: number) => post(`/api/admin/events/${id}/matches/${matchId}/freeze`),
  unfreezeEventMatch: (id: number, matchId: number) => post(`/api/admin/events/${id}/matches/${matchId}/unfreeze`),
```

- [ ] **Step 4: PlayPanel.tsx**

Add, above `MatchRow`:

```tsx
/** The desk's line under a match in a room phase (plan T3c Ruling 16). */
function DeskLine({ m }: { m: PlayMatch }) {
  const d = m.desk;
  if (!d) return null;
  const a = m.a?.name ?? 'TBD';
  const b = m.b?.name ?? 'TBD';
  const parts: string[] = [];
  if (d.holdReason !== null) parts.push(`On hold (${d.holdReason}${d.holdFrom ? `, from ${PHASE_TEXT[d.holdFrom === 'veto' ? 'veto' : d.holdFrom === 'booking' ? 'server' : d.holdFrom as RoomPhase] ?? d.holdFrom}` : ''})`);
  if (d.dispute) parts.push(`Disputed by ${d.dispute.byName} for ${d.dispute.side === 'a' ? a : b}: ${d.dispute.reason}`);
  if (d.frozen) parts.push('Frozen by staff');
  if (d.booking) parts.push(`Server: ${d.booking.serverName ?? 'none yet'}${d.booking.recovering ? ' (recovering)' : ''}`);
  if (d.subs.a + d.subs.b > 0) parts.push(`Subs: ${a} ${d.subs.a}, ${b} ${d.subs.b}`);
  if (parts.length === 0) return null;
  return <p class="muted desk-line">{parts.join(' · ')}</p>;
}

const STEP_ACTIONS = ['first', 'second', 'ban', 'pick', 'survivors', 'infected'] as const;
const FOUR_RE = /^\d{17}$/;

/** The staff tools (plan T3c Rulings 10 to 15 and 9), each behind a confirm. */
function DeskTools({ eventId, m, run, busy }: { eventId: number; m: PlayMatch; run: Run; busy: boolean }) {
  const [side, setSide] = useState<'a' | 'b'>('a');
  const [step, setStep] = useState('');
  const [action, setAction] = useState<(typeof STEP_ACTIONS)[number]>('ban');
  const [campaign, setCampaign] = useState('');
  const [four, setFour] = useState('');
  const [minutes, setMinutes] = useState('5');
  const [chapter, setChapter] = useState('');
  const d = m.desk!;
  const names = `${m.a?.name ?? 'TBD'} vs ${m.b?.name ?? 'TBD'}`;
  const teamName = side === 'a' ? m.a?.name ?? 'team A' : m.b?.name ?? 'team B';
  const phase = m.phase;
  const canAct = phase === 'ready' || phase === 'veto' || phase === 'lineup' || phase === 'live';
  const canReopen = phase === 'ready' || phase === 'veto' || phase === 'lineup' || phase === 'server' || phase === 'hold';
  const canBox = phase === 'connect' || phase === 'live';
  const chapters = d.liveGame?.chapters ?? [];
  const fourIds = four.split(/[\s,]+/).filter(Boolean);
  const chapterLabel = (c: { ordinal: number; map: string }) => `Chapter ${c.ordinal + 1}: ${c.map}`;
  return (
    <details class="desktools">
      <summary>{`Staff tools: ${names}`}</summary>
      {canAct && (
        <div class="desktools__group">
          <label>Act as
            <select aria-label="Act as" value={side} onChange={(e) => setSide((e.target as HTMLSelectElement).value as 'a' | 'b')}>
              <option value="a">{m.a?.name ?? 'Team A'}</option>
              <option value="b">{m.b?.name ?? 'Team B'}</option>
            </select>
          </label>
          {phase === 'ready' && (
            <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => void run(() => adminApi.actForTeam(eventId, m.id, { kind: 'ready', side }), { title: `Press Ready for ${teamName}?` })}>Press Ready</button>
          )}
          {(phase === 'veto' || phase === 'live') && (
            <div class="inlinerow">
              <input type="number" min={0} aria-label="Veto step" placeholder="step" value={step} onChange={(e) => setStep((e.target as HTMLInputElement).value)} />
              <select aria-label="Veto action" value={action} onChange={(e) => setAction((e.target as HTMLSelectElement).value as (typeof STEP_ACTIONS)[number])}>
                {STEP_ACTIONS.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
              <input type="text" aria-label="Campaign" placeholder="campaign slug (ban or pick)" value={campaign} onInput={(e) => setCampaign((e.target as HTMLInputElement).value)} />
              <button class="btn btn--ghost btn--sm" disabled={busy || !/^\d+$/.test(step)} onClick={() => void run(
                () => adminApi.actForTeam(eventId, m.id, { kind: 'veto', side, step: Number(step), action, campaign: campaign.trim() === '' ? null : campaign.trim() }),
                { title: `Take step ${step} (${action}${campaign.trim() ? ` ${campaign.trim()}` : ''}) for ${teamName}?`, body: 'The room page shows the step number of the pending step.' },
              )}>Take the veto step</button>
            </div>
          )}
          {phase === 'lineup' && (
            <div class="inlinerow">
              <input type="text" aria-label="Four SteamID64s" placeholder="four SteamID64s, space or comma separated" value={four} onInput={(e) => setFour((e.target as HTMLInputElement).value)} />
              <button class="btn btn--ghost btn--sm" disabled={busy || fourIds.length !== 4 || !fourIds.every((x) => FOUR_RE.test(x))} onClick={() => void run(
                () => adminApi.actForTeam(eventId, m.id, { kind: 'lineup', side, steamids: fourIds }),
                { title: `Lock this lineup for ${teamName}?`, body: 'The four must be starters or subs of the entry.' },
              )}>Lock the lineup</button>
            </div>
          )}
        </div>
      )}
      <div class="desktools__group">
        {canReopen && (
          <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => void run(() => adminApi.reopenEventVeto(eventId, m.id),
            { title: 'Reopen the veto?', body: 'The veto, games and lineups are cleared and the room starts again from the first step with both teams still ready. A booking made meanwhile is cancelled.' })}>Reopen veto</button>
        )}
        {phase === 'connect' && (
          <>
            <input type="number" min={1} max={60} aria-label="Minutes" value={minutes} onInput={(e) => setMinutes((e.target as HTMLInputElement).value)} />
            <button class="btn btn--ghost btn--sm" disabled={busy || !/^\d+$/.test(minutes)} onClick={() => void run(() => adminApi.extendEventGrace(eventId, m.id, Number(minutes)),
              { title: `Give both teams ${minutes} more minutes to connect?` })}>Extend grace</button>
          </>
        )}
        {phase === 'hold' && (
          <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => void run(() => adminApi.releaseEventHold(eventId, m.id),
            { title: 'Release the hold?', body: `The match goes back to ${d.holdFrom ?? 'where it was'} with a fresh deadline. A dispute is cleared.` })}>Release hold</button>
        )}
        {canBox && (d.frozen
          ? <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => void run(() => adminApi.unfreezeEventMatch(eventId, m.id), { title: 'Unfreeze the game?' })}>Unfreeze</button>
          : <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => void run(() => adminApi.freezeEventMatch(eventId, m.id), { title: 'Freeze the game?', body: 'The game pauses and only staff can unpause it (here, or !lift in game).' })}>Freeze</button>)}
        {canBox && (
          <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => void run(() => adminApi.moveEventServer(eventId, m.id),
            { title: 'Move the match to another server?', body: 'The current server goes back to the pool. The match takes the first idle server in its region, is set up again and the live game is restored from the site\'s record; with no server free it waits, then is held.' })}>Move server</button>
        )}
        {phase === 'live' && chapters.length > 0 && (
          <div class="inlinerow">
            <select aria-label="Chapter to replay" value={chapter} onChange={(e) => setChapter((e.target as HTMLSelectElement).value)}>
              <option value="">Pick a chapter</option>
              {chapters.map((c) => <option key={c.ordinal} value={String(c.ordinal)}>{chapterLabel(c)}</option>)}
            </select>
            <button class="btn btn--ghost btn--sm" disabled={busy || chapter === ''} onClick={() => void run(() => adminApi.replayEventChapter(eventId, m.id, Number(chapter)),
              { title: `Replay ${chapterLabel(chapters.find((c) => String(c.ordinal) === chapter)!)} from its start?`, body: 'That chapter and anything after it are played again; earlier chapters keep their scores. The finale cannot be replayed.' })}>Replay chapter</button>
          </div>
        )}
      </div>
    </details>
  );
}
```

In `MatchRow`, after the `<span class="muted">` line add `<DeskLine m={m} />`, and after the existing `editable && ROOM_LIVE.has(m.phase)` fragment add `{editable && m.desk && ROOM_LIVE.has(m.phase) && <DeskTools eventId={eventId} m={m} run={run} busy={busy} />}`. Import `RoomPhase` is already there. In `app.css` add `.desktools { margin-top: .5rem; } .desktools summary { cursor: pointer; } .desktools__group { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin: .35rem 0; } .desk-line { font-size: .9em; }`.

- [ ] **Step 5: ServerPanel.tsx and EventMatch.tsx**

In `ServerPanel.tsx` (`ServerPanel({ v, now }: { v: MatchRoomView; now: number })`), the running view's `<div class="roomserver">` starts with `{v.frozen && <p class="warning">Staff have frozen the game. Only staff can unfreeze it.</p>}` (`.warning` is the class the room's on-hold line already uses). `EventMatch.tsx` needs no change (the Server panel is shown in `connect` and `live`); its test's `view()` builder gets `frozen: false`.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run web/src/routes/admin/events/PlayPanel.test.tsx web/src/routes/event/room web/src/routes/EventMatch.test.tsx web/src/routes/event/StagePlay.test.tsx && npm run typecheck`
Expected: PASS (the whole `event/room` folder: LineupPanel, VetoBoard, ConfirmPanel, ServerPanel and roomText build `MatchRoomView` literals), both typechecks clean.

- [ ] **Step 7: Commit**

```bash
git add web/src/api.ts web/src/routes/admin/events/PlayPanel.tsx web/src/routes/admin/events/PlayPanel.test.tsx web/src/routes/event/room/ServerPanel.tsx web/src/routes/event/room/ServerPanel.test.tsx web/src/routes/event/room/LineupPanel.test.tsx web/src/routes/event/room/VetoBoard.test.tsx web/src/routes/event/room/ConfirmPanel.test.tsx web/src/routes/event/room/roomText.test.ts web/src/routes/EventMatch.test.tsx web/src/styles/app.css
git commit -m "Tournaments T3c: the Events desk shows the hold reason, the dispute, the freeze and the subs on each match, with staff tools to act for a team, reopen the veto, replay a chapter, move the server, extend the grace, release a hold and freeze or unfreeze"
```

---

### Task 10: The whole-branch check and the hand-off

**Files:**
- No new code; fixes to whatever the checks turn up, in the file they belong to.

- [ ] **Step 1: The whole-branch check**

Run, in order, and fix anything that fails before committing:

```bash
npm test
npm run typecheck
npm run build
plugin/build.sh
grep -rnP '\x{2014}' src web/src plugin tests docs/superpowers/plans/2026-10-07-tournaments-3c-in-game-and-desk.md | head
git diff --stat tournaments-t3b..HEAD
```

Expected: every test passes (the T3a, T3b and T2 suites included), both typechecks clean, a clean build, `pug-match.smx` compiles, no em dash anywhere in the branch, and the diff touching only the files in the file map plus the tests.

- [ ] **Step 2: Read the log and write the hand-off**

Read `git log --oneline tournaments-t3b..HEAD`: nine commits, one per task, each a plain sentence. Do not push; do not deploy; do not stage the plugin.

Note for the owner in the hand-off:
- The plugin is built, not staged: `plugin/pug-match.smx` 0.3.25 goes to the boxes with the owner's usual stage-on-restart, every pool box at once (the site pushes `sm_pug_tournament` and `sm_pug_adminpause` lines only to tournament bookings, and `CLEAR_LINES` to every booking's box, so a box on 0.3.24 answers "unknown command" to `sm_pug_tournament 0`, which the runner's best-effort push already tolerates).
- Before any event is announced, Task 5 Step 5's in-game checks on the local server with `rotoblin_cheats_4v4`, and one end-to-end run on the local server: a two-team room, a sub between chapters (the lineup on the room page and the next game's roster burst follow), `!admin` from a player (the Discord card with the Match room button, the feed alert, the room page's frozen line), Unfreeze from the desk, Replay chapter 1 of a live game (the box reloads it, the earlier score stands), Move server with a second local box free.
- Production stays behind `competitive_enabled = 'admins'`.

- [ ] **Step 3: Commit anything the checks changed**

```bash
git add -A
git commit -m "Tournaments T3c: the whole-branch check"
```

(only if Step 1 changed files; otherwise nothing to commit.)
