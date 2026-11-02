import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { getPlayer, upsertPlayer } from '../src/players.js';
import { setDisplayName, validateDisplayName } from '../src/displayName.js';
import { backfillPersonas } from '../src/personaBackfill.js';
import { resolveByName } from '../src/discord/reportButton.js';
import { searchPlayers } from '../src/admin/players.js';

const [PLAYER, MOD, ADMIN, OWNER] = ['76561199000000000', '76561199000000001', '76561199000000002', '76561199000000003'];
let db: DB;

describe('validateDisplayName', () => {
  it('takes a readable name, trimmed and with runs of spaces folded', () => {
    expect(validateDisplayName('  Vac  ')).toEqual({ ok: true, name: 'Vac' });
    expect(validateDisplayName('big   dog')).toEqual({ ok: true, name: 'big dog' });
  });

  it('refuses names nobody could read or type, and slurs', () => {
    for (const bad of ['', '   ', "'", 'ุ', 'a​b', 'x'.repeat(33), 42, null]) {
      expect(validateDisplayName(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(validateDisplayName('faggot').ok).toBe(false);
  });
});

describe('a display name', () => {
  beforeEach(() => {
    db = openDb(':memory:');
    upsertPlayer(db, { steamid: PLAYER, name: 'ุ', avatar: 'a.jpg' }, []);
  });

  it('becomes the name every page reads, and keeps the Steam name beside it', () => {
    expect(setDisplayName(db, PLAYER, 'Vac')).toEqual({ from: 'ุ', to: 'Vac', steamName: 'ุ' });
    const p = getPlayer(db, PLAYER)!;
    expect([p.name, p.steam_name, p.name_override]).toEqual(['Vac', 'ุ', 'Vac']);
  });

  it('survives a sign-in, which still refreshes the Steam name underneath', () => {
    setDisplayName(db, PLAYER, 'Vac');
    upsertPlayer(db, { steamid: PLAYER, name: 'new steam', avatar: 'b.jpg' }, []);
    const p = getPlayer(db, PLAYER)!;
    expect([p.name, p.steam_name, p.avatar]).toEqual(['Vac', 'new steam', 'b.jpg']);
    // And clearing it shows the persona they have now, not the old one.
    setDisplayName(db, PLAYER, null);
    expect(getPlayer(db, PLAYER)!.name).toBe('new steam');
  });

  it('survives the persona backfill', async () => {
    db.prepare("UPDATE players SET avatar = NULL WHERE steamid = ?").run(PLAYER);
    setDisplayName(db, PLAYER, 'Vac');
    const fetchFn = async () => new Response(JSON.stringify({
      response: { players: [{ steamid: PLAYER, personaname: 'persona', avatarfull: 'c.jpg' }] },
    }));
    await backfillPersonas(db, 'key', fetchFn as never);
    const p = getPlayer(db, PLAYER)!;
    expect([p.name, p.steam_name, p.avatar]).toEqual(['Vac', 'persona', 'c.jpg']);
  });

  it('keeps the persona of a row older than the steam_name column', () => {
    db.prepare('UPDATE players SET steam_name = NULL WHERE steamid = ?').run(PLAYER);
    setDisplayName(db, PLAYER, 'Vac');
    setDisplayName(db, PLAYER, null);
    expect(getPlayer(db, PLAYER)!.name).toBe('ุ');
  });

  it('leaves the player findable by the Steam name, for reports and staff search', () => {
    upsertPlayer(db, { steamid: PLAYER, name: 'stewie', avatar: 'a.jpg' }, []);
    setDisplayName(db, PLAYER, 'Vac');
    expect(resolveByName(db, 'stewie').map((c) => c.steamid)).toEqual([PLAYER]);
    expect(resolveByName(db, 'stew').map((c) => c.name)).toEqual(['Vac']);
    const [row] = searchPlayers(db, 'stewie');
    expect([row.name, row.steamName]).toEqual(['Vac', 'stewie']);
    setDisplayName(db, PLAYER, null);
    expect(searchPlayers(db, 'stewie')[0].steamName).toBeNull();
  });
});

describe('POST /api/admin/people/:steamid/display-name', () => {
  let app: FastifyInstance;
  const cookie: Record<string, Record<string, string>> = {};
  beforeEach(async () => {
    db = openDb(':memory:');
    app = await buildServer({ config: loadConfig({ ADMIN_STEAMIDS: OWNER }), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
    for (const id of [PLAYER, MOD, ADMIN, OWNER]) cookie[id] = authedCookie(app, db, id);
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
    db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  });
  afterEach(async () => { await app.close(); });
  const post = (as: string, payload: object) =>
    app.inject({ method: 'POST', url: `/api/admin/people/${PLAYER}/display-name`, cookies: cookie[as], payload });

  it('is admin only', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/admin/people/${PLAYER}/display-name`, payload: { name: 'Vac' } })).statusCode).toBe(401);
    expect((await post(PLAYER, { name: 'Vac' })).statusCode).toBe(403);
    expect((await post(MOD, { name: 'Vac' })).statusCode).toBe(404);
    expect(getPlayer(db, PLAYER)!.name_override).toBeNull();
  });

  it('sets, audits and clears it, and refuses a bad name', async () => {
    const before = getPlayer(db, PLAYER)!.name;
    expect((await post(ADMIN, { name: "'" })).statusCode).toBe(400);
    const res = await post(ADMIN, { name: ' Vac ' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, name: 'Vac' });
    const file = (await app.inject({ method: 'GET', url: `/api/admin/people/${PLAYER}`, cookies: cookie[ADMIN] })).json();
    expect(file.header).toMatchObject({ name: 'Vac', steamName: before, nameOverridden: true });
    expect(file.actions).toContain('rename');

    expect((await post(ADMIN, { name: null })).json()).toEqual({ ok: true, name: before });
    const log = db.prepare('SELECT action, detail FROM admin_actions WHERE target = ? ORDER BY id').all(PLAYER) as { action: string; detail: string }[];
    expect(log.map((l) => l.action)).toEqual(['set_display_name', 'clear_display_name']);
    expect(JSON.parse(log[0].detail)).toEqual({ from: before, to: 'Vac', steamName: before });
  });
});
