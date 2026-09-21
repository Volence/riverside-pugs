import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { setSetting } from '../src/settings.js';
import { publishAdminEvent } from '../src/adminFeed.js';
import { logAdmin } from '../src/admin/audit.js';
import { AdminFeedPoster } from '../src/discord/adminFeedPoster.js';
import { FakeTransport } from './fakes/fakeTransport.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 5 }, (_, i) => `7656119900000000${i}`);
const [ACCUSED, REPORTER, MOD, MOD2, OWNER] = IDS;
let db: DB;
let app: FastifyInstance;
const cookie: Record<string, Record<string, string>> = {};

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({ ADMIN_STEAMIDS: OWNER }), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
  for (const id of IDS) cookie[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid IN (?, ?)').run(MOD, MOD2);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(OWNER);
});
afterEach(async () => { await app.close(); });

describe('the ticket page and the Player File share one summary', () => {
  it('serves the summary beside the ticket, with a link to the full file', async () => {
    await app.inject({ method: 'POST', url: '/api/reports', cookies: cookie[REPORTER], payload: { targetId: ACCUSED, category: 'cheating', text: 'walls' } });
    const id = (db.prepare('SELECT id FROM tickets').get() as { id: number }).id;
    const detail = (await app.inject({ method: 'GET', url: `/api/mod/tickets/${id}`, cookies: cookie[MOD] })).json();
    expect(detail.summary).toMatchObject({ steamid: ACCUSED, openTickets: 1, fileUrl: `/admin/people/${ACCUSED}` });
    expect(detail.summary.evidence).toEqual([]);
  });

  it('gives no file link to a viewer who may not open the file', async () => {
    // A ticket about a member of staff is restricted by the tickets rules.
    // A second moderator let onto the access list may work that ticket and
    // still may not open the colleague's whole file, which is the one case
    // where the summary renders without a way through to it.
    await app.inject({ method: 'POST', url: '/api/mod/tickets', cookies: cookie[OWNER], payload: { targetId: MOD } });
    const id = (db.prepare('SELECT id FROM tickets').get() as { id: number }).id;
    await app.inject({ method: 'POST', url: `/api/mod/tickets/${id}/access`, cookies: cookie[OWNER], payload: { steamid: MOD2 } });
    const detail = (await app.inject({ method: 'GET', url: `/api/mod/tickets/${id}`, cookies: cookie[MOD2] })).json();
    expect(detail.summary.steamid).toBe(MOD);
    expect(detail.summary.fileUrl).toBeNull();
    expect((await app.inject({ method: 'GET', url: `/api/mod/tickets/${id}`, cookies: cookie[OWNER] })).json().summary.fileUrl)
      .toBe(`/admin/people/${MOD}`);
  });
});

describe('the admin feed', () => {
  let t: FakeTransport;
  let feed: AdminFeedPoster;

  beforeEach(() => {
    setSetting(db, 'discord_admin_channel_id', 'admins');
    t = new FakeTransport();
    feed = new AdminFeedPoster({ db, transport: t, publicUrl: 'https://pug.test' });
    feed.start();
  });
  afterEach(() => feed.stop());

  const text = (i: number) => JSON.stringify(t.live()[i]?.payload);

  it('links a named player to their file and a ticket to the People desk', async () => {
    logAdmin(db, OWNER, 'ticket_close', 12, { outcome: 'warned' });
    publishAdminEvent({ kind: 'signon_drop', steamid: ACCUSED, name: 'in game', count: 2, total: 2 });
    publishAdminEvent({
      kind: 'steam_signal', steamid: ACCUSED, matchId: null,
      signal: { what: 'recent_ban', vacBans: 1, gameBans: 0, daysSinceLastBan: 3 },
    });
    await feed.idle();
    expect(text(0)).toContain('https://pug.test/admin/people/tickets/12');
    expect(text(1)).toContain(`https://pug.test/admin/people/${ACCUSED}`);
    expect(text(2)).toContain(`https://pug.test/admin/people/${ACCUSED}`);
    expect(text(0) + text(1) + text(2)).not.toContain('/admin?ticket=');
  });
});
