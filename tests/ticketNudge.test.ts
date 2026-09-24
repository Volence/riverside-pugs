import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { SESSION_COOKIE } from '../src/session.js';
import { Hub } from '../src/ws.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { fileReport } from '../src/tickets/filing.js';
import { ticketNudger } from '../src/tickets/nudge.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 7 }, (_, i) => `7656119900000000${i}`);
const [R1, PLAYER, ACCUSED, STAFF_ACCUSED, MOD, ADMIN, OWNER] = IDS;
let db: DB;

const sock = () => {
  const sent: string[] = [];
  return { sent, readyState: 1, send: (m: string) => sent.push(m) };
};
const file = (targetId: string, category = 'griefing') =>
  (fileReport(db, R1, { targetId, category, text: 'x' }, { adminSteamIds: [OWNER] }) as { ticketId: number }).ticketId;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of IDS) {
    upsertPlayer(db, { steamid: id, name: `p${id.slice(-1)}`, avatar: null }, []);
    activatePlayer(db, id);
  }
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid IN (?, ?)').run(MOD, STAFF_ACCUSED);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid IN (?, ?)').run(ADMIN, OWNER);
});

describe('who hears that a ticket changed', () => {
  it('staff who can see it, and nobody else', () => {
    const hub = new Hub();
    const s = Object.fromEntries(IDS.map((id) => [id, sock()]));
    for (const id of IDS) hub.add(s[id] as any, id);
    const nudge = ticketNudger(db, hub);
    const heard = () => IDS.filter((id) => s[id].sent.length > 0);
    const reset = () => { for (const id of IDS) s[id].sent.length = 0; };

    nudge(file(ACCUSED));
    expect(heard()).toEqual([STAFF_ACCUSED, MOD, ADMIN, OWNER]);
    expect(s[MOD].sent).toEqual(['{"event":"tickets"}']);

    reset();
    nudge(file(ACCUSED, 'unsafe'));
    expect(heard()).toEqual([OWNER]);

    // A ticket about a member of staff: every other member of staff, never the accused.
    reset();
    nudge(file(STAFF_ACCUSED));
    expect(heard()).toEqual([MOD, ADMIN, OWNER]);

    // A banned moderator stops hearing at once, on the socket they still hold.
    reset();
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(MOD);
    nudge(1);
    expect(heard()).toEqual([STAFF_ACCUSED, ADMIN, OWNER]);

    // And an admin whose ban is only in the bans table: the same rule every
    // other staff check asks (inGoodStanding), not players.status on its own.
    reset();
    db.prepare("INSERT INTO bans (player_id, reason, created_by, created_at) VALUES (?, 'x', 'system', ?)")
      .run(ADMIN, new Date().toISOString());
    expect(db.prepare('SELECT status FROM players WHERE steamid = ?').get(ADMIN)).toEqual({ status: 'active' });
    nudge(1);
    expect(heard()).toEqual([STAFF_ACCUSED, OWNER]);

    reset();
    nudge(9999);
    expect(heard()).toEqual([]);
  });
});

describe('over a real socket', () => {
  let app: FastifyInstance;
  afterEach(async () => { await app.close(); });

  it('the socket is who its cookie says, and filing a report nudges staff only', async () => {
    app = await buildServer({ config: loadConfig({ ADMIN_STEAMIDS: OWNER }), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
    await app.ready();
    const open = async (steamid: string | null) => {
      const got: string[] = [];
      const headers = steamid ? { cookie: `${SESSION_COOKIE}=${encodeURIComponent(authedCookie(app, db, steamid)[SESSION_COOKIE])}` } : {};
      const ws = await app.injectWS('/ws', { headers });
      ws.on('message', (d) => got.push(String(d)));
      return { ws, got };
    };
    const mod = await open(MOD);
    const accused = await open(ACCUSED);
    const stranger = await open(null);
    const r = await app.inject({ method: 'POST', url: '/api/reports', cookies: authedCookie(app, db, R1), payload: { targetId: ACCUSED, category: 'afk', text: '' } });
    expect(r.statusCode).toBe(200);
    await vi.waitFor(() => expect(mod.got).toContain('{"event":"tickets"}'));
    await vi.waitFor(() => expect(accused.got).toContain('{"event":"refresh"}'));
    expect(accused.got).not.toContain('{"event":"tickets"}');
    expect(stranger.got).not.toContain('{"event":"tickets"}');
    for (const c of [mod, accused, stranger]) c.ws.terminate();
  });
});
