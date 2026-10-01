# Competitive foundation plan 4b: games inside a booked block

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every campaign played on a booked server is recorded as its own match (kind `scrim`, visible only to the booking's people and staff, never rated), with stats and replays like a PUG. Between campaigns the server moves on through the booking's playlist by itself. Captains steer it with `!nextmap`, `!stay`, `!end` and `!extend` in game, or the same controls on the booking page. When everyone leaves after a finished game, the booking ends at once.

**Architecture:** Booked games reuse the plugin's existing auto-track path instead of a new backend-driven one. The booking runner turns on `sm_pug_auto_track` on its box, so pug-match creates a match when both teams go live and announces it with the `MATCH_CREATE` burst. `src/selfStarted.ts` adopts it as before, but on a box a booking holds it files it as the booking's game (kind, visibility, rules snapshot, `booking_id`, which booking side is match team a). It also leaves `servers.status` alone. Self-started matches already skip the no-show reaper, leave and abandon tracking, the end kick, ratings (kind guard) and Discord cards, so none of those need a booking check. Finishing a booking game runs the normal `finishMatch` (dump, `completeMatch`, abort, replays) and then hands back to the runner instead of releasing the box. A central guard in `ServerReleaser.release` refuses to release a booking-held box unless the booking runner asks, so no match path can restart a booked server mid-slot. Captain commands are signed `PUGBOOK` log lines from the `l4d_booking` plugin, which the runner acts on after re-checking rights.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Fastify 5, better-sqlite3, vitest; Preact web; SourcePawn 1.12 (`plugin/build-booking.sh`).

**Spec:** `docs/superpowers/specs/2026-09-30-competitive-foundation-design.md`, section 3: "Games inside a block", "Playlist flow", "Player control" (the commands this plan covers), "Lifecycle" (idle end after a finished game). Builds on plan 4a (`docs/superpowers/plans/2026-09-30-competitive-foundation-4a-bookings.md`), merged first.

## Global Constraints

- Each game in a block is its own `matches` row: kind from the booking's purpose (`scrim`), visibility `participants`, `booking_id` set, sides linked to `booking_sides`. Each gets its own replay and stats.
- Nobody is kicked between games; the password stays; players reconnect freely with no abandon penalty and no ready-check timers. A game starts when both sides ready up.
- Playlist flow: when a campaign's game ends, the server announces "Next: <campaign> in 60 s. `!nextmap` to pick another, `!stay` to replay this one, `!end` to finish." With no objection it loads the next campaign. The command reminder also shows at the start of every campaign. At the start of each campaign, if the typical duration exceeds the time left: "About N min left, this campaign usually takes M. `!extend` now while the slot after is free."
- Player control: players never get the rcon password. The booking's captains (managers of a confirmed side) get `!nextmap`, `!stay`, `!end`, `!extend`. The site re-checks every command; the plugin's captain list is only a courtesy.
- Idle end: everyone leaving after a finished game ends the booking at once.
- Scrim and tournament matches never touch PUG SR; nothing PUG-facing counts them (`completedPug()`).
- A running PUG is never interrupted; a booked box is never released or restarted by anything but its own booking's end.
- Never write em dashes in code, comments, commits or docs. Commit messages are plain sentences. Do not push, deploy, stage or rcon any live box; the plugin is built and checked only on the local server (`/home/volence/l4d1-ds`, `python3 /home/volence/l4d1-ds/rcon-local.py`, gate every change on `0 humans` in the same command).
- Work in a worktree branch; several Claude sessions use `/home/volence/l4d/pug`.

## Rulings this plan makes (owner to confirm at review)

1. **Auto-track, not a backend-driven match.** A booked game is created by the plugin's auto-track when both teams go live with at least `booking_game_min_players` (setting, default 6) humans on teams. This means no ready-check timers, no roster push, no 12-player roster cap and no `sm_pug_match` setup per game, which is the spec's "a game starts when both sides ready up". The cost: a booked game has no stop map, so it ends where an in-game `!load_4v4p` match ends today (the plugin's finale rule), not at `campaign_play_rules`. Revisit if captains ask for shorter campaigns.
2. **Which booking side is match team a** is decided at adoption by majority: the booking side with more of its people among match team a's roster. A tie or nobody known goes to booking side a. Stored as `matches.booking_side_a`.
3. **`!end` during a game** aborts that game (`aborted`, cause `booking_ended`), then ends the booking. `!nextmap` and `!stay` are refused while a game is live ("Finish this game or use !end first").
4. **"Everyone left"** means no humans on two minute-ticks in a row, a finished game, no live game, and the last game ended at least 2 minutes ago, so a map change between campaigns cannot end the booking.
5. **`!nextmap <name>`** matches a campaign in the map pool by slug or by name, case-insensitive, prefix allowed when unique. With no name it means the next playlist campaign.
6. **Allowlist and `!allow` are plan 4b2**, next. Until then the booking password is the only gate.

## Not in this plan

- Allowlist kick, `!allow` grace, the 30 minute block, ringer marking from `!allow`: plan 4b2.
- `!restart` (mutual half restart), `!config`, per-match team lock: later; no plugin support exists.
- Voice, team names on cards, Scrims tab, casters: 4c. Side-locked spectating: 4d. Crash recovery: plan 5.

## Review Focus

- A booked box must never be released or restarted by a match path (finishMatch, finishWithRetry give-up, orphan reaper, admin abort or void). The central guard in `ServerReleaser.release` covers every caller; Task 1 tests it directly, Task 2 tests finishMatch.
- A `!load_4v4p` or auto-tracked match on a box that is NOT booked must be adopted exactly as today (kind pug, origin in_game, status live, notify sent). Task 2 test.
- A scrim match, its replays and its live view must be invisible to someone who is not in the booking, and visible to an accepted spectator of the booking who never played. Task 3 tests.
- A `PUGBOOK` line from a box with no open booking, from a non-captain, or for a booking that is ending does nothing but log. Task 6 tests.
- The map change between campaigns (players loading, 0 humans for a minute) must not end the booking. Task 4 test.

---

## File map

| File | Responsibility |
|---|---|
| `src/db.ts`, `src/settingsSchema.ts` | `matches.booking_id`, `matches.booking_side_a`; `bookings.playlist_pos`, `next_campaign`, `next_at`; setting `booking_game_min_players`. |
| `src/serverRelease.ts` | `ReleaseOpts.booking`; refuse to release a booking-held box without it. |
| `src/selfStarted.ts` | Adopt a game on a booked box as the booking's game. |
| `src/orchestrator.ts` | `finishMatch`: no release and no public notify for a booking game; call the booking hook. |
| `src/matchVisibility.ts` | Booking people may see the booking's matches. |
| `src/bookings/games.ts` | Booking game reads and writes: adoption fields, side mapping, games list, abort. |
| `src/bookings/runner.ts` | Setup pushes auto-track, pause rules, logging and captains; playlist advance; commands; everyone-left end. |
| `src/bookings/bookings.ts` | `bookingView.games`. |
| `plugin/l4d_booking.sp`, `plugin/build-booking.sh` | 1.1.0: captains cvar, chat commands, signed `PUGBOOK` lines, `sm_booking_cmd` test command. |
| `src/logParse.ts`, `src/logListener.ts` | `PUGBOOK` line, address-gated. |
| `src/server.ts` | Wiring: booking hook from finishMatch, `PUGBOOK` dispatch, runner deps. |
| `src/routes/bookings.ts`, `web/src/api.ts`, `web/src/routes/Booking.tsx` | Games list; Next campaign / Replay this campaign controls. |

---

### Task 1: Schema, setting, and the release guard

**Files:**
- Modify: `src/db.ts`, `src/settingsSchema.ts`, `src/serverRelease.ts`, `src/server.ts` (the booking runner's `release` dep passes `booking: true`)
- Test: `tests/bookingGamesSchema.test.ts` (new), `tests/serverRelease.test.ts` (or wherever `ServerReleaser` is tested today: `grep -ln "new ServerReleaser" tests`)

**Interfaces:**
- Produces: `matches.booking_id INTEGER REFERENCES bookings(id)` (null for everything else), `matches.booking_side_a TEXT CHECK (booking_side_a IN ('a','b'))`; `bookings.playlist_pos INTEGER NOT NULL DEFAULT 0`, `bookings.next_campaign TEXT`, `bookings.next_at TEXT`; index `matches_booking ON matches (booking_id) WHERE booking_id IS NOT NULL`.
- Produces: setting `booking_game_min_players` default `'6'`, int 2..8, group Competitive.
- Produces: `ReleaseOpts.booking?: boolean`. `release(serverId, opts, onSettled)` on a box whose `holdFor(db, serverId)?.kind === 'booking'` and without `opts.booking` does nothing to the servers row or the box, logs one line, publishes nothing, and calls `onSettled?.(false)`. With `opts.booking` it behaves exactly as today.

- [ ] **Step 1: Write the failing tests**

`tests/bookingGamesSchema.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { getSetting } from '../src/settings.js';
import { validateSetting } from '../src/settingsSchema.js';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

describe('booking games schema', () => {
  it('matches carry an optional booking and which booking side is team a', () => {
    const cols = (db.prepare('PRAGMA table_info(matches)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('booking_id');
    expect(cols).toContain('booking_side_a');
    const id = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'live', 'no_mercy')").run().lastInsertRowid);
    expect(db.prepare('SELECT booking_id, booking_side_a FROM matches WHERE id = ?').get(id)).toEqual({ booking_id: null, booking_side_a: null });
    expect(() => db.prepare("UPDATE matches SET booking_side_a = 'c' WHERE id = ?").run(id)).toThrow(/CHECK/);
  });

  it('bookings carry the playlist position and a pending next campaign', () => {
    const cols = (db.prepare('PRAGMA table_info(bookings)').all() as { name: string; dflt_value: string | null }[]);
    expect(cols.find((c) => c.name === 'playlist_pos')?.dflt_value).toBe('0');
    expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(['next_campaign', 'next_at']));
  });

  it('ships booking_game_min_players', () => {
    expect(getSetting(db, 'booking_game_min_players')).toBe('6');
    expect(validateSetting('booking_game_min_players', '9').ok).toBe(false);
  });
});
```

In the releaser test file, add (adapt the construction to that file's existing helpers for `ServerReleaser`, cleaner and restarter fakes):

```ts
  it('refuses to release a box a booking holds unless the booking asks', async () => {
    // A box held by an open booking.
    db.prepare("INSERT INTO players (steamid, name, status) VALUES ('76561199000000001', 'a', 'active')").run();
    db.prepare(
      `INSERT INTO bookings (purpose, starts_at, ends_at, state, server_id, password, tv_password, game_config, rules_json, playlist_json, created_by, created_at)
       VALUES ('scrim', 'x', 'y', 'active', ?, 'p', 't', 'standard', '{}', '[]', '76561199000000001', 'x')`,
    ).run(serverId);
    const settled: boolean[] = [];
    releaser.release(serverId, { restart: true }, (back) => settled.push(back));
    await releaser.settled();
    expect(cleaned).toEqual([]);              // the cleaner never ran
    expect(getServer(db, serverId)!.status).toBe('idle');
    expect(settled).toEqual([false]);
    releaser.release(serverId, { restart: true, forceRestart: true, booking: true }, (back) => settled.push(back));
    await releaser.settled();
    expect(cleaned).toHaveLength(1);
  });
```

(`cleaned` is whatever that test file records from its fake cleaner; use the file's own names.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/bookingGamesSchema.test.ts <releaser test file>`
Expected: FAIL (missing columns, setting, guard).

- [ ] **Step 3: Implement**

`src/db.ts`, next to the other `ensureColumn(db, 'matches', ...)` calls (after `game_config`):

```ts
  // Booked games (plan 4b): the booking a scrim match was played under, and
  // which booking side is the match's team a (decided at adoption).
  ensureColumn(db, 'matches', 'booking_id', 'INTEGER REFERENCES bookings(id)');
  ensureColumn(db, 'matches', 'booking_side_a', "TEXT CHECK (booking_side_a IN ('a','b'))");
  db.exec('CREATE INDEX IF NOT EXISTS matches_booking ON matches (booking_id) WHERE booking_id IS NOT NULL');
  // Where a booking is in its playlist, and the campaign it moves to next
  // (and when), set when a game ends or a captain picks one.
  ensureColumn(db, 'bookings', 'playlist_pos', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'bookings', 'next_campaign', 'TEXT');
  ensureColumn(db, 'bookings', 'next_at', 'TEXT');
```

(`bookings` is created in SCHEMA, which runs before the `ensureColumn` block, so the order is safe; check that the `matches` ensureColumns run after SCHEMA too.)

`DEFAULT_SETTINGS`: `booking_game_min_players: '6',` after `booking_extend_minutes`. `settingsSchema.ts`:

```ts
  { key: 'booking_game_min_players', group: 'Competitive', label: 'Players on teams to record a booked game', help: 'A game on a booked server is recorded once both teams go live with at least this many humans on teams in total.', type: { kind: 'int', min: 2, max: 8 } },
```

`src/serverRelease.ts`: add to `ReleaseOpts`:

```ts
  /** The booking runner releasing its own box at the end of a booking. Every
   *  other caller is refused on a box a booking holds (plan 4b): a game
   *  played inside a booking ends with the block still running, and nothing
   *  but the booking's own end may restart that box. */
  booking?: boolean;
```

At the top of `release()`, after `const server = getServer(...)`:

```ts
    if (!opts.booking && holdFor(this.db, serverId)?.kind === 'booking') {
      console.log(`[serverRelease] ${server.name} is held by a booking; not releasing it (the booking ends it)`);
      onSettled?.(false);
      return;
    }
```

(import `holdFor` from `./serverHolds.js`; keep `booking` out of the `full` object, it is only read here). In `src/server.ts`, the booking runner's `release` dep becomes `releaser.release(serverId, { restart: true, forceRestart: true, booking: true }, resolve)`.

- [ ] **Step 4: Run the tests, typecheck, full suite**

Run: `npx vitest run tests/bookingGamesSchema.test.ts <releaser test file> tests/bookingRunner.test.ts && npm run typecheck && npx vitest run`
Expected: PASS. `tests/db.test.ts` may list tables/columns exhaustively; update it if it fails on the new columns.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/settingsSchema.ts src/serverRelease.ts src/server.ts tests
git commit -m "Booked games: match and booking columns, game player threshold, and the releaser refuses to release a booked box unless the booking asks"
```

---

### Task 2: Adopt a game on a booked box as the booking's game; finish it without releasing

**Files:**
- Create: `src/bookings/games.ts`
- Modify: `src/selfStarted.ts` (commit), `src/orchestrator.ts` (`finishMatch`), `src/server.ts` (orchestrator dep wiring)
- Test: `tests/bookingGames.test.ts` (new), `tests/selfStarted*.test.ts` (existing behaviour unchanged; `grep -ln SelfStartedMatches tests`)

**Interfaces:**
- Produces (`src/bookings/games.ts`):
  - `bookingOnServer(db, serverId): BookingRow | null`: the open (`ending_at IS NULL`, state ready/active) booking holding this box, via `holdFor`.
  - `bookingSideForTeamA(db, bookingId, teamA: string[], teamB: string[]): 'a' | 'b'` (ruling 2).
  - `liveBookingGame(db, bookingId): { id: number; token: string; campaign: string } | null`.
  - `bookingGames(db, bookingId): BookingGameView[]` with `BookingGameView = { matchId: number; campaign: string; state: string; scoreA: number; scoreB: number; sideA: 'a' | 'b' | null; startedAt: string; endedAt: string | null }`, oldest first.
  - `abortBookingGame(db, matchId, now): string | null`: marks a live booking game `aborted` with `abort_cause = 'booking_ended'` and `ended_at`, returns its token (so the caller can unregister it), else null.
- Produces: in `SelfStartedMatches.commit`, when `bookingOnServer(db, serverId)` is a booking, the inserted match has `kind = booking.purpose`, `visibility = 'participants'`, `rules_json = booking.rules_json`, `game_config = booking.game_config`, `booking_id`, `booking_side_a`, `origin = 'in_game'`; `servers.status` is NOT changed; `notify` is NOT called; a `booking_events` row `game_started` is written with the match id; `markActive` runs. On a box with no booking: unchanged.
- Produces: `OrchestratorDeps.onBookingGameEnded?: (matchId: number) => void`. In `finishMatch`, for a match with `booking_id`, the `releaser.release` call and the `notify` are skipped and `onBookingGameEnded(matchId)` is called instead (after `clearLive` and `unregister`).

- [ ] **Step 1: Write the failing tests** (`tests/bookingGames.test.ts`)

Build a booking with tasks 4a's domain functions (copy the `book`/fake-rcon helpers from `tests/bookingRunner.test.ts`), get it to `ready` on server 3, then drive `SelfStartedMatches.handle` with a `match_create` / `match_roster` x6 / `match_create_end` burst whose `source` resolves to server 3 (`resolveServerId: () => 3`). Assert:

```ts
    const m = db.prepare('SELECT kind, visibility, origin, booking_id, booking_side_a, rules_json, game_config FROM matches WHERE token = ?').get(token);
    expect(m).toEqual({ kind: 'scrim', visibility: 'participants', origin: 'in_game', booking_id: id, booking_side_a: 'a', rules_json: getBooking(db, id)!.rules_json, game_config: 'standard' });
    expect(getServer(db, 3)!.status).toBe('idle');           // untouched
    expect(notified).toEqual([]);                             // no public "started in-game" line
    expect(getBooking(db, id)!.state).toBe('active');
```

with team a = three of side b's people and team b = three of side a's people in a second case, expecting `booking_side_a: 'b'`. A third case: the same burst on server 1 (no booking) is adopted as today (`kind 'pug'`, status `live`, notify called once).

For `finishMatch`, use the orchestrator test pattern (`grep -ln "finishMatch" tests`): a live booking game whose dump says `ended` completes (`state completed`), `releaser.release` is not called, `notify` is not called, and `onBookingGameEnded` is called with the match id. A non-booking match still releases with `{ restart: true }`.

`bookingSideForTeamA` unit cases: majority a, majority b, tie (expect 'a'), nobody known (expect 'a').

- [ ] **Step 2: Run them to see them fail**

- [ ] **Step 3: Implement**

`src/bookings/games.ts` (header comment: what a booking game is, why it is adopted through auto-track, ruling 2):

```ts
import type { DB } from '../db.js';
import { holdFor } from '../serverHolds.js';
import { getBooking, peopleOf, type BookingRow, type Side } from './bookings.js';

export function bookingOnServer(db: DB, serverId: number): BookingRow | null {
  const hold = holdFor(db, serverId);
  if (hold?.kind !== 'booking') return null;
  const b = getBooking(db, hold.rowId);
  return b && b.ending_at === null && (b.state === 'ready' || b.state === 'active') ? b : null;
}

export function bookingSideForTeamA(db: DB, bookingId: number, teamA: string[], teamB: string[]): Side {
  const sideOf = new Map(peopleOf(db, bookingId).map((p) => [p.steamid, p.side] as const));
  // Score: people of booking side a on match team a, plus people of booking
  // side b on match team b, against the opposite pairing.
  let straight = 0, crossed = 0;
  for (const s of teamA) { const x = sideOf.get(s); if (x === 'a') straight++; else if (x === 'b') crossed++; }
  for (const s of teamB) { const x = sideOf.get(s); if (x === 'b') straight++; else if (x === 'a') crossed++; }
  return crossed > straight ? 'b' : 'a';
}

export interface BookingGameView {
  matchId: number; campaign: string; state: string; scoreA: number; scoreB: number;
  sideA: Side | null; startedAt: string; endedAt: string | null;
}

export function bookingGames(db: DB, bookingId: number): BookingGameView[] {
  return (db.prepare(
    `SELECT id, campaign, state, team_a_score, team_b_score, booking_side_a, created_at, ended_at
       FROM matches WHERE booking_id = ? ORDER BY id`,
  ).all(bookingId) as { id: number; campaign: string; state: string; team_a_score: number; team_b_score: number; booking_side_a: Side | null; created_at: string; ended_at: string | null }[])
    .map((r) => ({ matchId: r.id, campaign: r.campaign, state: r.state, scoreA: r.team_a_score, scoreB: r.team_b_score, sideA: r.booking_side_a, startedAt: r.created_at, endedAt: r.ended_at }));
}

export function liveBookingGame(db: DB, bookingId: number): { id: number; token: string; campaign: string } | null {
  return (db.prepare("SELECT id, token, campaign FROM matches WHERE booking_id = ? AND state = 'live' ORDER BY id DESC LIMIT 1")
    .get(bookingId) as { id: number; token: string; campaign: string } | undefined) ?? null;
}

export function abortBookingGame(db: DB, matchId: number, now: Date): string | null {
  const row = db.prepare("SELECT token FROM matches WHERE id = ? AND booking_id IS NOT NULL AND state = 'live'").get(matchId) as { token: string } | undefined;
  if (!row) return null;
  db.prepare("UPDATE matches SET state = 'aborted', abort_cause = 'booking_ended', ended_at = ? WHERE id = ? AND state = 'live'")
    .run(now.toISOString().replace('T', ' ').slice(0, 19), matchId);
  return row.token;
}
```

(`matches.ended_at` elsewhere is written as `datetime('now')`, i.e. `YYYY-MM-DD HH:MM:SS`; match that format. Check `matches.created_at` default for `startedAt` and use `went_live_at` if a booking game has one; self-started games do not stamp it.)

`src/selfStarted.ts` commit: after the `busy` check, read `const booking = bookingOnServer(db, serverId);`. In the transaction, when `booking`:

```ts
          const teamA = [...p.roster].filter(([, v]) => v.team === 'a').map(([s]) => s);
          const teamB = [...p.roster].filter(([, v]) => v.team === 'b').map(([s]) => s);
          id = Number(db.prepare(
            `INSERT INTO matches (season_id, state, campaign, server_id, token, origin, kind, visibility, rules_json, game_config, booking_id, booking_side_a)
             VALUES (?, 'live', ?, ?, ?, 'in_game', ?, 'participants', ?, ?, ?, ?)`,
          ).run(currentSeasonId(db), campaign, serverId, token, booking.purpose, booking.rules_json, booking.game_config, booking.id,
            bookingSideForTeamA(db, booking.id, teamA, teamB)).lastInsertRowid);
```

skip the `UPDATE servers SET status = 'live'`, and after the transaction log a `game_started` booking event and `markActive` (add a small exported `logBookingEvent(db, id, actor, event, detail, now)` to `bookings.ts` if `logEvent` is private there). Skip `this.deps.notify?.(...)` for a booking game. Everything else (player insert, `match_players`, `reportOverfull`, `register`, `setMatchId`) stays.

`src/orchestrator.ts` `finishMatch`: read `booking_id` with the match row. At the release point:

```ts
      if (match.booking_id !== null) {
        // A game inside a booking: the block carries on, so the box is the
        // booking's to keep and the result is private (participants only).
        this.onBookingGameEnded?.(matchId);
        return 'completed';
      }
      this.releaser.release(match.server_id, { restart: true });
```

with the `notify` moved below that branch. Add `onBookingGameEnded?: (matchId: number) => void` to `OrchestratorDeps` and the constructor. Wire it in `src/server.ts` (where the Orchestrator is built) to a late-bound reference to the booking runner (the runner is built later in `buildServer`; use a `let bookingRunnerRef: BookingRunner | null = null` declared before the orchestrator, assigned after the runner exists, and call `bookingRunnerRef?.onGameEnded(matchId)`). `onGameEnded` is added in Task 4; until then wire it to a no-op-safe optional call (`(bookingRunnerRef as { onGameEnded?: (id: number) => void } | null)?.onGameEnded?.(id)` is ugly: instead add an empty `onGameEnded(matchId: number): void {}` stub to `BookingRunner` in this task with a comment that Task 4 fills it).

- [ ] **Step 4: Run tests, typecheck, full suite; Step 5: Commit**

```bash
git commit -m "Booked games: a game started on a booked box is adopted as the booking's private scrim match, and finishing it leaves the box with the booking"
```

---

### Task 3: Who may see a booking's games

**Files:**
- Modify: `src/matchVisibility.ts`, `src/bookings/bookings.ts` (`bookingView` gains `games`), `web/src/api.ts` (`BookingView.games`)
- Test: `tests/matchVisibility.test.ts` (or the existing visibility test file: `grep -ln canViewMatch tests`), `tests/bookings.test.ts`

**Interfaces:**
- Produces: `canViewMatch` and `visibleMatchesSql`: a `participants` match with a `booking_id` is also visible to that booking's accepted people and to the managers of its sides. Staff and public unchanged.
- Produces: `BookingView.games: BookingGameView[]` (Task 2 type), and the web type mirror.

- [ ] **Step 1: Failing tests**

- An accepted spectator of the booking who is not in `match_players` can view the scrim match (`canViewMatch` true) and finds it in a `visibleMatchesSql` list query.
- An invited-but-not-accepted person and a stranger cannot.
- The existing guard test that walks every match route with a non-participant (`grep -rln "participants" tests | head`) still passes and gains one booking-game case if it is table-driven.
- `bookingView(...).games` lists the booking's games oldest first.

- [ ] **Step 2-4: Implement and run**

`canViewMatch`:

```ts
  if (row.visibility !== 'participants' || !viewer.steamid) return false;
  if (db.prepare('SELECT 1 FROM match_players WHERE match_id = ? AND player_id = ?').get(matchId, viewer.steamid)) return true;
  return bookingParticipant(db, matchId, viewer.steamid);
```

with a private `bookingParticipant` that selects the match's `booking_id` and returns true when the viewer is an accepted `booking_people` row of it, or a side's pickup captain, or a captain/co-captain of a side's team (same rule as `managesSide`; import `sidesOf`/`managesSide` from `./bookings/bookings.js` only if that creates no import cycle, otherwise inline the SQL). `visibleMatchesSql` gets the same as an extra `OR EXISTS (...)` clause on `booking_people` (accepted) and `booking_sides` (pickup captain) and `team_members` (captain/cocaptain of the side's team), with the viewer param repeated as needed.

- [ ] **Step 5: Commit**

```bash
git commit -m "Booked games: the booking's people and side managers can see its scrim matches and replays; the booking page lists its games"
```

---

### Task 4: Runner: set the box up for games, move through the playlist, end when everyone has left

**Files:**
- Modify: `src/bookings/runner.ts`, `src/bookings/bookings.ts` (small guarded writes), `src/server.ts` (deps)
- Test: `tests/bookingRunner.test.ts`

**Interfaces:**
- Consumes: Task 2 `liveBookingGame`, `bookingGames`, `abortBookingGame`; Task 1 columns and setting; 4a `typicalCampaignMinutes`, `firstMapOf`, `campaignRegistry`.
- Produces (`BookingRunnerDeps` additions): `logPublicAddress?: string` (the `ip:port` the site listens on; when absent, logging lines are skipped, which keeps 4a tests valid), `unregisterToken?: (token: string) => void`.
- Produces (bookings.ts): `setNext(db, id, campaign: string | null, atIso: string | null): void`, `advancePlaylist(db, id, pos: number): void` (sets `playlist_pos`, clears `next_*`), both plain guarded UPDATEs on open bookings, plus a `booking_events` row (`next_set`, `campaign_loaded`).
- Produces (runner):
  - `gameLines(db, b): string[]` pushed during setup after `bookingLines`: `sm_pug_auto_track 1`, `sm_pug_auto_min_players <setting>`, `sm_pug_pause_limit <rules.pause.limit ?? 0>`, `sm_pug_pause_seconds <rules.pause.seconds ?? 0>`, and when `logPublicAddress` is set, `logaddress_add <logPublicAddress>` plus the log secret line exactly as `pushLogSecret` (`src/logAuth.ts`) sends it when the server row has a `log_secret`. Re-sent by the minute watch together with `bookingLines` (cheap, idempotent; a map change can reset cvars a cfg sets).
  - `onGameEnded(matchId: number): void`: for an open running booking, picks the next campaign (`playlist[playlist_pos + 1]` or null), `setNext(id, next, now + 60 s)` when there is one, and says on the box: `[Booking] Next: <name> in 60 s. !nextmap to pick another, !stay to replay this one, !end to finish.` or, when the playlist is used up, `[Booking] That was the last campaign on the playlist. !nextmap <campaign> to play another, or !end to finish.`
  - In `tick`/`watch`, for a ready/active booking with `next_at <= now` and no live game: `changelevel <firstMap(next_campaign)>`, `advancePlaylist(id, index of next_campaign in the playlist, or the current pos when it is not in the playlist)`, then the campaign-start lines: `[Booking] <name>: !nextmap, !stay, !end and !extend are yours, captains.` and, when `typicalCampaignMinutes(next) > minutes left`, `[Booking] About <left> min left, this campaign usually takes <typical>. !extend now while the slot after is free.`
  - `chooseNext(id: number, by: string, wanted: string | null, staff = false): { ok: true; campaign: string } | { ok: false; error: string }`: rights (actingSides or staff), running state, no live game, campaign resolution (ruling 5; must be in the pool and loadable on the box per `pickBox`'s campaign test), then `setNext(id, campaign, now)` so the next watch loads it at once (or call the load directly; either way at most one changelevel).
  - `stay(id, by, staff = false)`: `chooseNext` with the campaign of the last game (or `playlist[playlist_pos]` when no game yet).
  - `endFromGame(id, by, staff = false)`: if a game is live, `abortBookingGame` + `unregisterToken` + `sm_pug_abort <token>`; then the domain `endBooking` (staff flag as given) and `settle`.
  - Everyone-left end (ruling 4): the watch tracks consecutive empty watches per booking in memory; with 2 in a row, at least one completed game, no live game, and the last game's `ended_at` at least 2 minutes ago, `endNow(id, 'done')`. `END_SAY.done = 'everyone left'`.

- [ ] **Step 1: Failing tests** (extend `tests/bookingRunner.test.ts`; insert booking game rows directly with `booking_id` for the runner's view of games)

1. Setup sends `sm_pug_auto_track 1`, `sm_pug_auto_min_players 6`, and the Casual Scrim pause lines (`sm_pug_pause_limit 0`, `sm_pug_pause_seconds 0`, since its pause is null/null).
2. `onGameEnded` on a 2-campaign playlist: says the Next line with the second campaign's name, sets `next_at` 60 s ahead; one watch at +59 s does nothing; one at +60 s sends `changelevel <first map of campaign 2>`, sets `playlist_pos` 1, says the captains line, and (with typical 60 min and 30 min left) the extend warning.
3. `onGameEnded` on the last campaign: says the playlist-used-up line; nothing scheduled.
4. `chooseNext(id, captain, 'death')` resolves Death Toll by prefix; `chooseNext(..., 'xyz')` refuses; while a game is live refuses with "Finish this game or use !end first."; a non-captain refuses.
5. `endFromGame` with a live game: the game is `aborted` / `booking_ended`, `sm_pug_abort <token>` is sent, the booking ends and winds down.
6. Everyone left: after a completed game that ended 3 minutes ago, two empty watches end the booking with `done`; one empty watch does not; an empty watch within 2 minutes of the game's end does not.

- [ ] **Step 2-4: Implement and run** (`npx vitest run tests/bookingRunner.test.ts && npm run typecheck`)

Wire `logPublicAddress: deps.config.logPublicAddress` and `unregisterToken: (t) => listener.unregister(t)` (use the real listener variable name in `buildServer`) in `src/server.ts`.

- [ ] **Step 5: Commit**

```bash
git commit -m "Booked games: the box is set up to record games, the playlist moves on 60 s after each game unless a captain picks another, and the booking ends once everyone has left after a finished game"
```

---

### Task 5: `l4d_booking` 1.1.0: captain commands as signed log lines

**Files:**
- Modify: `plugin/l4d_booking.sp`, `plugin/build-booking.sh`, `plugin/README.md`

**Interfaces:**
- Produces: cvar `l4d_booking_captains` (comma-separated SteamID64s, `FCVAR_DONTRECORD`). Chat commands, only while `l4d_booking_password` is non-empty: `!nextmap [text]`, `!stay`, `!end`, `!extend`. From a SteamID64 in the captains list, the plugin emits through `PugLog`:
  `PUGBOOK event=cmd cmd=<nextmap|stay|end|extend> steamid=<id64> arg=<text>` (arg last, free text, at most 64 characters, `"`, `;` and line breaks removed; empty allowed) and prints `[Booking] Sent to the site.` to that client. From anyone else: `[Booking] Only a captain can do that.` The chat line itself still shows (return `Plugin_Continue`).
- Produces: server command `sm_booking_cmd <steamid64> <cmd> [arg...]` that emits the same line without the captain check, for testing and staff.
- Produces: `l4d_booking_version` "1.1.0".

- [ ] **Step 1: Implement**

Include `pug-logauth.inc` (which pulls `pug-hmac.inc`) and call `PugLogAuth_Init()` in `OnPluginStart`, as `l4d_tvwatch.sp` does. Read the SteamID64 with `GetClientAuthId(client, AuthId_SteamID64, ...)`. Parse the captains cvar by exact comma-separated match (wrap both in commas and `StrContains(",<list>,", ",<id>,")`). Use `OnClientSayCommand(int client, const char[] command, const char[] sArgs)`; trim, require the leading `!` and an exact command word followed by end or a space. `build-booking.sh` copies `pug-logauth.inc` and `pug-hmac.inc` into the scripting tree with the same trap cleanup as `build-tvwatch.sh`. README: one paragraph on the commands and the `PUGBOOK` line.

- [ ] **Step 2: Build and check on the local server**

`plugin/build-booking.sh`; then, each change gated on `python3 /home/volence/l4d1-ds/rcon-local.py status | grep -q ' 0 humans' &&`: copy the .smx into the local plugins dir, `sm plugins load_unlock` only if loading is locked (put it back after), `sm plugins load l4d_booking`, `l4d_booking_version` reads 1.1.0, `logaddress_list` (note it), then `sm_booking_cmd 76561199000000001 nextmap dead air` and read `/home/volence/l4d1-ds/server-live.log` (or the console log path the local server uses) for the `PUGBOOK event=cmd cmd=nextmap steamid=76561199000000001 arg=dead air` line. Unload and remove the plugin afterwards and confirm the box is as before. Record exactly what was seen in the commit message.

- [ ] **Step 3: Commit** (the .smx is not tracked; do not add it)

```bash
git commit -m "l4d_booking 1.1.0: captains' !nextmap, !stay, !end and !extend go to the site as signed PUGBOOK lines"
```

---

### Task 6: The site acts on captain commands

**Files:**
- Modify: `src/logParse.ts` (`PUGBOOK` → `{ kind: 'booking_cmd'; steamid: string; cmd: 'nextmap' | 'stay' | 'end' | 'extend'; arg: string }`), `src/logListener.ts` (token-less, address-gated list gains `'booking_cmd'`), `src/server.ts` (dispatch), `src/bookings/runner.ts` (`onCommand`, captains push)
- Test: `tests/logParse*.test.ts` (the parser's existing test file), `tests/bookingRunner.test.ts`

**Interfaces:**
- Produces: `parseLogDatagram` returns `booking_cmd` only for a well-formed line (17-digit steamid, known cmd; arg is the rest after ` arg=`, trimmed, at most 64 chars); anything else returns null.
- Produces: `BookingRunner.onCommand(serverId: number, steamid: string, cmd, arg): void`: finds `bookingOnServer`; does nothing (one log line) when there is none, when the booking is ending, or when the sender does not manage a confirmed side. Otherwise: `nextmap` → `chooseNext(id, steamid, arg || null)`; `stay` → `stay`; `end` → `endFromGame`; `extend` → domain `extendBooking` then `onExtended` (4a fix wave). Each result is said on the box: success lines as in Task 4, refusals as `[Booking] <reason>` (console-safe via `consoleText`).
- Produces: the captains list `l4d_booking_captains "<ids>"` (every manager of a confirmed side, comma-separated) is part of `gameLines`, so setup and every watch push it.

- [ ] **Step 1: Failing tests**

Parser: a good line; a bad steamid; an unknown cmd; an `arg=` carrying `cmd=end` text (must not change the cmd: read `cmd` and `steamid` from the part before ` arg=` only, like `PUGTV`'s `reason=` handling); no `arg=` at all (arg empty). Runner: `onCommand` from a captain with `nextmap` schedules the next campaign; from a non-captain does nothing and sends nothing; on a box with no booking does nothing; `extend` extends and says the new end; `end` ends.

- [ ] **Step 2-4: Implement and run.** Dispatch in `src/server.ts` beside the `sourcetv` branch:

```ts
        if (ev.kind === 'booking_cmd') {
          try {
            const sid = serverOf(source, meta);
            if (sid !== null) bookingRunnerRef?.onCommand(sid, ev.steamid, ev.cmd, ev.arg);
          } catch (err) {
            console.error('[booking] command line failed:', err);
          }
          return;
        }
```

- [ ] **Step 5: Commit**

```bash
git commit -m "Booked games: captains' in-game commands reach the booking runner, re-checked against current rights"
```

---

### Task 7: Booking page: games and between-games controls

**Files:**
- Modify: `src/routes/bookings.ts` (two actions), `web/src/api.ts`, `web/src/routes/Booking.tsx`, its test
- Test: `tests/bookingRoutes.test.ts`, `web/src/routes/Booking.test.tsx`

**Interfaces:**
- Produces: `POST /api/bookings/:id/next` body `{ campaign?: string }` → `runner.chooseNext(id, me, campaign ?? null, isStaff(me))`; `POST /api/bookings/:id/stay` → `runner.stay(...)`. Both answer the fresh view, or `409 { error }` with the runner's refusal text. A staff caller acting outside their own side is audited with `logAdmin` (`booking_next`, `booking_stay`).
- Produces: web `bookingsApi.next(id, campaign?)`, `bookingsApi.stay(id)`; the booking page shows a "Games" panel (campaign name, score as "<side a name> X : Y <side b name>" using `sideA` to orient, state, a link to `/match/<id>`) and, for a running booking with no live game, a campaign select (from `GET /api/bookings/options` campaigns) with "Play this next" and a "Replay last campaign" button, shown to managers of a confirmed side and staff.

- [ ] **Step 1-4:** route tests (captain can, stranger 404, refusal 409 with text, staff audited); web tests (Games panel renders and orients the score; controls hidden while a game is live; clicking calls the API). Run web tests, typecheck, `cd web && npm run build`.

- [ ] **Step 5: Commit**

```bash
git commit -m "Booking page: the block's games with scores, and Play next / Replay controls between games"
```

---

## After the last task

- Full suite, typecheck, web build.
- Whole-branch review against this plan and spec section 3.
- Hand-off for the owner: stage `l4d_booking` 1.1.0 on every pool box (it replaces 1.0.0); keep the switch on `admins` until plan 4b2 (allowlist) lands; first live test: two admins on a booked box, 3v3 on teams, ready up, play a map, `!stay`, `!end`.
