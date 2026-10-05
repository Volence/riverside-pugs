# Tournaments plan T1b: registration, check-in and seeding

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A captain or co-captain of a site team registers it for an open team event with a roster picked from its members (4 starters, the event's subs, at most one coach). Every player is checked against the event's entry rules and the one-entry-per-player rule, and the captain sees exactly who fails and why. Captains edit the roster, withdraw, and check in during the check-in window; a player can leave a roster. Teams over the cap wait in a waitlist. A minute tick opens check-in on time and, when it closes, drops teams that did not check in, fills from the waitlist and seeds the rest by average SR. Staff watch and fix all of it from the Events desk.

**Architecture:** A pure module `src/events/entryRules.ts` holds every entry rule that needs no database: roster shape, eligibility problems and their sentences, waitlist placement, seed order, the check-in window and the roster lock. A new writer `src/events/entries.ts` owns `event_entries` and `event_entry_players`; like `events.ts`, each mutation is one transaction that re-reads, checks, writes and adds exactly one `event_log` row (through `logEvent`, now exported from `events.ts`). The one status move this plan adds (`registration -> checkin`) is `openCheckin` in `events.ts`; finalising the entry list sets a new `events.locked_at` column inside `lockEntries` in `entries.ts`. An `EventRunner` minute tick (like `ScrimBoard`) drives the clock and sends three new DM types through the existing `Notifier`. Public routes in `src/routes/events.ts` gain the viewer's own entry view, the captain actions and an entry logo route; the desk in `src/routes/adminEvents.ts` gains an entries view and the staff actions. The web event page gets a registration and entry panel, and the desk editor an Entries section.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Fastify 5, better-sqlite3, vitest (`npm test`, `npx vitest run <file>`), `npm run typecheck` (server and web), `npm run build`; Preact + preact-iso + @testing-library/preact (happy-dom) for the web.

**Spec:** `docs/superpowers/specs/2026-09-30-competitive-tournaments-design.md`, section 1 (Eligibility, Check-in, Roster rules), section 2 (Entries and seeding), Error handling (one transaction with an audit row), Rollout item 1 (second half). T1a (`docs/superpowers/plans/2026-10-01-tournaments-1a-events.md`) built the tables, the desk and the read-only page this plan extends; read its "Rulings" section first.

## Global Constraints

- Only team events take registrations in T1b (`entry_kind = 'team'`); a draft-kind event keeps refusing with `draft_signups_later`.
- Entrants are site teams only (owner, 2026-10-05). `event_entries.team_id` is always set by this plan; pickup rosters (team_id null) are not built.
- A roster is exactly 4 starters, 0 to the event's `roster.maxSubs` subs and 0 or 1 coach, every SteamID once. Registration needs all 4 starters.
- One entry per player per event: a player holds at most one active place across the event's active entries (status not `dropped`, `disqualified`). Checked at registration, at every roster change, at check-in and at restore. An entry is not a team membership and does not touch the 3-team cap.
- Eligibility per player (spec section 1): good standing (`inGoodStanding`), let in by `competitive_enabled` (`competitiveAccess`), at least `minPugs` completed PUGs (`completedPug('m')`, voided matches not counted), Discord linked when `requireDiscord`, current-season display SR inside `srFloor`/`srCeiling` when set. A coach needs only standing, the switch and Discord.
- Check-in is a captain action (owner, 2026-10-05): a captain or co-captain presses Check in; every rostered player is re-checked at that moment.
- The team cap is a waitlist (owner, 2026-10-05): active entries past the cap, in registration order, wait; when the list is finalised the first `team_cap` ready entries stay and the rest drop with `over_cap`.
- The clock moves the event (owner, 2026-10-05): with check-in on, `registration -> checkin` at `starts_at - opensMinutes` and the list is finalised at `starts_at - closesMinutes`; with check-in off the list is finalised at `starts_at`. Admins can do either step early from the desk.
- Seeding: average current-season display SR of the 4 active starters, highest first, ties by registration order (spec section 2). Staff reorder seeds after the list is final and before the event goes live.
- `event_entries.name`, `tag`, `logo_key` are snapshots: taken from the team at registration, refreshed once when the list is finalised, never after.
- Every write to `event_entries`, `event_entry_players`, `events` and `event_log` is in `src/events/events.ts` or `src/events/entries.ts` (plus the account merge's own lines in `src/mergePlayers.ts`); every mutation there is one transaction that writes exactly one `event_log` row on success and nothing on refusal. Admin routes also `logAdmin`.
- Public routes follow `competitive_enabled` exactly as T1a's do (a closed switch is a 404). A draft event and everything under it (entries, logos) is a 404 to anyone but staff.
- Never write em dashes in code, comments, copy, commits or docs.
- Commit messages follow the repo style (plain sentence). Do not push. Do not deploy, restart, stage or rcon any live box.
- Several Claude sessions use `/home/volence/l4d/pug`: work in a worktree branch (`tournaments-t1b`); check `git reflog -10` and `git status` before any write on master.

## Rulings this plan makes (for the owner to confirm)

Owner answers of 2026-10-05: site teams only; captain check-in; waitlist over the cap; the clock moves registration (rulings 1 to 4). The rest are decided here:

1. **Entrants are site teams.** A captain or co-captain registers a live team; every new roster player must be a current member of that team. Pickup rosters wait for a later plan.
2. **Captain check-in.** One press by a captain or co-captain, during the window, with exactly 4 starters on the roster and every rostered player passing eligibility and the one-entry rule at that moment.
3. **Waitlist.** Placement is computed, not stored: active entries in registration order, the first `team_cap` are in, the rest are waitlisted with a position. A withdrawal moves the next team up by itself. Waitlisted teams can and should check in.
4. **Clock.** `EventRunner` ticks every minute. `registration -> checkin` at `starts_at - opensMinutes`; at `starts_at - closesMinutes` `lockEntries` drops entries that did not check in (`no_checkin`), then drops ready entries past the cap (`over_cap`), refreshes snapshots, seeds, and sets `events.locked_at`. Check-in off: at `starts_at`, entries with fewer than 4 starters drop (`incomplete`), then the cap and seeding as above. The event stays in `checkin` (or `registration`) with `locked_at` set; going `live` and building the first stage belong to rollout plan 2.
5. **Registration closes when check-in opens** (or at the start when check-in is off, or as soon as the list is final). No late registration during check-in.
6. **Roster edits** (captain or co-captain) are allowed while the event is in `registration`, `checkin` or `live` and the roster lock has not been reached. Lock `at` is reached at that time; lock `after_round` is never reached in T1b (no rounds are played yet; rollout plan 3 counts them). `maxAdditions` counts players added after registration (registration itself counts nothing); staff edits ignore both the lock and the limit.
7. **Players added by someone else are told** by DM (`event_roster_added`) and can leave the roster from the event page while the event is in `registration` or `checkin`. A starter leaving a checked-in entry undoes its check-in (it no longer has 4 starters).
8. **Withdraw** (captain or co-captain) is allowed until the list is final; after that a team that will not play is a forfeit (rollout plan 3) or a staff disqualification.
9. **A team disbanded before the list is final** has its entry dropped by the tick (`team_disbanded`). After it is final, staff decide.
10. **Staff tools on the desk** (admins act, mods read): open check-in now, finalise the list now, reorder seeds, edit any roster (any active player, ignoring the lock and the additions limit, still bound by eligibility and the one-entry rule), disqualify with a reason (any time before `finished`/`cancelled`), restore a dropped or disqualified entry before the list is final.
11. **Three new DM types**, each switchable on the notifications page like the booking and scrim ones: `event_checkin_open` (to the managers of every active entry, waitlisted included), `event_dropped` (to the managers of an entry the tick or the lock drops), `event_roster_added`.
12. **What the public sees:** entries with their snapshot name, tag and logo, a Checked in mark during check-in, a Waitlist mark with its position, and seeds once the list is final. SR is never shown publicly; the desk shows each entry's average SR.
13. **Snapshot refresh at finalise.** A team renamed or re-logoed between registration and the final list shows its new name in the bracket; after the list is final nothing follows the team.
14. **Unknown or merged SteamIDs** in a roster fail eligibility (`standing`), so the insert never reaches the players foreign key.

## Not in this plan (and why)

- Pickup rosters and draft signups: later plans (draft spec part 3).
- Going `live`, generating the first stage, brackets: rollout plan 2.
- Forfeits, `!sub`, roster lock `after_round`: rollout plan 3 (needs matches and rounds).
- Admin feed sentences for the new `event_*` admin actions: they render with the generic fallback today, like T1a's.
- A team page "Events" section: the event page carries everything this plan needs.

## Review Focus

- **Two captains of one team racing to register, or one player put on two teams' rosters at the same moment.** One wins, the other is refused (`already_entered` / `player_entered`); the partial unique index and the in-transaction re-read both hold. Task 3 tests both orders.
- **The clock passing several thresholds while the server was down.** Restarted after `closesAt`, the tick first opens check-in (and DMs) and on the next tick finalises; it never finalises a `registration`-status event with check-in on, and never runs a step twice. Task 5 tests.
- **A player who becomes ineligible after registering** (banned, Discord unlinked). The captain's next roster save and the check-in are refused naming that player, and the captain can remove them. Task 4 tests.
- **A waitlisted team that checked in when a placed team did not.** At finalise the waitlisted team takes the spot; the order among ready teams is registration order, not check-in order. Task 4 tests.
- **A logo key probed through the entry logo route.** Served only while an entry of an event the viewer may see holds it; a draft's entry logo is a 404 to a player; a team logo key no entry holds is a 404 on this route. Task 6 tests.

---

## File map

| File | Responsibility |
|---|---|
| `src/db.ts` | `events.locked_at`; `event_entries.checked_in_at`, `checked_in_by`, `dropped_at`, `drop_reason`, `additions`; one active entry per team per event (partial unique index). |
| `src/mergePlayers.ts` | `event_entries.checked_in_by` follows a merged account. |
| `src/rating.ts` | `UNRATED_SR` and `seasonSr` move here from `src/scrims/rules.ts`, exported. |
| `src/scrims/rules.ts` | Uses `seasonSr` instead of its private copy. |
| `src/events/validate.ts` | Entry error codes, `EntryProblem`, `fail` with detail, `registration -> checkin` allowed. |
| `src/events/entryRules.ts` | Pure: roster shape, eligibility problems and sentences, placement, seed order, check-in window, roster lock, drop reasons. |
| `src/events/events.ts` | `logEvent` exported; `openCheckin`. |
| `src/events/entries.ts` | Reads and every write to the two entry tables, plus `locked_at`. |
| `src/events/messages.ts` | The three event DMs. |
| `src/events/runner.ts` | `EventRunner`: the minute tick. |
| `src/events/views.ts` | Public entries list, the viewer's own entry view, the desk entries view. |
| `src/notify/notify.ts` | Three new `NotifyType`s. |
| `src/routes/events.ts` | `GET /api/events/:slug/mine`, register, roster, withdraw, check-in, leave, entry logos. |
| `src/routes/adminEvents.ts` | Desk entries view and staff actions. |
| `src/server.ts` | Wires `EventRunner` and passes `notifier`/`publicUrl` to `eventRoutes`. |
| `tests/entryFixture.ts` | Shared fixture: an event in registration, two teams of eligible players. |
| `web/src/api.ts` | Entry types, `ApiError.problems`, calls. |
| `web/src/routes/event/EntryPanel.tsx`, `RosterPicker.tsx` | Register, the viewer's entry, check-in, withdraw, leave. |
| `web/src/routes/Event.tsx` | Entries list with logos and marks; mounts `EntryPanel`. |
| `web/src/routes/admin/events/EntriesPanel.tsx`, `EventEditor.tsx` | The desk's Entries section. |
| `web/src/styles/app.css` | Styles for the above. |

---

### Task 1: Schema, merge and one SR helper

**Files:**
- Modify: `src/db.ts` (SCHEMA, after `CREATE INDEX IF NOT EXISTS event_entries_event ON event_entries (event_id);`; migrations, after `ensureColumn(db, 'team_members', 'left_reason', 'TEXT');`)
- Modify: `src/mergePlayers.ts` (`PLAIN` list, after `['event_entries', 'registered_by'],`)
- Modify: `src/rating.ts`, `src/scrims/rules.ts`
- Test: `tests/eventsSchema.test.ts` (add cases), `tests/mergePlayers.test.ts` (one case), `tests/seasonSr.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: columns `events.locked_at TEXT`, `event_entries.checked_in_at TEXT`, `checked_in_by TEXT`, `dropped_at TEXT`, `drop_reason TEXT`, `additions INTEGER NOT NULL DEFAULT 0`; index `event_entries_team_active`; `export const UNRATED_SR: number` and `export function seasonSr(db: DB, steamid: string, seasonId: number): number` in `src/rating.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/eventsSchema.test.ts` (it already opens a db and makes event `cup` with player `A` in its `beforeEach`; reuse them):

```ts
describe('T1b columns', () => {
  it('adds the lock, check-in and drop columns', () => {
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('events')).toContain('locked_at');
    expect(cols('event_entries')).toEqual(expect.arrayContaining(['checked_in_at', 'checked_in_by', 'dropped_at', 'drop_reason', 'additions']));
  });

  it('allows one active entry per team per event, and another once the first is dropped', () => {
    db.prepare("INSERT INTO teams (name, name_key, tag, tag_key, slug, captain_steamid, created_by, created_at) VALUES ('Rats', 'rats', 'RAT', 'RAT', 'rats', ?, ?, '2026-10-01')").run(A, A);
    const team = (db.prepare("SELECT id FROM teams WHERE slug = 'rats'").get() as { id: number }).id;
    const add = () => db.prepare("INSERT INTO event_entries (event_id, team_id, name, registered_by, created_at) VALUES (?, ?, 'Rats', ?, '2026-10-01')").run(cup, team, A);
    add();
    expect(add).toThrow(/UNIQUE/);
    db.prepare("UPDATE event_entries SET status = 'dropped' WHERE event_id = ?").run(cup);
    expect(add).not.toThrow();
  });
});
```

If the file's `beforeEach` does not create an event named `cup`, read the top of the file and use whatever event id it creates.

Add to `tests/mergePlayers.test.ts`, inside its main `describe`, following the shape of the existing event case (search the file for `event_entries`):

```ts
it('moves event_entries.checked_in_by to the surviving account', () => {
  // Arrange exactly as the existing event_entries.registered_by case does,
  // then also set checked_in_by to the alt.
  db.prepare('UPDATE event_entries SET checked_in_by = ? WHERE id = ?').run(ALT, entryId);
  mergePlayers(db, { from: ALT, into: MAIN });
  expect((db.prepare('SELECT checked_in_by AS v FROM event_entries WHERE id = ?').get(entryId) as { v: string }).v).toBe(MAIN);
});
```

Use the names (`ALT`, `MAIN`, `entryId`, the `mergePlayers` call shape) the existing event case in that file uses; copy its arrange block.

Create `tests/seasonSr.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { upsertPlayer, currentSeasonId } from '../src/players.js';
import { UNRATED_SR, displaySr, seasonSr } from '../src/rating.js';

describe('seasonSr', () => {
  it('reads a rated player and gives an unrated one the starting SR without writing a row', () => {
    const db = openDb(':memory:');
    const season = currentSeasonId(db);
    upsertPlayer(db, { steamid: '76561199000000901', name: 'a', avatar: null }, []);
    upsertPlayer(db, { steamid: '76561199000000902', name: 'b', avatar: null }, []);
    db.prepare('INSERT INTO player_ratings (player_id, season_id, mu, sigma) VALUES (?, ?, 30, 2)').run('76561199000000901', season);
    expect(seasonSr(db, '76561199000000901', season)).toBe(displaySr(30, 2));
    expect(seasonSr(db, '76561199000000902', season)).toBe(UNRATED_SR);
    expect(db.prepare('SELECT COUNT(*) AS n FROM player_ratings WHERE player_id = ?').get('76561199000000902')).toEqual({ n: 0 });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/eventsSchema.test.ts tests/mergePlayers.test.ts tests/seasonSr.test.ts`
Expected: FAIL (missing columns, no unique index, `seasonSr` not exported).

- [ ] **Step 3: Implement**

In `src/db.ts` SCHEMA, right after `CREATE INDEX IF NOT EXISTS event_entries_event ON event_entries (event_id);`:

```sql
-- One active entry per team per event (plan T1b). A dropped entry frees the
-- team to register again; a disqualified one does not.
CREATE UNIQUE INDEX IF NOT EXISTS event_entries_team_active ON event_entries (event_id, team_id)
  WHERE team_id IS NOT NULL AND status <> 'dropped';
```

In the migrations, right after `ensureColumn(db, 'team_members', 'left_reason', 'TEXT');`:

```ts
  // Tournaments plan T1b. locked_at: when the event's entry list became
  // final (check-in closed, or the start with check-in off). An entry's
  // check-in, its drop, and how many players were added after registration
  // (the event's maxAdditions). drop_reason is one of src/events/entryRules.ts
  // DROP_REASONS.
  ensureColumn(db, 'events', 'locked_at', 'TEXT');
  ensureColumn(db, 'event_entries', 'checked_in_at', 'TEXT');
  ensureColumn(db, 'event_entries', 'checked_in_by', 'TEXT');
  ensureColumn(db, 'event_entries', 'dropped_at', 'TEXT');
  ensureColumn(db, 'event_entries', 'drop_reason', 'TEXT');
  ensureColumn(db, 'event_entries', 'additions', 'INTEGER NOT NULL DEFAULT 0');
```

In `src/mergePlayers.ts` `PLAIN`, after `['event_entries', 'registered_by'],`:

```ts
  ['event_entries', 'checked_in_by'],
```

In `src/rating.ts`, after `displaySr`:

```ts
/** The SR a player with no rating row yet shows: openskill's own defaults,
 *  the ones ensureRating (src/players.ts) would write for them. */
export const UNRATED_SR = displaySr(rating().mu, rating().sigma);

/** A player's display SR in a season, read without writing a rating row.
 *  Scrim sides and event seeding both use it. */
export function seasonSr(db: DB, steamid: string, seasonId: number): number {
  const row = db.prepare('SELECT mu, sigma FROM player_ratings WHERE player_id = ? AND season_id = ?')
    .get(steamid, seasonId) as { mu: number; sigma: number } | undefined;
  return row ? displaySr(row.mu, row.sigma) : UNRATED_SR;
}
```

In `src/scrims/rules.ts`: delete the private `UNRATED_SR` and `srOf`, import `seasonSr` (and drop the now unused `rating` import from openskill if nothing else in the file uses it), and replace both `srOf(db, ...)` calls in `sideSr` with `seasonSr(db, ...)`. Keep the doc comment above `sideSr`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/eventsSchema.test.ts tests/mergePlayers.test.ts tests/seasonSr.test.ts tests/db.test.ts tests/scrimRules.test.ts`
Expected: PASS (if `tests/scrimRules.test.ts` does not exist, run `npx vitest run tests/scrim` instead).

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/mergePlayers.ts src/rating.ts src/scrims/rules.ts tests/eventsSchema.test.ts tests/mergePlayers.test.ts tests/seasonSr.test.ts
git commit -m "Event entries: lock, check-in and drop columns, one active entry per team per event, seasonSr shared by scrims and events"
```

---

### Task 2: The pure entry rules

**Files:**
- Create: `src/events/entryRules.ts`
- Modify: `src/events/validate.ts` (error table, `Checked`, `fail`, `nextStatusAllowed`)
- Test: `tests/entryRules.test.ts` (new), `tests/eventsValidate.test.ts` (one case)

**Interfaces:**
- Consumes: `Eligibility`, `Checkin`, `RosterLock`, `RosterRules`, `Checked`, `ok`, `fail` from `validate.ts`.
- Produces (all exported from `src/events/entryRules.ts`):
  - `type Role = 'starter' | 'sub' | 'coach'`; `const STARTERS = 4`; `interface Roster { starters: string[]; subs: string[]; coach: string | null }`
  - `const DROP_REASONS = ['withdrawn', 'no_checkin', 'over_cap', 'incomplete', 'team_disbanded'] as const`; `type DropReason`; `DROP_TEXT: Record<DropReason, string>`
  - `type Problem = 'closed' | 'standing' | 'pugs' | 'discord' | 'sr_low' | 'sr_high'`; `interface PlayerFacts { open: boolean; good: boolean; pugs: number; discord: boolean; sr: number }`
  - `problemsOf(e: Eligibility, f: PlayerFacts, role: Role): Problem[]`; `problemText(p: Problem, e: Eligibility, f: PlayerFacts): string`
  - `parseEntryRoster(raw: unknown, rules: RosterRules): Checked<Roster>`; `rosterList(r: Roster): { steamid: string; role: Role }[]`
  - `interface Placement { placed: number[]; waitlist: number[] }`; `placeEntries(rows: { id: number; created_at: string; status: string }[], cap: number | null): Placement`
  - `seedOrder(rows: { id: number; sr: number; created_at: string }[]): number[]`; `averageSr(srs: number[]): number`
  - `checkinTimes(startsAt: string, c: Checkin): { opensAt: string; closesAt: string }`; `rosterLocked(lock: RosterLock, now: string): boolean`
- In `validate.ts`: `interface EntryProblem { steamid: string; problems: string[] }`; `Checked<T>` failure gains `detail?: EntryProblem[]`; `fail(error, detail?)`; new error keys listed in Step 3; `nextStatusAllowed('registration', 'checkin') === true`.

- [ ] **Step 1: Write the failing tests**

`tests/entryRules.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as R from '../src/events/entryRules.js';
import { defaultEligibility, defaultRoster, nextStatusAllowed } from '../src/events/validate.js';

const S = (n: number) => `765611990000${String(n).padStart(5, '0')}`;
const facts = (over: Partial<R.PlayerFacts> = {}): R.PlayerFacts => ({ open: true, good: true, pugs: 10, discord: true, sr: 1500, ...over });

describe('problemsOf', () => {
  const e = { ...defaultEligibility(), srFloor: 1000, srCeiling: 2000 };
  it('passes an eligible player', () => expect(R.problemsOf(e, facts(), 'starter')).toEqual([]));
  it('names every failing rule', () => {
    expect(R.problemsOf(e, facts({ good: false, open: false, pugs: 2, discord: false, sr: 900 }), 'starter'))
      .toEqual(['standing', 'closed', 'pugs', 'discord', 'sr_low']);
    expect(R.problemsOf(e, facts({ sr: 2100 }), 'sub')).toEqual(['sr_high']);
  });
  it('holds a coach only to standing, the switch and Discord', () => {
    expect(R.problemsOf(e, facts({ pugs: 0, sr: 50 }), 'coach')).toEqual([]);
    expect(R.problemsOf(e, facts({ discord: false }), 'coach')).toEqual(['discord']);
  });
  it('skips Discord when the event does not require it', () => {
    expect(R.problemsOf({ ...e, requireDiscord: false }, facts({ discord: false }), 'starter')).toEqual([]);
  });
  it('says each problem as a sentence with the numbers', () => {
    expect(R.problemText('pugs', e, facts({ pugs: 2 }))).toBe('2 of 5 completed PUGs');
    expect(R.problemText('sr_low', e, facts({ sr: 900 }))).toBe('SR 900 is below the floor of 1000');
    expect(R.problemText('sr_high', e, facts({ sr: 2100 }))).toBe('SR 2100 is above the ceiling of 2000');
  });
});

describe('parseEntryRoster', () => {
  const rules = defaultRoster(); // maxSubs 2
  it('takes 4 starters, subs up to the limit and one coach', () => {
    const r = R.parseEntryRoster({ starters: [S(1), S(2), S(3), S(4)], subs: [S(5)], coach: S(6) }, rules);
    expect(r).toEqual({ ok: true, value: { starters: [S(1), S(2), S(3), S(4)], subs: [S(5)], coach: S(6) } });
  });
  it('defaults subs to none and coach to null', () => {
    expect(R.parseEntryRoster({ starters: [S(1), S(2), S(3), S(4)] }, rules)).toEqual({ ok: true, value: { starters: [S(1), S(2), S(3), S(4)], subs: [], coach: null } });
  });
  it.each([
    ['three starters', { starters: [S(1), S(2), S(3)] }],
    ['five starters', { starters: [S(1), S(2), S(3), S(4), S(5)] }],
    ['too many subs', { starters: [S(1), S(2), S(3), S(4)], subs: [S(5), S(6), S(7)] }],
    ['a player twice', { starters: [S(1), S(2), S(3), S(4)], subs: [S(1)] }],
    ['coach also a starter', { starters: [S(1), S(2), S(3), S(4)], coach: S(1) }],
    ['not a SteamID', { starters: [S(1), S(2), S(3), 'bob'] }],
    ['not an object', 'roster'],
  ])('refuses %s', (_, raw) => expect(R.parseEntryRoster(raw, rules)).toEqual({ ok: false, error: 'bad_entry_roster' }));
});

describe('placeEntries', () => {
  const row = (id: number, at: string, status = 'registered') => ({ id, created_at: at, status });
  it('places in registration order up to the cap and waitlists the rest, skipping dropped', () => {
    const rows = [row(3, '2026-10-02'), row(1, '2026-10-01'), row(2, '2026-10-01T05'), row(4, '2026-10-03', 'dropped'), row(5, '2026-10-04')];
    expect(R.placeEntries(rows, 2)).toEqual({ placed: [1, 2], waitlist: [3, 5] });
    expect(R.placeEntries(rows, null)).toEqual({ placed: [1, 2, 3, 5], waitlist: [] });
  });
  it('breaks a tie on the timestamp by id', () => {
    expect(R.placeEntries([row(9, 'x'), row(7, 'x')], 1)).toEqual({ placed: [7], waitlist: [9] });
  });
});

describe('seedOrder and averageSr', () => {
  it('seeds highest SR first, ties by registration order then id', () => {
    expect(R.seedOrder([
      { id: 1, sr: 1500, created_at: '2026-10-02' }, { id: 2, sr: 1800, created_at: '2026-10-03' },
      { id: 3, sr: 1500, created_at: '2026-10-01' }, { id: 4, sr: 1500, created_at: '2026-10-01' },
    ])).toEqual([2, 3, 4, 1]);
  });
  it('averages and rounds, 0 for none', () => {
    expect(R.averageSr([1000, 1001])).toBe(1001);
    expect(R.averageSr([])).toBe(0);
  });
});

describe('checkinTimes and rosterLocked', () => {
  it('counts the window back from the start', () => {
    expect(R.checkinTimes('2026-10-10T20:00:00.000Z', { enabled: true, opensMinutes: 60, closesMinutes: 15 }))
      .toEqual({ opensAt: '2026-10-10T19:00:00.000Z', closesAt: '2026-10-10T19:45:00.000Z' });
  });
  it('locks at a time once it passes, never on after_round in T1b, never on none', () => {
    expect(R.rosterLocked({ kind: 'at', at: '2026-10-05T00:00:00.000Z' }, '2026-10-04T23:59:59.000Z')).toBe(false);
    expect(R.rosterLocked({ kind: 'at', at: '2026-10-05T00:00:00.000Z' }, '2026-10-05T00:00:00.000Z')).toBe(true);
    expect(R.rosterLocked({ kind: 'after_round', stage: 1, round: 2 }, '2030-01-01T00:00:00.000Z')).toBe(false);
    expect(R.rosterLocked({ kind: 'none' }, '2030-01-01T00:00:00.000Z')).toBe(false);
  });
});

describe('nextStatusAllowed', () => {
  it('lets registration move to check-in', () => expect(nextStatusAllowed('registration', 'checkin')).toBe(true));
});
```

In `tests/eventsValidate.test.ts`, if any case asserts `nextStatusAllowed('registration', 'checkin')` is `false`, change it to expect `true` (T1b adds that move); leave every other expectation alone.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/entryRules.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

In `src/events/validate.ts`:

Add these keys to `EVENT_ERRORS`, after `has_entries`:

```ts
  bad_entry_roster: { status: 400, text: 'A roster is exactly 4 starters, no more subs than the event allows and at most one coach, each player once.' },
  not_registration: { status: 409, text: 'Registration is not open for this event.' },
  team_not_found: { status: 404, text: 'No such team.' },
  not_manager: { status: 403, text: 'Only the team captain or a co-captain can do that.' },
  already_entered: { status: 409, text: 'This team already has an entry in this event.' },
  not_on_team: { status: 400, text: 'Everyone added to the roster has to be on the team.' },
  player_ineligible: { status: 409, text: 'Someone on the roster does not meet the entry rules.' },
  player_entered: { status: 409, text: 'Someone on the roster is already on another entry in this event.' },
  entry_not_found: { status: 404, text: 'No such entry in this event.' },
  entry_out: { status: 409, text: 'This entry is no longer in the event.' },
  roster_locked: { status: 409, text: 'Rosters are locked for this event; ask staff to change yours.' },
  additions_used: { status: 409, text: 'This entry has used all the roster additions the event allows.' },
  not_on_entry: { status: 400, text: 'You are not on this roster.' },
  entries_locked: { status: 409, text: 'The entry list is final now.' },
  no_checkin: { status: 409, text: 'This event has no check-in.' },
  not_checkin: { status: 409, text: 'Check-in is not open.' },
  need_starters: { status: 409, text: 'Check-in needs 4 starters on the roster.' },
  seeds_locked: { status: 409, text: 'Seeds can change only once the entry list is final and before the event goes live.' },
  bad_seed_order: { status: 400, text: 'The new seed order must list every seeded entry once.' },
  not_restorable: { status: 409, text: 'Only a dropped or disqualified entry can be restored, before the entry list is final.' },
```

Replace the `Checked` type and `fail` helper:

```ts
/** One player a roster refusal is about, with the sentences of what is wrong
 *  (src/events/entryRules.ts problemText). The routes add the player's name. */
export interface EntryProblem { steamid: string; problems: string[] }
export type Checked<T> = { ok: true; value: T } | { ok: false; error: EventError; detail?: EntryProblem[] };
export const ok = <T>(value: T): Checked<T> => ({ ok: true, value });
export const fail = (error: EventError, detail?: EntryProblem[]): { ok: false; error: EventError; detail?: EntryProblem[] } =>
  (detail ? { ok: false, error, detail } : { ok: false, error });
```

Replace `nextStatusAllowed` and its comment:

```ts
/** The moves made so far: T1a's publish, open registration and cancel, and
 *  T1b's open check-in. Live and finished come with rollout plan 2. */
export function nextStatusAllowed(from: EventStatus, to: EventStatus): boolean {
  if (to === 'cancelled') return CANCELLABLE.has(from);
  return (from === 'draft' && to === 'announced') || (from === 'announced' && to === 'registration')
    || (from === 'registration' && to === 'checkin');
}
```

Create `src/events/entryRules.ts`:

```ts
import { fail, ok, type Checked, type Checkin, type Eligibility, type RosterLock, type RosterRules } from './validate.js';

/**
 * Every entry rule that needs no database (tournaments plan T1b): a roster's
 * shape, who is eligible and how to say why not, the waitlist, the seed
 * order, the check-in window and the roster lock. src/events/entries.ts reads
 * the facts and calls these inside its transactions.
 */

export type Role = 'starter' | 'sub' | 'coach';
export const STARTERS = 4;
export interface Roster { starters: string[]; subs: string[]; coach: string | null }

export const DROP_REASONS = ['withdrawn', 'no_checkin', 'over_cap', 'incomplete', 'team_disbanded'] as const;
export type DropReason = (typeof DROP_REASONS)[number];
/** Why an entry is out, as the end of "X is out of the event: ...". */
export const DROP_TEXT: Record<DropReason, string> = {
  withdrawn: 'it was withdrawn',
  no_checkin: 'it did not check in in time',
  over_cap: 'the event was full when the entry list closed',
  incomplete: 'it did not have 4 starters when the entry list closed',
  team_disbanded: 'the team was disbanded',
};

export type Problem = 'closed' | 'standing' | 'pugs' | 'discord' | 'sr_low' | 'sr_high';
export interface PlayerFacts { open: boolean; good: boolean; pugs: number; discord: boolean; sr: number }

/** What keeps a player off a roster in this role. A coach does not play, so
 *  the PUG count and the SR range do not apply to one. */
export function problemsOf(e: Eligibility, f: PlayerFacts, role: Role): Problem[] {
  const out: Problem[] = [];
  if (!f.good) out.push('standing');
  if (!f.open) out.push('closed');
  if (role !== 'coach' && f.pugs < e.minPugs) out.push('pugs');
  if (e.requireDiscord && !f.discord) out.push('discord');
  if (role !== 'coach' && e.srFloor !== null && f.sr < e.srFloor) out.push('sr_low');
  if (role !== 'coach' && e.srCeiling !== null && f.sr > e.srCeiling) out.push('sr_high');
  return out;
}

export function problemText(p: Problem, e: Eligibility, f: PlayerFacts): string {
  switch (p) {
    case 'standing': return 'Account is not in good standing';
    case 'closed': return 'Cannot use competitive features yet';
    case 'pugs': return `${f.pugs} of ${e.minPugs} completed PUGs`;
    case 'discord': return 'Discord is not linked';
    case 'sr_low': return `SR ${f.sr} is below the floor of ${e.srFloor}`;
    case 'sr_high': return `SR ${f.sr} is above the ceiling of ${e.srCeiling}`;
  }
}

const STEAMID = /^\d{17}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const ids = (v: unknown): string[] | null => (Array.isArray(v) && v.every((s) => typeof s === 'string' && STEAMID.test(s)) ? v as string[] : null);

export function parseEntryRoster(raw: unknown, rules: RosterRules): Checked<Roster> {
  if (!isObj(raw)) return fail('bad_entry_roster');
  const starters = ids(raw.starters);
  const subs = raw.subs === undefined ? [] : ids(raw.subs);
  const coach = raw.coach === undefined || raw.coach === null ? null : typeof raw.coach === 'string' && STEAMID.test(raw.coach) ? raw.coach : undefined;
  if (!starters || !subs || coach === undefined) return fail('bad_entry_roster');
  if (starters.length !== STARTERS || subs.length > rules.maxSubs) return fail('bad_entry_roster');
  const all = [...starters, ...subs, ...(coach ? [coach] : [])];
  if (new Set(all).size !== all.length) return fail('bad_entry_roster');
  return ok({ starters, subs, coach });
}

export function rosterList(r: Roster): { steamid: string; role: Role }[] {
  return [
    ...r.starters.map((steamid) => ({ steamid, role: 'starter' as const })),
    ...r.subs.map((steamid) => ({ steamid, role: 'sub' as const })),
    ...(r.coach ? [{ steamid: r.coach, role: 'coach' as const }] : []),
  ];
}

export interface Placement { placed: number[]; waitlist: number[] }

const byRegistration = (a: { id: number; created_at: string }, b: { id: number; created_at: string }) =>
  (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id);

/** Ruling 3: computed, never stored. Active entries in registration order;
 *  the first `cap` are in, the rest wait in that order. */
export function placeEntries(rows: { id: number; created_at: string; status: string }[], cap: number | null): Placement {
  const active = rows.filter((r) => r.status !== 'dropped' && r.status !== 'disqualified').sort(byRegistration).map((r) => r.id);
  return cap === null ? { placed: active, waitlist: [] } : { placed: active.slice(0, cap), waitlist: active.slice(cap) };
}

/** Spec section 2: highest average SR first, ties by registration order. */
export function seedOrder(rows: { id: number; sr: number; created_at: string }[]): number[] {
  return [...rows].sort((a, b) => b.sr - a.sr || byRegistration(a, b)).map((r) => r.id);
}

export function averageSr(srs: number[]): number {
  return srs.length === 0 ? 0 : Math.round(srs.reduce((a, b) => a + b, 0) / srs.length);
}

export function checkinTimes(startsAt: string, c: Checkin): { opensAt: string; closesAt: string } {
  const start = Date.parse(startsAt);
  return {
    opensAt: new Date(start - c.opensMinutes * 60_000).toISOString(),
    closesAt: new Date(start - c.closesMinutes * 60_000).toISOString(),
  };
}

/** Ruling 6: a lock `at` a time holds from that time; `after_round` needs
 *  played rounds, which arrive with rollout plan 3, so it never holds yet. */
export function rosterLocked(lock: RosterLock, now: string): boolean {
  return lock.kind === 'at' && now >= lock.at;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/entryRules.test.ts tests/eventsValidate.test.ts tests/events.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/events/entryRules.ts src/events/validate.ts tests/entryRules.test.ts tests/eventsValidate.test.ts
git commit -m "Event entries: pure rules for rosters, eligibility sentences, waitlist placement, seed order, the check-in window and the roster lock"
```

---

### Task 3: Registration, roster changes, leaving and withdrawing

**Files:**
- Create: `src/events/entries.ts`, `tests/entryFixture.ts`, `tests/entries.test.ts`
- Modify: `src/events/events.ts` (export `logEvent`), `tests/eventLogGuard.test.ts`

**Interfaces:**
- Consumes: Task 1 columns and `seasonSr`; Task 2 everything; `E.getEvent`, `E.fieldsOf`; `activeMembers`, `getTeam` from `src/teams/teams.ts`; `inGoodStanding`; `competitiveAccess`; `completedPug`; `currentSeasonId`, `getPlayer`.
- Produces (exported from `src/events/entries.ts`):
  - `type EntryStatus`; `interface EntryRow` (every `event_entries` column); `interface PlaceRow`
  - reads: `getEntry(db, id)`, `entriesOf(db, eventId): EntryRow[]` (registration order), `placesOf(db, entryId): PlaceRow[]`, `rosterOf(db, entryId): R.Roster`, `entryOfTeam(db, eventId, teamId)`, `entryOfPlayer(db, eventId, steamid)`, `placementOf(db, ev: E.EventRow): R.Placement`, `managersOf(db, teamId: number | null): string[]`, `playerFacts(db, steamid, now?): R.PlayerFacts`, `entrySr(db, entryId): number`, `isActive(e: EntryRow): boolean`
  - mutations: `registerEntry(db, { eventId, teamId, by, roster, now? }): V.Checked<{ entry: EntryRow; added: { steamid: string; role: R.Role }[] }>`, `setEntryRoster(db, { entryId, by, roster, staff?, now? })` (same value shape), `leaveEntry(db, { entryId, steamid, now? }): V.Checked<EntryRow>`, `withdrawEntry(db, { entryId, by, now? }): V.Checked<EntryRow>`
  - `event_log` actions: `entry_registered`, `roster_changed`, `roster_left`, `entry_withdrawn`
- From `src/events/events.ts`: `export function logEvent(db, eventId, actor: string | null, action: string, at: string, detail?: object): void` (inside the caller's transaction).

- [ ] **Step 1: Write the fixture**

`tests/entryFixture.ts`:

```ts
import { openDb, type DB } from '../src/db.js';
import { activatePlayer, upsertPlayer } from '../src/players.js';
import * as T from '../src/teams/teams.js';
import * as E from '../src/events/events.js';
import { ADMIN, NOW, START, must, stageBody } from './eventFixture.js';

/** Two teams of eligible players and an event in registration (plan T1b).
 *  Team A: captain a[0], co-captain a[1], members a[2..5]. Team B: captain
 *  b[0], members b[1..4]. OUTSIDER is active and eligible but on no team.
 *  Everyone has Discord linked; the event asks for no PUGs so nobody needs a
 *  match history unless a test gives eligibility rules of its own. */
export const A = ['801', '802', '803', '804', '805', '806'].map((n) => `76561199000000${n}`);
export const B = ['811', '812', '813', '814', '815'].map((n) => `76561199000000${n}`);
export const OUTSIDER = '76561199000000820';

export interface EntryFixture { db: DB; eventId: number; teamA: number; teamB: number }

/** startsAt defaults to the fixed START. Tests that go through HTTP run on the
 *  wall clock (the routes pass no `now`), so they must pass a start relative
 *  to Date.now(): a fixed date would make them fail once it passes, as the
 *  scrim and booking route tests did on 2026-10-02. */
export function entryFixture(o: { checkin?: boolean; teamCap?: number | null; eligibility?: object; roster?: object; startsAt?: string } = {}): EntryFixture {
  const db = openDb(':memory:');
  db.prepare("UPDATE settings SET value = 'everyone' WHERE key = 'competitive_enabled'").run();
  upsertPlayer(db, { steamid: ADMIN, name: 'boss', avatar: null }, [ADMIN]);
  [...A, ...B, OUTSIDER].forEach((s, i) => {
    upsertPlayer(db, { steamid: s, name: `p${i}`, avatar: null }, []);
    activatePlayer(db, s);
    db.prepare('UPDATE players SET discord_id = ? WHERE steamid = ?').run(`d${i}`, s);
  });
  const team = (members: string[], name: string, tag: string): number => {
    const t = T.createTeam(db, { creator: members[0], name, tag, now: NOW });
    if (!t.ok) throw new Error(t.error);
    const link = T.setJoinLink(db, { teamId: t.value.id, by: members[0], on: true });
    if (!link.ok || !link.value.token) throw new Error('no join link');
    for (const m of members.slice(1)) {
      const j = T.joinByLink(db, { token: link.value.token, steamid: m, now: NOW });
      if (!j.ok) throw new Error(j.error);
    }
    return t.value.id;
  };
  const teamA = team(A, 'Rats', 'RAT');
  const teamB = team(B, 'Bats', 'BAT');
  const r = T.setRole(db, { teamId: teamA, by: A[0], target: A[1], role: 'cocaptain' });
  if (!r.ok) throw new Error(r.error);

  const ev = must(E.createEvent(db, {
    by: ADMIN, now: NOW,
    fields: {
      name: 'Riverside Cup', startsAt: o.startsAt ?? START, entryKind: 'team', teamCap: o.teamCap ?? null,
      eligibility: o.eligibility ?? { minPugs: 0, requireDiscord: true },
      checkin: { enabled: o.checkin ?? true, opensMinutes: 60, closesMinutes: 15 },
      roster: o.roster ?? { maxSubs: 2 },
    },
  }));
  must(E.addStage(db, { eventId: ev.id, by: ADMIN, stage: stageBody(db, { advanceCount: null }), now: NOW }));
  must(E.publishEvent(db, { eventId: ev.id, by: ADMIN, now: NOW }));
  must(E.openRegistration(db, { eventId: ev.id, by: ADMIN, now: NOW }));
  return { db, eventId: ev.id, teamA, teamB };
}

export const rosterA = (over: object = {}) => ({ starters: A.slice(0, 4), subs: [A[4]], coach: null, ...over });
export const rosterB = (over: object = {}) => ({ starters: B.slice(0, 4), subs: [], coach: null, ...over });
```

Check `T.setJoinLink` and `T.setRole` signatures in `src/teams/teams.ts` (lines around 330 and 418) and adapt the calls if they differ; the fixture must build through the teams API, not raw inserts.

- [ ] **Step 2: Write the failing tests**

`tests/entries.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as N from '../src/events/entries.js';
import * as T from '../src/teams/teams.js';
import { NOW } from './eventFixture.js';
import { A, B, OUTSIDER, entryFixture, rosterA, rosterB } from './entryFixture.js';

const later = (min: number) => new Date(NOW.getTime() + min * 60_000);
const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};

describe('registerEntry', () => {
  it('registers a team with its roster, name, tag and logo snapshot', () => {
    const f = entryFixture();
    f.db.prepare("UPDATE teams SET logo_key = ? WHERE id = ?").run('c'.repeat(64), f.teamA);
    const { entry, added } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[1], roster: rosterA(), now: NOW }));
    expect(entry).toMatchObject({ team_id: f.teamA, name: 'Rats', tag: 'RAT', logo_key: 'c'.repeat(64), status: 'registered', registered_by: A[1], additions: 0 });
    expect(N.rosterOf(f.db, entry.id)).toEqual({ starters: A.slice(0, 4), subs: [A[4]], coach: null });
    expect(added.map((p) => p.steamid)).toEqual(A.slice(0, 5));
  });

  it('refuses a plain member, a second entry for the team, and a closed registration', () => {
    const f = entryFixture();
    expect(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[3], roster: rosterA(), now: NOW })).toEqual({ ok: false, error: 'not_manager' });
    must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    expect(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[1], roster: rosterA(), now: NOW })).toEqual({ ok: false, error: 'already_entered' });
    f.db.prepare("UPDATE events SET status = 'checkin' WHERE id = ?").run(f.eventId);
    expect(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamB, by: B[0], roster: rosterB(), now: NOW })).toEqual({ ok: false, error: 'not_registration' });
  });

  it('refuses a roster player who is not on the team', () => {
    const f = entryFixture();
    const r = N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA({ subs: [OUTSIDER] }), now: NOW });
    expect(r).toEqual({ ok: false, error: 'not_on_team' });
  });

  it('names every ineligible player and why', () => {
    const f = entryFixture({ eligibility: { minPugs: 1, requireDiscord: true } });
    f.db.prepare('UPDATE players SET discord_id = NULL WHERE steamid = ?').run(A[2]);
    const r = N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA({ subs: [] }), now: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('player_ineligible');
    expect(r.detail).toContainEqual({ steamid: A[2], problems: ['0 of 1 completed PUGs', 'Discord is not linked'] });
    expect(r.detail).toHaveLength(4);
  });

  it('keeps a player to one entry per event, whichever team registers first', () => {
    const f = entryFixture();
    const link = must(T.setJoinLink(f.db, { teamId: f.teamB, by: B[0], on: true }));
    must(T.joinByLink(f.db, { token: link.token!, steamid: A[3], now: NOW }));
    must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamB, by: B[0], roster: rosterB({ subs: [A[3]] }), now: NOW }));
    const r = N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('player_entered');
    expect(r.detail).toEqual([{ steamid: A[3], problems: ["Already on Bats's roster"] }]);
  });

  it('lets a withdrawn team register again', () => {
    const f = entryFixture();
    const { entry } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    must(N.withdrawEntry(f.db, { entryId: entry.id, by: A[0], now: NOW }));
    expect(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: later(1) }).ok).toBe(true);
  });
});

describe('setEntryRoster', () => {
  it('adds, removes and moves players, counting only additions', () => {
    const f = entryFixture();
    const { entry } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    const { entry: after, added } = must(N.setEntryRoster(f.db, {
      entryId: entry.id, by: A[1], now: later(5),
      roster: { starters: [A[0], A[1], A[2], A[4]], subs: [A[5]], coach: null },
    }));
    expect(N.rosterOf(f.db, entry.id)).toEqual({ starters: [A[0], A[1], A[2], A[4]], subs: [A[5]], coach: null });
    expect(added).toEqual([{ steamid: A[5], role: 'sub' }]);
    expect(after.additions).toBe(1);
    expect(f.db.prepare('SELECT removed_at FROM event_entry_players WHERE entry_id = ? AND steamid = ?').get(entry.id, A[3])).toEqual({ removed_at: later(5).toISOString() });
  });

  it('writes nothing for an unchanged roster', () => {
    const f = entryFixture();
    const { entry } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    const logs = () => (f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }).n;
    const before = logs();
    must(N.setEntryRoster(f.db, { entryId: entry.id, by: A[0], roster: rosterA(), now: NOW }));
    expect(logs()).toBe(before);
  });

  it('honours the addition limit and the roster lock, and staff ignore both', () => {
    const f = entryFixture({ roster: { maxSubs: 2, maxAdditions: 0, lock: { kind: 'at', at: later(60).toISOString() } } });
    const { entry } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    const withSixth = rosterA({ subs: [A[4], A[5]] });
    expect(N.setEntryRoster(f.db, { entryId: entry.id, by: A[0], roster: withSixth, now: later(1) })).toEqual({ ok: false, error: 'additions_used' });
    expect(N.setEntryRoster(f.db, { entryId: entry.id, by: A[0], roster: rosterA({ subs: [] }), now: later(61) })).toEqual({ ok: false, error: 'roster_locked' });
    expect(N.setEntryRoster(f.db, { entryId: entry.id, by: 'staff', staff: true, roster: withSixth, now: later(61) }).ok).toBe(true);
  });

  it('lets staff add a player from outside the team', () => {
    const f = entryFixture();
    const { entry } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    expect(N.setEntryRoster(f.db, { entryId: entry.id, by: A[0], roster: rosterA({ coach: OUTSIDER }), now: NOW })).toEqual({ ok: false, error: 'not_on_team' });
    expect(N.setEntryRoster(f.db, { entryId: entry.id, by: 'staff', staff: true, roster: rosterA({ coach: OUTSIDER }), now: NOW }).ok).toBe(true);
  });
});

describe('leaveEntry and withdrawEntry', () => {
  it('lets a player leave, and undoes a check-in when a starter leaves', () => {
    const f = entryFixture();
    const { entry } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    f.db.prepare("UPDATE events SET status = 'checkin' WHERE id = ?").run(f.eventId);
    f.db.prepare("UPDATE event_entries SET status = 'checked_in', checked_in_at = 'x', checked_in_by = ? WHERE id = ?").run(A[0], entry.id);
    expect(must(N.leaveEntry(f.db, { entryId: entry.id, steamid: A[4], now: NOW })).status).toBe('checked_in');
    const after = must(N.leaveEntry(f.db, { entryId: entry.id, steamid: A[2], now: NOW }));
    expect(after).toMatchObject({ status: 'registered', checked_in_at: null, checked_in_by: null });
    expect(N.leaveEntry(f.db, { entryId: entry.id, steamid: A[2], now: NOW })).toEqual({ ok: false, error: 'not_on_entry' });
  });

  it('withdraws until the list is final, managers only', () => {
    const f = entryFixture();
    const { entry } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    expect(N.withdrawEntry(f.db, { entryId: entry.id, by: A[3], now: NOW })).toEqual({ ok: false, error: 'not_manager' });
    f.db.prepare('UPDATE events SET locked_at = ? WHERE id = ?').run(NOW.toISOString(), f.eventId);
    expect(N.withdrawEntry(f.db, { entryId: entry.id, by: A[0], now: NOW })).toEqual({ ok: false, error: 'entries_locked' });
    f.db.prepare('UPDATE events SET locked_at = NULL WHERE id = ?').run(f.eventId);
    expect(must(N.withdrawEntry(f.db, { entryId: entry.id, by: A[0], now: NOW }))).toMatchObject({ status: 'dropped', drop_reason: 'withdrawn' });
  });
});

describe('placementOf', () => {
  it('waitlists past the cap and moves the next team up after a withdrawal', () => {
    const f = entryFixture({ teamCap: 2 });
    const ea = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW })).entry;
    const eb = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamB, by: B[0], roster: rosterB(), now: later(1) })).entry;
    const ev = () => f.db.prepare('SELECT * FROM events WHERE id = ?').get(f.eventId) as Parameters<typeof N.placementOf>[1];
    expect(N.placementOf(f.db, ev())).toEqual({ placed: [ea.id, eb.id], waitlist: [] });
    f.db.prepare('UPDATE events SET team_cap = 1 WHERE id = ?').run(f.eventId);
    expect(N.placementOf(f.db, ev())).toEqual({ placed: [ea.id], waitlist: [eb.id] });
    must(N.withdrawEntry(f.db, { entryId: ea.id, by: A[0], now: later(2) }));
    expect(N.placementOf(f.db, ev())).toEqual({ placed: [eb.id], waitlist: [] });
  });
});
```

`setJoinLink` returns `{ token }` (plan 3); turning it on again for team B may issue a fresh token, which is why the test uses the one it gets back.

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run tests/entries.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement**

In `src/events/events.ts`, change `function logEvent(` to `export function logEvent(` and extend its comment:

```ts
/** Inside the caller's transaction, always. Exported for src/events/entries.ts
 *  only: tests/eventLogGuard.test.ts holds every caller to one row per
 *  successful mutation. */
```

Create `src/events/entries.ts`:

```ts
import type { DB } from '../db.js';
import { completedPug } from '../matchKinds.js';
import { currentSeasonId, getPlayer } from '../players.js';
import { seasonSr } from '../rating.js';
import { inGoodStanding } from '../standing.js';
import { competitiveAccess } from '../teams/access.js';
import { activeMembers, getTeam } from '../teams/teams.js';
import * as E from './events.js';
import * as R from './entryRules.js';
import * as V from './validate.js';

/**
 * Every write to event_entries and event_entry_players (tournaments plan
 * T1b), and the entry list's lock on events.locked_at. Same shape as
 * src/events/events.ts: each mutation is one transaction that re-reads, checks
 * inside, writes, and adds exactly one event_log row before it commits; a
 * refusal writes nothing. tests/eventLogGuard.test.ts pins both.
 *
 * An entry is not a team membership: a player keeps one place across the
 * event's active entries (status not dropped or disqualified), and the team
 * caps never see entries.
 */

export type EntryStatus = 'registered' | 'checked_in' | 'dropped' | 'disqualified' | 'eliminated' | 'placed';
export interface EntryRow {
  id: number; event_id: number; team_id: number | null; name: string; tag: string; logo_key: string | null; seed: number | null;
  status: EntryStatus; placement: number | null; registered_by: string; created_at: string;
  checked_in_at: string | null; checked_in_by: string | null; dropped_at: string | null; drop_reason: R.DropReason | null; additions: number;
}
export interface PlaceRow { id: number; entry_id: number; steamid: string; role: R.Role; added_at: string; removed_at: string | null }
export type Added = { steamid: string; role: R.Role }[];

const iso = (now?: Date): string => (now ?? new Date()).toISOString();
export const isActive = (e: EntryRow): boolean => e.status !== 'dropped' && e.status !== 'disqualified';
/** Event statuses a roster may change in (Ruling 6). */
const ROSTER_OPEN: ReadonlySet<V.EventStatus> = new Set<V.EventStatus>(['registration', 'checkin', 'live']);
/** Event statuses a player may leave a roster in (Ruling 7). */
const LEAVE_OPEN: ReadonlySet<V.EventStatus> = new Set<V.EventStatus>(['registration', 'checkin']);

export function getEntry(db: DB, id: number): EntryRow | undefined {
  return db.prepare('SELECT * FROM event_entries WHERE id = ?').get(id) as EntryRow | undefined;
}
/** Every entry of the event, dropped ones included, in registration order. */
export function entriesOf(db: DB, eventId: number): EntryRow[] {
  return db.prepare('SELECT * FROM event_entries WHERE event_id = ? ORDER BY created_at, id').all(eventId) as EntryRow[];
}
export function placesOf(db: DB, entryId: number): PlaceRow[] {
  return db.prepare(
    `SELECT * FROM event_entry_players WHERE entry_id = ? AND removed_at IS NULL
     ORDER BY CASE role WHEN 'starter' THEN 0 WHEN 'sub' THEN 1 ELSE 2 END, added_at, id`,
  ).all(entryId) as PlaceRow[];
}
export function rosterOf(db: DB, entryId: number): R.Roster {
  const p = placesOf(db, entryId);
  return {
    starters: p.filter((r) => r.role === 'starter').map((r) => r.steamid),
    subs: p.filter((r) => r.role === 'sub').map((r) => r.steamid),
    coach: p.find((r) => r.role === 'coach')?.steamid ?? null,
  };
}
export function entryOfTeam(db: DB, eventId: number, teamId: number): EntryRow | undefined {
  return db.prepare("SELECT * FROM event_entries WHERE event_id = ? AND team_id = ? AND status NOT IN ('dropped','disqualified')")
    .get(eventId, teamId) as EntryRow | undefined;
}
/** The active entry this player holds a place on in this event, if any. */
export function entryOfPlayer(db: DB, eventId: number, steamid: string): EntryRow | undefined {
  return db.prepare(
    `SELECT e.* FROM event_entries e JOIN event_entry_players p ON p.entry_id = e.id AND p.removed_at IS NULL
     WHERE e.event_id = ? AND p.steamid = ? AND e.status NOT IN ('dropped','disqualified') LIMIT 1`,
  ).get(eventId, steamid) as EntryRow | undefined;
}
export function placementOf(db: DB, ev: E.EventRow): R.Placement {
  return R.placeEntries(entriesOf(db, ev.id), ev.team_cap);
}
/** A team's captain and co-captains right now. */
export function managersOf(db: DB, teamId: number | null): string[] {
  if (teamId === null) return [];
  return activeMembers(db, teamId).filter((m) => m.role === 'captain' || m.role === 'cocaptain').map((m) => m.steamid);
}

export function playerFacts(db: DB, steamid: string, now = new Date()): R.PlayerFacts {
  const pugs = (db.prepare(
    `SELECT COUNT(*) AS n FROM match_players mp JOIN matches m ON m.id = mp.match_id
     WHERE mp.player_id = ? AND ${completedPug('m')} AND m.voided_at IS NULL`,
  ).get(steamid) as { n: number }).n;
  return {
    open: competitiveAccess(db, steamid),
    good: inGoodStanding(db, steamid, now),
    pugs,
    discord: !!getPlayer(db, steamid)?.discord_id,
    sr: seasonSr(db, steamid, currentSeasonId(db)),
  };
}

/** A starting four's SR: the average current-season SR of the active starters. */
export function entrySr(db: DB, entryId: number): number {
  const season = currentSeasonId(db);
  return R.averageSr(rosterOf(db, entryId).starters.map((s) => seasonSr(db, s, season)));
}

/**
 * Everything that keeps this roster out, inside the caller's transaction.
 * New players (not on `previous`) must be on the team unless staff are
 * adding them. Then every player, old and new, is checked against the
 * one-entry rule and the eligibility rules, so a player who stopped being
 * eligible since registering blocks the save until removed.
 */
function checkRoster(
  db: DB, ev: E.EventRow,
  o: { entryId: number | null; teamId: number | null; roster: R.Roster; previous: R.Roster | null; staff: boolean; now: Date },
): V.Checked<null> {
  const elig = E.fieldsOf(ev).eligibility;
  const list = R.rosterList(o.roster);
  const before = new Set(o.previous ? R.rosterList(o.previous).map((p) => p.steamid) : []);
  const members = new Set(o.teamId === null ? [] : activeMembers(db, o.teamId).map((m) => m.steamid));
  if (!o.staff && list.some((p) => !before.has(p.steamid) && !members.has(p.steamid))) return V.fail('not_on_team');
  const elsewhere: V.EntryProblem[] = [];
  const problems: V.EntryProblem[] = [];
  for (const p of list) {
    const other = entryOfPlayer(db, ev.id, p.steamid);
    if (other && other.id !== o.entryId) elsewhere.push({ steamid: p.steamid, problems: [`Already on ${other.name}'s roster`] });
    const facts = playerFacts(db, p.steamid, o.now);
    const found = R.problemsOf(elig, facts, p.role);
    if (found.length > 0) problems.push({ steamid: p.steamid, problems: found.map((k) => R.problemText(k, elig, facts)) });
  }
  if (elsewhere.length > 0) return V.fail('player_entered', elsewhere);
  if (problems.length > 0) return V.fail('player_ineligible', problems);
  return V.ok(null);
}

function addPlace(db: DB, entryId: number, steamid: string, role: R.Role, at: string): void {
  db.prepare('INSERT INTO event_entry_players (entry_id, steamid, role, added_at) VALUES (?, ?, ?, ?)').run(entryId, steamid, role, at);
}

/** Ruling 5: registration is open only in `registration`, before the start
 *  and before the list is final. */
function registrationOpen(ev: E.EventRow, at: string): boolean {
  return ev.status === 'registration' && ev.locked_at === null && at < ev.starts_at;
}

export function registerEntry(
  db: DB, o: { eventId: number; teamId: number; by: string; roster: unknown; now?: Date },
): V.Checked<{ entry: EntryRow; added: Added }> {
  const now = o.now ?? new Date();
  const at = iso(now);
  return db.transaction((): V.Checked<{ entry: EntryRow; added: Added }> => {
    const ev = E.getEvent(db, o.eventId);
    if (!ev || ev.status === 'draft') return V.fail('not_found');
    if (ev.entry_kind !== 'team') return V.fail('draft_signups_later');
    if (!registrationOpen(ev, at)) return V.fail('not_registration');
    const team = getTeam(db, o.teamId);
    if (!team || team.disbanded_at !== null) return V.fail('team_not_found');
    if (!managersOf(db, team.id).includes(o.by)) return V.fail('not_manager');
    if (entryOfTeam(db, ev.id, team.id)) return V.fail('already_entered');
    const roster = R.parseEntryRoster(o.roster, E.fieldsOf(ev).roster);
    if (!roster.ok) return roster;
    const check = checkRoster(db, ev, { entryId: null, teamId: team.id, roster: roster.value, previous: null, staff: false, now });
    if (!check.ok) return check;
    const id = Number(db.prepare(
      'INSERT INTO event_entries (event_id, team_id, name, tag, logo_key, registered_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(ev.id, team.id, team.name, team.tag, team.logo_key, o.by, at).lastInsertRowid);
    const added = R.rosterList(roster.value);
    for (const p of added) addPlace(db, id, p.steamid, p.role, at);
    E.logEvent(db, ev.id, o.by, 'entry_registered', at, { entryId: id, teamId: team.id, name: team.name });
    return V.ok({ entry: getEntry(db, id)!, added });
  })();
}

export function setEntryRoster(
  db: DB, o: { entryId: number; by: string; roster: unknown; staff?: boolean; now?: Date },
): V.Checked<{ entry: EntryRow; added: Added }> {
  const now = o.now ?? new Date();
  const at = iso(now);
  const staff = o.staff === true;
  return db.transaction((): V.Checked<{ entry: EntryRow; added: Added }> => {
    const entry = getEntry(db, o.entryId);
    if (!entry) return V.fail('entry_not_found');
    if (!isActive(entry)) return V.fail('entry_out');
    const ev = E.getEvent(db, entry.event_id)!;
    if (!ROSTER_OPEN.has(ev.status)) return V.fail('wrong_status');
    const f = E.fieldsOf(ev);
    if (!staff && !managersOf(db, entry.team_id).includes(o.by)) return V.fail('not_manager');
    if (!staff && R.rosterLocked(f.roster.lock, at)) return V.fail('roster_locked');
    const parsed = R.parseEntryRoster(o.roster, f.roster);
    if (!parsed.ok) return parsed;
    const previous = rosterOf(db, entry.id);
    const prevRole = new Map(R.rosterList(previous).map((p) => [p.steamid, p.role]));
    const next = R.rosterList(parsed.value);
    const nextIds = new Set(next.map((p) => p.steamid));
    const added = next.filter((p) => !prevRole.has(p.steamid));
    const removed = [...prevRole.keys()].filter((s) => !nextIds.has(s));
    const moved = next.filter((p) => prevRole.has(p.steamid) && prevRole.get(p.steamid) !== p.role);
    if (added.length === 0 && removed.length === 0 && moved.length === 0) return V.ok({ entry, added: [] });
    if (!staff && f.roster.maxAdditions !== null && entry.additions + added.length > f.roster.maxAdditions) return V.fail('additions_used');
    const check = checkRoster(db, ev, { entryId: entry.id, teamId: entry.team_id, roster: parsed.value, previous, staff, now });
    if (!check.ok) return check;
    const close = db.prepare('UPDATE event_entry_players SET removed_at = ? WHERE entry_id = ? AND steamid = ? AND removed_at IS NULL');
    for (const s of removed) close.run(at, entry.id, s);
    const role = db.prepare('UPDATE event_entry_players SET role = ? WHERE entry_id = ? AND steamid = ? AND removed_at IS NULL');
    for (const p of moved) role.run(p.role, entry.id, p.steamid);
    for (const p of added) addPlace(db, entry.id, p.steamid, p.role, at);
    if (!staff && added.length > 0) db.prepare('UPDATE event_entries SET additions = additions + ? WHERE id = ?').run(added.length, entry.id);
    E.logEvent(db, ev.id, o.by, 'roster_changed', at, {
      entryId: entry.id, added: added.map((p) => p.steamid), removed, moved: moved.map((p) => ({ steamid: p.steamid, role: p.role })), staff,
    });
    return V.ok({ entry: getEntry(db, entry.id)!, added });
  })();
}

/** Ruling 7. A starter leaving a checked-in entry undoes the check-in. */
export function leaveEntry(db: DB, o: { entryId: number; steamid: string; now?: Date }): V.Checked<EntryRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<EntryRow> => {
    const entry = getEntry(db, o.entryId);
    if (!entry) return V.fail('entry_not_found');
    if (!isActive(entry)) return V.fail('entry_out');
    const ev = E.getEvent(db, entry.event_id)!;
    if (!LEAVE_OPEN.has(ev.status)) return V.fail('wrong_status');
    const place = placesOf(db, entry.id).find((p) => p.steamid === o.steamid);
    if (!place) return V.fail('not_on_entry');
    db.prepare('UPDATE event_entry_players SET removed_at = ? WHERE id = ?').run(at, place.id);
    if (place.role === 'starter' && entry.status === 'checked_in') {
      db.prepare("UPDATE event_entries SET status = 'registered', checked_in_at = NULL, checked_in_by = NULL WHERE id = ?").run(entry.id);
    }
    E.logEvent(db, ev.id, o.steamid, 'roster_left', at, { entryId: entry.id, role: place.role });
    return V.ok(getEntry(db, entry.id)!);
  })();
}

/** Ruling 8: until the list is final. */
export function withdrawEntry(db: DB, o: { entryId: number; by: string; now?: Date }): V.Checked<EntryRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<EntryRow> => {
    const entry = getEntry(db, o.entryId);
    if (!entry) return V.fail('entry_not_found');
    if (!isActive(entry)) return V.fail('entry_out');
    if (!managersOf(db, entry.team_id).includes(o.by)) return V.fail('not_manager');
    const ev = E.getEvent(db, entry.event_id)!;
    if (ev.locked_at !== null) return V.fail('entries_locked');
    if (ev.status !== 'registration' && ev.status !== 'checkin') return V.fail('wrong_status');
    db.prepare("UPDATE event_entries SET status = 'dropped', dropped_at = ?, drop_reason = 'withdrawn' WHERE id = ?").run(at, entry.id);
    E.logEvent(db, ev.id, o.by, 'entry_withdrawn', at, { entryId: entry.id });
    return V.ok(getEntry(db, entry.id)!);
  })();
}
```

- [ ] **Step 5: Extend the log guard**

In `tests/eventLogGuard.test.ts`:

1. Allow both engine files to write the event tables, and guard the entry tables:

```ts
const WRITERS = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(?:events|event_stages|event_log)\b/gi;
const ENTRY_WRITERS = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(?:event_entries|event_entry_players)\b/gi;
const ENGINE = new Set(['src/events/events.ts', 'src/events/entries.ts']);
```

Change the first test to filter `!ENGINE.has(f)` instead of `f !== 'src/events/events.ts'`, and add a sibling test:

```ts
  it('only src/events/entries.ts (and the account merge) writes the entry tables', () => {
    const offenders = walk('src')
      .filter((f) => f !== 'src/events/entries.ts' && f !== 'src/mergePlayers.ts')
      .filter((f) => (readFileSync(join(root, f), 'utf8').match(ENTRY_WRITERS) ?? []).length > 0);
    expect(offenders).toEqual([]);
  });
```

(lift `root` and `walk` out of the first test to the `describe` scope so both use them).

2. Add `logEvent` to a new `HELPERS` set next to `SPECIAL` and include it wherever the file checks that every export of `events.ts` is classified:

```ts
/** Exported for entries.ts to write its own audit row; never a mutation itself. */
const HELPERS = new Set(['logEvent']);
```

3. Add an entries table, run the same two guards (one row on success; nothing when the `event_log` insert fails) over it, and classify every export of `entries.ts`:

```ts
import * as N from '../src/events/entries.js';
import { A, entryFixture, rosterA, type EntryFixture } from './entryFixture.js';

const ENTRY_READS = new Set(['getEntry', 'entriesOf', 'placesOf', 'rosterOf', 'entryOfTeam', 'entryOfPlayer', 'placementOf', 'managersOf', 'playerFacts', 'entrySr', 'isActive']);
const registered = (f: EntryFixture) => must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW })).entry.id;
const ENTRY_MUTATIONS: Record<string, { action: string; run: (f: EntryFixture) => V.Checked<unknown> }> = {
  registerEntry: { action: 'entry_registered', run: (f) => N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }) },
  setEntryRoster: { action: 'roster_changed', run: (f) => N.setEntryRoster(f.db, { entryId: registered(f), by: A[0], roster: rosterA({ subs: [] }), now: NOW }) },
  leaveEntry: { action: 'roster_left', run: (f) => N.leaveEntry(f.db, { entryId: registered(f), steamid: A[4], now: NOW }) },
  withdrawEntry: { action: 'entry_withdrawn', run: (f) => N.withdrawEntry(f.db, { entryId: registered(f), by: A[0], now: NOW }) },
};
```

For the "one row on success" check, count `event_log` rows with that action after `run` (the setup inside `run` may add its own `entry_registered` row; compare the count of rows with `action === m.action` before and after, expecting `+1`, and for `registerEntry` itself use the total). For the "nothing when the audit row fails" check, register first where the mutation needs an entry, snapshot `event_entries` and `event_entry_players`, then create the failing trigger only on `action = <that action>` (`CREATE TRIGGER t BEFORE INSERT ON event_log WHEN NEW.action = '<action>' BEGIN SELECT RAISE(ABORT, 'audit down'); END`), call the mutation (it throws), and compare the snapshot. Follow how the existing file builds its trigger and adapt.

Task 4 adds `openCheckin` to the events table here and the rest of entries' mutations to `ENTRY_MUTATIONS`.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/entries.test.ts tests/eventLogGuard.test.ts tests/events.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/events/entries.ts src/events/events.ts tests/entryFixture.ts tests/entries.test.ts tests/eventLogGuard.test.ts
git commit -m "Event entries: a captain or co-captain registers a team with a checked roster, edits it, withdraws it, and a player can leave it; one entry per player per event"
```

---

### Task 4: Check-in, the final list, seeds and staff fixes

**Files:**
- Modify: `src/events/events.ts` (`openCheckin`), `src/events/entries.ts`, `tests/eventLogGuard.test.ts`
- Test: `tests/entriesLifecycle.test.ts` (new)

**Interfaces:**
- Consumes: Task 3.
- Produces:
  - `E.openCheckin(db, { eventId, by: string | null, now? }): V.Checked<E.EventRow>` (action `checkin_opened`)
  - `N.checkInEntry(db, { entryId, by, now? }): V.Checked<EntryRow>` (`entry_checked_in`)
  - `interface LockResult { kept: number[]; dropped: { entryId: number; reason: R.DropReason }[] }`; `N.lockEntries(db, { eventId, by: string | null, now? }): V.Checked<LockResult>` (`entries_locked`; `kept` in seed order)
  - `N.dropDisbandedEntry(db, { entryId, now? }): V.Checked<EntryRow>` (`entry_dropped`, actor null)
  - `N.disqualifyEntry(db, { entryId, by, reason: unknown, now? }): V.Checked<EntryRow>` (`entry_disqualified`)
  - `N.restoreEntry(db, { entryId, by, now? }): V.Checked<EntryRow>` (`entry_restored`)
  - `N.reorderSeeds(db, { eventId, by, order: unknown, now? }): V.Checked<number[]>` (`seeds_reordered`)

- [ ] **Step 1: Write the failing tests**

`tests/entriesLifecycle.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as E from '../src/events/events.js';
import * as N from '../src/events/entries.js';
import * as T from '../src/teams/teams.js';
import { NOW } from './eventFixture.js';
import { A, B, OUTSIDER, entryFixture, rosterA, rosterB } from './entryFixture.js';

const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
const status = (db: Parameters<typeof E.getEvent>[0], id: number) => E.getEvent(db, id)!.status;
const rate = (db: Parameters<typeof E.getEvent>[0], steamid: string, mu: number) =>
  db.prepare('INSERT OR REPLACE INTO player_ratings (player_id, season_id, mu, sigma) VALUES (?, (SELECT id FROM seasons WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1), ?, 1)').run(steamid, mu);

describe('openCheckin', () => {
  it('moves registration to check-in, only with check-in on', () => {
    const f = entryFixture();
    must(E.openCheckin(f.db, { eventId: f.eventId, by: null, now: NOW }));
    expect(status(f.db, f.eventId)).toBe('checkin');
    expect(E.openCheckin(f.db, { eventId: f.eventId, by: null, now: NOW })).toEqual({ ok: false, error: 'wrong_status' });
    const off = entryFixture({ checkin: false });
    expect(E.openCheckin(off.db, { eventId: off.eventId, by: null, now: NOW })).toEqual({ ok: false, error: 'no_checkin' });
  });
});

describe('checkInEntry', () => {
  it('checks in a full eligible roster during check-in, once', () => {
    const f = entryFixture();
    const { entry } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    expect(N.checkInEntry(f.db, { entryId: entry.id, by: A[0], now: NOW })).toEqual({ ok: false, error: 'not_checkin' });
    must(E.openCheckin(f.db, { eventId: f.eventId, by: null, now: NOW }));
    expect(N.checkInEntry(f.db, { entryId: entry.id, by: A[3], now: NOW })).toEqual({ ok: false, error: 'not_manager' });
    expect(must(N.checkInEntry(f.db, { entryId: entry.id, by: A[1], now: NOW }))).toMatchObject({ status: 'checked_in', checked_in_by: A[1] });
    const logs = (f.db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE action = 'entry_checked_in'").get() as { n: number }).n;
    must(N.checkInEntry(f.db, { entryId: entry.id, by: A[0], now: NOW }));
    expect((f.db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE action = 'entry_checked_in'").get() as { n: number }).n).toBe(logs);
  });

  it('refuses a short roster and a player who became ineligible, naming them', () => {
    const f = entryFixture();
    const { entry } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    must(E.openCheckin(f.db, { eventId: f.eventId, by: null, now: NOW }));
    f.db.prepare('UPDATE players SET discord_id = NULL WHERE steamid = ?').run(A[2]);
    const r = N.checkInEntry(f.db, { entryId: entry.id, by: A[0], now: NOW });
    expect(r).toEqual({ ok: false, error: 'player_ineligible', detail: [{ steamid: A[2], problems: ['Discord is not linked'] }] });
    must(N.leaveEntry(f.db, { entryId: entry.id, steamid: A[2], now: NOW }));
    expect(N.checkInEntry(f.db, { entryId: entry.id, by: A[0], now: NOW })).toEqual({ ok: false, error: 'need_starters' });
  });
});

describe('lockEntries', () => {
  it('drops teams that did not check in, fills from the waitlist in registration order, and seeds by SR', () => {
    const f = entryFixture({ teamCap: 1 });
    const ea = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW })).entry;
    const eb = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamB, by: B[0], roster: rosterB(), now: at(1) })).entry;
    must(E.openCheckin(f.db, { eventId: f.eventId, by: null, now: at(2) }));
    must(N.checkInEntry(f.db, { entryId: eb.id, by: B[0], now: at(3) })); // waitlisted, but it shows up
    const r = must(N.lockEntries(f.db, { eventId: f.eventId, by: null, now: at(4) }));
    expect(r).toEqual({ kept: [eb.id], dropped: [{ entryId: ea.id, reason: 'no_checkin' }] });
    expect(N.getEntry(f.db, eb.id)).toMatchObject({ seed: 1, status: 'checked_in' });
    expect(N.getEntry(f.db, ea.id)).toMatchObject({ status: 'dropped', drop_reason: 'no_checkin', dropped_at: at(4).toISOString() });
    expect(E.getEvent(f.db, f.eventId)!.locked_at).toBe(at(4).toISOString());
    expect(N.lockEntries(f.db, { eventId: f.eventId, by: null, now: at(5) })).toEqual({ ok: false, error: 'wrong_status' });
  });

  it('drops checked-in teams past the cap, and seeds the rest highest SR first', () => {
    const f = entryFixture({ teamCap: 1 });
    const ea = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW })).entry;
    const eb = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamB, by: B[0], roster: rosterB(), now: at(1) })).entry;
    must(E.openCheckin(f.db, { eventId: f.eventId, by: null, now: at(2) }));
    for (const id of [ea.id, eb.id]) must(N.checkInEntry(f.db, { entryId: id, by: id === ea.id ? A[0] : B[0], now: at(3) }));
    const r = must(N.lockEntries(f.db, { eventId: f.eventId, by: null, now: at(4) }));
    expect(r).toEqual({ kept: [ea.id], dropped: [{ entryId: eb.id, reason: 'over_cap' }] });
  });

  it('with check-in off, drops entries without 4 starters, refreshes snapshots and seeds by SR', () => {
    const f = entryFixture({ checkin: false });
    const ea = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW })).entry;
    const eb = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamB, by: B[0], roster: rosterB(), now: at(1) })).entry;
    for (const s of B.slice(0, 4)) rate(f.db, s, 40);
    must(T.renameTeam(f.db, { teamId: f.teamA, by: A[0], name: 'Rats Two', tag: 'RAT2' }));
    let r = must(N.lockEntries(f.db, { eventId: f.eventId, by: null, now: at(4) }));
    expect(r.kept).toEqual([eb.id, ea.id]);
    expect(N.getEntry(f.db, ea.id)).toMatchObject({ name: 'Rats Two', tag: 'RAT2', seed: 2 });
    expect(N.getEntry(f.db, eb.id)!.seed).toBe(1);

    const g = entryFixture({ checkin: false });
    const ga = must(N.registerEntry(g.db, { eventId: g.eventId, teamId: g.teamA, by: A[0], roster: rosterA(), now: NOW })).entry;
    must(N.leaveEntry(g.db, { entryId: ga.id, steamid: A[0], now: NOW }));
    r = must(N.lockEntries(g.db, { eventId: g.eventId, by: null, now: at(4) }));
    expect(r).toEqual({ kept: [], dropped: [{ entryId: ga.id, reason: 'incomplete' }] });
  });
});

describe('staff fixes and the tick helpers', () => {
  it('drops a disbanded team before the list is final', () => {
    const f = entryFixture();
    const { entry } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamB, by: B[0], roster: rosterB(), now: NOW }));
    expect(N.dropDisbandedEntry(f.db, { entryId: entry.id, now: NOW })).toEqual({ ok: false, error: 'wrong_status' });
    must(T.disbandTeam(f.db, { teamId: f.teamB, by: B[0], now: NOW }));
    expect(must(N.dropDisbandedEntry(f.db, { entryId: entry.id, now: NOW }))).toMatchObject({ status: 'dropped', drop_reason: 'team_disbanded' });
  });

  it('disqualifies with a reason and restores before the list is final', () => {
    const f = entryFixture();
    const { entry } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    expect(must(N.disqualifyEntry(f.db, { entryId: entry.id, by: 'staff', reason: 'Ringer', now: NOW })).status).toBe('disqualified');
    expect(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW })).toEqual({ ok: false, error: 'already_entered' });
    expect(must(N.restoreEntry(f.db, { entryId: entry.id, by: 'staff', now: NOW }))).toMatchObject({ status: 'registered', drop_reason: null, dropped_at: null });
    expect(N.restoreEntry(f.db, { entryId: entry.id, by: 'staff', now: NOW })).toEqual({ ok: false, error: 'not_restorable' });
  });

  it('refuses to restore an entry whose players are now on another entry', () => {
    const f = entryFixture();
    const { entry } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    must(N.withdrawEntry(f.db, { entryId: entry.id, by: A[0], now: NOW }));
    const again = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: at(1) })).entry;
    expect(N.restoreEntry(f.db, { entryId: entry.id, by: 'staff', now: at(2) }).ok).toBe(false);
    expect(N.getEntry(f.db, again.id)!.status).toBe('registered');
  });

  it('reorders seeds only once the list is final and before the event is live', () => {
    const f = entryFixture({ checkin: false });
    const ea = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW })).entry;
    const eb = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamB, by: B[0], roster: rosterB(), now: at(1) })).entry;
    expect(N.reorderSeeds(f.db, { eventId: f.eventId, by: 'staff', order: [eb.id, ea.id], now: NOW })).toEqual({ ok: false, error: 'seeds_locked' });
    must(N.lockEntries(f.db, { eventId: f.eventId, by: null, now: at(4) }));
    expect(N.reorderSeeds(f.db, { eventId: f.eventId, by: 'staff', order: [eb.id], now: at(5) })).toEqual({ ok: false, error: 'bad_seed_order' });
    expect(must(N.reorderSeeds(f.db, { eventId: f.eventId, by: 'staff', order: [eb.id, ea.id], now: at(5) }))).toEqual([eb.id, ea.id]);
    expect([N.getEntry(f.db, eb.id)!.seed, N.getEntry(f.db, ea.id)!.seed]).toEqual([1, 2]);
  });

  it('lets staff put any eligible active player on a roster', () => {
    const f = entryFixture();
    const { entry } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    expect(N.setEntryRoster(f.db, { entryId: entry.id, by: 'staff', staff: true, roster: rosterA({ subs: [OUTSIDER] }), now: NOW }).ok).toBe(true);
  });
});
```

Check the `T.renameTeam` and `T.disbandTeam` argument shapes in `src/teams/teams.ts` (lines 448 and 473) and adapt the calls if they differ.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/entriesLifecycle.test.ts`
Expected: FAIL, `openCheckin`, `checkInEntry` and the rest are not exported.

- [ ] **Step 3: Implement**

In `src/events/events.ts`, after `openRegistration`:

```ts
/** registration -> checkin (T1b Ruling 4): the runner calls it at
 *  starts_at - opensMinutes with by null; an admin may call it early. */
export function openCheckin(db: DB, o: { eventId: number; by: string | null; now?: Date }): EventResult<EventRow> {
  const at = iso(o.now);
  return db.transaction((): EventResult<EventRow> => {
    const ev = getEvent(db, o.eventId);
    if (!ev) return V.fail('not_found');
    if (!fieldsOf(ev).checkin.enabled) return V.fail('no_checkin');
    if (!V.nextStatusAllowed(ev.status, 'checkin') || ev.locked_at !== null) return V.fail('wrong_status');
    db.prepare("UPDATE events SET status = 'checkin', updated_at = ? WHERE id = ?").run(at, ev.id);
    logEvent(db, ev.id, o.by, 'checkin_opened', at);
    return V.ok(getEvent(db, ev.id)!);
  })();
}
```

Add `locked_at: string | null;` to `EventRow` (after `cancel_reason`).

In `src/events/entries.ts`, append:

```ts
/** Ruling 2: a captain or co-captain, during check-in, with 4 starters who
 *  all pass now. Pressing it again changes nothing and writes nothing. */
export function checkInEntry(db: DB, o: { entryId: number; by: string; now?: Date }): V.Checked<EntryRow> {
  const now = o.now ?? new Date();
  const at = iso(now);
  return db.transaction((): V.Checked<EntryRow> => {
    const entry = getEntry(db, o.entryId);
    if (!entry) return V.fail('entry_not_found');
    if (!isActive(entry)) return V.fail('entry_out');
    if (!managersOf(db, entry.team_id).includes(o.by)) return V.fail('not_manager');
    const ev = E.getEvent(db, entry.event_id)!;
    if (ev.status !== 'checkin' || ev.locked_at !== null) return V.fail('not_checkin');
    if (entry.status === 'checked_in') return V.ok(entry);
    const roster = rosterOf(db, entry.id);
    if (roster.starters.length !== R.STARTERS) return V.fail('need_starters');
    const check = checkRoster(db, ev, { entryId: entry.id, teamId: entry.team_id, roster, previous: roster, staff: true, now });
    if (!check.ok) return check;
    db.prepare("UPDATE event_entries SET status = 'checked_in', checked_in_at = ?, checked_in_by = ? WHERE id = ?").run(at, o.by, entry.id);
    E.logEvent(db, ev.id, o.by, 'entry_checked_in', at, { entryId: entry.id });
    return V.ok(getEntry(db, entry.id)!);
  })();
}

export interface LockResult { kept: number[]; dropped: { entryId: number; reason: R.DropReason }[] }

/**
 * Make the entry list final (Ruling 4). With check-in on (event in checkin):
 * entries not checked in drop as no_checkin. With it off (event in
 * registration): entries short of 4 starters drop as incomplete. Then the
 * ready entries past the cap, in registration order, drop as over_cap; the
 * kept ones take a fresh name, tag and logo from their team (Ruling 13) and
 * seeds by average starter SR. kept is in seed order.
 */
export function lockEntries(db: DB, o: { eventId: number; by: string | null; now?: Date }): V.Checked<LockResult> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<LockResult> => {
    const ev = E.getEvent(db, o.eventId);
    if (!ev) return V.fail('not_found');
    const f = E.fieldsOf(ev);
    if (ev.status !== (f.checkin.enabled ? 'checkin' : 'registration') || ev.locked_at !== null) return V.fail('wrong_status');
    const active = entriesOf(db, ev.id).filter(isActive);
    const dropped: LockResult['dropped'] = [];
    const ready = active.filter((e) => {
      const fine = f.checkin.enabled ? e.status === 'checked_in' : rosterOf(db, e.id).starters.length === R.STARTERS;
      if (!fine) dropped.push({ entryId: e.id, reason: f.checkin.enabled ? 'no_checkin' : 'incomplete' });
      return fine;
    });
    const place = R.placeEntries(ready, ev.team_cap);
    for (const id of place.waitlist) dropped.push({ entryId: id, reason: 'over_cap' });
    const drop = db.prepare("UPDATE event_entries SET status = 'dropped', dropped_at = ?, drop_reason = ? WHERE id = ?");
    for (const d of dropped) drop.run(at, d.reason, d.entryId);
    const snap = db.prepare('UPDATE event_entries SET name = ?, tag = ?, logo_key = ? WHERE id = ?');
    for (const id of place.placed) {
      const e = getEntry(db, id)!;
      const team = e.team_id !== null ? getTeam(db, e.team_id) : undefined;
      if (team && team.disbanded_at === null) snap.run(team.name, team.tag, team.logo_key, id);
    }
    const kept = R.seedOrder(place.placed.map((id) => ({ id, sr: entrySr(db, id), created_at: getEntry(db, id)!.created_at })));
    const seed = db.prepare('UPDATE event_entries SET seed = ? WHERE id = ?');
    kept.forEach((id, i) => seed.run(i + 1, id));
    db.prepare('UPDATE events SET locked_at = ?, updated_at = ? WHERE id = ?').run(at, at, ev.id);
    E.logEvent(db, ev.id, o.by, 'entries_locked', at, { kept: kept.length, dropped });
    return V.ok({ kept, dropped });
  })();
}

/** Ruling 9: the tick drops an entry whose team was disbanded, until the list is final. */
export function dropDisbandedEntry(db: DB, o: { entryId: number; now?: Date }): V.Checked<EntryRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<EntryRow> => {
    const entry = getEntry(db, o.entryId);
    if (!entry) return V.fail('entry_not_found');
    if (!isActive(entry)) return V.fail('entry_out');
    const ev = E.getEvent(db, entry.event_id)!;
    const team = entry.team_id !== null ? getTeam(db, entry.team_id) : undefined;
    if (ev.locked_at !== null || !team || team.disbanded_at === null) return V.fail('wrong_status');
    db.prepare("UPDATE event_entries SET status = 'dropped', dropped_at = ?, drop_reason = 'team_disbanded' WHERE id = ?").run(at, entry.id);
    E.logEvent(db, ev.id, null, 'entry_dropped', at, { entryId: entry.id, reason: 'team_disbanded' });
    return V.ok(getEntry(db, entry.id)!);
  })();
}

/** Ruling 10. The reason is kept in event_log only. */
export function disqualifyEntry(db: DB, o: { entryId: number; by: string; reason: unknown; now?: Date }): V.Checked<EntryRow> {
  const at = iso(o.now);
  const reason = V.normalizeReason(o.reason);
  if (!reason.ok) return reason;
  return db.transaction((): V.Checked<EntryRow> => {
    const entry = getEntry(db, o.entryId);
    if (!entry) return V.fail('entry_not_found');
    if (!isActive(entry)) return V.fail('entry_out');
    const ev = E.getEvent(db, entry.event_id)!;
    if (ev.status === 'finished' || ev.status === 'cancelled') return V.fail('wrong_status');
    db.prepare("UPDATE event_entries SET status = 'disqualified', dropped_at = ? WHERE id = ?").run(at, entry.id);
    E.logEvent(db, ev.id, o.by, 'entry_disqualified', at, { entryId: entry.id, reason: reason.value });
    return V.ok(getEntry(db, entry.id)!);
  })();
}

/** Ruling 10: back to registered, before the list is final, if the team and
 *  every rostered player are still free in this event. */
export function restoreEntry(db: DB, o: { entryId: number; by: string; now?: Date }): V.Checked<EntryRow> {
  const now = o.now ?? new Date();
  const at = iso(now);
  return db.transaction((): V.Checked<EntryRow> => {
    const entry = getEntry(db, o.entryId);
    if (!entry) return V.fail('entry_not_found');
    const ev = E.getEvent(db, entry.event_id)!;
    if (isActive(entry) || ev.locked_at !== null || (ev.status !== 'registration' && ev.status !== 'checkin')) return V.fail('not_restorable');
    if (entry.team_id !== null && entryOfTeam(db, ev.id, entry.team_id)) return V.fail('already_entered');
    const roster = rosterOf(db, entry.id);
    const check = checkRoster(db, ev, { entryId: entry.id, teamId: entry.team_id, roster, previous: roster, staff: true, now });
    if (!check.ok) return check;
    db.prepare("UPDATE event_entries SET status = 'registered', dropped_at = NULL, drop_reason = NULL, checked_in_at = NULL, checked_in_by = NULL WHERE id = ?").run(entry.id);
    E.logEvent(db, ev.id, o.by, 'entry_restored', at, { entryId: entry.id });
    return V.ok(getEntry(db, entry.id)!);
  })();
}

/** Spec section 2: staff reorder seeds once the list is final and before the
 *  event goes live. order lists every active seeded entry once. */
export function reorderSeeds(db: DB, o: { eventId: number; by: string; order: unknown; now?: Date }): V.Checked<number[]> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<number[]> => {
    const ev = E.getEvent(db, o.eventId);
    if (!ev) return V.fail('not_found');
    if (ev.locked_at === null || V.STAGES_LOCKED.has(ev.status)) return V.fail('seeds_locked');
    const seeded = entriesOf(db, ev.id).filter((e) => isActive(e) && e.seed !== null).map((e) => e.id);
    const order = o.order;
    if (!Array.isArray(order) || order.length !== seeded.length || new Set(order).size !== seeded.length
      || !order.every((x) => typeof x === 'number' && seeded.includes(x))) {
      return V.fail('bad_seed_order');
    }
    const seed = db.prepare('UPDATE event_entries SET seed = ? WHERE id = ?');
    (order as number[]).forEach((id, i) => seed.run(i + 1, id));
    E.logEvent(db, ev.id, o.by, 'seeds_reordered', at, { order });
    return V.ok(order as number[]);
  })();
}
```

Note the restore test that expects a refusal: the withdrawn entry's players are on the re-registered entry, and the team has an active entry, so `already_entered` comes first. That is the intended answer.

- [ ] **Step 4: Extend the log guard**

In `tests/eventLogGuard.test.ts`, add `openCheckin` to `MUTATIONS` (its `from` is a registration-status event; build it with `entryFixture()` inside `run` if the T1a fixture cannot reach `registration`, or add `'registration'` to the fixture's status option and call `E.openRegistration` there), and add to `ENTRY_MUTATIONS`:

```ts
  checkInEntry: { action: 'entry_checked_in', run: (f) => { const id = registered(f); must(E.openCheckin(f.db, { eventId: f.eventId, by: null, now: NOW })); return N.checkInEntry(f.db, { entryId: id, by: A[0], now: NOW }); } },
  lockEntries: { action: 'entries_locked', run: (f) => { registered(f); must(E.openCheckin(f.db, { eventId: f.eventId, by: null, now: NOW })); return N.lockEntries(f.db, { eventId: f.eventId, by: null, now: NOW }); } },
  dropDisbandedEntry: { action: 'entry_dropped', run: (f) => { const id = registered(f); f.db.prepare('UPDATE teams SET disbanded_at = ? WHERE id = ?').run(NOW.toISOString(), f.teamA); return N.dropDisbandedEntry(f.db, { entryId: id, now: NOW }); } },
  disqualifyEntry: { action: 'entry_disqualified', run: (f) => N.disqualifyEntry(f.db, { entryId: registered(f), by: A[0], reason: 'x', now: NOW }) },
  restoreEntry: { action: 'entry_restored', run: (f) => { const id = registered(f); must(N.disqualifyEntry(f.db, { entryId: id, by: A[0], reason: null, now: NOW })); return N.restoreEntry(f.db, { entryId: id, by: A[0], now: NOW }); } },
  reorderSeeds: { action: 'seeds_reordered', run: (f) => { const id = registered(f); must(E.openCheckin(f.db, { eventId: f.eventId, by: null, now: NOW })); must(N.checkInEntry(f.db, { entryId: id, by: A[0], now: NOW })); must(N.lockEntries(f.db, { eventId: f.eventId, by: null, now: NOW })); return N.reorderSeeds(f.db, { eventId: f.eventId, by: A[0], order: [id], now: NOW }); } },
```

The setup writes in these `run`s add rows of other actions; the guard counts rows of `m.action` only (Task 3, Step 5). The `UPDATE teams` in `dropDisbandedEntry`'s setup is in a test file, so the source guard does not see it.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/entriesLifecycle.test.ts tests/entries.test.ts tests/eventLogGuard.test.ts tests/events.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/events/events.ts src/events/entries.ts tests/entriesLifecycle.test.ts tests/eventLogGuard.test.ts
git commit -m "Event entries: open check-in, captain check-in, the final list (drops, waitlist fill, snapshot refresh, SR seeds), disbanded-team drops, disqualify, restore and seed reorder"
```

---

### Task 5: DMs and the minute tick

**Files:**
- Create: `src/events/messages.ts`, `src/events/runner.ts`, `tests/eventRunner.test.ts`
- Modify: `src/notify/notify.ts`, `src/server.ts`

**Interfaces:**
- Consumes: Task 4; `Notifier` (`src/notify/notify.ts`); `whenUtc` (`src/bookings/messages.ts`); `escapeName` (`src/identity.ts`).
- Produces:
  - `NotifyType` gains `'event_checkin_open' | 'event_dropped' | 'event_roster_added'`.
  - `type EventNotifyType = 'event_checkin_open' | 'event_dropped' | 'event_roster_added'`; `eventMessage(db, publicUrl, eventId, type, extra: { entryId?: number; reason?: R.DropReason; by?: string; role?: R.Role }): MessagePayload | null`
  - `class EventRunner { constructor(deps: { db; notifier: Notifier; publicUrl: string; now?: () => number }); tick(): Promise<void>; step(now: Date): void }`; `TICK_MS = 60_000`

- [ ] **Step 1: Write the failing tests**

`tests/eventRunner.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import * as E from '../src/events/events.js';
import * as N from '../src/events/entries.js';
import * as T from '../src/teams/teams.js';
import { EventRunner } from '../src/events/runner.js';
import { eventMessage } from '../src/events/messages.js';
import type { Notifier } from '../src/notify/notify.js';
import { NOW, START } from './eventFixture.js';
import { A, B, entryFixture, rosterA, rosterB } from './entryFixture.js';

const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
const startMinus = (min: number) => new Date(Date.parse(START) - min * 60_000);

function runner(db: Parameters<typeof E.getEvent>[0]) {
  const send = vi.fn(() => 1);
  return { send, r: new EventRunner({ db, notifier: { send } as unknown as Notifier, publicUrl: 'https://x' }) };
}

describe('EventRunner', () => {
  it('does nothing before the window', () => {
    const f = entryFixture();
    const { r, send } = runner(f.db);
    r.step(startMinus(61));
    expect(E.getEvent(f.db, f.eventId)!.status).toBe('registration');
    expect(send).not.toHaveBeenCalled();
  });

  it('opens check-in at the window and tells the managers of every active entry, waitlisted ones too', () => {
    const f = entryFixture({ teamCap: 1 });
    must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamB, by: B[0], roster: rosterB(), now: NOW }));
    const { r, send } = runner(f.db);
    r.step(startMinus(60));
    expect(E.getEvent(f.db, f.eventId)!.status).toBe('checkin');
    const told = send.mock.calls.flatMap((c) => [...(c[0] as Iterable<string>)]);
    expect(told.sort()).toEqual([A[0], A[1], B[0]].sort());
    expect(send.mock.calls.every((c) => c[1] === 'event_checkin_open')).toBe(true);
  });

  it('after downtime, opens on one tick and closes on the next, never both at once', () => {
    const f = entryFixture();
    must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    const { r, send } = runner(f.db);
    r.step(startMinus(5));
    expect(E.getEvent(f.db, f.eventId)).toMatchObject({ status: 'checkin', locked_at: null });
    r.step(startMinus(4));
    expect(E.getEvent(f.db, f.eventId)!.locked_at).toBe(startMinus(4).toISOString());
    expect(send.mock.calls.at(-1)![1]).toBe('event_dropped');
    r.step(startMinus(3));
    expect((f.db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE action = 'entries_locked'").get() as { n: number }).n).toBe(1);
  });

  it('with check-in off, finalises at the start', () => {
    const f = entryFixture({ checkin: false });
    must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    const { r } = runner(f.db);
    r.step(startMinus(1));
    expect(E.getEvent(f.db, f.eventId)!.locked_at).toBeNull();
    r.step(startMinus(0));
    expect(E.getEvent(f.db, f.eventId)!.locked_at).not.toBeNull();
  });

  it('drops a disbanded team on any tick before the list is final', () => {
    const f = entryFixture();
    const { entry } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamB, by: B[0], roster: rosterB(), now: NOW }));
    must(T.disbandTeam(f.db, { teamId: f.teamB, by: B[0], now: NOW }));
    runner(f.db).r.step(startMinus(600));
    expect(N.getEntry(f.db, entry.id)!.drop_reason).toBe('team_disbanded');
  });

  it('keeps going when one event fails', () => {
    const f = entryFixture();
    const { r } = runner(f.db);
    const spy = vi.spyOn(E, 'openCheckin').mockImplementationOnce(() => { throw new Error('boom'); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => r.step(startMinus(60))).not.toThrow();
    expect(err).toHaveBeenCalled();
    spy.mockRestore();
    err.mockRestore();
  });
});

describe('eventMessage', () => {
  it('words each DM with the event link and escaped names', () => {
    const f = entryFixture();
    const { entry } = must(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0], roster: rosterA(), now: NOW }));
    const slug = E.getEvent(f.db, f.eventId)!.slug;
    const open = eventMessage(f.db, 'https://x', f.eventId, 'event_checkin_open', { entryId: entry.id })!;
    expect(open.content).toContain('Check-in is open for Riverside Cup');
    expect(open.components[0]![0]).toMatchObject({ kind: 'link', url: `https://x/event/${slug}` });
    expect(eventMessage(f.db, 'https://x', f.eventId, 'event_dropped', { entryId: entry.id, reason: 'no_checkin' })!.content)
      .toBe('Rats is out of Riverside Cup: it did not check in in time.');
    expect(eventMessage(f.db, 'https://x', f.eventId, 'event_roster_added', { entryId: entry.id, by: A[0], role: 'sub' })!.content)
      .toContain("put you on Rats's roster for Riverside Cup as a sub");
  });
});
```

If `vi.spyOn(E, 'openCheckin')` cannot replace an ESM export in this repo's vitest setup, drop that case and instead give the runner a second event whose `checkin_json` is unparseable (`UPDATE events SET checkin_json = '{' WHERE id = ?`) and check the first still opens.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/eventRunner.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

In `src/notify/notify.ts`, extend `NotifyType` with `| 'event_checkin_open' | 'event_dropped' | 'event_roster_added'` and append to `NOTIFY_TYPES`:

```ts
  { type: 'event_checkin_open', label: 'Check-in opens for an event my team entered' },
  { type: 'event_dropped', label: 'My team\'s event entry is dropped' },
  { type: 'event_roster_added', label: 'Someone puts me on an event roster' },
```

Create `src/events/messages.ts`:

```ts
import type { DB } from '../db.js';
import type { MessagePayload } from '../discord/transport.js';
import { escapeName } from '../identity.js';
import { getPlayer } from '../players.js';
import { whenUtc } from '../bookings/messages.js';
import * as E from './events.js';
import { getEntry } from './entries.js';
import * as R from './entryRules.js';

/** The three event DMs (plan T1b Ruling 11). Every player-chosen name goes
 *  through escapeName, as in src/bookings/messages.ts. */
export type EventNotifyType = 'event_checkin_open' | 'event_dropped' | 'event_roster_added';

const ROLE_TEXT: Record<R.Role, string> = { starter: 'a starter', sub: 'a sub', coach: 'the coach' };

export function eventMessage(
  db: DB, publicUrl: string, eventId: number, type: EventNotifyType,
  extra: { entryId?: number; reason?: R.DropReason; by?: string; role?: R.Role } = {},
): MessagePayload | null {
  const ev = E.getEvent(db, eventId);
  if (!ev) return null;
  const entry = extra.entryId !== undefined ? getEntry(db, extra.entryId) : undefined;
  const event = escapeName(ev.name);
  const team = escapeName(entry?.name ?? 'Your team');
  let content: string;
  switch (type) {
    case 'event_checkin_open': {
      const { closesAt } = R.checkinTimes(ev.starts_at, E.fieldsOf(ev).checkin);
      content = `Check-in is open for ${event}. A captain or co-captain of ${team} checks in on the event page before ${whenUtc(closesAt)}; teams not checked in by then are dropped.`;
      break;
    }
    case 'event_dropped':
      content = `${team} is out of ${event}: ${R.DROP_TEXT[extra.reason ?? 'withdrawn']}.`;
      break;
    case 'event_roster_added': {
      const by = escapeName((extra.by ? getPlayer(db, extra.by)?.name : undefined) ?? 'Your captain');
      content = `${by} put you on ${team}'s roster for ${event} as ${ROLE_TEXT[extra.role ?? 'starter']}. You can leave the roster from the event page.`;
      break;
    }
  }
  return {
    content,
    embeds: [],
    components: [[{ kind: 'link', url: `${publicUrl}/event/${ev.slug}`, label: 'Open the event' }]],
    mentionUserIds: [],
  };
}
```

Create `src/events/runner.ts`:

```ts
import type { DB } from '../db.js';
import type { Notifier } from '../notify/notify.js';
import { getTeam } from '../teams/teams.js';
import * as E from './events.js';
import * as N from './entries.js';
import * as R from './entryRules.js';
import { eventMessage, type EventNotifyType } from './messages.js';

export const TICK_MS = 60_000;

/**
 * The events minute tick (plan T1b Ruling 4). For every team event in
 * registration or check-in whose list is not final: drop entries of
 * disbanded teams, open check-in when its window starts, and make the list
 * final when check-in closes (or at the start with check-in off). One step
 * per event per tick: an event found past both thresholds after downtime
 * opens check-in now (and says so) and closes on the next tick. Each event
 * is caught on its own, so one bad row cannot stop the rest.
 */
export class EventRunner {
  private ticking = false;
  private readonly now: () => number;

  constructor(private readonly deps: { db: DB; notifier: Notifier; publicUrl: string; now?: () => number }) {
    this.now = deps.now ?? Date.now;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.step(new Date(this.now()));
    } catch (err) {
      console.error('[events] tick failed:', err instanceof Error ? err.message : err);
    } finally {
      this.ticking = false;
    }
  }

  step(now: Date): void {
    const { db } = this.deps;
    const rows = db.prepare(
      "SELECT * FROM events WHERE entry_kind = 'team' AND status IN ('registration','checkin') AND locked_at IS NULL ORDER BY id",
    ).all() as E.EventRow[];
    for (const ev of rows) {
      try {
        this.stepEvent(ev, now);
      } catch (err) {
        console.error(`[events] tick for event ${ev.id} failed:`, err instanceof Error ? err.message : err);
      }
    }
  }

  private stepEvent(ev: E.EventRow, now: Date): void {
    const { db } = this.deps;
    const at = now.toISOString();
    for (const e of N.entriesOf(db, ev.id).filter(N.isActive)) {
      const team = e.team_id !== null ? getTeam(db, e.team_id) : undefined;
      if (team && team.disbanded_at !== null) N.dropDisbandedEntry(db, { entryId: e.id, now });
    }
    const f = E.fieldsOf(ev);
    if (f.checkin.enabled) {
      const { opensAt, closesAt } = R.checkinTimes(ev.starts_at, f.checkin);
      if (ev.status === 'registration' && at >= opensAt) {
        if (E.openCheckin(db, { eventId: ev.id, by: null, now }).ok) {
          for (const e of N.entriesOf(db, ev.id).filter(N.isActive)) this.tell(N.managersOf(db, e.team_id), ev.id, 'event_checkin_open', { entryId: e.id });
        }
        return;
      }
      if (ev.status === 'checkin' && at >= closesAt) this.lock(ev, now);
      return;
    }
    if (ev.status === 'registration' && at >= ev.starts_at) this.lock(ev, now);
  }

  private lock(ev: E.EventRow, now: Date): void {
    const r = N.lockEntries(this.deps.db, { eventId: ev.id, by: null, now });
    if (!r.ok) return;
    for (const d of r.value.dropped) {
      const entry = N.getEntry(this.deps.db, d.entryId);
      if (entry) this.tell(N.managersOf(this.deps.db, entry.team_id), ev.id, 'event_dropped', { entryId: d.entryId, reason: d.reason });
    }
  }

  /** A failure to word or send one notice must not stop the rest. */
  private tell(to: string[], eventId: number, type: EventNotifyType, extra: Parameters<typeof eventMessage>[4]): void {
    if (to.length === 0) return;
    try {
      const payload = eventMessage(this.deps.db, this.deps.publicUrl, eventId, type, extra);
      if (payload) this.deps.notifier.send(to, type, payload);
    } catch (err) {
      console.warn(`[events] ${type} notice for event ${eventId} failed:`, err instanceof Error ? err.message : err);
    }
  }
}
```

In `src/server.ts`: import `{ EventRunner, TICK_MS as EVENT_TICK_MS } from './events/runner.js'`; right after the `scrimTick` lines (around line 2055) add

```ts
  // Events (tournaments plan T1b): check-in opens and the entry list closes on the clock.
  const eventRunner = new EventRunner({ db: deps.db, notifier, publicUrl: deps.config.publicUrl });
  const eventTick = setInterval(() => { void eventRunner.tick(); }, EVENT_TICK_MS);
  eventTick.unref();
```

and next to `clearInterval(scrimTick);` (around line 1874) add `clearInterval(eventTick);`. If `eventTick` is declared after the close hook in the file, declare it with `let eventTick: ReturnType<typeof setInterval> | null = null;` near `scrimTick`'s own declaration pattern and guard the clear; follow whatever `scrimTick` does.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/eventRunner.test.ts tests/notify*.test.ts`
Expected: PASS (if no `tests/notify*.test.ts` exists, run `npx vitest run tests/eventRunner.test.ts` alone).

- [ ] **Step 5: Commit**

```bash
git add src/notify/notify.ts src/events/messages.ts src/events/runner.ts src/server.ts tests/eventRunner.test.ts
git commit -m "Events: a minute tick opens check-in and closes the entry list on the clock, drops disbanded teams, and DMs captains (check-in open, dropped) and added players"
```

---

### Task 6: Public entry routes and views

**Files:**
- Modify: `src/events/views.ts`, `src/routes/events.ts`, `src/server.ts` (the `eventRoutes` registration)
- Test: `tests/eventEntryRoutes.test.ts` (new), `tests/eventRoutes.test.ts` (adjust the entries shape if a case pins it)

**Interfaces:**
- Consumes: Tasks 3 to 5.
- Produces:
  - `EventEntryView` becomes `{ id: number; name: string; tag: string; logoKey: string | null; seed: number | null; status: string; waitlist: number | null }` (`waitlist` is the 1-based position, null when placed); `EventView` gains `lockedAt: string | null; checkinOpensAt: string | null; checkinClosesAt: string | null`.
  - `MyEventView` and friends (exact shapes in Step 3), `myEventView(db, ev, viewer, now?)`.
  - Routes: `GET /api/events/:slug/mine`; `POST /api/events/:slug/entries` `{ teamId, roster }`; `POST /api/events/:slug/entries/:id/roster` `{ roster }`; `POST /api/events/:slug/entries/:id/withdraw`; `POST /api/events/:slug/entries/:id/checkin`; `POST /api/events/:slug/entries/:id/leave`; `GET /api/events/logos/:file` (`<sha256>.png`).
  - A refusal with players answers `{ error: string, problems: { steamid, name, problems: string[] }[] }`.

- [ ] **Step 1: Write the failing tests**

`tests/eventEntryRoutes.test.ts`, set up like `tests/eventRoutes.test.ts` (copy its imports, `buildServer` call and `afterEach`), but build the world with the entry fixture's players and teams. Because `buildServer` takes the db, make the fixture's db first and pass it in:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import * as E from '../src/events/events.js';
import * as N from '../src/events/entries.js';
import { A, B, OUTSIDER, entryFixture, rosterA, rosterB, type EntryFixture } from './entryFixture.js';

let f: EntryFixture;
let app: FastifyInstance;
let communityDir: string;
const cookies: Record<string, Record<string, string>> = {};
let slug: string;
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

beforeEach(async () => {
  f = entryFixture({ startsAt: days(9) });
  communityDir = mkdtempSync(join(tmpdir(), 'entries-'));
  app = await buildServer({
    config: { ...loadConfig({}), communityDir }, db: f.db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
  });
  for (const s of [...A, ...B, OUTSIDER]) cookies[s] = authedCookie(app, f.db, s);
  slug = E.getEvent(f.db, f.eventId)!.slug;
});
afterEach(async () => { await app.close(); });

const get = (url: string, as?: string) => app.inject({ method: 'GET', url, cookies: as ? cookies[as] : undefined });
const post = (url: string, as: string, body: object = {}) => app.inject({ method: 'POST', url, cookies: cookies[as], payload: body });

describe('registration over HTTP', () => {
  it('offers a captain their team with each member marked, then registers it', async () => {
    const mine = (await get(`/api/events/${slug}/mine`, A[0])).json();
    expect(mine.canRegister).toBe(true);
    expect(mine.register).toHaveLength(1);
    expect(mine.register[0].members.map((m: { steamid: string }) => m.steamid)).toEqual(expect.arrayContaining(A));
    const res = await post(`/api/events/${slug}/entries`, A[0], { teamId: f.teamA, roster: rosterA() });
    expect(res.statusCode).toBe(200);
    const after = (await get(`/api/events/${slug}/mine`, A[0])).json();
    expect(after.register).toEqual([]);
    expect(after.entries[0]).toMatchObject({ name: 'Rats', manage: true, onRoster: true, status: 'registered', waitlist: null });
    const pub = (await get(`/api/events/${slug}`)).json();
    expect(pub.entries).toEqual([{ id: after.entries[0].id, name: 'Rats', tag: 'RAT', logoKey: null, seed: null, status: 'registered', waitlist: null }]);
  });

  it('answers a refusal with the players and their problems by name', async () => {
    f.db.prepare('UPDATE players SET discord_id = NULL WHERE steamid = ?').run(A[2]);
    const res = await post(`/api/events/${slug}/entries`, A[0], { teamId: f.teamA, roster: rosterA() });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'Someone on the roster does not meet the entry rules.',
      problems: [{ steamid: A[2], name: 'p2', problems: ['Discord is not linked'] }],
    });
  });

  it('lets a rostered player leave and a captain withdraw and check in', async () => {
    const id = (await post(`/api/events/${slug}/entries`, B[0], { teamId: f.teamB, roster: rosterB() })).json().id;
    expect((await post(`/api/events/${slug}/entries/${id}/checkin`, B[0])).statusCode).toBe(409);
    E.openCheckin(f.db, { eventId: f.eventId, by: null });
    expect((await post(`/api/events/${slug}/entries/${id}/checkin`, B[0])).statusCode).toBe(200);
    expect((await post(`/api/events/${slug}/entries/${id}/leave`, B[3])).statusCode).toBe(200);
    expect(N.getEntry(f.db, id)!.status).toBe('registered');
    expect((await post(`/api/events/${slug}/entries/${id}/withdraw`, B[0])).statusCode).toBe(200);
  });

  it('refuses an entry id from another event as not found', async () => {
    const id = (await post(`/api/events/${slug}/entries`, B[0], { teamId: f.teamB, roster: rosterB() })).json().id;
    const other = E.createEvent(f.db, { by: A[0], fields: { name: 'Other Cup', startsAt: days(30), entryKind: 'team' } });
    if (!other.ok) throw new Error(other.error);
    f.db.prepare("UPDATE events SET status = 'announced' WHERE id = ?").run(other.value.id);
    expect((await post(`/api/events/${other.value.slug}/entries/${id}/withdraw`, B[0])).statusCode).toBe(404);
  });

  it('is a 404 with the switch closed, and a 401 signed out', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/events/${slug}/entries`, payload: {} })).statusCode).toBe(401);
    f.db.prepare("UPDATE settings SET value = 'off' WHERE key = 'competitive_enabled'").run();
    expect((await get(`/api/events/${slug}/mine`, A[0])).statusCode).toBe(404);
  });
});

describe('entry logos', () => {
  const KEY = 'd'.repeat(64);
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a40000000049454e44ae426082', 'hex');
  beforeEach(() => {
    mkdirSync(join(communityDir, 'logos'), { recursive: true });
    writeFileSync(join(communityDir, 'logos', `${KEY}.png`), PNG);
  });

  it('serves a key only an entry of a visible event holds', async () => {
    expect((await get(`/api/events/logos/${KEY}.png`, A[0])).statusCode).toBe(404);
    f.db.prepare('UPDATE teams SET logo_key = ? WHERE id = ?').run(KEY, f.teamA);
    await post(`/api/events/${slug}/entries`, A[0], { teamId: f.teamA, roster: rosterA() });
    const res = await get(`/api/events/logos/${KEY}.png`, B[0]);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    f.db.prepare("UPDATE events SET status = 'draft' WHERE id = ?").run(f.eventId);
    expect((await get(`/api/events/logos/${KEY}.png`, B[0])).statusCode).toBe(404);
  });
});
```

Read `src/community/store.ts` for where the store puts `logos` (`FOLDER.logo` is `logos`, under the configured community dir) and `readLogo`; if the path is not `<communityDir>/logos/<sha>.png`, write the fixture file where `readLogo` looks.

If a case in `tests/eventRoutes.test.ts` pins the old entries shape (`{ name, tag, seed, status }`), update it to the new shape.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/eventEntryRoutes.test.ts`
Expected: FAIL (routes 404, view shape differs).

- [ ] **Step 3: Implement the views**

In `src/events/views.ts`:

Replace `EventEntryView` and add fields to `EventView`:

```ts
export interface EventEntryView { id: number; name: string; tag: string; logoKey: string | null; seed: number | null; status: string; waitlist: number | null }
```

and in `EventView` add `lockedAt: string | null; checkinOpensAt: string | null; checkinClosesAt: string | null;` after `cancelReason`.

Replace the `entries:` part of `eventView` with a call to this, and fill the new fields:

```ts
/** Ruling 12: active entries (disqualified ones too, marked), in seed order
 *  once the list is final and in registration order before, with the
 *  waitlist position of each entry past the cap. Never SR. */
function entryViews(db: DB, ev: E.EventRow): EventEntryView[] {
  const place = N.placementOf(db, ev);
  const rows = N.entriesOf(db, ev.id).filter((e) => e.status !== 'dropped');
  if (ev.locked_at !== null) rows.sort((a, b) => (a.seed ?? 1e9) - (b.seed ?? 1e9) || a.id - b.id);
  return rows.map((e) => {
    const w = place.waitlist.indexOf(e.id);
    return { id: e.id, name: e.name, tag: e.tag, logoKey: e.logo_key, seed: ev.locked_at !== null ? e.seed : null, status: e.status, waitlist: w >= 0 ? w + 1 : null };
  });
}
```

```ts
    entries: entryViews(db, ev),
    finishedAt: ev.finished_at, cancelledAt: ev.cancelled_at, cancelReason: ev.cancel_reason,
    lockedAt: ev.locked_at,
    ...(f.checkin.enabled
      ? (() => { const t = R.checkinTimes(ev.starts_at, f.checkin); return { checkinOpensAt: t.opensAt, checkinClosesAt: t.closesAt }; })()
      : { checkinOpensAt: null, checkinClosesAt: null }),
```

(import `* as N from './entries.js'` and `* as R from './entryRules.js'`). Make `entryCount` in the same file count only placed entries: `return N.placementOf(db, ev).placed.length;` (change its parameter to the event row and its call site).

Append the viewer's own view:

```ts
export interface RosterPlaceView { steamid: string; name: string; avatar: string | null; role: R.Role; problems: string[] }
export interface MemberOptionView { steamid: string; name: string; avatar: string | null; problems: string[]; elsewhere: string | null }
export interface MyEntryView {
  id: number; name: string; tag: string; logoKey: string | null; status: string; seed: number | null; waitlist: number | null;
  checkedInAt: string | null; manage: boolean; onRoster: boolean; roster: RosterPlaceView[];
  rosterLocked: boolean; additionsLeft: number | null;
  canEditRoster: boolean; canCheckIn: boolean; canWithdraw: boolean; canLeave: boolean;
  /** The team's current members, for the roster editor; managers only. */
  members: MemberOptionView[];
}
export interface RegisterOptionView { teamId: number; name: string; tag: string; logoKey: string | null; members: MemberOptionView[] }
export interface MyEventView { entries: MyEntryView[]; register: RegisterOptionView[]; canRegister: boolean }

/** What one signed-in player can do on this event page: the entries they
 *  manage or are on, and the teams they could register. Problems are the
 *  sentences of src/events/entryRules.ts problemText for the role a player
 *  has (members not yet on a roster are judged as starters). */
export function myEventView(db: DB, ev: E.EventRow, viewer: string, now = new Date()): MyEventView {
  const at = now.toISOString();
  const f = E.fieldsOf(ev);
  const place = N.placementOf(db, ev);
  const problems = (steamid: string, role: R.Role) => {
    const facts = N.playerFacts(db, steamid, now);
    return R.problemsOf(f.eligibility, facts, role).map((p) => R.problemText(p, f.eligibility, facts));
  };
  const person = (steamid: string) => { const p = getPlayer(db, steamid); return { name: p?.name ?? steamid, avatar: p?.avatar ?? null }; };
  const memberOptions = (teamId: number, entryId: number | null): MemberOptionView[] => activeMembers(db, teamId).map((m) => {
    const other = N.entryOfPlayer(db, ev.id, m.steamid);
    return { steamid: m.steamid, ...person(m.steamid), problems: problems(m.steamid, 'starter'), elsewhere: other && other.id !== entryId ? other.name : null };
  });
  const rosterOpen = ev.status === 'registration' || ev.status === 'checkin' || ev.status === 'live';
  const locked = R.rosterLocked(f.roster.lock, at);
  const preFinal = ev.locked_at === null && (ev.status === 'registration' || ev.status === 'checkin');

  const mine = N.entriesOf(db, ev.id).filter(N.isActive).filter((e) =>
    N.managersOf(db, e.team_id).includes(viewer) || N.placesOf(db, e.id).some((p) => p.steamid === viewer));
  const entries: MyEntryView[] = mine.map((e) => {
    const manage = N.managersOf(db, e.team_id).includes(viewer);
    const places = N.placesOf(db, e.id);
    const w = place.waitlist.indexOf(e.id);
    return {
      id: e.id, name: e.name, tag: e.tag, logoKey: e.logo_key, status: e.status, seed: ev.locked_at !== null ? e.seed : null,
      waitlist: w >= 0 ? w + 1 : null, checkedInAt: e.checked_in_at, manage, onRoster: places.some((p) => p.steamid === viewer),
      roster: places.map((p) => ({ steamid: p.steamid, ...person(p.steamid), role: p.role, problems: problems(p.steamid, p.role) })),
      rosterLocked: locked,
      additionsLeft: f.roster.maxAdditions === null ? null : Math.max(0, f.roster.maxAdditions - e.additions),
      canEditRoster: manage && rosterOpen && !locked,
      canCheckIn: manage && ev.status === 'checkin' && ev.locked_at === null && e.status === 'registered',
      canWithdraw: manage && preFinal,
      canLeave: places.some((p) => p.steamid === viewer) && (ev.status === 'registration' || ev.status === 'checkin'),
      members: manage && e.team_id !== null ? memberOptions(e.team_id, e.id) : [],
    };
  });

  const canRegister = ev.entry_kind === 'team' && ev.status === 'registration' && ev.locked_at === null && at < ev.starts_at;
  const register: RegisterOptionView[] = canRegister
    ? myTeams(db, viewer).filter((t) => (t.role === 'captain' || t.role === 'cocaptain') && !N.entryOfTeam(db, ev.id, t.id))
      .map((t) => ({ teamId: t.id, name: t.name, tag: t.tag, logoKey: t.logo_key, members: memberOptions(t.id, null) }))
    : [];
  return { entries, register, canRegister };
}
```

(import `activeMembers`, `myTeams` from `../teams/teams.js`).

- [ ] **Step 4: Implement the routes**

In `src/routes/events.ts`: extend the options to `{ db: DB; store: () => CommunityStore; notifier?: Notifier; publicUrl?: string }`, add `makeRequireActive` to the guards import, and add, inside `eventRoutes`:

```ts
  const requireActive = makeRequireActive(db);
  /** An active player the switch lets in, or the reply sent: the closed
   *  switch answers 404 before the login check, as the team routes do. */
  const allowedActive = (req: FastifyRequest, reply: FastifyReply): string | null => {
    if (!competitiveAccess(db, optionalViewer(req))) { reply.code(404).send(NOT_FOUND); return null; }
    return requireActive(req, reply);
  };
  const visibleEvent = (slug: string, viewer: string | null): E.EventRow | undefined => {
    const ev = getEventBySlug(db, slug);
    return ev && (ev.status !== 'draft' || isStaff(viewer)) ? ev : undefined;
  };
  const refuse = (reply: FastifyReply, r: { error: V.EventError; detail?: V.EntryProblem[] }) =>
    reply.code(V.EVENT_ERRORS[r.error].status).send({
      error: V.EVENT_ERRORS[r.error].text,
      ...(r.detail ? { problems: r.detail.map((p) => ({ steamid: p.steamid, name: getPlayer(db, p.steamid)?.name ?? p.steamid, problems: p.problems })) } : {}),
    });
  const entryIn = (ev: E.EventRow, raw: string): N.EntryRow | undefined => {
    const id = Number(raw);
    const e = Number.isInteger(id) ? N.getEntry(db, id) : undefined;
    return e && e.event_id === ev.id ? e : undefined;
  };
  /** Ruling 11: tell players someone else put on a roster. Never fails the request. */
  const tellAdded = (ev: E.EventRow, entryId: number, by: string, added: N.Added) => {
    const notifier = opts.notifier;
    if (!notifier) return;
    for (const p of added) {
      if (p.steamid === by) continue;
      try {
        const msg = eventMessage(db, opts.publicUrl ?? '', ev.id, 'event_roster_added', { entryId, by, role: p.role });
        if (msg) notifier.send([p.steamid], 'event_roster_added', msg);
      } catch (err) {
        console.warn('[events] roster DM failed:', err instanceof Error ? err.message : err);
      }
    }
  };
  type SlugId = { slug: string; id: string };

  app.get('/api/events/:slug/mine', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const ev = visibleEvent((req.params as { slug: string }).slug, me);
    if (!ev) return reply.code(404).send(NOT_FOUND);
    return myEventView(db, ev, me);
  });

  app.post('/api/events/:slug/entries', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const ev = visibleEvent((req.params as { slug: string }).slug, me);
    if (!ev) return reply.code(404).send(NOT_FOUND);
    const body = (req.body ?? {}) as { teamId?: unknown; roster?: unknown };
    const teamId = Number(body.teamId);
    if (!Number.isInteger(teamId)) return refuse(reply, { error: 'team_not_found' });
    const r = N.registerEntry(db, { eventId: ev.id, teamId, by: me, roster: body.roster });
    if (!r.ok) return refuse(reply, r);
    tellAdded(ev, r.value.entry.id, me, r.value.added);
    return { id: r.value.entry.id };
  });

  app.post('/api/events/:slug/entries/:id/roster', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const p = req.params as SlugId;
    const ev = visibleEvent(p.slug, me);
    const entry = ev && entryIn(ev, p.id);
    if (!ev || !entry) return refuse(reply, { error: 'entry_not_found' });
    const r = N.setEntryRoster(db, { entryId: entry.id, by: me, roster: ((req.body ?? {}) as { roster?: unknown }).roster });
    if (!r.ok) return refuse(reply, r);
    tellAdded(ev, entry.id, me, r.value.added);
    return {};
  });

  for (const action of ['withdraw', 'checkin', 'leave'] as const) {
    app.post(`/api/events/:slug/entries/:id/${action}`, async (req, reply) => {
      const me = allowedActive(req, reply);
      if (!me) return;
      const p = req.params as SlugId;
      const ev = visibleEvent(p.slug, me);
      const entry = ev && entryIn(ev, p.id);
      if (!ev || !entry) return refuse(reply, { error: 'entry_not_found' });
      const r = action === 'withdraw' ? N.withdrawEntry(db, { entryId: entry.id, by: me })
        : action === 'checkin' ? N.checkInEntry(db, { entryId: entry.id, by: me })
          : N.leaveEntry(db, { entryId: entry.id, steamid: me });
      if (!r.ok) return refuse(reply, r);
      return {};
    });
  }

  /** An entry's logo snapshot, only while an entry of an event this viewer
   *  may see holds the key (Review Focus). Same headers as a team logo. */
  app.get('/api/events/logos/:file', async (req, reply) => {
    const v = allowedViewer(req, reply);
    if (!v) return;
    const m = /^([0-9a-f]{64})\.png$/.exec((req.params as { file: string }).file);
    if (!m) return reply.code(404).send(NOT_FOUND);
    const holders = db.prepare(
      "SELECT e.status FROM event_entries x JOIN events e ON e.id = x.event_id WHERE x.logo_key = ? AND x.status <> 'dropped'",
    ).all(m[1]) as { status: string }[];
    if (!holders.some((h) => h.status !== 'draft' || isStaff(v.viewer))) return reply.code(404).send(NOT_FOUND);
    const bytes = opts.store().readLogo(m[1]!);
    if (!bytes) return reply.code(404).send(NOT_FOUND);
    return reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'public, max-age=3600')
      .type('image/png').send(bytes);
  });
```

Imports to add: `* as E from '../events/events.js'` (or extend the existing named import), `* as N from '../events/entries.js'`, `* as V from '../events/validate.js'`, `{ myEventView }` from `../events/views.js`, `{ eventMessage }` from `../events/messages.js`, `type { Notifier }` from `../notify/notify.js`, `makeRequireActive` from `./guards.js`.

The registration `POST /api/events/:slug/entries` answers 404 for a draft (via `visibleEvent`), and `registerEntry` itself refuses a draft too.

In `src/server.ts`, change the `eventRoutes` registration to `await app.register(eventRoutes, { db: deps.db, store: getCommunityStore, notifier, publicUrl: deps.config.publicUrl });` (it is registered after `notifier` is built; if not, move it below).

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/eventEntryRoutes.test.ts tests/eventRoutes.test.ts tests/eventGating.test.ts tests/eventBanners.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/events/views.ts src/routes/events.ts src/server.ts tests/eventEntryRoutes.test.ts tests/eventRoutes.test.ts
git commit -m "Event entries over HTTP: the viewer's own entries and teams to register, register, roster, withdraw, check-in and leave routes with per-player refusals, entry logo snapshots, waitlist and seeds on the public page"
```

---

### Task 7: The desk's entries view and staff actions

**Files:**
- Modify: `src/events/views.ts`, `src/routes/adminEvents.ts`
- Test: `tests/adminEventEntries.test.ts` (new)

**Interfaces:**
- Consumes: Tasks 3, 4, 6.
- Produces:
  - `interface AdminEntryView { id; teamSlug: string | null; name; tag; status: string; dropReason: string | null; seed: number | null; waitlist: number | null; sr: number; checkedInAt: string | null; createdAt: string; registeredByName: string; roster: RosterPlaceView[] }`; `adminEntryViews(db, ev): AdminEntryView[]` (every entry, dropped ones last).
  - `GET /api/admin/events/:id/entries` (staff) → `{ lockedAt: string | null; entries: AdminEntryView[] }`.
  - Admin POSTs: `/api/admin/events/:id/open-checkin`, `/lock-entries`, `/seeds` `{ order }`, `/entries/:entryId/roster` `{ roster }`, `/entries/:entryId/disqualify` `{ reason }`, `/entries/:entryId/restore`. Each `logAdmin` with actions `event_open_checkin`, `event_lock_entries`, `event_seeds`, `event_entry_roster`, `event_entry_disqualify`, `event_entry_restore`.

- [ ] **Step 1: Write the failing tests**

`tests/adminEventEntries.test.ts`, built like Task 6's route test (entry fixture db into `buildServer`), with `ADMIN` from `tests/eventFixture.ts` (already an admin in the fixture) and a mod:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { upsertPlayer } from '../src/players.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import * as E from '../src/events/events.js';
import * as N from '../src/events/entries.js';
import { ADMIN } from './eventFixture.js';
import { A, B, OUTSIDER, entryFixture, rosterA, rosterB, type EntryFixture } from './entryFixture.js';

const MOD = '76561199000000830';
let f: EntryFixture;
let app: FastifyInstance;
const cookies: Record<string, Record<string, string>> = {};
let ea: number;
let eb: number;

beforeEach(async () => {
  f = entryFixture({ teamCap: 1, startsAt: new Date(Date.now() + 9 * 86_400_000).toISOString() });
  upsertPlayer(f.db, { steamid: MOD, name: 'mod', avatar: null }, []);
  f.db.prepare("UPDATE players SET is_mod = 1, status = 'active' WHERE steamid = ?").run(MOD);
  app = await buildServer({
    config: { ...loadConfig({}), communityDir: mkdtempSync(join(tmpdir(), 'desk-entries-')) },
    db: f.db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
  });
  for (const s of [ADMIN, MOD]) cookies[s] = authedCookie(app, f.db, s);
  const reg = (team: number, by: string, roster: object) => {
    const r = N.registerEntry(f.db, { eventId: f.eventId, teamId: team, by, roster });
    if (!r.ok) throw new Error(r.error);
    return r.value.entry.id;
  };
  ea = reg(f.teamA, A[0], rosterA());
  eb = reg(f.teamB, B[0], rosterB());
});
afterEach(async () => { await app.close(); });

const post = (url: string, as: string, body: object = {}) => app.inject({ method: 'POST', url, cookies: cookies[as], payload: body });

describe('desk entries', () => {
  it('lists entries with roster, SR and waitlist for staff', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/admin/events/${f.eventId}/entries`, cookies: cookies[MOD] });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.lockedAt).toBeNull();
    expect(body.entries.map((e: { id: number; waitlist: number | null }) => [e.id, e.waitlist])).toEqual([[ea, null], [eb, 1]]);
    expect(body.entries[0].roster).toHaveLength(5);
    expect(typeof body.entries[0].sr).toBe('number');
  });

  it('refuses every write from a mod', async () => {
    for (const url of ['open-checkin', 'lock-entries', `entries/${ea}/restore`, `entries/${ea}/disqualify`]) {
      expect((await post(`/api/admin/events/${f.eventId}/${url}`, MOD)).statusCode).toBe(403);
    }
  });

  it('opens check-in, finalises, reorders seeds, and audits each', async () => {
    expect((await post(`/api/admin/events/${f.eventId}/open-checkin`, ADMIN)).statusCode).toBe(200);
    N.checkInEntry(f.db, { entryId: eb, by: B[0] });
    expect((await post(`/api/admin/events/${f.eventId}/lock-entries`, ADMIN)).statusCode).toBe(200);
    expect(N.getEntry(f.db, eb)!.seed).toBe(1);
    expect((await post(`/api/admin/events/${f.eventId}/seeds`, ADMIN, { order: [eb] })).statusCode).toBe(200);
    const actions = (f.db.prepare("SELECT action FROM admin_actions WHERE action LIKE 'event_%' ORDER BY id").all() as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(['event_open_checkin', 'event_lock_entries', 'event_seeds']);
  });

  it('edits a roster as staff, disqualifies with a reason and restores', async () => {
    expect((await post(`/api/admin/events/${f.eventId}/entries/${ea}/roster`, ADMIN, { roster: rosterA({ coach: OUTSIDER }) })).statusCode).toBe(200);
    expect((await post(`/api/admin/events/${f.eventId}/entries/${ea}/disqualify`, ADMIN, { reason: 'Ringer' })).statusCode).toBe(200);
    expect(N.getEntry(f.db, ea)!.status).toBe('disqualified');
    expect((await post(`/api/admin/events/${f.eventId}/entries/${ea}/restore`, ADMIN)).statusCode).toBe(200);
    expect(E.eventLog(f.db, f.eventId).map((l) => l.action)).toEqual(expect.arrayContaining(['entry_disqualified', 'entry_restored']));
  });

  it('answers an entry of another event as not found', async () => {
    expect((await post(`/api/admin/events/${f.eventId + 99}/entries/${ea}/restore`, ADMIN)).statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/adminEventEntries.test.ts`
Expected: FAIL (404s).

- [ ] **Step 3: Implement**

In `src/events/views.ts`, append:

```ts
export interface AdminEntryView {
  id: number; teamSlug: string | null; name: string; tag: string; status: string; dropReason: string | null; seed: number | null;
  waitlist: number | null; sr: number; checkedInAt: string | null; createdAt: string; registeredByName: string; roster: RosterPlaceView[];
}

/** The desk's list (Ruling 10): every entry, dropped and disqualified ones
 *  after the rest, with average starter SR, which the public never sees. */
export function adminEntryViews(db: DB, ev: E.EventRow): AdminEntryView[] {
  const f = E.fieldsOf(ev);
  const place = N.placementOf(db, ev);
  const rows = N.entriesOf(db, ev.id);
  const ordered = [...rows.filter(N.isActive), ...rows.filter((e) => !N.isActive(e))];
  return ordered.map((e) => {
    const w = place.waitlist.indexOf(e.id);
    return {
      id: e.id, teamSlug: e.team_id !== null ? getTeam(db, e.team_id)?.slug ?? null : null, name: e.name, tag: e.tag, status: e.status,
      dropReason: e.drop_reason, seed: e.seed, waitlist: w >= 0 ? w + 1 : null, sr: N.entrySr(db, e.id), checkedInAt: e.checked_in_at,
      createdAt: e.created_at, registeredByName: getPlayer(db, e.registered_by)?.name ?? e.registered_by,
      roster: N.placesOf(db, e.id).map((p) => {
        const facts = N.playerFacts(db, p.steamid);
        const pl = getPlayer(db, p.steamid);
        return {
          steamid: p.steamid, name: pl?.name ?? p.steamid, avatar: pl?.avatar ?? null, role: p.role,
          problems: R.problemsOf(f.eligibility, facts, p.role).map((k) => R.problemText(k, f.eligibility, facts)),
        };
      }),
    };
  });
}
```

(import `getTeam` from `../teams/teams.js`).

In `src/routes/adminEvents.ts`, inside `adminEventRoutes`, add (`N` = `../events/entries.js`, `adminEntryViews` from `../events/views.js`):

```ts
  const eventOf = (raw: unknown): E.EventRow | undefined => { const id = idOf(raw); return id ? E.getEvent(db, id) : undefined; };
  const entryOf = (ev: E.EventRow, raw: unknown): N.EntryRow | undefined => {
    const id = idOf(raw);
    const e = id ? N.getEntry(db, id) : undefined;
    return e && e.event_id === ev.id ? e : undefined;
  };
  const refuseWith = (reply: FastifyReply, r: { error: V.EventError; detail?: V.EntryProblem[] }) =>
    reply.code(V.EVENT_ERRORS[r.error].status).send({
      error: V.EVENT_ERRORS[r.error].text,
      ...(r.detail ? { problems: r.detail.map((p) => ({ steamid: p.steamid, name: getPlayer(db, p.steamid)?.name ?? p.steamid, problems: p.problems })) } : {}),
    });

  app.get('/api/admin/events/:id/entries', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    const ev = eventOf((req.params as { id: string }).id);
    if (!ev) return refuse(reply, 'not_found');
    return { lockedAt: ev.locked_at, entries: adminEntryViews(db, ev) };
  });

  app.post('/api/admin/events/:id/open-checkin', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const ev = eventOf((req.params as { id: string }).id);
    if (!ev) return refuse(reply, 'not_found');
    const r = E.openCheckin(db, { eventId: ev.id, by: me });
    if (!r.ok) return refuse(reply, r.error);
    logAdmin(db, me, 'event_open_checkin', ev.id, { slug: ev.slug });
    return {};
  });

  app.post('/api/admin/events/:id/lock-entries', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const ev = eventOf((req.params as { id: string }).id);
    if (!ev) return refuse(reply, 'not_found');
    const r = N.lockEntries(db, { eventId: ev.id, by: me });
    if (!r.ok) return refuse(reply, r.error);
    logAdmin(db, me, 'event_lock_entries', ev.id, { slug: ev.slug, kept: r.value.kept.length, dropped: r.value.dropped.length });
    return r.value;
  });

  app.post('/api/admin/events/:id/seeds', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const ev = eventOf((req.params as { id: string }).id);
    if (!ev) return refuse(reply, 'not_found');
    const r = N.reorderSeeds(db, { eventId: ev.id, by: me, order: ((req.body ?? {}) as { order?: unknown }).order });
    if (!r.ok) return refuse(reply, r.error);
    logAdmin(db, me, 'event_seeds', ev.id, { order: r.value });
    return {};
  });

  app.post('/api/admin/events/:id/entries/:entryId/:action', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const p = req.params as { id: string; entryId: string; action: string };
    const ev = eventOf(p.id);
    const entry = ev && entryOf(ev, p.entryId);
    if (!ev || !entry) return refuse(reply, 'entry_not_found');
    const body = (req.body ?? {}) as { roster?: unknown; reason?: unknown };
    let r: V.Checked<unknown>;
    let action: string;
    switch (p.action) {
      case 'roster': r = N.setEntryRoster(db, { entryId: entry.id, by: me, roster: body.roster, staff: true }); action = 'event_entry_roster'; break;
      case 'disqualify': r = N.disqualifyEntry(db, { entryId: entry.id, by: me, reason: body.reason }); action = 'event_entry_disqualify'; break;
      case 'restore': r = N.restoreEntry(db, { entryId: entry.id, by: me }); action = 'event_entry_restore'; break;
      default: return refuse(reply, 'bad_request');
    }
    if (!r.ok) return refuseWith(reply, r);
    logAdmin(db, me, action, ev.id, { entryId: entry.id, name: entry.name, ...(p.action === 'disqualify' ? { reason: body.reason } : {}) });
    return {};
  });
```

Check `makeRequireAdmin` answers a mod with 403 (T1a's tests say so); the mod test relies on it. The existing `refuse` takes an error key; `refuseWith` adds the players list for roster refusals.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/adminEventEntries.test.ts tests/adminEventRoutes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/events/views.ts src/routes/adminEvents.ts tests/adminEventEntries.test.ts
git commit -m "Events desk: entries with rosters, eligibility, SR and waitlist for staff; admins open check-in, close the entry list, reorder seeds, edit rosters, disqualify and restore"
```

---

### Task 8: The event page: register, my entry, check-in

**Files:**
- Modify: `web/src/api.ts`, `web/src/routes/Event.tsx`, `web/src/styles/app.css`
- Create: `web/src/routes/event/RosterPicker.tsx`, `web/src/routes/event/EntryPanel.tsx`, `web/src/routes/event/EntryPanel.test.tsx`
- Test: `web/src/routes/Event.test.tsx` (update the entries cases)

**Interfaces:**
- Consumes: Task 6 routes and shapes.
- Produces: `ApiError.problems?: { steamid: string; name: string; problems: string[] }[]`; types `EventEntryView` (new shape), `MyEventView`, `MyEntryView`, `RegisterOptionView`, `MemberOptionView`, `RosterPlaceView`, `EntryRoster = { starters: string[]; subs: string[]; coach: string | null }`; `eventsApi.mine(slug, signal)`, `register(slug, teamId, roster)`, `setRoster(slug, entryId, roster)`, `withdraw(slug, entryId)`, `checkIn(slug, entryId)`, `leave(slug, entryId)`; `entryLogoUrl(key)`.

- [ ] **Step 1: API types and calls**

In `web/src/api.ts`:

Give `ApiError` a fourth constructor parameter `readonly problems?: { steamid: string; name: string; problems: string[] }[]` and pass `(parsed as { problems?: ... }).problems` from `post`.

Replace `EventEntryView` and extend `EventView` (mirrors `src/events/views.ts`):

```ts
export interface EventEntryView { id: number; name: string; tag: string; logoKey: string | null; seed: number | null; status: string; waitlist: number | null }
```

and add `lockedAt: string | null; checkinOpensAt: string | null; checkinClosesAt: string | null;` to `EventView`. Then:

```ts
export type EntryRole = 'starter' | 'sub' | 'coach';
export interface EntryRoster { starters: string[]; subs: string[]; coach: string | null }
export interface RosterPlaceView { steamid: string; name: string; avatar: string | null; role: EntryRole; problems: string[] }
export interface MemberOptionView { steamid: string; name: string; avatar: string | null; problems: string[]; elsewhere: string | null }
export interface MyEntryView {
  id: number; name: string; tag: string; logoKey: string | null; status: string; seed: number | null; waitlist: number | null;
  checkedInAt: string | null; manage: boolean; onRoster: boolean; roster: RosterPlaceView[];
  rosterLocked: boolean; additionsLeft: number | null;
  canEditRoster: boolean; canCheckIn: boolean; canWithdraw: boolean; canLeave: boolean; members: MemberOptionView[];
}
export interface RegisterOptionView { teamId: number; name: string; tag: string; logoKey: string | null; members: MemberOptionView[] }
export interface MyEventView { entries: MyEntryView[]; register: RegisterOptionView[]; canRegister: boolean }
export const entryLogoUrl = (key: string): string => `/api/events/logos/${key}.png`;
```

and extend `eventsApi`:

```ts
  mine: (slug: string, signal?: AbortSignal) => get<MyEventView>(`/api/events/${enc(slug)}/mine`, signal),
  register: (slug: string, teamId: number, roster: EntryRoster) => post<{ id: number }>(`/api/events/${enc(slug)}/entries`, { teamId, roster }),
  setRoster: (slug: string, entryId: number, roster: EntryRoster) => post(`/api/events/${enc(slug)}/entries/${entryId}/roster`, { roster }),
  withdraw: (slug: string, entryId: number) => post(`/api/events/${enc(slug)}/entries/${entryId}/withdraw`),
  checkIn: (slug: string, entryId: number) => post(`/api/events/${enc(slug)}/entries/${entryId}/checkin`),
  leave: (slug: string, entryId: number) => post(`/api/events/${enc(slug)}/entries/${entryId}/leave`),
```

- [ ] **Step 2: Write the failing component tests**

`web/src/routes/event/EntryPanel.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { MyEventView, MemberOptionView } from '../../api';

const { mockEvents } = vi.hoisted(() => ({
  mockEvents: { mine: vi.fn(), register: vi.fn(), setRoster: vi.fn(), withdraw: vi.fn(), checkIn: vi.fn(), leave: vi.fn() },
}));
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, eventsApi: { ...actual.eventsApi, ...mockEvents } };
});
vi.mock('../../components/Confirm', () => ({ confirm: vi.fn(async () => true) }));
const { EntryPanel } = await import('./EntryPanel');
const { ApiError } = await import('../../api');

const member = (n: number, over: Partial<MemberOptionView> = {}): MemberOptionView =>
  ({ steamid: `7656119900000080${n}`, name: `p${n}`, avatar: null, problems: [], elsewhere: null, ...over });
const team = { teamId: 7, name: 'Rats', tag: 'RAT', logoKey: null, members: [1, 2, 3, 4, 5].map((n) => member(n)) };

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('EntryPanel', () => {
  it('registers a team with the first four members as starters by default', async () => {
    const view: MyEventView = { entries: [], register: [team], canRegister: true };
    mockEvents.register.mockResolvedValue({ id: 1 });
    const onChange = vi.fn();
    render(<EntryPanel slug="cup" view={view} maxSubs={2} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Register Rats' }));
    await waitFor(() => expect(mockEvents.register).toHaveBeenCalledWith('cup', 7, {
      starters: team.members.slice(0, 4).map((m) => m.steamid), subs: [], coach: null,
    }));
    expect(onChange).toHaveBeenCalled();
  });

  it('marks a member who cannot play and says why', () => {
    const view: MyEventView = { entries: [], register: [{ ...team, members: [member(1, { problems: ['2 of 5 completed PUGs'] }), ...team.members.slice(1)] }], canRegister: true };
    render(<EntryPanel slug="cup" view={view} maxSubs={2} onChange={() => {}} />);
    expect(screen.getByText('2 of 5 completed PUGs')).toBeTruthy();
  });

  it('shows the server refusal with each named player', async () => {
    mockEvents.register.mockRejectedValue(new ApiError(409, 'Someone on the roster does not meet the entry rules.', undefined,
      [{ steamid: '1', name: 'p3', problems: ['Discord is not linked'] }]));
    render(<EntryPanel slug="cup" view={{ entries: [], register: [team], canRegister: true }} maxSubs={2} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Register Rats' }));
    expect(await screen.findByText(/p3: Discord is not linked/)).toBeTruthy();
  });

  it('offers check-in, withdraw and leave only when the view allows them', async () => {
    const entry = {
      id: 3, name: 'Rats', tag: 'RAT', logoKey: null, status: 'registered', seed: null, waitlist: 2, checkedInAt: null,
      manage: true, onRoster: true, roster: [], rosterLocked: false, additionsLeft: null,
      canEditRoster: true, canCheckIn: true, canWithdraw: true, canLeave: false, members: team.members,
    };
    mockEvents.checkIn.mockResolvedValue({});
    render(<EntryPanel slug="cup" view={{ entries: [entry], register: [], canRegister: false }} maxSubs={2} onChange={() => {}} />);
    expect(screen.getByText(/Waitlist, number 2/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Leave roster' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check in' }));
    await waitFor(() => expect(mockEvents.checkIn).toHaveBeenCalledWith('cup', 3));
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `cd web && npx vitest run src/routes/event/EntryPanel.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement**

`web/src/routes/event/RosterPicker.tsx`:

```tsx
import type { EntryRole, EntryRoster, MemberOptionView } from '../../api';

const ROLE_LABEL: Record<EntryRole | 'out', string> = { starter: 'Starter', sub: 'Sub', coach: 'Coach', out: 'Not playing' };

/** A role per player: starter, sub, coach or not playing. The counts live
 *  under the list; the server checks the rest and names who fails. */
export function RosterPicker({ members, roster, maxSubs, onChange }: {
  members: MemberOptionView[]; roster: EntryRoster; maxSubs: number; onChange: (r: EntryRoster) => void;
}) {
  const roleOf = (s: string): EntryRole | 'out' =>
    roster.starters.includes(s) ? 'starter' : roster.subs.includes(s) ? 'sub' : roster.coach === s ? 'coach' : 'out';
  const set = (s: string, role: EntryRole | 'out') => {
    const next: EntryRoster = {
      starters: roster.starters.filter((x) => x !== s), subs: roster.subs.filter((x) => x !== s), coach: roster.coach === s ? null : roster.coach,
    };
    if (role === 'starter') next.starters.push(s);
    if (role === 'sub') next.subs.push(s);
    if (role === 'coach') next.coach = s;
    onChange(next);
  };
  return (
    <div class="rosterpick">
      <ul class="rosterpick__list">
        {members.map((m) => (
          <li key={m.steamid} class={`rosterpick__row${m.problems.length || m.elsewhere ? ' rosterpick__row--warn' : ''}`}>
            <span class="rosterpick__name">{m.name}</span>
            <select aria-label={`Role for ${m.name}`} value={roleOf(m.steamid)} onChange={(e) => set(m.steamid, (e.target as HTMLSelectElement).value as EntryRole | 'out')}>
              {(['starter', 'sub', 'coach', 'out'] as const).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
            {m.elsewhere && <span class="rosterpick__why">Already on {m.elsewhere}'s roster</span>}
            {m.problems.map((p) => <span key={p} class="rosterpick__why">{p}</span>)}
          </li>
        ))}
      </ul>
      <p class="muted">{roster.starters.length} of 4 starters · {roster.subs.length} of {maxSubs} subs · {roster.coach ? '1 coach' : 'no coach'}</p>
    </div>
  );
}

/** The first four members start, the rest sit out until picked. */
export function defaultRoster(members: MemberOptionView[]): EntryRoster {
  return { starters: members.slice(0, 4).map((m) => m.steamid), subs: [], coach: null };
}
```

`web/src/routes/event/EntryPanel.tsx`:

```tsx
import { useState } from 'preact/hooks';
import { ApiError, eventsApi, type EntryRoster, type MyEntryView, type MyEventView, type RegisterOptionView } from '../../api';
import { Panel } from '../../components/bits';
import { confirm } from '../../components/Confirm';
import { RosterPicker, defaultRoster } from './RosterPicker';

const ROLE: Record<string, string> = { starter: 'Starter', sub: 'Sub', coach: 'Coach' };

/** The server's sentence, then one line per named player (Task 6). */
function errorLines(err: unknown): string[] {
  if (!(err instanceof ApiError)) return ['Something went wrong.'];
  return [err.message, ...(err.problems ?? []).map((p) => `${p.name}: ${p.problems.join(', ')}`)];
}

function useSubmit(onChange: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string[]>([]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError([]);
    try {
      await fn();
      onChange();
    } catch (err) {
      setError(errorLines(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function Errors({ lines }: { lines: string[] }) {
  return lines.length ? <div class="error" role="alert">{lines.map((l) => <p key={l}>{l}</p>)}</div> : null;
}

function Register({ slug, team, maxSubs, onChange }: { slug: string; team: RegisterOptionView; maxSubs: number; onChange: () => void }) {
  const [roster, setRoster] = useState<EntryRoster>(() => defaultRoster(team.members));
  const { busy, error, run } = useSubmit(onChange);
  return (
    <div class="entrypanel__team">
      <h4>{team.name} <span class="muted">[{team.tag}]</span></h4>
      <RosterPicker members={team.members} roster={roster} maxSubs={maxSubs} onChange={setRoster} />
      <Errors lines={error} />
      <button class="btn" disabled={busy} onClick={() => run(() => eventsApi.register(slug, team.teamId, roster))}>Register {team.name}</button>
    </div>
  );
}

function statusLine(e: MyEntryView): string {
  if (e.status === 'checked_in') return 'Checked in';
  if (e.waitlist !== null) return `Waitlist, number ${e.waitlist}`;
  if (e.seed !== null) return `Seed ${e.seed}`;
  return 'Registered';
}

function MyEntry({ slug, entry, maxSubs, onChange }: { slug: string; entry: MyEntryView; maxSubs: number; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [roster, setRoster] = useState<EntryRoster>(() => ({
    starters: entry.roster.filter((p) => p.role === 'starter').map((p) => p.steamid),
    subs: entry.roster.filter((p) => p.role === 'sub').map((p) => p.steamid),
    coach: entry.roster.find((p) => p.role === 'coach')?.steamid ?? null,
  }));
  const { busy, error, run } = useSubmit(() => { setEditing(false); onChange(); });
  return (
    <div class="entrypanel__team">
      <h4>{entry.name} <span class="muted">[{entry.tag}]</span> <span class="teamchip">{statusLine(entry)}</span></h4>
      {editing ? (
        <RosterPicker members={entry.members} roster={roster} maxSubs={maxSubs} onChange={setRoster} />
      ) : (
        <ul class="entrypanel__roster">
          {entry.roster.map((p) => (
            <li key={p.steamid}>
              <span class="chip">{ROLE[p.role]}</span> {p.name}
              {p.problems.map((x) => <span key={x} class="rosterpick__why">{x}</span>)}
            </li>
          ))}
        </ul>
      )}
      {entry.rosterLocked && <p class="muted">Rosters are locked; staff can still change yours.</p>}
      {entry.additionsLeft !== null && <p class="muted">{entry.additionsLeft} roster addition{entry.additionsLeft === 1 ? '' : 's'} left.</p>}
      <Errors lines={error} />
      <div class="inlinerow">
        {entry.canCheckIn && <button class="btn" disabled={busy} onClick={() => run(() => eventsApi.checkIn(slug, entry.id))}>Check in</button>}
        {entry.canEditRoster && !editing && <button class="btn btn--ghost" onClick={() => setEditing(true)}>Edit roster</button>}
        {editing && <button class="btn" disabled={busy} onClick={() => run(() => eventsApi.setRoster(slug, entry.id, roster))}>Save roster</button>}
        {editing && <button class="btn btn--ghost" onClick={() => setEditing(false)}>Cancel</button>}
        {entry.canLeave && !editing && (
          <button class="btn btn--ghost" disabled={busy} onClick={async () => {
            if (await confirm({ title: 'Leave this roster?', body: `You will no longer play for ${entry.name} in this event.`, confirmLabel: 'Leave roster' })) {
              void run(() => eventsApi.leave(slug, entry.id));
            }
          }}>Leave roster</button>
        )}
        {entry.canWithdraw && !editing && (
          <button class="btn btn--ghost" disabled={busy} onClick={async () => {
            if (await confirm({ title: `Withdraw ${entry.name}?`, body: 'The team leaves the event. You can register again while registration is open, at the back of the list.', confirmLabel: 'Withdraw' })) {
              void run(() => eventsApi.withdraw(slug, entry.id));
            }
          }}>Withdraw</button>
        )}
      </div>
    </div>
  );
}

/** The viewer's part of the event page (plan T1b): their entries, then the
 *  teams they could register. Nothing at all when there is neither. */
export function EntryPanel({ slug, view, maxSubs, onChange }: { slug: string; view: MyEventView; maxSubs: number; onChange: () => void }) {
  if (view.entries.length === 0 && view.register.length === 0) return null;
  return (
    <Panel class="entrypanel">
      <h3>{view.entries.length ? 'Your entry' : 'Register your team'}</h3>
      {view.entries.map((e) => <MyEntry key={e.id} slug={slug} entry={e} maxSubs={maxSubs} onChange={onChange} />)}
      {view.register.map((t) => <Register key={t.teamId} slug={slug} team={t} maxSubs={maxSubs} onChange={onChange} />)}
    </Panel>
  );
}
```

Check the `confirm` options shape in `web/src/components/Confirm.tsx` (`ConfirmOptions`) and rename `title`/`body`/`confirmLabel` to its actual keys.

In `web/src/routes/Event.tsx`:

- Fetch `eventsApi.mine(slug)` when `session.kind === 'active'` (ignore failures: the panel stays hidden), keep it in state, and refetch both the event and `mine` on `onChange` (a `gen` counter in the effect dependencies does it).
- Render `<EntryPanel slug={ev.slug} view={mine} maxSubs={ev.roster.maxSubs} onChange={bump} />` right after the Entry panel.
- In the Entry panel, when `ev.checkinOpensAt` is set and the event is before its start, add a line `Check-in {whenText(ev.checkinOpensAt)} to {whenText(ev.checkinClosesAt)}`; when `ev.lockedAt` is set, show `The entry list is final.`
- Replace the Teams list item with a logo, name, tag and marks:

```tsx
<li key={e.id} class="evententry">
  {e.logoKey ? <img class="evententry__logo" src={entryLogoUrl(e.logoKey)} alt="" width={28} height={28} /> : <span class="evententry__logo evententry__logo--none" aria-hidden="true">{e.name.slice(0, 1).toUpperCase()}</span>}
  {e.seed !== null && <span class="muted">#{e.seed} </span>}{e.name}{e.tag && <span class="muted"> [{e.tag}]</span>}
  {e.status === 'checked_in' && <span class="chip chip--ok">Checked in</span>}
  {e.waitlist !== null && <span class="chip">Waitlist {e.waitlist}</span>}
  {e.status === 'disqualified' && <span class="chip chip--bad">Disqualified</span>}
</li>
```

In `web/src/routes/Event.test.tsx`, update the `view()` factory with `lockedAt: null, checkinOpensAt: null, checkinClosesAt: null` and the new entry shape, mock `mine` in `mockEvents` (resolve `{ entries: [], register: [], canRegister: false }`), and add one case: an entry with `waitlist: 2` renders `Waitlist 2`, and one with `status: 'checked_in'` renders `Checked in`.

In `web/src/styles/app.css`, add rules next to the existing `.eventlist` ones for `.entrypanel__team` (stacked, gap 8px, a top border between teams), `.rosterpick__list` (no bullets, rows as `grid-template-columns: 1fr auto` that wrap the `__why` lines onto their own full-width row), `.rosterpick__row--warn` (left border in the warning token), `.rosterpick__why` (small, the error token color, `grid-column: 1 / -1`), `.evententry` (flex row, gap 8px, align center), `.evententry__logo` (28px square, radius 6px, `object-fit: cover`; the `--none` variant a muted tile with a centered letter), `.chip--ok` and `.chip--bad` (the existing success and danger tokens). Use existing color tokens; check them at 390 px wide.

- [ ] **Step 5: Run the tests and typecheck**

Run: `cd web && npx vitest run src/routes/event src/routes/Event.test.tsx && cd .. && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/api.ts web/src/routes/Event.tsx web/src/routes/Event.test.tsx web/src/routes/event web/src/styles/app.css
git commit -m "Event page: register a team with a role per member and every problem named, your entry with check-in, roster edit, withdraw and leave, entry logos with waitlist, check-in and seed marks"
```

---

### Task 9: The desk's Entries section

**Files:**
- Create: `web/src/routes/admin/events/EntriesPanel.tsx`, `web/src/routes/admin/events/EntriesPanel.test.tsx`
- Modify: `web/src/api.ts` (desk types and calls), `web/src/routes/admin/events/EventEditor.tsx`

**Interfaces:**
- Consumes: Task 7 routes.
- Produces: `AdminEntryView` (mirror of the server's), `adminApi.eventEntries(id, signal)`, `openEventCheckin(id)`, `lockEventEntries(id)`, `reorderEventSeeds(id, order)`, `setEventEntryRoster(id, entryId, roster)`, `disqualifyEventEntry(id, entryId, reason)`, `restoreEventEntry(id, entryId)`.

- [ ] **Step 1: API**

In `web/src/api.ts`, next to the other desk types:

```ts
export interface AdminEntryView {
  id: number; teamSlug: string | null; name: string; tag: string; status: string; dropReason: string | null; seed: number | null;
  waitlist: number | null; sr: number; checkedInAt: string | null; createdAt: string; registeredByName: string; roster: RosterPlaceView[];
}
```

and in `adminApi`:

```ts
  eventEntries: (id: number, signal?: AbortSignal) => get<{ lockedAt: string | null; entries: AdminEntryView[] }>(`/api/admin/events/${id}/entries`, signal),
  openEventCheckin: (id: number) => post(`/api/admin/events/${id}/open-checkin`),
  lockEventEntries: (id: number) => post(`/api/admin/events/${id}/lock-entries`),
  reorderEventSeeds: (id: number, order: number[]) => post(`/api/admin/events/${id}/seeds`, { order }),
  setEventEntryRoster: (id: number, entryId: number, roster: EntryRoster) => post(`/api/admin/events/${id}/entries/${entryId}/roster`, { roster }),
  disqualifyEventEntry: (id: number, entryId: number, reason: string) => post(`/api/admin/events/${id}/entries/${entryId}/disqualify`, { reason }),
  restoreEventEntry: (id: number, entryId: number) => post(`/api/admin/events/${id}/entries/${entryId}/restore`),
```

- [ ] **Step 2: Write the failing test**

`web/src/routes/admin/events/EntriesPanel.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { AdminEntryView } from '../../../api';

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { eventEntries: vi.fn(), openEventCheckin: vi.fn(), lockEventEntries: vi.fn(), reorderEventSeeds: vi.fn(), disqualifyEventEntry: vi.fn(), restoreEventEntry: vi.fn(), setEventEntryRoster: vi.fn() },
}));
vi.mock('../../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
vi.mock('../../../components/Confirm', () => ({ confirm: vi.fn(async () => true) }));
const { EntriesPanel } = await import('./EntriesPanel');

const entry = (over: Partial<AdminEntryView> = {}): AdminEntryView => ({
  id: 1, teamSlug: 'rats', name: 'Rats', tag: 'RAT', status: 'registered', dropReason: null, seed: null, waitlist: null, sr: 1500,
  checkedInAt: null, createdAt: '2026-10-05T00:00:00.000Z', registeredByName: 'cap',
  roster: [{ steamid: '1', name: 'p1', avatar: null, role: 'starter', problems: ['Discord is not linked'] }], ...over,
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('EntriesPanel', () => {
  it('shows each entry with SR, problems and waitlist, and no controls for a mod', async () => {
    mockAdmin.eventEntries.mockResolvedValue({ lockedAt: null, entries: [entry(), entry({ id: 2, name: 'Bats', waitlist: 1 })] });
    render(<EntriesPanel eventId={9} status="registration" canEdit={false} />);
    expect(await screen.findByText('Rats')).toBeTruthy();
    expect(screen.getAllByText(/SR 1500/)).toHaveLength(2);
    expect(screen.getByText(/Discord is not linked/)).toBeTruthy();
    expect(screen.getByText(/Waitlist 1/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('lets an admin close the entry list early and move a seed up', async () => {
    mockAdmin.eventEntries.mockResolvedValue({ lockedAt: null, entries: [entry()] });
    mockAdmin.lockEventEntries.mockResolvedValue({});
    render(<EntriesPanel eventId={9} status="checkin" canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Close the entry list now' }));
    await waitFor(() => expect(mockAdmin.lockEventEntries).toHaveBeenCalledWith(9));

    cleanup();
    mockAdmin.eventEntries.mockResolvedValue({ lockedAt: 'x', entries: [entry({ seed: 1 }), entry({ id: 2, name: 'Bats', seed: 2 })] });
    mockAdmin.reorderEventSeeds.mockResolvedValue({});
    render(<EntriesPanel eventId={9} status="checkin" canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Move Bats up' }));
    await waitFor(() => expect(mockAdmin.reorderEventSeeds).toHaveBeenCalledWith(9, [2, 1]));
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `cd web && npx vitest run src/routes/admin/events/EntriesPanel.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement**

`web/src/routes/admin/events/EntriesPanel.tsx`:

```tsx
import { useState } from 'preact/hooks';
import { adminApi, type AdminEntryView } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty, Panel } from '../../../components/bits';
import { useAction } from '../useAction';

const DROP: Record<string, string> = {
  withdrawn: 'withdrawn', no_checkin: 'did not check in', over_cap: 'over the cap', incomplete: 'short of 4 starters', team_disbanded: 'team disbanded',
};
const ROLE: Record<string, string> = { starter: 'Starter', sub: 'Sub', coach: 'Coach' };

function statusText(e: AdminEntryView): string {
  if (e.status === 'dropped') return `Dropped (${DROP[e.dropReason ?? ''] ?? 'dropped'})`;
  if (e.status === 'disqualified') return 'Disqualified';
  if (e.status === 'checked_in') return 'Checked in';
  return e.waitlist !== null ? `Waitlist ${e.waitlist}` : 'Registered';
}

/** The Entries section of an event on the desk (plan T1b Ruling 10). A mod
 *  (canEdit false) reads the same list with no control. */
export function EntriesPanel({ eventId, status, canEdit }: { eventId: number; status: string; canEdit: boolean }) {
  const { data, error: loadError, reload } = useFetch((s) => adminApi.eventEntries(eventId, s), [eventId]);
  const { busy, error, run } = useAction(reload);
  const [reason, setReason] = useState('');
  if (loadError) return <Panel><h3>Entries</h3><p class="error">Could not load the entries.</p></Panel>;
  if (!data) return <Panel><h3>Entries</h3></Panel>;
  const locked = data.lockedAt !== null;
  const seeded = data.entries.filter((e) => e.seed !== null && (e.status === 'registered' || e.status === 'checked_in'))
    .sort((a, b) => (a.seed ?? 0) - (b.seed ?? 0));
  const move = (id: number, by: -1 | 1) => {
    const order = seeded.map((e) => e.id);
    const i = order.indexOf(id);
    const j = i + by;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j]!, order[i]!];
    void run(() => adminApi.reorderEventSeeds(eventId, order));
  };
  const active = (e: AdminEntryView) => e.status !== 'dropped' && e.status !== 'disqualified';
  return (
    <Panel>
      <h3>Entries</h3>
      {canEdit && !locked && (
        <div class="inlinerow">
          {status === 'registration' && (
            <button class="btn btn--ghost" disabled={busy} onClick={() => run(() => adminApi.openEventCheckin(eventId), 'Open check-in now?')}>Open check-in now</button>
          )}
          {(status === 'registration' || status === 'checkin') && (
            <button class="btn btn--ghost" disabled={busy} onClick={() => run(() => adminApi.lockEventEntries(eventId), {
              title: 'Close the entry list now?', body: 'Entries that are not ready are dropped, the waitlist is cut at the cap, and seeds are set by SR.',
            })}>Close the entry list now</button>
          )}
        </div>
      )}
      {locked && <p class="muted">The entry list is final. Seeds can be reordered until the event goes live.</p>}
      {error && <p class="error" role="alert">{error}</p>}
      {data.entries.length === 0 ? <Empty>No entries yet.</Empty> : (
        <ul class="admin-list">
          {data.entries.map((e) => (
            <li key={e.id} class={active(e) ? '' : 'muted'}>
              <strong>{e.seed !== null && active(e) ? `#${e.seed} ` : ''}{e.name}</strong> <span class="muted">[{e.tag}]</span>
              {' '}· {statusText(e)} · SR {e.sr} · by {e.registeredByName}
              <ul class="entrypanel__roster">
                {e.roster.map((p) => (
                  <li key={p.steamid}><span class="chip">{ROLE[p.role]}</span> {p.name}{p.problems.map((x) => <span key={x} class="rosterpick__why">{x}</span>)}</li>
                ))}
              </ul>
              {canEdit && (
                <div class="inlinerow">
                  {locked && active(e) && e.seed !== null && (
                    <>
                      <button class="btn btn--ghost" aria-label={`Move ${e.name} up`} disabled={busy} onClick={() => move(e.id, -1)}>Up</button>
                      <button class="btn btn--ghost" aria-label={`Move ${e.name} down`} disabled={busy} onClick={() => move(e.id, 1)}>Down</button>
                    </>
                  )}
                  {active(e) && (
                    <>
                      <input type="text" placeholder="Reason" value={reason} onInput={(ev) => setReason((ev.target as HTMLInputElement).value)} />
                      <button class="btn btn--ghost" disabled={busy} onClick={() => run(() => adminApi.disqualifyEventEntry(eventId, e.id, reason), `Disqualify ${e.name}?`)}>Disqualify</button>
                    </>
                  )}
                  {!active(e) && !locked && (
                    <button class="btn btn--ghost" disabled={busy} onClick={() => run(() => adminApi.restoreEventEntry(eventId, e.id), `Restore ${e.name}?`)}>Restore</button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
```

A staff roster editor reuses `RosterPicker`, but staff can add anyone, so it needs a player search; that is more UI than the rare case is worth right now. Staff roster edits are available on the API (`setEventEntryRoster`) and the desk can grow the editor later. Say so in the plan's hand-off notes; do not build it here.

In `EventEditor.tsx`: add the new `event_log` actions to `ACTION_TEXT`:

```ts
  checkin_opened: 'Check-in opened', entry_registered: 'Team registered', roster_changed: 'Roster changed', roster_left: 'Player left a roster',
  entry_withdrawn: 'Team withdrew', entry_checked_in: 'Team checked in', entries_locked: 'Entry list closed', entry_dropped: 'Entry dropped',
  entry_disqualified: 'Entry disqualified', entry_restored: 'Entry restored', seeds_reordered: 'Seeds reordered',
```

and render `<EntriesPanel eventId={ev.id} status={ev.status} canEdit={canEdit} />` after the stages section whenever `ev.status` is not `draft` or `announced`. A history line with actor null reads "by the clock" (find where the history renders `actorName` and use `actorName ?? 'the clock'`).

- [ ] **Step 5: Run the tests and typecheck**

Run: `cd web && npx vitest run src/routes/admin/events && cd .. && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/api.ts web/src/routes/admin/events/EntriesPanel.tsx web/src/routes/admin/events/EntriesPanel.test.tsx web/src/routes/admin/events/EventEditor.tsx
git commit -m "Events desk: an Entries section with rosters, problems, SR and waitlist; admins open check-in or close the list early, reorder seeds, disqualify and restore"
```

---

### Task 10: Whole-branch check

**Files:** none new.

- [ ] **Step 1: Full suite, typecheck and build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass. The known flaky `tests/scrimPoster.test.ts` scrim night reminder case may fail depending on the wall clock (it fails on master too); note it if it does and move on.

- [ ] **Step 2: Look at it**

Start a scratch dev server against a copy of the production-shaped DB the way earlier competitive plans did (API on 8091, vite on 5181, `/api/dev/login`; see `pug-site-redesign` notes and `npm run shoot`). Set `competitive_enabled` to `everyone` on the copy, create an event in registration with a near start, two teams, and check at 390 px and desktop: the Register panel (a member with a problem shows its line), a refusal naming a player, your entry after registering, the waitlist mark, check-in after `POST /api/admin/events/:id/open-checkin`, the entry list after closing, and the desk Entries section as an admin and as a mod. Fix anything that overflows or reads wrong, commit as "Event entries: layout fixes from the 390 px pass".

- [ ] **Step 3: Hand-off notes**

Write a short ledger (scratchpad) with: commits, test count, the rulings above, and the deferred items: staff roster editor UI with a player search, admin feed sentences for `event_*` admin actions, pickup rosters, `after_round` lock, going live (rollout plan 2).
