import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { addServer } from '../src/serverPool.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { addPerson, confirmBooking, createBooking, removePerson, respondPerson } from '../src/bookings/bookings.js';
import { BookingVoice } from '../src/bookings/voice.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const P = Array.from({ length: 6 }, (_, i) => `765611990000009${String(i).padStart(2, '0')}`);
const START = Date.parse('2026-10-02T20:00:00.000Z');
const NOW = START - 2 * 24 * 60 * 60_000;

let db: DB;
let t: FakeTransport;
let connected: boolean;
let voice: BookingVoice;
let events: AdminEvent[];
let unsubscribe: () => void;

beforeEach(() => {
  db = openDb(':memory:');
  const ins = db.prepare("INSERT INTO players (steamid, name, status, discord_id) VALUES (?, ?, 'active', ?)");
  P.forEach((id, i) => ins.run(id, `p${i}`, i === 5 ? null : `d${i}`));
  setSetting(db, 'competitive_enabled', 'everyone');
  setSetting(db, 'map_pool', JSON.stringify(['no_mercy']));
  setSetting(db, 'pug_reserve_servers', '1');
  for (const n of ['a', 'bb', 'ccc']) {
    const sid = addServer(db, { name: n, host: '10.0.0.1', port: 27014 + n.length, rconPort: 1, rconPassword: 'x' });
    db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(sid);
  }
  setSetting(db, 'discord_voice_enabled', '1');
  setSetting(db, 'discord_staff_role_id', 'staffrole');
  t = new FakeTransport();
  connected = true;
  voice = new BookingVoice({ db, voice: () => (connected ? t.voice : null), now: () => NOW });
  events = [];
  unsubscribe = subscribeAdminEvents((e) => events.push(e));
});
afterEach(() => unsubscribe());

const book = (confirm = true) => {
  const r = createBooking(db, {
    by: P[0], opponent: { steamid: P[1] }, startsAt: new Date(START).toISOString(), minutes: 120, playlist: ['no_mercy'], now: new Date(NOW),
  });
  if (!r.ok) throw new Error(r.error);
  if (confirm) confirmBooking(db, { bookingId: r.value.id, by: P[1], now: new Date(NOW) });
  return r.value.id;
};

const accept = (id: number, side: 'a' | 'b', steamid: string) => {
  addPerson(db, { bookingId: id, by: side === 'a' ? P[0] : P[1], side, steamid, role: 'player', now: new Date(NOW) });
  respondPerson(db, { bookingId: id, steamid, accept: true, now: new Date(NOW) });
};

const row = (id: number) => db.prepare('SELECT * FROM booking_voice WHERE booking_id = ?').get(id) as
  { category_id: string; side_a_id: string; side_b_id: string; created_at: string; deleted_at: string | null } | undefined;

describe('BookingVoice.ensure', () => {
  it('makes a private category named after both sides and a channel per side, labelled by side, with that side\'s people', async () => {
    const id = book();
    accept(id, 'a', P[2]);
    accept(id, 'b', P[3]);
    accept(id, 'b', P[5]); // no linked Discord: not in voice
    await voice.ensure(id);
    const r = row(id)!;
    expect(r.created_at).toBe(new Date(NOW).toISOString());
    expect(r.deleted_at).toBeNull();
    const cat = t.channels.get(r.category_id)!;
    const a = t.channels.get(r.side_a_id)!;
    const b = t.channels.get(r.side_b_id)!;
    expect(cat).toMatchObject({ name: "Scrim: p0's group vs p1's group", privateView: true });
    expect(a).toMatchObject({ name: "p0's group", privateView: true, staffRoleId: 'staffrole' });
    expect(b).toMatchObject({ name: "p1's group", privateView: true, staffRoleId: 'staffrole' });
    expect([...a.allowed].sort()).toEqual(['d0', 'd2']);
    expect([...b.allowed].sort()).toEqual(['d1', 'd3']);
    expect(events).toEqual([]);
  });

  it('makes nothing a second time', async () => {
    const id = book();
    await voice.ensure(id);
    await voice.ensure(id);
    // A new instance (a web restart) sees the row and makes nothing either.
    await new BookingVoice({ db, voice: () => t.voice }).ensure(id);
    expect(t.channels.size).toBe(3);
  });

  it('does nothing with voice off, with no bot connected, or with a side unconfirmed', async () => {
    const id = book();
    setSetting(db, 'discord_voice_enabled', '0');
    await voice.ensure(id);
    expect(t.channels.size).toBe(0);
    expect(row(id)).toBeUndefined();

    setSetting(db, 'discord_voice_enabled', '1');
    connected = false;
    await voice.ensure(id);
    expect(t.channels.size).toBe(0);
    expect(row(id)).toBeUndefined();

    connected = true;
    const unconfirmed = book(false);
    await voice.ensure(unconfirmed);
    expect(t.channels.size).toBe(0);
    expect(row(unconfirmed)).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('a failure tells staff once, even across two calls, and is not retried in this process', async () => {
    const id = book();
    t.failVoice = true;
    await expect(voice.ensure(id)).resolves.toBeUndefined();
    await voice.ensure(id);
    const problems = events.filter((e) => e.kind === 'problem');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: 'problem', text: expect.stringContaining(`Booking ${id}`) });
    expect(row(id)).toBeUndefined();
    t.failVoice = false;
    await voice.ensure(id);
    expect(row(id)).toBeUndefined();
    expect(events.filter((e) => e.kind === 'problem')).toHaveLength(1);
  });
});

describe('BookingVoice.sync', () => {
  it('lets in a newly accepted person and takes out a removed one', async () => {
    const id = book();
    accept(id, 'a', P[2]);
    await voice.ensure(id);
    const r = row(id)!;
    accept(id, 'b', P[3]);
    removePerson(db, { bookingId: id, by: P[0], steamid: P[2], now: new Date(NOW) });
    await voice.sync(id);
    expect([...t.channels.get(r.side_a_id)!.allowed].sort()).toEqual(['d0']);
    expect([...t.channels.get(r.side_b_id)!.allowed].sort()).toEqual(['d1', 'd3']);
  });

  it('takes out someone barred from the box (banned), as the allowlist does', async () => {
    const id = book();
    accept(id, 'a', P[2]);
    await voice.ensure(id);
    const r = row(id)!;
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(P[2]);
    await voice.sync(id);
    expect(t.channels.get(r.side_a_id)!.allowed).toEqual(['d0']);
  });

  it('after a web restart, re-grants everyone who belongs on the first sync', async () => {
    const id = book();
    await voice.ensure(id);
    const r = row(id)!;
    // Access lost behind our back (or never confirmed): a fresh instance knows nothing.
    t.channels.get(r.side_a_id)!.allowed = [];
    t.channels.get(r.side_b_id)!.allowed = [];
    const calls: [string, string, boolean][] = [];
    const ops = { ...t.voice, setMemberAccess: async (c: string, u: string, allow: boolean) => { calls.push([c, u, allow]); await t.voice.setMemberAccess(c, u, allow); } };
    const fresh = new BookingVoice({ db, voice: () => ops });
    await fresh.sync(id);
    expect(t.channels.get(r.side_a_id)!.allowed).toEqual(['d0']);
    expect(t.channels.get(r.side_b_id)!.allowed).toEqual(['d1']);
    // And only once: the second sync has nothing to change.
    calls.length = 0;
    await fresh.sync(id);
    expect(calls).toEqual([]);
  });

  it('logs and carries on when an access change fails, and tries it again next time', async () => {
    const id = book();
    await voice.ensure(id);
    const r = row(id)!;
    accept(id, 'a', P[2]);
    let fail = true;
    const ops = {
      ...t.voice,
      setMemberAccess: async (c: string, u: string, allow: boolean) => {
        if (fail) throw new Error('discord down');
        await t.voice.setMemberAccess(c, u, allow);
      },
    };
    const v = new BookingVoice({ db, voice: () => ops });
    await expect(v.sync(id)).resolves.toBeUndefined();
    fail = false;
    await v.sync(id);
    expect([...t.channels.get(r.side_a_id)!.allowed].sort()).toEqual(['d0', 'd2']);
  });
});

describe('BookingVoice.close', () => {
  it('moves everyone to the lobby, deletes both channels and the category, then does nothing the second time', async () => {
    setSetting(db, 'discord_lobby_channel_id', 'lobby');
    t.channels.set('lobby', { name: 'Lobby', members: new Set(), allowed: [], staffRoleId: null });
    const id = book();
    await voice.ensure(id);
    const r = row(id)!;
    await t.voice.move('d0', r.side_a_id);
    await t.voice.move('d1', r.side_b_id);
    t.moves = [];
    await voice.close(id);
    expect(t.moves).toEqual([{ userId: 'd0', channelId: 'lobby' }, { userId: 'd1', channelId: 'lobby' }]);
    expect(t.channels.has(r.side_a_id)).toBe(false);
    expect(t.channels.has(r.side_b_id)).toBe(false);
    expect(t.channels.has(r.category_id)).toBe(false);
    expect(row(id)!.deleted_at).toBe(new Date(NOW).toISOString());

    let calls = 0;
    const counting = new BookingVoice({
      db,
      voice: () => ({ ...t.voice, channelMemberIds: async () => { calls++; return []; }, deleteChannel: async () => { calls++; } }),
    });
    await counting.close(id);
    await voice.close(id);
    expect(calls).toBe(0);
    expect(t.moves).toHaveLength(2);
  });

  it('with no lobby set, still deletes; a failing step never throws or stops the rest', async () => {
    const id = book();
    await voice.ensure(id);
    const r = row(id)!;
    const deleted: string[] = [];
    const v = new BookingVoice({
      db,
      voice: () => ({
        ...t.voice,
        channelMemberIds: async () => { throw new Error('nope'); },
        deleteChannel: async (c: string) => { deleted.push(c); if (c === r.side_a_id) throw new Error('missing permissions'); },
      }),
    });
    await expect(v.close(id)).resolves.toBeUndefined();
    expect(deleted).toEqual([r.side_a_id, r.side_b_id, r.category_id]);
    expect(row(id)!.deleted_at).not.toBeNull();
  });

  it('does nothing with no bot connected, keeping the row for a later close', async () => {
    const id = book();
    await voice.ensure(id);
    connected = false;
    await voice.close(id);
    expect(row(id)!.deleted_at).toBeNull();
    expect(t.channels.size).toBe(3);
  });

  it('closeEnded closes what an offline wind-down left behind, and only for ended bookings', async () => {
    const ended = book();
    const running = book();
    await voice.ensure(ended);
    await voice.ensure(running);
    connected = false;
    await voice.close(ended); // the wind-down ran with no bot
    db.prepare("UPDATE bookings SET state = 'ended', ending_at = ?, ended_at = ? WHERE id = ?").run(new Date(NOW).toISOString(), new Date(NOW).toISOString(), ended);
    await voice.closeEnded();
    expect(row(ended)!.deleted_at).toBeNull();
    connected = true;
    await voice.closeEnded();
    expect(row(ended)!.deleted_at).not.toBeNull();
    expect(row(running)!.deleted_at).toBeNull();
    expect(t.channels.size).toBe(3);
  });
});
