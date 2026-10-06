# Tournaments plan T3b: match servers, automatic results, between-game picks, confirm and disputes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The moment both lineups of a tournament match are locked, the site books a server for the whole series, sets it up, and tells the eight players and their roster spectators where to connect, on the room page and by DM. Each game is started by the site with the campaign, the chapter limit and the sides the veto decided, so the team the veto named really does start as survivors. Results come from our own capture: a game's campaign total decides it, a tie replays the last chapter as a tiebreak game, Bo2 is total score over both games, Bo3 and Bo5 are games won. With "loser picks", the loser of each game picks the next from the room, on the same 60 second timer as the veto. A team with fewer than four on the server at the end of the grace loses by forfeit. After the last game the match sits in a 15 minute confirm window: either captain can confirm (both confirming ends it early) or dispute with a reason, which holds the match for staff with a feed alert linking the replays. Otherwise the result is recorded as automatic and the bracket advances. Nothing is deployed by this plan; production stays behind `competitive_enabled = 'admins'`.

**Architecture:** One new pure module, `seriesRules.ts`, turns the rows of `event_games` into a verdict: who leads, which game needs a tiebreak, whether the series is over and what the recorded result is. A new engine, `SeriesEngine` (`src/events/series.ts`), owns everything between "lineups locked" and "result recorded": it makes the booking, hands the booking runner the lines that start each game (`sm_pug_match` plus `sm_pug_roster`, the orchestrator's own proven path), reacts to the server becoming ready, to who is on it, to a game ending and to the booking ending, opens the between-game pick, runs the confirm window and files disputes. It talks to the game only through `BookingRunner`, which gains a small `TournamentHooks` interface and otherwise treats a tournament booking like a scrim block that never ends on time and takes no captain commands. All writes to `event_matches` and `event_games` stay in `src/events/room.ts` (new mutations, one `event_log` row each); the automatic result goes through `flow.ts` (`autoResultFlow`, `result_source = 'auto'`) so brackets, Swiss rounds and settles behave exactly as for an admin result. The 5 second `RoomClock` also ticks the series engine. No plugin change: `sm_pug_match`, `sm_pug_roster`, the `stopaftermap` argument and `sm_pug_auto_track 0` already exist.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Fastify 5, better-sqlite3, vitest (`npm test`, `npx vitest run <file>`), `npm run typecheck` (server and web), `npm run build`; Preact + preact-iso + @testing-library/preact (happy-dom) for the web. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-30-competitive-tournaments-design.md` section 4 (booking and connect, subs, no-show and forfeit, result, tiebreak, confirming and disputes, crash), Error handling ("waiting for a server", timers re-armed), Testing (tiebreaker selection, one dispute, one tie in the integration list). Foundation spec `docs/superpowers/specs/2026-09-30-competitive-foundation-design.md` section 3 (bookings, who may be on a booked server, games inside a block) and section 4 (crash recovery). T3a (`docs/superpowers/plans/2026-10-06-tournaments-3a-match-room.md`, branch `tournaments-t3a`, not on master yet) built the room, the veto engine and the room clock this plan extends; its interfaces are taken as existing. T2 (`docs/superpowers/plans/2026-10-05-tournaments-2-brackets.md`) built `flow.ts` and `play.ts`. Read T3a's Rulings first, then this plan's. The code map that informed this plan is `scratchpad/t3b-codemap.md` (bookings, runner, adoption, the plugin's side convention).

**T3a as built (checked against the branch 2026-10-07; this plan's snippets follow the code, not T3a's plan):** `RoomPhase` and `phaseOf` live in `src/events/playViews.ts` (re-exported by `roomViews.ts`); `MatchRoomView.a` and `.b` are `PlayEntry | null`; `roomViews.ts` uses `playEntriesOf` and `matchLabel` from `playViews.ts` and computes `next.step` as the count of `event_vetoes` rows; `RoomClock.pushChange(matchId)` is the public push, `RoomClock` is built in `server.ts` right before `adminEventRoutes` and passed as `rooms` to both route plugins; `expireOne` re-reads the match and re-checks status and deadline before acting; at a side-choice pause `st.games` already holds that game's slot with `firstSurvivors` null, so `syncGames` writes the `event_games` row then; `room.ts` builds `BUSY_SQL` from `P.ROOM_OPEN`; `tests/roomFixture.ts` exports `TIMERS`, `POOL7` (seven real poolable slugs) and `roomFixture({ veto?, pool?, startsAt?, now? })`; `forfeitMatch(db, { eventId, matchId, winner, expect, now? })` takes an `expect` predicate; the admin hold reason goes through `V.normalizeReason` plus a 3 character minimum; the web small button class is `btn--sm`; the room page test builder is `view()` and passes `session={{ kind: 'active' } as never}`. T3a's web Task 10 (bracket phase chips, the desk's Open room, Reset room and Hold buttons) and its final-review fix wave are on the branch (head 69e04bf5): rooms tick only while the event and stage are live (`ROOM_LIVE_SQL`), cancelling an event resets open rooms, an upstream correction resets downstream rooms still in their ready check (no veto or lineup rows) inside one transaction with the result, admin results and disqualifications push the rooms they close, and `resetRoom` takes `by: string | null`.

## Global Constraints

- Team events only (`entry_kind = 'team'`).
- Every write to `event_matches` stays in `src/events/play.ts` and `src/events/room.ts`; every write to `event_games`, `event_vetoes`, `event_lineups` and the two prefs tables stays in `src/events/room.ts`. Each mutation is one transaction writing exactly one `event_log` row on success and nothing on refusal (`tests/eventLogGuard.test.ts`). The series engine never writes those tables itself: it calls room.ts.
- Every write to the four booking tables stays in `src/bookings/bookings.ts` (one `booking_events` row per change). The one exception, as today for adoption, is `matches` and `match_players`: `src/bookings/tournamentGames.ts` inserts a tournament game's rows the way `selfStarted.ts` inserts an adopted game's.
- The site drives every tournament game explicitly (`sm_pug_match` and `sm_pug_roster`); `sm_pug_auto_track` is 0 on a tournament box. A game that the site did not start is not a tournament game.
- Connect details (host, port, password) reach only the booking's accepted people (the eight players and the roster spectators) and staff: never a public route, a DM to anyone else, an `event_log` detail or a hub event.
- Lineups stay secret until both are locked (T3a); T3b never reads them before `status = 'booking'`.
- Tournament games never move SR (`src/rating.ts` already refuses `kind != 'pug'`); their `matches` rows carry `kind = 'tournament'`.
- Never write em dashes in code, comments, copy, commits or docs.
- Commit messages follow the repo style (a plain sentence). Do not push. Do not deploy, restart, stage or rcon any live box.
- Several Claude sessions use `/home/volence/l4d/pug`: work in a worktree branch (`tournaments-t3b`, made with superpowers:using-git-worktrees, branched from `tournaments-t3a` once that branch is complete through its Task 10, or from master after T3a merges). Run `npm ci` inside the worktree (never symlink `node_modules`). Check `git reflog -10` and `git status` before any write on master.

## Rulings this plan makes (for the owner to confirm)

1. **Three plans (owner, 2026-10-06).** T3a: the match room. T3b (this plan): booking, connect, automatic results, no-show on the server, tiebreak games, between-game picks, the confirm window, disputes. T3c: in-game `!sub` and `!admin`, the desk tools (replay a chapter, reopen the veto, move server, act for a team, release a hold), side-locked spectating.
2. **One booking per series, made the moment both lineups lock.** The room clock sees `status = 'booking'` with no `booking_id` and makes it on the next tick: `purpose = 'tournament'`, starts now, region the event's, game config and rules the stage's (`event_stages.rules_json`, the tournament snapshot), playlist `[game 1's campaign]` and `games_allowed = 1`, grown by one each time a later game or a tiebreak is scheduled (`appendTournamentGame`), so the booking's own length and count follow the series rather than guess it. Side a is `entry_a`, side b is `entry_b` (a team side each, `captain_steamid` the team's captain), both confirmed at creation. People: the locked four as `player`, the rest of each roster and its coach as `spectator`, all `accepted`. No allowance, scrim block, `canUse` or capacity check: the teams were already let into the event, and an event night is planned by staff, who lower `pug_reserve_servers` for it. `created_by` is the event's organizer. The runner's `bookingsDue` already keeps one idle box back from the PUG queue for a confirmed booking that has started and has no box, so nothing new protects the queue.
3. **The site starts every game; no plugin change.** Before every `changelevel` of a tournament booking the runner pushes the lines the series engine returns: `sm_pug_match <id> <token> <campaign> ["<stop map>"]`, eight quoted `sm_pug_roster "<steamid>:<a|b>"` lines, and the ready panel's league notice. The plugin's convention "pug team a starts as survivors on map 1" (`Cmd_Match`) and its team lock (active for a backend roster even with auto-track on) make the veto's `first_survivors` binding: that team's four are rostered `a`, the other's `b`, and `matches.booking_side_a` records which booking side is match team a. `sm_pug_auto_track` is pushed as 0 on a tournament box (the `gameLines` burst, re-pushed every minute), so nothing is adopted and no result can arrive from a game the site did not start. The chapter limit is the stage's `chapters` (the N-th map of the campaign) or, when standard, `stopAfterMap` (the same campaign rule PUGs use). The lines are re-pushed on the minute watch until the game's first heartbeat (`match_live` row), so a burst lost to an rcon hiccup cannot strand a game.
4. **Status flow, and where the pick sits.** `booking` (lineups locked, and also "waiting for a server") -> `connect` (the server is ready; `deadline` = ready plus the grace) -> `live` (the first game's `MATCH_START`; stays `live` across every game of the series) -> `confirming` (`deadline` = 15 minutes) -> `done` (automatic result) or `admin_hold` (dispute). With "loser picks", the between-game pick keeps `status = 'live'` and sets `deadline` to the veto step length; `actVeto` accepts a step on a `live` match, the clock acts from preferences on timeout exactly as in the veto, and once the pick and its side choice are in, the engine schedules the game. The `event_matches` status CHECK is not touched (`connect`, `live` and `confirming` were in it from T2).
5. **Series arithmetic (owner).** A game is won on campaign total (`matches.team_a_score` / `team_b_score`, oriented by `booking_side_a`). Bo1, Bo3, Bo5: games won, the series ends as soon as a team has more than half. Bo2: total score across both games, both always played. A tied game (or, in Bo2, tied totals after game 2) is replayed as a tiebreak game: a new `event_games` row with `tiebreak_of` the tied series game, `ordinal = 10 * game + k` (so series games keep 1..5 and the unique index `event_games_ordinal` never collides with a game the veto settles later: `syncGames` only ever upserts ordinals 1..`games`, and a game's tenth tiebreak is still below the next game's first; `addTiebreak` refuses an eleventh as `changed` rather than hit the index), `map` the last chapter that game played (`match_maps`, highest ordinal), and `first_survivors` the team that was survivors second on that chapter (`match_rounds` half 1 of that map, the other team). A tiebreak is one map: the booking's `next_map` makes the runner `changelevel` straight to it and `stopaftermap` is that same map, so its score alone decides. A tiebreak that ties again gets another tiebreak of the same game. The recorded event result: Bo3/Bo5 `score_a`/`score_b` are games won; Bo2 they are the totals of every game played, tiebreaks included (so a tiebreak-decided Bo2 still has the winner strictly ahead, as `parseResult` demands).
6. **The game 1 lineup carries the series.** T3b rosters every game from the `event_lineups` rows of game 1; no rows are written for later games. Changing a player between games is T3c's `!sub`.
7. **No-show on the server.** The grace is the booking's rules' `noShowGraceMinutes` (the stage ruleset's, default 15), from `ready_at`. The decision is made by the first minute watch at or after the deadline, from who is on the box right then (`status`), counting each side's locked four only (spectators and the coach do not make a side shown). One side short: that side forfeits through `forfeitMatch` (the T2 path), the booking ends (`end_reason = 'no_show'`) and the box goes back; `booking_sides.no_show_at` is not written, so a tournament forfeit never touches the scrim reliability record (the event record is the record). Both short: `admin_hold` with `hold_reason = 'no_show_both'`, the booking stays up so staff can let them play short-handed or decide; an abandoned box still idle-ends on its own. If the box cannot be watched for 3 minutes past the deadline (rcon down), the clock holds the match with `no_presence` rather than guess. A first game going live before the deadline ends the question.
8. **Waiting for a server.** A tournament booking with no box stays `scheduled` and waits: the runner's immediate "started with no server" alert and its 15 minute `no_server` cancel do not apply to tournaments. The room and event pages show "Waiting for a server"; 10 minutes after the booking was made (`booked_at`) the clock alerts staff once (`server_alerted_at`, so a restart does not alert twice). The match waits until a box frees or staff reset the room or enter a result.
9. **Confirm window and disputes.** After the last game: `confirming` for `event_confirm_minutes` (setting, default 15, range 5 to 60). A manager of either team may Confirm (both confirmed: done at once) or Dispute with a reason (3 to 300 characters): the match goes to `admin_hold` with `hold_reason = 'dispute'` and `dispute_side`, `dispute_by`, `dispute_reason`, `disputed_at`; staff get a feed alert (`publishAdminEvent` kind `problem`, linking the room page and naming each game's match page, where the replays and demos are). A dispute at or after the deadline is refused (`room_closed`). The result is otherwise recorded by the clock with `result_source = 'auto'` through `autoResultFlow`, which re-checks `status = 'confirming'` inside the event's chain. A held match is resolved as in T3a: staff enter the result (T2) or reset the room.
10. **Captain commands on a tournament box.** `!nextmap`, `!stay`, `!addcampaign`, `!extend` and `!end` are refused with "The site runs this tournament match: it picks the campaigns and closes the server." `!allow` keeps working (a captain lets a late spectator in; the allowlist is the booking's).
11. **The booking ending.** After the series the booking closes 5 minutes after the last game (the runner's closing grace, `close_at`); that end changes nothing on the match. A booking that ends while the match is `booking`, `connect` or `live` (idle, staff cancel, setup failed, server lost, no_server) puts the match on `admin_hold` with `hold_reason = 'booking_<reason>'` and alerts staff. "Everyone left" never ends a tournament booking between games (the series engine knows when it is over); the idle end still does.
12. **Crash recovery is untouched.** A restarted or gone box is handled by plan 5's recovery; the game is restored from `match_rounds` and the event match keeps its status. Between games the recovery reloads the due campaign on the due map (`next_map`). Not covered: a crash during a tiebreak game before it went live restores at the campaign's first map (the snapshot has no map yet); staff reset the room or enter the result (Not in this plan).
13. **Visibility.** Tournament games are `matches` rows with `kind = 'tournament'` and `visibility = 'participants'` (both rosters, staff, invited casters), filed under the booking, exactly as scrim games are. The public delayed live viewer the spec describes does not exist yet; until it does, a public viewer sees the room page's score, not the live positions. SR never moves.
14. **Reset room on a booked match cancels the booking** (a staff cancel, which winds the box down and aborts a live game) and then resets as T3a does; `resetRoom` itself refuses with `booking_open` while the match's booking has not started ending, so a running box can never be orphaned by a reset.
15. **Game rows exist from the push.** A tournament game's `matches` row is inserted `live` with `went_live_at` null when its lines are pushed (as an adopted game is at go-live), so the PUG no-show reaper never looks at it (`src/noShow.ts` selects `went_live_at IS NOT NULL`, and nothing on this path stamps it: `recordMatchStart` only touches `match_live`) and the orphan reaper applies once the plugin heartbeats. Checked in `plugin/pug-match.sp`: `Timer_Heartbeat` runs every 30 s and emits `HEARTBEAT` in every state but `MS_None`, so a game sitting in `MS_Pending` heartbeats; `recordHeartbeat` upserts the `match_live` row (`touch`), so `isPendingGame` turns false within 30 s of the burst landing, before go-live, and `reapOrphanedMatches` (which joins `match_live` on a stale `last_seen`) can only ever reap a game the box once reported. `origin = 'queue'`: the site started it.
16. **DMs.** Two new types: `event_match_connect` (to the booking's accepted people: the connect line, game 1 and its sides, the grace) and `event_match_result` (to both rosters: the series result and the confirm window). The runner's `booking_ready` DM is not sent for a tournament booking (the series DM replaces it); `booking_recovered` and `booking_cancelled` still are (they are about the box). Players turn them off like the others.
17. **Live updates.** Every series change pushes `event_room` as T3a does (two rosters and staff); the room page keeps its 10 second poll, which is how the live score moves for everyone else.
18. **Restart.** Deadlines of `live` (a pick step) and `confirming` matches that passed during downtime get their full length again at start (T3a's rule, `resumeDeadline` widened). A `connect` deadline is left alone: the no-show decision is made from the box's current presence, so downtime costs nobody a forfeit.
19. **Timers.** `event_confirm_minutes` joins `RoomTimers` (`confirmMinutes`); the next-game delay (60 s), the closing grace (5 min), the server alert (10 min) and the presence fallback (3 min) are constants.

## Not in this plan (and why)

- `!sub` and `!admin` in game, admin pause, replay a chapter, reopen the veto, move server, act for a team, release a hold: T3c (the desk's tools need the room to have a game to act on, which this plan gives it).
- Side-locked spectating and the public delayed live viewer: T3c and the foundation's visibility work; tournament games are `participants` until then (Ruling 13).
- Casters' relay password through `/cast` for tournament boxes: foundation SourceTV work, unchanged here.
- Windows, reschedules, rooms on a schedule: rollout plan 4. Discord channel posts: rollout plan 5.
- A crash during a tiebreak game before go-live (Ruling 12): staff reset; a `next_map` aware snapshot is T3c's "replay a chapter".
- Private team voice for tournament bookings: already done by the booking runner for every booking; nothing to add.

## Review Focus

- **A game ending twice.** `finishWithRetry` can call `onGameEnded` more than once for one match; `recordGame` refuses a game already recorded (`changed`) and `continueSeries` is idempotent (a tiebreak already added, a next game already scheduled, a confirm already open are each detected and left alone). Task 6 tests a double `gameEnded`.
- **The clock and a captain acting on the same pick step.** Same answer as T3a: `actVeto` is keyed by step number, the loser is refused with `step_taken`; `afterPick` runs only when nothing human is left and schedules at most once. Task 6 tests.
- **A dispute at the confirm deadline.** `disputeMatch` is refused at or after `deadline`; `finalize` goes through `autoResultFlow`, whose `expect` re-checks `status = 'confirming'` inside the chain, so a dispute that landed first is never overwritten by an automatic result, and an automatic result that landed first makes the dispute `room_closed`. Task 6 tests both orders.
- **The booking ending right around the last game.** The series ends the booking with a 5 minute close; an idle or staff end that arrives while the match is `confirming` or `done` changes nothing (`ended` acts on `booking`, `connect`, `live` only). Task 6 tests.
- **The first game going live between two minute watches.** The no-show decision reads presence at the watch, but `forfeitMatch`'s `expect` demands `status = 'connect'` at the moment of the write, so a `MATCH_START` that moved the match to `live` in between wins. Task 5 tests.

---

## File map

| File | Responsibility |
|---|---|
| `src/events/seriesRules.ts` | Pure: `seriesVerdict`, `seriesResult`, `gameNumberOf`, `tiebreakOrdinal`, `playOrder`, `tiebreakFirstSurvivors`. |
| `src/db.ts` | New columns on `event_matches`, `event_games`, `bookings`, `booking_sides`; the `event_confirm_minutes` setting. |
| `src/settingsSchema.ts` | The confirm window in the Competitive group. |
| `src/events/room.ts` | New mutations (booking, connect, live, games, tiebreaks, picks, confirming, confirm, dispute, server alert), `vetoInput` winners, `actVeto` on a live match, resume and hold widened, new reads. |
| `src/events/play.ts` | `recordResult` takes `source`; `MatchRow` new columns. |
| `src/events/flow.ts` | `autoResultFlow`; `report` passes the source. |
| `src/events/validate.ts` | New error keys. |
| `src/bookings/bookings.ts` | `createTournamentBooking`, `appendTournamentGame`, `setNext` with a map, `present_now`. |
| `src/bookings/tournamentGames.ts` | Inserts a tournament game's `matches` and `match_players` rows; builds its `sm_pug_match` burst. |
| `src/bookings/runner.ts` | `TournamentHooks`; auto-track off, game lines before every changelevel, no time end, no captain commands, hooks on ready, presence, game end and booking end; `announce`. |
| `src/bookings/messages.ts` | No change in wording; `booking_ready` skipped for tournaments by the runner. |
| `src/events/series.ts` | `SeriesEngine`: book, game lines, connect, presence, game ended, tiebreaks, picks, confirm, dispute, reset, ended, tick. |
| `src/events/messages.ts`, `src/events/notices.ts`, `src/notify/notify.ts` | Two DM types. |
| `src/events/roomClock.ts` | Ticks the series engine; acts on live pick deadlines and confirm deadlines; resumes them. |
| `src/events/roomViews.ts`, `src/events/playViews.ts` | New phases; `series`, `games` with scores and live score, `server`, `confirm`, `dispute` in the room view. |
| `src/routes/events.ts`, `src/routes/adminEvents.ts` | Confirm and dispute routes; the veto route continues the series; reset goes through the engine. |
| `src/server.ts` | Builds the engine, wires the runner hooks, `match_start`, the clock and the routes. |
| `tests/seriesFixture.ts` | A room driven to `booking`, one idle server, a runner with a fake box, the engine and the clock. |
| `web/src/api.ts`, `web/src/routes/EventMatch.tsx`, `web/src/routes/event/room/*` | Server, series and confirm panels; the pick step on a live match; new phase texts. |
| `web/src/routes/event/Bracket.tsx`, `StagePlay.tsx`, `web/src/routes/admin/events/PlayPanel.tsx` | Phase chips for connect, live and confirming. |

---
### Task 1: Series rules (pure)

**Files:**
- Create: `src/events/seriesRules.ts`
- Test: `tests/seriesRules.test.ts` (new)

**Interfaces:**
- Consumes: `VetoConfig` (T3a `vetoConfig.ts`), `Side`, `other` (T3a `veto.ts`), `ResultInput` (`validate.ts`).
- Produces:
  - `interface SeriesGame { id: number; ordinal: number; tiebreakOf: number | null; scoreA: number | null; scoreB: number | null; winner: Side | null; started: boolean }`
  - `interface SeriesVerdict { bestOf: number; totalScore: boolean; decided: Side[]; winsA: number; winsB: number; totalA: number; totalB: number; over: boolean; winner: Side | null; tiebreakOf: SeriesGame | null; nextGame: number | null }`
  - `seriesVerdict(config: VetoConfig, games: SeriesGame[]): SeriesVerdict`
  - `seriesResult(v: SeriesVerdict): ResultInput | null`
  - `gameNumberOf(g: SeriesGame, games: SeriesGame[]): number`
  - `tiebreakOrdinal(parent: Pick<SeriesGame, 'id' | 'ordinal'>, games: SeriesGame[]): number`
  - `playOrder(games: SeriesGame[]): SeriesGame[]` (series game 1, its tiebreaks, game 2, ...)
  - `tiebreakFirstSurvivors(half1Survivors: Side): Side`

`decided` is what the veto engine's `winners` wants (T3a `VetoInput.winners`): the winner of each series game in order, a tiebreak's result standing in for its game, stopping at the first game without one. Bo2 never feeds it (loser picks is refused there).

- [ ] **Step 1: Write the failing tests**

Create `tests/seriesRules.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { gameNumberOf, playOrder, seriesResult, seriesVerdict, tiebreakFirstSurvivors, tiebreakOrdinal, type SeriesGame } from '../src/events/seriesRules.js';
import { presetConfig, type VetoConfig } from '../src/events/vetoConfig.js';

let nextId = 1;
const game = (ordinal: number, o: Partial<SeriesGame> = {}): SeriesGame =>
  ({ id: nextId++, ordinal, tiebreakOf: null, scoreA: null, scoreB: null, winner: null, started: false, ...o });
const played = (ordinal: number, a: number, b: number, o: Partial<SeriesGame> = {}): SeriesGame =>
  game(ordinal, { scoreA: a, scoreB: b, winner: a > b ? 'a' : b > a ? 'b' : null, started: true, ...o });
const bo3: VetoConfig = presetConfig('loser_picks', 7);
const bo2: VetoConfig = presetConfig('home_away', 4);
const bo1: VetoConfig = presetConfig('ban_to_one', 7);

describe('seriesVerdict for games won (Bo1, Bo3, Bo5)', () => {
  it('counts wins, names the next game, and ends once a team has more than half', () => {
    expect(seriesVerdict(bo3, [game(1)])).toMatchObject({ bestOf: 3, totalScore: false, decided: [], winsA: 0, winsB: 0, over: false, winner: null, tiebreakOf: null, nextGame: 1 });
    const one = [played(1, 900, 400)];
    expect(seriesVerdict(bo3, one)).toMatchObject({ decided: ['a'], winsA: 1, winsB: 0, over: false, nextGame: 2 });
    const two = [...one, played(2, 300, 800)];
    expect(seriesVerdict(bo3, two)).toMatchObject({ decided: ['a', 'b'], winsA: 1, winsB: 1, over: false, nextGame: 3 });
    const three = [...two, played(3, 500, 450)];
    expect(seriesVerdict(bo3, three)).toMatchObject({ decided: ['a', 'b', 'a'], winsA: 2, winsB: 1, over: true, winner: 'a', nextGame: null });
    expect(seriesResult(seriesVerdict(bo3, three))).toEqual({ winner: 'a', scoreA: 2, scoreB: 1, forfeit: false });
    expect(seriesVerdict(bo3, [played(1, 1, 0), played(2, 1, 0), game(3)])).toMatchObject({ over: true, winner: 'a', winsA: 2, nextGame: null });
    expect(seriesVerdict(bo1, [played(1, 10, 20)])).toMatchObject({ over: true, winner: 'b', decided: ['b'] });
    expect(seriesResult(seriesVerdict(bo1, [game(1)]))).toBeNull();
  });

  it('asks for a tiebreak of a tied game, takes the tiebreak as that game\'s result, and asks again when the tiebreak ties', () => {
    const tied = played(1, 500, 500);
    const v1 = seriesVerdict(bo3, [tied, game(2)]);
    expect(v1).toMatchObject({ decided: [], over: false, nextGame: null });
    expect(v1.tiebreakOf?.id).toBe(tied.id);
    expect(tiebreakOrdinal(tied, [tied])).toBe(11);
    const tb1 = played(11, 40, 40, { tiebreakOf: tied.id });
    expect(seriesVerdict(bo3, [tied, tb1, game(2)]).tiebreakOf?.id).toBe(tied.id);
    expect(tiebreakOrdinal(tied, [tied, tb1])).toBe(12);
    const tb2 = played(12, 40, 60, { tiebreakOf: tied.id });
    const v3 = seriesVerdict(bo3, [tied, tb1, tb2, game(2)]);
    expect(v3).toMatchObject({ decided: ['b'], winsA: 0, winsB: 1, tiebreakOf: null, nextGame: 2 });
    expect(gameNumberOf(tb2, [tied, tb1, tb2])).toBe(1);
    expect(playOrder([game(2), tb2, tied, tb1]).map((g) => g.ordinal)).toEqual([1, 11, 12, 2]);
  });
});

describe('seriesVerdict for total score (Bo2)', () => {
  it('adds both games, and breaks a tie with a tiebreak of game 2 whose score alone decides', () => {
    const g1 = played(1, 600, 500);
    const g2 = game(2);
    expect(seriesVerdict(bo2, [g1, g2])).toMatchObject({ totalScore: true, totalA: 600, totalB: 500, over: false, nextGame: 2, tiebreakOf: null });
    const g2w = played(2, 400, 550);
    expect(seriesVerdict(bo2, [g1, g2w])).toMatchObject({ totalA: 1000, totalB: 1050, over: true, winner: 'b', nextGame: null });
    expect(seriesResult(seriesVerdict(bo2, [g1, g2w]))).toEqual({ winner: 'b', scoreA: 1000, scoreB: 1050, forfeit: false });
    const g2t = played(2, 400, 500);
    const tiedTotals = seriesVerdict(bo2, [g1, g2t]);
    expect(tiedTotals).toMatchObject({ totalA: 1000, totalB: 1000, over: false, nextGame: null });
    expect(tiedTotals.tiebreakOf?.id).toBe(g2t.id);
    const tb = played(21, 70, 30, { tiebreakOf: g2t.id });
    const broken = seriesVerdict(bo2, [g1, g2t, tb]);
    expect(broken).toMatchObject({ over: true, winner: 'a', totalA: 1070, totalB: 1030 });
    expect(seriesResult(broken)).toEqual({ winner: 'a', scoreA: 1070, scoreB: 1030, forfeit: false });
  });

  it('never feeds the veto engine a winner (loser picks is refused for Bo2)', () => {
    expect(seriesVerdict(bo2, [played(1, 1, 0), played(2, 1, 0)]).decided).toEqual([]);
  });
});

describe('tiebreak sides', () => {
  it('starts the team that was survivors second on the replayed chapter as survivors', () => {
    expect(tiebreakFirstSurvivors('a')).toBe('b');
    expect(tiebreakFirstSurvivors('b')).toBe('a');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/seriesRules.test.ts`
Expected: FAIL, cannot find module `../src/events/seriesRules.js`.

- [ ] **Step 3: Write `src/events/seriesRules.ts`**

```ts
import type { VetoConfig } from './vetoConfig.js';
import { other, type Side } from './veto.js';
import type { ResultInput } from './validate.js';

/**
 * The arithmetic of a series (tournaments plan T3b Ruling 5), pure over the
 * rows of event_games. Bo1, Bo3 and Bo5 are games won; Bo2 is total score
 * across both games. A tied game is replayed as a tiebreak game (a row with
 * tiebreak_of = the tied series game, ordinal 10 * game + k); the last
 * tiebreak played stands for its game, and a tiebreak that ties again asks
 * for another. Sides a and b are the event match's entry_a and entry_b.
 */

export interface SeriesGame {
  id: number; ordinal: number; tiebreakOf: number | null; scoreA: number | null; scoreB: number | null; winner: Side | null;
  /** A matches row exists for it (it was pushed to the box). */
  started: boolean;
}
export interface SeriesVerdict {
  bestOf: number; totalScore: boolean;
  /** The winner of each series game in order (a tiebreak standing in for its game), up to the first undecided: the veto engine's winners. */
  decided: Side[];
  winsA: number; winsB: number; totalA: number; totalB: number;
  over: boolean; winner: Side | null;
  /** The series game whose tie needs a tiebreak now, or null. */
  tiebreakOf: SeriesGame | null;
  /** The next series game to play (1-based) when none is pending and the series is not over. */
  nextGame: number | null;
}

const played = (g: SeriesGame): boolean => g.scoreA !== null && g.scoreB !== null;
const isSeriesGame = (g: SeriesGame): boolean => g.tiebreakOf === null;

export function gameNumberOf(g: SeriesGame, games: SeriesGame[]): number {
  return g.tiebreakOf === null ? g.ordinal : games.find((x) => x.id === g.tiebreakOf)?.ordinal ?? g.ordinal;
}

/** Series games keep 1..5; a game's tiebreaks are 10 * game + 1, + 2, ...
 *  (at most ten per game before the next game's range starts; room.ts
 *  addTiebreak refuses an ordinal already taken). */
export function tiebreakOrdinal(parent: Pick<SeriesGame, 'id' | 'ordinal'>, games: SeriesGame[]): number {
  return parent.ordinal * 10 + games.filter((g) => g.tiebreakOf === parent.id).length + 1;
}

/** Game 1, its tiebreaks, game 2, its tiebreaks, ... */
export function playOrder(games: SeriesGame[]): SeriesGame[] {
  return [...games].sort((x, y) => gameNumberOf(x, games) - gameNumberOf(y, games) || x.ordinal - y.ordinal);
}

/** Ruling 5: the team that was survivors second on the replayed chapter starts as survivors. */
export const tiebreakFirstSurvivors = (half1Survivors: Side): Side => other(half1Survivors);

/** The last played tiebreak of a series game, or undefined. */
function lastTiebreak(g: SeriesGame, games: SeriesGame[]): SeriesGame | undefined {
  return games.filter((x) => x.tiebreakOf === g.id && played(x)).sort((x, y) => x.ordinal - y.ordinal).at(-1);
}

/** The result that stands for a series game: its last played tiebreak's, else its own; null until played. */
function standing(g: SeriesGame, games: SeriesGame[]): { winner: Side | null } | null {
  const last = lastTiebreak(g, games) ?? (played(g) ? g : null);
  return last ? { winner: last.winner } : null;
}

export function seriesVerdict(config: VetoConfig, games: SeriesGame[]): SeriesVerdict {
  const bestOf = config.games;
  const totalScore = bestOf === 2;
  const series = games.filter(isSeriesGame).sort((x, y) => x.ordinal - y.ordinal);
  let totalA = 0;
  let totalB = 0;
  for (const g of games) if (played(g)) { totalA += g.scoreA!; totalB += g.scoreB!; }
  const base = { bestOf, totalScore, decided: [] as Side[], winsA: 0, winsB: 0, totalA, totalB, over: false, winner: null as Side | null, tiebreakOf: null as SeriesGame | null, nextGame: null as number | null };

  if (totalScore) {
    const done = series.filter(played).length;
    if (done < 2) return { ...base, nextGame: done + 1 };
    const a = series.reduce((n, g) => n + g.scoreA!, 0);
    const b = series.reduce((n, g) => n + g.scoreB!, 0);
    let winner: Side | null = a > b ? 'a' : b > a ? 'b' : null;
    const last = series[1]!;
    // Tied totals: only a tiebreak of game 2 can break them (game 2's own
    // result is already inside the totals, so it must not stand in here).
    if (winner === null) winner = lastTiebreak(last, games)?.winner ?? null;
    if (winner === null) return { ...base, tiebreakOf: last };
    return { ...base, over: true, winner };
  }

  const decided: Side[] = [];
  let winsA = 0;
  let winsB = 0;
  let tiebreakOf: SeriesGame | null = null;
  for (const g of series) {
    const s = standing(g, games);
    if (!s) break;
    if (s.winner === null) { tiebreakOf = g; break; }
    decided.push(s.winner);
    if (s.winner === 'a') winsA++; else winsB++;
    if (winsA > bestOf / 2 || winsB > bestOf / 2) break;
  }
  const winner: Side | null = winsA > bestOf / 2 ? 'a' : winsB > bestOf / 2 ? 'b' : null;
  const over = winner !== null;
  const nextGame = over || tiebreakOf !== null || decided.length >= bestOf ? null : decided.length + 1;
  return { ...base, decided, winsA, winsB, over, winner, tiebreakOf, nextGame };
}

/** The event result for a finished series (play.ts recordResult input), or null while it runs. */
export function seriesResult(v: SeriesVerdict): ResultInput | null {
  if (!v.over || v.winner === null) return null;
  return v.totalScore
    ? { winner: v.winner, scoreA: v.totalA, scoreB: v.totalB, forfeit: false }
    : { winner: v.winner, scoreA: v.winsA, scoreB: v.winsB, forfeit: false };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/seriesRules.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/events/seriesRules.ts tests/seriesRules.test.ts
git commit -m "Tournaments T3b: pure series rules decide games won or total score, ask for tiebreak games on a tie, and name the recorded result"
```

---
### Task 2: Schema, the room writer's series mutations, and the automatic result path

**Files:**
- Modify: `src/db.ts` (the `ensureColumn` block after the T3a lines; `DEFAULT_SETTINGS`), `src/settingsSchema.ts`, `src/events/validate.ts` (error keys), `src/events/play.ts`, `src/events/flow.ts`, `src/events/room.ts`
- Test: `tests/room.test.ts`, `tests/eventsSchema.test.ts`, `tests/eventLogGuard.test.ts`, `tests/eventFlow.test.ts`

**Interfaces:**
- Consumes: Task 1; T3a `room.ts` (`roomState`, `syncGames`, `advance`, `liveMatch`, `gamesOf`, `lineupsOf`, `entryOn`, `sideOf`), T3a `play.ts` `ROOM_OPEN`.
- Produces columns: `event_matches.booked_at`, `server_alerted_at`, `confirm_a_at`, `confirm_b_at`, `dispute_side`, `dispute_by`, `dispute_reason`, `disputed_at`; `event_games.score_a`, `score_b`, `winner`, `map`, `ended_at`; `bookings.next_map`; `booking_sides.present_now`; setting `event_confirm_minutes` (15).
- Produces in `play.ts`: `MatchRow` gains the eight columns above; `recordResult(db, { ..., source?: 'auto' | 'admin' })` writes `result_source = forfeit ? 'forfeit' : source ?? 'admin'`.
- Produces in `flow.ts`: `autoResultFlow(db, { eventId, matchId, result: V.ResultInput, expect: (m) => boolean, now? }): Promise<V.Checked<P.MatchRow>>` (the clock's result: `by` null, `source` 'auto', `expect` checked inside the chain, then settle).
- Produces in `room.ts`:
  - `RoomTimers.confirmMinutes`; `roomTimers` reads `event_confirm_minutes` (15, 5..60).
  - `GameRow` gains `score_a: number | null; score_b: number | null; winner: number | null; map: string | null; ended_at: string | null`.
  - reads: `seriesGames(db, m): SeriesGame[]`, `lineupFour(db, matchId, entryId): string[] | null`, `matchOfBooking(db, bookingId): P.MatchRow | undefined`.
  - `vetoInput` fills `winners` from `seriesVerdict(...).decided`.
  - `actVeto` also runs on `status = 'live'` (a between-game pick); `advance` on a live match sets or clears `deadline` and never moves to `lineup`.
  - mutations (each `V.Checked<P.MatchRow>`, one `event_log` row): `attachBooking({ matchId, bookingId, now? })` `match_booked`; `noteServerAlert({ matchId, now? })` `server_wait_alerted`; `startConnect({ matchId, graceMinutes, now? })` `match_connect`; `startLive({ matchId, now? })` `match_live`; `linkGame({ matchId, gameId, gameMatchId, now? })` `game_started`; `recordGame({ matchId, gameId, scoreA, scoreB, winner: Side | null, now? })` `game_recorded`; `addTiebreak({ matchId, ofGameId, map, firstSurvivors: Side, now? }): V.Checked<GameRow>` `tiebreak_added`; `openPick({ matchId, timers, now? })` `pick_opened`; `startConfirm({ matchId, timers, now? })` `match_confirming`; `confirmResult({ matchId, steamid, now? })` `result_confirmed`; `disputeMatch({ matchId, steamid, reason: unknown, now? })` `match_disputed`.
  - `holdMatch` also holds `connect`, `live`, `confirming`; `resetRoom` also resets those and `admin_hold`, clears the new columns, and refuses `booking_open` while the match's booking is open with no end started; `resumeDeadline` also resumes `live` (step length) and `confirming` (confirm window).
- New error keys in `validate.ts`: `booking_open`, `not_connect_phase`, `not_live_phase`, `not_confirm_phase`, `game_not_found`, `already_confirmed`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/eventsSchema.test.ts`:

```ts
  it('has the series columns and the confirm window setting (plan T3b)', () => {
    const db = openDb(':memory:');
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('event_matches')).toEqual(expect.arrayContaining(['booked_at', 'server_alerted_at', 'confirm_a_at', 'confirm_b_at', 'dispute_side', 'dispute_by', 'dispute_reason', 'disputed_at']));
    expect(cols('event_games')).toEqual(expect.arrayContaining(['score_a', 'score_b', 'winner', 'map', 'ended_at']));
    expect(cols('bookings')).toContain('next_map');
    expect(cols('booking_sides')).toContain('present_now');
    expect((db.prepare("SELECT value FROM settings WHERE key = 'event_confirm_minutes'").get() as { value: string }).value).toBe('15');
  });
```

Append to `tests/room.test.ts` (it already has `at`, `ok`, `open`, `bothReady`, `veto`, `lastAction`; `TIMERS` from `roomFixture.ts` now carries `confirmMinutes: 15`):

```ts
import { presetConfig } from '../src/events/vetoConfig.js';
import { POOL7, fakeBooking, fakeMatch } from './roomFixture.js';
import { autoResultFlow } from '../src/events/flow.js';

/** Ban to one, both lineups locked: status booking, game 1 no_mercy, Bats survive first. */
const toBooking = async (f?: RoomFixture) => {
  f ??= await roomFixture();
  bothReady(f);
  ok(veto(f, A[0], 0, 'first'));
  ok(veto(f, A[0], 1, 'ban', 'dead_air'));
  ok(veto(f, B[0], 2, 'survivors'));
  ok(R.lockLineup(f.db, { matchId: f.matchId, steamid: A[0], steamids: A.slice(0, 4), timers: TIMERS, now: at(4) }));
  ok(R.lockLineup(f.db, { matchId: f.matchId, steamid: B[0], steamids: B.slice(0, 4), timers: TIMERS, now: at(4) }));
  return f;
};
const game = (f: RoomFixture, ordinal: number) => R.gamesOf(f.db, f.matchId).find((g) => g.ordinal === ordinal)!;

describe('series writer (plan T3b)', () => {
  it('walks booking, connect, live, a recorded game and the confirm window, one log row each', async () => {
    const f = await toBooking();
    const bookingId = fakeBooking(f, at(5));
    expect(ok(R.attachBooking(f.db, { matchId: f.matchId, bookingId, now: at(5) }))).toMatchObject({ status: 'booking', booking_id: bookingId, booked_at: at(5).toISOString() });
    expect(lastAction(f)).toEqual({ action: 'match_booked', actor: null });
    expect(ok(R.noteServerAlert(f.db, { matchId: f.matchId, now: at(15) })).server_alerted_at).toBe(at(15).toISOString());
    expect(R.noteServerAlert(f.db, { matchId: f.matchId, now: at(16) })).toEqual({ ok: false, error: 'changed' });
    expect(ok(R.startConnect(f.db, { matchId: f.matchId, graceMinutes: 15, now: at(20) }))).toMatchObject({ status: 'connect', deadline: at(35).toISOString() });
    expect(R.startConnect(f.db, { matchId: f.matchId, graceMinutes: 15, now: at(20) })).toEqual({ ok: false, error: 'wrong_status' });
    const gameMatchId = fakeMatch(f);
    expect(ok(R.linkGame(f.db, { matchId: f.matchId, gameId: game(f, 1).id, gameMatchId, now: at(21) })).status).toBe('connect');
    expect(game(f, 1).match_id).toBe(gameMatchId);
    expect(R.linkGame(f.db, { matchId: f.matchId, gameId: game(f, 1).id, gameMatchId: fakeMatch(f), now: at(21) })).toEqual({ ok: false, error: 'changed' });
    expect(ok(R.startLive(f.db, { matchId: f.matchId, now: at(25) }))).toMatchObject({ status: 'live', deadline: null });
    expect(R.startLive(f.db, { matchId: f.matchId, now: at(25) })).toEqual({ ok: false, error: 'not_connect_phase' });
    ok(R.recordGame(f.db, { matchId: f.matchId, gameId: game(f, 1).id, scoreA: 400, scoreB: 900, winner: 'b', now: at(60) }));
    expect(game(f, 1)).toMatchObject({ score_a: 400, score_b: 900, winner: f.entryB, ended_at: at(60).toISOString() });
    expect(R.recordGame(f.db, { matchId: f.matchId, gameId: game(f, 1).id, scoreA: 1, scoreB: 0, winner: 'a', now: at(61) })).toEqual({ ok: false, error: 'changed' });
    expect(R.seriesGames(f.db, P.getMatch(f.db, f.matchId)!)).toEqual([{ id: game(f, 1).id, ordinal: 1, tiebreakOf: null, scoreA: 400, scoreB: 900, winner: 'b', started: true }]);
    expect(ok(R.startConfirm(f.db, { matchId: f.matchId, timers: TIMERS, now: at(61) }))).toMatchObject({ status: 'confirming', deadline: at(76).toISOString() });
    expect(R.confirmResult(f.db, { matchId: f.matchId, steamid: A[3], now: at(62) })).toEqual({ ok: false, error: 'not_manager' });
    expect(ok(R.confirmResult(f.db, { matchId: f.matchId, steamid: A[1], now: at(62) })).confirm_a_at).toBe(at(62).toISOString());
    expect(R.confirmResult(f.db, { matchId: f.matchId, steamid: A[0], now: at(63) })).toEqual({ ok: false, error: 'already_confirmed' });
    expect(lastAction(f)).toEqual({ action: 'result_confirmed', actor: A[1] });
  });

  it('files a dispute with a reason, from a manager, before the deadline, and nowhere else', async () => {
    const f = await toBooking();
    ok(R.attachBooking(f.db, { matchId: f.matchId, bookingId: fakeBooking(f, at(5)), now: at(5) }));
    ok(R.startConnect(f.db, { matchId: f.matchId, graceMinutes: 15, now: at(5) }));
    ok(R.startLive(f.db, { matchId: f.matchId, now: at(6) }));
    expect(R.disputeMatch(f.db, { matchId: f.matchId, steamid: B[0], reason: 'They had five', now: at(7) })).toEqual({ ok: false, error: 'not_confirm_phase' });
    ok(R.startConfirm(f.db, { matchId: f.matchId, timers: TIMERS, now: at(60) }));
    expect(R.disputeMatch(f.db, { matchId: f.matchId, steamid: B[0], reason: 'no', now: at(61) })).toEqual({ ok: false, error: 'bad_reason' });
    expect(R.disputeMatch(f.db, { matchId: f.matchId, steamid: B[2], reason: 'They had five', now: at(61) })).toEqual({ ok: false, error: 'not_manager' });
    expect(R.disputeMatch(f.db, { matchId: f.matchId, steamid: B[0], reason: 'They had five', now: at(75) })).toEqual({ ok: false, error: 'room_closed' });
    const m = ok(R.disputeMatch(f.db, { matchId: f.matchId, steamid: B[0], reason: 'They had five on map 3', now: at(70) }));
    expect(m).toMatchObject({ status: 'admin_hold', hold_reason: 'dispute', dispute_side: 'b', dispute_by: B[0], dispute_reason: 'They had five on map 3', disputed_at: at(70).toISOString(), deadline: null });
    expect(lastAction(f)).toEqual({ action: 'match_disputed', actor: B[0] });
  });

  it('adds a tiebreak game under its series game with the replayed map and the sides', async () => {
    const f = await toBooking();
    const g1 = game(f, 1);
    const tb = ok(R.addTiebreak(f.db, { matchId: f.matchId, ofGameId: g1.id, map: 'l4d_vs_hospital04_interior', firstSurvivors: 'a', now: at(50) }));
    expect(tb).toMatchObject({ ordinal: 11, campaign: 'no_mercy', tiebreak_of: g1.id, map: 'l4d_vs_hospital04_interior', first_survivors: f.entryA, picked_by: null, side_by: null, match_id: null });
    const tb2 = ok(R.addTiebreak(f.db, { matchId: f.matchId, ofGameId: g1.id, map: 'l4d_vs_hospital04_interior', firstSurvivors: 'b', now: at(90) }));
    expect(tb2.ordinal).toBe(12);
    expect(R.addTiebreak(f.db, { matchId: f.matchId, ofGameId: 999, map: 'x', firstSurvivors: 'a', now: at(91) })).toEqual({ ok: false, error: 'game_not_found' });
  });

  it('runs the loser\'s pick and the side choice on a live match, then clears the deadline', async () => {
    const f = await roomFixture({ pool: POOL7, veto: presetConfig('loser_picks', 7) });
    bothReady(f);
    const opening: [string, number, string, string | null][] = [[A[0], 0, 'first', null], [A[0], 1, 'ban', POOL7[0]!], [B[0], 2, 'ban', POOL7[1]!], [A[0], 3, 'ban', POOL7[2]!], [B[0], 4, 'ban', POOL7[3]!], [A[0], 5, 'pick', POOL7[5]!], [B[0], 6, 'survivors', null]];
    for (const [who, step, action, campaign] of opening) ok(veto(f, who, step, action, campaign));
    ok(R.lockLineup(f.db, { matchId: f.matchId, steamid: A[0], steamids: A.slice(0, 4), timers: TIMERS, now: at(4) }));
    ok(R.lockLineup(f.db, { matchId: f.matchId, steamid: B[0], steamids: B.slice(0, 4), timers: TIMERS, now: at(4) }));
    ok(R.attachBooking(f.db, { matchId: f.matchId, bookingId: fakeBooking(f, at(5)), now: at(5) }));
    ok(R.startConnect(f.db, { matchId: f.matchId, graceMinutes: 15, now: at(5) }));
    ok(R.startLive(f.db, { matchId: f.matchId, now: at(6) }));
    ok(R.linkGame(f.db, { matchId: f.matchId, gameId: game(f, 1).id, gameMatchId: fakeMatch(f), now: at(6) }));
    // Before game 1 has a result the engine is waiting, and a pick is refused.
    expect(veto(f, A[0], 7, 'pick', POOL7[4]!)).toEqual({ ok: false, error: 'step_taken' });
    ok(R.recordGame(f.db, { matchId: f.matchId, gameId: game(f, 1).id, scoreA: 300, scoreB: 700, winner: 'b', now: at(60) }));
    const st = R.roomState(f.db, P.getMatch(f.db, f.matchId)!);
    expect(st.next).toEqual({ kind: 'pick', by: 'a', game: 2 });
    expect(ok(R.openPick(f.db, { matchId: f.matchId, timers: TIMERS, now: at(60) }))).toMatchObject({ status: 'live', deadline: new Date(at(60).getTime() + 60_000).toISOString() });
    expect(veto(f, B[0], 7, 'pick', POOL7[4]!, 61)).toEqual({ ok: false, error: 'not_your_turn' });
    const picked = ok(veto(f, A[0], 7, 'pick', POOL7[4]!, 61));
    expect(picked).toMatchObject({ status: 'live', deadline: new Date(at(61).getTime() + 60_000).toISOString() });
    const sided = ok(veto(f, B[0], 8, 'infected', null, 62));
    expect(sided).toMatchObject({ status: 'live', deadline: null });
    expect(game(f, 2)).toMatchObject({ campaign: POOL7[4], picked_by: f.entryA, side_by: f.entryB, first_survivors: f.entryA, match_id: null });
  });

  it('holds and resets a booked room only once its booking is ending', async () => {
    const f = await toBooking();
    const bookingId = fakeBooking(f, at(5));
    ok(R.attachBooking(f.db, { matchId: f.matchId, bookingId, now: at(5) }));
    ok(R.startConnect(f.db, { matchId: f.matchId, graceMinutes: 15, now: at(5) }));
    expect(ok(R.holdMatch(f.db, { matchId: f.matchId, by: null, reason: 'no_show_both', now: at(20) })).status).toBe('admin_hold');
    expect(R.resetRoom(f.db, { matchId: f.matchId, by: ADMIN, now: at(21) })).toEqual({ ok: false, error: 'booking_open' });
    f.db.prepare('UPDATE bookings SET ending_at = ? WHERE id = ?').run(at(21).toISOString(), bookingId);
    const m = ok(R.resetRoom(f.db, { matchId: f.matchId, by: ADMIN, now: at(22) }));
    expect(m).toMatchObject({ status: 'waiting', booking_id: null, booked_at: null, confirm_a_at: null, dispute_reason: null });
  });

  it('resumes a live pick step and a confirm window, and leaves a connect deadline alone', async () => {
    const f = await toBooking();
    ok(R.attachBooking(f.db, { matchId: f.matchId, bookingId: fakeBooking(f, at(5)), now: at(5) }));
    ok(R.startConnect(f.db, { matchId: f.matchId, graceMinutes: 15, now: at(5) }));
    expect(R.resumeDeadline(f.db, { matchId: f.matchId, timers: TIMERS, now: at(60) })).toEqual({ ok: false, error: 'changed' });
    ok(R.startLive(f.db, { matchId: f.matchId, now: at(6) }));
    f.db.prepare('UPDATE event_matches SET deadline = ? WHERE id = ?').run(at(7).toISOString(), f.matchId);
    expect(ok(R.resumeDeadline(f.db, { matchId: f.matchId, timers: TIMERS, now: at(60) })).deadline).toBe(new Date(at(60).getTime() + 60_000).toISOString());
    ok(R.startConfirm(f.db, { matchId: f.matchId, timers: TIMERS, now: at(61) }));
    expect(ok(R.resumeDeadline(f.db, { matchId: f.matchId, timers: TIMERS, now: at(120) })).deadline).toBe(at(135).toISOString());
  });
});
```

Append to `tests/eventFlow.test.ts` (the file already imports `* as F from '../src/events/flow.js'`, `* as R`, `ADMIN`, `NOW`, `TIMERS` and `roomFixture`, and its ok-or-throw helper is `ok`, not `must`):

```ts
  it('autoResultFlow records a result with result_source auto, only while expect holds (plan T3b)', async () => {
    const f = await roomFixture();
    ok(R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS, now: NOW }));
    const early = await F.autoResultFlow(f.db, { eventId: f.eventId, matchId: f.matchId, result: { winner: 'b', scoreA: 1, scoreB: 2, forfeit: false }, expect: (m) => m.status === 'confirming', now: NOW });
    expect(early).toEqual({ ok: false, error: 'changed' });
    f.db.prepare("UPDATE event_matches SET status = 'confirming' WHERE id = ?").run(f.matchId);
    const r = await F.autoResultFlow(f.db, { eventId: f.eventId, matchId: f.matchId, result: { winner: 'b', scoreA: 1, scoreB: 2, forfeit: false }, expect: (m) => m.status === 'confirming', now: NOW });
    expect(r.ok && r.value).toMatchObject({ status: 'done', winner_entry: f.entryB, score_a: 1, score_b: 2, result_source: 'auto', deadline: null });
    const log = f.db.prepare("SELECT actor, detail FROM event_log WHERE action = 'result_recorded'").get() as { actor: string | null; detail: string };
    expect(log.actor).toBeNull();
    expect(JSON.parse(log.detail)).toMatchObject({ correction: false, source: 'auto' });
  });
```

(the raw `UPDATE ... status = 'confirming'` is test setup only; `startConfirm` needs a live match, which Task 5's fixture provides properly.)

In `tests/eventLogGuard.test.ts`'s room guard: add to `ROOM_READS`: `'seriesGames', 'lineupFour', 'matchOfBooking'`; add to `ROOM_MUTATIONS` (each on a `driveToBooking` fixture unless said; `event_matches.booking_id` and `event_games.match_id` are foreign keys and the db runs with them on, so every `bookingId` is a `fakeBooking(f, at)` row and every `gameMatchId` a `fakeMatch(f)` row, both exported from `tests/roomFixture.ts` in Step 5):
- `attachBooking`: `match_booked`, actor null, run with a `fakeBooking`.
- `noteServerAlert`: `server_wait_alerted`, null, setup attachBooking.
- `startConnect`: `match_connect`, null, setup attachBooking.
- `startLive`: `match_live`, null, setup attachBooking + startConnect.
- `linkGame`: `game_started`, null, setup attachBooking + startConnect, run with game 1 and a `fakeMatch`.
- `recordGame`: `game_recorded`, null, setup through startLive + linkGame, run `{ scoreA: 1, scoreB: 2, winner: 'b' }`.
- `addTiebreak`: `tiebreak_added`, null, setup through startLive.
- `openPick`: `pick_opened`, null, setup: the loser picks opening of the room test driven through startLive, linkGame and a recorded game 1. The guard loop builds a plain `roomFixture()`, so this setup first rewrites the stage as `roomFixture` does for its options (`UPDATE event_stages SET campaign_pool_json = ?, veto_json = ? WHERE id = ?` with `POOL7` and `presetConfig('loser_picks', 7)`; test setup only, before the room opens).
- `startConfirm`: `match_confirming`, null, setup through startLive.
- `confirmResult`: `result_confirmed`, actor `A[0]`, setup through startConfirm.
- `disputeMatch`: `match_disputed`, actor `B[0]`, setup through startConfirm, reason `'They had five'`.
Extend `rows(f)` to include the new columns (it selects `*`, so nothing to change if it does).

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/eventsSchema.test.ts tests/room.test.ts tests/eventFlow.test.ts tests/eventLogGuard.test.ts`
Expected: FAIL (no columns, no functions).

- [ ] **Step 3: Schema, settings, error keys**

In `src/db.ts`, after the T3a `ensureColumn` lines:

```ts
  // Tournaments plan T3b: the series. booked_at is when the engine made the
  // match's booking (the 10 minute "waiting for a server" alert counts from
  // it, server_alerted_at says it went out); the confirm window and a
  // dispute live on the match, a game's score, winner (entry id), the one
  // chapter a tiebreak replays and when it ended on event_games.
  ensureColumn(db, 'event_matches', 'booked_at', 'TEXT');
  ensureColumn(db, 'event_matches', 'server_alerted_at', 'TEXT');
  ensureColumn(db, 'event_matches', 'confirm_a_at', 'TEXT');
  ensureColumn(db, 'event_matches', 'confirm_b_at', 'TEXT');
  ensureColumn(db, 'event_matches', 'dispute_side', "TEXT CHECK (dispute_side IN ('a','b'))");
  ensureColumn(db, 'event_matches', 'dispute_by', 'TEXT');
  ensureColumn(db, 'event_matches', 'dispute_reason', 'TEXT');
  ensureColumn(db, 'event_matches', 'disputed_at', 'TEXT');
  ensureColumn(db, 'event_games', 'score_a', 'INTEGER');
  ensureColumn(db, 'event_games', 'score_b', 'INTEGER');
  ensureColumn(db, 'event_games', 'winner', 'INTEGER REFERENCES event_entries(id)');
  ensureColumn(db, 'event_games', 'map', 'TEXT');
  ensureColumn(db, 'event_games', 'ended_at', 'TEXT');
```

In the booking `ensureColumn` block (after `close_at`):

```ts
  // Tournaments plan T3b: a tiebreak game is one chapter, so the runner is
  // told which map to load rather than the campaign's first (loadNext);
  // present_now is who was on the box at the last minute watch, per side.
  ensureColumn(db, 'bookings', 'next_map', 'TEXT');
  ensureColumn(db, 'booking_sides', 'present_now', 'INTEGER NOT NULL DEFAULT 0');
```

In `DEFAULT_SETTINGS`, after `event_lineup_minutes`: `event_confirm_minutes: '15',`.

In `src/settingsSchema.ts`, after `event_lineup_minutes`:

```ts
  { key: 'event_confirm_minutes', group: 'Competitive', label: 'Tournament confirm window (minutes)', help: 'After the last game of a tournament match, how long either captain has to confirm or dispute the result before it is recorded on its own.', type: { kind: 'int', min: 5, max: 60 } },
```

In `src/events/validate.ts` `EVENT_ERRORS`, add:

```ts
  booking_open: { status: 409, text: 'This match still holds a server booking. Cancel it first (Reset room does).' },
  not_connect_phase: { status: 409, text: 'This match is not waiting for the teams to connect.' },
  not_live_phase: { status: 409, text: 'This match is not being played.' },
  not_confirm_phase: { status: 409, text: 'This match is not in its confirm window.' },
  game_not_found: { status: 404, text: 'No such game in this match.' },
  already_confirmed: { status: 409, text: 'Your team has already confirmed the result.' },
```

- [ ] **Step 4: play.ts and flow.ts**

In `src/events/play.ts`:
- `MatchRow` gains `booked_at: string | null; server_alerted_at: string | null; confirm_a_at: string | null; confirm_b_at: string | null; dispute_side: 'a' | 'b' | null; dispute_by: string | null; dispute_reason: string | null; disputed_at: string | null;`.
- `recordResult`'s options gain `source?: 'auto' | 'admin'`; its final UPDATE writes `o.result.forfeit ? 'forfeit' : o.source ?? 'admin'` for `result_source`, and the `result_recorded` log detail gains `source: o.result.forfeit ? 'forfeit' : o.source ?? 'admin'`.

In `src/events/flow.ts`:
- `report(db, m, by, result, now?, source: 'auto' | 'admin' = 'admin')` passes `source` into both `P.recordResult` calls.
- Add, after `forfeitMatch`:

```ts
/** The series engine's result (plan T3b Ruling 9): the clock recorded it, so
 *  by is null and result_source is 'auto'. expect re-checks the match inside
 *  the event's chain (a dispute or an admin result that landed first wins),
 *  then the event settles as after any result. */
export async function autoResultFlow(
  db: DB, o: { eventId: number; matchId: number; result: V.ResultInput; expect: (m: P.MatchRow) => boolean; now?: Date },
): Promise<V.Checked<P.MatchRow>> {
  const r = await serialize(o.eventId, async (): Promise<V.Checked<P.MatchRow>> => {
    const m = P.getMatch(db, o.matchId);
    if (!m || m.event_id !== o.eventId) return V.fail('match_not_found');
    if (!o.expect(m)) return V.fail('changed');
    return report(db, m, null, o.result, o.now, 'auto');
  });
  if (r.ok) {
    try {
      await settleEvent(db, { eventId: o.eventId, now: o.now });
    } catch (err) {
      console.error(`[events] settle after an automatic result in event ${o.eventId} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return r;
}
```

- [ ] **Step 5: room.ts**

Imports: add `import { seriesVerdict, tiebreakOrdinal, type SeriesGame } from './seriesRules.js';`.

Replace `RoomTimers`, `roomTimers`, `GameRow` and `vetoInput`:

```ts
export interface RoomTimers { readyMinutes: number; stepSeconds: number; lineupMinutes: number; confirmMinutes: number }
export interface GameRow {
  id: number; event_match_id: number; ordinal: number; campaign: string; picked_by: number | null; side_by: number | null;
  first_survivors: number | null; match_id: number | null; tiebreak_of: number | null; created_at: string;
  score_a: number | null; score_b: number | null; winner: number | null; map: string | null; ended_at: string | null;
}

export function roomTimers(db: DB): RoomTimers {
  return {
    readyMinutes: settingNumber(db, 'event_ready_minutes', 10, { min: 2, max: 30, integer: true }),
    stepSeconds: settingNumber(db, 'event_veto_step_seconds', 60, { min: 20, max: 300, integer: true }),
    lineupMinutes: settingNumber(db, 'event_lineup_minutes', 5, { min: 1, max: 15, integer: true }),
    confirmMinutes: settingNumber(db, 'event_confirm_minutes', 15, { min: 5, max: 60, integer: true }),
  };
}

/** The series so far as the pure rules see it (plan T3b). Sides are the
 *  match's entry_a and entry_b. */
export function seriesGames(db: DB, m: P.MatchRow): SeriesGame[] {
  return gamesOf(db, m.id).map((g) => ({
    id: g.id, ordinal: g.ordinal, tiebreakOf: g.tiebreak_of, scoreA: g.score_a, scoreB: g.score_b,
    winner: g.winner === null ? null : g.winner === m.entry_a ? 'a' : 'b', started: g.match_id !== null,
  }));
}

/** The winners of the games played so far feed "loser picks" (T3a Ruling 8). */
export function vetoInput(db: DB, m: P.MatchRow): VetoInput {
  const s = E.stageSettingsOf(E.getStage(db, m.stage_id)!);
  return {
    config: s.veto, pool: s.campaignPool, higher: m.room_higher ?? 'a', seed: m.room_seed ?? 0, actions: vetoActions(db, m.id),
    winners: seriesVerdict(s.veto, seriesGames(db, m)).decided,
  };
}

/** The four a team locked for this match (game 1 carries the series, Ruling 6). */
export function lineupFour(db: DB, matchId: number, entryId: number): string[] | null {
  const row = lineupsOf(db, matchId).find((l) => l.game === 1 && l.entry_id === entryId);
  return row ? JSON.parse(row.steamids) as string[] : null;
}

export function matchOfBooking(db: DB, bookingId: number): P.MatchRow | undefined {
  return db.prepare('SELECT * FROM event_matches WHERE booking_id = ?').get(bookingId) as P.MatchRow | undefined;
}
```

Replace `advance`:

```ts
/** After both teams are ready or after a veto action: the next step's
 *  deadline; the lineups once nothing is left for a person to do; on a live
 *  match (a between-game pick, plan T3b Ruling 4) the deadline clears and
 *  the series engine schedules the game. */
function advance(db: DB, matchId: number, timers: RoomTimers, now: Date): void {
  const m = P.getMatch(db, matchId)!;
  const st = roomState(db, m);
  syncGames(db, m, st, iso(now));
  if (isHumanStep(st.next)) {
    db.prepare('UPDATE event_matches SET deadline = ? WHERE id = ?').run(plus(now, timers.stepSeconds * 1000), m.id);
  } else if (m.status === 'live') {
    db.prepare('UPDATE event_matches SET deadline = NULL WHERE id = ?').run(m.id);
  } else {
    db.prepare("UPDATE event_matches SET status = 'lineup', deadline = ? WHERE id = ?").run(plus(now, timers.lineupMinutes * 60_000), m.id);
  }
}
```

In `actVeto`, replace the phase check with:

```ts
    const inVeto = m.status === 'veto' && m.ready_a_at !== null && m.ready_b_at !== null;
    if (!inVeto && m.status !== 'live') return V.fail('not_veto_phase');
```

Replace the three sets and `resumeDeadline`:

```ts
const HOLDABLE: ReadonlySet<P.MatchStatus> = new Set<P.MatchStatus>(['veto', 'lineup', 'booking', 'connect', 'live', 'confirming']);
const RESETTABLE: ReadonlySet<P.MatchStatus> = new Set<P.MatchStatus>(['veto', 'lineup', 'booking', 'connect', 'live', 'confirming', 'admin_hold']);

/** Ruling 16 (T3a) and T3b Ruling 18: an overdue deadline found at start gets
 *  its phase's full length from now; connect is left alone (presence
 *  decides); anything else is refused as 'changed'. */
export function resumeDeadline(db: DB, o: { matchId: number; timers: RoomTimers; now?: Date }): V.Checked<P.MatchRow> {
  const now = o.now ?? new Date();
  const at = iso(now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const m = P.getMatch(db, o.matchId);
    const resumable = m && (m.status === 'veto' || m.status === 'lineup' || m.status === 'live' || m.status === 'confirming');
    if (!m || !resumable || m.deadline === null || m.deadline > at) return V.fail('changed');
    const ready = m.status === 'veto' && (m.ready_a_at === null || m.ready_b_at === null);
    const ms = m.status === 'lineup' ? o.timers.lineupMinutes * 60_000
      : m.status === 'confirming' ? o.timers.confirmMinutes * 60_000
        : ready ? o.timers.readyMinutes * 60_000 : o.timers.stepSeconds * 1000;
    db.prepare('UPDATE event_matches SET deadline = ? WHERE id = ?').run(plus(now, ms), m.id);
    E.logEvent(db, m.event_id, null, 'room_resumed', at, { matchId: m.id, was: m.deadline });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}
```

In `resetRoom`, after the `RESETTABLE` check add the booking guard, and widen the UPDATE:

```ts
    if (m.booking_id !== null) {
      const b = db.prepare('SELECT ending_at FROM bookings WHERE id = ?').get(m.booking_id) as { ending_at: string | null } | undefined;
      if (b && b.ending_at === null) return V.fail('booking_open');
    }
    for (const t of ['event_vetoes', 'event_games', 'event_lineups']) db.prepare(`DELETE FROM ${t} WHERE event_match_id = ?`).run(m.id);
    db.prepare(
      `UPDATE event_matches SET status = 'waiting', room_opened_at = NULL, room_higher = NULL, room_seed = NULL, ready_a_at = NULL,
         ready_b_at = NULL, deadline = NULL, hold_reason = NULL, booking_id = NULL, booked_at = NULL, server_alerted_at = NULL,
         confirm_a_at = NULL, confirm_b_at = NULL, dispute_side = NULL, dispute_by = NULL, dispute_reason = NULL, disputed_at = NULL
       WHERE id = ?`,
    ).run(m.id);
```

Add the series mutations (after `resumeDeadline`):

```ts
// ---------- the series (plan T3b) ----------

/** A match's booking, made by the series engine the moment lineups lock (Ruling 2). */
export function attachBooking(db: DB, o: { matchId: number; bookingId: number; now?: Date }): V.Checked<P.MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (m.status !== 'booking' || m.booking_id !== null) return V.fail('wrong_status');
    db.prepare('UPDATE event_matches SET booking_id = ?, booked_at = ? WHERE id = ?').run(o.bookingId, at, m.id);
    E.logEvent(db, ev.id, null, 'match_booked', at, { matchId: m.id, bookingId: o.bookingId });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

/** Staff were told the match has waited 10 minutes for a server (Ruling 8); once. */
export function noteServerAlert(db: DB, o: { matchId: number; now?: Date }): V.Checked<P.MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const m = P.getMatch(db, o.matchId);
    if (!m || m.status !== 'booking' || m.booking_id === null || m.server_alerted_at !== null) return V.fail('changed');
    db.prepare('UPDATE event_matches SET server_alerted_at = ? WHERE id = ?').run(at, m.id);
    E.logEvent(db, m.event_id, null, 'server_wait_alerted', at, { matchId: m.id, bookingId: m.booking_id });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

/** The server is ready: the teams have the grace to connect (Ruling 7). */
export function startConnect(db: DB, o: { matchId: number; graceMinutes: number; now?: Date }): V.Checked<P.MatchRow> {
  const now = o.now ?? new Date();
  const at = iso(now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (m.status !== 'booking' || m.booking_id === null) return V.fail('wrong_status');
    db.prepare("UPDATE event_matches SET status = 'connect', deadline = ? WHERE id = ?").run(plus(now, o.graceMinutes * 60_000), m.id);
    E.logEvent(db, ev.id, null, 'match_connect', at, { matchId: m.id, graceMinutes: o.graceMinutes });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

/** The first game went live. */
export function startLive(db: DB, o: { matchId: number; now?: Date }): V.Checked<P.MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (m.status !== 'connect') return V.fail('not_connect_phase');
    db.prepare("UPDATE event_matches SET status = 'live', deadline = NULL WHERE id = ?").run(m.id);
    E.logEvent(db, ev.id, null, 'match_live', at, { matchId: m.id });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

function gameIn(db: DB, m: P.MatchRow, gameId: number): GameRow | undefined {
  return gamesOf(db, m.id).find((g) => g.id === gameId);
}

/** A game was pushed to the box as this matches row (Ruling 15). */
export function linkGame(db: DB, o: { matchId: number; gameId: number; gameMatchId: number; now?: Date }): V.Checked<P.MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    // Game 1 is pushed during setup, before the connect phase (Ruling 3).
    if (m.status !== 'booking' && m.status !== 'connect' && m.status !== 'live') return V.fail('wrong_status');
    const g = gameIn(db, m, o.gameId);
    if (!g) return V.fail('game_not_found');
    if (g.match_id !== null) return V.fail('changed');
    db.prepare('UPDATE event_games SET match_id = ? WHERE id = ?').run(o.gameMatchId, g.id);
    E.logEvent(db, ev.id, null, 'game_started', at, { matchId: m.id, gameId: g.id, ordinal: g.ordinal, campaign: g.campaign, gameMatchId: o.gameMatchId });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

/** A game's campaign total from our capture (Ruling 5). winner null is a tie. */
export function recordGame(
  db: DB, o: { matchId: number; gameId: number; scoreA: number; scoreB: number; winner: Side | null; now?: Date },
): V.Checked<P.MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (m.status !== 'live') return V.fail('not_live_phase');
    const g = gameIn(db, m, o.gameId);
    if (!g) return V.fail('game_not_found');
    if (g.match_id === null || g.score_a !== null) return V.fail('changed');
    db.prepare('UPDATE event_games SET score_a = ?, score_b = ?, winner = ?, ended_at = ? WHERE id = ?')
      .run(o.scoreA, o.scoreB, o.winner === null ? null : entryOn(m, o.winner), at, g.id);
    E.logEvent(db, ev.id, null, 'game_recorded', at, { matchId: m.id, gameId: g.id, ordinal: g.ordinal, scoreA: o.scoreA, scoreB: o.scoreB, winner: o.winner });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

/** Ruling 5: one chapter, replayed; sides as the rules say. */
export function addTiebreak(db: DB, o: { matchId: number; ofGameId: number; map: string; firstSurvivors: Side; now?: Date }): V.Checked<GameRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<GameRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (m.status !== 'live') return V.fail('not_live_phase');
    const parent = gameIn(db, m, o.ofGameId);
    if (!parent || parent.tiebreak_of !== null) return V.fail('game_not_found');
    const ordinal = tiebreakOrdinal(parent, seriesGames(db, m));
    // Ruling 5: ten tiebreaks of one game fill its range; the unique index is never hit.
    if (gamesOf(db, m.id).some((g) => g.ordinal === ordinal)) return V.fail('changed');
    const id = Number(db.prepare(
      `INSERT INTO event_games (event_match_id, ordinal, campaign, picked_by, side_by, first_survivors, tiebreak_of, map, created_at)
       VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
    ).run(m.id, ordinal, parent.campaign, entryOn(m, o.firstSurvivors), parent.id, o.map, at).lastInsertRowid);
    E.logEvent(db, ev.id, null, 'tiebreak_added', at, { matchId: m.id, gameId: id, ofGame: parent.ordinal, map: o.map, firstSurvivors: o.firstSurvivors });
    return V.ok(gameIn(db, m, id)!);
  })();
}

/** Ruling 4: the loser's pick (and the side choice after it) runs on the
 *  live match with the veto step's timer. */
export function openPick(db: DB, o: { matchId: number; timers: RoomTimers; now?: Date }): V.Checked<P.MatchRow> {
  const now = o.now ?? new Date();
  const at = iso(now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (m.status !== 'live' || m.deadline !== null) return V.fail('not_live_phase');
    const st = roomState(db, m);
    if (!isHumanStep(st.next)) return V.fail('changed');
    db.prepare('UPDATE event_matches SET deadline = ? WHERE id = ?').run(plus(now, o.timers.stepSeconds * 1000), m.id);
    E.logEvent(db, ev.id, null, 'pick_opened', at, { matchId: m.id, step: st.used, kind: st.next.kind, by: st.next.by });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

/** The series is over: the confirm window opens (Ruling 9). */
export function startConfirm(db: DB, o: { matchId: number; timers: RoomTimers; now?: Date }): V.Checked<P.MatchRow> {
  const now = o.now ?? new Date();
  const at = iso(now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (m.status !== 'live') return V.fail('not_live_phase');
    db.prepare("UPDATE event_matches SET status = 'confirming', deadline = ?, confirm_a_at = NULL, confirm_b_at = NULL WHERE id = ?")
      .run(plus(now, o.timers.confirmMinutes * 60_000), m.id);
    E.logEvent(db, ev.id, null, 'match_confirming', at, { matchId: m.id });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

export function confirmResult(db: DB, o: { matchId: number; steamid: string; now?: Date }): V.Checked<P.MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (m.status !== 'confirming') return V.fail('not_confirm_phase');
    const side = sideOf(db, m, o.steamid);
    if (!side) return V.fail('not_manager');
    if ((side === 'a' ? m.confirm_a_at : m.confirm_b_at) !== null) return V.fail('already_confirmed');
    db.prepare(`UPDATE event_matches SET ${side === 'a' ? 'confirm_a_at' : 'confirm_b_at'} = ? WHERE id = ?`).run(at, m.id);
    E.logEvent(db, ev.id, o.steamid, 'result_confirmed', at, { matchId: m.id, side });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

const REASON_MIN = 3;

/** Ruling 9: a dispute holds the match for staff. Refused at or after the
 *  deadline. The reason shows on the room page and in the staff alert, so
 *  it goes through V.normalizeReason (one clean line, at most 300
 *  characters) plus the same 3 character minimum as an admin hold (T3a). */
export function disputeMatch(db: DB, o: { matchId: number; steamid: string; reason: unknown; now?: Date }): V.Checked<P.MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (m.status !== 'confirming') return V.fail('not_confirm_phase');
    if (m.deadline !== null && at >= m.deadline) return V.fail('room_closed');
    const side = sideOf(db, m, o.steamid);
    if (!side) return V.fail('not_manager');
    const nr = V.normalizeReason(o.reason);
    const reason = nr.ok ? nr.value ?? '' : '';
    if (reason.length < REASON_MIN) return V.fail('bad_reason');
    db.prepare(
      `UPDATE event_matches SET status = 'admin_hold', hold_reason = 'dispute', deadline = NULL,
         dispute_side = ?, dispute_by = ?, dispute_reason = ?, disputed_at = ? WHERE id = ?`,
    ).run(side, o.steamid, reason, at, m.id);
    E.logEvent(db, ev.id, o.steamid, 'match_disputed', at, { matchId: m.id, side, reason });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}
```

In `tests/roomFixture.ts`, set `TIMERS = { readyMinutes: 10, stepSeconds: 60, lineupMinutes: 5, confirmMinutes: 15 }`, export `driveToBooking(f: RoomFixture): void` (the `toBooking` steps above, synchronous: `openRoom` at `NOW`, both `readyUp` at `NOW` + 1 min, the three ban-to-one actions at + 2, both `lockLineup` at + 4) so the guard test and Task 5's fixture share it, and export the two foreign-key helpers the room and guard tests use. The file today imports only `type RoomTimers` from `room.js` and `rosterA`, `rosterB` from the entry fixture, so add `import * as R from '../src/events/room.js';`, `A`, `B` to the entry fixture import, and:

```ts
import { currentSeasonId } from '../src/players.js';

/** A minimal tournament booking row (event_matches.booking_id is a foreign key). Test setup only. */
export function fakeBooking(f: RoomFixture, at: Date): number {
  return Number(f.db.prepare(
    `INSERT INTO bookings (purpose, region, starts_at, ends_at, password, tv_password, game_config, rules_json, playlist_json, created_by, created_at)
     VALUES ('tournament', 'na', ?, ?, 'p', 't', 'standard', '{}', '["no_mercy"]', ?, ?)`,
  ).run(at.toISOString(), new Date(at.getTime() + 90 * 60_000).toISOString(), ADMIN, at.toISOString()).lastInsertRowid);
}

/** A minimal live matches row (event_games.match_id is a foreign key). Test setup only. */
export function fakeMatch(f: RoomFixture): number {
  return Number(f.db.prepare("INSERT INTO matches (season_id, state, campaign, kind) VALUES (?, 'live', 'no_mercy', 'tournament')").run(currentSeasonId(f.db)).lastInsertRowid);
}
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/eventsSchema.test.ts tests/room.test.ts tests/eventFlow.test.ts tests/eventLogGuard.test.ts tests/roomClock.test.ts tests/roomViews.test.ts && npm run typecheck`
Expected: PASS. The T3a room tests still pass (the ban to one path is unchanged). If `roomViews.test.ts` fails on `next` being computed for a `live` match, that is Task 8's change; it must not fail here because `next` is still gated on `status === 'veto'` until then.

- [ ] **Step 7: Commit**

```bash
git add src/db.ts src/settingsSchema.ts src/events/validate.ts src/events/play.ts src/events/flow.ts src/events/room.ts tests/roomFixture.ts tests/room.test.ts tests/eventsSchema.test.ts tests/eventFlow.test.ts tests/eventLogGuard.test.ts
git commit -m "Tournaments T3b: series columns, the room writer's booking, connect, live, game, tiebreak, pick, confirm and dispute mutations, loser picks on a live match, and an automatic result path"
```

---
### Task 3: Tournament bookings and tournament game rows

**Files:**
- Modify: `src/bookings/bookings.ts` (`BookingRow`, `SideRow`, `setNext`, `advancePlaylist`, `recordPresence`; new writers), `src/bookings/rules.ts` (nothing; `addCampaignMinutes` is reused)
- Create: `src/bookings/tournamentGames.ts`
- Test: `tests/tournamentBooking.test.ts` (new)

**Interfaces:**
- Consumes: `estimateMinutes`, `addCampaignMinutes` (rules.ts), `campaignRegistry`, `newLeasePassword`, `newToken` (`src/matchToken.ts`), `isMapName` (`src/campaigns.ts`), `quoted`, `consoleText` (`src/serverSetup.ts`), `currentSeasonId` (`src/players.ts`).
- Produces in `bookings.ts`:
  - `BookingRow.next_map: string | null`; `SideRow.present_now: number`.
  - `interface TournamentSide { teamId: number | null; captain: string; players: string[]; spectators: string[] }`
  - `createTournamentBooking(db, { region, campaign, rulesJson, rulesetId: number | null, gameConfig, createdBy, sides: [TournamentSide, TournamentSide], now? }): Result<{ id: number }>` (errors `bad_campaign`, `bad_config`)
  - `appendTournamentGame(db, { bookingId, campaign, map: string | null, now? }): Result<{ gamesAllowed: number; endsAt: string }>` (`wrong_state` unless an open tournament booking)
  - `setNext(db, id, campaign, atIso, now?, actor?, map: string | null = null)` writes `next_map`; `advancePlaylist` clears it.
  - `recordPresence` also writes `present_now` per side.
- Produces in `tournamentGames.ts`:
  - `createTournamentGame(db, { bookingId, serverId, campaign, teams: { a: string[]; b: string[] }, bookingSideA: Side, now? }): { matchId: number; token: string }` inserts `matches` (`state 'live'`, `origin 'queue'`, `kind 'tournament'`, `visibility 'participants'`, the booking's `rules_json` and `game_config`, `booking_id`, `booking_side_a`) and eight `match_players` rows (`source 'web'`), and one `booking_events` row `game_started`.
  - `gameLinesOf(db, { matchId, stopAfterMap: string | null, notice: string }): string[]` builds `sm_pug_match`, the quoted roster lines and `l4d_ready_league_notice` from the rows (throws on a bad map or token, as `resumeLines` does).
  - `isPendingGame(db, matchId): boolean` (a `live` row with no `match_live` heartbeat yet).

- [ ] **Step 1: Write the failing tests**

Create `tests/tournamentBooking.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { appendTournamentGame, createTournamentBooking, getBooking, peopleOf, recordPresence, setNext, sidesOf, advancePlaylist } from '../src/bookings/bookings.js';
import { createTournamentGame, gameLinesOf, isPendingGame } from '../src/bookings/tournamentGames.js';

const P = Array.from({ length: 10 }, (_, i) => `765611990000009${String(i).padStart(2, '0')}`);
const NOW = new Date('2026-10-07T20:00:00.000Z');
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  const ins = db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, ?, 'active')");
  P.forEach((id, i) => ins.run(id, `p${i}`));
});

const sides = () => [
  { teamId: null, captain: P[0]!, players: P.slice(0, 4), spectators: [P[8]!] },
  { teamId: null, captain: P[4]!, players: P.slice(4, 8), spectators: [] },
] as const;

describe('createTournamentBooking', () => {
  it('makes a confirmed booking that starts now with the locked four as players and the rest as spectators', () => {
    const r = createTournamentBooking(db, { region: 'na', campaign: 'no_mercy', rulesJson: '{}', rulesetId: null, gameConfig: 'standard', createdBy: P[9]!, sides: [sides()[0], sides()[1]], now: NOW });
    if (!r.ok) throw new Error(r.error);
    const b = getBooking(db, r.value.id)!;
    expect(b).toMatchObject({ purpose: 'tournament', state: 'scheduled', region: 'na', starts_at: NOW.toISOString(), games_allowed: 1, playlist_pos: 0, created_by: P[9], next_map: null });
    expect(JSON.parse(b.playlist_json)).toEqual(['no_mercy']);
    // 15 base + 60 typical + 10 slack = 85, up to the 30 minute step and the 60 minute floor: 90.
    expect(Date.parse(b.ends_at) - Date.parse(b.starts_at)).toBe(90 * 60_000);
    expect(sidesOf(db, b.id).map((s) => [s.side, s.captain_steamid, s.confirmed_at !== null])).toEqual([['a', P[0], true], ['b', P[4], true]]);
    expect(peopleOf(db, b.id).map((p) => [p.side, p.steamid, p.role, p.status])).toEqual([
      ...P.slice(0, 4).map((s) => ['a', s, 'player', 'accepted']), ['a', P[8], 'spectator', 'accepted'],
      ...P.slice(4, 8).map((s) => ['b', s, 'player', 'accepted']),
    ]);
    const ev = db.prepare('SELECT event, detail FROM booking_events WHERE booking_id = ?').all(b.id) as { event: string; detail: string }[];
    expect(ev).toEqual([{ event: 'created', detail: JSON.stringify({ purpose: 'tournament', campaign: 'no_mercy', minutes: 90 }) }]);
  });

  it('refuses an unknown campaign or a game config that is off', () => {
    expect(createTournamentBooking(db, { region: 'na', campaign: 'nowhere', rulesJson: '{}', rulesetId: null, gameConfig: 'standard', createdBy: P[9]!, sides: [sides()[0], sides()[1]], now: NOW })).toEqual({ ok: false, error: 'bad_campaign' });
    expect(createTournamentBooking(db, { region: 'na', campaign: 'no_mercy', rulesJson: '{}', rulesetId: null, gameConfig: 'nope', createdBy: P[9]!, sides: [sides()[0], sides()[1]], now: NOW })).toEqual({ ok: false, error: 'bad_config' });
  });
});

describe('appendTournamentGame, setNext with a map, presence', () => {
  it('grows the playlist, the count and the slot, and stages a single chapter as the next map', () => {
    const r = createTournamentBooking(db, { region: 'na', campaign: 'no_mercy', rulesJson: '{}', rulesetId: null, gameConfig: 'standard', createdBy: P[9]!, sides: [sides()[0], sides()[1]], now: NOW });
    if (!r.ok) throw new Error(r.error);
    const id = r.value.id;
    const a = appendTournamentGame(db, { bookingId: id, campaign: 'dead_air', map: null, now: NOW });
    expect(a).toEqual({ ok: true, value: { gamesAllowed: 2, endsAt: new Date(Date.parse(getBooking(db, id)!.starts_at) + 90 * 60_000 + 90 * 60_000).toISOString() } });
    const t = appendTournamentGame(db, { bookingId: id, campaign: 'dead_air', map: 'l4d_vs_airport04_terminal', now: NOW });
    expect(t.ok && t.value.gamesAllowed).toBe(3);
    expect(JSON.parse(getBooking(db, id)!.playlist_json)).toEqual(['no_mercy', 'dead_air', 'dead_air']);
    db.prepare("UPDATE bookings SET state = 'active' WHERE id = ?").run(id);
    expect(setNext(db, id, 'dead_air', NOW.toISOString(), NOW, null, 'l4d_vs_airport04_terminal')).toBe(true);
    expect(getBooking(db, id)).toMatchObject({ next_campaign: 'dead_air', next_map: 'l4d_vs_airport04_terminal' });
    expect(advancePlaylist(db, id, 2, NOW)).toBe(true);
    expect(getBooking(db, id)).toMatchObject({ next_campaign: null, next_map: null, playlist_pos: 2 });
    recordPresence(db, id, { a: 3, b: 4 }, true, NOW);
    expect(sidesOf(db, id).map((s) => [s.peak_present, s.present_now])).toEqual([[3, 3], [4, 4]]);
    recordPresence(db, id, { a: 1, b: 4 }, true, NOW);
    expect(sidesOf(db, id).map((s) => [s.peak_present, s.present_now])).toEqual([[3, 1], [4, 4]]);
    db.prepare("UPDATE bookings SET ending_at = ? WHERE id = ?").run(NOW.toISOString(), id);
    expect(appendTournamentGame(db, { bookingId: id, campaign: 'dead_air', map: null, now: NOW })).toEqual({ ok: false, error: 'wrong_state' });
  });
});

describe('createTournamentGame and gameLinesOf', () => {
  it('inserts a participants-only tournament game under the booking and builds the plugin burst', () => {
    const r = createTournamentBooking(db, { region: 'na', campaign: 'no_mercy', rulesJson: '{"x":1}', rulesetId: null, gameConfig: 'standard', createdBy: P[9]!, sides: [sides()[0], sides()[1]], now: NOW });
    if (!r.ok) throw new Error(r.error);
    const serverId = addServer(db, { name: 'box', host: '10.0.0.1', port: 27015, rconPort: 1, rconPassword: 'x' });
    const g = createTournamentGame(db, { bookingId: r.value.id, serverId, campaign: 'no_mercy', teams: { a: P.slice(4, 8), b: P.slice(0, 4) }, bookingSideA: 'b', now: NOW });
    const row = db.prepare('SELECT state, campaign, server_id, token, origin, kind, visibility, rules_json, game_config, booking_id, booking_side_a, went_live_at FROM matches WHERE id = ?').get(g.matchId) as Record<string, unknown>;
    expect(row).toEqual({ state: 'live', campaign: 'no_mercy', server_id: serverId, token: g.token, origin: 'queue', kind: 'tournament', visibility: 'participants', rules_json: '{"x":1}', game_config: 'standard', booking_id: r.value.id, booking_side_a: 'b', went_live_at: null });
    const players = db.prepare('SELECT player_id, team, source FROM match_players WHERE match_id = ? ORDER BY team, player_id').all(g.matchId);
    expect(players).toEqual([...P.slice(4, 8).map((s) => ({ player_id: s, team: 'a', source: 'web' })), ...P.slice(0, 4).map((s) => ({ player_id: s, team: 'b', source: 'web' }))]);
    expect(isPendingGame(db, g.matchId)).toBe(true);
    const lines = gameLinesOf(db, { matchId: g.matchId, stopAfterMap: 'l4d_vs_hospital04_interior', notice: 'Riverside Cup: Rats vs Bats, game 1' });
    expect(lines[0]).toBe(`sm_pug_match ${g.matchId} ${g.token} no_mercy "l4d_vs_hospital04_interior"`);
    expect(lines.slice(1, 9)).toEqual([...P.slice(4, 8).map((s) => `sm_pug_roster "${s}:a"`), ...P.slice(0, 4).map((s) => `sm_pug_roster "${s}:b"`)]);
    expect(lines[9]).toBe('l4d_ready_league_notice "Riverside Cup: Rats vs Bats, game 1"');
    expect(gameLinesOf(db, { matchId: g.matchId, stopAfterMap: null, notice: 'x' })[0]).toBe(`sm_pug_match ${g.matchId} ${g.token} no_mercy`);
    expect(() => gameLinesOf(db, { matchId: g.matchId, stopAfterMap: 'bad map;quit', notice: 'x' })).toThrow();
    db.prepare("INSERT INTO match_live (match_id, current_map, last_seen) VALUES (?, 'l4d_vs_hospital01_apartment', datetime('now'))").run(g.matchId);
    expect(isPendingGame(db, g.matchId)).toBe(false);
    expect((db.prepare("SELECT COUNT(*) AS n FROM booking_events WHERE booking_id = ? AND event = 'game_started'").get(r.value.id) as { n: number }).n).toBe(1);
  });
});
```

The `dead_air` slugs and map names must exist in a fresh registry; `l4d_vs_airport04_terminal` is only stored (`next_map` is not validated by `setNext`), so any string works there. If `estimateMinutes` for a fresh db is not 90 (the typical length changed), replace the two `90` constants with `estimateMinutes(db, ['no_mercy'])` and `addCampaignMinutes(db, 'dead_air')`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/tournamentBooking.test.ts`
Expected: FAIL (no such exports).

- [ ] **Step 3: bookings.ts**

- `BookingRow` gains `next_map: string | null;` (after `next_at`); `SideRow` gains `present_now: number;`.
- `setNext`:

```ts
/** The campaign the box loads next and when it is due (both null clears
 *  it). `map` (plan T3b): load this map of the campaign instead of its
 *  first, for a tiebreak chapter. Only on a running booking. */
export function setNext(db: DB, id: number, campaign: string | null, atIso: string | null, now: Date = new Date(), actor: string | null = null, map: string | null = null): boolean {
  return db.transaction(() => {
    const changed = db.prepare(
      "UPDATE bookings SET next_campaign = ?, next_at = ?, next_map = ? WHERE id = ? AND state IN ('ready','active') AND ending_at IS NULL",
    ).run(campaign, atIso, campaign === null ? null : map, id).changes > 0;
    if (changed) logEvent(db, id, actor, 'next_set', { campaign, at: atIso, map: campaign === null ? null : map }, now);
    return changed;
  })();
}
```

- `advancePlaylist`'s UPDATE adds `next_map = NULL`.
- `recordPresence`'s `peak` statement becomes `'UPDATE booking_sides SET peak_present = MAX(peak_present, ?), present_now = ? WHERE booking_id = ? AND side = ?'` run as `peak.run(present.a, present.a, id, 'a')` and the same for b.
- After `createBooking`, add the two writers below. `ok`, `fail`, `logEvent`, `insertPerson`, `iso` (from `./rules.js`), `estimateMinutes`, `addCampaignMinutes`, `campaignRegistry` and `newLeasePassword` are already in the module's scope (module-private helpers and existing imports); nothing new is imported.

```ts
// ---------- tournament bookings (tournaments plan T3b) ----------

export interface TournamentSide { teamId: number | null; captain: string; players: string[]; spectators: string[] }

/** The series engine's booking (T3b Ruling 2): purpose tournament, starts
 *  now, one campaign (later games and tiebreaks are appended), both sides
 *  confirmed, the locked four as players and the rest of each roster as
 *  spectators, all accepted. None of the scrim gates apply: the teams were
 *  let into the event already, and an event night is planned by staff. The
 *  campaign must be known (a stage pool is poolable, not necessarily in the
 *  PUG map pool) and the game config on. */
export function createTournamentBooking(db: DB, o: {
  region: string; campaign: string; rulesJson: string; rulesetId: number | null; gameConfig: string; createdBy: string;
  sides: readonly [TournamentSide, TournamentSide]; now?: Date;
}): Result<{ id: number }> {
  const now = o.now ?? new Date();
  return db.transaction((): Result<{ id: number }> => {
    if (!campaignRegistry(db).get(o.campaign)) return fail('bad_campaign');
    if (!db.prepare('SELECT 1 FROM game_configs WHERE key = ? AND enabled = 1').get(o.gameConfig)) return fail('bad_config');
    const minutes = estimateMinutes(db, [o.campaign]);
    const startMs = now.getTime();
    const id = Number(db.prepare(
      `INSERT INTO bookings (purpose, region, starts_at, ends_at, password, tv_password, game_config, rules_json, ruleset_id, playlist_json, games_allowed, created_by, created_at)
       VALUES ('tournament', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(o.region, iso(startMs), iso(startMs + minutes * 60_000), newLeasePassword(), newLeasePassword(), o.gameConfig, o.rulesJson, o.rulesetId,
      JSON.stringify([o.campaign]), o.createdBy, now.toISOString()).lastInsertRowid);
    const side = db.prepare('INSERT INTO booking_sides (booking_id, side, team_id, captain_steamid, confirmed_at) VALUES (?, ?, ?, ?, ?)');
    (['a', 'b'] as const).forEach((s, i) => {
      const t = o.sides[i];
      side.run(id, s, t.teamId, t.captain, now.toISOString());
      for (const sid of t.players) insertPerson(db, id, s, sid, 'player', 'accepted', o.createdBy, now);
      for (const sid of t.spectators) insertPerson(db, id, s, sid, 'spectator', 'accepted', o.createdBy, now);
    });
    logEvent(db, id, null, 'created', { purpose: 'tournament', campaign: o.campaign, minutes }, now);
    return ok({ id });
  })();
}

/** One more game of the series on the box (T3b Ruling 2): the campaign
 *  joins the playlist, the count and the slot grow (a single chapter counts
 *  as an unnamed campaign's length), and a pending close is cancelled. Only
 *  on an open tournament booking. */
export function appendTournamentGame(db: DB, o: { bookingId: number; campaign: string; map: string | null; now?: Date }): Result<{ gamesAllowed: number; endsAt: string }> {
  const now = o.now ?? new Date();
  return db.transaction((): Result<{ gamesAllowed: number; endsAt: string }> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    if (b.purpose !== 'tournament' || !isOpen(b)) return fail('wrong_state');
    if (!campaignRegistry(db).get(o.campaign)) return fail('bad_campaign');
    const minutes = addCampaignMinutes(db, o.map === null ? o.campaign : null);
    const endsAt = iso(Date.parse(b.ends_at) + minutes * 60_000);
    const gamesAllowed = b.games_allowed + 1;
    const playlist = [...(JSON.parse(b.playlist_json) as string[]), o.campaign];
    db.prepare(
      `UPDATE bookings SET ends_at = ?, games_allowed = ?, playlist_json = ?, extended_minutes = extended_minutes + ?, warned_minutes = NULL, close_at = NULL WHERE id = ?`,
    ).run(endsAt, gamesAllowed, JSON.stringify(playlist), minutes, b.id);
    logEvent(db, b.id, null, 'game_appended', { campaign: o.campaign, map: o.map, gamesAllowed, minutes, endsAt }, now);
    return ok({ gamesAllowed, endsAt });
  })();
}
```

- [ ] **Step 4: Write `src/bookings/tournamentGames.ts`**

```ts
import type { DB } from '../db.js';
import { isMapName } from '../campaigns.js';
import { newToken } from '../matchToken.js';
import { currentSeasonId } from '../players.js';
import { consoleText, quoted } from '../serverSetup.js';
import { getBooking, logBookingEvent, type Side } from './bookings.js';

/**
 * A tournament game's rows and its plugin burst (tournaments plan T3b
 * Rulings 3 and 15). The site starts every tournament game, as the
 * orchestrator starts a queue PUG: a matches row first (so the id exists),
 * then `sm_pug_match <id> <token> <campaign> ["<stop map>"]` and one quoted
 * `sm_pug_roster "<steamid>:<a|b>"` per player. Pug team a starts as
 * survivors on map 1 (plugin Cmd_Match), so the caller puts the team the
 * veto named on team a and says which booking side that is.
 *
 * The row is inserted live with no went_live_at, as an adopted booking game
 * is: the PUG no-show reaper never looks at it, and the orphan reaper
 * applies once the plugin heartbeats. The booking's own rules and game
 * config are copied onto it, as adoption copies them.
 */

export function createTournamentGame(db: DB, o: {
  bookingId: number; serverId: number; campaign: string; teams: { a: string[]; b: string[] }; bookingSideA: Side; now?: Date;
}): { matchId: number; token: string } {
  const now = o.now ?? new Date();
  const b = getBooking(db, o.bookingId);
  if (!b) throw new Error(`booking ${o.bookingId} does not exist`);
  const token = newToken();
  const matchId = db.transaction((): number => {
    const id = Number(db.prepare(
      `INSERT INTO matches (season_id, state, campaign, server_id, token, origin, kind, visibility, rules_json, game_config, booking_id, booking_side_a)
       VALUES (?, 'live', ?, ?, ?, 'queue', 'tournament', 'participants', ?, ?, ?, ?)`,
    ).run(currentSeasonId(db), o.campaign, o.serverId, token, b.rules_json, b.game_config, b.id, o.bookingSideA).lastInsertRowid);
    const ins = db.prepare("INSERT INTO match_players (match_id, player_id, team, source) VALUES (?, ?, ?, 'web')");
    for (const s of o.teams.a) ins.run(id, s, 'a');
    for (const s of o.teams.b) ins.run(id, s, 'b');
    logBookingEvent(db, b.id, null, 'game_started', { matchId: id, campaign: o.campaign }, now);
    return id;
  })();
  return { matchId, token };
}

/** The burst for a game whose rows exist (so a lost burst can be sent again). */
export function gameLinesOf(db: DB, o: { matchId: number; stopAfterMap: string | null; notice: string }): string[] {
  const m = db.prepare('SELECT token, campaign FROM matches WHERE id = ?').get(o.matchId) as { token: string | null; campaign: string } | undefined;
  if (!m || !m.token) throw new Error(`match ${o.matchId} has no token`);
  if (!/^[A-Za-z0-9]+$/.test(m.token)) throw new Error('match token has unexpected characters');
  if (!/^[a-z0-9_]+$/.test(m.campaign)) throw new Error(`campaign ${JSON.stringify(m.campaign)} has unexpected characters`);
  if (o.stopAfterMap !== null && !isMapName(o.stopAfterMap)) throw new Error(`stop map ${JSON.stringify(o.stopAfterMap)} is not a valid map name`);
  const roster = db.prepare('SELECT player_id, team FROM match_players WHERE match_id = ? ORDER BY team, rowid').all(o.matchId) as { player_id: string; team: 'a' | 'b' }[];
  return [
    `sm_pug_match ${o.matchId} ${m.token} ${m.campaign}${o.stopAfterMap ? ` "${o.stopAfterMap}"` : ''}`,
    // Quoted: the console splits an unquoted argument on ':' (orchestrator.ts).
    ...roster.filter((r) => /^\d{17}$/.test(r.player_id)).map((r) => `sm_pug_roster "${r.player_id}:${r.team}"`),
    `l4d_ready_league_notice ${quoted(consoleText(o.notice, 60))}`,
  ];
}

/** Pushed but not yet heard from: live with no heartbeat row. */
export function isPendingGame(db: DB, matchId: number): boolean {
  return !!db.prepare("SELECT 1 FROM matches m WHERE m.id = ? AND m.state = 'live' AND NOT EXISTS (SELECT 1 FROM match_live l WHERE l.match_id = m.id)").get(matchId);
}
```

Check `quoted`'s behaviour on a value with double quotes (`src/serverSetup.ts`); `consoleText` strips what the console cannot take. If `quoted` escapes rather than strips, the test's expected notice line still holds for plain text.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/tournamentBooking.test.ts tests/bookings.test.ts tests/bookingRunner.test.ts`
Expected: PASS (the scrim tests are untouched: `setNext`'s new parameter defaults to null, `present_now` is additive).

- [ ] **Step 6: Commit**

```bash
git add src/bookings/bookings.ts src/bookings/tournamentGames.ts tests/tournamentBooking.test.ts
git commit -m "Tournaments T3b: a tournament booking writer that skips the scrim gates, one more game per series step, a next map for tiebreak chapters, and tournament game rows with their plugin burst"
```

---
### Task 4: The booking runner on a tournament box

**Files:**
- Modify: `src/bookings/runner.ts`
- Test: `tests/bookingRunner.test.ts`

**Interfaces:**
- Consumes: Task 3 (`createTournamentBooking`, `setNext` with a map, `BookingRow.next_map`).
- Produces in `runner.ts`:

```ts
/** The series engine's hand on a tournament booking (tournaments plan T3b). */
export interface TournamentHooks {
  /** The burst that starts the game due on this campaign (sm_pug_match, the
   *  roster, the ready notice, a chat line), pushed before every changelevel
   *  of a tournament booking. May throw: a setup try then fails, and a
   *  between-game load alerts staff. */
  gameLines(bookingId: number, campaign: string): string[];
  /** The burst of a game already pushed that the box has not reported yet
   *  (no heartbeat), re-sent on the minute watch; [] otherwise. */
  pendingLines(bookingId: number): string[];
  ready(bookingId: number): void;
  presence(bookingId: number, on: ReadonlySet<string>, now: Date): void;
  gameEnded(bookingId: number, matchId: number): void;
  ended(bookingId: number, reason: string | null): void;
}
```

  `BookingRunnerDeps.tournament?: TournamentHooks`; `announce(bookingId: number, text: string): void` (one best-effort `say [Match] ...` line). Every hook call but `gameLines` is guarded: a throw is logged and never stops the runner.
- Behaviour on a tournament booking (Rulings 3, 7, 8, 10, 11): `sm_pug_auto_track 0`; the game burst goes before the first `changelevel` of setup and before every `changelevel` of `loadNext`; `loadNext` loads `next_map` when set; no `booking_ready` DM (the engine's replaces it); no immediate no-server alert and no 15 minute serverless cancel; never a `time` end, never an "everyone left" end, no slot warning; `onGameEnded` hands the game to the engine and schedules nothing; `!nextmap`, `!stay`, `!end`, `!extend`, `!addcampaign` are refused in game; the engine hears every wind-down.

- [ ] **Step 1: Write the failing tests**

Append to `tests/bookingRunner.test.ts` (add `createTournamentBooking` and `setNext` to the `bookings.js` import; `sideRow`, `cancelBooking`, `getBooking` and `currentSeasonId` are already imported; `build(over)` takes runner dep overrides, the servers are `a`, `bb` and `ccc` with ids 1 to 3, `box.ccc` is the fake box the runner picks, `sent` records every burst by server name and `dms` every DM):

```ts
describe('tournament bookings (plan T3b)', () => {
  const hooks = () => ({
    gameLines: vi.fn((_id: number, campaign: string) => [`sm_pug_match 1 tok ${campaign}`, 'say [Match] Game 1']),
    pendingLines: vi.fn(() => [] as string[]),
    ready: vi.fn(), presence: vi.fn(), gameEnded: vi.fn(), ended: vi.fn(),
  });
  const bookTournament = () => {
    const r = createTournamentBooking(db, {
      region: 'na', campaign: 'no_mercy', rulesJson: '{}', rulesetId: null, gameConfig: 'standard', createdBy: P[9]!,
      sides: [{ teamId: null, captain: P[0]!, players: P.slice(0, 4), spectators: [P[8]!] }, { teamId: null, captain: P[4]!, players: P.slice(4, 8), spectators: [] }],
      now: new Date(now),
    });
    if (!r.ok) throw new Error(r.error);
    return r.value.id;
  };
  const cmds = () => sent.filter((s) => s.server === 'ccc').flatMap((s) => s.cmds);

  it('sets the box up with auto-track off and the game burst before the first changelevel, and tells the engine instead of DMing the connect line', async () => {
    const h = hooks();
    runner = build({ tournament: h });
    now = START;
    const id = bookTournament();
    runner.allocate();
    await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ state: 'ready', server_id: 3 });
    expect(cmds()).toContain('sm_pug_auto_track 0');
    expect(cmds()).not.toContain('sm_pug_auto_track 1');
    expect(cmds().indexOf('sm_pug_match 1 tok no_mercy')).toBeLessThan(cmds().indexOf('changelevel l4d_vs_hospital01_apartment'));
    expect(h.gameLines).toHaveBeenCalledWith(id, 'no_mercy');
    expect(h.ready).toHaveBeenCalledWith(id);
    expect(dms).toEqual([]);
  });

  it('hands presence and a finished game to the engine, re-pushes a pending burst, never schedules or ends on time itself, and refuses captain commands', async () => {
    const h = hooks();
    h.pendingLines.mockReturnValue(['sm_pug_match 1 tok no_mercy']);
    runner = build({ tournament: h });
    now = START;
    const id = bookTournament();
    runner.allocate();
    await runner.idle();
    box.ccc.humans = [...P.slice(0, 4), ...P.slice(4, 7)];
    sent = [];
    now = START + MIN;
    await runner.tick();
    expect(h.presence).toHaveBeenCalledWith(id, new Set([...P.slice(0, 4), ...P.slice(4, 7)]), new Date(now));
    expect(sideRow(db, id, 'a')!.present_now).toBe(4);
    expect(cmds()).toContain('sm_pug_match 1 tok no_mercy');
    const matchId = Number(db.prepare(
      "INSERT INTO matches (season_id, state, campaign, server_id, token, kind, booking_id, booking_side_a, team_a_score, team_b_score, winner, ended_at) VALUES (?, 'completed', 'no_mercy', 3, 't1', 'tournament', ?, 'a', 500, 400, 'a', datetime('now'))",
    ).run(currentSeasonId(db), id).lastInsertRowid);
    sent = [];
    runner.onGameEnded(matchId);
    expect(h.gameEnded).toHaveBeenCalledWith(id, matchId);
    expect(getBooking(db, id)!.next_campaign).toBeNull();
    expect(cmds().some((c) => c.startsWith('say [Booking]'))).toBe(false);
    now = Date.parse(getBooking(db, id)!.ends_at) + MIN;
    await runner.tick();
    expect(getBooking(db, id)).toMatchObject({ state: 'active', ending_at: null });
    sent = [];
    runner.onCommand(3, P[0]!, 'nextmap', 'dead_air');
    runner.onCommand(3, P[0]!, 'end', '');
    await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ next_campaign: null, ending_at: null });
    expect(cmds().filter((c) => c === 'say [Match] The site runs this tournament match: it picks the campaigns and closes the server.')).toHaveLength(2);
  });

  it('loads a tiebreak chapter straight after the game burst, and tells the engine when the booking ends', async () => {
    const h = hooks();
    runner = build({ tournament: h });
    now = START;
    const id = bookTournament();
    runner.allocate();
    await runner.idle();
    db.prepare("UPDATE bookings SET state = 'active' WHERE id = ?").run(id);
    setNext(db, id, 'no_mercy', new Date(now).toISOString(), new Date(now), null, 'l4d_vs_hospital04_interior');
    sent = [];
    now += MIN;
    await runner.tick();
    await runner.idle();
    expect(cmds().indexOf('sm_pug_match 1 tok no_mercy')).toBeLessThan(cmds().indexOf('changelevel l4d_vs_hospital04_interior'));
    expect(cmds()).not.toContain('changelevel l4d_vs_hospital01_apartment');
    expect(getBooking(db, id)).toMatchObject({ next_campaign: null, next_map: null, playlist_pos: 0 });
    runner.announce(id, 'Series over: Rats beat Bats 2 games to 1.');
    await runner.idle();
    expect(cmds()).toContain('say [Match] Series over: Rats beat Bats 2 games to 1.');
    cancelBooking(db, { bookingId: id, by: P[9]!, staff: true, now: new Date(now) });
    runner.settle(id);
    await runner.idle();
    expect(h.ended).toHaveBeenCalledWith(id, 'staff');
  });
});
```

(`announce` and the command refusal go through the runner's `say`, which is not awaited and not tracked, so `await runner.idle()` does not wait for them; `fakeRcon` records the burst before its first `await`, so the lines are in `sent` by the time the assertion runs. If one is not there yet, `await new Promise((r) => setTimeout(r, 0))` first.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/bookingRunner.test.ts -t "tournament bookings"`
Expected: FAIL (`tournament` is not a dep; `sm_pug_auto_track 1` is pushed).

- [ ] **Step 3: Implement in `src/bookings/runner.ts`**

Add the `TournamentHooks` interface (above `BookingRunnerDeps`) exactly as in Interfaces, and to `BookingRunnerDeps`:

```ts
  /** Tournaments plan T3b: the series engine's hooks on a tournament booking. Absent, tournament bookings behave as scrims. */
  tournament?: TournamentHooks;
```

In `gameLines`, replace `'sm_pug_auto_track 1',` with:

```ts
    // A tournament box adopts nothing: the site starts every game (T3b Ruling 3).
    `sm_pug_auto_track ${b.purpose === 'tournament' ? 0 : 1}`,
```

In `allocate`, guard the late alert: `if (b.purpose !== 'tournament' && nowMs >= Date.parse(b.starts_at) && !this.latePublished.has(b.id)) {`.

In `closeServerless`, first line of the loop body: `if (b.purpose === 'tournament') continue;` (T3b Ruling 8: a tournament booking waits; the series engine alerts).

Add two private helpers (near `push`):

```ts
  /** The series engine's burst for the game due on a tournament booking; nothing for a scrim. May throw (TournamentHooks). */
  private gameLinesFor(b: BookingRow, campaign: string): string[] {
    if (b.purpose !== 'tournament' || !this.deps.tournament) return [];
    return this.deps.tournament.gameLines(b.id, campaign);
  }

  /** A guarded hook call: the engine's failure is logged and never stops the runner. */
  private hook(id: number, what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error(`[booking] ${id}: tournament ${what} hook failed:`, err instanceof Error ? err.message : err);
    }
  }

  /** The chat lines said once a campaign is up: the captains' commands on a
   *  scrim; nothing on a tournament box, whose burst says its own. */
  private startLinesFor(b: BookingRow, campaign: string): string[] {
    return b.purpose === 'tournament' ? [] : this.campaignStartLines(campaign);
  }

  /** One best-effort line on a tournament box (the series engine's). */
  announce(bookingId: number, text: string): void {
    this.say(bookingId, `say [Match] ${consoleText(text, 200)}`, 'the series line');
  }
```

In `setupOnce`, replace the two lines `await this.deps.rcon(server, [...lines, markerLine(b.id)]);` through the `changelevel` try with:

```ts
    // T3b Ruling 3: the game burst goes before the first changelevel, as the
    // orchestrator's queue path sends it; a throw here fails this setup try.
    const game = this.gameLinesFor(b, playlist[0]!);
    await this.deps.rcon(server, [...lines, markerLine(b.id), ...game]);
    try {
      await this.deps.rcon(server, [`changelevel ${firstMap}`]);
    } catch {
      // A changelevel can drop the connection it came in on; the map check decides.
    }
```

and replace `this.tell(id, acceptedPeople(this.db, id).map((p) => p.steamid), 'booking_ready');` with:

```ts
    if (b.purpose === 'tournament') this.hook(id, 'ready', () => this.deps.tournament?.ready(id));
    else this.tell(id, acceptedPeople(this.db, id).map((p) => p.steamid), 'booking_ready');
```

In `watch`:
- replace `if (first && !this.announced.has(b.id)) await this.push(b.id, server, () => this.campaignStartLines(first), 'the campaign start lines');` with `if (first && !this.announced.has(b.id)) await this.push(b.id, server, () => this.startLinesFor(b, first), 'the campaign start lines');`
- right after `recordPresence(this.db, b.id, present, humans.length > 0, now);` add:

```ts
    if (b.purpose === 'tournament') {
      this.hook(b.id, 'presence', () => this.deps.tournament?.presence(b.id, on, now));
      // A burst the box never got goes again until the game heartbeats (T3b Ruling 3).
      let pending: string[] = [];
      this.hook(b.id, 'pendingLines', () => { pending = this.deps.tournament?.pendingLines(b.id) ?? []; });
      if (pending.length > 0) await this.push(b.id, server, () => pending, 'the pending game burst');
    }
```

- change the everyone-left line to `if (b.purpose !== 'tournament' && empties >= EMPTY_WATCHES_TO_END && this.everyoneLeftAfterGame(b.id, nowMs)) { this.endNow(b.id, 'done', now); return; }`
- add `&& fresh.purpose !== 'tournament'` to the slot warning condition.

In `dueEnd`, the time line becomes:

```ts
    // A tournament booking never ends on time: the series engine closes it (T3b Ruling 11).
    if (b.purpose !== 'tournament' && nowMs >= Date.parse(b.ends_at) && (closeMs === null || nowMs >= closeMs)) return 'time';
```

In `onGameEnded`, right after `if (!b) return;`:

```ts
    if (b.purpose === 'tournament') {
      // The series engine records the game and schedules what follows (T3b).
      this.hook(b.id, 'gameEnded', () => this.deps.tournament?.gameEnded(b.id, matchId));
      return;
    }
```

In `loadNext`:
- `const map = b.next_map ?? firstMapOf(this.db, campaign);` (a tiebreak chapter loads straight, T3b Ruling 5)
- before `advancePlaylist(...)`:

```ts
    let game: string[];
    try {
      game = this.gameLinesFor(b, campaign);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      console.error(`[booking] ${id}: the game for ${campaign} could not be started: ${why}`);
      publishAdminEvent({ kind: 'problem', text: `Booking ${id}: the tournament game on ${campaign} could not be started (${why}). Nothing was loaded; look at the match room.` });
      setNext(this.db, id, null, null, new Date(this.now()));
      return;
    }
    if (game.length > 0) await this.push(id, server, () => game, 'the game burst');
```

- in the after-load push replace `...this.campaignStartLines(campaign)` with `...this.startLinesFor(after, campaign)`.

In `recoverOnce`: `const map = resumed ? snap!.map : fresh.next_map ?? firstMapOf(this.db, campaign);` and, where `loadedNext` is computed, add the burst for a game the crash caught before its load:

```ts
    const game = loadedNext ? this.gameLinesFor(fresh, campaign) : [];
    if (game.length > 0) await this.deps.rcon(server, game);
```

(after the `advancePlaylist` call and before the `changelevel`), and replace `this.campaignStartLines(campaign)` there with `this.startLinesFor(fresh, campaign)`.

In `onCommand`, after the `actingSides` check:

```ts
    if (b.purpose === 'tournament' && cmd !== 'allow') {
      // T3b Ruling 10: the series engine picks the campaigns and closes the box.
      this.say(b.id, 'say [Match] The site runs this tournament match: it picks the campaigns and closes the server.', 'the tournament refusal');
      return;
    }
```

In `windDown`, right after `if (!b || b.ended_at !== null) return;`:

```ts
    // T3b Ruling 11: the series engine holds a match whose box goes away mid-series.
    if (b.purpose === 'tournament') this.hook(id, 'ended', () => this.deps.tournament?.ended(id, b.end_reason));
```

`consoleText` is already imported from `../serverSetup.js`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/bookingRunner.test.ts tests/bookingRecovery.test.ts tests/tournamentBooking.test.ts && npm run typecheck`
Expected: PASS. Every scrim test is unchanged: the new branches are all behind `purpose === 'tournament'`.

- [ ] **Step 5: Commit**

```bash
git add src/bookings/runner.ts tests/bookingRunner.test.ts
git commit -m "Tournaments T3b: the booking runner starts each tournament game from the engine's burst with auto-track off, loads tiebreak chapters straight, never ends a tournament on time, and refuses captain commands on it"
```

---
### Task 5: The series engine, part 1 (booking, game bursts, connect, presence, the booking ending) and the two DMs

**Files:**
- Create: `src/events/series.ts`, `tests/seriesFixture.ts`, `tests/series.test.ts`
- Modify: `src/events/messages.ts`, `src/events/notices.ts`, `src/notify/notify.ts`
- Test: `tests/series.test.ts` (new), `tests/notify.test.ts` (or wherever `NOTIFY_TYPES` is pinned)

**Interfaces:**
- Consumes: Tasks 2, 3, 4; T3a `forfeitMatch`, `tellReadyForfeit` (widened below), `RoomClock` (Task 7 wires `series` into it; the fixture passes it already, so make `RoomClock`'s `series?: { tick(now: Date): void; afterPick(matchId: number): void; finalize(matchId: number, now: Date): Promise<void> }` dep exist from this task, unused until Task 7).
- Produces in `series.ts`:
  - `SERVER_ALERT_MS = 10 * 60_000`, `PRESENCE_FALLBACK_MS = 3 * 60_000`
  - `interface SeriesRunner { announce(bookingId: number, text: string): void; settle(bookingId: number): void; onCancelled(bookingId: number, by: string | null, reason: string | null): void }`
  - `interface SeriesDeps { db: DB; runner: SeriesRunner; notifier?: Notifier; publicUrl?: string; push?: (matchId: number) => void; registerToken?: (token: string) => void; now?: () => number }`
  - `class SeriesEngine { constructor(deps: SeriesDeps); hooks(): TournamentHooks; tick(now: Date): void; gameStarted(gameMatchId: number): void; gameLines(bookingId, campaign): string[]; pendingLines(bookingId): string[]; ready(bookingId): void; presence(bookingId, on, now): void; ended(bookingId, reason): void; gameEnded(bookingId, gameMatchId): void (Task 6); continueSeries(matchId): void (Task 6); afterPick(matchId): void (Task 6); finalize(matchId, now): Promise<void> (Task 6); confirm(...), dispute(...), reset(...) (Task 6) }`
  - `lateHooks(get: () => SeriesEngine | null): TournamentHooks` (forwards each hook to the engine once it exists; `server.ts` builds the runner before the engine).
- Produces in `notify.ts`: `event_match_connect`, `event_match_result`; in `messages.ts` the two cases, and `event_match_forfeit` gains `extra.why: 'ready' | 'server'`; in `notices.ts`: `tellConnect(d, eventId, matchId, to: string[])`, `tellSeriesResult(d, eventId, matchId)`, and `tellReadyForfeit(d, eventId, matchId, why: 'ready' | 'server' = 'ready')`.
- Produces in `tests/seriesFixture.ts`: `seriesFixture(o?: { veto?: object; pool?: string[]; drive?: (f: RoomFixture) => void }): Promise<SeriesFixture>` with `{ ...RoomFixture, t: { t: number }, runner, series, clock, sent: string[], box: { map; humans; down }, send: SpyInstance, alerts: AdminEvent[], pushes: number[], tick(), match(), booking(), gameOf(ordinal): GameRow, goLive(gameMatchId, map?), endGame(gameMatchId, maps), close() }` and `MIN = 60_000`; `driveLoserPicks(f)` (the opening of the room test's loser picks case, exported for Task 6).

- [ ] **Step 1: Write the fixture**

Create `tests/seriesFixture.ts`:

```ts
import { vi, type MockInstance } from 'vitest';
import type { DB } from '../src/db.js';
import * as P from '../src/events/play.js';
import * as R from '../src/events/room.js';
import * as B from '../src/bookings/bookings.js';
import { addServer, type ServerRow } from '../src/serverPool.js';
import { BookingRunner } from '../src/bookings/runner.js';
import { Notifier } from '../src/notify/notify.js';
import { SeriesEngine, lateHooks } from '../src/events/series.js';
import { RoomClock } from '../src/events/roomClock.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { NOW } from './eventFixture.js';
import { A, B as BATS } from './entryFixture.js';
import { POOL7, TIMERS, driveToBooking, roomFixture, type RoomFixture } from './roomFixture.js';

/** A room driven to `booking` (both lineups locked), one idle server, a
 *  booking runner on a fake box, the series engine and the room clock, all on
 *  one controllable clock (plan T3b). Ban to one by default: game 1 is
 *  no_mercy and Bats (entry b) start as survivors, so match team a is Bats
 *  and booking_side_a is 'b'. */
export const MIN = 60_000;
export interface SeriesFixture extends RoomFixture {
  t: { t: number }; runner: BookingRunner; series: SeriesEngine; clock: RoomClock;
  sent: string[]; box: { map: string; humans: string[]; down: boolean }; send: MockInstance; alerts: AdminEvent[]; pushes: number[];
  /** The room clock, then the runner's minute pass, then any tracked work. */
  tick(): Promise<void>;
  match(): P.MatchRow; booking(): B.BookingRow; gameOf(ordinal: number): R.GameRow;
  /** The plugin's MATCH_START for a pushed game: the heartbeat row, then the engine. */
  goLive(gameMatchId: number, map?: string): void;
  /** The orchestrator finished a game with these per-map scores (match team a first; half1Surv is who survived first on that map), then the runner's hook. */
  endGame(gameMatchId: number, maps: { map: string; a: number; b: number; half1Surv?: 'a' | 'b' }[]): void;
  close(): void;
}

const steam2 = (sid: string) => { const n = BigInt(sid) - 76561197960265728n; return `STEAM_1:${n % 2n}:${n / 2n}`; };

export async function seriesFixture(o: { veto?: object; pool?: string[]; drive?: (f: RoomFixture) => void } = {}): Promise<SeriesFixture> {
  const f = await roomFixture({ veto: o.veto, pool: o.pool });
  (o.drive ?? driveToBooking)(f);
  const serverId = addServer(f.db, { name: 'box', host: '10.0.0.1', port: 27015, rconPort: 1, rconPassword: 'x' });
  f.db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(serverId);
  const t = { t: NOW.getTime() + 10 * MIN };
  const sent: string[] = [];
  const box = { map: 'l4d_vs_hospital01_apartment', humans: [] as string[], down: false, marker: '', type: 'Rotoblin Pub VS' };
  const status = () => [
    'hostname: test', `map     : ${box.map} at: 0 x, 0 y, 0 z`, `players : ${box.humans.length} humans, 0 bots (31 max)`,
    '# userid name uniqueid connected ping loss state rate adr',
    ...box.humans.map((sid, i) => `#  ${i + 2} ${i + 1} "h${i}" ${steam2(sid)} 01:12 33 0 active 128000 10.0.0.${i}:27005`),
  ].join('\n');
  const rcon = async (_s: ServerRow, cmds: string[]): Promise<string[]> => {
    if (box.down) throw new Error('rcon connect timeout');
    return cmds.map((c) => {
      sent.push(c);
      if (c === 'status') return status();
      if (c === 'l4d_game_type_name') return `"l4d_game_type_name" = "${box.type}" ( def. "" )`;
      if (c === 'l4d_booking_version') return '"l4d_booking_version" = "1.4.0" ( def. "1.0.0" )';
      if (c === 'l4d_booking_id') return `"l4d_booking_id" = "${box.marker}" ( def. "" )`;
      const mk = /^l4d_booking_id "(\d*)"$/.exec(c);
      if (mk) box.marker = mk[1]!;
      if (c === 'exec pug_match') box.type = 'Rotoblin 4v4 PUG';
      const m = /^changelevel (\S+)$/.exec(c);
      if (m) box.map = m[1]!;
      return '';
    });
  };
  const notifier = new Notifier({ db: f.db, dm: () => async () => {} });
  const send = vi.spyOn(notifier, 'send');
  const alerts: AdminEvent[] = [];
  const unsubscribe = subscribeAdminEvents((e) => alerts.push(e));
  const pushes: number[] = [];
  let series: SeriesEngine | null = null;
  const runner = new BookingRunner({
    db: f.db, publicUrl: 'https://x', rcon,
    release: async (id) => { f.db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(id); return true; },
    restart: async () => { box.map = 'l4d_vs_hospital01_apartment'; box.marker = ''; box.type = 'Rotoblin Pub VS'; return true; },
    notifier, preempt: () => {}, sleep: async () => {}, now: () => t.t, tournament: lateHooks(() => series),
  });
  series = new SeriesEngine({ db: f.db, runner, notifier, publicUrl: 'https://x', push: (id) => pushes.push(id), registerToken: () => {}, now: () => t.t });
  const clock = new RoomClock({ db: f.db, notifier, publicUrl: 'https://x', push: (id) => pushes.push(id), now: () => t.t, seed: () => 0, series });
  const db: DB = f.db;
  // The engine's forfeit and automatic result run as untracked promise
  // chains (forfeitMatch, autoResultFlow): a macrotask turn after the
  // runner's work lets them land, and a second idle collects the wind-down
  // a forfeit starts.
  const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await runner.idle(); };
  return {
    ...f, t, runner, series, clock, sent, box, send, alerts, pushes,
    async tick() { await clock.tick(); await runner.tick(); await runner.idle(); await settle(); },
    match: () => P.getMatch(db, f.matchId)!,
    booking: () => B.getBooking(db, P.getMatch(db, f.matchId)!.booking_id!)!,
    gameOf: (ordinal) => R.gamesOf(db, f.matchId).find((g) => g.ordinal === ordinal)!,
    goLive(gameMatchId, map = box.map) {
      db.prepare("INSERT OR REPLACE INTO match_live (match_id, current_map, last_seen) VALUES (?, ?, datetime('now'))").run(gameMatchId, map);
      series!.gameStarted(gameMatchId);
    },
    endGame(gameMatchId, maps) {
      const a = maps.reduce((n, m) => n + m.a, 0);
      const b = maps.reduce((n, m) => n + m.b, 0);
      db.prepare("UPDATE matches SET state = 'completed', team_a_score = ?, team_b_score = ?, winner = ?, ended_at = datetime('now') WHERE id = ?")
        .run(a, b, a > b ? 'a' : b > a ? 'b' : 'draw', gameMatchId);
      const insMap = db.prepare('INSERT INTO match_maps (match_id, ordinal, map, team_a_score, team_b_score) VALUES (?, ?, ?, ?, ?)');
      const insRound = db.prepare("INSERT OR REPLACE INTO match_rounds (match_id, ordinal, half, surv_team, score, ended_at) VALUES (?, ?, ?, ?, ?, datetime('now'))");
      maps.forEach((m, i) => {
        insMap.run(gameMatchId, i, m.map, m.a, m.b);
        const first = m.half1Surv ?? 'a';
        insRound.run(gameMatchId, i, 1, first, first === 'a' ? m.a : m.b);
        insRound.run(gameMatchId, i, 2, first === 'a' ? 'b' : 'a', first === 'a' ? m.b : m.a);
      });
      db.prepare('DELETE FROM match_live WHERE match_id = ?').run(gameMatchId);
      runner.onGameEnded(gameMatchId);
    },
    close: () => { unsubscribe(); },
  };
}

/** The room test's loser picks opening (POOL7, Bo3 ban to three): Rats go
 *  first, four bans, Rats pick POOL7[5] for game 1, Bats survive first, both
 *  lineups locked. Use with seriesFixture({ pool: POOL7, veto: presetConfig('loser_picks', 7), drive: driveLoserPicks }). */
export function driveLoserPicks(f: RoomFixture): void {
  const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
  const ok = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value; };
  ok(R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS, now: NOW }));
  ok(R.readyUp(f.db, { matchId: f.matchId, steamid: A[0]!, timers: TIMERS, now: at(1) }));
  ok(R.readyUp(f.db, { matchId: f.matchId, steamid: BATS[0]!, timers: TIMERS, now: at(1) }));
  const steps: [string, number, string, string | null][] = [
    [A[0]!, 0, 'first', null], [A[0]!, 1, 'ban', POOL7[0]!], [BATS[0]!, 2, 'ban', POOL7[1]!], [A[0]!, 3, 'ban', POOL7[2]!], [BATS[0]!, 4, 'ban', POOL7[3]!],
    [A[0]!, 5, 'pick', POOL7[5]!], [BATS[0]!, 6, 'survivors', null],
  ];
  for (const [who, step, action, campaign] of steps) ok(R.actVeto(f.db, { matchId: f.matchId, steamid: who, step, action, campaign, timers: TIMERS, now: at(2) }));
  ok(R.lockLineup(f.db, { matchId: f.matchId, steamid: A[0]!, steamids: A.slice(0, 4), timers: TIMERS, now: at(4) }));
  ok(R.lockLineup(f.db, { matchId: f.matchId, steamid: BATS[0]!, steamids: BATS.slice(0, 4), timers: TIMERS, now: at(4) }));
}
```

The fixture's clock starts 10 minutes after `NOW` (the room was driven at `NOW` + 4), so every deadline it sets is in the future of `t.t`. `roomFixture` must build the `Standard Cup` stage ruleset (it does: `stageBody` uses `cupId`), whose `noShowGraceMinutes` is 15; if the template differs, read it in the tests with `B.bookingRules(f.booking())!.noShowGraceMinutes` rather than the literal 15.

- [ ] **Step 2: Write the failing tests**

Create `tests/series.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import * as B from '../src/bookings/bookings.js';
import * as R from '../src/events/room.js';
import { SERVER_ALERT_MS, PRESENCE_FALLBACK_MS } from '../src/events/series.js';
import { A, B as BATS } from './entryFixture.js';
import { MIN, seriesFixture, type SeriesFixture } from './seriesFixture.js';

let f: SeriesFixture;
afterEach(() => f?.close());

describe('SeriesEngine: booking, the game burst and connect', () => {
  it('books a server the moment lineups lock, pushes game 1 with the veto\'s sides before the changelevel, and opens connect with a DM', async () => {
    f = await seriesFixture();
    await f.tick();
    const b = f.booking();
    expect(b).toMatchObject({ purpose: 'tournament', state: 'ready', games_allowed: 1, region: 'na' });
    expect(JSON.parse(b.playlist_json)).toEqual(['no_mercy']);
    expect(B.peopleOf(f.db, b.id).map((p) => [p.side, p.steamid, p.role])).toEqual([
      ...A.slice(0, 4).map((s) => ['a', s, 'player']), ['a', A[4], 'spectator'], ...BATS.slice(0, 4).map((s) => ['b', s, 'player']),
    ]);
    const m = f.match();
    expect(m).toMatchObject({ status: 'connect', booking_id: b.id, booked_at: new Date(f.t.t).toISOString() });
    expect(m.deadline).toBe(new Date(f.t.t + B.bookingRules(b)!.noShowGraceMinutes * MIN).toISOString());
    const g1 = f.gameOf(1);
    expect(g1.match_id).not.toBeNull();
    expect(f.db.prepare('SELECT booking_side_a, kind, visibility, state FROM matches WHERE id = ?').get(g1.match_id!)).toEqual({ booking_side_a: 'b', kind: 'tournament', visibility: 'participants', state: 'live' });
    expect(f.sent).toContain('sm_pug_auto_track 0');
    const matchLine = f.sent.find((c) => c.startsWith('sm_pug_match '))!;
    expect(matchLine).toMatch(new RegExp(`^sm_pug_match ${g1.match_id} [A-Za-z0-9]+ no_mercy( "l4d_vs_hospital\\w+")?$`));
    expect(f.sent.indexOf(matchLine)).toBeLessThan(f.sent.indexOf('changelevel l4d_vs_hospital01_apartment'));
    // Bats survive first: their four are pug team a.
    expect(f.sent.filter((c) => c.startsWith('sm_pug_roster '))).toEqual([...BATS.slice(0, 4).map((s) => `sm_pug_roster "${s}:a"`), ...A.slice(0, 4).map((s) => `sm_pug_roster "${s}:b"`)]);
    expect(f.sent.some((c) => c.startsWith('say [Match] Game 1: No Mercy. Bats start as survivors.'))).toBe(true);
    expect(f.send).toHaveBeenCalledWith(expect.arrayContaining([A[0], A[4], BATS[3]]), 'event_match_connect', expect.objectContaining({ content: expect.stringContaining(`password ${b.password}`) }));
    expect(f.send).not.toHaveBeenCalledWith(expect.anything(), 'booking_ready', expect.anything());
    expect(f.pushes).toContain(f.matchId);
  });

  it('waits for a server, alerts staff once after ten minutes, and takes the first box freed', async () => {
    f = await seriesFixture();
    f.db.prepare("UPDATE servers SET status = 'live'").run();
    await f.tick();
    expect(f.match()).toMatchObject({ status: 'booking', server_alerted_at: null });
    expect(f.booking()).toMatchObject({ state: 'scheduled', server_id: null, ending_at: null });
    f.t.t += SERVER_ALERT_MS;
    await f.tick();
    await f.tick();
    expect(f.alerts.filter((a) => a.kind === 'problem' && a.text.includes('waited 10 minutes'))).toHaveLength(1);
    expect(f.match().server_alerted_at).not.toBeNull();
    f.db.prepare("UPDATE servers SET status = 'idle'").run();
    await f.tick();
    expect(f.match().status).toBe('connect');
  });

  it('re-pushes the game burst each minute until the game heartbeats', async () => {
    f = await seriesFixture();
    await f.tick();
    const line = f.sent.find((c) => c.startsWith('sm_pug_match '))!;
    f.sent.length = 0;
    f.t.t += MIN;
    await f.tick();
    expect(f.sent).toContain(line);
    f.goLive(f.gameOf(1).match_id!);
    f.sent.length = 0;
    f.t.t += MIN;
    await f.tick();
    expect(f.sent).not.toContain(line);
  });
});

describe('SeriesEngine: no-show on the server', () => {
  it('forfeits the side with fewer than four locked players on the box when the grace ends, and ends the booking', async () => {
    f = await seriesFixture();
    await f.tick();
    const grace = B.bookingRules(f.booking())!.noShowGraceMinutes;
    f.box.humans = [...A.slice(0, 4), ...BATS.slice(0, 3), A[4]!];
    f.t.t += (grace - 1) * MIN;
    await f.tick();
    expect(f.match().status).toBe('connect');
    f.t.t += 2 * MIN;
    await f.tick();
    expect(f.match()).toMatchObject({ status: 'forfeit', winner_entry: f.entryA, result_source: 'forfeit' });
    expect(f.booking()).toMatchObject({ end_reason: 'no_show' });
    expect(B.sidesOf(f.db, f.booking().id).map((s) => s.no_show_at)).toEqual([null, null]);
    expect(f.send).toHaveBeenCalledWith(expect.arrayContaining([A[0], BATS[0]]), 'event_match_forfeit', expect.objectContaining({ content: expect.stringContaining('four players on the server') }));
  });

  it('holds a match when neither side showed, and a game going live before the deadline ends the question', async () => {
    f = await seriesFixture();
    await f.tick();
    const grace = B.bookingRules(f.booking())!.noShowGraceMinutes;
    f.box.humans = [...A.slice(0, 2), ...BATS.slice(0, 2)];
    f.t.t += (grace + 1) * MIN;
    await f.tick();
    expect(f.match()).toMatchObject({ status: 'admin_hold', hold_reason: 'no_show_both' });
    expect(f.booking().ending_at).toBeNull();
    f.close();
    f = await seriesFixture();
    await f.tick();
    f.box.humans = [...A.slice(0, 4), ...BATS.slice(0, 4)];
    f.goLive(f.gameOf(1).match_id!);
    expect(f.match().status).toBe('live');
    f.t.t += (grace + 1) * MIN;
    await f.tick();
    expect(f.match().status).toBe('live');
  });

  it('holds a connect match whose box cannot be watched for three minutes past the deadline', async () => {
    f = await seriesFixture();
    await f.tick();
    const grace = B.bookingRules(f.booking())!.noShowGraceMinutes;
    f.box.down = true;
    f.t.t += grace * MIN + PRESENCE_FALLBACK_MS - MIN;
    await f.tick();
    expect(f.match().status).toBe('connect');
    f.t.t += 2 * MIN;
    await f.tick();
    expect(f.match()).toMatchObject({ status: 'admin_hold', hold_reason: 'no_presence' });
  });

  it('holds a match whose booking ends mid-series and alerts staff', async () => {
    f = await seriesFixture();
    await f.tick();
    const b = f.booking();
    B.cancelBooking(f.db, { bookingId: b.id, by: '76561199000000700', staff: true, now: new Date(f.t.t) });
    f.runner.onCancelled(b.id, '76561199000000700', null);
    await f.runner.idle();
    expect(f.match()).toMatchObject({ status: 'admin_hold', hold_reason: 'booking_staff' });
    expect(f.alerts.some((a) => a.kind === 'problem' && a.text.includes('server booking ended'))).toBe(true);
  });
});
```

Pin the two new notify types where `NOTIFY_TYPES` is tested.

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run tests/series.test.ts`
Expected: FAIL (no `series.ts`).

- [ ] **Step 4: Notify types, messages and notices**

In `src/notify/notify.ts`, add `| 'event_match_connect' | 'event_match_result'` to `NotifyType` and to `NOTIFY_TYPES`:

```ts
  { type: 'event_match_connect', label: 'My tournament server is ready, with the connect line' },
  { type: 'event_match_result', label: 'A tournament match of mine finished and is in its confirm window' },
```

In `src/events/messages.ts`: add the two types to `EventNotifyType`; add `why?: 'ready' | 'server'` to `extra`; add the imports `import { bookingRules, getBooking } from '../bookings/bookings.js';`, `import { getServer } from '../serverPool.js';`, `import { campaignDisplayName } from '../campaignRegistry.js';`, `import { seriesVerdict } from './seriesRules.js';`, and widen the existing `import { roomTimers } from './room.js';` to `import { gamesOf, roomTimers, seriesGames } from './room.js';`. In the T3a forfeit case, replace the loser sentence with:

```ts
        content = `${a} vs ${b} in ${event} is a forfeit win for ${winner}: ${loser} ${extra.why === 'server' ? 'did not have four players on the server when the grace ended' : 'did not ready up in time'}.`;
```

and add the two cases before the T3a `case 'event_match_room':`:

```ts
    case 'event_match_connect':
    case 'event_match_result': {
      const m = extra.matchId !== undefined ? P.getMatch(db, extra.matchId) : undefined;
      if (!m || m.entry_a === null || m.entry_b === null) return null;
      const a = escapeName(getEntry(db, m.entry_a)?.name ?? 'Team A');
      const b = escapeName(getEntry(db, m.entry_b)?.name ?? 'Team B');
      if (type === 'event_match_connect') {
        const bk = m.booking_id !== null ? getBooking(db, m.booking_id) : undefined;
        const s = bk && bk.server_id !== null ? getServer(db, bk.server_id) : undefined;
        if (!bk || !s) return null;
        const g1 = gamesOf(db, m.id).find((g) => g.ordinal === 1);
        const first = g1?.first_survivors === m.entry_a ? a : g1?.first_survivors === m.entry_b ? b : null;
        const game = g1 ? `Game 1: ${escapeName(campaignDisplayName(db, g1.campaign))}${first ? `, ${first} start as survivors` : ''}. ` : '';
        const grace = bookingRules(bk)?.noShowGraceMinutes ?? 15;
        content = `${a} vs ${b} in ${event}: your server is ready. In the game console:\n\`connect ${s.host}:${s.port}; password ${bk.password}\`\n${game}Both teams must have their four on the server within ${grace} minutes; a team that does not loses by forfeit.`;
      } else {
        const v = seriesVerdict(E.stageSettingsOf(E.getStage(db, m.stage_id)!).veto, seriesGames(db, m));
        if (v.winner === null) return null;
        const winner = v.winner === 'a' ? a : b;
        const loser = v.winner === 'a' ? b : a;
        const line = v.totalScore
          ? `${v.winner === 'a' ? v.totalA : v.totalB} to ${v.winner === 'a' ? v.totalB : v.totalA} on total score`
          : `${v.winner === 'a' ? v.winsA : v.winsB} games to ${v.winner === 'a' ? v.winsB : v.winsA}`;
        content = `${a} vs ${b} in ${event}: ${winner} beat ${loser} ${line}. Captains have ${roomTimers(db).confirmMinutes} minutes to confirm or dispute the result on the match page; otherwise it stands.`;
      }
      return {
        content, embeds: [],
        components: [[{ kind: 'link', url: `${publicUrl}/event/${ev.slug}/match/${m.id}`, label: 'Open the match room' }]],
        mentionUserIds: [],
      };
    }
```

In `src/events/notices.ts`:

```ts
export function tellReadyForfeit(d: NoticeDeps, eventId: number, matchId: number, why: 'ready' | 'server' = 'ready'): void {
  tell(d, rostersOf(d, matchId), eventId, 'event_match_forfeit', { matchId, why });
}
/** The connect line: only the booking's accepted people (the eight and the roster spectators), never a whole roster (T3b Global Constraints). */
export function tellConnect(d: NoticeDeps, eventId: number, matchId: number, to: string[]): void {
  tell(d, to, eventId, 'event_match_connect', { matchId });
}
export function tellSeriesResult(d: NoticeDeps, eventId: number, matchId: number): void {
  tell(d, rostersOf(d, matchId), eventId, 'event_match_result', { matchId });
}
```

- [ ] **Step 5: Write `src/events/series.ts` (part 1)**

```ts
import type { DB } from '../db.js';
import { publishAdminEvent } from '../adminFeed.js';
import { campaignDisplayName, campaignRegistry } from '../campaignRegistry.js';
import type { Notifier } from '../notify/notify.js';
import { getPlayer } from '../players.js';
import { parseRules, rulesForKind, type MatchRules } from '../rulesets.js';
import { stopAfterMap } from '../stopPoint.js';
import { getTeam } from '../teams/teams.js';
import * as B from '../bookings/bookings.js';
import { gamesPlayed } from '../bookings/games.js';
import { SHOWN_MIN } from '../bookings/rules.js';
import { CLOSE_GRACE_MS, NEXT_DELAY_MS, type TournamentHooks } from '../bookings/runner.js';
import { createTournamentGame, gameLinesOf, isPendingGame } from '../bookings/tournamentGames.js';
import * as E from './events.js';
import * as N from './entries.js';
import * as P from './play.js';
import * as R from './room.js';
import * as V from './validate.js';
import { autoResultFlow, forfeitMatch } from './flow.js';
import { tellConnect, tellReadyForfeit, tellSeriesResult } from './notices.js';
import { gameNumberOf, playOrder, seriesResult, seriesVerdict, tiebreakFirstSurvivors } from './seriesRules.js';
import { isHumanStep, other, type Side } from './veto.js';

/**
 * The series engine (tournaments plan T3b): everything between "both
 * lineups are locked" and "the result is recorded". It books the server
 * (Ruling 2), gives the booking runner the burst that starts each game
 * (Ruling 3), opens the connect phase and decides the no-show (Ruling 7),
 * records each game from our capture, adds tiebreaks, opens the loser's
 * pick, runs the confirm window and files disputes (Rulings 5, 9). It never
 * writes an event table itself (room.ts does, one event_log row each) and
 * never touches rcon (the runner does). Every entry point is safe to call
 * twice: the state in the database decides what is left to do.
 */

/** Ten minutes without a box: staff are told once (Ruling 8). */
export const SERVER_ALERT_MS = 10 * 60_000;
/** A connect deadline nobody could watch for this long is held, not guessed (Ruling 7). */
export const PRESENCE_FALLBACK_MS = 3 * 60_000;

export interface SeriesRunner {
  announce(bookingId: number, text: string): void;
  settle(bookingId: number): void;
  onCancelled(bookingId: number, by: string | null, reason: string | null): void;
}
export interface SeriesDeps {
  db: DB; runner: SeriesRunner; notifier?: Notifier; publicUrl?: string;
  push?: (matchId: number) => void; registerToken?: (token: string) => void; now?: () => number;
}

/** The runner is built before the engine (server.ts): each hook finds it when called. */
export function lateHooks(get: () => SeriesEngine | null): TournamentHooks {
  return {
    gameLines: (id, campaign) => get()?.gameLines(id, campaign) ?? [],
    pendingLines: (id) => get()?.pendingLines(id) ?? [],
    ready: (id) => get()?.ready(id),
    presence: (id, on, now) => get()?.presence(id, on, now),
    gameEnded: (id, matchId) => get()?.gameEnded(id, matchId),
    ended: (id, reason) => get()?.ended(id, reason),
  };
}

/** The rules a stage plays by: its snapshot, else its ruleset's tournament reading. */
function stageRules(db: DB, stage: E.StageRow): MatchRules {
  if (stage.rules_json) return parseRules(stage.rules_json);
  const row = db.prepare('SELECT rules_json FROM rulesets WHERE id = ?').get(stage.ruleset_id) as { rules_json: string } | undefined;
  if (!row) throw new Error(`stage ${stage.id}: ruleset ${stage.ruleset_id} is gone`);
  return rulesForKind('tournament', parseRules(row.rules_json));
}

const LIVE_OR_BEFORE: ReadonlySet<P.MatchStatus> = new Set<P.MatchStatus>(['booking', 'connect', 'live']);

export class SeriesEngine {
  private readonly db: DB;
  private readonly now: () => number;
  /** When each tournament booking's box was last watched (the presence hook), for the fallback. */
  private readonly watched = new Map<number, number>();
  private readonly bootMs: number;

  constructor(private readonly deps: SeriesDeps) {
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
    this.bootMs = this.now();
  }

  hooks(): TournamentHooks {
    return lateHooks(() => this);
  }

  private push(matchId: number): void {
    try { this.deps.push?.(matchId); } catch (err) { console.warn('[series] push failed:', err instanceof Error ? err.message : err); }
  }
  private name(m: P.MatchRow, side: Side): string {
    return N.getEntry(this.db, R.entryOn(m, side))?.name ?? (side === 'a' ? 'Team A' : 'Team B');
  }
  private sideOfEntry(m: P.MatchRow, entryId: number | null): Side | null {
    return entryId === null ? null : entryId === m.entry_a ? 'a' : entryId === m.entry_b ? 'b' : null;
  }
  private title(m: P.MatchRow): string {
    const ev = E.getEvent(this.db, m.event_id);
    return `${this.name(m, 'a')} vs ${this.name(m, 'b')} (${ev?.name ?? 'event'})`;
  }
  private roomLink(m: P.MatchRow): { label: string; path: string } {
    const ev = E.getEvent(this.db, m.event_id)!;
    return { label: 'Open the match room', path: `/event/${ev.slug}/match/${m.id}` };
  }
  private alert(m: P.MatchRow, text: string): void {
    publishAdminEvent({ kind: 'problem', text: `Tournament match ${this.title(m)}: ${text}`, link: this.roomLink(m) });
  }

  // ---------- the clock's duties ----------

  /** Every 5 seconds from the room clock: book, alert on a long wait, hold a connect deadline nobody could watch. */
  tick(now: Date): void {
    for (const m of this.db.prepare("SELECT * FROM event_matches WHERE status = 'booking' AND booking_id IS NULL ORDER BY id").all() as P.MatchRow[]) {
      try { this.book(m, now); } catch (err) { console.error(`[series] booking match ${m.id} failed:`, err instanceof Error ? err.message : err); }
    }
    const waiting = this.db.prepare(
      `SELECT m.* FROM event_matches m JOIN bookings b ON b.id = m.booking_id
       WHERE m.status = 'booking' AND m.server_alerted_at IS NULL AND m.booked_at <= ?
         AND b.server_id IS NULL AND b.state = 'scheduled' AND b.ending_at IS NULL`,
    ).all(new Date(now.getTime() - SERVER_ALERT_MS).toISOString()) as P.MatchRow[];
    for (const m of waiting) {
      try {
        if (!R.noteServerAlert(this.db, { matchId: m.id, now }).ok) continue;
        this.alert(m, 'has waited 10 minutes for a server (no idle box in its region can take it). It keeps waiting; free a box, or reset the room or enter the result on the Events desk.');
        this.push(m.id);
      } catch (err) {
        console.error(`[series] server alert for match ${m.id} failed:`, err instanceof Error ? err.message : err);
      }
    }
    const stale = this.db.prepare("SELECT * FROM event_matches WHERE status = 'connect' AND deadline IS NOT NULL AND deadline <= ?")
      .all(new Date(now.getTime() - PRESENCE_FALLBACK_MS).toISOString()) as P.MatchRow[];
    for (const m of stale) {
      const last = m.booking_id !== null ? this.watched.get(m.booking_id) ?? this.bootMs : this.bootMs;
      if (now.getTime() - last < PRESENCE_FALLBACK_MS) continue;
      const r = R.holdMatch(this.db, { matchId: m.id, by: null, reason: 'no_presence', now });
      if (!r.ok) continue;
      this.alert(m, 'the grace to connect ended but the server could not be watched (rcon not answering), so nobody was forfeited. It is on hold.');
      this.push(m.id);
    }
  }

  /** Ruling 2. */
  private book(m: P.MatchRow, now: Date): void {
    const ev = E.getEvent(this.db, m.event_id)!;
    const stage = E.getStage(this.db, m.stage_id)!;
    const s = E.stageSettingsOf(stage);
    const game1 = R.gamesOf(this.db, m.id).find((g) => g.ordinal === 1);
    if (!game1) return;
    const side = (k: Side): B.TournamentSide | null => {
      const entryId = R.entryOn(m, k);
      const entry = N.getEntry(this.db, entryId);
      const team = entry && entry.team_id !== null ? getTeam(this.db, entry.team_id) : undefined;
      const four = R.lineupFour(this.db, m.id, entryId);
      if (!entry || !team || !four) return null;
      const r = N.rosterOf(this.db, entryId);
      const rest = [...r.starters, ...r.subs, ...(r.coach ? [r.coach] : [])].filter((x) => !four.includes(x));
      return { teamId: team.id, captain: team.captain_steamid, players: four, spectators: rest };
    };
    const a = side('a');
    const b = side('b');
    if (!a || !b) {
      console.error(`[series] match ${m.id}: cannot book without both teams and their lineups`);
      return;
    }
    const r = B.createTournamentBooking(this.db, {
      region: ev.region, campaign: game1.campaign, rulesJson: JSON.stringify(stageRules(this.db, stage)), rulesetId: stage.ruleset_id,
      gameConfig: s.gameConfig, createdBy: ev.organizer_steamid, sides: [a, b], now,
    });
    if (!r.ok) {
      this.alert(m, `could not book a server (${r.error}).`);
      return;
    }
    const attached = R.attachBooking(this.db, { matchId: m.id, bookingId: r.value.id, now });
    if (!attached.ok) {
      B.cancelBooking(this.db, { bookingId: r.value.id, by: ev.organizer_steamid, staff: true, reason: 'The match moved on', now });
      this.deps.runner.settle(r.value.id);
      return;
    }
    console.log(`[series] match ${m.id} booked server booking ${r.value.id}`);
    this.push(m.id);
  }

  // ---------- the runner's hooks ----------

  private stopMapFor(stage: E.StageRow, campaign: string): string | null {
    const s = E.stageSettingsOf(stage);
    if (s.chapters === null) return stopAfterMap(this.db, campaign);
    const maps = campaignRegistry(this.db).get(campaign)?.maps ?? [];
    return maps[Math.min(s.chapters, maps.length) - 1] ?? null;
  }
  private gameLabel(m: P.MatchRow, g: R.GameRow): string {
    const games = R.seriesGames(this.db, m);
    const n = gameNumberOf(games.find((x) => x.id === g.id)!, games);
    return g.tiebreak_of !== null ? `tiebreak of game ${n}` : `game ${n}`;
  }
  private linesFor(m: P.MatchRow, g: R.GameRow, gameMatchId: number): string[] {
    const stage = E.getStage(this.db, m.stage_id)!;
    const ev = E.getEvent(this.db, m.event_id)!;
    const stop = g.tiebreak_of !== null ? g.map : this.stopMapFor(stage, g.campaign);
    return gameLinesOf(this.db, { matchId: gameMatchId, stopAfterMap: stop, notice: `${ev.name}: ${this.name(m, 'a')} vs ${this.name(m, 'b')}, ${this.gameLabel(m, g)}` });
  }
  private startText(m: P.MatchRow, g: R.GameRow): string {
    const first = this.sideOfEntry(m, g.first_survivors);
    const label = this.gameLabel(m, g);
    const what = `${label.charAt(0).toUpperCase()}${label.slice(1)}: ${campaignDisplayName(this.db, g.campaign)}${g.tiebreak_of !== null ? ', one chapter' : ''}.`;
    return `${what} ${first ? `${this.name(m, first)} start as survivors. ` : ''}Ready up when both teams are in.`;
  }

  /** Ruling 3: the burst for the game due on this campaign, creating its
   *  rows. Throws when nothing fits, so a setup try fails rather than load a
   *  map with no game behind it. */
  gameLines(bookingId: number, campaign: string): string[] {
    const m = R.matchOfBooking(this.db, bookingId);
    if (!m || !LIVE_OR_BEFORE.has(m.status)) return [];
    const b = B.getBooking(this.db, bookingId);
    if (!b || b.server_id === null) return [];
    const pending = this.pendingLines(bookingId);
    if (pending.length > 0) return pending;
    const rows = R.gamesOf(this.db, m.id);
    const due = playOrder(R.seriesGames(this.db, m)).map((s) => rows.find((g) => g.id === s.id)!).find((g) => g.match_id === null);
    if (!due || due.first_survivors === null) throw new Error(`match ${m.id}: no game is ready to start`);
    if (due.campaign !== campaign) throw new Error(`match ${m.id}: the box is loading ${campaign} but the next game is on ${due.campaign}`);
    const first = this.sideOfEntry(m, due.first_survivors)!;
    const four = (k: Side) => R.lineupFour(this.db, m.id, R.entryOn(m, k)) ?? [];
    const now = new Date(this.now());
    const g = createTournamentGame(this.db, { bookingId, serverId: b.server_id, campaign, teams: { a: four(first), b: four(other(first)) }, bookingSideA: first, now });
    const linked = R.linkGame(this.db, { matchId: m.id, gameId: due.id, gameMatchId: g.matchId, now });
    if (!linked.ok) throw new Error(`match ${m.id}: game ${due.ordinal} could not be linked (${linked.error})`);
    try { this.deps.registerToken?.(g.token); } catch (err) { console.error(`[series] registering the token of game ${g.matchId} failed:`, err); }
    console.log(`[series] match ${m.id}: game ${due.ordinal} is match ${g.matchId} on ${campaign}`);
    this.push(m.id);
    return [...this.linesFor(m, due, g.matchId), `say [Match] ${this.startText(m, due)}`];
  }

  /** A game pushed but not heard from yet: its burst again (no chat line). */
  pendingLines(bookingId: number): string[] {
    const m = R.matchOfBooking(this.db, bookingId);
    if (!m) return [];
    const pending = R.gamesOf(this.db, m.id).find((g) => g.match_id !== null && isPendingGame(this.db, g.match_id));
    return pending ? this.linesFor(m, pending, pending.match_id!) : [];
  }

  /** The box is set up: the grace to connect starts and the connect line goes out (Ruling 7, Ruling 16). */
  ready(bookingId: number): void {
    const m = R.matchOfBooking(this.db, bookingId);
    if (!m || m.status !== 'booking') return;
    const b = B.getBooking(this.db, bookingId);
    if (!b) return;
    const grace = B.bookingRules(b)?.noShowGraceMinutes ?? 15;
    const r = R.startConnect(this.db, { matchId: m.id, graceMinutes: grace, now: new Date(this.now()) });
    if (!r.ok) return;
    tellConnect(this.deps, m.event_id, m.id, B.acceptedPeople(this.db, bookingId).map((p) => p.steamid));
    this.push(m.id);
  }

  /** Who is on the box, each minute (Ruling 7). */
  presence(bookingId: number, on: ReadonlySet<string>, now: Date): void {
    this.watched.set(bookingId, now.getTime());
    const m = R.matchOfBooking(this.db, bookingId);
    if (!m || m.status !== 'connect' || m.deadline === null || now.toISOString() < m.deadline) return;
    const count = (k: Side) => (R.lineupFour(this.db, m.id, R.entryOn(m, k)) ?? []).filter((s) => on.has(s)).length;
    const shownA = count('a') >= SHOWN_MIN;
    const shownB = count('b') >= SHOWN_MIN;
    if (shownA && shownB) return;
    if (!shownA && !shownB) {
      const r = R.holdMatch(this.db, { matchId: m.id, by: null, reason: 'no_show_both', now });
      if (!r.ok) return;
      this.alert(m, `neither team had ${SHOWN_MIN} players on the server when the grace ended (${count('a')} and ${count('b')}). It is on hold; the server stays up.`);
      this.push(m.id);
      return;
    }
    void this.forfeitNoShow(m, shownA ? 'a' : 'b', now);
  }

  private async forfeitNoShow(m: P.MatchRow, winner: Side, now: Date): Promise<void> {
    const r = await forfeitMatch(this.db, {
      eventId: m.event_id, matchId: m.id, winner, now,
      expect: (x) => x.status === 'connect' && x.booking_id === m.booking_id,
    });
    if (!r.ok) return;
    if (m.booking_id !== null && B.closeBooking(this.db, m.booking_id, 'ended', 'no_show', now)) this.deps.runner.settle(m.booking_id);
    tellReadyForfeit(this.deps, m.event_id, m.id, 'server');
    this.alert(m, `${this.name(m, other(winner))} did not have ${SHOWN_MIN} players on the server when the grace ended: forfeit win for ${this.name(m, winner)}.`);
    this.push(m.id);
  }

  /** MATCH_START of a tournament game (server.ts): the first one makes the match live. */
  gameStarted(gameMatchId: number): void {
    const row = this.db.prepare("SELECT booking_id FROM matches WHERE id = ? AND kind = 'tournament'").get(gameMatchId) as { booking_id: number | null } | undefined;
    if (!row || row.booking_id === null) return;
    const m = R.matchOfBooking(this.db, row.booking_id);
    if (!m || m.status !== 'connect') return;
    if (R.startLive(this.db, { matchId: m.id, now: new Date(this.now()) }).ok) this.push(m.id);
  }

  /** The booking is winding down (Ruling 11). */
  ended(bookingId: number, reason: string | null): void {
    const m = R.matchOfBooking(this.db, bookingId);
    if (!m || !LIVE_OR_BEFORE.has(m.status)) return;
    const r = R.holdMatch(this.db, { matchId: m.id, by: null, reason: `booking_${reason ?? 'ended'}`, now: new Date(this.now()) });
    if (!r.ok) return;
    this.alert(m, `its server booking ended (${reason ?? 'ended'}) before the series finished. It is on hold; enter the result or reset the room on the Events desk.`);
    this.push(m.id);
  }

  // Task 6 adds gameEnded, continueSeries, afterPick, finalize, confirm, dispute and reset here.
}
```

In `src/events/roomClock.ts`, add the optional dep now so the fixture compiles (Task 7 uses it):

```ts
  series?: { tick(now: Date): void; afterPick(matchId: number): void; finalize(matchId: number, now: Date): Promise<void> };
```

on the constructor's `deps` type. `V` is imported for Task 6's return types; if the linter complains about an unused import in this task, add it in Task 6 instead.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/series.test.ts tests/notify.test.ts tests/roomClock.test.ts && npm run typecheck`
Expected: PASS. If the "Game 1: No Mercy" chat line differs only in the campaign's display name (`campaignDisplayName` may say "No Mercy" differently in a fresh registry), assert on `startsWith('say [Match] Game 1: ')` and `includes('Bats start as survivors')` instead.

- [ ] **Step 7: Commit**

```bash
git add src/events/series.ts src/events/messages.ts src/events/notices.ts src/notify/notify.ts src/events/roomClock.ts tests/seriesFixture.ts tests/series.test.ts tests/notify.test.ts
git commit -m "Tournaments T3b: the series engine books the server when lineups lock, starts game 1 with the veto's sides, opens connect with a DM, forfeits or holds a no-show on the server, and holds a match whose booking ends"
```

---
### Task 6: The series engine, part 2 (results, tiebreaks, the loser's pick, confirm window, disputes, reset)

**Files:**
- Modify: `src/events/series.ts`
- Test: `tests/series.test.ts`

**Interfaces:**
- Consumes: Task 5; `seriesVerdict`, `seriesResult`, `playOrder`, `tiebreakFirstSurvivors` (Task 1); `R.recordGame`, `addTiebreak`, `openPick`, `startConfirm`, `confirmResult`, `disputeMatch`, `resetRoom` (Task 2); `B.appendTournamentGame`, `setNext`, `setCloseAt`, `cancelBooking` (Task 3 and existing); `gamesPlayed` (`games.ts`).
- Produces on `SeriesEngine`:
  - `gameEnded(bookingId: number, gameMatchId: number): void` (the runner's hook: record the game from the `matches` row, oriented by `booking_side_a`, then `continueSeries`)
  - `continueSeries(matchId: number): void` (idempotent: tiebreak, confirm window, the loser's pick, or the next game)
  - `afterPick(matchId: number): void` (a route or the clock after a veto action on a live match)
  - `finalize(matchId: number, now: Date): Promise<void>` (the automatic result once the deadline passed or both confirmed)
  - `confirm(matchId: number, steamid: string, now?: Date): Promise<V.Checked<P.MatchRow>>`
  - `dispute(matchId: number, steamid: string, reason: unknown, now?: Date): V.Checked<P.MatchRow>` (the alert names the games' match pages)
  - `reset(matchId: number, by: string, now?: Date): V.Checked<P.MatchRow>` (Ruling 14)

- [ ] **Step 1: Write the failing tests**

Append to `tests/series.test.ts` (add `import { presetConfig } from '../src/events/vetoConfig.js';`, `import { POOL7, TIMERS } from './roomFixture.js';`, `import { driveLoserPicks } from './seriesFixture.js';`, `import * as P from '../src/events/play.js';`):

```ts
describe('SeriesEngine: games, picks, tiebreaks and the confirm window', () => {
  it('plays a Bo3 with loser picks: records game 1, opens the loser\'s pick, schedules each game with its sides, and ends in the confirm window', async () => {
    f = await seriesFixture({ pool: POOL7, veto: presetConfig('loser_picks', 7), drive: driveLoserPicks });
    await f.tick();
    const g1 = f.gameOf(1);
    // Bats survive first on game 1: match team a is Bats (entry b).
    expect(f.db.prepare('SELECT booking_side_a FROM matches WHERE id = ?').get(g1.match_id!)).toEqual({ booking_side_a: 'b' });
    f.goLive(g1.match_id!);
    expect(f.match().status).toBe('live');
    // Bats (team a) 400, Rats (team b) 600: Rats win game 1, Bats pick game 2.
    f.endGame(g1.match_id!, [{ map: 'm1', a: 300, b: 200 }, { map: 'm2', a: 100, b: 400 }]);
    expect(f.gameOf(1)).toMatchObject({ score_a: 600, score_b: 400, winner: f.entryA });
    const picking = f.match();
    expect(picking.status).toBe('live');
    expect(picking.deadline).toBe(new Date(f.t.t + 60_000).toISOString());
    expect(R.roomState(f.db, picking).next).toEqual({ kind: 'pick', by: 'b', game: 2 });
    expect(f.sent.some((c) => c.startsWith('say [Match] Bats: pick game 2'))).toBe(true);
    expect(f.booking().next_campaign).toBeNull();
    // Bats pick, Rats choose survivors: game 2 is scheduled a minute out.
    const pick = R.actVeto(f.db, { matchId: f.matchId, steamid: BATS[0]!, step: 7, action: 'pick', campaign: POOL7[4]!, timers: TIMERS, now: new Date(f.t.t) });
    expect(pick.ok).toBe(true);
    f.series.afterPick(f.matchId);
    expect(f.booking().next_campaign).toBeNull();
    const side = R.actVeto(f.db, { matchId: f.matchId, steamid: A[0]!, step: 8, action: 'survivors', campaign: null, timers: TIMERS, now: new Date(f.t.t) });
    expect(side.ok && side.value.deadline).toBeNull();
    f.series.afterPick(f.matchId);
    f.series.afterPick(f.matchId);
    expect(f.booking()).toMatchObject({ next_campaign: POOL7[4], next_map: null, games_allowed: 2 });
    expect(f.sent.filter((c) => c.startsWith('say [Match] Next: game 2')).length).toBe(1);
    f.sent.length = 0;
    f.t.t += MIN;
    await f.tick();
    const g2 = f.gameOf(2);
    expect(g2.match_id).not.toBeNull();
    expect(f.db.prepare('SELECT booking_side_a FROM matches WHERE id = ?').get(g2.match_id!)).toEqual({ booking_side_a: 'a' });
    expect(f.sent.filter((c) => c.startsWith('sm_pug_roster '))).toEqual([...A.slice(0, 4).map((s) => `sm_pug_roster "${s}:a"`), ...BATS.slice(0, 4).map((s) => `sm_pug_roster "${s}:b"`)]);
    expect(f.sent.some((c) => c.startsWith('changelevel '))).toBe(true);
    f.goLive(g2.match_id!);
    // Rats (team a) lose game 2: 1-1, the decider's sides are chosen by Rats (Bats made the last ban).
    f.endGame(g2.match_id!, [{ map: 'm1', a: 100, b: 500 }]);
    expect(R.roomState(f.db, f.match()).next).toEqual({ kind: 'side', by: 'a', game: 3 });
    expect(f.match().deadline).not.toBeNull();
    expect(R.actVeto(f.db, { matchId: f.matchId, steamid: A[0]!, step: 9, action: 'infected', campaign: null, timers: TIMERS, now: new Date(f.t.t) }).ok).toBe(true);
    f.series.afterPick(f.matchId);
    expect(f.booking()).toMatchObject({ next_campaign: POOL7[6], games_allowed: 3 });
    f.t.t += MIN;
    await f.tick();
    const g3 = f.gameOf(3);
    f.goLive(g3.match_id!);
    f.endGame(g3.match_id!, [{ map: 'm1', a: 100, b: 900 }]);
    // Bats survive first on game 3 (Rats chose infected), so team a is Bats: Rats win 2-1.
    const done = f.match();
    expect(done).toMatchObject({ status: 'confirming', deadline: new Date(f.t.t + 15 * MIN).toISOString(), confirm_a_at: null, confirm_b_at: null });
    expect(f.booking().close_at).toBe(new Date(f.t.t + 5 * MIN).toISOString());
    expect(f.sent.some((c) => c.startsWith('say [Match] Series over: Rats beat Bats 2 games to 1'))).toBe(true);
    expect(f.send).toHaveBeenCalledWith(expect.arrayContaining([A[0], BATS[0]]), 'event_match_result', expect.objectContaining({ content: expect.stringContaining('Rats beat Bats 2 games to 1') }));
    f.t.t += 15 * MIN;
    await f.tick();
    expect(f.match()).toMatchObject({ status: 'done', winner_entry: f.entryA, score_a: 2, score_b: 1, result_source: 'auto' });
  });

  it('acts for a team that runs out of time on its pick, from its saved order, and schedules the game', async () => {
    f = await seriesFixture({ pool: POOL7, veto: presetConfig('loser_picks', 7), drive: driveLoserPicks });
    R.savePrefs(f.db, { entryId: f.entryB, by: BATS[0]!, staff: false, prefs: { defaultFour: null, side: null, campaigns: { [String(f.stageId)]: [POOL7[6]!] } }, now: new Date(f.t.t) });
    await f.tick();
    const g1 = f.gameOf(1);
    f.goLive(g1.match_id!);
    f.endGame(g1.match_id!, [{ map: 'm1', a: 100, b: 500 }]);
    f.t.t += MIN;
    await f.tick();
    expect(f.gameOf(2)).toMatchObject({ campaign: POOL7[6], picked_by: f.entryB });
    f.t.t += MIN;
    await f.tick();
    // Rats did not pick, so Rats choose sides; with no saved side the clock takes survivors first.
    expect(f.gameOf(2).first_survivors).toBe(f.entryA);
    expect(f.booking()).toMatchObject({ next_campaign: POOL7[6], games_allowed: 2 });
    const rows = f.db.prepare('SELECT action, campaign, auto FROM event_vetoes ORDER BY step').all().slice(-2);
    expect(rows).toEqual([{ action: 'pick', campaign: POOL7[6], auto: 1 }, { action: 'survivors', campaign: null, auto: 1 }]);
  });

  it('replays the last chapter as a tiebreak when a game ties, with the team that survived second starting as survivors', async () => {
    f = await seriesFixture();
    await f.tick();
    const g1 = f.gameOf(1);
    f.goLive(g1.match_id!);
    // Team a is Bats. On the last map Rats (team b) survived first, so Bats survive first in the tiebreak.
    f.endGame(g1.match_id!, [{ map: 'l4d_vs_hospital01_apartment', a: 100, b: 100, half1Surv: 'a' }, { map: 'l4d_vs_hospital02_subway', a: 200, b: 200, half1Surv: 'b' }]);
    const tb = R.gamesOf(f.db, f.matchId).find((g) => g.tiebreak_of === g1.id)!;
    expect(tb).toMatchObject({ ordinal: 11, campaign: 'no_mercy', map: 'l4d_vs_hospital02_subway', first_survivors: f.entryB, match_id: null });
    expect(f.booking()).toMatchObject({ next_campaign: 'no_mercy', next_map: 'l4d_vs_hospital02_subway', games_allowed: 2 });
    expect(f.sent.some((c) => c.startsWith('say [Match] Game 1 is tied 300 to 300'))).toBe(true);
    f.sent.length = 0;
    f.t.t += MIN;
    await f.tick();
    const started = f.gameOf(11);
    expect(started.match_id).not.toBeNull();
    const line = f.sent.find((c) => c.startsWith('sm_pug_match '))!;
    expect(line).toBe(`sm_pug_match ${started.match_id} ${f.db.prepare('SELECT token FROM matches WHERE id = ?').pluck().get(started.match_id!)} no_mercy "l4d_vs_hospital02_subway"`);
    expect(f.sent.indexOf(line)).toBeLessThan(f.sent.indexOf('changelevel l4d_vs_hospital02_subway'));
    expect(f.sent.filter((c) => c.startsWith('sm_pug_roster '))).toEqual([...BATS.slice(0, 4).map((s) => `sm_pug_roster "${s}:a"`), ...A.slice(0, 4).map((s) => `sm_pug_roster "${s}:b"`)]);
    f.goLive(started.match_id!);
    f.endGame(started.match_id!, [{ map: 'l4d_vs_hospital02_subway', a: 50, b: 20 }]);
    expect(f.gameOf(11)).toMatchObject({ score_a: 20, score_b: 50, winner: f.entryB });
    expect(f.match().status).toBe('confirming');
    // Both captains confirm: done at once.
    expect((await f.series.confirm(f.matchId, A[1]!, new Date(f.t.t))).ok).toBe(true);
    expect(f.match().status).toBe('confirming');
    expect((await f.series.confirm(f.matchId, BATS[0]!, new Date(f.t.t))).ok).toBe(true);
    expect(f.match()).toMatchObject({ status: 'done', winner_entry: f.entryB, score_a: 0, score_b: 1, result_source: 'auto' });
  });

  it('takes a game ending twice once, refuses a dispute after the deadline, files one before it, and shrugs off a booking end after the series', async () => {
    f = await seriesFixture();
    await f.tick();
    const g1 = f.gameOf(1);
    f.goLive(g1.match_id!);
    f.endGame(g1.match_id!, [{ map: 'm1', a: 100, b: 300 }]);
    f.runner.onGameEnded(g1.match_id!);
    f.series.gameEnded(f.booking().id, g1.match_id!);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE action = 'game_recorded'").pluck().get()).toBe(1);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE action = 'match_confirming'").pluck().get()).toBe(1);
    expect(f.match().status).toBe('confirming');
    const b = f.booking();
    B.closeBooking(f.db, b.id, 'ended', 'idle', new Date(f.t.t));
    f.runner.settle(b.id);
    await f.runner.idle();
    expect(f.match().status).toBe('confirming');
    expect(f.series.dispute(f.matchId, BATS[0]!, 'Rats had five on map 2', new Date(f.t.t + 16 * MIN))).toEqual({ ok: false, error: 'room_closed' });
    const d = f.series.dispute(f.matchId, BATS[0]!, 'Rats had five on map 2', new Date(f.t.t));
    expect(d.ok && d.value).toMatchObject({ status: 'admin_hold', hold_reason: 'dispute', dispute_side: 'b' });
    const alert = f.alerts.find((a) => a.kind === 'problem' && a.text.includes('DISPUTED'))!;
    expect(alert.text).toContain('Rats had five on map 2');
    expect(alert.text).toContain(`/match/${g1.match_id}`);
    expect(alert.kind === 'problem' && alert.link?.path).toBe(`/event/${f.slug}/match/${f.matchId}`);
    f.t.t += 20 * MIN;
    await f.tick();
    expect(f.match().status).toBe('admin_hold');
  });

  it('resets a booked room by cancelling the booking first, without holding the match', async () => {
    f = await seriesFixture();
    await f.tick();
    const b = f.booking();
    const r = f.series.reset(f.matchId, '76561199000000700', new Date(f.t.t));
    expect(r.ok && r.value).toMatchObject({ status: 'waiting', booking_id: null });
    await f.runner.idle();
    expect(B.getBooking(f.db, b.id)).toMatchObject({ state: 'cancelled', end_reason: 'staff' });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE action = 'match_held'").pluck().get()).toBe(0);
    expect(f.db.prepare("SELECT state FROM matches WHERE booking_id = ?").pluck().get(b.id)).toBe('aborted');
  });
});
```

In the first test the step numbers continue the opening's seven actions (0 to 6): the pick is step 7, its side step 8, the decider's side step 9. `TIMERS.stepSeconds` is 60, so the pick deadline is one minute out. In the tiebreak test, half 1 of map 2 is `b` (match team b, Rats), so the team that survived second is match team a, Bats: `first_survivors` is `entryB`, their four are pug team a, and Bats' 50 to 20 is recorded as `score_a` 20 (Rats), `score_b` 50 (Bats).

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/series.test.ts`
Expected: FAIL (`gameEnded` is not a function).

- [ ] **Step 3: Add part 2 to `src/events/series.ts`**

Replace the `// Task 6 adds ...` comment with:

```ts
  // ---------- results, tiebreaks, picks, the confirm window ----------

  /** The runner's hook: a tournament game finished (completeMatch wrote the row). */
  gameEnded(bookingId: number, gameMatchId: number): void {
    const m = R.matchOfBooking(this.db, bookingId);
    if (!m) return;
    const now = new Date(this.now());
    // A lost MATCH_START: the result proves the game was played.
    if (m.status === 'connect') R.startLive(this.db, { matchId: m.id, now });
    const fresh = P.getMatch(this.db, m.id)!;
    if (fresh.status !== 'live') return;
    const game = R.gamesOf(this.db, m.id).find((g) => g.match_id === gameMatchId);
    if (!game) return;
    const row = this.db.prepare('SELECT state, team_a_score, team_b_score, winner, booking_side_a FROM matches WHERE id = ?').get(gameMatchId) as
      { state: string; team_a_score: number; team_b_score: number; winner: 'a' | 'b' | 'draw' | null; booking_side_a: Side | null } | undefined;
    if (!row || row.state !== 'completed') return;
    // Booking side a is entry_a; match team a is booking side booking_side_a.
    const flip = row.booking_side_a === 'b';
    const scoreA = flip ? row.team_b_score : row.team_a_score;
    const scoreB = flip ? row.team_a_score : row.team_b_score;
    const winner: Side | null = row.winner === null || row.winner === 'draw' ? null : (row.winner === 'a') !== flip ? 'a' : 'b';
    const rec = R.recordGame(this.db, { matchId: m.id, gameId: game.id, scoreA, scoreB, winner, now });
    if (!rec.ok) return;
    console.log(`[series] match ${m.id}: game ${game.ordinal} recorded ${scoreA} to ${scoreB}`);
    this.continueSeries(m.id);
  }

  /** The last chapter a game played and who survives first when it is
   *  replayed (Ruling 5): the team that was survivors second on it. Without
   *  a half-1 row for that map (an unreliable capture) the game's own first
   *  survivors are taken as that map's. */
  private lastChapter(m: P.MatchRow, g: R.GameRow): { map: string; firstSurvivors: Side } | null {
    if (g.match_id === null) return null;
    const last = this.db.prepare('SELECT ordinal, map FROM match_maps WHERE match_id = ? ORDER BY ordinal DESC LIMIT 1').get(g.match_id) as { ordinal: number; map: string } | undefined;
    if (!last) return null;
    const half1 = this.db.prepare('SELECT surv_team FROM match_rounds WHERE match_id = ? AND ordinal = ? AND half = 1').get(g.match_id, last.ordinal) as { surv_team: 'a' | 'b' } | undefined;
    const sideA = (this.db.prepare('SELECT booking_side_a FROM matches WHERE id = ?').get(g.match_id) as { booking_side_a: Side | null }).booking_side_a ?? 'a';
    const toEntry = (team: 'a' | 'b'): Side => ((team === 'a') === (sideA === 'a') ? 'a' : 'b');
    const half1Entry: Side = half1 ? toEntry(half1.surv_team) : this.sideOfEntry(m, g.first_survivors) ?? 'a';
    return { map: last.map, firstSurvivors: tiebreakFirstSurvivors(half1Entry) };
  }

  private scoreline(m: P.MatchRow, v: ReturnType<typeof seriesVerdict>): string {
    const w = v.winner!;
    const l = other(w);
    const line = v.totalScore
      ? `${w === 'a' ? v.totalA : v.totalB} to ${w === 'a' ? v.totalB : v.totalA} on total score`
      : `${w === 'a' ? v.winsA : v.winsB} games to ${w === 'a' ? v.winsB : v.winsA}`;
    return `${this.name(m, w)} beat ${this.name(m, l)} ${line}`;
  }

  /** After a recorded game or a settled pick: a tiebreak, the confirm window,
   *  the loser's pick, or the next game. Idempotent: whatever is already in
   *  place is left alone. */
  continueSeries(matchId: number): void {
    const now = new Date(this.now());
    const m = P.getMatch(this.db, matchId);
    if (!m || m.status !== 'live' || m.booking_id === null) return;
    const b = B.getBooking(this.db, m.booking_id);
    if (!b || !B.isOpen(b)) return;
    const timers = R.roomTimers(this.db);
    const s = E.stageSettingsOf(E.getStage(this.db, m.stage_id)!);
    const rows = R.gamesOf(this.db, m.id);
    const series = R.seriesGames(this.db, m);
    const v = seriesVerdict(s.veto, series);

    if (v.tiebreakOf) {
      const parent = rows.find((g) => g.id === v.tiebreakOf!.id)!;
      if (rows.some((g) => g.tiebreak_of === parent.id && g.match_id === null)) return;
      const played = playOrder(series).map((x) => rows.find((g) => g.id === x.id)!)
        .filter((g) => (g.id === parent.id || g.tiebreak_of === parent.id) && g.match_id !== null).at(-1)!;
      const chapter = this.lastChapter(m, played);
      if (!chapter) {
        if (R.holdMatch(this.db, { matchId: m.id, by: null, reason: 'tiebreak_unknown', now }).ok) {
          this.alert(m, `game ${parent.ordinal} tied but the site has no record of its last chapter, so no tiebreak could be set. It is on hold.`);
          this.push(m.id);
        }
        return;
      }
      const tb = R.addTiebreak(this.db, { matchId: m.id, ofGameId: parent.id, map: chapter.map, firstSurvivors: chapter.firstSurvivors, now });
      if (!tb.ok) return;
      B.appendTournamentGame(this.db, { bookingId: b.id, campaign: parent.campaign, map: chapter.map, now });
      B.setNext(this.db, b.id, parent.campaign, new Date(now.getTime() + NEXT_DELAY_MS).toISOString(), now, null, chapter.map);
      this.deps.runner.announce(b.id, `Game ${parent.ordinal} is tied ${played.score_a} to ${played.score_b}: its last chapter is replayed as a tiebreaker in about a minute. ${this.name(m, chapter.firstSurvivors)} start as survivors.`);
      this.push(m.id);
      return;
    }

    if (v.over) {
      if (!R.startConfirm(this.db, { matchId: m.id, timers, now }).ok) return;
      // The box closes after the usual grace (the idle end covers a refused close).
      B.setCloseAt(this.db, b.id, gamesPlayed(this.db, b.id), new Date(now.getTime() + CLOSE_GRACE_MS).toISOString(), now);
      this.deps.runner.announce(b.id, `Series over: ${this.scoreline(m, v)}. Captains confirm or dispute on the site within ${timers.confirmMinutes} minutes. The server closes in 5 minutes.`);
      tellSeriesResult(this.deps, m.event_id, m.id);
      this.push(m.id);
      return;
    }

    const st = R.roomState(this.db, m);
    if (isHumanStep(st.next)) {
      if (m.deadline !== null) return;
      if (!R.openPick(this.db, { matchId: m.id, timers, now }).ok) return;
      const what = st.next.kind === 'pick' ? `pick game ${st.next.game}` : st.next.kind === 'side' ? `choose sides for game ${st.next.game}` : 'choose';
      this.deps.runner.announce(b.id, `${this.name(m, st.next.by)}: ${what} on the site within ${timers.stepSeconds} seconds, or your saved order decides.`);
      this.push(m.id);
      return;
    }
    if (st.next.kind === 'wait') return;
    const next = v.nextGame === null ? undefined : rows.find((g) => g.tiebreak_of === null && g.ordinal === v.nextGame && g.match_id === null);
    if (!next || next.first_survivors === null || b.next_campaign !== null) return;
    B.appendTournamentGame(this.db, { bookingId: b.id, campaign: next.campaign, map: null, now });
    B.setNext(this.db, b.id, next.campaign, new Date(now.getTime() + NEXT_DELAY_MS).toISOString(), now);
    const first = this.sideOfEntry(m, next.first_survivors)!;
    this.deps.runner.announce(b.id, `Next: game ${next.ordinal}, ${campaignDisplayName(this.db, next.campaign)}, in about a minute. ${this.name(m, first)} start as survivors.`);
    this.push(m.id);
  }

  /** A pick or side choice landed on a live match (a route or the clock). */
  afterPick(matchId: number): void {
    const m = P.getMatch(this.db, matchId);
    if (!m || m.status !== 'live') return;
    if (isHumanStep(R.roomState(this.db, m).next)) return;
    this.continueSeries(matchId);
  }

  /** Ruling 9: the automatic result, once the window passed or both confirmed. */
  async finalize(matchId: number, now: Date): Promise<void> {
    const m = P.getMatch(this.db, matchId);
    if (!m || m.status !== 'confirming') return;
    const due = (m.deadline !== null && m.deadline <= now.toISOString()) || (m.confirm_a_at !== null && m.confirm_b_at !== null);
    if (!due) return;
    const s = E.stageSettingsOf(E.getStage(this.db, m.stage_id)!);
    const result = seriesResult(seriesVerdict(s.veto, R.seriesGames(this.db, m)));
    if (!result) {
      if (R.holdMatch(this.db, { matchId: m.id, by: null, reason: 'no_result', now }).ok) this.alert(m, 'its confirm window ended but the games do not add up to a result. It is on hold.');
      this.push(m.id);
      return;
    }
    const r = await autoResultFlow(this.db, { eventId: m.event_id, matchId: m.id, result, expect: (x) => x.status === 'confirming', now });
    if (r.ok) console.log(`[series] match ${m.id}: result recorded (${result.scoreA} to ${result.scoreB})`);
    this.push(m.id);
  }

  async confirm(matchId: number, steamid: string, now = new Date(this.now())): Promise<V.Checked<P.MatchRow>> {
    const r = R.confirmResult(this.db, { matchId, steamid, now });
    if (!r.ok) return r;
    this.push(matchId);
    await this.finalize(matchId, now);
    return r;
  }

  dispute(matchId: number, steamid: string, reason: unknown, now = new Date(this.now())): V.Checked<P.MatchRow> {
    const r = R.disputeMatch(this.db, { matchId, steamid, reason, now });
    if (!r.ok) return r;
    const m = r.value;
    const who = getPlayer(this.db, steamid)?.name ?? steamid;
    const pages = R.gamesOf(this.db, m.id).filter((g) => g.match_id !== null).map((g) => `/match/${g.match_id}`).join(', ');
    publishAdminEvent({
      kind: 'problem',
      text: `Tournament match ${this.title(m)} is DISPUTED by ${who} for ${this.name(m, m.dispute_side!)}: "${m.dispute_reason}". It is on hold. The games (replays and demos): ${pages || 'none'}. Enter the result or reset the room on the Events desk.`,
      link: this.roomLink(m),
    });
    this.push(matchId);
    return r;
  }

  /** Ruling 14: the booking is cancelled before the room resets, so no box is orphaned and no hold is raised. */
  reset(matchId: number, by: string, now = new Date(this.now())): V.Checked<P.MatchRow> {
    const m = P.getMatch(this.db, matchId);
    if (!m) return V.fail('match_not_found');
    let cancelled: number | null = null;
    if (m.booking_id !== null) {
      const b = B.getBooking(this.db, m.booking_id);
      if (b && B.isOpen(b)) {
        const c = B.cancelBooking(this.db, { bookingId: b.id, by, staff: true, reason: 'The match room was reset', now });
        if (!c.ok) return V.fail('booking_open');
        cancelled = b.id;
      }
    }
    const r = R.resetRoom(this.db, { matchId, by, now });
    // The wind-down runs after the reset, so its ended hook finds a waiting match and does nothing.
    if (cancelled !== null) this.deps.runner.onCancelled(cancelled, by, 'The match room was reset');
    if (r.ok) this.push(matchId);
    return r;
  }
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/series.test.ts tests/seriesRules.test.ts tests/room.test.ts && npm run typecheck`
Expected: PASS. If the decider side step's chooser in the first test comes out as `b`, re-read T3a Ruling 6: the decider's sides are chosen by the team that did not make the last opening ban (Bats banned last, so Rats choose); the T3a engine test "1-1: game 3 is the decider; b made the last ban, so a chooses sides" pins it.

- [ ] **Step 5: Commit**

```bash
git add src/events/series.ts tests/series.test.ts
git commit -m "Tournaments T3b: the series engine records each game from our capture, replays a tied chapter as a tiebreak, opens the loser's pick, schedules every game with its sides, runs the confirm window with early confirms and disputes, and resets a booked room safely"
```

---
### Task 7: The room clock ticks the series, and the server wires it

**Files:**
- Modify: `src/events/roomClock.ts`, `src/server.ts`
- Test: `tests/roomClock.test.ts`

**Interfaces:**
- Consumes: `SeriesEngine` (Tasks 5, 6), `lateHooks`; T3a `RoomClock`.
- Produces in `roomClock.ts`: the `series` dep (declared in Task 5) is used: `tick` calls `series.tick(now)` between opening rooms and expiring deadlines; `expire` also takes `live` (a pick step: the auto action, then `series.afterPick`) and `confirming` (`series.finalize`); `resume` also resumes `live` and `confirming`.
- Produces in `server.ts`: one `SeriesEngine`, built after the booking runner (which gets `tournament: lateHooks(() => seriesRef)`) and before the room clock; `match_start` calls `gameStarted`; `eventRoutes` and `adminEventRoutes` receive `series`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/roomClock.test.ts` (imports: `seriesFixture`, `driveLoserPicks`, `MIN`, `type SeriesFixture` from `./seriesFixture.js`; `POOL7` from `./roomFixture.js`; `presetConfig` from `../src/events/vetoConfig.js`; `* as R`):

```ts
describe('RoomClock with the series (plan T3b)', () => {
  let f: SeriesFixture;
  afterEach(() => f?.close());

  it('resumes an overdue pick step with its full length, leaves a connect deadline alone, and acts on the pick when it passes', async () => {
    f = await seriesFixture({ pool: POOL7, veto: presetConfig('loser_picks', 7), drive: driveLoserPicks });
    await f.tick();
    const connectDeadline = f.match().deadline;
    f.t.t += 60 * MIN;
    f.clock.resume();
    expect(f.match().deadline).toBe(connectDeadline);
    const g1 = f.gameOf(1);
    f.goLive(g1.match_id!);
    f.endGame(g1.match_id!, [{ map: 'm1', a: 100, b: 500 }]);
    expect(R.roomState(f.db, f.match()).next).toEqual({ kind: 'pick', by: 'b', game: 2 });
    f.t.t += 10 * MIN;
    f.clock.resume();
    expect(f.match().deadline).toBe(new Date(f.t.t + 60_000).toISOString());
    await f.clock.tick();
    expect(R.roomState(f.db, f.match()).next).toEqual({ kind: 'pick', by: 'b', game: 2 });
    f.t.t += MIN;
    await f.clock.tick();
    expect(f.gameOf(2)).toMatchObject({ picked_by: f.entryB });
    expect(f.db.prepare('SELECT auto FROM event_vetoes ORDER BY step DESC LIMIT 1').pluck().get()).toBe(1);
  });

  it('resumes an overdue confirm window, then records the result when it passes', async () => {
    f = await seriesFixture();
    await f.tick();
    const g1 = f.gameOf(1);
    f.goLive(g1.match_id!);
    f.endGame(g1.match_id!, [{ map: 'm1', a: 100, b: 500 }]);
    expect(f.match().status).toBe('confirming');
    f.t.t += 40 * MIN;
    f.clock.resume();
    expect(f.match().deadline).toBe(new Date(f.t.t + 15 * MIN).toISOString());
    await f.clock.tick();
    expect(f.match().status).toBe('confirming');
    f.t.t += 15 * MIN;
    await f.clock.tick();
    expect(f.match()).toMatchObject({ status: 'done', result_source: 'auto', winner_entry: f.entryA });
  });
});
```

(Bats are match team a in the default fixture, so 100 to 500 is a Rats win: `winner_entry` is `entryA`.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/roomClock.test.ts -t "with the series"`
Expected: FAIL (the clock neither resumes nor expires `live` and `confirming`).

- [ ] **Step 3: roomClock.ts**

- In `tick`, between `this.openDue(now);` and `await this.expire(now);` add:

```ts
      // Tournaments plan T3b: bookings, the server wait alert, the presence fallback.
      try { this.deps.series?.tick(now); } catch (err) { console.error('[rooms] series tick failed:', err instanceof Error ? err.message : err); }
```

- In `resume`, the query's statuses become `('veto','lineup','live','confirming')`.
- In `expire`, the query's statuses become `('veto','lineup','live','confirming')`.
- In `expireOne`, the re-read guard `if (!m || (m.status !== 'veto' && m.status !== 'lineup') || m.deadline === null || m.deadline > now.toISOString()) return;` becomes `const ACTING = new Set<P.MatchStatus>(['veto', 'lineup', 'live', 'confirming'])` (module level) and `if (!m || !ACTING.has(m.status) || m.deadline === null || m.deadline > now.toISOString()) return;`. Then, before the T3a ready-check branch add:

```ts
    if (m.status === 'confirming') {
      // T3b Ruling 9: the window passed with no dispute.
      await this.deps.series?.finalize(m.id, now);
      this.pushChange(m.id);
      return;
    }
```

  and change the veto auto-action branch's guard from `if (m.status === 'veto') {` to `if (m.status === 'veto' || m.status === 'live') {`, adding after `R.actVeto(...)` (the push there is already `this.pushChange(m.id)`):

```ts
      // T3b Ruling 4: a timed-out between-game pick; once nothing human is left the game is scheduled.
      if (m.status === 'live') this.deps.series?.afterPick(m.id);
```

- [ ] **Step 4: server.ts**

- Imports: `import { SeriesEngine, lateHooks } from './events/series.js';`.
- Next to `let bookingRunnerRef: BookingRunner | null = null;` (about line 814, well above the log listener callback that uses it, as `bookingRunnerRef` is): `let seriesRef: SeriesEngine | null = null;`. In the `BookingRunner` deps: `tournament: lateHooks(() => seriesRef),` with the comment `// Tournaments plan T3b: the series engine starts each tournament game.`
- Move the T3a push logic (today an inline `push: (matchId) => { ... }` in the `RoomClock` construction) into a named function above the runner so the engine and the clock share it:

```ts
  // Tournaments plan T3a Ruling 17: a room change goes to its two rosters and staff.
  const pushRoom = (matchId: number): void => {
    const m = getEventMatch(deps.db, matchId);
    if (m) hub.sendTo('event_room', (id) => isActiveStaff(deps.db, id) || isRoomParticipant(deps.db, m, id));
  };
```

- After `bookingRunner.resume();`:

```ts
  // Tournaments plan T3b: the series engine books, starts and scores tournament games on the booking runner.
  const series = new SeriesEngine({
    db: deps.db, runner: bookingRunner, notifier, publicUrl: deps.config.publicUrl, push: pushRoom,
    registerToken: (token) => logListener?.register(token),
  });
  seriesRef = series;
```

- The `RoomClock` construction (T3a) takes `push: pushRoom, series`.
- `adminEventRoutes` and `eventRoutes` options gain `series`.
- In the `match_start` block, inside `if (started) {` after `refreshSignals(...)`: `seriesRef?.gameStarted(started.id);` with the comment `// T3b: the first game of a tournament match going live makes the match live.`

If `logListener` is declared after the runner, use the same forward reference pattern `unregisterToken` already uses.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/roomClock.test.ts tests/series.test.ts tests/eventRunner.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/events/roomClock.ts src/server.ts tests/roomClock.test.ts
git commit -m "Tournaments T3b: the room clock ticks the series engine, acts on timed-out picks and confirm windows and resumes them, and the server wires the engine to the booking runner, the log feed and the routes"
```

---
### Task 8: Room view and routes for the server, the series, confirm and dispute

**Files:**
- Modify: `src/events/roomViews.ts`, `src/events/playViews.ts`, `src/routes/events.ts`, `src/routes/adminEvents.ts`
- Test: `tests/roomViews.test.ts`, `tests/eventRoomRoutes.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 6; T3a `matchRoomView`, `phaseOf`, routes.
- Produces in `playViews.ts`: `RoomPhase` adds `'connect' | 'live' | 'confirming'`; `phaseOf`: `booking` -> `server`, `connect` -> `connect`, `live` -> `live`, `confirming` -> `confirming`.
- Produces in `roomViews.ts`:

```ts
export interface RoomGame {
  id: number; game: number; ordinal: number; tiebreak: boolean; campaign: string; campaignName: string; map: string | null;
  pickedBy: 'a' | 'b' | null; sideBy: 'a' | 'b' | null; firstSurvivors: 'a' | 'b' | null;
  matchId: number | null; state: 'upcoming' | 'live' | 'done'; scoreA: number | null; scoreB: number | null; winner: 'a' | 'b' | null;
  live: { map: string | null; scoreA: number; scoreB: number } | null;
}
export interface RoomSeries { bestOf: number; totalScore: boolean; winsA: number; winsB: number; totalA: number; totalB: number; over: boolean; winner: 'a' | 'b' | null }
export interface RoomServer {
  state: 'waiting' | 'setup' | 'ready' | 'ended'; name: string | null; since: string;
  connect: { host: string; port: number; password: string } | null; present: { a: number; b: number } | null; graceEndsAt: string | null;
}
/** a and b are null only while a bracket match still waits for its teams (T3a). */
export interface MatchRoomView {
  id: number; eventSlug: string; eventName: string; roundLabel: string; a: PlayEntry | null; b: PlayEntry | null; phase: RoomPhase;
  higher: 'a' | 'b' | null; deadline: string | null; serverNow: string; ready: { a: boolean; b: boolean };
  vetoSummary: string; pool: RoomCampaign[]; log: RoomLogLine[]; games: RoomGame[];
  next: { kind: 'order' | 'ban' | 'pick' | 'side'; by: 'a' | 'b'; game: number | null; step: number } | { kind: 'wait'; game: number } | null;
  lineups: { a: RoomPlayer[] | null; b: RoomPlayer[] | null; aLocked: boolean; bLocked: boolean };
  holdReason: string | null;
  result: { winner: 'a' | 'b'; scoreA: number | null; scoreB: number | null; forfeit: boolean } | null;
  me: { side: 'a' | 'b'; manager: boolean; playable: RoomPlayer[]; defaultFour: string[] | null } | null;
  series: RoomSeries | null;
  server: RoomServer | null;
  confirm: { deadline: string | null; a: boolean; b: boolean } | null;
  dispute: { side: 'a' | 'b'; byName: string; reason: string; at: string } | null;
}
```

  `next` is computed on `live` too (the pick step). `games` is in play order (tiebreaks after their game) and carries scores. `server.connect` only for staff and the booking's accepted people. `present` is each side's `present_now`.
- Routes: `POST /api/events/:slug/matches/:id/confirm` -> `{}`; `POST .../dispute` body `{ reason }` -> `{}`; the veto route calls `series.afterPick` after an action on a live match; the admin `reset-room` goes through `series.reset`. Route option `series?: { confirm(matchId: number, steamid: string): Promise<V.Checked<unknown>>; dispute(matchId: number, steamid: string, reason: unknown): V.Checked<unknown>; afterPick(matchId: number): void; reset(matchId: number, by: string): V.Checked<unknown> }` on both route plugins' inline `opts` types (the ones that carry `rooms?: RoomClock`; `AdminEventOptions` in `adminEvents.ts` is the desk's option lists payload, not the plugin's options).

- [ ] **Step 1: Write the failing view tests**

Append to `tests/roomViews.test.ts` (imports: `seriesFixture`, `type SeriesFixture`, `MIN` from `./seriesFixture.js`; `* as B from '../src/bookings/bookings.js'`; `afterEach`):

```ts
describe('matchRoomView with a server and a series (plan T3b)', () => {
  let f: SeriesFixture;
  afterEach(() => f?.close());
  const sview = (viewer: string | null, staff = false) => matchRoomView(f.db, E.getEvent(f.db, f.eventId)!, P.getMatch(f.db, f.matchId)!, viewer, staff, new Date(f.t.t));

  it('shows the connect line only to the booking\'s people and staff, with the grace and who is on', async () => {
    f = await seriesFixture();
    await f.tick();
    f.box.humans = [...A.slice(0, 4), B[0]!];
    f.t.t += MIN;
    await f.tick();
    const b = f.booking();
    const mine = sview(A[4]);
    expect(mine.phase).toBe('connect');
    expect(mine.server).toEqual({ state: 'ready', name: 'box', since: b.created_at, connect: { host: '10.0.0.1', port: 27015, password: b.password }, present: { a: 4, b: 1 }, graceEndsAt: f.match().deadline });
    expect(sview(OUTSIDER).server!.connect).toBeNull();
    expect(sview(B[4]).server!.connect).toBeNull();
    expect(sview('76561199000000700', true).server!.connect).not.toBeNull();
    expect(mine.games).toEqual([expect.objectContaining({ game: 1, ordinal: 1, tiebreak: false, state: 'live', scoreA: null, matchId: f.gameOf(1).match_id, live: null })]);
    expect(mine.series).toEqual({ bestOf: 1, totalScore: false, winsA: 0, winsB: 0, totalA: 0, totalB: 0, over: false, winner: null });
  });

  it('shows waiting for a server, then the live score, the pick step, the result and the confirm window', async () => {
    f = await seriesFixture();
    f.db.prepare("UPDATE servers SET status = 'live'").run();
    await f.tick();
    expect(sview(null).server).toMatchObject({ state: 'waiting', name: null, connect: null });
    expect(sview(null).phase).toBe('server');
    f.db.prepare("UPDATE servers SET status = 'idle'").run();
    await f.tick();
    const g1 = f.gameOf(1);
    f.goLive(g1.match_id!, 'l4d_vs_hospital02_subway');
    f.db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score) VALUES (?, 0, 1, 'a', 120), (?, 0, 2, 'b', 80)").run(g1.match_id!, g1.match_id!);
    const live = sview(null);
    expect(live.phase).toBe('live');
    // Match team a is Bats: 120 for Bats is score_b for the room.
    expect(live.games[0]!.live).toEqual({ map: 'l4d_vs_hospital02_subway', scoreA: 80, scoreB: 120 });
    f.endGame(g1.match_id!, [{ map: 'l4d_vs_hospital02_subway', a: 300, b: 400 }]);
    const done = sview(null);
    expect(done.phase).toBe('confirming');
    expect(done.games[0]).toMatchObject({ state: 'done', scoreA: 400, scoreB: 300, winner: 'a', live: null });
    expect(done.series).toMatchObject({ winsA: 1, winsB: 0, over: true, winner: 'a' });
    expect(done.confirm).toEqual({ deadline: f.match().deadline, a: false, b: false });
    expect(done.dispute).toBeNull();
    f.series.dispute(f.matchId, B[0]!, 'Rats had five', new Date(f.t.t));
    expect(sview(null)).toMatchObject({ phase: 'hold', holdReason: 'dispute', dispute: { side: 'b', byName: expect.any(String), reason: 'Rats had five' } });
  });

  it('maps the series statuses to phases', () => {
    const m = (status: P.MatchStatus) => ({ status, ready_a_at: 'x', ready_b_at: 'y' }) as P.MatchRow;
    expect(['booking', 'connect', 'live', 'confirming'].map((s) => phaseOf(m(s as P.MatchStatus)))).toEqual(['server', 'connect', 'live', 'confirming']);
  });
});
```

(`B[4]` is on team Bats but not on the entry's roster, so not on the booking.) Also change the T3a phase test's `'server'` expectation for `booking` (unchanged) and keep its others.

Append to `tests/eventRoomRoutes.test.ts` (imports `createTournamentBooking`, `getBooking` from `../src/bookings/bookings.js`, `driveToBooking` from `./roomFixture.js`):

```ts
describe('confirm, dispute and reset over HTTP (plan T3b)', () => {
  const booked = () => {
    driveToBooking(f);
    const r = createTournamentBooking(f.db, {
      region: 'na', campaign: 'no_mercy', rulesJson: '{}', rulesetId: null, gameConfig: 'standard', createdBy: ADMIN,
      sides: [{ teamId: null, captain: A[0]!, players: A.slice(0, 4), spectators: [] }, { teamId: null, captain: B[0]!, players: B.slice(0, 4), spectators: [] }],
    });
    if (!r.ok) throw new Error(r.error);
    if (!R.attachBooking(f.db, { matchId: f.matchId, bookingId: r.value.id }).ok) throw new Error('attach');
    return r.value.id;
  };

  it('confirms and disputes in the window, for managers only', async () => {
    booked();
    R.startConnect(f.db, { matchId: f.matchId, graceMinutes: 15 });
    R.startLive(f.db, { matchId: f.matchId });
    expect((await post(`${room()}/confirm`, A[0])).json()).toEqual({ error: 'This match is not in its confirm window.' });
    R.startConfirm(f.db, { matchId: f.matchId, timers: TIMERS });
    expect((await post(`${room()}/confirm`, OUTSIDER)).statusCode).toBe(403);
    expect((await post(`${room()}/confirm`, A[1])).statusCode).toBe(200);
    expect(P.getMatch(f.db, f.matchId)!.confirm_a_at).not.toBeNull();
    expect((await post(`${room()}/dispute`, B[0], { reason: 'no' })).json()).toEqual({ error: expect.stringContaining('A reason is') });
    expect((await post(`${room()}/dispute`, B[0], { reason: 'Rats had five on map 2' })).statusCode).toBe(200);
    expect(P.getMatch(f.db, f.matchId)).toMatchObject({ status: 'admin_hold', hold_reason: 'dispute', dispute_side: 'b' });
    expect((await get(room(), OUTSIDER)).json().dispute).toMatchObject({ side: 'b', reason: 'Rats had five on map 2' });
  });

  it('resets a booked room through the engine, cancelling the booking', async () => {
    const bookingId = booked();
    expect((await post(`/api/admin/events/${f.eventId}/matches/${f.matchId}/reset-room`, ADMIN)).statusCode).toBe(200);
    expect(P.getMatch(f.db, f.matchId)).toMatchObject({ status: 'waiting', booking_id: null });
    expect(getBooking(f.db, bookingId)).toMatchObject({ state: 'cancelled', end_reason: 'staff' });
  });
});
```

The reset test needs `server.ts` to have built the engine with the real `BookingRunner`: the booking never had a box, so its wind-down touches no rcon. If the runner's `onCancelled` DM path needs a `notifier.dm` that is null in tests, that is already how every booking route test runs.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/roomViews.test.ts tests/eventRoomRoutes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Views**

In `src/events/playViews.ts`:

```ts
export type RoomPhase = 'pending' | 'waiting' | 'ready' | 'veto' | 'lineup' | 'server' | 'connect' | 'live' | 'confirming' | 'hold' | 'done';

export function phaseOf(m: Pick<P.MatchRow, 'status' | 'ready_a_at' | 'ready_b_at'>): RoomPhase {
  switch (m.status) {
    case 'pending': return 'pending';
    case 'waiting': return 'waiting';
    case 'veto': return m.ready_a_at !== null && m.ready_b_at !== null ? 'veto' : 'ready';
    case 'lineup': return 'lineup';
    case 'booking': return 'server';
    case 'connect': return 'connect';
    case 'live': return 'live';
    case 'confirming': return 'confirming';
    case 'admin_hold': return 'hold';
    default: return 'done';
  }
}
```

In `src/events/roomViews.ts`: add the three interfaces and the four fields to `MatchRoomView` as in Interfaces, replace `RoomGame`, and add the imports `import * as B from '../bookings/bookings.js';`, `import { getServer } from '../serverPool.js';`, `import { gameNumberOf, playOrder, seriesVerdict } from './seriesRules.js';`. In `matchRoomView`:

- `next`'s guard becomes `!st || !((m.status === 'veto' && m.ready_a_at !== null && m.ready_b_at !== null) || m.status === 'live') ? null : ...`.
- Replace the `games` mapping and add the new fields:

```ts
  const seriesRows = R.seriesGames(db, m);
  const verdict = seriesRows.length > 0 ? seriesVerdict(settings.veto, seriesRows) : null;
  const booking = m.booking_id !== null ? B.getBooking(db, m.booking_id) : undefined;
  const canConnect = staff || (viewer !== null && booking !== undefined && B.acceptedPeople(db, booking.id).some((p) => p.steamid === viewer));
  const liveScore = (gameMatchId: number): RoomGame['live'] => {
    const live = db.prepare('SELECT current_map FROM match_live WHERE match_id = ?').get(gameMatchId) as { current_map: string | null } | undefined;
    if (!live) return null;
    const sideA = (db.prepare('SELECT booking_side_a FROM matches WHERE id = ?').get(gameMatchId) as { booking_side_a: 'a' | 'b' | null }).booking_side_a ?? 'a';
    const totals = { a: 0, b: 0 };
    for (const r of db.prepare('SELECT surv_team, SUM(score) AS s FROM match_rounds WHERE match_id = ? GROUP BY surv_team').all(gameMatchId) as { surv_team: 'a' | 'b'; s: number }[]) totals[r.surv_team] = r.s;
    return { map: live.current_map, scoreA: sideA === 'a' ? totals.a : totals.b, scoreB: sideA === 'a' ? totals.b : totals.a };
  };
  const roomGames: RoomGame[] = playOrder(seriesRows).map((sg) => {
    const g = games.find((x) => x.id === sg.id)!;
    const state: RoomGame['state'] = g.score_a !== null ? 'done' : g.match_id !== null ? 'live' : 'upcoming';
    return {
      id: g.id, game: gameNumberOf(sg, seriesRows), ordinal: g.ordinal, tiebreak: g.tiebreak_of !== null, campaign: g.campaign, campaignName: name(g.campaign)!, map: g.map,
      pickedBy: sideOfEntry(g.picked_by), sideBy: sideOfEntry(g.side_by), firstSurvivors: sideOfEntry(g.first_survivors),
      matchId: g.match_id, state, scoreA: g.score_a, scoreB: g.score_b, winner: sideOfEntry(g.winner), live: state === 'live' ? liveScore(g.match_id!) : null,
    };
  });
  let server: RoomServer | null = null;
  if (booking) {
    const s = booking.server_id !== null ? getServer(db, booking.server_id) : undefined;
    const running = (booking.state === 'ready' || booking.state === 'active') && booking.ending_at === null;
    const sides = B.sidesOf(db, booking.id);
    server = {
      state: booking.ending_at !== null ? 'ended' : running ? 'ready' : booking.server_id === null ? 'waiting' : 'setup',
      name: s?.name ?? null, since: booking.created_at,
      connect: running && canConnect && s ? { host: s.host, port: s.port, password: booking.password } : null,
      present: running ? { a: sides.find((x) => x.side === 'a')?.present_now ?? 0, b: sides.find((x) => x.side === 'b')?.present_now ?? 0 } : null,
      graceEndsAt: m.status === 'connect' ? m.deadline : null,
    };
  }
```

  and in the returned object: `games: roomGames`, plus

```ts
    series: verdict ? { bestOf: verdict.bestOf, totalScore: verdict.totalScore, winsA: verdict.winsA, winsB: verdict.winsB, totalA: verdict.totalA, totalB: verdict.totalB, over: verdict.over, winner: verdict.winner } : null,
    server,
    confirm: m.status === 'confirming' ? { deadline: m.deadline, a: m.confirm_a_at !== null, b: m.confirm_b_at !== null } : null,
    dispute: m.dispute_side !== null ? { side: m.dispute_side, byName: getPlayer(db, m.dispute_by ?? '')?.name ?? 'a captain', reason: m.dispute_reason ?? '', at: m.disputed_at ?? '' } : null,
```

The pool's `game` tiles keep using `games` (the raw rows) for `picked`/`decider`; a tiebreak row shares its campaign with its game, so in the pool mapping take the series game (`tiebreak_of === null`) when several rows share a campaign.

- [ ] **Step 4: Routes**

In `src/routes/events.ts`: add `series?` to the plugin's `opts` type as in Interfaces. The room actions are one route per name from a loop (`for (const action of ['ready', 'veto', 'lineup'] as const)`), so widen the list to `['ready', 'veto', 'lineup', 'confirm', 'dispute'] as const`, add `reason?: unknown` to the `body` type, and extend the chain after the `lineup` branch:

```ts
      else if (action === 'confirm') {
        if (!opts.series) return reply.code(404).send(NOT_FOUND);
        r = await opts.series.confirm(m.id, me);
      } else if (action === 'dispute') {
        if (!opts.series) return reply.code(404).send(NOT_FOUND);
        r = opts.series.dispute(m.id, me, body.reason);
      } else r = R.lockLineup(db, { matchId: m.id, steamid: me, steamids: body.steamids, timers });
```

  (the `lineup` branch stays the final `else`), and after `if (!r.ok) return refuse(reply, r);`:

```ts
      // T3b Ruling 4: a pick on a live match may have settled the next game.
      if (action === 'veto' && P.getMatch(db, m.id)?.status === 'live') opts.series?.afterPick(m.id);
```

In `src/routes/adminEvents.ts`: add `series?` to the plugin's `opts` type (next to `rooms?: RoomClock`); in `roomAction`, the reset branch becomes `action === 'reset-room' ? (opts.series ? opts.series.reset(m.id, me) : R.resetRoom(db, { matchId: m.id, by: me }))` (its refusal already goes through `refuse(reply, r.error)`).

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/roomViews.test.ts tests/eventRoomRoutes.test.ts tests/eventPlayRoutes.test.ts tests/adminEventRoutes.test.ts tests/eventGating.test.ts && npm run typecheck`
Expected: PASS (the web typecheck fails until Task 9 copies the types; run `npm run typecheck` for the server side only if the script splits them, else accept the web failure here and fix it in Task 9).

- [ ] **Step 6: Commit**

```bash
git add src/events/roomViews.ts src/events/playViews.ts src/routes/events.ts src/routes/adminEvents.ts tests/roomViews.test.ts tests/eventRoomRoutes.test.ts
git commit -m "Tournaments T3b: the room view carries the server and connect line for the booking's people, the series score with a live game's score, the confirm window and a dispute, with confirm and dispute routes and a reset that cancels the booking"
```

---
### Task 9: The room page: server, series, pick step, confirm and dispute

**Files:**
- Modify: `web/src/api.ts`, `web/src/routes/EventMatch.tsx`, `web/src/routes/event/room/roomText.ts`, `web/src/styles/app.css`
- Create: `web/src/routes/event/room/ServerPanel.tsx`, `web/src/routes/event/room/SeriesPanel.tsx`, `web/src/routes/event/room/ConfirmPanel.tsx`
- Test: `web/src/routes/event/room/roomText.test.ts`, `web/src/routes/event/room/ServerPanel.test.tsx`, `web/src/routes/event/room/ConfirmPanel.test.tsx`, `web/src/routes/EventMatch.test.tsx`

**Interfaces:**
- Consumes: Task 8's view shape and routes; T3a's page, `VetoBoard`, `roomText`.
- Produces in `web/src/api.ts`: `RoomPhase` with the three new phases; `RoomGame`, `RoomSeries`, `RoomServer` and the four new `MatchRoomView` fields copied from `src/events/roomViews.ts`; `eventsApi.confirmResult(slug, id)` and `eventsApi.dispute(slug, id, reason)` posting to the two routes.
- Produces in `roomText.ts`: `PHASE_TEXT` entries `connect: 'Connect'`, `live: 'Live'`, `confirming: 'Confirming'`; `gameTitle(g: RoomGame): string` ("Game 2", "Tiebreak of game 1"); `gameLine(v, g): string`; `seriesLine(v): string`; `resultLine(v): string`.
- Produces `ServerPanel({ v, now })`, `SeriesPanel({ v })`, `ConfirmPanel({ v, now, busy, onConfirm, onDispute })`.

Page additions, in the T3a order: after the header, a **Server** panel in phases `server`, `connect`, `live` and `confirming` (waiting / setting up / the connect line with a Copy button for those who may see it, who is on, the grace countdown / closed); the **Veto** panel stays and shows the pick step on a live match through `VetoBoard` (it already renders `v.next`); a **Series** panel replaces the veto panel's plain game list once `v.series` is set (score line, one row per game in play order, the live game's map and score); the **Confirm** panel in phase `confirming` (the result, the countdown, Confirm and Dispute for a manager); the hold panel names a dispute. The page polls every 10 seconds in the new phases too.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/routes/event/room/roomText.test.ts` (the `v()` builder gains `series: null, server: null, confirm: null, dispute: null`; the existing log test's `games: [{ game: 1, campaign: 'no_mercy', ... }]` literal is an old-shape `RoomGame` and `logText` never reads it, so drop it there or give it the new fields; import `RoomGame` from `../../../api` and the four new functions):

```ts
  it('titles games and tiebreaks, writes a game line with scores, and the series and result lines', () => {
    const g = (over: Partial<RoomGame>): RoomGame => ({
      id: 1, game: 1, ordinal: 1, tiebreak: false, campaign: 'no_mercy', campaignName: 'No Mercy', map: null, pickedBy: null, sideBy: 'b', firstSurvivors: 'b',
      matchId: null, state: 'upcoming', scoreA: null, scoreB: null, winner: null, live: null, ...over,
    });
    const view = v({ series: { bestOf: 3, totalScore: false, winsA: 1, winsB: 1, totalA: 900, totalB: 900, over: false, winner: null } });
    expect(gameTitle(g({}))).toBe('Game 1');
    expect(gameTitle(g({ tiebreak: true, ordinal: 11 }))).toBe('Tiebreak of game 1');
    expect(gameLine(view, g({}))).toBe('Game 1 · No Mercy · Bats start as survivors');
    expect(gameLine(view, g({ state: 'live', matchId: 7, live: { map: 'l4d_vs_hospital03_sewers', scoreA: 80, scoreB: 120 } }))).toBe('Game 1 · No Mercy · live on l4d_vs_hospital03_sewers · Rats 80 - 120 Bats');
    expect(gameLine(view, g({ state: 'done', scoreA: 600, scoreB: 400, winner: 'a' }))).toBe('Game 1 · No Mercy · Rats 600 - 400 Bats');
    expect(gameLine(view, g({ tiebreak: true, ordinal: 11, map: 'l4d_vs_hospital04_interior', state: 'done', scoreA: 20, scoreB: 50, winner: 'b' }))).toBe('Tiebreak of game 1 · No Mercy, l4d_vs_hospital04_interior · Rats 20 - 50 Bats');
    expect(seriesLine(view)).toBe('Best of 3 · Rats 1 - 1 Bats');
    expect(seriesLine(v({ series: { bestOf: 2, totalScore: true, winsA: 0, winsB: 0, totalA: 1000, totalB: 1050, over: true, winner: 'b' } }))).toBe('Two games, total score · Rats 1000 - 1050 Bats');
    expect(resultLine(v({ series: { bestOf: 3, totalScore: false, winsA: 2, winsB: 1, totalA: 0, totalB: 0, over: true, winner: 'a' } }))).toBe('Rats beat Bats 2 games to 1.');
    expect(resultLine(v({ series: { bestOf: 2, totalScore: true, winsA: 0, winsB: 0, totalA: 1000, totalB: 1050, over: true, winner: 'b' } }))).toBe('Bats beat Rats 1050 to 1000 on total score.');
  });
```

Create `web/src/routes/event/room/ServerPanel.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import type { MatchRoomView } from '../../../api';
import { ServerPanel } from './ServerPanel';

afterEach(cleanup);
const base = (over: Partial<MatchRoomView>): MatchRoomView => ({
  id: 1, eventSlug: 'cup', eventName: 'Cup', roundLabel: 'Round 1',
  a: { id: 1, name: 'Rats', tag: 'RAT', logoKey: null, seed: 1, out: false }, b: { id: 2, name: 'Bats', tag: 'BAT', logoKey: null, seed: 2, out: false },
  phase: 'connect', higher: 'a', deadline: '2026-10-06T00:15:00.000Z', serverNow: '2026-10-06T00:00:00.000Z', ready: { a: true, b: true }, vetoSummary: '',
  pool: [], log: [], games: [], next: null, lineups: { a: null, b: null, aLocked: true, bLocked: true }, holdReason: null, result: null, me: null,
  series: null, server: null, confirm: null, dispute: null, ...over,
});
const NOW = Date.parse('2026-10-06T00:05:00.000Z');

describe('ServerPanel', () => {
  it('says it is waiting for a server, with when since', () => {
    render(<ServerPanel v={base({ phase: 'server', server: { state: 'waiting', name: null, since: '2026-10-06T00:00:00.000Z', connect: null, present: null, graceEndsAt: null } })} now={NOW} />);
    expect(screen.getByText(/Waiting for a server/)).toBeTruthy();
  });

  it('shows the connect line, who is on and the grace to those who may see it, and only the counts to others', () => {
    const server = { state: 'ready' as const, name: 'box', since: '2026-10-06T00:00:00.000Z', connect: { host: '10.0.0.1', port: 27015, password: 'pw' }, present: { a: 4, b: 3 }, graceEndsAt: '2026-10-06T00:15:00.000Z' };
    render(<ServerPanel v={base({ server })} now={NOW} />);
    expect(screen.getByText('connect 10.0.0.1:27015; password pw')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
    expect(screen.getByText('On the server: Rats 4 of 4, Bats 3 of 4')).toBeTruthy();
    expect(screen.getByText(/Both teams need four on the server within 10:00/)).toBeTruthy();
    cleanup();
    render(<ServerPanel v={base({ server: { ...server, connect: null } })} now={NOW} />);
    expect(screen.queryByText(/password/)).toBeNull();
    expect(screen.getByText(/The teams are connecting/)).toBeTruthy();
  });
});
```

Create `web/src/routes/event/room/ConfirmPanel.test.tsx` (the dispute goes behind the site's own `confirm` dialog from `components/Confirm`, mocked the way `PlayPanel.test.tsx` mocks it, not `window.confirm`):

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { MatchRoomView } from '../../../api';

vi.mock('../../../components/Confirm', () => ({ confirm: vi.fn(async () => true) }));
const { ConfirmPanel } = await import('./ConfirmPanel');
const { confirm } = await import('../../../components/Confirm');

afterEach(() => { cleanup(); vi.clearAllMocks(); });
const view = (over: Partial<MatchRoomView>): MatchRoomView => ({
  id: 1, eventSlug: 'cup', eventName: 'Cup', roundLabel: 'Round 1',
  a: { id: 1, name: 'Rats', tag: 'RAT', logoKey: null, seed: 1, out: false }, b: { id: 2, name: 'Bats', tag: 'BAT', logoKey: null, seed: 2, out: false },
  phase: 'confirming', higher: 'a', deadline: '2026-10-06T00:15:00.000Z', serverNow: '2026-10-06T00:00:00.000Z', ready: { a: true, b: true }, vetoSummary: '',
  pool: [], log: [], games: [], next: null, lineups: { a: null, b: null, aLocked: true, bLocked: true }, holdReason: null, result: null,
  me: { side: 'b', manager: true, playable: [], defaultFour: null },
  series: { bestOf: 3, totalScore: false, winsA: 2, winsB: 1, totalA: 0, totalB: 0, over: true, winner: 'a' }, server: null,
  confirm: { deadline: '2026-10-06T00:15:00.000Z', a: true, b: false }, dispute: null, ...over,
});
const NOW = Date.parse('2026-10-06T00:05:00.000Z');

describe('ConfirmPanel', () => {
  it('shows the result, who confirmed and the countdown, and lets a manager confirm or dispute with a reason', async () => {
    const onConfirm = vi.fn();
    const onDispute = vi.fn();
    render(<ConfirmPanel v={view({})} now={NOW} busy={false} onConfirm={onConfirm} onDispute={onDispute} />);
    expect(screen.getByText('Rats beat Bats 2 games to 1.')).toBeTruthy();
    expect(screen.getByText('Rats confirmed. Bats have not confirmed yet.')).toBeTruthy();
    expect(screen.getByText(/10:00 left/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm the result' }));
    expect(onConfirm).toHaveBeenCalled();
    fireEvent.input(screen.getByRole('textbox', { name: 'Why you dispute the result' }), { target: { value: 'Rats had five on map 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Dispute the result' }));
    await waitFor(() => expect(onDispute).toHaveBeenCalledWith('Rats had five on map 2'));
    expect(confirm).toHaveBeenCalled();
  });

  it('offers nothing to a player who is not a manager, and says a team already confirmed', () => {
    render(<ConfirmPanel v={view({ me: { side: 'a', manager: true, playable: [], defaultFour: null } })} now={NOW} busy={false} onConfirm={() => {}} onDispute={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Confirm the result' })).toBeNull();
    expect(screen.getByText('Your team has confirmed.')).toBeTruthy();
    cleanup();
    render(<ConfirmPanel v={view({ me: null })} now={NOW} busy={false} onConfirm={() => {}} onDispute={() => {}} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
```

Append to `web/src/routes/EventMatch.test.tsx` (its builder is `view()` and gains the four new fields as null; `mockEvents` gains `confirmResult: vi.fn()` and `dispute: vi.fn()`; add `vi.mock('../components/Confirm', () => ({ confirm: vi.fn(async () => true) }));` next to the existing `useHubEvent` mock, before the `await import`):

```tsx
  it('shows the server panel with the connect line in the connect phase, and the series with a live score (plan T3b)', async () => {
    mockEvents.room.mockResolvedValue(view({
      phase: 'live', deadline: null,
      server: { state: 'ready', name: 'box', since: '2026-10-06T00:00:00.000Z', connect: { host: '10.0.0.1', port: 27015, password: 'pw' }, present: { a: 4, b: 4 }, graceEndsAt: null },
      series: { bestOf: 1, totalScore: false, winsA: 0, winsB: 0, totalA: 0, totalB: 0, over: false, winner: null },
      games: [{ id: 1, game: 1, ordinal: 1, tiebreak: false, campaign: 'no_mercy', campaignName: 'No Mercy', map: null, pickedBy: null, sideBy: 'b', firstSurvivors: 'b', matchId: 7, state: 'live', scoreA: null, scoreB: null, winner: null, live: { map: 'l4d_vs_hospital02_subway', scoreA: 80, scoreB: 120 } }],
    }));
    render(<EventMatchPage slug="cup" id="1" session={{ kind: 'active' } as never} />);
    expect(await screen.findByText('connect 10.0.0.1:27015; password pw')).toBeTruthy();
    expect(screen.getByText('Game 1 · No Mercy · live on l4d_vs_hospital02_subway · Rats 80 - 120 Bats')).toBeTruthy();
    expect(screen.getByText('Live')).toBeTruthy();
  });

  it('confirms and disputes from the confirm panel (plan T3b)', async () => {
    mockEvents.room.mockResolvedValue(view({
      phase: 'confirming', deadline: '2026-10-06T00:15:00.000Z',
      me: { side: 'b', manager: true, playable: [], defaultFour: null },
      series: { bestOf: 1, totalScore: false, winsA: 1, winsB: 0, totalA: 0, totalB: 0, over: true, winner: 'a' },
      confirm: { deadline: '2026-10-06T00:15:00.000Z', a: false, b: false },
    }));
    mockEvents.confirmResult.mockResolvedValue({});
    mockEvents.dispute.mockResolvedValue({});
    render(<EventMatchPage slug="cup" id="1" session={{ kind: 'active' } as never} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm the result' }));
    await waitFor(() => expect(mockEvents.confirmResult).toHaveBeenCalledWith('cup', 1));
    fireEvent.input(screen.getByRole('textbox', { name: 'Why you dispute the result' }), { target: { value: 'They had five' } });
    fireEvent.click(screen.getByRole('button', { name: 'Dispute the result' }));
    await waitFor(() => expect(mockEvents.dispute).toHaveBeenCalledWith('cup', 1, 'They had five'));
  });
```

The `session` literal is the one the T3a tests pass (`{ kind: 'active' } as never`); the page does not read it.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run web/src/routes/event/room web/src/routes/EventMatch.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write the pieces**

In `web/src/api.ts`: widen `RoomPhase`, replace `RoomGame`, add `RoomSeries` and `RoomServer`, add `series`, `server`, `confirm`, `dispute` to `MatchRoomView` (exactly the Task 8 shapes), and on `eventsApi`:

```ts
  confirmResult: (slug: string, id: number) => post(`/api/events/${enc(slug)}/matches/${id}/confirm`),
  dispute: (slug: string, id: number, reason: string) => post(`/api/events/${enc(slug)}/matches/${id}/dispute`, { reason }),
```

In `roomText.ts`, extend `PHASE_TEXT` with `connect: 'Connect', live: 'Live', confirming: 'Confirming',` and add:

```ts
import type { RoomGame } from '../../../api';

export function gameTitle(g: RoomGame): string {
  return g.tiebreak ? `Tiebreak of game ${g.game}` : `Game ${g.game}`;
}

/** One line per game: its campaign (and chapter for a tiebreak), then the
 *  sides, the live map and score, or the final score. v.a and v.b can be
 *  null on a pending bracket match (T3a), hence team(). */
export function gameLine(v: MatchRoomView, g: RoomGame): string {
  const where = g.tiebreak && g.map ? `${g.campaignName}, ${g.map}` : g.campaignName;
  const score = (a: number, b: number) => `${team(v, 'a')} ${a} - ${b} ${team(v, 'b')}`;
  if (g.state === 'done' && g.scoreA !== null && g.scoreB !== null) return `${gameTitle(g)} · ${where} · ${score(g.scoreA, g.scoreB)}`;
  if (g.state === 'live') return `${gameTitle(g)} · ${where} · live${g.live?.map ? ` on ${g.live.map}` : ''}${g.live ? ` · ${score(g.live.scoreA, g.live.scoreB)}` : ''}`;
  const first = g.firstSurvivors ? ` · ${team(v, g.firstSurvivors)} start as survivors` : '';
  return `${gameTitle(g)} · ${where}${first}`;
}

export function seriesLine(v: MatchRoomView): string {
  const s = v.series;
  if (!s) return '';
  return s.totalScore ? `Two games, total score · ${team(v, 'a')} ${s.totalA} - ${s.totalB} ${team(v, 'b')}` : `Best of ${s.bestOf} · ${team(v, 'a')} ${s.winsA} - ${s.winsB} ${team(v, 'b')}`;
}

export function resultLine(v: MatchRoomView): string {
  const s = v.series;
  if (!s || !s.winner) return '';
  const w = s.winner;
  const l = w === 'a' ? 'b' : 'a';
  const line = s.totalScore
    ? `${w === 'a' ? s.totalA : s.totalB} to ${w === 'a' ? s.totalB : s.totalA} on total score`
    : `${w === 'a' ? s.winsA : s.winsB} games to ${w === 'a' ? s.winsB : s.winsA}`;
  return `${team(v, w)} beat ${team(v, l)} ${line}.`;
}
```

`web/src/routes/event/room/ServerPanel.tsx`:

```tsx
import { useState } from 'preact/hooks';
import type { MatchRoomView } from '../../../api';
import { clockText } from './roomText';

const hhmm = (iso: string): string => `${iso.slice(11, 16)} UTC`;

/** The booked server: waiting, setting up, ready (the connect line for those
 *  who may see it, who is on, the grace), or closed. */
export function ServerPanel({ v, now }: { v: MatchRoomView; now: number }) {
  const s = v.server;
  const [copied, setCopied] = useState(false);
  const aName = v.a?.name ?? 'TBD';
  const bName = v.b?.name ?? 'TBD';
  if (!s) return <p>Booking a server.</p>;
  if (s.state === 'waiting') return <p>{`Waiting for a server since ${hhmm(s.since)}. No box is free in the region right now; staff are told after 10 minutes.`}</p>;
  if (s.state === 'setup') return <p>{`Setting up ${s.name ?? 'the server'}.`}</p>;
  if (s.state === 'ended') return <p>The server is closed.</p>;
  const line = s.connect ? `connect ${s.connect.host}:${s.connect.port}; password ${s.connect.password}` : null;
  const copy = async () => {
    if (!line) return;
    try { await navigator.clipboard.writeText(line); setCopied(true); } catch { setCopied(false); }
  };
  const grace = s.graceEndsAt ? Date.parse(s.graceEndsAt) - now : null;
  return (
    <div class="roomserver">
      {line ? (
        <p class="roomserver__connect">
          <code>{line}</code>
          <button class="btn btn--sm" type="button" onClick={() => { void copy(); }}>{copied ? 'Copied' : 'Copy'}</button>
        </p>
      ) : <p>{`The teams are connecting to ${s.name ?? 'the server'}.`}</p>}
      {s.present && <p>{`On the server: ${aName} ${s.present.a} of 4, ${bName} ${s.present.b} of 4`}</p>}
      {grace !== null && <p class="roomserver__grace">{`Both teams need four on the server within ${clockText(grace)}, or the team that is short forfeits.`}</p>}
    </div>
  );
}
```

`web/src/routes/event/room/SeriesPanel.tsx`:

```tsx
import type { MatchRoomView } from '../../../api';
import { gameLine, seriesLine } from './roomText';

export function SeriesPanel({ v }: { v: MatchRoomView }) {
  return (
    <div class="roomseries">
      <p class="roomseries__score">{seriesLine(v)}</p>
      <ol class="roomseries__games">
        {v.games.map((g) => (
          <li key={g.id} class={`roomseries__game roomseries__game--${g.state}`}>
            {g.matchId !== null && g.state !== 'upcoming' ? <a href={`/match/${g.matchId}`}>{gameLine(v, g)}</a> : gameLine(v, g)}
          </li>
        ))}
      </ol>
    </div>
  );
}
```

`web/src/routes/event/room/ConfirmPanel.tsx`:

```tsx
import { useState } from 'preact/hooks';
import type { MatchRoomView } from '../../../api';
import { confirm } from '../../../components/Confirm';
import { clockText, resultLine } from './roomText';

/** The confirm window: the result, who confirmed, the countdown, and a
 *  manager's Confirm or Dispute (with a reason, behind the site's confirm
 *  dialog). */
export function ConfirmPanel({ v, now, busy, onConfirm, onDispute }: {
  v: MatchRoomView; now: number; busy: boolean; onConfirm: () => void; onDispute: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const c = v.confirm;
  const left = c?.deadline ? Date.parse(c.deadline) - now : null;
  const me = v.me;
  const aName = v.a?.name ?? 'TBD';
  const bName = v.b?.name ?? 'TBD';
  const mineDone = me ? (me.side === 'a' ? c?.a : c?.b) : false;
  const who = c ? [c.a ? `${aName} confirmed.` : '', c.b ? `${bName} confirmed.` : ''].filter(Boolean).join(' ') : '';
  const pending = c ? [c.a ? '' : aName, c.b ? '' : bName].filter(Boolean) : [];
  const dispute = async () => {
    if (await confirm('Dispute the result? The match goes on hold until staff look at it.')) onDispute(reason.trim());
  };
  const status = `${who}${who && pending.length ? ' ' : ''}${pending.length ? `${pending.join(' and ')} have not confirmed yet.` : ''}`.trim();
  return (
    <div class="roomconfirm">
      <p class="roomconfirm__result">{resultLine(v)}</p>
      {status && <p>{status}</p>}
      {left !== null && <p>{`${clockText(left)} left. With no dispute the result stands.`}</p>}
      {me?.manager && (mineDone ? <p>Your team has confirmed.</p> : (
        <div class="roomconfirm__actions">
          <button class="btn" type="button" disabled={busy} onClick={onConfirm}>Confirm the result</button>
          <label class="roomconfirm__reason">
            <span>Why you dispute the result</span>
            <textarea aria-label="Why you dispute the result" value={reason} maxLength={300} onInput={(e) => setReason((e.target as HTMLTextAreaElement).value)} />
          </label>
          <button class="btn btn--danger" type="button" disabled={busy || reason.trim().length < 3} onClick={() => { void dispute(); }}>
            Dispute the result
          </button>
        </div>
      ))}
    </div>
  );
}
```

(The test expects "Rats confirmed. Bats have not confirmed yet."; with one team pending the sentence reads "Bats have not confirmed yet.", which is the wording the test pins.)

In `web/src/routes/EventMatch.tsx`:
- `const LIVE = new Set(['ready', 'veto', 'lineup', 'server', 'connect', 'live', 'confirming']);`
- imports: `ServerPanel`, `SeriesPanel`, `ConfirmPanel`, and `resultLine` from `roomText`.
- after the error line, before the ready panel:

```tsx
      {(v.phase === 'server' || v.phase === 'connect' || v.phase === 'live' || v.phase === 'confirming') && (
        <Panel>
          <h3>Server</h3>
          <ServerPanel v={v} now={now + offset} />
        </Panel>
      )}
```

- in the veto panel, render the plain game list only when `!v.series` (`{!v.series && v.games.length > 0 && (...)}`), and add after the veto panel:

```tsx
      {v.series && (
        <Panel>
          <h3>Series</h3>
          <SeriesPanel v={v} />
        </Panel>
      )}
```

- replace the `v.phase === 'server'` sentence panel with nothing (the server panel covers it);
- the hold panel becomes:

```tsx
      {v.phase === 'hold' && (
        <Panel>
          <p class="warning">{`On hold: staff are looking at this match.${v.holdReason && v.holdReason !== 'dispute' ? ` (${v.holdReason})` : ''}`}</p>
          {v.dispute && <p>{`Disputed by ${v.dispute.byName} for ${v.dispute.side === 'a' ? v.a?.name ?? 'TBD' : v.b?.name ?? 'TBD'}: ${v.dispute.reason}`}</p>}
        </Panel>
      )}
```

- add the confirm panel:

```tsx
      {v.phase === 'confirming' && (
        <Panel>
          <h3>Result</h3>
          <ConfirmPanel
            v={v} now={now + offset} busy={busy}
            onConfirm={() => { void run(() => eventsApi.confirmResult(slug, matchId)); }}
            onDispute={(reason) => { void run(() => eventsApi.dispute(slug, matchId, reason)); }}
          />
        </Panel>
      )}
```

- the done panel: when `v.series?.over` show `resultLine(v)` instead of the raw scores (a forfeit still says "Forfeit win for X").

In `web/src/styles/app.css`: `.roomserver__connect` (a flex row that wraps, the `code` with `overflow-wrap: anywhere`), `.roomserver__grace` (warning colour), `.roomseries__games` (a plain list, `--live` rows with the accent border, `--done` muted), `.roomconfirm__actions` (a column with the existing gap), `.roomconfirm__reason textarea` (full width, 3 rows), and the `roomphase--connect`, `--live` (live colour), `--confirming` (checkin colour) chips.

- [ ] **Step 4: Run the tests and the build**

Run: `npx vitest run web/src/routes/event/room web/src/routes/EventMatch.test.tsx && npm run typecheck && npm run build`
Expected: PASS and a clean build.

- [ ] **Step 5: Commit**

```bash
git add web/src/api.ts web/src/routes/EventMatch.tsx web/src/routes/EventMatch.test.tsx web/src/routes/event/room web/src/styles/app.css
git commit -m "Tournaments T3b: the match room page shows the booked server and connect line, the series with each game's score and the live score, the loser's pick on a live match, and the confirm window with confirm and dispute"
```

---
### Task 10: Desk and bracket chips for the new phases, and the whole-branch check

**Files:**
- Modify: `web/src/routes/admin/events/PlayPanel.tsx`, `web/src/routes/event/Bracket.tsx` (only if it maps phases itself), `web/src/styles/app.css`
- Test: `web/src/routes/admin/events/PlayPanel.test.tsx`, `web/src/routes/event/StagePlay.test.tsx`

**Interfaces:**
- Consumes: `PHASE_TEXT` (Task 9), `adminApi.resetEventRoom` (T3a), and T3a's Task 10 as built on the branch: `MatchCard` shows `PHASE_TEXT[m.phase]` for every phase but `done`, `pending` and `waiting`; `PlayPanel` offers "Open room: A vs B", "Reset room: A vs B" (behind the site's `confirm` from `components/Confirm`, text "Reset this match room? Ready, veto and lineups are cleared and the room opens again.") and "Hold: A vs B" for the room phases, from a `phase` set, with `PlayPanel.test.tsx` mocking `confirm` as `vi.fn(async () => true)` and building `twoMatches()`. **Prerequisite:** that task is not on `tournaments-t3a` yet (2026-10-07); if it still is not when this task starts, build it first from the T3a plan, then this task.
- Produces: the bracket and round cards show `Connect`, `Live` and `Confirming`; the desk's Reset room button on a match in `connect`, `live` or `confirming` asks "Reset the room? This cancels the match's server booking and aborts any game on it." before calling; the desk's Hold button is offered in those phases too.

- [ ] **Step 1: Write the failing tests**

In `web/src/routes/event/StagePlay.test.tsx`, add a card with `status: 'live', phase: 'live'` to the T3a link test and expect `within(link).getByText('Live')`.

In `web/src/routes/admin/events/PlayPanel.test.tsx`, add a match `m({ id: 9, slot: 3, a: team(5, 'Emus'), b: team(6, 'Foxes'), status: 'live', phase: 'live' })` to `twoMatches()` and (the file already mocks `confirm`; `import type { Mock } from 'vitest'`):

```tsx
  it('asks before resetting a room that holds a server (plan T3b)', async () => {
    mockAdmin.eventPlay.mockResolvedValue(twoMatches());
    mockAdmin.resetEventRoom.mockResolvedValue({});
    const ask = confirm as Mock;
    ask.mockResolvedValueOnce(false);
    render(<PlayPanel eventId={9} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset room: Emus vs Foxes' }));
    await waitFor(() => expect(ask).toHaveBeenCalledWith(expect.stringContaining('cancels the match\'s server booking')));
    expect(mockAdmin.resetEventRoom).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reset room: Emus vs Foxes' }));
    await waitFor(() => expect(mockAdmin.resetEventRoom).toHaveBeenCalledWith(9, 9));
    expect(screen.getByText('Live')).toBeTruthy();
  });
```

(`confirm` takes `ConfirmOptions | string`; if T3a's panel passes an options object, match on `expect.objectContaining({ message: expect.stringContaining(...) })` or whichever field carries the text.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run web/src/routes/event/StagePlay.test.tsx web/src/routes/admin/events/PlayPanel.test.tsx`
Expected: FAIL (the T3a wording is asked, not the booking one; the chip may already pass through `PHASE_TEXT`).

- [ ] **Step 3: Implement**

In `PlayPanel.tsx`: the phases that count as "holds a server" are `const BOOKED = new Set(['connect', 'live', 'confirming']);`. The Reset room handler becomes:

```tsx
  const resetRoom = async (m: PlayMatch) => {
    const text = BOOKED.has(m.phase)
      ? 'Reset the room? This cancels the match\'s server booking and aborts any game on it.'
      : 'Reset this match room? Ready, veto and lineups are cleared and the room opens again.';
    if (!(await confirm(text))) return;
    void act(() => adminApi.resetEventRoom(eventId, m.id));
  };
```

(using whatever the panel's action helper is called), and the set that offers Reset room and Hold (T3a: `ready`, `veto`, `lineup`, `server`, `hold`) gains `connect`, `live` and `confirming`; T3a's `OPEN` set of statuses where a first result may be entered gains `connect`, `live` and `confirming` too (play.ts `ROOM_OPEN` already allows it). The chips come from `PHASE_TEXT`, which Task 9 already extended, so `Bracket.tsx` needs no change.

In `app.css`, if the chip modifiers are per phase, add `.roomphase--connect`, `.roomphase--live`, `.roomphase--confirming` next to the T3a ones (Task 9 may already have).

- [ ] **Step 4: The whole-branch check**

Run, in order, and fix anything that fails before committing:

```bash
npm test
npm run typecheck
npm run build
grep -rnP '\x{2014}' src web/src plugin tests docs/superpowers/plans/2026-10-07-tournaments-3b-match-servers.md | head
git diff --stat master..HEAD
```

Expected: every test passes (the T3a and T2 suites included), both typechecks clean, a clean build, no em dash anywhere in the branch, and the diff touching only the files in the file map plus the tests.

Then read `git log --oneline master..HEAD`: ten commits, one per task, each a plain sentence. Do not push; do not deploy. Note for the owner in the hand-off: the plugin needs no change, so nothing is to be compiled or staged; production stays behind `competitive_enabled = 'admins'`; the first real series should be watched end to end on the local server with `rotoblin_cheats_4v4` before any event is announced (a two-team room, both lineups locked, the booking landing on `l4d1-ds`, the burst and the team lock placing the right four on survivors, a game end reaching `confirming`).

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/admin/events/PlayPanel.tsx web/src/routes/admin/events/PlayPanel.test.tsx web/src/routes/event/StagePlay.test.tsx web/src/routes/event/Bracket.tsx web/src/styles/app.css
git commit -m "Tournaments T3b: bracket and desk cards show connect, live and confirming, and the desk asks before resetting a room that holds a server"
```
