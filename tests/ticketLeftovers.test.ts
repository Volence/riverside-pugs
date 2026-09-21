import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { fileReport } from '../src/tickets/filing.js';
import { claimTicket } from '../src/tickets/actions.js';
import { reseedOrphanedTickets, restrictOpenTicketAbout } from '../src/tickets/store.js';
import { mergePlayers } from '../src/mergePlayers.js';
import { logAdmin, recentActions } from '../src/admin/audit.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const [R1, R2, PLAYER, MAIN, ALT, ADMIN, OWNER, MOD] = IDS;
let db: DB;
let events: AdminEvent[];
let off: () => void;

const flag = (column: 'is_admin' | 'is_mod', ...ids: string[]) => {
  for (const id of ids) db.prepare(`UPDATE players SET ${column} = 1 WHERE steamid = ?`).run(id);
};
const accessOf = (ticketId: number) =>
  (db.prepare('SELECT steamid FROM ticket_access WHERE ticket_id = ? ORDER BY steamid').all(ticketId) as { steamid: string }[]).map((r) => r.steamid);
const file = (reporter: string, targetId: string, category = 'griefing', text = 'x') =>
  (fileReport(db, reporter, { targetId, category, text }, { adminSteamIds: [] }) as { ticketId: number }).ticketId;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of IDS) {
    upsertPlayer(db, { steamid: id, name: `p${id.slice(-1)}`, avatar: null }, []);
    activatePlayer(db, id);
  }
  events = [];
  off = subscribeAdminEvents((e) => events.push(e));
});
afterEach(() => off());

describe('a restricted ticket always has somebody on it', () => {
  it('does not restrict when nobody could be given access, and says so', () => {
    const id = file(R1, PLAYER);
    expect(restrictOpenTicketAbout(db, PLAYER, [])).toBe('nobody');
    expect(db.prepare('SELECT restricted FROM tickets WHERE id = ?').get(id)).toEqual({ restricted: 0 });
    expect(accessOf(id)).toEqual([]);
  });

  it('a merge into the only admin leaves the ticket normal and reports a problem that names nobody', () => {
    flag('is_admin', MAIN);
    const id = file(R1, ALT);
    mergePlayers(db, { from: ALT, into: MAIN, by: MAIN, adminSteamIds: [] });
    expect(db.prepare('SELECT target_id, restricted FROM tickets WHERE id = ?').get(id)).toEqual({ target_id: MAIN, restricted: 0 });
    const problems = events.filter((e) => e.kind === 'problem');
    expect(problems).toHaveLength(1);
    expect(JSON.stringify(problems[0])).toMatch(/could not be restricted/);
    expect(JSON.stringify(problems[0])).not.toContain(MAIN);
    expect(JSON.stringify(problems[0])).not.toContain(String(id));
  });

  it('a merge takes its owners from the caller', () => {
    flag('is_mod', MAIN);
    flag('is_admin', ADMIN, OWNER);
    const id = file(R1, PLAYER);
    // PLAYER becomes MAIN, a moderator. With no owner list the fallback would
    // be every admin, ADMIN included.
    mergePlayers(db, { from: PLAYER, into: MAIN, by: OWNER, adminSteamIds: [OWNER] });
    expect(db.prepare('SELECT restricted FROM tickets WHERE id = ?').get(id)).toEqual({ restricted: 1 });
    expect(accessOf(id)).toEqual([OWNER]);
  });

  it('never seeds the account that is being merged away', () => {
    flag('is_mod', MAIN);
    const id = file(R1, ALT);
    // Made an admin by hand after the report, so the ticket is still normal
    // and ALT is the only admin there is. Seeding ALT would restrict the
    // ticket and then empty its list in the same transaction.
    flag('is_admin', ALT);
    mergePlayers(db, { from: ALT, into: MAIN, by: OWNER, adminSteamIds: [] });
    expect(db.prepare('SELECT restricted FROM tickets WHERE id = ?').get(id)).toEqual({ restricted: 0 });
    expect(accessOf(id)).toEqual([]);
    expect(events.filter((e) => e.kind === 'problem')).toHaveLength(1);
  });

  it('a list emptied by the merge itself is filled again from the owners', () => {
    flag('is_mod', MAIN);
    flag('is_admin', ALT, OWNER);
    const id = file(R1, MAIN, 'toxicity');
    db.prepare('DELETE FROM ticket_access WHERE ticket_id = ? AND steamid != ?').run(id, ALT);
    expect(accessOf(id)).toEqual([ALT]);
    mergePlayers(db, { from: ALT, into: MAIN, by: OWNER, adminSteamIds: [OWNER] });
    expect(accessOf(id)).toEqual([OWNER]);
    expect(events.filter((e) => e.kind === 'problem')).toHaveLength(0);
  });

  it('an orphaned ticket is handed to whoever can take it, and counts what is left', () => {
    flag('is_mod', MAIN);
    const id = file(R1, MAIN, 'toxicity');
    expect(accessOf(id)).toEqual([]);
    expect(reseedOrphanedTickets(db, [])).toEqual({ seeded: 0, stillEmpty: 1 });
    flag('is_admin', ADMIN);
    expect(reseedOrphanedTickets(db, [])).toEqual({ seeded: 1, stillEmpty: 0 });
    expect(accessOf(id)).toEqual([ADMIN]);
  });
});

describe('folding two tickets', () => {
  it('moves the audit rows onto the survivor and leaves a line in its timeline', () => {
    flag('is_admin', ADMIN);
    const main = file(R1, MAIN);
    const alt = file(R2, ALT, 'cheating');
    claimTicket(db, alt, ADMIN, true);
    logAdmin(db, ADMIN, 'ticket_claim', alt, { claim: true });
    logAdmin(db, ADMIN, 'ban', ALT, { reason: 'unrelated' });
    mergePlayers(db, { from: ALT, into: MAIN, by: ADMIN, adminSteamIds: [] });
    expect(db.prepare('SELECT id FROM tickets').all()).toEqual([{ id: main }]);
    const rows = recentActions(db, ADMIN).filter((a) => a.action === 'ticket_claim');
    expect(rows.map((a) => a.target)).toEqual([String(main)]);
    const folded = db.prepare("SELECT detail FROM ticket_events WHERE ticket_id = ? AND kind = 'folded'").get(main) as { detail: string };
    expect(JSON.parse(folded.detail)).toEqual({ from: alt });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('counts on the list', () => {
  let app: FastifyInstance;
  afterEach(async () => { await app.close(); });

  it('counts what this viewer may see, per filter', async () => {
    app = await buildServer({ config: loadConfig({ ADMIN_STEAMIDS: OWNER }), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
    const cookie = (id: string) => authedCookie(app, db, id);
    flag('is_mod', MOD);
    flag('is_admin', OWNER);
    const a = file(R1, PLAYER);
    file(R1, ALT);
    file(R2, PLAYER, 'unsafe', 'restricted, so the moderator never counts it');
    claimTicket(db, a, MOD, true);
    db.prepare("UPDATE tickets SET status = 'closed' WHERE target_id = ?").run(ALT);
    const asMod = (await app.inject({ method: 'GET', url: '/api/mod/tickets?filter=open', cookies: cookie(MOD) })).json();
    expect(asMod.counts).toEqual({ open: 1, mine: 1, closed: 1 });
    expect(asMod.tickets).toHaveLength(1);
    const asOwner = (await app.inject({ method: 'GET', url: '/api/mod/tickets?filter=closed', cookies: cookie(OWNER) })).json();
    expect(asOwner.counts).toEqual({ open: 2, mine: 0, closed: 1 });
  });
});
