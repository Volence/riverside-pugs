import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { banPlayer } from '../src/admin/players.js';
import { addAlias } from '../src/aliases.js';
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

  // Carried over from the reports this replaced. requireActive and fileReport
  // both ask src/standing.ts, so the bans table and the alias table count.
  it('refuses a reporter who is banned, not yet active, or merged away, and files nothing', async () => {
    const body = { targetId: ACCUSED, category: 'afk', text: '' };
    const filed = () => (db.prepare('SELECT COUNT(*) AS n FROM ticket_reports').get() as { n: number }).n;

    // Signed in again after the ban, which ended the session they had.
    banPlayer(db, R1, ADMIN, 'toxic', 60);
    cookie[R1] = authedCookie(app, db, R1, { active: false });
    expect((await file(R1, body)).statusCode).toBe(403);
    expect((await post(R1, `/api/matches/${matchId}/reports`, body)).statusCode).toBe(403);

    db.prepare("UPDATE players SET status = 'invited' WHERE steamid = ?").run(R2);
    expect((await file(R2, body)).statusCode).toBe(403);

    // A row left over from before logins refused aliases, still marked active.
    addAlias(db, { steamid: MOD2, canonical: MOD, by: 'test' });
    expect((await file(MOD2, body)).statusCode).toBe(403);

    expect(filed()).toBe(0);
    expect((await file(OWNER, body)).statusCode).toBe(200);
  });

  it('the old admin report routes are gone', async () => {
    expect((await get(ADMIN, '/api/admin/reports')).statusCode).toBe(404);
  });

  it('the match page route carries a replay moment through', async () => {
    const r = await post(R1, `/api/matches/${matchId}/reports`, { targetId: ACCUSED, category: 'cheating', text: 'here', moment: { ordinal: 2, half: 1, tMs: 61500 } });
    expect(r.statusCode).toBe(200);
    expect(db.prepare('SELECT map_ordinal, half, t_ms FROM ticket_reports').get()).toEqual({ map_ordinal: 2, half: 1, t_ms: 61500 });
    expect((await post(R2, `/api/matches/${matchId}/reports`, { targetId: ACCUSED, category: 'cheating', text: '', moment: { ordinal: 2 } })).statusCode).toBe(400);
  });
});

describe('reports about a shared entry', () => {
  it('carry the entry in the ticket detail, and show when staff removed it', async () => {
    const entryId = Number(db.prepare(
      `INSERT INTO community_entries (kind, author_id, title, payload, created_at)
       VALUES ('crosshair', ?, 'Loud cross', '{}', '2026-09-24T00:00:00.000Z')`,
    ).run(ACCUSED).lastInsertRowid);
    expect((await file(R1, { targetId: ACCUSED, category: 'toxicity', text: '', entryId })).statusCode).toBe(200);
    expect((await file(R2, { targetId: ACCUSED, category: 'griefing', text: '' })).statusCode).toBe(200);
    const id = (db.prepare('SELECT id FROM tickets').get() as { id: number }).id;

    const before = (await get(MOD, `/api/mod/tickets/${id}`)).json();
    expect(before.reports[0].entry).toEqual({ id: entryId, kind: 'crosshair', title: 'Loud cross', removed: false });
    expect(before.reports[1].entry).toBeNull();

    expect((await post(MOD, `/api/community/${entryId}/remove`, { reason: 'offensive' })).statusCode).toBe(200);
    const after = (await get(MOD, `/api/mod/tickets/${id}`)).json();
    expect(after.reports[0].entry).toEqual({ id: entryId, kind: 'crosshair', title: 'Loud cross', removed: true });
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

  // requireMod asks the predicate every other guard asks (src/standing.ts):
  // the flag alone is not enough, whatever players.status still says.
  it('a banned moderator, and one whose SteamID was merged away, are refused', async () => {
    expect((await get(MOD, '/api/mod/tickets')).statusCode).toBe(200);
    // A ban in force counts even where status has not caught up with it. The
    // ban ended the session they had, so this is them signed in again.
    banPlayer(db, MOD, ADMIN, 'toxic', 60);
    db.prepare("UPDATE players SET status = 'active' WHERE steamid = ?").run(MOD);
    cookie[MOD] = authedCookie(app, db, MOD);
    expect((await get(MOD, '/api/mod/tickets')).statusCode).toBe(403);
    expect((await post(MOD, `/api/mod/tickets/${id}/claim`, { claim: true })).statusCode).toBe(403);

    expect((await get(MOD2, '/api/mod/tickets')).statusCode).toBe(200);
    addAlias(db, { steamid: MOD2, canonical: R1, by: 'test' });
    expect((await get(MOD2, '/api/mod/tickets')).statusCode).toBe(403);
    expect((await get(MOD2, `/api/mod/tickets/${id}`)).statusCode).toBe(403);

    // A banned admin is staff no more than a banned moderator is.
    banPlayer(db, ADMIN, OWNER, 'toxic', 60);
    cookie[ADMIN] = authedCookie(app, db, ADMIN, { active: false });
    expect((await get(ADMIN, '/api/mod/tickets')).statusCode).toBe(403);
    expect((await get(OWNER, '/api/mod/tickets')).statusCode).toBe(200);
  });

  it('the detail carries reports with the moment, events, the case file, the summary and the viewer cap', async () => {
    const d = (await get(MOD, `/api/mod/tickets/${id}`)).json();
    expect(d.ticket).toMatchObject({ id, targetId: ACCUSED, status: 'open' });
    expect(d.reports.map((r: { reporterId: string }) => r.reporterId).sort()).toEqual([R1, R2].sort());
    expect(d.reports.find((r: { reporterId: string }) => r.reporterId === R1)).toMatchObject({ matchId, campaign: 'dead_air', moment: { ordinal: 2, half: 1, tMs: 61500 } });
    expect(d.events.map((e: { kind: string }) => e.kind)).toEqual(['opened', 'report_attached']);
    expect(d.caseFile).toMatchObject({ steamid: ACCUSED, bans: [], tickets: [{ id }] });
    expect(d.summary).toMatchObject({ steamid: ACCUSED, bans: 0, fileUrl: `/admin/people/${ACCUSED}` });
    expect(d.viewer).toEqual({ isAdmin: false, banCapMinutes: 10080 });
    expect((await get(ADMIN, `/api/mod/tickets/${id}`)).json().viewer).toEqual({ isAdmin: true, banCapMinutes: null });
  });

  it('says the Discord discussion is not configured when it is not', async () => {
    const d = (await get(MOD, `/api/mod/tickets/${id}`)).json();
    expect(d.discussion).toEqual({ state: 'unconfigured', surface: null, url: null });
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

  it('a ban from a ticket pulls the player out of a ready check, not only out of the queue', async () => {
    const others = Array.from({ length: 7 }, (_, i) => `7656119800000010${i}`);
    for (const p of others) await app.inject({ method: 'POST', url: '/api/queue/join', cookies: authedCookie(app, db, p) });
    await post(ACCUSED, '/api/queue/join');
    expect((await get(ACCUSED, '/api/state')).json().lobby).not.toBeNull();
    expect((await post(MOD, `/api/mod/tickets/${id}/ban`, { reason: 'walls', minutes: 60 })).statusCode).toBe(200);
    const seat = (await app.inject({ method: 'GET', url: '/api/state', cookies: authedCookie(app, db, others[0]) })).json();
    expect(seat.lobby).toBeNull();
    expect(seat.queue.count).toBe(7);
    expect(seat.queue.players.map((p: { steamid: string }) => p.steamid)).not.toContain(ACCUSED);
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
  it('a restricted ticket about a mod is invisible to that mod and to everyone off the list, and its audit rows stay off the feed', async () => {
    await file(R1, { targetId: MOD, category: 'unsafe', text: 'abusive' });
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
    await file(R1, { targetId: MOD, category: 'unsafe', text: 'abusive' });
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

  it('promoting a player leaves the open ticket about them ordinary and hides it from them', async () => {
    await file(R1, { targetId: R2, category: 'griefing', text: 'threw' });
    const id = (db.prepare('SELECT id FROM tickets').get() as { id: number }).id;
    expect((await post(OWNER, `/api/admin/players/${R2}/mod`, { isMod: true })).statusCode).toBe(200);
    expect(db.prepare('SELECT restricted FROM tickets WHERE id = ?').get(id)).toEqual({ restricted: 0 });
    expect((await get(MOD, `/api/mod/tickets/${id}`)).statusCode).toBe(200);
    // Promoting R2 ends their sessions (src/routes/admin.ts): re-sign-in, as
    // they would have to for real, before checking what they can see.
    cookie[R2] = authedCookie(app, db, R2);
    expect((await get(R2, `/api/mod/tickets/${id}`)).statusCode).toBe(404);
    expect((await get(OWNER, `/api/mod/tickets/${id}`)).json().events.map((e: { kind: string }) => e.kind)).toEqual(['opened']);
  });

  it('promoting a player with both flavours open leaves both tickets as they were', async () => {
    await file(R1, { targetId: R2, category: 'griefing', text: 'threw' });
    await file(R1, { targetId: R2, category: 'unsafe', text: 'threats' });
    const before = db.prepare('SELECT id, restricted FROM tickets ORDER BY id').all();
    expect((await post(OWNER, `/api/admin/players/${R2}/admin`, { isAdmin: true })).statusCode).toBe(200);
    expect(db.prepare('SELECT id, restricted FROM tickets ORDER BY id').all()).toEqual(before);
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

  it('a ban issued from a restricted ticket is withheld from a case file and summary opened via a different ticket', async () => {
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
    expect(modBody.summary.bans).toBe(1);
    expect(modBody.summary.activeBan).toMatchObject({ reason: 'Withheld (restricted ticket)', createdByName: null });
    expect(modBody.summary.activeBan.createdBy).toBeFalsy();
    expect(JSON.stringify(modBody.summary)).not.toContain('sensitive detail');
    expect(JSON.stringify(modBody.summary)).not.toContain(OWNER);
    // The summary carries counts rather than ticket ids, so the restricted
    // ticket cannot be inferred from it at all.
    expect(JSON.stringify(modBody.summary)).not.toContain(`"${restrictedId}"`);

    const ownerBody = (await get(OWNER, `/api/mod/tickets/${normalId}`)).json();
    expect(ownerBody.caseFile.bans[0]).toMatchObject({ reason: 'sensitive detail', createdBy: OWNER });
    expect(ownerBody.caseFile.tickets.map((t: { id: number }) => t.id)).toContain(restrictedId);
    expect(ownerBody.summary.activeBan).toMatchObject({ reason: 'sensitive detail', createdBy: OWNER });
  });
});
