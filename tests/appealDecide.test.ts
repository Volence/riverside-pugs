import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { upsertPlayer, activatePlayer, getPlayer } from '../src/players.js';
import { insertBan, activeBan } from '../src/admin/players.js';
import { placeAltHold } from '../src/altHolds.js';
import { appellantFromSteam } from '../src/appeals/rules.js';
import { fileAppeal, getAppeal } from '../src/appeals/store.js';
import { decideBanAppeal } from '../src/appeals/decide.js';
import { dmText, playerLine } from '../src/appeals/templates.js';
import { playerView, staffAppeal } from '../src/appeals/views.js';
import { fileViewer } from '../src/admin/fileAccess.js';

const P = '76561198000000001';
const OTHER = '76561198000000002';
const MOD = '76561198000000008';
const NOW = new Date('2026-10-04T12:00:00.000Z');
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  setSetting(db, 'appeals_enabled', '1');
  for (const id of [P, OTHER, MOD]) { upsertPlayer(db, { steamid: id, name: `n${id.slice(-1)}`, avatar: null }, []); activatePlayer(db, id); }
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
});

const fileFor = (banId: number) => {
  const r = fileAppeal(db, appellantFromSteam(db, P), { ref: { kind: 'ban', id: banId }, whatHappened: 'a', whyLift: 'b', source: 'site' }, NOW);
  return getAppeal(db, (r as { id: number }).id)!;
};

describe('decideBanAppeal', () => {
  it('accept lifts only the appealed ban', () => {
    const a = insertBan(db, P, 'system', 'abandon', 48 * 60, NOW);
    const b = insertBan(db, P, MOD, 'griefing', 72 * 60, NOW);
    expect(decideBanAppeal(db, fileFor(b), MOD, 'accept', null, NOW)).toEqual({ ok: true });
    expect(activeBan(db, P, NOW)?.id).toBe(a);
    expect(getPlayer(db, P)!.status).toBe('banned');
  });

  it('accept on a hold closes the hold and frees the account', () => {
    const holdId = placeAltHold(db, P, OTHER, '900', 'dethisa', NOW)!;
    const banId = (db.prepare('SELECT ban_id FROM alt_holds WHERE id = ?').get(holdId) as { ban_id: number }).ban_id;
    expect(decideBanAppeal(db, fileFor(banId), MOD, 'accept', null, NOW)).toEqual({ ok: true });
    expect(activeBan(db, P, NOW)).toBeNull();
    expect((db.prepare('SELECT resolution FROM alt_holds WHERE id = ?').get(holdId) as { resolution: string }).resolution).toBe('cleared');
  });

  it('shorten moves the end earlier and refuses a later or past end, or a hold', () => {
    const ban = insertBan(db, P, MOD, 'griefing', 7 * 24 * 60, NOW);
    const row = fileFor(ban);
    expect(decideBanAppeal(db, row, MOD, 'shorten', '2026-10-30T00:00:00.000Z', NOW)).toMatchObject({ ok: false, status: 400 });
    expect(decideBanAppeal(db, row, MOD, 'shorten', '2026-10-01T00:00:00.000Z', NOW)).toMatchObject({ ok: false, status: 400 });
    expect(decideBanAppeal(db, row, MOD, 'shorten', '2026-10-06T00:00:00.000Z', NOW)).toEqual({ ok: true });
    expect(activeBan(db, P, NOW)!.expiresAt).toBe('2026-10-06T00:00:00.000Z');
    expect(getAppeal(db, row.id)).toMatchObject({ state: 'shortened', new_expires_at: '2026-10-06T00:00:00.000Z' });
  });

  it('a ban that ended while waiting moots the appeal instead of deciding it', () => {
    const ban = insertBan(db, P, 'system', 'abandon', 48 * 60, NOW);
    const row = fileFor(ban);
    const later = new Date(NOW.getTime() + 49 * 3600_000);
    expect(decideBanAppeal(db, row, MOD, 'deny', null, later)).toMatchObject({ ok: false, status: 409 });
    expect(getAppeal(db, row.id)!.state).toBe('moot');
  });
});

describe('what people read', () => {
  it('the player line and DM follow the state; a denial says when they may try again', () => {
    const ban = insertBan(db, P, MOD, 'griefing', null, NOW);
    const row = fileFor(ban);
    expect(playerLine(db, row, NOW)).toBe('Your appeal was received. Staff will review it.');
    decideBanAppeal(db, row, MOD, 'deny', null, NOW);
    const denied = getAppeal(db, row.id)!;
    expect(dmText(db, denied, 'https://pug.test', NOW)).toMatch(/the ban stands\. You can appeal again after/);
  });

  it('playerView lists the ban with its latest appeal; staffAppeal names the issuer', () => {
    const ban = insertBan(db, P, MOD, 'griefing', null, NOW);
    const row = fileFor(ban);
    const v = playerView(db, appellantFromSteam(db, P), NOW);
    expect(v.items).toHaveLength(1);
    expect(v.items[0]).toMatchObject({ canAppeal: false, appeal: { id: row.id, state: 'open' } });
    const d = staffAppeal(db, fileViewer(db, MOD), row.id, NOW)!;
    expect(d.target).toMatchObject({ reason: 'griefing', createdByName: 'n8' });
    expect(d.canDecide).toBe(true);
  });
});
