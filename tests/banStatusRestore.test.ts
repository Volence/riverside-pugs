import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer, getPlayer, linkDiscord } from '../src/players.js';
import { banPlayer, unbanPlayer, liftExpiredBans } from '../src/admin/players.js';

const P1 = '76561198000000001';
const ADMIN = '76561198000000009';
const HOUR = 60 * 60 * 1000;

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  upsertPlayer(db, { steamid: P1, name: 'alice', avatar: null }, []);
});

const status = () => getPlayer(db, P1)!.status;

// A one-day abandon ban on an account that had never been let in used to
// end with the account `active`: past the invite code and past the Discord
// gate, for the price of leaving one match.
describe('a ban ends with the status the account had before it', () => {
  it('an invited account is invited again when its ban expires', () => {
    const t0 = new Date('2026-09-01T00:00:00Z');
    banPlayer(db, P1, 'system', 'Abandoned match #3', 60, t0);
    expect(status()).toBe('banned');
    expect(liftExpiredBans(db, new Date(t0.getTime() + 2 * HOUR))).toEqual([P1]);
    expect(status()).toBe('invited');
  });

  it('an invited account is invited again when an admin unbans it', () => {
    banPlayer(db, P1, ADMIN, 'griefing', null);
    unbanPlayer(db, P1, ADMIN);
    expect(status()).toBe('invited');
  });

  it('an active account is active again, by expiry and by unban', () => {
    activatePlayer(db, P1);
    const t0 = new Date('2026-09-01T00:00:00Z');
    banPlayer(db, P1, 'system', 'Abandoned match #3', 60, t0);
    liftExpiredBans(db, new Date(t0.getTime() + 2 * HOUR));
    expect(status()).toBe('active');
    banPlayer(db, P1, ADMIN, 'griefing', null);
    unbanPlayer(db, P1, ADMIN);
    expect(status()).toBe('active');
  });

  it('a second ban on top of the first does not remember "banned"', () => {
    const t0 = new Date('2026-09-01T00:00:00Z');
    banPlayer(db, P1, 'system', 'first', 60, t0);
    banPlayer(db, P1, ADMIN, 'second', 120, t0);
    liftExpiredBans(db, new Date(t0.getTime() + 3 * HOUR));
    expect(status()).toBe('invited');
  });

  it('forgets the remembered status once it has been restored', () => {
    activatePlayer(db, P1);
    banPlayer(db, P1, ADMIN, 'griefing', null);
    unbanPlayer(db, P1, ADMIN);
    expect((db.prepare('SELECT status_before_ban AS s FROM players WHERE steamid = ?').get(P1) as { s: string | null }).s).toBeNull();
  });

  describe('a ban made before the status was remembered', () => {
    /** What a row banned by the old code looks like. */
    const legacyBan = () => {
      banPlayer(db, P1, ADMIN, 'old ban', null);
      db.prepare('UPDATE players SET status_before_ban = NULL WHERE steamid = ?').run(P1);
    };

    it('restores to invited when nothing says the account was ever let in', () => {
      legacyBan();
      unbanPlayer(db, P1, ADMIN);
      expect(status()).toBe('invited');
    });

    it('restores to active when the account has a linked Discord', () => {
      linkDiscord(db, P1, '111', 'Alice');
      legacyBan();
      unbanPlayer(db, P1, ADMIN);
      expect(status()).toBe('active');
    });

    it('restores to active when the account has played a match it queued for on the site', () => {
      const id = Number(db.prepare(
        "INSERT INTO matches (season_id, state, campaign, went_live_at) VALUES (1, 'completed', 'dead_air', '2026-09-01T00:00:00Z')",
      ).run().lastInsertRowid);
      db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, 'a')").run(id, P1);
      legacyBan();
      unbanPlayer(db, P1, ADMIN);
      expect(status()).toBe('active');
    });

    it('does not count a match started in game, which rosters accounts that were never let in', () => {
      const id = Number(db.prepare(
        "INSERT INTO matches (season_id, state, campaign) VALUES (1, 'completed', 'dead_air')",
      ).run().lastInsertRowid);
      db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, 'a')").run(id, P1);
      legacyBan();
      unbanPlayer(db, P1, ADMIN);
      expect(status()).toBe('invited');
    });

    it('restores to active for an admin, and for an account an admin once activated by hand', () => {
      db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(P1);
      legacyBan();
      unbanPlayer(db, P1, ADMIN);
      expect(status()).toBe('active');

      db.prepare("UPDATE players SET is_admin = 0, status = 'invited' WHERE steamid = ?").run(P1);
      db.prepare("INSERT INTO admin_actions (admin_id, action, target, created_at) VALUES (?, 'activate', ?, ?)")
        .run(ADMIN, P1, new Date().toISOString());
      legacyBan();
      unbanPlayer(db, P1, ADMIN);
      expect(status()).toBe('active');
    });
  });
});
