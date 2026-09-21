import { describe, it, expect, beforeEach } from 'vitest';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, linkDiscord } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { VoiceChannels } from '../src/discord/voice.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119800000000${i + 1}`);

let db: DB;
let t: FakeTransport;
let clock: number;
let v: VoiceChannels;
let matchId: number;

beforeEach(() => {
  db = openDb(':memory:');
  IDS.forEach((id, i) => {
    upsertPlayer(db, { steamid: id, name: `n${i}`, avatar: null }, []);
    if (i !== 3) linkDiscord(db, id, `90${i}`, `d${i}`);
  });
  matchId = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'configuring', 'dead_air')").run().lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((id, i) => ins.run(matchId, id, i < 4 ? 'a' : 'b'));
  t = new FakeTransport();
  clock = Date.parse('2026-09-18T00:00:00Z');
  v = new VoiceChannels({ db, voice: t.voice, now: () => clock, settleMs: 0 });
});

describe('VoiceChannels', () => {
  // Owner, 2026-09-21: staff should be able to drop into either team's
  // channel without being on the roster.
  it('lets the configured staff role into both team channels', async () => {
    setSetting(db, 'discord_staff_role_id', '1539967662388551791');
    await v.ensure(matchId);
    const ids = v.channelsFor(matchId)!;
    expect(t.channels.get(ids.teamAId)!.staffRoleId).toBe('1539967662388551791');
    expect(t.channels.get(ids.teamBId)!.staffRoleId).toBe('1539967662388551791');
  });

  it('leaves the channels role-free when no staff role is set', async () => {
    await v.ensure(matchId);
    const ids = v.channelsFor(matchId)!;
    expect(t.channels.get(ids.teamAId)!.staffRoleId).toBeNull();
  });

  it('creates one category with team channels open only to linked players, once', async () => {
    await v.ensure(matchId);
    await v.ensure(matchId);
    const cats = [...t.channels.values()].filter((c) => c.name === `PUG #${matchId}`);
    expect(cats).toHaveLength(1);
    const ids = v.channelsFor(matchId)!;
    expect(t.channels.get(ids.teamAId)!.allowed).toEqual(['900', '901', '902']);
    expect(t.channels.get(ids.teamBId)!.allowed).toEqual(['904', '905', '906', '907']);
  });

  it('moves only players already sitting in voice', async () => {
    t.voiceOf.set('900', 'lobby-vc');
    t.voiceOf.set('905', 'lobby-vc');
    await v.ensure(matchId);
    const ids = v.channelsFor(matchId)!;
    expect(t.moves).toEqual([{ userId: '900', channelId: ids.teamAId }, { userId: '905', channelId: ids.teamBId }]);
  });

  it('does nothing when disabled', async () => {
    setSetting(db, 'discord_voice_enabled', '0');
    await v.ensure(matchId);
    expect(t.channels.size).toBe(0);
    expect(v.channelsFor(matchId)).toBeNull();
  });

  it('a failure is logged, not thrown, and not retried every pass', async () => {
    t.failVoice = true;
    await expect(v.ensure(matchId)).resolves.toBeUndefined();
    t.failVoice = false;
    await v.ensure(matchId);
    expect(t.channels.size).toBe(0);
  });

  it('after the match ends, deletes empty channels, and forces it after ten minutes', async () => {
    await v.ensure(matchId);
    const ids = v.channelsFor(matchId)!;
    t.channels.get(ids.teamAId)!.members.add('900');

    await v.sweep();
    expect(t.channels.has(ids.teamAId)).toBe(true); // match still open

    db.prepare("UPDATE matches SET state = 'completed' WHERE id = ?").run(matchId);
    await v.sweep(); // stamps ended; A still occupied
    expect(t.channels.has(ids.teamBId)).toBe(true);

    clock += 5 * 60 * 1000;
    await v.sweep();
    expect(t.channels.has(ids.teamAId)).toBe(true);

    clock += 6 * 60 * 1000;
    await v.sweep();
    expect(t.channels.has(ids.teamAId)).toBe(false);
    expect(t.channels.has(ids.teamBId)).toBe(false);
    expect(v.channelsFor(matchId)).toBeNull();
  });

  // The hazard: discord.js builds its voice state cache from the gateway, so
  // for the first moments after a restart every channel reads as having zero
  // members. A sweep in that window sees "empty", skips the handback entirely
  // (it only runs when the channels are NOT empty) and deletes channels with
  // people sitting in them, dropping them out of voice. A restart is exactly
  // when this is most likely, because a deploy is when people are told to
  // expect a blip.
  it('sweeps nothing until the bot has been up long enough to trust a member count', async () => {
    await v.ensure(matchId);
    const ids = v.channelsFor(matchId)!;
    t.channels.get(ids.teamAId)!.members.add('900');
    db.prepare("UPDATE matches SET state = 'completed' WHERE id = ?").run(matchId);

    // A fresh instance, as a restart produces, with a cache that has not
    // filled in yet: every channel reports nobody.
    const fresh = new VoiceChannels({ db, voice: t.voice, now: () => clock });
    t.channels.get(ids.teamAId)!.members.clear();
    await fresh.sweep();
    expect(t.channels.has(ids.teamAId)).toBe(true);
    expect(db.prepare('SELECT ended_at FROM discord_voice WHERE match_id = ?').get(matchId)).toMatchObject({ ended_at: null });

    clock += 31_000;
    await fresh.sweep();
    expect(t.channels.has(ids.teamAId)).toBe(false);
  });

  describe('handing players back before the channels go', () => {
    /** Park a real channel in the fake for someone to have come from. */
    const parkIn = (userId: string, channelId: string) => {
      if (!t.channels.has(channelId)) t.channels.set(channelId, { name: channelId, members: new Set(), allowed: [], staffRoleId: null });
      t.channels.get(channelId)!.members.add(userId);
      t.voiceOf.set(userId, channelId);
    };

    /** Finish the match and run the sweep past the ten minute force. */
    const endAndForce = async () => {
      db.prepare("UPDATE matches SET state = 'completed' WHERE id = ?").run(matchId);
      await v.sweep();
      clock += 11 * 60 * 1000;
      await v.sweep();
    };

    it('hands everyone back the moment the match ends, not ten minutes later', async () => {
      setSetting(db, 'discord_lobby_channel_id', 'main-lobby');
      t.channels.set('main-lobby', { name: 'Lobby', members: new Set(), allowed: [], staffRoleId: null });
      parkIn('900', 'general');
      await v.ensure(matchId);
      t.moves.length = 0;

      db.prepare("UPDATE matches SET state = 'completed' WHERE id = ?").run(matchId);
      await v.sweep(); // no clock advance at all

      expect(t.moves).toEqual([{ userId: '900', channelId: 'general' }]);
    });

    it('returns each player to the channel they were pulled out of', async () => {
      parkIn('900', 'general');
      parkIn('905', 'chill');
      await v.ensure(matchId);
      t.moves.length = 0;

      await endAndForce();

      expect(t.moves).toEqual([{ userId: '900', channelId: 'general' }, { userId: '905', channelId: 'chill' }]);
      expect(t.channels.get('general')!.members.has('900')).toBe(true);
      expect(t.channels.get('chill')!.members.has('905')).toBe(true);
    });

    it('sends a player with no remembered origin to the configured lobby', async () => {
      setSetting(db, 'discord_lobby_channel_id', 'main-lobby');
      t.channels.set('main-lobby', { name: 'Lobby', members: new Set(), allowed: [], staffRoleId: null });
      await v.ensure(matchId);
      // Walked into the team channel on their own, so nothing was remembered.
      // voiceOf as well as members: that pair is what the fake keeps
      // consistent when someone is moved out again.
      const ids = v.channelsFor(matchId)!;
      t.channels.get(ids.teamAId)!.members.add('901');
      t.voiceOf.set('901', ids.teamAId);

      await endAndForce();

      expect(t.moves).toEqual([{ userId: '901', channelId: 'main-lobby' }]);
    });

    it('falls back to the lobby when the channel they came from is gone', async () => {
      setSetting(db, 'discord_lobby_channel_id', 'main-lobby');
      t.channels.set('main-lobby', { name: 'Lobby', members: new Set(), allowed: [], staffRoleId: null });
      parkIn('900', 'general');
      await v.ensure(matchId);
      t.channels.delete('general');
      t.moves.length = 0;

      await endAndForce();

      expect(t.moves).toEqual([{ userId: '900', channelId: 'main-lobby' }]);
    });

    it('deletes the channels anyway when nobody can be moved, and tells the admins once', async () => {
      const events: AdminEvent[] = [];
      const off = subscribeAdminEvents((e) => events.push(e));
      try {
        parkIn('900', 'general');
        parkIn('901', 'general');
        await v.ensure(matchId);
        t.channels.delete('general'); // and no lobby configured
        const ids = v.channelsFor(matchId)!;

        await endAndForce();

        expect(t.channels.has(ids.teamAId)).toBe(false);
        expect(t.channels.has(ids.teamBId)).toBe(false);
        expect(v.channelsFor(matchId)).toBeNull();
        const problems = events.filter((e) => e.kind === 'problem');
        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatchObject({ kind: 'problem', matchId });
      } finally {
        off();
      }
    });

    it('moves nobody when the channels are already empty', async () => {
      await v.ensure(matchId);
      t.moves.length = 0;
      await endAndForce();
      expect(t.moves).toEqual([]);
    });
  });

  it('deletes straight away when both are empty after the end, and treats hand-deleted channels as gone', async () => {
    await v.ensure(matchId);
    const ids = v.channelsFor(matchId)!;
    t.channels.delete(ids.teamAId);
    db.prepare("UPDATE matches SET state = 'aborted' WHERE id = ?").run(matchId);
    await v.sweep();
    expect(t.channels.size).toBe(0);
  });
});
