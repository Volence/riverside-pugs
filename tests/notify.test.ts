import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { setSetting } from '../src/settings.js';
import { Notifier, prefsOf, setPref, wants, NOTIFY_TYPES } from '../src/notify/notify.js';
import { bookingMessage, whenUtc } from '../src/bookings/messages.js';
import { confirmBooking, createBooking, holdBox, markReady, markSetup } from '../src/bookings/bookings.js';
import type { MessagePayload } from '../src/discord/transport.js';

const A = '76561199000000801';
const B = '76561199000000802';
const C = '76561199000000803';
let db: DB;
let sent: { to: string; payload: MessagePayload }[];
beforeEach(() => {
  db = openDb(':memory:');
  const ins = db.prepare("INSERT INTO players (steamid, name, status, discord_id) VALUES (?, ?, 'active', ?)");
  ins.run(A, 'Alpha*', 'd-a');
  ins.run(B, 'Bravo', 'd-b');
  ins.run(C, 'Charlie', null);
  sent = [];
});
const notifier = (dm: ((to: string, p: MessagePayload) => Promise<void>) | null = async (to, payload) => { sent.push({ to, payload }); }) =>
  new Notifier({ db, dm: () => dm });

describe('preferences', () => {
  it('every type is on until turned off', () => {
    expect(wants(db, A, 'booking_ready')).toBe(true);
    setPref(db, A, 'booking_ready', false);
    expect(wants(db, A, 'booking_ready')).toBe(false);
    setPref(db, A, 'booking_ready', true);
    expect(wants(db, A, 'booking_ready')).toBe(true);
    expect(prefsOf(db, A).map((p) => p.type)).toEqual(NOTIFY_TYPES.map((t) => t.type));
  });
  it('lists the two match room DMs (plan T3a)', () => {
    expect(NOTIFY_TYPES.filter((t) => t.type === 'event_match_room' || t.type === 'event_match_forfeit')).toEqual([
      { type: 'event_match_room', label: 'My tournament match room opens: ready up and veto' },
      { type: 'event_match_forfeit', label: 'A tournament match of mine is a forfeit because a team did not ready up in the match room or did not show on the server' },
    ]);
  });
  it('lists the two match server DMs (plan T3b)', () => {
    expect(NOTIFY_TYPES.filter((t) => t.type === 'event_match_connect' || t.type === 'event_match_result')).toEqual([
      { type: 'event_match_connect', label: 'My tournament server is ready, with the connect line' },
      { type: 'event_match_result', label: 'A tournament match of mine finished and is in its confirm window' },
    ]);
  });
});

describe('Notifier', () => {
  const payload: MessagePayload = { content: 'hi', embeds: [], components: [], mentionUserIds: [] };
  it('DMs each linked player who wants the type, once', async () => {
    setPref(db, B, 'booking_ready', false);
    expect(notifier().send([A, A, B, C], 'booking_ready', payload)).toBe(1);
    expect(sent.map((s) => s.to)).toEqual(['d-a']);
  });

  it('sends nothing while the bot is away, and a refused DM never throws', async () => {
    expect(notifier(null).send([A], 'booking_ready', payload)).toBe(0);
    expect(() => notifier(async () => { throw new Error('Cannot send messages to this user'); }).send([A], 'booking_ready', payload)).not.toThrow();
    await new Promise((r) => setImmediate(r));
  });
});

describe('booking messages', () => {
  beforeEach(() => {
    setSetting(db, 'competitive_enabled', 'everyone');
    setSetting(db, 'map_pool', JSON.stringify(['no_mercy']));
    for (const n of ['a', 'bb', 'ccc']) {
      const id = addServer(db, { name: n, host: '10.0.0.9', port: 27015 + n.length, rconPort: 1, rconPassword: 'x' });
      db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(id);
    }
  });
  const book = () => {
    const r = createBooking(db, { by: A, opponent: { steamid: B }, startsAt: '2026-10-02T20:00:00.000Z', minutes: 90, playlist: ['no_mercy'], now: new Date('2026-10-01T12:00:00.000Z') });
    if (!r.ok) throw new Error(r.error);
    return r.value.id;
  };

  it('names the sides, escaped, with the time in UTC and a link', () => {
    const id = book();
    const m = bookingMessage(db, 'https://riversidepug.com', id, 'booking_invite')!;
    expect(m.content).toContain('Alpha\\*');
    expect(m.content).toContain('2026-10-02 20:00 UTC');
    expect(m.components).toEqual([[{ kind: 'link', url: 'https://riversidepug.com/booking/' + id, label: 'Open the booking' }]]);
    expect(whenUtc('2026-10-02T20:00:00.000Z')).toBe('2026-10-02 20:00 UTC');
  });

  it('the ready message carries the connect line', () => {
    const id = book();
    confirmBooking(db, { bookingId: id, by: B });
    const now = new Date('2026-10-02T19:45:00.000Z');
    holdBox(db, id, 3, now);
    markSetup(db, id, now);
    markReady(db, id, now);
    const pw = (db.prepare('SELECT password FROM bookings WHERE id = ?').get(id) as { password: string }).password;
    expect(bookingMessage(db, 'https://x', id, 'booking_ready')!.content).toContain(`connect 10.0.0.9:27018; password ${pw}`);
  });
});
