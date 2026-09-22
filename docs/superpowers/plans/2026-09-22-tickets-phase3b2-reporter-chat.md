# Tickets Phase 3b2 Implementation Plan: reporter chat

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reporter (a player or a Discord-only member) can open a private chat with the moderators about an open report, from the filing receipt, from a My reports button on the report message, or from the site; staff can open the same chat with Contact reporter, join it and end it; on a normal ticket the reporter's messages are copied onto the staff forum post; closing a ticket ends its chats and thanks the reporters.

**Architecture:** The rules live in `src/tickets/reporterChat.ts` as database functions (who may open a chat, who may be in one, the once-an-hour ping, the close notices). The Discord half is a new `ReporterChats` class (`src/discord/reporterChats.ts`) whose public methods run on the reconciler's chain through `TicketSync.serialise`, like the mirror's removals. Everything that must happen eventually rather than now (ending chats when a ticket closes, the close DM, staff pings, copying reporter messages onto the forum post) is done by `TicketSync.reconcileTicket` from database state, so it is retried by the timer and survives restarts. The mirror, which already copies every message in a reporter thread onto the site, gains one hook that tells the reconciler something new arrived; the copy onto the forum post (`syncRelay`) and its deletion (in the mirror's removal sweep) are both keyed on a `relay_messages` row.

**Tech Stack:** TypeScript, better-sqlite3, fastify, vitest, discord.js 14.27 (no new calls), Preact.

**Spec:** `docs/superpowers/specs/2026-09-22-tickets-phase3-design.md`, section 3 ("Reporter chat"), with the phase 2b reviewer's handoff (`.superpowers/sdd/2026-09-22-tickets-phase2b/progress.md`, "Phase 3 handoff from the reviewer"). Built on phase 3b1 (`2026-09-22-tickets-phase3b1-staff-tickets.md`), which this plan assumes is merged: restricted tickets have no staff thread (`surfaceFor` answers `{ surface: null, why: 'restricted' }`), a report about staff is an ordinary ticket, and `ticketIsQuiet(db, t)` decides whether an audit row stays off the admin feed.

## Global Constraints

- **Run the FULL suite (`npx vitest run`) and `npm run typecheck` at the end of every task.** `tests/db.test.ts` has an exhaustive table list (Task 1 adds three tables); `tests/mergePlayers.test.ts` sweeps every foreign key to `players` (no new column here points at `players`).
- **Known test noise:** ECONNREFUSED lines are pre-existing and harmless. `tests/logAuthWiring.test.ts` is a known flake. A fresh worktree has no `dist/`, and `tests/server.test.ts`'s malformed-URL case fails until `npm run build` has run once. None of these are yours; do not stash, reset or "check" them.
- **Never use `git stash`.** Never reset, never touch master. **No em dashes** anywhere: code, comments, copy, commit messages.
- **NULL safety.** A reporter is `reporter_id` (a player) or `reporter_discord_id` (a Discord-only member); a target is `target_id` or `target_discord_id`. `x = y` is NULL when either side is NULL, and `NULL IS NOT NULL` is false, so "the reporter is not the accused" must be written per identity kind: `NOT ((r.reporter_id IS NOT NULL AND r.reporter_id = t.target_id) OR (r.reporter_discord_id IS NOT NULL AND r.reporter_discord_id = t.target_discord_id))`, never `r.reporter_id IS NOT t.target_id` alone (that is false for a Discord-only reporter about a Discord-only target). Look a reporter's thread up with `reporter_id IS ? AND reporter_discord_id IS ?`.
- **Chains.** `TicketSync`'s chain waits on the mirror's (`saveBeforeDelete` calls `mirror.catchUp`), and the mirror's removals wait on `TicketSync`'s (`serialise`). Nothing called from the mirror's own chain may wait on `TicketSync`'s: the mirror's new hook writes one row and queues, and returns. Nothing called from INSIDE `TicketSync`'s chain may call `serialise` (it would wait on itself): the reconciler calls the free functions `endReporterThread` and `syncRelay` directly, and only `ReporterChats`' public methods go through `serialise`.
- **Discord first, then the record.** A chat row, a relay row, an "ended" state is written only after Discord accepted the call it stands for, except where a charge-before-send is the point (pings and notices are marked sent before the send, as `notifyAccess` does, so a refused DM is never retried).
- **Privacy.**
  - The accused never enters a chat about their own ticket: `reporterThreadAudience` leaves out the target, and a reporter who has since become the target (a merge) is left out too.
  - A restricted ticket's chat is joined only by people on its access list, its reporter's messages are never copied anywhere in Discord, and the access list is DMed "The reporter wrote on ticket #N" with a link and no content.
  - A reporter learns nothing about the ticket: custom ids carry the REPORT id, never the ticket id (the ticket id would tell two reporters they reported the same case), and the chat's name is "Chat with the moderators".
  - Relayed files are a link to the ticket page, never a re-upload and never a Discord CDN link (those expire, and a reporter's file is click-to-reveal on the site).
  - Admin feed text names nobody; audit rows use `ticketIsQuiet`.
- Only `src/discord/djsTransport.ts` imports discord.js. No new Discord call is needed: private threads, members, lock, archive, send, edit, remove and DM all exist on `BotTransport`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/tickets/schema.ts` (modify) | `relay_messages`, `reporter_chat_pings`, `ticket_notices`. |
| `src/tickets/threads.ts` (modify) | `ThreadRow.reporter_discord_id`; `insertThread` takes `reporterDiscordId`. |
| `src/tickets/store.ts` (modify) | `foldTicket` moves `ticket_notices`. |
| `src/tickets/filing.ts` (modify) | `discordReporterBlocked` extracted for reuse. |
| `src/tickets/reporterChat.ts` (create) | The rules: who may open or contact, `reporterThreadAudience`, threads by reporter, pings, close notices, open reports for a presser. |
| `src/tickets/actions.ts` (modify) | `closeTicket(..., tellReporters)` queues the close notices. |
| `src/tickets/removal.ts` (modify) | `removeMessages`, the batch entry point. |
| `src/discord/reporterChats.ts` (create) | `ReporterChats` (open, contact, join, end) and `endReporterThread`. |
| `src/discord/reporterRelay.ts` (create) | `syncRelay`: reporter messages copied onto the forum post. |
| `src/discord/ticketSync.ts` (modify) | Eject from reporter threads, end chats on close, close DMs, pings, relay, `reporterActivity`. |
| `src/discord/ticketMirror.ts` (modify) | `onReporterActivity` hook; relay copies deleted in the removal sweep. |
| `src/discord/ticketCard.ts` (modify) | Second button row; `chatButton`, `closeDm`, `reporterWroteDm`; close modal's "tell" field. |
| `src/discord/ticketButtons.ts` (modify) | `t:<id>:contact`, `t:<id>:join`, `t:<id>:endchat`; close passes "tell". |
| `src/discord/reportButton.ts`, `src/discord/commands.ts` (modify) | Receipt Chat button, My reports button, `rp:chat:<reportId>`. |
| `src/discord/adminFeedPoster.ts` (modify) | Feed text for the three new audit actions. |
| `src/routes/tickets.ts`, `src/server.ts` (modify) | Site routes; wiring; `ServerDeps.reporterChats` test seam. |
| `src/tickets/views.ts` (modify) | `ticketDetail(...).reporterChats`. |
| `web/src/api.ts`, `web/src/routes/admin/AdminTicket.tsx`, `web/src/routes/admin/TicketTimeline.tsx`, `web/src/components/MyReports.tsx` (modify) | Contact reporter, the chats section, the close tick, My reports Chat. |

---

### Task 1: The rules and the tables

**Files:**
- Create: `src/tickets/reporterChat.ts`
- Modify: `src/tickets/schema.ts`, `src/tickets/threads.ts`, `src/tickets/store.ts`, `src/tickets/filing.ts`, `src/tickets/actions.ts`
- Test: `tests/reporterChat.test.ts` (create), `tests/db.test.ts` (table list)

**Interfaces:**
- Produces, in `src/tickets/reporterChat.ts`:

```ts
export const CHAT_CLOSED: string;       // 'This report is closed. File a new one if something has happened since.'
export const CHAT_REFUSED: string;      // 'You cannot open a chat right now.'
export const CHAT_NO_DISCORD: string;   // 'Link your Discord account on your profile first: the chat happens in Discord.'
export const PING_GAP_MS: number;       // 60 * 60_000
export interface ReporterRef { reporterId: string | null; reporterDiscordId: string | null }
export type ReporterAsker = { kind: 'player'; steamid: string } | { kind: 'discord'; discordId: string; timedOutUntil: string | null };
export interface ChatPlan { ticketId: number; reportId: number; ref: ReporterRef; reporterDiscordId: string; restricted: boolean; claimedBy: string | null }
export type Checked<T> = { ok: true; plan: T } | { ok: false; status: number; error: string };
export function reporterDiscordIdOf(db: DB, ref: ReporterRef): string | null;
export function isReporterMessage(th: Pick<ThreadRow, 'reporter_id' | 'reporter_discord_id'>, m: Pick<MessageRow, 'author_discord_id' | 'author_player_id'>): boolean;
export function reporterLabel(db: DB, ticketId: number, ref: ReporterRef): string;
export function checkReporterChat(db: DB, reportId: number, asker: ReporterAsker, now?: Date): Checked<ChatPlan>;
export function checkContactReporter(db: DB, ticketId: number, reportId: number, staff: string): Checked<ChatPlan>;
export function checkChatStaff(db: DB, ticketId: number, staff: string): Checked<TicketRow>;
export function reporterThreadFor(db: DB, ticketId: number, ref: ReporterRef): ThreadRow | undefined;
export function reporterThreadsOf(db: DB, ticketId: number, state?: 'open' | 'ended'): ThreadRow[];
export function reporterThreadAudience(db: DB, th: ThreadRow): string[];   // Discord ids
export function requestPing(db: DB, threadId: string, now?: Date): void;
export function takeDuePings(db: DB, ticketId: number, now?: Date): string[];
export function queueCloseNotices(db: DB, ticketId: number, now?: Date): number;
export function takeNotices(db: DB, ticketId: number, now?: Date): { id: number; discord_id: string }[];
export interface OpenReport { reportId: number; targetName: string; category: string }
export function openReportsOf(db: DB, asker: ReporterAsker, limit?: number): OpenReport[];
```

- Produces elsewhere: `ThreadRow.reporter_discord_id: string | null`; `insertThread(db, { ..., reporterDiscordId?: string | null })`; `discordReporterBlocked(db: DB, discordId: string, timedOutUntil: string | null, now: Date): boolean` from `filing.ts`; `closeTicket(db, id, by, outcome, note, tellReporters = true)`.

Why a `wanted_at` beside the spec's `last_ping_at`: the cap is "at most once an hour per thread", and a ping asked for inside the hour must still go out once the hour is up, rather than be dropped. `wanted_at` is that pending ask; the reconciler's five-minute timer sends it.

Why `ticket_notices` (not in the spec's table list): the close DM must be sent by the bot, after the chats have ended, whether or not the bot was running when the ticket closed. An outbox row written in the close's own transaction is what makes that true.

- [ ] **Step 1: Write the failing tests** `tests/reporterChat.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { fileReport } from '../src/tickets/filing.js';
import { addAccess, closeTicket } from '../src/tickets/actions.js';
import { foldTicket } from '../src/tickets/store.js';
import { insertThread } from '../src/tickets/threads.js';
import {
  CHAT_CLOSED, CHAT_NO_DISCORD, CHAT_REFUSED, PING_GAP_MS, checkChatStaff, checkContactReporter, checkReporterChat,
  isReporterMessage, openReportsOf, queueCloseNotices, reporterDiscordIdOf, reporterLabel, reporterThreadAudience,
  reporterThreadFor, requestPing, takeDuePings, takeNotices,
} from '../src/tickets/reporterChat.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000040${i}`);
const [R1, R2, ACCUSED, UNLINKED, , MOD2, MOD, ADMIN] = IDS;
const deps = { adminSteamIds: [ADMIN] };
const LURKER = { kind: 'discord' as const, discordId: '9990', name: 'Lurky', timedOutUntil: null };
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []);
    activatePlayer(db, id);
    if (id !== UNLINKED) linkDiscord(db, id, `94${i}`, `d${i}`);
  });
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid IN (?, ?)').run(MOD, MOD2);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
});

const file = (by: string | typeof LURKER, target: string, category = 'griefing', text = 'x') =>
  fileReport(db, by, { targetId: target, category, text }, deps) as { ok: true; reportId: number; ticketId: number };
const thread = (ticketId: number, ref: { reporterId?: string | null; reporterDiscordId?: string | null }, id = '8100') =>
  insertThread(db, { ticketId, kind: 'reporter', surface: 'private', channelId: 'chan1', threadId: id, reporterId: ref.reporterId ?? null, reporterDiscordId: ref.reporterDiscordId ?? null });

describe('who may open a chat', () => {
  it('the reporter of an open report, player or Discord-only', () => {
    const a = file(R1, ACCUSED);
    expect(checkReporterChat(db, a.reportId, { kind: 'player', steamid: R1 })).toEqual({
      ok: true, plan: { ticketId: a.ticketId, reportId: a.reportId, ref: { reporterId: R1, reporterDiscordId: null }, reporterDiscordId: '940', restricted: false, claimedBy: null },
    });
    const b = file(LURKER, ACCUSED, 'toxicity');
    expect(checkReporterChat(db, b.reportId, { kind: 'discord', discordId: '9990', timedOutUntil: null })).toMatchObject({
      ok: true, plan: { ref: { reporterId: null, reporterDiscordId: '9990' }, reporterDiscordId: '9990' },
    });
  });

  it('refuses somebody else\'s report, a missing one and a closed one with the same words', () => {
    const a = file(R1, ACCUSED);
    const closed = { ok: false, status: 404, error: CHAT_CLOSED };
    expect(checkReporterChat(db, a.reportId, { kind: 'player', steamid: R2 })).toEqual(closed);
    expect(checkReporterChat(db, 9999, { kind: 'player', steamid: R1 })).toEqual(closed);
    closeTicket(db, a.ticketId, MOD, 'no_action', '', false);
    expect(checkReporterChat(db, a.reportId, { kind: 'player', steamid: R1 })).toEqual(closed);
  });

  it('refuses a reporter who is not in good standing, timed out, or with no Discord to chat on', () => {
    const a = file(R1, ACCUSED);
    db.prepare("INSERT INTO bans (player_id, reason, created_by, created_at) VALUES (?, 'x', 'system', ?)").run(R1, new Date().toISOString());
    expect(checkReporterChat(db, a.reportId, { kind: 'player', steamid: R1 })).toEqual({ ok: false, status: 403, error: CHAT_REFUSED });
    const b = file(LURKER, ACCUSED, 'toxicity');
    const later = new Date(Date.now() + 3_600_000).toISOString();
    expect(checkReporterChat(db, b.reportId, { kind: 'discord', discordId: '9990', timedOutUntil: later })).toEqual({ ok: false, status: 403, error: CHAT_REFUSED });
    const c = file(UNLINKED, ACCUSED, 'afk');
    expect(checkReporterChat(db, c.reportId, { kind: 'player', steamid: UNLINKED })).toEqual({ ok: false, status: 400, error: CHAT_NO_DISCORD });
  });

  it('never opens a chat for a reporter who has since become the accused', () => {
    const a = file(R1, ACCUSED);
    db.prepare('UPDATE tickets SET target_id = ? WHERE id = ?').run(R1, a.ticketId);
    expect(checkReporterChat(db, a.reportId, { kind: 'player', steamid: R1 })).toMatchObject({ ok: false, error: CHAT_CLOSED });
  });

  it('staff contact: visible, open, a report on this ticket, a reporter reachable on Discord', () => {
    const a = file(R1, ACCUSED);
    const other = file(R2, R1);
    expect(checkContactReporter(db, a.ticketId, a.reportId, MOD)).toMatchObject({ ok: true, plan: { reporterDiscordId: '940' } });
    expect(checkContactReporter(db, a.ticketId, other.reportId, MOD)).toMatchObject({ ok: false, status: 404 });
    expect(checkContactReporter(db, a.ticketId, a.reportId, ACCUSED)).toMatchObject({ ok: false, status: 404 });
    const u = file(UNLINKED, ACCUSED, 'afk');
    expect(checkContactReporter(db, a.ticketId, u.reportId, MOD)).toMatchObject({ ok: false, status: 400 });
    closeTicket(db, a.ticketId, MOD, 'no_action', '', false);
    expect(checkContactReporter(db, a.ticketId, a.reportId, MOD)).toMatchObject({ ok: false, status: 409 });
    expect(checkChatStaff(db, a.ticketId, ACCUSED)).toMatchObject({ ok: false, status: 404 });
  });
});

describe('who may be in a chat', () => {
  it('on a normal ticket: the reporter and every linked, active member of staff but the accused', () => {
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(ACCUSED);
    const a = file(R1, ACCUSED);
    expect(reporterThreadAudience(db, thread(a.ticketId, { reporterId: R1 })).sort()).toEqual(['940', '945', '946', '947']);
  });

  it('on a restricted ticket: the reporter and the access list', () => {
    const a = file(R1, ACCUSED, 'unsafe', 'threats');
    expect(reporterThreadAudience(db, thread(a.ticketId, { reporterId: R1 })).sort()).toEqual(['940', '947']);
    addAccess(db, a.ticketId, ADMIN, MOD);
    expect(reporterThreadAudience(db, thread(a.ticketId, { reporterId: R1 }, '8101')).sort()).toEqual(['940', '946', '947']);
  });

  it('a Discord-only reporter by their own id, and never a reporter who has become the accused', () => {
    const a = file(LURKER, ACCUSED, 'toxicity');
    const th = thread(a.ticketId, { reporterDiscordId: '9990' });
    expect(reporterThreadAudience(db, th)).toContain('9990');
    db.prepare("UPDATE tickets SET target_id = NULL, target_discord_id = '9990' WHERE id = ?").run(a.ticketId);
    expect(reporterThreadAudience(db, th)).not.toContain('9990');
  });

  it('finds a reporter\'s thread by either identity, NULL-safely', () => {
    const a = file(R1, ACCUSED);
    const b = file(LURKER, ACCUSED, 'toxicity');
    const mine = thread(a.ticketId, { reporterId: R1 });
    const theirs = thread(b.ticketId, { reporterDiscordId: '9990' }, '8102');
    expect(reporterThreadFor(db, a.ticketId, { reporterId: R1, reporterDiscordId: null })!.id).toBe(mine.id);
    expect(reporterThreadFor(db, b.ticketId, { reporterId: null, reporterDiscordId: '9990' })!.id).toBe(theirs.id);
    expect(reporterThreadFor(db, a.ticketId, { reporterId: R2, reporterDiscordId: null })).toBeUndefined();
    expect(reporterDiscordIdOf(db, { reporterId: R1, reporterDiscordId: null })).toBe('940');
    expect(reporterLabel(db, b.ticketId, { reporterId: null, reporterDiscordId: '9990' })).toBe('Lurky');
    expect(isReporterMessage(mine, { author_discord_id: '940', author_player_id: R1 })).toBe(true);
    expect(isReporterMessage(mine, { author_discord_id: '946', author_player_id: MOD })).toBe(false);
    expect(isReporterMessage(theirs, { author_discord_id: '9990', author_player_id: null })).toBe(true);
  });
});

describe('pings and notices', () => {
  it('a ping asked for is sent at most once an hour per thread, and one asked inside the hour waits', () => {
    const a = file(R1, ACCUSED);
    thread(a.ticketId, { reporterId: R1 });
    const t0 = new Date('2026-09-23T12:00:00Z');
    requestPing(db, '8100', t0);
    expect(takeDuePings(db, a.ticketId, t0)).toEqual(['8100']);
    expect(takeDuePings(db, a.ticketId, t0)).toEqual([]);
    requestPing(db, '8100', new Date(t0.getTime() + 60_000));
    expect(takeDuePings(db, a.ticketId, new Date(t0.getTime() + 120_000))).toEqual([]);
    expect(takeDuePings(db, a.ticketId, new Date(t0.getTime() + PING_GAP_MS))).toEqual(['8100']);
  });

  it('closing with the tick queues one notice per reporter reachable on Discord, Discord-only ones included', () => {
    const a = file(R1, ACCUSED);
    file(R2, ACCUSED, 'afk');
    file(LURKER, ACCUSED, 'toxicity');
    file(UNLINKED, ACCUSED, 'cheating');
    expect(closeTicket(db, a.ticketId, MOD, 'warned', '', true)).toEqual({ ok: true });
    expect(takeNotices(db, a.ticketId).map((n) => n.discord_id).sort()).toEqual(['940', '941', '9990']);
    expect(takeNotices(db, a.ticketId)).toEqual([]);
  });

  it('a Discord-only reporter about a Discord-only accused is still told (the NULL trap)', () => {
    const r = fileReport(db, LURKER, { category: 'toxicity', text: '' }, {
      ...deps, targetDiscord: { discordId: '9991', name: 'Other', bot: false, administrator: false },
    }) as { ticketId: number };
    expect(queueCloseNotices(db, r.ticketId)).toBe(1);
  });

  it('closing without the tick queues nothing; a fold carries notices across', () => {
    const a = file(R1, ACCUSED);
    closeTicket(db, a.ticketId, MOD, 'warned', '', false);
    expect(takeNotices(db, a.ticketId)).toEqual([]);
    const keep = file(R2, R1).ticketId;
    const gone = file(R2, UNLINKED).ticketId;
    queueCloseNotices(db, gone);
    db.transaction(() => foldTicket(db, gone, keep, 'merge'))();
    expect(takeNotices(db, keep)).toHaveLength(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('lists a presser\'s open reports, newest first, never a closed one', () => {
    const a = file(R1, ACCUSED);
    const b = file(R1, R2, 'afk');
    closeTicket(db, a.ticketId, MOD, 'warned', '', false);
    expect(openReportsOf(db, { kind: 'player', steamid: R1 })).toEqual([{ reportId: b.reportId, targetName: 'player1', category: 'afk' }]);
    const c = file(LURKER, ACCUSED, 'toxicity');
    expect(openReportsOf(db, { kind: 'discord', discordId: '9990', timedOutUntil: null })).toEqual([{ reportId: c.reportId, targetName: 'player2', category: 'toxicity' }]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/reporterChat.test.ts`
Expected: FAIL (the module does not exist).

- [ ] **Step 3: The tables** in `src/tickets/schema.ts`, at the end of the template string in `ensureTicketSchema`, before the closing backtick:

```sql
    -- Phase 3b2. A reporter's message in a reporter thread, and its copy on
    -- the staff forum post. source_message_id is the original's Discord id
    -- (ticket_messages.discord_message_id). One copy at a time: a new post
    -- (a reopen) replaces the row. `hash` is of the payload last sent, so an
    -- edit is only sent when the copy would change. The row goes once the
    -- copy is deleted in Discord; while the original is removed or deleted
    -- and the row stands, the removal sweep still owes that deletion.
    CREATE TABLE IF NOT EXISTS relay_messages (
      source_message_id TEXT PRIMARY KEY,
      relay_message_id  TEXT NOT NULL,
      relay_thread_id   TEXT NOT NULL,
      hash              TEXT NOT NULL
    );

    -- The once-an-hour cap on telling staff about a reporter chat, per
    -- Discord thread. wanted_at is a ping asked for and not yet sent; the
    -- reconciler sends it once last_ping_at is an hour old.
    CREATE TABLE IF NOT EXISTS reporter_chat_pings (
      thread_id    TEXT PRIMARY KEY,
      last_ping_at TEXT,
      wanted_at    TEXT
    );

    -- DMs owed to reporters, written in the transaction that closes a
    -- ticket and sent by the bot after that ticket's chats have ended.
    -- Marked sent before the send: a refused DM is never retried.
    CREATE TABLE IF NOT EXISTS ticket_notices (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id  INTEGER NOT NULL REFERENCES tickets(id),
      discord_id TEXT NOT NULL,
      kind       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sent_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_notices_unsent ON ticket_notices (ticket_id) WHERE sent_at IS NULL;
```

`tests/db.test.ts`: add `'relay_messages'` and `'reporter_chat_pings'` in alphabetical position, and `'ticket_notices'` between the other `ticket_*` names, in the expected table list.

`ticket_notices` references `tickets`, which `widenTicketIdentity` rebuilds on a fresh database at every open; it is handled exactly as `ticket_events` is (the rebuild runs with foreign keys off and checks `foreign_key_check` afterwards), so nothing in `identityMigration.ts` changes. `tests/ticketIdentityMigration.test.ts` proves it on the full suite run.

- [ ] **Step 4: `src/tickets/threads.ts` and `src/tickets/store.ts`**

In `ThreadRow`, after `reporter_id: string | null;` add `reporter_discord_id: string | null;`. `insertThread` becomes:

```ts
export function insertThread(db: DB, t: {
  ticketId: number; kind: 'staff' | 'reporter'; surface: ThreadSurface; channelId: string; threadId: string;
  reporterId?: string | null; reporterDiscordId?: string | null; cardMessageId?: string | null; cardHash?: string;
}, now = new Date()): ThreadRow {
  db.prepare(
    `INSERT INTO ticket_threads (ticket_id, kind, reporter_id, reporter_discord_id, channel_id, thread_id, created_at, surface, card_message_id, card_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(t.ticketId, t.kind, t.reporterId ?? null, t.reporterDiscordId ?? null, t.channelId, t.threadId, now.toISOString(), t.surface, t.cardMessageId ?? null, t.cardHash ?? '');
  return threadByDiscordId(db, t.threadId)!;
}
```

In `foldTicket` (`store.ts`), after the `discord_sanctions` line:

```ts
  // Close DMs owed to reporters reference the ticket too: a notice queued on
  // the emptied ticket still goes out, from the survivor.
  db.prepare('UPDATE ticket_notices SET ticket_id = ? WHERE ticket_id = ?').run(keep, gone);
```

- [ ] **Step 5: `src/tickets/filing.ts`, extract `discordReporterBlocked`**

Add, above `fileReport`:

```ts
/**
 * The Discord-side equivalent of inGoodStanding, for somebody with no player
 * account: timed out in Discord right now, under a sanction the bot carried
 * out, or the most recent owner of this Discord id is a banned player (the
 * gap a banned player walks through by unlinking and carrying on in Discord;
 * linkDiscord refuses the same thing in the other direction). Filing a report
 * and opening a chat about one both ask this.
 */
export function discordReporterBlocked(db: DB, discordId: string, timedOutUntil: string | null, now: Date): boolean {
  const timedOut = timedOutUntil !== null && Date.parse(timedOutUntil) > now.getTime();
  if (timedOut || activeDiscordSanction(db, discordId, now)) return true;
  const lastOwner = db.prepare(
    'SELECT steamid FROM discord_link_history WHERE discord_id = ? ORDER BY id DESC LIMIT 1',
  ).get(discordId) as { steamid: string } | undefined;
  return !!lastOwner && hasActiveBan(db, lastOwner.steamid, now);
}
```

and in `fileReport` replace the whole `else { ... }` branch of the standing check with:

```ts
  } else if (discordReporterBlocked(db, reporter.discordId, reporter.timedOutUntil, now)) {
    return fail(403, 'you cannot file reports right now');
  }
```

- [ ] **Step 6: `src/tickets/reporterChat.ts`**

```ts
import type { DB } from '../db.js';
import { inGoodStanding } from '../standing.js';
import { discordReporterBlocked } from './filing.js';
import type { MessageRow } from './messages.js';
import { canSeeTicket, getTicketRow, type TicketRow } from './store.js';
import type { ThreadRow } from './threads.js';

/**
 * Reporter chat: the rules, as database functions. The Discord half is
 * src/discord/reporterChats.ts; the reconciler's half is in ticketSync.ts.
 *
 * A reporter is exactly one of a player (reporter_id) or a Discord-only
 * member (reporter_discord_id), on ticket_reports and on ticket_threads
 * alike. Every comparison here is written for both, NULL-safely.
 */

export const CHAT_CLOSED = 'This report is closed. File a new one if something has happened since.';
export const CHAT_REFUSED = 'You cannot open a chat right now.';
export const CHAT_NO_DISCORD = 'Link your Discord account on your profile first: the chat happens in Discord.';
/** The spec's cap: staff are told about a chat at most once an hour per thread. */
export const PING_GAP_MS = 60 * 60_000;

export interface ReporterRef { reporterId: string | null; reporterDiscordId: string | null }
export type ReporterAsker = { kind: 'player'; steamid: string } | { kind: 'discord'; discordId: string; timedOutUntil: string | null };
export interface ChatPlan { ticketId: number; reportId: number; ref: ReporterRef; reporterDiscordId: string; restricted: boolean; claimedBy: string | null }
export type Checked<T> = { ok: true; plan: T } | { ok: false; status: number; error: string };

const fail = (status: number, error: string) => ({ ok: false as const, status, error });

/** The Discord id a reporter is reached on: their own, or their player's. */
export function reporterDiscordIdOf(db: DB, ref: ReporterRef): string | null {
  if (ref.reporterDiscordId !== null) return ref.reporterDiscordId;
  if (ref.reporterId === null) return null;
  return (db.prepare('SELECT discord_id FROM players WHERE steamid = ?').get(ref.reporterId) as { discord_id: string | null } | undefined)?.discord_id ?? null;
}

/** Whether this stored message is the reporter's own, rather than a
 *  moderator's reply in the same thread. By player for a player (the
 *  adoption in phase 3b1 fills author_player_id in), by Discord id for a
 *  Discord-only reporter. */
export function isReporterMessage(
  th: Pick<ThreadRow, 'reporter_id' | 'reporter_discord_id'>, m: Pick<MessageRow, 'author_discord_id' | 'author_player_id'>,
): boolean {
  return (th.reporter_discord_id !== null && m.author_discord_id === th.reporter_discord_id)
    || (th.reporter_id !== null && m.author_player_id === th.reporter_id);
}

/** A reporter's name as staff see it: the player's name, or the snapshot
 *  taken when a Discord-only member filed. */
export function reporterLabel(db: DB, ticketId: number, ref: ReporterRef): string {
  if (ref.reporterId !== null) {
    return (db.prepare('SELECT name FROM players WHERE steamid = ?').get(ref.reporterId) as { name: string } | undefined)?.name ?? 'a reporter';
  }
  const r = db.prepare("SELECT NULLIF(reporter_name, '') AS name FROM ticket_reports WHERE ticket_id = ? AND reporter_discord_id = ? ORDER BY id DESC LIMIT 1")
    .get(ticketId, ref.reporterDiscordId) as { name: string | null } | undefined;
  return r?.name ?? 'a Discord member';
}

interface ReportJoin {
  id: number; ticket_id: number; reporter_id: string | null; reporter_discord_id: string | null;
  status: string; restricted: number; claimed_by: string | null; target_id: string | null; target_discord_id: string | null;
}

const reportOf = (db: DB, reportId: number) => db.prepare(
  `SELECT r.id, r.ticket_id, r.reporter_id, r.reporter_discord_id, t.status, t.restricted, t.claimed_by, t.target_id, t.target_discord_id
   FROM ticket_reports r JOIN tickets t ON t.id = r.ticket_id WHERE r.id = ?`,
).get(reportId) as ReportJoin | undefined;

/** A merge can leave a report filed by what is now the accused's own
 *  account. That person never gets a chat about their own case. */
const reporterIsAccused = (r: ReportJoin) =>
  (r.reporter_id !== null && r.reporter_id === r.target_id) || (r.reporter_discord_id !== null && r.reporter_discord_id === r.target_discord_id);

function planOf(db: DB, r: ReportJoin): Checked<ChatPlan> {
  const ref = { reporterId: r.reporter_id, reporterDiscordId: r.reporter_discord_id };
  const d = reporterDiscordIdOf(db, ref);
  if (d === null) return fail(400, CHAT_NO_DISCORD);
  return { ok: true, plan: { ticketId: r.ticket_id, reportId: r.id, ref, reporterDiscordId: d, restricted: r.restricted === 1, claimedBy: r.claimed_by } };
}

/**
 * May this person open a chat about this report? Only its own reporter, only
 * while its ticket is open, and only in good standing. Not yours, no such
 * report and closed are the same answer: a report id must not be a probe.
 */
export function checkReporterChat(db: DB, reportId: number, asker: ReporterAsker, now = new Date()): Checked<ChatPlan> {
  const r = reportOf(db, reportId);
  const mine = !!r && (asker.kind === 'player' ? r.reporter_id === asker.steamid : r.reporter_discord_id === asker.discordId);
  if (!r || !mine || r.status !== 'open' || reporterIsAccused(r)) return fail(404, CHAT_CLOSED);
  const blocked = asker.kind === 'player'
    ? !inGoodStanding(db, asker.steamid, now)
    : discordReporterBlocked(db, asker.discordId, asker.timedOutUntil, now);
  if (blocked) return fail(403, CHAT_REFUSED);
  const p = planOf(db, r);
  return p.ok ? p : fail(p.status, p.error);
}

/** Staff, visible ticket, open. The shared first half of every staff action
 *  on a chat. Missing and invisible are the same 404. */
export function checkChatStaff(db: DB, ticketId: number, staff: string): Checked<TicketRow> {
  const t = getTicketRow(db, ticketId);
  if (!t || !canSeeTicket(db, t, staff)) return fail(404, 'no such ticket');
  if (t.status !== 'open') return fail(409, 'reopen the ticket first');
  return { ok: true, plan: t };
}

/** Contact reporter: a member of staff opens the chat for a report on a
 *  ticket they can see. */
export function checkContactReporter(db: DB, ticketId: number, reportId: number, staff: string): Checked<ChatPlan> {
  const t = checkChatStaff(db, ticketId, staff);
  if (!t.ok) return t;
  const r = reportOf(db, reportId);
  if (!r || r.ticket_id !== ticketId) return fail(404, 'no such report on this ticket');
  if (reporterIsAccused(r)) return fail(400, 'that report was filed by the person this ticket is about');
  const p = planOf(db, r);
  if (!p.ok) return fail(400, 'this reporter has no Discord account linked, so there is no way to reach them there');
  return p;
}

/** The newest chat for this reporter on this ticket that the bot still
 *  stands behind. A fold can leave two; the newest is the one used. */
export function reporterThreadFor(db: DB, ticketId: number, ref: ReporterRef): ThreadRow | undefined {
  return db.prepare(
    `SELECT * FROM ticket_threads WHERE ticket_id = ? AND kind = 'reporter' AND state != 'deleted'
       AND reporter_id IS ? AND reporter_discord_id IS ? ORDER BY id DESC LIMIT 1`,
  ).get(ticketId, ref.reporterId, ref.reporterDiscordId) as ThreadRow | undefined;
}

export function reporterThreadsOf(db: DB, ticketId: number, state?: 'open' | 'ended'): ThreadRow[] {
  return (state === undefined
    ? db.prepare("SELECT * FROM ticket_threads WHERE ticket_id = ? AND kind = 'reporter' AND state != 'deleted' ORDER BY id").all(ticketId)
    : db.prepare("SELECT * FROM ticket_threads WHERE ticket_id = ? AND kind = 'reporter' AND state = ? ORDER BY id").all(ticketId, state)) as ThreadRow[];
}

/**
 * Who may be in a reporter thread: the reporter, and any linked, active
 * member of staff who can see the ticket (for a restricted ticket, the access
 * list). Never the accused, and never a reporter who has since become the
 * accused. The 2b handoff asked for this apart from privateThreadAudience.
 *
 * Who MAY be there, not who is: nobody is added from this list. The reporter
 * and the claimer are added when a chat opens, and staff by Join. The
 * ejection sweep takes out anyone in the thread who is not on it.
 */
export function reporterThreadAudience(db: DB, th: ThreadRow): string[] {
  const t = getTicketRow(db, th.ticket_id);
  if (!t) return [];
  const out = new Set<string>();
  const accused = (th.reporter_id !== null && th.reporter_id === t.target_id)
    || (th.reporter_discord_id !== null && th.reporter_discord_id === t.target_discord_id);
  const reporter = reporterDiscordIdOf(db, { reporterId: th.reporter_id, reporterDiscordId: th.reporter_discord_id });
  if (reporter !== null && !accused) out.add(reporter);
  const staff = db.prepare(
    `SELECT p.discord_id FROM players p
     WHERE p.status = 'active' AND (p.is_admin = 1 OR p.is_mod = 1) AND p.discord_id IS NOT NULL
       AND p.steamid IS NOT @target
       AND (@restricted = 0 OR EXISTS (SELECT 1 FROM ticket_access a WHERE a.ticket_id = @ticket AND a.steamid = p.steamid))`,
  ).all({ target: t.target_id, restricted: t.restricted, ticket: t.id }) as { discord_id: string }[];
  for (const s of staff) out.add(s.discord_id);
  return [...out];
}

/** Ask for staff to be told about this chat. A second ask while one waits
 *  keeps the first one's time. */
export function requestPing(db: DB, threadId: string, now = new Date()): void {
  db.prepare(
    `INSERT INTO reporter_chat_pings (thread_id, wanted_at) VALUES (?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET wanted_at = COALESCE(reporter_chat_pings.wanted_at, excluded.wanted_at)`,
  ).run(threadId, now.toISOString());
}

/** The chats on this ticket whose ping is owed and allowed now, charged
 *  before anything is sent: a ping Discord refuses is not tried again. */
export function takeDuePings(db: DB, ticketId: number, now = new Date()): string[] {
  const cutoff = new Date(now.getTime() - PING_GAP_MS).toISOString();
  const due = (db.prepare(
    `SELECT p.thread_id FROM reporter_chat_pings p JOIN ticket_threads th ON th.thread_id = p.thread_id
     WHERE th.ticket_id = ? AND th.kind = 'reporter' AND p.wanted_at IS NOT NULL
       AND (p.last_ping_at IS NULL OR p.last_ping_at <= ?)
     ORDER BY th.id`,
  ).all(ticketId, cutoff) as { thread_id: string }[]).map((r) => r.thread_id);
  const mark = db.prepare('UPDATE reporter_chat_pings SET last_ping_at = ?, wanted_at = NULL WHERE thread_id = ?');
  for (const id of due) mark.run(now.toISOString(), id);
  return due;
}

/** One close DM owed to each reporter reachable on Discord, never to a
 *  reporter who is the accused. Runs inside closeTicket's transaction. */
export function queueCloseNotices(db: DB, ticketId: number, now = new Date()): number {
  return db.prepare(
    `INSERT INTO ticket_notices (ticket_id, discord_id, kind, created_at)
     SELECT DISTINCT @ticket, d, 'closed', @now FROM (
       SELECT COALESCE(r.reporter_discord_id, p.discord_id) AS d
       FROM ticket_reports r JOIN tickets t ON t.id = r.ticket_id LEFT JOIN players p ON p.steamid = r.reporter_id
       WHERE r.ticket_id = @ticket
         AND NOT ((r.reporter_id IS NOT NULL AND r.reporter_id = t.target_id)
               OR (r.reporter_discord_id IS NOT NULL AND r.reporter_discord_id = t.target_discord_id))
     ) WHERE d IS NOT NULL`,
  ).run({ ticket: ticketId, now: now.toISOString() }).changes;
}

/** The notices owed on this ticket, charged as sent. */
export function takeNotices(db: DB, ticketId: number, now = new Date()): { id: number; discord_id: string }[] {
  const rows = db.prepare('SELECT id, discord_id FROM ticket_notices WHERE ticket_id = ? AND sent_at IS NULL ORDER BY id').all(ticketId) as { id: number; discord_id: string }[];
  const mark = db.prepare('UPDATE ticket_notices SET sent_at = ? WHERE id = ?');
  for (const r of rows) mark.run(now.toISOString(), r.id);
  return rows;
}

export interface OpenReport { reportId: number; targetName: string; category: string }

/** The presser's open reports, newest first, for My reports. Never one
 *  about themselves (a merge can make one). */
export function openReportsOf(db: DB, asker: ReporterAsker, limit = 5): OpenReport[] {
  const mine = asker.kind === 'player'
    ? 'r.reporter_id = @who AND t.target_id IS NOT r.reporter_id'
    : 'r.reporter_discord_id = @who AND t.target_discord_id IS NOT r.reporter_discord_id';
  return db.prepare(
    `SELECT r.id AS reportId, COALESCE(p.name, NULLIF(t.target_name, ''), 'someone') AS targetName, r.category
     FROM ticket_reports r JOIN tickets t ON t.id = r.ticket_id LEFT JOIN players p ON p.steamid = t.target_id
     WHERE t.status = 'open' AND ${mine}
     ORDER BY r.id DESC LIMIT @limit`,
  ).all({ who: asker.kind === 'player' ? asker.steamid : asker.discordId, limit }) as OpenReport[];
}
```

(In `openReportsOf` the `IS NOT` is safe: `@who` is never NULL, so `r.reporter_id` in that branch is never NULL either.)

- [ ] **Step 7: `closeTicket` takes the tick** (`src/tickets/actions.ts`)

Import `queueCloseNotices` from `'./reporterChat.js'`, and:

```ts
/**
 * Close with an outcome and an internal note. `tellReporters` (the site's
 * tick, on by default, and the Discord form's select) queues one neutral DM
 * per reporter, sent by the bot once the ticket's chats have ended.
 */
export function closeTicket(db: DB, id: number, by: string, outcome: unknown, note: unknown, tellReporters = true): ActionResult {
  const t = visible(db, id, by);
  if (!t) return fail(404, 'no such ticket');
  if (typeof outcome !== 'string' || !(TICKET_OUTCOMES as readonly string[]).includes(outcome)) return fail(400, 'pick an outcome');
  if (t.status !== 'open') return fail(409, 'the ticket is already closed');
  const text = typeof note === 'string' ? note.trim().slice(0, 1000) : '';
  const now = new Date();
  db.transaction(() => {
    db.prepare("UPDATE tickets SET status = 'closed', outcome = ?, outcome_note = ?, closed_at = ?, closed_by = ? WHERE id = ?")
      .run(outcome, text, now.toISOString(), by, id);
    addTicketEvent(db, id, by, 'closed', { outcome, note: text, told: tellReporters }, now);
    if (tellReporters) queueCloseNotices(db, id, now);
  })();
  return told(id, OK);
}
```

(`reporterChat.ts` imports `filing.ts` and `store.ts`; neither imports `actions.ts`, so there is no cycle.)

- [ ] **Step 8: Run the new file, then the full suite and typecheck**

Run: `npx vitest run tests/reporterChat.test.ts`, `npx vitest run`, `npm run typecheck`
Expected: all pass. An existing test that asserted the `closed` event's exact `detail` gains `told: true`; update that one expectation.

- [ ] **Step 9: Commit**

```bash
git add src tests
git commit -m "Add the reporter chat rules, pings and close notices"
```

---

### Task 2: `ReporterChats`: open, contact, join, end

**Files:**
- Create: `src/discord/reporterChats.ts`
- Test: `tests/reporterChats.test.ts` (create)

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces:

```ts
export const CHAT_OPENING: string; // the spec's opening message
export const CHAT_ENDED_BY_STAFF: string;
export const CHAT_ENDED_ON_CLOSE: string;
export type ChatResult = { ok: true; url: string; created: boolean; reopened: boolean } | { ok: false; status: number; error: string };
export interface ReporterChatsDeps {
  db: DB; transport: BotTransport; publicUrl: string; guildId: string;
  isMember?: (discordId: string) => boolean | null;
  serialise?: (fn: () => Promise<void>) => Promise<void>;
  now?: () => Date;
}
export class ReporterChats {
  openForReporter(reportId: number, asker: ReporterAsker): Promise<ChatResult>;
  contact(ticketId: number, reportId: number, staff: string): Promise<ChatResult>;
  join(ticketId: number, staff: string): Promise<ChatResult>;
  end(ticketId: number, threadRowId: number, staff: string): Promise<{ ok: true } | { ok: false; status: number; error: string }>;
}
export function endReporterThread(d: { db: DB; transport: BotTransport }, th: ThreadRow, farewell: string): Promise<void>;
export function threadUrl(guildId: string, threadId: string): string;
```

Each public method re-runs its Task 1 check inside the chain (the ticket may have closed while the call waited) and turns a Discord failure into `{ ok: false, status: 502, error: 'Discord would not do that just now. Try again in a moment.' }`, logged to the console.

- [ ] **Step 1: Write the failing tests** `tests/reporterChats.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport } from '../src/tickets/filing.js';
import { addAccess, claimTicket, closeTicket } from '../src/tickets/actions.js';
import { reporterThreadsOf, CHAT_CLOSED } from '../src/tickets/reporterChat.js';
import { ReporterChats, CHAT_OPENING, CHAT_ENDED_BY_STAFF } from '../src/discord/reporterChats.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000041${i}`);
const [R1, R2, ACCUSED, , , MOD2, MOD, ADMIN] = IDS;
const D = (id: string) => `95${IDS.indexOf(id)}`;
const LURKER = { kind: 'discord' as const, discordId: '9990', name: 'Lurky', timedOutUntil: null };
let db: DB;
let t: FakeTransport;
let chats: ReporterChats;
let members: Map<string, boolean>;

beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []);
    activatePlayer(db, id);
    linkDiscord(db, id, `95${i}`, `d${i}`);
  });
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid IN (?, ?)').run(MOD, MOD2);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  setSetting(db, 'discord_tickets_channel_id', 'chan1');
  t = new FakeTransport();
  members = new Map();
  chats = new ReporterChats({ db, transport: t, publicUrl: 'https://pug.test', guildId: 'g1', isMember: (id) => members.get(id) ?? null });
});

const file = (by: string | typeof LURKER, target: string, category = 'griefing', text = 'x') =>
  fileReport(db, by, { targetId: target, category, text }, { adminSteamIds: [ADMIN] }) as { ok: true; reportId: number; ticketId: number };
const memberIds = (threadId: string) => [...t.threadsById.get(threadId)!.members].sort();
const kinds = (ticketId: number) => (db.prepare('SELECT kind FROM ticket_events WHERE ticket_id = ? ORDER BY id').all(ticketId) as { kind: string }[]).map((e) => e.kind);
const said = (threadId: string) => t.live().filter((m) => m.channelId === threadId).map((m) => m.payload.content ?? m.payload.embeds[0]?.description ?? '');

describe('a reporter opens a chat', () => {
  it('gets a private thread in the tickets channel with the claimer, one opening line, and a ping asked for', async () => {
    const r = file(R1, ACCUSED);
    claimTicket(db, r.ticketId, MOD, true);
    const res = await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 });
    const [th] = reporterThreadsOf(db, r.ticketId, 'open');
    expect(res).toEqual({ ok: true, url: `https://discord.com/channels/g1/${th.thread_id}`, created: true, reopened: false });
    expect(t.threadsById.get(th.thread_id)).toMatchObject({ parentId: 'chan1', surface: 'private', name: 'Chat with the moderators' });
    expect(th).toMatchObject({ reporter_id: R1, reporter_discord_id: null, surface: 'private', channel_id: 'chan1' });
    expect(memberIds(th.thread_id)).toEqual([D(R1), D(MOD)].sort());
    expect(said(th.thread_id)).toEqual([CHAT_OPENING]);
    expect(kinds(r.ticketId)).toContain('reporter_chat');
    expect(db.prepare('SELECT wanted_at IS NOT NULL AS w FROM reporter_chat_pings WHERE thread_id = ?').get(th.thread_id)).toEqual({ w: 1 });
  });

  it('pressing again links the same thread and changes nothing', async () => {
    const r = file(R1, ACCUSED);
    const first = await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 });
    const again = await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 });
    expect(again).toMatchObject({ ok: true, created: false, reopened: false });
    expect(first.ok && again.ok && first.url === again.url).toBe(true);
    expect(t.threadsIn('chan1')).toHaveLength(1);
    expect(said(reporterThreadsOf(db, r.ticketId)[0].thread_id)).toHaveLength(1);
  });

  it('a Discord-only reporter chats on their own Discord id', async () => {
    const r = file(LURKER, ACCUSED, 'toxicity');
    const res = await chats.openForReporter(r.reportId, { kind: 'discord', discordId: '9990', timedOutUntil: null });
    expect(res).toMatchObject({ ok: true, created: true });
    const [th] = reporterThreadsOf(db, r.ticketId);
    expect(th).toMatchObject({ reporter_id: null, reporter_discord_id: '9990' });
    expect(memberIds(th.thread_id)).toEqual(['9990']);
  });

  it('refuses somebody else\'s report without making anything', async () => {
    const r = file(R1, ACCUSED);
    expect(await chats.openForReporter(r.reportId, { kind: 'player', steamid: R2 })).toEqual({ ok: false, status: 404, error: CHAT_CLOSED });
    expect(t.threadsById.size).toBe(0);
  });

  it('someone the member list says is not in the server: nothing is made', async () => {
    const r = file(R1, ACCUSED);
    members.set(D(R1), false);
    const res = await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 });
    expect(res).toMatchObject({ ok: false, status: 409 });
    expect(res.ok ? '' : res.error).toMatch(/not in the Discord server/);
    expect(t.threadsById.size).toBe(0);
  });

  it('an add Discord refuses deletes the thread it had just made', async () => {
    const r = file(R1, ACCUSED);
    t.notInGuild.add(D(R1));
    const res = await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 });
    expect(res).toMatchObject({ ok: false, status: 409 });
    expect(t.threadsIn('chan1')).toEqual([]);
    expect(reporterThreadsOf(db, r.ticketId)).toEqual([]);
  });

  it('a thread deleted by hand is made again', async () => {
    const r = file(R1, ACCUSED);
    await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 });
    const [first] = reporterThreadsOf(db, r.ticketId);
    await t.threads.deleteThread(first.thread_id);
    const res = await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 });
    expect(res).toMatchObject({ ok: true, created: true });
    expect(reporterThreadsOf(db, r.ticketId).map((th) => th.id)).not.toContain(first.id);
  });

  it('says so when no tickets channel is set', async () => {
    setSetting(db, 'discord_tickets_channel_id', '');
    const r = file(R1, ACCUSED);
    expect(await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 })).toMatchObject({ ok: false, status: 503 });
  });
});

describe('staff', () => {
  it('Contact reporter opens it with the presser in it, and asks for no ping', async () => {
    const r = file(R1, ACCUSED);
    const res = await chats.contact(r.ticketId, r.reportId, MOD2);
    expect(res).toMatchObject({ ok: true, created: true });
    const [th] = reporterThreadsOf(db, r.ticketId);
    expect(memberIds(th.thread_id)).toEqual([D(R1), D(MOD2)].sort());
    expect(db.prepare('SELECT COUNT(*) AS n FROM reporter_chat_pings').get()).toEqual({ n: 0 });
  });

  it('Join puts the presser in every open chat; someone off a restricted list gets a 404', async () => {
    const a = file(R1, ACCUSED);
    file(R2, ACCUSED, 'afk');
    const reports = db.prepare('SELECT id FROM ticket_reports WHERE ticket_id = ? ORDER BY id').all(a.ticketId) as { id: number }[];
    await chats.openForReporter(reports[0].id, { kind: 'player', steamid: R1 });
    await chats.openForReporter(reports[1].id, { kind: 'player', steamid: R2 });
    expect(await chats.join(a.ticketId, MOD2)).toMatchObject({ ok: true });
    for (const th of reporterThreadsOf(db, a.ticketId)) expect(memberIds(th.thread_id)).toContain(D(MOD2));
    const secret = file(R1, ACCUSED, 'unsafe', 'threats');
    await chats.openForReporter(secret.reportId, { kind: 'player', steamid: R1 });
    expect(await chats.join(secret.ticketId, MOD2)).toMatchObject({ ok: false, status: 404 });
    addAccess(db, secret.ticketId, ADMIN, MOD2);
    expect(await chats.join(secret.ticketId, MOD2)).toMatchObject({ ok: true });
  });

  it('End: a farewell, the reporter taken out, locked and archived; the reporter can open it again', async () => {
    const r = file(R1, ACCUSED);
    await chats.contact(r.ticketId, r.reportId, MOD);
    const [th] = reporterThreadsOf(db, r.ticketId);
    expect(await chats.end(r.ticketId, th.id, MOD)).toEqual({ ok: true });
    expect(t.threadsById.get(th.thread_id)).toMatchObject({ locked: true, archived: true, deleted: false });
    expect(memberIds(th.thread_id)).toEqual([D(MOD)]);
    expect(said(th.thread_id)).toContain(CHAT_ENDED_BY_STAFF);
    expect(reporterThreadsOf(db, r.ticketId, 'ended').map((x) => x.id)).toEqual([th.id]);
    expect(await chats.end(r.ticketId, th.id, MOD)).toMatchObject({ ok: false, status: 409 });

    const back = await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 });
    expect(back).toMatchObject({ ok: true, created: false, reopened: true });
    expect(t.threadsById.get(th.thread_id)).toMatchObject({ locked: false, archived: false });
    expect(memberIds(th.thread_id)).toEqual([D(R1), D(MOD)].sort());
    expect(reporterThreadsOf(db, r.ticketId, 'open').map((x) => x.id)).toEqual([th.id]);
  });

  it('nothing on a closed ticket', async () => {
    const r = file(R1, ACCUSED);
    closeTicket(db, r.ticketId, MOD, 'no_action', '', false);
    expect(await chats.contact(r.ticketId, r.reportId, MOD)).toMatchObject({ ok: false, status: 409 });
    expect(await chats.join(r.ticketId, MOD)).toMatchObject({ ok: false, status: 409 });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/reporterChats.test.ts`
Expected: FAIL (the module does not exist).

- [ ] **Step 3: `src/discord/reporterChats.ts`**

```ts
import type { DB } from '../db.js';
import { getSetting } from '../settings.js';
import { addTicketEvent } from '../tickets/store.js';
import { publishTicketSignal } from '../tickets/signals.js';
import {
  checkChatStaff, checkContactReporter, checkReporterChat, reporterDiscordIdOf, reporterThreadAudience,
  reporterThreadFor, reporterThreadsOf, requestPing, type ChatPlan, type ReporterAsker,
} from '../tickets/reporterChat.js';
import { insertThread, setThreadLocked, setThreadState, type ThreadRow } from '../tickets/threads.js';
import type { BotTransport } from './transport.js';

/** The spec's opening line, word for word. */
export const CHAT_OPENING = 'This is a private chat with the moderators about your report. A moderator will reply here when they can.';
export const CHAT_ENDED_BY_STAFF = 'The moderators have ended this chat. While your report is open you can start it again from My reports on the report message.';
export const CHAT_ENDED_ON_CLOSE = 'Your report is now closed, so this chat has ended. Thank you for telling us.';
const NOT_IN_SERVER_SELF = 'You are not in the Discord server, so there is nowhere to chat. Join it, then try again.';
const NOT_IN_SERVER_STAFF = 'The reporter is not in the Discord server, so there is no way to chat with them there.';
const UNCONFIGURED = 'Chats with the moderators are not set up yet: an admin has to set the tickets channel in Settings.';
const DISCORD_FAILED = 'Discord would not do that just now. Try again in a moment.';

export type ChatResult = { ok: true; url: string; created: boolean; reopened: boolean } | { ok: false; status: number; error: string };
type Done = { ok: true } | { ok: false; status: number; error: string };

export interface ReporterChatsDeps {
  db: DB;
  transport: BotTransport;
  publicUrl: string;
  guildId: string;
  /** GuildMembership.isMember: false for someone known not to be in the
   *  server, null while the member list is unknown (then the add decides). */
  isMember?: (discordId: string) => boolean | null;
  /** TicketSync.serialise: every thread operation here is on the
   *  reconciler's chain, which also unarchives, acts and archives threads.
   *  Left out (tests), the work simply runs. */
  serialise?: (fn: () => Promise<void>) => Promise<void>;
  now?: () => Date;
}

export const threadUrl = (guildId: string, threadId: string) => `https://discord.com/channels/${guildId}/${threadId}`;

const fail = (status: number, error: string) => ({ ok: false as const, status, error });

/** Unarchive first when Discord archived a quiet thread on its own: an
 *  archived thread refuses every write there is. */
async function writable(transport: BotTransport, threadId: string): Promise<void> {
  if (await transport.threads.isArchived(threadId)) await transport.threads.setArchived(threadId, false);
}

/**
 * End one reporter chat: say why, take the reporter out, lock, archive.
 * Marked ended only after Discord did it. Shared by staff's End (through
 * ReporterChats, on the reconciler's chain) and by the reconciler itself
 * when a ticket closes, which is why it is a free function: the reconciler
 * must not go through serialise from inside its own chain.
 */
export async function endReporterThread(d: { db: DB; transport: BotTransport }, th: ThreadRow, farewell: string): Promise<void> {
  const { db, transport } = d;
  if (await transport.threads.exists(th.thread_id)) {
    await writable(transport, th.thread_id);
    await transport.send(th.thread_id, { embeds: [{ description: farewell }], components: [], mentionUserIds: [] });
    const reporter = reporterDiscordIdOf(db, { reporterId: th.reporter_id, reporterDiscordId: th.reporter_discord_id });
    if (reporter !== null) {
      try {
        await transport.threads.removeMember(th.thread_id, reporter);
      } catch (err) {
        // Ordinary: they have left the server. The thread is locked below either way.
        console.warn('[discord] could not take the reporter out of an ended chat:', err instanceof Error ? err.message : err);
      }
    }
    await transport.threads.setLocked(th.thread_id, true);
    await transport.threads.setArchived(th.thread_id, true);
  }
  setThreadState(db, th.id, 'ended');
  setThreadLocked(db, th.id, true);
}

/**
 * Reporter chat, in Discord: a private thread under the tickets channel per
 * (ticket, reporter), registered in ticket_threads with kind 'reporter' so
 * the mirror copies it onto the site.
 *
 * Every public method runs on the reconciler's chain and never throws: a
 * Discord failure is an answer (502) for the button or the route to show.
 */
export class ReporterChats {
  constructor(private deps: ReporterChatsDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** On the chain, waited for, with any throw turned into DISCORD_FAILED. */
  private async onChain<T extends { ok: boolean }>(fn: () => Promise<T>): Promise<T | { ok: false; status: number; error: string }> {
    const serialise = this.deps.serialise ?? ((f: () => Promise<void>) => f());
    let out: T | undefined;
    try {
      await serialise(async () => { out = await fn(); });
      return out!;
    } catch (err) {
      console.error('[discord] a reporter chat action failed:', err instanceof Error ? err.message : err);
      return fail(502, DISCORD_FAILED);
    }
  }

  openForReporter(reportId: number, asker: ReporterAsker): Promise<ChatResult> {
    return this.onChain(async () => {
      const c = checkReporterChat(this.deps.db, reportId, asker, this.now());
      if (!c.ok) return fail(c.status, c.error);
      return this.openNow(c.plan, { kind: 'reporter' });
    });
  }

  contact(ticketId: number, reportId: number, staff: string): Promise<ChatResult> {
    return this.onChain(async () => {
      const c = checkContactReporter(this.deps.db, ticketId, reportId, staff);
      if (!c.ok) return fail(c.status, c.error);
      return this.openNow(c.plan, { kind: 'staff', steamid: staff });
    });
  }

  join(ticketId: number, staff: string): Promise<ChatResult> {
    return this.onChain(async (): Promise<ChatResult> => {
      const { db, transport, guildId } = this.deps;
      const c = checkChatStaff(db, ticketId, staff);
      if (!c.ok) return fail(c.status, c.error);
      const me = this.discordIdOf(staff);
      if (me === null) return fail(400, 'link your Discord account first');
      const open = reporterThreadsOf(db, ticketId, 'open');
      if (open.length === 0) return fail(409, 'there is no open reporter chat on this ticket');
      for (const th of open) {
        if (!reporterThreadAudience(db, th).includes(me)) continue;
        await writable(transport, th.thread_id);
        await transport.threads.addMember(th.thread_id, me);
      }
      addTicketEvent(db, ticketId, staff, 'reporter_chat_joined', {}, this.now());
      publishTicketSignal({ kind: 'ticket', ticketId });
      return { ok: true, url: threadUrl(guildId, open[0].thread_id), created: false, reopened: false };
    });
  }

  end(ticketId: number, threadRowId: number, staff: string): Promise<Done> {
    return this.onChain(async (): Promise<Done> => {
      const { db } = this.deps;
      const t = checkChatStaff(db, ticketId, staff);
      // Ending is allowed on a closed ticket too: the reconciler ends those
      // itself, and a moderator asking first is not wrong.
      if (!t.ok && t.status !== 409) return fail(t.status, t.error);
      const th = db.prepare("SELECT * FROM ticket_threads WHERE id = ? AND ticket_id = ? AND kind = 'reporter'").get(threadRowId, ticketId) as ThreadRow | undefined;
      if (!th || th.state === 'deleted') return fail(404, 'no such chat');
      if (th.state !== 'open') return fail(409, 'that chat has already ended');
      await endReporterThread(this.deps, th, CHAT_ENDED_BY_STAFF);
      addTicketEvent(db, ticketId, staff, 'reporter_chat_ended', { threadRowId }, this.now());
      publishTicketSignal({ kind: 'ticket', ticketId });
      return { ok: true };
    });
  }

  private discordIdOf(steamid: string): string | null {
    return (this.deps.db.prepare('SELECT discord_id FROM players WHERE steamid = ?').get(steamid) as { discord_id: string | null } | undefined)?.discord_id ?? null;
  }

  /**
   * The thread for this plan: made, reopened, or as it is. The reporter is
   * added every time (they may have been taken out, or left and come back).
   * A reporter's own press also adds the claimer and asks for staff to be
   * told; a moderator's press adds that moderator and tells nobody.
   */
  private async openNow(plan: ChatPlan, by: { kind: 'reporter' } | { kind: 'staff'; steamid: string }): Promise<ChatResult> {
    const { db, transport, guildId } = this.deps;
    const now = this.now();
    if (this.deps.isMember?.(plan.reporterDiscordId) === false) return fail(409, by.kind === 'reporter' ? NOT_IN_SERVER_SELF : NOT_IN_SERVER_STAFF);
    let th = reporterThreadFor(db, plan.ticketId, plan.ref);
    if (th && !(await transport.threads.exists(th.thread_id))) {
      // Deleted by hand in Discord. Remembered, and made again.
      setThreadState(db, th.id, 'deleted');
      th = undefined;
    }
    let created = false;
    let reopened = false;
    if (!th) {
      const channelId = getSetting(db, 'discord_tickets_channel_id') ?? '';
      if (!channelId) return fail(503, UNCONFIGURED);
      const made = await transport.threads.createPrivateThread(channelId, { name: 'Chat with the moderators' });
      try {
        th = insertThread(db, {
          ticketId: plan.ticketId, kind: 'reporter', surface: 'private', channelId, threadId: made.threadId,
          reporterId: plan.ref.reporterId, reporterDiscordId: plan.ref.reporterDiscordId,
        }, now);
      } catch (err) {
        // The ticket went (a fold) while the thread was being made: nothing
        // may be left standing that no row knows about.
        await transport.threads.deleteThread(made.threadId).catch(() => {});
        throw err;
      }
      created = true;
    } else if (th.state !== 'open' || th.locked === 1) {
      await writable(transport, th.thread_id);
      await transport.threads.setLocked(th.thread_id, false);
      setThreadLocked(db, th.id, false);
      setThreadState(db, th.id, 'open');
      reopened = true;
    } else {
      await writable(transport, th.thread_id);
    }
    try {
      await transport.threads.addMember(th.thread_id, plan.reporterDiscordId);
    } catch {
      // Discord's answer for somebody who is not in the server. A thread made
      // for them just now goes again; an old one stays for the record.
      if (created) {
        await transport.threads.deleteThread(th.thread_id).catch(() => {});
        setThreadState(db, th.id, 'deleted');
      }
      return fail(409, by.kind === 'reporter' ? NOT_IN_SERVER_SELF : NOT_IN_SERVER_STAFF);
    }
    if (created) await transport.send(th.thread_id, { content: CHAT_OPENING, embeds: [], components: [], mentionUserIds: [] });
    const allowed = reporterThreadAudience(db, th);
    const staff = by.kind === 'staff' ? this.discordIdOf(by.steamid) : plan.claimedBy ? this.discordIdOf(plan.claimedBy) : null;
    if (staff !== null && allowed.includes(staff)) {
      try {
        await transport.threads.addMember(th.thread_id, staff);
      } catch (err) {
        console.warn('[discord] could not add a moderator to a reporter chat:', err instanceof Error ? err.message : err);
      }
    }
    addTicketEvent(db, plan.ticketId, by.kind === 'staff' ? by.steamid : null, 'reporter_chat', { by: by.kind, created, reopened }, now);
    if (by.kind === 'reporter' && (created || reopened)) requestPing(db, th.thread_id, now);
    publishTicketSignal({ kind: 'ticket', ticketId: plan.ticketId });
    return { ok: true, url: threadUrl(guildId, th.thread_id), created, reopened };
  }
}
```

- [ ] **Step 4: Run it, the full suite and typecheck**

Run: `npx vitest run tests/reporterChats.test.ts`, `npx vitest run`, `npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/discord/reporterChats.ts tests/reporterChats.test.ts
git commit -m "Open, contact, join and end reporter chats in Discord"
```

---

### Task 3: The reconciler looks after chats

**Files:**
- Modify: `src/discord/ticketSync.ts`, `src/discord/ticketCard.ts`
- Test: `tests/reporterChatSync.test.ts` (create)

**Interfaces:**
- Consumes: `endReporterThread`, `CHAT_ENDED_ON_CLOSE` (Task 2); `reporterThreadAudience`, `reporterThreadsOf`, `takeDuePings`, `takeNotices`, `isReporterMessage`, `requestPing` (Task 1); `privateThreadAudience`, `forumAudience` (existing).
- Produces: in `ticketCard.ts`, `closeDm(): MessagePayload`, `reporterWroteDm(ticketId: number, publicUrl: string): MessagePayload`; in `TicketSync`, `reporterActivity(thread: ThreadRow, m: MessageRow, fresh: boolean): void` (Task 4 wires the mirror to it).

What the reconciler now does, in `reconcileTicket`, in this order, after `notifyAccess`:
1. a closed ticket's open chats are ended (`CHAT_ENDED_ON_CLOSE`), one `reporter_chat_ended` event each with no actor;
2. the close notices are sent, only if the ticket is still closed (a notice charged on a reopened ticket is dropped: "the ticket is now closed" would be false);
3. a restricted, open ticket with a ping due DMs its access list `reporterWroteDm` (no content, no name);
4. (existing) the staff thread. Inside the unlocked-thread block, for a forum post: the ping line (mentioning the claimer if they may read the forum, otherwise everyone who may), then the relay (Task 4), then the card.

And the ejection sweep covers reporter threads: the private-thread query no longer filters on `kind = 'staff'`, and each thread's entitled set is `reporterThreadAudience` for a reporter thread, `privateThreadAudience` for a staff one.

- [ ] **Step 1: Write the failing tests** `tests/reporterChatSync.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport } from '../src/tickets/filing.js';
import { addAccess, claimTicket, closeTicket, reopenTicket } from '../src/tickets/actions.js';
import { publishTicketSignal } from '../src/tickets/signals.js';
import { staffThread } from '../src/tickets/threads.js';
import { reporterThreadsOf, requestPing } from '../src/tickets/reporterChat.js';
import { TicketSync } from '../src/discord/ticketSync.js';
import { ReporterChats, CHAT_ENDED_ON_CLOSE } from '../src/discord/reporterChats.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000042${i}`);
const [R1, R2, ACCUSED, , , MOD2, MOD, ADMIN] = IDS;
const D = (id: string) => `96${IDS.indexOf(id)}`;
let db: DB;
let t: FakeTransport;
let sync: TicketSync;
let chats: ReporterChats;

beforeEach(async () => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []);
    activatePlayer(db, id);
    linkDiscord(db, id, `96${i}`, `d${i}`);
  });
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid IN (?, ?)').run(MOD, MOD2);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  setSetting(db, 'discord_tickets_forum_id', 'forum1');
  setSetting(db, 'discord_tickets_channel_id', 'chan1');
  t = new FakeTransport();
  sync = new TicketSync({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
  chats = new ReporterChats({ db, transport: t, publicUrl: 'https://pug.test', guildId: 'g1', serialise: (fn) => sync.serialise(fn) });
  sync.start();
  await sync.idle();
});
afterEach(() => sync.stop());

const file = (by: string, target: string, category = 'griefing', text = 'x') =>
  fileReport(db, by, { targetId: target, category, text }, { adminSteamIds: [ADMIN] }) as { ok: true; reportId: number; ticketId: number };
const inPost = (ticketId: number) => t.live().filter((m) => m.channelId === staffThread(db, ticketId)!.thread_id);
const pingLines = (ticketId: number) => inPost(ticketId).filter((m) => /opened a chat/.test(m.payload.content ?? ''));

describe('telling staff about a chat', () => {
  it('a normal ticket, unclaimed: one line in the forum post pinging everyone who may read the forum', async () => {
    const r = file(R1, ACCUSED);
    await sync.idle();
    await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 });
    await sync.idle();
    const [line] = pingLines(r.ticketId);
    expect(line.payload.mentionUserIds!.sort()).toEqual([D(MOD2), D(MOD), D(ADMIN)].sort());
    await sync.reconcile();
    expect(pingLines(r.ticketId)).toHaveLength(1);
  });

  it('claimed: only the claimer, and a reopen inside the hour pings nobody', async () => {
    const r = file(R1, ACCUSED);
    claimTicket(db, r.ticketId, MOD, true);
    await sync.idle();
    await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 });
    await sync.idle();
    expect(pingLines(r.ticketId).map((m) => m.payload.mentionUserIds)).toEqual([[D(MOD)]]);
    const [th] = reporterThreadsOf(db, r.ticketId);
    await chats.end(r.ticketId, th.id, MOD);
    await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 });
    await sync.idle();
    expect(pingLines(r.ticketId)).toHaveLength(1);
    // An hour later the waiting ping goes out.
    db.prepare("UPDATE reporter_chat_pings SET last_ping_at = '2000-01-01T00:00:00.000Z'").run();
    await sync.reconcile();
    expect(pingLines(r.ticketId)).toHaveLength(2);
  });

  it('a restricted ticket: its access list is DMed a link and nothing else, and nothing goes in any post', async () => {
    const r = file(R1, ACCUSED, 'unsafe', 'he threatened me');
    addAccess(db, r.ticketId, ADMIN, MOD);
    await sync.idle();
    const before = t.dms.length;
    await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 });
    await sync.idle();
    const pings = t.dms.slice(before);
    expect(pings.map((d) => d.userId).sort()).toEqual([D(MOD), D(ADMIN)].sort());
    for (const d of pings) {
      const said = JSON.stringify(d.payload);
      expect(said).toContain(`The reporter wrote on ticket #${r.ticketId}`);
      expect(said).toContain(`https://pug.test/admin/people/tickets/${r.ticketId}`);
      expect(said).not.toContain('threatened');
      expect(said).not.toContain('player0');
    }
    expect(staffThread(db, r.ticketId)).toBeUndefined();
    const [th] = reporterThreadsOf(db, r.ticketId);
    requestPing(db, th.thread_id);
    await sync.reconcile();
    expect(t.dms.length - before).toBe(2);
  });
});

describe('closing', () => {
  it('ends every chat, then thanks every reporter once', async () => {
    const r = file(R1, ACCUSED);
    file(R2, ACCUSED, 'afk');
    await sync.idle();
    await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 });
    await sync.idle();
    const [th] = reporterThreadsOf(db, r.ticketId);
    const dmsBefore = t.dms.length;
    closeTicket(db, r.ticketId, MOD, 'warned', '', true);
    await sync.idle();
    expect(reporterThreadsOf(db, r.ticketId, 'ended').map((x) => x.id)).toEqual([th.id]);
    expect(t.threadsById.get(th.thread_id)).toMatchObject({ locked: true, archived: true });
    expect([...t.threadsById.get(th.thread_id)!.members]).not.toContain(D(R1));
    expect(t.live().some((m) => m.channelId === th.thread_id && m.payload.embeds[0]?.description === CHAT_ENDED_ON_CLOSE)).toBe(true);
    const thanks = t.dms.slice(dmsBefore);
    expect(thanks.map((d) => d.userId).sort()).toEqual([D(R1), D(R2)].sort());
    for (const d of thanks) expect(d.payload.content).toBe('Thank you for your report. The ticket is now closed.');
    await sync.reconcile();
    expect(t.dms.length - dmsBefore).toBe(2);
  });

  it('without the tick nobody is told; reopened before the bot got to it, nobody is told', async () => {
    const a = file(R1, ACCUSED);
    await sync.idle();
    const before = t.dms.length;
    closeTicket(db, a.ticketId, MOD, 'warned', '', false);
    await sync.idle();
    expect(t.dms.length).toBe(before);
    sync.stop();
    reopenTicket(db, a.ticketId, MOD);
    closeTicket(db, a.ticketId, MOD, 'warned', '', true);
    reopenTicket(db, a.ticketId, MOD);
    sync = new TicketSync({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
    sync.start();
    await sync.idle();
    expect(t.dms.length).toBe(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_notices WHERE sent_at IS NULL').get()).toEqual({ n: 0 });
  });
});

describe('who stays in a chat', () => {
  it('a moderator demoted after joining is taken out; the reporter stays', async () => {
    const r = file(R1, ACCUSED);
    await sync.idle();
    await chats.contact(r.ticketId, r.reportId, MOD2);
    const [th] = reporterThreadsOf(db, r.ticketId);
    db.prepare('UPDATE players SET is_mod = 0 WHERE steamid = ?').run(MOD2);
    publishTicketSignal({ kind: 'staff' });
    await sync.idle();
    expect([...t.threadsById.get(th.thread_id)!.members]).toEqual([D(R1)]);
  });

  it('a stranger added by hand goes, even from an ended chat, which stays locked', async () => {
    const r = file(R1, ACCUSED);
    await sync.idle();
    await chats.contact(r.ticketId, r.reportId, MOD);
    const [th] = reporterThreadsOf(db, r.ticketId);
    await chats.end(r.ticketId, th.id, MOD);
    t.threadsById.get(th.thread_id)!.members.add('555');
    await sync.reconcile();
    expect([...t.threadsById.get(th.thread_id)!.members]).not.toContain('555');
    expect(t.threadsById.get(th.thread_id)).toMatchObject({ locked: true, archived: true });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/reporterChatSync.test.ts`
Expected: FAIL (no ping line, no close DM, the chat is not ended).

- [ ] **Step 3: `src/discord/ticketCard.ts`**

```ts
/** The neutral DM a reporter gets when their ticket closes, if the closer
 *  left the tick on. It says nothing about the outcome. */
export function closeDm(): MessagePayload {
  return { content: 'Thank you for your report. The ticket is now closed.', embeds: [], components: [], mentionUserIds: [] };
}

/** To the access list of a restricted ticket whose reporter wrote in their
 *  chat. No words of theirs and no name: the link does the telling, behind
 *  the site's access check. */
export function reporterWroteDm(ticketId: number, publicUrl: string): MessagePayload {
  return {
    content: `The reporter wrote on ticket #${ticketId}. Read it on the site.`,
    embeds: [],
    components: [[{ kind: 'link', url: `${publicUrl}/admin/people/tickets/${ticketId}`, label: `Open ticket #${ticketId}` }]],
    mentionUserIds: [],
  };
}
```

- [ ] **Step 4: `src/discord/ticketSync.ts`**

Imports to add: `import { addTicketEvent } from '../tickets/store.js';` (merge with the existing `getTicketRow, type TicketRow` import), `import type { MessageRow } from '../tickets/messages.js';`, `import { isReporterMessage, reporterThreadAudience, reporterThreadsOf, requestPing, takeDuePings, takeNotices } from '../tickets/reporterChat.js';`, `import { CHAT_ENDED_ON_CLOSE, endReporterThread } from './reporterChats.js';`, and `closeDm, reporterWroteDm` from `'./ticketCard.js'`.

`PRIVATE_THREADS` becomes:

```ts
/** Every private thread that still stands, staff (from before restricted
 *  tickets went site-only) and reporter alike, for the ejection sweep. */
const PRIVATE_THREADS = `SELECT th.* FROM ticket_threads th JOIN tickets t ON t.id = th.ticket_id
   WHERE th.surface = 'private' AND th.state != 'deleted'`;
```

In `ejectOutsiders`, replace the `entitled` line with:

```ts
        const entitled = new Set(th.kind === 'reporter'
          ? reporterThreadAudience(db, th)
          : privateThreadAudience(db, th.ticket_id).map((m) => m.discord_id));
```

In `reconcile`, the ids query becomes:

```ts
    const ids = (this.deps.db.prepare(
      `SELECT id FROM tickets WHERE status = 'open'
       UNION
       SELECT th.ticket_id FROM ticket_threads th JOIN tickets t ON t.id = th.ticket_id
        WHERE th.kind = 'staff' AND th.state = 'open' AND th.locked = 0 AND t.status = 'closed'
       UNION
       SELECT th.ticket_id FROM ticket_threads th JOIN tickets t ON t.id = th.ticket_id
        WHERE th.kind = 'reporter' AND th.state = 'open' AND t.status = 'closed'
       UNION
       SELECT ticket_id FROM ticket_notices WHERE sent_at IS NULL
       ORDER BY 1`,
    ).all() as { id: number }[]).map((r) => r.id);
```

In `reconcileTicket`, directly after `await this.notifyAccess(t);`:

```ts
    // A closed ticket's chats end first, then its reporters are thanked: the
    // thank-you must not arrive while the chat still looks open.
    if (t.status === 'closed') await this.endReporterChats(t);
    await this.sendNotices(t);
    await this.pingByDm(t);
```

and inside `if (thread.locked === 0) { ... }`, after `await this.announceReports(t, thread);`:

```ts
      await this.pingInPost(t, thread);
```

Add the methods (beside `notifyAccess`):

```ts
  /** Every chat still open on a closed ticket, ended. One Discord refusal
   *  throws out of the ticket's pass, and the timer tries again: the ids a
   *  pass visits include closed tickets with a chat still open. */
  private async endReporterChats(t: TicketRow): Promise<void> {
    const { db } = this.deps;
    for (const th of reporterThreadsOf(db, t.id, 'open')) {
      await endReporterThread(this.deps, th, CHAT_ENDED_ON_CLOSE);
      addTicketEvent(db, t.id, null, 'reporter_chat_ended', { threadRowId: th.id, why: 'closed' });
    }
  }

  /** The close DMs, charged before they are sent. A ticket reopened before
   *  this ran is not "now closed": its notices are dropped unsent. */
  private async sendNotices(t: TicketRow): Promise<void> {
    const due = takeNotices(this.deps.db, t.id);
    if (t.status !== 'closed') return;
    for (const n of due) {
      try {
        await this.deps.transport.dm(n.discord_id, closeDm());
      } catch { /* refused: dropped, like every other DM this bot sends */ }
    }
  }

  /** A restricted ticket has no post to ping in: its access list (the same
   *  people privateThreadAudience lets into anything about it) is DMed. */
  private async pingByDm(t: TicketRow): Promise<void> {
    if (t.restricted !== 1 || t.status !== 'open') return;
    const { db, transport, publicUrl } = this.deps;
    if (takeDuePings(db, t.id).length === 0) return;
    for (const m of privateThreadAudience(db, t.id)) {
      try {
        await transport.dm(m.discord_id, reporterWroteDm(t.id, publicUrl));
      } catch { /* refused: dropped */ }
    }
  }

  /** "The reporter opened a chat", on the forum post: the claimer if they
   *  can read the forum, otherwise everyone who can. */
  private async pingInPost(t: TicketRow, thread: ThreadRow): Promise<void> {
    if (thread.surface !== 'forum' || t.restricted === 1 || t.status !== 'open') return;
    const { db, transport } = this.deps;
    if (takeDuePings(db, t.id).length === 0) return;
    const readers = forumAudience(db);
    const claimer = t.claimed_by
      ? (db.prepare('SELECT discord_id FROM players WHERE steamid = ?').get(t.claimed_by) as { discord_id: string | null } | undefined)?.discord_id ?? null
      : null;
    const who = claimer !== null && readers.includes(claimer) ? [claimer] : readers;
    await transport.send(thread.thread_id, {
      content: `${who.map((id) => `<@${id}>`).join(' ')} The reporter opened a chat with the moderators. Press Join reporter chat under the card to go in.`.trim(),
      embeds: [], components: [], mentionUserIds: who,
    });
  }

  /**
   * Something new in a reporter thread, told by the mirror (Task 4 wires it).
   * Called on the MIRROR's chain, so it writes at most one row and queues:
   * it must never wait on this chain, which waits on the mirror's.
   *
   * A fresh message from the reporter on a restricted ticket asks for the
   * access list to be told (capped). On any ticket the ticket's pass is
   * queued once, which is what copies the message onto the forum post.
   */
  reporterActivity(thread: ThreadRow, m: MessageRow, fresh: boolean): void {
    const { db } = this.deps;
    const t = getTicketRow(db, thread.ticket_id);
    if (!t) return;
    if (fresh && t.restricted === 1 && t.status === 'open' && isReporterMessage(thread, m)) requestPing(db, thread.thread_id);
    this.poke(t.id);
  }

  /** Tickets with a pass already queued by reporterActivity: a backfill hands
   *  over a thread's history message by message, and one pass covers all. */
  private poked = new Set<number>();

  private poke(id: number): void {
    if (this.poked.has(id)) return;
    this.poked.add(id);
    this.enqueue(async () => {
      this.poked.delete(id);
      await this.one(id);
    });
  }
```

(`one` catches everything, so `poke`'s queued work never rejects.)

Two details to keep straight while editing:
- `pingByDm` runs before the `if (!thread) { this.announceInFeed(...); return; }` line, because a restricted ticket has no thread (3b1) and returns there.
- `pingInPost` sits after `makeWritable`, inside the unlocked block, because it writes into the post.

- [ ] **Step 5: Run it, the full suite and typecheck**

Run: `npx vitest run tests/reporterChatSync.test.ts`, `npx vitest run`, `npm run typecheck`
Expected: all pass. `tests/ticketSyncRestricted.test.ts`'s legacy-thread tests keep passing: a staff private thread's entitled set is still `privateThreadAudience`.

- [ ] **Step 6: Commit**

```bash
git add src/discord/ticketSync.ts src/discord/ticketCard.ts tests/reporterChatSync.test.ts
git commit -m "End reporter chats on close, thank the reporters, and tell staff about a chat"
```

---

### Task 4: The reporter's words on the staff post, and taking them back

**Files:**
- Create: `src/discord/reporterRelay.ts`
- Modify: `src/discord/ticketSync.ts`, `src/discord/ticketMirror.ts`, `src/tickets/removal.ts`
- Test: `tests/reporterRelay.test.ts` (create)

**Interfaces:**
- Consumes: `TicketSync.reporterActivity` (Task 3), `isReporterMessage` (Task 1).
- Produces:
  - `syncRelay(d: { db: DB; transport: BotTransport; publicUrl: string }, t: TicketRow, post: ThreadRow): Promise<void>` and `relayPayload(...)` in `reporterRelay.ts`;
  - `TicketMirrorDeps.onReporterActivity?: (thread: ThreadRow, m: MessageRow, fresh: boolean) => void`;
  - `removeMessages(db: DB, dir: string, ticketId: number, messageIds: number[], by: string, reason: unknown, now?: Date): { ok: true; removed: number; files: number } | { ok: false; status: number; error: string }` in `removal.ts`.

How the pieces meet (the 2b handoff's "single hook slot"): the transport has one `MessageHooks`, and the mirror holds it. The mirror stores a reporter-thread message exactly as before, then calls `onReporterActivity`, which is `TicketSync.reporterActivity`: it queues that ticket's pass. The pass calls `syncRelay`, which compares every reporter message with its `relay_messages` row and sends or edits the copy. Deletion of a copy is owed whenever its original is removed or deleted and the row still stands, and the mirror's removal sweep (already on the reconciler's chain through `serialise`) pays it, then drops the row. "Remove everything from this person" is `removeMessages` over every message they wrote, then one sweep.

- [ ] **Step 1: Write the failing tests** `tests/reporterRelay.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport } from '../src/tickets/filing.js';
import { addAccess } from '../src/tickets/actions.js';
import { staffThread } from '../src/tickets/threads.js';
import { messageByDiscordId } from '../src/tickets/messages.js';
import { removeMessage, removeMessages } from '../src/tickets/removal.js';
import { reporterThreadsOf } from '../src/tickets/reporterChat.js';
import { AttachmentStore, type AttachmentFetcher } from '../src/tickets/attachments.js';
import { TicketSync } from '../src/discord/ticketSync.js';
import { TicketMirror } from '../src/discord/ticketMirror.js';
import { ReporterChats } from '../src/discord/reporterChats.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000043${i}`);
const [R1, , ACCUSED, , , , MOD, ADMIN] = IDS;
const D = (id: string) => `97${IDS.indexOf(id)}`;
let db: DB;
let t: FakeTransport;
let sync: TicketSync;
let mirror: TicketMirror;
let chats: ReporterChats;
let root: string;

const fetcher: AttachmentFetcher = async () => ({ ok: true, body: (async function* () { yield new Uint8Array(10).fill(1); })() });

beforeEach(async () => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []);
    activatePlayer(db, id);
    linkDiscord(db, id, `97${i}`, `d${i}`);
  });
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  setSetting(db, 'discord_tickets_forum_id', 'forum1');
  setSetting(db, 'discord_tickets_channel_id', 'chan1');
  root = mkdtempSync(join(tmpdir(), 'pug-relay-'));
  t = new FakeTransport();
  mirror = new TicketMirror({
    db, transport: t, store: new AttachmentStore({ db, dir: join(root, 'files'), fetcher }),
    serialise: (fn) => sync.serialise(fn),
    onReporterActivity: (th, m, fresh) => sync.reporterActivity(th, m, fresh),
  });
  sync = new TicketSync({
    db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0,
    saveBeforeDelete: (id) => mirror.catchUp(id), sweepRemovals: () => { void mirror.sweepRemovals(); },
  });
  chats = new ReporterChats({ db, transport: t, publicUrl: 'https://pug.test', guildId: 'g1', serialise: (fn) => sync.serialise(fn) });
  sync.start();
  mirror.start();
  await settle();
});
afterEach(() => { mirror.stop(); sync.stop(); rmSync(root, { recursive: true, force: true }); });

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) { await mirror.idle(); await sync.idle(); }
}
async function chatAbout(category = 'griefing', text = 'x') {
  const r = fileReport(db, R1, { targetId: ACCUSED, category, text }, { adminSteamIds: [ADMIN] }) as { reportId: number; ticketId: number };
  await settle();
  await chats.openForReporter(r.reportId, { kind: 'player', steamid: R1 });
  await settle();
  return { ...r, chat: reporterThreadsOf(db, r.ticketId)[0].thread_id };
}
const copies = (ticketId: number) => {
  const post = staffThread(db, ticketId)?.thread_id;
  return t.live().filter((m) => m.channelId === post && (m.payload.embeds[0]?.title ?? '').startsWith('From the reporter'));
};

describe('the relay onto the forum post', () => {
  it('copies what the reporter writes, headed with their name, and not what staff write', async () => {
    const c = await chatAbout();
    await chats.join(c.ticketId, MOD);
    t.userPost(c.chat, { authorId: D(R1), authorName: 'Reporter Name', content: 'he did it again' });
    t.userPost(c.chat, { authorId: D(MOD), authorName: 'A Mod', content: 'thanks, looking now' });
    await settle();
    const got = copies(c.ticketId);
    expect(got).toHaveLength(1);
    expect(got[0].payload.embeds[0].title).toBe('From the reporter, Reporter Name');
    expect(got[0].payload.embeds[0].description).toBe('he did it again');
    expect(got[0].payload.mentionUserIds).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM relay_messages').get()).toEqual({ n: 1 });
    await sync.reconcile();
    expect(copies(c.ticketId)).toHaveLength(1);
  });

  it('an edit edits the copy; a delete in Discord deletes it', async () => {
    const c = await chatAbout();
    const m = t.userPost(c.chat, { authorId: D(R1), content: 'first words' });
    await settle();
    t.userEdit(m.id, 'second words');
    await settle();
    expect(copies(c.ticketId).map((x) => x.payload.embeds[0].description)).toEqual(['second words']);
    t.userDelete(m.id);
    await settle();
    expect(copies(c.ticketId)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM relay_messages').get()).toEqual({ n: 0 });
    // Deleted in Discord, the original stays on the site as before.
    expect(messageByDiscordId(db, m.id)!.content).toBe('second words');
  });

  it('a file travels as a link to the ticket page, never as Discord\'s own link', async () => {
    const c = await chatAbout();
    t.userPost(c.chat, { authorId: D(R1), content: '', attachments: [
      { id: 'a1', name: 'shot.png', contentType: 'image/png', size: 10, url: 'https://cdn.discordapp.com/x/shot.png' },
    ] });
    await settle();
    const [copy] = copies(c.ticketId);
    const said = JSON.stringify(copy.payload);
    expect(said).toContain('https://pug.test/admin/people/tickets/');
    expect(said).not.toContain('cdn.discordapp.com');
    expect(said).not.toContain('shot.png');
  });

  it('Remove takes the copy with it', async () => {
    const c = await chatAbout();
    const m = t.userPost(c.chat, { authorId: D(R1), content: 'something awful' });
    await settle();
    const row = messageByDiscordId(db, m.id)!;
    expect(removeMessage(db, join(root, 'files'), c.ticketId, row.id, MOD, '').ok).toBe(true);
    await mirror.sweepRemovals();
    await settle();
    expect(copies(c.ticketId)).toEqual([]);
    expect(JSON.stringify(t.live())).not.toContain('something awful');
  });

  it('Remove everything from this person: every message and every copy, in one pass', async () => {
    const c = await chatAbout();
    const a = t.userPost(c.chat, { authorId: D(R1), content: 'one' });
    const b = t.userPost(c.chat, { authorId: D(R1), content: 'two' });
    t.userPost(c.chat, { authorId: D(MOD), content: 'staff reply' });
    await settle();
    const ids = [messageByDiscordId(db, a.id)!.id, messageByDiscordId(db, b.id)!.id];
    expect(removeMessages(db, join(root, 'files'), c.ticketId, ids, MOD, '')).toEqual({ ok: true, removed: 2, files: 0 });
    expect(removeMessages(db, join(root, 'files'), c.ticketId, ids, MOD, '')).toEqual({ ok: true, removed: 0, files: 0 });
    await mirror.sweepRemovals();
    await settle();
    expect(copies(c.ticketId)).toEqual([]);
    expect(t.live().filter((m) => m.channelId === c.chat).map((m) => m.payload.content)).not.toContain('one');
    const events = (db.prepare("SELECT detail FROM ticket_events WHERE kind = 'removed'").all() as { detail: string }[]).map((e) => JSON.parse(e.detail));
    expect(events).toEqual([{ messageIds: ids, count: 2, files: 0 }]);
  });

  it('a restricted ticket: nothing is copied anywhere; its list is DMed once for two messages', async () => {
    const c = await chatAbout('unsafe', 'threats');
    addAccess(db, c.ticketId, ADMIN, MOD);
    await settle();
    const before = t.dms.length;
    db.prepare('DELETE FROM reporter_chat_pings').run();
    t.userPost(c.chat, { authorId: D(R1), content: 'he messaged me again' });
    t.userPost(c.chat, { authorId: D(R1), content: 'and again' });
    await settle();
    expect(staffThread(db, c.ticketId)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM relay_messages').get()).toEqual({ n: 0 });
    const pings = t.dms.slice(before);
    expect(pings.map((d) => d.userId).sort()).toEqual([D(MOD), D(ADMIN)].sort());
    expect(JSON.stringify(pings)).not.toContain('messaged me');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/reporterRelay.test.ts`
Expected: FAIL (`onReporterActivity` is not a dep; `removeMessages` does not exist).

- [ ] **Step 3: `src/discord/reporterRelay.ts`**

```ts
import { createHash } from 'node:crypto';
import type { DB } from '../db.js';
import type { MessageRow } from '../tickets/messages.js';
import { messageById } from '../tickets/messages.js';
import type { TicketRow } from '../tickets/store.js';
import type { ThreadRow } from '../tickets/threads.js';
import { escapeName } from './presenter.js';
import type { BotTransport, MessagePayload } from './transport.js';

export interface RelayDeps { db: DB; transport: BotTransport; publicUrl: string }

const hashOf = (p: MessagePayload) => createHash('sha1').update(JSON.stringify(p)).digest('hex');

/**
 * The copy of one reporter message on the forum post. Headed with the name
 * Discord showed for them. Their words verbatim, with no mention able to
 * ping anyone (mentionUserIds is empty, which the transport enforces). A
 * file is never re-uploaded and never linked where Discord keeps it: those
 * links expire, and on the site a reporter's file is click-to-reveal.
 */
export function relayPayload(m: Pick<MessageRow, 'author_name' | 'content'>, files: number, ticketId: number, publicUrl: string): MessagePayload {
  const lines: string[] = [];
  if (m.content) lines.push(m.content.slice(0, 3800));
  if (files > 0) {
    lines.push(`${files} file${files === 1 ? '' : 's'} attached. [Open the ticket on the site](${publicUrl}/admin/people/tickets/${ticketId}) to see ${files === 1 ? 'it' : 'them'}.`);
  }
  return {
    embeds: [{ title: `From the reporter, ${escapeName(m.author_name)}`.slice(0, 256), description: lines.join('\n\n') || '(no text)' }],
    components: [],
    mentionUserIds: [],
  };
}

/**
 * Every message a reporter wrote in a chat on this ticket, copied onto the
 * forum post, or its copy edited to match. Never on a restricted ticket (it
 * has no post), never staff's own replies (they wrote them in the chat), and
 * never a removed or deleted message: the mirror's removal sweep deletes
 * those copies. Runs inside the reconciler's pass, on the unlocked post.
 */
export async function syncRelay(d: RelayDeps, t: TicketRow, post: ThreadRow): Promise<void> {
  const { db, transport, publicUrl } = d;
  if (t.restricted === 1 || post.surface !== 'forum') return;
  const rows = db.prepare(
    `SELECT m.*, (SELECT COUNT(*) FROM ticket_attachments a WHERE a.message_id = m.id) AS files,
            rm.relay_message_id, rm.relay_thread_id, rm.hash AS relay_hash
     FROM ticket_messages m
       JOIN ticket_threads th ON th.thread_id = m.thread_id AND th.kind = 'reporter'
       LEFT JOIN relay_messages rm ON rm.source_message_id = m.discord_message_id
     WHERE m.ticket_id = ? AND m.removed_at IS NULL AND m.deleted_at IS NULL
       AND ((th.reporter_discord_id IS NOT NULL AND m.author_discord_id = th.reporter_discord_id)
         OR (th.reporter_id IS NOT NULL AND m.author_player_id = th.reporter_id))
     ORDER BY m.created_at, m.id`,
  ).all(t.id) as (MessageRow & { files: number; relay_message_id: string | null; relay_thread_id: string | null; relay_hash: string | null })[];
  const upsert = db.prepare(
    `INSERT INTO relay_messages (source_message_id, relay_message_id, relay_thread_id, hash) VALUES (?, ?, ?, ?)
     ON CONFLICT(source_message_id) DO UPDATE SET relay_message_id = excluded.relay_message_id,
       relay_thread_id = excluded.relay_thread_id, hash = excluded.hash`,
  );
  for (const m of rows) {
    const payload = relayPayload(m, m.files, t.id, publicUrl);
    const hash = hashOf(payload);
    if (m.relay_thread_id === post.thread_id && m.relay_message_id !== null) {
      if (m.relay_hash === hash) continue;
      if (await transport.edit(post.thread_id, m.relay_message_id, payload)) {
        db.prepare('UPDATE relay_messages SET hash = ? WHERE source_message_id = ?').run(hash, m.discord_message_id);
        continue;
      }
      // False: the copy was deleted by hand. Sent again below.
    }
    // A row for another thread is a copy on a post that has since gone (a
    // reopen made a new one): this post gets its own.
    const copyId = await transport.send(post.thread_id, payload);
    upsert.run(m.discord_message_id, copyId, post.thread_id, hash);
    // Removed while the copy was on its way: take it back now rather than
    // leave it for the next sweep.
    const now = messageById(db, m.id);
    if (now && (now.removed_at !== null || now.deleted_at !== null)) {
      await transport.remove(post.thread_id, copyId);
      db.prepare('DELETE FROM relay_messages WHERE source_message_id = ?').run(m.discord_message_id);
    }
  }
}
```

`src/discord/ticketSync.ts`: import `syncRelay` from `'./reporterRelay.js'`, and in `reconcileTicket`'s unlocked block, after `await this.pingInPost(t, thread);`:

```ts
      if (thread.surface === 'forum') await syncRelay(this.deps, t, thread);
```

- [ ] **Step 4: `src/discord/ticketMirror.ts`**

Add to `TicketMirrorDeps`:

```ts
  /** Something new in a reporter thread: TicketSync.reporterActivity, which
   *  queues that ticket's pass (the relay onto the forum post, and the
   *  restricted ticket's ping). Called on THIS chain and must return at once:
   *  it may never wait on the reconciler's chain, which waits on this one. */
  onReporterActivity?: (thread: ThreadRow, m: MessageRow, fresh: boolean) => void;
```

(import `type MessageRow` from `'../tickets/messages.js'`). Add a private helper:

```ts
  /** The hook, contained: a failure in it must not fail the copy onto the site. */
  private told(thread: ThreadRow, messageId: number, fresh: boolean): void {
    if (thread.kind !== 'reporter' || !this.deps.onReporterActivity) return;
    try {
      const row = messageById(this.deps.db, messageId);
      if (row) this.deps.onReporterActivity(thread, row, fresh);
    } catch (err) {
      console.error('[discord] telling the reconciler about a reporter message failed:', err instanceof Error ? err.message : err);
    }
  }
```

In `onMessage`, the `finally` after the attachments becomes:

```ts
    } finally {
      this.deps.onChange?.(thread.ticket_id);
      this.told(thread, row.id, true);
    }
```

In `applyEdit`, the `finally` becomes:

```ts
    } finally {
      if (changed) {
        this.deps.onChange?.(thread.ticket_id);
        this.told(thread, row.id, false);
      }
    }
```

In `onRemove`, after `this.deps.onChange?.(thread.ticket_id);`:

```ts
    // A reporter who deletes their message takes its copy on the forum post
    // with it. Asked for and not waited on: the sweep's chain waits on the
    // reconciler's, which waits on this one.
    if (thread.kind === 'reporter') void this.sweepRemovals();
```

In `sweepOwed`, after the existing loop over `owed`:

```ts
    // Copies on a forum post whose original was removed on the site or
    // deleted in Discord. The row goes once Discord confirms the copy is gone.
    const copies = db.prepare(
      `SELECT rm.source_message_id, rm.relay_message_id, rm.relay_thread_id FROM relay_messages rm
         JOIN ticket_messages m ON m.discord_message_id = rm.source_message_id
       WHERE m.removed_at IS NOT NULL OR m.deleted_at IS NOT NULL ORDER BY m.id`,
    ).all() as { source_message_id: string; relay_message_id: string; relay_thread_id: string }[];
    for (const c of copies) {
      try {
        await this.removeInDiscord(c.relay_thread_id, c.relay_message_id);
        db.prepare('DELETE FROM relay_messages WHERE source_message_id = ?').run(c.source_message_id);
      } catch (err) {
        console.error('[discord] could not delete the forum copy of a reporter message; the next sweep tries again:', err instanceof Error ? err.message : err);
        this.problem('A copy of a reporter\'s message on a staff forum post could not be deleted after the original was removed. It is retried every few minutes. The usual cause is the bot missing Manage Messages in the tickets forum.');
      }
    }
```

- [ ] **Step 5: `src/tickets/removal.ts`, the batch entry point**

Extract the post-commit tidy-up of `removeMessage` (everything from `// Everything from here on is after the commit` to the end of its `finally`) into a function, unchanged inside:

```ts
/** After a removal committed: purge the files, fold the log back, and nudge,
 *  in a finally. Never throws: the removal already stands. */
function afterRemoval(db: DB, dir: string, ticketId: number): void {
  try {
    if (purgeRemovedFiles(db, dir) > 0) {
      publishAdminEvent({ kind: 'problem', text: 'A file attached to a removed ticket message could not be deleted from disk. It is no longer served and is tried again at the next restart. Check the permissions on the ticket attachments directory.' });
    }
    const [checkpoint] = db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[];
    if (checkpoint?.busy) {
      console.error('[tickets] the write-ahead log could not be emptied after a removal because the database was in use; the removed text stays in the log until a later checkpoint folds it back in. The removal itself stands.');
    }
  } catch (err) {
    console.error('[tickets] tidying up after a removal failed; the removal itself stands:', err instanceof Error ? err.message : err);
  } finally {
    publishTicketSignal({ kind: 'ticket', ticketId });
  }
}
```

Keep the two long comments that sat inside that block (secure_delete and the checkpoint) above the matching lines. `removeMessage` then ends with `afterRemoval(db, dir, ticketId); return { ok: true, files };`. Add:

```ts
/**
 * Remove several messages of one ticket for good, in one transaction with
 * one event, then one tidy-up and one nudge: "Remove everything from this
 * person" (the 2b handoff's batch entry point). A message already removed,
 * or of another ticket, is skipped rather than refused: the caller asked for
 * "all of these", and the ones already gone are gone.
 */
export function removeMessages(
  db: DB, dir: string, ticketId: number, messageIds: number[], by: string, reason: unknown, now = new Date(),
): { ok: true; removed: number; files: number } | { ok: false; status: number; error: string } {
  const t = getTicketRow(db, ticketId);
  if (!t || !canSeeTicket(db, t, by)) return { ok: false, status: 404, error: 'no such ticket' };
  const text = typeof reason === 'string' ? reason.trim().slice(0, MAX_REASON) : '';
  const at = now.toISOString();
  const done = db.transaction(() => {
    const removed: number[] = [];
    let files = 0;
    for (const id of messageIds) {
      const m = messageById(db, id);
      if (!m || m.ticket_id !== ticketId || m.removed_at !== null) continue;
      db.prepare("UPDATE ticket_messages SET content = '', history = '[]', removed_at = ?, removed_by = ?, removed_reason = ? WHERE id = ?")
        .run(at, by, text, id);
      files += db.prepare('UPDATE ticket_attachments SET removed_at = ? WHERE message_id = ? AND removed_at IS NULL').run(at, id).changes;
      removed.push(id);
    }
    if (removed.length > 0) addTicketEvent(db, ticketId, by, 'removed', { messageIds: removed, count: removed.length, files }, now);
    return { removed: removed.length, files };
  })();
  if (done.removed > 0) afterRemoval(db, dir, ticketId);
  return { ok: true, ...done };
}
```

- [ ] **Step 6: Run it, the full suite and typecheck**

Run: `npx vitest run tests/reporterRelay.test.ts`, `npx vitest run`, `npm run typecheck`
Expected: all pass, `tests/ticketRemoval.test.ts` included (the single removal's behaviour is unchanged).

- [ ] **Step 7: Commit**

```bash
git add src tests/reporterRelay.test.ts
git commit -m "Copy reporter messages onto the staff post, and take the copies back on removal"
```

---

### Task 5: The Discord entry points

**Files:**
- Modify: `src/discord/ticketCard.ts`, `src/discord/ticketButtons.ts`, `src/discord/reportButton.ts`, `src/discord/commands.ts`, `src/discord/adminFeedPoster.ts`, `src/server.ts`
- Test: `tests/reporterChatDiscord.test.ts` (create); `tests/ticketSync.test.ts`, `tests/ticketButtons.test.ts` (update)

**Interfaces:**
- Consumes: `ReporterChats` (Task 2), `openReportsOf`, `reporterThreadsOf`, `reporterLabel` (Task 1).
- Produces: `chatButton(reportId: number, label?: string): Button` in `ticketCard.ts`; `TicketButtonDeps.chats?: () => ReporterChats | null`; `ReportHandlerDeps.chats?: () => ReporterChats | null`; custom ids `rp:mine`, `rp:chat:<reportId>`, `t:<id>:contact[:<reportId>]`, `t:<id>:join`, `t:<id>:endchat[:<threadRowId>]`; the close modal's `tell` select.

- [ ] **Step 1: Write the failing tests** `tests/reporterChatDiscord.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport } from '../src/tickets/filing.js';
import { reporterThreadsOf, CHAT_CLOSED } from '../src/tickets/reporterChat.js';
import { ReporterChats } from '../src/discord/reporterChats.js';
import { ReportButton, handleReportButton, handleReportModal } from '../src/discord/reportButton.js';
import { handleTicketButton, handleTicketModal } from '../src/discord/ticketButtons.js';
import { closeModal, ticketCard } from '../src/discord/ticketCard.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000044${i}`);
const [R1, R2, ACCUSED, , , , MOD, ADMIN] = IDS;
const D = (id: string) => `98${IDS.indexOf(id)}`;
let db: DB;
let t: FakeTransport;
let chats: ReporterChats;

beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []);
    activatePlayer(db, id);
    linkDiscord(db, id, `98${i}`, `d${i}`);
  });
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  setSetting(db, 'discord_tickets_channel_id', 'chan1');
  setSetting(db, 'discord_report_channel_id', 'reports');
  t = new FakeTransport();
  chats = new ReporterChats({ db, transport: t, publicUrl: 'https://pug.test', guildId: 'g1' });
});

const reportDeps = () => ({ db, adminSteamIds: [ADMIN], chats: () => chats });
const ticketDeps = () => ({ db, publicUrl: 'https://pug.test', chats: () => chats });
const press = (userId: string, customId: string) =>
  handleReportButton(reportDeps(), { kind: 'button', customId, userId, userName: 'x', presserTimedOutUntil: null });
const staffPress = (steamid: string, customId: string) =>
  handleTicketButton(ticketDeps(), { kind: 'button', customId, userId: D(steamid), userName: 'x', presserTimedOutUntil: null });
const file = (by: string, target: string, category = 'griefing') =>
  fileReport(db, by, { targetId: target, category, text: 'x' }, { adminSteamIds: [ADMIN] }) as { reportId: number; ticketId: number };
const buttonIds = (r: { payload: { components: unknown[][] } }) =>
  r.payload.components.flat().map((b) => (b as { customId?: string; url?: string }).customId ?? (b as { url: string }).url);

describe('the reporter\'s side', () => {
  it('the receipt carries a Chat button keyed by the report, never the ticket', async () => {
    const r = await handleReportModal(reportDeps(), {
      kind: 'modal', customId: 'rp:new', userId: D(R1), userName: 'x', presserTimedOutUntil: null,
      fields: { who: ACCUSED, reason: 'griefing', details: 'threw' }, picked: {},
    });
    const reportId = (db.prepare('SELECT id FROM ticket_reports').get() as { id: number }).id;
    expect(buttonIds(r)).toEqual([`rp:chat:${reportId}`]);
  });

  it('the report message has My reports beside Report a player', async () => {
    const button = new ReportButton({ db, transport: t, intervalMs: 0 });
    await button.tick();
    const [msg] = t.live().filter((m) => m.channelId === 'reports');
    expect(buttonIds({ payload: msg.payload })).toEqual(['rp:open', 'rp:mine']);
  });

  it('My reports lists the presser\'s open reports with a Chat button each', async () => {
    const a = file(R1, ACCUSED);
    const b = file(R1, R2, 'afk');
    const r = await press(D(R1), 'rp:mine');
    expect(r.ephemeral).toBe(true);
    expect(buttonIds(r)).toEqual([`rp:chat:${b.reportId}`, `rp:chat:${a.reportId}`]);
    expect(JSON.stringify(r.payload)).toContain('player1 (afk)');
    expect((await press('4242', 'rp:mine')).payload.content).toMatch(/no open reports/);
  });

  it('Chat opens the chat and links it; somebody else pressing it gets the closed answer', async () => {
    const a = file(R1, ACCUSED);
    const r = await press(D(R1), `rp:chat:${a.reportId}`);
    const [th] = reporterThreadsOf(db, a.ticketId);
    expect(buttonIds(r)).toEqual([`https://discord.com/channels/g1/${th.thread_id}`]);
    expect((await press(D(R2), `rp:chat:${a.reportId}`)).payload.content).toBe(CHAT_CLOSED);
  });

  it('a Discord-only member can chat about their report', async () => {
    const f = fileReport(db, { kind: 'discord', discordId: '4242', name: 'Lurky', timedOutUntil: null },
      { targetId: ACCUSED, category: 'toxicity', text: '' }, { adminSteamIds: [ADMIN] }) as { reportId: number };
    const r = await press('4242', `rp:chat:${f.reportId}`);
    expect(r.payload.content).toMatch(/open/);
  });

  it('with the bot not ready, it says so', async () => {
    const a = file(R1, ACCUSED);
    const r = await handleReportButton({ db, adminSteamIds: [ADMIN], chats: () => null }, {
      kind: 'button', customId: `rp:chat:${a.reportId}`, userId: D(R1), userName: 'x', presserTimedOutUntil: null,
    });
    expect(r.payload.content).toMatch(/not available right now/);
  });
});

describe('the staff post', () => {
  it('shows Contact reporter while there are reports, and Join and End while a chat is open', async () => {
    const a = file(R1, ACCUSED);
    expect(buttonIds({ payload: ticketCard(db, a.ticketId, 'https://pug.test')!.payload })).toContain(`t:${a.ticketId}:contact`);
    expect(buttonIds({ payload: ticketCard(db, a.ticketId, 'https://pug.test')!.payload })).not.toContain(`t:${a.ticketId}:join`);
    await chats.openForReporter(a.reportId, { kind: 'player', steamid: R1 });
    const ids = buttonIds({ payload: ticketCard(db, a.ticketId, 'https://pug.test')!.payload });
    expect(ids).toEqual(expect.arrayContaining([`t:${a.ticketId}:join`, `t:${a.ticketId}:endchat`]));
  });

  it('Contact with one reporter opens it straight away; with two it asks which', async () => {
    const a = file(R1, ACCUSED);
    const one = await staffPress(MOD, `t:${a.ticketId}:contact`);
    expect(buttonIds(one)[0]).toMatch(/^https:\/\/discord.com\/channels\/g1\//);
    file(R2, ACCUSED, 'afk');
    const which = await staffPress(MOD, `t:${a.ticketId}:contact`);
    expect(buttonIds(which).every((id) => id.startsWith(`t:${a.ticketId}:contact:`))).toBe(true);
    expect(buttonIds(which)).toHaveLength(2);
  });

  it('Join and End from the post, audited quietly on a ticket about staff', async () => {
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(ACCUSED);
    const a = file(R1, ACCUSED);
    await chats.openForReporter(a.reportId, { kind: 'player', steamid: R1 });
    expect(buttonIds(await staffPress(ADMIN, `t:${a.ticketId}:join`))[0]).toMatch(/^https:/);
    expect((await staffPress(ADMIN, `t:${a.ticketId}:endchat`)).payload.content).toMatch(/ended/);
    expect(reporterThreadsOf(db, a.ticketId, 'ended')).toHaveLength(1);
    const actions = (db.prepare('SELECT action FROM admin_actions ORDER BY id').all() as { action: string }[]).map((x) => x.action);
    expect(actions).toEqual(['ticket_chat_join', 'ticket_chat_end']);
    // The accused cannot press them at all.
    expect((await staffPress(ACCUSED, `t:${a.ticketId}:join`)).payload.content).toBe('No such ticket.');
  });

  it('the close form asks whether to tell the reporters, and No means nobody is told', async () => {
    expect(closeModal(1).fields.map((f) => f.id)).toEqual(['outcome', 'note', 'tell']);
    const a = file(R1, ACCUSED);
    await handleTicketModal(ticketDeps(), {
      kind: 'modal', customId: `t:${a.ticketId}:close`, userId: D(MOD), userName: 'x', presserTimedOutUntil: null,
      fields: { outcome: 'warned', note: '', tell: 'no' }, picked: {},
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_notices').get()).toEqual({ n: 0 });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/reporterChatDiscord.test.ts`
Expected: FAIL.

- [ ] **Step 3: `src/discord/ticketCard.ts`**

Import `reporterThreadsOf` from `'../tickets/reporterChat.js'` and `type Button` from `'./transport.js'`. Add:

```ts
/** The Chat button a reporter sees: on the receipt, and in My reports. Keyed
 *  by the REPORT: a ticket id would let two reporters learn they reported
 *  the same case. */
export function chatButton(reportId: number, label = 'Chat with the moderators'): Button {
  return { kind: 'button', customId: `rp:chat:${reportId}`, label: label.slice(0, 80), style: 'secondary' };
}
```

In `ticketCard`, replace the `// Claim, [Contact reporter: phase 3 puts it here], Close, then the link.` block with:

```ts
  // Row one: Claim, Close, the link. Row two, while open: Contact reporter
  // when anyone reported, and Join and End while a chat is open.
  const openChats = reporterThreadsOf(db, t.id, 'open').length;
  const chatRow: ActionRow = [];
  if (t.status === 'open' && reports.length > 0) chatRow.push({ kind: 'button', customId: `t:${t.id}:contact`, label: 'Contact reporter', style: 'secondary' });
  if (t.status === 'open' && openChats > 0) {
    chatRow.push({ kind: 'button', customId: `t:${t.id}:join`, label: 'Join reporter chat', style: 'secondary' });
    chatRow.push({ kind: 'button', customId: `t:${t.id}:endchat`, label: 'End reporter chat', style: 'secondary' });
  }
  const row: ActionRow = t.status === 'open'
    ? [
      { kind: 'button', customId: `t:${t.id}:claim`, label: t.claimed_by ? 'Release' : 'Claim', style: t.claimed_by ? 'secondary' : 'primary' },
      { kind: 'button', customId: `t:${t.id}:close`, label: 'Close', style: 'danger' },
      { kind: 'link', url, label: 'Open on the site' },
    ]
    : [{ kind: 'link', url, label: 'Open on the site' }];
```

Then `components: [row]` becomes `components: chatRow.length > 0 ? [row, chatRow] : [row]`.

`closeModal` gains a third field:

```ts
      { kind: 'select', id: 'tell', label: 'Tell the reporters it is closed?', options: [
        { label: 'Yes, send them a thank-you', value: 'yes', default: true },
        { label: 'No', value: 'no' },
      ] },
```

- [ ] **Step 4: `src/discord/ticketButtons.ts`**

```ts
import type { ReporterChats } from './reporterChats.js';
import { reporterLabel, reporterThreadsOf } from '../tickets/reporterChat.js';
import { ticketIsQuiet } from '../tickets/store.js';
```

`TicketButtonDeps` gains `chats?: () => ReporterChats | null;`. `say` becomes:

```ts
const say = (content: string, components: InteractionReply['payload']['components'] = []): InteractionReply => ({
  ephemeral: true,
  payload: { content, embeds: [], components, mentionUserIds: [] },
});
const link = (content: string, url: string, label: string) => say(content, [[{ kind: 'link', url, label }]]);
```

In `handleTicketButton`, the regex becomes `/^t:(\d+):(claim|close|contact|join|endchat)(?::(\d+))?$/`, and after `const { me, ticket } = who;`:

```ts
  if (m[2] === 'contact' || m[2] === 'join' || m[2] === 'endchat') {
    return chatAction(deps, m[2], ticket, me, m[3] === undefined ? null : Number(m[3]));
  }
```

and add:

```ts
/** The reporter-chat buttons on the staff post. Each calls what the site's
 *  route calls, and is audited the same way, quietly per ticketIsQuiet. */
async function chatAction(
  deps: TicketButtonDeps, action: 'contact' | 'join' | 'endchat', ticket: TicketRow, me: string, extra: number | null,
): Promise<InteractionReply> {
  const { db } = deps;
  const chats = deps.chats?.() ?? null;
  if (!chats) return say('Reporter chats are not available right now. Try again in a few minutes.');
  const quiet = ticketIsQuiet(db, ticket);
  const clip = (s: string) => s.slice(0, 80);

  if (action === 'contact') {
    let reportId = extra;
    if (reportId === null) {
      // One button per reporter, not per report.
      const reporters = db.prepare(
        `SELECT MIN(r.id) AS id, r.reporter_id, r.reporter_discord_id FROM ticket_reports r
         WHERE r.ticket_id = ? GROUP BY COALESCE(r.reporter_id, 'd:' || r.reporter_discord_id) ORDER BY MIN(r.id)`,
      ).all(ticket.id) as { id: number; reporter_id: string | null; reporter_discord_id: string | null }[];
      if (reporters.length === 0) return say('Nobody reported this ticket: it was opened by staff.');
      if (reporters.length > 1) {
        const buttons = reporters.slice(0, 20).map((r) => ({
          kind: 'button' as const, customId: `t:${ticket.id}:contact:${r.id}`, style: 'secondary' as const,
          label: clip(reporterLabel(db, ticket.id, { reporterId: r.reporter_id, reporterDiscordId: r.reporter_discord_id })),
        }));
        const rows = [];
        for (let i = 0; i < buttons.length; i += 5) rows.push(buttons.slice(i, i + 5));
        return say('Which reporter?', rows);
      }
      reportId = reporters[0].id;
    }
    const r = await chats.contact(ticket.id, reportId, me);
    if (!r.ok) return say(capitalise(r.error));
    logAdmin(db, me, 'ticket_contact', ticket.id, { reportId, via: 'discord' }, { quiet });
    return link('The chat with the reporter is open.', r.url, 'Open the chat');
  }

  if (action === 'join') {
    const r = await chats.join(ticket.id, me);
    if (!r.ok) return say(capitalise(r.error));
    logAdmin(db, me, 'ticket_chat_join', ticket.id, { via: 'discord' }, { quiet });
    return link('You are in the reporter chat.', r.url, 'Open the chat');
  }

  let threadRowId = extra;
  if (threadRowId === null) {
    const open = reporterThreadsOf(db, ticket.id, 'open');
    if (open.length === 0) return say('There is no open reporter chat on this ticket.');
    if (open.length > 1) {
      return say('Which chat?', [open.slice(0, 5).map((th) => ({
        kind: 'button' as const, customId: `t:${ticket.id}:endchat:${th.id}`, style: 'secondary' as const,
        label: clip(reporterLabel(db, ticket.id, { reporterId: th.reporter_id, reporterDiscordId: th.reporter_discord_id })),
      }))]);
    }
    threadRowId = open[0].id;
  }
  const r = await chats.end(ticket.id, threadRowId, me);
  if (!r.ok) return say(capitalise(r.error));
  logAdmin(db, me, 'ticket_chat_end', ticket.id, { threadRowId, via: 'discord' }, { quiet });
  return say('The reporter chat has ended.');
}
```

In `handleTicketModal`, the close call becomes `closeTicket(deps.db, id, who.me, i.fields.outcome, i.fields.note ?? '', i.fields.tell !== 'no')`.

- [ ] **Step 5: `src/discord/reportButton.ts` and `commands.ts`**

`reportButton.ts`: import `chatButton` from `'./ticketCard.js'`, `openReportsOf, type ReporterAsker` from `'../tickets/reporterChat.js'`, `type ReporterChats` from `'./reporterChats.js'`. `ReportHandlerDeps` becomes `{ db: DB; adminSteamIds: string[]; now?: () => Date; chats?: () => ReporterChats | null }`.

`standingPayload()`'s components become:

```ts
    components: [[
      { kind: 'button', customId: `${REPORT_PREFIX}open`, label: 'Report a player', style: 'primary' },
      { kind: 'button', customId: `${REPORT_PREFIX}mine`, label: 'My reports', style: 'secondary' },
    ]],
```

and append to `BODY` two lines: `''` and `'Already reported something? Press My reports to chat with the moderators about it.'`.

In `handleReportButton`, before the final `return say('That button no longer does anything.');`:

```ts
  if (i.customId === `${REPORT_PREFIX}mine`) {
    const rows = openReportsOf(deps.db, askerOf(me));
    if (rows.length === 0) return say('You have no open reports. Once a report is closed its chat ends; file a new one if something has happened since.');
    return say('Your open reports. Press one to chat with the moderators about it.',
      [rows.map((r) => chatButton(r.reportId, `${r.targetName} (${r.category})`))]);
  }
  if (i.customId.startsWith(`${REPORT_PREFIX}chat:`)) {
    const chats = deps.chats?.() ?? null;
    if (!chats) return say('Chats with the moderators are not available right now. Try again in a few minutes.');
    const r = await chats.openForReporter(Number(i.customId.split(':')[2]), askerOf(me));
    if (!r.ok) return say(r.error);
    return say(r.reopened ? 'Your chat with the moderators is open again.' : 'Your chat with the moderators is open.',
      [[{ kind: 'link', url: r.url, label: 'Open the chat' }]]);
  }
```

with, beside `whoIsPressing`:

```ts
const askerOf = (me: Me): ReporterAsker => (me.kind === 'player'
  ? { kind: 'player', steamid: me.steamid }
  : { kind: 'discord', discordId: me.discordId, timedOutUntil: me.timedOutUntil });
```

The success reply in `file()` becomes `return { ok: true, reply: say('Thanks. The moderators will look at it. The person you reported is never told who filed it.', [[chatButton(r.reportId)]]) };`.

`commands.ts`: import `chatButton` from `'./ticketCard.js'`; the `/report` success return becomes `return priv({ content: \`Reported ${name}${about}. Thanks, the moderators will look at it. The person you reported is never told who filed it.\`, components: [[chatButton(r.reportId)]] });`.

- [ ] **Step 6: `src/discord/adminFeedPoster.ts` and `src/server.ts`**

`adminFeedPoster.ts`: add `case 'ticket_contact': case 'ticket_chat_join': case 'ticket_chat_end':` to the ticket case list, and in the inner switch:

```ts
          case 'ticket_contact': return `${who} opened a chat with a reporter on ${ticket}${d.via === 'discord' ? ' from Discord' : ''}`;
          case 'ticket_chat_join': return `${who} joined the reporter chat on ${ticket}${d.via === 'discord' ? ' from Discord' : ''}`;
          case 'ticket_chat_end': return `${who} ended a reporter chat on ${ticket}${d.via === 'discord' ? ' from Discord' : ''}`;
```

`src/server.ts`:
- import `ReporterChats` from `'./discord/reporterChats.js'`;
- add to `ServerDeps`, after `discordModeration`:

```ts
  /** Test seam: stands in for the running bot's reporter chats, so the
   *  chat routes can be tested without a real bot. Wins when set. */
  reporterChats?: ReporterChats;
```

- beside `let reportButton ...`: `let reporterChats: ReporterChats | null = null;`;
- in `onConnected`, the mirror gains `onReporterActivity: (th, m, fresh) => ticketSync?.reporterActivity(th, m, fresh),`; after `ticketSync.start();` add:

```ts
        reporterChats = new ReporterChats({
          db: deps.db, transport: t, publicUrl: deps.config.publicUrl, guildId: deps.config.discord!.guildId,
          isMember: (id) => membership.isMember(id),
          // On the reconciler's chain, like the mirror's removals: both
          // unarchive a thread, act in it and archive it again.
          serialise: (fn) => (ticketSync ? ticketSync.serialise(fn) : fn()),
        });
```

- `extraButtons['t:']` becomes `(i) => handleTicketButton({ db: deps.db, publicUrl: deps.config.publicUrl, chats: () => deps.reporterChats ?? reporterChats }, i)`; `extraButtons['rp:']` and `extraModals['rp:']` pass `chats: () => deps.reporterChats ?? reporterChats`; `extraModals['t:']` passes the same `chats`.
- `ticketRoutes` gets `chats: () => deps.reporterChats ?? reporterChats,` (Task 6 declares the option; add this line in Task 6 if typecheck refuses it here).

(`config.discord.guildId` is a `string` whenever `config.discord` is set, and `onConnected` only runs when it is.)

- [ ] **Step 7: Update the existing tests**

`tests/ticketSync.test.ts`, the assertion at the top of the card test (`expect(buttons(row.thread_id)).toEqual([...])`) becomes:

```ts
    expect(buttons(row.thread_id)).toEqual([
      `t:${id}:claim=Claim`, `t:${id}:close=Close`, `link=https://pug.test/admin/people/tickets/${id}`, `t:${id}:contact=Contact reporter`,
    ]);
```

`tests/ticketButtons.test.ts`: the close modal assertion becomes `.toEqual([['select', 'outcome'], ['text', 'note'], ['select', 'tell']])`.

- [ ] **Step 8: Run it, the full suite and typecheck**

Run: `npx vitest run tests/reporterChatDiscord.test.ts`, `npx vitest run`, `npm run typecheck`
Expected: all pass. `tests/reportButton.test.ts` compares the receipt's text only, so it keeps passing; `tests/discordCommands.test.ts` matches `^Reported`.

- [ ] **Step 9: Commit**

```bash
git add src tests
git commit -m "Reporter chat buttons: the receipt, My reports, and Contact, Join and End on the staff post"
```

---

### Task 6: The site

**Files:**
- Modify: `src/routes/tickets.ts`, `src/server.ts` (the one `ticketRoutes` line, if not done in Task 5), `src/tickets/views.ts`, `web/src/api.ts`, `web/src/routes/admin/AdminTicket.tsx`, `web/src/routes/admin/TicketTimeline.tsx`, `web/src/components/MyReports.tsx`
- Test: `tests/reporterChatRoutes.test.ts` (create); `web/src/routes/admin/AdminTicket.test.tsx`, `web/src/components/ReportPlayer.test.tsx`, `web/src/routes/tickets.test.tsx` (update)

**Interfaces:**
- Consumes: everything above.
- Produces: routes `POST /api/reports/:rid/chat`, `POST /api/mod/tickets/:id/reports/:rid/contact`, `POST /api/mod/tickets/:id/chats/join`, `POST /api/mod/tickets/:id/chats/:tid/end`, `POST /api/mod/tickets/:id/chats/:tid/remove-all`; `POST /api/mod/tickets/:id/close` reads `tellReporters`; `ticketDetail(...).reporterChats: { id: number; reporterName: string; state: 'open' | 'ended'; url: string | null }[]`.

- [ ] **Step 1: Write the failing tests** `tests/reporterChatRoutes.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { linkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport } from '../src/tickets/filing.js';
import { insertMessage } from '../src/tickets/messages.js';
import { reporterThreadsOf } from '../src/tickets/reporterChat.js';
import { ReporterChats } from '../src/discord/reporterChats.js';
import { FakeTransport } from './fakes/fakeTransport.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000045${i}`);
const [R1, R2, ACCUSED, NOLINK, , , MOD, OWNER] = IDS;
let db: DB;
let app: FastifyInstance;
let t: FakeTransport;
const cookie: Record<string, Record<string, string>> = {};

async function boot(withBot: boolean) {
  db = openDb(':memory:');
  t = new FakeTransport();
  const chats = new ReporterChats({ db, transport: t, publicUrl: 'https://pug.test', guildId: 'g1' });
  app = await buildServer({
    config: loadConfig({ ADMIN_STEAMIDS: OWNER }), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
    ...(withBot ? { reporterChats: chats } : {}),
  });
  IDS.forEach((id, i) => {
    cookie[id] = authedCookie(app, db, id);
    if (id !== NOLINK) linkDiscord(db, id, `99${i}`, `d${i}`);
  });
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(OWNER);
  setSetting(db, 'discord_tickets_channel_id', 'chan1');
}
afterEach(async () => { await app.close(); });

const post = (as: string, url: string, payload: object = {}) => app.inject({ method: 'POST', url, cookies: cookie[as], payload });
const get = (as: string, url: string) => app.inject({ method: 'GET', url, cookies: cookie[as] });
const file = (by: string, target = ACCUSED) =>
  fileReport(db, by, { targetId: target, category: 'griefing', text: 'x' }, { adminSteamIds: [OWNER] }) as { reportId: number; ticketId: number };

describe('with the bot running', () => {
  beforeEach(() => boot(true));

  it('a player opens a chat from My reports and gets the link; nobody else can', async () => {
    const r = file(R1);
    const res = await post(R1, `/api/reports/${r.reportId}/chat`);
    expect(res.statusCode).toBe(200);
    const [th] = reporterThreadsOf(db, r.ticketId);
    expect(res.json()).toEqual({ ok: true, url: `https://discord.com/channels/g1/${th.thread_id}` });
    expect((await post(R2, `/api/reports/${r.reportId}/chat`)).statusCode).toBe(404);
  });

  it('a player with no Discord linked is told to link it', async () => {
    const r = file(NOLINK);
    const res = await post(NOLINK, `/api/reports/${r.reportId}/chat`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Link your Discord/);
  });

  it('staff contact, join and end, each audited; the page lists the chat', async () => {
    const r = file(R1);
    expect((await post(MOD, `/api/mod/tickets/${r.ticketId}/reports/${r.reportId}/contact`)).statusCode).toBe(200);
    expect((await post(OWNER, `/api/mod/tickets/${r.ticketId}/chats/join`)).statusCode).toBe(200);
    const d = (await get(MOD, `/api/mod/tickets/${r.ticketId}`)).json();
    const [th] = reporterThreadsOf(db, r.ticketId);
    // The test config has no Discord, so there is no guild id to link with.
    expect(d.reporterChats).toEqual([{ id: th.id, reporterName: 'p450', state: 'open', url: null }]);
    expect((await post(MOD, `/api/mod/tickets/${r.ticketId}/chats/${th.id}/end`)).statusCode).toBe(200);
    const actions = (db.prepare('SELECT action FROM admin_actions ORDER BY id').all() as { action: string }[]).map((a) => a.action);
    expect(actions).toEqual(['ticket_contact', 'ticket_chat_join', 'ticket_chat_end']);
    // The accused sees none of it.
    expect((await post(ACCUSED, `/api/mod/tickets/${r.ticketId}/chats/join`)).statusCode).toBe(403);
  });

  it('Remove everything from this person: every message they wrote in the ticket, and the chat ends', async () => {
    const r = file(R1);
    await post(MOD, `/api/mod/tickets/${r.ticketId}/reports/${r.reportId}/contact`);
    const [th] = reporterThreadsOf(db, r.ticketId);
    const say = (id: string, author: string, player: string | null, content: string) => insertMessage(db, {
      ticketId: r.ticketId, threadId: th.thread_id, channel: 'reporter', discordMessageId: id, authorDiscordId: author,
      authorPlayerId: player, authorName: 'x', content, createdAt: '2026-09-23T00:00:00Z',
    });
    say('7001', '990', R1, 'awful one');
    say('7002', '990', R1, 'awful two');
    say('7003', '996', MOD, 'staff reply');
    const res = await post(MOD, `/api/mod/tickets/${r.ticketId}/chats/${th.id}/remove-all`);
    expect(res.json()).toEqual({ ok: true, removed: 2, ended: true });
    const left = (db.prepare('SELECT content FROM ticket_messages ORDER BY id').all() as { content: string }[]).map((m) => m.content);
    expect(left).toEqual(['', '', 'staff reply']);
    expect(reporterThreadsOf(db, r.ticketId, 'ended')).toHaveLength(1);
  });

  it('closing without the tick queues no thank-you', async () => {
    const r = file(R1);
    expect((await post(MOD, `/api/mod/tickets/${r.ticketId}/close`, { outcome: 'warned', note: '', tellReporters: false })).statusCode).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_notices').get()).toEqual({ n: 0 });
    const s = file(R2, R1);
    expect((await post(MOD, `/api/mod/tickets/${s.ticketId}/close`, { outcome: 'warned', note: '' })).statusCode).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_notices').get()).toEqual({ n: 1 });
  });
});

describe('with no bot', () => {
  beforeEach(() => boot(false));

  it('says the bot is not running, after the checks that need no bot', async () => {
    const r = file(R1);
    expect((await post(R1, `/api/reports/${r.reportId}/chat`)).statusCode).toBe(503);
    const n = file(NOLINK, R2);
    expect((await post(NOLINK, `/api/reports/${n.reportId}/chat`)).statusCode).toBe(400);
    expect((await post(MOD, `/api/mod/tickets/${r.ticketId}/chats/join`)).statusCode).toBe(503);
  });
});
```

(`reporterName` is `'p450'` because `authedCookie` names a player `p` + the last three digits of the steamid. The accused gets 403 on the join route because it is a moderator-only route and ACCUSED is not staff; a staff accused would get the 404 from `checkChatStaff`, which Task 1's tests already cover.)

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/reporterChatRoutes.test.ts`
Expected: FAIL (404s: the routes do not exist).

- [ ] **Step 3: `src/routes/tickets.ts`**

Imports: `checkChatStaff, checkContactReporter, checkReporterChat, reporterDiscordIdOf` from `'../tickets/reporterChat.js'`; `removeMessages` beside `removeMessage`; `type ReporterChats` from `'../discord/reporterChats.js'`; `type ThreadRow` from `'../tickets/threads.js'`.

`TicketRouteOpts` gains:

```ts
  /** The running bot's reporter chats, or null when Discord is not
   *  connected. Read per call, like moderation. */
  chats: () => ReporterChats | null;
```

and destructure `chats` beside `moderation`. Add the routes (after `/api/reports/mine`, and after the removal route respectively):

```ts
  /** A reporter opens (or reopens) their chat about one of their reports.
   *  The rules first, so a player with no Discord linked is told that
   *  whether or not the bot is up. */
  app.post('/api/reports/:rid/chat', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return reply;
    const rid = Number((req.params as { rid: string }).rid);
    const pre = checkReporterChat(db, rid, { kind: 'player', steamid });
    if (!pre.ok) return reply.code(pre.status).send({ error: pre.error });
    const c = chats();
    if (!c) return reply.code(503).send({ error: 'Chats with the moderators are not available right now. Try again in a few minutes.' });
    const r = await c.openForReporter(rid, { kind: 'player', steamid });
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return { ok: true, url: r.url };
  });
```

```ts
  app.post('/api/mod/tickets/:id/reports/:rid/contact', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const { id, rid } = req.params as { id: string; rid: string };
    const pre = checkContactReporter(db, Number(id), Number(rid), me);
    if (!pre.ok) return reply.code(pre.status).send({ error: pre.error });
    const c = chats();
    if (!c) return reply.code(503).send({ error: 'the Discord bot is not running' });
    const r = await c.contact(Number(id), Number(rid), me);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    logAdmin(db, me, 'ticket_contact', Number(id), { reportId: Number(rid), via: 'site' }, { quiet: quiet(Number(id)) });
    return { ok: true, url: r.url };
  });

  app.post('/api/mod/tickets/:id/chats/join', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const id = Number((req.params as { id: string }).id);
    const pre = checkChatStaff(db, id, me);
    if (!pre.ok) return reply.code(pre.status).send({ error: pre.error });
    const c = chats();
    if (!c) return reply.code(503).send({ error: 'the Discord bot is not running' });
    const r = await c.join(id, me);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    logAdmin(db, me, 'ticket_chat_join', id, { via: 'site' }, { quiet: quiet(id) });
    return { ok: true, url: r.url };
  });

  app.post('/api/mod/tickets/:id/chats/:tid/end', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const { id, tid } = req.params as { id: string; tid: string };
    const c = chats();
    if (!c) return reply.code(503).send({ error: 'the Discord bot is not running' });
    const r = await c.end(Number(id), Number(tid), me);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    logAdmin(db, me, 'ticket_chat_end', Number(id), { threadRowId: Number(tid), via: 'site' }, { quiet: quiet(Number(id)) });
    return { ok: true };
  });

  /**
   * Remove everything from this person: every message they wrote anywhere in
   * this ticket, removed for good (text, history, files, the Discord message
   * and its forum copy), then their chat ended. The removal never waits on
   * Discord; ending the chat does, and without a bot `ended` is false.
   */
  app.post('/api/mod/tickets/:id/chats/:tid/remove-all', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const id = Number((req.params as { id: string }).id);
    const tid = Number((req.params as { tid: string }).tid);
    const t = getTicketRow(db, id);
    if (!t || !canSeeTicket(db, t, me)) return reply.code(404).send({ error: 'no such ticket' });
    const th = db.prepare("SELECT * FROM ticket_threads WHERE id = ? AND ticket_id = ? AND kind = 'reporter'").get(tid, id) as ThreadRow | undefined;
    if (!th) return reply.code(404).send({ error: 'no such chat' });
    const discordId = reporterDiscordIdOf(db, { reporterId: th.reporter_id, reporterDiscordId: th.reporter_discord_id });
    const ids = (db.prepare(
      `SELECT id FROM ticket_messages WHERE ticket_id = @ticket AND removed_at IS NULL
         AND ((@discord IS NOT NULL AND author_discord_id = @discord) OR (@player IS NOT NULL AND author_player_id = @player))`,
    ).all({ ticket: id, discord: discordId, player: th.reporter_id }) as { id: number }[]).map((r) => r.id);
    const r = removeMessages(db, attachmentsDir, id, ids, me, 'everything from this person');
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    logAdmin(db, me, 'ticket_remove', id, { count: r.removed, files: r.files, mirrored: true, everything: true, via: 'site' }, { quiet: quiet(id) });
    afterRemove();
    let ended = false;
    const c = chats();
    if (c && th.state === 'open') ended = (await c.end(id, tid, me)).ok;
    return { ok: true, removed: r.removed, ended };
  });
```

The close route becomes `act('ticket_close', (id, me, b) => closeTicket(db, id, me, b.outcome, b.note, b.tellReporters !== false), (b) => ({ outcome: b.outcome }))`.

`src/server.ts`: the `ticketRoutes` registration gains `chats: () => deps.reporterChats ?? reporterChats,` if Task 5 did not add it.

- [ ] **Step 4: `src/tickets/views.ts`**

Import `reporterLabel, reporterThreadsOf` from `'./reporterChat.js'`. In `ticketDetail`, before the `return`:

```ts
  // Reporter chats, for the ticket page's own section. The name is the
  // reporter's; staff may see who reported (they see the reports already).
  const reporterChats = reporterThreadsOf(db, id).map((th) => ({
    id: th.id,
    reporterName: reporterLabel(db, id, { reporterId: th.reporter_id, reporterDiscordId: th.reporter_discord_id }),
    state: th.state === 'open' ? 'open' as const : 'ended' as const,
    url: opts.guildId ? `https://discord.com/channels/${opts.guildId}/${th.thread_id}` : null,
  }));
```

and add `reporterChats` to the returned object beside `messages`.

- [ ] **Step 5: The web**

`web/src/api.ts`:
- `export interface ReporterChat { id: number; reporterName: string; state: 'open' | 'ended'; url: string | null }`;
- `TicketDetail` gains `reporterChats?: ReporterChat[];` (optional: an old server);
- `modApi.close: (id: number, outcome: string, note: string, tellReporters = true) => post(\`/api/mod/tickets/${id}/close\`, { outcome, note, tellReporters })`;
- `modApi` gains:

```ts
  contactReporter: (id: number, reportId: number) => post<{ ok: true; url: string }>(`/api/mod/tickets/${id}/reports/${reportId}/contact`),
  joinChats: (id: number) => post<{ ok: true; url: string }>(`/api/mod/tickets/${id}/chats/join`),
  endChat: (id: number, chatId: number) => post(`/api/mod/tickets/${id}/chats/${chatId}/end`),
  removeEverything: (id: number, chatId: number) =>
    post<{ ok: true; removed: number; ended: boolean }>(`/api/mod/tickets/${id}/chats/${chatId}/remove-all`),
```

- `api` gains `reportChat: (reportId: number) => post<{ ok: true; url: string }>(\`/api/reports/${reportId}/chat\`),`.

`web/src/routes/admin/AdminTicket.tsx`:
- beside the other `useState`s: `const [tell, setTell] = useState(true);` and `const [chatUrl, setChatUrl] = useState<string | null>(null);`;
- in each report's `<p>`, after the replay-moment link:

```tsx
                {open && <> · <button class="chip" type="button" disabled={busy}
                  onClick={() => run(async () => { setChatUrl((await modApi.contactReporter(t.id, r.id)).url); })}>Contact reporter</button></>}
```

- after the reports `<ul>`: `{chatUrl && <p><a href={chatUrl} target="_blank" rel="noreferrer">Open the chat with the reporter in Discord</a></p>}`;
- a section after the Discord sanctions section:

```tsx
      {(data.reporterChats ?? []).length > 0 && (
        <section>
          <h4>Reporter chats</h4>
          <p class="muted">Private Discord threads with the people who reported. Anyone with the Discord Administrator permission, or Manage Threads on the tickets channel, can read them.</p>
          <ul class="admin-list">
            {data.reporterChats!.map((c) => (
              <li key={c.id}>
                {c.reporterName} · {c.state}
                {c.url && <> · <a href={c.url} target="_blank" rel="noreferrer">Open in Discord</a></>}
                {c.state === 'open' && open && <> <button class="chip" type="button" disabled={busy} onClick={() => run(() => modApi.joinChats(t.id))}>Join</button></>}
                {c.state === 'open' && <> <button class="chip" type="button" disabled={busy} onClick={() => run(() => modApi.endChat(t.id, c.id), {
                  title: 'End this chat?', body: 'The reporter is taken out of the thread and it is locked. While the report is open they can start it again.', confirmLabel: 'End chat',
                })}>End chat</button></>}
                {' '}<button class="chip" type="button" disabled={busy} onClick={() => run(() => modApi.removeEverything(t.id, c.id), {
                  title: `Remove everything from ${c.reporterName}?`,
                  body: 'Every message they wrote in this ticket is removed for good, here and in Discord, with its files, and their chat is ended. This cannot be undone.',
                  confirmLabel: 'Remove everything', danger: true,
                })}>Remove everything from this person</button>
              </li>
            ))}
          </ul>
        </section>
      )}
```

- the close form gains, before the Close button: `<label><input type="checkbox" checked={tell} onChange={(e) => setTell((e.target as HTMLInputElement).checked)} /> Tell the reporters it is closed</label>`, and the Close button calls `modApi.close(t.id, outcome, note, tell)`.

`web/src/routes/admin/TicketTimeline.tsx`, in `eventText`, before `default`:

```ts
    case 'reporter_chat': return e.detail.by === 'staff' ? `${who} opened a chat with a reporter`
      : e.detail.reopened ? 'The reporter reopened their chat' : 'The reporter opened a chat with the moderators';
    case 'reporter_chat_joined': return `${who} joined the reporter chat`;
    case 'reporter_chat_ended': return e.actorId ? `${who} ended a reporter chat` : 'A reporter chat ended when the ticket closed';
```

and the `'removed'` case becomes:

```ts
    case 'removed': return e.detail.mirrored === false
      ? `${who} deleted a message in Discord that had not been copied here`
      : Number(e.detail.count) > 1
        ? `${who} removed ${Number(e.detail.count)} messages for good${Number(e.detail.files) > 0 ? `, with ${Number(e.detail.files)} file${Number(e.detail.files) === 1 ? '' : 's'}` : ''}`
        : `${who} removed a message for good${Number(e.detail.files) > 0 ? `, with ${Number(e.detail.files)} file${Number(e.detail.files) === 1 ? '' : 's'}` : ''}`;
```

`web/src/components/MyReports.tsx`:

```tsx
import { useState } from 'preact/hooks';
import { api, ApiError } from '../api';
import { useFetch } from '../hooks/useFetch';
import { Panel } from './bits';
import { fmtDate } from '../format';

/**
 * What you have reported, and whether the ticket is still open. Nothing about
 * the outcome: that stays with the moderators. This is also the fallback for
 * people whose Discord DMs are closed, who never get the closing message, and
 * the site's way into a chat with the moderators about an open report.
 */
export function MyReports() {
  const { data } = useFetch((s) => api.myReports(s), []);
  const [chat, setChat] = useState<Record<number, { url?: string; error?: string }>>({});
  if (!data || data.reports.length === 0) return null;
  const openChat = async (id: number) => {
    try {
      const r = await api.reportChat(id);
      setChat((c) => ({ ...c, [id]: { url: r.url } }));
    } catch (err) {
      setChat((c) => ({ ...c, [id]: { error: err instanceof ApiError ? err.message : 'Something went wrong.' } }));
    }
  };
  return (
    <Panel>
      <h3>Your reports</h3>
      <ul class="admin-list">
        {data.reports.map((r) => (
          <li key={r.id}>
            {r.targetId
              ? <a href={`/player/${r.targetId}`}>{r.targetName ?? r.targetId}</a>
              : <>{r.targetName ?? 'a Discord member'}</>} · {r.category}
            {r.matchId !== null && <> · <a href={`/match/${r.matchId}`}>#{r.matchId}</a></>}
            {' '}· {fmtDate(r.createdAt)} · <span class="muted">{r.status === 'open' ? 'open' : 'closed, thank you'}</span>
            {r.status === 'open' && (chat[r.id]?.url
              ? <> · <a href={chat[r.id].url} target="_blank" rel="noreferrer">Open the chat in Discord</a></>
              : <> · <button class="chip" type="button" onClick={() => void openChat(r.id)}>Chat with the moderators</button></>)}
            {chat[r.id]?.error && <span class="error"> {chat[r.id].error}</span>}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
```

(The hook sits above the early return, as the rules of hooks require. Confirm `ApiError` is exported from `web/src/api.ts`; `useAction.ts` already imports it from there.)

- [ ] **Step 6: Web tests**

`web/src/components/ReportPlayer.test.tsx`: add `reportChat: vi.fn()` to the hoisted `mockApi`, and in `describe('MyReports', ...)`:

```tsx
  it('offers a chat on an open report and shows the link it gets back, or the reason it cannot', async () => {
    mockApi.myReports.mockResolvedValue({ reports: [
      { id: 3, targetId: '7', targetDiscordId: null, targetName: 'Walls', category: 'cheating', matchId: null, createdAt: '2026-09-21T10:00:00.000Z', status: 'open' },
      { id: 4, targetId: '8', targetDiscordId: null, targetName: 'Gone', category: 'afk', matchId: null, createdAt: '2026-09-20T10:00:00.000Z', status: 'closed' },
    ] });
    mockApi.reportChat.mockResolvedValue({ ok: true, url: 'https://discord.com/channels/g1/5' });
    render(<MyReports />);
    const buttons = await screen.findAllByRole('button', { name: 'Chat with the moderators' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(mockApi.reportChat).toHaveBeenCalledWith(3));
    expect((await screen.findByText('Open the chat in Discord')).getAttribute('href')).toBe('https://discord.com/channels/g1/5');
  });
```

`web/src/routes/admin/AdminTicket.test.tsx`: add `contactReporter`, `joinChats`, `endChat`, `removeEverything`, `close` to the hoisted `mockMod` (as `vi.fn()`), and:

```tsx
  it('lists reporter chats with Join, End and Remove everything', async () => {
    mockMod.ticket.mockResolvedValue(detail({
      reports: [{ id: 9, reporterId: '76561198000000020', reporterDiscordId: null, reporterName: 'Tattler', category: 'cheating', text: '', matchId: null, campaign: null, moment: null, createdAt: '2026-09-21T18:56:13.000Z' }],
      reporterChats: [{ id: 3, reporterName: 'Tattler', state: 'open', url: 'https://discord.com/channels/g1/5' }],
    }));
    render(<AdminTicket id={1} onBack={() => {}} onOpen={() => {}} />);
    expect(await screen.findByText('Reporter chats')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Join' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'End chat' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove everything from this person' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Contact reporter' })).toBeTruthy();
    expect(screen.getByLabelText(/Tell the reporters it is closed/)).toBeTruthy();
  });
```

(If `TicketReport` in `web/src/api.ts` has a different field set, take the fields from its declaration; the ones above are what `ticketDetail` sends.)

`web/src/routes/tickets.test.tsx`: the close expectation becomes `expect(mockMod.close).toHaveBeenCalledWith(12, 'warned', 'first time', true)`.

- [ ] **Step 7: Full suite and typecheck**

Run: `npx vitest run tests/reporterChatRoutes.test.ts`, `npx vitest run`, `npm run typecheck`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src web/src tests
git commit -m "Reporter chat on the site: My reports Chat, Contact reporter, the chats section, the close tick"
```

---

## After the last task

- [ ] No existing table changes shape; three tables are added with `CREATE TABLE IF NOT EXISTS`. Still, dry-run `openDb` against a production backup with the recipe in the tickets memory (`gunzip -c ~/l4d/backups/pug/pug-<latest>.db.gz > <scratch>/pug.db`, a throwaway `.mts` script inside the repo that snapshots `sqlite_master` and per-table counts, calls the real `openDb`, snapshots again). Expect the three new tables, identical counts elsewhere, `integrity_check` ok, `foreign_key_check` empty. Never boot the real server against the copy.
- [ ] Deploy per the owner's standing rule (no players in game; back up the database; verify the tree hash, the service, the bot login, and that the report message now shows two buttons).
- [ ] Live checklist for the owner (the fake cannot prove these):
  - File a report from a test account, press Chat with the moderators on the receipt: a private thread "Chat with the moderators" appears under the tickets channel for that account only, with the opening line; the channel shows no "started a thread" line to anyone else.
  - Claim a ticket first and repeat: the claimer is added. Unclaimed: the forum post gets the ping line mentioning the moderators.
  - My reports on the report message lists the open report and its Chat button works after the receipt is gone.
  - Write in the chat: the words appear on the ticket page (reporter channel) and on the forum post as "From the reporter, <name>". Attach a picture: the post shows the site link, not the picture.
  - Remove that message on the site: it disappears from the chat and from the forum post.
  - End reporter chat from the post: the reporter is out and the thread is locked; pressing Chat again from My reports brings them back into the same thread.
  - A Safety concern report: pressing Chat makes the thread; the access list gets the DM "The reporter wrote on ticket #N" with a link and no words; nothing appears in the forum.
  - Close a ticket with the tick on: the chat ends with the closing line, and each reporter gets "Thank you for your report. The ticket is now closed."
  - **Permissions:** nobody but admins holds Manage Threads on the tickets channel. Discord shows every private thread in a channel to anyone with Manage Threads there, which would let a moderator read a restricted ticket's reporter chat they are not on (and the accused moderator read a chat about themselves).
  - A test account that has left the server: the site's Chat button says they are not in the Discord server.

## Decisions and deviations

1. **Pings go out for a chat being opened or reopened by the reporter (both kinds of ticket), and for each new reporter message only on a restricted ticket.** On a normal ticket every reporter message is already copied onto the forum post, which notifies whoever follows it; a mention per message would be noise. The spec names both notifications without saying when each fires.
2. **`reporter_chat_pings` has a `wanted_at` column the spec does not list**, so that a ping asked for inside the hour goes out when the hour is up instead of being lost. Keyed by the Discord thread id (like `ticket_messages.thread_id`), not by `ticket_threads.id`.
3. **A new `ticket_notices` table** holds the close DMs, written in the close's own transaction. The spec says "sends the neutral close DM" without saying how that survives the bot being down or runs after the chats end.
4. **The close tick comes back** ("tell the reporters", on by default) from the original tickets spec, on the site and as a select in the Discord close form. A notice queued and then overtaken by a reopen is dropped unsent.
5. **Custom ids and routes carry the report id, never the ticket id**, so a reporter never learns which case their report joined.
6. **Opening a chat requires good standing** (a player: `inGoodStanding`; a Discord-only member: the same test filing uses, now `discordReporterBlocked`). The spec does not say; a banned player could otherwise harass the moderators through the one door that is theirs.
7. **Ending a chat removes the reporter from the thread**, as the spec says, which also takes their view of the conversation away until they reopen it. Their messages stay on the site.
8. **"Join reporter chat" joins every open chat on the ticket**, from the post and from the site, rather than asking which. "End reporter chat" and "Contact reporter" ask which when there is more than one.
9. **The staff post's buttons move to two rows**: Claim, Close and the link, then Contact reporter, Join and End. Five buttons fit one row only without the link.
10. **The relay and the pings are done by the reconciler's pass** (queued by the mirror's hook), not sent from the hook itself. The handoff said "fire-and-forget through serialise"; queueing the ticket's pass is that, and it also makes the relay retry on the timer and catch messages written while the bot was down.
11. **A relayed copy is re-sent onto a new post** when a ticket's post is replaced (a reopen of a ticket about staff, whose closed post 3b1 deletes), so the new post carries the reporter's words too.
12. **Remove everything from this person covers every message they wrote in the ticket** (the original spec's words), not only the ones in their chat, and ends the chat only when the bot is running (`ended: false` otherwise, shown by the route; the page reloads and still shows the chat as open with its End button).
13. **Decided 2026-09-22 (owner took the recommendation): keep reporter chats in Discord for restricted tickets.** The ticket page's note must name both Discord Administrators and anyone with Manage Threads on the tickets channel. Was an open question: reporter chats on a restricted ticket are private Discord threads, and Discord Administrators (and anyone with Manage Threads on the tickets channel) can read them. The spec's owner ruling keeps restricted STAFF discussion off Discord but explicitly keeps reporter chats in Discord for restricted tickets too (the access list is only DMed). This plan follows the spec. If the owner wants a restricted ticket's reporter to be answered on the site instead, that is a different feature (the reporter has no site view of a ticket today).
