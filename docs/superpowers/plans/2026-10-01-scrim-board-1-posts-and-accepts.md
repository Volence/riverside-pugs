# Scrim board plan 1: posts, the board, accepts, and booking on confirm

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A captain posts "looking for scrim" for a time slot: the side, the length, up to 4 campaigns, an SR range, and a note. Other captains see it on `/scrims` and accept it, adding up to 2 campaigns of their own. The poster sees each acceptance with the playlist it would make, and confirms one; that books the server (plan 4a booking, both sides confirmed). The others are told the slot is taken. Public posts also get a card in a Discord `#scrims` channel with a link to the site. A direct challenge to one team goes only to that team's captain and co-captains.

**Architecture:**
- Two tables, `scrim_posts` and `scrim_accepts`.
- Pure helpers (`src/scrims/rules.ts`): side SR, the alternating playlist trimmed to fit, and the nearest free slot.
- One domain module (`src/scrims/scrims.ts`). Every write is a transaction with the same `{ ok, value } | { ok, error }` shape as bookings.
- Confirming an acceptance calls the booking domain in the same transaction: `createBooking` by the poster, then `confirmBooking` by the accepter. That reuses every booking rule (capacity, allowance, playlist, people snapshot).
- The routes notify through the existing `Notifier`.
- A minute `ScrimBoard` tick expires posts and acceptances.
- `ScrimPoster` keeps one Discord card per public post in the `discord_messages` table (kind `scrim`). It edits the card when the post changes and retries on the next tick when the bot is away, the same pattern as `ReportButton`.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, vitest; Preact web.

**Spec:** `docs/superpowers/specs/2026-09-30-competitive-scrims-design.md`, sections 1 (posts) and 2 (accepting and campaign requests), Error handling (one transaction; nearest free slot on a capacity change), and Rollout plan 1. Builds on foundation plans 3 (teams) and 4a-4c (bookings).

## Global Constraints

- `scrim_posts`: id, side kind (`team` | `pickup`), team_id (null for pickup), captain_steamid, region, starts_at, block_minutes, campaigns_json (the poster's picks, up to 4), sr_range (± around the side's average, or open), note, status (`open`, `pending`, `booked`, `expired`, `withdrawn`), created_at, target_team_id (null = public; set = a direct challenge).
- Posting checks the slot's capacity (foundation capacity rule) and the side's booking allowance up front, so a post can always be booked.
- Board `/scrims`: open posts filtered by time (shown in the viewer's time zone) and by SR range fit. Each post shows the side (a team badge with logo, or Pickup), average SR, time, length and campaigns.
- Discord: each public post gets a card in a `#scrims` channel (setting) with an Accept button that deep-links to the site. A direct challenge goes only to the target team's captain and co-captains, by DM and site notice.
- Posts expire at their start time; the poster can withdraw any time before acceptance.
- The accepting captain picks their side (a team they captain, or a pickup group) and may add up to 2 campaigns of their own (setting), or accept the poster's list as it is.
- The post goes `pending`. The poster sees the proposed playlist: campaigns alternate between the two sides' picks (poster first), trimmed to what fits the block, with the foundation's time warning. The poster confirms or declines.
- On confirm, the booking is created (foundation, purpose `scrim`), and both sides get connect details closer to the start, voice channels and reminders (all from 4a-4c).
- Several sides can accept the same post; the poster picks one and the others are told it is taken.
- A pending acceptance times out after 2 hours without an answer, or 30 minutes before the start.
- Accept, confirm and booking creation are one transaction. If the capacity changed in between, the confirm re-checks and, when the slot is gone, offers the nearest free slot to both captains instead of failing silently.
- Everything sits behind `competitive_enabled` (staff always pass, as for bookings). Never write em dashes. Plain-sentence commits. Never push, deploy, or touch Discord or live servers.

## Rulings (owner to confirm)

1. **Side SR** is the average current-season display SR (`displaySr`) of the team's active members, or of the pickup captain alone. A player with no rating counts as the season's starting SR. The SR range is a whole number from 50 to 1000, or open.
2. **"Fits my SR"** on the board uses the viewer's own side choice: the first team they captain, else their own SR. It is a filter the viewer can turn off, not a wall. Accepting is allowed even outside the range, which then shows a note to the poster.
3. **The alternating playlist** takes the poster's picks and the accepter's picks in turn, poster first, skipping duplicates. It keeps campaigns while the typical minutes (`playlistMinutes`) fit `block_minutes`, always keeps at least one, and never exceeds `booking_playlist_max`.
4. **Nearest free slot** searches 30 minute steps up to 3 hours either side of the post's start, closest first, for a slot with capacity for the same length. It is offered in the refusal; nothing is booked automatically.
5. **Discord card:** posted when a public post opens, edited on every status change, and edited to a closed line (not deleted) when the post is booked, withdrawn or expired. A direct challenge never gets a card.
6. **Settings:** `discord_scrims_channel_id` (empty means no cards) and `scrim_accept_campaigns_max` (default 2, 0..4).

## Review Focus

- A post or acceptance by someone who is not a manager of the side they name, or for a team they left, must be refused.
- Confirm must create the booking with both sides confirmed in one go. If any booking rule refuses (capacity, allowance, a captain who lost rights), nothing changes: the post stays pending and the acceptance stays.
- A direct challenge must never appear on the public board or in Discord, or to anyone but the target team's managers and the poster.
- The tick expiring an acceptance at T-30 and a post at its start must not race a confirm (the confirm re-checks the state inside its transaction).
- Player text (notes) must pass the slur filter and never reach Discord unescaped.

---

### Task 1: Schema, settings, notify types, rules

**Files:** `src/db.ts`, `src/settingsSchema.ts`, `src/notify/notify.ts`, `src/scrims/rules.ts` (new), `src/mergePlayers.ts`, tests `tests/scrimRules.test.ts`, `tests/scrimsSchema.test.ts`.

**Interfaces:**
- **`scrim_posts`:**
  - Columns: id, side_kind TEXT CHECK in ('team','pickup'), team_id INTEGER REFERENCES teams(id), captain_steamid TEXT NOT NULL REFERENCES players(steamid), region TEXT NOT NULL DEFAULT 'na', starts_at TEXT NOT NULL, block_minutes INTEGER NOT NULL, campaigns_json TEXT NOT NULL, sr_range INTEGER (null = open), note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open' CHECK in (open, pending, booked, expired, withdrawn), created_at TEXT NOT NULL, target_team_id INTEGER REFERENCES teams(id), booking_id INTEGER REFERENCES bookings(id).
  - Index on (status, starts_at).
- **`scrim_accepts`:**
  - Columns: id, post_id INTEGER NOT NULL REFERENCES scrim_posts(id), side_kind, team_id, captain_steamid NOT NULL, campaigns_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending' CHECK in (pending, chosen, declined, expired, withdrawn), created_at, responded_at.
  - Index on (post_id, status).
- **Merge lists:** both captain columns are PLAIN.
- **Settings:** `discord_scrims_channel_id` (group Discord, string, may be empty) and `scrim_accept_campaigns_max` ('2', int 0..4, group Competitive), each with help text.
- **NotifyType gains:** `scrim_challenge`, `scrim_accepted`, `scrim_booked`, `scrim_taken`, `scrim_declined`, with labels.
- **`src/scrims/rules.ts`:**
  - `sideSr(db, side: { teamId: number } | { captain: string }): number` (ruling 1).
  - `srFits(postSr, range, sr): boolean`.
  - `proposedPlaylist(db, posterPicks: string[], accepterPicks: string[], blockMinutes: number): { playlist: string[]; minutes: number; fits: boolean }` (ruling 3).
  - `nearestFreeSlot(db, region, startMs, minutes): string | null` (ruling 4, ISO).

- [ ] Steps: failing tests, then implement, then the covering tests, typecheck and full suite. Commit `Scrim board: tables, settings, notification types and the playlist, SR and free-slot rules`.

Tests:
- Schema checks.
- `sideSr` for a team and for a pickup captain, including an unrated player.
- `srFits` edges.
- `proposedPlaylist`: alternation, dedupe, trimming by typical minutes, at least one kept, the max respected.
- `nearestFreeSlot` returns the closest free slot, or null when nothing is free within 3 hours.

---

### Task 2: The scrim domain

**Files:** `src/scrims/scrims.ts` (new), `tests/scrims.test.ts`.

**Interfaces:**
- `SCRIM_ERRORS` and `ScrimResult<T>` follow the shape bookings use.

**Post and accept:**
- `createPost(db, { by, teamId?, startsAt, minutes, campaigns, srRange, note, targetTeamId?, now? }): ScrimResult<{ id }>`:
  - Rights are the same as `createBooking` side A: a team manager, or anyone for a pickup post.
  - The time and length use the booking limits.
  - Campaigns come from the pool, 1..`booking_playlist_max`.
  - `srRange` is null or an integer 50..1000.
  - The note is trimmed, at most 200 characters, and passes `findSlurs`.
  - A target team must be live and not the poster's own team.
  - The slot's capacity (`capacityProblem`) and the side's `allowance` are checked up front.
- `withdrawPost(db, { postId, by })`: the poster side's manager may withdraw before `booked`. Pending acceptances become `withdrawn`.
- `acceptPost(db, { postId, by, teamId?, campaigns?, now? })`:
  - The post must be open or pending, not the poster's own side, and not a team already accepting it.
  - For a direct challenge, `by` must manage the target team, and `teamId` must be that team.
  - `campaigns` holds up to `scrim_accept_campaigns_max` pool slugs.
  - The post becomes `pending`.
  - The result includes whether the accepter's SR fits.
- `withdrawAccept(db, { acceptId, by })`: the accepter withdraws. When no acceptance is left pending, the post goes back to `open`.

**Decide:**
- `declineAccept(db, { acceptId, by })`: the poster's manager declines. When no acceptance is left pending, the post goes back to `open`.
- `confirmAccept(db, { acceptId, by, now? }): ScrimResult<{ bookingId: number; takenAcceptIds: number[] }>`, in one transaction:
  1. Re-check that the post is pending, the acceptance is pending, and `by` manages the poster's side.
  2. Build the playlist with `proposedPlaylist`.
  3. Call `createBooking` with `by` = the poster's manager (`teamId` = the post's team, or none for pickup) and `opponent` = `{ teamId }` or `{ steamid: accepter captain }`, using the post's start and minutes and that playlist.
  4. Then call `confirmBooking` with `by` = the acceptance's captain.
  5. If either step refuses, throw inside the transaction so nothing is kept, and return that error. For `no_capacity`, also return `nearestFreeSlot` in the error payload.
  6. On success: the post becomes `booked` with its `booking_id`, the chosen acceptance becomes `chosen`, and every other pending acceptance becomes `declined`, with their ids returned for notices.

**Expire and read:**
- `expire(db, now): { posts: number[]; accepts: number[] }`: open or pending posts at or past their start become `expired`, and so do their pending acceptances. Pending acceptances older than 2 hours, or past start minus 30 minutes, become `expired`. A post left with none pending goes back to `open`.
- `board(db, viewer: { steamid: string | null; staff: boolean }, opts: { fitsOnly?: boolean }): BoardPost[]`:
  - Lists open and pending public posts, plus direct challenges aimed at a team the viewer manages.
  - It also lists the viewer's own posts.
  - Each entry has the side (team badge fields or Pickup), average SR, time, length, campaigns, note, and acceptance count. The poster also gets each acceptance with its proposed playlist and fit warning.
  - `fitsOnly` filters by ruling 2.

- [ ] Steps: tests for every rule and refusal above. Include a race test: a post at its start expired by `expire`, then `confirmAccept` refused with `wrong_state`. Include a `no_capacity` confirm returning the nearest slot, with the post and acceptance unchanged. Then implement and run. Commit `Scrim board: posts, accepts and a confirm that books the server in one step`.

---

### Task 3: Routes, notices and the minute tick

**Files:** `src/routes/scrims.ts` (new), `src/scrims/board.ts` (new: `ScrimBoard` tick class), `src/server.ts`, `src/bookings/messages.ts` or a new `src/scrims/messages.ts` (DM text), tests `tests/scrimRoutes.test.ts`.

**Interfaces:**
- Routes (closed switch answers 404, except for staff):
  - `GET /api/scrims`: the board, with query `fitsOnly=1`.
  - `POST /api/scrims`: create a post.
  - `POST /api/scrims/:id/withdraw`
  - `POST /api/scrims/:id/accept`: body `{ teamId?, campaigns? }`.
  - `POST /api/scrims/accepts/:id/withdraw`
  - `POST /api/scrims/accepts/:id/decline`
  - `POST /api/scrims/accepts/:id/confirm`: answers `{ bookingId }` or the error, with `nearestSlot` when the slot is gone.
  - `GET /api/scrims/options`: campaigns with their typical minutes, the limits, the teams the viewer manages, and live teams for challenges.
- Notices through `Notifier`:
  - A challenge goes to the target team's managers (`scrim_challenge`).
  - Each acceptance goes to the poster's managers (`scrim_accepted`).
  - A confirm goes to both sides' managers (`scrim_booked`, with a link to `/booking/<id>`) and also runs the booking runner's `onCreated`/`onConfirmed`/`allocate` hooks the way the booking routes do.
  - Each declined or taken acceptance goes to its captain (`scrim_taken` or `scrim_declined`).
- `ScrimBoard`: a minute tick calls `expire()` and tells the affected accepters (`scrim_declined` with reason "it expired"). It also calls `poster.tickNow()` when a poster exists. It is built in `server.ts` next to the booking runner, with a cleared interval on close.

- [ ] Steps: route tests for the switch, rights, a confirm creating a booking visible on `/api/bookings/:id` with both sides confirmed, a direct challenge invisible to a stranger, and the notices (count the DMs with the fake notifier). Then implement and run. Commit `Scrim board: routes, notices and the minute expiry`.

---

### Task 4: Discord cards

**Files:** `src/scrims/poster.ts` (new), `src/server.ts` (built in `onConnected`, stopped on close), tests `tests/scrimPoster.test.ts` with `tests/fakes/fakeTransport.ts`.

**Interfaces:**
- `class ScrimPoster { constructor({ db, transport, publicUrl }); start(); stop(); tickNow(): Promise<void> }`:
  - **Posting:** for each open or pending public post with no card and a channel set, it sends the card and saves it with `saveMessage(db, { kind: 'scrim', ref: String(id), channelId, messageId })`.
  - **Editing:** for each post with a card whose rendered payload hash changed, it edits the card in its stored channel. If the message is gone (`edit` returns false) it sends again. If `edit` throws, it keeps the old hash and retries next tick, the same as `ReportButton`. The hash is stored in memory, keyed by post id.
  - **Closing:** booked, withdrawn and expired posts are edited to the closed line once, and the row's state is set to `closed`.
- **Card content** (ruling 5):
  - The title is the side name, escaped with `escapeName`.
  - Fields: when, as a Discord timestamp `<t:unix:F>` so every reader sees their own time zone; the length; the campaigns (names); the average SR and the range; the note, escaped.
  - One link button, "Accept on the site", to `<publicUrl>/scrims?post=<id>`.
  - The closed version says "Booked", "Withdrawn" or "Expired" with no button.

- [ ] Steps: tests on the fake transport:
  - A card is posted for a public post and never for a challenge.
  - An edit on status change.
  - The closed edit happens once.
  - A blank channel posts nothing.
  - A failed edit retries on the next tick.
  - A deleted message is reposted.
  - Notes are escaped.

  Then implement and wire it. Commit `Scrim board: a Discord card for each public post, kept in step with the post`.

---

### Task 5: The `/scrims` page

**Files:** `web/src/api.ts` (`scrimsApi`), `web/src/routes/Scrims.tsx` (new), `web/src/AppRoutes.tsx`, `web/src/components/Nav.tsx` (a "Scrims" link next to Teams and Bookings for `me.teams`), `web/src/styles/app.css`, tests `web/src/routes/Scrims.test.tsx`.

**Interfaces:** the page has three panels.
1. **"Post a scrim":** side (a team you manage or a pickup group), start (`datetime-local` read in the viewer's zone, reusing `web/src/bookingTime.ts`), length, campaigns with typical minutes and the fit warning, SR range (a select of open, ±100, ±200, ±300, ±500), note, and optional challenge target team.
2. **The board:** open and pending posts as rows in the teams look (a badge or "Pickup", name, avg SR, local time, length, campaigns, note), with a "Fits my SR" toggle. Each row has an Accept button that opens an inline form (pick your side, add up to N campaigns) and posts it. `?post=<id>` scrolls to and highlights that post.
3. **"Your posts":** each acceptance with the accepter, their SR fit, the proposed playlist with its minutes and fit warning, and Confirm / Decline. A confirm success routes to `/booking/<id>`; a `no_capacity` refusal shows the nearest slot. The panel also has Withdraw.

- [ ] Steps: web tests:
  - The board renders and the fit toggle filters.
  - The accept form posts the chosen side and campaigns.
  - Confirm navigates on success and shows the nearest slot on `no_capacity`.
  - `?post=` highlights.
  - The nav link shows only for `me.teams`.

  Then implement, run the web tests, typecheck and build. Commit `Scrim board page: post, browse, accept, and confirm into a booking`.

---

## After the last task

Full suite, typecheck, web build; whole-branch review. Owner hand-off: set `discord_scrims_channel_id`; post a scrim as one admin, accept as another, confirm, and see the booking page.
