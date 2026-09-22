# Report Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a standing message with a **Report a player** button in the renamed tickets channel, opening a Discord form that files a report through the same `fileReport` the site and `/report` already use.

**Architecture:** One new module, `src/discord/reportButton.ts`, owning the standing message and its upkeep, the modal definition, target resolution, and the two interaction handlers. It plugs into the bot through the existing `BotDeps.extraButtons` / `extraModals` prefix seams and the `opensModal` predicate, so `src/discord/index.ts` needs no new concepts and `src/discord/djsTransport.ts` needs no change at all. Two new tables carry the only state: `report_message` (a singleton row for the standing message) and `pending_reports` (a draft held while a reporter picks between same-named players).

**Tech Stack:** TypeScript, better-sqlite3, vitest, discord.js 14.27.0 (untouched), Preact for the one web copy change.

**Spec:** `docs/superpowers/specs/2026-09-22-report-button-design.md`

## Global Constraints

- **No change to `src/discord/djsTransport.ts`.** Every primitive needed already exists: `send`, `edit`, `remove`, buttons in a message, modals carrying selects, and `opensModal`. If a task appears to need a new transport primitive, stop and raise it rather than adding one.
- **Players only.** A report is always about a row in `players`. Nothing here may loosen `tickets.target_id`.
- **Everything goes through `fileReport`.** Never insert into `tickets` or `ticket_reports` directly. Anonymity, one open case per accused, auto-restriction, the daily limit, the duplicate rules and the banned-reporter guard are all inherited from it and must not be re-implemented.
- **Every reply is ephemeral.** Nothing this feature does is ever visible in the channel except the standing message itself.
- **Custom id prefix is `rp:`.** `r:` (admin feed) and `t:` (tickets) are taken. `Object.keys(...).find((p) => customId.startsWith(p))` does the routing, and `rp:` cannot be confused with `r:` because the second character differs.
- **Copy rule:** the details wording is "what happened, in your own words". It must never lead with the map. A Discord slash command option description is capped at 100 characters.
- **No em dashes** in any copy, comment or commit message.
- Discord limits that bind here: 25 options in a select, 5 fields in a modal, 100 characters in a custom id, 100 characters in a select option label.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/tickets/schema.ts` (modify) | Add `pending_reports` and `report_message` tables beside the existing ticket tables. |
| `src/settingsSchema.ts` (modify) | Add `discord_report_channel_id` to the Discord group. |
| `src/db.ts` (modify) | Add its default (empty string) to `DEFAULT_SETTINGS`. |
| `src/discord/reportButton.ts` (create) | Everything else: recent co-players, name resolution, the modal, the standing message and its tick, both handlers, `opensReportModal`. |
| `src/discord/commands.ts` (modify) | Export `REPORT_LABELS`; reword the `details` option description. |
| `web/src/components/ReportPlayer.tsx` (modify) | Reword the optional details placeholder. |
| `src/server.ts` (modify) | Construct and start the module, register `rp:` in `extraButtons` and `extraModals`, compose `opensModal`. |
| `tests/reportButton.test.ts` (create) | Resolution, the modal, the standing message, both handlers, reaping. |

The module is one file because its parts are meaningless apart: the modal's shape determines what the submit handler reads, and the pending table exists only to bridge those two. It should stay under roughly 400 lines; if it grows past that, split the standing message upkeep into `src/discord/reportMessage.ts` and leave the handlers behind.

---

## Task 1: Tables and the setting

**Files:**
- Modify: `src/tickets/schema.ts` (inside `ensureTicketSchema`, after the existing `CREATE TABLE` statements)
- Modify: `src/settingsSchema.ts` (Discord group, after `discord_tickets_channel_id`)
- Modify: `src/db.ts` (`DEFAULT_SETTINGS`)
- Test: `tests/reportButton.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: tables `pending_reports` and `report_message`; setting key `discord_report_channel_id` defaulting to `''`.

- [ ] **Step 1: Write the failing test**

Create `tests/reportButton.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { getSetting } from '../src/settings.js';

let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
});

describe('report button schema', () => {
  it('creates the pending_reports and report_message tables', () => {
    const names = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('pending_reports', 'report_message')",
    ).all() as { name: string }[]).map((r) => r.name).sort();
    expect(names).toEqual(['pending_reports', 'report_message']);
  });

  it('holds report_message to a single row', () => {
    const ins = db.prepare(
      "INSERT INTO report_message (id, channel_id, message_id, hash, updated_at) VALUES (?, 'c1', 'm1', 'h', '2026-09-22T00:00:00.000Z')",
    );
    ins.run(1);
    expect(() => ins.run(2)).toThrow();
  });

  it('defaults the report channel setting to empty', () => {
    expect(getSetting(db, 'discord_report_channel_id')).toBe('');
  });

  it('keeps a pending report only for a real player', () => {
    expect(() => db.prepare(
      "INSERT INTO pending_reports (reporter_id, category, text, typed_name, candidates, created_at) VALUES ('76561199000000099', 'griefing', '', 'bob', '[]', '2026-09-22T00:00:00.000Z')",
    ).run()).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/reportButton.test.ts`
Expected: FAIL, "no such table: pending_reports" and the setting returning `undefined`.

- [ ] **Step 3: Add the tables**

In `src/tickets/schema.ts`, inside `ensureTicketSchema`, after the last existing `CREATE TABLE` statement:

```typescript
  db.exec(`
    -- A report whose typed name matched several players, held while the
    -- reporter picks which one they meant. In a table rather than in memory
    -- so that a deploy in the middle of picking cannot lose what someone
    -- wrote: a report can be about something distressing, and asking them to
    -- type it again is the worst failure this feature could have.
    CREATE TABLE IF NOT EXISTS pending_reports (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_id TEXT NOT NULL REFERENCES players(steamid),
      category    TEXT NOT NULL,
      text        TEXT NOT NULL DEFAULT '',
      typed_name  TEXT NOT NULL,
      candidates  TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pending_reports_created ON pending_reports (created_at);

    -- The standing message carrying the Report button. One row, ever.
    -- channel_id is kept beside message_id so that pointing the setting at a
    -- different channel is handled rather than orphaning a button.
    CREATE TABLE IF NOT EXISTS report_message (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      hash       TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
```

- [ ] **Step 4: Add the setting**

In `src/settingsSchema.ts`, immediately after the `discord_tickets_channel_id` entry:

```typescript
  { key: 'discord_report_channel_id', group: 'Discord', label: 'Report button channel id', help: 'A channel everyone can see, holding one standing message with a Report a player button. The bot keeps that message alive and re-posts it if it is deleted. Empty: no button, and reporting is done on the site or with /report.', type: { kind: 'string', maxLength: 32, allowEmpty: true } },
```

In `src/db.ts`, beside the other `discord_` keys in `DEFAULT_SETTINGS`:

```typescript
  discord_report_channel_id: '',
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/reportButton.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Guard the settings parity that nothing else guards**

`DEFAULT_SETTINGS` in `src/db.ts` and `SETTINGS_SCHEMA` in `src/settingsSchema.ts` have to agree: a key with no default reads back `undefined`, and a default with no schema entry cannot be edited by an admin. Nothing in the suite currently checks that, which is how a key added to one file and not the other would ship unnoticed. Add the guard here, since this task is what adds a key to both.

Append to `tests/reportButton.test.ts`:

```typescript
import { DEFAULT_SETTINGS } from '../src/db.js';
import { SETTINGS_SCHEMA } from '../src/settingsSchema.js';

describe('settings parity', () => {
  it('gives every default a schema entry and every schema entry a default', () => {
    const defaults = Object.keys(DEFAULT_SETTINGS).sort();
    const schema = SETTINGS_SCHEMA.map((s) => s.key).sort();
    expect(defaults).toEqual(schema);
  });
});
```

If `DEFAULT_SETTINGS` or `SETTINGS_SCHEMA` is not exported under that name, export it rather than reaching into the module's internals, and say so in the report. If this test fails on keys unrelated to this task, that is a pre-existing gap: report it and leave it, rather than editing unrelated settings to make the test green.

Run: `npx vitest run tests/reportButton.test.ts tests/adminSettings.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tickets/schema.ts src/settingsSchema.ts src/db.ts tests/reportButton.test.ts
git commit -m "Add the report button's tables and its channel setting"
```

---

## Task 2: The details wording

Independent of everything else, and worth landing on its own so the fix reaches members even if later tasks stall.

**Files:**
- Modify: `src/discord/commands.ts` (the `details` option, and the `REPORT_LABELS` declaration)
- Modify: `web/src/components/ReportPlayer.tsx:118`
- Test: `tests/reportButton.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export const REPORT_LABELS: Record<ReportCategory, string>` from `src/discord/commands.ts`, used by Task 4's modal.

- [ ] **Step 1: Write the failing test**

Append to `tests/reportButton.test.ts`:

```typescript
import { COMMAND_DEFS, REPORT_LABELS } from '../src/discord/commands.js';

describe('details wording', () => {
  const report = () => COMMAND_DEFS.find((c) => c.name === 'report')!;
  const details = () => report().options!.find((o) => o.name === 'details')!;

  it('does not lead with the map', () => {
    expect(details().description.toLowerCase()).not.toContain('map');
  });

  it('asks for what happened, in the reporter\'s own words', () => {
    expect(details().description).toBe('What happened, in your own words');
  });

  it('stays inside Discord\'s 100 character limit', () => {
    expect(details().description.length).toBeLessThanOrEqual(100);
  });

  it('exports the category labels so the form can share them', () => {
    expect(REPORT_LABELS.unsafe).toBe('Safety concern (handled privately)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/reportButton.test.ts`
Expected: FAIL, the description is still `When, which map, what they did`, and `REPORT_LABELS` is not exported.

- [ ] **Step 3: Reword and export**

In `src/discord/commands.ts`, change the declaration on line 24 from `const REPORT_LABELS` to:

```typescript
export const REPORT_LABELS: Record<ReportCategory, string> = {
```

and change the `details` option to:

```typescript
      { name: 'details', description: 'What happened, in your own words', type: 'string' },
```

- [ ] **Step 4: Reword the web placeholder**

In `web/src/components/ReportPlayer.tsx`, line 118, change the optional branch of the placeholder. The required branch used for `unsafe` stays exactly as it is:

```tsx
            placeholder={needsText ? 'What happened (required)' : 'Details (optional): what happened, in your own words'}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/reportButton.test.ts web/src/components/ReportPlayer.test.tsx`
Expected: PASS. If a `ReportPlayer` test asserts the old placeholder text, update that assertion to the new string; it is testing the copy, and the copy changed on purpose.

- [ ] **Step 6: Commit**

```bash
git add src/discord/commands.ts web/src/components/ReportPlayer.tsx tests/reportButton.test.ts
git commit -m "Ask what happened rather than which map, and share the category labels"
```

---

## Task 3: Recent co-players and name resolution

Two pure database reads with no Discord in them, which is why they are worth their own task and their own tests.

**Files:**
- Create: `src/discord/reportButton.ts`
- Test: `tests/reportButton.test.ts`

**Interfaces:**
- Consumes: `DB` from `src/db.js`; `PlayerRow` from `src/players.js`.
- Produces:
  - `export interface Candidate { steamid: string; name: string }`
  - `export function recentCoPlayers(db: DB, steamid: string, limit?: number): Candidate[]` (default limit 24)
  - `export function resolveByName(db: DB, typed: string, limit?: number): Candidate[]` (default limit 6; returns up to `limit` so the caller can tell "more than five" from "exactly five")

- [ ] **Step 1: Write the failing test**

Append to `tests/reportButton.test.ts`:

```typescript
import { upsertPlayer, activatePlayer, currentSeasonId } from '../src/players.js';
import { recentCoPlayers, resolveByName } from '../src/discord/reportButton.js';

const IDS = Array.from({ length: 6 }, (_, i) => `7656119900000010${i}`);
const [ME, ALICE, BOB1, BOB2, CARL, DEE] = IDS;

const seedPlayers = (d: DB) => {
  const names: Record<string, string> = {
    [ME]: 'me', [ALICE]: 'Alice', [BOB1]: 'Bob', [BOB2]: 'bob',
    [CARL]: 'Carl_99', [DEE]: 'Dee%Dee',
  };
  for (const id of IDS) {
    upsertPlayer(d, { steamid: id, name: names[id], avatar: null }, []);
    activatePlayer(d, id);
  }
};

// `matches` requires season_id and campaign, both NOT NULL. A fresh database
// seeds "Season 1", so currentSeasonId always has something to return.
const seedMatch = (d: DB, matchId: number, players: string[]) => {
  d.prepare(
    `INSERT INTO matches (id, season_id, state, campaign, created_at)
     VALUES (?, ?, 'completed', 'l4d_vs_smalltown', '2026-09-22T00:00:00.000Z')`,
  ).run(matchId, currentSeasonId(d));
  const ins = d.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, 'a')");
  for (const p of players) ins.run(matchId, p);
};

describe('recentCoPlayers', () => {
  beforeEach(() => { seedPlayers(db); });

  it('lists people from my matches, most recent first, never me', () => {
    seedMatch(db, 1, [ME, ALICE]);
    seedMatch(db, 2, [ME, CARL]);
    expect(recentCoPlayers(db, ME).map((c) => c.name)).toEqual(['Carl_99', 'Alice']);
  });

  it('lists someone once however many matches we shared', () => {
    seedMatch(db, 1, [ME, ALICE]);
    seedMatch(db, 2, [ME, ALICE]);
    expect(recentCoPlayers(db, ME)).toHaveLength(1);
  });

  it('is empty for someone who has never played', () => {
    expect(recentCoPlayers(db, ME)).toEqual([]);
  });

  it('honours the limit', () => {
    seedMatch(db, 1, [ME, ALICE, BOB1, CARL]);
    expect(recentCoPlayers(db, ME, 2)).toHaveLength(2);
  });
});

describe('resolveByName', () => {
  beforeEach(() => { seedPlayers(db); });

  it('finds one exact name regardless of case', () => {
    expect(resolveByName(db, 'ALICE').map((c) => c.steamid)).toEqual([ALICE]);
  });

  it('prefers exact matches over substrings', () => {
    // 'Bob' and 'bob' both match exactly; 'Bobby' would only match as a
    // substring and must not dilute an exact hit.
    upsertPlayer(db, { steamid: '76561199000000199', name: 'Bobby', avatar: null }, []);
    expect(resolveByName(db, 'bob').map((c) => c.steamid).sort()).toEqual([BOB1, BOB2].sort());
  });

  it('falls back to a substring when nothing matches exactly', () => {
    expect(resolveByName(db, 'arl').map((c) => c.steamid)).toEqual([CARL]);
  });

  it('returns nothing for a name nobody has', () => {
    expect(resolveByName(db, 'nobody')).toEqual([]);
  });

  it('treats LIKE wildcards as ordinary characters', () => {
    // '%' must not match everything, and '_' must not match any character.
    expect(resolveByName(db, '%').map((c) => c.steamid)).toEqual([DEE]);
    expect(resolveByName(db, 'Carl_').map((c) => c.steamid)).toEqual([CARL]);
  });

  it('ignores surrounding whitespace', () => {
    expect(resolveByName(db, '  Alice  ').map((c) => c.steamid)).toEqual([ALICE]);
  });

  it('returns at most the limit', () => {
    expect(resolveByName(db, 'e', 2).length).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/reportButton.test.ts`
Expected: FAIL, cannot resolve `../src/discord/reportButton.js`.

- [ ] **Step 3: Write the module**

Create `src/discord/reportButton.ts`:

```typescript
import type { DB } from '../db.js';

/** A player the reporter could mean. */
export interface Candidate { steamid: string; name: string }

/**
 * Everyone the reporter has shared a match with, most recent match first,
 * one row each. Feeds the form's dropdown, which Discord caps at 25 options:
 * the default of 24 leaves room for the sentinel option.
 */
export function recentCoPlayers(db: DB, steamid: string, limit = 24): Candidate[] {
  return db.prepare(
    `SELECT p.steamid AS steamid, p.name AS name, MAX(mine.match_id) AS last_match
       FROM match_players mine
       JOIN match_players theirs
         ON theirs.match_id = mine.match_id AND theirs.player_id != mine.player_id
       JOIN players p ON p.steamid = theirs.player_id
      WHERE mine.player_id = ?
      GROUP BY p.steamid
      ORDER BY last_match DESC
      LIMIT ?`,
  ).all(steamid, limit) as Candidate[];
}

/**
 * Players whose name the reporter may have typed. Exact matches win outright:
 * someone called "Bob" must not be buried by everyone called "Bobby". Only
 * when nothing matches exactly do we widen to a substring.
 *
 * The typed text goes into LIKE, so '%' and '_' are escaped. Without this a
 * reporter typing '%' matches the whole player list, which reads as the
 * feature being broken rather than as a wildcard.
 */
export function resolveByName(db: DB, typed: string, limit = 6): Candidate[] {
  const name = typed.trim();
  if (!name) return [];
  const exact = db.prepare(
    'SELECT steamid, name FROM players WHERE lower(name) = lower(?) ORDER BY name LIMIT ?',
  ).all(name, limit) as Candidate[];
  if (exact.length > 0) return exact;
  const escaped = name.replace(/[\\%_]/g, (c) => `\\${c}`);
  return db.prepare(
    `SELECT steamid, name FROM players
      WHERE lower(name) LIKE '%' || lower(?) || '%' ESCAPE '\\'
      ORDER BY name LIMIT ?`,
  ).all(escaped, limit) as Candidate[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/reportButton.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/discord/reportButton.ts tests/reportButton.test.ts
git commit -m "Find a reporter's recent opponents and resolve a typed name"
```

---

## Task 4: The form

**Files:**
- Modify: `src/discord/reportButton.ts`
- Test: `tests/reportButton.test.ts`

**Interfaces:**
- Consumes: `recentCoPlayers`, `Candidate` (Task 3); `REPORT_LABELS` (Task 2); `REPORT_CATEGORIES` from `src/tickets/filing.js`; `ModalDef` from `src/discord/transport.js`.
- Produces:
  - `export const REPORT_PREFIX = 'rp:'`
  - `export const OTHER = '__other'`
  - `export function reportModal(db: DB, reporter: string): ModalDef`
  - `export function opensReportModal(customId: string): boolean`

- [ ] **Step 1: Write the failing test**

Append to `tests/reportButton.test.ts`:

```typescript
import { reportModal, opensReportModal, OTHER } from '../src/discord/reportButton.js';

describe('reportModal', () => {
  beforeEach(() => { seedPlayers(db); });

  it('has four fields in a fixed order', () => {
    const m = reportModal(db, ME);
    expect(m.fields.map((f) => f.id)).toEqual(['who', 'name', 'reason', 'details']);
  });

  it('leads the who dropdown with the sentinel, then recent opponents', () => {
    seedMatch(db, 1, [ME, ALICE]);
    const who = reportModal(db, ME).fields[0];
    if (who.kind !== 'select') throw new Error('who must be a select');
    expect(who.options[0].value).toBe(OTHER);
    expect(who.options.slice(1).map((o) => o.value)).toEqual([ALICE]);
  });

  it('still offers the sentinel when there are no recent opponents', () => {
    const who = reportModal(db, ME).fields[0];
    if (who.kind !== 'select') throw new Error('who must be a select');
    // A select with zero options is not a valid modal, so the sentinel is
    // what keeps the form openable for someone who has never played.
    expect(who.options).toHaveLength(1);
  });

  it('never offers the reporter themselves', () => {
    seedMatch(db, 1, [ME, ALICE]);
    const who = reportModal(db, ME).fields[0];
    if (who.kind !== 'select') throw new Error('who must be a select');
    expect(who.options.map((o) => o.value)).not.toContain(ME);
  });

  it('offers every report category, with the shared labels', () => {
    const reason = reportModal(db, ME).fields[2];
    if (reason.kind !== 'select') throw new Error('reason must be a select');
    expect(reason.options.map((o) => o.value)).toEqual(['griefing', 'cheating', 'toxicity', 'afk', 'unsafe', 'other']);
    expect(reason.options.find((o) => o.value === 'unsafe')!.label).toBe('Safety concern (handled privately)');
  });

  it('keeps the name and details boxes optional and caps details at 1000', () => {
    const [, name, , details] = reportModal(db, ME).fields;
    if (name.kind !== 'text' || details.kind !== 'text') throw new Error('expected text fields');
    expect(name.required).toBe(false);
    expect(details.required).toBe(false);
    expect(details.maxLength).toBe(1000);
    expect(details.style).toBe('paragraph');
  });

  it('keeps every select option label inside Discord\'s 100 characters', () => {
    upsertPlayer(db, { steamid: '76561199000000198', name: 'x'.repeat(200), avatar: null }, []);
    activatePlayer(db, '76561199000000198');
    seedMatch(db, 1, [ME, '76561199000000198']);
    const who = reportModal(db, ME).fields[0];
    if (who.kind !== 'select') throw new Error('who must be a select');
    for (const o of who.options) expect(o.label.length).toBeLessThanOrEqual(100);
  });

  it('knows which button opens a form', () => {
    expect(opensReportModal('rp:open')).toBe(true);
    expect(opensReportModal('rp:pick:1:76561199000000101')).toBe(false);
    expect(opensReportModal('t:1:claim')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/reportButton.test.ts`
Expected: FAIL, `reportModal` is not exported.

- [ ] **Step 3: Implement**

Add to `src/discord/reportButton.ts`:

```typescript
import { REPORT_CATEGORIES } from '../tickets/filing.js';
import { REPORT_LABELS } from './commands.js';
import type { ModalDef } from './transport.js';

/** Custom id prefix. 'r:' is the admin feed and 't:' is tickets. */
export const REPORT_PREFIX = 'rp:';
/** The dropdown entry meaning "I will type the name instead". A modal select
 *  has no optional flag, so this sentinel is what lets the dropdown be
 *  skipped without the form refusing to submit. */
export const OTHER = '__other';
/** Discord's ceiling on a select option label. */
const LABEL_MAX = 100;

const clip = (s: string) => (s.length <= LABEL_MAX ? s : `${s.slice(0, LABEL_MAX - 1)}…`);

/** The form, built for this reporter: the dropdown is their own recent
 *  opponents, so the common case is one pick rather than any typing. */
export function reportModal(db: DB, reporter: string): ModalDef {
  return {
    customId: `${REPORT_PREFIX}new`,
    title: 'Report a player',
    fields: [
      {
        kind: 'select',
        id: 'who',
        label: 'Who are you reporting?',
        options: [
          { label: 'Someone else (I will type the name below)', value: OTHER },
          ...recentCoPlayers(db, reporter).map((c) => ({ label: clip(c.name), value: c.steamid })),
        ],
      },
      { kind: 'text', id: 'name', label: 'Or type their name', style: 'short', required: false, maxLength: 100 },
      {
        kind: 'select',
        id: 'reason',
        label: 'What happened?',
        options: REPORT_CATEGORIES.map((c) => ({ label: REPORT_LABELS[c], value: c })),
      },
      { kind: 'text', id: 'details', label: 'Details, in your own words', style: 'paragraph', required: false, maxLength: 1000 },
    ],
  };
}

/** Only the standing message's button answers with a form. The candidate
 *  buttons reply with a message, and the transport has to know the difference
 *  before it runs the handler. */
export function opensReportModal(customId: string): boolean {
  return customId === `${REPORT_PREFIX}open`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/reportButton.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/discord/reportButton.ts tests/reportButton.test.ts
git commit -m "Build the report form from the reporter's own recent matches"
```

---

## Task 5: The standing message and its upkeep

**Files:**
- Modify: `src/discord/reportButton.ts`
- Test: `tests/reportButton.test.ts`

**Interfaces:**
- Consumes: `BotTransport`, `MessagePayload` from `src/discord/transport.js`; `getSetting` from `src/settings.js`.
- Produces:
  - `export interface ReportButtonDeps { db: DB; transport: BotTransport; intervalMs?: number; now?: () => Date }`
  - `export class ReportButton { constructor(deps: ReportButtonDeps); start(): void; stop(): void; tick(): Promise<void> }`

- [ ] **Step 1: Write the failing test**

Append to `tests/reportButton.test.ts`:

```typescript
import { setSetting } from '../src/settings.js';
import { FakeTransport } from './fakes/fakeTransport.js';
import { ReportButton } from '../src/discord/reportButton.js';

const liveIn = (d: DB, t: FakeTransport, channel: string) => {
  setSetting(d, 'discord_report_channel_id', channel);
  return new ReportButton({ db: d, transport: t as never, intervalMs: 0 });
};
const standing = (t: FakeTransport) => t.messages.filter((m) => !m.deleted);
const stored = (d: DB) => d.prepare('SELECT channel_id, message_id FROM report_message WHERE id = 1')
  .get() as { channel_id: string; message_id: string } | undefined;

describe('the standing message', () => {
  let t: FakeTransport;
  beforeEach(() => { seedPlayers(db); t = new FakeTransport(); });

  it('posts one message with one button', async () => {
    await liveIn(db, t, 'c1').tick();
    expect(standing(t)).toHaveLength(1);
    expect(standing(t)[0].payload.components[0][0]).toMatchObject({ kind: 'button', customId: 'rp:open' });
    expect(stored(db)).toMatchObject({ channel_id: 'c1' });
  });

  it('does not post a second one on the next tick', async () => {
    const rb = liveIn(db, t, 'c1');
    await rb.tick();
    await rb.tick();
    expect(standing(t)).toHaveLength(1);
  });

  it('posts nothing when the setting is blank', async () => {
    const rb = new ReportButton({ db, transport: t as never, intervalMs: 0 });
    await rb.tick();
    expect(standing(t)).toHaveLength(0);
    expect(stored(db)).toBeUndefined();
  });

  it('re-posts a message someone deleted', async () => {
    const rb = liveIn(db, t, 'c1');
    await rb.tick();
    const first = stored(db)!.message_id;
    t.messages.find((m) => m.id === first)!.deleted = true;
    await rb.tick();
    expect(stored(db)!.message_id).not.toBe(first);
    expect(standing(t)).toHaveLength(1);
  });

  it('moves to a new channel when the setting changes, and takes the old one down', async () => {
    const rb = liveIn(db, t, 'c1');
    await rb.tick();
    const old = stored(db)!.message_id;
    setSetting(db, 'discord_report_channel_id', 'c2');
    await rb.tick();
    expect(stored(db)).toMatchObject({ channel_id: 'c2' });
    expect(t.messages.find((m) => m.id === old)!.deleted).toBe(true);
    expect(standing(t)).toHaveLength(1);
  });

  it('still moves channel when the old message cannot be removed', async () => {
    const rb = liveIn(db, t, 'c1');
    await rb.tick();
    setSetting(db, 'discord_report_channel_id', 'c2');
    t.messages.length = 0; // the old message is gone from Discord's side
    await rb.tick();
    expect(stored(db)).toMatchObject({ channel_id: 'c2' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/reportButton.test.ts`
Expected: FAIL, `ReportButton` is not exported.

- [ ] **Step 3: Implement**

Add to `src/discord/reportButton.ts`:

```typescript
import { createHash } from 'node:crypto';
import { getSetting } from '../settings.js';
import type { BotTransport, MessagePayload } from './transport.js';

const TICK_MS = 5 * 60_000;
/** How long a half-written report waits for its reporter to pick a name. */
const PENDING_MS = 60 * 60_000;

const BODY = [
  '**Something happened in a game? Tell the moderators.**',
  '',
  'Press the button below and fill in the form. Your report is private:',
  'the person you report is never told who reported them.',
].join('\n');

function standingPayload(): MessagePayload {
  return {
    content: BODY,
    embeds: [],
    components: [[{ kind: 'button', customId: `${REPORT_PREFIX}open`, label: 'Report a player', style: 'primary' }]],
  };
}

const hashOf = (p: MessagePayload) => createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 16);

export interface ReportButtonDeps {
  db: DB;
  transport: BotTransport;
  /** 0 disables the timer, which is what every test uses. */
  intervalMs?: number;
  now?: () => Date;
}

/**
 * Keeps one message with one button alive in the configured channel, and
 * clears out drafts nobody came back for.
 */
export class ReportButton {
  private timer: NodeJS.Timeout | null = null;

  constructor(private deps: ReportButtonDeps) {}

  start(): void {
    void this.tick();
    const every = this.deps.intervalMs ?? TICK_MS;
    if (every > 0) {
      this.timer = setInterval(() => { void this.tick(); }, every);
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    try {
      await this.ensureMessage();
    } catch (err) {
      console.error('[discord] report button:', err);
    }
    this.reapPending();
  }

  /** Rows nobody came back to finish. Not an error: someone opened the form,
   *  saw the list of names and thought better of it. */
  private reapPending(): void {
    const cutoff = new Date((this.deps.now?.() ?? new Date()).getTime() - PENDING_MS).toISOString();
    this.deps.db.prepare('DELETE FROM pending_reports WHERE created_at < ?').run(cutoff);
  }

  private async ensureMessage(): Promise<void> {
    const { db, transport } = this.deps;
    const channelId = getSetting(db, 'discord_report_channel_id') ?? '';
    const row = db.prepare('SELECT channel_id, message_id, hash FROM report_message WHERE id = 1')
      .get() as { channel_id: string; message_id: string; hash: string } | undefined;
    if (!channelId) return;

    const payload = standingPayload();
    const hash = hashOf(payload);

    // A changed setting moves the button. Take the old one down if we still
    // can, but never let a failure there stop the move: a stray button in an
    // abandoned channel still opens the form and still files a report, so it
    // is untidy rather than harmful.
    if (row && row.channel_id !== channelId) {
      await transport.remove(row.channel_id, row.message_id).catch(() => {});
    } else if (row && row.hash === hash) {
      // Nothing to say, but prove the message is still there. An edit that
      // returns false means Discord has lost it, and a failed edit reported
      // as success is what froze a match card in place before (32118ab).
      if (await transport.edit(row.channel_id, row.message_id, payload)) return;
    } else if (row) {
      if (await transport.edit(row.channel_id, row.message_id, payload)) {
        this.remember(channelId, row.message_id, hash);
        return;
      }
    }

    const messageId = await transport.send(channelId, payload);
    this.remember(channelId, messageId, hash);
  }

  private remember(channelId: string, messageId: string, hash: string): void {
    this.deps.db.prepare(
      `INSERT INTO report_message (id, channel_id, message_id, hash, updated_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET channel_id = excluded.channel_id,
         message_id = excluded.message_id, hash = excluded.hash, updated_at = excluded.updated_at`,
    ).run(channelId, messageId, hash, (this.deps.now?.() ?? new Date()).toISOString());
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/reportButton.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the reaping test**

Append:

```typescript
describe('reaping drafts', () => {
  it('deletes a draft older than an hour and keeps a fresh one', async () => {
    seedPlayers(db);
    const t = new FakeTransport();
    const ins = db.prepare(
      'INSERT INTO pending_reports (reporter_id, category, text, typed_name, candidates, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    ins.run(ME, 'griefing', '', 'bob', '[]', '2026-09-22T09:00:00.000Z');
    ins.run(ME, 'griefing', '', 'bob', '[]', '2026-09-22T11:59:00.000Z');
    const rb = new ReportButton({
      db, transport: t as never, intervalMs: 0, now: () => new Date('2026-09-22T12:00:00.000Z'),
    });
    await rb.tick();
    expect((db.prepare('SELECT COUNT(*) AS n FROM pending_reports').get() as { n: number }).n).toBe(1);
  });
});
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/reportButton.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/discord/reportButton.ts tests/reportButton.test.ts
git commit -m "Keep one report button alive in the channel and clear stale drafts"
```

---

## Task 6: Opening the form and submitting it

**Files:**
- Modify: `src/discord/reportButton.ts`
- Test: `tests/reportButton.test.ts`

**Interfaces:**
- Consumes: `reportModal`, `resolveByName`, `OTHER` (Tasks 3 and 4); `fileReport`, `REPORT_CATEGORIES` from `src/tickets/filing.js`; `playerByDiscordId` from `src/players.js`; `BotInteraction`, `InteractionReply` from `src/discord/transport.js`.
- Produces:
  - `export interface ReportHandlerDeps { db: DB; adminSteamIds: string[]; now?: () => Date }`
  - `export function handleReportButton(deps: ReportHandlerDeps, i: Extract<BotInteraction, { kind: 'button' }>): Promise<InteractionReply>`
  - `export function handleReportModal(deps: ReportHandlerDeps, i: Extract<BotInteraction, { kind: 'modal' }>): Promise<InteractionReply>`

- [ ] **Step 1: Write the failing test**

Append to `tests/reportButton.test.ts`:

```typescript
import { linkDiscord } from '../src/players.js';
import { handleReportButton, handleReportModal } from '../src/discord/reportButton.js';

const D = (steamid: string) => `90${IDS.indexOf(steamid)}`;
const hDeps = () => ({ db, adminSteamIds: [] as string[] });
const open = (steamid: string) => handleReportButton(hDeps(), {
  kind: 'button', customId: 'rp:open', userId: D(steamid), userName: 'x',
});
const submit = (steamid: string, fields: Record<string, string>) => handleReportModal(hDeps(), {
  kind: 'modal', customId: 'rp:new', userId: D(steamid), userName: 'x', fields,
});
const said = (r: { payload: { content?: string } }) => r.payload.content ?? '';
const reports = () => db.prepare('SELECT r.category, r.text, t.target_id FROM ticket_reports r JOIN tickets t ON t.id = r.ticket_id').all();

const linkAll = (d: DB) => { for (const id of IDS) linkDiscord(d, id, D(id), `d${id}`); };

describe('opening the form', () => {
  beforeEach(() => { seedPlayers(db); linkAll(db); });

  it('answers with the form', async () => {
    const r = await open(ME);
    expect(r.ephemeral).toBe(true);
    expect(r.modal?.customId).toBe('rp:new');
  });

  it('tells an unlinked presser to link first, and opens no form', async () => {
    const r = await handleReportButton(hDeps(), {
      kind: 'button', customId: 'rp:open', userId: 'nobody', userName: 'x',
    });
    expect(r.modal).toBeUndefined();
    expect(said(r)).toContain('/link');
  });
});

describe('submitting the form', () => {
  beforeEach(() => { seedPlayers(db); linkAll(db); });

  it('files against the dropdown pick', async () => {
    const r = await submit(ME, { who: ALICE, name: '', reason: 'griefing', details: 'threw the round' });
    expect(said(r)).toContain('Thanks');
    expect(reports()).toEqual([{ category: 'griefing', text: 'threw the round', target_id: ALICE }]);
  });

  it('files against a uniquely typed name', async () => {
    const r = await submit(ME, { who: OTHER, name: 'Alice', reason: 'toxicity', details: '' });
    expect(said(r)).toContain('Thanks');
    expect(reports()).toHaveLength(1);
  });

  it('asks for someone when neither field is filled', async () => {
    const r = await submit(ME, { who: OTHER, name: '   ', reason: 'griefing', details: '' });
    expect(said(r)).toContain('Pick someone from the list');
    expect(reports()).toHaveLength(0);
  });

  it('says so when nobody has that name', async () => {
    const r = await submit(ME, { who: OTHER, name: 'ghost', reason: 'griefing', details: '' });
    expect(said(r)).toContain('No player here by that name');
    expect(reports()).toHaveLength(0);
  });

  it('refuses a self report', async () => {
    const r = await submit(ME, { who: OTHER, name: 'me', reason: 'griefing', details: '' });
    expect(said(r).toLowerCase()).toContain('yourself');
    expect(reports()).toHaveLength(0);
  });

  it('surfaces a refusal from fileReport, such as a safety report with no words', async () => {
    const r = await submit(ME, { who: ALICE, name: '', reason: 'unsafe', details: '' });
    expect(said(r)).toContain('say what happened');
    expect(reports()).toHaveLength(0);
  });

  it('rejects a reason that is not a category', async () => {
    const r = await submit(ME, { who: ALICE, name: '', reason: 'nonsense', details: '' });
    expect(reports()).toHaveLength(0);
    expect(said(r)).toContain('pick a category');
  });

  it('offers the choices when a name is shared, and files nothing yet', async () => {
    const r = await submit(ME, { who: OTHER, name: 'bob', reason: 'cheating', details: 'walls' });
    expect(reports()).toHaveLength(0);
    expect(r.payload.components[0].map((b) => (b as { customId: string }).customId))
      .toEqual([`rp:pick:1:${BOB1}`, `rp:pick:1:${BOB2}`]);
    const held = db.prepare('SELECT reporter_id, category, text FROM pending_reports').all();
    expect(held).toEqual([{ reporter_id: ME, category: 'cheating', text: 'walls' }]);
  });

  it('asks for a more specific name when too many share it', async () => {
    for (let n = 0; n < 6; n++) {
      const id = `7656119900000030${n}`;
      upsertPlayer(db, { steamid: id, name: `same${n}`, avatar: null }, []);
      activatePlayer(db, id);
    }
    const r = await submit(ME, { who: OTHER, name: 'same', reason: 'griefing', details: '' });
    expect(said(r)).toContain('Type more of it');
    expect(db.prepare('SELECT COUNT(*) AS n FROM pending_reports').get()).toEqual({ n: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/reportButton.test.ts`
Expected: FAIL, `handleReportButton` is not exported.

- [ ] **Step 3: Implement**

Add to `src/discord/reportButton.ts`:

```typescript
import { fileReport } from '../tickets/filing.js';
import { playerByDiscordId } from '../players.js';
import type { BotInteraction, InteractionReply } from './transport.js';

/** How many same-named players are worth offering as buttons. Beyond this,
 *  asking for a better name beats a wall of buttons. */
const MAX_CHOICES = 5;

export interface ReportHandlerDeps { db: DB; adminSteamIds: string[]; now?: () => Date }

const say = (content: string, components: InteractionReply['payload']['components'] = []): InteractionReply =>
  ({ ephemeral: true, payload: { content, embeds: [], components } });

const LINK_FIRST = 'Link your Steam account first with `/link`, then you can file a report.';

export async function handleReportButton(
  deps: ReportHandlerDeps, i: Extract<BotInteraction, { kind: 'button' }>,
): Promise<InteractionReply> {
  const me = playerByDiscordId(deps.db, i.userId);
  if (!me) return say(LINK_FIRST);
  if (i.customId === `${REPORT_PREFIX}open`) {
    return { ephemeral: true, payload: { content: 'Opening the form...', embeds: [], components: [] }, modal: reportModal(deps.db, me.steamid) };
  }
  return say('That button no longer does anything.');
}

export async function handleReportModal(
  deps: ReportHandlerDeps, i: Extract<BotInteraction, { kind: 'modal' }>,
): Promise<InteractionReply> {
  const me = playerByDiscordId(deps.db, i.userId);
  if (!me) return say(LINK_FIRST);
  const category = i.fields.reason ?? '';
  const text = (i.fields.details ?? '').trim();
  const picked = i.fields.who ?? OTHER;

  if (picked !== OTHER) return file(deps, me.steamid, picked, category, text);

  const typed = (i.fields.name ?? '').trim();
  if (!typed) return say('Pick someone from the list or type their name.');

  const found = resolveByName(deps.db, typed, MAX_CHOICES + 1);
  if (found.length === 0) {
    return say('No player here by that name. They may never have played on these servers.');
  }
  if (found.length === 1) return file(deps, me.steamid, found[0].steamid, category, text);
  if (found.length > MAX_CHOICES) {
    return say('Several players share that name. Type more of it, or pick them from the list if you played together recently.');
  }
  return hold(deps, me.steamid, typed, category, text, found);
}

/** The one place a report is actually filed, so every path shares the same
 *  refusals and the same wording. */
function file(deps: ReportHandlerDeps, reporter: string, targetId: string, category: string, text: string): InteractionReply {
  const r = fileReport(deps.db, reporter, { targetId, category, text }, {
    adminSteamIds: deps.adminSteamIds, now: deps.now?.(),
  });
  if (!r.ok) return say(`Could not file the report: ${r.error}.`);
  return say('Thanks. The moderators will look at it, and they will not be told who reported them.');
}

/** Keep the words while the reporter says which of these people they meant. */
function hold(
  deps: ReportHandlerDeps, reporter: string, typed: string, category: string, text: string, found: Candidate[],
): InteractionReply {
  const id = Number(deps.db.prepare(
    'INSERT INTO pending_reports (reporter_id, category, text, typed_name, candidates, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(reporter, category, text, typed, JSON.stringify(found.map((c) => c.steamid)),
    (deps.now?.() ?? new Date()).toISOString()).lastInsertRowid);
  return say(
    `More than one player is called "${typed}". Which one do you mean? Nothing is filed until you choose.`,
    [found.map((c) => ({ kind: 'button' as const, customId: `${REPORT_PREFIX}pick:${id}:${c.steamid}`, label: clip(c.name), style: 'secondary' as const }))],
  );
}
```

Note on the invalid-category test: `fileReport` is what rejects a reason outside `REPORT_CATEGORIES`, with "pick a category". Do not add a second check here; one list of categories is the point.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/reportButton.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/discord/reportButton.ts tests/reportButton.test.ts
git commit -m "Open the report form and file what someone submits"
```

---

## Task 7: Choosing between same-named players

**Files:**
- Modify: `src/discord/reportButton.ts` (extend `handleReportButton`)
- Test: `tests/reportButton.test.ts`

**Interfaces:**
- Consumes: `handleReportButton` (Task 6), the `pending_reports` table (Task 1).
- Produces: no new exports. `handleReportButton` gains the `rp:pick:<id>:<steamid>` branch.

- [ ] **Step 1: Write the failing test**

Append to `tests/reportButton.test.ts`:

```typescript
const pick = (steamid: string, customId: string) => handleReportButton(hDeps(), {
  kind: 'button', customId, userId: D(steamid), userName: 'x',
});

describe('choosing between same-named players', () => {
  beforeEach(async () => {
    seedPlayers(db); linkAll(db);
    await submit(ME, { who: OTHER, name: 'bob', reason: 'cheating', details: 'walls' });
  });

  it('files against the one chosen, with the words kept', async () => {
    const r = await pick(ME, `rp:pick:1:${BOB2}`);
    expect(said(r)).toContain('Thanks');
    expect(reports()).toEqual([{ category: 'cheating', text: 'walls', target_id: BOB2 }]);
  });

  it('clears the draft once it is filed', async () => {
    await pick(ME, `rp:pick:1:${BOB2}`);
    expect(db.prepare('SELECT COUNT(*) AS n FROM pending_reports').get()).toEqual({ n: 0 });
  });

  it('cannot be pressed twice', async () => {
    await pick(ME, `rp:pick:1:${BOB2}`);
    const again = await pick(ME, `rp:pick:1:${BOB2}`);
    expect(said(again)).toContain('expired');
    expect(reports()).toHaveLength(1);
  });

  it('refuses someone else pressing it, and files nothing', async () => {
    const r = await pick(ALICE, `rp:pick:1:${BOB2}`);
    expect(said(r)).toContain('not yours');
    expect(reports()).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM pending_reports').get()).toEqual({ n: 1 });
  });

  it('refuses a steamid that was never offered', async () => {
    const r = await pick(ME, `rp:pick:1:${CARL}`);
    expect(said(r)).toContain('not one of the choices');
    expect(reports()).toHaveLength(0);
  });

  it('says a reaped draft expired', async () => {
    db.prepare('DELETE FROM pending_reports').run();
    const r = await pick(ME, `rp:pick:1:${BOB2}`);
    expect(said(r)).toContain('expired');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/reportButton.test.ts`
Expected: FAIL, the pick branch falls through to "That button no longer does anything."

- [ ] **Step 3: Implement**

In `src/discord/reportButton.ts`, replace the tail of `handleReportButton` (the `return say('That button no longer does anything.')` line) with:

```typescript
  if (i.customId.startsWith(`${REPORT_PREFIX}pick:`)) {
    const [, , rawId, steamid] = i.customId.split(':');
    const row = deps.db.prepare('SELECT id, reporter_id, category, text, candidates FROM pending_reports WHERE id = ?')
      .get(Number(rawId)) as { id: number; reporter_id: string; category: string; text: string; candidates: string } | undefined;
    // Reaped after an hour, or already used: either way the words are gone
    // and the honest answer is to start again.
    if (!row) return say('That draft has expired, please file it again.');
    // The custom id travels through Discord, so the presser is checked
    // against the row rather than trusted.
    if (row.reporter_id !== me.steamid) return say('That choice is not yours to make.');
    if (!(JSON.parse(row.candidates) as string[]).includes(steamid)) {
      return say('That player was not one of the choices.');
    }
    const reply = file(deps, row.reporter_id, steamid, row.category, row.text);
    // Only on success: a refusal (the daily limit, say) leaves the draft in
    // place so the reporter is not made to type it again.
    if (reply.payload.content?.startsWith('Thanks')) {
      deps.db.prepare('DELETE FROM pending_reports WHERE id = ?').run(row.id);
    }
    return reply;
  }
  return say('That button no longer does anything.');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/reportButton.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/discord/reportButton.ts tests/reportButton.test.ts
git commit -m "Let a reporter choose which same-named player they meant"
```

---

## Task 8: Wire it into the bot

**Files:**
- Modify: `src/server.ts` (the `startBot` deps block, around lines 1186-1210)
- Test: `tests/reportButton.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: a live `ReportButton` started with the bot, `rp:` registered on both seams, and `opensModal` answering for both prefixes.

- [ ] **Step 1: Write the failing test**

Append to `tests/reportButton.test.ts`:

```typescript
import { opensTicketModal } from '../src/discord/ticketButtons.js';

describe('wiring', () => {
  it('routes rp: without colliding with r: or t:', () => {
    // src/discord/index.ts picks a handler with customId.startsWith(prefix).
    const prefixes = ['r:', 't:', 'rp:'];
    const routeOf = (id: string) => prefixes.find((p) => id.startsWith(p));
    expect(routeOf('rp:open')).toBe('rp:');
    expect(routeOf('rp:pick:1:76561199000000101')).toBe('rp:');
    expect(routeOf('r:1:ack')).toBe('r:');
    expect(routeOf('t:1:claim')).toBe('t:');
  });

  it('keeps every custom id inside Discord\'s 100 characters', () => {
    expect(`rp:pick:999999:76561199000000101`.length).toBeLessThanOrEqual(100);
  });

  it('composes the two modal predicates without either swallowing the other', () => {
    const opens = (id: string) => opensTicketModal(id) || opensReportModal(id);
    expect(opens('rp:open')).toBe(true);
    expect(opens('rp:pick:1:76561199000000101')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `npx vitest run tests/reportButton.test.ts`
Expected: PASS for the routing checks (they are assertions about the contract, not about `server.ts`). They exist to lock the prefix choice so a later rename cannot silently collide. If any fails, the prefix is wrong and must be fixed before wiring.

- [ ] **Step 3: Construct and start the module**

In `src/server.ts`, inside the same `onConnected` callback that builds `ticketSync`, after `ticketSync.start()` and `mirror.start()`:

```typescript
        reportButton = new ReportButton({ db: deps.db, transport: t });
        reportButton.start();
```

Declare `let reportButton: ReportButton | null = null;` beside the existing `let ticketSync` and `let ticketMirror` declarations, and add its `stop()` wherever those are torn down, so a test server does not leave a timer behind.

Add the import beside the other `./discord/` imports:

```typescript
import { ReportButton, handleReportButton, handleReportModal, opensReportModal } from './discord/reportButton.js';
```

- [ ] **Step 4: Register both seams**

In the same `startBot` deps object, extend the existing maps. The handler deps mirror what `handleCommand` is already given:

```typescript
      extraButtons: {
        'r:': (i) => adminFeed!.handleButton(i),
        't:': (i) => handleTicketButton({ db: deps.db, publicUrl: deps.config.publicUrl }, i),
        'rp:': (i) => handleReportButton({ db: deps.db, adminSteamIds: deps.config.adminSteamIds }, i),
      },
      extraModals: {
        't:': (i) => handleTicketModal({ db: deps.db, publicUrl: deps.config.publicUrl }, i),
        'rp:': (i) => handleReportModal({ db: deps.db, adminSteamIds: deps.config.adminSteamIds }, i),
      },
      opensModal: (id) => opensTicketModal(id) || opensReportModal(id),
```

- [ ] **Step 5: Typecheck and run the whole suite**

Run: `npm run typecheck`
Expected: clean.

Run: `npm test`
Expected: PASS. The ECONNREFUSED and AbortError lines from network-mocked tests are known pre-existing noise, not failures.

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: succeeds, `dist/public` produced.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts tests/reportButton.test.ts
git commit -m "Start the report button with the bot and route its presses"
```

---

## Verification before handing back

- [ ] `npm test`, `npm run typecheck` and `npm run build` all clean, with the test counts recorded.
- [ ] `git status --short data/` prints nothing.
- [ ] `git diff --stat origin/main..HEAD` touches only the files this plan names, plus `src/discord/djsTransport.ts` **not at all**. If that file appears in the diff, something went wrong.
- [ ] Record what was covered in a verification section appended to this plan, in the style of the phase 2a and 2b plans, and commit it.

Do not merge to master and do not deploy. Hand back to the owner with the branch name and the owner checklist below.

## Owner checklist

None of this is done by the implementer.

Before it does anything:

1. Rename the channel to something that reads as an intake, for example `#report-a-player`, and set its topic. Keep it visible to everyone: the button is useless in a channel members cannot see.
2. Settings, Discord group: paste the channel id into "Report button channel id". The standing message appears within five minutes, or at once on the next bot start.
3. Confirm the bot can Send Messages and Embed Links in that channel. It does not need Manage Messages there.

The manual checks that stand in for the tests the discord.js layer cannot have. Unlike phases 2a and 2b, this list is short, because nothing in this feature is new discord.js code:

4. Press the button as someone with Steam linked. The form opens with people you played with in the dropdown.
5. Press it from an account with no Steam link. You are told to run `/link`, privately, and no form opens.
6. File one report from the dropdown and check it appears in the mod forum as a normal ticket.
7. Delete the standing message by hand. Within five minutes a new one is posted.
8. Blank the setting. The message stops being maintained. Put it back.

## Verification (2026-09-22)

Task 8 is the smallest task in this plan: everything it touches (`ReportButton`, `handleReportButton`,
`handleReportModal`, `opensReportModal`) was built and unit-tested in Tasks 1-7. This task only wires
already-tested pieces into `src/server.ts`, so the verification is proportionally small: reading the
wiring back against the brief, the new routing-contract tests, and the four required commands. Nothing
here ran against a real Discord bot or a real gateway connection; no bot token is configured in this
worktree and none was started.

**The wiring itself.** `src/server.ts`: a `let reportButton: ReportButton | null = null;` declaration
beside `ticketSync`/`ticketMirror`; inside the same `onConnected` callback, after `ticketSync.start()` and
`mirror.start()`, `reportButton = new ReportButton({ db: deps.db, transport: t }); reportButton.start();`;
`'rp:'` added to both `extraButtons` and `extraModals` with the handler deps (`db`, `adminSteamIds`)
mirroring what `handleCommand` already receives; `opensModal` changed from the bare `opensTicketModal`
reference to `(id) => opensTicketModal(id) || opensReportModal(id)`; and `reportButton?.stop()` added to
the `onClose` hook, ahead of the existing `ticketMirror?.stop()`/`ticketSync?.stop()` pair, so a torn-down
test server or a restart never leaves the button's five-minute timer running. This matched the brief's
Steps 3 and 4 exactly; no deviation was needed.

**Test file.** `tests/reportButton.test.ts` gained one import (`opensTicketModal` from
`../src/discord/ticketButtons.js`; `opensReportModal` was already imported from a prior task) and the
`describe('wiring', ...)` block from the brief, verbatim, appended after the existing 57 tests. It asserts
the routing contract that makes `'rp:'` safe to add alongside `'r:'` and `'t:'` (their second characters
differ, so `Array.prototype.find`'s `startsWith` scan never picks the wrong handler), the 100-character
Discord custom-id ceiling for the longest real id shape, and that composing `opensTicketModal` with
`opensReportModal` with `||` never has one swallow the other's `true`.

**Commands, all four required.**

- `npx vitest run tests/reportButton.test.ts`: 1 file, 60 tests passed (57 from Tasks 1-7 plus the 3 new
  wiring tests).
- `npm test`: 269 files, 3758 tests, all passing (baseline was 269 files / 3755 tests; the 3 new tests
  account for the difference exactly). The ECONNREFUSED/AggregateError lines in the output are the known
  pre-existing noise from network-mocked tests, not failures, as the brief said to expect.
- `npm run typecheck`: clean (`tsc --noEmit` for the server, then again for `web/tsconfig.json`), no
  output beyond the command echo.
- `npm run build`: succeeded; `dist/public/index.html`, its css and its js bundle were produced.

**Other checks from "Verification before handing back."** `git status --short data/` printed nothing,
both before this task's commit and after. `git diff --stat origin/main..HEAD` lists exactly the files this
plan's tasks touch (`src/db.ts`, `src/discord/commands.ts`, `src/discord/reportButton.ts`,
`src/mergePlayers.ts`, `src/server.ts`, `src/settingsSchema.ts`, `src/tickets/schema.ts`, the two test
files, the plan and spec docs, and one line in `web/src/components/ReportPlayer.tsx`) plus this
verification doc; `src/discord/djsTransport.ts` does not appear anywhere in that diff.

**What this did not prove.** Nothing here started a real Discord bot, so nothing here proves the button
actually renders in a channel, that a real press reaches `handleReportButton` through discord.js's own
event plumbing, that the five-minute upkeep timer behaves correctly against real message edit limits, or
that `'rp:'` really cannot collide with a real button discord.js hands back (only the string-prefix
contract in isolation was checked, which is what the brief's own Step 2 note says the test is for: locking
the prefix choice, not exercising discord.js). Those are exactly the owner checklist items above, and they
still need a real bot, a real channel, and a real press to close out.

No functional defect was found while doing this task; the two-file commit for Steps 3/4 is the whole
functional diff, and this verification section is a separate commit on top of it, as the checklist above
asks for.
