import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer, type ServerRow } from '../src/serverPool.js';
import { setSetting } from '../src/settings.js';
import { currentSeasonId } from '../src/players.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { Notifier } from '../src/notify/notify.js';
import {
  addPerson, cancelBooking, confirmBooking, createBooking, addCampaign, getBooking, holdBox, markSetup, respondPerson, sideRow,
  createTournamentBooking, setNext, markActive, recordPresence, beginRecovery, dropBox,
} from '../src/bookings/bookings.js';
import { BookingRunner, CLEAR_LINES, allowLines, bookingLines } from '../src/bookings/runner.js';
import { BookingVoice } from '../src/bookings/voice.js';
import { FakeTransport } from './fakes/fakeTransport.js';

const P = Array.from({ length: 10 }, (_, i) => `765611990000009${String(i).padStart(2, '0')}`);
const START = Date.parse('2026-10-02T20:00:00.000Z');
const MIN = 60_000;
const PUB = 'Rotoblin Pub VS';

let db: DB;
let now: number;
let sent: { server: string; cmds: string[] }[];
let box: Record<string, { type: string; plugin: boolean; map: string; humans: string[]; down: boolean; execs: number; failExec: number; marker: string; bookingPlugin: string; pug: string }>;
let released: number[];
let restarted: string[];
let dms: { to: string; content: string }[];
let preempts: number;
let runner: BookingRunner;

const status = (b: { map: string; humans: string[] }) => [
  'hostname: test', `map     : ${b.map} at: 0 x, 0 y, 0 z`, `players : ${b.humans.length} humans, 0 bots (31 max)`,
  '# userid name uniqueid connected ping loss state rate adr',
  ...b.humans.map((sid, i) => `#  ${i + 2} ${i + 1} "h${i}" ${steam2(sid)} 01:12 33 0 active 128000 10.0.0.${i}:27005`),
].join('\n');
/** SteamID64 -> STEAM_1:Y:Z, the form `status` prints. */
const steam2 = (sid: string) => { const n = BigInt(sid) - 76561197960265728n; return `STEAM_1:${n % 2n}:${n / 2n}`; };

/** The fake box: records each burst and answers like srcds would. */
const fakeRcon = async (server: ServerRow, cmds: string[]): Promise<string[]> => {
  const b = box[server.name];
  if (b.down) throw new Error('rcon connect timeout');
  sent.push({ server: server.name, cmds });
  return cmds.map((c) => {
    if (c === 'status') return status(b);
    if (c === 'sm_pug_status') return `STATUS ${b.pug} token=(none) campaign=(none) map=${b.map} stopAfterMap=(none)\nSTATUS end`;
    if (c === 'l4d_game_type_name') return `"l4d_game_type_name" = "${b.type}" ( def. "" )`;
    if (c === 'l4d_booking_version') return b.plugin ? '"l4d_booking_version" = "1.0.0" ( def. "1.0.0" )' : 'Unknown command "l4d_booking_version"';
    if (c === 'l4d_booking_id') return b.bookingPlugin >= '1.4.0' ? `"l4d_booking_id" = "${b.marker}" ( def. "" )` : 'Unknown command "l4d_booking_id"';
    const mk = /^l4d_booking_id "(\d*)"$/.exec(c);
    if (mk) b.marker = mk[1];
    if (c === 'exec pug_match') { b.execs++; if (b.failExec > 0) b.failExec--; else b.type = 'Rotoblin 4v4 PUG'; }
    const m = /^changelevel (\S+)$/.exec(c);
    if (m) b.map = m[1];
    return '';
  });
};

function build(over: Partial<ConstructorParameters<typeof BookingRunner>[0]> = {}) {
  return new BookingRunner({
    db,
    publicUrl: 'https://riversidepug.com',
    rcon: fakeRcon,
    release: async (id) => { released.push(id); db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(id); return true; },
    restart: async (server) => { restarted.push(server.name); box[server.name].type = PUB; box[server.name].map = 'l4d_vs_hospital01_apartment'; box[server.name].marker = ''; return true; },
    notifier: new Notifier({ db, dm: () => async (to, p) => { dms.push({ to, content: p.content ?? '' }); } }),
    preempt: () => { preempts++; },
    sleep: async () => {},
    now: () => now,
    ...over,
  });
}

beforeEach(() => {
  db = openDb(':memory:');
  now = START - 2 * 24 * 60 * MIN;
  sent = []; released = []; restarted = []; dms = []; preempts = 0; box = {};
  const ins = db.prepare("INSERT INTO players (steamid, name, status, discord_id) VALUES (?, ?, 'active', ?)");
  P.forEach((id, i) => ins.run(id, `p${i}`, `d${i}`));
  setSetting(db, 'competitive_enabled', 'everyone');
  setSetting(db, 'map_pool', JSON.stringify(['no_mercy', 'death_toll', 'dead_center']));
  setSetting(db, 'pug_reserve_servers', '1');
  for (const n of ['a', 'bb', 'ccc']) {
    const id = addServer(db, { name: n, host: '10.0.0.1', port: 27014 + n.length, rconPort: 1, rconPassword: 'x' });
    db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(id);
    box[n] = { type: PUB, plugin: true, map: 'l4d_vs_hospital01_apartment', humans: [], down: false, execs: 0, failExec: 0, marker: '', bookingPlugin: '1.4.0', pug: 'state=none match=0' };
  }
  runner = build();
});

/** The slot is estimated from the campaigns (no PUG history, so 60 each):
 *  one campaign is a 90 minute slot (until 21:30 UTC), two are 180 (23:00). */
const book = (o: { playlist?: string[]; confirm?: boolean } = {}) => {
  const r = createBooking(db, {
    by: P[0], opponent: { steamid: P[1] }, startsAt: new Date(START).toISOString(),
    playlist: o.playlist ?? ['no_mercy'], now: new Date(now),
  });
  if (!r.ok) throw new Error(r.error);
  if (o.confirm !== false) confirmBooking(db, { bookingId: r.value.id, by: P[1], now: new Date(now) });
  return r.value.id;
};

describe('allocation', () => {
  it('takes the highest-id idle box at the hold time, not before, and sets it up', async () => {
    const id = book();
    now = START - 16 * MIN;
    runner.allocate();
    expect(getBooking(db, id)!.state).toBe('scheduled');
    now = START - 15 * MIN;
    runner.allocate();
    await runner.idle();
    const b = getBooking(db, id)!;
    expect(b).toMatchObject({ state: 'ready', server_id: 3, setup_attempts: 1 });
    expect(restarted).toEqual(['ccc']);
    const cmds = sent.filter((s) => s.server === 'ccc').flatMap((s) => s.cmds);
    expect(cmds).toContain('exec pug_match');
    expect(cmds).toContain(`l4d_booking_password "${b.password}"`);
    expect(cmds).toContain(`l4d_booking_tv_password "${b.tv_password}"`);
    expect(cmds).toContain('changelevel l4d_vs_hospital01_apartment');
    expect(cmds.indexOf('exec pug_match')).toBeLessThan(cmds.indexOf('changelevel l4d_vs_hospital01_apartment'));
    // The connect line goes to the accepted people of both sides.
    expect(dms.filter((d) => d.content.includes(`password ${b.password}`)).map((d) => d.to).sort()).toEqual(['d0', 'd1']);
  });

  it('waits for an unconfirmed booking, and asks practice to give a box back when none is free', async () => {
    const unconfirmed = book({ confirm: false });
    now = START - 10 * MIN;
    runner.allocate();
    expect(getBooking(db, unconfirmed)!.state).toBe('scheduled');
    expect(preempts).toBe(0);
    const id = book();
    db.prepare("UPDATE servers SET status = 'live'").run();
    runner.allocate();
    expect(getBooking(db, id)!.state).toBe('scheduled');
    expect(preempts).toBe(1);
    db.prepare("UPDATE servers SET status = 'idle' WHERE id = 1").run();
    runner.allocate();
    await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ state: 'ready', server_id: 1 });
  });

  it('does not preempt practice or side games when idle boxes exist but none can load the playlist', () => {
    const id = book({ playlist: ['dead_center'] }); // needs dlc4; no box has it
    now = START - 15 * MIN;
    runner.allocate();
    expect(getBooking(db, id)!.state).toBe('scheduled');
    expect(preempts).toBe(0);
    db.prepare("UPDATE servers SET status = 'live'").run();
    runner.allocate();
    expect(preempts).toBe(1);
  });

  it('closes a confirmed booking that never got a box once the grace after its start is over', async () => {
    const events: AdminEvent[] = [];
    const unsubscribe = subscribeAdminEvents((e) => events.push(e));
    const id = book();
    db.prepare("UPDATE servers SET status = 'live'").run();
    now = START + 14 * MIN; // Casual Scrim grace is 15 minutes
    await runner.tick();
    expect(getBooking(db, id)!.state).toBe('scheduled');
    dms = [];
    now = START + 15 * MIN;
    await runner.tick();
    unsubscribe();
    const b = getBooking(db, id)!;
    expect(b).toMatchObject({ state: 'cancelled', end_reason: 'no_server' });
    expect(b.ended_at).not.toBeNull();
    expect(dms.filter((d) => d.content.includes('no server was free')).map((d) => d.to).sort()).toEqual(['d0', 'd1']);
    expect(events.some((e) => e.kind === 'problem' && e.text.includes(`Booking ${id} never got a server`))).toBe(true);
    expect(sideRow(db, id, 'a')!.no_show_at).toBeNull();
    expect(sideRow(db, id, 'b')!.no_show_at).toBeNull();
  });

  it('skips a box without the dlc4 mappack for an L4D2 campaign', () => {
    db.prepare('UPDATE servers SET has_dlc4 = 1 WHERE id = 1').run();
    const id = book({ playlist: ['dead_center'] });
    expect(runner.pickBox(getBooking(db, id)!)?.id).toBe(1);
  });

  it('alerts staff once when a confirmed booking is past its start with still no server', () => {
    const events: AdminEvent[] = [];
    const unsubscribe = subscribeAdminEvents((e) => events.push(e));
    const id = book();
    db.prepare("UPDATE servers SET status = 'live'").run();
    now = START + MIN;
    runner.allocate();
    runner.allocate();
    unsubscribe();
    const alerts = events.filter((e) => e.kind === 'problem' && e.text.includes(`Booking ${id} `));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      text: `Booking ${id} started at 20:00 UTC and still has no server: no idle box in its region can load its playlist, or every box is busy.`,
    });
  });
});

describe('setup failures', () => {
  it('retries once, then cancels as setup_failed, tells staff and both sides, and releases the box', async () => {
    const events: AdminEvent[] = [];
    const unsubscribe = subscribeAdminEvents((e) => events.push(e));
    box.ccc.plugin = false;
    const id = book();
    now = START - 15 * MIN;
    runner.allocate();
    await runner.idle();
    unsubscribe();
    const b = getBooking(db, id)!;
    expect(b).toMatchObject({ state: 'cancelled', end_reason: 'setup_failed', setup_attempts: 2 });
    expect(b.ended_at).not.toBeNull();
    expect(restarted).toEqual(['ccc', 'ccc']);
    expect(released).toEqual([3]);
    expect(events.some((e) => e.kind === 'problem' && /l4d_booking/.test(e.text))).toBe(true);
    expect(dms.filter((d) => /cancelled/.test(d.content)).map((d) => d.to).sort()).toEqual(['d0', 'd1']);
    expect(sideRow(db, id, 'a')!.no_show_at).toBeNull();
  });

  it('a setup_failed notice that fails to send does not block releasing the box', async () => {
    const broken = new Notifier({ db, dm: () => { throw new Error('boom'); } });
    const r = build({ notifier: broken });
    box.ccc.plugin = false;
    const id = book();
    now = START - 15 * MIN;
    r.allocate();
    await r.idle();
    const b = getBooking(db, id)!;
    expect(b).toMatchObject({ state: 'cancelled', end_reason: 'setup_failed' });
    expect(b.ended_at).not.toBeNull();
    expect(released).toEqual([3]);
  });

  it('a config that takes on the second try still makes the booking ready', async () => {
    box.ccc.failExec = 1;
    const id = book();
    now = START - 15 * MIN;
    runner.allocate();
    await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ state: 'ready', setup_attempts: 1 });
    expect(box.ccc.execs).toBe(2);
  });

  it('a cancel during setup stops it and winds the box down', async () => {
    const id = book();
    now = START - 15 * MIN;
    holdBox(db, id, 3, new Date(now));
    markSetup(db, id, new Date(now));
    cancelBooking(db, { bookingId: id, by: P[0], now: new Date(now) });
    runner.settle(id);
    await runner.idle();
    expect(getBooking(db, id)!.ended_at).not.toBeNull();
    expect(released).toEqual([3]);
  });
});

describe('resume after a web restart', () => {
  it('reruns setup for a held booking and winds down an ending one without a goodbye', async () => {
    const held = book();
    now = START - 15 * MIN;
    holdBox(db, held, 3, new Date(now));
    const ending = book();
    holdBox(db, ending, 2, new Date(now));
    cancelBooking(db, { bookingId: ending, by: P[0], now: new Date(now) });
    const fresh = build();
    fresh.resume();
    await fresh.idle();
    expect(getBooking(db, held)!.state).toBe('ready');
    expect(getBooking(db, ending)!.ended_at).not.toBeNull();
    expect(sent.filter((s) => s.server === 'bb').flatMap((s) => s.cmds).some((c) => c.startsWith('say '))).toBe(false);
  });

  it('does not spend a setup try on a web restart: a booking caught mid-setup gets a full retry', async () => {
    const id = book();
    now = START - 15 * MIN;
    holdBox(db, id, 3, new Date(now));
    markSetup(db, id, new Date(now));
    expect(getBooking(db, id)!.setup_attempts).toBe(1);
    box.ccc.plugin = false;
    const fresh = build();
    fresh.resume();
    await fresh.idle();
    const b = getBooking(db, id)!;
    expect(b).toMatchObject({ state: 'cancelled', end_reason: 'setup_failed', setup_attempts: 2 });
    expect(restarted).toEqual(['ccc', 'ccc']);
  });
});

describe('notices', () => {
  it('tells side b of the invite, side a of the confirm, an added person of their invite, everyone of a cancel', () => {
    const id = book({ confirm: false });
    runner.onCreated(id);
    expect(dms.map((d) => d.to)).toEqual(['d1']);
    confirmBooking(db, { bookingId: id, by: P[1], now: new Date(now) });
    runner.onConfirmed(id);
    expect(dms.map((d) => d.to)).toEqual(['d1', 'd0']);
    addPerson(db, { bookingId: id, by: P[0], side: 'a', steamid: P[5], role: 'ringer', now: new Date(now) });
    runner.onPersonAdded(id, P[5], P[0]);
    expect(dms.at(-1)!.to).toBe('d5');
    respondPerson(db, { bookingId: id, steamid: P[5], accept: true, now: new Date(now) });
    dms = [];
    cancelBooking(db, { bookingId: id, by: P[0], reason: 'sick', now: new Date(now) });
    runner.onCancelled(id, P[0], 'sick');
    expect(dms.map((d) => d.to).sort()).toEqual(['d1', 'd5']);
    expect(dms[0].content).toContain('sick');
  });

  it("a late cancel asks only the other side's managers to excuse it; their plain players get the plain notice", () => {
    const id = book();
    addPerson(db, { bookingId: id, by: P[0], side: 'a', steamid: P[5], role: 'ringer', now: new Date(now) });
    respondPerson(db, { bookingId: id, steamid: P[5], accept: true, now: new Date(now) });
    addPerson(db, { bookingId: id, by: P[1], side: 'b', steamid: P[6], role: 'ringer', now: new Date(now) });
    respondPerson(db, { bookingId: id, steamid: P[6], accept: true, now: new Date(now) });
    dms = [];
    cancelBooking(db, { bookingId: id, by: P[0], reason: 'sick', now: new Date(START - 60 * MIN) });
    runner.onCancelled(id, P[0], 'sick');
    const late = 'This is a late cancel. If it is fine with you, excuse it on the booking page so it does not count against them.';
    expect(dms.filter((d) => d.content.includes(late)).map((d) => d.to)).toEqual(['d1']);
    expect(dms.filter((d) => !d.content.includes(late)).map((d) => d.to).sort()).toEqual(['d5', 'd6']);
    expect(dms.every((d) => d.content.includes('sick'))).toBe(true);
  });

  it('an early cancel carries no late-cancel line', () => {
    const id = book();
    dms = [];
    cancelBooking(db, { bookingId: id, by: P[0], now: new Date(START - 5 * 60 * MIN) });
    runner.onCancelled(id, P[0], null);
    expect(dms.map((d) => d.to)).toEqual(['d1']);
    expect(dms[0].content).not.toContain('late cancel');
  });
});

describe('tick resilience', () => {
  it('a pass that throws is logged and the tick resolves rather than rejecting, and the ticking flag is still reset', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.exec('DROP TABLE bookings');
    await expect(runner.tick()).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    // The ticking flag was reset in finally: a second call is not silently
    // skipped as "already running" (openBookings still fails, so this also
    // proves it is not stuck true from the first call).
    const spy2 = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runner.tick()).resolves.toBeUndefined();
    expect(spy2).toHaveBeenCalled();
    spy2.mockRestore();
  });
});

describe('bookingLines', () => {
  it('keeps team names console-safe', () => {
    const id = book();
    db.prepare("UPDATE players SET name = 'a\"b;c ü' WHERE steamid = ?").run(P[0]);
    const lines = bookingLines(db, getBooking(db, id)!);
    expect(lines.find((l) => l.startsWith('l4d_booking_notice'))).toBe('l4d_booking_notice "Booked: abc ?\'s group vs p1\'s group until 21:30 UTC"');
  });
});

describe('the minute watch', () => {
  const ready = async () => {
    const id = book();
    now = START - 15 * MIN;
    runner.allocate();
    await runner.idle();
    sent = []; dms = [];
    return id;
  };

  it('reminds once at 60 and once at 15 minutes before the start', async () => {
    const id = book();
    now = START - 61 * MIN;
    await runner.tick();
    expect(dms).toEqual([]);
    now = START - 59 * MIN;
    await runner.tick();
    await runner.tick();
    expect(dms.filter((d) => /starts in 59 minutes/.test(d.content)).map((d) => d.to).sort()).toEqual(['d0', 'd1']);
    now = START - 15 * MIN;
    await runner.tick();
    await runner.idle();
    expect(dms.filter((d) => /starts in 15 minutes/.test(d.content))).toHaveLength(2);
    expect(getBooking(db, id)!.reminded_15_at).not.toBeNull();
  });

  it('records presence per side, turns active, and keeps the peak', async () => {
    const id = await ready();
    addPerson(db, { bookingId: id, by: P[0], side: 'a', steamid: P[2], role: 'player', now: new Date(now) });
    respondPerson(db, { bookingId: id, steamid: P[2], accept: true, now: new Date(now) });
    box.ccc.humans = [P[0], P[2], P[1], '76561199999999999'];
    now = START - 5 * MIN;
    await runner.tick();
    expect(getBooking(db, id)!.state).toBe('active');
    expect(sideRow(db, id, 'a')!.peak_present).toBe(2);
    expect(sideRow(db, id, 'b')!.peak_present).toBe(1);
    box.ccc.humans = [P[0]];
    now += MIN;
    await runner.tick();
    expect(sideRow(db, id, 'a')!.peak_present).toBe(2);
  });

  it('counts only players, not spectators, in present_now (plan T3b)', async () => {
    const id = await ready();
    addPerson(db, { bookingId: id, by: P[0], side: 'a', steamid: P[2], role: 'spectator', now: new Date(now) });
    respondPerson(db, { bookingId: id, steamid: P[2], accept: true, now: new Date(now) });
    box.ccc.humans = [P[0], P[2], P[1]];
    now = START - 5 * MIN;
    await runner.tick();
    expect(sideRow(db, id, 'a')).toMatchObject({ peak_present: 2, present_now: 1 });
    expect(sideRow(db, id, 'b')).toMatchObject({ peak_present: 1, present_now: 1 });
    box.ccc.humans = [P[2]];
    now += MIN;
    await runner.tick();
    expect(sideRow(db, id, 'a')).toMatchObject({ peak_present: 2, present_now: 0 });
  });

  it('ends an empty booking after the grace plus the idle time, with a goodbye, kick and release', async () => {
    const id = await ready();
    // Casual Scrim grace is 15 minutes, idle end 10: nobody ever came, so 25 minutes after the start.
    now = START + 24 * MIN;
    await runner.tick();
    expect(getBooking(db, id)!.ending_at).toBeNull();
    now = START + 25 * MIN;
    await runner.tick();
    await runner.idle();
    const b = getBooking(db, id)!;
    expect(b).toMatchObject({ state: 'ended', end_reason: 'idle' });
    expect(b.ended_at).not.toBeNull();
    const cmds = sent.flatMap((s) => s.cmds);
    expect(cmds).toContain('say [Booking] This booked server is closing: nobody was on it.');
    expect(cmds).toContain('sm_kick @humans "The booking is over. Thanks for playing."');
    expect(released).toEqual([3]);
  });

  it('a box people left late counts idle from the last human seen', async () => {
    const id = await ready();
    box.ccc.humans = [P[0]];
    now = START + 60 * MIN;
    await runner.tick();
    box.ccc.humans = [];
    now = START + 69 * MIN;
    await runner.tick();
    expect(getBooking(db, id)!.ending_at).toBeNull();
    now = START + 70 * MIN;
    await runner.tick();
    expect(getBooking(db, id)!.end_reason).toBe('idle');
  });

  // Ruling 4: one warning, about 10 minutes before the slot's end, in place
  // of the old 30, 10 and 5 minute ones.
  it('warns once, about 10 minutes before the slot ends, then an idle booking ends on time', async () => {
    const id = await ready();
    box.ccc.humans = [P[0]];
    const says = () => sent.flatMap((s) => s.cmds).filter((c) => c.includes('of the booked slot left'));
    now = START + 79 * MIN; await runner.tick();
    expect(says()).toEqual([]);
    now = START + 80 * MIN; await runner.tick();
    now = START + 81 * MIN; await runner.tick();
    now = START + 85 * MIN; await runner.tick();
    expect(says()).toEqual(['say [Booking] About 10 minutes of the booked slot left (until 21:30 UTC).']);
    expect(sent.flatMap((s) => s.cmds).some((c) => /About \d+ minutes left on this booking/.test(c))).toBe(false);
    now = START + 90 * MIN; await runner.tick();
    await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ state: 'ended', end_reason: 'time' });
  });

  it('makes no idle end while rcon is down, but still ends on time', async () => {
    const id = await ready();
    box.ccc.down = true;
    now = START + 60 * MIN;
    await runner.tick();
    expect(getBooking(db, id)!.ending_at).toBeNull();
    now = START + 89 * MIN;
    await runner.tick();
    expect(getBooking(db, id)!.ending_at).toBeNull();
    now = START + 90 * MIN;
    await runner.tick();
    await runner.idle();
    const b = getBooking(db, id)!;
    expect(b).toMatchObject({ state: 'ended', end_reason: 'time' });
    expect(b.ended_at).not.toBeNull();
    expect(released).toEqual([3]);
  });

  it('expires an unconfirmed invite and tells both sides', async () => {
    const id = book({ confirm: false });
    now = START - 29 * MIN;
    await runner.tick();
    expect(getBooking(db, id)).toMatchObject({ state: 'cancelled', end_reason: 'unconfirmed' });
    expect(dms.map((d) => d.to).sort()).toEqual(['d0', 'd1']);
  });
});

describe('fix wave (final review)', () => {
  const ready = async (r: BookingRunner = runner) => {
    const id = book();
    now = START - 15 * MIN;
    r.allocate();
    await r.idle();
    sent = []; dms = [];
    return id;
  };

  it('runs the freed hook after ended_at is written, so a waiting PUG sees the box', async () => {
    const seen: (string | null)[] = [];
    let id = 0;
    const r = build({ freed: () => { seen.push(getBooking(db, id)!.ended_at); } });
    id = await ready(r);
    cancelBooking(db, { bookingId: id, by: P[0], now: new Date(now) });
    r.settle(id);
    await r.idle();
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBeNull();
  });

  it('clears the booking cvars before the release, with or without a goodbye', async () => {
    const id = await ready();
    cancelBooking(db, { bookingId: id, by: P[0], now: new Date(now) });
    runner.settle(id);
    await runner.idle();
    const cmds = sent.flatMap((s) => s.cmds);
    for (const line of CLEAR_LINES) expect(cmds).toContain(line);
    // The scrim rules go back to PUG values too, so a skipped end restart cannot leak them into the next PUG.
    expect(CLEAR_LINES).toEqual([
      'l4d_booking_id ""',
      'l4d_booking_password ""', 'l4d_booking_tv_password ""', 'l4d_booking_notice ""',
      'sm_pug_pause_limit 3', 'sm_pug_pause_seconds 120', 'sm_pug_auto_min_players 8',
      // A tournament box turned the end kick off (T3b final review): a PUG after a skipped restart gets it back.
      'sm_pug_end_kick 1',
      // A tournament box turned on !sub, !admin and the staff freeze (plan T3c).
      'sm_pug_tournament 0',
    ]);
    expect(cmds.indexOf('l4d_booking_password ""')).toBeGreaterThan(cmds.indexOf('sm_kick @humans "The booking is over. Thanks for playing."'));

    // The resume path (no goodbye) still clears them.
    const other = book();
    holdBox(db, other, 2, new Date(now));
    cancelBooking(db, { bookingId: other, by: P[0], now: new Date(now) });
    sent = [];
    const fresh = build();
    fresh.resume();
    await fresh.idle();
    expect(sent.filter((x) => x.server === 'bb').flatMap((x) => x.cmds)).toEqual([...CLEAR_LINES]);
  });

  it('still releases when clearing the cvars fails', async () => {
    const id = await ready();
    box.ccc.down = true;
    cancelBooking(db, { bookingId: id, by: P[0], now: new Date(now) });
    runner.settle(id);
    await runner.idle();
    expect(released).toEqual([3]);
    expect(getBooking(db, id)!.ended_at).not.toBeNull();
  });

  it('a notice that throws never throws out of the runner', () => {
    const r = build({ notifier: { send: () => { throw new Error('boom'); } } as unknown as Notifier });
    const id = book({ confirm: false });
    expect(() => r.onCreated(id)).not.toThrow();
    expect(() => r.onCancelled(id, P[0], null)).not.toThrow();
  });

  it('onExtended re-sends the notice and says the new count and end on a running box', async () => {
    const id = await ready();
    expect(addCampaign(db, { bookingId: id, by: P[0], staff: true, now: new Date(now) }).ok).toBe(true);
    runner.onExtended(id);
    await new Promise((r) => setImmediate(r));
    const cmds = sent.flatMap((s) => s.cmds);
    // +1 campaign with none named: 60 + 10, up to 90 minutes, from 21:30.
    expect(cmds).toContain('say [Booking] +1 campaign: 2 left to play, 2 booked in all (until about 23:00 UTC).');
    expect(cmds.find((c) => c.startsWith('l4d_booking_notice'))).toContain('until 23:00 UTC');
  });

  it('onExtended does nothing for a booking with no box yet', () => {
    const id = book();
    runner.onExtended(id);
    expect(sent).toEqual([]);
  });

  it('a booking made 20 minutes ahead and confirmed is not expired, and gets its box', async () => {
    now = START - 20 * MIN;
    const id = book();
    now = START - 19 * MIN;
    await runner.tick();
    expect(getBooking(db, id)!.state).toBe('scheduled');
    now = START - 15 * MIN;
    await runner.tick();
    await runner.idle();
    expect(getBooking(db, id)!.state).toBe('ready');
  });
});

describe('booked games (plan 4b)', () => {
  const NEXT_DT = 'say [Booking] Next: Death Toll in about a minute. !nextmap to pick another, !stay to replay this one, !end to finish.';
  const CAPTAINS_DT = 'say [Booking] Death Toll: !nextmap, !stay, !end and !addcampaign are yours, captains.';
  /** Ruling 3: said when the finished-game count reaches games_allowed. */
  const CLOSE_1 = 'say [Booking] That was campaign 1 of 1. Type !addcampaign to play one more, or the server closes in 5 minutes.';
  const CLOSE_2 = 'say [Booking] That was campaign 2 of 2. Type !addcampaign to play one more, or the server closes in 5 minutes.';
  const cmds = () => sent.flatMap((s) => s.cmds);
  const flush = () => new Promise((r) => setImmediate(r));
  /** `YYYY-MM-DD HH:MM:SS`, as datetime('now') writes matches.ended_at. */
  const sqlTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

  const running = async (playlist: string[] = ['no_mercy', 'death_toll'], r: BookingRunner = runner) => {
    const id = book({ playlist });
    now = START - 15 * MIN;
    r.allocate();
    await r.idle();
    sent = []; dms = [];
    return id;
  };
  function insertGame(bookingId: number, o: { state: string; campaign?: string; token?: string; endedAt?: number }): number {
    return Number(db.prepare(
      `INSERT INTO matches (season_id, state, campaign, server_id, token, origin, kind, visibility, booking_id, booking_side_a, ended_at)
       VALUES (?, ?, ?, 3, ?, 'in_game', 'scrim', 'participants', ?, 'a', ?)`,
    ).run(currentSeasonId(db), o.state, o.campaign ?? 'no_mercy', o.token ?? `t${Math.random()}`, bookingId,
      o.endedAt === undefined ? null : sqlTime(o.endedAt)).lastInsertRowid);
  }
  const events = (id: number, event: string) =>
    db.prepare('SELECT detail FROM booking_events WHERE booking_id = ? AND event = ? ORDER BY rowid').all(id, event) as { detail: string }[];

  it('setup turns on auto-track with the min players setting and the ruleset pause rules, and no log lines without an address', async () => {
    await running(['no_mercy']);
    // `running` cleared `sent`; set up a second booking and look at its burst.
    const id = book();
    now = START - 15 * MIN;
    runner.allocate();
    await runner.idle();
    expect(getBooking(db, id)!.state).toBe('ready');
    const c = sent.filter((s) => s.server === 'bb').flatMap((s) => s.cmds);
    expect(c).toContain('sm_pug_auto_track 1');
    expect(c).toContain('sm_pug_auto_min_players 6');
    // Casual Scrim has no pause limits (null/null): 0 turns both off.
    expect(c).toContain('sm_pug_pause_limit 0');
    expect(c).toContain('sm_pug_pause_seconds 0');
    expect(c.indexOf('sm_pug_auto_track 1')).toBeGreaterThan(c.indexOf(`l4d_booking_password "${getBooking(db, id)!.password}"`));
    expect(c.some((x) => x.startsWith('logaddress_add') || x.startsWith('sm_pug_log_secret'))).toBe(false);
    // Tournament-only lines (T3b final review): a scrim keeps the plugin's own leave rules and end kick.
    expect(c.some((x) => x.startsWith('sm_pug_leave_budget') || x.startsWith('sm_pug_end_kick') || x.startsWith('sm_pug_tournament'))).toBe(false);
  });

  it('setup follows the booking_game_min_players setting', async () => {
    setSetting(db, 'booking_game_min_players', '4');
    const id = book();
    now = START - 15 * MIN;
    runner.allocate();
    await runner.idle();
    expect(getBooking(db, id)!.state).toBe('ready');
    expect(cmds()).toContain('sm_pug_auto_min_players 4');
  });

  it('setup sends logaddress_add and the log secret (as pushLogSecret does) in one burst when the box has a secret', async () => {
    const secret = 'ab'.repeat(16);
    db.prepare('UPDATE servers SET log_secret = ? WHERE id = 3').run(secret);
    const r = build({ logPublicAddress: '203.0.113.5:27500' });
    const id = book();
    now = START - 15 * MIN;
    r.allocate();
    await r.idle();
    expect(getBooking(db, id)!.state).toBe('ready');
    const burst = sent.find((s) => s.cmds.includes('logaddress_add 203.0.113.5:27500'))!;
    expect(burst).toBeDefined();
    const i = burst.cmds.indexOf('logaddress_add 203.0.113.5:27500');
    expect(burst.cmds.slice(i + 1, i + 4)).toEqual(['sv_rcon_log 0', `sm_pug_log_secret "${secret}"`, 'sv_rcon_log 1']);

    // A box with no secret gets the address only.
    db.prepare('UPDATE servers SET log_secret = NULL WHERE id = 2').run();
    sent = [];
    const other = book();
    now = START - 15 * MIN;
    r.allocate();
    await r.idle();
    expect(getBooking(db, other)!.server_id).toBe(2);
    const c = sent.flatMap((s) => s.cmds);
    expect(c).toContain('logaddress_add 203.0.113.5:27500');
    expect(c.some((x) => x.startsWith('sm_pug_log_secret'))).toBe(false);
  });

  it('the minute watch re-sends the booking and game lines', async () => {
    const id = await running();
    box.ccc.humans = [P[0]];
    now = START + 5 * MIN;
    await runner.tick();
    const c = cmds();
    expect(c).toContain('sm_pug_auto_track 1');
    expect(c).toContain(`l4d_booking_password "${getBooking(db, id)!.password}"`);
  });

  it('after a game the next campaign is announced, then loaded 60 s later with the captains line', async () => {
    const id = await running();
    box.ccc.humans = [P[0], P[1]];
    now = START + 89 * MIN;
    const game = insertGame(id, { state: 'completed', endedAt: now });
    runner.onGameEnded(game);
    await flush();
    expect(cmds()).toContain(NEXT_DT);
    expect(getBooking(db, id)).toMatchObject({ next_campaign: 'death_toll', next_at: new Date(now + MIN).toISOString() });
    expect(events(id, 'next_set')).toHaveLength(1);

    sent = [];
    now += 59_000;
    await runner.tick();
    await runner.idle();
    expect(cmds().some((c) => c.startsWith('changelevel'))).toBe(false);
    expect(getBooking(db, id)!.playlist_pos).toBe(0);

    now = START + 90 * MIN;
    await runner.tick();
    await runner.idle();
    expect(cmds().filter((c) => c.startsWith('changelevel'))).toEqual(['changelevel l4d_vs_smalltown01_caves']);
    expect(getBooking(db, id)).toMatchObject({ playlist_pos: 1, next_campaign: null, next_at: null });
    expect(cmds()).toContain(CAPTAINS_DT);
    // Ruling 4: time never cuts a live game, so there is no hint to extend.
    expect(cmds().some((c) => c.includes('usually takes'))).toBe(false);
    expect(JSON.parse(events(id, 'campaign_loaded')[0].detail)).toEqual({ campaign: 'death_toll', pos: 1 });

    // Loaded once: the next watch does not load it again.
    sent = [];
    now += MIN;
    await runner.tick();
    await runner.idle();
    expect(cmds().some((c) => c.startsWith('changelevel'))).toBe(false);
  });

  it('no extend hint at a campaign start, even with little of the slot left', async () => {
    const id = await running();
    box.ccc.humans = [P[0]];
    now = START + 150 * MIN; // 30 minutes left; Death Toll defaults to 60
    runner.onGameEnded(insertGame(id, { state: 'completed', endedAt: now }));
    now += MIN;
    await runner.tick();
    await runner.idle();
    expect(cmds()).toContain(CAPTAINS_DT);
    expect(cmds().some((c) => c.includes('this campaign usually takes'))).toBe(false);
  });

  it('a game ending on the last booked campaign says the close and schedules nothing', async () => {
    const id = await running(['no_mercy']);
    now = START + 60 * MIN;
    runner.onGameEnded(insertGame(id, { state: 'completed', endedAt: now }));
    await flush();
    expect(cmds()).toContain(CLOSE_1);
    expect(getBooking(db, id)).toMatchObject({ next_campaign: null, next_at: null, close_at: new Date(now + 5 * MIN).toISOString() });
  });

  it('closes after booking_close_grace_minutes and says so (plan T5 Ruling 2)', async () => {
    setSetting(db, 'booking_close_grace_minutes', '7');
    const id = await running(['no_mercy']);
    now = START + 60 * MIN;
    runner.onGameEnded(insertGame(id, { state: 'completed', endedAt: now }));
    await flush();
    expect(cmds()).toContain('say [Booking] That was campaign 1 of 1. Type !addcampaign to play one more, or the server closes in 7 minutes.');
    expect(getBooking(db, id)).toMatchObject({ next_campaign: null, close_at: new Date(now + 7 * MIN).toISOString() });
  });

  it('onGameEnded does nothing for a booking that is ending', async () => {
    const id = await running();
    const game = insertGame(id, { state: 'completed', endedAt: now });
    cancelBooking(db, { bookingId: id, by: P[0], now: new Date(now) });
    runner.onGameEnded(game);
    await flush();
    expect(cmds().some((c) => c.includes('Next:'))).toBe(false);
  });

  it('the next load waits for a live game to finish', async () => {
    const id = await running();
    box.ccc.humans = [P[0]];
    now = START + 30 * MIN;
    runner.onGameEnded(insertGame(id, { state: 'completed', endedAt: now }));
    insertGame(id, { state: 'live', campaign: 'no_mercy' });
    now += 2 * MIN;
    await runner.tick();
    await runner.idle();
    expect(cmds().some((c) => c.startsWith('changelevel'))).toBe(false);
    expect(getBooking(db, id)!.next_campaign).toBe('death_toll');
  });

  it('chooseNext resolves a campaign by prefix and loads it at once; refuses unknown names, a live game and non-captains', async () => {
    const id = await running();
    expect(runner.chooseNext(id, P[0], 'xyz')).toEqual({ ok: false, error: expect.stringContaining('xyz') });
    expect(runner.chooseNext(id, P[5], 'death')).toEqual({ ok: false, error: 'Only a captain or co-captain of that side can do that.' });
    const live = insertGame(id, { state: 'live' });
    expect(runner.chooseNext(id, P[0], 'death')).toEqual({ ok: false, error: 'Finish this game or use !end first.' });
    db.prepare("UPDATE matches SET state = 'completed' WHERE id = ?").run(live);
    sent = [];
    expect(runner.chooseNext(id, P[1], 'death')).toEqual({ ok: true, campaign: 'death_toll' });
    await runner.idle();
    expect(cmds().filter((c) => c.startsWith('changelevel'))).toEqual(['changelevel l4d_vs_smalltown01_caves']);
    expect(getBooking(db, id)).toMatchObject({ playlist_pos: 1, next_campaign: null });
    // The watch right after does not load it a second time.
    await runner.tick();
    await runner.idle();
    expect(cmds().filter((c) => c.startsWith('changelevel'))).toHaveLength(1);
  });

  it('chooseNext matches names and slugs case-insensitively, takes the next playlist campaign with no name, and lets staff through', async () => {
    const id = await running();
    expect(runner.chooseNext(id, P[0], 'NO MERCY')).toEqual({ ok: true, campaign: 'no_mercy' });
    await runner.idle();
    expect(runner.chooseNext(id, P[0], null)).toEqual({ ok: true, campaign: 'death_toll' });
    await runner.idle();
    expect(runner.chooseNext(id, P[9], 'no_mercy', true)).toEqual({ ok: true, campaign: 'no_mercy' });
    await runner.idle();
    // no_mercy is first on the playlist: picking it goes back to position 0.
    expect(getBooking(db, id)!.playlist_pos).toBe(0);
  });

  it('chooseNext refuses a campaign outside the pool or one this box cannot load', async () => {
    const id = await running();
    expect(runner.chooseNext(id, P[0], 'blood')).toMatchObject({ ok: false }); // Blood Harvest: not in the pool
    expect(runner.chooseNext(id, P[0], 'dead center')).toMatchObject({ ok: false, error: expect.stringContaining('cannot load') }); // dlc4
    expect(getBooking(db, id)!.next_campaign).toBeNull();
  });

  it('stay replays the campaign of the last game, or the current one with no game yet', async () => {
    const id = await running();
    expect(runner.stay(id, P[0])).toEqual({ ok: true, campaign: 'no_mercy' });
    await runner.idle();
    insertGame(id, { state: 'completed', campaign: 'death_toll', endedAt: now });
    sent = [];
    expect(runner.stay(id, P[1])).toEqual({ ok: true, campaign: 'death_toll' });
    await runner.idle();
    expect(cmds()).toContain('changelevel l4d_vs_smalltown01_caves');
    expect(getBooking(db, id)!.playlist_pos).toBe(1);
  });

  it('endFromGame aborts a live game, stops listening for it, sends sm_pug_abort, then ends and winds down', async () => {
    const unregistered: string[] = [];
    const r = build({ unregisterToken: (t) => { unregistered.push(t); } });
    const id = await running(['no_mercy'], r);
    const live = insertGame(id, { state: 'live', token: 'tok-live' });
    expect(r.endFromGame(id, P[5])).toEqual({ ok: false, error: 'Only a captain or co-captain of that side can do that.' });
    expect(db.prepare('SELECT state FROM matches WHERE id = ?').get(live)).toEqual({ state: 'live' });
    expect(r.endFromGame(id, P[1])).toEqual({ ok: true });
    await r.idle();
    expect(db.prepare('SELECT state, abort_cause FROM matches WHERE id = ?').get(live)).toEqual({ state: 'aborted', abort_cause: 'booking_ended' });
    expect(unregistered).toEqual(['tok-live']);
    const c = cmds();
    expect(c).toContain('sm_pug_abort tok-live');
    expect(c.indexOf('sm_pug_abort tok-live')).toBeLessThan(c.indexOf('say [Booking] This booked server is closing: a captain ended it.'));
    const b = getBooking(db, id)!;
    expect(b).toMatchObject({ state: 'ended', end_reason: 'captain' });
    expect(b.ended_at).not.toBeNull();
    expect(released).toEqual([3]);
  });

  it('endFromGame with no game live just ends; staff end as staff', async () => {
    const id = await running(['no_mercy']);
    expect(runner.endFromGame(id, P[9], true)).toEqual({ ok: true });
    await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ state: 'ended', end_reason: 'staff' });
    expect(cmds().some((c) => c.startsWith('sm_pug_abort'))).toBe(false);
  });

  // Plan 2 Ruling 5: the private review ask goes once per side when a scrim
  // closes as ended or no_show, guarded by a review_asked event.
  const ASK = 'Leave a quick private review on the booking page. Only staff see single reviews.';
  it('an ended scrim asks each side\'s managers once for a review, never again on a second settle', async () => {
    const id = await running(['no_mercy']);
    expect(runner.endFromGame(id, P[0])).toEqual({ ok: true });
    await runner.idle();
    const asks = dms.filter((d) => d.content.includes(ASK));
    expect(asks.map((d) => [d.to, d.content]).sort()).toEqual([
      ['d0', `How was p1's group? ${ASK}`],
      ['d1', `How was p0's group? ${ASK}`],
    ]);
    expect(events(id, 'review_asked')).toHaveLength(1);
    runner.settle(id);
    await runner.tick();
    await runner.idle();
    runner.settle(id);
    expect(dms.filter((d) => d.content.includes(ASK))).toHaveLength(2);
    expect(events(id, 'review_asked')).toHaveLength(1);
  });

  it('a no-show scrim asks too; a cancelled one and a tournament booking never do', async () => {
    const noShow = await running(['no_mercy']);
    db.prepare("UPDATE bookings SET state = 'no_show', end_reason = 'no_show', ending_at = ? WHERE id = ?").run(new Date(now).toISOString(), noShow);
    runner.onNoShow(noShow, 'b');
    await runner.idle();
    expect(dms.filter((d) => d.content.includes(ASK)).map((d) => d.to).sort()).toEqual(['d0', 'd1']);
    dms = [];
    const cancelled = book();
    cancelBooking(db, { bookingId: cancelled, by: P[0], now: new Date(now) });
    runner.onCancelled(cancelled, P[0], null);
    await runner.idle();
    expect(dms.some((d) => d.content.includes(ASK))).toBe(false);
    const tournament = book();
    db.prepare("UPDATE bookings SET purpose = 'tournament', state = 'ended', end_reason = 'staff', ending_at = ?, ended_at = ? WHERE id = ?")
      .run(new Date(now).toISOString(), new Date(now).toISOString(), tournament);
    runner.settle(tournament);
    expect(dms.some((d) => d.content.includes(ASK))).toBe(false);
    expect(events(tournament, 'review_asked')).toHaveLength(0);
  });

  it('everyone leaving after a finished game ends the booking: two empty watches, the game over 2 minutes ago', async () => {
    const id = await running();
    // Someone was on a minute ago, so the 4a idle end is far off.
    box.ccc.humans = [P[0]];
    now = START + 39 * MIN;
    await runner.tick();
    box.ccc.humans = [];
    now = START + 40 * MIN;
    insertGame(id, { state: 'completed', endedAt: now - 3 * MIN });
    await runner.tick();
    expect(getBooking(db, id)!.ending_at).toBeNull(); // one empty watch is not enough
    now += MIN;
    await runner.tick();
    await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ state: 'ended', end_reason: 'done' });
    expect(cmds()).toContain('say [Booking] This booked server is closing: everyone left.');
  });

  it('a map change between campaigns does not end the booking: empty watches within 2 minutes of the game end', async () => {
    const id = await running();
    box.ccc.humans = [P[0]];
    now = START + 39 * MIN;
    await runner.tick();
    box.ccc.humans = [];
    now = START + 40 * MIN;
    insertGame(id, { state: 'completed', endedAt: now - 30_000 });
    await runner.tick();
    now += MIN;
    await runner.tick();
    expect(getBooking(db, id)!.ending_at).toBeNull();
  });

  it('a human in between resets the empty count, and no game or a live game never ends it as done', async () => {
    const id = await running();
    box.ccc.humans = [P[0]];
    now = START + 39 * MIN;
    await runner.tick();
    now = START + 40 * MIN;
    insertGame(id, { state: 'completed', endedAt: now - 10 * MIN });
    box.ccc.humans = [];
    await runner.tick();
    box.ccc.humans = [P[0]];
    now += MIN; await runner.tick();
    box.ccc.humans = [];
    now += MIN; await runner.tick();
    expect(getBooking(db, id)!.ending_at).toBeNull();
    insertGame(id, { state: 'live' });
    now += MIN; await runner.tick();
    now += MIN; await runner.tick();
    expect(getBooking(db, id)!.ending_at).toBeNull();
  });

  it('with no finished game, empty watches leave it to the 4a idle end', async () => {
    const id = await running();
    box.ccc.humans = [P[0]];
    now = START + 39 * MIN;
    await runner.tick();
    box.ccc.humans = [];
    insertGame(id, { state: 'aborted', endedAt: now - 10 * MIN });
    for (let i = 1; i <= 9; i++) { now = START + (39 + i) * MIN; await runner.tick(); }
    expect(getBooking(db, id)!.ending_at).toBeNull();
    now = START + 49 * MIN;
    await runner.tick();
    expect(getBooking(db, id)!.end_reason).toBe('idle');
  });
  describe('fix round 1', () => {
    it('the first campaign gets the captains line once, when the booking goes active', async () => {
      const id = await running();
      box.ccc.humans = [P[0]];
      now = START + 140 * MIN; // 40 min left, No Mercy defaults to 60: still no extend hint
      await runner.tick();
      expect(getBooking(db, id)!.state).toBe('active');
      expect(cmds()).toContain('say [Booking] No Mercy: !nextmap, !stay, !end and !addcampaign are yours, captains.');
      expect(cmds().some((c) => c.includes('usually takes'))).toBe(false);
      sent = [];
      now += MIN;
      await runner.tick();
      expect(cmds().some((c) => c.includes('are yours, captains'))).toBe(false);
    });

    it('a campaign a captain loaded while the booking was ready is not announced again when it goes active', async () => {
      const id = await running();
      expect(getBooking(db, id)!.state).toBe('ready');
      expect(runner.chooseNext(id, P[0], 'death')).toEqual({ ok: true, campaign: 'death_toll' });
      await runner.idle();
      box.ccc.humans = [P[0]];
      now = START;
      await runner.tick();
      expect(getBooking(db, id)!.state).toBe('active');
      now += MIN;
      await runner.tick();
      expect(cmds().filter((c) => c.includes('are yours, captains'))).toEqual([CAPTAINS_DT]);
    });

    it('no extend hint at go-active when the campaign fits', async () => {
      await running();
      box.ccc.humans = [P[0]];
      now = START;
      await runner.tick();
      expect(cmds()).toContain('say [Booking] No Mercy: !nextmap, !stay, !end and !addcampaign are yours, captains.');
      expect(cmds().some((c) => c.includes('usually takes'))).toBe(false);
    });

    it('a failing re-push burst does not lose that minute\'s presence', async () => {
      const id = await running();
      const r = build({
        rcon: async (server, c) => {
          if (c.includes('sm_pug_auto_track 1')) throw new Error('rcon exec timeout: sm_pug_auto_track 1');
          return fakeRcon(server, c);
        },
      });
      box.ccc.humans = [P[0], P[1]];
      now = START + 5 * MIN;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await r.tick();
      warn.mockRestore();
      const b = getBooking(db, id)!;
      expect(b.state).toBe('active');
      expect(b.last_human_at).toBe(new Date(now).toISOString());
      expect(sideRow(db, id, 'a')!.peak_present).toBe(1);
    });

    it('a next campaign the box does not load is not announced; staff hear of it', async () => {
      const id = await running();
      const r = build({
        rcon: async (server, c) => fakeRcon(server, c.filter((x) => !x.startsWith('changelevel'))),
      });
      box.ccc.humans = [P[0]];
      now = START + 30 * MIN;
      r.onGameEnded(insertGame(id, { state: 'completed', endedAt: now }));
      const events: AdminEvent[] = [];
      const unsubscribe = subscribeAdminEvents((e) => events.push(e));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      now += MIN;
      await r.tick();
      await r.idle();
      unsubscribe();
      expect(warn.mock.calls.some((a) => String(a[0]).includes('l4d_vs_smalltown01_caves did not load'))).toBe(true);
      warn.mockRestore();
      expect(cmds()).not.toContain(CAPTAINS_DT);
      expect(events.some((e) => e.kind === 'problem' && e.text.includes(`Booking ${id}`) && e.text.includes('l4d_vs_smalltown01_caves'))).toBe(true);
    });

    it('a failing burst that carries the log secret is reported with the secret redacted', async () => {
      const secret = 'cd'.repeat(16);
      db.prepare('UPDATE servers SET log_secret = ?').run(secret);
      const r = build({
        logPublicAddress: '203.0.113.5:27500',
        rcon: async (server, c) => {
          const line = c.find((x) => x.startsWith('sm_pug_log_secret'));
          if (line) throw new Error(`rcon exec timeout: ${line}`);
          return fakeRcon(server, c);
        },
      });
      const events: AdminEvent[] = [];
      const unsubscribe = subscribeAdminEvents((e) => events.push(e));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Setup: the burst fails twice, the booking is cancelled, staff are told why.
      const id = book();
      now = START - 15 * MIN;
      r.allocate();
      await r.idle();
      unsubscribe();
      expect(getBooking(db, id)).toMatchObject({ state: 'cancelled', end_reason: 'setup_failed' });
      const feed = events.flatMap((e) => (e.kind === 'problem' ? [e.text] : []));
      const problem = feed.find((t) => t.includes(`Booking ${id} could not be set up`))!;
      expect(problem).toContain('<redacted>');
      const texts = [...feed, ...warn.mock.calls.map((a) => a.map(String).join(' '))];
      expect(texts.some((t) => t.includes('<redacted>'))).toBe(true);
      expect(texts.some((t) => t.includes(secret))).toBe(false);
      warn.mockRestore();
    });

    it('the minute watch re-push carries no log secret, and its failure is still logged without one', async () => {
      const id = await running();
      const secret = 'ef'.repeat(16);
      db.prepare('UPDATE servers SET log_secret = ? WHERE id = 3').run(secret);
      const bursts: string[][] = [];
      const r = build({
        logPublicAddress: '203.0.113.5:27500',
        rcon: async (server, c) => {
          bursts.push(c);
          if (c.some((x) => x.startsWith('logaddress_add'))) throw new Error(`rcon exec timeout: ${c.join('; ')}`);
          return fakeRcon(server, c);
        },
      });
      box.ccc.humans = [P[0]];
      now = START + 5 * MIN;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await r.tick();
      const logged = warn.mock.calls.map((a) => a.map(String).join(' '));
      warn.mockRestore();
      expect(getBooking(db, id)!.state).toBe('active');
      expect(bursts.some((c) => c.includes('logaddress_add 203.0.113.5:27500'))).toBe(true);
      expect(bursts.flat().some((x) => x.includes(secret))).toBe(false);
      expect(logged.some((t) => t.includes('re-pushing the booking lines'))).toBe(true);
      expect(logged.some((t) => t.includes(secret))).toBe(false);
    });
  });

  // Task 6: the plugin's signed PUGBOOK line reaches here as
  // runner.onCommand(serverId, steamid, cmd, arg). The plugin's own captains
  // cvar (gameLines, tested above) is only a courtesy: onCommand re-checks
  // rights against the booking actually on the box right now.
  describe('onCommand (Task 6: the plugin\'s PUGBOOK line)', () => {
    it('schedules and loads the next campaign for a captain, with no arg', async () => {
      const id = await running();
      runner.onCommand(3, P[0], 'nextmap', '');
      await runner.idle();
      expect(getBooking(db, id)).toMatchObject({ playlist_pos: 1, next_campaign: null });
      expect(cmds().filter((c) => c.startsWith('changelevel'))).toEqual(['changelevel l4d_vs_smalltown01_caves']);
      expect(cmds()).toContain(CAPTAINS_DT);
    });

    it('passes a named campaign through to chooseNext as `arg`', async () => {
      const id = await running();
      runner.onCommand(3, P[1], 'nextmap', 'death');
      await runner.idle();
      expect(getBooking(db, id)).toMatchObject({ playlist_pos: 1, next_campaign: null });
      expect(cmds()).toContain(CAPTAINS_DT);
    });

    it('does nothing, and sends nothing, for a non-captain, and logs one line naming the server, steamid and cmd', async () => {
      const id = await running();
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      runner.onCommand(3, P[5], 'nextmap', '');
      await runner.idle();
      // mockRestore() also clears mock.calls, so read it before restoring.
      const lines = log.mock.calls.map((a) => a.map(String).join(' '));
      log.mockRestore();
      expect(getBooking(db, id)!.playlist_pos).toBe(0);
      expect(cmds()).toEqual([]);
      expect(lines.some((l) => l.includes('server 3') && l.includes(P[5]) && l.includes('cmd nextmap'))).toBe(true);
    });

    it('does nothing on a box with no booking, and logs one line naming the server, steamid and cmd', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(() => runner.onCommand(1, P[0], 'stay', '')).not.toThrow();
      const lines = log.mock.calls.map((a) => a.map(String).join(' '));
      log.mockRestore();
      expect(cmds()).toEqual([]);
      expect(lines.some((l) => l.includes('server 1') && l.includes(P[0]) && l.includes('cmd stay'))).toBe(true);
    });

    it('does nothing once the booking has started ending', async () => {
      const id = await running();
      runner.endFromGame(id, P[0]);
      await runner.idle();
      expect(getBooking(db, id)!.state).toBe('ended');
      sent = [];
      runner.onCommand(3, P[0], 'stay', '');
      await runner.idle();
      expect(cmds()).toEqual([]);
    });

    it('does nothing while the wind-down is still running (ending_at set, ended_at still null)', async () => {
      // A release that never resolves pins windDown just past the goodbye and
      // CLEAR_LINES bursts, in the exact window the booking row sits in
      // (ending_at set, ended_at still null, state already the terminal one):
      // the hold (open_server_holds) is still open through ended_at IS NULL,
      // so onCommand must refuse on ending_at, not on the hold being gone.
      const r = build({ release: () => new Promise<boolean>(() => {}) });
      const id = await running(['no_mercy'], r);
      r.endFromGame(id, P[0]);
      await flush();
      const mid = getBooking(db, id)!;
      expect(mid.ending_at).not.toBeNull();
      expect(mid.ended_at).toBeNull();
      expect(mid.state).toBe('ended');
      sent = [];
      r.onCommand(3, P[0], 'stay', '');
      await flush();
      expect(cmds()).toEqual([]);
      expect(getBooking(db, id)!.playlist_pos).toBe(0);
    });

    it('!extend is +1 campaign with none named, and says the new count and end on the box', async () => {
      const id = await running();
      const before = getBooking(db, id)!.ends_at;
      runner.onCommand(3, P[1], 'extend', 'death');
      await flush();
      const b = getBooking(db, id)!;
      expect(Date.parse(b.ends_at)).toBe(Date.parse(before) + 90 * MIN);
      expect(b.games_allowed).toBe(3);
      // !extend takes no campaign: an arg is ignored.
      expect(JSON.parse(b.playlist_json)).toEqual(['no_mercy', 'death_toll']);
      expect(cmds()).toContain('say [Booking] +1 campaign: 3 left to play, 3 booked in all (until about 00:30 UTC).');
    });

    it('!addcampaign with a campaign name appends it to the playlist; with none it adds a campaign to pick later', async () => {
      const id = await running(['no_mercy']);
      runner.onCommand(3, P[0], 'addcampaign', 'death');
      await flush();
      let b = getBooking(db, id)!;
      expect(JSON.parse(b.playlist_json)).toEqual(['no_mercy', 'death_toll']);
      expect(b.games_allowed).toBe(2);
      // Death Toll has no history: 60 + 10, up to 90, from 21:30.
      expect(b.ends_at).toBe(new Date(START + 180 * MIN).toISOString());
      expect(cmds()).toContain('say [Booking] +1 campaign: 2 left to play, 2 booked in all (until about 23:00 UTC).');
      runner.onCommand(3, P[1], 'addcampaign', '');
      await flush();
      b = getBooking(db, id)!;
      expect(JSON.parse(b.playlist_json)).toEqual(['no_mercy', 'death_toll']);
      expect(b.games_allowed).toBe(3);
      expect(events(id, 'campaign_added').map((e) => JSON.parse(e.detail).campaign)).toEqual(['death_toll', null]);
    });

    it('!addcampaign with a name matching no pool campaign is refused on the box and adds nothing', async () => {
      const id = await running(['no_mercy']);
      runner.onCommand(3, P[0], 'addcampaign', 'xyz');
      await flush();
      expect(cmds()).toContain('say [Booking] No campaign in the map pool matches xyz.');
      expect(getBooking(db, id)!.games_allowed).toBe(1);
      expect(events(id, 'campaign_added')).toHaveLength(0);
    });

    it('a refused +1 campaign is said on the box', async () => {
      const id = await running(['no_mercy']); // 20:00 to 21:30
      // Two more bookings from 21:30 fill the two bookable boxes (one is reserved for PUGs).
      for (const [a, b] of [[2, 3], [4, 5]]) {
        const r = createBooking(db, { by: P[a], opponent: { steamid: P[b] }, startsAt: new Date(START + 90 * MIN).toISOString(), playlist: ['no_mercy'], now: new Date(now) });
        expect(r.ok).toBe(true);
      }
      runner.onCommand(3, P[0], 'addcampaign', '');
      await flush();
      expect(cmds()).toContain('say [Booking] No server is free for another campaign after this slot.');
      expect(getBooking(db, id)!.games_allowed).toBe(1);
    });

    it('ends the booking', async () => {
      const id = await running(['no_mercy']);
      runner.onCommand(3, P[1], 'end', '');
      await runner.idle();
      expect(getBooking(db, id)).toMatchObject({ state: 'ended', end_reason: 'captain' });
      expect(released).toEqual([3]);
    });

    it('a refusal from the method it calls is said on the box as [Booking] <reason>', async () => {
      const id = await running();
      runner.onCommand(3, P[0], 'nextmap', 'xyz');
      await flush();
      // consoleText strips the quotes around the campaign name.
      expect(cmds()).toContain('say [Booking] No campaign in the map pool matches xyz.');
      expect(getBooking(db, id)!.next_campaign).toBeNull();
    });

  });

  // Bookings by campaign, Task 2: a booking is N campaigns. The runner
  // counts finished games, closes 5 minutes after the Nth, and the slot's
  // end never cuts a live game.
  describe('by campaign', () => {
    const finish = (id: number, campaign = 'no_mercy') => {
      const game = insertGame(id, { state: 'completed', campaign, endedAt: now });
      runner.onGameEnded(game);
      return game;
    };
    const closeAt = (id: number) => getBooking(db, id)!.close_at;

    it('two finished games of two: the close line, then the close 5 minutes later', async () => {
      const id = await running();
      box.ccc.humans = [P[0], P[1]];
      now = START + 60 * MIN;
      finish(id);
      await flush();
      expect(cmds()).toContain(NEXT_DT);
      expect(closeAt(id)).toBeNull();
      now = START + 150 * MIN;
      finish(id, 'death_toll');
      await flush();
      expect(cmds()).toContain(CLOSE_2);
      expect(cmds().filter((c) => c.startsWith('say [Booking] Next:'))).toHaveLength(1);
      // The grace lives in close_at only: ending_at stays null, so +1 campaign still works.
      expect(getBooking(db, id)).toMatchObject({ close_at: new Date(now + 5 * MIN).toISOString(), ending_at: null, next_campaign: null });
      now = START + 154 * MIN;
      await runner.tick();
      await runner.idle();
      expect(getBooking(db, id)!.ending_at).toBeNull();
      now = START + 155 * MIN;
      await runner.tick();
      await runner.idle();
      const b = getBooking(db, id)!;
      expect(b).toMatchObject({ state: 'ended', end_reason: 'done' });
      expect(b.ended_at).not.toBeNull();
      expect(cmds()).toContain('say [Booking] This booked server is closing: every booked campaign is played.');
      expect(released).toEqual([3]);
    });

    it('an aborted game does not count', async () => {
      const id = await running();
      box.ccc.humans = [P[0]];
      now = START + 60 * MIN;
      insertGame(id, { state: 'aborted', endedAt: now - 30 * MIN });
      finish(id);
      await flush();
      expect(cmds()).toContain(NEXT_DT);
      expect(cmds()).not.toContain(CLOSE_2);
      expect(closeAt(id)).toBeNull();
    });

    it('a !stay replay and an off-playlist campaign each count as one of the N', async () => {
      const id = await running();
      box.ccc.humans = [P[0]];
      now = START + 60 * MIN;
      finish(id, 'no_mercy');
      now = START + 120 * MIN;
      finish(id, 'dead_air');
      await flush();
      expect(cmds()).toContain(CLOSE_2);
      expect(closeAt(id)).toBe(new Date(now + 5 * MIN).toISOString());
    });

    it('the next campaign goes by the count, and replays the last one when the playlist is shorter than the count', async () => {
      const id = await running(['no_mercy']);
      // +1 campaign with none named: 2 allowed, the playlist still 1 long.
      expect(addCampaign(db, { bookingId: id, by: P[0], now: new Date(now) }).ok).toBe(true);
      box.ccc.humans = [P[0]];
      now = START + 60 * MIN;
      finish(id);
      await flush();
      expect(cmds()).toContain('say [Booking] Next: No Mercy in about a minute. !nextmap to pick another, !stay to replay this one, !end to finish.');
      expect(getBooking(db, id)!.next_campaign).toBe('no_mercy');
    });

    it('a captain\'s +1 campaign during the grace succeeds and cancels the close, once', async () => {
      const id = await running(['no_mercy']); // 20:00 to 21:30
      box.ccc.humans = [P[0], P[1]];
      now = START + 60 * MIN;
      finish(id);
      await flush();
      expect(cmds()).toContain(CLOSE_1);
      expect(closeAt(id)).not.toBeNull();
      now = START + 62 * MIN;
      // The model call itself, as a captain (not staff), inside the grace.
      expect(addCampaign(db, { bookingId: id, by: P[1], now: new Date(now) })).toMatchObject({ ok: true, value: { gamesAllowed: 2 } });
      expect(closeAt(id)).toBeNull();
      // And in game: !addcampaign from the other captain adds another.
      sent = [];
      runner.onCommand(3, P[0], 'addcampaign', 'death');
      await flush();
      expect(getBooking(db, id)).toMatchObject({ games_allowed: 3, close_at: null, ending_at: null });
      expect(cmds()).toContain('say [Booking] +1 campaign: 2 left to play, 3 booked in all (until about 00:30 UTC).');
      // The box sat on a finished campaign: the next one by the count (the
      // named one, second on the playlist now) is announced and loaded.
      expect(getBooking(db, id)!.next_campaign).toBe('death_toll');
      expect(cmds()).toContain(NEXT_DT);
      // Past the old close: still open.
      now = START + 66 * MIN;
      await runner.tick();
      await runner.idle();
      expect(getBooking(db, id)!.ending_at).toBeNull();
      expect(cmds()).toContain('changelevel l4d_vs_smalltown01_caves');
      // Played to the new count: one close line, one close.
      now = START + 150 * MIN;
      finish(id, 'death_toll');
      now = START + 200 * MIN;
      finish(id);
      await flush();
      expect(cmds().filter((c) => c.startsWith('say [Booking] That was campaign 3 of 3.'))).toHaveLength(1);
      now = START + 205 * MIN;
      await runner.tick();
      await runner.idle();
      expect(getBooking(db, id)).toMatchObject({ state: 'ended', end_reason: 'done' });
      expect(events(id, 'ended')).toHaveLength(1);
    });

    it('a game finishing after the close has fired reopens nothing', async () => {
      const id = await running(['no_mercy']);
      box.ccc.humans = [P[0]];
      now = START + 60 * MIN;
      finish(id);
      now = START + 65 * MIN;
      await runner.tick();
      await runner.idle();
      const ended = getBooking(db, id)!;
      expect(ended).toMatchObject({ state: 'ended', end_reason: 'done' });
      sent = [];
      now = START + 66 * MIN;
      finish(id);
      await flush();
      expect(cmds()).toEqual([]);
      expect(getBooking(db, id)).toEqual(ended);
      expect(addCampaign(db, { bookingId: id, by: P[0], now: new Date(now) })).toEqual({ ok: false, error: 'wrong_state' });
    });

    it('!stay and !nextmap are refused after N of N', async () => {
      const id = await running();
      box.ccc.humans = [P[0]];
      now = START + 60 * MIN;
      finish(id);
      now = START + 120 * MIN;
      finish(id, 'death_toll');
      await flush();
      sent = [];
      const refused = { ok: false, error: 'All 2 campaigns are played. !addcampaign for one more.' };
      expect(runner.stay(id, P[0])).toEqual(refused);
      expect(runner.chooseNext(id, P[1], 'death')).toEqual(refused);
      runner.onCommand(3, P[0], 'nextmap', '');
      runner.onCommand(3, P[1], 'stay', '');
      await flush();
      expect(cmds()).toEqual([
        'say [Booking] All 2 campaigns are played. !addcampaign for one more.',
        'say [Booking] All 2 campaigns are played. !addcampaign for one more.',
      ]);
      expect(getBooking(db, id)!.next_campaign).toBeNull();
      // One more added: allowed again.
      expect(addCampaign(db, { bookingId: id, by: P[0], now: new Date(now) }).ok).toBe(true);
      expect(runner.stay(id, P[0])).toEqual({ ok: true, campaign: 'death_toll' });
    });

    it('a live game at the slot end keeps the booking open; it ends after the game', async () => {
      const id = await running(); // 20:00 to 23:00, 2 campaigns
      box.ccc.humans = [P[0], P[1]];
      now = START + 100 * MIN;
      const live = insertGame(id, { state: 'live' });
      now = START + 180 * MIN;
      await runner.tick();
      await runner.idle();
      now = START + 200 * MIN;
      await runner.tick();
      await runner.idle();
      expect(getBooking(db, id)!.ending_at).toBeNull();
      expect(db.prepare('SELECT state FROM matches WHERE id = ?').get(live)).toEqual({ state: 'live' });
      // The first of two games finishes past the slot: no next campaign is announced, and the booking ends.
      db.prepare("UPDATE matches SET state = 'completed', ended_at = ? WHERE id = ?").run(sqlTime(now), live);
      sent = [];
      runner.onGameEnded(live);
      await flush();
      expect(cmds().some((c) => c.startsWith('say [Booking] Next:'))).toBe(false);
      now += MIN;
      await runner.tick();
      await runner.idle();
      expect(getBooking(db, id)).toMatchObject({ state: 'ended', end_reason: 'time' });
      expect(cmds()).toContain('say [Booking] This booked server is closing: its time is up.');
    });

    it('the Nth game finishing past the slot end still gets the 5 minute grace', async () => {
      const id = await running(['no_mercy']); // 20:00 to 21:30
      box.ccc.humans = [P[0], P[1]];
      const live = insertGame(id, { state: 'live' });
      now = START + 100 * MIN;
      await runner.tick();
      expect(getBooking(db, id)!.ending_at).toBeNull();
      db.prepare("UPDATE matches SET state = 'completed', ended_at = ? WHERE id = ?").run(sqlTime(now), live);
      runner.onGameEnded(live);
      await flush();
      expect(cmds()).toContain(CLOSE_1);
      now = START + 104 * MIN;
      await runner.tick();
      await runner.idle();
      expect(getBooking(db, id)!.ending_at).toBeNull();
      now = START + 105 * MIN;
      await runner.tick();
      await runner.idle();
      expect(getBooking(db, id)).toMatchObject({ state: 'ended', end_reason: 'done' });
    });

    it('a +1 made while an earlier booking is being watched is not undone by a stale close', async () => {
      // The tick lists open bookings once, then awaits each watch in turn: a
      // +1 on the second booking made during the first one's rcon must not be
      // undone by the second watch reading its grace from the old list.
      let hook: (() => void) | null = null;
      runner = build({
        rcon: async (server, c) => {
          if (hook && c.includes('status')) { const h = hook; hook = null; h(); }
          return fakeRcon(server, c);
        },
      });
      const first = await running(['no_mercy']);
      const second = await running(['no_mercy']);
      for (const n of ['a', 'bb', 'ccc']) box[n].humans = [P[0], P[1]];
      now = START + 60 * MIN;
      finish(second);
      await flush();
      expect(closeAt(second)).not.toBeNull();
      expect(closeAt(first)).toBeNull();
      now = START + 66 * MIN;
      hook = () => { expect(addCampaign(db, { bookingId: second, by: P[1], now: new Date(now) }).ok).toBe(true); };
      await runner.tick();
      await runner.idle();
      expect(hook).toBeNull();
      expect(getBooking(db, second)).toMatchObject({ ending_at: null, games_allowed: 2, close_at: null });
    });

    it('a game started during the grace is not cut by the close', async () => {
      const id = await running(['no_mercy']);
      box.ccc.humans = [P[0], P[1]];
      now = START + 60 * MIN;
      finish(id);
      const live = insertGame(id, { state: 'live' });
      now = START + 70 * MIN;
      await runner.tick();
      await runner.idle();
      expect(getBooking(db, id)!.ending_at).toBeNull();
      expect(db.prepare('SELECT state FROM matches WHERE id = ?').get(live)).toEqual({ state: 'live' });
    });

    it('an idle booking past the slot end still ends, even with rcon down', async () => {
      const id = await running();
      box.ccc.down = true;
      now = START + 180 * MIN;
      await runner.tick();
      await runner.idle();
      expect(getBooking(db, id)).toMatchObject({ state: 'ended', end_reason: 'time' });
    });

    it('the 10 minute warning is said only between games, never during the grace', async () => {
      const id = await running(); // until 23:00
      box.ccc.humans = [P[0], P[1]];
      const says = () => cmds().filter((c) => c.includes('of the booked slot left'));
      const live = insertGame(id, { state: 'live' });
      now = START + 170 * MIN;
      await runner.tick();
      now = START + 171 * MIN;
      await runner.tick();
      expect(says()).toEqual([]);
      db.prepare("UPDATE matches SET state = 'completed', ended_at = ? WHERE id = ?").run(sqlTime(now), live);
      runner.onGameEnded(live);
      now = START + 172 * MIN;
      await runner.tick();
      await runner.idle();
      expect(says()).toEqual(['say [Booking] About 8 minutes of the booked slot left (until 23:00 UTC).']);

    });

    it('no 10 minute warning during the closing grace: the close line says it all', async () => {
      const id = await running(['no_mercy']); // until 21:30
      box.ccc.humans = [P[0]];
      now = START + 78 * MIN;
      finish(id);
      now = START + 81 * MIN;
      await runner.tick();
      await runner.idle();
      expect(cmds()).toContain(CLOSE_1);
      expect(cmds().filter((c) => c.includes('of the booked slot left'))).toEqual([]);
      expect(getBooking(db, id)!.ending_at).toBeNull();
    });
  });

  describe('the allowlist (plan 4b2)', () => {
    const STAFF = Array.from({ length: 12 }, (_, i) => `765611991100000${String(i).padStart(2, '0')}`);
    const addStaff = () => {
      const ins = db.prepare("INSERT INTO players (steamid, name, status, is_admin) VALUES (?, ?, 'active', 1)");
      STAFF.forEach((id, i) => ins.run(id, `staff${i}`));
    };
    /** The allowlist lines of one burst, in the order sent. */
    const allowPart = (burst: string[]) => burst.filter((c) => /^(sm_booking_allow_|l4d_booking_grace |l4d_booking_block )/.test(c));
    const expectList = (burst: string[], ids: string[], grace = 60, block = 30) => {
      const sorted = [...ids].sort();
      const chunks: string[] = [];
      for (let i = 0; i < sorted.length; i += 10) chunks.push(`sm_booking_allow_add ${sorted.slice(i, i + 10).join(' ')}`);
      expect(allowPart(burst)).toEqual(['sm_booking_allow_begin', ...chunks, 'sm_booking_allow_commit', `l4d_booking_grace ${grace}`, `l4d_booking_block ${block}`]);
    };

    it('allowLines chunks the list at 10 ids a line between begin and commit, then the grace and block settings', () => {
      addStaff();
      const id = book();
      setSetting(db, 'booking_allow_grace_seconds', '90');
      setSetting(db, 'booking_allow_block_minutes', '0');
      const lines = allowLines(db, getBooking(db, id)!);
      expect(lines).toHaveLength(6);
      expect(lines[1].split(' ')).toHaveLength(11);
      expect(lines[2].split(' ')).toHaveLength(5);
      expectList(lines, [P[0], P[1], ...STAFF], 90, 0);
    });

    it('setup pushes the whole list, and so does every minute watch', async () => {
      addStaff();
      const id = book();
      now = START - 15 * MIN;
      runner.allocate();
      await runner.idle();
      expect(getBooking(db, id)!.state).toBe('ready');
      // The setup burst before the changelevel, and the one after it.
      const setupBursts = sent.filter((s) => s.cmds.includes('sm_booking_allow_begin'));
      expect(setupBursts).toHaveLength(2);
      for (const burst of setupBursts) expectList(burst.cmds, [P[0], P[1], ...STAFF]);
      sent = [];
      box.ccc.humans = [P[0]];
      now = START + 5 * MIN;
      await runner.tick();
      const minute = sent.filter((s) => s.cmds.includes('sm_booking_allow_begin'));
      expect(minute).toHaveLength(1);
      expectList(minute[0].cmds, [P[0], P[1], ...STAFF]);
    });

    it("a captain's !allow adds the ringer, re-pushes the list at once and says so", async () => {
      const id = await running();
      const ringer = '76561199222222222';
      runner.onCommand(3, P[1], 'allow', `${ringer} Some Name`);
      await flush();
      expect(db.prepare('SELECT side, role, status, added_by FROM booking_people WHERE booking_id = ? AND steamid = ?').get(id, ringer))
        .toEqual({ side: 'b', role: 'ringer', status: 'accepted', added_by: P[1] });
      const c = cmds();
      expectList(c, [P[0], P[1], ringer]);
      expect(c.at(-1)).toBe("say [Booking] Some Name is in, as a ringer for p1's group.");
    });

    it('!allow log lines name the booking and the outcome, never a steamid', async () => {
      const id = await running();
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      runner.onCommand(3, P[1], 'allow', '76561199222222222 Some Name');
      runner.onCommand(3, P[1], 'allow', '123 bad');
      runner.onCommand(3, P[5], 'allow', '76561199222222223 x');
      runner.onCommand(1, P[0], 'allow', '76561199222222224 x');
      await flush();
      const lines = log.mock.calls.map((a) => a.map(String).join(' '));
      log.mockRestore();
      expect(lines.some((l) => l.includes(`${id}: !allow added`))).toBe(true);
      expect(lines.some((l) => l.includes(`${id}: !allow refused (not_player)`))).toBe(true);
      expect(lines).toHaveLength(4);
      expect(lines.some((l) => /\d{17}/.test(l))).toBe(false);
    });

    it('a setup failure on an allowlist line hides the ids in the console and the admin feed', async () => {
      const events: AdminEvent[] = [];
      const unsubscribe = subscribeAdminEvents((e) => events.push(e));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const failing = build({
        rcon: async (server, c) => {
          const add = c.find((x) => x.startsWith('sm_booking_allow_add'));
          if (add) throw new Error(`rcon exec timeout: ${add}`);
          return fakeRcon(server, c);
        },
      });
      const id = book();
      now = START - 15 * MIN;
      failing.allocate();
      await failing.idle();
      const logged = warn.mock.calls.map((a) => a.map(String).join(' '));
      warn.mockRestore();
      unsubscribe();
      expect(getBooking(db, id)!.end_reason).toBe('setup_failed');
      const feed = events.map((e) => JSON.stringify(e)).filter((t) => t.includes('could not be set up'));
      expect(feed).toHaveLength(1);
      expect(feed[0]).toContain('sm_booking_allow_add (2 ids)');
      expect(logged.some((t) => t.includes('sm_booking_allow_add (2 ids)'))).toBe(true);
      for (const t of [...logged, ...feed]) expect(t.includes(P[0]) || t.includes(P[1])).toBe(false);
    });

    it('a refused !allow pushes no list, says the reason and takes the player back off the box\'s list; a malformed arg is only refused', async () => {
      await running();
      db.prepare("INSERT INTO bans (player_id, reason, created_by, created_at) VALUES (?, 'x', 'system', '2026-09-01T00:00:00.000Z')").run(P[7]);
      runner.onCommand(3, P[0], 'allow', `${P[7]} banned guy`);
      await flush();
      // The plugin added them on its own when the captain typed it: the
      // refuse line takes that back and restarts their grace.
      expect(cmds()).toEqual(['say [Booking] That is not an active player.', `sm_booking_allow_refuse ${P[7]}`]);
      sent = [];
      runner.onCommand(3, P[0], 'allow', 'nobody');
      await flush();
      expect(cmds()).toEqual(['say [Booking] That is not an active player.']);
    });

    it('a refusal from the booking rules (a full side) also takes the player back off', async () => {
      const id = await running();
      const ins = db.prepare("INSERT INTO booking_people (booking_id, side, steamid, role, status, added_by, added_at) VALUES (?, 'a', ?, 'player', 'accepted', ?, '2026-09-01T00:00:00.000Z')");
      // Twelve more on side a: past PEOPLE_PER_SIDE whoever was there already.
      for (let i = 0; i < 12; i++) {
        const sid = `765611993333333${String(i).padStart(2, '0')}`;
        db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, 'x', 'active')").run(sid);
        ins.run(id, sid, P[0]);
      }
      runner.onCommand(3, P[0], 'allow', '76561199222222222 x');
      await flush();
      expect(cmds()).toEqual(['say [Booking] That side is full.', 'sm_booking_allow_refuse 76561199222222222']);
    });

    it('a non-captain cannot !allow anyone, and the box takes back what its plugin let in', async () => {
      const id = await running();
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      runner.onCommand(3, P[5], 'allow', '76561199222222222 x');
      await flush();
      log.mockRestore();
      expect(cmds()).toEqual(['say [Booking] Only a captain or co-captain of that side can do that.', 'sm_booking_allow_refuse 76561199222222222']);
      expect(db.prepare('SELECT 1 FROM booking_people WHERE booking_id = ? AND steamid = ?').get(id, '76561199222222222')).toBeUndefined();
    });

    it('an !allow on a box a booking still holds while it winds down is taken back too', async () => {
      const r = build({ release: () => new Promise<boolean>(() => {}) });
      const id = await running(['no_mercy'], r);
      r.endFromGame(id, P[0]);
      await flush();
      sent = [];
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      r.onCommand(3, P[0], 'allow', '76561199222222222 x');
      await flush();
      log.mockRestore();
      expect(cmds()).toEqual(['say [Booking] The booking is past that point.', 'sm_booking_allow_refuse 76561199222222222']);
    });

    it('an !allow on a box no booking holds sends nothing, and a non-allow command from a non-captain still sends nothing', async () => {
      await running();
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      runner.onCommand(1, P[0], 'allow', '76561199222222222 x');
      runner.onCommand(3, P[5], 'stay', '');
      await flush();
      log.mockRestore();
      expect(cmds()).toEqual([]);
    });

    it('a failed refuse line logs no steamid', async () => {
      await running();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const failing = build({
        rcon: async (server, c) => {
          const line = c.find((x) => x.startsWith('sm_booking_allow_refuse'));
          if (line) throw new Error(`rcon exec timeout: ${line}`);
          return fakeRcon(server, c);
        },
      });
      failing.onCommand(3, P[5], 'allow', '76561199222222222 x');
      await flush();
      const logged = warn.mock.calls.map((a) => a.map(String).join(' '));
      warn.mockRestore();
      expect(logged.length).toBeGreaterThan(0);
      expect(logged.some((t) => /\d{17}/.test(t))).toBe(false);
    });

    it('a failed allowlist push logs a count, never the ids', async () => {
      await running();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const failing = build({
        rcon: async (server, c) => {
          const add = c.find((x) => x.startsWith('sm_booking_allow_add'));
          if (add) throw new Error(`rcon exec timeout: ${add}`);
          return fakeRcon(server, c);
        },
      });
      failing.onCommand(3, P[0], 'allow', '76561199222222222 x');
      await flush();
      const logged = warn.mock.calls.map((a) => a.map(String).join(' '));
      warn.mockRestore();
      expect(logged.length).toBeGreaterThan(0);
      expect(logged.some((t) => t.includes(P[0]) || t.includes('76561199222222222'))).toBe(false);
      expect(logged.some((t) => t.includes('3 ids'))).toBe(true);
    });
  });

  describe('final review fixes', () => {
    /** The invariant: a booking that has ended leaves no live match behind. */
    const expectNoLiveGame = (bookingId: number) => {
      expect(getBooking(db, bookingId)!.ended_at).not.toBeNull();
      expect(db.prepare("SELECT id FROM matches WHERE booking_id = ? AND state = 'live'").all(bookingId)).toEqual([]);
    };
    let unregistered: string[];
    let r: BookingRunner;
    const start = async () => {
      unregistered = [];
      r = build({ unregisterToken: (t) => { unregistered.push(t); } });
      const id = await running(['no_mercy', 'death_toll'], r);
      const live = insertGame(id, { state: 'live', token: 'tok-live' });
      return { id, live };
    };
    const expectAborted = (live: number) => {
      expect(db.prepare('SELECT state, abort_cause FROM matches WHERE id = ?').get(live)).toEqual({ state: 'aborted', abort_cause: 'booking_ended' });
      expect(unregistered).toEqual(['tok-live']);
      const c = cmds();
      expect(c).toContain('sm_pug_abort tok-live');
      const bye = c.findIndex((x) => x.startsWith('say [Booking] This booked server is closing'));
      expect(bye).toBeGreaterThan(-1);
      expect(c.indexOf('sm_pug_abort tok-live')).toBeLessThan(bye);
    };

    // Ruling 4: the slot's end never cuts a live game (the by-campaign tests
    // below follow it to the end); the other ends still abort one.
    it('the slot end does not abort a live game', async () => {
      const { id, live } = await start();
      box.ccc.humans = [P[0]];
      now = START + 180 * MIN; // two campaigns: an estimated 3 hour slot
      await r.tick();
      await r.idle();
      expect(getBooking(db, id)!.ending_at).toBeNull();
      expect(db.prepare('SELECT state FROM matches WHERE id = ?').get(live)).toEqual({ state: 'live' });
      expect(unregistered).toEqual([]);
      expect(cmds().some((c) => c.startsWith('sm_pug_abort'))).toBe(false);
    });

    it('an idle end aborts a live game', async () => {
      const { id, live } = await start();
      now = START + 25 * MIN;
      await r.tick();
      await r.idle();
      expect(getBooking(db, id)!.end_reason).toBe('idle');
      expectAborted(live);
      expectNoLiveGame(id);
    });

    it('a cancel aborts a live game', async () => {
      const { id, live } = await start();
      expect(cancelBooking(db, { bookingId: id, by: P[0], now: new Date(now) }).ok).toBe(true);
      r.onCancelled(id, P[0], null);
      await r.idle();
      expect(getBooking(db, id)!.state).toBe('cancelled');
      expectAborted(live);
      expectNoLiveGame(id);
    });

    it('a staff end aborts a live game', async () => {
      const { id, live } = await start();
      expect(r.endFromGame(id, P[9], true)).toEqual({ ok: true });
      await r.idle();
      expect(getBooking(db, id)!.end_reason).toBe('staff');
      expectAborted(live);
      expectNoLiveGame(id);
    });

    it('an end that finishes after a web restart aborts the live game too (no goodbye)', async () => {
      const { id, live } = await start();
      cancelBooking(db, { bookingId: id, by: P[0], now: new Date(now) });
      const fresh = build({ unregisterToken: (t) => { unregistered.push(t); } });
      fresh.resume();
      await fresh.idle();
      expect(db.prepare('SELECT state FROM matches WHERE id = ?').get(live)).toEqual({ state: 'aborted' });
      expect(cmds()).toContain('sm_pug_abort tok-live');
      expectNoLiveGame(id);
    });

    it('a refused end aborts nothing', async () => {
      const { id, live } = await start();
      expect(r.endFromGame(id, P[5])).toMatchObject({ ok: false });
      await r.idle();
      expect(db.prepare('SELECT state FROM matches WHERE id = ?').get(live)).toEqual({ state: 'live' });
      expect(unregistered).toEqual([]);
      expect(cmds().some((c) => c.startsWith('sm_pug_abort'))).toBe(false);
    });

    it('abortGame stops listening for the token and tells the booked box, without releasing it or ending the booking', async () => {
      const { id, live } = await start();
      db.prepare("UPDATE matches SET state = 'aborted' WHERE id = ?").run(live);
      await r.abortGame(live, 'tok-live');
      expect(unregistered).toEqual(['tok-live']);
      expect(cmds()).toEqual(['sm_pug_abort tok-live']);
      expect(released).toEqual([]);
      expect(getBooking(db, id)!.ending_at).toBeNull();
    });

    it('abortGame does nothing for a match with no booking', async () => {
      await start();
      const pug = Number(db.prepare(
        "INSERT INTO matches (season_id, state, campaign, server_id, token) VALUES (?, 'aborted', 'no_mercy', 1, 'tok-pug')",
      ).run(currentSeasonId(db)).lastInsertRowid);
      await r.abortGame(pug, 'tok-pug');
      expect(unregistered).toEqual([]);
      expect(sent).toEqual([]);
    });

    it('the log secret goes at setup and with a campaign load, not in the minute re-push; the log address does', async () => {
      const secret = 'cd'.repeat(16);
      db.prepare('UPDATE servers SET log_secret = ? WHERE id = 3').run(secret);
      const lr = build({ logPublicAddress: '203.0.113.5:27500' });
      const id = await running(['no_mercy', 'death_toll'], lr);
      box.ccc.humans = [P[0]];
      now = START + 5 * MIN;
      await lr.tick();
      expect(cmds()).toContain('logaddress_add 203.0.113.5:27500');
      expect(cmds().some((c) => c.startsWith('sm_pug_log_secret'))).toBe(false);
      sent = [];
      expect(lr.chooseNext(id, P[0], 'death')).toMatchObject({ ok: true });
      await lr.idle();
      expect(cmds()).toContain(`sm_pug_log_secret "${secret}"`);
    });

    it('everyone-left counts 2 minutes from the later of the last game end and the last campaign load, and a load resets the empty count', async () => {
      const id = await running();
      box.ccc.humans = [P[0]];
      now = START + 39 * MIN;
      await runner.tick();
      // The game ended long ago, then an empty watch.
      insertGame(id, { state: 'completed', endedAt: now - 10 * MIN });
      box.ccc.humans = [];
      now = START + 40 * MIN;
      await runner.tick();
      // A captain loads the next campaign: the box empties while it loads.
      expect(runner.chooseNext(id, P[0], 'death')).toMatchObject({ ok: true });
      await runner.idle();
      // One more empty watch a minute after the load: the count started again,
      // and the load was under 2 minutes ago.
      now += MIN;
      await runner.tick();
      expect(getBooking(db, id)!.ending_at).toBeNull();
      now += MIN;
      await runner.tick();
      await runner.idle();
      // Two empty watches since the load, the load 2 minutes ago: everyone left.
      expect(getBooking(db, id)).toMatchObject({ state: 'ended', end_reason: 'done' });
    });

    it('a load inside the 2 minutes holds off the everyone-left end even with two empty watches before it', async () => {
      const id = await running();
      box.ccc.humans = [P[0]];
      now = START + 39 * MIN;
      await runner.tick();
      insertGame(id, { state: 'completed', endedAt: now - 10 * MIN });
      box.ccc.humans = [];
      now = START + 40 * MIN;
      expect(runner.chooseNext(id, P[0], 'death')).toMatchObject({ ok: true });
      await runner.idle();
      now += 30_000; await runner.tick();
      now += 60_000; await runner.tick();
      // Two empty watches, but the load was 90 s ago.
      expect(getBooking(db, id)!.ending_at).toBeNull();
    });
  });
});

describe('booking voice (plan 4c)', () => {
  let t: FakeTransport;
  const voiceRow = (id: number) => db.prepare('SELECT * FROM booking_voice WHERE booking_id = ?').get(id) as
    { category_id: string; side_a_id: string; side_b_id: string; deleted_at: string | null } | undefined;
  const ready = async (r: BookingRunner) => {
    const id = book();
    now = START - 15 * MIN;
    r.allocate();
    await r.idle();
    sent = []; dms = [];
    return id;
  };
  beforeEach(() => {
    t = new FakeTransport();
    setSetting(db, 'discord_voice_enabled', '1');
  });

  it('a booking turning ready gets its side channels', async () => {
    const r = build({ voice: new BookingVoice({ db, voice: () => t.voice, now: () => now }) });
    const id = await ready(r);
    expect(getBooking(db, id)!.state).toBe('ready');
    const v = voiceRow(id)!;
    expect(t.channels.get(v.side_a_id)!.allowed).toEqual(['d0']);
    expect(t.channels.get(v.side_b_id)!.allowed).toEqual(['d1']);
  });

  it('the minute watch makes the channels for a ready booking that has none, and syncs members', async () => {
    let connected = false;
    const r = build({ voice: new BookingVoice({ db, voice: () => (connected ? t.voice : null), now: () => now }) });
    const id = await ready(r);
    expect(voiceRow(id)).toBeUndefined();
    connected = true; // the bot logged in after the booking was set up
    now = START - 10 * MIN;
    await r.tick();
    const v = voiceRow(id)!;
    expect(t.channels.get(v.side_a_id)!.allowed).toEqual(['d0']);
    addPerson(db, { bookingId: id, by: P[0], side: 'a', steamid: P[2], role: 'player', now: new Date(now) });
    respondPerson(db, { bookingId: id, steamid: P[2], accept: true, now: new Date(now) });
    now += MIN;
    await r.tick();
    expect(t.channels.get(v.side_a_id)!.allowed).toEqual(['d0', 'd2']);
    expect(t.channels.size).toBe(3);
  });

  it('the wind-down closes voice before the release', async () => {
    const order: string[] = [];
    setSetting(db, 'discord_lobby_channel_id', 'lobby');
    t.channels.set('lobby', { name: 'Lobby', members: new Set(), allowed: [], staffRoleId: null });
    const ops = { ...t.voice, deleteChannel: async (c: string) => { order.push(`delete ${c}`); await t.voice.deleteChannel(c); } };
    const r = build({
      voice: new BookingVoice({ db, voice: () => ops, now: () => now }),
      release: async (sid) => { order.push('release'); released.push(sid); db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(sid); return true; },
    });
    const id = await ready(r);
    const v = voiceRow(id)!;
    await t.voice.move('d0', v.side_a_id);
    cancelBooking(db, { bookingId: id, by: P[0], now: new Date(now) });
    r.settle(id);
    await r.idle();
    expect(order).toEqual([`delete ${v.side_a_id}`, `delete ${v.side_b_id}`, `delete ${v.category_id}`, 'release']);
    expect(t.moves.at(-1)).toEqual({ userId: 'd0', channelId: 'lobby' });
    expect(voiceRow(id)!.deleted_at).not.toBeNull();
    expect(getBooking(db, id)!.ended_at).not.toBeNull();
  });

  it('a voice that throws stops neither the setup, the watch nor the wind-down', async () => {
    const boom = async () => { throw new Error('voice exploded'); };
    const thrower = { ensure: boom, sync: boom, close: boom } as unknown as BookingVoice;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = build({ voice: thrower });
    const id = await ready(r);
    expect(getBooking(db, id)!.state).toBe('ready');
    box.ccc.humans = [P[0]];
    now = START - 5 * MIN;
    await r.tick();
    expect(getBooking(db, id)!.state).toBe('active');
    cancelBooking(db, { bookingId: id, by: P[0], now: new Date(now) });
    r.settle(id);
    await r.idle();
    err.mockRestore();
    expect(released).toEqual([3]);
    expect(getBooking(db, id)!.ended_at).not.toBeNull();
  });
});

describe('tournament bookings (plan T3b)', () => {
  const hooks = () => ({
    gameLines: vi.fn((_id: number, campaign: string) => [`sm_pug_match 1 tok ${campaign}`, 'say [Match] Game 1']),
    pendingLines: vi.fn(() => [] as string[]),
    ready: vi.fn(), presence: vi.fn(), gameEnded: vi.fn(), ended: vi.fn(),
  });
  const bookTournament = () => {
    const r = createTournamentBooking(db, {
      region: 'na', campaign: 'no_mercy', rulesJson: '{}', rulesetId: null, gameConfig: 'standard', createdBy: P[9]!,
      sides: [{ teamId: null, captain: P[0]!, players: P.slice(0, 4), spectators: [P[8]!] }, { teamId: null, captain: P[4]!, players: P.slice(4, 8), spectators: [] }],
      now: new Date(now),
    });
    if (!r.ok) throw new Error(r.error);
    return r.value.id;
  };
  const cmds = () => sent.filter((s) => s.server === 'ccc').flatMap((s) => s.cmds);

  it('sets the box up with auto-track off and the game burst before the first changelevel, and tells the engine instead of DMing the connect line', async () => {
    const h = hooks();
    runner = build({ tournament: h });
    now = START;
    const id = bookTournament();
    runner.allocate();
    await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ state: 'ready', server_id: 3 });
    expect(cmds()).toContain('sm_pug_auto_track 0');
    expect(cmds()).not.toContain('sm_pug_auto_track 1');
    expect(cmds().indexOf('sm_pug_match 1 tok no_mercy')).toBeLessThan(cmds().indexOf('changelevel l4d_vs_hospital01_apartment'));
    expect(h.gameLines).toHaveBeenCalledWith(id, 'no_mercy');
    expect(h.ready).toHaveBeenCalledWith(id);
    expect(dms).toEqual([]);
    // T3b final review: the booking lines (re-pushed every minute) turn off PUG leave tracking and the end kick.
    expect(cmds()).toContain('sm_pug_leave_budget 0');
    expect(cmds()).toContain('sm_pug_end_kick 0');
    sent = [];
    now = START + MIN;
    await runner.tick();
    expect(cmds()).toContain('sm_pug_leave_budget 0');
    expect(cmds()).toContain('sm_pug_end_kick 0');
  });

  it('hands presence and a finished game to the engine, re-pushes a pending burst, never schedules or ends on time itself, and refuses captain commands', async () => {
    const h = hooks();
    h.pendingLines.mockReturnValue(['sm_pug_match 1 tok no_mercy']);
    runner = build({ tournament: h });
    now = START;
    const id = bookTournament();
    runner.allocate();
    await runner.idle();
    box.ccc.humans = [...P.slice(0, 4), ...P.slice(4, 7)];
    sent = [];
    now = START + MIN;
    await runner.tick();
    expect(h.presence).toHaveBeenCalledWith(id, new Set([...P.slice(0, 4), ...P.slice(4, 7)]), new Date(now));
    expect(sideRow(db, id, 'a')!.present_now).toBe(4);
    expect(cmds()).toContain('sm_pug_match 1 tok no_mercy');
    // T3b final review: the re-push asks the box first; a box that already holds the game (its MATCH_START lost) is left alone.
    expect(cmds().indexOf('sm_pug_status')).toBeLessThan(cmds().indexOf('sm_pug_match 1 tok no_mercy'));
    for (const held of ['state=live match=1', 'state=pending match=1', 'state=ended match=1', 'state=live match=7']) {
      box.ccc.pug = held;
      sent = [];
      now += MIN;
      await runner.tick();
      expect(cmds()).toContain('sm_pug_status');
      expect(cmds()).not.toContain('sm_pug_match 1 tok no_mercy');
    }
    // A box holding an older game that has ended, or none, gets the burst again.
    box.ccc.pug = 'state=ended match=7';
    sent = [];
    now += MIN;
    await runner.tick();
    expect(cmds()).toContain('sm_pug_match 1 tok no_mercy');
    const matchId = Number(db.prepare(
      "INSERT INTO matches (season_id, state, campaign, server_id, token, kind, booking_id, booking_side_a, team_a_score, team_b_score, winner, ended_at) VALUES (?, 'completed', 'no_mercy', 3, 't1', 'tournament', ?, 'a', 500, 400, 'a', datetime('now'))",
    ).run(currentSeasonId(db), id).lastInsertRowid);
    sent = [];
    runner.onGameEnded(matchId);
    expect(h.gameEnded).toHaveBeenCalledWith(id, matchId);
    expect(getBooking(db, id)!.next_campaign).toBeNull();
    expect(cmds().some((c) => c.startsWith('say [Booking]'))).toBe(false);
    now = Date.parse(getBooking(db, id)!.ends_at) + MIN;
    await runner.tick();
    expect(getBooking(db, id)).toMatchObject({ state: 'active', ending_at: null });
    sent = [];
    runner.onCommand(3, P[0]!, 'nextmap', 'dead_air');
    runner.onCommand(3, P[0]!, 'end', '');
    await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ next_campaign: null, ending_at: null });
    expect(cmds().filter((c) => c === 'say [Match] The site runs this tournament match: it picks the campaigns and closes the server.')).toHaveLength(2);
  });

  it('loads a tiebreak chapter straight after the game burst, and tells the engine when the booking ends', async () => {
    const h = hooks();
    runner = build({ tournament: h });
    now = START;
    const id = bookTournament();
    runner.allocate();
    await runner.idle();
    db.prepare("UPDATE bookings SET state = 'active' WHERE id = ?").run(id);
    setNext(db, id, 'no_mercy', new Date(now).toISOString(), new Date(now), null, 'l4d_vs_hospital04_interior');
    sent = [];
    now += MIN;
    await runner.tick();
    await runner.idle();
    expect(cmds().indexOf('sm_pug_match 1 tok no_mercy')).toBeLessThan(cmds().indexOf('changelevel l4d_vs_hospital04_interior'));
    expect(cmds()).not.toContain('changelevel l4d_vs_hospital01_apartment');
    expect(getBooking(db, id)).toMatchObject({ next_campaign: null, next_map: null, playlist_pos: 0 });
    runner.announce(id, 'Series over: Rats beat Bats 2 games to 1.');
    await runner.idle();
    expect(cmds()).toContain('say [Match] Series over: Rats beat Bats 2 games to 1.');
    cancelBooking(db, { bookingId: id, by: P[9]!, staff: true, now: new Date(now) });
    runner.settle(id);
    await runner.idle();
    expect(h.ended).toHaveBeenCalledWith(id, 'staff');
    expect(cmds().some((c) => c.startsWith('say [Match] This booked server is closing:'))).toBe(true);
    expect(cmds().some((c) => c.startsWith('say [Booking] This booked server is closing:'))).toBe(false);
  });

  it('a gameLines throw between games alerts staff and loads nothing', async () => {
    const h = hooks();
    runner = build({ tournament: h });
    now = START;
    const id = bookTournament();
    runner.allocate();
    await runner.idle();
    db.prepare("UPDATE bookings SET state = 'active' WHERE id = ?").run(id);
    setNext(db, id, 'no_mercy', new Date(now).toISOString(), new Date(now), null, 'l4d_vs_hospital04_interior');
    h.gameLines.mockImplementation(() => { throw new Error('no veto sides'); });
    const events: AdminEvent[] = [];
    const unsubscribe = subscribeAdminEvents((e) => events.push(e));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    sent = [];
    now += MIN;
    try {
      await runner.tick();
      await runner.idle();
    } finally {
      unsubscribe();
      err.mockRestore();
    }
    expect(cmds().some((c) => c.startsWith('changelevel'))).toBe(false);
    expect(events.some((e) => e.kind === 'problem' && e.text.includes(`Booking ${id}: the tournament game on no_mercy could not be started (no veto sides)`))).toBe(true);
    expect(getBooking(db, id)).toMatchObject({ next_campaign: null, next_map: null, playlist_pos: 0 });
  });

  it('a tournament booking with no box gets no late alert and is never cancelled as no_server', async () => {
    const events: AdminEvent[] = [];
    const unsubscribe = subscribeAdminEvents((e) => events.push(e));
    runner = build({ tournament: hooks() });
    now = START;
    const id = bookTournament();
    db.prepare("UPDATE servers SET status = 'live'").run();
    now = START + 30 * MIN;
    runner.allocate();
    await runner.tick();
    unsubscribe();
    expect(getBooking(db, id)).toMatchObject({ state: 'scheduled', server_id: null, ending_at: null });
    expect(events.filter((e) => e.kind === 'problem' && e.text.includes(`Booking ${id} `))).toEqual([]);
    expect(dms).toEqual([]);
  });
});

describe('server priority (owner, 2026-10-07)', () => {
  /** A tournament match's booking, made at lineup lock: starts now, 90 minutes, people P[2] to P[9]. */
  const tournament = () => {
    const r = createTournamentBooking(db, {
      region: 'na', campaign: 'no_mercy', rulesJson: '{}', rulesetId: null, gameConfig: 'standard', createdBy: P[9],
      sides: [{ teamId: null, captain: P[2], players: P.slice(2, 6), spectators: [] }, { teamId: null, captain: P[6], players: P.slice(6, 10), spectators: [] }],
      now: new Date(now),
    });
    if (!r.ok) throw new Error(r.error);
    return r.value.id;
  };
  /** A scrim held and set up on the highest box (ccc, id 3) at its hold time. */
  const heldScrim = async () => {
    const id = book();
    now = START - 15 * MIN;
    runner.allocate();
    await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ state: 'ready', server_id: 3 });
    return id;
  };

  it('a tournament match with no idle box and nothing to preempt bumps the unstarted scrim holding a box, which is told with the nearest slot, and takes the box after the wind-down (Rulings 4, 5 and 7)', async () => {
    const events: AdminEvent[] = [];
    const unsubscribe = subscribeAdminEvents((e) => events.push(e));
    const scrim = await heldScrim();
    db.prepare("UPDATE servers SET status = 'live' WHERE id IN (1, 2)").run();
    setSetting(db, 'pug_reserve_servers', '2'); // room for one booking: the match fills 19:45 to 21:15, so the scrim's next slot is 21:30
    dms = []; sent = []; released = [];
    const match = tournament();
    runner.allocate();
    expect(getBooking(db, scrim)).toMatchObject({ state: 'cancelled', end_reason: 'bumped', cancel_side: null, cancelled_by: null, server_id: 3, ended_at: null });
    expect(getBooking(db, scrim)!.cancel_reason).toBe('A tournament match needed the server. The nearest free slot is 2026-10-02 21:30 UTC.');
    expect(getBooking(db, match)!.state).toBe('scheduled');
    expect(preempts).toBe(1);
    expect(dms.filter((d) => d.content.includes('was bumped: a tournament match needed the server')).map((d) => d.to).sort()).toEqual(['d0', 'd1']);
    expect(dms.every((d) => d.content.includes('The nearest free slot is 2026-10-02 21:30 UTC'))).toBe(true);
    expect(events.filter((e) => e.kind === 'problem').map((e) => e.text)).toEqual([
      `Booking ${scrim} (p0's group vs p1's group, 20:00 UTC) was bumped by tournament match booking ${match}: its server is going back to the pool for the match. Both sides are told and offered 21:30 UTC; it counts against neither side.`,
    ]);
    unsubscribe();
    await runner.idle();
    expect(sent.filter((s) => s.server === 'ccc').flatMap((s) => s.cmds)).toContain('say [Booking] This booked server is closing: a tournament match needs it.');
    expect(released).toEqual([3]);
    expect(getBooking(db, scrim)!.ended_at).not.toBeNull();
    expect(db.prepare("SELECT event FROM booking_events WHERE booking_id = ? ORDER BY id").all(scrim).map((e) => (e as { event: string }).event)).toContain('bumped');
    runner.allocate();
    await runner.idle();
    expect(getBooking(db, match)).toMatchObject({ state: 'ready', server_id: 3 });
  });

  it('practice leases and side games give a box back before any scrim is bumped (Ruling 4)', async () => {
    const scrim = await heldScrim();
    db.prepare("UPDATE servers SET status = 'live' WHERE id = 2").run();
    db.prepare("INSERT INTO side_games (server_id, token, password) VALUES (1, 'tok', 'pw')").run();
    const match = tournament();
    runner.allocate();
    expect(preempts).toBe(1);
    expect(getBooking(db, scrim)!.state).toBe('ready');
    expect(getBooking(db, match)!.state).toBe('scheduled');
    db.prepare("UPDATE side_games SET ended_at = datetime('now')").run();
    runner.allocate();
    await runner.idle();
    expect(getBooking(db, match)).toMatchObject({ state: 'ready', server_id: 1 });
    expect(getBooking(db, scrim)).toMatchObject({ state: 'ready', server_id: 3 });
  });

  it('never bumps a scrim that started: an active booking stays, and the match waits (Ruling 4)', async () => {
    const scrim = await heldScrim();
    expect(markActive(db, scrim, new Date(now))).toBe(true);
    db.prepare("UPDATE servers SET status = 'live' WHERE id IN (1, 2)").run();
    dms = [];
    const match = tournament();
    runner.allocate();
    expect(getBooking(db, scrim)).toMatchObject({ state: 'active', server_id: 3 });
    expect(getBooking(db, match)!.state).toBe('scheduled');
    expect(dms).toEqual([]);
    expect(preempts).toBe(1);
  });

  it('bumps one scrim per waiting match: with two held scrims and one match, the latest row goes and the other stays while the box winds down (Ruling 4)', async () => {
    const first = book();
    const second = book();
    now = START - 15 * MIN;
    runner.allocate();
    await runner.idle();
    expect(getBooking(db, first)).toMatchObject({ state: 'ready', server_id: 3 });
    expect(getBooking(db, second)).toMatchObject({ state: 'ready', server_id: 2 });
    db.prepare("UPDATE servers SET status = 'live' WHERE id = 1").run();
    const match = tournament();
    runner.allocate();
    runner.allocate();
    expect(getBooking(db, second)).toMatchObject({ state: 'cancelled', end_reason: 'bumped' });
    expect(getBooking(db, first)).toMatchObject({ state: 'ready', server_id: 3 });
    await runner.idle();
    runner.allocate();
    await runner.idle();
    expect(getBooking(db, match)).toMatchObject({ state: 'ready', server_id: 2 });
    expect(getBooking(db, first)).toMatchObject({ state: 'ready', server_id: 3 });
  });

  it('one waiting match bumps at most one boxless scrim past its start, however many passes it waits through (Ruling 6)', () => {
    const first = book();
    const second = book();
    db.prepare("UPDATE servers SET status = 'live'").run();
    now = START + 2 * MIN;
    const match = tournament();
    runner.allocate();
    runner.allocate();
    runner.allocate();
    expect(getBooking(db, first)).toMatchObject({ state: 'cancelled', end_reason: 'bumped', server_id: null });
    expect(getBooking(db, second)).toMatchObject({ state: 'scheduled', server_id: null, ending_at: null });
    expect(getBooking(db, match)!.state).toBe('scheduled');
    expect((db.prepare("SELECT COUNT(*) AS n FROM booking_events WHERE event = 'bumped'").get() as { n: number }).n).toBe(1);
  });

  it('never bumps a held scrim whose players are already on its box (Ruling 4)', async () => {
    const scrim = await heldScrim();
    recordPresence(db, scrim, { a: 1, b: 0 }, true, new Date(now));
    db.prepare("UPDATE servers SET status = 'live' WHERE id IN (1, 2)").run();
    dms = [];
    const match = tournament();
    runner.allocate();
    runner.allocate();
    expect(getBooking(db, scrim)).toMatchObject({ state: 'ready', server_id: 3, ending_at: null });
    expect(getBooking(db, match)!.state).toBe('scheduled');
    expect(dms).toEqual([]);
  });

  it('a box that frees up goes to the tournament match before a scrim that has waited longer (Ruling 2)', async () => {
    const scrim = book();
    db.prepare("UPDATE servers SET status = 'live' WHERE id IN (2, 3)").run();
    db.prepare("INSERT INTO side_games (server_id, token, password) VALUES (1, 'tok', 'pw')").run();
    now = START - 15 * MIN;
    runner.allocate();
    expect(getBooking(db, scrim)!.state).toBe('scheduled');
    now = START + 2 * MIN; // the scrim is past its start; the match starts later than it
    const match = tournament();
    runner.allocate();
    expect(getBooking(db, scrim)!.state).toBe('scheduled'); // a side game is still there to take, so nothing is bumped
    db.prepare("UPDATE side_games SET ended_at = datetime('now')").run();
    runner.allocate();
    await runner.idle();
    expect(getBooking(db, match)).toMatchObject({ state: 'ready', server_id: 1 });
    expect(getBooking(db, scrim)!.server_id).toBeNull();
  });

  it('a scrim past its start with no box is bumped at its start for a match waiting on one, with the slot offer, and never gets the late alert (Ruling 6)', async () => {
    const events: AdminEvent[] = [];
    const unsubscribe = subscribeAdminEvents((e) => events.push(e));
    const scrim = book();
    db.prepare("UPDATE servers SET status = 'live'").run();
    now = START - 15 * MIN;
    runner.allocate();
    expect(getBooking(db, scrim)!.state).toBe('scheduled');
    now = START;
    dms = [];
    const match = tournament(); // 20:00 to 21:30; room for 2: the scrim's next slot is 20:30
    runner.allocate();
    unsubscribe();
    const b = getBooking(db, scrim)!;
    expect(b).toMatchObject({ state: 'cancelled', end_reason: 'bumped', cancel_side: null, server_id: null, ended_at: new Date(now).toISOString() });
    expect(b.cancel_reason).toBe('A tournament match needed the server. The nearest free slot is 2026-10-02 20:30 UTC.');
    expect(dms.filter((d) => d.content.includes('was bumped')).map((d) => d.to).sort()).toEqual(['d0', 'd1']);
    expect(events.filter((e) => e.kind === 'problem').map((e) => e.text)).toEqual([
      `Booking ${scrim} (p0's group vs p1's group, 20:00 UTC) was bumped by tournament match booking ${match}: no server was free and the match is ahead of it. Both sides are told and offered 20:30 UTC; it counts against neither side.`,
    ]);
    expect(getBooking(db, match)!.state).toBe('scheduled');
    await runner.idle();
    expect(released).toEqual([]);
  });

  it('a match that already holds a box owes nothing: a scrim short of a box beside it waits for the no_server close as before (Ruling 6)', async () => {
    db.prepare("UPDATE servers SET status = 'live' WHERE id IN (1, 2)").run();
    now = START - 20 * MIN;
    const match = tournament();
    runner.allocate();
    await runner.idle();
    expect(getBooking(db, match)).toMatchObject({ state: 'ready', server_id: 3 });
    const scrim = book();
    now = START + 14 * MIN;
    dms = [];
    await runner.tick();
    expect(getBooking(db, scrim)!.state).toBe('scheduled');
    expect(dms).toEqual([]);
    now = START + 15 * MIN;
    await runner.tick();
    expect(getBooking(db, scrim)).toMatchObject({ state: 'cancelled', end_reason: 'no_server' });
  });

  it('one scrim per waiting match: two scrims past their start and one match bump only the earlier-started one (Ruling 6)', () => {
    const first = book();
    const second = book();
    db.prepare("UPDATE servers SET status = 'live'").run();
    now = START + MIN;
    tournament();
    runner.allocate();
    expect(getBooking(db, first)).toMatchObject({ state: 'cancelled', end_reason: 'bumped' });
    expect(getBooking(db, second)!.state).toBe('scheduled');
  });
  describe('final review fixes', () => {
    const bumpedCount = () => (db.prepare("SELECT COUNT(*) AS n FROM booking_events WHERE event = 'bumped'").get() as { n: number }).n;

    it('a box mid-restart in the region counts as coming: no held scrim is bumped while it returns, and the match takes it once back (Important 1)', async () => {
      const restarting = new Set<number>();
      runner = build({ releasing: (id) => restarting.has(id) });
      const scrim = await heldScrim();
      db.prepare("UPDATE servers SET status = 'live' WHERE id = 1").run();
      db.prepare("UPDATE servers SET status = 'offline' WHERE id = 2").run();
      restarting.add(2);
      dms = [];
      const match = tournament();
      runner.allocate();
      runner.allocate();
      expect(getBooking(db, scrim)).toMatchObject({ state: 'ready', server_id: 3, ending_at: null });
      expect(getBooking(db, match)!.state).toBe('scheduled');
      expect(dms).toEqual([]);
      expect(bumpedCount()).toBe(0);
      restarting.delete(2);
      db.prepare("UPDATE servers SET status = 'idle' WHERE id = 2").run();
      runner.allocate();
      await runner.idle();
      expect(getBooking(db, match)).toMatchObject({ state: 'ready', server_id: 2 });
      expect(getBooking(db, scrim)).toMatchObject({ state: 'ready', server_id: 3 });
    });

    it('a box mid-restart also holds off the boxless bump of a scrim past its start (Important 1, Ruling 6)', () => {
      const restarting = new Set<number>([2]);
      runner = build({ releasing: (id) => restarting.has(id) });
      const scrim = book();
      db.prepare("UPDATE servers SET status = 'live' WHERE id IN (1, 3)").run();
      db.prepare("UPDATE servers SET status = 'offline' WHERE id = 2").run();
      now = START + 2 * MIN;
      tournament();
      runner.allocate();
      expect(getBooking(db, scrim)).toMatchObject({ state: 'scheduled', ending_at: null });
      expect(bumpedCount()).toBe(0);
    });

    it('a gone box mid-restart is not coming back: it never holds off a bump (Important 1)', () => {
      runner = build({ releasing: () => true });
      const scrim = book();
      db.prepare("UPDATE servers SET status = 'live' WHERE id IN (1, 3)").run();
      db.prepare("UPDATE servers SET status = 'offline', gone_since = '2026-10-02T19:00:00.000Z' WHERE id = 2").run();
      now = START + 2 * MIN;
      tournament();
      runner.allocate();
      expect(getBooking(db, scrim)).toMatchObject({ state: 'cancelled', end_reason: 'bumped' });
    });

    it('the waiting match takes the bumped box as soon as it is released, with no further allocate (Important 3)', async () => {
      const scrim = await heldScrim();
      db.prepare("UPDATE servers SET status = 'live' WHERE id IN (1, 2)").run();
      const match = tournament();
      runner.allocate();
      expect(getBooking(db, scrim)).toMatchObject({ end_reason: 'bumped' });
      await runner.idle();
      expect(getBooking(db, scrim)!.ended_at).not.toBeNull();
      expect(getBooking(db, match)).toMatchObject({ state: 'ready', server_id: 3 });
    });

    it('a tournament match whose box died bumps an unstarted scrim, its people are told, and the match recovers onto that box after the wind-down (Important 2)', async () => {
      const events: AdminEvent[] = [];
      const scrim = await heldScrim();
      db.prepare("UPDATE servers SET status = 'live' WHERE id = 1").run();
      const match = tournament();
      runner.allocate();
      await runner.idle();
      expect(getBooking(db, match)).toMatchObject({ state: 'ready', server_id: 2 });
      expect(beginRecovery(db, match, 'gone', new Date(now))).toBe(true);
      expect(dropBox(db, match, new Date(now))).toBe(2);
      dms = []; released = [];
      const unsubscribe = subscribeAdminEvents((e) => events.push(e));
      runner.allocate();
      runner.allocate();
      unsubscribe();
      expect(getBooking(db, scrim)).toMatchObject({ state: 'cancelled', end_reason: 'bumped', server_id: 3 });
      expect(bumpedCount()).toBe(1);
      expect(dms.filter((d) => d.content.includes('was bumped: a tournament match needed the server')).map((d) => d.to).sort()).toEqual(['d0', 'd1']);
      expect(events.some((e) => e.kind === 'problem' && e.text.includes(`was bumped by tournament match booking ${match}`))).toBe(true);
      await runner.idle();
      expect(released).toEqual([3]);
      expect(getBooking(db, match)).toMatchObject({ state: 'ready', server_id: 3, recovering_at: null, waiting_since: null });
    });

    it('a recovering match never takes a scrim whose players are on its box, nor one that started (Important 2)', async () => {
      const scrim = await heldScrim();
      db.prepare("UPDATE servers SET status = 'live' WHERE id = 1").run();
      const match = tournament();
      runner.allocate();
      await runner.idle();
      recordPresence(db, scrim, { a: 1, b: 0 }, true, new Date(now));
      beginRecovery(db, match, 'gone', new Date(now));
      dropBox(db, match, new Date(now));
      dms = [];
      runner.allocate();
      runner.allocate();
      await runner.idle();
      expect(getBooking(db, scrim)).toMatchObject({ state: 'ready', server_id: 3, ending_at: null });
      expect(getBooking(db, match)).toMatchObject({ server_id: null });
      expect(getBooking(db, match)!.waiting_since).not.toBeNull();
      expect(dms).toEqual([]);
      expect(bumpedCount()).toBe(0);
    });

    it('a match staff moved with no free box waits and bumps no scrim; a match whose box died still does (controller ruling)', async () => {
      runner = build({ release: async (id) => { released.push(id); db.prepare("UPDATE servers SET status = 'offline' WHERE id = ?").run(id); return true; } });
      const scrim = await heldScrim();
      db.prepare("UPDATE servers SET status = 'live' WHERE id = 1").run();
      const match = tournament();
      runner.allocate();
      await runner.idle();
      expect(getBooking(db, match)).toMatchObject({ state: 'ready', server_id: 2 });
      dms = [];
      expect(await runner.moveBooking(match)).toBe(2);
      runner.allocate();
      runner.allocate();
      await runner.idle();
      expect(getBooking(db, scrim)).toMatchObject({ state: 'ready', server_id: 3, ending_at: null });
      expect(getBooking(db, match)!.server_id).toBeNull();
      expect(getBooking(db, match)!.waiting_since).not.toBeNull();
      expect(bumpedCount()).toBe(0);
      expect(dms).toEqual([]);
      // The moved match then lands on box 2 again, and that box dies: now it bumps.
      db.prepare("UPDATE servers SET status = 'idle' WHERE id = 2").run();
      runner.allocate();
      await runner.idle();
      expect(getBooking(db, match)).toMatchObject({ server_id: 2, recovering_at: null });
      expect(beginRecovery(db, match, 'gone', new Date(now))).toBe(true);
      expect(dropBox(db, match, new Date(now))).toBe(2);
      runner.allocate();
      expect(getBooking(db, scrim)).toMatchObject({ state: 'cancelled', end_reason: 'bumped' });
      expect(bumpedCount()).toBe(1);
    });

    it('a second scrim bumped for the same match (the first box did not come back) says so to staff, and a failed bump is logged', async () => {
      const first = book();
      const second = book();
      now = START - 15 * MIN;
      runner.allocate();
      await runner.idle();
      expect(getBooking(db, first)).toMatchObject({ state: 'ready', server_id: 3 });
      expect(getBooking(db, second)).toMatchObject({ state: 'ready', server_id: 2 });
      let fails = 1;
      runner = build({
        release: async (id) => {
          released.push(id);
          if (fails-- > 0) { db.prepare("UPDATE servers SET status = 'offline' WHERE id = ?").run(id); return false; }
          db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(id);
          return true;
        },
      });
      db.prepare("UPDATE servers SET status = 'live' WHERE id = 1").run();
      const events: AdminEvent[] = [];
      const unsubscribe = subscribeAdminEvents((e) => events.push(e));
      const match = tournament();
      runner.allocate();
      expect(getBooking(db, second)).toMatchObject({ end_reason: 'bumped' });
      await runner.idle();
      unsubscribe();
      expect(getBooking(db, first)).toMatchObject({ state: 'cancelled', end_reason: 'bumped' });
      const texts = events.flatMap((e) => (e.kind === 'problem' && e.text.includes('was bumped') ? [e.text] : []));
      expect(texts).toHaveLength(2);
      expect(texts[0]).not.toContain('second scrim');
      expect(texts[1]).toContain(`It is the second scrim bumped for match booking ${match}: the server the earlier bump freed did not come back.`);
      expect(getBooking(db, match)).toMatchObject({ state: 'ready', server_id: 3 });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      (runner as unknown as { bump: (v: unknown, f: unknown, n: number) => void }).bump(getBooking(db, first), getBooking(db, match), now);
      expect(warn.mock.calls.some((c) => String(c[0]).includes(`bumping booking ${first} for ${match} refused: wrong_state`))).toBe(true);
      warn.mockRestore();
    });

    it('two waiting matches and one held scrim: the scrim goes once, the first match takes its box, the second waits (deferred Task 3 minor)', async () => {
      const scrim = await heldScrim();
      db.prepare("UPDATE servers SET status = 'live' WHERE id IN (1, 2)").run();
      const m1 = tournament();
      const m2 = tournament();
      runner.allocate();
      runner.allocate();
      expect(getBooking(db, scrim)).toMatchObject({ end_reason: 'bumped' });
      expect(bumpedCount()).toBe(1);
      await runner.idle();
      runner.allocate();
      await runner.idle();
      expect(getBooking(db, m1)).toMatchObject({ state: 'ready', server_id: 3 });
      expect(getBooking(db, m2)).toMatchObject({ state: 'scheduled', server_id: null });
      expect(bumpedCount()).toBe(1);
    });

    it('two waiting matches, one held scrim and one boxless scrim past its start: each match takes one scrim, never two for one (deferred Task 3 minor)', async () => {
      const held = await heldScrim();
      const boxless = book();
      db.prepare("UPDATE servers SET status = 'live' WHERE id IN (1, 2)").run();
      now = START + 2 * MIN;
      const m1 = tournament();
      const m2 = tournament();
      runner.allocate();
      runner.allocate();
      expect(getBooking(db, held)).toMatchObject({ end_reason: 'bumped' });
      expect(getBooking(db, boxless)).toMatchObject({ end_reason: 'bumped', server_id: null });
      const by = db.prepare("SELECT booking_id, json_extract(detail, '$.byBookingId') AS by FROM booking_events WHERE event = 'bumped' ORDER BY id").all();
      expect(by).toEqual([{ booking_id: held, by: m1 }, { booking_id: boxless, by: m2 }]);
      await runner.idle();
      expect(getBooking(db, m1)).toMatchObject({ state: 'ready', server_id: 3 });
      expect(getBooking(db, m2)!.server_id).toBeNull();
    });
  });
});
