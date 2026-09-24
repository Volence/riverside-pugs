import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, linkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { fileReport } from '../src/tickets/filing.js';
import { addAccess } from '../src/tickets/actions.js';
import { staffThread, surfaceFor } from '../src/tickets/threads.js';
import { getTicketRow } from '../src/tickets/store.js';
import { ticketDetail } from '../src/tickets/views.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { TicketSync } from '../src/discord/ticketSync.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000032${i}`);
const [R1, , , ACCUSED, , , MOD, ADMIN] = IDS;
let db: DB;
let t: FakeTransport;
let sync: TicketSync;
let events: AdminEvent[];
let off: () => void;

beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `player${i}`, avatar: null }, []);
    activatePlayer(db, id);
    linkDiscord(db, id, `92${i}`, `d${i}`);
  });
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  setSetting(db, 'discord_tickets_forum_id', 'forum1');
  setSetting(db, 'discord_tickets_channel_id', 'chan1');
  t = new FakeTransport();
  sync = new TicketSync({ db, transport: t, publicUrl: 'https://pug.test', intervalMs: 0 });
  sync.start();
  events = [];
  off = subscribeAdminEvents((e) => events.push(e));
});
afterEach(() => { sync.stop(); off(); });

describe('a restricted ticket', () => {
  it('gets no Discord thread anywhere; its list is DMed the site link and nothing else', async () => {
    const id = (fileReport(db, R1, { targetId: ACCUSED, category: 'unsafe', text: 'threats' }, { adminSteamIds: [ADMIN] }) as { ticketId: number }).ticketId;
    addAccess(db, id, ADMIN, MOD);
    await sync.idle();
    expect(t.threadsById.size).toBe(0);
    expect(staffThread(db, id)).toBeUndefined();
    expect(t.dms.map((d) => d.userId).sort()).toEqual(['926', '927']);
    for (const dm of t.dms) {
      const said = JSON.stringify(dm.payload);
      expect(said).toContain(`https://pug.test/admin/people/tickets/${id}`);
      expect(said).toContain('on the site only');
      expect(said).not.toContain('player3');
    }
    await sync.reconcile();
    expect(t.dms).toHaveLength(2);
    expect(events).toEqual([]);
  });

  it('surfaceFor and the ticket page say so', () => {
    const id = (fileReport(db, R1, { targetId: ACCUSED, category: 'unsafe', text: 'threats' }, { adminSteamIds: [ADMIN] }) as { ticketId: number }).ticketId;
    expect(surfaceFor(db, getTicketRow(db, id)!)).toEqual({ surface: null, why: 'restricted' });
    expect(ticketDetail(db, id, ADMIN, { guildId: 'g1' })!.discussion).toEqual({ state: 'restricted', surface: null, url: null });
  });
});
