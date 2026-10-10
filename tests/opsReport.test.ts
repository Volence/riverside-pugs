import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { opsMac, opsReportRoutes, opsReportText, parsePayload, clean, RATE_PER_HOUR } from '../src/opsReport.js';
import { loadConfig } from '../src/config.js';

const SECRET = 'a'.repeat(64);
let nowMs = Date.parse('2026-10-10T12:00:00Z');
let app: FastifyInstance;
let events: AdminEvent[];
let off: () => void;

async function build(secret: string | null = SECRET) {
  app = Fastify();
  await app.register(opsReportRoutes, { secret, now: () => nowMs });
}

function signed(payload: unknown, o: { ts?: number; secret?: string } = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const ts = o.ts ?? Math.floor(nowMs / 1000);
  return { ts, payload: text, mac: opsMac(o.secret ?? SECRET, ts, text) };
}

const post = (body: unknown) => app.inject({ method: 'POST', url: '/api/ops/report', payload: body as object });

const FRESH = {
  server: 'Riverside #5', kind: 'sm_errors', file: 'errors_20261010.log',
  fresh: [{ plugin: 'l4d_air_jump_force.smx', text: 'Plugin owning this native is currently paused.', where: 'Line 41, l4d_air_jump_force.sp::OnPlayerRunCmd', count: 3 }],
};

beforeEach(async () => {
  nowMs = Date.parse('2026-10-10T12:00:00Z');
  events = [];
  off = subscribeAdminEvents((e) => events.push(e));
  await build();
});
afterEach(async () => { off(); await app.close(); });

describe('POST /api/ops/report', () => {
  it('posts a signed report to the admin feed as a problem', async () => {
    const res = await post(signed(FRESH));
    expect(res.statusCode).toBe(200);
    expect(events).toHaveLength(1);
    const e = events[0] as Extract<AdminEvent, { kind: 'problem' }>;
    expect(e.kind).toBe('problem');
    expect(e.text).toBe('Riverside #5: new SourceMod error (errors_20261010.log): l4d_air_jump_force.smx: Plugin owning this native is currently paused. (Line 41, l4d_air_jump_force.sp::OnPlayerRunCmd) x3.');
  });

  it('is off (404) without a secret', async () => {
    await app.close();
    await build(null);
    expect((await post(signed(FRESH))).statusCode).toBe(404);
    expect(events).toHaveLength(0);
  });

  it('refuses a bad MAC, a stale or future timestamp, and a replay', async () => {
    expect((await post(signed(FRESH, { secret: 'b'.repeat(64) }))).statusCode).toBe(401);
    expect((await post(signed(FRESH, { ts: Math.floor(nowMs / 1000) - 400 }))).statusCode).toBe(401);
    expect((await post(signed(FRESH, { ts: Math.floor(nowMs / 1000) + 400 }))).statusCode).toBe(401);
    const body = signed(FRESH);
    expect((await post(body)).statusCode).toBe(200);
    expect((await post(body)).statusCode).toBe(409);
    // A payload changed after signing.
    const tampered = { ...signed(FRESH), payload: JSON.stringify({ ...FRESH, server: 'Dallas' }) };
    expect((await post(tampered)).statusCode).toBe(401);
    expect(events).toHaveLength(1);
  });

  it('refuses malformed bodies and payloads', async () => {
    expect((await post({ ts: 'x', payload: '{}', mac: 'zz' })).statusCode).toBe(400);
    expect((await post(signed('not json'))).statusCode).toBe(400);
    expect((await post(signed({ ...FRESH, server: 'x'.repeat(41) }))).statusCode).toBe(400);
    expect((await post(signed({ ...FRESH, kind: 'other' }))).statusCode).toBe(400);
    expect((await post(signed({ server: 'Dallas', kind: 'sm_errors', fresh: [] }))).statusCode).toBe(400);
    expect(events).toHaveLength(0);
  });

  it('caps posts per hour', async () => {
    for (let i = 0; i < RATE_PER_HOUR; i++) {
      nowMs += 1000;
      expect((await post(signed(FRESH))).statusCode).toBe(200);
    }
    nowMs += 1000;
    expect((await post(signed(FRESH))).statusCode).toBe(429);
    nowMs += 3_600_000;
    expect((await post(signed(FRESH))).statusCode).toBe(200);
    expect(events).toHaveLength(RATE_PER_HOUR + 1);
  });
});

describe('opsReportText', () => {
  it('words a flood with its top signatures', () => {
    const p = parsePayload(JSON.stringify({
      server: 'Riverside #6', kind: 'sm_errors', file: 'errors_20261001.log',
      flood: { lines: 33000, seconds: 120 },
      top: [{ plugin: 'l4d_air_jump_force.smx', text: 'Plugin owning this native is currently paused.', count: 9000 }],
    }))!;
    expect(opsReportText(p)).toBe(
      'Riverside #6: SourceMod error flood, 33,000 error log lines in 2 min (errors_20261001.log). Top: l4d_air_jump_force.smx: Plugin owning this native is currently paused. x9,000.',
    );
  });

  it('strips markdown links, code spans and control characters but keeps underscores', () => {
    expect(clean('[click](http://x) `rm` *b* @everyone a_b\n', 200)).toBe('(click)(http://x) rm b @everyone a_b');
    expect(clean('x'.repeat(50), 10)).toBe('xxxxxxx...');
  });

  it('caps the item list', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ text: `e${i}` }));
    expect(parsePayload(JSON.stringify({ server: 'Dallas', kind: 'sm_errors', fresh: many }))!.fresh).toHaveLength(5);
  });
});

describe('config', () => {
  it('reads OPS_REPORT_SECRET, null when unset or blank', () => {
    expect(loadConfig({}).opsReportSecret).toBeNull();
    expect(loadConfig({ OPS_REPORT_SECRET: '  ' }).opsReportSecret).toBeNull();
    expect(loadConfig({ OPS_REPORT_SECRET: SECRET }).opsReportSecret).toBe(SECRET);
  });
});
