import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import {
  upsertPlayer, getPlayer, linkDiscord, unlinkDiscord, playerByDiscordId,
  createLinkCode, consumeLinkCode,
} from '../src/players.js';

const P1 = '76561198000000001';
const P2 = '76561198000000002';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  upsertPlayer(db, { steamid: P1, name: 'alice', avatar: null }, []);
  upsertPlayer(db, { steamid: P2, name: 'bob', avatar: null }, []);
});

describe('discord linking', () => {
  it('links a discord account and finds the player by it', () => {
    expect(linkDiscord(db, P1, '111', 'alice#1')).toEqual({ ok: true });
    expect(playerByDiscordId(db, '111')?.steamid).toBe(P1);
    expect(getPlayer(db, P1)?.discord_name).toBe('alice#1');
  });

  it('refuses a discord account already linked to another player and changes neither', () => {
    linkDiscord(db, P1, '111', 'alice#1');
    expect(linkDiscord(db, P2, '111', 'alice#1')).toEqual({ ok: false, error: 'discord_taken' });
    expect(getPlayer(db, P1)?.discord_id).toBe('111');
    expect(getPlayer(db, P2)?.discord_id).toBeNull();
  });

  it('relinking the same player to the same account is fine, but a different account is refused until they unlink', () => {
    linkDiscord(db, P1, '111', 'alice#1');
    expect(linkDiscord(db, P1, '111', 'alice renamed')).toEqual({ ok: true });
    expect(getPlayer(db, P1)?.discord_name).toBe('alice renamed');
    expect(linkDiscord(db, P1, '222', 'alt')).toEqual({ ok: false, error: 'already_linked' });
    expect(getPlayer(db, P1)?.discord_id).toBe('111');
    unlinkDiscord(db, P1);
    expect(linkDiscord(db, P1, '222', 'alt')).toEqual({ ok: true });
    expect(playerByDiscordId(db, '111')).toBeUndefined();
  });

  it('unlink clears both columns', () => {
    linkDiscord(db, P1, '111', 'alice#1');
    unlinkDiscord(db, P1);
    const p = getPlayer(db, P1)!;
    expect(p.discord_id).toBeNull();
    expect(p.discord_name).toBeNull();
  });

  it('many players can be unlinked at once (the unique index ignores NULL)', () => {
    expect(getPlayer(db, P1)?.discord_id).toBeNull();
    expect(getPlayer(db, P2)?.discord_id).toBeNull();
  });
});

describe('link codes', () => {
  it('is consumed exactly once', () => {
    const code = createLinkCode(db, '111', 'alice#1');
    expect(code).toMatch(/^[A-Za-z0-9_-]{24,}$/);
    expect(consumeLinkCode(db, code)).toEqual({ discordId: '111', discordName: 'alice#1' });
    expect(consumeLinkCode(db, code)).toBeNull();
  });

  it('expires after 15 minutes', () => {
    const code = createLinkCode(db, '111', 'alice#1');
    const later = new Date(Date.now() + 16 * 60 * 1000);
    expect(consumeLinkCode(db, code, later)).toBeNull();
  });

  it('an unknown code is null', () => {
    expect(consumeLinkCode(db, 'nope')).toBeNull();
  });
});
