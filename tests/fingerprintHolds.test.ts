import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { linkDiscord } from '../src/players.js';
import { hasActiveBan } from '../src/banState.js';
import { altHolds, holdById, liftAltHold, placeAltHold, placeFingerprintHold } from '../src/altHolds.js';
import { addMember, createPerson } from '../src/evaderPeople.js';
import { fileViewer } from '../src/admin/fileAccess.js';
import { player } from './fingerprintFixtures.js';

const OLD = '76561198000000001';
const NEW = '76561198000000002';
const ADMIN = '76561198000000009';
let db: DB;
let personId: number;

beforeEach(() => {
  db = openDb(':memory:');
  for (const [id, name] of [[OLD, 'nepmir'], [NEW, 'fresh'], [ADMIN, 'admin']]) player(db, id, name);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  personId = createPerson(db, 'dethisa', '', ADMIN);
  addMember(db, personId, 'steam', OLD, ADMIN, 'seed');
});

const idOf = (r: ReturnType<typeof placeFingerprintHold>): number => {
  if (!('id' in r)) throw new Error(`refused: ${r.refused}`);
  return r.id;
};

describe('fingerprint holds', () => {
  it('blocks like a ban, as an alt hold', () => {
    const id = idOf(placeFingerprintHold(db, NEW, personId, OLD));
    expect(hasActiveBan(db, NEW)).toBe(true);
    const ban = db.prepare('SELECT kind FROM bans WHERE player_id = ?').get(NEW) as { kind: string };
    expect(ban.kind).toBe('alt_hold');
    expect(holdById(db, id)).toMatchObject({ source: 'fingerprint', personId });
  });

  it('lists with the person and the numbers behind it', () => {
    idOf(placeFingerprintHold(db, NEW, personId, OLD));
    db.prepare(
      `INSERT INTO fingerprint_alerts (steamid, person_id, level, distance, threshold, rank, signs_json, created_at)
       VALUES (?, ?, 'hold', 0.203, 0.25, 2, '["vpn"]', '2026-10-17T00:00:00.000Z')`,
    ).run(NEW, personId);
    const [h] = altHolds(db, fileViewer(db, ADMIN)).open;
    expect(h).toMatchObject({
      source: 'fingerprint', personId, personLabel: 'dethisa', otherSteamid: OLD,
      fingerprint: { distance: 0.203, threshold: 0.25, rank: 2, signs: ['vpn'] },
    });
  });

  it('takes the candidate\'s Discord when one is linked', () => {
    linkDiscord(db, NEW, '777000000000000001', 'newd');
    const id = idOf(placeFingerprintHold(db, NEW, personId, OLD));
    const row = db.prepare('SELECT discord_id, discord_name FROM alt_holds WHERE id = ?').get(id);
    expect(row).toEqual({ discord_id: '777000000000000001', discord_name: 'newd' });
  });

  it('a cleared pair is never held again, for that person only', () => {
    const id = idOf(placeFingerprintHold(db, NEW, personId, OLD));
    liftAltHold(db, id, ADMIN);
    expect(placeFingerprintHold(db, NEW, personId, OLD)).toEqual({ refused: 'cleared' });
    const other = createPerson(db, 'shove', '', ADMIN);
    expect('id' in placeFingerprintHold(db, NEW, other, OLD)).toBe(true);
  });

  it('a cleared Discord pair does not stop a fingerprint hold, nor the other way round', () => {
    const d = placeAltHold(db, NEW, OLD, '111', 'dethisa')!;
    liftAltHold(db, d, ADMIN);
    const f = idOf(placeFingerprintHold(db, NEW, personId, OLD));
    liftAltHold(db, f, ADMIN);
    expect(placeAltHold(db, NEW, OLD, '111', 'dethisa')).toBeNull(); // the Discord pair's own clear
    const db2 = openDb(':memory:');
    for (const [id, name] of [[OLD, 'nepmir'], [NEW, 'fresh'], [ADMIN, 'admin']]) player(db2, id, name);
    const p2 = createPerson(db2, 'dethisa', '', ADMIN);
    const f2 = placeFingerprintHold(db2, NEW, p2, OLD);
    liftAltHold(db2, (f2 as { id: number }).id, ADMIN);
    expect(placeAltHold(db2, NEW, OLD, '111', 'dethisa')).not.toBeNull();
  });

  it('refuses an account already on hold, staff, and an account the site has never seen', () => {
    placeAltHold(db, NEW, OLD, '111', 'dethisa');
    expect(placeFingerprintHold(db, NEW, personId, OLD)).toEqual({ refused: 'open_hold' });
    expect(placeFingerprintHold(db, ADMIN, personId, OLD)).toEqual({ refused: 'staff' });
    expect(placeFingerprintHold(db, '76561198000000077', personId, OLD)).toEqual({ refused: 'unknown' });
  });
});
