# Cancel Teardown and Server Bans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cancelled match empties its game server and puts it on a known map, and every website ban (and every lift) is enforced on every enabled game server.

**Architecture:** The backend's single release path gains a `teardown` flag that makes the one abort command it already sends carry `teardown <map>`; the plugin then does the bounded unpause, the kick and the map change itself. Bans are pushed as permanent SourceMod bans (`sm_addban 0`) over RCON: immediately on change through a small in-process bus, unconditionally every five minutes by a sweep that derives the desired state from the `bans` table, and once more on the connection `setupMatch` already holds.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Fastify, better-sqlite3, vitest; SourcePawn (SourceMod 1.12) compiled with `plugin/build.sh` (wine + spcomp).

**Spec:** `docs/superpowers/specs/2026-09-19-cancel-teardown-and-server-bans-design.md`

## Global Constraints

- No em dashes anywhere: code, comments, commit messages, docs. Rephrase by meaning.
- Server bans are always permanent on the box: `sm_addban 0 ...`. The website owns expiry.
- SteamIDs sent to the game server are `STEAM_1:Y:Z`. Never `[U:1:N]` (the engine cannot parse it) and never SteamID64.
- Nothing in this plan touches the Dallas box. Local verification uses `/home/volence/l4d1-ds` only, and half 2 cannot be verified there (`sv_lan 1` makes `sm_addban` a silent no-op).
- Never `FakeClientCommand` a fake client to pause or unpause; it segfaults srcds.
- Commit messages match the repo's style: a short sentence in the imperative, no conventional-commit prefix (see `git log --oneline -10`).
- Run `npm run typecheck` before every commit that touches `src/`.
- All test commands run from `/home/volence/l4d/pug`.

## File Structure

| file | responsibility |
|---|---|
| `src/steamId.ts` (new) | SteamID64 to `STEAM_1:Y:Z`. Pure. |
| `src/banEvents.ts` (new) | Process-wide bus for "a ban changed", mirroring `adminFeed.ts`. |
| `src/serverBans.ts` (new) | `ServerBanSync`: command generation from the `bans` table, immediate push, five minute sweep, rate-limited failure reporting. |
| `src/matchTeardown.ts` (new) | `resetMap`, `abortCommand`, `problemText`: the strings the release path and the PROBLEM handler need. |
| `src/admin/players.ts` | Publishes a ban change from the three writers of the `bans` table. |
| `src/serverRelease.ts` | `release(id, opts)`; `ServerCleaner` receives `opts`. |
| `src/server.ts` | `cleanServer` sends the teardown form; wires `ServerBanSync`; forwards `PROBLEM` lines to the admin feed. |
| `src/abandon.ts`, `src/noShow.ts`, `src/admin/matches.ts` | Pass `{ teardown: true }`. |
| `src/orchestrator.ts` | `beforeLive` hook, run on the setup connection before the changelevel. |
| `src/logParse.ts` | `PROBLEM code=...` line. |
| `src/settingsSchema.ts`, `src/db.ts` | `reset_map` setting. |
| `plugin/pug-match.sp` | `sm_pug_abort <token> teardown <map>`: unpause wait, kick, changelevel. |
| `plugin/README.md`, `plugin/TESTING.md` | Command documentation and the manual staging test. |

---

### Task 1: SteamID conversion

**Files:**
- Create: `src/steamId.ts`
- Test: `tests/steamId.test.ts`

**Interfaces:**
- Produces: `steam64ToSteam2(id64: string): string`, throws `Error` on anything that is not a 17 digit SteamID64 at or above the base.

- [ ] **Step 1: Write the failing test**

```ts
// tests/steamId.test.ts
import { describe, it, expect } from 'vitest';
import { steam64ToSteam2 } from '../src/steamId.js';

describe('steam64ToSteam2', () => {
  it('converts the verified live pair', () => {
    // How the Dallas logs print this account. Recorded in the spec.
    expect(steam64ToSteam2('76561198030413993')).toBe('STEAM_1:1:35074132');
  });

  it('handles an even account id', () => {
    // base + 2 -> Y = 0, Z = 1
    expect(steam64ToSteam2('76561197960265730')).toBe('STEAM_1:0:1');
  });

  it('handles the first possible account', () => {
    expect(steam64ToSteam2('76561197960265729')).toBe('STEAM_1:1:0');
  });

  it('rejects anything that is not a SteamID64', () => {
    expect(() => steam64ToSteam2('STEAM_1:1:35074132')).toThrow(/not a SteamID64/);
    expect(() => steam64ToSteam2('1234')).toThrow(/not a SteamID64/);
    expect(() => steam64ToSteam2('')).toThrow(/not a SteamID64/);
    // 17 digits but below the base: not an individual account.
    expect(() => steam64ToSteam2('10000000000000000')).toThrow(/not a SteamID64/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/steamId.test.ts`
Expected: FAIL, cannot find module `../src/steamId.js`

- [ ] **Step 3: Write the implementation**

```ts
// src/steamId.ts
/** The SteamID64 of account 0 in the individual-account universe. */
const STEAM64_BASE = 76561197960265728n;

/**
 * SteamID64 to the classic `STEAM_1:Y:Z` form.
 *
 * This is the only form the L4D1 engine's `banid` parses: `strings engine.so`
 * shows `STEAM_%u:%u:%u` and no SteamID3 parser at all. SourceMod's
 * `sm_addban` also accepts `[U:1:N]`, but it hands the string straight to the
 * engine, so that form would be accepted and then silently match nobody. The
 * universe digit is 1 because that is what the engine prints in its own logs.
 *
 * Verified pair: 76561198030413993 is logged by the Dallas box as
 * STEAM_1:1:35074132, and 35074132 * 2 + 1 == 70148265 == id64 - base.
 */
export function steam64ToSteam2(id64: string): string {
  if (!/^\d{17}$/.test(id64)) throw new Error(`not a SteamID64: ${id64}`);
  const acc = BigInt(id64) - STEAM64_BASE;
  if (acc < 0n) throw new Error(`not a SteamID64: ${id64}`);
  return `STEAM_1:${acc % 2n}:${acc / 2n}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/steamId.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/steamId.ts tests/steamId.test.ts
git commit -m "Convert SteamID64 to the STEAM_1 form the engine parses"
```

---

### Task 2: Ban change bus

**Files:**
- Create: `src/banEvents.ts`
- Modify: `src/admin/players.ts:38-75` (`banPlayer`, `unbanPlayer`, `liftExpiredBans`)
- Test: `tests/banEvents.test.ts`

**Interfaces:**
- Produces: `type BanChange = { kind: 'ban'; steamid: string; reason: string } | { kind: 'unban'; steamid: string }`, `publishBanChange(e: BanChange): void`, `subscribeBanChanges(fn: (e: BanChange) => void): () => void`.
- Every writer of the `bans` table publishes after its transaction commits. `liftExpiredBans` publishes `unban` only for a player left with no other open ban, which is exactly the set it already returns.

- [ ] **Step 1: Write the failing test**

```ts
// tests/banEvents.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { banPlayer, unbanPlayer, liftExpiredBans } from '../src/admin/players.js';
import { subscribeBanChanges, type BanChange } from '../src/banEvents.js';

const P = '76561198000000002';
let db: DB;
let seen: BanChange[];
let unsub: () => void;

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare('INSERT INTO players (steamid, name) VALUES (?, ?)').run(P, 'p2');
  seen = [];
  unsub?.();
  unsub = subscribeBanChanges((e) => seen.push(e));
});

describe('ban change bus', () => {
  it('banPlayer publishes a ban with its reason', () => {
    banPlayer(db, P, 'admin', 'Griefing', 60);
    expect(seen).toEqual([{ kind: 'ban', steamid: P, reason: 'Griefing' }]);
  });

  it('unbanPlayer publishes an unban', () => {
    banPlayer(db, P, 'admin', 'Griefing', 60);
    unbanPlayer(db, P, 'admin');
    expect(seen.at(-1)).toEqual({ kind: 'unban', steamid: P });
  });

  it('liftExpiredBans publishes an unban once the last ban has run out', () => {
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    banPlayer(db, P, 'system', 'Abandoned match #1', 60, past);
    seen = [];
    liftExpiredBans(db);
    expect(seen).toEqual([{ kind: 'unban', steamid: P }]);
  });

  it('liftExpiredBans stays quiet while another ban is still open', () => {
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    banPlayer(db, P, 'system', 'Abandoned match #1', 60, past);
    banPlayer(db, P, 'admin', 'Griefing', null);
    seen = [];
    liftExpiredBans(db);
    expect(seen).toEqual([]);
  });

  it('a throwing subscriber does not stop publishing', () => {
    subscribeBanChanges(() => { throw new Error('boom'); });
    banPlayer(db, P, 'admin', 'Griefing', 60);
    expect(seen).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/banEvents.test.ts`
Expected: FAIL, cannot find module `../src/banEvents.js`

- [ ] **Step 3: Write the bus**

```ts
// src/banEvents.ts
/**
 * "A ban changed", published from the three writers of the bans table and
 * consumed by whatever enforces bans somewhere else (today, ServerBanSync).
 *
 * A process-wide bus for the same reason adminFeed.ts is one: the writers are
 * reached from the admin routes, the abandon handler and the 60 second reaper,
 * none of which have any business holding an RCON client, and a missing
 * subscriber must cost nothing. Publishing never throws.
 *
 * This is latency only. Correctness comes from the sweep in serverBans.ts,
 * which reads the table and does not rely on having been told.
 */

export type BanChange =
  | { kind: 'ban'; steamid: string; reason: string }
  | { kind: 'unban'; steamid: string };

type Listener = (e: BanChange) => void;
const listeners = new Set<Listener>();

export function publishBanChange(e: BanChange): void {
  for (const fn of listeners) {
    try {
      fn(e);
    } catch (err) {
      console.error('[banEvents] listener failed:', err);
    }
  }
}

export function subscribeBanChanges(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
```

- [ ] **Step 4: Publish from the three writers**

In `src/admin/players.ts`, add the import at the top:

```ts
import { publishBanChange } from '../banEvents.js';
```

Replace `banPlayer` so the publish happens after the transaction:

```ts
export function banPlayer(
  db: DB, steamid: string, by: string, reason: string, minutes: number | null, now = new Date(),
): void {
  const expires = minutes ? new Date(now.getTime() + minutes * 60 * 1000).toISOString() : null;
  db.transaction(() => {
    db.prepare('INSERT INTO bans (player_id, reason, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(steamid, reason, by, now.toISOString(), expires);
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(steamid);
  })();
  // After the commit, never inside it: a subscriber may dial RCON.
  publishBanChange({ kind: 'ban', steamid, reason });
}
```

Replace `unbanPlayer`:

```ts
/** Lift every open ban and restore the player to active. */
export function unbanPlayer(db: DB, steamid: string, by: string, now = new Date()): void {
  db.transaction(() => {
    db.prepare('UPDATE bans SET lifted_by = ?, lifted_at = ? WHERE player_id = ? AND lifted_at IS NULL')
      .run(by, now.toISOString(), steamid);
    db.prepare("UPDATE players SET status = 'active' WHERE steamid = ? AND status = 'banned'").run(steamid);
  })();
  publishBanChange({ kind: 'unban', steamid });
}
```

In `liftExpiredBans`, the loop already pushes to `lifted` only when no other ban remains open. Add one line right after `lifted.push(player_id);`:

```ts
      lifted.push(player_id);
      publishBanChange({ kind: 'unban', steamid: player_id });
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/banEvents.test.ts tests/adminPlayers.test.ts tests/abandon.test.ts`
Expected: PASS. The existing suites still pass because nothing is subscribed in them.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/banEvents.ts src/admin/players.ts tests/banEvents.test.ts
git commit -m "Publish a ban change from every writer of the bans table"
```

---

### Task 3: ServerBanSync

**Files:**
- Create: `src/serverBans.ts`
- Test: `tests/serverBans.test.ts`

**Interfaces:**
- Consumes: `steam64ToSteam2` (Task 1), `subscribeBanChanges`/`BanChange` (Task 2), `listServers`/`ServerRow` from `src/serverPool.ts`, `publishAdminEvent` from `src/adminFeed.ts`.
- Produces:
  - `type ServerExec = (server: ServerRow, commands: string[]) => Promise<void>`
  - `banCommand(steamid: string, reason: string): string` and `unbanCommand(steamid: string): string`
  - `class ServerBanSync { constructor(deps: { db: DB; exec: ServerExec; now?: () => number }); commands(): string[]; sweep(): Promise<void>; onChange(e: BanChange): Promise<void>; pushAll(exec: (cmd: string) => Promise<unknown>): Promise<void>; start(): void; stop(): void }`
  - `SWEEP_MS = 300000`, `UNBAN_WINDOW_MS = 30 days`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/serverBans.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer, setEnabled, type ServerRow } from '../src/serverPool.js';
import { banPlayer, unbanPlayer } from '../src/admin/players.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { ServerBanSync, banCommand, unbanCommand, UNBAN_WINDOW_MS } from '../src/serverBans.js';

// 76561198030413993 is STEAM_1:1:35074132 (the verified pair).
const P1 = '76561198030413993';
const P2 = '76561197960265730'; // STEAM_1:0:1
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let db: DB;
let sent: { server: string; commands: string[] }[];
let clock: number;
let s1: number;
let s2: number;

const exec = async (server: ServerRow, commands: string[]) => { sent.push({ server: server.name, commands }); };
const sync = (over: Partial<ConstructorParameters<typeof ServerBanSync>[0]> = {}) =>
  new ServerBanSync({ db, exec, now: () => clock, ...over });

beforeEach(() => {
  db = openDb(':memory:');
  for (const p of [P1, P2]) db.prepare('INSERT INTO players (steamid, name) VALUES (?, ?)').run(p, p);
  s1 = addServer(db, { name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
  s2 = addServer(db, { name: 'chicago', host: '10.0.0.2', port: 27015, rconPort: 27015, rconPassword: 'x' });
  sent = [];
  clock = Date.parse('2026-09-19T12:00:00Z');
});

describe('command text', () => {
  it('bans permanently, in STEAM_1 form, with a quoted reason', () => {
    expect(banCommand(P1, 'Abandoned match #12')).toBe('sm_addban 0 "STEAM_1:1:35074132" "Abandoned match #12"');
    expect(unbanCommand(P1)).toBe('sm_unban "STEAM_1:1:35074132"');
  });

  it('strips characters that would end the argument or the command', () => {
    expect(banCommand(P2, 'he said "hi"; rcon_password x')).toBe('sm_addban 0 "STEAM_1:0:1" "he said  hi   rcon_password x"');
  });

  it('never sends an empty reason', () => {
    expect(banCommand(P2, '"')).toBe('sm_addban 0 "STEAM_1:0:1" "banned"');
  });
});

describe('ServerBanSync.commands', () => {
  it('lists every open ban and no lifted one', () => {
    banPlayer(db, P1, 'admin', 'Griefing', null, new Date(clock));
    banPlayer(db, P2, 'system', 'Abandoned match #3', 1440, new Date(clock));
    expect(sync().commands()).toEqual([
      banCommand(P2, 'Abandoned match #3'),
      banCommand(P1, 'Griefing'),
    ]);
  });

  it('uses the newest reason when a player has several open bans', () => {
    banPlayer(db, P1, 'admin', 'first', null, new Date(clock - HOUR));
    banPlayer(db, P1, 'admin', 'second', null, new Date(clock));
    expect(sync().commands()).toEqual([banCommand(P1, 'second')]);
  });

  it('treats an expired ban as not open', () => {
    banPlayer(db, P1, 'system', 'Abandoned match #3', 60, new Date(clock - 2 * HOUR));
    expect(sync().commands()).toEqual([]);
  });

  it('unbans anyone lifted inside the window and nobody outside it', () => {
    banPlayer(db, P1, 'admin', 'old', null, new Date(clock - 40 * DAY));
    unbanPlayer(db, P1, 'admin', new Date(clock - 31 * DAY));
    banPlayer(db, P2, 'admin', 'recent', null, new Date(clock - 2 * DAY));
    unbanPlayer(db, P2, 'admin', new Date(clock - DAY));
    expect(UNBAN_WINDOW_MS).toBe(30 * DAY);
    expect(sync().commands()).toEqual([unbanCommand(P2)]);
  });

  it('never unbans a player who still has an open ban', () => {
    banPlayer(db, P1, 'admin', 'old', null, new Date(clock - 2 * DAY));
    unbanPlayer(db, P1, 'admin', new Date(clock - DAY));
    banPlayer(db, P1, 'admin', 'again', null, new Date(clock));
    expect(sync().commands()).toEqual([banCommand(P1, 'again')]);
  });
});

describe('ServerBanSync pushing', () => {
  it('sweep sends the full command set to every enabled server and skips disabled ones', async () => {
    banPlayer(db, P1, 'admin', 'Griefing', null, new Date(clock));
    setEnabled(db, s2, false);
    await sync().sweep();
    expect(sent).toEqual([{ server: 'dallas', commands: [banCommand(P1, 'Griefing')] }]);
  });

  it('sweep sends nothing when there is nothing to say', async () => {
    await sync().sweep();
    expect(sent).toEqual([]);
  });

  it('onChange pushes just that change to every enabled server', async () => {
    await sync().onChange({ kind: 'ban', steamid: P1, reason: 'Griefing' });
    await sync().onChange({ kind: 'unban', steamid: P2 });
    expect(sent.map((s) => s.server)).toEqual(['dallas', 'chicago', 'dallas', 'chicago']);
    expect(sent[0].commands).toEqual([banCommand(P1, 'Griefing')]);
    expect(sent[2].commands).toEqual([unbanCommand(P2)]);
  });

  it('pushAll runs every command through a caller-supplied exec', async () => {
    banPlayer(db, P1, 'admin', 'Griefing', null, new Date(clock));
    const ran: string[] = [];
    await sync().pushAll(async (c) => { ran.push(c); });
    expect(ran).toEqual([banCommand(P1, 'Griefing')]);
  });

  it('a failing server neither throws nor stops the others', async () => {
    banPlayer(db, P1, 'admin', 'Griefing', null, new Date(clock));
    const failing = async (server: ServerRow, commands: string[]) => {
      if (server.name === 'dallas') throw new Error('ECONNREFUSED');
      sent.push({ server: server.name, commands });
    };
    await sync({ exec: failing }).sweep();
    expect(sent.map((s) => s.server)).toEqual(['chicago']);
  });

  it('reports a failing server to the admin feed at most once an hour', async () => {
    banPlayer(db, P1, 'admin', 'Griefing', null, new Date(clock));
    const events: AdminEvent[] = [];
    const unsub = subscribeAdminEvents((e) => events.push(e));
    const failing = async () => { throw new Error('ECONNREFUSED'); };
    const s = sync({ exec: failing });
    await s.sweep();
    await s.sweep();
    expect(events.filter((e) => e.kind === 'problem')).toHaveLength(2); // one per server
    clock += 61 * 60 * 1000;
    await s.sweep();
    expect(events.filter((e) => e.kind === 'problem')).toHaveLength(4);
    expect(events.some((e) => e.kind === 'problem' && /Could not push bans to dallas/.test(e.text))).toBe(true);
    unsub();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/serverBans.test.ts`
Expected: FAIL, cannot find module `../src/serverBans.js`

- [ ] **Step 3: Write the implementation**

```ts
// src/serverBans.ts
import type { DB } from './db.js';
import { listServers, type ServerRow } from './serverPool.js';
import { steam64ToSteam2 } from './steamId.js';
import { publishAdminEvent } from './adminFeed.js';
import { subscribeBanChanges, type BanChange } from './banEvents.js';

/**
 * Keeps every enabled game server's ban list equal to the website's.
 *
 * The website is the source of truth and the boxes are replicas that
 * converge. Three pushes, in order of how much correctness rests on them:
 *
 *   1. The sweep. Every SWEEP_MS, every open ban is re-sent to every enabled
 *      server, unconditionally, with no memory of what a box was told before.
 *      This is what makes the system right: `sm_addban` on an id that is
 *      already banned is harmless, so re-sending is free, and a box that was
 *      offline, restarted or rebuilt heals on its next sweep.
 *   2. The setup push (pushAll), run by the orchestrator on the connection it
 *      already holds before a match goes live, so a box about to host ranked
 *      play is current whatever the sweep's phase.
 *   3. The immediate push (onChange), fed by banEvents. Latency only.
 *
 * Bans go to the box as PERMANENT (`sm_addban 0`). SourceMod only writes
 * `banned_user.cfg` for permanent bans (core/logic/smn_banning.cpp, the
 * writeid is behind `ban_time == 0`), so a timed engine ban would be lost on
 * every server restart while most of ours are 1 to 7 day abandon bans. The
 * website already knows when each ban ends (liftExpiredBans runs every
 * minute) and lifts on the box at the same moment, so there is one clock.
 *
 * `sm_unban` reaches RemoveBan, which issues removeid AND writeid, so a lift
 * persists too. Checked; without it a lift would resurrect on restart.
 */

export const SWEEP_MS = 5 * 60 * 1000;
/** How far back the sweep keeps re-sending sm_unban. A permanent ban on disk
 *  survives however long a box is down, so this must cover the longest
 *  plausible outage. A box down longer than this is being rebuilt anyway. */
export const UNBAN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const REPORT_EVERY_MS = 60 * 60 * 1000;

/** Runs a batch of console commands on one server. Injected so tests never
 *  dial RCON. Must reject on failure; the caller does the logging. */
export type ServerExec = (server: ServerRow, commands: string[]) => Promise<void>;

/** Quotes and semicolons would end the argument or the command on the
 *  console; newlines would start a new one. Reasons are admin-typed text. */
function consoleSafe(reason: string): string {
  const s = reason.replace(/["\r\n;]/g, ' ').slice(0, 120).trim();
  return s || 'banned';
}

export function banCommand(steamid: string, reason: string): string {
  return `sm_addban 0 "${steam64ToSteam2(steamid)}" "${consoleSafe(reason)}"`;
}

export function unbanCommand(steamid: string): string {
  return `sm_unban "${steam64ToSteam2(steamid)}"`;
}

export class ServerBanSync {
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Server id to the last time its failure was posted to the admin feed. */
  private lastReported = new Map<number, number>();

  constructor(private deps: { db: DB; exec: ServerExec; now?: () => number }) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * Everything a box should be told right now: a ban for every player with an
   * open ban (newest reason wins), then an unban for every player lifted
   * inside the window who has no open ban left. Deterministic order so tests
   * and logs are readable.
   */
  commands(): string[] {
    const nowIso = new Date(this.now()).toISOString();
    const since = new Date(this.now() - UNBAN_WINDOW_MS).toISOString();
    const open = this.deps.db.prepare(
      `SELECT b.player_id, b.reason FROM bans b
       WHERE b.id IN (
         SELECT MAX(id) FROM bans
         WHERE lifted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
         GROUP BY player_id
       )
       ORDER BY b.player_id`,
    ).all(nowIso) as { player_id: string; reason: string }[];
    const openIds = new Set(open.map((r) => r.player_id));
    const lifted = this.deps.db.prepare(
      'SELECT DISTINCT player_id FROM bans WHERE lifted_at IS NOT NULL AND lifted_at >= ? ORDER BY player_id',
    ).all(since) as { player_id: string }[];
    return [
      ...open.map((r) => banCommand(r.player_id, r.reason)),
      ...lifted.filter((r) => !openIds.has(r.player_id)).map((r) => unbanCommand(r.player_id)),
    ];
  }

  /** The unconditional repair pass. See the class comment. */
  async sweep(): Promise<void> {
    const cmds = this.commands();
    if (cmds.length === 0) return;
    await this.pushToAll(cmds);
  }

  /** One change, now. The sweep will say it again in five minutes anyway. */
  async onChange(e: BanChange): Promise<void> {
    const cmd = e.kind === 'ban' ? banCommand(e.steamid, e.reason) : unbanCommand(e.steamid);
    await this.pushToAll([cmd]);
  }

  /** For a caller that already holds a connection to one box (match setup). */
  async pushAll(exec: (cmd: string) => Promise<unknown>): Promise<void> {
    for (const c of this.commands()) await exec(c);
  }

  private async pushToAll(cmds: string[]): Promise<void> {
    const servers = listServers(this.deps.db).filter((s) => s.enabled === 1);
    await Promise.all(servers.map(async (s) => {
      try {
        await this.deps.exec(s, cmds);
      } catch (err) {
        // Never rethrown: a dead box is out of date until it is back, and
        // that must not stop the other boxes or the caller.
        console.error(`[serverBans] push to ${s.name} failed:`, err);
        this.report(s, err);
      }
    }));
  }

  private report(s: ServerRow, err: unknown): void {
    const last = this.lastReported.get(s.id) ?? 0;
    if (this.now() - last < REPORT_EVERY_MS) return;
    this.lastReported.set(s.id, this.now());
    publishAdminEvent({
      kind: 'problem',
      text: `Could not push bans to ${s.name}: ${err instanceof Error ? err.message : String(err)}. `
        + `Its ban list may be out of date; it is retried every ${SWEEP_MS / 60_000} minutes.`,
    });
  }

  /** Subscribe to changes and start the sweep timer. */
  start(): void {
    this.unsubscribe = subscribeBanChanges((e) => { void this.onChange(e); });
    this.timer = setInterval(() => {
      this.sweep().catch((err) => console.error('[serverBans] sweep failed:', err));
    }, SWEEP_MS);
    this.timer.unref();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/serverBans.test.ts`
Expected: PASS, 13 tests

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/serverBans.ts tests/serverBans.test.ts
git commit -m "Sync the website's bans to every game server as permanent engine bans"
```

---

### Task 4: The reset map setting and the teardown strings

**Files:**
- Modify: `src/settingsSchema.ts:32` (insert after the `no_round_minutes` entry)
- Modify: `src/db.ts:437-475` (`DEFAULT_SETTINGS`)
- Create: `src/matchTeardown.ts`
- Test: `tests/matchTeardown.test.ts`

**Interfaces:**
- Produces: `DEFAULT_RESET_MAP = 'l4d_hospital01_apartment'`, `resetMap(db: DB): string`, `abortCommand(token: string, teardown: boolean, map: string): string`, `problemText(code: string, matchId: number | null): string`.
- The setting key is `reset_map`. `openDb` seeds it with `INSERT OR IGNORE` (`src/db.ts:567`), so existing databases get the default on next start.

- [ ] **Step 1: Write the failing test**

```ts
// tests/matchTeardown.test.ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { getSetting, setSetting } from '../src/settings.js';
import { validateSetting } from '../src/settingsSchema.js';
import { DEFAULT_RESET_MAP, resetMap, abortCommand, problemText } from '../src/matchTeardown.js';

const TOKEN = 'a'.repeat(32);

describe('reset_map setting', () => {
  it('is seeded with the stock default', () => {
    const db = openDb(':memory:');
    expect(getSetting(db, 'reset_map')).toBe(DEFAULT_RESET_MAP);
    expect(DEFAULT_RESET_MAP).toBe('l4d_hospital01_apartment');
  });

  it('is editable through the schema and cannot be blank', () => {
    expect(validateSetting('reset_map', 'l4d_vs_farm01_hilltop')).toEqual({ ok: true, value: 'l4d_vs_farm01_hilltop' });
    expect(validateSetting('reset_map', '')).toEqual({ ok: false, error: 'cannot be empty' });
  });
});

describe('resetMap', () => {
  it('returns the setting', () => {
    const db = openDb(':memory:');
    setSetting(db, 'reset_map', 'l4d_airport01_greenhouse');
    expect(resetMap(db)).toBe('l4d_airport01_greenhouse');
  });

  it('falls back rather than sending garbage to the console', () => {
    const db = openDb(':memory:');
    setSetting(db, 'reset_map', 'x; rcon_password pwned');
    expect(resetMap(db)).toBe(DEFAULT_RESET_MAP);
    setSetting(db, 'reset_map', '');
    expect(resetMap(db)).toBe(DEFAULT_RESET_MAP);
  });
});

describe('abortCommand', () => {
  it('is the plain abort without teardown', () => {
    expect(abortCommand(TOKEN, false, 'l4d_hospital01_apartment')).toBe(`sm_pug_abort ${TOKEN}`);
  });
  it('carries the map with teardown', () => {
    expect(abortCommand(TOKEN, true, 'l4d_hospital01_apartment')).toBe(`sm_pug_abort ${TOKEN} teardown l4d_hospital01_apartment`);
  });
});

describe('problemText', () => {
  it('explains the unpause timeout and names the match', () => {
    expect(problemText('unpause_timeout', 42)).toMatch(/match #42/);
    expect(problemText('unpause_timeout', 42)).toMatch(/did not unpause/);
  });
  it('still says something for a code it does not know', () => {
    expect(problemText('mystery', null)).toMatch(/mystery/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/matchTeardown.test.ts`
Expected: FAIL, cannot find module `../src/matchTeardown.js`

- [ ] **Step 3: Add the setting**

In `src/settingsSchema.ts`, insert after the `no_round_minutes` entry:

```ts
  { key: 'reset_map', group: 'Match', label: 'Reset map', help: 'Where a server is sent once a cancelled match has emptied it. A stock L4D1 map name, such as l4d_hospital01_apartment.', type: { kind: 'string', maxLength: 64, allowEmpty: false } },
```

In `src/db.ts` `DEFAULT_SETTINGS`, insert after `no_round_minutes: '30',`:

```ts
  // Where a server is sent after a cancelled match empties it. No Mercy 1 is
  // the stock default map, so an idle box looks the way a fresh one does.
  reset_map: 'l4d_hospital01_apartment',
```

- [ ] **Step 4: Write the module**

```ts
// src/matchTeardown.ts
import type { DB } from './db.js';
import { getSetting } from './settings.js';

/**
 * The strings the release path needs when a match ends badly.
 *
 * A cancelled match (abandon, no-show, admin abort) leaves its box with the
 * roster still connected, possibly paused, on the match map, and the standing
 * sv_password lets the leaver straight back in. The plugin does the actual
 * work (unpause, kick, changelevel) behind one extra argument to
 * sm_pug_abort; this module owns what the backend sends and what it says when
 * the plugin reports trouble.
 */

export const DEFAULT_RESET_MAP = 'l4d_hospital01_apartment';
const MAP_RE = /^[a-z0-9_]{1,64}$/i;

/** The map an emptied server is sent to. Falls back rather than throws: this
 *  is read on the release path, which must never fail over a setting, and it
 *  ends up on a console line, so anything but a bare map name is refused. */
export function resetMap(db: DB): string {
  const v = (getSetting(db, 'reset_map') ?? '').trim();
  return MAP_RE.test(v) ? v : DEFAULT_RESET_MAP;
}

/** The one command the release path sends the plugin. With `teardown` the
 *  plugin announces, waits for an unpause, kicks everyone and changes to
 *  `map` itself; see Cmd_Abort in plugin/pug-match.sp. Without it, behaviour
 *  is the routine post-report abort, unchanged. */
export function abortCommand(token: string, teardown: boolean, map: string): string {
  return teardown ? `sm_pug_abort ${token} teardown ${map}` : `sm_pug_abort ${token}`;
}

/** Admin-feed text for a `PUG <token> PROBLEM code=<code>` line. */
export function problemText(code: string, matchId: number | null): string {
  const m = matchId === null ? 'a match' : `match #${matchId}`;
  switch (code) {
    case 'unpause_timeout':
      return `Tearing down ${m}: the game did not unpause within 10 seconds. Players were kicked and the map `
        + 'changed anyway; if the server is still paused an admin must unpause it in game.';
    default:
      return `Tearing down ${m}: the plugin reported ${code}.`;
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/matchTeardown.test.ts tests/adminSettings.test.ts tests/db.test.ts`
Expected: PASS

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/settingsSchema.ts src/db.ts src/matchTeardown.ts tests/matchTeardown.test.ts
git commit -m "Add the reset map setting and the teardown command text"
```

---

### Task 5: The release path asks for a teardown

**Files:**
- Modify: `src/serverRelease.ts:4-10` (`ServerCleaner`), `:74-100` (`release`)
- Modify: `src/server.ts:275-323` (`cleanServer`)
- Modify: `src/abandon.ts:72`, `src/noShow.ts:85`, `src/admin/matches.ts:64`
- Test: `tests/serverRelease.test.ts`, `tests/abandon.test.ts`, `tests/noShow.test.ts`, `tests/adminMatches.test.ts`

**Interfaces:**
- Consumes: `abortCommand`, `resetMap` (Task 4).
- Produces: `interface ReleaseOpts { teardown: boolean }`; `ServerReleaser.release(serverId: number, opts?: Partial<ReleaseOpts>): void`; `type ServerCleaner = (server: ServerRow, token: string | null, opts: ReleaseOpts) => Promise<void>`. Every existing caller and every existing test cleaner keeps compiling: the parameter is optional on the way in and extra on the way out.

- [ ] **Step 1: Write the failing tests**

Append to `tests/serverRelease.test.ts` inside `describe('ServerReleaser', ...)`:

```ts
  it('tells the cleaner this is not a teardown unless asked', async () => {
    const db = openDb(':memory:');
    const id = seedServer(db);
    markLive(db, id);
    const seen: boolean[] = [];
    const clear: ServerCleaner = async (_s, _t, opts) => { seen.push(opts.teardown); };
    const releaser = new ServerReleaser(db, clear);
    releaser.release(id);
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual([false]);
  });

  it('passes a requested teardown through to the cleaner', async () => {
    const db = openDb(':memory:');
    const id = seedServer(db);
    markLive(db, id);
    const seen: boolean[] = [];
    const clear: ServerCleaner = async (_s, _t, opts) => { seen.push(opts.teardown); };
    const releaser = new ServerReleaser(db, clear);
    releaser.release(id, { teardown: true });
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual([true]);
  });
```

Append to `tests/abandon.test.ts` a new describe (the file's `deps()` helper stubs the releaser, so this test brings its own):

```ts
describe('abandon teardown', () => {
  it('releases the box with a teardown', async () => {
    const calls: { id: number; opts: unknown }[] = [];
    const d = {
      db,
      releaser: { release: (id: number, opts: unknown) => void calls.push({ id, opts }) } as never,
      confirm: async () => true,
    };
    await handleAbandon(d, TOKEN, IDS[0]);
    expect(calls).toEqual([{ id: serverId, opts: { teardown: true } }]);
  });
});
```

Append to `tests/noShow.test.ts`:

```ts
describe('no-show teardown', () => {
  it('releases the box with a teardown', () => {
    const db = openDb(':memory:');
    const { serverId } = liveMatch(db, 15);
    const seen: boolean[] = [];
    const releaser = new ServerReleaser(db, async (_s, _t, opts) => { seen.push(opts.teardown); });
    reapNoShowMatches(db, releaser);
    return new Promise<void>((r) => setImmediate(() => {
      expect(getServer(db, serverId)!.status).toBe('idle');
      expect(seen).toEqual([true]);
      r();
    }));
  });
});
```

Append to `tests/adminMatches.test.ts`. The file already imports `openDb` and `addServer`; add these three imports at the top:

```ts
import { abortMatch } from '../src/admin/matches.js';
import { markLive } from '../src/serverPool.js';
import { ServerReleaser } from '../src/serverRelease.js';
```

(`addServer` is already imported from `../src/serverPool.js`; merge `markLive` into that line rather than importing the module twice.) Then append:

```ts
describe('admin abort teardown', () => {
  it('releases the box with a teardown', async () => {
    const db = openDb(':memory:');
    const serverId = addServer(db, { name: 's', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    markLive(db, serverId);
    const mid = Number(db.prepare(
      "INSERT INTO matches (season_id, state, campaign, server_id, token) VALUES (1, 'live', 'no_mercy', ?, ?)",
    ).run(serverId, 'b'.repeat(32)).lastInsertRowid);
    const seen: boolean[] = [];
    const releaser = new ServerReleaser(db, async (_s, _t, opts) => { seen.push(opts.teardown); });
    expect(abortMatch(db, releaser, mid)).toEqual({ ok: true });
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual([true]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/serverRelease.test.ts tests/abandon.test.ts tests/noShow.test.ts tests/adminMatches.test.ts`
Expected: the four new tests FAIL (the cleaner receives no third argument; the stubs see `opts` undefined). Typecheck also fails on `opts.teardown` until Step 3.

- [ ] **Step 3: Change the releaser**

In `src/serverRelease.ts`, replace the `ServerCleaner` block at the top:

```ts
/** How a server is being freed. `teardown` is the ending that went wrong:
 *  abandon, no-show, admin abort. The roster is still on the box, possibly
 *  paused, on the match map, and the plugin is asked to empty it and change
 *  to the reset map. A clean finish, a boot-time reconcile and a failed setup
 *  all pass false: the first is already empty (the plugin kicks at the end of
 *  a backend match), and the other two may have casual players on the box
 *  who have nothing to do with any match. */
export interface ReleaseOpts {
  teardown: boolean;
}

/** Hands a server back: restore sv_password, and tell the plugin the match whose
 *  token this is (if any) is over, with a teardown when asked. Injected so tests
 *  never dial rcon and so the reapers, which have no rcon of their own, can
 *  still do both.
 *
 *  `token` is null when no match on that box ever got one, in which case there
 *  is nothing to abort. */
export type ServerCleaner = (server: ServerRow, token: string | null, opts: ReleaseOpts) => Promise<void>;
```

Change the `release` signature and the one call into the cleaner:

```ts
  release(serverId: number, opts: Partial<ReleaseOpts> = {}): void {
    const server = getServer(this.db, serverId);
    if (!server) return;
    const full: ReleaseOpts = { teardown: opts.teardown ?? false };
```

and, a few lines down, `this.cleanServer(server, token)` becomes `this.cleanServer(server, token, full)`.

- [ ] **Step 4: Send the teardown form from cleanServer**

In `src/server.ts`, add the import:

```ts
import { abortCommand, resetMap } from './matchTeardown.js';
```

Change the cleaner's parameter list on line 275 from `(async (server, token) => {` to `(async (server, token, opts) => {`, and replace the abort block:

```ts
      if (token) {
        try {
          // With teardown the plugin announces, waits for an unpause, kicks
          // everyone and changes to the reset map itself. One command rather
          // than five because exec secrets.cfg below drops the session and
          // each extra command is another thing that can time out first.
          await rcon.exec(abortCommand(token, opts.teardown, resetMap(deps.db)));
        } catch (err) {
          console.error(`[serverRelease] sm_pug_abort failed on ${server.name} (non-fatal):`, err);
        }
      }
```

- [ ] **Step 5: Ask for the teardown at the three cancel sites**

`src/abandon.ts:72`: `deps.releaser.release(match.server_id);` becomes

```ts
    deps.releaser.release(match.server_id, { teardown: true });
```

`src/noShow.ts:85`: `if (r.server_id !== null) releaser.release(r.server_id);` becomes

```ts
    if (r.server_id !== null) releaser.release(r.server_id, { teardown: true });
```

`src/admin/matches.ts:64`: `if (m.server_id !== null) releaser.release(m.server_id);` becomes

```ts
  if (m.server_id !== null) releaser.release(m.server_id, { teardown: true });
```

Leave `src/orchestrator.ts` (the completed-match release and the setup-failure release) and `reconcileServers` exactly as they are.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/serverRelease.test.ts tests/abandon.test.ts tests/noShow.test.ts tests/adminMatches.test.ts tests/orchestrator.test.ts`
Expected: PASS

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/serverRelease.ts src/server.ts src/abandon.ts src/noShow.ts src/admin/matches.ts tests/serverRelease.test.ts tests/abandon.test.ts tests/noShow.test.ts tests/adminMatches.test.ts
git commit -m "Tear the box down when a match is cancelled"
```

---

### Task 6: The plugin's PROBLEM line reaches the admin feed

**Files:**
- Modify: `src/logParse.ts:3-11` (union), `:135-137` (parser, after `ABANDON`)
- Modify: `src/server.ts:340-350` (the `LogListener` callback, before the `match_create` branch)
- Test: `tests/logParse.test.ts`

**Interfaces:**
- Consumes: `problemText` (Task 4).
- Produces: `LogEvent` gains `{ kind: 'problem'; token: string; code: string }`. `code` is `[a-z_]{1,40}`; the plugin sends `unpause_timeout`.
- Note: the listener only forwards registered tokens (`src/logListener.ts:35`). A cancelled match's token stays registered, because only the completion path unregisters, so a late PROBLEM line is delivered.

- [ ] **Step 1: Write the failing test**

Append inside `describe('parseLogDatagram', ...)` in `tests/logParse.test.ts`:

```ts
  it('parses PROBLEM with a code', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} PROBLEM code=unpause_timeout`));
    expect(ev).toEqual({ kind: 'problem', token: TOKEN, code: 'unpause_timeout' });
  });

  it('rejects PROBLEM without a well-formed code', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} PROBLEM`))).toBeNull();
    expect(parseLogDatagram(framed(`PUG ${TOKEN} PROBLEM code=Bad Code`))).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/logParse.test.ts`
Expected: FAIL, `null` where an event was expected

- [ ] **Step 3: Parse it**

In `src/logParse.ts`, add to the `LogEvent` union after the `abandon` member:

```ts
  | { kind: 'problem'; token: string; code: string }
```

and in `parseLogDatagram`, after the `ABANDON` case:

```ts
    case 'PROBLEM':
      // A short machine code, never free text: kv() splits on whitespace and
      // the backend owns the wording (matchTeardown.ts problemText).
      if (!/^[a-z_]{1,40}$/.test(rest.code ?? '')) return null;
      return { kind: 'problem', token, code: rest.code };
```

- [ ] **Step 4: Forward it**

In `src/server.ts`, add `problemText` to the import from `./matchTeardown.js`, and inside the `LogListener` callback, directly before the `if (ev.kind === 'match_create' || ...)` branch:

```ts
        if (ev.kind === 'problem') {
          // The plugin could not do part of a teardown (today: the game never
          // unpaused). The match is already aborted; this is for the admin
          // channel, so someone knows the box may need a hand.
          const row = deps.db.prepare('SELECT id FROM matches WHERE token = ?').get(ev.token) as { id: number } | undefined;
          publishAdminEvent({ kind: 'problem', matchId: row?.id, text: problemText(ev.code, row?.id ?? null) });
          return;
        }
```

`publishAdminEvent` is already imported in `src/server.ts` (line 13); nothing to add for it.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/logParse.test.ts tests/logListener.test.ts tests/server.test.ts`
Expected: PASS

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/logParse.ts src/server.ts tests/logParse.test.ts
git commit -m "Surface a teardown the plugin could not finish in the admin feed"
```

---

### Task 7: Wire the ban sync in, and push on the setup connection

**Files:**
- Modify: `src/orchestrator.ts:8-27` (`RealOrchestratorDeps`), `:37-58` (fields, constructor), `:160-162` (before the changelevel)
- Modify: `src/server.ts:62-80` (`ServerDeps`), after the releaser is built (`:275-323`), the orchestrator construction (`:443-452`), the `onClose` hook (`:685-690`), and the boot drain
- Test: `tests/orchestrator.test.ts`, `tests/serverBans.test.ts` (already covers `pushAll`)

**Interfaces:**
- Consumes: `ServerBanSync`, `ServerExec` (Task 3).
- Produces: `RealOrchestratorDeps.beforeLive?: (rcon: RconClient) => Promise<void>`, called after the roster is sent and the campaign checks pass, before `changelevel`; a failure is logged and does not cost the match its server. `ServerDeps.serverExec?: ServerExec`, injected by tests so `buildServer` never dials RCON for bans.

- [ ] **Step 1: Write the failing test**

Append inside `describe('RealOrchestrator', ...)` in `tests/orchestrator.test.ts`:

```ts
  it('runs beforeLive on the setup connection after the roster and before the changelevel', async () => {
    const srv = await fakeServer('');
    cleanup.push(srv.close);
    addServer(db, { name: 's', host: '127.0.0.1', port: 27015, rconPort: srv.port, rconPassword: 'secret' });
    const listener = new LogListener(() => {});
    await listener.listen(0);
    cleanup.push(() => listener.close());
    const orch = new RealOrchestrator({
      db, listener, logPublicAddress: '127.0.0.1:27500',
      releaser: new ServerReleaser(db, async () => {}), makeRcon: (o) => o,
      beforeLive: async (rcon) => { await rcon.exec('sm_addban 0 "STEAM_1:1:35074132" "probe"'); },
    });
    const mid = seedMatch(db);
    await orch.setupMatch(mid);
    const ban = srv.cmds.indexOf('sm_addban 0 "STEAM_1:1:35074132" "probe"');
    const lastRoster = srv.cmds.map((c) => c.startsWith('sm_pug_roster')).lastIndexOf(true);
    const change = srv.cmds.findIndex((c) => c.startsWith('changelevel'));
    expect(ban).toBeGreaterThan(lastRoster);
    expect(ban).toBeLessThan(change);
  });

  it('a failing beforeLive does not cost the match its server', async () => {
    const srv = await fakeServer('');
    cleanup.push(srv.close);
    const serverId = addServer(db, { name: 's', host: '127.0.0.1', port: 27015, rconPort: srv.port, rconPassword: 'secret' });
    const listener = new LogListener(() => {});
    await listener.listen(0);
    cleanup.push(() => listener.close());
    const orch = new RealOrchestrator({
      db, listener, logPublicAddress: '127.0.0.1:27500',
      releaser: new ServerReleaser(db, async () => {}), makeRcon: (o) => o,
      beforeLive: async () => { throw new Error('ban push exploded'); },
    });
    const mid = seedMatch(db);
    await orch.setupMatch(mid);
    expect(getServer(db, serverId)!.status).toBe('live');
    expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(mid) as { state: string }).state).toBe('live');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/orchestrator.test.ts`
Expected: the two new tests FAIL (typecheck: `beforeLive` is not a known property; at runtime the probe command is never sent)

- [ ] **Step 3: Add the hook to the orchestrator**

In `src/orchestrator.ts`, add to `RealOrchestratorDeps` after `onNoServer`:

```ts
  /** Run on the setup connection once the match is configured and before the
   *  changelevel: anything the box must have before players can join. Today
   *  that is the ban list (ServerBanSync.pushAll). Wrapped by the caller; a
   *  failure here is logged and never costs the match its server. */
  beforeLive?: (rcon: RconClient) => Promise<void>;
```

Add the field after `onNoServer?: (matchId: number) => void;` in the class:

```ts
  private beforeLive?: (rcon: RconClient) => Promise<void>;
```

and in the constructor, after `this.onNoServer = deps.onNoServer;`:

```ts
    this.beforeLive = deps.beforeLive;
```

In `setupMatch`, directly before `await rcon.exec(\`changelevel ${firstMapOf(this.db, match.campaign)}\`);`:

```ts
      if (this.beforeLive) {
        try {
          await this.beforeLive(rcon);
        } catch (err) {
          console.error(`[orchestrator] beforeLive hook failed for match ${matchId} (non-fatal):`, err);
        }
      }
```

- [ ] **Step 4: Build and start the sync in server.ts**

Add the imports:

```ts
import { ServerBanSync, type ServerExec } from './serverBans.js';
```

Add to `ServerDeps` after `serverCleaner`:

```ts
  /** Runs a batch of console commands on one server, for the ban sync.
   *  Injected in tests so a ban never dials rcon. */
  serverExec?: ServerExec;
```

Directly after the `releaser` is constructed (after the closing `}));` of `new ServerReleaser(...)`), add:

```ts
  // Every enabled box mirrors the website's bans. Built here, next to the
  // releaser, because both are the backend reaching into a game server
  // outside a match; started below once the server list has been reconciled.
  const banSync = new ServerBanSync({
    db: deps.db,
    exec: deps.serverExec ?? (async (server, commands) => {
      const rcon = new RealRcon({ host: server.host, port: server.rcon_port, password: server.rcon_password });
      try {
        await rcon.connect();
        for (const c of commands) await rcon.exec(c);
      } finally {
        rcon.close();
      }
    }),
  });
```

In the `new RealOrchestrator({ ... })` construction, add:

```ts
        beforeLive: (rcon) => banSync.pushAll((c) => rcon.exec(c)),
```

Where the reaper is started (`const reaper = setInterval(...)`), start the sync just before it, and run one sweep at boot so a restart heals every box without waiting five minutes. In dev mode there is no game server; skip both there:

```ts
  if (!deps.config.devMode) {
    banSync.start();
    banSync.sweep().catch((err) => console.error('[serverBans] boot sweep failed:', err));
  }
```

In the `onClose` hook that clears `reaper` and `pruneTimer`, add:

```ts
    banSync.stop();
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/orchestrator.test.ts tests/server.test.ts tests/adminPlayers.test.ts tests/smoke.test.ts`
Expected: PASS. If any `buildServer` based suite now tries to open RCON for a ban (it would hang or log ECONNREFUSED), pass `serverExec: async () => {}` in that suite's `buildServer` call, the same way they already pass `serverCleaner`.

- [ ] **Step 6: Typecheck, full suite, commit**

```bash
npm run typecheck
npx vitest run
git add src/orchestrator.ts src/server.ts tests/orchestrator.test.ts
git commit -m "Push bans at boot, every five minutes, on change, and before a match goes live"
```

---

### Task 8: The plugin empties the box

**Files:**
- Modify: `plugin/pug-match.sp:28-34` (defines), `:106-108` (globals), `:1493` and `:1687` (the two match-start sites), `:2029-2036` (`Cmd_Abort`), plus new functions next to `CancelEndKick` (`:1823`)
- Modify: `plugin/pug-leave.inc` (one accessor, next to `LeaveHeartbeat`)
- Modify: `plugin/TESTING.md` (manual test)
- Build: `plugin/build.sh`

**Interfaces:**
- Consumes: `LeaveUnpauseNow()`, `LeaveRotoblinPaused()` from `plugin/pug-leave.inc`; `IsEndKickTarget(int)`, `CancelEndKick()`, `TokenArgOk(int)`, `ResetMatchState()`, `StopMatchDemo()` already in `pug-match.sp`; `g_iMatchId`, `g_sToken`.
- The `.inc` files are included at the END of `pug-match.sp` (lines 3741 and 3743). SourcePawn forward-references functions but not variables, and the `.sp` never touches an inc-file global directly; keep that convention. `g_sAbandoner` is therefore read through a new `LeaveHasAbandoner()` accessor, defined in this task. `ForceChangeLevel` needs no extra include: `sourcemod.inc` pulls in `nextmap.inc`.
- Produces: `sm_pug_abort <token> [teardown [<map>]]`. With `teardown`: chat announcement, cooperative unpause with a 10 second bound, kick of every human (not bots, not SourceTV), then `ForceChangeLevel(<map>)` once the kicks have landed (at most 5 seconds later). Without a valid map the kick still happens and the map is left alone. Logs `PUG <token> PROBLEM code=unpause_timeout` if the wait ran out. Replies `PUGOK aborted teardown`.

- [ ] **Step 1: Add the defines and globals**

After `#define END_KICK_TRIES 5` (line 34):

```sourcepawn
// ---------- teardown: a cancelled backend match empties the box ----------
// sm_pug_abort <token> teardown <map>. The backend sends it from the release
// path when a match ends badly (abandon, no-show, admin abort). Everything
// runs on engine time, which keeps moving while the game is paused; the
// spike on 2026-09-19 proved SourceMod timers fire during a pause.
#define TEARDOWN_TICK 0.5
#define TEARDOWN_UNPAUSE_TICKS 20   // 10 s for Rotoblin's cooperative unpause to land
#define TEARDOWN_KICK_TICKS 10      // then up to 5 s for the kicks to land before the map changes
```

After `int g_iEndKickTries;` (line 108):

```sourcepawn
Handle g_hTeardown = null;
int g_iTeardownTicks;
bool g_bTeardownKicked;
char g_sTeardownMap[64];
char g_sTeardownReason[128];
char g_sTeardownToken[65];
```

- [ ] **Step 2: Add the accessor to pug-leave.inc**

Directly after `LeaveHeartbeat()` in `plugin/pug-leave.inc`:

```sourcepawn
/** Whether this match ended because someone ran out of reconnect time. Read by
 *  the teardown to word its announcement; a function because the .sp includes
 *  this file last and never reads its globals directly. */
bool LeaveHasAbandoner()
{
	return g_sAbandoner[0] != '\0';
}
```

- [ ] **Step 3: Replace Cmd_Abort**

```sourcepawn
public Action Cmd_Abort(int args)
{
	if (!TokenArgOk(args)) return Plugin_Handled;
	bool teardown = false;
	char map[64];
	if (args >= 2)
	{
		char mode[16];
		GetCmdArg(2, mode, sizeof(mode));
		teardown = StrEqual(mode, "teardown");
		if (teardown && args >= 3)
		{
			GetCmdArg(3, map, sizeof(map));
			// Refused rather than trusted: this ends up in ForceChangeLevel.
			if (!MapNameOk(map)) map[0] = '\0';
		}
	}
	StopMatchDemo();
	// Before ResetMatchState, which blanks the match id, the token and the
	// abandoner the announcement and the PROBLEM line need.
	if (teardown) BeginTeardown(map);
	ResetMatchState();
	PrintToServer(teardown ? "PUGOK aborted teardown" : "PUGOK aborted");
	return Plugin_Handled;
}
```

- [ ] **Step 4: Add the teardown functions**

Directly after `CancelEndKick()` (after line 1831):

```sourcepawn
/** A bare map name: letters, digits, underscore. Anything else is refused. */
bool MapNameOk(const char[] map)
{
	if (map[0] == '\0') return false;
	for (int i = 0; map[i] != '\0'; i++)
	{
		if (!IsCharAlpha(map[i]) && !IsCharNumeric(map[i]) && map[i] != '_') return false;
	}
	return true;
}

/** Start emptying the box. Runs BEFORE ResetMatchState.
 *
 *  Why not just unpause and kick right here: Rotoblin's unpause is a 3 second
 *  countdown after both teams ready, and its Unpause() needs an in-game client
 *  to issue the engine command. Kick first and the countdown lands on an empty
 *  server, Rotoblin clears its own flags, and the engine stays paused with no
 *  command left that can fix it. So: ask for the unpause, wait for it, then
 *  kick, then change the map from a later tick once the kicks have landed. */
void BeginTeardown(const char[] map)
{
	CancelEndKick();
	CancelTeardown();
	strcopy(g_sTeardownMap, sizeof(g_sTeardownMap), map);
	strcopy(g_sTeardownToken, sizeof(g_sTeardownToken), g_sToken);
	if (LeaveHasAbandoner())
	{
		Format(g_sTeardownReason, sizeof(g_sTeardownReason),
			"Match #%d cancelled: a player did not reconnect in time.", g_iMatchId);
	}
	else
	{
		Format(g_sTeardownReason, sizeof(g_sTeardownReason), "Match #%d cancelled.", g_iMatchId);
	}
	PrintToChatAll("\x04[PUG]\x01 %s Everyone will be removed from the server shortly.", g_sTeardownReason);
	// Unconditionally, not behind g_bLeavePaused: the leave module's idea of
	// whether it paused can be wrong, and LeaveUnpauseNow checks the real
	// state itself. Through Rotoblin, never a raw setpause: Rotoblin's command
	// listener blocks that, and a fake client issuing pause crashes srcds.
	LeaveUnpauseNow();
	g_iTeardownTicks = 0;
	g_bTeardownKicked = false;
	g_hTeardown = CreateTimer(TEARDOWN_TICK, Timer_Teardown, _, TIMER_REPEAT | TIMER_FLAG_NO_MAPCHANGE);
}

void CancelTeardown()
{
	if (g_hTeardown != null)
	{
		KillTimer(g_hTeardown);
		g_hTeardown = null;
	}
	ClearTeardownState();
}

/** The strings only. Called from inside the timer, which must not KillTimer itself. */
void ClearTeardownState()
{
	g_sTeardownMap[0] = '\0';
	g_sTeardownReason[0] = '\0';
	g_sTeardownToken[0] = '\0';
	g_iTeardownTicks = 0;
	g_bTeardownKicked = false;
}

void TeardownKickAll()
{
	for (int c = 1; c <= MaxClients; c++)
	{
		// IsClientInGame, not merely connected: a client mid-load is not safe
		// to kick, as Timer_EndKick documents. A later tick catches them.
		if (IsClientInGame(c) && IsEndKickTarget(c)) KickClient(c, "%s", g_sTeardownReason);
	}
}

public Action Timer_Teardown(Handle timer)
{
	g_iTeardownTicks++;

	if (!g_bTeardownKicked)
	{
		bool paused = LeaveRotoblinPaused();
		if (paused && g_iTeardownTicks < TEARDOWN_UNPAUSE_TICKS) return Plugin_Continue;
		if (paused)
		{
			// Not EmitPug: the match state is already reset, so it would be
			// dropped. The token was saved for exactly this line.
			LogToGame("PUG %s PROBLEM code=unpause_timeout", g_sTeardownToken);
			LogMessage("pug-match: teardown gave up waiting for an unpause after %d ticks", g_iTeardownTicks);
		}
		TeardownKickAll();
		g_bTeardownKicked = true;
		g_iTeardownTicks = 0;
		return Plugin_Continue;
	}

	int present = 0;
	for (int c = 1; c <= MaxClients; c++)
	{
		if (IsClientConnected(c) && IsEndKickTarget(c)) present++;
	}
	if (present > 0 && g_iTeardownTicks < TEARDOWN_KICK_TICKS)
	{
		TeardownKickAll();
		return Plugin_Continue;
	}

	if (g_sTeardownMap[0] != '\0')
	{
		LogMessage("pug-match: teardown complete (%d still connected), changing to %s", present, g_sTeardownMap);
		ForceChangeLevel(g_sTeardownMap, "PUG match cancelled");
	}
	else
	{
		LogMessage("pug-match: teardown complete (%d still connected), no reset map given", present);
	}
	g_hTeardown = null;
	ClearTeardownState();
	return Plugin_Stop;
}
```

- [ ] **Step 5: Void a pending teardown when a new match begins**

In `Cmd_Match` (line 1687), change

```sourcepawn
	CancelEndKick();                 // new match: a kick left over from the last one is void
```

to

```sourcepawn
	CancelEndKick();                 // new match: a kick left over from the last one is void
	CancelTeardown();                // likewise a teardown still counting down
```

Do the same at the backend match setup site, line 1493 (`CancelEndKick();` followed by `ResetMatchState();` and `g_iMatchId = matchId;`): add `CancelTeardown();` directly after that `CancelEndKick();`. Its comment says these are the only places the kick is cancelled; that remains true for the teardown too.

- [ ] **Step 6: Build**

Run: `cd plugin && ./build.sh`
Expected: `built: /home/volence/l4d/pug/plugin/pug-match.smx` with no errors. Warnings about unused symbols are acceptable only if they predate this change (compare with a build of the previous commit if in doubt).

- [ ] **Step 7: Document the manual test**

Append to `plugin/TESTING.md`:

```markdown
## Teardown (`sm_pug_abort <token> teardown <map>`)

Needs a REAL client connected to the local test server (`/home/volence/l4d1-ds`,
LAN address 192.168.4.85, `sv_allow_lobby_connect_only 0` after each map load).
Rotoblin must be loaded. Over RCON:

1. `sm_pug_match 999 <32 hex chars> no_mercy`, then `sm_pug_roster "<your steamid64>:a"`.
2. Join the server. Confirm `sm_pug_status` shows you rostered.
3. Unpaused case: `sm_pug_abort <token> teardown l4d_hospital01_apartment`.
   Expect within ~6 s: the "[PUG] Match #999 cancelled." chat line, a kick whose
   dialog reads "Match #999 cancelled.", then `status` over RCON shows
   `map : l4d_hospital01_apartment` and 0 humans.
4. Paused case: repeat 1 and 2, then type `!pause` in game. Run the same abort.
   Expect the same outcome. In the srcds console, no `PROBLEM` line. If the
   game does not unpause, the kick still happens after 10 s and the console
   shows `PUG <token> PROBLEM code=unpause_timeout`; the map change after that
   is the open question from the spec (does changelevel run while paused).
   Record the answer in the spec's spike table.
5. Bad map: `sm_pug_abort <token> teardown "l4d_hospital01_apartment; sv_cheats 1"`.
   Expect the kick, no map change, and no cvar change.
6. Plain abort still plain: configure again, `sm_pug_abort <token>`. Expect no
   kick and no map change (the routine post-report path is unchanged).

`sm_addban` cannot be tested here: on a LAN server it is a silent no-op.
```

- [ ] **Step 8: Commit**

```bash
git add plugin/pug-match.sp plugin/pug-leave.inc plugin/TESTING.md
git commit -m "Let sm_pug_abort tear the box down: unpause, kick everyone, reset the map"
```

The built `.smx` stays uncommitted, per the repo's existing practice.

---

### Task 9: Documentation and the ship checklist

**Files:**
- Modify: `plugin/README.md` (the command table)
- Modify: `docs/superpowers/specs/2026-09-19-cancel-teardown-and-server-bans-design.md` (status line)
- Create: `docs/superpowers/notes/2026-09-19-teardown-and-bans-ship-checklist.md`

- [ ] **Step 1: Document the command**

In `plugin/README.md`, find the row or paragraph describing `sm_pug_abort` and replace it with:

```markdown
- `sm_pug_abort <token> [teardown [<map>]]`: end the match. Plain form: reset
  plugin state, nothing else (the routine post-report call). With `teardown`:
  announce in chat, ask Rotoblin for an unpause and wait up to 10 s for it,
  kick every human (bots and SourceTV stay), then `ForceChangeLevel(<map>)`
  once the kicks have landed. Logs `PUG <token> PROBLEM code=unpause_timeout`
  if the game never unpaused. The backend sends the teardown form from the
  release path for abandon, no-show and admin abort; never for a clean finish.
```

- [ ] **Step 2: Write the ship checklist**

```markdown
# Teardown and server bans: what to check before it goes live

Spec: `docs/superpowers/specs/2026-09-19-cancel-teardown-and-server-bans-design.md`.
Plan: `docs/superpowers/plans/2026-09-19-cancel-teardown-and-server-bans.md`.

Nothing below touches Dallas without the owner's explicit go-ahead and an empty server.

## Read-only checks on Dallas (ask first, then one RCON session)

1. `sm plugins list` must show `Base Bans`. If it does not, half 2 does not work
   and has to move into the pug plugin; stop and re-plan.
2. `sv_banid_enabled` must be 1.
3. `sm_cvar sv_pausable` for the record.

## Local, with a real client

4. `plugin/TESTING.md`, section "Teardown", steps 3 to 6. Record whether
   changelevel ran while paused in the spec's spike table.

## Deploy order (audit-hardening precedent)

5. Web first: `deploy-web.sh`. The sweep starts pushing bans on boot. Watch the
   log for `[serverBans]` errors; expect none if basebans is loaded.
6. Then the plugin, on an EMPTY server: `plugin/stage.sh`.
7. Re-assert `sm_pug_auto_track` and `sm_pug_roster_at_live` afterwards, as the
   hardening notes require after any plugin stage.

## First real cancel afterwards

8. Check the admin feed: an abandon should show the ban, and no PROBLEM line.
9. `status` on the box within a minute: 0 humans, `map : <reset_map>`.
10. Check `banned_user.cfg` on the box contains the STEAM_1 id of the leaver.
```

- [ ] **Step 3: Update the spec status**

Change the spec's status line to:

```markdown
Status: **implemented on master (unreleased); see the ship checklist in
`docs/superpowers/notes/2026-09-19-teardown-and-bans-ship-checklist.md`.** Written after the
first real PUG night (2026-09-18/19) surfaced both problems in one incident. Revised the
same day after a local spike; see "What the spike established".
```

- [ ] **Step 4: Full suite, typecheck, commit**

```bash
npm run typecheck
npx vitest run
git add plugin/README.md docs/superpowers/specs/2026-09-19-cancel-teardown-and-server-bans-design.md docs/superpowers/notes/2026-09-19-teardown-and-bans-ship-checklist.md
git commit -m "Document the teardown command and what to check before shipping"
```
