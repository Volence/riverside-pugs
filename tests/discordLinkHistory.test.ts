import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, getPlayer, linkDiscord, unlinkDiscord, discordHistoryOf } from '../src/players.js';
import { banPlayer, unbanPlayer, playerDetail } from '../src/admin/players.js';
import { mergePlayers } from '../src/mergePlayers.js';

const P1 = '76561198000000001';
const P2 = '76561198000000002';
const ADMIN = '76561198000000009';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  upsertPlayer(db, { steamid: P1, name: 'alice', avatar: null }, []);
  upsertPlayer(db, { steamid: P2, name: 'bob', avatar: null }, []);
});

const rows = () => db.prepare('SELECT * FROM discord_link_history ORDER BY id').all() as {
  steamid: string; discord_id: string; discord_name: string; linked_at: string; linked_by: string;
  unlinked_at: string | null; unlinked_by: string | null;
}[];

describe('discord link history', () => {
  it('every link opens a row and every unlink closes it, with who did it', () => {
    linkDiscord(db, P1, '111', 'Alice');
    expect(rows()).toMatchObject([{ steamid: P1, discord_id: '111', linked_by: P1, unlinked_at: null }]);
    unlinkDiscord(db, P1, ADMIN);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].unlinked_at).toBeTruthy();
    expect(rows()[0].unlinked_by).toBe(ADMIN);
  });

  it('relinking the same account refreshes the name without opening a second row', () => {
    linkDiscord(db, P1, '111', 'Alice');
    linkDiscord(db, P1, '111', 'Alice renamed');
    expect(rows()).toHaveLength(1);
  });

  it('an unlink with no open row (a link older than the table) still leaves a record', () => {
    db.prepare("UPDATE players SET discord_id = '111', discord_name = 'Alice' WHERE steamid = ?").run(P1);
    unlinkDiscord(db, P1);
    expect(rows()).toMatchObject([{ steamid: P1, discord_id: '111', unlinked_by: P1 }]);
    expect(rows()[0].unlinked_at).toBeTruthy();
  });

  it('opens a row at boot for every link that predates the table, once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pug-linkhist-'));
    try {
      const path = join(dir, 'pug.db');
      const first = openDb(path);
      upsertPlayer(first, { steamid: P1, name: 'alice', avatar: null }, []);
      first.prepare("UPDATE players SET discord_id = '111', discord_name = 'Alice' WHERE steamid = ?").run(P1);
      first.close();
      const second = openDb(path);
      second.close();
      const third = openDb(path);
      const got = third.prepare('SELECT steamid, discord_id, linked_by, unlinked_at FROM discord_link_history').all();
      third.close();
      expect(got).toEqual([{ steamid: P1, discord_id: '111', linked_by: 'backfill', unlinked_at: null }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // One Discord serving Steam accounts in sequence: ban the first, unlink,
  // link the next. The Discord account is the anchor, so it carries the ban.
  it('refuses a Discord whose most recent other Steam account is banned', () => {
    linkDiscord(db, P1, '111', 'Alice');
    unlinkDiscord(db, P1);
    banPlayer(db, P1, ADMIN, 'cheating', null);
    expect(linkDiscord(db, P2, '111', 'Alice')).toEqual({ ok: false, error: 'discord_banned' });
    expect(getPlayer(db, P2)?.discord_id).toBeNull();
    unbanPlayer(db, P1, ADMIN);
    expect(linkDiscord(db, P2, '111', 'Alice').ok).toBe(true);
  });

  it('says so when a Discord moves to a different Steam account within 30 days, and not after', () => {
    const day = 24 * 60 * 60 * 1000;
    const t0 = new Date('2026-09-01T00:00:00Z');
    linkDiscord(db, P1, '111', 'Alice', { now: t0 });
    unlinkDiscord(db, P1, P1, new Date(t0.getTime() + day));
    const soon = linkDiscord(db, P2, '111', 'Alice', { now: new Date(t0.getTime() + 10 * day) });
    expect(soon).toEqual({ ok: true, movedFrom: { steamid: P1, unlinkedAt: new Date(t0.getTime() + day).toISOString() } });

    unlinkDiscord(db, P2, P2, new Date(t0.getTime() + 11 * day));
    const late = linkDiscord(db, P1, '111', 'Alice', { now: new Date(t0.getTime() + 60 * day) });
    expect(late).toEqual({ ok: true });
  });

  it('the admin player page shows who else has held this Discord', () => {
    linkDiscord(db, P1, '111', 'Alice');
    unlinkDiscord(db, P1);
    linkDiscord(db, P2, '111', 'Alice');
    const mine = discordHistoryOf(db, P2);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ discordId: '111', discordName: 'Alice', unlinkedAt: null });
    expect(mine[0].others.map((o) => ({ steamid: o.steamid, name: o.name }))).toEqual([{ steamid: P1, name: 'alice' }]);
    expect(playerDetail(db, P2)!.discordHistory).toEqual(mine);
  });

  it('a merge closes the losing account\'s open link and moves its history to the survivor', () => {
    linkDiscord(db, P2, '222', 'Alt');
    mergePlayers(db, { from: P2, into: P1 });
    expect(rows()).toMatchObject([{ steamid: P1, discord_id: '222', unlinked_by: 'merge' }]);
    expect(rows()[0].unlinked_at).toBeTruthy();
  });
});
