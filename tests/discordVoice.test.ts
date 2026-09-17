import { describe, it, expect, beforeEach } from 'vitest';
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

  it('deletes straight away when both are empty after the end, and treats hand-deleted channels as gone', async () => {
    await v.ensure(matchId);
    const ids = v.channelsFor(matchId)!;
    t.channels.delete(ids.teamAId);
    db.prepare("UPDATE matches SET state = 'aborted' WHERE id = ?").run(matchId);
    await v.sweep();
    expect(t.channels.size).toBe(0);
  });
});
