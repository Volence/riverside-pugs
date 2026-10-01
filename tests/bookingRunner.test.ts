import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer, type ServerRow } from '../src/serverPool.js';
import { setSetting } from '../src/settings.js';
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

function build(over: Partial<ConstructorParameters<typeof BookingRunner>[0]> = {}) {
  return new BookingRunner({
    db,
    publicUrl: 'https://riversidepug.com',
    rcon: async (server: ServerRow, cmds: string[]) => {
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
    },
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
    const says = () => sent.flatMap((s) => s.cmds).filter((c) => c.startsWith('say [Booking] About'));
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
    expect(CLEAR_LINES).toEqual(['l4d_booking_password ""', 'l4d_booking_tv_password ""', 'l4d_booking_notice ""']);
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
