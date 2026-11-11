import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import cookie from '@fastify/cookie';
import type { WebSocket } from 'ws';
import { openDb, type DB } from '../src/db.js';
import { CLIENT_STALL_MS, DemoFeed, Recording, liveDemoFileName, steadyNow } from '../src/demoLive.js';
import { MAX_STREAMS_PER_IP, demoLiveRoutes } from '../src/routes/demoLive.js';
import { HEADER_BYTES } from '../src/demoFrames.js';
import { DEFAULT_DELAY_MS } from '../src/replayTail.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { stubOrchestrator } from './helpers.js';

const TOKEN = 'b'.repeat(32);
const OTHER = 'c'.repeat(32);
const T0 = 1_800_000_000_000;

// ---------------------------------------------------------------- a small synthetic demo

function demoHeader(map = 'l4d_vs_hospital01_apartment', server = 'Riverside'): Buffer {
  const h = Buffer.alloc(HEADER_BYTES);
  h.write('HL2DEMO\0', 0, 'latin1');
  h.writeInt32LE(3, 8);
  h.writeInt32LE(37, 12);
  h.write(server, 16, 'latin1');
  h.write('SourceTV', 16 + 260, 'latin1');
  h.write(map, 16 + 520, 'latin1');
  h.write('left4dead', 16 + 780, 'latin1');
  return h;
}
/** A dem_packet frame at `tick` with `n` payload bytes. */
function packet(tick: number, n = 200, fill = 0x41): Buffer {
  const f = Buffer.alloc(6 + 304 + 8 + 4 + n, fill);
  f[0] = 2;
  f.writeInt32LE(tick, 1);
  f[5] = 0;
  f.fill(0, 6, 6 + 304 + 8);
  f.writeInt32LE(n, 6 + 304 + 8);
  return f;
}
const stopFrame = (tick: number) => { const f = Buffer.alloc(6); f[0] = 7; f.writeInt32LE(tick, 1); return f; };
function demo(frames: number, fill = 0x41, map?: string): Buffer {
  return Buffer.concat([demoHeader(map), ...Array.from({ length: frames }, (_, i) => packet(100 + i, 200, fill))]);
}

// ---------------------------------------------------------------- fixtures

let dir: string;
let liveDir: string;
let demoDir: string;
let db: DB;
let clock: number;
let free: number;
let feed: DemoFeed;
let app: FastifyInstance;

function seedMatch(state: string, token = TOKEN, visibility = 'public'): number {
  return Number(db.prepare(
    `INSERT INTO matches (season_id, state, campaign, token, visibility) VALUES (1, ?, 'no_mercy', ?, ?)`,
  ).run(state, token, visibility).lastInsertRowid);
}
function setState(id: number, state: string): void {
  db.prepare('UPDATE matches SET state = ? WHERE id = ?').run(state, id);
}

async function makeApp(over: Partial<ConstructorParameters<typeof DemoFeed>[0]> = {}): Promise<void> {
  feed = new DemoFeed({ db, liveDir, demoDir, now: () => clock, freeBytes: () => free, ...over });
  app = Fastify();
  await app.register(cookie, { secret: 'x'.repeat(32) });
  await app.register(websocket);
  await app.register(demoLiveRoutes, { db, feed });
  await app.ready();
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'demolive-'));
  liveDir = join(dir, 'live');
  demoDir = join(dir, 'demos');
  mkdirSync(demoDir);
  db = openDb(':memory:');
  clock = T0;
  free = 100e9;
  await makeApp();
});
afterEach(async () => {
  feed.stop();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

function push(offset: number, data: Buffer, over: Record<string, string> = {}, extra: { url?: string } = {}) {
  return app.inject({
    method: 'POST', url: extra.url ?? '/api/demos/push',
    headers: {
      'content-type': 'application/octet-stream',
      'x-demo-token': TOKEN, 'x-demo-ordinal': '1', 'x-demo-map': 'l4d_vs_hospital01_apartment',
      'x-demo-offset': String(offset), 'x-demo-started': '1000', ...over,
    },
    payload: data,
  });
}

/** Every text and binary message a WebSocket viewer gets, in order. */
interface WsLog { ws: WebSocket; msgs: (string | Buffer)[]; bytes: () => Buffer; texts: () => any[]; closed: () => boolean }
async function openWs(matchId: number, query = ''): Promise<WsLog> {
  const msgs: (string | Buffer)[] = [];
  let closed = false;
  const ws = await app.injectWS(`/api/demos/live/match/${matchId}/ws${query}`, {}, {
    onInit: (w: WebSocket) => {
      w.on('message', (d: Buffer, isBinary: boolean) => msgs.push(isBinary ? Buffer.from(d) : d.toString()));
      w.on('close', () => { closed = true; });
    },
  });
  return {
    ws, msgs,
    bytes: () => Buffer.concat(msgs.filter((m): m is Buffer => Buffer.isBuffer(m))),
    texts: () => msgs.filter((m): m is string => typeof m === 'string').map((s) => JSON.parse(s)),
    closed: () => closed,
  };
}
const settle = () => new Promise((r) => setTimeout(r, 30));
async function tickAt(t: number): Promise<void> {
  clock = t;
  feed.tick(t);
  await settle();
}

// ---------------------------------------------------------------- the delay

describe('Recording release', () => {
  it('never releases a byte before it is DEFAULT_DELAY_MS old', () => {
    expect(DEFAULT_DELAY_MS).toBe(10_000);
    const rec = new Recording(TOKEN, 1, 'push', 1);
    const arrived: [number, number][] = [];   // [end, time]
    let len = 0, t = T0;
    // Irregular arrivals, released checked at irregular times in between.
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let i = 0; i < 400; i++) {
      t += Math.floor(rnd() * 1500);
      if (rnd() < 0.6) {
        const n = 1 + Math.floor(rnd() * 5000);
        rec.append(Buffer.alloc(n, 1), t);
        len += n;
        arrived.push([len, t]);
      }
      rec.release(t, DEFAULT_DELAY_MS);
      // The last byte out must have arrived at least the delay ago.
      if (rec.released > 0) {
        const range = arrived.find(([end]) => end >= rec.released)!;
        expect(range[1]).toBeLessThanOrEqual(t - DEFAULT_DELAY_MS);
      }
      // And everything that old is out.
      const due = arrived.filter(([, at]) => at <= t - DEFAULT_DELAY_MS).pop();
      expect(rec.released).toBe(due ? due[0] : 0);
    }
  });

  it('holds back to the exact millisecond', () => {
    const rec = new Recording(TOKEN, 1, 'push', 1);
    rec.append(Buffer.alloc(5000), T0);
    rec.release(T0 + DEFAULT_DELAY_MS - 1, DEFAULT_DELAY_MS);
    expect(rec.released).toBe(0);
    rec.release(T0 + DEFAULT_DELAY_MS, DEFAULT_DELAY_MS);
    expect(rec.released).toBe(5000);
  });

  it('releases nothing for a delay of zero or less', () => {
    const rec = new Recording(TOKEN, 1, 'push', 1);
    rec.append(Buffer.alloc(10), T0);
    for (const d of [0, -1, NaN]) expect(rec.releasable(T0 + 1e9, d)).toBe(0);
  });

  it('a clock stepping backwards cannot date new bytes before older ones', () => {
    const rec = new Recording(TOKEN, 1, 'push', 1);
    rec.append(Buffer.alloc(10), T0);
    rec.append(Buffer.alloc(10), T0 - 60_000);
    rec.release(T0 + DEFAULT_DELAY_MS - 1, DEFAULT_DELAY_MS);
    expect(rec.released).toBe(0);
    rec.release(T0 + DEFAULT_DELAY_MS, DEFAULT_DELAY_MS);
    expect(rec.released).toBe(20);
  });
});

// ---------------------------------------------------------------- the push

describe('POST /api/demos/push', () => {
  it('appends a live match\'s bytes and answers with the length, naming neither token nor file', async () => {
    seedMatch('live');
    const d = demo(10);
    const res = await push(0, d.subarray(0, 2000));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ length: 2000 });
    expect(res.payload).not.toContain(TOKEN);
    expect(res.payload).not.toContain('.dem');
    expect(JSON.stringify(res.headers)).not.toContain(TOKEN);
    const res2 = await push(2000, d.subarray(2000));
    expect(res2.json()).toEqual({ length: d.length });
    expect(readFileSync(join(liveDir, liveDemoFileName(TOKEN, 1, 1000))).equals(d)).toBe(true);
  });

  it('refuses an unknown, finished or aborted match with the same 404, writing nothing', async () => {
    const unknown = await push(0, demo(2));
    expect(unknown.statusCode).toBe(404);
    for (const state of ['completed', 'aborted', 'configuring']) {
      db.prepare('DELETE FROM matches').run();
      seedMatch(state);
      const res = await push(0, demo(2));
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(unknown.json());
    }
    expect(existsSync(liveDir) ? readdirSync(liveDir) : []).toEqual([]);
  });

  it('refuses an offset gap with 409 and the length, and takes the resume', async () => {
    seedMatch('live');
    const d = demo(10);
    await push(0, d.subarray(0, 1500));
    const gap = await push(2500, d.subarray(2500));
    expect(gap.statusCode).toBe(409);
    expect(gap.json()).toEqual({ length: 1500 });
    // A retry of bytes already there is fine; different bytes there are not.
    expect((await push(0, d.subarray(0, 1500))).json()).toEqual({ length: 1500 });
    const changed = Buffer.from(d.subarray(1000, 1500)); changed[0] ^= 1;
    expect((await push(1000, changed)).statusCode).toBe(409);
    expect((await push(1000, d.subarray(1000, 2000))).statusCode).toBe(409);   // overlaps past the end
    const resume = await push(1500, d.subarray(1500));
    expect(resume.json()).toEqual({ length: d.length });
    // An empty batch asks where to resume.
    expect((await push(0, Buffer.alloc(0))).json()).toEqual({ length: d.length });
  });

  it('a batch at offset > 0 with nothing on the site is a 409 at length 0', async () => {
    seedMatch('live');
    const res = await push(5000, Buffer.alloc(100));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ length: 0 });
  });

  it('wants the whole demo header in the first batch, and the fields as headers', async () => {
    seedMatch('live');
    expect((await push(0, demo(1).subarray(0, 500))).statusCode).toBe(400);
    expect((await push(0, Buffer.alloc(2000, 1))).statusCode).toBe(400);
    expect((await push(0, demo(1), { 'x-demo-token': 'nope' })).statusCode).toBe(400);
    expect((await push(0, demo(1), { 'x-demo-map': '../../etc' })).statusCode).toBe(400);
    expect((await push(0, demo(1), { 'x-demo-started': '0' })).statusCode).toBe(400);
    // The token in the query instead of a header is not accepted.
    const q = await app.inject({
      method: 'POST', url: `/api/demos/push?token=${TOKEN}`,
      headers: { 'content-type': 'application/octet-stream', 'x-demo-ordinal': '1', 'x-demo-map': 'm', 'x-demo-offset': '0', 'x-demo-started': '1' },
      payload: demo(1),
    });
    expect(q.statusCode).toBe(400);
    expect(q.payload).not.toContain(TOKEN);
  });

  it('a newer recording at offset 0 replaces the copy; an older one is a stale 409', async () => {
    seedMatch('live');
    await push(0, demo(5));
    const older = await push(0, demo(5, 0x42), { 'x-demo-started': '999' });
    expect(older.statusCode).toBe(409);
    expect(older.json()).toEqual({ length: demo(5).length, error: 'stale recording' });
    // Another recording's bytes at the copy's own end are refused too.
    expect((await push(demo(5).length, packet(500), { 'x-demo-started': '1001' })).json())
      .toEqual({ length: demo(5).length, error: 'stale recording' });
    const newer = await push(0, demo(3, 0x43), { 'x-demo-started': '1001' });
    expect(newer.json()).toEqual({ length: demo(3).length });
    expect(readdirSync(liveDir)).toEqual([liveDemoFileName(TOKEN, 1, 1001)]);
  });

  it('refuses a brand new copy with 507 under the free-space floor or over the store cap', async () => {
    seedMatch('live');
    free = 1e9;
    const res = await push(0, demo(2));
    expect(res.statusCode).toBe(507);
    expect(existsSync(liveDir) ? readdirSync(liveDir) : []).toEqual([]);
    free = 100e9;
    feed.stop(); await app.close();
    await makeApp({ maxStoreBytes: 100 });
    mkdirSync(liveDir, { recursive: true });
    writeFileSync(join(liveDir, 'junk'), Buffer.alloc(200));
    expect((await push(0, demo(2))).statusCode).toBe(507);
  });

  it('refuses a body over the cap with 413', async () => {
    seedMatch('live');
    const res = await push(0, Buffer.alloc(1024 * 1024 + 1));
    expect(res.statusCode).toBe(413);
  });

  it('is off without a live demo directory', async () => {
    feed.stop(); await app.close();
    await makeApp({ liveDir: '' });
    seedMatch('live');
    const res = await push(0, demo(2));
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'live demo push is not configured' });
  });

  it('after a site restart reloads the copy from disk, counting its bytes as arriving now', async () => {
    const id = seedMatch('live');
    const d = demo(10);
    await push(0, d.subarray(0, 3000));
    feed.stop(); await app.close();
    clock = T0 + 60_000;
    await makeApp();
    expect((await push(3000, d.subarray(3000))).json()).toEqual({ length: d.length });
    await tickAt(clock + DEFAULT_DELAY_MS - 1);
    const v = await openWs(id);
    await settle();
    expect(v.texts()[0]).toMatchObject({ type: 'hello', size: 0 });
    await tickAt(T0 + 60_000 + DEFAULT_DELAY_MS);
    expect(v.bytes().equals(d)).toBe(true);
    v.ws.terminate();
  });

  it('answers a fixed error and never logs the token or a path when the write fails', async () => {
    seedMatch('live');
    writeFileSync(join(dir, 'blocked'), 'not a directory');
    feed.stop(); await app.close();
    await makeApp({ liveDir: join(dir, 'blocked', 'live') });
    const spies = ['error', 'warn', 'log', 'info'].map((k) => vi.spyOn(console, k as 'error').mockImplementation(() => {}));
    try {
      const res = await push(0, demo(2));
      expect([503, 507]).toContain(res.statusCode);
      expect(res.payload).not.toContain(TOKEN);
      expect(res.payload).not.toContain(dir);
      for (const s of spies) for (const call of s.mock.calls) for (const arg of call) {
        const text = typeof arg === 'string' ? arg : JSON.stringify(arg);
        expect(text).not.toContain(TOKEN);
        expect(text).not.toContain(dir);
      }
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

// ---------------------------------------------------------------- viewers

describe('GET /api/demos/live/match/:id', () => {
  it('WebSocket: hello, then nothing before the delay, then the bytes, pos marks and end; never the token', async () => {
    const id = seedMatch('live');
    const d = demo(20);
    await push(0, d.subarray(0, 4000));
    await tickAt(T0 + 2000);
    const v = await openWs(id);
    await settle();
    const hello = v.texts()[0];
    expect(hello).toMatchObject({ type: 'hello', offset: 0, size: 0, complete: false });
    expect(hello.id).toMatch(/^[0-9a-f]{16}$/);
    expect(v.bytes().length).toBe(0);

    clock = T0 + 5000;
    await push(4000, d.subarray(4000));
    await tickAt(T0 + 9999);
    expect(v.bytes().length).toBe(0);
    await tickAt(T0 + 10_000);
    expect(v.bytes().equals(d.subarray(0, 4000))).toBe(true);
    await tickAt(T0 + 14_999);
    expect(v.bytes().length).toBe(4000);
    await tickAt(T0 + 15_000);
    expect(v.bytes().equals(d)).toBe(true);
    const pos = v.texts().filter((m) => m.type === 'pos');
    expect(pos.length).toBeGreaterThan(0);
    expect(pos[pos.length - 1].off).toBe(d.length);

    // The match ends: everything is out already, so 'end' and a close.
    db.prepare("UPDATE matches SET state = 'completed'").run();
    await tickAt(T0 + 16_000);
    expect(v.texts().pop()).toEqual({ type: 'end', size: d.length });
    expect(v.closed()).toBe(true);
    for (const m of v.msgs) if (typeof m === 'string') expect(m).not.toContain(TOKEN);
  });

  it('HTTP stream: headers name a random id, and the body is only released bytes until the end', async () => {
    const id = seedMatch('live');
    const d = Buffer.concat([demo(20), stopFrame(200)]);
    await push(0, d.subarray(0, 5000));
    await tickAt(T0 + DEFAULT_DELAY_MS);
    clock = T0 + DEFAULT_DELAY_MS;
    await push(5000, d.subarray(5000));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/demos/live/match/${id}/live.dem`, { headers: { 'accept-encoding': 'identity' } });
    expect(res.status).toBe(200);
    const headers = JSON.stringify([...res.headers]);
    expect(headers).not.toContain(TOKEN);
    expect(res.headers.get('x-demo-id')).toMatch(/^[0-9a-f]{16}$/);
    expect(res.headers.get('x-demo-size')).toBe('5000');
    const reader = res.body!.getReader();
    const got: Buffer[] = [];
    const reading = (async () => { for (;;) { const r = await reader.read(); if (r.done) return; got.push(Buffer.from(r.value)); } })();
    await settle();
    expect(Buffer.concat(got).equals(d.subarray(0, 5000))).toBe(true);
    await tickAt(T0 + 2 * DEFAULT_DELAY_MS - 1);
    expect(Buffer.concat(got).length).toBe(5000);
    // dem_stop: the recording is complete once its last byte is out.
    await tickAt(T0 + 2 * DEFAULT_DELAY_MS);
    await reading;
    expect(Buffer.concat(got).equals(d)).toBe(true);
  });

  it('HTTP stream gzips when asked', async () => {
    const id = seedMatch('live');
    const d = Buffer.concat([demo(20), stopFrame(200)]);
    await push(0, d);
    await tickAt(T0 + DEFAULT_DELAY_MS);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/demos/live/match/${id}/live.dem`, { headers: { 'accept-encoding': 'gzip' } });
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(Buffer.from(await res.arrayBuffer()).equals(d)).toBe(true);   // fetch inflates
  });

  it('a resume with the same id continues at its offset; another id starts at 0', async () => {
    const id = seedMatch('live');
    const d = demo(20);
    await push(0, d);
    await tickAt(T0 + DEFAULT_DELAY_MS);
    const first = await openWs(id);
    await settle();
    const rid = first.texts()[0].id;
    first.ws.terminate();
    const again = await openWs(id, `?offset=3000&id=${rid}`);
    await settle();
    expect(again.texts()[0]).toMatchObject({ offset: 3000, size: d.length });
    expect(again.bytes().equals(d.subarray(3000))).toBe(true);
    again.ws.terminate();
    const other = await openWs(id, '?offset=3000&id=ffffffffffffffff');
    await settle();
    expect(other.texts()[0]).toMatchObject({ offset: 0 });
    // An offset beyond what is released is not honoured either.
    other.ws.terminate();
    const ahead = await openWs(id, `?offset=${d.length + 1}&id=${rid}`);
    await settle();
    expect(ahead.texts()[0]).toMatchObject({ offset: 0 });
    ahead.ws.terminate();
  });

  it('a restart of the recording tells viewers to restart, and the new one is held again', async () => {
    const id = seedMatch('live');
    await push(0, demo(10));
    await tickAt(T0 + DEFAULT_DELAY_MS);
    const v = await openWs(id);
    await settle();
    const oldId = v.texts()[0].id;
    clock = T0 + 20_000;
    await push(0, demo(4, 0x44), { 'x-demo-started': '2000' });
    await settle();
    expect(v.texts().pop()).toEqual({ type: 'restart' });
    expect(v.closed()).toBe(true);
    const w = await openWs(id, `?offset=100&id=${oldId}`);
    await settle();
    expect(w.texts()[0]).toMatchObject({ type: 'hello', offset: 0, size: 0 });
    expect(w.texts()[0].id).not.toBe(oldId);
    await tickAt(T0 + 20_000 + DEFAULT_DELAY_MS - 1);
    expect(w.bytes().length).toBe(0);
    await tickAt(T0 + 20_000 + DEFAULT_DELAY_MS);
    expect(w.bytes().equals(demo(4, 0x44))).toBe(true);
    w.ws.terminate();
  });

  it('the next map takes over only once its own first bytes are out, after the old map is sent whole', async () => {
    const id = seedMatch('live');
    const m1 = demo(10, 0x41);
    const m2 = demo(6, 0x45, 'l4d_vs_hospital02_subway');
    await push(0, m1);
    await tickAt(T0 + DEFAULT_DELAY_MS);
    const v = await openWs(id);
    await settle();
    clock = T0 + 12_000;
    await push(0, m2, { 'x-demo-ordinal': '2' });
    await tickAt(T0 + 12_000 + DEFAULT_DELAY_MS - 1);
    expect(v.closed()).toBe(false);
    // A new viewer still gets map 1.
    const late = await openWs(id);
    await settle();
    expect(late.bytes().equals(m1)).toBe(true);
    late.ws.terminate();
    await tickAt(T0 + 12_000 + DEFAULT_DELAY_MS);
    expect(v.bytes().equals(m1)).toBe(true);
    expect(v.texts().pop()).toEqual({ type: 'restart' });
    const next = await openWs(id);
    await settle();
    expect(next.bytes().equals(m2)).toBe(true);
    next.ws.terminate();
  });

  it('a quiet recording does not end while its match is live; it ends when the match does', async () => {
    const id = seedMatch('live');
    feed.stop(); await app.close();
    await makeApp({ idleEndMs: 30_000 });
    const d = demo(5);
    await push(0, d);
    await tickAt(T0 + DEFAULT_DELAY_MS);
    const v = await openWs(id);
    await settle();
    expect(v.bytes().equals(d)).toBe(true);
    // The box's sender down for ten minutes: the viewer waits, it is not ended.
    await tickAt(T0 + 600_000);
    expect(v.closed()).toBe(false);
    expect(v.texts().some((t) => (t as { type: string }).type === 'end')).toBe(false);
    setState(id, 'completed');
    await tickAt(T0 + 600_250);
    expect(v.texts().pop()).toEqual({ type: 'end', size: d.length });
  });

  it('a push at offset 0 with different bytes is refused as content differs, not resumed onto', async () => {
    seedMatch('live');
    const d = demo(5);
    expect((await push(0, d)).statusCode).toBe(200);
    const other = demo(5, 0x42);
    const r = await push(0, other.subarray(0, 2000));
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ length: d.length, error: 'content differs' });
    // the same bytes again are an exact retry, not a mismatch
    expect((await push(0, d.subarray(0, 2000))).statusCode).toBe(200);
  });

  it('caps open live streams per address, behind the proxy by the last forwarded entry', async () => {
    const id = seedMatch('live');
    await push(0, demo(3));
    await tickAt(T0 + DEFAULT_DELAY_MS);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/api/demos/live/match/${id}/live.dem`;
    const ctl: AbortController[] = [];
    const openOne = async (ip: string) => {
      const a = new AbortController(); ctl.push(a);
      return fetch(url, { signal: a.signal, headers: { 'x-forwarded-for': `10.0.0.9, ${ip}`, 'accept-encoding': 'identity' } });
    };
    for (let i = 0; i < MAX_STREAMS_PER_IP; i++) expect((await openOne('203.0.113.7')).status).toBe(200);
    expect((await openOne('203.0.113.7')).status).toBe(429);
    expect((await openOne('203.0.113.8')).status).toBe(200);
    ctl[0].abort();
    await new Promise((r) => setTimeout(r, 100));
    expect((await openOne('203.0.113.7')).status).toBe(200);
    for (const a of ctl) a.abort();
  });

  it('drops a viewer whose connection takes nothing for a minute', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      seedMatch('live');
      await push(0, demo(3));
      feed.tick(T0 + DEFAULT_DELAY_MS);
      const rec = feed.current(TOKEN)!;
      let ended = false;
      const c = { sent: 0, busy: false, send: () => new Promise<void>(() => { /* never drains */ }), end: () => { ended = true; } };
      feed.subscribe(rec, c);
      await vi.advanceTimersByTimeAsync(CLIENT_STALL_MS + 10);
      expect(ended).toBe(true);
      expect(rec.clients.has(c)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('turns the push off when DEMO_LIVE_DIR is DEMO_DIR', () => {
    const f = new DemoFeed({ db, liveDir: demoDir, demoDir });
    expect(f.liveDir).toBe('');
  });

  it('answers 404, the same for each, for a non-live, unknown, private or not-yet-recording match', async () => {
    const live = seedMatch('live');
    const done = seedMatch('completed', OTHER);
    const priv = seedMatch('live', 'd'.repeat(32), 'participants');
    const empty = seedMatch('live', 'e'.repeat(32));
    await push(0, demo(3));
    await push(0, demo(3), { 'x-demo-token': OTHER });   // 404 too: not live
    for (const tok of ['d'.repeat(32)]) await push(0, demo(3), { 'x-demo-token': tok });
    await tickAt(T0 + DEFAULT_DELAY_MS);
    // The live one is served (a live stream never ends, so only its hello is checked).
    const v = await openWs(live);
    await settle();
    expect(v.texts()[0]).toMatchObject({ type: 'hello' });
    v.ws.terminate();
    const refused = [];
    for (const id of [done, priv, empty, 99999, 'abc']) {
      const r = await app.inject({ method: 'GET', url: `/api/demos/live/match/${id}/live.dem` });
      expect(r.statusCode).toBe(404);
      refused.push(r.json());
      await expect(app.injectWS(`/api/demos/live/match/${id}/ws`)).rejects.toThrow(/404/);
    }
    for (const r of refused) expect(r).toEqual({ error: 'no live demo for that match' });
  }, 15_000);

  it('the status route says ready only once bytes are released, and 404s like the streams otherwise', async () => {
    const live = seedMatch('live');
    const done = seedMatch('completed', OTHER);
    const before = await app.inject({ method: 'GET', url: `/api/demos/live/match/${live}` });
    expect(before.statusCode).toBe(404);
    await push(0, demo(3));
    await tickAt(T0 + DEFAULT_DELAY_MS - 1);
    const held = await app.inject({ method: 'GET', url: `/api/demos/live/match/${live}` });
    expect(held.statusCode).toBe(200);
    expect(held.json()).toEqual({ ready: false });
    await tickAt(T0 + DEFAULT_DELAY_MS);
    const ready = await app.inject({ method: 'GET', url: `/api/demos/live/match/${live}` });
    expect(ready.json()).toEqual({ ready: true, map: 'l4d_vs_hospital01_apartment' });
    expect(ready.body).not.toContain(TOKEN);
    const gone = await app.inject({ method: 'GET', url: `/api/demos/live/match/${done}` });
    expect(gone.statusCode).toBe(404);
  });

  it('a match that leaves live mid-stream still waits out the hold, then ends', async () => {
    const id = seedMatch('live');
    const d = demo(10);
    await push(0, d.subarray(0, 3000));
    await tickAt(T0 + DEFAULT_DELAY_MS);
    const v = await openWs(id);
    clock = T0 + 11_000;
    await push(3000, d.subarray(3000));
    setState(id, 'completed');
    await tickAt(T0 + 11_000 + DEFAULT_DELAY_MS - 1);
    expect(v.bytes().length).toBe(3000);
    expect(v.closed()).toBe(false);
    await tickAt(T0 + 11_000 + DEFAULT_DELAY_MS);
    expect(v.bytes().equals(d)).toBe(true);
    expect(v.texts().pop()).toEqual({ type: 'end', size: d.length });
  });
});

// ---------------------------------------------------------------- Dallas: DEMO_DIR itself

describe('local mode (DEMO_DIR)', () => {
  beforeEach(async () => {
    feed.stop(); await app.close();
    await makeApp({ liveDir: '', local: true });
  });
  const file = (ord = 1, map = 'l4d_vs_hospital01_apartment', token = TOKEN) => join(demoDir, `pug_${token}_${ord}_${map}.dem`);
  const fresh = (path: string) => utimesSync(path, new Date(clock), new Date(clock));

  it('follows the growing file, dating each range by when the site first saw it', async () => {
    const id = seedMatch('live');
    const d = demo(20);
    writeFileSync(file(), d.subarray(0, 3000)); fresh(file());
    await tickAt(T0);
    const v = await openWs(id);
    await settle();
    expect(v.texts()[0]).toMatchObject({ type: 'hello', size: 0 });
    appendFileSync(file(), d.subarray(3000));
    await tickAt(T0 + 4000);
    await tickAt(T0 + DEFAULT_DELAY_MS + 3999);
    expect(v.bytes().equals(d.subarray(0, 3000))).toBe(true);
    await tickAt(T0 + DEFAULT_DELAY_MS + 4000);
    expect(v.bytes().equals(d)).toBe(true);
    // The push is not on here, and a push could not take over a local file.
    expect((await push(0, d)).statusCode).toBe(404);
    v.ws.terminate();
  });

  it('a file rewritten from the start is a new recording: viewers restart', async () => {
    const id = seedMatch('live');
    writeFileSync(file(), demo(20)); fresh(file());
    await tickAt(T0);
    await tickAt(T0 + DEFAULT_DELAY_MS);
    const v = await openWs(id);
    await settle();
    expect(v.bytes().length).toBe(demo(20).length);
    writeFileSync(file(), demo(2, 0x46));
    await tickAt(T0 + DEFAULT_DELAY_MS + 500);
    expect(v.texts().pop()).toEqual({ type: 'restart' });
    const w = await openWs(id);
    await settle();
    expect(w.bytes().length).toBe(0);
    await tickAt(T0 + 2 * DEFAULT_DELAY_MS + 500);
    expect(w.bytes().equals(demo(2, 0x46))).toBe(true);
    w.ws.terminate();
  });

  it('ignores a finished (old) file, a file of a match that is not live, and a non-demo', async () => {
    seedMatch('live');
    seedMatch('completed', OTHER);
    writeFileSync(file(1), demo(3));
    utimesSync(file(1), new Date(T0 - 10 * 60_000), new Date(T0 - 10 * 60_000));
    writeFileSync(file(1, 'm', OTHER), demo(3)); fresh(file(1, 'm', OTHER));
    writeFileSync(file(2, 'junk'), Buffer.alloc(3000, 7)); fresh(file(2, 'junk'));
    await tickAt(T0);
    await tickAt(T0 + 500);
    expect(feed.stats()).toEqual([]);
  });
});

describe('wiring', () => {
  it('is registered on the real server, push off by default', async () => {
    const real = await buildServer({
      config: loadConfig({}), db: openDb(':memory:'), orchestrator: stubOrchestrator(), serverExec: async () => {},
    });
    const res = await real.inject({
      method: 'POST', url: '/api/demos/push',
      headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(10),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'live demo push is not configured' });
    const live = await real.inject({ method: 'GET', url: '/api/demos/live/match/1/live.dem' });
    expect(live.statusCode).toBe(404);
    await real.close();
  });

  it('takes DEMO_LIVE_DIR and DEMO_LIVE_LOCAL from the environment', () => {
    expect(loadConfig({}).demoLiveDir).toBe('');
    expect(loadConfig({}).demoLiveLocal).toBe(false);
    const c = loadConfig({ DEMO_LIVE_DIR: '/x/live-demos', DEMO_LIVE_LOCAL: '1' });
    expect(c.demoLiveDir).toBe('/x/live-demos');
    expect(c.demoLiveLocal).toBe(true);
  });
});

describe('the hold clock', () => {
  it('is wall time that does not follow a stepped system clock', () => {
    const before = steadyNow();
    expect(Math.abs(before - Date.now())).toBeLessThan(60_000);
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000);
    try {
      expect(steadyNow() - before).toBeLessThan(1_000);
    } finally {
      spy.mockRestore();
    }
  });
});
