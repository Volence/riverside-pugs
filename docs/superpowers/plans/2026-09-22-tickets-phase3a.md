# Tickets Phase 3a Implementation Plan: Discord-only people

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let anyone in the Discord be reported and let anyone in the Discord report, through the Report a player form and `/report`, with tickets about Discord-only people stored, listed and folded into a player when that person links Steam.

**Architecture:** `tickets`, `ticket_reports` and `pending_reports` are rebuilt once at boot so each side of a report is exactly one of a steamid or a Discord id (CHECK enforced). A small `src/tickets/person.ts` holds the key expressions and label helpers. `fileReport` becomes the one place that decides whether a picked Discord member is really a player, and enforces every refusal for both kinds. Discord interactions carry the picked member's facts (name, bot, administrator) and the presser's timeout, read from Discord's own interaction payload, so no handler has to call Discord.

**Tech Stack:** TypeScript, better-sqlite3, vitest, discord.js 14.27, Preact for three small web changes.

**Spec:** `docs/superpowers/specs/2026-09-22-tickets-phase3-design.md` (sections 1 and 2). Phase 3b (reporter chat) and 3c (Discord sanctions) get their own plans, written against the code this one produces.

## Global Constraints

- **Run the FULL suite (`npx vitest run`) at the end of every task**, not only the task's own test file. `tests/db.test.ts` (exhaustive table list) and `tests/mergePlayers.test.ts` (foreign-key sweep) guard cross-cutting tables and stayed hidden for five tasks in the report-button build. Also `npm run typecheck`.
- **Known test noise:** ECONNREFUSED lines in the output are pre-existing and harmless. `tests/logAuthWiring.test.ts` is a known flake. A fresh worktree has no `dist/`, and `tests/server.test.ts`'s malformed-URL case fails until `npm run build` has run once. None of these are yours; do not stash, reset or "check" them.
- **Never use `git stash`.** Other sessions share the stash stack.
- **NULL is the trap of this whole plan.** After Task 1, `tickets.target_id` and `ticket_reports.reporter_id` can be NULL. In SQL, `x != NULL` and `x = NULL` are NULL, which a WHERE treats as false, so a `t.target_id != @viewer` filter hides every Discord-only ticket from everyone. Use `IS NOT` / `IS` for any comparison where either side can be NULL, and `LEFT JOIN players` wherever a ticket's target is joined.
- **Person keys:** a player's key is its steamid; a Discord-only person's key is `'d:' || discord_id`. In SQL: `COALESCE(t.target_id, 'd:' || t.target_discord_id)` and `COALESCE(r.reporter_id, 'd:' || r.reporter_discord_id)`. Never invent another encoding.
- **A linked Discord account is always the player.** Only `fileReport` turns a Discord id into a player (Task 3). Surfaces pass what Discord gave them.
- **Everything goes through `fileReport`.** Never insert into `tickets` or `ticket_reports` from a surface.
- **Every Discord reply here is ephemeral.**
- **No em dashes** anywhere: copy, comments, commit messages.
- Only `src/discord/djsTransport.ts` imports discord.js.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/tickets/person.ts` (create) | `Person` type, key SQL fragments, `personKey`, `targetOf`, `targetLabel`. |
| `src/tickets/identityMigration.ts` (create) | `widenTicketIdentity(db)`: the one-time rebuild of `tickets`, `ticket_reports`, `pending_reports`, plus `ticket_threads.reporter_discord_id` and the `discord_sanctions` table. |
| `src/tickets/discordSanctions.ts` (create) | `activeDiscordSanction(db, discordId, now)`. The writers arrive in 3c. |
| `src/tickets/adopt.ts` (create) | `adoptDiscordPerson(db, discordId, steamid, adminSteamIds, now)`. |
| `src/db.ts` (modify) | Call `widenTicketIdentity` after the ticket `ensureColumn`s. |
| `src/tickets/store.ts`, `views.ts`, `threads.ts`, `actions.ts`, `filing.ts` (modify) | NULL-safe reads; `fileReport` for both kinds. |
| `src/discord/ticketCard.ts`, `ticketSync.ts`, `adminFeedPoster.ts`, `src/adminFeed.ts`, `src/routes/tickets.ts` (modify) | Name a Discord-only accused. |
| `src/players.ts` (modify) | `linkDiscord` calls `adoptDiscordPerson`. |
| `src/discord/transport.ts`, `djsTransport.ts`, `tests/fakes/fakeTransport.ts` (modify) | `user` modal field, `PickedMember`, presser timeout. |
| `src/discord/reportButton.ts`, `commands.ts` (modify) | Member picker, Discord-only reporters and targets. |
| `web/src/api.ts`, `web/src/routes/admin/AdminTicket.tsx`, `AdminTickets.tsx`, `web/src/components/MyReports.tsx` (modify) | Nullable ids, no profile link for a Discord-only person. |

---

### Task 1: The identity rebuild

**Files:**
- Create: `src/tickets/person.ts`, `src/tickets/identityMigration.ts`, `src/tickets/discordSanctions.ts`
- Modify: `src/db.ts` (after the `ensureColumn(db, 'ticket_access', 'notified_at', 'TEXT');` line, before `migrateLegacyReports(db);`)
- Test: `tests/ticketIdentityMigration.test.ts` (create), `tests/db.test.ts` (add `discord_sanctions` to its table list)

**Interfaces:**
- Produces: `widenTicketIdentity(db: DB): void`; `activeDiscordSanction(db: DB, discordId: string, now?: Date): { kind: 'timeout' | 'ban'; until: string | null } | null`; from `person.ts`: `type Person`, `personKey(p: Person): string`, `TARGET_KEY_SQL = "COALESCE(t.target_id, 'd:' || t.target_discord_id)"`, `REPORTER_KEY_SQL = "COALESCE(r.reporter_id, 'd:' || r.reporter_discord_id)"`, `targetOf(row): Person`, `targetLabel(db, row): string`.

Why the rebuild runs on every open, fresh databases included: `ensureTicketSchema` keeps creating the old shape, and `widenTicketIdentity` turns it into the new one. One code path, exercised by every test in the suite, rather than a fresh-db shape and a migrated shape that can drift apart. It is a few milliseconds on empty tables.

Why the old column lists are asserted: a column added to `tickets` or `ticket_reports` later by someone's `ensureColumn` and not listed here would be silently dropped by the copy. The assertion makes that a boot failure instead.

Why `sqlite_sequence` is restored by hand: `foldTicket` deletes tickets, so the highest id ever used can be above the current maximum. Dropping the table forgets that, and the next ticket would reuse a deleted id that `admin_actions.target` and `bans.ticket_id` still point at.

- [ ] **Step 1: Write `src/tickets/person.ts`**

```ts
import type { DB } from '../db.js';
import { getPlayer } from '../players.js';

/**
 * One side of a report. A player whenever the Discord account is linked; a
 * Discord member only when there is no player to point at. fileReport is the
 * one place that decides which (see filing.ts).
 */
export type Person =
  | { kind: 'player'; steamid: string }
  | { kind: 'discord'; discordId: string; name: string };

/** The one encoding of a person as a single string, used by the unique index
 *  tickets_one_open and every duplicate rule. A steamid is digits only, so it
 *  can never start with 'd:'. */
export const personKey = (p: Person): string => (p.kind === 'player' ? p.steamid : `d:${p.discordId}`);

export const TARGET_KEY_SQL = "COALESCE(t.target_id, 'd:' || t.target_discord_id)";
export const REPORTER_KEY_SQL = "COALESCE(r.reporter_id, 'd:' || r.reporter_discord_id)";

export interface TargetColumns { target_id: string | null; target_discord_id: string | null; target_name: string }

export function targetOf(row: TargetColumns): Person {
  return row.target_id !== null
    ? { kind: 'player', steamid: row.target_id }
    : { kind: 'discord', discordId: row.target_discord_id!, name: row.target_name };
}

/** A readable name for the accused. Not escaped: callers escape for their
 *  own surface, as they do for player names today. */
export function targetLabel(db: DB, row: TargetColumns): string {
  if (row.target_id !== null) return getPlayer(db, row.target_id)?.name ?? row.target_id;
  return row.target_name || 'a Discord member';
}
```

- [ ] **Step 2: Write the failing migration test** `tests/ticketIdentityMigration.test.ts`

It builds a file-backed database in the PRE-phase-3 shape by opening with the migration disabled, fills it, then opens it for real.

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { upsertPlayer, activatePlayer, currentSeasonId } from '../src/players.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ident-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const cols = (db: Database.Database, t: string) =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; notnull: number }[]);

/** Put a database into the pre-phase-3 shape: open it (which migrates), then
 *  rebuild the three tables the old way. Kept inside the test, so the test
 *  does not depend on an old copy of the source. */
function oldShape(path: string): void {
  const db = openDb(path);
  db.close();
  const raw = new Database(path);
  raw.pragma('foreign_keys = OFF');
  raw.exec(`
    DROP INDEX IF EXISTS tickets_one_open;
    CREATE TABLE t_old (id INTEGER PRIMARY KEY AUTOINCREMENT, target_id TEXT NOT NULL REFERENCES players(steamid),
      status TEXT NOT NULL DEFAULT 'open', outcome TEXT, outcome_note TEXT NOT NULL DEFAULT '', restricted INTEGER NOT NULL DEFAULT 0,
      claimed_by TEXT, opened_by TEXT, created_at TEXT NOT NULL, closed_at TEXT, closed_by TEXT);
    DROP TABLE tickets; ALTER TABLE t_old RENAME TO tickets;
    CREATE UNIQUE INDEX tickets_one_open ON tickets (target_id, restricted) WHERE status = 'open';
    CREATE TABLE r_old (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      reporter_id TEXT NOT NULL REFERENCES players(steamid), category TEXT NOT NULL, text TEXT NOT NULL DEFAULT '',
      match_id INTEGER REFERENCES matches(id), map_ordinal INTEGER, half INTEGER, t_ms INTEGER, created_at TEXT NOT NULL,
      legacy_report_id INTEGER UNIQUE, announced_at TEXT, feed_held INTEGER NOT NULL DEFAULT 0);
    DROP TABLE ticket_reports; ALTER TABLE r_old RENAME TO ticket_reports;
    CREATE INDEX idx_ticket_reports_ticket ON ticket_reports (ticket_id);
    CREATE INDEX idx_ticket_reports_reporter ON ticket_reports (reporter_id, created_at);
    CREATE TABLE p_old (id INTEGER PRIMARY KEY AUTOINCREMENT, reporter_id TEXT NOT NULL REFERENCES players(steamid),
      category TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', typed_name TEXT NOT NULL, candidates TEXT NOT NULL, created_at TEXT NOT NULL);
    DROP TABLE pending_reports; ALTER TABLE p_old RENAME TO pending_reports;
    CREATE INDEX idx_pending_reports_created ON pending_reports (created_at);
    DROP TABLE IF EXISTS discord_sanctions;
  `);
  raw.close();
}

const A = '76561199000000301';
const B = '76561199000000302';

describe('widenTicketIdentity', () => {
  it('keeps every row and every id, and widens the three tables', () => {
    const path = join(dir, 'pug.db');
    oldShape(path);
    // Fill the old shape through a raw handle: openDb would migrate it.
    const raw = new Database(path);
    raw.prepare("INSERT INTO players (steamid, name) VALUES (?, 'a'), (?, 'b')").run(A, B);
    raw.prepare("INSERT INTO tickets (id, target_id, created_at) VALUES (1, ?, '2026-09-22T00:00:00Z')").run(B);
    raw.prepare("INSERT INTO tickets (id, target_id, created_at) VALUES (7, ?, '2026-09-22T00:00:00Z')").run(A);
    raw.prepare('DELETE FROM tickets WHERE id = 7').run(); // a folded ticket: seq stays at 7
    raw.prepare("INSERT INTO ticket_reports (ticket_id, reporter_id, category, created_at, feed_held) VALUES (1, ?, 'afk', '2026-09-22T00:00:00Z', 1)").run(A);
    raw.prepare("INSERT INTO pending_reports (reporter_id, category, typed_name, candidates, created_at) VALUES (?, 'afk', 'bo', '[]', '2026-09-22T00:00:00Z')").run(A);
    raw.close();

    const db = openDb(path);
    expect(db.prepare('SELECT id, target_id, target_discord_id, target_name FROM tickets').all())
      .toEqual([{ id: 1, target_id: B, target_discord_id: null, target_name: '' }]);
    expect(db.prepare('SELECT reporter_id, feed_held FROM ticket_reports').get()).toEqual({ reporter_id: A, feed_held: 1 });
    expect(db.prepare('SELECT reporter_id FROM pending_reports').get()).toEqual({ reporter_id: A });
    // The next ticket must not reuse the folded id 7.
    const next = db.prepare("INSERT INTO tickets (target_id, created_at) VALUES (?, 'x')").run(A).lastInsertRowid;
    expect(Number(next)).toBe(8);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('matches a fresh database column for column, and a second open changes nothing', () => {
    const path = join(dir, 'pug.db');
    oldShape(path);
    openDb(path).close();
    const migrated = new Database(path);
    const fresh = openDb(':memory:');
    for (const t of ['tickets', 'ticket_reports', 'pending_reports', 'ticket_threads', 'discord_sanctions']) {
      expect(cols(migrated, t)).toEqual(cols(fresh as unknown as Database.Database, t));
    }
    const schema = () => migrated.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
    const before = schema();
    migrated.close();
    openDb(path).close();
    const again = new Database(path);
    expect(again.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all()).toEqual(before);
    again.close();
  });

  it('enforces exactly one identity on each side', () => {
    const db = openDb(':memory:');
    upsertPlayer(db, { steamid: A, name: 'a', avatar: null }, []);
    const ins = db.prepare('INSERT INTO tickets (target_id, target_discord_id, created_at) VALUES (?, ?, ?)');
    expect(() => ins.run(null, null, 'x')).toThrow(/CHECK/);
    expect(() => ins.run(A, '111', 'x')).toThrow(/CHECK/);
    ins.run(null, '111', 'x');
    // One open case per person holds for Discord people too.
    expect(() => ins.run(null, '111', 'x')).toThrow(/UNIQUE/);
    const rep = db.prepare("INSERT INTO ticket_reports (ticket_id, reporter_id, reporter_discord_id, category, created_at) VALUES (1, ?, ?, 'afk', 'x')");
    expect(() => rep.run(null, null)).toThrow(/CHECK/);
    rep.run(null, '222');
  });

  it('refuses to run over a column it does not know', () => {
    const path = join(dir, 'pug.db');
    oldShape(path);
    const raw = new Database(path);
    raw.exec('ALTER TABLE tickets ADD COLUMN surprise TEXT');
    raw.close();
    expect(() => openDb(path)).toThrow(/surprise/);
  });
});
```

Note `currentSeasonId` and `activatePlayer` are imported for parity with other ticket tests; drop them if the linter flags unused imports.

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run tests/ticketIdentityMigration.test.ts`
Expected: FAIL (no `target_discord_id` column).

- [ ] **Step 4: Write `src/tickets/discordSanctions.ts`**

```ts
import type { DB } from '../db.js';

/**
 * Discord-side sanctions on people who have no player account: a timeout or
 * a ban the bot carried out. Written in phase 3c; read here so a sanctioned
 * Discord-only member cannot file reports, which is their equivalent of
 * inGoodStanding.
 */
export function activeDiscordSanction(
  db: DB, discordId: string, now = new Date(),
): { kind: 'timeout' | 'ban'; until: string | null } | null {
  const row = db.prepare(
    `SELECT kind, until FROM discord_sanctions
     WHERE discord_id = ? AND lifted_at IS NULL AND (until IS NULL OR until > ?)
     ORDER BY id DESC LIMIT 1`,
  ).get(discordId, now.toISOString()) as { kind: 'timeout' | 'ban'; until: string | null } | undefined;
  return row ?? null;
}
```

- [ ] **Step 5: Write `src/tickets/identityMigration.ts`**

```ts
import type { DB } from '../db.js';

const TICKETS_OLD = ['id', 'target_id', 'status', 'outcome', 'outcome_note', 'restricted', 'claimed_by', 'opened_by', 'created_at', 'closed_at', 'closed_by'];
const REPORTS_OLD = ['id', 'ticket_id', 'reporter_id', 'category', 'text', 'match_id', 'map_ordinal', 'half', 't_ms', 'created_at', 'legacy_report_id', 'announced_at', 'feed_held'];
const PENDING_OLD = ['id', 'reporter_id', 'category', 'text', 'typed_name', 'candidates', 'created_at'];

const columnsOf = (db: DB, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

function assertColumns(db: DB, table: string, expected: string[]): void {
  const extra = columnsOf(db, table).filter((c) => !expected.includes(c));
  if (extra.length > 0) {
    throw new Error(`widenTicketIdentity: ${table} has columns this rebuild would drop: ${extra.join(', ')}. Add them to identityMigration.ts.`);
  }
}

/** Every index on a table except the automatic ones and those in `skip`, so
 *  indexes added over time survive the rebuild without being listed here. */
const indexesOf = (db: DB, table: string, skip: string[]) =>
  (db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(table) as { name: string; sql: string }[])
    .filter((i) => !skip.includes(i.name));

/**
 * Phase 3: each side of a report is a player OR a Discord member. Rebuilds
 * tickets, ticket_reports and pending_reports so their player column is
 * nullable beside a Discord id, with a CHECK that exactly one is set, and
 * re-keys tickets_one_open over both. See the phase 3 spec, section 1.
 *
 * Runs on every open and does nothing once tickets has target_discord_id. A
 * fresh database is created in the old shape by ensureTicketSchema and
 * converted here, so there is one shape and one path to it.
 *
 * The 12-step SQLite recipe: foreign keys off (only possible outside a
 * transaction), everything else in one transaction, foreign_key_check before
 * commit, foreign keys back on.
 */
export function widenTicketIdentity(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS discord_sanctions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    until TEXT,
    reason TEXT NOT NULL,
    ticket_id INTEGER REFERENCES tickets(id),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    lifted_by TEXT,
    lifted_at TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_discord_sanctions_discord ON discord_sanctions (discord_id)');
  if (!columnsOf(db, 'ticket_threads').includes('reporter_discord_id')) {
    db.exec('ALTER TABLE ticket_threads ADD COLUMN reporter_discord_id TEXT');
  }
  if (columnsOf(db, 'tickets').includes('target_discord_id')) return;

  assertColumns(db, 'tickets', TICKETS_OLD);
  assertColumns(db, 'ticket_reports', REPORTS_OLD);
  assertColumns(db, 'pending_reports', PENDING_OLD);
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('tickets', 'ticket_reports', 'pending_reports')").all();
  if (triggers.length > 0) throw new Error('widenTicketIdentity: triggers on the ticket tables are not handled');

  const seqOf = (name: string) => (db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(name) as { seq: number } | undefined)?.seq;
  const seqs = { tickets: seqOf('tickets'), ticket_reports: seqOf('ticket_reports'), pending_reports: seqOf('pending_reports') };
  const keepTickets = indexesOf(db, 'tickets', ['tickets_one_open']);
  const keepReports = indexesOf(db, 'ticket_reports', []);
  const keepPending = indexesOf(db, 'pending_reports', []);

  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE tickets_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          target_id TEXT REFERENCES players(steamid),
          target_discord_id TEXT,
          target_name TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'open',
          outcome TEXT,
          outcome_note TEXT NOT NULL DEFAULT '',
          restricted INTEGER NOT NULL DEFAULT 0,
          claimed_by TEXT,
          opened_by TEXT,
          created_at TEXT NOT NULL,
          closed_at TEXT,
          closed_by TEXT,
          CHECK ((target_id IS NULL) <> (target_discord_id IS NULL))
        );
        INSERT INTO tickets_new (${TICKETS_OLD.join(', ')}) SELECT ${TICKETS_OLD.join(', ')} FROM tickets;
        DROP TABLE tickets;
        ALTER TABLE tickets_new RENAME TO tickets;
        CREATE UNIQUE INDEX tickets_one_open ON tickets (COALESCE(target_id, 'd:' || target_discord_id), restricted) WHERE status = 'open';
        CREATE INDEX idx_tickets_target_discord ON tickets (target_discord_id);

        CREATE TABLE ticket_reports_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ticket_id INTEGER NOT NULL REFERENCES tickets(id),
          reporter_id TEXT REFERENCES players(steamid),
          reporter_discord_id TEXT,
          reporter_name TEXT NOT NULL DEFAULT '',
          category TEXT NOT NULL,
          text TEXT NOT NULL DEFAULT '',
          match_id INTEGER REFERENCES matches(id),
          map_ordinal INTEGER,
          half INTEGER,
          t_ms INTEGER,
          created_at TEXT NOT NULL,
          legacy_report_id INTEGER UNIQUE,
          announced_at TEXT,
          feed_held INTEGER NOT NULL DEFAULT 0,
          CHECK ((reporter_id IS NULL) <> (reporter_discord_id IS NULL))
        );
        INSERT INTO ticket_reports_new (${REPORTS_OLD.join(', ')}) SELECT ${REPORTS_OLD.join(', ')} FROM ticket_reports;
        DROP TABLE ticket_reports;
        ALTER TABLE ticket_reports_new RENAME TO ticket_reports;
        CREATE INDEX idx_ticket_reports_reporter_discord ON ticket_reports (reporter_discord_id, created_at);

        CREATE TABLE pending_reports_new (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          reporter_id TEXT REFERENCES players(steamid),
          reporter_discord_id TEXT,
          category    TEXT NOT NULL,
          text        TEXT NOT NULL DEFAULT '',
          typed_name  TEXT NOT NULL,
          candidates  TEXT NOT NULL,
          created_at  TEXT NOT NULL,
          CHECK ((reporter_id IS NULL) <> (reporter_discord_id IS NULL))
        );
        INSERT INTO pending_reports_new (${PENDING_OLD.join(', ')}) SELECT ${PENDING_OLD.join(', ')} FROM pending_reports;
        DROP TABLE pending_reports;
        ALTER TABLE pending_reports_new RENAME TO pending_reports;
      `);
      for (const i of [...keepTickets, ...keepReports, ...keepPending]) db.exec(i.sql);
      for (const [name, seq] of Object.entries(seqs)) {
        if (seq !== undefined) db.prepare('UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?').run(seq, name);
      }
      const broken = db.pragma('foreign_key_check') as unknown[];
      if (broken.length > 0) throw new Error(`widenTicketIdentity: foreign_key_check failed: ${JSON.stringify(broken.slice(0, 5))}`);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
```

A note on `UPDATE sqlite_sequence ... MAX(seq, ?)`: copying rows with explicit ids already creates the sequence row at the highest copied id, which is below the old value when the top ticket was folded away. If the table was empty, no sequence row exists yet; then insert one: after the loop add, for any name with a saved `seq` and no row, `INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)`. Write it as:

```ts
      for (const [name, seq] of Object.entries(seqs)) {
        if (seq === undefined) continue;
        const has = db.prepare('SELECT 1 FROM sqlite_sequence WHERE name = ?').get(name);
        if (has) db.prepare('UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?').run(seq, name);
        else db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(name, seq);
      }
```

(use this version in place of the two-line loop above).

- [ ] **Step 6: Call it from `openDb`** in `src/db.ts`, right after `ensureColumn(db, 'ticket_access', 'notified_at', 'TEXT');`:

```ts
  // After every ticket ensureColumn, so the rebuild copies announced_at and
  // feed_held rather than dropping them. Before the legacy migration, which
  // inserts into the rebuilt tables.
  widenTicketIdentity(db);
```

with `import { widenTicketIdentity } from './tickets/identityMigration.js';` at the top.

- [ ] **Step 7: Add `discord_sanctions` to the table list in `tests/db.test.ts`** (find the exhaustive list of expected tables and insert it in alphabetical position).

- [ ] **Step 8: Run the migration test, then the full suite and typecheck**

Run: `npx vitest run tests/ticketIdentityMigration.test.ts` then `npx vitest run` then `npm run typecheck`
Expected: the new file passes. The full suite may now show TypeScript errors where `TicketRow.target_id` is typed `string`; it is still typed `string` at this point, so there should be none. If any existing test fails, it is a real regression of the rebuild: fix it here, not in Task 2.

- [ ] **Step 9: Commit**

```bash
git add src/tickets/person.ts src/tickets/identityMigration.ts src/tickets/discordSanctions.ts src/db.ts tests/ticketIdentityMigration.test.ts tests/db.test.ts
git commit -m "Let a ticket and a report name a Discord member instead of a player"
```

---

### Task 2: NULL-safe readers

Every reader that assumes `target_id` or `reporter_id` is set. Without this task a ticket about a Discord-only person exists but nobody can see it.

**Files:**
- Modify: `src/tickets/store.ts`, `src/tickets/views.ts`, `src/tickets/threads.ts`, `src/tickets/actions.ts`, `src/tickets/filing.ts` (only `myReports`), `src/discord/ticketCard.ts`, `src/discord/ticketSync.ts`, `src/adminFeed.ts`, `src/discord/adminFeedPoster.ts`, `src/routes/tickets.ts`, `web/src/api.ts`, `web/src/routes/admin/AdminTicket.tsx`, `web/src/routes/admin/AdminTickets.tsx`, `web/src/components/MyReports.tsx`
- Test: `tests/ticketDiscordTargets.test.ts` (create)

**Interfaces:**
- Consumes: `targetLabel`, `TARGET_KEY_SQL`, `REPORTER_KEY_SQL` from Task 1.
- Produces: `TicketRow` gains `target_id: string | null; target_discord_id: string | null; target_name: string`. `TicketSummary.targetId: string | null`, new `targetDiscordId: string | null`. Report rows in the detail view: `reporterId: string | null`, new `reporterDiscordId: string | null`. `MyReport.targetId: string | null`, new `targetDiscordId: string | null`. Admin feed event `{ kind: 'report'; ticketId; targetId: string | null; targetName: string; category; created }`. `banFromTicket` refuses a Discord-only target with 400 `'this person has no player account, so there is nothing to ban on the servers'`.

- [ ] **Step 1: Write the failing test** `tests/ticketDiscordTargets.test.ts`

Rows are inserted directly because `fileReport` learns Discord people only in Task 3.

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { listTickets, ticketCounts, ticketDetail } from '../src/tickets/views.js';
import { canSeeTicket, getTicketRow } from '../src/tickets/store.js';
import { myReports } from '../src/tickets/filing.js';
import { banFromTicket } from '../src/tickets/actions.js';
import { privateThreadAudience, forbiddenForumThreads } from '../src/tickets/threads.js';
import { ticketCard } from '../src/discord/ticketCard.js';

const MOD = '76561199000000401';
const REP = '76561199000000402';
const LURKER = '900000000000000001';
let db: DB;
let ticketId: number;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [MOD, REP]) {
    upsertPlayer(db, { steamid: id, name: id === MOD ? 'mod' : 'rep', avatar: null }, []);
    activatePlayer(db, id);
  }
  db.prepare("UPDATE players SET is_mod = 1, discord_id = '800' WHERE steamid = ?").run(MOD);
  ticketId = Number(db.prepare(
    "INSERT INTO tickets (target_discord_id, target_name, created_at) VALUES (?, 'Lurky', '2026-09-22T00:00:00Z')",
  ).run(LURKER).lastInsertRowid);
  db.prepare(
    "INSERT INTO ticket_reports (ticket_id, reporter_id, category, created_at) VALUES (?, ?, 'toxicity', '2026-09-22T00:00:00Z')",
  ).run(ticketId, REP);
  db.prepare(
    "INSERT INTO ticket_reports (ticket_id, reporter_discord_id, reporter_name, category, created_at) VALUES (?, '901', 'Other lurker', 'toxicity', '2026-09-22T00:00:01Z')",
  ).run(ticketId);
});

describe('a ticket about a Discord-only person', () => {
  it('is visible to staff in the list, the counts and the detail', () => {
    const [t] = listTickets(db, MOD, 'open');
    expect(t).toMatchObject({ id: ticketId, targetId: null, targetDiscordId: LURKER, targetName: 'Lurky', reports: 2, reporters: 2 });
    expect(ticketCounts(db, MOD).open).toBe(1);
    expect(canSeeTicket(db, getTicketRow(db, ticketId)!, MOD)).toBe(true);
    const d = ticketDetail(db, ticketId, MOD)!;
    expect(d.reports.map((r) => [r.reporterId, r.reporterDiscordId, r.reporterName])).toEqual([
      [REP, null, 'rep'], [null, '901', 'Other lurker'],
    ]);
  });

  it('shows on the reporter\'s own list', () => {
    expect(myReports(db, REP)).toMatchObject([{ targetId: null, targetDiscordId: LURKER, targetName: 'Lurky', status: 'open' }]);
  });

  it('a restricted one still lets its access list in, and offers staff to add', () => {
    db.prepare('UPDATE tickets SET restricted = 1 WHERE id = ?').run(ticketId);
    db.prepare("INSERT INTO ticket_access (ticket_id, steamid, added_by, created_at) VALUES (?, ?, 'system', 'x')").run(ticketId, MOD);
    expect(listTickets(db, MOD, 'open')).toHaveLength(1);
    expect(privateThreadAudience(db, ticketId).map((m) => m.steamid)).toEqual([MOD]);
  });

  it('a forum thread about it is forbidden only once the ticket is restricted', () => {
    db.prepare("INSERT INTO ticket_threads (ticket_id, kind, channel_id, thread_id, created_at, surface) VALUES (?, 'staff', 'f', 'th1', 'x', 'forum')").run(ticketId);
    expect(forbiddenForumThreads(db)).toHaveLength(0);
    db.prepare('UPDATE tickets SET restricted = 1 WHERE id = ?').run(ticketId);
    expect(forbiddenForumThreads(db)).toHaveLength(1);
  });

  it('cannot be server-banned from, since there is no player', () => {
    db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(MOD);
    expect(banFromTicket(db, ticketId, MOD, 'spam', 60)).toMatchObject({ ok: false, status: 400 });
  });

  it('the staff card names them without a profile link', () => {
    const card = ticketCard(db, ticketId, 'https://x')!;
    const accused = card.embed.fields!.find((f) => f.name === 'Accused')!.value;
    expect(accused).toContain('Lurky');
    expect(accused).not.toContain('/player/');
    expect(card.embed.fields!.find((f) => f.name === 'Reports')!.value).toContain('2 from 2');
  });
});
```

Check the real names before running: `ticketDetail` may be named differently in `views.ts` (search for the function that returns `reports` and `access`), and `ticketCard` returns a shape whose embed you should read in `ticketCard.ts` (adjust `card.embed.fields` to match; the test's intent is the Accused field text). Fix the test to the real names, not the code to the test.

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/ticketDiscordTargets.test.ts`
Expected: FAIL (the list is empty: `t.target_id != @viewer` is NULL).

- [ ] **Step 3: `src/tickets/store.ts`**

In `TicketRow`: `target_id: string | null;` and add `target_discord_id: string | null; target_name: string;`.

`hasStaffFlag(db: DB, steamid: string | null)`: first line `if (steamid === null) return false;`.

`canSeeTicket` needs no change: `t.target_id === viewer` is false for null. `accessSeed` and `seedAccess` take `targetId: string`; callers pass `personKey(targetOf(t))` from now on (a `'d:'` key excludes nobody real, which is right: a Discord-only person has no player row to exclude).

`restrictOpenTicketAbout` and `reseedOrphanedTickets`: in `reseedOrphanedTickets`, select `t.target_id, t.target_discord_id, t.target_name` and pass `personKey(targetOf(t))` to `seedAccess`.

- [ ] **Step 4: `src/tickets/views.ts`**

```ts
const VISIBLE = `t.target_id IS NOT @viewer AND (t.restricted = 0 OR EXISTS
  (SELECT 1 FROM ticket_access a WHERE a.ticket_id = t.id AND a.steamid = @viewer))`;
```

In `SUMMARY`: `COALESCE(pt.name, NULLIF(t.target_name, '')) AS target_name` in place of `pt.name AS target_name`, and the reporters count becomes `(SELECT COUNT(DISTINCT ${REPORTER_KEY_SQL}) FROM ticket_reports r WHERE r.ticket_id = t.id) AS reporters` (import `REPORTER_KEY_SQL`; SUMMARY becomes a template literal if it is not one). `SummaryRow.target_id: string | null`, add `target_discord_id: string | null`; `toSummary` adds `targetDiscordId: r.target_discord_id`. `SELECT t.*` already carries the new columns.

`ticketsAbout` is only called with a steamid; unchanged.

The reports query in the detail: select `r.reporter_discord_id` and `COALESCE(p.name, NULLIF(r.reporter_name, '')) AS reporter_name`; the row type gets `reporter_id: string | null; reporter_discord_id: string | null`, and the mapped object adds `reporterDiscordId: r.reporter_discord_id`.

`accessCandidates`: `AND steamid IS NOT ?` in place of `AND steamid != ?` (with a NULL target the old form returned no candidates at all).

- [ ] **Step 5: `src/tickets/threads.ts`**

`forbiddenForumThreads`: `JOIN players p ON p.steamid = t.target_id` becomes `LEFT JOIN players p ON p.steamid = t.target_id`. The condition `(t.restricted = 1 OR p.is_admin = 1 OR p.is_mod = 1)` then reads correctly for a NULL `p`.

`surfaceFor(db, t: { restricted: number; target_id: string | null })`: `hasStaffFlag` already handles null after Step 3.

`privateThreadAudience`: `AND p.steamid IS NOT t.target_id`.

`forumAudience`: `t.target_id = p.steamid` inside NOT EXISTS is already right (NULL never matches). Leave it.

- [ ] **Step 6: `src/tickets/actions.ts`**

In `banFromTicket`, straight after the `status !== 'open'` check:

```ts
  // Phase 3c gives these tickets a Discord timeout or ban instead.
  if (t.target_id === null) return fail(400, 'this person has no player account, so there is nothing to ban on the servers');
```

After that line TypeScript still sees `string | null`; bind `const targetId = t.target_id;` after the guard and use `targetId` in the rest of the function.

`setRestricted` (line ~55: `hasStaffFlag(db, t.target_id)`) compiles as is after Step 3. Its `seedAccess(db, id, t.target_id, ...)` becomes `seedAccess(db, id, personKey(targetOf(t)), ...)`.

- [ ] **Step 7: `myReports` in `src/tickets/filing.ts`**

```ts
export interface MyReport { id: number; targetId: string | null; targetDiscordId: string | null; targetName: string | null; category: string; matchId: number | null; createdAt: string; status: 'open' | 'closed' }

export function myReports(db: DB, reporter: string): MyReport[] {
  return db.prepare(
    `SELECT r.id, t.target_id AS targetId, t.target_discord_id AS targetDiscordId,
            COALESCE(p.name, NULLIF(t.target_name, '')) AS targetName, r.category, r.match_id AS matchId,
            r.created_at AS createdAt, t.status
     FROM ticket_reports r JOIN tickets t ON t.id = r.ticket_id LEFT JOIN players p ON p.steamid = t.target_id
     WHERE r.reporter_id = ? AND t.target_id IS NOT r.reporter_id ORDER BY r.id DESC LIMIT 100`,
  ).all(reporter) as MyReport[];
}
```

Keep the existing doc comment above it.

- [ ] **Step 8: Discord surfaces**

`src/discord/ticketCard.ts`: the reporters count becomes `COUNT(DISTINCT COALESCE(reporter_id, 'd:' || reporter_discord_id))`. The Accused field:

```ts
  const accused = targetLabel(db, t);
  // A Discord-only person has no profile page. The id is shown as code so a
  // moderator can find them in Discord's member list; never as a mention,
  // which would ping them from a staff post.
  const accusedValue = t.target_id !== null
    ? `${escapeName(accused)} ([profile](${publicUrl}/player/${t.target_id}))`
    : `${escapeName(accused)} (Discord member \`${t.target_discord_id}\`)`;
```

and use `accusedValue` in the field. Remove the old `getPlayer(...)?.name ?? t.target_id` line.

`src/adminFeed.ts`: the report event becomes `{ kind: 'report'; ticketId: number; targetId: string | null; targetName: string; category: string; created: boolean }`.

`src/discord/ticketSync.ts` line ~284: `publishAdminEvent({ kind: 'report', ticketId: t.id, targetId: t.target_id, targetName: targetLabel(db, t), category: r.category, created: first });` (use whatever the db handle is called there).

`src/discord/adminFeedPoster.ts` in `case 'report'`: `const who = e.targetId !== null ? this.name(e.targetId) : escapeName(e.targetName);` and use `who` in both strings. Check how `this.name` escapes and import `escapeName` from wherever `presenter.ts` or `identity.ts` exports it (it moved to `src/identity.ts`).

`src/routes/tickets.ts` ban route: `if (r.ok) matchmaker.remove(getTicketRow(db, id)!.target_id!);` is safe because `banFromTicket` refuses a NULL target before `ok`; write it with a guard instead of `!` so a future change cannot pass null: `const target = getTicketRow(db, id)?.target_id; if (r.ok && target) matchmaker.remove(target);`.

- [ ] **Step 9: Web**

`web/src/api.ts`: the three types at lines ~865, ~958, ~964: `targetId: string | null; targetDiscordId: string | null;` and `reporterId: string | null; reporterDiscordId: string | null;`.

`web/src/routes/admin/AdminTicket.tsx` line ~55:

```tsx
        #{t.id} {t.targetId
          ? <a href={`/player/${t.targetId}`}>{t.targetName ?? t.targetId}</a>
          : <span title={`Discord member ${t.targetDiscordId}`}>{t.targetName ?? 'Discord member'} <small>(Discord only)</small></span>}
```

line ~85, the same pattern for a reporter (`r.reporterId` link, else the name and "(Discord only)"). Line ~164, the ban confirm title: `t.targetName ?? t.targetId ?? 'this person'`; the Ban control must not render when `t.targetId === null` (find the button and wrap it in `{t.targetId && ...}`).

`web/src/routes/admin/AdminTickets.tsx` line ~34: `{t.targetName ?? t.targetId ?? 'Discord member'}`.

`web/src/components/MyReports.tsx` line ~20: link only when `r.targetId`, else plain `r.targetName ?? 'a Discord member'`.

- [ ] **Step 10: Run the new test, the full suite and typecheck**

Run: `npx vitest run tests/ticketDiscordTargets.test.ts`, `npx vitest run`, `npm run typecheck`
Expected: all pass. The typecheck is what finds any `target_id` reader this list missed: fix each one the same way (`IS NOT`, `LEFT JOIN`, or `targetLabel`) and say in the report which extra ones you found.

- [ ] **Step 11: Commit**

```bash
git add -A src web tests/ticketDiscordTargets.test.ts
git commit -m "Show tickets about Discord-only people everywhere tickets are listed"
```

---

### Task 3: `fileReport` for both kinds of people

**Files:**
- Modify: `src/tickets/filing.ts`
- Test: `tests/ticketFilingDiscord.test.ts` (create)

**Interfaces:**
- Consumes: `Person`, `personKey`, `TARGET_KEY_SQL`, `REPORTER_KEY_SQL` (Task 1), `activeDiscordSanction` (Task 1).
- Produces:

```ts
export interface DiscordReporter { kind: 'discord'; discordId: string; name: string; timedOutUntil: string | null }
export interface PickedTarget { discordId: string; name: string; bot: boolean; administrator: boolean }
export interface FileBody { targetId?: unknown; targetDiscord?: PickedTarget; category?: unknown; text?: unknown; matchId?: unknown; moment?: unknown }
export function fileReport(db: DB, reporter: string | DiscordReporter, body: FileBody, deps: FilingDeps): FileResult;
export const DISCORD_REPORT_GAP_MS = 10 * 60_000;
```

Existing callers pass a steamid string and `targetId`, and keep working unchanged.

The rules, in order:

1. Resolve the reporter: a string is a player. A `DiscordReporter` whose `discordId` is linked (`playerByDiscordId`) becomes that player. Otherwise it stays Discord.
2. Player reporter: `inGoodStanding` or 403 `'not an active player'` (unchanged). Discord reporter: `timedOutUntil` in the future, or `activeDiscordSanction` set, gives 403 `'you cannot file reports right now'`.
3. Resolve the target: `targetId` string is a player (404 if unknown, unchanged). Else `targetDiscord`: `bot` gives 400 `'you cannot report a bot'`; a linked `discordId` becomes that player; otherwise Discord, with `name` snapshotted. Neither gives 400 `'pick a player'`.
4. Self-report: same key, or a player reporter whose `discord_id` equals a Discord target's id, gives 400 `'you cannot report yourself'`.
5. Category and text checks, unchanged.
6. `matchId` or `moment` given when either side is Discord: 400 `'a match can only be attached between two players'`. Otherwise unchanged.
7. Per-day limit counted by reporter key. Discord reporter also: any report in the last `DISCORD_REPORT_GAP_MS` gives 429 `'wait a few minutes before filing another report'`.
8. Restricted: `unsafe`, or a player target with `hasStaffFlag`, or a Discord target with `administrator`.
9. Duplicates, by keys, same two rules as today.
10. Insert through `findOrOpen(db, target: Person, ...)`.

- [ ] **Step 1: Write the failing test** `tests/ticketFilingDiscord.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { fileReport, DISCORD_REPORT_GAP_MS, type DiscordReporter, type PickedTarget } from '../src/tickets/filing.js';

const P1 = '76561199000000501';
const LINKED = '76561199000000502';
const OWNER = '76561199000000503';
const deps = { adminSteamIds: [OWNER] };
let db: DB;
const lurker = (over: Partial<PickedTarget> = {}): PickedTarget => ({ discordId: '901', name: 'Lurky', bot: false, administrator: false, ...over });
const dReporter = (over: Partial<DiscordReporter> = {}): DiscordReporter => ({ kind: 'discord', discordId: '902', name: 'Newbie', timedOutUntil: null, ...over });

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [P1, LINKED, OWNER]) {
    upsertPlayer(db, { steamid: id, name: id.slice(-3), avatar: null }, []);
    activatePlayer(db, id);
  }
  db.prepare("UPDATE players SET discord_id = '700' WHERE steamid = ?").run(LINKED);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(OWNER);
});

const ticket = () => db.prepare('SELECT target_id, target_discord_id, target_name, restricted FROM tickets').get();

describe('fileReport with Discord people', () => {
  it('a player reports a Discord-only member', () => {
    expect(fileReport(db, P1, { targetDiscord: lurker(), category: 'toxicity', text: 'dms' }, deps)).toMatchObject({ ok: true, created: true, restricted: false });
    expect(ticket()).toEqual({ target_id: null, target_discord_id: '901', target_name: 'Lurky', restricted: 0 });
  });

  it('a picked member who has linked Steam is reported as the player', () => {
    fileReport(db, P1, { targetDiscord: lurker({ discordId: '700', name: 'whatever' }), category: 'afk', text: '' }, deps);
    expect(ticket()).toMatchObject({ target_id: LINKED, target_discord_id: null });
  });

  it('a Discord-only member files a report, stored under their Discord id', () => {
    expect(fileReport(db, dReporter(), { targetId: P1, category: 'toxicity', text: '' }, deps)).toMatchObject({ ok: true });
    expect(db.prepare('SELECT reporter_id, reporter_discord_id, reporter_name FROM ticket_reports').get())
      .toEqual({ reporter_id: null, reporter_discord_id: '902', reporter_name: 'Newbie' });
  });

  it('a Discord reporter who has linked Steam files as the player, standing checks and all', () => {
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(LINKED);
    expect(fileReport(db, dReporter({ discordId: '700' }), { targetId: P1, category: 'afk', text: '' }, deps)).toMatchObject({ ok: false, status: 403 });
  });

  it('refuses bots, yourself, and yourself through your own Discord account', () => {
    expect(fileReport(db, P1, { targetDiscord: lurker({ bot: true }), category: 'afk', text: '' }, deps)).toMatchObject({ ok: false, status: 400 });
    expect(fileReport(db, dReporter({ discordId: '901' }), { targetDiscord: lurker(), category: 'afk', text: '' }, deps)).toMatchObject({ ok: false, status: 400 });
    expect(fileReport(db, LINKED, { targetDiscord: lurker({ discordId: '700' }), category: 'afk', text: '' }, deps)).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses a timed-out or sanctioned Discord reporter', () => {
    const later = new Date(Date.now() + 60_000).toISOString();
    expect(fileReport(db, dReporter({ timedOutUntil: later }), { targetId: P1, category: 'afk', text: '' }, deps)).toMatchObject({ ok: false, status: 403 });
    db.prepare("INSERT INTO discord_sanctions (discord_id, kind, until, reason, created_by, created_at) VALUES ('902', 'ban', NULL, 'x', ?, 'x')").run(OWNER);
    expect(fileReport(db, dReporter(), { targetId: P1, category: 'afk', text: '' }, deps)).toMatchObject({ ok: false, status: 403 });
  });

  it('holds a Discord reporter to one report per ten minutes', () => {
    const now = new Date('2026-09-22T12:00:00Z');
    expect(fileReport(db, dReporter(), { targetId: P1, category: 'afk', text: '' }, { ...deps, now })).toMatchObject({ ok: true });
    expect(fileReport(db, dReporter(), { targetId: LINKED, category: 'afk', text: '' }, { ...deps, now: new Date(now.getTime() + 60_000) })).toMatchObject({ ok: false, status: 429 });
    expect(fileReport(db, dReporter(), { targetId: LINKED, category: 'afk', text: '' }, { ...deps, now: new Date(now.getTime() + DISCORD_REPORT_GAP_MS + 1) })).toMatchObject({ ok: true });
  });

  it('refuses a match when either side is Discord-only', () => {
    expect(fileReport(db, P1, { targetDiscord: lurker(), category: 'afk', text: '', matchId: 1 }, deps)).toMatchObject({ ok: false, status: 400 });
  });

  it('restricts a report about a Discord administrator, and an unsafe one', () => {
    expect(fileReport(db, P1, { targetDiscord: lurker({ administrator: true }), category: 'toxicity', text: '' }, deps)).toMatchObject({ ok: true, restricted: true });
    expect(fileReport(db, P1, { targetDiscord: lurker({ discordId: '903' }), category: 'unsafe', text: 'x' }, deps)).toMatchObject({ ok: true, restricted: true });
  });

  it('keeps one open case per Discord person, and the duplicate rule', () => {
    const a = fileReport(db, P1, { targetDiscord: lurker(), category: 'afk', text: '' }, deps);
    const b = fileReport(db, LINKED, { targetDiscord: lurker({ name: 'Renamed' }), category: 'afk', text: '' }, deps);
    expect((a as { ticketId: number }).ticketId).toBe((b as { ticketId: number }).ticketId);
    expect(fileReport(db, P1, { targetDiscord: lurker(), category: 'afk', text: '' }, deps)).toMatchObject({ ok: false, status: 409 });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/ticketFilingDiscord.test.ts`
Expected: FAIL (`DISCORD_REPORT_GAP_MS` is not exported).

- [ ] **Step 3: Rewrite `findOrOpen`**

```ts
function findOrOpen(
  db: DB, target: Person, restricted: boolean, openedBy: string | null, deps: FilingDeps,
): { id: number; created: boolean } {
  const now = deps.now ?? new Date();
  const key = personKey(target);
  // The same expression as tickets_one_open, so SQLite uses that index.
  const open = db.prepare(`SELECT id FROM tickets t WHERE ${TARGET_KEY_SQL} = ? AND restricted = ? AND status = 'open'`)
    .get(key, restricted ? 1 : 0) as { id: number } | undefined;
  if (open) return { id: open.id, created: false };
  const id = Number(db.prepare(
    'INSERT INTO tickets (target_id, target_discord_id, target_name, restricted, opened_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    target.kind === 'player' ? target.steamid : null,
    target.kind === 'discord' ? target.discordId : null,
    target.kind === 'discord' ? target.name.slice(0, 100) : '',
    restricted ? 1 : 0, openedBy, now.toISOString(),
  ).lastInsertRowid);
  if (restricted) seedAccess(db, id, key, deps.adminSteamIds, [], now);
  addTicketEvent(db, id, openedBy, 'opened', {}, now);
  return { id, created: true };
}
```

`openStaffTicket` calls it with `{ kind: 'player', steamid: targetId }`.

- [ ] **Step 4: Rewrite `fileReport`**

Keep every existing comment that still applies. The new body:

```ts
export const DISCORD_REPORT_GAP_MS = 10 * 60_000;

export interface DiscordReporter { kind: 'discord'; discordId: string; name: string; timedOutUntil: string | null }
/** A member picked in Discord, with the facts Discord supplied about them. */
export interface PickedTarget { discordId: string; name: string; bot: boolean; administrator: boolean }
export interface FileBody { targetId?: unknown; targetDiscord?: PickedTarget; category?: unknown; text?: unknown; matchId?: unknown; moment?: unknown }

type Reporter = { kind: 'player'; steamid: string } | DiscordReporter;

/** A Discord account that has linked Steam is that player, always: the
 *  surfaces pass what Discord gave them, and this is the one place that
 *  decides. */
function asReporter(db: DB, r: string | DiscordReporter): Reporter {
  if (typeof r === 'string') return { kind: 'player', steamid: r };
  const linked = playerByDiscordId(db, r.discordId);
  return linked ? { kind: 'player', steamid: linked.steamid } : r;
}

export function fileReport(db: DB, reporterIn: string | DiscordReporter, body: FileBody, deps: FilingDeps): FileResult {
  const now = deps.now ?? new Date();
  const reporter = asReporter(db, reporterIn);
  if (reporter.kind === 'player') {
    // (keep the existing inGoodStanding comment here)
    if (!inGoodStanding(db, reporter.steamid, now)) return fail(403, 'not an active player');
  } else {
    // The Discord-side equivalent of inGoodStanding: timed out in Discord
    // right now, or under a sanction the bot carried out (phase 3c).
    const timedOut = reporter.timedOutUntil !== null && Date.parse(reporter.timedOutUntil) > now.getTime();
    if (timedOut || activeDiscordSanction(db, reporter.discordId, now)) return fail(403, 'you cannot file reports right now');
  }

  let target: Person;
  if (typeof body.targetId === 'string' && body.targetId) {
    const p = getPlayer(db, body.targetId);
    if (!p) return fail(404, 'no such player');
    target = { kind: 'player', steamid: p.steamid };
  } else if (body.targetDiscord) {
    const d = body.targetDiscord;
    if (d.bot) return fail(400, 'you cannot report a bot');
    const linked = playerByDiscordId(db, d.discordId);
    target = linked ? { kind: 'player', steamid: linked.steamid } : { kind: 'discord', discordId: d.discordId, name: d.name };
  } else {
    return fail(400, 'pick a player');
  }

  const reporterKey = reporter.kind === 'player' ? reporter.steamid : `d:${reporter.discordId}`;
  const selfByDiscord = reporter.kind === 'player' && target.kind === 'discord'
    && getPlayer(db, reporter.steamid)?.discord_id === target.discordId;
  if (reporterKey === personKey(target) || selfByDiscord) return fail(400, 'you cannot report yourself');

  // (category, text and unsafe-needs-text checks: unchanged)

  const bothPlayers = reporter.kind === 'player' && target.kind === 'player';
  if (!bothPlayers && ((body.matchId !== undefined && body.matchId !== null) || (body.moment !== undefined && body.moment !== null))) {
    return fail(400, 'a match can only be attached between two players');
  }
  // (matchId and moment parsing: unchanged, using target.steamid; it only
  //  runs when bothPlayers, so narrow with `target.kind === 'player'`)

  const perDay = Number(getSetting(db, 'ticket_reports_per_day') ?? '5');
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const recent = (db.prepare(`SELECT COUNT(*) AS n FROM ticket_reports r WHERE ${REPORTER_KEY_SQL} = ? AND created_at > ? AND legacy_report_id IS NULL`)
    .get(reporterKey, since) as { n: number }).n;
  if (recent >= perDay) return fail(429, `you can file ${perDay} reports a day; try again tomorrow`);
  if (reporter.kind === 'discord') {
    const gapSince = new Date(now.getTime() - DISCORD_REPORT_GAP_MS).toISOString();
    if (db.prepare(`SELECT 1 FROM ticket_reports r WHERE ${REPORTER_KEY_SQL} = ? AND created_at > ?`).get(reporterKey, gapSince)) {
      return fail(429, 'wait a few minutes before filing another report');
    }
  }

  // (keep the existing restricted/duplicate comment)
  const restricted = category === 'unsafe'
    || (target.kind === 'player' ? hasStaffFlag(db, target.steamid) : body.targetDiscord!.administrator);
  const targetKey = personKey(target);
  const dupe = matchId !== null
    ? db.prepare(
      `SELECT 1 FROM ticket_reports r JOIN tickets t ON t.id = r.ticket_id
       WHERE ${REPORTER_KEY_SQL} = ? AND ${TARGET_KEY_SQL} = ? AND r.match_id = ? AND t.restricted = ?`)
      .get(reporterKey, targetKey, matchId, restricted ? 1 : 0)
    : db.prepare(
      `SELECT 1 FROM ticket_reports r JOIN tickets t ON t.id = r.ticket_id
       WHERE ${REPORTER_KEY_SQL} = ? AND ${TARGET_KEY_SQL} = ? AND r.match_id IS NULL AND t.status = 'open' AND t.restricted = ?`)
      .get(reporterKey, targetKey, restricted ? 1 : 0);
  if (dupe) return fail(409, matchId !== null ? 'you already reported this player for this match' : 'you already have an open report about this player');

  const result = db.transaction((): FileResult => {
    const ticket = findOrOpen(db, target, restricted, null, deps);
    const reportId = Number(db.prepare(
      `INSERT INTO ticket_reports (ticket_id, reporter_id, reporter_discord_id, reporter_name, category, text, match_id, map_ordinal, half, t_ms, created_at, feed_held)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ticket.id,
      reporter.kind === 'player' ? reporter.steamid : null,
      reporter.kind === 'discord' ? reporter.discordId : null,
      reporter.kind === 'discord' ? reporter.name.slice(0, 100) : '',
      category, text, matchId, moment?.ordinal ?? null, moment?.half ?? null, moment?.tMs ?? null,
      now.toISOString(), restricted ? 1 : 0,
    ).lastInsertRowid);
    if (!ticket.created) addTicketEvent(db, ticket.id, null, 'report_attached', { reportId }, now);
    return { ok: true, reportId, ticketId: ticket.id, created: ticket.created, restricted };
  })();
  if (result.ok) publishTicketSignal({ kind: 'ticket', ticketId: result.ticketId });
  return result;
}
```

Import `playerByDiscordId` from `../players.js`, `activeDiscordSanction` from `./discordSanctions.js`, and `Person`, `personKey`, `TARGET_KEY_SQL`, `REPORTER_KEY_SQL` from `./person.js`. A Discord name for `target_name` and `reporter_name` is capped at 100 characters as above.

Note on the restricted-by-administrator rule: once a picked administrator resolves to a linked player, `hasStaffFlag` decides instead. That is right: the ticket then has a player target and the site's staff flags are the authority.

- [ ] **Step 5: Run the new test, `tests/ticketFiling.test.ts`, the full suite and typecheck**

Expected: all pass. `tests/ticketFiling.test.ts` must pass unchanged: it is the proof the player path did not move.

- [ ] **Step 6: Commit**

```bash
git add src/tickets/filing.ts tests/ticketFilingDiscord.test.ts
git commit -m "File reports by and about Discord-only members"
```

---

### Task 4: Linking Steam folds a Discord person into the player

**Files:**
- Create: `src/tickets/adopt.ts`
- Modify: `src/players.ts` (`linkDiscord`), `src/routes/discordAuth.ts` (pass `adminSteamIds`)
- Test: `tests/ticketAdopt.test.ts` (create)

**Interfaces:**
- Consumes: `foldTicket`, `hasStaffFlag`, `restrictOpenTicketAbout`, `reseedOrphanedTickets` from `store.ts`.
- Produces: `adoptDiscordPerson(db: DB, discordId: string, steamid: string, adminSteamIds: string[], now?: Date): { moved: number }`. `linkDiscord`'s `opts` gains `adminSteamIds?: string[]`.

Runs inside `linkDiscord`'s transaction, so a link and its adoption commit together.

- [ ] **Step 1: Write the failing test** `tests/ticketAdopt.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { fileReport } from '../src/tickets/filing.js';

const P1 = '76561199000000601';
const NEWBIE = '76561199000000602';
const OWNER = '76561199000000603';
const deps = { adminSteamIds: [OWNER] };
const lurker = { discordId: '950', name: 'Lurky', bot: false, administrator: false };
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [P1, NEWBIE, OWNER]) {
    upsertPlayer(db, { steamid: id, name: id.slice(-3), avatar: null }, []);
    activatePlayer(db, id);
  }
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(OWNER);
});

describe('adoptDiscordPerson through linkDiscord', () => {
  it('moves tickets about them and reports by them onto the player', () => {
    fileReport(db, P1, { targetDiscord: lurker, category: 'toxicity', text: '' }, deps);
    fileReport(db, { kind: 'discord', discordId: '950', name: 'Lurky', timedOutUntil: null }, { targetId: OWNER, category: 'afk', text: '' }, deps);
    expect(linkDiscord(db, NEWBIE, '950', 'Lurky', { adminSteamIds: [OWNER] })).toMatchObject({ ok: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE target_discord_id IS NOT NULL').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT target_id FROM tickets WHERE target_id = ?').get(NEWBIE)).toEqual({ target_id: NEWBIE });
    expect(db.prepare('SELECT reporter_id FROM ticket_reports WHERE reporter_discord_id IS NULL AND reporter_id = ?').get(NEWBIE)).toEqual({ reporter_id: NEWBIE });
  });

  it('folds two open cases into one when the player already had one', () => {
    fileReport(db, P1, { targetDiscord: lurker, category: 'toxicity', text: '' }, deps);
    fileReport(db, OWNER, { targetId: NEWBIE, category: 'afk', text: '' }, deps);
    linkDiscord(db, NEWBIE, '950', 'Lurky', { adminSteamIds: [OWNER] });
    const open = db.prepare("SELECT id FROM tickets WHERE status = 'open'").all();
    expect(open).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_reports').get()).toEqual({ n: 2 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('restricts the adopted case when the player is staff', () => {
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(NEWBIE);
    fileReport(db, P1, { targetDiscord: lurker, category: 'toxicity', text: '' }, deps);
    linkDiscord(db, NEWBIE, '950', 'Lurky', { adminSteamIds: [OWNER] });
    expect(db.prepare('SELECT restricted FROM tickets').get()).toEqual({ restricted: 1 });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/ticketAdopt.test.ts`
Expected: FAIL (`target_discord_id` still set after linking).

- [ ] **Step 3: Write `src/tickets/adopt.ts`**

```ts
import type { DB } from '../db.js';
import { foldTicket, hasStaffFlag, reseedOrphanedTickets, restrictOpenTicketAbout } from './store.js';

/**
 * Someone who was only in the Discord has linked Steam: everything recorded
 * under their Discord id becomes the player's, the way mergePlayers moves an
 * alt onto a main. Runs inside the caller's transaction.
 *
 * discord_sanctions rows stay keyed by Discord id on purpose: Discord acts on
 * that id, and lifting a timeout later has to name it.
 */
export function adoptDiscordPerson(
  db: DB, discordId: string, steamid: string, adminSteamIds: string[], now = new Date(),
): { moved: number } {
  // tickets_one_open allows one open case per person per flavour. Where both
  // identities have one, the Discord one folds into the player's.
  for (const restricted of [0, 1]) {
    const gone = db.prepare("SELECT id FROM tickets WHERE target_discord_id = ? AND restricted = ? AND status = 'open'")
      .get(discordId, restricted) as { id: number } | undefined;
    const keep = db.prepare("SELECT id FROM tickets WHERE target_id = ? AND restricted = ? AND status = 'open'")
      .get(steamid, restricted) as { id: number } | undefined;
    if (gone && keep) foldTicket(db, gone.id, keep.id, 'merge', now);
  }
  const moved = db.prepare('UPDATE tickets SET target_id = ?, target_discord_id = NULL WHERE target_discord_id = ?').run(steamid, discordId).changes;
  db.prepare("UPDATE ticket_reports SET reporter_id = ?, reporter_discord_id = NULL, reporter_name = '' WHERE reporter_discord_id = ?").run(steamid, discordId);
  db.prepare('UPDATE pending_reports SET reporter_id = ?, reporter_discord_id = NULL WHERE reporter_discord_id = ?').run(steamid, discordId);
  db.prepare('UPDATE ticket_threads SET reporter_id = ?, reporter_discord_id = NULL WHERE reporter_discord_id = ?').run(steamid, discordId);
  if (hasStaffFlag(db, steamid)) restrictOpenTicketAbout(db, steamid, adminSteamIds, now);
  // The accused never sits on a list of a case about themselves.
  db.prepare('DELETE FROM ticket_access WHERE steamid = ? AND ticket_id IN (SELECT id FROM tickets WHERE target_id = ?)').run(steamid, steamid);
  reseedOrphanedTickets(db, adminSteamIds, [], now);
  return { moved };
}
```

`target_name` is left as it was: readers prefer the player's name once `target_id` is set, and the snapshot is harmless history.

- [ ] **Step 4: Call it from `linkDiscord`** in `src/players.ts`

Add `adminSteamIds?: string[]` to `opts`, and inside the existing `db.transaction(() => { ... })`, after the history row is written:

```ts
    // Reports about or by this Discord account from before they linked.
    adoptDiscordPerson(db, discordId, steamid, opts.adminSteamIds ?? [], now);
```

with `import { adoptDiscordPerson } from './tickets/adopt.js';`. Check for an import cycle: `adopt.ts` imports `store.ts`, which imports only `db.js`. If `players.ts` is imported by `store.ts` directly or indirectly, move the call into the two `discordAuth.ts` call sites instead and say so in your report.

In `src/routes/discordAuth.ts`, both `linkDiscord(...)` calls pass `{ adminSteamIds: config.adminSteamIds }` (merge with any opts already passed).

- [ ] **Step 5: Run the new test, `tests/discordLink.test.ts`, `tests/discordLinkHistory.test.ts`, the full suite and typecheck**

- [ ] **Step 6: Commit**

```bash
git add src/tickets/adopt.ts src/players.ts src/routes/discordAuth.ts tests/ticketAdopt.test.ts
git commit -m "Give a Discord member's reports to their player when they link Steam"
```

---

### Task 5: Discord gives the handler who was picked

**Files:**
- Modify: `src/discord/transport.ts`, `src/discord/djsTransport.ts`
- Test: `tests/djsTransportModal.test.ts` (create, only if `toModal` can be exported for testing; see Step 3)

**Interfaces:**
- Produces, in `transport.ts`:

```ts
/** A member as Discord's interaction payload described them. Read from the
 *  interaction itself, never fetched, so handlers stay synchronous. */
export interface PickedMember { id: string; name: string; bot: boolean; administrator: boolean }

export type ModalField =
  | { kind: 'text'; ... }            // unchanged
  | { kind: 'select'; ... }          // unchanged
  | { kind: 'user'; id: string; label: string; required?: boolean };
```

`BotInteraction` `command` and `modal` variants gain `picked: Record<string, PickedMember>` (keyed by option name or field id; empty when nothing was picked) and `presserTimedOutUntil: string | null`. A modal's `fields[id]` for a `user` field is the picked id, or `''`.

This is the only task that touches `djsTransport.ts`. None of it can be proven against the fake; it is on the live checklist.

- [ ] **Step 1: Types in `transport.ts`**

Add `PickedMember` and the `user` variant as above. In `BotInteraction`:

```ts
  | {
      kind: 'command';
      name: string;
      userId: string;
      userName: string;
      /** String options by name. A user option carries the user id. */
      options: Record<string, string>;
      /** Each user option's member, by option name. */
      picked: Record<string, PickedMember>;
      /** When the presser's Discord timeout ends, or null. */
      presserTimedOutUntil: string | null;
    }
  | { kind: 'modal'; customId: string; userId: string; userName: string; fields: Record<string, string>; picked: Record<string, PickedMember>; presserTimedOutUntil: string | null }
```

Run `npm run typecheck`. Every test and fake that builds a `command` or `modal` interaction now fails to compile. Fix each by adding `picked: {}, presserTimedOutUntil: null` (a test helper per file is fine). Do this before touching discord.js, so the compile errors are only about the new fields.

- [ ] **Step 2: `djsTransport.ts`, the modal**

In `toModal`, a third branch:

```ts
        : f.kind === 'user'
          ? { type: ComponentType.UserSelect, custom_id: f.id, required: f.required ?? false, min_values: f.required ? 1 : 0, max_values: 1 }
          : { /* the text input branch, unchanged */ }
```

Order the ternary so `select`, `user`, then text. Check `UserSelectMenuComponentData` at `node_modules/discord.js/typings/index.d.ts:7488` for the exact field names the Label accepts, and cite the line in a comment the way the existing code does.

Two helpers near `toModal`:

```ts
/** Administrator, from either a cached GuildMember or the raw resolved member
 *  an interaction carries (whose permissions are a bitfield string). */
function isAdministrator(m: unknown): boolean {
  const perms = (m as { permissions?: unknown } | null)?.permissions;
  if (perms instanceof PermissionsBitField) return perms.has(PermissionFlagsBits.Administrator);
  if (typeof perms === 'string') return (BigInt(perms) & PermissionFlagsBits.Administrator) !== 0n;
  return false;
}

/** When a member's timeout ends, from either shape, or null. */
function timedOutUntil(m: unknown): string | null {
  const g = m as { communicationDisabledUntil?: Date | null; communication_disabled_until?: string | null } | null;
  const v = g?.communicationDisabledUntil ?? g?.communication_disabled_until ?? null;
  return v === null ? null : new Date(v).toISOString();
}

function picked(user: User, member: unknown): PickedMember {
  const nick = (member as { displayName?: string; nick?: string | null } | null);
  return {
    id: user.id,
    name: nick?.displayName ?? nick?.nick ?? user.globalName ?? user.username,
    bot: user.bot,
    administrator: isAdministrator(member),
  };
}
```

Import `PermissionsBitField`, `PermissionFlagsBits`, `type User` from discord.js if not already imported.

In the modal-submit branch:

```ts
        const fields: Record<string, string> = {};
        const pickedMembers: Record<string, PickedMember> = {};
        for (const [id, f] of i.fields.fields) {
          if (f.type === ComponentType.UserSelect) {
            // getSelectedUsers :2947, getSelectedMembers :2949.
            const user = i.fields.getSelectedUsers(id)?.first();
            fields[id] = user?.id ?? '';
            if (user) pickedMembers[id] = picked(user, i.fields.getSelectedMembers(id)?.get(user.id) ?? null);
            continue;
          }
          fields[id] = f.type === ComponentType.TextInput ? f.value
            : f.type === ComponentType.StringSelect ? (i.fields.getStringSelectValues(id)[0] ?? '') : '';
        }
        const reply = await handler({
          kind: 'modal', customId: i.customId, userId: i.user.id, userName: i.user.globalName ?? i.user.username,
          fields, picked: pickedMembers, presserTimedOutUntil: timedOutUntil(i.member),
        });
```

- [ ] **Step 3: `djsTransport.ts`, the slash command**

```ts
        const options: Record<string, string> = {};
        const pickedMembers: Record<string, PickedMember> = {};
        for (const o of i.options.data) {
          if (o.value !== undefined) options[o.name] = String(o.value);
          // CommandInteractionOption.user / .member :6291.
          if (o.user) pickedMembers[o.name] = picked(o.user, o.member ?? null);
        }
        const interaction: BotInteraction = {
          kind: 'command', name: i.commandName, userId: i.user.id, userName: i.user.globalName ?? i.user.username,
          options, picked: pickedMembers, presserTimedOutUntil: timedOutUntil(i.member),
        };
```

If `toModal` is not exported, do not export it only for a test: the fake cannot prove any of this anyway. Skip the test file; the typecheck against discord.js's typings is the check here.

- [ ] **Step 4: Full suite and typecheck**

Run: `npx vitest run`, `npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A src tests
git commit -m "Carry the picked member and the presser's timeout on Discord interactions"
```

---

### Task 6: The Report a player form takes a Discord member

**Files:**
- Modify: `src/discord/reportButton.ts`
- Test: `tests/reportButton.test.ts` (add cases; update existing modal field expectations)

**Interfaces:**
- Consumes: `fileReport`, `DiscordReporter`, `PickedTarget` (Task 3); `PickedMember`, `picked`, `presserTimedOutUntil` (Task 5).
- Produces: `reportModal(db, reporter: string | null)` (null for a Discord-only reporter: the dropdown holds only the sentinel). The modal now has five fields in this order: `who` (select), `member` (user, not required), `name` (text), `reason` (select), `details` (text).

Resolution in `handleReportModal`, per the spec:

1. `who` set to anything but `OTHER`: that player.
2. Else `member` picked: `targetDiscord` from `i.picked.member`.
3. Else typed `name`: today's path.
4. If `who` is a player and `member` is also picked and they are not the same person (the member is not that player's linked Discord), refuse: `You picked two different people. Pick one and send the form again.` followed by the reporter's details in a quote block, so nothing typed is lost.

Discord-only reporters: `handleReportButton` no longer answers `LINK_FIRST` for `rp:open`; it opens the form with `reportModal(db, null)`. The pick buttons (`rp:pick:`) scope the draft by `reporter_id` or `reporter_discord_id`.

- [ ] **Step 1: Write the failing tests** (add to `tests/reportButton.test.ts`, reusing its `seedPlayers`, `seedMatch`, IDS)

```ts
const modal = (fields: Record<string, string>, picked: Record<string, PickedMember> = {}, userId = 'd-me') => ({
  kind: 'modal' as const, customId: 'rp:new', userId, userName: 'someone', fields, picked, presserTimedOutUntil: null,
});
const lurkerPick: PickedMember = { id: '990', name: 'Lurky', bot: false, administrator: false };

describe('Discord members on the form', () => {
  beforeEach(() => {
    seedPlayers(db);
    db.prepare("UPDATE players SET discord_id = 'd-me' WHERE steamid = ?").run(ME);
  });

  it('the form has a member picker between the dropdown and the name box', () => {
    expect(reportModal(db, ME).fields.map((f) => [f.id, f.kind])).toEqual([
      ['who', 'select'], ['member', 'user'], ['name', 'text'], ['reason', 'select'], ['details', 'text'],
    ]);
  });

  it('a picked Discord-only member is reported by Discord id', async () => {
    const r = await handleReportModal({ db, adminSteamIds: [] }, modal({ who: OTHER, member: '990', name: '', reason: 'toxicity', details: 'dms' }, { member: lurkerPick }));
    expect(r.payload.content).toMatch(/^Thanks/);
    expect(db.prepare('SELECT target_discord_id, target_name FROM tickets').get()).toEqual({ target_discord_id: '990', target_name: 'Lurky' });
  });

  it('the dropdown wins over an empty picker, and two different people are refused with the details kept', async () => {
    const r = await handleReportModal({ db, adminSteamIds: [] }, modal({ who: ALICE, member: '990', name: '', reason: 'toxicity', details: 'my words' }, { member: lurkerPick }));
    expect(r.payload.content).toMatch(/two different people/);
    expect(r.payload.content).toContain('my words');
    expect(db.prepare('SELECT COUNT(*) AS n FROM tickets').get()).toEqual({ n: 0 });
  });

  it('a Discord-only reporter can open the form and file', async () => {
    const open = await handleReportButton({ db, adminSteamIds: [] }, { kind: 'button', customId: 'rp:open', userId: 'd-new', userName: 'new' });
    expect(open.modal?.fields.find((f) => f.id === 'who')).toMatchObject({ options: [{ value: OTHER }] });
    const r = await handleReportModal({ db, adminSteamIds: [] }, modal({ who: OTHER, member: '990', name: '', reason: 'toxicity', details: '' }, { member: lurkerPick }, 'd-new'));
    expect(r.payload.content).toMatch(/^Thanks/);
    expect(db.prepare('SELECT reporter_discord_id FROM ticket_reports').get()).toEqual({ reporter_discord_id: 'd-new' });
  });

  it('a Discord-only reporter who types an ambiguous name gets a draft of their own', async () => {
    const r = await handleReportModal({ db, adminSteamIds: [] }, modal({ who: OTHER, member: '', name: 'bob', reason: 'afk', details: '' }, {}, 'd-new'));
    expect(r.payload.content).toMatch(/More than one player/);
    expect(db.prepare('SELECT reporter_id, reporter_discord_id FROM pending_reports').get()).toEqual({ reporter_id: null, reporter_discord_id: 'd-new' });
    const pick = r.payload.components[0][0] as { customId: string };
    // Someone else pressing it gets the expired answer.
    const other = await handleReportButton({ db, adminSteamIds: [] }, { kind: 'button', customId: pick.customId, userId: 'd-else', userName: 'x' });
    expect(other.payload.content).toMatch(/expired/);
    const mine = await handleReportButton({ db, adminSteamIds: [] }, { kind: 'button', customId: pick.customId, userId: 'd-new', userName: 'new' });
    expect(mine.payload.content).toMatch(/^Thanks/);
  });
});
```

Existing tests that asserted four modal fields, or that `rp:open` from an unlinked user answers "Link your Steam account first", describe behaviour this task changes on purpose: update them and say which ones in your report.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/reportButton.test.ts`

- [ ] **Step 3: Implement**

`reportModal(db: DB, reporter: string | null)`:

```ts
      {
        kind: 'select',
        id: 'who',
        label: 'Someone you played with?',
        options: [
          { label: 'Someone else (pick or type them below)', value: OTHER },
          ...(reporter ? recentCoPlayers(db, reporter) : []).map((c) => ({ label: clip(c.name), value: c.steamid })),
        ],
      },
      { kind: 'user', id: 'member', label: 'Or pick them from the Discord', required: false },
      { kind: 'text', id: 'name', label: 'Or type their in-game name', style: 'short', required: false, maxLength: 100 },
```

(labels at most 45 characters; `toModal` slices, but keep them short so nothing is cut.)

A reporter helper in the module:

```ts
type Me = { kind: 'player'; steamid: string } | DiscordReporter;
function whoIsPressing(db: DB, i: { userId: string; userName: string; presserTimedOutUntil?: string | null }): Me {
  const p = playerByDiscordId(db, i.userId);
  return p ? { kind: 'player', steamid: p.steamid }
    : { kind: 'discord', discordId: i.userId, name: i.userName, timedOutUntil: i.presserTimedOutUntil ?? null };
}
```

`handleReportButton`: drop the `LINK_FIRST` early return. For `rp:open`, `const me = whoIsPressing(...)` and `reportModal(deps.db, me.kind === 'player' ? me.steamid : null)`. For `rp:pick:`, scope the draft with `WHERE id = ? AND (reporter_id IS ? AND reporter_discord_id IS ?)` passing `(me.kind === 'player' ? me.steamid : null, me.kind === 'discord' ? me.discordId : null)`, and file with `me` as the reporter (a button carries no timeout: pass `timedOutUntil: null`; `fileReport` still checks sanctions).

`handleReportModal`:

```ts
  const me = whoIsPressing(deps.db, i);
  const category = i.fields.reason ?? '';
  const text = (i.fields.details ?? '').trim();
  const picked = i.fields.who ?? OTHER;
  const member = i.picked?.member;

  if (picked !== OTHER && member) {
    const memberPlayer = playerByDiscordId(deps.db, member.id);
    if (memberPlayer?.steamid !== picked) {
      return say(`You picked two different people. Pick one and send the form again.${text ? `\n\nWhat you wrote:\n> ${text.replace(/\n/g, '\n> ')}` : ''}`);
    }
  }
  if (picked !== OTHER) return file(deps, me, { targetId: picked }, category, text).reply;
  if (member) {
    return file(deps, me, { targetDiscord: { discordId: member.id, name: member.name, bot: member.bot, administrator: member.administrator } }, category, text).reply;
  }
  // typed name: unchanged, with `me` in place of me.steamid
```

`file(deps, reporter: Me, target: { targetId: string } | { targetDiscord: PickedTarget }, category, text)`: the match is looked up only when both are players:

```ts
  const matchId = reporter.kind === 'player' && 'targetId' in target
    ? latestSharedMatch(deps.db, reporter.steamid, target.targetId) : null;
  const r = fileReport(deps.db, reporter.kind === 'player' ? reporter.steamid : reporter, { ...target, category, text, matchId }, { ... });
```

`hold(...)`: `DELETE FROM pending_reports WHERE reporter_id IS ? AND reporter_discord_id IS ?` and insert both columns, as in `rp:pick:`.

The name collision message stays as is. `LINK_FIRST` becomes unused; delete it.

- [ ] **Step 4: Run the test file, the full suite and typecheck**

- [ ] **Step 5: Commit**

```bash
git add src/discord/reportButton.ts tests/reportButton.test.ts
git commit -m "Let the report form pick a Discord member and take reports from anyone in the server"
```

---

### Task 7: `/report` for Discord-only people, and its copy

`/report` already has a `player` option of type `user` (a Discord member picker). It refuses members who have not linked. That refusal goes, and so does the one for unlinked reporters.

**Files:**
- Modify: `src/discord/commands.ts`
- Test: the existing `/report` tests (find them with `grep -rln "name: 'report'" tests`), plus new cases in the same file

**Interfaces:**
- Consumes: `fileReport`, `PickedMember` (`i.picked.player`), `presserTimedOutUntil`.

Rules:

- Reporter: a linked player goes through `resolve()` as today (standing and all). An unlinked presser becomes a `DiscordReporter`: `{ kind: 'discord', discordId: i.userId, name: i.userName, timedOutUntil: i.presserTimedOutUntil }`. `resolve()` answers an unlinked presser with the link prompt, so call `playerByDiscordId` first and only run `resolve()` for a linked one.
- Target: `i.picked.player` goes to `fileReport` as `targetDiscord`. `fileReport` turns a linked member into the player. The old "That player has not linked Discord" reply goes.
- `match` option: only when both are players, as today. If a Discord-only person is involved and `match` was given, `fileReport` refuses with its own message.
- Success copy: `Reported <name><about>. Thanks, the moderators will look at it. The person you reported is never told who filed it.` This fixes the pronoun problem where "they" bound to the moderators, and matches the button's wording.

- [ ] **Step 1: Write the failing tests**

```ts
  it('reports a Discord-only member picked in the player option', async () => {
    const r = await handleCommand(deps, { kind: 'command', name: 'report', userId: LINKED_DISCORD, userName: 'x',
      options: { player: '990', reason: 'toxicity' }, picked: { player: { id: '990', name: 'Lurky', bot: false, administrator: false } }, presserTimedOutUntil: null });
    expect(r.payload.content).toMatch(/^Reported Lurky/);
    expect(r.payload.content).toContain('The person you reported is never told who filed it.');
  });

  it('takes a report from someone who has not linked Steam', async () => {
    const r = await handleCommand(deps, { kind: 'command', name: 'report', userId: 'd-new', userName: 'new',
      options: { player: TARGET_DISCORD, reason: 'afk' }, picked: { player: { id: TARGET_DISCORD, name: 't', bot: false, administrator: false } }, presserTimedOutUntil: null });
    expect(r.payload.content).toMatch(/^Reported/);
  });
```

Adapt `deps`, `LINKED_DISCORD` and `TARGET_DISCORD` to the fixtures the existing `/report` tests use. Existing tests asserting "has not linked Discord" or "They will not be told who reported them" describe behaviour this task changes on purpose: update them and list them in your report.

- [ ] **Step 2: Run to see them fail**

- [ ] **Step 3: Implement** in `report()`:

```ts
function report(deps: CommandDeps, i: Cmd): InteractionReply {
  // A linked presser goes through the same door as the buttons (standing,
  // bans, merges). Someone only in the Discord files as themselves; fileReport
  // holds them to the Discord-side rules.
  const linked = playerByDiscordId(deps.db, i.userId);
  let reporter: string | DiscordReporter;
  if (linked) {
    const who = resolve(deps, i);
    if ('reply' in who) return who.reply;
    reporter = who.player.steamid;
  } else {
    reporter = { kind: 'discord', discordId: i.userId, name: i.userName, timedOutUntil: i.presserTimedOutUntil };
  }
  const pick = i.picked.player;
  if (!pick) return priv({ content: 'Pick the person you are reporting.' });
  const targetPlayer = playerByDiscordId(deps.db, pick.id);

  // A match is optional, and only exists between two players.
  const matchId: number | null = i.options.match
    ? Number(i.options.match)
    : typeof reporter === 'string' && targetPlayer ? latestSharedMatch(deps.db, reporter, targetPlayer.steamid) : null;
  const r = fileReport(deps.db, reporter, {
    targetDiscord: { discordId: pick.id, name: pick.name, bot: pick.bot, administrator: pick.administrator },
    category: i.options.reason, text: i.options.details ?? '', matchId,
  }, { adminSteamIds: deps.adminSteamIds ?? [] });
  if (!r.ok) return priv({ content: `Could not file the report: ${r.error}.` });
  const about = matchId === null ? '' : ` for match #${matchId}`;
  const name = targetPlayer ? idOf(targetPlayer) : pick.name;
  return priv({ content: `Reported ${plainLabelEscaped(name)}${about}. Thanks, the moderators will look at it. The person you reported is never told who filed it.` });
}
```

Check what `idOf` and `plainLabelEscaped` take (they are in this file or `presenter.ts`); pass what they expect. Update the command's `description` if it says "player" only: `'Privately report someone, in a game or in the Discord'` (at most 100 characters).

- [ ] **Step 4: Run the command tests, the full suite and typecheck**

- [ ] **Step 5: Commit**

```bash
git add src/discord/commands.ts tests
git commit -m "Let /report name anyone in the Discord and be used before linking Steam"
```

---

## After the last task

- [ ] Dry-run the rebuild against a production backup with the recipe in the tickets memory: `gunzip -c ~/l4d/backups/pug/pug-<latest>.db.gz > <scratch>/pug.db`, a throwaway `.mts` script INSIDE the repo that snapshots `sqlite_master` and per-table counts, calls the real `openDb`, snapshots again. Expect: `tickets`, `ticket_reports`, `pending_reports` rebuilt with identical counts; `discord_sanctions` added; `ticket_threads` gains one column; `integrity_check` ok; `foreign_key_check` empty; a second open changes nothing. Never boot the real server against the copy (its `servers` table dials the live boxes).
- [ ] Live checklist for the owner (the fake cannot prove these): the member picker renders in the Report a player form and submits; `/report` with an unlinked member; a picked member's display name is right; an Administrator member lands on a restricted ticket; a timed-out Discord-only member is refused.
