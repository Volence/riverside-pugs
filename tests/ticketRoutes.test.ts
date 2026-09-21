import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const [R1, R2, ACCUSED, MOD, MOD2, ADMIN, OWNER] = IDS;
let db: DB;
let app: FastifyInstance;
let matchId: number;
const cookie: Record<string, Record<string, string>> = {};

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({ ADMIN_STEAMIDS: OWNER }), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
  for (const id of IDS) cookie[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid IN (?, ?)').run(MOD, MOD2);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid IN (?, ?)').run(ADMIN, OWNER);
  matchId = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'completed', 'dead_air')").run().lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  [R1, R2, ACCUSED].forEach((id, i) => ins.run(matchId, id, i < 2 ? 'a' : 'b'));
});
afterEach(async () => { await app.close(); });

const post = (as: string, url: string, payload: object = {}) => app.inject({ method: 'POST', url, cookies: cookie[as], payload });
const get = (as: string, url: string) => app.inject({ method: 'GET', url, cookies: cookie[as] });
const file = (as: string, payload: object) => post(as, '/api/reports', payload);

describe('filing over HTTP', () => {
  it('any active player files, with or without a match, and sees it under mine', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/reports', payload: {} })).statusCode).toBe(401);
    expect((await file(R1, { targetId: ACCUSED, category: 'cheating', text: 'walls', matchId })).statusCode).toBe(200);
    expect((await file(R1, { targetId: ACCUSED, category: 'cheating', text: 'walls', matchId })).statusCode).toBe(409);
    expect((await file(R2, { targetId: ACCUSED, category: 'toxicity', text: '' })).statusCode).toBe(200);
    const mine = (await get(R1, '/api/reports/mine')).json();
    expect(mine.reports).toHaveLength(1);
    expect(mine.reports[0]).toMatchObject({ targetId: ACCUSED, status: 'open' });
    expect((await file(R1, { targetId: ACCUSED, category: 'cheating' })).json()).toEqual({ ok: true });
  });

  it('the match page routes still work and no longer need the reporter on the roster', async () => {
    const elig = (await get(OWNER, `/api/matches/${matchId}/report-eligibility`)).json();
    expect(elig.canReport).toBe(true);
    expect(elig.targets).toHaveLength(3);
    expect((await post(OWNER, `/api/matches/${matchId}/reports`, { targetId: ACCUSED, category: 'afk', text: '' })).statusCode).toBe(200);
    expect(db.prepare('SELECT match_id FROM ticket_reports').get()).toEqual({ match_id: matchId });
    expect((await get(OWNER, '/api/matches/999/report-eligibility')).json()).toEqual({ canReport: false, reason: 'no such match' });
  });

  it('the old admin report routes are gone', async () => {
    expect((await get(ADMIN, '/api/admin/reports')).statusCode).toBe(404);
  });
});

describe('working tickets over HTTP', () => {
  let id: number;
  beforeEach(async () => {
    await file(R1, { targetId: ACCUSED, category: 'cheating', text: 'walls', matchId, moment: { ordinal: 2, half: 1, tMs: 61500 } });
    await file(R2, { targetId: ACCUSED, category: 'griefing', text: '' });
    id = (db.prepare('SELECT id FROM tickets').get() as { id: number }).id;
  });

  it('players are refused, mods and admins get the list', async () => {
    expect((await get(R1, '/api/mod/tickets')).statusCode).toBe(403);
    const list = (await get(MOD, '/api/mod/tickets')).json();
    expect(list.tickets).toHaveLength(1);
    expect(list.tickets[0]).toMatchObject({ id, targetId: ACCUSED, reports: 2, reporters: 2, restricted: false, status: 'open' });
    expect(list.tickets[0].categories.sort()).toEqual(['cheating', 'griefing']);
    expect((await get(ADMIN, '/api/mod/tickets?filter=closed')).json().tickets).toEqual([]);
    expect((await get(ADMIN, '/api/mod/tickets?filter=nonsense')).statusCode).toBe(400);
  });

  it('the detail carries reports with the moment, events, the case file and the viewer cap', async () => {
    const d = (await get(MOD, `/api/mod/tickets/${id}`)).json();
    expect(d.ticket).toMatchObject({ id, targetId: ACCUSED, status: 'open' });
    expect(d.reports.map((r: { reporterId: string }) => r.reporterId).sort()).toEqual([R1, R2].sort());
    expect(d.reports.find((r: { reporterId: string }) => r.reporterId === R1)).toMatchObject({ matchId, campaign: 'dead_air', moment: { ordinal: 2, half: 1, tMs: 61500 } });
    expect(d.events.map((e: { kind: string }) => e.kind)).toEqual(['opened', 'report_attached']);
    expect(d.caseFile).toMatchObject({ steamid: ACCUSED, bans: [], tickets: [{ id }] });
    expect(d.viewer).toEqual({ isAdmin: false, banCapMinutes: 10080 });
    expect((await get(ADMIN, `/api/mod/tickets/${id}`)).json().viewer).toEqual({ isAdmin: true, banCapMinutes: null });
  });

  it('claim, ban, close and reopen work and are audited', async () => {
    expect((await post(MOD, `/api/mod/tickets/${id}/claim`, { claim: true })).statusCode).toBe(200);
    expect((await get(MOD, '/api/mod/tickets?filter=mine')).json().tickets).toHaveLength(1);
    expect((await get(MOD2, '/api/mod/tickets?filter=mine')).json().tickets).toHaveLength(0);
    expect((await post(MOD, `/api/mod/tickets/${id}/ban`, { reason: 'walls', minutes: 20000 })).statusCode).toBe(403);
    expect((await post(MOD, `/api/mod/tickets/${id}/ban`, { reason: 'walls', minutes: 1440 })).statusCode).toBe(200);
    expect((await get(MOD, `/api/mod/tickets/${id}`)).json().bans[0]).toMatchObject({ reason: 'walls', createdBy: MOD });
    expect((await post(MOD, `/api/mod/tickets/${id}/close`, { outcome: 'action_taken', note: 'one day' })).statusCode).toBe(200);
    expect((await get(R1, '/api/reports/mine')).json().reports[0].status).toBe('closed');
    expect((await post(MOD2, `/api/mod/tickets/${id}/reopen`)).statusCode).toBe(200);
    const audit = (await get(ADMIN, '/api/admin/audit')).json();
    expect(audit.actions.slice(0, 4).map((a: { action: string }) => a.action)).toEqual(['ticket_reopen', 'ticket_close', 'ticket_ban', 'ticket_claim']);
    expect(audit.actions[0].target).toBe(String(id));
  });

  it('staff open a ticket by hand', async () => {
    const r = await post(MOD, '/api/mod/tickets', { targetId: R1, note: 'said something in discord' });
    expect(r.statusCode).toBe(200);
    const d = (await get(MOD, `/api/mod/tickets/${r.json().ticketId}`)).json();
    expect(d.reports).toEqual([]);
    expect(d.events.map((e: { kind: string }) => e.kind)).toEqual(['opened', 'note']);
    expect(d.ticket.openedBy).toBe(MOD);
  });
});

describe('restricted tickets over HTTP', () => {
  it('a ticket about a mod is invisible to that mod and to everyone off the list, and its audit rows stay off the feed', async () => {
    await file(R1, { targetId: MOD, category: 'toxicity', text: 'abusive' });
    const id = (db.prepare('SELECT id FROM tickets').get() as { id: number }).id;
    for (const who of [MOD, MOD2, ADMIN]) {
      expect((await get(who, '/api/mod/tickets')).json().tickets).toEqual([]);
      expect((await get(who, `/api/mod/tickets/${id}`)).statusCode).toBe(404);
      expect((await post(who, `/api/mod/tickets/${id}/claim`, { claim: true })).statusCode).toBe(404);
    }
    const events: AdminEvent[] = [];
    const off = subscribeAdminEvents((e) => events.push(e));
    const d = (await get(OWNER, `/api/mod/tickets/${id}`)).json();
    expect(d.ticket.restricted).toBe(true);
    expect(d.access).toEqual([{ steamid: OWNER, name: expect.any(String) }]);
    expect(d.accessCandidates.map((c: { steamid: string }) => c.steamid).sort()).toEqual([MOD2, ADMIN].sort());
    expect((await post(OWNER, `/api/mod/tickets/${id}/access`, { steamid: ADMIN })).statusCode).toBe(200);
    expect((await post(OWNER, `/api/mod/tickets/${id}/restrict`, { restricted: false })).statusCode).toBe(400);
    off();
    expect(events).toEqual([]);
    expect((await get(ADMIN, `/api/mod/tickets/${id}`)).statusCode).toBe(200);
    expect((db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'ticket_access'").get() as { n: number }).n).toBe(1);
  });

  it('opening a restricted ticket by hand answers the same whether or not one already exists', async () => {
    const first = await post(MOD, '/api/mod/tickets', { targetId: ACCUSED, restricted: true, note: 'told in person' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true, ticketId: null });
    const id = (db.prepare('SELECT id FROM tickets').get() as { id: number }).id;
    expect((await post(MOD, '/api/mod/tickets', { targetId: ACCUSED, restricted: true })).json()).toEqual({ ok: true, ticketId: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM tickets').get()).toEqual({ n: 1 });
    expect((await get(MOD, `/api/mod/tickets/${id}`)).statusCode).toBe(404);
    expect((await get(OWNER, `/api/mod/tickets/${id}`)).json().events.map((e: { kind: string }) => e.kind)).toEqual(['opened', 'note']);
  });

  it('audit rows about a restricted ticket reach only its access list', async () => {
    await file(R1, { targetId: MOD, category: 'toxicity', text: 'abusive' });
    const id = (db.prepare('SELECT id FROM tickets').get() as { id: number }).id;
    expect((await post(OWNER, `/api/mod/tickets/${id}/claim`, { claim: true })).statusCode).toBe(200);
    expect((await post(OWNER, `/api/mod/tickets/${id}/close`, { outcome: 'no_action', note: 'nothing in it' })).statusCode).toBe(200);
    const ticketRows = async (as: string) => (await get(as, '/api/admin/audit')).json().actions
      .filter((a: { action: string; target: string }) => a.action.startsWith('ticket_') && a.target === String(id));
    expect(await ticketRows(ADMIN)).toEqual([]);
    expect((await ticketRows(OWNER)).map((a: { action: string }) => a.action)).toEqual(['ticket_close', 'ticket_claim']);
    // The accused, promoted to admin, must learn nothing from the log either.
    db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(MOD);
    expect(await ticketRows(MOD)).toEqual([]);
  });

  it('promoting a player restricts the open ticket about them', async () => {
    await file(R1, { targetId: R2, category: 'griefing', text: 'threw' });
    const id = (db.prepare('SELECT id FROM tickets').get() as { id: number }).id;
    expect((await get(MOD, `/api/mod/tickets/${id}`)).statusCode).toBe(200);
    expect((await post(OWNER, `/api/admin/players/${R2}/mod`, { isMod: true })).statusCode).toBe(200);
    expect(db.prepare('SELECT restricted FROM tickets WHERE id = ?').get(id)).toEqual({ restricted: 1 });
    expect((await get(MOD, `/api/mod/tickets/${id}`)).statusCode).toBe(404);
    expect((await get(OWNER, `/api/mod/tickets/${id}`)).json().events.map((e: { kind: string }) => e.kind))
      .toEqual(['opened', 'restricted']);
  });

  it('promoting a player with both flavours open leaves one restricted ticket holding both reports', async () => {
    await file(R1, { targetId: R2, category: 'griefing', text: 'threw' });
    await file(R1, { targetId: R2, category: 'unsafe', text: 'threats' });
    const normalId = (db.prepare('SELECT id FROM tickets WHERE restricted = 0').get() as { id: number }).id;
    const restrictedId = (db.prepare('SELECT id FROM tickets WHERE restricted = 1').get() as { id: number }).id;
    expect((await post(OWNER, `/api/admin/players/${R2}/admin`, { isAdmin: true })).statusCode).toBe(200);
    expect(db.prepare('SELECT id FROM tickets').all()).toEqual([{ id: restrictedId }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_reports WHERE ticket_id = ?').get(restrictedId)).toEqual({ n: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_reports WHERE ticket_id = ?').get(normalId)).toEqual({ n: 0 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('an accused mod does not see an ordinary ticket about themselves either', async () => {
    db.prepare('UPDATE players SET is_mod = 0 WHERE steamid = ?').run(MOD2);
    await file(R1, { targetId: MOD2, category: 'afk', text: '' });
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD2);
    const id = (db.prepare('SELECT id FROM tickets').get() as { id: number }).id;
    expect((await get(MOD, `/api/mod/tickets/${id}`)).statusCode).toBe(200);
    expect((await get(MOD2, `/api/mod/tickets/${id}`)).statusCode).toBe(404);
    expect((await get(MOD2, '/api/mod/tickets')).json().tickets).toEqual([]);
  });

  it('a ban issued from a restricted ticket is withheld from a case file opened via a different ticket', async () => {
    await file(R1, { targetId: ACCUSED, category: 'unsafe', text: 'weapon threat' });
    const restrictedId = (db.prepare('SELECT id FROM tickets WHERE restricted = 1').get() as { id: number }).id;
    expect((await post(OWNER, `/api/mod/tickets/${restrictedId}/ban`, { reason: 'sensitive detail', minutes: 60 })).statusCode).toBe(200);
    expect((await post(OWNER, `/api/mod/tickets/${restrictedId}/close`, { outcome: 'action_taken', note: '' })).statusCode).toBe(200);
    // ACCUSED is now status banned; that does not stop someone else reporting them.
    await file(R2, { targetId: ACCUSED, category: 'afk', text: '' });
    const normalId = (db.prepare('SELECT id FROM tickets WHERE restricted = 0').get() as { id: number }).id;

    const modBody = (await get(MOD, `/api/mod/tickets/${normalId}`)).json();
    expect(modBody.caseFile.bans).toHaveLength(1);
    expect(modBody.caseFile.bans[0]).toMatchObject({ reason: 'Withheld (restricted ticket)', createdByName: null });
    expect(modBody.caseFile.bans[0].createdBy).toBeFalsy();
    expect(JSON.stringify(modBody.caseFile.bans)).not.toContain('sensitive detail');
    expect(JSON.stringify(modBody.caseFile.bans)).not.toContain(OWNER);
    expect(JSON.stringify(modBody.caseFile.activeBan)).not.toContain('sensitive detail');
    expect(JSON.stringify(modBody.caseFile.activeBan)).not.toContain(OWNER);
    expect(modBody.caseFile.tickets.map((t: { id: number }) => t.id)).not.toContain(restrictedId);

    const ownerBody = (await get(OWNER, `/api/mod/tickets/${normalId}`)).json();
    expect(ownerBody.caseFile.bans[0]).toMatchObject({ reason: 'sensitive detail', createdBy: OWNER });
    expect(ownerBody.caseFile.tickets.map((t: { id: number }) => t.id)).toContain(restrictedId);
  });
});
