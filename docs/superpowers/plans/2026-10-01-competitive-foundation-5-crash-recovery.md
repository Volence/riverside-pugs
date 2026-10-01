# Competitive foundation 5: crash recovery for booked servers

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a booked box's srcds restarts or the box dies mid-booking, the site notices on its own, sets the booking up again (on the same box, or on another one if the box is gone), and puts a live booking game back on the map it was on with the scores it had, then tells both sides and staff.

**Architecture:** The minute watch in `BookingRunner` already sends `status` to every running booking's box. It now also reads a new boot marker, `l4d_booking_id`, which l4d_booking 1.4.0 holds and only setup and recovery write. If the marker comes back empty, srcds restarted and the booking is set up again on the same box. If rcon fails, the site records when the box went quiet and asks it over A2S (new `src/a2s.ts`). Only when rcon, the live game's heartbeat and A2S have all been silent for `booking_gone_minutes` (3) does the booking drop the box and wait for another one. While it waits, it is first in line ahead of new PUGs. A live game is rebuilt from the site's own `match_rounds` (new `src/bookings/restore.ts`) through a new pug-match command, `sm_pug_resume` (0.3.19). At go-live, the plugin seeds l4dscores' tally with a new `sm_l4dscores_seed` (fork 8.5.9-riverside3), so the next map's side order still follows the real totals.

**Tech Stack:** TypeScript (Node, better-sqlite3, vitest), Preact for the web, SourcePawn 1.12 for the plugins (spcomp under wine).

**Spec:** `docs/superpowers/specs/2026-09-30-competitive-foundation-design.md`, section 4 "Crash recovery" (also section 3 Lifecycle and "Error handling"). Earlier plans in this series: `docs/superpowers/plans/2026-09-30-competitive-foundation-4a-bookings.md`, `2026-10-01-competitive-foundation-4b-booked-games.md`, `2026-10-01-competitive-foundation-4b2-allowlist.md`.

## Global Constraints

- rcon alone is never the signal that a box is gone: a box counts as gone only after `booking_gone_minutes` (default 3) of no rcon answer, no heartbeat from its live game and no A2S answer, all together.
- If A2S answers (with players or without) while rcon does not, nothing moves; staff get one alert per outage.
- An srcds restart (the box answers but the boot marker is empty) is restored on the same box.
- Waiting for a box to move to puts the booking ahead of new PUGs (it counts in `bookingsDue`). This is the only case where a booking outranks the PUG queue.
- Every booking state change is one transaction with a `booking_events` row (`logEvent`), as in `src/bookings/bookings.ts`.
- One short rcon connection per burst (`BoxRcon`). Nothing holds a connection across a wait, and nothing opens parallel rcon sessions to a box.
- Log lines and admin events never carry the log secret, the booking passwords or allowlist ids (`redactSecrets`, `hideAllowIds`).
- No em dashes anywhere: code, comments, copy, commits.
- Every new number is a setting in the Competitive group, not a constant: `booking_gone_minutes` (3, 2..15) and `booking_recover_wait_minutes` (20, 5..60).
- Nothing deploys without the owner's go-ahead. The plugins stage through `deploy/tools/stage-on-restart.sh` on the pool boxes. l4d_booking is staged nowhere yet, so 1.4.0 is what gets staged first.

## Rulings this plan makes (for the owner to confirm in review)

1. **The interrupted map is replayed from its start.** Half 1 of a map cannot be resumed in the engine, and the plugin cannot attribute a resumed half 2 (`g_iRound1*` would be 0). Completed maps keep their exact scores. Any `match_rounds` rows of the interrupted map are deleted at restore, so its rows are rewritten when it is played again.
2. **Player stats of a restored game cover only the maps played after the restore.** Plugin stats live in memory and die with srcds, and the dump at the end is the authoritative record. Scores stay exact. The match row records `restored_at_map` (the ordinal of the replayed map), and the booking page and the match page say "Stats from map N on: the server restarted".
3. **A booking waits at most `booking_recover_wait_minutes` (20) for a replacement box.** After that, its live game is aborted (`server_lost`) and the booking closes as `cancelled` / `server_lost`. That is not a no-show and not a late cancel for anyone.
4. **A box judged gone is marked offline** (`servers.status = 'offline'`), and staff are told to set it idle on the Servers desk once it answers again. Nothing automatic puts it back.
5. **If setting a restart up again fails twice** (exec, map or plugin check), the booking closes as `cancelled` / `server_lost`, the same as rule 3. If only the game's restore fails (for example an old pug-match without `sm_pug_resume`), the game is aborted (`server_lost`), the booking carries on with the box set up for the next campaign, and staff are told.
6. **The in-game scoreboard total** (the engine's own campaign score) shows only the maps played since the restore. Writing it needs a left4dhooks call whose team mapping is unverified. l4dscores' tally, which is what decides who survives first on the next map, is seeded, and the restore line in chat states the real score.

## Review Focus

- **A restart during a captain-picked campaign load** (box restarts while `next_campaign` is set and no game is live): expected to restore to the campaign that was loading, and never to replay the previous one. Pinned in Task 7 (`restores the loading campaign`).
- **A web restart in the middle of a recovery**: expected to pick the recovery up again, either on the same box or still waiting for one, and never to leave the booking stuck with `recovering_at` set and nothing working on it. Pinned in Task 7 (`resume() restarts a recovery`) and Task 8 (`a waiting booking survives a web restart`).
- **Idle end right after a recovery**: everyone is reconnecting, so the first watch after a restore sees 0 humans. Expected not to end the booking as idle. Pinned in Task 7 (`no idle end right after a restore`).
- **A self-started match on a restarted box before the site restores it**: 6 or more players ready up on the fresh box. Expected that it is never adopted as a second game of the booking. Pinned in Task 9 (`selfStarted refuses adoption during recovery`), and the recovery burst also starts with `sm_pug_auto_track 0`.
- **The orphan reaper during a long wait**: the live game has no heartbeat for 10 or more minutes while the booking waits for a box. Expected that the reaper leaves it alone, so the give-up path aborts it with the right cause. Pinned in Task 9 (`reaper skips a recovering booking's game`).

---

## File structure

- `src/db.ts` (modify): new columns on `bookings`: `recovering_at`, `recover_reason`, `lost_since`, `a2s_seen_at`, `up_alerted_at`, `recoveries`, `waiting_since`. New column on `matches`: `restored_at_map`. Default settings `booking_gone_minutes`, `booking_recover_wait_minutes`.
- `src/settingsSchema.ts` (modify): the two settings.
- `src/bookings/rules.ts` (modify): `bookingLimits` gains `goneMinutes` and `recoverWaitMinutes`; `bookingsDue` counts waiting bookings.
- `src/bookings/bookings.ts` (modify): `BookingRow` fields, plus the recovery writes `noteLost`, `noteAlive`, `noteA2s`, `markUpAlerted`, `beginRecovery`, `dropBox`, `reholdBox`, `finishRecovery`, and `recovery` on `BookingView`.
- `src/bookings/recovery.ts` (create): pure liveness classification, `classifyBox`.
- `src/bookings/restore.ts` (create): `restoreSnapshot` from the DB and `resumeLines` for the plugin.
- `src/a2s.ts` (create): one A2S_INFO query with challenge handling.
- `src/bookings/runner.ts` (modify): the boot marker in setup, detection in `watch`, `recover()` for the same box, the move, the wait and give-up, and `resume()`.
- `src/bookings/messages.ts`, `src/notify/notify.ts` (modify): `booking_recovered` notice.
- `src/liveView.ts` (modify): the reaper skips games of recovering bookings.
- `src/selfStarted.ts` (modify): no adoption on a recovering booking's box.
- `src/server.ts` (modify): wiring `a2s` into the runner.
- `web/src/routes/Booking.tsx` (modify): the recovery banner and the restored-at-map note.
- `plugin/pug-match.sp` (modify, 0.3.19): `sm_pug_resume`, `sm_pug_resume_map`, `sm_pug_roster` joined map, resumed side seed, l4dscores seed at go-live.
- `plugin/l4d_booking.sp` (modify, 1.4.0): `l4d_booking_id` cvar.
- `/home/volence/l4d/deploy/plugins-src/l4dscores.sp` (modify, 8.5.9-riverside3, deploy repo): `sm_l4dscores_seed`.
- Tests: `tests/bookingRecovery.test.ts` (create), `tests/bookingRestore.test.ts` (create), `tests/a2s.test.ts` (create), plus additions to `tests/bookingsSchema.test.ts`, `tests/liveView.test.ts` and `web/src/routes/Booking.test.tsx`.

---

### Task 1: Schema, settings and the recovery writes

**Files:**
- Modify: `src/db.ts` (ensureColumn block after the booking_sides excuse columns, about line 1999; defaults block about line 1217)
- Modify: `src/settingsSchema.ts` (after `booking_allow_block_minutes`, line 116)
- Modify: `src/bookings/rules.ts` (`BookingLimits`, `bookingLimits`, `bookingsDue`)
- Modify: `src/bookings/bookings.ts` (`BookingRow`, the runner writes section)
- Test: `tests/bookingRecovery.test.ts` (create), `tests/bookingsSchema.test.ts`

**Interfaces:**
- Produces:
  - `BookingRow` gains `recovering_at: string | null; recover_reason: 'restart' | 'gone' | null; lost_since: string | null; a2s_seen_at: string | null; up_alerted_at: string | null; recoveries: number; waiting_since: string | null`.
  - `BookingLimits` gains `goneMinutes: number; recoverWaitMinutes: number`.
  - `noteLost(db, id, now: Date): string`: sets `lost_since` if null; returns the stored value.
  - `noteAlive(db, id): void`: clears `lost_since`, `a2s_seen_at` and `up_alerted_at`.
  - `noteA2s(db, id, now: Date): void`: sets `a2s_seen_at`.
  - `markUpAlerted(db, id, now: Date): boolean`: true only the first time in an outage.
  - `beginRecovery(db, id, reason: 'restart' | 'gone', now: Date): boolean`: only on a running booking (ready or active, no end started, `recovering_at` null).
  - `dropBox(db, id, now: Date): number | null`: the box id given up; sets `server_id = NULL`, `waiting_since = now`, marks that server offline, and points nothing else at it.
  - `reholdBox(db, id, serverId, now: Date): boolean`: takes an idle, enabled, unheld box for a waiting booking and moves its live game's `matches.server_id` with it.
  - `finishRecovery(db, id, now: Date): boolean`: clears `recovering_at`, `recover_reason`, `lost_since`, `a2s_seen_at`, `up_alerted_at` and `waiting_since`, adds 1 to `recoveries`, and sets `last_human_at = now` (idle-end grace).

- [ ] **Step 1: Write the failing tests**

Create `tests/bookingRecovery.test.ts` with the shared fixture (copy the top of `tests/bookingRunner.test.ts` lines 1-106 verbatim: imports, `P`, `START`, `MIN`, `PUB`, the fake box, `build`, `beforeEach`, `book`). Then add:

```ts
import {
  beginRecovery, dropBox, finishRecovery, markUpAlerted, noteA2s, noteAlive, noteLost, reholdBox,
} from '../src/bookings/bookings.js';
import { bookingLimits, bookingsDue } from '../src/bookings/rules.js';

/** A booking set up and running on box ccc (server 3). */
async function running(): Promise<number> {
  const id = book();
  now = START - 15 * MIN;
  runner.allocate();
  await runner.idle();
  expect(getBooking(db, id)!.state).toBe('ready');
  now = START;
  return id;
}

describe('recovery writes', () => {
  it('beginRecovery only on a running booking, once', async () => {
    const id = await running();
    expect(beginRecovery(db, id, 'restart', new Date(now))).toBe(true);
    expect(beginRecovery(db, id, 'restart', new Date(now))).toBe(false);
    const b = getBooking(db, id)!;
    expect(b.recover_reason).toBe('restart');
    const ev = db.prepare("SELECT detail FROM booking_events WHERE booking_id = ? AND event = 'recovery_started'").get(id) as { detail: string };
    expect(JSON.parse(ev.detail)).toEqual({ reason: 'restart', serverId: 3 });
  });

  it('noteLost keeps the first time, noteAlive clears the outage', async () => {
    const id = await running();
    const first = noteLost(db, id, new Date(now));
    expect(noteLost(db, id, new Date(now + MIN))).toBe(first);
    noteA2s(db, id, new Date(now));
    expect(markUpAlerted(db, id, new Date(now))).toBe(true);
    expect(markUpAlerted(db, id, new Date(now))).toBe(false);
    noteAlive(db, id);
    expect(getBooking(db, id)).toMatchObject({ lost_since: null, a2s_seen_at: null, up_alerted_at: null });
  });

  it('dropBox gives up the box, marks it offline, and the waiting booking is kept a box ahead of PUGs', async () => {
    const id = await running();
    beginRecovery(db, id, 'gone', new Date(now));
    expect(dropBox(db, id, new Date(now))).toBe(3);
    expect(getBooking(db, id)).toMatchObject({ server_id: null, state: 'ready' });
    expect((db.prepare('SELECT status FROM servers WHERE id = 3').get() as { status: string }).status).toBe('offline');
    expect(bookingsDue(db, now, bookingLimits(db).protectMinutes)).toBe(1);
  });

  it('reholdBox takes an idle unheld box and moves the live game with it', async () => {
    const id = await running();
    const m = Number(db.prepare(
      "INSERT INTO matches (season_id, state, campaign, server_id, token, origin, kind, visibility, booking_id) VALUES (?, 'live', 'no_mercy', 3, 'tok', 'in_game', 'scrim', 'participants', ?)",
    ).run(currentSeasonId(db), id).lastInsertRowid);
    beginRecovery(db, id, 'gone', new Date(now));
    dropBox(db, id, new Date(now));
    expect(reholdBox(db, id, 3, new Date(now))).toBe(false); // offline now
    expect(reholdBox(db, id, 2, new Date(now))).toBe(true);
    expect(getBooking(db, id)!.server_id).toBe(2);
    expect((db.prepare('SELECT server_id FROM matches WHERE id = ?').get(m) as { server_id: number }).server_id).toBe(2);
    expect(bookingsDue(db, now, bookingLimits(db).protectMinutes)).toBe(0);
  });

  it('finishRecovery clears the outage, counts it and restarts the idle clock', async () => {
    const id = await running();
    beginRecovery(db, id, 'restart', new Date(now));
    noteLost(db, id, new Date(now));
    expect(finishRecovery(db, id, new Date(now + 2 * MIN))).toBe(true);
    expect(getBooking(db, id)).toMatchObject({
      recovering_at: null, recover_reason: null, lost_since: null, waiting_since: null, recoveries: 1,
      last_human_at: new Date(now + 2 * MIN).toISOString(),
    });
  });

  it('the limits read the two settings with their bounds', () => {
    expect(bookingLimits(db)).toMatchObject({ goneMinutes: 3, recoverWaitMinutes: 20 });
    setSetting(db, 'booking_gone_minutes', '1');
    setSetting(db, 'booking_recover_wait_minutes', '999');
    expect(bookingLimits(db)).toMatchObject({ goneMinutes: 2, recoverWaitMinutes: 60 });
  });
});
```

In `tests/bookingsSchema.test.ts` add:

```ts
it('has the crash recovery columns', () => {
  const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  expect(cols('bookings')).toEqual(expect.arrayContaining(['recovering_at', 'recover_reason', 'lost_since', 'a2s_seen_at', 'up_alerted_at', 'recoveries', 'waiting_since']));
  expect(cols('matches')).toContain('restored_at_map');
});
```

(Use whatever `db` that file's `beforeEach` opens.)

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/bookingRecovery.test.ts tests/bookingsSchema.test.ts`
Expected: FAIL (`beginRecovery` is not exported; the columns are missing).

- [ ] **Step 3: Implement**

`src/db.ts`, in the defaults object next to `booking_allow_block_minutes: '30',`:

```ts
  booking_gone_minutes: '3',
  booking_recover_wait_minutes: '20',
```

`src/db.ts`, after the `excuse_note` ensureColumn:

```ts
  // Crash recovery (plan 5). recovering_at: a recovery is running (same box
  // after an srcds restart, or a move). lost_since / a2s_seen_at /
  // up_alerted_at: the current outage, cleared once rcon answers again.
  // waiting_since: the box was given up and the booking waits for another.
  ensureColumn(db, 'bookings', 'recovering_at', 'TEXT');
  ensureColumn(db, 'bookings', 'recover_reason', "TEXT CHECK (recover_reason IN ('restart','gone'))");
  ensureColumn(db, 'bookings', 'lost_since', 'TEXT');
  ensureColumn(db, 'bookings', 'a2s_seen_at', 'TEXT');
  ensureColumn(db, 'bookings', 'up_alerted_at', 'TEXT');
  ensureColumn(db, 'bookings', 'recoveries', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'bookings', 'waiting_since', 'TEXT');
  // The ordinal of the map a restored booking game was replayed from: its
  // player stats cover only that map on (plan 5 ruling 2). Null: never restored.
  ensureColumn(db, 'matches', 'restored_at_map', 'INTEGER');
```

`src/settingsSchema.ts`, after the `booking_allow_block_minutes` entry:

```ts
  { key: 'booking_gone_minutes', group: 'Competitive', label: 'A booked server counts as gone after (minutes)', help: 'How long rcon, the live game and the server browser query must all be silent before a booking moves to another server. A server that still answers the browser query is never moved; staff are told instead.', type: { kind: 'int', min: 2, max: 15 } },
  { key: 'booking_recover_wait_minutes', group: 'Competitive', label: 'Wait for a replacement server (minutes)', help: 'After its server is gone, how long a booking waits for another one (ahead of new PUGs) before it is cancelled.', type: { kind: 'int', min: 5, max: 60 } },
```

`src/bookings/rules.ts`: add `goneMinutes: number; recoverWaitMinutes: number;` to `BookingLimits` and to the returned object:

```ts
    goneMinutes: n('booking_gone_minutes', 3, 2, 15),
    recoverWaitMinutes: n('booking_recover_wait_minutes', 20, 5, 60),
```

Replace `bookingsDue` with:

```ts
/** Idle boxes claimIdle keeps back: one per confirmed booking without a box
 *  that starts within the window, and one per running booking whose box was
 *  given up and is waiting for another (plan 5: the only time a booking is
 *  ahead of the PUG queue). */
export function bookingsDue(db: DB, nowMs: number, withinMinutes: number): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM bookings b
      WHERE b.server_id IS NULL AND b.ending_at IS NULL AND (
        (b.state = 'scheduled' AND b.starts_at <= ? AND b.ends_at > ?
          AND NOT EXISTS (SELECT 1 FROM booking_sides s WHERE s.booking_id = b.id AND s.confirmed_at IS NULL))
        OR (b.state IN ('ready','active') AND b.waiting_since IS NOT NULL))`,
  ).get(iso(nowMs + withinMinutes * 60_000), iso(nowMs)) as { n: number }).n;
}
```

`src/bookings/bookings.ts`: add to `BookingRow`:

```ts
  /** Crash recovery (plan 5): see src/db.ts. */
  recovering_at: string | null; recover_reason: 'restart' | 'gone' | null; lost_since: string | null;
  a2s_seen_at: string | null; up_alerted_at: string | null; recoveries: number; waiting_since: string | null;
```

At the end of the runner writes section (after `setCloseAt`), add:

```ts
// ---------- crash recovery (plan 5) ----------

/** The first moment of the current outage (rcon stopped answering); kept
 *  across calls so the gone clock never restarts while the box stays silent. */
export function noteLost(db: DB, id: number, now: Date): string {
  db.prepare('UPDATE bookings SET lost_since = ? WHERE id = ? AND lost_since IS NULL').run(now.toISOString(), id);
  return (db.prepare('SELECT lost_since FROM bookings WHERE id = ?').get(id) as { lost_since: string }).lost_since;
}

/** rcon answered: the outage, if any, is over. Bookkeeping only. */
export function noteAlive(db: DB, id: number): void {
  db.prepare('UPDATE bookings SET lost_since = NULL, a2s_seen_at = NULL, up_alerted_at = NULL WHERE id = ? AND lost_since IS NOT NULL').run(id);
}

/** The box answered an A2S query during the outage. */
export function noteA2s(db: DB, id: number, now: Date): void {
  db.prepare('UPDATE bookings SET a2s_seen_at = ? WHERE id = ?').run(now.toISOString(), id);
}

/** True the first time in an outage: staff are told once that the box is up
 *  but rcon is not answering. */
export function markUpAlerted(db: DB, id: number, now: Date): boolean {
  return db.prepare('UPDATE bookings SET up_alerted_at = ? WHERE id = ? AND up_alerted_at IS NULL').run(now.toISOString(), id).changes > 0;
}

export function beginRecovery(db: DB, id: number, reason: 'restart' | 'gone', now: Date): boolean {
  return db.transaction(() => {
    const changed = db.prepare(
      `UPDATE bookings SET recovering_at = ?, recover_reason = ?
        WHERE id = ? AND state IN ('ready','active') AND ending_at IS NULL AND recovering_at IS NULL AND server_id IS NOT NULL`,
    ).run(now.toISOString(), reason, id).changes > 0;
    if (changed) {
      const serverId = (db.prepare('SELECT server_id FROM bookings WHERE id = ?').get(id) as { server_id: number }).server_id;
      logEvent(db, id, null, 'recovery_started', { reason, serverId }, now);
    }
    return changed;
  })();
}

/** The box is gone (plan 5 ruling 4): the booking lets go of it and waits for
 *  another, and the box goes offline so nothing else is handed it. Returns
 *  the box given up, or null when there was nothing to give up. */
export function dropBox(db: DB, id: number, now: Date): number | null {
  return db.transaction(() => {
    const b = db.prepare("SELECT server_id FROM bookings WHERE id = ? AND recovering_at IS NOT NULL AND ending_at IS NULL AND server_id IS NOT NULL")
      .get(id) as { server_id: number } | undefined;
    if (!b) return null;
    db.prepare('UPDATE bookings SET server_id = NULL, waiting_since = ? WHERE id = ?').run(now.toISOString(), id);
    db.prepare("UPDATE servers SET status = 'offline' WHERE id = ?").run(b.server_id);
    logEvent(db, id, null, 'box_dropped', { serverId: b.server_id }, now);
    return b.server_id;
  })();
}

/** A waiting booking takes another box: idle, enabled, held by nothing. The
 *  live game (if any) moves with it, so the dump is pulled from the right box. */
export function reholdBox(db: DB, id: number, serverId: number, now: Date): boolean {
  return db.transaction(() => {
    const changed = db.prepare(
      `UPDATE bookings SET server_id = ?, waiting_since = NULL
        WHERE id = ? AND server_id IS NULL AND waiting_since IS NOT NULL AND recovering_at IS NOT NULL AND ending_at IS NULL
          AND ? IN (SELECT id FROM servers WHERE status = 'idle' AND enabled = 1 AND ${NOT_HELD_SQL})`,
    ).run(serverId, id, serverId).changes > 0;
    if (!changed) return false;
    db.prepare("UPDATE matches SET server_id = ? WHERE booking_id = ? AND state = 'live'").run(serverId, id);
    logEvent(db, id, null, 'box_moved', { serverId }, now);
    return true;
  })();
}

/** The recovery is done: the outage fields clear and the idle clock restarts,
 *  since everyone is reconnecting (Review Focus: no idle end right after). */
export function finishRecovery(db: DB, id: number, now: Date): boolean {
  return db.transaction(() => {
    const changed = db.prepare(
      `UPDATE bookings SET recovering_at = NULL, recover_reason = NULL, lost_since = NULL, a2s_seen_at = NULL,
              up_alerted_at = NULL, waiting_since = NULL, recoveries = recoveries + 1, last_human_at = ?
        WHERE id = ? AND recovering_at IS NOT NULL AND server_id IS NOT NULL`,
    ).run(now.toISOString(), id).changes > 0;
    if (changed) logEvent(db, id, null, 'recovered', {}, now);
    return changed;
  })();
}
```

(`logEvent` and `NOT_HELD_SQL` are already in scope in bookings.ts, since `holdBox` uses both. Add `currentSeasonId` to the test imports from `../src/players.js`.)

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run tests/bookingRecovery.test.ts tests/bookingsSchema.test.ts tests/bookingRules.test.ts tests/bookingHolds.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/settingsSchema.ts src/bookings/rules.ts src/bookings/bookings.ts tests/bookingRecovery.test.ts tests/bookingsSchema.test.ts
git commit -m "Bookings: crash recovery columns, settings and state writes; a booking waiting for a new box is kept one ahead of PUGs"
```

---

### Task 2: Liveness classification

**Files:**
- Create: `src/bookings/recovery.ts`
- Test: `tests/bookingRecovery.test.ts` (new describe)

**Interfaces:**
- Produces:

```ts
export type BoxVerdict =
  | { kind: 'ok' }            // rcon answers and the marker is ours (or the plugin is too old to have one)
  | { kind: 'restarted' }     // rcon answers but the marker is empty or not this booking's
  | { kind: 'quiet' }         // rcon failed; not long enough, or the heartbeat is still fresh
  | { kind: 'up_no_rcon'; players: number } // rcon silent past the limit, A2S answers
  | { kind: 'gone' };         // rcon, heartbeat and A2S all silent past the limit
export interface BoxSignals {
  rconOk: boolean;
  /** cvarValue(reply, 'l4d_booking_id'): null when the cvar does not exist (l4d_booking older than 1.4.0). */
  marker: string | null;
  bookingId: number;
  nowMs: number;
  lostSinceMs: number | null;
  /** match_live.last_seen of the live game, in ms; null when there is no live game or no heartbeat yet. */
  heartbeatMs: number | null;
  /** The A2S answer of this check: null for no answer, else the player count. Only asked when rcon failed. */
  a2sPlayers: number | null;
  goneMs: number;
}
export function classifyBox(s: BoxSignals): BoxVerdict;
```

- [ ] **Step 1: Write the failing test**

```ts
import { classifyBox, type BoxSignals } from '../src/bookings/recovery.js';

describe('classifyBox', () => {
  const base: BoxSignals = { rconOk: true, marker: '7', bookingId: 7, nowMs: 1_000_000, lostSinceMs: null, heartbeatMs: null, a2sPlayers: null, goneMs: 3 * MIN };
  it('ok when rcon answers with our marker, or with no marker cvar at all (old plugin)', () => {
    expect(classifyBox(base)).toEqual({ kind: 'ok' });
    expect(classifyBox({ ...base, marker: null })).toEqual({ kind: 'ok' });
  });
  it('restarted when rcon answers and the marker is empty or another booking', () => {
    expect(classifyBox({ ...base, marker: '' })).toEqual({ kind: 'restarted' });
    expect(classifyBox({ ...base, marker: '8' })).toEqual({ kind: 'restarted' });
  });
  it('quiet while rcon has failed for less than the limit', () => {
    expect(classifyBox({ ...base, rconOk: false, lostSinceMs: base.nowMs - 2 * MIN })).toEqual({ kind: 'quiet' });
  });
  it('quiet while the live game still heartbeats, however long rcon has failed', () => {
    expect(classifyBox({ ...base, rconOk: false, lostSinceMs: base.nowMs - 10 * MIN, heartbeatMs: base.nowMs - 40_000 })).toEqual({ kind: 'quiet' });
  });
  it('up_no_rcon when A2S answers past the limit, with or without players', () => {
    expect(classifyBox({ ...base, rconOk: false, lostSinceMs: base.nowMs - 3 * MIN, a2sPlayers: 5 })).toEqual({ kind: 'up_no_rcon', players: 5 });
    expect(classifyBox({ ...base, rconOk: false, lostSinceMs: base.nowMs - 3 * MIN, a2sPlayers: 0 })).toEqual({ kind: 'up_no_rcon', players: 0 });
  });
  it('gone when rcon, heartbeat and A2S are all silent past the limit', () => {
    expect(classifyBox({ ...base, rconOk: false, lostSinceMs: base.nowMs - 3 * MIN, heartbeatMs: base.nowMs - 4 * MIN })).toEqual({ kind: 'gone' });
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/bookingRecovery.test.ts -t classifyBox`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/bookings/recovery.ts`**

```ts
/**
 * Is a booked box still there (spec part 1 section 4, Crash recovery; plan 5)?
 *
 * rcon alone is never the signal: rcon to our boxes drops out now and then
 * while the game runs fine. A box that answers rcon has restarted when the
 * boot marker l4d_booking_id (l4d_booking 1.4.0, written only by setup and
 * recovery) is no longer this booking's. A box that does not answer rcon is
 * gone only when, for the whole limit, its live game has not heartbeated
 * either and it does not answer A2S, a separate UDP path.
 */
export type BoxVerdict =
  | { kind: 'ok' }
  | { kind: 'restarted' }
  | { kind: 'quiet' }
  | { kind: 'up_no_rcon'; players: number }
  | { kind: 'gone' };

export interface BoxSignals {
  rconOk: boolean;
  marker: string | null;
  bookingId: number;
  nowMs: number;
  lostSinceMs: number | null;
  heartbeatMs: number | null;
  a2sPlayers: number | null;
  goneMs: number;
}

export function classifyBox(s: BoxSignals): BoxVerdict {
  if (s.rconOk) {
    // No such cvar: an l4d_booking older than 1.4.0. Setup refuses that
    // plugin, so this only covers a box downgraded under a running booking:
    // never mistake it for a restart every minute.
    if (s.marker === null || s.marker === String(s.bookingId)) return { kind: 'ok' };
    return { kind: 'restarted' };
  }
  const since = s.lostSinceMs ?? s.nowMs;
  if (s.nowMs - since < s.goneMs) return { kind: 'quiet' };
  if (s.heartbeatMs !== null && s.nowMs - s.heartbeatMs < s.goneMs) return { kind: 'quiet' };
  if (s.a2sPlayers !== null) return { kind: 'up_no_rcon', players: s.a2sPlayers };
  return { kind: 'gone' };
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `npx vitest run tests/bookingRecovery.test.ts -t classifyBox`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bookings/recovery.ts tests/bookingRecovery.test.ts
git commit -m "Bookings: decide from rcon, the boot marker, the heartbeat and A2S whether a booked box restarted or is gone"
```

---

### Task 3: A2S_INFO query

**Files:**
- Create: `src/a2s.ts`
- Test: `tests/a2s.test.ts`

**Interfaces:**
- Produces: `export async function a2sInfo(host: string, port: number, timeoutMs = 2_000): Promise<{ players: number; map: string } | null>`. Never throws; null on timeout, socket error or a reply it cannot read. `export type A2sFn = typeof a2sInfo;`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import dgram from 'node:dgram';
import { a2sInfo } from '../src/a2s.js';

const HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);
let sock: dgram.Socket | null = null;
afterEach(() => { sock?.close(); sock = null; });

/** A fake srcds: answers A2S_INFO, first with a challenge when `challenge` is set. */
function fake(o: { challenge?: boolean; silent?: boolean; players?: number; map?: string }): Promise<number> {
  return new Promise((resolve) => {
    sock = dgram.createSocket('udp4');
    sock.on('message', (msg, r) => {
      if (o.silent) return;
      const hasChallenge = msg.length >= 4 + 1 + 20 + 4;
      if (o.challenge && !hasChallenge) {
        sock!.send(Buffer.concat([HEADER, Buffer.from([0x41, 1, 2, 3, 4])]), r.port, r.address);
        return;
      }
      if (o.challenge) expect([...msg.subarray(msg.length - 4)]).toEqual([1, 2, 3, 4]);
      const str = (s: string) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
      const body = Buffer.concat([
        HEADER, Buffer.from([0x49, 17]), str('Riverside #3'), str(o.map ?? 'l4d_vs_hospital02_subway'), str('left4dead'), str('L4D'),
        Buffer.from([0xf4, 0x01]), // app id 500 (L4D1), little endian; unused
        Buffer.from([o.players ?? 0, 18, 0]),
      ]);
      sock!.send(body, r.port, r.address);
    });
    sock.bind(0, '127.0.0.1', () => resolve((sock!.address() as { port: number }).port));
  });
}

describe('a2sInfo', () => {
  it('reads players and map from a direct answer', async () => {
    const port = await fake({ players: 7 });
    expect(await a2sInfo('127.0.0.1', port)).toEqual({ players: 7, map: 'l4d_vs_hospital02_subway' });
  });
  it('answers a challenge and then reads the answer', async () => {
    const port = await fake({ challenge: true, players: 3 });
    expect(await a2sInfo('127.0.0.1', port)).toEqual({ players: 3, map: 'l4d_vs_hospital02_subway' });
  });
  it('gives null on silence, within the timeout', async () => {
    const port = await fake({ silent: true });
    const t = Date.now();
    expect(await a2sInfo('127.0.0.1', port, 300)).toBeNull();
    expect(Date.now() - t).toBeLessThan(1_000);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/a2s.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/a2s.ts`**

```ts
import dgram from 'node:dgram';

/**
 * One A2S_INFO query (Valve server query protocol), for crash recovery
 * (plan 5): a second way to ask "is that box there", on a UDP path separate
 * from rcon. Since 2020 servers may answer the first request with
 * S2C_CHALLENGE (0x41) and want it repeated with the 4 challenge bytes
 * appended. Never throws. Note: some hosts never answer A2S (NFO's Chicago
 * box did not), and to the recovery that looks exactly like a box that is gone.
 */
const HEADER = [0xff, 0xff, 0xff, 0xff];
const REQUEST = Buffer.from([...HEADER, 0x54, ...Buffer.from('Source Engine Query\0', 'latin1')]);

export type A2sFn = (host: string, port: number, timeoutMs?: number) => Promise<{ players: number; map: string } | null>;

export function a2sInfo(host: string, port: number, timeoutMs = 2_000): Promise<{ players: number; map: string } | null> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (v: { players: number; map: string } | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* already closed */ }
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    sock.on('error', () => finish(null));
    sock.on('message', (msg) => {
      if (msg.length < 5 || msg.readInt32LE(0) !== -1) return;
      const kind = msg[4];
      if (kind === 0x41 && msg.length >= 9) {
        sock.send(Buffer.concat([REQUEST, msg.subarray(5, 9)]), port, host);
        return;
      }
      if (kind !== 0x49) return;
      finish(parseInfo(msg));
    });
    sock.send(REQUEST, port, host, (err) => { if (err) finish(null); });
  });
}

/** The players and map of an A2S_INFO answer, or null for a short one. */
function parseInfo(msg: Buffer): { players: number; map: string } | null {
  let at = 6; // header (4), 0x49, protocol (1)
  const str = (): string | null => {
    const end = msg.indexOf(0, at);
    if (end < 0) return null;
    const s = msg.toString('utf8', at, end);
    at = end + 1;
    return s;
  };
  if (str() === null) return null; // name
  const map = str();
  if (map === null || str() === null || str() === null) return null; // folder, game
  at += 2; // app id
  if (at >= msg.length) return null;
  return { players: msg[at], map };
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `npx vitest run tests/a2s.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/a2s.ts tests/a2s.test.ts
git commit -m "A2S_INFO query with challenge handling, for telling a dead booked box from a quiet rcon"
```

---

### Task 4: The restore snapshot

**Files:**
- Create: `src/bookings/restore.ts`
- Test: `tests/bookingRestore.test.ts`

**Interfaces:**
- Consumes: `campaignRegistry(db).get(slug).maps` (`src/campaignRegistry.ts`), the tables `match_rounds`, `match_live_maps`, `match_live`, `match_players`, `match_live_events`.
- Produces:

```ts
export interface RestoreSnapshot {
  matchId: number; token: string; campaign: string;
  /** The game's first map: the plugin's g_sCampaign for the SameCampaign check. */
  firstMap: string;
  /** Finished maps in order, with each team's score. */
  maps: { map: string; a: number; b: number }[];
  /** The map to load: the one the game was on, replayed from its start (ruling 1). */
  map: string;
  /** Which match team survives first on `map`: the higher total, a tie keeps the previous map's half-1 order, and team a on map 1. */
  firstSurv: 'a' | 'b';
  roster: { steamid: string; team: 'a' | 'b'; joinedMap: number }[];
  /** One above the highest event seq the site holds for this game. */
  nextSeq: number;
}
export function restoreSnapshot(db: DB, matchId: number): RestoreSnapshot | null;
/** The plugin lines that resume it (pug-match 0.3.19, Task 5). */
export function resumeLines(s: RestoreSnapshot): string[];
/** Delete the interrupted map's partial rows and stamp restored_at_map. */
export function prepareRestore(db: DB, s: RestoreSnapshot): void;
```

Rules for `restoreSnapshot`:
- Null when the match is not `live`, has no token, or its campaign is unknown.
- A map is finished when `match_rounds` has its half 2 row with `ended_at` set. Its score is the sum of `score` over that ordinal's rows, credited to `surv_team`. Only the longest run of finished ordinals from 0 counts.
- Map names: `match_live_maps.map` at that ordinal; otherwise the campaign's `maps` from the index of the first map. The first map is `match_live_maps` ordinal 0, else `match_live.current_map` when nothing is finished, else the campaign's first map.
- `map` = `match_live.current_map` when it is in the campaign and not one of the finished maps; otherwise the campaign map right after the last finished one.
- Null when `map` is past the campaign's end. The game finished its last map, and the collection path owns it.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { currentSeasonId } from '../src/players.js';
import { prepareRestore, restoreSnapshot, resumeLines } from '../src/bookings/restore.js';

let db: DB;
let m: number;
const A = ['76561199000000001', '76561199000000002'];
const B = ['76561199000000003', '76561199000000004'];

const round = (ordinal: number, half: number, surv: 'a' | 'b', score: number, ended = true) =>
  db.prepare('INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, ended_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(m, ordinal, half, surv, score, ended ? '2026-10-02 20:30:00' : null);

beforeEach(() => {
  db = openDb(':memory:');
  for (const s of [...A, ...B]) db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, ?, 'active')").run(s, s.slice(-2));
  m = Number(db.prepare("INSERT INTO matches (season_id, state, campaign, token, origin) VALUES (?, 'live', 'no_mercy', 'tok123', 'in_game')")
    .run(currentSeasonId(db)).lastInsertRowid);
  for (const s of A) db.prepare("INSERT INTO match_players (match_id, player_id, team, source) VALUES (?, ?, 'a', 'udp')").run(m, s);
  for (const s of B) db.prepare("INSERT INTO match_players (match_id, player_id, team, source, joined_map) VALUES (?, ?, 'b', 'udp', 1)").run(m, s);
});

describe('restoreSnapshot', () => {
  it('nothing finished: replays the map it was on, team a survives first', () => {
    db.prepare("INSERT INTO match_live (match_id, current_map, last_seen) VALUES (?, 'l4d_vs_hospital01_apartment', '2026-10-02 20:10:00')").run(m);
    round(0, 1, 'a', 300, true);
    const s = restoreSnapshot(db, m)!;
    expect(s).toMatchObject({ maps: [], map: 'l4d_vs_hospital01_apartment', firstMap: 'l4d_vs_hospital01_apartment', firstSurv: 'a', token: 'tok123' });
    expect(s.roster).toContainEqual({ steamid: B[0], team: 'b', joinedMap: 1 });
  });

  it('two maps finished: scores from match_rounds, the leader survives first on map 3', () => {
    round(0, 1, 'a', 400); round(0, 2, 'b', 350);
    round(1, 1, 'a', 200); round(1, 2, 'b', 500);
    db.prepare("INSERT INTO match_live (match_id, current_map, last_seen) VALUES (?, 'l4d_vs_hospital03_sewers', '2026-10-02 21:00:00')").run(m);
    const s = restoreSnapshot(db, m)!;
    expect(s.maps).toEqual([
      { map: 'l4d_vs_hospital01_apartment', a: 400, b: 350 },
      { map: 'l4d_vs_hospital02_subway', a: 200, b: 500 },
    ]);
    expect(s.map).toBe('l4d_vs_hospital03_sewers');
    expect(s.firstSurv).toBe('b'); // b 850 > a 600
  });

  it('a tie keeps the previous map\'s half-1 survivors', () => {
    round(0, 1, 'b', 300); round(0, 2, 'a', 300);
    expect(restoreSnapshot(db, m)!.firstSurv).toBe('b');
  });

  it('nextSeq is one above the highest event the site holds', () => {
    db.prepare("INSERT INTO match_live_events (match_id, seq, kind, actor, value, map_ordinal, half, t_ms) VALUES (?, 41, 'kill', 'x', 0, 0, 1, 0)").run(m);
    expect(restoreSnapshot(db, m)!.nextSeq).toBe(42);
  });

  it('null once every campaign map is finished, and for a match that is not live', () => {
    const maps = ['l4d_vs_hospital01_apartment', 'l4d_vs_hospital02_subway', 'l4d_vs_hospital03_sewers', 'l4d_vs_hospital04_interior', 'l4d_vs_hospital05_rooftop'];
    maps.forEach((_, i) => { round(i, 1, 'a', 1); round(i, 2, 'b', 1); });
    expect(restoreSnapshot(db, m)).toBeNull();
    db.prepare("UPDATE matches SET state = 'aborted' WHERE id = ?").run(m);
    expect(restoreSnapshot(db, m)).toBeNull();
  });
});

describe('resumeLines and prepareRestore', () => {
  it('lines: resume, each finished map, the roster with joined maps', () => {
    round(0, 1, 'a', 400); round(0, 2, 'b', 350); round(1, 1, 'b', 100, true);
    const s = restoreSnapshot(db, m)!;
    expect(resumeLines(s)).toEqual([
      `sm_pug_resume ${m} tok123 l4d_vs_hospital01_apartment a ${s.nextSeq}`,
      'sm_pug_resume_map l4d_vs_hospital01_apartment 400 350',
      `sm_pug_roster ${A[0]}:a:0`, `sm_pug_roster ${A[1]}:a:0`, `sm_pug_roster ${B[0]}:b:1`, `sm_pug_roster ${B[1]}:b:1`,
      'sm_pug_resume_commit',
    ]);
    prepareRestore(db, s);
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_rounds WHERE match_id = ? AND ordinal = 1').get(m)).toEqual({ n: 0 });
    expect(db.prepare('SELECT restored_at_map FROM matches WHERE id = ?').get(m)).toEqual({ restored_at_map: 1 });
  });

  it('refuses a token or map that would break the console line', () => {
    db.prepare("UPDATE matches SET token = 'a b' WHERE id = ?").run(m);
    const s = restoreSnapshot(db, m)!;
    expect(() => resumeLines(s)).toThrow(/unexpected/);
  });
});
```

The resume line's 4th field is `firstSurv`: there is no stop map, because booking games are self-started and decide their own end.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/bookingRestore.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/bookings/restore.ts`**

```ts
import type { DB } from '../db.js';
import { campaignRegistry } from '../campaignRegistry.js';
import { isMapName } from '../campaigns.js';

/**
 * Putting a booking game back after its srcds restarted (plan 5). The plugin
 * lost everything it held in memory, so the site rebuilds the game from its
 * own record: the finished maps from match_rounds (written from the ROUND
 * lines as they happened), the roster from match_players. The map the game
 * was on is replayed from its start (ruling 1); player stats cover only the
 * maps from there on (ruling 2), which restored_at_map records.
 */

export interface RestoreSnapshot {
  matchId: number; token: string; campaign: string; firstMap: string;
  maps: { map: string; a: number; b: number }[];
  map: string; firstSurv: 'a' | 'b';
  roster: { steamid: string; team: 'a' | 'b'; joinedMap: number }[];
  nextSeq: number;
}

export function restoreSnapshot(db: DB, matchId: number): RestoreSnapshot | null {
  const m = db.prepare("SELECT id, campaign, token FROM matches WHERE id = ? AND state = 'live'").get(matchId) as
    { id: number; campaign: string; token: string | null } | undefined;
  if (!m || !m.token) return null;
  const entry = campaignRegistry(db).get(m.campaign);
  if (!entry) return null;

  const rounds = db.prepare('SELECT ordinal, half, surv_team, score, ended_at FROM match_rounds WHERE match_id = ? ORDER BY ordinal, half')
    .all(matchId) as { ordinal: number; half: number; surv_team: 'a' | 'b'; score: number; ended_at: string | null }[];
  const liveMaps = new Map((db.prepare('SELECT ordinal, map FROM match_live_maps WHERE match_id = ?').all(matchId) as { ordinal: number; map: string }[])
    .map((r) => [r.ordinal, r.map] as const));
  const current = (db.prepare('SELECT current_map FROM match_live WHERE match_id = ?').get(matchId) as { current_map: string | null } | undefined)?.current_map ?? null;

  // Finished ordinals: a contiguous run from 0, each with an ended half 2.
  const done: { a: number; b: number; half1Surv: 'a' | 'b' | null }[] = [];
  for (let o = 0; ; o++) {
    const rows = rounds.filter((r) => r.ordinal === o);
    if (!rows.some((r) => r.half === 2 && r.ended_at !== null)) break;
    const a = rows.filter((r) => r.surv_team === 'a').reduce((n, r) => n + r.score, 0);
    const b = rows.filter((r) => r.surv_team === 'b').reduce((n, r) => n + r.score, 0);
    done.push({ a, b, half1Surv: rows.find((r) => r.half === 1)?.surv_team ?? null });
  }

  const inCampaign = (map: string | null | undefined): map is string => !!map && entry.maps.includes(map);
  const firstMap = inCampaign(liveMaps.get(0)) ? liveMaps.get(0)!
    : done.length === 0 && inCampaign(current) ? current : entry.maps[0];
  const start = entry.maps.indexOf(firstMap);
  const maps = done.map((d, i) => ({ map: inCampaign(liveMaps.get(i)) ? liveMaps.get(i)! : entry.maps[start + i], a: d.a, b: d.b }));
  const finished = new Set(maps.map((x) => x.map));
  const map = inCampaign(current) && !finished.has(current) ? current : entry.maps[start + done.length];
  if (!map) return null;

  const totA = maps.reduce((n, x) => n + x.a, 0);
  const totB = maps.reduce((n, x) => n + x.b, 0);
  const prev = done.at(-1)?.half1Surv ?? null;
  // L4D1 (verified on 906 of 910 map starts): the higher total survives
  // first; a tie keeps the previous map's order; map 1 is team a.
  const firstSurv: 'a' | 'b' = totA > totB ? 'a' : totB > totA ? 'b' : prev ?? 'a';

  const roster = (db.prepare('SELECT player_id, team, joined_map FROM match_players WHERE match_id = ? ORDER BY team, player_id').all(matchId) as
    { player_id: string; team: 'a' | 'b'; joined_map: number }[]).map((r) => ({ steamid: r.player_id, team: r.team, joinedMap: r.joined_map }));
  const maxSeq = (db.prepare('SELECT MAX(seq) AS s FROM match_live_events WHERE match_id = ?').get(matchId) as { s: number | null }).s ?? 0;

  return { matchId, token: m.token, campaign: m.campaign, firstMap, maps, map, firstSurv, roster, nextSeq: maxSeq + 1 };
}

export function resumeLines(s: RestoreSnapshot): string[] {
  if (!/^[A-Za-z0-9]+$/.test(s.token)) throw new Error('restore token has unexpected characters');
  for (const x of [s.firstMap, s.map, ...s.maps.map((y) => y.map)]) if (!isMapName(x)) throw new Error(`restore map ${JSON.stringify(x)} has unexpected characters`);
  return [
    `sm_pug_resume ${s.matchId} ${s.token} ${s.firstMap} ${s.firstSurv} ${s.nextSeq}`,
    ...s.maps.map((x) => `sm_pug_resume_map ${x.map} ${Math.trunc(x.a)} ${Math.trunc(x.b)}`),
    ...s.roster.filter((r) => /^\d{17}$/.test(r.steamid)).map((r) => `sm_pug_roster ${r.steamid}:${r.team}:${r.joinedMap}`),
    'sm_pug_resume_commit',
  ];
}

export function prepareRestore(db: DB, s: RestoreSnapshot): void {
  db.transaction(() => {
    db.prepare('DELETE FROM match_rounds WHERE match_id = ? AND ordinal >= ?').run(s.matchId, s.maps.length);
    db.prepare('DELETE FROM match_live_maps WHERE match_id = ? AND ordinal >= ?').run(s.matchId, s.maps.length);
    // The first restore decides: stats cover from there on, even after a second one.
    db.prepare('UPDATE matches SET restored_at_map = COALESCE(restored_at_map, ?) WHERE id = ?').run(s.maps.length, s.matchId);
  })();
}
```

If `match_live_events` uses different column names than the test's insert, read `src/db.ts` around line 524 and fix the test insert, not the query.

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run tests/bookingRestore.test.ts`
Expected: PASS. If a stock map name differs from the test's list, take the real names from `campaignRegistry(db).get('no_mercy')!.maps` and fix the test.

- [ ] **Step 5: Commit**

```bash
git add src/bookings/restore.ts tests/bookingRestore.test.ts
git commit -m "Bookings: rebuild a restarted booking game from the site's own rounds and roster (finished maps, map to replay, who survives first)"
```

---

### Task 5: Plugins: pug-match 0.3.19 resume, l4d_booking 1.4.0 boot marker, l4dscores seed

**Files:**
- Modify: `plugin/pug-match.sp` (`PLUGIN_VERSION` line 26, globals near line 165, `OnPluginStart` command registration near line 433, `Cmd_Roster` near line 2036, `ResetMatchState` near line 2911, `SeedNewMapSides` near line 3189, the Pending to Live block near line 3643)
- Modify: `plugin/l4d_booking.sp` (`PLUGIN_VERSION` line 66, cvars near line 108)
- Modify: `/home/volence/l4d/deploy/plugins-src/l4dscores.sp` (`SCORE_VERSION` line 6, command registration near line 183)
- Modify: `src/bookings/runner.ts` (`CLEAR_LINES`)

**Interfaces:**
- Produces (the console contract Task 7 relies on):
  - `sm_pug_resume <matchid> <token> <firstmap> <a|b> <nextseq>` → `PUGOK resume=<matchid>`, or a `PUGERR ...` line. It resets the match state, then sets Pending, `g_bSelfStarted = true` and `g_bResumed = true`, the first survivor team, and `g_iEventSeq = nextseq - 1`.
  - `sm_pug_resume_map <map> <a> <b>` → `PUGOK resume_map=<count>`, only while resumed and Pending.
  - `sm_pug_roster <steamid64>:<a|b>[:<joinedmap>]`: the optional joined map is new.
  - `sm_pug_resume_commit` → `PUGOK resumed maps=<n> roster=<n>`, or `PUGERR` when nothing is rostered. It sets `g_iRplMapSeq = g_iMapCount` and arms the side seed for the next `OnMapStart`.
  - At go-live of a resumed match, pug-match runs `sm_l4dscores_seed <survivorsTotal> <infectedTotal> <mapCounter>`, with the totals of the pug team actually on survivors and on infected.
  - `l4d_booking_id` (l4d_booking 1.4.0): a string cvar, default `""`.
  - `sm_l4dscores_seed <surv> <inf> <mapcounter>` (l4dscores 8.5.9-riverside3): a server command that sets `campaignScores` for the current survivor and infected logical teams, plus `mapCounter`.

- [ ] **Step 1: pug-match globals and reset**

Bump `#define PLUGIN_VERSION "0.3.19"`. Next to `bool g_bSelfStarted;` add:

```sourcepawn
// Crash recovery (site plan 5): a match the backend rebuilt after srcds
// restarted. g_iResumeFirst is the pug team (1 = a, 2 = b) that survives
// first on the replayed map, applied once by SeedNewMapSides at the next map
// start and then cleared.
bool g_bResumed;
int g_iResumeFirst;
```

In `ResetMatchState()`, next to `g_bSelfStarted = false;`:

```sourcepawn
	g_bResumed = false;
	g_iResumeFirst = 0;
```

- [ ] **Step 2: the three commands**

Register them in `OnPluginStart` next to `sm_pug_setid`:

```sourcepawn
	RegServerCmd("sm_pug_resume", Cmd_Resume, "sm_pug_resume <matchid> <token> <firstmap> <a|b> <nextseq> - rebuild a match after a server restart");
	RegServerCmd("sm_pug_resume_map", Cmd_ResumeMap, "sm_pug_resume_map <map> <a> <b> - a map the resumed match already finished");
	RegServerCmd("sm_pug_resume_commit", Cmd_ResumeCommit, "sm_pug_resume_commit - the resumed match is complete; seed sides at the next map start");
```

Add after `Cmd_Roster`:

```sourcepawn
/** Crash recovery (site plan 5). The backend rebuilds a booking game that
 *  srcds lost: same match id and token, the finished maps with their scores,
 *  the roster, and the next event seq. The match is self-started (it was
 *  adopted by auto-track), so the booking's password and the team-lock rules
 *  stay exactly as they were. The map it was on is replayed from its start. */
public Action Cmd_Resume(int args)
{
	if (args < 5)
	{
		PrintToServer("PUGERR usage: sm_pug_resume <matchid> <token> <firstmap> <a|b> <nextseq>");
		return Plugin_Handled;
	}
	char buf[65];
	GetCmdArg(1, buf, sizeof(buf));
	int matchId = StringToInt(buf);
	GetCmdArg(4, buf, sizeof(buf));
	int first = StrEqual(buf, "a") ? 1 : StrEqual(buf, "b") ? 2 : 0;
	if (matchId <= 0 || first == 0)
	{
		PrintToServer("PUGERR bad resume args");
		return Plugin_Handled;
	}
	CancelEndKick();
	CancelTeardown();
	ResetMatchState();
	g_iMatchId = matchId;
	GetCmdArg(2, g_sToken, sizeof(g_sToken));
	GetCmdArg(3, g_sCampaign, sizeof(g_sCampaign));
	GetCmdArg(5, buf, sizeof(buf));
	g_iEventSeq = StringToInt(buf) - 1;
	if (g_iEventSeq < 0) g_iEventSeq = 0;
	g_bSelfStarted = true;
	g_bResumed = true;
	g_iResumeFirst = first;
	g_State = MS_Pending;
	PrintToServer("PUGOK resume=%d", g_iMatchId);
	return Plugin_Handled;
}

public Action Cmd_ResumeMap(int args)
{
	if (!g_bResumed || g_State != MS_Pending || args < 3)
	{
		PrintToServer("PUGERR no resume in progress");
		return Plugin_Handled;
	}
	if (g_iMapCount >= MAX_MAPS)
	{
		PrintToServer("PUGERR too many maps");
		return Plugin_Handled;
	}
	char buf[64];
	GetCmdArg(1, g_sMapName[g_iMapCount], 64);
	GetCmdArg(2, buf, sizeof(buf));
	g_iMapScoreA[g_iMapCount] = StringToInt(buf);
	GetCmdArg(3, buf, sizeof(buf));
	g_iMapScoreB[g_iMapCount] = StringToInt(buf);
	g_iMapCount++;
	PrintToServer("PUGOK resume_map=%d", g_iMapCount);
	return Plugin_Handled;
}

public Action Cmd_ResumeCommit(int args)
{
	if (!g_bResumed || g_State != MS_Pending || g_iRosterCount == 0)
	{
		PrintToServer("PUGERR resume incomplete");
		return Plugin_Handled;
	}
	// Replay files of the replayed map keep its ordinal (pug_<token>_<n>_<half>.rpl).
	g_iRplMapSeq = g_iMapCount;
	LogMessage("[pug] match %d resumed after a server restart: %d maps finished, %d rostered, pug team %s survives first",
		g_iMatchId, g_iMapCount, g_iRosterCount, g_iResumeFirst == 1 ? "a" : "b");
	PrintToServer("PUGOK resumed maps=%d roster=%d", g_iMapCount, g_iRosterCount);
	return Plugin_Handled;
}
```

- [ ] **Step 3: roster joined map**

In `Cmd_Roster`, the arg buffer is `char arg[48]` and the team letter is `arg[sep + 1]`. After `g_iRosterTeam[g_iRosterCount] = team;` add:

```sourcepawn
	// Optional ":<joinedmap>" (site plan 5, resume): the map ordinal this
	// player was rostered on in the match before the restart.
	if (arg[sep + 2] == ':') g_iRosterJoinedMap[g_iRosterCount] = StringToInt(arg[sep + 3]);
```

Check that the `strlen` guard above still accepts `id:a:2` (it only checks that `sep` is not the last character), and that `arg` is wide enough: 17 + 1 + 1 + 1 + 2 = 22 < 48.

- [ ] **Step 4: seed the replayed map's sides, and l4dscores at go-live**

In `SeedNewMapSides`, right after `g_iNextFirstL4ds = 0;` and before the `if (g_State != MS_Live ...) return;`:

```sourcepawn
	// A resumed match (site plan 5): the backend says who survives first on
	// the replayed map, from its own totals. Once, at the first map start.
	if (g_bResumed && g_State == MS_Pending && g_iResumeFirst != 0)
	{
		g_iPugSide[g_iResumeFirst] = TEAM_SURVIVOR;
		g_iPugSide[3 - g_iResumeFirst] = TEAM_INFECTED;
		g_bSeedHold = true;
		for (int c = 1; c <= MaxClients; c++) g_iLockAttempts[c] = 0;
		LogMessage("[pug] map %s: resumed match, pug team %s survives first", g_sCurrentMap, g_iResumeFirst == 1 ? "a" : "b");
		g_iResumeFirst = 0;
		return;
	}
```

In the go-live block (`if (g_State == MS_Pending) { g_State = MS_Live; SampleSkillDetect(); EmitPug("MATCH_START ...` near line 3643), after the `EmitPug` line add:

```sourcepawn
		if (g_bResumed) SeedL4dscoresTally();
```

Add the helper next to `TotalScores`:

```sourcepawn
/** A resumed match goes live on a fresh srcds whose l4dscores tally is 0-0,
 *  and that tally decides who survives first on the next map. Seed it with
 *  the real totals of whichever pug team is on survivors right now (counted
 *  from the rostered players actually standing there). l4dscores 8.5.9-
 *  riverside3 has the command; an older one ignores it, logged. */
void SeedL4dscoresTally()
{
	int onSurv[3];
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c) || GetClientTeam(c) != TEAM_SURVIVOR) continue;
		int r = g_iClientRoster[c];
		if (r >= 0) onSurv[g_iRosterTeam[r]]++;
	}
	int survPug = (onSurv[2] > onSurv[1]) ? 2 : 1;
	int a, b;
	TotalScores(a, b);
	int surv = (survPug == 1) ? a : b;
	int inf = (survPug == 1) ? b : a;
	ServerCommand("sm_l4dscores_seed %d %d %d", surv, inf, g_iMapCount + 1);
	LogMessage("[pug] resumed match %d live: l4dscores seeded survivors=%d infected=%d (pug team %s on survivors)", g_iMatchId, surv, inf, survPug == 1 ? "a" : "b");
}
```

`TEAM_SURVIVOR` is the constant `g_iPugSide` already uses. If the file names it differently, use that name.

- [ ] **Step 5: l4d_booking 1.4.0**

Bump `#define PLUGIN_VERSION "1.4.0"`. After the `l4d_booking_block` cvar add:

```sourcepawn
	// Crash recovery (site plan 5): the booking id, written only by the
	// site's setup and recovery, never by its minute re-push. A fresh srcds
	// starts with it empty, which is how the site tells a restart.
	CreateConVar("l4d_booking_id", "", "The booking this box was set up for; empty after a server start.", FCVAR_DONTRECORD);
```

In `src/bookings/runner.ts`, add `'l4d_booking_id ""'` as the first element of `CLEAR_LINES`.

- [ ] **Step 6: l4dscores 8.5.9-riverside3 (deploy repo)**

In `/home/volence/l4d/deploy/plugins-src/l4dscores.sp`, set `#define SCORE_VERSION "8.5.9-riverside3"`. After the `sm_setscores` registration add:

```sourcepawn
	// riverside3: the site's crash recovery seeds the tally of a match that
	// pug-match resumed on a fresh srcds (pug-match 0.3.19). Server only.
	RegServerCmd("sm_l4dscores_seed", Command_SeedScores, "sm_l4dscores_seed <survivors> <infected> <mapcounter>");
```

And the handler, next to `Command_SetCampaignScores`:

```sourcepawn
public Action:Command_SeedScores(args)
{
	if (args < 3)
	{
		PrintToServer("[l4dscores] usage: sm_l4dscores_seed <survivors> <infected> <mapcounter>");
		return Plugin_Handled;
	}
	new String:arg[16];
	GetCmdArg(1, arg, sizeof(arg));
	new surv = StringToInt(arg);
	GetCmdArg(2, arg, sizeof(arg));
	new inf = StringToInt(arg);
	GetCmdArg(3, arg, sizeof(arg));
	new counter = StringToInt(arg);
	if (surv < 0 || inf < 0 || counter < 1)
	{
		PrintToServer("[l4dscores] seed refused: bad values");
		return Plugin_Handled;
	}
	mapCounter = counter;
	ClearArray(mapScores);
	campaignScores[CurrentToLogicalTeam(L4D_TEAM_SURVIVORS)] = surv;
	campaignScores[CurrentToLogicalTeam(L4D_TEAM_INFECTED)] = inf;
	LogMessage("[l4dscores] seeded: survivors=%d infected=%d mapCounter=%d", surv, inf, counter);
	return Plugin_Handled;
}
```

The admin `!setscores` path sets `mapCounter = 1`. Whether `mapCounter` should be the replayed map's number is one of the things Task 10 checks in game. Keep the argument either way.

- [ ] **Step 7: Build all three**

Run:
```bash
cd /home/volence/l4d/pug/plugin && ./build.sh && ./build-booking.sh
```
Expected: both print `built: ...` with no errors.

For l4dscores, use the deploy repo's build path. Find it with `grep -rn "l4dscores" /home/volence/l4d/deploy/tools/*.sh /home/volence/l4d/deploy/*.sh | head`. If there is no script, compile it the way `build-booking.sh` does (copy into `$SCRIPTING`, `wine ./spcomp.exe l4dscores.sp -o l4dscores.smx -iinclude`, move the .smx next to the source's usual overlay path that `git -C /home/volence/l4d/deploy log --stat -1 -- '*l4dscores*'` shows).
Expected: a clean compile.

- [ ] **Step 8: Run the site suite parts that touch CLEAR_LINES**

Run: `npx vitest run tests/bookingRunner.test.ts`
Expected: PASS. If a test pins `CLEAR_LINES` exactly, update it to include `'l4d_booking_id ""'` first.

- [ ] **Step 9: Commit (two repos)**

```bash
cd /home/volence/l4d/pug && git add plugin/pug-match.sp plugin/l4d_booking.sp src/bookings/runner.ts tests/bookingRunner.test.ts
git commit -m "pug-match 0.3.19: sm_pug_resume rebuilds a booking game after a server restart; l4d_booking 1.4.0: l4d_booking_id boot marker"
cd /home/volence/l4d/deploy && git add plugins-src/l4dscores.sp && git commit -m "l4dscores 8.5.9-riverside3: sm_l4dscores_seed for a match pug-match resumed after a server restart"
```

(Commit the built .smx files only where those repos already track built plugins. Check `git -C <repo> ls-files '*.smx'`.)

---

### Task 6: The boot marker in setup, and the recovery notice

**Files:**
- Modify: `src/bookings/runner.ts` (`setupOnce`)
- Modify: `src/bookings/messages.ts`, `src/notify/notify.ts`
- Test: `tests/bookingRecovery.test.ts`

**Interfaces:**
- Produces:
  - `markerLine(id: number): string`, exported from runner.ts, returns `l4d_booking_id "<id>"`.
  - Setup pushes it and refuses a box where the cvar does not exist ("the l4d_booking plugin on this box is older than 1.4.0").
  - `NotifyType` and `BookingNotifyType` gain `'booking_recovered'`. `bookingMessage(..., 'booking_recovered', { moved?: boolean; restored?: string | null })`: `restored` is an optional line such as "your game is back on map 3, A 812 - B 640".

- [ ] **Step 1: Extend the fake box and write the failing tests**

In the fixture's `fakeRcon` add to the box record `marker: string` (initial `''`) and `bookingPlugin: '1.4.0'`. Answer:

```ts
    if (c === 'l4d_booking_id') return b.bookingPlugin >= '1.4.0' ? `"l4d_booking_id" = "${b.marker}" ( def. "" )` : 'Unknown command "l4d_booking_id"';
    const mk = /^l4d_booking_id "(\d*)"$/.exec(c);
    if (mk) b.marker = mk[1];
```

The `restart` fake sets `box[server.name].marker = ''` (a restart empties it). Then:

```ts
describe('boot marker', () => {
  it('setup writes the booking id marker', async () => {
    const id = await running();
    expect(box.ccc.marker).toBe(String(id));
  });
  it('setup refuses a box whose l4d_booking has no marker cvar', async () => {
    for (const n of ['a', 'bb', 'ccc']) box[n].bookingPlugin = '1.3.0';
    const id = book();
    now = START - 15 * MIN;
    runner.allocate();
    await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ state: 'cancelled', end_reason: 'setup_failed' });
  });
});

describe('booking_recovered message', () => {
  it('names the connect line, says a move, and carries the restored line', async () => {
    const id = await running();
    const b = getBooking(db, id)!;
    const same = bookingMessage(db, 'https://x', id, 'booking_recovered', { restored: 'your game is back on map 3, p0 812 - p1 640' })!;
    expect(same.content).toContain('restarted');
    expect(same.content).toContain(`password ${b.password}`);
    expect(same.content).toContain('your game is back on map 3');
    const moved = bookingMessage(db, 'https://x', id, 'booking_recovered', { moved: true })!;
    expect(moved.content).toContain('moved to another server');
  });
});
```

(Import `bookingMessage` from `../src/bookings/messages.js`.)

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/bookingRecovery.test.ts -t "boot marker|booking_recovered"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In runner.ts, export:

```ts
/** The boot marker (plan 5): written by setup and recovery only, never by the
 *  minute re-push, so an empty one means srcds started since. */
export const markerLine = (id: number): string => `l4d_booking_id "${id}"`;
```

In `setupOnce`, after the `l4d_booking_version` check, add a marker check, and push the marker with the lines:

```ts
    const [hasMarker] = await this.deps.rcon(server, ['l4d_booking_id']);
    if (cvarValue(hasMarker, 'l4d_booking_id') === null) throw new Error('the l4d_booking plugin on this box is older than 1.4.0 (no l4d_booking_id)');
```

and change `await this.deps.rcon(server, lines);` to `await this.deps.rcon(server, [...lines, markerLine(b.id)]);`.

In `src/notify/notify.ts`, add `| 'booking_recovered'` to the booking line of `NotifyType`, and add this entry to `NOTIFY_TYPES` after `booking_ready`:

```ts
  { type: 'booking_recovered', label: 'My booked server restarted or moved, with the new connect line' },
```

In `messages.ts`, add `'booking_recovered'` to `BookingNotifyType`, widen `extra` with `moved?: boolean; restored?: string | null`, and add the case:

```ts
    case 'booking_recovered': {
      const s = b.server_id !== null ? getServer(db, b.server_id) : undefined;
      const head = extra.moved
        ? `The server for ${vs} went down, so the booking moved to another server.`
        : `The server for ${vs} restarted and is set up again.`;
      const game = extra.restored ? ` ${escapeName(extra.restored)}.` : '';
      content = s ? `${head}${game} Reconnect in the game console:\n\`connect ${s.host}:${s.port}; password ${b.password}\`` : `${head}${game}`;
      break;
    }
```

- [ ] **Step 4: Run them and see them pass, plus the existing runner and notify tests**

Run: `npx vitest run tests/bookingRecovery.test.ts tests/bookingRunner.test.ts tests/notify.test.ts`
Expected: PASS. The bookingRunner fixture's fake must also answer `l4d_booking_id` the same way, so copy the two fake lines and the `marker` field into it. If `tests/notify.test.ts` does not exist, run `npx vitest run -t notify`.

- [ ] **Step 5: Commit**

```bash
git add src/bookings/runner.ts src/bookings/messages.ts src/notify/notify.ts tests/bookingRecovery.test.ts tests/bookingRunner.test.ts
git commit -m "Bookings: setup writes the l4d_booking_id boot marker and refuses a plugin without it; booking_recovered notice"
```

---

### Task 7: Same-box recovery after an srcds restart

**Files:**
- Modify: `src/bookings/runner.ts` (`watch`, `resume`, new `recover`)
- Test: `tests/bookingRecovery.test.ts`

**Interfaces:**
- Consumes: `classifyBox` (Task 2), `restoreSnapshot` / `resumeLines` / `prepareRestore` (Task 4), `beginRecovery` / `finishRecovery` / `noteLost` / `noteAlive` (Task 1), `markerLine` (Task 6), and the plugin contract (Task 5).
- Produces:
  - `BookingRunnerDeps.a2s?: A2sFn`: absent in tests that do not need it, so it is treated as never answering.
  - Private `recover(id: number): Promise<void>`, tracked like setup.
  - `watch` asks for the marker in the same burst as `status` and branches before the minute re-push.
  - Admin events: `Booking N: <box> restarted; setting it up again` and `Booking N: restored on <box> (game #M back on <map>, A x - B y)`.
  - In-game line after a restored game: `[Booking] Restored after a server restart: <campaign> map <n>, <sideA> <x> - <sideB> <y>. <side> survive first. Ready up when everyone is back.`

`recover(id)`, step by step:
1. `b = getBooking`. Stop if it is not recovering, it is ending, or it has no box.
2. `waitForStartup(rcon, server, sleep)`, then `execVerified(server, b)`, then check `l4d_booking_version` and the marker cvar exists (as setupOnce does).
3. `live = liveBookingGame(db, id)`. If there is one, `snap = restoreSnapshot(db, live.id)`.
4. One burst: `['sm_pug_auto_track 0', ...(snap ? resumeLines(snap) : []), ...bookingLines, ...gameLines(withSecret), markerLine(id)]`. The `sm_pug_resume_commit` reply is the last `resumeLines` element's reply. If it does not start with `PUGOK resumed`, or `snap` is null while a game is live: abort that game (ruling 5) with `abortBookingGame`, but with `abort_cause = 'server_lost'` (step 4a below), `forgetToken`, admin event, and carry on without a game.
5. `prepareRestore(db, snap)` when the resume took.
6. The map: `snap.map` if restored. Otherwise `firstMapOf(next_campaign ?? playlist[playlist_pos])`. `changelevel`, sleep `MAP_SETTLE_MS`, then `status` must show that map. Failure throws.
7. `finishRecovery(db, id, now)`. Reset `emptyWatches` and `announced` for the id. Say the restore line if restored. `tell(everyone, 'booking_recovered', { restored })`. Admin event.
8. On a throw: if attempts < `SETUP_TRIES` (an in-memory count per booking), try again from step 2. Otherwise close with `closeBooking(db, id, 'cancelled', 'server_lost', now)`, tell everyone `booking_cancelled` with the reason "the server went down and could not be set up again", send an admin problem event, then `windDown(id, false)` (no goodbye: the box is broken).

Step 4a: add an optional `cause` parameter to `abortBookingGame(db, matchId, now, cause = 'booking_ended')` in `src/bookings/games.ts`, and pass `'server_lost'` here.

- [ ] **Step 1: Write the failing tests**

Extend the fake: `sm_pug_resume*` lines are recorded in `sent` and answered `PUGOK resume=..`, `PUGOK resume_map=..`, `PUGOK resumed maps=0 roster=N` (or `Unknown command` when `b.pugMatch < '0.3.19'`, a new box field defaulting to `'0.3.19'`). Then:

```ts
/** Box ccc restarts under booking `id`: empty marker, Pub, the default map. */
const crash = (name = 'ccc') => { box[name].marker = ''; box[name].type = PUB; box[name].map = 'l4d_vs_hospital01_apartment'; box[name].humans = []; };

/** A live booking game on ccc with map 1 finished and map 2 under way. */
function liveGame(id: number): number {
  const m = Number(db.prepare(
    "INSERT INTO matches (season_id, state, campaign, server_id, token, origin, kind, visibility, booking_id, booking_side_a) VALUES (?, 'live', 'no_mercy', 3, 'tok123', 'in_game', 'scrim', 'participants', ?, 'a')",
  ).run(currentSeasonId(db), id).lastInsertRowid);
  db.prepare("INSERT INTO match_players (match_id, player_id, team, source) VALUES (?, ?, 'a', 'udp'), (?, ?, 'b', 'udp')").run(m, P[0], m, P[1]);
  db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, ended_at) VALUES (?, 0, 1, 'a', 400, 'x'), (?, 0, 2, 'b', 300, 'x'), (?, 1, 1, 'b', 50, NULL)").run(m, m, m);
  db.prepare("INSERT INTO match_live (match_id, current_map, last_seen) VALUES (?, 'l4d_vs_hospital02_subway', datetime('now'))").run(m);
  return m;
}

describe('srcds restarted', () => {
  it('sets the booking up again on the same box and resumes the live game on the map it was on', async () => {
    const id = await running();
    const m = liveGame(id);
    crash();
    await runner.tick();
    await runner.idle();
    const cmds = sent.filter((s) => s.server === 'ccc').flatMap((s) => s.cmds);
    const resume = cmds.indexOf(`sm_pug_resume ${m} tok123 l4d_vs_hospital01_apartment a ${1}`);
    expect(cmds.indexOf('sm_pug_auto_track 0')).toBeLessThan(resume);
    expect(cmds).toContain('sm_pug_resume_map l4d_vs_hospital01_apartment 400 300');
    expect(cmds).toContain('changelevel l4d_vs_hospital02_subway');
    expect(box.ccc.marker).toBe(String(id));
    expect(getBooking(db, id)).toMatchObject({ recovering_at: null, recoveries: 1, server_id: 3 });
    expect(db.prepare('SELECT state, restored_at_map FROM matches WHERE id = ?').get(m)).toEqual({ state: 'live', restored_at_map: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_rounds WHERE match_id = ? AND ordinal = 1').get(m)).toEqual({ n: 0 });
    expect(dms.some((d) => d.content.includes('restarted'))).toBe(true);
    expect(cmds.some((c) => c.startsWith('say [Booking] Restored after a server restart'))).toBe(true);
  });

  it('with no live game, sets up again and loads the campaign it was on', async () => {
    const id = await running();
    crash();
    box.ccc.map = 'c1m1_hotel';
    await runner.tick();
    await runner.idle();
    expect(box.ccc.map).toBe('l4d_vs_hospital01_apartment');
    expect(getBooking(db, id)).toMatchObject({ recovering_at: null, recoveries: 1 });
  });

  it('restores the loading campaign when a captain had picked the next one', async () => {
    const id = await running();
    db.prepare("UPDATE bookings SET next_campaign = 'death_toll', next_at = ? WHERE id = ?").run(new Date(now + 10 * MIN).toISOString(), id);
    crash();
    await runner.tick();
    await runner.idle();
    expect(box.ccc.map).toBe('l4d_vs_smalltown01_caves');
  });

  it('an old pug-match: the game is aborted as server_lost and the booking carries on', async () => {
    const id = await running();
    const m = liveGame(id);
    box.ccc.pugMatch = '0.3.18';
    crash();
    await runner.tick();
    await runner.idle();
    expect(db.prepare('SELECT state, abort_cause FROM matches WHERE id = ?').get(m)).toEqual({ state: 'aborted', abort_cause: 'server_lost' });
    expect(getBooking(db, id)).toMatchObject({ state: 'ready', recovering_at: null });
  });

  it('two failed set-ups close the booking as server_lost, not a no-show', async () => {
    const id = await running();
    crash();
    box.ccc.failExec = 99;
    await runner.tick();
    await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ state: 'cancelled', end_reason: 'server_lost' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM booking_sides WHERE booking_id = ? AND no_show_at IS NOT NULL').get(id)).toEqual({ n: 0 });
  });

  it('no idle end right after a restore', async () => {
    const id = await running();
    db.prepare("UPDATE bookings SET last_human_at = ? WHERE id = ?").run(new Date(now - 60 * MIN).toISOString(), id);
    now = START + 40 * MIN;
    crash();
    await runner.tick();
    await runner.idle();
    now += MIN;
    await runner.tick();
    await runner.idle();
    expect(getBooking(db, id)!.ending_at).toBeNull();
  });

  it('resume() restarts a recovery a web restart cut off', async () => {
    const id = await running();
    beginRecovery(db, id, 'restart', new Date(now));
    crash();
    const fresh = build();
    fresh.resume();
    await fresh.idle();
    expect(getBooking(db, id)).toMatchObject({ recovering_at: null, recoveries: 1 });
  });

  it('a box that answers with our marker is left alone', async () => {
    const id = await running();
    await runner.tick();
    await runner.idle();
    expect(getBooking(db, id)!.recovering_at).toBeNull();
    expect(sent.flatMap((s) => s.cmds)).not.toContain('sm_pug_auto_track 0');
  });
});
```

The death_toll first map in the test is `l4d_vs_smalltown01_caves`. Check it with `firstMapOf(db, 'death_toll')` and fix the test if it differs. The test's `match_rounds` insert gives `ended_at` the literal `'x'` only because the snapshot treats any non-null value as ended.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/bookingRecovery.test.ts -t "srcds restarted"`
Expected: FAIL.

- [ ] **Step 3: Implement in runner.ts**

Imports: `classifyBox` from `./recovery.js`; `restoreSnapshot, resumeLines, prepareRestore` from `./restore.js`; `beginRecovery, finishRecovery, noteAlive, noteLost, noteA2s, markUpAlerted, dropBox, reholdBox` from `./bookings.js`; `type A2sFn` from `../a2s.js`; `abortBookingGame` (already imported). Add `a2s?: A2sFn;` to `BookingRunnerDeps`. Add `private readonly recoverTries = new Map<number, number>();`.

In `watch`, replace the status block:

```ts
    let humans: ReturnType<typeof parseStatusPlayers>;
    let marker: string | null = null;
    let rconOk = true;
    try {
      const [st, mk] = await this.deps.rcon(server, ['status', 'l4d_booking_id']);
      humans = parseStatusPlayers(st);
      marker = cvarValue(mk, 'l4d_booking_id');
    } catch (err) {
      rconOk = false;
      humans = [];
      this.emptyWatches.delete(b.id);
      console.warn(`[booking] ${b.id}: status on ${server.name} failed:`, err instanceof Error ? err.message : err);
    }
    if (await this.checkBox(b, server, now, rconOk, marker)) return;
    if (!rconOk) return;
```

Add `checkBox`. It returns true when the watch must stop here (a recovery started, or the box is quiet):

```ts
  /** Plan 5: after the watch's status, is the box still this booking's? */
  private async checkBox(b: BookingRow, server: ServerRow, now: Date, rconOk: boolean, marker: string | null): Promise<boolean> {
    const nowMs = now.getTime();
    if (rconOk) noteAlive(this.db, b.id);
    const lostSince = rconOk ? null : noteLost(this.db, b.id, now);
    const live = liveBookingGame(this.db, b.id);
    const hb = live ? (this.db.prepare('SELECT last_seen FROM match_live WHERE match_id = ?').get(live.id) as { last_seen: string } | undefined) : undefined;
    let a2sPlayers: number | null = null;
    const limits = bookingLimits(this.db);
    if (!rconOk && lostSince !== null && nowMs - Date.parse(lostSince) >= limits.goneMinutes * 60_000) {
      try {
        const r = await this.deps.a2s?.(server.host, server.port);
        if (r) { a2sPlayers = r.players; noteA2s(this.db, b.id, now); }
      } catch { /* treated as no answer */ }
    }
    const v = classifyBox({
      rconOk, marker, bookingId: b.id, nowMs,
      lostSinceMs: lostSince !== null ? Date.parse(lostSince) : null,
      heartbeatMs: hb ? sqlMs(hb.last_seen) : null,
      a2sPlayers, goneMs: limits.goneMinutes * 60_000,
    });
    switch (v.kind) {
      case 'ok': return false;
      case 'quiet': return true;
      case 'up_no_rcon':
        if (markUpAlerted(this.db, b.id, now)) {
          publishAdminEvent({ kind: 'problem', text: `Booking ${b.id}: ${server.name} has not answered rcon for ${limits.goneMinutes}+ minutes but answers the server browser (${v.players} players). Nothing was moved; check the box.` });
        }
        return true;
      case 'restarted':
        if (beginRecovery(this.db, b.id, 'restart', now)) {
          publishAdminEvent({ kind: 'problem', text: `Booking ${b.id}: ${server.name} restarted; setting the booking up again on it.` });
          this.track(b.id, () => this.recover(b.id));
        }
        return true;
      case 'gone':
        this.onGone(b, server, now);
        return true;
    }
  }
```

Leave `onGone` as a one-line stub that only logs until Task 8 (`private onGone(b: BookingRow, server: ServerRow, now: Date): void { console.warn(`[booking] ${b.id}: ${server.name} looks gone (Task 8 moves it)`); }`), so this task compiles and its tests stay focused.

`recover`:

```ts
  /** Plan 5: set a restarted box up again, and put its live game back. */
  private async recover(id: number): Promise<void> {
    for (;;) {
      const b = getBooking(this.db, id);
      if (!b || b.recovering_at === null || b.ending_at !== null || b.server_id === null) return;
      const server = getServer(this.db, b.server_id)!;
      const attempt = (this.recoverTries.get(id) ?? 0) + 1;
      this.recoverTries.set(id, attempt);
      try {
        await this.recoverOnce(b, server);
        this.recoverTries.delete(id);
        return;
      } catch (err) {
        const why = hideAllowIds(redactSecrets(err instanceof Error ? err.message : String(err), [server.log_secret]));
        console.warn(`[booking] ${id}: recovery try ${attempt} on ${server.name} failed: ${why}`);
        if (attempt < SETUP_TRIES) continue;
        this.recoverTries.delete(id);
        this.giveUp(id, `it could not be set up again on ${server.name} (${why})`, 'the server went down and could not be set up again');
        // Already tracked (this is the recovery's own work): wind down inline.
        await this.windDown(id, false);
        return;
      }
    }
  }

  private async recoverOnce(b: BookingRow, server: ServerRow): Promise<void> {
    await waitForStartup(this.deps.rcon, server, this.sleep);
    await this.execVerified(server, b);
    const [version, mk] = await this.deps.rcon(server, ['l4d_booking_version', 'l4d_booking_id']);
    if (cvarValue(version, 'l4d_booking_version') === null) throw new Error('the l4d_booking plugin is not loaded on this box');
    if (cvarValue(mk, 'l4d_booking_id') === null) throw new Error('the l4d_booking plugin on this box is older than 1.4.0 (no l4d_booking_id)');
    const live = liveBookingGame(this.db, b.id);
    const snap = live ? restoreSnapshot(this.db, live.id) : null;
    const resume = snap ? resumeLines(snap) : [];
    const lines = [...bookingLines(this.db, b), ...gameLines(this.db, b, server, this.deps.logPublicAddress), markerLine(b.id)];
    const replies = await this.deps.rcon(server, ['sm_pug_auto_track 0', ...resume, ...lines]);
    const resumed = snap !== null && (replies[resume.length] ?? '').includes('PUGOK resumed');
    if (live && !resumed) {
      // Ruling 5: the game cannot come back; the booking carries on without it.
      const token = abortBookingGame(this.db, live.id, new Date(this.now()), 'server_lost');
      if (token) this.forgetToken(b.id, token);
      publishAdminEvent({ kind: 'problem', matchId: live.id, text: `Booking ${b.id}: game #${live.id} could not be restored on ${server.name} (${snap ? 'pug-match did not take sm_pug_resume; is 0.3.19 staged?' : 'the site has no record of where it was'}). It is aborted; the booking carries on.` });
    }
    if (resumed) prepareRestore(this.db, snap!);
    const fresh = getBooking(this.db, b.id)!;
    const campaign = fresh.next_campaign ?? (JSON.parse(fresh.playlist_json) as string[])[fresh.playlist_pos];
    const map = resumed ? snap!.map : firstMapOf(this.db, campaign);
    if (!isMapName(map)) throw new Error(`${campaign} starts on ${JSON.stringify(map)}, which is not a valid map name`);
    try { await this.deps.rcon(server, [`changelevel ${map}`]); } catch { /* the map check decides */ }
    await this.sleep(MAP_SETTLE_MS);
    const [st] = await this.deps.rcon(server, ['status', ...lines]);
    if (parseStatusMap(st) !== map) throw new Error(`${map} did not load (the box is on ${parseStatusMap(st) ?? 'no map'})`);
    if (!finishRecovery(this.db, b.id, new Date(this.now()))) return;
    this.emptyWatches.delete(b.id);
    this.announced.delete(b.id);
    let restored: string | null = null;
    if (resumed) {
      const [sa, sb] = sidesOf(this.db, b.id);
      const sideA = (this.db.prepare('SELECT booking_side_a FROM matches WHERE id = ?').get(snap!.matchId) as { booking_side_a: Side | null }).booking_side_a ?? 'a';
      const teamName = (t: 'a' | 'b') => sideName(this.db, (t === 'a') === (sideA === 'a') ? sa : sb);
      const totA = snap!.maps.reduce((n, x) => n + x.a, 0);
      const totB = snap!.maps.reduce((n, x) => n + x.b, 0);
      const cname = campaignRegistry(this.db).get(snap!.campaign)?.name ?? snap!.campaign;
      restored = `your game is back on ${cname} map ${snap!.maps.length + 1}, ${teamName('a')} ${totA} - ${teamName('b')} ${totB}`;
      await this.push(b.id, server, () => [consoleText(
        `say [Booking] Restored after a server restart: ${cname} map ${snap!.maps.length + 1}, ${teamName('a')} ${totA} - ${teamName('b')} ${totB}. ${teamName(snap!.firstSurv)} survive first. Ready up when everyone is back.`, 240)], 'the restore line');
    }
    publishAdminEvent({ kind: 'problem', text: `Booking ${b.id}: set up again on ${server.name}${resumed ? ` and game #${snap!.matchId} restored on ${snap!.map}` : ''}.` });
    this.tell(b.id, this.everyone(b.id), 'booking_recovered', { moved: fresh.recover_reason === 'gone', restored });
  }

  /** Plan 5 rulings 3 and 5: the booking cannot go on. */
  private giveUp(id: number, staffWhy: string, playerWhy: string): void {
    const live = liveBookingGame(this.db, id);
    if (live) {
      const token = abortBookingGame(this.db, live.id, new Date(this.now()), 'server_lost');
      if (token) this.forgetToken(id, token);
    }
    publishAdminEvent({ kind: 'problem', text: `Booking ${id} is cancelled: ${staffWhy}.` });
    if (closeBooking(this.db, id, 'cancelled', 'server_lost', new Date(this.now()))) {
      this.tell(id, this.everyone(id), 'booking_cancelled', { reason: playerWhy });
    }
    // No wind-down here: callers run it (inline from recover, tracked from relocate).
  }
```

`consoleText` must not strip the leading `say `. If it would, build the line as `say [Booking] ` + `consoleText(rest, 220)`, the way `campaignStartLines` does.

In `resume()`, before the `held`/`setup` branch:

```ts
      else if (b.recovering_at !== null && b.server_id !== null) this.track(b.id, () => this.recover(b.id));
```

In `src/bookings/games.ts`:

```ts
export function abortBookingGame(db: DB, matchId: number, now: Date, cause: 'booking_ended' | 'server_lost' = 'booking_ended'): string | null {
```

and use `cause` in the UPDATE in place of the literal.

- [ ] **Step 4: Run them and see them pass, plus the whole booking suite**

Run: `npx vitest run tests/bookingRecovery.test.ts tests/bookingRunner.test.ts tests/bookingGames.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bookings/runner.ts src/bookings/games.ts tests/bookingRecovery.test.ts
git commit -m "Bookings: notice an srcds restart from the boot marker, set the booking up again on the same box and resume its live game"
```

---

### Task 8: A box that is gone: move, wait ahead of PUGs, give up

**Files:**
- Modify: `src/bookings/runner.ts` (`onGone`, `tick`, new `relocate`)
- Modify: `src/server.ts` (wire `a2s: a2sInfo` into the BookingRunner deps)
- Test: `tests/bookingRecovery.test.ts`

**Interfaces:**
- Consumes: `dropBox`, `reholdBox` and `bookingsDue` (Task 1), `pickBox` (existing), `recover` and `giveUp` (Task 7).
- Produces: `relocate()`, run by `tick` and by `allocate()`, which the releaser already calls when a box frees. Waiting bookings are tried before scheduled ones.

`onGone(b, server, now)`: `beginRecovery(db, b.id, 'gone', now)` (if false, return). Then `dropBox`, an admin problem event naming the box ("marked offline; set it idle on the Servers desk once it answers"), `this.deps.preempt()` if no box is free, and `relocate()`.

`relocate()`: for each open booking with `waiting_since` not null and no box: if `now - waiting_since >= recoverWaitMinutes`, call `giveUp(id, 'no server came free within N minutes after its server went down', 'the server went down and no other server was free')` and then `track(windDown(id,false))`. Otherwise `s = pickBox(b)`. If `s` is null, set preempt. Otherwise, if `reholdBox`, `track(recover(id))`. The new box was idle with a standing config, so `recover`'s `waitForStartup`/exec path sets it up, and the moved `matches.server_id` lets `finishMatch` pull the dump from it later. Before `recover` on a moved box, the box gets the same forced restart setup gives a fresh box: in `recover`, when `b.recover_reason === 'gone'` and the box was just taken, call `this.deps.restart(server)` first (track this with a `Set<number>` of `freshBox` ids filled by `relocate`).

- [ ] **Step 1: Write the failing tests**

```ts
describe('box gone', () => {
  const kill = (name = 'ccc') => { box[name].down = true; };

  it('is quiet before the limit, then moves to another box after rcon, heartbeat and A2S are silent for 3 minutes', async () => {
    runner = build({ a2s: async () => null });
    const id = await running();
    const m = liveGame(id);
    db.prepare("UPDATE match_live SET last_seen = datetime('now', '-10 minutes') WHERE match_id = ?").run(m);
    kill();
    await runner.tick(); await runner.idle();
    expect(getBooking(db, id)!.server_id).toBe(3);
    now += 3 * MIN;
    await runner.tick(); await runner.idle();
    const b = getBooking(db, id)!;
    expect(b).toMatchObject({ server_id: 2, recovering_at: null, recoveries: 1 });
    expect((db.prepare('SELECT status FROM servers WHERE id = 3').get() as { status: string }).status).toBe('offline');
    expect(restarted).toContain('bb');
    expect(db.prepare('SELECT server_id, state FROM matches WHERE id = ?').get(m)).toEqual({ server_id: 2, state: 'live' });
    expect(dms.some((d) => d.content.includes('moved to another server'))).toBe(true);
  });

  it('never moves while A2S answers; staff are told once', async () => {
    const seen: AdminEvent[] = [];
    subscribeAdminEvents((e) => seen.push(e));
    runner = build({ a2s: async () => ({ players: 6, map: 'x' }) });
    const id = await running();
    kill();
    for (let i = 0; i < 6; i++) { await runner.tick(); await runner.idle(); now += MIN; }
    expect(getBooking(db, id)).toMatchObject({ server_id: 3, recovering_at: null });
    expect(seen.filter((e) => e.kind === 'problem' && e.text.includes('answers the server browser')).length).toBe(1);
  });

  it('never moves while the live game still heartbeats', async () => {
    runner = build({ a2s: async () => null });
    const id = await running();
    const m = liveGame(id);
    kill();
    for (let i = 0; i < 5; i++) {
      db.prepare('UPDATE match_live SET last_seen = ? WHERE match_id = ?').run(new Date(now).toISOString().replace('T', ' ').slice(0, 19), m);
      await runner.tick(); await runner.idle(); now += MIN;
    }
    expect(getBooking(db, id)!.server_id).toBe(3);
  });

  it('with no free box: waits ahead of PUGs, takes the first freed box, gives up after the wait', async () => {
    runner = build({ a2s: async () => null });
    const id = await running();
    db.prepare("UPDATE servers SET status = 'live' WHERE id IN (1, 2)").run();
    kill();
    await runner.tick(); now += 3 * MIN; await runner.tick(); await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ server_id: null });
    expect(getBooking(db, id)!.waiting_since).not.toBeNull();
    expect(preempts).toBeGreaterThan(0);
    db.prepare("UPDATE servers SET status = 'idle' WHERE id = 1").run();
    expect(claimIdle(db, now)).toBeNull(); // kept back for the waiting booking
    runner.allocate(); await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ server_id: 1, recoveries: 1 });
  });

  it('gives up after booking_recover_wait_minutes', async () => {
    runner = build({ a2s: async () => null });
    const id = await running();
    const m = liveGame(id);
    db.prepare("UPDATE match_live SET last_seen = datetime('now', '-30 minutes') WHERE match_id = ?").run(m);
    db.prepare("UPDATE servers SET status = 'live' WHERE id IN (1, 2)").run();
    kill();
    await runner.tick(); now += 3 * MIN; await runner.tick(); await runner.idle();
    now += 20 * MIN;
    await runner.tick(); await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ state: 'cancelled', end_reason: 'server_lost' });
    expect(getBooking(db, id)!.ended_at).not.toBeNull();
    expect(db.prepare('SELECT abort_cause FROM matches WHERE id = ?').get(m)).toEqual({ abort_cause: 'server_lost' });
  });

  it('a waiting booking survives a web restart', async () => {
    runner = build({ a2s: async () => null });
    const id = await running();
    db.prepare("UPDATE servers SET status = 'live' WHERE id IN (1, 2)").run();
    kill();
    await runner.tick(); now += 3 * MIN; await runner.tick(); await runner.idle();
    const fresh = build({ a2s: async () => null });
    fresh.resume();
    db.prepare("UPDATE servers SET status = 'idle' WHERE id = 2").run();
    await fresh.tick(); await fresh.idle();
    expect(getBooking(db, id)).toMatchObject({ server_id: 2, recoveries: 1 });
  });
});
```

Import `claimIdle` from `../src/serverPool.js`. The fake `release` and `restart` must not undo `down` for the box under test; `restart` of `bb` must bring `bb` up as Pub with an empty marker.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/bookingRecovery.test.ts -t "box gone"`
Expected: FAIL (the `onGone` stub only logs).

- [ ] **Step 3: Implement**

Replace the `onGone` stub:

```ts
  /** Plan 5: the box is gone. Let go of it, keep a box back from the PUG
   *  queue, and take the first one that is free. */
  private onGone(b: BookingRow, server: ServerRow, now: Date): void {
    if (!beginRecovery(this.db, b.id, 'gone', now)) return;
    if (dropBox(this.db, b.id, now) === null) return;
    publishAdminEvent({
      kind: 'problem',
      text: `Booking ${b.id}: ${server.name} is gone (no rcon, no heartbeat, no server browser answer for ${bookingLimits(this.db).goneMinutes} minutes). It is marked offline; set it idle on the Servers desk once it answers. The booking is moving to another server.`,
    });
    this.relocate();
  }

  /** Waiting bookings first: the only time a booking goes ahead of PUGs. */
  private relocate(): void {
    const nowMs = this.now();
    const wait = bookingLimits(this.db).recoverWaitMinutes * 60_000;
    let preempt = false;
    for (const b of openBookings(this.db)) {
      if (b.waiting_since === null || b.server_id !== null || b.ending_at !== null || this.busy.has(b.id)) continue;
      if (nowMs - Date.parse(b.waiting_since) >= wait) {
        this.giveUp(b.id, `no server came free within ${wait / 60_000} minutes after its server went down`, 'the server went down and no other server was free');
        this.track(b.id, () => this.windDown(b.id, false));
        continue;
      }
      const s = this.pickBox(b);
      if (!s || !reholdBox(this.db, b.id, s.id, new Date(nowMs))) { preempt = true; continue; }
      console.log(`[booking] ${b.id} moves to ${s.name}`);
      this.freshBox.add(b.id);
      this.track(b.id, () => this.recover(b.id));
    }
    if (preempt) this.deps.preempt();
  }
```

Add the field `private readonly freshBox = new Set<number>();`. At the top of `recoverOnce` add:

```ts
    if (this.freshBox.delete(b.id) && !(await this.deps.restart(server))) throw new Error('the new box did not come back from its restart');
```

Call `this.relocate();` first thing in `allocate()`, and in `tick()` right after `this.remind(now);`. Because of the busy guard, a call from both places is harmless.

In `resume()`, a waiting booking (`recovering_at` set, `server_id` null) needs nothing: the next tick's `relocate` picks it up. A booking with `recovering_at` set and a box re-runs `recover` (Task 7). That box may be a fresh box from a move whose restart a web restart cut off; the setup path's `waitForStartup` plus exec covers that, because a box mid-restart answers once it is up.

In `src/server.ts`, where the `BookingRunner` is constructed, add `a2s: a2sInfo,` and import `{ a2sInfo }` from `./a2s.js`.

- [ ] **Step 4: Run them and see them pass, then the full suite and typecheck**

Run: `npx vitest run tests/bookingRecovery.test.ts && npm run typecheck && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bookings/runner.ts src/server.ts tests/bookingRecovery.test.ts
git commit -m "Bookings: a booked box that is gone is marked offline and the booking moves to the first free box, ahead of PUGs, or is cancelled after the wait"
```

---

### Task 9: Guards elsewhere: reaper, self-started adoption, booking page

**Files:**
- Modify: `src/liveView.ts` (`reapOrphanedMatches` query, line ~807)
- Modify: `src/selfStarted.ts` (adoption transaction, line ~334)
- Modify: `src/bookings/bookings.ts` (`BookingView.recovery`, `bookingView`)
- Modify: `web/src/routes/Booking.tsx`, plus the web API type for the booking view (find it with `grep -rn "gamesPlayed" web/src/api*`)
- Modify: the match page note (find where `restored_at_map` would show: `grep -rn "abort_cause" src/routes/matches*.ts web/src/routes/Match*.tsx | head`)
- Test: `tests/liveView.test.ts`, `tests/bookingGames.test.ts` (self-started), `web/src/routes/Booking.test.tsx`

**Interfaces:**
- Produces: `BookingView.recovery: { since: string; moved: boolean; waiting: boolean } | null`. The match API gains `restoredAtMap: number | null`.

- [ ] **Step 1: Write the failing tests**

`tests/liveView.test.ts`:

```ts
it('reaper skips a recovering booking\'s game', () => {
  // A booking in recovery, its live game silent for an hour.
  const b = Number(db.prepare(
    `INSERT INTO bookings (purpose, starts_at, ends_at, state, password, tv_password, game_config, rules_json, playlist_json, created_by, created_at, recovering_at)
     VALUES ('scrim', '2026-10-02T20:00:00Z', '2026-10-02T22:00:00Z', 'active', 'pw', 'tv', 'pug', '{}', '["no_mercy"]', ?, '2026-10-01T00:00:00Z', '2026-10-02T20:30:00Z')`,
  ).run(SOME_PLAYER).lastInsertRowid);
  const m = Number(db.prepare("INSERT INTO matches (season_id, state, campaign, token, origin, booking_id) VALUES (?, 'live', 'no_mercy', 't', 'in_game', ?)").run(currentSeasonId(db), b).lastInsertRowid);
  db.prepare("INSERT INTO match_live (match_id, last_seen) VALUES (?, datetime('now', '-60 minutes'))").run(m);
  expect(reapOrphanedMatches(db, releaser)).not.toContain(m);
});
```

Use that file's existing fixtures for `db`, `releaser` and a player row (`SOME_PLAYER`), and add a player row if it has none.

`tests/bookingGames.test.ts`: copy that file's existing booked-adoption test and set `recovering_at` on the booking while a live game exists. Expect no second match row, and the plugin told `sm_pug_abort <new token>` (whatever the refusal path does today for `return null`; assert the match count stays at 1).

`web/src/routes/Booking.test.tsx`: render with `recovery: { since: '...', moved: false, waiting: false }` and expect the text `The server restarted. Setting it up again`. With `waiting: true`, expect `The server went down. Waiting for another one`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/liveView.test.ts tests/bookingGames.test.ts web/src/routes/Booking.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`reapOrphanedMatches`, the query:

```sql
SELECT m.id, m.server_id FROM matches m
  JOIN match_live l ON l.match_id = m.id
 WHERE m.state = 'live' AND l.last_seen < ?
   AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = m.booking_id AND b.recovering_at IS NOT NULL AND b.ending_at IS NULL)
```

with a comment: `// A booking in crash recovery (plan 5) owns its game's fate: restored, or aborted as server_lost by its give-up.`

`selfStarted.ts`, right after `booking = bookingOnServer(db, serverId);`:

```ts
        // Plan 5: a booking being set up again after a restart already has a
        // game to restore; a fresh go-live on the box must not become a second one.
        if (booking && booking.recovering_at !== null && liveBookingGame(db, booking.id)) return null;
```

(Import `liveBookingGame` from `./bookings/games.js`.)

`bookingView`: add `recovery: b.recovering_at !== null && b.ending_at === null ? { since: b.recovering_at, moved: b.recover_reason === 'gone', waiting: b.server_id === null } : null,`. While `waiting` is true, `connect` is null, which it already is when `server_id` is null; check this.

`Booking.tsx`: above the connect block, render it in the page's existing notice style (copy the class the "closing" notice uses):

```tsx
{v.recovery && (
  <p class="notice">
    {v.recovery.waiting
      ? 'The server went down. Waiting for another one; the new connect line will show here and in your DMs.'
      : v.recovery.moved
        ? 'The server went down. Setting up another one now.'
        : 'The server restarted. Setting it up again; your game comes back on the map it was on.'}
  </p>
)}
```

In the games list, a game with `restoredAtMap !== null` gets the note `Stats from map {restoredAtMap + 1} on: the server restarted`. Carry `restored_at_map` through `bookingGames` (add it to the SELECT and to `BookingGameView` as `restoredAtMap`) and through the match page the same way.

- [ ] **Step 4: Run them and see them pass, then everything**

Run: `npx vitest run tests/liveView.test.ts tests/bookingGames.test.ts web/src/routes/Booking.test.tsx && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/liveView.ts src/selfStarted.ts src/bookings/bookings.ts src/bookings/games.ts web/src tests
git commit -m "Bookings: the reaper and self-started adoption leave a recovering booking alone; the booking page says the server is being set up again"
```

---

### Task 10: In-game check on the local server, and the staging runbook

Nothing here is automated. This task proves the plugin contract Task 7 assumes, on `/home/volence/l4d1-ds` in cheats mode. Read the memory notes "Local server is shared" and "Local tests use cheats" first: check `status` for humans and foreign sessions before you start, and ask the owner before launching their client.

**Files:**
- Create: `plugin/RECOVERY-TESTING.md` (the runbook below, with the results filled in)

- [ ] **Step 1: Stage the three builds on the local server only**

Copy `pug-match.smx`, `l4d_booking.smx` and `l4dscores.smx` into `/home/volence/l4d1-ds/left4dead/addons/sourcemod/plugins/`. Start with `l4d1-ds/start-cheats.sh`. Confirm the versions with `sm plugins list`.

- [ ] **Step 2: Resume with no clients (contract)**

Over rcon (`rcon-local.py`):
```
sm_pug_resume 999 abc123 l4d_vs_hospital01_apartment b 50
sm_pug_resume_map l4d_vs_hospital01_apartment 400 300
sm_pug_roster 76561199000000001:a:0
sm_pug_roster 76561199000000002:b:0
sm_pug_resume_commit
changelevel l4d_vs_hospital02_subway
sm_pug_status
```
Expected: `PUGOK resume=999`, `PUGOK resume_map=1`, `PUGOK resumed maps=1 roster=2`. After the changelevel, `sm_pug_status` shows state pending, map count 1 and seedHold. The SM log shows `resumed match, pug team b survives first`, and a heartbeat with token `abc123` arrives on the log feed.

- [ ] **Step 3: With the owner's client plus bots (needs the owner)**

On the owner's go-ahead, launch their client through the HUD harness. Roster the owner's steamid as team b, then resume as in step 2 with `b` surviving first. Expected:
- The owner is placed on survivors.
- At go-live the log shows `l4dscores seeded survivors=300 infected=400`, and `sm_printscores` shows those totals.
- After the map, the next map's survivor-first order follows the totals.
- The final `sm_pug_dump abc123` lists map 1 at 400/300 plus the played map.

Note whether `mapCounter` = map number or 1 is right for the finale swap, and fix `SeedL4dscoresTally` if needed.

- [ ] **Step 4: A real crash under the site (dev server)**

With the dev API pointed at the local box as a pool server (the scratch-DB dev setup from the teams polish work: API 8091, `/api/dev/login`), make a booking with the switch on admins. Let it go ready, then `kill -9` the local srcds. Expected within 2 minutes: an admin event "restarted; setting the booking up again", the box set up again, and `l4d_booking_id` set.

- [ ] **Step 5: Write `plugin/RECOVERY-TESTING.md`**

Record the commands above, what each one printed, and any fix made. Commit:

```bash
git add plugin/RECOVERY-TESTING.md plugin/pug-match.sp
git commit -m "Crash recovery: local server checks of sm_pug_resume, the side seed and the l4dscores seed"
```

- [ ] **Step 6: Staging order (for the owner's go-ahead, not done in this plan)**

1. Web deploy first. It is safe alone: with l4d_booking unstaged, setup refuses every box as today, and nothing recovers.
2. Then stage `l4dscores` riverside3, `pug-match` 0.3.19 (carrying 0.3.18's unshipped seed-and-hold) and `l4d_booking` 1.4.0 on every pool box via `deploy/tools/stage-on-restart.sh`.
3. Verify that `l4d_booking_version` is `1.4.0` and `sm plugins list` shows pug-match 0.3.19 on each box.

---

## Self-review notes

- Spec coverage: same-box restore (Task 7); box gone with heartbeat + A2S (Tasks 2, 3, 8); A2S shows players means staff alert and no move (Tasks 2, 8); the move replays setup with the same password (Task 8 runs `recover` on the new box with `bookingLines`); restore to the map with scores from `match_rounds` using seed-and-hold (Tasks 4, 5, 7); admin feed and both sides told with the new connect line (Tasks 6, 7, 8); waiting ahead of new PUGs (Tasks 1, 8); local server test of the restore (Task 10); a web restart resumes (Tasks 7, 8).
- Not in the spec but needed: the boot marker (the spec's "plugin reports no match" has no signal between games, since pug-match emits nothing in MS_None), the give-up wait (ruling 3), and the reaper and adoption guards.
- Deliberately out: restoring player stats from before a restart (ruling 2), writing the engine's own campaign score (ruling 6), and a pug-match reload with srcds still up (the marker stays, so the orphan reaper still handles that one as today).
