import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { publishAdminEvent } from '../src/adminFeed.js';
import { destinationOf } from '../src/discord/feedRouting.js';
import { AdminFeedPoster } from '../src/discord/adminFeedPoster.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const P = '76561198129925325';
const ROLE = '123456789012345678';
let db: DB;
let t: FakeTransport;
let feed: AdminFeedPoster;

beforeEach(() => {
  db = openDb(':memory:');
  upsertPlayer(db, { steamid: P, name: 'nepmir', avatar: null }, []);
  setSetting(db, 'discord_admin_channel_id', 'admins');
  setSetting(db, 'discord_mod_channel_id', 'mods');
  setSetting(db, 'mod_call_role_id', ROLE);
  t = new FakeTransport();
  feed = new AdminFeedPoster({ db, transport: t, publicUrl: 'https://pug.test' });
  feed.start();
});
afterEach(() => feed.stop());

describe('aim flags on the feed', () => {
  it('go to the mod channel', () => {
    expect(destinationOf({ kind: 'aim_flag', steamid: P, matchId: 722, rule: 'hs_share', detail: '' })).toBe('mod');
  });

  it('ping the mod call role for aimbot_multi', async () => {
    publishAdminEvent({ kind: 'aim_flag', steamid: P, matchId: 722, rule: 'aimbot_multi', detail: 'hs_share + flick_return. hs_share: ...' });
    await feed.idle();
    const [m] = t.live();
    expect(m.channelId).toBe('mods');
    expect(m.payload.content).toBe(`<@&${ROLE}>`);
    expect(m.payload.mentionRoleIds).toEqual([ROLE]);
    expect(JSON.stringify(m.payload)).toContain('two or more aim rules');
    expect(JSON.stringify(m.payload)).toContain('/match/722');
    expect(JSON.stringify(m.payload)).toContain('Nothing was done to the account');
  });

  it('do not ping for one rule alone', async () => {
    publishAdminEvent({ kind: 'aim_flag', steamid: P, matchId: 722, rule: 'flick_return', detail: '2 of 9 SI kills were a 90+ degree flick' });
    await feed.idle();
    const [m] = t.live();
    expect(m.channelId).toBe('mods');
    expect(m.payload.content).toBeUndefined();
    expect(JSON.stringify(m.payload)).toContain('`flick_return` aim rule');
  });

  it('go quiet with the problems feed switched off', async () => {
    setSetting(db, 'admin_feed_problems', '0');
    publishAdminEvent({ kind: 'aim_flag', steamid: P, matchId: 722, rule: 'aimbot_multi', detail: '' });
    await feed.idle();
    expect(t.live()).toEqual([]);
  });
});
