# Tournaments plan T4: window scheduling and reschedules

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every round of a window stage (every league, and any stage the organizer sets to windows) carries a default time and a window, set by the organizer per round from the Events desk (a league fills them from a weekly pattern against its season start); a bracket round of a rolling stage can carry a date, which is binding: its rooms open no earlier. A captain or co-captain of either team proposes another time inside the window from the match room; the other side accepts, declines or counters; a proposal nobody answers locks on its own after `reschedule_autoaccept_hours` (setting, default 24) when it was made at least 48 hours before the proposed time. Discord DMs go out when a proposal arrives, 24 hours before it locks on its own, and when a time is locked. At the locked time minus `event_window_lead_minutes` (setting, default 20) the match room opens exactly as a rolling one does (T3a ready check, veto, lineups), the series engine books the box at lineup lock as in T3b, and the capacity rules keep a box back for every scheduled match ahead of time. A match still unplayed when its window ends is a forfeit against the side that never answered the other's proposal and never played, and otherwise goes to `admin_hold` with the proposal log on the desk. All times are stored UTC and shown in the viewer's time zone on the site and in each player's own zone in Discord. Nothing is deployed by this plan; production stays behind `competitive_enabled = 'admins'`.

**Architecture:** One new module, `src/events/schedule.ts`, owns the new `event_reschedules` table and the two agreed-time columns of `event_matches` (`scheduled_at`, `schedule_source`), in the same shape as `room.ts`: each mutation is one transaction with exactly one `event_log` row, and `tests/eventLogGuard.test.ts` gains a guard section for it (and lists it as the third writer of `event_matches`). The per-round schedule lives on the stage (`event_stages.schedule_json`, written by `events.ts` `setRoundSchedule`, readable while the event is live, unlike the stage's other settings) and is stamped onto match rows by `play.ts` when a round is written (`insertRound`, `syncBracket`) and on demand (`applySchedule`); a league round with no explicit row gets its T2 week as its window and no default time. The room clock (`roomClock.ts`) gains a second due list (window-stage matches whose locked time minus the lead has come) and a `schedule` pass each tick (auto-accepts, reminders, stale proposals, window ends). The booking stays T3b's (made at lineup lock, the box taken at once); `src/bookings/rules.ts` counts scheduled, not yet booked tournament matches as two-hour slots in `capacityProblem` (scrims cannot book over them) and `bookingsDue` (the PUG queue, side games and practice keep a box back for them), so capacity is reserved ahead with no booking row. Two DM types (`event_reschedule`, `event_match_time`) go through the existing notices. The room page gets a Schedule panel, the event page shows times on round headers and match cards, and the desk gets a per-stage Round schedule editor and a Set time tool. No plugin change.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Fastify 5, better-sqlite3, vitest (`npm test`, `npx vitest run <file>`), `npm run typecheck` (server and web), `npm run build`; Preact + preact-iso + @testing-library/preact (happy-dom) for the web. No new dependencies. No SourcePawn.

**Spec:** `docs/superpowers/specs/2026-09-30-competitive-tournaments-design.md` section 4 (Start time: "Window (long events): the agreed time from section 5. The flow starts 20 minutes before it"; Booking and connect: "For window-scheduled matches the booking is made when the time is agreed"), section 5 (Scheduling for long events, the whole section), section 3 League (N weeks, X matches a week), Rollout item 4. Plan T2 Rulings 7, 18, 19 and 20 (`docs/superpowers/plans/2026-10-05-tournaments-2-brackets.md`: a league season is a match count at 1 to 3 a week from a season start date; week dates are labels in T2 and "rollout plan 4 turns them into windows with a deadline"). Plan T3a Rulings 2 and 13 (`docs/superpowers/plans/2026-10-06-tournaments-3a-match-room.md`: rolling rooms open on their own, window rooms only by hand "until rollout plan 4"). Read the T3a, T3b and T3c ledgers (`.superpowers/sdd/*/progress.md` under each worktree) before this plan's Rulings: nothing here reverses one of theirs.

**T3c as built (checked against branch `tournaments-t3c` at d32aae26, the head that carries its final review wave, 2026-10-07; this plan's snippets follow the code):** `src/events/play.ts` owns every write to `event_matches` together with `room.ts` (`tests/eventLogGuard.test.ts`, play guard: `MATCH_WRITERS` offenders may be only those two files; `PLAY_READS` lists `getMatch`, `matchesOf`, `stageEntrants`, `stageBracket`, `activeSeeded`, `totalRounds`; `PLAY_MUTATIONS` lists `startEvent`, `recordResult`, `addRound`, `finishStage`); `insertRound(db, eventId, stageId, r, at)` and `syncBracket(db, eventId, stageId, data, at)` are the two inserters of match rows and `openStage` writes `started_at` before calling them; `MatchRow` already carries `not_before`, `scheduled_at`, `window_start`, `window_end` (columns from T2, "created now, empty"). `events.ts` writes `events`, `event_stages` and `event_log` (guard `WRITERS`; `READS` lists `getEvent`, `getEventBySlug`, `getStage`, `stagesOf`, `eventLog`, `fieldsOf`, `stageSettingsOf`, `stageContext`, `chainOf`; `MUTATIONS` lists eleven, each run from a `draft`, `announced` or `registration` fixture); `STAGES_LOCKED` (`validate.ts`) refuses stage edits from `live` on; `ownStage`, `touch`, `logEvent` are its helpers; `StageRow` has `started_at`. `room.ts` has `HOLDABLE` (`veto`, `lineup`, `booking`, `connect`, `live`, `confirming`), `holdMatch` writing `hold_from`, `releaseHold` (refuses `hold_not_releasable` when `hold_from` is not in `HOLDABLE`, checks the booking for `BOX_PHASES`), `liveMatch`, `sideOf`, `entryOn`, `ROOM_LIVE_SQL`, `roomTimers`, `openRoom` (refuses `wrong_status` unless `waiting`, `entry_busy` when a team is in another open room), `resetRoom` (leaves `scheduled_at` and the window alone). `roomClock.ts` has `dueRooms(db, now)` (rolling stages only, `not_before` honoured, each team's earliest unresolved match, one room per team), `RoomClock` with `deps { db, notifier?, publicUrl?, push?, now?, seed?, series? }`, `pushChange`, `resume`, `tick` (`openDue`, `series.tick`, `expire`), `expireOne` acting on `veto`, `lineup`, `live`, `confirming` deadlines, and `forfeitMatch`/`holdMatch` for the ready check. `flow.ts` `forfeitMatch(db, { eventId, matchId, winner, expect, now })` reports inside the event's chain and settles. `notices.ts` has `NoticeDeps`, the private `tell` and `rostersOf`, `tellRoomOpen`, `tellReadyForfeit(d, eventId, matchId, why: 'ready' | 'server' = 'ready')`, `tellConnect`, `tellSeriesResult`, `tellStaffAction`; `messages.ts` has `EventNotifyType`, `StaffAction`, `eventMessage(db, publicUrl, eventId, type, extra)` with the `event_match_room | event_match_forfeit` case building the "Open the match room" link, and imports `whenUtc` from `../bookings/messages.js`; `notify.ts` has `NotifyType`, `NOTIFY_TYPES` (`tests/notify.test.ts` checks `prefsOf` lists exactly them and pins the T3 labels). `playViews.ts` has `RoomPhase`, `phaseOf`, `PlayMatch` (`desk?: PlayMatchDesk` for staff), `PlayRound { group, round, label, dates, matches }` (`dates` is the league week from `weekDates(seasonStart, weekOfRound(round, perWeek))`, `seasonStart` falling back to the stage's `started_at` or the event's `starts_at` day), `stageLabels`, `deskOf`, `stagePlayViews(db, ev, { staff })`. `roomViews.ts` has `MatchRoomView` (last field `frozen`), `matchRoomView(db, ev, m, viewer, staff, now)`; the six web test builders of `MatchRoomView` are `EventMatch.test.tsx`, `ServerPanel.test.tsx`, `LineupPanel.test.tsx`, `VetoBoard.test.tsx`, `ConfirmPanel.test.tsx`, `roomText.test.ts`. `league.ts` is pure and shared with the web (`weekDates`, `weekOfRound`, `leagueWeeks`, `perWeekFor`, `byeSpread`, `repeatedRoundRobin`, `DAY`, the private `day`/`ymd`). `validate.ts` has `parseTime` (ISO with a zone, as UTC), `normalizeReason` (one line, at most 300), `isObj`, `isInt`, `EVENT_ERRORS`, `Checked`, `ok`, `fail`, `Scheduling`, `SCHEDULING_KINDS`. `series.ts` `book(m, now)` makes the booking from the `booking` status (`createTournamentBooking`, `starts_at` now) and the runner's `allocate` takes the highest-id idle box at once; `runningBooking`, `presence`, `ready` unchanged. `rules.ts` has `capacityProblem(db, { region, startMs, endMs, exceptId })` over open booking rows (a `rows` list of `{ s, e }`) and `bookingsDue(db, nowMs, withinMinutes)` (used by `serverPool.claimIdle`, `sideGames.ts`, `practiceLeases.ts`), `bookingLimits`, `iso`. The routes: `src/routes/events.ts` (`eventRoutes`, `allowedViewer`, `allowedActive`, `visibleEvent`, `matchIn`, `refuse`, the `for (const action of ['ready', 'veto', 'lineup', 'confirm', 'dispute'])` loop pushing `opts.rooms?.pushChange(m.id)`), `src/routes/adminEvents.ts` (`adminEventRoutes`, `requireAdmin`, `requireStaff`, `refuse`, `idOf`, `eventOf`, `action(path, name, call, detail, after)`, `roomAction`, `deskTool`, `AdminEventStage { id, ordinal, summary, settings, rulesSnapshotted }`, `adminEventDetail`). The web: `web/src/api.ts` mirrors every view type (`PlayMatch`, `PlayRound`, `MatchRoomView`, `AdminEventStage`, `eventsApi`, `adminApi`), `web/src/eventFormat.ts` has `whenText` (viewer's zone), `toLocalInput`, `fromLocalInput`, `weekRangeText`, `groupPrefix`; `EventMatch.tsx` builds the room page from panels under `web/src/routes/event/room/`; `StagePlay.tsx` renders round headers (`r.label`, `r.dates`) and `MatchCard` (`Bracket.tsx`); `PlayPanel.tsx` has `DeskLine`, `DeskTools` (one `<details class="desktools">` per match), `MatchRow`; `EventEditor.tsx` lists stages with `StageForm` behind `stagesOpen` (`canEdit && !STAGES_LOCKED.includes(ev.status)`) and mounts `PlayPanel` with `slug`. Settings are seeded in `src/db.ts` `DEFAULT_SETTINGS` and described in `src/settingsSchema.ts` (`tests/adminSettings.test.ts`: every schema key has a seeded default). `src/db.ts` runs `SCHEMA` (`CREATE TABLE IF NOT EXISTS ...`) on every open, then `ensureColumn` migrations. Branch `tournaments-t4` from d32aae26; where this plan's snippets and the code disagree, the code wins.

## Global Constraints

- Team events only (`entry_kind = 'team'`).
- Every write to `event_matches` stays in `src/events/play.ts`, `src/events/room.ts` and, from this plan, `src/events/schedule.ts` (the agreed time only: `scheduled_at`, `schedule_source`); every write to `event_reschedules` stays in `schedule.ts`; every write to `event_stages` stays in `events.ts`. Each mutation is one transaction writing exactly one `event_log` row on success and nothing on refusal (`tests/eventLogGuard.test.ts`, extended in Task 3). The clock and the routes never write those tables themselves.
- Every write to the booking tables stays in `src/bookings/bookings.ts`; this plan writes none (capacity is reserved by counting, not by booking rows).
- Times are stored as `Date#toISOString()` UTC strings and compare as text; the web shows them in the viewer's zone (`whenText`) and Discord DMs use Discord's own timestamp markup (`<t:unix:F>`), so nobody reads a UTC time by hand. The one exception is a league week's dates, which stay calendar days shown as written (T2 Ruling 19).
- Lineups stay secret until both are locked (T3a); the schedule panel shows nothing about lineups.
- A proposal log is public on the room page (it holds times and team names only), as the veto log is.
- Tournament games never move SR.
- Never write em dashes in code, comments, copy, commits or docs.
- Commit messages follow the repo style (a plain sentence). Do not push. Do not deploy. No live server is touched.
- Several Claude sessions use `/home/volence/l4d/pug`: work in the worktree `/home/volence/l4d/pug/.claude/worktrees/tournaments-t4` (branch `tournaments-t4`, already at d32aae26). Run `npm ci` inside the worktree (never symlink `node_modules`). Check `git reflog -10` and `git status` before any write on master.

## Rulings this plan makes (for the owner to confirm)

1. **Scope (rollout item 4).** Per-round schedules on the desk, league weeks as windows, captain proposals with accept, decline, counter and withdraw, auto-accept, the three DMs, rooms opening on the locked time, capacity kept back ahead of time, window-end forfeits and holds, a staff Set time tool, and dates on the event page. Discord channel posts (round pairings, cards) stay in rollout plan 5.
2. **Where the schedule lives.** `event_stages.schedule_json` is a list of `{ round, at, from, to }` rows (UTC), written by `events.ts` `setRoundSchedule`, which is allowed while the event is live (a league's weeks are set as the season runs and a Swiss stage's later rounds do not exist until paired) and refused only for a finished or cancelled event or a finished stage (`schedule_locked`). `play.ts` stamps the rows onto matches: a window stage's match gets `scheduled_at = at` (`schedule_source = 'default'`), `window_start = from`, `window_end = to`; a rolling stage's match gets `not_before = at` and no window (Ruling 3). Stamping happens when the round is written (`insertRound`, `syncBracket`) and again through `applySchedule` after every save on a live stage, which never overwrites a time a captain agreed or staff set (`schedule_source` `agreed` or `staff`), but always rewrites the window and `not_before`, which are the organizer's.
3. **Bracket rounds on specific days (the owner's earlier ask): binding.** A schedule row on a rolling stage is a date only (`from` and `to` must be null, `bad_schedule` otherwise) and is stamped as `not_before`, which T3a's `dueRooms` already honours: the round's rooms open no earlier than that time, and the event page shows the date on the round header ("Semifinals · Sat Oct 24, 21:00"). Information-only dates were rejected because the clock would then open a room days early the moment the previous round finished.
4. **A league week is a window.** A league round with no explicit schedule row gets its T2 week as its window (`weekWindow`: 00:00:00 UTC of the week's first day to 23:59:59 UTC of its last) and no default time, so captains must agree a time or the window-end rule applies. An explicit row (from the weekly pattern or typed) replaces that. Week 1 starts on the season start date, or the day the stage started (T2 Ruling 19, unchanged).
5. **Booking at lineup lock, capacity reserved by counting (the open decision).** The booking stays as T3b built it: made when both lineups lock, `starts_at` now, the highest-id idle box taken at once. A booking row made earlier would need a campaign and the eight players before the veto and the lineups exist, and the runner would set the box up at `starts_at - hold lead` with no game to push. Instead `src/bookings/rules.ts` counts every scheduled, not yet booked tournament match (`scheduled_at` set, `booking_id` null, status pending, waiting, veto, lineup or booking, in a live window stage of a live event) as a slot of `EVENT_SLOT_MINUTES` (120) from its time: `capacityProblem` adds those slots in the event's region, so a scrim cannot book over a scheduled match, and `bookingsDue` adds those due within the protect window, so the PUG queue, side games and practice leases keep a box back for them as they do for a confirmed scrim. The room opens `event_window_lead_minutes` (default 20, the spec's figure; range 5 to 60) before the time, so the lineups lock around the time itself and the booking follows at once; with no idle box the match waits and staff are alerted after 10 minutes as in T3b Ruling 8.
6. **Auto-accept.** `auto_accept_at = created_at + reschedule_autoaccept_hours` when the proposed time is at least 48 hours after the proposal, else null (an answer is required; the clock expires the proposal once its time has passed, `reschedule_expired` with `time_passed`). The reminder DM goes out at `auto_accept_at - 24 h` only when that is at least an hour after the proposal; with the default 24 hours that moment is the proposal itself, so the arrival DM carries the lock time and no second DM is sent. `reschedule_autoaccept_hours` is an integer setting 1 to 72, seeded 24; `event_window_lead_minutes` 5 to 60, seeded 20.
7. **Who proposes and what.** A captain or co-captain of either team (`sideOf`), while the match is `waiting` in a live window stage with a window whose end has not passed (`not_schedulable` otherwise: a match whose room is open, a rolling stage, or a match with no window yet, which staff fix with the round schedule). The time must be a date and time inside the window, at least an hour ahead, and not the current locked time (`bad_time`). One open proposal per match (`proposal_open`); the other side accepts, declines or counters (a counter closes the open one as `countered` and opens the new one in one transaction, one log row); the proposing side may withdraw (`not_your_proposal` for the other side); a side cannot answer its own (`own_proposal`). An optional note of one line, at most 300 characters (`normalizeReason`). Accepting (by a person or the clock) sets `scheduled_at` and `schedule_source = 'agreed'`; a declined or withdrawn proposal changes no time.
8. **The window end.** Each tick, a window-stage match still `waiting` whose `window_end` has passed: any open proposal expires (`window_ended`); then the "silent" side is the side that made no proposal and answered none while the other side made at least one, and it forfeits (`forfeitMatch` with `expect` still waiting; the forfeit DM says why: `why = 'window'`); with no proposal at all, or both sides having acted, the match is held (`window_expired`) and staff get a feed alert linking the room, where the proposal log shows who did what. `HOLDABLE` gains `waiting` so the hold can be taken from there, and `releaseHold` puts such a match back to `waiting` with no deadline (staff then set a time or open the room). A match whose locked time came and whose room opened but nobody readied is already T3a's `nobody_ready` hold; the window end never touches a match whose room is open.
9. **Rooms on the locked time.** `dueWindowRooms(db, now, leadMs)`: window-stage matches `waiting` with both teams in, `scheduled_at - lead <= now`, neither team busy in another open room. The earliest-match rule of rolling stages does not apply (a league week's two matches are independent), the busy rule does: a team in another room gets its second room when the first closes. A match whose room staff reset after its time passed reopens on the next tick, as a rolling room does (T3a Ruling 13); staff who want a pause hold it or set a new time first.
10. **Staff set a time.** The desk's Set time takes any future date and time (the window is not enforced for staff), on a `waiting` match of a window stage; it expires an open proposal in the same transaction and records `schedule_source = 'staff'`; both rosters get the `event_match_time` DM; `admin_actions` gets `event_match_time`. The desk's Round schedule editor (per stage, any status but finished or cancelled) saves the list and, on a live stage, applies it at once; `admin_actions` gets `event_schedule_set`.
11. **DMs.** `event_reschedule` goes to the managers (captain and co-captains) of the side that must act: the other side on a proposal or a counter and for the reminder; the proposing side on a decline or a withdrawal. `event_match_time` goes to both rosters (starters, subs, coach) when a time locks by acceptance, auto-acceptance or staff. Both are opt-out types like the others. Times in DMs are Discord timestamps (`<t:unix:F>`), which Discord shows in the reader's zone; the UTC text is not repeated.
12. **The event page and the room page.** Round headers show the round's default time or date (`PlayRound.defaultAt`, viewer's zone) after the T2 week label; a match card shows its own locked time when it differs from the round default or when the round has none; a window stage's round header also shows the window ("play by Sun Oct 18, 23:59"). The room page gets a Schedule panel for window-stage matches: the locked time (with "the room opens 20 minutes before"), the window, the open proposal with Accept, Decline and Counter for the answering side's managers and Withdraw for the proposer's, a propose form (a `datetime-local` input read in the viewer's zone through `fromLocalInput`, plus a note) when a proposal may be made, and the proposal log. A rolling stage's room shows no panel.
13. **Errors.** New keys in `validate.ts`: `bad_schedule`, `schedule_locked`, `not_schedulable`, `bad_time`, `proposal_open`, `no_proposal`, `own_proposal`, `not_your_proposal`.
14. **Audit.** `admin_actions`: `event_schedule_set` (stage, rounds), `event_match_time` (match, time). Every schedule mutation's own `event_log` row: `schedule_set`, `schedule_applied`, `reschedule_proposed`, `reschedule_accepted`, `reschedule_declined`, `reschedule_countered`, `reschedule_withdrawn`, `reschedule_auto_accepted`, `reschedule_reminded`, `reschedule_expired`, `match_time_set`.

## Not in this plan (and why)

- **Discord channel posts for round pairings and locked times, and match cards:** rollout plan 5 (the foundation's notification module and `DiscordSync`). DMs only here.
- **A booking row made at the agreed time.** Ruling 5: the box would be set up with no game to push; capacity is kept back by counting instead. If a real event shows PUGs still squeezing scheduled matches out, the follow-up is a placeholder booking state, not a change to this plan's rules.
- **Per-match windows set by staff.** Staff set a time (Ruling 10) or the round's window; a one-off window for one match is not offered.
- **Rescheduling a match whose room is already open.** Once the room opened the T3a timers run; staff reset the room (it reopens at once, Ruling 9) and set a new time.
- **Time zone preferences per player.** The site uses the browser's zone and Discord renders its own; a stored preference is a later nicety.
- **Changing `not_before` on a bracket round once its rooms opened.** `applySchedule` restamps pending and waiting matches only.

## Review Focus

- **The window end can never forfeit the wrong side.** `silentSide` names a side only when it made no proposal and answered none while the other made at least one; an expired or countered proposal counts as an action for both. Task 3 tests every combination, Task 4 the clock's forfeit through `forfeitMatch` with `expect` on `waiting`.
- **Auto-accept and a human answer racing.** `autoAccept` re-reads the proposal inside its transaction and refuses `changed` unless it is still `open` with a future time and a `waiting` match; a captain's accept or decline a tick earlier wins. Task 3 tests the refusal.
- **A restamp never loses an agreed time.** `applySchedule` writes `scheduled_at` only where `schedule_source` is null or `default`; Task 2 tests a league match with an agreed time keeping it through a schedule save that moves the round default.
- **Capacity counting never double counts a booked match.** `scheduledMatchSlots` requires `booking_id IS NULL`; once the engine books, the booking row counts itself. Task 5 tests the hand-over and the region filter.
- **The schedule guard holds.** `schedule.ts` joins the `event_matches` writer list and gets its own one-row guard over every exported mutation; a mutation added later without a `SCHEDULE_MUTATIONS` entry fails the "every exported function is a known read or a guarded mutation" test.

---

## File map

| File | Responsibility |
|---|---|
| `src/db.ts` | `event_reschedules` table; `event_stages.schedule_json`; `event_matches.schedule_source`; the two settings' defaults. |
| `src/settingsSchema.ts` | `reschedule_autoaccept_hours`, `event_window_lead_minutes`. |
| `src/events/validate.ts` | `RoundSchedule`, `parseRoundSchedule`; new error keys. |
| `src/events/league.ts` | `weekWindow`, `weeklyRoundTimes`, `WeeklySlot` (pure, shared with the web). |
| `src/events/events.ts` | `StageRow.schedule_json`, `scheduleOf`, `setRoundSchedule`. |
| `src/events/play.ts` | `MatchRow.schedule_source`; `roundTimes`; stamping in `insertRound` and `syncBracket`; `applySchedule`. |
| `src/events/schedule.ts` (new) | Proposals: `scheduleRules`, `proposalsOf`, `openProposal`, `autoAcceptAt`, `reminderAt`, `silentSide`, `proposeTime`, `respondProposal`, `counterProposal`, `withdrawProposal`, `staffSetTime`, `autoAcceptDue`, `autoAccept`, `remindersDue`, `noteReminded`, `staleProposals`, `expireProposal`, `expiredWindows`. |
| `src/events/room.ts` | `HOLDABLE` gains `waiting`; `releaseHold` to `waiting`. |
| `src/events/roomClock.ts` | `dueWindowRooms`; the `schedule` pass (auto-accept, reminders, stale proposals, window ends). |
| `src/events/notices.ts`, `src/events/messages.ts`, `src/notify/notify.ts` | `tellReschedule`, `tellTimeLocked`; the two DM types; `why: 'window'` on the forfeit DM; `discordTime`. |
| `src/bookings/rules.ts` | `EVENT_SLOT_MINUTES`, `scheduledMatchSlots`; `capacityProblem` and `bookingsDue` count them. |
| `src/events/roomViews.ts`, `src/events/playViews.ts` | `MatchRoomView.schedule`; `PlayMatch.scheduledAt`, `PlayRound.defaultAt`/`window`; `PlayMatchDesk.schedule`. |
| `src/routes/events.ts` | `propose`, `respond`, `counter`, `withdraw`. |
| `src/routes/adminEvents.ts` | `AdminEventStage.schedule`/`roundsKnown`; the stage schedule route; `set-time`. |
| `tests/eventLogGuard.test.ts`, `tests/roomFixture.ts` | The schedule guard; `windowFixture`. |
| `web/src/api.ts`, `web/src/eventFormat.ts`, `web/src/routes/event/room/SchedulePanel.tsx` (new), `web/src/routes/EventMatch.tsx`, `web/src/routes/event/StagePlay.tsx`, `web/src/routes/event/Bracket.tsx`, `web/src/routes/admin/events/RoundScheduleForm.tsx` (new), `web/src/routes/admin/events/EventEditor.tsx`, `web/src/routes/admin/events/PlayPanel.tsx`, `web/src/styles/app.css` (and the six `MatchRoomView` test builders) | The Schedule panel, times on the event page, the Round schedule editor and Set time on the desk. |

---
### Task 1: Schema, settings, the schedule shape and the league helpers

**Files:**
- Modify: `src/db.ts`, `src/settingsSchema.ts`, `src/events/validate.ts`, `src/events/play.ts` (the `MatchRow` type only), `src/events/events.ts` (the `StageRow` type only), `src/events/league.ts`
- Test: `tests/eventsSchema.test.ts`, `tests/eventsValidate.test.ts`, `tests/league.test.ts`, `tests/adminSettings.test.ts` (parity, no edit)

**Interfaces:**
- Consumes: `ensureColumn`, `SCHEMA`, `DEFAULT_SETTINGS` (`src/db.ts`); `parseTime`, `isObj`, `isInt`, `ok`, `fail`, `Scheduling`, `EVENT_ERRORS` (`validate.ts`); `weekDates`, `weekOfRound`, `DAY`, `day` (`league.ts`, the last two file-private).
- Produces:
  - Table `event_reschedules (id, event_match_id, side, proposed_by, proposed_time, note, created_at, auto_accept_at, reminded_at, status, responded_by, responded_at)` with a unique partial index on `(event_match_id) WHERE status = 'open'`; `event_stages.schedule_json TEXT`; `event_matches.schedule_source TEXT CHECK (schedule_source IN ('default','agreed','staff'))`.
  - Settings `reschedule_autoaccept_hours` (`'24'`, int 1 to 72) and `event_window_lead_minutes` (`'20'`, int 5 to 60), seeded and in the schema's Competitive group.
  - `validate.ts`: `interface RoundSchedule { round: number; at: string | null; from: string | null; to: string | null }`; `SCHEDULE_ROUNDS_MAX = 60`; `parseRoundSchedule(raw: unknown, scheduling: Scheduling): Checked<RoundSchedule[]>`; error keys of Ruling 13.
  - `play.ts`: `MatchRow.schedule_source: 'default' | 'agreed' | 'staff' | null`; `events.ts`: `StageRow.schedule_json: string | null`.
  - `league.ts`: `interface WeeklySlot { day: number; time: string }` (day 0 Sunday to 6 Saturday, time `HH:MM` UTC); `weekWindow(seasonStart: string, round: number, perWeek: number): { from: string; to: string }` (ISO UTC); `weeklyRoundTimes(o: { seasonStart: string; matches: number; perWeek: number; slots: WeeklySlot[] }): { round: number; at: string | null; from: string; to: string }[]`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/eventsSchema.test.ts` (inside `describe('event schema')`; `event`, `stage`, `db`, `A` exist):

```ts
  it('holds one open reschedule proposal per match, with the statuses and the schedule columns of plan T4', () => {
    const id = event();
    stage(id, 1);
    const stageId = (db.prepare('SELECT id FROM event_stages WHERE event_id = ?').get(id) as { id: number }).id;
    const matchId = Number(db.prepare(
      "INSERT INTO event_matches (event_id, stage_id, round, slot, status, created_at) VALUES (?, ?, 1, 1, 'waiting', 'x')",
    ).run(id, stageId).lastInsertRowid);
    expect(db.prepare('SELECT schedule_source, scheduled_at, window_start, window_end FROM event_matches WHERE id = ?').get(matchId))
      .toEqual({ schedule_source: null, scheduled_at: null, window_start: null, window_end: null });
    expect(() => db.prepare("UPDATE event_matches SET schedule_source = 'guess' WHERE id = ?").run(matchId)).toThrow(/CHECK/);
    db.prepare("UPDATE event_matches SET schedule_source = 'agreed', scheduled_at = '2026-10-14T21:00:00.000Z' WHERE id = ?").run(matchId);
    db.prepare("UPDATE event_stages SET schedule_json = '[]' WHERE id = ?").run(stageId);
    const propose = db.prepare(
      "INSERT INTO event_reschedules (event_match_id, side, proposed_by, proposed_time, created_at) VALUES (?, 'a', ?, '2026-10-15T21:00:00.000Z', 'x')",
    );
    const first = Number(propose.run(matchId, A).lastInsertRowid);
    expect(db.prepare('SELECT status, note, auto_accept_at, reminded_at, responded_by, responded_at FROM event_reschedules WHERE id = ?').get(first))
      .toEqual({ status: 'open', note: '', auto_accept_at: null, reminded_at: null, responded_by: null, responded_at: null });
    expect(() => propose.run(matchId, A)).toThrow(/UNIQUE/);
    db.prepare("UPDATE event_reschedules SET status = 'countered' WHERE id = ?").run(first);
    propose.run(matchId, A);
    for (const s of ['accepted', 'auto_accepted', 'declined', 'withdrawn', 'expired']) db.prepare('UPDATE event_reschedules SET status = ? WHERE id = ?').run(s, first);
    expect(() => db.prepare("UPDATE event_reschedules SET status = 'maybe' WHERE id = ?").run(first)).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE event_reschedules SET side = 'c' WHERE id = ?").run(first)).toThrow(/CHECK/);
    expect(db.prepare("SELECT value FROM settings WHERE key = 'reschedule_autoaccept_hours'").get()).toEqual({ value: '24' });
    expect(db.prepare("SELECT value FROM settings WHERE key = 'event_window_lead_minutes'").get()).toEqual({ value: '20' });
  });
```

Append to `tests/eventsValidate.test.ts` (inside its top-level `describe`; `V` is the module import):

```ts
  it('reads a round schedule: UTC times, a window around the default on a window stage, a date only on a rolling one (plan T4)', () => {
    const rows = [
      { round: 2, at: '2026-10-21T21:00:00+00:00', from: '2026-10-19T00:00:00Z', to: '2026-10-25T23:59:59Z' },
      { round: 1, at: null, from: '2026-10-12T00:00:00Z', to: '2026-10-18T23:59:59Z' },
      { round: 3, at: null, from: null, to: null },
    ];
    expect(V.parseRoundSchedule(rows, 'window')).toEqual({ ok: true, value: [
      { round: 1, at: null, from: '2026-10-12T00:00:00.000Z', to: '2026-10-18T23:59:59.000Z' },
      { round: 2, at: '2026-10-21T21:00:00.000Z', from: '2026-10-19T00:00:00.000Z', to: '2026-10-25T23:59:59.000Z' },
    ] });
    expect(V.parseRoundSchedule([{ round: 1, at: '2026-10-24T21:00:00Z' }], 'rolling')).toEqual({ ok: true, value: [{ round: 1, at: '2026-10-24T21:00:00.000Z', from: null, to: null }] });
    expect(V.parseRoundSchedule([], 'window')).toEqual({ ok: true, value: [] });
    for (const bad of [
      'x', [{ round: 0, at: null }], [{ round: 1, at: '2026-10-24 21:00' }], [{ round: 1, at: '2026-10-24T21:00' }],
      [{ round: 1, at: null, from: '2026-10-12T00:00:00Z' }], [{ round: 1, at: null, from: '2026-10-18T00:00:00Z', to: '2026-10-12T00:00:00Z' }],
      [{ round: 1, at: '2026-10-26T21:00:00Z', from: '2026-10-12T00:00:00Z', to: '2026-10-18T23:59:59Z' }],
      [{ round: 1, at: null }, { round: 1, at: null }], Array.from({ length: V.SCHEDULE_ROUNDS_MAX + 1 }, (_, i) => ({ round: i + 1, at: null })),
    ]) expect(V.parseRoundSchedule(bad, 'window'), JSON.stringify(bad)).toEqual({ ok: false, error: 'bad_schedule' });
    expect(V.parseRoundSchedule([{ round: 1, at: '2026-10-24T21:00:00Z', from: '2026-10-19T00:00:00Z', to: '2026-10-25T23:59:59Z' }], 'rolling'))
      .toEqual({ ok: false, error: 'bad_schedule' });
    for (const k of ['bad_schedule', 'schedule_locked', 'not_schedulable', 'bad_time', 'proposal_open', 'no_proposal', 'own_proposal', 'not_your_proposal'] as const) {
      expect(V.EVENT_ERRORS[k].text.length).toBeGreaterThan(10);
    }
  });
```

Append to `tests/league.test.ts` (inside `describe('league season')`; extend the import line with `weekWindow, weeklyRoundTimes`):

```ts
  it('turns a week into a UTC window, and a weekly pattern into round times (plan T4)', () => {
    expect(weekWindow('2026-10-12', 1, 2)).toEqual({ from: '2026-10-12T00:00:00.000Z', to: '2026-10-18T23:59:59.000Z' });
    expect(weekWindow('2026-10-12', 3, 2)).toEqual({ from: '2026-10-19T00:00:00.000Z', to: '2026-10-25T23:59:59.000Z' });
    // Season start Monday Oct 12; match 1 of each week on Wednesday 21:00, match 2 on Sunday 19:30.
    const rows = weeklyRoundTimes({ seasonStart: '2026-10-12', matches: 3, perWeek: 2, slots: [{ day: 3, time: '21:00' }, { day: 0, time: '19:30' }] });
    expect(rows).toEqual([
      { round: 1, at: '2026-10-14T21:00:00.000Z', from: '2026-10-12T00:00:00.000Z', to: '2026-10-18T23:59:59.000Z' },
      { round: 2, at: '2026-10-18T19:30:00.000Z', from: '2026-10-12T00:00:00.000Z', to: '2026-10-18T23:59:59.000Z' },
      { round: 3, at: '2026-10-21T21:00:00.000Z', from: '2026-10-19T00:00:00.000Z', to: '2026-10-25T23:59:59.000Z' },
    ]);
    // A season starting on a Wednesday: the Wednesday slot is that very day; a missing or bad slot leaves the round with no default.
    expect(weeklyRoundTimes({ seasonStart: '2026-10-14', matches: 2, perWeek: 2, slots: [{ day: 3, time: '21:00' }] })).toEqual([
      { round: 1, at: '2026-10-14T21:00:00.000Z', from: '2026-10-14T00:00:00.000Z', to: '2026-10-20T23:59:59.000Z' },
      { round: 2, at: null, from: '2026-10-14T00:00:00.000Z', to: '2026-10-20T23:59:59.000Z' },
    ]);
    expect(weeklyRoundTimes({ seasonStart: '2026-10-12', matches: 1, perWeek: 1, slots: [{ day: 9, time: '21:00' }] })[0]!.at).toBeNull();
    expect(weeklyRoundTimes({ seasonStart: '2026-10-12', matches: 1, perWeek: 1, slots: [{ day: 1, time: '9pm' }] })[0]!.at).toBeNull();
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/eventsSchema.test.ts tests/eventsValidate.test.ts tests/league.test.ts`
Expected: FAIL (no `event_reschedules` table, no `schedule_source` column, `parseRoundSchedule` and the league helpers undefined, the settings unseeded).

- [ ] **Step 3: db.ts and settingsSchema.ts**

In `src/db.ts`, in `SCHEMA` right after the `event_campaign_prefs` table (before `match_players`):

```sql
-- Reschedule proposals (tournaments plan T4, spec section 5). Only
-- src/events/schedule.ts writes this table. One open proposal per match;
-- auto_accept_at is null when the proposal needs an answer (made less than
-- 48 hours before its time); reminded_at records the 24-hour DM.
CREATE TABLE IF NOT EXISTS event_reschedules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  event_match_id INTEGER NOT NULL REFERENCES event_matches(id),
  side           TEXT NOT NULL CHECK (side IN ('a','b')),
  proposed_by    TEXT NOT NULL REFERENCES players(steamid),
  proposed_time  TEXT NOT NULL,
  note           TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  auto_accept_at TEXT,
  reminded_at    TEXT,
  status         TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','accepted','auto_accepted','declined','countered','withdrawn','expired')),
  responded_by   TEXT,
  responded_at   TEXT
);
CREATE INDEX IF NOT EXISTS event_reschedules_match ON event_reschedules (event_match_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS event_reschedules_open ON event_reschedules (event_match_id) WHERE status = 'open';
```

In the migrations, after the three T3c `ensureColumn` lines on `event_matches`:

```ts
  // Tournaments plan T4: the per-round schedule of a stage (src/events/
  // validate.ts RoundSchedule rows, written by events.ts setRoundSchedule)
  // and where a match's scheduled_at came from: the round default, an
  // agreed proposal, or staff. The time columns themselves date from T2.
  ensureColumn(db, 'event_stages', 'schedule_json', 'TEXT');
  ensureColumn(db, 'event_matches', 'schedule_source', "TEXT CHECK (schedule_source IN ('default','agreed','staff'))");
```

In `DEFAULT_SETTINGS`, after `event_confirm_minutes: '15',`:

```ts
  // Tournaments plan T4: how long an unanswered reschedule proposal waits
  // before it locks (spec section 5), and how early a scheduled match's room opens.
  reschedule_autoaccept_hours: '24',
  event_window_lead_minutes: '20',
```

In `src/settingsSchema.ts`, after the `event_confirm_minutes` row:

```ts
  { key: 'reschedule_autoaccept_hours', group: 'Competitive', label: 'Reschedule proposal locks after (hours)', help: 'A proposed match time the other team does not answer locks on its own after this long, when it was made at least 48 hours before the proposed time. Captains are reminded 24 hours before it locks.', type: { kind: 'int', min: 1, max: 72 } },
  { key: 'event_window_lead_minutes', group: 'Competitive', label: 'Scheduled match room opens early (minutes)', help: 'How long before a scheduled tournament match time its room opens for the ready check, veto and lineups. The server is booked once the lineups lock.', type: { kind: 'int', min: 5, max: 60 } },
```

- [ ] **Step 4: validate.ts**

Add to `EVENT_ERRORS` after `bad_side`:

```ts
  bad_schedule: { status: 400, text: 'A round schedule lists rounds, each with a default time and, on a window stage, a window that starts before it ends and holds the default time; a rolling stage takes a date only.' },
  schedule_locked: { status: 409, text: 'The schedule of a finished stage or event cannot change.' },
  not_schedulable: { status: 409, text: 'This match cannot be rescheduled now: it is not waiting in a window stage with a scheduling window, or its window has passed.' },
  bad_time: { status: 400, text: 'A proposed time is a date and time inside the match window, at least an hour ahead, and not the time already set.' },
  proposal_open: { status: 409, text: 'A proposal is already open for this match. Answer it or withdraw it first.' },
  no_proposal: { status: 409, text: 'There is no open proposal for this match.' },
  own_proposal: { status: 409, text: 'The other team answers your proposal. You can withdraw it.' },
  not_your_proposal: { status: 409, text: 'Only the team that made the proposal can withdraw it.' },
```

After `StageSettings` add:

```ts
/** One round's schedule (plan T4 Ruling 2): the default time, and on a
 *  window stage the window it sits in; on a rolling stage a date only,
 *  stamped as the round's not_before (Ruling 3). ISO UTC strings. */
export interface RoundSchedule { round: number; at: string | null; from: string | null; to: string | null }
export const SCHEDULE_ROUNDS_MAX = 60;
```

After `parsePool` add:

```ts
/** A stage's round schedule as the desk sends it. A row with nothing set
 *  clears that round and is dropped; rounds come back sorted. */
export function parseRoundSchedule(raw: unknown, scheduling: Scheduling): Checked<RoundSchedule[]> {
  if (!Array.isArray(raw) || raw.length > SCHEDULE_ROUNDS_MAX) return fail('bad_schedule');
  const time = (v: unknown): string | null | undefined => (v === null || v === undefined ? null : parseTime(v) ?? undefined);
  const out: RoundSchedule[] = [];
  for (const row of raw) {
    if (!isObj(row) || !isInt(row.round, 1, 999) || out.some((r) => r.round === row.round)) return fail('bad_schedule');
    const at = time(row.at);
    const from = time(row.from);
    const to = time(row.to);
    if (at === undefined || from === undefined || to === undefined) return fail('bad_schedule');
    if (scheduling === 'rolling' && (from !== null || to !== null)) return fail('bad_schedule');
    if ((from === null) !== (to === null)) return fail('bad_schedule');
    if (from !== null && to !== null && (from >= to || (at !== null && (at < from || at > to)))) return fail('bad_schedule');
    if (at === null && from === null) continue;
    out.push({ round: row.round, at, from, to });
  }
  return ok(out.sort((x, y) => x.round - y.round));
}
```

(`row.round` is narrowed to `number` by `isInt`'s type guard.)

- [ ] **Step 5: The row types and league.ts**

In `src/events/play.ts` `MatchRow`, after the T3c line:

```ts
  /** Plan T4: where scheduled_at came from (the round default, an agreed proposal, staff); null with no time. */
  schedule_source: 'default' | 'agreed' | 'staff' | null;
```

In `src/events/events.ts` `StageRow`, after `finished_at: string | null;`:

```ts
  /** Plan T4: the per-round schedule (validate.ts RoundSchedule rows), or null. */
  schedule_json: string | null;
```

In `src/events/league.ts`, after `weekDates`:

```ts
/** A league week as a scheduling window (plan T4 Ruling 4): the first day's
 *  midnight to the last second of the last day, UTC. */
export function weekWindow(seasonStart: string, round: number, perWeek: number): { from: string; to: string } {
  const w = weekDates(seasonStart, weekOfRound(round, perWeek));
  return { from: `${w.from}T00:00:00.000Z`, to: `${w.to}T23:59:59.000Z` };
}

/** A weekly pattern: the k-th match of every week on this weekday (0 Sunday
 *  to 6 Saturday) at this UTC time. */
export interface WeeklySlot { day: number; time: string }

/** The desk's "fill from a weekly pattern" (plan T4 Ruling 2): one row per
 *  round, its window the week, its default time the slot's weekday on or
 *  after the week's first day. A missing or unreadable slot leaves the
 *  round with no default. */
export function weeklyRoundTimes(o: { seasonStart: string; matches: number; perWeek: number; slots: WeeklySlot[] }): { round: number; at: string | null; from: string; to: string }[] {
  const out: { round: number; at: string | null; from: string; to: string }[] = [];
  for (let round = 1; round <= o.matches; round++) {
    const w = weekWindow(o.seasonStart, round, o.perWeek);
    const slot = o.slots[(round - 1) % o.perWeek];
    let at: string | null = null;
    if (slot && Number.isInteger(slot.day) && slot.day >= 0 && slot.day <= 6 && /^([01]\d|2[0-3]):[0-5]\d$/.test(slot.time)) {
      const start = Date.parse(w.from);
      const offset = (slot.day - new Date(start).getUTCDay() + 7) % 7;
      at = new Date(start + offset * DAY + Number(slot.time.slice(0, 2)) * 3_600_000 + Number(slot.time.slice(3)) * 60_000).toISOString();
    }
    out.push({ round, at, from: w.from, to: w.to });
  }
  return out;
}
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/eventsSchema.test.ts tests/eventsValidate.test.ts tests/league.test.ts tests/adminSettings.test.ts && npm run typecheck`
Expected: PASS; both typechecks clean (the two new row fields are read by nothing yet).

- [ ] **Step 7: Commit**

```bash
git add src/db.ts src/settingsSchema.ts src/events/validate.ts src/events/play.ts src/events/events.ts src/events/league.ts tests/eventsSchema.test.ts tests/eventsValidate.test.ts tests/league.test.ts
git commit -m "Tournaments T4: the reschedule table, the schedule columns, the two settings, the round schedule shape and the league week helpers"
```

---
### Task 2: The stage schedule and its stamp on matches

**Files:**
- Modify: `src/events/events.ts`, `src/events/play.ts`
- Test: `tests/events.test.ts`, `tests/play.test.ts`, `tests/eventLogGuard.test.ts`

**Interfaces:**
- Consumes: `getEvent`, `getStage`, `ownStage`, `touch`, `logEvent`, `stageSettingsOf` (`events.ts`); `matchesOf`, `insertRound`, `syncBracket`, `openStage`, `iso` (`play.ts`); `parseRoundSchedule`, `RoundSchedule`, `StageConfigs` (`validate.ts`); `weekWindow` (`league.ts`); `bracketMatches` (`bracket.ts`).
- Produces:
  - `events.ts`: `scheduleOf(s: StageRow): V.RoundSchedule[]` (a read; `READS` in the guard); `setRoundSchedule(db, o: { eventId: number; stageId: number; by: string; rounds: unknown; now?: Date }): EventResult<StageRow>` (`schedule_set`; refused `schedule_locked` for a finished or cancelled event or a finished stage; `MUTATIONS` in the guard, run from `draft`).
  - `play.ts`: `roundTimes(stage: E.StageRow, round: number, fallbackStart: string): { at: string | null; from: string | null; to: string | null }` (a read; `PLAY_READS`); `insertRound` and `syncBracket` stamp new rows; `applySchedule(db, o: { stageId: number; by: string | null; now?: Date }): V.Checked<{ stamped: number }>` (`schedule_applied`; `PLAY_MUTATIONS`).

- [ ] **Step 1: Write the failing tests**

Append to `tests/events.test.ts` (inside its top-level `describe`; `eventFixture`, `ADMIN`, `NOW`, `E` exist; add `import { LEAGUE, playFixture } from './playFixture.js';` if the file lacks it):

```ts
  it('stores a round schedule on a stage at any status but finished or cancelled, sorted, and logs it (plan T4)', () => {
    const f = eventFixture('draft');
    const rows = [{ round: 2, at: '2026-10-21T21:00:00Z', from: '2026-10-19T00:00:00Z', to: '2026-10-25T23:59:59Z' }, { round: 1, at: '2026-10-14T21:00:00Z', from: '2026-10-12T00:00:00Z', to: '2026-10-18T23:59:59Z' }];
    f.db.prepare("UPDATE event_stages SET scheduling = 'window' WHERE id = ?").run(f.s1);
    const r = E.setRoundSchedule(f.db, { eventId: f.eventId, stageId: f.s1, by: ADMIN, rounds: rows, now: NOW });
    expect(r.ok).toBe(true);
    expect(E.scheduleOf(E.getStage(f.db, f.s1)!).map((x) => x.round)).toEqual([1, 2]);
    expect(f.db.prepare('SELECT action, actor, detail FROM event_log ORDER BY id DESC LIMIT 1').get()).toMatchObject({ action: 'schedule_set', actor: ADMIN });
    expect(E.setRoundSchedule(f.db, { eventId: f.eventId, stageId: f.s2, by: ADMIN, rounds: rows, now: NOW })).toEqual({ ok: false, error: 'bad_schedule' });
    expect(E.setRoundSchedule(f.db, { eventId: f.eventId, stageId: f.s2, by: ADMIN, rounds: [{ round: 1, at: '2026-10-24T21:00:00Z' }], now: NOW }).ok).toBe(true);
    expect(E.setRoundSchedule(f.db, { eventId: f.eventId, stageId: 999, by: ADMIN, rounds: [], now: NOW })).toEqual({ ok: false, error: 'stage_not_found' });
    f.db.prepare("UPDATE event_stages SET status = 'finished' WHERE id = ?").run(f.s1);
    expect(E.setRoundSchedule(f.db, { eventId: f.eventId, stageId: f.s1, by: ADMIN, rounds: [], now: NOW })).toEqual({ ok: false, error: 'schedule_locked' });
    f.db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(f.eventId);
    expect(E.setRoundSchedule(f.db, { eventId: f.eventId, stageId: f.s2, by: ADMIN, rounds: [], now: NOW })).toEqual({ ok: false, error: 'schedule_locked' });
  });
```

Append to `tests/play.test.ts` (inside its top-level `describe`; `playFixture`, `SE`, `SWISS`, `LEAGUE`, `ADMIN`, `NOW`, `P`, `E`, `startEventFlow` are imported there, add `LEAGUE` and `E` if missing):

```ts
  it('stamps a league round with its week as the window and the schedule row as the default time, keeping an agreed time through a restamp (plan T4)', async () => {
    const f = playFixture({ stages: [LEAGUE(4, 2, 'round_robin', null, '2026-10-12')], entries: 4 });
    await startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW });
    const ms = P.matchesOf(f.db, f.stages[0]!);
    expect(ms.filter((m) => m.round === 1).map((m) => [m.scheduled_at, m.schedule_source, m.window_start, m.window_end, m.not_before]))
      .toEqual([[null, null, '2026-10-12T00:00:00.000Z', '2026-10-18T23:59:59.000Z', null], [null, null, '2026-10-12T00:00:00.000Z', '2026-10-18T23:59:59.000Z', null]]);
    expect(ms.find((m) => m.round === 3)).toMatchObject({ window_start: '2026-10-19T00:00:00.000Z', window_end: '2026-10-25T23:59:59.000Z' });
    const rows = [{ round: 1, at: '2026-10-14T21:00:00Z', from: '2026-10-12T00:00:00Z', to: '2026-10-18T23:59:59Z' }, { round: 2, at: '2026-10-17T21:00:00Z', from: '2026-10-12T00:00:00Z', to: '2026-10-18T23:59:59Z' }];
    expect(E.setRoundSchedule(f.db, { eventId: f.eventId, stageId: f.stages[0]!, by: ADMIN, rounds: rows, now: NOW }).ok).toBe(true);
    const first = ms.find((m) => m.round === 1)!;
    // A captain agreed another time for one match before the organizer moved the default (test setup only: schedule.ts writes this in Task 3).
    f.db.prepare("UPDATE event_matches SET scheduled_at = '2026-10-16T20:00:00.000Z', schedule_source = 'agreed' WHERE id = ?").run(first.id);
    const r = P.applySchedule(f.db, { stageId: f.stages[0]!, by: ADMIN, now: NOW });
    expect(r).toEqual({ ok: true, value: { stamped: 8 } });
    const after = P.matchesOf(f.db, f.stages[0]!);
    expect(after.find((m) => m.id === first.id)).toMatchObject({ scheduled_at: '2026-10-16T20:00:00.000Z', schedule_source: 'agreed' });
    expect(after.filter((m) => m.round === 1 && m.id !== first.id).map((m) => [m.scheduled_at, m.schedule_source])).toEqual([['2026-10-14T21:00:00.000Z', 'default']]);
    expect(after.filter((m) => m.round === 2).map((m) => m.scheduled_at)).toEqual(['2026-10-17T21:00:00.000Z', '2026-10-17T21:00:00.000Z']);
    expect(after.filter((m) => m.round === 3).map((m) => m.scheduled_at)).toEqual([null, null]);
    expect(f.db.prepare('SELECT action, detail FROM event_log ORDER BY id DESC LIMIT 1').get()).toMatchObject({ action: 'schedule_applied' });
  });

  it('stamps a rolling bracket round\'s date as not_before and never a window (plan T4 Ruling 3)', async () => {
    const f = playFixture({ stages: [SE()], entries: 4 });
    expect(E.setRoundSchedule(f.db, { eventId: f.eventId, stageId: f.stages[0]!, by: ADMIN, rounds: [{ round: 2, at: '2026-10-24T21:00:00Z' }], now: NOW }).ok).toBe(true);
    await startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW });
    const ms = P.matchesOf(f.db, f.stages[0]!);
    expect(ms.filter((m) => m.round === 1).every((m) => m.not_before === null && m.scheduled_at === null && m.window_start === null)).toBe(true);
    expect(ms.find((m) => m.round === 2)).toMatchObject({ not_before: '2026-10-24T21:00:00.000Z', scheduled_at: null, window_start: null, window_end: null, schedule_source: null });
    expect(P.roundTimes(E.getStage(f.db, f.stages[0]!)!, 2, NOW.toISOString())).toEqual({ at: '2026-10-24T21:00:00.000Z', from: null, to: null });
    expect(P.applySchedule(f.db, { stageId: 999, by: ADMIN, now: NOW })).toEqual({ ok: false, error: 'stage_not_found' });
  });
```

In `tests/eventLogGuard.test.ts`: add `'scheduleOf'` to `READS`; add to `MUTATIONS`:

```ts
  setRoundSchedule: {
    from: 'draft', action: 'schedule_set',
    run: ({ db, eventId, s2 }) => E.setRoundSchedule(db, { eventId, stageId: s2, by: ADMIN, rounds: [{ round: 1, at: START }], now: NOW }),
  },
```

(`s2` is the single-elimination stage, rolling, so a date-only row is valid.) In the play guard: add `'roundTimes'` to `PLAY_READS` and to `PLAY_MUTATIONS`:

```ts
      applySchedule: {
        action: 'schedule_applied', actor: ADMIN, setup: started,
        run: (f) => P.applySchedule(f.db, { stageId: f.stages[0]!, by: ADMIN, now: NOW }),
      },
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/events.test.ts tests/play.test.ts tests/eventLogGuard.test.ts`
Expected: FAIL (`setRoundSchedule`, `scheduleOf`, `roundTimes`, `applySchedule` undefined; the guard's "every exported function" lists disagree).

- [ ] **Step 3: events.ts**

After `stageSettingsOf` add:

```ts
/** The per-round schedule (plan T4 Ruling 2), empty when none was set. */
export function scheduleOf(s: StageRow): V.RoundSchedule[] {
  return s.schedule_json ? JSON.parse(s.schedule_json) as V.RoundSchedule[] : [];
}
```

After `reorderStages` add:

```ts
/** A schedule may change while the event runs (a league's later weeks, a
 *  Swiss round paired later), so this is not behind STAGES_LOCKED: only a
 *  finished or cancelled event, or a finished stage, refuses it. The rows
 *  are stamped onto matches by src/events/play.ts (insertRound for rounds
 *  written later, applySchedule for the ones that exist). */
const SCHEDULE_LOCKED: ReadonlySet<V.EventStatus> = new Set<V.EventStatus>(['finished', 'cancelled']);

export function setRoundSchedule(db: DB, o: { eventId: number; stageId: number; by: string; rounds: unknown; now?: Date }): EventResult<StageRow> {
  const at = iso(o.now);
  return db.transaction((): EventResult<StageRow> => {
    const ev = getEvent(db, o.eventId);
    if (!ev) return V.fail('not_found');
    if (SCHEDULE_LOCKED.has(ev.status)) return V.fail('schedule_locked');
    const s = ownStage(db, ev.id, o.stageId);
    if (!s) return V.fail('stage_not_found');
    if (s.status === 'finished') return V.fail('schedule_locked');
    const p = V.parseRoundSchedule(o.rounds, s.scheduling);
    if (!p.ok) return p;
    db.prepare('UPDATE event_stages SET schedule_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(p.value), at, s.id);
    touch(db, ev.id, at);
    logEvent(db, ev.id, o.by, 'schedule_set', at, { stageId: s.id, ordinal: s.ordinal, rounds: p.value.map((r) => r.round) });
    return V.ok(getStage(db, s.id)!);
  })();
}
```

- [ ] **Step 4: play.ts**

Add `import { weekWindow } from './league.js';`. After `totalRounds` add:

```ts
/** What a round's matches are stamped with (plan T4 Ruling 2): the stage's
 *  schedule row; else, for a league, its week as the window with no
 *  default time (Ruling 4); else nothing. fallbackStart is the day week 1
 *  starts when the league has no season start and the stage no started_at
 *  yet (openStage writes started_at before it inserts rounds). */
export function roundTimes(stage: E.StageRow, round: number, fallbackStart: string): { at: string | null; from: string | null; to: string | null } {
  const row = E.scheduleOf(stage).find((r) => r.round === round);
  if (row) return { at: row.at, from: row.from, to: row.to };
  const s = E.stageSettingsOf(stage);
  if (s.type !== 'league') return { at: null, from: null, to: null };
  const c = s.config as V.StageConfigs['league'];
  const w = weekWindow(c.seasonStart ?? (stage.started_at ?? fallbackStart).slice(0, 10), round, c.matchesPerWeek);
  return { at: null, from: w.from, to: w.to };
}

interface Stamp { not_before: string | null; scheduled_at: string | null; source: 'default' | null; from: string | null; to: string | null }

/** A window stage's match carries the default time and the window; a
 *  rolling stage's match carries the date as not_before (Ruling 3). */
function stampOf(db: DB, stageId: number, round: number, at: string): Stamp {
  const stage = E.getStage(db, stageId)!;
  const t = roundTimes(stage, round, at);
  return stage.scheduling === 'window'
    ? { not_before: null, scheduled_at: t.at, source: t.at !== null ? 'default' : null, from: t.from, to: t.to }
    : { not_before: t.at, scheduled_at: null, source: null, from: null, to: null };
}
```

Replace `insertRound` with:

```ts
function insertRound(db: DB, eventId: number, stageId: number, r: NewRound, at: string): void {
  const ins = db.prepare(
    `INSERT INTO event_matches (event_id, stage_id, grp, round, slot, entry_a, entry_b, status, winner_entry, created_at, finished_at,
       not_before, scheduled_at, schedule_source, window_start, window_end)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const s = stampOf(db, stageId, r.round, at);
  r.pairs.forEach(([a, b], i) => ins.run(eventId, stageId, r.round, i + 1, a, b, 'waiting', null, at, null, s.not_before, s.scheduled_at, s.source, s.from, s.to));
  if (r.bye !== null) ins.run(eventId, stageId, r.round, r.pairs.length + 1, r.bye, null, 'bye', r.bye, at, at, s.not_before, s.scheduled_at, s.source, s.from, s.to);
}
```

In `syncBracket`, the insert becomes

```ts
  const ins = db.prepare(
    `INSERT INTO event_matches (event_id, stage_id, grp, round, slot, bm_match_id, entry_a, entry_b, status, winner_entry, score_a, score_b, created_at, finished_at,
       not_before, scheduled_at, schedule_source, window_start, window_end)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
```

and its `ins.run(...)` call in the `if (!row)` branch:

```ts
      const s = stampOf(db, stageId, b.round, at);
      ins.run(eventId, stageId, b.group, b.round, b.number, b.bmId, b.a, b.b, status, b.winner, b.scoreA, b.scoreB, at, resolved ? at : null,
        s.not_before, s.scheduled_at, s.source, s.from, s.to);
```

(The `upd` of existing rows is unchanged: a bracket sync never touches times.) After `finishStage` add:

```ts
/** Plan T4 Ruling 2: the stage's schedule, stamped again onto every match
 *  that has not started (pending or waiting). The window and not_before
 *  are the organizer's and always follow the schedule; a time a captain
 *  agreed or staff set (schedule_source agreed or staff) is kept. by is
 *  null when the engine calls it. */
export function applySchedule(db: DB, o: { stageId: number; by: string | null; now?: Date }): V.Checked<{ stamped: number }> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<{ stamped: number }> => {
    const stage = E.getStage(db, o.stageId);
    if (!stage) return V.fail('stage_not_found');
    if (stage.status === 'finished') return V.fail('schedule_locked');
    const upd = db.prepare(
      `UPDATE event_matches SET not_before = ?, window_start = ?, window_end = ?,
         scheduled_at = CASE WHEN schedule_source IN ('agreed', 'staff') THEN scheduled_at ELSE ? END,
         schedule_source = CASE WHEN schedule_source IN ('agreed', 'staff') THEN schedule_source ELSE ? END
       WHERE id = ?`,
    );
    let stamped = 0;
    for (const m of matchesOf(db, stage.id)) {
      if (m.status !== 'pending' && m.status !== 'waiting') continue;
      const s = stampOf(db, stage.id, m.round, at);
      upd.run(s.not_before, s.from, s.to, s.scheduled_at, s.source, m.id);
      stamped++;
    }
    E.logEvent(db, stage.event_id, o.by, 'schedule_applied', at, { stageId: stage.id, stamped });
    return V.ok({ stamped });
  })();
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/events.test.ts tests/play.test.ts tests/eventLogGuard.test.ts tests/eventFlow.test.ts tests/roomClock.test.ts && npm run typecheck`
Expected: PASS (the T2 flow tests still pass: a Swiss or bracket stage with no schedule stamps nulls, a league stage gets its week windows, which nothing reads yet).

- [ ] **Step 6: Commit**

```bash
git add src/events/events.ts src/events/play.ts tests/events.test.ts tests/play.test.ts tests/eventLogGuard.test.ts
git commit -m "Tournaments T4: a stage carries a per-round schedule that the desk may set while the event runs, stamped onto matches as the default time and window (a league week by default) or as a bracket round's not_before"
```

---
### Task 3: Proposals: `src/events/schedule.ts`, the hold from waiting, and the guard

**Files:**
- Create: `src/events/schedule.ts`
- Modify: `src/events/room.ts`, `tests/roomFixture.ts`, `tests/eventLogGuard.test.ts`
- Test: `tests/schedule.test.ts` (new), `tests/room.test.ts`

**Interfaces:**
- Consumes: `settingNumber` (`settings.ts`); `getEvent`, `getStage`, `logEvent` (`events.ts`); `getEntry`, `isActive` (`entries.ts`); `getMatch`, `MatchRow` (`play.ts`); `sideOf` (`room.ts`); `parseTime`, `normalizeReason`, `ok`, `fail`, `Checked` (`validate.ts`); `Side`, `other` (`veto.ts`); `ROOM_LIVE_SQL` (`room.ts`).
- Produces (`schedule.ts`):
  - `type RescheduleStatus = 'open' | 'accepted' | 'auto_accepted' | 'declined' | 'countered' | 'withdrawn' | 'expired'`; `interface RescheduleRow { id; event_match_id; side: Side; proposed_by; proposed_time; note; created_at; auto_accept_at: string | null; reminded_at: string | null; status: RescheduleStatus; responded_by: string | null; responded_at: string | null }`; `interface ScheduleRules { autoAcceptHours: number; leadMinutes: number }`.
  - Constants `AUTO_ACCEPT_MIN_AHEAD_MS = 48 h`, `PROPOSE_MIN_AHEAD_MS = 1 h`, `REMINDER_BEFORE_MS = 24 h`, `REMINDER_MIN_GAP_MS = 1 h`.
  - Reads: `scheduleRules(db)`, `proposalsOf(db, matchId)`, `openProposal(db, matchId)`, `getProposal(db, id)`, `autoAcceptAt(createdMs, proposedMs, hours): string | null`, `reminderAt(createdMs, autoAcceptIso): string | null`, `silentSide(db, m): Side | null`, `autoAcceptDue(db, now): RescheduleRow[]`, `remindersDue(db, now): RescheduleRow[]`, `staleProposals(db, now): RescheduleRow[]`, `expiredWindows(db, now): P.MatchRow[]`.
  - Mutations, each one `event_log` row: `proposeTime(db, { matchId, by, time, note?, rules, now? }): Checked<RescheduleRow>` (`reschedule_proposed`); `respondProposal(db, { matchId, by, accept, now? }): Checked<{ m: MatchRow; proposal: RescheduleRow }>` (`reschedule_accepted` or `reschedule_declined`); `counterProposal(db, { matchId, by, time, note?, rules, now? }): Checked<RescheduleRow>` (`reschedule_countered`); `withdrawProposal(db, { matchId, by, now? }): Checked<RescheduleRow>` (`reschedule_withdrawn`); `staffSetTime(db, { matchId, by, time, now? }): Checked<MatchRow>` (`match_time_set`); `autoAccept(db, { proposalId, now? }): Checked<MatchRow>` (`reschedule_auto_accepted`, actor null); `noteReminded(db, { proposalId, now? }): Checked<RescheduleRow>` (`reschedule_reminded`, actor null); `expireProposal(db, { proposalId, reason: 'time_passed' | 'window_ended'; now? }): Checked<RescheduleRow>` (`reschedule_expired`, actor null).
  - `room.ts`: `HOLDABLE` gains `waiting`; `releaseHold` sends a `waiting` hold back with no deadline.
  - `tests/roomFixture.ts`: `windowFixture(o?: Parameters<typeof roomFixture>[0] & { from?: Date; to?: Date }): Promise<RoomFixture>`: a `roomFixture` whose stage is `window` and whose match carries the window `NOW` to `NOW + 7 days` (or the given ends), both `scheduled_at` and `schedule_source` null.

- [ ] **Step 1: The fixture**

Append to `tests/roomFixture.ts`:

```ts
/** The same room in a window stage (plan T4): the match waits with a
 *  window of a week from NOW and no time yet, so captains may propose. */
export async function windowFixture(o: Parameters<typeof roomFixture>[0] & { from?: Date; to?: Date } = {}): Promise<RoomFixture> {
  const f = await roomFixture(o);
  const from = o.from ?? o.now ?? NOW;
  const to = o.to ?? new Date(from.getTime() + 7 * 86_400_000);
  f.db.prepare("UPDATE event_stages SET scheduling = 'window' WHERE id = ?").run(f.stageId);
  f.db.prepare('UPDATE event_matches SET window_start = ?, window_end = ? WHERE stage_id = ?').run(from.toISOString(), to.toISOString(), f.stageId);
  return f;
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/schedule.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as P from '../src/events/play.js';
import * as R from '../src/events/room.js';
import * as S from '../src/events/schedule.js';
import { ADMIN, NOW } from './eventFixture.js';
import { A, B, OUTSIDER } from './entryFixture.js';
import { TIMERS, windowFixture, type RoomFixture } from './roomFixture.js';

const H = 3_600_000;
const at = (hours: number) => new Date(NOW.getTime() + hours * H);
const RULES: S.ScheduleRules = { autoAcceptHours: 24, leadMinutes: 20 };
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value; };
const match = (f: RoomFixture) => P.getMatch(f.db, f.matchId)!;
const last = (f: RoomFixture) => f.db.prepare('SELECT action, actor FROM event_log ORDER BY id DESC LIMIT 1').get() as { action: string; actor: string | null };
const propose = (f: RoomFixture, by: string, hours: number, now = NOW) => S.proposeTime(f.db, { matchId: f.matchId, by, time: at(hours).toISOString(), rules: RULES, now });

describe('autoAcceptAt and reminderAt', () => {
  it('locks only a proposal made at least 48 h before its time, and reminds 24 h before the lock when that is an hour or more after the proposal', () => {
    expect(S.autoAcceptAt(NOW.getTime(), at(48).getTime(), 24)).toBe(at(24).toISOString());
    expect(S.autoAcceptAt(NOW.getTime(), at(47).getTime(), 24)).toBeNull();
    expect(S.autoAcceptAt(NOW.getTime(), at(100).getTime(), 6)).toBe(at(6).toISOString());
    expect(S.reminderAt(NOW.getTime(), at(24).toISOString())).toBeNull();
    expect(S.reminderAt(NOW.getTime(), at(25).toISOString())).toBe(at(1).toISOString());
    expect(S.reminderAt(NOW.getTime(), at(72).toISOString())).toBe(at(48).toISOString());
    expect(S.reminderAt(NOW.getTime(), null)).toBeNull();
  });
});

describe('proposeTime', () => {
  it('opens one proposal from a manager inside the window, at least an hour ahead, with the lock time, and logs it', async () => {
    const f = await windowFixture();
    const p = ok(propose(f, A[0]!, 72));
    expect(p).toMatchObject({ event_match_id: f.matchId, side: 'a', proposed_by: A[0], proposed_time: at(72).toISOString(), status: 'open', auto_accept_at: at(24).toISOString(), note: '' });
    expect(last(f)).toEqual({ action: 'reschedule_proposed', actor: A[0] });
    expect(match(f).scheduled_at).toBeNull();
    expect(propose(f, B[0]!, 50)).toEqual({ ok: false, error: 'proposal_open' });
  });

  it('refuses a non-manager, a time outside the window or too soon, the time already set, a bad note, and a match that is not waiting in a window stage', async () => {
    const f = await windowFixture();
    expect(propose(f, OUTSIDER, 72)).toEqual({ ok: false, error: 'not_manager' });
    expect(propose(f, A[3]!, 72)).toEqual({ ok: false, error: 'not_manager' });
    expect(propose(f, A[0]!, 0.5)).toEqual({ ok: false, error: 'bad_time' });
    expect(propose(f, A[0]!, 24 * 8)).toEqual({ ok: false, error: 'bad_time' });
    expect(S.proposeTime(f.db, { matchId: f.matchId, by: A[0]!, time: 'tomorrow', rules: RULES, now: NOW })).toEqual({ ok: false, error: 'bad_time' });
    f.db.prepare("UPDATE event_matches SET scheduled_at = ?, schedule_source = 'default' WHERE id = ?").run(at(72).toISOString(), f.matchId);
    expect(propose(f, A[0]!, 72)).toEqual({ ok: false, error: 'bad_time' });
    expect(S.proposeTime(f.db, { matchId: f.matchId, by: A[0]!, time: at(50).toISOString(), note: 'x'.repeat(301), rules: RULES, now: NOW })).toEqual({ ok: false, error: 'bad_reason' });
    const p = ok(S.proposeTime(f.db, { matchId: f.matchId, by: A[0]!, time: at(50).toISOString(), note: '  after  work ', rules: RULES, now: NOW }));
    expect(p.note).toBe('after work');
    ok(S.withdrawProposal(f.db, { matchId: f.matchId, by: A[1]!, now: NOW }));
    R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS, now: NOW });
    expect(propose(f, A[0]!, 50)).toEqual({ ok: false, error: 'not_schedulable' });
    const g = await windowFixture();
    g.db.prepare("UPDATE event_stages SET scheduling = 'rolling' WHERE id = ?").run(g.stageId);
    expect(propose(g, A[0]!, 50)).toEqual({ ok: false, error: 'not_schedulable' });
    g.db.prepare("UPDATE event_stages SET scheduling = 'window' WHERE id = ?").run(g.stageId);
    g.db.prepare('UPDATE event_matches SET window_start = NULL, window_end = NULL WHERE id = ?').run(g.matchId);
    expect(propose(g, A[0]!, 50)).toEqual({ ok: false, error: 'not_schedulable' });
    const h = await windowFixture({ to: at(1) });
    expect(propose(h, A[0]!, 0.9, at(2))).toEqual({ ok: false, error: 'not_schedulable' });
  });
});

describe('respondProposal, counterProposal, withdrawProposal', () => {
  it('the other side accepts: the time locks as agreed; or declines: nothing changes', async () => {
    const f = await windowFixture();
    ok(propose(f, A[0]!, 72));
    expect(S.respondProposal(f.db, { matchId: f.matchId, by: A[1]!, accept: true, now: at(1) })).toEqual({ ok: false, error: 'own_proposal' });
    expect(S.respondProposal(f.db, { matchId: f.matchId, by: OUTSIDER, accept: true, now: at(1) })).toEqual({ ok: false, error: 'not_manager' });
    const r = ok(S.respondProposal(f.db, { matchId: f.matchId, by: B[0]!, accept: true, now: at(1) }));
    expect(r.m).toMatchObject({ scheduled_at: at(72).toISOString(), schedule_source: 'agreed', status: 'waiting' });
    expect(r.proposal).toMatchObject({ status: 'accepted', responded_by: B[0], responded_at: at(1).toISOString() });
    expect(last(f)).toEqual({ action: 'reschedule_accepted', actor: B[0] });
    expect(S.respondProposal(f.db, { matchId: f.matchId, by: B[0]!, accept: true, now: at(1) })).toEqual({ ok: false, error: 'no_proposal' });
    ok(propose(f, B[0]!, 96, at(2)));
    const d = ok(S.respondProposal(f.db, { matchId: f.matchId, by: A[0]!, accept: false, now: at(3) }));
    expect(d.proposal.status).toBe('declined');
    expect(match(f).scheduled_at).toBe(at(72).toISOString());
    expect(last(f)).toEqual({ action: 'reschedule_declined', actor: A[0] });
  });

  it('a counter closes the open proposal and opens the other side\'s in one row; a withdrawal is the proposer\'s alone', async () => {
    const f = await windowFixture();
    const first = ok(propose(f, A[0]!, 72));
    expect(S.counterProposal(f.db, { matchId: f.matchId, by: A[0]!, time: at(80).toISOString(), rules: RULES, now: at(1) })).toEqual({ ok: false, error: 'own_proposal' });
    const logs = (f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }).n;
    const c = ok(S.counterProposal(f.db, { matchId: f.matchId, by: B[0]!, time: at(80).toISOString(), rules: RULES, now: at(1) }));
    expect(c).toMatchObject({ side: 'b', proposed_time: at(80).toISOString(), status: 'open', auto_accept_at: at(25).toISOString() });
    expect(S.getProposal(f.db, first.id)).toMatchObject({ status: 'countered', responded_by: B[0] });
    expect((f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }).n).toBe(logs + 1);
    expect(last(f)).toEqual({ action: 'reschedule_countered', actor: B[0] });
    expect(S.withdrawProposal(f.db, { matchId: f.matchId, by: A[0]!, now: at(2) })).toEqual({ ok: false, error: 'not_your_proposal' });
    const w = ok(S.withdrawProposal(f.db, { matchId: f.matchId, by: B[0]!, now: at(2) }));
    expect(w.status).toBe('withdrawn');
    expect(S.openProposal(f.db, f.matchId)).toBeUndefined();
    expect(S.withdrawProposal(f.db, { matchId: f.matchId, by: B[0]!, now: at(2) })).toEqual({ ok: false, error: 'no_proposal' });
    expect(S.proposalsOf(f.db, f.matchId).map((p) => p.status)).toEqual(['countered', 'withdrawn']);
  });
});

describe('the clock\'s proposals', () => {
  it('auto-accepts a due proposal once, refusing one already answered or whose time passed', async () => {
    const f = await windowFixture();
    const p = ok(propose(f, A[0]!, 72));
    expect(S.autoAcceptDue(f.db, at(23))).toEqual([]);
    expect(S.autoAcceptDue(f.db, at(24)).map((x) => x.id)).toEqual([p.id]);
    const r = ok(S.autoAccept(f.db, { proposalId: p.id, now: at(24) }));
    expect(r).toMatchObject({ scheduled_at: at(72).toISOString(), schedule_source: 'agreed' });
    expect(last(f)).toEqual({ action: 'reschedule_auto_accepted', actor: null });
    expect(S.getProposal(f.db, p.id)).toMatchObject({ status: 'auto_accepted', responded_by: null, responded_at: at(24).toISOString() });
    expect(S.autoAccept(f.db, { proposalId: p.id, now: at(24) })).toEqual({ ok: false, error: 'changed' });
    const q = ok(propose(f, B[0]!, 100, at(25)));
    expect(S.autoAccept(f.db, { proposalId: q.id, now: at(101) })).toEqual({ ok: false, error: 'changed' });
    const short = await windowFixture();
    const s = ok(propose(short, A[0]!, 30));
    expect(s.auto_accept_at).toBeNull();
    expect(S.autoAcceptDue(short.db, at(200))).toEqual([]);
  });

  it('reminds once, 24 h before the lock, and expires a proposal whose time passed', async () => {
    const f = await windowFixture();
    const p = ok(S.proposeTime(f.db, { matchId: f.matchId, by: A[0]!, time: at(100).toISOString(), rules: { autoAcceptHours: 48, leadMinutes: 20 }, now: NOW }));
    expect(p.auto_accept_at).toBe(at(48).toISOString());
    expect(S.remindersDue(f.db, at(23))).toEqual([]);
    expect(S.remindersDue(f.db, at(24)).map((x) => x.id)).toEqual([p.id]);
    ok(S.noteReminded(f.db, { proposalId: p.id, now: at(24) }));
    expect(last(f)).toEqual({ action: 'reschedule_reminded', actor: null });
    expect(S.remindersDue(f.db, at(25))).toEqual([]);
    expect(S.noteReminded(f.db, { proposalId: p.id, now: at(24) })).toEqual({ ok: false, error: 'changed' });
    const g = await windowFixture();
    const q = ok(propose(g, A[0]!, 30));
    expect(S.staleProposals(g.db, at(29))).toEqual([]);
    expect(S.staleProposals(g.db, at(30)).map((x) => x.id)).toEqual([q.id]);
    const e = ok(S.expireProposal(g.db, { proposalId: q.id, reason: 'time_passed', now: at(30) }));
    expect(e.status).toBe('expired');
    expect(g.db.prepare('SELECT action, actor, detail FROM event_log ORDER BY id DESC LIMIT 1').get()).toMatchObject({ action: 'reschedule_expired', actor: null });
    expect(S.expireProposal(g.db, { proposalId: q.id, reason: 'time_passed', now: at(30) })).toEqual({ ok: false, error: 'changed' });
  });

  it('names the silent side at the window end: no proposal and no answer while the other side proposed', async () => {
    const f = await windowFixture();
    expect(S.silentSide(f.db, match(f))).toBeNull();
    ok(propose(f, A[0]!, 72));
    expect(S.silentSide(f.db, match(f))).toBe('b');
    ok(S.respondProposal(f.db, { matchId: f.matchId, by: B[0]!, accept: false, now: at(1) }));
    expect(S.silentSide(f.db, match(f))).toBeNull();
    const g = await windowFixture();
    ok(propose(g, B[0]!, 72));
    ok(S.counterProposal(g.db, { matchId: g.matchId, by: A[0]!, time: at(80).toISOString(), rules: RULES, now: at(1) }));
    expect(S.silentSide(g.db, match(g))).toBeNull();
    const h = await windowFixture({ to: at(48) });
    ok(propose(h, B[0]!, 30));
    expect(S.expiredWindows(h.db, at(47))).toEqual([]);
    expect(S.expiredWindows(h.db, at(48)).map((m) => m.id)).toEqual([h.matchId]);
    expect(S.silentSide(h.db, match(h))).toBe('a');
  });
});

describe('staffSetTime and the hold from waiting', () => {
  it('staff set any future time on a waiting window match, expiring an open proposal in the same row', async () => {
    const f = await windowFixture();
    const p = ok(propose(f, A[0]!, 72));
    expect(S.staffSetTime(f.db, { matchId: f.matchId, by: ADMIN, time: at(-1).toISOString(), now: NOW })).toEqual({ ok: false, error: 'bad_time' });
    const logs = (f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }).n;
    const m = ok(S.staffSetTime(f.db, { matchId: f.matchId, by: ADMIN, time: at(24 * 9).toISOString(), now: NOW }));
    expect(m).toMatchObject({ scheduled_at: at(24 * 9).toISOString(), schedule_source: 'staff' });
    expect(S.getProposal(f.db, p.id)).toMatchObject({ status: 'expired', responded_by: ADMIN });
    expect((f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }).n).toBe(logs + 1);
    expect(last(f)).toEqual({ action: 'match_time_set', actor: ADMIN });
    R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS, now: NOW });
    expect(S.staffSetTime(f.db, { matchId: f.matchId, by: ADMIN, time: at(50).toISOString(), now: NOW })).toEqual({ ok: false, error: 'not_schedulable' });
  });

  it('a waiting match can be held at the window end and released back to waiting with no deadline', async () => {
    const f = await windowFixture();
    const h = ok(R.holdMatch(f.db, { matchId: f.matchId, by: null, reason: 'window_expired', now: NOW }));
    expect(h).toMatchObject({ status: 'admin_hold', hold_from: 'waiting', hold_reason: 'window_expired' });
    const r = ok(R.releaseHold(f.db, { matchId: f.matchId, by: ADMIN, timers: TIMERS, graceMinutes: 15, now: NOW }));
    expect(r).toMatchObject({ status: 'waiting', deadline: null, hold_from: null, hold_reason: null });
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run tests/schedule.test.ts`
Expected: FAIL (the module does not exist; `holdMatch` refuses `wrong_status` from `waiting`).

- [ ] **Step 4: room.ts**

`HOLDABLE` becomes `new Set<P.MatchStatus>(['waiting', 'veto', 'lineup', 'booking', 'connect', 'live', 'confirming'])` with the comment extended: `waiting` is the window end's hold (plan T4 Ruling 8). In `releaseHold`, the deadline chain gains nothing (a `waiting` match has no deadline and is not in `BOX_PHASES`), but the doc comment gets one line: "A hold from `waiting` (the window end, plan T4) goes back to waiting with no deadline; the clock opens its room again at its locked time, or staff set one." No other change: `to === 'waiting'` falls through every branch with `deadline = null` and `moveOn = false`.

- [ ] **Step 5: schedule.ts**

Create `src/events/schedule.ts`:

```ts
import type { DB } from '../db.js';
import { settingNumber } from '../settings.js';
import * as E from './events.js';
import * as N from './entries.js';
import * as P from './play.js';
import * as V from './validate.js';
import { ROOM_LIVE_SQL, sideOf } from './room.js';
import type { Side } from './veto.js';

/**
 * Reschedule proposals (tournaments plan T4, spec section 5): the only
 * writer of event_reschedules and of a match's agreed time (scheduled_at,
 * schedule_source). Same shape as room.ts: each mutation is one
 * transaction that re-reads, checks, writes and adds exactly one event_log
 * row; a refusal writes nothing (tests/eventLogGuard.test.ts, the schedule
 * guard). The window and the round default are stamped by play.ts; this
 * module only ever sets a time a captain agreed or staff chose.
 */

export type RescheduleStatus = 'open' | 'accepted' | 'auto_accepted' | 'declined' | 'countered' | 'withdrawn' | 'expired';
export interface RescheduleRow {
  id: number; event_match_id: number; side: Side; proposed_by: string; proposed_time: string; note: string; created_at: string;
  auto_accept_at: string | null; reminded_at: string | null; status: RescheduleStatus; responded_by: string | null; responded_at: string | null;
}
export interface ScheduleRules { autoAcceptHours: number; leadMinutes: number }

/** A proposal locks on its own only when made this long before its time (Ruling 6). */
export const AUTO_ACCEPT_MIN_AHEAD_MS = 48 * 3_600_000;
/** A proposed time is at least this far ahead (the room opens 20 minutes before it). */
export const PROPOSE_MIN_AHEAD_MS = 60 * 60_000;
/** The reminder goes out this long before the lock ... */
export const REMINDER_BEFORE_MS = 24 * 3_600_000;
/** ... but only when that is at least this long after the proposal (else the arrival DM says it all). */
export const REMINDER_MIN_GAP_MS = 60 * 60_000;

const iso = (now?: Date): string => (now ?? new Date()).toISOString();

export function scheduleRules(db: DB): ScheduleRules {
  return {
    autoAcceptHours: settingNumber(db, 'reschedule_autoaccept_hours', 24, { min: 1, max: 72, integer: true }),
    leadMinutes: settingNumber(db, 'event_window_lead_minutes', 20, { min: 5, max: 60, integer: true }),
  };
}

export function proposalsOf(db: DB, matchId: number): RescheduleRow[] {
  return db.prepare('SELECT * FROM event_reschedules WHERE event_match_id = ? ORDER BY id').all(matchId) as RescheduleRow[];
}
export function openProposal(db: DB, matchId: number): RescheduleRow | undefined {
  return db.prepare("SELECT * FROM event_reschedules WHERE event_match_id = ? AND status = 'open'").get(matchId) as RescheduleRow | undefined;
}
export function getProposal(db: DB, id: number): RescheduleRow | undefined {
  return db.prepare('SELECT * FROM event_reschedules WHERE id = ?').get(id) as RescheduleRow | undefined;
}

/** When an unanswered proposal locks (Ruling 6), or null when it needs an answer. */
export function autoAcceptAt(createdMs: number, proposedMs: number, hours: number): string | null {
  return proposedMs - createdMs >= AUTO_ACCEPT_MIN_AHEAD_MS ? new Date(createdMs + hours * 3_600_000).toISOString() : null;
}
/** When the 24-hour reminder goes out, or null when the arrival DM carries the lock time already. */
export function reminderAt(createdMs: number, autoAcceptIso: string | null): string | null {
  if (autoAcceptIso === null) return null;
  const t = Date.parse(autoAcceptIso) - REMINDER_BEFORE_MS;
  return t >= createdMs + REMINDER_MIN_GAP_MS ? new Date(t).toISOString() : null;
}

/** The match, waiting in a live window stage with a window whose end has not passed, both teams in. */
function schedulable(db: DB, matchId: number, at: string): V.Checked<{ m: P.MatchRow; ev: E.EventRow }> {
  const m = P.getMatch(db, matchId);
  if (!m) return V.fail('match_not_found');
  const ev = E.getEvent(db, m.event_id)!;
  const stage = E.getStage(db, m.stage_id)!;
  if (ev.status !== 'live' || stage.status !== 'live') return V.fail('not_live');
  if (m.entry_a === null || m.entry_b === null) return V.fail('match_not_open');
  if (![m.entry_a, m.entry_b].every((id) => N.isActive(N.getEntry(db, id)!))) return V.fail('entry_out');
  if (stage.scheduling !== 'window' || m.status !== 'waiting' || m.window_start === null || m.window_end === null || m.window_end <= at) {
    return V.fail('not_schedulable');
  }
  return V.ok({ m, ev });
}

/** A proposed time: inside the window, at least an hour ahead, not the time already set (Ruling 7). */
function timeIn(m: P.MatchRow, raw: unknown, at: string): string | null {
  const t = V.parseTime(raw);
  if (!t || t < m.window_start! || t > m.window_end! || t === m.scheduled_at) return null;
  return Date.parse(t) - Date.parse(at) >= PROPOSE_MIN_AHEAD_MS ? t : null;
}

function insertProposal(db: DB, m: P.MatchRow, side: Side, by: string, time: string, note: string, at: string, rules: ScheduleRules): number {
  const auto = autoAcceptAt(Date.parse(at), Date.parse(time), rules.autoAcceptHours);
  return Number(db.prepare(
    'INSERT INTO event_reschedules (event_match_id, side, proposed_by, proposed_time, note, created_at, auto_accept_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(m.id, side, by, time, note, at, auto).lastInsertRowid);
}
function closeProposal(db: DB, id: number, status: RescheduleStatus, by: string | null, at: string): void {
  db.prepare('UPDATE event_reschedules SET status = ?, responded_by = ?, responded_at = ? WHERE id = ?').run(status, by, at, id);
}
function lockTime(db: DB, matchId: number, time: string, source: 'agreed' | 'staff'): void {
  db.prepare('UPDATE event_matches SET scheduled_at = ?, schedule_source = ? WHERE id = ?').run(time, source, matchId);
}

export function proposeTime(
  db: DB, o: { matchId: number; by: string; time: unknown; note?: unknown; rules: ScheduleRules; now?: Date },
): V.Checked<RescheduleRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<RescheduleRow> => {
    const c = schedulable(db, o.matchId, at);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    const side = sideOf(db, m, o.by);
    if (!side) return V.fail('not_manager');
    if (openProposal(db, m.id)) return V.fail('proposal_open');
    const time = timeIn(m, o.time, at);
    if (!time) return V.fail('bad_time');
    const nr = V.normalizeReason(o.note);
    if (!nr.ok) return nr;
    const id = insertProposal(db, m, side, o.by, time, nr.value ?? '', at, o.rules);
    const p = getProposal(db, id)!;
    E.logEvent(db, ev.id, o.by, 'reschedule_proposed', at, { matchId: m.id, proposalId: id, side, time, autoAcceptAt: p.auto_accept_at });
    return V.ok(p);
  })();
}

/** The other side accepts (the time locks as agreed) or declines (nothing changes). */
export function respondProposal(db: DB, o: { matchId: number; by: string; accept: boolean; now?: Date }): V.Checked<{ m: P.MatchRow; proposal: RescheduleRow }> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<{ m: P.MatchRow; proposal: RescheduleRow }> => {
    const c = schedulable(db, o.matchId, at);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    const side = sideOf(db, m, o.by);
    if (!side) return V.fail('not_manager');
    const p = openProposal(db, m.id);
    if (!p) return V.fail('no_proposal');
    if (p.side === side) return V.fail('own_proposal');
    // A time that passed while nobody answered cannot be accepted; the clock expires it.
    if (o.accept && p.proposed_time <= at) return V.fail('bad_time');
    closeProposal(db, p.id, o.accept ? 'accepted' : 'declined', o.by, at);
    if (o.accept) lockTime(db, m.id, p.proposed_time, 'agreed');
    E.logEvent(db, ev.id, o.by, o.accept ? 'reschedule_accepted' : 'reschedule_declined', at, { matchId: m.id, proposalId: p.id, side, time: p.proposed_time });
    return V.ok({ m: P.getMatch(db, m.id)!, proposal: getProposal(db, p.id)! });
  })();
}

/** The other side answers with its own time: the open proposal closes as countered and the new one opens, one row. */
export function counterProposal(
  db: DB, o: { matchId: number; by: string; time: unknown; note?: unknown; rules: ScheduleRules; now?: Date },
): V.Checked<RescheduleRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<RescheduleRow> => {
    const c = schedulable(db, o.matchId, at);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    const side = sideOf(db, m, o.by);
    if (!side) return V.fail('not_manager');
    const p = openProposal(db, m.id);
    if (!p) return V.fail('no_proposal');
    if (p.side === side) return V.fail('own_proposal');
    const time = timeIn(m, o.time, at);
    if (!time) return V.fail('bad_time');
    const nr = V.normalizeReason(o.note);
    if (!nr.ok) return nr;
    closeProposal(db, p.id, 'countered', o.by, at);
    const id = insertProposal(db, m, side, o.by, time, nr.value ?? '', at, o.rules);
    const next = getProposal(db, id)!;
    E.logEvent(db, ev.id, o.by, 'reschedule_countered', at, { matchId: m.id, countered: p.id, proposalId: id, side, time, autoAcceptAt: next.auto_accept_at });
    return V.ok(next);
  })();
}

export function withdrawProposal(db: DB, o: { matchId: number; by: string; now?: Date }): V.Checked<RescheduleRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<RescheduleRow> => {
    const c = schedulable(db, o.matchId, at);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    const side = sideOf(db, m, o.by);
    if (!side) return V.fail('not_manager');
    const p = openProposal(db, m.id);
    if (!p) return V.fail('no_proposal');
    if (p.side !== side) return V.fail('not_your_proposal');
    closeProposal(db, p.id, 'withdrawn', o.by, at);
    E.logEvent(db, ev.id, o.by, 'reschedule_withdrawn', at, { matchId: m.id, proposalId: p.id, side });
    return V.ok(getProposal(db, p.id)!);
  })();
}

/** Ruling 10: staff set any future time on a waiting window-stage match; an open proposal expires with it. */
export function staffSetTime(db: DB, o: { matchId: number; by: string; time: unknown; now?: Date }): V.Checked<P.MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const m = P.getMatch(db, o.matchId);
    if (!m) return V.fail('match_not_found');
    const ev = E.getEvent(db, m.event_id)!;
    const stage = E.getStage(db, m.stage_id)!;
    if (ev.status !== 'live' || stage.status !== 'live') return V.fail('not_live');
    if (stage.scheduling !== 'window' || m.status !== 'waiting' || m.entry_a === null || m.entry_b === null) return V.fail('not_schedulable');
    const time = V.parseTime(o.time);
    if (!time || time <= at) return V.fail('bad_time');
    const p = openProposal(db, m.id);
    if (p) closeProposal(db, p.id, 'expired', o.by, at);
    lockTime(db, m.id, time, 'staff');
    E.logEvent(db, ev.id, o.by, 'match_time_set', at, { matchId: m.id, time, was: m.scheduled_at, expired: p?.id ?? null });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

// ---------- the clock's duties (src/events/roomClock.ts) ----------

/** Open proposals of waiting matches in live events and stages: the base of every due list. */
const OPEN_SQL = `SELECT r.* FROM event_reschedules r JOIN event_matches m ON m.id = r.event_match_id
  WHERE ${ROOM_LIVE_SQL} AND r.status = 'open' AND m.status = 'waiting'`;

export function autoAcceptDue(db: DB, now: Date): RescheduleRow[] {
  const at = now.toISOString();
  return db.prepare(`${OPEN_SQL} AND r.auto_accept_at IS NOT NULL AND r.auto_accept_at <= ? AND r.proposed_time > ? ORDER BY r.id`).all(at, at) as RescheduleRow[];
}

/** Ruling 6: still open, due, and the match still waiting with a future time; else 'changed'. */
export function autoAccept(db: DB, o: { proposalId: number; now?: Date }): V.Checked<P.MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const p = getProposal(db, o.proposalId);
    if (!p || p.status !== 'open' || p.auto_accept_at === null || p.auto_accept_at > at || p.proposed_time <= at) return V.fail('changed');
    const m = P.getMatch(db, p.event_match_id);
    if (!m || m.status !== 'waiting') return V.fail('changed');
    closeProposal(db, p.id, 'auto_accepted', null, at);
    lockTime(db, m.id, p.proposed_time, 'agreed');
    E.logEvent(db, m.event_id, null, 'reschedule_auto_accepted', at, { matchId: m.id, proposalId: p.id, side: p.side, time: p.proposed_time });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

export function remindersDue(db: DB, now: Date): RescheduleRow[] {
  const rows = db.prepare(`${OPEN_SQL} AND r.reminded_at IS NULL AND r.auto_accept_at IS NOT NULL ORDER BY r.id`).all() as RescheduleRow[];
  const at = now.toISOString();
  return rows.filter((r) => { const t = reminderAt(Date.parse(r.created_at), r.auto_accept_at); return t !== null && t <= at; });
}

export function noteReminded(db: DB, o: { proposalId: number; now?: Date }): V.Checked<RescheduleRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<RescheduleRow> => {
    const p = getProposal(db, o.proposalId);
    if (!p || p.status !== 'open' || p.reminded_at !== null) return V.fail('changed');
    db.prepare('UPDATE event_reschedules SET reminded_at = ? WHERE id = ?').run(at, p.id);
    const m = P.getMatch(db, p.event_match_id)!;
    E.logEvent(db, m.event_id, null, 'reschedule_reminded', at, { matchId: m.id, proposalId: p.id, side: p.side, autoAcceptAt: p.auto_accept_at });
    return V.ok(getProposal(db, p.id)!);
  })();
}

/** Open proposals whose time came with no answer. */
export function staleProposals(db: DB, now: Date): RescheduleRow[] {
  return db.prepare(`${OPEN_SQL} AND r.proposed_time <= ? ORDER BY r.id`).all(now.toISOString()) as RescheduleRow[];
}

export function expireProposal(db: DB, o: { proposalId: number; reason: 'time_passed' | 'window_ended'; now?: Date }): V.Checked<RescheduleRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<RescheduleRow> => {
    const p = getProposal(db, o.proposalId);
    if (!p || p.status !== 'open') return V.fail('changed');
    closeProposal(db, p.id, 'expired', null, at);
    const m = P.getMatch(db, p.event_match_id)!;
    E.logEvent(db, m.event_id, null, 'reschedule_expired', at, { matchId: m.id, proposalId: p.id, side: p.side, reason: o.reason });
    return V.ok(getProposal(db, p.id)!);
  })();
}

/** Window-stage matches still waiting past their window's end (Ruling 8), both teams known. */
export function expiredWindows(db: DB, now: Date): P.MatchRow[] {
  return db.prepare(
    `SELECT m.* FROM event_matches m JOIN event_stages s ON s.id = m.stage_id
     WHERE ${ROOM_LIVE_SQL} AND s.scheduling = 'window' AND m.status = 'waiting' AND m.entry_a IS NOT NULL AND m.entry_b IS NOT NULL
       AND m.window_end IS NOT NULL AND m.window_end <= ? ORDER BY m.id`,
  ).all(now.toISOString()) as P.MatchRow[];
}

/** Ruling 8: the side that made no proposal and answered none while the
 *  other side made at least one; null when both acted or neither did. A
 *  counter, a decline, a withdrawal and a staff expiry all count as an
 *  answer by the side whose manager gave it. */
export function silentSide(db: DB, m: P.MatchRow): Side | null {
  const acted = { a: false, b: false };
  const proposed = { a: false, b: false };
  for (const p of proposalsOf(db, m.id)) {
    proposed[p.side] = true;
    acted[p.side] = true;
    if (p.responded_by !== null) {
      const s = sideOf(db, m, p.responded_by);
      if (s) acted[s] = true;
    }
  }
  if (acted.a === acted.b) return null;
  const silent: Side = acted.a ? 'b' : 'a';
  return proposed[silent === 'a' ? 'b' : 'a'] ? silent : null;
}
```

(`acted.a === acted.b` covers both false and both true. A staff expiry's `responded_by` is the admin, who manages neither side, so it marks nobody.)

- [ ] **Step 6: The guard**

In `tests/eventLogGuard.test.ts`, the play guard's offender filter becomes `walk('src').filter((f) => f !== 'src/events/play.ts' && f !== 'src/events/room.ts' && f !== 'src/events/schedule.ts')` and its test name "only src/events/play.ts, room.ts and schedule.ts write event_matches". Add, after the room guard `describe`, a schedule guard modelled on it (`import * as S from '../src/events/schedule.js';` and `windowFixture` from `./roomFixture.js`):

```ts
  /** Plan T4: src/events/schedule.ts is the only writer of event_reschedules,
   *  and its mutations follow the same one-row rule. */
  describe('schedule guard (src/events/schedule.ts)', () => {
    const SCHEDULE_TABLE = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+event_reschedules\b/gi;
    const SCHEDULE_READS = new Set([
      'scheduleRules', 'proposalsOf', 'openProposal', 'getProposal', 'autoAcceptAt', 'reminderAt', 'silentSide',
      'autoAcceptDue', 'remindersDue', 'staleProposals', 'expiredWindows',
    ]);
    const RULES: S.ScheduleRules = { autoAcceptHours: 24, leadMinutes: 20 };
    const at = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
    const must = <T>(r: V.Checked<T>): T => { if (!r.ok) throw new Error(r.error); return r.value; };
    const proposed = (f: RoomFixture) => must(S.proposeTime(f.db, { matchId: f.matchId, by: A[0]!, time: at(72).toISOString(), rules: RULES, now: NOW }));
    const SCHEDULE_MUTATIONS: Record<string, { action: string; actor: string | null; setup: (f: RoomFixture) => void; run: (f: RoomFixture) => V.Checked<unknown> }> = {
      proposeTime: { action: 'reschedule_proposed', actor: A[0]!, setup: () => {}, run: (f) => S.proposeTime(f.db, { matchId: f.matchId, by: A[0]!, time: at(72).toISOString(), rules: RULES, now: NOW }) },
      respondProposal: { action: 'reschedule_accepted', actor: B[0]!, setup: proposed, run: (f) => S.respondProposal(f.db, { matchId: f.matchId, by: B[0]!, accept: true, now: at(1) }) },
      counterProposal: { action: 'reschedule_countered', actor: B[0]!, setup: proposed, run: (f) => S.counterProposal(f.db, { matchId: f.matchId, by: B[0]!, time: at(80).toISOString(), rules: RULES, now: at(1) }) },
      withdrawProposal: { action: 'reschedule_withdrawn', actor: A[0]!, setup: proposed, run: (f) => S.withdrawProposal(f.db, { matchId: f.matchId, by: A[0]!, now: at(1) }) },
      staffSetTime: { action: 'match_time_set', actor: ADMIN, setup: proposed, run: (f) => S.staffSetTime(f.db, { matchId: f.matchId, by: ADMIN, time: at(90).toISOString(), now: at(1) }) },
      autoAccept: { action: 'reschedule_auto_accepted', actor: null, setup: proposed, run: (f) => S.autoAccept(f.db, { proposalId: S.openProposal(f.db, f.matchId)!.id, now: at(24) }) },
      noteReminded: {
        action: 'reschedule_reminded', actor: null,
        setup: (f) => must(S.proposeTime(f.db, { matchId: f.matchId, by: A[0]!, time: at(100).toISOString(), rules: { autoAcceptHours: 48, leadMinutes: 20 }, now: NOW })),
        run: (f) => S.noteReminded(f.db, { proposalId: S.openProposal(f.db, f.matchId)!.id, now: at(24) }),
      },
      expireProposal: { action: 'reschedule_expired', actor: null, setup: proposed, run: (f) => S.expireProposal(f.db, { proposalId: S.openProposal(f.db, f.matchId)!.id, reason: 'time_passed', now: at(72) }) },
    };
    const rows = (f: RoomFixture) => JSON.stringify(['event_matches', 'event_reschedules'].map((t) => f.db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()));

    it('only src/events/schedule.ts writes event_reschedules', () => {
      const offenders = walk('src').filter((f) => f !== 'src/events/schedule.ts')
        .filter((f) => (readFileSync(join(root, f), 'utf8').match(SCHEDULE_TABLE) ?? []).length > 0);
      expect(offenders).toEqual([]);
    });

    it('every exported function of schedule.ts is a known read or a guarded mutation', () => {
      const fns = Object.entries(S).filter(([, v]) => typeof v === 'function').map(([k]) => k);
      expect(fns.filter((k) => !SCHEDULE_READS.has(k)).sort()).toEqual(Object.keys(SCHEDULE_MUTATIONS).sort());
    });

    for (const [name, m] of Object.entries(SCHEDULE_MUTATIONS)) {
      it(`${name} writes exactly one event_log row, ${m.action}`, async () => {
        const f = await windowFixture();
        m.setup(f);
        const before = logCount(f);
        const r = m.run(f);
        expect(r.ok, r.ok ? '' : r.error).toBe(true);
        expect(logCount(f)).toBe(before + 1);
        expect(f.db.prepare('SELECT action, actor FROM event_log ORDER BY id DESC LIMIT 1').get()).toEqual({ action: m.action, actor: m.actor });
      });

      it(`${name} writes nothing when its event_log row cannot be written`, async () => {
        const f = await windowFixture();
        m.setup(f);
        const before = rows(f);
        f.db.exec(`CREATE TRIGGER schedule_log_down_${name} BEFORE INSERT ON event_log WHEN NEW.action = '${m.action}' BEGIN SELECT RAISE(ABORT, 'audit down'); END`);
        expect(() => m.run(f)).toThrow(/audit down/);
        expect(rows(f)).toBe(before);
      });
    }
  });
```

(The room guard's `ROOM_MUTATIONS` already covers `holdMatch` and `releaseHold`; the `waiting` hold needs no new entry.)

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/schedule.test.ts tests/room.test.ts tests/eventLogGuard.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/events/schedule.ts src/events/room.ts tests/roomFixture.ts tests/schedule.test.ts tests/eventLogGuard.test.ts
git commit -m "Tournaments T4: captains propose, accept, decline, counter and withdraw match times inside the window, a proposal locks on its own after the setting's hours when made 48 hours ahead, staff set a time outright, and a match can be held from waiting"
```

---
### Task 4: The clock opens scheduled rooms and runs the proposals; the DMs

**Files:**
- Modify: `src/events/roomClock.ts`, `src/events/notices.ts`, `src/events/messages.ts`, `src/notify/notify.ts`
- Test: `tests/roomClock.test.ts`, `tests/eventRunner.test.ts` (the `eventMessage` tests live there), `tests/notify.test.ts`

**Interfaces:**
- Consumes: everything of Task 3; `forfeitMatch` (`flow.ts`); `holdMatch`, `openRoom`, `busyEntries`, `ROOM_LIVE_SQL` (`room.ts`); `publishAdminEvent` (`adminFeed.ts`); `other` (`veto.ts`); `managersOf`, `getEntry` (`entries.ts`); `escapeName`, `getPlayer`, `whenUtc`.
- Produces:
  - `roomClock.ts`: `dueWindowRooms(db: DB, now: Date, leadMs: number): P.MatchRow[]`; `RoomClock.tick` runs `this.schedule(now)` (auto-accepts, reminders, stale proposals, window ends) before `openDue`, and `openDue` opens both lists.
  - `messages.ts`: `EventNotifyType` gains `'event_reschedule' | 'event_match_time'`; `type RescheduleNotice = 'proposed' | 'countered' | 'declined' | 'withdrawn' | 'reminder'`; `extra` gains `what?: StaffAction | RescheduleNotice; proposalId?: number`; `why` gains `'window'`; `discordTime(iso: string): string` (`<t:unix:F>`).
  - `notices.ts`: `tellReschedule(d, eventId, matchId, what: RescheduleNotice, proposalId: number): void` (to the managers of the side that must act, Ruling 11); `tellTimeLocked(d, eventId, matchId): void` (both rosters); `tellReadyForfeit`'s `why` accepts `'window'`.
  - `notify.ts`: `NotifyType` and `NOTIFY_TYPES` gain `event_reschedule` ("A captain proposes, counters, declines or withdraws a time for a tournament match of mine, or a proposal is about to lock") and `event_match_time` ("A tournament match of mine has its time set").

- [ ] **Step 1: Write the failing tests**

Append to `tests/roomClock.test.ts` (new `describe`; add `import * as S from '../src/events/schedule.js';`, `windowFixture` to the roomFixture import, and `import { forfeitMatch } from '../src/events/flow.js';` is not needed):

```ts
describe('RoomClock: window stages (plan T4)', () => {
  const H = 60;
  const hours = (h: number) => at(h * H);

  it('opens a scheduled room at the lead before its time, not before, and DMs the rosters', async () => {
    const f = await windowFixture();
    f.db.prepare("UPDATE event_matches SET scheduled_at = ?, schedule_source = 'default' WHERE id = ?").run(new Date(hours(2)).toISOString(), f.matchId);
    const t = { t: hours(2) - 21 * 60_000 };
    const { clock, send, push } = clockAt(f, t);
    await clock.tick();
    expect(match(f).status).toBe('waiting');
    t.t = hours(2) - 20 * 60_000;
    await clock.tick();
    expect(match(f)).toMatchObject({ status: 'veto', room_seed: 5 });
    expect(send).toHaveBeenCalledWith(expect.arrayContaining([A[0], B[0]]), 'event_match_room', expect.anything());
    expect(push).toHaveBeenCalledWith(f.matchId);
    expect(dueWindowRooms(f.db, new Date(t.t), 20 * 60_000)).toEqual([]);
  });

  it('does not open a window match with no time, and respects the busy rule but not the earliest-match rule', async () => {
    const f = await windowFixture();
    expect(dueWindowRooms(f.db, new Date(hours(48)), 20 * 60_000)).toEqual([]);
    f.db.prepare("UPDATE event_matches SET scheduled_at = ?, schedule_source = 'default' WHERE id = ?").run(new Date(hours(1)).toISOString(), f.matchId);
    // A second, later-round match of Rats already in a room makes Rats busy (test setup only).
    const other = Number(f.db.prepare(
      `INSERT INTO event_matches (event_id, stage_id, grp, round, slot, entry_a, entry_b, status, created_at) VALUES (?, ?, 1, 2, 1, ?, ?, 'veto', ?)`,
    ).run(f.eventId, f.stageId, f.entryA, f.entryB, NOW.toISOString()).lastInsertRowid);
    expect(dueWindowRooms(f.db, new Date(hours(1)), 20 * 60_000)).toEqual([]);
    f.db.prepare("UPDATE event_matches SET status = 'done' WHERE id = ?").run(other);
    expect(dueWindowRooms(f.db, new Date(hours(1)), 20 * 60_000).map((m) => m.id)).toEqual([f.matchId]);
  });

  it('auto-accepts a due proposal and opens the room at its time, reminding first when the lock is far off', async () => {
    const f = await windowFixture();
    f.db.prepare("UPDATE settings SET value = '48' WHERE key = 'reschedule_autoaccept_hours'").run();
    const rules = S.scheduleRules(f.db);
    expect(rules).toEqual({ autoAcceptHours: 48, leadMinutes: 20 });
    const p = S.proposeTime(f.db, { matchId: f.matchId, by: A[0], time: new Date(hours(100)).toISOString(), rules, now: NOW });
    expect(p.ok).toBe(true);
    const t = { t: hours(24) };
    const { clock, send, push } = clockAt(f, t);
    await clock.tick();
    expect(send).toHaveBeenCalledWith([B[0]], 'event_reschedule', expect.objectContaining({ content: expect.stringContaining('locks') }));
    expect(send).not.toHaveBeenCalledWith(expect.arrayContaining([A[0]]), 'event_reschedule', expect.anything());
    expect(S.openProposal(f.db, f.matchId)!.reminded_at).toBe(new Date(hours(24)).toISOString());
    t.t = hours(48);
    await clock.tick();
    expect(match(f)).toMatchObject({ scheduled_at: new Date(hours(100)).toISOString(), schedule_source: 'agreed', status: 'waiting' });
    expect(send).toHaveBeenCalledWith(expect.arrayContaining([A[0], A[4], B[0], B[3]]), 'event_match_time', expect.anything());
    expect(push).toHaveBeenCalledWith(f.matchId);
    t.t = hours(100) - 20 * 60_000;
    await clock.tick();
    expect(match(f).status).toBe('veto');
  });

  it('expires a proposal whose time passed with no answer, and pushes', async () => {
    const f = await windowFixture();
    const p = S.proposeTime(f.db, { matchId: f.matchId, by: A[0], time: new Date(hours(30)).toISOString(), rules: S.scheduleRules(f.db), now: NOW });
    expect(p.ok && p.value.auto_accept_at).toBeNull();
    const t = { t: hours(30) };
    const { clock, push } = clockAt(f, t);
    await clock.tick();
    expect(S.openProposal(f.db, f.matchId)).toBeUndefined();
    expect(S.proposalsOf(f.db, f.matchId)[0]!.status).toBe('expired');
    expect(push).toHaveBeenCalledWith(f.matchId);
    expect(match(f).status).toBe('waiting');
  });

  it('at the window end forfeits the silent side, else holds the match for staff', async () => {
    const f = await windowFixture({ to: new Date(hours(48)) });
    S.proposeTime(f.db, { matchId: f.matchId, by: B[0], time: new Date(hours(30)).toISOString(), rules: S.scheduleRules(f.db), now: NOW });
    const t = { t: hours(48) };
    const { clock, send } = clockAt(f, t);
    await clock.tick();
    expect(match(f)).toMatchObject({ status: 'forfeit', winner_entry: f.entryB, result_source: 'forfeit' });
    expect(S.proposalsOf(f.db, f.matchId)[0]!.status).toBe('expired');
    expect(send).toHaveBeenCalledWith(expect.arrayContaining([A[0], B[0]]), 'event_match_forfeit', expect.objectContaining({ content: expect.stringContaining('window') }));

    const g = await windowFixture({ to: new Date(hours(48)) });
    const alerts: string[] = [];
    const { subscribeAdminEvents } = await import('../src/adminFeed.js');
    const off = subscribeAdminEvents((e) => alerts.push(e.text));
    try {
      const { clock: c2 } = clockAt(g, { t: hours(48) });
      await c2.tick();
      expect(match(g)).toMatchObject({ status: 'admin_hold', hold_reason: 'window_expired', hold_from: 'waiting' });
      expect(alerts.some((x) => /window/.test(x))).toBe(true);
      await c2.tick();
      expect(match(g).status).toBe('admin_hold');
    } finally { off(); }
  });
});
```

(`subscribeAdminEvents` returns an unsubscribe function, as `tests/seriesFixture.ts` uses it; check its signature in `src/adminFeed.ts` and adapt the `off()` call if it differs.) Append to `tests/eventRunner.test.ts` (inside the `eventMessage` describe; look at how its existing tests build an event with a match: the room DM test from T3a uses `roomFixture` and `eventMessage(f.db, 'https://x', f.eventId, 'event_match_room', { matchId })`; follow that):

```ts
  it('words the reschedule and locked-time DMs with Discord timestamps, and the window forfeit (plan T4)', async () => {
    const f = await windowFixture();
    const S = await import('../src/events/schedule.js');
    const time = new Date(NOW.getTime() + 72 * 3_600_000).toISOString();
    const p = S.proposeTime(f.db, { matchId: f.matchId, by: A[0], time, note: 'after work', rules: { autoAcceptHours: 24, leadMinutes: 20 }, now: NOW });
    if (!p.ok) throw new Error(p.error);
    const unix = Math.floor(Date.parse(time) / 1000);
    const proposed = eventMessage(f.db, 'https://x', f.eventId, 'event_reschedule', { matchId: f.matchId, what: 'proposed', proposalId: p.value.id })!;
    expect(proposed.content).toContain(`<t:${unix}:F>`);
    expect(proposed.content).toContain('Rats');
    expect(proposed.content).toContain('after work');
    expect(proposed.content).toContain(`locks on <t:${Math.floor(Date.parse(p.value.auto_accept_at!) / 1000)}:F>`);
    expect(proposed.components[0]![0]).toMatchObject({ kind: 'link', url: `https://x/event/${f.slug}/match/${f.matchId}` });
    expect(eventMessage(f.db, 'https://x', f.eventId, 'event_reschedule', { matchId: f.matchId, what: 'reminder', proposalId: p.value.id })!.content).toMatch(/locks on <t:\d+:F> unless/);
    expect(eventMessage(f.db, 'https://x', f.eventId, 'event_reschedule', { matchId: f.matchId, what: 'declined', proposalId: p.value.id })!.content).toMatch(/declined/);
    f.db.prepare("UPDATE event_matches SET scheduled_at = ?, schedule_source = 'agreed' WHERE id = ?").run(time, f.matchId);
    const locked = eventMessage(f.db, 'https://x', f.eventId, 'event_match_time', { matchId: f.matchId })!;
    expect(locked.content).toContain(`<t:${unix}:F>`);
    expect(locked.content).toMatch(/20 minutes before/);
    expect(eventMessage(f.db, 'https://x', f.eventId, 'event_match_time', { matchId: f.matchId, what: 'staff' })!.content).toMatch(/staff set/i);
    f.db.prepare("UPDATE event_matches SET status = 'forfeit', winner_entry = ? WHERE id = ?").run(f.entryB, f.matchId);
    expect(eventMessage(f.db, 'https://x', f.eventId, 'event_match_forfeit', { matchId: f.matchId, why: 'window' })!.content).toMatch(/never answered .* before the window closed/);
  });
```

Append to `tests/notify.test.ts` (inside the prefs `describe`):

```ts
    expect(NOTIFY_TYPES.filter((t) => t.type === 'event_reschedule' || t.type === 'event_match_time')).toEqual([
      { type: 'event_reschedule', label: 'A captain proposes, counters, declines or withdraws a time for a tournament match of mine, or a proposal is about to lock' },
      { type: 'event_match_time', label: 'A tournament match of mine has its time set' },
    ]);
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/roomClock.test.ts tests/eventRunner.test.ts tests/notify.test.ts`
Expected: FAIL (`dueWindowRooms` undefined, the scheduled room never opens, the new types unknown).

- [ ] **Step 3: notify.ts, messages.ts, notices.ts**

`notify.ts`: add `| 'event_reschedule' | 'event_match_time'` to `NotifyType` and the two rows after `event_match_staff` in `NOTIFY_TYPES` with the labels above.

`messages.ts`: `EventNotifyType` gains the two; add

```ts
/** A reschedule DM's occasion (plan T4 Ruling 11). */
export type RescheduleNotice = 'proposed' | 'countered' | 'declined' | 'withdrawn' | 'reminder';
/** Discord renders this in each reader's own time zone (Global Constraints). */
export const discordTime = (iso: string): string => `<t:${Math.floor(Date.parse(iso) / 1000)}:F>`;
```

`eventMessage`'s `extra` type becomes `{ entryId?: number; reason?: R.DropReason; by?: string; role?: R.Role; matchId?: number; why?: 'ready' | 'server' | 'window'; what?: StaffAction | RescheduleNotice | 'staff'; detail?: string; proposalId?: number }`. Add imports `import { getProposal } from './schedule.js';` and `import { scheduleRules } from './schedule.js';` (one line). In the `switch`, extend the first match case to `case 'event_match_connect': case 'event_match_result': case 'event_match_staff': case 'event_reschedule': case 'event_match_time':` and inside, before `if (type === 'event_match_staff')`:

```ts
      if (type === 'event_reschedule') {
        const p = extra.proposalId !== undefined ? getProposal(db, extra.proposalId) : undefined;
        if (!p) return null;
        const who = p.side === 'a' ? a : b;
        const by = escapeName(getPlayer(db, p.proposed_by)?.name ?? 'A captain');
        const note = p.note ? ` ("${escapeName(p.note)}")` : '';
        const lock = p.auto_accept_at ? ` Unanswered, it locks on ${discordTime(p.auto_accept_at)}.` : '';
        const what = extra.what ?? 'proposed';
        content = what === 'proposed' || what === 'countered'
          ? `${by} of ${who} ${what === 'countered' ? 'counters with' : 'proposes'} ${discordTime(p.proposed_time)} for ${a} vs ${b} in ${event}${note}. A captain or co-captain accepts, declines or counters on the match page.${lock}`
          : what === 'reminder'
            ? `${who}'s proposed time for ${a} vs ${b} in ${event}, ${discordTime(p.proposed_time)}, locks on ${discordTime(p.auto_accept_at ?? p.proposed_time)} unless a captain or co-captain of your team answers on the match page.`
            : what === 'declined'
              ? `${a === who ? b : a} declined ${who}'s proposed time ${discordTime(p.proposed_time)} for ${a} vs ${b} in ${event}. Propose another on the match page.`
              : `${who} withdrew its proposed time ${discordTime(p.proposed_time)} for ${a} vs ${b} in ${event}.`;
      } else if (type === 'event_match_time') {
        if (m.scheduled_at === null) return null;
        const lead = scheduleRules(db).leadMinutes;
        content = `${a} vs ${b} in ${event} is set for ${discordTime(m.scheduled_at)}${extra.what === 'staff' ? ' (staff set it)' : ''}. The match room opens ${lead} minutes before; a captain or co-captain of each team presses Ready there, then the veto and lineups follow and the server is booked.`;
      } else if (type === 'event_match_staff') {
```

(the existing `if (type === 'event_match_staff')` becomes that `else if`, and `extra.what` there is narrowed with `as StaffAction` where `STAFF_TEXT[...]` is indexed: `STAFF_TEXT[(extra.what as StaffAction | undefined) ?? 'hold_released']`.) In the forfeit case the `why` text becomes:

```ts
        const why = extra.why === 'server' ? 'did not have four players on the server when the grace to connect ended'
          : extra.why === 'window' ? 'never answered the other team\'s proposed time and never played before the window closed'
            : 'did not press Ready in the match room in time';
        content = `${a} vs ${b} in ${event} is a forfeit win for ${winner}: ${loser} ${why}.`;
```

`notices.ts`: `tellReadyForfeit`'s `why` type becomes `'ready' | 'server' | 'window'`; add `import { getProposal } from './schedule.js';` and `import type { RescheduleNotice, StaffAction } from './messages.js';` (extend the existing type import), then:

```ts
/** A proposal moved (plan T4 Ruling 11): the managers of the side that
 *  must act. A proposal, a counter and the reminder go to the other side;
 *  a decline or a withdrawal to the side that proposed. */
export function tellReschedule(d: NoticeDeps, eventId: number, matchId: number, what: RescheduleNotice, proposalId: number): void {
  const m = P.getMatch(d.db, matchId);
  const p = getProposal(d.db, proposalId);
  if (!m || !p || m.entry_a === null || m.entry_b === null) return;
  const toSide = what === 'declined' || what === 'withdrawn' ? p.side : p.side === 'a' ? 'b' : 'a';
  const entry = N.getEntry(d.db, toSide === 'a' ? m.entry_a : m.entry_b);
  if (!entry) return;
  tell(d, N.managersOf(d.db, entry.team_id), eventId, 'event_reschedule', { matchId, what, proposalId });
}
/** A time locked (accepted, auto-accepted or set by staff): both rosters. */
export function tellTimeLocked(d: NoticeDeps, eventId: number, matchId: number, staff = false): void {
  tell(d, rostersOf(d, matchId), eventId, 'event_match_time', { matchId, ...(staff ? { what: 'staff' as const } : {}) });
}
```

- [ ] **Step 4: roomClock.ts**

Add imports: `import * as S from './schedule.js';`, `import { publishAdminEvent } from '../adminFeed.js';`, `import { tellReadyForfeit, tellReschedule, tellRoomOpen, tellTimeLocked } from './notices.js';` (extend), `import { autoAction, isHumanStep, other, type Side } from './veto.js';` (extend). After `dueRooms` add:

```ts
/** Window-stage matches whose locked time minus the lead has come (plan T4
 *  Ruling 9): both teams known and in, neither busy in another open room.
 *  No earliest-match rule: a league week's matches are independent. */
export function dueWindowRooms(db: DB, now: Date, leadMs: number): P.MatchRow[] {
  const rows = db.prepare(
    `SELECT m.* FROM event_matches m JOIN event_stages s ON s.id = m.stage_id
     WHERE ${R.ROOM_LIVE_SQL} AND s.scheduling = 'window' AND m.status = 'waiting'
       AND m.entry_a IS NOT NULL AND m.entry_b IS NOT NULL AND m.scheduled_at IS NOT NULL AND m.scheduled_at <= ?
     ORDER BY m.scheduled_at, m.id`,
  ).all(new Date(now.getTime() + leadMs).toISOString()) as P.MatchRow[];
  const out: P.MatchRow[] = [];
  const taken = new Map<number, Set<number>>();
  for (const m of rows) {
    if (!taken.has(m.event_id)) taken.set(m.event_id, R.busyEntries(db, m.event_id));
    const busy = taken.get(m.event_id)!;
    const ids = [m.entry_a!, m.entry_b!];
    if (ids.some((id) => busy.has(id) || !N.isActive(N.getEntry(db, id)!))) continue;
    ids.forEach((id) => busy.add(id));
    out.push(m);
  }
  return out;
}
```

In `tick`, before `this.openDue(now);` add `this.schedule(now);` (inside the same try). `openDue` becomes:

```ts
  private openDue(now: Date): void {
    const { db } = this.deps;
    const timers = R.roomTimers(db);
    // Rolling rooms first; a team they make busy is then skipped by the window list (one room per team).
    const due = [...dueRooms(db, now), ...dueWindowRooms(db, now, S.scheduleRules(db).leadMinutes * 60_000)];
    for (const m of due) {
      try {
        const r = R.openRoom(db, { matchId: m.id, by: null, higher: higherSide(db, m), seed: this.deps.seed?.() ?? randomInt(2 ** 31), timers, now });
        if (!r.ok) continue;
        tellRoomOpen(this.deps, m.event_id, m.id);
        this.pushChange(m.id);
      } catch (err) {
        console.error(`[rooms] open of match ${m.id} failed:`, err instanceof Error ? err.message : err);
      }
    }
  }
```

(`dueWindowRooms` is computed after `dueRooms` returns but before any room opens; `openRoom` refuses `entry_busy` for a team the rolling list just made busy, which the `if (!r.ok) continue` covers.) Add the pass:

```ts
  /** Plan T4: the proposals (Rulings 6 and 8). Each is caught on its own. */
  private schedule(now: Date): void {
    const { db } = this.deps;
    for (const p of S.remindersDue(db, now)) {
      try {
        const m = P.getMatch(db, p.event_match_id);
        if (m && S.noteReminded(db, { proposalId: p.id, now }).ok) tellReschedule(this.deps, m.event_id, m.id, 'reminder', p.id);
      } catch (err) { console.error(`[rooms] reminder for proposal ${p.id} failed:`, err instanceof Error ? err.message : err); }
    }
    for (const p of S.autoAcceptDue(db, now)) {
      try {
        const r = S.autoAccept(db, { proposalId: p.id, now });
        if (!r.ok) continue;
        tellTimeLocked(this.deps, r.value.event_id, r.value.id);
        this.pushChange(r.value.id);
      } catch (err) { console.error(`[rooms] auto-accept of proposal ${p.id} failed:`, err instanceof Error ? err.message : err); }
    }
    for (const p of S.staleProposals(db, now)) {
      try {
        if (S.expireProposal(db, { proposalId: p.id, reason: 'time_passed', now }).ok) this.pushChange(p.event_match_id);
      } catch (err) { console.error(`[rooms] expiry of proposal ${p.id} failed:`, err instanceof Error ? err.message : err); }
    }
    for (const m of S.expiredWindows(db, now)) {
      void this.expireWindow(m, now).catch((err) => console.error(`[rooms] window end of match ${m.id} failed:`, err instanceof Error ? err.message : err));
    }
  }

  /** Ruling 8: the silent side forfeits; otherwise staff decide from the proposal log. */
  private async expireWindow(m: P.MatchRow, now: Date): Promise<void> {
    const { db } = this.deps;
    const open = S.openProposal(db, m.id);
    if (open) S.expireProposal(db, { proposalId: open.id, reason: 'window_ended', now });
    const silent = S.silentSide(db, m);
    if (silent !== null) {
      const r = await forfeitMatch(db, { eventId: m.event_id, matchId: m.id, winner: other(silent), now, expect: (x) => x.status === 'waiting' });
      if (r.ok) tellReadyForfeit(this.deps, m.event_id, m.id, 'window');
    } else {
      const r = R.holdMatch(db, { matchId: m.id, by: null, reason: 'window_expired', now });
      if (r.ok) {
        const ev = E.getEvent(db, m.event_id)!;
        const name = (id: number) => N.getEntry(db, id)?.name ?? 'a team';
        publishAdminEvent({
          kind: 'problem',
          text: `Tournament match ${name(m.entry_a!)} vs ${name(m.entry_b!)} (${ev.name}) was not played by the end of its window and is on hold: decide from the proposal log on the match page.`,
          link: { label: 'Open the match room', path: `/event/${ev.slug}/match/${m.id}` },
        });
      }
    }
    this.pushChange(m.id);
  }
```

(`E` is already imported in `roomClock.ts`. The hold runs on the next tick too only if the match is still `waiting`, which it is not once held, so the alert goes out once.)

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/roomClock.test.ts tests/eventRunner.test.ts tests/notify.test.ts tests/series.test.ts tests/schedule.test.ts && npm run typecheck`
Expected: PASS (the series tests still drive rolling rooms; `expect.arrayContaining([A[0], A[4], B[0], B[3]])` matches the roster DM as the room-open test does).

- [ ] **Step 6: Commit**

```bash
git add src/events/roomClock.ts src/events/notices.ts src/events/messages.ts src/notify/notify.ts tests/roomClock.test.ts tests/eventRunner.test.ts tests/notify.test.ts
git commit -m "Tournaments T4: the room clock opens a scheduled match's room at its time minus the lead, locks unanswered proposals, reminds captains a day before the lock, expires stale proposals and at the window end forfeits the silent side or holds the match, with DMs that show times in each reader's zone"
```

---
### Task 5: Capacity kept back for scheduled matches

**Files:**
- Modify: `src/bookings/rules.ts`
- Test: `tests/bookingRules.test.ts`

**Interfaces:**
- Consumes: `capacityProblem`, `bookingsDue`, `iso`, `OPEN_STATES_SQL` (`rules.ts`).
- Produces: `EVENT_SLOT_MINUTES = 120`; `scheduledMatchSlots(db: DB, region: string | null, fromMs: number, toMs: number): { s: number; e: number }[]` (scheduled, unbooked tournament matches of live window stages of live events, in the region when one is given, whose slot overlaps `[fromMs, toMs)`); `capacityProblem` adds the region's slots to its rows; `bookingsDue` adds the count of slots overlapping `[nowMs, nowMs + withinMinutes)`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/bookingRules.test.ts` (inside `describe('capacity')`; `db`, `servers`, `book`, `T0`, `H`, `A` exist; add `scheduledMatchSlots, EVENT_SLOT_MINUTES` to the import):

```ts
  it('keeps a box back for a scheduled tournament match until it is booked, in its region only (plan T4 Ruling 5)', () => {
    servers(3); // room for 1 at a time
    let n = 0;
    const seed = (region: string, scheduledAt: string, over: Record<string, unknown> = {}) => {
      n++;
      const cup = (db.prepare("SELECT id FROM rulesets WHERE name = 'Standard Cup'").get() as { id: number }).id;
      const ev = Number(db.prepare(
        `INSERT INTO events (slug, name, region, organizer_steamid, entry_kind, status, starts_at, eligibility_json, checkin_json, roster_json, created_at, updated_at)
         VALUES (?, 'Cup', ?, ?, 'team', 'live', ?, '{}', '{}', '{}', 'x', 'x')`,
      ).run(`cup-${n}`, region, A, scheduledAt).lastInsertRowid);
      const stage = Number(db.prepare(
        `INSERT INTO event_stages (event_id, ordinal, type, config_json, ruleset_id, campaign_pool_json, veto_type, scheduling, status, created_at, updated_at)
         VALUES (?, 1, 'league', '{}', ?, '[]', 'ban_to_one', 'window', 'live', 'x', 'x')`,
      ).run(ev, cup).lastInsertRowid);
      const row = { event_id: ev, stage_id: stage, round: 1, slot: 1, status: 'waiting', scheduled_at: scheduledAt, created_at: 'x', ...over };
      const cols = Object.keys(row);
      return Number(db.prepare(`INSERT INTO event_matches (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(row)).lastInsertRowid);
    };
    const matchId = seed('na', new Date(T0).toISOString());
    expect(scheduledMatchSlots(db, 'na', T0 - H, T0 + 3 * H)).toEqual([{ s: T0, e: T0 + EVENT_SLOT_MINUTES * 60_000 }]);
    expect(scheduledMatchSlots(db, 'eu', T0 - H, T0 + 3 * H)).toEqual([]);
    expect(scheduledMatchSlots(db, null, T0 + 2 * H, T0 + 3 * H)).toEqual([]);
    expect(capacityProblem(db, { region: 'na', startMs: T0, endMs: T0 + H })).toBe(T0);
    expect(capacityProblem(db, { region: 'na', startMs: T0 + 2 * H, endMs: T0 + 3 * H })).toBeNull();
    expect(capacityProblem(db, { region: 'na', startMs: T0 - H, endMs: T0 + H })).toBe(T0);
    expect(bookingsDue(db, T0 - 74 * 60_000, 75)).toBe(1);
    expect(bookingsDue(db, T0 - 76 * 60_000, 75)).toBe(0);
    expect(bookingsDue(db, T0 + H, 75)).toBe(1);
    expect(bookingsDue(db, T0 + 2 * H, 75)).toBe(0);
    // Booked: the booking row counts, the match no longer does.
    const bookingId = book(T0, T0 + H);
    db.prepare('UPDATE event_matches SET booking_id = ? WHERE id = ?').run(bookingId, matchId);
    expect(scheduledMatchSlots(db, 'na', T0 - H, T0 + 3 * H)).toEqual([]);
    expect(bookingsDue(db, T0 - H, 75)).toBe(0); // a booked match's booking has its box; an unheld scheduled one would count, as before
    // Finished, or in a rolling stage, or of a stage not live: never counted.
    seed('na', new Date(T0 + 4 * H).toISOString(), { status: 'done' });
    expect(scheduledMatchSlots(db, 'na', T0 + 3 * H, T0 + 6 * H)).toEqual([]);
    const rolling = seed('na', new Date(T0 + 4 * H).toISOString());
    db.prepare("UPDATE event_stages SET scheduling = 'rolling' WHERE id = (SELECT stage_id FROM event_matches WHERE id = ?)").run(rolling);
    expect(scheduledMatchSlots(db, 'na', T0 + 3 * H, T0 + 6 * H)).toEqual([]);
  });
```

(`A` is upserted as a player by the file's `beforeEach`, so `organizer_steamid` resolves. The `book()` helper of that file inserts a booking with `server_id` null by default; `bookingsDue` counts a scheduled booking without a box only when it is confirmed and starts within the window, so the last `bookingsDue` expectation depends on `book`'s defaults: `state 'scheduled'`, both sides confirmed, start `T0`. With `nowMs = T0 - H` and 75 minutes the booking is not yet within the window, hence 0. If the helper's defaults differ, adjust the expected count, not the rule.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/bookingRules.test.ts`
Expected: FAIL (`scheduledMatchSlots` undefined).

- [ ] **Step 3: rules.ts**

After `bookingsDue`'s doc comment block (before the function) add:

```ts
/** A scheduled tournament match holds a box this long from its time
 *  (tournaments plan T4 Ruling 5): a Bo1 with setup, the grace to connect
 *  and a possible tiebreak. */
export const EVENT_SLOT_MINUTES = 120;

/**
 * Scheduled tournament matches not yet booked, as slots (plan T4 Ruling 5):
 * each waits in a live window stage of a live event with a time and no
 * booking (pending, waiting, or in its room before the booking is made),
 * and holds EVENT_SLOT_MINUTES from its time. Once the series engine books
 * it, the booking row counts instead. With a region, that region's events
 * only. Only slots overlapping [fromMs, toMs) come back.
 */
export function scheduledMatchSlots(db: DB, region: string | null, fromMs: number, toMs: number): { s: number; e: number }[] {
  const slot = EVENT_SLOT_MINUTES * 60_000;
  return (db.prepare(
    `SELECT m.scheduled_at FROM event_matches m
       JOIN event_stages s ON s.id = m.stage_id JOIN events e ON e.id = m.event_id
      WHERE e.status = 'live' AND s.status = 'live' AND s.scheduling = 'window' AND m.booking_id IS NULL
        AND m.status IN ('pending', 'waiting', 'veto', 'lineup', 'booking') AND m.scheduled_at IS NOT NULL
        AND (? IS NULL OR e.region = ?) AND m.scheduled_at < ? AND m.scheduled_at > ?
      ORDER BY m.scheduled_at, m.id`,
  ).all(region, region, iso(toMs), iso(fromMs - slot)) as { scheduled_at: string }[])
    .map((r) => { const s = Date.parse(r.scheduled_at); return { s, e: s + slot }; });
}
```

In `capacityProblem`, the `rows` become:

```ts
  const rows = [
    ...(db.prepare(
      `SELECT starts_at, ends_at FROM bookings
        WHERE region = ? AND state IN ${OPEN_STATES_SQL} AND ending_at IS NULL AND id != ?
          AND starts_at < ? AND ends_at > ?`,
    ).all(o.region, o.exceptId ?? 0, iso(o.endMs), iso(o.startMs)) as { starts_at: string; ends_at: string }[])
      .map((r) => ({ s: Date.parse(r.starts_at), e: Date.parse(r.ends_at) })),
    // Plan T4 Ruling 5: a scheduled tournament match holds a box before it is booked.
    ...scheduledMatchSlots(db, o.region, o.startMs, o.endMs),
  ];
```

`bookingsDue` returns its count plus the matches: wrap the existing expression as `const bookings = (...).n;` and `return bookings + scheduledMatchSlots(db, null, nowMs, nowMs + withinMinutes * 60_000).length;`, with the doc comment gaining "and one per scheduled tournament match not yet booked whose slot starts within the window (plan T4 Ruling 5)".

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/bookingRules.test.ts tests/bookings.test.ts tests/scrim*.test.ts tests/serverPool.test.ts tests/practice*.test.ts tests/sideGame*.test.ts && npm run typecheck`
Expected: PASS (no scheduled match exists in those suites, so the counts are unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/bookings/rules.ts tests/bookingRules.test.ts
git commit -m "Tournaments T4: a scheduled tournament match keeps a box back two hours from its time until the series engine books it, against scrims through the capacity rule and against PUGs, side games and practice through the boxes due"
```

---
### Task 6: The views

**Files:**
- Modify: `src/events/roomViews.ts`, `src/events/playViews.ts`, `src/routes/adminEvents.ts` (`AdminEventStage` and `adminEventDetail` only)
- Test: `tests/roomViews.test.ts`, `tests/eventPlayRoutes.test.ts`

**Interfaces:**
- Consumes: `proposalsOf`, `openProposal`, `scheduleRules`, `RescheduleRow` (`schedule.ts`); `scheduleOf`, `stageSettingsOf` (`events.ts`); `roundTimes`, `totalRounds` (`play.ts`); `sideOf` (`room.ts`); `getPlayer`.
- Produces:
  - `roomViews.ts`: `interface RoomProposal { id: number; side: 'a' | 'b'; byName: string; time: string; note: string; createdAt: string; autoAcceptAt: string | null; status: RescheduleStatus; respondedByName: string | null; respondedAt: string | null }`; `interface RoomSchedule { scheduledAt: string | null; source: 'default' | 'agreed' | 'staff' | null; windowStart: string | null; windowEnd: string | null; opensAt: string | null; leadMinutes: number; proposal: RoomProposal | null; log: RoomProposal[]; canPropose: boolean; canAnswer: boolean; canWithdraw: boolean }`; `MatchRoomView.schedule: RoomSchedule | null` (null for a rolling stage).
  - `playViews.ts`: `PlayMatch.scheduledAt: string | null`, `PlayMatch.scheduleSource: 'default' | 'agreed' | 'staff' | null`; `PlayRound.defaultAt: string | null` (a window round's default time, or a rolling round's date), `PlayRound.window: { from: string; to: string } | null`; `PlayMatchDesk.schedule: { windowStart: string | null; windowEnd: string | null; proposal: { side: 'a' | 'b'; byName: string; time: string; autoAcceptAt: string | null } | null; proposals: number } | null` (window stages only).
  - `adminEvents.ts`: `AdminEventStage.schedule: V.RoundSchedule[]` and `AdminEventStage.roundsKnown: number | null` (the rounds the stage will have, when known: Swiss `rounds`, league `matches`, else the highest existing round or null).

- [ ] **Step 1: Write the failing tests**

Append to `tests/roomViews.test.ts` (inside `describe('matchRoomView')`; add `windowFixture` to the roomFixture import and `import * as S from '../src/events/schedule.js';`):

```ts
  it('shows the schedule of a window match to everyone, and what the viewer may do (plan T4)', async () => {
    const f = await windowFixture();
    const time = at(72 * 60).toISOString();
    expect(view(f, null).schedule).toMatchObject({ scheduledAt: null, source: null, windowStart: NOW.toISOString(), opensAt: null, leadMinutes: 20, proposal: null, log: [], canPropose: false, canAnswer: false, canWithdraw: false });
    expect(view(f, A[0]).schedule).toMatchObject({ canPropose: true, canAnswer: false, canWithdraw: false });
    expect(view(f, A[3]).schedule!.canPropose).toBe(false);
    const p = S.proposeTime(f.db, { matchId: f.matchId, by: A[0], time, note: 'late', rules: { autoAcceptHours: 24, leadMinutes: 20 }, now: NOW });
    if (!p.ok) throw new Error(p.error);
    const a = view(f, A[0]).schedule!;
    expect(a.proposal).toMatchObject({ id: p.value.id, side: 'a', time, note: 'late', autoAcceptAt: at(24 * 60).toISOString(), status: 'open', respondedByName: null });
    expect(a.proposal!.byName).toBe((await import('../src/players.js')).getPlayer(f.db, A[0])!.name);
    expect([a.canPropose, a.canAnswer, a.canWithdraw]).toEqual([false, false, true]);
    const b = view(f, B[0]).schedule!;
    expect([b.canPropose, b.canAnswer, b.canWithdraw]).toEqual([false, true, false]);
    S.respondProposal(f.db, { matchId: f.matchId, by: B[0], accept: true, now: at(1) });
    const after = view(f, null).schedule!;
    expect(after).toMatchObject({ scheduledAt: time, source: 'agreed', opensAt: at(72 * 60 - 20).toISOString(), proposal: null });
    expect(after.log.map((l) => [l.status, l.respondedByName !== null])).toEqual([['accepted', true]]);
    const g = await roomFixture();
    expect(view(g, A[0]).schedule).toBeNull();
  });
```

Append to `tests/eventPlayRoutes.test.ts` (find its `describe` over the public `/api/events/:slug` play view and the desk's `/play`; it builds a live event through `playFixture` or the HTTP routes; follow its own helpers for the event and stage, the test below assumes `app`, `call`/`get`, an admin cookie and a league event; adapt names):

```ts
  it('carries round times, windows and each match\'s time on the public play view and the desk (plan T4)', async () => {
    const f = playFixture({ stages: [LEAGUE(2, 1, 'round_robin', null, '2026-10-12')], entries: 2 });
    const { startEventFlow } = await import('../src/events/flow.js');
    await startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW });
    E.setRoundSchedule(f.db, { eventId: f.eventId, stageId: f.stages[0]!, by: ADMIN, rounds: [{ round: 1, at: '2026-10-14T21:00:00Z', from: '2026-10-12T00:00:00Z', to: '2026-10-18T23:59:59Z' }], now: NOW });
    P.applySchedule(f.db, { stageId: f.stages[0]!, by: ADMIN, now: NOW });
    const ev = E.getEvent(f.db, f.eventId)!;
    const views = stagePlayViews(f.db, ev);
    expect(views[0]!.rounds[0]).toMatchObject({ round: 1, defaultAt: '2026-10-14T21:00:00.000Z', window: { from: '2026-10-12T00:00:00.000Z', to: '2026-10-18T23:59:59.000Z' } });
    expect(views[0]!.rounds[0]!.matches[0]).toMatchObject({ scheduledAt: '2026-10-14T21:00:00.000Z', scheduleSource: 'default' });
    expect(views[0]!.rounds[1]).toMatchObject({ round: 2, defaultAt: null, window: { from: '2026-10-19T00:00:00.000Z', to: '2026-10-25T23:59:59.000Z' } });
    expect(views[0]!.rounds[0]!.matches[0]!.desk).toBeUndefined();
    const desk = stagePlayViews(f.db, ev, { staff: true })[0]!.rounds[0]!.matches[0]!.desk!;
    expect(desk.schedule).toEqual({ windowStart: '2026-10-12T00:00:00.000Z', windowEnd: '2026-10-18T23:59:59.000Z', proposal: null, proposals: 0 });
    const se = playFixture({ stages: [SE()], entries: 4 });
    E.setRoundSchedule(se.db, { eventId: se.eventId, stageId: se.stages[0]!, by: ADMIN, rounds: [{ round: 2, at: '2026-10-24T21:00:00Z' }], now: NOW });
    await startEventFlow(se.db, { eventId: se.eventId, by: ADMIN, now: NOW });
    const bracket = stagePlayViews(se.db, E.getEvent(se.db, se.eventId)!)[0]!;
    expect(bracket.rounds.find((r) => r.round === 2)).toMatchObject({ defaultAt: '2026-10-24T21:00:00.000Z', window: null });
    expect(bracket.rounds.find((r) => r.round === 2)!.matches[0]!.scheduledAt).toBeNull();
    expect(stagePlayViews(se.db, E.getEvent(se.db, se.eventId)!, { staff: true })[0]!.rounds[0]!.matches[0]!.desk!.schedule).toBeNull();
  });
```

(Imports the file may lack: `stagePlayViews` from `../src/events/playViews.js`, `LEAGUE`, `SE`, `playFixture` from `./playFixture.js`, `E`, `P`, `ADMIN`, `NOW`.) Also add to `tests/adminEventRoutes.test.ts`, inside the `describe` that reads an event's detail (`GET /api/admin/events/:id`):

```ts
  it('lists each stage\'s round schedule and how many rounds it will have (plan T4)', async () => {
    const { id } = (await call('POST', '/api/admin/events', ADMIN, { name: 'Riverside League', startsAt: start(), entryKind: 'team' })).json();
    await call('POST', `/api/admin/events/${id}/stages`, ADMIN, { type: 'league', config: { matches: 6, matchesPerWeek: 2, pairing: 'swiss', seasonStart: '2026-10-12' }, rulesetId: cup() });
    await call('POST', `/api/admin/events/${id}/stages`, ADMIN, { type: 'single_elim', rulesetId: cup() });
    const stages = (await call('GET', `/api/admin/events/${id}`, MOD)).json().stages;
    expect(stages[0]).toMatchObject({ schedule: [], roundsKnown: 6 });
    expect(stages[1]).toMatchObject({ schedule: [], roundsKnown: null });
  });
```

(The first stage needs an `advanceCount` only at publish; `addStage` takes it without one.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/roomViews.test.ts tests/eventPlayRoutes.test.ts tests/adminEventRoutes.test.ts`
Expected: FAIL (no `schedule` on the views, no `defaultAt`, no `roundsKnown`).

- [ ] **Step 3: roomViews.ts**

Add imports `import { openProposal, proposalsOf, scheduleRules, type RescheduleRow, type RescheduleStatus } from './schedule.js';`. After `RoomPlayer` add:

```ts
/** One reschedule proposal as the room page lists it (plan T4). */
export interface RoomProposal {
  id: number; side: 'a' | 'b'; byName: string; time: string; note: string; createdAt: string; autoAcceptAt: string | null;
  status: RescheduleStatus; respondedByName: string | null; respondedAt: string | null;
}
/** The schedule of a window-stage match (plan T4 Ruling 12); null on a rolling stage. */
export interface RoomSchedule {
  scheduledAt: string | null; source: 'default' | 'agreed' | 'staff' | null; windowStart: string | null; windowEnd: string | null;
  /** scheduledAt minus the lead: when the room opens on its own. */
  opensAt: string | null; leadMinutes: number;
  proposal: RoomProposal | null; log: RoomProposal[];
  canPropose: boolean; canAnswer: boolean; canWithdraw: boolean;
}
```

Add `schedule: RoomSchedule | null;` to `MatchRoomView` after `frozen`. In `matchRoomView`, before the `return`, build it (the function already has `settings`, `m`, `viewer`, `now`, and `me`'s side where `me` is computed; use `sideOf(db, m, viewer)` directly):

```ts
  let schedule: RoomSchedule | null = null;
  if (settings.scheduling === 'window') {
    const lead = scheduleRules(db).leadMinutes;
    const toView = (p: RescheduleRow): RoomProposal => ({
      id: p.id, side: p.side, byName: getPlayer(db, p.proposed_by)?.name ?? 'a captain', time: p.proposed_time, note: p.note, createdAt: p.created_at,
      autoAcceptAt: p.auto_accept_at, status: p.status,
      respondedByName: p.responded_by === null ? null : getPlayer(db, p.responded_by)?.name ?? (staff ? 'staff' : 'a captain'), respondedAt: p.responded_at,
    });
    const open = openProposal(db, m.id);
    const mySide = viewer ? R.sideOf(db, m, viewer) : null;
    const at = now.toISOString();
    const schedulable = m.status === 'waiting' && m.window_start !== null && m.window_end !== null && m.window_end > at;
    schedule = {
      scheduledAt: m.scheduled_at, source: m.schedule_source, windowStart: m.window_start, windowEnd: m.window_end,
      opensAt: m.scheduled_at === null ? null : new Date(Date.parse(m.scheduled_at) - lead * 60_000).toISOString(), leadMinutes: lead,
      proposal: open ? toView(open) : null,
      log: proposalsOf(db, m.id).filter((p) => p.status !== 'open').map(toView),
      canPropose: schedulable && mySide !== null && !open,
      canAnswer: schedulable && mySide !== null && !!open && open.side !== mySide,
      canWithdraw: schedulable && mySide !== null && !!open && open.side === mySide,
    };
  }
```

and `schedule,` in the returned object. (`R.sideOf` is already imported as `R`; check the file's import style and use what it has.)

- [ ] **Step 4: playViews.ts**

`PlayMatch` gains `scheduledAt: string | null; scheduleSource: 'default' | 'agreed' | 'staff' | null;` after `phase`. `PlayRound` gains `defaultAt: string | null; window: { from: string; to: string } | null;` after `dates`, with the comment: "defaultAt: a window round's default time or a rolling round's date (plan T4 Rulings 2 and 3); window: the round's window on a window stage". `PlayMatchDesk` gains:

```ts
  /** Plan T4: a window stage's match only. */
  schedule: { windowStart: string | null; windowEnd: string | null; proposal: { side: 'a' | 'b'; byName: string; time: string; autoAcceptAt: string | null } | null; proposals: number } | null;
```

Add `import { openProposal, proposalsOf } from './schedule.js';`. In `stageLabels`, add to the returned object:

```ts
    times: (round: number) => {
      const t = P.roundTimes(s, round, (s.started_at ?? ev.starts_at));
      return { defaultAt: t.at, window: t.from !== null && t.to !== null ? { from: t.from, to: t.to } : null };
    },
```

In `deskOf(db, m)` add a `stage` lookup (`const stage = E.getStage(db, m.stage_id)!;`) and the field:

```ts
    schedule: stage.scheduling !== 'window' ? null : (() => {
      const p = openProposal(db, m.id);
      return {
        windowStart: m.window_start, windowEnd: m.window_end,
        proposal: p ? { side: p.side, byName: getPlayer(db, p.proposed_by)?.name ?? 'a captain', time: p.proposed_time, autoAcceptAt: p.auto_accept_at } : null,
        proposals: proposalsOf(db, m.id).length,
      };
    })(),
```

In `stagePlayViews`, destructure `times` too, build each round as `{ group: m.grp, round: m.round, label: label(m.grp, m.round), dates: dates(m.round), ...times(m.round), matches: [] }`, and each row with `scheduledAt: m.scheduled_at, scheduleSource: m.schedule_source,` after `phase`.

- [ ] **Step 5: adminEvents.ts**

`AdminEventStage` gains `schedule: V.RoundSchedule[]; roundsKnown: number | null;`. In `adminEventDetail`'s stage map:

```ts
      const ms = P.matchesOf(db, s.id);
      const known = P.totalRounds(s) ?? (ms.length > 0 ? Math.max(...ms.map((m) => m.round)) : null);
      return { id: s.id, ordinal: s.ordinal, summary: stageSummary(settings.type, settings.config, settings.advanceCount), settings, rulesSnapshotted: s.rules_json !== null, schedule: E.scheduleOf(s), roundsKnown: known };
```

(`totalRounds` returns the Swiss round count or a Swiss-paired league's match count; a round robin league returns null there, so its `matches` is read from the config: add `?? (settings.type === 'league' ? (settings.config as V.StageConfigs['league']).matches : null)` before the existing-rounds fallback.)

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/roomViews.test.ts tests/eventPlayRoutes.test.ts tests/adminEventRoutes.test.ts tests/eventRoomRoutes.test.ts tests/series.test.ts && npm run typecheck`
Expected: PASS on the server; the web typecheck fails until Task 8 mirrors the types (run `npm run typecheck` again after Task 8, or run only the server typecheck here: see `package.json` for the script's two halves).

- [ ] **Step 7: Commit**

```bash
git add src/events/roomViews.ts src/events/playViews.ts src/routes/adminEvents.ts tests/roomViews.test.ts tests/eventPlayRoutes.test.ts tests/adminEventRoutes.test.ts
git commit -m "Tournaments T4: the room view carries a window match's schedule, proposal and log with what the viewer may do, the play views carry round times, windows and each match's time, and the desk detail carries each stage's round schedule"
```

---
### Task 7: The routes

**Files:**
- Modify: `src/routes/events.ts`, `src/routes/adminEvents.ts`
- Test: `tests/eventRoomRoutes.test.ts`, `tests/adminEventRoutes.test.ts`

**Interfaces:**
- Consumes: `proposeTime`, `respondProposal`, `counterProposal`, `withdrawProposal`, `staffSetTime`, `scheduleRules` (`schedule.ts`); `setRoundSchedule` (`events.ts`); `applySchedule`, `matchesOf` (`play.ts`); `tellReschedule`, `tellTimeLocked` (`notices.ts`); `logAdmin`; `RoomClock.pushChange`.
- Produces:
  - Public: `POST /api/events/:slug/matches/:id/propose { time, note? }`, `/respond { accept: boolean }`, `/counter { time, note? }`, `/withdraw`; each an active player the switch lets in, refused with the sentence of `EVENT_ERRORS`, then the DM of Ruling 11 and a push.
  - Admin: `POST /api/admin/events/:id/stages/:stageId/schedule { rounds }` (admins; `setRoundSchedule`, then `applySchedule` when the stage has started; `logAdmin('event_schedule_set', ...)`; a push for every waiting match of the stage); `POST /api/admin/events/:id/matches/:matchId/set-time { time }` (`staffSetTime`; `tellTimeLocked(..., true)`; `logAdmin('event_match_time', ...)`; push).

- [ ] **Step 1: Write the failing tests**

Append to `tests/eventRoomRoutes.test.ts` (new `describe`; add `windowFixture` to the roomFixture import and `import * as S from '../src/events/schedule.js';`; `f` is rebuilt by `beforeEach` as a rolling room, so the test turns it into a window one as `windowFixture` does):

```ts
describe('reschedules over HTTP (plan T4)', () => {
  const toWindow = () => {
    f.db.prepare("UPDATE event_stages SET scheduling = 'window' WHERE id = ?").run(f.stageId);
    f.db.prepare('UPDATE event_matches SET window_start = ?, window_end = ? WHERE id = ?').run(days(0), days(7), f.matchId);
  };
  const dm = () => vi.spyOn((app as unknown as { notifier?: { send: (...a: unknown[]) => number } }).notifier ?? { send: () => 0 }, 'send');

  it('proposes, counters, withdraws and answers through the routes, with the DMs and the sentences', async () => {
    toWindow();
    const time = days(3);
    const t4 = days(4);
    const t5 = days(5);
    expect((await post(`${room()}/propose`, OUTSIDER, { time })).json()).toEqual({ error: EVENT_ERRORS.not_manager.text });
    expect((await post(`${room()}/propose`, A[0], { time: 'soon' })).json()).toEqual({ error: EVENT_ERRORS.bad_time.text });
    expect((await post(`${room()}/propose`, A[0], { time, note: 'after work' })).statusCode).toBe(200);
    expect((await post(`${room()}/propose`, B[0], { time })).json()).toEqual({ error: EVENT_ERRORS.proposal_open.text });
    expect((await get(room(), B[0])).json().schedule).toMatchObject({ proposal: { side: 'a', note: 'after work' }, canAnswer: true });
    expect((await post(`${room()}/respond`, A[0], { accept: true })).json()).toEqual({ error: EVENT_ERRORS.own_proposal.text });
    expect((await post(`${room()}/withdraw`, B[0])).json()).toEqual({ error: EVENT_ERRORS.not_your_proposal.text });
    expect((await post(`${room()}/counter`, B[0], { time: t4 })).statusCode).toBe(200);
    expect(S.proposalsOf(f.db, f.matchId).map((p) => [p.side, p.status])).toEqual([['a', 'countered'], ['b', 'open']]);
    expect((await post(`${room()}/withdraw`, B[0])).statusCode).toBe(200);
    expect((await post(`${room()}/respond`, A[0], { accept: true })).json()).toEqual({ error: EVENT_ERRORS.no_proposal.text });
    expect((await post(`${room()}/propose`, B[0], { time: t5 })).statusCode).toBe(200);
    expect((await post(`${room()}/respond`, A[1], { accept: 'yes' })).statusCode).toBe(400);
    expect((await post(`${room()}/respond`, A[1], { accept: true })).statusCode).toBe(200);
    const v = (await get(room())).json();
    expect(v.schedule).toMatchObject({ scheduledAt: t5, source: 'agreed', proposal: null });
    expect(v.schedule.log).toHaveLength(3);
  });

  it('refuses every reschedule route on a rolling stage, and signed out', async () => {
    expect((await post(`${room()}/propose`, A[0], { time: days(3) })).json()).toEqual({ error: EVENT_ERRORS.not_schedulable.text });
    expect((await app.inject({ method: 'POST', url: `${room()}/propose`, payload: { time: days(3) } })).statusCode).toBe(401);
  });

  it('staff set a time and the round schedule from the desk, admin only, with audit rows', async () => {
    toWindow();
    const base = `/api/admin/events/${f.eventId}`;
    const t2 = days(2);
    const t3 = days(3);
    const t7 = days(7);
    const t0 = P.getMatch(f.db, f.matchId)!.window_start!;
    expect((await post(`${base}/matches/${f.matchId}/set-time`, A[0], { time: t2 })).statusCode).toBe(403);
    expect((await post(`${base}/matches/${f.matchId}/set-time`, ADMIN, { time: 'x' })).json()).toEqual({ error: EVENT_ERRORS.bad_time.text });
    expect((await post(`${base}/matches/${f.matchId}/set-time`, ADMIN, { time: t2 })).statusCode).toBe(200);
    expect(P.getMatch(f.db, f.matchId)).toMatchObject({ scheduled_at: t2, schedule_source: 'staff' });
    const rounds = [{ round: 1, at: t3, from: t0, to: t7 }];
    expect((await post(`${base}/stages/${f.stageId}/schedule`, A[0], { rounds })).statusCode).toBe(403);
    expect((await post(`${base}/stages/${f.stageId}/schedule`, ADMIN, { rounds: 'x' })).json()).toEqual({ error: EVENT_ERRORS.bad_schedule.text });
    expect((await post(`${base}/stages/${f.stageId}/schedule`, ADMIN, { rounds })).statusCode).toBe(200);
    expect(E.scheduleOf(E.getStage(f.db, f.stageId)!)).toEqual([{ round: 1, at: t3, from: t0, to: t7 }]);
    // Applied at once on a live stage: the window follows; the staff-set time is kept.
    expect(P.getMatch(f.db, f.matchId)).toMatchObject({ scheduled_at: t2, schedule_source: 'staff', window_end: t7 });
    expect(f.db.prepare("SELECT action FROM admin_actions WHERE action IN ('event_match_time', 'event_schedule_set') ORDER BY id").all())
      .toEqual([{ action: 'event_match_time' }, { action: 'event_schedule_set' }]);
    expect((await post(`${base}/stages/999/schedule`, ADMIN, { rounds })).statusCode).toBe(404);
  });
});
```

(`days(n)` in that file returns an ISO string `n` days from now, computed from `Date.now()` on every call, which is why each time is taken once into a constant; `parseTime` round-trips a full `toISOString` unchanged. The `dm` helper is not needed if the file has no notifier; drop it. The `admin_actions` table and column names: check `src/admin/audit.ts` `logAdmin` for the exact table and column, and adapt the query.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/eventRoomRoutes.test.ts`
Expected: FAIL (404 on the new routes).

- [ ] **Step 3: events.ts (routes)**

Add `import * as S from '../events/schedule.js';` and extend the notices import with `tellReschedule, tellTimeLocked`. After the `ready | veto | lineup | confirm | dispute` loop add:

```ts
  /** Reschedule proposals (plan T4 Ruling 7). The DM goes to the side that must act next; every change pushes the room. */
  for (const action of ['propose', 'respond', 'counter', 'withdraw'] as const) {
    app.post(`/api/events/:slug/matches/:id/${action}`, async (req, reply) => {
      const me = allowedActive(req, reply);
      if (!me) return;
      const p = req.params as SlugId;
      const ev = visibleEvent(p.slug, me);
      const m = ev && matchIn(ev, p.id);
      if (!ev || !m) return refuse(reply, { error: 'match_not_found' });
      const body = (req.body ?? {}) as { time?: unknown; note?: unknown; accept?: unknown };
      const rules = S.scheduleRules(db);
      if (action === 'propose' || action === 'counter') {
        const r = action === 'propose'
          ? S.proposeTime(db, { matchId: m.id, by: me, time: body.time, note: body.note, rules })
          : S.counterProposal(db, { matchId: m.id, by: me, time: body.time, note: body.note, rules });
        if (!r.ok) return refuse(reply, r);
        tellReschedule(opts, ev.id, m.id, action === 'propose' ? 'proposed' : 'countered', r.value.id);
      } else if (action === 'respond') {
        if (typeof body.accept !== 'boolean') return refuse(reply, { error: 'bad_request' });
        const r = S.respondProposal(db, { matchId: m.id, by: me, accept: body.accept });
        if (!r.ok) return refuse(reply, r);
        if (body.accept) tellTimeLocked(opts, ev.id, m.id);
        else tellReschedule(opts, ev.id, m.id, 'declined', r.value.proposal.id);
      } else {
        const r = S.withdrawProposal(db, { matchId: m.id, by: me });
        if (!r.ok) return refuse(reply, r);
        tellReschedule(opts, ev.id, m.id, 'withdrawn', r.value.id);
      }
      opts.rooms?.pushChange(m.id);
      return {};
    });
  }
```

- [ ] **Step 4: adminEvents.ts**

Add `import * as S from '../events/schedule.js';` and extend the notices import with `tellTimeLocked`. After the `roomAction(...)` calls add:

```ts
  /** Plan T4 Ruling 10: the stage's round schedule, applied at once on a started stage. */
  app.post('/api/admin/events/:id/stages/:stageId/schedule', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const p = req.params as { id: string; stageId: string };
    const ev = eventOf(p.id);
    const stageId = idOf(p.stageId);
    if (!ev) return refuse(reply, 'not_found');
    if (stageId === null) return refuse(reply, 'stage_not_found');
    const r = E.setRoundSchedule(db, { eventId: ev.id, stageId, by: me, rounds: ((req.body ?? {}) as { rounds?: unknown }).rounds });
    if (!r.ok) return refuse(reply, r.error);
    let stamped = 0;
    if (r.value.status !== 'pending') {
      const a = P.applySchedule(db, { stageId, by: me });
      if (a.ok) stamped = a.value.stamped;
      else console.error(`[events] applying the schedule of stage ${stageId} refused: ${a.error}`);
      for (const m of P.matchesOf(db, stageId)) if (m.status === 'waiting') opts.rooms?.pushChange(m.id);
    }
    logAdmin(db, me, 'event_schedule_set', ev.id, { stageId, rounds: E.scheduleOf(r.value).map((x) => x.round), stamped });
    return { stamped };
  });

  /** Plan T4 Ruling 10: staff set a match time outright. */
  app.post('/api/admin/events/:id/matches/:matchId/set-time', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const p = req.params as { id: string; matchId: string };
    const ev = eventOf(p.id);
    const matchId = idOf(p.matchId);
    const m = ev && matchId !== null ? P.getMatch(db, matchId) : undefined;
    if (!ev || !m || m.event_id !== ev.id) return refuse(reply, 'match_not_found');
    const r = S.staffSetTime(db, { matchId: m.id, by: me, time: ((req.body ?? {}) as { time?: unknown }).time });
    if (!r.ok) return refuse(reply, r.error);
    tellTimeLocked(opts, ev.id, m.id, true);
    opts.rooms?.pushChange(m.id);
    logAdmin(db, me, 'event_match_time', ev.id, { matchId: m.id, time: r.value.scheduled_at, was: m.scheduled_at });
    return {};
  });
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/eventRoomRoutes.test.ts tests/adminEventRoutes.test.ts tests/eventRoutes.test.ts tests/eventGating.test.ts && npm run typecheck`
Expected: PASS on the server (the web typecheck still waits on Task 8).

- [ ] **Step 6: Commit**

```bash
git add src/routes/events.ts src/routes/adminEvents.ts tests/eventRoomRoutes.test.ts
git commit -m "Tournaments T4: captains propose, answer, counter and withdraw match times through the room routes, and the desk sets a stage's round schedule and a match's time, each audited and pushed"
```

---
### Task 8: The web: the Schedule panel, times on the event page, the Round schedule editor and Set time on the desk

**Files:**
- Create: `web/src/routes/event/room/SchedulePanel.tsx`, `web/src/routes/event/room/SchedulePanel.test.tsx`, `web/src/routes/admin/events/RoundScheduleForm.tsx`, `web/src/routes/admin/events/RoundScheduleForm.test.tsx`
- Modify: `web/src/api.ts`, `web/src/eventFormat.ts`, `web/src/routes/EventMatch.tsx`, `web/src/routes/event/StagePlay.tsx`, `web/src/routes/event/Bracket.tsx`, `web/src/routes/admin/events/EventEditor.tsx`, `web/src/routes/admin/events/PlayPanel.tsx`, `web/src/styles/app.css`, and the six `MatchRoomView` test builders (`schedule: null`)
- Test: `web/src/routes/event/StagePlay.test.tsx`, `web/src/routes/admin/events/PlayPanel.test.tsx`, `web/src/routes/admin/events/EventEditor.test.tsx`, `web/src/eventFormat.test.ts` (if present; else `tests/eventFormat.test.ts`)

**Interfaces:**
- Consumes: `whenText`, `toLocalInput`, `fromLocalInput`, `weekRangeText`, `groupPrefix` (`eventFormat.ts`); `weeklyRoundTimes`, `leagueWeeks` (`src/events/league.ts`, already importable from the web); `Run`, `useAction`; `FormRow`, `FormGroup`; `Panel`, `Empty`; `PHASE_TEXT`.
- Produces:
  - `api.ts`: `RescheduleStatus`, `RoomProposal`, `RoomSchedule`, `MatchRoomView.schedule`, `PlayMatch.scheduledAt`/`scheduleSource`, `PlayRound.defaultAt`/`window`, `PlayMatchDesk.schedule`, `RoundSchedule`, `AdminEventStage.schedule`/`roundsKnown`; `eventsApi.propose(slug, id, time, note)`, `respond(slug, id, accept)`, `counter(slug, id, time, note)`, `withdraw(slug, id)`; `adminApi.setRoundSchedule(id, stageId, rounds)`, `setEventMatchTime(id, matchId, time)`.
  - `eventFormat.ts`: `playByText(iso: string): string` ("play by Sun, Oct 18, 23:59" in the viewer's zone).
  - `SchedulePanel({ v, busy, onPropose, onRespond, onCounter, onWithdraw })`.
  - `RoundScheduleForm({ stage, scheduling, league, seasonStart, busy, onSave })` with the weekly fill.
  - `PlayPanel`: `DeskLine` shows the time, the window and the open proposal; `DeskTools` offers Set time on a waiting window match.

- [ ] **Step 1: Write the failing tests**

`web/src/routes/event/room/SchedulePanel.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import type { MatchRoomView, RoomSchedule } from '../../../api';
import { SchedulePanel } from './SchedulePanel';
import { whenText } from '../../../eventFormat';

afterEach(cleanup);

const TIME = '2026-10-14T21:00:00.000Z';
const schedule = (over: Partial<RoomSchedule> = {}): RoomSchedule => ({
  scheduledAt: null, source: null, windowStart: '2026-10-12T00:00:00.000Z', windowEnd: '2026-10-18T23:59:59.000Z', opensAt: null, leadMinutes: 20,
  proposal: null, log: [], canPropose: false, canAnswer: false, canWithdraw: false, ...over,
});
const view = (s: RoomSchedule): MatchRoomView => ({
  id: 1, eventSlug: 'cup', eventName: 'Cup', roundLabel: 'Week 1',
  a: { id: 1, name: 'Rats', tag: 'RAT', logoKey: null, seed: 1, out: false }, b: { id: 2, name: 'Bats', tag: 'BAT', logoKey: null, seed: 2, out: false },
  phase: 'waiting', higher: null, deadline: null, serverNow: TIME, ready: { a: false, b: false }, vetoSummary: '', pool: [], log: [], games: [], next: null,
  lineups: { a: null, b: null, aLocked: false, bLocked: false }, holdReason: null, result: null, me: null, series: null, server: null, confirm: null, dispute: null, frozen: false,
  schedule: s,
});
const handlers = () => ({ onPropose: vi.fn(), onRespond: vi.fn(), onCounter: vi.fn(), onWithdraw: vi.fn() });

describe('SchedulePanel', () => {
  it('shows no time yet and the window, and a propose form for a manager', () => {
    const h = handlers();
    render(<SchedulePanel v={view(schedule({ canPropose: true }))} busy={false} {...h} />);
    expect(screen.getByText(/No time is set yet/)).toBeTruthy();
    expect(screen.getByText(new RegExp(whenText('2026-10-18T23:59:59.000Z').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeTruthy();
    fireEvent.input(screen.getByLabelText('Proposed time'), { target: { value: '2026-10-14T21:00' } });
    fireEvent.input(screen.getByLabelText('Note'), { target: { value: 'after work' } });
    fireEvent.click(screen.getByRole('button', { name: 'Propose this time' }));
    expect(h.onPropose).toHaveBeenCalledWith(new Date('2026-10-14T21:00').toISOString(), 'after work');
  });

  it('shows the locked time with when the room opens, and the open proposal with Accept, Decline and Counter for the other side', () => {
    const h = handlers();
    const p = { id: 5, side: 'a' as const, byName: 'alice', time: TIME, note: 'late', createdAt: '2026-10-10T10:00:00.000Z', autoAcceptAt: '2026-10-11T10:00:00.000Z', status: 'open' as const, respondedByName: null, respondedAt: null };
    render(<SchedulePanel v={view(schedule({ scheduledAt: '2026-10-13T20:00:00.000Z', source: 'default', opensAt: '2026-10-13T19:40:00.000Z', proposal: p, canAnswer: true }))} busy={false} {...h} />);
    expect(screen.getByText(/room opens 20 minutes before/)).toBeTruthy();
    expect(screen.getByText(/alice \(Rats\) proposes/)).toBeTruthy();
    expect(screen.getByText(/locks on/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(h.onRespond).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(h.onRespond).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: 'Counter' }));
    fireEvent.input(screen.getByLabelText('Proposed time'), { target: { value: '2026-10-15T21:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Counter with this time' }));
    expect(h.onCounter).toHaveBeenCalledWith(new Date('2026-10-15T21:00').toISOString(), '');
  });

  it('offers Withdraw to the proposing side and lists the log', () => {
    const h = handlers();
    const p = { id: 5, side: 'b' as const, byName: 'bob', time: TIME, note: '', createdAt: '2026-10-10T10:00:00.000Z', autoAcceptAt: null, status: 'open' as const, respondedByName: null, respondedAt: null };
    const old = { ...p, id: 4, status: 'declined' as const, respondedByName: 'alice', respondedAt: '2026-10-10T11:00:00.000Z' };
    render(<SchedulePanel v={view(schedule({ proposal: p, canWithdraw: true, log: [old] }))} busy={false} {...h} />);
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    expect(h.onWithdraw).toHaveBeenCalled();
    expect(screen.getByText(/declined by alice/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });
});
```

Append to `web/src/routes/event/StagePlay.test.tsx` (inside `describe('StagePlay')`; the `match` builder there gets `scheduledAt: null, scheduleSource: null` in its defaults, and every `rounds` literal in the file gets `defaultAt: null, window: null`):

```tsx
  it('shows a round\'s default time and window, and a match\'s own time when it differs (plan T4)', () => {
    const stage: StagePlayView = {
      ordinal: 1, type: 'league', status: 'live', layout: 'table', groups: [{ number: 1, label: 'Rounds' }], standings: [], advanceCount: null, pairsAsItGoes: false,
      rounds: [{
        group: 1, round: 1, label: 'Week 1', dates: { from: '2026-10-12', to: '2026-10-18' }, defaultAt: '2026-10-14T21:00:00.000Z',
        window: { from: '2026-10-12T00:00:00.000Z', to: '2026-10-18T23:59:59.000Z' },
        matches: [match({ scheduledAt: '2026-10-14T21:00:00.000Z', scheduleSource: 'default' }), match({ id: 2, slot: 2, a: team(3, 'Cats'), b: team(4, 'Dogs'), scheduledAt: '2026-10-16T20:00:00.000Z', scheduleSource: 'agreed' })],
      }],
    };
    render(<StagePlay stage={stage} slug="cup" />);
    const header = document.querySelector('.playround .eyebrow')!.textContent!;
    expect(header).toContain('Week 1');
    expect(header).toContain(whenText('2026-10-14T21:00:00.000Z'));
    expect(header).toContain('play by');
    expect(document.querySelectorAll('.matchcard__when')).toHaveLength(1);
    expect(document.querySelector('.matchcard__when')!.textContent).toBe(whenText('2026-10-16T20:00:00.000Z'));
  });
```

(import `whenText` from `../../eventFormat` there.) Append to `web/src/routes/admin/events/RoundScheduleForm.test.tsx` (new file):

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { RoundScheduleForm } from './RoundScheduleForm';

afterEach(cleanup);

describe('RoundScheduleForm', () => {
  it('fills a league from a weekly pattern and saves the rows as UTC', () => {
    const onSave = vi.fn();
    render(<RoundScheduleForm scheduling="window" league={{ matches: 3, matchesPerWeek: 2 }} seasonStart="2026-10-12" roundsKnown={3} initial={[]} busy={false} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText('Match 1 weekday'), { target: { value: '3' } });
    fireEvent.input(screen.getByLabelText('Match 1 time (UTC)'), { target: { value: '21:00' } });
    fireEvent.change(screen.getByLabelText('Match 2 weekday'), { target: { value: '0' } });
    fireEvent.input(screen.getByLabelText('Match 2 time (UTC)'), { target: { value: '19:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fill from the pattern' }));
    expect(screen.getAllByLabelText(/^Round \d default time$/)).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    expect(onSave).toHaveBeenCalledWith([
      { round: 1, at: '2026-10-14T21:00:00.000Z', from: '2026-10-12T00:00:00.000Z', to: '2026-10-18T23:59:59.000Z' },
      { round: 2, at: '2026-10-18T19:30:00.000Z', from: '2026-10-12T00:00:00.000Z', to: '2026-10-18T23:59:59.000Z' },
      { round: 3, at: '2026-10-21T21:00:00.000Z', from: '2026-10-19T00:00:00.000Z', to: '2026-10-25T23:59:59.000Z' },
    ]);
  });

  it('takes a date only per round on a rolling stage, adding rounds by hand, and clears a row', () => {
    const onSave = vi.fn();
    render(<RoundScheduleForm scheduling="rolling" league={null} seasonStart={null} roundsKnown={null} initial={[{ round: 1, at: '2026-10-24T21:00:00.000Z', from: null, to: null }]} busy={false} onSave={onSave} />);
    expect(screen.queryByLabelText('Round 1 window start')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add a round' }));
    fireEvent.input(screen.getByLabelText('Round 2 default time'), { target: { value: '2026-10-25T21:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear round 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    expect(onSave).toHaveBeenCalledWith([{ round: 2, at: new Date('2026-10-25T21:00').toISOString(), from: null, to: null }]);
  });
});
```

Append to `web/src/routes/admin/events/PlayPanel.test.tsx` (`mockAdmin` gains `setEventMatchTime: vi.fn()`; the `m()` builder gets `scheduledAt: null, scheduleSource: null`; the `rounds` literals get `defaultAt: null, window: null`):

```tsx
  it('shows a window match\'s time, window and open proposal, and sets a time (plan T4)', async () => {
    const desk = {
      holdReason: null, holdFrom: null, dispute: null, frozen: false, graceEndsAt: null, booking: null, liveGame: null, subs: { a: 0, b: 0 },
      schedule: { windowStart: '2026-10-12T00:00:00.000Z', windowEnd: '2026-10-18T23:59:59.000Z', proposal: { side: 'b' as const, byName: 'bob', time: '2026-10-16T20:00:00.000Z', autoAcceptAt: null }, proposals: 2 },
    };
    mockAdmin.eventPlay.mockResolvedValue(play({ stages: [{ ordinal: 1, type: 'league', status: 'live', layout: 'table', groups: [{ number: 1, label: 'Rounds' }], standings: [], advanceCount: null, pairsAsItGoes: false,
      rounds: [{ group: 1, round: 1, label: 'Week 1', dates: null, defaultAt: null, window: null, matches: [m({ scheduledAt: '2026-10-14T21:00:00.000Z', scheduleSource: 'default', desk })] }] }] }));
    mockAdmin.setEventMatchTime.mockResolvedValue({});
    render(<PlayPanel eventId={9} canEdit slug="cup" />);
    expect((await screen.findByText(/Proposal open: bob \(Bats\)/)).textContent).toContain('2 proposals');
    fireEvent.click(await screen.findByText('Staff tools: Rats vs Bats'));
    fireEvent.input(screen.getByLabelText('Match time'), { target: { value: '2026-10-17T21:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set time' }));
    await waitFor(() => expect(mockAdmin.setEventMatchTime).toHaveBeenCalledWith(9, 7, new Date('2026-10-17T21:00').toISOString()));
    expect(confirm).toHaveBeenCalled();
  });
```

Append to `web/src/routes/admin/events/EventEditor.test.tsx` (its mocks of `adminApi` gain `setRoundSchedule: vi.fn()`; the stage literals in its `detail()` builder gain `schedule: [], roundsKnown: null`; inside its `describe`):

```tsx
  it('opens the round schedule editor for a stage at any status and saves it (plan T4)', async () => {
    mockAdmin.event.mockResolvedValue(detail({ status: 'live', stages: [{ id: 3, ordinal: 1, summary: 'Swiss, 4 rounds', settings: swissSettings(), rulesSnapshotted: true, schedule: [], roundsKnown: 4 }] }));
    mockAdmin.setRoundSchedule.mockResolvedValue({ stamped: 2 });
    render(<EventEditor id={1} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Schedule stage 1' }));
    fireEvent.input(screen.getByLabelText('Round 1 default time'), { target: { value: '2026-10-24T21:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(mockAdmin.setRoundSchedule).toHaveBeenCalledWith(1, 3, [{ round: 1, at: new Date('2026-10-24T21:00').toISOString(), from: null, to: null }]));
  });
```

(`detail()` and `swissSettings()` are whatever that file's builders are called; the Swiss stage in the fixture is `rolling`, so the row is a date only.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run web/src/routes/event/room/SchedulePanel.test.tsx web/src/routes/event/StagePlay.test.tsx web/src/routes/admin/events/RoundScheduleForm.test.tsx web/src/routes/admin/events/PlayPanel.test.tsx web/src/routes/admin/events/EventEditor.test.tsx`
Expected: FAIL (modules missing, fields missing).

- [ ] **Step 3: api.ts and eventFormat.ts**

In `api.ts`, after `PlayMatchDesk` add `schedule: { windowStart: string | null; windowEnd: string | null; proposal: { side: 'a' | 'b'; byName: string; time: string; autoAcceptAt: string | null } | null; proposals: number } | null;` to it; `PlayMatch` gains `scheduledAt: string | null; scheduleSource: 'default' | 'agreed' | 'staff' | null;`; `PlayRound` becomes `{ group: number; round: number; label: string; dates: { from: string; to: string } | null; defaultAt: string | null; window: { from: string; to: string } | null; matches: PlayMatch[] }`. After `RoomPlayer` add:

```ts
/** Plan T4 (mirrors src/events/roomViews.ts). */
export type RescheduleStatus = 'open' | 'accepted' | 'auto_accepted' | 'declined' | 'countered' | 'withdrawn' | 'expired';
export interface RoomProposal {
  id: number; side: 'a' | 'b'; byName: string; time: string; note: string; createdAt: string; autoAcceptAt: string | null;
  status: RescheduleStatus; respondedByName: string | null; respondedAt: string | null;
}
export interface RoomSchedule {
  scheduledAt: string | null; source: 'default' | 'agreed' | 'staff' | null; windowStart: string | null; windowEnd: string | null;
  opensAt: string | null; leadMinutes: number; proposal: RoomProposal | null; log: RoomProposal[];
  canPropose: boolean; canAnswer: boolean; canWithdraw: boolean;
}
```

`MatchRoomView` gains `schedule: RoomSchedule | null;` after `frozen`. Near `StageSettings` add `export interface RoundSchedule { round: number; at: string | null; from: string | null; to: string | null }`; `AdminEventStage` gains `schedule: RoundSchedule[]; roundsKnown: number | null;`. In `eventsApi` after `dispute`:

```ts
  /** Reschedule proposals (plan T4). */
  propose: (slug: string, id: number, time: string, note: string) => post(`/api/events/${enc(slug)}/matches/${id}/propose`, { time, note }),
  respond: (slug: string, id: number, accept: boolean) => post(`/api/events/${enc(slug)}/matches/${id}/respond`, { accept }),
  counter: (slug: string, id: number, time: string, note: string) => post(`/api/events/${enc(slug)}/matches/${id}/counter`, { time, note }),
  withdraw: (slug: string, id: number) => post(`/api/events/${enc(slug)}/matches/${id}/withdraw`),
```

In `adminApi` after `unfreezeEventMatch`:

```ts
  /** Plan T4: a stage's round schedule, and a match's time set by staff. */
  setRoundSchedule: (id: number, stageId: number, rounds: RoundSchedule[]) => post<{ stamped: number }>(`/api/admin/events/${id}/stages/${stageId}/schedule`, { rounds }),
  setEventMatchTime: (id: number, matchId: number, time: string) => post(`/api/admin/events/${id}/matches/${matchId}/set-time`, { time }),
```

In `eventFormat.ts` add:

```ts
/** "play by Sun, Oct 18, 23:59" for a window's end, in the viewer's zone. */
export function playByText(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? `play by ${iso}` : `play by ${new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
}
```

Add `schedule: null,` to each of the six `MatchRoomView` test builders.

- [ ] **Step 4: SchedulePanel.tsx and EventMatch.tsx**

`web/src/routes/event/room/SchedulePanel.tsx`:

```tsx
import { useState } from 'preact/hooks';
import type { MatchRoomView, RoomProposal } from '../../../api';
import { fromLocalInput, whenText } from '../../../eventFormat';

const STATUS_TEXT: Record<RoomProposal['status'], string> = {
  open: 'open', accepted: 'accepted', auto_accepted: 'locked with no answer', declined: 'declined', countered: 'countered', withdrawn: 'withdrawn', expired: 'expired',
};

/** The propose or counter form: a local-time input read in the viewer's zone, and a note. */
function TimeForm({ label, busy, onSubmit, onCancel }: { label: string; busy: boolean; onSubmit: (time: string, note: string) => void; onCancel?: () => void }) {
  const [time, setTime] = useState('');
  const [note, setNote] = useState('');
  const iso = fromLocalInput(time);
  return (
    <form class="inlinerow" onSubmit={(e) => { e.preventDefault(); if (iso) onSubmit(iso, note.trim()); }}>
      <label>Proposed time <input type="datetime-local" aria-label="Proposed time" value={time} onInput={(e) => setTime((e.target as HTMLInputElement).value)} /></label>
      <label>Note <input type="text" aria-label="Note" maxLength={300} value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} /></label>
      <button class="btn btn--sm" type="submit" disabled={busy || !iso}>{label}</button>
      {onCancel && <button class="btn btn--ghost btn--sm" type="button" onClick={onCancel}>Cancel</button>}
    </form>
  );
}

/** A window-stage match's schedule (plan T4 Ruling 12): the locked time,
 *  the window, the open proposal and what the viewer may do, the log. Times
 *  are shown in the viewer's zone and entered in it. */
export function SchedulePanel({ v, busy, onPropose, onRespond, onCounter, onWithdraw }: {
  v: MatchRoomView; busy: boolean;
  onPropose: (time: string, note: string) => void; onRespond: (accept: boolean) => void; onCounter: (time: string, note: string) => void; onWithdraw: () => void;
}) {
  const s = v.schedule;
  const [countering, setCountering] = useState(false);
  if (!s) return null;
  const team = (side: 'a' | 'b') => (side === 'a' ? v.a?.name ?? 'Team A' : v.b?.name ?? 'Team B');
  const p = s.proposal;
  const source = s.source === 'agreed' ? 'agreed by the captains' : s.source === 'staff' ? 'set by staff' : 'the round default';
  return (
    <div class="roomschedule">
      {s.scheduledAt
        ? <p><strong>{whenText(s.scheduledAt)}</strong> <span class="muted">({source}; the room opens {s.leadMinutes} minutes before)</span></p>
        : <p>No time is set yet. {s.windowEnd ? 'A captain or co-captain proposes one below.' : 'Staff set the round\'s window first.'}</p>}
      {s.windowStart && s.windowEnd && <p class="muted">{`Window: ${whenText(s.windowStart)} to ${whenText(s.windowEnd)}`}</p>}
      {p && (
        <div class="roomschedule__proposal">
          <p>{`${p.byName} (${team(p.side)}) proposes ${whenText(p.time)}${p.note ? ` ("${p.note}")` : ''}.`}
            {p.autoAcceptAt && <span class="muted">{` Unanswered, it locks on ${whenText(p.autoAcceptAt)}.`}</span>}
          </p>
          {s.canAnswer && !countering && (
            <div class="inlinerow">
              <button class="btn btn--sm" type="button" disabled={busy} onClick={() => onRespond(true)}>Accept</button>
              <button class="btn btn--ghost btn--sm" type="button" disabled={busy} onClick={() => onRespond(false)}>Decline</button>
              <button class="btn btn--ghost btn--sm" type="button" disabled={busy} onClick={() => setCountering(true)}>Counter</button>
            </div>
          )}
          {s.canAnswer && countering && <TimeForm label="Counter with this time" busy={busy} onSubmit={(t, n) => { setCountering(false); onCounter(t, n); }} onCancel={() => setCountering(false)} />}
          {s.canWithdraw && <button class="btn btn--ghost btn--sm" type="button" disabled={busy} onClick={onWithdraw}>Withdraw</button>}
        </div>
      )}
      {s.canPropose && <TimeForm label="Propose this time" busy={busy} onSubmit={onPropose} />}
      {s.log.length > 0 && (
        <ol class="room__log">
          {s.log.map((l) => (
            <li key={l.id}>{`${l.byName} (${team(l.side)}) proposed ${whenText(l.time)}: ${STATUS_TEXT[l.status]}${l.respondedByName ? ` by ${l.respondedByName}` : ''}`}</li>
          ))}
        </ol>
      )}
    </div>
  );
}
```

In `EventMatch.tsx`, import `SchedulePanel` and, right after the `{problem && ...}` line, add:

```tsx
      {v.schedule && (v.phase === 'waiting' || v.phase === 'hold' || v.schedule.log.length > 0) && (
        <Panel>
          <h3>Schedule</h3>
          <SchedulePanel
            v={v} busy={busy}
            onPropose={(time, note) => { void run(() => eventsApi.propose(slug, matchId, time, note)); }}
            onRespond={(accept) => { void run(() => eventsApi.respond(slug, matchId, accept)); }}
            onCounter={(time, note) => { void run(() => eventsApi.counter(slug, matchId, time, note)); }}
            onWithdraw={() => { void run(() => eventsApi.withdraw(slug, matchId)); }}
          />
        </Panel>
      )}
```

and show the locked time in the header line: after `{v.roundLabel}` add `{v.schedule?.scheduledAt && <span> · {whenText(v.schedule.scheduledAt)}</span>}` (import `whenText` from `../eventFormat`).

- [ ] **Step 5: StagePlay.tsx and Bracket.tsx**

In `StagePlay.tsx` the round header becomes:

```tsx
              <span class="eyebrow">
                {`${groupPrefix(stage, r)}${r.label}${r.dates ? ` · ${weekRangeText(r.dates.from, r.dates.to)}` : ''}${r.defaultAt ? ` · ${whenText(r.defaultAt)}` : ''}${r.window ? ` · ${playByText(r.window.to)}` : ''}`}
              </span>
```

(import `playByText, whenText` from `../../eventFormat`). In `Bracket.tsx`, the `MatchCard` body gains, after the phase chip, `{m.scheduledAt && m.scheduledAt !== roundDefault && <span class="matchcard__when">{whenText(m.scheduledAt)}</span>}` where `MatchCard` takes a new optional prop `roundDefault?: string | null` (`StagePlay` passes `r.defaultAt`, `Bracket` passes `r.defaultAt` too); the bracket's round `<span class="eyebrow">{r.label}</span>` becomes `{`${r.label}${r.defaultAt ? ` · ${whenText(r.defaultAt)}` : ''}`}`. In `app.css` add `.matchcard__when { display: block; padding: 0 var(--sp-2) var(--sp-1); font-size: var(--fs-dense); color: var(--text-muted); }` and `.roomschedule__proposal { margin: var(--sp-2) 0; padding: var(--sp-2); border: 1px solid var(--border); border-radius: 6px; }`.

- [ ] **Step 6: RoundScheduleForm.tsx and EventEditor.tsx**

`web/src/routes/admin/events/RoundScheduleForm.tsx`:

```tsx
import { useState } from 'preact/hooks';
import type { RoundSchedule, Scheduling } from '../../../api';
import { weeklyRoundTimes, type WeeklySlot } from '../../../../../src/events/league';
import { fromLocalInput, toLocalInput } from '../../../eventFormat';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
interface Row { round: number; at: string; from: string; to: string }
const rowOf = (r: RoundSchedule): Row => ({ round: r.round, at: r.at ? toLocalInput(r.at) : '', from: r.from ? toLocalInput(r.from) : '', to: r.to ? toLocalInput(r.to) : '' });
const blank = (round: number): Row => ({ round, at: '', from: '', to: '' });

/** A stage's per-round schedule (plan T4 Rulings 2 and 3): one row per
 *  round with a default time and, on a window stage, the window. A league
 *  fills every round from a weekly pattern against its season start, then
 *  any row may be edited. Times are typed in the viewer's zone and sent as
 *  UTC; a rolling stage takes a date only. */
export function RoundScheduleForm({ scheduling, league, seasonStart, roundsKnown, initial, busy, onSave }: {
  scheduling: Scheduling; league: { matches: number; matchesPerWeek: number } | null; seasonStart: string | null; roundsKnown: number | null;
  initial: RoundSchedule[]; busy: boolean; onSave: (rows: RoundSchedule[]) => void;
}) {
  const count = Math.max(roundsKnown ?? 0, ...initial.map((r) => r.round), 1);
  const [rows, setRows] = useState<Row[]>(() => Array.from({ length: count }, (_, i) => { const r = initial.find((x) => x.round === i + 1); return r ? rowOf(r) : blank(i + 1); }));
  const [slots, setSlots] = useState<WeeklySlot[]>(() => Array.from({ length: league?.matchesPerWeek ?? 0 }, () => ({ day: 3, time: '' })));
  const [problem, setProblem] = useState<string | null>(null);
  const set = (i: number, patch: Partial<Row>) => setRows((xs) => xs.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const fill = () => {
    if (!league || !seasonStart) return;
    const out = weeklyRoundTimes({ seasonStart, matches: league.matches, perWeek: league.matchesPerWeek, slots });
    setRows(out.map((r) => rowOf(r)));
  };
  const submit = (e: Event) => {
    e.preventDefault();
    const out: RoundSchedule[] = [];
    for (const r of rows) {
      const at = r.at === '' ? null : fromLocalInput(r.at);
      const from = scheduling === 'window' && r.from !== '' ? fromLocalInput(r.from) : null;
      const to = scheduling === 'window' && r.to !== '' ? fromLocalInput(r.to) : null;
      if (at === undefined || (r.at !== '' && at === null) || (r.from !== '' && from === null) || (r.to !== '' && to === null)) { setProblem(`Round ${r.round}: a time is not readable.`); return; }
      if (at === null && from === null && to === null) continue;
      out.push({ round: r.round, at, from, to });
    }
    setProblem(null);
    onSave(out);
  };
  return (
    <form class="eventform eventform--schedule" onSubmit={submit}>
      {problem && <p class="error" role="alert">{problem}</p>}
      {league && (
        <div class="inlinerow">
          {slots.map((s, i) => (
            <span key={i} class="inlinerow">
              <label>{`Match ${i + 1} weekday`}
                <select aria-label={`Match ${i + 1} weekday`} value={String(s.day)} onChange={(e) => setSlots((xs) => xs.map((x, k) => (k === i ? { ...x, day: Number((e.target as HTMLSelectElement).value) } : x)))}>
                  {DAYS.map((d, k) => <option key={d} value={String(k)}>{d}</option>)}
                </select>
              </label>
              <label>{`Match ${i + 1} time (UTC)`}
                <input type="time" aria-label={`Match ${i + 1} time (UTC)`} value={s.time} onInput={(e) => setSlots((xs) => xs.map((x, k) => (k === i ? { ...x, time: (e.target as HTMLInputElement).value } : x)))} />
              </label>
            </span>
          ))}
          <button class="btn btn--ghost btn--sm" type="button" disabled={!seasonStart || slots.some((s) => s.time === '')} onClick={fill}>Fill from the pattern</button>
          {!seasonStart && <span class="muted">Set the season start on the stage to fill from a pattern.</span>}
        </div>
      )}
      <ol class="admin-list">
        {rows.map((r, i) => (
          <li key={r.round} class="inlinerow">
            <strong>{`Round ${r.round}`}</strong>
            <label>Default time <input type="datetime-local" aria-label={`Round ${r.round} default time`} value={r.at} onInput={(e) => set(i, { at: (e.target as HTMLInputElement).value })} /></label>
            {scheduling === 'window' && (
              <>
                <label>Window from <input type="datetime-local" aria-label={`Round ${r.round} window start`} value={r.from} onInput={(e) => set(i, { from: (e.target as HTMLInputElement).value })} /></label>
                <label>to <input type="datetime-local" aria-label={`Round ${r.round} window end`} value={r.to} onInput={(e) => set(i, { to: (e.target as HTMLInputElement).value })} /></label>
              </>
            )}
            <button class="btn btn--ghost btn--sm" type="button" aria-label={`Clear round ${r.round}`} onClick={() => set(i, { at: '', from: '', to: '' })}>Clear</button>
          </li>
        ))}
      </ol>
      <div class="eventform__actions">
        <button class="btn btn--ghost btn--sm" type="button" onClick={() => setRows((xs) => [...xs, blank(xs.length + 1)])}>Add a round</button>
        <button class="btn" type="submit" disabled={busy}>Save schedule</button>
      </div>
    </form>
  );
}
```

(`fromLocalInput` returns `string | null`, never undefined; the `at === undefined` guard is harmless and keeps the three checks symmetric, drop it if the linter objects.) In `EventEditor.tsx`: import `RoundScheduleForm`; add state `const [scheduling, setScheduling] = useState<number | null>(null);`; in each stage row's `<div class="eventstage__head">`, outside the `stagesOpen` span so it shows while live too, add

```tsx
                  {canEdit && !over && (
                    <button class="btn btn--ghost btn--sm" aria-label={`Schedule stage ${s.ordinal}`} disabled={busy} onClick={() => setScheduling(scheduling === s.id ? null : s.id)}>Schedule</button>
                  )}
```

and after the `editing === s.id` block:

```tsx
                {scheduling === s.id && (
                  <RoundScheduleForm
                    scheduling={s.settings.scheduling}
                    league={s.settings.type === 'league' ? { matches: (s.settings.config as StageConfigs['league']).matches, matchesPerWeek: (s.settings.config as StageConfigs['league']).matchesPerWeek } : null}
                    seasonStart={s.settings.type === 'league' ? (s.settings.config as StageConfigs['league']).seasonStart : null}
                    roundsKnown={s.roundsKnown} initial={s.schedule} busy={busy}
                    onSave={(rounds) => void run(async () => { await adminApi.setRoundSchedule(id, s.id, rounds); setScheduling(null); })}
                  />
                )}
```

(import `StageConfigs` from `../../../api`). The History panel's `ACTION_TEXT` gains `schedule_set: 'set a round schedule'`, `schedule_applied: 'applied the schedule to the matches'`, `reschedule_proposed: 'proposed a match time'`, `reschedule_accepted: 'accepted a proposed time'`, `reschedule_declined: 'declined a proposed time'`, `reschedule_countered: 'countered a proposed time'`, `reschedule_withdrawn: 'withdrew a proposed time'`, `reschedule_auto_accepted: 'locked an unanswered proposal'`, `reschedule_reminded: 'reminded a team of a proposal'`, `reschedule_expired: 'expired a proposal'`, `match_time_set: 'set a match time'`.

- [ ] **Step 7: PlayPanel.tsx**

In `DeskLine`, after the subs line add:

```tsx
  if (m.scheduledAt) parts.push(`Time: ${whenText(m.scheduledAt)}${m.scheduleSource === 'agreed' ? ' (agreed)' : m.scheduleSource === 'staff' ? ' (staff)' : ''}`);
  if (d.schedule?.windowEnd) parts.push(playByText(d.schedule.windowEnd));
  if (d.schedule?.proposal) parts.push(`Proposal open: ${d.schedule.proposal.byName} (${d.schedule.proposal.side === 'a' ? a : b}) ${whenText(d.schedule.proposal.time)}${d.schedule.proposal.autoAcceptAt ? `, locks ${whenText(d.schedule.proposal.autoAcceptAt)}` : ''} · ${d.schedule.proposals} proposals`);
```

(import `playByText, whenText` from `../../../eventFormat`.) In `DeskTools`: `const canTime = phase === 'waiting' && d.schedule !== null;` joins the `if (!canAct && !canReopen && !canBox && !canTime) return null;` guard, `MatchRow` mounts `DeskTools` for `ROOM_LIVE.has(m.phase) || m.phase === 'waiting'` when `m.desk` is present, and a new group:

```tsx
      {open && canTime && (
        <div class="desktools__group">
          <label>Match time <input type="datetime-local" aria-label="Match time" value={time} onInput={(e) => setTime((e.target as HTMLInputElement).value)} /></label>
          <button class="btn btn--ghost btn--sm" disabled={busy || !fromLocalInput(time)} onClick={() => void run(() => adminApi.setEventMatchTime(eventId, m.id, fromLocalInput(time)!),
            { title: `Set ${names} for ${whenText(fromLocalInput(time)!)}?`, body: 'Both rosters are told. An open proposal expires. The room opens before the time on its own.' })}>Set time</button>
        </div>
      )}
```

with `const [time, setTime] = useState('');` and `fromLocalInput` imported.

- [ ] **Step 8: Run the tests**

Run: `npx vitest run web/src/routes/event web/src/routes/EventMatch.test.tsx web/src/routes/admin/events tests/eventFormat.test.ts && npm run typecheck && npm run build`
Expected: PASS; both typechecks clean; a clean build.

- [ ] **Step 9: Commit**

```bash
git add web/src/api.ts web/src/eventFormat.ts web/src/routes/event/room/SchedulePanel.tsx web/src/routes/event/room/SchedulePanel.test.tsx web/src/routes/EventMatch.tsx web/src/routes/event/StagePlay.tsx web/src/routes/event/StagePlay.test.tsx web/src/routes/event/Bracket.tsx web/src/routes/admin/events/RoundScheduleForm.tsx web/src/routes/admin/events/RoundScheduleForm.test.tsx web/src/routes/admin/events/EventEditor.tsx web/src/routes/admin/events/EventEditor.test.tsx web/src/routes/admin/events/PlayPanel.tsx web/src/routes/admin/events/PlayPanel.test.tsx web/src/styles/app.css web/src/routes/EventMatch.test.tsx web/src/routes/event/room/ServerPanel.test.tsx web/src/routes/event/room/LineupPanel.test.tsx web/src/routes/event/room/VetoBoard.test.tsx web/src/routes/event/room/ConfirmPanel.test.tsx web/src/routes/event/room/roomText.test.ts
git commit -m "Tournaments T4: the room page gets a Schedule panel to propose, answer, counter and withdraw times, the event page shows round times, windows and each match's time, and the desk edits a stage's round schedule (a league from a weekly pattern) and sets a match time"
```

---
### Task 9: The whole-branch check and the hand-off

**Files:**
- No new code; fixes to whatever the checks turn up, in the file they belong to.

- [ ] **Step 1: The whole-branch check**

Run, in order, and fix anything that fails before committing:

```bash
npm test
npm run typecheck
npm run build
grep -rnP '\x{2014}' src web/src tests docs/superpowers/plans/2026-10-07-tournaments-4-windows.md | head
git diff --stat tournaments-t3c..HEAD
```

Expected: every test passes (the T2, T3a, T3b and T3c suites included: the league fixtures now stamp week windows, which nothing in those suites asserts against), both typechecks clean, a clean build, no em dash anywhere in the branch, and the diff touching only the files in the file map plus the tests.

- [ ] **Step 2: A scratch walk**

On a throwaway database (`PUG_DB=/tmp/t4.sqlite npm run dev` or whatever `tests/http-e2e.test.ts` and the T3a walk used; never `/home/volence/l4d1-ds` or a live box), with `competitive_enabled = 'admins'` and `event_window_lead_minutes` at 5: make a two-team league event with a season start of today, start it, open the desk's Schedule for the stage, fill from a weekly pattern with today's weekday at a time ten minutes ahead, save; see the event page show "Week 1 · <time> · play by <Sunday>" and the match card; open the match room as a captain, propose a time twenty minutes ahead, see the other captain's Accept, accept it; watch the room open on its own five minutes before; then reset the room from the desk and see it reopen on the next tick (Ruling 9). Then make a second match with a window ending in two minutes and one unanswered proposal, and see the forfeit and the DM text in the console (the notifier logs when no bot is attached). Five screenshots at 390 px into the scratchpad, no sideways scroll.

- [ ] **Step 3: Read the log and write the hand-off**

Read `git log --oneline tournaments-t3c..HEAD`: eight commits, one per task, each a plain sentence. Do not push; do not deploy.

Note for the owner in the hand-off:
- Rulings 3 (bracket dates are binding `not_before`), 5 (booking at lineup lock, capacity reserved by counting two-hour slots), 6 (the reminder folds into the arrival DM at the default 24 hours), 8 (who forfeits at the window end) and 9 (a reset room reopens at once) are the ones to confirm or reverse.
- Two new settings on the Settings desk under Competitive: `reschedule_autoaccept_hours` (24) and `event_window_lead_minutes` (20).
- Discord DM times use `<t:unix:F>`, which the Discord client renders in each reader's zone; the site uses the browser's zone.
- Production stays behind `competitive_enabled = 'admins'`; no plugin change; no server touched.

- [ ] **Step 4: Commit anything the checks changed**

```bash
git add -A
git commit -m "Tournaments T4: the whole-branch check"
```

(only if Step 1 or 2 changed files; otherwise nothing to commit.)
