import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import * as E from '../src/events/events.js';
import { must } from './eventFixture.js';

/**
 * Every event route, for every competitive_enabled value and every kind of
 * viewer, in one table. Public routes follow the switch exactly as the team
 * pages do; a draft is staff only and otherwise an ordinary 404; the admin
 * desk ignores the switch, lets staff read and only admins write.
 */

const ADMIN = '76561199000000730';
const MOD = '76561199000000731';
const PLAYER = '76561199000000732';
type Who = 'anon' | 'player' | 'mod' | 'admin';
type Switch = 'off' | 'admins' | 'everyone';
const WHO: Record<Who, string | undefined> = { anon: undefined, player: PLAYER, mod: MOD, admin: ADMIN };

/** Public routes on a published event. */
const PUBLIC: Record<Switch, Record<Who, number>> = {
  off: { anon: 404, player: 404, mod: 404, admin: 404 },
  admins: { anon: 404, player: 404, mod: 404, admin: 200 },
  everyone: { anon: 200, player: 200, mod: 200, admin: 200 },
};
/** The page of a draft: staff, once the switch lets them in at all (under
 *  admins only, a mod is kept out like any player). */
const DRAFT: Record<Switch, Record<Who, number>> = {
  off: { anon: 404, player: 404, mod: 404, admin: 404 },
  admins: { anon: 404, player: 404, mod: 404, admin: 200 },
  everyone: { anon: 404, player: 404, mod: 200, admin: 200 },
};
/** The admin desk, whatever the switch: staff read it, only admins write. */
const DESK_READ: Record<Who, number> = { anon: 401, player: 403, mod: 200, admin: 200 };
const DESK_WRITE: Record<Who, number> = { anon: 401, player: 403, mod: 403, admin: 200 };

let db: DB;
let app: FastifyInstance;
let cookies: Record<string, Record<string, string>>;
let published: E.EventRow;
let draft: E.EventRow;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({
    config: { ...loadConfig({}), communityDir: mkdtempSync(join(tmpdir(), 'eventgating-')) },
    db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
  });
  cookies = {};
  for (const id of [ADMIN, MOD, PLAYER]) cookies[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  const cup = (db.prepare("SELECT id FROM rulesets WHERE name = 'Standard Cup'").get() as { id: number }).id;
  const startsAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  published = must(E.createEvent(db, { by: ADMIN, fields: { name: 'Open Cup', startsAt, entryKind: 'team' } }));
  must(E.addStage(db, { eventId: published.id, by: ADMIN, stage: { type: 'single_elim', rulesetId: cup } }));
  must(E.publishEvent(db, { eventId: published.id, by: ADMIN }));
  draft = must(E.createEvent(db, { by: ADMIN, fields: { name: 'Secret Cup', startsAt, entryKind: 'team' } }));
});
afterEach(async () => { await app.close(); });

const setSwitch = (v: Switch) => db.prepare("UPDATE settings SET value = ? WHERE key = 'competitive_enabled'").run(v);
const call = (method: 'GET' | 'POST', url: string, who: Who, payload?: object) => {
  const id = WHO[who];
  return app.inject({ method, url, cookies: id ? cookies[id] : undefined, payload });
};

describe('event route gating', () => {
  for (const sw of ['off', 'admins', 'everyone'] as const) {
    for (const who of ['anon', 'player', 'mod', 'admin'] as const) {
      it(`switch ${sw}, ${who}`, async () => {
        setSwitch(sw);
        expect((await call('GET', '/api/events', who)).statusCode, 'list').toBe(PUBLIC[sw][who]);
        expect((await call('GET', `/api/events/${published.slug}`, who)).statusCode, 'page').toBe(PUBLIC[sw][who]);
        expect((await call('GET', `/api/events/${draft.slug}`, who)).statusCode, 'draft page').toBe(DRAFT[sw][who]);
        for (const url of ['/api/admin/events', '/api/admin/events/options', `/api/admin/events/${draft.id}`]) {
          expect((await call('GET', url, who)).statusCode, url).toBe(DESK_READ[who]);
        }
        if (PUBLIC[sw][who] === 200) {
          const names = (await call('GET', '/api/events', who)).json().events.map((e: { name: string }) => e.name);
          expect(names).toEqual(who === 'admin' || who === 'mod' ? ['Open Cup', 'Secret Cup'] : ['Open Cup']);
        }
      });
    }
  }

  it('no one but an admin changes anything through the desk, and a refused call writes nothing', async () => {
    setSwitch('everyone');
    const before = JSON.stringify([db.prepare('SELECT * FROM events').all(), db.prepare('SELECT COUNT(*) FROM event_log').get()]);
    for (const who of ['anon', 'player', 'mod'] as const) {
      expect((await call('POST', '/api/admin/events', who, { name: 'Sneaky Cup', startsAt: published.starts_at, entryKind: 'team' })).statusCode).toBe(DESK_WRITE[who]);
      expect((await call('POST', `/api/admin/events/${draft.id}/publish`, who)).statusCode).toBe(DESK_WRITE[who]);
      expect((await call('POST', `/api/admin/events/${published.id}/cancel`, who, { reason: 'x' })).statusCode).toBe(DESK_WRITE[who]);
      expect((await call('POST', `/api/admin/events/${published.id}/banner/remove`, who)).statusCode).toBe(DESK_WRITE[who]);
    }
    expect(JSON.stringify([db.prepare('SELECT * FROM events').all(), db.prepare('SELECT COUNT(*) FROM event_log').get()])).toBe(before);
  });
});
