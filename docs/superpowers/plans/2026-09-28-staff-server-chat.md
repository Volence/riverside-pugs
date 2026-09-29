# Staff Server Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff read every server's chat live on the site and answer to all, one team, or one player; players answer staff privately with `/staff`.

**Architecture:** pug-match already streams every human chat line as a signed `PUGSAY` log line. The site starts storing those in a new `server_chat` table and tells staff browsers over the existing hub (`Hub.sendTo`). Sends go out over rcon as one new pug-match server command, `sm_pug_staffsay`, which prints the message in colour and logs a signed `PUGSTAFFSENT` delivery line. Players' `/staff` messages are a new signed `PUGSTAFF` line. The chat is a drawer on the Live board (`/admin/live?chat=<serverId>`), and the Live desk opens to moderators with the match-rescue actions; server controls stay admin-only.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, vitest, Preact (web), SourcePawn 1.12 (plugin, built by `plugin/build.sh` under wine).

**Spec:** `docs/superpowers/specs/2026-09-28-staff-server-chat-design.md`

## Global Constraints

- Work in the worktree `/home/volence/l4d/pug/.claude/worktrees/staff-chat`, branch `staff-chat`. Never commit to master. Start every task with `git -C /home/volence/l4d/pug/.claude/worktrees/staff-chat branch --show-current` and stop if it does not print `staff-chat`.
- Staff means `players.is_admin = 1 OR players.is_mod = 1` AND `inGoodStanding` (`makeRequireMod` for routes).
- Staff see everything, team chat included, in any match. No hiding rules.
- Moderators get the whole Live desk and these actions: abandon clock (Hold / +5 min / End now), queue removal, practice servers (players, kick, end), abort / void. Admin-only: pool in/out, restart after match, SourceTV, log signing, Set idle, DLC check, admin sync, settings.
- Chat is kept for good. No pruning.
- The site only ever sends `sm_pug_staffsay`. No other command is built from user input.
- Message: `;`, `"`, `\r`, `\n` become spaces, whitespace collapsed, trimmed, 1 to 190 characters after that. Staff name: same stripping, capped at 32, fallback `Staff`.
- Rate limit: 5 sends per 10 s per staff SteamID (HTTP 429).
- `/staff` cooldown 5 s per player. Admin feed posts at most once per player per 10 minutes, no ping.
- Every whisper prints a second line: `Reply privately with /staff <message>`.
- No em dashes anywhere (code, comments, copy, commits).
- Plugin version becomes `0.3.16`.
- Every task ends with `npm run typecheck` and the task's tests passing; any task touching `web/` also runs `npm run build`.

## Review Focus

1. A chat message containing `steamid=`, ` msg=`, ` id=` or ` delivered=` must not change who said it or which send it confirms (text is always last on the line).
2. A `PUGSTAFFSENT` line from server B must not mark a send made to server A as delivered (delivery is matched on send id AND server id).
3. A staff message containing `"; quit` or a line break must reach the game as plain text, never as a second console command.
4. A moderator calling a server-control route directly (pool, restart, SourceTV, log signing, Set idle, DLC check, admin sync, settings) gets 403, even though the Live desk now renders for them.
5. A demoted or banned moderator with an open tab stops receiving chat events and gets 403 on every chat route.

---

### Task 1: Parser: PUGSAY scope, PUGSTAFF, PUGSTAFFSENT

**Files:**
- Modify: `src/logParse.ts` (LogEvent union near line 219; PUGSAY branch near line 593)
- Modify: `src/logListener.ts:78-81` (token-less kinds list)
- Modify: `src/aliases.ts:75` (ID_FIELDS)
- Test: `tests/staffChatParse.test.ts`

**Interfaces:**
- Produces:
  - `{ kind: 'say'; steamid: string; team: number | null; message: string; scope: 'all' | 'team' | null }` (scope null when the plugin did not send it)
  - `{ kind: 'staff_in'; steamid: string; team: number | null; message: string }`
  - `{ kind: 'staff_sent'; sendId: number; delivered: number }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/staffChatParse.test.ts
import { describe, it, expect } from 'vitest';
import { parseLogDatagram } from '../src/logParse.js';

const P = '76561199048276493';
const V = '76561199122132251';
const parse = (line: string) => parseLogDatagram(Buffer.from(line, 'utf8'));

describe('PUGSAY scope', () => {
  it('reads scope=team and scope=all', () => {
    expect(parse(`PUGSAY steamid=${P} team=2 scope=team msg=rush now`))
      .toEqual({ kind: 'say', steamid: P, team: 2, scope: 'team', message: 'rush now' });
    expect(parse(`PUGSAY steamid=${P} team=3 scope=all msg=gg`))
      .toMatchObject({ scope: 'all' });
  });
  it('an older plugin without scope reads as null', () => {
    expect(parse(`PUGSAY steamid=${P} team=2 msg=hi`)).toMatchObject({ scope: null });
  });
  it('an unknown scope word is null, not a refused line', () => {
    expect(parse(`PUGSAY steamid=${P} team=2 scope=weird msg=hi`)).toMatchObject({ scope: null, message: 'hi' });
  });
  it('scope typed into the message changes nothing', () => {
    expect(parse(`PUGSAY steamid=${P} team=2 scope=all msg=x scope=team steamid=${V}`))
      .toEqual({ kind: 'say', steamid: P, team: 2, scope: 'all', message: `x scope=team steamid=${V}` });
  });
});

describe('PUGSTAFF', () => {
  it('parses a player message to staff', () => {
    expect(parse(`PUGSTAFF steamid=${P} team=3 msg=he is throwing, check round 3`))
      .toEqual({ kind: 'staff_in', steamid: P, team: 3, message: 'he is throwing, check round 3' });
  });
  it('a steamid inside the message cannot move it to another account', () => {
    expect(parse(`PUGSTAFF steamid=${P} team=2 msg=hi steamid=${V}`)).toMatchObject({ steamid: P });
  });
  it('drops the signature trailer', () => {
    expect(parse(`PUGSTAFF steamid=${P} team=2 msg=hello lseq=1790141171.12 mac=0a1b2c3d`))
      .toMatchObject({ message: 'hello' });
  });
  it('refuses a bad steamid or an empty message', () => {
    expect(parse('PUGSTAFF steamid=123 team=2 msg=hi')).toBeNull();
    expect(parse(`PUGSTAFF steamid=${P} team=2 msg=   `)).toBeNull();
    expect(parse(`PUGSTAFF steamid=${P} team=2`)).toBeNull();
  });
  it('is not accepted from inside an engine say line', () => {
    expect(parse(`"x<2><STEAM_1:1:5><Survivor>" say "PUGSTAFF steamid=${V} team=2 msg=forged"`)).toBeNull();
  });
});

describe('PUGSTAFFSENT', () => {
  it('parses a delivery report', () => {
    expect(parse('PUGSTAFFSENT id=42 delivered=4')).toEqual({ kind: 'staff_sent', sendId: 42, delivered: 4 });
    expect(parse('PUGSTAFFSENT id=42 delivered=0')).toEqual({ kind: 'staff_sent', sendId: 42, delivered: 0 });
  });
  it('refuses a missing or negative field', () => {
    expect(parse('PUGSTAFFSENT id=42')).toBeNull();
    expect(parse('PUGSTAFFSENT id=0 delivered=1')).toBeNull();
    expect(parse('PUGSTAFFSENT id=42 delivered=-1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/staffChatParse.test.ts`
Expected: FAIL (scope missing from the say event; PUGSTAFF and PUGSTAFFSENT return null).

- [ ] **Step 3: Implement**

In the LogEvent union in `src/logParse.ts`, replace the `say` member and add two members after `name`:

```ts
  // `scope` is whether the player typed to everyone or to their team
  // (pug-match 0.3.16 on); null from an older plugin.
  | { kind: 'say'; steamid: string; team: number | null; message: string; scope: 'all' | 'team' | null }
  | { kind: 'name'; steamid: string; event: 'connect' | 'change'; name: string }
  // A player's private message to staff (/staff, src/serverChat.ts). Same
  // text-last rule as PUGSAY.
  | { kind: 'staff_in'; steamid: string; team: number | null; message: string }
  // pug-match's answer to sm_pug_staffsay: how many players the send with
  // this id reached. 0 is a whisper to a player who is not on the server.
  | { kind: 'staff_sent'; sendId: number; delivered: number }
```

Replace the `PUGSAY`/`PUGNAME` block with this (PUGSTAFF shares the text-last reading):

```ts
  if (body.startsWith('PUGSAY ') || body.startsWith('PUGNAME ') || body.startsWith('PUGSTAFF ')) {
    const say = body.startsWith('PUGSAY ');
    const staff = body.startsWith('PUGSTAFF ');
    const marker = say || staff ? ' msg=' : ' name=';
    const at = body.indexOf(marker);
    if (at < 0) return null;
    const head = kv(body.slice(0, at).split(/\s+/).slice(1));
    const text = body.slice(at + marker.length);
    const steamid = steamId64Of(head.steamid ?? '');
    if (!steamid || !text.trim()) return null;
    const teamNo = intOf(head.team);
    const team = teamNo !== null && teamNo >= 0 && teamNo <= 3 ? teamNo : null;
    if (staff) return { kind: 'staff_in', steamid, team, message: text };
    if (say) {
      const scope = head.scope === 'all' || head.scope === 'team' ? head.scope : null;
      return { kind: 'say', steamid, team, scope, message: text };
    }
    if (head.event !== 'connect' && head.event !== 'change') return null;
    return { kind: 'name', steamid, event: head.event, name: text.slice(0, 128) };
  }

  // Token-less like PUGNET: the marker opens the line, nothing a player types
  // can reach it, and neither field is player text.
  if (body.startsWith('PUGSTAFFSENT ')) {
    const f = kv(body.slice('PUGSTAFFSENT '.length).split(/\s+/));
    const sendId = intOf(f.id);
    const delivered = intOf(f.delivered);
    if (sendId === null || sendId < 1 || delivered === null || delivered < 0) return null;
    return { kind: 'staff_sent', sendId, delivered };
  }
```

`PUGSTAFFSENT ` starts with `PUGSTAFF`, but not with `PUGSTAFF ` (space), so the first branch never takes it. Keep that trailing space.

In `src/logListener.ts`, add `|| ev.kind === 'staff_in' || ev.kind === 'staff_sent'` to the token-less kinds condition next to `ev.kind === 'call'`.

In `src/aliases.ts` ID_FIELDS, add `staff_in: ['steamid'],` beside `say`.

Existing tests expect `say` events without `scope`. Run `grep -rn "kind: 'say'" tests src` and add `scope: null` where a test uses `toEqual` on a say event (conductFlags.test.ts line ~17 at least).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/staffChatParse.test.ts tests/conductFlags.test.ts tests/conduct.test.ts tests/logListener.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/logParse.ts src/logListener.ts src/aliases.ts tests/
git commit -m "staff chat: parse PUGSAY scope, PUGSTAFF and PUGSTAFFSENT"
```

---

### Task 2: Storage: server_chat table and store module

**Files:**
- Modify: `src/db.ts` (SCHEMA string, beside `match_chat` near line 286)
- Modify: `src/mergePlayers.ts` (PLAIN list)
- Create: `src/serverChat.ts`
- Test: `tests/serverChat.test.ts`

**Interfaces:**
- Consumes: the Task 1 event types.
- Produces (all in `src/serverChat.ts`):
  - `export interface ChatLineRow { id: number; server_id: number; at: number; steamid: string | null; name: string | null; team: number | null; scope: 'all' | 'team' | null; kind: 'say' | 'staff_in' | 'staff_out'; message: string; match_id: number | null; to_kind: 'all' | 'team' | 'player' | null; to_value: string | null; sent_by: string | null; delivered: number | null }`
  - `export function noteName(steamid: string, name: string): void`
  - `export function recordSay(db: DB, serverId: number, ev: { steamid: string; team: number | null; scope: 'all' | 'team' | null; message: string }, now?: number): number`
  - `export function recordStaffIn(db: DB, serverId: number, ev: { steamid: string; team: number | null; message: string }, now?: number): number`
  - `export function recordStaffOut(db: DB, serverId: number, row: { sentBy: string; name: string; toKind: 'all' | 'team' | 'player'; toValue: string | null; message: string }, now?: number): number`
  - `export function markDelivered(db: DB, serverId: number, sendId: number, delivered: number): boolean` (true when a row changed)
  - `export function listLines(db: DB, serverId: number, after: number, limit: number): ChatLineRow[]` (oldest first; with `after = 0`, the newest `limit` lines)
  - `export function liveMatchOn(db: DB, serverId: number): number | null`
  - `export function _resetNames(): void` (tests)

- [ ] **Step 1: Write the failing test**

```ts
// tests/serverChat.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import {
  _resetNames, listLines, markDelivered, noteName, recordSay, recordStaffIn, recordStaffOut,
} from '../src/serverChat.js';

const P = '76561199048276493';
const MOD = '76561199000000009';
const server = (db: DB, name: string): number => Number(db.prepare(
  "INSERT INTO servers (name, host, port, rcon_port, rcon_password, tv_port, tv_enabled) VALUES (?, '1.2.3.4', 27015, 27015, 'x', 27020, 1)",
).run(name).lastInsertRowid);
let db: DB;
let s1: number;
let s2: number;

beforeEach(() => {
  db = openDb(':memory:');
  _resetNames();
  s1 = server(db, 'Dallas');
  s2 = server(db, 'Chicago');
});

describe('server_chat store', () => {
  it('stores a say line with the in-game name last seen, and lists it', () => {
    noteName(P, 'Zoey Main');
    recordSay(db, s1, { steamid: P, team: 2, scope: 'team', message: 'rush' }, 1000);
    const [row] = listLines(db, s1, 0, 200);
    expect(row).toMatchObject({ server_id: s1, at: 1000, steamid: P, name: 'Zoey Main', team: 2, scope: 'team', kind: 'say', message: 'rush', match_id: null });
  });

  it('falls back to the site name, then null', () => {
    upsertPlayer(db, { steamid: P, name: 'Site Name', avatar: null }, []);
    recordSay(db, s1, { steamid: P, team: 2, scope: null, message: 'a' });
    recordSay(db, s1, { steamid: '76561199000000001', team: 3, scope: null, message: 'b' });
    const rows = listLines(db, s1, 0, 200);
    expect(rows.map((r) => r.name)).toEqual(['Site Name', null]);
  });

  it('keeps servers apart and pages with after', () => {
    const a = recordSay(db, s1, { steamid: P, team: 2, scope: null, message: 'one' });
    recordSay(db, s2, { steamid: P, team: 2, scope: null, message: 'other server' });
    recordSay(db, s1, { steamid: P, team: 2, scope: null, message: 'two' });
    expect(listLines(db, s1, 0, 200).map((r) => r.message)).toEqual(['one', 'two']);
    expect(listLines(db, s1, a, 200).map((r) => r.message)).toEqual(['two']);
  });

  it('with after = 0 returns the newest limit lines, oldest first', () => {
    for (let i = 0; i < 5; i++) recordSay(db, s1, { steamid: P, team: 2, scope: null, message: `m${i}` });
    expect(listLines(db, s1, 0, 3).map((r) => r.message)).toEqual(['m2', 'm3', 'm4']);
  });

  it('records a /staff message and a staff send', () => {
    recordStaffIn(db, s1, { steamid: P, team: 3, message: 'help' });
    const id = recordStaffOut(db, s1, { sentBy: MOD, name: 'Volence', toKind: 'player', toValue: P, message: 'on it' });
    const rows = listLines(db, s1, 0, 200);
    expect(rows[0]).toMatchObject({ kind: 'staff_in', steamid: P, message: 'help' });
    expect(rows[1]).toMatchObject({ id, kind: 'staff_out', steamid: null, name: 'Volence', sent_by: MOD, to_kind: 'player', to_value: P, delivered: null });
  });

  it('marks delivery only for the server that was sent to', () => {
    const id = recordStaffOut(db, s1, { sentBy: MOD, name: 'V', toKind: 'all', toValue: null, message: 'hi' });
    expect(markDelivered(db, s2, id, 8)).toBe(false);
    expect(markDelivered(db, s1, id, 4)).toBe(true);
    expect(listLines(db, s1, 0, 200)[0].delivered).toBe(4);
  });

  it('never marks delivery on a player line', () => {
    const id = recordSay(db, s1, { steamid: P, team: 2, scope: null, message: 'x' });
    expect(markDelivered(db, s1, id, 3)).toBe(false);
  });

  it('tags the live match on that server', () => {
    const m = Number(db.prepare("INSERT INTO matches (season_id, state, campaign, server_id) VALUES (1, 'live', 'no_mercy', ?)").run(s1).lastInsertRowid);
    recordSay(db, s1, { steamid: P, team: 2, scope: null, message: 'x' });
    expect(listLines(db, s1, 0, 200)[0].match_id).toBe(m);
  });
});
```

The server and match inserts follow `tests/modCallPoster.test.ts`, which is known to satisfy the schema.

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/serverChat.test.ts`
Expected: FAIL, module `../src/serverChat.js` not found.

- [ ] **Step 3: Implement**

Add to the SCHEMA string in `src/db.ts`, right after the `match_chat` table:

```sql
-- Every human chat line on every server, in a match or not, plus players'
-- /staff messages and what staff sent back (src/serverChat.ts). Kept for
-- good, like match_chat. steamid is NULL on a staff_out row, whose author is
-- sent_by. name is a snapshot: the in-game name last seen, else the site
-- name, so an old line still says who it was after a rename.
CREATE TABLE IF NOT EXISTS server_chat (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id  INTEGER NOT NULL,
  at         INTEGER NOT NULL,
  steamid    TEXT,
  name       TEXT,
  team       INTEGER,
  scope      TEXT,
  kind       TEXT    NOT NULL,
  message    TEXT    NOT NULL,
  match_id   INTEGER,
  to_kind    TEXT,
  to_value   TEXT,
  sent_by    TEXT,
  delivered  INTEGER
);
CREATE INDEX IF NOT EXISTS server_chat_by_server ON server_chat (server_id, id);
```

In `src/mergePlayers.ts` PLAIN, add after `['match_chat', 'steamid'],`:

```ts
  ['server_chat', 'steamid'],
  ['server_chat', 'sent_by'],
  // A whisper target. On a team or all row to_value is a team number or
  // NULL, which never equals a SteamID64, so a plain rewrite is safe.
  ['server_chat', 'to_value'],
```

Create `src/serverChat.ts`:

```ts
import type { DB } from './db.js';

/**
 * Live server chat for staff (spec 2026-09-28-staff-server-chat-design.md).
 * Every human chat line pug-match reports is kept here with the server it came
 * from; so are players' /staff messages and what staff sent back. The page
 * reads it through src/routes/serverChat.ts.
 */

export interface ChatLineRow {
  id: number; server_id: number; at: number; steamid: string | null; name: string | null;
  team: number | null; scope: 'all' | 'team' | null; kind: 'say' | 'staff_in' | 'staff_out';
  message: string; match_id: number | null; to_kind: 'all' | 'team' | 'player' | null;
  to_value: string | null; sent_by: string | null; delivered: number | null;
}

/** The in-game name each SteamID last connected or renamed with (PUGNAME).
 *  In memory: after a restart the site name stands in until they rename or
 *  reconnect. */
const names = new Map<string, string>();

export function noteName(steamid: string, name: string): void { names.set(steamid, name); }
export function _resetNames(): void { names.clear(); }

function nameOf(db: DB, steamid: string): string | null {
  const seen = names.get(steamid);
  if (seen) return seen;
  const row = db.prepare('SELECT name FROM players WHERE steamid = ?').get(steamid) as { name: string | null } | undefined;
  return row?.name ?? null;
}

/** The match live on this server right now, if any. */
export function liveMatchOn(db: DB, serverId: number): number | null {
  const row = db.prepare("SELECT id FROM matches WHERE server_id = ? AND state = 'live' ORDER BY id DESC LIMIT 1")
    .get(serverId) as { id: number } | undefined;
  return row?.id ?? null;
}

const INSERT = `INSERT INTO server_chat
  (server_id, at, steamid, name, team, scope, kind, message, match_id, to_kind, to_value, sent_by, delivered)
  VALUES (@server_id, @at, @steamid, @name, @team, @scope, @kind, @message, @match_id, @to_kind, @to_value, @sent_by, NULL)`;

function insert(db: DB, row: Omit<ChatLineRow, 'id' | 'delivered'>): number {
  return Number(db.prepare(INSERT).run(row).lastInsertRowid);
}

export function recordSay(
  db: DB, serverId: number,
  ev: { steamid: string; team: number | null; scope: 'all' | 'team' | null; message: string },
  now = Date.now(),
): number {
  return insert(db, {
    server_id: serverId, at: now, steamid: ev.steamid, name: nameOf(db, ev.steamid), team: ev.team,
    scope: ev.scope, kind: 'say', message: ev.message, match_id: liveMatchOn(db, serverId),
    to_kind: null, to_value: null, sent_by: null,
  });
}

export function recordStaffIn(
  db: DB, serverId: number, ev: { steamid: string; team: number | null; message: string }, now = Date.now(),
): number {
  return insert(db, {
    server_id: serverId, at: now, steamid: ev.steamid, name: nameOf(db, ev.steamid), team: ev.team,
    scope: null, kind: 'staff_in', message: ev.message, match_id: liveMatchOn(db, serverId),
    to_kind: null, to_value: null, sent_by: null,
  });
}

export function recordStaffOut(
  db: DB, serverId: number,
  row: { sentBy: string; name: string; toKind: 'all' | 'team' | 'player'; toValue: string | null; message: string },
  now = Date.now(),
): number {
  return insert(db, {
    server_id: serverId, at: now, steamid: null, name: row.name, team: null, scope: null, kind: 'staff_out',
    message: row.message, match_id: liveMatchOn(db, serverId), to_kind: row.toKind, to_value: row.toValue,
    sent_by: row.sentBy,
  });
}

/** A delivery report is believed only from the server the send went to, and
 *  only for a staff_out row: a line from another box cannot touch it. */
export function markDelivered(db: DB, serverId: number, sendId: number, delivered: number): boolean {
  return db.prepare("UPDATE server_chat SET delivered = ? WHERE id = ? AND server_id = ? AND kind = 'staff_out'")
    .run(delivered, sendId, serverId).changes > 0;
}

/** Oldest first. `after = 0` means "the newest `limit` lines". */
export function listLines(db: DB, serverId: number, after: number, limit: number): ChatLineRow[] {
  if (after > 0) {
    return db.prepare('SELECT * FROM server_chat WHERE server_id = ? AND id > ? ORDER BY id LIMIT ?')
      .all(serverId, after, limit) as ChatLineRow[];
  }
  return (db.prepare('SELECT * FROM server_chat WHERE server_id = ? ORDER BY id DESC LIMIT ?')
    .all(serverId, limit) as ChatLineRow[]).reverse();
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/serverChat.test.ts tests/mergePlayers.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/mergePlayers.ts src/serverChat.ts tests/serverChat.test.ts
git commit -m "staff chat: server_chat table and store"
```

---

### Task 3: Ingest, hub event, admin feed line

**Files:**
- Modify: `src/serverChat.ts` (add the handler and staff check)
- Modify: `src/server.ts` (near line 966, the say/name branch)
- Modify: `src/adminFeed.ts` (event union and FEED_SETTING)
- Modify: `src/discord/adminFeedPoster.ts` (one new case)
- Modify: `src/settingsSchema.ts` (one toggle, after `admin_feed_conduct` near line 79), `src/db.ts` (default near line 850)
- Test: `tests/serverChatIngest.test.ts`, `tests/discordAdminFeed.test.ts` (one new case)

**Interfaces:**
- Consumes: Task 1 events, Task 2 store.
- Produces:
  - `export const STAFF_FEED_QUIET_MS = 10 * 60_000`
  - `export function isActiveStaff(db: DB, steamid: string): boolean`
  - `export function handleServerChatEvent(db: DB, ev: Extract<LogEvent, { kind: 'say' | 'name' | 'staff_in' | 'staff_sent' }>, serverId: number | null, notify: () => void, now?: number): void`
  - `export function _resetFeedQuiet(): void`
  - Admin feed kind `{ kind: 'staff_message'; steamid: string; serverId: number; text: string }`, toggle `admin_feed_staff_messages` (default `'1'`)
  - Hub event name `'server_chat'`, sent only to active staff

- [ ] **Step 1: Write the failing tests**

```ts
// tests/serverChatIngest.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import {
  STAFF_FEED_QUIET_MS, _resetFeedQuiet, _resetNames, handleServerChatEvent, isActiveStaff, listLines, recordStaffOut,
} from '../src/serverChat.js';

const P = '76561199048276493';
const MOD = '76561199000000009';
const server = (db: DB, name: string): number => Number(db.prepare(
  "INSERT INTO servers (name, host, port, rcon_port, rcon_password, tv_port, tv_enabled) VALUES (?, '1.2.3.4', 27015, 27015, 'x', 27020, 1)",
).run(name).lastInsertRowid);
let db: DB;
let s1: number;
let events: AdminEvent[];
let off: () => void;

beforeEach(() => {
  db = openDb(':memory:');
  _resetNames();
  _resetFeedQuiet();
  s1 = server(db, 'Dallas');
  events = [];
  off = subscribeAdminEvents((e) => events.push(e));
});
afterEach(() => off());

describe('handleServerChatEvent', () => {
  it('stores a say line and notifies', () => {
    const notify = vi.fn();
    handleServerChatEvent(db, { kind: 'say', steamid: P, team: 2, scope: 'all', message: 'hi' }, s1, notify);
    expect(listLines(db, s1, 0, 10)).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('a name event names later lines and does not notify', () => {
    const notify = vi.fn();
    handleServerChatEvent(db, { kind: 'name', steamid: P, event: 'connect', name: 'Zoey' }, s1, notify);
    handleServerChatEvent(db, { kind: 'say', steamid: P, team: 2, scope: null, message: 'x' }, s1, notify);
    expect(listLines(db, s1, 0, 10)[0].name).toBe('Zoey');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('drops a line whose server is unknown', () => {
    const notify = vi.fn();
    handleServerChatEvent(db, { kind: 'say', steamid: P, team: 2, scope: null, message: 'x' }, null, notify);
    expect(db.prepare('SELECT COUNT(*) AS n FROM server_chat').get()).toEqual({ n: 0 });
    expect(notify).not.toHaveBeenCalled();
  });

  it('a /staff message posts to the admin feed once per player per quiet window', () => {
    const t0 = 1_000_000;
    const msg = (message: string, at: number) =>
      handleServerChatEvent(db, { kind: 'staff_in', steamid: P, team: 3, message }, s1, () => {}, at);
    msg('first', t0);
    msg('second', t0 + 60_000);
    msg('later', t0 + STAFF_FEED_QUIET_MS + 1);
    expect(events).toEqual([
      { kind: 'staff_message', steamid: P, serverId: s1, text: 'first' },
      { kind: 'staff_message', steamid: P, serverId: s1, text: 'later' },
    ]);
    expect(listLines(db, s1, 0, 10)).toHaveLength(3);
  });

  it('a delivery report updates the send and notifies only when it matched', () => {
    const notify = vi.fn();
    const id = recordStaffOut(db, s1, { sentBy: MOD, name: 'V', toKind: 'all', toValue: null, message: 'x' });
    handleServerChatEvent(db, { kind: 'staff_sent', sendId: id + 100, delivered: 2 }, s1, notify);
    expect(notify).not.toHaveBeenCalled();
    handleServerChatEvent(db, { kind: 'staff_sent', sendId: id, delivered: 2 }, s1, notify);
    expect(listLines(db, s1, 0, 10)[0].delivered).toBe(2);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe('isActiveStaff', () => {
  it('is true for a mod or admin in good standing only', () => {
    upsertPlayer(db, { steamid: MOD, name: 'Mod', avatar: null }, []);
    upsertPlayer(db, { steamid: P, name: 'Player', avatar: null }, []);
    expect(isActiveStaff(db, MOD)).toBe(false);
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
    expect(isActiveStaff(db, MOD)).toBe(true);
    expect(isActiveStaff(db, P)).toBe(false);
    expect(isActiveStaff(db, '76561199000000077')).toBe(false);
  });
});
```

Add to `tests/discordAdminFeed.test.ts`, inside the describe that has the sourcetv_watch cases, reusing its `feed`, `t`, `IDS` and `publishAdminEvent`:

```ts
  it('a message to staff names the player and the server, and says where to answer', async () => {
    publishAdminEvent({ kind: 'staff_message', steamid: IDS[2], serverId: 1, text: 'he is *throwing*' });
    await feed.idle();
    const line = t.live()[0].payload.embeds[0].description ?? '';
    expect(line).toContain('**player2**');
    expect(line).toContain('messaged staff');
    expect(line).toContain('he is \\*throwing\\*');
    expect(line).toContain('https://pug.test/admin/live?chat=1');
  });
```

Check how that file names its players and servers first (`player2` for IDS[2] is what the sourcetv cases assert; server id 1 must exist there, or insert one in the test the way nearby cases do).

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/serverChatIngest.test.ts tests/discordAdminFeed.test.ts`
Expected: FAIL (handleServerChatEvent not exported; staff_message not a feed kind).

- [ ] **Step 3: Implement**

Append to `src/serverChat.ts`:

```ts
import type { LogEvent } from './logParse.js';
import { publishAdminEvent } from './adminFeed.js';
import { inGoodStanding } from './standing.js';

/** One admin feed line per player per this long; the page has the rest. */
export const STAFF_FEED_QUIET_MS = 10 * 60_000;
const lastFeed = new Map<string, number>();
export function _resetFeedQuiet(): void { lastFeed.clear(); }

/** Who may read server chat: checked per event, so a demotion or a ban takes
 *  effect on the next line rather than when the tab reloads. */
export function isActiveStaff(db: DB, steamid: string): boolean {
  const p = db.prepare('SELECT is_admin, is_mod FROM players WHERE steamid = ?').get(steamid) as
    { is_admin: number; is_mod: number } | undefined;
  return !!p && (p.is_admin === 1 || p.is_mod === 1) && inGoodStanding(db, steamid);
}

type ChatEvent = Extract<LogEvent, { kind: 'say' | 'name' | 'staff_in' | 'staff_sent' }>;

export function handleServerChatEvent(
  db: DB, ev: ChatEvent, serverId: number | null, notify: () => void, now = Date.now(),
): void {
  if (ev.kind === 'name') { noteName(ev.steamid, ev.name); return; }
  if (serverId === null) return;
  if (ev.kind === 'say') { recordSay(db, serverId, ev, now); notify(); return; }
  if (ev.kind === 'staff_sent') { if (markDelivered(db, serverId, ev.sendId, ev.delivered)) notify(); return; }
  recordStaffIn(db, serverId, ev, now);
  notify();
  const last = lastFeed.get(ev.steamid);
  if (last === undefined || now - last > STAFF_FEED_QUIET_MS) {
    lastFeed.set(ev.steamid, now);
    publishAdminEvent({ kind: 'staff_message', steamid: ev.steamid, serverId, text: ev.message });
  }
}
```

Move the three new imports to the top of the file with the existing one.

In `src/adminFeed.ts`, add to the union after `sourcetv_watch`:

```ts
  // A player's /staff message (src/serverChat.ts). One per player per ten
  // minutes; the chat drawer on Live holds the whole conversation.
  | { kind: 'staff_message'; steamid: string; serverId: number; text: string }
```

and to FEED_SETTING: `staff_message: 'admin_feed_staff_messages',`.

In `src/settingsSchema.ts`, after the `admin_feed_conduct` entry:

```ts
  { key: 'admin_feed_staff_messages', group: 'Admin feed', label: 'Messages to staff', help: 'A player typed /staff in game. One line per player per ten minutes, no ping; the whole conversation is in the chat drawer on Live.', type: { kind: 'bool' } },
```

In `src/db.ts` defaults, after `admin_feed_conduct: '1',` add `admin_feed_staff_messages: '1',`.

In `src/discord/adminFeedPoster.ts`, add before `case 'signon_drop':`:

```ts
      case 'staff_message': {
        // Not a ping: /mod is the urgent route. A link straight to that
        // server's chat, where a whisper answers them.
        const server = this.deps.db.prepare('SELECT name FROM servers WHERE id = ?').get(e.serverId) as { name: string } | undefined;
        return {
          text: `💬 ${this.name(e.steamid)} messaged staff on ${escapeName(server?.name ?? 'a server')}: "${escapeName(e.text)}". `
            + `[Answer in Server chat](${this.deps.publicUrl}/admin/live?chat=${e.serverId})`,
          color: COLOR.account,
        };
      }
```

In `src/server.ts`, replace the say/name branch (line ~966) with:

```ts
        if (ev.kind === 'say' || ev.kind === 'name' || ev.kind === 'staff_in' || ev.kind === 'staff_sent') {
          const sid = serverOf(source, meta);
          // Conduct alerts first, then the staff chat store. Neither is on
          // the critical path: a failure here must not take down the
          // listener that also carries match_end.
          if (ev.kind === 'say' || ev.kind === 'name') {
            try {
              handleConduct(deps.db, ev, sid);
            } catch (err) {
              console.error('[conduct] failed to check a line:', err);
            }
          }
          try {
            handleServerChatEvent(deps.db, ev, sid, () => hub.sendTo('server_chat', (id) => isActiveStaff(deps.db, id)));
          } catch (err) {
            console.error('[serverchat] failed to store a line:', err);
          }
          return;
        }
```

Import `handleServerChatEvent` and `isActiveStaff` from `./serverChat.js`. Check that `hub` is in scope at that point (it is declared at line ~535, before the listener is built near line 846); if the listener is built earlier than the hub in this checkout, move the `hub` declaration up rather than passing a closure over an undefined variable.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/serverChatIngest.test.ts tests/discordAdminFeed.test.ts tests/conductFlags.test.ts tests/adminSettings.test.ts && npm run typecheck`
Expected: PASS. If a settings test snapshots the full list of toggles, update the snapshot with the one new key.

- [ ] **Step 5: Commit**

```bash
git add src/ tests/
git commit -m "staff chat: store every chat line, notify staff, feed line for /staff"
```

---

### Task 4: Sending: cleaning, rate limit, the rcon command

**Files:**
- Create: `src/staffChatSend.ts`
- Test: `tests/staffChatSend.test.ts`

**Interfaces:**
- Consumes: `recordStaffOut` (Task 2); `LeaseRcon` type from `src/practiceLeases.ts:322` (`(server: ServerRow, commands: string[]) => Promise<string[]>`); `getServer` from `src/serverPool.ts:53`.
- Produces:
  - `export type SendTarget = { to: 'all' } | { to: 'team'; team: 1 | 2 | 3 } | { to: 'player'; steamid: string }`
  - `export function cleanChatText(raw: unknown, max: number): string` (empty string when nothing is left)
  - `export class SendLimiter { constructor(max?: number, windowMs?: number); allow(steamid: string, now?: number): boolean }` (defaults 5 and 10_000)
  - `export function staffSayCommand(target: SendTarget, name: string, message: string, sendId: number): string`
  - `export type SendResult = { ok: true; id: number } | { ok: false; id: number; error: string }`
  - `export async function sendStaffChat(db: DB, rcon: LeaseRcon, input: { serverId: number; sentBy: string; name: string; target: SendTarget; message: string }): Promise<SendResult>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/staffChatSend.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { listLines } from '../src/serverChat.js';
import { SendLimiter, cleanChatText, sendStaffChat, staffSayCommand } from '../src/staffChatSend.js';

const P = '76561199048276493';
const MOD = '76561199000000009';
const server = (db: DB, name: string): number => Number(db.prepare(
  "INSERT INTO servers (name, host, port, rcon_port, rcon_password, tv_port, tv_enabled) VALUES (?, '1.2.3.4', 27015, 27015, 'x', 27020, 1)",
).run(name).lastInsertRowid);

describe('cleanChatText', () => {
  it('turns quotes, semicolons and line breaks into spaces and trims', () => {
    expect(cleanChatText('hi"; quit\nnow', 190)).toBe('hi quit now');
    expect(cleanChatText('  a   b  ', 190)).toBe('a b');
  });
  it('caps the length after cleaning and returns empty for nothing left', () => {
    expect(cleanChatText('x'.repeat(300), 190)).toHaveLength(190);
    expect(cleanChatText(';;"\n', 190)).toBe('');
    expect(cleanChatText(42, 190)).toBe('');
  });
});

describe('SendLimiter', () => {
  it('allows 5 per 10 s per person', () => {
    const l = new SendLimiter();
    for (let i = 0; i < 5; i++) expect(l.allow(MOD, 1000 + i)).toBe(true);
    expect(l.allow(MOD, 2000)).toBe(false);
    expect(l.allow(P, 2000)).toBe(true);
    expect(l.allow(MOD, 11_001)).toBe(true);
  });
});

describe('staffSayCommand', () => {
  it('builds each target', () => {
    expect(staffSayCommand({ to: 'all' }, 'Volence', 'hello', 7)).toBe('sm_pug_staffsay all "Volence" "hello" 7');
    expect(staffSayCommand({ to: 'team', team: 2 }, 'V', 'go', 8)).toBe('sm_pug_staffsay survivors "V" "go" 8');
    expect(staffSayCommand({ to: 'team', team: 3 }, 'V', 'go', 9)).toBe('sm_pug_staffsay infected "V" "go" 9');
    expect(staffSayCommand({ to: 'team', team: 1 }, 'V', 'go', 10)).toBe('sm_pug_staffsay spectators "V" "go" 10');
    expect(staffSayCommand({ to: 'player', steamid: P }, 'V', 'psst', 11)).toBe(`sm_pug_staffsay ${P} "V" "psst" 11`);
  });
});

describe('sendStaffChat', () => {
  let db: DB;
  let sid: number;
  beforeEach(() => {
    db = openDb(':memory:');
    sid = server(db, 'Dallas');
  });

  it('stores the row first, then sends one command', async () => {
    const sent: string[][] = [];
    const r = await sendStaffChat(db, async (_s, cmds) => { sent.push(cmds); return ['']; }, {
      serverId: sid, sentBy: MOD, name: 'Volence', target: { to: 'player', steamid: P }, message: 'on it',
    });
    expect(r).toEqual({ ok: true, id: expect.any(Number) });
    expect(sent).toEqual([[`sm_pug_staffsay ${P} "Volence" "on it" ${r.id}`]]);
    expect(listLines(db, sid, 0, 10)[0]).toMatchObject({ kind: 'staff_out', to_kind: 'player', to_value: P, delivered: null });
  });

  it('an rcon failure marks the row -1 and says so', async () => {
    const r = await sendStaffChat(db, async () => { throw new Error('rcon connect timeout'); }, {
      serverId: sid, sentBy: MOD, name: 'V', target: { to: 'all' }, message: 'hi',
    });
    expect(r).toMatchObject({ ok: false, error: 'Could not reach the server.' });
    expect(listLines(db, sid, 0, 10)[0].delivered).toBe(-1);
  });

  it('an old plugin (Unknown command) marks -1 and names the version', async () => {
    const r = await sendStaffChat(db, async () => ['Unknown command "sm_pug_staffsay"'], {
      serverId: sid, sentBy: MOD, name: 'V', target: { to: 'all' }, message: 'hi',
    });
    expect(r).toMatchObject({ ok: false, error: 'This server needs pug-match 0.3.16 to send.' });
    expect(listLines(db, sid, 0, 10)[0].delivered).toBe(-1);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/staffChatSend.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/staffChatSend.ts
import type { DB } from './db.js';
import type { LeaseRcon } from './practiceLeases.js';
import { getServer } from './serverPool.js';
import { recordStaffOut } from './serverChat.js';

/**
 * Staff messages into a game server. The ONLY command built from user text is
 * sm_pug_staffsay, and the text goes in as two quoted arguments with every
 * character that could end a quote or start a second console command
 * (`"`, `;`, a line break) turned into a space first.
 */

export type SendTarget = { to: 'all' } | { to: 'team'; team: 1 | 2 | 3 } | { to: 'player'; steamid: string };
export type SendResult = { ok: true; id: number } | { ok: false; id: number; error: string };

export function cleanChatText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/["\r\n;]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

export class SendLimiter {
  private sent = new Map<string, number[]>();
  constructor(private max = 5, private windowMs = 10_000) {}
  allow(steamid: string, now = Date.now()): boolean {
    const recent = (this.sent.get(steamid) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) { this.sent.set(steamid, recent); return false; }
    recent.push(now);
    this.sent.set(steamid, recent);
    return true;
  }
}

const TEAM_WORD = { 1: 'spectators', 2: 'survivors', 3: 'infected' } as const;

export function staffSayCommand(target: SendTarget, name: string, message: string, sendId: number): string {
  const to = target.to === 'all' ? 'all' : target.to === 'team' ? TEAM_WORD[target.team] : target.steamid;
  return `sm_pug_staffsay ${to} "${name}" "${message}" ${sendId}`;
}

export async function sendStaffChat(
  db: DB, rcon: LeaseRcon,
  input: { serverId: number; sentBy: string; name: string; target: SendTarget; message: string },
): Promise<SendResult> {
  const { target } = input;
  const id = recordStaffOut(db, input.serverId, {
    sentBy: input.sentBy, name: input.name, toKind: target.to,
    toValue: target.to === 'team' ? String(target.team) : target.to === 'player' ? target.steamid : null,
    message: input.message,
  });
  const failed = (error: string): SendResult => {
    db.prepare('UPDATE server_chat SET delivered = -1 WHERE id = ?').run(id);
    return { ok: false, id, error };
  };
  const server = getServer(db, input.serverId);
  if (!server) return failed('No such server.');
  let reply: string;
  try {
    [reply = ''] = await rcon(server, [staffSayCommand(target, input.name, input.message, id)]);
  } catch (err) {
    console.error(`[serverchat] send ${id} to ${server.name} failed:`, err);
    return failed('Could not reach the server.');
  }
  if (/Unknown command/i.test(reply)) return failed('This server needs pug-match 0.3.16 to send.');
  return { ok: true, id };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/staffChatSend.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/staffChatSend.ts tests/staffChatSend.test.ts
git commit -m "staff chat: clean, rate limit and send sm_pug_staffsay"
```

---

### Task 5: Routes

**Files:**
- Create: `src/routes/serverChat.ts`
- Modify: `src/server.ts` (factor the practice rcon runner into a shared const; add `chatRcon?: LeaseRcon` to deps near line 167; register the routes next to `modCallRoutes` near line 1678)
- Test: `tests/serverChatRoutes.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 4; `makeRequireMod` (`src/routes/guards.ts:69`); `listServers` (`src/serverPool.ts:204`); `isLeased` (`src/serverPool.ts:72`); `liveMatchOn` (Task 2).
- Produces:
  - `GET /api/mod/chat/servers` → `{ servers: ChatServerView[] }`, `ChatServerView = { id: number; name: string; state: 'match' | 'practice' | 'idle' | 'offline'; lastAt: number | null }` (enabled servers plus any leased one)
  - `GET /api/mod/chat/:serverId?after=<id>&limit=<n>` → `{ server: { id: number; name: string }; lines: ChatLineView[] }`, limit default 200, max 500
  - `ChatLineView = { id: number; at: number; kind: 'say' | 'staff_in' | 'staff_out'; steamid: string | null; name: string | null; team: number | null; scope: 'all' | 'team' | null; message: string; matchId: number | null; to: { kind: 'all' | 'team' | 'player'; value: string | null; name: string | null } | null; delivered: number | null }` (`to.name` is the whisper target's name, else null)
  - `POST /api/mod/chat/:serverId` body `{ to: 'all' | 'team' | 'player'; team?: 1 | 2 | 3; steamid?: string; message: string }` → 200 `{ ok: true, id }`, 400 `{ error }`, 404, 429 `{ error: 'Slow down: 5 messages per 10 seconds.' }`, 502 `{ error, id }` on a failed send

- [ ] **Step 1: Write the failing test**

```ts
// tests/serverChatRoutes.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { recordSay } from '../src/serverChat.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 3 }, (_, i) => `7656119900000000${i}`);
const [MOD, PLAYER, TARGET] = IDS;
let db: DB;
let app: FastifyInstance;
let sid: number;
let sent: string[];
let rconReply: string;
const cookie: Record<string, Record<string, string>> = {};

beforeEach(async () => {
  db = openDb(':memory:');
  sent = [];
  rconReply = '';
  app = await buildServer({
    config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
    chatRcon: async (_s, cmds) => { sent.push(...cmds); return [rconReply]; },
  });
  for (const id of IDS) cookie[id] = authedCookie(app, db, id);
  db.prepare("UPDATE players SET is_mod = 1, name = 'Mod Person' WHERE steamid = ?").run(MOD);
  db.prepare("UPDATE players SET name = 'Target' WHERE steamid = ?").run(TARGET);
  sid = Number(db.prepare(
    "INSERT INTO servers (name, host, port, rcon_port, rcon_password, tv_port, tv_enabled) VALUES ('Dallas', '1.2.3.4', 27015, 27015, 'x', 27020, 1)",
  ).run().lastInsertRowid);
});
afterEach(async () => { await app.close(); });

const get = (as: string | null, url: string) => app.inject({ method: 'GET', url, cookies: as ? cookie[as] : undefined });
const send = (as: string, body: unknown) => app.inject({ method: 'POST', url: `/api/mod/chat/${sid}`, cookies: cookie[as], payload: body as object });

describe('server chat routes', () => {
  it('are staff only', async () => {
    expect((await get(null, '/api/mod/chat/servers')).statusCode).toBe(401);
    expect((await get(PLAYER, '/api/mod/chat/servers')).statusCode).toBe(403);
    expect((await get(PLAYER, `/api/mod/chat/${sid}`)).statusCode).toBe(403);
    expect((await send(PLAYER, { to: 'all', message: 'x' })).statusCode).toBe(403);
    expect(sent).toEqual([]);
  });

  it('a banned moderator is refused', async () => {
    db.prepare("INSERT INTO bans (player_id, created_by, reason, created_at) VALUES (?, 'system', 'x', datetime('now'))").run(MOD);
    expect((await get(MOD, '/api/mod/chat/servers')).statusCode).toBe(403);
  });

  it('lists servers and lines', async () => {
    recordSay(db, sid, { steamid: PLAYER, team: 2, scope: 'team', message: 'rush' });
    const servers = (await get(MOD, '/api/mod/chat/servers')).json();
    expect(servers.servers).toEqual([{ id: sid, name: 'Dallas', state: expect.any(String), lastAt: expect.any(Number) }]);
    const body = (await get(MOD, `/api/mod/chat/${sid}`)).json();
    expect(body.server).toEqual({ id: sid, name: 'Dallas' });
    expect(body.lines[0]).toMatchObject({ kind: 'say', steamid: PLAYER, team: 2, scope: 'team', message: 'rush', to: null });
  });

  it('404s an unknown server', async () => {
    expect((await get(MOD, '/api/mod/chat/999')).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/mod/chat/999', cookies: cookie[MOD], payload: { to: 'all', message: 'x' } })).statusCode).toBe(404);
  });

  it('sends a whisper signed with the site name, cleaned', async () => {
    const r = await send(MOD, { to: 'player', steamid: TARGET, message: 'hi"; quit' });
    expect(r.statusCode).toBe(200);
    expect(sent).toEqual([`sm_pug_staffsay ${TARGET} "Mod Person" "hi quit" ${r.json().id}`]);
    const line = (await get(MOD, `/api/mod/chat/${sid}`)).json().lines[0];
    expect(line).toMatchObject({ kind: 'staff_out', name: 'Mod Person', to: { kind: 'player', value: TARGET, name: 'Target' } });
  });

  it('refuses a bad body', async () => {
    expect((await send(MOD, { to: 'all', message: ' ; ' })).statusCode).toBe(400);
    expect((await send(MOD, { to: 'team', team: 4, message: 'x' })).statusCode).toBe(400);
    expect((await send(MOD, { to: 'player', steamid: '123', message: 'x' })).statusCode).toBe(400);
    expect((await send(MOD, { to: 'everyone', message: 'x' })).statusCode).toBe(400);
    expect(sent).toEqual([]);
  });

  it('rate limits at 5 per 10 s', async () => {
    for (let i = 0; i < 5; i++) expect((await send(MOD, { to: 'all', message: `m${i}` })).statusCode).toBe(200);
    const r = await send(MOD, { to: 'all', message: 'too many' });
    expect(r.statusCode).toBe(429);
    expect(sent).toHaveLength(5);
  });

  it('502s with the reason on an old plugin', async () => {
    rconReply = 'Unknown command "sm_pug_staffsay"';
    const r = await send(MOD, { to: 'all', message: 'x' });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toBe('This server needs pug-match 0.3.16 to send.');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/serverChatRoutes.test.ts`
Expected: FAIL (`chatRcon` not a dep; routes 404).

- [ ] **Step 3: Implement**

In `src/server.ts`, lift the practice runner into a const just above `const practiceLeases = new PracticeLeases({`:

```ts
  // One short rcon connection per burst (see src/rcon.ts on turns). Shared by
  // practice leases and staff chat.
  const realServerRcon: LeaseRcon = async (server, commands) => {
    const rcon = new RealRcon({ host: server.host, port: server.rcon_port, password: server.rcon_password });
    try {
      await rcon.connect();
      const out: string[] = [];
      for (const c of commands) out.push(await rcon.exec(c));
      return out;
    } finally {
      rcon.close();
    }
  };
```

and pass `rcon: deps.practiceRcon ?? realServerRcon,` to PracticeLeases. Add to the deps interface beside `practiceRcon?: LeaseRcon;`:

```ts
  /** Staff chat sends (src/routes/serverChat.ts). Tests inject a fake. */
  chatRcon?: LeaseRcon;
```

Register after `modCallRoutes`:

```ts
  await app.register(serverChatRoutes, { db: deps.db, rcon: deps.chatRcon ?? realServerRcon });
```

Create `src/routes/serverChat.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import type { LeaseRcon } from '../practiceLeases.js';
import { getPlayer } from '../players.js';
import { getServer, isLeased, listServers } from '../serverPool.js';
import { listLines, liveMatchOn, type ChatLineRow } from '../serverChat.js';
import { SendLimiter, cleanChatText, sendStaffChat, type SendTarget } from '../staffChatSend.js';
import { makeRequireMod } from './guards.js';

export interface ChatServerView { id: number; name: string; state: 'match' | 'practice' | 'idle' | 'offline'; lastAt: number | null }
export interface ChatLineView {
  id: number; at: number; kind: ChatLineRow['kind']; steamid: string | null; name: string | null;
  team: number | null; scope: 'all' | 'team' | null; message: string; matchId: number | null;
  to: { kind: 'all' | 'team' | 'player'; value: string | null; name: string | null } | null;
  delivered: number | null;
}

export const MESSAGE_MAX = 190;
export const NAME_MAX = 32;

/**
 * People, Server chat: every server's chat for mods and admins alike, and the
 * one way the site talks into a game. Staff see team chat too (owner ruling
 * 2026-09-28: teams are on voice, typed team chat hides nothing).
 */
export async function serverChatRoutes(app: FastifyInstance, opts: { db: DB; rcon: LeaseRcon }): Promise<void> {
  const { db, rcon } = opts;
  const requireMod = makeRequireMod(db);
  const limiter = new SendLimiter();
  const lastAt = db.prepare('SELECT MAX(at) AS at FROM server_chat WHERE server_id = ?');

  const serverId = (raw: unknown): number | null => {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 && getServer(db, n) ? n : null;
  };

  app.get('/api/mod/chat/servers', async (req, reply) => {
    if (!requireMod(req, reply)) return;
    const servers: ChatServerView[] = listServers(db)
      .filter((s) => s.enabled === 1 || isLeased(db, s.id))
      .map((s) => ({
        id: s.id, name: s.name,
        state: isLeased(db, s.id) ? 'practice' : liveMatchOn(db, s.id) !== null ? 'match' : s.status === 'offline' ? 'offline' : 'idle',
        lastAt: (lastAt.get(s.id) as { at: number | null }).at,
      }));
    return { servers };
  });

  app.get('/api/mod/chat/:serverId', async (req, reply) => {
    if (!requireMod(req, reply)) return;
    const id = serverId((req.params as { serverId: string }).serverId);
    if (id === null) return reply.code(404).send({ error: 'no such server' });
    const q = req.query as { after?: string; limit?: string };
    const after = Math.max(0, Number.parseInt(q.after ?? '0', 10) || 0);
    const limit = Math.min(500, Math.max(1, Number.parseInt(q.limit ?? '200', 10) || 200));
    const server = getServer(db, id)!;
    const lines: ChatLineView[] = listLines(db, id, after, limit).map((r) => ({
      id: r.id, at: r.at, kind: r.kind, steamid: r.steamid, name: r.name, team: r.team, scope: r.scope,
      message: r.message, matchId: r.match_id, delivered: r.delivered,
      to: r.to_kind === null ? null : {
        kind: r.to_kind, value: r.to_value,
        name: r.to_kind === 'player' && r.to_value ? getPlayer(db, r.to_value)?.name ?? null : null,
      },
    }));
    return { server: { id: server.id, name: server.name }, lines };
  });

  app.post('/api/mod/chat/:serverId', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return;
    const id = serverId((req.params as { serverId: string }).serverId);
    if (id === null) return reply.code(404).send({ error: 'no such server' });
    const body = (req.body ?? {}) as { to?: unknown; team?: unknown; steamid?: unknown; message?: unknown };
    const message = cleanChatText(body.message, MESSAGE_MAX);
    if (!message) return reply.code(400).send({ error: 'Type a message.' });
    let target: SendTarget;
    if (body.to === 'all') target = { to: 'all' };
    else if (body.to === 'team' && (body.team === 1 || body.team === 2 || body.team === 3)) target = { to: 'team', team: body.team };
    else if (body.to === 'player' && typeof body.steamid === 'string' && /^\d{17}$/.test(body.steamid)) target = { to: 'player', steamid: body.steamid };
    else return reply.code(400).send({ error: 'Pick who the message is for.' });
    if (!limiter.allow(me)) return reply.code(429).send({ error: 'Slow down: 5 messages per 10 seconds.' });
    const name = cleanChatText(getPlayer(db, me)?.name ?? '', NAME_MAX) || 'Staff';
    const r = await sendStaffChat(db, rcon, { serverId: id, sentBy: me, name, target, message });
    if (!r.ok) return reply.code(502).send({ error: r.error, id: r.id });
    return { ok: true, id: r.id };
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/serverChatRoutes.test.ts tests/practiceRoutes.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ tests/serverChatRoutes.test.ts
git commit -m "staff chat: /api/mod/chat routes"
```

---

### Task 6: Plugin: pug-match 0.3.16 (staffsay, /staff, say scope)

**Files:**
- Create: `plugin/pug-staffchat.inc`
- Modify: `plugin/pug-match.sp` (PLUGIN_VERSION line 23; include beside `pug-modcall.inc`; `StaffChat_Init()` beside `ModCall_Init()` at line 507; `EmitConductSay` near line 988)
- Modify: `plugin/pug-modcall.inc` (`OnClientSayCommand` at line 105: the one say forward the plugin may have)
- Modify: `plugin/build.sh` (copy and clean up the new include)
- Modify: `plugin/TESTING.md` (a "Staff chat" section with the manual checks from Step 5)

**Interfaces:**
- Consumes: `PugLog`, `SanitizeChat`, `ModCall_AuthId` (pug-modcall.inc:153).
- Produces (the wire the site reads, Task 1):
  - `PUGSAY steamid=<id64> team=<n> scope=all|team msg=<text>`
  - `PUGSTAFF steamid=<id64> team=<n> msg=<text>`
  - `PUGSTAFFSENT id=<send id> delivered=<count>`
  - Server command `sm_pug_staffsay <all|survivors|infected|spectators|steamid64> "<name>" "<message>" <send id>`

- [ ] **Step 1: Write `plugin/pug-staffchat.inc`**

```sourcepawn
// ---------- staff chat: the site talking into the game, and /staff back ----------
//
// Spec: docs/superpowers/specs/2026-09-28-staff-server-chat-design.md.
//
// sm_pug_staffsay is sent over rcon by the site (src/staffChatSend.ts) and
// prints a staff message to everyone, one team, or one player. It answers
// with a signed PUGSTAFFSENT line saying how many players it reached, so the
// page can say "delivered to 4" or "not on the server".
//
// /staff <message> is a player's private line to staff. The say is dropped
// (OnClientSayCommand in pug-modcall.inc calls StaffChat_OnSay first), so
// nobody in game sees it, and it goes out as a signed PUGSTAFF line.

#define STAFFCHAT_COOLDOWN 5.0

float g_fStaffLast[MAXPLAYERS + 1];
bool g_bSayTeam[MAXPLAYERS + 1];   // the say this client is typing right now went to team chat

void StaffChat_Init()
{
	RegServerCmd("sm_pug_staffsay", Cmd_StaffSay, "sm_pug_staffsay <all|survivors|infected|spectators|steamid64> \"<name>\" \"<message>\" <send id>");
	RegConsoleCmd("sm_staff", Cmd_Staff, "Message the staff privately. Only staff see it.");
}

void StaffChat_OnDisconnect(int client)
{
	g_fStaffLast[client] = 0.0;
	g_bSayTeam[client] = false;
}

public Action Cmd_StaffSay(int args)
{
	if (args < 4)
	{
		PrintToServer("usage: sm_pug_staffsay <to> \"<name>\" \"<message>\" <send id>");
		return Plugin_Handled;
	}
	char to[24], name[64], message[256], idArg[16];
	GetCmdArg(1, to, sizeof(to));
	GetCmdArg(2, name, sizeof(name));
	GetCmdArg(3, message, sizeof(message));
	GetCmdArg(4, idArg, sizeof(idArg));
	int sendId = StringToInt(idArg);

	int team = 0;       // 0 = everyone
	bool whisper = false;
	if (StrEqual(to, "survivors")) team = 2;
	else if (StrEqual(to, "infected")) team = 3;
	else if (StrEqual(to, "spectators")) team = 1;
	else if (!StrEqual(to, "all")) whisper = true;

	char label[32];
	if (whisper) strcopy(label, sizeof(label), "Staff → you");
	else if (team == 2) strcopy(label, sizeof(label), "Staff → Survivors");
	else if (team == 3) strcopy(label, sizeof(label), "Staff → Infected");
	else if (team == 1) strcopy(label, sizeof(label), "Staff → Spectators");
	else strcopy(label, sizeof(label), "Staff");

	int delivered = 0;
	char id[24];
	for (int c = 1; c <= MaxClients; c++)
	{
		if (!IsClientInGame(c) || IsFakeClient(c)) continue;
		if (whisper)
		{
			if (!ModCall_AuthId(c, id, sizeof(id)) || !StrEqual(id, to)) continue;
		}
		else if (team != 0 && GetClientTeam(c) != team)
		{
			continue;
		}
		PrintToChat(c, "\x04[%s]\x01 %s: %s", label, name, message);
		if (whisper) PrintToChat(c, "\x05Reply privately with /staff <message>");
		delivered++;
	}
	PugLog("PUGSTAFFSENT id=%d delivered=%d", sendId, delivered);
	PrintToServer("staffsay delivered=%d", delivered);
	return Plugin_Handled;
}

public Action Cmd_Staff(int client, int args)
{
	if (client < 1 || client > MaxClients || !IsClientInGame(client) || IsFakeClient(client))
	{
		ReplyToCommand(client, "[PUG] /staff is for players in game.");
		return Plugin_Handled;
	}
	char text[256];
	GetCmdArgString(text, sizeof(text));
	StaffChat_Send(client, text);
	return Plugin_Handled;
}

/** True when the say was a !staff and has been handled (the caller drops it).
 *  Also remembers whether this say went to team chat, for EmitConductSay,
 *  which runs from player_say after this forward. */
bool StaffChat_OnSay(int client, const char[] command, const char[] text)
{
	g_bSayTeam[client] = StrEqual(command, "say_team", false);
	int rest = ModCall_TriggerEnd(text, "!staff");
	if (rest < 0) return false;
	StaffChat_Send(client, text[rest]);
	return true;
}

void StaffChat_Send(int client, const char[] raw)
{
	char text[256];
	strcopy(text, sizeof(text), raw);
	StripQuotes(text);
	TrimString(text);
	SanitizeChat(text, sizeof(text));
	if (text[0] == '\0')
	{
		PrintToChat(client, "[PUG] Usage: /staff <message>. Only staff see it.");
		return;
	}
	float now = GetEngineTime();
	if (g_fStaffLast[client] > 0.0 && now - g_fStaffLast[client] < STAFFCHAT_COOLDOWN)
	{
		PrintToChat(client, "[PUG] Wait a few seconds before your next /staff message.");
		return;
	}
	char id[24];
	if (!ModCall_AuthId(client, id, sizeof(id)))
	{
		PrintToChat(client, "[PUG] Your Steam ID is not verified yet, try again in a moment.");
		return;
	}
	g_fStaffLast[client] = now;
	PugLog("PUGSTAFF steamid=%s team=%d msg=%s", id, GetClientTeam(client), text);
	PrintToChat(client, "[PUG] Sent to staff.");
}
```

Before relying on `ModCall_TriggerEnd` returning the index just past the trigger AND its following space, read it (pug-modcall.inc:138) and keep whatever its contract is; `text[rest]` must be the message without the leading space. Confirm `SanitizeChat` exists with `(char[] text, int maxlen)` (pug-match.sp ~line 960).

- [ ] **Step 2: Wire it into pug-match**

In `plugin/pug-match.sp`:
- `#define PLUGIN_VERSION "0.3.16"`.
- `#include "pug-staffchat.inc"` directly after the `pug-modcall.inc` include (it uses `ModCall_AuthId` and `ModCall_TriggerEnd`).
- `StaffChat_Init();` after `ModCall_Init();`.
- `StaffChat_OnDisconnect(client);` after `ModCall_OnDisconnect(client);` (line ~3104).
- In `EmitConductSay`, change the PugLog line to:

```sourcepawn
	PugLog("PUGSAY steamid=%s team=%d scope=%s msg=%s", id, GetClientTeam(client), g_bSayTeam[client] ? "team" : "all", text);
```

In `plugin/pug-modcall.inc` `OnClientSayCommand`, after `TrimString(text);` and BEFORE the `g_bAwaitDetails` check, add:

```sourcepawn
	// Staff chat reads every say: it records team versus all chat for PUGSAY
	// and takes !staff. A pending /mod detail line still wins below.
	if (!g_bAwaitDetails[client] && StaffChat_OnSay(client, command, text)) return Plugin_Stop;
```

StaffChat_OnSay must still record `g_bSayTeam` when details are pending, so call it for the scope even then: make the condition `StaffChat_OnSay(...)` run first and only return when it handled a !staff and no details are pending. Write it as:

```sourcepawn
	g_bSayTeam[client] = StrEqual(command, "say_team", false);
	if (!g_bAwaitDetails[client] && StaffChat_OnSay(client, command, text)) return Plugin_Stop;
```

and drop the duplicate assignment from StaffChat_OnSay.

In `plugin/build.sh`: add `cp pug-staffchat.inc "$SCRIPTING/pug-staffchat.inc"` after the modcall copy, and `$SCRIPTING/pug-staffchat.inc` to CLEANUP.

- [ ] **Step 3: Build**

Run: `cd plugin && ./build.sh`
Expected: compiles with no errors; `pug-match.smx` updated. Fix any warnings the new code adds.

- [ ] **Step 4: Local server check**

The local server is shared: first run `status` over rcon and check for humans or foreign plugins; if anyone else is on it, stop and ask. Use the cheats cfg (`/home/volence/l4d1-ds/start-cheats.sh` or `rcon-local.py exec rotoblin_cheats_4v4`). Copy the new smx into `/home/volence/l4d1-ds/server/left4dead/addons/sourcemod/plugins/`, `sm plugins load_unlock`, `sm plugins reload pug-match`, and confirm `sm plugins info pug-match` shows 0.3.16.

With no client, over rcon:
- `sm_pug_staffsay all "Test" "hello" 1` prints `staffsay delivered=0` and the server log has `PUGSTAFFSENT id=1 delivered=0`.
- `sm_pug_staffsay 76561199048276493 "Test" "hi" 2` gives `delivered=0`.

With the owner's client (harness allowed any time per the owner), repeat and confirm the colour line, the whisper's reply hint, `/staff hello` staying silent in chat with "Sent to staff." and a `PUGSTAFF` log line, and `say_team x` logging `scope=team`.

- [ ] **Step 5: Commit**

Add a "Staff chat (0.3.16)" section to `plugin/TESTING.md` listing the Step 4 checks, then:

```bash
git add plugin/
git commit -m "pug-match 0.3.16: sm_pug_staffsay, /staff, team/all scope on PUGSAY"
```

---

### Task 7: Open the Live desk to moderators

Owner ruling 2026-09-28: moderators see the whole Live desk and may use the abandon clock (Hold / +5 min / End now), queue removal, practice servers (players list, kick, end a lease), and abort / void. Server controls stay admin-only: pool in/out, restart after match, SourceTV, log signing (secret and mode), Set idle, DLC check, admin sync, settings.

**Files:**
- Modify: `src/routes/admin.ts` (guards on the routes listed below)
- Modify: `src/routes/practice.ts` (the three `/api/admin/practice/...` routes; the end route at line ~287)
- Modify: `web/src/routes/admin/adminRoutes.ts` (`parseAdminPath`, `legacyRedirect`, `landingFor`, a `DESKS` filter)
- Modify: `web/src/routes/Admin.tsx` (desk strip for mods; pass `isAdmin` to AdminLive)
- Modify: `web/src/routes/admin/AdminLive.tsx`, `web/src/routes/admin/MatchPanels.tsx` (hide server controls for mods)
- Test: `tests/adminLive.test.ts`, `tests/practiceRoutes.test.ts`, `web/src/routes/admin/adminRoutes.test.ts`, `web/src/routes/admin/AdminLive.test.tsx`

**Interfaces:**
- Produces: `deskItems(isAdmin: boolean)` in adminRoutes.ts (Live + People for a mod, all four for an admin); `AdminLive({ isAdmin }: { isAdmin: boolean })`; `AdminServersPanel` gains `canManage: boolean`.

- [ ] **Step 1: Failing backend tests**

In `tests/adminLive.test.ts`, replace the test "a moderator is not an admin here: refused by both routes, and nothing is dialled" with:

```ts
  it('a moderator reads the board and can use the abandon clock', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/live', cookies: cookies[MOD] })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/admin/overview', cookies: cookies[MOD] })).statusCode).toBe(200);
    expect((await act({ action: 'hold' }, MOD)).statusCode).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('a moderator may remove from the queue, abort and void, and the audit names them', async () => {
    const post = (url: string, payload?: object) => app.inject({ method: 'POST', url, cookies: cookies[MOD], payload });
    expect((await post('/api/admin/queue/remove', { steamid: IDS[0] })).statusCode).toBe(200);
    const audit = db.prepare("SELECT admin_id FROM admin_actions WHERE action = 'queue_remove'").get() as { admin_id: string };
    expect(audit.admin_id).toBe(MOD);
    // abort and void answer with their own business errors for this fixture;
    // what matters is that the guard let a moderator through (not 401/403).
    expect([401, 403]).not.toContain((await post(`/api/admin/matches/${matchId}/abort`)).statusCode);
    expect([401, 403]).not.toContain((await post(`/api/admin/matches/${matchId}/void`, { reason: 'test' })).statusCode);
  });

  it('server controls stay admin only', async () => {
    const serverId = (db.prepare('SELECT id FROM servers LIMIT 1').get() as { id: number }).id;
    const post = (url: string, payload?: object) => app.inject({ method: 'POST', url, cookies: cookies[MOD], payload });
    for (const [url, body] of [
      [`/api/admin/servers/${serverId}/enabled`, { enabled: false }],
      [`/api/admin/servers/${serverId}/idle`, undefined],
      [`/api/admin/servers/${serverId}/restart-after-match`, { on: true }],
      [`/api/admin/servers/${serverId}/log-secret`, undefined],
      [`/api/admin/servers/${serverId}/log-auth`, { mode: 'off' }],
      [`/api/admin/servers/${serverId}/sourcetv`, { enabled: true }],
      ['/api/admin/servers/dlc4-check', undefined],
      ['/api/admin/servers/admins-sync', undefined],
    ] as [string, object | undefined][]) {
      expect((await post(url, body)).statusCode, url).toBe(403);
    }
    expect((await app.inject({ method: 'GET', url: '/api/admin/settings', cookies: cookies[MOD] })).statusCode).toBe(403);
  });

  it('a plain player is still refused the board', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/live', cookies: cookies[PLAYER] })).statusCode).toBe(403);
    expect((await act({ action: 'hold' }, PLAYER)).statusCode).toBe(403);
  });
```

Check `admin_actions` column names first (`grep -n "CREATE TABLE IF NOT EXISTS admin_actions" -A8 src/db.ts`) and use the real name of the actor column in the audit assertion.

In `tests/practiceRoutes.test.ts`, find the existing tests for `/api/admin/practice/:leaseId/players`, `/kick`, `/api/admin/practice/leases` and `/api/practice/leases/:id/end` (grep for them) and add, using the file's own fixtures and a moderator made the way it makes an admin (`UPDATE players SET is_mod = 1`):
- a moderator gets 200 on `GET /api/admin/practice/leases` and on the players list;
- a moderator's kick is accepted and logged with their steamid;
- a moderator can end a park lease, and the 403 text for a non-staff player now says "Only staff can close the Practice Park..." / "Only whoever started this drill server, or staff, can close it."

Run: `npx vitest run tests/adminLive.test.ts tests/practiceRoutes.test.ts`
Expected: the new cases FAIL with 403.

- [ ] **Step 2: Change the guards**

In `src/routes/admin.ts`, add next to `const requireAdmin = makeRequireAdmin(db);`:

```ts
  // The Live desk is open to moderators (owner ruling 2026-09-28): the board
  // itself and the match-rescue actions. Server controls stay requireAdmin.
  const requireStaff = makeRequireMod(db);
```

and use `requireStaff` instead of `requireAdmin` in exactly these routes: `GET /api/admin/overview`, `POST /api/admin/matches/:id/abort`, `POST /api/admin/matches/:id/void`, `GET /api/admin/live`, `POST /api/admin/live/:matchId/players/:steamid/leave`, `POST /api/admin/queue/remove`. Import `makeRequireMod` from `./guards.js`. Update the file's header comment ("Each route starts with requireAdmin") to say which routes take requireStaff and why.

In `src/routes/practice.ts`: the three `/api/admin/practice/...` routes use `makeRequireMod(db)` instead of requireAdmin. In the end route, replace `const isAdmin = getPlayer(db, steamid)?.is_admin === 1;` with

```ts
    const me = getPlayer(db, steamid);
    const isStaff = me?.is_admin === 1 || me?.is_mod === 1;
```

use `isStaff` in the condition and the `logAdmin` branch, and change the two 403 texts to "Only staff can close the Practice Park. It closes on its own 5 minutes after everyone leaves." and "Only whoever started this drill server, or staff, can close it." Update any existing test that asserts the old wording.

Run the Step 1 tests again: PASS. Then `npx vitest run tests/` for anything else that asserted a moderator 403 on these routes (fix those assertions to the new rule; do not loosen any other route).

- [ ] **Step 3: Front end routing, failing tests first**

Add to `web/src/routes/admin/adminRoutes.test.ts`:

```ts
  it('a moderator can open the Live desk and lands on it', () => {
    expect(parseAdminPath('/admin/live', { isAdmin: false })).toEqual({ desk: 'live', section: 'board', param: null });
    expect(parseAdminPath('/admin/setup/settings', { isAdmin: false }).desk).toBe('people');
    expect(parseAdminPath('/admin/balance', { isAdmin: false }).desk).toBe('people');
    expect(landingFor(false)).toBe('/admin/live');
    expect(deskItems(false).map((d) => d.key)).toEqual(['live', 'people']);
    expect(deskItems(true).map((d) => d.key)).toEqual(['live', 'people', 'setup', 'balance']);
  });
```

Existing tests that expect a moderator on `/admin/live` to land on People, or `landingFor(false)` to be `/admin/people`, change to the new rule. Run: `npx vitest run web/src/routes/admin/adminRoutes.test.ts`, see it fail.

In `adminRoutes.ts`:

```ts
export const landingFor = (_isAdmin: boolean): string => '/admin/live';

/** The desk strip: a moderator has Live and People (owner ruling 2026-09-28). */
export const deskItems = (isAdmin: boolean) => (isAdmin ? DESKS : DESKS.filter((d) => d.key === 'live' || d.key === 'people'));
```

In `parseAdminPath`, replace the moderator line with:

```ts
  // A moderator has Live and People. Anything else lands on People rather
  // than on a screen every call inside would be refused on anyway.
  if (!opts.isAdmin) {
    if (desk === 'live' || desk === '') return { desk: 'live', section: 'board', param: null };
    return desk === 'people' ? people() : { desk: 'people', section: 'search', param: null };
  }
```

In `legacyRedirect`, allow the `?live=` carry-over for moderators too (drop the `isAdmin &&` on that line), and change the `if (!isAdmin && !inPeople) return '/admin/people';` rule so `/admin/live` is not redirected for a moderator (`inPeople || path.startsWith('/admin/live')`). Read the function whole before editing; keep its other rules.

In `Admin.tsx`: render the desk strip for every staff member with `items={deskItems(isAdmin)}` (drop the `isAdmin &&` wrapper), and `<AdminLive isAdmin={isAdmin} />`.

- [ ] **Step 4: Hide server controls for moderators**

`AdminLive` takes `{ isAdmin }` and passes `canManage={isAdmin}` to `AdminServersPanel`. In `AdminServersPanel`, when `canManage` is false:
- the In pool cell shows plain text ("in pool" / "out of pool"), no Take out / Put back button;
- `RestartCell`, `SourceTvCell`, `LogAuthCell` are replaced by read-only text of their current value (`restart_after_match` on/off, SourceTV on/off, log signing mode);
- no Set idle button, no `<AdminSyncButton />`.

Everything else on the board (Hold / +5 min / End now, Abort, Void, queue Remove, practice End / Kick) renders for both.

Add to `web/src/routes/admin/AdminLive.test.tsx`, using its existing mocks and fixtures:

```tsx
  it('a moderator sees the servers without their controls', async () => {
    // same mocks as the admin render test in this file
    render(<AdminLive isAdmin={false} />);
    await screen.findByText('Servers');
    expect(screen.queryByRole('button', { name: 'Take out' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Set idle' })).toBeNull();
    expect(screen.getByText('in pool')).toBeTruthy();
  });
```

Copy the mock setup from the nearest existing render test in that file so the overview has one enabled server; existing renders become `<AdminLive isAdmin />`.

- [ ] **Step 5: Run everything touched and build**

Run: `npx vitest run tests/adminLive.test.ts tests/practiceRoutes.test.ts web/src/routes && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ web/ tests/
git commit -m "admin: open the Live desk to moderators; server controls stay admin only"
```

---

### Task 8: Chat drawer on the Live board

**Files:**
- Modify: `web/src/api.ts` (types + `modApi` methods, beside `calls` near line 1489)
- Create: `web/src/routes/admin/ChatDrawer.tsx`
- Modify: `web/src/routes/admin/AdminLive.tsx` (drawer state from `?chat=`; open buttons)
- Modify: `web/src/routes/admin/MatchPanels.tsx` (a Chat button per server row, for everyone)
- Modify: `web/src/liveBoard.ts` (`chatFromUrl`)
- Modify: `web/src/styles/app.css`
- Test: `web/src/routes/admin/ChatDrawer.test.tsx`, `web/src/liveBoard.test.ts` (or wherever `liveFromUrl` is tested: `grep -rn liveFromUrl web/src --include=*.test.*`)

**Interfaces:**
- Consumes: Task 5 routes; `useHubEvent(['server_chat'], fn)`.
- Produces: `/admin/live?chat=<serverId>` opens the drawer on that server (the link Task 3's feed line and Task 9's links use); `chatFromUrl(search?: string): number | null`; `ChatDrawer({ serverId, onPick, onClose })`.

- [ ] **Step 1: API client**

Add to `web/src/api.ts` after `ModCallView`:

```ts
/** Server chat (src/routes/serverChat.ts). */
export interface ChatServerView { id: number; name: string; state: 'match' | 'practice' | 'idle' | 'offline'; lastAt: number | null }
export interface ChatLineView {
  id: number; at: number; kind: 'say' | 'staff_in' | 'staff_out'; steamid: string | null; name: string | null;
  team: number | null; scope: 'all' | 'team' | null; message: string; matchId: number | null;
  to: { kind: 'all' | 'team' | 'player'; value: string | null; name: string | null } | null;
  delivered: number | null;
}
export type ChatSendBody =
  | { to: 'all'; message: string }
  | { to: 'team'; team: 1 | 2 | 3; message: string }
  | { to: 'player'; steamid: string; message: string };
```

and to `modApi`:

```ts
  chatServers: (signal?: AbortSignal) => get<{ servers: ChatServerView[] }>('/api/mod/chat/servers', signal),
  chatLines: (serverId: number, after: number, signal?: AbortSignal) =>
    get<{ server: { id: number; name: string }; lines: ChatLineView[] }>(`/api/mod/chat/${serverId}?after=${after}`, signal),
  chatSend: (serverId: number, body: ChatSendBody) => post<{ ok: true; id: number }>(`/api/mod/chat/${serverId}`, body),
```

- [ ] **Step 2: `chatFromUrl`, test first**

Beside the existing `liveFromUrl` tests:

```ts
  it('reads ?chat= as a server id', () => {
    expect(chatFromUrl('?chat=3')).toBe(3);
    expect(chatFromUrl('?live=5&chat=12')).toBe(12);
    expect(chatFromUrl('?chat=x')).toBeNull();
    expect(chatFromUrl('')).toBeNull();
  });
```

In `web/src/liveBoard.ts`, next to `liveFromUrl` (match its style and default argument):

```ts
/** The server whose chat drawer ?chat= asks for, from a link on a mod call
 *  card, the admin feed, or In-game calls. */
export function chatFromUrl(search: string = typeof location === 'undefined' ? '' : location.search): number | null {
  const v = new URLSearchParams(search).get('chat');
  return v !== null && /^\d{1,6}$/.test(v) ? Number(v) : null;
}
```

Run the test: PASS.

- [ ] **Step 3: Drawer component test (failing)**

```tsx
// web/src/routes/admin/ChatDrawer.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { ChatLineView } from '../../api';

const { mockMod } = vi.hoisted(() => ({ mockMod: { chatServers: vi.fn(), chatLines: vi.fn(), chatSend: vi.fn() } }));
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, modApi: { ...actual.modApi, ...mockMod } };
});
vi.mock('../../hooks/useHubEvent', () => ({ useHubEvent: () => {} }));

const { ChatDrawer } = await import('./ChatDrawer');

const P = '76561198000000001';
const line = (over: Partial<ChatLineView> = {}): ChatLineView => ({
  id: 1, at: Date.UTC(2026, 8, 28, 20, 0), kind: 'say', steamid: P, name: 'Zoey', team: 2, scope: 'all',
  message: 'hello', matchId: null, to: null, delivered: null, ...over,
});
const SERVERS = { servers: [{ id: 3, name: 'Dallas', state: 'match', lastAt: null }, { id: 4, name: 'Riverside #3', state: 'practice', lastAt: null }] };

beforeEach(() => {
  for (const f of Object.values(mockMod)) f.mockReset();
  mockMod.chatServers.mockResolvedValue(SERVERS);
});
afterEach(() => cleanup());

describe('ChatDrawer', () => {
  it('picks another server', async () => {
    mockMod.chatLines.mockResolvedValue({ server: { id: 3, name: 'Dallas' }, lines: [] });
    const onPick = vi.fn();
    render(<ChatDrawer serverId={3} onPick={onPick} onClose={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Server'), { target: { value: '4' } });
    expect(onPick).toHaveBeenCalledWith(4);
  });

  it('closes', async () => {
    mockMod.chatLines.mockResolvedValue({ server: { id: 3, name: 'Dallas' }, lines: [] });
    const onClose = vi.fn();
    render(<ChatDrawer serverId={3} onPick={() => {}} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Close chat' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows lines with team chat and staff messages marked', async () => {
    mockMod.chatLines.mockResolvedValue({ server: { id: 3, name: 'Dallas' }, lines: [
      line(),
      line({ id: 2, scope: 'team', message: 'rush' }),
      line({ id: 3, kind: 'staff_in', message: 'he is throwing' }),
      line({ id: 4, kind: 'staff_out', steamid: null, name: 'Volence', to: { kind: 'player', value: P, name: 'Zoey' }, delivered: 1, message: 'watching' }),
      line({ id: 5, kind: 'staff_out', steamid: null, name: 'Volence', to: { kind: 'player', value: P, name: 'Zoey' }, delivered: 0, message: 'gone?' }),
    ] });
    render(<ChatDrawer serverId={3} onPick={() => {}} onClose={() => {}} />);
    await screen.findByText('hello');
    expect(screen.getByText('(team)')).toBeTruthy();
    expect(screen.getByText('to staff')).toBeTruthy();
    expect(screen.getAllByText(/whisper to Zoey/)).toHaveLength(2);
    expect(screen.getByText('delivered to 1')).toBeTruthy();
    expect(screen.getByText('not on the server')).toBeTruthy();
  });

  it('clicking a name switches to a whisper and sends it', async () => {
    mockMod.chatLines.mockResolvedValue({ server: { id: 3, name: 'Dallas' }, lines: [line()] });
    mockMod.chatSend.mockResolvedValue({ ok: true, id: 9 });
    render(<ChatDrawer serverId={3} onPick={() => {}} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Zoey' }));
    expect(screen.getByText('Whisper to Zoey')).toBeTruthy();
    fireEvent.input(screen.getByLabelText('Message'), { target: { value: 'on it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(mockMod.chatSend).toHaveBeenCalledWith(3, { to: 'player', steamid: P, message: 'on it' }));
  });

  it('sends to a team', async () => {
    mockMod.chatLines.mockResolvedValue({ server: { id: 3, name: 'Dallas' }, lines: [] });
    mockMod.chatSend.mockResolvedValue({ ok: true, id: 9 });
    render(<ChatDrawer serverId={3} onPick={() => {}} onClose={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Send to'), { target: { value: 'team:3' } });
    fireEvent.input(screen.getByLabelText('Message'), { target: { value: 'hold' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(mockMod.chatSend).toHaveBeenCalledWith(3, { to: 'team', team: 3, message: 'hold' }));
  });

  it('shows the server error on a failed send', async () => {
    mockMod.chatLines.mockResolvedValue({ server: { id: 3, name: 'Dallas' }, lines: [] });
    const { ApiError } = await import('../../api');
    mockMod.chatSend.mockRejectedValue(new ApiError(502, 'This server needs pug-match 0.3.16 to send.'));
    render(<ChatDrawer serverId={3} onPick={() => {}} onClose={() => {}} />);
    fireEvent.input(await screen.findByLabelText('Message'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('This server needs pug-match 0.3.16 to send.')).toBeTruthy();
  });
});
```

Run: `npx vitest run web/src/routes/admin/ChatDrawer.test.tsx`. Expected: FAIL, module not found.

- [ ] **Step 4: Implement `ChatDrawer.tsx`**

```tsx
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, modApi, type ChatLineView, type ChatSendBody } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { useHubEvent } from '../../hooks/useHubEvent';
import { Empty } from '../../components/bits';

const TEAM_CLASS: Record<number, string> = { 1: 'chat-line--spec', 2: 'chat-line--surv', 3: 'chat-line--inf' };
const TEAM_NAME: Record<string, string> = { '1': 'Spectators', '2': 'Survivors', '3': 'Infected' };

type Mode = { kind: 'all' } | { kind: 'team'; team: 1 | 2 | 3 } | { kind: 'player'; steamid: string; name: string };

/**
 * The Live board's chat drawer: one server's chat, live, and a box that sends
 * to everyone, a team, or one player. Staff see team chat too (owner ruling
 * 2026-09-28). Opened by ?chat=<serverId>, so a mod call card or the admin
 * feed can link straight into it.
 */
export function ChatDrawer({ serverId, onPick, onClose }: {
  serverId: number; onPick: (id: number) => void; onClose: () => void;
}) {
  const servers = useFetch((s) => modApi.chatServers(s), []);
  const [lines, setLines] = useState<ChatLineView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'all' });
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  // A delivery report changes an old row, so a refresh re-reads the whole
  // window rather than only what is after the last id.
  const load = async () => {
    try {
      const r = await modApi.chatLines(serverId, 0);
      setLines(r.lines);
      setError(null);
    } catch {
      setError('Could not load the chat.');
    }
  };
  useEffect(() => { setMode({ kind: 'all' }); setLines([]); void load(); }, [serverId]);
  useHubEvent(['server_chat'], () => { void load(); });
  useEffect(() => { bottom.current?.scrollIntoView?.({ block: 'end' }); }, [lines.length]);

  const send = async () => {
    const message = text.trim();
    if (!message) return;
    const body: ChatSendBody = mode.kind === 'all' ? { to: 'all', message }
      : mode.kind === 'team' ? { to: 'team', team: mode.team, message }
      : { to: 'player', steamid: mode.steamid, message };
    setSending(true);
    try {
      await modApi.chatSend(serverId, body);
      setText('');
      setError(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send.');
    } finally {
      setSending(false);
    }
  };

  const modeValue = mode.kind === 'team' ? `team:${mode.team}` : mode.kind;
  return (
    <aside class="chat-drawer" aria-label="Server chat">
      <header class="chat-drawer__head">
        <label>
          <span class="sr-only">Server</span>
          <select aria-label="Server" value={String(serverId)}
            onChange={(e) => onPick(Number((e.target as HTMLSelectElement).value))}>
            {(servers.data?.servers ?? [{ id: serverId, name: `Server ${serverId}`, state: 'idle', lastAt: null }]).map((s) => (
              <option key={s.id} value={String(s.id)}>{s.name} ({s.state})</option>
            ))}
          </select>
        </label>
        <button type="button" class="chip" aria-label="Close chat" onClick={onClose}>×</button>
      </header>
      <div class="chat-log" role="log">
        {lines.length === 0 && <Empty>No chat yet.</Empty>}
        {lines.map((l) => <Line key={l.id} line={l} onName={(steamid, n) => setMode({ kind: 'player', steamid, name: n })} />)}
        <div ref={bottom} />
      </div>
      {error && <p class="error">{error}</p>}
      <form class="chat-send" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        {mode.kind === 'player' ? (
          <span class="chat-mode">
            Whisper to {mode.name}{' '}
            <button type="button" class="chip" onClick={() => setMode({ kind: 'all' })}>Cancel</button>
          </span>
        ) : (
          <label>
            <span class="sr-only">Send to</span>
            <select aria-label="Send to" value={modeValue}
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                setMode(v === 'all' ? { kind: 'all' } : { kind: 'team', team: Number(v.split(':')[1]) as 1 | 2 | 3 });
              }}>
              <option value="all">All</option>
              <option value="team:2">Survivors</option>
              <option value="team:3">Infected</option>
              <option value="team:1">Spectators</option>
            </select>
          </label>
        )}
        <input aria-label="Message" maxLength={190} value={text}
          onInput={(e) => setText((e.target as HTMLInputElement).value)} />
        <button type="submit" disabled={sending || !text.trim()}>Send</button>
      </form>
    </aside>
  );
}

function Line({ line: l, onName }: { line: ChatLineView; onName: (steamid: string, name: string) => void }) {
  const time = new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (l.kind === 'staff_out') {
    const to = l.to?.kind === 'player' ? `whisper to ${l.to.name ?? l.to.value}`
      : l.to?.kind === 'team' ? `to ${TEAM_NAME[l.to.value ?? ''] ?? 'team'}` : 'to everyone';
    const status = l.delivered === null ? 'sending' : l.delivered === -1 ? 'not sent'
      : l.delivered === 0 ? 'not on the server' : `delivered to ${l.delivered}`;
    return (
      <div class="chat-line chat-line--staff">
        <span class="muted">{time}</span> <strong>[Staff] {l.name}</strong> <span class="muted">({to})</span>: {l.message}{' '}
        <span class="muted">{status}</span>
      </div>
    );
  }
  const who = l.name ?? l.steamid ?? '?';
  return (
    <div class={`chat-line ${TEAM_CLASS[l.team ?? 0] ?? ''}${l.kind === 'staff_in' ? ' chat-line--to-staff' : ''}`}>
      <span class="muted">{time}</span>{' '}
      {l.steamid
        ? <button type="button" class="linkish" onClick={() => onName(l.steamid!, who)}>{who}</button>
        : <strong>{who}</strong>}
      {l.scope === 'team' && <>{' '}<span class="muted">(team)</span></>}
      {l.kind === 'staff_in' && <span class="chat-tag">to staff</span>}
      : {l.message}
    </div>
  );
}
```

`Empty` comes from `web/src/components/bits.tsx`; `.sr-only` already exists in app.css.

Add to `web/src/styles/app.css`:

```css
.chat-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(440px, 100vw); z-index: 40; display: flex; flex-direction: column; gap: 8px; padding: 12px 16px; background: var(--bg, #15120f); border-left: 1px solid rgba(255, 255, 255, 0.12); box-shadow: -8px 0 24px rgba(0, 0, 0, 0.4); }
.chat-drawer__head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.chat-log { flex: 1; overflow-y: auto; font-size: 0.95rem; display: flex; flex-direction: column; gap: 2px; }
.chat-line--surv { border-left: 3px solid #4a90d9; padding-left: 6px; }
.chat-line--inf { border-left: 3px solid #d94a4a; padding-left: 6px; }
.chat-line--spec { border-left: 3px solid #888; padding-left: 6px; }
.chat-line--staff { border-left: 3px solid #45b39c; padding-left: 6px; }
.chat-line--to-staff { background: rgba(69, 179, 156, 0.12); }
.chat-tag { margin-left: 6px; font-size: 0.8em; padding: 0 4px; border-radius: 3px; background: #45b39c; color: #111; }
.chat-send { display: flex; gap: 8px; flex-wrap: wrap; }
.chat-send input { flex: 1; min-width: 10rem; }
.linkish { background: none; border: 0; padding: 0; font: inherit; color: inherit; font-weight: 600; cursor: pointer; text-decoration: underline dotted; }
```

Check the real background token name (`grep -n "^\s*--bg\|--surface\|--panel" web/src/styles/app.css | head`) and use the one panels use, so the drawer matches the site in both themes.

- [ ] **Step 5: Wire it into the board**

In `AdminLive.tsx`:

```tsx
  const [chat, setChat] = useState<number | null>(() => chatFromUrl());
  const openChat = (id: number | null) => {
    setChat(id);
    // Keep the URL shareable and the back button sane: replace, not push.
    const q = new URLSearchParams(location.search);
    if (id === null) q.delete('chat'); else q.set('chat', String(id));
    const qs = q.toString();
    history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}`);
  };
```

Render `{chat !== null && <ChatDrawer serverId={chat} onPick={openChat} onClose={() => openChat(null)} />}` as the last child of the page's outer `div`. Pass `onChat={openChat}` to `AdminServersPanel` and to `MatchCard` (which has `match.server`).

In `AdminServersPanel` (MatchPanels.tsx), for every row and for mods and admins alike, after the host span in the name cell:

```tsx
{' '}<button type="button" class="chip" onClick={() => onChat(s.id)}>Chat</button>
```

In `MatchCard`, next to the card's heading, when `m.server` is set:

```tsx
<button type="button" class="chip" onClick={() => onChat(m.server!.id)}>Chat</button>
```

Add to `AdminLive.test.tsx` (mock `ChatDrawer` or `modApi.chat*` the way the file mocks other modules):

```tsx
  it('opens the chat drawer from a server row and from ?chat=', async () => {
    // same overview mock as the other render tests, one server with id 1
    render(<AdminLive isAdmin />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Chat' }))[0]);
    expect(await screen.findByRole('complementary', { name: 'Server chat' })).toBeTruthy();
  });
```

- [ ] **Step 6: Run the tests and build**

Run: `npx vitest run web/src && npm run typecheck && npm run build`
Expected: PASS and a clean build (`web/src/styles/app.css.test.ts` parses the stylesheet, so an unclosed brace fails here).

- [ ] **Step 7: Commit**

```bash
git add web/
git commit -m "staff chat: chat drawer on the Live board"
```

---

### Task 9: Links in: mod call card, In-game calls

**Files:**
- Modify: `src/discord/modCallCard.ts` (link row near line 147)
- Modify: `src/routes/modCalls.ts` and `web/src/api.ts` (`serverId` on ModCallView)
- Modify: `web/src/routes/admin/AdminCalls.tsx` (a link per call)
- Test: `tests/modCallPoster.test.ts`, `tests/modCallRoutes.test.ts`, `web/src/routes/admin/AdminCalls.test.tsx`

**Interfaces:**
- Consumes: `/admin/live?chat=<serverId>` (Task 8).
- Produces: `ModCallView.serverId: number | null`.

- [ ] **Step 1: Failing tests**

In `tests/modCallPoster.test.ts`, after the Join-line tests (its `call()` helper files every call on `serverId`):

```ts
  it('links to that server\'s chat', async () => {
    call(); await poster.idle();
    const buttons = inAdmin()[0].payload.components[0];
    expect(buttons).toContainEqual({ kind: 'link', label: 'Server chat', url: `https://pug.test/admin/live?chat=${serverId}` });
  });
```

In `tests/modCallRoutes.test.ts`, add:

```ts
  it('gives each call its server id', async () => {
    const sid = Number(db.prepare(
      "INSERT INTO servers (name, host, port, rcon_port, rcon_password, tv_port, tv_enabled) VALUES ('Dallas', '1.2.3.4', 27015, 27015, 'x', 27020, 1)",
    ).run().lastInsertRowid);
    call({ server_id: sid });
    call({ text: 'no server' });
    const body = (await get(MOD, '/api/mod/calls?filter=all')).json();
    expect(body.calls.map((c: { serverId: number | null }) => c.serverId)).toEqual([null, sid]);
  });
```

In `web/src/routes/admin/AdminCalls.test.tsx`, add `serverId: 3` to the `call()` factory and:

```tsx
  it('links each call to its server chat', async () => {
    mockMod.calls.mockResolvedValue({ calls: [call()], discordReady: true });
    render(<AdminCalls />);
    expect((await screen.findByText('server chat')).getAttribute('href')).toBe('/admin/live?chat=3');
  });
```

Run: `npx vitest run tests/modCallPoster.test.ts tests/modCallRoutes.test.ts web/src/routes/admin/AdminCalls.test.tsx`. Expected: the new assertions FAIL.

- [ ] **Step 2: Implement**

`src/discord/modCallCard.ts`, after the Replay moment button:

```ts
  if (call.server_id !== null) {
    row.push({ kind: 'link', label: 'Server chat', url: `${publicUrl}/admin/live?chat=${call.server_id}` });
  }
```

Discord allows 5 components per row: Handling it, Replay moment, Ticket, Server chat is 4.

`src/routes/modCalls.ts`: add `serverId: number | null;` to `ModCallView` and `serverId: c.server_id,` in `view()`. Same field in `web/src/api.ts` ModCallView.

`AdminCalls.tsx`: beside the existing "replay moment" link for a call, add
`{c.serverId !== null && <a href={`/admin/live?chat=${c.serverId}`}>server chat</a>}`
with the same separator markup its neighbours use.

- [ ] **Step 3: Run the tests and build**

Run: `npx vitest run tests/modCallPoster.test.ts tests/modCallRoutes.test.ts web/src/routes/admin && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/ web/ tests/
git commit -m "staff chat: Server chat links on mod call cards and In-game calls"
```

---

### Task 10: Spec touch-up and full check

**Files:**
- Modify: `docs/superpowers/specs/2026-09-28-staff-server-chat-design.md`

- [ ] **Step 1: Check the spec against what was built**

The spec was updated on 2026-09-28 for the drawer, the Live desk opening and the team/all scope. Read it against the branch and fix anything that drifted during the build (route names, labels, toggle name).

- [ ] **Step 2: Full suite**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green. `server.test.ts` malformed-URL may fail in a fresh worktree without `dist/public`; `npm run build` first produces it. Any other failure is real: fix it.

- [ ] **Step 3: Commit**

```bash
git add docs/
git commit -m "spec: staff chat as built"
```

Shipping (web deploy, then pug-match 0.3.16 on empty servers) is NOT part of this plan: it needs the owner's go-ahead per server.
