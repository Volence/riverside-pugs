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
  v = new VoiceChannels({ db, voice: t.voice, now: () => clock });
});

describe('VoiceChannels', () => {
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

  describe('handing players back before the channels go', () => {
    /** Park a real channel in the fake for someone to have come from. */
    const parkIn = (userId: string, channelId: string) => {
      if (!t.channels.has(channelId)) t.channels.set(channelId, { name: channelId, members: new Set(), allowed: [] });
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
      t.channels.set('main-lobby', { name: 'Lobby', members: new Set(), allowed: [] });
      await v.ensure(matchId);
      // Walked into the team channel on their own, so nothing was remembered.
      const ids = v.channelsFor(matchId)!;
      t.channels.get(ids.teamAId)!.members.add('901');

      await endAndForce();

      expect(t.moves).toEqual([{ userId: '901', channelId: 'main-lobby' }]);
    });

    it('falls back to the lobby when the channel they came from is gone', async () => {
      setSetting(db, 'discord_lobby_channel_id', 'main-lobby');
      t.channels.set('main-lobby', { name: 'Lobby', members: new Set(), allowed: [] });
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
