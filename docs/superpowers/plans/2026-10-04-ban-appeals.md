# Ban Appeals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Banned, held and Discord-sanctioned people can file one appeal per ban from the site, a Discord button, or a public `/appeal` page, and staff decide it with fixed-template outcomes.

**Architecture:** A new `src/appeals/` module owns the table, the rules (`canAppeal`), the state machine and the views. Thin surfaces call it: `src/routes/appeals.ts` (player + staff HTTP), a Discord sign-in branch in `src/routes/discordAuth.ts`, a standing Discord button (`src/discord/appealButton.ts`, the Report button pattern) and a reconciler (`src/discord/appealSync.ts`) that keeps a forum post and the appellant's DMs in step with each row's `state`. Every state change is one guarded UPDATE, so races resolve in SQL.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, discord.js behind `BotTransport` (tests use `tests/fakes/fakeTransport.ts`), Preact + preact-iso on the web side, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-04-ban-appeals-design.md` (read it first). Companion, planned separately: `docs/superpowers/specs/2026-10-04-mod-channel-split-design.md`.

## Global Constraints

- Feature ships dark: `appeals_enabled` defaults to `'0'`; nothing a player sees changes until an admin turns it on.
- Defaults: `appeal_min_ban_hours` 24, `appeal_cooldown_days` 7, `appeal_max_per_ban` 2, `appeal_text_max` 1500, `appeal_answer_max` 800, `appeal_answer_hours` 72. Alt holds are exempt from the minimum length.
- One shot: one appeal open per ban; staff ask at most ONE question, only from state `open`; outcomes are fixed templates, staff never send the appellant free text except that one question.
- Who decides: anyone at the issuer's rank or above, the issuer included. An admin-issued ban or sanction needs an admin; anything issued by a moderator or by `system` can be decided by any moderator or admin who can see it.
- The appellant's identity always comes from the Steam session, the appeal cookie or the Discord interaction, never from a request body. A body names WHICH ban (`kind` + `id`), and that ref is accepted only if it is among the identity's own active bans/sanctions.
- No em dashes anywhere (code, comments, copy, commits). Copy is plain and short.
- Run the FULL suite (`npm test`) at the end of every task, not just the new file: `tests/db.test.ts` (exhaustive table list) and `tests/mergePlayers.test.ts` (FK sweep) catch cross-cutting misses. ECONNREFUSED noise in test output is known and pre-existing. 20 scrimRoutes/bookingRecovery failures are pre-existing on master; compare against master before treating a failure as yours.
- A fresh worktree has no `dist/`; run `npm run build` once before the suite or `tests/server.test.ts`'s malformed-URL case fails for reasons that are not yours.
- Never `git stash` (shared with other sessions). Commit on branch `ban-appeals` in this worktree.

## Deviations from the spec, decided while planning (owner approved the spec, these are implementation calls)

1. **No in-game pointer.** `sm_addban` writes `banned_user.cfg`; a banned SteamID is refused by the engine with its own fixed text and the reason string never reaches the player. Appending the appeal URL to the reason would show nowhere, so `banCommand` is untouched. The bot's ban reply and the site panel carry the pointer instead.
2. **Appeal sign-in is a signed cookie, not an `appeal_sessions` table.** `pug_appeal` = `discordId.issuedAt.nameBase64url`, signed with the cookie secret, 1 hour. Nothing to reap, nothing to merge.
3. **No IP rate limiter.** The site has no client-IP plumbing (`trustProxy` is off, so `req.ip` would be the proxy) and nothing can be filed without an active ban, which the DB caps at one open appeal and `appeal_max_per_ban` in total. The DB caps are the limit.
4. **Moot by sweep, not by hooks in every lift path.** The 60 s reaper calls `sweepAppeals`, and every decision re-checks that the ban is still in force first. One place, no lift path can forget it.
5. **Shorten applies to website bans only.** A hold is lifted or kept; a Discord ban has no end; shortening a Discord timeout would need a new Discord call. Those get Accept and Deny.
6. **No forum post for quiet appeals.** An appeal by a staff member, or against a ban/sanction from a restricted ticket, is worked on the site only, exactly as restricted tickets have no staff thread (owner ruling 2026-09-22). This keeps `forumAudience` untouched. Such appeals also post nothing to the feed and are audited `quiet`.
7. **"No appeals" is set from the appeal page,** after an appeal exists (the realistic moment an admin wants it), not from the ban list.
8. **Accepting an appeal on a Discord sanction issued by a moderator may be done by a moderator** (owner ruling 2), although the tickets lift route says only admins lift.
9. **Accept lifts the appealed ban only** (`liftOneBan`), not every open ban the player has, unlike the panel's Unban button.

## Review Focus

1. A banned player with TWO open bans (an abandon ban plus a ticket ban): each is listed and appealed separately; accepting one leaves the player banned by the other, and status is restored only when none remain.
2. A forged ref: a signed-in banned player POSTs `{kind:'ban', id:<someone else's ban>}`; expect 409 `You have nothing to appeal.` and no row.
3. An appeal whose ban expires while it waits, then a moderator presses Deny: expect 409 "the ban is no longer in force", row `moot`, nothing counted against the player.
4. A Discord-banned person signs in at `/appeal` with no players row at all: their sanction is listed and appealable, and the answer route accepts their cookie.
5. Restart while an appeal post is being created: the tickets forum's orphan sweep must not delete appeal posts (it now knows `appeals.forum_thread_id`).

Each of these has a test in the task that owns it (Tasks 2, 5, 3/4, 6, 7).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/appeals/types.ts` (new) | Shared types and constants: refs, states, row shape, `OPEN_STATES`, `refColumn`. Leaf module. |
| `src/appeals/schema.ts` (new) | `ensureAppealSchema(db)`: `appeals`, `appeal_message`, `no_appeal` columns. |
| `src/appeals/rules.ts` (new) | Settings, appellant identity, active targets, `judge`, `canAppeal`, refusal text, next-appeal date. |
| `src/appeals/signals.ts` (new) | In-process pub/sub: "appeal N changed". |
| `src/appeals/access.ts` (new) | Who may see and decide an appeal; whether it is quiet. |
| `src/appeals/store.ts` (new) | `fileAppeal`, `askQuestion`, `answerQuestion`, `recordDecision`, `sweepAppeals`, `getAppeal`. |
| `src/appeals/decide.ts` (new) | Carrying out a decision on a website ban (lift one, lift hold, shorten). |
| `src/appeals/templates.ts` (new) | Every sentence the appellant reads (site line, DM, sanction DM). |
| `src/appeals/views.ts` (new) | Player view and staff list/detail. |
| `src/appeals/appealSession.ts` (new) | The `pug_appeal` cookie. |
| `src/routes/appeals.ts` (new) | Player and staff HTTP routes. |
| `src/discord/appealSync.ts` (new) | Forum post + DMs reconciler. |
| `src/discord/appealButton.ts` (new) | Standing Appeal button and its modal. |
| `src/admin/players.ts` | `liftOneBan`; `banMessage` gains the appeal pointer. |
| `src/routes/discordAuth.ts` | `/auth/discord/appeal` and the appeal branch of the callback. |
| `src/adminFeed.ts`, `src/discord/adminFeedPoster.ts` | `appeal` feed event. |
| `src/discord/ticketSync.ts` | Orphan sweep knows appeal posts. |
| `src/routes/tickets.ts` | Sanction DM with the appeal pointer. |
| `src/db.ts`, `src/settingsSchema.ts`, `src/mergePlayers.ts`, `src/server.ts` | Wiring. |
| `web/src/api.ts`, `web/src/components/AppealBox.tsx`, `web/src/routes/Appeal.tsx`, `web/src/routes/Play.tsx`, `web/src/AppRoutes.tsx` | Player side. |
| `web/src/routes/admin/PeopleAppeals.tsx`, `AdminAppeal.tsx`, `adminRoutes.ts`, `Admin.tsx`, `StaffGuide.tsx` | Staff side. |

---

### Task 1: Schema, settings, merge and `liftOneBan`

**Files:**
- Create: `src/appeals/types.ts`, `src/appeals/schema.ts`
- Modify: `src/db.ts` (call before `seed(db)` at the end of `openDb`, ~line 2266; add DEFAULT_SETTINGS keys ~line 1166), `src/settingsSchema.ts`, `src/mergePlayers.ts:28-60` (PLAIN), `src/admin/players.ts` (after `unbanPlayer`, ~line 131)
- Test: `tests/appealsSchema.test.ts` (new), `tests/db.test.ts` (table list), `tests/mergePlayers.test.ts` (runs unchanged; must stay green)

**Interfaces:**
- Produces: everything in `types.ts` (below); `ensureAppealSchema(db: DB): void`; `liftOneBan(db: DB, banId: number, by: string, now?: Date): boolean` (true when this call lifted it).

- [ ] **Step 1: Write `src/appeals/types.ts`** (no test of its own; types only)

```ts
/**
 * Shared shapes for ban appeals (spec docs/superpowers/specs/2026-10-04-ban-appeals-design.md).
 * A leaf: imports nothing from the rest of src/appeals, so every other
 * appeals module can import it without a cycle.
 */

/** What an appeal is about: a row in `bans` (a website ban or an alt hold)
 *  or a row in `discord_sanctions` (a bot-run Discord timeout or ban). */
export type AppealRef = { kind: 'ban'; id: number } | { kind: 'sanction'; id: number };

export type AppealState =
  | 'open' | 'asked' | 'answered'
  | 'accepted' | 'shortened' | 'denied' | 'auto_denied' | 'lapsed' | 'moot';

/** Still waiting on someone. Everything else is settled. */
export const OPEN_STATES: readonly AppealState[] = ['open', 'asked', 'answered'];

/** Count as a turned-down appeal: they start the cooldown. */
export const DENIAL_STATES: readonly AppealState[] = ['denied', 'auto_denied', 'lapsed'];

export type AppealSource = 'site' | 'discord_button' | 'appeal_page';

/** One `appeals` row as SQLite returns it. */
export interface AppealRow {
  id: number;
  ban_id: number | null;
  sanction_id: number | null;
  steamid: string | null;
  discord_id: string | null;
  appellant_name: string;
  what_happened: string;
  why_lift: string;
  state: AppealState;
  question: string | null;
  asked_by: string | null;
  asked_at: string | null;
  answer: string | null;
  answered_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  new_expires_at: string | null;
  slurs: string | null;
  source: AppealSource;
  created_at: string;
  forum_thread_id: string | null;
  forum_message_id: string | null;
  forum_state: string | null;
  dm_state: string | null;
}

/** Who is appealing. `steamids`: every player account this person may speak
 *  for (one for a Steam session; for a Discord identity, each account linked
 *  to it now or before). `discordId`: their Discord, when known. */
export interface Appellant {
  steamids: string[];
  discordId: string | null;
  name: string;
}

/** One ban, hold or Discord sanction in force against an appellant. */
export interface Appealable {
  ref: AppealRef;
  /** The banned player (bans only). */
  steamid: string | null;
  /** The sanctioned Discord id (sanctions only). */
  discordId: string | null;
  reason: string;
  createdBy: string;
  createdAt: string;
  endsAt: string | null;
  hold: boolean;
  sanctionKind: 'timeout' | 'ban' | null;
  ticketId: number | null;
  noAppeal: boolean;
}

export const refColumn = (ref: AppealRef): 'ban_id' | 'sanction_id' => (ref.kind === 'ban' ? 'ban_id' : 'sanction_id');
export const sameRef = (a: AppealRef, b: AppealRef): boolean => a.kind === b.kind && a.id === b.id;
export const refOf = (row: Pick<AppealRow, 'ban_id' | 'sanction_id'>): AppealRef =>
  (row.ban_id !== null ? { kind: 'ban', id: row.ban_id } : { kind: 'sanction', id: row.sanction_id! });
```

- [ ] **Step 2: Write the failing schema test** `tests/appealsSchema.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { openDb, DEFAULT_SETTINGS } from '../src/db.js';
import { SETTINGS_SCHEMA } from '../src/settingsSchema.js';
import { upsertPlayer, activatePlayer, getPlayer } from '../src/players.js';
import { insertBan, liftOneBan, activeBan } from '../src/admin/players.js';
import { subscribeBanChanges } from '../src/banEvents.js';
import { ensureAppealSchema } from '../src/appeals/schema.js';

const P = '76561198000000001';
const insertAppeal = (db: ReturnType<typeof openDb>, banId: number, state: string) =>
  db.prepare(`INSERT INTO appeals (ban_id, steamid, appellant_name, what_happened, why_lift, state, source, created_at)
              VALUES (?, ?, 'p', 'a', 'b', ?, 'site', '2026-10-04T00:00:00.000Z')`).run(banId, P, state);

describe('appeals schema', () => {
  it('allows one open appeal per ban, any number of settled ones', () => {
    const db = openDb(':memory:');
    upsertPlayer(db, { steamid: P, name: 'p', avatar: null }, []);
    const ban = insertBan(db, P, 'system', 'abandon', 60 * 48);
    insertAppeal(db, ban, 'denied');
    insertAppeal(db, ban, 'open');
    expect(() => insertAppeal(db, ban, 'asked')).toThrow(/UNIQUE/);
    insertAppeal(db, ban, 'moot');
  });

  it('refuses a row about both a ban and a sanction, or neither', () => {
    const db = openDb(':memory:');
    expect(() => db.prepare(`INSERT INTO appeals (appellant_name, discord_id, what_happened, why_lift, state, source, created_at)
      VALUES ('x', '1', 'a', 'b', 'open', 'site', 'now')`).run()).toThrow(/CHECK/);
  });

  it('adds no_appeal to bans and discord_sanctions, and is idempotent', () => {
    const db = openDb(':memory:');
    ensureAppealSchema(db);
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('bans')).toContain('no_appeal');
    expect(cols('discord_sanctions')).toContain('no_appeal');
  });

  it('every appeal setting is seeded and in the Settings schema, off by default', () => {
    const keys = ['appeals_enabled', 'appeal_min_ban_hours', 'appeal_cooldown_days', 'appeal_max_per_ban',
      'appeal_text_max', 'appeal_answer_max', 'appeal_answer_hours'];
    for (const k of keys) {
      expect(DEFAULT_SETTINGS[k], k).toBeDefined();
      expect(SETTINGS_SCHEMA.some((s) => s.key === k), k).toBe(true);
    }
    expect(DEFAULT_SETTINGS.appeals_enabled).toBe('0');
  });
});

describe('liftOneBan', () => {
  it('lifts only the named ban; the player stays banned while another is open', () => {
    const db = openDb(':memory:');
    upsertPlayer(db, { steamid: P, name: 'p', avatar: null }, []);
    activatePlayer(db, P);
    const a = insertBan(db, P, 'system', 'abandon', 60 * 48);
    const b = insertBan(db, P, 'admin', 'toxic', null);
    const changes: string[] = [];
    const off = subscribeBanChanges((e) => changes.push(e.kind));
    expect(liftOneBan(db, b, 'mod')).toBe(true);
    expect(activeBan(db, P)?.id).toBe(a);
    expect(getPlayer(db, P)?.status).toBe('banned');
    expect(changes).toEqual([]);
    expect(liftOneBan(db, a, 'mod')).toBe(true);
    expect(getPlayer(db, P)?.status).toBe('active');
    expect(changes).toEqual(['unban']);
    expect(liftOneBan(db, a, 'mod')).toBe(false);
    off();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/appealsSchema.test.ts`
Expected: FAIL, cannot resolve `../src/appeals/schema.js` / `liftOneBan` is not exported.

- [ ] **Step 4: Write `src/appeals/schema.ts`**

```ts
import type { DB } from '../db.js';

const columnsOf = (db: DB, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

/**
 * Ban appeals. Called at the very end of openDb, after widenTicketIdentity
 * (which creates discord_sanctions), so the ALTERs below always have a table.
 *
 * One open appeal per ban is a partial unique index rather than only a
 * check in canAppeal: two submits racing each other both pass the check, and
 * the index is what makes the second one fail.
 */
export function ensureAppealSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS appeals (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      ban_id           INTEGER REFERENCES bans(id),
      sanction_id      INTEGER REFERENCES discord_sanctions(id),
      steamid          TEXT REFERENCES players(steamid),
      discord_id       TEXT,
      appellant_name   TEXT NOT NULL DEFAULT '',
      what_happened    TEXT NOT NULL,
      why_lift         TEXT NOT NULL,
      state            TEXT NOT NULL CHECK (state IN
                         ('open','asked','answered','accepted','shortened','denied','auto_denied','lapsed','moot')),
      question         TEXT,
      asked_by         TEXT,
      asked_at         TEXT,
      answer           TEXT,
      answered_at      TEXT,
      decided_by       TEXT,
      decided_at       TEXT,
      new_expires_at   TEXT,
      slurs            TEXT,
      source           TEXT NOT NULL CHECK (source IN ('site','discord_button','appeal_page')),
      created_at       TEXT NOT NULL,
      forum_thread_id  TEXT,
      forum_message_id TEXT,
      forum_state      TEXT,
      dm_state         TEXT,
      CHECK ((ban_id IS NULL) != (sanction_id IS NULL)),
      CHECK (steamid IS NOT NULL OR discord_id IS NOT NULL)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_appeals_open_ban ON appeals (ban_id)
      WHERE ban_id IS NOT NULL AND state IN ('open','asked','answered');
    CREATE UNIQUE INDEX IF NOT EXISTS idx_appeals_open_sanction ON appeals (sanction_id)
      WHERE sanction_id IS NOT NULL AND state IN ('open','asked','answered');
    CREATE INDEX IF NOT EXISTS idx_appeals_state ON appeals (state);

    -- The standing message carrying the Appeal button, beside the Report
    -- button in the same channel. One row, ever (the report_message pattern).
    CREATE TABLE IF NOT EXISTS appeal_message (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      hash       TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  // Admin-only "this ban cannot be appealed".
  if (!columnsOf(db, 'bans').includes('no_appeal')) db.exec('ALTER TABLE bans ADD COLUMN no_appeal INTEGER NOT NULL DEFAULT 0');
  if (!columnsOf(db, 'discord_sanctions').includes('no_appeal')) {
    db.exec('ALTER TABLE discord_sanctions ADD COLUMN no_appeal INTEGER NOT NULL DEFAULT 0');
  }
}
```

- [ ] **Step 5: Wire it into `src/db.ts`**

Add `import { ensureAppealSchema } from './appeals/schema.js';` with the other imports, and directly above `seed(db);` at the end of `openDb`:

```ts
  // Ban appeals. Last, after widenTicketIdentity has created discord_sanctions.
  ensureAppealSchema(db);
```

In `DEFAULT_SETTINGS`, next to `ticket_mod_ban_max_minutes`:

```ts
  appeals_enabled: '0',
  appeal_min_ban_hours: '24',
  appeal_cooldown_days: '7',
  appeal_max_per_ban: '2',
  appeal_text_max: '1500',
  appeal_answer_max: '800',
  appeal_answer_hours: '72',
```

- [ ] **Step 6: Add the settings to `src/settingsSchema.ts`** (after the `ticket_mod_ban_max_minutes` entry)

```ts
  { key: 'appeals_enabled', group: 'Appeals', label: 'Ban appeals', help: 'Let banned, held and Discord-sanctioned people appeal from the site, the Appeal button (beside the Report button) and /appeal. Off: they are told to message staff, as before.', type: { kind: 'bool' } },
  { key: 'appeal_min_ban_hours', group: 'Appeals', label: 'Shortest ban that can be appealed (hours)', help: 'Shorter bans run out before anyone could review them. Alt holds can always be appealed.', type: { kind: 'int', min: 0, max: 8760 } },
  { key: 'appeal_cooldown_days', group: 'Appeals', label: 'Wait after a denied appeal (days)', help: 'How long after a denial before the same ban can be appealed again. An unanswered question and an automatic denial count as denials.', type: { kind: 'int', min: 0, max: 90 } },
  { key: 'appeal_max_per_ban', group: 'Appeals', label: 'Appeals per ban', help: 'How many appeals one ban gets in total. An appeal closed because the ban ended on its own does not count.', type: { kind: 'int', min: 1, max: 10 } },
  { key: 'appeal_text_max', group: 'Appeals', label: 'Appeal length (characters per box)', help: 'Each of the two boxes on the appeal form. Discord forms cap at 4000.', type: { kind: 'int', min: 200, max: 4000 } },
  { key: 'appeal_answer_max', group: 'Appeals', label: 'Answer length (characters)', help: 'The answer to the one question staff may ask.', type: { kind: 'int', min: 100, max: 4000 } },
  { key: 'appeal_answer_hours', group: 'Appeals', label: 'Time to answer (hours)', help: 'After staff ask their one question. No answer in time closes the appeal as denied.', type: { kind: 'int', min: 1, max: 336 } },
```

- [ ] **Step 7: Register merge columns** in `src/mergePlayers.ts` PLAIN, after `['bans', 'player_id'],`

```ts
  ['appeals', 'steamid'],
  ['appeals', 'asked_by'],
  ['appeals', 'decided_by'],
```

- [ ] **Step 8: Add `liftOneBan` to `src/admin/players.ts`** directly after `unbanPlayer`

```ts
/**
 * Lift one ban by id, the way an accepted appeal does. Unlike unbanPlayer,
 * which lifts every open ban, a player under a second ban stays banned:
 * an appeal is about one ban. Status is restored, and the game servers told,
 * only once nothing else holds the player. False when the ban was already
 * lifted (or never existed), so a racing second caller changes nothing.
 */
export function liftOneBan(db: DB, banId: number, by: string, now = new Date()): boolean {
  const row = db.prepare('SELECT player_id FROM bans WHERE id = ? AND lifted_at IS NULL').get(banId) as
    | { player_id: string } | undefined;
  if (!row) return false;
  let lifted = false;
  let freed = false;
  db.transaction(() => {
    lifted = db.prepare('UPDATE bans SET lifted_by = ?, lifted_at = ? WHERE id = ? AND lifted_at IS NULL')
      .run(by, now.toISOString(), banId).changes > 0;
    if (lifted && !activeBan(db, row.player_id, now)) {
      restoreStatus(db, row.player_id);
      freed = true;
    }
  })();
  if (freed) publishBanChange({ kind: 'unban', steamid: row.player_id });
  return lifted;
}
```

- [ ] **Step 9: Update `tests/db.test.ts`'s table list**: insert `'appeal_message', 'appeals',` after `'alt_holds',`.

- [ ] **Step 10: Run the new test, then the full suite**

Run: `npx vitest run tests/appealsSchema.test.ts` then `npm test`
Expected: new file PASS; full suite green apart from the known pre-existing failures. `tests/mergePlayers.test.ts` "handles every foreign key that points at players" must pass (it fails if `appeals.steamid` is not in PLAIN).

- [ ] **Step 11: Commit**

```bash
git add src/appeals/types.ts src/appeals/schema.ts src/db.ts src/settingsSchema.ts src/mergePlayers.ts src/admin/players.ts tests/appealsSchema.test.ts tests/db.test.ts
git commit -m "Appeals: table, settings (off by default), merge columns, and liftOneBan for lifting a single ban"
```

---

### Task 2: Rules (`canAppeal`)

**Files:**
- Create: `src/appeals/rules.ts`
- Test: `tests/appealRules.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces:
  - `appealSettings(db: DB): { enabled: boolean; minBanHours: number; cooldownDays: number; maxPerBan: number; textMax: number; answerMax: number; answerHours: number }`
  - `appellantFromSteam(db: DB, steamid: string): Appellant`
  - `appellantFromDiscord(db: DB, discordId: string, name: string): Appellant`
  - `activeTargets(db: DB, who: Appellant, now?: Date): Appealable[]`
  - `type Refusal = 'disabled' | 'nothing_to_appeal' | 'too_short' | 'already_open' | 'cooldown' | 'limit_reached' | 'marked_final'`
  - `type Verdict = { ok: true; target: Appealable } | { ok: false; reason: Refusal; opensAt?: string }`
  - `judge(db: DB, target: Appealable, now?: Date): Verdict`
  - `canAppeal(db: DB, who: Appellant, ref: AppealRef, now?: Date): Verdict`
  - `refusalText(v: Extract<Verdict, { ok: false }>): string`
  - `nextAppealAt(db: DB, ref: AppealRef, now?: Date): string | null` (when this ban may be appealed again after a settled appeal; null when never)
  - `refKey(ref: AppealRef): string` / `parseRefKey(s: string): AppealRef | null` (`'ban:12'`)

- [ ] **Step 1: Write the failing test** `tests/appealRules.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { upsertPlayer, linkDiscord, unlinkDiscord } from '../src/players.js';
import { insertBan } from '../src/admin/players.js';
import {
  activeTargets, appellantFromDiscord, appellantFromSteam, canAppeal, nextAppealAt, parseRefKey, refKey, refusalText,
} from '../src/appeals/rules.js';

const P = '76561198000000001';
const Q = '76561198000000002';
const NOW = new Date('2026-10-04T12:00:00.000Z');
const H = 60; // minutes in an hour
let db: DB;

const appeal = (banId: number, state: string, decidedAt: string | null = null) =>
  db.prepare(`INSERT INTO appeals (ban_id, steamid, appellant_name, what_happened, why_lift, state, source, created_at, decided_at)
              VALUES (?, ?, 'p', 'a', 'b', ?, 'site', ?, ?)`).run(banId, P, state, NOW.toISOString(), decidedAt);
const sanction = (discordId: string, kind: 'timeout' | 'ban', until: string | null) =>
  Number(db.prepare(`INSERT INTO discord_sanctions (discord_id, kind, until, reason, ticket_id, created_by, created_at)
              VALUES (?, ?, ?, 'spam', NULL, ?, ?)`).run(discordId, kind, until, Q, NOW.toISOString()).lastInsertRowid);

beforeEach(() => {
  db = openDb(':memory:');
  setSetting(db, 'appeals_enabled', '1');
  upsertPlayer(db, { steamid: P, name: 'p', avatar: null }, []);
  upsertPlayer(db, { steamid: Q, name: 'q', avatar: null }, []);
});

describe('canAppeal', () => {
  it('is refused while appeals are off', () => {
    setSetting(db, 'appeals_enabled', '0');
    const ban = insertBan(db, P, 'system', 'abandon', 48 * H, NOW);
    const v = canAppeal(db, appellantFromSteam(db, P), { kind: 'ban', id: ban }, NOW);
    expect(v).toEqual({ ok: false, reason: 'disabled' });
  });

  it('allows a 48 hour ban and refuses a 2 hour one', () => {
    const long = insertBan(db, P, 'system', 'abandon', 48 * H, NOW);
    const short = insertBan(db, P, 'system', 'abandon', 2 * H, NOW);
    const me = appellantFromSteam(db, P);
    expect(canAppeal(db, me, { kind: 'ban', id: long }, NOW).ok).toBe(true);
    expect(canAppeal(db, me, { kind: 'ban', id: short }, NOW)).toEqual({ ok: false, reason: 'too_short' });
  });

  it('always allows a permanent ban and an alt hold, however short', () => {
    const perm = insertBan(db, P, 'admin', 'toxic', null, NOW);
    const hold = insertBan(db, Q, 'system', 'On hold', null, NOW, 'alt_hold');
    expect(canAppeal(db, appellantFromSteam(db, P), { kind: 'ban', id: perm }, NOW).ok).toBe(true);
    expect(canAppeal(db, appellantFromSteam(db, Q), { kind: 'ban', id: hold }, NOW).ok).toBe(true);
  });

  it('refuses someone else\'s ban as nothing to appeal (a forged ref)', () => {
    const theirs = insertBan(db, Q, 'admin', 'toxic', null, NOW);
    expect(canAppeal(db, appellantFromSteam(db, P), { kind: 'ban', id: theirs }, NOW))
      .toEqual({ ok: false, reason: 'nothing_to_appeal' });
  });

  it('refuses a second open appeal, then counts settled ones toward the limit', () => {
    const ban = insertBan(db, P, 'admin', 'toxic', null, NOW);
    const me = appellantFromSteam(db, P);
    appeal(ban, 'open');
    expect(canAppeal(db, me, { kind: 'ban', id: ban }, NOW)).toEqual({ ok: false, reason: 'already_open' });
    db.prepare("UPDATE appeals SET state = 'denied', decided_at = ?").run('2026-09-01T00:00:00.000Z');
    expect(canAppeal(db, me, { kind: 'ban', id: ban }, NOW).ok).toBe(true);
    appeal(ban, 'lapsed', '2026-09-02T00:00:00.000Z');
    expect(canAppeal(db, me, { kind: 'ban', id: ban }, NOW)).toEqual({ ok: false, reason: 'limit_reached' });
  });

  it('a moot appeal counts for nothing', () => {
    const ban = insertBan(db, P, 'admin', 'toxic', null, NOW);
    appeal(ban, 'moot', '2026-10-01T00:00:00.000Z');
    appeal(ban, 'moot', '2026-10-02T00:00:00.000Z');
    expect(canAppeal(db, appellantFromSteam(db, P), { kind: 'ban', id: ban }, NOW).ok).toBe(true);
  });

  it('waits out the cooldown after a denial and says when it opens', () => {
    const ban = insertBan(db, P, 'admin', 'toxic', null, NOW);
    appeal(ban, 'denied', '2026-10-01T12:00:00.000Z');
    const v = canAppeal(db, appellantFromSteam(db, P), { kind: 'ban', id: ban }, NOW);
    expect(v).toEqual({ ok: false, reason: 'cooldown', opensAt: '2026-10-08T12:00:00.000Z' });
    if (!v.ok) expect(refusalText(v)).toMatch(/You can appeal again after/);
    expect(nextAppealAt(db, { kind: 'ban', id: ban }, NOW)).toBe('2026-10-08T12:00:00.000Z');
  });

  it('refuses a ban an admin marked final', () => {
    const ban = insertBan(db, P, 'admin', 'toxic', null, NOW);
    db.prepare('UPDATE bans SET no_appeal = 1 WHERE id = ?').run(ban);
    expect(canAppeal(db, appellantFromSteam(db, P), { kind: 'ban', id: ban }, NOW))
      .toEqual({ ok: false, reason: 'marked_final' });
  });

  it('refuses a lifted or expired ban as nothing to appeal', () => {
    const ban = insertBan(db, P, 'system', 'abandon', 48 * H, new Date('2026-09-01T00:00:00.000Z'));
    expect(canAppeal(db, appellantFromSteam(db, P), { kind: 'ban', id: ban }, NOW))
      .toEqual({ ok: false, reason: 'nothing_to_appeal' });
  });
});

describe('appellants and targets', () => {
  it('a Discord identity speaks for every account it is or was linked to, and for its own sanctions', () => {
    linkDiscord(db, P, '900', 'dethisa');
    unlinkDiscord(db, P);
    linkDiscord(db, Q, '900', 'dethisa');
    insertBan(db, P, 'admin', 'old account', null, NOW);
    insertBan(db, Q, 'system', 'On hold', null, NOW, 'alt_hold');
    sanction('900', 'timeout', '2026-10-20T00:00:00.000Z');
    const who = appellantFromDiscord(db, '900', 'dethisa');
    expect(new Set(who.steamids)).toEqual(new Set([P, Q]));
    const kinds = activeTargets(db, who, NOW).map((t) => `${t.ref.kind}:${t.hold ? 'hold' : t.sanctionKind ?? 'ban'}`);
    expect(kinds.sort()).toEqual(['ban:ban', 'ban:hold', 'sanction:timeout']);
  });

  it('a Discord-only person with no player row still sees their sanction', () => {
    sanction('901', 'ban', null);
    const who = appellantFromDiscord(db, '901', 'stranger');
    expect(who.steamids).toEqual([]);
    const [t] = activeTargets(db, who, NOW);
    expect(t.sanctionKind).toBe('ban');
    expect(canAppeal(db, who, t.ref, NOW).ok).toBe(true);
  });

  it('refKey round-trips and rejects junk', () => {
    expect(parseRefKey(refKey({ kind: 'sanction', id: 7 }))).toEqual({ kind: 'sanction', id: 7 });
    expect(parseRefKey('ban:x')).toBeNull();
    expect(parseRefKey('other:1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/appealRules.test.ts`
Expected: FAIL, cannot resolve `../src/appeals/rules.js`.

- [ ] **Step 3: Write `src/appeals/rules.ts`**

```ts
import type { DB } from '../db.js';
import { getSetting, settingNumber } from '../settings.js';
import { getPlayer } from '../players.js';
import {
  DENIAL_STATES, OPEN_STATES, refColumn, type AppealRef, type Appealable, type Appellant,
} from './types.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function appealSettings(db: DB) {
  return {
    enabled: getSetting(db, 'appeals_enabled') === '1',
    minBanHours: settingNumber(db, 'appeal_min_ban_hours', 24, { min: 0, integer: true }),
    cooldownDays: settingNumber(db, 'appeal_cooldown_days', 7, { min: 0, integer: true }),
    maxPerBan: settingNumber(db, 'appeal_max_per_ban', 2, { min: 1, integer: true }),
    textMax: settingNumber(db, 'appeal_text_max', 1500, { min: 1, integer: true }),
    answerMax: settingNumber(db, 'appeal_answer_max', 800, { min: 1, integer: true }),
    answerHours: settingNumber(db, 'appeal_answer_hours', 72, { min: 1, integer: true }),
  };
}

export function appellantFromSteam(db: DB, steamid: string): Appellant {
  const p = getPlayer(db, steamid);
  return { steamids: [steamid], discordId: p?.discord_id ?? null, name: p?.name ?? steamid };
}

/** Every account this Discord is linked to now or was before: a banned
 *  account cannot unlink, so "before" mostly covers an alt hold, where the
 *  Discord moved to the held account from the one it came from. */
export function appellantFromDiscord(db: DB, discordId: string, name: string): Appellant {
  const steamids = (db.prepare(
    `SELECT steamid FROM players WHERE discord_id = ?
     UNION SELECT steamid FROM discord_link_history WHERE discord_id = ?`,
  ).all(discordId, discordId) as { steamid: string }[]).map((r) => r.steamid);
  return { steamids, discordId, name };
}

/** Every ban, hold and Discord sanction in force against this person,
 *  newest first. The only source of "what may this person appeal", so a ref
 *  that is not in here is not theirs. */
export function activeTargets(db: DB, who: Appellant, now = new Date()): Appealable[] {
  const iso = now.toISOString();
  const out: Appealable[] = [];
  for (const steamid of who.steamids) {
    const bans = db.prepare(
      `SELECT id, player_id, reason, created_by, created_at, expires_at, kind, ticket_id, no_appeal FROM bans
       WHERE player_id = ? AND lifted_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY id DESC`,
    ).all(steamid, iso) as {
      id: number; player_id: string; reason: string; created_by: string; created_at: string;
      expires_at: string | null; kind: string; ticket_id: number | null; no_appeal: number;
    }[];
    for (const b of bans) {
      out.push({
        ref: { kind: 'ban', id: b.id }, steamid: b.player_id, discordId: null, reason: b.reason,
        createdBy: b.created_by, createdAt: b.created_at, endsAt: b.expires_at, hold: b.kind === 'alt_hold',
        sanctionKind: null, ticketId: b.ticket_id, noAppeal: b.no_appeal === 1,
      });
    }
  }
  if (who.discordId) {
    const rows = db.prepare(
      `SELECT id, discord_id, kind, until, reason, ticket_id, created_by, created_at, no_appeal FROM discord_sanctions
       WHERE discord_id = ? AND lifted_at IS NULL AND (until IS NULL OR until > ?) ORDER BY id DESC`,
    ).all(who.discordId, iso) as {
      id: number; discord_id: string; kind: 'timeout' | 'ban'; until: string | null; reason: string;
      ticket_id: number | null; created_by: string; created_at: string; no_appeal: number;
    }[];
    for (const s of rows) {
      out.push({
        ref: { kind: 'sanction', id: s.id }, steamid: null, discordId: s.discord_id, reason: s.reason,
        createdBy: s.created_by, createdAt: s.created_at, endsAt: s.until, hold: false,
        sanctionKind: s.kind, ticketId: s.ticket_id, noAppeal: s.no_appeal === 1,
      });
    }
  }
  return out;
}

export type Refusal = 'disabled' | 'nothing_to_appeal' | 'too_short' | 'already_open' | 'cooldown' | 'limit_reached' | 'marked_final';
export type Verdict = { ok: true; target: Appealable } | { ok: false; reason: Refusal; opensAt?: string };

/** Settled appeals on this ref that count: everything but open ones and moot. */
function counted(db: DB, ref: AppealRef): { n: number; lastDenial: string | null } {
  const col = refColumn(ref);
  const open = OPEN_STATES.map(() => '?').join(',');
  const deny = DENIAL_STATES.map(() => '?').join(',');
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM appeals WHERE ${col} = ? AND state NOT IN (${open}) AND state != 'moot'`)
    .get(ref.id, ...OPEN_STATES) as { n: number }).n;
  const last = db.prepare(`SELECT MAX(decided_at) AS at FROM appeals WHERE ${col} = ? AND state IN (${deny})`)
    .get(ref.id, ...DENIAL_STATES) as { at: string | null };
  return { n, lastDenial: last.at };
}

/** The rules for one ban already known to be the appellant's and in force. */
export function judge(db: DB, target: Appealable, now = new Date()): Verdict {
  const s = appealSettings(db);
  if (!s.enabled) return { ok: false, reason: 'disabled' };
  if (target.noAppeal) return { ok: false, reason: 'marked_final' };
  if (!target.hold && target.endsAt !== null
    && Date.parse(target.endsAt) - Date.parse(target.createdAt) < s.minBanHours * HOUR_MS) {
    return { ok: false, reason: 'too_short' };
  }
  const col = refColumn(target.ref);
  const open = db.prepare(`SELECT 1 FROM appeals WHERE ${col} = ? AND state IN (${OPEN_STATES.map(() => '?').join(',')})`)
    .get(target.ref.id, ...OPEN_STATES);
  if (open) return { ok: false, reason: 'already_open' };
  const c = counted(db, target.ref);
  if (c.n >= s.maxPerBan) return { ok: false, reason: 'limit_reached' };
  if (c.lastDenial) {
    const opens = Date.parse(c.lastDenial) + s.cooldownDays * DAY_MS;
    if (opens > now.getTime()) return { ok: false, reason: 'cooldown', opensAt: new Date(opens).toISOString() };
  }
  return { ok: true, target };
}

export function canAppeal(db: DB, who: Appellant, ref: AppealRef, now = new Date()): Verdict {
  if (!appealSettings(db).enabled) return { ok: false, reason: 'disabled' };
  const target = activeTargets(db, who, now).find((t) => t.ref.kind === ref.kind && t.ref.id === ref.id);
  if (!target) return { ok: false, reason: 'nothing_to_appeal' };
  return judge(db, target, now);
}

const fmtDate = (iso: string) => new Date(iso).toUTCString().replace(/:\d\d GMT$/, ' UTC');

export function refusalText(v: Extract<Verdict, { ok: false }>): string {
  switch (v.reason) {
    case 'disabled': return 'Appeals are not open right now. Message a moderator in the Discord instead.';
    case 'nothing_to_appeal': return 'You have nothing to appeal.';
    case 'too_short': return 'This ban is too short to appeal. It ends on its own soon.';
    case 'already_open': return 'You already have an appeal open for this. Staff will get to it.';
    case 'cooldown': return `Your last appeal for this was turned down. You can appeal again after ${fmtDate(v.opensAt!)}.`;
    case 'limit_reached': return 'You have used every appeal for this ban.';
    case 'marked_final': return 'This ban cannot be appealed.';
  }
}

/** When this ban may next be appealed, judged on settled appeals alone, or
 *  null when it never may (the limit is reached). For the denial message. */
export function nextAppealAt(db: DB, ref: AppealRef, now = new Date()): string | null {
  const s = appealSettings(db);
  const c = counted(db, ref);
  if (c.n >= s.maxPerBan) return null;
  if (!c.lastDenial) return now.toISOString();
  return new Date(Math.max(now.getTime(), Date.parse(c.lastDenial) + s.cooldownDays * DAY_MS)).toISOString();
}

export const refKey = (ref: AppealRef): string => `${ref.kind}:${ref.id}`;

export function parseRefKey(s: string): AppealRef | null {
  const m = /^(ban|sanction):(\d{1,12})$/.exec(s);
  return m ? { kind: m[1] as 'ban' | 'sanction', id: Number(m[2]) } : null;
}
```

- [ ] **Step 4: Run the test, then the full suite**

Run: `npx vitest run tests/appealRules.test.ts` then `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/appeals/rules.ts tests/appealRules.test.ts
git commit -m "Appeals: canAppeal, the one rule check every entry point uses (length, open, limit, cooldown, final)"
```

---

### Task 3: Store and state machine

**Files:**
- Create: `src/appeals/signals.ts`, `src/appeals/access.ts`, `src/appeals/store.ts`
- Modify: `src/adminFeed.ts` (new `appeal` event + FEED_SETTING entry), `src/discord/adminFeedPoster.ts` (render it)
- Test: `tests/appealStore.test.ts`

**Interfaces:**
- Consumes: Task 1, Task 2.
- Produces:
  - `publishAppealSignal(id: number): void`, `subscribeAppealSignals(fn: (id: number) => void): () => void`
  - access: `canSeeAppeal(db, viewer: FileViewer, row: AppealRow): boolean`; `issuerOf(db, row): string`; `issuerIsAdmin(db, createdBy: string): boolean`; `decideCheck(db, viewer: FileViewer, row: AppealRow): { ok: true } | Fail`; `appealIsQuiet(db, row): boolean`; `type Fail = { ok: false; status: number; error: string }`
  - store: `getAppeal(db, id): AppealRow | undefined`; `fileAppeal(db, who, input: { ref: AppealRef; whatHappened: unknown; whyLift: unknown; source: AppealSource }, now?): { ok: true; id: number; state: 'open' | 'auto_denied' } | Fail`; `askQuestion(db, id, by, question: unknown, now?): { ok: true } | Fail`; `answerQuestion(db, who, id, answer: unknown, now?): { ok: true; state: 'answered' | 'auto_denied' } | Fail`; `recordDecision(db, id, by, state: 'accepted' | 'shortened' | 'denied', newExpiresAt: string | null, now?): boolean`; `mootAppeal(db, id, now?): boolean`; `targetInForce(db, row, now?): boolean`; `sweepAppeals(db, now?): { lapsed: number[]; moot: number[] }`; `ownsAppeal(who: Appellant, row: AppealRow): boolean`
  - AdminEvent `{ kind: 'appeal'; appealId: number; what: 'filed' | 'auto_denied'; name: string; slurs: string[] }`

- [ ] **Step 1: Write the failing test** `tests/appealStore.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { upsertPlayer } from '../src/players.js';
import { insertBan } from '../src/admin/players.js';
import { appellantFromSteam } from '../src/appeals/rules.js';
import {
  answerQuestion, askQuestion, fileAppeal, getAppeal, recordDecision, sweepAppeals,
} from '../src/appeals/store.js';
import { subscribeAppealSignals } from '../src/appeals/signals.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { fileViewer } from '../src/admin/fileAccess.js';
import { canSeeAppeal, decideCheck } from '../src/appeals/access.js';

const P = '76561198000000001';
const MOD = '76561198000000008';
const ADMIN = '76561198000000009';
const NOW = new Date('2026-10-04T12:00:00.000Z');
let db: DB;
let signals: number[];
let events: AdminEvent[];
let offs: (() => void)[];

beforeEach(() => {
  db = openDb(':memory:');
  setSetting(db, 'appeals_enabled', '1');
  for (const [id, name] of [[P, 'p'], [MOD, 'mod'], [ADMIN, 'admin']]) upsertPlayer(db, { steamid: id, name, avatar: null }, []);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  signals = []; events = [];
  offs = [subscribeAppealSignals((id) => signals.push(id)), subscribeAdminEvents((e) => { if (e.kind === 'appeal') events.push(e); })];
});
afterEach(() => { for (const off of offs) off(); });

const file = (banId: number, what = 'I lagged out', why = 'It was my router') =>
  fileAppeal(db, appellantFromSteam(db, P), { ref: { kind: 'ban', id: banId }, whatHappened: what, whyLift: why, source: 'site' }, NOW);

describe('fileAppeal', () => {
  it('files an open appeal, signals it and announces it to the feed', () => {
    const ban = insertBan(db, P, 'system', 'abandon', 48 * 60, NOW);
    const r = file(ban);
    expect(r).toMatchObject({ ok: true, state: 'open' });
    const row = getAppeal(db, (r as { id: number }).id)!;
    expect(row).toMatchObject({ ban_id: ban, steamid: P, appellant_name: 'p', state: 'open', source: 'site' });
    expect(signals).toEqual([row.id]);
    expect(events).toEqual([{ kind: 'appeal', appealId: row.id, what: 'filed', name: 'p', slurs: [] }]);
  });

  it('refuses empty or overlong text, and a second open appeal', () => {
    const ban = insertBan(db, P, 'system', 'abandon', 48 * 60, NOW);
    expect(file(ban, '   ')).toMatchObject({ ok: false, status: 400 });
    expect(file(ban, 'x'.repeat(1501))).toMatchObject({ ok: false, status: 400 });
    expect(file(ban).ok).toBe(true);
    expect(file(ban)).toEqual({ ok: false, status: 409, error: 'You already have an appeal open for this. Staff will get to it.' });
  });

  it('a slur denies it at once, counts it, and says so in the feed', () => {
    const ban = insertBan(db, P, 'admin', 'toxic', null, NOW);
    const r = file(ban, 'you are all retards');
    expect(r).toMatchObject({ ok: true, state: 'auto_denied' });
    const row = getAppeal(db, (r as { id: number }).id)!;
    expect(row.decided_by).toBe('system');
    expect(JSON.parse(row.slurs!)).toEqual(['r-word']);
    expect(events[0]).toMatchObject({ what: 'auto_denied', slurs: ['r-word'] });
  });

  it('an appeal by staff is quiet: nothing to the feed', () => {
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(P);
    const ban = insertBan(db, P, 'admin', 'toxic', null, NOW);
    expect(file(ban).ok).toBe(true);
    expect(events).toEqual([]);
  });
});

describe('question and answer', () => {
  it('one question, only from open; one answer, only from asked and in time', () => {
    const ban = insertBan(db, P, 'admin', 'toxic', null, NOW);
    const id = (file(ban) as { id: number }).id;
    expect(askQuestion(db, id, MOD, 'Which match?', NOW)).toEqual({ ok: true });
    expect(askQuestion(db, id, MOD, 'And another?', NOW)).toMatchObject({ ok: false, status: 409 });
    const me = appellantFromSteam(db, P);
    const late = new Date(NOW.getTime() + 73 * 3600_000);
    expect(answerQuestion(db, me, id, 'Match 400', late)).toMatchObject({ ok: false, status: 409 });
    expect(answerQuestion(db, me, id, 'Match 400', NOW)).toEqual({ ok: true, state: 'answered' });
    expect(answerQuestion(db, me, id, 'again', NOW)).toMatchObject({ ok: false, status: 409 });
    expect(getAppeal(db, id)).toMatchObject({ state: 'answered', question: 'Which match?', answer: 'Match 400', asked_by: MOD });
  });

  it('someone else cannot answer (404, not 403)', () => {
    const ban = insertBan(db, P, 'admin', 'toxic', null, NOW);
    const id = (file(ban) as { id: number }).id;
    askQuestion(db, id, MOD, 'Which match?', NOW);
    expect(answerQuestion(db, appellantFromSteam(db, MOD), id, 'me', NOW)).toMatchObject({ ok: false, status: 404 });
  });
});

describe('decisions and the sweep', () => {
  it('only the first decision lands', () => {
    const ban = insertBan(db, P, 'admin', 'toxic', null, NOW);
    const id = (file(ban) as { id: number }).id;
    expect(recordDecision(db, id, ADMIN, 'denied', null, NOW)).toBe(true);
    expect(recordDecision(db, id, MOD, 'accepted', null, NOW)).toBe(false);
    expect(getAppeal(db, id)).toMatchObject({ state: 'denied', decided_by: ADMIN });
  });

  it('lapses an unanswered question and moots an appeal whose ban ended', () => {
    const a = insertBan(db, P, 'admin', 'toxic', null, NOW);
    const asked = (file(a) as { id: number }).id;
    askQuestion(db, asked, MOD, 'Which match?', NOW);
    const b = insertBan(db, P, 'system', 'abandon', 48 * 60, NOW);
    const waiting = (file(b) as { id: number }).id;
    const later = new Date(NOW.getTime() + 73 * 3600_000);
    expect(sweepAppeals(db, later)).toEqual({ lapsed: [asked], moot: [waiting] });
    expect(getAppeal(db, asked)!.state).toBe('lapsed');
    expect(getAppeal(db, waiting)!.state).toBe('moot');
  });
});

describe('access', () => {
  it('a moderator cannot see or decide an appeal about staff; the rank rule follows the issuer', () => {
    const ban = insertBan(db, P, ADMIN, 'toxic', null, NOW);
    const id = (file(ban) as { id: number }).id;
    const row = getAppeal(db, id)!;
    expect(canSeeAppeal(db, fileViewer(db, MOD), row)).toBe(true);
    expect(decideCheck(db, fileViewer(db, MOD), row)).toMatchObject({ ok: false, status: 403 });
    expect(decideCheck(db, fileViewer(db, ADMIN), row)).toEqual({ ok: true });
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(P);
    expect(canSeeAppeal(db, fileViewer(db, MOD), row)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/appealStore.test.ts`
Expected: FAIL, missing modules.

- [ ] **Step 3: Write `src/appeals/signals.ts`**

```ts
/** "Appeal N changed." Fired after the write has committed; the Discord
 *  reconciler (appealSync) listens. In process only, like banEvents. */
type Listener = (appealId: number) => void;
const listeners = new Set<Listener>();

export function publishAppealSignal(appealId: number): void {
  for (const fn of listeners) {
    try {
      fn(appealId);
    } catch (err) {
      console.error('[appeals] listener failed:', err);
    }
  }
}

export function subscribeAppealSignals(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
```

- [ ] **Step 4: Write `src/appeals/access.ts`**

```ts
import type { DB } from '../db.js';
import { canOpenFile, type FileViewer } from '../admin/fileAccess.js';
import { banIsWithheld } from '../admin/banRedaction.js';
import { canSeeTicket, getTicketRow, hasStaffFlag } from '../tickets/store.js';
import { OPEN_STATES, type AppealRow } from './types.js';

export type Fail = { ok: false; status: number; error: string };

/** The ban or sanction row behind an appeal: who issued it and its ticket. */
function source(db: DB, row: AppealRow): { createdBy: string; ticketId: number | null } {
  const r = row.ban_id !== null
    ? db.prepare('SELECT created_by, ticket_id FROM bans WHERE id = ?').get(row.ban_id)
    : db.prepare('SELECT created_by, ticket_id FROM discord_sanctions WHERE id = ?').get(row.sanction_id);
  const s = r as { created_by: string; ticket_id: number | null } | undefined;
  return { createdBy: s?.created_by ?? 'system', ticketId: s?.ticket_id ?? null };
}

export const issuerOf = (db: DB, row: AppealRow): string => source(db, row).createdBy;

/** 'system' (abandon bans, alt holds) and moderators are moderator rank. */
export function issuerIsAdmin(db: DB, createdBy: string): boolean {
  const p = db.prepare('SELECT is_admin FROM players WHERE steamid = ?').get(createdBy) as { is_admin: number } | undefined;
  return p?.is_admin === 1;
}

/**
 * The file rules, applied to an appeal. A moderator never sees an appeal by
 * staff (canOpenFile keeps them out of staff files), and nobody sees one
 * against a ban or sanction from a restricted ticket they cannot see.
 * Callers answer 404, never 403, as for files and tickets.
 */
export function canSeeAppeal(db: DB, viewer: FileViewer, row: AppealRow): boolean {
  if (!viewer.isAdmin && !viewer.isMod) return false;
  if (row.steamid !== null && !canOpenFile(db, viewer, row.steamid)) return false;
  const { ticketId } = source(db, row);
  if (row.ban_id !== null) return !banIsWithheld(db, ticketId, viewer.steamid);
  if (ticketId === null) return true;
  const t = getTicketRow(db, ticketId);
  return !!t && canSeeTicket(db, t, viewer.steamid);
}

/** Owner ruling 2 (2026-10-04): anyone at the issuer's rank or above,
 *  the issuer included. */
export function decideCheck(db: DB, viewer: FileViewer, row: AppealRow): { ok: true } | Fail {
  if (!canSeeAppeal(db, viewer, row)) return { ok: false, status: 404, error: 'no such appeal' };
  if (!OPEN_STATES.includes(row.state)) return { ok: false, status: 409, error: 'this appeal has already been decided' };
  if (!viewer.isAdmin && issuerIsAdmin(db, issuerOf(db, row))) {
    return { ok: false, status: 403, error: 'only an admin can decide an appeal against an admin\'s ban' };
  }
  return { ok: true };
}

/** Worked on the site alone: no forum post, no feed line, audited quiet.
 *  An appeal by staff, or against a ban or sanction from a restricted
 *  ticket (restricted tickets have no staff thread either). Fails closed
 *  when the ticket row is gone. */
export function appealIsQuiet(db: DB, row: AppealRow): boolean {
  if (row.steamid !== null && hasStaffFlag(db, row.steamid)) return true;
  const { ticketId } = source(db, row);
  if (ticketId === null) return false;
  const t = getTicketRow(db, ticketId);
  return !t || t.restricted === 1;
}
```

- [ ] **Step 5: Add the feed event.** In `src/adminFeed.ts`, add to the `AdminEvent` union:

```ts
  /** A ban appeal was filed, or denied at once for a slur. Quiet appeals
   *  (by staff, or from a restricted ticket) never publish this. */
  | { kind: 'appeal'; appealId: number; what: 'filed' | 'auto_denied'; name: string; slurs: string[] }
```

and to `FEED_SETTING`: `appeal: 'admin_feed_reports',`.

In `src/discord/adminFeedPoster.ts`, inside the `switch (e.kind)` of the line builder (next to `case 'report':`), add:

```ts
      case 'appeal': {
        const link = `[#${e.appealId}](${this.deps.publicUrl}/admin/people/appeals/${e.appealId})`;
        // Like a report: with a staff forum, the appeal's own post is the
        // announcement. An automatic denial always posts: nobody else will.
        if (e.what === 'filed') {
          if (getSetting(this.deps.db, 'discord_tickets_forum_id')) return null;
          return { text: `📨 New appeal ${link} from ${escapeName(e.name)}.`, color: COLOR.report };
        }
        return { text: `📨 Appeal ${link} from ${escapeName(e.name)} was denied automatically: ${e.slurs.join(', ')}.`, color: COLOR.problem };
      }
```

(`line()` already returns `{ text; color } | null`, and `deliver` skips a null line.)

- [ ] **Step 6: Write `src/appeals/store.ts`**

```ts
import type { DB } from '../db.js';
import { findSlurs } from '../slurs.js';
import { publishAdminEvent } from '../adminFeed.js';
import { appealSettings, canAppeal, refusalText } from './rules.js';
import { publishAppealSignal } from './signals.js';
import { appealIsQuiet, type Fail } from './access.js';
import { OPEN_STATES, type AppealRef, type AppealRow, type AppealSource, type Appellant } from './types.js';

const fail = (status: number, error: string): Fail => ({ ok: false, status, error });
const inList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(',');
const OPEN_SQL = inList(OPEN_STATES);

export function getAppeal(db: DB, id: number): AppealRow | undefined {
  return db.prepare('SELECT * FROM appeals WHERE id = ?').get(id) as AppealRow | undefined;
}

/** The appellant may act on this row: it is about one of their accounts,
 *  or about their own Discord sanction. */
export function ownsAppeal(who: Appellant, row: AppealRow): boolean {
  if (row.steamid !== null) return who.steamids.includes(row.steamid);
  return row.sanction_id !== null && row.discord_id !== null && row.discord_id === who.discordId;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function fileAppeal(
  db: DB, who: Appellant,
  input: { ref: AppealRef; whatHappened: unknown; whyLift: unknown; source: AppealSource },
  now = new Date(),
): { ok: true; id: number; state: 'open' | 'auto_denied' } | Fail {
  const s = appealSettings(db);
  const what = text(input.whatHappened);
  const why = text(input.whyLift);
  if (!what || !why) return fail(400, 'Fill in both boxes.');
  if (what.length > s.textMax || why.length > s.textMax) return fail(400, `Each box takes up to ${s.textMax} characters.`);
  const slurs = [...new Set([...findSlurs(what), ...findSlurs(why)])];
  const iso = now.toISOString();
  let result: { ok: true; id: number; state: 'open' | 'auto_denied' } | Fail;
  try {
    result = db.transaction(() => {
      const v = canAppeal(db, who, input.ref, now);
      if (!v.ok) return fail(409, refusalText(v));
      const t = v.target;
      const state = slurs.length > 0 ? 'auto_denied' as const : 'open' as const;
      const id = Number(db.prepare(
        `INSERT INTO appeals (ban_id, sanction_id, steamid, discord_id, appellant_name, what_happened, why_lift, state,
                              decided_by, decided_at, slurs, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.ref.kind === 'ban' ? input.ref.id : null, input.ref.kind === 'sanction' ? input.ref.id : null,
        t.steamid, t.discordId ?? who.discordId, who.name.slice(0, 100), what, why, state,
        state === 'auto_denied' ? 'system' : null, state === 'auto_denied' ? iso : null,
        slurs.length > 0 ? JSON.stringify(slurs) : null, input.source, iso,
      ).lastInsertRowid);
      return { ok: true as const, id, state };
    })();
  } catch (err) {
    // The partial unique index: a second submit raced the first past canAppeal.
    if (String(err).includes('UNIQUE')) return fail(409, refusalText({ ok: false, reason: 'already_open' }));
    throw err;
  }
  if (result.ok) {
    const row = getAppeal(db, result.id)!;
    if (!appealIsQuiet(db, row)) {
      publishAdminEvent({ kind: 'appeal', appealId: row.id, what: result.state === 'open' ? 'filed' : 'auto_denied', name: row.appellant_name, slurs });
    }
    publishAppealSignal(result.id);
  }
  return result;
}

export function askQuestion(db: DB, id: number, by: string, question: unknown, now = new Date()): { ok: true } | Fail {
  const q = text(question);
  if (!q || q.length > 500) return fail(400, 'A question is up to 500 characters.');
  const changed = db.prepare("UPDATE appeals SET state = 'asked', question = ?, asked_by = ?, asked_at = ? WHERE id = ? AND state = 'open'")
    .run(q, by, now.toISOString(), id).changes > 0;
  if (!changed) return fail(409, 'A question can only be asked once, before anything else happens.');
  publishAppealSignal(id);
  return { ok: true };
}

export function answerQuestion(
  db: DB, who: Appellant, id: number, answer: unknown, now = new Date(),
): { ok: true; state: 'answered' | 'auto_denied' } | Fail {
  const row = getAppeal(db, id);
  if (!row || !ownsAppeal(who, row)) return fail(404, 'no such appeal');
  if (row.state !== 'asked') return fail(409, 'There is no question waiting for an answer.');
  const s = appealSettings(db);
  if (Date.parse(row.asked_at!) + s.answerHours * 3600_000 <= now.getTime()) return fail(409, 'The time to answer has run out.');
  const a = text(answer);
  if (!a || a.length > s.answerMax) return fail(400, `An answer is up to ${s.answerMax} characters.`);
  const slurs = findSlurs(a);
  const iso = now.toISOString();
  const state = slurs.length > 0 ? 'auto_denied' as const : 'answered' as const;
  const changed = db.prepare(
    `UPDATE appeals SET state = ?, answer = ?, answered_at = ?,
       decided_by = CASE WHEN ? = 'auto_denied' THEN 'system' ELSE decided_by END,
       decided_at = CASE WHEN ? = 'auto_denied' THEN ? ELSE decided_at END,
       slurs = CASE WHEN ? = 'auto_denied' THEN ? ELSE slurs END
     WHERE id = ? AND state = 'asked'`,
  ).run(state, a, iso, state, state, iso, state, JSON.stringify(slurs), id).changes > 0;
  if (!changed) return fail(409, 'There is no question waiting for an answer.');
  if (state === 'auto_denied' && !appealIsQuiet(db, row)) {
    publishAdminEvent({ kind: 'appeal', appealId: id, what: 'auto_denied', name: row.appellant_name, slurs });
  }
  publishAppealSignal(id);
  return { ok: true, state };
}

/** The one guarded write behind every staff decision. False: somebody else
 *  decided first, or the appeal was closed by the sweep. */
export function recordDecision(
  db: DB, id: number, by: string, state: 'accepted' | 'shortened' | 'denied', newExpiresAt: string | null, now = new Date(),
): boolean {
  const changed = db.prepare(
    `UPDATE appeals SET state = ?, decided_by = ?, decided_at = ?, new_expires_at = ? WHERE id = ? AND state IN (${OPEN_SQL})`,
  ).run(state, by, now.toISOString(), newExpiresAt, id).changes > 0;
  if (changed) publishAppealSignal(id);
  return changed;
}

export function mootAppeal(db: DB, id: number, now = new Date()): boolean {
  const changed = db.prepare(
    `UPDATE appeals SET state = 'moot', decided_by = 'system', decided_at = ? WHERE id = ? AND state IN (${OPEN_SQL})`,
  ).run(now.toISOString(), id).changes > 0;
  if (changed) publishAppealSignal(id);
  return changed;
}

/** Whether the ban or sanction an appeal is about is still in force. */
export function targetInForce(db: DB, row: AppealRow, now = new Date()): boolean {
  const iso = now.toISOString();
  return row.ban_id !== null
    ? !!db.prepare('SELECT 1 FROM bans WHERE id = ? AND lifted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)').get(row.ban_id, iso)
    : !!db.prepare('SELECT 1 FROM discord_sanctions WHERE id = ? AND lifted_at IS NULL AND (until IS NULL OR until > ?)').get(row.sanction_id, iso);
}

/** Runs on the 60 s reaper. An unanswered question past its time closes as
 *  lapsed (counts as a denial); an appeal whose ban has ended any other way
 *  closes as moot (counts for nothing). */
export function sweepAppeals(db: DB, now = new Date()): { lapsed: number[]; moot: number[] } {
  const s = appealSettings(db);
  const cutoff = new Date(now.getTime() - s.answerHours * 3600_000).toISOString();
  const lapsed: number[] = [];
  for (const { id } of db.prepare("SELECT id FROM appeals WHERE state = 'asked' AND asked_at <= ?").all(cutoff) as { id: number }[]) {
    const changed = db.prepare("UPDATE appeals SET state = 'lapsed', decided_by = 'system', decided_at = ? WHERE id = ? AND state = 'asked'")
      .run(now.toISOString(), id).changes > 0;
    if (changed) { lapsed.push(id); publishAppealSignal(id); }
  }
  const moot: number[] = [];
  for (const row of db.prepare(`SELECT * FROM appeals WHERE state IN (${OPEN_SQL})`).all() as AppealRow[]) {
    if (!targetInForce(db, row, now) && mootAppeal(db, row.id, now)) moot.push(row.id);
  }
  return { lapsed, moot };
}
```

- [ ] **Step 7: Run the test, then the full suite**

Run: `npx vitest run tests/appealStore.test.ts` then `npm test`
Expected: PASS. If `tests/discordAdminFeed.test.ts` enumerates every event kind, add an `appeal` case to it rendering both `what` values.

- [ ] **Step 8: Commit**

```bash
git add src/appeals/signals.ts src/appeals/access.ts src/appeals/store.ts src/adminFeed.ts src/discord/adminFeedPoster.ts tests/appealStore.test.ts
git commit -m "Appeals: filing, the one question, guarded decisions, the lapse/moot sweep and the feed line"
```

---

### Task 4: Carrying out a decision, templates and views

**Files:**
- Create: `src/appeals/decide.ts`, `src/appeals/templates.ts`, `src/appeals/views.ts`
- Test: `tests/appealDecide.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3, `liftAltHold` (`src/altHolds.ts`), `liftOneBan`.
- Produces:
  - `decideBanAppeal(db, row: AppealRow, by: string, outcome: 'accept' | 'shorten' | 'deny', endsAt: unknown, now?): { ok: true } | Fail`
  - `STATE_LABEL: Record<AppealState, string>`; `playerLine(db, row, now?): string | null`; `dmText(db, row, publicUrl, now?): string | null`; `sanctionDmText(kind: 'timeout' | 'ban', until: string | null, reason: string, appealUrl: string | null): string`
  - `playerView(db, who, now?): MyAppeals`; `staffAppeals(db, viewer, which: 'open' | 'closed'): StaffAppealRow[]`; `staffAppeal(db, viewer, id, now?): StaffAppealDetail | null` (types below, mirrored in `web/src/api.ts` in Task 9)

- [ ] **Step 1: Write the failing test** `tests/appealDecide.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { upsertPlayer, activatePlayer, getPlayer } from '../src/players.js';
import { insertBan, activeBan } from '../src/admin/players.js';
import { placeAltHold } from '../src/altHolds.js';
import { appellantFromSteam } from '../src/appeals/rules.js';
import { fileAppeal, getAppeal } from '../src/appeals/store.js';
import { decideBanAppeal } from '../src/appeals/decide.js';
import { dmText, playerLine } from '../src/appeals/templates.js';
import { playerView, staffAppeal } from '../src/appeals/views.js';
import { fileViewer } from '../src/admin/fileAccess.js';

const P = '76561198000000001';
const OTHER = '76561198000000002';
const MOD = '76561198000000008';
const NOW = new Date('2026-10-04T12:00:00.000Z');
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  setSetting(db, 'appeals_enabled', '1');
  for (const id of [P, OTHER, MOD]) { upsertPlayer(db, { steamid: id, name: `n${id.slice(-1)}`, avatar: null }, []); activatePlayer(db, id); }
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
});

const fileFor = (banId: number) => {
  const r = fileAppeal(db, appellantFromSteam(db, P), { ref: { kind: 'ban', id: banId }, whatHappened: 'a', whyLift: 'b', source: 'site' }, NOW);
  return getAppeal(db, (r as { id: number }).id)!;
};

describe('decideBanAppeal', () => {
  it('accept lifts only the appealed ban', () => {
    const a = insertBan(db, P, 'system', 'abandon', 48 * 60, NOW);
    const b = insertBan(db, P, MOD, 'griefing', 72 * 60, NOW);
    expect(decideBanAppeal(db, fileFor(b), MOD, 'accept', null, NOW)).toEqual({ ok: true });
    expect(activeBan(db, P, NOW)?.id).toBe(a);
    expect(getPlayer(db, P)!.status).toBe('banned');
  });

  it('accept on a hold closes the hold and frees the account', () => {
    const holdId = placeAltHold(db, P, OTHER, '900', 'dethisa', NOW)!;
    const banId = (db.prepare('SELECT ban_id FROM alt_holds WHERE id = ?').get(holdId) as { ban_id: number }).ban_id;
    expect(decideBanAppeal(db, fileFor(banId), MOD, 'accept', null, NOW)).toEqual({ ok: true });
    expect(activeBan(db, P, NOW)).toBeNull();
    expect((db.prepare('SELECT resolution FROM alt_holds WHERE id = ?').get(holdId) as { resolution: string }).resolution).toBe('cleared');
  });

  it('shorten moves the end earlier and refuses a later or past end, or a hold', () => {
    const ban = insertBan(db, P, MOD, 'griefing', 7 * 24 * 60, NOW);
    const row = fileFor(ban);
    expect(decideBanAppeal(db, row, MOD, 'shorten', '2026-10-30T00:00:00.000Z', NOW)).toMatchObject({ ok: false, status: 400 });
    expect(decideBanAppeal(db, row, MOD, 'shorten', '2026-10-01T00:00:00.000Z', NOW)).toMatchObject({ ok: false, status: 400 });
    expect(decideBanAppeal(db, row, MOD, 'shorten', '2026-10-06T00:00:00.000Z', NOW)).toEqual({ ok: true });
    expect(activeBan(db, P, NOW)!.expiresAt).toBe('2026-10-06T00:00:00.000Z');
    expect(getAppeal(db, row.id)).toMatchObject({ state: 'shortened', new_expires_at: '2026-10-06T00:00:00.000Z' });
  });

  it('a ban that ended while waiting moots the appeal instead of deciding it', () => {
    const ban = insertBan(db, P, 'system', 'abandon', 48 * 60, NOW);
    const row = fileFor(ban);
    const later = new Date(NOW.getTime() + 49 * 3600_000);
    expect(decideBanAppeal(db, row, MOD, 'deny', null, later)).toMatchObject({ ok: false, status: 409 });
    expect(getAppeal(db, row.id)!.state).toBe('moot');
  });
});

describe('what people read', () => {
  it('the player line and DM follow the state; a denial says when they may try again', () => {
    const ban = insertBan(db, P, MOD, 'griefing', null, NOW);
    const row = fileFor(ban);
    expect(playerLine(db, row, NOW)).toBe('Your appeal was received. Staff will review it.');
    decideBanAppeal(db, row, MOD, 'deny', null, NOW);
    const denied = getAppeal(db, row.id)!;
    expect(dmText(db, denied, 'https://pug.test', NOW)).toMatch(/the ban stands\. You can appeal again after/);
  });

  it('playerView lists the ban with its latest appeal; staffAppeal names the issuer', () => {
    const ban = insertBan(db, P, MOD, 'griefing', null, NOW);
    const row = fileFor(ban);
    const v = playerView(db, appellantFromSteam(db, P), NOW);
    expect(v.items).toHaveLength(1);
    expect(v.items[0]).toMatchObject({ canAppeal: false, appeal: { id: row.id, state: 'open' } });
    const d = staffAppeal(db, fileViewer(db, MOD), row.id, NOW)!;
    expect(d.target).toMatchObject({ reason: 'griefing', createdByName: 'n8' });
    expect(d.canDecide).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/appealDecide.test.ts`
Expected: FAIL, missing modules.

- [ ] **Step 3: Write `src/appeals/decide.ts`**

```ts
import type { DB } from '../db.js';
import { liftOneBan } from '../admin/players.js';
import { liftAltHold } from '../altHolds.js';
import { mootAppeal, recordDecision, targetInForce } from './store.js';
import type { Fail } from './access.js';
import type { AppealRow } from './types.js';

const fail = (status: number, error: string): Fail => ({ ok: false, status, error });

/**
 * Carry out a staff decision on an appeal against a WEBSITE ban or hold
 * (a Discord sanction is decided in the route, which has to call Discord).
 * decideCheck has already said this viewer may decide it.
 *
 * The decision is recorded first, by the guarded UPDATE, so of two staff
 * pressing at once exactly one goes on to lift anything. Lifting happens
 * after and on its own: liftOneBan and liftAltHold each commit and then tell
 * the game servers, which must never happen inside an outer transaction.
 */
export function decideBanAppeal(
  db: DB, row: AppealRow, by: string, outcome: 'accept' | 'shorten' | 'deny', endsAt: unknown, now = new Date(),
): { ok: true } | Fail {
  const ban = db.prepare('SELECT id, kind, expires_at FROM bans WHERE id = ?').get(row.ban_id) as
    | { id: number; kind: string; expires_at: string | null } | undefined;
  if (!ban) return fail(404, 'no such appeal');
  if (!targetInForce(db, row, now)) {
    mootAppeal(db, row.id, now);
    return fail(409, 'The ban is no longer in force, so the appeal has been closed.');
  }
  if (outcome === 'shorten') {
    if (ban.kind === 'alt_hold') return fail(400, 'A hold is lifted or kept; it cannot be shortened.');
    const t = typeof endsAt === 'string' ? Date.parse(endsAt) : NaN;
    if (!Number.isFinite(t)) return fail(400, 'Pick when the ban should end.');
    if (t <= now.getTime() + 60_000) return fail(400, 'Pick a time in the future.');
    if (ban.expires_at !== null && t >= Date.parse(ban.expires_at)) return fail(400, 'Pick a time before the ban ends now.');
    const iso = new Date(t).toISOString();
    if (!recordDecision(db, row.id, by, 'shortened', iso, now)) return fail(409, 'this appeal has already been decided');
    db.prepare('UPDATE bans SET expires_at = ? WHERE id = ? AND lifted_at IS NULL').run(iso, ban.id);
    return { ok: true };
  }
  if (outcome === 'deny') {
    return recordDecision(db, row.id, by, 'denied', null, now) ? { ok: true } : fail(409, 'this appeal has already been decided');
  }
  if (!recordDecision(db, row.id, by, 'accepted', null, now)) return fail(409, 'this appeal has already been decided');
  const hold = db.prepare('SELECT id FROM alt_holds WHERE ban_id = ? AND resolved_at IS NULL').get(ban.id) as { id: number } | undefined;
  if (hold) liftAltHold(db, hold.id, by, now);
  else liftOneBan(db, ban.id, by, now);
  return { ok: true };
}
```

- [ ] **Step 4: Write `src/appeals/templates.ts`**

```ts
import type { DB } from '../db.js';
import { appealSettings, nextAppealAt } from './rules.js';
import { refOf, type AppealRow, type AppealState } from './types.js';

export const STATE_LABEL: Record<AppealState, string> = {
  open: 'Waiting for staff',
  asked: 'Question asked',
  answered: 'Answered, waiting for staff',
  accepted: 'Accepted',
  shortened: 'Shortened',
  denied: 'Denied',
  auto_denied: 'Denied automatically',
  lapsed: 'No answer in time',
  moot: 'Closed, the ban ended',
};

const fmt = (iso: string) => new Date(iso).toUTCString().replace(/:\d\d GMT$/, ' UTC');
const answerBy = (db: DB, row: AppealRow) => new Date(Date.parse(row.asked_at!) + appealSettings(db).answerHours * 3600_000).toISOString();

function again(db: DB, row: AppealRow, now: Date): string {
  const at = nextAppealAt(db, refOf(row), now);
  return at ? ` You can appeal again after ${fmt(at)}.` : '';
}

/** What the appellant reads on the site. Fixed sentences only: staff never
 *  add their own words to an outcome. */
export function playerLine(db: DB, row: AppealRow, now = new Date()): string | null {
  switch (row.state) {
    case 'open': case 'answered': return 'Your appeal was received. Staff will review it.';
    case 'asked': return `Staff have one question about your appeal. Answer it by ${fmt(answerBy(db, row))}.`;
    case 'accepted': return 'Your appeal was accepted. The ban has been lifted.';
    case 'shortened': return `Your appeal was reviewed. The ban now ends ${fmt(row.new_expires_at!)}.`;
    case 'denied': case 'auto_denied': case 'lapsed': return `Your appeal was reviewed and the ban stands.${again(db, row, now)}`;
    case 'moot': return null;
  }
}

/** The DM for a state, or null when that state sends none ('open' and
 *  'answered' are the appellant's own doing; 'moot' needs no word). */
export function dmText(db: DB, row: AppealRow, publicUrl: string, now = new Date()): string | null {
  const link = `${publicUrl}/appeal`;
  switch (row.state) {
    case 'open': case 'answered': case 'moot': return null;
    case 'asked': return `Staff have one question about your appeal:\n> ${row.question!.replace(/\n/g, '\n> ')}\nAnswer it at ${link} by <t:${Math.floor(Date.parse(answerBy(db, row)) / 1000)}:f>.`;
    default: return `${playerLine(db, row, now)} (${link})`;
  }
}

/** Sent to a Discord member when the bot times them out or bans them. */
export function sanctionDmText(kind: 'timeout' | 'ban', until: string | null, reason: string, appealUrl: string | null): string {
  const what = kind === 'ban'
    ? 'You have been banned from the Riverside Discord'
    : `You have been timed out in the Riverside Discord until <t:${Math.floor(Date.parse(until!) / 1000)}:f>`;
  return `${what}. Reason: ${reason}.${appealUrl ? `\nIf you think this was a mistake, you can appeal at ${appealUrl}` : ''}`;
}
```

- [ ] **Step 5: Write `src/appeals/views.ts`**

```ts
import type { DB } from '../db.js';
import type { FileViewer } from '../admin/fileAccess.js';
import { activeTargets, appealSettings, judge, refusalText } from './rules.js';
import { canSeeAppeal, decideCheck } from './access.js';
import { playerLine } from './templates.js';
import { targetInForce } from './store.js';
import { OPEN_STATES, refColumn, type AppealRef, type AppealRow, type AppealState, type Appellant } from './types.js';

export interface PlayerAppealItem {
  ref: AppealRef;
  hold: boolean;
  sanctionKind: 'timeout' | 'ban' | null;
  reason: string;
  endsAt: string | null;
  canAppeal: boolean;
  refusal: string | null;
  appeal: { id: number; state: AppealState; question: string | null; answerBy: string | null; line: string | null; filedAt: string } | null;
}

export interface MyAppeals { enabled: boolean; name: string; textMax: number; answerMax: number; items: PlayerAppealItem[] }

export function playerView(db: DB, who: Appellant, now = new Date()): MyAppeals {
  const s = appealSettings(db);
  const items = activeTargets(db, who, now).map((t): PlayerAppealItem => {
    const v = judge(db, t, now);
    const latest = db.prepare(`SELECT * FROM appeals WHERE ${refColumn(t.ref)} = ? AND state != 'moot' ORDER BY id DESC LIMIT 1`)
      .get(t.ref.id) as AppealRow | undefined;
    return {
      ref: t.ref, hold: t.hold, sanctionKind: t.sanctionKind, reason: t.reason, endsAt: t.endsAt,
      canAppeal: v.ok, refusal: v.ok || v.reason === 'already_open' ? null : refusalText(v),
      appeal: latest ? {
        id: latest.id, state: latest.state, question: latest.state === 'asked' ? latest.question : null,
        answerBy: latest.state === 'asked' ? new Date(Date.parse(latest.asked_at!) + s.answerHours * 3600_000).toISOString() : null,
        line: playerLine(db, latest, now), filedAt: latest.created_at,
      } : null,
    };
  });
  return { enabled: s.enabled, name: who.name, textMax: s.textMax, answerMax: s.answerMax, items };
}

export interface StaffAppealRow {
  id: number; state: AppealState; name: string; steamid: string | null; discordId: string | null;
  about: 'ban' | 'hold' | 'timeout' | 'discord ban'; filedAt: string; decidedAt: string | null;
}

export interface StaffAppealDetail extends StaffAppealRow {
  whatHappened: string; whyLift: string;
  question: string | null; askedByName: string | null; askedAt: string | null;
  answer: string | null; answeredAt: string | null; answerBy: string | null;
  decidedByName: string | null; newExpiresAt: string | null; slurs: string[];
  target: { reason: string; createdByName: string; createdAt: string; endsAt: string | null; ticketId: number | null; noAppeal: boolean; inForce: boolean };
  earlier: { id: number; state: AppealState; decidedAt: string | null }[];
  canDecide: boolean; canShorten: boolean; canMarkFinal: boolean;
}

const nameOf = (db: DB, steamid: string | null): string | null => {
  if (!steamid) return null;
  if (steamid === 'system') return 'automatic';
  return (db.prepare('SELECT name FROM players WHERE steamid = ?').get(steamid) as { name: string } | undefined)?.name ?? steamid;
};

function about(db: DB, row: AppealRow): StaffAppealRow['about'] {
  if (row.ban_id !== null) {
    const k = db.prepare('SELECT kind FROM bans WHERE id = ?').get(row.ban_id) as { kind: string } | undefined;
    return k?.kind === 'alt_hold' ? 'hold' : 'ban';
  }
  const k = db.prepare('SELECT kind FROM discord_sanctions WHERE id = ?').get(row.sanction_id) as { kind: string } | undefined;
  return k?.kind === 'ban' ? 'discord ban' : 'timeout';
}

const toRow = (db: DB, r: AppealRow): StaffAppealRow => ({
  id: r.id, state: r.state, name: r.appellant_name || nameOf(db, r.steamid) || r.discord_id || '?', steamid: r.steamid,
  discordId: r.discord_id, about: about(db, r), filedAt: r.created_at, decidedAt: r.decided_at,
});

export function staffAppeals(db: DB, viewer: FileViewer, which: 'open' | 'closed'): StaffAppealRow[] {
  const inOpen = OPEN_STATES.map((s) => `'${s}'`).join(',');
  const rows = db.prepare(`SELECT * FROM appeals WHERE state ${which === 'open' ? 'IN' : 'NOT IN'} (${inOpen}) ORDER BY id ${which === 'open' ? 'ASC' : 'DESC'} LIMIT 200`)
    .all() as AppealRow[];
  return rows.filter((r) => canSeeAppeal(db, viewer, r)).map((r) => toRow(db, r));
}

export function staffAppeal(db: DB, viewer: FileViewer, id: number, now = new Date()): StaffAppealDetail | null {
  const r = db.prepare('SELECT * FROM appeals WHERE id = ?').get(id) as AppealRow | undefined;
  if (!r || !canSeeAppeal(db, viewer, r)) return null;
  const t = (r.ban_id !== null
    ? db.prepare('SELECT reason, created_by, created_at, expires_at AS ends_at, ticket_id, no_appeal FROM bans WHERE id = ?').get(r.ban_id)
    : db.prepare('SELECT reason, created_by, created_at, until AS ends_at, ticket_id, no_appeal FROM discord_sanctions WHERE id = ?').get(r.sanction_id)) as
    { reason: string; created_by: string; created_at: string; ends_at: string | null; ticket_id: number | null; no_appeal: number };
  const col = r.ban_id !== null ? 'ban_id' : 'sanction_id';
  const earlier = db.prepare(`SELECT id, state, decided_at FROM appeals WHERE ${col} = ? AND id != ? ORDER BY id`)
    .all(r.ban_id ?? r.sanction_id, r.id) as { id: number; state: AppealState; decided_at: string | null }[];
  const ab = about(db, r);
  const canDecide = decideCheck(db, viewer, r).ok;
  const s = appealSettings(db);
  return {
    ...toRow(db, r),
    whatHappened: r.what_happened, whyLift: r.why_lift,
    question: r.question, askedByName: nameOf(db, r.asked_by), askedAt: r.asked_at,
    answer: r.answer, answeredAt: r.answered_at,
    answerBy: r.state === 'asked' ? new Date(Date.parse(r.asked_at!) + s.answerHours * 3600_000).toISOString() : null,
    decidedByName: nameOf(db, r.decided_by), newExpiresAt: r.new_expires_at, slurs: r.slurs ? JSON.parse(r.slurs) as string[] : [],
    target: {
      reason: t.reason, createdByName: nameOf(db, t.created_by) ?? '', createdAt: t.created_at, endsAt: t.ends_at,
      ticketId: t.ticket_id, noAppeal: t.no_appeal === 1, inForce: targetInForce(db, r, now),
    },
    earlier: earlier.map((e) => ({ id: e.id, state: e.state, decidedAt: e.decided_at })),
    canDecide,
    canShorten: canDecide && ab === 'ban',
    canMarkFinal: viewer.isAdmin,
  };
}
```

- [ ] **Step 6: Run the test, then the full suite**

Run: `npx vitest run tests/appealDecide.test.ts` then `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/appeals/decide.ts src/appeals/templates.ts src/appeals/views.ts tests/appealDecide.test.ts
git commit -m "Appeals: carrying out accept/shorten/deny on a ban or hold, the fixed outcome sentences, player and staff views"
```

---

### Task 5: Player routes and the reaper

**Files:**
- Create: `src/appeals/appealSession.ts`, `src/routes/appeals.ts`
- Modify: `src/server.ts` (register routes near `peopleRoutes` ~line 1940; `sweepAppeals` in the reaper after `liftExpiredBans` ~line 1590), `src/admin/players.ts` (`banMessage` pointer), `src/server.ts` callers of `banMessage` (pass `deps.config.publicUrl`)
- Test: `tests/appealRoutes.test.ts` (player half)

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces:
  - `APPEAL_COOKIE`, `setAppealSession(reply, discordId, name, secure, now?)`, `readAppealSession(req, now?): { discordId: string; name: string } | null`, `clearAppealSession(reply)`
  - `appealRoutes(app, opts: { db: DB; moderation: () => ModerationOps | null })` registering: `GET /api/appeals/mine`, `POST /api/appeals`, `POST /api/appeals/:id/answer`, `POST /api/appeals/sign-out` (this task), plus staff routes (Task 6)
  - `banMessage(db, steamid, publicUrl?: string)`

- [ ] **Step 1: Write the failing test** `tests/appealRoutes.test.ts` (player half; Task 6 appends the staff half)

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { setSetting } from '../src/settings.js';
import { upsertPlayer } from '../src/players.js';
import { insertBan, banMessage } from '../src/admin/players.js';
import { APPEAL_COOKIE } from '../src/appeals/appealSession.js';
import { FakeTransport } from './fakes/fakeTransport.js';

export const P = '76561198000000001';
export const Q = '76561198000000002';
export const MOD = '76561198000000008';
export const ADMIN = '76561198000000009';
let db: DB;
let app: FastifyInstance;
let fake: FakeTransport;

beforeEach(async () => {
  db = openDb(':memory:');
  fake = new FakeTransport();
  app = await buildServer({
    config: loadConfig({ PUBLIC_URL: 'https://pug.test' }),
    db, orchestrator: stubOrchestrator(), serverExec: async () => {}, serverCleaner: async () => {},
    discordModeration: fake.moderation,
  });
  setSetting(db, 'appeals_enabled', '1');
  for (const id of [P, Q]) upsertPlayer(db, { steamid: id, name: `n${id.slice(-1)}`, avatar: null }, []);
});
afterEach(async () => { await app.close(); });

/** A banned player's cookie: ban first, then sign in, as a real login would. */
function bannedCookie(steamid: string, minutes: number | null = null, by = 'system') {
  const ban = insertBan(db, steamid, by, 'abandon', minutes);
  return { ban, cookies: authedCookie(app, db, steamid, { active: false }) };
}
const discordCookie = (discordId: string, name = 'stranger') =>
  ({ [APPEAL_COOKIE]: app.signCookie(`${discordId}.${Date.now()}.${Buffer.from(name).toString('base64url')}`) });

describe('player appeal routes', () => {
  it('a banned player sees their ban, files once, and answers the one question', async () => {
    const { ban, cookies } = bannedCookie(P);
    const mine = await app.inject({ method: 'GET', url: '/api/appeals/mine', cookies });
    expect(mine.json()).toMatchObject({ enabled: true, items: [{ ref: { kind: 'ban', id: ban }, canAppeal: true }] });
    const filed = await app.inject({ method: 'POST', url: '/api/appeals', cookies, payload: { kind: 'ban', id: ban, whatHappened: 'lag', whyLift: 'router' } });
    expect(filed.statusCode).toBe(200);
    const id = filed.json().id as number;
    db.prepare("UPDATE appeals SET state = 'asked', question = 'Which map?', asked_by = ?, asked_at = ? WHERE id = ?").run(ADMIN, new Date().toISOString(), id);
    const ans = await app.inject({ method: 'POST', url: `/api/appeals/${id}/answer`, cookies, payload: { answer: 'Dead Air 2' } });
    expect(ans.json()).toEqual({ ok: true, state: 'answered' });
  });

  it('a forged ref (somebody else\'s ban) is refused and nothing is stored', async () => {
    const { cookies } = bannedCookie(P);
    const theirs = insertBan(db, Q, 'system', 'abandon', null);
    const r = await app.inject({ method: 'POST', url: '/api/appeals', cookies, payload: { kind: 'ban', id: theirs, whatHappened: 'a', whyLift: 'b' } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('You have nothing to appeal.');
    expect(db.prepare('SELECT COUNT(*) AS n FROM appeals').get()).toEqual({ n: 0 });
  });

  it('a Discord-only person with no player row appeals their sanction through the appeal cookie', async () => {
    const sid = Number(db.prepare(`INSERT INTO discord_sanctions (discord_id, kind, until, reason, created_by, created_at)
      VALUES ('901', 'ban', NULL, 'spam', ?, ?)`).run(MOD, new Date().toISOString()).lastInsertRowid);
    const cookies = discordCookie('901');
    const mine = await app.inject({ method: 'GET', url: '/api/appeals/mine', cookies });
    expect(mine.json().items).toMatchObject([{ ref: { kind: 'sanction', id: sid }, sanctionKind: 'ban', canAppeal: true }]);
    const filed = await app.inject({ method: 'POST', url: '/api/appeals', cookies, payload: { kind: 'sanction', id: sid, whatHappened: 'a', whyLift: 'b' } });
    expect(filed.statusCode).toBe(200);
    expect(db.prepare('SELECT source, discord_id, appellant_name FROM appeals').get())
      .toEqual({ source: 'appeal_page', discord_id: '901', appellant_name: 'stranger' });
  });

  it('nobody signed in gets 401; an expired appeal cookie is no sign-in', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/appeals/mine' })).statusCode).toBe(401);
    const old = { [APPEAL_COOKIE]: app.signCookie(`901.${Date.now() - 2 * 3600_000}.eA`) };
    expect((await app.inject({ method: 'GET', url: '/api/appeals/mine', cookies: old })).statusCode).toBe(401);
  });

  it('the bot reply points at /appeal only while appeals are on', () => {
    insertBan(db, P, 'system', 'abandon', null);
    expect(banMessage(db, P, 'https://pug.test')).toContain('https://pug.test/appeal');
    setSetting(db, 'appeals_enabled', '0');
    expect(banMessage(db, P, 'https://pug.test')).not.toContain('/appeal');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/appealRoutes.test.ts`
Expected: FAIL, missing module `appealSession.js`.

- [ ] **Step 3: Write `src/appeals/appealSession.ts`**

```ts
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * The /appeal page's sign-in for someone who cannot sign in through Steam,
 * typically a person banned from the Discord. It proves one Discord account
 * and nothing else: no route but the appeal routes ever reads it, and it is
 * not a session in the src/session.ts sense. An hour is enough to write an
 * appeal; there is nothing to revoke, so nothing is stored server side.
 */
export const APPEAL_COOKIE = 'pug_appeal';
export const APPEAL_SESSION_MS = 60 * 60 * 1000;

export function setAppealSession(reply: FastifyReply, discordId: string, name: string, secure: boolean, now = Date.now()): void {
  const value = `${discordId}.${now}.${Buffer.from(name.slice(0, 100), 'utf8').toString('base64url')}`;
  reply.setCookie(APPEAL_COOKIE, value, {
    path: '/', httpOnly: true, signed: true, sameSite: 'lax', secure, maxAge: APPEAL_SESSION_MS / 1000,
  });
}

export function readAppealSession(req: FastifyRequest, now = Date.now()): { discordId: string; name: string } | null {
  const raw = req.cookies[APPEAL_COOKIE];
  if (!raw) return null;
  const u = req.unsignCookie(raw);
  if (!u.valid || !u.value) return null;
  const m = /^(\d{15,22})\.(\d{1,15})\.([A-Za-z0-9_-]*)$/.exec(u.value);
  if (!m) return null;
  const issued = Number(m[2]);
  if (now - issued > APPEAL_SESSION_MS || issued > now + 5 * 60_000) return null;
  return { discordId: m[1], name: Buffer.from(m[3], 'base64url').toString('utf8') };
}

export function clearAppealSession(reply: FastifyReply): void {
  reply.clearCookie(APPEAL_COOKIE, { path: '/' });
}
```

- [ ] **Step 4: Write `src/routes/appeals.ts`** (player half; the staff half is added in Task 6 inside the same function)

```ts
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import type { ModerationOps } from '../discord/transport.js';
import { getSession } from '../session.js';
import { appellantFromDiscord, appellantFromSteam } from '../appeals/rules.js';
import { answerQuestion, fileAppeal } from '../appeals/store.js';
import { playerView } from '../appeals/views.js';
import { clearAppealSession, readAppealSession } from '../appeals/appealSession.js';
import type { AppealRef, AppealSource, Appellant } from '../appeals/types.js';

export interface AppealRouteOpts {
  db: DB;
  moderation: () => ModerationOps | null;
}

export async function appealRoutes(app: FastifyInstance, opts: AppealRouteOpts): Promise<void> {
  const { db } = opts;

  /** A Steam session first (banned players keep theirs), else the appeal
   *  cookie from /appeal's Discord sign-in. Never anything in the body. */
  const appellantOf = (req: FastifyRequest): { who: Appellant; source: AppealSource } | null => {
    const steamid = getSession(req, db);
    if (steamid) return { who: appellantFromSteam(db, steamid), source: 'site' };
    const d = readAppealSession(req);
    return d ? { who: appellantFromDiscord(db, d.discordId, d.name), source: 'appeal_page' } : null;
  };

  const refFrom = (body: unknown): AppealRef | null => {
    const b = (body ?? {}) as { kind?: unknown; id?: unknown };
    const id = Number(b.id);
    if (!Number.isInteger(id) || id <= 0) return null;
    return b.kind === 'ban' || b.kind === 'sanction' ? { kind: b.kind, id } : null;
  };

  app.get('/api/appeals/mine', async (req, reply) => {
    const a = appellantOf(req);
    if (!a) return reply.code(401).send({ error: 'not signed in' });
    return { ...playerView(db, a.who), signedInAs: a.source === 'site' ? 'steam' : 'discord' };
  });

  app.post('/api/appeals', async (req, reply) => {
    const a = appellantOf(req);
    if (!a) return reply.code(401).send({ error: 'not signed in' });
    const ref = refFrom(req.body);
    if (!ref) return reply.code(400).send({ error: 'Pick what you are appealing.' });
    const b = (req.body ?? {}) as { whatHappened?: unknown; whyLift?: unknown };
    const r = fileAppeal(db, a.who, { ref, whatHappened: b.whatHappened, whyLift: b.whyLift, source: a.source });
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return r;
  });

  app.post('/api/appeals/:id/answer', async (req, reply) => {
    const a = appellantOf(req);
    if (!a) return reply.code(401).send({ error: 'not signed in' });
    const r = answerQuestion(db, a.who, Number((req.params as { id: string }).id), ((req.body ?? {}) as { answer?: unknown }).answer);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return r;
  });

  app.post('/api/appeals/sign-out', async (_req, reply) => {
    clearAppealSession(reply);
    return { ok: true };
  });
}
```

- [ ] **Step 5: Wire into `src/server.ts`**

Imports: `import { appealRoutes } from './routes/appeals.js';` and `import { sweepAppeals } from './appeals/store.js';`.

Next to `await app.register(peopleRoutes, { db: deps.db });`:

```ts
  await app.register(appealRoutes, {
    db: deps.db,
    moderation: () => deps.discordModeration ?? bot?.transport.moderation ?? null,
  });
```

(`bot` is declared earlier in `buildServer` at ~line 1702; if `appealRoutes` is registered above that line, move the registration below it, as `ticketRoutes` is.)

In the reaper, directly after the `liftExpiredBans` try block:

```ts
    try {
      sweepAppeals(deps.db);
    } catch (err) {
      console.error('[appeals] sweep failed:', err);
    }
```

- [ ] **Step 6: Point the bot's ban reply at /appeal.** In `src/admin/players.ts` change `banMessage`:

```ts
/** What a banned player is told (Discord uses <t:> timestamps). With
 *  appeals on, it says where to appeal. */
export function banMessage(db: DB, steamid: string, publicUrl?: string): string {
  const ban = activeBan(db, steamid);
  const appeal = publicUrl && getSetting(db, 'appeals_enabled') === '1' ? `\nTo appeal: ${publicUrl}/appeal` : '';
  if (!ban) return `You are banned from the PUG.${appeal}`;
  if (ban.kind === 'alt_hold') return `Your account is on hold. ${ban.reason}.${appeal}`;
  const until = ban.expiresAt ? ` It ends <t:${Math.floor(Date.parse(ban.expiresAt) / 1000)}:R>.` : '';
  return `You are banned from the PUG: ${ban.reason}.${until}${appeal}`;
}
```

Add `import { getSetting } from '../settings.js';` if absent. In `src/server.ts`, both `banMessage: (steamid) => banMessage(deps.db, steamid)` become `banMessage(deps.db, steamid, deps.config.publicUrl)`.

- [ ] **Step 7: Run the test, then the full suite**

Run: `npx vitest run tests/appealRoutes.test.ts` then `npm test`
Expected: PASS. Existing `banMessage` tests stay green because appeals default to off.

- [ ] **Step 8: Commit**

```bash
git add src/appeals/appealSession.ts src/routes/appeals.ts src/server.ts src/admin/players.ts tests/appealRoutes.test.ts
git commit -m "Appeals: player routes (Steam session or appeal cookie), reaper sweep, and the bot's ban reply points at /appeal"
```

---

### Task 6: Discord sign-in for /appeal, staff routes, sanction DM

**Files:**
- Modify: `src/routes/discordAuth.ts`, `src/routes/appeals.ts` (staff half), `src/routes/tickets.ts` (sanction DM), `src/server.ts` (`discordDm` dep, pass `dm` to ticketRoutes)
- Test: `tests/appealSignIn.test.ts` (new), `tests/appealRoutes.test.ts` (append staff half)

**Interfaces:**
- Consumes: Tasks 1-5, `checkLift`-free `recordLift(db, plan, by, now)` from `src/tickets/discordSanctions.ts`.
- Produces: `GET /auth/discord/appeal`; callback branch for `state` starting `appeal.`; staff routes `GET /api/mod/appeals?state=open|closed`, `GET /api/mod/appeals/:id`, `POST /api/mod/appeals/:id/ask`, `POST /api/mod/appeals/:id/decide`, `POST /api/admin/appeals/:id/final`; `ServerDeps.discordDm?: (userId: string, payload: MessagePayload) => Promise<void>`; `TicketRouteOpts.dm`.

- [ ] **Step 1: Write the failing sign-in test** `tests/appealSignIn.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { stubOrchestrator } from './helpers.js';
import { fakeDiscordApi } from './fakes/fakeDiscordApi.js';
import { APPEAL_COOKIE } from '../src/appeals/appealSession.js';

let db: DB;
let app: FastifyInstance;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({
    config: loadConfig({
      PUBLIC_URL: 'https://pug.test',
      DISCORD_CLIENT_ID: 'cid', DISCORD_CLIENT_SECRET: 'secret', DISCORD_BOT_TOKEN: 'bot', DISCORD_GUILD_ID: 'guild',
    }),
    db, orchestrator: stubOrchestrator(),
    discordApi: fakeDiscordApi({ users: { good: { id: '901', username: 'stranger', globalName: 'Stranger' } }, members: {} }),
    serverExec: async () => {}, serverCleaner: async () => {},
  });
});
afterEach(async () => { await app.close(); });

const cookieFrom = (res: { cookies: { name: string; value: string }[] }, name: string) => res.cookies.find((c) => c.name === name);

describe('/appeal Discord sign-in', () => {
  it('needs no Steam session, binds state to a nonce cookie, and lands back on /appeal signed in', async () => {
    const start = await app.inject({ method: 'GET', url: '/auth/discord/appeal' });
    expect(start.statusCode).toBe(302);
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    expect(state.startsWith('appeal.')).toBe(true);
    const nonce = cookieFrom(start, 'pug_appeal_nonce')!;
    const back = await app.inject({
      method: 'GET', url: `/auth/discord/callback?code=good&state=${encodeURIComponent(state)}`,
      cookies: { pug_appeal_nonce: nonce.value },
    });
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe('/appeal');
    const appeal = cookieFrom(back, APPEAL_COOKIE)!;
    const mine = await app.inject({ method: 'GET', url: '/api/appeals/mine', cookies: { [APPEAL_COOKIE]: appeal.value } });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toMatchObject({ name: 'Stranger', signedInAs: 'discord' });
  });

  it('a state without its nonce cookie (a link someone else started) fails back to /appeal', async () => {
    const start = await app.inject({ method: 'GET', url: '/auth/discord/appeal' });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const back = await app.inject({ method: 'GET', url: `/auth/discord/callback?code=good&state=${encodeURIComponent(state)}` });
    expect(back.headers.location).toBe('/appeal?signin=failed');
    expect(cookieFrom(back, APPEAL_COOKIE)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Append the failing staff tests** to `tests/appealRoutes.test.ts`

```ts
describe('staff appeal routes', () => {
  const staff = () => {
    const mod = authedCookie(app, db, MOD);
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
    const admin = authedCookie(app, db, ADMIN);
    db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
    return { mod, admin };
  };
  const fileAs = async (cookies: Record<string, string>, kind: 'ban' | 'sanction', id: number) =>
    (await app.inject({ method: 'POST', url: '/api/appeals', cookies, payload: { kind, id, whatHappened: 'a', whyLift: 'b' } })).json().id as number;

  it('a moderator lists, asks once, and denies; the audit row names the decider', async () => {
    const { mod } = staff();
    const { ban, cookies } = bannedCookie(P);
    const id = await fileAs(cookies, 'ban', ban);
    const list = await app.inject({ method: 'GET', url: '/api/mod/appeals?state=open', cookies: mod });
    expect(list.json().appeals.map((a: { id: number }) => a.id)).toEqual([id]);
    expect((await app.inject({ method: 'POST', url: `/api/mod/appeals/${id}/ask`, cookies: mod, payload: { question: 'Which map?' } })).statusCode).toBe(200);
    const deny = await app.inject({ method: 'POST', url: `/api/mod/appeals/${id}/decide`, cookies: mod, payload: { outcome: 'deny' } });
    expect(deny.statusCode).toBe(200);
    expect(db.prepare("SELECT admin_id, action FROM admin_actions WHERE action LIKE 'appeal_%'").all())
      .toEqual([{ admin_id: MOD, action: 'appeal_ask' }, { admin_id: MOD, action: 'appeal_deny' }]);
  });

  it('a moderator cannot decide an appeal against an admin\'s ban', async () => {
    const { mod } = staff();
    const { ban, cookies } = bannedCookie(P, null, ADMIN);
    const id = await fileAs(cookies, 'ban', ban);
    const r = await app.inject({ method: 'POST', url: `/api/mod/appeals/${id}/decide`, cookies: mod, payload: { outcome: 'accept' } });
    expect(r.statusCode).toBe(403);
  });

  it('accepting a moderator-issued Discord timeout lifts it in Discord, records the lift, and a moderator may do it', async () => {
    const { mod } = staff();
    const sid = Number(db.prepare(`INSERT INTO discord_sanctions (discord_id, kind, until, reason, created_by, created_at)
      VALUES ('901', 'timeout', ?, 'spam', ?, ?)`).run(new Date(Date.now() + 7 * 86400_000).toISOString(), MOD, new Date().toISOString()).lastInsertRowid);
    const id = await fileAs(discordCookie('901'), 'sanction', sid);
    const r = await app.inject({ method: 'POST', url: `/api/mod/appeals/${id}/decide`, cookies: mod, payload: { outcome: 'accept' } });
    expect(r.statusCode).toBe(200);
    expect(fake.moderationCalls).toMatchObject([{ op: 'removeTimeout', userId: '901' }]);
    expect(db.prepare('SELECT lifted_by FROM discord_sanctions WHERE id = ?').get(sid)).toEqual({ lifted_by: MOD });
  });

  it('only an admin marks a ban final', async () => {
    const { mod, admin } = staff();
    const { ban, cookies } = bannedCookie(P);
    const id = await fileAs(cookies, 'ban', ban);
    expect((await app.inject({ method: 'POST', url: `/api/admin/appeals/${id}/final`, cookies: mod, payload: { on: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/admin/appeals/${id}/final`, cookies: admin, payload: { on: true } })).statusCode).toBe(200);
    expect(db.prepare('SELECT no_appeal FROM bans WHERE id = ?').get(ban)).toEqual({ no_appeal: 1 });
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `npx vitest run tests/appealSignIn.test.ts tests/appealRoutes.test.ts`
Expected: FAIL (404 on the new routes).

- [ ] **Step 4: Add the appeal sign-in to `src/routes/discordAuth.ts`**

Add imports: `import { randomBytes } from 'node:crypto';` (merge with the existing `node:crypto` import) and `import { setAppealSession } from '../appeals/appealSession.js';`.

Inside `discordAuthRoutes`, above the existing `app.get('/auth/discord', ...)`:

```ts
  /**
   * Sign in for /appeal, with no Steam session: the way in for somebody the
   * bot banned from the Discord, who cannot use the Appeal button. The state
   * is bound to a random nonce in a cookie on this browser, so a link
   * started by somebody else cannot sign this browser in as them.
   */
  const APPEAL_STATE = 'appeal.';
  const NONCE_COOKIE = 'pug_appeal_nonce';
  const secure = config.publicUrl.startsWith('https://');

  app.get('/auth/discord/appeal', async (_req, reply) => {
    if (!discord || !api) return reply.code(404).send({ error: 'not found' });
    const nonce = randomBytes(16).toString('hex');
    reply.setCookie(NONCE_COOKIE, nonce, { path: '/auth/discord', httpOnly: true, signed: true, sameSite: 'lax', secure, maxAge: 10 * 60 });
    const params = new URLSearchParams({
      client_id: discord.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'identify',
      state: `${APPEAL_STATE}${signState(config.cookieSecret, `appeal:${nonce}`, Date.now())}`,
    });
    return reply.redirect(`https://discord.com/oauth2/authorize?${params}`);
  });

  const appealCallback = async (req: FastifyRequest, reply: FastifyReply, code: string | undefined, state: string) => {
    const failed = () => reply.redirect('/appeal?signin=failed');
    const raw = req.cookies[NONCE_COOKIE];
    const nonce = raw ? req.unsignCookie(raw) : null;
    reply.clearCookie(NONCE_COOKIE, { path: '/auth/discord' });
    if (!code || !nonce?.valid || !nonce.value || !verifyState(config.cookieSecret, `appeal:${nonce.value}`, state)) return failed();
    try {
      const { accessToken } = await api!.exchangeCode(code, redirectUri);
      const user = await api!.getCurrentUser(accessToken);
      setAppealSession(reply, user.id, user.globalName ?? user.username, secure);
    } catch (err) {
      console.error('[discord] appeal sign-in failed:', err);
      return failed();
    }
    return reply.redirect('/appeal');
  };
```

At the very top of the existing `/auth/discord/callback` handler, before `guard`:

```ts
    const q = req.query as { code?: string; state?: string };
    if (typeof q.state === 'string' && q.state.startsWith(APPEAL_STATE)) {
      if (!discord || !api) return reply.code(404).send({ error: 'not found' });
      return appealCallback(req, reply, q.code, q.state.slice(APPEAL_STATE.length));
    }
```

- [ ] **Step 5: Add the staff half to `src/routes/appeals.ts`**

Extra imports:

```ts
import { makeRequireAdmin, makeRequireMod } from './guards.js';
import { fileViewer } from '../admin/fileAccess.js';
import { logAdmin } from '../admin/audit.js';
import { publishAdminEvent } from '../adminFeed.js';
import { askQuestion, getAppeal, mootAppeal, recordDecision, targetInForce } from '../appeals/store.js';
import { appealIsQuiet, canSeeAppeal, decideCheck } from '../appeals/access.js';
import { decideBanAppeal } from '../appeals/decide.js';
import { staffAppeal, staffAppeals } from '../appeals/views.js';
import { publishAppealSignal } from '../appeals/signals.js';
import { recordLift } from '../tickets/discordSanctions.js';
```

Inside `appealRoutes`, after the player routes:

```ts
  const requireMod = makeRequireMod(db);
  const requireAdmin = makeRequireAdmin(db);
  const idOf = (req: FastifyRequest) => Number((req.params as { id: string }).id);
  const audit = (me: string, action: string, row: NonNullable<ReturnType<typeof getAppeal>>, detail: object = {}) =>
    logAdmin(db, me, action, row.steamid ?? row.discord_id ?? '', { appealId: row.id, ...detail }, { quiet: appealIsQuiet(db, row) });

  app.get('/api/mod/appeals', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const which = (req.query as { state?: string }).state === 'closed' ? 'closed' : 'open';
    return { appeals: staffAppeals(db, fileViewer(db, me), which) };
  });

  app.get('/api/mod/appeals/:id', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const d = staffAppeal(db, fileViewer(db, me), idOf(req));
    return d ?? reply.code(404).send({ error: 'no such appeal' });
  });

  app.post('/api/mod/appeals/:id/ask', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const row = getAppeal(db, idOf(req));
    const c = row ? decideCheck(db, fileViewer(db, me), row) : { ok: false as const, status: 404, error: 'no such appeal' };
    if (!c.ok) return reply.code(c.status).send({ error: c.error });
    const r = askQuestion(db, row!.id, me, ((req.body ?? {}) as { question?: unknown }).question);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    audit(me, 'appeal_ask', row!);
    return r;
  });

  app.post('/api/mod/appeals/:id/decide', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const row = getAppeal(db, idOf(req));
    const c = row ? decideCheck(db, fileViewer(db, me), row) : { ok: false as const, status: 404, error: 'no such appeal' };
    if (!c.ok) return reply.code(c.status).send({ error: c.error });
    const { outcome, endsAt } = (req.body ?? {}) as { outcome?: unknown; endsAt?: unknown };
    if (outcome !== 'accept' && outcome !== 'shorten' && outcome !== 'deny') return reply.code(400).send({ error: 'outcome is accept, shorten or deny' });
    const a = row!;

    if (a.ban_id !== null) {
      const r = decideBanAppeal(db, a, me, outcome, endsAt);
      if (!r.ok) return reply.code(r.status).send({ error: r.error });
      audit(me, `appeal_${outcome}`, a, outcome === 'shorten' ? { endsAt } : {});
      return r;
    }

    // A Discord sanction: lifted or kept, never shortened here.
    if (outcome === 'shorten') return reply.code(400).send({ error: 'A Discord timeout or ban is lifted or kept; it cannot be shortened here.' });
    if (!targetInForce(db, a)) {
      mootAppeal(db, a.id);
      return reply.code(409).send({ error: 'The sanction is no longer in force, so the appeal has been closed.' });
    }
    if (outcome === 'deny') {
      if (!recordDecision(db, a.id, me, 'denied', null)) return reply.code(409).send({ error: 'this appeal has already been decided' });
      audit(me, 'appeal_deny', a);
      return { ok: true };
    }
    const s = db.prepare('SELECT id, discord_id, kind, ticket_id FROM discord_sanctions WHERE id = ?').get(a.sanction_id) as
      { id: number; discord_id: string; kind: 'timeout' | 'ban'; ticket_id: number | null };
    const mod = opts.moderation();
    if (!mod) return reply.code(503).send({ error: 'the Discord bot is not running' });
    // Discord first, as the tickets lift route does. A timed-out member who
    // has since left cannot have the timeout removed; it ends on its own, so
    // the appeal is still accepted and the row marked lifted.
    const result = s.kind === 'timeout'
      ? await mod.removeTimeout(s.discord_id, 'appeal accepted')
      : await mod.unban(s.discord_id, 'appeal accepted');
    if (!result.ok && !(s.kind === 'timeout' && result.why === 'not_member')) {
      return reply.code(409).send({ error: `Discord refused: ${result.detail}` });
    }
    if (!recordDecision(db, a.id, me, 'accepted', null)) return reply.code(409).send({ error: 'this appeal has already been decided' });
    try {
      recordLift(db, { sanctionId: s.id, discordId: s.discord_id, kind: s.kind, ticketId: s.ticket_id, restricted: false }, me);
    } catch (err) {
      publishAdminEvent({ kind: 'problem', text: `Appeal #${a.id}: Discord lifted the ${s.kind}, but recording the lift failed: ${String(err)}` });
    }
    audit(me, 'appeal_accept', a);
    return { ok: true };
  });

  /** Admin only: this ban or sanction may not be appealed again. */
  app.post('/api/admin/appeals/:id/final', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return reply;
    const row = getAppeal(db, idOf(req));
    if (!row || !canSeeAppeal(db, fileViewer(db, me), row)) return reply.code(404).send({ error: 'no such appeal' });
    const on = ((req.body ?? {}) as { on?: unknown }).on === true ? 1 : 0;
    if (row.ban_id !== null) db.prepare('UPDATE bans SET no_appeal = ? WHERE id = ?').run(on, row.ban_id);
    else db.prepare('UPDATE discord_sanctions SET no_appeal = ? WHERE id = ?').run(on, row.sanction_id);
    audit(me, on ? 'appeal_final' : 'appeal_unfinal', row);
    publishAppealSignal(row.id);
    return { ok: true };
  });
```

- [ ] **Step 6: Sanction DM with the appeal pointer.** In `src/server.ts` add to `ServerDeps`:

```ts
  /** Tests: what the routes use to DM a Discord member. Production uses the bot. */
  discordDm?: (userId: string, payload: MessagePayload) => Promise<void>;
```

(import `MessagePayload` type from `./discord/transport.js`), and pass to `ticketRoutes`:

```ts
    dm: () => deps.discordDm ?? (bot ? (userId: string, payload: MessagePayload) => bot!.transport.dm(userId, payload) : null),
```

In `src/routes/tickets.ts`, add `dm: () => ((userId: string, payload: MessagePayload) => Promise<void>) | null;` to `TicketRouteOpts`, destructure it, import `sanctionDmText` from `../appeals/templates.js`, `getSetting` from `../settings.js`, `MessagePayload` type. Add a helper in the route function:

```ts
  /** Tell the person, with where to appeal while appeals are on. Never fails
   *  the action: a closed DM is ordinary. */
  const tellSanctioned = async (discordId: string, kind: 'timeout' | 'ban', minutes: number | null, reason: string) => {
    const send = dm();
    if (!send) return;
    const until = kind === 'timeout' && minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null;
    const appealUrl = getSetting(db, 'appeals_enabled') === '1' ? `${publicUrl}/appeal` : null;
    try {
      await send(discordId, { content: sanctionDmText(kind, until, reason, appealUrl), embeds: [], components: [] });
    } catch (err) {
      console.log('[tickets] could not DM a sanctioned member:', String(err));
    }
  };
```

In the `/api/mod/tickets/:id/discord-sanction` route: for a ban, `await tellSanctioned(plan.discordId, 'ban', null, plan.reason)` immediately BEFORE `mod.ban(...)` (afterwards the bot shares no server with them and the DM cannot arrive); for a timeout, call it after `recordDiscordSanction` succeeds. If `publicUrl` is not already in `TicketRouteOpts`, add it and pass `deps.config.publicUrl` from server.ts.

Add a test to `tests/appealRoutes.test.ts` or the existing `tests/discordSanctions.test.ts`, with `discordDm` stubbed to push into an array: a timeout with appeals on DMs text containing `/appeal`; with appeals off it does not contain it.

- [ ] **Step 7: Run the tests, then the full suite**

Run: `npx vitest run tests/appealSignIn.test.ts tests/appealRoutes.test.ts tests/discordSanctions.test.ts` then `npm test`
Expected: PASS. `tests/discordAuth.test.ts` must stay green (the Steam link flow is untouched).

- [ ] **Step 8: Commit**

```bash
git add src/routes/discordAuth.ts src/routes/appeals.ts src/routes/tickets.ts src/server.ts tests/appealSignIn.test.ts tests/appealRoutes.test.ts tests/discordSanctions.test.ts
git commit -m "Appeals: Discord sign-in for /appeal, staff routes (ask once, accept/shorten/deny, mark final), sanction DMs say where to appeal"
```

---

### Task 7: Forum post and DMs (`AppealSync`)

**Files:**
- Create: `src/discord/appealSync.ts`
- Modify: `src/discord/ticketSync.ts` (`sweepOrphanPosts` known set, ~line 416), `src/server.ts` (start/stop in `onConnected` / `onClose`)
- Test: `tests/appealSync.test.ts`

**Interfaces:**
- Consumes: Tasks 1-4, `FakeTransport`.
- Produces: `class AppealSync { constructor(deps: { db: DB; transport: BotTransport; publicUrl: string; serialise?: (fn: () => Promise<void>) => Promise<void>; intervalMs?: number; now?: () => Date }); start(): void; stop(): void; reconcile(): Promise<void> }`; `appealCard(db, row, publicUrl): MessagePayload`

- [ ] **Step 1: Write the failing test** `tests/appealSync.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { upsertPlayer, linkDiscord } from '../src/players.js';
import { insertBan } from '../src/admin/players.js';
import { appellantFromSteam } from '../src/appeals/rules.js';
import { askQuestion, fileAppeal, getAppeal, recordDecision } from '../src/appeals/store.js';
import { AppealSync } from '../src/discord/appealSync.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const P = '76561198000000001';
const MOD = '76561198000000008';
const FORUM = '5000';
let db: DB;
let t: FakeTransport;
let sync: AppealSync;

beforeEach(() => {
  db = openDb(':memory:');
  t = new FakeTransport();
  setSetting(db, 'appeals_enabled', '1');
  setSetting(db, 'discord_tickets_forum_id', FORUM);
  upsertPlayer(db, { steamid: P, name: 'telltale', avatar: null }, []);
  upsertPlayer(db, { steamid: MOD, name: 'mod', avatar: null }, []);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  linkDiscord(db, P, '700', 'telltale');
  sync = new AppealSync({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
});

const file = () => {
  const ban = insertBan(db, P, MOD, 'griefing', null);
  return (fileAppeal(db, appellantFromSteam(db, P), { ref: { kind: 'ban', id: ban }, whatHappened: 'lag', whyLift: 'router' }, ) as { id: number }).id;
};

describe('AppealSync', () => {
  it('posts one forum post per appeal, tagged Appeal, and remembers it', async () => {
    const id = file();
    await sync.reconcile();
    await sync.reconcile();
    const posts = t.threadsIn(FORUM);
    expect(posts).toHaveLength(1);
    expect(posts[0].tags).toEqual(['Appeal']);
    expect(getAppeal(db, id)!.forum_thread_id).toBe(posts[0].id);
  });

  it('DMs the question once, and the outcome once; never the filing itself', async () => {
    const id = file();
    await sync.reconcile();
    expect(t.dms).toEqual([]);
    askQuestion(db, id, MOD, 'Which map?');
    await sync.reconcile();
    await sync.reconcile();
    expect(t.dms).toHaveLength(1);
    expect(t.dms[0].userId).toBe('700');
    expect(t.dms[0].payload.content).toContain('Which map?');
    recordDecision(db, id, MOD, 'denied', null);
    await sync.reconcile();
    expect(t.dms).toHaveLength(2);
    expect(t.dms[1].payload.content).toContain('the ban stands');
  });

  it('closes the post when the appeal is settled', async () => {
    const id = file();
    await sync.reconcile();
    recordDecision(db, id, MOD, 'denied', null);
    await sync.reconcile();
    const post = t.threadsIn(FORUM)[0];
    expect(post.locked).toBe(true);
    expect(post.archived).toBe(true);
  });

  it('a quiet appeal (by staff) gets no forum post', async () => {
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(P);
    file();
    await sync.reconcile();
    expect(t.threadsIn(FORUM)).toHaveLength(0);
  });

  it('a refused DM is not retried', async () => {
    t.dmsClosed.add('700');
    const id = file();
    askQuestion(db, id, MOD, 'Which map?');
    await sync.reconcile();
    t.dmsClosed.delete('700');
    await sync.reconcile();
    expect(t.dms).toEqual([]);
  });
});
```

Also add to the existing `tests/ticketSync.test.ts` (or whichever file covers `sweepOrphanPosts`) a case: a bot-made forum post whose id is in `appeals.forum_thread_id` survives the first reconcile pass. Copy the shape of the existing orphan-sweep test in that file and insert an appeals row with that `forum_thread_id` before the pass.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/appealSync.test.ts`
Expected: FAIL, missing module.

- [ ] **Step 3: Write `src/discord/appealSync.ts`**

```ts
import type { DB } from '../db.js';
import { getSetting } from '../settings.js';
import { escapeName } from '../identity.js';
import { getAppeal } from '../appeals/store.js';
import { appealIsQuiet } from '../appeals/access.js';
import { dmText, STATE_LABEL } from '../appeals/templates.js';
import { subscribeAppealSignals } from '../appeals/signals.js';
import { OPEN_STATES, type AppealRow } from '../appeals/types.js';
import type { BotTransport, MessagePayload } from './transport.js';

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const nameOf = (db: DB, steamid: string | null) => (steamid === 'system' ? 'automatic'
  : steamid ? ((db.prepare('SELECT name FROM players WHERE steamid = ?').get(steamid) as { name: string } | undefined)?.name ?? steamid) : '');

/** The forum post's first message: the whole appeal as it stands now. It is
 *  edited in place on every change, so a skipped intermediate state (asked
 *  and answered between two passes) is never lost from the post. */
export function appealCard(db: DB, row: AppealRow, publicUrl: string): MessagePayload {
  const ban = row.ban_id !== null
    ? db.prepare('SELECT reason, created_by, expires_at AS ends FROM bans WHERE id = ?').get(row.ban_id)
    : db.prepare('SELECT reason, created_by, until AS ends FROM discord_sanctions WHERE id = ?').get(row.sanction_id);
  const b = ban as { reason: string; created_by: string; ends: string | null };
  const fields = [
    { name: 'Ban', value: clip(escapeName(b.reason), 1000) },
    { name: 'Issued by', value: escapeName(nameOf(db, b.created_by)), inline: true },
    { name: 'Ends', value: b.ends ? `<t:${Math.floor(Date.parse(b.ends) / 1000)}:f>` : 'never', inline: true },
    { name: 'Status', value: STATE_LABEL[row.state], inline: true },
  ];
  if (row.question) fields.push({ name: `Question from ${escapeName(nameOf(db, row.asked_by))}`, value: clip(escapeName(row.question), 1000) });
  if (row.answer) fields.push({ name: 'Answer', value: clip(escapeName(row.answer), 1000) });
  if (row.decided_by) fields.push({ name: 'Decided by', value: escapeName(nameOf(db, row.decided_by)), inline: true });
  return {
    embeds: [{
      title: clip(`Appeal #${row.id}: ${row.appellant_name}`, 250),
      url: `${publicUrl}/admin/people/appeals/${row.id}`,
      description: `**What happened**\n${clip(escapeName(row.what_happened), 1800)}\n\n**Why it should be lifted**\n${clip(escapeName(row.why_lift), 1800)}`,
      fields,
    }],
    components: [],
    mentionUserIds: [],
  };
}

export interface AppealSyncDeps {
  db: DB;
  transport: BotTransport;
  publicUrl: string;
  /** The tickets reconciler's chain: its once-per-process orphan sweep lists
   *  the same forum, and a post made between its listing and our row write
   *  would be deleted as an orphan. */
  serialise?: (fn: () => Promise<void>) => Promise<void>;
  intervalMs?: number;
  now?: () => Date;
}

/**
 * Keeps each appeal's forum post and the appellant's DMs in step with the
 * row. Idempotent, driven by two columns: `forum_state` (the state the post
 * shows) and `dm_state` (the last state the appellant was told about). A
 * pass changes nothing for a row whose columns already equal its state.
 */
export class AppealSync {
  private timer: NodeJS.Timeout | null = null;
  private off: (() => void) | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(private deps: AppealSyncDeps) {}

  start(): void {
    this.off = subscribeAppealSignals(() => { this.kick(); });
    this.kick();
    const every = this.deps.intervalMs ?? 60_000;
    if (every > 0) {
      this.timer = setInterval(() => { this.kick(); }, every);
      this.timer.unref();
    }
  }

  stop(): void {
    this.off?.();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private kick(): void {
    this.chain = this.chain.then(() => this.reconcile()).catch((err) => console.error('[discord] appeal sync:', err));
  }

  async reconcile(): Promise<void> {
    const ids = (this.deps.db.prepare(
      'SELECT id FROM appeals WHERE dm_state IS NOT state OR forum_state IS NOT state ORDER BY id',
    ).all() as { id: number }[]).map((r) => r.id);
    for (const id of ids) {
      const row = getAppeal(this.deps.db, id);
      if (!row) continue;
      await this.dm(row);
      const run = () => this.forum(row.id);
      await (this.deps.serialise ? this.deps.serialise(run) : run());
    }
  }

  /** Charged before the send, so a refused DM is never retried. */
  private async dm(row: AppealRow): Promise<void> {
    const { db, transport, publicUrl } = this.deps;
    if (row.dm_state === row.state) return;
    const charged = db.prepare('UPDATE appeals SET dm_state = ? WHERE id = ? AND dm_state IS NOT ?').run(row.state, row.id, row.state).changes > 0;
    if (!charged) return;
    const content = dmText(db, row, publicUrl, this.deps.now?.());
    const to = row.discord_id
      ?? (row.steamid ? (db.prepare('SELECT discord_id FROM players WHERE steamid = ?').get(row.steamid) as { discord_id: string | null } | undefined)?.discord_id : null);
    if (!content || !to) return;
    try {
      await transport.dm(to, { content, embeds: [], components: [], mentionUserIds: [] });
    } catch (err) {
      console.log(`[discord] appeal #${row.id}: DM refused (${String(err)})`);
    }
  }

  private async forum(id: number): Promise<void> {
    const { db, transport, publicUrl } = this.deps;
    const row = getAppeal(db, id);
    if (!row || row.forum_state === row.state) return;
    const forumId = getSetting(db, 'discord_tickets_forum_id') ?? '';
    const mark = () => db.prepare('UPDATE appeals SET forum_state = ? WHERE id = ?').run(row.state, row.id);
    // Quiet appeals and a forum-less setup: worked on the site only.
    if (!forumId || appealIsQuiet(db, row)) { mark(); return; }
    const card = appealCard(db, row, publicUrl);

    if (!row.forum_thread_id) {
      const made = await transport.threads.createForumPost(forumId, { name: `Appeal #${row.id}: ${row.appellant_name}`.slice(0, 100), message: card, tags: ['Appeal'] });
      try {
        db.prepare('UPDATE appeals SET forum_thread_id = ?, forum_message_id = ?, forum_state = ? WHERE id = ?')
          .run(made.threadId, made.messageId, row.state, row.id);
      } catch (err) {
        await transport.threads.deleteThread(made.threadId).catch(() => {});
        throw err;
      }
      if (!OPEN_STATES.includes(row.state)) await this.close(made.threadId);
      return;
    }

    if (!(await transport.threads.exists(row.forum_thread_id))) { mark(); return; }
    if (await transport.threads.isArchived(row.forum_thread_id)) await transport.threads.setArchived(row.forum_thread_id, false);
    await transport.edit(row.forum_thread_id, row.forum_message_id ?? row.forum_thread_id, card);
    // A short line too, because an edit notifies nobody.
    await transport.send(row.forum_thread_id, { content: `Status: ${STATE_LABEL[row.state]}`, embeds: [], components: [], mentionUserIds: [] });
    mark();
    if (!OPEN_STATES.includes(row.state)) await this.close(row.forum_thread_id);
  }

  private async close(threadId: string): Promise<void> {
    await this.deps.transport.threads.setLocked(threadId, true);
    await this.deps.transport.threads.setArchived(threadId, true);
  }
}
```

- [ ] **Step 4: Teach the tickets orphan sweep about appeal posts.** In `src/discord/ticketSync.ts` `sweepOrphanPosts`, replace the `known` query with:

```ts
    // Appeal posts live in the same forum (src/discord/appealSync.ts) and are
    // not orphans: their ids are on the appeals rows.
    const known = new Set((db.prepare(
      `SELECT thread_id FROM ticket_threads WHERE surface = 'forum'
       UNION SELECT forum_thread_id FROM appeals WHERE forum_thread_id IS NOT NULL`,
    ).all() as { thread_id: string }[]).map((r) => r.thread_id));
```

- [ ] **Step 5: Start it in `src/server.ts`.** Declare `let appealSync: AppealSync | null = null;` beside `reportButton`. In `onConnected`, after `reportButton.start();`:

```ts
        appealSync = new AppealSync({
          db: deps.db, transport: t, publicUrl: deps.config.publicUrl,
          serialise: (fn) => (ticketSync ? ticketSync.serialise(fn) : fn()),
        });
        appealSync.start();
```

In `onClose`, add `appealSync?.stop();` next to `reportButton?.stop();`. Import `AppealSync`.

- [ ] **Step 6: Run the tests, then the full suite**

Run: `npx vitest run tests/appealSync.test.ts tests/ticketSync.test.ts` then `npm test`
Expected: PASS. (The fake's `createForumPost` only needs a non-empty forum id; no channel setup.)

- [ ] **Step 7: Commit**

```bash
git add src/discord/appealSync.ts src/discord/ticketSync.ts src/server.ts tests/appealSync.test.ts tests/ticketSync.test.ts
git commit -m "Appeals: forum post per appeal (edited in place, closed when settled), question and outcome DMs, orphan sweep spares appeal posts"
```

---

### Task 8: The Appeal button in Discord

**Files:**
- Create: `src/discord/appealButton.ts`
- Modify: `src/server.ts` (`extraButtons`/`extraModals` `'ap:'`, `opensModal`, start/stop)
- Test: `tests/appealButton.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3, the `reportButton.ts` patterns.
- Produces: `APPEAL_PREFIX = 'ap:'`; `opensAppealModal(customId): boolean`; `class AppealButton { constructor(deps: { db; transport; publicUrl; intervalMs?; now? }); start(); stop(); tick(): Promise<void> }`; `handleAppealButton(deps: { db; publicUrl; now? }, i): Promise<InteractionReply>`; `handleAppealModal(deps, i): Promise<InteractionReply>`

- [ ] **Step 1: Write the failing test** `tests/appealButton.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { upsertPlayer, linkDiscord } from '../src/players.js';
import { insertBan } from '../src/admin/players.js';
import { AppealButton, handleAppealButton, handleAppealModal, opensAppealModal } from '../src/discord/appealButton.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const P = '76561198000000001';
const CH = '6000';
let db: DB;
let t: FakeTransport;
const deps = () => ({ db, publicUrl: 'https://pug.test' });
const press = (userId: string) => ({ kind: 'button' as const, customId: 'ap:open', userId, userName: 'telltale', presserTimedOutUntil: null });
const submit = (customId: string, fields: Record<string, string>, userId = '700') =>
  ({ kind: 'modal' as const, customId, userId, userName: 'telltale', fields, picked: {}, presserTimedOutUntil: null });

beforeEach(() => {
  db = openDb(':memory:');
  t = new FakeTransport();
  setSetting(db, 'discord_report_channel_id', CH);
  upsertPlayer(db, { steamid: P, name: 'telltale', avatar: null }, []);
  linkDiscord(db, P, '700', 'telltale');
});

describe('the standing message', () => {
  it('posts only while appeals are on, and takes itself down when they go off', async () => {
    const b = new AppealButton({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
    await b.tick();
    expect(t.messages.filter((m) => !m.deleted)).toHaveLength(0);
    setSetting(db, 'appeals_enabled', '1');
    await b.tick();
    const live = t.messages.filter((m) => !m.deleted);
    expect(live).toHaveLength(1);
    expect(JSON.stringify(live[0].payload)).toContain('ap:open');
    setSetting(db, 'appeals_enabled', '0');
    await b.tick();
    expect(t.messages.filter((m) => !m.deleted)).toHaveLength(0);
  });
});

describe('pressing Appeal', () => {
  beforeEach(() => setSetting(db, 'appeals_enabled', '1'));

  it('opens a form for a banned member, with the ban in its id', async () => {
    const ban = insertBan(db, P, 'system', 'abandon', null);
    expect(opensAppealModal('ap:open')).toBe(true);
    const r = await handleAppealButton(deps(), press('700'));
    expect(r.modal?.customId).toBe(`ap:new:ban:${ban}`);
    expect(r.modal?.fields.map((f) => f.id)).toEqual(['what', 'why']);
  });

  it('says "nothing to appeal" without a form for someone who is not banned', async () => {
    const r = await handleAppealButton(deps(), press('999'));
    expect(r.modal).toBeUndefined();
    expect(r.payload.content).toBe('You have nothing to appeal.');
  });

  it('a submitted form files the appeal; a forged id is refused', async () => {
    const ban = insertBan(db, P, 'system', 'abandon', null);
    const ok = await handleAppealModal(deps(), submit(`ap:new:ban:${ban}`, { what: 'lag', why: 'router' }));
    expect(ok.payload.content).toMatch(/Your appeal was sent/);
    expect(db.prepare('SELECT source FROM appeals').get()).toEqual({ source: 'discord_button' });
    const forged = await handleAppealModal(deps(), submit(`ap:new:ban:${ban + 50}`, { what: 'a', why: 'b' }));
    expect(forged.payload.content).toBe('You have nothing to appeal.');
  });

  it('several bans: one select, and the pick decides which', async () => {
    const a = insertBan(db, P, 'system', 'abandon', null);
    const b = insertBan(db, P, 'system', 'griefing', null);
    const r = await handleAppealButton(deps(), press('700'));
    expect(r.modal?.customId).toBe('ap:new');
    expect(r.modal?.fields[0]).toMatchObject({ kind: 'select', id: 'which' });
    await handleAppealModal(deps(), submit('ap:new', { which: `ban:${a}`, what: 'x', why: 'y' }));
    expect(db.prepare('SELECT ban_id FROM appeals').get()).toEqual({ ban_id: a });
    expect(b).toBeGreaterThan(a);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/appealButton.test.ts`
Expected: FAIL, missing module.

- [ ] **Step 3: Write `src/discord/appealButton.ts`**

```ts
import { createHash } from 'node:crypto';
import type { DB } from '../db.js';
import { getSetting } from '../settings.js';
import { activeTargets, appealSettings, appellantFromDiscord, judge, parseRefKey, refKey, refusalText } from '../appeals/rules.js';
import { fileAppeal } from '../appeals/store.js';
import type { Appealable } from '../appeals/types.js';
import type { BotInteraction, BotTransport, InteractionReply, MessagePayload, ModalDef, ModalField } from './transport.js';

/** Custom id prefix. 'rp:' is the Report button beside it. */
export const APPEAL_PREFIX = 'ap:';

export function opensAppealModal(customId: string): boolean {
  return customId === `${APPEAL_PREFIX}open`;
}

const say = (content: string): InteractionReply => ({ ephemeral: true, payload: { content, embeds: [], components: [] } });
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

function describe(t: Appealable): string {
  if (t.hold) return 'Account hold';
  if (t.sanctionKind) return clip(`Discord ${t.sanctionKind}: ${t.reason}`, 100);
  return clip(`Ban: ${t.reason}`, 100);
}

function standingPayload(publicUrl: string): MessagePayload {
  return {
    content: [
      '**Banned, on hold or timed out?**',
      '',
      'If you think it was a mistake, press Appeal and tell the staff what happened.',
      'You get one appeal at a time, and staff may ask you one question.',
      '',
      `Banned from this Discord? Appeal at ${publicUrl}/appeal`,
    ].join('\n'),
    embeds: [],
    components: [[{ kind: 'button', customId: `${APPEAL_PREFIX}open`, label: 'Appeal', style: 'secondary' }]],
  };
}

const hashOf = (p: MessagePayload) => createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 16);

/** One standing message in the Report button's channel, while appeals are on. */
export class AppealButton {
  private timer: NodeJS.Timeout | null = null;

  constructor(private deps: { db: DB; transport: BotTransport; publicUrl: string; intervalMs?: number; now?: () => Date }) {}

  start(): void {
    void this.tick();
    const every = this.deps.intervalMs ?? 5 * 60_000;
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
      console.error('[discord] appeal button:', err);
    }
  }

  private async ensureMessage(): Promise<void> {
    const { db, transport } = this.deps;
    const on = getSetting(db, 'appeals_enabled') === '1';
    const channelId = on ? getSetting(db, 'discord_report_channel_id') ?? '' : '';
    const row = db.prepare('SELECT channel_id, message_id, hash FROM appeal_message WHERE id = 1')
      .get() as { channel_id: string; message_id: string; hash: string } | undefined;
    if (!channelId) {
      if (row) {
        await transport.remove(row.channel_id, row.message_id).catch(() => {});
        db.prepare('DELETE FROM appeal_message WHERE id = 1').run();
      }
      return;
    }
    const payload = standingPayload(this.deps.publicUrl);
    const hash = hashOf(payload);
    if (row && row.channel_id !== channelId) {
      await transport.remove(row.channel_id, row.message_id).catch(() => {});
    } else if (row && row.hash === hash) {
      if (await transport.edit(row.channel_id, row.message_id, payload)) return;
    } else if (row) {
      if (await transport.edit(row.channel_id, row.message_id, payload)) { this.remember(channelId, row.message_id, hash); return; }
    }
    const messageId = await transport.send(channelId, payload);
    this.remember(channelId, messageId, hash);
  }

  private remember(channelId: string, messageId: string, hash: string): void {
    this.deps.db.prepare(
      `INSERT INTO appeal_message (id, channel_id, message_id, hash, updated_at) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET channel_id = excluded.channel_id, message_id = excluded.message_id,
         hash = excluded.hash, updated_at = excluded.updated_at`,
    ).run(channelId, messageId, hash, (this.deps.now?.() ?? new Date()).toISOString());
  }
}

interface HandlerDeps { db: DB; publicUrl: string; now?: () => Date }

/** Answered before the press is deferred (opensModal), so a quick read only. */
export async function handleAppealButton(deps: HandlerDeps, i: Extract<BotInteraction, { kind: 'button' }>): Promise<InteractionReply> {
  if (i.customId !== `${APPEAL_PREFIX}open`) return say('That button no longer does anything.');
  const now = deps.now?.() ?? new Date();
  const s = appealSettings(deps.db);
  if (!s.enabled) return say(refusalText({ ok: false, reason: 'disabled' }));
  const who = appellantFromDiscord(deps.db, i.userId, i.userName);
  const targets = activeTargets(deps.db, who, now);
  if (targets.length === 0) return say(refusalText({ ok: false, reason: 'nothing_to_appeal' }));
  const verdicts = targets.map((t) => judge(deps.db, t, now));
  const ok = targets.filter((_, n) => verdicts[n].ok);
  if (ok.length === 0) {
    const first = verdicts.find((v) => !v.ok) as Extract<ReturnType<typeof judge>, { ok: false }>;
    return say(refusalText(first));
  }
  const max = Math.min(s.textMax, 4000);
  const fields: ModalField[] = [
    { kind: 'text', id: 'what', label: 'What happened?', style: 'paragraph', required: true, maxLength: max },
    { kind: 'text', id: 'why', label: 'Why should it be lifted or shortened?', style: 'paragraph', required: true, maxLength: max },
  ];
  const modal: ModalDef = ok.length === 1
    ? { customId: `${APPEAL_PREFIX}new:${refKey(ok[0].ref)}`, title: 'Appeal', fields }
    : {
        customId: `${APPEAL_PREFIX}new`, title: 'Appeal',
        fields: [
          { kind: 'select', id: 'which', label: 'Which one?', options: ok.slice(0, 25).map((t, n) => ({ label: describe(t), value: refKey(t.ref), ...(n === 0 ? { default: true } : {}) })) },
          ...fields,
        ],
      };
  return { ephemeral: true, payload: { content: 'Opening the form...', embeds: [], components: [] }, modal };
}

/** The ref in the custom id (or the select) travels through Discord, so it
 *  is only a claim: fileAppeal accepts it only if it is one of this
 *  member's own bans. */
export async function handleAppealModal(deps: HandlerDeps, i: Extract<BotInteraction, { kind: 'modal' }>): Promise<InteractionReply> {
  const fromId = i.customId.startsWith(`${APPEAL_PREFIX}new:`) ? i.customId.slice(`${APPEAL_PREFIX}new:`.length) : (i.fields.which ?? '');
  const ref = parseRefKey(fromId);
  if (!ref) return say('Pick what you are appealing.');
  const who = appellantFromDiscord(deps.db, i.userId, i.userName);
  const r = fileAppeal(deps.db, who, { ref, whatHappened: i.fields.what, whyLift: i.fields.why, source: 'discord_button' }, deps.now?.());
  if (!r.ok) return say(r.error);
  if (r.state === 'auto_denied') return say('Your appeal was denied automatically because it contains a slur.');
  return say(`Your appeal was sent. Staff will look at it, and the bot will DM you when there is news. You can also follow it at ${deps.publicUrl}/appeal`);
}
```

- [ ] **Step 4: Wire into `src/server.ts`.** Declare `let appealButton: AppealButton | null = null;`; in `onConnected` after `appealSync.start();`: `appealButton = new AppealButton({ db: deps.db, transport: t, publicUrl: deps.config.publicUrl }); appealButton.start();`. Add to `extraButtons`: `'ap:': (i) => handleAppealButton({ db: deps.db, publicUrl: deps.config.publicUrl }, i),`; to `extraModals`: `'ap:': (i) => handleAppealModal({ db: deps.db, publicUrl: deps.config.publicUrl }, i),`; change `opensModal` to `(id) => opensTicketModal(id) || opensReportModal(id) || opensAppealModal(id)`. In `onClose`: `appealButton?.stop();`.

- [ ] **Step 5: Run the test, then the full suite**

Run: `npx vitest run tests/appealButton.test.ts` then `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/discord/appealButton.ts src/server.ts tests/appealButton.test.ts
git commit -m "Appeals: an Appeal button beside Report a player; the form names the ban and files through fileAppeal"
```

---

### Task 9: Player side of the site

**Files:**
- Modify: `web/src/api.ts`, `web/src/routes/Play.tsx:28-55`, `web/src/AppRoutes.tsx`
- Create: `web/src/components/AppealBox.tsx`, `web/src/components/AppealBox.test.tsx`, `web/src/routes/Appeal.tsx`

**Interfaces:**
- Consumes: Task 5/6 routes.
- Produces: `appealApi`, types `MyAppeals`, `PlayerAppealItem`, `AppealState`, `AppealRef`; `<AppealBox fallback={string} />`; `/appeal` page.

- [ ] **Step 1: Add the client in `web/src/api.ts`** (near `peopleApi`)

```ts
export type AppealState = 'open' | 'asked' | 'answered' | 'accepted' | 'shortened' | 'denied' | 'auto_denied' | 'lapsed' | 'moot';
export interface AppealRef { kind: 'ban' | 'sanction'; id: number }
export interface PlayerAppealItem {
  ref: AppealRef; hold: boolean; sanctionKind: 'timeout' | 'ban' | null; reason: string; endsAt: string | null;
  canAppeal: boolean; refusal: string | null;
  appeal: { id: number; state: AppealState; question: string | null; answerBy: string | null; line: string | null; filedAt: string } | null;
}
export interface MyAppeals { enabled: boolean; signedInAs: 'steam' | 'discord'; name: string; textMax: number; answerMax: number; items: PlayerAppealItem[] }

export const appealApi = {
  mine: (signal?: AbortSignal) => get<MyAppeals>('/api/appeals/mine', signal),
  file: (ref: AppealRef, whatHappened: string, whyLift: string) =>
    post<{ ok: true; id: number; state: AppealState }>('/api/appeals', { kind: ref.kind, id: ref.id, whatHappened, whyLift }),
  answer: (id: number, answer: string) => post<{ ok: true }>(`/api/appeals/${id}/answer`, { answer }),
  signOut: () => post<{ ok: true }>('/api/appeals/sign-out'),
};
```

- [ ] **Step 2: Write the failing component test** `web/src/components/AppealBox.test.tsx`

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { MyAppeals } from '../api';

const { mock } = vi.hoisted(() => ({ mock: { mine: vi.fn(), file: vi.fn(), answer: vi.fn(), signOut: vi.fn() } }));
vi.mock('../api', async (orig) => ({ ...(await orig<typeof import('../api')>()), appealApi: mock }));
const { AppealBox } = await import('./AppealBox');

const base: MyAppeals = { enabled: true, signedInAs: 'steam', name: 'telltale', textMax: 1500, answerMax: 800, items: [] };
const ban = { ref: { kind: 'ban' as const, id: 4 }, hold: false, sanctionKind: null, reason: 'abandon', endsAt: null, canAppeal: true, refusal: null, appeal: null };

beforeEach(() => { for (const f of Object.values(mock)) f.mockReset(); });
afterEach(cleanup);

describe('AppealBox', () => {
  it('falls back to the old line while appeals are off', async () => {
    mock.mine.mockResolvedValue({ ...base, enabled: false });
    render(<AppealBox fallback="To appeal, message an admin in the Discord." />);
    expect(await screen.findByText('To appeal, message an admin in the Discord.')).toBeTruthy();
  });

  it('files an appeal from the two boxes', async () => {
    mock.mine.mockResolvedValue({ ...base, items: [ban] });
    mock.file.mockResolvedValue({ ok: true, id: 1, state: 'open' });
    render(<AppealBox fallback="" />);
    fireEvent.click(await screen.findByText('Appeal this ban'));
    fireEvent.input(screen.getByLabelText('What happened?'), { target: { value: 'lag' } });
    fireEvent.input(screen.getByLabelText('Why should it be lifted or shortened?'), { target: { value: 'router' } });
    fireEvent.click(screen.getByText('Send appeal'));
    await waitFor(() => expect(mock.file).toHaveBeenCalledWith(ban.ref, 'lag', 'router'));
  });

  it('shows the one question with an answer box', async () => {
    mock.mine.mockResolvedValue({ ...base, items: [{ ...ban, canAppeal: false, appeal: { id: 9, state: 'asked', question: 'Which map?', answerBy: '2026-10-07T12:00:00.000Z', line: 'Staff have one question about your appeal.', filedAt: '' } }] });
    render(<AppealBox fallback="" />);
    expect(await screen.findByText('Which map?')).toBeTruthy();
    expect(screen.getByLabelText('Your answer')).toBeTruthy();
  });

  it('a refusal is shown instead of the button', async () => {
    mock.mine.mockResolvedValue({ ...base, items: [{ ...ban, canAppeal: false, refusal: 'This ban cannot be appealed.' }] });
    render(<AppealBox fallback="" />);
    expect(await screen.findByText('This ban cannot be appealed.')).toBeTruthy();
    expect(screen.queryByText('Appeal this ban')).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run web/src/components/AppealBox.test.tsx`
Expected: FAIL, missing `./AppealBox`.

- [ ] **Step 4: Write `web/src/components/AppealBox.tsx`**

```tsx
import { useState } from 'preact/hooks';
import { ApiError, appealApi, type MyAppeals, type PlayerAppealItem } from '../api';
import { useFetch } from '../hooks/useFetch';

const what = (it: PlayerAppealItem) => (it.hold ? 'Account hold'
  : it.sanctionKind === 'timeout' ? 'Discord timeout'
    : it.sanctionKind === 'ban' ? 'Discord ban' : 'Ban');

/**
 * Everything a banned person can do about it: one entry per ban, hold or
 * Discord sanction, each with the form, the refusal, or where its appeal
 * stands. Used on the Play page (Steam session) and on /appeal (either).
 * `fallback` is what the page said before appeals existed, shown while the
 * feature is off.
 */
export function AppealBox({ fallback }: { fallback: string }) {
  const fetched = useFetch((s) => appealApi.mine(s), []);
  const data = fetched.data;
  if (!data) return null;
  if (!data.enabled) return <p class="muted">{fallback}</p>;
  if (data.items.length === 0) return <p class="muted">You have nothing to appeal.</p>;
  return <div class="stack">{data.items.map((it) => <Item key={`${it.ref.kind}:${it.ref.id}`} it={it} data={data} reload={fetched.reload} />)}</div>;
}

function Item({ it, data, reload }: { it: PlayerAppealItem; data: MyAppeals; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const send = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await fn(); setOpen(false); reload(); } catch (err) { setError(err instanceof ApiError ? err.message : 'Something went wrong.'); } finally { setBusy(false); }
  };
  const ap = it.appeal;
  const showStatus = ap && (!it.canAppeal || ap.state === 'asked');
  return (
    <div class="appeal-item">
      <p><strong>{what(it)}</strong>: {it.reason}{it.endsAt ? `, ends ${new Date(it.endsAt).toLocaleString()}` : ''}</p>
      {showStatus && ap.line && <p>{ap.line}</p>}
      {ap?.state === 'asked' && ap.question && (
        <>
          <blockquote>{ap.question}</blockquote>
          <label>Your answer
            <textarea maxLength={data.answerMax} value={answer} onInput={(e) => setAnswer((e.target as HTMLTextAreaElement).value)} />
          </label>
          <button class="btn" disabled={busy || !answer.trim()} onClick={() => send(() => appealApi.answer(ap.id, answer))}>Send answer</button>
        </>
      )}
      {it.refusal && <p class="muted">{it.refusal}</p>}
      {it.canAppeal && !open && <button class="btn" onClick={() => setOpen(true)}>Appeal this ban</button>}
      {it.canAppeal && open && (
        <>
          <p class="muted">You get one appeal at a time. Staff may ask you one question; keep it short and stick to what happened.</p>
          <label>What happened?
            <textarea maxLength={data.textMax} value={a} onInput={(e) => setA((e.target as HTMLTextAreaElement).value)} />
          </label>
          <label>Why should it be lifted or shortened?
            <textarea maxLength={data.textMax} value={b} onInput={(e) => setB((e.target as HTMLTextAreaElement).value)} />
          </label>
          <button class="btn" disabled={busy || !a.trim() || !b.trim()} onClick={() => send(() => appealApi.file(it.ref, a, b))}>Send appeal</button>
        </>
      )}
      {error && <p class="error">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 5: Use it on the Play page.** In `web/src/routes/Play.tsx`, import `AppealBox` and replace the two muted paragraphs:
  - On hold: replace the `<p class="muted">If you moved to a new Steam account ...</p>` with `<AppealBox fallback="If you moved to a new Steam account or lost your old one, message a moderator in the Discord and tell them what happened. They can lift the hold." />`
  - Banned: replace `<p class="muted">To appeal, message an admin in the Discord.</p>` with `<AppealBox fallback="To appeal, message an admin in the Discord." />`

- [ ] **Step 6: Write `web/src/routes/Appeal.tsx`**

```tsx
import { useEffect, useState } from 'preact/hooks';
import { ApiError, appealApi, type MyAppeals } from '../api';
import { Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import { AppealBox } from '../components/AppealBox';

/**
 * /appeal: the one link the bot, the site and the Discord all give out.
 * Anyone can open it. A Steam session shows that account's bans; anyone
 * else signs in with Discord (/auth/discord/appeal), which is the only way
 * in for somebody banned from the Discord itself.
 */
export function Appeal() {
  const [state, setState] = useState<{ data: MyAppeals | null; signedOut: boolean }>({ data: null, signedOut: false });
  const failed = typeof location !== 'undefined' && new URLSearchParams(location.search).get('signin') === 'failed';
  useEffect(() => {
    appealApi.mine().then(
      (data) => setState({ data, signedOut: false }),
      (err) => setState({ data: null, signedOut: err instanceof ApiError && err.status === 401 }),
    );
  }, []);
  return (
    <div class="page page--play">
      <PageHeader eyebrow="Riverside" title="Appeal a ban" />
      <Panel>
        {failed && <p class="error">Signing in with Discord did not work. Try again.</p>}
        {state.signedOut && (
          <>
            <p>Sign in so we know whose ban this is.</p>
            {/* Backend routes: target keeps preact-iso from swallowing the click (see Play.tsx SignIn). */}
            <p>
              <a class="btn" href="/auth/steam" target="_top" rel="noopener">Sign in through Steam</a>{' '}
              <a class="btn" href="/auth/discord/appeal" target="_top" rel="noopener">Sign in with Discord</a>
            </p>
            <p class="muted">Banned from the Discord server? Use Sign in with Discord; it still works.</p>
          </>
        )}
        {state.data && (
          <>
            <p class="muted">Signed in as {state.data.name}.</p>
            <AppealBox fallback="Appeals are not open right now. Message a moderator in the Discord." />
          </>
        )}
      </Panel>
    </div>
  );
}
```

(The page asks `/api/appeals/mine` once for the 401 check and `AppealBox` asks again for its own data and reloads. Two small GETs on a rarely visited page; accepted for a simpler component.)

- [ ] **Step 7: Route it.** In `web/src/AppRoutes.tsx`: `import { Appeal } from './routes/Appeal';` and `<Route path="/appeal" component={Appeal} />` beside `/how-to-play`.

- [ ] **Step 8: Run tests, typecheck and build**

Run: `npx vitest run web/src/components/AppealBox.test.tsx && npm run typecheck && npm run build && npm test`
Expected: PASS, no type errors.

- [ ] **Step 9: Commit**

```bash
git add web/src/api.ts web/src/components/AppealBox.tsx web/src/components/AppealBox.test.tsx web/src/routes/Appeal.tsx web/src/routes/Play.tsx web/src/AppRoutes.tsx
git commit -m "Appeals: the Banned and On hold panels offer the form, and /appeal signs people in with Steam or Discord"
```

---

### Task 10: Staff side of the site

**Files:**
- Modify: `web/src/api.ts`, `web/src/routes/admin/adminRoutes.ts` (+ `adminRoutes.test.ts`), `web/src/routes/Admin.tsx:102-130`, `web/src/routes/admin/StaffGuide.tsx`
- Create: `web/src/routes/admin/PeopleAppeals.tsx`, `web/src/routes/admin/AdminAppeal.tsx`, `web/src/routes/admin/AdminAppeal.test.tsx`

**Interfaces:**
- Consumes: Task 6 staff routes, Task 4 `StaffAppealRow`/`StaffAppealDetail` shapes.
- Produces: People tab "Appeals" at `/admin/people/appeals`, page `/admin/people/appeals/<id>` (section `'appeal'`), `appealUrl(id)`.

- [ ] **Step 1: Staff client in `web/src/api.ts`**

```ts
export interface StaffAppealRow {
  id: number; state: AppealState; name: string; steamid: string | null; discordId: string | null;
  about: 'ban' | 'hold' | 'timeout' | 'discord ban'; filedAt: string; decidedAt: string | null;
}
export interface StaffAppealDetail extends StaffAppealRow {
  whatHappened: string; whyLift: string;
  question: string | null; askedByName: string | null; askedAt: string | null;
  answer: string | null; answeredAt: string | null; answerBy: string | null;
  decidedByName: string | null; newExpiresAt: string | null; slurs: string[];
  target: { reason: string; createdByName: string; createdAt: string; endsAt: string | null; ticketId: number | null; noAppeal: boolean; inForce: boolean };
  earlier: { id: number; state: AppealState; decidedAt: string | null }[];
  canDecide: boolean; canShorten: boolean; canMarkFinal: boolean;
}
export const appealStaffApi = {
  list: (which: 'open' | 'closed', signal?: AbortSignal) => get<{ appeals: StaffAppealRow[] }>(`/api/mod/appeals?state=${which}`, signal),
  get: (id: number, signal?: AbortSignal) => get<StaffAppealDetail>(`/api/mod/appeals/${id}`, signal),
  ask: (id: number, question: string) => post<{ ok: true }>(`/api/mod/appeals/${id}/ask`, { question }),
  decide: (id: number, outcome: 'accept' | 'shorten' | 'deny', endsAt?: string) =>
    post<{ ok: true }>(`/api/mod/appeals/${id}/decide`, { outcome, endsAt }),
  markFinal: (id: number, on: boolean) => post<{ ok: true }>(`/api/admin/appeals/${id}/final`, { on }),
};
```

- [ ] **Step 2: Routing, test first.** Add to `web/src/routes/admin/adminRoutes.test.ts`:

```ts
  it('routes the appeals list and one appeal', () => {
    expect(parseAdminPath('/admin/people/appeals', { isAdmin: false })).toEqual({ desk: 'people', section: 'appeals', param: null });
    expect(parseAdminPath('/admin/people/appeals/12', { isAdmin: false })).toEqual({ desk: 'people', section: 'appeal', param: '12' });
    expect(parseAdminPath('/admin/people/appeals/x', { isAdmin: false }).section).toBe('unknown');
  });
```

Run: `npx vitest run web/src/routes/admin/adminRoutes.test.ts` (FAIL), then in `adminRoutes.ts`:
- `PEOPLE_TABS`: insert `{ key: 'appeals', label: 'Appeals', path: '/admin/people/appeals' },` after `tickets`.
- `export const appealUrl = (id: number | string): string => \`/admin/people/appeals/${id}\`;`
- In `people()`, after the `tickets` block:

```ts
    if (a === 'appeals') {
      if (b === '') return { desk: 'people', section: 'appeals', param: null };
      return TICKET.test(b) ? { desk: 'people', section: 'appeal', param: b } : { ...NOWHERE, desk: 'people' };
    }
```

Run it again: PASS.

- [ ] **Step 3: Write `web/src/routes/admin/PeopleAppeals.tsx`**

```tsx
import { useState } from 'preact/hooks';
import { appealStaffApi } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel } from '../../components/bits';
import { fmtTime } from './useAction';
import { appealUrl } from './adminRoutes';

const STATE: Record<string, string> = {
  open: 'waiting', asked: 'question asked', answered: 'answered', accepted: 'accepted', shortened: 'shortened',
  denied: 'denied', auto_denied: 'denied (slur)', lapsed: 'no answer', moot: 'ban ended',
};

/** Appeals waiting for staff, oldest first; or settled ones, newest first. */
export function PeopleAppeals() {
  const [which, setWhich] = useState<'open' | 'closed'>('open');
  const { data, error } = useFetch((s) => appealStaffApi.list(which, s), [which]);
  return (
    <Panel class="panel--table">
      <h3>Appeals</h3>
      <p class="muted">
        One appeal per ban at a time. You may ask one question, then accept, shorten or deny. The player only ever
        sees a fixed sentence for the outcome. <a href="/admin/people/guide#appeals">How appeals work</a>
      </p>
      <p>
        <button class={`chip${which === 'open' ? ' is-on' : ''}`} onClick={() => setWhich('open')}>Waiting</button>{' '}
        <button class={`chip${which === 'closed' ? ' is-on' : ''}`} onClick={() => setWhich('closed')}>Settled</button>
      </p>
      {error && <Empty>Could not load the appeals.</Empty>}
      {data && data.appeals.length === 0 && <Empty>{which === 'open' ? 'Nothing waiting.' : 'No settled appeals yet.'}</Empty>}
      {data && data.appeals.length > 0 && (
        <div class="table-wrap">
          <table class="admin-table">
            <thead><tr><th>#</th><th>Who</th><th>About</th><th>State</th><th>Filed</th></tr></thead>
            <tbody>
              {data.appeals.map((a) => (
                <tr key={a.id}>
                  <td><a href={appealUrl(a.id)}>#{a.id}</a></td>
                  <td>{a.name}</td>
                  <td>{a.about}</td>
                  <td>{STATE[a.state]}</td>
                  <td class="muted">{fmtTime(a.filedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
```

- [ ] **Step 4: Write the failing page test** `web/src/routes/admin/AdminAppeal.test.tsx`

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import type { StaffAppealDetail } from '../../api';

const { mock } = vi.hoisted(() => ({ mock: { get: vi.fn(), ask: vi.fn(), decide: vi.fn(), markFinal: vi.fn(), list: vi.fn() } }));
vi.mock('../../api', async (orig) => ({ ...(await orig<typeof import('../../api')>()), appealStaffApi: mock }));
const { AdminAppeal } = await import('./AdminAppeal');

const detail: StaffAppealDetail = {
  id: 3, state: 'open', name: 'telltale', steamid: '76561198000000001', discordId: null, about: 'ban', filedAt: '2026-10-04T12:00:00.000Z', decidedAt: null,
  whatHappened: 'lag', whyLift: 'router', question: null, askedByName: null, askedAt: null, answer: null, answeredAt: null, answerBy: null,
  decidedByName: null, newExpiresAt: null, slurs: [],
  target: { reason: 'abandon', createdByName: 'automatic', createdAt: '2026-10-04T11:00:00.000Z', endsAt: null, ticketId: null, noAppeal: false, inForce: true },
  earlier: [], canDecide: true, canShorten: true, canMarkFinal: false,
};

beforeEach(() => { for (const f of Object.values(mock)) f.mockReset(); });
afterEach(cleanup);

describe('AdminAppeal', () => {
  it('shows both answers and every control a deciding moderator has', async () => {
    mock.get.mockResolvedValue(detail);
    render(<AdminAppeal id={3} />);
    expect(await screen.findByText('lag')).toBeTruthy();
    for (const label of ['Ask one question', 'Accept', 'Shorten', 'Deny']) expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByText('No more appeals on this ban')).toBeNull();
  });

  it('no Ask once a question has been asked; nothing to press without canDecide', async () => {
    mock.get.mockResolvedValue({ ...detail, state: 'asked', question: 'Which map?', canDecide: false });
    render(<AdminAppeal id={3} />);
    expect(await screen.findByText('Which map?')).toBeTruthy();
    expect(screen.queryByText('Ask one question')).toBeNull();
    expect(screen.queryByText('Accept')).toBeNull();
  });
});
```

- [ ] **Step 5: Write `web/src/routes/admin/AdminAppeal.tsx`**

```tsx
import { useState } from 'preact/hooks';
import { appealStaffApi } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel } from '../../components/bits';
import { fmtTime, useAction } from './useAction';
import { fileUrl, ticketUrl } from './adminRoutes';

export function AdminAppeal({ id }: { id: number }) {
  const { data: a, error: loadError, reload } = useFetch((s) => appealStaffApi.get(id, s), [id]);
  const { busy, error, run } = useAction(reload);
  const [question, setQuestion] = useState('');
  const [endsAt, setEndsAt] = useState('');
  if (loadError) return <Empty>No such appeal.</Empty>;
  if (!a) return null;
  const open = a.state === 'open' || a.state === 'asked' || a.state === 'answered';

  return (
    <div class="stack">
      <Panel>
        <p class="eyebrow">Appeal #{a.id} · {a.about}</p>
        <h3>{a.steamid ? <a href={fileUrl(a.steamid)}>{a.name}</a> : a.name}</h3>
        <p>
          <strong>Ban:</strong> {a.target.reason}, by {a.target.createdByName} on {fmtTime(a.target.createdAt)},{' '}
          {a.target.endsAt ? `ends ${fmtTime(a.target.endsAt)}` : 'permanent'}
          {a.target.ticketId !== null && <> · <a href={ticketUrl(a.target.ticketId)}>ticket #{a.target.ticketId}</a></>}
          {!a.target.inForce && <> · <em>no longer in force</em></>}
        </p>
        {a.earlier.length > 0 && <p class="muted">Earlier appeals on this ban: {a.earlier.map((e) => `#${e.id} ${e.state}`).join(', ')}</p>}
        <h4>What happened</h4>
        <p class="pre-wrap">{a.whatHappened}</p>
        <h4>Why it should be lifted or shortened</h4>
        <p class="pre-wrap">{a.whyLift}</p>
        {a.question && <><h4>Question from {a.askedByName}</h4><p class="pre-wrap">{a.question}</p></>}
        {a.state === 'asked' && a.answerBy && <p class="muted">Waiting for an answer until {fmtTime(a.answerBy)}.</p>}
        {a.answer && <><h4>Answer</h4><p class="pre-wrap">{a.answer}</p></>}
        {a.slurs.length > 0 && <p class="error">Denied automatically: {a.slurs.join(', ')}.</p>}
        {!open && <p><strong>{a.state}</strong>{a.decidedByName ? ` by ${a.decidedByName}` : ''}{a.decidedAt ? `, ${fmtTime(a.decidedAt)}` : ''}{a.newExpiresAt ? `; now ends ${fmtTime(a.newExpiresAt)}` : ''}</p>}
      </Panel>

      {open && a.canDecide && (
        <Panel>
          {error && <p class="error">{error}</p>}
          {a.state === 'open' && (
            <p>
              <label>One question (you only get one)
                <input type="text" maxLength={500} value={question} onInput={(e) => setQuestion((e.target as HTMLInputElement).value)} />
              </label>
              <button class="btn" disabled={busy || !question.trim()} onClick={() => run(() => appealStaffApi.ask(a.id, question))}>Ask one question</button>
            </p>
          )}
          <p class="admin-actions">
            <button class="btn" disabled={busy} onClick={() => run(() => appealStaffApi.decide(a.id, 'accept'), {
              title: 'Accept this appeal?', body: 'The ban is lifted now. The player is told their appeal was accepted.', confirmLabel: 'Accept',
            })}>Accept</button>
            {a.canShorten && (
              <>
                <input type="datetime-local" value={endsAt} onInput={(e) => setEndsAt((e.target as HTMLInputElement).value)} />
                <button class="btn" disabled={busy || !endsAt} onClick={() => run(() => appealStaffApi.decide(a.id, 'shorten', new Date(endsAt).toISOString()), {
                  title: 'Shorten this ban?', body: `It will end ${new Date(endsAt).toLocaleString()}. The player is told the new end.`, confirmLabel: 'Shorten',
                })}>Shorten</button>
              </>
            )}
            <button class="btn btn--danger" disabled={busy} onClick={() => run(() => appealStaffApi.decide(a.id, 'deny'), {
              title: 'Deny this appeal?', body: 'The ban stands. The player is told so, and when they may appeal again.', confirmLabel: 'Deny', danger: true,
            })}>Deny</button>
          </p>
        </Panel>
      )}

      {a.canMarkFinal && (
        <Panel>
          <button class="btn" disabled={busy} onClick={() => run(() => appealStaffApi.markFinal(a.id, !a.target.noAppeal))}>
            {a.target.noAppeal ? 'Allow appeals on this ban again' : 'No more appeals on this ban'}
          </button>
        </Panel>
      )}
    </div>
  );
}
```

(If `pre-wrap` / `btn--danger` classes do not exist in the stylesheet, use whatever `AdminTicket.tsx` uses for user text and destructive buttons.)

- [ ] **Step 6: Render them in `web/src/routes/Admin.tsx`.** Import both; add beside the tickets lines:

```tsx
        {r.desk === 'people' && r.section === 'appeals' && <PeopleAppeals />}
        {r.desk === 'people' && r.section === 'appeal' && <AdminAppeal key={r.param} id={Number(r.param)} />}
```

and extend `activeSection`: `r.section === 'appeal' ? 'appeals' : ...` in the existing ternary chain.

- [ ] **Step 7: Staff guide entry.** In `StaffGuide.tsx` add `<li><a href="#appeals">Appeals</a></li>` to the index and, before the closing `</div>`:

```tsx
      <Panel id="appeals">
        <h3>Appeals</h3>
        <p>
          Banned, held and Discord-sanctioned people can appeal from the site, the Appeal button beside Report a player,
          or riversidepug.com/appeal. Each ban gets one appeal at a time and two in total; after a denial they wait seven
          days. Bans shorter than a day cannot be appealed (holds always can).
        </p>
        <p>
          You may ask <strong>one</strong> question. They have 72 hours to answer; no answer closes the appeal as denied.
          Then Accept (the ban is lifted), Shorten (pick a new end; website bans only) or Deny. The player only ever sees
          a fixed sentence for the outcome, so there is nothing to argue with.
        </p>
        <p>
          Anyone at the issuer's rank or above decides, including whoever issued the ban: an admin's ban needs an admin.
          An appeal containing a slur is denied automatically and still shown here. Appeals by staff, or about a ban from
          a restricted ticket, have no forum post. An admin can mark a ban "No more appeals".
        </p>
      </Panel>
```

- [ ] **Step 8: Run tests, typecheck, build, full suite**

Run: `npx vitest run web/src/routes/admin/AdminAppeal.test.tsx web/src/routes/admin/adminRoutes.test.ts web/src/routes/admin/StaffGuide.test.tsx && npm run typecheck && npm run build && npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add web/src/api.ts web/src/routes/admin/adminRoutes.ts web/src/routes/admin/adminRoutes.test.ts web/src/routes/Admin.tsx web/src/routes/admin/PeopleAppeals.tsx web/src/routes/admin/AdminAppeal.tsx web/src/routes/admin/AdminAppeal.test.tsx web/src/routes/admin/StaffGuide.tsx
git commit -m "Appeals: People > Appeals tab and appeal page (ask once, accept, shorten, deny, mark final), Staff guide entry"
```

---

### Task 11: Verification before handing back

No new code unless a check fails.

- [ ] **Step 1: Whole suite, typecheck, build**

Run: `npm run build && npm run typecheck && npm test`
Expected: green apart from the known pre-existing failures (compare the failing names against a master run).

- [ ] **Step 2: Migration dry-run on a production copy.** Copy the newest backup from the Dallas box into the scratchpad (read-only use; never write to the live DB), then:

```bash
cp <backup>.db "$SCRATCH/appeals-dryrun.db"
npx tsx -e "import { openDb } from './src/db.ts'; const db = openDb(process.argv[1]); console.log(db.prepare('PRAGMA foreign_key_check').all()); console.log(db.prepare('SELECT COUNT(*) AS n FROM bans').get(), db.prepare('SELECT COUNT(*) AS n FROM discord_sanctions').get());" "$SCRATCH/appeals-dryrun.db"
```

Run it twice. Expected: `appeals` and `appeal_message` exist, `no_appeal` on both tables, `foreign_key_check` empty, counts unchanged, running it twice changes nothing.

- [ ] **Step 3: Local proof of the Discord-only path** (owner has no Discord-banned account). On a scratch copy DB with the dev server (`npm run dev:api` against the copy, `appeals_enabled=1`): insert `INSERT INTO discord_sanctions (discord_id, kind, until, reason, created_by, created_at) VALUES ('<owner discord id>', 'ban', NULL, 'test', '<an admin steamid>', datetime('now'))`, open `/appeal`, Sign in with Discord, file, then as staff ask, answer, deny; check the page shows each step. Delete the scratch DB after.

- [ ] **Step 4: Whole-branch review** (subagent-driven: the final reviewer), then report. Do NOT deploy: deploying is the owner's call (memory `feedback-deploy-when-empty`; web deploys may go out during matches, but only when asked).

---

## Owner's live checklist (after deploy, with `appeals_enabled` on)

1. The Appeal message appears in the report channel beside Report a player.
2. A timed-out member presses Appeal: the form opens (if Discord blocks timed-out members from components, the timeout DM's /appeal link is the path, which is fine).
3. An outcome DM arrives.
