import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { offloadMatchDemos, sweepDemos, friendlyName, type R2Ops } from '../src/demoOffload.js';
import { r2FromEnv, encodeKey, demoKey, overviewKey, OVERVIEW_CACHE_CONTROL, signRequest, type R2Config } from '../src/r2.js';

const CFG: R2Config = {
  endpoint: 'https://acct.r2.cloudflarestorage.com',
  bucket: 'riverside-demos',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'SECRETEXAMPLE',
  publicUrl: 'https://pub-abc.r2.dev',
};

const TOKEN = 'a'.repeat(32);

let db: DB;
let dir: string;

/** A fake bucket: records every call, and can be told to fail or to lie about
 *  a stored size, which is how the ordering rules get tested. */
function fakeOps(over: Partial<R2Ops> & { storedBytes?: (key: string) => number | null } = {}) {
  const calls: string[] = [];
  const stored = new Map<string, number>();
  const ops: R2Ops = {
    async put(_cfg, key, _path, o) {
      calls.push(`put:${key}:${o.contentDisposition ?? ''}`);
      stored.set(key, over.storedBytes ? (over.storedBytes(key) ?? 0) : 999);
      return { bytes: 999 };
    },
    async head(_cfg, key) {
      calls.push(`head:${key}`);
      const b = stored.get(key);
      return b === undefined ? null : { bytes: b };
    },
    async remove(path) { calls.push(`remove:${path}`); rmSync(path, { force: true }); },
    ...over,
  };
  return { ops, calls, stored };
}

function seedMatch(id: number, state: string, maps: number, sizes: number[] = []) {
  db.prepare("INSERT INTO matches (id, season_id, state, campaign, token) VALUES (?, 1, ?, 'dead_air', ?)")
    .run(id, state, TOKEN);
  for (let o = 0; o < maps; o++) {
    const name = `pug_${TOKEN}_${o}_l4d_vs_airport0${o + 1}_x.dem`;
    const bytes = sizes[o] ?? 100;
    writeFileSync(join(dir, name), 'x'.repeat(bytes));
    db.prepare('INSERT INTO match_demos (match_id, ordinal, map, filename, bytes) VALUES (?, ?, ?, ?, ?)')
      .run(id, o, `m${o}`, name, bytes);
  }
}

beforeEach(() => {
  db = openDb(':memory:');
  dir = mkdtempSync(join(tmpdir(), 'demooffload-'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('r2FromEnv', () => {
  const full = {
    R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com/',
    R2_BUCKET: 'riverside-demos',
    R2_ACCESS_KEY_ID: 'k',
    R2_SECRET_ACCESS_KEY: 's',
    R2_PUBLIC_URL: 'https://pub-abc.r2.dev/',
  };

  it('reads a full config and strips trailing slashes', () => {
    const cfg = r2FromEnv(full)!;
    expect(cfg.endpoint).toBe('https://acct.r2.cloudflarestorage.com');
    expect(cfg.publicUrl).toBe('https://pub-abc.r2.dev');
  });

  it('is null when ANY single variable is missing', () => {
    // A half-configured bucket is worse than none: an upload that silently
    // no-ops while the caller deletes the local file would lose demos.
    for (const k of Object.keys(full)) {
      const partial = { ...full, [k]: '' };
      expect(r2FromEnv(partial), `${k} missing should disable R2`).toBeNull();
    }
  });
});

describe('key handling', () => {
  it('encodes each segment but keeps the separators', () => {
    expect(encodeKey('demos/12/pug_a b.dem')).toBe('demos/12/pug_a%20b.dem');
    expect(encodeKey('demos/12/x.dem').split('/')).toHaveLength(3);
  });

  it('groups a demo under its match', () => {
    expect(demoKey(37, 'pug_x_0_map.dem')).toBe('demos/37/pug_x_0_map.dem');
  });

  it('names downloads the way playdemo can actually be typed', () => {
    // Ordinal is zero-based on the wire and one-based to a human.
    expect(friendlyName(8, 0)).toBe('pug8-1.dem');
    expect(friendlyName(37, 3)).toBe('pug37-4.dem');
  });
});

describe('signRequest', () => {
  const at = new Date('2026-09-17T20:00:00.000Z');

  it('produces a deterministic signature for fixed inputs', () => {
    const a = signRequest(CFG, { method: 'PUT', path: '/b/k', headers: {}, payloadHash: 'UNSIGNED-PAYLOAD', now: at });
    const b = signRequest(CFG, { method: 'PUT', path: '/b/k', headers: {}, payloadHash: 'UNSIGNED-PAYLOAD', now: at });
    expect(a.Authorization).toBe(b.Authorization);
    expect(a.Authorization).toContain('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260917/auto/s3/aws4_request');
  });

  it('signs every header it sends, so nothing can be added afterwards', () => {
    const h = signRequest(CFG, {
      method: 'PUT', path: '/b/k', payloadHash: 'UNSIGNED-PAYLOAD', now: at,
      headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment' },
    });
    const signed = /SignedHeaders=([^,]+)/.exec(h.Authorization)![1].split(';');
    for (const k of Object.keys(h)) {
      if (k === 'Authorization') continue;
      expect(signed, `${k} is sent but not signed`).toContain(k.toLowerCase());
    }
  });

  it('changes the signature when the payload hash changes', () => {
    const a = signRequest(CFG, { method: 'PUT', path: '/b/k', headers: {}, payloadHash: 'UNSIGNED-PAYLOAD', now: at });
    const b = signRequest(CFG, { method: 'PUT', path: '/b/k', headers: {}, payloadHash: 'abc', now: at });
    expect(a.Authorization).not.toBe(b.Authorization);
  });
});

describe('offloadMatchDemos', () => {
  it('uploads, verifies, records the key and reclaims the file', async () => {
    seedMatch(1, 'completed', 2, [100, 200]);
    const { ops, calls } = fakeOps({ storedBytes: (k) => (k.endsWith('_0_l4d_vs_airport01_x.dem') ? 100 : 200) });

    const r = await offloadMatchDemos(db, CFG, 1, dir, { deleteLocal: true, ops });

    expect(r).toMatchObject({ uploaded: 2, failed: 0 });
    expect(r.bytes).toBe(300);
    const rows = db.prepare('SELECT ordinal, r2_key AS k, r2_at AS at FROM match_demos ORDER BY ordinal').all() as
      { ordinal: number; k: string | null; at: string | null }[];
    expect(rows.every((x) => x.k !== null && x.at !== null)).toBe(true);
    expect(rows[0].k).toBe(`demos/1/pug_${TOKEN}_0_l4d_vs_airport01_x.dem`);
    expect(existsSync(join(dir, `pug_${TOKEN}_0_l4d_vs_airport01_x.dem`))).toBe(false);
    // The friendly name travels with the object, which is what makes the
    // redirect usable from the Source console.
    expect(calls.some((c) => c.includes('pug1-1.dem'))).toBe(true);
  });

  it('keeps the local file and records nothing when the upload throws', async () => {
    seedMatch(1, 'completed', 1);
    const { ops } = fakeOps({ put: async () => { throw new Error('network down'); } });

    const r = await offloadMatchDemos(db, CFG, 1, dir, { deleteLocal: true, ops });

    expect(r).toMatchObject({ uploaded: 0, failed: 1 });
    expect(db.prepare('SELECT r2_key AS k FROM match_demos').get()).toEqual({ k: null });
    expect(existsSync(join(dir, `pug_${TOKEN}_0_l4d_vs_airport01_x.dem`))).toBe(true);
  });

  it('keeps the local file when the remote size does not match', async () => {
    // The dangerous case: a PUT that returns success having stored a truncated
    // body. Verifying before recording is what catches it.
    seedMatch(1, 'completed', 1, [500]);
    const { ops } = fakeOps({ storedBytes: () => 12 });

    const r = await offloadMatchDemos(db, CFG, 1, dir, { deleteLocal: true, ops });

    expect(r).toMatchObject({ uploaded: 0, failed: 1 });
    expect(db.prepare('SELECT r2_key AS k FROM match_demos').get()).toEqual({ k: null });
    expect(existsSync(join(dir, `pug_${TOKEN}_0_l4d_vs_airport01_x.dem`))).toBe(true);
  });

  it('keeps the local file when the object is not there at all', async () => {
    seedMatch(1, 'completed', 1);
    const { ops } = fakeOps({ head: async () => null });
    const r = await offloadMatchDemos(db, CFG, 1, dir, { deleteLocal: true, ops });
    expect(r.failed).toBe(1);
    expect(existsSync(join(dir, `pug_${TOKEN}_0_l4d_vs_airport01_x.dem`))).toBe(true);
  });

  it('never deletes before it has verified', async () => {
    seedMatch(1, 'completed', 1);
    const { ops, calls } = fakeOps({ storedBytes: () => 100 });
    await offloadMatchDemos(db, CFG, 1, dir, { deleteLocal: true, ops });
    const order = calls.map((c) => c.split(':')[0]);
    expect(order).toEqual(['put', 'head', 'remove']);
  });

  it('leaves the file alone without deleteLocal, so a first pass can be checked by hand', async () => {
    seedMatch(1, 'completed', 1);
    const { ops } = fakeOps({ storedBytes: () => 100 });
    const r = await offloadMatchDemos(db, CFG, 1, dir, { ops });
    expect(r.uploaded).toBe(1);
    expect(r.bytes).toBe(0);
    expect(existsSync(join(dir, `pug_${TOKEN}_0_l4d_vs_airport01_x.dem`))).toBe(true);
    expect((db.prepare('SELECT r2_key AS k FROM match_demos').get() as { k: string }).k).toBeTruthy();
  });

  it('does not re-upload a demo already in R2', async () => {
    seedMatch(1, 'completed', 1);
    db.prepare("UPDATE match_demos SET r2_key = 'demos/1/x.dem'").run();
    const { ops, calls } = fakeOps();
    const r = await offloadMatchDemos(db, CFG, 1, dir, { ops });
    expect(r).toMatchObject({ uploaded: 0, skipped: 1 });
    expect(calls.filter((c) => c.startsWith('put:'))).toHaveLength(0);
  });

  it('reclaims on a second pass, verifying the remote copy first', async () => {
    seedMatch(1, 'completed', 1, [100]);
    const { ops, calls, stored } = fakeOps({ storedBytes: () => 100 });
    await offloadMatchDemos(db, CFG, 1, dir, { ops });
    expect(existsSync(join(dir, `pug_${TOKEN}_0_l4d_vs_airport01_x.dem`))).toBe(true);

    calls.length = 0;
    stored.set(`demos/1/pug_${TOKEN}_0_l4d_vs_airport01_x.dem`, 100);
    const r = await offloadMatchDemos(db, CFG, 1, dir, { deleteLocal: true, ops });

    expect(r.bytes).toBe(100);
    expect(existsSync(join(dir, `pug_${TOKEN}_0_l4d_vs_airport01_x.dem`))).toBe(false);
    expect(calls.map((c) => c.split(':')[0])).toEqual(['head', 'remove']);
  });

  it('refuses to reclaim on a second pass when the remote copy has gone', async () => {
    seedMatch(1, 'completed', 1);
    db.prepare("UPDATE match_demos SET r2_key = 'demos/1/gone.dem'").run();
    const { ops } = fakeOps({ head: async () => null });
    const r = await offloadMatchDemos(db, CFG, 1, dir, { deleteLocal: true, ops });
    expect(r.failed).toBe(1);
    expect(existsSync(join(dir, `pug_${TOKEN}_0_l4d_vs_airport01_x.dem`))).toBe(true);
  });

  it('does nothing without a demo directory', async () => {
    seedMatch(1, 'completed', 1);
    const { ops, calls } = fakeOps();
    expect(await offloadMatchDemos(db, CFG, 1, '', { ops })).toMatchObject({ uploaded: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe('sweepDemos', () => {
  it('takes completed and aborted matches, oldest first', async () => {
    seedMatch(3, 'completed', 1);
    seedMatch(1, 'aborted', 1);
    seedMatch(2, 'completed', 1);
    const { ops, calls } = fakeOps({ storedBytes: () => 100 });

    await sweepDemos(db, CFG, dir, { ops });

    const puts = calls.filter((c) => c.startsWith('put:')).map((c) => c.split('/')[1]);
    expect(puts).toEqual(['1', '2', '3']);
  });

  it('leaves a live or configuring match alone', async () => {
    // Its demos are still being written; the highest ordinal is the file srcds
    // has open.
    seedMatch(1, 'live', 1);
    seedMatch(2, 'configuring', 1);
    const { ops, calls } = fakeOps();
    const r = await sweepDemos(db, CFG, dir, { ops });
    expect(r.uploaded).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('ignores already-uploaded matches by default, so the budget reaches new ones', async () => {
    seedMatch(1, 'completed', 1);
    db.prepare("UPDATE match_demos SET r2_key = 'demos/1/x.dem' WHERE match_id = 1").run();
    seedMatch(2, 'completed', 1);
    const { ops, calls } = fakeOps({ storedBytes: () => 100 });

    await sweepDemos(db, CFG, dir, { ops, deleteLocal: true });

    // Only match 2 is touched: match 1 has a key, and in steady state a row
    // with a key has no local file left to collect.
    expect(calls.filter((c) => c.startsWith('put:'))).toHaveLength(1);
    expect(calls.some((c) => c.includes('demos/2/'))).toBe(true);
  });

  it('reclaims already-uploaded demos when asked, which is the second migration pass', async () => {
    // The state a first pass run WITHOUT --delete leaves behind: every row has
    // a key and every local file is still there. Without includeUploaded the
    // query matches nothing and the space is never reclaimed.
    seedMatch(1, 'completed', 2, [100, 200]);
    // The fake must report each object at its real local size, or the first
    // pass refuses the mismatch and never records a key.
    const sizeOf = (k: string) => (k.endsWith('_0_l4d_vs_airport01_x.dem') ? 100 : 200);
    const first = fakeOps({ storedBytes: sizeOf });
    await sweepDemos(db, CFG, dir, { ops: first.ops });
    expect(existsSync(join(dir, `pug_${TOKEN}_0_l4d_vs_airport01_x.dem`))).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_demos WHERE r2_key IS NOT NULL').get()).toEqual({ n: 2 });

    const second = fakeOps();
    second.stored.set(`demos/1/pug_${TOKEN}_0_l4d_vs_airport01_x.dem`, 100);
    second.stored.set(`demos/1/pug_${TOKEN}_1_l4d_vs_airport02_x.dem`, 200);

    const r = await sweepDemos(db, CFG, dir, { ops: second.ops, deleteLocal: true, includeUploaded: true });

    expect(r.bytes).toBe(300);
    expect(existsSync(join(dir, `pug_${TOKEN}_0_l4d_vs_airport01_x.dem`))).toBe(false);
    expect(existsSync(join(dir, `pug_${TOKEN}_1_l4d_vs_airport02_x.dem`))).toBe(false);
    // Nothing was re-uploaded; each was verified and then removed.
    expect(second.calls.filter((c) => c.startsWith('put:'))).toHaveLength(0);
  });

  it('bounds one sweep so a backlog does not hold the process', async () => {
    for (let i = 1; i <= 5; i++) seedMatch(i, 'completed', 1);
    const { ops, calls } = fakeOps({ storedBytes: () => 100 });
    await sweepDemos(db, CFG, dir, { ops, limit: 2 });
    expect(calls.filter((c) => c.startsWith('put:'))).toHaveLength(2);
  });

  it('one match failing does not stop the rest of the sweep', async () => {
    seedMatch(1, 'completed', 1);
    seedMatch(2, 'completed', 1);
    const f = fakeOps({ storedBytes: () => 100 });
    // Wrap rather than replace, so the surviving call still records into the
    // fake bucket and can be verified the way a real one would be.
    let first = true;
    const realPut = f.ops.put.bind(f.ops);
    f.ops.put = async (c, key, path, o) => {
      if (first) { first = false; throw new Error('flaky'); }
      return realPut(c, key, path, o);
    };
    const r = await sweepDemos(db, CFG, dir, { ops: f.ops });
    expect(r.failed).toBe(1);
    expect(r.uploaded).toBe(1);
  });
});

describe('overview objects', () => {
  it('keys a layer under its own prefix, clear of demos/', () => {
    expect(overviewKey('l4d_vs_farm01_hilltop_z+0326.16x.webp'))
      .toBe('overviews/l4d_vs_farm01_hilltop_z+0326.16x.webp');
  });

  it('encodes the + in a cut height without eating the prefix slash', () => {
    expect(encodeKey(overviewKey('l4d_vs_farm01_hilltop_z+0326.16x.webp')))
      .toBe('overviews/l4d_vs_farm01_hilltop_z%2B0326.16x.webp');
  });

  it('caches hard, because a name never changes meaning', () => {
    expect(OVERVIEW_CACHE_CONTROL).toContain('immutable');
  });
});
