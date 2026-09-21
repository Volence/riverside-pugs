import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { ensureTicketSchema } from '../src/tickets/schema.js';
import { getSetting } from '../src/settings.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const A = '76561199000000001';
const B = '76561199000000002';
const ADMIN = '76561199000000009';
let db: DB;
let app: FastifyInstance;
const cookie: Record<string, Record<string, string>> = {};

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
  for (const id of [A, B, ADMIN]) cookie[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
});
afterEach(async () => { await app.close(); });

const openTicket = (target: string, restricted: number) =>
  db.prepare("INSERT INTO tickets (target_id, restricted, created_at) VALUES (?, ?, '2026-09-21T00:00:00.000Z')").run(target, restricted);

describe('ticket schema', () => {
  it('is idempotent', () => {
    expect(() => ensureTicketSchema(db)).not.toThrow();
  });

  it('allows one open ticket per player per restricted flavour', () => {
    openTicket(A, 0);
    expect(() => openTicket(A, 0)).toThrow(/UNIQUE/);
    expect(() => openTicket(A, 1)).not.toThrow();
    db.prepare("UPDATE tickets SET status = 'closed' WHERE target_id = ? AND restricted = 0").run(A);
    expect(() => openTicket(A, 0)).not.toThrow();
  });

  it('adds is_mod, bans.ticket_id and the two settings', () => {
    expect((db.prepare('SELECT is_mod FROM players WHERE steamid = ?').get(A) as { is_mod: number }).is_mod).toBe(0);
    expect(() => db.prepare('SELECT ticket_id FROM bans').all()).not.toThrow();
    expect(getSetting(db, 'ticket_mod_ban_max_minutes')).toBe('10080');
    expect(getSetting(db, 'ticket_reports_per_day')).toBe('5');
  });
});

describe('the moderator flag', () => {
  it('an admin toggles it, it shows in /api/me, and it is audited', async () => {
    const set = (as: string, isMod: unknown) => app.inject({ method: 'POST', url: `/api/admin/players/${A}/mod`, cookies: cookie[as], payload: { isMod } });
    expect((await set(B, true)).statusCode).toBe(403);
    expect((await set(ADMIN, 'yes')).statusCode).toBe(400);
    expect((await set(ADMIN, true)).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/me', cookies: cookie[A] })).json().isMod).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/me', cookies: cookie[B] })).json().isMod).toBe(false);
    const audit = (await app.inject({ method: 'GET', url: '/api/admin/audit', cookies: cookie[ADMIN] })).json();
    expect(audit.actions[0]).toMatchObject({ action: 'set_mod', target: A });
    const list = (await app.inject({ method: 'GET', url: `/api/admin/players?q=${A}`, cookies: cookie[ADMIN] })).json();
    expect(list.players[0].isMod).toBe(true);
  });
});
