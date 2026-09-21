import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { banPlayer } from '../src/admin/players.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

// Two legacy readers of the ban list, src/admin/players.ts's publicBans (GET
// /api/bans) and playerDetail (GET /api/admin/players/:steamid), predate the
// tickets confidentiality rule and read bans.reason straight off the row. A
// ban issued from a restricted ticket must come through banRedaction.ts's
// shared rule on both routes, exactly as it already does on the new People
// desk surfaces.

const R1 = '76561198100000001';
const ACCUSED = '76561198100000002';
// Seeded onto the restricted ticket's access list via ADMIN_STEAMIDS.
const OWNER = '76561198100000003';
// An admin who is not on that list: the whole point of the bug.
const ADMIN = '76561198100000004';

let db: DB;
let app: FastifyInstance;
let cookie: Record<string, Record<string, string>>;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({
    config: loadConfig({ ADMIN_STEAMIDS: OWNER }), db, orchestrator: stubOrchestrator(),
    serverCleaner: async () => {}, serverExec: async () => {},
  });
  cookie = { [R1]: authedCookie(app, db, R1), [ACCUSED]: authedCookie(app, db, ACCUSED),
    [OWNER]: authedCookie(app, db, OWNER), [ADMIN]: authedCookie(app, db, ADMIN) };
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid IN (?, ?)').run(OWNER, ADMIN);
});
afterEach(async () => { await app.close(); });

const post = (as: string, url: string, payload: object = {}) => app.inject({ method: 'POST', url, cookies: cookie[as], payload });
const get = (as: string, url: string) => app.inject({ method: 'GET', url, cookies: cookie[as] });

/** Files an 'unsafe' report about ACCUSED (always restricted), bans from
 *  the resulting ticket with a distinctive reason, and returns the ban's id. */
async function banFromRestrictedTicket(reason: string): Promise<number> {
  expect((await post(R1, '/api/reports', { targetId: ACCUSED, category: 'unsafe', text: 'threat' })).statusCode).toBe(200);
  const ticketId = (db.prepare("SELECT id FROM tickets WHERE restricted = 1").get() as { id: number }).id;
  expect((await post(OWNER, `/api/mod/tickets/${ticketId}/ban`, { reason, minutes: 60 })).statusCode).toBe(200);
  return (db.prepare('SELECT id FROM bans WHERE player_id = ?').get(ACCUSED) as { id: number }).id;
}

describe('legacy ban readers redact a ban tied to a ticket the viewer may not see', () => {
  it('GET /api/bans withholds the reason and issuer from an admin off the access list, and shows them to the owner', async () => {
    await banFromRestrictedTicket('sensitive detail about the threat');

    const outsider = (await get(ADMIN, '/api/bans')).json();
    const row = outsider.bans.find((b: { steamid: string }) => b.steamid === ACCUSED);
    expect(row).toMatchObject({ reason: 'Withheld (restricted ticket)', bannedByName: null });
    const outsiderText = JSON.stringify(outsider);
    expect(outsiderText).not.toContain('sensitive detail about the threat');
    expect(outsiderText).not.toContain(OWNER);

    const ownerView = (await get(OWNER, '/api/bans')).json();
    const ownerRow = ownerView.bans.find((b: { steamid: string }) => b.steamid === ACCUSED);
    expect(ownerRow).toMatchObject({ reason: 'sensitive detail about the threat' });
  });

  it('GET /api/admin/players/:steamid withholds the reason and issuer from an admin off the access list, and shows them to the owner', async () => {
    await banFromRestrictedTicket('another sensitive detail');

    const outsider = (await get(ADMIN, `/api/admin/players/${ACCUSED}`)).json();
    expect(outsider.bans[0]).toMatchObject({ reason: 'Withheld (restricted ticket)', createdByName: null });
    expect(outsider.activeBan).toMatchObject({ reason: 'Withheld (restricted ticket)', createdByName: null });
    const outsiderText = JSON.stringify(outsider);
    expect(outsiderText).not.toContain('another sensitive detail');
    expect(outsiderText).not.toContain(OWNER);

    const ownerView = (await get(OWNER, `/api/admin/players/${ACCUSED}`)).json();
    expect(ownerView.bans[0]).toMatchObject({ reason: 'another sensitive detail', createdBy: OWNER });
    expect(ownerView.activeBan).toMatchObject({ reason: 'another sensitive detail', createdBy: OWNER });
  });

  it('a ban with no ticket is unchanged for everyone on both routes', async () => {
    banPlayer(db, ACCUSED, OWNER, 'plain old ban', null);

    for (const viewer of [ADMIN, OWNER]) {
      const bansRow = (await get(viewer, '/api/bans')).json().bans.find((b: { steamid: string }) => b.steamid === ACCUSED);
      expect(bansRow).toMatchObject({ reason: 'plain old ban' });
      const detail = (await get(viewer, `/api/admin/players/${ACCUSED}`)).json();
      expect(detail.activeBan).toMatchObject({ reason: 'plain old ban', createdBy: OWNER });
    }
  });

  it('fails closed when the ban\'s ticket row no longer resolves, even for the ticket owner', async () => {
    banPlayer(db, ACCUSED, OWNER, 'orphaned reason', null);
    const banId = (db.prepare('SELECT id FROM bans WHERE player_id = ?').get(ACCUSED) as { id: number }).id;
    // A ticket id that was never a real ticket: the dangling-pointer case
    // banIsWithheld is built to fail closed on.
    db.prepare('UPDATE bans SET ticket_id = 999999 WHERE id = ?').run(banId);

    for (const viewer of [ADMIN, OWNER]) {
      const bansRow = (await get(viewer, '/api/bans')).json().bans.find((b: { steamid: string }) => b.steamid === ACCUSED);
      expect(bansRow).toMatchObject({ reason: 'Withheld (restricted ticket)', bannedByName: null });
      const detail = (await get(viewer, `/api/admin/players/${ACCUSED}`)).json();
      expect(detail.activeBan).toMatchObject({ reason: 'Withheld (restricted ticket)', createdByName: null });
    }
  });
});
