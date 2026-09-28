import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer, claimIdle, getServer, markLive, type ServerRow } from '../src/serverPool.js';
import { ServerReleaser, reconcileServers } from '../src/serverRelease.js';
import { upsertPlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import {
  EXTEND_MS, IDLE_END_MS, LEASE_MS, LEASES_PER_HOUR, PARK_CAPACITY, PREEMPT_WARN_MS, PICK_ERRORS,
  PracticeLeases, getLease, identityLines, joinableParks, judgeLease, leaseView, newLeasePassword,
  parkListings, parseStatusMap, pickLeaseServer, adminLeaseRows,
} from '../src/practiceLeases.js';

const ME = '76561199000000001';
const YOU = '76561199000000002';
const T0 = Date.parse('2026-09-28T12:00:00.000Z');
const URL = 'https://riversidepug.com';

let db: DB;
let now: number;
let sent: { server: string; cmds: string[] }[];
let humansOn: Record<string, number>;
let rconDown: Set<string>;
let released: number[];
let releaseBack: boolean;
let restartBack: boolean;

function seedServer(name: string, over: { restart?: number; enabled?: number; status?: ServerRow['status'] } = {}): number {
  const id = addServer(db, { name, host: `10.0.0.${name.length}`, port: 27015, rconPort: 27015, rconPassword: 'x' });
  db.prepare('UPDATE servers SET restart_after_match = ?, enabled = ?, status = ? WHERE id = ?')
    .run(over.restart ?? 1, over.enabled ?? 1, over.status ?? 'idle', id);
  return id;
}

const status = (humans: number, map = 'l4d_vs_hospital01_apartment') =>
  `hostname: test\nversion : 1.0.2.9\nmap     : ${map} at: 0 x, 0 y, 0 z\nplayers : ${humans} humans, 0 bots (31 max)\n`;

function manager(over: Partial<ConstructorParameters<typeof PracticeLeases>[0]> = {}) {
  return new PracticeLeases({
    db,
    publicUrl: URL,
    rcon: async (server, cmds) => {
      if (rconDown.has(server.name)) throw new Error('rcon connect timeout');
      sent.push({ server: server.name, cmds });
      return cmds.map((c) => (c === 'status' ? status(humansOn[server.name] ?? 0) : ''));
    },
    release: async (id) => { released.push(id); if (releaseBack) db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(id); return releaseBack; },
    // Recorded in `sent` so the order against the rcon lines is visible.
    restart: async (server) => { sent.push({ server: server.name, cmds: ['(restart)'] }); return restartBack; },
    sleep: async () => {},
    now: () => now,
    ...over,
  });
}

/** Lets queued background steps (setup, wind-down) run to completion. */
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

beforeEach(() => {
  db = openDb(':memory:');
  now = T0;
  sent = [];
  humansOn = {};
  rconDown = new Set();
  released = [];
  releaseBack = true;
  restartBack = true;
  upsertPlayer(db, { steamid: ME, name: 'me', avatar: null }, []);
  upsertPlayer(db, { steamid: YOU, name: 'you', avatar: null }, []);
});

let mgr: PracticeLeases | null = null;
afterEach(() => { mgr?.stop(); mgr = null; });

describe('pickLeaseServer', () => {
  it('takes the highest id and keeps one other box idle for the queue', () => {
    seedServer('a'); const b = seedServer('bb');
    const pick = pickLeaseServer(db);
    expect(pick.ok && pick.server.id).toBe(b);
  });

  it('refuses when taking a box would leave fewer idle than the reserve', () => {
    seedServer('a');
    expect(pickLeaseServer(db)).toEqual({ ok: false, reason: 'no_server' });
    setSetting(db, 'practice_reserve_idle', '0');
    expect(pickLeaseServer(db).ok).toBe(true);
  });

  it('lends any enabled box, restart toggle or not (ending restarts it regardless)', () => {
    seedServer('a', { restart: 0 }); const b = seedServer('bb', { restart: 0 });
    const pick = pickLeaseServer(db);
    expect(pick.ok && pick.server.id).toBe(b);
  });

  it('ignores disabled, busy and already leased boxes', () => {
    seedServer('a'); seedServer('bb', { status: 'live' }); seedServer('ccc', { enabled: 0 });
    expect(pickLeaseServer(db).ok).toBe(false);
  });

  it('refuses while a PUG is waiting for a box, at the lease cap, and when turned off', () => {
    seedServer('a'); seedServer('bb'); seedServer('ccc');
    db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'configuring', 'no_mercy')").run();
    expect(pickLeaseServer(db)).toEqual({ ok: false, reason: 'queue_waiting' });
    db.prepare("UPDATE matches SET state = 'aborted'").run();
    setSetting(db, 'practice_max_leases', '0');
    expect(pickLeaseServer(db)).toEqual({ ok: false, reason: 'off' });
    setSetting(db, 'practice_max_leases', '1');
    db.prepare(`INSERT INTO practice_leases (server_id, kind, owner_player_id, password, ends_at)
      VALUES (3, 'park', ?, 'x', '2099-01-01')`).run(ME);
    expect(pickLeaseServer(db)).toEqual({ ok: false, reason: 'max_leases' });
  });

  it('has a player-facing message for every refusal', () => {
    expect(PICK_ERRORS.no_server).toBe('All servers are busy with PUGs right now. Try again in a few minutes.');
  });
});

describe('the pool with a lease open', () => {
  it('claimIdle never hands out a leased box, and does again once the lease has ended', () => {
    const a = seedServer('a');
    const id = Number(db.prepare(`INSERT INTO practice_leases (server_id, kind, owner_player_id, password, ends_at)
      VALUES (?, 'drill', ?, 'x', '2099-01-01')`).run(a, ME).lastInsertRowid);
    expect(claimIdle(db)).toBeNull();
    // Winding down still holds it.
    db.prepare("UPDATE practice_leases SET end_reason = 'owner' WHERE id = ?").run(id);
    expect(claimIdle(db)).toBeNull();
    db.prepare("UPDATE practice_leases SET ended_at = 'now' WHERE id = ?").run(id);
    expect(claimIdle(db)?.id).toBe(a);
  });

  it('the boot reconcile leaves a leased idle box alone', () => {
    const a = seedServer('a');
    db.prepare(`INSERT INTO practice_leases (server_id, kind, owner_player_id, password, ends_at)
      VALUES (?, 'park', ?, 'x', '2099-01-01')`).run(a, ME);
    const cleaned: number[] = [];
    expect(reconcileServers(db, new ServerReleaser(db, async (s) => { cleaned.push(s.id); }))).toEqual([]);
    expect(getServer(db, a)!.status).toBe('idle');
    expect(cleaned).toEqual([]);
  });
});

describe('judgeLease', () => {
  const lease = { kind: 'drill' as const, last_human_at: new Date(T0).toISOString(), ends_at: new Date(T0 + LEASE_MS).toISOString() };

  it('keeps a lease with people on it and stamps them', () => {
    const v = judgeLease(lease, 3, T0 + 5 * 60_000);
    expect(v).toEqual({ end: null, lastHumanAt: new Date(T0 + 5 * 60_000).toISOString(), endsAt: lease.ends_at });
  });

  it('ends a drill server nobody has been on for ten minutes, not before', () => {
    expect(IDLE_END_MS.drill).toBe(10 * 60_000);
    expect(judgeLease(lease, 0, T0 + IDLE_END_MS.drill - 1).end).toBeNull();
    expect(judgeLease(lease, 0, T0 + IDLE_END_MS.drill).end).toBe('idle');
  });

  it('ends an empty park after five minutes', () => {
    expect(IDLE_END_MS.park).toBe(5 * 60_000);
    const park = { ...lease, kind: 'park' as const };
    expect(judgeLease(park, 0, T0 + 5 * 60_000 - 1).end).toBeNull();
    expect(judgeLease(park, 0, T0 + 5 * 60_000).end).toBe('idle');
  });

  it('a failed poll counts as nobody, so a dead box drifts to the idle end', () => {
    expect(judgeLease(lease, null, T0 + IDLE_END_MS.drill).end).toBe('idle');
  });

  it('extends past the time limit while people are on, and ends it when they are not', () => {
    const at = T0 + LEASE_MS;
    expect(judgeLease({ ...lease, last_human_at: new Date(at - 60_000).toISOString() }, 0, at).end).toBe('expired');
    const v = judgeLease(lease, 2, at);
    expect(v).toEqual({ end: null, lastHumanAt: new Date(at).toISOString(), endsAt: new Date(at + EXTEND_MS).toISOString() });
  });
});

describe('small parts', () => {
  it('passwords are eight characters from the unambiguous alphabet, and differ', () => {
    const p = newLeasePassword();
    expect(p).toMatch(/^[a-hj-km-np-z2-9]{8}$/);
    expect(newLeasePassword()).not.toBe(p);
  });

  it('reads the map from status', () => {
    expect(parseStatusMap(status(0, 'l4d_vs_airport03_garage'))).toBe('l4d_vs_airport03_garage');
    expect(parseStatusMap('nothing')).toBeNull();
  });

  it('quotes the site URL, since // starts a console comment', () => {
    expect(identityLines({ kind: 'drill', password: 'abcd2345', owner_player_id: ME }, URL)).toEqual([
      'sm_cvar sv_password "abcd2345"',
      `l4d_practice_owner ${ME}`,
      'l4d_practice_site "https://riversidepug.com"',
    ]);
    expect(() => identityLines({ kind: 'drill', password: 'a"b', owner_player_id: ME }, URL)).toThrow();
    expect(() => identityLines({ kind: 'drill', password: 'abcd2345', owner_player_id: ME }, 'http://x/"; quit')).toThrow();
  });

  it('a park is ownerless in game: its owner cvar is set empty', () => {
    expect(identityLines({ kind: 'park', password: 'abcd2345', owner_player_id: ME }, URL)[1]).toBe('l4d_practice_owner ""');
  });
});

describe('PracticeLeases.create', () => {
  it('leases a park: checks for people, execs the cfg, then sends password, an empty owner and site twice', async () => {
    seedServer('a'); const b = seedServer('bb');
    mgr = manager();
    const r = await mgr.create(ME, 'park');
    expect(r.ok && !r.joined).toBe(true);
    if (!r.ok) return;
    expect(r.lease.server_id).toBe(b);
    expect(r.lease.ends_at).toBe(new Date(T0 + LEASE_MS).toISOString());
    await flush();
    const pw = getLease(db, r.lease.id)!.password;
    const id = [`sm_cvar sv_password "${pw}"`, 'l4d_practice_owner ""', `l4d_practice_site "${URL}"`];
    // Status first (nobody on it), then a restart for a clean slate, then the cfg.
    expect(sent.map((s) => s.cmds)).toEqual([['status'], ['(restart)'], ['exec practice_park.cfg'], id, id]);
    expect(getLease(db, r.lease.id)!.setup_phase).toBeNull();
    expect(sent.every((s) => s.server === 'bb')).toBe(true);
    expect(getLease(db, r.lease.id)!.ready_at).toBe(new Date(T0).toISOString());
  });

  it('a drill lease execs the drill cfg and preloads its code on the second send', async () => {
    seedServer('a'); seedServer('bb');
    mgr = manager();
    const r = await mgr.create(ME, 'drill', 'K7QX');
    await flush();
    expect(r.ok).toBe(true);
    expect(sent[1].cmds).toEqual(['(restart)']);
    expect(sent[2].cmds).toEqual(['exec practice_drill.cfg']);
    expect(sent[4].cmds.at(-1)).toBe('sm_drill_load K7QX');
    expect(sent[3].cmds).not.toContain('sm_drill_load K7QX');
  });

  it('hands back the park that has room instead of leasing another box', async () => {
    seedServer('a'); seedServer('bb'); seedServer('ccc');
    mgr = manager();
    const first = await mgr.create(ME, 'park');
    const second = await mgr.create(YOU, 'park');
    expect(second.ok && second.joined).toBe(true);
    expect(second.ok && first.ok && second.lease.id).toBe(first.ok && first.lease.id);
    db.prepare('UPDATE practice_leases SET humans = ?').run(PARK_CAPACITY);
    expect(joinableParks(db)).toEqual([]);
    const third = await mgr.create(YOU, 'park');
    expect(third.ok && !third.joined).toBe(true);
  });

  it('one open drill server per player', async () => {
    seedServer('a'); seedServer('bb'); seedServer('ccc');
    mgr = manager();
    const d = await mgr.create(ME, 'drill');
    const again = await mgr.create(ME, 'drill');
    expect(again).toMatchObject({ ok: false, status: 409, leaseId: d.ok ? d.lease.id : -1 });
  });

  it('limits new leases per hour', async () => {
    seedServer('a'); seedServer('bb');
    for (let i = 0; i < LEASES_PER_HOUR; i++) {
      db.prepare(`INSERT INTO practice_leases (server_id, kind, owner_player_id, password, created_at, ends_at, ended_at)
        VALUES (1, 'drill', ?, 'x', ?, 'x', 'x')`).run(ME, new Date(T0 - 60_000).toISOString());
    }
    mgr = manager();
    expect(await mgr.create(ME, 'drill')).toMatchObject({ ok: false, status: 429 });
  });

  it('refuses a box with people on it and gives it straight back, untouched', async () => {
    seedServer('a'); seedServer('bb');
    humansOn.bb = 2;
    mgr = manager();
    const r = await mgr.create(ME, 'park');
    expect(r).toMatchObject({ ok: false, status: 503 });
    const lease = getLease(db, 1)!;
    expect(lease.end_reason).toBe('players_on_server');
    expect(lease.ended_at).not.toBeNull();
    expect(released).toEqual([]);
    expect(sent.map((s) => s.cmds)).toEqual([['status']]);
    expect(claimIdle(db)?.id).toBe(1);
  });

  it('says every server is busy when none can be spared', async () => {
    seedServer('a');
    mgr = manager();
    expect(await mgr.create(ME, 'park')).toEqual({ ok: false, status: 503, error: PICK_ERRORS.no_server });
  });

  it('a server that does not come back from its reset ends the lease through the release', async () => {
    seedServer('a'); const b = seedServer('bb');
    restartBack = false;
    mgr = manager();
    expect((await mgr.create(ME, 'park')).ok).toBe(true);
    await flush();
    expect(sent.map((s) => s.cmds[0])).not.toContain('exec practice_park.cfg');
    expect(getLease(db, 1)!.end_reason).toBe('setup_failed');
    expect(released).toEqual([b]);
  });

  it('says which setup step it is on: resetting, then loading', async () => {
    seedServer('a'); seedServer('bb');
    let letBack!: (v: boolean) => void;
    mgr = manager({ restart: () => new Promise((r) => { letBack = r; }) });
    await mgr.create(ME, 'drill');
    await flush();
    expect(leaseView(db, getLease(db, 1)!, ME, false)).toMatchObject({ state: 'setting_up', setupPhase: 'resetting' });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // Hold the setup at its settle wait to read the loading phase.
    (mgr as unknown as { sleep: (ms: number) => Promise<void> }).sleep = () => gate;
    letBack(true);
    await flush();
    expect(leaseView(db, getLease(db, 1)!, ME, false).setupPhase).toBe('loading');
    release();
    await flush();
    expect(leaseView(db, getLease(db, 1)!, ME, false)).toMatchObject({ state: 'ready', setupPhase: null });
  });

  it('a setup that fails is wound down through the release', async () => {
    seedServer('a'); const b = seedServer('bb');
    let calls = 0;
    mgr = manager({
      rcon: async (_s, cmds) => {
        calls++;
        if (calls === 2) throw new Error('rcon exec timeout');
        return cmds.map((c) => (c === 'status' ? status(0) : ''));
      },
    });
    const r = await mgr.create(ME, 'park');
    expect(r.ok).toBe(true);
    await flush();
    const lease = getLease(db, 1)!;
    expect(lease.end_reason).toBe('setup_failed');
    expect(lease.ended_at).not.toBeNull();
    expect(released).toEqual([b]);
  });
});

describe('PracticeLeases.end', () => {
  it('says goodbye, kicks, releases, and only then closes the lease', async () => {
    seedServer('a'); const b = seedServer('bb');
    mgr = manager();
    await mgr.create(ME, 'park');
    await flush();
    sent = [];
    let resolveRelease!: (v: boolean) => void;
    const m2 = manager({ release: (id) => { released.push(id); return new Promise((r) => { resolveRelease = r; }); } });
    expect(m2.end(1, 'owner')).toBe(true);
    expect(m2.end(1, 'admin')).toBe(false);
    await flush();
    expect(sent.map((s) => s.cmds[0])).toEqual([
      'say [Practice] This practice server is closing: the owner closed it.',
      'sm_kick @humans "Practice server closed. Thanks for practising."',
    ]);
    expect(released).toEqual([b]);
    // Still holding the box while the restart runs.
    expect(getLease(db, 1)!.ended_at).toBeNull();
    expect(claimIdle(db)?.id).not.toBe(b);
    resolveRelease(true);
    await flush();
    expect(getLease(db, 1)!.ended_at).not.toBeNull();
    expect(getLease(db, 1)!.end_reason).toBe('owner');
  });

  it('a box that never answers still gets its lease closed and its restart', async () => {
    seedServer('a'); const b = seedServer('bb');
    mgr = manager();
    await mgr.create(ME, 'park');
    await flush();
    rconDown.add('bb');
    mgr.end(1, 'admin');
    await flush();
    expect(released).toEqual([b]);
    expect(getLease(db, 1)!.ended_at).not.toBeNull();
  });
});

describe('PracticeLeases.tick', () => {
  async function leased(kind: 'park' | 'drill' = 'park') {
    seedServer('a'); seedServer('bb');
    mgr = manager();
    await mgr.create(ME, kind);
    await flush();
    sent = [];
    return mgr;
  }

  it('records humans and map while people are on', async () => {
    const m = await leased();
    humansOn.bb = 3;
    now = T0 + 5 * 60_000;
    await m.tick();
    const l = getLease(db, 1)!;
    expect(l.humans).toBe(3);
    expect(l.map).toBe('l4d_vs_hospital01_apartment');
    expect(l.last_human_at).toBe(new Date(now).toISOString());
    expect(parkListings(db)).toEqual([{
      id: 1, server: 'bb', humans: 3, capacity: PARK_CAPACITY, map: 'l4d_vs_hospital01_apartment',
      ready: true, endsAt: new Date(T0 + LEASE_MS).toISOString(),
    }]);
  });

  it('ends a park nobody joined within five minutes', async () => {
    const m = await leased();
    now = T0 + IDLE_END_MS.park - 1;
    await m.tick();
    expect(getLease(db, 1)!.end_reason).toBeNull();
    now = T0 + IDLE_END_MS.park;
    await m.tick();
    await flush();
    expect(getLease(db, 1)!.end_reason).toBe('idle');
    expect(released).toEqual([2]);
  });

  it('extends a lease past ninety minutes while people are on', async () => {
    const m = await leased();
    humansOn.bb = 1;
    now = T0 + LEASE_MS;
    await m.tick();
    expect(getLease(db, 1)!.ends_at).toBe(new Date(now + EXTEND_MS).toISOString());
    expect(getLease(db, 1)!.end_reason).toBeNull();
  });
});

describe('preemption', () => {
  it('warns the newest lease, then ends it after the warning while the PUG still waits', async () => {
    seedServer('a'); seedServer('bb'); seedServer('ccc');
    setSetting(db, 'practice_reserve_idle', '0');
    mgr = manager();
    await mgr.create(ME, 'park');
    await mgr.create(YOU, 'drill');
    await flush();
    // The queue took the last free box and another match waits.
    db.prepare("UPDATE servers SET status = 'live' WHERE id = 1").run();
    db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'configuring', 'no_mercy')").run();
    sent = [];
    mgr.needServer();
    mgr.needServer();
    await flush();
    const newest = getLease(db, 2)!;
    expect(newest.server_id).toBe(2);
    expect(newest.warned_at).not.toBeNull();
    expect(getLease(db, 1)!.warned_at).toBeNull();
    expect(sent).toEqual([{ server: 'bb', cmds: ['say [Practice] A PUG needs this server in 60 seconds. Ranked matches always come first.'] }]);

    // Not yet.
    now = T0 + PREEMPT_WARN_MS - 1;
    await mgr.tick();
    expect(getLease(db, 2)!.end_reason).toBeNull();
    now = T0 + PREEMPT_WARN_MS;
    await mgr.tick();
    await flush();
    expect(getLease(db, 2)!.end_reason).toBe('preempted');
    expect(getLease(db, 1)!.end_reason).toBeNull();
    expect(released).toEqual([2]);
  });

  it('stands down when the PUG found a box during the warning', async () => {
    seedServer('a'); seedServer('bb');
    mgr = manager();
    await mgr.create(ME, 'park');
    await flush();
    db.prepare("UPDATE servers SET status = 'live' WHERE id = 1").run();
    const match = db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'configuring', 'no_mercy')").run().lastInsertRowid;
    mgr.needServer();
    db.prepare("UPDATE matches SET server_id = 1, state = 'live' WHERE id = ?").run(match);
    now = T0 + PREEMPT_WARN_MS;
    await mgr.tick();
    await flush();
    expect(getLease(db, 1)!.end_reason).toBeNull();
    expect(getLease(db, 1)!.warned_at).toBeNull();
  });

  it('does nothing while an idle box is free for the PUG', async () => {
    seedServer('a'); seedServer('bb');
    mgr = manager();
    await mgr.create(ME, 'park');
    await flush();
    mgr.needServer();
    expect(getLease(db, 1)!.warned_at).toBeNull();
  });

  it('the tick starts a preemption for a PUG that was already waiting', async () => {
    seedServer('a'); seedServer('bb');
    mgr = manager();
    await mgr.create(ME, 'park');
    await flush();
    db.prepare("UPDATE servers SET status = 'live' WHERE id = 1").run();
    db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'configuring', 'no_mercy')").run();
    humansOn.bb = 2;
    await mgr.tick();
    expect(getLease(db, 1)!.warned_at).not.toBeNull();
  });
});

describe('resume at boot', () => {
  it('runs a wind-down a web restart interrupted, and ends a lease that never finished setting up', async () => {
    seedServer('a'); seedServer('bb'); seedServer('ccc');
    const ins = db.prepare(`INSERT INTO practice_leases (server_id, kind, owner_player_id, password, ends_at, ready_at, end_reason)
      VALUES (?, ?, ?, 'x', '2099-01-01', ?, ?)`);
    ins.run(2, 'park', ME, '2026-09-28', 'owner');
    ins.run(3, 'drill', YOU, null, null);
    db.prepare("UPDATE servers SET status = 'offline' WHERE id = 2").run();
    mgr = manager();
    mgr.resume();
    await flush();
    expect(released.sort()).toEqual([2, 3]);
    expect(getLease(db, 1)!.ended_at).not.toBeNull();
    expect(getLease(db, 2)!.end_reason).toBe('interrupted');
    expect(getLease(db, 2)!.ended_at).not.toBeNull();
    // No goodbye for the resumed one: the box was mid-restart.
    expect(sent.filter((s) => s.server === 'bb')).toEqual([]);
  });
});

describe('views', () => {
  it('shows the connect line to logged-in viewers while open, End to the owner and admins only', async () => {
    seedServer('a'); seedServer('bb');
    mgr = manager();
    await mgr.create(ME, 'drill', 'K7QX');
    await flush();
    const l = getLease(db, 1)!;
    const mine = leaseView(db, l, ME, false);
    expect(mine).toMatchObject({ isOwner: true, canEnd: true, state: 'ready', drillCode: 'K7QX', capacity: null });
    expect(mine.connect).toEqual({ host: '10.0.0.2', port: 27015, password: l.password });
    expect(leaseView(db, l, YOU, false)).toMatchObject({ isOwner: false, canEnd: false });
    expect(leaseView(db, l, YOU, true).canEnd).toBe(true);
    mgr.end(1, 'owner');
    await flush();
    const ended = leaseView(db, getLease(db, 1)!, ME, false);
    expect(ended).toMatchObject({ state: 'ended', connect: null, canEnd: false, endReason: 'owner' });
  });

  it('lists open leases for the admin board', async () => {
    seedServer('a'); seedServer('bb');
    mgr = manager();
    await mgr.create(ME, 'park');
    expect(adminLeaseRows(db)).toMatchObject([{ id: 1, kind: 'park', server: 'bb', owner: { steamid: ME, name: 'me' } }]);
  });
});

describe('releaser hooks the lease relies on', () => {
  it('forceRestart restarts a box without restart_after_match, and onSettled runs before the waiters', async () => {
    const id = seedServer('a', { restart: 0 });
    const order: string[] = [];
    const releaser = new ServerReleaser(db, async () => { order.push('clean'); }, { restart: async () => { order.push('restart'); return true; } });
    releaser.onFreed(() => order.push('waiter'));
    releaser.release(id, { restart: true, forceRestart: true }, (back) => order.push(`settled:${back}`));
    expect(getServer(db, id)!.status).toBe('offline');
    await releaser.settled();
    expect(order).toEqual(['clean', 'restart', 'settled:true', 'waiter']);
    expect(getServer(db, id)!.status).toBe('idle');
  });

  it('onSettled says false when the restart never came back', async () => {
    const id = seedServer('a');
    markLive(db, id);
    let back: boolean | null = null;
    const releaser = new ServerReleaser(db, async () => {}, { restart: async () => false });
    releaser.release(id, { forceRestart: true }, (b) => { back = b; });
    await releaser.settled();
    expect(back).toBe(false);
    expect(getServer(db, id)!.status).toBe('offline');
  });
});

describe('admin overview', () => {
  it('marks a leased server as in use for practice, with the owner', async () => {
    const { adminOverview } = await import('../src/admin/matches.js');
    seedServer('a'); seedServer('bb');
    mgr = manager();
    await mgr.create(ME, 'drill');
    const rows = adminOverview(db).servers as unknown as { id: number; status: string; practice: unknown }[];
    expect(rows.find((r) => r.id === 1)!.practice).toBeNull();
    expect(rows.find((r) => r.id === 2)).toMatchObject({ status: 'idle', practice: { leaseId: 1, kind: 'drill', ownerName: 'me', ending: false } });
  });
});
