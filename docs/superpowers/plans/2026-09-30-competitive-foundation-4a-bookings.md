# Competitive foundation plan 4a: server bookings (core)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A team captain (or anyone, as a pickup group) books a pool server for a time slot against another team or player. The other side confirms, both sides add their people, and at start time minus 15 minutes the site takes a real box. It sets the box up with the booking's game config, a private server password and a private SourceTV password, then hands the connect line to both sides by DM and on the site. It ends the booking on time, when the server sits idle, on a captain's End, on a no-show claim or on a cancel. All of it sits behind `competitive_enabled`.

**Architecture:** Five tables (`bookings`, `booking_sides`, `booking_people`, `booking_events`, `notification_prefs`) plus `servers.region`. Pure rules (capacity, allowance, campaign timing, "boxes due") live in `src/bookings/rules.ts`. Every booking write is a synchronous better-sqlite3 transaction in `src/bookings/bookings.ts` that returns `{ ok, value } | { ok: false, error }`, the same shape as `src/teams/teams.ts`. Everything that talks to a game server lives in one class, `BookingRunner` (`src/bookings/runner.ts`), modelled on `PracticeLeases`: a minute tick, a guarded `end`, a wind-down that holds the box until its restart is done, and `resume()` after a web restart. A booking holds its box through a new arm of the `open_server_holds` view (kind `booking`, rank 0). A new small SourceMod plugin, `l4d_booking`, re-applies the booking's passwords after every map load, because `server.cfg` puts the standing ones back on each map change. `src/notify/` sends Discord DMs, honouring per-type opt-outs.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Fastify 5, better-sqlite3, vitest (`npm test`, `npx vitest run <file>`), `npm run typecheck`; Preact + preact-iso + @testing-library/preact for the web; SourcePawn 1.12 via `plugin/build*.sh` (wine + Rotoblin spcomp).

**Spec:** `docs/superpowers/specs/2026-09-30-competitive-foundation-design.md`, section 3 (Server booking), section 4 (Region, Notifications), Error handling, Rollout item 4. Scrim spec `docs/superpowers/specs/2026-09-30-competitive-scrims-design.md` section 3a for who may cancel.

## Plan 4 is split

Rollout item 4 of the spec ("Bookings, plugin allowlist and commands, voice, SourceTV lockdown, notifications") is several times plan 3's size, so it ships as four plans, each usable on its own behind the switch:

- **4a (this plan): bookings core.** Booking, invite, confirm, people, capacity, allowance, box allocation and setup, private server and SourceTV passwords, connect line, reminders, time and idle end, cancel, extend, no-show claim, admin list, notifications module.
- **4b: games inside a block.** Each game is a `matches` row (kind scrim, `booking_id`), with no ready-check timers or abandon penalties, the playlist flow (`!nextmap` / `!stay` / `!end` / `!extend`), captain commands gated by the rules, rules pushed per match, the allowlist kick plus `!allow` grace, and the "everyone left after a finished game" end.
- **4c: voice and presentation.** A Discord voice channel per side, team names on match cards, the team page Scrims tab, the caster invite (`booking_casters`), and the `/cast` relay password for staff and casters.
- **4d: side-locked spectating.** Probe first on the local server, then the plugin piece.

Until 4b lands, a booked server loads the first campaign of the playlist and the players play it with the normal ready-up. Nothing is recorded as a match, and a different campaign needs an admin. That is enough for admins to try the booking lifecycle with the switch on `admins`. Do not open the switch to everyone before 4b.

## Global Constraints

- Tables: `bookings` (id, purpose `scrim` | `tournament`, region, starts_at, ends_at, state, server_id, password, tv_password, game_config, rules_json, playlist_json, extended_minutes, created_by, created_at, held_at, ready_at, ended_at, end_reason, plus the bookkeeping columns in Task 1), `booking_sides` (booking_id, side a/b, team_id null for a pickup group, captain_steamid, confirmed_at), `booking_people` (booking_id, side, steamid, role `player` | `ringer` | `spectator`, status `invited` | `accepted`, added_by).
- States: `scheduled` → `held` → `setup` → `ready` → `active` → `ended`, or `cancelled` / `no_show`.
- A pickup group is a side with no team_id; it never counts toward anyone's team cap.
- Length 1 to 3 hours in 30-minute steps; booked up to 14 days ahead; up to 4 upcoming bookings per team or pickup captain (`booking_max_upcoming`), lowered by one for each no-show in the last 30 days (minimum 1); playlist up to 4 campaigns. Every number is a setting in the Settings desk group "Competitive".
- Capacity: at every moment the booking covers, `enabled servers in region - overlapping bookings >= pug_reserve_servers` (default 2).
- At T-15 minutes the booking picks an idle, enabled box in the region and becomes `held`; a running PUG is never interrupted; if no box is free it retries every minute and takes the first box released. Practice leases and side games on the pool are preempted as ranked preemption does today.
- Setup copies the practice lease flow: forced restart, `exec` the booking's game config, set password, identity line, then `ready`. Connect info goes to both sides on the site and by DM.
- Players never get the rcon password.
- SourceTV: `tv_password` is random per booking and never shown to players. A booked box appears in no public server list.
- Cancel: either side's captain or co-captain, any time; staff from the admin list. No-show: if a side is not on the server `rules.noShowGraceMinutes` after the start, the other side may end the booking and the absent side gets a no-show. Extend adds 30 minutes if the capacity rule holds for the extra time. Idle end: empty for 10 minutes. End: goodbye message, kick, release with a restart.
- Every state change of a booking is a single transaction with an audit row (`booking_events`). A web restart resumes bookings from their state. A booking that fails setup twice goes to `cancelled` with `end_reason = 'setup_failed'`, both sides told, staff alerted, and is not a no-show.
- rcon follows the one-connection-per-burst rule (`LeaseRcon`); nothing opens parallel rcon sessions to a box.
- `servers.region`, `bookings.region`: text, default `na`. Nothing region-related is shown while only one region exists.
- Notifications: `src/notify/` decides who gets told what; players can turn off each type (`notification_prefs`).
- Everything sits behind `competitive_enabled` (off | admins | everyone). Closed means every `/api/bookings*` route answers 404 and no nav link shows.
- Staff = `is_admin = 1` or `is_mod = 1`.
- Never write em dashes in code, comments, commits or docs.
- Commit messages follow the repo style (plain sentence). Do not push. Do not deploy, restart, stage or rcon any live box; the plugin is built and tested only on the local server (`/home/volence/l4d1-ds`, check `status` for other people first).
- Several Claude sessions may use `/home/volence/l4d/pug`: work in a worktree branch; check `git reflog -10` and `git status` before any write on master.

## Rulings this plan makes (owner to confirm at review)

1. **Boxes are kept back for bookings due soon.** The spec says a booking takes a box at T-15 and never interrupts a PUG. On a busy night every box can be running a PUG at T-15, and the booking would wait about an hour. So `claimIdle` keeps back one idle box for each confirmed booking starting within `booking_protect_minutes` (default 75) that has no box yet. PUGs still always have at least `pug_reserve_servers` boxes, by the capacity rule. Practice leases and side games respect the same count.
2. **A booking waiting for its box outranks the PUG queue for a freed box.** Owner, 2026-09-30: "bookings are a hold PUGs can never override". The rule in 1 does this: a box released while a booking is due stays idle for it, and the runner is woken by the releaser to take it at once.
3. **An unconfirmed booking holds its capacity.** If it didn't, a confirm could fail on capacity. To stop held slots from piling up, an invite that is not confirmed expires after 24 hours, or 30 minutes before the start if that comes first. A booking made 30 minutes or less ahead has until its start instead (final review fix 5).
4. **"On the server" for the no-show rule means 4 of that side's people at once** (`SHOWN_MIN = 4`, the scrim spec's "Shown" definition). Only a side that itself reached 4 may claim the other side's no-show. If neither side shows, the idle end closes the booking and nobody is recorded.
5. **People.** A team side starts with the team's active members as accepted players (the snapshot is taken when that side is created or confirmed). Anyone else a manager adds is `invited` until they accept on the site. At most 12 people per side. Connect details go only to accepted people and staff.
6. **Starting a booking:** a team's captain or co-captain for a team side, or any player for a pickup side. The opponent is a live team (its captain or co-captains confirm) or one player (who confirms and becomes the pickup captain).
7. **The game config is checked after `exec`** by `l4d_game_type_name` no longer containing `Pub`. `game_configs` has no per-config marker yet.

## Not in this plan (and why)

- Match rows, stats and replays for booked games, the playlist flow, in-game captain commands, the allowlist and `!allow`, rules pushed per match: 4b.
- Voice channels, team names on match cards, Scrims tab, caster invites, the `/cast` relay password: 4c. Side-locked spectating: 4d.
- Late-cancel recording and excuses, the reliability score, the scrim board: scrim spec (part 4). This plan stores `cancelled_by`, `cancel_side`, the cancel time and the reason, which is everything part 4 needs.
- Crash recovery: foundation plan 5. A box that dies mid-booking leaves the booking `active` until it times out; staff can cancel it.
- "Tournament night: PUG queue on N servers" banner: tournament spec. Lowering `pug_reserve_servers` already works.
- Moving the team-invite DM onto `src/notify/`: later; it already works and has its own rate limit.

## Review Focus

- **Overlap arithmetic at the edges.** A booking 20:00-21:00 and one 21:00-22:00 do not overlap, so with room for one booking both fit. A third request 20:30-21:30 overlaps each of them, but never both at once, so it is refused only when room is 1. Task 2 tests.
- **One person on both sides.** A player on both teams of a team-vs-team booking (a player may be on 3 teams) is kept on side A only, and cannot be added to side B by hand. Task 4 tests.
- **A web restart in each state.** `held`/`setup` reruns setup; `ready`/`active` carries on; a booking whose wind-down had started finishes it without a second goodbye; a cancel with no box leaves nothing to do. Task 7 tests.
- **The password survives a map change.** After `changelevel`, `sv_password` and `tv_password` on the box are the booking's, not the standing ones from `secrets.cfg` / `local.cfg`. Task 6 local-server check.
- **A captain who leaves the team after booking.** Rights follow current team roles, not who booked: a former co-captain cannot cancel; the new captain can. Task 4 test.

---

## File map

| File | Responsibility |
|---|---|
| `src/db.ts` | SCHEMA: five tables; `servers.region`; the `booking` arm of `open_server_holds`; DEFAULT_SETTINGS gains the booking keys. |
| `src/settingsSchema.ts` | Booking settings in the `Competitive` group. |
| `src/serverHolds.ts` | `HoldKind` gains `'booking'`. |
| `src/serverPool.ts` | `ServerRow.region`; `claimIdle` keeps boxes back for bookings due soon. |
| `src/mergePlayers.ts` | Booking columns follow a merged account. |
| `src/bookings/rules.ts` | Limits, capacity, allowance, campaign timing, `bookingsDue`. |
| `src/bookings/bookings.ts` | Every booking write and view. |
| `src/bookings/messages.ts` | DM text for each booking notification. |
| `src/notify/notify.ts` | Notification types, preferences, `Notifier`. |
| `src/serverSetup.ts` | Shared box setup helpers moved out of practice leases (`waitForStartup`, `cvarValue`, `quoted`, `BoxRcon`). |
| `src/bookings/runner.ts` | `BookingRunner`: allocation, setup, tick, end, wind-down, resume. |
| `src/practiceLeases.ts`, `src/sideGames.ts` | Respect boxes kept for bookings; preemption also serves a waiting booking. |
| `plugin/l4d_booking.sp`, `plugin/build-booking.sh` | Re-apply booking password, SourceTV password and notice after every map load. |
| `src/routes/bookings.ts` | Player HTTP surface. |
| `src/routes/adminBookings.ts` | Staff list, cancel, extend. |
| `src/routes/serverChat.ts` | `booking` state in the mod chat server list. |
| `src/server.ts` | Builds the runner and notifier, tick, resume, stop, routes. |
| `web/src/api.ts` | Types, `bookingsApi`, admin calls. |
| `web/src/routes/Bookings.tsx`, `web/src/routes/Booking.tsx` | List and create page, one booking page. |
| `web/src/routes/admin/BookingsPanel.tsx`, `AdminLive.tsx` | Staff panel on the Live desk. |
| `web/src/AppRoutes.tsx`, `web/src/components/Nav.tsx` | Routes and the nav link. |

---

### Task 1: Schema, settings, region, holds view, account merge

**Files:**
- Modify: `src/db.ts` (SCHEMA string after `team_invites_open`; `ensureColumn` block near line 1363 for `servers.region`; `SERVER_HOLDS_VIEW` near line 1108; `DEFAULT_SETTINGS` after `team_membership_cap`)
- Modify: `src/serverPool.ts` (`ServerRow`: add `region`)
- Modify: `src/serverHolds.ts` (`HoldKind`)
- Modify: `src/settingsSchema.ts` (entries after `team_membership_cap`)
- Modify: `src/mergePlayers.ts` (`PLAIN`, `KEYED`)
- Test: `tests/bookingsSchema.test.ts` (new), `tests/mergePlayers.test.ts` (one case)

**Interfaces:**
- Produces: tables `bookings`, `booking_sides`, `booking_people`, `booking_events`, `notification_prefs` exactly as in Step 3; column `servers.region TEXT NOT NULL DEFAULT 'na'`; `ServerRow.region: string`.
- Produces: `HoldKind = 'booking' | 'practice' | 'side'`; an open booking with a box is `holdFor(...).kind === 'booking'` and wins over any other hold on that box (rank 0).
- Produces: settings `booking_max_upcoming` 4, `pug_reserve_servers` 2, `booking_days_ahead` 14, `booking_min_minutes` 60, `booking_max_minutes` 180, `booking_playlist_max` 4, `booking_hold_lead_minutes` 15, `booking_protect_minutes` 75, `booking_idle_end_minutes` 10, `booking_extend_minutes` 30.

- [ ] **Step 1: Write the failing tests**

`tests/bookingsSchema.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { holdFor } from '../src/serverHolds.js';
import { claimableServers } from '../src/serverPool.js';
import { validateSetting } from '../src/settingsSchema.js';
import { getSetting } from '../src/settings.js';

const A = '76561199000000401';
let db: DB;
let serverId: number;
beforeEach(() => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, 'a', 'active')").run(A);
  serverId = Number(db.prepare(
    "INSERT INTO servers (name, host, port, rcon_port, rcon_password, status) VALUES ('s1', 'h', 27015, 27015, 'pw', 'idle')",
  ).run().lastInsertRowid);
});

const booking = (over: Record<string, unknown> = {}) => {
  const row = {
    purpose: 'scrim', starts_at: '2026-10-02T20:00:00.000Z', ends_at: '2026-10-02T22:00:00.000Z',
    password: 'abcdefgh', tv_password: 'hgfedcba', game_config: 'standard', rules_json: '{}', playlist_json: '["no_mercy"]',
    created_by: A, created_at: '2026-10-01T12:00:00.000Z', server_id: null, ended_at: null, ...over,
  };
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO bookings (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...Object.values(row)).lastInsertRowid);
};

describe('booking schema', () => {
  it('servers carry a region, na by default', () => {
    expect(db.prepare('SELECT region FROM servers WHERE id = ?').get(serverId)).toEqual({ region: 'na' });
  });

  it('a booking starts scheduled in region na and refuses an unknown state', () => {
    const id = booking();
    expect(db.prepare('SELECT state, region, extended_minutes, setup_attempts FROM bookings WHERE id = ?').get(id))
      .toEqual({ state: 'scheduled', region: 'na', extended_minutes: 0, setup_attempts: 0 });
    expect(() => db.prepare("UPDATE bookings SET state = 'paused' WHERE id = ?").run(id)).toThrow(/CHECK/);
  });

  it('an open booking with a box holds it, ahead of any other holder', () => {
    db.prepare("INSERT INTO practice_leases (server_id, kind, owner_player_id, password, last_human_at, ends_at) VALUES (?, 'park', ?, 'x', '2026-10-01', '2026-10-01')")
      .run(serverId, A);
    const id = booking({ server_id: serverId });
    expect(holdFor(db, serverId)).toEqual({ kind: 'booking', rowId: id });
    expect(claimableServers(db)).toEqual([]);
  });

  it('a booking without a box, or one whose box is back, holds nothing', () => {
    booking();
    booking({ server_id: serverId, ended_at: '2026-10-02T22:05:00.000Z' });
    expect(holdFor(db, serverId)).toBeNull();
    expect(claimableServers(db).map((s) => s.id)).toEqual([serverId]);
  });

  it('booking_people has one row per person per booking', () => {
    const id = booking();
    const ins = db.prepare("INSERT INTO booking_people (booking_id, side, steamid, role, status, added_by, added_at) VALUES (?, ?, ?, 'player', 'accepted', ?, 'x')");
    ins.run(id, 'a', A, A);
    expect(() => ins.run(id, 'b', A, A)).toThrow(/UNIQUE|PRIMARY/);
  });

  it('ships the booking settings with defaults and bounds', () => {
    expect(getSetting(db, 'pug_reserve_servers')).toBe('2');
    expect(getSetting(db, 'booking_max_upcoming')).toBe('4');
    expect(getSetting(db, 'booking_protect_minutes')).toBe('75');
    expect(validateSetting('booking_max_minutes', '600').ok).toBe(false);
    expect(validateSetting('booking_hold_lead_minutes', '20')).toEqual({ ok: true, value: '20' });
  });
});
```

Add to `tests/mergePlayers.test.ts`, inside `describe('mergePlayers', ...)` after the teams case:

```ts
  it('moves booking rows, keeping one place per booking when both accounts were in it', () => {
    const b = Number(db.prepare(
      `INSERT INTO bookings (purpose, starts_at, ends_at, password, tv_password, game_config, rules_json, playlist_json, created_by, created_at)
       VALUES ('scrim', '2026-10-02T20:00:00.000Z', '2026-10-02T22:00:00.000Z', 'p', 't', 'standard', '{}', '[]', ?, 'x')`,
    ).run(ALT).lastInsertRowid);
    db.prepare("INSERT INTO booking_sides (booking_id, side, captain_steamid, confirmed_at) VALUES (?, 'a', ?, 'x'), (?, 'b', ?, NULL)")
      .run(b, ALT, b, OTHER);
    const person = db.prepare("INSERT INTO booking_people (booking_id, side, steamid, role, status, added_by, added_at) VALUES (?, 'a', ?, 'player', 'accepted', ?, 'x')");
    person.run(b, ALT, ALT);
    person.run(b, MAIN, ALT);
    db.prepare("INSERT INTO booking_events (booking_id, at, actor, event) VALUES (?, 'x', ?, 'created')").run(b, ALT);
    db.prepare("INSERT INTO notification_prefs (steamid, type, enabled) VALUES (?, 'booking_ready', 0)").run(ALT);

    mergePlayers(db, { from: ALT, into: MAIN });

    expect(db.prepare('SELECT created_by FROM bookings WHERE id = ?').get(b)).toEqual({ created_by: MAIN });
    expect(db.prepare("SELECT captain_steamid FROM booking_sides WHERE booking_id = ? AND side = 'a'").get(b)).toEqual({ captain_steamid: MAIN });
    expect(db.prepare('SELECT steamid, added_by FROM booking_people WHERE booking_id = ?').all(b)).toEqual([{ steamid: MAIN, added_by: MAIN }]);
    expect(db.prepare('SELECT actor FROM booking_events WHERE booking_id = ?').get(b)).toEqual({ actor: MAIN });
    expect(db.prepare('SELECT steamid FROM notification_prefs').all()).toEqual([{ steamid: MAIN }]);
  });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/bookingsSchema.test.ts tests/mergePlayers.test.ts`
Expected: FAIL, `no such table: bookings` (and the merge FK test fails on the new tables once they exist).

- [ ] **Step 3: Add the tables, column, view arm and settings**

In `src/db.ts` SCHEMA, after the line `CREATE UNIQUE INDEX IF NOT EXISTS team_invites_open ...`:

```sql
-- Server bookings (competitive platform, spec part 1 section 3; plan 4a).
-- A booking reserves capacity in a region from the moment it is made. At its
-- start minus booking_hold_lead_minutes it takes a concrete box, which it
-- holds through open_server_holds (kind 'booking', rank 0) until the
-- wind-down restart has finished: ending_at is set when the end starts,
-- ended_at only once the box is back, as for practice_leases. A booking that
-- never had a box gets both at once. state says how it is going; the
-- terminal states are ended, cancelled and no_show.
CREATE TABLE IF NOT EXISTS bookings (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose          TEXT NOT NULL CHECK (purpose IN ('scrim','tournament')),
  region           TEXT NOT NULL DEFAULT 'na',
  starts_at        TEXT NOT NULL,
  ends_at          TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'scheduled'
                   CHECK (state IN ('scheduled','held','setup','ready','active','ended','cancelled','no_show')),
  server_id        INTEGER REFERENCES servers(id),
  password         TEXT NOT NULL,
  tv_password      TEXT NOT NULL,
  game_config      TEXT NOT NULL,
  rules_json       TEXT NOT NULL,
  playlist_json    TEXT NOT NULL,
  extended_minutes INTEGER NOT NULL DEFAULT 0,
  created_by       TEXT NOT NULL REFERENCES players(steamid),
  created_at       TEXT NOT NULL,
  held_at          TEXT,
  ready_at         TEXT,
  setup_attempts   INTEGER NOT NULL DEFAULT 0,
  last_human_at    TEXT,
  reminded_60_at   TEXT,
  reminded_15_at   TEXT,
  warned_minutes   INTEGER,
  ending_at        TEXT,
  ended_at         TEXT,
  end_reason       TEXT,
  cancelled_by     TEXT REFERENCES players(steamid),
  cancel_side      TEXT CHECK (cancel_side IN ('a','b')),
  cancel_reason    TEXT
);
CREATE INDEX IF NOT EXISTS bookings_open ON bookings (starts_at) WHERE ended_at IS NULL;
CREATE TABLE IF NOT EXISTS booking_sides (
  booking_id      INTEGER NOT NULL REFERENCES bookings(id),
  side            TEXT NOT NULL CHECK (side IN ('a','b')),
  team_id         INTEGER REFERENCES teams(id),
  captain_steamid TEXT NOT NULL REFERENCES players(steamid),
  confirmed_at    TEXT,
  peak_present    INTEGER NOT NULL DEFAULT 0,
  no_show_at      TEXT,
  PRIMARY KEY (booking_id, side)
);
CREATE TABLE IF NOT EXISTS booking_people (
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  side       TEXT NOT NULL CHECK (side IN ('a','b')),
  steamid    TEXT NOT NULL REFERENCES players(steamid),
  role       TEXT NOT NULL CHECK (role IN ('player','ringer','spectator')),
  status     TEXT NOT NULL CHECK (status IN ('invited','accepted')),
  added_by   TEXT NOT NULL REFERENCES players(steamid),
  added_at   TEXT NOT NULL,
  PRIMARY KEY (booking_id, steamid)
);
-- The audit trail: one row per state change or edit, written in the same
-- transaction. actor is null for the runner's own changes.
CREATE TABLE IF NOT EXISTS booking_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  at         TEXT NOT NULL,
  actor      TEXT,
  event      TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS booking_events_booking ON booking_events (booking_id, id);
-- Opt-outs from src/notify/. A missing row means the player gets that type.
CREATE TABLE IF NOT EXISTS notification_prefs (
  steamid TEXT NOT NULL REFERENCES players(steamid),
  type    TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  PRIMARY KEY (steamid, type)
);
```

After `ensureColumn(db, 'servers', 'log_auth_seq', ...)`:

```ts
  // Competitive bookings count capacity per region (spec part 1 section 4).
  // Every box today is NA; nothing shows a region while only one exists.
  ensureColumn(db, 'servers', 'region', "TEXT NOT NULL DEFAULT 'na'");
```

Replace `SERVER_HOLDS_VIEW`:

```ts
const SERVER_HOLDS_VIEW = `CREATE VIEW open_server_holds AS
  SELECT server_id, 'booking' AS kind, id AS row_id, 0 AS rank FROM bookings WHERE server_id IS NOT NULL AND ended_at IS NULL
  UNION ALL
  SELECT server_id, 'practice' AS kind, id AS row_id, 1 AS rank FROM practice_leases WHERE ended_at IS NULL
  UNION ALL
  SELECT server_id, 'side' AS kind, id AS row_id, 2 AS rank FROM side_games WHERE ended_at IS NULL`;
```

In `DEFAULT_SETTINGS`, after `team_membership_cap: '3',`:

```ts
  // Server bookings (plan 4a). Every number in spec section 3 is a setting.
  booking_max_upcoming: '4',
  pug_reserve_servers: '2',
  booking_days_ahead: '14',
  booking_min_minutes: '60',
  booking_max_minutes: '180',
  booking_playlist_max: '4',
  booking_hold_lead_minutes: '15',
  booking_protect_minutes: '75',
  booking_idle_end_minutes: '10',
  booking_extend_minutes: '30',
```

In `src/serverPool.ts`, add to `ServerRow` after `deploy_slug`:

```ts
  /** Which region the box counts toward for bookings (default 'na'). */
  region: string;
```

In `src/serverHolds.ts`:

```ts
/** A kind of database hold; one arm of open_server_holds each. A booking
 *  (rank 0) outranks a practice lease (1) and a side game (2). */
export type HoldKind = 'booking' | 'practice' | 'side';
```

In `src/settingsSchema.ts`, after the `team_membership_cap` entry:

```ts
  { key: 'booking_max_upcoming', group: 'Competitive', label: 'Upcoming bookings per side', help: 'How many booked servers one team, or one pickup captain, may have coming up at once. Each no-show in the last 30 days lowers it by one, never below 1.', type: { kind: 'int', min: 1, max: 20 } },
  { key: 'pug_reserve_servers', group: 'Competitive', label: 'Servers always left for PUGs', help: 'A booking is only accepted if, for its whole slot, at least this many enabled servers in its region stay unbooked. Lower it for a tournament night.', type: { kind: 'int', min: 0, max: 10 } },
  { key: 'booking_days_ahead', group: 'Competitive', label: 'Book up to (days ahead)', help: 'How far ahead a server can be booked.', type: { kind: 'int', min: 1, max: 60 } },
  { key: 'booking_min_minutes', group: 'Competitive', label: 'Shortest booking (minutes)', help: 'Bookings are made in 30 minute steps from this length.', type: { kind: 'int', min: 30, max: 360 } },
  { key: 'booking_max_minutes', group: 'Competitive', label: 'Longest booking (minutes)', help: 'Bookings are made in 30 minute steps up to this length, before any extension.', type: { kind: 'int', min: 30, max: 360 } },
  { key: 'booking_playlist_max', group: 'Competitive', label: 'Campaigns per booking', help: 'How many campaigns a booking playlist may list.', type: { kind: 'int', min: 1, max: 8 } },
  { key: 'booking_hold_lead_minutes', group: 'Competitive', label: 'Take the box this early (minutes)', help: 'How long before the start a booking takes its server and sets it up.', type: { kind: 'int', min: 5, max: 60 } },
  { key: 'booking_protect_minutes', group: 'Competitive', label: 'Keep boxes back for bookings (minutes)', help: 'From this long before a booking starts, a new PUG will not take the last idle box that booking needs, so a PUG that starts now cannot still be running when the booking begins. Must be at least the take-the-box time.', type: { kind: 'int', min: 5, max: 180 } },
  { key: 'booking_idle_end_minutes', group: 'Competitive', label: 'End an empty booking after (minutes)', help: 'A booked server with nobody on it for this long, after the start and the no-show grace, is closed and goes back to the pool.', type: { kind: 'int', min: 5, max: 60 } },
  { key: 'booking_extend_minutes', group: 'Competitive', label: 'Extend by (minutes)', help: 'What one Extend adds, if enough servers stay free for the extra time.', type: { kind: 'int', min: 15, max: 120 } },
```

In `src/mergePlayers.ts`, append to `PLAIN` after the `team_invites` lines:

```ts
  // Bookings (src/bookings/bookings.ts) follow the person: the booking they
  // made, the side they captain, what they did on it, a cancel they made.
  ['bookings', 'created_by'],
  ['bookings', 'cancelled_by'],
  ['booking_sides', 'captain_steamid'],
  ['booking_people', 'added_by'],
  ['booking_events', 'actor'],
```

and to `KEYED`:

```ts
  // One place per person per booking. Where both accounts were in one booking
  // (on one side or on both), the survivor's row is kept.
  ['booking_people', 'steamid'],
  // One opt-out per type; where both accounts set one, the survivor's stands.
  ['notification_prefs', 'steamid'],
```

Whichever of the `PLAIN` and `KEYED` loops runs first, the result is the same: the survivor keeps one `booking_people` row, with `added_by` moved to it.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/bookingsSchema.test.ts tests/mergePlayers.test.ts tests/serverHolds.test.ts tests/serverHoldGuard.test.ts`
Expected: PASS. `tests/mergePlayers.test.ts` has a test that enumerates every foreign key pointing at `players`. If it fails, the list it prints names a booking column missing from Step 3. Add that column to `PLAIN`.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors. A test fixture that builds a full `ServerRow` literal now lacks `region`; add `region: 'na'` to each one the compiler names.

```bash
git add src/db.ts src/serverPool.ts src/serverHolds.ts src/settingsSchema.ts src/mergePlayers.ts tests/bookingsSchema.test.ts tests/mergePlayers.test.ts
git commit -m "Bookings: tables, server region, booking holds in open_server_holds, settings, merge"
```

---

### Task 2: Booking rules (capacity, allowance, campaign timing, boxes due)

**Files:**
- Create: `src/bookings/rules.ts`
- Test: `tests/bookingRules.test.ts`

**Interfaces:**
- Consumes: Task 1 tables and settings.
- Produces (all in `src/bookings/rules.ts`):
  - `type BookingState = 'scheduled' | 'held' | 'setup' | 'ready' | 'active' | 'ended' | 'cancelled' | 'no_show'`
  - `OPEN_STATES_SQL: string` = `"('scheduled','held','setup','ready','active')"`
  - `STEP_MINUTES = 30`, `SHOWN_MIN = 4`, `PEOPLE_PER_SIDE = 12`, `NO_SHOW_WINDOW_DAYS = 30`, `DEFAULT_CAMPAIGN_MINUTES = 60`, `UNCONFIRMED_TTL_MS = 24 * 3_600_000`, `UNCONFIRMED_CUTOFF_MS = 30 * 60_000`
  - `interface BookingLimits { minMinutes; maxMinutes; daysAhead; playlistMax; maxUpcoming; reserve; holdLeadMinutes; protectMinutes; idleEndMinutes; extendMinutes }` (all `number`)
  - `bookingLimits(db: DB): BookingLimits`
  - `capacityProblem(db: DB, o: { region: string; startMs: number; endMs: number; exceptId?: number }): number | null` returns the first moment (ms) the rule breaks, or null when it fits
  - `type Party = { teamId: number } | { captain: string }`
  - `upcomingCount(db: DB, party: Party): number`, `recentNoShows(db: DB, party: Party, nowMs: number): number`, `allowance(db: DB, party: Party, nowMs: number): number`
  - `typicalCampaignMinutes(db: DB, campaign: string): number`
  - `playlistMinutes(db: DB, playlist: string[]): number`
  - `bookingsDue(db: DB, nowMs: number, withinMinutes: number): number`
  - `iso(ms: number): string`

- [ ] **Step 1: Write the failing tests**

`tests/bookingRules.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import {
  allowance, bookingLimits, bookingsDue, capacityProblem, playlistMinutes, recentNoShows, typicalCampaignMinutes, upcomingCount,
  DEFAULT_CAMPAIGN_MINUTES,
} from '../src/bookings/rules.js';

const A = '76561199000000501';
const B = '76561199000000502';
const H = 3_600_000;
const T0 = Date.parse('2026-10-02T20:00:00.000Z');
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [A, B]) db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, ?, 'active')").run(id, id.slice(-3));
});

const servers = (n: number, region = 'na') => {
  for (let i = 0; i < n; i++) {
    db.prepare("INSERT INTO servers (name, host, port, rcon_port, rcon_password, status, region) VALUES (?, 'h', ?, 1, 'pw', 'idle', ?)")
      .run(`s${i}`, 27015 + i, region);
  }
};
const book = (startMs: number, endMs: number, o: { state?: string; captain?: string; teamId?: number | null; bConfirmed?: boolean; serverId?: number | null } = {}) => {
  const id = Number(db.prepare(
    `INSERT INTO bookings (purpose, starts_at, ends_at, state, server_id, password, tv_password, game_config, rules_json, playlist_json, created_by, created_at)
     VALUES ('scrim', ?, ?, ?, ?, 'p', 't', 'standard', '{}', '[]', ?, 'x')`,
  ).run(new Date(startMs).toISOString(), new Date(endMs).toISOString(), o.state ?? 'scheduled', o.serverId ?? null, o.captain ?? A).lastInsertRowid);
  db.prepare("INSERT INTO booking_sides (booking_id, side, team_id, captain_steamid, confirmed_at) VALUES (?, 'a', ?, ?, 'x')")
    .run(id, o.teamId ?? null, o.captain ?? A);
  db.prepare("INSERT INTO booking_sides (booking_id, side, captain_steamid, confirmed_at) VALUES (?, 'b', ?, ?)")
    .run(id, B, o.bConfirmed === false ? null : 'x');
  return id;
};
const setReserve = (n: number) => db.prepare("UPDATE settings SET value = ? WHERE key = 'pug_reserve_servers'").run(String(n));

describe('capacity', () => {
  it('fits while enabled minus overlapping bookings stays at or above the reserve', () => {
    servers(3); // room for 1 booking at a time with the default reserve of 2
    expect(capacityProblem(db, { region: 'na', startMs: T0, endMs: T0 + H })).toBeNull();
    book(T0, T0 + H);
    expect(capacityProblem(db, { region: 'na', startMs: T0, endMs: T0 + H })).toBe(T0);
    expect(capacityProblem(db, { region: 'na', startMs: T0 + H, endMs: T0 + 2 * H })).toBeNull(); // back to back is fine
    expect(capacityProblem(db, { region: 'na', startMs: T0 - H, endMs: T0 })).toBeNull();
  });

  it('checks the busiest moment, not just the start', () => {
    servers(4); // room for 2
    book(T0, T0 + H);
    book(T0 + H / 2, T0 + 2 * H);
    // 20:30-21:30: from 20:30 to 21:00 both are running, so a third does not fit.
    expect(capacityProblem(db, { region: 'na', startMs: T0 + H / 2, endMs: T0 + H + H / 2 })).toBe(T0 + H / 2);
    // 21:00-22:00 meets only the second.
    expect(capacityProblem(db, { region: 'na', startMs: T0 + H, endMs: T0 + 2 * H })).toBeNull();
    // 19:00-21:00 starts with nobody, then meets the first at 20:00 and the second at 20:30.
    expect(capacityProblem(db, { region: 'na', startMs: T0 - H, endMs: T0 + H })).toBe(T0 + H / 2);
  });

  it('ignores ended, cancelled and winding-down bookings, the booking itself, disabled boxes and other regions', () => {
    servers(3);
    servers(5, 'eu');
    db.prepare("INSERT INTO servers (name, host, port, rcon_port, rcon_password, status, enabled) VALUES ('off', 'h', 1, 1, 'pw', 'idle', 0)").run();
    book(T0, T0 + H, { state: 'cancelled' });
    book(T0, T0 + H, { state: 'ended' });
    const mine = book(T0, T0 + H);
    expect(capacityProblem(db, { region: 'na', startMs: T0, endMs: T0 + H, exceptId: mine })).toBeNull();
    db.prepare("UPDATE bookings SET ending_at = 'x' WHERE id = ?").run(mine);
    expect(capacityProblem(db, { region: 'na', startMs: T0, endMs: T0 + H })).toBeNull();
  });

  it('refuses everything when the reserve leaves no room, and staff can lower it', () => {
    servers(2);
    expect(capacityProblem(db, { region: 'na', startMs: T0, endMs: T0 + H })).toBe(T0);
    setReserve(1);
    expect(capacityProblem(db, { region: 'na', startMs: T0, endMs: T0 + H })).toBeNull();
  });
});

describe('allowance', () => {
  const now = T0 - 24 * H;
  it('counts open bookings a party is a confirmed side of', () => {
    book(T0, T0 + H, { captain: A });
    book(T0 + 2 * H, T0 + 3 * H, { captain: A, state: 'cancelled' });
    expect(upcomingCount(db, { captain: A })).toBe(1);
    expect(upcomingCount(db, { captain: B })).toBe(1); // B is side b of the first, confirmed
    book(T0 + 4 * H, T0 + 5 * H, { captain: A, bConfirmed: false });
    expect(upcomingCount(db, { captain: B })).toBe(1);  // an unconfirmed invite is not B's yet
  });

  it('a team party counts by team, not by captain', () => {
    db.prepare("INSERT INTO teams (name, name_key, tag, tag_key, slug, captain_steamid, created_by) VALUES ('R', 'r', 'RR', 'RR', 'r', ?, ?)").run(A, A);
    book(T0, T0 + H, { captain: A, teamId: 1 });
    expect(upcomingCount(db, { teamId: 1 })).toBe(1);
    expect(upcomingCount(db, { captain: A })).toBe(0);
  });

  it('each no-show in the last 30 days lowers the allowance by one, never below 1', () => {
    expect(allowance(db, { captain: A }, now)).toBe(4);
    for (let i = 0; i < 5; i++) {
      const id = book(T0 - (i + 1) * 24 * H, T0 - (i + 1) * 24 * H + H, { captain: A, state: 'no_show' });
      db.prepare("UPDATE booking_sides SET no_show_at = ? WHERE booking_id = ? AND side = 'a'").run(new Date(now - i * 24 * H).toISOString(), id);
    }
    expect(recentNoShows(db, { captain: A }, now)).toBe(5);
    expect(allowance(db, { captain: A }, now)).toBe(1);
    expect(recentNoShows(db, { captain: A }, now + 31 * 24 * H)).toBe(0);
  });
});

describe('campaign timing', () => {
  const match = (campaign: string, minutes: number) => {
    db.prepare(
      `INSERT INTO matches (season_id, state, campaign, kind, went_live_at, ended_at)
       VALUES ((SELECT id FROM seasons LIMIT 1), 'completed', ?, 'pug', '2026-09-01 20:00:00', datetime('2026-09-01 20:00:00', ?))`,
    ).run(campaign, `+${minutes} minutes`);
  };
  it('is the median of recent completed PUGs, or the default with fewer than 3', () => {
    match('no_mercy', 50);
    match('no_mercy', 70);
    expect(typicalCampaignMinutes(db, 'no_mercy')).toBe(DEFAULT_CAMPAIGN_MINUTES);
    match('no_mercy', 80);
    expect(typicalCampaignMinutes(db, 'no_mercy')).toBe(70);
    match('no_mercy', 5); // a crash or abort shape, ignored
    expect(typicalCampaignMinutes(db, 'no_mercy')).toBe(70);
    expect(playlistMinutes(db, ['no_mercy', 'death_toll'])).toBe(70 + DEFAULT_CAMPAIGN_MINUTES);
  });
});

describe('bookings due', () => {
  it('counts confirmed bookings with no box starting within the window', () => {
    book(T0, T0 + H);
    book(T0 + 30 * 60_000, T0 + H, { bConfirmed: false });
    book(T0, T0 + H, { serverId: null, state: 'cancelled' });
    expect(bookingsDue(db, T0 - 80 * 60_000, 75)).toBe(0);
    expect(bookingsDue(db, T0 - 70 * 60_000, 75)).toBe(1);
    expect(bookingsDue(db, T0 + 10 * 60_000, 75)).toBe(1); // late and still waiting
  });

  it('reads the limits from settings', () => {
    expect(bookingLimits(db)).toEqual({
      minMinutes: 60, maxMinutes: 180, daysAhead: 14, playlistMax: 4, maxUpcoming: 4, reserve: 2,
      holdLeadMinutes: 15, protectMinutes: 75, idleEndMinutes: 10, extendMinutes: 30,
    });
  });
});
```

The `matches` insert names only the columns a completed PUG needs; `openDb` seeds Season 1, which the subquery picks up.

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/bookingRules.test.ts`
Expected: FAIL, cannot find module `../src/bookings/rules.js`.

- [ ] **Step 3: Write `src/bookings/rules.ts`**

```ts
import type { DB } from '../db.js';
import { settingNumber } from '../settings.js';
import { completedPug } from '../matchKinds.js';

/**
 * The numbers and arithmetic of server bookings (spec part 1 section 3):
 * capacity per region, how many upcoming bookings a side may hold, how long
 * a campaign usually takes, and how many boxes the queue must leave idle for
 * bookings about to start. Read-only; src/bookings/bookings.ts writes.
 *
 * Times are stored as Date#toISOString() strings, so they compare as text.
 */

export type BookingState = 'scheduled' | 'held' | 'setup' | 'ready' | 'active' | 'ended' | 'cancelled' | 'no_show';
/** States that still take up a slot of capacity. A row whose end has
 *  started (ending_at set) does not, whatever its state says. */
export const OPEN_STATES_SQL = "('scheduled','held','setup','ready','active')";
export const STEP_MINUTES = 30;
/** People of one side who must be on the server at once for it to count as
 *  shown (scrim spec section 3, "Shown"). */
export const SHOWN_MIN = 4;
/** Players, ringers and spectators one side may list. */
export const PEOPLE_PER_SIDE = 12;
export const NO_SHOW_WINDOW_DAYS = 30;
/** A campaign with too little history is assumed to take this long. */
export const DEFAULT_CAMPAIGN_MINUTES = 60;
/** An invite nobody confirms expires this long after it was made... */
export const UNCONFIRMED_TTL_MS = 24 * 3_600_000;
/** ...or this long before the start, whichever comes first. */
export const UNCONFIRMED_CUTOFF_MS = 30 * 60_000;

export const iso = (ms: number): string => new Date(ms).toISOString();

export interface BookingLimits {
  minMinutes: number; maxMinutes: number; daysAhead: number; playlistMax: number; maxUpcoming: number;
  reserve: number; holdLeadMinutes: number; protectMinutes: number; idleEndMinutes: number; extendMinutes: number;
}

export function bookingLimits(db: DB): BookingLimits {
  const n = (key: string, fallback: number, min: number, max: number) => settingNumber(db, key, fallback, { integer: true, min, max });
  const holdLeadMinutes = n('booking_hold_lead_minutes', 15, 5, 60);
  return {
    minMinutes: n('booking_min_minutes', 60, 30, 360),
    maxMinutes: n('booking_max_minutes', 180, 30, 360),
    daysAhead: n('booking_days_ahead', 14, 1, 60),
    playlistMax: n('booking_playlist_max', 4, 1, 8),
    maxUpcoming: n('booking_max_upcoming', 4, 1, 20),
    reserve: n('pug_reserve_servers', 2, 0, 10),
    holdLeadMinutes,
    // Never shorter than the lead: a box kept back must still be kept at T-lead.
    protectMinutes: Math.max(holdLeadMinutes, n('booking_protect_minutes', 75, 5, 180)),
    idleEndMinutes: n('booking_idle_end_minutes', 10, 5, 60),
    extendMinutes: n('booking_extend_minutes', 30, 15, 120),
  };
}

function enabledServers(db: DB, region: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM servers WHERE enabled = 1 AND region = ?').get(region) as { n: number }).n;
}

/**
 * The capacity rule: at every moment of [startMs, endMs), enabled servers in
 * the region minus overlapping bookings stays at or above pug_reserve_servers.
 * Null when the new booking fits; otherwise the first moment it would not.
 *
 * Overlap is half-open, so back-to-back bookings never overlap. The number of
 * bookings running at once only rises at a booking's start, so checking the
 * new booking's own start and every other start inside it is enough.
 */
export function capacityProblem(db: DB, o: { region: string; startMs: number; endMs: number; exceptId?: number }): number | null {
  const room = enabledServers(db, o.region) - bookingLimits(db).reserve;
  if (room < 1) return o.startMs;
  const rows = (db.prepare(
    `SELECT starts_at, ends_at FROM bookings
      WHERE region = ? AND state IN ${OPEN_STATES_SQL} AND ending_at IS NULL AND id != ?
        AND starts_at < ? AND ends_at > ?`,
  ).all(o.region, o.exceptId ?? 0, iso(o.endMs), iso(o.startMs)) as { starts_at: string; ends_at: string }[])
    .map((r) => ({ s: Date.parse(r.starts_at), e: Date.parse(r.ends_at) }));
  const points = [o.startMs, ...rows.map((r) => r.s).filter((s) => s > o.startMs)].sort((x, y) => x - y);
  for (const t of points) {
    const running = rows.filter((r) => r.s <= t && r.e > t).length;
    if (running + 1 > room) return t;
  }
  return null;
}

/** Who an allowance belongs to: a team, or the captain of a pickup group
 *  (scrim spec section 3: a pickup group's record is its captain's). */
export type Party = { teamId: number } | { captain: string };

function partyWhere(party: Party): { sql: string; arg: number | string } {
  return 'teamId' in party
    ? { sql: 's.team_id = ?', arg: party.teamId }
    : { sql: 's.team_id IS NULL AND s.captain_steamid = ?', arg: party.captain };
}

/** Open bookings the party is a confirmed side of. */
export function upcomingCount(db: DB, party: Party): number {
  const w = partyWhere(party);
  return (db.prepare(
    `SELECT COUNT(DISTINCT b.id) AS n FROM bookings b JOIN booking_sides s ON s.booking_id = b.id
      WHERE ${w.sql} AND s.confirmed_at IS NOT NULL AND b.state IN ${OPEN_STATES_SQL} AND b.ending_at IS NULL`,
  ).get(w.arg) as { n: number }).n;
}

export function recentNoShows(db: DB, party: Party, nowMs: number): number {
  const w = partyWhere(party);
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM booking_sides s WHERE ${w.sql} AND s.no_show_at IS NOT NULL AND s.no_show_at > ?`,
  ).get(w.arg, iso(nowMs - NO_SHOW_WINDOW_DAYS * 86_400_000)) as { n: number }).n;
}

export function allowance(db: DB, party: Party, nowMs: number): number {
  return Math.max(1, bookingLimits(db).maxUpcoming - recentNoShows(db, party, nowMs));
}

/**
 * How long this campaign usually takes, in minutes: the median of its last 30
 * completed PUGs, from going live to the end, ignoring anything under 10
 * minutes or over 4 hours (aborts, a box left running). With fewer than 3
 * such games, DEFAULT_CAMPAIGN_MINUTES.
 */
export function typicalCampaignMinutes(db: DB, campaign: string): number {
  const mins = (db.prepare(
    `SELECT (julianday(ended_at) - julianday(went_live_at)) * 1440 AS m FROM matches
      WHERE ${completedPug()} AND campaign = ? AND went_live_at IS NOT NULL AND ended_at IS NOT NULL
      ORDER BY id DESC LIMIT 30`,
  ).all(campaign) as { m: number }[]).map((r) => r.m).filter((m) => m >= 10 && m <= 240).sort((a, b) => a - b);
  if (mins.length < 3) return DEFAULT_CAMPAIGN_MINUTES;
  const mid = Math.floor(mins.length / 2);
  return Math.round(mins.length % 2 ? mins[mid] : (mins[mid - 1] + mins[mid]) / 2);
}

export function playlistMinutes(db: DB, playlist: string[]): number {
  return playlist.reduce((sum, c) => sum + typicalCampaignMinutes(db, c), 0);
}

/**
 * Confirmed bookings without a box that start within `withinMinutes` of now
 * (or should already have started): how many idle boxes the queue, practice
 * leases and side games must leave alone right now (claimIdle), or how many
 * bookings are waiting on a box at all (withinMinutes = the hold lead).
 */
export function bookingsDue(db: DB, nowMs: number, withinMinutes: number): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM bookings b
      WHERE b.state = 'scheduled' AND b.server_id IS NULL AND b.ending_at IS NULL AND b.starts_at <= ?
        AND NOT EXISTS (SELECT 1 FROM booking_sides s WHERE s.booking_id = b.id AND s.confirmed_at IS NULL)`,
  ).get(iso(nowMs + withinMinutes * 60_000)) as { n: number }).n;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/bookingRules.test.ts tests/matchKindGuard.test.ts`
Expected: PASS. The guard test accepts `completedPug()`.

- [ ] **Step 5: Commit**

```bash
git add src/bookings/rules.ts tests/bookingRules.test.ts
git commit -m "Bookings: capacity rule, upcoming allowance with no-shows, typical campaign length, boxes due"
```

---
### Task 3: Idle boxes kept back for bookings due soon

**Files:**
- Modify: `src/serverPool.ts` (`claimIdle`)
- Modify: `src/practiceLeases.ts` (`pickLeaseServer`, `needServer` text, `finishPreempt`, `END_SAY.preempted`)
- Modify: `src/sideGames.ts` (`maybeOpen`)
- Test: `tests/bookingHolds.test.ts` (new), `tests/practiceLeases.test.ts` (one assertion updated, one case added)

**Interfaces:**
- Consumes: `bookingsDue`, `bookingLimits` from Task 2.
- Produces: `claimIdle(db: DB, nowMs?: number): ServerRow | null`, which returns null while the idle boxes are no more than the confirmed bookings without a box that start within `protectMinutes`. `pickLeaseServer(db: DB, nowMs?: number)` counts those boxes as taken. `PracticeLeases.finishPreempt` ends the lease when a PUG waits OR when more bookings are waiting at the hold lead than boxes are claimable.

- [ ] **Step 1: Write the failing tests**

`tests/bookingHolds.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer, claimIdle } from '../src/serverPool.js';
import { pickLeaseServer } from '../src/practiceLeases.js';
import { setSetting } from '../src/settings.js';

const A = '76561199000000601';
const B = '76561199000000602';
const START = Date.parse('2026-10-02T20:00:00.000Z');
const MIN = 60_000;
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [A, B]) db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, 'x', 'active')").run(id);
});
const box = (name: string) => {
  const id = addServer(db, { name, host: 'h', port: 27015 + name.length, rconPort: 1, rconPassword: 'x' });
  db.prepare("UPDATE servers SET status = 'idle', enabled = 1 WHERE id = ?").run(id);
  return id;
};
const book = (bConfirmed = true) => {
  const id = Number(db.prepare(
    `INSERT INTO bookings (purpose, starts_at, ends_at, password, tv_password, game_config, rules_json, playlist_json, created_by, created_at)
     VALUES ('scrim', ?, ?, 'p', 't', 'standard', '{}', '[]', ?, 'x')`,
  ).run(new Date(START).toISOString(), new Date(START + 60 * MIN).toISOString(), A).lastInsertRowid);
  db.prepare("INSERT INTO booking_sides (booking_id, side, captain_steamid, confirmed_at) VALUES (?, 'a', ?, 'x'), (?, 'b', ?, ?)")
    .run(id, A, id, B, bConfirmed ? 'x' : null);
  return id;
};

describe('boxes kept back for bookings', () => {
  it('a PUG cannot take the last idle box a booking due within the protect window needs', () => {
    box('a');
    book();
    expect(claimIdle(db, START - 80 * MIN)?.name).toBe('a');
    db.prepare("UPDATE servers SET status = 'idle'").run();
    expect(claimIdle(db, START - 70 * MIN)).toBeNull();
  });

  it('a second idle box is still the queue\'s', () => {
    box('a'); box('bb');
    book();
    expect(claimIdle(db, START - 10 * MIN)?.name).toBe('a');
    expect(claimIdle(db, START - 10 * MIN)).toBeNull();
  });

  it('an unconfirmed invite keeps nothing back', () => {
    box('a');
    book(false);
    expect(claimIdle(db, START - 10 * MIN)?.name).toBe('a');
  });

  it('a practice lease counts the kept boxes as taken', () => {
    box('a'); box('bb');
    setSetting(db, 'practice_reserve_idle', '1');
    expect(pickLeaseServer(db, START - 10 * MIN).ok).toBe(true);
    book();
    expect(pickLeaseServer(db, START - 10 * MIN)).toEqual({ ok: false, reason: 'no_server' });
  });
});
```

In `tests/practiceLeases.test.ts`, change the expected warning line at about line 521 to:

```ts
    expect(sent).toEqual([{ server: 'bb', cmds: ['say [Practice] A ranked match or a booked server needs this box in 60 seconds. Those always come first.'] }]);
```

and add to `describe('preemption', ...)`:

```ts
  it('ends the warned lease for a booking that waits on a box, with no PUG waiting', async () => {
    seedServer('a'); seedServer('bb');
    setSetting(db, 'practice_reserve_idle', '0');
    mgr = manager();
    await mgr.create(ME, 'park');
    await flush();
    db.prepare("UPDATE servers SET status = 'live' WHERE id = 1").run();
    // A confirmed booking starting now, with no box.
    const id = Number(db.prepare(
      `INSERT INTO bookings (purpose, starts_at, ends_at, password, tv_password, game_config, rules_json, playlist_json, created_by, created_at)
       VALUES ('scrim', ?, ?, 'p', 't', 'standard', '{}', '[]', ?, 'x')`,
    ).run(new Date(T0).toISOString(), new Date(T0 + 3_600_000).toISOString(), ME).lastInsertRowid);
    db.prepare("INSERT INTO booking_sides (booking_id, side, captain_steamid, confirmed_at) VALUES (?, 'a', ?, 'x'), (?, 'b', ?, 'x')").run(id, ME, id, YOU);
    mgr.needServer();
    now = T0 + PREEMPT_WARN_MS;
    await mgr.tick();
    await flush();
    expect(getLease(db, 1)!.end_reason).toBe('preempted');
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/bookingHolds.test.ts tests/practiceLeases.test.ts`
Expected: FAIL. `claimIdle` ignores bookings, the warning text differs, and the booking case stands down ("Never mind").

- [ ] **Step 3: Implement**

`src/serverPool.ts`: import `import { bookingLimits, bookingsDue } from './bookings/rules.js';` and replace `claimIdle`:

```ts
/** Atomically reserve one idle, enabled server; returns it, or null if none is
 *  available. A disabled box is invisible here however idle it looks, which is
 *  the whole point: an admin can pull a misbehaving server out of rotation
 *  mid-evening without stopping it, kicking anyone, or editing the database.
 *  A held box (booking, practice lease, side game) is invisible the same way;
 *  a PUG that finds nothing else takes one back through that holder's
 *  preemption (src/practiceLeases.ts, src/sideGames.ts), never by claiming it
 *  here. One idle box is also kept back for each confirmed booking without a
 *  box that starts within booking_protect_minutes (src/bookings/rules.ts), so
 *  a PUG started now is not still running when the booking needs the box. */
export function claimIdle(db: DB, nowMs: number = Date.now()): ServerRow | null {
  return db.transaction(() => {
    const free = claimableServers(db);
    if (free.length <= bookingsDue(db, nowMs, bookingLimits(db).protectMinutes)) return null;
    const row = free[0];
    db.prepare("UPDATE servers SET status = 'reserved' WHERE id = ?").run(row.id);
    return { ...row, status: 'reserved' as const };
  })();
}
```

`src/practiceLeases.ts`: import `import { bookingLimits, bookingsDue } from './bookings/rules.js';`.

`pickLeaseServer`:

```ts
export function pickLeaseServer(db: DB, nowMs: number = Date.now()): PickResult {
  const max = settingNumber(db, 'practice_max_leases', 2, { integer: true, min: 0 });
  if (max === 0) return { ok: false, reason: 'off' };
  if (openLeases(db).length >= max) return { ok: false, reason: 'max_leases' };
  if (matchesWaiting(db) > 0) return { ok: false, reason: 'queue_waiting' };
  const reserve = settingNumber(db, 'practice_reserve_idle', 1, { integer: true, min: 0 });
  // Boxes kept back for bookings about to start count as already taken.
  const kept = bookingsDue(db, nowMs, bookingLimits(db).protectMinutes);
  const free = claimableServers(db);
  if (free.length === 0 || free.length - 1 - kept < reserve) return { ok: false, reason: 'no_server' };
  return { ok: true, server: free[free.length - 1] };
}
```

The call inside `create` passes `this.now()`: `pickLeaseServer(this.db, this.now())`.

`END_SAY.preempted` becomes `'a ranked match or a booked server needs it'`. In `needServer` the `say` line becomes:

```ts
        `say [Practice] A ranked match or a booked server needs this box in ${PREEMPT_WARN_MS / 1000} seconds. Those always come first.`,
```

and its doc comment's first sentence becomes "A PUG, or a booking at its hold time, needs a server and found none." In `finishPreempt` replace the stand-down test:

```ts
    // Still needed: a PUG waits, or more bookings wait at their hold time
    // than there are boxes for them (src/bookings/runner.ts calls needServer).
    const bookingsWaiting = bookingsDue(this.db, this.now(), bookingLimits(this.db).holdLeadMinutes);
    if (matchesWaiting(this.db) === 0 && bookingsWaiting <= claimableServers(this.db).length) {
```

and its "Never mind" line becomes `'say [Practice] Never mind: the server is not needed after all. Carry on.'`.

`src/sideGames.ts`: import `bookingLimits, bookingsDue` from `./bookings/rules.js`; in `maybeOpen` replace the `const server = ...` line with:

```ts
    const free = claimableServers(this.deps.db);
    // Boxes kept back for bookings about to start are not the queue's to lend.
    if (free.length <= bookingsDue(this.deps.db, now, bookingLimits(this.deps.db).protectMinutes)) return;
    const server = free.find((s) => !this.refusedUntil.has(s.id));
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/bookingHolds.test.ts tests/practiceLeases.test.ts tests/serverPool.test.ts tests/sideGamesTable.test.ts tests/sideGames.test.ts tests/serverHoldGuard.test.ts`
Expected: PASS. If another test asserts the old "Never mind" or `END_SAY` text, grep for it (`grep -rn "Never mind\|a PUG needs this server" tests`) and update it to the new words.

- [ ] **Step 5: Commit**

```bash
git add src/serverPool.ts src/practiceLeases.ts src/sideGames.ts tests/bookingHolds.test.ts tests/practiceLeases.test.ts
git commit -m "Bookings: keep idle boxes back for bookings due soon; practice preemption also serves a waiting booking"
```

---

### Task 4: Booking domain (every write and view)

**Files:**
- Create: `src/bookings/bookings.ts`
- Test: `tests/bookings.test.ts`

**Interfaces:**
- Consumes: Task 2 rules; `competitiveAccess` (`src/teams/access.ts`); `getTeam`, `roleOf`, `activeMembers` (`src/teams/teams.ts`); `inGoodStanding(db, steamid)` (`src/standing.ts`); `getPlayer` (`src/players.ts`); `getCampaignPool` (`src/settings.ts`); `campaignRegistry(db).get(slug)` (`src/campaignRegistry.ts`); `parseRules`, `rulesForKind`, `MatchRules` (`src/rulesets.ts`); `newLeasePassword` (`src/practiceLeases.ts`); `NOT_HELD_SQL` (`src/serverHolds.ts`); `getServer` (`src/serverPool.ts`).
- Produces (`src/bookings/bookings.ts`):
  - `type Side = 'a' | 'b'`, `type PersonRole = 'player' | 'ringer' | 'spectator'`
  - `interface BookingRow` (every `bookings` column), `interface SideRow`, `interface PersonRow`
  - `BOOKING_ERRORS` (key → `{ status, text }`), `type BookingError`, `type Result<T>`
  - Reads: `getBooking(db, id)`, `sidesOf(db, id): SideRow[]`, `sideRow(db, id, side)`, `peopleOf(db, id): PersonRow[]`, `acceptedPeople(db, id): PersonRow[]`, `isOpen(b: BookingRow): boolean`, `managesSide(db, s: SideRow, steamid): boolean`, `managedSides(db, id, steamid): Side[]`, `sideName(db, s: SideRow): string`, `openBookings(db): BookingRow[]` (ended_at null, oldest start first), `bookingRules(b: BookingRow): MatchRules | null`
  - Player writes: `createBooking`, `confirmBooking`, `declineBooking`, `addPerson`, `respondPerson`, `removePerson`, `cancelBooking`, `extendBooking`, `claimNoShow`, `endBooking`, with the argument shapes in Step 3
  - Runner writes: `holdBox(db, id, serverId, now): boolean`, `markSetup(db, id, now): number | null` (attempt number), `markReady(db, id, now): boolean`, `markActive(db, id, now): boolean`, `closeBooking(db, id, state: 'ended' | 'cancelled', reason: string, now, actor?: string | null): boolean`, `markReleased(db, id, now): void`, `recordPresence(db, id, present: Record<Side, number>, anyHuman: boolean, now): void`, `setReminded(db, id, which: 60 | 15, now): void`, `setWarned(db, id, minutes: number): void`, `expireUnconfirmed(db, now): number[]`
  - Views: `interface BookingView`, `bookingView(db, id, viewer: { steamid: string; staff: boolean }): BookingView | null`, `interface BookingSummary`, `myBookings(db, steamid): { open: BookingSummary[]; recent: BookingSummary[] }`

- [ ] **Step 1: Write the failing tests**

`tests/bookings.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { setSetting } from '../src/settings.js';
import { createTeam, invitePlayer, respondInvite, setRole, transferCaptain } from '../src/teams/teams.js';
import {
  addPerson, bookingView, cancelBooking, claimNoShow, closeBooking, confirmBooking, createBooking, declineBooking,
  endBooking, expireUnconfirmed, extendBooking, getBooking, holdBox, markActive, markReady, markReleased, markSetup,
  myBookings, peopleOf, recordPresence, removePerson, respondPerson, sideRow,
} from '../src/bookings/bookings.js';

const P = Array.from({ length: 14 }, (_, i) => `765611990000007${String(i).padStart(2, '0')}`);
const NOW = new Date('2026-10-01T12:00:00.000Z');
const START = '2026-10-02T20:00:00.000Z';
const MIN = 60_000;
const at = (iso: string, plusMin = 0) => new Date(Date.parse(iso) + plusMin * MIN);
let db: DB;
let servers: number[];

beforeEach(() => {
  db = openDb(':memory:');
  const ins = db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, ?, 'active')");
  P.forEach((id, i) => ins.run(id, `p${i}`));
  setSetting(db, 'competitive_enabled', 'everyone');
  setSetting(db, 'map_pool', JSON.stringify(['no_mercy', 'death_toll', 'dead_air', 'blood_harvest', 'crash_course']));
  servers = ['a', 'bb', 'ccc', 'dddd'].map((n) => {
    const id = addServer(db, { name: n, host: 'h', port: 27000 + n.length, rconPort: 1, rconPassword: 'x' });
    db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(id);
    return id;
  }); // 4 enabled, reserve 2: room for 2 bookings at once
});

const base = (over: Record<string, unknown> = {}) => ({
  by: P[0], opponent: { steamid: P[1] }, startsAt: START, minutes: 120, playlist: ['no_mercy', 'death_toll'], now: NOW, ...over,
});
const create = (over: Record<string, unknown> = {}) => {
  const r = createBooking(db, base(over) as Parameters<typeof createBooking>[1]);
  if (!r.ok) throw new Error(r.error);
  return r.value.id;
};
const team = (captain: string, name: string, tag: string, members: string[] = []) => {
  const t = createTeam(db, { creator: captain, name, tag, now: NOW });
  if (!t.ok) throw new Error(t.error);
  for (const m of members) {
    const inv = invitePlayer(db, { teamId: t.value.id, by: captain, target: m, now: NOW });
    if (!inv.ok) throw new Error(inv.error);
    respondInvite(db, { inviteId: inv.value.inviteId, steamid: m, accept: true, now: NOW });
  }
  return t.value.id;
};

describe('creating', () => {
  it('a pickup booking against a player: side a confirmed with its captain, side b invited', () => {
    const id = create();
    const b = getBooking(db, id)!;
    expect(b).toMatchObject({ state: 'scheduled', purpose: 'scrim', region: 'na', starts_at: START, ends_at: '2026-10-02T22:00:00.000Z', game_config: 'standard' });
    expect(JSON.parse(b.playlist_json)).toEqual(['no_mercy', 'death_toll']);
    expect(JSON.parse(b.rules_json).rated).toBe(false);
    expect(b.password).toMatch(/^[a-z0-9]{8}$/);
    expect(b.tv_password).not.toBe(b.password);
    expect(sideRow(db, id, 'a')).toMatchObject({ team_id: null, captain_steamid: P[0] });
    expect(sideRow(db, id, 'a')!.confirmed_at).not.toBeNull();
    expect(sideRow(db, id, 'b')).toMatchObject({ captain_steamid: P[1], confirmed_at: null });
    expect(peopleOf(db, id).map((p) => [p.side, p.steamid, p.status])).toEqual([['a', P[0], 'accepted'], ['b', P[1], 'invited']]);
  });

  it('refuses bad input with a reason', () => {
    const r = (over: Record<string, unknown>) => {
      const res = createBooking(db, base(over) as Parameters<typeof createBooking>[1]);
      return res.ok ? 'ok' : res.error;
    };
    expect(r({ startsAt: '2026-10-01T11:00:00.000Z' })).toBe('bad_time');
    expect(r({ startsAt: '2026-10-20T11:00:00.000Z' })).toBe('bad_time');
    expect(r({ startsAt: 'tomorrow' })).toBe('bad_time');
    expect(r({ minutes: 45 })).toBe('bad_length');
    expect(r({ minutes: 240 })).toBe('bad_length');
    expect(r({ playlist: [] })).toBe('bad_playlist');
    expect(r({ playlist: ['no_mercy', 'no_mercy'] })).toBe('bad_playlist');
    expect(r({ playlist: ['the_sacrifice'] })).toBe('bad_playlist'); // not in the pool
    expect(r({ playlist: ['no_mercy', 'death_toll', 'dead_air', 'blood_harvest', 'crash_course'] })).toBe('bad_playlist');
    expect(r({ opponent: { steamid: P[0] } })).toBe('bad_opponent');
    expect(r({ opponent: { steamid: '76561199999999999' } })).toBe('not_player');
    expect(r({ gameConfig: 'nope' })).toBe('bad_config');
    expect(r({ rulesetId: 999 })).toBe('bad_ruleset');
    setSetting(db, 'competitive_enabled', 'admins');
    expect(r({})).toBe('not_open');
  });

  it('only a captain or co-captain books for a team', () => {
    const t = team(P[0], 'Rats', 'RR', [P[2]]);
    expect(createBooking(db, base({ by: P[2], teamId: t }) as Parameters<typeof createBooking>[1])).toEqual({ ok: false, error: 'not_manager' });
    const id = create({ teamId: t });
    expect(peopleOf(db, id).filter((p) => p.side === 'a').map((p) => p.steamid).sort()).toEqual([P[0], P[2]].sort());
  });

  it('refuses a slot without capacity, and the allowance', () => {
    create({ opponent: { steamid: P[1] } });
    create({ by: P[2], opponent: { steamid: P[3] } });
    expect(createBooking(db, base({ by: P[4], opponent: { steamid: P[5] } }) as Parameters<typeof createBooking>[1]))
      .toEqual({ ok: false, error: 'no_capacity' });
    setSetting(db, 'booking_max_upcoming', '1');
    expect(createBooking(db, base({ startsAt: '2026-10-03T20:00:00.000Z' }) as Parameters<typeof createBooking>[1]))
      .toEqual({ ok: false, error: 'allowance' });
  });
});

describe('confirming', () => {
  it('the invited player confirms and becomes the pickup captain', () => {
    const id = create();
    expect(confirmBooking(db, { bookingId: id, by: P[2], now: NOW })).toEqual({ ok: false, error: 'not_manager' });
    expect(confirmBooking(db, { bookingId: id, by: P[1], now: NOW })).toEqual({ ok: true, value: null });
    expect(sideRow(db, id, 'b')!.confirmed_at).not.toBeNull();
    expect(peopleOf(db, id).find((p) => p.steamid === P[1])!.status).toBe('accepted');
    expect(confirmBooking(db, { bookingId: id, by: P[1], now: NOW })).toEqual({ ok: false, error: 'already_confirmed' });
  });

  it('a team side is confirmed by its captain or co-captain, and a player on both teams stays on side a', () => {
    const rats = team(P[0], 'Rats', 'RR', [P[2], P[4]]);
    const mice = team(P[1], 'Mice', 'MM', [P[3], P[4]]);
    setRole(db, { teamId: mice, by: P[1], target: P[3], role: 'cocaptain' });
    const id = create({ teamId: rats, opponent: { teamId: mice } });
    expect(confirmBooking(db, { bookingId: id, by: P[3], now: NOW }).ok).toBe(true);
    const b = peopleOf(db, id).filter((p) => p.side === 'b').map((p) => p.steamid).sort();
    expect(b).toEqual([P[1], P[3]].sort());
    expect(addPerson(db, { bookingId: id, by: P[1], side: 'b', steamid: P[4], role: 'player', now: NOW }))
      .toEqual({ ok: false, error: 'already_in' });
  });

  it('declining cancels the booking at once', () => {
    const id = create();
    expect(declineBooking(db, { bookingId: id, by: P[1], now: NOW }).ok).toBe(true);
    expect(getBooking(db, id)).toMatchObject({ state: 'cancelled', end_reason: 'declined', cancel_side: 'b' });
    expect(getBooking(db, id)!.ended_at).not.toBeNull();
  });

  it('an invite nobody confirms expires after 24 hours or 30 minutes before the start', () => {
    const late = create({ startsAt: '2026-10-01T13:00:00.000Z' });
    const early = create({ by: P[2], opponent: { steamid: P[3] }, startsAt: '2026-10-05T20:00:00.000Z' });
    expect(expireUnconfirmed(db, at('2026-10-01T12:20:00.000Z'))).toEqual([]);
    expect(expireUnconfirmed(db, at('2026-10-01T12:31:00.000Z'))).toEqual([late]);
    expect(expireUnconfirmed(db, at('2026-10-02T12:00:01.000Z'))).toEqual([early]);
    expect(getBooking(db, late)).toMatchObject({ state: 'cancelled', end_reason: 'unconfirmed' });
  });
});

describe('people', () => {
  it('a manager adds people; non-members are invited until they accept', () => {
    const id = create();
    expect(addPerson(db, { bookingId: id, by: P[0], side: 'a', steamid: P[5], role: 'ringer', now: NOW })).toEqual({ ok: true, value: { status: 'invited' } });
    expect(addPerson(db, { bookingId: id, by: P[5], side: 'a', steamid: P[6], role: 'player', now: NOW })).toEqual({ ok: false, error: 'not_manager' });
    expect(respondPerson(db, { bookingId: id, steamid: P[5], accept: true, now: NOW }).ok).toBe(true);
    expect(peopleOf(db, id).find((p) => p.steamid === P[5])).toMatchObject({ role: 'ringer', status: 'accepted' });
    expect(removePerson(db, { bookingId: id, by: P[0], steamid: P[0], now: NOW })).toEqual({ ok: false, error: 'is_captain' });
    expect(removePerson(db, { bookingId: id, by: P[5], steamid: P[5], now: NOW }).ok).toBe(true); // leaving
  });

  it('side b cannot add people before it confirms', () => {
    const id = create();
    expect(addPerson(db, { bookingId: id, by: P[1], side: 'b', steamid: P[5], role: 'player', now: NOW })).toEqual({ ok: false, error: 'wrong_state' });
  });

  it('a side holds at most 12 people', () => {
    const id = create();
    for (const sid of P.slice(2, 13)) addPerson(db, { bookingId: id, by: P[0], side: 'a', steamid: sid, role: 'player', now: NOW });
    expect(addPerson(db, { bookingId: id, by: P[0], side: 'a', steamid: P[13], role: 'player', now: NOW })).toEqual({ ok: false, error: 'side_full' });
  });
});

describe('cancel, extend, end, no-show', () => {
  it('rights follow the current team roles', () => {
    const rats = team(P[0], 'Rats', 'RR', [P[2]]);
    setRole(db, { teamId: rats, by: P[0], target: P[2], role: 'cocaptain' });
    const id = create({ teamId: rats });
    setRole(db, { teamId: rats, by: P[0], target: P[2], role: 'member' });
    expect(cancelBooking(db, { bookingId: id, by: P[2], now: NOW })).toEqual({ ok: false, error: 'not_manager' });
    transferCaptain(db, { teamId: rats, by: P[0], target: P[2] });
    expect(cancelBooking(db, { bookingId: id, by: P[2], reason: '  sorry  ', now: NOW }).ok).toBe(true);
    expect(getBooking(db, id)).toMatchObject({ state: 'cancelled', end_reason: 'cancelled', cancel_side: 'a', cancel_reason: 'sorry', cancelled_by: P[2] });
  });

  it('a cancel with a box leaves the release to the runner; staff cancels count against nobody', () => {
    const id = create();
    confirmBooking(db, { bookingId: id, by: P[1], now: NOW });
    expect(holdBox(db, id, servers[3], at(START, -15))).toBe(true);
    expect(cancelBooking(db, { bookingId: id, by: P[9], staff: true, now: at(START, -10) })).toEqual({ ok: true, value: { hadServer: true } });
    const b = getBooking(db, id)!;
    expect(b).toMatchObject({ state: 'cancelled', end_reason: 'staff', cancel_side: null, ended_at: null });
    expect(b.ending_at).not.toBeNull();
    markReleased(db, id, at(START, -9));
    expect(getBooking(db, id)!.ended_at).not.toBeNull();
  });

  it('extends only while the capacity rule holds for the extra time', () => {
    const id = create();
    create({ by: P[2], opponent: { steamid: P[3] }, startsAt: '2026-10-02T22:00:00.000Z' });
    create({ by: P[4], opponent: { steamid: P[5] }, startsAt: '2026-10-02T22:00:00.000Z' });
    expect(extendBooking(db, { bookingId: id, by: P[0], now: NOW })).toEqual({ ok: false, error: 'no_capacity' });
    setSetting(db, 'pug_reserve_servers', '1');
    expect(extendBooking(db, { bookingId: id, by: P[0], now: NOW })).toEqual({ ok: true, value: { endsAt: '2026-10-02T22:30:00.000Z' } });
    expect(getBooking(db, id)).toMatchObject({ extended_minutes: 30, warned_minutes: null });
  });

  it('a no-show is claimed only after the grace, by a side that showed, against one that did not', () => {
    const id = create();
    confirmBooking(db, { bookingId: id, by: P[1], now: NOW });
    holdBox(db, id, servers[3], at(START, -15));
    markSetup(db, id, at(START, -15));
    markReady(db, id, at(START, -12));
    markActive(db, id, at(START, -5));
    const claim = (min: number) => claimNoShow(db, { bookingId: id, by: P[0], now: at(START, min) });
    expect(claim(10)).toEqual({ ok: false, error: 'too_early' });
    expect(claim(16)).toEqual({ ok: false, error: 'not_shown' });
    recordPresence(db, id, { a: 4, b: 2 }, true, at(START, 1));
    recordPresence(db, id, { a: 3, b: 1 }, true, at(START, 2));
    expect(sideRow(db, id, 'a')!.peak_present).toBe(4);
    expect(claim(16)).toEqual({ ok: true, value: { absent: 'b' } });
    expect(getBooking(db, id)).toMatchObject({ state: 'no_show', end_reason: 'no_show' });
    expect(sideRow(db, id, 'b')!.no_show_at).not.toBeNull();
  });

  it('a captain ends a running booking; the runner closes and releases', () => {
    const id = create();
    confirmBooking(db, { bookingId: id, by: P[1], now: NOW });
    expect(endBooking(db, { bookingId: id, by: P[0], now: NOW })).toEqual({ ok: false, error: 'wrong_state' });
    holdBox(db, id, servers[3], at(START, -15));
    markSetup(db, id, at(START, -15));
    markReady(db, id, at(START, -12));
    expect(endBooking(db, { bookingId: id, by: P[1], now: at(START, 30) }).ok).toBe(true);
    expect(getBooking(db, id)).toMatchObject({ state: 'ended', end_reason: 'captain' });
    expect(closeBooking(db, id, 'ended', 'time', at(START, 31))).toBe(false); // already ending
  });
});

describe('runner writes', () => {
  it('holdBox takes only an idle, enabled box nobody holds', () => {
    const id = create();
    confirmBooking(db, { bookingId: id, by: P[1], now: NOW });
    db.prepare("UPDATE servers SET status = 'live' WHERE id = ?").run(servers[0]);
    expect(holdBox(db, id, servers[0], NOW)).toBe(false);
    expect(holdBox(db, id, servers[1], NOW)).toBe(true);
    expect(getBooking(db, id)).toMatchObject({ state: 'held', server_id: servers[1] });
    const other = create({ by: P[2], opponent: { steamid: P[3] } });
    confirmBooking(db, { bookingId: other, by: P[3], now: NOW });
    expect(holdBox(db, other, servers[1], NOW)).toBe(false);
  });

  it('markSetup counts attempts', () => {
    const id = create();
    confirmBooking(db, { bookingId: id, by: P[1], now: NOW });
    holdBox(db, id, servers[1], NOW);
    expect(markSetup(db, id, NOW)).toBe(1);
    expect(markSetup(db, id, NOW)).toBe(2);
  });
});

describe('views', () => {
  it('only the people in it, the side managers and staff can see a booking; connect only when ready', () => {
    const id = create();
    expect(bookingView(db, id, { steamid: P[9], staff: false })).toBeNull();
    const invited = bookingView(db, id, { steamid: P[1], staff: false })!;
    expect(invited.viewer).toEqual({ side: 'b', manages: ['b'], staff: false, invited: true });
    expect(invited.connect).toBeNull();
    confirmBooking(db, { bookingId: id, by: P[1], now: NOW });
    holdBox(db, id, servers[1], NOW);
    markSetup(db, id, NOW);
    markReady(db, id, NOW);
    const v = bookingView(db, id, { steamid: P[0], staff: false })!;
    expect(v.connect).toEqual({ host: 'h', port: 27002, password: getBooking(db, id)!.password });
    expect(JSON.stringify(v)).not.toContain(getBooking(db, id)!.tv_password);
    expect(bookingView(db, id, { steamid: P[9], staff: true })!.connect).not.toBeNull();
  });

  it('myBookings lists what needs the viewer', () => {
    const id = create();
    expect(myBookings(db, P[1]).open.map((b) => [b.id, b.needs])).toEqual([[id, 'confirm']]);
    expect(myBookings(db, P[0]).open.map((b) => b.needs)).toEqual([null]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/bookings.test.ts`
Expected: FAIL, cannot find module `../src/bookings/bookings.js`.

- [ ] **Step 3: Write `src/bookings/bookings.ts`**

```ts
import type { DB } from '../db.js';
import { getPlayer } from '../players.js';
import { inGoodStanding } from '../standing.js';
import { competitiveAccess } from '../teams/access.js';
import { activeMembers, getTeam, roleOf } from '../teams/teams.js';
import { getCampaignPool } from '../settings.js';
import { campaignRegistry } from '../campaignRegistry.js';
import { parseRules, rulesForKind, type MatchRules } from '../rulesets.js';
import { newLeasePassword } from '../practiceLeases.js';
import { NOT_HELD_SQL } from '../serverHolds.js';
import { getServer } from '../serverPool.js';
import {
  allowance, bookingLimits, capacityProblem, iso, upcomingCount, OPEN_STATES_SQL, PEOPLE_PER_SIDE, SHOWN_MIN, STEP_MINUTES,
  UNCONFIRMED_CUTOFF_MS, UNCONFIRMED_TTL_MS, type BookingLimits, type BookingState, type Party,
} from './rules.js';

/**
 * Every rule about server bookings (spec part 1 section 3; plan 4a). The
 * routes and the runner call these and nothing else writes the four booking
 * tables, so the surfaces cannot disagree about who may do what.
 *
 * Each write is one better-sqlite3 transaction that re-checks its rules
 * inside and writes a booking_events row, so two requests racing (two
 * confirms, a cancel during setup) cannot both get through.
 *
 * Rights follow CURRENT team roles: a team side is managed by whoever is
 * captain or co-captain of that team now, not by who made the booking. A
 * pickup side is managed by its captain_steamid.
 */

export type Side = 'a' | 'b';
export type PersonRole = 'player' | 'ringer' | 'spectator';
const ROLES: readonly PersonRole[] = ['player', 'ringer', 'spectator'];

export interface BookingRow {
  id: number; purpose: 'scrim' | 'tournament'; region: string; starts_at: string; ends_at: string; state: BookingState;
  server_id: number | null; password: string; tv_password: string; game_config: string; rules_json: string; playlist_json: string;
  extended_minutes: number; created_by: string; created_at: string; held_at: string | null; ready_at: string | null;
  setup_attempts: number; last_human_at: string | null; reminded_60_at: string | null; reminded_15_at: string | null;
  warned_minutes: number | null; ending_at: string | null; ended_at: string | null; end_reason: string | null;
  cancelled_by: string | null; cancel_side: Side | null; cancel_reason: string | null;
}
export interface SideRow {
  booking_id: number; side: Side; team_id: number | null; captain_steamid: string; confirmed_at: string | null;
  peak_present: number; no_show_at: string | null;
}
export interface PersonRow {
  booking_id: number; side: Side; steamid: string; role: PersonRole; status: 'invited' | 'accepted'; added_by: string; added_at: string;
}

export const BOOKING_ERRORS = {
  not_found: { status: 404, text: 'No such booking.' },
  not_open: { status: 409, text: 'That player cannot use scrims yet.' },
  not_player: { status: 400, text: 'That is not an active player.' },
  bad_time: { status: 400, text: 'Pick a start time in the future, inside the booking window.' },
  bad_length: { status: 400, text: 'That length is not one of the allowed booking lengths.' },
  bad_playlist: { status: 400, text: 'Pick campaigns from the map pool, each once, up to the limit.' },
  bad_ruleset: { status: 400, text: 'Pick one of the listed rule sets.' },
  bad_config: { status: 400, text: 'Pick one of the listed game configs.' },
  bad_opponent: { status: 400, text: 'Pick another team or player to play against.' },
  bad_side: { status: 400, text: 'A side is a or b.' },
  bad_role: { status: 400, text: 'A role is player, ringer or spectator.' },
  not_manager: { status: 403, text: 'Only a captain or co-captain of that side can do that.' },
  no_capacity: { status: 409, text: 'Not enough servers are free for that time. Try another slot.' },
  allowance: { status: 409, text: 'That side already has as many upcoming bookings as allowed.' },
  wrong_state: { status: 409, text: 'The booking is past that point.' },
  already_confirmed: { status: 409, text: 'Already confirmed.' },
  already_in: { status: 409, text: 'That player is already in this booking.' },
  side_full: { status: 409, text: 'That side is full.' },
  not_person: { status: 404, text: 'That player is not in this booking.' },
  no_invite: { status: 410, text: 'That invite is no longer open.' },
  is_captain: { status: 400, text: "A side's captain cannot be removed." },
  too_early: { status: 409, text: 'The other side still has time to arrive.' },
  not_shown: { status: 409, text: 'Your side has to be on the server first.' },
  they_showed: { status: 409, text: 'The other side is on the server.' },
} as const satisfies Record<string, { status: number; text: string }>;
export type BookingError = keyof typeof BOOKING_ERRORS;
export type Result<T> = { ok: true; value: T } | { ok: false; error: BookingError };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: BookingError): { ok: false; error: BookingError } => ({ ok: false, error });

// ---------- reads ----------

export function getBooking(db: DB, id: number): BookingRow | undefined {
  return db.prepare('SELECT * FROM bookings WHERE id = ?').get(id) as BookingRow | undefined;
}
export function sidesOf(db: DB, id: number): SideRow[] {
  return db.prepare('SELECT * FROM booking_sides WHERE booking_id = ? ORDER BY side').all(id) as SideRow[];
}
export function sideRow(db: DB, id: number, side: Side): SideRow | undefined {
  return db.prepare('SELECT * FROM booking_sides WHERE booking_id = ? AND side = ?').get(id, side) as SideRow | undefined;
}
export function peopleOf(db: DB, id: number): PersonRow[] {
  return db.prepare('SELECT * FROM booking_people WHERE booking_id = ? ORDER BY side, added_at, rowid').all(id) as PersonRow[];
}
export function acceptedPeople(db: DB, id: number): PersonRow[] {
  return peopleOf(db, id).filter((p) => p.status === 'accepted');
}
/** Still going: an open state and no end started. */
export function isOpen(b: BookingRow): boolean {
  return ['scheduled', 'held', 'setup', 'ready', 'active'].includes(b.state) && b.ending_at === null;
}
/** Every booking still holding something (capacity or a box), oldest start first. */
export function openBookings(db: DB): BookingRow[] {
  return db.prepare('SELECT * FROM bookings WHERE ended_at IS NULL ORDER BY starts_at, id').all() as BookingRow[];
}
export function managesSide(db: DB, s: SideRow, steamid: string): boolean {
  if (s.team_id !== null) {
    const r = roleOf(db, s.team_id, steamid);
    return r === 'captain' || r === 'cocaptain';
  }
  return s.captain_steamid === steamid;
}
export function managedSides(db: DB, id: number, steamid: string): Side[] {
  return sidesOf(db, id).filter((s) => managesSide(db, s, steamid)).map((s) => s.side);
}
export function sideName(db: DB, s: SideRow): string {
  if (s.team_id !== null) return getTeam(db, s.team_id)?.name ?? 'A team';
  return `${getPlayer(db, s.captain_steamid)?.name ?? 'Someone'}'s group`;
}
export function bookingRules(b: BookingRow): MatchRules | null {
  try { return parseRules(b.rules_json); } catch { return null; }
}

const canUse = (db: DB, steamid: string): boolean => competitiveAccess(db, steamid) && inGoodStanding(db, steamid);

function logEvent(db: DB, id: number, actor: string | null, event: string, detail: object, now: Date): void {
  db.prepare('INSERT INTO booking_events (booking_id, at, actor, event, detail) VALUES (?, ?, ?, ?, ?)')
    .run(id, now.toISOString(), actor, event, JSON.stringify(detail));
}
function insertPerson(db: DB, id: number, side: Side, steamid: string, role: PersonRole, status: 'invited' | 'accepted', by: string, now: Date): void {
  db.prepare(`INSERT OR IGNORE INTO booking_people (booking_id, side, steamid, role, status, added_by, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, side, steamid, role, status, by, now.toISOString());
}

// ---------- input parsing ----------

function parseStart(raw: unknown, nowMs: number, limits: BookingLimits): number | null {
  if (typeof raw !== 'string') return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return null;
  const start = Math.floor(t / 60_000) * 60_000;
  if (start <= nowMs || start > nowMs + limits.daysAhead * 86_400_000) return null;
  return start;
}
function parseMinutes(raw: unknown, limits: BookingLimits): number | null {
  const m = typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isInteger(m) || m % STEP_MINUTES !== 0 || m < limits.minMinutes || m > limits.maxMinutes) return null;
  return m;
}
function parsePlaylist(db: DB, raw: unknown, max: number): string[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > max) return null;
  const pool = new Set(getCampaignPool(db));
  const registry = campaignRegistry(db);
  const out: string[] = [];
  for (const c of raw) {
    if (typeof c !== 'string' || !pool.has(c) || !registry.get(c) || out.includes(c)) return null;
    out.push(c);
  }
  return out;
}
function pickRules(db: DB, raw: unknown): string | null {
  const row = (raw === undefined || raw === null
    ? db.prepare("SELECT rules_json FROM rulesets WHERE name = 'Casual Scrim' AND archived_at IS NULL").get()
    : Number.isInteger(raw)
      ? db.prepare('SELECT rules_json FROM rulesets WHERE id = ? AND archived_at IS NULL').get(raw)
      : undefined) as { rules_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.stringify(rulesForKind('scrim', parseRules(row.rules_json)));
  } catch {
    return null;
  }
}
function pickConfig(db: DB, raw: unknown): string | null {
  const key = raw === undefined || raw === null ? 'standard' : raw;
  if (typeof key !== 'string') return null;
  return db.prepare('SELECT 1 FROM game_configs WHERE key = ? AND enabled = 1').get(key) ? key : null;
}
type Opponent = { teamId: number } | { steamid: string };
function parseOpponent(raw: unknown): Opponent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (Number.isInteger(r.teamId)) return { teamId: r.teamId as number };
  if (typeof r.steamid === 'string' && /^\d{17}$/.test(r.steamid)) return { steamid: r.steamid };
  return null;
}
const partyOf = (s: Pick<SideRow, 'team_id' | 'captain_steamid'>): Party =>
  s.team_id !== null ? { teamId: s.team_id } : { captain: s.captain_steamid };

// ---------- player writes ----------

export function createBooking(db: DB, o: {
  by: string; teamId?: unknown; opponent: unknown; startsAt: unknown; minutes: unknown; playlist: unknown;
  rulesetId?: unknown; gameConfig?: unknown; now?: Date;
}): Result<{ id: number }> {
  const now = o.now ?? new Date();
  const nowMs = now.getTime();
  const limits = bookingLimits(db);
  if (!canUse(db, o.by)) return fail('not_open');
  const startMs = parseStart(o.startsAt, nowMs, limits);
  if (startMs === null) return fail('bad_time');
  const minutes = parseMinutes(o.minutes, limits);
  if (minutes === null) return fail('bad_length');
  const playlist = parsePlaylist(db, o.playlist, limits.playlistMax);
  if (!playlist) return fail('bad_playlist');
  const rules = pickRules(db, o.rulesetId);
  if (!rules) return fail('bad_ruleset');
  const config = pickConfig(db, o.gameConfig);
  if (!config) return fail('bad_config');
  const opp = parseOpponent(o.opponent);
  if (!opp) return fail('bad_opponent');
  const teamId = o.teamId === undefined || o.teamId === null ? null : o.teamId;
  if (teamId !== null && !Number.isInteger(teamId)) return fail('not_found');

  return db.transaction((): Result<{ id: number }> => {
    let region = 'na';
    let aCaptain = o.by;
    let aPeople = [o.by];
    if (teamId !== null) {
      const team = getTeam(db, teamId as number);
      if (!team || team.disbanded_at) return fail('not_found');
      const role = roleOf(db, team.id, o.by);
      if (role !== 'captain' && role !== 'cocaptain') return fail('not_manager');
      region = team.region;
      aCaptain = team.captain_steamid;
      aPeople = activeMembers(db, team.id).map((m) => m.steamid);
    }
    const aParty = partyOf({ team_id: teamId as number | null, captain_steamid: aCaptain });
    if (upcomingCount(db, aParty) >= allowance(db, aParty, nowMs)) return fail('allowance');

    let bTeam: number | null = null;
    let bCaptain: string;
    let bInvitee: string | null = null;
    if ('teamId' in opp) {
      const t = getTeam(db, opp.teamId);
      if (!t || t.disbanded_at || t.id === teamId) return fail('bad_opponent');
      if (!canUse(db, t.captain_steamid)) return fail('not_open');
      bTeam = t.id;
      bCaptain = t.captain_steamid;
    } else {
      const p = getPlayer(db, opp.steamid);
      if (!p || p.status !== 'active') return fail('not_player');
      if (aPeople.includes(opp.steamid)) return fail('bad_opponent');
      if (!canUse(db, opp.steamid)) return fail('not_open');
      bCaptain = opp.steamid;
      bInvitee = opp.steamid;
    }

    const endMs = startMs + minutes * 60_000;
    if (capacityProblem(db, { region, startMs, endMs }) !== null) return fail('no_capacity');
    const id = Number(db.prepare(
      `INSERT INTO bookings (purpose, region, starts_at, ends_at, password, tv_password, game_config, rules_json, playlist_json, created_by, created_at)
       VALUES ('scrim', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(region, iso(startMs), iso(endMs), newLeasePassword(), newLeasePassword(), config, rules, JSON.stringify(playlist), o.by, now.toISOString()).lastInsertRowid);
    const side = db.prepare('INSERT INTO booking_sides (booking_id, side, team_id, captain_steamid, confirmed_at) VALUES (?, ?, ?, ?, ?)');
    side.run(id, 'a', teamId, aCaptain, now.toISOString());
    side.run(id, 'b', bTeam, bCaptain, null);
    for (const sid of aPeople) insertPerson(db, id, 'a', sid, 'player', 'accepted', o.by, now);
    if (bInvitee) insertPerson(db, id, 'b', bInvitee, 'player', 'invited', o.by, now);
    logEvent(db, id, o.by, 'created', { minutes, playlist, opponent: opp }, now);
    return ok({ id });
  })();
}

export function confirmBooking(db: DB, o: { bookingId: number; by: string; now?: Date }): Result<null> {
  const now = o.now ?? new Date();
  return db.transaction((): Result<null> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    if (b.state !== 'scheduled' || b.ending_at !== null) return fail('wrong_state');
    const s = sideRow(db, b.id, 'b')!;
    if (s.confirmed_at !== null) return fail('already_confirmed');
    if (!managesSide(db, s, o.by)) return fail('not_manager');
    if (!canUse(db, o.by)) return fail('not_open');
    const party = partyOf(s);
    if (upcomingCount(db, party) >= allowance(db, party, now.getTime())) return fail('allowance');
    if (capacityProblem(db, { region: b.region, startMs: Date.parse(b.starts_at), endMs: Date.parse(b.ends_at), exceptId: b.id }) !== null) {
      return fail('no_capacity');
    }
    db.prepare("UPDATE booking_sides SET confirmed_at = ? WHERE booking_id = ? AND side = 'b'").run(now.toISOString(), b.id);
    if (s.team_id !== null) {
      // The team's current roster, minus anyone already on side a (a player
      // may be on both teams; they play for the side that booked).
      const onA = new Set(peopleOf(db, b.id).filter((p) => p.side === 'a').map((p) => p.steamid));
      for (const m of activeMembers(db, s.team_id)) if (!onA.has(m.steamid)) insertPerson(db, b.id, 'b', m.steamid, 'player', 'accepted', o.by, now);
    } else {
      db.prepare("UPDATE booking_people SET status = 'accepted' WHERE booking_id = ? AND steamid = ?").run(b.id, s.captain_steamid);
    }
    logEvent(db, b.id, o.by, 'confirmed', {}, now);
    return ok(null);
  })();
}

/** Close a booking: the terminal state, why, and the end started. With no box
 *  there is nothing to release, so ended_at is set too. False when it was
 *  already ending (another end got there first). */
function close(db: DB, id: number, state: 'ended' | 'cancelled' | 'no_show', reason: string, now: Date,
  extra: { cancelledBy?: string | null; cancelSide?: Side | null; cancelReason?: string | null } = {}): boolean {
  const t = now.toISOString();
  return db.prepare(
    `UPDATE bookings SET state = ?, end_reason = ?, ending_at = ?,
       ended_at = CASE WHEN server_id IS NULL THEN ? ELSE NULL END,
       cancelled_by = COALESCE(?, cancelled_by), cancel_side = COALESCE(?, cancel_side), cancel_reason = COALESCE(?, cancel_reason)
     WHERE id = ? AND ending_at IS NULL AND state IN ${OPEN_STATES_SQL}`,
  ).run(state, reason, t, t, extra.cancelledBy ?? null, extra.cancelSide ?? null, extra.cancelReason ?? null, id).changes > 0;
}

export function declineBooking(db: DB, o: { bookingId: number; by: string; now?: Date }): Result<null> {
  const now = o.now ?? new Date();
  return db.transaction((): Result<null> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    const s = sideRow(db, b.id, 'b')!;
    if (b.state !== 'scheduled' || b.ending_at !== null || s.confirmed_at !== null) return fail('wrong_state');
    if (!managesSide(db, s, o.by)) return fail('not_manager');
    close(db, b.id, 'cancelled', 'declined', now, { cancelledBy: o.by, cancelSide: 'b' });
    logEvent(db, b.id, o.by, 'declined', {}, now);
    return ok(null);
  })();
}

export function addPerson(db: DB, o: {
  bookingId: number; by: string; side: unknown; steamid: unknown; role: unknown; staff?: boolean; now?: Date;
}): Result<{ status: 'invited' | 'accepted' }> {
  const now = o.now ?? new Date();
  if (o.side !== 'a' && o.side !== 'b') return fail('bad_side');
  if (typeof o.role !== 'string' || !ROLES.includes(o.role as PersonRole)) return fail('bad_role');
  if (typeof o.steamid !== 'string' || !/^\d{17}$/.test(o.steamid)) return fail('not_player');
  const side = o.side;
  const role = o.role as PersonRole;
  const steamid = o.steamid;
  return db.transaction((): Result<{ status: 'invited' | 'accepted' }> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    if (!isOpen(b)) return fail('wrong_state');
    const s = sideRow(db, b.id, side)!;
    if (!o.staff && !managesSide(db, s, o.by)) return fail('not_manager');
    if (s.confirmed_at === null) return fail('wrong_state');
    const p = getPlayer(db, steamid);
    if (!p || p.status !== 'active') return fail('not_player');
    if (!canUse(db, steamid)) return fail('not_open');
    if (db.prepare('SELECT 1 FROM booking_people WHERE booking_id = ? AND steamid = ?').get(b.id, steamid)) return fail('already_in');
    const count = (db.prepare('SELECT COUNT(*) AS n FROM booking_people WHERE booking_id = ? AND side = ?').get(b.id, side) as { n: number }).n;
    if (count >= PEOPLE_PER_SIDE) return fail('side_full');
    const status = s.team_id !== null && roleOf(db, s.team_id, steamid) !== null ? 'accepted' : 'invited';
    insertPerson(db, b.id, side, steamid, role, status, o.by, now);
    logEvent(db, b.id, o.by, 'person_added', { steamid, side, role, status }, now);
    return ok({ status });
  })();
}

export function respondPerson(db: DB, o: { bookingId: number; steamid: string; accept: boolean; now?: Date }): Result<null> {
  const now = o.now ?? new Date();
  return db.transaction((): Result<null> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    if (!isOpen(b)) return fail('wrong_state');
    const row = db.prepare("SELECT * FROM booking_people WHERE booking_id = ? AND steamid = ? AND status = 'invited'").get(b.id, o.steamid) as PersonRow | undefined;
    if (!row) return fail('no_invite');
    // Side b's invited captain answers through confirm/decline, not here.
    const s = sideRow(db, b.id, row.side)!;
    if (s.confirmed_at === null) return fail('wrong_state');
    if (o.accept) db.prepare("UPDATE booking_people SET status = 'accepted' WHERE booking_id = ? AND steamid = ?").run(b.id, o.steamid);
    else db.prepare('DELETE FROM booking_people WHERE booking_id = ? AND steamid = ?').run(b.id, o.steamid);
    logEvent(db, b.id, o.steamid, o.accept ? 'person_accepted' : 'person_declined', {}, now);
    return ok(null);
  })();
}

export function removePerson(db: DB, o: { bookingId: number; by: string; steamid: string; staff?: boolean; now?: Date }): Result<null> {
  const now = o.now ?? new Date();
  return db.transaction((): Result<null> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    if (!isOpen(b)) return fail('wrong_state');
    const row = db.prepare('SELECT * FROM booking_people WHERE booking_id = ? AND steamid = ?').get(b.id, o.steamid) as PersonRow | undefined;
    if (!row) return fail('not_person');
    const s = sideRow(db, b.id, row.side)!;
    if (s.captain_steamid === o.steamid) return fail('is_captain');
    if (!o.staff && o.by !== o.steamid && !managesSide(db, s, o.by)) return fail('not_manager');
    db.prepare('DELETE FROM booking_people WHERE booking_id = ? AND steamid = ?').run(b.id, o.steamid);
    logEvent(db, b.id, o.by, o.by === o.steamid ? 'person_left' : 'person_removed', { steamid: o.steamid }, now);
    return ok(null);
  })();
}

export function cancelBooking(db: DB, o: { bookingId: number; by: string; staff?: boolean; reason?: unknown; now?: Date }): Result<{ hadServer: boolean }> {
  const now = o.now ?? new Date();
  const reason = typeof o.reason === 'string' && o.reason.trim() ? o.reason.trim().slice(0, 300) : null;
  return db.transaction((): Result<{ hadServer: boolean }> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    if (!isOpen(b)) return fail('wrong_state');
    const mine = managedSides(db, b.id, o.by);
    if (!o.staff && mine.length === 0) return fail('not_manager');
    // Staff cancels belong to no side (scrim spec 3a: never counted against anyone).
    const side = o.staff ? null : mine[0];
    close(db, b.id, 'cancelled', o.staff ? 'staff' : 'cancelled', now, { cancelledBy: o.by, cancelSide: side, cancelReason: reason });
    logEvent(db, b.id, o.by, 'cancelled', { side, reason, staff: !!o.staff }, now);
    return ok({ hadServer: b.server_id !== null });
  })();
}

export function extendBooking(db: DB, o: { bookingId: number; by: string; staff?: boolean; now?: Date }): Result<{ endsAt: string }> {
  const now = o.now ?? new Date();
  return db.transaction((): Result<{ endsAt: string }> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    if (!isOpen(b)) return fail('wrong_state');
    if (!o.staff && managedSides(db, b.id, o.by).length === 0) return fail('not_manager');
    const ext = bookingLimits(db).extendMinutes;
    const from = Date.parse(b.ends_at);
    if (capacityProblem(db, { region: b.region, startMs: from, endMs: from + ext * 60_000, exceptId: b.id }) !== null) return fail('no_capacity');
    const endsAt = iso(from + ext * 60_000);
    db.prepare('UPDATE bookings SET ends_at = ?, extended_minutes = extended_minutes + ?, warned_minutes = NULL WHERE id = ?').run(endsAt, ext, b.id);
    logEvent(db, b.id, o.by, 'extended', { minutes: ext, endsAt, staff: !!o.staff }, now);
    return ok({ endsAt });
  })();
}

export function claimNoShow(db: DB, o: { bookingId: number; by: string; now?: Date }): Result<{ absent: Side }> {
  const now = o.now ?? new Date();
  return db.transaction((): Result<{ absent: Side }> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    if ((b.state !== 'ready' && b.state !== 'active') || b.ending_at !== null) return fail('wrong_state');
    const mine = managedSides(db, b.id, o.by)[0];
    if (!mine) return fail('not_manager');
    const absent: Side = mine === 'a' ? 'b' : 'a';
    const grace = bookingRules(b)?.noShowGraceMinutes ?? 15;
    if (now.getTime() < Date.parse(b.starts_at) + grace * 60_000) return fail('too_early');
    if (sideRow(db, b.id, mine)!.peak_present < SHOWN_MIN) return fail('not_shown');
    if (sideRow(db, b.id, absent)!.peak_present >= SHOWN_MIN) return fail('they_showed');
    db.prepare('UPDATE booking_sides SET no_show_at = ? WHERE booking_id = ? AND side = ?').run(now.toISOString(), b.id, absent);
    close(db, b.id, 'no_show', 'no_show', now);
    logEvent(db, b.id, o.by, 'no_show', { absent }, now);
    return ok({ absent });
  })();
}

export function endBooking(db: DB, o: { bookingId: number; by: string; staff?: boolean; now?: Date }): Result<null> {
  const now = o.now ?? new Date();
  return db.transaction((): Result<null> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    if ((b.state !== 'ready' && b.state !== 'active') || b.ending_at !== null) return fail('wrong_state');
    if (!o.staff && managedSides(db, b.id, o.by).length === 0) return fail('not_manager');
    close(db, b.id, 'ended', o.staff ? 'staff' : 'captain', now);
    logEvent(db, b.id, o.by, 'ended', { staff: !!o.staff }, now);
    return ok(null);
  })();
}

// ---------- runner writes ----------

/** Take this box for the booking: only an idle, enabled box nothing holds,
 *  and only while the booking is scheduled with no box. The check and the
 *  write are one statement, so a claimIdle in between cannot race it. */
export function holdBox(db: DB, id: number, serverId: number, now: Date): boolean {
  return db.transaction(() => {
    const changed = db.prepare(
      `UPDATE bookings SET server_id = ?, state = 'held', held_at = ?
        WHERE id = ? AND state = 'scheduled' AND server_id IS NULL AND ending_at IS NULL
          AND ? IN (SELECT id FROM servers WHERE status = 'idle' AND enabled = 1 AND ${NOT_HELD_SQL})`,
    ).run(serverId, now.toISOString(), id, serverId).changes > 0;
    if (changed) logEvent(db, id, null, 'held', { serverId }, now);
    return changed;
  })();
}

/** Start (or restart) setup; the attempt number, or null when the booking is
 *  not held or ending. */
export function markSetup(db: DB, id: number, now: Date): number | null {
  return db.transaction(() => {
    const changed = db.prepare(
      "UPDATE bookings SET state = 'setup', setup_attempts = setup_attempts + 1 WHERE id = ? AND state IN ('held','setup') AND ending_at IS NULL",
    ).run(id).changes > 0;
    if (!changed) return null;
    const n = (db.prepare('SELECT setup_attempts AS n FROM bookings WHERE id = ?').get(id) as { n: number }).n;
    logEvent(db, id, null, 'setup_started', { attempt: n }, now);
    return n;
  })();
}

export function markReady(db: DB, id: number, now: Date): boolean {
  return db.transaction(() => {
    const changed = db.prepare("UPDATE bookings SET state = 'ready', ready_at = ? WHERE id = ? AND state = 'setup' AND ending_at IS NULL")
      .run(now.toISOString(), id).changes > 0;
    if (changed) logEvent(db, id, null, 'ready', {}, now);
    return changed;
  })();
}

export function markActive(db: DB, id: number, now: Date): boolean {
  return db.transaction(() => {
    const changed = db.prepare("UPDATE bookings SET state = 'active' WHERE id = ? AND state = 'ready' AND ending_at IS NULL").run(id).changes > 0;
    if (changed) logEvent(db, id, null, 'active', {}, now);
    return changed;
  })();
}

/** The runner's own ends: time, idle, setup_failed, unconfirmed. */
export function closeBooking(db: DB, id: number, state: 'ended' | 'cancelled', reason: string, now: Date, actor: string | null = null): boolean {
  return db.transaction(() => {
    const changed = close(db, id, state, reason, now);
    if (changed) logEvent(db, id, actor, state === 'ended' ? 'ended' : 'cancelled', { reason }, now);
    return changed;
  })();
}

/** The box is back in the pool (or there was none): the booking holds nothing. */
export function markReleased(db: DB, id: number, now: Date): void {
  db.transaction(() => {
    if (db.prepare('UPDATE bookings SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(now.toISOString(), id).changes > 0) {
      logEvent(db, id, null, 'released', {}, now);
    }
  })();
}

/** One look at who is on the box: each side's count of its people present,
 *  kept as a running peak, and when anyone was last there. */
export function recordPresence(db: DB, id: number, present: Record<Side, number>, anyHuman: boolean, now: Date): void {
  db.transaction(() => {
    const peak = db.prepare('UPDATE booking_sides SET peak_present = MAX(peak_present, ?) WHERE booking_id = ? AND side = ?');
    peak.run(present.a, id, 'a');
    peak.run(present.b, id, 'b');
    if (anyHuman) db.prepare('UPDATE bookings SET last_human_at = ? WHERE id = ?').run(now.toISOString(), id);
  })();
}

export function setReminded(db: DB, id: number, which: 60 | 15, now: Date): void {
  db.prepare(`UPDATE bookings SET reminded_${which}_at = ? WHERE id = ?`).run(now.toISOString(), id);
}

export function setWarned(db: DB, id: number, minutes: number): void {
  db.prepare('UPDATE bookings SET warned_minutes = ? WHERE id = ?').run(minutes, id);
}

/** Invites nobody confirmed in time (rules.ts UNCONFIRMED_*), cancelled. */
export function expireUnconfirmed(db: DB, now: Date): number[] {
  const nowMs = now.getTime();
  const rows = db.prepare(
    `SELECT b.id, b.created_at, b.starts_at FROM bookings b JOIN booking_sides s ON s.booking_id = b.id AND s.side = 'b'
      WHERE b.state = 'scheduled' AND b.ending_at IS NULL AND s.confirmed_at IS NULL ORDER BY b.id`,
  ).all() as { id: number; created_at: string; starts_at: string }[];
  const out: number[] = [];
  for (const r of rows) {
    if (Date.parse(r.created_at) + UNCONFIRMED_TTL_MS <= nowMs || Date.parse(r.starts_at) - UNCONFIRMED_CUTOFF_MS <= nowMs) {
      if (closeBooking(db, r.id, 'cancelled', 'unconfirmed', now)) out.push(r.id);
    }
  }
  return out;
}

// ---------- views ----------

export interface BookingPersonView { steamid: string; name: string; avatar: string | null; role: PersonRole; status: 'invited' | 'accepted' }
export interface BookingSideView {
  side: Side; name: string; team: { id: number; slug: string; name: string; tag: string; logoKey: string | null } | null;
  captain: { steamid: string; name: string }; confirmed: boolean; peakPresent: number; noShow: boolean; people: BookingPersonView[];
}
export interface BookingView {
  id: number; purpose: 'scrim' | 'tournament'; state: BookingState; ending: boolean; startsAt: string; endsAt: string;
  extendedMinutes: number; extendMinutes: number; createdAt: string; playlist: { slug: string; name: string }[]; rules: MatchRules | null;
  gameConfig: { key: string; label: string }; sides: BookingSideView[]; server: { name: string } | null;
  connect: { host: string; port: number; password: string } | null;
  cancel: { side: Side | null; reason: string | null } | null; endReason: string | null;
  noShowFrom: string;
  viewer: { side: Side | null; manages: Side[]; staff: boolean; invited: boolean };
}

export function bookingView(db: DB, id: number, viewer: { steamid: string; staff: boolean }): BookingView | null {
  const b = getBooking(db, id);
  if (!b) return null;
  const people = peopleOf(db, id);
  const me = people.find((p) => p.steamid === viewer.steamid);
  const manages = managedSides(db, id, viewer.steamid);
  if (!me && manages.length === 0 && !viewer.staff) return null;
  const registry = campaignRegistry(db);
  const server = b.server_id !== null ? getServer(db, b.server_id) : undefined;
  const running = (b.state === 'ready' || b.state === 'active') && b.ending_at === null;
  const canConnect = viewer.staff || me?.status === 'accepted';
  const config = db.prepare('SELECT key, label FROM game_configs WHERE key = ?').get(b.game_config) as { key: string; label: string } | undefined;
  const rules = bookingRules(b);
  return {
    id: b.id, purpose: b.purpose, state: b.state, ending: b.ending_at !== null, startsAt: b.starts_at, endsAt: b.ends_at,
    extendedMinutes: b.extended_minutes, extendMinutes: bookingLimits(db).extendMinutes, createdAt: b.created_at,
    playlist: (JSON.parse(b.playlist_json) as string[]).map((slug) => ({ slug, name: registry.get(slug)?.name ?? slug })),
    rules, gameConfig: config ?? { key: b.game_config, label: b.game_config },
    sides: sidesOf(db, id).map((s) => {
      const t = s.team_id !== null ? getTeam(db, s.team_id) : undefined;
      return {
        side: s.side, name: sideName(db, s),
        team: t ? { id: t.id, slug: t.slug, name: t.name, tag: t.tag, logoKey: t.logo_key } : null,
        captain: { steamid: s.captain_steamid, name: getPlayer(db, s.captain_steamid)?.name ?? s.captain_steamid },
        confirmed: s.confirmed_at !== null, peakPresent: s.peak_present, noShow: s.no_show_at !== null,
        people: people.filter((p) => p.side === s.side).map((p) => {
          const pl = getPlayer(db, p.steamid);
          return { steamid: p.steamid, name: pl?.name ?? p.steamid, avatar: pl?.avatar ?? null, role: p.role, status: p.status };
        }),
      };
    }),
    server: server ? { name: server.name } : null,
    connect: running && canConnect && server ? { host: server.host, port: server.port, password: b.password } : null,
    cancel: b.state === 'cancelled' ? { side: b.cancel_side, reason: b.cancel_reason } : null,
    endReason: b.end_reason,
    noShowFrom: iso(Date.parse(b.starts_at) + (rules?.noShowGraceMinutes ?? 15) * 60_000),
    viewer: { side: me?.side ?? manages[0] ?? null, manages, staff: viewer.staff, invited: me?.status === 'invited' },
  };
}

export interface BookingSummary {
  id: number; state: BookingState; ending: boolean; startsAt: string; endsAt: string; aName: string; bName: string;
  mySide: Side | null; needs: 'confirm' | 'accept' | null;
}

/** The bookings this player is in or manages a side of: still open, and the
 *  last ten finished. */
export function myBookings(db: DB, steamid: string): { open: BookingSummary[]; recent: BookingSummary[] } {
  const ids = (db.prepare(
    `SELECT booking_id AS id FROM booking_people WHERE steamid = ?
     UNION SELECT booking_id FROM booking_sides WHERE team_id IS NULL AND captain_steamid = ?
     UNION SELECT s.booking_id FROM booking_sides s JOIN team_members m ON m.team_id = s.team_id
       WHERE m.steamid = ? AND m.left_at IS NULL AND m.role IN ('captain','cocaptain')`,
  ).all(steamid, steamid, steamid) as { id: number }[]).map((r) => r.id);
  const rows = ids.map((id) => getBooking(db, id)!).sort((x, y) => x.starts_at.localeCompare(y.starts_at));
  const summary = (b: BookingRow): BookingSummary => {
    const [a, bSide] = sidesOf(db, b.id);
    const me = db.prepare('SELECT side, status FROM booking_people WHERE booking_id = ? AND steamid = ?').get(b.id, steamid) as { side: Side; status: string } | undefined;
    const manages = managedSides(db, b.id, steamid);
    const needs = isOpen(b) && bSide.confirmed_at === null && manages.includes('b') ? 'confirm'
      : isOpen(b) && me?.status === 'invited' && bSide.confirmed_at !== null ? 'accept' : null;
    return {
      id: b.id, state: b.state, ending: b.ending_at !== null, startsAt: b.starts_at, endsAt: b.ends_at,
      aName: sideName(db, a), bName: sideName(db, bSide), mySide: me?.side ?? manages[0] ?? null, needs,
    };
  };
  return {
    open: rows.filter((b) => b.ending_at === null).map(summary),
    recent: rows.filter((b) => b.ending_at !== null).reverse().slice(0, 10).map(summary),
  };
}
```

`respondPerson` is for people a side added. The invited pickup captain of side b answers through `confirmBooking` / `declineBooking`; `myBookings` reports that case as `needs: 'confirm'` because `managesSide` is true for them.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run tests/bookings.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/bookings/bookings.ts tests/bookings.test.ts
git commit -m "Bookings: create, confirm, people, cancel, extend, no-show, end, runner state writes and views, each one transaction with an audit row"
```

---
### Task 5: Notifications module and booking messages

**Files:**
- Create: `src/notify/notify.ts`
- Create: `src/bookings/messages.ts`
- Test: `tests/notify.test.ts`

**Interfaces:**
- Consumes: `DmFn` (`src/signonDropNotify.ts`), `MessagePayload` (`src/discord/transport.ts`), `escapeName` (`src/identity.ts`), Task 4 reads.
- Produces (`src/notify/notify.ts`):
  - `type NotifyType = 'booking_invite' | 'booking_confirmed' | 'booking_starting' | 'booking_ready' | 'booking_cancelled' | 'booking_no_show'`
  - `NOTIFY_TYPES: readonly { type: NotifyType; label: string }[]`, `isNotifyType(v: unknown): v is NotifyType`
  - `wants(db, steamid, type): boolean`, `prefsOf(db, steamid): { type: NotifyType; label: string; enabled: boolean }[]`, `setPref(db, steamid, type: NotifyType, enabled: boolean): void`
  - `class Notifier { constructor(deps: { db: DB; dm: () => DmFn | null }); send(steamids: Iterable<string>, type: NotifyType, payload: MessagePayload): number }`
- Produces (`src/bookings/messages.ts`): `whenUtc(iso: string): string`, `bookingMessage(db, publicUrl: string, bookingId: number, type: NotifyType, extra?: { minutes?: number; reason?: string | null; addedBy?: string }): MessagePayload | null`

- [ ] **Step 1: Write the failing tests**

`tests/notify.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { setSetting } from '../src/settings.js';
import { Notifier, prefsOf, setPref, wants, NOTIFY_TYPES } from '../src/notify/notify.js';
import { bookingMessage, whenUtc } from '../src/bookings/messages.js';
import { confirmBooking, createBooking, holdBox, markReady, markSetup } from '../src/bookings/bookings.js';
import type { MessagePayload } from '../src/discord/transport.js';

const A = '76561199000000801';
const B = '76561199000000802';
const C = '76561199000000803';
let db: DB;
let sent: { to: string; payload: MessagePayload }[];
beforeEach(() => {
  db = openDb(':memory:');
  const ins = db.prepare("INSERT INTO players (steamid, name, status, discord_id) VALUES (?, ?, 'active', ?)");
  ins.run(A, 'Alpha*', 'd-a');
  ins.run(B, 'Bravo', 'd-b');
  ins.run(C, 'Charlie', null);
  sent = [];
});
const notifier = (dm: ((to: string, p: MessagePayload) => Promise<void>) | null = async (to, payload) => { sent.push({ to, payload }); }) =>
  new Notifier({ db, dm: () => dm });

describe('preferences', () => {
  it('every type is on until turned off', () => {
    expect(wants(db, A, 'booking_ready')).toBe(true);
    setPref(db, A, 'booking_ready', false);
    expect(wants(db, A, 'booking_ready')).toBe(false);
    setPref(db, A, 'booking_ready', true);
    expect(wants(db, A, 'booking_ready')).toBe(true);
    expect(prefsOf(db, A).map((p) => p.type)).toEqual(NOTIFY_TYPES.map((t) => t.type));
  });
});

describe('Notifier', () => {
  const payload: MessagePayload = { content: 'hi', embeds: [], components: [], mentionUserIds: [] };
  it('DMs each linked player who wants the type, once', async () => {
    setPref(db, B, 'booking_ready', false);
    expect(notifier().send([A, A, B, C], 'booking_ready', payload)).toBe(1);
    expect(sent.map((s) => s.to)).toEqual(['d-a']);
  });

  it('sends nothing while the bot is away, and a refused DM never throws', async () => {
    expect(notifier(null).send([A], 'booking_ready', payload)).toBe(0);
    expect(() => notifier(async () => { throw new Error('Cannot send messages to this user'); }).send([A], 'booking_ready', payload)).not.toThrow();
    await new Promise((r) => setImmediate(r));
  });
});

describe('booking messages', () => {
  beforeEach(() => {
    setSetting(db, 'competitive_enabled', 'everyone');
    setSetting(db, 'map_pool', JSON.stringify(['no_mercy']));
    for (const n of ['a', 'bb', 'ccc']) {
      const id = addServer(db, { name: n, host: '10.0.0.9', port: 27015 + n.length, rconPort: 1, rconPassword: 'x' });
      db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(id);
    }
  });
  const book = () => {
    const r = createBooking(db, { by: A, opponent: { steamid: B }, startsAt: '2026-10-02T20:00:00.000Z', minutes: 90, playlist: ['no_mercy'], now: new Date('2026-10-01T12:00:00.000Z') });
    if (!r.ok) throw new Error(r.error);
    return r.value.id;
  };

  it('names the sides, escaped, with the time in UTC and a link', () => {
    const id = book();
    const m = bookingMessage(db, 'https://riversidepug.com', id, 'booking_invite')!;
    expect(m.content).toContain('Alpha\\*');
    expect(m.content).toContain('2026-10-02 20:00 UTC');
    expect(m.components).toEqual([[{ kind: 'link', url: 'https://riversidepug.com/booking/' + id, label: 'Open the booking' }]]);
    expect(whenUtc('2026-10-02T20:00:00.000Z')).toBe('2026-10-02 20:00 UTC');
  });

  it('the ready message carries the connect line', () => {
    const id = book();
    confirmBooking(db, { bookingId: id, by: B });
    const now = new Date('2026-10-02T19:45:00.000Z');
    holdBox(db, id, 3, now);
    markSetup(db, id, now);
    markReady(db, id, now);
    const pw = (db.prepare('SELECT password FROM bookings WHERE id = ?').get(id) as { password: string }).password;
    expect(bookingMessage(db, 'https://x', id, 'booking_ready')!.content).toContain(`connect 10.0.0.9:27018; password ${pw}`);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/notify.test.ts`
Expected: FAIL, cannot find module `../src/notify/notify.js`.

- [ ] **Step 3: Write `src/notify/notify.ts`**

```ts
import type { DB } from '../db.js';
import type { MessagePayload } from '../discord/transport.js';
import type { DmFn } from '../signonDropNotify.js';
import { getPlayer } from '../players.js';

/**
 * Who gets told what (spec part 1 section 4, Notifications). For now one
 * channel, a Discord DM, sent only to players with Discord linked who have
 * not turned that type off; the site itself shows the same state on the
 * bookings pages. Specs 2-4 add their own types here.
 *
 * Sends are fire-and-forget: a player with DMs closed is logged and skipped,
 * and nothing a DM does can fail the request or tick that caused it.
 */
export type NotifyType =
  | 'booking_invite' | 'booking_confirmed' | 'booking_starting' | 'booking_ready' | 'booking_cancelled' | 'booking_no_show';

export const NOTIFY_TYPES: readonly { type: NotifyType; label: string }[] = [
  { type: 'booking_invite', label: 'Someone invites me to a booked server' },
  { type: 'booking_confirmed', label: 'The other side confirms my booking' },
  { type: 'booking_starting', label: 'A booking starts in 60 and in 15 minutes' },
  { type: 'booking_ready', label: 'My booked server is ready, with the connect line' },
  { type: 'booking_cancelled', label: 'A booking I am in is cancelled' },
  { type: 'booking_no_show', label: 'My side is recorded as a no-show' },
];

export function isNotifyType(v: unknown): v is NotifyType {
  return NOTIFY_TYPES.some((t) => t.type === v);
}

export function wants(db: DB, steamid: string, type: NotifyType): boolean {
  const row = db.prepare('SELECT enabled FROM notification_prefs WHERE steamid = ? AND type = ?').get(steamid, type) as { enabled: number } | undefined;
  return row ? row.enabled === 1 : true;
}

export function prefsOf(db: DB, steamid: string): { type: NotifyType; label: string; enabled: boolean }[] {
  return NOTIFY_TYPES.map((t) => ({ ...t, enabled: wants(db, steamid, t.type) }));
}

export function setPref(db: DB, steamid: string, type: NotifyType, enabled: boolean): void {
  db.prepare(`INSERT INTO notification_prefs (steamid, type, enabled) VALUES (?, ?, ?)
    ON CONFLICT (steamid, type) DO UPDATE SET enabled = excluded.enabled`).run(steamid, type, enabled ? 1 : 0);
}

export class Notifier {
  constructor(private readonly deps: { db: DB; dm: () => DmFn | null }) {}

  /** DM each of these players who wants `type` and has Discord linked.
   *  Returns how many DMs were started. Read per call: the bot logs in after
   *  the web starts. */
  send(steamids: Iterable<string>, type: NotifyType, payload: MessagePayload): number {
    const dm = this.deps.dm();
    if (!dm) return 0;
    let n = 0;
    for (const steamid of new Set(steamids)) {
      if (!wants(this.deps.db, steamid, type)) continue;
      const discordId = getPlayer(this.deps.db, steamid)?.discord_id;
      if (!discordId) continue;
      n++;
      void dm(discordId, payload).catch((err) => {
        console.warn(`[notify] ${type} DM to ${steamid} failed:`, err instanceof Error ? err.message : err);
      });
    }
    return n;
  }
}
```

- [ ] **Step 4: Write `src/bookings/messages.ts`**

```ts
import type { DB } from '../db.js';
import type { MessagePayload } from '../discord/transport.js';
import { escapeName } from '../identity.js';
import { getPlayer } from '../players.js';
import { getServer } from '../serverPool.js';
import type { NotifyType } from '../notify/notify.js';
import { getBooking, sideName, sidesOf } from './bookings.js';

/** "2026-10-02 20:00 UTC". DMs have no viewer time zone; the site shows local time. */
export const whenUtc = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** The DM for one booking notification, or null for a booking that is gone.
 *  Every player-chosen name goes through escapeName, as in teamButtons.ts. */
export function bookingMessage(
  db: DB, publicUrl: string, bookingId: number, type: NotifyType,
  extra: { minutes?: number; reason?: string | null; addedBy?: string } = {},
): MessagePayload | null {
  const b = getBooking(db, bookingId);
  if (!b) return null;
  const [a, bs] = sidesOf(db, b.id);
  const aName = escapeName(sideName(db, a));
  const vs = `**${aName}** vs **${escapeName(sideName(db, bs))}**`;
  const when = whenUtc(b.starts_at);
  const hours = (Date.parse(b.ends_at) - Date.parse(b.starts_at)) / 3_600_000;
  let content: string;
  switch (type) {
    case 'booking_invite':
      content = extra.addedBy
        ? `${escapeName(getPlayer(db, extra.addedBy)?.name ?? 'Someone')} added you to a booked server: ${vs}, ${when}. Accept it on the site to get the connect details.`
        : `${aName} wants a scrim: ${vs}, ${when}, ${hours} h. Confirm or decline it on the site.`;
      break;
    case 'booking_confirmed':
      content = `Your booking is confirmed: ${vs}, ${when}.`;
      break;
    case 'booking_starting':
      content = `${vs} starts in ${extra.minutes ?? 15} minutes (${when}).`;
      break;
    case 'booking_ready': {
      const s = b.server_id !== null ? getServer(db, b.server_id) : undefined;
      content = s
        ? `Your server for ${vs} is ready. In the game console:\n\`connect ${s.host}:${s.port}; password ${b.password}\``
        : `Your server for ${vs} is ready.`;
      break;
    }
    case 'booking_cancelled':
      content = `${vs} on ${when} is cancelled${extra.reason ? `: ${escapeName(extra.reason)}` : '.'}`;
      break;
    case 'booking_no_show':
      content = `Your side was recorded as a no-show for ${vs} on ${when}.`;
      break;
  }
  return {
    content,
    embeds: [],
    components: [[{ kind: 'link', url: `${publicUrl}/booking/${b.id}`, label: 'Open the booking' }]],
    mentionUserIds: [],
  };
}
```

- [ ] **Step 5: Run the tests and commit**

Run: `npx vitest run tests/notify.test.ts && npm run typecheck`
Expected: PASS. The invite case expects `Alpha\*`; if `escapeName` escapes markdown differently, change the expectation to what `escapeName('Alpha*')` returns rather than the code.

```bash
git add src/notify/notify.ts src/bookings/messages.ts tests/notify.test.ts
git commit -m "Notifications: per-type opt-outs and a DM notifier; booking messages"
```

---

### Task 6: `l4d_booking` plugin (passwords survive map changes)

**Files:**
- Create: `plugin/l4d_booking.sp`
- Create: `plugin/build-booking.sh`
- Modify: `plugin/README.md` (one paragraph)

**Interfaces:**
- Produces, on a box with the plugin: cvars `l4d_booking_version` (`1.0.0`), `l4d_booking_password`, `l4d_booking_tv_password` (both `FCVAR_PROTECTED`), `l4d_booking_notice`. While `l4d_booking_password` is non-empty, `sv_password` is set back to it after every map's configs, and on every change to the booking cvars. The same goes for `tv_password` (when its cvar is non-empty) and `l4d_ready_league_notice` (when the notice is non-empty). An srcds restart empties them all.

**Why:** `server.cfg` re-runs on every map change, `local.cfg` runs `exec secrets` (standing `sv_password`) and sets the standing `tv_password`. A password set over rcon lasts until the next map. `pug-match.sp` `OnConfigsExecuted` solves this for matches (see its comment at about line 3381); a booked server has no match until plan 4b.

- [ ] **Step 1: Write the plugin**

`plugin/l4d_booking.sp`:

```sourcepawn
/**
 * l4d_booking - keep a booked server's own passwords across map changes.
 *
 * The site (src/bookings/runner.ts) books a pool server for two sides and
 * gives it a private sv_password, a private SourceTV tv_password and a line
 * for the ready-up panel. server.cfg re-runs on every map change, local.cfg
 * runs from it and puts the box's standing sv_password (secrets.cfg) and
 * tv_password back, so a value set over rcon lasts one map. This plugin holds
 * the booking's values in its own cvars, which no cfg touches, and applies
 * them from OnConfigsExecuted, the one hook that runs after those files (the
 * same reason pug-match.sp re-asserts its match password there).
 *
 * Empty l4d_booking_password means "not booked": nothing is touched. Every
 * booking ends with an srcds restart, which empties the cvars again.
 *
 * Plan 4b grows this plugin (allowlist, captain commands).
 *
 * Build: ./build-booking.sh
 */
#pragma semicolon 1
#pragma newdecls required
#include <sourcemod>

#define PLUGIN_VERSION "1.0.0"

ConVar g_cvPassword;
ConVar g_cvTvPassword;
ConVar g_cvNotice;

public Plugin myinfo = {
	name = "L4D1 Booked Server",
	author = "Riverside",
	description = "Holds a booked server's private passwords across map changes.",
	version = PLUGIN_VERSION,
	url = "https://riversidepug.com",
};

public void OnPluginStart()
{
	CreateConVar("l4d_booking_version", PLUGIN_VERSION, "L4D1 Booked Server version", FCVAR_NOTIFY | FCVAR_DONTRECORD);
	g_cvPassword = CreateConVar("l4d_booking_password", "", "The booking's sv_password; empty when the box is not booked.", FCVAR_PROTECTED | FCVAR_DONTRECORD);
	g_cvTvPassword = CreateConVar("l4d_booking_tv_password", "", "The booking's SourceTV password.", FCVAR_PROTECTED | FCVAR_DONTRECORD);
	g_cvNotice = CreateConVar("l4d_booking_notice", "", "Ready-up panel line for the booking.", FCVAR_DONTRECORD);
	g_cvPassword.AddChangeHook(OnBookingCvarChanged);
	g_cvTvPassword.AddChangeHook(OnBookingCvarChanged);
	g_cvNotice.AddChangeHook(OnBookingCvarChanged);
}

public void OnConfigsExecuted()
{
	Apply();
}

public void OnBookingCvarChanged(ConVar cv, const char[] oldValue, const char[] newValue)
{
	Apply();
}

void Apply()
{
	char pw[64];
	g_cvPassword.GetString(pw, sizeof(pw));
	if (pw[0] == '\0') return;
	ConVar sv = FindConVar("sv_password");
	if (sv != null) sv.SetString(pw);

	char tv[64];
	g_cvTvPassword.GetString(tv, sizeof(tv));
	ConVar tvp = FindConVar("tv_password");
	if (tvp != null && tv[0] != '\0') tvp.SetString(tv);

	char notice[128];
	g_cvNotice.GetString(notice, sizeof(notice));
	ConVar league = FindConVar("l4d_ready_league_notice");
	if (league != null && notice[0] != '\0') league.SetString(notice);
}
```

`plugin/build-booking.sh` (then `chmod +x plugin/build-booking.sh`):

```bash
#!/usr/bin/env bash
# Local compile via wine + the Rotoblin tree's spcomp (SourcePawn 1.12).
# Absolute unix paths break spcomp under wine -> copy in, compile relative, copy out.
# Mirrors build-tvwatch.sh, but builds only l4d_booking (no includes of its own).
set -euo pipefail
cd "$(dirname "$0")"
SCRIPTING=${PUG_SCRIPTING:-/home/volence/l4d/Rotoblin-AZMod/SourceCode/scripting-az}
cp l4d_booking.sp "$SCRIPTING/l4d_booking.sp"
trap 'rm -f "$SCRIPTING/l4d_booking.sp"' EXIT
(cd "$SCRIPTING" && wine ./spcomp.exe l4d_booking.sp -o l4d_booking.smx -iinclude)
mv "$SCRIPTING/l4d_booking.smx" ./l4d_booking.smx
echo "built: $(pwd)/l4d_booking.smx"
```

In `plugin/README.md`, add a short section: "`l4d_booking` holds a booked server's private `sv_password`, `tv_password` and ready-up line across map changes (plan 4a). Build with `./build-booking.sh`. It must be loaded on every pool box before bookings are opened to anyone: setup refuses a box without `l4d_booking_version`."

- [ ] **Step 2: Build it**

Run: `plugin/build-booking.sh`
Expected: `built: .../plugin/l4d_booking.smx` with no errors or warnings.

- [ ] **Step 3: Check it on the local server**

The local server is shared (other sessions and the owner test there). First run `/home/volence/l4d1-ds/rcon-local.py status` and stop if any human is connected or another session is mid-test. Then:

```bash
cp plugin/l4d_booking.smx /home/volence/l4d1-ds/server/left4dead/addons/sourcemod/plugins/
R=/home/volence/l4d1-ds/rcon-local.py
$R "sm plugins load l4d_booking" "l4d_booking_version"
$R 'l4d_booking_tv_password "tvtest99"' 'l4d_booking_notice "Booked: A vs B until 23:00 UTC"' 'l4d_booking_password "booktest1"'
$R "sv_password" "tv_password" "l4d_ready_league_notice"
$R "changelevel l4d_vs_hospital02_subway"
sleep 20
$R "sv_password" "tv_password" "l4d_ready_league_notice"
```

Expected: after the changelevel, `sv_password` is `booktest1`, `tv_password` is `tvtest99`, and the notice is the booking line. A protected cvar may echo as `"sv_password" = "" ( def. "" ) ... FCVAR_PROTECTED`, hiding its value. If so, check the password by connecting a client with and without `password booktest1`, or compare `sv_password` on the console of the server (`/home/volence/l4d1-ds/server-live.log` shows console output). Then put the box back:

```bash
$R 'l4d_booking_password ""' 'l4d_booking_tv_password ""' 'l4d_booking_notice ""' "sm plugins unload l4d_booking"
rm /home/volence/l4d1-ds/server/left4dead/addons/sourcemod/plugins/l4d_booking.smx
$R "changelevel l4d_vs_hospital01_apartment"
```

and confirm `sv_password` is the standing one again after the changelevel. Record what was seen in the commit message.

- [ ] **Step 4: Commit**

```bash
git add plugin/l4d_booking.sp plugin/build-booking.sh plugin/README.md
git commit -m "l4d_booking 1.0.0: a booked server keeps its own sv_password, tv_password and ready-up line across map changes (checked on the local server)"
```

The `.smx` is not committed unless the repo commits the other built plugins (check `git ls-files plugin/*.smx`; `pug-match.smx` and `l4d_tvwatch.smx` are tracked, so add `plugin/l4d_booking.smx` too). Staging it onto the pool boxes needs the owner's go-ahead and is not part of this plan.

---

### Task 7: BookingRunner part 1: allocation, setup, end, wind-down, resume

**Files:**
- Create: `src/serverSetup.ts`
- Modify: `src/practiceLeases.ts` (use `src/serverSetup.ts`; keep the exported names working)
- Create: `src/bookings/runner.ts`
- Test: `tests/bookingRunner.test.ts`

**Interfaces:**
- Consumes: Task 4 runner writes and reads, Task 5 `Notifier` and `bookingMessage`, `isInstalledEverywhere(db, slug, [serverId])` (`src/campaignInstall.ts`), `firstMapOf(db, slug)` and `campaignRegistry` (`src/campaignRegistry.ts`), `isMapName` (`src/campaigns.ts`), `parseStatusMap(status)` (`src/practiceLeases.ts`), `publishAdminEvent` (`src/adminFeed.ts`), `NOT_HELD_SQL`.
- Produces (`src/serverSetup.ts`): `type BoxRcon = (server: ServerRow, commands: string[]) => Promise<string[]>`, `STARTUP_POLLS`, `STARTUP_POLL_MS`, `STARTUP_GRACE_MS`, `cvarValue(reply, name)`, `quoted(v)`, `consoleText(v, max)`, `waitForStartup(rcon, server, sleep): Promise<void>`.
- Produces (`src/bookings/runner.ts`):
  - `interface BookingRunnerDeps { db; rcon: BoxRcon; publicUrl: string; release(serverId): Promise<boolean>; restart(server): Promise<boolean>; notifier: Notifier; preempt(): void; sleep?; now? }`
  - constants `TICK_MS = 60_000`, `SETUP_TRIES = 2`, `CFG_TRIES = 3`, `SETUP_SETTLE_MS = 15_000`, `MAP_SETTLE_MS = 20_000`, `GOODBYE_MS = 3_000`, `WARN_AT_MINUTES = [30, 10, 5]`
  - `bookingLines(db, b: BookingRow): string[]`
  - `class BookingRunner` with `resume(): void`, `allocate(): void`, `pickBox(b: BookingRow): ServerRow | null`, `settle(id: number): void`, `tick(): Promise<void>` (Task 8 fills in the watch half), `onCreated(id)`, `onConfirmed(id)`, `onPersonAdded(id, steamid, by)`, `onCancelled(id, by: string | null, reason: string | null)`, `onNoShow(id, absent: Side)`, `idle(): Promise<void>` (tests: waits for background work)

- [ ] **Step 1: Move the shared setup helpers**

Create `src/serverSetup.ts`:

```ts
import type { ServerRow } from './serverPool.js';

/**
 * Box setup helpers shared by everything that borrows a pool server outside a
 * match: practice leases (src/practiceLeases.ts) and bookings
 * (src/bookings/runner.ts). Moved here unchanged from practiceLeases.ts.
 */

/** Runs these commands on one short connection and returns each reply. */
export type BoxRcon = (server: ServerRow, commands: string[]) => Promise<string[]>;

/**
 * A freshly restarted box answers rcon BEFORE its own startup has finished:
 * server.cfg runs server_startup.cfg, which ends in `exec rotoblin_pub.cfg`,
 * and that lands after the first rcon answer. A cfg exec'd in that gap was
 * overwritten by Pub VS (lease 3 on the local rig, 2026-09-28; the live boxes
 * boot the same way). So setup polls `l4d_game_type_name` until it reports
 * the startup config (it contains "Pub"), this many times this far apart,
 * then waits STARTUP_GRACE_MS more.
 */
export const STARTUP_POLLS = 10;
export const STARTUP_POLL_MS = 2_000;
export const STARTUP_GRACE_MS = 4_000;

/** A cvar's value from its console echo (`"name" = "value" ( def. ... )`),
 *  or null when the reply does not carry one (unknown cvar, dropped reply). */
export function cvarValue(reply: string | undefined, name: string): string | null {
  const m = new RegExp(`"${name}"\\s*=\\s*"([^"]*)"`).exec(reply ?? '');
  return m ? m[1] : null;
}

/** Quoted for the console: a URL carries `//`, which starts a comment
 *  unquoted. Quotes and line breaks are refused rather than escaped, since
 *  the Source console has no escape for either. */
export function quoted(v: string): string {
  if (/["\r\n;]/.test(v)) throw new Error(`refusing to send ${JSON.stringify(v)} to a game server console`);
  return `"${v}"`;
}

/** Free text (a team name) made safe for quoted(): printable ASCII only, no
 *  quote or semicolon, at most `max` characters. */
export function consoleText(v: string, max: number): string {
  return v.replace(/["\r\n;]/g, '').replace(/[^\x20-\x7e]/g, '?').slice(0, max);
}

/** Poll until the box's own startup config has run (see STARTUP_POLLS), or
 *  the polls run out, then give it STARTUP_GRACE_MS more. Never throws: a
 *  box that never says "Pub" may run a different startup cfg, and the verify
 *  step after this is what decides. */
export async function waitForStartup(rcon: BoxRcon, server: ServerRow, sleep: (ms: number) => Promise<void>): Promise<void> {
  for (let i = 0; i < STARTUP_POLLS; i++) {
    try {
      const [reply] = await rcon(server, ['l4d_game_type_name']);
      if ((cvarValue(reply, 'l4d_game_type_name') ?? '').includes('Pub')) break;
    } catch {
      // Still coming up; poll again.
    }
    await sleep(STARTUP_POLL_MS);
  }
  await sleep(STARTUP_GRACE_MS);
}
```

In `src/practiceLeases.ts`: delete the local `STARTUP_POLLS`, `STARTUP_POLL_MS`, `STARTUP_GRACE_MS` constants and their comment, `cvarValue`, `quoted`, and the `LeaseRcon` type. Then add:

```ts
import { cvarValue, quoted, waitForStartup, type BoxRcon } from './serverSetup.js';
export { STARTUP_POLLS, STARTUP_POLL_MS, STARTUP_GRACE_MS, cvarValue } from './serverSetup.js';
/** Runs these commands on one short connection and returns each reply. */
export type LeaseRcon = BoxRcon;
```

Replace the private `waitForStartup` method body with one line, `await waitForStartup(this.deps.rcon, server, (ms) => this.sleep(ms));`, or delete the method and call the function at its one call site.

Run: `npx vitest run tests/practiceLeases.test.ts tests/practiceLeaseRoutes.test.ts && npm run typecheck`
Expected: PASS. The move changes no behaviour.

- [ ] **Step 2: Write the failing runner tests**

`tests/bookingRunner.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer, type ServerRow } from '../src/serverPool.js';
import { setSetting } from '../src/settings.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { Notifier } from '../src/notify/notify.js';
import {
  addPerson, cancelBooking, confirmBooking, createBooking, getBooking, holdBox, markSetup, respondPerson, sideRow,
} from '../src/bookings/bookings.js';
import { BookingRunner, bookingLines } from '../src/bookings/runner.js';

const P = Array.from({ length: 10 }, (_, i) => `765611990000009${String(i).padStart(2, '0')}`);
const START = Date.parse('2026-10-02T20:00:00.000Z');
const MIN = 60_000;
const PUB = 'Rotoblin Pub VS';

let db: DB;
let now: number;
let sent: { server: string; cmds: string[] }[];
let box: Record<string, { type: string; plugin: boolean; map: string; humans: string[]; down: boolean; execs: number; failExec: number }>;
let released: number[];
let restarted: string[];
let dms: { to: string; content: string }[];
let preempts: number;
let runner: BookingRunner;

const status = (b: { map: string; humans: string[] }) => [
  'hostname: test', `map     : ${b.map} at: 0 x, 0 y, 0 z`, `players : ${b.humans.length} humans, 0 bots (31 max)`,
  '# userid name uniqueid connected ping loss state rate adr',
  ...b.humans.map((sid, i) => `#  ${i + 2} ${i + 1} "h${i}" ${steam2(sid)} 01:12 33 0 active 128000 10.0.0.${i}:27005`),
].join('\n');
/** SteamID64 -> STEAM_1:Y:Z, the form `status` prints. */
const steam2 = (sid: string) => { const n = BigInt(sid) - 76561197960265728n; return `STEAM_1:${n % 2n}:${n / 2n}`; };

function build(over: Partial<ConstructorParameters<typeof BookingRunner>[0]> = {}) {
  return new BookingRunner({
    db,
    publicUrl: 'https://riversidepug.com',
    rcon: async (server: ServerRow, cmds: string[]) => {
      const b = box[server.name];
      if (b.down) throw new Error('rcon connect timeout');
      sent.push({ server: server.name, cmds });
      return cmds.map((c) => {
        if (c === 'status') return status(b);
        if (c === 'l4d_game_type_name') return `"l4d_game_type_name" = "${b.type}" ( def. "" )`;
        if (c === 'l4d_booking_version') return b.plugin ? '"l4d_booking_version" = "1.0.0" ( def. "1.0.0" )' : 'Unknown command "l4d_booking_version"';
        if (c === 'exec pug_match') { b.execs++; if (b.failExec > 0) b.failExec--; else b.type = 'Rotoblin 4v4 PUG'; }
        const m = /^changelevel (\S+)$/.exec(c);
        if (m) b.map = m[1];
        return '';
      });
    },
    release: async (id) => { released.push(id); db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(id); return true; },
    restart: async (server) => { restarted.push(server.name); box[server.name].type = PUB; box[server.name].map = 'l4d_vs_hospital01_apartment'; return true; },
    notifier: new Notifier({ db, dm: () => async (to, p) => { dms.push({ to, content: p.content ?? '' }); } }),
    preempt: () => { preempts++; },
    sleep: async () => {},
    now: () => now,
    ...over,
  });
}

beforeEach(() => {
  db = openDb(':memory:');
  now = START - 2 * 24 * 60 * MIN;
  sent = []; released = []; restarted = []; dms = []; preempts = 0; box = {};
  const ins = db.prepare("INSERT INTO players (steamid, name, status, discord_id) VALUES (?, ?, 'active', ?)");
  P.forEach((id, i) => ins.run(id, `p${i}`, `d${i}`));
  setSetting(db, 'competitive_enabled', 'everyone');
  setSetting(db, 'map_pool', JSON.stringify(['no_mercy', 'death_toll', 'dead_center']));
  setSetting(db, 'pug_reserve_servers', '1');
  for (const n of ['a', 'bb', 'ccc']) {
    const id = addServer(db, { name: n, host: '10.0.0.1', port: 27014 + n.length, rconPort: 1, rconPassword: 'x' });
    db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(id);
    box[n] = { type: PUB, plugin: true, map: 'l4d_vs_hospital01_apartment', humans: [], down: false, execs: 0, failExec: 0 };
  }
  runner = build();
});

const book = (o: { playlist?: string[]; confirm?: boolean } = {}) => {
  const r = createBooking(db, {
    by: P[0], opponent: { steamid: P[1] }, startsAt: new Date(START).toISOString(), minutes: 120,
    playlist: o.playlist ?? ['no_mercy'], now: new Date(now),
  });
  if (!r.ok) throw new Error(r.error);
  if (o.confirm !== false) confirmBooking(db, { bookingId: r.value.id, by: P[1], now: new Date(now) });
  return r.value.id;
};

describe('allocation', () => {
  it('takes the highest-id idle box at the hold time, not before, and sets it up', async () => {
    const id = book();
    now = START - 16 * MIN;
    runner.allocate();
    expect(getBooking(db, id)!.state).toBe('scheduled');
    now = START - 15 * MIN;
    runner.allocate();
    await runner.idle();
    const b = getBooking(db, id)!;
    expect(b).toMatchObject({ state: 'ready', server_id: 3, setup_attempts: 1 });
    expect(restarted).toEqual(['ccc']);
    const cmds = sent.filter((s) => s.server === 'ccc').flatMap((s) => s.cmds);
    expect(cmds).toContain('exec pug_match');
    expect(cmds).toContain(`l4d_booking_password "${b.password}"`);
    expect(cmds).toContain(`l4d_booking_tv_password "${b.tv_password}"`);
    expect(cmds).toContain('changelevel l4d_vs_hospital01_apartment');
    expect(cmds.indexOf('exec pug_match')).toBeLessThan(cmds.indexOf('changelevel l4d_vs_hospital01_apartment'));
    // The connect line goes to the accepted people of both sides.
    expect(dms.filter((d) => d.content.includes(`password ${b.password}`)).map((d) => d.to).sort()).toEqual(['d0', 'd1']);
  });

  it('waits for an unconfirmed booking, and asks practice to give a box back when none is free', async () => {
    const unconfirmed = book({ confirm: false });
    now = START - 10 * MIN;
    runner.allocate();
    expect(getBooking(db, unconfirmed)!.state).toBe('scheduled');
    expect(preempts).toBe(0);
    const id = book();
    db.prepare("UPDATE servers SET status = 'live'").run();
    runner.allocate();
    expect(getBooking(db, id)!.state).toBe('scheduled');
    expect(preempts).toBe(1);
    db.prepare("UPDATE servers SET status = 'idle' WHERE id = 1").run();
    runner.allocate();
    await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ state: 'ready', server_id: 1 });
  });

  it('skips a box without the dlc4 mappack for an L4D2 campaign', () => {
    db.prepare('UPDATE servers SET has_dlc4 = 1 WHERE id = 1').run();
    const id = book({ playlist: ['dead_center'] });
    expect(runner.pickBox(getBooking(db, id)!)?.id).toBe(1);
  });
});

describe('setup failures', () => {
  it('retries once, then cancels as setup_failed, tells staff and both sides, and releases the box', async () => {
    const events: AdminEvent[] = [];
    const unsubscribe = subscribeAdminEvents((e) => events.push(e));
    box.ccc.plugin = false;
    const id = book();
    now = START - 15 * MIN;
    runner.allocate();
    await runner.idle();
    unsubscribe();
    const b = getBooking(db, id)!;
    expect(b).toMatchObject({ state: 'cancelled', end_reason: 'setup_failed', setup_attempts: 2 });
    expect(b.ended_at).not.toBeNull();
    expect(restarted).toEqual(['ccc', 'ccc']);
    expect(released).toEqual([3]);
    expect(events.some((e) => e.kind === 'problem' && /l4d_booking/.test(e.text))).toBe(true);
    expect(dms.filter((d) => /cancelled/.test(d.content)).map((d) => d.to).sort()).toEqual(['d0', 'd1']);
    expect(sideRow(db, id, 'a')!.no_show_at).toBeNull();
  });

  it('a config that takes on the second try still makes the booking ready', async () => {
    box.ccc.failExec = 1;
    const id = book();
    now = START - 15 * MIN;
    runner.allocate();
    await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ state: 'ready', setup_attempts: 1 });
    expect(box.ccc.execs).toBe(2);
  });

  it('a cancel during setup stops it and winds the box down', async () => {
    const id = book();
    now = START - 15 * MIN;
    holdBox(db, id, 3, new Date(now));
    markSetup(db, id, new Date(now));
    cancelBooking(db, { bookingId: id, by: P[0], now: new Date(now) });
    runner.settle(id);
    await runner.idle();
    expect(getBooking(db, id)!.ended_at).not.toBeNull();
    expect(released).toEqual([3]);
  });
});

describe('resume after a web restart', () => {
  it('reruns setup for a held booking and winds down an ending one without a goodbye', async () => {
    const held = book();
    now = START - 15 * MIN;
    holdBox(db, held, 3, new Date(now));
    const ending = book();
    holdBox(db, ending, 2, new Date(now));
    cancelBooking(db, { bookingId: ending, by: P[0], now: new Date(now) });
    const fresh = build();
    fresh.resume();
    await fresh.idle();
    expect(getBooking(db, held)!.state).toBe('ready');
    expect(getBooking(db, ending)!.ended_at).not.toBeNull();
    expect(sent.filter((s) => s.server === 'bb').flatMap((s) => s.cmds).some((c) => c.startsWith('say '))).toBe(false);
  });
});

describe('notices', () => {
  it('tells side b of the invite, side a of the confirm, an added person of their invite, everyone of a cancel', () => {
    const id = book({ confirm: false });
    runner.onCreated(id);
    expect(dms.map((d) => d.to)).toEqual(['d1']);
    confirmBooking(db, { bookingId: id, by: P[1], now: new Date(now) });
    runner.onConfirmed(id);
    expect(dms.map((d) => d.to)).toEqual(['d1', 'd0']);
    addPerson(db, { bookingId: id, by: P[0], side: 'a', steamid: P[5], role: 'ringer', now: new Date(now) });
    runner.onPersonAdded(id, P[5], P[0]);
    expect(dms.at(-1)!.to).toBe('d5');
    respondPerson(db, { bookingId: id, steamid: P[5], accept: true, now: new Date(now) });
    dms = [];
    cancelBooking(db, { bookingId: id, by: P[0], reason: 'sick', now: new Date(now) });
    runner.onCancelled(id, P[0], 'sick');
    expect(dms.map((d) => d.to).sort()).toEqual(['d1', 'd5']);
    expect(dms[0].content).toContain('sick');
  });
});

describe('bookingLines', () => {
  it('keeps team names console-safe', () => {
    const id = book();
    db.prepare("UPDATE players SET name = 'a\"b;c ü' WHERE steamid = ?").run(P[0]);
    const lines = bookingLines(db, getBooking(db, id)!);
    expect(lines.find((l) => l.startsWith('l4d_booking_notice'))).toBe('l4d_booking_notice "Booked: abc ?\'s group vs p1\'s group until 22:00 UTC"');
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run tests/bookingRunner.test.ts`
Expected: FAIL, cannot find module `../src/bookings/runner.js`.

- [ ] **Step 4: Write `src/bookings/runner.ts`**

```ts
import type { DB } from '../db.js';
import { getServer, type ServerRow } from '../serverPool.js';
import { NOT_HELD_SQL } from '../serverHolds.js';
import { campaignRegistry, firstMapOf } from '../campaignRegistry.js';
import { isInstalledEverywhere } from '../campaignInstall.js';
import { isMapName } from '../campaigns.js';
import { parseStatusMap } from '../practiceLeases.js';
import { parseStatusPlayers } from '../practicePlayers.js';
import { publishAdminEvent } from '../adminFeed.js';
import { consoleText, cvarValue, quoted, waitForStartup, type BoxRcon } from '../serverSetup.js';
import { activeMembers } from '../teams/teams.js';
import type { Notifier, NotifyType } from '../notify/notify.js';
import { bookingMessage } from './messages.js';
import { bookingLimits } from './rules.js';
import {
  acceptedPeople, bookingRules, closeBooking, expireUnconfirmed, getBooking, markActive, markReady, markReleased, markSetup,
  openBookings, recordPresence, setReminded, setWarned, sideName, sidesOf, holdBox, type BookingRow, type Side, type SideRow,
} from './bookings.js';

/**
 * The part of bookings that talks to game servers (spec part 1 section 3;
 * plan 4a), modelled on PracticeLeases: a minute tick, setup in the
 * background, a guarded end, a wind-down that holds the box until its
 * restart has finished, and resume() after a web restart.
 *
 * Every state change goes through src/bookings/bookings.ts. This class only
 * decides when, and does the rcon work in between. One short rcon connection
 * per burst (BoxRcon), never one held across a wait.
 */

export const TICK_MS = 60_000;
/** Setup attempts before a booking is cancelled as setup_failed (spec). */
export const SETUP_TRIES = 2;
/** Tries at exec'ing the game config and seeing it take, per attempt. */
export const CFG_TRIES = 3;
/** After `exec <cfg>`: it changes map or restarts the round. */
export const SETUP_SETTLE_MS = 15_000;
/** After `changelevel`: the map loads and its configs run. */
export const MAP_SETTLE_MS = 20_000;
export const GOODBYE_MS = 3_000;
/** Minutes left at which the box says so in chat, once each. */
export const WARN_AT_MINUTES = [30, 10, 5] as const;

const END_SAY: Record<string, string> = {
  time: 'its time is up',
  idle: 'nobody was on it',
  captain: 'a captain ended it',
  staff: 'staff ended it',
  cancelled: 'it was cancelled',
  no_show: 'the other side did not show',
  setup_failed: 'it could not be set up',
};

export interface BookingRunnerDeps {
  db: DB;
  rcon: BoxRcon;
  publicUrl: string;
  /** Give the box back with a forced restart; resolves once it is back (true)
   *  or reported offline (false). */
  release: (serverId: number) => Promise<boolean>;
  /** The quit-and-wait before setup, without a release (the booking still holds the box). */
  restart: (server: ServerRow) => Promise<boolean>;
  notifier: Notifier;
  /** No box for a booking at its hold time: ask practice leases and side
   *  games to give one back (server.ts wires both needServer calls). */
  preempt: () => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** The lines that make a box the booking's: the plugin's cvars (which put
 *  the values back after every map load) and the engine cvars themselves. */
export function bookingLines(db: DB, b: BookingRow): string[] {
  if (!/^[a-z0-9]+$/.test(b.password) || !/^[a-z0-9]+$/.test(b.tv_password)) throw new Error('booking password has unexpected characters');
  const [a, bs] = sidesOf(db, b.id);
  const notice = consoleText(`Booked: ${sideName(db, a)} vs ${sideName(db, bs)} until ${b.ends_at.slice(11, 16)} UTC`, 120);
  return [
    `l4d_booking_tv_password ${quoted(b.tv_password)}`,
    `l4d_booking_notice ${quoted(notice)}`,
    `l4d_booking_password ${quoted(b.password)}`,
    `sm_cvar sv_password ${quoted(b.password)}`,
    `sm_cvar tv_password ${quoted(b.tv_password)}`,
  ];
}

/** Who runs a side: a team's captain and co-captains, or the pickup captain. */
function sideManagers(db: DB, s: SideRow): string[] {
  if (s.team_id === null) return [s.captain_steamid];
  return activeMembers(db, s.team_id).filter((m) => m.role !== 'member').map((m) => m.steamid);
}

export class BookingRunner {
  private readonly db: DB;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** Bookings with a setup or wind-down running; nothing else starts on them. */
  private readonly busy = new Map<number, Promise<void>>();
  private ticking = false;

  constructor(private readonly deps: BookingRunnerDeps) {
    this.db = deps.db;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }));
    this.now = deps.now ?? Date.now;
  }

  private track(id: number, work: () => Promise<void>): void {
    if (this.busy.has(id)) return;
    const p = work().catch((err) => { console.error(`[booking] ${id}:`, err); }).finally(() => { this.busy.delete(id); });
    this.busy.set(id, p);
  }

  /** Resolves once no setup or wind-down is running. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.busy.size > 0) await Promise.all([...this.busy.values()]);
  }

  /** Boot: nothing in memory survived. An end that had started finishes
   *  (no goodbye: the box may be mid-restart); a booking caught in setup is
   *  set up again from the start; ready and active ones carry on. */
  resume(): void {
    for (const b of openBookings(this.db)) {
      if (b.ending_at !== null) this.track(b.id, () => this.windDown(b.id, false));
      else if (b.state === 'held' || b.state === 'setup') this.track(b.id, () => this.setup(b.id));
    }
  }

  /** Take a box for every confirmed booking at its hold time. Run by the
   *  tick and whenever the releaser frees a box. */
  allocate(): void {
    const nowMs = this.now();
    const lead = bookingLimits(this.db).holdLeadMinutes * 60_000;
    let waiting = false;
    for (const b of openBookings(this.db)) {
      if (b.state !== 'scheduled' || b.server_id !== null || b.ending_at !== null) continue;
      if (Date.parse(b.starts_at) - lead > nowMs) continue;
      if (sidesOf(this.db, b.id).some((s) => s.confirmed_at === null)) continue;
      const server = this.pickBox(b);
      if (!server || !holdBox(this.db, b.id, server.id, new Date(nowMs))) { waiting = true; continue; }
      console.log(`[booking] ${b.id} holds ${server.name}`);
      this.track(b.id, () => this.setup(b.id));
    }
    if (waiting) this.deps.preempt();
  }

  /** An idle box for this booking: enabled, in its region, held by nothing,
   *  and able to load every campaign on the playlist. Highest id first, the
   *  reverse of claimIdle, like a practice lease. */
  pickBox(b: BookingRow): ServerRow | null {
    const rows = this.db.prepare(
      `SELECT * FROM servers WHERE status = 'idle' AND enabled = 1 AND region = ? AND ${NOT_HELD_SQL} ORDER BY id DESC`,
    ).all(b.region) as ServerRow[];
    const registry = campaignRegistry(this.db);
    const playlist = JSON.parse(b.playlist_json) as string[];
    return rows.find((s) => playlist.every((c) => {
      const e = registry.get(c);
      return !!e && (!e.custom || isInstalledEverywhere(this.db, c, [s.id])) && (!e.requiresDlc4 || s.has_dlc4 === 1);
    })) ?? null;
  }

  private stillSettingUp(id: number): BookingRow | null {
    const b = getBooking(this.db, id);
    return b && b.state === 'setup' && b.ending_at === null ? b : null;
  }

  private async setup(id: number): Promise<void> {
    for (;;) {
      const attempt = markSetup(this.db, id, new Date(this.now()));
      if (attempt === null) break;
      const b = getBooking(this.db, id)!;
      const server = getServer(this.db, b.server_id!)!;
      try {
        await this.setupOnce(id, server);
        break;
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        console.warn(`[booking] ${id}: setup try ${attempt} on ${server.name} failed: ${why}`);
        if (!this.stillSettingUp(id)) break;
        if (attempt < SETUP_TRIES) continue;
        publishAdminEvent({ kind: 'problem', text: `Booking ${id} could not be set up on ${server.name} (${why}). It is cancelled and the box is going back to the pool.` });
        if (closeBooking(this.db, id, 'cancelled', 'setup_failed', new Date(this.now()))) {
          this.tell(id, this.everyone(id), 'booking_cancelled', { reason: 'the server could not be set up' });
        }
        break;
      }
    }
    // An end that came in during setup (a cancel, setup_failed) is ours to finish.
    const after = getBooking(this.db, id);
    if (after && after.ending_at !== null && after.ended_at === null) await this.windDown(id, true);
  }

  private async setupOnce(id: number, server: ServerRow): Promise<void> {
    if (!(await this.deps.restart(server))) throw new Error('the box did not come back from its restart');
    if (!this.stillSettingUp(id)) return;
    await waitForStartup(this.deps.rcon, server, this.sleep);
    const b = this.stillSettingUp(id);
    if (!b) return;
    await this.execVerified(server, b);
    const [version] = await this.deps.rcon(server, ['l4d_booking_version']);
    if (cvarValue(version, 'l4d_booking_version') === null) throw new Error('the l4d_booking plugin is not loaded on this box');
    const lines = bookingLines(this.db, b);
    const playlist = JSON.parse(b.playlist_json) as string[];
    const firstMap = firstMapOf(this.db, playlist[0]);
    if (!isMapName(firstMap)) throw new Error(`${playlist[0]} starts on ${JSON.stringify(firstMap)}, which is not a valid map name`);
    await this.deps.rcon(server, lines);
    try {
      await this.deps.rcon(server, [`changelevel ${firstMap}`]);
    } catch {
      // A changelevel can drop the connection it came in on; the map check decides.
    }
    await this.sleep(MAP_SETTLE_MS);
    if (!this.stillSettingUp(id)) return;
    const [st] = await this.deps.rcon(server, ['status', ...lines]);
    if (parseStatusMap(st) !== firstMap) throw new Error(`${firstMap} did not load (the box is on ${parseStatusMap(st) ?? 'no map'})`);
    if (!markReady(this.db, id, new Date(this.now()))) return;
    console.log(`[booking] ${id} ready on ${server.name}`);
    this.tell(id, acceptedPeople(this.db, id).map((p) => p.steamid), 'booking_ready');
  }

  /** Exec the booking's game config and see it take (the box's game type no
   *  longer says Pub); up to CFG_TRIES times. */
  private async execVerified(server: ServerRow, b: BookingRow): Promise<void> {
    const row = this.db.prepare('SELECT cfg FROM game_configs WHERE key = ?').get(b.game_config) as { cfg: string } | undefined;
    if (!row || !/^[a-z0-9_]+$/.test(row.cfg)) throw new Error(`game config ${b.game_config} has no usable cfg`);
    let seen = '';
    for (let i = 1; i <= CFG_TRIES; i++) {
      try {
        await this.deps.rcon(server, [`exec ${row.cfg}`]);
        await this.sleep(SETUP_SETTLE_MS);
        const [reply] = await this.deps.rcon(server, ['l4d_game_type_name']);
        const type = cvarValue(reply, 'l4d_game_type_name') ?? '';
        if (type !== '' && !type.includes('Pub')) return;
        seen = `game type "${type}"`;
      } catch (err) {
        seen = `no answer (${err instanceof Error ? err.message : String(err)})`;
      }
    }
    throw new Error(`${row.cfg}.cfg did not take after ${CFG_TRIES} tries; last seen ${seen}`);
  }

  /** Finish an end that has started: goodbye, kick, release with a restart,
   *  then the booking holds nothing. A booking that never had a box has
   *  nothing to give back. */
  private async windDown(id: number, sayGoodbye: boolean): Promise<void> {
    const b = getBooking(this.db, id);
    if (!b || b.ended_at !== null) return;
    if (b.server_id === null) { markReleased(this.db, id, new Date(this.now())); return; }
    const server = getServer(this.db, b.server_id);
    if (server && sayGoodbye) {
      try {
        await this.deps.rcon(server, [`say [Booking] This booked server is closing: ${END_SAY[b.end_reason ?? 'time'] ?? 'the booking is over'}.`]);
        await this.sleep(GOODBYE_MS);
        await this.deps.rcon(server, ['sm_kick @humans "The booking is over. Thanks for playing."']);
      } catch (err) {
        // Best effort: the restart below empties the box either way.
        console.warn(`[booking] ${id}: goodbye on ${server.name} failed:`, err instanceof Error ? err.message : err);
      }
    }
    try {
      await this.deps.release(b.server_id);
    } catch (err) {
      console.error(`[booking] ${id}: releasing server ${b.server_id} failed:`, err);
    }
    markReleased(this.db, id, new Date(this.now()));
  }

  /** Finish any end a route or the tick started. Idempotent. */
  settle(id: number): void {
    const b = getBooking(this.db, id);
    if (!b || b.ending_at === null || b.ended_at !== null) return;
    this.track(id, () => this.windDown(id, true));
  }

  /** The minute pass. Task 8 adds expiry, reminders and the watch. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.allocate();
      for (const b of openBookings(this.db)) if (b.ending_at !== null) this.settle(b.id);
    } finally {
      this.ticking = false;
    }
  }

  // ---------- notices ----------

  private tell(id: number, steamids: Iterable<string>, type: NotifyType, extra: { minutes?: number; reason?: string | null; addedBy?: string } = {}): void {
    const payload = bookingMessage(this.db, this.deps.publicUrl, id, type, extra);
    if (payload) this.deps.notifier.send(steamids, type, payload);
  }

  /** Everyone with a stake: accepted people and the managers of both sides. */
  private everyone(id: number): string[] {
    return [...acceptedPeople(this.db, id).map((p) => p.steamid), ...sidesOf(this.db, id).flatMap((s) => sideManagers(this.db, s))];
  }

  onCreated(id: number): void {
    const b = sidesOf(this.db, id).find((s) => s.side === 'b');
    if (b) this.tell(id, sideManagers(this.db, b), 'booking_invite');
  }

  onConfirmed(id: number): void {
    const a = sidesOf(this.db, id).find((s) => s.side === 'a');
    if (a) this.tell(id, sideManagers(this.db, a), 'booking_confirmed');
  }

  onPersonAdded(id: number, steamid: string, by: string): void {
    const row = this.db.prepare("SELECT 1 FROM booking_people WHERE booking_id = ? AND steamid = ? AND status = 'invited'").get(id, steamid);
    if (row) this.tell(id, [steamid], 'booking_invite', { addedBy: by });
  }

  onCancelled(id: number, by: string | null, reason: string | null): void {
    this.tell(id, this.everyone(id).filter((s) => s !== by), 'booking_cancelled', { reason });
    this.settle(id);
  }

  onNoShow(id: number, absent: Side): void {
    const s = sidesOf(this.db, id).find((x) => x.side === absent);
    if (!s) return;
    const people = acceptedPeople(this.db, id).filter((p) => p.side === absent).map((p) => p.steamid);
    this.tell(id, [...sideManagers(this.db, s), ...people], 'booking_no_show');
    this.settle(id);
  }
}
```

The import list already carries what Task 8 uses (`expireUnconfirmed`, `markActive`, `recordPresence`, `setReminded`, `setWarned`, `bookingRules`, `parseStatusPlayers`); the repo's tsconfig does not flag unused imports.

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run tests/bookingRunner.test.ts tests/practiceLeases.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/serverSetup.ts src/practiceLeases.ts src/bookings/runner.ts tests/bookingRunner.test.ts
git commit -m "Bookings: runner takes a box at the hold time, sets it up (restart, game config, private passwords, first map), retries once, winds down, resumes after a restart, sends the notices"
```

---

### Task 8: BookingRunner part 2: the minute watch

**Files:**
- Modify: `src/bookings/runner.ts` (`tick`, new private `remind`, `watch`, `endNow`)
- Test: `tests/bookingRunner.test.ts` (new `describe` blocks)

**Interfaces:**
- Consumes: Task 4 `expireUnconfirmed`, `recordPresence`, `markActive`, `setReminded`, `setWarned`, `bookingRules`; `parseStatusPlayers(status)` from `src/practicePlayers.ts` (returns `{ steamid64: string | null; ... }[]`, humans only).
- Produces: `tick()` runs, in order: expire unconfirmed invites (and tell both sides), send the 60 and 15 minute reminders, allocate, finish started ends, and watch every `ready`/`active` booking that has no setup or wind-down running.

The watch, per booking, runs one `status`. If rcon fails, it judges nothing that minute. Otherwise it:

1. Counts each side's accepted people present and records the peak and `last_human_at`.
2. Turns `ready` into `active` when any of the booking's people is on the box.
3. Ends the booking with reason `time` at `ends_at`.
4. Ends it with reason `idle` when the box has been empty for `idleEndMinutes`, counted from the later of the last human seen and the start plus the no-show grace.
5. Says "About N minutes left" once each at 30, 10 and 5 minutes left (the smallest threshold crossed, so a booking extended past one hears it again).

- [ ] **Step 1: Write the failing tests**

Append to `tests/bookingRunner.test.ts`:

```ts
describe('the minute watch', () => {
  const ready = async () => {
    const id = book();
    now = START - 15 * MIN;
    runner.allocate();
    await runner.idle();
    sent = []; dms = [];
    return id;
  };

  it('reminds once at 60 and once at 15 minutes before the start', async () => {
    const id = book();
    now = START - 61 * MIN;
    await runner.tick();
    expect(dms).toEqual([]);
    now = START - 59 * MIN;
    await runner.tick();
    await runner.tick();
    expect(dms.filter((d) => /starts in 59 minutes/.test(d.content)).map((d) => d.to).sort()).toEqual(['d0', 'd1']);
    now = START - 15 * MIN;
    await runner.tick();
    await runner.idle();
    expect(dms.filter((d) => /starts in 15 minutes/.test(d.content))).toHaveLength(2);
    expect(getBooking(db, id)!.reminded_15_at).not.toBeNull();
  });

  it('records presence per side, turns active, and keeps the peak', async () => {
    const id = await ready();
    addPerson(db, { bookingId: id, by: P[0], side: 'a', steamid: P[2], role: 'player', now: new Date(now) });
    respondPerson(db, { bookingId: id, steamid: P[2], accept: true, now: new Date(now) });
    box.ccc.humans = [P[0], P[2], P[1], '76561199999999999'];
    now = START - 5 * MIN;
    await runner.tick();
    expect(getBooking(db, id)!.state).toBe('active');
    expect(sideRow(db, id, 'a')!.peak_present).toBe(2);
    expect(sideRow(db, id, 'b')!.peak_present).toBe(1);
    box.ccc.humans = [P[0]];
    now += MIN;
    await runner.tick();
    expect(sideRow(db, id, 'a')!.peak_present).toBe(2);
  });

  it('ends an empty booking after the grace plus the idle time, with a goodbye, kick and release', async () => {
    const id = await ready();
    // Casual Scrim grace is 15 minutes, idle end 10: nobody ever came, so 25 minutes after the start.
    now = START + 24 * MIN;
    await runner.tick();
    expect(getBooking(db, id)!.ending_at).toBeNull();
    now = START + 25 * MIN;
    await runner.tick();
    await runner.idle();
    const b = getBooking(db, id)!;
    expect(b).toMatchObject({ state: 'ended', end_reason: 'idle' });
    expect(b.ended_at).not.toBeNull();
    const cmds = sent.flatMap((s) => s.cmds);
    expect(cmds).toContain('say [Booking] This booked server is closing: nobody was on it.');
    expect(cmds).toContain('sm_kick @humans "The booking is over. Thanks for playing."');
    expect(released).toEqual([3]);
  });

  it('a box people left late counts idle from the last human seen', async () => {
    const id = await ready();
    box.ccc.humans = [P[0]];
    now = START + 60 * MIN;
    await runner.tick();
    box.ccc.humans = [];
    now = START + 69 * MIN;
    await runner.tick();
    expect(getBooking(db, id)!.ending_at).toBeNull();
    now = START + 70 * MIN;
    await runner.tick();
    expect(getBooking(db, id)!.end_reason).toBe('idle');
  });

  it('warns at 30, 10 and 5 minutes left, once each, then ends on time', async () => {
    const id = await ready();
    box.ccc.humans = [P[0]];
    const says = () => sent.flatMap((s) => s.cmds).filter((c) => c.startsWith('say [Booking] About'));
    now = START + 89 * MIN; await runner.tick();
    expect(says()).toEqual([]);
    now = START + 90 * MIN; await runner.tick();
    now = START + 91 * MIN; await runner.tick();
    expect(says()).toEqual(['say [Booking] About 30 minutes left on this booking (until 22:00 UTC).']);
    now = START + 110 * MIN; await runner.tick();
    now = START + 115 * MIN; await runner.tick();
    now = START + 116 * MIN; await runner.tick();
    expect(says()).toEqual([
      'say [Booking] About 30 minutes left on this booking (until 22:00 UTC).',
      'say [Booking] About 10 minutes left on this booking (until 22:00 UTC).',
      'say [Booking] About 5 minutes left on this booking (until 22:00 UTC).',
    ]);
    now = START + 120 * MIN; await runner.tick();
    await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ state: 'ended', end_reason: 'time' });
  });

  it('judges nothing while rcon is down', async () => {
    const id = await ready();
    box.ccc.down = true;
    now = START + 60 * MIN;
    await runner.tick();
    expect(getBooking(db, id)!.ending_at).toBeNull();
  });

  it('expires an unconfirmed invite and tells both sides', async () => {
    const id = book({ confirm: false });
    now = START - 29 * MIN;
    await runner.tick();
    expect(getBooking(db, id)).toMatchObject({ state: 'cancelled', end_reason: 'unconfirmed' });
    expect(dms.map((d) => d.to).sort()).toEqual(['d0', 'd1']);
  });
});
```

A tick that crosses two marks at once (a booking extended, or a missed tick) says only the smallest one. That is why `warned_minutes` stores the last mark said, not a set.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/bookingRunner.test.ts`
Expected: the new cases FAIL (no reminders, no watch).

- [ ] **Step 3: Implement**

In `src/bookings/runner.ts`, replace `tick` and add the three private methods:

```ts
  /** The minute pass. Never runs two at once. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = new Date(this.now());
      for (const id of expireUnconfirmed(this.db, now)) {
        this.tell(id, this.everyone(id), 'booking_cancelled', { reason: 'it was not confirmed in time' });
      }
      this.remind(now);
      this.allocate();
      for (const b of openBookings(this.db)) {
        if (b.ending_at !== null) { this.settle(b.id); continue; }
        if ((b.state === 'ready' || b.state === 'active') && !this.busy.has(b.id)) await this.watch(b, now);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** 60 and 15 minutes before the start, once each, to everyone accepted. A
   *  booking made 40 minutes ahead gets the first one at once ("in 40"). */
  private remind(now: Date): void {
    for (const b of openBookings(this.db)) {
      if (b.ending_at !== null || b.state === 'active') continue;
      if (sidesOf(this.db, b.id).some((s) => s.confirmed_at === null)) continue;
      const left = Date.parse(b.starts_at) - now.getTime();
      if (left <= 0) continue;
      const minutes = Math.round(left / 60_000);
      const to = acceptedPeople(this.db, b.id).map((p) => p.steamid);
      if (left <= 15 * 60_000 && b.reminded_15_at === null) {
        setReminded(this.db, b.id, 15, now);
        setReminded(this.db, b.id, 60, now);
        this.tell(b.id, to, 'booking_starting', { minutes });
      } else if (left <= 60 * 60_000 && left > 15 * 60_000 && b.reminded_60_at === null) {
        setReminded(this.db, b.id, 60, now);
        this.tell(b.id, to, 'booking_starting', { minutes });
      }
    }
  }

  /** One look at a running booking's box (see Task 8 in the plan). */
  private async watch(b: BookingRow, now: Date): Promise<void> {
    const server = b.server_id !== null ? getServer(this.db, b.server_id) : undefined;
    if (!server) return;
    let humans: ReturnType<typeof parseStatusPlayers>;
    try {
      const [st] = await this.deps.rcon(server, ['status']);
      humans = parseStatusPlayers(st);
    } catch (err) {
      console.warn(`[booking] ${b.id}: status on ${server.name} failed:`, err instanceof Error ? err.message : err);
      return;
    }
    const on = new Set(humans.map((h) => h.steamid64).filter((s): s is string => s !== null));
    const people = acceptedPeople(this.db, b.id);
    const present = {
      a: people.filter((p) => p.side === 'a' && on.has(p.steamid)).length,
      b: people.filter((p) => p.side === 'b' && on.has(p.steamid)).length,
    };
    recordPresence(this.db, b.id, present, humans.length > 0, now);
    if (b.state === 'ready' && present.a + present.b > 0) markActive(this.db, b.id, now);

    const fresh = getBooking(this.db, b.id)!;
    const nowMs = now.getTime();
    const endsMs = Date.parse(fresh.ends_at);
    if (nowMs >= endsMs) { this.endNow(b.id, 'time', now); return; }
    const limits = bookingLimits(this.db);
    const grace = (bookingRules(fresh)?.noShowGraceMinutes ?? 15) * 60_000;
    const idleFrom = Math.max(fresh.last_human_at ? Date.parse(fresh.last_human_at) : 0, Date.parse(fresh.starts_at) + grace);
    if (humans.length === 0 && nowMs - idleFrom >= limits.idleEndMinutes * 60_000) { this.endNow(b.id, 'idle', now); return; }

    const leftMin = (endsMs - nowMs) / 60_000;
    const crossed = WARN_AT_MINUTES.filter((m) => leftMin <= m && (fresh.warned_minutes === null || fresh.warned_minutes > m));
    if (crossed.length > 0) {
      const m = Math.min(...crossed);
      setWarned(this.db, b.id, m);
      try {
        await this.deps.rcon(server, [`say [Booking] About ${m} minutes left on this booking (until ${fresh.ends_at.slice(11, 16)} UTC).`]);
      } catch {
        // Best effort.
      }
    }
  }

  private endNow(id: number, reason: 'time' | 'idle', now: Date): void {
    if (closeBooking(this.db, id, 'ended', reason, now)) this.settle(id);
  }
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run tests/bookingRunner.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bookings/runner.ts tests/bookingRunner.test.ts
git commit -m "Bookings: minute watch (expiry, 60 and 15 minute reminders, presence per side, active, idle and time ends, minutes-left warnings)"
```

---
### Task 9: HTTP routes and server wiring

**Files:**
- Create: `src/routes/bookings.ts`
- Create: `src/routes/adminBookings.ts`
- Modify: `src/server.ts` (deps type near line 174; runner and notifier after `let bot` near line 1605; route registration next to `teamRoutes`; shutdown next to `clearInterval(practiceTick)`)
- Modify: `src/routes/serverChat.ts` and `web/src/api.ts` (`ChatServerView.state` gains `'booking'`)
- Test: `tests/bookingRoutes.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 5, 7, 8.
- Produces, player routes (all answer 404 `{ error: 'not found' }` while the switch keeps the viewer out; errors are `{ error: text }` with `BOOKING_ERRORS` status):
  - `GET /api/bookings/options` → `{ campaigns: { slug, name, minutes }[]; rulesets: { id, name }[]; gameConfigs: { key, label }[]; limits: { minMinutes, maxMinutes, daysAhead, playlistMax, stepMinutes, extendMinutes }; myTeams: { id, slug, name, tag }[]; teams: { id, slug, name, tag }[] }`
  - `GET /api/bookings/mine` → `{ open: BookingSummary[]; recent: BookingSummary[]; prefs: { type, label, enabled }[] }`
  - `POST /api/bookings` body `{ teamId?, opponent, startsAt, minutes, playlist, rulesetId?, gameConfig? }` → 201 `{ id }`
  - `GET /api/bookings/:id` → `BookingView` (404 for anyone it does not show)
  - `POST /api/bookings/:id/confirm` | `/decline` | `/accept` | `/leave` | `/cancel` (body `{ reason? }`) | `/extend` | `/no-show` | `/end` → the fresh `BookingView`
  - `POST /api/bookings/:id/people` body `{ side, steamid, role }` and `POST /api/bookings/:id/people/:steamid/remove` → the fresh `BookingView`
  - `POST /api/bookings/prefs` body `{ type, enabled }` → `{ prefs }`
- Produces, staff routes (admin or mod; not behind the switch, so staff can always clean up): `GET /api/admin/bookings` → `{ bookings: AdminBookingRow[] }`; `POST /api/admin/bookings/:id/cancel` (body `{ reason? }`), `/extend`, `/end` → `{ ok: true }`, each audited with `logAdmin`.
- `AdminBookingRow = { id, state, ending, startsAt, endsAt, aName, bName, server: string | null, peak: { a, b }, endReason: string | null }`

- [ ] **Step 1: Write the failing tests**

`tests/bookingRoutes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { addServer } from '../src/serverPool.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const P = Array.from({ length: 4 }, (_, i) => `7656119900000030${i}`);
const ADMIN = '76561199000000390';
const MOD = '76561199000000391';
const START = new Date(Date.now() + 3 * 24 * 3_600_000);
START.setUTCMinutes(0, 0, 0);

let db: DB;
let app: FastifyInstance;
let cookies: Record<string, Record<string, string>>;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({
    config: { ...loadConfig({}), communityDir: mkdtempSync(join(tmpdir(), 'bookingroutes-')) },
    db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
    bookingRcon: async () => { throw new Error('no rcon in route tests'); },
  });
  cookies = {};
  for (const id of [...P, ADMIN, MOD]) cookies[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare("UPDATE settings SET value = 'everyone' WHERE key = 'competitive_enabled'").run();
  db.prepare("UPDATE settings SET value = ? WHERE key = 'map_pool'").run(JSON.stringify(['no_mercy', 'death_toll']));
  for (const n of ['a', 'bb', 'ccc']) {
    const id = addServer(db, { name: n, host: 'h', port: 27014 + n.length, rconPort: 1, rconPassword: 'x' });
    db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(id);
  }
});
afterEach(async () => { await app.close(); });

const call = (method: 'GET' | 'POST', url: string, as?: string, payload?: object) =>
  app.inject({ method, url, cookies: as ? cookies[as] : undefined, payload });
const create = async (as = P[0], opponent: object = { steamid: P[1] }) => {
  const r = await call('POST', '/api/bookings', as, { opponent, startsAt: START.toISOString(), minutes: 90, playlist: ['no_mercy'] });
  expect(r.statusCode).toBe(201);
  return r.json().id as number;
};

describe('the switch', () => {
  it('off hides every route; admins-only lets admins through', async () => {
    db.prepare("UPDATE settings SET value = 'off' WHERE key = 'competitive_enabled'").run();
    expect((await call('GET', '/api/bookings/mine', ADMIN)).statusCode).toBe(404);
    db.prepare("UPDATE settings SET value = 'admins' WHERE key = 'competitive_enabled'").run();
    expect((await call('GET', '/api/bookings/mine', ADMIN)).statusCode).toBe(200);
    expect((await call('GET', '/api/bookings/mine', P[0])).statusCode).toBe(404);
    expect((await call('GET', '/api/bookings/options')).statusCode).toBe(404);
  });
});

describe('booking flow', () => {
  it('options list the pool with typical lengths and the limits', async () => {
    const r = (await call('GET', '/api/bookings/options', P[0])).json();
    expect(r.campaigns.map((c: { slug: string }) => c.slug)).toEqual(['no_mercy', 'death_toll']);
    expect(r.campaigns[0].minutes).toBe(60);
    expect(r.limits).toMatchObject({ minMinutes: 60, maxMinutes: 180, stepMinutes: 30, playlistMax: 4 });
    expect(r.rulesets.map((x: { name: string }) => x.name)).toContain('Casual Scrim');
  });

  it('create, view, confirm, cancel', async () => {
    const id = await create();
    expect((await call('GET', `/api/bookings/${id}`, P[2])).statusCode).toBe(404);
    const v = (await call('GET', `/api/bookings/${id}`, P[1])).json();
    expect(v.viewer).toMatchObject({ side: 'b', invited: true });
    const refused = await call('POST', `/api/bookings/${id}/confirm`, P[2]);
    expect(refused.statusCode).toBe(404);
    const confirmed = await call('POST', `/api/bookings/${id}/confirm`, P[1]);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().sides[1].confirmed).toBe(true);
    const mine = (await call('GET', '/api/bookings/mine', P[1])).json();
    expect(mine.open.map((b: { id: number }) => b.id)).toEqual([id]);
    const cancelled = await call('POST', `/api/bookings/${id}/cancel`, P[1], { reason: 'cannot make it' });
    expect(cancelled.json()).toMatchObject({ state: 'cancelled', cancel: { side: 'b', reason: 'cannot make it' } });
  });

  it('refusals carry the reason text and status', async () => {
    const r = await call('POST', '/api/bookings', P[0], { opponent: { steamid: P[1] }, startsAt: START.toISOString(), minutes: 45, playlist: ['no_mercy'] });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/length/);
  });

  it('people: add, accept, remove', async () => {
    const id = await create();
    await call('POST', `/api/bookings/${id}/confirm`, P[1]);
    const added = await call('POST', `/api/bookings/${id}/people`, P[0], { side: 'a', steamid: P[2], role: 'ringer' });
    expect(added.statusCode).toBe(200);
    expect((await call('POST', `/api/bookings/${id}/accept`, P[2])).statusCode).toBe(200);
    const removed = await call('POST', `/api/bookings/${id}/people/${P[2]}/remove`, P[0]);
    expect(removed.json().sides[0].people.map((p: { steamid: string }) => p.steamid)).toEqual([P[0]]);
  });

  it('notification preferences', async () => {
    const r = await call('POST', '/api/bookings/prefs', P[0], { type: 'booking_ready', enabled: false });
    expect(r.json().prefs.find((p: { type: string }) => p.type === 'booking_ready').enabled).toBe(false);
    expect((await call('POST', '/api/bookings/prefs', P[0], { type: 'nope', enabled: false })).statusCode).toBe(400);
  });
});

describe('staff', () => {
  it('lists bookings for staff only, and a staff cancel is audited and counts against nobody', async () => {
    const id = await create();
    expect((await call('GET', '/api/admin/bookings', P[0])).statusCode).toBe(403);
    const list = (await call('GET', '/api/admin/bookings', MOD)).json();
    expect(list.bookings.map((b: { id: number }) => b.id)).toEqual([id]);
    expect((await call('POST', `/api/admin/bookings/${id}/cancel`, MOD, { reason: 'test' })).statusCode).toBe(200);
    expect(db.prepare('SELECT state, cancel_side FROM bookings WHERE id = ?').get(id)).toEqual({ state: 'cancelled', cancel_side: null });
    expect(db.prepare("SELECT action FROM admin_actions WHERE action = 'booking_cancel'").all()).toHaveLength(1);
  });
});
```

The `confirm` refusal for `P[2]` is a 404, not a 403, because `P[2]` cannot see the booking at all: every `/:id` route first checks `bookingView` and answers 404 to anyone it would not show.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/bookingRoutes.test.ts`
Expected: FAIL (404 on every route; `bookingRcon` is not a known dep, which is a type error only).

- [ ] **Step 3: Write `src/routes/bookings.ts`**

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import { makeOptionalViewer, makeRequireActive } from './guards.js';
import { getPlayer } from '../players.js';
import { competitiveAccess } from '../teams/access.js';
import { liveTeams, myTeams } from '../teams/teams.js';
import { getCampaignPool } from '../settings.js';
import { campaignRegistry } from '../campaignRegistry.js';
import * as B from '../bookings/bookings.js';
import { bookingLimits, typicalCampaignMinutes, STEP_MINUTES } from '../bookings/rules.js';
import { isNotifyType, prefsOf, setPref } from '../notify/notify.js';
import type { BookingRunner } from '../bookings/runner.js';

export interface BookingRoutesOpts {
  db: DB;
  /** Null only in tests that build the routes bare. */
  runner: BookingRunner | null;
}

const NOT_FOUND = { error: 'not found' };

/**
 * Server bookings for players (plan 4a). Every route answers 404 to a viewer
 * the competitive switch keeps out, before anything else, so nothing says
 * the routes exist. Every /:id route answers 404 to a viewer the booking is
 * not shown to (bookingView null), so a stranger cannot learn which ids exist.
 * The domain module decides everything; these only translate.
 */
export async function bookingRoutes(app: FastifyInstance, opts: BookingRoutesOpts): Promise<void> {
  const { db, runner } = opts;
  const optionalViewer = makeOptionalViewer(db);
  const requireActive = makeRequireActive(db);
  const isStaff = (steamid: string): boolean => {
    const p = getPlayer(db, steamid);
    return !!p && (p.is_admin === 1 || p.is_mod === 1);
  };
  const allowed = (req: FastifyRequest, reply: FastifyReply): string | null => {
    if (!competitiveAccess(db, optionalViewer(req))) { reply.code(404).send(NOT_FOUND); return null; }
    return requireActive(req, reply);
  };
  const refuse = (reply: FastifyReply, error: B.BookingError) =>
    reply.code(B.BOOKING_ERRORS[error].status).send({ error: B.BOOKING_ERRORS[error].text });
  /** The booking id from the URL and the viewer, when the viewer may see it. */
  const visible = (req: FastifyRequest, reply: FastifyReply): { me: string; id: number } | null => {
    const me = allowed(req, reply);
    if (!me) return null;
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id < 1 || !B.bookingView(db, id, { steamid: me, staff: isStaff(me) })) {
      reply.code(404).send(NOT_FOUND);
      return null;
    }
    return { me, id };
  };
  const view = (me: string, id: number) => B.bookingView(db, id, { steamid: me, staff: isStaff(me) });
  const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>;

  app.get('/api/bookings/options', async (req, reply) => {
    const me = allowed(req, reply);
    if (!me) return;
    const registry = campaignRegistry(db);
    const limits = bookingLimits(db);
    const team = (t: { id: number; slug: string; name: string; tag: string }) => ({ id: t.id, slug: t.slug, name: t.name, tag: t.tag });
    return {
      campaigns: getCampaignPool(db).filter((slug) => registry.get(slug))
        .map((slug) => ({ slug, name: registry.get(slug)!.name, minutes: typicalCampaignMinutes(db, slug) })),
      rulesets: db.prepare('SELECT id, name FROM rulesets WHERE archived_at IS NULL ORDER BY id').all(),
      gameConfigs: db.prepare('SELECT key, label FROM game_configs WHERE enabled = 1 ORDER BY key').all(),
      limits: {
        minMinutes: limits.minMinutes, maxMinutes: limits.maxMinutes, daysAhead: limits.daysAhead,
        playlistMax: limits.playlistMax, stepMinutes: STEP_MINUTES, extendMinutes: limits.extendMinutes,
      },
      myTeams: myTeams(db, me).filter((t) => t.role !== 'member').map(team),
      teams: liveTeams(db).map(team),
    };
  });

  app.get('/api/bookings/mine', async (req, reply) => {
    const me = allowed(req, reply);
    if (!me) return;
    return { ...B.myBookings(db, me), prefs: prefsOf(db, me) };
  });

  app.post('/api/bookings/prefs', async (req, reply) => {
    const me = allowed(req, reply);
    if (!me) return;
    const { type, enabled } = body(req);
    if (!isNotifyType(type) || typeof enabled !== 'boolean') return reply.code(400).send({ error: 'A preference is a known type and on or off.' });
    setPref(db, me, type, enabled);
    return { prefs: prefsOf(db, me) };
  });

  app.post('/api/bookings', async (req, reply) => {
    const me = allowed(req, reply);
    if (!me) return;
    const b = body(req);
    const r = B.createBooking(db, {
      by: me, teamId: b.teamId, opponent: b.opponent, startsAt: b.startsAt, minutes: b.minutes,
      playlist: b.playlist, rulesetId: b.rulesetId, gameConfig: b.gameConfig,
    });
    if (!r.ok) return refuse(reply, r.error);
    runner?.onCreated(r.value.id);
    return reply.code(201).send({ id: r.value.id });
  });

  app.get('/api/bookings/:id', async (req, reply) => {
    const v = visible(req, reply);
    if (!v) return;
    reply.header('Cache-Control', 'no-store');
    return view(v.me, v.id);
  });

  /** One POST action on a booking: run it, then the follow-up, then the fresh view. */
  const action = (path: string, run: (me: string, id: number, req: FastifyRequest) => B.Result<unknown>, after?: (me: string, id: number, value: unknown, req: FastifyRequest) => void) => {
    app.post(`/api/bookings/:id/${path}`, async (req, reply) => {
      const v = visible(req, reply);
      if (!v) return;
      const r = run(v.me, v.id, req);
      if (!r.ok) return refuse(reply, r.error);
      after?.(v.me, v.id, r.value, req);
      return view(v.me, v.id);
    });
  };

  action('confirm', (me, id) => B.confirmBooking(db, { bookingId: id, by: me }), (_me, id) => { runner?.onConfirmed(id); runner?.allocate(); });
  action('decline', (me, id) => B.declineBooking(db, { bookingId: id, by: me }), (me, id) => runner?.onCancelled(id, me, null));
  action('accept', (me, id) => B.respondPerson(db, { bookingId: id, steamid: me, accept: true }));
  action('leave', (me, id) => {
    const row = db.prepare("SELECT status FROM booking_people WHERE booking_id = ? AND steamid = ?").get(id, me) as { status: string } | undefined;
    return row?.status === 'invited'
      ? B.respondPerson(db, { bookingId: id, steamid: me, accept: false })
      : B.removePerson(db, { bookingId: id, by: me, steamid: me });
  });
  action('cancel', (me, id, req) => B.cancelBooking(db, { bookingId: id, by: me, reason: body(req).reason }),
    (me, id) => runner?.onCancelled(id, me, B.getBooking(db, id)?.cancel_reason ?? null));
  action('extend', (me, id) => B.extendBooking(db, { bookingId: id, by: me }));
  action('no-show', (me, id) => B.claimNoShow(db, { bookingId: id, by: me }),
    (_me, id, value) => runner?.onNoShow(id, (value as { absent: B.Side }).absent));
  action('end', (me, id) => B.endBooking(db, { bookingId: id, by: me }), (_me, id) => runner?.settle(id));
  action('people', (me, id, req) => {
    const b = body(req);
    return B.addPerson(db, { bookingId: id, by: me, side: b.side, steamid: b.steamid, role: b.role });
  }, (me, id, _value, req) => runner?.onPersonAdded(id, String(body(req).steamid), me));

  app.post('/api/bookings/:id/people/:steamid/remove', async (req, reply) => {
    const v = visible(req, reply);
    if (!v) return;
    const r = B.removePerson(db, { bookingId: v.id, by: v.me, steamid: (req.params as { steamid: string }).steamid });
    if (!r.ok) return refuse(reply, r.error);
    return view(v.me, v.id);
  });
}
```

`/api/bookings/prefs` and `/api/bookings/mine` and `/api/bookings/options` are registered before `/api/bookings/:id`; Fastify's router prefers static segments, so order does not matter, but `prefs` is a POST with no `:id` twin anyway.

- [ ] **Step 4: Write `src/routes/adminBookings.ts`**

```ts
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DB } from '../db.js';
import { makeRequireMod } from './guards.js';
import { logAdmin } from '../admin/audit.js';
import { getServer } from '../serverPool.js';
import * as B from '../bookings/bookings.js';
import type { BookingRunner } from '../bookings/runner.js';

export interface AdminBookingRow {
  id: number; state: string; ending: boolean; startsAt: string; endsAt: string; aName: string; bName: string;
  server: string | null; peak: { a: number; b: number }; endReason: string | null;
}

/**
 * The staff side of bookings (plan 4a): every open booking and those that
 * ended in the last day, with Cancel, Extend and End. Staff = admin or mod.
 * Not behind the competitive switch, so staff can always clean up after it
 * has been turned off. Every action is audited with logAdmin; a staff cancel
 * belongs to no side (scrim spec 3a: never counted against anyone).
 */
export async function adminBookingRoutes(app: FastifyInstance, opts: { db: DB; runner: BookingRunner | null }): Promise<void> {
  const { db, runner } = opts;
  const requireStaff = makeRequireMod(db);
  const refuse = (reply: FastifyReply, error: B.BookingError) =>
    reply.code(B.BOOKING_ERRORS[error].status).send({ error: B.BOOKING_ERRORS[error].text });
  const idOf = (params: unknown): number => Number((params as { id: string }).id);

  app.get('/api/admin/bookings', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const rows = db.prepare('SELECT * FROM bookings WHERE ended_at IS NULL OR ended_at > ? ORDER BY starts_at, id').all(since) as B.BookingRow[];
    const bookings: AdminBookingRow[] = rows.map((b) => {
      const [a, s] = B.sidesOf(db, b.id);
      return {
        id: b.id, state: b.state, ending: b.ending_at !== null, startsAt: b.starts_at, endsAt: b.ends_at,
        aName: B.sideName(db, a), bName: B.sideName(db, s),
        server: b.server_id !== null ? getServer(db, b.server_id)?.name ?? null : null,
        peak: { a: a.peak_present, b: s.peak_present }, endReason: b.end_reason,
      };
    });
    return { bookings };
  });

  app.post('/api/admin/bookings/:id/cancel', async (req, reply) => {
    const me = requireStaff(req, reply);
    if (!me) return;
    const id = idOf(req.params);
    const reason = (req.body as { reason?: unknown } | undefined)?.reason;
    const r = B.cancelBooking(db, { bookingId: id, by: me, staff: true, reason });
    if (!r.ok) return refuse(reply, r.error);
    logAdmin(db, me, 'booking_cancel', id, { reason: typeof reason === 'string' ? reason : null });
    runner?.onCancelled(id, me, B.getBooking(db, id)?.cancel_reason ?? null);
    return { ok: true };
  });

  app.post('/api/admin/bookings/:id/extend', async (req, reply) => {
    const me = requireStaff(req, reply);
    if (!me) return;
    const id = idOf(req.params);
    const r = B.extendBooking(db, { bookingId: id, by: me, staff: true });
    if (!r.ok) return refuse(reply, r.error);
    logAdmin(db, me, 'booking_extend', id, { endsAt: r.value.endsAt });
    return { ok: true };
  });

  app.post('/api/admin/bookings/:id/end', async (req, reply) => {
    const me = requireStaff(req, reply);
    if (!me) return;
    const id = idOf(req.params);
    const r = B.endBooking(db, { bookingId: id, by: me, staff: true });
    if (!r.ok) return refuse(reply, r.error);
    logAdmin(db, me, 'booking_end', id);
    runner?.settle(id);
    return { ok: true };
  });
}
```

- [ ] **Step 5: Wire into `src/server.ts`**

In the deps interface, after `practiceRcon?: LeaseRcon;`:

```ts
  /** Booking runner rcon; the real one when absent. Tests inject a fake. */
  bookingRcon?: LeaseRcon;
```

Imports:

```ts
import { BookingRunner, TICK_MS as BOOKING_TICK_MS } from './bookings/runner.js';
import { Notifier } from './notify/notify.js';
import { bookingRoutes } from './routes/bookings.js';
import { adminBookingRoutes } from './routes/adminBookings.js';
```

Directly before `await app.register(teamRoutes, {` (after `let bot` exists, because the notifier reads the bot's transport per DM):

```ts
  // Server bookings (plan 4a). After `bot`: the notifier reads its transport
  // per DM. resume() finishes any end or setup a restart interrupted; the
  // releaser's waiters let a booking waiting for a box take one the moment a
  // release frees it, ahead of the PUG queue (claimIdle keeps it back too).
  const notifier = new Notifier({
    db: deps.db,
    dm: () => { const transport = bot?.transport; return transport ? (userId, payload) => transport.dm(userId, payload) : null; },
  });
  const bookingRunner = new BookingRunner({
    db: deps.db,
    publicUrl: deps.config.publicUrl,
    rcon: deps.bookingRcon ?? realServerRcon,
    release: (serverId) => new Promise<boolean>((resolve) => {
      releaser.release(serverId, { restart: true, forceRestart: true }, resolve);
    }),
    restart: (server) => restarter.restart(server),
    notifier,
    preempt: () => { practiceLeases.needServer(); sideGamesRef?.needServer(); },
  });
  bookingRunner.resume();
  releaser.onFreed(() => bookingRunner.allocate());
  const bookingTick = setInterval(() => { void bookingRunner.tick(); }, BOOKING_TICK_MS);
  bookingTick.unref();
  await app.register(bookingRoutes, { db: deps.db, runner: bookingRunner });
  await app.register(adminBookingRoutes, { db: deps.db, runner: bookingRunner });
```

In the `onClose` hook, next to `clearInterval(practiceTick);`:

```ts
    clearInterval(bookingTick);
```

The hook (about line 1758) is registered before this code runs, but it only reads `bookingTick` when the server closes, long after the declaration; TypeScript allows a closure to name a later `const`.

`src/routes/serverChat.ts`: widen `ChatServerView.state` to `'match' | 'booking' | 'practice' | 'side' | 'idle' | 'offline'` and put `hold?.kind === 'booking' ? 'booking' :` first in the state chain. Make the same widening in `web/src/api.ts` `ChatServerView`.

- [ ] **Step 6: Run the tests and typecheck**

Run: `npx vitest run tests/bookingRoutes.test.ts tests/serverChat*.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: all green. The suite is about 8,400 tests, so run it in the background and read the summary.

- [ ] **Step 8: Commit**

```bash
git add src/routes/bookings.ts src/routes/adminBookings.ts src/server.ts src/routes/serverChat.ts web/src/api.ts tests/bookingRoutes.test.ts
git commit -m "Bookings: player and staff routes, runner and notifier wired into the server (tick, resume, wake on release)"
```

---

### Task 10: Web: Bookings page and booking page

**Files:**
- Modify: `web/src/api.ts` (types and `bookingsApi` after `teamsApi`)
- Create: `web/src/routes/Bookings.tsx`, `web/src/routes/Booking.tsx`, `web/src/bookingTime.ts`
- Modify: `web/src/AppRoutes.tsx` (two lazy routes), `web/src/components/Nav.tsx` (link)
- Test: `web/src/routes/Bookings.test.tsx`, `web/src/routes/Booking.test.tsx`, `web/src/bookingTime.test.ts`

**Interfaces:**
- Consumes: Task 9 routes. `teamsApi.search(q)` for player search (same switch).
- Produces: `/bookings` (my bookings with Confirm/Decline/Accept, a "Book a server" form, notification toggles) and `/booking/:id` (sides, people, connect line, actions). A "Bookings" nav link next to "Teams" for viewers with `me.teams`.
- Produces (`web/src/bookingTime.ts`): `toUtcIso(local: string): string | null` (a `datetime-local` value read in the viewer's zone), `localLabel(iso: string): string`, `fitWarning(minutes: number, playlistMinutes: number): string | null`.

- [ ] **Step 1: Write the failing tests**

`web/src/bookingTime.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { fitWarning, toUtcIso } from './bookingTime';

describe('booking time helpers', () => {
  it('reads a datetime-local value in the viewer zone', () => {
    const iso = toUtcIso('2026-10-02T20:00');
    expect(iso).toBe(new Date(2026, 9, 2, 20, 0).toISOString());
    expect(toUtcIso('')).toBeNull();
    expect(toUtcIso('nonsense')).toBeNull();
  });

  it('warns when the playlist will not fit', () => {
    expect(fitWarning(120, 110)).toBeNull();
    expect(fitWarning(60, 130)).toBe('These campaigns usually take about 130 minutes; the booking is 60. Extend later, or pick fewer.');
  });
});
```

`web/src/routes/Bookings.test.tsx` (the repo mocks the api module, as `Teams.test.tsx` does):

```tsx
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';

const { mockBookings } = vi.hoisted(() => ({
  mockBookings: { options: vi.fn(), mine: vi.fn(), act: vi.fn(), setPref: vi.fn(), create: vi.fn() },
}));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, bookingsApi: mockBookings };
});
const { Bookings } = await import('./Bookings');

const OPTIONS = {
  campaigns: [{ slug: 'no_mercy', name: 'No Mercy', minutes: 70 }, { slug: 'death_toll', name: 'Death Toll', minutes: 60 }],
  rulesets: [{ id: 3, name: 'Casual Scrim' }], gameConfigs: [{ key: 'standard', label: 'Standard' }],
  limits: { minMinutes: 60, maxMinutes: 180, daysAhead: 14, playlistMax: 4, stepMinutes: 30, extendMinutes: 30 },
  myTeams: [], teams: [{ id: 1, slug: 'mice', name: 'Mice', tag: 'MM' }],
};
const MINE = {
  open: [{ id: 7, state: 'scheduled', ending: false, startsAt: '2026-10-02T20:00:00.000Z', endsAt: '2026-10-02T22:00:00.000Z', aName: "p0's group", bName: 'Mice', mySide: 'b', needs: 'confirm' }],
  recent: [], prefs: [{ type: 'booking_ready', label: 'My booked server is ready', enabled: true }],
};
const session = { kind: 'active', me: { steamid: '76561199000000300', name: 'me', avatar: null, status: 'active', isAdmin: false, teams: true } } as never;

afterEach(() => { cleanup(); for (const f of Object.values(mockBookings)) f.mockReset(); });
beforeEach(() => {
  mockBookings.options.mockResolvedValue(OPTIONS);
  mockBookings.mine.mockResolvedValue(MINE);
  mockBookings.act.mockResolvedValue({});
  mockBookings.setPref.mockResolvedValue({ prefs: MINE.prefs });
});

describe('Bookings page', () => {
  it('shows what needs me with a Confirm button', async () => {
    render(<Bookings session={session} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(mockBookings.act).toHaveBeenCalledWith(7, 'confirm'));
  });

  it('the form warns when the playlist will not fit the length', async () => {
    render(<Bookings session={session} />);
    fireEvent.change(await screen.findByLabelText('Length'), { target: { value: '60' } });
    fireEvent.click(screen.getByLabelText('No Mercy'));
    fireEvent.click(screen.getByLabelText('Death Toll'));
    expect(screen.getByText(/usually take about 130 minutes/)).toBeTruthy();
  });

  it('the notification toggle posts the change', async () => {
    render(<Bookings session={session} />);
    fireEvent.click(await screen.findByLabelText('My booked server is ready'));
    await waitFor(() => expect(mockBookings.setPref).toHaveBeenCalledWith('booking_ready', false));
  });

  it('a closed switch says so', async () => {
    const { ApiError } = await import('../api');
    mockBookings.mine.mockRejectedValue(new ApiError(404, 'not found'));
    render(<Bookings session={session} />);
    expect(await screen.findByText('Booked servers are not open yet.')).toBeTruthy();
  });
});
```

`web/src/routes/Booking.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';

const { mockBookings } = vi.hoisted(() => ({ mockBookings: { get: vi.fn(), act: vi.fn(), cancel: vi.fn() } }));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, bookingsApi: mockBookings };
});
const { Booking } = await import('./Booking');

const VIEW = (over: Record<string, unknown> = {}) => ({
  id: 7, purpose: 'scrim', state: 'ready', ending: false, startsAt: '2026-10-02T20:00:00.000Z', endsAt: '2026-10-02T22:00:00.000Z',
  extendedMinutes: 0, extendMinutes: 30, createdAt: '2026-10-01T12:00:00.000Z', playlist: [{ slug: 'no_mercy', name: 'No Mercy' }], rules: null,
  gameConfig: { key: 'standard', label: 'Standard' }, server: { name: 'Riverside #3' },
  connect: { host: '1.2.3.4', port: 27015, password: 'abcd2345' }, cancel: null, endReason: null, noShowFrom: '2026-10-02T20:15:00.000Z',
  sides: [
    { side: 'a', name: "p0's group", team: null, captain: { steamid: 'x0', name: 'p0' }, confirmed: true, peakPresent: 0, noShow: false, people: [{ steamid: 'x0', name: 'p0', avatar: null, role: 'player', status: 'accepted' }] },
    { side: 'b', name: 'Mice', team: { id: 1, slug: 'mice', name: 'Mice', tag: 'MM', logoKey: null }, captain: { steamid: 'x1', name: 'p1' }, confirmed: true, peakPresent: 0, noShow: false, people: [] },
  ],
  viewer: { side: 'a', manages: ['a'], staff: false, invited: false },
  ...over,
});
const session = { kind: 'active', me: { steamid: 'x0', name: 'p0', avatar: null, status: 'active', isAdmin: false, teams: true } } as never;

afterEach(() => { cleanup(); for (const f of Object.values(mockBookings)) f.mockReset(); });
beforeEach(() => { mockBookings.get.mockResolvedValue(VIEW()); });

describe('Booking page', () => {
  it('shows the connect line when ready', async () => {
    render(<Booking id="7" session={session} />);
    expect(await screen.findByText('connect 1.2.3.4:27015; password abcd2345')).toBeTruthy();
  });

  it('a manager sees Cancel, Extend and no connect line before ready', async () => {
    mockBookings.get.mockResolvedValue(VIEW({ state: 'scheduled', connect: null, server: null }));
    render(<Booking id="7" session={session} />);
    expect(await screen.findByRole('button', { name: 'Cancel booking' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Extend 30 min' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'End now' })).toBeNull();
    expect(screen.queryByText(/connect /)).toBeNull();
  });

  it('an invited person sees Accept', async () => {
    mockBookings.get.mockResolvedValue(VIEW({ viewer: { side: 'a', manages: [], staff: false, invited: true }, connect: null }));
    render(<Booking id="7" session={session} />);
    expect(await screen.findByRole('button', { name: 'Accept' })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd web && npx vitest run src/bookingTime.test.ts src/routes/Bookings.test.tsx src/routes/Booking.test.tsx`
Expected: FAIL, modules not found.

- [ ] **Step 3: Add the API types and calls**

In `web/src/api.ts`, after the `teamsApi` block:

```ts
// ---------- bookings ----------

export type BookingState = 'scheduled' | 'held' | 'setup' | 'ready' | 'active' | 'ended' | 'cancelled' | 'no_show';
export type BookingSide = 'a' | 'b';
export type BookingRole = 'player' | 'ringer' | 'spectator';
export interface BookingOptions {
  campaigns: { slug: string; name: string; minutes: number }[];
  rulesets: { id: number; name: string }[];
  gameConfigs: { key: string; label: string }[];
  limits: { minMinutes: number; maxMinutes: number; daysAhead: number; playlistMax: number; stepMinutes: number; extendMinutes: number };
  myTeams: { id: number; slug: string; name: string; tag: string }[];
  teams: { id: number; slug: string; name: string; tag: string }[];
}
export interface BookingSummary {
  id: number; state: BookingState; ending: boolean; startsAt: string; endsAt: string; aName: string; bName: string;
  mySide: BookingSide | null; needs: 'confirm' | 'accept' | null;
}
export interface NotifyPref { type: string; label: string; enabled: boolean }
export interface BookingPerson { steamid: string; name: string; avatar: string | null; role: BookingRole; status: 'invited' | 'accepted' }
export interface BookingSideView {
  side: BookingSide; name: string; team: { id: number; slug: string; name: string; tag: string; logoKey: string | null } | null;
  captain: { steamid: string; name: string }; confirmed: boolean; peakPresent: number; noShow: boolean; people: BookingPerson[];
}
export interface BookingView {
  id: number; purpose: 'scrim' | 'tournament'; state: BookingState; ending: boolean; startsAt: string; endsAt: string;
  extendedMinutes: number; extendMinutes: number; createdAt: string; playlist: { slug: string; name: string }[];
  rules: { noShowGraceMinutes: number } | null; gameConfig: { key: string; label: string };
  sides: BookingSideView[]; server: { name: string } | null; connect: { host: string; port: number; password: string } | null;
  cancel: { side: BookingSide | null; reason: string | null } | null; endReason: string | null; noShowFrom: string;
  viewer: { side: BookingSide | null; manages: BookingSide[]; staff: boolean; invited: boolean };
}
export interface NewBooking {
  teamId: number | null; opponent: { teamId: number } | { steamid: string }; startsAt: string; minutes: number;
  playlist: string[]; rulesetId?: number; gameConfig?: string;
}

export const bookingsApi = {
  options: (signal?: AbortSignal) => get<BookingOptions>('/api/bookings/options', signal),
  mine: (signal?: AbortSignal) => get<{ open: BookingSummary[]; recent: BookingSummary[]; prefs: NotifyPref[] }>('/api/bookings/mine', signal),
  get: (id: number | string, signal?: AbortSignal) => get<BookingView>(`/api/bookings/${enc(String(id))}`, signal),
  create: (b: NewBooking) => post<{ id: number }>('/api/bookings', b),
  act: (id: number, action: 'confirm' | 'decline' | 'accept' | 'leave' | 'extend' | 'no-show' | 'end') =>
    post<BookingView>(`/api/bookings/${id}/${action}`),
  cancel: (id: number, reason: string) => post<BookingView>(`/api/bookings/${id}/cancel`, { reason }),
  addPerson: (id: number, side: BookingSide, steamid: string, role: BookingRole) =>
    post<BookingView>(`/api/bookings/${id}/people`, { side, steamid, role }),
  removePerson: (id: number, steamid: string) => post<BookingView>(`/api/bookings/${id}/people/${enc(steamid)}/remove`),
  setPref: (type: string, enabled: boolean) => post<{ prefs: NotifyPref[] }>('/api/bookings/prefs', { type, enabled }),
};

export interface AdminBookingRow {
  id: number; state: BookingState; ending: boolean; startsAt: string; endsAt: string; aName: string; bName: string;
  server: string | null; peak: { a: number; b: number }; endReason: string | null;
}
```

and in `adminApi` add:

```ts
  bookings: (signal?: AbortSignal) => get<{ bookings: AdminBookingRow[] }>('/api/admin/bookings', signal),
  cancelBooking: (id: number, reason: string) => post(`/api/admin/bookings/${id}/cancel`, { reason }),
  extendBooking: (id: number) => post(`/api/admin/bookings/${id}/extend`),
  endBooking: (id: number) => post(`/api/admin/bookings/${id}/end`),
```

- [ ] **Step 4: Write `web/src/bookingTime.ts`**

```ts
/** A `datetime-local` value ("2026-10-02T20:00") read in the viewer's own
 *  time zone, as an ISO string; null when empty or unreadable. */
export function toUtcIso(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  const t = new Date(local).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** "Fri 2 Oct, 20:00" in the viewer's zone. */
export function localLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** The spec's "warns when the playlist will not fit". */
export function fitWarning(minutes: number, playlistMinutes: number): string | null {
  return playlistMinutes > minutes
    ? `These campaigns usually take about ${playlistMinutes} minutes; the booking is ${minutes}. Extend later, or pick fewer.`
    : null;
}
```

- [ ] **Step 5: Write `web/src/routes/Bookings.tsx`**

```tsx
import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { ApiError, bookingsApi, teamsApi, type BookingOptions, type BookingSummary, type NotifyPref } from '../api';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import type { Session } from '../hooks/useLiveState';
import { fitWarning, localLabel, toUtcIso } from '../bookingTime';

const STATE_LABEL: Record<BookingSummary['state'], string> = {
  scheduled: 'Booked', held: 'Server taken', setup: 'Setting up', ready: 'Ready', active: 'Playing',
  ended: 'Over', cancelled: 'Cancelled', no_show: 'No-show',
};

function Row({ b, busy, act }: { b: BookingSummary; busy: boolean; act: (fn: () => Promise<unknown>) => void }) {
  return (
    <li class="bookingrow">
      <a href={`/booking/${b.id}`}>{b.aName} vs {b.bName}</a>
      <span class="muted">{localLabel(b.startsAt)} · {b.ending && b.state !== 'cancelled' ? 'Closing' : STATE_LABEL[b.state]}</span>
      {b.needs === 'confirm' && <>
        <button class="btn" disabled={busy} onClick={() => act(() => bookingsApi.act(b.id, 'confirm'))}>Confirm</button>
        <button class="btn btn--ghost" disabled={busy} onClick={() => act(() => bookingsApi.act(b.id, 'decline'))}>Decline</button>
      </>}
      {b.needs === 'accept' && <>
        <button class="btn" disabled={busy} onClick={() => act(() => bookingsApi.act(b.id, 'accept'))}>Accept</button>
        <button class="btn btn--ghost" disabled={busy} onClick={() => act(() => bookingsApi.act(b.id, 'leave'))}>Decline</button>
      </>}
    </li>
  );
}

function BookForm({ options, onError }: { options: BookingOptions; onError: (e: string | null) => void }) {
  const { route } = useLocation();
  const [teamId, setTeamId] = useState<number | null>(options.myTeams[0]?.id ?? null);
  const [against, setAgainst] = useState<'team' | 'player'>('team');
  const [oppTeam, setOppTeam] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ steamid: string; name: string }[]>([]);
  const [oppPlayer, setOppPlayer] = useState<{ steamid: string; name: string } | null>(null);
  const [when, setWhen] = useState('');
  const [minutes, setMinutes] = useState(options.limits.minMinutes * 2 <= options.limits.maxMinutes ? options.limits.minMinutes * 2 : options.limits.minMinutes);
  const [playlist, setPlaylist] = useState<string[]>([]);
  const [rulesetId, setRulesetId] = useState<number | undefined>(options.rulesets.find((r) => r.name === 'Casual Scrim')?.id);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return; }
    const ctl = new AbortController();
    teamsApi.search(q.trim(), ctl.signal).then((r) => setFound(r.players), () => {});
    return () => ctl.abort();
  }, [q]);

  const lengths: number[] = [];
  for (let m = options.limits.minMinutes; m <= options.limits.maxMinutes; m += options.limits.stepMinutes) lengths.push(m);
  const playMinutes = playlist.reduce((s, slug) => s + (options.campaigns.find((c) => c.slug === slug)?.minutes ?? 60), 0);
  const warning = playlist.length > 0 ? fitWarning(minutes, playMinutes) : null;
  const toggle = (slug: string) => setPlaylist((p) => p.includes(slug) ? p.filter((s) => s !== slug) : p.length < options.limits.playlistMax ? [...p, slug] : p);

  const submit = async (ev: Event) => {
    ev.preventDefault();
    onError(null);
    const startsAt = toUtcIso(when);
    if (!startsAt) { onError('Pick a start time.'); return; }
    const opponent = against === 'team' ? (oppTeam !== null ? { teamId: oppTeam } : null) : (oppPlayer ? { steamid: oppPlayer.steamid } : null);
    if (!opponent) { onError('Pick who you are playing against.'); return; }
    setBusy(true);
    try {
      const { id } = await bookingsApi.create({ teamId, opponent, startsAt, minutes, playlist, rulesetId });
      route(`/booking/${id}`);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="bookform" onSubmit={submit}>
      <label>Your side
        <select aria-label="Your side" value={teamId === null ? '' : String(teamId)} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; setTeamId(v ? Number(v) : null); }}>
          {options.myTeams.map((t) => <option key={t.id} value={String(t.id)}>[{t.tag}] {t.name}</option>)}
          <option value="">A pickup group (just me for now)</option>
        </select>
      </label>
      <fieldset>
        <legend>Against</legend>
        <label><input type="radio" checked={against === 'team'} onChange={() => setAgainst('team')} /> A team</label>
        <label><input type="radio" checked={against === 'player'} onChange={() => setAgainst('player')} /> A player and their group</label>
        {against === 'team'
          ? <select aria-label="Opponent team" value={oppTeam === null ? '' : String(oppTeam)} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; setOppTeam(v ? Number(v) : null); }}>
              <option value="">Pick a team</option>
              {options.teams.filter((t) => t.id !== teamId).map((t) => <option key={t.id} value={String(t.id)}>[{t.tag}] {t.name}</option>)}
            </select>
          : <div class="bookform__search">
              {oppPlayer
                ? <span>{oppPlayer.name} <button type="button" class="btn btn--ghost" onClick={() => setOppPlayer(null)}>Change</button></span>
                : <>
                    <input aria-label="Find a player" value={q} placeholder="Player name" onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
                    <ul>{found.map((p) => <li key={p.steamid}><button type="button" class="btn btn--ghost" onClick={() => { setOppPlayer(p); setQ(''); }}>{p.name}</button></li>)}</ul>
                  </>}
            </div>}
      </fieldset>
      <label>Start (your time)<input aria-label="Start" type="datetime-local" value={when} onInput={(e) => setWhen((e.target as HTMLInputElement).value)} /></label>
      <label>Length
        <select aria-label="Length" value={String(minutes)} onChange={(e) => setMinutes(Number((e.target as HTMLSelectElement).value))}>
          {lengths.map((m) => <option key={m} value={String(m)}>{m / 60} h</option>)}
        </select>
      </label>
      <fieldset>
        <legend>Campaigns (up to {options.limits.playlistMax}, in play order)</legend>
        {options.campaigns.map((c) => (
          <label key={c.slug}>
            <input type="checkbox" aria-label={c.name} checked={playlist.includes(c.slug)} onChange={() => toggle(c.slug)} />
            {c.name}
            <span class="muted"> · about {c.minutes} min{playlist.includes(c.slug) ? ` · #${playlist.indexOf(c.slug) + 1}` : ''}</span>
          </label>
        ))}
        {warning && <p class="warning">{warning}</p>}
      </fieldset>
      {options.rulesets.length > 1 && (
        <label>Rules
          <select aria-label="Rules" value={rulesetId === undefined ? '' : String(rulesetId)} onChange={(e) => setRulesetId(Number((e.target as HTMLSelectElement).value))}>
            {options.rulesets.map((r) => <option key={r.id} value={String(r.id)}>{r.name}</option>)}
          </select>
        </label>
      )}
      <button class="btn" type="submit" disabled={busy || playlist.length === 0}>Book the server</button>
    </form>
  );
}

export function Bookings({ session }: { session: Session }) {
  const signedIn = session.kind === 'active';
  const [mine, setMine] = useState<{ open: BookingSummary[]; recent: BookingSummary[]; prefs: NotifyPref[] } | null>(null);
  const [options, setOptions] = useState<BookingOptions | null>(null);
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    if (!signedIn) return;
    bookingsApi.mine().then(setMine, (e) => { if (e instanceof ApiError && e.status === 404) setClosed(true); });
    bookingsApi.options().then(setOptions, () => {});
  };
  useEffect(load, [signedIn]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try { await fn(); load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  if (!signedIn || closed) {
    return <main class="page page--profile bookingpage"><PageHeader title="Bookings" /><Empty>{closed ? 'Booked servers are not open yet.' : 'Sign in to book a server.'}</Empty></main>;
  }
  return (
    <main class="page page--profile bookingpage">
      <PageHeader title="Bookings" />
      {error && <p class="error" role="alert">{error}</p>}
      <Panel>
        <h3>Your bookings</h3>
        {mine === null ? null : mine.open.length === 0
          ? <Empty>Nothing booked.</Empty>
          : <ul class="bookinglist">{mine.open.map((b) => <Row key={b.id} b={b} busy={busy} act={act} />)}</ul>}
      </Panel>
      {options && (
        <Panel>
          <h3>Book a server</h3>
          <BookForm options={options} onError={setError} />
        </Panel>
      )}
      {mine && mine.recent.length > 0 && (
        <Panel>
          <h3>Recent</h3>
          <ul class="bookinglist">{mine.recent.map((b) => <Row key={b.id} b={b} busy={busy} act={act} />)}</ul>
        </Panel>
      )}
      {mine && (
        <Panel>
          <h3>Discord messages</h3>
          {mine.prefs.map((p) => (
            <label key={p.type} class="bookingpref">
              <input type="checkbox" aria-label={p.label} checked={p.enabled} disabled={busy}
                onChange={() => act(() => bookingsApi.setPref(p.type, !p.enabled))} />
              {p.label}
            </label>
          ))}
        </Panel>
      )}
    </main>
  );
}

export default Bookings;
```

- [ ] **Step 6: Write `web/src/routes/Booking.tsx`**

```tsx
import { useEffect, useState } from 'preact/hooks';
import { bookingsApi, teamsApi, type BookingRole, type BookingSide, type BookingView } from '../api';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import type { Session } from '../hooks/useLiveState';
import { localLabel } from '../bookingTime';

const STATE_LINE: Record<BookingView['state'], string> = {
  scheduled: 'Booked. The server is taken and set up 15 minutes before the start.',
  held: 'Taking the server.', setup: 'Setting the server up.', ready: 'The server is ready.', active: 'Playing.',
  ended: 'Over.', cancelled: 'Cancelled.', no_show: 'Ended: a side did not show.',
};
const ROLE_LABEL: Record<BookingRole, string> = { player: 'Player', ringer: 'Ringer', spectator: 'Spectator' };

function AddPerson({ id, side, onDone }: { id: number; side: BookingSide; onDone: (v: BookingView) => void }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ steamid: string; name: string }[]>([]);
  const [role, setRole] = useState<BookingRole>('player');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return; }
    const ctl = new AbortController();
    teamsApi.search(q.trim(), ctl.signal).then((r) => setFound(r.players), () => {});
    return () => ctl.abort();
  }, [q]);
  const add = async (steamid: string) => {
    setError(null);
    try { onDone(await bookingsApi.addPerson(id, side, steamid, role)); setQ(''); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <div class="bookingadd">
      <input aria-label="Add a player" value={q} placeholder="Add someone by name" onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      <select aria-label="Role" value={role} onChange={(e) => setRole((e.target as HTMLSelectElement).value as BookingRole)}>
        {(['player', 'ringer', 'spectator'] as const).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
      </select>
      <ul>{found.map((p) => <li key={p.steamid}><button class="btn btn--ghost" onClick={() => add(p.steamid)}>{p.name}</button></li>)}</ul>
      {error && <p class="error" role="alert">{error}</p>}
    </div>
  );
}

export function Booking({ id, session }: { id: string; session: Session }) {
  const [v, setV] = useState<BookingView | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');

  const load = () => { bookingsApi.get(id).then(setV, () => setMissing(true)); };
  useEffect(load, [id]);
  useEffect(() => {
    // The state moves on its own (held, ready, active): re-read while it can.
    if (!v || v.ending || ['ended', 'cancelled', 'no_show'].includes(v.state)) return;
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [v?.state, v?.ending]);

  const act = async (fn: () => Promise<BookingView>) => {
    setError(null);
    setBusy(true);
    try { setV(await fn()); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  if (missing || session.kind !== 'active') return <main class="page page--profile bookingpage"><PageHeader title="Booking" /><Empty>No such booking.</Empty></main>;
  if (!v) return null;
  const manages = v.viewer.manages.length > 0 || v.viewer.staff;
  const open = !v.ending && ['scheduled', 'held', 'setup', 'ready', 'active'].includes(v.state);
  const running = open && (v.state === 'ready' || v.state === 'active');
  const [a, b] = v.sides;
  const unconfirmedB = !b.confirmed;

  return (
    <main class="page page--profile bookingpage">
      <PageHeader eyebrow="Booked server" title={`${a.name} vs ${b.name}`}>
        <p>{localLabel(v.startsAt)} to {localLabel(v.endsAt)}{v.extendedMinutes > 0 ? ` (extended ${v.extendedMinutes} min)` : ''} · {v.playlist.map((c) => c.name).join(', ')}</p>
      </PageHeader>
      {error && <p class="error" role="alert">{error}</p>}
      <Panel>
        <p>{v.ending && v.state !== 'cancelled' && v.state !== 'no_show' ? 'Closing.' : STATE_LINE[v.state]}{v.cancel?.reason ? ` Reason: ${v.cancel.reason}` : ''}</p>
        {v.connect && (
          <p class="bookingconnect">In the game console: <code>{`connect ${v.connect.host}:${v.connect.port}; password ${v.connect.password}`}</code></p>
        )}
        {v.viewer.invited && v.viewer.manages.length === 0 && open && (
          <p>
            <button class="btn" disabled={busy} onClick={() => act(() => bookingsApi.act(v.id, 'accept'))}>Accept</button>
            <button class="btn btn--ghost" disabled={busy} onClick={() => act(() => bookingsApi.act(v.id, 'leave'))}>Decline</button>
          </p>
        )}
        {unconfirmedB && v.viewer.manages.includes('b') && open && (
          <p>
            <button class="btn" disabled={busy} onClick={() => act(() => bookingsApi.act(v.id, 'confirm'))}>Confirm</button>
            <button class="btn btn--ghost" disabled={busy} onClick={() => act(() => bookingsApi.act(v.id, 'decline'))}>Decline</button>
          </p>
        )}
      </Panel>
      {v.sides.map((s) => (
        <Panel key={s.side}>
          <h3>{s.name}{!s.confirmed ? ' (not confirmed yet)' : ''}{s.noShow ? ' · no-show' : ''}</h3>
          <ul class="bookingpeople">
            {s.people.map((p) => (
              <li key={p.steamid}>
                <span>{p.name}</span>
                <span class="muted"> · {ROLE_LABEL[p.role]}{p.status === 'invited' ? ' · invited' : ''}{p.steamid === s.captain.steamid ? ' · captain' : ''}</span>
                {open && v.viewer.manages.includes(s.side) && p.steamid !== s.captain.steamid && (
                  <button class="btn btn--ghost" disabled={busy} onClick={() => act(() => bookingsApi.removePerson(v.id, p.steamid))}>Remove</button>
                )}
              </li>
            ))}
          </ul>
          {open && s.confirmed && v.viewer.manages.includes(s.side) && <AddPerson id={v.id} side={s.side} onDone={setV} />}
        </Panel>
      ))}
      {manages && open && (
        <Panel>
          <h3>Booking</h3>
          <p>
            <button class="btn btn--ghost" disabled={busy} onClick={() => act(() => bookingsApi.act(v.id, 'extend'))}>Extend {v.extendMinutes} min</button>
            {running && <button class="btn btn--ghost" disabled={busy} onClick={() => act(() => bookingsApi.act(v.id, 'end'))}>End now</button>}
            {running && Date.now() >= Date.parse(v.noShowFrom) && (
              <button class="btn btn--ghost" disabled={busy} onClick={() => act(() => bookingsApi.act(v.id, 'no-show'))}>They did not show</button>
            )}
          </p>
          <p>
            <input aria-label="Cancel reason" value={reason} maxLength={300} placeholder="Reason (optional, only the two sides and staff see it)"
              onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
            <button class="btn btn--danger" disabled={busy} onClick={() => act(() => bookingsApi.cancel(v.id, reason))}>Cancel booking</button>
          </p>
        </Panel>
      )}
    </main>
  );
}

export default Booking;
```

- [ ] **Step 7: Routes and nav**

`web/src/AppRoutes.tsx`, next to the Teams lazies:

```ts
const Bookings = lazy(() => import('./routes/Bookings'));
const Booking = lazy(() => import('./routes/Booking'));
```

and next to the team routes:

```tsx
      <Route path="/bookings" component={Bookings} session={session} />
      <Route path="/booking/:id" component={Booking} session={session} />
```

`web/src/components/Nav.tsx`: the Teams line becomes

```ts
  // Teams and Bookings only for viewers the competitive switch lets in (/api/me teams).
  const links = me?.teams
    ? [...NAV_LINKS.slice(0, 5), ['/teams', 'Teams'] as const, ['/bookings', 'Bookings'] as const, ...NAV_LINKS.slice(5)]
    : NAV_LINKS;
```

and in `isCurrent` add `if (href === '/bookings') return path === '/bookings' || path.startsWith('/booking/');` under the `/teams` line. Add CSS for `.bookingrow`, `.bookform`, `.bookingpeople`, `.bookingconnect` next to the `.teamcard` / `.teamform` rules in `web/src/styles/app.css`, reusing their spacing and colour tokens. Keep it to layout: flex rows with a gap, the form as a one-column grid at phone width.

- [ ] **Step 8: Run the web tests, typecheck and build**

Run: `cd web && npx vitest run src/bookingTime.test.ts src/routes/Bookings.test.tsx src/routes/Booking.test.tsx src/routes/routes.test.tsx && npm run typecheck && npm run build`
Expected: PASS and a clean build. If `routes.test.tsx` lists every route, add the two new paths to it.

- [ ] **Step 9: Commit**

```bash
git add web/src/api.ts web/src/bookingTime.ts web/src/bookingTime.test.ts web/src/routes/Bookings.tsx web/src/routes/Booking.tsx web/src/routes/Bookings.test.tsx web/src/routes/Booking.test.tsx web/src/AppRoutes.tsx web/src/components/Nav.tsx web/src/styles/app.css
git commit -m "Bookings web: list and book page, booking page with connect line and captain actions, Discord message toggles, nav link"
```


---

### Task 11: Staff panel on the Live desk

**Files:**
- Create: `web/src/routes/admin/BookingsPanel.tsx`
- Modify: `web/src/routes/admin/AdminLive.tsx` (render it next to `PracticeLeasesPanel`)
- Test: `web/src/routes/admin/BookingsPanel.test.tsx`

**Interfaces:**
- Consumes: `adminApi.bookings`, `cancelBooking`, `extendBooking`, `endBooking` (Task 10 Step 3); `useAction` and `useFetch` as `PracticeLeasesPanel` uses them.
- Produces: `BookingsPanel({ nudge }: { nudge: number })`, which renders nothing when there are no rows.

- [ ] **Step 1: Write the failing test**

`web/src/routes/admin/BookingsPanel.test.tsx` (same mocking as `PracticeLeasesPanel.test.tsx`):

```tsx
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { AdminBookingRow } from '../../api';

const { mockAdmin, mockConfirm } = vi.hoisted(() => ({
  mockAdmin: { bookings: vi.fn(), cancelBooking: vi.fn(), extendBooking: vi.fn(), endBooking: vi.fn() },
  mockConfirm: vi.fn(),
}));
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
vi.mock('../../components/Confirm', () => ({ confirm: mockConfirm }));
const { BookingsPanel } = await import('./BookingsPanel');

const ROW: AdminBookingRow = {
  id: 4, state: 'active', ending: false, startsAt: '2026-10-02T20:00:00.000Z', endsAt: '2026-10-02T22:00:00.000Z',
  aName: 'Rats', bName: "p1's group", server: 'Riverside #3', peak: { a: 4, b: 3 }, endReason: null,
};

afterEach(cleanup);
beforeEach(() => { for (const fn of [...Object.values(mockAdmin), mockConfirm]) fn.mockReset(); });

describe('BookingsPanel', () => {
  it('lists bookings with their server and turnout, with Cancel, Extend and End', async () => {
    mockAdmin.bookings.mockResolvedValue({ bookings: [ROW] });
    render(<BookingsPanel nudge={0} />);
    expect(await screen.findByText("Rats vs p1's group")).toBeTruthy();
    expect(screen.getByText('Riverside #3')).toBeTruthy();
    expect(screen.getByText('4 / 3')).toBeTruthy();
    for (const name of ['Cancel', 'Extend', 'End']) expect(screen.getByRole('button', { name })).toBeTruthy();
  });

  it('Cancel asks first, then cancels', async () => {
    mockAdmin.bookings.mockResolvedValue({ bookings: [ROW] });
    mockConfirm.mockResolvedValue(true);
    mockAdmin.cancelBooking.mockResolvedValue({ ok: true });
    render(<BookingsPanel nudge={0} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(mockAdmin.cancelBooking).toHaveBeenCalledWith(4, ''));
    expect(mockConfirm).toHaveBeenCalled();
  });

  it('renders nothing with no bookings', async () => {
    mockAdmin.bookings.mockResolvedValue({ bookings: [] });
    const { container } = render(<BookingsPanel nudge={0} />);
    await waitFor(() => expect(mockAdmin.bookings).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd web && npx vitest run src/routes/admin/BookingsPanel.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `web/src/routes/admin/BookingsPanel.tsx`**

```tsx
import { adminApi, type AdminBookingRow } from '../../api';
import { Panel } from '../../components/bits';
import { useFetch } from '../../hooks/useFetch';
import { localLabel } from '../../bookingTime';
import { useAction } from './useAction';

const STATE_LABEL: Record<AdminBookingRow['state'], string> = {
  scheduled: 'booked', held: 'server taken', setup: 'setting up', ready: 'ready', active: 'playing',
  ended: 'over', cancelled: 'cancelled', no_show: 'no-show',
};

/**
 * Booked servers on the live board (plan 4a; the spec's "calendar of bookings
 * on the admin Live desk"): every open booking and those that ended in the
 * last day, soonest first, with the box each one holds and the most people
 * of each side seen on it. Cancel here counts against neither side. Omits
 * itself when there is nothing to show.
 */
export function BookingsPanel({ nudge }: { nudge: number }) {
  const list = useFetch((s) => adminApi.bookings(s), [nudge]);
  const { busy, error, run } = useAction(() => list.reload());
  const rows = list.data?.bookings ?? [];
  if (rows.length === 0) return null;
  return (
    <Panel class="panel--table">
      <h3>Booked servers</h3>
      {error && <p class="error" role="alert">{error}</p>}
      <div class="table-wrap">
        <table class="admin-table">
          <thead><tr><th>Booking</th><th>When</th><th>State</th><th>Server</th><th>On it (peak)</th><th /></tr></thead>
          <tbody>
            {rows.map((b) => {
              const open = !b.ending && ['scheduled', 'held', 'setup', 'ready', 'active'].includes(b.state);
              const running = open && (b.state === 'ready' || b.state === 'active');
              return (
                <tr key={b.id}>
                  <td><a href={`/booking/${b.id}`}>{b.aName} vs {b.bName}</a></td>
                  <td>{localLabel(b.startsAt)} to {localLabel(b.endsAt)}</td>
                  <td>{STATE_LABEL[b.state]}{b.endReason ? ` (${b.endReason})` : ''}</td>
                  <td>{b.server ?? ''}</td>
                  <td>{b.peak.a} / {b.peak.b}</td>
                  <td>
                    {open && <button class="btn btn--ghost" disabled={busy}
                      onClick={() => run(() => adminApi.cancelBooking(b.id, ''), { title: `Cancel ${b.aName} vs ${b.bName}?`, body: 'Both sides are told. It counts against neither side.', confirmLabel: 'Cancel booking', danger: true })}>Cancel</button>}
                    {open && <button class="btn btn--ghost" disabled={busy} onClick={() => run(() => adminApi.extendBooking(b.id))}>Extend</button>}
                    {running && <button class="btn btn--ghost" disabled={busy}
                      onClick={() => run(() => adminApi.endBooking(b.id), { title: `End ${b.aName} vs ${b.bName} now?`, body: 'Everyone on the server is kicked and the box restarts.', confirmLabel: 'End now', danger: true })}>End</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
```

`run(fn, ask)` takes `ConfirmOptions` (`web/src/components/Confirm.tsx`: `title`, `body`, `confirmLabel`, `danger`), as the practice panel's End does.

In `web/src/routes/admin/AdminLive.tsx`, import it and render `<BookingsPanel nudge={nudge} />` directly above `<PracticeLeasesPanel ... />`.

- [ ] **Step 4: Run the tests and build**

Run: `cd web && npx vitest run src/routes/admin/ && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/admin/BookingsPanel.tsx web/src/routes/admin/BookingsPanel.test.tsx web/src/routes/admin/AdminLive.tsx
git commit -m "Live desk: booked servers panel with Cancel, Extend and End"
```

---

## After the last task

- [ ] Run the whole suite (`npm test`, and `cd web && npm test`), `npm run typecheck` in both, and `cd web && npm run build`. All green before review.
- [ ] Whole-branch review against this plan and the spec section 3.
- [ ] Hand-off notes for the owner, none of which this plan does:
  1. Stage `plugin/l4d_booking.smx` on every pool box through the normal restart staging (`deploy/tools/stage-on-restart.sh`). Setup refuses a box without it, so until every box has it, keep the switch on `admins`.
  2. Web deploy as usual. Nothing shows until Settings > Competitive > "Teams and competitive for" leaves Nobody, and the new booking settings appear in that group.
  3. Try it with the switch on `admins`: book a slot 20 minutes ahead against a second admin account, confirm, watch the Live desk panel take a box at T-15, connect with the DM'd line, check that `tv_password` on the box is not the standing one, then End.
  4. Open the switch to everyone only after plan 4b (games recorded, playlist, allowlist).
