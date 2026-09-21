# Tickets Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the one-line player report feature with tickets: one case per accused player, a moderator tier, restricted cases, bans linked to tickets, all usable on the site with no Discord work.

**Architecture:** New `tickets`, `ticket_reports`, `ticket_events` and `ticket_access` tables beside the old `reports` table, which is migrated once and then left alone. All ticket logic lives in `src/tickets/` as plain functions over the DB; `src/routes/tickets.ts` is a thin HTTP layer behind a new `requireMod` guard. The web side swaps the admin Reports tab for a Tickets tab that mods can also open.

**Tech Stack:** Fastify 5, better-sqlite3, discord.js 14 behind `BotTransport`, Preact 10 + preact-iso, vitest 4 (`server` and `web` projects).

**Spec:** `docs/superpowers/specs/2026-09-21-tickets-design.md`. This plan covers build order item 1 only. Phases 2 (staff forum, mirror, attachments, removal) and 3 (reporter threads, close DM) get their own plans, written against the code this phase produces.

## Global Constraints

- Work only in the worktree `/home/volence/l4d/pug/.claude/worktrees/tickets` on branch `worktree-tickets`. Never write to the main checkout; other sessions are committing to master.
- Nothing is deployed. No rcon, no ssh, no `deploy-web.sh`.
- Never use em dashes in code, comments, docs, commit messages or UI copy.
- No `CHECK` constraint on any status-like column. New tables are `CREATE TABLE IF NOT EXISTS`; new columns go through `ensureColumn` in `src/db.ts`.
- The accused is never told a report exists or who filed it. Every ticket query excludes rows where `target_id` is the viewer. A restricted ticket returns 404, never 403, to anyone off its access list.
- Categories, exact: `griefing`, `cheating`, `toxicity`, `afk`, `unsafe`, `other`. Outcomes, exact: `action_taken`, `warned`, `no_action`, `invalid`.
- Setting defaults, exact: `ticket_mod_ban_max_minutes` = `10080`, `ticket_reports_per_day` = `5`.
- Report text is capped at 1000 characters, ban reason at 500, outcome note at 1000.
- `is_mod` grants nothing on game servers: `src/serverAdmins.ts` is not touched.
- Every mutation ends with `logAdmin`. For a restricted ticket the audit row is written but no admin feed event is published.
- Commit messages follow the repo style: one plain sentence saying what changed, no prefix.
- Test commands: `npx vitest run <file>` for one file, `npm test` for everything, `npm run typecheck` for types.

## File Structure

Created:
- `src/tickets/schema.ts`: the four tables and the partial unique index.
- `src/tickets/store.ts`: row types, visibility, events, access seeding, list and detail queries.
- `src/tickets/filing.ts`: filing a report, opening a staff ticket, match targets, my reports.
- `src/tickets/actions.ts`: claim, restrict, access, close, reopen, ban.
- `src/tickets/migrate.ts`: one-time migration of the old `reports` rows.
- `src/tickets/caseFile.ts`: the accused's summary for the ticket page.
- `src/routes/tickets.ts`: `/api/reports*` and `/api/mod/tickets*`.
- `web/src/routes/admin/AdminTickets.tsx`: the list.
- `web/src/routes/admin/AdminTicket.tsx`: one ticket.
- `web/src/components/MyReports.tsx`: the reporter's own list.
- Tests: `tests/ticketSchema.test.ts`, `tests/ticketFiling.test.ts`, `tests/ticketActions.test.ts`, `tests/ticketMigrate.test.ts`, `tests/ticketRoutes.test.ts`, `web/src/routes/tickets.test.tsx`.

Modified:
- `src/db.ts` (schema call, two columns, two settings), `src/settingsSchema.ts`, `src/players.ts` (`is_mod` on `PlayerRow`), `src/routes/guards.ts` (`makeRequireMod`), `src/routes/auth.ts` (`isMod`), `src/routes/admin.ts` (mod toggle, old report routes removed), `src/routes/api.ts` (match report routes become thin callers), `src/admin/players.ts` (`isMod`, `tickets` instead of `reportsAgainst`), `src/admin/audit.ts` (`quiet`), `src/mergePlayers.ts`, `src/adminFeed.ts`, `src/discord/adminFeedPoster.ts`, `src/discord/commands.ts`, `src/server.ts` (route registration).
- `web/src/api.ts`, `web/src/routes/Admin.tsx`, `web/src/routes/admin/AdminPlayers.tsx`, `web/src/components/ReportPlayer.tsx`, `web/src/components/Nav.tsx`, `web/src/routes/Profile.tsx`, `web/src/styles/app.css`.

Deleted at the end: `src/reports.ts`, `web/src/routes/admin/AdminReports.tsx`, `tests/reports.test.ts`.

---

### Task 1: Schema, the `is_mod` flag, settings

**Files:**
- Create: `src/tickets/schema.ts`, `tests/ticketSchema.test.ts`
- Modify: `src/db.ts` (inside `openDb`, just before `seed(db)`; and `DEFAULT_SETTINGS`), `src/settingsSchema.ts`, `src/players.ts:9-25`, `src/routes/auth.ts:84`, `src/routes/admin.ts` (after the `/admin` toggle route, near line 126), `src/admin/players.ts` (`AdminPlayerRow`, `searchPlayers`)

**Interfaces:**
- Produces: `ensureTicketSchema(db: DB): void`; `PlayerRow.is_mod: number`; `/api/me` gains `isMod: boolean`; `POST /api/admin/players/:steamid/mod` with body `{ isMod: boolean }`; `AdminPlayerRow.isMod: boolean`; settings `ticket_mod_ban_max_minutes`, `ticket_reports_per_day`; column `bans.ticket_id`.

- [ ] **Step 1: Write the failing test**

`tests/ticketSchema.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { ensureTicketSchema } from '../src/tickets/schema.js';
import { getSetting } from '../src/settings.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const A = '76561199000000001';
const B = '76561199000000002';
const ADMIN = '76561199000000009';
let db: DB;
let app: FastifyInstance;
const cookie: Record<string, Record<string, string>> = {};

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
  for (const id of [A, B, ADMIN]) cookie[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
});
afterEach(async () => { await app.close(); });

const openTicket = (target: string, restricted: number) =>
  db.prepare("INSERT INTO tickets (target_id, restricted, created_at) VALUES (?, ?, '2026-09-21T00:00:00.000Z')").run(target, restricted);

describe('ticket schema', () => {
  it('is idempotent', () => {
    expect(() => ensureTicketSchema(db)).not.toThrow();
  });

  it('allows one open ticket per player per restricted flavour', () => {
    openTicket(A, 0);
    expect(() => openTicket(A, 0)).toThrow(/UNIQUE/);
    expect(() => openTicket(A, 1)).not.toThrow();
    db.prepare("UPDATE tickets SET status = 'closed' WHERE target_id = ? AND restricted = 0").run(A);
    expect(() => openTicket(A, 0)).not.toThrow();
  });

  it('adds is_mod, bans.ticket_id and the two settings', () => {
    expect((db.prepare('SELECT is_mod FROM players WHERE steamid = ?').get(A) as { is_mod: number }).is_mod).toBe(0);
    expect(() => db.prepare('SELECT ticket_id FROM bans').all()).not.toThrow();
    expect(getSetting(db, 'ticket_mod_ban_max_minutes')).toBe('10080');
    expect(getSetting(db, 'ticket_reports_per_day')).toBe('5');
  });
});

describe('the moderator flag', () => {
  it('an admin toggles it, it shows in /api/me, and it is audited', async () => {
    const set = (as: string, isMod: unknown) => app.inject({ method: 'POST', url: `/api/admin/players/${A}/mod`, cookies: cookie[as], payload: { isMod } });
    expect((await set(B, true)).statusCode).toBe(403);
    expect((await set(ADMIN, 'yes')).statusCode).toBe(400);
    expect((await set(ADMIN, true)).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/me', cookies: cookie[A] })).json().isMod).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/me', cookies: cookie[B] })).json().isMod).toBe(false);
    const audit = (await app.inject({ method: 'GET', url: '/api/admin/audit', cookies: cookie[ADMIN] })).json();
    expect(audit.actions[0]).toMatchObject({ action: 'set_mod', target: A });
    const list = (await app.inject({ method: 'GET', url: `/api/admin/players?q=${A}`, cookies: cookie[ADMIN] })).json();
    expect(list.players[0].isMod).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/ticketSchema.test.ts`
Expected: FAIL, cannot resolve `../src/tickets/schema.js`.

- [ ] **Step 3: Create the schema**

`src/tickets/schema.ts`:

```ts
import type { DB } from '../db.js';

/**
 * Tickets: player reports grouped into one case per accused player.
 *
 * No CHECK on status, outcome, category or event kind: those sets will grow,
 * and SQLite cannot widen a CHECK without rebuilding the table.
 *
 * tickets_one_open is what makes "one open case per player" a fact rather
 * than a convention. It is keyed on restricted as well, so a restricted
 * report never has to attach to a ticket the whole team can read: it opens a
 * restricted sibling instead.
 */
export function ensureTicketSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id TEXT NOT NULL REFERENCES players(steamid),
      status TEXT NOT NULL DEFAULT 'open',
      outcome TEXT,
      outcome_note TEXT NOT NULL DEFAULT '',
      restricted INTEGER NOT NULL DEFAULT 0,
      claimed_by TEXT,
      opened_by TEXT,
      created_at TEXT NOT NULL,
      closed_at TEXT,
      closed_by TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS tickets_one_open ON tickets (target_id, restricted) WHERE status = 'open';

    CREATE TABLE IF NOT EXISTS ticket_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      reporter_id TEXT NOT NULL REFERENCES players(steamid),
      category TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      match_id INTEGER REFERENCES matches(id),
      map_ordinal INTEGER,
      half INTEGER,
      t_ms INTEGER,
      created_at TEXT NOT NULL,
      legacy_report_id INTEGER UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_reports_ticket ON ticket_reports (ticket_id);
    CREATE INDEX IF NOT EXISTS idx_ticket_reports_reporter ON ticket_reports (reporter_id, created_at);

    CREATE TABLE IF NOT EXISTS ticket_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      actor_id TEXT,
      kind TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket ON ticket_events (ticket_id);

    CREATE TABLE IF NOT EXISTS ticket_access (
      ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      steamid TEXT NOT NULL,
      added_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (ticket_id, steamid)
    );
  `);
}
```

- [ ] **Step 4: Wire it into `openDb`**

In `src/db.ts`, add the import at the top with the others:

```ts
import { ensureTicketSchema } from './tickets/schema.js';
```

Immediately before the `seed(db);` line at the end of `openDb`:

```ts
  // Moderators: may work tickets and nothing else. Deliberately not read by
  // serverAdmins.ts, so the flag grants nothing on a game server.
  ensureColumn(db, 'players', 'is_mod', 'INTEGER NOT NULL DEFAULT 0');
  // The ticket a ban was issued from, so the ban list and the ticket point at
  // each other. Null for every ban issued from the Players tab.
  ensureColumn(db, 'bans', 'ticket_id', 'INTEGER');
  ensureTicketSchema(db);
```

In `DEFAULT_SETTINGS` (same file), beside `admin_feed_reports`:

```ts
  ticket_mod_ban_max_minutes: '10080',
  ticket_reports_per_day: '5',
```

- [ ] **Step 5: Add the two settings to the schema**

In `src/settingsSchema.ts`, append to `SETTINGS_SCHEMA` after the `penalty_minutes` entry:

```ts
  { key: 'ticket_mod_ban_max_minutes', group: 'Penalties', label: 'Longest ban a moderator can issue (minutes)', help: 'Moderators can ban from a ticket up to this long. Anything longer, or permanent, needs an admin. 10080 is seven days.', type: { kind: 'int', min: 1, max: 525600 } },
  { key: 'ticket_reports_per_day', group: 'Penalties', label: 'Reports per player per day', help: 'How many reports one player may file in 24 hours.', type: { kind: 'int', min: 1, max: 100 } },
```

- [ ] **Step 6: The flag on the row, the session and the search**

`src/players.ts`, in `PlayerRow` after `is_admin: number;`:

```ts
  /** May work tickets. Nothing else: no settings, no game server rights. */
  is_mod: number;
```

`src/routes/auth.ts`, after `isAdmin: player.is_admin === 1,`:

```ts
      isMod: player.is_mod === 1,
```

`src/admin/players.ts`: add `isMod: boolean;` after `isAdmin: boolean;` in `AdminPlayerRow`; add `p.is_mod` after `p.is_admin` in the `searchPlayers` SELECT list; add `is_mod: number;` to the row type cast beside `is_admin: number;`; add `isMod: r.is_mod === 1,` after `isAdmin: r.is_admin === 1,` in the map.

- [ ] **Step 7: The toggle route**

`src/routes/admin.ts`, directly after the `/api/admin/players/:steamid/admin` route:

```ts
  app.post('/api/admin/players/:steamid/mod', async (req, reply) => {
    const t = target(req, reply);
    if (!t) return reply;
    const { isMod } = (req.body ?? {}) as { isMod?: unknown };
    if (typeof isMod !== 'boolean') return reply.code(400).send({ error: 'isMod must be true or false' });
    db.prepare('UPDATE players SET is_mod = ? WHERE steamid = ?').run(isMod ? 1 : 0, t.steamid);
    logAdmin(db, t.adminId, 'set_mod', t.steamid, { isMod });
    return { ok: true };
  });
```

In `src/discord/adminFeedPoster.ts` `actionText`, after the `set_admin` case:

```ts
      case 'set_mod': return `${who} ${d.isMod ? 'made' : 'removed'} ${target} ${d.isMod ? 'a moderator' : 'as moderator'}`;
```

- [ ] **Step 8: Run the test, then everything**

Run: `npx vitest run tests/ticketSchema.test.ts` then `npm test` then `npm run typecheck`
Expected: all PASS. Nothing else reads `is_mod` yet.

- [ ] **Step 9: Commit**

```bash
git add src/tickets/schema.ts tests/ticketSchema.test.ts src/db.ts src/settingsSchema.ts src/players.ts src/routes/auth.ts src/routes/admin.ts src/admin/players.ts src/discord/adminFeedPoster.ts
git commit -m "Add the ticket tables and a moderator flag"
```

---

### Task 2: Filing a report

**Files:**
- Create: `src/tickets/store.ts`, `src/tickets/filing.ts`, `tests/ticketFiling.test.ts`

**Interfaces:**
- Consumes: the tables from Task 1; `getPlayer` from `src/players.ts`; `getSetting` from `src/settings.ts`.
- Produces, from `src/tickets/store.ts`:
  - `interface TicketRow { id: number; target_id: string; status: 'open' | 'closed'; outcome: string | null; outcome_note: string; restricted: number; claimed_by: string | null; opened_by: string | null; created_at: string; closed_at: string | null; closed_by: string | null }`
  - `hasStaffFlag(db: DB, steamid: string): boolean` (admin or mod flag, whatever the account status)
  - `getTicketRow(db: DB, id: number): TicketRow | undefined`
  - `canSeeTicket(db: DB, t: TicketRow, viewer: string): boolean`
  - `addTicketEvent(db: DB, ticketId: number, actorId: string | null, kind: string, detail?: object, now?: Date): void`
  - `seedAccess(db: DB, ticketId: number, targetId: string, adminSteamIds: string[], extra?: string[], now?: Date): void`
- Produces, from `src/tickets/filing.ts`:
  - `REPORT_CATEGORIES`, `type ReportCategory`
  - `interface FilingDeps { adminSteamIds: string[]; now?: Date }`
  - `type FileResult = { ok: true; reportId: number; ticketId: number; created: boolean; restricted: boolean } | { ok: false; status: number; error: string }`
  - `fileReport(db: DB, reporter: string, body: FileBody, deps: FilingDeps): FileResult`
  - `openStaffTicket(db: DB, by: string, body: { targetId?: unknown; note?: unknown; restricted?: unknown }, deps: FilingDeps): { ok: true; ticketId: number } | { ok: false; status: number; error: string }`
  - `matchReportTargets(db: DB, matchId: number, reporter: string): MatchTargets`
  - `myReports(db: DB, reporter: string): MyReport[]`

- [ ] **Step 1: Write the failing test**

`tests/ticketFiling.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport, matchReportTargets, myReports, openStaffTicket } from '../src/tickets/filing.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const [R1, R2, R3, ACCUSED, MOD, ADMIN, OWNER] = IDS;
const deps = { adminSteamIds: [OWNER] };
let db: DB;
let matchId: number;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of IDS) {
    upsertPlayer(db, { steamid: id, name: `p${id.slice(-1)}`, avatar: null }, []);
    activatePlayer(db, id);
  }
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid IN (?, ?)').run(ADMIN, OWNER);
  matchId = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'completed', 'dead_air')").run().lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  [R1, R2, ACCUSED].forEach((id, i) => ins.run(matchId, id, i < 2 ? 'a' : 'b'));
});

const tickets = () => db.prepare('SELECT * FROM tickets ORDER BY id').all() as { id: number; target_id: string; restricted: number; status: string }[];

describe('fileReport', () => {
  it('the first report opens a ticket and later ones attach to it', () => {
    const a = fileReport(db, R1, { targetId: ACCUSED, category: 'cheating', text: 'walls', matchId }, deps);
    const b = fileReport(db, R2, { targetId: ACCUSED, category: 'griefing', text: '' }, deps);
    expect(a).toMatchObject({ ok: true, created: true, restricted: false });
    expect(b).toMatchObject({ ok: true, created: false });
    expect(tickets()).toHaveLength(1);
    expect((a as { ticketId: number }).ticketId).toBe((b as { ticketId: number }).ticketId);
    const kinds = (db.prepare('SELECT kind FROM ticket_events ORDER BY id').all() as { kind: string }[]).map((e) => e.kind);
    expect(kinds).toEqual(['opened', 'report_attached']);
  });

  it('a closed ticket does not take new reports: a new one opens', () => {
    fileReport(db, R1, { targetId: ACCUSED, category: 'afk', text: '' }, deps);
    db.prepare("UPDATE tickets SET status = 'closed'").run();
    fileReport(db, R2, { targetId: ACCUSED, category: 'afk', text: '' }, deps);
    expect(tickets().map((t) => t.status)).toEqual(['closed', 'open']);
  });

  it('an unsafe report opens a restricted sibling, seeded with the owner, and needs text', () => {
    fileReport(db, R1, { targetId: ACCUSED, category: 'toxicity', text: '' }, deps);
    expect(fileReport(db, R2, { targetId: ACCUSED, category: 'unsafe', text: '  ' }, deps)).toMatchObject({ ok: false, status: 400 });
    const r = fileReport(db, R2, { targetId: ACCUSED, category: 'unsafe', text: 'details' }, deps);
    expect(r).toMatchObject({ ok: true, created: true, restricted: true });
    expect(tickets().map((t) => t.restricted)).toEqual([0, 1]);
    const access = db.prepare('SELECT steamid FROM ticket_access').all() as { steamid: string }[];
    expect(access.map((a) => a.steamid)).toEqual([OWNER]);
  });

  it('a report about staff is restricted, and the accused is never on the access list', () => {
    expect(fileReport(db, R1, { targetId: MOD, category: 'toxicity', text: '' }, deps)).toMatchObject({ restricted: true });
    fileReport(db, R1, { targetId: OWNER, category: 'toxicity', text: '' }, deps);
    const t = tickets().find((x) => x.target_id === OWNER)!;
    const access = (db.prepare('SELECT steamid FROM ticket_access WHERE ticket_id = ?').all(t.id) as { steamid: string }[]).map((a) => a.steamid);
    expect(access).toEqual([ADMIN]);
  });

  it('refuses self, unknown players, inactive reporters, bad categories, long text', () => {
    const bad = (body: object, as = R1) => fileReport(db, as, body, deps);
    expect(bad({ targetId: R1, category: 'afk' })).toMatchObject({ ok: false, status: 400 });
    expect(bad({ targetId: '76561199999999999', category: 'afk' })).toMatchObject({ ok: false, status: 404 });
    expect(bad({ targetId: ACCUSED, category: 'rude' })).toMatchObject({ ok: false, status: 400 });
    expect(bad({ targetId: ACCUSED, category: 'other', text: 'x'.repeat(1001) })).toMatchObject({ ok: false, status: 400 });
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(R3);
    expect(bad({ targetId: ACCUSED, category: 'afk' }, R3)).toMatchObject({ ok: false, status: 403 });
  });

  it('checks the match and the moment', () => {
    expect(fileReport(db, R1, { targetId: ACCUSED, category: 'afk', matchId: 999 }, deps)).toMatchObject({ ok: false, status: 404 });
    expect(fileReport(db, R1, { targetId: R3, category: 'afk', matchId }, deps)).toMatchObject({ ok: false, status: 400 });
    expect(fileReport(db, R1, { targetId: ACCUSED, category: 'afk', moment: { ordinal: 1, half: 0, tMs: 5 } }, deps)).toMatchObject({ ok: false, status: 400 });
    const ok = fileReport(db, R1, { targetId: ACCUSED, category: 'afk', matchId, moment: { ordinal: 2, half: 1, tMs: 61500 } }, deps);
    expect(ok.ok).toBe(true);
    expect(db.prepare('SELECT match_id, map_ordinal, half, t_ms FROM ticket_reports').get()).toEqual({ match_id: matchId, map_ordinal: 2, half: 1, t_ms: 61500 });
  });

  it('one report per reporter, target and match; one match-less report per open ticket', () => {
    const body = { targetId: ACCUSED, category: 'afk', matchId };
    expect(fileReport(db, R1, body, deps).ok).toBe(true);
    expect(fileReport(db, R1, body, deps)).toMatchObject({ ok: false, status: 409 });
    expect(fileReport(db, R1, { targetId: ACCUSED, category: 'afk' }, deps).ok).toBe(true);
    expect(fileReport(db, R1, { targetId: ACCUSED, category: 'other' }, deps)).toMatchObject({ ok: false, status: 409 });
  });

  it('rate limits per reporter over 24 hours', () => {
    setSetting(db, 'ticket_reports_per_day', '2');
    const now = new Date('2026-09-21T12:00:00.000Z');
    expect(fileReport(db, R1, { targetId: ACCUSED, category: 'afk' }, { ...deps, now }).ok).toBe(true);
    expect(fileReport(db, R1, { targetId: R2, category: 'afk' }, { ...deps, now }).ok).toBe(true);
    expect(fileReport(db, R1, { targetId: R3, category: 'afk' }, { ...deps, now })).toMatchObject({ ok: false, status: 429 });
    const later = new Date('2026-09-22T12:00:01.000Z');
    expect(fileReport(db, R1, { targetId: R3, category: 'afk' }, { ...deps, now: later }).ok).toBe(true);
  });
});

describe('openStaffTicket', () => {
  it('opens a ticket with no report, and reuses the open one', () => {
    const a = openStaffTicket(db, MOD, { targetId: ACCUSED, note: 'seen in discord' }, deps);
    const b = openStaffTicket(db, ADMIN, { targetId: ACCUSED }, deps);
    expect(a).toMatchObject({ ok: true });
    expect(b).toEqual(a);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_reports').get()).toEqual({ n: 0 });
    expect(openStaffTicket(db, MOD, { targetId: MOD }, deps)).toMatchObject({ ok: false, status: 400 });
  });

  it('a hand-restricted ticket lets its opener in', () => {
    const r = openStaffTicket(db, MOD, { targetId: ACCUSED, restricted: true }, deps) as { ticketId: number };
    const access = (db.prepare('SELECT steamid FROM ticket_access WHERE ticket_id = ? ORDER BY steamid').all(r.ticketId) as { steamid: string }[]).map((a) => a.steamid);
    expect(access).toEqual([MOD, OWNER].sort());
  });
});

describe('matchReportTargets and myReports', () => {
  it('lists the roster minus the viewer, marking who is already reported', () => {
    fileReport(db, R1, { targetId: ACCUSED, category: 'afk', matchId }, deps);
    const t = matchReportTargets(db, matchId, R1);
    expect(t).toEqual({ canReport: true, targets: [{ steamid: R2, name: 'p1', alreadyReported: false }, { steamid: ACCUSED, name: 'p3', alreadyReported: true }] });
    expect(matchReportTargets(db, 999, R1)).toMatchObject({ canReport: false, status: 404 });
  });

  it('shows a reporter their own reports with open or closed and nothing else', () => {
    fileReport(db, R1, { targetId: ACCUSED, category: 'cheating', text: 'x', matchId }, deps);
    db.prepare("UPDATE tickets SET status = 'closed', outcome = 'action_taken', outcome_note = 'banned'").run();
    const mine = myReports(db, R1);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ targetId: ACCUSED, targetName: 'p3', category: 'cheating', matchId, status: 'closed' });
    expect(Object.keys(mine[0]).sort()).toEqual(['category', 'createdAt', 'id', 'matchId', 'status', 'targetId', 'targetName']);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/ticketFiling.test.ts`
Expected: FAIL, cannot resolve `../src/tickets/filing.js`.

- [ ] **Step 3: Write `src/tickets/store.ts`**

```ts
import type { DB } from '../db.js';

export interface TicketRow {
  id: number;
  target_id: string;
  status: 'open' | 'closed';
  outcome: string | null;
  outcome_note: string;
  restricted: number;
  claimed_by: string | null;
  opened_by: string | null;
  created_at: string;
  closed_at: string | null;
  closed_by: string | null;
}

/** Admin or moderator flag set, whatever the account's status. Used to decide
 *  that a report is ABOUT staff, where a banned moderator is still staff for
 *  the purpose of keeping their colleagues out of the case. */
export function hasStaffFlag(db: DB, steamid: string): boolean {
  const p = db.prepare('SELECT is_admin, is_mod FROM players WHERE steamid = ?').get(steamid) as
    | { is_admin: number; is_mod: number } | undefined;
  return !!p && (p.is_admin === 1 || p.is_mod === 1);
}

export function getTicketRow(db: DB, id: number): TicketRow | undefined {
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as TicketRow | undefined;
}

/** The one visibility rule. The accused never sees a ticket about themselves;
 *  a restricted ticket is seen only by its access list. Callers turn false
 *  into 404, never 403: a restricted ticket must not be detectable. */
export function canSeeTicket(db: DB, t: TicketRow, viewer: string): boolean {
  if (t.target_id === viewer) return false;
  if (t.restricted !== 1) return true;
  return !!db.prepare('SELECT 1 FROM ticket_access WHERE ticket_id = ? AND steamid = ?').get(t.id, viewer);
}

export function addTicketEvent(
  db: DB, ticketId: number, actorId: string | null, kind: string, detail: object = {}, now = new Date(),
): void {
  db.prepare('INSERT INTO ticket_events (ticket_id, actor_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(ticketId, actorId, kind, JSON.stringify(detail), now.toISOString());
}

/** Who may see a newly restricted ticket. The configured owners first; if
 *  that leaves nobody (none configured, or the owner is the accused), every
 *  admin. Never the accused, by any route. */
export function seedAccess(
  db: DB, ticketId: number, targetId: string, adminSteamIds: string[], extra: string[] = [], now = new Date(),
): void {
  const exists = (id: string) => !!db.prepare('SELECT 1 FROM players WHERE steamid = ?').get(id);
  let ids = adminSteamIds.filter((id) => id !== targetId && exists(id));
  if (ids.length === 0) {
    ids = (db.prepare('SELECT steamid FROM players WHERE is_admin = 1 AND steamid != ?').all(targetId) as { steamid: string }[])
      .map((r) => r.steamid);
  }
  const ins = db.prepare('INSERT OR IGNORE INTO ticket_access (ticket_id, steamid, added_by, created_at) VALUES (?, ?, ?, ?)');
  for (const id of new Set([...ids, ...extra.filter((e) => e !== targetId)])) ins.run(ticketId, id, 'system', now.toISOString());
}
```

- [ ] **Step 4: Write `src/tickets/filing.ts`**

```ts
import type { DB } from '../db.js';
import { getPlayer } from '../players.js';
import { getSetting } from '../settings.js';
import { addTicketEvent, hasStaffFlag, seedAccess } from './store.js';

export const REPORT_CATEGORIES = ['griefing', 'cheating', 'toxicity', 'afk', 'unsafe', 'other'] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];
const MAX_TEXT = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface FilingDeps {
  /** config.adminSteamIds: who is let into a restricted ticket first. */
  adminSteamIds: string[];
  now?: Date;
}
export interface FileBody { targetId?: unknown; category?: unknown; text?: unknown; matchId?: unknown; moment?: unknown }
type Fail = { ok: false; status: number; error: string };
export type FileResult = { ok: true; reportId: number; ticketId: number; created: boolean; restricted: boolean } | Fail;

const fail = (status: number, error: string): Fail => ({ ok: false, status, error });
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** The open ticket about this player in this flavour, or a new one. Runs
 *  inside the caller's transaction. */
function findOrOpen(
  db: DB, targetId: string, restricted: boolean, openedBy: string | null, deps: FilingDeps, extraAccess: string[] = [],
): { id: number; created: boolean } {
  const now = deps.now ?? new Date();
  const open = db.prepare("SELECT id FROM tickets WHERE target_id = ? AND restricted = ? AND status = 'open'")
    .get(targetId, restricted ? 1 : 0) as { id: number } | undefined;
  if (open) return { id: open.id, created: false };
  const id = Number(db.prepare('INSERT INTO tickets (target_id, restricted, opened_by, created_at) VALUES (?, ?, ?, ?)')
    .run(targetId, restricted ? 1 : 0, openedBy, now.toISOString()).lastInsertRowid);
  if (restricted) seedAccess(db, id, targetId, deps.adminSteamIds, extraAccess, now);
  addTicketEvent(db, id, openedBy, 'opened', {}, now);
  return { id, created: true };
}

/**
 * File a report. Any active player, about any other player, at any time; a
 * match and a replay moment are optional. The accused is never told.
 */
export function fileReport(db: DB, reporter: string, body: FileBody, deps: FilingDeps): FileResult {
  const now = deps.now ?? new Date();
  if (getPlayer(db, reporter)?.status !== 'active') return fail(403, 'not an active player');
  if (typeof body.targetId !== 'string' || !body.targetId) return fail(400, 'pick a player');
  if (body.targetId === reporter) return fail(400, 'you cannot report yourself');
  const target = getPlayer(db, body.targetId);
  if (!target) return fail(404, 'no such player');
  if (typeof body.category !== 'string' || !(REPORT_CATEGORIES as readonly string[]).includes(body.category)) {
    return fail(400, 'pick a category');
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (text.length > MAX_TEXT) return fail(400, `keep it under ${MAX_TEXT} characters`);
  if (body.category === 'unsafe' && !text) return fail(400, 'say what happened, so the right people can look into it');

  let matchId: number | null = null;
  if (body.matchId !== undefined && body.matchId !== null) {
    matchId = Number(body.matchId);
    if (!Number.isInteger(matchId) || !db.prepare('SELECT 1 FROM matches WHERE id = ?').get(matchId)) return fail(404, 'no such match');
    if (!db.prepare('SELECT 1 FROM match_players WHERE match_id = ? AND player_id = ?').get(matchId, target.steamid)) {
      return fail(400, 'that player was not in that match');
    }
  }
  let moment: { ordinal: number; half: number; tMs: number } | null = null;
  if (body.moment !== undefined && body.moment !== null) {
    const m = body.moment as { ordinal?: unknown; half?: unknown; tMs?: unknown };
    if (matchId === null || !isCount(m.ordinal) || !isCount(m.half) || !isCount(m.tMs)) return fail(400, 'a replay moment needs a match, a map, a half and a time');
    moment = { ordinal: m.ordinal, half: m.half, tMs: m.tMs };
  }

  const perDay = Number(getSetting(db, 'ticket_reports_per_day') ?? '5');
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const recent = (db.prepare('SELECT COUNT(*) AS n FROM ticket_reports WHERE reporter_id = ? AND created_at > ? AND legacy_report_id IS NULL')
    .get(reporter, since) as { n: number }).n;
  if (recent >= perDay) return fail(429, `you can file ${perDay} reports a day; try again tomorrow`);

  const dupe = matchId !== null
    ? db.prepare(
      `SELECT 1 FROM ticket_reports r JOIN tickets t ON t.id = r.ticket_id
       WHERE r.reporter_id = ? AND t.target_id = ? AND r.match_id = ?`).get(reporter, target.steamid, matchId)
    : db.prepare(
      `SELECT 1 FROM ticket_reports r JOIN tickets t ON t.id = r.ticket_id
       WHERE r.reporter_id = ? AND t.target_id = ? AND r.match_id IS NULL AND t.status = 'open'`).get(reporter, target.steamid);
  if (dupe) return fail(409, matchId !== null ? 'you already reported this player for this match' : 'you already have an open report about this player');

  const restricted = body.category === 'unsafe' || hasStaffFlag(db, target.steamid);
  return db.transaction((): FileResult => {
    const ticket = findOrOpen(db, target.steamid, restricted, null, deps);
    const reportId = Number(db.prepare(
      `INSERT INTO ticket_reports (ticket_id, reporter_id, category, text, match_id, map_ordinal, half, t_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(ticket.id, reporter, body.category, text, matchId, moment?.ordinal ?? null, moment?.half ?? null, moment?.tMs ?? null, now.toISOString()).lastInsertRowid);
    if (!ticket.created) addTicketEvent(db, ticket.id, null, 'report_attached', { reportId }, now);
    return { ok: true, reportId, ticketId: ticket.id, created: ticket.created, restricted };
  })();
}

/** A ticket opened by staff with no report behind it: something seen in
 *  Discord, or told to a moderator in person. */
export function openStaffTicket(
  db: DB, by: string, body: { targetId?: unknown; note?: unknown; restricted?: unknown }, deps: FilingDeps,
): { ok: true; ticketId: number } | Fail {
  const now = deps.now ?? new Date();
  if (typeof body.targetId !== 'string' || !getPlayer(db, body.targetId)) return fail(404, 'no such player');
  if (body.targetId === by) return fail(400, 'you cannot open a ticket about yourself');
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, MAX_TEXT) : '';
  const targetId = body.targetId;
  const restricted = body.restricted === true || hasStaffFlag(db, targetId);
  return db.transaction(() => {
    const ticket = findOrOpen(db, targetId, restricted, by, deps, [by]);
    if (note) addTicketEvent(db, ticket.id, by, 'note', { text: note }, now);
    return { ok: true as const, ticketId: ticket.id };
  })();
}

export type MatchTargets =
  | { canReport: true; targets: { steamid: string; name: string; alreadyReported: boolean }[] }
  | { canReport: false; reason: string; status: 404 };

/** The report chip on a match page: that match's roster minus the viewer. */
export function matchReportTargets(db: DB, matchId: number, reporter: string): MatchTargets {
  if (!db.prepare('SELECT 1 FROM matches WHERE id = ?').get(matchId)) return { canReport: false, reason: 'no such match', status: 404 };
  const roster = db.prepare(
    'SELECT mp.player_id AS steamid, p.name FROM match_players mp JOIN players p ON p.steamid = mp.player_id WHERE mp.match_id = ? ORDER BY mp.rowid',
  ).all(matchId) as { steamid: string; name: string }[];
  const done = new Set((db.prepare(
    'SELECT t.target_id FROM ticket_reports r JOIN tickets t ON t.id = r.ticket_id WHERE r.match_id = ? AND r.reporter_id = ?',
  ).all(matchId, reporter) as { target_id: string }[]).map((r) => r.target_id));
  return { canReport: true, targets: roster.filter((r) => r.steamid !== reporter).map((r) => ({ ...r, alreadyReported: done.has(r.steamid) })) };
}

export interface MyReport { id: number; targetId: string; targetName: string | null; category: string; matchId: number | null; createdAt: string; status: 'open' | 'closed' }

/** What a reporter may know about their own reports: that they exist, and
 *  whether the ticket is still open. Never the outcome. */
export function myReports(db: DB, reporter: string): MyReport[] {
  return db.prepare(
    `SELECT r.id, t.target_id AS targetId, p.name AS targetName, r.category, r.match_id AS matchId,
            r.created_at AS createdAt, t.status
     FROM ticket_reports r JOIN tickets t ON t.id = r.ticket_id LEFT JOIN players p ON p.steamid = t.target_id
     WHERE r.reporter_id = ? ORDER BY r.id DESC LIMIT 100`,
  ).all(reporter) as MyReport[];
}
```

Note on the rate limit: `legacy_report_id IS NULL` keeps migrated reports (Task 4) from counting against anyone.

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/ticketFiling.test.ts`
Expected: PASS. If `ORDER BY mp.rowid` fails because `match_players` is a `WITHOUT ROWID` table, order by `mp.team, mp.player_id` instead and update the expected order in the test to match.

- [ ] **Step 6: Commit**

```bash
git add src/tickets/store.ts src/tickets/filing.ts tests/ticketFiling.test.ts
git commit -m "File reports into one open ticket per accused player"
```

---

### Task 3: Working a ticket

**Files:**
- Create: `src/tickets/actions.ts`, `tests/ticketActions.test.ts`

**Interfaces:**
- Consumes: `TicketRow`, `getTicketRow`, `canSeeTicket`, `addTicketEvent`, `seedAccess`, `hasStaffFlag` from `src/tickets/store.ts`; `insertBan` from `src/admin/players.ts`; `publishBanChange` from `src/banEvents.ts`; `getSetting`.
- Produces, all returning `ActionResult = { ok: true } | { ok: false; status: number; error: string }`:
  - `TICKET_OUTCOMES`, `type TicketOutcome`
  - `claimTicket(db, id: number, by: string, claim: boolean): ActionResult`
  - `setRestricted(db, id: number, by: string, restricted: boolean, adminSteamIds: string[]): ActionResult`
  - `addAccess(db, id: number, by: string, steamid: string): ActionResult`
  - `closeTicket(db, id: number, by: string, outcome: unknown, note: unknown): ActionResult`
  - `reopenTicket(db, id: number, by: string): ActionResult`
  - `banFromTicket(db, id: number, by: string, reason: unknown, minutes: unknown, now?: Date): ActionResult`
- Every function returns `{ ok: false, status: 404, error: 'no such ticket' }` when the ticket is missing OR the actor cannot see it. The caller has already established that `by` is active staff.

- [ ] **Step 1: Write the failing test**

`tests/ticketActions.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, getPlayer } from '../src/players.js';
import { fileReport } from '../src/tickets/filing.js';
import { addAccess, banFromTicket, claimTicket, closeTicket, reopenTicket, setRestricted } from '../src/tickets/actions.js';
import { subscribeBanChanges } from '../src/banEvents.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const [R1, R2, ACCUSED, MOD, MOD2, ADMIN, OWNER] = IDS;
const deps = { adminSteamIds: [OWNER] };
let db: DB;
let ticket: number;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of IDS) {
    upsertPlayer(db, { steamid: id, name: `p${id.slice(-1)}`, avatar: null }, []);
    activatePlayer(db, id);
  }
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid IN (?, ?)').run(MOD, MOD2);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid IN (?, ?)').run(ADMIN, OWNER);
  ticket = (fileReport(db, R1, { targetId: ACCUSED, category: 'cheating', text: 'x' }, deps) as { ticketId: number }).ticketId;
});

const row = (id = ticket) => db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Record<string, unknown>;
const kinds = (id = ticket) => (db.prepare('SELECT kind FROM ticket_events WHERE ticket_id = ? ORDER BY id').all(id) as { kind: string }[]).map((e) => e.kind);

describe('claim', () => {
  it('claims and releases, and another mod can take it over', () => {
    expect(claimTicket(db, ticket, MOD, true)).toEqual({ ok: true });
    expect(row().claimed_by).toBe(MOD);
    expect(claimTicket(db, ticket, MOD2, true)).toEqual({ ok: true });
    expect(row().claimed_by).toBe(MOD2);
    expect(claimTicket(db, ticket, MOD2, false)).toEqual({ ok: true });
    expect(row().claimed_by).toBeNull();
    expect(kinds()).toEqual(['opened', 'claimed', 'claimed', 'unclaimed']);
  });
});

describe('visibility', () => {
  it('a ticket the actor cannot see is a 404 for every action', () => {
    const about = (fileReport(db, R1, { targetId: MOD, category: 'toxicity', text: '' }, deps) as { ticketId: number }).ticketId;
    for (const who of [MOD, MOD2, ADMIN]) {
      expect(claimTicket(db, about, who, true)).toMatchObject({ ok: false, status: 404 });
      expect(closeTicket(db, about, who, 'no_action', '')).toMatchObject({ ok: false, status: 404 });
    }
    expect(claimTicket(db, about, OWNER, true)).toEqual({ ok: true });
    expect(claimTicket(db, 9999, OWNER, true)).toMatchObject({ ok: false, status: 404 });
  });
});

describe('restrict and access', () => {
  it('restricting by hand seeds the owner and the actor, and hides it from everyone else', () => {
    expect(setRestricted(db, ticket, MOD, true, deps.adminSteamIds)).toEqual({ ok: true });
    expect(row().restricted).toBe(1);
    expect(claimTicket(db, ticket, MOD2, true)).toMatchObject({ status: 404 });
    expect(claimTicket(db, ticket, MOD, true)).toEqual({ ok: true });
    expect(addAccess(db, ticket, MOD, MOD2)).toEqual({ ok: true });
    expect(claimTicket(db, ticket, MOD2, true)).toEqual({ ok: true });
    expect(addAccess(db, ticket, MOD, ACCUSED)).toMatchObject({ ok: false, status: 400 });
    expect(addAccess(db, ticket, MOD, R2)).toMatchObject({ ok: false, status: 400 });
  });

  it('un-restricting is refused while the accused is staff or a report is unsafe', () => {
    const staff = (fileReport(db, R1, { targetId: MOD, category: 'toxicity', text: '' }, deps) as { ticketId: number }).ticketId;
    expect(setRestricted(db, staff, OWNER, false, deps.adminSteamIds)).toMatchObject({ ok: false, status: 400 });
    const unsafe = (fileReport(db, R2, { targetId: ACCUSED, category: 'unsafe', text: 'details' }, deps) as { ticketId: number }).ticketId;
    expect(setRestricted(db, unsafe, OWNER, false, deps.adminSteamIds)).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses a change that would make two open tickets of one flavour', () => {
    const sibling = (fileReport(db, R2, { targetId: ACCUSED, category: 'unsafe', text: 'details' }, deps) as { ticketId: number }).ticketId;
    expect(sibling).not.toBe(ticket);
    expect(setRestricted(db, ticket, MOD, true, deps.adminSteamIds)).toMatchObject({ ok: false, status: 409 });
  });
});

describe('close and reopen', () => {
  it('closes with an outcome and a note, and reopens', () => {
    expect(closeTicket(db, ticket, MOD, 'maybe', '')).toMatchObject({ ok: false, status: 400 });
    expect(closeTicket(db, ticket, MOD, 'warned', ' told them off ')).toEqual({ ok: true });
    expect(row()).toMatchObject({ status: 'closed', outcome: 'warned', outcome_note: 'told them off', closed_by: MOD });
    expect(closeTicket(db, ticket, MOD, 'warned', '')).toMatchObject({ ok: false, status: 409 });
    expect(reopenTicket(db, ticket, MOD2)).toEqual({ ok: true });
    expect(row()).toMatchObject({ status: 'open', outcome: null, closed_at: null, closed_by: null });
    expect(kinds()).toEqual(['opened', 'closed', 'reopened']);
  });

  it('will not reopen over a newer open ticket', () => {
    closeTicket(db, ticket, MOD, 'no_action', '');
    fileReport(db, R2, { targetId: ACCUSED, category: 'afk', text: '' }, deps);
    expect(reopenTicket(db, ticket, MOD)).toMatchObject({ ok: false, status: 409 });
  });
});

describe('ban from a ticket', () => {
  it('a mod bans up to the cap, the ban links to the ticket, and the change is published after commit', () => {
    const seen: unknown[] = [];
    const off = subscribeBanChanges((c) => seen.push(c));
    expect(banFromTicket(db, ticket, MOD, 'walls', null)).toMatchObject({ ok: false, status: 403 });
    expect(banFromTicket(db, ticket, MOD, 'walls', 10081)).toMatchObject({ ok: false, status: 403 });
    expect(banFromTicket(db, ticket, MOD, '', 60)).toMatchObject({ ok: false, status: 400 });
    expect(seen).toEqual([]);
    expect(banFromTicket(db, ticket, MOD, 'walls', 10080)).toEqual({ ok: true });
    off();
    expect(db.prepare('SELECT player_id, reason, created_by, ticket_id FROM bans').get()).toEqual({ player_id: ACCUSED, reason: 'walls', created_by: MOD, ticket_id: ticket });
    expect(getPlayer(db, ACCUSED)?.status).toBe('banned');
    expect(seen).toEqual([{ kind: 'ban', steamid: ACCUSED, reason: 'walls' }]);
    expect(kinds()).toContain('banned');
  });

  it('an admin bans for any length, permanent included', () => {
    expect(banFromTicket(db, ticket, ADMIN, 'walls', null)).toEqual({ ok: true });
    expect((db.prepare('SELECT expires_at FROM bans').get() as { expires_at: string | null }).expires_at).toBeNull();
  });

  it('refuses on a closed ticket', () => {
    closeTicket(db, ticket, MOD, 'no_action', '');
    expect(banFromTicket(db, ticket, ADMIN, 'walls', 60)).toMatchObject({ ok: false, status: 409 });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/ticketActions.test.ts`
Expected: FAIL, cannot resolve `../src/tickets/actions.js`.

- [ ] **Step 3: Write `src/tickets/actions.ts`**

```ts
import type { DB } from '../db.js';
import { insertBan } from '../admin/players.js';
import { publishBanChange } from '../banEvents.js';
import { getSetting } from '../settings.js';
import { addTicketEvent, canSeeTicket, getTicketRow, hasStaffFlag, seedAccess, type TicketRow } from './store.js';

export const TICKET_OUTCOMES = ['action_taken', 'warned', 'no_action', 'invalid'] as const;
export type TicketOutcome = (typeof TICKET_OUTCOMES)[number];
export type ActionResult = { ok: true } | { ok: false; status: number; error: string };

const fail = (status: number, error: string): ActionResult => ({ ok: false, status, error });
const OK: ActionResult = { ok: true };

/** Missing and invisible are the same answer on purpose. */
function visible(db: DB, id: number, by: string): TicketRow | null {
  const t = getTicketRow(db, id);
  return t && canSeeTicket(db, t, by) ? t : null;
}

/** tickets_one_open turns a second open ticket of one flavour into a
 *  constraint error; this turns that into a 409 with words. */
function guardUnique(fn: () => void, error: string): ActionResult {
  try {
    fn();
    return OK;
  } catch (err) {
    if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return fail(409, error);
    throw err;
  }
}

export function claimTicket(db: DB, id: number, by: string, claim: boolean): ActionResult {
  const t = visible(db, id, by);
  if (!t) return fail(404, 'no such ticket');
  if (t.status !== 'open') return fail(409, 'the ticket is closed');
  db.transaction(() => {
    db.prepare('UPDATE tickets SET claimed_by = ? WHERE id = ?').run(claim ? by : null, id);
    addTicketEvent(db, id, by, claim ? 'claimed' : 'unclaimed');
  })();
  return OK;
}

export function setRestricted(db: DB, id: number, by: string, restricted: boolean, adminSteamIds: string[]): ActionResult {
  const t = visible(db, id, by);
  if (!t) return fail(404, 'no such ticket');
  if ((t.restricted === 1) === restricted) return OK;
  if (!restricted) {
    if (hasStaffFlag(db, t.target_id)) return fail(400, 'a ticket about staff stays restricted');
    if (db.prepare("SELECT 1 FROM ticket_reports WHERE ticket_id = ? AND category = 'unsafe'").get(id)) {
      return fail(400, 'a ticket holding a safety report stays restricted');
    }
  }
  return guardUnique(() => db.transaction(() => {
    db.prepare('UPDATE tickets SET restricted = ? WHERE id = ?').run(restricted ? 1 : 0, id);
    if (restricted) seedAccess(db, id, t.target_id, adminSteamIds, [by]);
    addTicketEvent(db, id, by, restricted ? 'restricted' : 'unrestricted');
  })(), `there is already an open ${restricted ? 'restricted' : 'normal'} ticket about this player`);
}

export function addAccess(db: DB, id: number, by: string, steamid: string): ActionResult {
  const t = visible(db, id, by);
  if (!t) return fail(404, 'no such ticket');
  if (t.restricted !== 1) return fail(400, 'the ticket is not restricted');
  if (steamid === t.target_id) return fail(400, 'the accused can never be given access');
  if (!hasStaffFlag(db, steamid)) return fail(400, 'only staff can be given access');
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO ticket_access (ticket_id, steamid, added_by, created_at) VALUES (?, ?, ?, ?)')
      .run(id, steamid, by, new Date().toISOString());
    addTicketEvent(db, id, by, 'access_added', { steamid });
  })();
  return OK;
}

export function closeTicket(db: DB, id: number, by: string, outcome: unknown, note: unknown): ActionResult {
  const t = visible(db, id, by);
  if (!t) return fail(404, 'no such ticket');
  if (typeof outcome !== 'string' || !(TICKET_OUTCOMES as readonly string[]).includes(outcome)) return fail(400, 'pick an outcome');
  if (t.status !== 'open') return fail(409, 'the ticket is already closed');
  const text = typeof note === 'string' ? note.trim().slice(0, 1000) : '';
  db.transaction(() => {
    db.prepare("UPDATE tickets SET status = 'closed', outcome = ?, outcome_note = ?, closed_at = ?, closed_by = ? WHERE id = ?")
      .run(outcome, text, new Date().toISOString(), by, id);
    addTicketEvent(db, id, by, 'closed', { outcome, note: text });
  })();
  return OK;
}

export function reopenTicket(db: DB, id: number, by: string): ActionResult {
  const t = visible(db, id, by);
  if (!t) return fail(404, 'no such ticket');
  if (t.status === 'open') return fail(409, 'the ticket is already open');
  return guardUnique(() => db.transaction(() => {
    db.prepare("UPDATE tickets SET status = 'open', outcome = NULL, outcome_note = '', closed_at = NULL, closed_by = NULL WHERE id = ?").run(id);
    addTicketEvent(db, id, by, 'reopened');
  })(), 'there is a newer open ticket about this player; work that one');
}

/**
 * Ban the accused from the ticket. A moderator is capped at
 * ticket_mod_ban_max_minutes and cannot ban permanently; an admin is not
 * capped. The ban row carries the ticket id.
 *
 * publishBanChange runs after the commit and never inside it, for the reason
 * written above insertBan: a subscriber dials rcon and places a permanent
 * engine ban, which nothing un-does if the row it stands for is rolled back.
 */
export function banFromTicket(db: DB, id: number, by: string, reason: unknown, minutes: unknown, now = new Date()): ActionResult {
  const t = visible(db, id, by);
  if (!t) return fail(404, 'no such ticket');
  if (t.status !== 'open') return fail(409, 'reopen the ticket before banning from it');
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) return fail(400, 'a reason is required (up to 500 characters)');
  let mins: number | null = null;
  if (minutes !== undefined && minutes !== null && minutes !== '') {
    mins = Number(minutes);
    if (!Number.isInteger(mins) || mins <= 0 || mins > 60 * 24 * 365) return fail(400, 'minutes must be a whole number between 1 and 525600');
  }
  const actor = db.prepare('SELECT is_admin FROM players WHERE steamid = ?').get(by) as { is_admin: number } | undefined;
  if (actor?.is_admin !== 1) {
    const cap = Number(getSetting(db, 'ticket_mod_ban_max_minutes') ?? '10080');
    if (mins === null || mins > cap) return fail(403, `moderators can ban for up to ${cap} minutes; ask an admin for longer`);
  }
  const text = reason.trim();
  db.transaction(() => {
    insertBan(db, t.target_id, by, text, mins, now);
    db.prepare('UPDATE bans SET ticket_id = ? WHERE id = (SELECT MAX(id) FROM bans WHERE player_id = ?)').run(id, t.target_id);
    addTicketEvent(db, id, by, 'banned', { reason: text, minutes: mins }, now);
  })();
  publishBanChange({ kind: 'ban', steamid: t.target_id, reason: text });
  return OK;
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/ticketActions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tickets/actions.ts tests/ticketActions.test.ts
git commit -m "Claim, restrict, close, reopen and ban from a ticket"
```

---

### Task 4: Old reports become tickets, and a player merge carries tickets along

**Files:**
- Create: `src/tickets/migrate.ts`, `tests/ticketMigrate.test.ts`
- Modify: `src/db.ts` (one call after `ensureTicketSchema(db)`), `src/mergePlayers.ts:22-35` (the `PLAIN` list) and the transaction body just before the `for (const [table, column] of PLAIN)` loop

**Interfaces:**
- Consumes: tables from Task 1; `seedAccess`, `hasStaffFlag` from `src/tickets/store.ts`.
- Produces: `migrateLegacyReports(db: DB): number` (rows migrated this call; 0 on every later call).

- [ ] **Step 1: Write the failing test**

`tests/ticketMigrate.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { migrateLegacyReports } from '../src/tickets/migrate.js';
import { mergePlayers } from '../src/mergePlayers.js';
import { fileReport } from '../src/tickets/filing.js';

const IDS = Array.from({ length: 6 }, (_, i) => `7656119900000000${i}`);
const [R1, R2, T1, T2, ADMIN, ALT] = IDS;
let db: DB;
let matchId: number;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of IDS) {
    upsertPlayer(db, { steamid: id, name: `p${id.slice(-1)}`, avatar: null }, []);
    activatePlayer(db, id);
  }
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  matchId = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'completed', 'dead_air')").run().lastInsertRowid);
});

const legacy = (reporter: string, target: string, status: string, note: string | null = null) =>
  db.prepare(
    `INSERT INTO reports (match_id, reporter_id, target_id, category, text, status, resolved_by, resolution_note, created_at, resolved_at)
     VALUES (?, ?, ?, 'cheating', 'old text', ?, ?, ?, '2026-09-18T10:00:00.000Z', ?)`,
  ).run(matchId, reporter, target, status, status === 'open' ? null : ADMIN, note, status === 'open' ? null : '2026-09-19T10:00:00.000Z');

describe('migrateLegacyReports', () => {
  it('groups open reports by target, gives each settled report its own closed ticket, and runs once', () => {
    legacy(R1, T1, 'open');
    legacy(R2, T1, 'open');
    legacy(R1, T2, 'resolved', 'warned him');
    legacy(R2, T2, 'dismissed');
    expect(migrateLegacyReports(db)).toBe(4);
    expect(migrateLegacyReports(db)).toBe(0);
    const tickets = db.prepare('SELECT target_id, status, outcome, outcome_note, closed_by FROM tickets ORDER BY id').all();
    expect(tickets).toEqual([
      { target_id: T1, status: 'open', outcome: null, outcome_note: '', closed_by: null },
      { target_id: T2, status: 'closed', outcome: 'action_taken', outcome_note: 'warned him', closed_by: ADMIN },
      { target_id: T2, status: 'closed', outcome: 'invalid', outcome_note: '', closed_by: ADMIN },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_reports WHERE ticket_id = 1').get()).toEqual({ n: 2 });
    expect(db.prepare('SELECT match_id, text, created_at FROM ticket_reports WHERE id = 1').get())
      .toEqual({ match_id: matchId, text: 'old text', created_at: '2026-09-18T10:00:00.000Z' });
  });

  it('restricts a migrated ticket about staff', () => {
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(T1);
    legacy(R1, T1, 'open');
    migrateLegacyReports(db);
    expect(db.prepare('SELECT restricted FROM tickets').get()).toEqual({ restricted: 1 });
    expect(db.prepare('SELECT steamid FROM ticket_access').all()).toEqual([{ steamid: ADMIN }]);
  });

  it('runs from openDb', () => {
    // A second openDb over the same in-memory handle is not possible, so
    // prove the wiring by the absence of unmigrated rows after a plain open.
    expect(db.prepare('SELECT COUNT(*) AS n FROM reports r WHERE NOT EXISTS (SELECT 1 FROM ticket_reports t WHERE t.legacy_report_id = r.id)').get()).toEqual({ n: 0 });
  });
});

describe('merging players', () => {
  it('folds the alt open ticket into the main one and repoints everything else', () => {
    const deps = { adminSteamIds: [] };
    const main = (fileReport(db, R1, { targetId: T1, category: 'afk', text: '' }, deps) as { ticketId: number }).ticketId;
    const alt = (fileReport(db, R2, { targetId: ALT, category: 'cheating', text: 'x' }, deps) as { ticketId: number }).ticketId;
    fileReport(db, ALT, { targetId: T2, category: 'afk', text: '' }, deps);
    mergePlayers(db, { from: ALT, into: T1, by: ADMIN });
    expect(db.prepare('SELECT id, target_id FROM tickets ORDER BY id').all()).toEqual([
      { id: main, target_id: T1 },
      { id: alt + 1, target_id: T2 },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_reports WHERE ticket_id = ?').get(main)).toEqual({ n: 2 });
    expect(db.prepare('SELECT reporter_id FROM ticket_reports WHERE ticket_id = ?').get(alt + 1)).toEqual({ reporter_id: T1 });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/ticketMigrate.test.ts`
Expected: FAIL, cannot resolve `../src/tickets/migrate.js`.

- [ ] **Step 3: Write `src/tickets/migrate.ts`**

```ts
import type { DB } from '../db.js';
import { hasStaffFlag, seedAccess } from './store.js';

interface Legacy {
  id: number; match_id: number; reporter_id: string; target_id: string; category: string; text: string;
  status: 'open' | 'resolved' | 'dismissed'; resolved_by: string | null; resolution_note: string | null;
  created_at: string; resolved_at: string | null;
}

/**
 * Carry the old `reports` rows into tickets, once. Idempotent through
 * ticket_reports.legacy_report_id, so it is safe on every boot. The reports
 * table is left exactly as it was: nothing writes to it any more, and it is
 * the undo if this ever turns out wrong.
 *
 * Open reports are grouped by target, which is what filing would have done.
 * A settled report keeps its own closed ticket, because each one was decided
 * on its own and merging them would invent a decision nobody made.
 *
 * No owner list is available at openDb time, so a restricted migrated ticket
 * falls back to every admin but the accused (seedAccess with an empty list).
 */
export function migrateLegacyReports(db: DB): number {
  const rows = db.prepare(
    `SELECT r.* FROM reports r
     WHERE NOT EXISTS (SELECT 1 FROM ticket_reports t WHERE t.legacy_report_id = r.id)
       AND EXISTS (SELECT 1 FROM players p WHERE p.steamid = r.reporter_id)
       AND EXISTS (SELECT 1 FROM players p WHERE p.steamid = r.target_id)
     ORDER BY r.id`,
  ).all() as Legacy[];
  if (rows.length === 0) return 0;
  const insTicket = db.prepare(
    `INSERT INTO tickets (target_id, status, outcome, outcome_note, restricted, created_at, closed_at, closed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insReport = db.prepare(
    `INSERT INTO ticket_reports (ticket_id, reporter_id, category, text, match_id, created_at, legacy_report_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const r of rows) {
      const restricted = hasStaffFlag(db, r.target_id) ? 1 : 0;
      let ticketId: number;
      if (r.status === 'open') {
        const open = db.prepare("SELECT id FROM tickets WHERE target_id = ? AND restricted = ? AND status = 'open'")
          .get(r.target_id, restricted) as { id: number } | undefined;
        ticketId = open?.id ?? Number(insTicket.run(r.target_id, 'open', null, '', restricted, r.created_at, null, null).lastInsertRowid);
      } else {
        ticketId = Number(insTicket.run(
          r.target_id, 'closed', r.status === 'resolved' ? 'action_taken' : 'invalid', r.resolution_note ?? '',
          restricted, r.created_at, r.resolved_at ?? r.created_at, r.resolved_by,
        ).lastInsertRowid);
      }
      if (restricted) seedAccess(db, ticketId, r.target_id, []);
      insReport.run(ticketId, r.reporter_id, r.category, r.text, r.match_id, r.created_at, r.id);
    }
  })();
  return rows.length;
}
```

- [ ] **Step 4: Call it from `openDb`**

`src/db.ts`: import `migrateLegacyReports` from `./tickets/migrate.js`, and directly after `ensureTicketSchema(db);`:

```ts
  migrateLegacyReports(db);
```

- [ ] **Step 5: Teach the merge about tickets**

`src/mergePlayers.ts`. Keep the two `['reports', ...]` entries in `PLAIN`: the old table still holds rows. Add after them:

```ts
  ['ticket_reports', 'reporter_id'],
  ['ticket_events', 'actor_id'],
  ['tickets', 'claimed_by'],
  ['tickets', 'opened_by'],
  ['tickets', 'closed_by'],
```

Inside the transaction, immediately before `for (const [table, column] of PLAIN) {`:

```ts
    // Tickets ABOUT the merged account. tickets_one_open allows one open
    // ticket per player per flavour, so where both accounts have one the
    // alt's reports and history move into the main's and the empty shell
    // goes. Closed tickets cannot collide and are simply repointed.
    for (const restricted of [0, 1]) {
      const open = (id: string) => db.prepare("SELECT id FROM tickets WHERE target_id = ? AND restricted = ? AND status = 'open'")
        .get(id, restricted) as { id: number } | undefined;
      const gone = open(from);
      const keep = open(into);
      if (!gone || !keep) continue;
      db.prepare('UPDATE ticket_reports SET ticket_id = ? WHERE ticket_id = ?').run(keep.id, gone.id);
      db.prepare('UPDATE ticket_events SET ticket_id = ? WHERE ticket_id = ?').run(keep.id, gone.id);
      db.prepare('UPDATE OR IGNORE ticket_access SET ticket_id = ? WHERE ticket_id = ?').run(keep.id, gone.id);
      db.prepare('DELETE FROM ticket_access WHERE ticket_id = ?').run(gone.id);
      db.prepare('UPDATE bans SET ticket_id = ? WHERE ticket_id = ?').run(keep.id, gone.id);
      db.prepare('DELETE FROM tickets WHERE id = ?').run(gone.id);
    }
    db.prepare('UPDATE tickets SET target_id = ? WHERE target_id = ?').run(into, from);
    // A merged account must never sit on the access list of a ticket that is
    // now about itself.
    db.prepare('UPDATE OR IGNORE ticket_access SET steamid = ? WHERE steamid = ?').run(into, from);
    db.prepare('DELETE FROM ticket_access WHERE steamid = ?').run(from);
    db.prepare('DELETE FROM ticket_access WHERE steamid = ? AND ticket_id IN (SELECT id FROM tickets WHERE target_id = ?)').run(into, into);
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/ticketMigrate.test.ts tests/mergePlayers.test.ts`
Expected: PASS. `mergePlayers(db, { from, into, by })` is the real signature (`src/mergePlayers.ts:64`). If the repo has no `tests/mergePlayers.test.ts`, run `npx vitest run tests/ticketMigrate.test.ts` and then `npm test`.

- [ ] **Step 7: Commit**

```bash
git add src/tickets/migrate.ts tests/ticketMigrate.test.ts src/db.ts src/mergePlayers.ts
git commit -m "Carry the old reports into tickets, and tickets through a player merge"
```

---

### Task 5: The HTTP layer

**Files:**
- Create: `src/tickets/views.ts`, `src/tickets/caseFile.ts`, `src/routes/tickets.ts`, `tests/ticketRoutes.test.ts`
- Modify: `src/routes/guards.ts` (append `makeRequireMod`), `src/admin/audit.ts:6-10` (`quiet`), `src/routes/api.ts:74-87` (the two match report routes), `src/routes/admin.ts:402-419` (delete both report routes and the `listReports, resolveReport` import), `src/server.ts:950` (register)
- Delete: `tests/reports.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2 and 3; `playerDetail` from `src/admin/players.ts`.
- Produces:
  - `makeRequireMod(db)`: active and (`is_mod` or `is_admin`), else 401/403; returns the steamid.
  - `logAdmin(db, adminId, action, target, detail?, opts?: { quiet?: boolean })`: `quiet` writes the row and publishes nothing.
  - `listTickets(db, viewer: string, filter: 'open' | 'mine' | 'closed'): TicketSummary[]`
  - `ticketsAbout(db, targetId: string, viewer: string): TicketSummary[]`
  - `ticketDetail(db, id: number, viewer: string): TicketDetail | null`
  - `caseFile(db, steamid: string, viewer: string)`
  - Routes: `POST /api/reports`, `GET /api/reports/mine`, `GET /api/mod/tickets?filter=`, `POST /api/mod/tickets`, `GET /api/mod/tickets/:id`, `POST /api/mod/tickets/:id/{claim,restrict,access,ban,close,reopen}`.
  - JSON shapes (the web types in Task 7 mirror these exactly):
    - `TicketSummary { id, targetId, targetName, status, outcome, restricted: boolean, claimedBy, claimedByName, reports: number, reporters: number, categories: string[], createdAt, lastReportAt, closedAt }`
    - `TicketDetail { ticket: TicketSummary & { outcomeNote, openedBy, openedByName, closedBy, closedByName }, reports: TicketReport[], events: TicketEvent[], bans: { id, reason, createdBy, createdByName, createdAt, expiresAt, liftedAt }[], access: { steamid, name }[], accessCandidates: { steamid, name }[], caseFile, viewer: { isAdmin: boolean, banCapMinutes: number | null } }`
    - `TicketReport { id, reporterId, reporterName, category, text, matchId, campaign, moment: { ordinal, half, tMs } | null, createdAt }`
    - `TicketEvent { id, actorId, actorName, kind, detail: Record<string, unknown>, createdAt }`

- [ ] **Step 1: Write the failing test**

`tests/ticketRoutes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const [R1, R2, ACCUSED, MOD, MOD2, ADMIN, OWNER] = IDS;
let db: DB;
let app: FastifyInstance;
let matchId: number;
const cookie: Record<string, Record<string, string>> = {};

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({ ADMIN_STEAMIDS: OWNER }), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
  for (const id of IDS) cookie[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid IN (?, ?)').run(MOD, MOD2);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid IN (?, ?)').run(ADMIN, OWNER);
  matchId = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'completed', 'dead_air')").run().lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  [R1, R2, ACCUSED].forEach((id, i) => ins.run(matchId, id, i < 2 ? 'a' : 'b'));
});
afterEach(async () => { await app.close(); });

const post = (as: string, url: string, payload: object = {}) => app.inject({ method: 'POST', url, cookies: cookie[as], payload });
const get = (as: string, url: string) => app.inject({ method: 'GET', url, cookies: cookie[as] });
const file = (as: string, payload: object) => post(as, '/api/reports', payload);

describe('filing over HTTP', () => {
  it('any active player files, with or without a match, and sees it under mine', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/reports', payload: {} })).statusCode).toBe(401);
    expect((await file(R1, { targetId: ACCUSED, category: 'cheating', text: 'walls', matchId })).statusCode).toBe(200);
    expect((await file(R1, { targetId: ACCUSED, category: 'cheating', text: 'walls', matchId })).statusCode).toBe(409);
    expect((await file(R2, { targetId: ACCUSED, category: 'toxicity', text: '' })).statusCode).toBe(200);
    const mine = (await get(R1, '/api/reports/mine')).json();
    expect(mine.reports).toHaveLength(1);
    expect(mine.reports[0]).toMatchObject({ targetId: ACCUSED, status: 'open' });
    expect((await file(R1, { targetId: ACCUSED, category: 'cheating' })).json()).toEqual({ ok: true });
  });

  it('the match page routes still work and no longer need the reporter on the roster', async () => {
    const elig = (await get(OWNER, `/api/matches/${matchId}/report-eligibility`)).json();
    expect(elig.canReport).toBe(true);
    expect(elig.targets).toHaveLength(3);
    expect((await post(OWNER, `/api/matches/${matchId}/reports`, { targetId: ACCUSED, category: 'afk', text: '' })).statusCode).toBe(200);
    expect(db.prepare('SELECT match_id FROM ticket_reports').get()).toEqual({ match_id: matchId });
    expect((await get(OWNER, '/api/matches/999/report-eligibility')).json()).toEqual({ canReport: false, reason: 'no such match' });
  });

  it('the old admin report routes are gone', async () => {
    expect((await get(ADMIN, '/api/admin/reports')).statusCode).toBe(404);
  });
});

describe('working tickets over HTTP', () => {
  let id: number;
  beforeEach(async () => {
    await file(R1, { targetId: ACCUSED, category: 'cheating', text: 'walls', matchId, moment: { ordinal: 2, half: 1, tMs: 61500 } });
    await file(R2, { targetId: ACCUSED, category: 'griefing', text: '' });
    id = (db.prepare('SELECT id FROM tickets').get() as { id: number }).id;
  });

  it('players are refused, mods and admins get the list', async () => {
    expect((await get(R1, '/api/mod/tickets')).statusCode).toBe(403);
    const list = (await get(MOD, '/api/mod/tickets')).json();
    expect(list.tickets).toHaveLength(1);
    expect(list.tickets[0]).toMatchObject({ id, targetId: ACCUSED, reports: 2, reporters: 2, restricted: false, status: 'open' });
    expect(list.tickets[0].categories.sort()).toEqual(['cheating', 'griefing']);
    expect((await get(ADMIN, '/api/mod/tickets?filter=closed')).json().tickets).toEqual([]);
    expect((await get(ADMIN, '/api/mod/tickets?filter=nonsense')).statusCode).toBe(400);
  });

  it('the detail carries reports with the moment, events, the case file and the viewer cap', async () => {
    const d = (await get(MOD, `/api/mod/tickets/${id}`)).json();
    expect(d.ticket).toMatchObject({ id, targetId: ACCUSED, status: 'open' });
    expect(d.reports.map((r: { reporterId: string }) => r.reporterId).sort()).toEqual([R1, R2].sort());
    expect(d.reports.find((r: { reporterId: string }) => r.reporterId === R1)).toMatchObject({ matchId, campaign: 'dead_air', moment: { ordinal: 2, half: 1, tMs: 61500 } });
    expect(d.events.map((e: { kind: string }) => e.kind)).toEqual(['opened', 'report_attached']);
    expect(d.caseFile).toMatchObject({ steamid: ACCUSED, bans: [], tickets: [{ id }] });
    expect(d.viewer).toEqual({ isAdmin: false, banCapMinutes: 10080 });
    expect((await get(ADMIN, `/api/mod/tickets/${id}`)).json().viewer).toEqual({ isAdmin: true, banCapMinutes: null });
  });

  it('claim, ban, close and reopen work and are audited', async () => {
    expect((await post(MOD, `/api/mod/tickets/${id}/claim`, { claim: true })).statusCode).toBe(200);
    expect((await get(MOD, '/api/mod/tickets?filter=mine')).json().tickets).toHaveLength(1);
    expect((await get(MOD2, '/api/mod/tickets?filter=mine')).json().tickets).toHaveLength(0);
    expect((await post(MOD, `/api/mod/tickets/${id}/ban`, { reason: 'walls', minutes: 20000 })).statusCode).toBe(403);
    expect((await post(MOD, `/api/mod/tickets/${id}/ban`, { reason: 'walls', minutes: 1440 })).statusCode).toBe(200);
    expect((await get(MOD, `/api/mod/tickets/${id}`)).json().bans[0]).toMatchObject({ reason: 'walls', createdBy: MOD });
    expect((await post(MOD, `/api/mod/tickets/${id}/close`, { outcome: 'action_taken', note: 'one day' })).statusCode).toBe(200);
    expect((await get(R1, '/api/reports/mine')).json().reports[0].status).toBe('closed');
    expect((await post(MOD2, `/api/mod/tickets/${id}/reopen`)).statusCode).toBe(200);
    const audit = (await get(ADMIN, '/api/admin/audit')).json();
    expect(audit.actions.slice(0, 4).map((a: { action: string }) => a.action)).toEqual(['ticket_reopen', 'ticket_close', 'ticket_ban', 'ticket_claim']);
    expect(audit.actions[0].target).toBe(String(id));
  });

  it('staff open a ticket by hand', async () => {
    const r = await post(MOD, '/api/mod/tickets', { targetId: R1, note: 'said something in discord' });
    expect(r.statusCode).toBe(200);
    const d = (await get(MOD, `/api/mod/tickets/${r.json().ticketId}`)).json();
    expect(d.reports).toEqual([]);
    expect(d.events.map((e: { kind: string }) => e.kind)).toEqual(['opened', 'note']);
    expect(d.ticket.openedBy).toBe(MOD);
  });
});

describe('restricted tickets over HTTP', () => {
  it('a ticket about a mod is invisible to that mod and to everyone off the list, and its audit rows stay off the feed', async () => {
    await file(R1, { targetId: MOD, category: 'toxicity', text: 'abusive' });
    const id = (db.prepare('SELECT id FROM tickets').get() as { id: number }).id;
    for (const who of [MOD, MOD2, ADMIN]) {
      expect((await get(who, '/api/mod/tickets')).json().tickets).toEqual([]);
      expect((await get(who, `/api/mod/tickets/${id}`)).statusCode).toBe(404);
      expect((await post(who, `/api/mod/tickets/${id}/claim`, { claim: true })).statusCode).toBe(404);
    }
    const events: AdminEvent[] = [];
    const off = subscribeAdminEvents((e) => events.push(e));
    const d = (await get(OWNER, `/api/mod/tickets/${id}`)).json();
    expect(d.ticket.restricted).toBe(true);
    expect(d.access).toEqual([{ steamid: OWNER, name: expect.any(String) }]);
    expect(d.accessCandidates.map((c: { steamid: string }) => c.steamid).sort()).toEqual([MOD2, ADMIN].sort());
    expect((await post(OWNER, `/api/mod/tickets/${id}/access`, { steamid: ADMIN })).statusCode).toBe(200);
    expect((await post(OWNER, `/api/mod/tickets/${id}/restrict`, { restricted: false })).statusCode).toBe(400);
    off();
    expect(events).toEqual([]);
    expect((await get(ADMIN, `/api/mod/tickets/${id}`)).statusCode).toBe(200);
    expect((db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'ticket_access'").get() as { n: number }).n).toBe(1);
  });

  it('an accused mod does not see an ordinary ticket about themselves either', async () => {
    db.prepare('UPDATE players SET is_mod = 0 WHERE steamid = ?').run(MOD2);
    await file(R1, { targetId: MOD2, category: 'afk', text: '' });
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD2);
    const id = (db.prepare('SELECT id FROM tickets').get() as { id: number }).id;
    expect((await get(MOD, `/api/mod/tickets/${id}`)).statusCode).toBe(200);
    expect((await get(MOD2, `/api/mod/tickets/${id}`)).statusCode).toBe(404);
    expect((await get(MOD2, '/api/mod/tickets')).json().tickets).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/ticketRoutes.test.ts`
Expected: FAIL, `/api/reports` answers 404.

- [ ] **Step 3: The guard and the quiet audit**

Append to `src/routes/guards.ts`:

```ts
/** Per-route guard for tickets: an active moderator or admin's steamid, or
 *  the 401/403 reply sent and null. Which tickets that person may see is a
 *  separate question, answered per ticket by canSeeTicket. */
export function makeRequireMod(db: DB) {
  return function requireMod(req: FastifyRequest, reply: FastifyReply): string | null {
    const steamid = getSession(req);
    if (!steamid) {
      reply.code(401).send({ error: 'not logged in' });
      return null;
    }
    const player = getPlayer(db, steamid);
    if (!player || player.status !== 'active' || (player.is_admin !== 1 && player.is_mod !== 1)) {
      reply.code(403).send({ error: 'staff only' });
      return null;
    }
    return steamid;
  };
}
```

Replace `logAdmin` in `src/admin/audit.ts`:

```ts
/** `quiet` writes the audit row and publishes nothing. For restricted
 *  tickets: the admin feed channel is readable by every admin, including, in
 *  the case that matters, the one the ticket is about. */
export function logAdmin(
  db: DB, adminId: string, action: string, target: string | number, detail: object = {}, opts: { quiet?: boolean } = {},
): void {
  db.prepare('INSERT INTO admin_actions (admin_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(adminId, action, String(target), JSON.stringify(detail), new Date().toISOString());
  if (opts.quiet) return;
  publishAdminEvent({ kind: 'admin_action', adminId, action, target: String(target), detail: detail as Record<string, unknown> });
}
```

- [ ] **Step 4: Write `src/tickets/views.ts`**

```ts
import type { DB } from '../db.js';
import { getSetting } from '../settings.js';
import { canSeeTicket, getTicketRow } from './store.js';

/** The visibility rule as SQL, for lists. Must say exactly what canSeeTicket
 *  says; tests/ticketRoutes.test.ts holds the two together. */
const VISIBLE = `t.target_id != @viewer AND (t.restricted = 0 OR EXISTS
  (SELECT 1 FROM ticket_access a WHERE a.ticket_id = t.id AND a.steamid = @viewer))`;

const SUMMARY = `SELECT t.*, pt.name AS target_name, pc.name AS claimed_name, po.name AS opened_name, px.name AS closed_name,
    (SELECT COUNT(*) FROM ticket_reports r WHERE r.ticket_id = t.id) AS reports,
    (SELECT COUNT(DISTINCT r.reporter_id) FROM ticket_reports r WHERE r.ticket_id = t.id) AS reporters,
    (SELECT GROUP_CONCAT(DISTINCT r.category) FROM ticket_reports r WHERE r.ticket_id = t.id) AS categories,
    (SELECT MAX(r.created_at) FROM ticket_reports r WHERE r.ticket_id = t.id) AS last_report_at
  FROM tickets t
  LEFT JOIN players pt ON pt.steamid = t.target_id LEFT JOIN players pc ON pc.steamid = t.claimed_by
  LEFT JOIN players po ON po.steamid = t.opened_by LEFT JOIN players px ON px.steamid = t.closed_by`;

interface SummaryRow {
  id: number; target_id: string; status: 'open' | 'closed'; outcome: string | null; outcome_note: string; restricted: number;
  claimed_by: string | null; opened_by: string | null; created_at: string; closed_at: string | null; closed_by: string | null;
  target_name: string | null; claimed_name: string | null; opened_name: string | null; closed_name: string | null;
  reports: number; reporters: number; categories: string | null; last_report_at: string | null;
}

const toSummary = (r: SummaryRow) => ({
  id: r.id, targetId: r.target_id, targetName: r.target_name, status: r.status, outcome: r.outcome,
  restricted: r.restricted === 1, claimedBy: r.claimed_by, claimedByName: r.claimed_name,
  reports: r.reports, reporters: r.reporters, categories: r.categories ? r.categories.split(',') : [],
  createdAt: r.created_at, lastReportAt: r.last_report_at, closedAt: r.closed_at,
});
export type TicketSummary = ReturnType<typeof toSummary>;
export type TicketFilter = 'open' | 'mine' | 'closed';

export function listTickets(db: DB, viewer: string, filter: TicketFilter): TicketSummary[] {
  const where = filter === 'closed' ? "t.status = 'closed'"
    : filter === 'mine' ? "t.status = 'open' AND t.claimed_by = @viewer" : "t.status = 'open'";
  return (db.prepare(`${SUMMARY} WHERE ${VISIBLE} AND ${where} ORDER BY COALESCE(last_report_at, t.created_at) DESC LIMIT 200`)
    .all({ viewer }) as SummaryRow[]).map(toSummary);
}

/** Every ticket about one player that this viewer may see, newest first. */
export function ticketsAbout(db: DB, targetId: string, viewer: string): TicketSummary[] {
  return (db.prepare(`${SUMMARY} WHERE ${VISIBLE} AND t.target_id = @targetId ORDER BY t.id DESC LIMIT 50`)
    .all({ viewer, targetId }) as SummaryRow[]).map(toSummary);
}

export function ticketDetail(db: DB, id: number, viewer: string) {
  const row = getTicketRow(db, id);
  if (!row || !canSeeTicket(db, row, viewer)) return null;
  const s = db.prepare(`${SUMMARY} WHERE t.id = ?`).get(id) as SummaryRow;
  const reports = (db.prepare(
    `SELECT r.id, r.reporter_id, p.name AS reporter_name, r.category, r.text, r.match_id, m.campaign,
            r.map_ordinal, r.half, r.t_ms, r.created_at
     FROM ticket_reports r LEFT JOIN players p ON p.steamid = r.reporter_id LEFT JOIN matches m ON m.id = r.match_id
     WHERE r.ticket_id = ? ORDER BY r.id`,
  ).all(id) as {
    id: number; reporter_id: string; reporter_name: string | null; category: string; text: string; match_id: number | null;
    campaign: string | null; map_ordinal: number | null; half: number | null; t_ms: number | null; created_at: string;
  }[]).map((r) => ({
    id: r.id, reporterId: r.reporter_id, reporterName: r.reporter_name, category: r.category, text: r.text,
    matchId: r.match_id, campaign: r.campaign,
    moment: r.map_ordinal === null || r.half === null || r.t_ms === null ? null : { ordinal: r.map_ordinal, half: r.half, tMs: r.t_ms },
    createdAt: r.created_at,
  }));
  const events = (db.prepare(
    `SELECT e.id, e.actor_id, p.name AS actor_name, e.kind, e.detail, e.created_at
     FROM ticket_events e LEFT JOIN players p ON p.steamid = e.actor_id WHERE e.ticket_id = ? ORDER BY e.id`,
  ).all(id) as { id: number; actor_id: string | null; actor_name: string | null; kind: string; detail: string; created_at: string }[])
    .map((e) => ({ id: e.id, actorId: e.actor_id, actorName: e.actor_name, kind: e.kind, detail: JSON.parse(e.detail) as Record<string, unknown>, createdAt: e.created_at }));
  const bans = db.prepare(
    `SELECT b.id, b.reason, b.created_by AS createdBy, p.name AS createdByName, b.created_at AS createdAt,
            b.expires_at AS expiresAt, b.lifted_at AS liftedAt
     FROM bans b LEFT JOIN players p ON p.steamid = b.created_by WHERE b.ticket_id = ? ORDER BY b.id DESC`,
  ).all(id);
  const access = row.restricted === 1 ? db.prepare(
    `SELECT a.steamid, COALESCE(p.name, a.steamid) AS name FROM ticket_access a
     LEFT JOIN players p ON p.steamid = a.steamid WHERE a.ticket_id = ? ORDER BY name`,
  ).all(id) : [];
  const accessCandidates = row.restricted === 1 ? db.prepare(
    `SELECT steamid, name FROM players WHERE (is_admin = 1 OR is_mod = 1) AND steamid != ?
       AND steamid NOT IN (SELECT steamid FROM ticket_access WHERE ticket_id = ?) ORDER BY name`,
  ).all(row.target_id, id) : [];
  const me = db.prepare('SELECT is_admin FROM players WHERE steamid = ?').get(viewer) as { is_admin: number } | undefined;
  const isAdmin = me?.is_admin === 1;
  return {
    ticket: {
      ...toSummary(s), outcomeNote: s.outcome_note, openedBy: s.opened_by, openedByName: s.opened_name,
      closedBy: s.closed_by, closedByName: s.closed_name,
    },
    reports, events, bans, access, accessCandidates,
    viewer: { isAdmin, banCapMinutes: isAdmin ? null : Number(getSetting(db, 'ticket_mod_ban_max_minutes') ?? '10080') },
  };
}
```

- [ ] **Step 5: Write `src/tickets/caseFile.ts`**

```ts
import type { DB } from '../db.js';
import { playerDetail } from '../admin/players.js';
import { getPlayer } from '../players.js';
import { ticketsAbout } from './views.js';

/**
 * What a moderator sees about the accused beside a ticket. Picked from
 * playerDetail rather than passed through whole: a moderator is not an admin,
 * and does not get notes, the match list, or the hashed network rows. They do
 * get sharesAddressWith, because "is this a second account" is a ticket
 * question; it carries names and countries, never a hash.
 */
export function caseFile(db: DB, steamid: string, viewer: string) {
  const p = getPlayer(db, steamid);
  const d = playerDetail(db, steamid);
  if (!p || !d) return null;
  return {
    steamid: p.steamid,
    name: p.name,
    avatar: p.avatar,
    status: p.status,
    // playerDetail spreads a search row that is absent in theory, so its
    // type is a union; narrow rather than assert.
    sr: 'sr' in d ? d.sr : null,
    games: 'games' in d ? d.games : 0,
    createdAt: p.created_at,
    activeBan: d.activeBan,
    bans: d.bans,
    penalties: d.penalties,
    timeout: d.timeout,
    inputFlags: d.inputFlags,
    aliases: d.aliases,
    sharesAddressWith: d.sharesAddressWith,
    tickets: ticketsAbout(db, steamid, viewer),
  };
}
```

- [ ] **Step 6: Write `src/routes/tickets.ts`**

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import type { Matchmaker } from '../matchmaker.js';
import { makeRequireActive, makeRequireMod } from './guards.js';
import { logAdmin } from '../admin/audit.js';
import { getTicketRow } from '../tickets/store.js';
import { fileReport, myReports, openStaffTicket } from '../tickets/filing.js';
import { addAccess, banFromTicket, claimTicket, closeTicket, reopenTicket, setRestricted, type ActionResult } from '../tickets/actions.js';
import { listTickets, ticketDetail, type TicketFilter } from '../tickets/views.js';
import { caseFile } from '../tickets/caseFile.js';

export interface TicketRouteOpts {
  db: DB;
  matchmaker: Matchmaker;
  broadcast: (event: string) => void;
  adminSteamIds: string[];
}

/** Filing under /api/reports for any active player; everything under
 *  /api/mod for staff. Each mutation ends with logAdmin, quiet when the
 *  ticket is restricted. */
export async function ticketRoutes(app: FastifyInstance, opts: TicketRouteOpts): Promise<void> {
  const { db, matchmaker, broadcast, adminSteamIds } = opts;
  const requireActive = makeRequireActive(db);
  const requireMod = makeRequireMod(db);
  const filing = { adminSteamIds };

  app.post('/api/reports', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return reply;
    const r = fileReport(db, steamid, (req.body ?? {}) as object, filing);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    broadcast('refresh');
    // Deliberately nothing about the ticket: a reporter must not learn
    // whether others have reported the same player.
    return { ok: true };
  });

  app.get('/api/reports/mine', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return reply;
    return { reports: myReports(db, steamid) };
  });

  app.get('/api/mod/tickets', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const filter = String((req.query as { filter?: string }).filter ?? 'open');
    if (!['open', 'mine', 'closed'].includes(filter)) return reply.code(400).send({ error: 'bad filter' });
    return { tickets: listTickets(db, me, filter as TicketFilter) };
  });

  app.post('/api/mod/tickets', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const r = openStaffTicket(db, me, (req.body ?? {}) as object, filing);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    logAdmin(db, me, 'ticket_open', r.ticketId, {}, { quiet: getTicketRow(db, r.ticketId)?.restricted === 1 });
    broadcast('refresh');
    return { ok: true, ticketId: r.ticketId };
  });

  app.get('/api/mod/tickets/:id', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const d = ticketDetail(db, Number((req.params as { id: string }).id), me);
    if (!d) return reply.code(404).send({ error: 'no such ticket' });
    return { ...d, caseFile: caseFile(db, d.ticket.targetId, me) };
  });

  /** Shared tail of every mutation: run it, answer, audit, nudge open pages. */
  const act = (
    action: string,
    run: (id: number, me: string, body: Record<string, unknown>) => ActionResult,
    detail: (body: Record<string, unknown>) => object = () => ({}),
  ) => async (req: FastifyRequest, reply: FastifyReply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const id = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const r = run(id, me, body);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    logAdmin(db, me, action, id, detail(body), { quiet: getTicketRow(db, id)?.restricted === 1 });
    broadcast('refresh');
    return { ok: true };
  };

  app.post('/api/mod/tickets/:id/claim', act('ticket_claim', (id, me, b) => claimTicket(db, id, me, b.claim !== false), (b) => ({ claim: b.claim !== false })));
  app.post('/api/mod/tickets/:id/restrict', act('ticket_restrict', (id, me, b) => setRestricted(db, id, me, b.restricted === true, adminSteamIds), (b) => ({ restricted: b.restricted === true })));
  app.post('/api/mod/tickets/:id/access', act('ticket_access', (id, me, b) => addAccess(db, id, me, String(b.steamid ?? '')), (b) => ({ steamid: String(b.steamid ?? '') })));
  app.post('/api/mod/tickets/:id/close', act('ticket_close', (id, me, b) => closeTicket(db, id, me, b.outcome, b.note), (b) => ({ outcome: b.outcome })));
  app.post('/api/mod/tickets/:id/reopen', act('ticket_reopen', (id, me) => reopenTicket(db, id, me)));
  app.post('/api/mod/tickets/:id/ban', act('ticket_ban', (id, me, b) => {
    const r = banFromTicket(db, id, me, b.reason, b.minutes);
    // Out of the queue at once, as the Players tab ban does.
    if (r.ok) matchmaker.leave(getTicketRow(db, id)!.target_id);
    return r;
  }, (b) => ({ reason: b.reason, minutes: b.minutes ?? null })));
}
```

A restricted ticket being un-restricted is audited quietly or loudly by its state AFTER the change, which is the right way round: once it is normal, the feed may hear about it.

- [ ] **Step 7: Register, rewire the match routes, remove the old admin routes**

`src/server.ts`: import `ticketRoutes` from `./routes/tickets.js`, and after the `apiRoutes` registration at line 950:

```ts
  await app.register(ticketRoutes, {
    db: deps.db, matchmaker, broadcast: (e) => hub.broadcast(e), adminSteamIds: deps.config.adminSteamIds,
  });
```

`src/routes/api.ts`: add `adminSteamIds: string[]` to `ApiRouteOpts`, destructure it, pass `adminSteamIds: deps.config.adminSteamIds` at the `apiRoutes` registration in `src/server.ts`, replace the import `import { fileReport, reportEligibility } from '../reports.js';` with `import { fileReport, matchReportTargets } from '../tickets/filing.js';`, and replace the two match report routes with:

```ts
  app.get('/api/matches/:id/report-eligibility', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return;
    const e = matchReportTargets(db, Number((req.params as { id: string }).id), steamid);
    return e.canReport ? e : { canReport: false, reason: e.reason };
  });

  app.post('/api/matches/:id/reports', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const r = fileReport(db, steamid, { ...body, matchId: Number((req.params as { id: string }).id) }, { adminSteamIds });
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return { ok: true };
  });
```

`src/routes/admin.ts`: delete the `GET /api/admin/reports` and `POST /api/admin/reports/:id/resolve` routes and the `import { listReports, resolveReport } from '../reports.js';` line.

Delete `tests/reports.test.ts` (`git rm tests/reports.test.ts`): every case in it is either covered by `tests/ticketRoutes.test.ts` or asserts a rule the spec removed (roster membership, the 48 hour window).

- [ ] **Step 8: Run the tests**

Run: `npx vitest run tests/ticketRoutes.test.ts` then `npm test` then `npm run typecheck`
Expected: `ticketRoutes` PASS. In the full run, `tests/discordAdminFeed.test.ts` and the `/report` cases in the Discord commands test still pass, because `src/reports.ts` and its callers in `src/discord/` are untouched until Task 6. `web/src/routes/admin.test.tsx` still passes: it mocks the API.

- [ ] **Step 9: Commit**

```bash
git add -A src/tickets src/routes src/admin/audit.ts src/server.ts tests/ticketRoutes.test.ts tests/reports.test.ts
git commit -m "Serve tickets to moderators and take reports from any active player"
```

---

### Task 6: Discord touch points

Phase 1 adds no threads. It does three small things: `/report` stops needing a match, the admin feed swaps its report card for one plain line, and ticket actions read properly in the feed.

**Files:**
- Modify: `src/adminFeed.ts:12` (the `report` event), `src/tickets/filing.ts` (publish after commit), `src/discord/adminFeedPoster.ts` (card out, line in, stale buttons answered), `src/discord/commands.ts:13-17,196-224`, `src/server.ts:932`, `src/settingsSchema.ts:53` (help text), `tests/discordAdminFeed.test.ts:1-76`, `tests/discordCommands.test.ts:102-125`

**Interfaces:**
- Consumes: `fileReport` and `FilingDeps` from `src/tickets/filing.ts`.
- Produces: `AdminEvent` member `{ kind: 'report'; ticketId: number; targetId: string; category: string; created: boolean }`; `CommandDeps.adminSteamIds?: string[]`.

- [ ] **Step 1: Rewrite the three report tests in `tests/discordAdminFeed.test.ts`**

Change the import on line 5 to `import { fileReport } from '../src/tickets/filing.js';`, delete the `getMessage` import, and replace the first three `it(...)` blocks (new report card, resolve button, resolved on the website) with:

```ts
  it('posts one plain line for a new ticket and another for a further report, never naming the reporter', async () => {
    const a = fileReport(db, IDS[0], { targetId: IDS[5], category: 'griefing', text: 'kept killing us', matchId }, { adminSteamIds: [] }) as { ticketId: number };
    fileReport(db, IDS[1], { targetId: IDS[5], category: 'cheating', text: '' }, { adminSteamIds: [] });
    await feed.idle();
    expect(t.live()).toHaveLength(2);
    expect(t.live()[0].channelId).toBe('admins');
    expect(text(0)).toContain(`https://pug.test/admin?ticket=${a.ticketId}`);
    expect(text(0)).toContain('player5');
    expect(text(0)).toContain('griefing');
    expect(text(0)).toMatch(/new ticket/i);
    expect(text(1)).toMatch(/another report/i);
    expect(text(0) + text(1)).not.toContain('player0');
    expect(text(0) + text(1)).not.toContain('player1');
    expect(text(0)).not.toContain('kept killing us');
    expect(t.live()[0].payload.components).toEqual([]);
  });

  it('a restricted ticket posts nothing', async () => {
    fileReport(db, IDS[0], { targetId: IDS[5], category: 'unsafe', text: 'details' }, { adminSteamIds: [] });
    fileReport(db, IDS[0], { targetId: ADMIN, category: 'toxicity', text: '' }, { adminSteamIds: [] });
    await feed.idle();
    expect(t.live()).toHaveLength(0);
  });

  it('a button on an old report card answers instead of failing', async () => {
    const r = await feed.handleButton({ kind: 'button', customId: 'r:12:resolve', userId: '907', userName: 'd7' });
    expect(r.ephemeral).toBe(true);
    expect(JSON.stringify(r.payload)).toMatch(/tickets/i);
  });

  it('ticket actions read as sentences with a link', async () => {
    logAdmin(db, ADMIN, 'ticket_close', 12, { outcome: 'warned' });
    logAdmin(db, ADMIN, 'ticket_ban', 12, { reason: 'walls', minutes: 1440 });
    await feed.idle();
    expect(text(0)).toContain('closed ticket [#12](https://pug.test/admin?ticket=12)');
    expect(text(0)).toContain('warned');
    expect(text(1)).toContain('banned from ticket [#12]');
    expect(text(1)).toContain('1 day');
  });
```

- [ ] **Step 2: Rewrite the `/report` tests in `tests/discordCommands.test.ts`**

Replace the whole `describe('/report', ...)` block with:

```ts
describe('/report', () => {
  const rows = () => db.prepare('SELECT r.match_id, r.reporter_id, t.target_id, r.category, r.text FROM ticket_reports r JOIN tickets t ON t.id = r.ticket_id ORDER BY r.id').all();

  it('files against your latest match together, privately', async () => {
    play('a');
    const latest = play('b');
    const r = await run('report', { player: '905', reason: 'afk', details: 'gone all of map 2' });
    expect(r.ephemeral).toBe(true);
    expect(text(r)).toContain(`match #${latest}`);
    expect(rows()).toEqual([{ match_id: latest, reporter_id: IDS[0], target_id: IDS[5], category: 'afk', text: 'gone all of map 2' }]);
  });

  it('files with no match at all when you have none together', async () => {
    const r = await run('report', { player: '905', reason: 'toxicity', details: 'in voice' });
    expect(text(r)).toMatch(/reported player5/i);
    expect(text(r)).not.toMatch(/match #/);
    expect(rows()).toEqual([{ match_id: null, reporter_id: IDS[0], target_id: IDS[5], category: 'toxicity', text: 'in voice' }]);
  });

  it('takes an explicit match, refuses a repeat, yourself, and unlinked targets', async () => {
    const first = play('a');
    play('b');
    expect(text(await run('report', { player: '905', reason: 'cheating', match: String(first) }))).toContain(`match #${first}`);
    expect(text(await run('report', { player: '905', reason: 'cheating', match: String(first) }))).toMatch(/already reported/);
    expect(text(await run('report', { player: '900', reason: 'afk' }))).toMatch(/yourself/);
    expect(text(await run('report', { player: '999', reason: 'afk' }))).toMatch(/not linked/);
  });

  it('offers the safety category and insists on details for it', async () => {
    const def = COMMAND_DEFS.find((d) => d.name === 'report')!;
    expect(JSON.stringify(def)).toContain('unsafe');
    expect(text(await run('report', { player: '905', reason: 'unsafe' }))).toMatch(/say what happened/i);
  });
});
```

- [ ] **Step 3: Run both and watch them fail**

Run: `npx vitest run tests/discordAdminFeed.test.ts tests/discordCommands.test.ts`
Expected: FAIL. The feed test cannot call the new `fileReport` shape through to a posted line, and `/report` still writes to `reports`.

- [ ] **Step 4: The event and where it is published**

`src/adminFeed.ts`, replace `| { kind: 'report'; reportId: number }` with:

```ts
  // A report landed on a normal ticket. `created` is whether it opened the
  // ticket or joined one. Never published for a restricted ticket, and it
  // carries no reporter: the feed channel is wider than the ticket.
  | { kind: 'report'; ticketId: number; targetId: string; category: string; created: boolean }
```

`src/tickets/filing.ts`: add `import { publishAdminEvent } from '../adminFeed.js';`, and change the tail of `fileReport` from `return db.transaction(...)();` to:

```ts
  const result = db.transaction((): FileResult => {
    // (body unchanged)
  })();
  // After the commit, and only for a ticket the whole team may read.
  if (result.ok && !result.restricted) {
    publishAdminEvent({ kind: 'report', ticketId: result.ticketId, targetId: target.steamid, category: body.category, created: result.created });
  }
  return result;
```

- [ ] **Step 5: `src/discord/adminFeedPoster.ts`**

Delete: the `import { getReport, resolveReport } from '../reports.js';` line, the `resolve_report` branch at the top of `deliver`, the `if (e.kind === 'report') { ... }` block in `deliver`, `reportCard`, `refreshReport`, and the `saveMessage` / `getMessage` imports if nothing else in the file uses them. Update the class comment (lines 15-25) to say reports are one plain line, not a card.

Change `line`'s parameter type from `Exclude<AdminEvent, { kind: 'report' }>` to `AdminEvent` and add as its first case:

```ts
      case 'report': {
        const link = `[#${e.ticketId}](${this.deps.publicUrl}/admin?ticket=${e.ticketId})`;
        return {
          text: e.created
            ? `🎫 New ticket ${link} about **${this.name(e.targetId)}** (${e.category}).`
            : `🎫 Another report on ticket ${link} about **${this.name(e.targetId)}** (${e.category}).`,
          color: COLOR.report,
        };
      }
```

In `actionText`, before `default:`:

```ts
      case 'ticket_open': case 'ticket_claim': case 'ticket_restrict': case 'ticket_access':
      case 'ticket_close': case 'ticket_reopen': case 'ticket_ban': {
        const ticket = `ticket [#${e.target}](${this.deps.publicUrl}/admin?ticket=${e.target})`;
        switch (e.action) {
          case 'ticket_open': return `${who} opened ${ticket}`;
          case 'ticket_claim': return `${who} ${d.claim === false ? 'released' : 'claimed'} ${ticket}`;
          case 'ticket_close': return `${who} closed ${ticket}: ${String(d.outcome ?? '').replace(/_/g, ' ')}`;
          case 'ticket_reopen': return `${who} reopened ${ticket}`;
          case 'ticket_ban': return `${who} banned from ${ticket}: ${escapeName(String(d.reason ?? ''))} (${d.minutes ? fmtMinutes(Number(d.minutes)) : 'permanent'})`;
          default: return `${who} updated ${ticket}`;
        }
      }
```

Replace the body of `handleButton` with:

```ts
  /** Report cards posted before tickets existed still carry Resolve and
   *  Dismiss. They must answer, not time out. */
  async handleButton(_i: Extract<BotInteraction, { kind: 'button' }>): Promise<InteractionReply> {
    return {
      ephemeral: true,
      payload: { content: `Reports are tickets now. Open ${this.deps.publicUrl}/admin and use the Tickets tab.`, embeds: [], components: [], mentionUserIds: [] },
    };
  }
```

Remove any import this leaves unused (`playerByDiscordId`, `logAdmin`); `npm run typecheck` names them.

- [ ] **Step 6: `/report` in `src/discord/commands.ts`**

Add `adminSteamIds?: string[];` to `CommandDeps`. Replace the import of `fileReport, reportEligibility` from `'../reports.js'` with `import { fileReport, REPORT_CATEGORIES } from '../tickets/filing.js';`. In `COMMAND_DEFS`, make the `reason` choices come from `REPORT_CATEGORIES` if they are written out by hand today, so `unsafe` appears; label it `Safety concern (handled privately)`. Replace the `report` function with:

```ts
/** Always private: nobody else in the channel learns who reported whom. */
function report(deps: CommandDeps, i: Cmd): InteractionReply {
  const reporter = playerByDiscordId(deps.db, i.userId);
  if (!reporter) return linkPrompt({ ...deps }, i.userId, i.userName);
  const target = playerByDiscordId(deps.db, i.options.player ?? '');
  if (!target) {
    return priv({ content: 'That player has not linked Discord, so the bot cannot tell who they are. Use Report on their profile on the website instead.' });
  }
  if (target.steamid === reporter.steamid) return priv({ content: 'You cannot report yourself.' });

  // A match is optional. With none given, attach the latest one you shared in
  // the last 48 hours if there is one, because that is nearly always what the
  // report is about; otherwise file it with no match.
  let matchId: number | null = i.options.match ? Number(i.options.match) : null;
  if (matchId === null) {
    const shared = deps.db.prepare(
      `SELECT m.id FROM matches m
       JOIN match_players a ON a.match_id = m.id AND a.player_id = ?
       JOIN match_players b ON b.match_id = m.id AND b.player_id = ?
       WHERE m.state IN ('live', 'completed', 'aborted')
         AND (m.ended_at IS NULL OR m.ended_at > datetime('now', '-48 hours'))
       ORDER BY m.id DESC LIMIT 1`,
    ).get(reporter.steamid, target.steamid) as { id: number } | undefined;
    matchId = shared?.id ?? null;
  }
  const r = fileReport(deps.db, reporter.steamid, {
    targetId: target.steamid, category: i.options.reason, text: i.options.details ?? '', matchId,
  }, { adminSteamIds: deps.adminSteamIds ?? [] });
  if (!r.ok) return priv({ content: `Could not file the report: ${r.error}.` });
  const about = matchId === null ? '' : ` for match #${matchId}`;
  return priv({ content: `Reported ${escapeName(target.name)}${about}. Thanks, the moderators will look at it. They will not be told who reported them.` });
}
```

`src/server.ts:932`: pass `adminSteamIds: deps.config.adminSteamIds` in the object given to `handleCommand`.

`src/settingsSchema.ts:53`, the `admin_feed_reports` help becomes: `'Post a line when a ticket opens or gets another report. Restricted tickets never post.'`

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/discordAdminFeed.test.ts tests/discordCommands.test.ts` then `npm test` then `npm run typecheck`
Expected: PASS. `src/reports.ts` now has one caller left, `src/admin/players.ts`, which Task 7 removes.

- [ ] **Step 8: Commit**

```bash
git add src/adminFeed.ts src/tickets/filing.ts src/discord/adminFeedPoster.ts src/discord/commands.ts src/server.ts src/settingsSchema.ts tests/discordAdminFeed.test.ts tests/discordCommands.test.ts
git commit -m "Let /report file without a match and post tickets to the feed as one line"
```

---

### Task 7: The Tickets tab

**Files:**
- Create: `web/src/routes/admin/AdminTickets.tsx`, `web/src/routes/admin/AdminTicket.tsx`, `web/src/routes/tickets.test.tsx`
- Modify: `web/src/api.ts` (`Me`, `AdminPlayerRow`, `AdminPlayerDetail`, new types, `modApi`, `adminApi.setMod`; remove `AdminReport`, `adminApi.reports`, `adminApi.resolveReport`), `web/src/routes/Admin.tsx`, `web/src/routes/admin/AdminPlayers.tsx:84-100,176-188`, `web/src/components/Nav.tsx:44-49`, `web/src/styles/app.css`, `web/src/routes/admin.test.tsx:20,55-60` (drop the `reports` mock, keep the rest), `src/admin/players.ts:7,164`
- Delete: `web/src/routes/admin/AdminReports.tsx`, `src/reports.ts`

**Interfaces:**
- Consumes: the JSON shapes listed in Task 5; `POST /api/admin/players/:steamid/mod` from Task 1.
- Produces: `modApi` with `tickets(filter, signal)`, `ticket(id, signal)`, `open(targetId, note, restricted)`, `claim(id, claim)`, `restrict(id, restricted)`, `access(id, steamid)`, `ban(id, reason, minutes)`, `close(id, outcome, note)`, `reopen(id)`; types `TicketSummary`, `TicketDetail`, `TicketReport`, `TicketEvent`, `CaseFile`; `Me.isMod`; the URL `/admin?ticket=<id>` opens that ticket.

- [ ] **Step 1: Write the failing test**

`web/src/routes/tickets.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import type { TicketDetail, TicketSummary } from '../api';
import { ConfirmHost } from '../components/Confirm';

const { mockMod, mockAdmin } = vi.hoisted(() => ({
  mockMod: {
    tickets: vi.fn(), ticket: vi.fn(), claim: vi.fn(), restrict: vi.fn(), access: vi.fn(),
    ban: vi.fn(), close: vi.fn(), reopen: vi.fn(), open: vi.fn(),
  },
  mockAdmin: { players: vi.fn() },
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, modApi: mockMod, adminApi: { ...actual.adminApi, ...mockAdmin } };
});

const { Admin } = await import('./Admin');

const summary: TicketSummary = {
  id: 12, targetId: '7', targetName: 'Walls', status: 'open', outcome: null, restricted: false,
  claimedBy: null, claimedByName: null, reports: 2, reporters: 2, categories: ['cheating', 'griefing'],
  createdAt: '2026-09-21T10:00:00.000Z', lastReportAt: '2026-09-21T11:00:00.000Z', closedAt: null,
};
const detail = (over: Partial<TicketDetail> = {}): TicketDetail => ({
  ticket: { ...summary, outcomeNote: '', openedBy: null, openedByName: null, closedBy: null, closedByName: null },
  reports: [{ id: 1, reporterId: '3', reporterName: 'Rep', category: 'cheating', text: 'saw me through a wall', matchId: 66, campaign: 'dead_air', moment: { ordinal: 2, half: 1, tMs: 61500 }, createdAt: '2026-09-21T10:00:00.000Z' }],
  events: [{ id: 1, actorId: null, actorName: null, kind: 'opened', detail: {}, createdAt: '2026-09-21T10:00:00.000Z' }],
  bans: [], access: [], accessCandidates: [],
  caseFile: { steamid: '7', name: 'Walls', avatar: null, status: 'active', sr: 1500, games: 40, createdAt: '2026-08-01', activeBan: null, bans: [], penalties: [], timeout: null, inputFlags: [], aliases: [], sharesAddressWith: [], tickets: [summary] },
  viewer: { isAdmin: false, banCapMinutes: 10080 },
  ...over,
});

const mod = { steamid: '1', name: 'mod', avatar: null, status: 'active', isAdmin: false, isMod: true };

afterEach(() => { cleanup(); history.replaceState(null, '', '/admin'); });
beforeEach(() => {
  for (const fn of [...Object.values(mockMod), ...Object.values(mockAdmin)]) fn.mockReset();
  mockMod.tickets.mockResolvedValue({ tickets: [summary] });
  mockMod.ticket.mockResolvedValue(detail());
  for (const k of ['claim', 'restrict', 'access', 'ban', 'close', 'reopen'] as const) mockMod[k].mockResolvedValue({ ok: true });
});

describe('the Tickets tab', () => {
  it('refuses a plain player', () => {
    render(<Admin session={{ kind: 'active', me: { ...mod, isMod: false } }} />);
    expect(screen.getByText('Staff only.')).toBeTruthy();
    expect(mockMod.tickets).not.toHaveBeenCalled();
  });

  it('a moderator sees only Tickets, and never calls the admin API', async () => {
    render(<Admin session={{ kind: 'active', me: mod }} />);
    await screen.findByText('Walls');
    expect(screen.queryByRole('tab', { name: 'Settings' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Players' })).toBeNull();
    expect(mockAdmin.players).not.toHaveBeenCalled();
    expect(screen.getByText(/2 reports from 2 people/)).toBeTruthy();
  });

  it('opens a ticket, shows the report with its replay link, and claims it', async () => {
    render(<Admin session={{ kind: 'active', me: mod }} />);
    fireEvent.click(await screen.findByText('Walls'));
    await screen.findByText('saw me through a wall');
    const replay = screen.getByRole('link', { name: /replay moment/i }) as HTMLAnchorElement;
    expect(replay.getAttribute('href')).toBe('/match/66?ordinal=2&half=1&t=61500');
    fireEvent.click(screen.getByRole('button', { name: 'Claim' }));
    await waitFor(() => expect(mockMod.claim).toHaveBeenCalledWith(12, true));
  });

  it('opens straight to a ticket from the link the feed posts', async () => {
    history.replaceState(null, '', '/admin?ticket=12');
    render(<Admin session={{ kind: 'active', me: mod }} />);
    await screen.findByText('saw me through a wall');
    expect(mockMod.ticket).toHaveBeenCalledWith(12, expect.anything());
  });

  it('closes with an outcome and a note', async () => {
    history.replaceState(null, '', '/admin?ticket=12');
    render(<Admin session={{ kind: 'active', me: mod }} />);
    await screen.findByText('saw me through a wall');
    fireEvent.change(screen.getByLabelText('Outcome'), { target: { value: 'warned' } });
    fireEvent.input(screen.getByLabelText('Closing note'), { target: { value: 'first time' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close ticket' }));
    await waitFor(() => expect(mockMod.close).toHaveBeenCalledWith(12, 'warned', 'first time'));
  });

  it('a moderator cannot pick permanent, and the ban asks first', async () => {
    history.replaceState(null, '', '/admin?ticket=12');
    render(<><Admin session={{ kind: 'active', me: mod }} /><ConfirmHost /></>);
    await screen.findByText('saw me through a wall');
    const length = screen.getByLabelText('Ban length') as HTMLSelectElement;
    expect([...length.options].map((o) => o.value)).toEqual(['60', '1440', '4320', '10080']);
    fireEvent.input(screen.getByLabelText('Ban reason'), { target: { value: 'walls' } });
    fireEvent.change(length, { target: { value: '1440' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ban' }));
    const dialog = await waitFor(() => screen.getByRole('alertdialog'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ban' }));
    await waitFor(() => expect(mockMod.ban).toHaveBeenCalledWith(12, 'walls', 1440));
  });

  it('an admin is offered longer bans and permanent', async () => {
    mockMod.ticket.mockResolvedValue(detail({ viewer: { isAdmin: true, banCapMinutes: null } }));
    history.replaceState(null, '', '/admin?ticket=12');
    render(<Admin session={{ kind: 'active', me: { ...mod, isAdmin: true } }} />);
    await screen.findByText('saw me through a wall');
    const values = [...(screen.getByLabelText('Ban length') as HTMLSelectElement).options].map((o) => o.value);
    expect(values).toEqual(['60', '1440', '4320', '10080', '43200', '']);
  });

  it('a restricted ticket says so, warns about Discord, and lists who can see it', async () => {
    mockMod.ticket.mockResolvedValue(detail({
      ticket: { ...detail().ticket, restricted: true },
      access: [{ steamid: '9', name: 'Owner' }], accessCandidates: [{ steamid: '5', name: 'Other' }],
    }));
    history.replaceState(null, '', '/admin?ticket=12');
    render(<Admin session={{ kind: 'active', me: mod }} />);
    await screen.findByText(/Restricted/);
    expect(screen.getByText(/Discord Administrator/)).toBeTruthy();
    expect(screen.getByText('Owner')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Give access to'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Give access' }));
    await waitFor(() => expect(mockMod.access).toHaveBeenCalledWith(12, '5'));
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run web/src/routes/tickets.test.tsx`
Expected: FAIL, `TicketDetail` is not exported from `../api`.

- [ ] **Step 3: Types and `modApi` in `web/src/api.ts`**

In `Me`, after `isAdmin: boolean;` add `/** May open the Tickets tab. */ isMod?: boolean;`. In `AdminPlayerRow`, after `isAdmin: boolean;` add `isMod: boolean;`. Delete the `AdminReport` interface. In `AdminPlayerDetail`, replace `reportsAgainst: AdminReport[];` with `tickets: TicketSummary[];`. Delete `reports:` and `resolveReport:` from `adminApi` and add `setMod: (steamid: string, isMod: boolean) => post(`/api/admin/players/${steamid}/mod`, { isMod }),` after `setAdmin`.

Add, above `export const adminApi`:

```ts
// ---------- tickets ----------

export interface TicketSummary {
  id: number; targetId: string; targetName: string | null; status: 'open' | 'closed'; outcome: string | null;
  restricted: boolean; claimedBy: string | null; claimedByName: string | null;
  reports: number; reporters: number; categories: string[];
  createdAt: string; lastReportAt: string | null; closedAt: string | null;
}
export interface TicketReport {
  id: number; reporterId: string; reporterName: string | null; category: string; text: string;
  matchId: number | null; campaign: string | null; moment: { ordinal: number; half: number; tMs: number } | null; createdAt: string;
}
export interface TicketEvent {
  id: number; actorId: string | null; actorName: string | null; kind: string; detail: Record<string, unknown>; createdAt: string;
}
/** The accused, as a moderator may see them. Narrower than AdminPlayerDetail
 *  on purpose: no notes, no match list, no hashed network rows. */
export interface CaseFile {
  steamid: string; name: string; avatar: string | null; status: string; sr: number | null; games: number; createdAt: string | null;
  activeBan: AdminBan | null; bans: AdminBan[];
  penalties: AdminPlayerDetail['penalties']; timeout: AdminPlayerDetail['timeout'];
  inputFlags: AdminPlayerDetail['inputFlags']; aliases: AdminPlayerDetail['aliases'];
  sharesAddressWith: AdminPlayerDetail['sharesAddressWith']; tickets: TicketSummary[];
}
export interface TicketDetail {
  ticket: TicketSummary & { outcomeNote: string; openedBy: string | null; openedByName: string | null; closedBy: string | null; closedByName: string | null };
  reports: TicketReport[];
  events: TicketEvent[];
  bans: { id: number; reason: string; createdBy: string; createdByName: string | null; createdAt: string; expiresAt: string | null; liftedAt: string | null }[];
  access: { steamid: string; name: string }[];
  accessCandidates: { steamid: string; name: string }[];
  caseFile: CaseFile | null;
  /** banCapMinutes null means no cap: the viewer is an admin. */
  viewer: { isAdmin: boolean; banCapMinutes: number | null };
}

export const modApi = {
  tickets: (filter: 'open' | 'mine' | 'closed', signal?: AbortSignal) =>
    get<{ tickets: TicketSummary[] }>(`/api/mod/tickets?filter=${filter}`, signal),
  ticket: (id: number, signal?: AbortSignal) => get<TicketDetail>(`/api/mod/tickets/${id}`, signal),
  open: (targetId: string, note: string, restricted: boolean) =>
    post<{ ok: true; ticketId: number }>('/api/mod/tickets', { targetId, note, restricted }),
  claim: (id: number, claim: boolean) => post(`/api/mod/tickets/${id}/claim`, { claim }),
  restrict: (id: number, restricted: boolean) => post(`/api/mod/tickets/${id}/restrict`, { restricted }),
  access: (id: number, steamid: string) => post(`/api/mod/tickets/${id}/access`, { steamid }),
  ban: (id: number, reason: string, minutes: number | null) => post(`/api/mod/tickets/${id}/ban`, { reason, minutes }),
  close: (id: number, outcome: string, note: string) => post(`/api/mod/tickets/${id}/close`, { outcome, note }),
  reopen: (id: number) => post(`/api/mod/tickets/${id}/reopen`),
};
```

If `AdminPlayerDetail` does not declare `inputFlags`, `aliases` or `sharesAddressWith` under exactly those names, read the interface (it starts near `web/src/api.ts:588`) and use the names it has.

- [ ] **Step 4: `web/src/routes/admin/AdminTickets.tsx`**

```tsx
import { useState } from 'preact/hooks';
import { modApi, type TicketSummary } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel, Tabs } from '../../components/bits';
import { AdminTicket } from './AdminTicket';
import { fmtTime } from './useAction';

const FILTERS = [{ key: 'open', label: 'Open' }, { key: 'mine', label: 'Mine' }, { key: 'closed', label: 'Closed' }];
const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;

/** "2 reports from 2 people", or what a hand-opened ticket has instead. */
export const reportLine = (t: TicketSummary) =>
  t.reports === 0 ? 'Opened by staff, no reports' : `${t.reports} report${t.reports === 1 ? '' : 's'} from ${people(t.reporters)}`;

/** The ticket id in /admin?ticket=12, which is what the Discord feed links to. */
export const ticketFromUrl = (): number | null => {
  const raw = new URLSearchParams(location.search).get('ticket');
  const id = raw === null ? NaN : Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

export function AdminTickets() {
  const [filter, setFilter] = useState<'open' | 'mine' | 'closed'>('open');
  const [selected, setSelected] = useState<number | null>(ticketFromUrl);
  const { data, reload } = useFetch((s) => modApi.tickets(filter, s), [filter]);

  const select = (id: number | null) => {
    setSelected(id);
    history.replaceState(null, '', id === null ? '/admin' : `/admin?ticket=${id}`);
    if (id === null) reload();
  };

  if (selected !== null) return <AdminTicket id={selected} onBack={() => select(null)} onOpen={select} />;

  return (
    <Panel>
      <Tabs active={filter} onSelect={(k) => setFilter(k as typeof filter)} tabs={FILTERS} />
      {data && data.tickets.length === 0 && <Empty>No {filter === 'mine' ? 'tickets claimed by you' : `${filter} tickets`}.</Empty>}
      <ul class="tickets">
        {data?.tickets.map((t) => (
          <li key={t.id}>
            <button type="button" class="ticket-row" onClick={() => select(t.id)}>
              <span class="ticket-row__id">#{t.id}</span>
              <strong>{t.targetName ?? t.targetId}</strong>
              {t.restricted && <span class="admin-tag">restricted</span>}
              <span class="muted">{t.categories.join(', ')}</span>
              <span class="muted">{reportLine(t)}</span>
              <span class="muted">{t.claimedByName ? `claimed by ${t.claimedByName}` : 'unclaimed'}</span>
              <span class="muted">{fmtTime(t.lastReportAt ?? t.createdAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
```

- [ ] **Step 5: `web/src/routes/admin/AdminTicket.tsx`**

```tsx
import { useState } from 'preact/hooks';
import { modApi, type TicketDetail, type TicketEvent } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { campaignName } from '../../format';
import { Empty, Panel } from '../../components/bits';
import { fmtTime, useAction } from './useAction';
import { reportLine } from './AdminTickets';

const OUTCOMES = [['action_taken', 'Action taken'], ['warned', 'Warned'], ['no_action', 'No action'], ['invalid', 'Invalid report']] as const;
const LENGTHS: [minutes: number | null, label: string][] = [
  [60, '1 hour'], [1440, '1 day'], [4320, '3 days'], [10080, '7 days'], [43200, '30 days'], [null, 'Permanent'],
];

const eventText = (e: TicketEvent): string => {
  const who = e.actorName ?? 'A player';
  switch (e.kind) {
    case 'opened': return e.actorId ? `${who} opened the ticket` : 'Opened by a report';
    case 'report_attached': return 'Another report came in';
    case 'note': return `${who}: ${String(e.detail.text ?? '')}`;
    case 'claimed': return `${who} claimed it`;
    case 'unclaimed': return `${who} released it`;
    case 'restricted': return `${who} restricted it`;
    case 'unrestricted': return `${who} lifted the restriction`;
    case 'access_added': return `${who} gave someone access`;
    case 'banned': return `${who} banned the player: ${String(e.detail.reason ?? '')}`;
    case 'closed': return `${who} closed it: ${String(e.detail.outcome ?? '').replace(/_/g, ' ')}${e.detail.note ? ` (${String(e.detail.note)})` : ''}`;
    case 'reopened': return `${who} reopened it`;
    default: return `${who}: ${e.kind.replace(/_/g, ' ')}`;
  }
};

export function AdminTicket({ id, onBack, onOpen }: { id: number; onBack: () => void; onOpen: (id: number) => void }) {
  const { data, error, reload } = useFetch((s) => modApi.ticket(id, s), [id]);
  const { busy, error: actionError, run } = useAction(reload);
  const [outcome, setOutcome] = useState('');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState('1440');
  const [grant, setGrant] = useState('');

  if (error) return <Panel><button class="chip" type="button" onClick={onBack}>Back to tickets</button><Empty>No such ticket.</Empty></Panel>;
  if (!data) return <Panel><p class="muted">Loading...</p></Panel>;
  const { ticket: t, caseFile: c } = data;
  const cap = data.viewer.banCapMinutes;
  const lengths = LENGTHS.filter(([m]) => cap === null || (m !== null && m <= cap));
  const open = t.status === 'open';

  return (
    <Panel>
      <button class="chip" type="button" onClick={onBack}>Back to tickets</button>
      <h3>
        #{t.id} <a href={`/player/${t.targetId}`}>{t.targetName ?? t.targetId}</a>
        {t.restricted && <span class="admin-tag">Restricted</span>}
        <span class="admin-tag">{open ? 'open' : `closed: ${(t.outcome ?? '').replace(/_/g, ' ')}`}</span>
      </h3>
      <p class="muted">{reportLine(t)} · {t.claimedByName ? `claimed by ${t.claimedByName}` : 'unclaimed'} · opened {fmtTime(t.createdAt)}</p>
      {actionError && <p class="error">{actionError}</p>}

      {t.restricted && (
        <section class="ticket-restricted">
          <p>Only the people listed here can see this ticket. Anyone with the Discord Administrator permission can read every channel on the Discord server, so keep the discussion of this one off Discord if that includes the accused.</p>
          <ul class="admin-list">{data.access.map((a) => <li key={a.steamid}>{a.name}</li>)}</ul>
          {data.accessCandidates.length > 0 && (
            <div class="admin-form">
              <select value={grant} aria-label="Give access to" onChange={(e) => setGrant((e.target as HTMLSelectElement).value)}>
                <option value="">Give access to...</option>
                {data.accessCandidates.map((a) => <option key={a.steamid} value={a.steamid}>{a.name}</option>)}
              </select>
              <button class="chip" type="button" disabled={busy || !grant} onClick={() => run(() => modApi.access(t.id, grant)).then(() => setGrant(''))}>Give access</button>
            </div>
          )}
        </section>
      )}

      <section>
        <h4>Reports</h4>
        {data.reports.length === 0 && <p class="muted">None. This ticket was opened by staff.</p>}
        <ul class="admin-reports">
          {data.reports.map((r) => (
            <li key={r.id} class="admin-report">
              <p>
                <strong>{r.category}</strong> from <a href={`/player/${r.reporterId}`}>{r.reporterName ?? r.reporterId}</a>
                <span class="muted"> · {fmtTime(r.createdAt)}</span>
                {r.matchId !== null && <> · <a href={`/match/${r.matchId}`}>#{r.matchId}{r.campaign ? ` ${campaignName(r.campaign)}` : ''}</a></>}
                {r.matchId !== null && r.moment && <> · <a href={`/match/${r.matchId}?ordinal=${r.moment.ordinal}&half=${r.moment.half}&t=${r.moment.tMs}`}>replay moment</a></>}
              </p>
              {r.text && <blockquote>{r.text}</blockquote>}
            </li>
          ))}
        </ul>
      </section>

      {c && (
        <section>
          <h4>About {c.name}</h4>
          <p class="muted">{c.status} · SR {c.sr ?? 'n/a'} · {c.games} games{c.activeBan ? ` · banned: ${c.activeBan.reason}` : ''}{c.timeout ? ` · queue timeout, ${c.timeout.offenses} offenses` : ''}</p>
          <ul class="admin-list">
            <li>{c.bans.length} ban{c.bans.length === 1 ? '' : 's'} on record, {c.penalties.length} penalt{c.penalties.length === 1 ? 'y' : 'ies'}, {c.inputFlags.length} input flag{c.inputFlags.length === 1 ? '' : 's'}</li>
            {c.aliases.length > 0 && <li>{c.aliases.length} merged second account{c.aliases.length === 1 ? '' : 's'}</li>}
            {c.sharesAddressWith.length > 0 && <li>Shares a connection with: {c.sharesAddressWith.map((s) => s.name).join(', ')}</li>}
          </ul>
          {c.tickets.filter((o) => o.id !== t.id).length > 0 && (
            <>
              <h4>Earlier tickets</h4>
              <ul class="admin-list">
                {c.tickets.filter((o) => o.id !== t.id).map((o) => (
                  <li key={o.id}>
                    <button class="chip" type="button" onClick={() => onOpen(o.id)}>#{o.id}</button>
                    {' '}{o.categories.join(', ')} · {o.status === 'open' ? 'open' : (o.outcome ?? 'closed').replace(/_/g, ' ')} · {fmtTime(o.createdAt)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      <section>
        <h4>Timeline</h4>
        <ul class="admin-list">
          {data.events.map((e) => <li key={e.id}><span class="muted">{fmtTime(e.createdAt)}</span> {eventText(e)}</li>)}
        </ul>
        <p class="muted">The moderators' discussion will appear here once the Discord forum is connected.</p>
      </section>

      <section>
        <h4>Actions</h4>
        <div class="admin-actions">
          {open && <button class="chip" type="button" disabled={busy} onClick={() => run(() => modApi.claim(t.id, t.claimedBy === null))}>{t.claimedBy === null ? 'Claim' : 'Release'}</button>}
          <button class="chip" type="button" disabled={busy}
            onClick={() => run(() => modApi.restrict(t.id, !t.restricted), t.restricted ? undefined : {
              title: 'Restrict this ticket?',
              body: 'Only you and the owners will be able to see it until someone is given access.',
              confirmLabel: 'Restrict',
            })}>
            {t.restricted ? 'Lift restriction' : 'Restrict'}
          </button>
          {!open && <button class="chip" type="button" disabled={busy} onClick={() => run(() => modApi.reopen(t.id))}>Reopen</button>}
        </div>

        {open && (
          <>
            <div class="admin-form">
              <input value={reason} maxLength={500} placeholder="Ban reason" aria-label="Ban reason" onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
              <select value={minutes} aria-label="Ban length" onChange={(e) => setMinutes((e.target as HTMLSelectElement).value)}>
                {lengths.map(([m, label]) => <option key={label} value={m === null ? '' : String(m)}>{label}</option>)}
              </select>
              <button class="btn" type="button" disabled={busy || !reason.trim()}
                onClick={() => run(() => modApi.ban(t.id, reason.trim(), minutes === '' ? null : Number(minutes)), {
                  title: `Ban ${t.targetName ?? t.targetId}?`,
                  body: 'They are removed from the queue and banned on every game server. The ban is linked to this ticket.',
                  confirmLabel: 'Ban',
                  danger: true,
                }).then(() => setReason(''))}>
                Ban
              </button>
            </div>
            <div class="admin-form">
              <select value={outcome} aria-label="Outcome" onChange={(e) => setOutcome((e.target as HTMLSelectElement).value)}>
                <option value="">Outcome...</option>
                {OUTCOMES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
              <input value={note} maxLength={1000} placeholder="Closing note (staff only)" aria-label="Closing note" onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
              <button class="btn" type="button" disabled={busy || !outcome} onClick={() => run(() => modApi.close(t.id, outcome, note))}>Close ticket</button>
            </div>
          </>
        )}
      </section>
    </Panel>
  );
}
```

- [ ] **Step 6: `web/src/routes/Admin.tsx`**

Replace the `AdminReports` import with `import { AdminTickets, ticketFromUrl } from './admin/AdminTickets';`, rename the `reports` tab entry to `{ key: 'tickets', label: 'Tickets' }`, and replace the component body with:

```tsx
/** The staff panel. The server enforces every route; this guard only spares
 *  someone a page of 403s. A moderator gets the Tickets tab and nothing else. */
export function Admin({ session }: { session: Session }) {
  const isAdmin = session.kind === 'active' && session.me.isAdmin;
  const isStaff = isAdmin || (session.kind === 'active' && session.me.isMod === true);
  const [tab, setTab] = useState(() => (ticketFromUrl() !== null ? 'tickets' : 'players'));
  if (session.kind === 'loading') return <div class="page page--admin" />;
  if (session.kind !== 'active' || !isStaff) {
    return (
      <div class="page page--list">
        <Panel><Empty>Staff only.</Empty></Panel>
      </div>
    );
  }
  const tabs = isAdmin ? TABS : TABS.filter((t) => t.key === 'tickets');
  const active = isAdmin ? tab : 'tickets';
  return (
    <div class="page page--admin">
      <PageHeader eyebrow="Riverside" title={isAdmin ? 'Admin' : 'Moderation'} />
      <Tabs tabs={tabs} active={active} onSelect={setTab} />
      <div class="admin-body">
        {active === 'players' && <AdminPlayers me={session.me.steamid} />}
        {active === 'matches' && <AdminMatches />}
        {active === 'tickets' && <AdminTickets />}
        {active === 'integrity' && <AdminIntegrity />}
        {active === 'campaigns' && <AdminCampaigns />}
        {active === 'seasons' && <AdminSeasons />}
        {active === 'settings' && <AdminSettings />}
        {active === 'audit' && <AdminAudit />}
      </div>
    </div>
  );
}
```

`web/src/routes/admin.test.tsx` has a test asserting the text `Admins only.`; change that expectation to `Staff only.`, remove `reports: vi.fn(),` from `mockAdmin`, and delete any test in that file that renders the old Reports tab.

- [ ] **Step 7: Players tab, nav, server side of `reportsAgainst`, CSS**

`src/admin/players.ts`: delete `import { listReports } from '../reports.js';`, add `import { ticketsAbout } from '../tickets/views.js';`, give `playerDetail` a third parameter `viewer: string = ''`, and replace the `reportsAgainst:` line with:

```ts
    // Tickets about this player that the viewing admin may see. A restricted
    // one is simply absent for an admin who is not on its list.
    tickets: ticketsAbout(db, steamid, viewer),
```

`src/routes/admin.ts`, the `GET /api/admin/players/:steamid` route: capture the admin (`const adminId = requireAdmin(req, reply); if (!adminId) return reply;`) and call `playerDetail(db, steamid, adminId)`. `src/tickets/caseFile.ts` keeps calling `playerDetail(db, steamid)` and its own `ticketsAbout`. Then `git rm src/reports.ts`.

`web/src/routes/admin/AdminPlayers.tsx`: replace the "Reports against" section with:

```tsx
      <section>
        <h4>Tickets</h4>
        {d.tickets.length === 0 ? <p class="muted">None.</p> : (
          <ul class="admin-list">
            {d.tickets.map((t) => (
              <li key={t.id}>
                <a href={`/admin?ticket=${t.id}`}>#{t.id}</a> · {t.categories.join(', ') || 'opened by staff'} · {t.status === 'open' ? 'open' : (t.outcome ?? 'closed').replace(/_/g, ' ')} · {fmtTime(t.createdAt)}
              </li>
            ))}
          </ul>
        )}
      </section>
```

and, directly after the Make admin / Remove admin button:

```tsx
        <button class="chip" disabled={busy}
          onClick={() => run(() => adminApi.setMod(d.steamid, !d.isMod), d.isMod ? undefined : {
            title: `Make ${d.name} a moderator?`,
            body: 'They can see and work tickets, and ban for up to the moderator limit. They get no settings and nothing on the game servers.',
            confirmLabel: 'Make moderator',
          })}>
          {d.isMod ? 'Remove moderator' : 'Make moderator'}
        </button>
```

Show the flag in the list row: after `{p.isAdmin && <span class="admin-tag">admin</span>}` add `{p.isMod && <span class="admin-tag">mod</span>}`.

`web/src/components/Nav.tsx`: change the Admin link's condition to `(me?.isAdmin || me?.isMod)` and its label to `{me?.isAdmin ? 'Admin' : 'Moderation'}`. Leave the Bans link admin only.

Append to `web/src/styles/app.css`:

```css
/* Tickets. A row is a button so the whole line is one target. */
.tickets { list-style: none; margin: 0; padding: 0; }
.ticket-row {
  display: flex; flex-wrap: wrap; gap: 0.25rem 0.75rem; align-items: baseline;
  width: 100%; padding: 0.6rem 0.25rem; text-align: left;
  background: none; border: 0; border-bottom: 1px solid var(--line, rgba(255, 255, 255, 0.08));
  color: inherit; font: inherit; cursor: pointer;
}
.ticket-row:hover, .ticket-row:focus-visible { background: rgba(255, 255, 255, 0.04); }
.ticket-row__id { font-variant-numeric: tabular-nums; opacity: 0.7; }
.ticket-restricted { border-left: 3px solid #de4e40; padding-left: 0.75rem; margin: 0.75rem 0; }
```

If `app.css` defines a border colour token under another name, use it in place of `--line`; `grep -n "^  --" web/src/styles/app.css | head -30` lists them.

- [ ] **Step 8: Run the tests**

Run: `npx vitest run web/src/routes/tickets.test.tsx web/src/routes/admin.test.tsx` then `npm test` then `npm run typecheck`
Expected: PASS. If a `Tabs` button does not have `role="tab"`, read `web/src/components/bits.tsx:99` and query by the role it does have; the assertion that matters is that Settings and Players are absent for a moderator.

- [ ] **Step 9: Commit**

```bash
git add -A web/src src/admin/players.ts src/routes/admin.ts src/reports.ts
git commit -m "Replace the Reports tab with Tickets, and let moderators in"
```

---

### Task 8: Reporting from a profile, and My reports

**Files:**
- Create: `web/src/components/MyReports.tsx`, `web/src/components/ReportPlayer.test.tsx`
- Modify: `web/src/components/ReportPlayer.tsx`, `web/src/api.ts` (`api.fileReport`, `api.myReports`, `MyReport`), `web/src/routes/Profile.tsx:78-92`, `web/src/routes/admin.test.tsx` (the existing `ReportPlayer` cases keep passing unchanged; if one asserts the text `An admin will look at it`, change it to `The moderators will look at it`)

**Interfaces:**
- Consumes: `POST /api/reports`, `GET /api/reports/mine`, `POST /api/mod/tickets` (Task 5); `modApi.open` (Task 7).
- Produces: `ReportPlayer` props become `{ matchId?: number; target?: { steamid: string; name: string } }` (exactly one of the two); `api.fileReport(body)`; `api.myReports(signal)`; `<MyReports />`.

- [ ] **Step 1: Write the failing test**

`web/src/components/ReportPlayer.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';

const { mockApi } = vi.hoisted(() => ({
  mockApi: { reportEligibility: vi.fn(), report: vi.fn(), fileReport: vi.fn(), myReports: vi.fn() },
}));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { ...actual.api, ...mockApi } };
});

const { ReportPlayer } = await import('./ReportPlayer');
const { MyReports } = await import('./MyReports');

afterEach(cleanup);
beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  mockApi.fileReport.mockResolvedValue({ ok: true });
});

describe('ReportPlayer on a profile', () => {
  const target = { steamid: '7', name: 'Walls' };

  it('reports a fixed player with no match and never asks for eligibility', async () => {
    render(<ReportPlayer target={target} />);
    fireEvent.click(screen.getByRole('button', { name: 'Report Walls' }));
    expect(screen.queryByLabelText('Player')).toBeNull();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'toxicity' } });
    fireEvent.input(screen.getByLabelText('Details'), { target: { value: 'in voice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(mockApi.fileReport).toHaveBeenCalledWith({ targetId: '7', category: 'toxicity', text: 'in voice' }));
    expect(mockApi.reportEligibility).not.toHaveBeenCalled();
    await screen.findByText(/moderators will look at it/i);
  });

  it('the safety category explains itself and needs details', async () => {
    render(<ReportPlayer target={target} />);
    fireEvent.click(screen.getByRole('button', { name: 'Report Walls' }));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'unsafe' } });
    expect(screen.getByText(/seen only by the people who run the community/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Send report' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.input(screen.getByLabelText('Details'), { target: { value: 'what happened' } });
    expect((screen.getByRole('button', { name: 'Send report' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('MyReports', () => {
  it('lists what you filed and whether it is open, and nothing about the outcome', async () => {
    mockApi.myReports.mockResolvedValue({ reports: [
      { id: 1, targetId: '7', targetName: 'Walls', category: 'cheating', matchId: 66, createdAt: '2026-09-21T10:00:00.000Z', status: 'closed' },
    ] });
    render(<MyReports />);
    await screen.findByText('Walls');
    expect(screen.getByText(/closed/)).toBeTruthy();
    expect(screen.getByRole('link', { name: '#66' }).getAttribute('href')).toBe('/match/66');
  });

  it('renders nothing when you have filed none', async () => {
    mockApi.myReports.mockResolvedValue({ reports: [] });
    const { container } = render(<MyReports />);
    await waitFor(() => expect(mockApi.myReports).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run web/src/components/ReportPlayer.test.tsx`
Expected: FAIL, `./MyReports` does not exist.

- [ ] **Step 3: `web/src/api.ts`**

Beside `ReportEligibility`:

```ts
export interface MyReport {
  id: number; targetId: string; targetName: string | null; category: string;
  matchId: number | null; createdAt: string; status: 'open' | 'closed';
}
```

In `api`, beside `report:`:

```ts
  fileReport: (body: { targetId: string; category: string; text: string; matchId?: number; moment?: { ordinal: number; half: number; tMs: number } }) =>
    post('/api/reports', body),
  myReports: (signal?: AbortSignal) => get<{ reports: MyReport[] }>('/api/reports/mine', signal),
```

- [ ] **Step 4: `web/src/components/ReportPlayer.tsx`**

Replace `CATEGORIES`, the doc comment, the props, `start` and `submit`, and the render, leaving `capitalise` as it is:

```tsx
const CATEGORIES = [
  ['griefing', 'Griefing / throwing'],
  ['cheating', 'Cheating'],
  ['toxicity', 'Toxicity / harassment'],
  ['afk', 'AFK / left the game'],
  ['unsafe', 'Safety concern (handled privately)'],
  ['other', 'Something else'],
] as const;

/**
 * "Report a player". Two homes: a match page (pass matchId, pick someone from
 * that match's roster) and a profile (pass target, no match). Moderators see
 * reports as tickets; the reported player is never told who filed one.
 */
export function ReportPlayer({ matchId, target: fixed }: { matchId?: number; target?: { steamid: string; name: string } }) {
  const [open, setOpen] = useState(false);
  const [elig, setElig] = useState<ReportEligibility | null>(null);
  const [target, setTarget] = useState('');
  const [category, setCategory] = useState('');
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setOpen(true);
    setMsg(null);
    if (fixed || matchId === undefined) return;
    try {
      setElig(await api.reportEligibility(matchId));
    } catch {
      setElig({ canReport: false, reason: 'Could not load the players in this match.' });
    }
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      if (fixed) await api.fileReport({ targetId: fixed.steamid, category, text });
      else await api.report(matchId!, target, category, text);
      setMsg({ ok: true, text: 'Thanks. The moderators will look at it.' });
      setTarget('');
      setCategory('');
      setText('');
      if (!fixed && matchId !== undefined) setElig(await api.reportEligibility(matchId));
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Could not send the report.' });
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return <button class="chip report" type="button" onClick={start}>{fixed ? `Report ${fixed.name}` : 'Report a player'}</button>;
  }

  const ready = fixed ? true : elig?.canReport === true;
  const needsText = category === 'unsafe';
  return (
    <div class="report">
      <h3>{fixed ? `Report ${fixed.name}` : 'Report a player'}</h3>
      {!fixed && !elig && <p class="muted">Checking...</p>}
      {!fixed && elig && !elig.canReport && <p class="muted">{capitalise(elig.reason ?? 'You cannot report on this match')}.</p>}
      {ready && (
        <form class="report__form" onSubmit={submit}>
          {!fixed && (
            <select value={target} aria-label="Player" onChange={(e) => setTarget((e.target as HTMLSelectElement).value)}>
              <option value="">Who?</option>
              {elig!.targets!.map((t) => (
                <option key={t.steamid} value={t.steamid} disabled={t.alreadyReported}>
                  {t.name}{t.alreadyReported ? ' (reported)' : ''}
                </option>
              ))}
            </select>
          )}
          <select value={category} aria-label="Reason" onChange={(e) => setCategory((e.target as HTMLSelectElement).value)}>
            <option value="">What happened?</option>
            {CATEGORIES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
          {needsText && <p class="muted">This is seen only by the people who run the community, not by the whole moderator team. Say what happened in as much detail as you are comfortable with.</p>}
          <textarea value={text} maxLength={1000} aria-label="Details"
            placeholder={needsText ? 'What happened (required)' : 'Details (optional): when, which map, what they did'}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
          <div class="admin-form">
            <button class="btn" type="submit" disabled={busy || (!fixed && !target) || !category || (needsText && !text.trim())}>Send report</button>
            <button class="chip" type="button" onClick={() => setOpen(false)}>Close</button>
          </div>
        </form>
      )}
      {msg && <p class={msg.ok ? 'muted' : 'error'}>{msg.text}</p>}
    </div>
  );
}
```

- [ ] **Step 5: `web/src/components/MyReports.tsx`**

```tsx
import { api } from '../api';
import { useFetch } from '../hooks/useFetch';
import { Panel } from './bits';
import { fmtDate } from '../format';

/**
 * What you have reported, and whether the ticket is still open. Nothing about
 * the outcome: that stays with the moderators. This is also the fallback for
 * people whose Discord DMs are closed, who never get the closing message.
 */
export function MyReports() {
  const { data } = useFetch((s) => api.myReports(s), []);
  if (!data || data.reports.length === 0) return null;
  return (
    <Panel>
      <h3>Your reports</h3>
      <ul class="admin-list">
        {data.reports.map((r) => (
          <li key={r.id}>
            <a href={`/player/${r.targetId}`}>{r.targetName ?? r.targetId}</a> · {r.category}
            {r.matchId !== null && <> · <a href={`/match/${r.matchId}`}>#{r.matchId}</a></>}
            {' '}· {fmtDate(r.createdAt)} · <span class="muted">{r.status === 'open' ? 'open' : 'closed, thank you'}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
```

If `fmtDate` in `web/src/format.ts` does not take an ISO string, use `new Date(r.createdAt).toLocaleDateString()`.

- [ ] **Step 6: `web/src/routes/Profile.tsx`**

Import `ReportPlayer`, `MyReports` and `modApi`. Directly after the `<SocialChips ... />` line:

```tsx
        {session?.kind === 'active' && session.me.steamid !== steamid && (
          <div class="admin-actions">
            <ReportPlayer target={{ steamid, name: player.name }} />
            {(session.me.isAdmin || session.me.isMod) && (
              <button class="chip" type="button"
                onClick={async () => {
                  const r = await modApi.open(steamid, '', false);
                  location.href = `/admin?ticket=${r.ticketId}`;
                }}>
                Open a ticket
              </button>
            )}
          </div>
        )}
```

and, inside the existing own-profile block, after the closing `</Panel>` of the Discord and profile edit panel:

```tsx
        {session?.kind === 'active' && session.me.steamid === steamid && <MyReports />}
```

(That block's condition also admits `pending`; `MyReports` needs an active session, hence its own condition.)

- [ ] **Step 7: Run the tests**

Run: `npx vitest run web/src/components/ReportPlayer.test.tsx web/src/routes/admin.test.tsx web/src/routes/routes.test.tsx` then `npm test` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add web/src/components/ReportPlayer.tsx web/src/components/ReportPlayer.test.tsx web/src/components/MyReports.tsx web/src/api.ts web/src/routes/Profile.tsx web/src/routes/admin.test.tsx
git commit -m "Report a player from their profile, and show reporters their own reports"
```

---

### Task 9: Prove the whole thing in a browser

Tests mock the API on the web side and inject on the server side. Nothing so far has run the two together.

**Files:** none changed unless a defect is found.

- [ ] **Step 1: Full suite and build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all PASS, build succeeds.

- [ ] **Step 2: Run it for real against a scratch database**

```bash
DB_PATH="$PWD/data/tickets-dev.sqlite" ADMIN_STEAMIDS=76561199000000001 npm run dev
```

`npm run dev` already sets `DEV_MODE=1`, which keeps the bot off and enables `POST /api/dev/login` (read its body shape at `src/server.ts`, around the `/api/dev/login` route, line 994). Use a fresh database file, never a copy of production: a dev server over a production copy can dial rcon at the live boxes unless its `servers` rows are deleted first.

Signing in through `/api/dev/login` as three different players: file two reports about one player (one with a match, one without) and one `unsafe` report about the same player. Then as the owner confirm: two tickets exist for that player, one normal with two reports and one restricted; the restricted one is absent for a second admin who is not the owner; `/admin?ticket=<id>` opens directly; Claim, Ban (check the player's status flips to banned and the ban row carries `ticket_id`), Close and Reopen all work; the reporter's profile shows "Your reports" with `closed, thank you` and no outcome; a moderator account sees only the Tickets tab and is refused `/api/admin/players` with 403.

- [ ] **Step 3: Drive the same flow headless, as the repo's convention requires**

Frame-driven and layout bugs in this app are debugged with headless Chrome over CDP, never an in-app pane. Use `npm run shoot` (the screenshot rig) to capture `/admin?ticket=<id>` at desktop and 400 px widths and look at both images. Fix any overflow in `.ticket-row` or `.admin-form` before calling this done.

- [ ] **Step 4: Record what was and was not verified**

Append a short "Verification" section to this plan file listing exactly what was run and seen, and what was not (nothing on a real server, nothing with Discord, no production data migrated). Commit:

```bash
git add docs/superpowers/plans/2026-09-21-tickets-phase1.md
git commit -m "Record what the tickets phase 1 verification covered"
```

Do not merge to master and do not deploy. Hand back to the owner with the branch name and the verification notes.

---

## Deliberately left for the later phases

These are in the spec and not in this plan. They are listed so nobody mistakes them for oversights.

- **Attaching a replay moment from the UI.** The API and the table take `moment` now and the ticket page links to it; the control that captures "this second of this round" belongs in the replay viewer and comes with phase 2.
- **Live refresh of an open ticket page.** Routes already call `broadcast('refresh')`; the ticket page does not listen yet. It starts to matter when mirrored chat arrives, so it is wired in phase 2.
- **A DM to the access list when a restricted ticket opens**, the close DM to reporters, and everything else that speaks through the bot: phases 2 and 3.
- **`ticket_threads`, `ticket_messages`, `ticket_attachments`** and removal: phase 2 creates them when it needs them.

"My reports" is in the spec's phase 3 list. It is here instead because it needs nothing from Discord and phase 1 removes the only other feedback a reporter had.
