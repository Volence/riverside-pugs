import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { banPlayer, unbanPlayer } from '../src/admin/players.js';
import { addNote } from '../src/admin/players.js';

const ADMIN = '76561198000000001';
const P2 = '76561198000000002';
const P3 = '76561198000000003';

let db: DB;
let app: FastifyInstance;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
  authedCookie(app, db, ADMIN);
  db.prepare('UPDATE players SET is_admin = 1, name = ? WHERE steamid = ?').run('theadmin', ADMIN);
  authedCookie(app, db, P2);
  authedCookie(app, db, P3);
  db.prepare('UPDATE players SET name = ? WHERE steamid = ?').run('cheater', P2);
});
afterEach(async () => { await app.close(); });

const bans = () => app.inject({ method: 'GET', url: '/api/bans' });

describe('public bans page', () => {
  it('is readable without signing in at all', async () => {
    const res = await bans();
    expect(res.statusCode).toBe(200);
    expect(res.json().bans).toEqual([]);
  });

  it('shows an active ban with the reason, who issued it and when', async () => {
    banPlayer(db, P2, ADMIN, 'aimbot: https://youtu.be/x', null);
    const [row] = (await bans()).json().bans;
    expect(row).toMatchObject({
      steamid: P2, name: 'cheater', reason: 'aimbot: https://youtu.be/x',
      bannedByName: 'theadmin', permanent: true, active: true,
    });
    expect(row.createdAt).toBeTruthy();
  });

  it('keeps lifted bans on the record rather than hiding them', async () => {
    banPlayer(db, P2, ADMIN, 'mistake', 60);
    unbanPlayer(db, P2, ADMIN);
    const [row] = (await bans()).json().bans;
    expect(row.active).toBe(false);
    expect(row.liftedByName).toBe('theadmin');
  });

  // Reasons are already shown to the banned player, so they are fair game.
  // Admin notes never were, and must not leak through this route.
  it('never exposes private admin notes', async () => {
    banPlayer(db, P2, ADMIN, 'reason', null);
    addNote(db, P2, ADMIN, 'SECRET-NOTE-TEXT');
    expect(JSON.stringify((await bans()).json())).not.toContain('SECRET-NOTE-TEXT');
  });

  it('searches by SteamID and by name', async () => {
    banPlayer(db, P2, ADMIN, 'r1', null);
    banPlayer(db, P3, ADMIN, 'r2', null);
    const byId = await app.inject({ method: 'GET', url: `/api/bans?q=${P2}` });
    expect(byId.json().bans.map((b: any) => b.steamid)).toEqual([P2]);
    const byName = await app.inject({ method: 'GET', url: '/api/bans?q=cheat' });
    expect(byName.json().bans.map((b: any) => b.steamid)).toEqual([P2]);
  });

  it('puts the newest ban first', async () => {
    banPlayer(db, P2, ADMIN, 'older', null);
    banPlayer(db, P3, ADMIN, 'newer', null);
    expect((await bans()).json().bans.map((b: any) => b.reason)).toEqual(['newer', 'older']);
  });
});
