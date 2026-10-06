# Server priority plan: Match, then Scrim, then PUG, then practice

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The fleet's boxes go, in order, to a tournament match, then a scrim, then a PUG, then a practice lease or a queue side game. Nothing ever interrupts a PUG, a scrim or a tournament match being played; practice leases and side games are the one tier that can be taken back at any time, in use or not, by anything above them, with the 60 second in-game warning a practice lease gets today. Priority decides two things only: who gets the next free box, and whether a scrim that has not started gives way to a tournament match. A tournament match whose booking finds no idle box in its region, once practice leases and side games have nothing left to give back there, bumps the scrim that has not started and holds a box its campaign can load (latest start first, one at a time); a scrim past its start with no box while a tournament match waits for one is bumped at its start instead of waiting on for the `no_server` cancel. A bumped scrim is cancelled as `bumped`, a side of nobody (no late cancel, no no-show, nothing on either record), and both sides are told by DM with the nearest free slot of the same length and a link to the booking page, where they rebook or leave it. A new setting `scrim_max_servers` (Competitive group, default 2) caps how many scrims may overlap at any moment of a slot, on top of `pug_reserve_servers`, so tournament matches keep room of their own; the cap is a booking-time rule and never cuts a game. The Live board's Booked servers panel shows each booking's priority (Match or Scrim), the cap beside the PUG reserve, and a bumped scrim as such. PUG and scrim behaviour is otherwise unchanged; practice leases and side games are preempted exactly as today. Nothing is deployed by this plan; production stays behind `competitive_enabled = 'admins'`.

**Architecture:** No new table and no plugin change. `src/bookings/rules.ts` gains the purpose rank (`PURPOSE_RANK`, `byPriority`), the `scrimMax` limit, a `purpose` on `capacityProblem` (the scrim cap is a second ceiling checked at every start point, for scrims only), and `scrimsHolding` for the desk. `src/bookings/bookings.ts` gains the one new write, `bumpBooking` (the only module that writes the booking tables, as before), which closes an unstarted scrim with `end_reason = 'bumped'` and works out the nearest free slot through `src/scrims/rules.ts` `nearestFreeSlot` inside the same transaction. `src/bookings/runner.ts` orders its allocation queue by priority, and in `allocate` adds the two bump branches behind the existing "no free box, preempt" branch: practice and side games are asked to give a box back first (`deps.preempt`, as today), and only with none of those left in the region does a tournament match bump a held scrim (`bumpFor`, `bumpable`) or a scrim past its start give way to a waiting match (`tournamentsOwed`, `waitingTournament`); a bumped scrim's box goes back through the ordinary wind-down (goodbye, kick, release with restart), the releaser's `freed` runs `allocate` again, and the match takes the box because `claimIdle` keeps a box back for it (`bookingsDue`, unchanged). The DM is a new booking notice type, `booking_bumped` (`src/bookings/messages.ts`, `src/notify/notify.ts`). The desk route `src/routes/adminBookings.ts` adds `purpose` to each row and a `priority` block; `web/src/routes/admin/BookingsPanel.tsx` shows the chip and the line. `open_server_holds` and its ranks are untouched: between two bookings the runner's queue order decides, and the view only says who holds.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Fastify 5, better-sqlite3, vitest (`npm test`, `npx vitest run <file>`), `npm run typecheck` (server and web), `npm run build`; Preact + preact-iso + @testing-library/preact (happy-dom) for the web. No new dependencies. No SourcePawn.

**Spec:** The owner's direction of 2026-10-07 (binding): "server priority is Match (tournament) > Scrim (limited amount) > PUG > Practice ranges / side games. Nothing ever interrupts a game already being played (a live PUG included). Priority decides who gets the next free box and whether a scrim booking that has not started yet can be bumped by a tournament match (with notice to the scrim captains and an offer of another slot or a cancel). A setting caps how many boxes scrims may hold at once (so PUGs keep a floor); every number is a setting in the Competitive group." The owner's clarification of the same day (binding): practice ranges and side games may be interrupted at any time, including while in use, by anything above them (a tournament match, a scrim, a PUG); "nothing interrupts a game being played" applies to PUGs, scrims and tournament matches only. `docs/superpowers/specs/2026-09-30-competitive-foundation-design.md` section 3: "Capacity, not a box" (the reserve rule and "Staff can lower the reserve for a tournament night"), "Allocation and hand-over" ("A running PUG is never interrupted. If no box is free at T-15, the booking retries every minute and takes the first box released"; "Practice leases on the chosen box are warned and preempted exactly as ranked preemption works today"), "One holds module", "Lifecycle: Cancel" (capacity and any held box are released, the other side is told). Plan T4 Ruling 5 (`docs/superpowers/plans/2026-10-07-tournaments-4-windows.md`: scheduled tournament matches reserve capacity by counting, no booking row) and plan T3b Rulings 2 and 8 (the booking is made at lineup lock and starts now; with no idle box the match waits and staff are alerted after 10 minutes). Plan 2 of the scrim board (`src/scrims/rules.ts` `nearestFreeSlot`, Ruling 4 there: the nearest slot of the same length, searched in 30 minute steps out to 3 hours either side, later first). Nothing here reverses one of those.

**As built (checked against branch `tournaments-t4` at 080b2d79, 2026-10-07; this plan's snippets follow the code):** `src/serverHolds.ts` has `HoldKind`, `Hold`, `NOT_HELD_SQL` (`id NOT IN (SELECT server_id FROM open_server_holds)`), `holdFor`, `isHeld`, `ServerHolds`; `src/db.ts` `SERVER_HOLDS_VIEW` unions bookings (rank 0, `server_id IS NOT NULL AND ended_at IS NULL`), practice leases (1) and side games (2), and `tests/serverHoldGuard.test.ts` fails any statement filtering `status = 'idle'` without `${NOT_HELD_SQL}` (one allowance, `src/sideGames.ts` `takeForMatch`). `src/serverPool.ts` has `claimableServers` (idle, enabled, not held, pick order) and `claimIdle(db, nowMs, choose)`, which returns null when `free.length <= bookingsDue(db, nowMs, bookingLimits(db).protectMinutes)`. `src/bookings/rules.ts` has `BookingLimits { minMinutes, daysAhead, playlistMax, maxUpcoming, reserve, holdLeadMinutes, protectMinutes, idleEndMinutes, goneMinutes, recoverWaitMinutes }` from `bookingLimits` (`pug_reserve_servers` 2, `booking_hold_lead_minutes` 15, `booking_protect_minutes` 75), `OPEN_STATES_SQL`, `iso`, `capacityProblem(db, { region, startMs, endMs, exceptId })` (room = enabled servers in the region minus the reserve; `rows` of `{ s, e }` from open booking rows plus `scheduledMatchSlots`; the first start point where `running + 1 > room`), `scheduledMatchSlots`, `EVENT_SLOT_MINUTES`, `bookingsDue(db, nowMs, withinMinutes)` (confirmed bookings with no box starting within the window, running bookings waiting for a box after theirs went down, and scheduled matches). `capacityProblem` is called from `bookings.ts` `createBooking` (scrims only), `confirmBooking`, `addCampaign`, `src/scrims/scrims.ts` `createPost` and `src/scrims/rules.ts` `nearestFreeSlot(db, region, startMs, minutes, nowMs)`; `bookingsDue` from `claimIdle`, `sideGames.ts` `maybeOpen`, `practiceLeases.ts` `pickLeaseServer`, `needServer` and `finishPreempt`. `src/bookings/bookings.ts` has `BookingRow` (`purpose: 'scrim' | 'tournament'`, `region`, `starts_at`, `ends_at`, `state`, `server_id`, `ending_at`, `ended_at`, `end_reason`, `cancelled_by`, `cancel_side`, `cancel_reason`, `recovering_at`, `waiting_since`, ...), `BOOKING_ERRORS` (`not_found`, `wrong_state`, `no_capacity`, ...), `Result<T>`, `getBooking`, `sidesOf`, `sideName`, `acceptedPeople`, `isOpen` (open state and no end started), `openBookings` (every row with `ended_at IS NULL`, `ORDER BY starts_at, id`), the private `close(db, id, state, reason, now, extra)` (sets `ending_at`, and `ended_at` too when there is no box and no wait), the private `logEvent`, `createBooking` (scrim, checks `capacityProblem` with no purpose), `createTournamentBooking` (purpose tournament, `starts_at` now, both sides confirmed, no capacity check), `confirmBooking` and `addCampaign` (both re-check `capacityProblem` with `exceptId`), `cancelBooking`, `holdBox` (guarded by `NOT_HELD_SQL`), `markReleased`, `closeBooking`; `isLateCancel` (`rules.ts`) is true only for `end_reason 'cancelled'` with a `cancel_side`, and `shortSide` only for `ended` or `no_show`. `src/bookings/games.ts` exports `liveBookingGame(db, bookingId)`. `src/bookings/runner.ts` has `BookingRunnerDeps { db, rcon, publicUrl, release, releasing?, restart, notifier, preempt, freed?, logPublicAddress?, unregisterToken?, voice?, a2s?, tournament?, sleep?, now? }`, `END_SAY` (the goodbye per `end_reason`), `BookingRunner` with `allocate()` (runs `relocate()` first, then for each of `openBookings` that is `scheduled`, boxless, not ending, within the hold lead and confirmed: `pickBox`, `holdBox`, `track(setup)`; on failure `if (this.freeBoxes(b.region) === 0) preempt = true;` and the once-per-process "started ... and still has no server" admin line for non-tournament bookings; `if (preempt) this.deps.preempt()`), `freeBoxes(region)`, `pickBox(b)` (idle, enabled, in region, not held, highest id first, every playlist campaign `loadsOn` the box), `relocate()` (bookings with `waiting_since`, cancelled after `recoverWaitMinutes`), `setup`/`setupOnce`, `windDown(id, sayGoodbye)` (aborts live games, goodbye `[Booking] This booked server is closing: ${END_SAY[end_reason]}`, kick, `CLEAR_LINES`, `deps.release`, `markReleased`, `deps.freed`), `settle(id)` (idempotent: starts the wind-down of an ending booking), `tick()` (expire unconfirmed, `remind`, `relocate`, `allocate`, `closeServerless`, the minute `watch`, `returnGone`), `closeServerless` (a confirmed scrim with no box is cancelled `no_server` once its no-show grace after the start has passed; tournament bookings wait), `watch` (presence; `markActive` once anyone of either side is on a `ready` box), the private `tell(id, steamids, type, extra)`, `everyone(id)` (accepted people plus both sides' managers), `hook`, `giveUp`, `endNow`, `onCancelled`, `onExtended`, `onNoShow`; `src/server.ts` wires `preempt: () => { practiceLeases.needServer(); sideGamesRef?.needServer(); }`, `freed: () => holdFreed()` and `releaser.onFreed(() => bookingRunner.allocate())`. `src/practiceLeases.ts` `needServer` warns the newest active lease in game and ends it 60 s later unless no PUG and no booking waits; `src/sideGames.ts` `needServer` closes the active side game once no lease is left to preempt. `src/events/series.ts` `book(m, now)` makes the booking at lineup lock through `createTournamentBooking`; `tick` alerts staff once a match has waited `SERVER_ALERT_MS` (10 minutes) for a box; `ended(bookingId, reason)` holds the match when its booking winds down early. `src/bookings/messages.ts` has `whenUtc`, `BookingNotifyType` (seven types) and `bookingMessage(db, publicUrl, bookingId, type, extra)` with the `Open the booking` link; `src/notify/notify.ts` has `NotifyType` and `NOTIFY_TYPES` (`tests/notify.test.ts` checks `prefsOf` lists exactly them). `src/routes/adminBookings.ts` has `AdminBookingRow { id, state, ending, startsAt, endsAt, aName, bName, server, peak, endReason, toxic }` and `GET /api/admin/bookings` answering `{ bookings }`; `web/src/api.ts` mirrors `AdminBookingRow` and `adminApi.bookings`; `web/src/routes/admin/BookingsPanel.tsx` renders the table (`STATE_LABEL`, the `teamchip teamchip--toxic` chip) and returns null with no rows; `web/src/routes/admin/AdminLive.tsx` mounts it. Settings are seeded in `src/db.ts` `DEFAULT_SETTINGS` and described in `src/settingsSchema.ts` (`tests/adminSettings.test.ts`: every schema key has a seeded default). The runner's tests (`tests/bookingRunner.test.ts`) build a fake box per server (`a`, `bb`, `ccc`, ids 1 to 3, `pug_reserve_servers` 1), a `book()` helper (P[0] vs P[1], one campaign, a 90 minute slot from `START`), `preempts` counting `deps.preempt`, `released`, `dms`, and `runner.idle()` to await tracked work; `createTournamentBooking` is already imported there. Branch `server-priority` from 080b2d79; where this plan's snippets and the code disagree, the code wins.

## Global Constraints

- Nothing interrupts a PUG, a scrim or a tournament match being played: no code path in this plan touches a booking that is `active`, has a live booking game, or is in crash recovery, and no path touches a PUG. `bumpBooking` refuses those, and the runner's candidate query excludes them before asking. Practice leases and side games are outside that rule (Ruling 11): they are taken back while in use, as today.
- Every write to the booking tables stays in `src/bookings/bookings.ts`. The runner and the routes call it. No write to `event_matches`, `practice_leases` or `side_games` anywhere in this plan.
- Every statement that filters on `status = 'idle'` keeps `${NOT_HELD_SQL}` (`tests/serverHoldGuard.test.ts`); the new queries in the runner filter bookings and holds, never idle servers.
- `open_server_holds` and its ranks are not changed; `claimIdle`, `bookingsDue`, `practiceLeases.ts` and `sideGames.ts` are not changed.
- Every number is a setting in the Competitive group; this plan adds exactly one (`scrim_max_servers`), the others already exist (`pug_reserve_servers`, `booking_hold_lead_minutes`, `booking_protect_minutes`, `booking_recover_wait_minutes`).
- Times are stored as `Date#toISOString()` UTC strings and compare as text; DMs show UTC through `whenUtc` as the other booking DMs do.
- Never write em dashes in code, comments, copy, commits or docs.
- Commit messages follow the repo style (a plain sentence). Do not push. Do not deploy. No live server is touched.
- Several Claude sessions use `/home/volence/l4d/pug`: work in a worktree of your own on branch `server-priority` from `tournaments-t4` at 080b2d79 (`git worktree add .claude/worktrees/server-priority -b server-priority 080b2d79`). Run `npm ci` inside the worktree (never symlink `node_modules`). Check `git reflog -10` and `git status` before any write on master.

## Rulings this plan makes (for the owner to confirm)

1. **Scope.** The priority order among bookings, the bump of an unstarted scrim by a tournament match (two cases: a scrim holding a box, and a scrim past its start with no box while a match waits for one), the scrim cap at booking time, the DM with the nearest slot, the desk chip and line. Not: a change to how PUGs, practice leases or side games get boxes (`bookingsDue` already puts every confirmed booking ahead of a new PUG, and `deps.preempt` already takes practice and side games back).
2. **What priority decides, and where.** A rank per purpose in `src/bookings/rules.ts` (`PURPOSE_RANK`: tournament 0, scrim 1) and `byPriority` (rank, then the earlier start, then the older row). The runner's `allocate` and `relocate` walk `openBookings` in that order, so when one box frees up a waiting tournament match takes it before a waiting scrim, however long the scrim has waited. PUGs versus bookings and practice versus everything are unchanged. `open_server_holds` keeps rank 0 for every booking: the view says who holds a box, not who should get the next one, and `holdFor` never needs to choose between two bookings on one box.
3. **The scrim cap is a booking-time rule.** `scrim_max_servers` (integer 0 to 10, seeded 2) is a second ceiling in `capacityProblem` for scrims only: at the new slot's start and every other start inside it, the scrims already running there plus this one must stay at or under the cap, after the reserve rule (enabled minus every booking and scheduled match, at or above `pug_reserve_servers`). It applies wherever a scrim slot is accepted: `createBooking`, `confirmBooking`, `addCampaign` (+1 campaign on a scrim), `createPost` and `nearestFreeSlot`. Tournament bookings and scheduled matches count toward the room but are never capped by it (`purpose: 'tournament'` skips the cap), and `confirmBooking` and `addCampaign` pass the booking's own purpose so a staff +1 on a tournament booking is never refused by the scrim cap. The cap is not re-checked at allocation: what is booked holds, lowering it refuses new scrims and leaves booked ones alone (as `team_membership_cap` does), and a scrim whose last game runs past its slot is a game being played. 0 stops new scrim bookings (a tournament night); with the default reserve of 2 and 6 pool boxes, room is 4 and scrims take at most 2 of it.
4. **The bump of a held scrim.** In `allocate`, a tournament booking that gets no box and whose region has no free box at all (`freeBoxes === 0`, so an idle box that cannot load the campaign is never a reason to bump) first asks practice leases and side games to give one back exactly as today (`preempt`), and bumps a scrim only when the region has no practice lease or side game left to take (`preemptable`: no `open_server_holds` row of kind practice or side on an enabled box in the region). The victim is the open scrim in the region that holds a box (`held`, `setup` or `ready`), is not `active`, has no live game, is not in crash recovery, and whose box can load the match's campaign; the latest start first, then the newest row, so the scrim with the most time to rebook gives way. One at a time: while a bumped scrim's box is still winding down in the region (`end_reason 'bumped'`, box still held) no second scrim is bumped for the same waiting match (`tournamentsOwed` = waiting tournament bookings minus boxes already coming back). The bumped box takes the normal wind-down (goodbye, kick, cvars cleared, release with a forced restart); `freed` runs `allocate` again and the match takes it, since `claimIdle` keeps one box back for the boxless match (`bookingsDue`). A tournament booking with nothing to bump waits as today and the series engine alerts staff after 10 minutes (T3b Ruling 8).
5. **What happens to the bumped scrim.** `bumpBooking` closes it as `cancelled` with `end_reason 'bumped'`, `cancelled_by` and `cancel_side` null: never a late cancel (`isLateCancel` needs `end_reason 'cancelled'`), never a no-show or a short side (those need `ended` or `no_show`), nothing on either record, the allowance freed. In the same transaction, once the row no longer counts, the nearest free slot of the same length is worked out with `nearestFreeSlot` (same region, 30 minute steps, up to 3 hours either side of the scrim's start, later first, never in the past) and written into `cancel_reason` ("A tournament match needed the server. The nearest free slot is 2026-10-02 21:30 UTC."), so the booking page shows it with no web change. Both sides' accepted people and managers get the `booking_bumped` DM with the same slot and the Open the booking link. Rebooking is the ordinary flow: a scrim born from a post has Book again on its page (plan 2 Ruling 4), a direct booking is made again from the booking form; this plan adds no one-click rebook, because the offered slot is advice (capacity moves) and the form re-checks it.
6. **A scrim past its start with no box.** Today it waits for the no-show grace after its start and is cancelled `no_server`. Now, when a tournament booking in its region is waiting for a box (scheduled, no box, not ending) and nothing is left to preempt, the scrim is bumped at its start instead (not at its hold time: the 15 minutes before the start are its chance of a PUG ending), one scrim per waiting match in the pass (the earliest start first, the queue order), with the same close, reason and DM. A tournament match that already holds a box is not waiting, so a scrim short of a box beside it keeps the old `no_server` path: that shortage is PUGs, not the match.
7. **Who is told, and how.** The scrim's people: `booking_bumped`, an opt-out notice type like the others ("A scrim I am in is bumped by a tournament match, with the nearest free slot"). The admin feed: one `problem` line naming the scrim, its start, the match's booking id, whether its box is going back to the pool or it never had one, and the offered slot. In game, the goodbye on the bumped box: "This booked server is closing: a tournament match needs it." (`END_SAY.bumped`). The tournament's people hear nothing extra: their connect DM comes when the box is ready, as always.
8. **Audit.** `booking_events` gets one `bumped` row `{ byBookingId, nearestSlot }` on the scrim, written by `bumpBooking`; no `admin_actions` row (no admin acted).
9. **The desk.** `GET /api/admin/bookings` answers `{ bookings, priority: { scrimMax, scrimsHolding, pugReserve } }` and each row carries `purpose`. The Booked servers panel shows a Match or Scrim chip before the names, a line under the heading ("Priority: Match, then Scrim, then PUG, then practice and side games. Scrims hold 1 of 2 servers they may hold at once; 2 always left for PUGs. A match with no free server bumps a scrim that has not started."), and a bumped row's state as "cancelled (bumped by a match)". The Live board's server table and the booking page are unchanged.
10. **Regions.** Every rule is per region as the capacity rules already are (the match's region for the bump, the scrim's for the cap); the cap setting itself is one number for all regions.
11. **Practice leases and side games give way at any time, in use or not (owner ruling, 2026-10-07 clarification).** This is what the code does today and this plan keeps it exactly: a practice lease is taken back through `practiceLeases.needServer` (the newest active lease is warned in game, "A ranked match or a booked server needs this box in 60 seconds. Those always come first.", and ended `preempted` 60 seconds later unless by then no PUG and no booking waits, whoever is on it), a side game through `sideGames.needServer` (closed `preempted` at once, once no practice lease is left to take), and both are asked by a PUG with no box (`orchestrator` `onNoServer`) and by any booking at its hold time with no free box in its region (`BookingRunnerDeps.preempt`, tournament or scrim alike). `claimIdle`, `pickLeaseServer` and `maybeOpen` already keep boxes back for bookings due, so a lease or side game is not even started where a booking will need the box. The only new thing is the runner's `preemptable(region)`: before any scrim gives way to a tournament match, the runner checks that this tier has nothing left to give in the region, so a practice lease or side game, in use or not, always goes first (Task 3's second test). Nothing in this plan adds a check on whether a lease or side game is in use.

## Not in this plan (and why)

- **The cap at allocation time.** Ruling 3: what is booked holds. If staff want fewer scrim boxes tonight they lower the cap ahead of the bookings, or cancel from the desk (a staff cancel counts against nobody).
- **A warning on the Events desk when staff set a match time over booked scrims.** T4 keeps capacity for scheduled matches by counting; a scrim booked before the time was set is bumped only if the match actually finds no box at its lineup lock, which is the honest moment. A desk preview of "this time would bump N scrims" is a follow-up.
- **Bumping an active scrim, or any PUG, for a tournament match.** The owner's rule; the match waits and staff are alerted.
- **A one-click rebook from the DM.** Ruling 5.
- **Reordering PUGs against scrims beyond today's `bookingsDue`.** A PUG already yields the last idle box to a booking due within `booking_protect_minutes`; the owner's order between PUG and scrim is already the behaviour.
- **Changes to `open_server_holds` ranks or `holdFor`.** Ruling 2.
- **Discord channel posts.** DMs only, as every booking notice.

## Review Focus

- **A game being played is never cut.** `bumpable` filters out `active`, a live game and crash recovery in SQL and in code; `bumpBooking` refuses the same (`wrong_state`). Task 3 tests an active scrim and Task 2 tests the refusals.
- **No cascade.** While a bumped box winds down, `tournamentsOwed` counts it as coming and a second `allocate` bumps nothing more for the same match; two matches waiting may bump two scrims. Task 3 tests one match with two held scrims across two synchronous `allocate` calls.
- **Practice and side games go first.** `preemptable` is checked before any bump, and a side game hold in the region leaves every scrim alone. Task 3 tests it.
- **The scrim at its start is bumped only for a match that is waiting.** A match holding a box owes nothing; Task 4 tests both.
- **The cap arithmetic.** Both ceilings are checked at every start point, the cap only for a scrim, scheduled matches never count as scrims, `exceptId` still excludes the booking itself. Task 1 tests the busiest moment and both purposes.
- **The hold guard.** None of the new SQL filters idle servers without `${NOT_HELD_SQL}`; `tests/serverHoldGuard.test.ts` stays green.
- **The DM goes to the scrim's people only, and says the slot.** Task 3's first test checks the recipients (`d0`, `d1`) and the slot text.

---

## File map

| File | Responsibility |
|---|---|
| `src/db.ts` | `scrim_max_servers` seeded default. |
| `src/settingsSchema.ts` | `scrim_max_servers` in the Competitive group. |
| `src/bookings/rules.ts` | `BookingPurpose`, `PURPOSE_RANK`, `byPriority`, `BookingLimits.scrimMax`, `capacityProblem` with `purpose` and the cap, `scrimsHolding`. |
| `src/bookings/bookings.ts` | `confirmBooking` and `addCampaign` pass the purpose; `bumpReason`, `bumpBooking`. |
| `src/bookings/messages.ts`, `src/notify/notify.ts` | The `booking_bumped` notice. |
| `src/bookings/runner.ts` | `END_SAY.bumped`; `queue`, `fits`, `preemptable`, `tournamentsOwed`, `waitingTournament`, `bumpable`, `bumpFor`, `bump`; `allocate` and `relocate` by priority. |
| `src/serverHolds.ts` | A comment: the view's ranks never choose between two bookings. |
| `src/routes/adminBookings.ts` | `AdminBookingRow.purpose`, `AdminBookingPriority`, the `priority` block. |
| `web/src/api.ts`, `web/src/routes/admin/BookingsPanel.tsx`, `web/src/styles/app.css` | The chip, the line, the bumped state. |
| `tests/bookingRules.test.ts`, `tests/bookings.test.ts`, `tests/notify.test.ts`, `tests/bookingRunner.test.ts`, `tests/bookingRoutes.test.ts`, `web/src/routes/admin/BookingsPanel.test.tsx` | The tests of each task. |

---
### Task 1: The setting, the priority order and the scrim cap in the capacity rule

**Files:**
- Modify: `src/db.ts`, `src/settingsSchema.ts`, `src/bookings/rules.ts`, `src/bookings/bookings.ts` (two call sites)
- Test: `tests/bookingRules.test.ts`, `tests/adminSettings.test.ts` (parity, no edit)

**Interfaces:**
- Consumes: `settingNumber` (`src/settings.ts`); `OPEN_STATES_SQL`, `scheduledMatchSlots`, `iso`, `bookingLimits` (`rules.ts`); `BookingRow` (type, `bookings.ts`).
- Produces:
  - Setting `scrim_max_servers` (`'2'`, int 0 to 10), seeded and in the schema's Competitive group.
  - `rules.ts`: `type BookingPurpose = 'scrim' | 'tournament'`; `PURPOSE_RANK: Record<BookingPurpose, number>`; `byPriority(a: Pick<BookingRow, 'purpose' | 'starts_at' | 'id'>, b: Pick<BookingRow, 'purpose' | 'starts_at' | 'id'>): number`; `BookingLimits.scrimMax: number`; `capacityProblem(db, o: { region: string; startMs: number; endMs: number; exceptId?: number; purpose?: BookingPurpose }): number | null` (purpose defaults to `'scrim'`); `scrimsHolding(db: DB, region?: string | null): number`.

- [ ] **Step 1: Write the failing tests**

In `tests/bookingRules.test.ts`, extend the import to

```ts
import {
  addCampaignMinutes, allowance, bookingLimits, bookingsDue, byPriority, capacityProblem, estimateMinutes, playlistMinutes, recentNoShows,
  scrimsHolding, typicalCampaignMinutes, upcomingCount, DEFAULT_CAMPAIGN_MINUTES, scheduledMatchSlots, EVENT_SLOT_MINUTES,
} from '../src/bookings/rules.js';
```

replace the `book` helper with one that takes a purpose:

```ts
const book = (startMs: number, endMs: number, o: { state?: string; captain?: string; teamId?: number | null; bConfirmed?: boolean; serverId?: number | null; purpose?: 'scrim' | 'tournament' } = {}) => {
  const id = Number(db.prepare(
    `INSERT INTO bookings (purpose, starts_at, ends_at, state, server_id, password, tv_password, game_config, rules_json, playlist_json, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'p', 't', 'standard', '{}', '[]', ?, 'x')`,
  ).run(o.purpose ?? 'scrim', new Date(startMs).toISOString(), new Date(endMs).toISOString(), o.state ?? 'scheduled', o.serverId ?? null, o.captain ?? A).lastInsertRowid);
  db.prepare("INSERT INTO booking_sides (booking_id, side, team_id, captain_steamid, confirmed_at) VALUES (?, 'a', ?, ?, 'x')")
    .run(id, o.teamId ?? null, o.captain ?? A);
  db.prepare("INSERT INTO booking_sides (booking_id, side, captain_steamid, confirmed_at) VALUES (?, 'b', ?, ?)")
    .run(id, B, o.bConfirmed === false ? null : 'x');
  return id;
};
const setReserve = (n: number) => db.prepare("UPDATE settings SET value = ? WHERE key = 'pug_reserve_servers'").run(String(n));
const setScrimMax = (n: number) => db.prepare("UPDATE settings SET value = ? WHERE key = 'scrim_max_servers'").run(String(n));
```

and append inside `describe('capacity')`:

```ts
  it('caps the scrims that overlap at scrim_max_servers; a tournament booking or a scheduled match is never capped by it (server priority Ruling 3)', () => {
    servers(6); // reserve 2: room for 4 bookings at once
    setScrimMax(2);
    book(T0, T0 + H);
    book(T0 + H / 2, T0 + 2 * H);
    // A third scrim over the two is refused at the first moment both run, not at its start.
    expect(capacityProblem(db, { region: 'na', startMs: T0, endMs: T0 + H })).toBe(T0 + H / 2);
    expect(capacityProblem(db, { region: 'na', startMs: T0, endMs: T0 + H, purpose: 'scrim' })).toBe(T0 + H / 2);
    // Tournament bookings count toward the room but not toward the scrim cap, in either direction.
    expect(capacityProblem(db, { region: 'na', startMs: T0, endMs: T0 + H, purpose: 'tournament' })).toBeNull();
    book(T0, T0 + H, { purpose: 'tournament' });
    book(T0, T0 + H, { purpose: 'tournament' });
    // Room is 4 and four bookings run at 20:30: full for anyone.
    expect(capacityProblem(db, { region: 'na', startMs: T0, endMs: T0 + H, purpose: 'tournament' })).toBe(T0 + H / 2);
    // From 21:00 only the second scrim runs: one more scrim fits.
    expect(capacityProblem(db, { region: 'na', startMs: T0 + H, endMs: T0 + 2 * H })).toBeNull();
    setScrimMax(0);
    expect(capacityProblem(db, { region: 'na', startMs: T0 + 3 * H, endMs: T0 + 4 * H })).toBe(T0 + 3 * H);
    expect(capacityProblem(db, { region: 'na', startMs: T0 + 3 * H, endMs: T0 + 4 * H, purpose: 'tournament' })).toBeNull();
  });

  it('the booking itself and scheduled tournament matches never count as scrims toward the cap', () => {
    servers(6);
    setScrimMax(1);
    const mine = book(T0, T0 + H);
    expect(capacityProblem(db, { region: 'na', startMs: T0, endMs: T0 + H, exceptId: mine })).toBeNull();
    expect(capacityProblem(db, { region: 'na', startMs: T0, endMs: T0 + H })).toBe(T0);
    db.prepare("UPDATE bookings SET ending_at = 'x' WHERE id = ?").run(mine);
    expect(capacityProblem(db, { region: 'na', startMs: T0, endMs: T0 + H })).toBeNull();
  });
```

(The scheduled-match half of the second test is covered by the existing T4 test, which books a scrim beside a scheduled match with room to spare and expects null; it must still pass with the cap at its default of 2.)

Append at the end of the file:

```ts
describe('server priority', () => {
  it('orders a tournament match before a scrim, then the earlier start, then the older row (Ruling 2)', () => {
    const row = (purpose: 'scrim' | 'tournament', starts_at: string, id: number) => ({ purpose, starts_at, id });
    const rows = [
      row('scrim', '2026-10-02T20:00:00.000Z', 1), row('tournament', '2026-10-02T20:30:00.000Z', 2), row('scrim', '2026-10-02T19:00:00.000Z', 3),
      row('tournament', '2026-10-02T20:30:00.000Z', 4), row('scrim', '2026-10-02T19:00:00.000Z', 5),
    ];
    expect([...rows].sort(byPriority).map((r) => r.id)).toEqual([2, 4, 3, 5, 1]);
  });

  it('reads scrim_max_servers (default 2) into the limits', () => {
    expect(db.prepare("SELECT value FROM settings WHERE key = 'scrim_max_servers'").get()).toEqual({ value: '2' });
    expect(bookingLimits(db).scrimMax).toBe(2);
    setScrimMax(5);
    expect(bookingLimits(db).scrimMax).toBe(5);
  });

  it('counts the boxes scrims hold right now; tournaments and released ones are left out, and a region can be asked for', () => {
    servers(3);
    book(T0, T0 + H, { serverId: 1, state: 'ready' });
    book(T0, T0 + H, { serverId: 2, state: 'active', purpose: 'tournament' });
    const gone = book(T0, T0 + H, { serverId: 3, state: 'ended' });
    expect(scrimsHolding(db)).toBe(2);
    db.prepare("UPDATE bookings SET ending_at = 'x', ended_at = 'x' WHERE id = ?").run(gone);
    expect(scrimsHolding(db)).toBe(1);
    expect(scrimsHolding(db, 'na')).toBe(1);
    expect(scrimsHolding(db, 'eu')).toBe(0);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/bookingRules.test.ts`
Expected: FAIL (`byPriority` and `scrimsHolding` undefined, the setting unseeded, `purpose` ignored by `capacityProblem`).

- [ ] **Step 3: db.ts and settingsSchema.ts**

In `src/db.ts` `DEFAULT_SETTINGS`, after `booking_recover_wait_minutes: '20',`:

```ts
  // Server priority (owner, 2026-10-07): how many scrims may overlap at any
  // moment, so tournament matches keep room beside the PUG reserve.
  scrim_max_servers: '2',
```

In `src/settingsSchema.ts`, after the `pug_reserve_servers` row:

```ts
  { key: 'scrim_max_servers', group: 'Competitive', label: 'Servers scrims may hold at once', help: 'A scrim is booked only if, for its whole slot, fewer than this many scrims already overlap it in its region, on top of the servers always left for PUGs, so tournament matches keep room of their own. Tournament matches are never limited by it. Lowering it refuses new scrims; scrims already booked keep their slot, and a game being played is never cut. 0 stops new scrim bookings, for a tournament night.', type: { kind: 'int', min: 0, max: 10 } },
```

- [ ] **Step 4: rules.ts**

After `BookingState` add:

```ts
export type BookingPurpose = 'scrim' | 'tournament';

/** Who gets the next free box among bookings (server priority, Ruling 2):
 *  a tournament match before a scrim, then the earlier start, then the
 *  older row. The runner walks its queue in this order; the holds view
 *  (src/serverHolds.ts) keeps one rank for every booking. */
export const PURPOSE_RANK: Record<BookingPurpose, number> = { tournament: 0, scrim: 1 };

export function byPriority(a: Pick<BookingRow, 'purpose' | 'starts_at' | 'id'>, b: Pick<BookingRow, 'purpose' | 'starts_at' | 'id'>): number {
  return PURPOSE_RANK[a.purpose] - PURPOSE_RANK[b.purpose]
    || (a.starts_at < b.starts_at ? -1 : a.starts_at > b.starts_at ? 1 : 0)
    || a.id - b.id;
}
```

In `BookingLimits` add `scrimMax: number;` after `reserve: number;`, and in `bookingLimits` after `reserve: n('pug_reserve_servers', 2, 0, 10),`:

```ts
    scrimMax: n('scrim_max_servers', 2, 0, 10),
```

Replace `capacityProblem` with:

```ts
/**
 * The capacity rule: at every moment of [startMs, endMs), enabled servers in
 * the region minus overlapping bookings stays at or above pug_reserve_servers,
 * and for a scrim (the default purpose) the scrims running at once stay at or
 * under scrim_max_servers (server priority, Ruling 3). Null when the new
 * booking fits; otherwise the first moment it would not.
 *
 * Overlap is half-open, so back-to-back bookings never overlap. The number of
 * bookings running at once only rises at a booking's start, so checking the
 * new booking's own start and every other start inside it is enough. A
 * tournament booking and a scheduled match count toward the room but never
 * toward the scrim cap.
 */
export function capacityProblem(db: DB, o: { region: string; startMs: number; endMs: number; exceptId?: number; purpose?: BookingPurpose }): number | null {
  const limits = bookingLimits(db);
  const room = enabledServers(db, o.region) - limits.reserve;
  if (room < 1) return o.startMs;
  const scrim = (o.purpose ?? 'scrim') === 'scrim';
  if (scrim && limits.scrimMax < 1) return o.startMs;
  const rows = [
    ...(db.prepare(
      `SELECT starts_at, ends_at, purpose FROM bookings
        WHERE region = ? AND state IN ${OPEN_STATES_SQL} AND ending_at IS NULL AND id != ?
          AND starts_at < ? AND ends_at > ?`,
    ).all(o.region, o.exceptId ?? 0, iso(o.endMs), iso(o.startMs)) as { starts_at: string; ends_at: string; purpose: BookingPurpose }[])
      .map((r) => ({ s: Date.parse(r.starts_at), e: Date.parse(r.ends_at), scrim: r.purpose === 'scrim' })),
    // Plan T4 Ruling 5: a scheduled tournament match holds a box before it is booked.
    ...scheduledMatchSlots(db, o.region, o.startMs, o.endMs).map((r) => ({ ...r, scrim: false })),
  ];
  const points = [o.startMs, ...rows.map((r) => r.s).filter((s) => s > o.startMs)].sort((x, y) => x - y);
  for (const t of points) {
    const running = rows.filter((r) => r.s <= t && r.e > t);
    if (running.length + 1 > room) return t;
    if (scrim && running.filter((r) => r.scrim).length + 1 > limits.scrimMax) return t;
  }
  return null;
}

/** Boxes scrims hold right now, from the hold to the end of the wind-down
 *  (the Live board's "N of max", Ruling 9). With a region, that region only. */
export function scrimsHolding(db: DB, region: string | null = null): number {
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM bookings WHERE purpose = 'scrim' AND server_id IS NOT NULL AND ended_at IS NULL AND (? IS NULL OR region = ?)",
  ).get(region, region) as { n: number }).n;
}
```

- [ ] **Step 5: The two call sites in bookings.ts**

In `confirmBooking`, the capacity check becomes

```ts
    if (capacityProblem(db, { region: b.region, startMs: Date.parse(b.starts_at), endMs: Date.parse(b.ends_at), exceptId: b.id, purpose: b.purpose }) !== null) {
```

and in `addCampaign`

```ts
    if (capacityProblem(db, { region: b.region, startMs: from, endMs: from + minutes * 60_000, exceptId: b.id, purpose: b.purpose }) !== null) {
```

(`createBooking`, `createPost` and `nearestFreeSlot` are scrims and keep the default.)

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/bookingRules.test.ts tests/bookings.test.ts tests/scrims.test.ts tests/scrimRules.test.ts tests/adminSettings.test.ts && npm run typecheck`
Expected: PASS; both typechecks clean.

- [ ] **Step 7: Commit**

```bash
git add src/db.ts src/settingsSchema.ts src/bookings/rules.ts src/bookings/bookings.ts tests/bookingRules.test.ts
git commit -m "Server priority: the scrim_max_servers setting, the purpose rank and queue order, and the scrim cap as a second ceiling in the capacity rule"
```

---
### Task 2: The bump write and its notice

**Files:**
- Modify: `src/bookings/bookings.ts`, `src/bookings/messages.ts`, `src/notify/notify.ts`
- Test: `tests/bookings.test.ts`, `tests/notify.test.ts`

**Interfaces:**
- Consumes: `getBooking`, `isOpen`, `close`, `logEvent` (`bookings.ts`); `liveBookingGame` (`games.ts`); `nearestFreeSlot` (`src/scrims/rules.ts`, which imports nothing from `bookings.ts`, so no cycle); `whenUtc`, `escapeName` (`messages.ts`).
- Produces:
  - `bookings.ts`: `bumpReason(nearestSlot: string | null): string`; `bumpBooking(db, o: { bookingId: number; byBookingId: number; now?: Date }): Result<{ hadServer: boolean; nearestSlot: string | null }>` (refuses `not_found`, and `wrong_state` for a tournament booking, a booking that is not open, one that is `active`, has a live game or is in crash recovery).
  - `messages.ts`: `BookingNotifyType` gains `'booking_bumped'`; `bookingMessage` `extra` gains `slot?: string | null`.
  - `notify.ts`: `NotifyType` and `NOTIFY_TYPES` gain `booking_bumped`.

- [ ] **Step 1: Write the failing tests**

In `tests/bookings.test.ts`, extend the booking import with `bumpBooking, bumpReason, createTournamentBooking`, add `import { isLateCancel } from '../src/bookings/rules.js';` and `import { bookingMessage } from '../src/bookings/messages.js';`, and append at the end of the file:

```ts
describe('bumped by a tournament match (server priority Rulings 5 and 7)', () => {
  const tournament = (now: Date) => {
    const r = createTournamentBooking(db, {
      region: 'na', campaign: 'no_mercy', rulesJson: '{}', rulesetId: null, gameConfig: 'standard', createdBy: P[13],
      sides: [{ teamId: null, captain: P[4], players: P.slice(4, 8), spectators: [] }, { teamId: null, captain: P[8], players: P.slice(8, 12), spectators: [] }], now,
    });
    if (!r.ok) throw new Error(r.error);
    return r.value.id;
  };

  it('closes an unstarted scrim as bumped, a side of nobody, with the nearest free slot in its reason and its event', () => {
    setSetting(db, 'pug_reserve_servers', '3'); // 4 boxes: room for 1 booking at a time
    const id = create();
    confirmBooking(db, { bookingId: id, by: P[1], now: NOW });
    const now = at(START, -10);
    const match = tournament(now); // 19:50 to 21:20
    const r = bumpBooking(db, { bookingId: id, byBookingId: match, now });
    // The scrim's own 3 hour slot overlaps the match at 20:00, 20:30 and 21:00 and fits from 21:30.
    expect(r).toEqual({ ok: true, value: { hadServer: false, nearestSlot: at(START, 90).toISOString() } });
    const b = getBooking(db, id)!;
    expect(b).toMatchObject({ state: 'cancelled', end_reason: 'bumped', cancel_side: null, cancelled_by: null, ending_at: now.toISOString(), ended_at: now.toISOString() });
    expect(b.cancel_reason).toBe('A tournament match needed the server. The nearest free slot is 2026-10-02 21:30 UTC.');
    expect(bumpReason(null)).toBe('A tournament match needed the server. No other slot is free within 3 hours of the start.');
    expect(isLateCancel(db, b)).toBe(false);
    expect(db.prepare("SELECT detail FROM booking_events WHERE booking_id = ? AND event = 'bumped'").get(id))
      .toEqual({ detail: JSON.stringify({ byBookingId: match, nearestSlot: at(START, 90).toISOString() }) });
    const v = bookingView(db, id, { steamid: P[0], staff: false }, now.getTime())!;
    expect(v.cancel).toEqual({ side: null, reason: b.cancel_reason });
    expect(v.sides.every((s) => !s.lateCancel)).toBe(true);
    expect(bumpBooking(db, { bookingId: id, byBookingId: match, now })).toEqual({ ok: false, error: 'wrong_state' });
  });

  it('keeps the box for the runner to give back, and refuses a tournament booking, an active scrim or a live game', () => {
    const id = create();
    confirmBooking(db, { bookingId: id, by: P[1], now: NOW });
    expect(holdBox(db, id, servers[0]!, at(START, -15))).toBe(true);
    const match = tournament(at(START, -14));
    expect(bumpBooking(db, { bookingId: match, byBookingId: id, now: at(START, -14) })).toEqual({ ok: false, error: 'wrong_state' });
    const r = bumpBooking(db, { bookingId: id, byBookingId: match, now: at(START, -14) });
    expect(r.ok && r.value.hadServer).toBe(true);
    expect(getBooking(db, id)).toMatchObject({ state: 'cancelled', end_reason: 'bumped', server_id: servers[0], ended_at: null });
    const active = create({ startsAt: at(START, 240).toISOString() });
    confirmBooking(db, { bookingId: active, by: P[1], now: NOW });
    db.prepare("UPDATE bookings SET state = 'active', server_id = ? WHERE id = ?").run(servers[1], active);
    expect(bumpBooking(db, { bookingId: active, byBookingId: match, now: at(START, 240) })).toEqual({ ok: false, error: 'wrong_state' });
    expect(bumpBooking(db, { bookingId: 999, byBookingId: match })).toEqual({ ok: false, error: 'not_found' });
  });

  it('the DM names both sides, the slot and the booking page', () => {
    const id = create();
    const m = bookingMessage(db, 'https://riversidepug.com', id, 'booking_bumped', { slot: at(START, 90).toISOString() })!;
    expect(m.content).toBe("**p0's group** vs **p1's group** on 2026-10-02 20:00 UTC was bumped: a tournament match needed the server. The nearest free slot is 2026-10-02 21:30 UTC: book it again from the booking page, or leave it. It counts against neither side.");
    expect(m.components).toEqual([[{ kind: 'link', url: `https://riversidepug.com/booking/${id}`, label: 'Open the booking' }]]);
    expect(bookingMessage(db, 'https://riversidepug.com', id, 'booking_bumped', { slot: null })!.content).toContain('No other slot is free within 3 hours of the start: book another time from the booking page, or leave it.');
  });
});
```

(`BookingSideView.lateCancel` is the field `bookingView` fills from `isLateCancel`; if its name differs in the code, use the code's name. `tests/bookings.test.ts` imports `setSetting` already.)

In `tests/notify.test.ts`, inside the first `describe`, add:

```ts
  it('lists the bump notice (server priority Ruling 7)', () => {
    expect(NOTIFY_TYPES.find((t) => t.type === 'booking_bumped')).toEqual({ type: 'booking_bumped', label: 'A scrim I am in is bumped by a tournament match, with the nearest free slot' });
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/bookings.test.ts tests/notify.test.ts`
Expected: FAIL (`bumpBooking` undefined; the notice type unknown).

- [ ] **Step 3: bookings.ts**

Extend the imports: `import { bookingGames, gamesPlayed, liveBookingGame, type BookingGameView } from './games.js';` and add `import { nearestFreeSlot } from '../scrims/rules.js';`. After `cancelBooking` add:

```ts
/** The reason a bumped scrim carries on its page (Ruling 5); the DM says
 *  the same. The time is written as whenUtc does (src/bookings/messages.ts
 *  imports this module, so the format is repeated rather than imported). */
export function bumpReason(nearestSlot: string | null): string {
  const slot = nearestSlot
    ? `The nearest free slot is ${nearestSlot.slice(0, 10)} ${nearestSlot.slice(11, 16)} UTC.`
    : 'No other slot is free within 3 hours of the start.';
  return `A tournament match needed the server. ${slot}`;
}

/**
 * A scrim bumped by a tournament match (server priority, Rulings 4 to 6):
 * closed as cancelled with end_reason 'bumped' and a side of nobody, so it is
 * never a late cancel, a no-show or a short side and nothing lands on either
 * record. Once the row no longer counts, the nearest free slot of the same
 * length (src/scrims/rules.ts) is worked out for the reason, the event and
 * the DM. Only an open scrim that has not started: never a tournament
 * booking, never one that is active, has a live game or is in crash
 * recovery. The runner winds the box down and tells both sides.
 */
export function bumpBooking(db: DB, o: { bookingId: number; byBookingId: number; now?: Date }): Result<{ hadServer: boolean; nearestSlot: string | null }> {
  const now = o.now ?? new Date();
  return db.transaction((): Result<{ hadServer: boolean; nearestSlot: string | null }> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    if (b.purpose !== 'scrim' || !isOpen(b) || b.state === 'active' || b.recovering_at !== null || liveBookingGame(db, b.id)) return fail('wrong_state');
    if (!close(db, b.id, 'cancelled', 'bumped', now)) return fail('wrong_state');
    const minutes = Math.round((Date.parse(b.ends_at) - Date.parse(b.starts_at)) / 60_000);
    const nearestSlot = nearestFreeSlot(db, b.region, Date.parse(b.starts_at), minutes, now.getTime());
    db.prepare('UPDATE bookings SET cancel_reason = ? WHERE id = ?').run(bumpReason(nearestSlot), b.id);
    logEvent(db, b.id, null, 'bumped', { byBookingId: o.byBookingId, nearestSlot }, now);
    return ok({ hadServer: b.server_id !== null, nearestSlot });
  })();
}
```

- [ ] **Step 4: messages.ts and notify.ts**

In `src/bookings/messages.ts`, the type becomes

```ts
/** The booking notice types this module knows how to word. Narrower than
 *  the full NotifyType (which also carries the scrim board's types, worded
 *  elsewhere) so the switch below stays exhaustive as NotifyType grows. */
export type BookingNotifyType =
  'booking_invite' | 'booking_confirmed' | 'booking_starting' | 'booking_ready' | 'booking_recovered' | 'booking_cancelled' | 'booking_no_show' | 'booking_bumped';
```

the `extra` parameter gains `slot?: string | null`, and the switch gains, after the `booking_no_show` case:

```ts
    case 'booking_bumped':
      // Server priority Ruling 5: the slot is nearestFreeSlot's, worked out when the scrim was closed.
      content = `${vs} on ${when} was bumped: a tournament match needed the server. ${extra.slot
        ? `The nearest free slot is ${whenUtc(extra.slot)}: book it again from the booking page, or leave it.`
        : 'No other slot is free within 3 hours of the start: book another time from the booking page, or leave it.'} It counts against neither side.`;
      break;
```

In `src/notify/notify.ts`, add `| 'booking_bumped'` to the first line of `NotifyType` (after `'booking_no_show'`) and, after the `booking_no_show` entry of `NOTIFY_TYPES`:

```ts
  { type: 'booking_bumped', label: 'A scrim I am in is bumped by a tournament match, with the nearest free slot' },
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/bookings.test.ts tests/notify.test.ts tests/bookingRunner.test.ts && npm run typecheck`
Expected: PASS; both typechecks clean (the runner's `tell` takes `BookingNotifyType`, which only grew).

- [ ] **Step 6: Commit**

```bash
git add src/bookings/bookings.ts src/bookings/messages.ts src/notify/notify.ts tests/bookings.test.ts tests/notify.test.ts
git commit -m "Server priority: bumpBooking closes an unstarted scrim as bumped with the nearest free slot, and the booking_bumped notice"
```

---
### Task 3: The runner takes boxes by priority and bumps a held scrim for a tournament match

**Files:**
- Modify: `src/bookings/runner.ts`, `src/serverHolds.ts` (comment only)
- Test: `tests/bookingRunner.test.ts`

**Interfaces:**
- Consumes: `bumpBooking`, `sideName`, `sidesOf`, `openBookings`, `holdBox` (`bookings.ts`); `byPriority`, `bookingLimits` (`rules.ts`); `liveBookingGame` (`games.ts`); `getServer` (`serverPool.ts`); `campaignRegistry`; `publishAdminEvent`; the file-private `loadsOn`.
- Produces (all private but `allocate`, `relocate` and `pickBox`, which keep their signatures): `queue(): BookingRow[]`; `fits(b: BookingRow, s: ServerRow): boolean`; `preemptable(region: string): boolean`; `tournamentsOwed(region: string): number`; `waitingTournament(region: string): BookingRow | null`; `bumpable(forB: BookingRow): BookingRow | null`; `bumpFor(forB: BookingRow, nowMs: number): void`; `bump(victim: BookingRow, forB: BookingRow, nowMs: number): void`; `END_SAY.bumped`.

- [ ] **Step 1: Write the failing tests**

In `tests/bookingRunner.test.ts`, extend the booking import with `markActive` (keep the rest), and append at the end of the file:

```ts
describe('server priority (owner, 2026-10-07)', () => {
  /** A tournament match's booking, made at lineup lock: starts now, 90 minutes, people P[2] to P[9]. */
  const tournament = () => {
    const r = createTournamentBooking(db, {
      region: 'na', campaign: 'no_mercy', rulesJson: '{}', rulesetId: null, gameConfig: 'standard', createdBy: P[9],
      sides: [{ teamId: null, captain: P[2], players: P.slice(2, 6), spectators: [] }, { teamId: null, captain: P[6], players: P.slice(6, 10), spectators: [] }],
      now: new Date(now),
    });
    if (!r.ok) throw new Error(r.error);
    return r.value.id;
  };
  /** A scrim held and set up on the highest box (ccc, id 3) at its hold time. */
  const heldScrim = async () => {
    const id = book();
    now = START - 15 * MIN;
    runner.allocate();
    await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ state: 'ready', server_id: 3 });
    return id;
  };

  it('a tournament match with no idle box and nothing to preempt bumps the unstarted scrim holding a box, which is told with the nearest slot, and takes the box after the wind-down (Rulings 4, 5 and 7)', async () => {
    const events: AdminEvent[] = [];
    const unsubscribe = subscribeAdminEvents((e) => events.push(e));
    const scrim = await heldScrim();
    db.prepare("UPDATE servers SET status = 'live' WHERE id IN (1, 2)").run();
    setSetting(db, 'pug_reserve_servers', '2'); // room for one booking: the match fills 19:45 to 21:15, so the scrim's next slot is 21:30
    dms = []; sent = []; released = [];
    const match = tournament();
    runner.allocate();
    expect(getBooking(db, scrim)).toMatchObject({ state: 'cancelled', end_reason: 'bumped', cancel_side: null, cancelled_by: null, server_id: 3, ended_at: null });
    expect(getBooking(db, scrim)!.cancel_reason).toBe('A tournament match needed the server. The nearest free slot is 2026-10-02 21:30 UTC.');
    expect(getBooking(db, match)!.state).toBe('scheduled');
    expect(preempts).toBe(1);
    expect(dms.filter((d) => d.content.includes('was bumped: a tournament match needed the server')).map((d) => d.to).sort()).toEqual(['d0', 'd1']);
    expect(dms.every((d) => d.content.includes('The nearest free slot is 2026-10-02 21:30 UTC'))).toBe(true);
    expect(events.filter((e) => e.kind === 'problem').map((e) => e.text)).toEqual([
      `Booking ${scrim} (p0's group vs p1's group, 20:00 UTC) was bumped by tournament match booking ${match}: its server is going back to the pool for the match. Both sides are told and offered 21:30 UTC; it counts against neither side.`,
    ]);
    unsubscribe();
    await runner.idle();
    expect(sent.filter((s) => s.server === 'ccc').flatMap((s) => s.cmds)).toContain('say [Booking] This booked server is closing: a tournament match needs it.');
    expect(released).toEqual([3]);
    expect(getBooking(db, scrim)!.ended_at).not.toBeNull();
    expect(db.prepare("SELECT event FROM booking_events WHERE booking_id = ? ORDER BY id").all(scrim).map((e) => (e as { event: string }).event)).toContain('bumped');
    runner.allocate();
    await runner.idle();
    expect(getBooking(db, match)).toMatchObject({ state: 'ready', server_id: 3 });
  });

  it('practice leases and side games give a box back before any scrim is bumped (Ruling 4)', async () => {
    const scrim = await heldScrim();
    db.prepare("UPDATE servers SET status = 'live' WHERE id = 2").run();
    db.prepare("INSERT INTO side_games (server_id, token, password) VALUES (1, 'tok', 'pw')").run();
    const match = tournament();
    runner.allocate();
    expect(preempts).toBe(1);
    expect(getBooking(db, scrim)!.state).toBe('ready');
    expect(getBooking(db, match)!.state).toBe('scheduled');
    db.prepare("UPDATE side_games SET ended_at = datetime('now')").run();
    runner.allocate();
    await runner.idle();
    expect(getBooking(db, match)).toMatchObject({ state: 'ready', server_id: 1 });
    expect(getBooking(db, scrim)).toMatchObject({ state: 'ready', server_id: 3 });
  });

  it('never bumps a scrim that started: an active booking stays, and the match waits (Ruling 4)', async () => {
    const scrim = await heldScrim();
    expect(markActive(db, scrim, new Date(now))).toBe(true);
    db.prepare("UPDATE servers SET status = 'live' WHERE id IN (1, 2)").run();
    dms = [];
    const match = tournament();
    runner.allocate();
    expect(getBooking(db, scrim)).toMatchObject({ state: 'active', server_id: 3 });
    expect(getBooking(db, match)!.state).toBe('scheduled');
    expect(dms).toEqual([]);
    expect(preempts).toBe(1);
  });

  it('bumps one scrim per waiting match: with two held scrims and one match, the latest row goes and the other stays while the box winds down (Ruling 4)', async () => {
    const first = book();
    const second = book();
    now = START - 15 * MIN;
    runner.allocate();
    await runner.idle();
    expect(getBooking(db, first)).toMatchObject({ state: 'ready', server_id: 3 });
    expect(getBooking(db, second)).toMatchObject({ state: 'ready', server_id: 2 });
    db.prepare("UPDATE servers SET status = 'live' WHERE id = 1").run();
    const match = tournament();
    runner.allocate();
    runner.allocate();
    expect(getBooking(db, second)).toMatchObject({ state: 'cancelled', end_reason: 'bumped' });
    expect(getBooking(db, first)).toMatchObject({ state: 'ready', server_id: 3 });
    await runner.idle();
    runner.allocate();
    await runner.idle();
    expect(getBooking(db, match)).toMatchObject({ state: 'ready', server_id: 2 });
    expect(getBooking(db, first)).toMatchObject({ state: 'ready', server_id: 3 });
  });

  it('a box that frees up goes to the tournament match before a scrim that has waited longer (Ruling 2)', async () => {
    const scrim = book();
    db.prepare("UPDATE servers SET status = 'live' WHERE id IN (2, 3)").run();
    db.prepare("INSERT INTO side_games (server_id, token, password) VALUES (1, 'tok', 'pw')").run();
    now = START - 15 * MIN;
    runner.allocate();
    expect(getBooking(db, scrim)!.state).toBe('scheduled');
    now = START + 2 * MIN; // the scrim is past its start; the match starts later than it
    const match = tournament();
    runner.allocate();
    expect(getBooking(db, scrim)!.state).toBe('scheduled'); // a side game is still there to take, so nothing is bumped
    db.prepare("UPDATE side_games SET ended_at = datetime('now')").run();
    runner.allocate();
    await runner.idle();
    expect(getBooking(db, match)).toMatchObject({ state: 'ready', server_id: 1 });
    expect(getBooking(db, scrim)!.server_id).toBeNull();
  });
});
```

(In the last test the scrim's own fate after the match took the box is Task 4's business; here it only must not get the box. `setSetting` is imported in this file already.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/bookingRunner.test.ts`
Expected: the five new tests FAIL (nothing is bumped; in the last one the scrim takes box 1 by start order).

- [ ] **Step 3: runner.ts**

Extend the booking import with `bumpBooking` (the `import { ... } from './bookings.js'` list; `sideName` and `sidesOf` are already there) and the rules import with `byPriority`:

```ts
import { DEFAULT_GRACE_MINUTES, bookingLimits, byPriority, isLateCancel } from './rules.js';
```

In `END_SAY`, after `done: 'everyone left',`:

```ts
  // Server priority Ruling 7: the goodbye on a scrim's box a tournament match takes.
  bumped: 'a tournament match needs it',
```

Replace `allocate`, `freeBoxes` and `pickBox` with:

```ts
  /** Take a box for every confirmed booking at its hold time. Run by the
   *  tick and whenever the releaser frees a box. Bookings are walked by
   *  priority (rules.ts byPriority): a tournament match before a scrim. */
  allocate(): void {
    // Waiting bookings first: the only time a booking goes ahead of PUGs.
    this.relocate();
    const nowMs = this.now();
    const lead = bookingLimits(this.db).holdLeadMinutes * 60_000;
    let preempt = false;
    // Boxes tournament matches in each region still wait for in this pass
    // (Ruling 6): one scrim past its start is bumped for each, no more.
    const owed = new Map<string, number>();
    for (const b of this.queue()) {
      if (b.state !== 'scheduled' || b.server_id !== null || b.ending_at !== null) continue;
      if (Date.parse(b.starts_at) - lead > nowMs) continue;
      if (sidesOf(this.db, b.id).some((s) => s.confirmed_at === null)) continue;
      const server = this.pickBox(b);
      if (!server || !holdBox(this.db, b.id, server.id, new Date(nowMs))) {
        // Preempt practice and side games only when the region has no free
        // box at all; an idle box that cannot load the playlist (dlc4, a
        // custom campaign) would not be helped by emptying another one.
        if (this.freeBoxes(b.region) === 0) {
          preempt = true;
          // Server priority (Rulings 4 and 6): once practice and side games
          // have nothing left to give back in the region, a tournament match
          // bumps the unstarted scrim holding a box it can use, and a scrim
          // past its start is bumped for a match still waiting on a box
          // rather than waiting on itself for the no_server close.
          if (!this.preemptable(b.region)) {
            if (b.purpose === 'tournament') {
              this.bumpFor(b, nowMs);
            } else if (nowMs >= Date.parse(b.starts_at)) {
              const left = owed.get(b.region) ?? this.tournamentsOwed(b.region);
              const match = left > 0 ? this.waitingTournament(b.region) : null;
              owed.set(b.region, match ? left - 1 : left);
              if (match) { this.bump(b, match, nowMs); continue; }
            }
          }
        }
        if (b.purpose !== 'tournament' && nowMs >= Date.parse(b.starts_at) && !this.latePublished.has(b.id)) {
          this.latePublished.add(b.id);
          publishAdminEvent({
            kind: 'problem',
            text: `Booking ${b.id} started at ${b.starts_at.slice(11, 16)} UTC and still has no server: no idle box in its region can load its playlist, or every box is busy.`,
          });
        }
        continue;
      }
      console.log(`[booking] ${b.id} holds ${server.name}`);
      this.track(b.id, () => this.setup(b.id));
    }
    if (preempt) this.deps.preempt();
  }

  /** Every booking still holding something, in the order boxes go to them
   *  (server priority Ruling 2). */
  private queue(): BookingRow[] {
    return openBookings(this.db).sort(byPriority);
  }

  /** Idle, enabled boxes in the region that nothing holds. */
  private freeBoxes(region: string): number {
    return (this.db.prepare(
      `SELECT COUNT(*) AS n FROM servers WHERE status = 'idle' AND enabled = 1 AND region = ? AND ${NOT_HELD_SQL}`,
    ).get(region) as { n: number }).n;
  }

  /** Whether this box can load every campaign on the booking's playlist. */
  private fits(b: BookingRow, s: ServerRow): boolean {
    const registry = campaignRegistry(this.db);
    return (JSON.parse(b.playlist_json) as string[]).every((c) => loadsOn(this.db, registry.get(c), s));
  }

  /** An idle box for this booking: enabled, in its region, held by nothing,
   *  and able to load every campaign on the playlist. Highest id first, the
   *  reverse of claimIdle, like a practice lease. */
  pickBox(b: BookingRow): ServerRow | null {
    const rows = this.db.prepare(
      `SELECT * FROM servers WHERE status = 'idle' AND enabled = 1 AND region = ? AND ${NOT_HELD_SQL} ORDER BY id DESC`,
    ).all(b.region) as ServerRow[];
    return rows.find((s) => this.fits(b, s)) ?? null;
  }

  // ---------- server priority (owner, 2026-10-07) ----------

  /** Practice leases and side games on enabled boxes in the region: what
   *  deps.preempt can still give back, which always comes before a scrim
   *  gives way (Ruling 4). */
  private preemptable(region: string): boolean {
    return !!this.db.prepare(
      `SELECT 1 FROM open_server_holds h JOIN servers s ON s.id = h.server_id
        WHERE h.kind IN ('practice', 'side') AND s.region = ? AND s.enabled = 1 LIMIT 1`,
    ).get(region);
  }

  /** Tournament bookings in the region waiting for a box, less the boxes
   *  bumped scrims there are already winding down to give them: how many
   *  more scrims may give way right now (Rulings 4 and 6). */
  private tournamentsOwed(region: string): number {
    const waiting = (this.db.prepare(
      "SELECT COUNT(*) AS n FROM bookings WHERE purpose = 'tournament' AND region = ? AND state = 'scheduled' AND server_id IS NULL AND ending_at IS NULL",
    ).get(region) as { n: number }).n;
    const coming = (this.db.prepare(
      "SELECT COUNT(*) AS n FROM bookings WHERE purpose = 'scrim' AND region = ? AND end_reason = 'bumped' AND server_id IS NOT NULL AND ended_at IS NULL",
    ).get(region) as { n: number }).n;
    return Math.max(0, waiting - coming);
  }

  /** The tournament booking in the region waiting for a box that a scrim
   *  past its start gives way to (Ruling 6): the first in queue order. */
  private waitingTournament(region: string): BookingRow | null {
    const rows = this.db.prepare(
      "SELECT * FROM bookings WHERE purpose = 'tournament' AND region = ? AND state = 'scheduled' AND server_id IS NULL AND ending_at IS NULL",
    ).all(region) as BookingRow[];
    return rows.sort(byPriority)[0] ?? null;
  }

  /** The scrim a tournament match may bump (Ruling 4): open, holding a box
   *  in the match's region, not started (never active, no live game, not in
   *  crash recovery), on a box that loads the match's campaign. The latest
   *  start first, then the newest row: the scrim with the most time to
   *  rebook gives way. */
  private bumpable(forB: BookingRow): BookingRow | null {
    const rows = this.db.prepare(
      `SELECT * FROM bookings WHERE purpose = 'scrim' AND region = ? AND server_id IS NOT NULL AND ending_at IS NULL
         AND recovering_at IS NULL AND state IN ('held', 'setup', 'ready') ORDER BY starts_at DESC, id DESC`,
    ).all(forB.region) as BookingRow[];
    for (const v of rows) {
      if (liveBookingGame(this.db, v.id)) continue;
      const s = getServer(this.db, v.server_id!);
      if (s && this.fits(forB, s)) return v;
    }
    return null;
  }

  /** A tournament match with no idle box in its region and nothing left to
   *  preempt: bump one scrim for it, unless a bumped box is already on its
   *  way back (Ruling 4). */
  private bumpFor(forB: BookingRow, nowMs: number): void {
    if (this.tournamentsOwed(forB.region) === 0) return;
    const victim = this.bumpable(forB);
    if (victim) this.bump(victim, forB, nowMs);
  }

  /** Close the scrim as bumped, tell staff and both sides, and start the
   *  wind-down (settle), which gives its box back through the releaser;
   *  the freed hook then runs allocate again for the match (Rulings 5 and 7). */
  private bump(victim: BookingRow, forB: BookingRow, nowMs: number): void {
    const r = bumpBooking(this.db, { bookingId: victim.id, byBookingId: forB.id, now: new Date(nowMs) });
    if (!r.ok) return;
    const [a, bs] = sidesOf(this.db, victim.id);
    const names = `${sideName(this.db, a)} vs ${sideName(this.db, bs)}`;
    console.log(`[booking] ${victim.id} (${names}) bumped by tournament booking ${forB.id}`);
    publishAdminEvent({
      kind: 'problem',
      text: `Booking ${victim.id} (${names}, ${victim.starts_at.slice(11, 16)} UTC) was bumped by tournament match booking ${forB.id}: `
        + `${r.value.hadServer ? 'its server is going back to the pool for the match' : 'no server was free and the match is ahead of it'}. `
        + `Both sides are told${r.value.nearestSlot ? ` and offered ${r.value.nearestSlot.slice(11, 16)} UTC` : ''}; it counts against neither side.`,
    });
    this.tell(victim.id, this.everyone(victim.id), 'booking_bumped', { slot: r.value.nearestSlot });
    this.settle(victim.id);
  }
```

In `relocate`, change `for (const b of openBookings(this.db)) {` to `for (const b of this.queue()) {`. In the private `tell`, add `slot?: string | null` to the `extra` type (the same shape as `bookingMessage`'s).

In `src/serverHolds.ts`, change the doc comment above `HoldKind` to:

```ts
/** A kind of database hold; one arm of open_server_holds each. A booking
 *  (rank 0) outranks a practice lease (1) and a side game (2). Between two
 *  bookings the view never chooses: which booking gets the next free box is
 *  the runner's queue order (src/bookings/rules.ts byPriority, a tournament
 *  match before a scrim), and two bookings never hold one box. */
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/bookingRunner.test.ts tests/bookingRecovery.test.ts tests/serverHoldGuard.test.ts tests/series.test.ts && npm run typecheck`
Expected: PASS; both typechecks clean. (`bookingRecovery` covers `relocate`, whose only change is the order.)

- [ ] **Step 5: Commit**

```bash
git add src/bookings/runner.ts src/serverHolds.ts tests/bookingRunner.test.ts
git commit -m "Server priority: the runner takes boxes by priority, preempts practice and side games first, and bumps the unstarted scrim holding a box for a tournament match, one at a time"
```

---
### Task 4: A scrim past its start gives way to a waiting match

**Files:**
- Modify: nothing new (the branch landed in Task 3's `allocate`); this task proves it and the control cases.
- Test: `tests/bookingRunner.test.ts`

**Interfaces:**
- Consumes: Task 3's `allocate`, `tournamentsOwed`, `waitingTournament`, `bump`; `closeServerless` (unchanged).
- Produces: nothing new; the tests below are the contract of Ruling 6.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('server priority (owner, 2026-10-07)')` in `tests/bookingRunner.test.ts`:

```ts
  it('a scrim past its start with no box is bumped at its start for a match waiting on one, with the slot offer, and never gets the late alert (Ruling 6)', async () => {
    const events: AdminEvent[] = [];
    const unsubscribe = subscribeAdminEvents((e) => events.push(e));
    const scrim = book();
    db.prepare("UPDATE servers SET status = 'live'").run();
    now = START - 15 * MIN;
    runner.allocate();
    expect(getBooking(db, scrim)!.state).toBe('scheduled');
    now = START;
    dms = [];
    const match = tournament(); // 20:00 to 21:30; room for 2: the scrim's next slot is 20:30
    runner.allocate();
    unsubscribe();
    const b = getBooking(db, scrim)!;
    expect(b).toMatchObject({ state: 'cancelled', end_reason: 'bumped', cancel_side: null, server_id: null, ended_at: new Date(now).toISOString() });
    expect(b.cancel_reason).toBe('A tournament match needed the server. The nearest free slot is 2026-10-02 20:30 UTC.');
    expect(dms.filter((d) => d.content.includes('was bumped')).map((d) => d.to).sort()).toEqual(['d0', 'd1']);
    expect(events.filter((e) => e.kind === 'problem').map((e) => e.text)).toEqual([
      `Booking ${scrim} (p0's group vs p1's group, 20:00 UTC) was bumped by tournament match booking ${match}: no server was free and the match is ahead of it. Both sides are told and offered 20:30 UTC; it counts against neither side.`,
    ]);
    expect(getBooking(db, match)!.state).toBe('scheduled');
    await runner.idle();
    expect(released).toEqual([]);
  });

  it('a match that already holds a box owes nothing: a scrim short of a box beside it waits for the no_server close as before (Ruling 6)', async () => {
    db.prepare("UPDATE servers SET status = 'live' WHERE id IN (1, 2)").run();
    now = START - 20 * MIN;
    const match = tournament();
    runner.allocate();
    await runner.idle();
    expect(getBooking(db, match)).toMatchObject({ state: 'ready', server_id: 3 });
    const scrim = book();
    now = START + 14 * MIN;
    dms = [];
    await runner.tick();
    expect(getBooking(db, scrim)!.state).toBe('scheduled');
    expect(dms).toEqual([]);
    now = START + 15 * MIN;
    await runner.tick();
    expect(getBooking(db, scrim)).toMatchObject({ state: 'cancelled', end_reason: 'no_server' });
  });

  it('one scrim per waiting match: two scrims past their start and one match bump only the earlier-started one (Ruling 6)', () => {
    const first = book();
    const second = book();
    db.prepare("UPDATE servers SET status = 'live'").run();
    now = START + MIN;
    tournament();
    runner.allocate();
    expect(getBooking(db, first)).toMatchObject({ state: 'cancelled', end_reason: 'bumped' });
    expect(getBooking(db, second)!.state).toBe('scheduled');
  });
```

(In the second test `book()` is made after the match took its box and the slot still fits: `pug_reserve_servers` is 1 in this file, room for 2. The `ready` match's `starts_at` is before the scrim's, so queue order is not what the test proves; `tournamentsOwed` is.)

- [ ] **Step 2: Run them**

Run: `npx vitest run tests/bookingRunner.test.ts`
Expected: PASS with Task 3's code. If the first test fails on the slot ("20:30"), check `nearestFreeSlot`'s `inWindow` (a candidate must be strictly after `nowMs`, so the scrim's own 20:00 start is never offered at 20:00) before touching anything else; if the third fails on which scrim went, check that `queue()` sorts the two scrims by start then id (the first row is first) and that `owed` is decremented once.

- [ ] **Step 3: Commit**

```bash
git add tests/bookingRunner.test.ts
git commit -m "Server priority: a scrim past its start gives way to a waiting tournament match at its start, one per match, and a match holding a box owes nothing"
```

---
### Task 5: The desk shows priority and the cap

**Files:**
- Modify: `src/routes/adminBookings.ts`, `web/src/api.ts`, `web/src/routes/admin/BookingsPanel.tsx`, `web/src/styles/app.css`
- Test: `tests/bookingRoutes.test.ts`, `web/src/routes/admin/BookingsPanel.test.tsx`

**Interfaces:**
- Consumes: `bookingLimits`, `scrimsHolding` (`rules.ts`); `AdminBookingRow`, `adminApi.bookings`, `BookingState` (`web/src/api.ts`).
- Produces:
  - `adminBookings.ts`: `AdminBookingRow.purpose: 'scrim' | 'tournament'`; `interface AdminBookingPriority { scrimMax: number; scrimsHolding: number; pugReserve: number }`; `GET /api/admin/bookings` answers `{ bookings: AdminBookingRow[]; priority: AdminBookingPriority }`.
  - `web/src/api.ts`: the same two types; `adminApi.bookings` typed to the new answer.
  - `BookingsPanel.tsx`: `PURPOSE_LABEL`, the chip, the priority line (`data-testid="booking-priority"`), "cancelled (bumped by a match)".

- [ ] **Step 1: Write the failing tests**

In `tests/bookingRoutes.test.ts`, inside `describe('staff')`:

```ts
  it('the staff list names each booking\'s purpose and the scrim cap beside the PUG reserve (server priority Ruling 9)', async () => {
    const id = await create();
    const list = (await call('GET', '/api/admin/bookings', MOD)).json();
    expect(list.bookings.find((b: { id: number }) => b.id === id).purpose).toBe('scrim');
    const reserve = Number((db.prepare("SELECT value FROM settings WHERE key = 'pug_reserve_servers'").get() as { value: string }).value);
    expect(list.priority).toEqual({ scrimMax: 2, scrimsHolding: 0, pugReserve: reserve });
    db.prepare("UPDATE settings SET value = '3' WHERE key = 'scrim_max_servers'").run();
    db.prepare("UPDATE bookings SET server_id = (SELECT id FROM servers WHERE name = 'a'), state = 'held' WHERE id = ?").run(id);
    expect((await call('GET', '/api/admin/bookings', MOD)).json().priority).toEqual({ scrimMax: 3, scrimsHolding: 1, pugReserve: reserve });
  });
```

In `web/src/routes/admin/BookingsPanel.test.tsx`, add `purpose: 'scrim',` to `ROW` (after `id: 4,`) and append inside `describe('BookingsPanel')`:

```tsx
  it('shows each booking\'s priority, the scrim cap line and a bumped scrim (server priority Ruling 9)', async () => {
    mockAdmin.bookings.mockResolvedValue({
      bookings: [
        ROW,
        { ...ROW, id: 5, purpose: 'tournament', aName: 'Owls', bName: 'Rats', state: 'scheduled', server: null },
        { ...ROW, id: 6, aName: 'Owls', bName: "p1's group", state: 'cancelled', endReason: 'bumped', server: null },
      ],
      priority: { scrimMax: 2, scrimsHolding: 1, pugReserve: 2 },
    });
    render(<BookingsPanel nudge={0} />);
    await screen.findByText('Owls vs Rats');
    expect(screen.getByText('Match')).toBeTruthy();
    expect(screen.getAllByText('Scrim')).toHaveLength(2);
    expect(screen.getByTestId('booking-priority').textContent).toBe('Priority: Match, then Scrim, then PUG, then practice and side games. Scrims hold 1 of 2 servers they may hold at once; 2 always left for PUGs. A match with no free server bumps a scrim that has not started.');
    expect(screen.getByText('cancelled (bumped by a match)')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '+1 campaign' })).toBeTruthy();
  });

  it('shows no priority line when the answer carries none', async () => {
    mockAdmin.bookings.mockResolvedValue({ bookings: [ROW] });
    render(<BookingsPanel nudge={0} />);
    await screen.findByText("Rats vs p1's group");
    expect(screen.queryByTestId('booking-priority')).toBeNull();
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/bookingRoutes.test.ts web/src/routes/admin/BookingsPanel.test.tsx`
Expected: FAIL (`purpose` and `priority` missing from the answer; no chip, no line).

- [ ] **Step 3: adminBookings.ts**

Add `import { bookingLimits, scrimsHolding } from '../bookings/rules.js';`. The row type becomes

```ts
export interface AdminBookingRow {
  id: number; purpose: 'scrim' | 'tournament'; state: string; ending: boolean; startsAt: string; endsAt: string; aName: string; bName: string;
  server: string | null; peak: { a: number; b: number }; endReason: string | null;
  /** Plan 2 Ruling 6: a side whose team (or pickup captain) carries the toxic flag. */
  toxic: { a: boolean; b: boolean };
}

/** Server priority (Ruling 9): the scrim cap, how much of it is in use, and the PUG reserve. */
export interface AdminBookingPriority { scrimMax: number; scrimsHolding: number; pugReserve: number }
```

In the list route, add `purpose: b.purpose,` after `id: b.id,` in each row, and return

```ts
    const limits = bookingLimits(db);
    return { bookings, priority: { scrimMax: limits.scrimMax, scrimsHolding: scrimsHolding(db), pugReserve: limits.reserve } satisfies AdminBookingPriority };
```

- [ ] **Step 4: web/src/api.ts and BookingsPanel.tsx**

In `web/src/api.ts`, `AdminBookingRow` gains `purpose: 'scrim' | 'tournament';` after `id: number;`, and after it:

```ts
/** src/routes/adminBookings.ts: the scrim cap, how much of it is in use, and the PUG reserve (server priority Ruling 9). */
export interface AdminBookingPriority { scrimMax: number; scrimsHolding: number; pugReserve: number }
```

and `adminApi.bookings` becomes

```ts
  bookings: (signal?: AbortSignal) => get<{ bookings: AdminBookingRow[]; priority?: AdminBookingPriority }>('/api/admin/bookings', signal),
```

(`priority` optional on the client so the existing panel tests, which mock `{ bookings }` alone, still type and render.)

In `BookingsPanel.tsx`, after `STATE_LABEL`:

```tsx
const PURPOSE_LABEL: Record<AdminBookingRow['purpose'], string> = { tournament: 'Match', scrim: 'Scrim' };

/** The state cell: a bumped scrim says what bumped it (server priority Ruling 9). */
const stateText = (b: AdminBookingRow): string =>
  `${STATE_LABEL[b.state]}${b.endReason === 'bumped' ? ' (bumped by a match)' : b.endReason ? ` (${b.endReason})` : ''}`;
```

In the component, after `const rows = ...`: `const priority = list.data?.priority ?? null;`. After `<h3>Booked servers</h3>`:

```tsx
      {priority && (
        <p class="muted" data-testid="booking-priority">
          Priority: Match, then Scrim, then PUG, then practice and side games. Scrims hold {priority.scrimsHolding} of {priority.scrimMax} server{priority.scrimMax === 1 ? '' : 's'} they may hold at once; {priority.pugReserve} always left for PUGs. A match with no free server bumps a scrim that has not started.
        </p>
      )}
```

The first cell of each row becomes

```tsx
                  <td>
                    <span class={`teamchip teamchip--${b.purpose}`}>{PURPOSE_LABEL[b.purpose]}</span>{' '}
                    <a href={`/booking/${b.id}`}>{b.aName} vs {b.bName}</a>
                    {b.toxic.a && <span class="teamchip teamchip--toxic" title={`${b.aName}: repeated toxic tags`}>Toxic tags</span>}
                    {b.toxic.b && <span class="teamchip teamchip--toxic" title={`${b.bName}: repeated toxic tags`}>Toxic tags</span>}
                  </td>
```

and the state cell `<td>{stateText(b)}</td>`. In `web/src/styles/app.css`, next to the `.teamchip--toxic` rule:

```css
.teamchip--tournament { background: var(--accent-soft, rgba(255, 165, 0, 0.18)); color: var(--accent, #e8a33d); }
.teamchip--scrim { background: var(--panel-2, rgba(255, 255, 255, 0.08)); color: var(--muted, #9aa3ad); }
```

(Use the token names `app.css` already defines for the toxic chip's colours; the fallbacks above are only for a token that does not exist.)

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/bookingRoutes.test.ts web/src/routes/admin/BookingsPanel.test.tsx web/src/routes/admin/AdminLive.test.tsx && npm run typecheck && npm run build`
Expected: PASS; both typechecks clean; a clean build.

- [ ] **Step 6: Commit**

```bash
git add src/routes/adminBookings.ts web/src/api.ts web/src/routes/admin/BookingsPanel.tsx web/src/routes/admin/BookingsPanel.test.tsx web/src/styles/app.css tests/bookingRoutes.test.ts
git commit -m "Server priority: the Booked servers panel shows each booking as Match or Scrim, the scrim cap beside the PUG reserve, and a bumped scrim as such"
```

---
### Task 6: The whole-branch check and the hand-off

**Files:**
- No new code; fixes to whatever the checks turn up, in the file they belong to.

- [ ] **Step 1: The whole-branch check**

Run, in order, and fix anything that fails before committing:

```bash
npm test
npm run typecheck
npm run build
grep -rnP '\x{2014}' src web/src tests | head
git diff --stat tournaments-t4..HEAD
```

Expected: every test passes (the scrim board, booking, recovery, series, practice and side game suites included: none asserts the order of `openBookings` in the runner, and every scrim they book fits under a cap of 2), both typechecks clean, a clean build, no em dash anywhere in the branch, and the diff touching only the files in the file map plus the tests.

- [ ] **Step 2: A scratch walk**

On a throwaway database (`PUG_DB=/tmp/priority.sqlite npm run dev`; never `/home/volence/l4d1-ds` or a live box), with `competitive_enabled = 'admins'`, three enabled servers pointed at nothing (rcon fails, which is fine for the desk), `pug_reserve_servers` at 1 and `scrim_max_servers` at 1: book two scrims for the same hour and see the second refused with "Not enough servers are free for that time"; set the cap to 2 and see it accepted; open the Live board and see the Booked servers panel with two Scrim chips and the line "Scrims hold 0 of 2 servers they may hold at once; 1 always left for PUGs"; cancel one from the desk. Then from the Settings desk confirm `scrim_max_servers` sits under Competitive with its help text. Two screenshots at 390 px into the scratchpad, no sideways scroll. (The bump itself needs a box that answers rcon and is proven by Tasks 3 and 4; it is not walked here.)

- [ ] **Step 3: Read the log and write the hand-off**

Read `git log --oneline tournaments-t4..HEAD`: five commits, one per task, each a plain sentence. Do not push; do not deploy.

Note for the owner in the hand-off:
- Rulings 3 (the cap is booking-time only and lowering it leaves booked scrims alone), 4 (practice and side games always give way before a scrim; the latest-starting scrim gives way first; one bump at a time per waiting match), 5 (no one-click rebook; the DM and the page carry the nearest slot), 6 (a scrim past its start is bumped at its start, not at its hold time, and only for a match that is waiting) and 7 (the admin feed line is a `problem` line) are the ones to confirm or reverse.
- One new setting on the Settings desk under Competitive: `scrim_max_servers` (2).
- Nothing changes for PUGs, practice leases or side games (Ruling 11 records the owner's clarification that the bottom tier is interruptible in use, which is today's behaviour); `open_server_holds` is untouched.
- Production stays behind `competitive_enabled = 'admins'`; no plugin change; no server touched.

- [ ] **Step 4: Commit anything the checks changed**

```bash
git add -A
git commit -m "Server priority: the whole-branch check"
```

(only if Step 1 or 2 changed files; otherwise nothing to commit.)
