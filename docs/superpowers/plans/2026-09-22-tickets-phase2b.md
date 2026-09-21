# Tickets Phase 2b Implementation Plan: the mirrored discussion, attachments and Remove

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Copy every message staff write in a ticket's Discord thread onto the ticket page, with its edits, its deletion and its files stored on the box, and give staff one action, from the site or from Discord, that destroys a message and its files for good.

**Architecture:** The transport gains an inbound message hook that asks "is this thread a ticket?" before it looks at anything else, plus paged history fetch and a message context menu command; `djsTransport.ts` stays the only file importing discord.js. `TicketMirror` owns the copy: live events and a backfill go through one chain, write `ticket_messages` and `ticket_attachments`, and download files through an injected fetcher into a directory outside the web root. Removal is a database and disk operation that finishes inside the request; the Discord delete follows through a sweep the bot runs, so the site never waits on Discord. The ticket page refetches on a websocket event sent only to sockets whose user is active staff and can see that ticket.

**Tech Stack:** Fastify 5, better-sqlite3, @fastify/websocket 11, discord.js 14.27 behind `BotTransport`, Preact 10 + preact-iso, vitest 4 (`server` and `web` projects).

**Spec:** `docs/superpowers/specs/2026-09-21-tickets-design.md`. This plan is the second half of build order item 2: "Staff forum post, overwrite sync, mirror with backfill, attachments, removal." It is written against the code `docs/superpowers/plans/2026-09-22-tickets-phase2a.md` produces and must be built after it. Phase 3 (reporter threads and relay, End reporter chat, Remove everything from this person, the close DM) is not planned here, and nothing here may make it harder.

## Global Constraints

- Work only in the worktree `/home/volence/l4d/pug/.claude/worktrees/tickets` on branch `worktree-tickets`. Never write to the main checkout, never `git stash`, never push, never check out another branch; other sessions are committing to master.
- Nothing is deployed. No rcon, no ssh, no `deploy-web.sh`.
- Never use em dashes or en dashes in code, comments, docs, commit messages or UI copy.
- No `CHECK` constraint on any status-like column. New tables are `CREATE TABLE IF NOT EXISTS` in `src/tickets/schema.ts`; new columns on existing tables go through `ensureColumn` in `src/db.ts`.
- discord.js is imported by exactly one file, `src/discord/djsTransport.ts`. No test imports it. Everything with logic in it is tested against `tests/fakes/fakeTransport.ts`.
- No network in any test, ever. The attachment fetcher is an injected dependency with a fake in tests. Tests that touch files use a temp dir from `mkdtempSync(join(tmpdir(), ...))`, never the repo's `data/` directory, and remove it afterwards.
- The website never waits on Discord and never fails because of it. No Discord call is made inside a request. With `discord_tickets_forum_id` and `discord_tickets_channel_id` empty nothing Discord-side is attempted.
- Anything published to a subscriber that dials Discord or rcon is published AFTER the database transaction commits, never inside it.
- A restricted ticket must not be detectable by anyone off its access list, above all the accused. Mirrored messages and attachments are ticket content: every read path goes through `canSeeTicket` (`src/tickets/store.ts`) or its SQL twin `VISIBLE` (`src/tickets/views.ts`), the attachment serving route included. Missing and invisible are the same answer: 404, never 403. Nothing about a ticket's messages reaches the admin feed, any broadcast payload, or any response to someone who cannot see the ticket.
- `hub.broadcast('refresh')` reaches every connected client, the accused included. Chat updates never ride it. They ride `hub.sendTo('tickets', ...)`, which reaches only sockets whose user is active staff and can see the ticket.
- Only messages inside a thread listed in `ticket_threads` are ever read. Everything else is dropped before its content, author or attachments are looked at. Bot-authored messages are not mirrored.
- A Discord-side delete is SOFT: `deleted_at` is set, content and files are kept. Remove is HARD and cannot be undone: file bytes gone from disk, `content` and `history` blanked, the Discord message deleted if still there, only a tombstone kept (who, when, an optional short reason, and per file its name, size and sha256). The audit row and the ticket event for a removal never contain the removed content.
- Allowed attachment types, exact: `png`, `jpg`, `gif`, `webp`, `mp4`, `webm`, `mov`, `txt`. Anything else is recorded (name, type, size) and not stored.
- Setting defaults, exact: `ticket_store_attachments` = `1`, `ticket_attachment_max_mb` = `25`, `ticket_attachments_ticket_mb` = `200`, `ticket_attachments_total_mb` = `2048`.
- Serving route headers, exact: `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`; `Content-Disposition: inline` only for the allowed image and video types, otherwise `Content-Disposition: attachment`.
- Attachments live under `TICKET_ATTACHMENTS_DIR` (default: a `ticket-attachments` directory beside the database), outside the web root, under random names, never in the database. That directory is deliberately NOT part of the 6 hourly database backup, so removing a file removes every copy the system holds. Do not add it to any backup script.
- Size is validated from Discord's metadata BEFORE downloading and enforced again while streaming.
- Anyone with the Discord Administrator permission can read every channel and thread in the server. No code can change it; the page already says so (phase 2a).
- "Remove everything from this person" is phase 3. Remove here is one message at a time.
- Commit messages follow the repo style: one plain sentence saying what changed, no prefix.
- Test commands: `npx vitest run <file>` for one file, `npm test` for everything, `npm run typecheck` for types.
- Line numbers in this plan were right when it was written. Where a step quotes code, locate the place by the quoted code, not the number.

## File Structure

Created:
- `src/tickets/messages.ts`: the `ticket_messages` and `ticket_attachments` row types and their queries.
- `src/tickets/attachments.ts`: the allowed types, `AttachmentStore` (validate, download, hash, store), the real fetcher, and the path helper.
- `src/tickets/removal.ts`: `removeMessage` and `purgeRemovedFiles`.
- `src/tickets/nudge.ts`: who is told that a ticket changed.
- `src/discord/ticketMirror.ts`: `TicketMirror`: live events, backfill, retry of failed downloads, the Discord half of a removal.
- `src/discord/ticketRemove.ts`: the "Remove from ticket" message context menu command.
- `web/src/hooks/useTicketNudge.ts`: the browser side of the staff-scoped event.
- `web/src/routes/admin/TicketTimeline.tsx`: events and messages interleaved, files, Remove.
- Tests: `tests/ticketMessages.test.ts`, `tests/fakeMessages.test.ts`, `tests/ticketAttachments.test.ts`, `tests/ticketNudge.test.ts`, `tests/ticketMirror.test.ts`, `tests/ticketAttachmentRoute.test.ts`, `tests/ticketRemoval.test.ts`, `web/src/routes/admin/TicketTimeline.test.tsx`.

Modified:
- `src/tickets/schema.ts` (two tables), `src/tickets/store.ts` (`foldTicket`), `src/mergePlayers.ts` (`PLAIN`), `src/db.ts` and `src/settingsSchema.ts` (four settings), `src/config.ts` (`ticketAttachmentsDir`), `src/tickets/views.ts` (`messages` on the detail), `src/routes/tickets.ts` (the serving route, the remove route), `src/ws.ts` and `src/routes/ws.ts` (sockets know their user), `src/server.ts` (wiring), `src/discord/transport.ts`, `src/discord/index.ts`, `src/discord/djsTransport.ts`, `src/discord/adminFeedPoster.ts` (`ticket_remove`), `tests/fakes/fakeTransport.ts`, `tests/ws.test.ts`, `tests/discordBot.test.ts`, `tests/config.test.ts`.
- `web/src/api.ts`, `web/src/hooks/useLiveState.ts`, `web/src/routes/admin/AdminTicket.tsx`, `web/src/routes/admin/AdminTickets.tsx`, `web/src/styles/app.css`, `web/src/components/ReportPlayer.tsx`, `web/src/components/ReportPlayer.test.tsx`, `web/src/routes/MatchDetail.tsx`, `web/src/replay/Viewer.tsx`, `web/src/routes/tickets.test.tsx`.

Names this plan takes from phase 2a, exactly as built there: `ThreadRow`, `threadByDiscordId(db, threadId)`, `staffThread(db, ticketId)`, `insertThread(db, {...})` in `src/tickets/threads.ts`; `foldTicket(db, gone, keep, access, now?)` in `src/tickets/store.ts`; `TicketSignal`, `publishTicketSignal`, `subscribeTicketSignals` in `src/tickets/signals.ts`; `ThreadOps` and `BotTransport.threads` in `src/discord/transport.ts`; `FakeTransport.threadsById`, `threadsIn`, and its private `snowflake()`, `guardThread()`, `threadOp()` and `liveThread()`; `TicketSync` in `src/discord/ticketSync.ts`; `BotDeps.extraButtons`, `extraModals`, `opensModal` in `src/discord/index.ts`.

---

### Task 1: `ticket_messages` and `ticket_attachments`: the tables, their queries, both folds, the merge, the settings

Nothing here talks to Discord or touches a file. It lays down where the mirror writes, and teaches every piece of code that moves or deletes a ticket about the new rows, so that no later task can strand one.

Two columns are not in the spec, and both are there for a reason a later task depends on:
- `ticket_messages.discord_gone`: 1 once the Discord message is known to be gone (Discord told us it was deleted, or the bot deleted it). A removal commits on the site first and deletes in Discord afterwards; this column is how the sweep in Task 7 knows what is still owed, across restarts.
- `ticket_attachments.discord_attachment_id`: which attachment of the message this row is. A failed download is retried by fetching the message again for a freshly signed URL, and the retry has to find the same attachment in it.

**Files:**
- Create: `src/tickets/messages.ts`, `tests/ticketMessages.test.ts`
- Modify: `src/tickets/schema.ts` (append two tables), `src/tickets/store.ts` (`foldTicket`), `src/mergePlayers.ts` (`PLAIN`), `src/db.ts` (`DEFAULT_SETTINGS`), `src/settingsSchema.ts`, `src/config.ts`, `tests/config.test.ts`

**Interfaces:**
- Consumes: `foldTicket(db, gone, keep, access, now?)` and `restrictOpenTicketAbout` from `src/tickets/store.ts` (phase 2a Task 1); `insertThread` from `src/tickets/threads.ts`; `mergePlayers(db, { from, into, by?, adminSteamIds? })`.
- Produces, in `src/tickets/messages.ts`:
  - `type MessageChannel = 'staff' | 'reporter'`, `type SkipReason = 'too_large' | 'type' | 'quota' | 'disabled' | 'fetch_failed'`
  - `interface MessageRow { id; ticket_id; thread_id; channel; discord_message_id; author_discord_id; author_player_id; author_name; content; history; created_at; edited_at; deleted_at; removed_at; removed_by; removed_reason; discord_gone }`
  - `interface AttachmentRow { id; message_id; discord_attachment_id; filename; content_type; size; sha256; stored_name; skip_reason; removed_at }`
  - `messageById(db, id): MessageRow | undefined`, `messageByDiscordId(db, discordMessageId): MessageRow | undefined`
  - `insertMessage(db, m: NewMessage): MessageRow | null` (null when that Discord message is already stored)
  - `recordEdit(db, id: number, content: string, editedAt: string): boolean`
  - `markDeleted(db, discordMessageId: string, now?: Date): MessageRow | undefined`
  - `lastMessageId(db, threadId: string): string | null`
  - `insertAttachment(db, a: NewAttachment): number`, `updateAttachment(db, id, r: { size; sha256; storedName; skipReason }): void`, `attachmentsOf(db, messageId): AttachmentRow[]`
  - `storedBytes(db: DB, ticketId?: number): number`
- Produces elsewhere: settings `ticket_store_attachments`, `ticket_attachment_max_mb`, `ticket_attachments_ticket_mb`, `ticket_attachments_total_mb`; `Config.ticketAttachmentsDir: string`.

- [ ] **Step 1: Write the failing test**

`tests/ticketMessages.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { getSetting } from '../src/settings.js';
import { ensureTicketSchema } from '../src/tickets/schema.js';
import { fileReport } from '../src/tickets/filing.js';
import { foldTicket, restrictOpenTicketAbout } from '../src/tickets/store.js';
import { mergePlayers } from '../src/mergePlayers.js';
import {
  attachmentsOf, insertAttachment, insertMessage, lastMessageId, markDeleted, messageByDiscordId, messageById,
  recordEdit, storedBytes, updateAttachment,
} from '../src/tickets/messages.js';

const IDS = Array.from({ length: 6 }, (_, i) => `7656119900000000${i}`);
const [R1, R2, ACCUSED, ALT, MOD, ADMIN] = IDS;
const deps = { adminSteamIds: [ADMIN] };
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of IDS) {
    upsertPlayer(db, { steamid: id, name: `p${id.slice(-1)}`, avatar: null }, []);
    activatePlayer(db, id);
  }
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
});

const file = (reporter: string, targetId: string, category = 'griefing') =>
  (fileReport(db, reporter, { targetId, category, text: 'x' }, deps) as { ticketId: number }).ticketId;
const say = (ticketId: number, discordMessageId: string, content = 'hello', author: string | null = MOD) => insertMessage(db, {
  ticketId, threadId: '9001', channel: 'staff', discordMessageId, authorDiscordId: '906', authorPlayerId: author,
  authorName: 'mod on discord', content, createdAt: '2026-09-22T10:00:00.000Z',
})!;

describe('ticket_messages', () => {
  it('is idempotent, and a Discord message is stored once', () => {
    expect(() => ensureTicketSchema(db)).not.toThrow();
    const id = file(R1, ACCUSED);
    const m = say(id, '100001');
    expect(m).toMatchObject({ ticket_id: id, channel: 'staff', content: 'hello', history: '[]', deleted_at: null, removed_at: null, discord_gone: 0 });
    expect(insertMessage(db, {
      ticketId: id, threadId: '9001', channel: 'staff', discordMessageId: '100001', authorDiscordId: '906', authorPlayerId: MOD,
      authorName: 'x', content: 'again', createdAt: '2026-09-22T10:00:01.000Z',
    })).toBeNull();
    expect(messageByDiscordId(db, '100001')!.content).toBe('hello');
  });

  it('an edit pushes the previous content onto history, and an unchanged edit is nothing', () => {
    const m = say(file(R1, ACCUSED), '100001', 'first');
    expect(recordEdit(db, m.id, 'second', '2026-09-22T10:01:00.000Z')).toBe(true);
    expect(recordEdit(db, m.id, 'second', '2026-09-22T10:02:00.000Z')).toBe(false);
    expect(recordEdit(db, m.id, 'third', '2026-09-22T10:03:00.000Z')).toBe(true);
    const now = messageById(db, m.id)!;
    expect(now.content).toBe('third');
    expect(JSON.parse(now.history)).toEqual(['first', 'second']);
    expect(now.edited_at).toBe('2026-09-22T10:03:00.000Z');
  });

  it('a Discord delete is soft: marked, known gone, content kept', () => {
    const m = say(file(R1, ACCUSED), '100001', 'evidence');
    const gone = markDeleted(db, '100001', new Date('2026-09-22T11:00:00.000Z'))!;
    expect(gone).toMatchObject({ id: m.id, content: 'evidence', deleted_at: '2026-09-22T11:00:00.000Z', discord_gone: 1 });
    expect(markDeleted(db, 'nope')).toBeUndefined();
  });

  it('the last stored id is the largest snowflake, not the largest string', () => {
    const id = file(R1, ACCUSED);
    say(id, '99999');
    say(id, '100001');
    expect(lastMessageId(db, '9001')).toBe('100001');
    expect(lastMessageId(db, 'other')).toBeNull();
  });
});

describe('ticket_attachments', () => {
  it('counts only bytes that are on disk, per ticket and overall', () => {
    const a = file(R1, ACCUSED);
    const b = file(R1, ALT);
    const ma = say(a, '100001');
    const mb = say(b, '100002');
    const first = insertAttachment(db, { messageId: ma.id, discordAttachmentId: 'a1', filename: 'one.png', contentType: 'image/png', size: 100, sha256: 'h1', storedName: 'f'.repeat(32), skipReason: null });
    insertAttachment(db, { messageId: ma.id, discordAttachmentId: 'a2', filename: 'big.exe', contentType: 'application/x-msdownload', size: 5000, sha256: null, storedName: null, skipReason: 'type' });
    insertAttachment(db, { messageId: mb.id, discordAttachmentId: 'a3', filename: 'two.png', contentType: 'image/png', size: 30, sha256: 'h3', storedName: 'e'.repeat(32), skipReason: null });
    expect(storedBytes(db, a)).toBe(100);
    expect(storedBytes(db)).toBe(130);
    updateAttachment(db, first, { size: 0, sha256: null, storedName: null, skipReason: 'fetch_failed' });
    expect(attachmentsOf(db, ma.id).map((r) => [r.filename, r.skip_reason])).toEqual([['one.png', 'fetch_failed'], ['big.exe', 'type']]);
    expect(storedBytes(db)).toBe(30);
  });
});

describe('rows follow their ticket', () => {
  it('a fold moves the messages onto the survivor', () => {
    const keep = file(R1, ACCUSED);
    const gone = file(R2, ALT);
    const m = say(gone, '100001');
    insertAttachment(db, { messageId: m.id, discordAttachmentId: 'a1', filename: 'one.png', contentType: 'image/png', size: 1, sha256: 'h', storedName: 'f'.repeat(32), skipReason: null });
    db.transaction(() => foldTicket(db, gone, keep, 'merge'))();
    expect(messageById(db, m.id)!.ticket_id).toBe(keep);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('so does the fold into a restricted sibling when the accused becomes staff', () => {
    const normal = file(R1, ACCUSED);
    const sibling = file(R2, ACCUSED, 'unsafe');
    const m = say(normal, '100001');
    db.transaction(() => {
      db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(ACCUSED);
      expect(restrictOpenTicketAbout(db, ACCUSED, [ADMIN])).toBe('folded');
    })();
    expect(messageById(db, m.id)!.ticket_id).toBe(sibling);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('a player merge rewrites the author and the remover, and folds the tickets under the messages', () => {
    const main = file(R1, ACCUSED);
    const alt = file(R2, ALT);
    const m = say(alt, '100001', 'hello', R2);
    db.prepare("UPDATE ticket_messages SET removed_by = ?, removed_at = '2026-09-22T12:00:00.000Z' WHERE id = ?").run(R2, m.id);
    mergePlayers(db, { from: ALT, into: ACCUSED, by: ADMIN, adminSteamIds: [ADMIN] });
    expect(messageById(db, m.id)!.ticket_id).toBe(main);
    mergePlayers(db, { from: R2, into: R1, by: ADMIN, adminSteamIds: [ADMIN] });
    expect(messageById(db, m.id)).toMatchObject({ author_player_id: R1, removed_by: R1 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('settings and config', () => {
  it('seeds the four attachment settings with the exact defaults', () => {
    expect(getSetting(db, 'ticket_store_attachments')).toBe('1');
    expect(getSetting(db, 'ticket_attachment_max_mb')).toBe('25');
    expect(getSetting(db, 'ticket_attachments_ticket_mb')).toBe('200');
    expect(getSetting(db, 'ticket_attachments_total_mb')).toBe('2048');
  });

  it('keeps attachments beside the database unless told otherwise', () => {
    expect(loadConfig({ DB_PATH: '/srv/pug/data/pug.db' }).ticketAttachmentsDir).toBe('/srv/pug/data/ticket-attachments');
    expect(loadConfig({ DB_PATH: '/srv/pug/data/pug.db', TICKET_ATTACHMENTS_DIR: '/mnt/files' }).ticketAttachmentsDir).toBe('/mnt/files');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/ticketMessages.test.ts`
Expected: FAIL, cannot resolve `../src/tickets/messages.js`.

- [ ] **Step 3: The tables**

`src/tickets/schema.ts`: append inside the `db.exec` template, after the `ticket_threads` table and its index:

```sql

    CREATE TABLE IF NOT EXISTS ticket_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      thread_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      discord_message_id TEXT NOT NULL UNIQUE,
      author_discord_id TEXT NOT NULL,
      author_player_id TEXT REFERENCES players(steamid),
      author_name TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      history TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      edited_at TEXT,
      deleted_at TEXT,
      removed_at TEXT,
      removed_by TEXT,
      removed_reason TEXT,
      discord_gone INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages (ticket_id);
    CREATE INDEX IF NOT EXISTS idx_ticket_messages_thread ON ticket_messages (thread_id);

    CREATE TABLE IF NOT EXISTS ticket_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES ticket_messages(id),
      discord_attachment_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      content_type TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT,
      stored_name TEXT,
      skip_reason TEXT,
      removed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_attachments_message ON ticket_attachments (message_id);
```

and add to the comment above `ensureTicketSchema`:

```ts
 *
 * ticket_messages is the mirror of a ticket's Discord threads. `thread_id` is
 * the Discord thread's id, not a ticket_threads row id: a message belongs to
 * the ticket, and outlives the thread row it arrived through. `deleted_at` is
 * a Discord-side delete and keeps everything; `removed_at` is a removal and
 * keeps only the tombstone. `discord_gone` is 1 once the Discord message is
 * known to be gone, which is how a removal that committed while the bot was
 * down still gets its Discord message deleted later.
 *
 * ticket_attachments never holds a file, only where it is: `stored_name` is a
 * random name under TICKET_ATTACHMENTS_DIR, NULL when the file was not kept
 * (`skip_reason` says why) or is no longer there.
```

- [ ] **Step 4: The queries**

`src/tickets/messages.ts`:

```ts
import type { DB } from '../db.js';

export type MessageChannel = 'staff' | 'reporter';
export type SkipReason = 'too_large' | 'type' | 'quota' | 'disabled' | 'fetch_failed';

export interface MessageRow {
  id: number;
  ticket_id: number;
  thread_id: string;
  channel: MessageChannel;
  discord_message_id: string;
  author_discord_id: string;
  author_player_id: string | null;
  author_name: string;
  content: string;
  /** JSON array of earlier contents, oldest first. */
  history: string;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  removed_at: string | null;
  removed_by: string | null;
  removed_reason: string | null;
  discord_gone: number;
}

export interface AttachmentRow {
  id: number;
  message_id: number;
  discord_attachment_id: string;
  filename: string;
  content_type: string;
  size: number;
  sha256: string | null;
  stored_name: string | null;
  skip_reason: SkipReason | null;
  removed_at: string | null;
}

export interface NewMessage {
  ticketId: number; threadId: string; channel: MessageChannel; discordMessageId: string;
  authorDiscordId: string; authorPlayerId: string | null; authorName: string; content: string; createdAt: string;
}

export interface NewAttachment {
  messageId: number; discordAttachmentId: string; filename: string; contentType: string; size: number;
  sha256: string | null; storedName: string | null; skipReason: SkipReason | null;
}

/** An edit war must not grow a row without bound. The newest are kept. */
const HISTORY_MAX = 50;

export function messageById(db: DB, id: number): MessageRow | undefined {
  return db.prepare('SELECT * FROM ticket_messages WHERE id = ?').get(id) as MessageRow | undefined;
}

export function messageByDiscordId(db: DB, discordMessageId: string): MessageRow | undefined {
  return db.prepare('SELECT * FROM ticket_messages WHERE discord_message_id = ?').get(discordMessageId) as MessageRow | undefined;
}

/** Null when this Discord message is already stored: a live event and a
 *  backfill can both deliver it, and the second is not a second message. */
export function insertMessage(db: DB, m: NewMessage): MessageRow | null {
  const r = db.prepare(
    `INSERT OR IGNORE INTO ticket_messages
       (ticket_id, thread_id, channel, discord_message_id, author_discord_id, author_player_id, author_name, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(m.ticketId, m.threadId, m.channel, m.discordMessageId, m.authorDiscordId, m.authorPlayerId, m.authorName.slice(0, 100), m.content, m.createdAt);
  return r.changes === 0 ? null : messageByDiscordId(db, m.discordMessageId)!;
}

/** False when nothing changed: the content is the same, or the message has
 *  been removed and must stay blank whatever Discord says afterwards. */
export function recordEdit(db: DB, id: number, content: string, editedAt: string): boolean {
  const m = messageById(db, id);
  if (!m || m.removed_at !== null || m.content === content) return false;
  const history = [...(JSON.parse(m.history) as string[]), m.content].slice(-HISTORY_MAX);
  db.prepare('UPDATE ticket_messages SET content = ?, history = ?, edited_at = ? WHERE id = ?')
    .run(content, JSON.stringify(history), editedAt, id);
  return true;
}

/** A delete in Discord. Soft on purpose: the case file survives someone
 *  tidying up after themselves. The first deletion time is the one kept. */
export function markDeleted(db: DB, discordMessageId: string, now = new Date()): MessageRow | undefined {
  db.prepare('UPDATE ticket_messages SET deleted_at = COALESCE(deleted_at, ?), discord_gone = 1 WHERE discord_message_id = ?')
    .run(now.toISOString(), discordMessageId);
  return messageByDiscordId(db, discordMessageId);
}

/** The newest stored message in a thread. Snowflakes are decimal strings of
 *  growing length, so the longest wins and then the largest. */
export function lastMessageId(db: DB, threadId: string): string | null {
  const r = db.prepare(
    'SELECT discord_message_id AS id FROM ticket_messages WHERE thread_id = ? ORDER BY LENGTH(discord_message_id) DESC, discord_message_id DESC LIMIT 1',
  ).get(threadId) as { id: string } | undefined;
  return r?.id ?? null;
}

export function insertAttachment(db: DB, a: NewAttachment): number {
  return Number(db.prepare(
    `INSERT INTO ticket_attachments (message_id, discord_attachment_id, filename, content_type, size, sha256, stored_name, skip_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(a.messageId, a.discordAttachmentId, a.filename.slice(0, 255), a.contentType.slice(0, 100), a.size, a.sha256, a.storedName, a.skipReason).lastInsertRowid);
}

/** The outcome of a retried download. */
export function updateAttachment(
  db: DB, id: number, r: { size: number; sha256: string | null; storedName: string | null; skipReason: SkipReason | null },
): void {
  db.prepare('UPDATE ticket_attachments SET size = ?, sha256 = ?, stored_name = ?, skip_reason = ? WHERE id = ?')
    .run(r.size, r.sha256, r.storedName, r.skipReason, id);
}

export function attachmentsOf(db: DB, messageId: number): AttachmentRow[] {
  return db.prepare('SELECT * FROM ticket_attachments WHERE message_id = ? ORDER BY id').all(messageId) as AttachmentRow[];
}

/** Bytes on disk right now, for one ticket or for all of them. A file that
 *  was not kept, or has been removed, has no stored_name and counts nothing. */
export function storedBytes(db: DB, ticketId?: number): number {
  const sql = `SELECT COALESCE(SUM(a.size), 0) AS n FROM ticket_attachments a JOIN ticket_messages m ON m.id = a.message_id
               WHERE a.stored_name IS NOT NULL`;
  const r = ticketId === undefined
    ? db.prepare(sql).get() as { n: number }
    : db.prepare(`${sql} AND m.ticket_id = ?`).get(ticketId) as { n: number };
  return r.n;
}
```

- [ ] **Step 5: Both folds, and the merge**

Both folds are one function since phase 2a: `mergePlayers` and `restrictOpenTicketAbout` each call `foldTicket`. `src/tickets/store.ts`, in `foldTicket`, directly above the comment that begins `// Discord threads follow the ticket.`:

```ts
  // The mirrored discussion is part of the case. Attachments hang off their
  // message, so they follow without being touched.
  db.prepare('UPDATE ticket_messages SET ticket_id = ? WHERE ticket_id = ?').run(keep, gone);
```

`src/mergePlayers.ts`, in `PLAIN`, after `['ticket_threads', 'reporter_id'],`:

```ts
  ['ticket_messages', 'author_player_id'],
  ['ticket_messages', 'removed_by'],
```

`author_player_id` is a foreign key, so `tests/mergePlayers.test.ts` (which checks every foreign key to `players` against `MERGE_HANDLED_PLAYER_COLUMNS`) fails without the first line. `removed_by` is not a foreign key, like `tickets.claimed_by`, and is listed for the same reason that one is: the tombstone should name the account that still exists.

- [ ] **Step 6: The settings and the directory**

`src/db.ts`, in `DEFAULT_SETTINGS`, after `ticket_reports_per_day: '5',`:

```ts
  ticket_store_attachments: '1',
  ticket_attachment_max_mb: '25',
  ticket_attachments_ticket_mb: '200',
  ticket_attachments_total_mb: '2048',
```

`src/settingsSchema.ts`, after the `discord_tickets_channel_id` entry:

```ts
  { key: 'ticket_store_attachments', group: 'Discord', label: 'Store ticket attachments', help: 'Download files posted in ticket threads and keep them on the server, because Discord\'s own links expire within a day. Off: the name, type and size are recorded and the file is not kept. Files already stored stay until they are removed.', type: { kind: 'bool' } },
  { key: 'ticket_attachment_max_mb', group: 'Discord', label: 'Largest ticket attachment (MB)', help: 'A bigger file is recorded and not stored.', type: { kind: 'int', min: 1, max: 500 } },
  { key: 'ticket_attachments_ticket_mb', group: 'Discord', label: 'Attachment space per ticket (MB)', help: 'Once one ticket holds this much, further files on it are recorded and not stored.', type: { kind: 'int', min: 1, max: 10000 } },
  { key: 'ticket_attachments_total_mb', group: 'Discord', label: 'Attachment space overall (MB)', help: 'Once every ticket together holds this much, no new file is stored and the admin channel is told. Removing messages frees space. These files are deliberately left out of the database backup, so that removing one removes every copy.', type: { kind: 'int', min: 1, max: 1000000 } },
```

`src/config.ts`. Add `import { dirname, join } from 'node:path';`. In `Config`, after `dlc4MissionsDir`:

```ts
  /** Where files posted in ticket threads are kept: outside the web root,
   *  under random names, served only through the ticket's own access check.
   *  Deliberately NOT part of the 6 hourly database backup: removing a file
   *  has to remove every copy the system holds. */
  ticketAttachmentsDir: string;
```

In `loadConfig`, compute the database path once and use it twice:

```ts
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const dbPath = env.DB_PATH ?? 'data/pug.db';
  return {
    port: Number(env.PORT ?? 8080),
    publicUrl: env.PUBLIC_URL ?? 'http://localhost:8080',
    dbPath,
```

and after `dlc4MissionsDir: env.DLC4_MISSIONS_DIR ?? '',`:

```ts
    ticketAttachmentsDir: env.TICKET_ATTACHMENTS_DIR?.trim() || join(dirname(dbPath), 'ticket-attachments'),
```

It is not added to `missingDirs`: the directory is made on the first stored file, and not existing yet is the ordinary state of a fresh install.

`tests/config.test.ts`, at the end:

```ts
describe('ticketAttachmentsDir', () => {
  it('defaults to a directory beside the database', () => {
    expect(loadConfig({}).ticketAttachmentsDir).toBe('data/ticket-attachments');
    expect(loadConfig({ TICKET_ATTACHMENTS_DIR: ' /mnt/files ' }).ticketAttachmentsDir).toBe('/mnt/files');
  });
});
```

- [ ] **Step 7: Run**

Run: `npx vitest run tests/ticketMessages.test.ts tests/config.test.ts tests/ticketSchema.test.ts tests/ticketThreads.test.ts tests/ticketLeftovers.test.ts tests/mergePlayers.test.ts tests/adminSettings.test.ts && npm run typecheck`
Expected: PASS, typecheck clean. `tests/adminSettings.test.ts` proves all four new schema keys have a seeded default; `tests/mergePlayers.test.ts` proves `ticket_messages.author_player_id` is known to the merge.

- [ ] **Step 8: Commit**

```bash
git add src/tickets/messages.ts src/tickets/schema.ts src/tickets/store.ts src/mergePlayers.ts src/db.ts src/settingsSchema.ts src/config.ts tests/ticketMessages.test.ts tests/config.test.ts
git commit -m "Add the ticket message and attachment tables, move them with a fold and a merge, and seed the attachment settings"
```

---

### Task 2: Messages on the transport: the inbound hook, history, and a message context menu command

Phase 2a left these off the seam so it could ship without the Message Content intent. They go in here, in all three places at once as before: the interface, the fake every later test runs against, and discord.js.

The rule the whole mirror rests on is built into the seam itself: a transport asks `watches(threadId)` first, and hands nothing over when the answer is no. Not the content, not the author, not the attachments.

The discord.js half has no automated test, by that file's standing rule. Its gate is `npm run typecheck`, which checks every call below against the installed typings, plus the owner's manual checklist at the end of this plan. Every discord.js name used here was checked against `node_modules/discord.js/typings/index.d.ts` for the installed version, 14.27.0; the line is cited beside each. Locate by the quoted name if the numbers have moved.

Deleting a message needs no new method: `BotTransport.remove(channelId, messageId)` already deletes one and already treats "already gone" as success, and a thread id is a channel id.

**Files:**
- Create: `tests/fakeMessages.test.ts`
- Modify: `src/discord/transport.ts`, `tests/fakes/fakeTransport.ts`, `src/discord/index.ts` (`BotDeps`, command registration, the `onInteraction` handler), `src/discord/djsTransport.ts`, `tests/discordBot.test.ts` (one new case)

**Interfaces:**
- Consumes: `ThreadOps`, `BotTransport`, `BotInteraction`, `InteractionReply`, `SlashCommandDef` from `src/discord/transport.ts`; `FakeTransport`'s private `snowflake()`, `threadOp()`, `liveThread()`, `guardThread()` (phase 2a Task 3).
- Produces, in `src/discord/transport.ts`:

```ts
export interface InboundAttachment { id: string; name: string; contentType: string | null; size: number; url: string }
export interface InboundMessage {
  id: string; threadId: string; authorId: string; authorName: string; authorIsBot: boolean;
  content: string; attachments: InboundAttachment[]; createdAt: string; editedAt: string | null;
}
export interface MessageHooks {
  watches(threadId: string): boolean;
  create(m: InboundMessage): void;
  update(m: InboundMessage): void;
  remove(threadId: string, messageId: string): void;
}
export interface MessageCommandDef { name: string }

// BotInteraction gains:
//   | { kind: 'message_command'; name: string; userId: string; userName: string; channelId: string; messageId: string }
// ThreadOps gains:
//   fetchAfter(threadId: string, afterId: string | null): Promise<InboundMessage[]>;
//   fetchMessage(threadId: string, messageId: string): Promise<InboundMessage | null>;
// BotTransport gains:
//   watchMessages(h: MessageHooks): void;
// BotTransport.registerCommands becomes:
//   registerCommands(defs: SlashCommandDef[], messageCommands?: MessageCommandDef[]): Promise<void>;
```

- Produces, in `src/discord/index.ts`: `BotDeps.messageCommands?: Record<string, (i: Extract<BotInteraction, { kind: 'message_command' }>) => Promise<InteractionReply>>`, keyed by the command's exact name.
- Produces, on `FakeTransport`: `inbox`, `hooks`, `messageCommands`, `fetchPageSize`, `userPost(threadId, m, deliver?)`, `userEdit(messageId, content, deliver?)`, `userDelete(messageId, deliver?)`. Bot messages sent into a thread now get snowflake-shaped ids.

- [ ] **Step 1: Write the failing tests**

`tests/fakeMessages.test.ts`. As with the thread fake, this covers only the behaviour later tests lean on:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { FakeTransport } from './fakes/fakeTransport.js';
import type { InboundMessage } from '../src/discord/transport.js';

const card = (content: string) => ({ content, embeds: [], components: [] });
let t: FakeTransport;
let thread: string;
let heard: string[];

beforeEach(async () => {
  t = new FakeTransport();
  thread = (await t.threads.createForumPost('forum1', { name: 'x', message: card('the card'), tags: [] })).threadId;
  heard = [];
  t.watchMessages({
    watches: (id) => id === thread,
    create: (m) => heard.push(`create ${m.content}`),
    update: (m) => heard.push(`update ${m.content}`),
    remove: (_thread, id) => heard.push(`remove ${id}`),
  });
});

describe('FakeTransport messages', () => {
  it('delivers create, update and delete for a watched thread, and nothing at all for any other', () => {
    const m = t.userPost(thread, { authorId: '901', content: 'hello' });
    t.userEdit(m.id, 'hello again');
    t.userDelete(m.id);
    const other = t.userPost('general', { authorId: '901', content: 'not a ticket' });
    t.userEdit(other.id, 'still not');
    t.userDelete(other.id);
    expect(heard).toEqual(['create hello', 'update hello again', `remove ${m.id}`]);
  });

  it('history comes back oldest first, a page at a time, bot messages included, deleted ones not', async () => {
    t.fetchPageSize = 2;
    const a = t.userPost(thread, { authorId: '901', content: 'one' }, false);
    const b = t.userPost(thread, { authorId: '902', content: 'two' }, false);
    const c = t.userPost(thread, { authorId: '901', content: 'three' }, false);
    t.userDelete(b.id, false);
    await t.send(thread, card('a line from the bot'));
    expect(heard).toEqual([]);
    const first = await t.threads.fetchAfter(thread, null);
    // The card has the thread's own id, the smallest there is.
    expect(first.map((m: InboundMessage) => [m.content, m.authorIsBot])).toEqual([['the card', true], ['one', false]]);
    const second = await t.threads.fetchAfter(thread, first[1].id);
    expect(second.map((m) => m.content)).toEqual(['three', 'a line from the bot']);
    expect(await t.threads.fetchAfter(thread, second[1].id)).toEqual([]);
    expect((await t.threads.fetchMessage(thread, a.id))?.content).toBe('one');
    expect(await t.threads.fetchMessage(thread, b.id)).toBeNull();
    expect(c.id > a.id).toBe(true);
  });

  it('remove deletes a person\'s message, and an archived thread refuses it', async () => {
    const m = t.userPost(thread, { authorId: '901', content: 'gone soon' });
    await t.threads.setArchived(thread, true);
    await expect(t.remove(thread, m.id)).rejects.toThrow(/archived/i);
    await t.threads.setArchived(thread, false);
    await t.remove(thread, m.id);
    await t.remove(thread, m.id);
    expect(await t.threads.fetchMessage(thread, m.id)).toBeNull();
  });
});
```

And one case in `tests/discordBot.test.ts`, inside `describe('startBot extras', ...)`:

```ts
  it('registers message commands beside the slash commands and routes them by name', async () => {
    const s = setup(ENV);
    const bot = await startBot({
      ...s, connect: async () => s.t,
      messageCommands: { 'Remove from ticket': async (i) => ({ ephemeral: true, payload: { content: `removed ${i.messageId} in ${i.channelId}`, embeds: [], components: [] } }) },
    });
    expect(s.t.messageCommands).toEqual([{ name: 'Remove from ticket' }]);
    const r = await s.t.handler!({ kind: 'message_command', name: 'Remove from ticket', userId: '1', userName: 'x', channelId: 'th1', messageId: 'm9' });
    expect(r.payload.content).toBe('removed m9 in th1');
    const stray = await s.t.handler!({ kind: 'message_command', name: 'Something else', userId: '1', userName: 'x', channelId: 'th1', messageId: 'm9' });
    expect(stray.ephemeral).toBe(true);
    await bot!.stop();
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/fakeMessages.test.ts tests/discordBot.test.ts`
Expected: FAIL. `t.watchMessages` is not a function in the first file; `messageCommands` is not a known property in the second.

- [ ] **Step 3: The interface**

`src/discord/transport.ts`. Above `export type BotInteraction` add:

```ts
/** One file on a message. `url` is Discord's signed CDN link, good for about
 *  a day: whoever wants the file downloads it now. */
export interface InboundAttachment { id: string; name: string; contentType: string | null; size: number; url: string }

/** A message somebody wrote in a thread the bot watches. */
export interface InboundMessage {
  id: string;
  threadId: string;
  authorId: string;
  /** The name Discord shows for them in this server. */
  authorName: string;
  /** Bots, webhooks and Discord's own system lines ("X added Y to the thread"). */
  authorIsBot: boolean;
  content: string;
  attachments: InboundAttachment[];
  createdAt: string;
  editedAt: string | null;
}

/**
 * Inbound messages. `watches` is asked FIRST, with the thread id and nothing
 * else, and a transport hands over nothing when it answers false: not the
 * content, not the author, not the attachments. The bot sits in a server
 * full of conversations that are none of its business.
 */
export interface MessageHooks {
  watches(threadId: string): boolean;
  create(m: InboundMessage): void;
  update(m: InboundMessage): void;
  remove(threadId: string, messageId: string): void;
}

/** A command in a message's right-click menu (Apps). It has a name and
 *  nothing else: Discord supplies the message it was used on. */
export interface MessageCommandDef { name: string }
```

Add a member to the `BotInteraction` union, after the `modal` member:

```ts
  /** A message context menu command. Only ids: what the message SAYS is never
   *  handed to the bot's logic through this path. */
  | { kind: 'message_command'; name: string; userId: string; userName: string; channelId: string; messageId: string };
```

(The `modal` member's closing `;` becomes part of the union: end the `modal` line without a semicolon and put it after the new member.)

In `ThreadOps`, after `deleteThread`:

```ts
  /** One page of a thread's history, oldest first, strictly after `afterId`
   *  (null: from the beginning). An empty page means there is no more. Bot
   *  messages are included; the caller drops them. */
  fetchAfter(threadId: string, afterId: string | null): Promise<InboundMessage[]>;
  /** One message, fetched fresh (its attachment links are newly signed). Null
   *  when the message or the thread is gone. */
  fetchMessage(threadId: string, messageId: string): Promise<InboundMessage | null>;
```

In `BotTransport`, replace the `registerCommands` line and add `watchMessages`:

```ts
  /** Replaces every command the bot has in the server, so both kinds go in
   *  one call. */
  registerCommands(defs: SlashCommandDef[], messageCommands?: MessageCommandDef[]): Promise<void>;
  /** Start hearing messages. See MessageHooks for the one rule. */
  watchMessages(h: MessageHooks): void;
```

- [ ] **Step 4: The fake**

`tests/fakes/fakeTransport.ts`. Add `InboundAttachment, InboundMessage, MessageCommandDef, MessageHooks` to the type import. Inside the class, below the thread world's `opensModal` field:

```ts
  // Message world: what people, not the bot, wrote.
  inbox: (InboundMessage & { deleted: boolean })[] = [];
  hooks: MessageHooks | null = null;
  messageCommands: MessageCommandDef[] = [];
  /** How many messages one fetchAfter returns. Discord's is 100. */
  fetchPageSize = 100;

  watchMessages(h: MessageHooks): void {
    this.hooks = h;
  }

  private view(m: InboundMessage & { deleted: boolean }): InboundMessage {
    const { deleted: _deleted, ...rest } = m;
    return { ...rest, attachments: [...m.attachments] };
  }

  /** Someone writes in a channel. `deliver: false` is a message the bot was
   *  not online to hear: it is only there for a later fetchAfter. */
  userPost(
    threadId: string,
    m: { authorId: string; authorName?: string; content: string; attachments?: InboundAttachment[]; bot?: boolean },
    deliver = true,
  ): InboundMessage {
    const msg = {
      id: this.snowflake(), threadId, authorId: m.authorId, authorName: m.authorName ?? `user${m.authorId}`,
      authorIsBot: m.bot ?? false, content: m.content, attachments: m.attachments ?? [],
      createdAt: new Date(Date.UTC(2026, 8, 22, 10, 0, this.inbox.length)).toISOString(), editedAt: null, deleted: false,
    };
    this.inbox.push(msg);
    // As the real transport does: ask first, hand over nothing on a no.
    if (deliver && this.hooks?.watches(threadId)) this.hooks.create(this.view(msg));
    return this.view(msg);
  }

  userEdit(messageId: string, content: string, deliver = true): void {
    const msg = this.inbox.find((m) => m.id === messageId);
    if (!msg) throw new Error(`no such message ${messageId}`);
    msg.content = content;
    msg.editedAt = new Date(Date.UTC(2026, 8, 22, 11, 0, 0)).toISOString();
    if (deliver && this.hooks?.watches(msg.threadId)) this.hooks.update(this.view(msg));
  }

  userDelete(messageId: string, deliver = true): void {
    const msg = this.inbox.find((m) => m.id === messageId);
    if (!msg) throw new Error(`no such message ${messageId}`);
    msg.deleted = true;
    if (deliver && this.hooks?.watches(msg.threadId)) this.hooks.remove(msg.threadId, messageId);
  }

  /** A thread's whole history as Discord would list it: the bot's messages
   *  and everyone else's, oldest first. */
  private history(threadId: string): InboundMessage[] {
    const bot = this.messages.filter((m) => m.channelId === threadId && !m.deleted && /^\d+$/.test(m.id)).map((m): InboundMessage => ({
      id: m.id, threadId, authorId: 'bot', authorName: 'bot', authorIsBot: true, content: m.payload.content ?? '',
      attachments: [], createdAt: new Date(Date.UTC(2026, 8, 22, 9, 0, 0)).toISOString(), editedAt: null,
    }));
    const people = this.inbox.filter((m) => m.threadId === threadId && !m.deleted).map((m) => this.view(m));
    return [...bot, ...people].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  }
```

Add two members to the `threads` object, after `deleteThread`:

```ts
    fetchAfter: async (threadId, afterId) => {
      this.threadOp();
      this.liveThread(threadId);
      const after = BigInt(afterId ?? '0');
      return this.history(threadId).filter((m) => BigInt(m.id) > after).slice(0, this.fetchPageSize);
    },
    fetchMessage: async (threadId, messageId) => {
      this.threadOp();
      const th = this.threadsById.get(threadId);
      if (!th || th.deleted) return null;
      return this.history(threadId).find((m) => m.id === messageId) ?? null;
    },
```

A message the bot sends into a thread needs an id that sorts with everyone else's. In `send`, replace ``const id = `m${++this.seq}`;`` with:

```ts
    // Inside a thread the id is snowflake-shaped, so history sorts. Anywhere
    // else it stays 'm<n>', which a dozen older tests read.
    const id = this.threadsById.has(channelId) ? this.snowflake() : `m${++this.seq}`;
```

Replace `remove` with one that knows about people's messages and about archived threads:

```ts
  async remove(channelId: string, messageId: string): Promise<void> {
    this.guardThread(channelId);
    const m = this.messages.find((x) => x.id === messageId);
    if (m) m.deleted = true;
    const theirs = this.inbox.find((x) => x.id === messageId);
    if (theirs) theirs.deleted = true;
  }
```

And `registerCommands` remembers both kinds:

```ts
  async registerCommands(defs: SlashCommandDef[], messageCommands: MessageCommandDef[] = []): Promise<void> {
    this.commands = defs;
    this.messageCommands = messageCommands;
  }
```

- [ ] **Step 5: Register and route message commands in `src/discord/index.ts`**

In `BotDeps`, below `opensModal`:

```ts
  /** Message context menu commands, by exact name. The names are what gets
   *  registered; the handler gets ids only, never the message's content. */
  messageCommands?: Record<string, (i: Extract<BotInteraction, { kind: 'message_command' }>) => Promise<InteractionReply>>;
```

In the `transport.onInteraction(async (i) => { ... })` handler, directly above the line `if (deps.commands) return deps.commands.handle(i);`:

```ts
    if (i.kind === 'message_command') {
      const run = deps.messageCommands?.[i.name];
      if (run) return run(i);
      return { ephemeral: true, payload: { content: 'That command no longer does anything.', embeds: [], components: [] } };
    }
```

Replace the registration block (`if (deps.commands) { await transport.registerCommands(deps.commands.defs)...`) with:

```ts
  const messageCommands = Object.keys(deps.messageCommands ?? {}).map((name) => ({ name }));
  if (deps.commands || messageCommands.length > 0) {
    await transport.registerCommands(deps.commands?.defs ?? [], messageCommands).catch((err) =>
      console.error('[discord] registering commands failed:', err));
  }
```

- [ ] **Step 6: Run the two test files**

Run: `npx vitest run tests/fakeMessages.test.ts tests/discordBot.test.ts tests/fakeThreads.test.ts`
Expected: PASS. `npm run typecheck` is red until the next step: `createDjsTransport` has no `watchMessages`, `fetchAfter` or `fetchMessage` yet.

- [ ] **Step 7: discord.js: intents, partials, and the three events**

`src/discord/djsTransport.ts`. Widen the imports:

```ts
import {
  ApplicationCommandOptionType, ApplicationCommandType, ChannelType, Client, ComponentType, Events, GatewayIntentBits, MessageFlags,
  OverwriteType, Partials, PermissionFlagsBits, ThreadAutoArchiveDuration,
  type AnyThreadChannel, type ForumChannel, type Guild, type Interaction, type Message, type TextBasedChannel,
} from 'discord.js';
```

and add `InboundMessage, MessageCommandDef, MessageHooks` to the type import from `'./transport.js'`.

Replace the `new Client({ ... })` call:

```ts
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates,
      // Tickets mirror what staff write in ticket threads. GuildMessages is
      // the events (discord-api-types gateway/v10.d.ts:169); MessageContent is
      // the privileged one (:175), switched on in the developer portal, and
      // without it every content arrives as an empty string.
      GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
    ],
    // Without this discord.js silently drops an edit or a delete of any
    // message it has not cached, which is every message older than this
    // process. Partials :7735, ClientOptions.partials :6233.
    partials: [Partials.Message],
  });
```

Below `let opensModal ...` add:

```ts
  let hooks: MessageHooks | null = null;

  /** Message :2459. attachments :2466, author :2467, content :2473,
   *  createdTimestamp :2475, editedTimestamp :2480, member :2490, system
   *  :2501, webhookId :2509; Attachment :2582; User.bot :4087, globalName
   *  :4096; GuildMember.displayName :1886. */
  // A Pick, not Message itself: the events hand over
  // OmitPartialGroupDMChannel<Message>, an Omit of a class with private
  // members, which is not assignable to the class. Both satisfy this.
  type ReadableMessage = Pick<Message,
    'id' | 'channelId' | 'author' | 'member' | 'webhookId' | 'system' | 'content' | 'attachments' | 'createdTimestamp' | 'editedTimestamp'>;
  const toInbound = (m: ReadableMessage): InboundMessage => ({
    id: m.id,
    threadId: m.channelId,
    authorId: m.author.id,
    authorName: m.member?.displayName ?? m.author.globalName ?? m.author.username,
    authorIsBot: m.author.bot || m.webhookId !== null || m.system,
    content: m.content,
    attachments: [...m.attachments.values()].map((a) => ({ id: a.id, name: a.name, contentType: a.contentType, size: a.size, url: a.url })),
    createdAt: new Date(m.createdTimestamp).toISOString(),
    editedAt: m.editedTimestamp === null ? null : new Date(m.editedTimestamp).toISOString(),
  });

  // In all four listeners the FIRST thing read is the channel id, and the
  // first thing done is to ask whether that thread is a ticket. Nothing else
  // about a message is touched before the answer is yes.
  client.on(Events.MessageCreate, (m) => {                                    // messageCreate :6145
    if (!hooks || !hooks.watches(m.channelId)) return;
    hooks.create(toInbound(m));
  });
  client.on(Events.MessageUpdate, async (_old, m) => {                        // messageUpdate :6168
    if (!hooks || !hooks.watches(m.channelId)) return;
    try {
      // An uncached message can arrive partial, with no author and no
      // content; fetch it whole. Message.fetch :2529.
      const full = (m as { partial: boolean }).partial ? await m.fetch() : m;
      hooks.update(toInbound(full));
    } catch (err) {
      console.error('[discord] could not read an edited ticket message:', err);
    }
  });
  client.on(Events.MessageDelete, (m) => {                                    // messageDelete :6146
    // A partial still carries both ids, which is all this needs.
    if (!hooks || !hooks.watches(m.channelId)) return;
    hooks.remove(m.channelId, m.id);
  });
  client.on(Events.MessageBulkDelete, (messages, channel) => {                // messageDeleteBulk :6154
    if (!hooks || !hooks.watches(channel.id)) return;
    for (const id of messages.keys()) hooks.remove(channel.id, id);
  });
```

In the `InteractionCreate` listener, after the closing brace of the `else if (i.isChatInputCommand()) { ... }` branch and before the `else if (i.isModalSubmit())` branch phase 2a added, add:

```ts
      } else if (i.isMessageContextMenuCommand()) {
        // isMessageContextMenuCommand :2214. Deferred and private: the handler
        // deletes files and the answer is for the moderator alone. Only ids
        // are passed on: targetId :1517, CommandInteraction.channelId :643.
        // i.targetMessage, which carries the content, is never read.
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const reply = await handler({
          kind: 'message_command', name: i.commandName, userId: i.user.id, userName: i.user.globalName ?? i.user.username,
          channelId: i.channelId, messageId: i.targetId,
        });
        const m = toMessage(reply.payload);
        await i.editReply({ content: m.content || undefined, embeds: m.embeds, components: m.components as never, allowedMentions: m.allowedMentions });
```

(That is an `else if` inserted in the chain: the `}` that closed the `isChatInputCommand` branch becomes `} else if (i.isMessageContextMenuCommand()) {`, and the block above ends where the existing `} else if (i.isModalSubmit()) {` begins.)

- [ ] **Step 8: discord.js: history, one message, and registration**

In the `threads` object, after `deleteThread`:

```ts
    async fetchAfter(threadId, afterId) {
      const th = await needThread(threadId);
      // MessageManager.fetch(FetchMessagesOptions) :5280, options :6620.
      // `after` returns the messages that come right after that id, up to
      // `limit`, so taking the largest id of each page walks forward through
      // the whole thread. cache: false, a backfill must not fill the cache.
      const page = await th.messages.fetch({ after: afterId ?? '0', limit: 100, cache: false });
      return [...page.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)).map(toInbound);
    },
    async fetchMessage(threadId, messageId) {
      const th = await threadById(threadId);
      if (!th) return null;
      try {
        // MessageManager.fetch(id) :5279. force: the attachment links on a
        // cached copy may have expired, and a fresh link is the whole point.
        return toInbound(await th.messages.fetch({ message: messageId, force: true, cache: false }));
      } catch (err) {
        if (codeOf(err) === UNKNOWN_MESSAGE) return null;
        throw err;
      }
    },
```

Replace the returned `registerCommands` with one that sends both kinds in a single `set`, because `set` replaces everything:

```ts
    async registerCommands(defs: SlashCommandDef[], messageCommands: MessageCommandDef[] = []) {
      await guild.commands.set([
        ...defs.map((d) => ({
          type: ApplicationCommandType.ChatInput as const,
          name: d.name,
          description: d.description,
          options: (d.options ?? []).map((o) => ({
            name: o.name,
            description: o.description,
            required: o.required ?? false,
            type: o.type === 'user' ? ApplicationCommandOptionType.User
              : o.type === 'integer' ? ApplicationCommandOptionType.Integer : ApplicationCommandOptionType.String,
            ...(o.choices ? { choices: o.choices } : {}),
          })) as never,
        })),
        // MessageApplicationCommandData :5613: a type and a name, no
        // description and no options. It shows under Apps on every message in
        // the server, for everyone; the handler is what refuses non-staff.
        ...messageCommands.map((c) => ({ type: ApplicationCommandType.Message as const, name: c.name })),
      ]);
    },
```

Add to the returned object, beside `onInteraction`:

```ts
    watchMessages(h) {
      hooks = h;
    },
```

The command is deliberately not hidden with `defaultMemberPermissions`: moderators are marked on the site, not by a Discord permission, so there is no permission bit that means "staff". Everyone sees the menu entry; only staff get anything but "Staff only." from it.

- [ ] **Step 9: The gate**

Run: `npm run typecheck && npx vitest run tests/fakeMessages.test.ts tests/fakeThreads.test.ts tests/discordBot.test.ts tests/discordAdminFeed.test.ts tests/discordSync.test.ts tests/discordCommands.test.ts tests/ticketSync.test.ts tests/ticketSyncRestricted.test.ts tests/ticketSyncAccess.test.ts tests/ticketButtons.test.ts`
Expected: typecheck clean, tests PASS. The phase 2a suites still pass with snowflake ids on the bot's thread messages: none of them reads an `m<n>` id inside a thread.

`th.messages.fetch({ message: messageId, force: true, cache: false })` is `FetchMessageOptions` (:6616, `message`) over `BaseFetchOptions` (:5962, `cache` and `force`). If a call here does not compile, read the typings and fix the call. Do not reach for `as never`: the point of this gate is that the typings check it.

- [ ] **Step 10: Commit**

```bash
git add src/discord/transport.ts src/discord/index.ts src/discord/djsTransport.ts tests/fakes/fakeTransport.ts tests/fakeMessages.test.ts tests/discordBot.test.ts
git commit -m "Let the bot transport hear messages in ticket threads, read their history and offer a message command"
```

---

### Task 3: The attachment store: what is kept, what is refused, and how it gets to disk

Discord's CDN links are signed and stop working after about a day, so a file is downloaded when its message is mirrored or not at all. This task is the part that decides and downloads; it knows nothing about Discord or about messages. The fetcher is handed in, so no test goes near the network.

The order of the checks is the point. Everything that can be decided from Discord's metadata (the kill switch, the type, the size, both quotas) is decided BEFORE a byte is fetched, and the size cap is enforced again while the bytes arrive, because metadata can lie.

The type is decided by the file's extension and by nothing Discord says about it, and the serving route (Task 6) answers with OUR content type for that extension, `nosniff`, and a sandboxing policy. `jpeg` is treated as `jpg`.

**Files:**
- Create: `src/tickets/attachments.ts`, `tests/ticketAttachments.test.ts`

**Interfaces:**
- Consumes: `storedBytes(db, ticketId?)`, `insertAttachment`, `insertMessage`, `type SkipReason` from `src/tickets/messages.ts` (Task 1); `InboundAttachment` from `src/discord/transport.ts` (Task 2, a type only); `getSetting`; `publishAdminEvent`.
- Produces, in `src/tickets/attachments.ts`:
  - `ALLOWED_TYPES: Record<string, { mime: string; inline: boolean }>` and `allowedType(filename: string): { ext: string; mime: string; inline: boolean } | null`
  - `type AttachmentFetcher = (url: string) => Promise<{ ok: boolean; body: AsyncIterable<Uint8Array> | null }>`
  - `interface SaveResult { size: number; sha256: string | null; storedName: string | null; skipReason: SkipReason | null }`
  - `class AttachmentStore { constructor(deps: { db: DB; dir: string; fetcher: AttachmentFetcher }); readonly dir: string; save(ticketId: number, a: InboundAttachment): Promise<SaveResult> }` (never throws)
  - `attachmentPath(dir: string, storedName: string): string | null`
  - `httpFetcher: AttachmentFetcher` (the real one: https, Discord's two CDN hosts, nothing else)

- [ ] **Step 1: Write the failing test**

`tests/ticketAttachments.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport } from '../src/tickets/filing.js';
import { insertAttachment, insertMessage } from '../src/tickets/messages.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { allowedType, attachmentPath, AttachmentStore, httpFetcher, type AttachmentFetcher } from '../src/tickets/attachments.js';
import type { InboundAttachment } from '../src/discord/transport.js';

const IDS = Array.from({ length: 4 }, (_, i) => `7656119900000000${i}`);
const MB = 1024 * 1024;
let db: DB;
let dir: string;
let root: string;
let calls: string[];
let events: AdminEvent[];
let off: () => void;
let seq = 0;

const bytes = (n: number) => new Uint8Array(n).fill(7);
/** url -> what the CDN answers. 'fail' is a 404, 'throw' is a dead connection. */
const fetcherOf = (map: Record<string, Uint8Array | 'fail' | 'throw'>): AttachmentFetcher => async (url) => {
  calls.push(url);
  const v = map[url];
  if (v === 'throw' || v === undefined) throw new Error('socket hang up');
  if (v === 'fail') return { ok: false, body: null };
  // Two chunks, so the streaming cap is exercised mid-body.
  const half = Math.floor(v.byteLength / 2);
  return { ok: true, body: (async function* () { yield v.subarray(0, half); yield v.subarray(half); })() };
};
const att = (name: string, size: number, url = `https://cdn.discordapp.com/${name}`): InboundAttachment =>
  ({ id: `a${++seq}`, name, contentType: null, size, url });

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of IDS) {
    upsertPlayer(db, { steamid: id, name: `p${id.slice(-1)}`, avatar: null }, []);
    activatePlayer(db, id);
  }
  root = mkdtempSync(join(tmpdir(), 'pug-attach-'));
  // Not made yet on purpose: the store makes it on the first file it keeps.
  dir = join(root, 'ticket-attachments');
  calls = [];
  events = [];
  off = subscribeAdminEvents((e) => events.push(e));
});
afterEach(() => { off(); rmSync(root, { recursive: true, force: true }); });

const ticket = (target: string) => (fileReport(db, IDS[0], { targetId: target, category: 'griefing', text: 'x' }, { adminSteamIds: [] }) as { ticketId: number }).ticketId;
/** Save, and record the outcome the way the mirror does, so quotas count it. */
async function keep(store: AttachmentStore, ticketId: number, a: InboundAttachment) {
  const r = await store.save(ticketId, a);
  const m = insertMessage(db, {
    ticketId, threadId: '9001', channel: 'staff', discordMessageId: `d${++seq}`, authorDiscordId: '906', authorPlayerId: null,
    authorName: 'x', content: '', createdAt: '2026-09-22T10:00:00.000Z',
  })!;
  insertAttachment(db, { messageId: m.id, discordAttachmentId: a.id, filename: a.name, contentType: '', size: r.size, sha256: r.sha256, storedName: r.storedName, skipReason: r.skipReason });
  return r;
}
const onDisk = () => (existsSync(dir) ? readdirSync(dir) : []);

describe('what is kept', () => {
  it('stores an allowed file under a random name with its hash, and nothing about it in the name', async () => {
    const body = bytes(1000);
    const a = att('Proof Of It.PNG', 1000);
    const store = new AttachmentStore({ db, dir, fetcher: fetcherOf({ [a.url]: body }) });
    const r = await store.save(ticket(IDS[1]), a);
    expect(r).toMatchObject({ size: 1000, skipReason: null, sha256: createHash('sha256').update(body).digest('hex') });
    expect(r.storedName).toMatch(/^[0-9a-f]{32}$/);
    expect(onDisk()).toEqual([r.storedName]);
    expect(readFileSync(attachmentPath(dir, r.storedName!)!)).toEqual(Buffer.from(body));
  });

  it('knows its eight types by extension, whatever the case, and jpeg as jpg', () => {
    expect(['a.png', 'a.jpg', 'a.gif', 'a.webp', 'a.mp4', 'a.webm', 'a.mov', 'a.txt'].map((n) => allowedType(n)?.ext))
      .toEqual(['png', 'jpg', 'gif', 'webp', 'mp4', 'webm', 'mov', 'txt']);
    expect(allowedType('photo.JPEG')).toMatchObject({ ext: 'jpg', mime: 'image/jpeg', inline: true });
    expect(allowedType('notes.txt')).toMatchObject({ inline: false });
    for (const n of ['run.exe', 'page.html', 'pic.svg', 'archive.zip', 'noextension', 'trick.png.exe']) expect(allowedType(n)).toBeNull();
  });
});

describe('what is refused, before anything is downloaded', () => {
  it('a type that is not allowed', async () => {
    const store = new AttachmentStore({ db, dir, fetcher: fetcherOf({}) });
    expect(await store.save(ticket(IDS[1]), att('payload.exe', 10))).toEqual({ size: 10, sha256: null, storedName: null, skipReason: 'type' });
    expect(calls).toEqual([]);
  });

  it('a file Discord says is too large', async () => {
    setSetting(db, 'ticket_attachment_max_mb', '1');
    const store = new AttachmentStore({ db, dir, fetcher: fetcherOf({}) });
    expect((await store.save(ticket(IDS[1]), att('long.mp4', 2 * MB))).skipReason).toBe('too_large');
    expect(calls).toEqual([]);
  });

  it('everything, with the kill switch off', async () => {
    setSetting(db, 'ticket_store_attachments', '0');
    const store = new AttachmentStore({ db, dir, fetcher: fetcherOf({}) });
    expect((await store.save(ticket(IDS[1]), att('fine.png', 10))).skipReason).toBe('disabled');
    expect(calls).toEqual([]);
  });

  it('a file that would take its ticket past the per ticket quota, without telling the admins', async () => {
    setSetting(db, 'ticket_attachments_ticket_mb', '1');
    const a = att('one.png', 600 * 1024);
    const b = att('two.png', 600 * 1024);
    const store = new AttachmentStore({ db, dir, fetcher: fetcherOf({ [a.url]: bytes(600 * 1024), [b.url]: bytes(600 * 1024) }) });
    const id = ticket(IDS[1]);
    expect((await keep(store, id, a)).skipReason).toBeNull();
    expect((await keep(store, id, b)).skipReason).toBe('quota');
    expect(calls).toEqual([a.url]);
    expect(events).toEqual([]);
  });

  it('past the overall cap nothing new is stored, and the admins are told once, with no file named', async () => {
    setSetting(db, 'ticket_attachments_total_mb', '1');
    const a = att('one.png', 600 * 1024);
    const b = att('secret-name.png', 600 * 1024);
    const c = att('three.png', 600 * 1024);
    const store = new AttachmentStore({ db, dir, fetcher: fetcherOf({ [a.url]: bytes(600 * 1024) }) });
    expect((await keep(store, ticket(IDS[1]), a)).skipReason).toBeNull();
    expect((await keep(store, ticket(IDS[2]), b)).skipReason).toBe('quota');
    expect((await keep(store, ticket(IDS[3]), c)).skipReason).toBe('quota');
    const problems = events.filter((e) => e.kind === 'problem');
    expect(problems).toHaveLength(1);
    expect(JSON.stringify(problems[0])).toMatch(/attachment/i);
    expect(JSON.stringify(problems[0])).not.toContain('secret-name');
  });
});

describe('what goes wrong while downloading', () => {
  it('a body bigger than Discord said is cut off at the cap, and nothing is left on disk', async () => {
    setSetting(db, 'ticket_attachment_max_mb', '1');
    const a = att('liar.png', 10);
    const store = new AttachmentStore({ db, dir, fetcher: fetcherOf({ [a.url]: bytes(2 * MB) }) });
    expect((await store.save(ticket(IDS[1]), a)).skipReason).toBe('too_large');
    expect(onDisk()).toEqual([]);
  });

  it('a refused or broken download is fetch_failed, never a throw, and leaves nothing behind', async () => {
    const a = att('gone.png', 10);
    const b = att('dead.png', 10);
    const store = new AttachmentStore({ db, dir, fetcher: fetcherOf({ [a.url]: 'fail', [b.url]: 'throw' }) });
    const id = ticket(IDS[1]);
    expect((await store.save(id, a)).skipReason).toBe('fetch_failed');
    expect((await store.save(id, b)).skipReason).toBe('fetch_failed');
    expect(onDisk()).toEqual([]);
  });
});

describe('the two guards around the file system and the network', () => {
  it('a stored name is 32 hex characters or it is not a path', () => {
    expect(attachmentPath('/srv/files', 'a'.repeat(32))).toBe('/srv/files/' + 'a'.repeat(32));
    for (const bad of ['../pug.db', 'a'.repeat(31), `${'a'.repeat(32)}/x`, '']) expect(attachmentPath('/srv/files', bad)).toBeNull();
  });

  it('the real fetcher refuses anything that is not https on Discord\'s CDN, without touching the network', async () => {
    for (const url of ['https://example.com/x.png', 'http://cdn.discordapp.com/x.png', 'https://cdn.discordapp.com.evil.test/x.png', 'file:///etc/passwd', 'nonsense']) {
      expect(await httpFetcher(url)).toEqual({ ok: false, body: null });
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/ticketAttachments.test.ts`
Expected: FAIL, cannot resolve `../src/tickets/attachments.js`.

- [ ] **Step 3: The store**

`src/tickets/attachments.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DB } from '../db.js';
import { publishAdminEvent } from '../adminFeed.js';
import { getSetting } from '../settings.js';
import type { InboundAttachment } from '../discord/transport.js';
import { storedBytes, type SkipReason } from './messages.js';

/**
 * The only files a ticket keeps, by extension. `mime` is what the serving
 * route answers with, whatever Discord or the uploader claimed; `inline` is
 * whether a browser may show it in place. Everything else is recorded (name,
 * type, size) and not stored. No svg and no html: both can carry script.
 */
export const ALLOWED_TYPES: Record<string, { mime: string; inline: boolean }> = {
  png: { mime: 'image/png', inline: true },
  jpg: { mime: 'image/jpeg', inline: true },
  gif: { mime: 'image/gif', inline: true },
  webp: { mime: 'image/webp', inline: true },
  mp4: { mime: 'video/mp4', inline: true },
  webm: { mime: 'video/webm', inline: true },
  mov: { mime: 'video/quicktime', inline: true },
  txt: { mime: 'text/plain; charset=utf-8', inline: false },
};

/** By the LAST extension, so `trick.png.exe` is an exe. */
export function allowedType(filename: string): { ext: string; mime: string; inline: boolean } | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(filename);
  const raw = m ? m[1].toLowerCase() : '';
  const ext = raw === 'jpeg' ? 'jpg' : raw;
  const t = ALLOWED_TYPES[ext];
  return t ? { ext, ...t } : null;
}

/** Fetch a URL's bytes. Injected, so tests never touch the network. */
export type AttachmentFetcher = (url: string) => Promise<{ ok: boolean; body: AsyncIterable<Uint8Array> | null }>;

export interface SaveResult {
  /** Bytes written when stored; otherwise what Discord said the size was. */
  size: number;
  sha256: string | null;
  storedName: string | null;
  skipReason: SkipReason | null;
}

/** Where a stored file is, or null for a name this module did not make. The
 *  name comes out of the database, and this is what stands between a bad row
 *  and a path outside the directory. */
export function attachmentPath(dir: string, storedName: string): string | null {
  return /^[0-9a-f]{32}$/.test(storedName) ? join(dir, storedName) : null;
}

class TooLarge extends Error {}

const mb = (db: DB, key: string, fallback: number): number => Number(getSetting(db, key) ?? fallback) * 1024 * 1024;

export class AttachmentStore {
  /** The overall cap is reported once, not once per refused file. It is
   *  reported again if space was freed and then ran out again. */
  private capReported = false;

  constructor(private deps: { db: DB; dir: string; fetcher: AttachmentFetcher }) {}

  get dir(): string {
    return this.deps.dir;
  }

  /** Decide, download, hash and store one file. Never throws: every way this
   *  can go wrong is a skip reason the ticket page shows. */
  async save(ticketId: number, a: InboundAttachment): Promise<SaveResult> {
    const { db, dir, fetcher } = this.deps;
    const skip = (skipReason: SkipReason): SaveResult => ({ size: a.size, sha256: null, storedName: null, skipReason });

    // Everything that can be decided from metadata, before a byte is fetched.
    if (getSetting(db, 'ticket_store_attachments') === '0') return skip('disabled');
    if (!allowedType(a.name)) return skip('type');
    const maxBytes = mb(db, 'ticket_attachment_max_mb', 25);
    if (a.size > maxBytes) return skip('too_large');
    if (storedBytes(db, ticketId) + a.size > mb(db, 'ticket_attachments_ticket_mb', 200)) return skip('quota');
    if (storedBytes(db) + a.size > mb(db, 'ticket_attachments_total_mb', 2048)) {
      if (!this.capReported) {
        this.capReported = true;
        // Names no ticket and no file: every admin reads the feed.
        publishAdminEvent({ kind: 'problem', text: 'Ticket attachment storage is full, so new files posted in ticket threads are recorded but not stored. Raise "Attachment space overall" in Settings, or remove messages that no longer matter.' });
      }
      return skip('quota');
    }
    this.capReported = false;

    const storedName = randomBytes(16).toString('hex');
    const final = join(dir, storedName);
    const part = `${final}.part`;
    const hash = createHash('sha256');
    let size = 0;
    try {
      const res = await fetcher(a.url);
      if (!res.ok || !res.body) return skip('fetch_failed');
      const body = res.body;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // The cap again, on the bytes themselves: the size above is what
      // Discord said, and this is what actually arrived.
      const capped = async function* (): AsyncGenerator<Uint8Array> {
        for await (const chunk of body) {
          size += chunk.byteLength;
          if (size > maxBytes) throw new TooLarge();
          hash.update(chunk);
          yield chunk;
        }
      };
      await pipeline(Readable.from(capped()), createWriteStream(part, { mode: 0o600 }));
      renameSync(part, final);
      return { size, sha256: hash.digest('hex'), storedName, skipReason: null };
    } catch (err) {
      rmSync(part, { force: true });
      if (err instanceof TooLarge) return skip('too_large');
      // The message only: the URL carries a signature and stays out of logs.
      console.error('[tickets] an attachment download failed:', err instanceof Error ? err.message : err);
      return skip('fetch_failed');
    }
  }
}

const CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

/** The real fetcher. It will only ever dial Discord's CDN over https, and
 *  follows no redirect: the URL comes out of a Discord payload, and this is
 *  what keeps a surprise in one from becoming a request to somewhere else. */
export const httpFetcher: AttachmentFetcher = async (url) => {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, body: null };
  }
  if (u.protocol !== 'https:' || !CDN_HOSTS.has(u.hostname)) return { ok: false, body: null };
  const res = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  return { ok: res.ok, body: res.body as unknown as AsyncIterable<Uint8Array> | null };
};
```

- [ ] **Step 4: Run**

Run: `npx vitest run tests/ticketAttachments.test.ts && npm run typecheck`
Expected: PASS, typecheck clean. After the run, `git status --short data/` prints nothing: no test wrote into the repo's `data/` directory.

- [ ] **Step 5: Commit**

```bash
git add src/tickets/attachments.ts tests/ticketAttachments.test.ts
git commit -m "Store ticket attachments on disk under random names, within type, size and space limits"
```

---

### Task 4: A nudge that only staff who can see the ticket receive

`hub.broadcast('refresh')` goes to every open browser, and every browser answers it by refetching. That is fine for the queue. It is not fine for ticket chat: the accused's browser would stir every time staff wrote about them. So chat updates get their own event, `tickets`, and it is sent only to sockets whose signed-in user is active staff AND can see the ticket that changed.

The hub cannot do that today, because it does not know whose socket is whose. The smallest change that lets it: the `/ws` route reads the same signed session cookie every other route reads and hands the steamid to `hub.add`. Who may hear an event is then asked per send, against the database, so a demotion or a removal from an access list takes effect at once. The event carries a name and nothing else, as `refresh` does.

The nudge is driven by the ticket signal phase 2a already publishes after every ticket mutation and filing, so this also gives the ticket page the live refresh phase 1 left for later, with no route touched. Task 5 calls the same function when a message is mirrored.

**Files:**
- Create: `src/tickets/nudge.ts`, `tests/ticketNudge.test.ts`, `web/src/hooks/useTicketNudge.ts`
- Modify: `src/ws.ts`, `src/routes/ws.ts`, `src/server.ts`, `tests/ws.test.ts`, `web/src/hooks/useLiveState.ts`, `web/src/routes/admin/AdminTicket.tsx`, `web/src/routes/admin/AdminTickets.tsx`, `web/src/routes/tickets.test.tsx`

**Interfaces:**
- Consumes: `getSession(req)` from `src/session.ts`; `getTicketRow`, `canSeeTicket` from `src/tickets/store.ts`; `getPlayer` from `src/players.ts`; `subscribeTicketSignals` (phase 2a Task 2); `useFetch`'s `reload`.
- Produces:
  - `Hub.add(socket, steamid?: string | null): void` and `Hub.sendTo(event: string, allow: (steamid: string) => boolean): void`
  - `src/tickets/nudge.ts`: `ticketNudger(db: DB, hub: Hub): (ticketId: number) => void`
  - In `buildServer`: a local `nudgeTicket`, subscribed to ticket signals, which Task 5 also hands to the mirror.
  - `web/src/hooks/useTicketNudge.ts`: `TICKETS_EVENT = 'pug:tickets'`, `eventName(data: unknown): string | null`, `useTicketNudge(fn: () => void): void`

- [ ] **Step 1: Write the failing tests**

Add to `tests/ws.test.ts`, inside `describe('Hub', ...)`:

```ts
  it('sendTo reaches only signed-in sockets the caller allows, asks once per user, and tells no subscriber', () => {
    const hub = new Hub();
    const staff = fakeSocket();
    const staffSecondTab = fakeSocket();
    const player = fakeSocket();
    const anonymous = fakeSocket();
    hub.add(staff as any, 'S');
    hub.add(staffSecondTab as any, 'S');
    hub.add(player as any, 'P');
    hub.add(anonymous as any);
    const heard: string[] = [];
    hub.subscribe((e) => heard.push(e));
    const asked: string[] = [];
    hub.sendTo('tickets', (id) => { asked.push(id); return id === 'S'; });
    expect(staff.sent).toEqual(['{"event":"tickets"}']);
    expect(staffSecondTab.sent).toEqual(['{"event":"tickets"}']);
    expect(player.sent).toEqual([]);
    expect(anonymous.sent).toEqual([]);
    expect(asked.sort()).toEqual(['P', 'S']);
    expect(heard).toEqual([]);
    hub.broadcast('refresh');
    expect(anonymous.sent).toEqual(['{"event":"refresh"}']);
  });
```

`tests/ticketNudge.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { SESSION_COOKIE } from '../src/session.js';
import { Hub } from '../src/ws.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { fileReport } from '../src/tickets/filing.js';
import { ticketNudger } from '../src/tickets/nudge.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 7 }, (_, i) => `7656119900000000${i}`);
const [R1, PLAYER, ACCUSED, STAFF_ACCUSED, MOD, ADMIN, OWNER] = IDS;
let db: DB;

const sock = () => {
  const sent: string[] = [];
  return { sent, readyState: 1, send: (m: string) => sent.push(m) };
};
const file = (targetId: string, category = 'griefing') =>
  (fileReport(db, R1, { targetId, category, text: 'x' }, { adminSteamIds: [OWNER] }) as { ticketId: number }).ticketId;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of IDS) {
    upsertPlayer(db, { steamid: id, name: `p${id.slice(-1)}`, avatar: null }, []);
    activatePlayer(db, id);
  }
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid IN (?, ?)').run(MOD, STAFF_ACCUSED);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid IN (?, ?)').run(ADMIN, OWNER);
});

describe('who hears that a ticket changed', () => {
  it('staff who can see it, and nobody else', () => {
    const hub = new Hub();
    const s = Object.fromEntries(IDS.map((id) => [id, sock()]));
    for (const id of IDS) hub.add(s[id] as any, id);
    const nudge = ticketNudger(db, hub);
    const heard = () => IDS.filter((id) => s[id].sent.length > 0);
    const reset = () => { for (const id of IDS) s[id].sent.length = 0; };

    nudge(file(ACCUSED));
    expect(heard()).toEqual([STAFF_ACCUSED, MOD, ADMIN, OWNER]);
    expect(s[MOD].sent).toEqual(['{"event":"tickets"}']);

    reset();
    nudge(file(ACCUSED, 'unsafe'));
    expect(heard()).toEqual([OWNER]);

    // A ticket about a member of staff: restricted, and never the accused.
    reset();
    nudge(file(STAFF_ACCUSED));
    expect(heard()).toEqual([OWNER]);

    // A banned moderator stops hearing at once, on the socket they still hold.
    reset();
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(MOD);
    nudge(1);
    expect(heard()).toEqual([STAFF_ACCUSED, ADMIN, OWNER]);

    reset();
    nudge(9999);
    expect(heard()).toEqual([]);
  });
});

describe('over a real socket', () => {
  let app: FastifyInstance;
  afterEach(async () => { await app.close(); });

  it('the socket is who its cookie says, and filing a report nudges staff only', async () => {
    app = await buildServer({ config: loadConfig({ ADMIN_STEAMIDS: OWNER }), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
    await app.ready();
    const open = async (steamid: string | null) => {
      const got: string[] = [];
      const headers = steamid ? { cookie: `${SESSION_COOKIE}=${encodeURIComponent(authedCookie(app, db, steamid)[SESSION_COOKIE])}` } : {};
      const ws = await app.injectWS('/ws', { headers });
      ws.on('message', (d) => got.push(String(d)));
      return { ws, got };
    };
    const mod = await open(MOD);
    const accused = await open(ACCUSED);
    const stranger = await open(null);
    const r = await app.inject({ method: 'POST', url: '/api/reports', cookies: authedCookie(app, db, R1), payload: { targetId: ACCUSED, category: 'afk', text: '' } });
    expect(r.statusCode).toBe(200);
    await vi.waitFor(() => expect(mod.got).toContain('{"event":"tickets"}'));
    await vi.waitFor(() => expect(accused.got).toContain('{"event":"refresh"}'));
    expect(accused.got).not.toContain('{"event":"tickets"}');
    expect(stranger.got).not.toContain('{"event":"tickets"}');
    for (const c of [mod, accused, stranger]) c.ws.terminate();
  });
});
```

Add to `web/src/routes/tickets.test.tsx`. Widen the import at the top with `import { eventName, TICKETS_EVENT } from '../hooks/useTicketNudge';` and add inside `describe('the Tickets tab', ...)`:

```tsx
  it('refetches the open ticket when the staff nudge arrives, and only knows a well formed frame', async () => {
    history.replaceState(null, '', '/admin?ticket=12');
    render(<Admin session={{ kind: 'active', me: mod }} />);
    await screen.findByText('saw me through a wall');
    expect(mockMod.ticket).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event(TICKETS_EVENT));
    await waitFor(() => expect(mockMod.ticket).toHaveBeenCalledTimes(2));
    expect(eventName('{"event":"tickets"}')).toBe('tickets');
    expect(eventName('{"event":7}')).toBeNull();
    expect(eventName('not json')).toBeNull();
    expect(eventName(new ArrayBuffer(2))).toBeNull();
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/ws.test.ts tests/ticketNudge.test.ts web/src/routes/tickets.test.tsx`
Expected: FAIL. `hub.sendTo` is not a function; `../src/tickets/nudge.js` and `../hooks/useTicketNudge` do not resolve.

- [ ] **Step 3: The hub knows whose socket is whose**

`src/ws.ts`. Replace the `sockets` field, `add` and `remove`, and the socket loop at the end of `broadcast`, and add `sendTo`:

```ts
export class Hub {
  /** socket -> the steamid its session cookie named when it connected, or
   *  null for a browser that was not signed in. */
  private sockets = new Map<SocketLike, string | null>();

  add(socket: SocketLike, steamid: string | null = null): void {
    this.sockets.set(socket, steamid);
  }

  remove(socket: SocketLike): void {
    this.sockets.delete(socket);
  }
```

```ts
    const msg = JSON.stringify({ event });
    for (const s of this.sockets.keys()) {
      if (s.readyState === OPEN) s.send(msg);
    }
  }

  /**
   * An event for some browsers only. `allow` is asked per signed-in user at
   * the moment of sending, once per user however many tabs they have, so it
   * can read the database and a demotion takes effect on the next event. A
   * socket that was not signed in when it connected never receives one.
   *
   * In-process subscribers do NOT hear it: they hear what everyone hears,
   * and this is by definition not that.
   *
   * The steamid is the one the cookie named at connect time. Someone who
   * signs out keeps their socket until the page reloads, which is why
   * `allow` must check the account as it is now, not trust that it was
   * staff when it connected.
   */
  sendTo(event: string, allow: (steamid: string) => boolean): void {
    const msg = JSON.stringify({ event });
    const verdict = new Map<string, boolean>();
    for (const [s, steamid] of this.sockets) {
      if (steamid === null || s.readyState !== OPEN) continue;
      let ok = verdict.get(steamid);
      if (ok === undefined) {
        ok = allow(steamid);
        verdict.set(steamid, ok);
      }
      if (ok) s.send(msg);
    }
  }
}
```

`src/routes/ws.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { Hub } from '../ws.js';
import { getSession } from '../session.js';

export async function wsRoutes(app: FastifyInstance, opts: { hub: Hub }): Promise<void> {
  app.get('/ws', { websocket: true }, (socket, req) => {
    // The same signed cookie every route reads. Null for a browser that is
    // not signed in, which still gets every broadcast and no targeted event.
    opts.hub.add(socket, getSession(req));
    socket.on('close', () => opts.hub.remove(socket));
    socket.on('error', () => opts.hub.remove(socket));
  });
}
```

`@fastify/cookie` is registered before `@fastify/websocket` in `buildServer` (locate by `await app.register(cookie, { secret: deps.config.cookieSecret });`), so `req.cookies` and `req.unsignCookie` exist on the upgrade request.

- [ ] **Step 4: Who is told**

`src/tickets/nudge.ts`:

```ts
import type { DB } from '../db.js';
import type { Hub } from '../ws.js';
import { getPlayer } from '../players.js';
import { canSeeTicket, getTicketRow } from './store.js';

/**
 * "This ticket changed: refetch it", to the browsers of people who may see
 * that ticket and to no others.
 *
 * hub.broadcast('refresh') reaches every open browser, the accused's
 * included, and every browser answers it with a refetch. A ticket's chat must
 * never ride that. This sends 'tickets' only to sockets whose user is, right
 * now, an active moderator or admin who passes canSeeTicket: the same rule
 * every read path uses, so the accused and anyone off a restricted ticket's
 * list hear nothing, not even that something happened.
 *
 * The event is a name and nothing else. A ticket that no longer exists (it
 * was folded into another) is told to nobody.
 */
export function ticketNudger(db: DB, hub: Hub): (ticketId: number) => void {
  return (ticketId) => {
    const t = getTicketRow(db, ticketId);
    if (!t) return;
    hub.sendTo('tickets', (steamid) => {
      const p = getPlayer(db, steamid);
      return !!p && p.status === 'active' && (p.is_admin === 1 || p.is_mod === 1) && canSeeTicket(db, t, steamid);
    });
  };
}
```

`src/server.ts`. Add the imports:

```ts
import { ticketNudger } from './tickets/nudge.js';
import { subscribeTicketSignals } from './tickets/signals.js';
```

Directly after `await app.register(wsRoutes, { hub });`:

```ts
  // Every ticket mutation and every filing publishes a ticket signal after
  // its commit (phase 2a). Open ticket pages of people who may see that
  // ticket refetch on it; nobody else hears a thing.
  const nudgeTicket = ticketNudger(deps.db, hub);
  const offTicketNudge = subscribeTicketSignals((s) => {
    if (s.kind === 'ticket') nudgeTicket(s.ticketId);
  });
```

and in the `onClose` hook, before `adminFeed?.stop();`:

```ts
    offTicketNudge();
```

- [ ] **Step 5: The browser side**

`web/src/hooks/useTicketNudge.ts`:

```ts
import { useEffect, useRef } from 'preact/hooks';

/** What the one websocket (useLiveState) raises on `window` when the server
 *  says a ticket this viewer may see has changed. */
export const TICKETS_EVENT = 'pug:tickets';

/** The event name inside a websocket frame, or null for anything unreadable. */
export function eventName(data: unknown): string | null {
  if (typeof data !== 'string') return null;
  try {
    const v = JSON.parse(data) as { event?: unknown };
    return typeof v.event === 'string' ? v.event : null;
  } catch {
    return null;
  }
}

/** Call `fn` whenever that happens. The server only sends the event to staff
 *  who can see the ticket, so there is nothing to filter here. */
export function useTicketNudge(fn: () => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const h = () => ref.current();
    window.addEventListener(TICKETS_EVENT, h);
    return () => window.removeEventListener(TICKETS_EVENT, h);
  }, []);
}
```

`web/src/hooks/useLiveState.ts`. Add `import { eventName, TICKETS_EVENT } from './useTicketNudge';` and replace the line `ws.onmessage = () => refreshRef.current();` with:

```ts
      ws.onmessage = (m) => {
        // 'tickets' is for ticket pages, goes only to staff, and says nothing
        // about the queue: pass it on and leave the live state alone.
        if (eventName(m.data) === 'tickets') {
          window.dispatchEvent(new Event(TICKETS_EVENT));
          return;
        }
        refreshRef.current();
      };
```

`web/src/routes/admin/AdminTicket.tsx`: add `import { useTicketNudge } from '../../hooks/useTicketNudge';` and, directly after the `useAction` line:

```tsx
  useTicketNudge(reload);
```

`web/src/routes/admin/AdminTickets.tsx`: the same import, and directly after the `useFetch` line:

```tsx
  useTicketNudge(reload);
```

(`useFetch` keeps the data it has while a reload is in flight, so the page does not flash.)

- [ ] **Step 6: Run**

Run: `npx vitest run tests/ws.test.ts tests/ticketNudge.test.ts tests/ticketRoutes.test.ts web/src/routes/tickets.test.tsx && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/ws.ts src/routes/ws.ts src/tickets/nudge.ts src/server.ts tests/ws.test.ts tests/ticketNudge.test.ts web/src/hooks/useTicketNudge.ts web/src/hooks/useLiveState.ts web/src/routes/admin/AdminTicket.tsx web/src/routes/admin/AdminTickets.tsx web/src/routes/tickets.test.tsx
git commit -m "Tell only staff who can see a ticket that it changed, and refetch the ticket page when they are told"
```

---

### Task 5: The mirror: create, edit, delete, backfill, and files

`TicketMirror` copies what people write in ticket threads into `ticket_messages`. Like `TicketSync` it does its work on one chain of promises, so a message, its edit and its deletion are applied in the order they happened, and a backfill never interleaves with a live event.

The rules, each of which has a test below:
- Only a thread listed in `ticket_threads` is read. The transport asks first (Task 2), and the mirror looks the thread up again before it reads anything off the message, so a bug in either place alone cannot leak a conversation into a ticket.
- Bot-authored messages are not mirrored: the timeline already has the events they describe.
- An unknown Discord author is stored with the Discord name and no player link. Never rejected.
- An edit pushes the previous content onto `history`. A delete in Discord is soft.
- Backfill runs on every bot start, for every open, unlocked thread, fetching after the last stored id, a page at a time. It also runs for one ticket whenever that ticket's signal fires, which covers "when a thread is reopened" and costs one cheap REST call per ticket action.
- A failed attachment download is recorded as `fetch_failed` and retried by the next backfill, which fetches the message again for a freshly signed link.

What a backfill cannot see: an EDIT or a DELETE that happened while the bot was down, to a message that was already stored. Discord has no "changes since" call. The stored content stays as it was last seen. This is written down in the closing section.

**Files:**
- Create: `src/discord/ticketMirror.ts`, `tests/ticketMirror.test.ts`
- Modify: `src/server.ts` (start it with the bot)

**Interfaces:**
- Consumes: `watchMessages`, `threads.fetchAfter`, `threads.fetchMessage`, `InboundMessage`, `InboundAttachment` (Task 2); `AttachmentStore`, `httpFetcher` (Task 3); `insertMessage`, `recordEdit`, `markDeleted`, `lastMessageId`, `messageByDiscordId`, `insertAttachment`, `updateAttachment`, `attachmentsOf` (Task 1); `threadByDiscordId`, `ThreadRow` (phase 2a); `subscribeTicketSignals` (phase 2a); `playerByDiscordId`; `nudgeTicket` in `buildServer` (Task 4).
- Produces, in `src/discord/ticketMirror.ts`:
  - `interface TicketMirrorDeps { db: DB; transport: BotTransport; store: AttachmentStore; onChange?: (ticketId: number) => void }`
  - `class TicketMirror` with `start(): void`, `stop(): void`, `idle(): Promise<void>`, `backfill(): Promise<void>` (never throws). Task 7 adds `sweepRemovals()` and `removeInDiscord()`.

- [ ] **Step 1: Write the failing test**

`tests/ticketMirror.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { fileReport } from '../src/tickets/filing.js';
import { closeTicket, reopenTicket } from '../src/tickets/actions.js';
import { insertThread, setThreadLocked, threadByDiscordId } from '../src/tickets/threads.js';
import { attachmentsOf, messageByDiscordId, type MessageRow } from '../src/tickets/messages.js';
import { AttachmentStore, type AttachmentFetcher } from '../src/tickets/attachments.js';
import { TicketMirror } from '../src/discord/ticketMirror.js';
import type { InboundMessage } from '../src/discord/transport.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const MOD = IDS[6];
const ADMIN = IDS[7];
let db: DB;
let t: FakeTransport;
let mirror: TicketMirror;
let root: string;
let dir: string;
let cdn: Record<string, Uint8Array | 'fail'>;
let nudged: number[];

const fetcher: AttachmentFetcher = async (url) => {
  const v = cdn[url];
  if (v === undefined || v === 'fail') return { ok: false, body: null };
  return { ok: true, body: (async function* () { yield v; })() };
};
const card = (content: string) => ({ content, embeds: [], components: [] });
const all = () => db.prepare('SELECT * FROM ticket_messages ORDER BY id').all() as MessageRow[];

beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []);
    activatePlayer(db, id);
    linkDiscord(db, id, `90${i}`, `d${i}`);
  });
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  root = mkdtempSync(join(tmpdir(), 'pug-mirror-'));
  dir = join(root, 'ticket-attachments');
  cdn = {};
  nudged = [];
  t = new FakeTransport();
  mirror = new TicketMirror({ db, transport: t, store: new AttachmentStore({ db, dir, fetcher }), onChange: (id) => nudged.push(id) });
});
afterEach(() => { mirror.stop(); rmSync(root, { recursive: true, force: true }); });

const file = (targetId: string) => (fileReport(db, IDS[0], { targetId, category: 'griefing', text: 'x' }, { adminSteamIds: [ADMIN] }) as { ticketId: number }).ticketId;
/** A ticket with a staff thread that exists in the fake and in ticket_threads. */
async function ticketWithThread(targetId: string): Promise<{ id: number; thread: string }> {
  const id = file(targetId);
  const made = await t.threads.createForumPost('forum1', { name: `#${id}`, message: card('the card'), tags: [] });
  insertThread(db, { ticketId: id, kind: 'staff', surface: 'forum', channelId: 'forum1', threadId: made.threadId, cardMessageId: made.messageId, cardHash: 'h' });
  return { id, thread: made.threadId };
}

describe('live', () => {
  it('mirrors a message, its edit and its deletion, in order, and nudges the ticket each time', async () => {
    const { id, thread } = await ticketWithThread(IDS[5]);
    mirror.start();
    const m = t.userPost(thread, { authorId: '906', authorName: 'Mod on Discord', content: 'first' });
    t.userEdit(m.id, 'second');
    t.userDelete(m.id);
    await mirror.idle();
    expect(all()).toHaveLength(1);
    expect(all()[0]).toMatchObject({
      ticket_id: id, thread_id: thread, channel: 'staff', discord_message_id: m.id, author_discord_id: '906',
      author_player_id: MOD, author_name: 'Mod on Discord', content: 'second', discord_gone: 1,
    });
    expect(JSON.parse(all()[0].history)).toEqual(['first']);
    expect(all()[0].deleted_at).not.toBeNull();
    expect(nudged).toEqual([id, id, id]);
  });

  it('stores an author nobody on the site knows under their Discord name, with no player', async () => {
    const { thread } = await ticketWithThread(IDS[5]);
    mirror.start();
    t.userPost(thread, { authorId: '555', authorName: 'A Stranger', content: 'hello' });
    await mirror.idle();
    expect(all()[0]).toMatchObject({ author_discord_id: '555', author_player_id: null, author_name: 'A Stranger' });
  });

  it('does not mirror the bot, a webhook or a system line', async () => {
    const { thread } = await ticketWithThread(IDS[5]);
    mirror.start();
    t.userPost(thread, { authorId: 'bot', content: 'Another report: cheating', bot: true });
    await t.send(thread, card('a line the bot sent'));
    await mirror.idle();
    expect(all()).toEqual([]);
    expect(nudged).toEqual([]);
  });

  it('reads nothing from a thread that is not a ticket, whoever delivers it', async () => {
    const { thread } = await ticketWithThread(IDS[5]);
    mirror.start();
    // The transport asks first, so this is never delivered...
    t.userPost('general-chat', { authorId: '906', content: 'none of our business' });
    // ...and a transport that forgot to ask still gets nowhere: the mirror
    // looks the thread up before it reads a single field off the message.
    let read = false;
    const trap = {
      id: '999999', threadId: 'general-chat', authorId: '906', authorName: 'x', authorIsBot: false,
      get content() { read = true; return 'secret'; }, attachments: [], createdAt: '2026-09-22T10:00:00.000Z', editedAt: null,
    } as InboundMessage;
    t.hooks!.create(trap);
    t.hooks!.update(trap);
    await mirror.idle();
    expect(read).toBe(false);
    expect(all()).toEqual([]);
    expect(t.hooks!.watches(thread)).toBe(true);
    expect(t.hooks!.watches('general-chat')).toBe(false);
  });

  it('a message delivered twice is one message', async () => {
    const { thread } = await ticketWithThread(IDS[5]);
    mirror.start();
    const m = t.userPost(thread, { authorId: '906', content: 'once' });
    t.hooks!.create(m);
    await mirror.idle();
    await mirror.backfill();
    expect(all()).toHaveLength(1);
  });
});

describe('files', () => {
  it('stores an allowed file on disk and records a refused one without storing it', async () => {
    const { thread } = await ticketWithThread(IDS[5]);
    mirror.start();
    cdn['https://cdn.discordapp.com/1/shot.png'] = new Uint8Array(64).fill(1);
    const m = t.userPost(thread, { authorId: '906', content: 'look', attachments: [
      { id: 'a1', name: 'shot.png', contentType: 'image/png', size: 64, url: 'https://cdn.discordapp.com/1/shot.png' },
      { id: 'a2', name: 'tool.exe', contentType: 'application/x-msdownload', size: 9000, url: 'https://cdn.discordapp.com/1/tool.exe' },
    ] });
    await mirror.idle();
    const rows = attachmentsOf(db, messageByDiscordId(db, m.id)!.id);
    expect(rows.map((r) => [r.filename, r.discord_attachment_id, r.size, r.skip_reason, r.stored_name !== null])).toEqual([
      ['shot.png', 'a1', 64, null, true], ['tool.exe', 'a2', 9000, 'type', false],
    ]);
    expect(rows[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readdirSync(dir)).toEqual([rows[0].stored_name]);
  });

  it('a download that failed is tried again by the next backfill, with a fresh link', async () => {
    const { thread } = await ticketWithThread(IDS[5]);
    mirror.start();
    const url = 'https://cdn.discordapp.com/1/clip.mp4';
    cdn[url] = 'fail';
    const m = t.userPost(thread, { authorId: '906', content: '', attachments: [{ id: 'a1', name: 'clip.mp4', contentType: 'video/mp4', size: 32, url }] });
    await mirror.idle();
    const row = () => attachmentsOf(db, messageByDiscordId(db, m.id)!.id)[0];
    expect(row()).toMatchObject({ skip_reason: 'fetch_failed', stored_name: null });
    cdn[url] = new Uint8Array(32).fill(2);
    await mirror.backfill();
    expect(row()).toMatchObject({ skip_reason: null, size: 32 });
    expect(existsSync(join(dir, row().stored_name!))).toBe(true);
    expect(attachmentsOf(db, messageByDiscordId(db, m.id)!.id)).toHaveLength(1);
  });
});

describe('backfill', () => {
  it('on start, picks up what was written while the bot was away, a page at a time, and skips the bot', async () => {
    const { id, thread } = await ticketWithThread(IDS[5]);
    t.fetchPageSize = 2;
    const seen = t.userPost(thread, { authorId: '906', content: 'before the restart' }, false);
    // Already stored, as if mirrored before the bot went down.
    mirror.start();
    await mirror.idle();
    mirror.stop();
    expect(all().map((m) => m.discord_message_id)).toEqual([seen.id]);

    for (const content of ['one', 'two', 'three', 'four', 'five']) t.userPost(thread, { authorId: '907', content }, false);
    await t.send(thread, card('Another report: afk'));
    mirror = new TicketMirror({ db, transport: t, store: new AttachmentStore({ db, dir, fetcher }), onChange: (n) => nudged.push(n) });
    mirror.start();
    await mirror.idle();
    expect(all().map((m) => m.content)).toEqual(['before the restart', 'one', 'two', 'three', 'four', 'five']);
    expect(all()[1]).toMatchObject({ ticket_id: id, author_player_id: ADMIN });
  });

  it('leaves locked threads alone on start, and catches up when the ticket is reopened', async () => {
    const { id, thread } = await ticketWithThread(IDS[5]);
    closeTicket(db, id, MOD, 'no_action', '');
    setThreadLocked(db, threadByDiscordId(db, thread)!.id, true);
    t.userPost(thread, { authorId: '907', content: 'written into a locked thread by someone who can' }, false);
    mirror.start();
    await mirror.idle();
    expect(all()).toEqual([]);
    expect(reopenTicket(db, id, MOD).ok).toBe(true);
    await mirror.idle();
    expect(all().map((m) => m.content)).toEqual(['written into a locked thread by someone who can']);
  });

  it('one thread Discord refuses does not stop the others', async () => {
    const a = await ticketWithThread(IDS[5]);
    const b = await ticketWithThread(IDS[4]);
    t.userPost(a.thread, { authorId: '906', content: 'in a' }, false);
    t.userPost(b.thread, { authorId: '906', content: 'in b' }, false);
    t.failThreadOps = 1;
    mirror.start();
    await mirror.idle();
    expect(all().map((m) => m.content)).toEqual(['in b']);
    await mirror.backfill();
    expect(all().map((m) => m.content).sort()).toEqual(['in a', 'in b']);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/ticketMirror.test.ts`
Expected: FAIL, cannot resolve `../src/discord/ticketMirror.js`.

- [ ] **Step 3: The mirror**

`src/discord/ticketMirror.ts`:

```ts
import type { DB } from '../db.js';
import { playerByDiscordId } from '../players.js';
import { subscribeTicketSignals } from '../tickets/signals.js';
import { threadByDiscordId, type ThreadRow } from '../tickets/threads.js';
import {
  attachmentsOf, insertAttachment, insertMessage, lastMessageId, markDeleted, messageByDiscordId, recordEdit, updateAttachment,
} from '../tickets/messages.js';
import type { AttachmentStore } from '../tickets/attachments.js';
import type { BotTransport, InboundAttachment, InboundMessage } from './transport.js';

export interface TicketMirrorDeps {
  db: DB;
  transport: BotTransport;
  store: AttachmentStore;
  /** "This ticket's page should refetch." Wired to the staff-scoped nudge,
   *  never to hub.broadcast: see src/tickets/nudge.ts. */
  onChange?: (ticketId: number) => void;
}

/**
 * Copies what people write in ticket threads onto the site.
 *
 * Only threads listed in ticket_threads are read. The transport asks
 * `watches` before it hands anything over, and every handler here looks the
 * thread up again before it reads a field off the message, so neither a bug
 * in the transport nor a stale event can turn somebody's conversation into
 * ticket content.
 *
 * Everything runs on one chain, so a message, its edit and its deletion land
 * in order, and a backfill never interleaves with a live event. Live events
 * are latency; the backfill on every start is what makes the copy complete,
 * because deploys restart the bot often.
 */
export class TicketMirror {
  private chain: Promise<void> = Promise.resolve();
  private offs: (() => void)[] = [];
  private stopped = false;

  constructor(private deps: TicketMirrorDeps) {}

  start(): void {
    this.deps.transport.watchMessages({
      watches: (threadId) => !this.stopped && this.watched(threadId) !== undefined,
      create: (m) => this.enqueue(() => this.onCreate(m)),
      update: (m) => this.enqueue(() => this.onUpdate(m)),
      remove: (threadId, messageId) => this.enqueue(() => this.onRemove(threadId, messageId)),
    });
    // A ticket signal is "something about this ticket changed". One of those
    // things is a reopen, after which the thread may hold messages written
    // while it was locked. One REST call per ticket action is cheap, and it
    // keeps this free of knowing WHAT changed.
    this.offs.push(subscribeTicketSignals((s) => {
      if (s.kind === 'ticket') this.enqueue(() => this.backfillTicket(s.ticketId));
    }));
    this.enqueue(() => this.backfill());
  }

  stop(): void {
    this.stopped = true;
    for (const off of this.offs) off();
    this.offs = [];
  }

  /** Resolves once everything asked for so far has been done (tests). */
  idle(): Promise<void> {
    return this.chain;
  }

  private enqueue(fn: () => Promise<void>): void {
    this.chain = this.chain.then(fn).catch((err) => console.error('[discord] ticket mirror failed:', err));
  }

  /** The ticket thread with this Discord id, if it is one the bot still
   *  stands behind. A thread the bot deleted is nobody's. */
  private watched(threadId: string): ThreadRow | undefined {
    const th = threadByDiscordId(this.deps.db, threadId);
    return th && th.state !== 'deleted' ? th : undefined;
  }

  private async onCreate(m: InboundMessage): Promise<void> {
    // The thread first. Nothing else about `m` is read before this passes.
    const thread = this.watched(m.threadId);
    if (!thread) return;
    // The timeline already has the events the bot's own lines describe.
    if (m.authorIsBot) return;
    const { db } = this.deps;
    const row = insertMessage(db, {
      ticketId: thread.ticket_id, threadId: m.threadId, channel: thread.kind === 'reporter' ? 'reporter' : 'staff',
      discordMessageId: m.id, authorDiscordId: m.authorId,
      // Unknown to the site is fine: the Discord name is kept and the
      // message is never turned away for it.
      authorPlayerId: playerByDiscordId(db, m.authorId)?.steamid ?? null,
      authorName: m.authorName, content: m.content, createdAt: m.createdAt,
    });
    if (!row) {
      // Already stored: a live event and a backfill both delivered it. What
      // arrived may still be newer than what is stored.
      await this.onUpdate(m);
      return;
    }
    for (const a of m.attachments) await this.saveOne(thread.ticket_id, row.id, a);
    this.deps.onChange?.(thread.ticket_id);
  }

  private async onUpdate(m: InboundMessage): Promise<void> {
    const thread = this.watched(m.threadId);
    if (!thread) return;
    if (m.authorIsBot) return;
    const { db } = this.deps;
    const row = messageByDiscordId(db, m.id);
    if (!row) {
      // An edit to a message that was never seen: store it as it is now.
      await this.onCreate(m);
      return;
    }
    // A removed message stays blank whatever Discord says afterwards.
    if (row.removed_at !== null) return;
    let changed = recordEdit(db, row.id, m.content, m.editedAt ?? new Date().toISOString());
    const known = new Set(attachmentsOf(db, row.id).map((a) => a.discord_attachment_id));
    for (const a of m.attachments) {
      if (known.has(a.id)) continue;
      await this.saveOne(thread.ticket_id, row.id, a);
      changed = true;
    }
    if (changed) this.deps.onChange?.(thread.ticket_id);
  }

  /** A delete in Discord is soft here: the content and the files are kept. */
  private async onRemove(threadId: string, messageId: string): Promise<void> {
    const thread = this.watched(threadId);
    if (!thread) return;
    const before = messageByDiscordId(this.deps.db, messageId);
    if (!before || before.deleted_at !== null) return;
    markDeleted(this.deps.db, messageId);
    this.deps.onChange?.(thread.ticket_id);
  }

  private async saveOne(ticketId: number, messageId: number, a: InboundAttachment): Promise<void> {
    const r = await this.deps.store.save(ticketId, a);
    insertAttachment(this.deps.db, {
      messageId, discordAttachmentId: a.id, filename: a.name, contentType: a.contentType ?? '',
      size: r.size, sha256: r.sha256, storedName: r.storedName, skipReason: r.skipReason,
    });
  }

  /** Every open, unlocked thread. Never throws, and one thread Discord
   *  refuses does not stop the rest. */
  async backfill(): Promise<void> {
    const threads = this.deps.db.prepare("SELECT * FROM ticket_threads WHERE state = 'open' AND locked = 0 ORDER BY id").all() as ThreadRow[];
    for (const th of threads) await this.backfillSafely(th);
  }

  private async backfillTicket(ticketId: number): Promise<void> {
    const threads = this.deps.db.prepare("SELECT * FROM ticket_threads WHERE ticket_id = ? AND state = 'open' ORDER BY id").all(ticketId) as ThreadRow[];
    for (const th of threads) await this.backfillSafely(th);
  }

  private async backfillSafely(th: ThreadRow): Promise<void> {
    try {
      await this.backfillThread(th);
    } catch (err) {
      console.error(`[discord] backfilling ticket thread ${th.thread_id} failed; the next start tries again:`, err instanceof Error ? err.message : err);
    }
  }

  private async backfillThread(th: ThreadRow): Promise<void> {
    const { db, transport } = this.deps;
    // After the last STORED id. The bot's own lines are never stored, so any
    // after that point are read again each time and dropped again.
    let after = lastMessageId(db, th.thread_id);
    for (;;) {
      const page = await transport.threads.fetchAfter(th.thread_id, after);
      if (page.length === 0) break;
      for (const m of page) await this.onCreate(m);
      after = page[page.length - 1].id;
    }
    await this.retryFailed(th);
  }

  /** Downloads that failed, tried again. The message is fetched afresh
   *  because its links are signed and the old ones may have expired. */
  private async retryFailed(th: ThreadRow): Promise<void> {
    const { db, transport, store } = this.deps;
    const failed = db.prepare(
      `SELECT a.id, a.discord_attachment_id, m.discord_message_id, m.ticket_id FROM ticket_attachments a
         JOIN ticket_messages m ON m.id = a.message_id
       WHERE m.thread_id = ? AND a.skip_reason = 'fetch_failed' AND a.removed_at IS NULL
         AND m.removed_at IS NULL AND m.deleted_at IS NULL
       ORDER BY a.id`,
    ).all(th.thread_id) as { id: number; discord_attachment_id: string; discord_message_id: string; ticket_id: number }[];
    const fresh = new Map<string, InboundMessage | null>();
    let changed = false;
    for (const f of failed) {
      if (!fresh.has(f.discord_message_id)) fresh.set(f.discord_message_id, await transport.threads.fetchMessage(th.thread_id, f.discord_message_id));
      const a = fresh.get(f.discord_message_id)?.attachments.find((x) => x.id === f.discord_attachment_id);
      if (!a) continue;
      const r = await store.save(f.ticket_id, a);
      if (r.skipReason === 'fetch_failed') continue;
      updateAttachment(db, f.id, r);
      changed = true;
    }
    if (changed) this.deps.onChange?.(th.ticket_id);
  }
}
```

- [ ] **Step 4: Start it with the bot**

`src/server.ts`. Add the imports:

```ts
import { TicketMirror } from './discord/ticketMirror.js';
import { AttachmentStore, httpFetcher } from './tickets/attachments.js';
```

Beside `let ticketSync: TicketSync | null = null;`:

```ts
  let ticketMirror: TicketMirror | null = null;
```

In `startBot`'s `onConnected`, after `ticketSync.start();`:

```ts
        // After the reconciler is listening, so a thread it makes on its
        // first pass is there for the mirror's next look.
        ticketMirror = new TicketMirror({
          db: deps.db, transport: t,
          store: new AttachmentStore({ db: deps.db, dir: deps.config.ticketAttachmentsDir, fetcher: httpFetcher }),
          onChange: nudgeTicket,
        });
        ticketMirror.start();
```

In the `onClose` hook, before `ticketSync?.stop();`:

```ts
    ticketMirror?.stop();
```

`nudgeTicket` is the constant Task 4 declared next to the `wsRoutes` registration, well above this point in `buildServer`. `DEV_MODE=1` keeps the bot off, so none of this runs in development or in any `buildServer` test, and nothing in a test can reach `httpFetcher`.

- [ ] **Step 5: Run**

Run: `npx vitest run tests/ticketMirror.test.ts tests/ticketSync.test.ts tests/fakeMessages.test.ts && npm run typecheck`
Expected: PASS, typecheck clean. `git status --short data/` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add src/discord/ticketMirror.ts src/server.ts tests/ticketMirror.test.ts
git commit -m "Mirror what staff write in a ticket thread onto the site, with edits, deletions, files and a backfill on every start"
```

---

### Task 6: The discussion on the ticket detail, and the one route that serves a file

Two read paths, both behind the same gate as the ticket itself.

`ticketDetail` already answers null for a ticket the viewer cannot see, so adding `messages` to it adds nothing to anyone who could not already read the ticket.

The serving route is the only way a stored file ever leaves the box. It checks, in this order: staff (the ordinary `requireMod`, 401 or 403 like every `/api/mod` route, which says nothing about any file), then the ticket through `canSeeTicket`, then that the attachment belongs to THAT ticket, is stored, and has not been removed. Every failure after `requireMod` is the same 404 with the same body, so the route cannot be used to ask whether a ticket or a file exists. The headers are exact, and they matter: these are files strangers chose.

**Files:**
- Create: `tests/ticketAttachmentRoute.test.ts`
- Modify: `src/tickets/views.ts` (`ticketDetail`), `src/routes/tickets.ts` (`TicketRouteOpts`, one route), `src/server.ts` (the `ticketRoutes` registration)

**Interfaces:**
- Consumes: `MessageRow`, `AttachmentRow` (Task 1); `allowedType`, `attachmentPath`, `AttachmentStore` (Task 3); `canSeeTicket`, `getTicketRow`; `Config.ticketAttachmentsDir` (Task 1).
- Produces:
  - `ticketDetail(...)` gains `messages: TicketMessageView[]` where

```ts
interface TicketMessageView {
  id: number; channel: 'staff' | 'reporter'; authorName: string; authorPlayerId: string | null; authorPlayerName: string | null;
  content: string; history: string[]; createdAt: string; editedAt: string | null; deletedAt: string | null;
  removed: { at: string; by: string | null; byName: string | null; reason: string } | null;
  attachments: { id: number; filename: string; contentType: string; size: number; sha256: string | null;
    stored: boolean; skipReason: string | null; removed: boolean }[];
}
```

  - `TicketRouteOpts.attachmentsDir: string`
  - `GET /api/mod/tickets/:id/attachments/:aid`

- [ ] **Step 1: Write the failing test**

`tests/ticketAttachmentRoute.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { fileReport } from '../src/tickets/filing.js';
import { insertAttachment, insertMessage } from '../src/tickets/messages.js';
import { attachmentPath, AttachmentStore } from '../src/tickets/attachments.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 7 }, (_, i) => `7656119900000000${i}`);
const [R1, PLAYER, ACCUSED, STAFF_ACCUSED, MOD, ADMIN, OWNER] = IDS;
let db: DB;
let app: FastifyInstance;
let root: string;
let dir: string;
let seq = 0;
const cookie: Record<string, Record<string, string>> = {};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'pug-serve-'));
  dir = join(root, 'ticket-attachments');
  db = openDb(':memory:');
  app = await buildServer({
    config: loadConfig({ ADMIN_STEAMIDS: OWNER, TICKET_ATTACHMENTS_DIR: dir }), db,
    orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
  });
  for (const id of IDS) cookie[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid IN (?, ?)').run(ADMIN, OWNER);
});
afterEach(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });

const file = (targetId: string, category = 'griefing') =>
  (fileReport(db, R1, { targetId, category, text: 'x' }, { adminSteamIds: [OWNER] }) as { ticketId: number }).ticketId;
/** A mirrored message with one file, stored through the real store. */
async function seed(ticketId: number, name: string, body: Uint8Array): Promise<{ aid: number; storedName: string | null }> {
  const store = new AttachmentStore({ db, dir, fetcher: async () => ({ ok: true, body: (async function* () { yield body; })() }) });
  const r = await store.save(ticketId, { id: `a${++seq}`, name, contentType: null, size: body.byteLength, url: 'https://cdn.discordapp.com/x' });
  const m = insertMessage(db, {
    ticketId, threadId: '9001', channel: 'staff', discordMessageId: `d${++seq}`, authorDiscordId: '906', authorPlayerId: MOD,
    authorName: 'Mod on Discord', content: 'look at this', createdAt: '2026-09-22T10:00:00.000Z',
  })!;
  const aid = insertAttachment(db, { messageId: m.id, discordAttachmentId: `a${seq}`, filename: name, contentType: 'whatever/discord-said', size: r.size, sha256: r.sha256, storedName: r.storedName, skipReason: r.skipReason });
  return { aid, storedName: r.storedName };
}
const get = (as: string | null, url: string) => app.inject({ method: 'GET', url, cookies: as ? cookie[as] : undefined });

describe('GET /api/mod/tickets/:id/attachments/:aid', () => {
  it('serves an image inline, with our content type and the exact headers', async () => {
    const id = file(ACCUSED);
    const body = new Uint8Array(200).fill(9);
    const { aid } = await seed(id, 'shot.png', body);
    const r = await get(MOD, `/api/mod/tickets/${id}/attachments/${aid}`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['content-disposition']).toBe('inline; filename="shot.png"');
    expect(r.headers['cache-control']).toBe('private, no-store');
    expect(String(r.headers['content-length'])).toBe('200');
    expect(r.rawPayload).toEqual(Buffer.from(body));
  });

  it('serves a text file as a download, never inline, and never trusts the name it was given', async () => {
    const id = file(ACCUSED);
    const txt = await seed(id, 'we"ird\r\nname.txt', new Uint8Array(5).fill(65));
    const r = await get(MOD, `/api/mod/tickets/${id}/attachments/${txt.aid}`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(r.headers['content-disposition']).toBe('attachment; filename="we_ird__name.txt"');
    const mov = await seed(id, 'clip.mov', new Uint8Array(5));
    expect((await get(MOD, `/api/mod/tickets/${id}/attachments/${mov.aid}`)).headers['content-disposition']).toBe('inline; filename="clip.mov"');
  });

  it('is behind the ticket: the accused, anyone off a restricted list, and a wrong ticket id all get the same 404', async () => {
    const restricted = file(ACCUSED, 'unsafe');
    const secret = await seed(restricted, 'secret.png', new Uint8Array(10));
    const aboutStaff = file(STAFF_ACCUSED);
    // Made a moderator after the report, so the ticket is still a normal one:
    // readable by every other member of staff, and never by them.
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(STAFF_ACCUSED);
    const theirs = await seed(aboutStaff, 'about-me.png', new Uint8Array(10));
    const normal = file(PLAYER);

    expect((await get(OWNER, `/api/mod/tickets/${restricted}/attachments/${secret.aid}`)).statusCode).toBe(200);
    const missing = await get(OWNER, `/api/mod/tickets/${restricted}/attachments/99999`);
    expect(missing.statusCode).toBe(404);
    for (const r of [
      await get(ADMIN, `/api/mod/tickets/${restricted}/attachments/${secret.aid}`),
      await get(MOD, `/api/mod/tickets/${restricted}/attachments/${secret.aid}`),
      await get(STAFF_ACCUSED, `/api/mod/tickets/${aboutStaff}/attachments/${theirs.aid}`),
      // A real file, asked for through a ticket it does not belong to.
      await get(MOD, `/api/mod/tickets/${normal}/attachments/${secret.aid}`),
      await get(MOD, `/api/mod/tickets/9999/attachments/${secret.aid}`),
    ]) {
      expect(r.statusCode).toBe(404);
      expect(r.body).toBe(missing.body);
    }
    // Not staff: refused as every /api/mod route refuses, before any file is looked up.
    expect((await get(PLAYER, `/api/mod/tickets/${restricted}/attachments/${secret.aid}`)).statusCode).toBe(403);
    expect((await get(PLAYER, `/api/mod/tickets/${restricted}/attachments/99999`)).statusCode).toBe(403);
    expect((await get(null, `/api/mod/tickets/${restricted}/attachments/${secret.aid}`)).statusCode).toBe(401);
  });

  it('404s a file that was not stored, was removed, or is no longer on disk', async () => {
    const id = file(ACCUSED);
    const refused = await seed(id, 'tool.exe', new Uint8Array(10));
    expect((await get(MOD, `/api/mod/tickets/${id}/attachments/${refused.aid}`)).statusCode).toBe(404);
    const removed = await seed(id, 'gone.png', new Uint8Array(10));
    db.prepare("UPDATE ticket_attachments SET removed_at = '2026-09-22T12:00:00.000Z' WHERE id = ?").run(removed.aid);
    expect((await get(MOD, `/api/mod/tickets/${id}/attachments/${removed.aid}`)).statusCode).toBe(404);
    const lost = await seed(id, 'lost.png', new Uint8Array(10));
    unlinkSync(attachmentPath(dir, lost.storedName!)!);
    expect((await get(MOD, `/api/mod/tickets/${id}/attachments/${lost.aid}`)).statusCode).toBe(404);
  });
});

describe('the discussion on the detail', () => {
  it('lists mirrored messages oldest first, each with its files and what became of them', async () => {
    const id = file(ACCUSED);
    const png = await seed(id, 'shot.png', new Uint8Array(10));
    await seed(id, 'tool.exe', new Uint8Array(10));
    const d = (await get(MOD, `/api/mod/tickets/${id}`)).json();
    expect(d.messages).toHaveLength(2);
    expect(d.messages[0]).toMatchObject({
      channel: 'staff', authorName: 'Mod on Discord', authorPlayerId: MOD, content: 'look at this', history: [],
      editedAt: null, deletedAt: null, removed: null,
    });
    expect(d.messages[0].attachments).toEqual([expect.objectContaining({ id: png.aid, filename: 'shot.png', size: 10, stored: true, skipReason: null, removed: false })]);
    expect(d.messages[1].attachments[0]).toMatchObject({ filename: 'tool.exe', stored: false, skipReason: 'type' });
    // The random name on disk is nobody's business but the server's.
    expect(JSON.stringify(d)).not.toContain(png.storedName);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/ticketAttachmentRoute.test.ts`
Expected: FAIL. The route answers 404 for everything, and `d.messages` is undefined.

- [ ] **Step 3: `messages` on the detail**

`src/tickets/views.ts`. Add `import type { AttachmentRow, MessageRow } from './messages.js';`. In `ticketDetail`, above the `const me = ...` line:

```ts
  // The mirrored discussion. Everything here is behind the canSeeTicket check
  // at the top of this function, like the rest of the detail. `stored_name`
  // stays on the server: the page asks for a file by attachment id.
  const files = db.prepare(
    `SELECT a.* FROM ticket_attachments a JOIN ticket_messages m ON m.id = a.message_id WHERE m.ticket_id = ? ORDER BY a.id`,
  ).all(id) as AttachmentRow[];
  const messages = (db.prepare(
    `SELECT m.*, pa.name AS author_player_name, pr.name AS removed_by_name FROM ticket_messages m
       LEFT JOIN players pa ON pa.steamid = m.author_player_id LEFT JOIN players pr ON pr.steamid = m.removed_by
     WHERE m.ticket_id = ? ORDER BY m.created_at, m.id`,
  ).all(id) as (MessageRow & { author_player_name: string | null; removed_by_name: string | null })[]).map((m) => ({
    id: m.id, channel: m.channel, authorName: m.author_name, authorPlayerId: m.author_player_id, authorPlayerName: m.author_player_name,
    content: m.content, history: JSON.parse(m.history) as string[],
    createdAt: m.created_at, editedAt: m.edited_at, deletedAt: m.deleted_at,
    removed: m.removed_at === null ? null : { at: m.removed_at, by: m.removed_by, byName: m.removed_by_name, reason: m.removed_reason ?? '' },
    attachments: files.filter((f) => f.message_id === m.id).map((f) => ({
      id: f.id, filename: f.filename, contentType: f.content_type, size: f.size, sha256: f.sha256,
      stored: f.stored_name !== null && f.removed_at === null, skipReason: f.skip_reason, removed: f.removed_at !== null,
    })),
  }));
```

and add `messages,` to the returned object, after `discussion,`.

- [ ] **Step 4: The serving route**

`src/routes/tickets.ts`. Add the imports:

```ts
import { createReadStream, statSync } from 'node:fs';
import { canSeeTicket, getTicketRow } from '../tickets/store.js';
import { allowedType, attachmentPath } from '../tickets/attachments.js';
import type { AttachmentRow } from '../tickets/messages.js';
```

(`getTicketRow` is already imported from `'../tickets/store.js'`; widen that import rather than adding a second.) Add to `TicketRouteOpts`:

```ts
  /** config.ticketAttachmentsDir. */
  attachmentsDir: string;
```

destructure it (`const { db, matchmaker, broadcast, adminSteamIds, guildId, attachmentsDir } = opts;`) and add the route after the ticket detail route:

```ts
  /**
   * The only way a stored file leaves the box.
   *
   * After requireMod, every refusal is the same 404 with the same body: no
   * such ticket, a ticket this viewer may not see, a file that belongs to a
   * different ticket, one that was never stored, one that was removed. The
   * route cannot be used to ask whether any of those exist.
   *
   * The headers assume the file is hostile, because a stranger chose it. The
   * content type is OURS for the extension, never what Discord or the
   * uploader claimed; nosniff stops a browser second-guessing it; the
   * sandboxing policy means that even opened in a tab of its own it runs
   * nothing and loads nothing. Only images and video may show in place.
   */
  app.get('/api/mod/tickets/:id/attachments/:aid', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const { id, aid } = req.params as { id: string; aid: string };
    const gone = () => reply.code(404).send({ error: 'no such file' });
    const t = getTicketRow(db, Number(id));
    if (!t || !canSeeTicket(db, t, me)) return gone();
    const a = db.prepare(
      `SELECT a.* FROM ticket_attachments a JOIN ticket_messages m ON m.id = a.message_id
       WHERE a.id = ? AND m.ticket_id = ? AND m.removed_at IS NULL`,
    ).get(Number(aid), t.id) as AttachmentRow | undefined;
    if (!a || a.removed_at !== null || a.stored_name === null) return gone();
    const type = allowedType(a.filename);
    const path = attachmentPath(attachmentsDir, a.stored_name);
    if (!type || !path) return gone();
    let bytes: number;
    try {
      bytes = statSync(path).size;
    } catch {
      return gone();
    }
    // Nothing but these survives into the header: a name is user input.
    const safeName = a.filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(-100);
    return reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "sandbox; default-src 'none'")
      .header('Content-Disposition', `${type.inline ? 'inline' : 'attachment'}; filename="${safeName}"`)
      // A removed file must not live on in a browser cache.
      .header('Cache-Control', 'private, no-store')
      .header('Content-Length', bytes)
      .type(type.mime)
      .send(createReadStream(path));
  });
```

`src/server.ts`, the `ticketRoutes` registration gains one line:

```ts
    attachmentsDir: deps.config.ticketAttachmentsDir,
```

There is no `Range` support: a video plays from its start and cannot be scrubbed until it has loaded. That is left out on purpose (see the closing section); the file can always be opened in its own tab.

- [ ] **Step 5: Run**

Run: `npx vitest run tests/ticketAttachmentRoute.test.ts tests/ticketRoutes.test.ts tests/ticketSyncAccess.test.ts && npm run typecheck`
Expected: PASS, typecheck clean. `git status --short data/` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add src/tickets/views.ts src/routes/tickets.ts src/server.ts tests/ticketAttachmentRoute.test.ts
git commit -m "Put the mirrored discussion on the ticket detail and serve its files behind the ticket's own access check"
```

---

### Task 7: Remove: from the site, from Discord, and for good

The threat: somebody posts something horrible in a ticket thread, and by then the bot has copied it to the box. Getting rid of it is one action from wherever the moderator is, and it leaves nothing behind.

What Remove does, in this order:
1. In one transaction: `content` and `history` are blanked, the tombstone is written (who, when, an optional reason of up to 200 characters), every attachment of the message is marked removed, and a `removed` ticket event is added. From this commit on, the detail shows a tombstone and the serving route answers 404.
2. The files are unlinked from disk, and `stored_name` is cleared as each one goes. A file that cannot be unlinked keeps its `stored_name`, is reported to the admin feed with no detail, and is tried again on every server start.
3. The ticket signal is published, which nudges open ticket pages.
4. The message is deleted in Discord. This is the one step that needs the bot, so it is not part of the request: the mirror sweeps for removed messages whose Discord copy is not yet known gone (`discord_gone = 0`), on every start, and whenever the site or the command pokes it. A removal made while the bot is down is finished when it comes back.

What is kept, on purpose: who wrote the message, when, and for each file its name, size and sha256. That is the record that something was removed. The audit row and the ticket event carry the message's id and a file count, never a word of what was removed.

Remove cannot be undone. The site asks once through the app's confirm dialog (Task 8). The Discord command acts at once and answers privately.

**Files:**
- Create: `src/tickets/removal.ts`, `src/discord/ticketRemove.ts`, `tests/ticketRemoval.test.ts`
- Modify: `src/discord/ticketMirror.ts` (`sweepRemovals`, `removeInDiscord`, a download that finishes after the removal), `src/routes/tickets.ts` (`TicketRouteOpts`, one route), `src/server.ts` (wiring, the start-up purge), `src/discord/adminFeedPoster.ts` (`ticket_remove`)

**Interfaces:**
- Consumes: `messageById`, `messageByDiscordId` (Task 1); `attachmentPath` (Task 3); `TicketMirror` (Task 5); `BotDeps.messageCommands` (Task 2); `threadByDiscordId`; `canSeeTicket`, `getTicketRow`, `addTicketEvent`; `publishTicketSignal`; `logAdmin`; `BotTransport.remove(channelId, messageId)`, `threads.exists`, `threads.setArchived`.
- Produces:
  - `src/tickets/removal.ts`: `type RemoveResult = { ok: true; files: number } | { ok: false; status: number; error: string }`, `removeMessage(db: DB, dir: string, ticketId: number, messageId: number, by: string, reason: unknown, now?: Date): RemoveResult`, `purgeRemovedFiles(db: DB, dir: string): number` (how many could not be deleted)
  - `TicketMirror.sweepRemovals(): Promise<void>` and `TicketMirror.removeInDiscord(threadId: string, discordMessageId: string): Promise<void>`
  - `src/discord/ticketRemove.ts`: `REMOVE_COMMAND = 'Remove from ticket'`, `interface TicketRemoveDeps { db: DB; attachmentsDir: string; mirror: () => TicketMirror | null }`, `handleRemoveCommand(deps, i): Promise<InteractionReply>`
  - `POST /api/mod/tickets/:id/messages/:mid/remove` with body `{ reason?: string }`; `TicketRouteOpts.afterRemove: () => void`
  - Audit action `ticket_remove`, detail `{ messageId, files, via? }` or `{ mirrored: false, via: 'discord' }`. Ticket event `removed`, detail `{ messageId, files }` or `{ mirrored: false }`.

- [ ] **Step 1: Write the failing test**

`tests/ticketRemoval.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { fileReport } from '../src/tickets/filing.js';
import { insertThread, setThreadLocked, threadByDiscordId } from '../src/tickets/threads.js';
import { attachmentsOf, messageByDiscordId, messageById } from '../src/tickets/messages.js';
import { AttachmentStore, type AttachmentFetcher } from '../src/tickets/attachments.js';
import { removeMessage } from '../src/tickets/removal.js';
import { subscribeTicketSignals, type TicketSignal } from '../src/tickets/signals.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { TicketMirror } from '../src/discord/ticketMirror.js';
import { handleRemoveCommand, REMOVE_COMMAND } from '../src/discord/ticketRemove.js';
import { FakeTransport } from './fakes/fakeTransport.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const [R1, PLAYER, , , , ACCUSED, MOD, ADMIN] = IDS;
const HORRIBLE = 'the horrible thing that was said';
let db: DB;
let t: FakeTransport;
let mirror: TicketMirror;
let root: string;
let dir: string;
let signals: TicketSignal[];
let events: AdminEvent[];
let offs: (() => void)[];

const fetcher: AttachmentFetcher = async () => ({ ok: true, body: (async function* () { yield new Uint8Array(50).fill(3); })() });
const card = (content: string) => ({ content, embeds: [], components: [] });
const newMirror = () => new TicketMirror({ db, transport: t, store: new AttachmentStore({ db, dir, fetcher }) });

beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []);
    activatePlayer(db, id);
    linkDiscord(db, id, `90${i}`, `d${i}`);
  });
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  root = mkdtempSync(join(tmpdir(), 'pug-remove-'));
  dir = join(root, 'ticket-attachments');
  t = new FakeTransport();
  mirror = newMirror();
  signals = [];
  events = [];
  offs = [subscribeTicketSignals((s) => signals.push(s)), subscribeAdminEvents((e) => events.push(e))];
});
afterEach(() => { mirror.stop(); for (const off of offs) off(); rmSync(root, { recursive: true, force: true }); });

const file = (targetId: string, category = 'griefing') =>
  (fileReport(db, R1, { targetId, category, text: 'x' }, { adminSteamIds: [ADMIN] }) as { ticketId: number }).ticketId;
async function ticketWithThread(targetId: string, category = 'griefing'): Promise<{ id: number; thread: string }> {
  const id = file(targetId, category);
  const made = await t.threads.createForumPost('forum1', { name: `#${id}`, message: card('the card'), tags: [] });
  insertThread(db, { ticketId: id, kind: 'staff', surface: 'forum', channelId: 'forum1', threadId: made.threadId, cardMessageId: made.messageId, cardHash: 'h' });
  return { id, thread: made.threadId };
}
/** Someone posts the horrible thing with a picture, edits it once, and the mirror copies it all. */
async function horrible(thread: string) {
  const m = t.userPost(thread, { authorId: '555', authorName: 'A Stranger', content: 'an earlier version', attachments: [
    { id: 'a1', name: 'picture.png', contentType: 'image/png', size: 50, url: 'https://cdn.discordapp.com/1/picture.png' },
  ] });
  t.userEdit(m.id, HORRIBLE);
  await mirror.idle();
  return { discordId: m.id, row: messageByDiscordId(db, m.id)! };
}
const dump = () => JSON.stringify([
  db.prepare('SELECT * FROM ticket_messages').all(), db.prepare('SELECT * FROM ticket_events').all(),
  db.prepare('SELECT * FROM admin_actions').all(), events,
]);

describe('removeMessage', () => {
  it('destroys the text, its history and its files, and keeps only a tombstone', async () => {
    const { id, thread } = await ticketWithThread(ACCUSED);
    mirror.start();
    const { row } = await horrible(thread);
    const before = attachmentsOf(db, row.id)[0];
    expect(existsSync(join(dir, before.stored_name!))).toBe(true);
    signals.length = 0;

    expect(removeMessage(db, dir, id, row.id, MOD, '  not for anyone to see  ', new Date('2026-09-22T12:00:00.000Z'))).toEqual({ ok: true, files: 1 });

    expect(messageById(db, row.id)).toMatchObject({
      content: '', history: '[]', removed_at: '2026-09-22T12:00:00.000Z', removed_by: MOD, removed_reason: 'not for anyone to see',
      author_name: 'A Stranger', discord_gone: 0,
    });
    expect(attachmentsOf(db, row.id)[0]).toMatchObject({
      filename: 'picture.png', size: 50, sha256: before.sha256, stored_name: null, removed_at: '2026-09-22T12:00:00.000Z',
    });
    expect(readdirSync(dir)).toEqual([]);
    const ev = db.prepare("SELECT actor_id, detail FROM ticket_events WHERE ticket_id = ? AND kind = 'removed'").get(id) as { actor_id: string; detail: string };
    expect(ev.actor_id).toBe(MOD);
    expect(JSON.parse(ev.detail)).toEqual({ messageId: row.id, files: 1 });
    expect(signals).toEqual([{ kind: 'ticket', ticketId: id }]);
    expect(dump()).not.toContain(HORRIBLE);
    expect(dump()).not.toContain('an earlier version');
  });

  it('answers a ticket you cannot see as it answers one that does not exist, and refuses a second removal', async () => {
    const { id, thread } = await ticketWithThread(ACCUSED, 'unsafe');
    const other = file(PLAYER);
    mirror.start();
    const { row } = await horrible(thread);
    expect(removeMessage(db, dir, id, row.id, MOD, '')).toEqual(removeMessage(db, dir, 9999, row.id, MOD, ''));
    expect(removeMessage(db, dir, id, row.id, MOD, '')).toMatchObject({ ok: false, status: 404 });
    // The right message through the wrong ticket.
    expect(removeMessage(db, dir, other, row.id, MOD, '')).toMatchObject({ ok: false, status: 404 });
    expect(messageById(db, row.id)!.content).toBe(HORRIBLE);
    expect(removeMessage(db, dir, id, row.id, ADMIN, '').ok).toBe(true);
    expect(removeMessage(db, dir, id, row.id, ADMIN, '')).toMatchObject({ ok: false, status: 409 });
  });
});

describe('the Discord half', () => {
  it('deletes the message in Discord, once, and an edit that arrives late changes nothing', async () => {
    const { id, thread } = await ticketWithThread(ACCUSED);
    mirror.start();
    const { discordId, row } = await horrible(thread);
    removeMessage(db, dir, id, row.id, MOD, '');
    await mirror.sweepRemovals();
    expect(await t.threads.fetchMessage(thread, discordId)).toBeNull();
    expect(messageById(db, row.id)!.discord_gone).toBe(1);
    t.hooks!.update({ id: discordId, threadId: thread, authorId: '555', authorName: 'A Stranger', authorIsBot: false, content: HORRIBLE, attachments: [], createdAt: row.created_at, editedAt: '2026-09-22T13:00:00.000Z' });
    await mirror.idle();
    expect(messageById(db, row.id)).toMatchObject({ content: '', history: '[]' });
  });

  it('a removal made while the bot was down is finished when it comes back', async () => {
    const { id, thread } = await ticketWithThread(ACCUSED);
    mirror.start();
    const { discordId, row } = await horrible(thread);
    mirror.stop();
    removeMessage(db, dir, id, row.id, MOD, '');
    expect(await t.threads.fetchMessage(thread, discordId)).not.toBeNull();
    mirror = newMirror();
    mirror.start();
    await mirror.idle();
    expect(await t.threads.fetchMessage(thread, discordId)).toBeNull();
    expect(messageById(db, row.id)!.discord_gone).toBe(1);
  });

  it('opens an archived thread to delete in it, and closes it again if the bot had locked it', async () => {
    const { id, thread } = await ticketWithThread(ACCUSED);
    mirror.start();
    const { discordId, row } = await horrible(thread);
    await t.threads.setLocked(thread, true);
    await t.threads.setArchived(thread, true);
    setThreadLocked(db, threadByDiscordId(db, thread)!.id, true);
    removeMessage(db, dir, id, row.id, MOD, '');
    await mirror.sweepRemovals();
    expect(t.inbox.find((m) => m.id === discordId)!.deleted).toBe(true);
    expect(t.threadsById.get(thread)).toMatchObject({ archived: true, locked: true });
  });

  it('a thread that no longer exists owes nothing', async () => {
    const { id, thread } = await ticketWithThread(ACCUSED);
    mirror.start();
    const { row } = await horrible(thread);
    await t.threads.deleteThread(thread);
    removeMessage(db, dir, id, row.id, MOD, '');
    await mirror.sweepRemovals();
    expect(messageById(db, row.id)!.discord_gone).toBe(1);
  });
});

describe('Remove from ticket, the Discord command', () => {
  const run = (userId: string, channelId: string, messageId: string) =>
    handleRemoveCommand({ db, attachmentsDir: dir, mirror: () => mirror }, { kind: 'message_command', name: REMOVE_COMMAND, userId, userName: 'x', channelId, messageId });
  const said = (r: { payload: { content?: string } }) => r.payload.content ?? '';

  it('is for staff, inside a ticket thread they can see, and answers privately', async () => {
    const open = await ticketWithThread(ACCUSED);
    const restricted = await ticketWithThread(PLAYER, 'unsafe');
    mirror.start();
    const a = await horrible(open.thread);
    const b = t.userPost(restricted.thread, { authorId: '907', content: HORRIBLE });
    await mirror.idle();
    const player = await run('901', open.thread, a.discordId);
    expect(player.ephemeral).toBe(true);
    expect(said(player)).toBe('Staff only.');
    const elsewhere = await run('906', 'general-chat', a.discordId);
    // Off the restricted ticket's list: the same words as "not a ticket thread".
    expect(said(await run('906', restricted.thread, b.id))).toBe(said(elsewhere));
    // Someone who CAN see both tickets, naming a message from the wrong thread.
    expect(said(await run('907', restricted.thread, a.discordId))).toBe(said(elsewhere));
    expect(messageById(db, a.row.id)!.content).toBe(HORRIBLE);
    expect(db.prepare('SELECT COUNT(*) AS n FROM admin_actions').get()).toEqual({ n: 0 });
  });

  it('removes at once: the site copy, the files and the Discord message, audited as from Discord', async () => {
    const { id, thread } = await ticketWithThread(ACCUSED);
    mirror.start();
    const { discordId, row } = await horrible(thread);
    const r = await run('906', thread, discordId);
    expect(r.ephemeral).toBe(true);
    expect(said(r)).toMatch(/cannot be undone/);
    expect(messageById(db, row.id)).toMatchObject({ content: '', removed_by: MOD, discord_gone: 1 });
    expect(readdirSync(dir)).toEqual([]);
    expect(await t.threads.fetchMessage(thread, discordId)).toBeNull();
    const audit = db.prepare('SELECT admin_id, action, target, detail FROM admin_actions').all() as { admin_id: string; action: string; target: string; detail: string }[];
    expect(audit.map((a) => ({ ...a, detail: JSON.parse(a.detail) }))).toEqual([
      { admin_id: MOD, action: 'ticket_remove', target: String(id), detail: { messageId: row.id, files: 1, via: 'discord' } },
    ]);
    expect(dump()).not.toContain(HORRIBLE);
    expect(said(await run('906', thread, discordId))).toMatch(/already removed/i);
  });

  it('deletes a message the mirror never copied, leaves the card alone, and is quiet on a restricted ticket', async () => {
    const { id, thread } = await ticketWithThread(ACCUSED, 'unsafe');
    mirror.start();
    await mirror.idle();
    mirror.stop();
    const missed = t.userPost(thread, { authorId: '555', content: HORRIBLE }, false);
    mirror = newMirror();
    events.length = 0;
    expect(said(await run('907', thread, missed.id))).toMatch(/had not been copied/);
    expect(t.inbox.find((m) => m.id === missed.id)!.deleted).toBe(true);
    expect(db.prepare("SELECT detail FROM ticket_events WHERE ticket_id = ? AND kind = 'removed'").get(id)).toEqual({ detail: '{"mirrored":false}' });
    expect(events).toEqual([]);
    expect(said(await run('907', thread, thread))).toMatch(/ticket's own card/);
    expect(t.byId(thread)!.deleted).toBe(false);
  });
});

describe('POST /api/mod/tickets/:id/messages/:mid/remove', () => {
  let app: FastifyInstance;
  afterEach(async () => { await app.close(); });

  it('removes for staff who can see the ticket, audits without the content, and the file stops being served', async () => {
    const { id, thread } = await ticketWithThread(ACCUSED);
    mirror.start();
    const { row } = await horrible(thread);
    const aid = attachmentsOf(db, row.id)[0].id;
    app = await buildServer({
      config: loadConfig({ ADMIN_STEAMIDS: ADMIN, TICKET_ATTACHMENTS_DIR: dir }), db,
      orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
    });
    const as = (steamid: string) => authedCookie(app, db, steamid);
    const url = `/api/mod/tickets/${id}/messages/${row.id}/remove`;
    expect((await app.inject({ method: 'GET', url: `/api/mod/tickets/${id}/attachments/${aid}`, cookies: as(MOD) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url, cookies: as(PLAYER), payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, cookies: as(ACCUSED), payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/mod/tickets/9999/messages/${row.id}/remove`, cookies: as(MOD), payload: {} })).statusCode).toBe(404);
    const r = await app.inject({ method: 'POST', url, cookies: as(MOD), payload: { reason: 'gore' } });
    expect(r.json()).toEqual({ ok: true });
    expect((await app.inject({ method: 'GET', url: `/api/mod/tickets/${id}/attachments/${aid}`, cookies: as(MOD) })).statusCode).toBe(404);
    const d = (await app.inject({ method: 'GET', url: `/api/mod/tickets/${id}`, cookies: as(MOD) })).json();
    expect(d.messages[0]).toMatchObject({ content: '', history: [], removed: { by: MOD, reason: 'gore' } });
    expect(d.messages[0].attachments[0]).toMatchObject({ filename: 'picture.png', size: 50, stored: false, removed: true });
    const audit = db.prepare("SELECT detail FROM admin_actions WHERE action = 'ticket_remove'").get() as { detail: string };
    expect(JSON.parse(audit.detail)).toEqual({ messageId: row.id, files: 1 });
    expect(dump()).not.toContain(HORRIBLE);
    expect(JSON.stringify(d)).not.toContain(HORRIBLE);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/ticketRemoval.test.ts`
Expected: FAIL, cannot resolve `../src/tickets/removal.js`.

- [ ] **Step 3: The removal itself**

`src/tickets/removal.ts`:

```ts
import { unlinkSync } from 'node:fs';
import type { DB } from '../db.js';
import { publishAdminEvent } from '../adminFeed.js';
import { attachmentPath } from './attachments.js';
import { messageById } from './messages.js';
import { publishTicketSignal } from './signals.js';
import { addTicketEvent, canSeeTicket, getTicketRow } from './store.js';

export type RemoveResult = { ok: true; files: number } | { ok: false; status: number; error: string };

const fail = (status: number, error: string): RemoveResult => ({ ok: false, status, error });
const MAX_REASON = 200;

/**
 * Unlink every file whose attachment row says it was removed, and forget its
 * name once it is gone. Returns how many could NOT be deleted; those keep
 * their stored_name and are tried again on the next call, which the server
 * makes at every start. A file that is already missing counts as deleted.
 */
export function purgeRemovedFiles(db: DB, dir: string): number {
  const rows = db.prepare('SELECT id, stored_name FROM ticket_attachments WHERE removed_at IS NOT NULL AND stored_name IS NOT NULL')
    .all() as { id: number; stored_name: string }[];
  let left = 0;
  for (const r of rows) {
    const path = attachmentPath(dir, r.stored_name);
    try {
      if (path) unlinkSync(path);
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') {
        console.error('[tickets] a removed attachment could not be deleted from disk:', err instanceof Error ? err.message : err);
        left++;
        continue;
      }
    }
    db.prepare('UPDATE ticket_attachments SET stored_name = NULL WHERE id = ?').run(r.id);
  }
  return left;
}

/**
 * Remove a mirrored message for good. It cannot be undone.
 *
 * The caller has already established that `by` is active staff (requireMod
 * on the site, the same check by hand in the Discord command). This adds the
 * per-ticket rule: missing and invisible are the same answer.
 *
 * The database first, in one transaction, so that from the moment it commits
 * the detail shows a tombstone and the serving route answers 404. Then the
 * files. Then the signal, which nudges open pages and wakes the bot's sweep
 * for the Discord half. Nothing here talks to Discord, so nothing here can
 * be slowed or failed by it.
 *
 * What is kept is the tombstone: who wrote it, who removed it, when, the
 * reason if one was given, and for each file its name, size and sha256. The
 * event carries an id and a count, never a word of what was removed.
 */
export function removeMessage(
  db: DB, dir: string, ticketId: number, messageId: number, by: string, reason: unknown, now = new Date(),
): RemoveResult {
  const t = getTicketRow(db, ticketId);
  if (!t || !canSeeTicket(db, t, by)) return fail(404, 'no such ticket');
  const m = messageById(db, messageId);
  // The same 404 for a message of another ticket: the id alone proves nothing.
  if (!m || m.ticket_id !== ticketId) return fail(404, 'no such ticket');
  if (m.removed_at !== null) return fail(409, 'that message was already removed');
  const text = typeof reason === 'string' ? reason.trim().slice(0, MAX_REASON) : '';
  const at = now.toISOString();
  const files = db.transaction(() => {
    db.prepare("UPDATE ticket_messages SET content = '', history = '[]', removed_at = ?, removed_by = ?, removed_reason = ? WHERE id = ?")
      .run(at, by, text, messageId);
    const n = db.prepare('UPDATE ticket_attachments SET removed_at = ? WHERE message_id = ? AND removed_at IS NULL').run(at, messageId).changes;
    addTicketEvent(db, ticketId, by, 'removed', { messageId, files: n }, now);
    return n;
  })();
  if (purgeRemovedFiles(db, dir) > 0) {
    publishAdminEvent({ kind: 'problem', text: 'A file attached to a removed ticket message could not be deleted from disk. It is no longer served and is tried again at the next restart. Check the permissions on the ticket attachments directory.' });
  }
  publishTicketSignal({ kind: 'ticket', ticketId });
  return { ok: true, files };
}
```

- [ ] **Step 4: The Discord half, in the mirror**

`src/discord/ticketMirror.ts`. Add `messageById` to the import from `'../tickets/messages.js'`, and add `import { purgeRemovedFiles } from '../tickets/removal.js';`.

In `start()`, change the last line so a start also finishes what is owed:

```ts
    this.enqueue(() => this.backfill());
    this.enqueue(() => this.sweep());
```

Add to the class:

```ts
  /**
   * The Discord half of every removal that still owes one: removed on the
   * site, Discord copy not yet known gone. Queued behind whatever the mirror
   * is doing, and resolves when it has run. Called on every start, by the
   * site after a removal, and by the Discord command.
   */
  sweepRemovals(): Promise<void> {
    this.enqueue(() => this.sweep());
    return this.chain;
  }

  private async sweep(): Promise<void> {
    const { db } = this.deps;
    const owed = db.prepare('SELECT id, thread_id, discord_message_id FROM ticket_messages WHERE removed_at IS NOT NULL AND discord_gone = 0 ORDER BY id')
      .all() as { id: number; thread_id: string; discord_message_id: string }[];
    for (const m of owed) {
      try {
        await this.removeInDiscord(m.thread_id, m.discord_message_id);
        db.prepare('UPDATE ticket_messages SET discord_gone = 1 WHERE id = ?').run(m.id);
      } catch (err) {
        console.error('[discord] could not delete a removed ticket message; the next start tries again:', err instanceof Error ? err.message : err);
      }
    }
  }

  /** Delete one message in Discord. Throws what Discord throws, except for
   *  what is not a failure: the thread or the message already being gone. */
  async removeInDiscord(threadId: string, discordMessageId: string): Promise<void> {
    const { db, transport } = this.deps;
    if (!(await transport.threads.exists(threadId))) return;
    try {
      await transport.remove(threadId, discordMessageId);
    } catch {
      // An archived thread refuses a delete. Open it, delete, and close it
      // again if closed is how the bot left it (a closed ticket's thread).
      await transport.threads.setArchived(threadId, false);
      await transport.remove(threadId, discordMessageId);
      if (threadByDiscordId(db, threadId)?.locked === 1) await transport.threads.setArchived(threadId, true);
    }
  }
```

And close the one race between a download and a removal. Replace `saveOne` with:

```ts
  private async saveOne(ticketId: number, messageId: number, a: InboundAttachment): Promise<void> {
    const { db, store } = this.deps;
    const r = await store.save(ticketId, a);
    const id = insertAttachment(db, {
      messageId, discordAttachmentId: a.id, filename: a.name, contentType: a.contentType ?? '',
      size: r.size, sha256: r.sha256, storedName: r.storedName, skipReason: r.skipReason,
    });
    // A large file can still be arriving when its message is removed. The
    // removal marked the rows it could see; this one came after, so it is
    // marked now and its bytes go the way of the rest.
    const m = messageById(db, messageId);
    if (m && m.removed_at !== null) {
      db.prepare('UPDATE ticket_attachments SET removed_at = ? WHERE id = ?').run(m.removed_at, id);
      purgeRemovedFiles(db, store.dir);
    }
  }
```

- [ ] **Step 5: The Discord command**

`src/discord/ticketRemove.ts`:

```ts
import type { DB } from '../db.js';
import { logAdmin } from '../admin/audit.js';
import { playerByDiscordId } from '../players.js';
import { messageByDiscordId } from '../tickets/messages.js';
import { removeMessage } from '../tickets/removal.js';
import { publishTicketSignal } from '../tickets/signals.js';
import { addTicketEvent, canSeeTicket, getTicketRow } from '../tickets/store.js';
import { threadByDiscordId } from '../tickets/threads.js';
import type { TicketMirror } from './ticketMirror.js';
import type { BotInteraction, InteractionReply } from './transport.js';

/** As it reads in Discord: right-click a message, Apps, Remove from ticket. */
export const REMOVE_COMMAND = 'Remove from ticket';

export interface TicketRemoveDeps {
  db: DB;
  attachmentsDir: string;
  /** The running mirror. A getter, because the mirror is made when the bot
   *  connects, after this handler has been handed to it. */
  mirror: () => TicketMirror | null;
}

const say = (content: string): InteractionReply => ({
  ephemeral: true,
  payload: { content, embeds: [], components: [], mentionUserIds: [] },
});
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const STAFF_ONLY = 'Staff only.';
/** One answer for "this is not a ticket thread", "not a ticket you may see"
 *  and "that message is not in this thread", on purpose. */
const NOT_HERE = 'This only works on a message inside a ticket thread you have access to.';

/**
 * Remove, from wherever the moderator happens to be. It acts at once, with
 * no confirmation, and answers privately.
 *
 * The command shows under Apps on every message in the server, for everyone,
 * so everything is checked here from scratch: the person (a Discord account
 * linked to an active moderator or admin), the place (a thread listed in
 * ticket_threads), and the ticket (canSeeTicket). Only ids arrive; what the
 * message says is never handed to this function.
 */
export async function handleRemoveCommand(
  deps: TicketRemoveDeps, i: Extract<BotInteraction, { kind: 'message_command' }>,
): Promise<InteractionReply> {
  const { db } = deps;
  const p = playerByDiscordId(db, i.userId);
  if (!p || p.status !== 'active' || (p.is_admin !== 1 && p.is_mod !== 1)) return say(STAFF_ONLY);
  const thread = threadByDiscordId(db, i.channelId);
  const ticket = thread ? getTicketRow(db, thread.ticket_id) : undefined;
  if (!thread || !ticket || !canSeeTicket(db, ticket, p.steamid)) return say(NOT_HERE);
  if (i.messageId === thread.card_message_id) return say('That is the ticket\'s own card. It is not part of the discussion, so there is nothing to remove.');
  const quiet = ticket.restricted === 1;

  const m = messageByDiscordId(db, i.messageId);
  if (m && m.thread_id !== i.channelId) return say(NOT_HERE);
  if (!m) {
    // Never copied to the site: written while the bot was away and not yet
    // backfilled, or one of the bot's own lines. There is no site copy and no
    // file to destroy, but it can still be made to go from Discord, which is
    // what the moderator is asking for.
    await deps.mirror()?.removeInDiscord(i.channelId, i.messageId);
    addTicketEvent(db, ticket.id, p.steamid, 'removed', { mirrored: false });
    logAdmin(db, p.steamid, 'ticket_remove', ticket.id, { mirrored: false, via: 'discord' }, { quiet });
    publishTicketSignal({ kind: 'ticket', ticketId: ticket.id });
    return say('Deleted. That message had not been copied to the site, so there was nothing else to remove.');
  }

  const r = removeMessage(db, deps.attachmentsDir, ticket.id, m.id, p.steamid, '');
  if (!r.ok) return say(capitalise(r.error));
  logAdmin(db, p.steamid, 'ticket_remove', ticket.id, { messageId: m.id, files: r.files, via: 'discord' }, { quiet });
  await deps.mirror()?.sweepRemovals();
  const files = r.files === 0 ? '' : ` and ${r.files} file${r.files === 1 ? '' : 's'}`;
  return say(`Removed for good: the text, its edit history${files} are deleted from the site, and the message is deleted here. This cannot be undone.`);
}
```

- [ ] **Step 6: The site route, the wiring, and the feed line**

`src/routes/tickets.ts`. Add `import { removeMessage } from '../tickets/removal.js';`. Add to `TicketRouteOpts`:

```ts
  /** Called after a removal committed: pokes the bot, if it is running, to
   *  delete the message in Discord. Never awaited by the route. */
  afterRemove: () => void;
```

destructure it, and add the route after the attachment route:

```ts
  /** Remove a mirrored message for good: text, history and files. The
   *  Discord message follows through the bot; this does not wait for it. */
  app.post('/api/mod/tickets/:id/messages/:mid/remove', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const { id, mid } = req.params as { id: string; mid: string };
    const r = removeMessage(db, attachmentsDir, Number(id), Number(mid), me, ((req.body ?? {}) as { reason?: unknown }).reason);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    logAdmin(db, me, 'ticket_remove', Number(id), { messageId: Number(mid), files: r.files }, { quiet: getTicketRow(db, Number(id))?.restricted === 1 });
    afterRemove();
    return { ok: true };
  });
```

No `broadcast('refresh')` here: `removeMessage` publishes the ticket signal, and the staff-scoped nudge does the rest.

`src/server.ts`. Add the imports:

```ts
import { purgeRemovedFiles } from './tickets/removal.js';
import { handleRemoveCommand, REMOVE_COMMAND } from './discord/ticketRemove.js';
```

The `ticketRoutes` registration gains:

```ts
    afterRemove: () => { void ticketMirror?.sweepRemovals(); },
```

In the `startBot({ ... })` call, after `opensModal: opensTicketModal,`:

```ts
      messageCommands: {
        [REMOVE_COMMAND]: (i) => handleRemoveCommand({ db: deps.db, attachmentsDir: deps.config.ticketAttachmentsDir, mirror: () => ticketMirror }, i),
      },
```

`ticketMirror` is the `let` Task 5 declared beside `let ticketSync`, which sits above both the `startBot` call and the route registrations, so both closures can read it. It is null until the bot connects, and stays null in development and in every test.

And finish what an earlier run could not. Directly after the `nudgeTicket` block Task 4 added:

```ts
  // Files of removed messages that could not be unlinked last time (a full
  // disk, a permissions fault). Rows only: with none owed this touches nothing.
  purgeRemovedFiles(deps.db, deps.config.ticketAttachmentsDir);
```

`src/discord/adminFeedPoster.ts`, in `actionText`: add `case 'ticket_remove':` to the list of ticket cases that opens the block (`case 'ticket_open': case 'ticket_claim': ...`), and inside it, above `default:`:

```ts
          case 'ticket_remove': return `${who} removed a message from ${ticket}${d.via === 'discord' ? ' from Discord' : ''}`;
```

A restricted ticket's removal is logged `quiet` and never reaches this.

- [ ] **Step 7: Run**

Run: `npx vitest run tests/ticketRemoval.test.ts tests/ticketMirror.test.ts tests/ticketAttachmentRoute.test.ts tests/ticketRoutes.test.ts tests/discordAdminFeed.test.ts && npm run typecheck`
Expected: PASS, typecheck clean. `git status --short data/` prints nothing.

- [ ] **Step 8: Commit**

```bash
git add src/tickets/removal.ts src/discord/ticketRemove.ts src/discord/ticketMirror.ts src/discord/adminFeedPoster.ts src/routes/tickets.ts src/server.ts tests/ticketRemoval.test.ts
git commit -m "Remove a mirrored message for good from the site or from Discord, keeping only a tombstone"
```

---

### Task 8: The ticket page: one timeline, thumbnails, click to reveal, Remove

The ticket page's timeline becomes what the spec describes: `ticket_events` and mirrored messages in one list, in time order, each message labelled `staff` or `reporter`.

The rule about files is built into the component now, although only phase 3 creates the channel it is about: a file from the REPORTER channel is never shown, not even fetched, until a moderator clicks to reveal it. A file from the STAFF channel shows as a thumbnail at once. `mov` is served inline but browsers mostly cannot play it, so on the page it is a link, like `txt`.

Remove goes through the app's confirm dialog, once, with words that say it cannot be undone. An optional reason is typed in one box above the timeline rather than in a box per message.

**Files:**
- Create: `web/src/routes/admin/TicketTimeline.tsx`, `web/src/routes/admin/TicketTimeline.test.tsx`
- Modify: `web/src/api.ts`, `web/src/routes/admin/AdminTicket.tsx` (the Timeline section; `eventText` moves out), `web/src/styles/app.css`, `web/src/routes/tickets.test.tsx` (the `detail` fixture and the mock)

**Interfaces:**
- Consumes: `messages` on `GET /api/mod/tickets/:id` (Task 6); `POST /api/mod/tickets/:id/messages/:mid/remove` (Task 7); `GET /api/mod/tickets/:id/attachments/:aid` (Task 6); `useAction`'s `run` and `type Run` from `web/src/routes/admin/useAction.ts`; `confirm` options `{ title, body, confirmLabel, danger }`; `fmtBytes` from `web/src/format.ts`; the `folded` event kind (phase 2a Task 1).
- Produces:
  - `web/src/api.ts`: `interface TicketAttachment`, `interface TicketMessage`, `TicketDetail.messages: TicketMessage[]`, `modApi.removeMessage(ticketId: number, messageId: number, reason: string)`, `ticketAttachmentUrl(ticketId: number, attachmentId: number): string`
  - `web/src/routes/admin/TicketTimeline.tsx`: `eventText(e: TicketEvent): string`, `interleave(events, messages)`, `TicketTimeline({ ticketId, events, messages, busy, run })`

- [ ] **Step 1: Write the failing test**

`web/src/routes/admin/TicketTimeline.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import type { TicketEvent, TicketMessage } from '../../api';
import { ConfirmHost } from '../../components/Confirm';
import { useAction } from './useAction';

const { mockMod } = vi.hoisted(() => ({ mockMod: { removeMessage: vi.fn() } }));
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, modApi: { ...actual.modApi, ...mockMod } };
});

const { TicketTimeline, interleave } = await import('./TicketTimeline');

const event = (id: number, kind: string, createdAt: string, over: Partial<TicketEvent> = {}): TicketEvent =>
  ({ id, actorId: '1', actorName: 'Mod', kind, detail: {}, createdAt, ...over });
const message = (id: number, createdAt: string, over: Partial<TicketMessage> = {}): TicketMessage => ({
  id, channel: 'staff', authorName: 'Mod on Discord', authorPlayerId: '1', authorPlayerName: 'Mod', content: `message ${id}`, history: [],
  createdAt, editedAt: null, deletedAt: null, removed: null, attachments: [], ...over,
});
const png = { id: 5, filename: 'shot.png', contentType: 'image/png', size: 2048, sha256: 'ab'.repeat(32), stored: true, skipReason: null, removed: false };

let reloads = 0;
function Harness({ events, messages }: { events: TicketEvent[]; messages: TicketMessage[] }) {
  const { busy, run } = useAction(() => { reloads++; });
  return <><TicketTimeline ticketId={12} events={events} messages={messages} busy={busy} run={run} /><ConfirmHost /></>;
}

afterEach(cleanup);
beforeEach(() => { mockMod.removeMessage.mockReset(); mockMod.removeMessage.mockResolvedValue({ ok: true }); reloads = 0; });

describe('TicketTimeline', () => {
  it('puts events and messages in one list, in time order, and labels each message', () => {
    const items = interleave(
      [event(1, 'opened', '2026-09-22T10:00:00.000Z'), event(2, 'claimed', '2026-09-22T10:05:00.000Z')],
      [message(1, '2026-09-22T10:02:00.000Z'), message(2, '2026-09-22T10:07:00.000Z', { channel: 'reporter' })],
    );
    expect(items.map((i) => i.key)).toEqual(['e1', 'm1', 'e2', 'm2']);
    render(<Harness events={[event(2, 'claimed', '2026-09-22T10:05:00.000Z')]} messages={[message(1, '2026-09-22T10:02:00.000Z'), message(2, '2026-09-22T10:07:00.000Z', { channel: 'reporter' })]} />);
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(rows[0]).toContain('staff');
    expect(rows[0]).toContain('message 1');
    expect(rows[1]).toContain('Mod claimed it');
    expect(rows[2]).toContain('reporter');
  });

  it('shows a staff file as a thumbnail at once, and says why a file was not kept', () => {
    render(<Harness events={[]} messages={[message(1, '2026-09-22T10:02:00.000Z', { attachments: [
      png, { ...png, id: 6, filename: 'tool.exe', stored: false, skipReason: 'type', sha256: null },
    ] })]} />);
    const img = screen.getByAltText('shot.png') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/mod/tickets/12/attachments/5');
    expect(img.closest('a')!.getAttribute('target')).toBe('_blank');
    expect(screen.getByText(/tool\.exe/).textContent).toMatch(/not stored: this type of file is not stored/);
  });

  it('never loads a file from the reporter channel until a moderator asks to see it', () => {
    render(<Harness events={[]} messages={[message(1, '2026-09-22T10:02:00.000Z', { channel: 'reporter', attachments: [png] })]} />);
    expect(screen.queryByAltText('shot.png')).toBeNull();
    expect(document.querySelector('img, video')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 file from the reporter' }));
    expect((screen.getByAltText('shot.png') as HTMLImageElement).getAttribute('src')).toBe('/api/mod/tickets/12/attachments/5');
  });

  it('keeps an edited message\'s earlier versions to hand, and marks one deleted in Discord', () => {
    render(<Harness events={[]} messages={[message(1, '2026-09-22T10:02:00.000Z', {
      content: 'the polite version', history: ['the first version'], editedAt: '2026-09-22T10:03:00.000Z', deletedAt: '2026-09-22T10:04:00.000Z',
    })]} />);
    expect(screen.getByText('the polite version')).toBeTruthy();
    expect(screen.getByText('1 earlier version')).toBeTruthy();
    expect(screen.getByText('the first version')).toBeTruthy();
    expect(screen.getByText(/deleted in Discord/)).toBeTruthy();
  });

  it('Remove asks once, says it cannot be undone, and sends the reason', async () => {
    render(<Harness events={[]} messages={[message(7, '2026-09-22T10:02:00.000Z', { attachments: [png] })]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    const first = await waitFor(() => screen.getByRole('alertdialog'));
    expect(first.textContent).toMatch(/cannot be undone/);
    fireEvent.click(within(first).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(mockMod.removeMessage).not.toHaveBeenCalled();

    fireEvent.input(screen.getByLabelText('Reason for a removal'), { target: { value: 'gore' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    const second = await waitFor(() => screen.getByRole('alertdialog'));
    fireEvent.click(within(second).getByRole('button', { name: 'Remove for good' }));
    await waitFor(() => expect(mockMod.removeMessage).toHaveBeenCalledWith(12, 7, 'gore'));
    await waitFor(() => expect(reloads).toBe(1));
  });

  it('a removed message is a tombstone: who, when, why, the file\'s name, size and hash, and nothing to click', () => {
    render(<Harness events={[]} messages={[message(7, '2026-09-22T10:02:00.000Z', {
      content: '', history: [], removed: { at: '2026-09-22T12:00:00.000Z', by: '1', byName: 'Mod', reason: 'gore' },
      attachments: [{ ...png, stored: false, removed: true }],
    })]} />);
    const row = screen.getByRole('listitem').textContent ?? '';
    expect(row).toMatch(/Removed by Mod/);
    expect(row).toContain('gore');
    expect(row).toContain('shot.png');
    expect(row).toContain('2.0 KB');
    expect(row).toContain('abababababababab');
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    // The author's profile link is still there; nothing points at a file.
    expect(document.querySelector('img, video, a[href*="attachments"]')).toBeNull();
  });
});
```

(`fmtBytes(2048)` in `web/src/format.ts` reads `2.0 KB`. The component must use `fmtBytes`, not its own arithmetic.)

In `web/src/routes/tickets.test.tsx`: add `removeMessage: vi.fn()` to `mockMod`, and give the `detail` fixture a default beside `discussion`:

```tsx
  messages: [],
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run web/src/routes/admin/TicketTimeline.test.tsx`
Expected: FAIL, cannot resolve `./TicketTimeline`.

- [ ] **Step 3: The types and the two calls**

`web/src/api.ts`. Above `export interface TicketDetail`:

```ts
export interface TicketAttachment {
  id: number; filename: string; contentType: string; size: number; sha256: string | null;
  /** On the server and not removed: it can be fetched. */
  stored: boolean;
  skipReason: 'too_large' | 'type' | 'quota' | 'disabled' | 'fetch_failed' | null;
  removed: boolean;
}
/** One message mirrored from a ticket's Discord thread. `removed` set means a
 *  tombstone: content and history are empty and no file can be fetched. */
export interface TicketMessage {
  id: number; channel: 'staff' | 'reporter'; authorName: string; authorPlayerId: string | null; authorPlayerName: string | null;
  content: string; history: string[]; createdAt: string; editedAt: string | null; deletedAt: string | null;
  removed: { at: string; by: string | null; byName: string | null; reason: string } | null;
  attachments: TicketAttachment[];
}
```

In `TicketDetail`, after `discussion: TicketDiscussion;`:

```ts
  messages: TicketMessage[];
```

Above `export const modApi`:

```ts
/** Where a stored ticket file is served from. A plain function, not part of
 *  modApi: it makes no request, it is what an <img> points at. */
export const ticketAttachmentUrl = (ticketId: number, attachmentId: number): string =>
  `/api/mod/tickets/${ticketId}/attachments/${attachmentId}`;
```

and in `modApi`, after `reopen`:

```ts
  removeMessage: (id: number, messageId: number, reason: string) =>
    post(`/api/mod/tickets/${id}/messages/${messageId}/remove`, { reason }),
```

- [ ] **Step 4: The timeline**

`web/src/routes/admin/TicketTimeline.tsx`:

```tsx
import { useState } from 'preact/hooks';
import { modApi, ticketAttachmentUrl, type TicketAttachment, type TicketEvent, type TicketMessage } from '../../api';
import { fmtBytes } from '../../format';
import { fmtTime, type Run } from './useAction';

export const eventText = (e: TicketEvent): string => {
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
    case 'folded': return `Ticket #${String(e.detail.from ?? '')} about the same player was folded into this one`;
    case 'removed': return e.detail.mirrored === false
      ? `${who} deleted a message in Discord that had not been copied here`
      : `${who} removed a message for good${Number(e.detail.files) > 0 ? `, with ${Number(e.detail.files)} file${Number(e.detail.files) === 1 ? '' : 's'}` : ''}`;
    default: return `${who}: ${e.kind.replace(/_/g, ' ')}`;
  }
};

export interface TimelineItem { key: string; at: string; event?: TicketEvent; message?: TicketMessage }

/** Events and messages in one list, oldest first. Ties keep the order they
 *  came in, events before messages. */
export function interleave(events: TicketEvent[], messages: TicketMessage[]): TimelineItem[] {
  const items: TimelineItem[] = [
    ...events.map((e) => ({ key: `e${e.id}`, at: e.createdAt, event: e })),
    ...messages.map((m) => ({ key: `m${m.id}`, at: m.createdAt, message: m })),
  ];
  return items.map((item, i) => ({ item, i }))
    .sort((a, b) => Date.parse(a.item.at) - Date.parse(b.item.at) || a.i - b.i)
    .map((x) => x.item);
}

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
/** mov is left out on purpose: it is served, but browsers mostly cannot play
 *  it, and a broken player is worse than a link. */
const VIDEO = /\.(mp4|webm)$/i;
const NOT_STORED: Record<string, string> = {
  too_large: 'it was too large to store',
  type: 'this type of file is not stored',
  quota: 'attachment storage was full',
  disabled: 'storing attachments is switched off',
  fetch_failed: 'the download failed; it is tried again when the bot next starts',
};

function File({ ticketId, a }: { ticketId: number; a: TicketAttachment }) {
  const size = fmtBytes(a.size);
  if (a.removed) {
    return <li class="ticket-file ticket-file--gone">{a.filename} ({size}), removed{a.sha256 ? <>, sha256 <code title={a.sha256}>{a.sha256.slice(0, 16)}</code></> : null}</li>;
  }
  if (!a.stored) return <li class="ticket-file">{a.filename} ({size}), not stored: {NOT_STORED[a.skipReason ?? ''] ?? 'it could not be kept'}</li>;
  const url = ticketAttachmentUrl(ticketId, a.id);
  if (IMAGE.test(a.filename)) {
    return <li class="ticket-file"><a href={url} target="_blank" rel="noreferrer"><img class="ticket-thumb" src={url} alt={a.filename} loading="lazy" /></a></li>;
  }
  if (VIDEO.test(a.filename)) {
    return <li class="ticket-file"><video class="ticket-thumb" src={url} controls preload="none" aria-label={a.filename} /></li>;
  }
  return <li class="ticket-file"><a href={url} target="_blank" rel="noreferrer">{a.filename}</a> ({size})</li>;
}

/**
 * A message's files. From the staff channel they show at once. From the
 * reporter channel NOTHING is rendered, so nothing is fetched, until a
 * moderator asks: a reporter is a stranger, and what a stranger attaches is
 * not put in front of someone who only opened the ticket to read it.
 */
function Files({ ticketId, m }: { ticketId: number; m: TicketMessage }) {
  const [shown, setShown] = useState(m.channel === 'staff' || m.removed !== null);
  if (m.attachments.length === 0) return null;
  if (!shown) {
    const n = m.attachments.length;
    return <p><button class="chip" type="button" onClick={() => setShown(true)}>Show {n} file{n === 1 ? '' : 's'} from the reporter</button></p>;
  }
  return <ul class="ticket-files">{m.attachments.map((a) => <File key={a.id} ticketId={ticketId} a={a} />)}</ul>;
}

function Message({ ticketId, m, reason, busy, run }: { ticketId: number; m: TicketMessage; reason: string; busy: boolean; run: Run }) {
  const marks = `${m.editedAt ? ' · edited' : ''}${m.deletedAt ? ' · deleted in Discord' : ''}`;
  return (
    <li class={`ticket-msg ticket-msg--${m.channel}`}>
      <p>
        <span class="admin-tag">{m.channel}</span>{' '}
        <strong>{m.authorPlayerId ? <a href={`/player/${m.authorPlayerId}`}>{m.authorName}</a> : m.authorName}</strong>
        <span class="muted"> · {fmtTime(m.createdAt)}{marks}</span>
      </p>
      {m.removed
        ? <p class="muted">Removed by {m.removed.byName ?? m.removed.by ?? 'staff'} on {fmtTime(m.removed.at)}{m.removed.reason ? `: ${m.removed.reason}` : ''}. The text and any files are gone for good.</p>
        : (
          <>
            {m.content && <blockquote>{m.content}</blockquote>}
            {m.history.length > 0 && (
              <details>
                <summary>{m.history.length} earlier version{m.history.length === 1 ? '' : 's'}</summary>
                <ol>{m.history.map((h, i) => <li key={i}><blockquote>{h}</blockquote></li>)}</ol>
              </details>
            )}
          </>
        )}
      <Files ticketId={ticketId} m={m} />
      {!m.removed && (
        <button class="chip" type="button" disabled={busy}
          onClick={() => run(() => modApi.removeMessage(ticketId, m.id, reason), {
            title: 'Remove this message for good?',
            body: 'Its text, its edit history and every file attached to it are deleted from the server, and the message is deleted in Discord. Only a note that something was removed is kept. This cannot be undone.',
            confirmLabel: 'Remove for good',
            danger: true,
          })}>
          Remove
        </button>
      )}
    </li>
  );
}

export function TicketTimeline(
  { ticketId, events, messages, busy, run }: { ticketId: number; events: TicketEvent[]; messages: TicketMessage[]; busy: boolean; run: Run },
) {
  const [reason, setReason] = useState('');
  const removable = messages.some((m) => !m.removed);
  return (
    <>
      {removable && (
        <div class="admin-form">
          <input value={reason} maxLength={200} placeholder="Reason for a removal (optional, staff only)" aria-label="Reason for a removal"
            onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
        </div>
      )}
      <ul class="ticket-timeline">
        {interleave(events, messages).map((item) => (item.message
          ? <Message key={item.key} ticketId={ticketId} m={item.message} reason={reason.trim()} busy={busy} run={run} />
          : <li key={item.key} class="ticket-event"><span class="muted">{fmtTime(item.event!.createdAt)}</span> {eventText(item.event!)}</li>))}
      </ul>
    </>
  );
}
```

The earlier-versions list and the file list are `ol` and `ul` inside a timeline `li`. The first test above reads `getAllByRole('listitem')` on a fixture with no history and no files, so the nesting does not disturb it; keep it that way if the fixture changes.

- [ ] **Step 5: Use it on the ticket page**

`web/src/routes/admin/AdminTicket.tsx`. Delete the whole `const eventText = (e: TicketEvent): string => { ... };` declaration (it now lives in `TicketTimeline.tsx`, with the `folded` case phase 2a added and the new `removed` case). Change the imports:

```tsx
import { modApi, type TicketDetail, type TicketDiscussion } from '../../api';
import { TicketTimeline } from './TicketTimeline';
```

(Drop `type TicketEvent`; keep `type TicketDetail` only if the file still uses it, which the typecheck will say.) In the Timeline section, replace

```tsx
        <ul class="admin-list">
          {data.events.map((e) => <li key={e.id}><span class="muted">{fmtTime(e.createdAt)}</span> {eventText(e)}</li>)}
        </ul>
```

with

```tsx
        <TicketTimeline ticketId={t.id} events={data.events} messages={data.messages} busy={busy} run={run} />
```

The `<Discussion d={data.discussion} />` line under it stays.

`web/src/styles/app.css`, directly after the `.ticket-restricted` rule:

```css
.ticket-timeline { list-style: none; margin: 0; padding: 0; }
.ticket-event { padding: var(--sp-2) 0; }
.ticket-msg { padding: var(--sp-3) 0; border-bottom: 1px solid var(--border); }
.ticket-msg p { margin: 0 0 var(--sp-2); }
.ticket-msg blockquote { margin: 0 0 var(--sp-2); padding-left: var(--sp-3); border-left: 2px solid var(--rule); color: var(--text); overflow-wrap: anywhere; white-space: pre-wrap; }
.ticket-msg--reporter blockquote { border-left-color: #c9a45c; }
.ticket-files { list-style: none; margin: 0 0 var(--sp-2); padding: 0; display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: flex-end; }
.ticket-file { overflow-wrap: anywhere; }
.ticket-file--gone { opacity: 0.7; }
.ticket-thumb { display: block; max-width: min(240px, 100%); max-height: 180px; border: 1px solid var(--border); border-radius: 4px; }
```

- [ ] **Step 6: Run**

Run: `npx vitest run web/src/routes/admin/TicketTimeline.test.tsx web/src/routes/tickets.test.tsx web/src/routes/admin.test.tsx && npm run typecheck`
Expected: PASS, typecheck clean. The existing ticket page tests still find "Opened by a report" and the folded line: the same `eventText` renders them, from its new home.

- [ ] **Step 7: Commit**

```bash
git add web/src/api.ts web/src/routes/admin/TicketTimeline.tsx web/src/routes/admin/TicketTimeline.test.tsx web/src/routes/admin/AdminTicket.tsx web/src/styles/app.css web/src/routes/tickets.test.tsx
git commit -m "Show the mirrored discussion on the ticket page with thumbnails, click to reveal for reporter files, and Remove"
```

---

### Task 9: "Report this moment": the replay control phase 1 left for later

The API and the table have taken a replay moment since phase 1, the ticket page links to it, and the Discord case card links to it. What is missing is a way for a player to attach one. It goes where the moment is: on the match page, beside the round switch above the viewer. Pressing it reads the viewer's clock and hands `{ ordinal, half, tMs }` to the report form further down the page, which opens itself and says what is attached.

The viewer is a large component with its own theater mode, so it is touched as little as possible: one optional prop, a ref it writes its clock into. The button lives outside it, which means it is not visible in theater mode; pause, leave theater, press. That is written down in the closing section.

**Files:**
- Modify: `web/src/replay/Viewer.tsx` (one prop), `web/src/routes/MatchDetail.tsx` (`MapReplay`, the page), `web/src/components/ReportPlayer.tsx`, `web/src/api.ts` (`api.report`, `ReportMoment`), `web/src/components/ReportPlayer.test.tsx`, `web/src/replay/Viewer.test.tsx`, `tests/ticketRoutes.test.ts`

**Interfaces:**
- Consumes: `POST /api/matches/:id/reports`, which already passes its whole body to `fileReport` (`src/routes/api.ts`), and `fileReport`'s `moment: { ordinal, half, tMs }` (phase 1); `usePlayback`'s `tMs` inside `Viewer`; `fmtClock(seconds)` from `web/src/format.ts`.
- Produces:
  - `web/src/api.ts`: `interface ReportMoment { ordinal: number; half: number; tMs: number }`; `api.report(matchId, targetId, category, text, moment?: ReportMoment)`
  - `Viewer` prop `momentRef?: { current: number }`
  - `ReportPlayer` props `moment?: ReportMoment | null` and `onClearMoment?: () => void`

- [ ] **Step 1: Write the failing tests**

Add to `tests/ticketRoutes.test.ts`, inside `describe('filing over HTTP', ...)`:

```ts
  it('the match page route carries a replay moment through', async () => {
    const r = await post(R1, `/api/matches/${matchId}/reports`, { targetId: ACCUSED, category: 'cheating', text: 'here', moment: { ordinal: 2, half: 1, tMs: 61500 } });
    expect(r.statusCode).toBe(200);
    expect(db.prepare('SELECT map_ordinal, half, t_ms FROM ticket_reports').get()).toEqual({ map_ordinal: 2, half: 1, t_ms: 61500 });
    expect((await post(R2, `/api/matches/${matchId}/reports`, { targetId: ACCUSED, category: 'cheating', text: '', moment: { ordinal: 2 } })).statusCode).toBe(400);
  });
```

(This one passes already. It is here because the control below depends on it, and nothing tested it over HTTP.)

Add to `web/src/components/ReportPlayer.test.tsx`, inside `describe('ReportPlayer on a match page', ...)`:

```tsx
  it('opens itself when a replay moment is handed to it, says what is attached, and sends it', async () => {
    mockApi.reportEligibility.mockResolvedValue({ canReport: true, targets: [{ steamid: '7', name: 'Walls', alreadyReported: false }] });
    mockApi.report.mockResolvedValue({ ok: true });
    const cleared = vi.fn();
    render(<ReportPlayer matchId={66} moment={{ ordinal: 2, half: 1, tMs: 61500 }} onClearMoment={cleared} />);
    await screen.findByText(/map 3, round 1, at 1:01/);
    fireEvent.change(await screen.findByLabelText('Player'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'cheating' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(mockApi.report).toHaveBeenCalledWith(66, '7', 'cheating', '', { ordinal: 2, half: 1, tMs: 61500 }));
    await waitFor(() => expect(cleared).toHaveBeenCalled());
  });

  it('a moment can be taken off again before sending', async () => {
    mockApi.reportEligibility.mockResolvedValue({ canReport: true, targets: [] });
    const cleared = vi.fn();
    render(<ReportPlayer matchId={66} moment={{ ordinal: 0, half: 2, tMs: 5000 }} onClearMoment={cleared} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Detach' }));
    expect(cleared).toHaveBeenCalled();
  });
```

(`fmtClock(61)` in `web/src/format.ts` reads `1:01`, with no leading zero on the minutes. The component must use `fmtClock`, not its own arithmetic.)

Add to `web/src/replay/Viewer.test.tsx`, inside its main `describe`:

```tsx
  it('writes its clock into momentRef, so a control outside it can ask what moment is on screen', () => {
    const momentRef = { current: -1 };
    const { container } = render(<Viewer spec={{ kind: 'file', name: 'x' }} names={NAMES} timeline={[]} seekMs={8000} momentRef={momentRef} />);
    expect((container.querySelector('.scrub__range') as HTMLInputElement).value).toBe('8000');
    expect(momentRef.current).toBe(8000);
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run web/src/components/ReportPlayer.test.tsx web/src/replay/Viewer.test.tsx tests/ticketRoutes.test.ts`
Expected: the two web files FAIL (`moment` and `momentRef` are not known props, and nothing renders "map 3"); `tests/ticketRoutes.test.ts` passes.

- [ ] **Step 3: The API call**

`web/src/api.ts`. Above `export const api`:

```ts
/** A second of a round: which map of the match, which half, how far in. */
export interface ReportMoment { ordinal: number; half: number; tMs: number }
```

Replace `api.report`:

```ts
  report: (matchId: number, targetId: string, category: string, text: string, moment?: ReportMoment) =>
    post(`/api/matches/${matchId}/reports`, moment ? { targetId, category, text, moment } : { targetId, category, text }),
```

and use the type in `fileReport`'s body (`moment?: ReportMoment`) in place of the inline shape.

- [ ] **Step 4: The viewer says what time it is**

`web/src/replay/Viewer.tsx`. Widen the props:

```tsx
export function Viewer(
  { spec, live = false, names = NO_NAMES, timeline, seekMs, momentRef }:
  {
    spec: ReplaySpec; live?: boolean; names?: Record<string, string>; timeline?: TimelineEntry[];
    seekMs?: number;
    /** Written on every render with the clock the viewer is showing, in
     *  milliseconds into the round, so a control OUTSIDE the viewer (the
     *  match page's "Report this moment") can ask without the viewer knowing
     *  what it is for. A ref, not a callback: it must never cause a render. */
    momentRef?: { current: number };
  },
) {
```

and directly after `const playback = usePlayback(endMs, { live, closed });`:

```tsx
  if (momentRef) momentRef.current = playback.tMs;
```

- [ ] **Step 5: The button, and the form that takes the moment**

`web/src/routes/MatchDetail.tsx`. Change the first import to `import { useRef, useState } from 'preact/hooks';` and add `type ReportMoment` to the import from `'../api'`.

`MapReplay` gains one prop and one ref:

```tsx
function MapReplay(
  { matchId, ordinal, names, initialHalf, seekMs, onMoment }: {
    matchId: number; ordinal: number; names: Record<string, string>;
    /** The round a deep link asked for, already validated by the caller
     *  against this match's own rounds. Undefined for an ordinary visit. */
    initialHalf?: number;
    /** Only meaningful for `initialHalf`'s own round: see the seek prop below. */
    seekMs?: number;
    /** Given for a signed-in viewer: attach what is on screen to a report. */
    onMoment?: (m: ReportMoment) => void;
  },
) {
  const [half, setHalf] = useState(initialHalf ?? 1);
  const momentRef = useRef(0);
```

In its `.replay__rounds` row, after the Round 2 button:

```tsx
        {onMoment && (
          <button class="chip" type="button" title="Pause on what you want the moderators to see, then press this"
            onClick={() => onMoment({ ordinal, half, tMs: Math.round(momentRef.current) })}>
            Report this moment
          </button>
        )}
```

and pass the ref to the viewer: add `momentRef={momentRef}` to the `<Viewer ... />` props.

In `MatchDetail`, directly after the `const [ordinal, setOrdinal] = useState<number | null>(...)` statement:

```tsx
  // A moment picked in the viewer, waiting in the report form below.
  const [moment, setMoment] = useState<ReportMoment | null>(null);
```

Add to the `<MapReplay ... />` element:

```tsx
                onMoment={me ? setMoment : undefined}
```

and change the report panel at the bottom of the page to:

```tsx
            <ReportPlayer matchId={match.id} moment={moment} onClearMoment={() => setMoment(null)} />
```

`web/src/components/ReportPlayer.tsx`. Change the imports:

```tsx
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError, type ReportEligibility, type ReportMoment } from '../api';
import { fmtClock } from '../format';
```

Widen the props:

```tsx
export function ReportPlayer(
  { matchId, target: fixed, moment, onClearMoment }: {
    matchId?: number; target?: { steamid: string; name: string };
    /** A replay moment picked in the viewer above. Match pages only. */
    moment?: ReportMoment | null;
    onClearMoment?: () => void;
  },
) {
```

Directly after the last `useState` line (`const [busy, setBusy] = useState(false);`):

```tsx
  const root = useRef<HTMLDivElement>(null);
```

and directly after the `start` function, which the effect calls and which is a `const`, so it has to come first:

```tsx
  // Picking a moment in the viewer is asking to report it: open the form...
  useEffect(() => {
    if (moment) void start();
  }, [moment]);
  // ...and bring it into view, once it exists: the form's wrapper is only
  // rendered when `open` is true, so this waits for that render. Keyed on the
  // moment object too, so picking a second moment scrolls back. jsdom has no
  // scrollIntoView, hence the optional call.
  useEffect(() => {
    if (open && moment) root.current?.scrollIntoView?.({ block: 'nearest' });
  }, [open, moment]);
```

In `submit`, replace the line `else await api.report(matchId!, target, category, text);` with:

```tsx
      else if (moment) await api.report(matchId!, target, category, text, moment);
      else await api.report(matchId!, target, category, text);
```

and after `setText('');` add:

```tsx
      if (moment) onClearMoment?.();
```

Give the open form's wrapper the ref (`<div class="report" ref={root}>`), and inside the `<form>`, directly above the `<textarea>`:

```tsx
          {moment && (
            <p class="muted">
              Attached: map {moment.ordinal + 1}, round {moment.half}, at {fmtClock(Math.floor(moment.tMs / 1000))}.{' '}
              <button class="chip" type="button" onClick={onClearMoment}>Detach</button>
            </p>
          )}
```

Two existing tests assert `api.report` was called with exactly four arguments. They still pass: with no moment the call is still made with four.

The "Detach" test above renders with `targets: []`; the form is `ready` because `elig.canReport` is true, so the attached line and its button are there.

- [ ] **Step 6: Run**

Run: `npx vitest run web/src/components/ReportPlayer.test.tsx web/src/replay/Viewer.test.tsx web/src/routes/admin.test.tsx web/src/routes/routes.test.tsx tests/ticketRoutes.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add web/src/api.ts web/src/replay/Viewer.tsx web/src/replay/Viewer.test.tsx web/src/routes/MatchDetail.tsx web/src/components/ReportPlayer.tsx web/src/components/ReportPlayer.test.tsx tests/ticketRoutes.test.ts
git commit -m "Let a player attach the replay moment on screen to a report"
```

---

### Task 10: Prove what can be proved, and say what cannot

As in phase 2a: the site half is run for real against a scratch database and a real browser, and the Discord half cannot be, because `DEV_MODE=1` keeps the bot off and the implementer has no bot and must not use the owner's. With the bot off, no message is ever mirrored by the running server. So the discussion is put into the scratch database by a throwaway script that drives the REAL `TicketMirror`, the REAL `AttachmentStore` and the REAL removal code against the fake transport and a fetcher that reads local files. What the browser then shows is real rows, real files on disk and the real serving route; what stays unproven is only the wire between Discord and the fake's shape.

**Files:** none changed unless a defect is found, then `docs/superpowers/plans/2026-09-22-tickets-phase2b.md` (a Verification section appended in Step 7).

**Interfaces:**
- Consumes: everything Tasks 1 to 9 produced; `POST /api/dev/login` (`src/routes/dev.ts`, body `{ steamid }`, 17 digits); `scripts/shoot-pages.mjs` as the model for a CDP script; `web/public/portraits/*.png` as sample images.
- Produces: a Verification section in this file.

- [ ] **Step 1: Full suite, types and build**

Run: `npm test && npm run typecheck && npm run build && git status --short data/`
Expected: every test passes (ECONNREFUSED and AbortError lines are noise from network-mocked tests), typecheck clean, `dist/public` produced, and the last command prints nothing: no test wrote into the repo's `data/` directory.

- [ ] **Step 2: Start a server on a scratch database and a scratch attachments directory, outside the repo**

```bash
SCRATCH="$(mktemp -d /tmp/tickets-2b-XXXXXX)"
mkdir -p "$SCRATCH/replays"
export DB_PATH="$SCRATCH/tickets.sqlite" TICKET_ATTACHMENTS_DIR="$SCRATCH/ticket-attachments"
DEV_MODE=1 PORT=8099 REPLAY_DIR="$SCRATCH/replays" ADMIN_STEAMIDS=76561199000000001 npx tsx src/index.ts &
sleep 3
sqlite3 "$DB_PATH" 'SELECT COUNT(*) FROM servers'
```

Expected: `0`. Do not click anything until it says `0`: a dev server over a database with `servers` rows can dial rcon at the live boxes. Never point `DB_PATH` or `TICKET_ATTACHMENTS_DIR` into the repo, and never at a copy of production.

- [ ] **Step 3: The cast, two tickets, and a discussion put there by the real mirror**

```bash
B=http://localhost:8099
login() { curl -s -c "$SCRATCH/$1.jar" -H 'content-type: application/json' -d "{\"steamid\":\"$1\"}" $B/api/dev/login >/dev/null; }
as() { curl -s -b "$SCRATCH/$1.jar" -H 'content-type: application/json' "${@:2}"; }
for id in 76561199000000001 76561199000000002 76561199000000003 76561199000000004 76561199000000006; do login $id; done
sqlite3 "$DB_PATH" "UPDATE players SET is_admin = 1 WHERE steamid IN ('76561199000000001','76561199000000002'); UPDATE players SET is_mod = 1, discord_id = '906', discord_name = 'mod' WHERE steamid = '76561199000000003';"
as 76561199000000004 -d '{"targetId":"76561199000000006","category":"griefing","text":"threw the finale"}' $B/api/reports
as 76561199000000004 -d '{"targetId":"76561199000000006","category":"unsafe","text":"details"}' $B/api/reports
```

Ticket 1 is normal, ticket 2 is restricted to the owner (`...001`). Now the discussion. Write `$SCRATCH/seed.ts` (outside the repo; it imports the worktree's code by absolute path):

```ts
import { readFileSync } from 'node:fs';
const WT = '/home/volence/l4d/pug/.claude/worktrees/tickets';
const { openDb } = await import(`${WT}/src/db.js`);
const { insertThread } = await import(`${WT}/src/tickets/threads.js`);
const { AttachmentStore } = await import(`${WT}/src/tickets/attachments.js`);
const { TicketMirror } = await import(`${WT}/src/discord/ticketMirror.js`);
const { FakeTransport } = await import(`${WT}/tests/fakes/fakeTransport.js`);

const db = openDb(process.env.DB_PATH!);
const t = new FakeTransport();
const local: Record<string, string> = {
  'https://cdn.discordapp.com/1/zoey.png': `${WT}/web/public/portraits/zoey.png`,
  'https://cdn.discordapp.com/1/bill.png': `${WT}/web/public/portraits/bill.png`,
};
const store = new AttachmentStore({
  db, dir: process.env.TICKET_ATTACHMENTS_DIR!,
  fetcher: async (url: string) => (local[url] ? { ok: true, body: (async function* () { yield new Uint8Array(readFileSync(local[url])); })() } : { ok: false, body: null }),
});
const mirror = new TicketMirror({ db, transport: t, store });
const card = { content: 'card', embeds: [], components: [] };
const threads: Record<number, string> = {};
for (const ticketId of [1, 2]) {
  const made = await t.threads.createForumPost('forum1', { name: `#${ticketId}`, message: card, tags: [] });
  insertThread(db, { ticketId, kind: 'staff', surface: ticketId === 1 ? 'forum' : 'private', channelId: 'forum1', threadId: made.threadId, cardMessageId: made.messageId, cardHash: 'h' });
  threads[ticketId] = made.threadId;
}
mirror.start();
const size = (p: string) => readFileSync(p).byteLength;
const first = t.userPost(threads[1], { authorId: '906', authorName: 'Mod on Discord', content: 'I watched the replay. He walks off the roof on purpose at 4:10.' });
t.userEdit(first.id, 'I watched the replay. He walks off the roof on purpose at 4:12.');
t.userPost(threads[1], { authorId: '555', authorName: 'Someone Unlinked', content: 'Screenshots of the chat afterwards.', attachments: [
  { id: 'a1', name: 'zoey.png', contentType: 'image/png', size: size(local['https://cdn.discordapp.com/1/zoey.png']), url: 'https://cdn.discordapp.com/1/zoey.png' },
  { id: 'a2', name: 'cheat-loader.exe', contentType: 'application/x-msdownload', size: 123456, url: 'https://cdn.discordapp.com/1/x.exe' },
] });
const doomed = t.userPost(threads[1], { authorId: '555', authorName: 'Someone Unlinked', content: 'SOMETHING THAT SHOULD NOT BE KEPT', attachments: [
  { id: 'a3', name: 'bill.png', contentType: 'image/png', size: size(local['https://cdn.discordapp.com/1/bill.png']), url: 'https://cdn.discordapp.com/1/bill.png' },
] });
const tidied = t.userPost(threads[1], { authorId: '906', authorName: 'Mod on Discord', content: 'Typed this in the wrong thread, deleting it.' });
t.userDelete(tidied.id);
t.userPost(threads[2], { authorId: '901', authorName: 'Owner on Discord', content: 'Restricted discussion. Only the access list reads this.' });
await mirror.idle();
mirror.stop();
console.log(JSON.stringify({ doomed: doomed.id }));
```

Run: `npx tsx "$SCRATCH/seed.ts"`
Expected: one line of JSON, and `ls "$TICKET_ATTACHMENTS_DIR"` lists exactly two files with 32 character hex names and no extension. `git status --short` in the worktree shows nothing new.

Then check over HTTP, and write down what came back:

1. `as 76561199000000003 $B/api/mod/tickets/1`: `messages` has four entries in time order; the first has `history` of one entry and `editedAt` set; the second has two attachments, `zoey.png` with `stored: true` and `cheat-loader.exe` with `stored: false, skipReason: "type"`; the fourth has `deletedAt` set and its content intact. The author of the first has `authorPlayerId` of the moderator; "Someone Unlinked" has `authorPlayerId: null`.
2. `as 76561199000000003 -D - -o "$SCRATCH/out.png" $B/api/mod/tickets/1/attachments/<zoey's id>`: status 200 and the headers, exactly: `x-content-type-options: nosniff`, `content-security-policy: sandbox; default-src 'none'`, `content-type: image/png`, `content-disposition: inline; filename="zoey.png"`, `cache-control: private, no-store`. `cmp "$SCRATCH/out.png" web/public/portraits/zoey.png` prints nothing.
3. The same URL as `...004` (a player): 403. As `...006` (the accused, a player): 403. With no cookie: 401.
4. `as 76561199000000003 $B/api/mod/tickets/2` (the moderator, off the list): 404. Find the restricted ticket's message as the owner; there are no attachments on it, so ask for ticket 1's attachment THROUGH ticket 2 as the owner: `$B/api/mod/tickets/2/attachments/<zoey's id>` answers 404.
5. Remove the doomed message as the moderator. Its id is the `id` of the entry in item 1's `messages` whose content is `SOMETHING THAT SHOULD NOT BE KEPT` (the number the seed script printed is its Discord id, not this). `as 76561199000000003 -d '{"reason":"not for anyone to see"}' $B/api/mod/tickets/1/messages/<that id>/remove` answers `{"ok":true}`. Then: `ls "$TICKET_ATTACHMENTS_DIR"` lists ONE file; `sqlite3 "$DB_PATH" "SELECT content, history, removed_by, removed_reason, discord_gone FROM ticket_messages WHERE removed_at IS NOT NULL"` prints `|[]|76561199000000003|not for anyone to see|0` (`discord_gone` stays 0: no bot is running to delete it in Discord, which is the honest state); `grep -c "SHOULD NOT BE KEPT" "$DB_PATH"` prints `0` after `sqlite3 "$DB_PATH" 'PRAGMA wal_checkpoint(TRUNCATE)'` (check the `-wal` file too if it still exists); bill's attachment URL now answers 404; the second removal answers 409.
6. `as 76561199000000001 $B/api/admin/audit`: a `ticket_remove` row whose detail is `{ "messageId": ..., "files": 1 }` and nothing else.
7. `sqlite3 "$DB_PATH" 'PRAGMA foreign_key_check'` prints nothing.

If step 5's `grep` finds the text after the checkpoint, SQLite has left it in a free page. That is a finding, not a pass: write it in the Verification section and tell the owner, because "blanked" is then not "gone from the file" until the page is reused or the database is vacuumed. Do not add a `VACUUM` without being asked: on the production database it rewrites the whole file.

- [ ] **Step 4: The live nudge, with two browsers' worth of sockets**

```bash
node -e '
const open = (jar, name) => { const c = require("fs").readFileSync(jar, "utf8").split("\n").find((l) => l.includes("pug_session")).split("\t");
  const ws = new WebSocket("ws://localhost:8099/ws", { headers: { cookie: `pug_session=${c[6]}` } });
  ws.onmessage = (m) => console.log(name, m.data); };
open(process.argv[1], "moderator"); open(process.argv[2], "accused"); setTimeout(() => process.exit(0), 8000);
' "$SCRATCH/76561199000000003.jar" "$SCRATCH/76561199000000006.jar" &
sleep 1
as 76561199000000003 -d '{"claim":true}' $B/api/mod/tickets/1/claim
wait %2
```

Expected: the moderator's socket prints `{"event":"tickets"}` and `{"event":"refresh"}`; the accused's socket prints `{"event":"refresh"}` only. If Node's built-in `WebSocket` refuses the `headers` option on this machine's Node, use the `ws` package that `@fastify/websocket` already brings in (`require("ws")`), which takes it.

- [ ] **Step 5: Look at it in a browser**

Layout and frame-driven bugs in this app are checked with headless Chrome over CDP, never an in-app pane. Copy `scripts/shoot-pages.mjs` to `$SCRATCH/shoot.mjs`, point `BASE` at `http://localhost:8099`, log in first with an in-page `fetch('/api/dev/login', ...)` so the real signed cookie is set, and capture at 1280 and 400 wide:

- `/admin?ticket=1` as the moderator. Look for: one timeline with events and messages in time order; `staff` tags; "edited" with "1 earlier version" that opens; zoey's portrait as a thumbnail; `cheat-loader.exe (121 KB), not stored: this type of file is not stored`; the tombstone "Removed by ... : not for anyone to see. The text and any files are gone for good." with `bill.png`, its size and a hash, and no Remove button on it; "deleted in Discord" on the tidied message with its text still readable; the reason box above the timeline.
- The same page after clicking Remove on the first message: the confirm dialog, with "This cannot be undone." Capture it, then cancel.
- `/admin?ticket=2` as the owner: the restricted discussion is there. As the moderator the page says "No such ticket."
- A match page is not needed for Task 9 unless a replay exists in the scratch setup; it does not. Say so in the notes.

To see the click-to-reveal rule with real data, flip one message by hand, reload, capture, and flip it back: `sqlite3 "$DB_PATH" "UPDATE ticket_messages SET channel = 'reporter' WHERE id = 2"`. The thumbnail is replaced by "Show 2 files from the reporter", and the network log of that page load has no request to `/attachments/`.

Open every image and look at it. Check `document.documentElement.scrollWidth <= clientWidth` on each 400 px capture, with a long unbroken string as a message if need be; fix any overflow before going on.

- [ ] **Step 6: Stop the server and clean up**

```bash
kill %1; sleep 1; ss -ltn | grep -c ':8099 ' || true
rm -rf "$SCRATCH"
```

Expected: `0` listeners on 8099.

- [ ] **Step 7: Record what was and was not verified**

Append a `## Verification (<date>)` section to this file in the style of the one in `docs/superpowers/plans/2026-09-21-tickets-phase1.md`: what was run, what was seen, and then this list, edited to match what actually happened. Do not shorten it and do not soften it.

**Not verified, and why.** Nothing in this plan was run against Discord. The implementer has no bot and `DEV_MODE=1` keeps the bot off.

- Proven against `tests/fakes/fakeTransport.ts` only: that only ticket threads are read; create, edit and delete arriving live; dropping bot, webhook and system messages; the backfill, its paging and its trigger on reopen; the retry of a failed download; the Discord delete that follows a removal, including the archived thread case and the removal made while the bot was down; the "Remove from ticket" handler.
- Proven with a fake fetcher only: every download. `httpFetcher` has one test, which proves what it REFUSES. That it can fetch a real Discord CDN link, that the link's host is one of the two it allows, and that Node's `fetch` body streams as the store expects, is proven by nothing.
- Proven by `npm run typecheck` only: every line added to `src/discord/djsTransport.ts` in Task 2. The two new intents, the partial, the four message events, `fetchAfter`, `fetchMessage`, the context menu branch and the combined command registration compile against discord.js 14.27.0 and have never run. In particular nothing proves that `Partials.Message` is enough for an edit or a delete in a thread the bot has not cached, or that registering a message command beside the slash commands leaves the slash commands as they were.
- Proven in the browser against seeded rows, not against a live mirror: the timeline, thumbnails, click to reveal, the tombstone, Remove and its confirm dialog, the serving route and its headers, the staff-scoped nudge over a real socket.
- Not exercised at all: "Report this moment" in a browser (no replay in the scratch setup; it is covered by component tests only); a video attachment in a browser; the overall storage cap with real files; a disk that refuses an unlink; an edit or a delete made in Discord while the bot was down (the mirror cannot see those, by design); whether removed text survives in a free page of the SQLite file (Step 3, item 5 says what was seen).

Commit:

```bash
git add docs/superpowers/plans/2026-09-22-tickets-phase2b.md
git commit -m "Record what the tickets phase 2b verification covered"
```

Do not merge to master and do not deploy. Hand back to the owner with the branch name, the verification notes and the owner checklist below.

---

## Deliberately left for the later phases

In the spec, not in this plan. Listed so nobody takes them for oversights.

- **Reporter threads and their relay, "Contact reporter", "End reporter chat", "Remove everything from this person", the close DM:** phase 3. What is already in place for it: `ticket_messages.channel` takes `reporter` and the mirror sets it from `ticket_threads.kind`; the page hides reporter files until asked; `removeMessage` is one message at a time and takes the author's Discord id from the row, so "everything from this person" is a loop over `WHERE ticket_id = ? AND author_discord_id = ?` plus the sweep; the mirror already watches any thread listed in `ticket_threads`, whatever its kind.
- **Removing a single attachment and keeping the message.** The spec's permission table says "a message or attachment"; its Removal section defines Remove on a message. This plan builds the second. A message's files go with it.
- **Blocking a re-upload by hash, and expiring old attachments.** Out of scope in the spec. The sha256 is kept on the tombstone so the first can be added.
- **Edits and deletes made while the bot was down.** Discord has no "changes since". A message already stored keeps the content it had when last seen.
- **`Range` requests on the serving route.** A video plays from the start and cannot be scrubbed until it has loaded.
- **"Report this moment" inside theater mode.** The button sits outside the viewer. Pause, leave theater, press.
- **A backup of the attachments directory.** Left out on purpose, by the spec: removing a file has to remove every copy the system holds. The consequence is that a lost disk loses the files and keeps their rows; the page then shows each as a 404. Nothing should "fix" this by adding the directory to the 6 hourly backup.

## What this plan decided that the spec did not

- **The nudge goes only to staff who can see THAT ticket,** not to all staff. A moderator off a restricted ticket's list, and a member of staff the ticket is about, do not even learn that something happened.
- **The nudge is driven by the ticket signal,** so every ticket action refreshes open ticket pages, not only chat. Routes keep their `broadcast('refresh')` as phase 1 wrote them.
- **The mirror backfills one ticket on every signal for that ticket,** not only on reopen. It costs one REST call per ticket action and keeps the mirror from having to know what changed.
- **The type of a file is its last extension and nothing else,** `jpeg` counts as `jpg`, and the served content type is ours. Discord's claimed type is recorded and never trusted.
- **Two columns beyond the spec:** `ticket_messages.discord_gone` (so a removal commits on the site first and its Discord delete survives a restart) and `ticket_attachments.discord_attachment_id` (so a retried download can find its attachment in a freshly fetched message).
- **The Discord delete is not part of the Remove request.** The site blanks, unlinks and answers; the bot deletes in Discord moments later, or when it is next up.
- **A file that cannot be unlinked** keeps its row's `stored_name`, stops being served at once, is reported to the admin feed with no detail, and is retried at every server start.
- **A download that finishes after its message was removed** is destroyed on arrival.
- **"Remove from ticket" on a message the mirror never copied** deletes it in Discord and records a `removed` event with `mirrored: false`. On the ticket's own card it refuses.
- **The command is visible to everyone** under Apps, because no Discord permission means "staff" here. Everyone but staff gets "Staff only."
- **A non-staff request to the serving route gets 403,** as every `/api/mod` route gives, before any ticket or file is looked up. Everything after that check is a uniform 404.
- **Edit history is capped at 50 versions per message,** newest kept.
- **One optional removal reason box above the timeline,** not one per message, capped at 200 characters; the Discord command sends none.
- **The real fetcher only dials `cdn.discordapp.com` and `media.discordapp.net` over https and follows no redirect.**
- **The overall cap's `problem` event fires once** until space has been freed and run out again.
- **The tombstone keeps who WROTE the message** as well as who removed it.

## Owner checklist

Nothing here is done by the implementer, and none of it is in code or tests.

Already done: the Message Content intent is ON in the developer portal; both channels exist in guild `1539966341543633117` (tickets text channel `1551668103199461497`, moderator forum `1551668183906394204`), and phase 2a's checklist covered their permissions and the two Settings entries.

Before the deploy:

1. The bot's role has Manage Messages in BOTH channels. It deletes other people's messages when one is removed; without it every Discord delete fails and is retried at each start for ever.
2. Decide where the files live. The default is `ticket-attachments` beside the database. To put them elsewhere set `TICKET_ATTACHMENTS_DIR` in the box's `.env`. The service user must be able to create and write it. It must NOT be under the web root, and it must NOT be added to the 6 hourly backup: that is what makes Remove mean what it says.
3. Check the disk has room for `ticket_attachments_total_mb` (default 2048). The demos have filled this box before.

After the deploy, in Settings (Discord group): leave "Store ticket attachments" on, and look at the three size settings once.

The manual checks that stand in for the tests `djsTransport.ts` cannot have. Do them once, with a second account:

4. Write a message in a ticket's forum thread. Within a second or two the ticket page, already open in a browser, shows it under Timeline, tagged `staff`, without a reload. Open the same page as someone who is not staff in another browser: nothing there changes or refetches.
5. Edit the message in Discord. The page shows the new text, "edited", and "1 earlier version". Delete it in Discord. The page still shows the text, marked "deleted in Discord".
6. Write in any OTHER channel of the server, and in a thread that is not a ticket. Nothing appears anywhere on the site. (`SELECT COUNT(*) FROM ticket_messages` does not move.)
7. Post a png, an mp4 and a zip in a ticket thread. The png and the mp4 show on the page; the zip is listed as not stored. On the box, the attachments directory holds two files with random names and no extension.
8. Restart the service while typing two more messages in the thread during the restart. Both appear on the page once the bot is back: that is the backfill.
9. Right-click a message in a ticket thread, Apps, "Remove from ticket". The reply is private and says it cannot be undone; the message vanishes from Discord; the page shows a tombstone; the file is gone from the directory. Do the same from the ticket page's Remove button on another message, and watch it vanish from Discord a moment later.
10. Use "Remove from ticket" from the second account (not staff) on a message in a channel it can see: "Staff only." and nothing happens. Use it as staff on a message outside any ticket thread: it says it only works inside a ticket thread.
11. Check the slash commands (`/queue`, `/report` and the rest) still appear and still work. They are registered in the same call as the new command.
12. Close a ticket, then remove one of its messages from the site. The post stays locked and archived, and the message is gone from it.
13. In a restricted ticket's private thread, write a message and attach an image. Only the access list sees it on the site; a moderator off the list gets "No such ticket." and a 404 for the image's URL pasted directly.

