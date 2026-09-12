# Replay Viewer (Piece 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn recorded `.rpl` files into a watchable top-down viewer on riversidepug.com, for finished rounds, for rounds still being recorded, and for standalone `!mix` sessions that have no match row.

**Architecture:** One decoder shared by server and browser, made isomorphic by swapping Node Buffer methods for a DataView. Live playback is byte-prefix polling: the server hands out raw replay bytes truncated at the last frame older than the 10 second anti-ghosting delay, so a live replay is literally a prefix of the same file format and the client has one code path. Map geometry is a per-map data table seeded from Valve's `mapinfo.res`, with an auto-fit fallback derived from the replay's own position bounds so no map is blocked on art.

**Tech Stack:** TypeScript, Node, Fastify, better-sqlite3, Preact, preact-iso, Vite, Vitest, Canvas 2D. Python with `srctools` and Pillow for a one-off texture conversion.

**Spec:** `docs/superpowers/specs/2026-09-12-replay-viewer-design.md`

## Global Constraints

- Branch is `feat/skill-stats-5`. Do not create a new branch.
- **No em dashes** anywhere: code, comments, docs, commit messages. Replace by meaning, not by swapping the character.
- **Shared modules stay self-contained with no relative imports.** `src/replayFormat.ts` and `src/mapTransform.ts` are imported by the server as `./x.js` and by the browser as `../../src/x`. A relative `.js` specifier inside either one breaks the browser build.
- **Never adjust an existing test to make the isomorphic swap pass.** The existing suite is the gate on that change. If a test fails, the port is wrong.
- **Anti-ghosting is load-bearing.** For a file that is still being written, no byte past the releasable cutoff may appear in any HTTP response, ever. The live page is public and frames carry ghost infected positions.
- **Do not deploy to the Dallas box.** No `deploy.sh`, no `deploy-web.sh`, no rcon, no plugin upload. Players are often on it. Task 14 changes the plugin source only.
- Run the full suite with `npm test`. Typecheck both projects with `npm run typecheck`.
- Commit after each task. Conventional commit prefixes, matching the existing log (`feat(replay):`, `fix(replay):`, `test(replay):`).

---

## File Structure

**Shared, imported by both server and browser:**

- `src/replayFormat.ts` (modify) - the byte layout. Becomes isomorphic. Gains a weapon id table and a version check.
- `src/mapTransform.ts` (create) - per-map world-to-image table, auto-fit fallback, projection.

**Server:**

- `src/replayTail.ts` (modify) - gains `releasableBytes()`.
- `src/replaySessions.ts` (create) - directory scan, header-only reads, session grouping, open/closed decision.
- `src/routes/replays.ts` (create) - the four HTTP routes.
- `src/server.ts` (modify) - register the routes.

**Browser:**

- `web/tsconfig.json` (modify) - include the shared modules.
- `web/src/api.ts` (modify) - response types for the new endpoints.
- `web/src/replay/source.ts` (create) - `useReplaySource()`, saved and live.
- `web/src/replay/playback.ts` (create) - `usePlayback()`, the clock.
- `web/src/replay/interpolate.ts` (create) - pure bracketing and lerp maths.
- `web/src/replay/draw.ts` (create) - pure canvas draw functions.
- `web/src/replay/timeline.ts` (create) - merge events and chat into a seekable rail.
- `web/src/replay/Viewer.tsx` (create) - the component.
- `web/src/replay/HudStrip.tsx` (create) - the in-game style panel strip.
- `web/src/routes/Replays.tsx` (create) - the browse page.
- `web/src/main.tsx` (modify) - route registration.
- `web/src/routes/Live.tsx` (modify) - mount the viewer at the top.
- `web/src/routes/MatchDetail.tsx` (modify) - mount the viewer per map.
- `web/src/styles/app.css` (modify) - viewer styles.
- `web/public/portraits/*.png` (create) - converted survivor art.

**Plugin, source only, not deployed:**

- `plugin/pug-match.sp` (modify) - format version 2, survivor character in `cls`.

---

## Task 1: Make the replay decoder isomorphic

`src/replayFormat.ts` uses Buffer read and write methods throughout. Buffer is Node-only, and the browser needs this exact module. Swap to a DataView over `Uint8Array`. `Buffer` is a subclass of `Uint8Array`, so every existing Node caller keeps working, and `fs` accepts `Uint8Array` for writes.

**Files:**
- Modify: `src/replayFormat.ts`
- Test: `tests/replayFormat.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `encodeHeader(h: ReplayHeader): Uint8Array`, `decodeHeader(buf: Uint8Array): ReplayHeader | null`, `encodeFrame(f: Frame): Uint8Array`, `decodeFrames(buf: Uint8Array, from: number, end: number): { frames: Frame[]; truncatedBytes: number }`, `decodeIndex(buf: Uint8Array, h: ReplayHeader): { tMs: number; offset: number }[]`, `parseReplay(buf: Uint8Array): Replay | null`. Every other export is unchanged.

- [ ] **Step 1: Write the failing test**

Add to `tests/replayFormat.test.ts`, inside the existing `describe('replay header', ...)` block. This is the regression test for the one bug this port can introduce: a Node Buffer is usually a window into a shared pooled ArrayBuffer, so a DataView built without the byte offset reads somebody else's bytes.

```ts
  it('decodes a buffer that is a view into a larger ArrayBuffer', () => {
    const h = header();
    const encoded = encodeHeader(h);
    // Deliberately not at offset 0. Buffer.alloc hands out pooled memory with
    // a non-zero byteOffset all the time, so this is the common case in
    // production and the rare case in tests.
    const backing = new Uint8Array(encoded.length + 64);
    backing.set(encoded, 64);
    expect(decodeHeader(backing.subarray(64))).toEqual(h);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/replayFormat.test.ts -t "view into a larger ArrayBuffer"`

Expected: FAIL. `backing.subarray(64)` is a plain `Uint8Array`, and the pre-port
`decodeHeader` calls Buffer-only prototype methods on its argument. The magic
check goes first, and `Uint8Array.prototype.toString` ignores an encoding
argument and stringifies as comma-joined decimals, so `readAscii` never returns
`'L4RP'` and the function returns null.

That makes this a genuine RED test rather than a regression guard, and it is
guarding two things at once. It proves the port accepts a plain `Uint8Array`,
which is the browser's case and the whole point of the task. It also proves the
port honours `byteOffset`: `backing.subarray(64)` starts 64 bytes into its
ArrayBuffer, so a port written as `new DataView(buf.buffer)` would read from the
wrong place and fail this test even though it is a `Uint8Array`.

- [ ] **Step 3: Add the DataView helper and port the ASCII helpers**

Replace the two helper functions in `src/replayFormat.ts` with these three:

```ts
/** Buffer's read and write helpers are Node-only, and this module is imported
 *  by the browser too. A DataView over the same bytes is the isomorphic
 *  equivalent.
 *
 *  The three-argument constructor is load-bearing. A Node Buffer is usually a
 *  window into a shared pooled ArrayBuffer, so `new DataView(buf.buffer)`
 *  would read from the start of the pool rather than the start of this
 *  buffer, silently returning another allocation's bytes. */
function dv(buf: Uint8Array): DataView {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Node's 'ascii' encoding masks the high bit off in both directions. The
 *  mask here is not decoration: it is what keeps this a faithful port rather
 *  than a subtly wider encoding. */
function writeAscii(buf: Uint8Array, s: string, off: number, len: number): void {
  buf.fill(0, off, off + len);
  const n = Math.min(s.length, len);
  for (let i = 0; i < n; i++) buf[off + i] = s.charCodeAt(i) & 0x7f;
}

function readAscii(buf: Uint8Array, off: number, len: number): string {
  let end = off + len;
  for (let i = off; i < off + len; i++) {
    if (buf[i] === 0) { end = i; break; }
  }
  let s = '';
  for (let i = off; i < end; i++) s += String.fromCharCode(buf[i] & 0x7f);
  return s;
}
```

- [ ] **Step 4: Port encodeHeader and decodeHeader**

```ts
export function encodeHeader(h: ReplayHeader): Uint8Array {
  const buf = new Uint8Array(HEADER_BYTES);
  const v = dv(buf);
  writeAscii(buf, MAGIC, OFF.magic, 4);
  v.setUint16(OFF.version, h.version, true);
  v.setUint8(OFF.ordinal, h.ordinal);
  v.setUint8(OFF.half, h.half);
  v.setUint8(OFF.playerHz, h.playerHz);
  v.setUint8(OFF.entityHz, h.entityHz);
  writeAscii(buf, h.token, OFF.token, TOKEN_BYTES);
  writeAscii(buf, h.map, OFF.map, MAP_BYTES);
  v.setUint32(OFF.startedUnix, h.startedUnix, true);
  v.setUint32(OFF.indexOffset, h.indexOffset, true);
  v.setUint32(OFF.indexCount, h.indexCount, true);
  v.setUint32(OFF.frameCount, h.frameCount, true);
  for (let i = 0; i < PLAYER_SLOTS; i++) {
    const raw = h.slots[i] ?? '';
    v.setBigUint64(OFF.slots + i * 8, raw === '' ? 0n : BigInt(raw), true);
  }
  return buf;
}

export function decodeHeader(buf: Uint8Array): ReplayHeader | null {
  if (buf.length < HEADER_BYTES) return null;
  if (readAscii(buf, OFF.magic, 4) !== MAGIC) return null;
  const v = dv(buf);
  const slots: string[] = [];
  for (let i = 0; i < PLAYER_SLOTS; i++) {
    const raw = v.getBigUint64(OFF.slots + i * 8, true);
    slots.push(raw === 0n ? '' : raw.toString());
  }
  return {
    version: v.getUint16(OFF.version, true),
    token: readAscii(buf, OFF.token, TOKEN_BYTES),
    ordinal: v.getUint8(OFF.ordinal),
    half: v.getUint8(OFF.half),
    playerHz: v.getUint8(OFF.playerHz),
    entityHz: v.getUint8(OFF.entityHz),
    map: readAscii(buf, OFF.map, MAP_BYTES),
    startedUnix: v.getUint32(OFF.startedUnix, true),
    indexOffset: v.getUint32(OFF.indexOffset, true),
    indexCount: v.getUint32(OFF.indexCount, true),
    frameCount: v.getUint32(OFF.frameCount, true),
    slots,
  };
}
```

- [ ] **Step 5: Port encodeFrame**

```ts
export function encodeFrame(f: Frame): Uint8Array {
  const buf = new Uint8Array(frameBytes(f.entities.length));
  const v = dv(buf);
  v.setUint32(0, f.tMs, true);
  v.setUint16(4, f.entities.length, true);
  for (let slot = 0; slot < PLAYER_SLOTS; slot++) {
    const p = f.players[slot];
    const o = FRAME_HEADER_BYTES + slot * PLAYER_RECORD_BYTES;
    if (!p) continue;
    v.setInt16(o, p.x, true);
    v.setInt16(o + 2, p.y, true);
    v.setInt16(o + 4, p.z, true);
    v.setInt16(o + 6, Math.round(p.yaw * YAW_SCALE), true);
    v.setInt8(o + 8, p.pitch);
    v.setUint8(o + 9, p.state);
    v.setUint16(o + 10, p.health, true);
    v.setUint16(o + 12, p.temp, true);
    v.setUint8(o + 14, p.cls);
    v.setUint8(o + 15, p.weapon);
    v.setUint16(o + 16, p.clip, true);
    v.setUint16(o + 18, p.reserve, true);
  }
  let o = FRAME_HEADER_BYTES + PLAYER_BLOCK_BYTES;
  for (const e of f.entities) {
    v.setUint16(o, e.ref, true);
    v.setUint8(o + 2, e.kind);
    v.setUint8(o + 3, e.state);
    v.setInt16(o + 4, e.x, true);
    v.setInt16(o + 6, e.y, true);
    v.setInt16(o + 8, e.z, true);
    v.setUint16(o + 10, e.health, true);
    o += ENTITY_RECORD_BYTES;
  }
  return buf;
}
```

- [ ] **Step 6: Port decodeFrames, decodeIndex and parseReplay**

In `decodeFrames`, change the signature to `buf: Uint8Array`, add `const v = dv(buf);` at the top, and replace every `buf.readXxxLE(o)` with the DataView equivalent: `buf.readUInt32LE(o)` becomes `v.getUint32(o, true)`, `buf.readUInt16LE(o)` becomes `v.getUint16(o, true)`, `buf.readInt16LE(o)` becomes `v.getInt16(o, true)`, `buf.readUInt8(o)` becomes `v.getUint8(o)`, `buf.readInt8(o)` becomes `v.getInt8(o)`. The loop structure, the bounds checks and the `frames.push({ tMs, players, entities, offset: off })` line are unchanged.

In `decodeIndex`, change the signature to `buf: Uint8Array`, add `const v = dv(buf);`, and replace the two reads with `v.getUint32(o, true)` and `v.getUint32(o + 4, true)`.

In `parseReplay`, change the signature to `buf: Uint8Array`. The body needs no other change.

- [ ] **Step 7: Run the full suite**

Run: `npm test`

Expected: PASS, every test, with no test file edited. If anything fails, the port is wrong. Do not change a test to accommodate it.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`

Expected: clean. `Buffer.concat` accepts `readonly Uint8Array[]`, so the existing test helpers still compile.

- [ ] **Step 9: Commit**

```bash
git add src/replayFormat.ts tests/replayFormat.test.ts
git commit -m "refactor(replay): decode over DataView so the browser can share the parser"
```

---

## Task 2: Reject a future format version

`parseReplay` never checks `header.version`. A version 2 file fed to a version 1 reader decodes as plausible nonsense rather than erroring, which is exactly the failure mode the in-game byte-for-byte verification existed to catch. This must land before Task 14 bumps the version.

**Files:**
- Modify: `src/replayFormat.ts`
- Test: `tests/replayFormat.test.ts`

**Interfaces:**
- Consumes: `decodeHeader`, `parseReplay` from Task 1.
- Produces: `parseReplay` returns `null` for `header.version > VERSION`. `decodeHeader` is unchanged and still reports any version, because callers that only want to know what a file claims to be must still be able to ask.

- [ ] **Step 1: Write the failing tests**

Add to `tests/replayFormat.test.ts`:

```ts
describe('format version', () => {
  it('refuses to parse a file from a newer writer', () => {
    const buf = Buffer.concat([
      encodeHeader(header({ version: VERSION + 1 })),
      encodeFrame(frame({ tMs: 1 })),
    ]);
    expect(parseReplay(buf)).toBeNull();
  });

  it('still parses the current version', () => {
    const buf = Buffer.concat([encodeHeader(header()), encodeFrame(frame({ tMs: 1 }))]);
    expect(parseReplay(buf)?.frames).toHaveLength(1);
  });

  // decodeHeader deliberately does NOT gate on version. Something has to be
  // able to read a newer file's header in order to say "this file is newer
  // than I am" instead of "this file is corrupt", and the browse listing does
  // exactly that.
  it('still reports the version of a newer file through decodeHeader', () => {
    const got = decodeHeader(encodeHeader(header({ version: VERSION + 1 })));
    expect(got?.version).toBe(VERSION + 1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/replayFormat.test.ts -t "newer writer"`

Expected: FAIL. `parseReplay` returns a Replay rather than null.

- [ ] **Step 3: Add the check**

In `src/replayFormat.ts`, in `parseReplay`, directly after the `if (!header) return null;` line:

```ts
  // A newer writer may have changed a record's size or the meaning of a
  // field. Either way the bytes after this header decode into something that
  // looks fine and is wrong, so refusing is the only safe answer. Older
  // versions stay readable: this is a ceiling, not an equality check.
  if (header.version > VERSION) return null;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/replayFormat.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/replayFormat.ts tests/replayFormat.test.ts
git commit -m "fix(replay): refuse to parse a file written by a newer format version"
```

---

## Task 3: Add the weapon id table

The Guns toggle needs weapon ids resolved to names. This mirrors `RplWeaponId` at `plugin/pug-match.sp:1010`. It lives next to `ENTITY_KIND` so the two stay in view of each other.

**Files:**
- Modify: `src/replayFormat.ts`
- Test: `tests/replayFormat.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `WEAPON_NAMES: Record<number, string>` and `weaponName(id: number): string`.

- [ ] **Step 1: Write the failing test**

```ts
describe('weapon names', () => {
  it('names every id the plugin can write', () => {
    expect(weaponName(1)).toBe('Pistol');
    expect(weaponName(5)).toBe('Assault Rifle');
    expect(weaponName(10)).toBe('Pain Pills');
  });

  // 0 is what the plugin writes for an infected player, for a survivor with
  // no active weapon, and for any classname it does not recognise. All three
  // mean "nothing to show" rather than an error.
  it('gives an empty name for id 0 and for an unknown id', () => {
    expect(weaponName(0)).toBe('');
    expect(weaponName(200)).toBe('');
  });
});
```

Add `WEAPON_NAMES, weaponName` to the import list at the top of the test file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/replayFormat.test.ts -t "weapon names"`

Expected: FAIL with an import or reference error.

- [ ] **Step 3: Implement**

Add to `src/replayFormat.ts`, immediately after the `ENTITY_KIND` block:

```ts
/** Weapon ids as the plugin assigns them in `RplWeaponId`
 *  (`plugin/pug-match.sp:1010`). This is a second copy of that mapping, which
 *  is a cost worth paying here and nowhere else in this format: a wrong
 *  weapon name is visibly wrong on screen, whereas a wrong byte offset
 *  decodes into plausible nonsense. Keep it adjacent to ENTITY_KIND so a
 *  change to one is made in sight of the other. */
export const WEAPON_NAMES: Record<number, string> = {
  1: 'Pistol',
  2: 'SMG',
  3: 'Pump Shotgun',
  4: 'Auto Shotgun',
  5: 'Assault Rifle',
  6: 'Hunting Rifle',
  7: 'Pipe Bomb',
  8: 'Molotov',
  9: 'First Aid Kit',
  10: 'Pain Pills',
};

export function weaponName(id: number): string {
  return WEAPON_NAMES[id] ?? '';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/replayFormat.test.ts -t "weapon names"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/replayFormat.ts tests/replayFormat.test.ts
git commit -m "feat(replay): name the ten weapon ids the plugin records"
```

---

## Task 4: Compute the releasable byte cutoff

`releasableFrames()` decides which frames may be sent. The HTTP layer needs that decision expressed in bytes so it can truncate a response without re-deriving the rule. `Frame.offset` is already filled in by the decoder, so this is arithmetic on top of the tested function rather than a second implementation of the rule.

**Files:**
- Modify: `src/replayTail.ts`
- Test: `tests/replayTail.test.ts`

**Interfaces:**
- Consumes: `releasableFrames`, `DEFAULT_DELAY_MS` from `src/replayTail.ts`; `Frame`, `frameBytes` from `src/replayFormat.ts`.
- Produces: `releasableBytes(frames: Frame[], roundStartedUnixMs: number, nowMs: number, delayMs?: number): number` - the byte offset one past the last releasable frame, or `0` when none of these frames may be sent yet.

- [ ] **Step 1: Write the failing test**

Add to `tests/replayTail.test.ts`. Check the top of that file for how it already builds frames and reuse those helpers if they exist; otherwise add this one:

```ts
import { releasableBytes } from '../src/replayTail.js';
import { HEADER_BYTES, PLAYER_SLOTS, frameBytes, type Frame } from '../src/replayFormat.js';

function frameAt(tMs: number, offset: number, entities = 0): Frame {
  return {
    tMs,
    offset,
    players: Array.from({ length: PLAYER_SLOTS }, (_, slot) => ({
      slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0,
      health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0,
    })),
    entities: Array.from({ length: entities }, (_, i) => ({
      ref: i, kind: 1, state: 0, x: 0, y: 0, z: 0, health: 0,
    })),
  };
}

describe('releasableBytes', () => {
  const started = 1_800_000_000_000;

  it('returns the offset one past the last releasable frame', () => {
    // Two frames with no entities, laid out as the writer would lay them out.
    const a = frameAt(0, HEADER_BYTES);
    const b = frameAt(1000, HEADER_BYTES + frameBytes(0));
    // 20 seconds after the round started, both frames are older than the
    // 10 second delay.
    const got = releasableBytes([a, b], started, started + 20_000);
    expect(got).toBe(HEADER_BYTES + frameBytes(0) * 2);
  });

  it('accounts for a frame carrying entities, which is longer', () => {
    const a = frameAt(0, HEADER_BYTES, 5);
    const got = releasableBytes([a], started, started + 20_000);
    expect(got).toBe(HEADER_BYTES + frameBytes(5));
  });

  it('stops at the cutoff rather than at the end of the array', () => {
    const a = frameAt(0, HEADER_BYTES);
    const b = frameAt(19_000, HEADER_BYTES + frameBytes(0));
    // Now is 20s in, so the cutoff is t=10000. Frame b at t=19000 is inside
    // the delay window and must not be released.
    const got = releasableBytes([a, b], started, started + 20_000);
    expect(got).toBe(HEADER_BYTES + frameBytes(0));
  });

  it('returns 0 when nothing may be released yet', () => {
    const a = frameAt(19_000, HEADER_BYTES);
    expect(releasableBytes([a], started, started + 20_000)).toBe(0);
  });

  it('returns 0 for an unknown round start, matching releasableFrames', () => {
    const a = frameAt(0, HEADER_BYTES);
    expect(releasableBytes([a], 0, started + 20_000)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/replayTail.test.ts -t "releasableBytes"`

Expected: FAIL, `releasableBytes` is not exported.

- [ ] **Step 3: Implement**

Add to `src/replayTail.ts`. It needs a value import now, not only a type import, so change the existing import line to `import { frameBytes, type Frame } from './replayFormat.js';`.

```ts
/**
 * The same decision as `releasableFrames`, expressed in bytes.
 *
 * The HTTP layer serves a prefix of the file rather than re-encoding frames,
 * so it needs the cutoff as an offset. Deriving it here from the frames
 * `releasableFrames` already approved is what keeps the delay rule in one
 * place: there is no second condition that could drift from the first.
 *
 * Returns 0, not the header size, when nothing is releasable. The caller
 * knows what floor it scanned from and 0 lets it say so; returning
 * HEADER_BYTES would be wrong for a caller that started mid-file.
 */
export function releasableBytes(
  frames: Frame[],
  roundStartedUnixMs: number,
  nowMs: number,
  delayMs: number = DEFAULT_DELAY_MS,
): number {
  const ok = releasableFrames(frames, roundStartedUnixMs, nowMs, delayMs);
  if (ok.length === 0) return 0;
  const last = ok[ok.length - 1];
  return last.offset + frameBytes(last.entities.length);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/replayTail.test.ts`

Expected: PASS, including the pre-existing `releasableFrames` tests.

- [ ] **Step 5: Commit**

```bash
git add src/replayTail.ts tests/replayTail.test.ts
git commit -m "feat(replay): express the release cutoff as a byte offset"
```

---

## Task 5: Discover replay sessions on disk

Standalone `!mix` files have no `match_replays` row, so they can only be found by listing the directory. The same listing answers which file is the live round for a token. Reading the 160 byte header is enough for all of it, and a full parse of a 15 MB file is not acceptable for a listing.

**Files:**
- Create: `src/replaySessions.ts`
- Test: `tests/replaySessions.test.ts`

**Interfaces:**
- Consumes: `decodeHeader`, `HEADER_BYTES` from `src/replayFormat.ts`.
- Produces:
  - `interface ReplayFileInfo { filename: string; token: string; ordinal: number; half: number; bytes: number; mtimeMs: number; map: string; startedUnix: number; frameCount: number; playerHz: number; version: number; closed: boolean }`
  - `interface ReplaySession { token: string; startedUnix: number; files: ReplayFileInfo[] }`
  - `CLOSED_AFTER_IDLE_MS: number`
  - `listSessions(dir: string, nowMs: number): ReplaySession[]`
  - `currentFileFor(dir: string, token: string, nowMs: number): ReplayFileInfo | null`
  - `resolveByName(dir: string, filename: string, nowMs: number): { path: string; info: ReplayFileInfo } | null`

- [ ] **Step 1: Write the failing test**

Create `tests/replaySessions.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listSessions, currentFileFor, resolveByName, CLOSED_AFTER_IDLE_MS,
} from '../src/replaySessions.js';
import { encodeHeader, encodeFrame, VERSION, HEADER_BYTES, PLAYER_SLOTS,
  type ReplayHeader, type Frame } from '../src/replayFormat.js';

const TOKEN_A = 'a'.repeat(32);
const TOKEN_B = 'b'.repeat(32);
const NOW = 1_800_000_000_000;

function header(over: Partial<ReplayHeader> = {}): ReplayHeader {
  return {
    version: VERSION, token: TOKEN_A, ordinal: 0, half: 1,
    playerHz: 10, entityHz: 10, map: 'l4d_vs_farm01_hilltop',
    startedUnix: 1_785_956_274, indexOffset: 0, indexCount: 0, frameCount: 0,
    slots: ['', '', '', '', '', '', '', ''],
    ...over,
  };
}

function emptyFrame(tMs: number): Frame {
  return {
    tMs, offset: 0,
    players: Array.from({ length: PLAYER_SLOTS }, (_, slot) => ({
      slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0,
      health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0,
    })),
    entities: [],
  };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rpl-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function write(name: string, h: ReplayHeader, mtimeMs = NOW): void {
  const path = join(dir, name);
  writeFileSync(path, Buffer.concat([encodeHeader(h), encodeFrame(emptyFrame(0))]));
  const secs = mtimeMs / 1000;
  utimesSync(path, secs, secs);
}

describe('listSessions', () => {
  it('groups files by token and sorts files by ordinal then half', () => {
    write(`pug_${TOKEN_A}_1_2.rpl`, header({ ordinal: 1, half: 2 }));
    write(`pug_${TOKEN_A}_0_1.rpl`, header({ ordinal: 0, half: 1 }));
    write(`pug_${TOKEN_B}_0_1.rpl`, header({ token: TOKEN_B }));

    const sessions = listSessions(dir, NOW);
    expect(sessions).toHaveLength(2);
    const a = sessions.find((s) => s.token === TOKEN_A)!;
    expect(a.files.map((f) => [f.ordinal, f.half])).toEqual([[0, 1], [1, 2]]);
  });

  it('ignores files that are not replays', () => {
    write(`pug_${TOKEN_A}_0_1.rpl`, header());
    writeFileSync(join(dir, 'notes.txt'), 'hello');
    writeFileSync(join(dir, `pug_${TOKEN_A}_0_1.dem`), 'demo');
    expect(listSessions(dir, NOW)).toHaveLength(1);
  });

  it('treats a file with a patched frame count as closed', () => {
    write(`pug_${TOKEN_A}_0_1.rpl`, header({ frameCount: 900 }));
    expect(listSessions(dir, NOW)[0].files[0].closed).toBe(true);
  });

  it('treats an untouched file as closed once it has gone idle', () => {
    // frameCount 0 means the writer never closed it. A crashed recording
    // would otherwise be treated as live and delayed forever.
    write(`pug_${TOKEN_A}_0_1.rpl`, header({ frameCount: 0 }), NOW - CLOSED_AFTER_IDLE_MS - 1);
    expect(listSessions(dir, NOW)[0].files[0].closed).toBe(true);
  });

  it('treats a recently written file with no frame count as open', () => {
    write(`pug_${TOKEN_A}_0_1.rpl`, header({ frameCount: 0 }), NOW - 1000);
    expect(listSessions(dir, NOW)[0].files[0].closed).toBe(false);
  });

  it('returns nothing for a missing directory rather than throwing', () => {
    expect(listSessions(join(dir, 'nope'), NOW)).toEqual([]);
  });

  it('returns nothing when no directory is configured', () => {
    expect(listSessions('', NOW)).toEqual([]);
  });
});

describe('currentFileFor', () => {
  it('picks the highest ordinal and half for the token', () => {
    write(`pug_${TOKEN_A}_0_1.rpl`, header({ ordinal: 0, half: 1 }));
    write(`pug_${TOKEN_A}_1_1.rpl`, header({ ordinal: 1, half: 1 }));
    write(`pug_${TOKEN_A}_1_2.rpl`, header({ ordinal: 1, half: 2 }));
    const got = currentFileFor(dir, TOKEN_A, NOW);
    expect(got?.filename).toBe(`pug_${TOKEN_A}_1_2.rpl`);
  });

  it('returns null for an unknown token', () => {
    expect(currentFileFor(dir, TOKEN_B, NOW)).toBeNull();
  });

  it('returns null for a token that is not 32 hex characters', () => {
    expect(currentFileFor(dir, '../../etc/passwd', NOW)).toBeNull();
  });
});

describe('resolveByName', () => {
  it('resolves a well formed name', () => {
    write(`pug_${TOKEN_A}_0_1.rpl`, header());
    const got = resolveByName(dir, `pug_${TOKEN_A}_0_1.rpl`, NOW);
    expect(got?.path).toBe(join(dir, `pug_${TOKEN_A}_0_1.rpl`));
  });

  it('refuses a traversal attempt', () => {
    expect(resolveByName(dir, '../../../etc/passwd', NOW)).toBeNull();
    expect(resolveByName(dir, `../pug_${TOKEN_A}_0_1.rpl`, NOW)).toBeNull();
  });

  it('refuses a name that does not match the replay pattern', () => {
    writeFileSync(join(dir, 'evil.rpl'), 'x');
    expect(resolveByName(dir, 'evil.rpl', NOW)).toBeNull();
  });

  it('returns null for a name that matches but is not on disk', () => {
    expect(resolveByName(dir, `pug_${TOKEN_B}_0_1.rpl`, NOW)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/replaySessions.test.ts`

Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement**

Create `src/replaySessions.ts`:

```ts
import { readdirSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { decodeHeader, HEADER_BYTES } from './replayFormat.js';

const TOKEN_RE = /^[0-9a-f]{32}$/;
const NAME_RE = /^pug_([0-9a-f]{32})_(\d+)_([12])\.rpl$/;

/**
 * How long a file with no patched frame count may sit untouched before it is
 * treated as finished.
 *
 * `frameCount` is patched into the header when the writer closes, so 0 means
 * "never closed", which is true both of a round in progress and of a
 * recording the game server died in the middle of. Without this, a crashed
 * file would be treated as live forever and held behind the delay forever.
 * The recorder writes at 10Hz, so a minute of silence is four orders of
 * magnitude past normal.
 */
export const CLOSED_AFTER_IDLE_MS = 60_000;

export interface ReplayFileInfo {
  filename: string;
  token: string;
  ordinal: number;
  half: number;
  bytes: number;
  mtimeMs: number;
  map: string;
  startedUnix: number;
  frameCount: number;
  playerHz: number;
  version: number;
  /** True when this file is history and may be served whole. False means it
   *  is still being written, and every byte handed out must go through the
   *  anti-ghosting cutoff. */
  closed: boolean;
}

export interface ReplaySession {
  token: string;
  /** Earliest `startedUnix` across the session's files, in seconds. */
  startedUnix: number;
  files: ReplayFileInfo[];
}

/** Read just the header. A replay runs to 15 MB and a listing shows dozens,
 *  so parsing one to learn its map name is not an option. */
function readInfo(dir: string, filename: string, nowMs: number): ReplayFileInfo | null {
  const m = NAME_RE.exec(filename);
  if (!m) return null;
  const path = join(dir, filename);

  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;

  const buf = new Uint8Array(HEADER_BYTES);
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const read = readSync(fd, buf, 0, HEADER_BYTES, 0);
    if (read < HEADER_BYTES) return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }

  const h = decodeHeader(buf);
  if (!h) return null;

  return {
    filename,
    token: m[1],
    ordinal: Number(m[2]),
    half: Number(m[3]),
    bytes: st.size,
    mtimeMs: st.mtimeMs,
    map: h.map,
    startedUnix: h.startedUnix,
    frameCount: h.frameCount,
    playerHz: h.playerHz,
    version: h.version,
    closed: h.frameCount !== 0 || nowMs - st.mtimeMs > CLOSED_AFTER_IDLE_MS,
  };
}

/** Every replay on disk, grouped by the session token in its filename.
 *
 *  Never throws. A missing or unreadable directory yields no sessions,
 *  because a browse page returning empty is a far better failure than a
 *  browse page returning 500. */
export function listSessions(dir: string, nowMs: number): ReplaySession[] {
  if (!dir) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const byToken = new Map<string, ReplayFileInfo[]>();
  for (const name of names) {
    const info = readInfo(dir, name, nowMs);
    if (!info) continue;
    const list = byToken.get(info.token);
    if (list) list.push(info);
    else byToken.set(info.token, [info]);
  }

  const out: ReplaySession[] = [];
  for (const [token, files] of byToken) {
    files.sort((a, b) => a.ordinal - b.ordinal || a.half - b.half);
    out.push({
      token,
      startedUnix: Math.min(...files.map((f) => f.startedUnix)),
      files,
    });
  }
  // Newest session first, which is what someone opening the page wants.
  out.sort((a, b) => b.startedUnix - a.startedUnix);
  return out;
}

/** The file a live viewer should be reading for this token: the newest round.
 *
 *  Ordinal then half, not mtime. A map change writes a new file while the old
 *  one may still be flushing, and ordering by modification time would flip
 *  back to the previous round for as long as that takes. */
export function currentFileFor(
  dir: string, token: string, nowMs: number,
): ReplayFileInfo | null {
  if (!dir || !TOKEN_RE.test(token)) return null;
  const session = listSessions(dir, nowMs).find((s) => s.token === token);
  if (!session || session.files.length === 0) return null;
  return session.files[session.files.length - 1];
}

/**
 * Resolve an untrusted filename to a path inside the replay directory.
 *
 * This mirrors `resolveReplayPath`'s hardening in `src/replays.ts` and for a
 * stronger reason: that function's name comes from a database row this
 * process wrote, and this one's comes from a URL. A name that goes into a
 * file read is exactly the shape of bug that turns a crafted request into
 * arbitrary file disclosure, so the pattern, the basename check and the
 * resolved-prefix check are all load-bearing rather than belt and braces.
 */
export function resolveByName(
  dir: string, filename: string, nowMs: number,
): { path: string; info: ReplayFileInfo } | null {
  if (!dir) return null;
  if (filename !== basename(filename)) return null;
  if (!NAME_RE.test(filename)) return null;

  const root = resolve(dir);
  const path = resolve(root, filename);
  if (path !== join(root, filename)) return null;
  if (!path.startsWith(root + '/')) return null;

  const info = readInfo(dir, filename, nowMs);
  if (!info) return null;
  return { path, info };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/replaySessions.test.ts`

Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/replaySessions.ts tests/replaySessions.test.ts
git commit -m "feat(replay): discover sessions and files by scanning the replay directory"
```

---

## Task 6: Serve replay bytes over HTTP

Four routes. The one invariant that keeps them all honest: a closed file streams whole with no parse, and an open file is truncated at the releasable cutoff.

**Files:**
- Create: `src/routes/replays.ts`
- Modify: `src/server.ts`
- Test: `tests/replayRoutes.test.ts`

**Interfaces:**
- Consumes: `listSessions`, `currentFileFor`, `resolveByName`, `ReplayFileInfo` from `src/replaySessions.ts`; `resolveReplayPath` from `src/replays.ts`; `releasableBytes` from `src/replayTail.ts`; `decodeHeader`, `decodeFrames`, `HEADER_BYTES` from `src/replayFormat.ts`.
- Produces: `replayRoutes(app: FastifyInstance, opts: { db: DB; replayDir: string }): Promise<void>`, registered in `src/server.ts`. Routes:
  - `GET /api/replays/sessions` returns `{ sessions: ReplaySession[] }`
  - `GET /api/replays/live/:token` returns `{ filename: string; closed: boolean }` or 404
  - `GET /api/replays/file/:name?since=N` returns bytes
  - `GET /api/replays/match/:id/:ordinal/:half?since=N` returns bytes
  - Byte responses carry `X-Replay-Next` (the offset to pass as `since` next time) and `X-Replay-Closed` (`1` or `0`).

- [ ] **Step 1: Write the failing test**

Create `tests/replayRoutes.test.ts`. Look at `tests/stats.test.ts` first for how this codebase builds an app instance for route tests and follow that pattern for the `buildApp` helper; the assertions below are what matter.

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { replayRoutes } from '../src/routes/replays.js';
import { openDb } from '../src/db.js';
import {
  encodeHeader, encodeFrame, decodeHeader, VERSION, HEADER_BYTES,
  PLAYER_SLOTS, frameBytes, type ReplayHeader, type Frame,
} from '../src/replayFormat.js';

const TOKEN = 'a'.repeat(32);

function header(over: Partial<ReplayHeader> = {}): ReplayHeader {
  return {
    version: VERSION, token: TOKEN, ordinal: 0, half: 1,
    playerHz: 10, entityHz: 10, map: 'l4d_vs_farm01_hilltop',
    startedUnix: Math.floor(Date.now() / 1000) - 600,
    indexOffset: 0, indexCount: 0, frameCount: 0,
    slots: ['', '', '', '', '', '', '', ''],
    ...over,
  };
}

function emptyFrame(tMs: number): Frame {
  return {
    tMs, offset: 0,
    players: Array.from({ length: PLAYER_SLOTS }, (_, slot) => ({
      slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0,
      health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0,
    })),
    entities: [],
  };
}

let dir: string;
let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rplroutes-'));
  app = Fastify();
  await app.register(replayRoutes, { db: openDb(':memory:'), replayDir: dir });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Write a file whose frames run from t=0 at `startedSecondsAgo` seconds ago,
 *  one frame per second, so the delay cutoff is easy to reason about. */
function writeRound(name: string, frames: number, startedSecondsAgo: number, closed: boolean): void {
  const parts: Uint8Array[] = [
    encodeHeader(header({
      startedUnix: Math.floor(Date.now() / 1000) - startedSecondsAgo,
      frameCount: closed ? frames : 0,
    })),
  ];
  for (let i = 0; i < frames; i++) parts.push(encodeFrame(emptyFrame(i * 1000)));
  const path = join(dir, name);
  writeFileSync(path, Buffer.concat(parts));
  const secs = Date.now() / 1000;
  utimesSync(path, secs, secs);
}

describe('GET /api/replays/sessions', () => {
  it('lists sessions grouped by token', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    const res = await app.inject({ url: '/api/replays/sessions' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sessions: { token: string; files: unknown[] }[] };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].token).toBe(TOKEN);
  });
});

describe('GET /api/replays/file/:name', () => {
  it('serves a closed file whole', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    const res = await app.inject({ url: `/api/replays/file/pug_${TOKEN}_0_1.rpl` });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(HEADER_BYTES + frameBytes(0) * 5);
    expect(res.headers['x-replay-closed']).toBe('1');
  });

  it('serves only the bytes after `since`', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    const since = HEADER_BYTES + frameBytes(0) * 2;
    const res = await app.inject({ url: `/api/replays/file/pug_${TOKEN}_0_1.rpl?since=${since}` });
    expect(res.rawPayload.length).toBe(frameBytes(0) * 3);
    expect(res.headers['x-replay-next']).toBe(String(HEADER_BYTES + frameBytes(0) * 5));
  });

  // THE test. Everything else in this file is plumbing; this is the security
  // model of a public live page. The round started 15 seconds ago and has 15
  // frames at one per second, so frames t=0..4 are older than the 10 second
  // delay and frames t=5..14 are not.
  it('never serves a byte past the cutoff for an open file', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 15, 15, false);
    const res = await app.inject({ url: `/api/replays/file/pug_${TOKEN}_0_1.rpl` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-replay-closed']).toBe('0');

    const served = res.rawPayload.length;
    const whole = HEADER_BYTES + frameBytes(0) * 15;
    expect(served).toBeLessThan(whole);
    // At most six frames: the five certainly outside the window, plus one for
    // the second that may have ticked over between writing and serving.
    const frames = (served - HEADER_BYTES) / frameBytes(0);
    expect(frames).toBeGreaterThanOrEqual(4);
    expect(frames).toBeLessThanOrEqual(6);
  });

  it('serves the header alone when no frame is old enough yet', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 3, 2, false);
    const res = await app.inject({ url: `/api/replays/file/pug_${TOKEN}_0_1.rpl` });
    expect(res.rawPayload.length).toBe(HEADER_BYTES);
    expect(decodeHeader(res.rawPayload)?.token).toBe(TOKEN);
  });

  it('404s a traversal attempt', async () => {
    const res = await app.inject({ url: '/api/replays/file/..%2F..%2Fetc%2Fpasswd' });
    expect(res.statusCode).toBe(404);
  });

  it('404s an unknown file', async () => {
    const res = await app.inject({ url: `/api/replays/file/pug_${'b'.repeat(32)}_0_1.rpl` });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/replays/live/:token', () => {
  it('names the newest file for the token', async () => {
    writeRound(`pug_${TOKEN}_0_1.rpl`, 5, 600, true);
    writeRound(`pug_${TOKEN}_1_1.rpl`, 5, 60, false);
    const res = await app.inject({ url: `/api/replays/live/${TOKEN}` });
    expect(res.json()).toEqual({ filename: `pug_${TOKEN}_1_1.rpl`, closed: false });
  });

  it('404s an unknown token', async () => {
    const res = await app.inject({ url: `/api/replays/live/${'c'.repeat(32)}` });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/replayRoutes.test.ts`

Expected: FAIL, `src/routes/replays.ts` does not exist.

- [ ] **Step 3: Implement the routes**

Create `src/routes/replays.ts`:

```ts
import { readFileSync, createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DB } from '../db.js';
import { listSessions, currentFileFor, resolveByName, type ReplayFileInfo } from '../replaySessions.js';
import { resolveReplayPath } from '../replays.js';
import { releasableBytes } from '../replayTail.js';
import { decodeFrames, decodeHeader, HEADER_BYTES } from '../replayFormat.js';

/** How long a computed cutoff is reused.
 *
 *  Finding the cutoff for an open file means decoding frames, and the first
 *  request from any viewer decodes the whole file. Several people opening the
 *  live page within the same second would otherwise each pay for that scan.
 *  One second is shorter than the poll interval, so nobody ever sees a stale
 *  cutoff, and it is enough to collapse a thundering herd into one scan. */
const CUTOFF_TTL_MS = 1000;

interface CutoffEntry { at: number; size: number; mtimeMs: number; cutoff: number }
const cutoffCache = new Map<string, CutoffEntry>();

/**
 * How many bytes of this file may be sent right now.
 *
 * A closed file is history: every byte of it is older than any delay could
 * care about, so it is served whole and never parsed. That matters for more
 * than tidiness, because a finished round runs to 15 MB and parsing it to
 * answer a download would be absurd.
 *
 * An open file is live. Its newest frames carry ghost infected positions on a
 * page anyone can open, so the cutoff is not optional.
 */
function cutoffFor(path: string, info: ReplayFileInfo, nowMs: number): number {
  if (info.closed) return info.bytes;

  const hit = cutoffCache.get(path);
  if (hit && nowMs - hit.at < CUTOFF_TTL_MS && hit.size === info.bytes && hit.mtimeMs === info.mtimeMs) {
    return hit.cutoff;
  }

  const buf = readFileSync(path);
  const header = decodeHeader(buf);
  // An unreadable header means we cannot know when the round started, and
  // without that the delay cannot be computed. Release nothing.
  if (!header) return 0;

  const { frames } = decodeFrames(buf, HEADER_BYTES, buf.length);
  const released = releasableBytes(frames, header.startedUnix * 1000, nowMs);
  // Zero releasable frames still means the header may go out: the client
  // needs the map name and the slot roster before it can render anything,
  // and the header carries no positions.
  const cutoff = released === 0 ? HEADER_BYTES : released;

  cutoffCache.set(path, { at: nowMs, size: info.bytes, mtimeMs: info.mtimeMs, cutoff });
  return cutoff;
}

function sendSlice(
  reply: FastifyReply, path: string, info: ReplayFileInfo, since: number, nowMs: number,
): FastifyReply {
  const cutoff = cutoffFor(path, info, nowMs);
  const start = Number.isFinite(since) && since > 0 ? Math.min(since, cutoff) : 0;

  reply.header('Content-Type', 'application/octet-stream');
  reply.header('Cache-Control', 'no-store');
  reply.header('X-Replay-Next', String(cutoff));
  reply.header('X-Replay-Closed', info.closed ? '1' : '0');
  reply.header('Content-Length', String(Math.max(0, cutoff - start)));

  if (cutoff <= start) return reply.send(Buffer.alloc(0));
  // `end` is inclusive for createReadStream, so subtract one. Streaming
  // rather than buffering matters for the closed case, where this is a
  // multi-megabyte download.
  return reply.send(createReadStream(path, { start, end: cutoff - 1 }));
}

export async function replayRoutes(
  app: FastifyInstance, opts: { db: DB; replayDir: string },
): Promise<void> {
  const { db, replayDir } = opts;

  app.get('/api/replays/sessions', async () => ({
    sessions: listSessions(replayDir, Date.now()),
  }));

  app.get('/api/replays/live/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const info = currentFileFor(replayDir, token, Date.now());
    if (!info) return reply.code(404).send({ error: 'no replay for that token' });
    return { filename: info.filename, closed: info.closed };
  });

  app.get('/api/replays/file/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const { since } = req.query as { since?: string };
    const now = Date.now();
    const found = resolveByName(replayDir, name, now);
    if (!found) return reply.code(404).send({ error: 'no such replay' });
    return sendSlice(reply, found.path, found.info, Number(since ?? 0), now);
  });

  app.get('/api/replays/match/:id/:ordinal/:half', async (req, reply) => {
    const { id, ordinal, half } = req.params as { id: string; ordinal: string; half: string };
    const { since } = req.query as { since?: string };
    const now = Date.now();
    const row = resolveReplayPath(db, Number(id), Number(ordinal), Number(half), replayDir);
    if (!row) return reply.code(404).send({ error: 'no such replay' });
    // Go back through the by-name resolver rather than trusting the row's
    // path directly, because that is what knows whether the file is still
    // being written. A match's current map is live too.
    const found = resolveByName(replayDir, row.filename, now);
    if (!found) return reply.code(404).send({ error: 'no such replay' });
    return sendSlice(reply, found.path, found.info, Number(since ?? 0), now);
  });
}
```

- [ ] **Step 4: Register the routes**

In `src/server.ts`, add the import next to the other route imports:

```ts
import { replayRoutes } from './routes/replays.js';
```

and register it next to `statsRoutes`, around line 289:

```ts
  await app.register(replayRoutes, { db: deps.db, replayDir: deps.config.replayDir });
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/replayRoutes.test.ts`

Expected: PASS, all cases, including the cutoff test.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`

Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add src/routes/replays.ts src/server.ts tests/replayRoutes.test.ts
git commit -m "feat(replay): serve replay bytes, delayed while a round is still recording"
```

---

## Task 7: The world-to-image transform table

Positions in a replay are raw world units. Turning them into pixels is a per-map constant, which is a data table rather than code. Valve ships the numbers for ten maps in `mapinfo.res`; every other map auto-fits from the replay's own bounds.

Map names in a versus match carry a `vs_` infix (`l4d_vs_farm01_hilltop`) which `mapinfo.res` does not (`l4d_farm01_hilltop`). Normalising that is the difference between ten calibrated maps and zero.

**Files:**
- Create: `src/mapTransform.ts`
- Test: `tests/mapTransform.test.ts`

**Interfaces:**
- Consumes: nothing. This module has no imports, which is what keeps it importable from the browser.
- Produces:
  - `interface MapTransform { originX: number; originY: number; unitsPerPixel: number; image: string | null; width: number; height: number }`
  - `interface WorldBounds { minX: number; maxX: number; minY: number; maxY: number }`
  - `normalizeMapName(map: string): string`
  - `transformFor(map: string): MapTransform | null`
  - `autoFitTransform(bounds: WorldBounds, width: number, height: number, padFraction?: number): MapTransform`
  - `worldToImage(t: MapTransform, x: number, y: number): { px: number; py: number }`
  - `boundsOf(points: { x: number; y: number }[]): WorldBounds | null`

- [ ] **Step 1: Write the failing test**

Create `tests/mapTransform.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  normalizeMapName, transformFor, autoFitTransform, worldToImage, boundsOf,
} from '../src/mapTransform.js';

describe('normalizeMapName', () => {
  it('strips the versus infix so a vs map finds its overview', () => {
    expect(normalizeMapName('l4d_vs_farm01_hilltop')).toBe('l4d_farm01_hilltop');
  });

  it('leaves a coop map name alone', () => {
    expect(normalizeMapName('l4d_farm01_hilltop')).toBe('l4d_farm01_hilltop');
  });

  it('lowercases, because the header is whatever the engine reported', () => {
    expect(normalizeMapName('L4D_VS_Farm01_Hilltop')).toBe('l4d_farm01_hilltop');
  });
});

describe('transformFor', () => {
  it('finds the Valve numbers for a versus map', () => {
    const t = transformFor('l4d_vs_farm01_hilltop')!;
    expect(t.originX).toBe(-13730);
    expect(t.originY).toBe(-6299);
    expect(t.unitsPerPixel).toBe(9);
    expect(t.image).toBe('/overviews/l4d_farm01_hilltop.png');
  });

  it('returns null for a map with no overview', () => {
    expect(transformFor('l4d_vs_hospital01_apartment')).toBeNull();
  });
});

describe('worldToImage', () => {
  it('puts the origin corner at pixel 0,0', () => {
    const t = transformFor('l4d_farm01_hilltop')!;
    expect(worldToImage(t, -13730, -6299)).toEqual({ px: 0, py: 0 });
  });

  // y is flipped: mapinfo's y is the UPPER-left corner, and world y grows
  // north while image y grows down.
  it('flips the y axis', () => {
    const t = transformFor('l4d_farm01_hilltop')!;
    const got = worldToImage(t, -13730, -6299 - 900);
    expect(got.px).toBe(0);
    expect(got.py).toBe(100);
  });

  it('scales x by units per pixel', () => {
    const t = transformFor('l4d_farm01_hilltop')!;
    expect(worldToImage(t, -13730 + 900, -6299).px).toBe(100);
  });
});

describe('boundsOf', () => {
  it('finds the extent of the points', () => {
    expect(boundsOf([{ x: 1, y: 5 }, { x: -3, y: 2 }, { x: 7, y: 9 }]))
      .toEqual({ minX: -3, maxX: 7, minY: 2, maxY: 9 });
  });

  it('returns null for no points', () => {
    expect(boundsOf([])).toBeNull();
  });
});

describe('autoFitTransform', () => {
  it('fits a wide world into the canvas without distorting it', () => {
    // 2000 wide, 1000 tall, into a 500x500 canvas. The wide axis governs.
    const t = autoFitTransform({ minX: 0, maxX: 2000, minY: 0, maxY: 1000 }, 500, 500, 0);
    expect(t.unitsPerPixel).toBe(4);
    // Both axes share one scale, which is what keeps pixels square.
    const a = worldToImage(t, 0, 1000);
    const b = worldToImage(t, 2000, 1000);
    expect(b.px - a.px).toBe(500);
  });

  it('centres the fitted world on the short axis', () => {
    const t = autoFitTransform({ minX: 0, maxX: 2000, minY: 0, maxY: 1000 }, 500, 500, 0);
    // The world is 1000 tall at 4 units per pixel, so 250px of a 500px
    // canvas, leaving 125px of margin above and below.
    expect(worldToImage(t, 0, 1000).py).toBe(125);
    expect(worldToImage(t, 0, 0).py).toBe(375);
  });

  it('has no image', () => {
    const t = autoFitTransform({ minX: 0, maxX: 100, minY: 0, maxY: 100 }, 500, 500);
    expect(t.image).toBeNull();
  });

  it('survives a degenerate world where every point is the same', () => {
    const t = autoFitTransform({ minX: 10, maxX: 10, minY: 10, maxY: 10 }, 500, 500);
    expect(Number.isFinite(t.unitsPerPixel)).toBe(true);
    expect(t.unitsPerPixel).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mapTransform.test.ts`

Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement**

Create `src/mapTransform.ts`. The ten entries are copied verbatim from `left4dead/resource/overviews/mapinfo.res`.

```ts
/**
 * Where a world position lands on a map image.
 *
 * This is a data table on purpose. Adding No Mercy later is a row and a PNG,
 * not a code change, and no replay ever needs re-recording because positions
 * are stored as raw world units rather than pixels.
 *
 * It also replaces the manual calibration panel suprep's viewer carries.
 * `cl_leveloverview` prints the origin and the scale on the console, and
 * Valve's own mapinfo.res stores exactly those numbers, so there is nothing
 * to eyeball.
 *
 * This module has no imports, deliberately. It is loaded by the browser as
 * well as the server, and a relative `.js` specifier would break the bundler.
 */

export interface MapTransform {
  /** World x of the image's left edge. */
  originX: number;
  /** World y of the image's TOP edge. World y grows north, image y grows
   *  down, which is why projection subtracts in the other direction. */
  originY: number;
  unitsPerPixel: number;
  /** Web path to the backdrop, or null when there is no art and the viewer
   *  should draw a grid and a trail instead. */
  image: string | null;
  width: number;
  height: number;
}

export interface WorldBounds {
  minX: number; maxX: number; minY: number; maxY: number;
}

/** Valve's shipped overviews. `x` and `y` are the upper-left world corner and
 *  `scale` is world units per pixel at the 1024 pixel height their BMPs use.
 *  Straight out of `left4dead/resource/overviews/mapinfo.res`. */
const VALVE: Record<string, { x: number; y: number; scale: number }> = {
  l4d_farm01_hilltop: { x: -13730, y: -6299, scale: 9.0 },
  l4d_farm02_traintunnel: { x: -9279, y: -4779, scale: 8.5 },
  l4d_farm03_bridge: { x: -353, y: -8921, scale: 10.0 },
  l4d_farm04_barn: { x: 6693, y: -241, scale: 11.0 },
  l4d_farm05_cornfield: { x: 5769, y: 4893, scale: 6.0 },
  l4d_smalltown01_caves: { x: -17459, y: -3809, scale: 12.0 },
  l4d_smalltown02_drainage: { x: -11784, y: -3090, scale: 6.0 },
  l4d_smalltown03_ranchhouse: { x: -12920, y: 2506, scale: 10.5 },
  l4d_smalltown04_mainstreet: { x: -5900, y: 1620, scale: 10.0 },
  l4d_smalltown05_houseboat: { x: -3400, y: 4820, scale: 10.0 },
};

/** The pixel height Valve's `scale` assumes. Their BMPs are 1024x1024, so for
 *  those the correction below is a no-op. It is written out anyway because a
 *  `cl_leveloverview` capture at any other height is the expected way new maps
 *  arrive, and at that point units per pixel is `1024 * scale / height` on
 *  both axes. Pixels stay square either way: a non-square capture is a wider
 *  field of view, not a distorted one. */
const VALVE_SCALE_HEIGHT = 1024;
const VALVE_IMAGE_SIZE = 1024;

/**
 * A versus map and its coop twin share one overview.
 *
 * The engine reports `l4d_vs_farm01_hilltop` in a versus match and mapinfo.res
 * is keyed on `l4d_farm01_hilltop`. Without this every ranked replay would
 * fall through to auto-fit despite the art being right there.
 */
export function normalizeMapName(map: string): string {
  return map.toLowerCase().replace(/^l4d_vs_/, 'l4d_');
}

export function transformFor(map: string): MapTransform | null {
  const key = normalizeMapName(map);
  const v = VALVE[key];
  if (!v) return null;
  return {
    originX: v.x,
    originY: v.y,
    unitsPerPixel: (VALVE_SCALE_HEIGHT * v.scale) / VALVE_IMAGE_SIZE,
    image: `/overviews/${key}.png`,
    width: VALVE_IMAGE_SIZE,
    height: VALVE_IMAGE_SIZE,
  };
}

export function boundsOf(points: { x: number; y: number }[]): WorldBounds | null {
  if (points.length === 0) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, maxX, minY, maxY };
}

/**
 * Fit a world extent into a canvas with no art at all.
 *
 * This is what makes the viewer usable on the twelve maps with no overview:
 * the replay knows where people went, so the view can be derived from the
 * replay itself. One scale governs both axes so pixels stay square, and the
 * short axis is centred.
 */
export function autoFitTransform(
  bounds: WorldBounds, width: number, height: number, padFraction = 0.05,
): MapTransform {
  // A round where nobody moved, or a single frame, would otherwise divide by
  // zero. One unit per pixel is arbitrary and harmless: there is nothing to
  // see either way, and the alternative is Infinity propagating into every
  // drawn position.
  const spanX = Math.max(bounds.maxX - bounds.minX, 1);
  const spanY = Math.max(bounds.maxY - bounds.minY, 1);
  const pad = 1 + padFraction * 2;
  const unitsPerPixel = Math.max(spanX / width, spanY / height) * pad;

  // Centre: half the leftover canvas in world units, on each axis.
  const marginX = (width * unitsPerPixel - spanX) / 2;
  const marginY = (height * unitsPerPixel - spanY) / 2;

  return {
    originX: bounds.minX - marginX,
    originY: bounds.maxY + marginY,
    unitsPerPixel,
    image: null,
    width,
    height,
  };
}

export function worldToImage(
  t: MapTransform, x: number, y: number,
): { px: number; py: number } {
  return {
    px: (x - t.originX) / t.unitsPerPixel,
    py: (t.originY - y) / t.unitsPerPixel,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/mapTransform.test.ts`

Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/mapTransform.ts tests/mapTransform.test.ts
git commit -m "feat(replay): map world positions to image pixels from a per-map table"
```

---

## Task 8: Convert the map and portrait art

Two one-off conversions. Valve's ten overview BMPs become PNGs the browser can load, and the four survivor panel portraits become PNGs for the HUD strip. Both sources are already on this machine, and the HUD project's virtualenv already has the VTF reader.

**Files:**
- Create: `web/public/overviews/l4d_farm01_hilltop.png` and nine more
- Create: `web/public/portraits/bill.png`, `francis.png`, `louis.png`, `zoey.png`, `dead.png`, `unknown.png`
- Create: `tools/convert-art.sh`

**Interfaces:**
- Consumes: nothing.
- Produces: static assets. Vite's root is `web/`, so `web/public/x` is served at `/x`, which is what `transformFor()` in Task 7 already points at.

- [ ] **Step 1: Confirm the sources are where the plan says**

Run:

```bash
ls /home/volence/l4d1-ds/server/left4dead/resource/overviews/*.bmp | wc -l
ls /home/volence/Games/L4D-June-2008/L4D_June2008/left4dead/materials/vgui/s_panel_{namvet,biker,manager,teenangst}.vtf
/home/volence/l4d/hud/.venv/bin/python -c "import srctools.vtf, PIL; print('ok')"
```

Expected: `10`, four existing paths, and `ok`. If the virtualenv is missing, stop and say so rather than installing anything globally.

- [ ] **Step 2: Write the conversion script**

Create `tools/convert-art.sh`:

```bash
#!/usr/bin/env bash
# One-off conversion of shipped game art into web assets.
#
# Both sources are outside this repo and neither is redistributable game data
# we want to regenerate on every build, so the PNGs are committed and this
# script exists to document exactly where they came from.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OVERVIEW_SRC=/home/volence/l4d1-ds/server/left4dead/resource/overviews
PORTRAIT_SRC=/home/volence/Games/L4D-June-2008/L4D_June2008/left4dead/materials/vgui
VENV_PY=/home/volence/l4d/hud/.venv/bin/python

mkdir -p "$REPO/web/public/overviews" "$REPO/web/public/portraits"

# Overviews. PNG8 with 256 colours because these are desaturated top-down
# renders: the quality loss is invisible and it is the difference between
# roughly 1.5 MB and roughly 400 KB per map, ten times over, in git.
for f in "$OVERVIEW_SRC"/*.bmp; do
  base="$(basename "${f%.bmp}")"
  magick "$f" -colors 256 "PNG8:$REPO/web/public/overviews/$base.png"
done

# Portraits, straight out of the VTFs.
"$VENV_PY" - <<'PY'
import io, os
from srctools.vtf import VTF
from PIL import Image

SRC = '/home/volence/Games/L4D-June-2008/L4D_June2008/left4dead/materials/vgui'
OUT = os.path.abspath(os.path.join(os.getcwd(), 'web', 'public', 'portraits'))
NAMES = {
    's_panel_namvet': 'bill',
    's_panel_biker': 'francis',
    's_panel_manager': 'louis',
    's_panel_teenangst': 'zoey',
    's_panel_dead': 'dead',
}
os.makedirs(OUT, exist_ok=True)
for vtf_name, out_name in NAMES.items():
    with open(os.path.join(SRC, vtf_name + '.vtf'), 'rb') as fh:
        v = VTF.read(io.BytesIO(fh.read()))
    img = v.get().to_PIL().convert('RGBA')
    img.save(os.path.join(OUT, out_name + '.png'))
    print('wrote', out_name + '.png', img.size)

# A neutral stand-in for a version 1 replay, which does not record which
# survivor a player was. Drawn rather than sourced, because there is no
# "generic survivor" portrait in the game to take.
silhouette = Image.new('RGBA', (128, 128), (0, 0, 0, 0))
px = silhouette.load()
for y in range(128):
    for x in range(128):
        # Head circle plus shoulders, in the same washed grey the panels use.
        head = (x - 64) ** 2 + (y - 44) ** 2 < 26 ** 2
        body = y > 74 and (x - 64) ** 2 / 46 ** 2 + (y - 128) ** 2 / 60 ** 2 < 1
        if head or body:
            px[x, y] = (150, 150, 150, 255)
silhouette.save(os.path.join(OUT, 'unknown.png'))
print('wrote unknown.png')
PY
```

Make it executable: `chmod +x tools/convert-art.sh`

- [ ] **Step 3: Run it from the repo root**

Run: `./tools/convert-art.sh`

Expected: ten overview lines of output from magick (silent on success) and six `wrote` lines from the Python block.

- [ ] **Step 4: Check the result and the size**

Run:

```bash
ls web/public/overviews | wc -l
ls web/public/portraits
du -sh web/public/overviews web/public/portraits
```

Expected: `10`, six portrait PNGs, and an overviews total comfortably under 6 MB. If overviews came out much larger, the `-colors 256` flag did not apply and the magick invocation needs checking before committing megabytes to git.

- [ ] **Step 5: Look at one of each**

Open `web/public/overviews/l4d_farm01_hilltop.png` and `web/public/portraits/francis.png` in an image viewer. The first must be a recognisable overhead of Blood Harvest 1 and the second a portrait of Francis on a transparent background. A black or magenta image means the conversion silently produced garbage, which is worth catching now rather than after the viewer is drawing on top of it.

- [ ] **Step 6: Commit**

```bash
git add tools/convert-art.sh web/public/overviews web/public/portraits
git commit -m "feat(replay): add map overviews and survivor portraits as web assets"
```

---

## Task 9: Fetch replay bytes in the browser

The wiring that lets a Preact component hold a decoded replay, from either source, without knowing which.

**Files:**
- Modify: `web/tsconfig.json`
- Modify: `web/src/api.ts`
- Create: `web/src/replay/source.ts`
- Test: `web/src/replay/source.test.ts`

**Interfaces:**
- Consumes: `decodeHeader`, `decodeFrames`, `HEADER_BYTES`, `ReplayHeader`, `Frame` from `../../src/replayFormat`; `ReplaySession` from `../../src/replaySessions`.
- Produces:
  - `type ReplaySpec = { kind: 'file'; name: string } | { kind: 'match'; matchId: number; ordinal: number; half: number } | { kind: 'live'; token: string }`
  - `replayUrl(spec: ReplaySpec, since: number): string`
  - `appendChunk(state: ReplayState, chunk: Uint8Array, base: number): ReplayState` - pure, the part worth testing
  - `interface ReplayState { header: ReplayHeader | null; frames: Frame[]; cursor: number }`
  - `useReplaySource(spec: ReplaySpec | null): { header: ReplayHeader | null; frames: Frame[]; closed: boolean; error: Error | null }`
  - `api.replaySessions`, `api.replayLive` added to the `api` object.

- [ ] **Step 1: Let the browser project see the shared modules**

In `web/tsconfig.json`, change the `include` array to:

```json
  "include": ["src", "../src/replayFormat.ts", "../src/mapTransform.ts", "../src/replaySessions.ts"]
```

`src/replaySessions.ts` is listed because its `ReplaySession` type describes the browse endpoint's JSON. It imports `node:fs`, so the browser must only ever import its **types**, never its values. Use `import type { ReplaySession } from '../../src/replaySessions';` and nothing else, or the bundle will try to pull in `node:fs` and fail.

- [ ] **Step 2: Write the failing test**

Create `web/src/replay/source.test.ts`. `appendChunk` is the piece with real logic in it: frame offsets inside a chunk are relative to the chunk, and everything downstream (seeking, the keyframe index, the next `since`) depends on them being absolute.

```ts
import { describe, it, expect } from 'vitest';
import { appendChunk, replayUrl, type ReplayState } from './source';
import {
  encodeHeader, encodeFrame, HEADER_BYTES, PLAYER_SLOTS, frameBytes, VERSION,
  type ReplayHeader, type Frame,
} from '../../../src/replayFormat';

const TOKEN = 'a'.repeat(32);

function header(over: Partial<ReplayHeader> = {}): ReplayHeader {
  return {
    version: VERSION, token: TOKEN, ordinal: 0, half: 1,
    playerHz: 10, entityHz: 10, map: 'l4d_vs_farm01_hilltop',
    startedUnix: 1_785_956_274, indexOffset: 0, indexCount: 0, frameCount: 0,
    slots: ['', '', '', '', '', '', '', ''],
    ...over,
  };
}

function emptyFrame(tMs: number): Frame {
  return {
    tMs, offset: 0,
    players: Array.from({ length: PLAYER_SLOTS }, (_, slot) => ({
      slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0,
      health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0,
    })),
    entities: [],
  };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const EMPTY: ReplayState = { header: null, frames: [], cursor: 0 };

describe('appendChunk', () => {
  it('reads the header out of the first chunk', () => {
    const chunk = concat([encodeHeader(header()), encodeFrame(emptyFrame(0))]);
    const got = appendChunk(EMPTY, chunk, 0);
    expect(got.header?.map).toBe('l4d_vs_farm01_hilltop');
    expect(got.frames).toHaveLength(1);
    expect(got.cursor).toBe(HEADER_BYTES + frameBytes(0));
  });

  it('gives frames in the first chunk absolute offsets', () => {
    const chunk = concat([encodeHeader(header()), encodeFrame(emptyFrame(0)), encodeFrame(emptyFrame(100))]);
    const got = appendChunk(EMPTY, chunk, 0);
    expect(got.frames.map((f) => f.offset))
      .toEqual([HEADER_BYTES, HEADER_BYTES + frameBytes(0)]);
  });

  // The reason this function exists. A later chunk starts at `base` bytes into
  // the file, and decodeFrames numbers offsets from the start of whatever it
  // was handed. Without the shift, every frame after the first poll claims to
  // live in the header.
  it('shifts a later chunk by its base offset', () => {
    const first = concat([encodeHeader(header()), encodeFrame(emptyFrame(0))]);
    const state = appendChunk(EMPTY, first, 0);
    const base = state.cursor;

    const second = concat([encodeFrame(emptyFrame(100)), encodeFrame(emptyFrame(200))]);
    const got = appendChunk(state, second, base);

    expect(got.frames).toHaveLength(3);
    expect(got.frames.map((f) => f.offset))
      .toEqual([HEADER_BYTES, base, base + frameBytes(0)]);
    expect(got.cursor).toBe(base + frameBytes(0) * 2);
  });

  it('ignores an empty chunk, which is what a poll with nothing new returns', () => {
    const first = concat([encodeHeader(header()), encodeFrame(emptyFrame(0))]);
    const state = appendChunk(EMPTY, first, 0);
    const got = appendChunk(state, new Uint8Array(0), state.cursor);
    expect(got.frames).toHaveLength(1);
    expect(got.cursor).toBe(state.cursor);
  });

  it('returns the state unchanged when the first chunk is not a replay', () => {
    const got = appendChunk(EMPTY, new Uint8Array(HEADER_BYTES).fill(7), 0);
    expect(got.header).toBeNull();
    expect(got.frames).toEqual([]);
  });
});

describe('replayUrl', () => {
  it('builds a file url', () => {
    expect(replayUrl({ kind: 'file', name: `pug_${TOKEN}_0_1.rpl` }, 0))
      .toBe(`/api/replays/file/pug_${TOKEN}_0_1.rpl?since=0`);
  });

  it('builds a match url', () => {
    expect(replayUrl({ kind: 'match', matchId: 8, ordinal: 1, half: 2 }, 320))
      .toBe('/api/replays/match/8/1/2?since=320');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run web/src/replay/source.test.ts`

Expected: FAIL, the module does not exist.

- [ ] **Step 4: Implement the source module**

Create `web/src/replay/source.ts`:

```ts
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  decodeFrames, decodeHeader, frameBytes, HEADER_BYTES,
  type Frame, type ReplayHeader,
} from '../../../src/replayFormat';

export type ReplaySpec =
  | { kind: 'file'; name: string }
  | { kind: 'match'; matchId: number; ordinal: number; half: number }
  | { kind: 'live'; token: string };

export interface ReplayState {
  header: ReplayHeader | null;
  frames: Frame[];
  /** Absolute byte offset to ask for next. Always a frame boundary, which is
   *  what lets a later chunk be decoded on its own. */
  cursor: number;
}

/** How often a round still being recorded is polled. The server holds frames
 *  back ten seconds regardless, so this interval controls smoothness of
 *  arrival, not how far behind the viewer is. */
const POLL_MS = 1000;

export function replayUrl(spec: ReplaySpec, since: number): string {
  switch (spec.kind) {
    case 'file':
      return `/api/replays/file/${encodeURIComponent(spec.name)}?since=${since}`;
    case 'match':
      return `/api/replays/match/${spec.matchId}/${spec.ordinal}/${spec.half}?since=${since}`;
    case 'live':
      // Live resolves to a filename first, so this is never fetched directly.
      return `/api/replays/live/${encodeURIComponent(spec.token)}`;
  }
}

/**
 * Fold one response body into the running state.
 *
 * Pure, and separated from the fetching for exactly that reason: the offset
 * arithmetic here is the part that can be wrong in a way that looks fine.
 * `decodeFrames` numbers offsets from the start of the buffer it is given, so
 * a chunk that starts `base` bytes into the file produces offsets that are
 * all short by `base`. Seeking, the keyframe index and the next poll's
 * `since` all read those offsets.
 */
export function appendChunk(state: ReplayState, chunk: Uint8Array, base: number): ReplayState {
  if (chunk.length === 0) return state;

  let header = state.header;
  let from = 0;
  if (!header) {
    header = decodeHeader(chunk);
    if (!header) return state;
    from = HEADER_BYTES;
  }

  const { frames } = decodeFrames(chunk, from, chunk.length);
  const shifted = base === 0 ? frames : frames.map((f) => ({ ...f, offset: f.offset + base }));

  // The cursor is where the last WHOLE frame ended, not where the chunk
  // ended. Those are the same today and would diverge the moment a response
  // stopped mid-frame, which `decodeFrames` is built to tolerate and which
  // would otherwise leave the cursor pointing into the middle of a record and
  // desynchronise every later poll.
  const end = shifted.length
    ? shifted[shifted.length - 1].offset + frameBytes(shifted[shifted.length - 1].entities.length)
    : base + chunk.length;

  return { header, frames: state.frames.concat(shifted), cursor: end };
}

/**
 * Hold a replay, saved or live, and keep it current.
 *
 * The two cases differ only in whether polling continues. A saved round
 * arrives in one response and stops; a live one keeps asking from where it
 * left off. Neither the decoding nor anything downstream knows the
 * difference, which is the whole point of serving live frames as a prefix of
 * the same file format.
 */
export function useReplaySource(spec: ReplaySpec | null): {
  header: ReplayHeader | null;
  frames: Frame[];
  closed: boolean;
  error: Error | null;
} {
  const [state, setState] = useState<ReplayState>({ header: null, frames: [], cursor: 0 });
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const key = spec ? JSON.stringify(spec) : '';

  useEffect(() => {
    if (!spec) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let name: string | null = spec.kind === 'file' ? spec.name : null;

    setState({ header: null, frames: [], cursor: 0 });
    setClosed(false);
    setError(null);

    async function tick(): Promise<void> {
      try {
        // A live spec names a token, not a file. Resolving it every poll is
        // what makes a round change appear on its own: the filename moves on,
        // and the cursor resets with it.
        if (spec!.kind === 'live') {
          const res = await fetch(replayUrl(spec!, 0));
          if (!res.ok) throw new Error('no live replay');
          const body = (await res.json()) as { filename: string; closed: boolean };
          if (cancelled) return;
          if (body.filename !== name) {
            name = body.filename;
            setState({ header: null, frames: [], cursor: 0 });
          }
        }

        const cursor = stateRef.current.cursor;
        const url = spec!.kind === 'live'
          ? `/api/replays/file/${encodeURIComponent(name!)}?since=${cursor}`
          : replayUrl(spec!, cursor);

        const res = await fetch(url);
        if (!res.ok) throw new Error(`replay fetch failed: ${res.status}`);
        const chunk = new Uint8Array(await res.arrayBuffer());
        if (cancelled) return;

        const isClosed = res.headers.get('X-Replay-Closed') === '1';
        setState((s) => appendChunk(s, chunk, s.cursor));
        setClosed(isClosed);
        setError(null);

        // A closed file has nothing more to say. Stopping here is what keeps a
        // finished replay from polling forever on somebody's open tab.
        if (!isClosed && !cancelled) timer = setTimeout(tick, POLL_MS);
      } catch (e) {
        if (cancelled) return;
        setError(e as Error);
        // Keep trying. A live page left open across a server restart should
        // recover on its own rather than needing a refresh.
        timer = setTimeout(tick, POLL_MS);
      }
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [key]);

  return { header: state.header, frames: state.frames, closed, error };
}
```

- [ ] **Step 5: Add the two JSON endpoints to the api object**

In `web/src/api.ts`, add the type import and two entries in the `api` object next to `maps`:

```ts
import type { ReplaySession } from '../../src/replaySessions';
```

```ts
  replaySessions: (signal?: AbortSignal) =>
    get<{ sessions: ReplaySession[] }>('/api/replays/sessions', signal),
  replayLive: (token: string, signal?: AbortSignal) =>
    get<{ filename: string; closed: boolean }>(`/api/replays/live/${encodeURIComponent(token)}`, signal),
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `npx vitest run web/src/replay/source.test.ts && npm run typecheck`

Expected: PASS and clean. A typecheck failure mentioning `node:fs` means `ReplaySession` was imported as a value rather than with `import type`.

- [ ] **Step 7: Commit**

```bash
git add web/tsconfig.json web/src/api.ts web/src/replay/source.ts web/src/replay/source.test.ts
git commit -m "feat(replay): decode replay bytes in the browser from either source"
```

---

## Task 10: The browse page

**CHECKPOINT: after this task, `npm run dev` and `/replays` lists the real sessions on disk.** This is the first point where the whole server path is visible end to end.

**Files:**
- Create: `web/src/routes/Replays.tsx`
- Modify: `web/src/main.tsx`
- Modify: `web/src/components/Nav.tsx`
- Modify: `web/src/styles/app.css`

**Interfaces:**
- Consumes: `api.replaySessions` from Task 9; `Panel`, `Empty`, `Tile`, `Tiles` from `../components/bits`; `useFetch` from `../hooks/useFetch`; `campaignName` from `../format`.
- Produces: a `/replays` route listing sessions, each file linking to `/replay/file/<name>`.

- [ ] **Step 1: Write the route component**

Create `web/src/routes/Replays.tsx`:

```tsx
import { api } from '../api';
import { useFetch } from '../hooks/useFetch';
import { Empty, Panel, Tile, Tiles } from '../components/bits';

function when(startedUnix: number): string {
  return new Date(startedUnix * 1000).toLocaleString();
}

export function Replays() {
  const { data, error } = useFetch((s) => api.replaySessions(s), []);

  if (error) {
    return (
      <div class="page page--list">
        <Panel><Empty>Couldn't load replays.</Empty></Panel>
      </div>
    );
  }
  if (!data) return <div class="page page--list" />;

  const sessions = data.sessions;
  const files = sessions.reduce((n, s) => n + s.files.length, 0);

  return (
    <div class="page page--list">
      <div class="page__head"><h2>Replays</h2></div>

      {sessions.length === 0 ? (
        <Panel>
          <Empty>
            No replays on disk. Recording is per round, so one appears as soon
            as a round goes live.
          </Empty>
        </Panel>
      ) : (
        <>
          <Tiles>
            <Tile label="Sessions" value={sessions.length} />
            <Tile label="Rounds" value={files} />
          </Tiles>

          <div class="stack">
            {sessions.map((s) => (
              <Panel class="panel--table" key={s.token}>
                {/* The token is the session identity but it is 32 hex
                    characters, so the time is the heading and the token is
                    the subtitle. */}
                <h3>{when(s.startedUnix)}</h3>
                <p class="muted mono">{s.token}</p>
                <div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Map</th>
                        <th class="num">Round</th>
                        <th class="num">Half</th>
                        <th class="num">Size</th>
                        <th>State</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.files.map((f) => (
                        <tr key={f.filename}>
                          <td>
                            <a href={`/replay/file/${encodeURIComponent(f.filename)}`}>{f.map}</a>
                          </td>
                          <td class="num">{f.ordinal}</td>
                          <td class="num">{f.half}</td>
                          <td class="num">{(f.bytes / 1_048_576).toFixed(1)} MB</td>
                          <td>{f.closed ? 'finished' : 'recording'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Register the route**

In `web/src/main.tsx`, add the import and the route:

```tsx
import { Replays } from './routes/Replays';
```

```tsx
          <Route path="/replays" component={Replays} />
```

The per file links this page renders point at `/replay/file/:name`, which does
not exist until Task 13. Until then they land on the not-found page, which is
the expected state at this checkpoint and not something to paper over with a
placeholder component.

- [ ] **Step 3: Add a nav link**

In `web/src/components/Nav.tsx`, add a `/replays` entry alongside the existing links, following whatever shape that file already uses for one.

- [ ] **Step 4: Add the two styles the page uses**

In `web/src/styles/app.css`, if `.muted` and `.mono` do not already exist, add them:

```css
.muted { color: var(--fg-dim); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8em; }
```

Check the file first. This codebase already has a token system in `web/src/styles/tokens.css`, so use the existing dim foreground variable name rather than inventing `--fg-dim` if it is called something else.

- [ ] **Step 5: See it work**

Run: `npm run dev`

Open `http://localhost:5173/replays`. The standalone sessions recorded on 2026-09-12 must appear, grouped by token, with real map names read out of the file headers. A session recorded within the last minute shows `recording`; older ones show `finished`.

If the list is empty, `REPLAY_DIR` is not set in the local environment. That is a configuration problem, not a code one: check `.env`.

- [ ] **Step 6: Commit**

```bash
git add web/src/routes/Replays.tsx web/src/main.tsx web/src/components/Nav.tsx web/src/styles/app.css
git commit -m "feat(replay): browse recorded sessions by token"
```

---

## Task 11: Interpolation maths

Frames arrive at 10Hz and the screen refreshes at 60. Without interpolation the viewer is a slideshow. These are pure functions, tested on their own, because the canvas code that consumes them cannot be tested usefully.

**Files:**
- Create: `web/src/replay/interpolate.ts`
- Test: `web/src/replay/interpolate.test.ts`

**Interfaces:**
- Consumes: `Frame`, `PlayerSample`, `EntitySample` from `../../../src/replayFormat`.
- Produces:
  - `lerp(a: number, b: number, f: number): number`
  - `lerpAngle(a: number, b: number, f: number): number`
  - `bracket(frames: Frame[], tMs: number): { a: Frame; b: Frame; f: number } | null`
  - `interpolatePlayers(a: Frame, b: Frame, f: number): PlayerSample[]`
  - `interpolateEntities(a: Frame, b: Frame, f: number, maxJump?: number): EntitySample[]`
  - `MAX_ENTITY_JUMP: number`

- [ ] **Step 1: Write the failing test**

Create `web/src/replay/interpolate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  lerp, lerpAngle, bracket, interpolatePlayers, interpolateEntities, MAX_ENTITY_JUMP,
} from './interpolate';
import { PLAYER_SLOTS, STATE, ENTITY_KIND, type Frame, type PlayerSample } from '../../../src/replayFormat';

function players(over: Partial<PlayerSample>[] = []): PlayerSample[] {
  return Array.from({ length: PLAYER_SLOTS }, (_, slot) => ({
    slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0,
    health: 0, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0,
    ...(over[slot] ?? {}),
  }));
}

function frameAt(tMs: number, over: Partial<Frame> = {}): Frame {
  return { tMs, offset: 0, players: players(), entities: [], ...over };
}

describe('lerp', () => {
  it('interpolates linearly', () => {
    expect(lerp(0, 10, 0.25)).toBe(2.5);
  });
});

describe('lerpAngle', () => {
  it('interpolates the short way across the wrap', () => {
    // 170 to -170 is 20 degrees the short way, not 340 the long way.
    expect(lerpAngle(170, -170, 0.5)).toBeCloseTo(180, 5);
  });

  it('interpolates normally away from the wrap', () => {
    expect(lerpAngle(0, 90, 0.5)).toBeCloseTo(45, 5);
  });

  it('handles the other direction across the wrap', () => {
    expect(lerpAngle(-170, 170, 0.5)).toBeCloseTo(-180, 5);
  });
});

describe('bracket', () => {
  const frames = [frameAt(0), frameAt(100), frameAt(200), frameAt(300)];

  it('finds the pair a time falls between, and how far', () => {
    const got = bracket(frames, 150)!;
    expect(got.a.tMs).toBe(100);
    expect(got.b.tMs).toBe(200);
    expect(got.f).toBeCloseTo(0.5, 5);
  });

  it('clamps before the first frame', () => {
    const got = bracket(frames, -50)!;
    expect(got.a.tMs).toBe(0);
    expect(got.f).toBe(0);
  });

  it('clamps after the last frame', () => {
    const got = bracket(frames, 9999)!;
    expect(got.a.tMs).toBe(300);
    expect(got.b.tMs).toBe(300);
    expect(got.f).toBe(0);
  });

  it('returns null with no frames', () => {
    expect(bracket([], 0)).toBeNull();
  });

  it('does not scan linearly', () => {
    // A round is 4000-plus frames and this runs 60 times a second, so a
    // linear scan would be the slowest thing in the viewer. Binary search
    // over a large array must still land on the right pair.
    const many = Array.from({ length: 5000 }, (_, i) => frameAt(i * 100));
    const got = bracket(many, 4999 * 100 - 50)!;
    expect(got.a.tMs).toBe(4998 * 100);
    expect(got.b.tMs).toBe(4999 * 100);
  });
});

describe('interpolatePlayers', () => {
  it('moves a player between frames', () => {
    const a = frameAt(0, { players: players([{ x: 0, y: 0 }]) });
    const b = frameAt(100, { players: players([{ x: 100, y: -50 }]) });
    const got = interpolatePlayers(a, b, 0.5);
    expect(got[0].x).toBe(50);
    expect(got[0].y).toBe(-25);
  });

  // State is a bitfield. Half of "incapped" is not a thing, and interpolating
  // it would make a player flicker between states for a tenth of a second
  // every time one changed.
  it('takes discrete fields from the earlier frame', () => {
    const a = frameAt(0, { players: players([{ state: STATE.PRESENT | STATE.ALIVE, health: 100 }]) });
    const b = frameAt(100, { players: players([{ state: STATE.PRESENT, health: 0 }]) });
    const got = interpolatePlayers(a, b, 0.9);
    expect(got[0].state).toBe(STATE.PRESENT | STATE.ALIVE);
    expect(got[0].health).toBe(100);
  });
});

describe('interpolateEntities', () => {
  it('moves an entity whose ref and kind both match', () => {
    const a = frameAt(0, { entities: [{ ref: 5, kind: ENTITY_KIND.COMMON, state: 0, x: 0, y: 0, z: 0, health: 50 }] });
    const b = frameAt(100, { entities: [{ ref: 5, kind: ENTITY_KIND.COMMON, state: 0, x: 100, y: 0, z: 0, health: 50 }] });
    expect(interpolateEntities(a, b, 0.5)[0].x).toBe(50);
  });

  // Engine entity indices are recycled. A common that dies and a different
  // common that spawns can share ref 5 one frame apart, and interpolating
  // between them draws a zombie sliding impossibly across the map.
  it('does not interpolate a recycled ref that teleported', () => {
    const a = frameAt(0, { entities: [{ ref: 5, kind: ENTITY_KIND.COMMON, state: 0, x: 0, y: 0, z: 0, health: 50 }] });
    const b = frameAt(100, { entities: [{ ref: 5, kind: ENTITY_KIND.COMMON, state: 0, x: MAX_ENTITY_JUMP + 100, y: 0, z: 0, health: 50 }] });
    const got = interpolateEntities(a, b, 0.5);
    expect(got[0].x).toBe(MAX_ENTITY_JUMP + 100);
  });

  it('does not interpolate a ref whose kind changed', () => {
    const a = frameAt(0, { entities: [{ ref: 5, kind: ENTITY_KIND.COMMON, state: 0, x: 0, y: 0, z: 0, health: 50 }] });
    const b = frameAt(100, { entities: [{ ref: 5, kind: ENTITY_KIND.WITCH, state: 0, x: 100, y: 0, z: 0, health: 50 }] });
    expect(interpolateEntities(a, b, 0.5)[0].x).toBe(100);
  });

  it('shows an entity that only exists in the later frame', () => {
    const a = frameAt(0, { entities: [] });
    const b = frameAt(100, { entities: [{ ref: 5, kind: ENTITY_KIND.COMMON, state: 0, x: 100, y: 0, z: 0, health: 50 }] });
    expect(interpolateEntities(a, b, 0.5)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run web/src/replay/interpolate.test.ts`

Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement**

Create `web/src/replay/interpolate.ts`:

```ts
import type { EntitySample, Frame, PlayerSample } from '../../../src/replayFormat';

/** How far an entity may move between two samples and still be believed to be
 *  the same entity. At 10Hz a sprinting common covers roughly 25 units, and a
 *  tank throwing itself around covers more, so this is generous. It exists to
 *  catch a recycled index, which teleports across the map, not to catch fast
 *  movement. */
export const MAX_ENTITY_JUMP = 600;

export function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

/** Interpolate a yaw the short way around.
 *
 *  Yaw is stored in +/- 180, so a player turning through south goes from 170
 *  to -170. Treated as plain numbers that is a 340 degree spin in the wrong
 *  direction, once per turn, and it is extremely visible. */
export function lerpAngle(a: number, b: number, f: number): number {
  const delta = ((b - a + 540) % 360) - 180;
  return a + delta * f;
}

/**
 * The two frames a time falls between, and how far between them it is.
 *
 * Binary search rather than a scan: a round holds several thousand frames and
 * this runs on every animation frame.
 */
export function bracket(
  frames: Frame[], tMs: number,
): { a: Frame; b: Frame; f: number } | null {
  if (frames.length === 0) return null;
  if (tMs <= frames[0].tMs) return { a: frames[0], b: frames[0], f: 0 };
  const last = frames[frames.length - 1];
  if (tMs >= last.tMs) return { a: last, b: last, f: 0 };

  let lo = 0;
  let hi = frames.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].tMs <= tMs) lo = mid;
    else hi = mid;
  }

  const a = frames[lo];
  const b = frames[hi];
  const span = b.tMs - a.tMs;
  return { a, b, f: span > 0 ? (tMs - a.tMs) / span : 0 };
}

/**
 * Positions and angles interpolate. Everything else does not.
 *
 * State is a bitfield, health is a number that means something exact, and the
 * weapon is an id. Half of "incapacitated" is meaningless, and a health bar
 * that slides from 100 to 0 over a tenth of a second reads as a slow death
 * rather than an instant one. Discrete fields come from the earlier frame,
 * so they change exactly when the recording says they changed.
 */
export function interpolatePlayers(a: Frame, b: Frame, f: number): PlayerSample[] {
  return a.players.map((pa, i) => {
    const pb = b.players[i] ?? pa;
    return {
      ...pa,
      x: lerp(pa.x, pb.x, f),
      y: lerp(pa.y, pb.y, f),
      z: lerp(pa.z, pb.z, f),
      yaw: lerpAngle(pa.yaw, pb.yaw, f),
    };
  });
}

/**
 * Entities are matched by index, which the format warns is recycled.
 *
 * An entity only interpolates when the later frame has the same ref, the same
 * kind, and a plausible distance. Anything else is drawn where the later
 * frame says it is, which pops for one frame and is correct, rather than
 * sliding smoothly between two different zombies, which looks smooth and is
 * nonsense.
 */
export function interpolateEntities(
  a: Frame, b: Frame, f: number, maxJump: number = MAX_ENTITY_JUMP,
): EntitySample[] {
  const prev = new Map<number, EntitySample>();
  for (const e of a.entities) prev.set(e.ref, e);

  return b.entities.map((eb) => {
    const ea = prev.get(eb.ref);
    if (!ea || ea.kind !== eb.kind) return eb;
    const dx = eb.x - ea.x;
    const dy = eb.y - ea.y;
    const dz = eb.z - ea.z;
    if (dx * dx + dy * dy + dz * dz > maxJump * maxJump) return eb;
    return {
      ...eb,
      x: lerp(ea.x, eb.x, f),
      y: lerp(ea.y, eb.y, f),
      z: lerp(ea.z, eb.z, f),
    };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run web/src/replay/interpolate.test.ts`

Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add web/src/replay/interpolate.ts web/src/replay/interpolate.test.ts
git commit -m "feat(replay): interpolate positions and yaw between 10Hz samples"
```

---

## Task 12: The playback clock

Playback is separate from fetching so that seeking and speed changes never touch the network, and so that a live viewer following the tail is the same object as a saved viewer sitting at a fixed time.

**Files:**
- Create: `web/src/replay/playback.ts`
- Test: `web/src/replay/playback.test.ts`

**Interfaces:**
- Consumes: nothing outside `preact/hooks`.
- Produces:
  - `SPEEDS: readonly number[]`
  - `advance(tMs: number, elapsedMs: number, speed: number, endMs: number, following: boolean): number` - pure
  - `usePlayback(endMs: number, opts?: { live?: boolean }): { tMs: number; playing: boolean; speed: number; following: boolean; play(): void; pause(): void; toggle(): void; seek(t: number): void; setSpeed(s: number): void; follow(): void }`

- [ ] **Step 1: Write the failing test**

Create `web/src/replay/playback.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { advance, SPEEDS } from './playback';

describe('SPEEDS', () => {
  it('offers the four rates the toolbar shows', () => {
    expect([...SPEEDS]).toEqual([0.5, 1, 2, 4]);
  });
});

describe('advance', () => {
  it('moves forward by elapsed time at 1x', () => {
    expect(advance(1000, 16, 1, 10_000, false)).toBe(1016);
  });

  it('scales by speed', () => {
    expect(advance(1000, 100, 4, 10_000, false)).toBe(1400);
  });

  it('stops at the end when not following', () => {
    expect(advance(9950, 100, 1, 10_000, false)).toBe(10_000);
  });

  // Following is the live case. The end keeps moving as frames arrive, and
  // the viewer should ride it rather than repeatedly hitting a wall that
  // moves a moment later.
  it('snaps to the end when following', () => {
    expect(advance(1000, 16, 1, 10_000, true)).toBe(10_000);
  });

  it('never goes backwards past zero', () => {
    expect(advance(0, 16, 1, 0, false)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run web/src/replay/playback.test.ts`

Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement**

Create `web/src/replay/playback.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

export const SPEEDS = [0.5, 1, 2, 4] as const;

/**
 * Where the clock lands after `elapsedMs` of real time.
 *
 * Pure and separate from the hook because this is the part with a decision in
 * it. `following` is the live behaviour: rather than advancing toward an end
 * that is itself moving, the clock simply sits on the newest frame. That is
 * what makes a live view look live instead of drifting a little further
 * behind every time the tab is backgrounded and rAF stops firing.
 */
export function advance(
  tMs: number, elapsedMs: number, speed: number, endMs: number, following: boolean,
): number {
  if (following) return endMs;
  const next = tMs + elapsedMs * speed;
  if (next >= endMs) return endMs;
  return next < 0 ? 0 : next;
}

export function usePlayback(endMs: number, opts: { live?: boolean } = {}): {
  tMs: number; playing: boolean; speed: number; following: boolean;
  play(): void; pause(): void; toggle(): void;
  seek(t: number): void; setSpeed(s: number): void; follow(): void;
} {
  const [tMs, setTMs] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  // A live viewer starts pinned to the newest frame. Scrubbing anywhere
  // unpins it, so someone rewinding to look at a death is not yanked back to
  // live a second later.
  const [following, setFollowing] = useState(Boolean(opts.live));

  const endRef = useRef(endMs);
  endRef.current = endMs;
  const stateRef = useRef({ playing, speed, following });
  stateRef.current = { playing, speed, following };

  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const step = (now: number): void => {
      const elapsed = now - last;
      last = now;
      const s = stateRef.current;
      if (s.playing) {
        setTMs((t) => advance(t, elapsed, s.speed, endRef.current, s.following));
      }
      raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  const seek = useCallback((t: number) => {
    setFollowing(false);
    setTMs(Math.max(0, Math.min(t, endRef.current)));
  }, []);

  return {
    tMs, playing, speed, following,
    play: useCallback(() => setPlaying(true), []),
    pause: useCallback(() => setPlaying(false), []),
    toggle: useCallback(() => setPlaying((p) => !p), []),
    seek,
    setSpeed: useCallback((s: number) => setSpeed(s), []),
    follow: useCallback(() => { setFollowing(true); setPlaying(true); }, []),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run web/src/replay/playback.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/replay/playback.ts web/src/replay/playback.test.ts
git commit -m "feat(replay): playback clock with speed, seeking and live follow"
```

---

## Task 13: Draw the scene

**CHECKPOINT: after this task you can open a recorded round in a browser and watch it play.** Everything after this is refinement.

**Files:**
- Create: `web/src/replay/draw.ts`
- Create: `web/src/replay/Viewer.tsx`
- Modify: `web/src/main.tsx`
- Modify: `web/src/styles/app.css`
- Test: `web/src/replay/draw.test.ts`

**Interfaces:**
- Consumes: `MapTransform`, `worldToImage`, `transformFor`, `autoFitTransform`, `boundsOf` from `../../../src/mapTransform`; `STATE`, `ENTITY_KIND`, `PlayerSample`, `EntitySample`, `ReplayHeader` from `../../../src/replayFormat`; `bracket`, `interpolatePlayers`, `interpolateEntities` from `./interpolate`; `useReplaySource` from `./source`; `usePlayback` from `./playback`.
- Produces:
  - `avatarRadius(z: number, medianZ: number, base?: number): number`
  - `medianHeight(players: PlayerSample[]): number`
  - `isSurvivor(p: PlayerSample): boolean`
  - `teamColor(p: PlayerSample): string`
  - `entityStyle(kind: number): { color: string; radius: number } | null`
  - `drawScene(ctx: CanvasRenderingContext2D, args: DrawArgs): void`
  - `interface DrawArgs { transform: MapTransform; backdrop: HTMLImageElement | null; trail: { x: number; y: number }[]; players: PlayerSample[]; entities: EntitySample[]; show: ShowFlags; width: number; height: number }`
  - `interface ShowFlags { ci: boolean; entities: boolean }`
  - `Viewer` component, props `{ spec: ReplaySpec; live?: boolean }`

- [ ] **Step 1: Write the failing test**

Create `web/src/replay/draw.test.ts`. Only the pure helpers are tested; canvas output is not.

```ts
import { describe, it, expect } from 'vitest';
import { avatarRadius, medianHeight, isSurvivor, entityStyle } from './draw';
import { STATE, ENTITY_KIND, PLAYER_SLOTS, type PlayerSample } from '../../../src/replayFormat';

function player(over: Partial<PlayerSample> = {}): PlayerSample {
  return {
    slot: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
    state: STATE.PRESENT | STATE.ALIVE,
    health: 100, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0,
    ...over,
  };
}

describe('isSurvivor', () => {
  // A survivor is the slot half, not a recorded flag. Slots 0-3 are team A's
  // survivors for the half and 4-7 are the infected, which is how the roster
  // is laid out in the header.
  it('reads the slot', () => {
    expect(isSurvivor(player({ slot: 0 }))).toBe(true);
    expect(isSurvivor(player({ slot: 3 }))).toBe(true);
    expect(isSurvivor(player({ slot: 4 }))).toBe(false);
  });
});

describe('medianHeight', () => {
  it('ignores players who are not alive', () => {
    const ps = [
      player({ slot: 0, z: 100 }),
      player({ slot: 1, z: 200 }),
      player({ slot: 2, z: 9000, state: STATE.PRESENT }),
      player({ slot: 3, z: 300 }),
    ];
    expect(medianHeight(ps)).toBe(200);
  });

  it('returns 0 when nobody is alive', () => {
    expect(medianHeight([player({ state: 0 })])).toBe(0);
  });
});

describe('avatarRadius', () => {
  it('is the base size at the team median', () => {
    expect(avatarRadius(500, 500, 10)).toBe(10);
  });

  // Higher reads as closer to an overhead camera, which is what separates a
  // rooftop from the alley under it without a layer system.
  it('grows above the median and shrinks below', () => {
    expect(avatarRadius(900, 500, 10)).toBeGreaterThan(10);
    expect(avatarRadius(100, 500, 10)).toBeLessThan(10);
  });

  it('clamps to plus or minus 20 percent however extreme the height', () => {
    expect(avatarRadius(99_999, 0, 10)).toBeCloseTo(12, 5);
    expect(avatarRadius(-99_999, 0, 10)).toBeCloseTo(8, 5);
  });
});

describe('entityStyle', () => {
  it('styles every kind the recorder writes', () => {
    for (const kind of Object.values(ENTITY_KIND)) {
      expect(entityStyle(kind)).not.toBeNull();
    }
  });

  it('returns null for a kind it does not know', () => {
    expect(entityStyle(99)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run web/src/replay/draw.test.ts`

Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement the draw module**

Create `web/src/replay/draw.ts`:

```ts
import { worldToImage, type MapTransform } from '../../../src/mapTransform';
import { ENTITY_KIND, STATE, type EntitySample, type PlayerSample } from '../../../src/replayFormat';

/** Roster slots 0-3 are the survivor team for this half and 4-7 are the
 *  infected. The player record carries no team field because the slot already
 *  is one. */
export function isSurvivor(p: PlayerSample): boolean {
  return p.slot < 4;
}

export function medianHeight(players: PlayerSample[]): number {
  const alive = players
    .filter((p) => (p.state & STATE.ALIVE) !== 0)
    .map((p) => p.z)
    .sort((a, b) => a - b);
  if (alive.length === 0) return 0;
  return alive[Math.floor(alive.length / 2)];
}

/** How far above or below the team an avatar may be scaled. Twenty percent is
 *  enough to read as "that one is upstairs" and small enough that it never
 *  looks like a different kind of thing. */
const HEIGHT_SCALE = 0.2;
/** The height difference at which the scaling is fully applied. Roughly two
 *  storeys, so a normal slope does almost nothing and a floor above does all
 *  of it. */
const HEIGHT_SPAN = 400;

export function avatarRadius(z: number, medianZ: number, base = 7): number {
  const d = Math.max(-1, Math.min(1, (z - medianZ) / HEIGHT_SPAN));
  return base * (1 + d * HEIGHT_SCALE);
}

export function teamColor(p: PlayerSample): string {
  if (!isSurvivor(p)) return '#d9534f';
  return '#6fb1e0';
}

const ENTITY_STYLES: Record<number, { color: string; radius: number }> = {
  [ENTITY_KIND.COMMON]: { color: '#6b6f57', radius: 2 },
  [ENTITY_KIND.WITCH]: { color: '#e8e8e8', radius: 5 },
  [ENTITY_KIND.TANK_ROCK]: { color: '#b07a3c', radius: 3 },
  [ENTITY_KIND.TANK_AI]: { color: '#c0563a', radius: 9 },
  [ENTITY_KIND.SURVIVOR_BOT]: { color: '#4d7d9e', radius: 6 },
  [ENTITY_KIND.SMOKER_AI]: { color: '#7aa65f', radius: 5 },
  [ENTITY_KIND.BOOMER_AI]: { color: '#9e8a3f', radius: 6 },
  [ENTITY_KIND.HUNTER_AI]: { color: '#8d6bb0', radius: 5 },
};

export function entityStyle(kind: number): { color: string; radius: number } | null {
  return ENTITY_STYLES[kind] ?? null;
}

export interface ShowFlags {
  ci: boolean;
  entities: boolean;
}

export interface DrawArgs {
  transform: MapTransform;
  backdrop: HTMLImageElement | null;
  trail: { x: number; y: number }[];
  players: PlayerSample[];
  entities: EntitySample[];
  show: ShowFlags;
  width: number;
  height: number;
}

function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  const step = 64;
  for (let x = 0; x <= w; x += step) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let y = 0; y <= h; y += step) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  ctx.restore();
}

/**
 * Draw one frame.
 *
 * Order matters and is the whole readability of the view: backdrop, then the
 * route trail, then commons, then world entities, then players on top. A
 * common drawn over a survivor makes a horde look like it has already won.
 */
export function drawScene(ctx: CanvasRenderingContext2D, a: DrawArgs): void {
  ctx.clearRect(0, 0, a.width, a.height);
  ctx.fillStyle = '#11130f';
  ctx.fillRect(0, 0, a.width, a.height);

  if (a.backdrop) {
    ctx.drawImage(a.backdrop, 0, 0, a.width, a.height);
  } else {
    // No art for this map. The grid gives the eye a scale reference and the
    // trail below turns the route itself into the map.
    drawGrid(ctx, a.width, a.height);
  }

  if (a.trail.length > 1) {
    ctx.save();
    ctx.strokeStyle = 'rgba(111,177,224,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const first = worldToImage(a.transform, a.trail[0].x, a.trail[0].y);
    ctx.moveTo(first.px, first.py);
    for (let i = 1; i < a.trail.length; i++) {
      const p = worldToImage(a.transform, a.trail[i].x, a.trail[i].y);
      ctx.lineTo(p.px, p.py);
    }
    ctx.stroke();
    ctx.restore();
  }

  for (const e of a.entities) {
    const style = entityStyle(e.kind);
    if (!style) continue;
    const isCommon = e.kind === ENTITY_KIND.COMMON;
    if (isCommon && !a.show.ci) continue;
    if (!isCommon && !a.show.entities) continue;
    const p = worldToImage(a.transform, e.x, e.y);
    ctx.fillStyle = style.color;
    ctx.beginPath();
    ctx.arc(p.px, p.py, style.radius, 0, Math.PI * 2);
    ctx.fill();
  }

  const median = medianHeight(a.players);
  for (const pl of a.players) {
    if ((pl.state & STATE.PRESENT) === 0) continue;
    const alive = (pl.state & STATE.ALIVE) !== 0;
    const p = worldToImage(a.transform, pl.x, pl.y);
    const r = avatarRadius(pl.z, median);

    ctx.save();
    // A ghost is an infected that has not spawned. It is drawn hollow so it
    // reads as "not really there yet". The ten second server-side delay is
    // what makes showing it safe at all; nothing here may be relaxed into
    // showing a ghost sooner.
    const ghost = (pl.state & STATE.GHOST) !== 0;
    ctx.globalAlpha = alive ? (ghost ? 0.35 : 1) : 0.3;

    ctx.beginPath();
    ctx.arc(p.px, p.py, r, 0, Math.PI * 2);
    if (ghost) {
      ctx.strokeStyle = teamColor(pl);
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      ctx.fillStyle = teamColor(pl);
      ctx.fill();
    }

    if (alive) {
      // Yaw is degrees with 0 along +x, and canvas y grows downward, so the
      // sine is negated to keep the arrow pointing where the player looks.
      const rad = (pl.yaw * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(p.px, p.py);
      ctx.lineTo(p.px + Math.cos(rad) * r * 2.2, p.py - Math.sin(rad) * r * 2.2);
      ctx.strokeStyle = teamColor(pl);
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    if ((pl.state & STATE.INCAP) !== 0 || (pl.state & STATE.PINNED) !== 0) {
      ctx.beginPath();
      ctx.arc(p.px, p.py, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = '#e8b04b';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
  }
}
```

- [ ] **Step 4: Implement a minimal Viewer**

Create `web/src/replay/Viewer.tsx`. Controls arrive in Task 14; this version plays.

```tsx
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  autoFitTransform, boundsOf, transformFor, type MapTransform,
} from '../../../src/mapTransform';
import { STATE } from '../../../src/replayFormat';
import { bracket, interpolateEntities, interpolatePlayers } from './interpolate';
import { usePlayback } from './playback';
import { useReplaySource, type ReplaySpec } from './source';
import { drawScene, isSurvivor, type ShowFlags } from './draw';

const SIZE = 720;

export function Viewer(
  { spec, live = false, names = {} }:
  { spec: ReplaySpec; live?: boolean; names?: Record<string, string> },
) {
  const { header, frames, closed, error } = useReplaySource(spec);
  const endMs = frames.length ? frames[frames.length - 1].tMs : 0;
  const playback = usePlayback(endMs, { live });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [backdrop, setBackdrop] = useState<HTMLImageElement | null>(null);
  const show: ShowFlags = { ci: true, entities: true };

  /**
   * One interpolated frame per tick, shared by everything that reads it.
   *
   * The canvas, the status counts and the health panels must agree. Letting
   * each call `bracket` itself would drift them a frame apart, which shows up
   * as a health number sitting next to an avatar that has already moved.
   */
  const { livePlayers, liveEntities } = useMemo(() => {
    const pair = bracket(frames, playback.tMs);
    if (!pair) return { livePlayers: [], liveEntities: [] };
    return {
      livePlayers: interpolatePlayers(pair.a, pair.b, pair.f),
      liveEntities: interpolateEntities(pair.a, pair.b, pair.f),
    };
  }, [frames, playback.tMs]);

  /**
   * The transform is derived once per replay, not per frame.
   *
   * A map with an overview uses Valve's numbers. Everything else is fitted to
   * the positions this round actually contains, which is why the viewer works
   * on the twelve maps with no art at all. Fitting to the whole round rather
   * than the visible frame keeps the view still: a camera that reframed as
   * the team moved would be unwatchable.
   */
  const transform: MapTransform | null = useMemo(() => {
    if (!header) return null;
    const known = transformFor(header.map);
    if (known) return known;
    const points: { x: number; y: number }[] = [];
    for (const f of frames) {
      for (const p of f.players) {
        if ((p.state & STATE.PRESENT) !== 0) points.push({ x: p.x, y: p.y });
      }
    }
    const bounds = boundsOf(points);
    if (!bounds) return null;
    return autoFitTransform(bounds, SIZE, SIZE);
    // Deliberately keyed on the map and the frame count rather than on
    // `frames`, so a live round refits occasionally as it extends rather than
    // on every single poll.
  }, [header?.map, Math.floor(frames.length / 100)]);

  useEffect(() => {
    if (!transform?.image) { setBackdrop(null); return; }
    const img = new Image();
    img.onload = () => setBackdrop(img);
    // A missing overview is not an error. Falling back to the grid is exactly
    // what a map with no art does anyway.
    img.onerror = () => setBackdrop(null);
    img.src = transform.image;
  }, [transform?.image]);

  const trail = useMemo(() => {
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < frames.length; i += 10) {
      const alive = frames[i].players.filter((p) => isSurvivor(p) && (p.state & STATE.ALIVE) !== 0);
      if (alive.length === 0) continue;
      out.push({
        x: alive.reduce((n, p) => n + p.x, 0) / alive.length,
        y: alive.reduce((n, p) => n + p.y, 0) / alive.length,
      });
    }
    return out;
  }, [frames.length]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !transform) return;
    drawScene(ctx, {
      transform, backdrop, trail,
      players: livePlayers,
      entities: liveEntities,
      show,
      width: SIZE,
      height: SIZE,
    });
  }, [livePlayers, liveEntities, transform, backdrop, trail]);

  if (error && !header) return <div class="replay replay--empty">Couldn't load that replay.</div>;
  if (!header) return <div class="replay replay--empty">Loading replay...</div>;

  return (
    <div class="replay">
      <canvas ref={canvasRef} width={SIZE} height={SIZE} class="replay__canvas" />
      <div class="replay__status">
        {header.map}
        {!closed && <span class="replay__live"> LIVE, 10s delayed</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Add a viewer page and route**

Create `web/src/routes/ReplayPage.tsx`:

```tsx
import { Viewer } from '../replay/Viewer';

export function ReplayPage({ name }: { name: string }) {
  return (
    <div class="page">
      <div class="page__head"><h2>Replay</h2></div>
      <Viewer spec={{ kind: 'file', name: decodeURIComponent(name) }} />
    </div>
  );
}
```

In `web/src/main.tsx`, add the import and the route:

```tsx
import { ReplayPage } from './routes/ReplayPage';
```

```tsx
          <Route path="/replay/file/:name" component={ReplayPage} />
```

- [ ] **Step 6: Add the styles**

In `web/src/styles/app.css`:

```css
.replay { display: flex; flex-direction: column; gap: 0.5rem; }
.replay__canvas { width: 100%; max-width: 720px; aspect-ratio: 1; background: #11130f; border-radius: 4px; }
.replay__status { font-size: 0.85rem; opacity: 0.8; }
.replay__live { color: #d9534f; font-weight: 600; }
.replay--empty { padding: 2rem; text-align: center; opacity: 0.7; }
```

- [ ] **Step 7: Run the tests and typecheck**

Run: `npx vitest run web/src/replay/draw.test.ts && npm run typecheck`

Expected: PASS and clean.

- [ ] **Step 8: Watch a replay**

Run: `npm run dev`

Go to `/replays`, click a Death Toll round (`l4d_smalltown01_caves` has a Valve overview, so it should draw on the real map image), and confirm:

- Blue dots move along the map with yaw arrows.
- The infected dots are red.
- A Death Toll or Blood Harvest round shows the overhead image; a No Mercy or Dead Air round shows the grid with a trail and the dots still move sensibly.
- Playback runs at roughly real time.

If dots appear in a tight cluster in one corner on a Valve map, the transform is wrong and the likely cause is the `vs_` name normalisation. Check `transformFor(header.map)` returns non-null for the map in the header.

- [ ] **Step 9: Commit**

```bash
git add web/src/replay/draw.ts web/src/replay/draw.test.ts web/src/replay/Viewer.tsx web/src/routes/ReplayPage.tsx web/src/main.tsx web/src/styles/app.css
git commit -m "feat(replay): draw and play back a recorded round"
```

---

## Task 14: Viewer controls

The toolbar, scrub bar, speed, follow, and the status line.

**Files:**
- Modify: `web/src/replay/Viewer.tsx`
- Create: `web/src/replay/useToggles.ts`
- Modify: `web/src/styles/app.css`
- Test: `web/src/replay/useToggles.test.ts`

**Interfaces:**
- Consumes: `usePlayback`, `SPEEDS` from `./playback`; `ShowFlags` from `./draw`.
- Produces:
  - `interface Toggles { hp: boolean; guns: boolean; events: boolean; chat: boolean; ci: boolean; entities: boolean; follow: boolean }`
  - `DEFAULT_TOGGLES: Toggles`
  - `readToggles(raw: string | null): Toggles` - pure
  - `useToggles(): [Toggles, (k: keyof Toggles) => void]`

- [ ] **Step 1: Write the failing test**

Create `web/src/replay/useToggles.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readToggles, DEFAULT_TOGGLES } from './useToggles';

describe('readToggles', () => {
  it('falls back to the defaults with nothing stored', () => {
    expect(readToggles(null)).toEqual(DEFAULT_TOGGLES);
  });

  it('falls back to the defaults on unparseable storage', () => {
    expect(readToggles('not json')).toEqual(DEFAULT_TOGGLES);
  });

  it('keeps a stored value', () => {
    const raw = JSON.stringify({ ...DEFAULT_TOGGLES, ci: false });
    expect(readToggles(raw).ci).toBe(false);
  });

  // A toggle added in a later release must not leave everyone who has
  // already used the viewer with it undefined, which renders as off with no
  // way to discover it.
  it('fills in a key the stored value predates', () => {
    const raw = JSON.stringify({ hp: false });
    const got = readToggles(raw);
    expect(got.hp).toBe(false);
    expect(got.guns).toBe(DEFAULT_TOGGLES.guns);
    expect(got.entities).toBe(DEFAULT_TOGGLES.entities);
  });

  it('ignores a stored value that is not an object', () => {
    expect(readToggles('42')).toEqual(DEFAULT_TOGGLES);
    expect(readToggles('null')).toEqual(DEFAULT_TOGGLES);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run web/src/replay/useToggles.test.ts`

Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement**

Create `web/src/replay/useToggles.ts`:

```ts
import { useCallback, useState } from 'preact/hooks';

export interface Toggles {
  hp: boolean;
  guns: boolean;
  events: boolean;
  chat: boolean;
  ci: boolean;
  entities: boolean;
  follow: boolean;
}

export const DEFAULT_TOGGLES: Toggles = {
  hp: true, guns: false, events: true, chat: true,
  ci: true, entities: true, follow: false,
};

const KEY = 'replay.toggles';

/** Merge over the defaults rather than trusting what was stored.
 *
 *  Storage outlives releases. A value written before a toggle existed has no
 *  key for it, and spreading the defaults first is what stops that reading as
 *  "off" forever with no way for the user to find out why. */
export function readToggles(raw: string | null): Toggles {
  if (!raw) return DEFAULT_TOGGLES;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_TOGGLES;
    return { ...DEFAULT_TOGGLES, ...(parsed as Partial<Toggles>) };
  } catch {
    return DEFAULT_TOGGLES;
  }
}

export function useToggles(): [Toggles, (k: keyof Toggles) => void] {
  const [toggles, setToggles] = useState<Toggles>(() => {
    try {
      return readToggles(localStorage.getItem(KEY));
    } catch {
      // Private browsing and blocked site data both throw on access rather
      // than returning null.
      return DEFAULT_TOGGLES;
    }
  });

  const toggle = useCallback((k: keyof Toggles) => {
    setToggles((t) => {
      const next = { ...t, [k]: !t[k] };
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* not fatal */ }
      return next;
    });
  }, []);

  return [toggles, toggle];
}
```

- [ ] **Step 4: Wire the controls into the Viewer**

In `web/src/replay/Viewer.tsx`:

- Import `useToggles, type Toggles` and `SPEEDS`.
- Replace the hardcoded `const show: ShowFlags = { ci: true, entities: true };` with `const [toggles, toggle] = useToggles();` and `const show: ShowFlags = { ci: toggles.ci, entities: toggles.entities };`.
- Add a `followSlot` state: `const [followSlot, setFollowSlot] = useState<number | null>(null);`
- Add this block between the canvas and the status line:

```tsx
      <div class="replay__controls">
        <button class="replay__btn" onClick={playback.toggle}>
          {playback.playing ? 'Pause' : 'Play'}
        </button>
        <input
          class="replay__scrub"
          type="range"
          min={0}
          max={Math.max(endMs, 1)}
          value={playback.tMs}
          onInput={(e) => playback.seek(Number((e.target as HTMLInputElement).value))}
        />
        <span class="replay__time">{formatTime(playback.tMs)} / {formatTime(endMs)}</span>
        {SPEEDS.map((s) => (
          <button
            key={s}
            class={`replay__btn ${playback.speed === s ? 'is-on' : ''}`}
            onClick={() => playback.setSpeed(s)}
          >{s}x</button>
        ))}
        {live && (
          <button
            class={`replay__btn ${playback.following ? 'is-on' : ''}`}
            onClick={playback.follow}
          >Live</button>
        )}
      </div>

      <div class="replay__toolbar">
        {(['hp', 'guns', 'events', 'chat', 'ci', 'entities'] as (keyof Toggles)[]).map((k) => (
          <button
            key={k}
            class={`replay__btn ${toggles[k] ? 'is-on' : ''}`}
            onClick={() => toggle(k)}
          >{TOGGLE_LABELS[k]}</button>
        ))}
      </div>
```

- Add these two helpers at module scope in the same file:

```tsx
const TOGGLE_LABELS: Record<string, string> = {
  hp: 'HP', guns: 'Guns', events: 'Evts', chat: 'Chat', ci: 'CI', entities: 'Ents',
};

/** Round time as m:ss. The scrub bar is in milliseconds because that is what
 *  the frames carry; nobody wants to read that. */
function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
```

- [ ] **Step 5: Add follow-camera support to the draw call**

In the draw `useEffect` in `Viewer.tsx`, before `drawScene`, translate the context when a slot is being followed:

```tsx
    const players = interpolatePlayers(pair.a, pair.b, pair.f);
    const target = followSlot === null ? null : players[followSlot];
    ctx.save();
    if (target && transform) {
      // Keep the followed player centred by moving the world under them.
      const p = worldToImage(transform, target.x, target.y);
      ctx.translate(SIZE / 2 - p.px, SIZE / 2 - p.py);
    }
    drawScene(ctx, { /* as before, with players */ });
    ctx.restore();
```

Add `worldToImage` to the `../../../src/mapTransform` import.

Add the follow row under the toolbar. An empty slot gets no button, because
following a slot nobody occupied would centre the camera on the world origin:

```tsx
      <div class="replay__toolbar">
        <button
          class={`replay__btn ${followSlot === null ? 'is-on' : ''}`}
          onClick={() => setFollowSlot(null)}
        >Free</button>
        {header.slots.map((id, i) => (id === '' ? null : (
          <button
            key={i}
            class={`replay__btn ${followSlot === i ? 'is-on' : ''}`}
            onClick={() => setFollowSlot(i)}
          >{names[id] ?? `Slot ${i}`}</button>
        )))}
      </div>
```

`names` is the prop Task 13 added. A standalone session has no name lookup, so
this renders SteamID64s there, which is correct and still distinguishes the
slots.

- [ ] **Step 6: Add the status line counts**

The spec calls for a status line reading survivors alive, commons and
specials. Add the count to `web/src/replay/draw.ts`:

```ts
export interface SceneCounts { survivors: number; commons: number; specials: number }

/**
 * What the status line reports.
 *
 * Specials counts both halves of the picture: rostered infected players who
 * are alive, and AI specials, which arrive as entities rather than player
 * records because the player block is the roster and a bot never joins it.
 * Counting only one of the two would read as zero on a mix night and as
 * nearly zero in a ranked match with an AI tank on the field.
 */
export function sceneCounts(players: PlayerSample[], entities: EntitySample[]): SceneCounts {
  let survivors = 0;
  let specials = 0;
  for (const p of players) {
    if ((p.state & STATE.ALIVE) === 0) continue;
    if (isSurvivor(p)) survivors++;
    // A ghost has not spawned, so it is not on the field to be counted.
    else if ((p.state & STATE.GHOST) === 0) specials++;
  }

  let commons = 0;
  for (const e of entities) {
    if (e.kind === ENTITY_KIND.COMMON) commons++;
    else if (
      e.kind === ENTITY_KIND.SMOKER_AI || e.kind === ENTITY_KIND.BOOMER_AI ||
      e.kind === ENTITY_KIND.HUNTER_AI || e.kind === ENTITY_KIND.TANK_AI
    ) specials++;
  }
  return { survivors, commons, specials };
}
```

Add its test to `web/src/replay/draw.test.ts`:

```ts
describe('sceneCounts', () => {
  it('counts living survivors', () => {
    const ps = [player({ slot: 0 }), player({ slot: 1, state: STATE.PRESENT }), player({ slot: 2 })];
    expect(sceneCounts(ps, []).survivors).toBe(2);
  });

  it('counts rostered infected and AI specials together', () => {
    const ps = [player({ slot: 4 }), player({ slot: 5 })];
    const es = [
      { ref: 1, kind: ENTITY_KIND.HUNTER_AI, state: 0, x: 0, y: 0, z: 0, health: 250 },
      { ref: 2, kind: ENTITY_KIND.COMMON, state: 0, x: 0, y: 0, z: 0, health: 50 },
    ];
    expect(sceneCounts(ps, es).specials).toBe(3);
    expect(sceneCounts(ps, es).commons).toBe(1);
  });

  // A ghost is queued to spawn, not on the field. Counting it would tell a
  // survivor watching the live page how many are already up, which is part
  // of what the delay exists to blunt.
  it('does not count a ghost as a special on the field', () => {
    const ps = [player({ slot: 4, state: STATE.PRESENT | STATE.ALIVE | STATE.GHOST })];
    expect(sceneCounts(ps, []).specials).toBe(0);
  });
});
```

Add `sceneCounts` and `ENTITY_KIND` to that test file's imports, and replace the
status line in `Viewer.tsx` with:

```tsx
      <div class="replay__status">
        <span>{header.map}</span>
        <span>{counts.survivors} alive</span>
        <span>{counts.commons} common</span>
        <span>{counts.specials} special</span>
        {!closed && <span class="replay__live">LIVE, 10s delayed</span>}
      </div>
```

where `counts` comes from `sceneCounts(livePlayers, liveEntities)` on the same
memo as the draw call.

- [ ] **Step 7: Add the styles**

In `web/src/styles/app.css`:

```css
.replay__status { display: flex; gap: 0.75rem; flex-wrap: wrap; }
.replay__controls, .replay__toolbar { display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap; }
.replay__scrub { flex: 1 1 200px; }
.replay__time { font-variant-numeric: tabular-nums; font-size: 0.85rem; opacity: 0.8; }
.replay__btn { padding: 0.2rem 0.55rem; font-size: 0.8rem; border-radius: 3px; cursor: pointer; }
.replay__btn.is-on { outline: 1px solid currentColor; font-weight: 600; }
```

- [ ] **Step 8: Run the tests and try it**

Run: `npx vitest run web/src/replay/useToggles.test.ts web/src/replay/draw.test.ts && npm run typecheck && npm run dev`

Check in the browser: pause and play work, the scrub bar seeks, 4x is visibly four times as fast, turning CI off removes the small dots, and a reload keeps whatever toggles were set.

- [ ] **Step 9: Commit**

```bash
git add web/src/replay/useToggles.ts web/src/replay/useToggles.test.ts web/src/replay/draw.ts web/src/replay/draw.test.ts web/src/replay/Viewer.tsx web/src/styles/app.css
git commit -m "feat(replay): viewer controls, toggles and follow camera"
```

---

## Task 15: The HUD panel strip

Eight panels in the in-game style. Everything they show except the portrait is already in the format.

**Files:**
- Modify: `src/replayFormat.ts`
- Create: `web/src/replay/HudStrip.tsx`
- Create: `web/src/replay/hud.ts`
- Modify: `web/src/replay/Viewer.tsx`
- Modify: `web/src/styles/app.css`
- Test: `web/src/replay/hud.test.ts`

**Interfaces:**
- Consumes: `STATE`, `weaponName` from `../../../src/replayFormat`; `isSurvivor` from `./draw`.
- Produces:
  - In `src/replayFormat.ts`: `SURVIVOR_CHARACTERS: readonly string[]`, `ZOMBIE_CLASSES: readonly string[]`
  - In `web/src/replay/hud.ts`: `healthColor(health: number, alive: boolean): string`, `statusFlags(state: number): string[]`, `portraitFor(cls: number, version: number, survivor: boolean): string`, `barSegments(health: number, temp: number, max?: number): { perm: number; temp: number }`
  - `HudStrip` component, props `{ players: PlayerSample[]; header: ReplayHeader; names: Record<string, string>; showHp: boolean; showGuns: boolean }`

- [ ] **Step 1: Add the two name tables to the shared format module**

In `src/replayFormat.ts`, immediately after `WEAPON_NAMES`:

```ts
/** Survivor character by the index the plugin records in `cls`, from format
 *  version 2 onward. Version 1 files always wrote 0 for a survivor, which is
 *  why a viewer must check the header version before believing this.
 *
 *  The order is the engine's `m_survivorCharacter` order, which is verified
 *  in game rather than assumed: see the replay viewer plan's final task. */
export const SURVIVOR_CHARACTERS = ['bill', 'zoey', 'francis', 'louis'] as const;

/** Zombie class by `m_zombieClass`, which the plugin records in `cls` for
 *  infected players in every format version. */
export const ZOMBIE_CLASSES = ['', 'smoker', 'boomer', 'hunter', 'witch', 'tank'] as const;
```

- [ ] **Step 2: Write the failing test**

Create `web/src/replay/hud.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { healthColor, statusFlags, portraitFor, barSegments } from './hud';
import { STATE, VERSION } from '../../../src/replayFormat';

describe('healthColor', () => {
  it('ramps green to red', () => {
    expect(healthColor(100, true)).not.toBe(healthColor(40, true));
    expect(healthColor(40, true)).not.toBe(healthColor(10, true));
  });

  it('greys out a dead player', () => {
    expect(healthColor(0, false)).toBe(healthColor(100, false));
  });
});

describe('statusFlags', () => {
  it('names each state bit that is set', () => {
    expect(statusFlags(STATE.PRESENT | STATE.ALIVE | STATE.INCAP)).toContain('Incapped');
    expect(statusFlags(STATE.PRESENT | STATE.ALIVE | STATE.PINNED)).toContain('Pinned');
    expect(statusFlags(STATE.PRESENT | STATE.ALIVE | STATE.BILED)).toContain('Biled');
    expect(statusFlags(STATE.PRESENT | STATE.ALIVE | STATE.BURNING)).toContain('Burning');
    expect(statusFlags(STATE.PRESENT | STATE.ALIVE | STATE.LEDGED)).toContain('Hanging');
  });

  it('names nothing for a healthy player', () => {
    expect(statusFlags(STATE.PRESENT | STATE.ALIVE)).toEqual([]);
  });

  it('names a dead player as dead rather than listing bits', () => {
    expect(statusFlags(STATE.PRESENT)).toEqual(['Dead']);
  });
});

describe('portraitFor', () => {
  // The whole reason the version check exists. A version 1 file wrote 0 for
  // every survivor, so believing `cls` there would label all four of them
  // Bill.
  it('is the silhouette for a version 1 survivor', () => {
    expect(portraitFor(0, 1, true)).toBe('/portraits/unknown.png');
    expect(portraitFor(2, 1, true)).toBe('/portraits/unknown.png');
  });

  it('is the real character for a version 2 survivor', () => {
    expect(portraitFor(2, 2, true)).toBe('/portraits/francis.png');
  });

  it('is the silhouette for an out of range character index', () => {
    expect(portraitFor(99, 2, true)).toBe('/portraits/unknown.png');
  });

  it('is never a survivor portrait for an infected player', () => {
    expect(portraitFor(1, 2, false)).toBe('/portraits/unknown.png');
  });

  it('handles the current version without special casing', () => {
    expect(portraitFor(0, VERSION, true)).toBe(
      VERSION >= 2 ? '/portraits/bill.png' : '/portraits/unknown.png',
    );
  });
});

describe('barSegments', () => {
  it('splits permanent and temporary health as fractions', () => {
    expect(barSegments(50, 25)).toEqual({ perm: 0.5, temp: 0.25 });
  });

  it('clamps the total to the bar', () => {
    const got = barSegments(90, 90);
    expect(got.perm + got.temp).toBeLessThanOrEqual(1);
  });

  it('is empty for a dead player', () => {
    expect(barSegments(0, 0)).toEqual({ perm: 0, temp: 0 });
  });

  // A tank records 8000 health, which is why health is a uint16 in the
  // format. Passing its own max keeps the bar meaningful instead of pinned.
  it('accepts a different maximum', () => {
    expect(barSegments(4000, 0, 8000).perm).toBe(0.5);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run web/src/replay/hud.test.ts`

Expected: FAIL, the module does not exist.

- [ ] **Step 4: Implement the helpers**

Create `web/src/replay/hud.ts`:

```ts
import { STATE, SURVIVOR_CHARACTERS } from '../../../src/replayFormat';

export function healthColor(health: number, alive: boolean): string {
  if (!alive) return '#6b6b6b';
  if (health > 40) return '#7ec95e';
  if (health > 20) return '#e8b04b';
  return '#d9534f';
}

export function statusFlags(state: number): string[] {
  if ((state & STATE.ALIVE) === 0) return ['Dead'];
  const out: string[] = [];
  if (state & STATE.INCAP) out.push('Incapped');
  if (state & STATE.LEDGED) out.push('Hanging');
  if (state & STATE.PINNED) out.push('Pinned');
  if (state & STATE.BILED) out.push('Biled');
  if (state & STATE.BURNING) out.push('Burning');
  return out;
}

/**
 * Which portrait to show.
 *
 * Version 1 files hardcoded `cls` to 0 for every survivor, so the character
 * genuinely is not recorded there and the silhouette is the honest answer.
 * Believing the field anyway would put Bill's face on all four of them, which
 * looks like a bug in the viewer rather than a gap in the recording.
 */
export function portraitFor(cls: number, version: number, survivor: boolean): string {
  if (!survivor || version < 2) return '/portraits/unknown.png';
  const name = SURVIVOR_CHARACTERS[cls];
  return name ? `/portraits/${name}.png` : '/portraits/unknown.png';
}

/**
 * The two-tone bar, as fractions of the bar's width.
 *
 * Temporary health sits on top of permanent health rather than beside it, and
 * the pair is clamped so a player with 90 permanent and 90 temporary does not
 * draw a bar wider than the panel.
 */
export function barSegments(
  health: number, temp: number, max = 100,
): { perm: number; temp: number } {
  const perm = Math.max(0, Math.min(1, health / max));
  const tempFrac = Math.max(0, Math.min(1 - perm, temp / max));
  return { perm, temp: tempFrac };
}
```

- [ ] **Step 5: Implement the strip**

Create `web/src/replay/HudStrip.tsx`:

```tsx
import { STATE, ZOMBIE_CLASSES, weaponName, type PlayerSample, type ReplayHeader } from '../../../src/replayFormat';
import { isSurvivor } from './draw';
import { barSegments, healthColor, portraitFor, statusFlags } from './hud';

/** A tank carries 8000 health and everything else carries 100, so the bar
 *  needs to know which it is looking at or a tank's bar is permanently full.
 *  `cls` 5 is the tank in `m_zombieClass`. */
function maxHealthFor(p: PlayerSample): number {
  return !isSurvivor(p) && ZOMBIE_CLASSES[p.cls] === 'tank' ? 8000 : 100;
}

function Panel(
  { p, header, name, showHp, showGuns }:
  { p: PlayerSample; header: ReplayHeader; name: string; showHp: boolean; showGuns: boolean },
) {
  const present = (p.state & STATE.PRESENT) !== 0;
  const alive = (p.state & STATE.ALIVE) !== 0;
  const survivor = isSurvivor(p);
  const max = maxHealthFor(p);
  const bar = barSegments(p.health, p.temp, max);
  const flags = statusFlags(p.state);

  if (!present) return <div class="hudp hudp--empty" />;

  return (
    <div class={`hudp ${alive ? '' : 'hudp--dead'}`}>
      <img class="hudp__face" src={portraitFor(p.cls, header.version, survivor)} alt="" />
      <div class="hudp__body">
        <div class="hudp__top">
          <span class="hudp__name">{name}</span>
          {showHp && (
            <span class="hudp__hp" style={{ color: healthColor((p.health / max) * 100, alive) }}>
              {alive ? p.health : 0}
            </span>
          )}
        </div>
        {!survivor && ZOMBIE_CLASSES[p.cls] && (
          <span class="hudp__cls">{ZOMBIE_CLASSES[p.cls]}</span>
        )}
        {showGuns && survivor && weaponName(p.weapon) && (
          <span class="hudp__gun">{weaponName(p.weapon)} {p.clip}/{p.reserve}</span>
        )}
        {flags.length > 0 && <span class="hudp__flags">{flags.join(' ')}</span>}
        <div class="hudp__bar">
          {/* Temporary health is drawn behind permanent health, so the
              permanent segment always starts at the left edge and the temp
              segment extends past it. That is how the game draws it. */}
          <div class="hudp__bar-temp" style={{ width: `${(bar.perm + bar.temp) * 100}%` }} />
          <div class="hudp__bar-perm" style={{ width: `${bar.perm * 100}%` }} />
        </div>
      </div>
    </div>
  );
}

export function HudStrip(
  { players, header, names, showHp, showGuns }:
  { players: PlayerSample[]; header: ReplayHeader; names: Record<string, string>; showHp: boolean; showGuns: boolean },
) {
  const survivors = players.filter(isSurvivor);
  const infected = players.filter((p) => !isSurvivor(p));

  const row = (group: PlayerSample[], label: string) => (
    <div class="hud-row">
      <span class="hud-row__label">{label}</span>
      {group.map((p) => (
        <Panel
          key={p.slot}
          p={p}
          header={header}
          // The header's slot roster is SteamID64 per slot. The name lookup
          // comes from the match page when there is one; a standalone session
          // has no roster to look names up in, so the id is the name.
          name={names[header.slots[p.slot]] ?? header.slots[p.slot] ?? `Slot ${p.slot}`}
          showHp={showHp}
          showGuns={showGuns}
        />
      ))}
    </div>
  );

  return (
    <div class="hud-strip">
      {row(survivors, 'Survivors')}
      {row(infected, 'Infected')}
    </div>
  );
}
```

- [ ] **Step 6: Mount it in the Viewer**

In `web/src/replay/Viewer.tsx`:

The `names` prop and the `livePlayers` / `liveEntities` memo already exist from
Task 13. Render the strip below the toolbar:

```tsx
      {header && <HudStrip
        players={livePlayers}
        header={header}
        names={names}
        showHp={toggles.hp}
        showGuns={toggles.guns}
      />}
```

- [ ] **Step 7: Add the styles**

In `web/src/styles/app.css`:

```css
.hud-strip { display: flex; flex-direction: column; gap: 0.4rem; }
.hud-row { display: flex; gap: 0.35rem; align-items: stretch; flex-wrap: wrap; }
.hud-row__label { font-size: 0.7rem; opacity: 0.6; align-self: center; min-width: 4.5rem; }
.hudp { display: flex; gap: 0.4rem; background: #1b1d18; border: 1px solid #2b2e26; border-radius: 3px; padding: 0.25rem; min-width: 9rem; }
.hudp--empty { visibility: hidden; }
.hudp--dead { filter: grayscale(1); opacity: 0.55; }
.hudp__face { width: 34px; height: 34px; object-fit: cover; border-radius: 2px; }
.hudp__body { display: flex; flex-direction: column; gap: 0.1rem; flex: 1; min-width: 0; }
.hudp__top { display: flex; justify-content: space-between; gap: 0.4rem; }
.hudp__name { font-size: 0.75rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hudp__hp { font-size: 0.85rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.hudp__cls, .hudp__gun, .hudp__flags { font-size: 0.65rem; opacity: 0.75; }
.hudp__flags { color: #e8b04b; }
.hudp__bar { position: relative; height: 5px; background: #0e0f0c; border-radius: 2px; overflow: hidden; }
.hudp__bar-temp, .hudp__bar-perm { position: absolute; inset: 0 auto 0 0; }
.hudp__bar-temp { background: #4a6b4a; }
.hudp__bar-perm { background: #7ec95e; }
```

- [ ] **Step 8: Run the tests and look at it**

Run: `npx vitest run web/src/replay/hud.test.ts && npm run typecheck && npm run dev`

In the browser, the strip must show eight panels with health numbers that change as the round plays, a bar that drains, and grey panels for the dead. Portraits are the silhouette for every file recorded so far, which is correct until Task 18 ships.

- [ ] **Step 9: Commit**

```bash
git add src/replayFormat.ts web/src/replay/hud.ts web/src/replay/hud.test.ts web/src/replay/HudStrip.tsx web/src/replay/Viewer.tsx web/src/styles/app.css
git commit -m "feat(replay): in-game style health panels for both teams"
```

---

## Task 16: The events and chat timeline

Events and chat both carry `t_ms` on the same clock the replay frames use, and they share one sequence counter, so they interleave in true order. This is match-only: a standalone session has no match row, therefore no events and no chat.

**Files:**
- Modify: `src/routes/replays.ts`
- Modify: `web/src/api.ts`
- Create: `web/src/replay/timeline.ts`
- Modify: `web/src/replay/Viewer.tsx`
- Modify: `web/src/styles/app.css`
- Test: `tests/replayRoutes.test.ts`, `web/src/replay/timeline.test.ts`

**Interfaces:**
- Consumes: `match_live_events` and `match_chat` tables.
- Produces:
  - `GET /api/replays/timeline/:matchId/:ordinal/:half` returning `{ entries: TimelineEntry[] }`
  - `interface TimelineEntry { seq: number; tMs: number; kind: 'event' | 'chat'; text: string; actor: string; team: string | null }`
  - `mergeTimeline(events, chat): TimelineEntry[]` in `web/src/replay/timeline.ts`
  - `activeEntries(entries: TimelineEntry[], tMs: number, windowMs?: number): TimelineEntry[]`

- [ ] **Step 1: Write the failing route test**

Add to `tests/replayRoutes.test.ts`. Insert rows directly; the point is the filter and the ordering, not the recording path.

```ts
describe('GET /api/replays/timeline/:matchId/:ordinal/:half', () => {
  it('returns events and chat for that map and half, in sequence order', async () => {
    // Build an app with a db you can seed. Follow the same buildApp pattern
    // the rest of this file uses, keeping a handle on the db.
    const db = openDb(':memory:');
    db.prepare('INSERT INTO matches (id, token, state) VALUES (1, ?, ?)').run('t'.repeat(32), 'done');
    db.prepare(
      `INSERT INTO match_live_events (match_id, seq, kind, actor, target, value, map_ordinal, half, t_ms)
       VALUES (1, 1, 'pounce', 'A', 'B', 20, 0, 1, 5000)`,
    ).run();
    db.prepare(
      `INSERT INTO match_chat (match_id, seq, map_ordinal, half, t_ms, steamid, team, message)
       VALUES (1, 2, 0, 1, 6000, 'A', 'survivor', 'nice')`,
    ).run();
    // Another map: must not appear.
    db.prepare(
      `INSERT INTO match_live_events (match_id, seq, kind, actor, target, value, map_ordinal, half, t_ms)
       VALUES (1, 3, 'pounce', 'A', 'B', 20, 1, 1, 7000)`,
    ).run();
    // Untimed, from before the t_ms column existed: must not appear, because
    // it cannot be placed on the timeline at all.
    db.prepare(
      `INSERT INTO match_live_events (match_id, seq, kind, actor, target, value, map_ordinal, half, t_ms)
       VALUES (1, 4, 'pounce', 'A', 'B', 20, 0, 1, -1)`,
    ).run();

    const app2 = Fastify();
    await app2.register(replayRoutes, { db, replayDir: dir });
    await app2.ready();

    const res = await app2.inject({ url: '/api/replays/timeline/1/0/1' });
    const body = res.json() as { entries: { seq: number; kind: string }[] };
    expect(body.entries.map((e) => [e.seq, e.kind])).toEqual([[1, 'event'], [2, 'chat']]);
    await app2.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/replayRoutes.test.ts -t "timeline"`

Expected: FAIL with a 404.

- [ ] **Step 3: Add the route**

In `src/routes/replays.ts`, inside `replayRoutes`:

```ts
  /**
   * Events and chat for one round, on the same clock as the replay frames.
   *
   * `t_ms` defaults to -1 for rows written before that column existed, and a
   * row that cannot be placed in time cannot be placed on a timeline, so it
   * is filtered out here rather than rendered at zero. Ordering is by `seq`
   * rather than by `t_ms` because events and chat share one monotonic counter
   * and that is what puts a message and the death it was about in the order
   * they actually happened.
   */
  app.get('/api/replays/timeline/:matchId/:ordinal/:half', async (req) => {
    const { matchId, ordinal, half } = req.params as
      { matchId: string; ordinal: string; half: string };
    const id = Number(matchId);
    const ord = Number(ordinal);
    const hf = Number(half);

    const events = db.prepare(
      `SELECT seq, t_ms AS tMs, kind, actor, target, value FROM match_live_events
       WHERE match_id = ? AND map_ordinal = ? AND half = ? AND t_ms >= 0`,
    ).all(id, ord, hf) as
      { seq: number; tMs: number; kind: string; actor: string; target: string | null; value: number }[];

    const chat = db.prepare(
      `SELECT seq, t_ms AS tMs, steamid, team, message FROM match_chat
       WHERE match_id = ? AND map_ordinal = ? AND half = ? AND t_ms >= 0`,
    ).all(id, ord, hf) as
      { seq: number; tMs: number; steamid: string; team: string | null; message: string }[];

    const entries = [
      ...events.map((e) => ({
        seq: e.seq, tMs: e.tMs, kind: 'event' as const,
        text: e.target ? `${e.kind} ${e.target} ${e.value}` : `${e.kind} ${e.value}`,
        actor: e.actor, team: null as string | null,
      })),
      ...chat.map((c) => ({
        seq: c.seq, tMs: c.tMs, kind: 'chat' as const,
        text: c.message, actor: c.steamid, team: c.team,
      })),
    ].sort((a, b) => a.seq - b.seq);

    return { entries };
  });
```

- [ ] **Step 4: Write the failing client test**

Create `web/src/replay/timeline.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { activeEntries, type TimelineEntry } from './timeline';

const entries: TimelineEntry[] = [
  { seq: 1, tMs: 1000, kind: 'event', text: 'pounce 20', actor: 'A', team: null },
  { seq: 2, tMs: 5000, kind: 'chat', text: 'nice', actor: 'B', team: 'survivor' },
  { seq: 3, tMs: 9000, kind: 'event', text: 'death 0', actor: 'C', team: null },
];

describe('activeEntries', () => {
  it('returns entries inside the window ending at now', () => {
    expect(activeEntries(entries, 6000, 5000).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('excludes anything in the future, which is the point', () => {
    expect(activeEntries(entries, 5000, 60_000).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('drops entries older than the window', () => {
    expect(activeEntries(entries, 9000, 1000).map((e) => e.seq)).toEqual([3]);
  });

  it('handles an empty list', () => {
    expect(activeEntries([], 1000)).toEqual([]);
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npx vitest run web/src/replay/timeline.test.ts`

Expected: FAIL, the module does not exist.

- [ ] **Step 6: Implement the client module**

Create `web/src/replay/timeline.ts`:

```ts
export interface TimelineEntry {
  seq: number;
  tMs: number;
  kind: 'event' | 'chat';
  text: string;
  actor: string;
  team: string | null;
}

/** How much history the rail shows by default. Long enough to read what just
 *  happened, short enough that it is not a wall of text during a horde. */
export const DEFAULT_WINDOW_MS = 20_000;

/**
 * Entries the viewer may show at this moment.
 *
 * Nothing in the future is ever returned. On a saved replay that is a
 * convenience, because seeing a death announced before it happens spoils the
 * clip. On a live one it also matters that it never widens what the server
 * chose to release.
 */
export function activeEntries(
  entries: TimelineEntry[], tMs: number, windowMs = DEFAULT_WINDOW_MS,
): TimelineEntry[] {
  const from = tMs - windowMs;
  return entries.filter((e) => e.tMs <= tMs && e.tMs > from);
}
```

- [ ] **Step 7: Add the api entry and render the rail**

In `web/src/api.ts`:

```ts
  replayTimeline: (matchId: number, ordinal: number, half: number, signal?: AbortSignal) =>
    get<{ entries: TimelineEntry[] }>(`/api/replays/timeline/${matchId}/${ordinal}/${half}`, signal),
```

importing `TimelineEntry` as a type from `./replay/timeline`.

In `Viewer.tsx`, accept an optional `timeline?: TimelineEntry[]` prop and render the rail beside the canvas when it is present and the relevant toggle is on:

```tsx
      {timeline && (toggles.events || toggles.chat) && (
        <div class="replay__rail">
          {activeEntries(timeline, playback.tMs)
            .filter((e) => (e.kind === 'chat' ? toggles.chat : toggles.events))
            .map((e) => (
              <button
                key={e.seq}
                class={`replay__entry replay__entry--${e.kind}`}
                onClick={() => playback.seek(e.tMs)}
              >
                <span class="replay__entry-t">{formatTime(e.tMs)}</span>
                <span class="replay__entry-who">{names[e.actor] ?? e.actor}</span>
                <span class="replay__entry-text">{e.text}</span>
              </button>
            ))}
        </div>
      )}
```

- [ ] **Step 8: Add the styles**

```css
.replay__rail { display: flex; flex-direction: column; gap: 0.15rem; max-height: 18rem; overflow-y: auto; }
.replay__entry { display: flex; gap: 0.4rem; text-align: left; font-size: 0.75rem; padding: 0.15rem 0.3rem; background: none; border: 0; cursor: pointer; border-radius: 2px; }
.replay__entry:hover { background: #23261e; }
.replay__entry--chat .replay__entry-text { opacity: 0.85; font-style: italic; }
.replay__entry-t { font-variant-numeric: tabular-nums; opacity: 0.55; }
.replay__entry-who { font-weight: 600; }
```

- [ ] **Step 9: Run the tests**

Run: `npm test && npm run typecheck`

Expected: both clean.

- [ ] **Step 10: Commit**

```bash
git add src/routes/replays.ts tests/replayRoutes.test.ts web/src/api.ts web/src/replay/timeline.ts web/src/replay/timeline.test.ts web/src/replay/Viewer.tsx web/src/styles/app.css
git commit -m "feat(replay): interleave events and chat on a seekable timeline"
```

---

## Task 17: Put the viewer on the live and match pages

**Files:**
- Modify: `web/src/routes/Live.tsx`
- Modify: `web/src/routes/MatchDetail.tsx`
- Test: `web/src/routes/routes.test.tsx`

**Interfaces:**
- Consumes: `Viewer` from `../replay/Viewer`; `api.replayTimeline` from Task 16.
- Produces: no new exports. The live page mounts `<Viewer spec={{ kind: 'live', token }} live />` above the stats; the match page mounts a per-map viewer with a round switch.

- [ ] **Step 1: Mount on the live page**

The live viewer is addressed by session token, and `LiveMatch` does not carry
one today, on either side. Add it first.

In `src/liveView.ts`, add `token: string;` to the `LiveMatch` interface, then
select it in `getLiveMatches` by adding `m.token` to the SELECT list and
`token: string` to that query's row type:

```ts
      `SELECT m.id, m.token, m.campaign, l.current_map AS currentMap, l.last_seen AS lastSeen
       FROM matches m
       LEFT JOIN match_live l ON l.match_id = m.id
       WHERE m.state = 'live'
       ORDER BY m.id DESC`,
```

Carry `token` through to the object that function builds. Add `token: string;`
to the `LiveMatch` interface in `web/src/api.ts` to match.

Then in `web/src/routes/Live.tsx`, above the existing stats section, for each
live match:

```tsx
          <Panel>
            <Viewer spec={{ kind: 'live', token: m.token }} live names={namesFor(m)} />
          </Panel>
```

and add the name lookup at module scope in that file:

```tsx
function namesFor(m: LiveMatch): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of [...m.teamA, ...m.teamB]) out[p.steamid] = p.name;
  return out;
}
```

A live match with no replay on disk renders the viewer's own loading state and
then its error state, which is correct: recording can be off, and the live page
must still show its stats.

- [ ] **Step 2: Mount on the match page**

In `web/src/routes/MatchDetail.tsx`, inside each map's section, add a round switch and a viewer:

```tsx
  const [half, setHalf] = useState(1);
  const timeline = useFetch(
    (s) => api.replayTimeline(matchId, map.ordinal, half, s),
    [matchId, map.ordinal, half],
  );
```

```tsx
        <div class="replay__rounds">
          <button class={`replay__btn ${half === 1 ? 'is-on' : ''}`} onClick={() => setHalf(1)}>Round 1</button>
          <button class={`replay__btn ${half === 2 ? 'is-on' : ''}`} onClick={() => setHalf(2)}>Round 2</button>
        </div>
        <Viewer
          spec={{ kind: 'match', matchId, ordinal: map.ordinal, half }}
          names={playerNames}
          timeline={timeline.data?.entries}
        />
```

A map with no replay row renders the viewer's own "couldn't load" state, which is the right outcome for a match played before recording existed. Do not add a second empty state for it.

- [ ] **Step 3: Extend the route smoke test**

`web/src/routes/routes.test.tsx` already renders the routes. Add a case that renders `MatchDetail` with a stubbed fetch that 404s the replay endpoints, and assert the page still renders its stats rather than throwing. Follow the existing stubbing pattern in that file.

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck`

Expected: clean. `tests/liveView.test.ts` covers `getLiveMatches`; if it
asserts on the whole returned object it will now fail on the added `token`
field. That is a real assertion about a real change, so update it to expect the
token rather than deleting the assertion.

- [ ] **Step 5: Check both pages by hand**

Run: `npm run dev`

- `/match/<id>` for a match with replays: the viewer appears under the map, the round switch swaps rounds, and timeline entries seek.
- `/live` during a recording session: the viewer appears, says `LIVE, 10s delayed`, and keeps moving. Leave it open for a minute and confirm it does not fall behind.

- [ ] **Step 6: Commit**

```bash
git add web/src/routes/Live.tsx web/src/routes/MatchDetail.tsx web/src/routes/routes.test.tsx
git commit -m "feat(replay): mount the viewer on the live and match pages"
```

---

## Task 18: Record the survivor character (format version 2)

Source change only. **This plugin is the live ranked path and must not be deployed as part of executing this plan.** Compile it, commit it, and stop.

**Files:**
- Modify: `plugin/pug-match.sp`
- Modify: `src/replayFormat.ts`
- Test: `tests/replayFormat.test.ts`

**Interfaces:**
- Consumes: the `header.version` check from Task 2, which must already be committed.
- Produces: `VERSION` becomes 2. For a version 2 file, `cls` holds `m_survivorCharacter` for a survivor and `m_zombieClass` for an infected. Record sizes are unchanged.

- [ ] **Step 1: Write the failing test**

Add to `tests/replayFormat.test.ts`:

```ts
describe('format version 2', () => {
  it('is the current version', () => {
    expect(VERSION).toBe(2);
  });

  it('names a survivor character for every index the engine can report', () => {
    expect(SURVIVOR_CHARACTERS).toHaveLength(4);
    expect(new Set(SURVIVOR_CHARACTERS).size).toBe(4);
  });

  // The record did not grow. This is the whole reason this change is cheap:
  // `cls` was already there and was always 0 for a survivor.
  it('does not change the player record size', () => {
    expect(PLAYER_RECORD_BYTES).toBe(20);
  });
});
```

Add `SURVIVOR_CHARACTERS, PLAYER_RECORD_BYTES` to the test file's imports.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/replayFormat.test.ts -t "format version 2"`

Expected: FAIL, `VERSION` is 1.

- [ ] **Step 3: Bump the version**

In `src/replayFormat.ts`:

```ts
export const VERSION = 2;
```

and extend the comment above it to say what changed:

```ts
/** Format version.
 *
 *  2: `cls` carries `m_survivorCharacter` for a survivor, where version 1
 *  always wrote 0. No record grew and no offset moved, so a version 1 file
 *  still decodes correctly; only the meaning of one byte for one team
 *  changed, which is exactly why the version check in `parseReplay` had to
 *  land first. */
```

- [ ] **Step 4: Change the plugin**

In `plugin/pug-match.sp`, find the constant carrying the format version written into the header and set it to 2.

Then change the `cls` write in the player sampler. It currently reads:

```sourcepawn
		p = RplU8(p, survivor ? 0 : GetEntProp(client, Prop_Send, "m_zombieClass"));
```

Replace it with:

```sourcepawn
		// Version 2: this byte is the survivor character for a survivor and
		// the zombie class for an infected. It was always 0 for survivors
		// before, so this fills a field rather than growing the record, which
		// is why no offset below this line moves.
		p = RplU8(p, survivor
			? GetEntProp(client, Prop_Send, "m_survivorCharacter")
			: GetEntProp(client, Prop_Send, "m_zombieClass"));
```

- [ ] **Step 5: Compile the plugin**

Compile it the way the repo already does. Check `plugin/` for a build script or a Makefile and use that rather than inventing a compiler invocation.

Expected: compiles with no errors. A "property not found" error on `m_survivorCharacter` means the netprop is named differently on L4D1, in which case stop and report it rather than guessing a substitute.

- [ ] **Step 6: Run the tests**

Run: `npm test && npm run typecheck`

Expected: clean.

- [ ] **Step 7: Commit, and do not deploy**

```bash
git add src/replayFormat.ts tests/replayFormat.test.ts plugin/pug-match.sp
git commit -m "feat(plugin): record the survivor character in cls, format version 2"
```

- [ ] **Step 8: Write down what still needs verifying in game**

Add to the end of `docs/superpowers/specs/2026-09-12-replay-viewer-design.md`, under a new `## Verification still owed` heading:

```markdown
The order of `SURVIVOR_CHARACTERS` in `src/replayFormat.ts` is
`['bill', 'zoey', 'francis', 'louis']`, which is an assumption about
`m_survivorCharacter` on L4D1 and not a verified fact. It is the one thing in
this piece that fails silently: a wrong order puts the wrong face on the right
player, which looks like a viewer bug rather than a bad constant.

Verifying it takes one round on the local test server at
`/home/volence/l4d1-ds`: record a round with known characters, run
`scripts/dump-replay.ts` over the file, and read the `cls` byte for each
survivor slot. Correct the array if it disagrees.

Deploying the plugin to the Dallas box is a separate decision and has not been
made.
```

Commit it:

```bash
git add docs/superpowers/specs/2026-09-12-replay-viewer-design.md
git commit -m "docs(replay): record the survivor character order as unverified"
```
