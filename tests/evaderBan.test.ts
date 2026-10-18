import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { linkDiscord } from '../src/players.js';
import { hasActiveBan } from '../src/banState.js';
import { subscribeBanChanges } from '../src/banEvents.js';
import { liftAltHold, placeFingerprintHold } from '../src/altHolds.js';
import { addMember, closePerson, createPerson, personOf } from '../src/evaderPeople.js';
import { banAsSamePerson } from '../src/evaderBan.js';
import { player } from './fingerprintFixtures.js';

const OLD = '76561198000000001';
const NEW = '76561198000000002';
const ADMIN = '76561198000000009';
const DISCORD = '777000000000000001';
let db: DB;
let personId: number;

beforeEach(() => {
  db = openDb(':memory:');
  for (const [id, name] of [[OLD, 'nepmir'], [NEW, 'fresh'], [ADMIN, 'admin']]) player(db, id, name);
  linkDiscord(db, NEW, DISCORD, 'freshd');
  personId = createPerson(db, 'dethisa', '', ADMIN);
  addMember(db, personId, 'steam', OLD, ADMIN, 'seed');
});

describe('banAsSamePerson', () => {
  it('bans from an alert and adds the account and its Discord to the person', () => {
    db.prepare("INSERT INTO fingerprint_cache (subject, classes_json, holds, built_at) VALUES (?, '{}', 0, 'x')").run(`person:${personId}`);
    const changes: string[] = [];
    const off = subscribeBanChanges((c) => { changes.push(`${c.kind}:${c.steamid}`); });
    expect(banAsSamePerson(db, { steamid: NEW, personId, by: ADMIN })).toBe('banned');
    off();
    expect(hasActiveBan(db, NEW)).toBe(true);
    const ban = db.prepare("SELECT reason FROM bans WHERE player_id = ? AND kind = 'ban'").get(NEW) as { reason: string };
    expect(ban.reason).toBe('Ban evasion: another account of dethisa');
    expect(personOf(db, 'steam', NEW)?.label).toBe('dethisa');
    expect(personOf(db, 'discord', DISCORD)?.label).toBe('dethisa');
    const how = db.prepare("SELECT how FROM evader_members WHERE kind = 'steam' AND ident = ?").get(NEW) as { how: string };
    expect(how.how).toBe('ban as same person');
    expect((db.prepare('SELECT built_at FROM fingerprint_cache WHERE subject = ?').get(`person:${personId}`) as { built_at: string }).built_at).toBe('');
    expect(changes).toContain(`ban:${NEW}`);
  });

  it('turns a fingerprint hold into a ban and closes the hold', () => {
    const placed = placeFingerprintHold(db, NEW, personId, OLD);
    const holdId = (placed as { id: number }).id;
    expect(banAsSamePerson(db, { steamid: NEW, personId, by: ADMIN, holdId })).toBe('banned');
    const hold = db.prepare('SELECT resolution FROM alt_holds WHERE id = ?').get(holdId) as { resolution: string };
    expect(hold.resolution).toBe('banned');
    const kinds = db.prepare('SELECT kind, lifted_at FROM bans WHERE player_id = ? ORDER BY id').all(NEW) as { kind: string; lifted_at: string | null }[];
    expect(kinds.map((k) => [k.kind, k.lifted_at === null])).toEqual([['alt_hold', false], ['ban', true]]);
  });

  it('refuses a missing or closed person and a settled hold', () => {
    expect(banAsSamePerson(db, { steamid: NEW, personId: 999, by: ADMIN })).toBe('no_person');
    const placed = placeFingerprintHold(db, NEW, personId, OLD) as { id: number };
    liftAltHold(db, placed.id, ADMIN);
    expect(banAsSamePerson(db, { steamid: NEW, personId, by: ADMIN, holdId: placed.id })).toBe('hold_settled');
    closePerson(db, personId, ADMIN);
    expect(banAsSamePerson(db, { steamid: NEW, personId, by: ADMIN })).toBe('closed');
    expect(hasActiveBan(db, NEW)).toBe(false);
  });

  it('refuses a hold that belongs to another account and writes nothing', () => {
    const other = '76561198000000003';
    player(db, other, 'third');
    const placed = placeFingerprintHold(db, other, personId, OLD) as { id: number };
    expect(banAsSamePerson(db, { steamid: NEW, personId, by: ADMIN, holdId: placed.id })).toBe('hold_mismatch');
    expect(hasActiveBan(db, NEW)).toBe(false);
    expect(personOf(db, 'steam', NEW)).toBeNull();
  });

  it('refuses an account already on another person and writes nothing', () => {
    const p2 = createPerson(db, 'someone', '', ADMIN);
    addMember(db, p2, 'discord', DISCORD, ADMIN, 'seed');
    const changes: string[] = [];
    const off = subscribeBanChanges((c) => { changes.push(c.steamid); });
    expect(banAsSamePerson(db, { steamid: NEW, personId, by: ADMIN })).toBe('member_elsewhere');
    off();
    expect(changes).toEqual([]);
    expect(hasActiveBan(db, NEW)).toBe(false);
    expect(personOf(db, 'steam', NEW)).toBeNull();
  });

  it('closes an open hold on the alert path without a second bans row', () => {
    const placed = placeFingerprintHold(db, NEW, personId, OLD) as { id: number };
    expect(banAsSamePerson(db, { steamid: NEW, personId, by: ADMIN })).toBe('banned');
    const hold = db.prepare('SELECT resolution FROM alt_holds WHERE id = ?').get(placed.id) as { resolution: string };
    expect(hold.resolution).toBe('banned');
    const n = db.prepare("SELECT COUNT(*) AS n FROM bans WHERE player_id = ? AND lifted_at IS NULL").get(NEW) as { n: number };
    expect(n.n).toBe(1);
  });

  it('rolls everything back and publishes nothing when a membership write fails', () => {
    db.exec("CREATE TRIGGER boom BEFORE INSERT ON evader_members WHEN NEW.ident = '777000000000000001' BEGIN SELECT RAISE(ABORT, 'boom'); END");
    const changes: string[] = [];
    const off = subscribeBanChanges((c) => { changes.push(c.steamid); });
    expect(() => banAsSamePerson(db, { steamid: NEW, personId, by: ADMIN })).toThrow();
    off();
    expect(changes).toEqual([]);
    expect(hasActiveBan(db, NEW)).toBe(false);
    expect(personOf(db, 'steam', NEW)).toBeNull();
  });
});
