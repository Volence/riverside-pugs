# Competitive foundation plan 4b2: who may be on a booked server

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only the booking's people and staff can stay on a booked server. Anyone else who connects gets 60 seconds in which a captain can type `!allow <name>` to add them as a ringer. Otherwise they are kicked with a reason and cannot rejoin that booking's server for 30 minutes, unless a captain adds them on the site, which lifts the block at once. A leaked password is no longer enough to scout.

**Architecture:** The site owns the list. The booking runner pushes it to the `l4d_booking` plugin at setup and every minute: accepted booking people of both sides, plus every staff member (admin or mod) in good standing. The push goes as a begin, add-in-chunks, commit sequence, so the plugin swaps whole lists and never enforces a half-sent one. The plugin enforces only on connect, and only once it holds a committed list. SourceMod admins (site admins get root through the generated `admins.cfg`) and SourceTV are always let in. `!allow` comes to the site as a signed `PUGBOOK ... cmd=allow` line (plan 4b's path). The site adds the player as an accepted ringer of the captain's side and re-pushes the list. The plugin also lets them in at once, so the grace timer stops without waiting a minute.

**Tech Stack:** TypeScript, better-sqlite3, vitest; SourcePawn 1.12.

**Spec:** `docs/superpowers/specs/2026-09-30-competitive-foundation-design.md`, section 3, "Who may be on a booked server". Builds on plans 4a and 4b.

## Global Constraints

- The allowlist is each side's players, ringers and approved spectators, plus staff. The plugin kicks anyone else on connect with a reason.
- A captain can `!allow <name>` in game during a 60-second grace window after someone connects; that adds a ringer or spectator for this booking. Otherwise the grace ends in a kick, and that player cannot rejoin this booking's server for 30 minutes (setting). A captain adding them on the site lifts the block at once.
- Ringers are always marked as ringers on the scrim record.
- Allowlist changes are pushed immediately and re-pushed after every map load (the runner's minute re-push covers map loads).
- Never write em dashes. Plain-sentence commits. Do not push, deploy, stage or rcon live boxes; plugin checks only on `/home/volence/l4d1-ds` with the 0-humans gate in the same command, restoring the box after.

## Rulings (owner to confirm)

1. `!allow` adds the player as a **ringer** of the captain's side (accepted at once: the captain's in-game word is the consent). A spectator-only role from in game is not offered. A captain can change the role on the site later.
2. Someone who has never visited the site gets a `players` row (status `invited`, name from the game) so they can be listed, the same as an in-game adopted match does today. A player with an active ban is refused.
3. The grace and block are settings: `booking_allow_grace_seconds` (default 60, 15..300) and `booking_allow_block_minutes` (default 30, 0..240). 0 minutes means no block.
4. People removed from a booking while connected are not kicked; the list is enforced on connect only.
5. Until the plugin holds a committed list (fresh load, before the first push) it enforces nothing.

## Not in this plan

Kick-on-remove, a spectator role from in game, side-locked spectating (4d), voice (4c).

## Review Focus

- A half-sent list must never be enforced: a push that fails between begin and commit leaves the previous list in force.
- The booking's own people, staff, SourceMod admins and SourceTV are never kicked; bots are ignored.
- A blocked player whom a captain then adds on the site can join on the next connect after the push.
- `!allow` from a non-captain, for a name matching nobody or several people, or for someone already allowed does nothing harmful and says why.
- The kick reason never echoes player-controlled text into the console unsafely.

---

### Task 1: Site side: settings, list, in-game allow

**Files:** `src/db.ts`, `src/settingsSchema.ts`, `src/bookings/bookings.ts`, `src/bookings/runner.ts`, `tests/bookings.test.ts`, `tests/bookingRunner.test.ts`

**Interfaces:**
- Settings `booking_allow_grace_seconds` '60' (int 15..300), `booking_allow_block_minutes` '30' (int 0..240), group Competitive, with help text that says what each does.
- `allowList(db, bookingId): string[]`: the steamids of accepted `booking_people` of the booking, plus every player with `is_admin = 1 OR is_mod = 1` who is in good standing; de-duplicated, sorted.
- `allowInGame(db, o: { bookingId: number; by: string; steamid: unknown; name: unknown; now?: Date }): Result<{ side: Side; added: boolean }>`:
  - The booking must be open and ready/active.
  - `by` must manage a confirmed side (`actingSides`); the person joins that side (the first one when someone manages both).
  - `steamid` must be 17 digits. `name` is trimmed to 32 characters; unsafe characters go through the same `hasUnsafeChars` rule players use, falling back to the steamid.
  - A player with an active ban is refused (`not_player`).
  - Already in the booking: `{ added: false }`, no change.
  - Otherwise insert `players` if absent (status `invited`, the name), insert `booking_people` (role `ringer`, status `accepted`, added_by `by`), and write a `booking_events` row `person_allowed_in_game`. Side capacity is `PEOPLE_PER_SIDE`, refused as `side_full`.
- Runner: `allowLines(db, b): string[]` builds `sm_booking_allow_begin`, then `sm_booking_allow_add <id> <id> ...` with at most 10 ids per line, then `sm_booking_allow_commit`, then `l4d_booking_grace <seconds>` and `l4d_booking_block <minutes>`. It is appended to `gameLines`, so setup and every minute push it. `onCommand` gains `cmd === 'allow'`: `arg` is `<steamid64> <name...>`. The runner calls `allowInGame`, pushes `allowLines` at once, and says `[Booking] <name> is in, as a ringer for <side name>.` or the refusal.
- `parseLogDatagram` (`src/logParse.ts`) must accept `cmd=allow` (extend the known cmd set). Its parser test gains the case.

- [ ] Steps: failing tests first, then implement, run the covering tests and typecheck, full suite, commit `Booked servers: an allowlist of the booking's people and staff, pushed whole every minute, and !allow adds a ringer from in game`.

Tests to write:
- `allowList` includes accepted people and staff, excludes invited people and a banned admin.
- `allowInGame`: by a captain adds a ringer (and creates a players row for an unknown id); by a non-captain is `not_manager`; for a banned id is refused; for someone already in is `added: false`; when the side is full is `side_full`.
- The runner pushes begin, add chunks of at most 10, and commit, in that order, in setup and in the minute re-push. `onCommand('allow', '<id> Some Name')` from a captain adds the ringer, re-pushes, and says the line.

---

### Task 2: `l4d_booking` 1.2.0: enforce the list on connect

**Files:** `plugin/l4d_booking.sp`, `plugin/README.md`

**Interfaces:**
- Server commands: `sm_booking_allow_begin` (starts a pending list), `sm_booking_allow_add <id64> [id64...]` (adds to the pending list; ids that are not 17 digits are skipped), `sm_booking_allow_commit` (swaps pending into the active list, marks the list loaded, and clears any block for an id now on it), `sm_booking_status` (prints whether a list is loaded, how many ids, and the pending graces and blocks, for testing).
- Cvars `l4d_booking_grace` (default 60) and `l4d_booking_block` (default 30, in minutes).
- **On connect** (`OnClientPostAdminCheck`), the plugin acts only when all of these hold:
  - `l4d_booking_password` is non-empty;
  - a list is loaded;
  - the client is not a bot, not SourceTV, not a SourceMod admin (`GetUserAdmin(client) != INVALID_ADMIN_ID`), and not on the list.

  If the id is blocked and the block has not expired, kick at once: `This server is booked. You were not let in a few minutes ago; ask a captain to add you on the site.` Otherwise start a grace timer of `l4d_booking_grace` seconds and print to every captain (`l4d_booking_captains`): `[Booking] <name> joined and is not on the booking. Type !allow <name> within <n> seconds to let them play as a ringer.` Tell the joiner: `[Booking] This server is booked. A captain has <n> seconds to let you in.`

- **When the grace runs out** and the client is still connected and still not allowed: kick with `This server is booked. Ask a captain to add you to the booking on the site.`, and block the id for `l4d_booking_block` minutes when that is above 0.
- `!allow <name>` from a captain:
  - The name is matched, case-insensitively and by substring, against clients currently in grace. Exactly one match is required. Otherwise the plugin says `[Booking] No one waiting matches that name.` or `[Booking] More than one player matches; type more of the name.`
  - On a match it adds the id to the active list at once, cancels that grace, and emits `PUGBOOK event=cmd cmd=allow steamid=<captain> arg=<target id64> <target name>`, with the name sanitized like other args.
- `!allow` from a non-captain: `[Booking] Only a captain can do that.`
- Grace and block state are kept per SteamID64, not per client index, so a reconnect cannot dodge them. A map change keeps them (plugin globals survive map changes).
- Version 1.2.0 (from 1.1.1).

- [ ] Steps: implement, build with `plugin/build-booking.sh`, then check on the local server with the usual gate:
  - load the plugin;
  - send `sm_booking_allow_begin` / `_add` / `_commit` and confirm through `sm_booking_status` (loaded, the count);
  - confirm a begin without a commit leaves the old list active;
  - confirm `sm_booking_cmd` still works.

  The connect path needs a real client and is left for the owner's live test; say so in the commit. Restore the box. Commit `l4d_booking 1.2.0: a booked server lets in only its people and staff, with a captain's !allow grace and a 30 minute block`.

---

### Task 3: Admin abort dialog for a booking game

**Files:** `web/src/routes/admin/MatchPanels.tsx` (the abort confirm), its test.

**Interfaces:** for a match with a booking (the admin match payload must say so: add `bookingId: number | null` to the admin match view in `src/admin/matches.ts` if it is not there), the abort confirm says "The game is dropped; the booking keeps its server and carries on." instead of "The server is freed", does not offer the leave-out checkboxes, and after the abort shows the route's `message`. Non-booking matches: unchanged.

- [ ] Steps: failing web test for both cases, implement, web tests + typecheck + build, commit `Admin abort of a booking game says the booking carries on`.

---

## After the last task

Full suite, typecheck, build; whole-branch review. Owner hand-off: stage 1.2.0 on every pool box; live test with a third account that is not on the booking (grace message, `!allow`, the kick and block after the grace, the block lifted by adding them on the site).
