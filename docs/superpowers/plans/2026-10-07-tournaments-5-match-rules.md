# Tournaments plan T5: match rules (pauses, disconnects, emergency subs, settings sweep)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tournament boxes play by FACEIT-style match rules whose every number is a per-ruleset setting, snapshotted per stage and edited in the Rulesets editor. A team has tactical pauses (count per game, length each: the existing `pause.limit` and `pause.seconds`) and technical pauses declared with `!tech <reason>`, the reason shown to both teams in chat, on the room page, on the Events desk and in the match log, with a total technical time per team per game (`pause.techSeconds`, default 300); technical time past its budget is charged to the team's tactical pauses one at a time, and with none left the game unpauses; unpausing stays mutual as today. A rostered player's disconnect still auto-pauses the game, is recorded as a technical pause, and spends the team's reconnect time (`disconnect.teamSeconds`, default 600 per team per game); when it runs out the team loses that game by forfeit through the existing result path (the series engine records a forfeited game; a Bo1 ends the match), and a tournament box never sends a PUG `ABANDON`. While the game is paused for a disconnect a captain may `!sub` a bench player into the missing player's slot mid-chapter, using one of the match's subs; the reconnect clock stops once the sub is in (an optional ruleset charge, default 0). The other team can `!flag [note]` a technical pause once, which posts a staff call through the existing mod-call path with the new reason `tech`; staff warn or forfeit the game from the Events desk with an audit row and a DM to both teams. The `!admin` cooldown and the next-game delay move into the ruleset; the operational waits of T3a to T4 (closing grace, server-wait alert, presence fallback, held-back slot length, reschedule reminder and the two reschedule margins) move into the Competitive settings group; structural constants stay constants with a stated reason. PUG behaviour does not change. pug-match goes to 0.3.26, compiled only in a scratch copy, staged only by the owner after the in-game checklist in Task 11. Nothing is deployed by this plan; production stays behind `competitive_enabled = 'admins'`.

**Architecture:** Three layers, each with one owner. The rules: `src/rulesets.ts` `MatchRules` gains `pause.techSeconds`, `subs.emergency`, `subs.emergencyChargeSeconds`, `disconnect.teamSeconds`, `staffCall.cooldownSeconds` and `series.nextGameSeconds`, read with defaults from any ruleset or stage snapshot saved before them; `src/rulesetStore.ts` validates and keeps stored values the editor does not send; `src/bookings/tournamentGames.ts` `tournamentRuleLines` turns a tournament booking's snapshot into six new plugin cvars pushed with the booking lines and every game burst (`CLEAR_LINES` puts them back). The box: `plugin/pug-pause.inc` runs the technical clock and its overrun into tactical pauses, `plugin/pug-leave.inc` runs a per-team reconnect pool on a tournament box (a new cvar, so a 0.3.25 box that ignores it keeps leave tracking off exactly as today), and `plugin/pug-tourney.inc` adds `!tech`, `!flag`, the emergency `!sub`, `sm_pug_forfeit` and the cvar-driven `!admin` cooldown; a forfeit that is not a `!gg` names the other team as the winner and says why (`forfeit_why=disconnect|staff`) on `MATCH_END` and the dump's `END` line. The site: `src/logParse.ts` reads the new signed `TECH` line and `SUB ... emergency=1`; `src/dumpParse.ts` reads `forfeit_why` into `matches.forfeit_why` and on to `event_games.forfeit_why`; `src/events/room.ts` owns the pause ledger as `event_log` rows (`noteTech`, `techPausesOf`, `techPenalty`, each mutation one transaction and one row, guarded by `tests/eventLogGuard.test.ts`); `src/events/series.ts` orients the box's pug team to the room side through `matches.booking_side_a`, posts a feed line per technical pause, takes emergency subs, and drives the desk's forfeit through `sm_pug_forfeit`. The room page gets a Pauses panel, the desk a Technical pauses group with Warn and Forfeit the game, the Rulesets editor a Tournament play group.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Fastify 5, better-sqlite3, vitest (`npm test`, `npx vitest run <file>`), `npm run typecheck` (server and web), `npm run build`; Preact + preact-iso + @testing-library/preact (happy-dom) for the web. SourcePawn 1.12 for `plugin/pug-match.sp` and its includes, compiled with `plugin/build.sh` (wine + the Rotoblin tree's spcomp) in a scratch copy only. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-30-competitive-tournaments-design.md` section 4 (Pauses; Disconnects; Subs during a match; In-game help) and section 1 (Rulesets: "every number a setting"). The owner's direction of 2026-10-07 (this plan's Rulings 1 to 12 carry it). Plan T3c Rulings 2 to 9 and 20 (`docs/superpowers/plans/2026-10-07-tournaments-3c-in-game-and-desk.md`: `TOURNAMENT_LINES`, `!sub` between chapters, `!admin` and the freeze, the 180 s cooldown shared with `/mod`, 0.3.25). The T3b, T3c, T4 and server-priority ledgers (`.superpowers/sdd/*/progress.md` under each worktree): nothing here reverses one of their rulings; Ruling 15 answers the T3c ledger's OWNER NOTE on the `!admin` cooldown.

**Match-rules as built (checked against branch `match-rules` at 94faf647, 2026-10-07: tournaments-t3a/b/c, rollout 4 windows and server priority stacked; this plan's snippets follow the code):** `MatchRules` (`src/rulesets.ts`) is `{ rated, pause: { limit, seconds, mutualUnpause, techPauses }, teamLock, playerMapControl, restartHalf, noShowGraceMinutes, penalties, bosses, sideRule, spectate, subs: { perMatch } }`; `parseRules` checks every field by hand and defaults `subs` to `{ perMatch: 2 }` when absent; `TEMPLATES` are `PUG`, `Standard Cup` (`techPauses: 2`), `Casual Scrim`; `rulesForKind`, `seedRulesetTemplates` (INSERT OR IGNORE, so a stored template keeps its JSON). `techPauses` is read by nothing but `rulesLines` today. `src/rulesetStore.ts` has `RULESET_ERRORS`, `EditableRules = Omit<MatchRules, 'rated' | 'penalties'>`, `readEditableRules` (a body without `subs` reads as the default), `unratedRules`, `updateRuleset` (a body without `subs` keeps the stored value), `createRuleset`, `rulesetList`. `src/events/format.ts` has `rulesLines` (event page) and `rulesSummary`. The web editor is `web/src/routes/admin/rulesets/RulesetForm.tsx` with `rulesDraft.ts` (`RulesTyped { limit, seconds, techPauses, grace }`, `editableFrom`, `typedFrom`, `readRules`, `readWhole` from `../events/wholeNumber`), `FormGroup`, `FormRow`, `ToggleRow`; `web/src/api.ts` mirrors `MatchRules` without `subs`. A tournament booking copies the stage snapshot into `bookings.rules_json` (`series.ts` `book` -> `createTournamentBooking`) and `createTournamentGame` copies it into `matches.rules_json`. `src/bookings/runner.ts` `gameLines` pushes `sm_pug_pause_limit`/`sm_pug_pause_seconds` from `bookingRules(b)` and `TOURNAMENT_LINES` (`sm_pug_tournament 1`, `sm_pug_leave_budget 0`, `sm_pug_end_kick 0`) for a tournament booking; `gameLinesOf` (`tournamentGames.ts`) puts `TOURNAMENT_LINES` first in every game burst; `CLEAR_LINES` resets them; `CLOSE_GRACE_MS` (5 min) and `NEXT_DELAY_MS` (60 s) are runner constants that `series.ts` imports; the runner loads a `next_campaign` on its minute pass (`TICK_MS`). `series.ts` has `SERVER_ALERT_MS` (10 min), `PRESENCE_FALLBACK_MS` (3 min), `RESET_EXPECT_MS`, `stageRules`, `SeriesEngine` (`tick`, `book`, `gameEnded` reading `matches.forfeit_team` oriented by `booking_side_a`, `scoreline` saying "typed !gg", `continueSeries`, `schedule` using `NEXT_DELAY_MS`, `subRequested(token, by, outId, inId)`, `adminPauseLine`, `freeze`, `liveGameOf`, `matchOfToken`, `runningBooking`, `alert`, `name`, `playerName`, `gameLabel`, `push`). `room.ts` has `SUB_PHASES`, `subPlayer` (logs `player_subbed` with `used`/`limit`), `revertSub`, `setAdminPause` (accepts a hold taken from a box phase), `recordGame(db, { matchId, gameId, scoreA, scoreB, forfeit, now, held })`, the private `liveMatch` and `gameIn`; `GameRow` has `forfeit_side`. `schedule.ts` has `AUTO_ACCEPT_MIN_AHEAD_MS` (48 h), `PROPOSE_MIN_AHEAD_MS` (1 h), `AUTO_ACCEPT_LOCK_BEFORE_MS` (24 h), `REMINDER_BEFORE_MS` (24 h), `REMINDER_MIN_GAP_MS` (1 h), `ScheduleRules { autoAcceptHours, leadMinutes }`, `scheduleRules(db)`, `autoAcceptAt`, `reminderAt`, the private `timeIn`. `src/bookings/rules.ts` has `EVENT_SLOT_MINUTES` (120) in `scheduledMatchSlots`, `bookingLimits(db)`. The plugin (0.3.25): `pug-leave.inc` (per-player allowance `sm_pug_leave_budget`, `LeaveTracking`, `LeaveRemaining`, `Timer_LeaveClock`, `LeaveAbandon` -> `ABANDON`, `LeaveTryPause` with `PauseAllowInternal`, `LeaveUnpauseNow`, `LeaveForget`, `Cmd_Leave` hold/release/add/end, `LeaveStatus`), `pug-pause.inc` (`sm_pug_pause_limit`/`sm_pug_pause_seconds` per campaign, i.e. per game on a tournament box, charged on the observed transition in `PauseClockTick`, ceiling held while anyone is absent or the freeze holds), `pug-tourney.inc` (`TourneyOn`, `TourneyFrozen`, `Tourney_OnSay` for `!sub`/`!admin`/`!lift`, `Tourney_BetweenChapters`, `Cmd_PugSub` refusing `PUGERR not between chapters`, `Tourney_AdminCall` using `MODCALL_COOLDOWN` 180, `Tourney_RetryGap`, `Tourney_Lift`, `Tourney_Status`), `pug-gg.inc` (`g_iForfeitTeam`, `Gg_Forfeit` -> `EndMatchNow("forfeit")`, `Gg_ForfeitTail` ` forfeit=a`, `Gg_CancelVote`, `Gg_Reset`), `pug-match.sp` (`EndMatchNow` and `WriteDump` compute the winner with `WinnerOf` and append `Gg_ForfeitTail`; includes in order leave, pause, modcall, staffchat, gg, tourney). `src/dumpParse.ts` believes a `forfeit=` only when it names the side that lost per `winner=`; `src/matchResult.ts` `completeMatch` writes `forfeit_team`. `src/abandon.ts` already ignores `ABANDON` on a booked game. `src/modCalls.ts` has `REASON_LABELS`, `CATEGORY` (`admin: null`), `targetKind 'none'` for `broke`/`admin`; `MOD_CALL_REASONS` is in `logParse.ts`; the card's Match room link (`modCallCard.ts`) already appears for a tournament game. `src/server.ts` dispatches `sub_request` and `admin_pause` to `seriesRef`; `tests/seriesFixture.ts` `line()` mirrors that dispatch. In `seriesFixture`, entry a is Rats (`A`), entry b is Bats (`BATS`), and game 1's `booking_side_a` is `'b'`: pug team a is Bats, pug team b is Rats. Where this plan's snippets and the code disagree, the code wins.

## Global Constraints

- Team events only (`entry_kind = 'team'`).
- **PUG behaviour does not change.** Every new plugin path is gated on `TourneyOn()` (`sm_pug_tournament 1`) or on a forfeit that is not a `!gg`; every new cvar defaults to today's behaviour; the PUG ruleset keeps its values; `CLEAR_LINES` puts every new cvar back; the `sm_pug_tournament 0` path is untouched. A PUG `!gg` writes exactly the lines it writes today.
- Every write to the room tables and every new `event_log` row of a match stays in `src/events/room.ts`; each mutation is one transaction writing exactly one `event_log` row on success and nothing on refusal (`tests/eventLogGuard.test.ts`, extended in Task 7). The series engine and the routes never write those tables themselves.
- Every write to `rulesets` stays in `src/rulesetStore.ts`; every setting has a `DEFAULT_SETTINGS` seed and a `SETTINGS_SCHEMA` row (`tests/adminSettings.test.ts` parity).
- The box's pug teams (`a`, `b`) are never the room's sides: every `TECH` line, forfeit and `sm_pug_forfeit` is oriented through the game's `matches.booking_side_a`.
- Tournament games never move SR.
- The plugin is compiled only in a scratch copy (Task 4 Step 6's commands), never into `plugin/` of a tree that is deployed and never into the Rotoblin tree; nothing is staged, rcon'd, restarted or deployed; `/home/volence/l4d1-ds` and every live box are never touched. The owner stages 0.3.26 after the Task 11 checklist.
- Never write em dashes in code, comments, copy, commits or docs.
- Commit messages follow the repo style (a plain sentence). Do not push. Do not deploy.
- Several Claude sessions use `/home/volence/l4d/pug`: work in the worktree `/home/volence/l4d/pug/.claude/worktrees/match-rules` (branch `match-rules`, at 94faf647). Run `npm ci` inside the worktree (never symlink `node_modules`). Never run a bare `git stash`. Check `git reflog -10` and `git status` before any commit.

## Rulings this plan makes (for the owner to confirm)

1. **Scope.** Technical pauses with a time budget and overrun into tactical pauses; disconnect pauses recorded as technical; a per-team reconnect pool ending in a game forfeit; emergency subs; the `!flag` staff call; desk penalties (warning, forfeit the game); the six new ruleset numbers and the editor fields; the settings sweep. Nothing changes for PUGs, scrims or side games.
2. **Where each number lives.** Match-play numbers (what the teams play by) live in the ruleset and are snapshotted per stage at publish, as today: tactical pauses (`pause.limit`, `pause.seconds`, unchanged), technical pauses (`pause.techPauses` count, `pause.techSeconds` time), reconnect time (`disconnect.teamSeconds`), subs (`subs.perMatch`, `subs.emergency`, `subs.emergencyChargeSeconds`), the `!admin` cooldown (`staffCall.cooldownSeconds`) and the next-game delay (`series.nextGameSeconds`). Operational numbers (how the site and staff run things) become Competitive settings: `booking_close_grace_minutes` (5, was `CLOSE_GRACE_MS`), `event_server_alert_minutes` (10, was `SERVER_ALERT_MS`), `event_presence_fallback_minutes` (3, was `PRESENCE_FALLBACK_MS`), `event_slot_minutes` (120, was `EVENT_SLOT_MINUTES`), `reschedule_reminder_hours` (24, was `REMINDER_BEFORE_MS`), `reschedule_autoaccept_min_ahead_hours` (48, was `AUTO_ACCEPT_MIN_AHEAD_MS`), `reschedule_min_ahead_minutes` (60, was `PROPOSE_MIN_AHEAD_MS`). The old constants stay exported as the seeded defaults so tests and fallbacks keep one source. Kept as constants, each with its reason in a comment: `SHOWN_MIN` (a team is four players), `DEFAULT_GRACE_MINUTES` (the fallback for a booking with unreadable rules), `RESET_EXPECT_MS` (how long a UDP line can lag, not a policy), `ROOM_TICK_MS` and the runner's `TICK_MS` (clock granularity), `GRACE_EXTEND_MAX` (the input bound of a staff tool), the nine tiebreak slots (`10 * game + 1 .. 9` is the ordinal encoding), `AUTO_ACCEPT_LOCK_BEFORE_MS` and `REMINDER_MIN_GAP_MS` (derived guards on the two reschedule settings; the min-ahead setting's floor of 25 hours keeps the lock after the proposal), `POOL_LIMIT` (the veto board's size), and the plugin's `TOURNEY_*` timings (Rotoblin's pause mechanics). `NEXT_DELAY_MS` stays the scrim runner's constant (a scrim's next campaign is the booking flow of `!nextmap`, not a match rule); `GG_VOTE_TIME`, `GG_COOLDOWN` and `MODCALL_COOLDOWN` stay PUG constants.
3. **The new rule fields.** `pause.techSeconds` 60 to 1800, default 300; `disconnect.teamSeconds` 60 to 3600, default 600; `subs.emergency` boolean, default true; `subs.emergencyChargeSeconds` 0 to 600, default 0; `staffCall.cooldownSeconds` 30 to 600, default 180; `series.nextGameSeconds` 30 to 600, default 60. `parseRules` reads each as its default when absent (every stored ruleset and stage snapshot predates them, nothing re-saves). All three templates carry the defaults, the PUG one included; they act only on a tournament box, so PUG and scrims are unchanged. `pause.techPauses` keeps its meaning as a count, now enforced: technical pauses a team may declare per game, 0 turns `!tech` off (the PUG and Casual Scrim templates have 0, Standard Cup 2).
4. **Tactical pauses are today's pauses.** `pause.limit` and `pause.seconds` already reach the box as `sm_pug_pause_limit`/`sm_pug_pause_seconds`, charged per campaign; every tournament game is its own campaign on the box (`sm_pug_match` resets the budget), so they are per team per game with no change. Unpausing stays mutual (Rotoblin's both-teams `!ready`), and a disconnect pause still unpauses itself 10 seconds after everyone is back (`sm_pug_leave_autounpause`, unchanged).
5. **`!tech <reason>`.** A rostered, not subbed-out player during a live round with nothing paused, on a tournament box with `sm_pug_tech_limit` above 0, whose team has a technical pause and technical time left this game; the reason is required (3 or more characters after sanitising, at most 159). The pause is Rotoblin's own `sm_pause` issued from that player with the internal flag (unbudgeted as a tactical pause), and it counts as technical only once the box sees the game paused within `Tourney_RetryGap()` of the request (the same "charge what happened" rule as tactical pauses). Chat to everyone: `[Match] Team A technical pause: <reason> (M:SS of technical time left; the other team can !flag it for staff).` The box emits a signed `TECH event=start` line with the reason; the site writes it to the match log (`tech_pause`), the room page and the desk, and posts one admin-feed line.
6. **Technical time.** It runs once a second while the team's technical pause holds, and not while any rostered player is disconnected or the staff freeze holds (Ruling 7; the T3c freeze rule). Warnings at 60, 30 and 10 seconds left. At zero (`TECH event=over`): with a tactical pause left, the pause becomes one of that team's tactical pauses (one charged, the tactical ceiling starts, a `PAUSE` line as for any tactical pause), and when that ceiling runs out with another tactical pause left a further one is charged and the ceiling restarts; with none left the game unpauses through the both-teams-ready path. With `pause.limit` null (unlimited) the overrun is one tactical ceiling and then the game unpauses; with `pause.seconds` null it waits for a mutual unpause.
7. **A disconnect pause counts as technical.** On a tournament box with reconnect time, the leave module's auto-pause is recorded as a technical pause of the disconnected player's team (`TECH event=start cause=disconnect`, reason "disconnected", flaggable), but it is charged to that team's reconnect pool, not its technical time: charging both would make a team play short-handed after five minutes, which the owner ruled out. While anyone is away the technical clock and the tactical ceiling hold.
8. **Reconnect time per team per game.** On a tournament box with `sm_pug_dc_team_seconds` above 0 (pushed from `disconnect.teamSeconds`), the leave module tracks the team, not the player: for every second at least one of a team's rostered players is disconnected and not held, that team's pool spends one second, so two players dropping together spend it once. It resets with every game (each `sm_pug_match`), warns at 60, 30 and 10 seconds left, and at zero the team forfeits the game (Ruling 9) and nothing is aborted or banned. `sm_pug_leave_budget 0` stays in `TOURNAMENT_LINES` and the new cvar turns tracking on, so a 0.3.25 box (which ignores the unknown cvar) keeps leave tracking off exactly as today, and `src/abandon.ts` still ignores an `ABANDON` on a booked game. The live board's `sm_pug_leave` verbs work on the team pool there (`add` and `end` move the team's pool, `hold` freezes one player's share).
9. **A forfeit through the result path.** The box ends the game as a `!gg` does (`EndMatchNow("forfeit")`, the half already scored kept), with `forfeit=<team>` and, new, `forfeit_why=disconnect|staff` on `MATCH_END` and the dump's `END` line; a forfeit that is not a `!gg` names the other team as `winner=` whatever the score, so `dumpParse` (which believes a forfeit only when it names the loser) keeps it. A `!gg` line is byte for byte today's. `matches.forfeit_why` and `event_games.forfeit_why` record why; the series engine records the game as forfeited by that side exactly as it does a `!gg` (a Bo1 then ends the match, a Bo3 moves on), and the series line says "ran out of reconnect time" or "by staff ruling" instead of "typed !gg".
10. **Emergency subs.** Mid-chapter, `!sub <out> <in>` is taken when `sm_pug_sub_emergency` is 1 (from `subs.emergency`), `out` is a rostered player who is disconnected now, and the game is paused; the box sends `SUB ... emergency=1`, and the site applies its usual checks (a captain or co-captain of `out`'s side, `in` a starter or sub of the entry not in the four, within `subs.perMatch`, which the emergency sub uses), plus `emergency_off` when the snapshot says no. The box takes `sm_pug_sub` mid-chapter for that case only (`PUGERR not between chapters` otherwise, as today). Once the sub is placed, `out`'s absence is forgotten, so the reconnect clock stops; with `subs.emergencyChargeSeconds` above 0 the team's pool is charged that much, never to zero by the charge alone. The pause is then lifted by both teams' `!ready`.
11. **`!flag [note]`.** A rostered player of the other team, while a technical pause (cause call or disconnect) of the opposing team is open, once per pause. It sends one `PUGCALL ... reason=tech target=none` line through the mod-call path (a Discord card titled "In-game call: Tournament: technical pause flagged", pinged and folded like any call, no ticket, the Match room button) and a signed `TECH event=flag` line the site records on the pause (`tech_flagged`). It is not subject to the `!admin` cooldown (once per pause bounds it; the site's per-caller rate cap still applies). Play is not affected.
12. **Staff penalties.** From the desk's Technical pauses group, one per pause: Warning (any time before the match is resolved) or Forfeit the game (only while the game that pause belonged to is being played: the engine sends `sm_pug_forfeit <token> <team>` and records the penalty on `PUGOK forfeit`; the game then ends with `forfeit_why=staff` through Ruling 9). An earlier game's pause is warned, or staff enter the result. Each writes `tech_penalty` to the match log, `event_tech_penalty` to `admin_actions`, and the `event_match_staff` DM to both rosters ("staff gave a warning for a technical pause (Rats, game 1: "router")").
13. **Who sees what.** The room page lists every technical pause of the match to everyone (game, team, kind, time used, overrun, flagged, penalty), as the veto log is public; the reason and the flag note only to the two rosters and staff (the T4 ruling on proposal notes). The desk shows everything with names.
14. **Admin feed.** One line per technical pause start and per overrun, linking the room. A flag reaches staff through the mod-call card instead (it pings), so it adds no feed line.
15. **The `!admin` cooldown.** `staffCall.cooldownSeconds` reaches the box as `sm_pug_admin_cooldown` and is the only cooldown `!admin` checks; `/mod` keeps its 180 s. They still share the per-account timestamp, so a `/mod` right after `!admin` waits out `/mod`'s own cooldown. (Answers the T3c ledger's OWNER NOTE.)
16. **The next-game delay.** `series.nextGameSeconds` replaces `NEXT_DELAY_MS` in `series.ts` `schedule`. The runner loads a scheduled game on its minute pass, so the real wait is the setting rounded up to that pass; the chat says "in about a minute" up to 60 seconds and "in about N minutes" above.
17. **Plugin 0.3.26.** New cvars (defaults keep PUG and 0.3.25 behaviour): `sm_pug_tech_limit` 0, `sm_pug_tech_seconds` 300, `sm_pug_dc_team_seconds` 0, `sm_pug_sub_emergency` 0, `sm_pug_sub_charge` 0, `sm_pug_admin_cooldown` 180; new RCON `sm_pug_forfeit <token> <a|b>` (tournament box only; `PUGOK forfeit team=<x>`, `PUGOK forfeit team=<x> already`, or `PUGERR <why>`); new signed line `TECH event=<start|end|over|flag> id=<unix> team=<a|b> cause=<call|disconnect> by=<id64|none> used=<s> budget=<s> [tactical=<n>] text=<free text>`. `id` is the unix second the pause began, so it stays unique within a game across a chapter replay or crash restore (which rebuild the match and reset its budgets: Not in this plan). The site pushes the six cvars from the snapshot with the booking lines and every game burst; a snapshot it cannot read pushes none (the box then keeps `!tech` and team tracking off).
18. **Errors.** New keys in `validate.ts`: `pause_not_found`, `already_penalized`, `bad_penalty`, `emergency_off`. New keys in `RULESET_ERRORS`: `bad_tech_seconds`, `bad_reconnect`, `bad_subs`, `bad_sub_charge`, `bad_call_cooldown`, `bad_next_game`.
19. **Audit and log rows.** `admin_actions`: `event_tech_penalty` (match, pause, penalty). `event_log`: `tech_pause`, `tech_pause_ended`, `tech_overrun`, `tech_flagged`, `tech_penalty`; `player_subbed` gains `emergency: true` on an emergency sub; `game_recorded` gains `why`.

## Not in this plan (and why)

- **The live page and the PUG pause ledger telling a technical pause apart.** `PHASE` is unchanged; a technical pause shows there as a pause nobody is charged for (`team=0`), like a disconnect pause today. The room page and the desk carry the technical ledger.
- **Budgets across a chapter replay or a crash restore.** `sm_pug_resume` rebuilds the match and resets the game's pause and reconnect budgets on the box. Staff start replays; the restore is rare. A follow-up can resend the used seconds with the resume burst.
- **A player missing when a later game of the series starts.** The ready-up decides (a team readies with three or waits); the reconnect clock starts with that game's first disconnect only.
- **Automatic penalties for a flag, point deductions, or a ban.** Staff decide every flag; the two penalties are the owner's.
- **Per-player reconnect tools on the Events desk.** The Live board's existing hold/add/end act on the team pool (Ruling 8); the desk gets none.
- **Discord channel posts of penalties.** DMs only, as T3c's staff actions.

## Review Focus

- **PUG is untouched.** Every plugin change is behind `TourneyOn()`, a non-`!gg` forfeit, or a cvar whose default is today's behaviour; Task 5's diff review and Task 11's PUG rows check it, and `CLEAR_LINES` resets all six cvars (Task 3 test).
- **The pug team is never taken for the room side.** `sideOfPugTeam`/`pugTeamOf` orient every `TECH` line and `sm_pug_forfeit` through `booking_side_a`; Task 8 tests both directions with the fixture's flipped game 1.
- **A disconnect forfeit is a forfeit of the right team and never an abandon.** The winner override, `forfeit_why` and `dumpParse` (Task 6), the engine's recorded game and series line (Task 8), and the old-plugin safety of keeping `sm_pug_leave_budget 0` (Ruling 8).
- **The clocks terminate and never double-charge.** Technical time holds while anyone is away or frozen; the team pool spends one second per team per tick; the overrun chain ends when tactical pauses run out (Task 4 and Task 11 rows).
- **The room guard holds.** `noteTech` and `techPenalty` join `ROOM_MUTATIONS` with one row each and `techPausesOf` joins `ROOM_READS` (Task 7).

---

## File map

| File | Responsibility |
|---|---|
| `src/rulesets.ts` | `MatchRules` new fields, `MATCH_PLAY_DEFAULTS`, `parseRules` defaults and ranges, templates. |
| `src/rulesetStore.ts` | `readEditableRules` and `updateRuleset` for the new fields; error keys. |
| `src/events/format.ts` | `rulesLines` for technical time, reconnect time and subs. |
| `src/db.ts`, `src/settingsSchema.ts` | Seven Competitive settings; `matches.forfeit_why`, `event_games.forfeit_why`. |
| `src/bookings/rules.ts` | `BookingLimits.closeGraceMinutes`; `scheduledMatchSlots` reads `event_slot_minutes`. |
| `src/bookings/runner.ts` | Close grace from settings; `tournamentRuleLines` in `gameLines`; `CLEAR_LINES`. |
| `src/bookings/tournamentGames.ts` | `tournamentRuleLines`, `TOURNAMENT_RULE_CLEAR`; rule lines in `gameLinesOf`. |
| `src/events/schedule.ts` | `ScheduleRules` gains the three reschedule settings. |
| `plugin/pug-pause.inc`, `plugin/pug-leave.inc`, `plugin/pug-tourney.inc`, `plugin/pug-gg.inc`, `plugin/pug-match.sp`, `plugin/README.md` | 0.3.26: technical pauses, team reconnect pool, emergency sub, `!flag`, `sm_pug_forfeit`, `forfeit_why`, cooldown cvar. |
| `src/logParse.ts`, `src/dumpParse.ts`, `src/matchResult.ts`, `src/modCalls.ts` | `TECH` lines, `SUB emergency=1`, reason `tech`, `forfeit_why`. |
| `src/events/validate.ts`, `src/events/room.ts` | Error keys; `noteTech`, `techPausesOf`, `techPenalty`; `recordGame` `forfeitWhy`; `subPlayer` `emergency`. |
| `src/events/series.ts`, `src/events/messages.ts`, `src/server.ts` | `seriesTimings`, `techLine`, emergency subs, `techPenalty`, forfeit wording, next-game delay; two staff actions; dispatch. |
| `src/events/pauseViews.ts` (new), `src/events/roomViews.ts`, `src/events/playViews.ts`, `src/routes/adminEvents.ts` | `RoomPause`/`DeskPause` builders; `MatchRoomView.pauses`, `PlayMatchDesk.pauses`, the `tech-penalty` route. |
| `tests/eventLogGuard.test.ts`, `tests/seriesFixture.ts`, `tests/matchRules.test.ts` (new) | Guard entries; `tech` dispatch; the end-to-end rules tests. |
| `web/src/api.ts`, `web/src/routes/admin/rulesets/rulesDraft.ts`, `web/src/routes/admin/rulesets/RulesetForm.tsx`, `web/src/routes/event/room/PausePanel.tsx` (new), `web/src/routes/EventMatch.tsx`, `web/src/routes/admin/events/PlayPanel.tsx`, `web/src/styles/app.css` (and the `MatchRoomView`/`PlayMatchDesk`/`MatchRules` test builders) | The Tournament play editor group, the Pauses panel, the desk's Technical pauses group. |

---
### Task 1: The rule fields, their defaults and the editor's server side

**Files:**
- Modify: `src/rulesets.ts`, `src/rulesetStore.ts`, `src/events/format.ts`
- Test: `tests/rulesets.test.ts`, `tests/rulesetStore.test.ts`, `tests/eventFormat.test.ts`

**Interfaces:**
- Consumes: `MatchRules`, `TEMPLATES`, `parseRules`, `numberOrNull`, `fail` (`rulesets.ts`); `RULESET_ERRORS`, `readEditableRules`, `unratedRules`, `updateRuleset`, `whole`, `rulesOf` (`rulesetStore.ts`); `rulesLines` (`format.ts`).
- Produces:
  - `rulesets.ts`: `MatchRules.pause.techSeconds: number`; `MatchRules.subs: { perMatch: number; emergency: boolean; emergencyChargeSeconds: number }`; `MatchRules.disconnect: { teamSeconds: number }`; `MatchRules.staffCall: { cooldownSeconds: number }`; `MatchRules.series: { nextGameSeconds: number }`; `export const MATCH_PLAY_DEFAULTS: { techSeconds: 300; teamSeconds: 600; emergency: true; emergencyChargeSeconds: 0; cooldownSeconds: 180; nextGameSeconds: 60 }`; `export const RULE_RANGES: Record<'techSeconds' | 'teamSeconds' | 'emergencyChargeSeconds' | 'cooldownSeconds' | 'nextGameSeconds', readonly [number, number]>`.
  - `rulesetStore.ts`: `readEditableRules` reads the new fields (absent: the default; present: range-checked); `updateRuleset` keeps every stored new field a body leaves out (`mergeStored(body, stored): unknown`, file-private).
  - `format.ts`: `rulesLines` says technical pauses with their time, reconnect time, subs and emergency subs.

- [ ] **Step 1: Write the failing tests**

In `tests/rulesets.test.ts`, replace the `reads subs.perMatch ...` test's last line (`for (const t of Object.values(TEMPLATES)) expect(t.subs).toEqual({ perMatch: 2 });`) with `for (const t of Object.values(TEMPLATES)) expect(t.subs.perMatch).toBe(2);`, change its first expectation to `expect(parseRules(old).subs).toEqual({ perMatch: 2, emergency: true, emergencyChargeSeconds: 0 });` and its second to `.subs).toEqual({ perMatch: 1, emergency: true, emergencyChargeSeconds: 0 });`, then append inside the `describe`:

```ts
  it('reads the plan T5 match-play fields, defaulting each one a ruleset saved before them lacks', () => {
    const cup = TEMPLATES['Standard Cup'];
    const old = JSON.parse(JSON.stringify(cup)) as Record<string, unknown>;
    delete (old.pause as Record<string, unknown>).techSeconds;
    delete old.disconnect;
    delete old.staffCall;
    delete old.series;
    old.subs = { perMatch: 1 };
    const r = parseRules(JSON.stringify(old));
    expect(r.pause.techSeconds).toBe(MATCH_PLAY_DEFAULTS.techSeconds);
    expect(r.disconnect).toEqual({ teamSeconds: 600 });
    expect(r.staffCall).toEqual({ cooldownSeconds: 180 });
    expect(r.series).toEqual({ nextGameSeconds: 60 });
    expect(r.subs).toEqual({ perMatch: 1, emergency: true, emergencyChargeSeconds: 0 });
    const custom = { ...cup, pause: { ...cup.pause, techSeconds: 120 }, disconnect: { teamSeconds: 900 }, staffCall: { cooldownSeconds: 60 }, series: { nextGameSeconds: 120 }, subs: { perMatch: 2, emergency: false, emergencyChargeSeconds: 30 } };
    expect(parseRules(JSON.stringify(custom))).toEqual(custom);
    for (const [field, bad] of [['pause.techSeconds', { ...cup, pause: { ...cup.pause, techSeconds: 30 } }], ['disconnect.teamSeconds', { ...cup, disconnect: { teamSeconds: 4000 } }],
      ['staffCall.cooldownSeconds', { ...cup, staffCall: { cooldownSeconds: 'x' } }], ['series.nextGameSeconds', { ...cup, series: { nextGameSeconds: 10 } }],
      ['subs.emergency', { ...cup, subs: { perMatch: 2, emergency: 'yes' } }], ['subs.emergencyChargeSeconds', { ...cup, subs: { perMatch: 2, emergencyChargeSeconds: 601 } }]] as const) {
      expect(() => parseRules(JSON.stringify(bad))).toThrow(`invalid rules: ${field}`);
    }
  });

  it('gives every template the defaults, PUG included, and keeps PUG\'s own values (plan T5 Ruling 3)', () => {
    for (const t of Object.values(TEMPLATES)) {
      expect(t.pause.techSeconds).toBe(300);
      expect(t.disconnect).toEqual({ teamSeconds: 600 });
      expect(t.staffCall).toEqual({ cooldownSeconds: 180 });
      expect(t.series).toEqual({ nextGameSeconds: 60 });
      expect(t.subs).toEqual({ perMatch: 2, emergency: true, emergencyChargeSeconds: 0 });
    }
    expect(TEMPLATES.PUG.pause).toEqual({ limit: 3, seconds: 120, mutualUnpause: false, techPauses: 0, techSeconds: 300 });
    expect(TEMPLATES['Standard Cup'].pause.techPauses).toBe(2);
    expect(TEMPLATES['Casual Scrim'].pause.techPauses).toBe(0);
  });
```

Add `MATCH_PLAY_DEFAULTS` to the file's import from `../src/rulesets.js`.

In `tests/rulesetStore.test.ts`, the two expectations of `takes every field and turns blank pause limits into no limit` gain `techSeconds: 300` (`.toEqual({ limit: null, seconds: null, mutualUnpause: false, techPauses: 0, techSeconds: 300 })` and the same with `limit: 0, seconds: 30, mutualUnpause: true, techPauses: 5`), and their inputs pass `techSeconds: 300`. Append inside `describe('reading the editable rules', ...)`:

```ts
  it('reads the plan T5 fields when sent and refuses each out of range with its own reason', () => {
    const body = (over: Record<string, unknown>) => ({ ...cupEditable, ...over });
    expect(okOf(readEditableRules(body({ disconnect: { teamSeconds: 900 }, staffCall: { cooldownSeconds: 60 }, series: { nextGameSeconds: 120 }, subs: { perMatch: 3, emergency: false, emergencyChargeSeconds: 30 } }))))
      .toMatchObject({ disconnect: { teamSeconds: 900 }, staffCall: { cooldownSeconds: 60 }, series: { nextGameSeconds: 120 }, subs: { perMatch: 3, emergency: false, emergencyChargeSeconds: 30 } });
    const { disconnect: _d, staffCall: _c, series: _s, subs: _u, ...bare } = cupEditable;
    expect(okOf(readEditableRules({ ...bare, pause: { ...cupEditable.pause, techSeconds: undefined } })))
      .toMatchObject({ pause: { techSeconds: 300 }, disconnect: { teamSeconds: 600 }, staffCall: { cooldownSeconds: 180 }, series: { nextGameSeconds: 60 }, subs: { perMatch: 2, emergency: true, emergencyChargeSeconds: 0 } });
    expect(errOf(readEditableRules(body({ pause: { ...cupEditable.pause, techSeconds: 59 } })))).toBe('bad_tech_seconds');
    expect(errOf(readEditableRules(body({ disconnect: { teamSeconds: 3601 } })))).toBe('bad_reconnect');
    expect(errOf(readEditableRules(body({ subs: { perMatch: 5, emergency: true, emergencyChargeSeconds: 0 } })))).toBe('bad_subs');
    expect(errOf(readEditableRules(body({ subs: { perMatch: 2, emergency: true, emergencyChargeSeconds: 900 } })))).toBe('bad_sub_charge');
    expect(errOf(readEditableRules(body({ staffCall: { cooldownSeconds: 20 } })))).toBe('bad_call_cooldown');
    expect(errOf(readEditableRules(body({ series: { nextGameSeconds: 20 } })))).toBe('bad_next_game');
  });
```

Append a test in the file's update `describe` (the one that calls `updateRuleset`; use its own `idOf`/`row` helpers):

```ts
  it('keeps every plan T5 field the body leaves out, as it keeps subs', () => {
    const id = okOf(createRuleset(db, { by: ADMIN, copyFrom: idOf('Standard Cup'), name: 'Spring Cup' })).id;
    const stored = { ...cupEditable, pause: { ...cupEditable.pause, techSeconds: 120 }, disconnect: { teamSeconds: 900 }, staffCall: { cooldownSeconds: 60 }, series: { nextGameSeconds: 90 }, subs: { perMatch: 1, emergency: false, emergencyChargeSeconds: 20 } };
    okOf(updateRuleset(db, { by: ADMIN, id, name: 'Spring Cup', rules: stored }));
    const { disconnect: _d, staffCall: _c, series: _s, subs: _u, ...bare } = stored;
    okOf(updateRuleset(db, { by: ADMIN, id, name: 'Spring Cup', rules: { ...bare, pause: { limit: 2, seconds: 90, mutualUnpause: true, techPauses: 1 } } }));
    expect(JSON.parse(row(id).rules_json)).toMatchObject({
      pause: { limit: 2, seconds: 90, techPauses: 1, techSeconds: 120 }, disconnect: { teamSeconds: 900 }, staffCall: { cooldownSeconds: 60 }, series: { nextGameSeconds: 90 },
      subs: { perMatch: 1, emergency: false, emergencyChargeSeconds: 20 },
    });
  });
```

In `tests/eventFormat.test.ts`, append inside its `describe` (import `TEMPLATES` from `../src/rulesets.js` if missing):

```ts
  it('says the technical time, the reconnect time and the subs (plan T5)', () => {
    const lines = rulesLines(TEMPLATES['Standard Cup']);
    expect(lines).toContain('Technical pauses: 2 per team per game, 5:00 of technical time in all; past it a pause uses tactical pauses');
    expect(lines).toContain('Reconnect time: 10:00 per team per game; at zero the team forfeits the game');
    expect(lines).toContain('Subs: 2 per match, one may come in mid-chapter for a disconnected player');
    expect(rulesLines({ ...TEMPLATES['Standard Cup'], pause: { ...TEMPLATES['Standard Cup'].pause, techPauses: 0 } }).some((l) => l.startsWith('Technical pauses'))).toBe(false);
    expect(rulesLines({ ...TEMPLATES['Standard Cup'], subs: { perMatch: 1, emergency: false, emergencyChargeSeconds: 0 } })).toContain('Subs: 1 per match, between chapters');
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/rulesets.test.ts tests/rulesetStore.test.ts tests/eventFormat.test.ts`
Expected: FAIL (`MATCH_PLAY_DEFAULTS` undefined, the new fields missing, the new error keys unknown, the new lines absent).

- [ ] **Step 3: rulesets.ts**

Replace the `MatchRules` interface with:

```ts
export interface MatchRules {
  rated: boolean;
  /** limit and seconds are the tactical pauses; techPauses and techSeconds the
   *  technical ones (plan T5 Rulings 4 to 6). A tournament box counts all of
   *  them per game; a PUG box per campaign, which is the same thing. */
  pause: { limit: number | null; seconds: number | null; mutualUnpause: boolean; techPauses: number; techSeconds: number };
  teamLock: boolean;
  playerMapControl: boolean;
  restartHalf: { allowed: boolean; lockAfterDamage: boolean };
  noShowGraceMinutes: number;
  penalties: boolean;
  bosses: 'random_published' | 'fixed' | 'voteboss';
  sideRule: 'higher_seed_chooses' | 'non_picker_chooses' | 'coin';
  spectate: { sideLocked: boolean };
  /** Tournaments plan T3c: substitutions a side may make per match (in-game
   *  !sub between chapters); plan T5: whether one may come in mid-chapter
   *  for a disconnected player, and what that costs the team's reconnect time. */
  subs: { perMatch: number; emergency: boolean; emergencyChargeSeconds: number };
  /** Plan T5, tournament boxes only: reconnect time per team per game. */
  disconnect: { teamSeconds: number };
  /** Plan T5, tournament boxes only: seconds between two !admin calls of one player. */
  staffCall: { cooldownSeconds: number };
  /** Plan T5: seconds between two games of a series. */
  series: { nextGameSeconds: number };
}

/** Plan T5 Ruling 3: what a ruleset or stage snapshot saved before these
 *  fields reads as, and what every template carries. */
export const MATCH_PLAY_DEFAULTS = {
  techSeconds: 300, teamSeconds: 600, emergency: true, emergencyChargeSeconds: 0, cooldownSeconds: 180, nextGameSeconds: 60,
} as const;
/** Inclusive ranges, shared by parseRules and the editor (rulesetStore.ts). */
export const RULE_RANGES = {
  techSeconds: [60, 1800], teamSeconds: [60, 3600], emergencyChargeSeconds: [0, 600], cooldownSeconds: [30, 600], nextGameSeconds: [30, 600],
} as const satisfies Record<string, readonly [number, number]>;
```

In `TEMPLATES`, every `pause` gains `techSeconds: 300`, and every template's `subs: { perMatch: 2 }` becomes:

```ts
    subs: { perMatch: 2, emergency: true, emergencyChargeSeconds: 0 },
    disconnect: { teamSeconds: 600 },
    staffCall: { cooldownSeconds: 180 },
    series: { nextGameSeconds: 60 },
```

Above the `PUG` template's comment add: `// Plan T5: the match-play defaults below act only on a tournament box (sm_pug_tournament 1); a PUG box never receives them.`

In `parseRules`, after `if (typeof pause.techPauses !== 'number') fail('pause.techPauses');` add:

```ts
  const inRange = (v: unknown, range: readonly [number, number]): v is number => Number.isInteger(v) && (v as number) >= range[0] && (v as number) <= range[1];
  // Plan T5: absent in every ruleset and snapshot saved before the field.
  if (pause.techSeconds !== undefined && !inRange(pause.techSeconds, RULE_RANGES.techSeconds)) fail('pause.techSeconds');
```

Replace the `subs` block with:

```ts
  // Tournaments plan T3c, extended by plan T5. Absent in every ruleset and
  // stage snapshot saved before the field: read as the default.
  let subs: MatchRules['subs'] = { perMatch: 2, emergency: MATCH_PLAY_DEFAULTS.emergency, emergencyChargeSeconds: MATCH_PLAY_DEFAULTS.emergencyChargeSeconds };
  if (r.subs !== undefined) {
    if (typeof r.subs !== 'object' || r.subs === null) fail('subs');
    const s = r.subs as Record<string, unknown>;
    if (!Number.isInteger(s.perMatch) || (s.perMatch as number) < 0 || (s.perMatch as number) > 4) fail('subs.perMatch');
    if (s.emergency !== undefined && typeof s.emergency !== 'boolean') fail('subs.emergency');
    if (s.emergencyChargeSeconds !== undefined && !inRange(s.emergencyChargeSeconds, RULE_RANGES.emergencyChargeSeconds)) fail('subs.emergencyChargeSeconds');
    subs = {
      perMatch: s.perMatch as number,
      emergency: (s.emergency as boolean | undefined) ?? MATCH_PLAY_DEFAULTS.emergency,
      emergencyChargeSeconds: (s.emergencyChargeSeconds as number | undefined) ?? MATCH_PLAY_DEFAULTS.emergencyChargeSeconds,
    };
  }
  /** One plan T5 object of a single whole-number field: absent reads as the default. */
  const one = (key: 'disconnect' | 'staffCall' | 'series', field: string, range: readonly [number, number], fallback: number): number => {
    const v = r[key];
    if (v === undefined) return fallback;
    if (typeof v !== 'object' || v === null) fail(key);
    const n = (v as Record<string, unknown>)[field];
    if (!inRange(n, range)) fail(`${key}.${field}`);
    return n as number;
  };
  const teamSeconds = one('disconnect', 'teamSeconds', RULE_RANGES.teamSeconds, MATCH_PLAY_DEFAULTS.teamSeconds);
  const cooldownSeconds = one('staffCall', 'cooldownSeconds', RULE_RANGES.cooldownSeconds, MATCH_PLAY_DEFAULTS.cooldownSeconds);
  const nextGameSeconds = one('series', 'nextGameSeconds', RULE_RANGES.nextGameSeconds, MATCH_PLAY_DEFAULTS.nextGameSeconds);
```

and the returned object's `pause` and tail become:

```ts
    pause: {
      limit: pauseLimit, seconds: pauseSeconds, mutualUnpause: pause.mutualUnpause, techPauses: pause.techPauses,
      techSeconds: (pause.techSeconds as number | undefined) ?? MATCH_PLAY_DEFAULTS.techSeconds,
    },
    ...
    spectate: { sideLocked: spectate.sideLocked },
    subs,
    disconnect: { teamSeconds },
    staffCall: { cooldownSeconds },
    series: { nextGameSeconds },
```

- [ ] **Step 4: rulesetStore.ts**

Import `MATCH_PLAY_DEFAULTS, RULE_RANGES` from `./rulesets.js`. Add to `RULESET_ERRORS` after `bad_grace`:

```ts
  bad_tech_seconds: { status: 400, text: 'Technical time is 60 to 1800 seconds per team per game.' },
  bad_reconnect: { status: 400, text: 'Reconnect time is 60 to 3600 seconds per team per game.' },
  bad_subs: { status: 400, text: 'Subs per match is a whole number from 0 to 4.' },
  bad_sub_charge: { status: 400, text: 'An emergency sub costs 0 to 600 seconds of reconnect time.' },
  bad_call_cooldown: { status: 400, text: 'The !admin cooldown is 30 to 600 seconds.' },
  bad_next_game: { status: 400, text: 'The next game follows after 30 to 600 seconds.' },
```

In `readEditableRules`, replace the `subs` lines and the returned object with:

```ts
  // Plan T3c subs and the plan T5 fields: a body without one reads as the
  // default (updateRuleset fills in the stored value first); one with it is
  // range-checked, each with its own sentence.
  const within = (v: unknown, range: readonly [number, number]) => whole(v, range[0], range[1]);
  if (pause.techSeconds !== undefined && !within(pause.techSeconds, RULE_RANGES.techSeconds)) return fail('bad_tech_seconds');
  const subs = r.subs as Record<string, unknown> | null | undefined;
  if (subs !== undefined && (typeof subs !== 'object' || subs === null || !whole(subs.perMatch, 0, 4))) return fail('bad_subs');
  if (subs && subs.emergency !== undefined && typeof subs.emergency !== 'boolean') return fail('bad_rules');
  if (subs && subs.emergencyChargeSeconds !== undefined && !within(subs.emergencyChargeSeconds, RULE_RANGES.emergencyChargeSeconds)) return fail('bad_sub_charge');
  const field = (key: 'disconnect' | 'staffCall' | 'series', name: string): unknown => {
    const v = r[key];
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[name] : v === undefined ? undefined : null;
  };
  const teamSeconds = field('disconnect', 'teamSeconds');
  if (teamSeconds !== undefined && !within(teamSeconds, RULE_RANGES.teamSeconds)) return fail('bad_reconnect');
  const cooldownSeconds = field('staffCall', 'cooldownSeconds');
  if (cooldownSeconds !== undefined && !within(cooldownSeconds, RULE_RANGES.cooldownSeconds)) return fail('bad_call_cooldown');
  const nextGameSeconds = field('series', 'nextGameSeconds');
  if (nextGameSeconds !== undefined && !within(nextGameSeconds, RULE_RANGES.nextGameSeconds)) return fail('bad_next_game');
  return ok({
    pause: {
      limit: pause.limit as number | null, seconds: pause.seconds as number | null, mutualUnpause: pause.mutualUnpause as boolean, techPauses: pause.techPauses as number,
      techSeconds: (pause.techSeconds as number | undefined) ?? MATCH_PLAY_DEFAULTS.techSeconds,
    },
    teamLock: r.teamLock as boolean,
    playerMapControl: r.playerMapControl as boolean,
    restartHalf: { allowed: restartHalf.allowed as boolean, lockAfterDamage: (restartHalf.allowed as boolean) && (restartHalf.lockAfterDamage as boolean) },
    noShowGraceMinutes: r.noShowGraceMinutes as number,
    bosses: r.bosses as MatchRules['bosses'],
    sideRule: r.sideRule as MatchRules['sideRule'],
    spectate: { sideLocked: spectate.sideLocked as boolean },
    subs: {
      perMatch: subs ? (subs.perMatch as number) : 2,
      emergency: (subs?.emergency as boolean | undefined) ?? MATCH_PLAY_DEFAULTS.emergency,
      emergencyChargeSeconds: (subs?.emergencyChargeSeconds as number | undefined) ?? MATCH_PLAY_DEFAULTS.emergencyChargeSeconds,
    },
    disconnect: { teamSeconds: (teamSeconds as number | undefined) ?? MATCH_PLAY_DEFAULTS.teamSeconds },
    staffCall: { cooldownSeconds: (cooldownSeconds as number | undefined) ?? MATCH_PLAY_DEFAULTS.cooldownSeconds },
    series: { nextGameSeconds: (nextGameSeconds as number | undefined) ?? MATCH_PLAY_DEFAULTS.nextGameSeconds },
  });
```

`unratedRules` becomes:

```ts
export function unratedRules(e: EditableRules): MatchRules {
  return {
    rated: false, pause: e.pause, teamLock: e.teamLock, playerMapControl: e.playerMapControl, restartHalf: e.restartHalf,
    noShowGraceMinutes: e.noShowGraceMinutes, penalties: false, bosses: e.bosses, sideRule: e.sideRule, spectate: e.spectate,
    subs: e.subs, disconnect: e.disconnect, staffCall: e.staffCall, series: e.series,
  };
}
```

Before `updateRuleset` add:

```ts
/** A body's missing rule objects and fields filled from the stored rules, so
 *  an editor that does not send them (an older web bundle, or a field the
 *  form leaves out) never resets them to the defaults (plan T3c subs, plan T5). */
function mergeStored(body: unknown, stored: MatchRules | null): unknown {
  if (typeof body !== 'object' || body === null || stored === null) return body;
  const b = { ...(body as Record<string, unknown>) };
  for (const key of ['subs', 'disconnect', 'staffCall', 'series'] as const) if (!(key in b)) b[key] = stored[key];
  if (typeof b.subs === 'object' && b.subs !== null) b.subs = { emergency: stored.subs.emergency, emergencyChargeSeconds: stored.subs.emergencyChargeSeconds, ...(b.subs as object) };
  if (typeof b.pause === 'object' && b.pause !== null && !('techSeconds' in (b.pause as object))) b.pause = { ...(b.pause as object), techSeconds: stored.pause.techSeconds };
  return b;
}
```

and in `updateRuleset` replace the two `stored`/`body` lines with:

```ts
    // A body without a field keeps the ruleset's stored value (plan T3c subs, plan T5).
    const body = mergeStored(o.rules, rulesOf(row));
```

- [ ] **Step 5: format.ts**

Replace the `techPauses` line of `rulesLines` with:

```ts
  const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  if (r.pause.techPauses > 0) {
    lines.push(`Technical pauses: ${r.pause.techPauses} per team per game, ${clock(r.pause.techSeconds)} of technical time in all; past it a pause uses tactical pauses`);
  }
  lines.push(`Reconnect time: ${clock(r.disconnect.teamSeconds)} per team per game; at zero the team forfeits the game`);
  lines.push(r.subs.emergency
    ? `Subs: ${r.subs.perMatch} per match, one may come in mid-chapter for a disconnected player`
    : `Subs: ${r.subs.perMatch} per match, between chapters`);
```

- [ ] **Step 6: Run the tests and the typecheck**

Run: `npx vitest run tests/rulesets.test.ts tests/rulesetStore.test.ts tests/eventFormat.test.ts tests/adminRulesetRoutes.test.ts && npm run typecheck`
Expected: PASS. The server typecheck may flag test fixtures that build a `MatchRules` by hand (add the defaults from `TEMPLATES['Standard Cup']` there); the web typecheck still passes (its mirror is updated in Task 10).

- [ ] **Step 7: Commit**

```bash
git add src/rulesets.ts src/rulesetStore.ts src/events/format.ts tests/rulesets.test.ts tests/rulesetStore.test.ts tests/eventFormat.test.ts
git commit -m "Tournaments T5: the ruleset carries technical time, reconnect time, emergency subs, the admin call cooldown and the next-game delay, each read with its default from older rulesets"
```

---
### Task 2: The operational numbers become Competitive settings

**Files:**
- Modify: `src/db.ts`, `src/settingsSchema.ts`, `src/bookings/rules.ts`, `src/bookings/runner.ts`, `src/events/series.ts`, `src/events/schedule.ts`
- Test: `tests/adminSettings.test.ts` (parity, no edit), `tests/bookingRules.test.ts`, `tests/series.test.ts`, `tests/schedule.test.ts`, `tests/bookingRunner.test.ts`

**Interfaces:**
- Consumes: `settingNumber` (`src/settings.ts`), `bookingLimits`, `scheduledMatchSlots`, `EVENT_SLOT_MINUTES` (`rules.ts`), `CLOSE_GRACE_MS` (`runner.ts`), `SERVER_ALERT_MS`, `PRESENCE_FALLBACK_MS` (`series.ts`), `scheduleRules`, `autoAcceptAt`, `reminderAt`, `remindersDue`, `timeIn` (`schedule.ts`).
- Produces:
  - Settings (Competitive): `booking_close_grace_minutes` 5 (1 to 30), `event_server_alert_minutes` 10 (2 to 60), `event_presence_fallback_minutes` 3 (1 to 15), `event_slot_minutes` 120 (60 to 360), `reschedule_min_ahead_minutes` 60 (60 to 1440), `reschedule_autoaccept_min_ahead_hours` 48 (25 to 168), `reschedule_reminder_hours` 24 (1 to 48).
  - `rules.ts`: `BookingLimits.closeGraceMinutes: number`; `scheduledMatchSlots` reads `event_slot_minutes`.
  - `series.ts`: `export function seriesTimings(db: DB): { serverAlertMs: number; presenceFallbackMs: number; closeGraceMs: number }`.
  - `schedule.ts`: `ScheduleRules { autoAcceptHours; leadMinutes; minAheadMinutes?: number; autoAcceptMinAheadHours?: number; reminderHours?: number }` (optional so hand-built rules in tests keep compiling; `scheduleRules(db)` fills all); `autoAcceptAt(createdMs, proposedMs, hours, roomOpensMs = null, minAheadMs = AUTO_ACCEPT_MIN_AHEAD_MS)`; `reminderAt(createdMs, autoAcceptIso, beforeMs = REMINDER_BEFORE_MS)`.

- [ ] **Step 1: Write the failing tests**

In `tests/bookingRules.test.ts`, inside `keeps a box back for a scheduled tournament match until it is booked, in its region only (plan T4 Ruling 5)`, right after `expect(bookingsDue(db, T0 + 2 * H, 75)).toBe(0);` and before the `// Booked:` comment (the match seeded at `T0` is still unbooked there), add:

```ts
    // Plan T5 Ruling 2: the slot length is a setting.
    setSetting(db, 'event_slot_minutes', '180');
    expect(scheduledMatchSlots(db, 'na', T0 - H, T0 + 4 * H)).toEqual([{ s: T0, e: T0 + 180 * 60_000 }]);
    setSetting(db, 'event_slot_minutes', '120');
```

and a new test in the same `describe`:

```ts
  it('reads the close grace from booking_close_grace_minutes (plan T5 Ruling 2)', () => {
    expect(bookingLimits(db).closeGraceMinutes).toBe(5);
    setSetting(db, 'booking_close_grace_minutes', '12');
    expect(bookingLimits(db).closeGraceMinutes).toBe(12);
  });
```


Append to `tests/series.test.ts` inside `describe('SeriesEngine: booking, the game burst and connect', ...)`:

```ts
  it('alerts staff after event_server_alert_minutes, not a fixed ten (plan T5 Ruling 2)', async () => {
    f = await seriesFixture();
    setSetting(f.db, 'event_server_alert_minutes', '4');
    f.db.prepare("UPDATE servers SET status = 'live'").run();
    await f.tick();
    expect(f.match()).toMatchObject({ status: 'booking', server_alerted_at: null });
    f.t.t += 4 * MIN;
    await f.tick();
    await f.tick();
    expect(f.alerts.filter((a) => a.kind === 'problem' && a.text.includes('has waited 4 minutes for a server'))).toHaveLength(1);
    expect(seriesTimings(f.db)).toEqual({ serverAlertMs: 4 * MIN, presenceFallbackMs: 3 * MIN, closeGraceMs: 5 * MIN });
  });
```

Add `seriesTimings` to the file's import from `../src/events/series.js` and `setSetting` from `../src/settings.js` (in every test file of this task that calls it). (The existing `waits for a server, alerts staff once after ten minutes` test keeps passing on the seeded 10.)

Append to `tests/schedule.test.ts` inside `describe('autoAcceptAt and reminderAt', ...)` (`windowFixture`, `at` and `NOW` are already imported or defined there):

```ts
  it('reads the reschedule margins from the Competitive settings (plan T5 Ruling 2)', async () => {
    const f = await windowFixture();
    expect(S.scheduleRules(f.db)).toEqual({ autoAcceptHours: 24, leadMinutes: 20, minAheadMinutes: 60, autoAcceptMinAheadHours: 48, reminderHours: 24 });
    setSetting(f.db, 'reschedule_autoaccept_min_ahead_hours', '72');
    setSetting(f.db, 'reschedule_reminder_hours', '12');
    expect(S.scheduleRules(f.db)).toMatchObject({ autoAcceptMinAheadHours: 72, reminderHours: 12 });
    expect(S.autoAcceptAt(NOW.getTime(), at(60).getTime(), 24, null, 72 * 3_600_000)).toBeNull();
    expect(S.autoAcceptAt(NOW.getTime(), at(80).getTime(), 24, null, 72 * 3_600_000)).toBe(at(24).toISOString());
    expect(S.reminderAt(NOW.getTime(), at(24).toISOString(), 12 * 3_600_000)).toBe(at(12).toISOString());
  });
```


In `tests/bookingRunner.test.ts`, after `a game ending on the last booked campaign says the close and schedules nothing` (same `describe`, same helpers), add:

```ts
  it('closes after booking_close_grace_minutes and says so (plan T5 Ruling 2)', async () => {
    setSetting(db, 'booking_close_grace_minutes', '7');
    const id = await running(['no_mercy']);
    now = START + 60 * MIN;
    runner.onGameEnded(insertGame(id, { state: 'completed', endedAt: now }));
    await flush();
    expect(cmds()).toContain('say [Booking] That was campaign 1 of 1. Type !addcampaign to play one more, or the server closes in 7 minutes.');
    expect(getBooking(db, id)).toMatchObject({ next_campaign: null, close_at: new Date(now + 7 * MIN).toISOString() });
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/bookingRules.test.ts tests/series.test.ts tests/schedule.test.ts tests/bookingRunner.test.ts`
Expected: FAIL (`seriesTimings` undefined; the settings missing; `closeGraceMinutes` undefined; the fixed numbers still used).

- [ ] **Step 3: db.ts and settingsSchema.ts**

In `DEFAULT_SETTINGS`, after `event_window_lead_minutes: '20',`:

```ts
  // Tournaments plan T5 Ruling 2: the operational waits of T3a to T4, once
  // constants (CLOSE_GRACE_MS, SERVER_ALERT_MS, PRESENCE_FALLBACK_MS,
  // EVENT_SLOT_MINUTES and the reschedule margins), now settings with the
  // same values.
  booking_close_grace_minutes: '5',
  event_server_alert_minutes: '10',
  event_presence_fallback_minutes: '3',
  event_slot_minutes: '120',
  reschedule_min_ahead_minutes: '60',
  reschedule_autoaccept_min_ahead_hours: '48',
  reschedule_reminder_hours: '24',
```

In `SETTINGS_SCHEMA`, after the `event_window_lead_minutes` row:

```ts
  { key: 'booking_close_grace_minutes', group: 'Competitive', label: 'Close a finished booking after (minutes)', help: 'After the last booked campaign of a scrim, or the last game of a tournament series, how long the server stays up (for !addcampaign on a scrim) before it closes.', type: { kind: 'int', min: 1, max: 30 } },
  { key: 'event_server_alert_minutes', group: 'Competitive', label: 'Tell staff a match waits for a server after (minutes)', help: 'A tournament match whose lineups locked but that has no idle server for this long is reported on the admin feed once. It keeps waiting.', type: { kind: 'int', min: 2, max: 60 } },
  { key: 'event_presence_fallback_minutes', group: 'Competitive', label: 'Hold a match nobody could watch after (minutes)', help: 'When the grace to connect ends and the server has not answered rcon for this long, nobody is forfeited for not showing: the match is put on hold for staff instead.', type: { kind: 'int', min: 1, max: 15 } },
  { key: 'event_slot_minutes', group: 'Competitive', label: 'Server time kept back per scheduled match (minutes)', help: 'A scheduled tournament match not yet booked keeps a server back for this long from its time: scrims cannot book over it, and the PUG queue, side games and practice leave a server for it.', type: { kind: 'int', min: 60, max: 360 } },
  { key: 'reschedule_min_ahead_minutes', group: 'Competitive', label: 'Propose a match time at least (minutes ahead)', help: 'A captain\'s proposed time for a scheduled tournament match must be at least this far in the future. Keep it above the room\'s early opening.', type: { kind: 'int', min: 60, max: 1440 } },
  { key: 'reschedule_autoaccept_min_ahead_hours', group: 'Competitive', label: 'A proposal can lock on its own when made (hours ahead)', help: 'An unanswered reschedule proposal locks on its own only when it was made at least this long before the proposed time; a later one needs an answer. At least 25, so the lock always falls after the proposal.', type: { kind: 'int', min: 25, max: 168 } },
  { key: 'reschedule_reminder_hours', group: 'Competitive', label: 'Remind captains before a proposal locks (hours)', help: 'The other team\'s captains get a DM this long before an unanswered proposal locks on its own.', type: { kind: 'int', min: 1, max: 48 } },
```

Change the `reschedule_autoaccept_hours` row's help to end with `Captains are reminded before it locks (see below).` (its "48 hours" and "24 hours" are settings now).

- [ ] **Step 4: rules.ts and runner.ts**

In `BookingLimits` add `closeGraceMinutes: number;`. In `bookingLimits`, add `closeGraceMinutes: n('booking_close_grace_minutes', 5, 1, 30),` to the returned object.

Replace `EVENT_SLOT_MINUTES`' comment with `/** The seeded default of event_slot_minutes (plan T5 Ruling 2): a Bo1 with setup, the grace to connect and a possible tiebreak. */` and in `scheduledMatchSlots` replace `const slot = EVENT_SLOT_MINUTES * 60_000;` with:

```ts
  const slot = settingNumber(db, 'event_slot_minutes', EVENT_SLOT_MINUTES, { integer: true, min: 60, max: 360 }) * 60_000;
```

In `runner.ts`, `CLOSE_GRACE_MS`' comment becomes `/** The seeded default of booking_close_grace_minutes (plan T5 Ruling 2). */`. In the scrim's last-game branch (the `if (played >= b.games_allowed)` block of the game-ended handler) replace the `setCloseAt` line and the two `line =` strings with:

```ts
      const graceMin = bookingLimits(this.db).closeGraceMinutes;
      if (!setCloseAt(this.db, b.id, played, new Date(nowMs + graceMin * 60_000).toISOString(), new Date(nowMs))) return;
      const closes = `or the server closes in ${graceMin} minute${graceMin === 1 ? '' : 's'}.`;
      // A game started inside an earlier grace can take played past the count.
      line = played > b.games_allowed
        ? `say [Booking] That was past the last booked campaign. Type !addcampaign to play one more, ${closes}`
        : `say [Booking] That was campaign ${b.games_allowed} of ${b.games_allowed}. Type !addcampaign to play one more, ${closes}`;
```

(`bookingLimits` is already imported by `runner.ts` from `./rules.js`; add it to that import if not.)

- [ ] **Step 5: series.ts**

Import `settingNumber` from `../settings.js` and `bookingLimits` from `../bookings/rules.js` (extend the existing `rules.js` import). Change the two constants' comments to `/** The seeded default of event_server_alert_minutes (plan T5 Ruling 2). */` and `/** The seeded default of event_presence_fallback_minutes (plan T5 Ruling 2). */`, and after them add:

```ts
/** The engine's operational waits, from the Competitive settings (plan T5 Ruling 2). */
export function seriesTimings(db: DB): { serverAlertMs: number; presenceFallbackMs: number; closeGraceMs: number } {
  return {
    serverAlertMs: settingNumber(db, 'event_server_alert_minutes', SERVER_ALERT_MS / 60_000, { integer: true, min: 2, max: 60 }) * 60_000,
    presenceFallbackMs: settingNumber(db, 'event_presence_fallback_minutes', PRESENCE_FALLBACK_MS / 60_000, { integer: true, min: 1, max: 15 }) * 60_000,
    closeGraceMs: bookingLimits(db).closeGraceMinutes * 60_000,
  };
}
```

In `tick`, read `const timing = seriesTimings(this.db);` first, then use `timing.serverAlertMs` in place of `SERVER_ALERT_MS` (the alert text becomes `` `has waited ${Math.round(timing.serverAlertMs / 60_000)} minutes for a server (no idle box in its region can take it). It keeps waiting; free a box, or reset the room or enter the result on the Events desk.` ``) and `timing.presenceFallbackMs` in place of both `PRESENCE_FALLBACK_MS`. In `continueSeries`, the series-over branch becomes:

```ts
      if (b && open) {
        // The box closes after the usual grace (the idle end covers a refused close).
        const graceMs = seriesTimings(this.db).closeGraceMs;
        const closing = B.setCloseAt(this.db, b.id, gamesPlayed(this.db, b.id), new Date(now.getTime() + graceMs).toISOString(), now);
        const mins = Math.round(graceMs / 60_000);
        this.deps.runner.announce(b.id, `Series over: ${this.scoreline(m, v)}. Captains confirm or dispute on the site within ${timers.confirmMinutes} minutes.${closing ? ` The server closes in ${mins} minute${mins === 1 ? '' : 's'}.` : ''}`);
      }
```

Remove `CLOSE_GRACE_MS` from the `runner.js` import (Task 3 removes `NEXT_DELAY_MS`).

- [ ] **Step 6: schedule.ts**

Replace `ScheduleRules` and `scheduleRules`:

```ts
/** The three plan T5 margins are optional so a hand-built ScheduleRules
 *  (tests) keeps compiling; scheduleRules(db) always fills them. */
export interface ScheduleRules { autoAcceptHours: number; leadMinutes: number; minAheadMinutes?: number; autoAcceptMinAheadHours?: number; reminderHours?: number }

export function scheduleRules(db: DB): ScheduleRules {
  return {
    autoAcceptHours: settingNumber(db, 'reschedule_autoaccept_hours', 24, { min: 1, max: 72, integer: true }),
    leadMinutes: settingNumber(db, 'event_window_lead_minutes', 20, { min: 5, max: 60, integer: true }),
    minAheadMinutes: settingNumber(db, 'reschedule_min_ahead_minutes', PROPOSE_MIN_AHEAD_MS / 60_000, { min: 60, max: 1440, integer: true }),
    autoAcceptMinAheadHours: settingNumber(db, 'reschedule_autoaccept_min_ahead_hours', AUTO_ACCEPT_MIN_AHEAD_MS / 3_600_000, { min: 25, max: 168, integer: true }),
    reminderHours: settingNumber(db, 'reschedule_reminder_hours', REMINDER_BEFORE_MS / 3_600_000, { min: 1, max: 48, integer: true }),
  };
}
```

The constants' comments become "The seeded default of reschedule_..." (keep `AUTO_ACCEPT_LOCK_BEFORE_MS` and `REMINDER_MIN_GAP_MS` as they are, with `// Structural (plan T5 Ruling 2): a guard derived from the two settings, not a policy.`). `autoAcceptAt` and `reminderAt` gain the trailing parameters:

```ts
export function autoAcceptAt(createdMs: number, proposedMs: number, hours: number, roomOpensMs: number | null = null, minAheadMs: number = AUTO_ACCEPT_MIN_AHEAD_MS): string | null {
  if (proposedMs - createdMs < minAheadMs) return null;
  const lock = Math.min(createdMs + hours * 3_600_000, proposedMs - AUTO_ACCEPT_LOCK_BEFORE_MS);
  if (roomOpensMs !== null && lock > roomOpensMs) return null;
  return new Date(lock).toISOString();
}
export function reminderAt(createdMs: number, autoAcceptIso: string | null, beforeMs: number = REMINDER_BEFORE_MS): string | null {
  if (autoAcceptIso === null) return null;
  const t = Date.parse(autoAcceptIso) - beforeMs;
  return t >= createdMs + REMINDER_MIN_GAP_MS ? new Date(t).toISOString() : null;
}
```

`timeIn` takes the margin: `function timeIn(m: P.MatchRow, raw: unknown, at: string, minAheadMs: number): string | null` with `>= minAheadMs` in its last line; its two callers pass `(o.rules.minAheadMinutes ?? 60) * 60_000`. `insertProposal` passes `(rules.autoAcceptMinAheadHours ?? 48) * 3_600_000` as `autoAcceptAt`'s fifth argument. `remindersDue` reads `const before = (scheduleRules(db).reminderHours ?? 24) * 3_600_000;` and calls `reminderAt(Date.parse(r.created_at), r.auto_accept_at, before)`.

- [ ] **Step 7: Run the tests and the typecheck**

Run: `npx vitest run tests/adminSettings.test.ts tests/bookingRules.test.ts tests/series.test.ts tests/schedule.test.ts tests/bookingRunner.test.ts tests/roomClock.test.ts && npm run typecheck`
Expected: PASS; every existing test keeps its expectations (the seeds equal the old constants).

- [ ] **Step 8: Commit**

```bash
git add src/db.ts src/settingsSchema.ts src/bookings/rules.ts src/bookings/runner.ts src/events/series.ts src/events/schedule.ts tests/bookingRules.test.ts tests/series.test.ts tests/schedule.test.ts tests/bookingRunner.test.ts
git commit -m "Tournaments T5: the closing grace, the server-wait alert, the presence fallback, the held-back slot and the reschedule margins are Competitive settings with the old values"
```

---
### Task 3: The ruleset reaches the box and the series engine

**Files:**
- Modify: `src/bookings/tournamentGames.ts`, `src/bookings/runner.ts`, `src/events/series.ts`
- Test: `tests/tournamentBooking.test.ts`, `tests/bookingRunner.test.ts`, `tests/series.test.ts`

**Interfaces:**
- Consumes: `TOURNAMENT_LINES`, `gameLinesOf` (`tournamentGames.ts`); `gameLines`, `CLEAR_LINES`, `bookingRules` (`runner.ts`, `bookings.ts`); `parseRules`, `MatchRules` (`rulesets.ts`); `stageRules`, `schedule`, `continueSeries` (`series.ts`).
- Produces:
  - `tournamentGames.ts`: `export function tournamentRuleLines(rules: MatchRules | null): string[]` (six cvar lines, `[]` for null); `export const TOURNAMENT_RULE_CLEAR: readonly string[]` (the six at the plugin's defaults); `gameLinesOf` puts the rule lines right after `TOURNAMENT_LINES`.
  - `runner.ts`: `gameLines` appends `tournamentRuleLines(bookingRules(b))` after `TOURNAMENT_LINES` on a tournament booking; `CLEAR_LINES` ends with `TOURNAMENT_RULE_CLEAR`.
  - `series.ts`: `export function soonText(seconds: number): string`; `schedule` waits `series.nextGameSeconds`; its three announcements say `soonText`.

- [ ] **Step 1: Write the failing tests**

In `tests/tournamentBooking.test.ts`, the `gameLinesOf` test keeps `rulesJson: '{"x":1}'` (unreadable: no rule lines, so its slices hold). Append a test in the same `describe`:

```ts
  it('puts the ruleset\'s plan T5 cvars right after the tournament lines in the burst (Ruling 17)', () => {
    const rules = { ...TEMPLATES['Standard Cup'], pause: { ...TEMPLATES['Standard Cup'].pause, techSeconds: 240 }, disconnect: { teamSeconds: 480 }, staffCall: { cooldownSeconds: 90 }, subs: { perMatch: 2, emergency: false, emergencyChargeSeconds: 30 } };
    const r = createTournamentBooking(db, { region: 'na', campaign: 'no_mercy', rulesJson: JSON.stringify(rules), rulesetId: null, gameConfig: 'standard', createdBy: P[9]!, sides: [sides()[0], sides()[1]], now: NOW });
    if (!r.ok) throw new Error(r.error);
    const serverId = addServer(db, { name: 'box', host: '10.0.0.1', port: 27015, rconPort: 1, rconPassword: 'x' });
    const g = createTournamentGame(db, { bookingId: r.value.id, serverId, campaign: 'no_mercy', teams: { a: P.slice(4, 8), b: P.slice(0, 4) }, bookingSideA: 'b', now: NOW });
    const all = gameLinesOf(db, { matchId: g.matchId, stopAfterMap: null, notice: 'x' });
    expect(all.slice(0, 9)).toEqual([
      'sm_pug_tournament 1', 'sm_pug_leave_budget 0', 'sm_pug_end_kick 0',
      'sm_pug_tech_limit 2', 'sm_pug_tech_seconds 240', 'sm_pug_dc_team_seconds 480', 'sm_pug_sub_emergency 0', 'sm_pug_sub_charge 30', 'sm_pug_admin_cooldown 90',
    ]);
    expect(all[9]).toBe(`sm_pug_match ${g.matchId} ${g.token} no_mercy`);
    expect(tournamentRuleLines(null)).toEqual([]);
    expect(TOURNAMENT_RULE_CLEAR).toEqual(['sm_pug_tech_limit 0', 'sm_pug_tech_seconds 300', 'sm_pug_dc_team_seconds 0', 'sm_pug_sub_emergency 0', 'sm_pug_sub_charge 0', 'sm_pug_admin_cooldown 180']);
  });
```

Import `tournamentRuleLines, TOURNAMENT_RULE_CLEAR` from `../src/bookings/tournamentGames.js` and `TEMPLATES` from `../src/rulesets.js`.

In `tests/bookingRunner.test.ts`, the `CLEAR_LINES` expectation ends with:

```ts
      'sm_pug_tournament 0',
      // Plan T5: the tournament box's match-rule cvars back to the plugin's defaults.
      'sm_pug_tech_limit 0', 'sm_pug_tech_seconds 300', 'sm_pug_dc_team_seconds 0', 'sm_pug_sub_emergency 0', 'sm_pug_sub_charge 0', 'sm_pug_admin_cooldown 180',
    ]);
```

In `tests/series.test.ts`, the first booking test's `expect(burst.slice(-3)).toEqual([...])` becomes:

```ts
    expect(burst.slice(-9)).toEqual([
      'sm_pug_tournament 1', 'sm_pug_leave_budget 0', 'sm_pug_end_kick 0',
      // Plan T5: the stage's snapshot (Standard Cup) as the box's match-rule cvars.
      'sm_pug_tech_limit 2', 'sm_pug_tech_seconds 300', 'sm_pug_dc_team_seconds 600', 'sm_pug_sub_emergency 1', 'sm_pug_sub_charge 0', 'sm_pug_admin_cooldown 180',
    ]);
```

(The fixture's stage is on Standard Cup, `eventFixture.ts` `cupId`.) In `describe('BookingRunner on a tournament box (plan T3c)')`'s first test add `expect(f.sent).toContain('sm_pug_dc_team_seconds 600');`. Append to `describe('SeriesEngine: games, picks, tiebreaks and the confirm window', ...)`:

```ts
  it('waits the stage\'s series.nextGameSeconds before a tiebreak and says so (plan T5 Ruling 16)', async () => {
    f = await seriesFixture();
    const s = f.db.prepare('SELECT s.id, s.rules_json, r.rules_json AS base FROM event_stages s JOIN rulesets r ON r.id = s.ruleset_id WHERE s.id = ?')
      .get(f.match().stage_id) as { id: number; rules_json: string | null; base: string };
    const rules = JSON.parse(s.rules_json ?? s.base) as Record<string, unknown>;
    f.db.prepare('UPDATE event_stages SET rules_json = ? WHERE id = ?').run(JSON.stringify({ ...rules, series: { nextGameSeconds: 180 } }), s.id);
    await f.tick();
    const g1 = f.gameOf(1);
    f.goLive(g1.match_id!);
    f.sent.length = 0;
    f.endGame(g1.match_id!, [{ map: 'l4d_vs_hospital01_apartment', a: 100, b: 100, half1Surv: 'a' }, { map: 'l4d_vs_hospital02_subway', a: 200, b: 200, half1Surv: 'b' }]);
    expect(Date.parse(f.booking().next_at!)).toBe(f.t.t + 180_000);
    expect(f.sent.some((c) => c.startsWith('say [Match] Game 1 is tied 300 to 300') && c.includes('in about 3 minutes'))).toBe(true);
    expect(soonText(60)).toBe('about a minute');
    expect(soonText(45)).toBe('about a minute');
    expect(soonText(180)).toBe('about 3 minutes');
  });
```

Import `soonText` from `../src/events/series.js`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/tournamentBooking.test.ts tests/bookingRunner.test.ts tests/series.test.ts`
Expected: FAIL (`tournamentRuleLines`, `TOURNAMENT_RULE_CLEAR`, `soonText` undefined; the burst and `CLEAR_LINES` lack the lines; the delay is 60 s).

- [ ] **Step 3: tournamentGames.ts**

Import `parseRules, type MatchRules` from `../rulesets.js`. After `TOURNAMENT_LINES` add:

```ts
/** Plan T5 Ruling 17: a tournament box's match rules as pug-match 0.3.26
 *  cvars. Pushed with the booking lines and every game burst, after
 *  TOURNAMENT_LINES; an older plugin ignores the unknown cvars. Rules the
 *  site cannot read push nothing: the box then keeps !tech and team
 *  reconnect tracking off, which is 0.3.25's behaviour. */
export function tournamentRuleLines(rules: MatchRules | null): string[] {
  if (!rules) return [];
  return [
    `sm_pug_tech_limit ${rules.pause.techPauses}`,
    `sm_pug_tech_seconds ${rules.pause.techSeconds}`,
    `sm_pug_dc_team_seconds ${rules.disconnect.teamSeconds}`,
    `sm_pug_sub_emergency ${rules.subs.emergency ? 1 : 0}`,
    `sm_pug_sub_charge ${rules.subs.emergencyChargeSeconds}`,
    `sm_pug_admin_cooldown ${rules.staffCall.cooldownSeconds}`,
  ];
}
/** The same six at pug-match's defaults, for CLEAR_LINES. */
export const TOURNAMENT_RULE_CLEAR: readonly string[] = [
  'sm_pug_tech_limit 0', 'sm_pug_tech_seconds 300', 'sm_pug_dc_team_seconds 0', 'sm_pug_sub_emergency 0', 'sm_pug_sub_charge 0', 'sm_pug_admin_cooldown 180',
];
const rulesOfJson = (json: string | null): MatchRules | null => {
  if (json === null) return null;
  try { return parseRules(json); } catch { return null; }
};
```

In `gameLinesOf`, read the rules with the row (`SELECT token, campaign, rules_json FROM matches WHERE id = ?`, typed `{ token: string | null; campaign: string; rules_json: string | null }`) and put `...tournamentRuleLines(rulesOfJson(m.rules_json)),` right after `...TOURNAMENT_LINES,`.

- [ ] **Step 4: runner.ts**

Import `TOURNAMENT_RULE_CLEAR, tournamentRuleLines` with `TOURNAMENT_LINES`. In `gameLines` replace the tournament spread with `...(b.purpose === 'tournament' ? [...TOURNAMENT_LINES, ...tournamentRuleLines(bookingRules(b))] : []),`. `CLEAR_LINES` ends with:

```ts
  'sm_pug_tournament 0',
  // Plan T5: a tournament box's match-rule cvars back to pug-match's defaults.
  ...TOURNAMENT_RULE_CLEAR,
];
```

- [ ] **Step 5: series.ts**

Remove `NEXT_DELAY_MS` from the `runner.js` import. After `seriesTimings` add:

```ts
/** "about a minute" or "about N minutes" (plan T5 Ruling 16): the runner
 *  loads a scheduled game on its minute pass, so a wait up to a minute reads
 *  as a minute. */
export function soonText(seconds: number): string {
  return seconds <= 60 ? 'about a minute' : `about ${Math.ceil(seconds / 60)} minutes`;
}
```

`schedule` waits the stage's delay:

```ts
  private schedule(m: P.MatchRow, b: B.BookingRow, rows: R.GameRow[], campaign: string, map: string | null, now: Date): boolean {
    const linked = rows.filter((g) => g.match_id !== null).length;
    if (b.games_allowed <= linked) {
      const r = B.appendTournamentGame(this.db, { bookingId: b.id, campaign, map, now });
      if (!r.ok) console.error(`[series] match ${m.id}: appending ${campaign} to booking ${b.id} failed (${r.error})`);
    }
    // Plan T5 Ruling 16: the stage's snapshot says how long between games.
    const delayMs = this.nextGameSeconds(m) * 1000;
    return B.setNext(this.db, b.id, campaign, new Date(now.getTime() + delayMs).toISOString(), now, null, map);
  }
  private nextGameSeconds(m: P.MatchRow): number {
    return stageRules(this.db, E.getStage(this.db, m.stage_id)!).series.nextGameSeconds;
  }
```

and the three announcements in `continueSeries` replace `in about a minute` with `` `in ${soonText(this.nextGameSeconds(m))}` `` (the tiebreak reload, the tiebreak and the next game). The comment above `schedule` says "after the stage's next-game delay" instead of "in a minute".

- [ ] **Step 6: Run the tests and the typecheck**

Run: `npx vitest run tests/tournamentBooking.test.ts tests/bookingRunner.test.ts tests/series.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/bookings/tournamentGames.ts src/bookings/runner.ts src/events/series.ts tests/tournamentBooking.test.ts tests/bookingRunner.test.ts tests/series.test.ts
git commit -m "Tournaments T5: a tournament box gets the stage's match rules as six plugin cvars with every booking push and game burst, the booking end clears them, and the series waits the ruleset's next-game delay"
```

---
### Task 4: Plugin: the team reconnect pool, forfeits that are not a `!gg`, the emergency sub and the cooldown cvar

**Files:**
- Modify: `plugin/pug-leave.inc`, `plugin/pug-gg.inc`, `plugin/pug-tourney.inc`, `plugin/pug-match.sp`
- Test: none automated (SourcePawn). The scratch compile (Step 6) must be clean; `tests/eventKindsParity.test.ts` still passes (no new `EmitEvent` kinds). The in-game rows are Task 11's.

**Interfaces:**
- Consumes: `LeaveTracking`, `LeaveRemaining`, `Timer_LeaveClock`, `LeaveTryPause`, `LeaveRelease`, `LeaveEmitState`, `LeaveNameOf`, `LeaveForget`, `Cmd_Leave`, `LeaveStatus`, `DumpLine` (leave); `Gg_Forfeit`, `Gg_CancelVote`, `Gg_Reset`, `Gg_ForfeitTail`, `g_iForfeitTeam` (gg); `TourneyOn`, `Tourney_BetweenChapters`, `Tourney_Sub`, `Cmd_PugSub`, `Tourney_AdminCall`, `Tourney_Lift`, `Tourney_Status`, `TokenArgOk`, `ModCall_AuthId`, `g_smCooldown` (tourney, modcall); `EndMatchNow`, `WriteDump`, `WinnerOf` (.sp).
- Produces (all used by Task 5 and the site):
  - `pug-leave.inc`: cvar `sm_pug_dc_team_seconds` (`g_cvDcTeamSeconds`); `bool LeaveTeamMode()`; `int LeaveTeamUsed(int team)`; `int LeaveTeamLeft(int team)`; `int LeaveFirstAbsent()`; `void LeaveCharge(int team, int secs)`; on a tournament box the pool forfeits through `Tourney_Forfeit(team, "disconnect")` and never `ABANDON`s; `STATUS leave team mode=<0|1> seconds=<n> used_a=<n> used_b=<n>`.
  - `pug-gg.inc`: `char g_sForfeitWhy[16]`; `void Gg_ForfeitAs(int team, const char[] why)`; `void Gg_ForfeitWinner(char[] winner, int maxlen)`; `Gg_ForfeitTail` adds ` forfeit_why=<why>` for a forfeit that is not a `!gg`.
  - `pug-tourney.inc`: cvars `sm_pug_sub_emergency`, `sm_pug_sub_charge`, `sm_pug_admin_cooldown`; `bool Tourney_EmergencyOk(int slot)`; `void Tourney_Forfeit(int team, const char[] why)`; RCON `sm_pug_forfeit <token> <a|b>`; `SUB ... emergency=1`; `tourney rules emergency=<0|1> charge=<n> cooldown=<n>` status line.

- [ ] **Step 1: pug-leave.inc, the pool**

After `ConVar g_cvLeaveHoldMax;` add:

```sourcepawn
ConVar g_cvDcTeamSeconds;

// Plan T5: on a tournament box the reconnect time is the team's, per game.
float g_fTeamDcUsed[3];             // [1] pug team a, [2] pug team b: seconds spent this game
int g_iTeamDcWarned[3];             // the last warning threshold announced, per team
```

In `LeaveInit`, after the `g_cvLeaveHoldMax` cvar:

```sourcepawn
	// Plan T5 Ruling 8: the site pushes this from the ruleset to a tournament
	// box only. 0, the default, leaves tracking to sm_pug_leave_budget, which
	// the site pushes as 0 there, so a box that predates this cvar keeps leave
	// tracking off exactly as before.
	g_cvDcTeamSeconds = CreateConVar("sm_pug_dc_team_seconds", "0",
		"Tournament box: reconnect seconds each team has per game while a rostered player is disconnected; at zero the team forfeits the game. 0 = off.",
		FCVAR_NOTIFY, true, 0.0, true, 3600.0);
```

In `LeaveReset`, before `g_bLeavePaused = false;`:

```sourcepawn
	for (int t = 0; t < 3; t++)
	{
		g_fTeamDcUsed[t] = 0.0;
		g_iTeamDcWarned[t] = 0;
	}
```

Replace `LeaveTracking` and the first line of `LeaveRemaining`'s body:

```sourcepawn
bool LeaveTracking()
{
	return (g_State == MS_Pending || g_State == MS_Live)
		&& !g_bSelfStarted
		&& g_sAbandoner[0] == '\0'
		&& (LeaveTeamMode() || g_cvLeaveBudget.IntValue > 0);
}

/** A tournament box with team reconnect time (plan T5): the pool replaces
 *  the per-player allowance and a forfeit replaces the abandon. */
bool LeaveTeamMode()
{
	return TourneyOn() && g_cvDcTeamSeconds != null && g_cvDcTeamSeconds.IntValue > 0;
}

int LeaveTeamUsed(int team)
{
	if (team != 1 && team != 2) return 0;
	return RoundToFloor(g_fTeamDcUsed[team]);
}

int LeaveTeamLeft(int team)
{
	if (team != 1 && team != 2) return 0;
	int left = g_cvDcTeamSeconds.IntValue - LeaveTeamUsed(team);
	return left < 0 ? 0 : left;
}

/** The first rostered slot that is disconnected now, or -1. */
int LeaveFirstAbsent()
{
	for (int i = 0; i < g_iRosterCount; i++)
	{
		if (g_fAbsentSince[i] > 0.0) return i;
	}
	return -1;
}

/** An emergency sub's cost (plan T5 Ruling 10): never takes the pool to
 *  zero by itself, so the charge alone forfeits nothing. */
void LeaveCharge(int team, int secs)
{
	if (!LeaveTeamMode() || secs <= 0 || (team != 1 && team != 2)) return;
	float cap = float(g_cvDcTeamSeconds.IntValue - 1);
	float next = g_fTeamDcUsed[team] + float(secs);
	if (next > cap) next = g_fTeamDcUsed[team] > cap ? g_fTeamDcUsed[team] : cap;
	g_fTeamDcUsed[team] = next;
	int left = LeaveTeamLeft(team);
	PrintToChatAll("\x04[Match]\x01 The emergency sub costs Team %s %d seconds of reconnect time (\x05%d:%02d\x01 left).",
		team == 1 ? "A" : "B", secs, left / 60, left % 60);
}

int LeaveRemaining(int slot)
{
	// Plan T5: the team's pool on a tournament box.
	if (LeaveTeamMode()) return LeaveTeamLeft(g_iRosterTeam[slot]);
	float used = g_fAbsentUsed[slot];
```

(the rest of `LeaveRemaining` unchanged).

- [ ] **Step 2: pug-leave.inc, the clock and the forfeit**

In `Timer_LeaveClock`, after `if (!g_bLeavePaused) LeaveTryPause();` add:

```sourcepawn
	// Plan T5: the team's pool, and a forfeit instead of an abandon.
	if (LeaveTeamMode())
	{
		LeaveTeamTick();
		return Plugin_Continue;
	}
```

and after `Timer_LeaveClock` add:

```sourcepawn
/** Once a second while someone is away on a tournament box (plan T5 Ruling
 *  8): a team whose rostered player is disconnected and not held spends one
 *  second, however many of its players are away. A hold still ends at
 *  sm_pug_leave_hold_max, as for a PUG. */
static void LeaveTeamTick()
{
	bool spending[3];
	for (int i = 0; i < g_iRosterCount; i++)
	{
		if (g_fAbsentSince[i] <= 0.0) continue;
		if (g_fHoldSince[i] > 0.0)
		{
			if (GetEngineTime() - g_fHoldSince[i] < g_cvLeaveHoldMax.FloatValue) continue;
			LeaveRelease(i);
			char held[MAX_NAME_LENGTH];
			LeaveNameOf(i, held, sizeof(held));
			PrintToChatAll("\x04[PUG]\x01 The hold on %s's reconnect time ran out. Their clock is running again.", held);
			LeaveEmitState(i, true);
		}
		int team = g_iRosterTeam[i];
		if (team == 1 || team == 2) spending[team] = true;
	}
	for (int team = 1; team <= 2; team++)
	{
		if (!spending[team]) continue;
		g_fTeamDcUsed[team] += 1.0;
		int left = LeaveTeamLeft(team);
		if (left <= 0)
		{
			LeaveTeamForfeit(team);
			return;
		}
		int threshold = left <= 10 ? 10 : left <= 30 ? 30 : left <= 60 ? 60 : 0;
		if (threshold != 0 && g_iTeamDcWarned[team] != threshold)
		{
			g_iTeamDcWarned[team] = threshold;
			PrintToChatAll("\x04[Match]\x01 Team %s has \x05%d seconds\x01 of reconnect time left. At zero it forfeits this game.", team == 1 ? "A" : "B", left);
		}
	}
}

/** The pool ran out (plan T5 Ruling 9): the team forfeits this game. No
 *  ABANDON, no abort, no ban; the absences are forgotten so nothing waits on
 *  anyone any more. */
static void LeaveTeamForfeit(int team)
{
	g_fTeamDcUsed[team] = float(g_cvDcTeamSeconds.IntValue);
	for (int i = 0; i < g_iRosterCount; i++)
	{
		g_fAbsentSince[i] = 0.0;
		g_fHoldSince[i] = 0.0;
	}
	g_bLeavePaused = false;
	g_bLeaveUnpausing = false;
	PrintToChatAll("\x04[Match]\x01 Team %s ran out of reconnect time and forfeits this game.", team == 1 ? "A" : "B");
	LogMessage("pug-match: team %s ran out of reconnect time in match %d", team == 1 ? "a" : "b", g_iMatchId);
	Tourney_Forfeit(team, "disconnect");
}
```

In `Event_LeaveDisconnect`, the chat line becomes (the pool is the team's on a tournament box):

```sourcepawn
	if (LeaveTeamMode())
		PrintToChatAll("\x04[Match]\x01 %s disconnected. Team %s has \x05%d:%02d\x01 of reconnect time left this game; the game pauses for them.",
			g_sLeaveName[slot], g_iRosterTeam[slot] == 1 ? "A" : "B", left / 60, left % 60);
	else
		PrintToChatAll("\x04[PUG]\x01 %s disconnected. They have \x05%d:%02d\x01 of reconnect time left for this match.",
			g_sLeaveName[slot], left / 60, left % 60);
```

In `Cmd_Leave`, the `add` branch's `g_fAbsentUsed[slot] -= float(secs);` becomes:

```sourcepawn
		// Plan T5: on a tournament box the time is the team's.
		if (LeaveTeamMode()) g_fTeamDcUsed[g_iRosterTeam[slot]] -= float(secs);
		else g_fAbsentUsed[slot] -= float(secs);
```

and the `end` branch's `g_fAbsentUsed[slot] = float(g_cvLeaveBudget.IntValue);` becomes:

```sourcepawn
		if (LeaveTeamMode()) g_fTeamDcUsed[g_iRosterTeam[slot]] = float(g_cvDcTeamSeconds.IntValue);
		else g_fAbsentUsed[slot] = float(g_cvLeaveBudget.IntValue);
```

At the end of `LeaveStatus` add:

```sourcepawn
	// Plan T5. Not "STATUS leave abandoner=", which src/abandon.ts reads.
	DumpLine("STATUS leave team mode=%d seconds=%d used_a=%d used_b=%d",
		LeaveTeamMode() ? 1 : 0, g_cvDcTeamSeconds.IntValue, LeaveTeamUsed(1), LeaveTeamUsed(2));
```

- [ ] **Step 3: pug-gg.inc and pug-match.sp, why and who wins**

After `int g_iForfeitTeam;` add `char g_sForfeitWhy[16];           // plan T5: "gg", "disconnect" or "staff"; empty = none`. In `Gg_Reset` add `g_sForfeitWhy[0] = '\0';`. Replace `Gg_Forfeit` and `Gg_ForfeitTail` with:

```sourcepawn
/** End the match with `team` forfeiting. A half already scored on this map is
 *  recorded as a (partial) map first, so the points it earned are kept. */
void Gg_Forfeit(int team)
{
	Gg_ForfeitAs(team, "gg");
}

/** Plan T5: the same end for a tournament box's reconnect pool running out
 *  ("disconnect") and a staff ruling ("staff"); those say so themselves. */
void Gg_ForfeitAs(int team, const char[] why)
{
	int a, b;
	Gg_Totals(a, b);
	LogMessage("[pug] match %d: team %s forfeits (%s) at a=%d b=%d on %s", g_iMatchId, team == 1 ? "a" : "b", why, a, b, g_sCurrentMap);
	if (StrEqual(why, "gg")) PrintToChatAll("[PUG] Team %s forfeits. GG.", team == 1 ? "A" : "B");
	if (!g_bPendingFinalize && !Gg_CurrentMapFinalized() && g_iRound1SurvPug != 0) FinalizeMap();
	strcopy(g_sForfeitWhy, sizeof(g_sForfeitWhy), why);
	g_iForfeitTeam = team;
	EndMatchNow("forfeit");
}

/** " forfeit=a" / " forfeit=b" for MATCH_END and the dump's END line; empty
 *  when nobody forfeited, so older backends see the line they always did. A
 *  forfeit that is not a !gg adds " forfeit_why=<why>" (plan T5); a !gg's
 *  line is exactly what it always was. */
void Gg_ForfeitTail(char[] out, int maxlen)
{
	if (g_iForfeitTeam == 0)
	{
		out[0] = '\0';
		return;
	}
	Format(out, maxlen, " forfeit=%s", g_iForfeitTeam == 1 ? "a" : "b");
	if (g_sForfeitWhy[0] != '\0' && !StrEqual(g_sForfeitWhy, "gg")) Format(out, maxlen, "%s forfeit_why=%s", out, g_sForfeitWhy);
}

/** Plan T5 Ruling 9: a forfeit that is not a !gg loses whatever the score,
 *  so the winner is the other team (the site believes a forfeit only when it
 *  names the loser). A !gg team is always behind, and is left alone. */
void Gg_ForfeitWinner(char[] winner, int maxlen)
{
	if (g_iForfeitTeam == 0 || g_sForfeitWhy[0] == '\0' || StrEqual(g_sForfeitWhy, "gg")) return;
	strcopy(winner, maxlen, g_iForfeitTeam == 1 ? "b" : "a");
}
```

In `pug-match.sp` `EndMatchNow` and `WriteDump`: after each `WinnerOf(a, b, winner, sizeof(winner));` add `Gg_ForfeitWinner(winner, sizeof(winner));`, and change `char ff[16];` to `char ff[48];` in both. Change `#define PLUGIN_VERSION "0.3.25"` to `"0.3.26"`.

- [ ] **Step 4: pug-tourney.inc, cvars, the forfeit and the cooldown**

After `float g_fTourneyApplyAt;` add:

```sourcepawn
ConVar g_cvSubEmergency;   // plan T5: a mid-chapter sub for a disconnected player
ConVar g_cvSubCharge;      // plan T5: what that costs the team's reconnect time
ConVar g_cvAdminCooldown;  // plan T5: seconds between two !admin calls of one player
```

In `Tourney_Init`, after the `sm_pug_tournament` cvar:

```sourcepawn
	g_cvSubEmergency = CreateConVar("sm_pug_sub_emergency", "0",
		"Tournament box: 1 = a captain may !sub a disconnected player mid-chapter while the game is paused for them.",
		FCVAR_NOTIFY, true, 0.0, true, 1.0);
	g_cvSubCharge = CreateConVar("sm_pug_sub_charge", "0",
		"Tournament box: seconds of the team's reconnect time an emergency sub costs.",
		FCVAR_NOTIFY, true, 0.0, true, 600.0);
	g_cvAdminCooldown = CreateConVar("sm_pug_admin_cooldown", "180",
		"Tournament box: seconds before the same player can call staff with !admin again.",
		FCVAR_NOTIFY, true, 30.0, true, 600.0);
	RegServerCmd("sm_pug_forfeit", Cmd_PugForfeit, "sm_pug_forfeit <token> <a|b> - staff ruled that this team forfeits the game (tournament box)");
```

In `Tourney_Status` add after its line:

```sourcepawn
	PrintToServer("tourney rules emergency=%d charge=%d cooldown=%d", g_cvSubEmergency.IntValue, g_cvSubCharge.IntValue, g_cvAdminCooldown.IntValue);
```

In `Tourney_AdminCall` replace `int left = MODCALL_COOLDOWN - (GetTime() - last);` with:

```sourcepawn
		// Plan T5 Ruling 15: the ruleset's cooldown (/mod keeps MODCALL_COOLDOWN).
		int left = g_cvAdminCooldown.IntValue - (GetTime() - last);
```

and change the comment above it to `// The per-account timestamp is the one /mod writes, so the two cannot be used in turn.`

At the end of the file add:

```sourcepawn
// ---------- forfeits that are not a !gg (plan T5) ----------

/** The reconnect pool ran out ("disconnect") or staff ruled it ("staff"):
 *  the game ends as a !gg does, with the why on MATCH_END and the dump. A
 *  freeze is lifted first (its line goes out while the token stands) but the
 *  game is not unpaused: the next game's load ends the pause. Once only. */
void Tourney_Forfeit(int team, const char[] why)
{
	if (team != 1 && team != 2) return;
	if (g_iForfeitTeam != 0) return;
	if (g_State != MS_Live && g_State != MS_Pending) return;
	if (g_bTourneyFrozen) Tourney_Lift("site", "reset", "", false);
	Gg_CancelVote();
	Gg_ForfeitAs(team, why);
}

/** sm_pug_forfeit <token> <a|b>: the desk's Forfeit the game (plan T5
 *  Ruling 12). Answers PUGOK forfeit team=<x>, PUGOK forfeit team=<x>
 *  already for a forfeit of that team already in place, or PUGERR. */
public Action Cmd_PugForfeit(int args)
{
	if (!TokenArgOk(args)) return Plugin_Handled;
	if (args < 2)
	{
		PrintToServer("PUGERR usage: sm_pug_forfeit <token> <a|b>");
		return Plugin_Handled;
	}
	if (!TourneyOn())
	{
		PrintToServer("PUGERR not a tournament box");
		return Plugin_Handled;
	}
	char t[4];
	GetCmdArg(2, t, sizeof(t));
	int team = StrEqual(t, "a") ? 1 : StrEqual(t, "b") ? 2 : 0;
	if (team == 0)
	{
		PrintToServer("PUGERR team is a or b");
		return Plugin_Handled;
	}
	if (g_iForfeitTeam != 0)
	{
		if (g_iForfeitTeam == team) PrintToServer("PUGOK forfeit team=%s already", t);
		else PrintToServer("PUGERR already forfeited");
		return Plugin_Handled;
	}
	if (g_State != MS_Live && g_State != MS_Pending)
	{
		PrintToServer("PUGERR no live match");
		return Plugin_Handled;
	}
	PrintToServer("PUGOK forfeit team=%s", t);
	PrintToChatAll("\x04[Match]\x01 Staff ruled that Team %s forfeits this game.", team == 1 ? "A" : "B");
	Tourney_Forfeit(team, "staff");
	return Plugin_Handled;
}
```

- [ ] **Step 5: pug-tourney.inc, the emergency sub**

After `Tourney_BetweenChapters` add:

```sourcepawn
/** Plan T5 Ruling 10: mid-chapter, a sub may replace a rostered player who
 *  is disconnected now while the game is paused, on a tournament box with
 *  team reconnect time and emergency subs on. */
bool Tourney_EmergencyOk(int slot)
{
	return g_cvSubEmergency.BoolValue && LeaveTeamMode() && slot >= 0 && slot < MAX_ROSTER
		&& g_fAbsentSince[slot] > 0.0 && LeaveRotoblinPaused();
}
```

In `Tourney_Sub`, delete the `if (!Tourney_BetweenChapters()) { ... return; }` block (the moment is judged once `out` is known), and replace the final `EmitPug("SUB by=%s out=%s in=%s map=%d", ...)` line with:

```sourcepawn
	// Between chapters, or (plan T5) mid-chapter for a player the game is paused for.
	bool emergency = !Tourney_BetweenChapters() && Tourney_EmergencyOk(outSlot);
	if (!Tourney_BetweenChapters() && !emergency)
	{
		if (g_cvSubEmergency.BoolValue) PrintToChat(client, "[Match] Mid-chapter, a sub can only replace a player who disconnected, while the game is paused for them. Otherwise wait for the next ready-up.");
		else PrintToChat(client, "[Match] Subs are made between chapters, not during one. Try again at the next ready-up.");
		return;
	}
	EmitPug("SUB by=%s out=%s in=%s map=%d%s", by, outId, inId, g_iMapCount, emergency ? " emergency=1" : "");
```

In `Cmd_PugSub`, replace the `if (!Tourney_BetweenChapters()) { PrintToServer("PUGERR not between chapters"); ... }` block with:

```sourcepawn
	// The site checked the moment when the captain asked; the game may have
	// gone live since, or the dropped player may be back (plan T5).
	bool emergency = !Tourney_BetweenChapters() && Tourney_EmergencyOk(outSlot);
	if (!Tourney_BetweenChapters() && !emergency)
	{
		PrintToServer("PUGERR not between chapters");
		return Plugin_Handled;
	}
```

after `LeaveForget(outSlot);` add `if (emergency) LeaveCharge(team, g_cvSubCharge.IntValue);`, and the two chat lines say the kind:

```sourcepawn
	if (inClient != -1) PrintToChatAll("\x04[Match]\x01 %N replaces %s for Team %s%s.", inClient, outName, team == 1 ? "A" : "B", emergency ? " (emergency sub)" : "");
	else PrintToChatAll("\x04[Match]\x01 A sub replaces %s for Team %s%s; they are placed when they connect.", outName, team == 1 ? "A" : "B", emergency ? " (emergency sub)" : "");
```

- [ ] **Step 6: Compile in a scratch copy**

```bash
SCR=$(mktemp -d)
cp -r /home/volence/l4d/pug/.claude/worktrees/match-rules/plugin "$SCR/plugin"
cp -r /home/volence/l4d/Rotoblin-AZMod/SourceCode/scripting-az "$SCR/scripting-az"
# build.sh would borrow geoip.inc from the local test server; give the scratch tree its own instead.
cp /home/volence/l4d/sourcetv/deps/sourcemod-1.12/plugins/include/geoip.inc "$SCR/scripting-az/include/geoip.inc"
(cd "$SCR/plugin" && PUG_SCRIPTING="$SCR/scripting-az" bash build.sh)
rm -rf "$SCR"
```

Expected: `built: <scratch>/plugin/pug-match.smx` and no `error` lines (the warnings 0.3.25 already printed, if any, and no new ones). Nothing is written under the worktree or the Rotoblin tree. Then run `npx vitest run tests/eventKindsParity.test.ts`: PASS.

- [ ] **Step 7: Commit**

```bash
git add plugin/pug-leave.inc plugin/pug-gg.inc plugin/pug-tourney.inc plugin/pug-match.sp
git commit -m "pug-match 0.3.26: a tournament box keeps reconnect time per team per game and a team that runs out forfeits the game, staff can rule a forfeit with sm_pug_forfeit, a disconnected player can be replaced mid-chapter, and the admin call cooldown is a cvar"
```

---
### Task 5: Plugin: technical pauses, the overrun into tactical pauses and `!flag`

**Files:**
- Modify: `plugin/pug-pause.inc`, `plugin/pug-tourney.inc`, `plugin/README.md`
- Test: none automated (SourcePawn). The scratch compile must be clean. The in-game rows are Task 11's.

**Interfaces:**
- Consumes: `PauseClockTick`, `PauseReset`, `PauseStatus`, `PauseRemaining`, `PauseLimit`, `PauseTeamName`, `PauseAllowInternal`, `g_iPauseOwner`, `g_iPauseUsed`, `g_fPauseStarted`, `g_fPauseHeld`, `g_iPauseWarned` (pause); `LeaveAnyAbsent`, `LeaveTeamMode`, `LeaveTeamUsed`, `LeaveFirstAbsent`, `g_cvDcTeamSeconds`, `LeaveRotoblinPaused`, `LeaveUnpauseNow`, `g_bLeavePaused` (leave, Task 4); `TourneyOn`, `TourneyFrozen`, `Tourney_RetryGap`, `Tourney_SlotOut`, `Tourney_OnSay`, `ModCall_TriggerEnd`, `ModCall_AuthId`, `SanitizeChat`, `PugLog`, `RoundMs`, `g_iRplMapSeq`, `g_iHalf`, `g_iMatchId` (tourney, modcall, .sp).
- Produces: cvars `sm_pug_tech_limit`, `sm_pug_tech_seconds`; `int Tech_Left(int team)`; `!tech <reason>`; `!flag [note]`; the signed line `PUG <token> TECH event=<start|end|over|flag> id=<unix> team=<a|b> cause=<call|disconnect> by=<id64|none> used=<s> budget=<s>[ tactical=<n>] text=<text>`; `PUGCALL ... reason=tech target=none ...`; status line `tech limit=<n> seconds=<n> count_a=<n> count_b=<n> used_a=<n> used_b=<n> open=<0|1|2>`.

- [ ] **Step 1: pug-pause.inc, state and cvars**

After `ConVar g_cvPauseLimit;` add:

```sourcepawn
// ---------- technical pauses (plan T5, tournament boxes only) ----------
//
// !tech <reason> (pug-tourney.inc) lets a pause through that this file then
// treats as technical, the same "charge what happened" way as a tactical
// pause: only once the game is seen paused. Technical time runs once a
// second while the team's technical pause holds and nobody is away and the
// staff freeze is off. Past the team's technical time the pause becomes one
// of its tactical pauses, then another as each ceiling runs out, and with
// none left the game unpauses (Rulings 5 and 6). A disconnect pause on a
// tournament box with team reconnect time is recorded as technical too, but
// its time is the team's reconnect time, which pug-leave.inc spends (Ruling 7).

#define TECH_CAUSE_CALL 1
#define TECH_CAUSE_DC   2

ConVar g_cvTechLimit;
ConVar g_cvTechSeconds;

int g_iTechCount[3];          // technical pauses each pug team declared this game
float g_fTechUsed[3];         // technical seconds each pug team spent this game
int g_iTechOwner;             // pug team whose technical clock runs now; 0 = none
int g_iTechOpen;              // pug team of the TECH record open now (kept through an overrun); 0 = none
int g_iTechCause;             // TECH_CAUSE_CALL or TECH_CAUSE_DC of the open record
int g_iTechId;                // the open record's id=: the unix second it began
bool g_bTechFlagged;          // the other team flagged the open record
int g_iTechWarned;            // last technical-time warning announced, in seconds left
char g_sTechBy[24];           // who declared it, or who disconnected
char g_sTechReason[160];
int g_iTechPendingTeam;       // a !tech let through that has not been seen to pause yet
float g_fTechPendingAt;
char g_sTechPendingBy[24];
char g_sTechPendingReason[160];
bool g_bPauseConverted;       // technical time ran out: this pause is the owner's tactical pause(s) now
```

In `PauseInit`, after the `g_cvPauseLimit` cvar:

```sourcepawn
	g_cvTechLimit = CreateConVar("sm_pug_tech_limit", "0",
		"Tournament box: technical pauses (!tech <reason>) each team may call per game. 0 turns !tech off.",
		FCVAR_NOTIFY, true, 0.0, true, 10.0);
	g_cvTechSeconds = CreateConVar("sm_pug_tech_seconds", "300",
		"Tournament box: technical time each team has per game, in seconds. Past it the pause uses the team's tactical pauses.",
		FCVAR_NOTIFY, true, 0.0, true, 3600.0);
```

In `PauseReset`, before `g_sPhaseLast[0] = '\0';`:

```sourcepawn
	for (int t = 0; t < 3; t++)
	{
		g_iTechCount[t] = 0;
		g_fTechUsed[t] = 0.0;
	}
	g_iTechOwner = 0;
	g_iTechOpen = 0;
	g_iTechCause = 0;
	g_iTechId = 0;
	g_bTechFlagged = false;
	g_iTechWarned = 0;
	g_sTechBy[0] = '\0';
	g_sTechReason[0] = '\0';
	g_iTechPendingTeam = 0;
	g_bPauseConverted = false;
```

At the end of `PauseStatus`:

```sourcepawn
	PrintToServer("tech limit=%d seconds=%d count_a=%d count_b=%d used_a=%d used_b=%d open=%d",
		g_cvTechLimit.IntValue, g_cvTechSeconds.IntValue, g_iTechCount[1], g_iTechCount[2],
		RoundToFloor(g_fTechUsed[1]), RoundToFloor(g_fTechUsed[2]), g_iTechOpen);
```

- [ ] **Step 2: pug-pause.inc, the technical record**

After `PauseTeamName` add:

```sourcepawn
int Tech_Left(int team)
{
	if (team != 1 && team != 2) return 0;
	int left = g_cvTechSeconds.IntValue - RoundToFloor(g_fTechUsed[team]);
	return left < 0 ? 0 : left;
}

/** One signed TECH line for the open record. tactical -2 = leave the key out. */
void Tech_Emit(const char[] ev, int team, const char[] by, int used, int budget, int tactical, const char[] text)
{
	char tac[24];
	if (tactical == -2) tac[0] = '\0';
	else Format(tac, sizeof(tac), " tactical=%d", tactical);
	EmitPug("TECH event=%s id=%d team=%s cause=%s by=%s used=%d budget=%d%s text=%s",
		ev, g_iTechId, team == 1 ? "a" : "b", g_iTechCause == TECH_CAUSE_DC ? "disconnect" : "call",
		by[0] != '\0' ? by : "none", used, budget, tac, text);
}

/** A !tech pug-tourney.inc let through became this pause: within the retry
 *  gap (Rotoblin's pause delay plus a margin), on a tournament box, and not
 *  a disconnect or freeze pause. A stale request is dropped. */
static bool Tech_PendingLanded()
{
	if (g_iTechPendingTeam == 0) return false;
	bool landed = TourneyOn() && !g_bLeavePaused && !TourneyFrozen() && GetEngineTime() - g_fTechPendingAt <= Tourney_RetryGap();
	if (!landed) g_iTechPendingTeam = 0;
	return landed;
}

static void Tech_Begin()
{
	int team = g_iTechPendingTeam;
	g_iTechPendingTeam = 0;
	g_iTechOwner = team;
	g_iTechOpen = team;
	g_iTechCause = TECH_CAUSE_CALL;
	g_iTechId = GetTime();
	g_iTechCount[team]++;
	g_bTechFlagged = false;
	g_iTechWarned = 0;
	strcopy(g_sTechBy, sizeof(g_sTechBy), g_sTechPendingBy);
	strcopy(g_sTechReason, sizeof(g_sTechReason), g_sTechPendingReason);
	char name[16];
	PauseTeamName(team, name, sizeof(name));
	int left = Tech_Left(team);
	PrintToChatAll("\x04[Match]\x01 %s technical pause: \x05%s\x01 (%d:%02d of technical time left; the other team can !flag it for staff).",
		name, g_sTechReason, left / 60, left % 60);
	Tech_Emit("start", team, g_sTechBy, RoundToFloor(g_fTechUsed[team]), g_cvTechSeconds.IntValue, -2, g_sTechReason);
}

/** The leave module's disconnect pause on a tournament box with team
 *  reconnect time: a technical record of the dropped player's team whose
 *  clock is the reconnect pool (Ruling 7). */
static void Tech_BeginDisconnect()
{
	if (!LeaveTeamMode()) return;
	int slot = LeaveFirstAbsent();
	if (slot < 0) return;
	int team = g_iRosterTeam[slot];
	if (team != 1 && team != 2) return;
	g_iTechOwner = 0;
	g_iTechOpen = team;
	g_iTechCause = TECH_CAUSE_DC;
	g_iTechId = GetTime();
	g_bTechFlagged = false;
	strcopy(g_sTechBy, sizeof(g_sTechBy), g_sRosterId[slot]);
	strcopy(g_sTechReason, sizeof(g_sTechReason), "disconnected");
	Tech_Emit("start", team, g_sTechBy, LeaveTeamUsed(team), g_cvDcTeamSeconds.IntValue, -2, g_sTechReason);
}

/** The game unpaused: the open record ends. */
static void Tech_End()
{
	if (g_iTechOpen == 0) return;
	int team = g_iTechOpen;
	bool dc = g_iTechCause == TECH_CAUSE_DC;
	Tech_Emit("end", team, g_sTechBy, dc ? LeaveTeamUsed(team) : RoundToFloor(g_fTechUsed[team]),
		dc ? g_cvDcTeamSeconds.IntValue : g_cvTechSeconds.IntValue, -2, "");
	g_iTechOpen = 0;
	g_iTechOwner = 0;
	g_iTechCause = 0;
	g_bTechFlagged = false;
	g_sTechBy[0] = '\0';
	g_sTechReason[0] = '\0';
}

/** Once a second while a !tech pause holds (Ruling 6). */
static void Tech_Tick()
{
	if (LeaveAnyAbsent() || TourneyFrozen()) return;
	int team = g_iTechOwner;
	g_fTechUsed[team] += 1.0;
	int left = Tech_Left(team);
	if (left <= 0)
	{
		Tech_Overrun();
		return;
	}
	int threshold = left <= 10 ? 10 : left <= 30 ? 30 : left <= 60 ? 60 : 0;
	if (threshold != 0 && g_iTechWarned != threshold)
	{
		g_iTechWarned = threshold;
		char name[16];
		PauseTeamName(team, name, sizeof(name));
		PrintToChatAll("\x04[Match]\x01 %s has \x05%d seconds\x01 of technical time left. Past it the pause uses a tactical pause.", name, left);
	}
}

/** Technical time ran out: charge a tactical pause and run its ceiling, or
 *  unpause when the team has none left (Ruling 6). */
static void Tech_Overrun()
{
	int team = g_iTechOwner;
	g_iTechOwner = 0;
	char name[16];
	PauseTeamName(team, name, sizeof(name));
	int used = RoundToFloor(g_fTechUsed[team]);
	if (PauseLimit() > 0 && PauseRemaining(team) <= 0)
	{
		PrintToChatAll("\x04[Match]\x01 %s is out of technical time and has no tactical pause left. Unpausing.", name);
		Tech_Emit("over", team, g_sTechBy, used, g_cvTechSeconds.IntValue, -1, "");
		LeaveUnpauseNow();
		return;
	}
	if (PauseLimit() > 0) g_iPauseUsed[team]++;
	g_iPauseOwner = team;
	g_bPauseConverted = true;
	g_fPauseStarted = GetEngineTime();
	g_fPauseHeld = 0.0;
	g_iPauseWarned = 0;
	int left = PauseLimit() > 0 ? PauseRemaining(team) : -1;
	if (left >= 0) PrintToChatAll("\x04[Match]\x01 %s is out of technical time: this pause now uses one of their tactical pauses (\x05%d\x01 left).", name, left);
	else PrintToChatAll("\x04[Match]\x01 %s is out of technical time: this pause is now a tactical pause.", name);
	Tech_Emit("over", team, g_sTechBy, used, g_cvTechSeconds.IntValue, left < 0 ? 0 : left, "");
	EmitPug("PAUSE team=%d used=%d limit=%d", team, g_iPauseUsed[team], PauseLimit());
}
```

- [ ] **Step 3: pug-pause.inc, the clock**

Replace `PauseClockTick` with:

```sourcepawn
static void PauseClockTick()
{
	bool paused = LeaveRotoblinPaused();

	if (paused && !g_bPauseSeen)
	{
		g_bPauseSeen = true;
		g_fPauseStarted = GetEngineTime();
		g_fPauseHeld = 0.0;
		g_iPauseWarned = 0;
		g_bPauseConverted = false;
		// Plan T5: a !tech pause is nobody's tactical pause; it has its own clock.
		bool tech = Tech_PendingLanded();
		// A pause the leave module caused is nobody's: not charged, and not
		// subject to the ceiling either, because the player it is waiting for
		// has a reconnect allowance that is allowed to outlast it.
		// A pause the staff freeze caused is nobody's either (plan T3c);
		// g_iPausePendingTeam may hold a stale request Rotoblin refused, which
		// must not be charged for it.
		g_iPauseOwner = (g_bLeavePaused || TourneyFrozen() || tech) ? 0 : g_iPausePendingTeam;
		g_iPausePendingTeam = 0;
		// Only a request from the last few seconds: one Rotoblin refused
		// without pausing must not be pinned on a later, unrelated pause.
		if (g_bLeavePaused || GetEngineTime() - g_fPausePendingAt > PAUSE_BY_WINDOW || TourneyFrozen() || tech) g_sPauseBy[0] = '\0';
		else strcopy(g_sPauseBy, sizeof(g_sPauseBy), g_sPausePendingBy);
		g_sPausePendingBy[0] = '\0';
		if (tech) Tech_Begin();
		else if (g_bLeavePaused) Tech_BeginDisconnect();
		if (g_iPauseOwner == 1 || g_iPauseOwner == 2)
		{
			g_iPauseUsed[g_iPauseOwner]++;
			char name[16];
			PauseTeamName(g_iPauseOwner, name, sizeof(name));
			int left = PauseRemaining(g_iPauseOwner);
			int ceiling = g_cvPauseSeconds.IntValue;
			if (ceiling > 0)
			{
				PrintToChatAll("\x04[PUG]\x01 %s pause \x05%d:%02d\x01 max. \x05%d\x01 pause%s left this campaign.",
					name, ceiling / 60, ceiling % 60, left, left == 1 ? "" : "s");
			}
			else
			{
				PrintToChatAll("\x04[PUG]\x01 %s pause. \x05%d\x01 pause%s left this campaign.",
					name, left, left == 1 ? "" : "s");
			}
			EmitPug("PAUSE team=%d used=%d limit=%d", g_iPauseOwner, g_iPauseUsed[g_iPauseOwner], PauseLimit());
		}
		return;
	}

	if (!paused)
	{
		if (g_bPauseSeen)
		{
			// Plan T5: the open technical record ends with the pause.
			Tech_End();
			g_bPauseSeen = false;
			g_iPauseOwner = 0;
			g_iPausePendingTeam = 0;
			g_sPauseBy[0] = '\0';
			g_bPauseConverted = false;
		}
		return;
	}

	// Plan T5: a technical pause spends its team's technical time instead of
	// running a ceiling.
	if (g_iTechOwner != 0)
	{
		Tech_Tick();
		return;
	}

	// Paused, and we have seen it before: run the ceiling.
	int ceiling = g_cvPauseSeconds.IntValue;
	if (ceiling <= 0 || g_iPauseOwner == 0) return;

	// The clock does not run while a rostered player is actually away. A
	// player pause that a disconnect lands in the middle of must not expire
	// under someone who is still loading back in.
	// Nor while the staff freeze holds a team's pause (plan T3c): the expiry
	// path would call LeaveUnpauseNow, which the freeze refuses, say
	// "Unpausing." and emit PAUSE_EXPIRED for nothing. The frozen seconds are
	// held like an absence, so the team's clock picks up where it was once the
	// freeze is lifted instead of expiring the moment it is.
	if (LeaveAnyAbsent() || TourneyFrozen())
	{
		g_fPauseHeld += 1.0;
		return;
	}

	int left = ceiling - RoundToFloor(GetEngineTime() - g_fPauseStarted - g_fPauseHeld);

	if (left <= 0)
	{
		char name[16];
		PauseTeamName(g_iPauseOwner, name, sizeof(name));
		// Plan T5 Ruling 6: technical time past its budget takes the team's
		// tactical pauses one at a time while it has any.
		if (g_bPauseConverted && PauseLimit() > 0 && PauseRemaining(g_iPauseOwner) > 0)
		{
			g_iPauseUsed[g_iPauseOwner]++;
			g_fPauseStarted = GetEngineTime();
			g_fPauseHeld = 0.0;
			g_iPauseWarned = 0;
			int more = PauseRemaining(g_iPauseOwner);
			PrintToChatAll("\x04[Match]\x01 %s's pause runs on into another tactical pause (\x05%d\x01 left).", name, more);
			EmitPug("PAUSE team=%d used=%d limit=%d", g_iPauseOwner, g_iPauseUsed[g_iPauseOwner], PauseLimit());
			return;
		}
		PrintToChatAll("\x04[PUG]\x01 %s's pause has run out. Unpausing.", name);
		EmitPug("PAUSE_EXPIRED team=%d seconds=%d", g_iPauseOwner, ceiling);
		// Plan T5: g_bPauseSeen is cleared below, so the unpause transition
		// will not end a converted pause's technical record: end it here.
		Tech_End();
		// The same both-teams-ready path a player unpause takes, so
		// Rotoblin's own countdown and its frozen-smoker-victim fix apply.
		LeaveUnpauseNow();
		g_bPauseSeen = false;
		g_iPauseOwner = 0;
		g_sPauseBy[0] = '\0';
		return;
	}

	// Announced once each, so nobody is surprised by the game unfreezing.
	for (int mark = 30; mark >= 10; mark -= 20)
	{
		if (left <= mark && g_iPauseWarned != mark && (g_iPauseWarned == 0 || g_iPauseWarned > mark))
		{
			g_iPauseWarned = mark;
			PrintToChatAll("\x04[PUG]\x01 Unpausing in \x05%d\x01 seconds. Type \x05!ready\x01 to go now.", mark);
			break;
		}
	}
	return;
}
```

On a PUG box `Tech_PendingLanded` is false (no `!tech` there: `TourneyOn()` gates the command and the landing), `Tech_BeginDisconnect` returns at once (`LeaveTeamMode()` false), `g_iTechOwner` stays 0 and `g_bPauseConverted` stays false, so the function behaves exactly as before. On a PUG box `Tech_End` in the expiry branch is a no-op (no record is ever open).

- [ ] **Step 4: pug-tourney.inc, `!tech` and `!flag`**

In `Tourney_OnSay`, before the `!admin` trigger:

```sourcepawn
	// Plan T5: a technical pause, and the other team's flag on one.
	rest = ModCall_TriggerEnd(text, "!tech");
	if (rest < 0) rest = ModCall_TriggerEnd(text, "/tech");
	if (rest >= 0)
	{
		Tourney_Tech(client, text[rest]);
		return true;
	}
	rest = ModCall_TriggerEnd(text, "!flag");
	if (rest < 0) rest = ModCall_TriggerEnd(text, "/flag");
	if (rest >= 0)
	{
		Tourney_Flag(client, text[rest]);
		return true;
	}
```

and after the `!sub` section add:

```sourcepawn
// ---------- !tech and !flag (plan T5) ----------

/** The pug team of a rostered, not subbed-out client, else 0. */
static int Tourney_TeamOf(int client)
{
	if (client < 1 || client > MaxClients || !IsClientInGame(client) || IsFakeClient(client)) return 0;
	int slot = g_iClientRoster[client];
	if (slot < 0 || Tourney_SlotOut(slot)) return 0;
	int team = g_iRosterTeam[slot];
	return team == 1 || team == 2 ? team : 0;
}

/** !tech <reason> (Ruling 5): the pause is Rotoblin's own sm_pause from this
 *  player, unbudgeted as a tactical pause; pug-pause.inc makes it technical
 *  once the game is seen paused. */
void Tourney_Tech(int client, const char[] args)
{
	if (client < 1 || client > MaxClients || !IsClientInGame(client) || IsFakeClient(client)) return;
	if (g_cvTechLimit.IntValue <= 0)
	{
		PrintToChat(client, "[Match] Technical pauses are off in this match.");
		return;
	}
	int team = Tourney_TeamOf(client);
	if (team == 0)
	{
		PrintToChat(client, "[Match] Only players in the match can call a technical pause.");
		return;
	}
	char reason[160];
	strcopy(reason, sizeof(reason), args);
	StripQuotes(reason);
	TrimString(reason);
	SanitizeChat(reason, sizeof(reason));
	if (strlen(reason) < 3)
	{
		PrintToChat(client, "[Match] Usage: !tech <reason>. Both teams and staff see the reason.");
		return;
	}
	if (g_State != MS_Live || InReadyUp() || g_bRoundEnded || g_fRoundLiveAt <= 0.0)
	{
		PrintToChat(client, "[Match] A technical pause is called during a live round.");
		return;
	}
	if (LeaveRotoblinPaused())
	{
		PrintToChat(client, "[Match] The game is already paused.");
		return;
	}
	if (g_iTechCount[team] >= g_cvTechLimit.IntValue)
	{
		PrintToChat(client, "[Match] Your team has used all %d technical pauses this game.", g_cvTechLimit.IntValue);
		return;
	}
	if (Tech_Left(team) <= 0)
	{
		PrintToChat(client, "[Match] Your team has no technical time left this game. Use !pause for a tactical pause.");
		return;
	}
	char by[24];
	if (!ModCall_AuthId(client, by, sizeof(by)))
	{
		PrintToChat(client, "[PUG] Your Steam ID is not verified yet, try again in a moment.");
		return;
	}
	g_iTechPendingTeam = team;
	g_fTechPendingAt = GetEngineTime();
	strcopy(g_sTechPendingBy, sizeof(g_sTechPendingBy), by);
	strcopy(g_sTechPendingReason, sizeof(g_sTechPendingReason), reason);
	// Unbudgeted as a tactical pause, as the leave module's pause is.
	PauseAllowInternal();
	FakeClientCommand(client, "sm_pause");
}

/** !flag [note] (Ruling 11): the other team's technical pause, once, to
 *  staff through the mod-call path. Play is not affected. */
void Tourney_Flag(int client, const char[] args)
{
	int team = Tourney_TeamOf(client);
	if (team == 0)
	{
		PrintToChat(client, "[Match] Only players in the match can flag a technical pause.");
		return;
	}
	if (g_iTechOpen == 0 || g_iTechOpen == team)
	{
		PrintToChat(client, "[Match] !flag is for the other team's technical pause, while it runs.");
		return;
	}
	if (g_bTechFlagged)
	{
		PrintToChat(client, "[Match] This technical pause is already flagged for staff.");
		return;
	}
	char id[24];
	if (!ModCall_AuthId(client, id, sizeof(id)))
	{
		PrintToChat(client, "[PUG] Your Steam ID is not verified yet, try again in a moment.");
		return;
	}
	char note[160];
	strcopy(note, sizeof(note), args);
	StripQuotes(note);
	TrimString(note);
	SanitizeChat(note, sizeof(note));
	g_bTechFlagged = true;
	char pausing[16];
	strcopy(pausing, sizeof(pausing), g_iTechOpen == 1 ? "Team A" : "Team B");
	char map[64];
	GetCurrentMap(map, sizeof(map));
	char line[512];
	// text= stays last: it runs to the end of the line.
	Format(line, sizeof(line), "PUGCALL steamid=%s target=none tteam=%d reason=tech match=%d ord=%d half=%d tms=%d via=game map=%s text=%s technical pause: %s%s%s",
		id, GetClientTeam(client), g_iMatchId, g_iRplMapSeq, g_iHalf, RoundMs(), map, pausing, g_sTechReason, note[0] != '\0' ? " | " : "", note);
	PugLog("%s", line);
	LogMessage("[tourney] %s", line);
	bool dc = g_iTechCause == TECH_CAUSE_DC;
	Tech_Emit("flag", g_iTechOpen, id, dc ? LeaveTeamUsed(g_iTechOpen) : RoundToFloor(g_fTechUsed[g_iTechOpen]),
		dc ? g_cvDcTeamSeconds.IntValue : g_cvTechSeconds.IntValue, -2, note);
	PrintToChatAll("\x04[Match]\x01 %N flagged %s's technical pause for staff review. Play goes on as normal; staff decide.", client, pausing);
}
```

- [ ] **Step 5: README rows**

In `plugin/README.md`: the RCON table gains

```markdown
| `sm_pug_forfeit` | `<token> <a\|b>` | 0.3.26 and later, tournament box only. Staff ruled that this pug team forfeits the game (the Events desk's Forfeit the game). The game ends as a `!gg` does, with `forfeit=<team> forfeit_why=staff` and the other team as `winner=`. Answers `PUGOK forfeit team=<x>`, `PUGOK forfeit team=<x> already`, or `PUGERR <reason>`. |
```

The cvar table gains six rows ("0.3.26 and later; the site pushes them from the stage's ruleset to a tournament box and resets them when the booking ends"): `sm_pug_tech_limit` `0` (technical pauses per team per game; 0 turns `!tech` off), `sm_pug_tech_seconds` `300` (technical time per team per game; past it the pause uses tactical pauses, then unpauses), `sm_pug_dc_team_seconds` `0` (reconnect seconds per team per game on a tournament box; at zero the team forfeits the game with `forfeit_why=disconnect`; 0 leaves tracking to `sm_pug_leave_budget`), `sm_pug_sub_emergency` `0` (1 lets a captain `!sub` a disconnected player mid-chapter while the game is paused for them), `sm_pug_sub_charge` `0` (seconds of reconnect time an emergency sub costs; never forfeits by itself), `sm_pug_admin_cooldown` `180` (seconds between two `!admin` calls of one player; `/mod` keeps 180). The `sm_pug_tournament` row adds "`!tech <reason>` and `!flag [note]` (0.3.26)". The wire grammar section gains:

```markdown
`PUG <token> TECH event=<start|end|over|flag> id=<unix second it began> team=<a|b> cause=<call|disconnect> by=<steamid64|none> used=<s> budget=<s> [tactical=<n>] text=<free text>` (0.3.26, tournament box): a technical pause of pug team `team` (`cause=disconnect`: the leave module's pause, `used`/`budget` are the team's reconnect time; else technical time). `over`: technical time ran out; `tactical` is the team's tactical pauses left after the charge, `-1` when it had none and the game unpaused. `flag`: `by` flagged it, `text` is their note. `text=` runs to the end of the line.
`PUG <token> SUB ... emergency=1` (0.3.26): a mid-chapter sub for a disconnected player.
`MATCH_END ... forfeit=<a|b> forfeit_why=<disconnect|staff>` and the dump's `END ... forfeit=<a|b> forfeit_why=<...>` (0.3.26): a forfeit that is not a `!gg`; `winner=` is then the other team whatever the score. A `!gg` carries no `forfeit_why`.
`PUGCALL ... reason=tech target=none ...` (0.3.26): `!flag` on a tournament box.
```

- [ ] **Step 6: Compile in a scratch copy**

Run the five commands of Task 4 Step 6 again. Expected: `built: <scratch>/plugin/pug-match.smx`, no `error` lines, no new warnings; `rm -rf "$SCR"` leaves nothing behind. Then `git -C /home/volence/l4d/pug/.claude/worktrees/match-rules status --short plugin/` lists only the three edited files (no `.smx`).

- [ ] **Step 7: Commit**

```bash
git add plugin/pug-pause.inc plugin/pug-tourney.inc plugin/README.md
git commit -m "pug-match 0.3.26: technical pauses with a reason and a time budget per team per game that run over into tactical pauses, disconnect pauses recorded as technical, and the other team's flag to staff, all on tournament boxes only"
```

---
### Task 6: The site reads the new lines: `TECH`, emergency subs, the flag reason and why a game was forfeited

**Files:**
- Modify: `src/logParse.ts`, `src/dumpParse.ts`, `src/db.ts`, `src/matchResult.ts`, `src/modCalls.ts`
- Test: `tests/logParse.test.ts`, `tests/dumpParse.test.ts`, `tests/matchResult.test.ts`, `tests/modCalls.test.ts`, `tests/modCallParse.test.ts`

**Interfaces:**
- Consumes: `parseLogDatagram`, `kv`, `intOf`, `steamId64Of`, `MOD_CALL_REASONS` (`logParse.ts`); `parseDump`, `Dump` (`dumpParse.ts`); `completeMatch` (`matchResult.ts`); `REASON_LABELS`, `CATEGORY`, `handleModCall` (`modCalls.ts`); `ensureColumn` (`db.ts`).
- Produces:
  - `logParse.ts`: `export type TechEventKind = 'start' | 'end' | 'over' | 'flag'`; `LogEvent` member `{ kind: 'tech'; token: string; event: TechEventKind; id: number; team: 'a' | 'b'; cause: 'call' | 'disconnect'; by: string | null; used: number; budget: number; tactical: number | null; text: string }`; `sub_request` gains `emergency?: boolean`; `MOD_CALL_REASONS` gains `'tech'`.
  - `dumpParse.ts`: `export type ForfeitWhy = 'gg' | 'disconnect' | 'staff'`; `Dump.forfeitWhy?: ForfeitWhy | null` (null without a forfeit; `'gg'` for a forfeit with no `forfeit_why=`).
  - `db.ts`: `matches.forfeit_why`, `event_games.forfeit_why` (`TEXT CHECK (... IN ('gg','disconnect','staff'))`).
  - `matchResult.ts`: `completeMatch` writes `forfeit_why`.
  - `modCalls.ts`: `REASON_LABELS.tech = 'Tournament: technical pause flagged'`, `CATEGORY.tech = null`, target `none`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/logParse.test.ts` after the plan T3c SUB/ADMINPAUSE test:

```ts
  it('parses a TECH line with its free text last, and SUB emergency=1 (plan T5)', () => {
    const BY = '76561199000000801';
    const P = '76561199048276493';
    const Q = '76561199122132251';
    expect(parseLogDatagram(framed(`PUG ${TOKEN} TECH event=start id=1791000000 team=b cause=call by=${BY} used=0 budget=300 text=my router restarted, sorry`)))
      .toEqual({ kind: 'tech', token: TOKEN, event: 'start', id: 1791000000, team: 'b', cause: 'call', by: BY, used: 0, budget: 300, tactical: null, text: 'my router restarted, sorry' });
    expect(parseLogDatagram(framed(`PUG ${TOKEN} TECH event=over id=1791000000 team=b cause=call by=${BY} used=300 budget=300 tactical=-1 text=`)))
      .toMatchObject({ event: 'over', tactical: -1, text: '' });
    expect(parseLogDatagram(framed(`PUG ${TOKEN} TECH event=start id=1791000100 team=a cause=disconnect by=${P} used=40 budget=600 text=disconnected`)))
      .toMatchObject({ event: 'start', cause: 'disconnect', by: P, used: 40, budget: 600 });
    expect(parseLogDatagram(framed(`PUG ${TOKEN} TECH event=end id=1791000100 team=a cause=disconnect by=none used=70 budget=600 text=`)))
      .toMatchObject({ event: 'end', by: null });
    // A key this parser cannot read costs the line: it writes the match log.
    expect(parseLogDatagram(framed(`PUG ${TOKEN} TECH event=pause id=1 team=a cause=call by=none used=0 budget=300 text=x`))).toBeNull();
    expect(parseLogDatagram(framed(`PUG ${TOKEN} TECH event=start id=0 team=a cause=call by=none used=0 budget=300 text=x`))).toBeNull();
    expect(parseLogDatagram(framed(`PUG ${TOKEN} TECH event=start id=5 team=c cause=call by=none used=0 budget=300 text=x`))).toBeNull();
    expect(parseLogDatagram(framed(`PUG ${TOKEN} TECH event=start id=5 team=a cause=lag by=none used=0 budget=300 text=x`))).toBeNull();
    expect(parseLogDatagram(framed(`PUG ${TOKEN} TECH event=start id=5 team=a cause=call by=bob used=0 budget=300 text=x`))).toBeNull();
    // text= keys inside the free text are text, not keys.
    expect(parseLogDatagram(framed(`PUG ${TOKEN} TECH event=flag id=5 team=a cause=call by=${BY} used=10 budget=300 text=team=b used=999`)))
      .toMatchObject({ team: 'a', used: 10, text: 'team=b used=999' });
    expect(parseLogDatagram(framed(`PUG ${TOKEN} SUB by=${BY} out=${P} in=${Q} map=2 emergency=1`)))
      .toEqual({ kind: 'sub_request', token: TOKEN, by: BY, out: P, in: Q, map: 2, emergency: true });
  });
```

Append to `tests/modCallParse.test.ts` inside `describe('PUGCALL parsing', ...)` (its `parse` helper frames the line):

```ts
  it('takes reason=tech, a tournament box\'s !flag (plan T5)', () => {
    const ev = parse(`PUGCALL steamid=76561199000000801 target=none tteam=3 reason=tech match=42 ord=1 half=2 tms=5000 via=game map=l4d_vs_hospital02_subway text=Team A technical pause: router | looks fake`);
    expect(ev).toMatchObject({ kind: 'call', reason: 'tech', target: 'none', text: 'Team A technical pause: router | looks fake' });
  });
```


Append to `tests/modCalls.test.ts` inside `describe('handleModCall', ...)`:

```ts
  it('never files for a flagged technical pause and keeps no target (plan T5)', () => {
    const row = call({ reason: 'tech', target: 'none', text: 'Team A technical pause: router | looks fake' });
    expect(row).toMatchObject({ reason: 'tech', target_kind: 'none', target_steamid: null, ticket_id: null, pinged: 1 });
    expect(REASON_LABELS.tech).toBe('Tournament: technical pause flagged');
  });
```

(import `REASON_LABELS`).

Append to `tests/dumpParse.test.ts` inside `describe('parseDump', ...)`:

```ts
  it('reads why a forfeit that is not a !gg happened, and calls a bare forfeit a !gg (plan T5)', () => {
    expect(parseDump(SAMPLE)!.forfeitWhy).toBeNull();
    const gg = SAMPLE.replace('END winner=a a=645 b=610', 'END winner=a a=645 b=610 forfeit=b');
    expect(parseDump(gg)!.forfeitWhy).toBe('gg');
    // The disconnect pool ran out for team a while it led: the plugin names b the winner.
    const dc = SAMPLE.replace('END winner=a a=645 b=610', 'END winner=b a=645 b=610 forfeit=a forfeit_why=disconnect');
    expect(parseDump(dc)).toMatchObject({ winner: 'b', forfeit: 'a', forfeitWhy: 'disconnect' });
    const staff = SAMPLE.replace('END winner=a a=645 b=610', 'END winner=a a=645 b=610 forfeit=b forfeit_why=staff');
    expect(parseDump(staff)!.forfeitWhy).toBe('staff');
    const odd = SAMPLE.replace('END winner=a a=645 b=610', 'END winner=a a=645 b=610 forfeit=b forfeit_why=lag');
    expect(parseDump(odd)!.forfeitWhy).toBe('gg');
  });
```

Append to `tests/matchResult.test.ts` inside `describe('completeMatch', ...)`:

```ts
  it('stores why a game was forfeited, gg for a bare forfeit and null without one (plan T5)', () => {
    expect(completeMatch(db, matchId, { ...dumpFor(matchId), forfeit: 'a', forfeitWhy: 'disconnect' })).toBe(true);
    expect(db.prepare('SELECT forfeit_team, forfeit_why FROM matches WHERE id = ?').get(matchId)).toEqual({ forfeit_team: 'a', forfeit_why: 'disconnect' });
    const gg = seedLiveMatch(db);
    expect(completeMatch(db, gg, { ...dumpFor(gg), forfeit: 'a' })).toBe(true);
    expect(db.prepare('SELECT forfeit_why FROM matches WHERE id = ?').get(gg)).toEqual({ forfeit_why: 'gg' });
    const plain = seedLiveMatch(db);
    expect(completeMatch(db, plain, dumpFor(plain))).toBe(true);
    expect(db.prepare('SELECT forfeit_why FROM matches WHERE id = ?').get(plain)).toEqual({ forfeit_why: null });
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/logParse.test.ts tests/modCallParse.test.ts tests/modCalls.test.ts tests/dumpParse.test.ts tests/matchResult.test.ts`
Expected: FAIL (no `TECH` case, no `emergency`, `tech` not a reason, no `forfeitWhy`, no `forfeit_why` column).

- [ ] **Step 3: logParse.ts**

`MOD_CALL_REASONS` becomes `['cheating', 'toxicity', 'griefing', 'afk', 'english', 'broke', 'other', 'admin', 'tech'] as const` with its comment adding "`tech` is a tournament box's `!flag` on the other team's technical pause (plan T5)." After `AdminPauseCause` add `export type TechEventKind = 'start' | 'end' | 'over' | 'flag';`. In `LogEvent`, the `sub_request` member gains `; emergency?: boolean` and after the `admin_pause` member add:

```ts
  /** A technical pause on a tournament box (pug-match 0.3.26, plan T5): its
   *  start, end, overrun into tactical pauses, or the other team's flag. team
   *  is the box's pug team; the series engine orients it. used and budget are
   *  technical seconds, or the team's reconnect seconds for cause disconnect.
   *  tactical is set on `over`: tactical pauses left, -1 when none and the
   *  game unpaused. text is the reason (start) or the flag's note. */
  | { kind: 'tech'; token: string; event: TechEventKind; id: number; team: 'a' | 'b'; cause: 'call' | 'disconnect'; by: string | null; used: number; budget: number; tactical: number | null; text: string }
```

In the `SUB` case, the return becomes:

```ts
      return { kind: 'sub_request', token, by, out, in: inId, map, ...(rest.emergency === '1' ? { emergency: true } : {}) };
```

After the `ADMINPAUSE` case add:

```ts
    case 'TECH': {
      // text= runs to the end of the line (the reason or a note), so the keys
      // are read from what comes before it, as PUGCALL's are.
      const at = line.indexOf(' text=');
      const head = kv((at < 0 ? line : line.slice(0, at)).split(/\s+/).slice(3));
      const text = at < 0 ? '' : line.slice(at + ' text='.length).trim().slice(0, 300);
      const event = head.event;
      if (event !== 'start' && event !== 'end' && event !== 'over' && event !== 'flag') return null;
      if (head.team !== 'a' && head.team !== 'b') return null;
      if (head.cause !== 'call' && head.cause !== 'disconnect') return null;
      const id = intOf(head.id), used = intOf(head.used), budget = intOf(head.budget);
      if (id === null || id <= 0 || used === null || used < 0 || budget === null || budget < 0) return null;
      const by = head.by === undefined || head.by === 'none' ? null : steamId64Of(head.by);
      if (head.by !== undefined && head.by !== 'none' && !by) return null;
      const tactical = head.tactical === undefined ? null : intOf(head.tactical);
      return {
        kind: 'tech', token, event, id, team: head.team, cause: head.cause, by, used, budget,
        tactical: tactical !== null && tactical >= -1 ? tactical : null, text,
      };
    }
```

- [ ] **Step 4: dumpParse.ts, db.ts, matchResult.ts, modCalls.ts**

In `dumpParse.ts`, before `Dump` add `/** Why a game was forfeited (plan T5): a !gg, the reconnect pool running out, or a staff ruling. */ export type ForfeitWhy = 'gg' | 'disconnect' | 'staff';`; in `Dump`, after `forfeit?`, add:

```ts
  /** Plan T5 (pug-match 0.3.26): why, null without a forfeit. A forfeit with
   *  no forfeit_why= (every !gg, and any older plugin) is a !gg. */
  forfeitWhy?: ForfeitWhy | null;
```

In the `END` branch, after `const forfeit = ...`:

```ts
      const forfeitWhy: ForfeitWhy | null = forfeit === null ? null
        : rest.forfeit_why === 'disconnect' || rest.forfeit_why === 'staff' ? rest.forfeit_why : 'gg';
      end = { winner: rest.winner, totalA: a, totalB: b, forfeit, forfeitWhy };
```

(widen `end`'s type with `forfeitWhy: ForfeitWhy | null`) and the return adds `forfeitWhy: end.forfeitWhy`.

In `db.ts`, after the T4 `ensureColumn` lines:

```ts
  // Tournaments plan T5: why a game was forfeited (src/dumpParse.ts ForfeitWhy),
  // on the game's matches row and on its event_games row.
  ensureColumn(db, 'matches', 'forfeit_why', "TEXT CHECK (forfeit_why IN ('gg','disconnect','staff'))");
  ensureColumn(db, 'event_games', 'forfeit_why', "TEXT CHECK (forfeit_why IN ('gg','disconnect','staff'))");
```

In `matchResult.ts` `completeMatch`, the first `UPDATE` becomes:

```ts
    db.prepare(
      "UPDATE matches SET state = 'completed', team_a_score = ?, team_b_score = ?, winner = ?, forfeit_team = ?, forfeit_why = ?, ended_at = datetime('now') WHERE id = ?",
    ).run(d.totalA, d.totalB, d.winner, d.forfeit ?? null, d.forfeit ? d.forfeitWhy ?? 'gg' : null, matchId);
```

(If `canonicaliseDump` rebuilds the dump field by field, carry `forfeitWhy` through it.)

In `modCalls.ts`, `REASON_LABELS` gains `tech: 'Tournament: technical pause flagged',`; the `CATEGORY` comment says "`broke` is about the server and `admin` and `tech` about the match" and gains `tech: null`; the `targetKind` condition becomes `ev.reason === 'broke' || ev.reason === 'admin' || ev.reason === 'tech'`.

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run tests/logParse.test.ts tests/modCallParse.test.ts tests/modCalls.test.ts tests/modCallPoster.test.ts tests/dumpParse.test.ts tests/matchResult.test.ts tests/db.test.ts && npm run typecheck`
Expected: PASS (the web's reason labels come from the server, so its typecheck is unaffected; `src/discord/modCallCard.ts` titles the card from `REASON_LABELS`).

- [ ] **Step 6: Commit**

```bash
git add src/logParse.ts src/dumpParse.ts src/db.ts src/matchResult.ts src/modCalls.ts tests/logParse.test.ts tests/modCallParse.test.ts tests/modCalls.test.ts tests/dumpParse.test.ts tests/matchResult.test.ts
git commit -m "Tournaments T5: the site reads TECH lines, emergency subs and the flag reason, and keeps why a game was forfeited"
```

---
### Task 7: The pause ledger in the room: `noteTech`, `techPausesOf`, `techPenalty`

**Files:**
- Modify: `src/events/validate.ts`, `src/events/room.ts`
- Test: `tests/matchRules.test.ts` (new), `tests/eventLogGuard.test.ts`, `tests/room.test.ts`

**Interfaces:**
- Consumes: `liveMatch`, `gamesOf`, `SUB_PHASES`, `GameRow`, `subPlayer`, `recordGame`, `iso` (`room.ts`); `E.logEvent`; `P.getMatch`, `P.RESOLVED`; `V.normalizeReason`, `V.fail`, `V.ok`, `EVENT_ERRORS`; `ForfeitWhy` (`dumpParse.ts`).
- Produces:
  - `validate.ts` `EVENT_ERRORS`: `pause_not_found`, `already_penalized`, `bad_penalty`, `emergency_off`.
  - `room.ts`: `export type TechCause = 'call' | 'disconnect'`; `export type TechPenaltyKind = 'warning' | 'forfeit'`; `export interface TechPause { id: number; gameMatchId: number; ordinal: number; techId: number; side: Side; cause: TechCause; by: string | null; reason: string; startedAt: string; endedAt: string | null; used: number; budget: number; overrun: { at: string; tactical: number | null } | null; flagged: { by: string | null; note: string; at: string } | null; penalty: { kind: TechPenaltyKind; by: string | null; note: string | null; at: string } | null }`; `techPausesOf(db, m: P.MatchRow): TechPause[]` (a read); `noteTech(db, o: { matchId; gameMatchId; event: TechEventKind; techId: number; side: Side; cause: TechCause; by: string | null; used: number; budget: number; tactical: number | null; text: string; now?: Date }): V.Checked<{ m: P.MatchRow; pause: TechPause }>` (`tech_pause` | `tech_pause_ended` | `tech_overrun` | `tech_flagged`); `techPenalty(db, o: { matchId: number; pauseId: unknown; by: string; penalty: unknown; note: unknown; now?: Date }): V.Checked<{ m: P.MatchRow; pause: TechPause }>` (`tech_penalty`); `GameRow.forfeit_why: ForfeitWhy | null`; `recordGame` takes `forfeitWhy?: ForfeitWhy | null`; `subPlayer` takes `emergency?: boolean`.

- [ ] **Step 1: Write the failing tests**

Create `tests/matchRules.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import * as P from '../src/events/play.js';
import * as R from '../src/events/room.js';
import { EVENT_ERRORS } from '../src/events/validate.js';
import { ADMIN } from './eventFixture.js';
import { A, B as BATS } from './entryFixture.js';
import { seriesFixture, type SeriesFixture } from './seriesFixture.js';

/** Tournaments plan T5: the match rules on the site. In the fixture's game
 *  1, booking_side_a is 'b': pug team a is Bats (entry b), pug team b is
 *  Rats (entry a). */
let f: SeriesFixture;
afterEach(() => f?.close());
const T1 = 1_791_000_000;

const playing = async () => {
  f = await seriesFixture();
  await f.tick();
  f.box.humans = [...A.slice(0, 4), ...BATS.slice(0, 4), A[4]!];
  f.goLive(f.gameOf(1).match_id!);
  return f.liveGameToken();
};
const start = (over: Partial<Parameters<typeof R.noteTech>[1]> = {}) => R.noteTech(f.db, {
  matchId: f.matchId, gameMatchId: f.gameOf(1).match_id!, event: 'start', techId: T1, side: 'a', cause: 'call', by: A[0]!,
  used: 0, budget: 300, tactical: null, text: '  my   router restarted  ', now: new Date(f.t.t), ...over,
});

describe('the pause ledger (room.ts)', () => {
  it('records a technical pause, its end, overrun and flag once each, in one log row apiece', async () => {
    await playing();
    const r = start();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.pause).toMatchObject({ techId: T1, side: 'a', cause: 'call', by: A[0], reason: 'my router restarted', used: 0, budget: 300, endedAt: null, overrun: null, flagged: null, penalty: null, ordinal: 1 });
    expect(start()).toEqual({ ok: false, error: 'changed' });
    const base = { matchId: f.matchId, gameMatchId: f.gameOf(1).match_id!, techId: T1, side: 'a' as const, cause: 'call' as const, budget: 300, now: new Date(f.t.t) };
    expect(R.noteTech(f.db, { ...base, event: 'flag', by: BATS[0]!, used: 40, tactical: null, text: 'looks fake' }).ok).toBe(true);
    expect(R.noteTech(f.db, { ...base, event: 'flag', by: BATS[1]!, used: 41, tactical: null, text: 'again' })).toEqual({ ok: false, error: 'changed' });
    expect(R.noteTech(f.db, { ...base, event: 'over', by: A[0]!, used: 300, tactical: 1, text: '' }).ok).toBe(true);
    expect(R.noteTech(f.db, { ...base, event: 'end', by: A[0]!, used: 300, tactical: null, text: '' }).ok).toBe(true);
    expect(R.noteTech(f.db, { ...base, event: 'end', by: A[0]!, used: 300, tactical: null, text: '' })).toEqual({ ok: false, error: 'changed' });
    expect(R.noteTech(f.db, { ...base, techId: T1 + 5, event: 'end', by: null, used: 0, tactical: null, text: '' })).toEqual({ ok: false, error: 'pause_not_found' });
    expect(R.noteTech(f.db, { ...base, gameMatchId: 999_999, event: 'start', by: null, used: 0, tactical: null, text: 'x' })).toEqual({ ok: false, error: 'game_not_found' });
    const [p] = R.techPausesOf(f.db, f.match());
    expect(p).toMatchObject({ used: 300, overrun: { tactical: 1 }, flagged: { by: BATS[0], note: 'looks fake' } });
    expect(p!.endedAt).not.toBeNull();
    const actions = (f.db.prepare("SELECT action, actor FROM event_log WHERE action LIKE 'tech_%' ORDER BY id").all() as { action: string; actor: string | null }[]);
    expect(actions).toEqual([
      { action: 'tech_pause', actor: A[0] }, { action: 'tech_flagged', actor: BATS[0] }, { action: 'tech_overrun', actor: null }, { action: 'tech_pause_ended', actor: null },
    ]);
  });

  it('takes one penalty per pause, refuses a bad one or a resolved match, and keeps the note', async () => {
    await playing();
    const r = start();
    if (!r.ok) throw new Error(r.error);
    const id = r.value.pause.id;
    const now = new Date(f.t.t);
    expect(R.techPenalty(f.db, { matchId: f.matchId, pauseId: id, by: ADMIN, penalty: 'ban', note: null, now })).toEqual({ ok: false, error: 'bad_penalty' });
    expect(R.techPenalty(f.db, { matchId: f.matchId, pauseId: 123_456, by: ADMIN, penalty: 'warning', note: null, now })).toEqual({ ok: false, error: 'pause_not_found' });
    const w = R.techPenalty(f.db, { matchId: f.matchId, pauseId: id, by: ADMIN, penalty: 'warning', note: 'first and last', now });
    expect(w.ok && w.value.pause.penalty).toMatchObject({ kind: 'warning', by: ADMIN, note: 'first and last' });
    expect(R.techPenalty(f.db, { matchId: f.matchId, pauseId: id, by: ADMIN, penalty: 'forfeit', note: null, now })).toEqual({ ok: false, error: 'already_penalized' });
    const second = start({ techId: T1 + 60, text: 'mouse died' });
    if (!second.ok) throw new Error(second.error);
    f.db.prepare("UPDATE event_matches SET status = 'done' WHERE id = ?").run(f.matchId);
    expect(R.techPenalty(f.db, { matchId: f.matchId, pauseId: second.value.pause.id, by: ADMIN, penalty: 'warning', note: null, now })).toEqual({ ok: false, error: 'wrong_status' });
    expect(R.techPausesOf(f.db, f.match())).toHaveLength(2);
    expect(EVENT_ERRORS.already_penalized.status).toBe(409);
  });

  it('records why a game was forfeited and an emergency sub', async () => {
    await playing();
    const g1 = f.gameOf(1);
    const s = R.subPlayer(f.db, { matchId: f.matchId, by: A[0]!, outId: A[3]!, inId: A[4]!, limit: 2, gameId: g1.id, emergency: true, now: new Date(f.t.t) });
    expect(s.ok).toBe(true);
    expect(JSON.parse((f.db.prepare("SELECT detail FROM event_log WHERE action = 'player_subbed'").get() as { detail: string }).detail)).toMatchObject({ emergency: true, used: 1 });
    const rec = R.recordGame(f.db, { matchId: f.matchId, gameId: g1.id, scoreA: 500, scoreB: 100, forfeit: 'a', forfeitWhy: 'disconnect', now: new Date(f.t.t) });
    expect(rec.ok).toBe(true);
    expect(f.gameOf(1)).toMatchObject({ forfeit_side: 'a', forfeit_why: 'disconnect', winner: f.entryB });
  });
});
```

(`P` is imported for the later tasks' tests in this file; drop it if unused here and the linter complains.)

In `tests/eventLogGuard.test.ts`, add `'techPausesOf'` to `ROOM_READS` and to `ROOM_MUTATIONS`:

```ts
      noteTech: {
        action: 'tech_pause', actor: A[0]!, setup: linked,
        run: (f) => R.noteTech(f.db, { matchId: f.matchId, gameMatchId: game1(f).match_id!, event: 'start', techId: 1_791_000_000, side: 'a', cause: 'call', by: A[0]!, used: 0, budget: 300, tactical: null, text: 'router', now: at(20) }),
      },
      techPenalty: {
        action: 'tech_penalty', actor: ADMIN,
        setup: (f) => { linked(f); must(R.noteTech(f.db, { matchId: f.matchId, gameMatchId: game1(f).match_id!, event: 'start', techId: 1_791_000_000, side: 'a', cause: 'call', by: A[0]!, used: 0, budget: 300, tactical: null, text: 'router', now: at(20) })); },
        run: (f) => R.techPenalty(f.db, { matchId: f.matchId, pauseId: R.techPausesOf(f.db, P.getMatch(f.db, f.matchId)!)[0]!.id, by: ADMIN, penalty: 'warning', note: null, now: at(21) }),
      },
```

(`P` is `../src/events/play.js`, imported there already for the play guard.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/matchRules.test.ts tests/eventLogGuard.test.ts`
Expected: FAIL (`noteTech`, `techPausesOf`, `techPenalty` undefined; `forfeit_why` and `emergency` unknown).

- [ ] **Step 3: validate.ts**

Add to `EVENT_ERRORS` after `bad_side`:

```ts
  pause_not_found: { status: 404, text: 'No such technical pause in this match.' },
  already_penalized: { status: 409, text: 'Staff already ruled on this technical pause.' },
  bad_penalty: { status: 400, text: 'A penalty is a warning or a forfeit of the game.' },
  emergency_off: { status: 409, text: 'Emergency subs are off in this event: subs are made between chapters.' },
```

- [ ] **Step 4: room.ts**

Import `type TechEventKind` from `../logParse.js` (beside `AdminPauseCause`) and `type ForfeitWhy` from `../dumpParse.js`. `GameRow`'s plan T3b fields gain `forfeit_why: ForfeitWhy | null;` (with the comment "plan T5: why it was forfeited, null when it was played out").

`recordGame`'s options gain `forfeitWhy?: ForfeitWhy | null;`, its `UPDATE` becomes:

```ts
    const why = o.forfeit === null ? null : o.forfeitWhy ?? 'gg';
    db.prepare('UPDATE event_games SET score_a = ?, score_b = ?, forfeit_side = ?, forfeit_why = ?, winner = ?, ended_at = ? WHERE id = ?')
      .run(o.scoreA, o.scoreB, o.forfeit, why, winner === null ? null : entryOn(m, winner), at, g.id);
    E.logEvent(db, ev.id, null, 'game_recorded', at, {
      matchId: m.id, gameId: g.id, ordinal: g.ordinal, scoreA: o.scoreA, scoreB: o.scoreB, forfeit: o.forfeit, why, winner,
    });
```

`subPlayer`'s options gain `emergency?: boolean;` and its log row becomes:

```ts
    E.logEvent(db, ev.id, o.by, 'player_subbed', at, {
      matchId: m.id, side, out: o.outId, in: o.inId, gameId: o.gameId, used: used + 1, limit: o.limit, ...(o.emergency ? { emergency: true } : {}),
    });
```

At the end of the file add:

```ts
// ---------- the technical pause ledger and staff penalties (plan T5) ----------

export type TechCause = 'call' | 'disconnect';
export type TechPenaltyKind = 'warning' | 'forfeit';
/** One technical pause of a match, built from its event_log rows (the
 *  match log is the ledger: Rulings 5, 11, 12 and 19). id is the start
 *  row's; techId is the box's id= (the unix second it began), unique within
 *  a game. ordinal is the event game's. */
export interface TechPause {
  id: number; gameMatchId: number; ordinal: number; techId: number; side: Side; cause: TechCause; by: string | null; reason: string;
  startedAt: string; endedAt: string | null; used: number; budget: number;
  overrun: { at: string; tactical: number | null } | null;
  flagged: { by: string | null; note: string; at: string } | null;
  penalty: { kind: TechPenaltyKind; by: string | null; note: string | null; at: string } | null;
}

const TECH_ACTION: Record<TechEventKind, string> = { start: 'tech_pause', end: 'tech_pause_ended', over: 'tech_overrun', flag: 'tech_flagged' };
/** A reason or a note as stored: one line, at most this long. */
export const TECH_TEXT_MAX = 160;

/** A box phase, or a hold taken from one (as setAdminPause). */
const inBoxPhase = (m: P.MatchRow): boolean => SUB_PHASES.has(m.status) || (m.status === 'admin_hold' && m.hold_from !== null && SUB_PHASES.has(m.hold_from));

export function techPausesOf(db: DB, m: P.MatchRow): TechPause[] {
  const rows = db.prepare(
    `SELECT id, action, actor, at, detail FROM event_log
      WHERE event_id = ? AND action IN ('tech_pause', 'tech_pause_ended', 'tech_overrun', 'tech_flagged', 'tech_penalty')
        AND json_extract(detail, '$.matchId') = ? ORDER BY id`,
  ).all(m.event_id, m.id) as { id: number; action: string; actor: string | null; at: string; detail: string }[];
  const games = gamesOf(db, m.id);
  const out: TechPause[] = [];
  const byKey = new Map<string, TechPause>();
  for (const r of rows) {
    const d = JSON.parse(r.detail) as Record<string, unknown>;
    if (r.action === 'tech_pause') {
      const p: TechPause = {
        id: r.id, gameMatchId: d.gameMatchId as number, ordinal: games.find((g) => g.match_id === d.gameMatchId)?.ordinal ?? 0,
        techId: d.techId as number, side: d.side as Side, cause: d.cause as TechCause, by: (d.by as string | null) ?? null,
        reason: (d.reason as string | undefined) ?? '', startedAt: r.at, endedAt: null, used: d.used as number, budget: d.budget as number,
        overrun: null, flagged: null, penalty: null,
      };
      out.push(p);
      byKey.set(`${p.gameMatchId}:${p.techId}`, p);
      continue;
    }
    if (r.action === 'tech_penalty') {
      const p = out.find((x) => x.id === d.pauseId);
      if (p) p.penalty = { kind: d.penalty as TechPenaltyKind, by: r.actor, note: (d.note as string | null) ?? null, at: r.at };
      continue;
    }
    const p = byKey.get(`${d.gameMatchId as number}:${d.techId as number}`);
    if (!p) continue;
    if (r.action === 'tech_pause_ended') { p.endedAt = r.at; p.used = d.used as number; }
    else if (r.action === 'tech_overrun') { p.overrun = { at: r.at, tactical: (d.tactical as number | null) ?? null }; p.used = d.used as number; }
    else p.flagged = { by: r.actor, note: (d.note as string | undefined) ?? '', at: r.at };
  }
  return out;
}

/** The box's TECH line, oriented to the room's side by the engine (Ruling
 *  17). Once per event of each pause: a repeat is 'changed', a line about
 *  a pause the site never saw start is 'pause_not_found'. The match must be
 *  in a box phase (or held from one) and the game one of its linked games. */
export function noteTech(db: DB, o: {
  matchId: number; gameMatchId: number; event: TechEventKind; techId: number; side: Side; cause: TechCause;
  by: string | null; used: number; budget: number; tactical: number | null; text: string; now?: Date;
}): V.Checked<{ m: P.MatchRow; pause: TechPause }> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<{ m: P.MatchRow; pause: TechPause }> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (!inBoxPhase(m)) return V.fail('not_live_phase');
    if (!gamesOf(db, m.id).some((g) => g.match_id === o.gameMatchId)) return V.fail('game_not_found');
    const known = techPausesOf(db, m).find((p) => p.gameMatchId === o.gameMatchId && p.techId === o.techId);
    if (o.event === 'start' && known) return V.fail('changed');
    if (o.event !== 'start' && !known) return V.fail('pause_not_found');
    if (known && ((o.event === 'end' && known.endedAt !== null) || (o.event === 'over' && known.overrun !== null) || (o.event === 'flag' && known.flagged !== null))) {
      return V.fail('changed');
    }
    const text = o.text.replace(/\s+/g, ' ').trim().slice(0, TECH_TEXT_MAX);
    const base = { matchId: m.id, gameMatchId: o.gameMatchId, techId: o.techId, side: o.side };
    const detail = o.event === 'start' ? { ...base, cause: o.cause, by: o.by, reason: text, used: o.used, budget: o.budget }
      : o.event === 'flag' ? { ...base, note: text }
        : o.event === 'over' ? { ...base, used: o.used, tactical: o.tactical }
          : { ...base, used: o.used };
    // The actor is the player who called it or flagged it; a disconnect, an end and an overrun are nobody's.
    const actor = o.event === 'flag' || (o.event === 'start' && o.cause === 'call') ? o.by : null;
    E.logEvent(db, ev.id, actor, TECH_ACTION[o.event], at, detail);
    const pause = techPausesOf(db, m).find((p) => p.gameMatchId === o.gameMatchId && p.techId === o.techId)!;
    return V.ok({ m: P.getMatch(db, m.id)!, pause });
  })();
}

/** Staff rule on a technical pause (Ruling 12): one penalty per pause, before
 *  the match is resolved. A forfeit is recorded here once the box took it
 *  (the series engine sends sm_pug_forfeit first). */
export function techPenalty(db: DB, o: { matchId: number; pauseId: unknown; by: string; penalty: unknown; note: unknown; now?: Date }): V.Checked<{ m: P.MatchRow; pause: TechPause }> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<{ m: P.MatchRow; pause: TechPause }> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (P.RESOLVED.has(m.status)) return V.fail('wrong_status');
    if (o.penalty !== 'warning' && o.penalty !== 'forfeit') return V.fail('bad_penalty');
    const note = V.normalizeReason(o.note);
    if (!note.ok) return note;
    const pause = Number.isInteger(o.pauseId) ? techPausesOf(db, m).find((p) => p.id === o.pauseId) : undefined;
    if (!pause) return V.fail('pause_not_found');
    if (pause.penalty !== null) return V.fail('already_penalized');
    E.logEvent(db, ev.id, o.by, 'tech_penalty', at, {
      matchId: m.id, pauseId: pause.id, gameMatchId: pause.gameMatchId, side: pause.side, penalty: o.penalty, note: note.value,
    });
    return V.ok({ m: P.getMatch(db, m.id)!, pause: techPausesOf(db, m).find((p) => p.id === pause.id)! });
  })();
}
```

(`Side` is already imported from `./veto.js`.)

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run tests/matchRules.test.ts tests/eventLogGuard.test.ts tests/room.test.ts tests/series.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/events/validate.ts src/events/room.ts tests/matchRules.test.ts tests/eventLogGuard.test.ts
git commit -m "Tournaments T5: the match log keeps every technical pause with its end, overrun, flag and staff penalty, a forfeited game keeps why, and an emergency sub is marked"
```

---
### Task 8: The series engine: technical pause lines, emergency subs, forfeit wording and staff penalties

**Files:**
- Modify: `src/events/series.ts`, `src/events/messages.ts`, `src/server.ts`, `tests/seriesFixture.ts`
- Test: `tests/matchRules.test.ts`, `tests/series.test.ts`

**Interfaces:**
- Consumes: `matchOfToken`, `liveGameOf`, `runningBooking`, `stageRules`, `alert`, `push`, `name`, `playerName`, `gameLabel`, `subRequested`, `gameEnded`, `scoreline` (`series.ts`); `R.noteTech`, `R.techPausesOf`, `R.techPenalty`, `R.subPlayer`, `R.recordGame`, `R.gamesOf`; `tellStaffAction`, `StaffAction`, `STAFF_TEXT` (`notices.ts`, `messages.ts`); `other` (`veto.ts`); `LogEvent` (`logParse.ts`).
- Produces:
  - `series.ts`: `export type TechLine = Extract<LogEvent, { kind: 'tech' }>`; `export function forfeitTook(reply: string | null | undefined, team: 'a' | 'b'): boolean`; `SeriesEngine.techLine(token: string, ev: TechLine): void`; `SeriesEngine.subRequested(token, by, outId, inId, emergency = false): Promise<void>`; `SeriesEngine.techPenalty(matchId: number, by: string, pauseId: unknown, penalty: unknown, note: unknown): Promise<V.Checked<P.MatchRow>>`; `gameEnded` passes `forfeitWhy`; `scoreline` says why.
  - `messages.ts`: `StaffAction` gains `'tech_warning' | 'tech_forfeit'`.
  - `server.ts`: `tech` lines go to `seriesRef.techLine`; `sub_request` passes `ev.emergency === true`.
  - `seriesFixture.ts`: `line()` dispatches `tech` and the emergency flag; `box.forfeitOk` (default true) and the `sm_pug_forfeit` answer.

- [ ] **Step 1: Write the failing tests**

In `tests/seriesFixture.ts`: add `forfeitOk: boolean` to the `box` type and `forfeitOk: true` to its initial value; in the rcon fake, after the `sm_pug_adminpause` answer:

```ts
      // pug-match 0.3.26's answer (plugin/pug-tourney.inc Cmd_PugForfeit).
      const ff = /^sm_pug_forfeit \S+ (a|b)$/.exec(c);
      if (ff) return box.forfeitOk ? `PUGOK forfeit team=${ff[1]}` : 'PUGERR no live match';
```

and in `line()`, the first branch becomes `if (ev.kind === 'sub_request') await series!.subRequested(ev.token, ev.by, ev.out, ev.in, ev.emergency === true);` with a new branch after `admin_pause`: `else if (ev.kind === 'tech') series!.techLine(ev.token, ev);`.

Append to `tests/matchRules.test.ts` (add `import { EVENT_ERRORS } ...` is already there; add `forfeitTook` to an import from `../src/events/series.js`):

```ts
const setStageRules = (over: Record<string, unknown>) => {
  const s = f.db.prepare('SELECT s.id, s.rules_json, r.rules_json AS base FROM event_stages s JOIN rulesets r ON r.id = s.ruleset_id WHERE s.id = ?')
    .get(f.match().stage_id) as { id: number; rules_json: string | null; base: string };
  f.db.prepare('UPDATE event_stages SET rules_json = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(s.rules_json ?? s.base), ...over }), s.id);
};
const alertText = () => f.alerts.map((a) => ('text' in a ? String(a.text) : ''));

describe('technical pauses from the box (series.ts)', () => {
  it('orients the pug team to the room side, records each line, tells staff and pushes the room', async () => {
    const token = await playing();
    f.alerts.length = 0;
    f.pushes.length = 0;
    // Pug team b is Rats (entry a) on this game.
    await f.line(`PUG ${token} TECH event=start id=${T1} team=b cause=call by=${A[0]} used=0 budget=300 text=my router restarted`);
    expect(R.techPausesOf(f.db, f.match())[0]).toMatchObject({ side: 'a', cause: 'call', by: A[0], reason: 'my router restarted' });
    expect(alertText().some((t) => t.includes('Rats called a technical pause in game 1: "my router restarted" (5:00 of technical time left).'))).toBe(true);
    expect(f.pushes).toContain(f.matchId);
    await f.line(`PUG ${token} TECH event=flag id=${T1} team=b cause=call by=${BATS[0]} used=40 budget=300 text=looks fake`);
    await f.line(`PUG ${token} TECH event=over id=${T1} team=b cause=call by=${A[0]} used=300 budget=300 tactical=1 text=`);
    expect(alertText().some((t) => t.includes('Rats ran out of technical time; the pause now uses a tactical pause (1 left).'))).toBe(true);
    await f.line(`PUG ${token} TECH event=end id=${T1} team=b cause=call by=${A[0]} used=300 budget=300 text=`);
    expect(R.techPausesOf(f.db, f.match())[0]).toMatchObject({ flagged: { by: BATS[0], note: 'looks fake' }, overrun: { tactical: 1 }, used: 300 });
    expect(R.techPausesOf(f.db, f.match())[0]!.endedAt).not.toBeNull();
    // Pug team a is Bats (entry b): a disconnect pause on their reconnect time.
    await f.line(`PUG ${token} TECH event=start id=${T1 + 90} team=a cause=disconnect by=${BATS[2]} used=15 budget=600 text=disconnected`);
    expect(R.techPausesOf(f.db, f.match())[1]).toMatchObject({ side: 'b', cause: 'disconnect', by: BATS[2] });
    expect(alertText().some((t) => t.includes('Bats is paused for a disconnect') && t.includes('9:45 of reconnect time left'))).toBe(true);
    // A repeated line changes nothing and alerts nobody again.
    const n = f.alerts.length;
    await f.line(`PUG ${token} TECH event=start id=${T1 + 90} team=a cause=disconnect by=${BATS[2]} used=15 budget=600 text=disconnected`);
    expect(f.alerts.length).toBe(n);
    expect(R.techPausesOf(f.db, f.match())).toHaveLength(2);
  });

  it('takes an emergency sub as one of the match\'s subs, and refuses it when the stage turned them off (Ruling 10)', async () => {
    const token = await playing();
    f.sent.length = 0;
    await f.line(`PUG ${token} SUB by=${A[0]} out=${A[3]} in=${A[4]} map=0 emergency=1`);
    expect(f.sent).toContain(`sm_pug_sub ${token} ${A[3]} ${A[4]}`);
    expect(f.sent.some((c) => /^say \[Match\] .+ is in for .+ \(Rats, emergency sub 1 of 2\)\.$/.test(c))).toBe(true);
    expect(R.subsUsed(f.db, f.match(), 'a')).toBe(1);
    setStageRules({ subs: { perMatch: 2, emergency: false, emergencyChargeSeconds: 0 } });
    f.sent.length = 0;
    await f.line(`PUG ${token} SUB by=${A[0]} out=${A[4]} in=${A[3]} map=0 emergency=1`);
    expect(f.sent.some((c) => c.startsWith(`say [Match] Sub refused: ${EVENT_ERRORS.emergency_off.text}`))).toBe(true);
    expect(f.sent.some((c) => c.startsWith('sm_pug_sub '))).toBe(false);
    expect(R.subsUsed(f.db, f.match(), 'a')).toBe(1);
  });

  it('records a game the reconnect pool forfeited from the result path, and says why (Ruling 9)', async () => {
    await playing();
    const g1 = f.gameOf(1).match_id!;
    // Rats (pug team b) ran out while leading: the box names Bats (pug team a) the winner.
    f.db.prepare("UPDATE matches SET state = 'completed', team_a_score = 100, team_b_score = 400, winner = 'a', forfeit_team = 'b', forfeit_why = 'disconnect', ended_at = datetime('now') WHERE id = ?").run(g1);
    f.sent.length = 0;
    f.runner.onGameEnded(g1);
    expect(f.gameOf(1)).toMatchObject({ score_a: 400, score_b: 100, forfeit_side: 'a', forfeit_why: 'disconnect', winner: f.entryB });
    expect(f.match().status).toBe('confirming');
    expect(f.sent.some((c) => c.includes('Bats beat Rats by forfeit (Rats ran out of reconnect time)'))).toBe(true);
  });
});

describe('staff penalties (series.ts)', () => {
  const paused = async () => {
    const token = await playing();
    await f.line(`PUG ${token} TECH event=start id=${T1} team=b cause=call by=${A[0]} used=0 budget=300 text=router`);
    return { token, id: R.techPausesOf(f.db, f.match())[0]!.id };
  };

  it('warns once, with a DM to both rosters', async () => {
    const { id } = await paused();
    expect((await f.series.techPenalty(f.matchId, ADMIN, id, 'warning', 'last warning')).ok).toBe(true);
    expect(f.send).toHaveBeenCalledWith(expect.arrayContaining([A[0], BATS[0]]), 'event_match_staff',
      expect.objectContaining({ content: expect.stringContaining('staff gave a warning for a technical pause (Rats, game 1: "router")') }));
    expect(await f.series.techPenalty(f.matchId, ADMIN, id, 'forfeit', null)).toEqual({ ok: false, error: 'already_penalized' });
  });

  it('forfeits the live game on the box for the pausing team\'s pug team, then records it (Ruling 12)', async () => {
    const { token, id } = await paused();
    f.sent.length = 0;
    expect((await f.series.techPenalty(f.matchId, ADMIN, id, 'forfeit', 'fake pause')).ok).toBe(true);
    // Rats (entry a) are pug team b on this game.
    expect(f.sent).toContain(`sm_pug_forfeit ${token} b`);
    expect(R.techPausesOf(f.db, f.match())[0]!.penalty).toMatchObject({ kind: 'forfeit', by: ADMIN, note: 'fake pause' });
    expect(f.send).toHaveBeenCalledWith(expect.anything(), 'event_match_staff',
      expect.objectContaining({ content: expect.stringContaining('ruled that a team forfeits the game over a technical pause') }));
    expect(forfeitTook('PUGOK forfeit team=b', 'b')).toBe(true);
    expect(forfeitTook('PUGOK forfeit team=b already', 'b')).toBe(true);
    expect(forfeitTook('PUGOK forfeit team=a', 'b')).toBe(false);
    expect(forfeitTook('PUGERR already forfeited', 'b')).toBe(false);
  });

  it('refuses a forfeit the box does not take or whose game is over, writing nothing, and a penalty it does not know', async () => {
    const { id } = await paused();
    f.box.forfeitOk = false;
    expect(await f.series.techPenalty(f.matchId, ADMIN, id, 'forfeit', null)).toEqual({ ok: false, error: 'no_box' });
    expect(R.techPausesOf(f.db, f.match())[0]!.penalty).toBeNull();
    f.box.forfeitOk = true;
    f.endGame(f.gameOf(1).match_id!, [{ map: 'm1', a: 100, b: 900 }]);
    expect(await f.series.techPenalty(f.matchId, ADMIN, id, 'forfeit', null)).toEqual({ ok: false, error: 'no_live_game' });
    expect(await f.series.techPenalty(f.matchId, ADMIN, id, 'forfeit-ish', null)).toEqual({ ok: false, error: 'bad_penalty' });
    // A warning is still possible in the confirm window.
    expect((await f.series.techPenalty(f.matchId, ADMIN, id, 'warning', null)).ok).toBe(true);
  });
});
```

In `tests/series.test.ts`, the `records a !gg as a forfeit ...` test's scoreline expectation (if it checks the announcement) keeps `typed !gg`; add to it `expect(f.gameOf(1).forfeit_why).toBe('gg');`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/matchRules.test.ts tests/series.test.ts`
Expected: FAIL (`techLine`, `techPenalty`, `forfeitTook` undefined; `subRequested` ignores the flag; no `forfeit_why` passed; the series line says "typed !gg").

- [ ] **Step 3: messages.ts**

`StaffAction` gains `| 'tech_warning' | 'tech_forfeit'`; `STAFF_TEXT` gains:

```ts
  tech_warning: 'gave a warning for a technical pause',
  tech_forfeit: 'ruled that a team forfeits the game over a technical pause',
```

- [ ] **Step 4: series.ts**

Add `import type { LogEvent } from '../logParse.js';` (beside the `AdminPauseCause` import) and after `adminPauseTook`:

```ts
/** A TECH line from a tournament box (pug-match 0.3.26, plan T5). */
export type TechLine = Extract<LogEvent, { kind: 'tech' }>;

/** True when pug-match answered `sm_pug_forfeit <token> <team>` with `PUGOK
 *  forfeit team=<team>` (or `... already`, a re-send): Cmd_PugForfeit, 0.3.26. */
export function forfeitTook(reply: string | null | undefined, team: 'a' | 'b'): boolean {
  for (const raw of (reply ?? '').split(/\r?\n/)) {
    const m = /^PUGOK forfeit team=(a|b)( already)?$/.exec(raw.trim());
    if (m) return m[1] === team;
  }
  return false;
}
const clock = (s: number): string => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, '0')}`;
```

In `gameEnded`, the row read adds `forfeit_why` (`SELECT state, team_a_score, team_b_score, forfeit_team, forfeit_why, booking_side_a ...`, typed `forfeit_why: 'gg' | 'disconnect' | 'staff' | null`) and the record call becomes:

```ts
      const rec = R.recordGame(this.db, { matchId: m.id, gameId: game.id, scoreA, scoreB, forfeit, forfeitWhy: forfeit ? row.forfeit_why ?? 'gg' : null, now, held });
```

`scoreline` becomes:

```ts
  private scoreline(m: P.MatchRow, v: ReturnType<typeof seriesVerdict>): string {
    const w = v.winner!;
    const l = other(w);
    // Plan T5 Ruling 9: the forfeited game says why.
    const why = v.forfeit === null ? null : R.gamesOf(this.db, m.id).filter((g) => g.forfeit_side === v.forfeit).at(-1)?.forfeit_why ?? 'gg';
    const how = why === 'disconnect' ? 'ran out of reconnect time' : why === 'staff' ? 'forfeited by staff ruling' : 'typed !gg';
    const line = v.forfeit !== null
      ? `by forfeit (${this.name(m, v.forfeit)} ${how})`
      : v.totalScore
      ? `${w === 'a' ? v.totalA : v.totalB} to ${w === 'a' ? v.totalB : v.totalA} on total score`
      : winsLine(w === 'a' ? v.winsA : v.winsB, w === 'a' ? v.winsB : v.winsA);
    return `${this.name(m, w)} beat ${this.name(m, l)} ${line}`;
  }
```

`subRequested` takes the flag:

```ts
  async subRequested(token: string, by: string, outId: string, inId: string, emergency = false): Promise<void> {
```

in its non-standing branch, before `R.subPlayer`:

```ts
      // Plan T5 Ruling 10: the box only sends emergency=1 when its cvar is on;
      // the stage's snapshot is the rule.
      if (emergency && !stageRules(this.db, E.getStage(this.db, m.stage_id)!).subs.emergency) {
        say(`Sub refused: ${V.EVENT_ERRORS.emergency_off.text}`);
        return;
      }
```

pass `emergency` to `R.subPlayer({ ..., emergency, now })`, and the success line becomes `` say(`${this.playerName(inId)} is in for ${this.playerName(outId)} (${this.name(m, side)}, ${emergency ? 'emergency sub' : 'sub'} ${used} of ${limit}).`) ``.

After `adminPauseLine` add:

```ts
  // ---------- technical pauses and staff penalties (plan T5) ----------

  /** The room side of a game's pug team: pug team a is the game's booking_side_a (Ruling 17). */
  private sideOfPugTeam(gameMatchId: number, team: 'a' | 'b'): Side {
    const sideA = (this.db.prepare('SELECT booking_side_a FROM matches WHERE id = ?').get(gameMatchId) as { booking_side_a: Side | null } | undefined)?.booking_side_a ?? 'a';
    return team === 'a' ? sideA : other(sideA);
  }
  private pugTeamOf(gameMatchId: number, side: Side): 'a' | 'b' {
    return this.sideOfPugTeam(gameMatchId, 'a') === side ? 'a' : 'b';
  }
  private gameLabelOf(m: P.MatchRow, gameMatchId: number): string {
    const g = R.gamesOf(this.db, m.id).find((x) => x.match_id === gameMatchId);
    return g ? this.gameLabel(m, g) : 'a game';
  }

  /** The box's TECH line (Rulings 5 to 7, 11, 14): recorded on the match
   *  log; a start and an overrun tell staff on the feed (a flag reaches them
   *  through the mod-call card). A repeat or a line for a game this match
   *  does not hold changes nothing. */
  techLine(token: string, ev: TechLine): void {
    const found = this.matchOfToken(token);
    if (!found) return;
    const { m, gameMatchId } = found;
    const side = this.sideOfPugTeam(gameMatchId, ev.team);
    const r = R.noteTech(this.db, {
      matchId: m.id, gameMatchId, event: ev.event, techId: ev.id, side, cause: ev.cause, by: ev.by,
      used: ev.used, budget: ev.budget, tactical: ev.tactical, text: ev.text, now: new Date(this.now()),
    });
    if (!r.ok) {
      if (r.error !== 'changed') console.warn(`[series] match ${m.id}: a TECH ${ev.event} line was not recorded (${r.error})`);
      return;
    }
    const team = this.name(m, side);
    const where = this.gameLabelOf(m, gameMatchId);
    if (ev.event === 'start') {
      this.alert(m, ev.cause === 'disconnect'
        ? `${team} is paused for a disconnect (${ev.by ? this.playerName(ev.by) : 'a player'}) in ${where}; ${clock(ev.budget - ev.used)} of reconnect time left.`
        : `${team} called a technical pause in ${where}: "${r.value.pause.reason}" (${clock(ev.budget - ev.used)} of technical time left).`);
    } else if (ev.event === 'over') {
      this.alert(m, ev.tactical === null || ev.tactical < 0
        ? `${team} ran out of technical time with no tactical pause left; the game was unpaused.`
        : `${team} ran out of technical time; the pause now uses a tactical pause (${ev.tactical} left).`);
    }
    this.push(m.id);
  }

  /** The desk's ruling on a technical pause (Ruling 12). A forfeit needs the
   *  pause's own game to be the one being played, and the box to take
   *  sm_pug_forfeit for the pausing team's pug team; the game then ends
   *  through the result path with forfeit_why=staff. Nothing is written
   *  until the box answered. */
  async techPenalty(matchId: number, by: string, pauseId: unknown, penalty: unknown, note: unknown): Promise<V.Checked<P.MatchRow>> {
    const m = P.getMatch(this.db, matchId);
    if (!m) return V.fail('match_not_found');
    if (penalty !== 'warning' && penalty !== 'forfeit') return V.fail('bad_penalty');
    const n = V.normalizeReason(note);
    if (!n.ok) return n;
    const pause = R.techPausesOf(this.db, m).find((p) => p.id === pauseId);
    if (!pause) return V.fail('pause_not_found');
    if (pause.penalty !== null) return V.fail('already_penalized');
    if (penalty === 'forfeit') {
      const live = this.liveGameOf(m);
      if (!live || live.game.match_id !== pause.gameMatchId) return V.fail('no_live_game');
      const b = this.runningBooking(m);
      if (!b) return V.fail('no_box');
      const team = this.pugTeamOf(pause.gameMatchId, pause.side);
      const replies = await this.deps.runner.send(b.id, [`sm_pug_forfeit ${live.token} ${team}`], 'the forfeit');
      if (!forfeitTook(replies?.[0], team)) return V.fail('no_box');
    }
    const r = R.techPenalty(this.db, { matchId, pauseId, by, penalty, note, now: new Date(this.now()) });
    if (!r.ok) {
      if (penalty === 'forfeit') console.error(`[series] match ${matchId}: the box took the forfeit but the penalty was not recorded (${r.error})`);
      return r;
    }
    tellStaffAction(this.deps, m.event_id, m.id, penalty === 'forfeit' ? 'tech_forfeit' : 'tech_warning',
      `${this.name(m, pause.side)}, ${this.gameLabelOf(m, pause.gameMatchId)}: "${pause.reason}"`);
    this.push(m.id);
    return V.ok(r.value.m);
  }
```

- [ ] **Step 5: server.ts**

The `sub_request` branch passes the flag: `seriesRef?.subRequested(ev.token, ev.by, ev.out, ev.in, ev.emergency === true).catch(...)`. After the `admin_pause` branch add:

```ts
        if (ev.kind === 'tech') {
          // A technical pause on a tournament box (plan T5): the match log, the room, the desk.
          try { seriesRef?.techLine(ev.token, ev); } catch (err) { console.error('[series] TECH line failed:', err); }
          return;
        }
```

- [ ] **Step 6: Run the tests and the typecheck**

Run: `npx vitest run tests/matchRules.test.ts tests/series.test.ts tests/eventLogGuard.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/events/series.ts src/events/messages.ts src/server.ts tests/seriesFixture.ts tests/matchRules.test.ts tests/series.test.ts
git commit -m "Tournaments T5: the series engine records technical pauses from the box on the right side, takes emergency subs, says why a game was forfeited, and staff can warn or forfeit the game over a technical pause"
```

---
### Task 9: The room page, the desk view and the penalty route

**Files:**
- Create: `src/events/pauseViews.ts`
- Modify: `src/events/roomViews.ts`, `src/events/playViews.ts`, `src/routes/adminEvents.ts`
- Test: `tests/eventRoomRoutes.test.ts`, `tests/roomViews.test.ts`

**Interfaces:**
- Consumes: `R.techPausesOf`, `R.gamesOf`, `R.seriesGames`, `gameNumberOf` (`seriesRules.ts`), `getPlayer`; `matchRoomView` (its `mySide` and `staff`), `deskOf` (its `live` game); `deskTool` (`adminEvents.ts`).
- Produces:
  - `pauseViews.ts`: `export interface RoomPause { id: number; game: number; tiebreak: boolean; side: 'a' | 'b'; cause: 'call' | 'disconnect'; reason: string | null; startedAt: string; endedAt: string | null; usedS: number; budgetS: number; overrun: boolean; flagged: boolean; flagNote: string | null; penalty: 'warning' | 'forfeit' | null }`; `export interface DeskPause extends RoomPause { byName: string | null; flaggedBy: string | null; penaltyNote: string | null; live: boolean }`; `roomPauses(db, m, insider: boolean): RoomPause[]`; `deskPauses(db, m, liveGameMatchId: number | null): DeskPause[]`.
  - `MatchRoomView.pauses: RoomPause[]`; `PlayMatchDesk.pauses: DeskPause[]`.
  - Route `POST /api/admin/events/:id/matches/:matchId/tech-penalty` `{ pauseId, penalty: 'warning' | 'forfeit', note? }` (admins; `event_tech_penalty` audit).

- [ ] **Step 1: Write the failing tests**

Append to `tests/eventRoomRoutes.test.ts`, inside the `describe` whose helpers are `MOD`, `base()` and `audit()` (the T3c desk describe):

```ts
  it('rules on a technical pause from the desk, shows the ledger to the desk with names and to the public without reasons (plan T5)', async () => {
    R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS });
    // A technical pause as R.noteTech writes it during a game (test setup only: noteTech itself needs a box phase).
    E.logEvent(f.db, f.eventId, A[0]!, 'tech_pause', new Date().toISOString(),
      { matchId: f.matchId, gameMatchId: 0, techId: 1_791_000_000, side: 'a', cause: 'call', by: A[0], reason: 'router', used: 0, budget: 300 });
    const pauseId = R.techPausesOf(f.db, P.getMatch(f.db, f.matchId)!)[0]!.id;
    expect((await post(`${base()}/tech-penalty`, MOD, { pauseId, penalty: 'warning' })).statusCode).toBe(403);
    expect((await post(`${base()}/tech-penalty`, ADMIN, { pauseId: 999_999, penalty: 'warning' })).json()).toEqual({ error: EVENT_ERRORS.pause_not_found.text });
    expect((await post(`${base()}/tech-penalty`, ADMIN, { pauseId, penalty: 'ban' })).json()).toEqual({ error: EVENT_ERRORS.bad_penalty.text });
    expect((await post(`${base()}/tech-penalty`, ADMIN, { pauseId, penalty: 'forfeit' })).json()).toEqual({ error: EVENT_ERRORS.no_live_game.text });
    expect((await post(`${base()}/tech-penalty`, ADMIN, { pauseId, penalty: 'warning', note: 'once' })).statusCode).toBe(200);
    expect((await post(`${base()}/tech-penalty`, ADMIN, { pauseId, penalty: 'warning' })).json()).toEqual({ error: EVENT_ERRORS.already_penalized.text });
    expect(audit().filter((a) => a === 'event_tech_penalty')).toHaveLength(1);
    const play = (await get(`/api/admin/events/${f.eventId}/play`, MOD)).json();
    const row = play.stages[0].rounds[0].matches.find((m: { id: number }) => m.id === f.matchId);
    expect(row.desk.pauses).toEqual([expect.objectContaining({ id: pauseId, side: 'a', cause: 'call', reason: 'router', penalty: 'warning', penaltyNote: 'once', live: false, flagged: false })]);
    expect((await get(room())).json().pauses).toEqual([expect.objectContaining({ id: pauseId, side: 'a', reason: null, penalty: 'warning', flagNote: null })]);
    expect((await get(room(), A[1])).json().pauses[0].reason).toBe('router');
    expect((await get(room(), B[1])).json().pauses[0].reason).toBe('router');
    expect((await get(room(), OUTSIDER)).json().pauses[0].reason).toBeNull();
  });
```

Append to `tests/roomViews.test.ts` (inside its `describe`; it already builds a room view with `matchRoomView`):

```ts
  it('lists no technical pauses for a match that has none, and a live game\'s pause by series game (plan T5)', async () => {
    const f = await roomFixture();
    R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS, now: NOW });
    expect(view(f, null).pauses).toEqual([]);
    const s = await seriesFixture();
    await s.tick();
    s.goLive(s.gameOf(1).match_id!);
    R.noteTech(s.db, { matchId: s.matchId, gameMatchId: s.gameOf(1).match_id!, event: 'start', techId: 1_791_000_000, side: 'b', cause: 'disconnect', by: B[2]!, used: 15, budget: 600, tactical: null, text: 'disconnected', now: new Date(s.t.t) });
    const v = matchRoomView(s.db, E.getEvent(s.db, s.eventId)!, s.match(), null, false, new Date(s.t.t));
    expect(v.pauses).toEqual([expect.objectContaining({ game: 1, tiebreak: false, side: 'b', cause: 'disconnect', reason: null, usedS: 15, budgetS: 600, overrun: false, flagged: false, penalty: null })]);
    s.close();
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/eventRoomRoutes.test.ts tests/roomViews.test.ts`
Expected: FAIL (no route, no `pauses` field).

- [ ] **Step 3: pauseViews.ts**

```ts
import type { DB } from '../db.js';
import { getPlayer } from '../players.js';
import type * as P from './play.js';
import * as R from './room.js';
import { gameNumberOf } from './seriesRules.js';

/**
 * Technical pauses as the room page and the Events desk show them (plan T5
 * Ruling 13): every pause to everyone, as the veto log is public; the reason
 * and the flag note only to the two rosters and staff; names only to staff.
 */
export interface RoomPause {
  id: number; game: number; tiebreak: boolean; side: 'a' | 'b'; cause: 'call' | 'disconnect';
  reason: string | null; startedAt: string; endedAt: string | null; usedS: number; budgetS: number;
  overrun: boolean; flagged: boolean; flagNote: string | null; penalty: 'warning' | 'forfeit' | null;
}
export interface DeskPause extends RoomPause { byName: string | null; flaggedBy: string | null; penaltyNote: string | null; live: boolean }

export function roomPauses(db: DB, m: P.MatchRow, insider: boolean): RoomPause[] {
  const games = R.gamesOf(db, m.id);
  const series = R.seriesGames(db, m);
  return R.techPausesOf(db, m).map((p) => {
    const g = games.find((x) => x.match_id === p.gameMatchId);
    const sg = g ? series.find((x) => x.id === g.id) : undefined;
    return {
      id: p.id, game: sg ? gameNumberOf(sg, series) : p.ordinal, tiebreak: g ? g.tiebreak_of !== null : false, side: p.side, cause: p.cause,
      reason: insider ? p.reason : null, startedAt: p.startedAt, endedAt: p.endedAt, usedS: p.used, budgetS: p.budget,
      overrun: p.overrun !== null, flagged: p.flagged !== null, flagNote: insider && p.flagged ? p.flagged.note : null,
      penalty: p.penalty?.kind ?? null,
    };
  });
}

export function deskPauses(db: DB, m: P.MatchRow, liveGameMatchId: number | null): DeskPause[] {
  const raw = R.techPausesOf(db, m);
  const name = (sid: string | null) => (sid === null ? null : getPlayer(db, sid)?.name ?? sid);
  return roomPauses(db, m, true).map((v, i) => {
    const p = raw[i]!;
    return { ...v, byName: name(p.by), flaggedBy: name(p.flagged?.by ?? null), penaltyNote: p.penalty?.note ?? null, live: liveGameMatchId !== null && p.gameMatchId === liveGameMatchId };
  });
}
```

- [ ] **Step 4: roomViews.ts, playViews.ts, adminEvents.ts**

In `roomViews.ts`: import `roomPauses, type RoomPause` from `./pauseViews.js`; `MatchRoomView` gains, after `schedule`, `/** Plan T5: the technical pauses (Ruling 13). */ pauses: RoomPause[];`; `matchRoomView`'s returned object gains `pauses: roomPauses(db, m, staff || mySide !== null),`.

In `playViews.ts`: import `deskPauses, type DeskPause` from `./pauseViews.js`; `PlayMatchDesk` gains `/** Plan T5: the technical pauses with names, and whether each one's game is being played. */ pauses: DeskPause[];`; `deskOf`'s returned object gains `pauses: deskPauses(db, m, live ? live.match_id! : null),`.

In `adminEvents.ts`, widen `deskTool`'s first parameter to `'reopen-veto' | 'move-server' | 'extend-grace' | 'release-hold' | 'freeze' | 'unfreeze' | 'tech-penalty'` and after the `unfreeze` line add:

```ts
  // Plan T5 Ruling 12: a warning or a forfeit of the game over a technical pause.
  deskTool('tech-penalty', 'event_tech_penalty', (s, id, me, body) => s.techPenalty(id, me, body.pauseId, body.penalty, body.note),
    (body) => ({ pauseId: body.pauseId, penalty: body.penalty }));
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run tests/eventRoomRoutes.test.ts tests/roomViews.test.ts tests/matchRules.test.ts tests/eventLogGuard.test.ts && npm run typecheck`
Expected: PASS on the server; the web typecheck passes too (its `api.ts` mirror does not list the new fields until Task 10, and an extra field in the JSON breaks nothing).

- [ ] **Step 6: Commit**

```bash
git add src/events/pauseViews.ts src/events/roomViews.ts src/events/playViews.ts src/routes/adminEvents.ts tests/eventRoomRoutes.test.ts tests/roomViews.test.ts
git commit -m "Tournaments T5: the room page lists the technical pauses with reasons for the two teams, the desk sees them with names, and the desk route warns or forfeits the game"
```

---
### Task 10: The web: the Tournament play editor group, the Pauses panel and the desk's Technical pauses

**Files:**
- Create: `web/src/routes/event/room/PausePanel.tsx`, `web/src/routes/event/room/PausePanel.test.tsx`
- Modify: `web/src/api.ts`, `web/src/routes/admin/rulesets/rulesDraft.ts`, `web/src/routes/admin/rulesets/RulesetForm.tsx`, `web/src/routes/EventMatch.tsx`, `web/src/routes/admin/events/PlayPanel.tsx`, `web/src/styles/app.css`
- Test: `web/src/routes/admin/rulesets/rulesDraft.test.ts`, `web/src/routes/admin/rulesets/AdminRulesets.test.tsx`, `web/src/routes/admin/events/PlayPanel.test.tsx`, and the `MatchRoomView` builders (`EventMatch.test.tsx`, `ServerPanel.test.tsx`, `LineupPanel.test.tsx`, `VetoBoard.test.tsx`, `ConfirmPanel.test.tsx`, `SchedulePanel.test.tsx`, `roomText.test.ts`: each gains `pauses: []`)

**Interfaces:**
- Consumes: `MatchRules`, `EditableRules`, `MatchRoomView`, `PlayMatchDesk`, `adminApi` (`api.ts`); `RulesTyped`, `editableFrom`, `typedFrom`, `readRules`, `readWhole` (`rulesDraft.ts`); `FormGroup`, `FormRow`, `ToggleRow`; `DeskTools`, `Run` (`PlayPanel.tsx`); `Panel` (`EventMatch.tsx`).
- Produces:
  - `api.ts`: `MatchRules` mirrors Task 1 (`pause.techSeconds`, `subs`, `disconnect`, `staffCall`, `series`); `RoomPause`, `DeskPause`; `MatchRoomView.pauses`; `PlayMatchDesk.pauses`; `adminApi.techPenaltyEventMatch(id: number, matchId: number, pauseId: number, penalty: 'warning' | 'forfeit')`.
  - `rulesDraft.ts`: `RulesTyped` gains `techSeconds`, `reconnect`, `subs`, `subCharge`, `cooldown`, `nextGame`; `readRules` reads them.
  - `RulesetForm.tsx`: the "Tournament play" group.
  - `PausePanel.tsx`: `export function PausePanel({ v }: { v: MatchRoomView })` (null with no pauses).
  - `PlayPanel.tsx` `DeskTools`: a Technical pauses group with Warn and, for a pause of the game being played, Forfeit the game.

- [ ] **Step 1: Write the failing tests**

In `web/src/routes/admin/rulesets/rulesDraft.test.ts`, `CUP` becomes:

```ts
const CUP: MatchRules = {
  rated: false,
  pause: { limit: 3, seconds: 120, mutualUnpause: true, techPauses: 2, techSeconds: 300 },
  teamLock: true, playerMapControl: false, restartHalf: { allowed: false, lockAfterDamage: false },
  noShowGraceMinutes: 15, penalties: false, bosses: 'random_published', sideRule: 'higher_seed_chooses', spectate: { sideLocked: true },
  subs: { perMatch: 2, emergency: true, emergencyChargeSeconds: 0 }, disconnect: { teamSeconds: 600 }, staffCall: { cooldownSeconds: 180 }, series: { nextGameSeconds: 60 },
};
```

Every `typedFrom` expectation and `readRules` call gains the six fields (`techSeconds: '300', reconnect: '600', subs: '2', subCharge: '0', cooldown: '180', nextGame: '60'`), and append:

```ts
  it('reads the Tournament play numbers, refusing a blank one with its label (plan T5)', () => {
    const e = editableFrom(CUP);
    const t = { ...typedFrom(e), techSeconds: '240', reconnect: '900', subs: '3', subCharge: '30', cooldown: '90', nextGame: '120' };
    expect(readRules(e, t)).toEqual({ ok: true, value: {
      ...e, pause: { ...e.pause, techSeconds: 240 }, disconnect: { teamSeconds: 900 }, subs: { ...e.subs, perMatch: 3, emergencyChargeSeconds: 30 },
      staffCall: { cooldownSeconds: 90 }, series: { nextGameSeconds: 120 },
    } });
    expect(readRules(e, { ...t, reconnect: '' })).toEqual({ ok: false, error: 'Reconnect time needs a whole number.' });
    expect(readRules(e, { ...t, nextGame: '1.5' })).toEqual({ ok: false, error: 'Next game after needs a whole number.' });
  });
```

In `web/src/routes/admin/rulesets/AdminRulesets.test.tsx`, `PUG_RULES` and `SCRIM_RULES` gain `techSeconds: 300` in `pause` and `subs: { perMatch: 2, emergency: true, emergencyChargeSeconds: 0 }, disconnect: { teamSeconds: 600 }, staffCall: { cooldownSeconds: 180 }, series: { nextGameSeconds: 60 }`; append inside its `describe`:

```ts
  it('edits the Tournament play numbers and sends them with the rest (plan T5)', async () => {
    render(<AdminRulesets />);
    await screen.findByText('Late Night', { selector: 'strong' });
    fireEvent.click(within(rowOf('Late Night')).button('Edit')!);
    expect(await screen.findByText('Tournament play')).toBeTruthy();
    fireEvent.input(screen.getByLabelText('Reconnect time'), { target: { value: '900' } });
    fireEvent.input(screen.getByLabelText('Technical time'), { target: { value: '240' } });
    fireEvent.click(screen.getByLabelText('Emergency subs'));
    fireEvent.click(screen.getByRole('button', { name: 'Save ruleset' }));
    await waitFor(() => expect(mockAdmin.updateRuleset).toHaveBeenCalledWith(4, 'Late Night', expect.objectContaining({
      pause: expect.objectContaining({ techSeconds: 240 }), disconnect: { teamSeconds: 900 }, subs: expect.objectContaining({ emergency: false }),
    })));
    expect(screen.queryByLabelText('Emergency sub cost')).toBeNull();
  });
```


Create `web/src/routes/event/room/PausePanel.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import type { MatchRoomView, RoomPause } from '../../../api';
import { PausePanel } from './PausePanel';

afterEach(() => cleanup());
const pause = (over: Partial<RoomPause> = {}): RoomPause => ({
  id: 1, game: 1, tiebreak: false, side: 'a', cause: 'call', reason: 'router restarted', startedAt: '2026-10-10T21:00:00.000Z', endedAt: '2026-10-10T21:02:00.000Z',
  usedS: 120, budgetS: 300, overrun: false, flagged: false, flagNote: null, penalty: null, ...over,
});
const v = (pauses: RoomPause[]) => ({ a: { name: 'Rats' }, b: { name: 'Bats' }, pauses }) as unknown as MatchRoomView;

describe('PausePanel', () => {
  it('renders nothing without pauses', () => {
    const { container } = render(<PausePanel v={v([])} />);
    expect(container.textContent).toBe('');
  });

  it('lists each pause with its team, kind, time, reason when known, flag and ruling', () => {
    render(<PausePanel v={v([
      pause(),
      pause({ id: 2, side: 'b', cause: 'disconnect', reason: null, usedS: 75, budgetS: 600, endedAt: null }),
      pause({ id: 3, game: 2, reason: null, overrun: true, flagged: true, penalty: 'forfeit', usedS: 300 }),
    ])} />);
    expect(screen.getByText(/Game 1 · Rats · technical · 2:00 of 5:00/)).toBeTruthy();
    expect(screen.getByText(/router restarted/, { selector: 'q' })).toBeTruthy();
    expect(screen.getByText(/Game 1 · Bats · disconnect · 1:15 of 10:00 · still paused/)).toBeTruthy();
    expect(screen.getByText(/Game 2 · Rats · technical · 5:00 of 5:00 · ran into tactical pauses · flagged by the other team · staff ruled the game forfeited/)).toBeTruthy();
  });
});
```

In `web/src/routes/admin/events/PlayPanel.test.tsx`: add `techPenaltyEventMatch: vi.fn()` to `mockAdmin`; the `desk` builder gains `pauses: []`; append:

```tsx
  it('warns over a technical pause, and offers Forfeit the game only for the game being played (plan T5)', async () => {
    const p = { id: 31, game: 1, tiebreak: false, side: 'a' as const, cause: 'call' as const, reason: 'router', startedAt: '2026-10-10T21:00:00.000Z', endedAt: null,
      usedS: 40, budgetS: 300, overrun: false, flagged: true, flagNote: 'looks fake', penalty: null, byName: 'Ann', flaggedBy: 'Bob', penaltyNote: null, live: true };
    mockAdmin.eventPlay.mockResolvedValue(play({ stages: [{ ...play().stages[0]!, rounds: [{ group: 1, round: 1, label: 'Final', dates: null, defaultAt: null, window: null, matches: [
      m({ status: 'live', phase: 'live', desk: desk({ pauses: [p, { ...p, id: 32, live: false, flagged: false, flaggedBy: null }] }) }),
    ] }] }] }));
    for (const fn of Object.values(mockAdmin)) if (fn !== mockAdmin.eventPlay) (fn as Mock).mockResolvedValue({});
    render(<PlayPanel eventId={9} canEdit />);
    fireEvent.click(await screen.findByText('Staff tools: Rats vs Bats'));
    expect(screen.getByText(/Game 1, Rats, technical: "router" by Ann, flagged by Bob/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Forfeit the game' })).toHaveLength(1);
    fireEvent.click(screen.getAllByRole('button', { name: 'Warn' })[1]!);
    await waitFor(() => expect(mockAdmin.techPenaltyEventMatch).toHaveBeenCalledWith(9, 7, 32, 'warning'));
    fireEvent.click(screen.getByRole('button', { name: 'Forfeit the game' }));
    await waitFor(() => expect(mockAdmin.techPenaltyEventMatch).toHaveBeenCalledWith(9, 7, 31, 'forfeit'));
  });
```

In each `MatchRoomView` builder listed under Files, add `pauses: []` after `schedule: null`.

- [ ] **Step 2: Run them to see them fail**

Run: `cd web && npx vitest run src/routes/admin/rulesets src/routes/event/room/PausePanel.test.tsx src/routes/admin/events/PlayPanel.test.tsx; cd ..`
Expected: FAIL (no fields, no `PausePanel`, no Technical pauses group).

- [ ] **Step 3: api.ts**

`MatchRules` becomes the server's shape:

```ts
/** Mirrors src/rulesets.ts MatchRules. */
export interface MatchRules {
  rated: boolean;
  pause: { limit: number | null; seconds: number | null; mutualUnpause: boolean; techPauses: number; techSeconds: number };
  teamLock: boolean;
  playerMapControl: boolean;
  restartHalf: { allowed: boolean; lockAfterDamage: boolean };
  noShowGraceMinutes: number;
  penalties: boolean;
  bosses: 'random_published' | 'fixed' | 'voteboss';
  sideRule: 'higher_seed_chooses' | 'non_picker_chooses' | 'coin';
  spectate: { sideLocked: boolean };
  subs: { perMatch: number; emergency: boolean; emergencyChargeSeconds: number };
  disconnect: { teamSeconds: number };
  staffCall: { cooldownSeconds: number };
  series: { nextGameSeconds: number };
}
```

After `MatchRoomView`'s neighbours add:

```ts
/** Mirrors src/events/pauseViews.ts RoomPause and DeskPause (plan T5). */
export interface RoomPause {
  id: number; game: number; tiebreak: boolean; side: 'a' | 'b'; cause: 'call' | 'disconnect';
  reason: string | null; startedAt: string; endedAt: string | null; usedS: number; budgetS: number;
  overrun: boolean; flagged: boolean; flagNote: string | null; penalty: 'warning' | 'forfeit' | null;
}
export interface DeskPause extends RoomPause { byName: string | null; flaggedBy: string | null; penaltyNote: string | null; live: boolean }
```

`MatchRoomView` gains `pauses: RoomPause[];` after `schedule`; `PlayMatchDesk` gains `pauses: DeskPause[];`; `adminApi` gains after `unfreezeEventMatch`:

```ts
  techPenaltyEventMatch: (id: number, matchId: number, pauseId: number, penalty: 'warning' | 'forfeit') =>
    post(`/api/admin/events/${id}/matches/${matchId}/tech-penalty`, { pauseId, penalty }),
```

- [ ] **Step 4: rulesDraft.ts and RulesetForm.tsx**

`rulesDraft.ts`:

```ts
export interface RulesTyped {
  limit: string; seconds: string; techPauses: string; grace: string;
  /** Plan T5: the Tournament play group. */
  techSeconds: string; reconnect: string; subs: string; subCharge: string; cooldown: string; nextGame: string;
}

export function typedFrom(r: EditableRules): RulesTyped {
  return {
    limit: r.pause.limit === null ? '' : String(r.pause.limit),
    seconds: r.pause.seconds === null ? '' : String(r.pause.seconds),
    techPauses: String(r.pause.techPauses),
    grace: String(r.noShowGraceMinutes),
    techSeconds: String(r.pause.techSeconds),
    reconnect: String(r.disconnect.teamSeconds),
    subs: String(r.subs.perMatch),
    subCharge: String(r.subs.emergencyChargeSeconds),
    cooldown: String(r.staffCall.cooldownSeconds),
    nextGame: String(r.series.nextGameSeconds),
  };
}

export function readRules(base: EditableRules, typed: RulesTyped): { ok: true; value: EditableRules } | { ok: false; error: string } {
  const limit = readWhole(typed.limit, 'Pauses per team', true);
  if (!limit.ok) return limit;
  const seconds = readWhole(typed.seconds, 'Pause length', true);
  if (!seconds.ok) return seconds;
  const tech = readWhole(typed.techPauses, 'Technical pauses', false);
  if (!tech.ok) return tech;
  const grace = readWhole(typed.grace, 'No-show grace', false);
  if (!grace.ok) return grace;
  // Plan T5: blank is an error for each, like the grace; the server judges the ranges.
  const nums: [keyof RulesTyped, string][] = [['techSeconds', 'Technical time'], ['reconnect', 'Reconnect time'], ['subs', 'Subs per match'],
    ['subCharge', 'Emergency sub cost'], ['cooldown', '!admin cooldown'], ['nextGame', 'Next game after']];
  const got: Partial<Record<keyof RulesTyped, number>> = {};
  for (const [k, label] of nums) {
    const r = readWhole(typed[k], label, false);
    if (!r.ok) return r;
    got[k] = r.value as number;
  }
  return {
    ok: true,
    value: {
      ...base,
      pause: { ...base.pause, limit: limit.value, seconds: seconds.value, techPauses: tech.value as number, techSeconds: got.techSeconds! },
      noShowGraceMinutes: grace.value as number,
      subs: { ...base.subs, perMatch: got.subs!, emergencyChargeSeconds: got.subCharge! },
      disconnect: { teamSeconds: got.reconnect! },
      staffCall: { cooldownSeconds: got.cooldown! },
      series: { nextGameSeconds: got.nextGame! },
    },
  };
}
```

The file comment gains: "The Tournament play numbers (plan T5) are read the same way; blank is an error."

`RulesetForm.tsx`, between the Match group and the actions:

```tsx
      <FormGroup title="Tournament play">
        <p class="muted">These apply on tournament servers only. PUGs and scrims never use them.</p>
        <FormRow label="Technical time" help="Seconds each team has per game for !tech pauses. Past it a pause uses the team's tactical pauses, then the game unpauses. (60 to 1800)" for={id('techSeconds')}>
          <input id={id('techSeconds')} aria-label="Technical time" type="number" min={60} max={1800} value={typed.techSeconds} onInput={type('techSeconds')} />
        </FormRow>
        <FormRow label="Reconnect time" help="Seconds per team per game while a player is disconnected (the game is paused). At zero the team forfeits the game. (60 to 3600)" for={id('reconnect')}>
          <input id={id('reconnect')} aria-label="Reconnect time" type="number" min={60} max={3600} value={typed.reconnect} onInput={type('reconnect')} />
        </FormRow>
        <FormRow label="Subs per match" help="Substitutions each team may make in a match. (0 to 4)" for={id('subs')}>
          <input id={id('subs')} aria-label="Subs per match" type="number" min={0} max={4} value={typed.subs} onInput={type('subs')} />
        </FormRow>
        <ToggleRow label="Emergency subs" help="While the game is paused for a disconnected player, a captain may !sub a bench player into that slot mid-chapter. It uses one of the match's subs." checked={d.subs.emergency}
          onChange={() => set({ subs: { ...d.subs, emergency: !d.subs.emergency } })} />
        {d.subs.emergency && (
          <FormRow label="Emergency sub cost" help="Seconds of the team's reconnect time an emergency sub uses. 0 for none. (0 to 600)" for={id('subCharge')}>
            <input id={id('subCharge')} aria-label="Emergency sub cost" type="number" min={0} max={600} value={typed.subCharge} onInput={type('subCharge')} />
          </FormRow>
        )}
        <FormRow label="!admin cooldown" help="Seconds before the same player can call staff with !admin again. (30 to 600)" for={id('cooldown')}>
          <input id={id('cooldown')} aria-label="!admin cooldown" type="number" min={30} max={600} value={typed.cooldown} onInput={type('cooldown')} />
        </FormRow>
        <FormRow label="Next game after" help="Seconds between two games of a series. The server loads the next game on its next minute pass after this. (30 to 600)" for={id('nextGame')}>
          <input id={id('nextGame')} aria-label="Next game after" type="number" min={30} max={600} value={typed.nextGame} onInput={type('nextGame')} />
        </FormRow>
      </FormGroup>
```

The Technical pauses row's help in the Pauses group becomes "Technical pauses (!tech) each team may call per game. 0 turns them off. (0 to 5)".

- [ ] **Step 5: PausePanel.tsx and EventMatch.tsx**

```tsx
import type { MatchRoomView } from '../../../api';

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** Plan T5 Ruling 13: every technical pause of the match. The reason shows
 *  only to the two teams and staff (the server leaves it null otherwise). */
export function PausePanel({ v }: { v: MatchRoomView }) {
  if (v.pauses.length === 0) return null;
  const team = (side: 'a' | 'b') => (side === 'a' ? v.a?.name : v.b?.name) ?? `Team ${side.toUpperCase()}`;
  return (
    <ul class="room__pauses">
      {v.pauses.map((p) => (
        <li key={p.id}>
          {`Game ${p.game}${p.tiebreak ? ' tiebreak' : ''} · ${team(p.side)} · ${p.cause === 'disconnect' ? 'disconnect' : 'technical'} · ${clock(p.usedS)} of ${clock(p.budgetS)}`}
          {p.endedAt === null && ' · still paused'}
          {p.reason !== null && p.cause === 'call' && <> · <q>{p.reason}</q></>}
          {p.overrun && ' · ran into tactical pauses'}
          {p.flagged && ' · flagged by the other team'}
          {p.flagNote && <> (<q>{p.flagNote}</q>)</>}
          {p.penalty === 'warning' && ' · staff gave a warning'}
          {p.penalty === 'forfeit' && ' · staff ruled the game forfeited'}
        </li>
      ))}
    </ul>
  );
}
```

(Testing Library matches an element's own text nodes, so each expectation reads one `li`; the third pause has no reason, so nothing sits between its time and "ran into tactical pauses".)

In `EventMatch.tsx`, import `PausePanel` and after the Server panel:

```tsx
      {v.pauses.length > 0 && (
        <Panel>
          <h3>Technical pauses</h3>
          <PausePanel v={v} />
        </Panel>
      )}
```

- [ ] **Step 6: PlayPanel.tsx DeskTools**

After `const canTime = ...`: `const canTech = d.pauses.length > 0;`; the early return becomes `if (!canAct && !canReopen && !canBox && !canTime && !canTech) return null;`; and as the last group inside the `<details>`:

```tsx
      {open && canTech && (
        <div class="desktools__group">
          <p class="muted">Technical pauses</p>
          <ul class="desktools__pauses">
            {d.pauses.map((p) => {
              const team = p.side === 'a' ? m.a?.name ?? 'Team A' : m.b?.name ?? 'Team B';
              return (
                <li key={p.id}>
                  {`Game ${p.game}, ${team}, ${p.cause === 'disconnect' ? 'disconnect' : 'technical'}: "${p.reason ?? ''}"${p.byName ? ` by ${p.byName}` : ''}${p.flaggedBy ? `, flagged by ${p.flaggedBy}${p.flagNote ? ` ("${p.flagNote}")` : ''}` : ''}`}
                  {p.penalty !== null
                    ? ` (${p.penalty === 'warning' ? 'warned' : 'game forfeited'}${p.penaltyNote ? `: ${p.penaltyNote}` : ''})`
                    : (
                      <>
                        {' '}
                        <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => void run(() => adminApi.techPenaltyEventMatch(eventId, m.id, p.id, 'warning'),
                          { title: `Warn ${team} over this technical pause?`, body: 'Both teams get a DM, and it is kept on the match log.' })}>Warn</button>
                        {p.live && (
                          <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => void run(() => adminApi.techPenaltyEventMatch(eventId, m.id, p.id, 'forfeit'),
                            { title: `${team} forfeits this game?`, body: 'The server ends the game now as a forfeit by this team; the series records it like a !gg. Both teams get a DM.' })}>Forfeit the game</button>
                        )}
                      </>
                    )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
```

In `web/src/styles/app.css`, after the `.desktools__group` rules:

```css
.desktools__pauses, .room__pauses { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.desktools__pauses li, .room__pauses li { overflow-wrap: anywhere; }
```

- [ ] **Step 7: Run the tests, the typecheck and the build**

Run: `cd web && npx vitest run && cd .. && npm run typecheck && npm run build`
Expected: PASS; the build writes the bundle with no type errors.

- [ ] **Step 8: Commit**

```bash
git add web/src/api.ts web/src/routes/admin/rulesets web/src/routes/event/room/PausePanel.tsx web/src/routes/event/room/PausePanel.test.tsx web/src/routes/EventMatch.tsx web/src/routes/EventMatch.test.tsx web/src/routes/event/room web/src/routes/admin/events/PlayPanel.tsx web/src/routes/admin/events/PlayPanel.test.tsx web/src/styles/app.css
git commit -m "Tournaments T5: the Rulesets editor sets the tournament match rules, the room page lists technical pauses, and the desk warns or forfeits the game over one"
```

---
### Task 11: The whole branch, and the owner's in-game checklist for 0.3.26

**Files:**
- Modify: none (fixes only if a check fails, each in its own commit)
- Test: the whole suite

- [ ] **Step 1: The whole suite, the typecheck and the build**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS, apart from failures the ledgers already record as unrelated (the `skeetStreakPoster` wall-clock tests): name each in the report, fix nothing outside this plan.

- [ ] **Step 2: PUG untouched, by reading**

Run: `git --no-pager diff 94faf647 -- plugin/ | grep -n '^[+-]' | grep -v '^[+-][[:space:]]*//'` and confirm each changed plugin path is behind `TourneyOn()`, `LeaveTeamMode()` (which needs `TourneyOn()`), a `!tech`/`!flag` handler reached only through `Tourney_OnSay` (which returns at once off a tournament box), or a non-`gg` `g_sForfeitWhy`. Run: `grep -n "sm_pug_leave_budget 0" src/bookings/tournamentGames.ts` (still there). Run: `npx vitest run tests/bookingRunner.test.ts -t "clears the booking cvars"` (the six resets in `CLEAR_LINES`).
Expected: every change accounted for; the PUG rows of Step 4 are the in-game proof.

- [ ] **Step 3: The scratch compile, once more, from the branch head**

Run the five commands of Task 4 Step 6. Expected: `built: ...` with no errors; `git status --short` shows nothing under `plugin/`.

- [ ] **Step 4: Hand the owner this checklist in the report (verbatim)**

The owner stages pug-match 0.3.26 only after every row passes on a box of their choosing (not by this plan). Setup on that box, by rcon or the server console (short budgets so the rows are quick; `TOKEN` is any 32 lowercase hex characters, `P1` and `P2` are two players' SteamID64s, `P3` a third player who is connected but not rostered, `S` a staff member with SourceMod root):

```
sm_pug_tournament 1; sm_pug_leave_budget 0; sm_pug_end_kick 0
sm_pug_tech_limit 2; sm_pug_tech_seconds 60; sm_pug_dc_team_seconds 90
sm_pug_sub_emergency 1; sm_pug_sub_charge 0; sm_pug_admin_cooldown 60
sm_pug_pause_limit 1; sm_pug_pause_seconds 30
log on
sm_pug_match 9001 TOKEN no_mercy
sm_pug_roster "P1:a"; sm_pug_roster "P2:b"
```

"Log line" is what the box writes to its log (the console with `log on`), which is exactly what the site receives over UDP; each `PUG TOKEN ...` line is signed as today.

| # | Who types what | Expected in chat / console | Log line the site receives |
|---|---|---|---|
| 1 | console: `sm_pug_status` | `tourney on=1 frozen=0`, `tourney rules emergency=1 charge=0 cooldown=60`, `STATUS leave team mode=1 seconds=90 used_a=0 used_b=0`, `tech limit=2 seconds=60 count_a=0 count_b=0 used_a=0 used_b=0 open=0` | none |
| 2 | P1 in ready-up: `!tech router` | to P1: `[Match] A technical pause is called during a live round.` | none |
| 3 | P1 in a live round: `!tech` | to P1: `[Match] Usage: !tech <reason>. Both teams and staff see the reason.` | none |
| 4 | P1 in a live round: `!tech my router restarted` | the game pauses; all: `[Match] Team A technical pause: my router restarted (1:00 of technical time left; the other team can !flag it for staff).` | `PUG TOKEN TECH event=start id=<unix> team=a cause=call by=P1 used=0 budget=60 text=my router restarted`, then `PUG TOKEN PHASE state=paused team=0 limit=30 leave=0` (no `PAUSE` line) |
| 5 | P1: `!flag no` | to P1: `[Match] !flag is for the other team's technical pause, while it runs.` | none |
| 6 | P2: `!flag looks fake` | all: `[Match] P2 flagged Team A's technical pause for staff review. Play goes on as normal; staff decide.` | `PUGCALL steamid=P2 target=none tteam=<2 or 3> reason=tech match=9001 ... text=Team A technical pause: my router restarted \| looks fake` and `PUG TOKEN TECH event=flag id=<same> team=a cause=call by=P2 used=<n> budget=60 text=looks fake` |
| 7 | P2: `!flag again` | to P2: `[Match] This technical pause is already flagged for staff.` | none |
| 8 | wait | all, at once (the whole budget is under a minute) `[Match] Team A has 59 seconds of technical time left. Past it the pause uses a tactical pause.`, then the same at 30 and 10; at 0: `[Match] Team A is out of technical time: this pause now uses one of their tactical pauses (0 left).` | `PUG TOKEN TECH event=over id=<same> team=a cause=call by=P1 used=60 budget=60 tactical=0 text=`, `PUG TOKEN PAUSE team=1 used=1 limit=1` |
| 9 | wait 30 s more | `Unpausing in 10 seconds...`, then `[PUG] Team A's pause has run out. Unpausing.`; the game resumes after Rotoblin's countdown | `PUG TOKEN PAUSE_EXPIRED team=1 seconds=30`, `PUG TOKEN TECH event=end id=<same> team=a cause=call by=P1 used=60 budget=60 text=` |
| 10 | P1: `!tech again` | to P1: `[Match] Your team has no technical time left this game. Use !pause for a tactical pause.` | none |
| 11 | P2: `!tech mouse`, then both teams `!ready` | the game pauses, then unpauses on the mutual ready | `TECH event=start ... team=b ...`, then `TECH event=end ... team=b used=<seconds paused>` |
| 12 | P2: `!tech one`, both `!ready`; P2: `!tech two` | the third is refused: `[Match] Your team has used all 2 technical pauses this game.` | two start/end pairs, nothing for the third |
| 13 | S: `sm_pug_adminpause TOKEN on` during P2's `!tech three` (raise `sm_pug_tech_limit 3` first), wait 20 s, `sm_pug_status`, then `sm_pug_adminpause TOKEN off` | `used_b` does not grow while frozen; it grows again once lifted | `ADMINPAUSE state=on ...`, `ADMINPAUSE state=off ...`, the TECH lines of that pause |
| 14 | P2 quits the game mid-round | all: `[Match] P2 disconnected. Team B has 1:30 of reconnect time left this game; the game pauses for them.`; the game pauses | `PUG TOKEN LEAVE steamid=P2 remaining=90`, `PUG TOKEN TECH event=start id=<unix> team=b cause=disconnect by=P2 used=0 budget=90 text=disconnected` |
| 15 | P2 reconnects within 30 s | all: `P2 is back (1:0x of reconnect time left).`, `Everyone is back. Unpausing in 10 seconds.` | `RETURN steamid=P2 remaining=<about 60>`, `TECH event=end ... team=b cause=disconnect used=<about 30> budget=90` |
| 16 | P2 quits again; P3 joins as a spectator; P1: `!sub <P2's name> <P3's name>` (a unique part of each name is enough) | P1: `[Match] Asking the site to put P3 in. It answers in chat.` | `PUG TOKEN SUB by=P1 out=P2 in=P3 map=0 emergency=1` |
| 17 | console (standing in for the site): `sm_pug_sub TOKEN P2 P3` | reply `PUGOK sub out=P2 in=P3 slot=2`; all: `P3 replaces P2 for Team B (emergency sub).` and `Nobody is missing any more. Both teams type !ready to unpause.`; P3 is moved onto team B within 2 s (taking the survivor bot, or as infected); `sm_pug_status` shows `used_b` no longer growing; after both teams `!ready` the game resumes | after the unpause: `PUG TOKEN TECH event=end ... team=b cause=disconnect ...` (the site writes the roster itself) |
| 18 | `sm_pug_sub_charge 30`, repeat 16 and 17 with another bench player | also: `The emergency sub costs Team B 30 seconds of reconnect time (m:ss left).` | as 16 |
| 19 | mid-round with nobody missing, P1: `!sub P1 P3`; console: `sm_pug_sub TOKEN P1 P3` | to P1: `[Match] Mid-chapter, a sub can only replace a player who disconnected, while the game is paused for them. Otherwise wait for the next ready-up.`; reply `PUGERR not between chapters` | none |
| 20 | P1 quits and stays out | all at 60, 30, 10 left: `Team A has N seconds of reconnect time left. At zero it forfeits this game.`; at 0: `Team A ran out of reconnect time and forfeits this game.`, then `[PUG] Match ended. no_mercy: Team B wins by forfeit <a> to <b>. Reporting to the site.` | `PUG TOKEN MATCH_END a=<a> b=<b> winner=b forfeit=a forfeit_why=disconnect` and no `ABANDON` line |
| 21 | console: `sm_pug_dump TOKEN n1`, `sm_pug_status` | the dump's last line `END winner=b a=<a> b=<b> forfeit=a forfeit_why=disconnect nonce=n1 state=ended`; status `STATUS leave abandoner=none ...` | none |
| 22 | new game `sm_pug_match 9002 TOKEN2 no_mercy` + rosters; give Team A the lead (play a map); console: `sm_pug_forfeit TOKEN2 a` | reply `PUGOK forfeit team=a`; all: `Staff ruled that Team A forfeits this game.`; then `sm_pug_forfeit TOKEN2 a` again: `PUGOK forfeit team=a already`; `sm_pug_forfeit TOKEN2 b`: `PUGERR already forfeited` | `PUG TOKEN2 MATCH_END a=<higher> b=<lower> winner=b forfeit=a forfeit_why=staff` (winner b although a led) |
| 23 | new game; P1: `!admin help`; S: `!lift`; P1: `!admin again` within 60 s | the freeze, then lifted; to P1: `[Match] You can call staff again in 0:5x.` | `PUGCALL ... reason=admin ...`, `ADMINPAUSE state=on by=P1 cause=call`, `ADMINPAUSE state=off ... cause=staff` |
| 24 | PUG check: `sm_pug_tournament 0; sm_pug_leave_budget 20`, a new match; P1: `!tech x`, `!flag x` | both are plain chat (no reply, no pause) | none |
| 25 | PUG check, same match: P2 quits and stays out | per-player clock: `[PUG] P2 disconnected. They have 0:20 of reconnect time left for this match.`; at 0: `P2 did not reconnect in time. The match is over and counts as an abandon...` | `LEAVE steamid=P2 remaining=20`, then `ABANDON steamid=P2` (no `TECH` line, no `forfeit_why`) |
| 26 | PUG check: a new match where team B trails beyond reach; team B: `!gg` and agree | `[PUG] Team B forfeits. GG.` | `MATCH_END ... winner=a forfeit=b` with no `forfeit_why` (byte for byte 0.3.25's) |

Expected: every row as written. A row that differs is reported with the exact chat and log text, and 0.3.26 is not staged until it is fixed.

- [ ] **Step 5: Report**

Report the suite, typecheck and build results, the scratch compile output, the unrelated failures by name, and the checklist above. No commit unless a check needed a fix.
