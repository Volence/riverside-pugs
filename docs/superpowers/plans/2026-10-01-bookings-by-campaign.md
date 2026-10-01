# Bookings by campaign: book N campaigns, and +1 campaign instead of +30 minutes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People book a number of campaigns, not a length of time.
- Booking a server or posting a scrim means picking campaigns; the time slot follows from them.
- The server lets the two sides play exactly that many campaigns, then closes.
- "Extend" becomes **+1 campaign**, on the site and in game.

**Architecture:**
- `bookings.games_allowed` (new, the campaign count) is the contract.
- `ends_at` stays, but only as a **capacity estimate**: it holds the slot against other bookings. It is computed from the playlist by `estimateMinutes()`.
- The runner closes a booking when its count of finished games reaches `games_allowed` (after a short "gg" grace), and never cuts a live game at `ends_at`.
- `+1 campaign` bumps `games_allowed` and pushes `ends_at` out by one campaign's estimate, capacity permitting.
- The `l4d_booking` plugin gains the `!addcampaign` chat command (with `!extend` kept as an alias). The plugin has not been staged anywhere yet, so this is the version that ships.

**Tech Stack:** TypeScript, better-sqlite3, vitest, Preact; SourcePawn 1.12.

**Spec:** owner request 2026-10-01 ("booking just by number of campaigns ... the server just lets them only play x amount of campaigns ... instead of +30 minutes it just does +1 campaign"). It changes foundation spec section 3 (bookings: length and extension) and scrims spec section 2 (a playlist "trimmed to what fits the block"). The rulings below are the design.

## Global Constraints

- Never write em dashes. Commit messages are plain sentences.
- Do not push, deploy, stage or rcon live boxes. Plugin checks run only on `/home/volence/l4d1-ds`, with the 0-humans gate in the same command, and the box is restored afterwards.
- Migrations are additive and idempotent. Existing bookings keep working: `games_allowed` is backfilled to the playlist length.
- Built `.smx` files are not committed.

## Rulings (owner to confirm)

1. **The length estimate.**
   - `estimateMinutes(db, playlist) = 15 + Σ (typicalCampaignMinutes(c) + 10)`, rounded up to the 30-minute step.
   - The 15 minutes covers setup and ready-up. The 10 minutes per campaign is slack for a slow round.
   - The result must sit within `booking_min_minutes`..`booking_max_minutes`: it is raised to the minimum, and a playlist that needs more than the maximum is refused (`too_long`, with the text "That many campaigns will not fit in one booking; book fewer, and add one later with +1 campaign.").
   - No manual length picker. The forms show "About 2 h 30 for 2 campaigns".
2. **A booking is N campaigns.**
   - `games_allowed` starts as the playlist length.
   - A game counts once it **finishes**: it reaches the game-ended path, as `finishMatch` reports it today. An aborted game does not count.
   - `!stay` (replay) and `!nextmap <other>` are allowed. Each played game uses one of the N, whatever campaign it is.
   - The playlist only gives the default order of the next campaign.
3. **The end.**
   - When the finished-game count reaches `games_allowed`, the server says: "[Booking] That was campaign N of N. Type !addcampaign to play one more, or the server closes in 5 minutes."
   - It closes 5 minutes later (reason `done`) unless a campaign is added.
   - The other ends still apply: everyone left, idle, staff, captains' `!end`.
4. **Time never cuts a live game.**
   - At `ends_at` with a booking game live, the runner does not end the booking. It ends after that game finishes. The "N of N" end still runs, as above.
   - The 30, 10 and 5 minute time warnings are replaced by a single "about 10 minutes of the booked slot left" line, said only between games.
   - If the slot overruns and the box is needed by a later booking, the later booking takes another free box or waits under the existing capacity and protect rules. The slack keeps this rare.
5. **+1 campaign.**
   - It replaces Extend everywhere: the site button "+1 campaign" and the in-game `!addcampaign [campaign]`, with `!extend` kept as an alias that takes no campaign.
   - It adds 1 to `games_allowed`.
   - A named campaign is appended to the playlist. Without one, the captains pick it with `!nextmap` when the time comes, and the default is to replay the last campaign.
   - `ends_at` moves out by `typicalCampaignMinutes(that campaign, or 60) + 10`, rounded to the step, and the move is capacity-checked from the current `ends_at`. When there is no room it is refused with "No server is free for another campaign after this slot."
   - It is allowed while the booking is ready or active, including during the 5-minute closing grace, which it cancels.
   - The `booking_extend_minutes` setting is removed from the schema and the admin page. Its stored row is left in place, unused.
6. **Scrim posts.**
   - A post's `block_minutes` becomes `estimateMinutes(poster's campaigns)`.
   - On accept, the proposed playlist (alternating, poster first) is no longer trimmed to fit a block. Its estimate becomes the booking length at confirm, and the existing confirm-time capacity check (with `nearestSlot`) covers the longer slot.
   - The board and cards show "2 campaigns, about 2 h 30" instead of "2 h".

## Not in this plan

Saved pickup groups (a separate plan), per-campaign pricing of capacity, and changing what counts as a game.

## Review Focus

- **Counting:**
  - an aborted game, a `!stay` replay, and an off-playlist `!nextmap` each count correctly;
  - a game finishing after the 5-minute close has already fired cannot reopen anything.
- **The never-cut rule:** a live game at `ends_at` runs to the end; an idle booking past `ends_at` still ends.
- **+1 during the closing grace** cancels the close exactly once. Two `!addcampaign` at once add 2, each capacity-checked.
- **Backfill:** existing open bookings get `games_allowed` = playlist length and keep their `ends_at`.
- **Scrim confirm** with a longer accepted playlist refuses `no_capacity` with `nearestSlot`, rather than silently trimming.

---

### Task 1: The model, the estimate and +1 campaign (site side)

**Files:**
- `src/db.ts`
- `src/bookings/rules.ts`
- `src/bookings/bookings.ts`
- `src/settingsSchema.ts`
- `src/routes/bookings.ts`
- `src/routes/adminBookings.ts`
- `src/scrims/scrims.ts`
- `src/scrims/rules.ts`
- `src/routes/scrims.ts`
- tests

**Interfaces:**
- **Columns.** `bookings.games_allowed INTEGER NOT NULL DEFAULT 0` via `ensureColumn`. A backfill runs once: `UPDATE bookings SET games_allowed = json_array_length(playlist_json) WHERE games_allowed = 0`. Also `bookings.close_at TEXT` (the 5-minute grace deadline, null when none).
- **`estimateMinutes(db, playlist: string[]): number`**, per Ruling 1, in `rules.ts`.
- **`createBooking`:**
  - drops the `minutes` input (ignored if sent);
  - computes the length with `estimateMinutes`;
  - refuses `too_long` (new `BOOKING_ERRORS` entry, status 400, Ruling 1 text);
  - sets `games_allowed = playlist.length`.
- **`addCampaign(db, o: { bookingId; by; staff?; campaign?: unknown; now? }): Result<{ gamesAllowed: number; endsAt: string; campaign: string | null }>`** replaces `extendBooking`.
  - It is gated like `extendBooking` today.
  - It validates the campaign against the pool, like `parsePlaylist`.
  - It applies Ruling 5, clears `close_at`, and logs a `booking_events` row `campaign_added`.
  - Keep `extendBooking` as a thin wrapper that calls `addCampaign` with no campaign, so old callers compile, or update every caller. Then remove the `booking_extend_minutes` setting.
- **Routes:**
  - `POST /api/bookings/:id/extend` keeps its path and calls `addCampaign` with the body's `campaign`.
  - `GET /api/bookings/options` drops the minute steps, and adds `estimate: { perCampaign: Record<slug, minutes>, base: 15, slack: 10, step: 30, min, max }` so the web can show the estimate live.
- **bookingView** gains `gamesAllowed`, `gamesPlayed` (finished booking games) and `closeAt`.
- **Scrims:**
  - `createPost` derives `block_minutes` from the poster's campaigns and ignores `minutes`.
  - The proposed playlist drops the fit trimming.
  - `confirmAccept` passes the merged playlist to `createBooking`, which computes the length.
  - Board posts gain `campaignCount`.

- [ ] Steps:
  1. Failing tests first.
  2. Implement.
  3. Run the covering tests and the typecheck, then the full suite.
  4. Commit `Bookings: a booking is a number of campaigns, its slot is estimated from them, and +1 campaign replaces extend`.

Tests to write:
- `estimateMinutes`: rounding, the minimum, and `too_long` above the maximum.
- The backfill sets `games_allowed` from existing rows and is idempotent.
- `addCampaign`:
  - bumps the count and `ends_at` by the estimate;
  - is refused without capacity;
  - clears `close_at`;
  - two calls add 2;
  - is refused when not ready/active, or for a non-manager.
- `createBooking` ignores `minutes`.
- Scrims:
  - a post's `block_minutes` comes from its campaigns;
  - an accepted longer playlist confirms into a longer booking, or refuses `no_capacity` with `nearestSlot`.

---

### Task 2: The runner counts campaigns and never cuts a live game

**Files:** `src/bookings/runner.ts`, `src/bookings/messages.ts` (if a line moves), `tests/bookingRunner.test.ts`

**Interfaces:**
- **`onGameEnded`.**
  - After a finished game, count the booking's finished games: matches with this `booking_id` in a completed state. Find the state `finishMatch` writes.
  - If the count is below `games_allowed`, keep today's behaviour and announce the next one. The next campaign is the next playlist entry by count (`playlist[count]`), or the last campaign again when the playlist is shorter than the count.
  - If the count has reached `games_allowed`, set `close_at = now + 5 min` and say the Ruling 3 line.
- **The minute watch.**
  - `ends_at` passed with a live booking game: do nothing.
  - `ends_at` passed with no live game: end with `time`, as today.
  - `close_at` passed with no live game and the count still at or over `games_allowed`: end with `done`.
- **`!nextmap` and `!stay`** are refused when the count has reached `games_allowed`, with "All N campaigns are played. !addcampaign for one more."
- **The `extend` and `addcampaign` commands** come from the plugin as `cmd=extend` (no arg) or `cmd=addcampaign arg=<campaign or empty>`. Both call `addCampaign`, and say "[Booking] +1 campaign: now N to play (until about HH:MM UTC)." or the refusal.
- **Warnings.** Replace `WARN_AT_MINUTES` with one 10-minute warning, said only when no game is live.

- [ ] Steps:
  1. Failing tests first, with the clock pinned.
  2. Implement.
  3. Run the covering tests and the typecheck, then the full suite.
  4. Commit `Bookings: the server closes after the booked number of campaigns, a live game is never cut by the slot end, and !addcampaign adds one`.

Tests to write:
- Two finished games of two: the close line, then a close 5 minutes later.
- An aborted game does not count.
- `!addcampaign` during the grace cancels the close.
- A live game at `ends_at` keeps the booking open, which ends after the game.
- An idle booking past `ends_at` still ends.
- `!stay` and `!nextmap` are refused after N of N.
- A `cmd=addcampaign` with a campaign name appends it to the playlist.

---

### Task 3: The web forms and booking page, plus `l4d_booking` 1.3.0

**Files:**
- `web/src/routes/Bookings.tsx`, `web/src/routes/Booking.tsx`, `web/src/routes/Scrims.tsx`, `web/src/api.ts`, and their tests
- `src/scrims/poster.ts` (the card text)
- `plugin/l4d_booking.sp`
- `plugin/README.md`

**Interfaces:**
- **Book a server and Post a scrim:**
  - remove the Length select;
  - under the campaign checkboxes, show "About 2 h 30 for 2 campaigns", computed live from `options.estimate`;
  - when the estimate is above the maximum, show the `too_long` text and disable submit.
- **The booking page:**
  - shows "Campaign 1 of 2", from `gamesPlayed` and `gamesAllowed` (the next one to play), or "All 2 campaigns played" when done;
  - shows "Closing in about 5 minutes" while `closeAt` is set;
  - the Extend button becomes "+1 campaign", with an optional campaign select (default "pick later"), and it posts `{ campaign }`.
- **Board rows and Discord cards** read "2 campaigns, about 2 h 30".
- **Plugin `l4d_booking` 1.3.0:**
  - the chat command `!addcampaign [name]` emits `PUGBOOK event=cmd cmd=addcampaign steamid=<id> arg=<sanitized name>`;
  - `!extend` keeps emitting `cmd=extend`;
  - the help text lists `!addcampaign`.
  - Build it with `plugin/build-booking.sh`. Check on the local server with the usual 0-humans gate, then load it and confirm with `sm_booking_cmd` / `sm_booking_status` that it still loads. The chat path needs a real client and is left for the owner's live test.

- [ ] Steps:
  1. Failing web tests first.
  2. Implement.
  3. Run the web tests and the typecheck, the web build, the plugin build and the local load check, then the full suite.
  4. Commit `Bookings: forms pick campaigns and show the estimated slot, the booking page counts campaigns with +1 campaign, and l4d_booking 1.3.0 adds !addcampaign`.

Tests to write:
- The estimate line updates as campaigns are ticked, and `too_long` disables submit.
- The booking page shows the count, the closing line, and "+1 campaign" posting a campaign.
- The board row text.

---

## After the last task

Full suite, typecheck and build, then the whole-branch review.

Owner hand-off: stage `l4d_booking` 1.3.0, not 1.2.1. In the live test, play a 1-campaign booking to the end, then try `!addcampaign`.
