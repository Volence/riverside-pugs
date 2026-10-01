# Competitive foundation plan 4c: voice, the team Scrims tab, and casters

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A booked scrim gets one private Discord voice channel per side for the whole booking, named after the side, open only to that side's people and staff, and removed when the booking ends. A team's page gets a Scrims section (members and staff only) listing its booked games with scores. Both captains can invite a caster to a scrim booking; an invited caster sees its games and live feed like a participant, and `/cast` gives staff and invited casters the booked box's SourceTV relay with the booking's own relay password.

**Architecture:**
- **Voice.** It reuses the PUG voice transport (`VoiceOps`) with two small additions: a `privateView` option on channel creation, and a `setMemberAccess` call so people added after creation get in.
- **Voice lifecycle.** A small `BookingVoice` class (`src/bookings/voice.ts`) owns one row per booking in a new `booking_voice` table. The booking runner calls it when a booking becomes ready, on every minute watch (member sync), and at wind-down (move people to the lobby channel, then delete).
- **Scrims section.** It reads booking games through the existing `bookingGames`.
- **Casters.** Invites live in `booking_casters`. The two visibility functions (`canViewMatch`, `visibleMatchesSql`) gain a "fully invited caster" clause, so every match, replay and live route follows automatically.

**Spec:** `docs/superpowers/specs/2026-09-30-competitive-foundation-design.md`: section 1 Visibility (casters; scrims only when both captains invite), section 2 Team page (Scrims tab), section 3 SourceTV and Voice. Builds on plans 4a, 4b, 4b2.

## Global Constraints

- Each side gets a temporary Discord voice channel for the whole block, visible only to that side's players, ringers, approved spectators and staff. It is deleted when the booking ends.
- Casters see a scrim only when both sides' captains invite that caster for the booking (`booking_casters`: booking_id, caster_steamid, invited_by_a, invited_by_b). An invited caster gets the no-delay live feed and the SourceTV relay for that booking. The scrim stays `participants` for everyone else.
- No public relay for booked boxes: `tv_password` is random per booking and never shown to players; staff and invited casters get it through `/cast`.
- Members and staff see the team's Scrims tab; for anyone else it does not exist.
- Voice only when `discord_voice_enabled` is `1` and the bot is connected; a voice failure never blocks a booking (admin problem event, carry on).
- Never write em dashes. Plain-sentence commits. Never push, deploy, or touch live servers.

## Rulings (owner to confirm)

1. **One category plus two channels per booking**, named `Scrim: <side a> vs <side b>`, with each channel labelled by its side's name. `@everyone` is denied View, so the names do not leak.
2. **Members are synced every minute** from the booking's accepted people (the same set as the 4b2 allowlist, without staff, who come in through the staff role). Removed people lose access but are not kicked from the channel.
3. **At the end**, everyone in the two channels is moved to `discord_lobby_channel_id` (if set), then the channels and the category are deleted. There is no 10 minute grace like PUG voice: the block is over.
4. **A caster invite** is valid only for a player with `is_caster = 1` in good standing. Either side may withdraw its own half. A caster with both halves sees the booking's games; staff always do.
5. **The Scrims section** lists every booking the team was a side of, with each game's campaign, the score from the team's side, and a link to the match. Visible to the team's current members and staff.

## Review Focus

- A booking's voice channel must never be visible to someone outside that side (other side, strangers), and staff come in only through the staff role.
- A voice failure (no bot, missing permissions, deleted channel) must not stop setup, the minute watch, or the wind-down, and must not loop errors every minute.
- A half-invited caster sees nothing; a caster who loses `is_caster` loses access.
- `/cast` never gives a player (or a non-invited caster) a booking's relay password.
- The team Scrims endpoint answers 404 to non-members (no existence leak) and nothing about another team's private data.

---

### Task 1: VoiceOps: private channels and member access

**Files:** `src/discord/transport.ts` (VoiceOps), `src/discord/djsTransport.ts`, `tests/fakes/fakeTransport.ts`, tests for both.

**Interfaces:**
- `createMatchChannels(name, teamA, teamB, staffRoleId, opts?: { privateView?: boolean })`. With `privateView`, `@everyone` gets ViewChannel denied (and Connect denied), instead of today's allow-view. Without it, behaviour is exactly as today.
- `setMemberAccess(channelId: string, userId: string, allow: boolean): Promise<void>`. With `allow` true, it adds a Member overwrite with View, Connect and Speak (a no-op if present). With false, it removes that member's overwrite. It ignores an unknown channel or member (no throw).
- FakeTransport: records `privateView` per channel and keeps `allowed` in step with `setMemberAccess`.

- [ ] Steps:
  - Tests on the fake: a private create records `privateView`; `setMemberAccess` adds and removes. A djs-level test only if `djsTransport` already has unit tests for voice (check `tests/` first); otherwise none.
  - Implement both.
  - Make sure the existing PUG voice callers still compile and behave unchanged (call sites pass no `opts`).
  - Commit `Voice: private channels and per-member access for booked servers`.

---

### Task 2: Booking voice

**Files:** `src/db.ts` (table), `src/bookings/voice.ts` (new), `src/bookings/runner.ts` (calls), `src/server.ts` (wiring), tests `tests/bookingVoice.test.ts` and runner tests.

**Interfaces:**
- Table `booking_voice`: `booking_id INTEGER PRIMARY KEY REFERENCES bookings(id)`, `category_id TEXT NOT NULL`, `side_a_id TEXT NOT NULL`, `side_b_id TEXT NOT NULL`, `created_at TEXT NOT NULL`, `deleted_at TEXT`.
- `class BookingVoice { constructor(deps: { db: DB; voice: () => VoiceOps | null; now?: () => number }); ensure(bookingId): Promise<void>; sync(bookingId): Promise<void>; close(bookingId): Promise<void> }`:
  - `ensure` does nothing when voice is off (`discord_voice_enabled !== '1'`), the transport is null, a live row exists, or a side is unconfirmed. Otherwise it creates the private channels (ruling 1, labels from `sideName`, userIds = discord ids of that side's accepted people, staff role from `discord_staff_role_id`) and inserts the row. On error: one admin problem event per booking per process, then nothing.
  - `sync` diffs the desired members (accepted people with a `discord_id`, per side) against an in-memory record of what it granted (seeded at `ensure`) and calls `setMemberAccess` for each difference. Errors are logged, not thrown.
  - `close` (row present, not deleted): `channelMemberIds` of both channels, then `move` each member to `discord_lobby_channel_id` when set, then delete both channels and the category, then set `deleted_at`. Best effort per step, never throws.
- Runner: `BookingRunnerDeps.voice?: BookingVoice`. `ensure` is called after `markReady` (setup) and also from the watch when a ready or active booking has no row (covers voice turned on later and a web restart). `sync` runs in the watch, and `close` in `windDown` before the release. Every call is wrapped so that a throw is logged and ignored.
- `server.ts`: build `BookingVoice` with `voice: () => bot?.transport?.voice ?? null` and pass it to the runner.

- [ ] Steps:
  - Tests (fake transport):
    - `ensure` creates private channels named and labelled per ruling 1, with the right members per side.
    - No second create on repeat.
    - Off, null transport and an unconfirmed side each do nothing.
    - A failure gives one admin event even across two calls.
    - `sync` adds a newly accepted person and removes a removed one.
    - `close` moves members to the lobby and deletes all three, then is a no-op the second time.
    - Runner integration: ready calls `ensure`; wind-down calls `close` before the release; a throwing voice does not stop the wind-down.
  - Implement. Commit `Booked servers: a private voice channel per side for the whole booking`.

---

### Task 3: Team page Scrims section

**Files:** `src/routes/teams.ts`, `src/bookings/games.ts` (a team query), `web/src/api.ts`, `web/src/routes/Team.tsx`, tests (route and web).

**Interfaces:**
- `teamScrims(db, teamId): TeamScrim[]` with `TeamScrim = { bookingId: number; opponent: string; startsAt: string; state: string; games: { matchId: number; campaign: string; state: string; us: number; them: number }[] }`. It covers bookings where the team is a side, newest first, at most 50. `us`/`them` are oriented with `booking_side_a` and the team's side.
- `GET /api/teams/:slug/scrims`: 404 unless the viewer is a current member of the team (`roleOf` not null) or staff, so non-members cannot learn the route exists. Answers `{ scrims: TeamScrim[] }`.
- Web: on `/team/:slug`, for members and staff, a "Scrims" panel listing each booking (opponent, date, state) and its games (campaign, us : them, link to `/match/<id>` and to `/booking/<id>`). Nothing renders for others.

- [ ] Steps:
  - Tests: member sees; staff sees; former member, stranger and signed-out get 404; orientation when the team is side b and `booking_side_a` is 'b'; a booking the team was not in is never listed.
  - Web test: the panel shows for a member, and is absent and never fetched for a non-member (use `viewer.role`/`viewer.staff` from the team view to decide whether to fetch).
  - Implement. Commit `Team page: a Scrims section for members and staff with the team's booked games`.

---

### Task 4: Caster invites, visibility and `/cast` for booked boxes

**Files:** `src/db.ts` (table), `src/bookings/casters.ts` (new), `src/matchVisibility.ts`, `src/routes/bookings.ts` (routes), `src/routes/cast.ts`, `src/bookings/bookings.ts` (`bookingView.casters`), `web/src/api.ts`, `web/src/routes/Booking.tsx`, `web/src/routes/Cast.tsx` (only if it needs a field), tests.

**Interfaces:**
- Table `booking_casters`: `booking_id INTEGER NOT NULL REFERENCES bookings(id)`, `caster_steamid TEXT NOT NULL REFERENCES players(steamid)`, `invited_by_a TEXT`, `invited_by_b TEXT`, `created_at TEXT NOT NULL`, `PRIMARY KEY (booking_id, caster_steamid)`. Add it to the account merge lists (`src/mergePlayers.ts`: `caster_steamid` KEYED, `invited_by_*` PLAIN) so the FK enumeration test passes.
- `src/bookings/casters.ts`:
  - `inviteCaster(db, { bookingId, by, caster, now })` sets `invited_by_<side>` for the side `by` acts for (`actingSides`; the first side if both). It refuses with `not_caster` when the caster lacks `is_caster` or good standing, and with `wrong_state` on a closed booking.
  - `withdrawCaster(db, { bookingId, by, caster })` clears that side's half and deletes the row when both are empty.
  - `castersOf(db, bookingId)` returns `{ steamid, name, a: boolean, b: boolean }[]`.
  - `fullyInvited(db, bookingId, steamid): boolean` is true when both halves are set and the player has `is_caster` in good standing.
  - Each write logs a `booking_events` row.
- Visibility: `canViewMatch` gains, for a match with `booking_id`, "or the viewer is a fully invited caster of that booking". `visibleMatchesSql` gains the same as an EXISTS clause joined to `players.is_caster = 1` (check every caller's param order, as in 4b Task 3).
- Routes:
  - `GET /api/bookings/casters`: active casters for the picker. Needs the competitive switch, like the other booking routes.
  - `POST /api/bookings/:id/casters` with body `{ steamid }`.
  - `POST /api/bookings/:id/casters/:steamid/withdraw`.
  - All three answer the fresh view. `bookingView` gains `casters` (shown to people who can see the booking).
- `/cast`:
  - The list query also includes live booking games when the viewer is staff, or a fully invited caster of that game's booking.
  - For a match on a box a booking holds, `spectate.password` is the booking's `tv_password`, not `servers.tv_password`. Only `/cast` returns it.
  - `connect` stays null for booked games, so casters never get the game server password.
- Web:
  - On the booking page, a Casters panel for managers of a confirmed side: pick from casters, invite, withdraw your side's half, and see each caster's status (side a ✓ / side b pending).
  - On `/cast`, booked games show like the others (no layout change beyond what the data needs).

- [ ] Steps:
  - Tests:
    - Only a manager of a confirmed side can invite.
    - A non-caster is refused.
    - Half-invited sees nothing (`canViewMatch` false, absent from `visibleMatchesSql`).
    - Fully invited sees the game and its replays (route level, one case).
    - A caster whose `is_caster` is cleared loses access.
    - `/cast` lists the booked game for a fully invited caster and for staff, never for a half-invited caster, and returns the booking's `tv_password` there and nowhere else (assert `/api/bookings/:id` never carries it).
    - The merge test passes.
    - Web tests for the panel.
  - Implement. Commit `Casters: both captains invite a caster to a scrim, who then sees its games, live feed and relay on /cast`.

---

## After the last task

Full suite, typecheck, web build; whole-branch review. Owner hand-off: turn on voice for a test booking and check that the channels are private; invite a caster from both sides and check `/cast`.
