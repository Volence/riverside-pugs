# Scrim blocks: a side chooses who it never scrims

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Some teams want to be selective about their opponents. A team's captain or co-captain, or a pickup captain for themselves, can block a team or a player. A blocked pair never meet through the scrim system:
- neither sees the other's posts on the board;
- neither can accept, challenge or book the other;
- the blocked side is never told it was blocked.

**Architecture:**
- One table, `scrim_blocks`, holds the blocks. One function, `blocked(db, sideA, sideB)`, answers in either direction, and every place two sides meet calls it: `board()`, `createPost` (the challenge target), `acceptPost`, `confirmAccept` and `createBooking`.
- A refusal reuses one generic error, `not_available`, so a blocked side cannot tell a block apart from other refusals.
- Blocks are managed from a "Blocked" panel on `/scrims`.

**Tech Stack:** TypeScript, Fastify 5, better-sqlite3, vitest, Preact.

**Spec:** this is an owner request from 2026-10-01 ("some teams might want to be selective about who they play"). It extends the scrims spec (`docs/superpowers/specs/2026-09-30-competitive-scrims-design.md`, sections 1 and 2), which has no block list. The rulings below are the design.

## Global Constraints

- Everything sits behind the existing scrim gates (`canUse`) and the same manager rules as scrim posts (`managesScrimSide`).
- Never write em dashes in code, copy, tests or commits. Commit messages are plain sentences.
- Do not push, deploy or touch any game server.
- Migrations are additive and idempotent (`CREATE TABLE IF NOT EXISTS`).

## Rulings (owner to confirm)

1. **Who blocks.** A blocker is a *party*:
   - a team, managed by its captain and co-captain;
   - a pickup captain, for themselves.
2. **What can be blocked.** A team, or a player.
   - A team block matches when the other side is that team.
   - A player block matches when the other side is a pickup group captained by that player, or a team in which that player is currently captain or co-captain. Ordinary members are not matched: blocking a member would silently cut off every team they ever join.
3. **Blocks work both ways.** A blocked pair is kept apart in both directions: the blocker does not see the blocked side's posts either, and neither can accept, challenge or book the other.
4. **Silent.** The blocked side gets no notice. Its refusals read "This scrim is not available to you." (`not_available`, status 409), the same text for every block refusal.
   - Discord cards cannot be hidden per viewer, so a blocked side may still see a card. Its Accept link opens the board, where the post is absent, and a direct accept is refused.
5. **On blocking, pending acceptances between the pair are withdrawn quietly.**
   - On the blocker's open posts, the blocked side's pending acceptances become `declined`, with the usual `scrim_declined` DM, which does not name a block.
   - The blocker's own pending acceptances on the blocked side's posts become `withdrawn`, with no DM.
   - Existing confirmed bookings are not touched. Cancelling one is a separate, deliberate act.
6. **Limits and records.**
   - At most 100 blocks per party (`too_many_blocks`).
   - Blocking the same target twice is a no-op success.
   - A party cannot block itself, nor a team it belongs to (`bad_block`).
7. **Visibility.**
   - A party's block list is visible only to its managers and to staff.
   - Staff see a party's blocks on the admin People desk under the existing Scrims heading. That is read-only, with no staff editing in this plan.

## Not in this plan

Blocking by individual members, temporary blocks, a reason field, and staff editing of blocks.

## Review Focus

- **Direction:** every meeting point refuses in BOTH directions. Test each one with the block made by either side.
- **Leakage:** no response tells a blocked side that it is blocked. That covers the error text, the board count, and the absence of fields.
- **Player-block matching:** a player block follows the player into a team they captain or co-captain, but not into one where they are only a member.
- **Pickup:** a pickup party is keyed by captain steamid, the same `Party` shape as `src/bookings/rules.ts`.

---

### Task 1: Blocks on the site side

**Files:**
- `src/db.ts`
- new `src/scrims/blocks.ts`
- `src/scrims/scrims.ts`
- `src/bookings/bookings.ts` (`createBooking`)
- `src/routes/scrims.ts`
- `src/routes/admin.ts` (or `playerFile`, wherever Task 2 of scrim plan 2 put `sections.scrims`)
- tests: `tests/scrimBlocks.test.ts`, plus additions to `tests/scrims.test.ts`, `tests/bookings.test.ts` and `tests/scrimRoutes.test.ts`

**Interfaces:**
- **Table `scrim_blocks`:**
  - columns: `id`, `blocker_team_id INTEGER` (null for a pickup), `blocker_steamid TEXT` (the pickup captain; null for a team), `target_team_id INTEGER`, `target_steamid TEXT`, `created_by TEXT NOT NULL`, `created_at TEXT NOT NULL`;
  - CHECK that exactly one blocker column is set, and exactly one target column;
  - UNIQUE indexes on `(blocker_team_id, target_team_id, target_steamid)` and on `(blocker_steamid, target_team_id, target_steamid)`. Use `COALESCE`, or two partial unique indexes, so NULLs do not defeat uniqueness.
- **Types:**
  - `type BlockParty = { teamId: number } | { captain: string }`. Reuse `Party` from `src/bookings/rules.ts` if its shape matches.
  - `type BlockTarget = { teamId: number } | { steamid: string }`
- **`blocked(db, a: BlockParty, b: BlockParty): boolean`** is true if either party blocks the other, under Ruling 2:
  - a target team matches party `{teamId}`;
  - a target steamid matches party `{captain: steamid}`, or a party `{teamId}` whose current captain or co-captain is that steamid (`team_members.left_at IS NULL`, role in captain/cocaptain).
- **`blockTarget(db, o: { by; party: BlockParty; target: unknown; now? }): Result<{ added: boolean }>`:**
  - `by` must manage the party, using the same check `managesScrimSide` uses for posts;
  - parse and validate the target: a team must exist, and a player must exist in `players`;
  - apply Ruling 6, then Ruling 5's withdrawals in the same transaction.
- **`unblock(db, o: { by; party; target })`** returns `Result<{ removed: boolean }>`.
- **`blocksOf(db, party)`** returns `{ target: { kind: 'team'; id; name; tag } | { kind: 'player'; steamid; name }; createdAt }[]`, newest first.
- **Meeting points.** Each calls `blocked` with the two sides as parties. A pickup side is `{captain}`, and a team side is `{teamId}`.
  - `board()` drops posts whose side is blocked with any side the viewer could act as: their managed teams and themselves as a pickup captain. Simplest rule: drop a post if it is blocked with ANY party the viewer manages.
  - `createPost` with `targetTeamId` refuses `not_available` when the poster's side and the target are blocked.
  - `acceptPost` refuses `not_available`.
  - `confirmAccept` refuses `not_available`. A block made after the accept but before the confirm is caught here.
  - `createBooking` refuses `not_available` when the creator's side and the opponent are blocked. Add the code to `BOOKING_ERRORS` with the same text.
- **Routes:**
  - `GET /api/scrims/blocks?teamId=<id>` (omit teamId for your own pickup party) returns `{ blocks }`. It requires a manager; otherwise 404.
  - `POST /api/scrims/blocks` with `{ teamId?: number, target: { teamId } | { steamid } }`.
  - `POST /api/scrims/blocks/remove` with the same body.
- **Staff view:** the People desk player data gains `scrimBlocks`, holding the player's pickup blocks and each current team's blocks, under the existing Scrims section.

- [ ] Steps: failing tests first, then the implementation, the covering tests, the typecheck, and the full suite. Commit `Scrims: a team or pickup captain can block a team or player, and a blocked pair never sees, accepts, challenges or books each other`.

Tests to write:
- `blocked`:
  - team blocks team, in both directions;
  - a player block matches a pickup captained by them and a team they captain or co-captain;
  - it does not match a team where they are a plain member;
  - after they leave the team, it no longer matches.
- Each meeting point refuses `not_available`, with the block made by EITHER side. That covers board hiding, challenge, accept, confirm (block made between accept and confirm) and `createBooking`.
- Blocking withdraws or declines pending acceptances per Ruling 5. A confirmed booking is untouched.
- Ruling 6: duplicate, self, own team, and the cap.
- **Privacy:**
  - a non-manager gets 404 on the list;
  - the blocked side's responses never contain the word "block".

---

### Task 2: The Blocked panel on /scrims

**Files:**
- `web/src/routes/Scrims.tsx`
- `web/src/api.ts`
- `web/src/routes/admin/file/PlayerFile.tsx`
- their tests

**Interfaces:**
- **A "Blocked" panel** on `/scrims`, below "Your posts", for anyone who can post:
  - a side picker, using the same "Your side" options as Post a scrim (managed teams, or yourself as pickup);
  - the list for that side, each entry with an Unblock button;
  - an add row: a "Team" select of live teams, or "Player" search using the existing `teamsApi.search` (player search) endpoint, and a Block button.
  - Copy: "Blocked sides never see your scrim posts and you never see theirs; neither can accept, challenge or book the other. They are not told."
- **People desk:** under Scrims, list a player's blocks (pickup, and per team), read-only.
- Phone width at 390 px.

- [ ] Steps: failing tests first, then the implementation, the web tests, the typecheck, the web build and the full suite. Commit `Scrims: a Blocked panel to manage a side's blocks, and staff can read them on the People desk`.

Tests to write:
- Adding a team block and a player block posts the right body.
- Unblock posts the remove.
- Switching the side reloads the list.
- The panel is absent for someone who cannot post.
- The People desk renders blocks.
