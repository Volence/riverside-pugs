import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { linkDiscord } from '../src/players.js';
import { fileReport, openStaffTicket } from '../src/tickets/filing.js';
import { setRestricted } from '../src/tickets/actions.js';
import { canSeeTicket, getTicketRow, holdFeedAbout, ticketIsQuiet } from '../src/tickets/store.js';
import { listTickets } from '../src/tickets/views.js';
import { mergePlayers } from '../src/mergePlayers.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000030${i}`);
const [R1, R2, ACCUSED, MOD, MOD2, ADMIN, OWNER, NEWBIE] = IDS;
const deps = { adminSteamIds: [OWNER] };
let db: DB;
let app: FastifyInstance;
let events: AdminEvent[];
let off: () => void;
const cookie: Record<string, Record<string, string>> = {};

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({ ADMIN_STEAMIDS: OWNER }), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
  for (const id of IDS) cookie[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid IN (?, ?)').run(MOD, MOD2);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid IN (?, ?)').run(ADMIN, OWNER);
  events = [];
  off = subscribeAdminEvents((e) => events.push(e));
});
afterEach(async () => { off(); await app.close(); });

const post = (as: string, url: string, payload: object = {}) => app.inject({ method: 'POST', url, cookies: cookie[as], payload });
const get = (as: string, url: string) => app.inject({ method: 'GET', url, cookies: cookie[as] });
const fileAbout = (target: string, category = 'toxicity', text = 'rude in voice', by = R1) =>
  fileReport(db, by, { targetId: target, category, text }, deps) as { ok: true; ticketId: number; restricted: boolean };
const heldOf = (ticketId: number) => (db.prepare('SELECT feed_held FROM ticket_reports WHERE ticket_id = ? ORDER BY id').all(ticketId) as { feed_held: number }[]).map((r) => r.feed_held);

describe('a report about staff', () => {
  it('is an ordinary ticket every other moderator works, the accused never sees, and the admin feed never hears', () => {
    const r = fileAbout(MOD);
    expect(r).toMatchObject({ ok: true, restricted: false });
    const t = getTicketRow(db, r.ticketId)!;
    expect(t.restricted).toBe(0);
    expect(heldOf(r.ticketId)).toEqual([1]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_access WHERE ticket_id = ?').get(r.ticketId)).toEqual({ n: 0 });
    for (const who of [MOD2, ADMIN, OWNER]) expect(canSeeTicket(db, t, who)).toBe(true);
    expect(canSeeTicket(db, t, MOD)).toBe(false);
    expect(listTickets(db, MOD, 'open')).toEqual([]);
    expect(listTickets(db, MOD2, 'open').map((x) => x.id)).toEqual([r.ticketId]);
  });

  it('is restricted when it is a safety report, and the accused is never on the list', () => {
    const r = fileAbout(MOD, 'unsafe', 'threatened someone');
    expect(r).toMatchObject({ ok: true, restricted: true });
    const access = (db.prepare('SELECT steamid FROM ticket_access WHERE ticket_id = ?').all(r.ticketId) as { steamid: string }[]).map((a) => a.steamid);
    expect(access).toEqual([OWNER]);
  });

  it('about a Discord administrator with no player account is ordinary too, and held from the feed', () => {
    const r = fileReport(db, R1, { category: 'toxicity', text: '' }, {
      ...deps, targetDiscord: { discordId: '990000000000000077', name: 'Boss', bot: false, administrator: true },
    }) as { ok: true; ticketId: number; restricted: boolean };
    expect(r).toMatchObject({ ok: true, restricted: false });
    expect(heldOf(r.ticketId)).toEqual([1]);
  });

  it('opened by hand is restricted only when asked', () => {
    const plain = openStaffTicket(db, MOD2, { targetId: MOD, note: 'seen in voice' }, deps) as { ok: true; ticketId: number };
    expect(getTicketRow(db, plain.ticketId)!.restricted).toBe(0);
    const asked = openStaffTicket(db, OWNER, { targetId: ADMIN, restricted: true }, deps) as { ok: true; ticketId: number };
    expect(getTicketRow(db, asked.ticketId)!.restricted).toBe(1);
  });

  it('can have its restriction lifted unless it holds a safety report', () => {
    const r = fileAbout(MOD);
    expect(setRestricted(db, r.ticketId, OWNER, true, deps.adminSteamIds).ok).toBe(true);
    expect(setRestricted(db, r.ticketId, OWNER, false, deps.adminSteamIds)).toEqual({ ok: true });
    const unsafe = fileAbout(MOD, 'unsafe', 'threats', R2);
    expect(setRestricted(db, unsafe.ticketId, OWNER, false, deps.adminSteamIds)).toMatchObject({ ok: false, status: 400 });
  });
});

describe('quiet audit rows', () => {
  it('ticketIsQuiet: restricted, or about somebody with a staff flag', () => {
    expect(ticketIsQuiet(db, { restricted: 0, target_id: ACCUSED })).toBe(false);
    expect(ticketIsQuiet(db, { restricted: 1, target_id: ACCUSED })).toBe(true);
    expect(ticketIsQuiet(db, { restricted: 0, target_id: MOD })).toBe(true);
    expect(ticketIsQuiet(db, { restricted: 0, target_id: null })).toBe(false);
  });

  it('an action on an ordinary ticket about an admin is audited, and the admin feed hears nothing', async () => {
    const r = fileAbout(ADMIN);
    expect((await post(MOD, `/api/mod/tickets/${r.ticketId}/claim`, { claim: true })).statusCode).toBe(200);
    expect((await post(MOD, `/api/mod/tickets/${r.ticketId}/close`, { outcome: 'warned', note: '' })).statusCode).toBe(200);
    expect(events.filter((e) => e.kind === 'admin_action')).toEqual([]);
    const actions = (db.prepare("SELECT action FROM admin_actions WHERE target = ? ORDER BY id").all(String(r.ticketId)) as { action: string }[]).map((a) => a.action);
    expect(actions).toEqual(['ticket_claim', 'ticket_close']);
    // The accused admin reads the audit log and learns nothing.
    const rows = (await get(ADMIN, '/api/admin/audit')).json().actions.filter((a: { target: string }) => a.target === String(r.ticketId));
    expect(rows).toEqual([]);
    expect((await get(ADMIN, `/api/mod/tickets/${r.ticketId}`)).statusCode).toBe(404);
  });
});

describe('promotion, merge and adoption', () => {
  it('promoting the accused leaves the ticket ordinary, hides it from them, and holds what the feed has not said', async () => {
    const r = fileAbout(ACCUSED, 'griefing');
    expect(heldOf(r.ticketId)).toEqual([0]);
    expect((await post(OWNER, `/api/admin/players/${ACCUSED}/mod`, { isMod: true })).statusCode).toBe(200);
    expect(getTicketRow(db, r.ticketId)!.restricted).toBe(0);
    expect(heldOf(r.ticketId)).toEqual([1]);
    expect((await get(MOD2, `/api/mod/tickets/${r.ticketId}`)).statusCode).toBe(200);
    // Promoting ACCUSED ends their sessions (src/routes/admin.ts), same as a
    // demotion would: re-sign-in, as they would have to for real, before
    // checking what they can see of their own case.
    cookie[ACCUSED] = authedCookie(app, db, ACCUSED);
    expect((await get(ACCUSED, `/api/mod/tickets/${r.ticketId}`)).statusCode).toBe(404);
    expect(events.filter((e) => e.kind === 'problem')).toEqual([]);
  });

  it('promoting someone with both flavours open leaves both tickets as they were', async () => {
    const normal = fileAbout(ACCUSED, 'griefing');
    const unsafe = fileAbout(ACCUSED, 'unsafe', 'threats', R2);
    expect((await post(OWNER, `/api/admin/players/${ACCUSED}/admin`, { isAdmin: true })).statusCode).toBe(200);
    expect(db.prepare('SELECT id, restricted FROM tickets ORDER BY id').all()).toEqual([
      { id: normal.ticketId, restricted: 0 }, { id: unsafe.ticketId, restricted: 1 },
    ]);
  });

  it('holdFeedAbout leaves announced reports alone and counts what it held', () => {
    const r = fileAbout(ACCUSED, 'griefing');
    fileAbout(ACCUSED, 'afk', '', R2);
    db.prepare("UPDATE ticket_reports SET announced_at = 'x' WHERE id = (SELECT MIN(id) FROM ticket_reports)").run();
    expect(holdFeedAbout(db, ACCUSED)).toBe(1);
    expect(heldOf(r.ticketId)).toEqual([0, 1]);
  });

  it('merging a player into a staff account keeps the ticket ordinary and the survivor off every list about themselves', () => {
    const r = fileAbout(R2, 'griefing', 'threw', R1);
    mergePlayers(db, { from: R2, into: MOD, by: OWNER, adminSteamIds: [OWNER] });
    const t = getTicketRow(db, r.ticketId)!;
    expect(t).toMatchObject({ target_id: MOD, restricted: 0 });
    expect(canSeeTicket(db, t, MOD)).toBe(false);
    expect(heldOf(r.ticketId)).toEqual([1]);
    expect(events.filter((e) => e.kind === 'problem')).toEqual([]);
  });

  it('adoption fills in who wrote the messages, keeps a staff case ordinary, and says when a restricted ticket is left with nobody', () => {
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(NEWBIE);
    const lurker = { discordId: '950', name: 'Lurky', bot: false, administrator: false };
    const normal = fileReport(db, R1, { category: 'toxicity', text: '' }, { ...deps, targetDiscord: lurker }) as { ticketId: number };
    // A message the lurker wrote in a ticket thread before they linked.
    db.prepare(
      `INSERT INTO ticket_messages (ticket_id, thread_id, channel, discord_message_id, author_discord_id, author_player_id, author_name, content, created_at)
       VALUES (?, '8001', 'reporter', '8002', '950', NULL, 'Lurky', 'hello', '2026-09-22T00:00:00Z')`,
    ).run(normal.ticketId);
    // A restricted ticket nobody can be given: no owners passed, and no admin is left.
    db.prepare('UPDATE players SET is_admin = 0').run();
    fileReport(db, R2, { category: 'unsafe', text: 'threats' }, { adminSteamIds: [], targetDiscord: lurker });
    expect(linkDiscord(db, NEWBIE, '950', 'Lurky', { adminSteamIds: [] })).toMatchObject({ ok: true });
    expect(db.prepare("SELECT author_player_id FROM ticket_messages WHERE discord_message_id = '8002'").get()).toEqual({ author_player_id: NEWBIE });
    expect(getTicketRow(db, normal.ticketId)).toMatchObject({ target_id: NEWBIE, restricted: 0 });
    expect(heldOf(normal.ticketId)).toEqual([1]);
    const problems = events.filter((e) => e.kind === 'problem').map((e) => (e as { text: string }).text);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/nobody on its access list/);
    expect(problems[0]).not.toContain(NEWBIE);
    expect(problems[0]).not.toContain('950');
  });
});
