import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { setSetting } from '../src/settings.js';
import { CALLS_LIMIT } from '../src/routes/modCalls.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 5 }, (_, i) => `7656119900000000${i}`);
const [CALLER, CALLER2, ACCUSED, MOD, PLAYER] = IDS;
let db: DB;
let app: FastifyInstance;
const cookie: Record<string, Record<string, string>> = {};

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
  for (const id of IDS) cookie[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare("UPDATE players SET name = 'Caller One' WHERE steamid = ?").run(CALLER);
  db.prepare("UPDATE players SET name = 'The Accused' WHERE steamid = ?").run(ACCUSED);
  db.prepare("UPDATE players SET name = 'Mod Person', discord_id = '4242' WHERE steamid = ?").run(MOD);
});
afterEach(async () => { await app.close(); });

const get = (as: string, url: string) => app.inject({ method: 'GET', url, cookies: cookie[as] });

function call(fields: Record<string, unknown>): number {
  const row = {
    created_at: '2026-09-24T10:00:00.000Z', caller_steamid: CALLER, target_kind: 'player', target_steamid: ACCUSED,
    reason: 'cheating', text: 'walls', post_state: 'posted', ...fields,
  };
  const keys = Object.keys(row);
  return Number(db.prepare(
    `INSERT INTO mod_calls (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
  ).run(...Object.values(row)).lastInsertRowid);
}

describe('GET /api/mod/calls', () => {
  it('is staff only', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/mod/calls' })).statusCode).toBe(401);
    expect((await get(PLAYER, '/api/mod/calls')).statusCode).toBe(403);
  });

  it('nests a folded call under its parent, with labels and names', async () => {
    const parent = call({ map: 'l4d_vs_airport01_greenhouse', match_id: 7, map_ordinal: 1, half: 2, t_ms: 61500 });
    call({ caller_steamid: CALLER2, reason: 'griefing', text: 'also', folded_into: parent, post_state: 'folded', created_at: '2026-09-24T10:01:00.000Z' });
    const body = (await get(MOD, '/api/mod/calls?filter=all')).json();
    expect(body.calls).toHaveLength(1);
    const [c] = body.calls;
    expect(c).toMatchObject({
      id: parent, reason: 'cheating', reasonLabel: 'Cheating', via: 'game', matchId: 7,
      moment: { ordinal: 1, half: 2, tMs: 61500 },
      caller: { steamid: CALLER, name: 'Caller One' },
      target: { kind: 'player', steamid: ACCUSED, name: 'The Accused' },
    });
    expect(c.folded).toHaveLength(1);
    expect(c.folded[0]).toMatchObject({ reasonLabel: 'Griefing / throwing', caller: { steamid: CALLER2 }, folded: [] });
  });

  it('open hides a handled call, all shows it, and handledBy names the linked player', async () => {
    call({ text: 'open one' });
    call({ text: 'done', handled_at: '2026-09-24T10:05:00.000Z', handled_by_discord_id: '4242' });
    call({ text: 'done by stranger', handled_at: '2026-09-24T10:06:00.000Z', handled_by_discord_id: '999' });
    const open = (await get(MOD, '/api/mod/calls?filter=open')).json();
    expect(open.calls.map((c: { text: string }) => c.text)).toEqual(['open one']);
    const all = (await get(MOD, '/api/mod/calls?filter=all')).json();
    // Newest first.
    expect(all.calls.map((c: { text: string }) => c.text)).toEqual(['done by stranger', 'done', 'open one']);
    expect(all.calls[1].handledBy).toBe('Mod Person');
    expect(all.calls[0].handledBy).toBe('999');
  });

  it('caps both tabs at the newest CALLS_LIMIT parents', async () => {
    for (let i = 0; i < CALLS_LIMIT + 5; i++) call({ text: `c${i}` });
    for (const filter of ['open', 'all']) {
      const { calls } = (await get(MOD, `/api/mod/calls?filter=${filter}`)).json();
      expect(calls).toHaveLength(CALLS_LIMIT);
      expect(calls[0].text).toBe(`c${CALLS_LIMIT + 4}`);
    }
  });

  it('discordReady needs the admin channel and calls turned on', async () => {
    setSetting(db, 'discord_admin_channel_id', '');
    expect((await get(MOD, '/api/mod/calls')).json().discordReady).toBe(false);
    setSetting(db, 'discord_admin_channel_id', '123');
    expect((await get(MOD, '/api/mod/calls')).json().discordReady).toBe(true);
    setSetting(db, 'mod_calls_enabled', '0');
    expect((await get(MOD, '/api/mod/calls')).json().discordReady).toBe(false);
  });

  it('names a team or general target without a player', async () => {
    call({ target_kind: 'team', target_steamid: null });
    const [c] = (await get(MOD, '/api/mod/calls')).json().calls;
    expect(c.target).toEqual({ kind: 'team', steamid: null, name: null });
  });

  it('the ticket detail carries a report\'s source', async () => {
    db.prepare("UPDATE players SET is_admin = 1 WHERE steamid = ?").run(MOD);
    const r = await app.inject({ method: 'POST', url: '/api/reports', cookies: cookie[CALLER], payload: { targetId: ACCUSED, category: 'cheating', text: '' } });
    expect(r.statusCode).toBe(200);
    db.prepare("UPDATE ticket_reports SET source = 'game'").run();
    const id = (db.prepare('SELECT id FROM tickets').get() as { id: number }).id;
    expect((await get(MOD, `/api/mod/tickets/${id}`)).json().reports[0].source).toBe('game');
  });

  it('never lists a call, or a folded call, about the viewer', async () => {
    call({ target_steamid: MOD, text: 'about the mod' });
    const parent = call({ text: 'about the accused' });
    call({ target_steamid: MOD, text: 'folded about the mod', folded_into: parent, post_state: 'folded' });
    call({ caller_steamid: CALLER2, text: 'folded about the accused', folded_into: parent, post_state: 'folded' });
    for (const filter of ['open', 'all']) {
      const { calls } = (await get(MOD, `/api/mod/calls?filter=${filter}`)).json();
      expect(calls.map((c: { text: string }) => c.text)).toEqual(['about the accused']);
      expect(calls[0].folded.map((c: { text: string }) => c.text)).toEqual(['folded about the accused']);
    }
    // Another staff member sees them all.
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(PLAYER);
    const { calls } = (await get(PLAYER, '/api/mod/calls?filter=all')).json();
    expect(calls.map((c: { text: string }) => c.text)).toEqual(['about the accused', 'about the mod']);
    expect(calls[0].folded).toHaveLength(2);
  });

  it('shows the ticket id only when the viewer may see that ticket', async () => {
    const ticket = (restricted: number) => Number(db.prepare(
      "INSERT INTO tickets (target_id, target_name, restricted, created_at) VALUES (?, 'The Accused', ?, '2026-09-24T10:00:00.000Z')",
    ).run(ACCUSED, restricted).lastInsertRowid);
    const open = ticket(0);
    const locked = ticket(1);
    call({ text: 'normal', ticket_id: open });
    call({ text: 'restricted', ticket_id: locked });
    const byText = async (as: string) => Object.fromEntries(
      (await get(as, '/api/mod/calls')).json().calls.map((c: { text: string; ticketId: number | null }) => [c.text, c.ticketId]),
    );
    expect(await byText(MOD)).toEqual({ normal: open, restricted: null });
    db.prepare("INSERT INTO ticket_access (ticket_id, steamid, added_by, created_at) VALUES (?, ?, 'system', 'x')").run(locked, MOD);
    expect(await byText(MOD)).toEqual({ normal: open, restricted: locked });
  });

  it('open leaves out a call that was skipped, all keeps it', async () => {
    call({ text: 'posted' });
    call({ text: 'skipped', post_state: 'skipped' });
    expect((await get(MOD, '/api/mod/calls?filter=open')).json().calls.map((c: { text: string }) => c.text)).toEqual(['posted']);
    expect((await get(MOD, '/api/mod/calls?filter=all')).json().calls.map((c: { text: string }) => c.text)).toEqual(['skipped', 'posted']);
  });
});
