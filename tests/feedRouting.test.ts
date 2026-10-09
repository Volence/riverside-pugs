import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { FEED_DESTINATION, MOD_ACTIONS, feedChannel, modChannelOrAdmin } from '../src/discord/feedRouting.js';
import type { AdminEvent } from '../src/adminFeed.js';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  setSetting(db, 'discord_admin_channel_id', 'admins');
});

const slur: AdminEvent = { kind: 'conduct_flag', steamid: '1', where: 'chat', text: 'x', slurs: ['r-word'], matchId: null, serverId: null };
const lilac: AdminEvent = { kind: 'lilac_flag', steamid: '1', cheat: 'aimbot', banned: false, matchId: null };
const action = (a: string): AdminEvent => ({ kind: 'admin_action', adminId: '9', action: a, target: '1', detail: {} });

describe('feedChannel', () => {
  it('with no mod channel, everything goes where it always went', () => {
    expect(feedChannel(db, slur)).toBe('admins');
    expect(feedChannel(db, lilac)).toBe('admins');
    expect(feedChannel(db, action('ban'))).toBe('admins');
  });

  it('with a mod channel, moderator lines move and automatic ones stay', () => {
    setSetting(db, 'discord_mod_channel_id', 'mods');
    expect(feedChannel(db, slur)).toBe('mods');
    expect(feedChannel(db, { kind: 'sourcetv_watch' } as AdminEvent)).toBe('mods');
    expect(feedChannel(db, lilac)).toBe('admins');
    expect(feedChannel(db, { kind: 'penalty', steamid: '1', penalty: 'no_show', matchId: null })).toBe('admins');
    expect(feedChannel(db, action('ban'))).toBe('mods');
    expect(feedChannel(db, action('ticket_claim'))).toBe('mods');
    expect(feedChannel(db, action('setting'))).toBe('admins');
    expect(feedChannel(db, action('something_new'))).toBe('admins');
  });

  it('every moderator action goes to the mod channel', () => {
    setSetting(db, 'discord_mod_channel_id', 'mods');
    for (const a of MOD_ACTIONS) expect(feedChannel(db, action(a)), a).toBe('mods');
  });

  it('a kind switched off posts nowhere, whichever channel it would use', () => {
    setSetting(db, 'discord_mod_channel_id', 'mods');
    setSetting(db, 'admin_feed_conduct', '0');
    expect(feedChannel(db, slur)).toBeNull();
  });

  it('mod channel set, admin channel empty: mod lines post, admin lines do not', () => {
    setSetting(db, 'discord_admin_channel_id', '');
    setSetting(db, 'discord_mod_channel_id', 'mods');
    expect(feedChannel(db, slur)).toBe('mods');
    expect(feedChannel(db, lilac)).toBeNull();
    expect(modChannelOrAdmin(db)).toBe('mods');
  });

  it('the spec\'s table, kind by kind', () => {
    const mod = Object.entries(FEED_DESTINATION).filter(([, d]) => d === 'mod').map(([k]) => k).sort();
    expect(mod).toEqual(['alt', 'appeal', 'conduct_flag', 'ip_match', 'report', 'sourcetv_watch', 'spray_exploit', 'staff_message']);
  });
});
