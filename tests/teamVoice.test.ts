import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DB } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import * as N from '../src/events/entries.js';
import { FINISHED_GRACE_MS, TeamVoice, outSince, teamVoiceChannel, teamVoiceCovers } from '../src/events/teamVoice.js';
import { ADMIN, NOW, must } from './eventFixture.js';
import { draftFixture } from './draftFixture.js';
import { BENCH, liveStandins, standinFixture } from './standinFixture.js';
import { FakeTransport } from './fakes/fakeTransport.js';

let t: FakeTransport;
let connected: boolean;
let clock: number;
let events: AdminEvent[];
let unsubscribe: () => void;

const disc = (steamid: string) => `d${steamid}`;

function setup(db: DB): TeamVoice {
  db.prepare("UPDATE players SET discord_id = 'd' || steamid").run();
  setSetting(db, 'discord_voice_enabled', '1');
  setSetting(db, 'discord_staff_role_id', 'staffrole');
  return new TeamVoice({ db, voice: () => (connected ? t.voice : null), now: () => clock });
}

const rows = (db: DB, eventId: number) => db.prepare('SELECT * FROM event_entry_voice WHERE event_id = ? ORDER BY entry_id').all(eventId) as
  { entry_id: number; category_id: string; channel_id: string; deleted_at: string | null }[];

const rosterIds = (db: DB, entryId: number) => {
  const r = N.rosterOf(db, entryId);
  return [...r.starters, ...r.subs].map(disc).sort();
};

beforeEach(() => {
  t = new FakeTransport();
  connected = true;
  clock = NOW.getTime();
  events = [];
  unsubscribe = subscribeAdminEvents((e) => events.push(e));
});
afterEach(() => unsubscribe());

describe('TeamVoice', () => {
  it('makes nothing before the teams are published', async () => {
    const f = draftFixture();
    const tv = setup(f.db);
    await tv.tick();
    expect(rows(f.db, f.eventId)).toEqual([]);
    expect(t.channels.size).toBe(0);
  });

  it('makes one private category named after the event and a private channel per team, with that team in it', async () => {
    const f = standinFixture();
    const tv = setup(f.db);
    await tv.tick();
    const made = rows(f.db, f.eventId);
    expect(made.map((r) => r.entry_id)).toEqual([...f.entries].sort((a, b) => a - b));
    expect(new Set(made.map((r) => r.category_id)).size).toBe(1);
    const ev = f.db.prepare('SELECT name FROM events WHERE id = ?').get(f.eventId) as { name: string };
    expect(t.channels.get(made[0].category_id)).toMatchObject({ name: `${ev.name}: Teams`, privateView: true });
    for (const r of made) {
      const ch = t.channels.get(r.channel_id)!;
      expect(ch.name).toBe(N.getEntry(f.db, r.entry_id)!.name);
      expect(ch).toMatchObject({ privateView: true, staffRoleId: 'staffrole' });
      expect([...ch.allowed].sort()).toEqual(rosterIds(f.db, r.entry_id));
      expect(teamVoiceChannel(f.db, r.entry_id)).toBe(r.channel_id);
    }
    // A second tick makes nothing more.
    await tv.tick();
    expect(rows(f.db, f.eventId)).toHaveLength(made.length);
    expect(t.channels.size).toBe(made.length + 1);
  });

  it('does nothing with voice switched off or no bot, and makes the channels once the bot is back', async () => {
    const f = standinFixture();
    const tv = setup(f.db);
    setSetting(f.db, 'discord_voice_enabled', '0');
    await tv.tick();
    expect(rows(f.db, f.eventId)).toEqual([]);
    setSetting(f.db, 'discord_voice_enabled', '1');
    connected = false;
    await tv.tick();
    expect(rows(f.db, f.eventId)).toEqual([]);
    connected = true;
    await tv.tick();
    expect(rows(f.db, f.eventId)).toHaveLength(f.entries.length);
  });

  it('keeps a team channel in step with its roster: a replaced player is let out and the new one in', async () => {
    const f = standinFixture();
    const tv = setup(f.db);
    await tv.tick();
    const entry = N.getEntry(f.db, f.entries[0])!;
    const out = N.rosterOf(f.db, entry.id).starters.find((s) => s !== entry.captain_steamid)!;
    must(N.replaceDraftPlayer(f.db, { eventId: f.eventId, entryId: entry.id, out, in: BENCH[0], reason: 'left', note: null, actor: ADMIN, now: NOW }));
    await tv.tick();
    const ch = t.channels.get(teamVoiceChannel(f.db, entry.id)!)!;
    expect(ch.allowed).toContain(disc(BENCH[0]));
    expect(ch.allowed).not.toContain(disc(out));
    expect([...ch.allowed].sort()).toEqual(rosterIds(f.db, entry.id));
  });

  it('deletes the channel of a team that is out, and leaves the rest', async () => {
    const f = standinFixture();
    const tv = setup(f.db);
    await tv.tick();
    const gone = teamVoiceChannel(f.db, f.entries[1])!;
    f.db.prepare("UPDATE event_entries SET status = 'disqualified' WHERE id = ?").run(f.entries[1]);
    await tv.tick();
    expect(t.channels.has(gone)).toBe(false);
    expect(teamVoiceChannel(f.db, f.entries[1])).toBeNull();
    expect(teamVoiceChannel(f.db, f.entries[0])).not.toBeNull();
  });

  it('keeps the channels a while after the event finishes, then moves everyone to the lobby and deletes them all with the category', async () => {
    const f = standinFixture();
    const tv = setup(f.db);
    setSetting(f.db, 'discord_lobby_channel_id', 'lobby');
    t.channels.set('lobby', { name: 'Lobby', members: new Set(), allowed: [], staffRoleId: null, privateView: false });
    await tv.tick();
    const made = rows(f.db, f.eventId);
    const talker = disc(N.rosterOf(f.db, made[0].entry_id).starters[0]);
    t.channels.get(made[0].channel_id)!.members.add(talker);
    t.voiceOf.set(talker, made[0].channel_id);
    f.db.prepare("UPDATE events SET status = 'finished', finished_at = ? WHERE id = ?").run(new Date(clock).toISOString(), f.eventId);
    await tv.tick();
    expect(rows(f.db, f.eventId).every((r) => r.deleted_at === null)).toBe(true);
    clock += FINISHED_GRACE_MS;
    await tv.tick();
    expect(rows(f.db, f.eventId).every((r) => r.deleted_at !== null)).toBe(true);
    expect(t.moves).toContainEqual({ userId: talker, channelId: 'lobby' });
    expect([...t.channels.keys()]).toEqual(['lobby']);
  });

  it('deletes them at once when the event is cancelled', async () => {
    const f = standinFixture();
    const tv = setup(f.db);
    await tv.tick();
    f.db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(f.eventId);
    await tv.tick();
    expect(t.channels.size).toBe(0);
  });

  it('reports a refused create to staff once and does not retry it', async () => {
    const f = standinFixture();
    const tv = setup(f.db);
    t.failVoice = true;
    await tv.tick();
    await tv.tick();
    expect(rows(f.db, f.eventId)).toEqual([]);
    expect(events.filter((e) => e.kind === 'problem' && /team voice/.test(e.text))).toHaveLength(1);
  });

  it('covers a tournament booking only when both of its teams have a channel', async () => {
    const f = await liveStandins();
    const tv = setup(f.db);
    const m = f.db.prepare("SELECT id, entry_a, entry_b FROM event_matches WHERE event_id = ? AND entry_a IS NOT NULL AND entry_b IS NOT NULL LIMIT 1")
      .get(f.eventId) as { id: number; entry_a: number; entry_b: number };
    f.db.pragma('foreign_keys = OFF');
    f.db.prepare('UPDATE event_matches SET booking_id = 999 WHERE id = ?').run(m.id);
    expect(teamVoiceCovers(f.db, 999)).toBe(false);
    await tv.tick();
    expect(teamVoiceCovers(f.db, 999)).toBe(true);
    f.db.prepare("UPDATE event_entries SET status = 'disqualified' WHERE id = ?").run(m.entry_b);
    await tv.tick();
    expect(teamVoiceCovers(f.db, 999)).toBe(false);
  });
});

describe('TeamVoice match headings and knockouts', () => {
  const firstMatch = (db: DB, eventId: number) => db.prepare(
    'SELECT id, entry_a, entry_b FROM event_matches WHERE event_id = ? AND entry_a IS NOT NULL AND entry_b IS NOT NULL ORDER BY id LIMIT 1',
  ).get(eventId) as { id: number; entry_a: number; entry_b: number };
  const heading = (db: DB, matchId: number) => db.prepare('SELECT * FROM event_match_voice WHERE match_id = ?').get(matchId) as
    { category_id: string; deleted_at: string | null } | undefined;

  it('puts a match being played under a heading named after it, below the event category, and back once it is over', async () => {
    const f = await liveStandins();
    const tv = setup(f.db);
    await tv.tick();
    const m = firstMatch(f.db, f.eventId);
    // Waiting for its room: no heading yet.
    await tv.tick();
    expect(heading(f.db, m.id)).toBeUndefined();
    f.db.prepare("UPDATE event_matches SET status = 'veto' WHERE id = ?").run(m.id);
    await tv.tick();
    const h = heading(f.db, m.id)!;
    const teams = rows(f.db, f.eventId)[0].category_id;
    const name = (id: number) => N.getEntry(f.db, id)!.name;
    expect(t.channels.get(h.category_id)).toMatchObject({ name: `${name(m.entry_a)} vs ${name(m.entry_b)}`, privateView: true });
    expect(t.categoryAfter.get(h.category_id)).toBe(teams);
    expect(t.parentOf.get(teamVoiceChannel(f.db, m.entry_a)!)).toBe(h.category_id);
    expect(t.parentOf.get(teamVoiceChannel(f.db, m.entry_b)!)).toBe(h.category_id);
    // Still one heading on later ticks.
    await tv.tick();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM event_match_voice').get()).toEqual({ n: 1 });

    f.db.prepare("UPDATE event_matches SET status = 'done', winner_entry = ?, finished_at = ? WHERE id = ?").run(m.entry_a, new Date(clock).toISOString(), m.id);
    await tv.tick();
    expect(heading(f.db, m.id)!.deleted_at).not.toBeNull();
    expect(t.channels.has(h.category_id)).toBe(false);
    expect(t.parentOf.get(teamVoiceChannel(f.db, m.entry_a)!)).toBe(teams);
    expect(t.parentOf.get(teamVoiceChannel(f.db, m.entry_b)!)).toBe(teams);
  });

  it('deletes a knocked-out team\'s channel a while after the match that put it out, in an elimination bracket only', async () => {
    const f = await liveStandins();
    const tv = setup(f.db);
    await tv.tick();
    const m = firstMatch(f.db, f.eventId);
    f.db.prepare("UPDATE event_matches SET status = 'done', winner_entry = ?, finished_at = ? WHERE id = ?").run(m.entry_a, new Date(clock).toISOString(), m.id);
    // A swiss loss is not out.
    expect(outSince(f.db, N.getEntry(f.db, m.entry_b)!)).toBeNull();
    f.db.prepare("UPDATE event_stages SET type = 'single_elim' WHERE event_id = ?").run(f.eventId);
    expect(outSince(f.db, N.getEntry(f.db, m.entry_a)!)).toBeNull();
    expect(outSince(f.db, N.getEntry(f.db, m.entry_b)!)).toBe(clock + FINISHED_GRACE_MS);
    await tv.tick();
    expect(teamVoiceChannel(f.db, m.entry_b)).not.toBeNull();
    clock += FINISHED_GRACE_MS;
    await tv.tick();
    expect(teamVoiceChannel(f.db, m.entry_b)).toBeNull();
    expect(teamVoiceChannel(f.db, m.entry_a)).not.toBeNull();
  });

  it('does not count a loser as out while a later match (a third place match) has it', async () => {
    const f = await liveStandins();
    setup(f.db);
    const m = firstMatch(f.db, f.eventId);
    f.db.prepare("UPDATE event_stages SET type = 'single_elim' WHERE event_id = ?").run(f.eventId);
    f.db.prepare("UPDATE event_matches SET status = 'done', winner_entry = ?, finished_at = ? WHERE id = ?").run(m.entry_a, new Date(clock).toISOString(), m.id);
    const other = f.db.prepare("SELECT id FROM event_matches WHERE event_id = ? AND id != ? ORDER BY id LIMIT 1").get(f.eventId, m.id) as { id: number };
    f.db.prepare("UPDATE event_matches SET entry_a = ?, status = 'waiting' WHERE id = ?").run(m.entry_b, other.id);
    expect(outSince(f.db, N.getEntry(f.db, m.entry_b)!)).toBeNull();
  });
});
