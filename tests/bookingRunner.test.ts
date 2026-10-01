import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer, type ServerRow } from '../src/serverPool.js';
import { setSetting } from '../src/settings.js';
import { currentSeasonId } from '../src/players.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { Notifier } from '../src/notify/notify.js';
import {
  addPerson, cancelBooking, confirmBooking, createBooking, extendBooking, getBooking, holdBox, markSetup, respondPerson, sideRow,
} from '../src/bookings/bookings.js';
import { BookingRunner, CLEAR_LINES, bookingLines } from '../src/bookings/runner.js';

const P = Array.from({ length: 10 }, (_, i) => `765611990000009${String(i).padStart(2, '0')}`);
const START = Date.parse('2026-10-02T20:00:00.000Z');
const MIN = 60_000;
const PUB = 'Rotoblin Pub VS';

let db: DB;
let now: number;
let sent: { server: string; cmds: string[] }[];
let box: Record<string, { type: string; plugin: boolean; map: string; humans: string[]; down: boolean; execs: number; failExec: number }>;
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
    if (c === 'l4d_game_type_name') return `"l4d_game_type_name" = "${b.type}" ( def. "" )`;
    if (c === 'l4d_booking_version') return b.plugin ? '"l4d_booking_version" = "1.0.0" ( def. "1.0.0" )' : 'Unknown command "l4d_booking_version"';
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
    restart: async (server) => { restarted.push(server.name); box[server.name].type = PUB; box[server.name].map = 'l4d_vs_hospital01_apartment'; return true; },
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
    box[n] = { type: PUB, plugin: true, map: 'l4d_vs_hospital01_apartment', humans: [], down: false, execs: 0, failExec: 0 };
  }
  runner = build();
});

const book = (o: { playlist?: string[]; confirm?: boolean } = {}) => {
  const r = createBooking(db, {
    by: P[0], opponent: { steamid: P[1] }, startsAt: new Date(START).toISOString(), minutes: 120,
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
});

describe('bookingLines', () => {
  it('keeps team names console-safe', () => {
    const id = book();
    db.prepare("UPDATE players SET name = 'a\"b;c ü' WHERE steamid = ?").run(P[0]);
    const lines = bookingLines(db, getBooking(db, id)!);
    expect(lines.find((l) => l.startsWith('l4d_booking_notice'))).toBe('l4d_booking_notice "Booked: abc ?\'s group vs p1\'s group until 22:00 UTC"');
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

  it('warns at 30, 10 and 5 minutes left, once each, then ends on time', async () => {
    const id = await ready();
    box.ccc.humans = [P[0]];
    const says = () => sent.flatMap((s) => s.cmds).filter((c) => c.startsWith('say [Booking] About') && c.includes('on this booking'));
    now = START + 89 * MIN; await runner.tick();
    expect(says()).toEqual([]);
    now = START + 90 * MIN; await runner.tick();
    now = START + 91 * MIN; await runner.tick();
    expect(says()).toEqual(['say [Booking] About 30 minutes left on this booking (until 22:00 UTC).']);
    now = START + 110 * MIN; await runner.tick();
    now = START + 115 * MIN; await runner.tick();
    now = START + 116 * MIN; await runner.tick();
    expect(says()).toEqual([
      'say [Booking] About 30 minutes left on this booking (until 22:00 UTC).',
      'say [Booking] About 10 minutes left on this booking (until 22:00 UTC).',
      'say [Booking] About 5 minutes left on this booking (until 22:00 UTC).',
    ]);
    now = START + 120 * MIN; await runner.tick();
    await runner.idle();
    expect(getBooking(db, id)).toMatchObject({ state: 'ended', end_reason: 'time' });
  });

  it('makes no idle end while rcon is down, but still ends on time', async () => {
    const id = await ready();
    box.ccc.down = true;
    now = START + 60 * MIN;
    await runner.tick();
    expect(getBooking(db, id)!.ending_at).toBeNull();
    now = START + 119 * MIN;
    await runner.tick();
    expect(getBooking(db, id)!.ending_at).toBeNull();
    now = START + 120 * MIN;
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
      'l4d_booking_password ""', 'l4d_booking_tv_password ""', 'l4d_booking_notice ""',
      'sm_pug_pause_limit 3', 'sm_pug_pause_seconds 120', 'sm_pug_auto_min_players 8',
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

  it('onExtended re-sends the notice and says the new end on a running box', async () => {
    const id = await ready();
    expect(extendBooking(db, { bookingId: id, by: P[0], staff: true, now: new Date(now) }).ok).toBe(true);
    runner.onExtended(id);
    await new Promise((r) => setImmediate(r));
    const cmds = sent.flatMap((s) => s.cmds);
    expect(cmds).toContain('say [Booking] Extended: this booking now runs until 22:30 UTC.');
    expect(cmds.find((c) => c.startsWith('l4d_booking_notice'))).toContain('until 22:30 UTC');
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
  const NEXT_DT = 'say [Booking] Next: Death Toll in 60 s. !nextmap to pick another, !stay to replay this one, !end to finish.';
  const CAPTAINS_DT = 'say [Booking] Death Toll: !nextmap, !stay, !end and !extend are yours, captains.';
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

  it('after a game the next campaign is announced, then loaded 60 s later with the captains line and the extend warning', async () => {
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
    // Death Toll has no PUG history: the 60 minute default, with 30 left.
    expect(cmds()).toContain('say [Booking] About 30 min left, this campaign usually takes 60. !extend now while the slot after is free.');
    expect(JSON.parse(events(id, 'campaign_loaded')[0].detail)).toEqual({ campaign: 'death_toll', pos: 1 });

    // Loaded once: the next watch does not load it again.
    sent = [];
    now += MIN;
    await runner.tick();
    await runner.idle();
    expect(cmds().some((c) => c.startsWith('changelevel'))).toBe(false);
  });

  it('no extend warning when the campaign fits in the time left', async () => {
    const id = await running();
    box.ccc.humans = [P[0]];
    now = START + 10 * MIN;
    runner.onGameEnded(insertGame(id, { state: 'completed', endedAt: now }));
    now += MIN;
    await runner.tick();
    await runner.idle();
    expect(cmds()).toContain(CAPTAINS_DT);
    expect(cmds().some((c) => c.includes('this campaign usually takes'))).toBe(false);
  });

  it('a game ending on the last playlist campaign says so and schedules nothing', async () => {
    const id = await running(['no_mercy']);
    now = START + 60 * MIN;
    runner.onGameEnded(insertGame(id, { state: 'completed', endedAt: now }));
    await flush();
    expect(cmds()).toContain('say [Booking] That was the last campaign on the playlist. !nextmap <campaign> to play another, or !end to finish.');
    expect(getBooking(db, id)).toMatchObject({ next_campaign: null, next_at: null });
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
    it('the first campaign gets the captains line and the extend warning once, when the booking goes active', async () => {
      const id = await running();
      box.ccc.humans = [P[0]];
      now = START + 70 * MIN; // 50 min left, No Mercy defaults to 60
      await runner.tick();
      expect(getBooking(db, id)!.state).toBe('active');
      expect(cmds()).toContain('say [Booking] No Mercy: !nextmap, !stay, !end and !extend are yours, captains.');
      expect(cmds()).toContain('say [Booking] About 50 min left, this campaign usually takes 60. !extend now while the slot after is free.');
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

    it('no extend warning at go-active when the campaign fits', async () => {
      await running();
      box.ccc.humans = [P[0]];
      now = START;
      await runner.tick();
      expect(cmds()).toContain('say [Booking] No Mercy: !nextmap, !stay, !end and !extend are yours, captains.');
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

    it('the minute watch re-push failure is logged redacted', async () => {
      const id = await running();
      const secret = 'ef'.repeat(16);
      db.prepare('UPDATE servers SET log_secret = ? WHERE id = 3').run(secret);
      const r = build({
        logPublicAddress: '203.0.113.5:27500',
        rcon: async (server, c) => {
          const line = c.find((x) => x.startsWith('sm_pug_log_secret'));
          if (line) throw new Error(`rcon exec timeout: ${line}`);
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
      expect(logged.some((t) => t.includes('re-pushing the booking lines') && t.includes('<redacted>'))).toBe(true);
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

    it('does nothing, and sends nothing, for a non-captain', async () => {
      const id = await running();
      runner.onCommand(3, P[5], 'nextmap', '');
      await runner.idle();
      expect(getBooking(db, id)!.playlist_pos).toBe(0);
      expect(cmds()).toEqual([]);
    });

    it('does nothing on a box with no booking', () => {
      expect(() => runner.onCommand(1, P[0], 'stay', '')).not.toThrow();
      expect(cmds()).toEqual([]);
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

    it('extends the booking and says the new end on the box', async () => {
      const id = await running();
      const before = getBooking(db, id)!.ends_at;
      runner.onCommand(3, P[1], 'extend', '');
      await flush();
      const b = getBooking(db, id)!;
      expect(Date.parse(b.ends_at)).toBe(Date.parse(before) + 30 * MIN);
      expect(cmds()).toContain(`say [Booking] Extended: this booking now runs until ${b.ends_at.slice(11, 16)} UTC.`);
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
});
