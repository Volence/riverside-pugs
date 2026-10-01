# Scrim board plan 2: cancelling, reliability, reviews, scrim night

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A scrim side's record is built from what actually happened. Scrim plan 2 covers:
- **Reliability record:** how often a side showed, its no-shows and its late cancels. Only staff and the side itself see it, unless a setting makes it public.
- **Excusing a late cancel:** the other side can excuse it with one tap ("All good, no hard feelings"), and staff can excuse any mark.
- **Re-posting:** a cancelled scrim can be re-posted in one click.
- **Private reviews:** a one-tap review of the opponent after the booking ends. Individual reviews are visible only to staff, and a team sees only its own aggregate.
- **Scrim night:** a weekly banner and Discord reminder.

**Architecture:**
- Everything is computed from booking rows, never counted in place. `booking_sides` gains excuse columns, and `src/scrims/reliability.ts` reads bookings, sides and excuses into a record.
- `recentNoShows` (the booking allowance) ignores excused no-shows.
- Reviews live in a new `scrim_reviews` table, one row per booking per reviewing side. They are read through `src/scrims/reviews.ts`, which has separate staff and own-side views.
- Scrim night is three settings plus a pure window function. The board shows it, and `ScrimPoster` posts the weekly reminder.

**Tech Stack:** TypeScript, Fastify 5, better-sqlite3, vitest, Preact.

**Spec:** `docs/superpowers/specs/2026-09-30-competitive-scrims-design.md`, sections 3, 3a, 4 and 5 (rollout plan 2). It builds on foundation plans 4a to 4c and scrim board plan 1.

## Global Constraints

- Everything sits behind `competitive_enabled` (the `canUse` / `competitiveAccess` gates, exactly as plan 1's routes use them).
- Reliability is never public unless `scrim_reliability_public` is on (default off). Staff and the side itself see it.
  - "The side itself" for a team means its current members.
  - For a pickup party it means the captain whose steamid is on the booking side.
- Late cancel: a non-staff cancel less than `scrim_late_cancel_hours` (default 2, int 0..24) before `starts_at`.
  - A cancel made earlier, a staff cancel, or a system cancel (`no_server`, unconfirmed expiry, setup failure) is never recorded against anyone.
  - Excused marks never count anywhere: not the record, not the allowance.
- For pickup parties, the record belongs to the captain who booked (`booking_sides.captain_steamid`, team_id NULL), so forming a new group does not escape it.
- Individual reviews never appear in any non-staff response. Reviews are never shown on posts, the board or public team pages.
- Never write em dashes, in code, copy, tests or commits. Commit messages are plain sentences.
- Do not push, deploy, stage or rcon live boxes. No plugin changes in this plan.
- Copy the existing patterns:
  - `Result`/`fail`/`ok` and error maps with `{ status, text }`, as in `SCRIM_ERRORS`;
  - `ensureColumn` for new columns on existing tables;
  - `CREATE TABLE IF NOT EXISTS` for new tables;
  - the `Notifier` for DMs, with a new `NotifyType` per new DM;
  - `settingsSchema.ts` for settings, group `Competitive`, with help text saying what each does.

## Rulings made while writing (owner to confirm)

1. **Denominator of "N of M shown".** M counts the bookings a side confirmed whose start has passed and which closed as `ended` or `no_show`, or as `cancelled` by that same side late and not excused. N counts the bookings in M where that side's `peak_present >= SHOWN_MIN` (4).
   - Bookings cancelled early, or by the system or staff, are in neither count.
   - An excused no-show or late cancel drops out of M.
2. **One excuse mechanism for both marks.** `booking_sides.excused_at / excused_by / excuse_note` excuse whatever that side's mark is on that booking (late cancel or no-show).
   - The other side's captain or co-captain can excuse a **late cancel** only.
   - Staff can excuse either. A staff excuse of a no-show covers "a crash was nobody's fault".
3. The spec's **"Cancel button on the Discord reminder"** becomes a second link button, `Cancel`, on the 60 and 15 minute reminder DMs. It opens `/booking/<id>?cancel=1`, which opens the cancel confirm. DMs carry no interactive buttons today, and a link keeps the cancel in one place.
4. **Re-post** is offered on a cancelled scrim booking that came from a post (`scrim_posts.booking_id`) to either side's managers. It creates a fresh public post for the re-poster's own side, with the booking's start, length and playlist (up to the post's campaign limit; extra campaigns are dropped). A start that is too close or past refuses with plan 1's errors, and the form shows them.
5. **Reviews.**
   - Open for 7 days after the booking closes as `ended` or `no_show`.
   - One per reviewing side, by its captain or co-captain (team) or its captain (pickup).
   - Editable until the window closes.
   - The aggregate needs at least 3 reviews before any percentage is shown; under that it reads "Not enough reviews yet".
6. **The toxic flag:** 3 or more `toxic` tags from distinct bookings within 60 days, against a team or a pickup captain. It shows on the staff People desk player view (for the pickup captain, and for each team the player is currently in) and on the admin Bookings panel.
7. **Scrim night settings:**
   - `scrim_night_day` (choice: off, monday..sunday; default off);
   - `scrim_night_start_utc` (string `HH:MM`, default `21:00`);
   - `scrim_night_hours` (int 1..12, default 4).

   The Discord reminder goes to the scrims channel once per week, 2 hours before the window opens, only when `competitivePublic` and the channel are set. The `discord_messages` kind is `scrim_night` and its ref is the window's start ISO, so a restart never posts twice.

## Not in this plan

Standing scrims, one-click rebook of a finished scrim, private replay notes, suggestions, a public review score, and a reliability badge on Discord cards.

## Review Focus

- **Privacy:**
  - A non-staff, non-member viewer must never get reliability (while the setting is off), individual reviews, tags or the toxic flag from any endpoint. That includes the team page, the board, a post, a booking view and `/api/bookings/mine`.
  - Test every such response.
- **Double counting and races:**
  - Excusing twice, excusing your own cancel, excusing an early (unrecorded) cancel, and a review submitted twice or after the window must all refuse cleanly or change nothing.
- **Allowance:** an excused no-show must stop lowering `allowance` at once.
- **Pickup rule:** a pickup captain's record follows the captain across different pickup groups and bookings. A team record never includes the captain's pickup bookings, and the reverse holds too.
- **Clock and time zones:** the late-cancel boundary is exactly `scrim_late_cancel_hours` before the start. The scrim night window crosses midnight UTC (21:00 + 4 h ends 01:00 the next day) and must work in both the banner and the board highlight. Pin the clock with `vi.useFakeTimers` or by passing `now`; never rely on the real clock.

---

### Task 1: Late cancels, excuses and the reliability record (site side)

**Files:**
- `src/db.ts`
- `src/settingsSchema.ts`
- `src/bookings/bookings.ts`
- `src/bookings/rules.ts`
- `src/bookings/messages.ts`
- `src/bookings/runner.ts` (only if the cancel notice is sent there)
- `src/routes/bookings.ts`
- `src/routes/adminBookings.ts`
- new `src/scrims/reliability.ts`
- tests: `tests/scrimReliability.test.ts`, `tests/bookings.test.ts`, `tests/bookingRoutes.test.ts`

**Interfaces:**
- **New `booking_sides` columns** (via `ensureColumn`): `excused_at TEXT`, `excused_by TEXT`, `excuse_note TEXT`.
- **Settings:**
  - `scrim_late_cancel_hours` '2' (int 0..24). Help: "A side that cancels a booked scrim less than this long before the start gets a late cancel on its record, unless the other side or staff excuse it. 0 means never."
  - `scrim_reliability_public` 'off' (choice: off/on). Help: "Off: a side's scrim record is shown only to staff and to the side itself. On: everyone sees a Reliable badge on posts and team pages."
- **`isLateCancel(db, b: BookingRow): boolean`** is true when all of these hold:
  - `state = 'cancelled'`;
  - `end_reason = 'cancelled'`, so staff and system cancels are excluded;
  - `cancel_side` is set;
  - `ending_at` (the cancel time) is less than `scrim_late_cancel_hours` before `starts_at`.
- **`excuseMark(db, o: { bookingId; by; staff?: boolean; side?: Side; note?: unknown; now? }): Result<{ side: Side }>`:**
  - A non-staff caller excuses the late cancel of the *other* side. The caller must be in `actingSides` for the side that did not cancel, and the booking must be a late cancel. Otherwise it fails `not_manager` or `wrong_state`.
  - Staff pass `side` and may excuse that side's late cancel or no-show; a side with neither mark gets `wrong_state`.
  - Already excused returns `already_excused` (a new error, status 409, with text "That is already excused.").
  - The note is trimmed to 200 characters.
  - Writes a `booking_events` row `excused` with `{ side, staff }`.
- **`recentNoShows`** adds `AND s.excused_at IS NULL`.
- **`src/scrims/reliability.ts`:**
  - `reliability(db, party: Party, nowMs?): { shown: number; booked: number; noShows: number; lateCancels: number; excused: number }`, following Ruling 1. The counts cover all time; the allowance still uses its own 30 days.
  - `canSeeReliability(db, party, viewer: string | null): boolean` is true for staff (`is_admin` or `is_mod`), for a current member of the team, for the pickup captain themselves, or for anyone when the setting is on.
- **`bookingView`** gains, per side:
  - `lateCancel: boolean` and `excused: boolean`;
  - `canExcuse: boolean`, true for the viewer when the viewer is a manager of the other side and the mark is an unexcused late cancel;
  - `record`, which holds the side's `reliability` only when `canSeeReliability`, and is otherwise omitted.
- **Routes:**
  - `POST /api/bookings/:id/excuse` for a manager;
  - `POST /api/admin/bookings/:id/excuse` with `{ side, note }` for staff.

  Both return the refreshed view, as the other booking actions do.
- **The cancel notice to the other side:**
  - When the cancel is late, `booking_cancelled` DM content adds: "This is a late cancel. If it is fine with you, excuse it on the booking page so it does not count against them." It keeps the existing link button.
  - The cancel notice says who cancelled only by side name, as today.
- **Reminder DMs** (`booking_starting`) gain a second link button, `Cancel`, pointing to `${publicUrl}/booking/<id>?cancel=1` (Ruling 3).

- [ ] Steps: failing tests first, then the implementation. Run the covering tests and the typecheck, then the full suite. Commit `Scrims: late cancels are recorded and can be excused, and a side's reliability record is computed from its bookings`.

Tests to write:
- `isLateCancel`:
  - just inside versus just outside the hours boundary;
  - a staff cancel and a `no_server` cancel are never late.
- `reliability`:
  - mixed history: shown, no-show, early cancel, late cancel, excused late cancel, excused no-show;
  - the pickup captain across two different pickup bookings;
  - team bookings never mixed into the captain's pickup record.
- `excuseMark` refusals:
  - excusing your own side's cancel;
  - excusing an early cancel;
  - excusing twice;
  - a non-manager;
  - staff excusing a no-show.
- `allowance`: rises again after a staff excuse of a recent no-show.
- `bookingView`:
  - `record` is present for a member of the side and for staff;
  - it is absent for the other side's members and for strangers while the setting is off;
  - it is present for anyone when the setting is on.
- Route tests for both excuse endpoints, plus the late-cancel DM wording and the reminder's Cancel button.

---

### Task 2: Reliability and excuses on the web

**Files:**
- web pages: `web/src/routes/Booking.tsx`, `Team.tsx`, `Bookings.tsx`, `Scrims.tsx`
- admin: the People desk player view (find it from `web/src/routes/admin/adminRoutes.ts` key `people`) and `web/src/routes/admin/BookingsPanel.tsx`
- `web/src/api.ts`
- their tests
- server routes:
  - `src/routes/teams.ts` (the team view gains `record` for members only);
  - `src/routes/bookings.ts` (`/api/bookings/mine` gains the viewer's own pickup `record`);
  - `src/routes/admin.ts` (the `playerDetail` route gains `scrimRecord` for the player as a pickup captain, plus each current team's record)
- `src/scrims/scrims.ts` (`board()` gains a `record` on each post only when `scrim_reliability_public` is on)
- tests for each server change

**Interfaces:**
- **Booking page:**
  - A cancelled booking with a late cancel shows "Late cancel by <side>" and, when `canExcuse`, a button "All good, no hard feelings". It posts `/excuse` and then shows "Excused".
  - Staff see an "Excuse" control per marked side, with an optional note.
  - The `?cancel=1` query opens the existing cancel confirm at once when the viewer may cancel; otherwise it is ignored.
- **Record line:** wherever `record` is present, it shows "Shown N of M" plus, only when non-zero, "No-shows N" and "Late cancels N". Under 3 booked it reads "New".
  - The team page shows it in the team's Scrims section, for members.
  - The Bookings page shows "Your pickup record" for a captain with any pickup bookings.
  - The admin People desk shows the player's pickup record and each current team's record under a "Scrims" heading.
  - When the setting is on, board rows show the badge "Reliable: N of M shown", or "New".
- Phone width at 390 px must not overflow.

- [ ] Steps: failing tests first (the web tests mock the api as the existing page tests do, and the server tests extend the existing route tests), then the implementation. Then the typecheck, `cd web && npm run build`, and the full suite. Commit `Scrims: the reliability record shows to staff and the side itself, and the other side can excuse a late cancel`.

Tests to write:
- The excuse button shows and posts.
- `?cancel=1` opens the confirm.
- The record line renders "New" under 3 booked.
- The team view `record` is absent for a non-member while the setting is off.
- Board posts carry `record` only when the setting is on.
- Admin player detail includes `scrimRecord`.

---

### Task 3: Re-post a cancelled scrim

**Files:**
- `src/scrims/scrims.ts`
- `src/routes/scrims.ts`
- `src/bookings/bookings.ts` (`bookingView` adds `repost: { allowed: boolean }` for the viewer)
- `web/src/routes/Booking.tsx`
- `web/src/api.ts`
- tests

**Interfaces:**
- **`repostFromBooking(db, o: { bookingId; by; now? }): ScrimResult<{ id: number }>`:**
  - The booking must be `cancelled`, with `purpose = 'scrim'`, and must come from a post (`scrim_posts.booking_id = bookingId`).
  - `by` must manage one of its sides (`managedSides`), even an unconfirmed one. Staff are not included unless they manage a side.
  - It builds the new post for the caller's side: the team when the side is a team, otherwise a pickup with the caller as captain. It uses the booking's `starts_at`, its length in minutes, `playlist_json` trimmed to the post campaign limit, the original post's `sr_range`, and an empty note.
  - It calls the same `createPost`, so every plan 1 rule applies: the too-late cutoff, the allowance, the three-open-posts limit and capacity. Its refusal is returned unchanged.
  - The original post stays `booked`. The new post records nothing back to the old one.
- **Route:** `POST /api/scrims/repost/:bookingId`, gated like the other scrim routes. It returns `{ id }` (201) or the refusal with `text` (and `nearestSlot` on `no_capacity`).
- **Booking page:** a "Re-post this scrim" button when `repost.allowed`. On success it routes to `/scrims?post=<id>`; a refusal shows its text.

- [ ] Steps: failing tests first, then the implementation, the covering tests, the typecheck, the web build and the full suite. Commit `Scrims: either side can re-post a cancelled scrim in one click`.

Tests to write:
- The poster side re-posts.
- The accepter side re-posts as its own side.
- A start too close refuses with `too_late`.
- A booking not from a post refuses.
- A non-manager refuses.
- The playlist is trimmed to the limit.
- The web button routes on success and shows the text on refusal.

---

### Task 4: Private reviews (site side)

**Files:**
- `src/db.ts`
- new `src/scrims/reviews.ts`
- `src/notify/notify.ts`
- `src/bookings/messages.ts` (or a scrims message helper, whichever already renders booking DMs)
- `src/bookings/runner.ts` (the settle path sends the review DM)
- `src/routes/bookings.ts`
- `src/routes/teams.ts`
- `src/routes/admin.ts`
- `src/routes/adminBookings.ts`
- tests: `tests/scrimReviews.test.ts`, plus route tests

**Interfaces:**
- **Table `scrim_reviews`:**
  - columns: `id`, `booking_id` (references bookings), `by_side` ('a'|'b'), `reviewer` (steamid), `thumbs` (1 or -1), `tags_json` (array), `created_at`, `updated_at`;
  - `UNIQUE (booking_id, by_side)`;
  - index on `booking_id`.
- **`REVIEW_TAGS = ['on_time', 'good_comms', 'good_sport', 'left_early', 'toxic']`**, with labels "On time", "Good comms", "Good sport", "Left early", "Toxic".
- **`submitReview(db, o: { bookingId; by; thumbs: unknown; tags: unknown; now? }): Result<{ side: Side }>`:**
  - The booking must be `purpose = 'scrim'`, closed as `ended` or `no_show`, within 7 days of `ended_at` (Ruling 5).
  - `by` must be in `actingSides`, and the review is for the first such side.
  - `thumbs` must be 1 or -1.
  - Tags must be a de-duplicated subset of `REVIEW_TAGS`, at most 5.
  - An upsert on `(booking_id, by_side)`, so a second submit edits.
  - Refusal codes: `wrong_state`, `not_manager`, `bad_review`, `review_closed`.
- **Aggregates:**
  - `reviewSummary(db, party: Party): { count: number; positivePct: number | null; topTag: string | null }` covers reviews *received* by the party: reviews written by the other side of a booking where the party was a side. `positivePct` is null under 3 reviews.
  - `toxicFlag(db, party, nowMs): boolean` follows Ruling 6.
  - `staffReviews(db, bookingId)` returns the individual rows, for staff only.
- **`bookingView`** gains, for the viewer:
  - `review: { open: boolean; mine: { thumbs; tags } | null }`, when the viewer manages a side and the window is open;
  - for staff only, `reviews` (both sides' rows).
- **Routes:**
  - `POST /api/bookings/:id/review` with `{ thumbs, tags }`;
  - the team view adds `reviews: reviewSummary` for members only;
  - admin player detail adds `scrimReviews` (summaries and toxic flags for the pickup captain and each current team);
  - the admin Bookings panel list adds `toxic: true` flags.
- **DM:**
  - The new `NotifyType` is `scrim_review`, with label "Review my scrim opponent after a booked scrim".
  - When a scrim booking closes as `ended` or `no_show`, each side's managers get: "How was <other side>? Leave a quick private review on the booking page. Only staff see single reviews." It has the "Open the booking" link button.
  - It is sent once from the place where settle runs for ended bookings. A `booking_events` row `review_asked` guards against a second send.

- [ ] Steps: failing tests first, then the implementation, the covering tests, the typecheck and the full suite. Commit `Scrims: captains can leave a private review of their opponent, teams see only their own aggregate, and repeated toxic tags flag for staff`.

Tests to write:
- Submit:
  - submit, then edit;
  - after 7 days it is `review_closed`;
  - a non-manager is refused;
  - bad tags and bad thumbs are refused;
  - a cancelled booking is `wrong_state`.
- Aggregates:
  - `reviewSummary` is null under 3 and has the right percentage and top tag at 3 and above;
  - `toxicFlag` at 3 distinct bookings in 60 days, and not with 2 or with old ones.
- **Privacy:**
  - the booking view for a non-staff viewer never contains `reviews` or any other side's review;
  - the team view for a non-member has no `reviews`;
  - admin routes require staff.
- The review DM goes once per side, never twice after a second settle.

---

### Task 5: Reviews on the web

**Files:**
- `web/src/routes/Booking.tsx`
- `web/src/routes/Team.tsx`
- the People desk player view
- `web/src/routes/admin/BookingsPanel.tsx`
- `web/src/api.ts`
- their tests

**Interfaces:**
- **Booking page:**
  - When `review.open`, a "Review <other side>" card shows: thumbs up and down buttons, tag toggles with the labels above, and a Save button. It is pre-filled from `mine`, and saving shows "Saved. Only staff see single reviews."
  - Staff see both sides' reviews in a small staff-only block.
- **Team page (members):** "Opponents' reviews: 92% positive, top tag: On time", or "Not enough reviews yet".
- **Admin:**
  - The People desk "Scrims" heading adds review summaries and a red "Toxic tags" flag.
  - The Bookings panel shows a "Toxic tags" chip on flagged sides.
- Phone width at 390 px.

- [ ] Steps: failing tests first, then the implementation, the web tests, the typecheck, the web build and the full suite. Commit `Scrims: the review card on booked scrims, team review aggregates for members, and toxic flags on the staff desks`.

Tests to write:
- The review card posts thumbs and tags, and pre-fills from `mine`.
- The card is absent when `review` is missing.
- The staff block shows only when `reviews` is present.
- The team aggregate wording, including under 3 reviews.

---

### Task 6: Scrim night

**Files:**
- `src/settingsSchema.ts`
- new `src/scrims/night.ts`
- `src/scrims/scrims.ts` (`board()` includes `night`)
- `src/routes/scrims.ts` (`/api/scrims/options` or the board payload carries the window)
- `src/scrims/poster.ts` (the weekly reminder)
- `web/src/routes/Scrims.tsx`
- `web/src/api.ts`
- tests

**Interfaces:**
- Settings as in Ruling 7. Help for `scrim_night_day`: "A weekly scrim night to cluster activity: a banner on the scrim board, posts inside it highlighted, and a reminder in the scrims channel 2 hours before. Off hides it."
- **`nightWindow(db, nowMs): { startsAt: string; endsAt: string } | null`** is the next or current window: the configured weekday and time in UTC, lasting the configured hours, possibly crossing midnight. If now is inside a window, it returns that one. It returns null when the day is off or the time setting does not parse.
- **`inNight(db, startsAtIso): boolean`** is true when a post's start falls inside any weekly occurrence of the window.
- **Board payload:**
  - `night: { startsAt, endsAt } | null`;
  - each post gains `night: boolean`.
- **Web:**
  - A banner above the board reads "Scrim night: <weekday> <local start>-<local end> (your time)", plus "On now" while it is running.
  - Posts in the window get a highlighted row (a class plus a small "Scrim night" tag).
- **`ScrimPoster`:**
  - Each tick, when `competitivePublic`, the channel is set, and now is within 2 hours before `nightWindow().startsAt` (but not after it), it sends "Scrim night starts in about 2 hours (<discord timestamp>). Post or accept a scrim: <publicUrl>/scrims" once.
  - It records the send in `discord_messages`, with kind `scrim_night`, ref = startsAt and state `closed`, so a restart does not repeat it.
  - A send failure is logged and retried next tick.

- [ ] Steps: failing tests first (pin the clock), then the implementation, the covering tests, the typecheck, the web build and the full suite. Commit `Scrims: an optional weekly scrim night with a board banner, highlighted posts and a Discord reminder`.

Tests to write:
- `nightWindow`:
  - off gives null;
  - Thursday 21:00 + 4 h computed from a Wednesday, from inside the window (just after midnight Friday UTC), and from just after it ends;
  - a bad time string gives null.
- `inNight` across the midnight wrap.
- The reminder:
  - sends exactly once, even across a fresh poster instance (restart);
  - is not sent when not public or with no channel;
  - a failed send retries.
- The web banner and the row highlight.

---

## After the last task

Full suite, typecheck and web build, then the whole-branch review.

Owner hand-off:
- Decide whether `scrim_reliability_public` stays off.
- Set the scrim night day if wanted.
- Check the review DM wording.
