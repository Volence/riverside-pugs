# Drafts plan D2c: no scrim records from tournaments, players on draft teams, staff remove and replace

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three owner requests (2026-10-07), on top of D2a (branch `drafts-2a`):
1. Tournament play never touches scrim records, and never counts as PUGs.
2. Draft teams show their players publicly.
3. Staff can remove a draft player for behaviour or cheating and replace them.

**Architecture:**
- **Scrim records.** They are computed in `src/scrims/reliability.ts` and `src/bookings/rules.ts` over `booking_sides` joined to `bookings`. Every one of those queries gains `b.purpose <> 'tournament'`.
- **Public team list.** It comes from `src/events/views.ts` (`EventEntryView`) and gains the starters' names for draft entries.
- **Staff replace.** A new mutation in `src/events/entries.ts`, the only writer of entry rosters, with a desk action, DMs, and handling for a match that is already under way. That handling goes through the room's existing substitution path (`R.subPlayer` in `src/events/room.ts`).

**Tech Stack:** TypeScript (ESM), Fastify 5, better-sqlite3, vitest, Preact. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-30-competitive-drafts-design.md` section 6 (bench and stand-ins: "Staff can override"; a player who leaves a team stranded gets a staff note), plus the owner's 2026-10-07 messages: "draft tourney should not count as pugs and there should be no scrim records", "draft teams should show players", "staff should definitely be able to kill someone if they're behaving poorly or cheating and replace if need be".

## Rulings (for the owner to confirm)

1. **No scrim records from tournaments.** This covers every tournament booking, for team events and drafts alike. The following exclude `bookings.purpose = 'tournament'`:
   - reliability (shown, booked, no-shows, late cancels, excused);
   - `scrimRecordOf`;
   - `hasPickupBookings`;
   - `upcomingCount`;
   - `recentNoShows`.

   A tournament no-show is handled by the event (forfeits, staff), not by scrim standing. Find the real purpose value and column by reading `src/bookings/bookings.ts`.
2. **Not PUGs.** Tournament games are `matches.kind = 'tournament'` and never move SR. This plan adds tests that pin both: a finished tournament game adds no `rating_history` row, and `completedPug` excludes it.
3. **Players on public draft teams.** A draft entry's public view lists its current starters' display names, in the order the entry stores them, captain first. Team entries are unchanged; they show no roster publicly, as today. SR is never shown.
4. **Staff remove and replace.**
   - An admin, from the desk, removes one starter of a draft entry and puts in a replacement, in one action.
   - Allowed any time from teams made until the event finishes (registration, check-in or live).
   - A reason is required, one of: `conduct`, `cheating`, `no_show`, `left`, `other`. A free-text note is optional, staff-only, and at most 200 characters.
   - The replacement is an active bench signup of the event by default. Staff may instead pick any player who passes the event's eligibility and is not already on an entry in this event.
   - The removed player loses their place. This is not a site ban: staff use the existing ban tools for that, and the desk links to them.
5. **During a match.** If the removed player is in a locked lineup of an unfinished match of this entry, the replace also substitutes them there through the room's existing substitution path, so the next game and every re-push use the new player. A staff replace does not count against the team's subs-per-match limit. If the substitution path refuses (for example mid-chapter, where in-game rules apply), the replace is refused with `replace_in_game` and the server's reason. The desk then tells staff to use the in-game tools first (staff freeze, !sub).
6. **Records.**
   - One `event_log` row: `entry_player_replaced` with `{ entryId, out, in, reason }`. The note never appears in public logs.
   - The removed player gets a staff-visible note on their profile: the existing staff/conduct note facility, if one fits. Read `src/admin` for player notes. If none fits, the event log is the record, and the People desk shows it.
   - DMs:
     - The removed player gets `draft_player_removed`: "You were removed from <team> in <event> by staff (<reason sentence>)." The note is never included.
     - The replacement gets `draft_player_added`: "You are now on <team> in <event>, captained by <captain>: <link>".
     - The captain gets `draft_roster_changed`: "<out> was replaced by <in> on your team in <event>."
7. **Captains cannot do this.** Captain-requested stand-ins with bench offers are plan D3.

## Global Constraints

- Team events and their entries are unchanged, except that their tournament bookings no longer feed scrim records (Ruling 1, owner-requested).
- Writers:
  - `event_entries` and `event_entry_players` are written only in `src/events/entries.ts`.
  - Room tables are written only through `src/events/room.ts` exports.
  - One transaction and one `event_log` row per mutation, and nothing on refusal (`tests/eventLogGuard.test.ts`).
- Admins write and mods read (`requireAdmin` + `logAdmin`). DMs go out after commit through the D1/D2a DM pattern.
- Privacy: the reason note and SR never appear in public or player responses. The public view shows names only.
- Never write em dashes. Commit messages are plain sentences. Do not push or deploy.
- Work in `/home/volence/l4d/pug/.claude/worktrees/drafts-2c`, on branch `drafts-2c` cut from `drafts-2a`. The 7 `tests/skeetStreakPoster.test.ts` wall-clock failures are known.

## Review Focus

1. **A scrim record that loses real scrims.** Only tournament bookings may be excluded. A team's actual scrim no-shows still count. Task 1 tests both side by side.
2. **A replace that leaves a match room inconsistent.** After a replace during a booked series, the next game's burst and roster use the new player, and the room's lineup shows them. Task 3 pins it with the series fixture.
3. **A replacement already playing elsewhere in the event.** Refused with `player_entered`, the existing one-entry-per-player rule.
4. **Removing the captain.** Refused with `captain_replace`, with the sentence "Make another player captain first." Captain transfer is a separate staff action; ask in the report whether it is wanted.
5. **The bench afterwards.** The public bench list no longer shows a player who was placed on a team.

---

### Task 1: Tournament bookings out of scrim records; not PUGs (tests)

**Files:** `src/scrims/reliability.ts`, `src/bookings/rules.ts` (and any other scrim-record query over `booking_sides`: grep `no_show_at`, `late_cancel`, `booking_sides` in `src/scrims` and `src/bookings`). Tests: `tests/scrimReliability*.test.ts` or the existing reliability tests, plus a new `tests/tournamentNotScrim.test.ts`.

- [ ] **Step 1: Write the failing tests** (`tests/tournamentNotScrim.test.ts`):
  1. Give a team one scrim no-show and one tournament booking no-show. `reliability` counts 1 no-show, and `recentNoShows` counts 1.
  2. A pickup captain with an open tournament booking: `upcomingCount` is 0, and `hasPickupBookings` is false if that is their only booking.
  3. `scrimRecordOf` ignores the tournament side.
  4. Not PUGs: finish a tournament game through the series fixture (`tests/seriesFixture.ts`, as `tests/carry.test.ts` or `tests/series.test.ts` do). It adds no `rating_history` row, and a `completedPug('m')` query does not return it.
- [ ] **Step 2: Run and fail. Step 3: Add the purpose filter to each query. Step 4: Pass** (run the full suite once, plus typecheck).
- [ ] **Step 5: Commit** "Tournament bookings no longer count toward scrim reliability, no-shows or booking limits, and tests pin that tournament games are not PUGs (plan D2c)".

### Task 2: Players on public draft teams; bench excludes placed players

**Files:** `src/events/views.ts` (`EventEntryView` gains `players?: string[]` for draft entries only), `web/src/api.ts` (type), `web/src/routes/Event.tsx` (render the names under each draft team in the Teams list), and the D1 cut lists (the bench list excludes anyone now on an entry). Tests: views tests, `web/src/routes/Event.test.tsx`.

- [ ] **Step 1: Write the failing tests:**
  - The public view of a draft event with teams made lists 4 names per entry, captain first.
  - A team event's entries have no `players`.
  - The JSON has no `sr`.
  - After a replace (simulate one by writing the roster directly in this task's test), the bench list drops the placed player.
  - Web: the names render under the team.
- [ ] **Step 2 to 4:** Run and fail, implement, pass. Use the styles in `app.css` near the draft rules, with existing tokens only.
- [ ] **Step 5: Commit** "Draft teams list their players on the event page, and the bench drops anyone placed on a team (plan D2c)".

### Task 3: Staff remove and replace a draft player

**Files:**
- `src/events/entries.ts`: add `replaceDraftPlayer`.
- `src/events/room.ts`: only if a staff variant of the substitution path is needed. Prefer calling the existing `R.subPlayer` with the staff/limit options it already has. Read it first.
- `src/routes/adminEvents.ts`: add a route.
- DM files for the three types.
- `web/src/routes/admin/events/EntriesPanel.tsx`: add a "Replace player" action on draft entries.
- `web/src/api.ts`.
- Tests: `tests/draftReplace.test.ts` (new), the guard test, `EntriesPanel.test.tsx`.

**Interface:**
```ts
export type ReplaceReason = 'conduct' | 'cheating' | 'no_show' | 'left' | 'other';
export function replaceDraftPlayer(db: DB, o: {
  eventId: number; entryId: number; out: string; in: string; reason: ReplaceReason; note: string | null; actor: string; now: Date;
}): Checked<{ subbedInMatch: number | null }>;
```
In one transaction:
- Draft entry only (`not_draft_entry`).
- Teams made and the event not finished or cancelled (`wrong_status`).
- `out` is an active starter (`not_on_entry`) and not the captain (`captain_replace`).
- `in` is eligible (`problemsOf` starter; `ineligible` with problems) and not on any active entry of the event (`player_entered`).
- Reason valid (`bad_reason`), note at most 200 characters (`bad_note`).
- Set `out`'s place `removed_at`, then add `in` as a starter through the private `addPlace`.
- If `out` is in a locked lineup of an unfinished match of this entry, run the substitution in the same transaction (Ruling 5). A refusal rolls everything back and returns `replace_in_game` with the reason.
- Log one `entry_player_replaced` row.

Route: `POST /api/admin/events/:id/entries/:entryId/replace` `{ out, in, reason, note }`, requireAdmin + logAdmin (the note goes into the admin audit only). Send the DMs after commit, plus the staff profile note per Ruling 6.

Desk:
- "Replace player" on each non-captain starter of a draft entry (admins).
- A dialog with:
  - the replacement: a bench select first, plus a search for another player (reuse the desk's existing player search component);
  - a reason select: "Conduct", "Cheating", "No-show", "Left the event", "Other";
  - an optional note.
- Confirm title: "Replace <out> with <in>?" Body: "<out> loses their place on <team>. This is not a ban; use the ban tools for that."

- [ ] **Step 1: Write the failing tests** (`tests/draftReplace.test.ts`, on the D2a draft fixture with teams published):
  1. Replace a starter with a bench player: the roster has the new four, there is one log row, and the three DMs are sent.
  2. `captain_replace`, `not_on_entry`, `player_entered` (the replacement is on another team), `ineligible`, and `bad_reason` each refuse and write nothing.
  3. Replacing during a booked series, between games (series fixture): the next game's burst roster and `lineupFour` show the new player, and the team's sub count is unchanged.
  4. Refused mid-chapter with `replace_in_game` when the substitution path refuses; nothing is written.
  5. A mod gets 403; the admin route works and audits.
  6. Guard rows.
  - Web: the dialog, the bench select, a required reason, and the confirm text.
- [ ] **Step 2 to 4:** Run and fail, implement, pass (full suite once, web project, typecheck).
- [ ] **Step 5: Commit** "Staff can remove a draft player for conduct or cheating and replace them from the bench or another eligible player, carried into a running series, with DMs and a staff record (plan D2c)".
