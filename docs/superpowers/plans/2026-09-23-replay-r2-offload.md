# Replay R2 Offload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finished replays are copied to R2 and served from there by the same API when the local file is gone, and the pruner can no longer delete a replay that is not safely in R2.

**Architecture:** A new `src/replaySides.ts` owns the side mask and the upload preparation (token blanked, mask stamped). `src/replayOffload.ts` mirrors `src/demoOffload.ts`: an hourly sweep uploads eligible replays and records `r2_key`. `src/routes/replays.ts` falls back to a ranged R2 GET through the same head-rewrite code as local files, so responses are byte-identical. `src/replayPrune.ts` only selects offloaded rows when R2 is configured.

**Tech Stack:** TypeScript (Node 22, ESM, `.js` import suffixes), Fastify, better-sqlite3, vitest, the in-repo SigV4 client `src/r2.ts`.

**Spec:** `docs/superpowers/specs/2026-09-23-replay-r2-offload-design.md`

## Global Constraints

- Nothing changes for anyone using the site: same routes, query parameters, response bodies and headers, same live behaviour. The web viewer (`web/`) is not touched.
- Object key: `replays/<matchId>/<ordinal>_<half>.rpl`. Never derived from the filename (filenames contain the match token).
- Uploaded bytes never contain the token: bytes `TOKEN_OFFSET` to `TOKEN_OFFSET + TOKEN_BYTES` are zeroed in the uploaded copy.
- Eligible for upload: match state `completed` or `aborted`, row `r2_key IS NULL` and `pruned_at IS NULL`, local file closed (header `frameCount !== 0`), file mtime at least 10 minutes old.
- Order: upload, HEAD verify size, then record `r2_key`/`r2_at`. Any failure leaves the row and file untouched. The sweep never deletes local files.
- Prune: when R2 is configured, only rows with `r2_key IS NOT NULL` are ever selected (window and floor). When not configured, today's behaviour exactly.
- Live routes never read R2. `/api/replays/file/:name` is unchanged.
- Never use em dashes in code, comments, docs or commits.
- Run the full suite (`npx vitest run`) and `npx tsc --noEmit -p .` before each commit. In a worktree, first `ln -s /home/volence/l4d/pug/node_modules node_modules` and `ln -s /home/volence/l4d/pug/dist dist` (one server test needs a built frontend); never commit those links.

## File structure

- Create `src/replaySides.ts`: side mask from the database (`infectedMaskForHeader`), in-place stamp of a file (`stampSidesInFile`), upload preparation (`prepareForUpload`), and the shared head rewrite (`rewriteHead`).
- Create `src/replayOffload.ts`: `offloadReplay`, `sweepReplays`.
- Modify `src/r2.ts`: add `replayKey`, `getRange`.
- Modify `src/db.ts`: two `ensureColumn` calls for `match_replays`.
- Modify `src/routes/replays.ts`: use `rewriteHead`; R2 fallback on the match route; `infectedMaskFor` delegates to `replaySides`.
- Modify `src/replayPrune.ts`: `requireOffloaded` option.
- Modify `src/server.ts`: wire the sweep, the route option and the prune option.
- Create `scripts/stamp-replay-sides.ts`, `scripts/offload-replays.ts`.
- Tests: `tests/replaySides.test.ts`, `tests/replayOffload.test.ts`, additions to `tests/replayRoutes.test.ts`, `tests/replayPrune.test.ts`, `tests/demoOffload.test.ts` (r2 helpers live there).

---

### Task 1: R2 key, ranged GET, and the new columns

**Files:**
- Modify: `src/r2.ts` (after `demoKey`, and after `head`)
- Modify: `src/db.ts:1002-1003` (next to the `match_demos` columns)
- Test: `tests/demoOffload.test.ts` (it already hosts the r2 helper tests)

**Interfaces:**
- Produces: `replayKey(matchId: number, ordinal: number, half: number): string`; `getRange(cfg: R2Config, key: string, from: number): Promise<{ body: Buffer; total: number } | null>` (null on 404); columns `match_replays.r2_key TEXT`, `match_replays.r2_at TEXT`.

- [ ] **Step 1: Write the failing tests** (append to `tests/demoOffload.test.ts`)

```ts
import { replayKey, getRange } from '../src/r2.js';

describe('replayKey', () => {
  it('groups by match and names the round, never the token', () => {
    expect(replayKey(92, 3, 2)).toBe('replays/92/3_2.rpl');
    expect(replayKey(92, 3, 2)).not.toMatch(/[0-9a-f]{32}/);
  });
});

describe('getRange', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('asks for the bytes from `from` to the end, signed, and reports the total', async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string> };
      return new Response(Buffer.from('world'), { status: 206, headers: { 'content-range': 'bytes 6-10/11' } });
    }) as typeof fetch;
    const r = await getRange(CFG, 'replays/1/0_1.rpl', 6);
    expect(r).toEqual({ body: Buffer.from('world'), total: 11 });
    expect(seen!.url).toBe('https://acct.r2.cloudflarestorage.com/riverside-demos/replays/1/0_1.rpl');
    expect(seen!.headers.range).toBe('bytes=6-');
    expect(seen!.headers.authorization).toMatch(/SignedHeaders=[^,]*range/);
  });

  it('answers an offset at or past the end with an empty body and the total', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 416, headers: { 'content-range': 'bytes */11' } })) as typeof fetch;
    expect(await getRange(CFG, 'k', 11)).toEqual({ body: Buffer.alloc(0), total: 11 });
  });

  it('returns null for a missing object and throws on anything else', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
    expect(await getRange(CFG, 'k', 0)).toBeNull();
    globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
    await expect(getRange(CFG, 'k', 0)).rejects.toThrow(/R2 GET k failed: 500/);
  });

  it('reads a whole object on a 200 (from 0) and takes the total from content-length', async () => {
    globalThis.fetch = (async () => new Response(Buffer.from('hello'), { status: 200, headers: { 'content-length': '5' } })) as typeof fetch;
    expect(await getRange(CFG, 'k', 0)).toEqual({ body: Buffer.from('hello'), total: 5 });
  });
});
```

Before writing the assertion on `seen.url`, check `pathFor` in `src/r2.ts` and match its shape (path-style `/<bucket>/<key>`); adjust the expected URL to what `pathFor` builds, not the other way round.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/demoOffload.test.ts`
Expected: FAIL, `replayKey`/`getRange` not exported.

- [ ] **Step 3: Implement** (in `src/r2.ts`)

```ts
/** The object key for one replay round.
 *
 *  Unlike `demoKey`, NOT derived from the filename: replay filenames carry the
 *  match token, which seeds that match's server password, and the bucket is
 *  public by URL. Match id, ordinal and half identify the round completely. */
export function replayKey(matchId: number, ordinal: number, half: number): string {
  return `replays/${matchId}/${ordinal}_${half}.rpl`;
}

/** Bytes of an object from `from` to its end, plus the object's total size.
 *  Null when the object is not there. An offset at or past the end is not an
 *  error: it answers an empty body and the total, which is what a viewer that
 *  already has the whole file asks for. */
export async function getRange(
  cfg: R2Config, key: string, from: number,
): Promise<{ body: Buffer; total: number } | null> {
  const headers = { range: `bytes=${from}-` };
  const signed = signRequest(cfg, { method: 'GET', path: pathFor(cfg, key), headers, payloadHash: EMPTY_SHA256 });
  const res = await fetch(`${cfg.endpoint}${pathFor(cfg, key)}`, { method: 'GET', headers: signed });
  if (res.status === 404) return null;
  const range = res.headers.get('content-range');
  if (res.status === 416) {
    return { body: Buffer.alloc(0), total: Number(/\/(\d+)$/.exec(range ?? '')?.[1] ?? 0) };
  }
  if (!res.ok) throw new Error(`R2 GET ${key} failed: ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  const total = res.status === 206
    ? Number(/\/(\d+)$/.exec(range ?? '')?.[1] ?? from + body.length)
    : Number(res.headers.get('content-length') ?? body.length);
  return { body, total };
}
```

If `signRequest` does not add every passed header to `SignedHeaders`, read it and pass `range` the way it expects; the test asserts it is signed.

In `src/db.ts`, beside the `match_demos` lines:

```ts
  ensureColumn(db, 'match_replays', 'r2_key', 'TEXT');
  ensureColumn(db, 'match_replays', 'r2_at', 'TEXT');
```

- [ ] **Step 4: Run to verify pass**, then the full suite and typecheck.

Run: `npx vitest run tests/demoOffload.test.ts && npx vitest run && npx tsc --noEmit -p .`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/r2.ts src/db.ts tests/demoOffload.test.ts
git commit -m "R2: a replay key with no token in it, a ranged GET, and r2 columns on match_replays"
```

---

### Task 2: `src/replaySides.ts` (mask, stamp, upload preparation, head rewrite)

**Files:**
- Create: `src/replaySides.ts`
- Modify: `src/routes/replays.ts` (`infectedMaskFor` body at ~197-223; the head rewrite inside `sendSlice` at ~154-171)
- Test: `tests/replaySides.test.ts`

**Interfaces:**
- Consumes: `decodeHeader`, `HEADER_BYTES`, `TOKEN_OFFSET`, `TOKEN_BYTES`, `INFECTED_MASK_OFFSET`, `SIDES_FLAG_OFFSET` from `src/replayFormat.ts`.
- Produces:
  - `infectedMaskForHeader(db: DB, head: Buffer, matchId: number, ordinal: number, half: number): number | null`
  - `rewriteHead(buf: Buffer, start: number, infectedMask: number | null): void`: mutates `buf`, which holds file bytes beginning at absolute offset `start`; zeroes any token bytes it holds; when `start === 0`, `buf.length >= HEADER_BYTES`, `infectedMask !== null` and the sides flag is not 1, writes the mask and sets the flag.
  - `prepareForUpload(file: Buffer, infectedMask: number | null): Buffer`: a copy with `rewriteHead(copy, 0, mask)` applied.
  - `stampSidesInFile(path: string, mask: number): boolean`: writes bytes 156/157 in place only if the header's sides flag is not 1; returns whether it wrote.

- [ ] **Step 1: Write the failing tests** (`tests/replaySides.test.ts`)

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import {
  encodeHeader, VERSION, HEADER_BYTES, TOKEN_OFFSET, TOKEN_BYTES,
  INFECTED_MASK_OFFSET, SIDES_FLAG_OFFSET, type ReplayHeader,
} from '../src/replayFormat.js';
import { infectedMaskForHeader, rewriteHead, prepareForUpload, stampSidesInFile } from '../src/replaySides.js';

const TOKEN = 'b'.repeat(32);
const A = ['11', '12', '13', '14'].map((n) => `765611980000000${n}`);
const B = ['21', '22', '23', '24'].map((n) => `765611980000000${n}`);

function head(over: Partial<ReplayHeader> = {}): Buffer {
  return Buffer.from(encodeHeader({
    version: VERSION, token: TOKEN, ordinal: 0, half: 1, playerHz: 10, entityHz: 10,
    map: 'l4d_vs_farm01_hilltop', startedUnix: 1_700_000_000, indexOffset: 0, indexCount: 0,
    frameCount: 5, slots: [...A, ...B], infectedMask: 0, sidesKnown: false, ...over,
  }));
}

let db: DB;
let dir: string;
beforeEach(() => {
  db = openDb(':memory:');
  dir = mkdtempSync(join(tmpdir(), 'rplsides-'));
  db.prepare("INSERT INTO matches (id, season_id, state, campaign, token) VALUES (7, 1, 'completed', 'x', ?)").run(TOKEN);
  for (const p of [...A, ...B]) db.prepare("INSERT OR IGNORE INTO players (steamid, name) VALUES (?, 'p')").run(p);
  for (const p of A) db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (7, ?, 'a')").run(p);
  for (const p of B) db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (7, ?, 'b')").run(p);
  db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team) VALUES (7, 0, 1, 'a')").run();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('infectedMaskForHeader', () => {
  it('marks the slots of the team that did not survive', () => {
    expect(infectedMaskForHeader(db, head(), 7, 0, 1)).toBe(0b11110000);
  });
  it('is null when the round side is unknown', () => {
    expect(infectedMaskForHeader(db, head(), 7, 3, 2)).toBeNull();
  });
});

describe('rewriteHead', () => {
  it('zeroes the token and stamps the mask on a slice from 0', () => {
    const b = head();
    rewriteHead(b, 0, 0b11110000);
    expect(b.subarray(TOKEN_OFFSET, TOKEN_OFFSET + TOKEN_BYTES).every((x) => x === 0)).toBe(true);
    expect(b[INFECTED_MASK_OFFSET]).toBe(0b11110000);
    expect(b[SIDES_FLAG_OFFSET]).toBe(1);
  });
  it('keeps a mask the writer already set', () => {
    const b = head({ infectedMask: 0b00001111, sidesKnown: true });
    rewriteHead(b, 0, 0b11110000);
    expect(b[INFECTED_MASK_OFFSET]).toBe(0b00001111);
  });
  it('zeroes only the token bytes a partial slice holds, and never stamps it', () => {
    const full = head();
    const from = TOKEN_OFFSET + 10;
    const slice = Buffer.from(full.subarray(from));
    rewriteHead(slice, from, 0b11110000);
    expect(slice.subarray(0, TOKEN_BYTES - 10).every((x) => x === 0)).toBe(true);
    expect(slice[INFECTED_MASK_OFFSET - from]).toBe(full[INFECTED_MASK_OFFSET]);
  });
  it('leaves a slice past the header untouched', () => {
    const b = Buffer.from([1, 2, 3]);
    rewriteHead(b, HEADER_BYTES + 5, 1);
    expect([...b]).toEqual([1, 2, 3]);
  });
});

describe('prepareForUpload', () => {
  it('returns a blanked, stamped copy and leaves the input alone', () => {
    const file = Buffer.concat([head(), Buffer.from([9, 9, 9])]);
    const out = prepareForUpload(file, 0b11110000);
    expect(out.includes(Buffer.from(TOKEN))).toBe(false);
    expect(file.includes(Buffer.from(TOKEN))).toBe(true);
    expect(out[SIDES_FLAG_OFFSET]).toBe(1);
    expect(out.subarray(HEADER_BYTES)).toEqual(file.subarray(HEADER_BYTES));
  });
});

describe('stampSidesInFile', () => {
  it('writes only bytes 156 and 157', () => {
    const p = join(dir, 'f.rpl');
    const before = Buffer.concat([head(), Buffer.from([1, 2, 3])]);
    writeFileSync(p, before);
    expect(stampSidesInFile(p, 0b11110000)).toBe(true);
    const after = readFileSync(p);
    const diff = [...after].flatMap((x, i) => (x !== before[i] ? [i] : []));
    expect(diff.every((i) => i === INFECTED_MASK_OFFSET || i === SIDES_FLAG_OFFSET)).toBe(true);
    expect(after[SIDES_FLAG_OFFSET]).toBe(1);
  });
  it('does nothing to a file that already has a mask', () => {
    const p = join(dir, 'g.rpl');
    writeFileSync(p, head({ infectedMask: 3, sidesKnown: true }));
    expect(stampSidesInFile(p, 0b11110000)).toBe(false);
    expect(readFileSync(p)[INFECTED_MASK_OFFSET]).toBe(3);
  });
});
```

Check `tests/replayPrune.test.ts` and `src/db.ts` for the exact required columns of `players`, `match_players`, `match_rounds` and adjust the seed inserts to satisfy NOT NULL constraints (keep the values above).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/replaySides.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/replaySides.ts`**

```ts
import { openSync, readSync, writeSync, closeSync } from 'node:fs';
import type { DB } from './db.js';
import {
  decodeHeader, HEADER_BYTES, TOKEN_OFFSET, TOKEN_BYTES, INFECTED_MASK_OFFSET, SIDES_FLAG_OFFSET,
} from './replayFormat.js';

/**
 * Which roster slots are infected in one round, as the header's version 3
 * side mask, or null when the database cannot say. Roster team plus the
 * round's survivor side, mapped through the file's own slot table. Moved here
 * from routes/replays.ts so the route, the upload and the one-time stamp all
 * compute it the same way.
 */
export function infectedMaskForHeader(
  db: DB, head: Buffer, matchId: number, ordinal: number, half: number,
): number | null {
  const round = db.prepare(
    'SELECT surv_team FROM match_rounds WHERE match_id = ? AND ordinal = ? AND half = ?',
  ).get(matchId, ordinal, half) as { surv_team: 'a' | 'b' } | undefined;
  if (!round) return null;
  const h = decodeHeader(head);
  if (!h) return null;
  const team = new Map(
    (db.prepare('SELECT player_id, team FROM match_players WHERE match_id = ?')
      .all(matchId) as { player_id: string; team: 'a' | 'b' }[])
      .map((r) => [r.player_id, r.team] as const),
  );
  let mask = 0;
  for (let slot = 0; slot < h.slots.length; slot++) {
    const t = team.get(h.slots[slot]);
    if (t !== undefined && t !== round.surv_team) mask |= 1 << slot;
  }
  return mask;
}

const TOKEN_END = TOKEN_OFFSET + TOKEN_BYTES;

/**
 * Rewrite the header bytes a slice holds, in place. `buf` holds file bytes
 * starting at absolute offset `start`. The token is zeroed wherever the slice
 * overlaps it (it seeds the match's server password), and a slice from 0 that
 * holds the whole header gets the side mask when the file has none.
 */
export function rewriteHead(buf: Buffer, start: number, infectedMask: number | null): void {
  const zeroFrom = Math.max(start, TOKEN_OFFSET) - start;
  const zeroTo = Math.min(start + buf.length, TOKEN_END) - start;
  if (zeroTo > zeroFrom) buf.fill(0, zeroFrom, zeroTo);
  if (infectedMask !== null && start === 0 && buf.length >= HEADER_BYTES && buf[SIDES_FLAG_OFFSET] !== 1) {
    buf[INFECTED_MASK_OFFSET] = infectedMask & 0xff;
    buf[SIDES_FLAG_OFFSET] = 1;
  }
}

/** The bytes that go to R2: a copy, token zeroed, mask stamped when missing. */
export function prepareForUpload(file: Buffer, infectedMask: number | null): Buffer {
  const out = Buffer.from(file);
  rewriteHead(out, 0, infectedMask);
  return out;
}

/** Write the mask into a file's own header, once. Touches bytes 156 and 157
 *  only, and only when the file has no mask. Returns whether it wrote. */
export function stampSidesInFile(path: string, mask: number): boolean {
  const fd = openSync(path, 'r+');
  try {
    const head = Buffer.alloc(HEADER_BYTES);
    if (readSync(fd, head, 0, HEADER_BYTES, 0) !== HEADER_BYTES) return false;
    if (head[SIDES_FLAG_OFFSET] === 1) return false;
    writeSync(fd, Buffer.from([mask & 0xff, 1]), 0, 2, INFECTED_MASK_OFFSET);
    return true;
  } finally {
    closeSync(fd);
  }
}
```

`writeSync(fd, [mask, 1], ..., INFECTED_MASK_OFFSET)` relies on `SIDES_FLAG_OFFSET === INFECTED_MASK_OFFSET + 1` (156 and 157). Assert that in a test line: `expect(SIDES_FLAG_OFFSET).toBe(INFECTED_MASK_OFFSET + 1)`.

Then in `src/routes/replays.ts`:
- Replace the body of `infectedMaskFor` with: read the header via `readRange(path, 0, HEADER_BYTES)` in a try (return null on throw, as today) and `return infectedMaskForHeader(db, head, matchId, ordinal, half);`. Keep the export and doc comment.
- In `sendSlice`, replace the manual token fill and mask stamp (the `zeroFrom`/`zeroTo` fill and the `if (infectedMask !== null && start === 0 ...)` block) with `rewriteHead(head, start, infectedMask);`. Keep `rewriteEnd`, the `readRange` of the head, and the stream of the rest exactly as they are.

- [ ] **Step 4: Run to verify pass**, including every existing route test (they pin the byte-level behaviour).

Run: `npx vitest run tests/replaySides.test.ts tests/replayRoutes.test.ts && npx vitest run && npx tsc --noEmit -p .`
Expected: all pass, no existing test changed.

- [ ] **Step 5: Commit**

```bash
git add src/replaySides.ts src/routes/replays.ts tests/replaySides.test.ts
git commit -m "Replay sides: one module for the mask, the head rewrite, the upload copy and the one-time stamp"
```

---

### Task 3: `src/replayOffload.ts`

**Files:**
- Create: `src/replayOffload.ts`
- Test: `tests/replayOffload.test.ts`

**Interfaces:**
- Consumes: `R2Ops`, `realOps` from `src/demoOffload.ts` (`put`, `head`; `remove` unused); `replayKey` (Task 1); `infectedMaskForHeader`, `prepareForUpload` (Task 2); `resolveReplayPath` from `src/replays.ts`; `decodeHeader` from `src/replayFormat.ts`.
- Produces:
  - `REPLAY_QUIET_MS = 10 * 60 * 1000`
  - `offloadReplay(db: DB, cfg: R2Config, row: { matchId: number; ordinal: number; half: number }, path: string, opts?: { ops?: R2Ops }): Promise<'uploaded' | 'failed'>`: prepares, uploads, verifies, records. Does not check eligibility.
  - `sweepReplays(db: DB, cfg: R2Config, replayDir: string, opts?: { limit?: number; nowMs?: number; ops?: R2Ops }): Promise<{ uploaded: number; skipped: number; failed: number }>`

- [ ] **Step 1: Write the failing tests** (`tests/replayOffload.test.ts`)

Build fixtures with `encodeHeader`/`encodeFrame` as in `tests/replayRoutes.test.ts` (copy its `header()` and `emptyFrame()` helpers). Fake ops capture the uploaded bytes by reading the temp file inside `put`:

```ts
function fakeOps(opts: { failPut?: boolean; lieSize?: boolean } = {}) {
  const uploads = new Map<string, Buffer>();
  const ops: R2Ops = {
    async put(_c, key, path) {
      if (opts.failPut) throw new Error('boom');
      const b = readFileSync(path); uploads.set(key, b); return { bytes: b.length };
    },
    async head(_c, key) {
      const b = uploads.get(key);
      return b ? { bytes: opts.lieSize ? b.length - 1 : b.length } : null;
    },
    async remove() { throw new Error('the sweep must never delete'); },
  };
  return { ops, uploads };
}
```

Seed with a `matches` row (`state` parameterised), a `match_replays` row and a closed file whose mtime is set with `utimesSync` to 20 minutes ago unless the test says otherwise. Tests:

```ts
it('uploads a closed, quiet replay of a finished match under the tokenless key, blanked and stamped', async () => {
  // state 'completed', closed file, mtime 20 min ago, match_rounds + match_players seeded so a mask resolves
  const r = await sweepReplays(db, CFG, dir, { ops, nowMs: Date.now() });
  expect(r).toEqual({ uploaded: 1, skipped: 0, failed: 0 });
  const body = uploads.get('replays/7/0_1.rpl')!;
  expect(body.includes(Buffer.from(TOKEN))).toBe(false);
  expect(body[SIDES_FLAG_OFFSET]).toBe(1);
  const row = db.prepare('SELECT r2_key, r2_at FROM match_replays WHERE match_id = 7').get() as any;
  expect(row.r2_key).toBe('replays/7/0_1.rpl');
  expect(row.r2_at).toBeTruthy();
  expect(existsSync(join(dir, FILE))).toBe(true);   // never deleted
});

it('also takes aborted matches', ...);               // state 'aborted' -> uploaded 1
it('skips a live match', ...);                        // state 'live' -> uploaded 0, uploads empty
it('skips a file still being written', ...);          // header frameCount 0 -> skipped 1
it('skips a file changed inside the quiet period', ...); // mtime 5 min ago -> skipped 1
it('skips rows already uploaded or already pruned', ...); // r2_key set / pruned_at set -> not selected (uploads empty)
it('leaves the row alone when the upload fails', ...);    // failPut -> failed 1, r2_key null
it('does not record an upload whose size does not match', ...); // lieSize -> failed 1, r2_key null
it('uploads without a mask when the sides are unknown, token still blanked', ...); // no match_rounds row
it('respects the limit, oldest match first', ...);   // 3 eligible across matches 5,6,7, limit 2 -> 5 and 6 uploaded
```

Write each one in full in the test file (no shared "similar" bodies); each seeds its own rows.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/replayOffload.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/replayOffload.ts`**

```ts
import { readFileSync, statSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DB } from './db.js';
import { replayKey, type R2Config } from './r2.js';
import { realOps, type R2Ops } from './demoOffload.js';
import { resolveReplayPath } from './replays.js';
import { decodeHeader, HEADER_BYTES } from './replayFormat.js';
import { infectedMaskForHeader, prepareForUpload } from './replaySides.js';

/** A replay must sit unchanged this long before it is uploaded. Chicago and
 *  Riverside rounds reach Dallas through pull timers 2 to 5 minutes after the
 *  round ends, so a younger file may still be half-copied. */
export const REPLAY_QUIET_MS = 10 * 60 * 1000;

/**
 * Upload one replay: a copy with the token zeroed and the side mask stamped,
 * then HEAD to confirm the size, then record the key. Any failure leaves the
 * row as it was. The local file is never touched; the pruner removes it once
 * the row carries a key.
 */
export async function offloadReplay(
  db: DB, cfg: R2Config, row: { matchId: number; ordinal: number; half: number },
  path: string, opts: { ops?: R2Ops } = {},
): Promise<'uploaded' | 'failed'> {
  const ops = opts.ops ?? realOps;
  const key = replayKey(row.matchId, row.ordinal, row.half);
  const tmp = mkdtempSync(join(tmpdir(), 'rplup-'));
  try {
    const file = readFileSync(path);
    const mask = infectedMaskForHeader(db, file.subarray(0, HEADER_BYTES), row.matchId, row.ordinal, row.half);
    const body = prepareForUpload(file, mask);
    const tmpPath = join(tmp, 'r.rpl');
    writeFileSync(tmpPath, body);
    await ops.put(cfg, key, tmpPath, { contentType: 'application/octet-stream' });
    const remote = await ops.head(cfg, key);
    if (!remote || remote.bytes !== body.length) {
      console.error(`[replayOffload] match ${row.matchId} ${row.ordinal}/${row.half}: uploaded ${body.length} but remote reports ${remote?.bytes ?? 'absent'}`);
      return 'failed';
    }
    db.prepare("UPDATE match_replays SET r2_key = ?, r2_at = datetime('now') WHERE match_id = ? AND ordinal = ? AND half = ?")
      .run(key, row.matchId, row.ordinal, row.half);
    return 'uploaded';
  } catch (err) {
    console.error(`[replayOffload] upload failed for match ${row.matchId} ${row.ordinal}/${row.half}:`, (err as Error).message);
    return 'failed';
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The hourly sweep: every eligible replay, oldest match first, bounded by
 *  `limit`. Never throws and never deletes. */
export async function sweepReplays(
  db: DB, cfg: R2Config, replayDir: string,
  opts: { limit?: number; nowMs?: number; ops?: R2Ops } = {},
): Promise<{ uploaded: number; skipped: number; failed: number }> {
  const out = { uploaded: 0, skipped: 0, failed: 0 };
  if (!replayDir) return out;
  const nowMs = opts.nowMs ?? Date.now();
  const rows = db.prepare(
    `SELECT r.match_id AS matchId, r.ordinal, r.half
       FROM match_replays r JOIN matches m ON m.id = r.match_id
      WHERE r.r2_key IS NULL AND r.pruned_at IS NULL
        AND m.state IN ('completed', 'aborted')
      ORDER BY r.match_id ASC, r.ordinal ASC, r.half ASC
      LIMIT ?`,
  ).all(opts.limit ?? 50) as { matchId: number; ordinal: number; half: number }[];

  for (const row of rows) {
    const found = resolveReplayPath(db, row.matchId, row.ordinal, row.half, replayDir);
    if (!found) { out.skipped++; continue; }
    try {
      if (nowMs - statSync(found.path).mtimeMs < REPLAY_QUIET_MS) { out.skipped++; continue; }
      const h = decodeHeader(readFileSync(found.path).subarray(0, HEADER_BYTES));
      if (!h || h.frameCount === 0) { out.skipped++; continue; }
    } catch { out.skipped++; continue; }
    const r = await offloadReplay(db, cfg, row, found.path, { ops: opts.ops });
    if (r === 'uploaded') out.uploaded++; else out.failed++;
  }
  if (out.uploaded > 0 || out.failed > 0) {
    console.log(`[replayOffload] ${out.uploaded} uploaded, ${out.skipped} skipped, ${out.failed} failed`);
  }
  return out;
}
```

The `limit` counts rows considered, not rows uploaded. The "respects the limit" test must seed so that the first `limit` rows are eligible.

- [ ] **Step 4: Run to verify pass**, then the full suite and typecheck.

Run: `npx vitest run tests/replayOffload.test.ts && npx vitest run && npx tsc --noEmit -p .`

- [ ] **Step 5: Commit**

```bash
git add src/replayOffload.ts tests/replayOffload.test.ts
git commit -m "Replay offload: upload finished, quiet replays to R2, blanked and stamped, and record the key"
```

---

### Task 4: Serve an R2-only replay through the same slice

**Files:**
- Modify: `src/routes/replays.ts` (`replayRoutes` options at ~249-252; the `/api/replays/match/:id/:ordinal/:half` handler at ~373-386)
- Test: `tests/replayRoutes.test.ts` (new `describe` at the end)

**Interfaces:**
- Consumes: `getRange` and `R2Config` (Task 1), `rewriteHead`, `infectedMaskForHeader` (Task 2).
- Produces: `replayRoutes` options gain `r2?: R2Config | null` and `r2Get?: typeof getRange` (injected for tests; defaults to the real `getRange`).

- [ ] **Step 1: Write the failing tests** (append to `tests/replayRoutes.test.ts`)

The helper registers a second app with `r2` and a fake `r2Get` that serves a stored buffer by key. For each case, write a closed round, seed its row as `completed`, request it from the local app, then move the file away, set `r2_key`, store the SAME prepared bytes the uploader would store (`prepareForUpload(fileBytes, null)`) under that key, and request it from the R2 app. Compare status, body and the three headers.

```ts
describe('GET /api/replays/match/:id/:ordinal/:half from R2', () => {
  async function appWithR2(store: Map<string, Buffer>, fail = false) {
    const a = Fastify();
    const r2Get = async (_cfg: unknown, key: string, from: number) => {
      if (fail) throw new Error('r2 down');
      const b = store.get(key);
      if (!b) return null;
      return { body: b.subarray(Math.min(from, b.length)), total: b.length };
    };
    await a.register(replayRoutes, { db, replayDir: dir, r2: CFG, r2Get: r2Get as never });
    await a.ready();
    return a;
  }

  for (const since of [0, 40, 400, 100000]) {
    it(`answers exactly as the local file did, since=${since}`, async () => {
      const name = `pug_${'c'.repeat(32)}_0_1.rpl`;
      writeRound(name, 20, 3600, true);
      const id = seedMatchReplay(name, 0, 1, 0, 20);
      db.prepare("UPDATE matches SET state = 'completed' WHERE id = ?").run(id);
      const local = await app.inject({ url: `/api/replays/match/${id}/0/1?since=${since}` });

      const bytes = readFileSync(join(dir, name));
      rmSync(join(dir, name));
      const key = `replays/${id}/0_1.rpl`;
      db.prepare('UPDATE match_replays SET r2_key = ? WHERE match_id = ?').run(key, id);
      const store = new Map([[key, prepareForUpload(bytes, null)]]);
      const a = await appWithR2(store);
      const remote = await a.inject({ url: `/api/replays/match/${id}/0/1?since=${since}` });
      await a.close();

      expect(remote.statusCode).toBe(local.statusCode);
      expect(remote.rawPayload.equals(local.rawPayload)).toBe(true);
      for (const h of ['x-replay-next', 'x-replay-closed', 'cache-control', 'content-type', 'content-length']) {
        expect(remote.headers[h], h).toBe(local.headers[h]);
      }
    });
  }

  it('404s, as for a pruned replay, when R2 fails', async () => { /* same setup, appWithR2(store, true), expect 404 */ });
  it('404s when the row has no r2_key and no local file', async () => { /* expect 404 */ });
  it('prefers the local file when both exist', async () => { /* store holds different bytes; response equals local */ });
  it('never consults R2 when r2 is not configured', async () => { /* the default `app` from beforeEach: file removed, r2_key set -> 404 */ });
});
```

`CFG` is a local `R2Config` literal (copy the one from `tests/demoOffload.test.ts`). Write the four short cases in full.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/replayRoutes.test.ts`
Expected: the new cases FAIL (404 where a body is expected, and the `r2`/`r2Get` options are unknown to the type checker).

- [ ] **Step 3: Implement**

In `replayRoutes` options: `opts: { db: DB; replayDir: string; liveDir?: string; r2?: R2Config | null; r2Get?: typeof getRange }`, with `const { r2 = null, r2Get = getRange } = opts;`.

Add beside `sendSlice`:

```ts
/**
 * A finished replay that only R2 still holds, answered exactly as sendSlice
 * answers the same closed file from disk: same headers, same bytes, token
 * blanked, side mask stamped by the same rewrite. The object is already
 * blanked and stamped at upload, so the rewrite is a safety net here.
 */
async function sendR2Slice(
  reply: FastifyReply, cfg: R2Config, get: typeof getRange, key: string, since: number,
  mask: (head: Buffer) => number | null,
): Promise<FastifyReply> {
  // Same `since` handling as sendSlice: NaN, negative and fractional values
  // come from malformed requests and must not error.
  const from = Number.isFinite(since) && since > 0 ? Math.floor(since) : 0;
  const got = await get(cfg, key, from);
  if (!got) return reply.code(404).send({ error: 'no such replay' });
  const start = Math.min(from, got.total);
  const body = Buffer.from(got.body);
  const m = start === 0 && body.length >= HEADER_BYTES ? mask(body.subarray(0, HEADER_BYTES)) : null;
  rewriteHead(body, start, m);
  reply.header('Content-Type', 'application/octet-stream');
  reply.header('Cache-Control', 'no-store');
  reply.header('X-Replay-Next', String(got.total));
  reply.header('X-Replay-Closed', '1');
  reply.header('Content-Length', String(body.length));
  return reply.send(body);
}
```

For a `since` past the end, `getRange` answers 416 as an empty body plus the total, so this sends an empty body with `X-Replay-Next` equal to the total, which is what `sendSlice` sends for the same request on a closed file.

In the match handler, after `const found = ...` and before the 404:

```ts
    if (!found && r2) {
      const keyRow = db.prepare(
        `SELECT r.r2_key AS key FROM match_replays r JOIN matches m ON m.id = r.match_id
          WHERE r.match_id = ? AND r.ordinal = ? AND r.half = ?
            AND r.r2_key IS NOT NULL AND m.state IN ('completed', 'aborted')`,
      ).get(Number(id), Number(ordinal), Number(half)) as { key: string } | undefined;
      if (keyRow) {
        try {
          return await sendR2Slice(reply, r2, r2Get, keyRow.key, Number(since ?? 0),
            (head) => infectedMaskForHeader(db, head, Number(id), Number(ordinal), Number(half)));
        } catch (err) {
          console.error('[replays] R2 read failed:', (err as Error).message);
          return reply.code(404).send({ error: 'no such replay' });
        }
      }
    }
```

`found` is null only when neither the replay directory nor the live directory holds the round (the existing `resolveFurther`/`liveRoundFor` logic runs first and is unchanged), so a local copy always wins and a live match can never reach R2: the query also requires a finished match.

- [ ] **Step 4: Run to verify pass**, then the full suite and typecheck.

Run: `npx vitest run tests/replayRoutes.test.ts && npx vitest run && npx tsc --noEmit -p .`

- [ ] **Step 5: Commit**

```bash
git add src/routes/replays.ts tests/replayRoutes.test.ts
git commit -m "Serve a finished replay from R2 when the local file is gone, byte for byte as from disk"
```

---

### Task 5: The pruner only deletes replays that are in R2

**Files:**
- Modify: `src/replayPrune.ts` (`planPrune` signature and query; `pruneReplays` signature)
- Test: `tests/replayPrune.test.ts`

**Interfaces:**
- Produces: `planPrune(db, dir, now, retentionDays, freeBytes, floorBytes, opts?: { requireOffloaded?: boolean })`; `pruneReplays(db, dir, opts?: { requireOffloaded?: boolean })`.

- [ ] **Step 1: Write the failing tests** (append to `tests/replayPrune.test.ts`, reusing its seed helpers)

```ts
describe('with R2 configured (requireOffloaded)', () => {
  it('never selects a replay that has no r2_key, by window or by floor', () => {
    // two old rows past the retention window, one with r2_key, one without; free bytes below the floor
    const plan = planPrune(db, dir, now, 90, 0, 10e9, { requireOffloaded: true });
    expect(plan.map((c) => c.filename)).toEqual([OFFLOADED_NAME]);
  });
  it('still selects offloaded replays for the floor, oldest first', () => { /* floor sweep over offloaded rows only */ });
  it('behaves exactly as before without the option', () => { /* same fixture, no opts: both selected */ });
});
```

Write them in full using the file's existing fixture helpers (read the top of `tests/replayPrune.test.ts` first).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/replayPrune.test.ts`

- [ ] **Step 3: Implement**

Add the option and put `AND (? = 0 OR r.r2_key IS NOT NULL)` into the `WHERE` of the `planPrune` query, binding `opts.requireOffloaded ? 1 : 0`. `pruneReplays(db, dir, opts = {})` passes `opts` through to `planPrune`. Extend the doc comment on `planPrune` with one paragraph: with R2 configured a replay is only ever eligible once it is in R2, because on 2026-09-23 an unreachable floor deleted 559 replays that existed nowhere else.

- [ ] **Step 4: Run to verify pass**, full suite, typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/replayPrune.ts tests/replayPrune.test.ts
git commit -m "Replay prune: with R2 configured, only replays already in R2 can be deleted"
```

---

### Task 6: Wire it into the server

**Files:**
- Modify: `src/server.ts` (the daily prune timer ~1190-1195, the offload timer ~1204-1216, the boot prune ~1224-1230, `replayRoutes` registration ~1428)
- Test: `tests/server.test.ts` only if an existing test covers the timers; otherwise the wiring is covered by typecheck and the Task 3 to 5 tests.

- [ ] **Step 1: Implement**

- Every `pruneReplays(deps.db, deps.config.replayDir)` call becomes `pruneReplays(deps.db, deps.config.replayDir, { requireOffloaded: r2 !== null })`. Check both the daily timer and the boot run; `r2` is the value read once near line 368.
- Inside `if (r2) { ... }` on the offload timer, after the `sweepDemos` call:

```ts
      void sweepReplays(deps.db, r2, deps.config.replayDir)
        .catch((err) => console.error('[replayOffload] sweep failed:', err));
```

- Add one boot run of the replay sweep in the same `setTimeout` that prunes on boot, BEFORE the prune calls, guarded by `if (r2)`, with the same `void ... .catch(...)` form, so a restart uploads before it prunes.
- `replayRoutes` registration gains `r2`.

- [ ] **Step 2: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit -p .`

- [ ] **Step 3: Commit**

```bash
git add src/server.ts
git commit -m "Run the replay sweep hourly and on boot, and serve and prune with R2 in mind"
```

---

### Task 7: The one-time scripts

**Files:**
- Create: `scripts/stamp-replay-sides.ts`
- Create: `scripts/offload-replays.ts`
- Test: none beyond Tasks 2 and 3 (the scripts are thin shells over tested functions); verify by running each with no `--commit` against a copy of a database and a temp directory.

Read `scripts/offload-demos.ts` first and follow its shape: `loadDotEnv` from `scripts/dotenv.ts`, `openDb` on the configured `DB_PATH`, `r2FromEnv()`.

- [ ] **Step 1: `scripts/stamp-replay-sides.ts <dir> [--commit]`**

For every `match_replays` row whose `filename` exists in `<dir>` (validate the name with the same `NAME_RE` the pruner uses, basename only): read the header; skip when the sides flag is 1; compute `infectedMaskForHeader`; skip when null; with `--commit` call `stampSidesInFile`. Print one line per match (`match N: stamped K, already had M, unknown U`) and a total. Dry run by default.

- [ ] **Step 2: `scripts/offload-replays.ts [--limit N] [--backups <dir>] [--commit]`**

- Without `--backups`: with `--commit`, `await sweepReplays(db, cfg, replayDir, { limit })` and print the result; without, list what would be eligible (same query and checks as the sweep, no upload).
- With `--backups <dir>`: rows with `pruned_at IS NOT NULL AND r2_key IS NULL` whose file exists in `<dir>` (validated name); with `--commit` call `offloadReplay(db, cfg, row, path)` for each; print counts. These rows keep `pruned_at` (the local copy on the box is gone); `r2_key` makes them servable.

- [ ] **Step 3: Dry-run both against a temp copy**

```bash
cp /path/to/a/local/scratch.db /tmp/rpl-test.db   # any DB built by the test helpers is fine
DB_PATH=/tmp/rpl-test.db npx tsx scripts/stamp-replay-sides.ts /tmp/some-replays
DB_PATH=/tmp/rpl-test.db npx tsx scripts/offload-replays.ts --limit 5
```

Expected: each prints its plan and changes nothing.

- [ ] **Step 4: Full suite, typecheck, commit**

```bash
git add scripts/stamp-replay-sides.ts scripts/offload-replays.ts
git commit -m "Scripts: stamp replay sides once, and offload replays or their backups to R2"
```

---

## Rollout (not a task for the implementer; the controller does this with the owner's go-ahead)

1. Merge to master, `deploy-web.sh` with no players in game and a DB backup first. The first sweep runs on boot.
2. On the box: `stamp-replay-sides.ts` dry run, then `--commit` on the replay dir. Locally: the same on `backups/replays` against a DB copy is not needed; the backups upload path stamps as it uploads.
3. `offload-replays.ts --limit 1000 --commit` on the box, then `--backups` from the workstation's `backups/replays` (copy the files to the box first, or run the script locally with the production `.env`'s R2 values against a DB copy and then write the resulting `r2_key`s to production; decide at rollout).
4. Verify: a pruned-on-box match's replay plays in the viewer, byte-identical to a local fetch of its backup (token blanked).
