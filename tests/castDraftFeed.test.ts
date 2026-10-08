// tests/castDraftFeed.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { castStudioRoutes } from '../src/routes/castStudio.js';
import { Hub } from '../src/ws.js';
import { overlayKey } from '../src/cast/key.js';
import { getStudio } from '../src/cast/studio.js';
import * as DR from '../src/events/draftRoom.js';
import { authedCookie } from './helpers.js';
import { ADMIN } from './eventFixture.js';
import type { DraftFixture } from './draftFixture.js';
import { ALL, CAPTAINS, POOL, T0, at, drive, liveDraft, must } from './draftRoomFixture.js';

/** Drafts plan D2b2 Rulings 3, 6 and 10; Review Focus 1 and 2. */
const SECRET = 'k'.repeat(32);
const NOTE = 'secret note 5521';
const LIST = [POOL[9]!, POOL[8]!];
/** A captain who is also an admin, a caster and the organizer (Review Focus 1). */
const CASTER = CAPTAINS[0]!;
let f: DraftFixture;
let app: FastifyInstance;
let hub: Hub;
let nowMs: number;

async function setup(): Promise<void> {
  f = liveDraft();
  f.db.prepare('UPDATE draft_signups SET note = ? WHERE event_id = ? AND steamid = ?').run(NOTE, f.eventId, POOL[4]);
  must(DR.savePickList(f.db, { eventId: f.eventId, steamid: CASTER, list: LIST, now: T0 }));
  must(DR.startRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: T0, present: ALL }));
  drive(f, 1);
  nowMs = at(5).getTime();
  hub = new Hub();
  app = Fastify();
  await app.register(cookie, { secret: SECRET });
  await app.register(castStudioRoutes, {
    db: f.db,
    config: { cookieSecret: SECRET, publicUrl: 'http://localhost', replayDir: mkdtempSync(join(tmpdir(), 'castdraft-')), replayLiveDir: '' },
    store: () => { throw new Error('no community store in this test'); },
    hub,
    now: () => nowMs,
  });
  await app.ready();
  authedCookie(app, f.db, CASTER);
  f.db.prepare('UPDATE players SET is_caster = 1, is_admin = 1 WHERE steamid = ?').run(CASTER);
  f.db.prepare('UPDATE events SET organizer_steamid = ? WHERE id = ?').run(CASTER, f.eventId);
}
afterEach(async () => { await app?.close(); });

const as = (method: 'GET' | 'PUT', url: string, payload?: object) =>
  app.inject({ method, url, payload, cookies: authedCookie(app, f.db, CASTER) });
const feed = () => app.inject({
  method: 'GET', url: `/api/overlay/feed?k=${encodeURIComponent(overlayKey(SECRET, CASTER, getStudio(f.db, CASTER).keyGen))}`,
});
const PRIVATE_KEYS = ['"notes"', '"lists"', '"chemistry"', '"together"', '"me"', '"delegates"', '"avgSr"', '"spread"', '"forecasts"'];

describe('the overlay feed follows a draft', () => {
  it('serves the public room only, even to a caster who is staff, the organizer and a captain', async () => {
    await setup();
    expect((await as('PUT', '/api/cast/studio', { draftEventId: f.eventId, scene: 'draftboard' })).statusCode).toBe(200);
    const res = await feed();
    expect(res.statusCode).toBe(200);
    expect(res.json().draft).toMatchObject({ eventId: f.eventId, status: 'running', totalPicks: 15 });
    expect(res.json().draft.picks).toHaveLength(1);
    for (const body of [res.body, (await as('GET', '/api/cast/studio/feed')).body]) {
      expect(body).not.toContain(NOTE);
      expect(body).not.toContain(JSON.stringify(LIST));
      for (const k of PRIVATE_KEYS) expect(body).not.toContain(k);
    }
  });

  it('lists the draft on the panel and refuses one the caster may not put on air', async () => {
    await setup();
    const panel = (await as('GET', '/api/cast/studio')).json();
    expect(panel.drafts).toEqual([expect.objectContaining({ id: f.eventId, status: 'running', picks: 1, totalPicks: 15 })]);
    expect(JSON.stringify(panel)).not.toContain(NOTE);
    f.db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(f.eventId);
    const r = await as('PUT', '/api/cast/studio', { draftEventId: f.eventId });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('not_castable_draft');
  });

  it('clears a saved draft that went off air instead of refusing every later save', async () => {
    await setup();
    await as('PUT', '/api/cast/studio', { draftEventId: f.eventId });
    f.db.prepare('UPDATE events SET teams_made_at = ? WHERE id = ?').run(new Date(nowMs - 7 * 3_600_000).toISOString(), f.eventId);
    expect((await feed()).json().draft).toBeNull();
    const r = await as('PUT', '/api/cast/studio', { ...getStudio(f.db, CASTER).state, title: 'Next show' });
    expect(r.statusCode).toBe(200);
    expect(r.json().studio).toMatchObject({ title: 'Next show', draftEventId: null });
  });

  it('shows a pick on the next read once the room broadcasts, not when the cache runs out', async () => {
    await setup();
    await as('PUT', '/api/cast/studio', { draftEventId: f.eventId });
    expect((await feed()).json().draft.picks).toHaveLength(1);
    drive(f, 1, 6);
    // The same instant: the 900 ms cache still holds the old answer.
    expect((await feed()).json().draft.picks).toHaveLength(1);
    // Another event's broadcast leaves it alone.
    hub.broadcast(`draft:${f.eventId + 1}`);
    expect((await feed()).json().draft.picks).toHaveLength(1);
    hub.broadcast(`draft:${f.eventId}`);
    expect((await feed()).json().draft.picks).toHaveLength(2);
  });

  it('drops a followed draft from the feed the moment it stops being castable', async () => {
    await setup();
    await as('PUT', '/api/cast/studio', { draftEventId: f.eventId });
    expect((await feed()).json().draft).not.toBeNull();
    f.db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(f.eventId);
    nowMs += 1000;
    expect((await feed()).json().draft).toBeNull();
    expect((await as('GET', '/api/cast/studio/feed')).json().draft).toBeNull();
  });
});
