import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { hashIp, networksOf, recordPlayerNet, sharesAddressWith } from '../src/playerNetworks.js';
import { parseLogDatagram } from '../src/logParse.js';

const MAIN = '76561198005192652';
const ALT = '76561199861598482';
const OTHER = '76561197972484944';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [MAIN, ALT, OTHER]) upsertPlayer(db, { steamid: id, name: `n${id.slice(-2)}`, avatar: null }, []);
});

describe('player networks', () => {
  it('never stores the address itself, only a hash of it', () => {
    recordPlayerNet(db, { steamid: MAIN, ip: '203.0.113.9', country: 'US' });
    const dump = JSON.stringify(db.prepare('SELECT * FROM player_networks').all());
    expect(dump).not.toContain('203.0.113.9');
    expect(dump).toContain('US');
  });

  // Without a stable salt the hash is useless: two sightings of one address
  // have to land on the same value or nothing correlates.
  it('hashes one address to the same value every time, and different ones apart', () => {
    expect(hashIp(db, '203.0.113.9')).toBe(hashIp(db, '203.0.113.9'));
    expect(hashIp(db, '203.0.113.9')).not.toBe(hashIp(db, '203.0.113.10'));
  });

  // The salt is per-installation, so a hash lifted from this database says
  // nothing about an address anywhere else.
  it('uses a salt of its own, not a fixed one shared by every install', () => {
    const other = openDb(':memory:');
    expect(hashIp(db, '203.0.113.9')).not.toBe(hashIp(other, '203.0.113.9'));
  });

  it('counts repeat sightings instead of piling up rows', () => {
    recordPlayerNet(db, { steamid: MAIN, ip: '203.0.113.9', country: 'US' });
    recordPlayerNet(db, { steamid: MAIN, ip: '203.0.113.9', country: 'US' });
    const [row] = networksOf(db, MAIN);
    expect(row.seenCount).toBe(2);
    expect(row.country).toBe('US');
    expect(networksOf(db, MAIN)).toHaveLength(1);
  });

  // The whole reason this exists. Match 65 cost a season recompute and only
  // came to light because somebody noticed a five-man team on a Discord card.
  it('names the other accounts seen on the same address', () => {
    recordPlayerNet(db, { steamid: MAIN, ip: '203.0.113.9', country: 'US' });
    recordPlayerNet(db, { steamid: ALT, ip: '203.0.113.9', country: 'US' });
    recordPlayerNet(db, { steamid: OTHER, ip: '198.51.100.4', country: 'BR' });

    expect(sharesAddressWith(db, MAIN).map((s) => s.steamid)).toEqual([ALT]);
    expect(sharesAddressWith(db, ALT).map((s) => s.steamid)).toEqual([MAIN]);
    expect(sharesAddressWith(db, OTHER)).toEqual([]);
  });

  it('carries the name and how often, so an admin can judge rather than guess', () => {
    recordPlayerNet(db, { steamid: MAIN, ip: '203.0.113.9', country: 'US' });
    for (let i = 0; i < 3; i++) recordPlayerNet(db, { steamid: ALT, ip: '203.0.113.9', country: 'US' });
    const [s] = sharesAddressWith(db, MAIN);
    expect(s).toMatchObject({ steamid: ALT, name: expect.any(String), seenCount: 3, country: 'US' });
  });

  it('tolerates an unknown country rather than refusing the sighting', () => {
    recordPlayerNet(db, { steamid: MAIN, ip: '203.0.113.9', country: null });
    expect(networksOf(db, MAIN)[0].country).toBeNull();
  });

  // Loopback and LAN addresses are every listen-server host and anyone
  // testing from the same box. Correlating on them would report the whole
  // server as one person.
  it('ignores addresses that cannot identify anyone', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.7', '172.16.0.3', '', 'garbage']) {
      recordPlayerNet(db, { steamid: MAIN, ip, country: 'US' });
    }
    expect(networksOf(db, MAIN)).toEqual([]);
  });
});

describe('PUGNET parsing', () => {
  const parse = (line: string) => parseLogDatagram(Buffer.from(line, 'utf8'));

  it('reads a well-formed line with a country', () => {
    expect(parse(`PUGNET steamid=${MAIN} ip=203.0.113.9 cc=us`))
      .toEqual({ kind: 'player_net', steamid: MAIN, ip: '203.0.113.9', country: 'US' });
  });

  it('accepts a line with no country, which is what an unloaded GeoIP looks like', () => {
    expect(parse(`PUGNET steamid=${MAIN} ip=203.0.113.9`))
      .toMatchObject({ kind: 'player_net', country: null });
  });

  it('rejects a malformed address or SteamID rather than recording a bad hash', () => {
    expect(parse(`PUGNET steamid=${MAIN} ip=not-an-ip`)).toBeNull();
    expect(parse('PUGNET steamid=123 ip=203.0.113.9')).toBeNull();
  });

  // The line carries no token, so the ONLY thing separating it from a player
  // typing it in chat is that a chat line never starts with the marker: the
  // engine opens every line about a player with a quote.
  it('is not forgeable from chat, where the marker cannot be first', () => {
    expect(parse(`"bob<2><STEAM_1:0:5><Survivor>" say "PUGNET steamid=${MAIN} ip=203.0.113.9"`))
      .toBeNull();
  });
});
