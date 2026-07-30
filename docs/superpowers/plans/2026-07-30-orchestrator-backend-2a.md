# Backend Orchestrator (Sub-project 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `DevOrchestrator` stub with a real backend orchestrator that configures a match on a game server over RCON, receives a lossy live-view feed over a UDP `logaddress` listener, and pulls the authoritative final scores/stats over RCON to drive a match from `configuring` → `live` → `completed`.

**Architecture:** Small, single-purpose TypeScript modules — a Source RCON TCP client, a DB-backed server pool, a pure log-line parser wrapped in a UDP listener, a match-token helper, and a real `Orchestrator` that composes them. Everything is tested in isolation against a fake RCON TCP server and synthetic log datagrams; **no live game server is contacted anywhere in this plan.**

**Tech Stack:** Node 22 built-ins only (`node:net`, `node:dgram`, `node:crypto`), TypeScript strict ESM, vitest, better-sqlite3 (already present).

**Context:** Builds on the completed sub-project 1 in `/home/volence/l4d/pug`. Read the spec first: `docs/superpowers/specs/2026-07-30-sub-project-2-orchestrator-plugin-design.md`. Key existing pieces you will consume or modify: `src/orchestrator.ts` (currently `Orchestrator` interface + `DevOrchestrator` stub), `src/db.ts` (`openDb`, `type DB`; the `servers` and `matches`/`match_players` tables already exist), `src/matchmaker.ts` (calls `orchestrator.setupMatch(matchId)`), `src/server.ts` (`buildServer`, constructs the orchestrator), `src/config.ts` (`loadConfig`, `Config`).

**Scope boundary:** This plan is 2a only. The `pug-match` SourcePawn plugin (2b) and the second-srcds-instance infrastructure (2c) are deliberately out of scope — they require the live box and are designed but not built here. This plan's `Orchestrator` is fully exercised against fakes; pinning the log parser against *real* captured srcds samples happens during the 2b/2c dry-run.

**Contract shared with the (future) plugin — do not drift from this:**

Live-view UDP lines (lossy, cosmetic), one datagram each, engine-wrapped as
`\xFF\xFF\xFF\xFFR` + `L MM/DD/YYYY - HH:MM:SS: ` + body + `\n`:
```
PUG <token> MATCH_START map=<map1>
PUG <token> MAP_RESULT map=<map> a=<n> b=<n>
PUG <token> HEARTBEAT
PUG <token> PLAYER steamid=<id64> event=connect|disconnect
PUG <token> MATCH_END a=<n> b=<n> winner=a|b|draw
```
Authoritative `sm_pug_dump <token>` RCON response body (reliable):
```
DUMP match=<id>
MAP map=<map> a=<n> b=<n>
STAT steamid=<id64> team=a|b sidmg=<n> sikill=<n> ck=<n> ff=<n> rev=<n>
END winner=a|b|draw a=<n> b=<n>
```

---

### Task 1: Match token helper

**Files:**
- Create: `src/matchToken.ts`
- Test: `tests/matchToken.test.ts`

- [ ] **Step 1: Write failing test `tests/matchToken.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { newToken, isValidTokenFormat } from '../src/matchToken.js';

describe('matchToken', () => {
  it('generates a 32-char lowercase hex token', () => {
    const t = newToken();
    expect(t).toMatch(/^[0-9a-f]{32}$/);
  });

  it('generates distinct tokens', () => {
    const set = new Set(Array.from({ length: 100 }, () => newToken()));
    expect(set.size).toBe(100);
  });

  it('validates token format', () => {
    expect(isValidTokenFormat(newToken())).toBe(true);
    expect(isValidTokenFormat('nope')).toBe(false);
    expect(isValidTokenFormat('ABCDEF0123456789abcdef0123456789')).toBe(false); // uppercase
    expect(isValidTokenFormat('')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/matchToken.test.ts`
Expected: FAIL — cannot find module `../src/matchToken.js`.

- [ ] **Step 3: Write `src/matchToken.ts`**

```ts
import { randomBytes } from 'node:crypto';

const TOKEN_RE = /^[0-9a-f]{32}$/;

/** A per-match secret: 16 random bytes as lowercase hex. */
export function newToken(): string {
  return randomBytes(16).toString('hex');
}

export function isValidTokenFormat(token: string): boolean {
  return TOKEN_RE.test(token);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/matchToken.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/matchToken.ts tests/matchToken.test.ts && git commit -m "feat: per-match token helper"
```

---

### Task 2: Log line parser

**Files:**
- Create: `src/logParse.ts`
- Test: `tests/logParse.test.ts`

Design: `parseLogDatagram(buf)` takes a raw UDP datagram `Buffer` and returns a typed `LogEvent | null` (null = not one of our lines, or malformed — never throw). It strips the engine framing (`0xFF 0xFF 0xFF 0xFF 0x52 'R'`-style prefix is `FF FF FF FF` then a single `R` byte, then the ASCII text; the text begins with the `L MM/DD/YYYY - HH:MM:SS: ` stamp) and then matches the `PUG <token> <VERB> ...` body. Tolerant of the framing being absent (some capture paths hand us just the text), so it searches for `PUG ` rather than assuming a fixed offset.

- [ ] **Step 1: Write failing test `tests/logParse.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { parseLogDatagram } from '../src/logParse.js';

const TOKEN = '0123456789abcdef0123456789abcdef';

function framed(body: string): Buffer {
  // engine framing: FF FF FF FF 52 then 'L <date> - <time>: ' then body then \n
  const head = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]);
  const text = Buffer.from(`L 07/30/2026 - 14:23:01: ${body}\n`, 'utf8');
  return Buffer.concat([head, text]);
}

describe('parseLogDatagram', () => {
  it('parses MATCH_START', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} MATCH_START map=l4d_hospital01_apartment`));
    expect(ev).toEqual({ kind: 'match_start', token: TOKEN, map: 'l4d_hospital01_apartment' });
  });

  it('parses MAP_RESULT with numeric scores', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} MAP_RESULT map=l4d_garage b=310 a=245`));
    expect(ev).toEqual({ kind: 'map_result', token: TOKEN, map: 'l4d_garage', a: 245, b: 310 });
  });

  it('parses HEARTBEAT', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} HEARTBEAT`));
    expect(ev).toEqual({ kind: 'heartbeat', token: TOKEN });
  });

  it('parses PLAYER connect/disconnect', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} PLAYER steamid=76561198000000001 event=disconnect`));
    expect(ev).toEqual({ kind: 'player', token: TOKEN, steamid: '76561198000000001', event: 'disconnect' });
  });

  it('parses MATCH_END', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} MATCH_END a=812 b=1044 winner=b`));
    expect(ev).toEqual({ kind: 'match_end', token: TOKEN, a: 812, b: 1044, winner: 'b' });
  });

  it('parses an unframed body (raw text without engine header)', () => {
    const ev = parseLogDatagram(Buffer.from(`PUG ${TOKEN} HEARTBEAT`, 'utf8'));
    expect(ev).toEqual({ kind: 'heartbeat', token: TOKEN });
  });

  it('returns null for a non-PUG log line', () => {
    expect(parseLogDatagram(framed('"Alice<2><STEAM_1:0:1><Survivor>" say "hi"'))).toBeNull();
  });

  it('returns null for a bad token', () => {
    expect(parseLogDatagram(framed('PUG not-a-token HEARTBEAT'))).toBeNull();
  });

  it('returns null for an unknown verb', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} FROBNICATE x=1`))).toBeNull();
  });

  it('returns null for a MATCH_END with a bad winner', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} MATCH_END a=1 b=2 winner=x`))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/logParse.test.ts`
Expected: FAIL — cannot find module `../src/logParse.js`.

- [ ] **Step 3: Write `src/logParse.ts`**

```ts
const TOKEN_RE = /^[0-9a-f]{32}$/;

export type LogEvent =
  | { kind: 'match_start'; token: string; map: string }
  | { kind: 'map_result'; token: string; map: string; a: number; b: number }
  | { kind: 'heartbeat'; token: string }
  | { kind: 'player'; token: string; steamid: string; event: 'connect' | 'disconnect' }
  | { kind: 'match_end'; token: string; a: number; b: number; winner: 'a' | 'b' | 'draw' };

/** Parse `key=val key=val` pairs from the remainder of a PUG line. */
function kv(parts: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq > 0) out[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return out;
}

function intOf(s: string | undefined): number | null {
  if (s === undefined || !/^-?\d+$/.test(s)) return null;
  return Number(s);
}

/**
 * Decode a raw srcds log UDP datagram into a typed PUG event, or null if it is
 * not one of ours or is malformed. Never throws. Tolerant of the engine framing
 * being present or absent — it locates the `PUG ` marker rather than assuming an
 * offset.
 */
export function parseLogDatagram(buf: Buffer): LogEvent | null {
  const text = buf.toString('utf8');
  const idx = text.indexOf('PUG ');
  if (idx < 0) return null;
  // take up to end-of-line
  const line = text.slice(idx).split('\n', 1)[0].trim();
  const parts = line.split(/\s+/);
  // parts[0] === 'PUG', parts[1] === token, parts[2] === VERB, rest = kv
  if (parts.length < 3) return null;
  const token = parts[1];
  if (!TOKEN_RE.test(token)) return null;
  const verb = parts[2];
  const rest = kv(parts.slice(3));

  switch (verb) {
    case 'MATCH_START': {
      if (!rest.map) return null;
      return { kind: 'match_start', token, map: rest.map };
    }
    case 'MAP_RESULT': {
      const a = intOf(rest.a), b = intOf(rest.b);
      if (!rest.map || a === null || b === null) return null;
      return { kind: 'map_result', token, map: rest.map, a, b };
    }
    case 'HEARTBEAT':
      return { kind: 'heartbeat', token };
    case 'PLAYER': {
      if (!/^\d{17}$/.test(rest.steamid ?? '')) return null;
      if (rest.event !== 'connect' && rest.event !== 'disconnect') return null;
      return { kind: 'player', token, steamid: rest.steamid, event: rest.event };
    }
    case 'MATCH_END': {
      const a = intOf(rest.a), b = intOf(rest.b);
      if (a === null || b === null) return null;
      if (rest.winner !== 'a' && rest.winner !== 'b' && rest.winner !== 'draw') return null;
      return { kind: 'match_end', token, a, b, winner: rest.winner };
    }
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/logParse.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/logParse.ts tests/logParse.test.ts && git commit -m "feat: srcds log-line parser for PUG live-view events"
```

---

### Task 3: Dump response parser

**Files:**
- Create: `src/dumpParse.ts`
- Test: `tests/dumpParse.test.ts`

Design: `parseDump(body)` takes the multi-line `sm_pug_dump` RCON response string and returns a structured `{ matchId, maps, players, winner, totalA, totalB } | null` (null if the required `DUMP`/`END` lines are missing or malformed). This is the authoritative result; it must be strict, not tolerant.

- [ ] **Step 1: Write failing test `tests/dumpParse.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { parseDump } from '../src/dumpParse.js';

const SAMPLE = [
  'DUMP match=42',
  'MAP map=l4d_hospital01_apartment a=245 b=310',
  'MAP map=l4d_hospital02_subway a=400 b=300',
  'STAT steamid=76561198000000001 team=a sidmg=1240 sikill=8 ck=312 ff=45 rev=3',
  'STAT steamid=76561198000000002 team=b sidmg=980 sikill=6 ck=280 ff=12 rev=1',
  'END winner=a a=645 b=610',
].join('\n');

describe('parseDump', () => {
  it('parses a full dump', () => {
    const d = parseDump(SAMPLE)!;
    expect(d.matchId).toBe(42);
    expect(d.maps).toEqual([
      { map: 'l4d_hospital01_apartment', a: 245, b: 310 },
      { map: 'l4d_hospital02_subway', a: 400, b: 300 },
    ]);
    expect(d.players).toEqual([
      { steamid: '76561198000000001', team: 'a', sidmg: 1240, sikill: 8, ck: 312, ff: 45, rev: 3 },
      { steamid: '76561198000000002', team: 'b', sidmg: 980, sikill: 6, ck: 280, ff: 12, rev: 1 },
    ]);
    expect(d.winner).toBe('a');
    expect(d.totalA).toBe(645);
    expect(d.totalB).toBe(610);
  });

  it('tolerates leading RCON noise/whitespace and CRLF', () => {
    const d = parseDump(`\r\nsome console echo\r\n${SAMPLE.replace(/\n/g, '\r\n')}\r\n`)!;
    expect(d.matchId).toBe(42);
    expect(d.players).toHaveLength(2);
  });

  it('returns null when DUMP header missing', () => {
    expect(parseDump('MAP map=x a=1 b=2\nEND winner=a a=1 b=2')).toBeNull();
  });

  it('returns null when END missing', () => {
    expect(parseDump('DUMP match=1\nMAP map=x a=1 b=2')).toBeNull();
  });

  it('returns null on a malformed STAT line', () => {
    const bad = SAMPLE.replace('sidmg=1240', 'sidmg=oops');
    expect(parseDump(bad)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dumpParse.test.ts`
Expected: FAIL — cannot find module `../src/dumpParse.js`.

- [ ] **Step 3: Write `src/dumpParse.ts`**

```ts
export interface DumpMap {
  map: string;
  a: number;
  b: number;
}

export interface DumpPlayer {
  steamid: string;
  team: 'a' | 'b';
  sidmg: number;
  sikill: number;
  ck: number;
  ff: number;
  rev: number;
}

export interface Dump {
  matchId: number;
  maps: DumpMap[];
  players: DumpPlayer[];
  winner: 'a' | 'b' | 'draw';
  totalA: number;
  totalB: number;
}

function kv(parts: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq > 0) out[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return out;
}

function intOf(s: string | undefined): number | null {
  if (s === undefined || !/^-?\d+$/.test(s)) return null;
  return Number(s);
}

/**
 * Parse the authoritative `sm_pug_dump` response. Strict: any malformed required
 * field yields null so the caller can retry the RCON pull rather than persist
 * garbage. Ignores unrelated console noise before the DUMP header.
 */
export function parseDump(body: string): Dump | null {
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const start = lines.findIndex((l) => l.startsWith('DUMP '));
  if (start < 0) return null;

  const header = kv(lines[start].split(/\s+/).slice(1));
  const matchId = intOf(header.match);
  if (matchId === null) return null;

  const maps: DumpMap[] = [];
  const players: DumpPlayer[] = [];
  let end: { winner: 'a' | 'b' | 'draw'; totalA: number; totalB: number } | null = null;

  for (const line of lines.slice(start + 1)) {
    const parts = line.split(/\s+/);
    const verb = parts[0];
    const rest = kv(parts.slice(1));
    if (verb === 'MAP') {
      const a = intOf(rest.a), b = intOf(rest.b);
      if (!rest.map || a === null || b === null) return null;
      maps.push({ map: rest.map, a, b });
    } else if (verb === 'STAT') {
      const nums = ['sidmg', 'sikill', 'ck', 'ff', 'rev'].map((k) => intOf(rest[k]));
      if (!/^\d{17}$/.test(rest.steamid ?? '')) return null;
      if (rest.team !== 'a' && rest.team !== 'b') return null;
      if (nums.some((n) => n === null)) return null;
      const [sidmg, sikill, ck, ff, rev] = nums as number[];
      players.push({ steamid: rest.steamid, team: rest.team, sidmg, sikill, ck, ff, rev });
    } else if (verb === 'END') {
      const a = intOf(rest.a), b = intOf(rest.b);
      if (a === null || b === null) return null;
      if (rest.winner !== 'a' && rest.winner !== 'b' && rest.winner !== 'draw') return null;
      end = { winner: rest.winner, totalA: a, totalB: b };
      break;
    }
  }

  if (!end) return null;
  return { matchId, maps, players, winner: end.winner, totalA: end.totalA, totalB: end.totalB };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dumpParse.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/dumpParse.ts tests/dumpParse.test.ts && git commit -m "feat: authoritative sm_pug_dump response parser"
```

---

### Task 4: Source RCON packet framing

**Files:**
- Create: `src/rconPacket.ts`
- Test: `tests/rconPacket.test.ts`

Design: pure encode/decode of Source RCON packets, no sockets. A packet is
`int32LE size | int32LE id | int32LE type | body bytes | 0x00 | 0x00`, where
`size = body.length + 10`. `decodePackets(buf)` pulls all complete packets from a
stream buffer and returns `{ packets, rest }` (leftover bytes for the next read).

- [ ] **Step 1: Write failing test `tests/rconPacket.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { encodePacket, decodePackets, SERVERDATA_AUTH, SERVERDATA_EXECCOMMAND } from '../src/rconPacket.js';

describe('rcon packet', () => {
  it('encodes with correct size and trailing nulls', () => {
    const p = encodePacket(7, SERVERDATA_EXECCOMMAND, 'status');
    // size field = body(6) + 10 = 16
    expect(p.readInt32LE(0)).toBe(16);
    expect(p.readInt32LE(4)).toBe(7);
    expect(p.readInt32LE(8)).toBe(SERVERDATA_EXECCOMMAND);
    expect(p.subarray(12, 18).toString()).toBe('status');
    expect(p[p.length - 2]).toBe(0);
    expect(p[p.length - 1]).toBe(0);
  });

  it('round-trips through decode', () => {
    const buf = Buffer.concat([
      encodePacket(1, SERVERDATA_AUTH, 'pw'),
      encodePacket(2, SERVERDATA_EXECCOMMAND, 'hi'),
    ]);
    const { packets, rest } = decodePackets(buf);
    expect(rest.length).toBe(0);
    expect(packets).toEqual([
      { id: 1, type: SERVERDATA_AUTH, body: 'pw' },
      { id: 2, type: SERVERDATA_EXECCOMMAND, body: 'hi' },
    ]);
  });

  it('leaves a partial trailing packet in rest', () => {
    const full = encodePacket(9, SERVERDATA_EXECCOMMAND, 'abc');
    const partial = full.subarray(0, full.length - 3);
    const { packets, rest } = decodePackets(Buffer.concat([full, partial]));
    expect(packets).toHaveLength(1);
    expect(rest.length).toBe(partial.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rconPacket.test.ts`
Expected: FAIL — cannot find module `../src/rconPacket.js`.

- [ ] **Step 3: Write `src/rconPacket.ts`**

```ts
export const SERVERDATA_AUTH = 3;
export const SERVERDATA_AUTH_RESPONSE = 2;
export const SERVERDATA_EXECCOMMAND = 2;
export const SERVERDATA_RESPONSE_VALUE = 0;

export interface RconPacket {
  id: number;
  type: number;
  body: string;
}

export function encodePacket(id: number, type: number, body: string): Buffer {
  const bodyBuf = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(bodyBuf.length + 14); // 4 size + 4 id + 4 type + body + 2 nulls
  buf.writeInt32LE(bodyBuf.length + 10, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBuf.copy(buf, 12);
  // last two bytes already 0
  return buf;
}

/** Pull all complete packets from a stream buffer; return leftover bytes. */
export function decodePackets(buf: Buffer): { packets: RconPacket[]; rest: Buffer } {
  const packets: RconPacket[] = [];
  let off = 0;
  while (buf.length - off >= 4) {
    const size = buf.readInt32LE(off);
    if (buf.length - off - 4 < size) break; // incomplete
    const id = buf.readInt32LE(off + 4);
    const type = buf.readInt32LE(off + 8);
    const body = buf.toString('utf8', off + 12, off + 4 + size - 2); // exclude 2 trailing nulls
    packets.push({ id, type, body });
    off += 4 + size;
  }
  return { packets, rest: buf.subarray(off) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/rconPacket.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/rconPacket.ts tests/rconPacket.test.ts && git commit -m "feat: source rcon packet encode/decode"
```

---

### Task 5: RCON client (against a fake server)

**Files:**
- Create: `src/rcon.ts`
- Test: `tests/rcon.test.ts`

Design: `RconClient` opens a TCP socket, authenticates, and `exec(cmd)` resolves
with the response body of the matching-id `RESPONSE_VALUE` packet. Our commands
all produce a single small (<4 KB) response, so single-packet handling is
sufficient; a comment notes multi-packet fragmentation is out of scope. The test
stands up a real in-process `net.Server` speaking the protocol — no game server.

- [ ] **Step 1: Write failing test `tests/rcon.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { RconClient } from '../src/rcon.js';
import {
  decodePackets, encodePacket, SERVERDATA_AUTH, SERVERDATA_AUTH_RESPONSE,
  SERVERDATA_EXECCOMMAND, SERVERDATA_RESPONSE_VALUE,
} from '../src/rconPacket.js';

// Minimal fake Source-RCON server. Password 'secret'. Echoes exec commands as
// `ran:<cmd>` unless the command is 'dumpcmd', for which it returns 'DUMPBODY'.
function fakeServer(password = 'secret'): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf: Buffer = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk as Buffer]);
        const { packets, rest } = decodePackets(buf);
        buf = rest;
        for (const p of packets) {
          if (p.type === SERVERDATA_AUTH) {
            const ok = p.body === password;
            sock.write(encodePacket(0, SERVERDATA_RESPONSE_VALUE, ''));
            sock.write(encodePacket(ok ? p.id : -1, SERVERDATA_AUTH_RESPONSE, ''));
          } else if (p.type === SERVERDATA_EXECCOMMAND) {
            const body = p.body === 'dumpcmd' ? 'DUMPBODY' : `ran:${p.body}`;
            sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, body));
          }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

let stop: (() => Promise<void>) | null = null;
afterEach(async () => { if (stop) await stop(); stop = null; });

describe('RconClient', () => {
  it('authenticates and runs a command', async () => {
    const srv = await fakeServer();
    stop = srv.close;
    const client = new RconClient({ host: '127.0.0.1', port: srv.port, password: 'secret' });
    await client.connect();
    expect(await client.exec('status')).toBe('ran:status');
    expect(await client.exec('dumpcmd')).toBe('DUMPBODY');
    client.close();
  });

  it('rejects a bad password', async () => {
    const srv = await fakeServer();
    stop = srv.close;
    const client = new RconClient({ host: '127.0.0.1', port: srv.port, password: 'wrong' });
    await expect(client.connect()).rejects.toThrow(/auth/i);
    client.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rcon.test.ts`
Expected: FAIL — cannot find module `../src/rcon.js`.

- [ ] **Step 3: Write `src/rcon.ts`**

```ts
import net from 'node:net';
import {
  decodePackets, encodePacket, type RconPacket,
  SERVERDATA_AUTH, SERVERDATA_AUTH_RESPONSE, SERVERDATA_EXECCOMMAND, SERVERDATA_RESPONSE_VALUE,
} from './rconPacket.js';

export interface RconOpts {
  host: string;
  port: number;
  password: string;
  timeoutMs?: number;
}

/**
 * Minimal Source RCON (TCP) client. Each `exec` resolves with the body of the
 * RESPONSE_VALUE packet whose id matches the request. Our commands return a
 * single small (<4 KB) packet, so multi-packet fragmentation is intentionally
 * not handled here.
 */
export class RconClient {
  private sock: net.Socket | null = null;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, { resolve: (body: string) => void; reject: (e: Error) => void }>();
  private readonly timeoutMs: number;

  constructor(private opts: RconOpts) {
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.opts.host, port: this.opts.port });
      this.sock = sock;
      const authId = this.nextId++;
      const timer = setTimeout(() => reject(new Error('rcon connect timeout')), this.timeoutMs);

      sock.on('error', (err) => { clearTimeout(timer); reject(err); });
      sock.on('data', (chunk) => this.onData(chunk));
      sock.on('connect', () => {
        sock.write(encodePacket(authId, SERVERDATA_AUTH, this.opts.password));
      });

      // Resolve/reject connect() based on the AUTH_RESPONSE.
      this.onAuth = (p: RconPacket) => {
        clearTimeout(timer);
        if (p.id === -1) reject(new Error('rcon auth failed'));
        else resolve();
        this.onAuth = null;
      };
    });
  }

  private onAuth: ((p: RconPacket) => void) | null = null;

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    const { packets, rest } = decodePackets(this.buf);
    this.buf = rest;
    for (const p of packets) {
      if (p.type === SERVERDATA_AUTH_RESPONSE) {
        this.onAuth?.(p);
        continue;
      }
      if (p.type === SERVERDATA_RESPONSE_VALUE) {
        const waiter = this.pending.get(p.id);
        if (waiter) {
          this.pending.delete(p.id);
          waiter.resolve(p.body);
        }
      }
    }
  }

  exec(cmd: string): Promise<string> {
    if (!this.sock) return Promise.reject(new Error('rcon not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rcon exec timeout: ${cmd}`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (body) => { clearTimeout(timer); resolve(body); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.sock!.write(encodePacket(id, SERVERDATA_EXECCOMMAND, cmd));
    });
  }

  close(): void {
    this.sock?.destroy();
    this.sock = null;
    for (const [, w] of this.pending) w.reject(new Error('rcon closed'));
    this.pending.clear();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/rcon.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/rcon.ts tests/rcon.test.ts && git commit -m "feat: source rcon tcp client"
```

---

### Task 6: Server pool

**Files:**
- Create: `src/serverPool.ts`
- Test: `tests/serverPool.test.ts`

Design: DB-backed helpers over the existing `servers` table. `claimIdle()`
atomically flips exactly one `idle` row to `reserved` and returns it (or null if
none). `release`/`markLive`/`markOffline` set status. `addServer(...)` inserts a
row (used by tests and, later, seeding).

- [ ] **Step 1: Write failing test `tests/serverPool.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer, claimIdle, release, markLive, markOffline, getServer } from '../src/serverPool.js';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

function seedTwo() {
  addServer(db, { name: 's1', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'p1' });
  addServer(db, { name: 's2', host: '10.0.0.2', port: 27015, rconPort: 27015, rconPassword: 'p2' });
}

describe('serverPool', () => {
  it('addServer inserts as idle by default and getServer reads it back', () => {
    const id = addServer(db, { name: 's1', host: 'h', port: 1, rconPort: 2, rconPassword: 'x', status: 'idle' });
    const s = getServer(db, id)!;
    expect(s.name).toBe('s1');
    expect(s.status).toBe('idle');
    expect(s.rcon_password).toBe('x');
  });

  it('claimIdle reserves exactly one idle server per call', () => {
    seedTwo();
    const a = claimIdle(db)!;
    const b = claimIdle(db)!;
    expect(a.id).not.toBe(b.id);
    expect(getServer(db, a.id)!.status).toBe('reserved');
    expect(claimIdle(db)).toBeNull(); // none left
  });

  it('does not claim offline/reserved/live servers', () => {
    const id = addServer(db, { name: 's', host: 'h', port: 1, rconPort: 2, rconPassword: 'x', status: 'offline' });
    expect(claimIdle(db)).toBeNull();
    markOffline(db, id);
    expect(getServer(db, id)!.status).toBe('offline');
  });

  it('release/markLive/markOffline transition status', () => {
    seedTwo();
    const s = claimIdle(db)!;
    markLive(db, s.id);
    expect(getServer(db, s.id)!.status).toBe('live');
    release(db, s.id);
    expect(getServer(db, s.id)!.status).toBe('idle');
    markOffline(db, s.id);
    expect(getServer(db, s.id)!.status).toBe('offline');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/serverPool.test.ts`
Expected: FAIL — cannot find module `../src/serverPool.js`.

- [ ] **Step 3: Write `src/serverPool.ts`**

```ts
import type { DB } from './db.js';

export interface ServerRow {
  id: number;
  name: string;
  host: string;
  port: number;
  rcon_port: number;
  rcon_password: string;
  status: 'idle' | 'reserved' | 'live' | 'offline';
}

export function addServer(
  db: DB,
  s: {
    name: string; host: string; port: number; rconPort: number; rconPassword: string;
    status?: ServerRow['status'];
  },
): number {
  const info = db
    .prepare(
      `INSERT INTO servers (name, host, port, rcon_port, rcon_password, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(s.name, s.host, s.port, s.rconPort, s.rconPassword, s.status ?? 'idle');
  return Number(info.lastInsertRowid);
}

export function getServer(db: DB, id: number): ServerRow | undefined {
  return db.prepare('SELECT * FROM servers WHERE id = ?').get(id) as ServerRow | undefined;
}

/** Atomically reserve one idle server; returns it, or null if none are idle. */
export function claimIdle(db: DB): ServerRow | null {
  return db.transaction(() => {
    const row = db
      .prepare("SELECT * FROM servers WHERE status = 'idle' ORDER BY id LIMIT 1")
      .get() as ServerRow | undefined;
    if (!row) return null;
    db.prepare("UPDATE servers SET status = 'reserved' WHERE id = ?").run(row.id);
    return { ...row, status: 'reserved' as const };
  })();
}

function setStatus(db: DB, id: number, status: ServerRow['status']): void {
  db.prepare('UPDATE servers SET status = ? WHERE id = ?').run(status, id);
}

export const release = (db: DB, id: number) => setStatus(db, id, 'idle');
export const markLive = (db: DB, id: number) => setStatus(db, id, 'live');
export const markOffline = (db: DB, id: number) => setStatus(db, id, 'offline');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/serverPool.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/serverPool.ts tests/serverPool.test.ts && git commit -m "feat: db-backed server pool"
```

---

### Task 7: UDP log listener

**Files:**
- Create: `src/logListener.ts`
- Test: `tests/logListener.test.ts`

Design: `LogListener` binds a UDP socket, runs each datagram through
`parseLogDatagram`, and invokes a callback with events whose token is currently
registered (`register(token)` / `unregister(token)`). Unknown-token or unparseable
datagrams are silently dropped. The test sends real UDP datagrams to the bound
port on loopback.

- [ ] **Step 1: Write failing test `tests/logListener.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import dgram from 'node:dgram';
import { LogListener } from '../src/logListener.js';
import type { LogEvent } from '../src/logParse.js';

const TOKEN = '0123456789abcdef0123456789abcdef';
const OTHER = 'ffffffffffffffffffffffffffffffff';

function send(port: number, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = dgram.createSocket('udp4');
    const text = Buffer.from(`L 07/30/2026 - 14:23:01: ${body}\n`, 'utf8');
    const pkt = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]), text]);
    c.send(pkt, port, '127.0.0.1', (err) => { c.close(); err ? reject(err) : resolve(); });
  });
}

let listener: LogListener | null = null;
afterEach(async () => { if (listener) await listener.close(); listener = null; });

describe('LogListener', () => {
  it('delivers events for a registered token and drops others', async () => {
    const got: LogEvent[] = [];
    listener = new LogListener((ev) => got.push(ev));
    const port = await listener.listen(0);
    listener.register(TOKEN);

    await send(port, `PUG ${TOKEN} HEARTBEAT`);
    await send(port, `PUG ${OTHER} HEARTBEAT`);       // unregistered token → dropped
    await send(port, 'some other log line');           // non-PUG → dropped
    await send(port, `PUG ${TOKEN} MATCH_END a=1 b=2 winner=a`);

    await new Promise((r) => setTimeout(r, 50)); // let datagrams arrive

    expect(got).toEqual([
      { kind: 'heartbeat', token: TOKEN },
      { kind: 'match_end', token: TOKEN, a: 1, b: 2, winner: 'a' },
    ]);
  });

  it('stops delivering after unregister', async () => {
    const got: LogEvent[] = [];
    listener = new LogListener((ev) => got.push(ev));
    const port = await listener.listen(0);
    listener.register(TOKEN);
    listener.unregister(TOKEN);
    await send(port, `PUG ${TOKEN} HEARTBEAT`);
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/logListener.test.ts`
Expected: FAIL — cannot find module `../src/logListener.js`.

- [ ] **Step 3: Write `src/logListener.ts`**

```ts
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { parseLogDatagram, type LogEvent } from './logParse.js';

/**
 * Binds a UDP socket for srcds `logaddress` traffic. Datagrams are parsed and,
 * if their token is registered, handed to the callback. Everything else (bad
 * parse, unknown token) is dropped — the stream is untrusted and lossy by design.
 */
export class LogListener {
  private sock: dgram.Socket | null = null;
  private tokens = new Set<string>();

  constructor(private onEvent: (ev: LogEvent) => void) {}

  listen(port: number, address = '0.0.0.0'): Promise<number> {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      this.sock = sock;
      sock.on('error', reject);
      sock.on('message', (msg) => {
        const ev = parseLogDatagram(msg);
        if (ev && this.tokens.has(ev.token)) this.onEvent(ev);
      });
      sock.bind(port, address, () => {
        resolve((sock.address() as AddressInfo).port);
      });
    });
  }

  register(token: string): void { this.tokens.add(token); }
  unregister(token: string): void { this.tokens.delete(token); }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.sock) return resolve();
      this.sock.close(() => resolve());
      this.sock = null;
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/logListener.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/logListener.ts tests/logListener.test.ts && git commit -m "feat: udp logaddress listener with token gating"
```

---

### Task 8: Config additions for orchestration

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts` (extend)

Design: add orchestration settings to `Config` — the UDP listen port, and the
backend's own reachable `host:port` that gets handed to `logaddress_add` so the
server knows where to send logs. Keep defaults dev-friendly.

- [ ] **Step 1: Extend `tests/config.test.ts`**

Add these cases inside the existing `describe('loadConfig', ...)` block:

```ts
  it('applies orchestration defaults', () => {
    const c = loadConfig({});
    expect(c.logListenPort).toBe(27500);
    expect(c.logPublicAddress).toBe('127.0.0.1:27500');
  });

  it('parses orchestration env', () => {
    const c = loadConfig({ LOG_LISTEN_PORT: '30000', LOG_PUBLIC_ADDRESS: '203.0.113.9:30000' });
    expect(c.logListenPort).toBe(30000);
    expect(c.logPublicAddress).toBe('203.0.113.9:30000');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `logListenPort` is undefined.

- [ ] **Step 3: Modify `src/config.ts`**

Add to the `Config` interface:

```ts
  logListenPort: number;
  logPublicAddress: string;
```

Add to the object returned by `loadConfig`:

```ts
    logListenPort: Number(env.LOG_LISTEN_PORT ?? 27500),
    logPublicAddress: env.LOG_PUBLIC_ADDRESS ?? '127.0.0.1:27500',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS (all config tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts && git commit -m "feat: orchestration config (udp port + logaddress public address)"
```

---

### Task 9: Real orchestrator — setup and finish

**Files:**
- Modify: `src/orchestrator.ts`
- Test: `tests/orchestrator.test.ts`

Design: add `RealOrchestrator` implementing the existing `Orchestrator` interface,
composed from an injected RCON factory, a `LogListener`, and the DB. It reads the
match roster/campaign from the DB, so `setupMatch` needs no extra args (matching
the interface). It exposes `finishMatch(matchId)` for the RCON reconciliation
pull. The `Orchestrator` interface gains `finishMatch`; `DevOrchestrator` gets a
no-op `finishMatch` so it still satisfies the interface.

Because the real match-end trigger (a `MATCH_END` UDP event, or an admin action)
is wired in a later task, this task tests `setupMatch` and `finishMatch` directly
against a fake RCON server + in-memory DB.

- [ ] **Step 1: Write failing test `tests/orchestrator.test.ts`**

```ts
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import net from 'node:net';
import { openDb, type DB } from '../src/db.js';
import { RealOrchestrator } from '../src/orchestrator.js';
import { addServer, getServer } from '../src/serverPool.js';
import { LogListener } from '../src/logListener.js';
import { currentSeasonId } from '../src/players.js';
import {
  decodePackets, encodePacket, SERVERDATA_AUTH, SERVERDATA_AUTH_RESPONSE,
  SERVERDATA_EXECCOMMAND, SERVERDATA_RESPONSE_VALUE,
} from '../src/rconPacket.js';

// Fake RCON server that records every exec command and, for `sm_pug_dump`,
// returns a canned authoritative dump for match 1.
function fakeServer(dumpBody: string): Promise<{ port: number; cmds: string[]; close: () => Promise<void> }> {
  const cmds: string[] = [];
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf: Buffer = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk as Buffer]);
        const { packets, rest } = decodePackets(buf);
        buf = rest;
        for (const p of packets) {
          if (p.type === SERVERDATA_AUTH) {
            sock.write(encodePacket(0, SERVERDATA_RESPONSE_VALUE, ''));
            sock.write(encodePacket(p.id, SERVERDATA_AUTH_RESPONSE, ''));
          } else if (p.type === SERVERDATA_EXECCOMMAND) {
            cmds.push(p.body);
            const body = p.body.startsWith('sm_pug_dump') ? dumpBody : 'ok';
            sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, body));
          }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        cmds,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

const IDS = Array.from({ length: 8 }, (_, i) => `7656119800000000${i + 1}`);

function seedMatch(db: DB): number {
  const season = currentSeasonId(db);
  for (const id of IDS) db.prepare('INSERT INTO players (steamid, name) VALUES (?, ?)').run(id, `p${id.slice(-1)}`);
  const mid = Number(
    db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (?, 'configuring', 'no_mercy')")
      .run(season).lastInsertRowid,
  );
  IDS.forEach((id, i) => db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)')
    .run(mid, id, i < 4 ? 'a' : 'b'));
  return mid;
}

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanup) await c(); cleanup = []; });

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

describe('RealOrchestrator', () => {
  it('setupMatch reserves a server, configures it over RCON, marks match live', async () => {
    const srv = await fakeServer('');
    cleanup.push(srv.close);
    const serverId = addServer(db, { name: 's', host: '127.0.0.1', port: 27015, rconPort: srv.port, rconPassword: 'secret' });
    const listener = new LogListener(() => {});
    await listener.listen(0);
    cleanup.push(() => listener.close());

    const orch = new RealOrchestrator({
      db, listener,
      logPublicAddress: '127.0.0.1:27500',
      makeRcon: (o) => o,
    });
    const mid = seedMatch(db);
    await orch.setupMatch(mid);

    // one server used, now live; match live with a token + server_id
    expect(getServer(db, serverId)!.status).toBe('live');
    const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(mid) as any;
    expect(m.state).toBe('live');
    expect(m.server_id).toBe(serverId);
    expect(m.token).toMatch(/^[0-9a-f]{32}$/);

    // RCON commands: logaddress_add, exec, sv_password, 1 match + 8 roster, changelevel
    expect(srv.cmds.some((c) => c.startsWith('logaddress_add 127.0.0.1:27500'))).toBe(true);
    expect(srv.cmds.filter((c) => c.startsWith('sm_pug_roster'))).toHaveLength(8);
    expect(srv.cmds.some((c) => c.startsWith(`sm_pug_match ${mid} ${m.token} no_mercy`))).toBe(true);
    expect(srv.cmds.some((c) => c.startsWith('changelevel'))).toBe(true);
  });

  it('setupMatch aborts the match when no server is free', async () => {
    const orch = new RealOrchestrator({
      db, listener: new LogListener(() => {}),
      logPublicAddress: '127.0.0.1:27500', makeRcon: (o) => o,
    });
    const mid = seedMatch(db); // no servers added
    await orch.setupMatch(mid);
    expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(mid) as any).state).toBe('aborted');
  });

  it('finishMatch pulls the dump, persists scores/stats, resets server, completes match', async () => {
    const mid = 1; // seedMatch below yields id 1 in a fresh db
    const dump = [
      `DUMP match=${mid}`,
      'MAP map=l4d_hospital01 a=245 b=310',
      ...IDS.map((id, i) => `STAT steamid=${id} team=${i < 4 ? 'a' : 'b'} sidmg=${100 + i} sikill=${i} ck=${i * 10} ff=${i} rev=${i}`),
      'END winner=b a=245 b=310',
    ].join('\n');
    const srv = await fakeServer(dump);
    cleanup.push(srv.close);
    const serverId = addServer(db, { name: 's', host: '127.0.0.1', port: 27015, rconPort: srv.port, rconPassword: 'secret' });
    const listener = new LogListener(() => {});
    await listener.listen(0);
    cleanup.push(() => listener.close());
    const orch = new RealOrchestrator({ db, listener, logPublicAddress: '127.0.0.1:27500', makeRcon: (o) => o });

    const realMid = seedMatch(db);
    expect(realMid).toBe(mid);
    await orch.setupMatch(realMid);
    await orch.finishMatch(realMid);

    const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(realMid) as any;
    expect(m.state).toBe('completed');
    expect(m.winner).toBe('b');
    expect(m.team_a_score).toBe(245);
    expect(m.team_b_score).toBe(310);
    expect(getServer(db, serverId)!.status).toBe('idle'); // released
    const mp = db.prepare('SELECT * FROM match_players WHERE match_id = ? AND player_id = ?').get(realMid, IDS[0]) as any;
    expect(mp.si_damage).toBe(100);
    expect(JSON.parse(mp.stats_json).sidmg).toBe('100');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/orchestrator.test.ts`
Expected: FAIL — `RealOrchestrator` is not exported.

- [ ] **Step 3: Rewrite `src/orchestrator.ts`**

```ts
import type { DB } from './db.js';
import type { RconClient, RconOpts } from './rcon.js';
import { RconClient as RealRcon } from './rcon.js';
import type { LogListener } from './logListener.js';
import { newToken } from './matchToken.js';
import { parseDump, type Dump } from './dumpParse.js';
import { claimIdle, release, markLive, getServer, type ServerRow } from './serverPool.js';

/** Sub-project 2b's SourcePawn plugin is the server-side counterpart. */
export interface Orchestrator {
  setupMatch(matchId: number): Promise<void>;
  finishMatch(matchId: number): Promise<void>;
}

/** Stub used in dev mode — no real server contact. */
export class DevOrchestrator implements Orchestrator {
  async setupMatch(matchId: number): Promise<void> {
    console.log(`[orchestrator-stub] match ${matchId} created; real orchestration is sub-project 2`);
  }
  async finishMatch(matchId: number): Promise<void> {
    console.log(`[orchestrator-stub] finishMatch ${matchId} no-op`);
  }
}

export interface RealOrchestratorDeps {
  db: DB;
  listener: LogListener;
  logPublicAddress: string;
  /** Opts-transform hook (default identity). The real RconClient is always used;
   *  this lets tests point it at a fake TCP server via injected opts. */
  makeRcon?: (opts: RconOpts) => RconOpts;
}

interface MatchRow {
  id: number;
  campaign: string;
  server_id: number | null;
  token: string | null;
}

export class RealOrchestrator implements Orchestrator {
  private db: DB;
  private listener: LogListener;
  private logPublicAddress: string;
  private makeRcon: (opts: RconOpts) => RconOpts;

  constructor(deps: RealOrchestratorDeps) {
    this.db = deps.db;
    this.listener = deps.listener;
    this.logPublicAddress = deps.logPublicAddress;
    this.makeRcon = deps.makeRcon ?? ((o) => o);
  }

  private async connectRcon(server: ServerRow): Promise<RconClient> {
    const opts = this.makeRcon({ host: server.host, port: server.rcon_port, password: server.rcon_password });
    const client = new RealRcon(opts);
    await client.connect();
    return client;
  }

  async setupMatch(matchId: number): Promise<void> {
    const server = claimIdle(this.db);
    if (!server) {
      this.db.prepare("UPDATE matches SET state = 'aborted' WHERE id = ?").run(matchId);
      console.error(`[orchestrator] no idle server for match ${matchId}; aborted`);
      return;
    }

    const match = this.db.prepare('SELECT id, campaign FROM matches WHERE id = ?').get(matchId) as
      | { id: number; campaign: string }
      | undefined;
    if (!match) {
      release(this.db, server.id);
      return;
    }
    const roster = this.db
      .prepare('SELECT player_id, team FROM match_players WHERE match_id = ?')
      .all(matchId) as { player_id: string; team: 'a' | 'b' }[];

    const token = newToken();
    this.db.prepare('UPDATE matches SET server_id = ?, token = ? WHERE id = ?').run(server.id, token, matchId);
    this.listener.register(token);

    let rcon: RconClient | null = null;
    try {
      rcon = await this.connectRcon(server);
      await rcon.exec(`logaddress_add ${this.logPublicAddress}`);
      await rcon.exec('exec pug_match');
      await rcon.exec(`sv_password "pug_${token.slice(0, 8)}"`);
      await rcon.exec(`sm_pug_match ${matchId} ${token} ${match.campaign}`);
      for (const r of roster) await rcon.exec(`sm_pug_roster ${r.player_id}:${r.team}`);
      await rcon.exec(`changelevel ${firstMapOf(match.campaign)}`);
      markLive(this.db, server.id);
      this.db.prepare("UPDATE matches SET state = 'live' WHERE id = ?").run(matchId);
    } catch (err) {
      console.error(`[orchestrator] setup failed for match ${matchId}:`, err);
      this.listener.unregister(token);
      release(this.db, server.id);
      this.db.prepare("UPDATE matches SET state = 'aborted' WHERE id = ?").run(matchId);
    } finally {
      rcon?.close();
    }
  }

  async finishMatch(matchId: number): Promise<void> {
    const match = this.db
      .prepare('SELECT id, campaign, server_id, token FROM matches WHERE id = ?')
      .get(matchId) as MatchRow | undefined;
    if (!match || match.server_id === null || match.token === null) return;
    const server = getServer(this.db, match.server_id);
    if (!server) return;

    let rcon: RconClient | null = null;
    try {
      rcon = await this.connectRcon(server);
      const body = await rcon.exec(`sm_pug_dump ${match.token}`);
      const dump = parseDump(body);
      if (!dump) {
        console.error(`[orchestrator] unparseable dump for match ${matchId}; leaving live for retry`);
        return;
      }
      this.persist(matchId, dump);
      await rcon.exec(`sm_pug_abort ${match.token}`); // tell the server to reset/kick
    } catch (err) {
      console.error(`[orchestrator] finish failed for match ${matchId}:`, err);
      return;
    } finally {
      rcon?.close();
    }

    this.listener.unregister(match.token);
    release(this.db, match.server_id);
  }

  private persist(matchId: number, d: Dump): void {
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE matches SET state = 'completed', team_a_score = ?, team_b_score = ?, winner = ?, ended_at = datetime('now') WHERE id = ?")
        .run(d.totalA, d.totalB, d.winner, matchId);
      const upd = this.db.prepare(
        `UPDATE match_players SET si_damage = ?, si_kills = ?, common_kills = ?, ff_dealt = ?, revives = ?, stats_json = ?
         WHERE match_id = ? AND player_id = ?`,
      );
      for (const p of d.players) {
        upd.run(p.sidmg, p.sikill, p.ck, p.ff, p.rev,
          JSON.stringify({ sidmg: String(p.sidmg), sikill: String(p.sikill), ck: String(p.ck), ff: String(p.ff), rev: String(p.rev) }),
          matchId, p.steamid);
      }
    })();
  }
}

/** First playable map of a campaign. Full per-campaign map lists live in the plugin;
 *  the backend only needs the entry map to changelevel into. */
function firstMapOf(campaign: string): string {
  const FIRST: Record<string, string> = {
    no_mercy: 'l4d_hospital01_apartment',
    death_toll: 'l4d_smalltown01_caves',
    dead_air: 'l4d_airport01_greenhouse',
    blood_harvest: 'l4d_farm01_hilltop',
  };
  return FIRST[campaign] ?? 'l4d_hospital01_apartment';
}
```

- [ ] **Step 4: Add the `token` column to the schema**

The `matches` table needs a `token` column. Modify `src/db.ts` — in the
`CREATE TABLE IF NOT EXISTS matches (...)` block, add `token TEXT` after
`server_id INTEGER REFERENCES servers(id),`:

```
  server_id INTEGER REFERENCES servers(id),
  token TEXT,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/orchestrator.test.ts && npx vitest run && npx tsc --noEmit`
Expected: orchestrator tests PASS (3), full suite PASS, clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator.ts src/db.ts tests/orchestrator.test.ts && git commit -m "feat: real orchestrator (rcon setup + reconciliation-pull finish)"
```

---

### Task 10: Trigger finishMatch from the MATCH_END live event, and wire into buildServer

**Files:**
- Modify: `src/server.ts`
- Test: `tests/orchestrator-e2e.test.ts`

Design: the live `MATCH_END` UDP event is the signal to run the authoritative
`finishMatch` pull. `buildServer` constructs the `LogListener` and the
`RealOrchestrator` when not in dev mode, and routes `match_end` events to
`orchestrator.finishMatch(matchId)` (looking up the match by token). Dev mode
keeps the stub and no listener. The e2e test drives a full setup→MATCH_END→finish
cycle through a fake RCON server and a real UDP datagram.

- [ ] **Step 1: Write failing test `tests/orchestrator-e2e.test.ts`**

```ts
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import net from 'node:net';
import dgram from 'node:dgram';
import { openDb, type DB } from '../src/db.js';
import { RealOrchestrator } from '../src/orchestrator.js';
import { LogListener } from '../src/logListener.js';
import { addServer } from '../src/serverPool.js';
import { currentSeasonId } from '../src/players.js';
import {
  decodePackets, encodePacket, SERVERDATA_AUTH, SERVERDATA_AUTH_RESPONSE,
  SERVERDATA_EXECCOMMAND, SERVERDATA_RESPONSE_VALUE,
} from '../src/rconPacket.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119800000000${i + 1}`);

function fakeServer(dumpFor: (mid: string) => string) {
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
    const server = net.createServer((sock) => {
      let buf: Buffer = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk as Buffer]);
        const { packets, rest } = decodePackets(buf); buf = rest;
        for (const p of packets) {
          if (p.type === SERVERDATA_AUTH) {
            sock.write(encodePacket(0, SERVERDATA_RESPONSE_VALUE, ''));
            sock.write(encodePacket(p.id, SERVERDATA_AUTH_RESPONSE, ''));
          } else if (p.type === SERVERDATA_EXECCOMMAND) {
            const m = p.body.match(/^sm_pug_dump \S+/);
            sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, m ? dumpFor(p.body) : 'ok'));
          }
        }
      });
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({ port: (server.address() as net.AddressInfo).port, close: () => new Promise((r) => server.close(() => r())) }));
  });
}

function seedMatch(db: DB): number {
  const season = currentSeasonId(db);
  for (const id of IDS) db.prepare('INSERT INTO players (steamid, name) VALUES (?, ?)').run(id, `p${id.slice(-1)}`);
  const mid = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (?, 'configuring', 'no_mercy')").run(season).lastInsertRowid);
  IDS.forEach((id, i) => db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)').run(mid, id, i < 4 ? 'a' : 'b'));
  return mid;
}

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanup) await c(); cleanup = []; });
let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

describe('orchestrator end-to-end (fake server + real UDP)', () => {
  it('a MATCH_END datagram drives finishMatch to completion', async () => {
    const dumpFor = (cmd: string) => {
      const token = cmd.split(/\s+/)[1];
      const mid = (db.prepare('SELECT id FROM matches WHERE token = ?').get(token) as any).id;
      return [
        `DUMP match=${mid}`,
        'MAP map=l4d_hospital01 a=100 b=200',
        ...IDS.map((id, i) => `STAT steamid=${id} team=${i < 4 ? 'a' : 'b'} sidmg=1 sikill=1 ck=1 ff=1 rev=1`),
        'END winner=b a=100 b=200',
      ].join('\n');
    };
    const srv = await fakeServer(dumpFor);
    cleanup.push(srv.close);
    addServer(db, { name: 's', host: '127.0.0.1', port: 27015, rconPort: srv.port, rconPassword: 'secret' });

    let onMatchEnd: (token: string) => void = () => {};
    const listener = new LogListener((ev) => { if (ev.kind === 'match_end') onMatchEnd(ev.token); });
    const port = await listener.listen(0);
    cleanup.push(() => listener.close());

    const orch = new RealOrchestrator({ db, listener, logPublicAddress: `127.0.0.1:${port}`, makeRcon: (o) => o });
    onMatchEnd = (token) => {
      const mid = (db.prepare('SELECT id FROM matches WHERE token = ?').get(token) as any).id;
      void orch.finishMatch(mid);
    };

    const mid = seedMatch(db);
    await orch.setupMatch(mid);
    const token = (db.prepare('SELECT token FROM matches WHERE id = ?').get(mid) as any).token;

    // send a real MATCH_END datagram to the listener
    const c = dgram.createSocket('udp4');
    const body = `L 07/30/2026 - 14:23:01: PUG ${token} MATCH_END a=100 b=200 winner=b\n`;
    const pkt = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]), Buffer.from(body)]);
    await new Promise<void>((r) => c.send(pkt, port, '127.0.0.1', () => { c.close(); r(); }));

    // wait for the async finishMatch to settle
    await new Promise((r) => setTimeout(r, 150));

    const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(mid) as any;
    expect(m.state).toBe('completed');
    expect(m.winner).toBe('b');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/orchestrator-e2e.test.ts`
Expected: PASS already? No — it constructs `RealOrchestrator` directly (which exists from Task 9), so this test may pass without any server.ts change. Run it: if it passes, that confirms the orchestrator wiring works end-to-end via a real UDP round-trip. If it fails, fix per the error. Either way, proceed to Step 3 to wire the production path into `buildServer`.

- [ ] **Step 3: Modify `src/server.ts` to construct the real orchestrator + listener outside dev mode**

Add imports:

```ts
import { RealOrchestrator } from './orchestrator.js';
import { LogListener } from './logListener.js';
```

Replace the current matchmaker/orchestrator construction block. Currently it is:

```ts
  const matchmaker = new Matchmaker(deps.db, {
    broadcast: (event) => hub.broadcast(event),
    orchestrator: deps.orchestrator ?? new DevOrchestrator(),
  });
```

Change it to build a real orchestrator (with a UDP listener that triggers
`finishMatch` on `match_end`) when not in dev mode and no orchestrator was
injected:

```ts
  let orchestrator = deps.orchestrator;
  let logListener: LogListener | null = null;
  if (!orchestrator) {
    if (deps.config.devMode) {
      orchestrator = new DevOrchestrator();
    } else {
      logListener = new LogListener((ev) => {
        if (ev.kind === 'match_end') {
          const row = deps.db.prepare('SELECT id FROM matches WHERE token = ?').get(ev.token) as { id: number } | undefined;
          if (row) void (orchestrator as RealOrchestrator).finishMatch(row.id);
        }
      });
      await logListener.listen(deps.config.logListenPort);
      orchestrator = new RealOrchestrator({
        db: deps.db,
        listener: logListener,
        logPublicAddress: deps.config.logPublicAddress,
      });
    }
  }

  const matchmaker = new Matchmaker(deps.db, {
    broadcast: (event) => hub.broadcast(event),
    orchestrator,
  });
  app.addHook('onClose', async () => { if (logListener) await logListener.close(); });
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: full suite passes (including the new e2e test), clean typecheck. Note the existing api/dev tests run in dev mode or inject an orchestrator, so they keep using the stub / injected orchestrator and bind no UDP socket.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/orchestrator-e2e.test.ts && git commit -m "feat: wire real orchestrator + udp listener into buildServer; finish on MATCH_END"
```

---

### Task 11: README + status update

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the Status section of `README.md`**

Replace the existing `## Status` section body with:

```markdown
Sub-project 1 (backend core) complete. Sub-project 2a (backend orchestrator)
complete: Source RCON client, DB-backed server pool, UDP `logaddress` listener +
parser, per-match token, and a real orchestrator that configures a match over
RCON, receives a lossy live-view feed over UDP, and pulls the authoritative
final scores/stats over RCON (`sm_pug_dump`) to drive `configuring` → `live` →
`completed`. All exercised against a fake RCON server + synthetic UDP datagrams —
no live game server is contacted.

**Not yet built (need the live box):** the `pug-match` SourcePawn plugin (2b) and
the second-srcds-instance infrastructure (2c). Designed in
`docs/superpowers/specs/2026-07-30-sub-project-2-orchestrator-plugin-design.md`.
The `logaddress` line format is pinned against synthetic samples until a real
capture from the L4D1 binary is taken during the 2b/2c dry-run.
```

Add a row to the Environment table:

```markdown
| LOG_LISTEN_PORT | 27500 | UDP port the backend binds for srcds logaddress traffic |
| LOG_PUBLIC_ADDRESS | 127.0.0.1:27500 | host:port handed to `logaddress_add` (the server's view of the backend) |
```

- [ ] **Step 2: Full verification**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests green, clean typecheck. Report the exact test count.

- [ ] **Step 3: Commit**

```bash
git add README.md && git commit -m "docs: README for sub-project 2a orchestrator"
```

---

## Out of scope (later)

- **2b:** the `pug-match` SourcePawn plugin (roster enforcement, Rotoblin-layered
  match flow, `LogToGame` emission, `sm_pug_dump` responder).
- **2c:** second srcds instance on the Dallas box (install dir, systemd unit, port
  pair, secrets, ufw, steal-monitor fix), plus seeding its `servers` row.
- **Real log-sample capture** to pin `logParse.ts`/`dumpParse.ts` against actual
  L4D1 srcds output.
- **Sub-project 3:** SR updates from the persisted scores/stats, rating history,
  profiles, leaderboard, Discord.
