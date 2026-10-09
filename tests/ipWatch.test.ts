import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { banPlayer } from '../src/admin/players.js';
import { recordPlayerNet } from '../src/playerNetworks.js';
import { addAlias } from '../src/aliases.js';
import { checkConnection, clearEvader, flagEvader, ipWatchView, unwatch, watchAddress } from '../src/ipWatch.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';

const EVADER = '76561198000000001';
const ALT = '76561198000000002';
const HOUSEMATE = '76561198000000003';
const STAFF = '76561198000000009';

let db: DB;
let events: Extract<AdminEvent, { kind: 'ip_match' }>[];
let off: () => void;

/** One connect, the way server.ts handles a player_net line. */
function connect(steamid: string, ip: string) {
  const h = recordPlayerNet(db, { steamid, ip, country: 'US' });
  if (h) checkConnection(db, steamid, h);
}

beforeEach(() => {
  db = openDb(':memory:');
  for (const [id, name] of [[EVADER, 'ne'], [ALT, 'bad_magic'], [HOUSEMATE, 'roomie'], [STAFF, 'staff']]) {
    upsertPlayer(db, { steamid: id, name, avatar: null }, []);
  }
  events = [];
  off = subscribeAdminEvents((e) => { if (e.kind === 'ip_match') events.push(e); });
});
afterEach(() => off());

describe('shared connection with a banned account', () => {
  it('posts a plain alert once per account and address', () => {
    connect(EVADER, '8.8.8.8');
    banPlayer(db, EVADER, STAFF, 'toxic', null);
    connect(ALT, '8.8.8.8');
    connect(ALT, '8.8.8.8');
    expect(events).toEqual([{ kind: 'ip_match', level: 'banned', steamid: ALT, others: [EVADER], flagged: null, note: '' }]);
  });

  it('says nothing when nobody on the address is banned', () => {
    connect(EVADER, '8.8.8.8');
    connect(HOUSEMATE, '8.8.8.8');
    expect(events).toEqual([]);
  });

  it('says nothing about an account that is itself banned', () => {
    connect(EVADER, '8.8.8.8');
    banPlayer(db, EVADER, STAFF, 'toxic', null);
    banPlayer(db, ALT, STAFF, 'alt', null);
    connect(ALT, '8.8.8.8');
    expect(events).toEqual([]);
  });

  it('ignores private addresses', () => {
    connect(EVADER, '192.168.1.5');
    banPlayer(db, EVADER, STAFF, 'toxic', null);
    connect(ALT, '192.168.1.5');
    expect(events).toEqual([]);
  });

});

describe('the watch list', () => {
  it('watches every address a flagged evader used, and new ones as they appear', () => {
    connect(EVADER, '8.8.8.8');
    flagEvader(db, EVADER, 'dethisa', STAFF);
    connect(EVADER, '1.1.1.1');
    const hashes = ipWatchView(db).entries.map((e) => e.steamid);
    expect(hashes).toEqual([EVADER, EVADER]);
    expect(events).toEqual([]);
  });

  it('pings on another account turning up on a watched address, once', () => {
    connect(EVADER, '8.8.8.8');
    flagEvader(db, EVADER, 'dethisa', STAFF);
    connect(ALT, '8.8.8.8');
    connect(ALT, '8.8.8.8');
    expect(events).toEqual([{ kind: 'ip_match', level: 'watch', steamid: ALT, others: [EVADER], flagged: EVADER, note: '' }]);
  });

  it('takes the watch alert over the banned one for the same connect', () => {
    connect(EVADER, '8.8.8.8');
    flagEvader(db, EVADER, 'dethisa', STAFF);
    banPlayer(db, EVADER, STAFF, 'evading', null);
    connect(ALT, '8.8.8.8');
    expect(events.map((e) => e.level)).toEqual(['watch']);
  });

  it('watches an address typed by hand without storing it', () => {
    expect(watchAddress(db, '9.9.9.9', 'from another league', STAFF)).toBe(true);
    expect(watchAddress(db, 'not an ip', '', STAFF)).toBe(false);
    expect(watchAddress(db, '999.1.1.1', '', STAFF)).toBe(false);
    const dump = JSON.stringify(db.prepare('SELECT * FROM ip_watch').all());
    expect(dump).not.toContain('9.9.9.9');
    connect(HOUSEMATE, '9.9.9.9');
    expect(events).toEqual([{ kind: 'ip_match', level: 'watch', steamid: HOUSEMATE, others: [], flagged: null, note: 'from another league' }]);
  });

  it('clearing a flag stops watching what it added, but not what staff added', () => {
    connect(EVADER, '8.8.8.8');
    connect(EVADER, '9.9.9.9');
    watchAddress(db, '9.9.9.9', 'by hand', STAFF);
    flagEvader(db, EVADER, 'dethisa', STAFF);
    expect(clearEvader(db, EVADER, STAFF)).toBe(true);
    const left = ipWatchView(db).entries;
    expect(left).toHaveLength(1);
    expect(left[0].note).toBe('by hand');
    expect(ipWatchView(db).flags).toEqual([]);
    connect(ALT, '8.8.8.8');
    expect(events).toEqual([]);
  });

  it('treats a merged-in alias of a flagged evader as the evader', () => {
    connect(EVADER, '8.8.8.8');
    flagEvader(db, EVADER, 'dethisa', STAFF);
    addAlias(db, { steamid: ALT, canonical: EVADER, by: STAFF });
    connect(ALT, '1.1.1.1');
    expect(events).toEqual([]);
    expect(ipWatchView(db).entries.map((e) => e.steamid)).toEqual([EVADER, EVADER]);
  });

  it('a removed address stops alerting', () => {
    watchAddress(db, '9.9.9.9', '', STAFF);
    const h = ipWatchView(db).entries[0].ipHash;
    expect(unwatch(db, h, STAFF)).toBe(true);
    connect(HOUSEMATE, '9.9.9.9');
    expect(events).toEqual([]);
  });
});
