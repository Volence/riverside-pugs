import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { linkDiscord } from '../src/players.js';
import { recordPlayerNet } from '../src/playerNetworks.js';
import { addAlias } from '../src/aliases.js';
import { addMember, createPerson } from '../src/evaderPeople.js';
import type { AsnLookup } from '../src/asnTable.js';
import {
  activeBanAt, candidatesOf, dbTimeMs, discordCreatedMs, isNewAccount, ratedMatchesAt, secondSigns, type SignContext,
} from '../src/fingerprintSigns.js';
import { endedMatch, playMatch, player } from './fingerprintFixtures.js';

const MEMBER = '76561198000000001';
const CAND = '76561198000000002';
const OTHER = '76561198000000003';
const STAFF = '76561198000000009';
const AT = new Date('2026-10-17T21:00:00Z');
const DAY = 86_400_000;
let db: DB;

const ctx = (over: Partial<SignContext> = {}): SignContext =>
  ({ members: [MEMBER], membersInTop10: 0, asnLoaded: true, extraVpn: new Set(), ...over });
const net = (asn: number, org: string): AsnLookup => ({ lookup: () => ({ asn, org }) });
const snowflakeAt = (ms: number): string => ((BigInt(ms) - 1420070400000n) << 22n).toString();
const sqliteTime = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [MEMBER, CAND, OTHER, STAFF]) player(db, id);
});

describe('time helpers', () => {
  it('reads both column formats', () => {
    expect(dbTimeMs('2026-10-17 20:00:00')).toBe(Date.parse('2026-10-17T20:00:00Z'));
    expect(dbTimeMs('2026-10-17T20:00:00.000Z')).toBe(Date.parse('2026-10-17T20:00:00Z'));
    expect(dbTimeMs(null)).toBeNull();
  });

  it('dates a Discord account from its id', () => {
    // Discord's own documented example.
    expect(discordCreatedMs('175928847299117063')).toBe(1462015105796);
    expect(discordCreatedMs('nope')).toBeNull();
  });
});

describe('who is new', () => {
  it('counts completed, rated, unvoided PUGs that ended by then', () => {
    endedMatch(db, 1, '2026-10-17 10:00:00');
    endedMatch(db, 2, '2026-10-17 11:00:00');
    endedMatch(db, 3, '2026-10-17 12:00:00');
    endedMatch(db, 4, '2026-10-17 22:00:00');
    endedMatch(db, 5, '2026-10-17 14:00:00');
    db.prepare("UPDATE matches SET voided_at = '2026-10-17 13:00:00' WHERE id = 3").run();
    db.prepare("UPDATE matches SET kind = 'scrim' WHERE id = 5").run();
    const ins = db.prepare("INSERT INTO match_players (match_id, player_id, team, rated) VALUES (?, ?, 'a', ?)");
    ins.run(1, CAND, 1); ins.run(2, CAND, 0); ins.run(3, CAND, 1); ins.run(4, CAND, 1); ins.run(5, CAND, 1);
    expect(ratedMatchesAt(db, CAND, AT)).toBe(1);
  });

  it('is new under 15 rated matches or under 30 days on the site', () => {
    for (let i = 0; i < 15; i++) {
      endedMatch(db, 100 + i, '2026-10-01 20:00:00');
      db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, 'a')").run(100 + i, CAND);
    }
    db.prepare('UPDATE players SET created_at = ? WHERE steamid = ?').run(sqliteTime(AT.getTime() - 60 * DAY), CAND);
    expect(isNewAccount(db, CAND, AT)).toBe(false);
    db.prepare('DELETE FROM match_players WHERE match_id = 114').run();
    expect(isNewAccount(db, CAND, AT)).toBe(true);
    db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (114, ?, 'a')").run(CAND);
    db.prepare('UPDATE players SET created_at = ? WHERE steamid = ?').run(sqliteTime(AT.getTime() - 10 * DAY), CAND);
    expect(isNewAccount(db, CAND, AT)).toBe(true);
  });

  it('reads a ban as of a moment, not as of now', () => {
    const ban = db.prepare(
      "INSERT INTO bans (player_id, reason, created_by, created_at, expires_at, lifted_by, lifted_at, kind) VALUES (?, 'x', ?, ?, ?, ?, ?, 'ban')",
    );
    ban.run(CAND, STAFF, '2026-10-18T00:00:00.000Z', null, null, null); // after AT
    expect(activeBanAt(db, CAND, AT)).toBe(false);
    ban.run(CAND, STAFF, '2026-10-16T00:00:00.000Z', null, STAFF, '2026-10-17T22:00:00.000Z'); // lifted later
    expect(activeBanAt(db, CAND, AT)).toBe(true);
    ban.run(OTHER, STAFF, '2026-10-10T00:00:00.000Z', '2026-10-11T00:00:00.000Z', null, null); // expired
    expect(activeBanAt(db, OTHER, AT)).toBe(false);
  });

  it('checks the new, unbanned players of the match who belong to no person', () => {
    endedMatch(db, 900);
    const ALIASED = '76561198000000004';
    const BANNED = '76561198000000005';
    for (const id of [ALIASED, BANNED]) player(db, id);
    for (const id of [MEMBER, CAND, ALIASED, BANNED]) playMatch(db, id, 900, 10, 20);
    const p = createPerson(db, 'dethisa', '', STAFF);
    addMember(db, p, 'steam', MEMBER, STAFF, 'seed');
    addAlias(db, { steamid: ALIASED, canonical: MEMBER, by: STAFF });
    db.prepare("INSERT INTO bans (player_id, reason, created_by, created_at, kind) VALUES (?, 'x', ?, '2026-10-01T00:00:00.000Z', 'ban')").run(BANNED, STAFF);
    expect(candidatesOf(db, 900, AT)).toEqual([CAND]);
  });
});

describe('second signs', () => {
  it('nothing on a plain account', () => {
    expect(secondSigns(db, CAND, ctx(), AT)).toEqual([]);
  });

  it('a VPN or hosting connection, only with a table loaded and only one seen by then', () => {
    recordPlayerNet(db, { steamid: CAND, ip: '198.51.100.4', country: 'GB' }, new Date('2026-10-17T20:00:00Z'), net(212238, 'DATACAMP-LIMITED'));
    expect(secondSigns(db, CAND, ctx(), AT)).toEqual(['vpn']);
    expect(secondSigns(db, CAND, ctx({ asnLoaded: false }), AT)).toEqual([]);
    expect(secondSigns(db, CAND, ctx(), new Date('2026-10-17T19:00:00Z'))).toEqual([]);
  });

  it('a residential connection is not a sign', () => {
    recordPlayerNet(db, { steamid: CAND, ip: '203.0.113.9', country: 'US' }, new Date('2026-10-17T20:00:00Z'), net(64500, 'EXAMPLE-CABLE'));
    expect(secondSigns(db, CAND, ctx(), AT)).toEqual([]);
  });

  it('a fresh identity: young or private Steam account', () => {
    const steam = db.prepare("INSERT INTO player_steam_signals (steamid, time_created, visibility, checked_at) VALUES (?, ?, ?, '2026-10-17T00:00:00.000Z')");
    steam.run(CAND, Math.floor((AT.getTime() - 100 * DAY) / 1000), 3);
    expect(secondSigns(db, CAND, ctx(), AT)).toEqual(['fresh_identity']);
    db.prepare('UPDATE player_steam_signals SET time_created = ?, visibility = 1 WHERE steamid = ?')
      .run(Math.floor((AT.getTime() - 900 * DAY) / 1000), CAND);
    expect(secondSigns(db, CAND, ctx(), AT)).toEqual(['fresh_identity']);
    db.prepare('UPDATE player_steam_signals SET visibility = 3 WHERE steamid = ?').run(CAND);
    expect(secondSigns(db, CAND, ctx(), AT)).toEqual([]);
  });

  it('a fresh identity: a Discord account under 90 days old', () => {
    linkDiscord(db, CAND, snowflakeAt(AT.getTime() - 20 * DAY), 'newd');
    expect(secondSigns(db, CAND, ctx(), AT)).toEqual(['fresh_identity']);
  });

  it('a fresh identity: a Discord new to us on a site account under 7 days old', () => {
    db.prepare('UPDATE players SET created_at = ? WHERE steamid = ?').run(sqliteTime(AT.getTime() - 3 * DAY), CAND);
    linkDiscord(db, CAND, '175928847299117063', 'oldd');
    expect(secondSigns(db, CAND, ctx(), AT)).toEqual(['fresh_identity']);
    db.prepare(
      `INSERT INTO discord_link_history (steamid, discord_id, discord_name, linked_at, linked_by, unlinked_at, unlinked_by)
       VALUES (?, '175928847299117063', 'oldd', '2026-01-01T00:00:00.000Z', 'x', '2026-02-01T00:00:00.000Z', 'x')`,
    ).run(OTHER);
    expect(secondSigns(db, CAND, ctx(), AT)).toEqual([]);
    db.prepare('DELETE FROM discord_link_history WHERE steamid = ?').run(OTHER);
    db.prepare('UPDATE players SET created_at = ? WHERE steamid = ?').run(sqliteTime(AT.getTime() - 30 * DAY), CAND);
    expect(secondSigns(db, CAND, ctx(), AT)).toEqual([]);
  });

  it('a cheat flag of an aimbot or wallhack kind, in a match, by then', () => {
    const flag = db.prepare("INSERT INTO integrity_flags (match_id, steamid, source, kind, severity, at) VALUES (?, ?, 'lilac', ?, 'suspected', ?)");
    flag.run(900, CAND, 'bhop', '2026-10-17T20:00:00.000Z');
    flag.run(null, CAND, 'aimbot', '2026-10-17T20:00:00.000Z');
    flag.run(900, CAND, 'aimbot', '2026-10-17T22:00:00.000Z');
    expect(secondSigns(db, CAND, ctx(), AT)).toEqual([]);
    flag.run(900, CAND, 'aimbot_multi', '2026-10-17T20:00:00.000Z');
    expect(secondSigns(db, CAND, ctx(), AT)).toEqual(['cheat_flag']);
  });

  it('two member accounts among the 10 nearest', () => {
    expect(secondSigns(db, CAND, ctx({ membersInTop10: 1 }), AT)).toEqual([]);
    expect(secondSigns(db, CAND, ctx({ membersInTop10: 2 }), AT)).toEqual(['two_members']);
  });

  it('a connection shared with a member', () => {
    recordPlayerNet(db, { steamid: MEMBER, ip: '203.0.113.9', country: 'US' }, new Date('2026-10-17T19:00:00Z'), null);
    recordPlayerNet(db, { steamid: CAND, ip: '203.0.113.9', country: 'US' }, new Date('2026-10-17T20:00:00Z'), null);
    expect(secondSigns(db, CAND, ctx(), AT)).toEqual(['shared_connection']);
    expect(secondSigns(db, CAND, ctx({ members: [] }), AT)).toEqual([]);
  });

  it('a shared commercial VPN exit is not a shared connection, table loaded or not', () => {
    const t1 = new Date('2026-10-17T19:00:00Z');
    const t2 = new Date('2026-10-17T20:00:00Z');
    recordPlayerNet(db, { steamid: MEMBER, ip: '203.0.113.9', country: 'NL' }, t1, net(212238, 'DATACAMP-LIMITED'));
    // The candidate's row was recorded with no lookup (NULL asn): the
    // member's row tags the hash as a VPN, which is enough.
    recordPlayerNet(db, { steamid: CAND, ip: '203.0.113.9', country: 'NL' }, t2, null);
    expect(secondSigns(db, CAND, ctx({ asnLoaded: true }), AT)).toEqual([]);
    expect(secondSigns(db, CAND, ctx({ asnLoaded: false }), AT)).toEqual([]);
    // Staff's own list counts as well.
    recordPlayerNet(db, { steamid: MEMBER, ip: '203.0.113.10', country: 'US' }, t1, net(64500, 'Example Telecom'));
    recordPlayerNet(db, { steamid: CAND, ip: '203.0.113.10', country: 'US' }, t2, null);
    expect(secondSigns(db, CAND, ctx({ asnLoaded: false, extraVpn: new Set([64500]) }), AT)).toEqual([]);
    // A residential one shared beside it still counts.
    expect(secondSigns(db, CAND, ctx({ asnLoaded: false }), AT)).toEqual(['shared_connection']);
  });

  it('an untagged (unknown) shared connection still counts with no ASN table', () => {
    recordPlayerNet(db, { steamid: MEMBER, ip: '203.0.113.9', country: 'US' }, new Date('2026-10-17T19:00:00Z'), null);
    recordPlayerNet(db, { steamid: CAND, ip: '203.0.113.9', country: 'US' }, new Date('2026-10-17T20:00:00Z'), null);
    expect(secondSigns(db, CAND, ctx({ asnLoaded: false }), AT)).toEqual(['shared_connection']);
  });
});
