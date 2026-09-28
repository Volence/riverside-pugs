import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { openDb, type DB } from '../src/db.js';
import { practiceRoutes } from '../src/routes/practice.js';
import { addServer } from '../src/serverPool.js';
import { PracticeLeases, getLease } from '../src/practiceLeases.js';
import { authedCookie } from './helpers.js';
import { upsertPlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';

const OWNER = '76561199000000061';
const FRIEND = '76561199000000062';
const ADMIN = '76561199000000063';

let db: DB;
let app: FastifyInstance;
let leases: PracticeLeases;
let sent: string[][];
const kindOn = new Map<number, string>();
/** What the fake boxes' `status` lists after the header, and what
 *  `sm_practice_who` answers; set by the players and kick tests once their
 *  lease exists (a box with people on it cannot be leased). */
let statusLines = '';
let whoReply = 'Unknown command "sm_practice_who"';
let owner: Record<string, string>;
let friend: Record<string, string>;
let admin: Record<string, string>;

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

function seedServers(n: number): void {
  for (let i = 1; i <= n; i++) {
    const id = addServer(db, { name: `Box ${i}`, host: `10.0.0.${i}`, port: 27015, rconPort: 27015, rconPassword: 'x' });
    db.prepare('UPDATE servers SET restart_after_match = 1 WHERE id = ?').run(id);
  }
}

beforeEach(async () => {
  db = openDb(':memory:');
  sent = [];
  kindOn.clear();
  statusLines = '';
  whoReply = 'Unknown command "sm_practice_who"';
  leases = new PracticeLeases({
    db, publicUrl: 'https://riversidepug.com',
    // A box takes whichever practice cfg was last exec'd on it, and says so
    // in the two cvars setup verifies (the verify logic has its own tests).
    rcon: async (s, cmds) => {
      const reads = cmds.every((c) => c === 'l4d_game_type_name' || c === 'l4d_practice_mode');
      if (!reads) sent.push(cmds);
      return cmds.map((c) => {
        const m = /^exec practice_(park|drill)\.cfg$/.exec(c);
        if (m) kindOn.set(s.id, m[1]);
        const k = kindOn.get(s.id);
        if (c === 'status') return `players : 0 humans, 0 bots (31 max)\n${statusLines}`;
        if (c === 'sm_practice_who') return whoReply;
        if (c === 'l4d_game_type_name') return `"l4d_game_type_name" = "${k === 'park' ? 'Practice' : k === 'drill' ? 'Rotoblin 4v4 PUG' : 'Rotoblin Pub VS'}"`;
        if (c === 'l4d_practice_mode') return `"l4d_practice_mode" = "${k ?? ''}"`;
        return '';
      });
    },
    release: async () => true,
    restart: async () => true,
    sleep: async () => {},
  });
  app = Fastify();
  await app.register(cookie, { secret: 'x'.repeat(32) });
  await app.register(practiceRoutes, { db, replayDir: '', r2: null, leases });
  await app.ready();
  owner = authedCookie(app, db, OWNER);
  friend = authedCookie(app, db, FRIEND);
  admin = authedCookie(app, db, ADMIN);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  // Most tests are about leases, not the rollout switch: open to everyone.
  setSetting(db, 'practice_leasing', 'everyone');
});
afterEach(async () => { leases.stop(); await app.close(); });

const start = (payload: object, cookies: Record<string, string> | null = owner) =>
  app.inject({ method: 'POST', url: '/api/practice/leases', payload, cookies: cookies ?? undefined });

describe('POST /api/practice/leases', () => {
  it('refuses anyone signed out', async () => {
    seedServers(2);
    expect((await start({ kind: 'park' }, null)).statusCode).toBe(401);
  });

  it('starts a park and then hands the same park to the next player', async () => {
    seedServers(3);
    const a = await start({ kind: 'park' });
    expect(a.statusCode).toBe(200);
    // Ownerless: the starter is recorded but is not its owner and cannot end it.
    expect(a.json()).toMatchObject({ joined: false, lease: { id: 1, kind: 'park', server: 'Box 3', isOwner: false, canEnd: false, capacity: 8, owner: { steamid: OWNER } } });
    const b = await start({ kind: 'park' }, friend);
    expect(b.json()).toMatchObject({ joined: true, lease: { id: 1, isOwner: false } });
  });

  it('says all servers are busy when none can be spared', async () => {
    seedServers(1);
    const r = await start({ kind: 'park' });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toBe('All servers are busy with PUGs right now. Try again in a few minutes.');
  });

  it('checks the drill code and preloads it', async () => {
    seedServers(2);
    expect((await start({ kind: 'drill', drillCode: 'ZZZZ' })).statusCode).toBe(404);
    expect((await start({ kind: 'park', drillCode: 'ZZZZ' })).statusCode).toBe(400);
    db.prepare("INSERT INTO practice_drills (code, spec_json, ordinal, half, t_ms) VALUES ('K7QX', '{}', 0, 1, 0)").run();
    const r = await start({ kind: 'drill', drillCode: 'k7qx' });
    expect(r.statusCode).toBe(200);
    expect(r.json().lease.drillCode).toBe('K7QX');
    await flush();
    expect(sent.at(-2)?.at(-1)).toBe('sm_drill_load K7QX');   // the last send is the ready-time status read
  });

  it('a second lease of your own is a 409 naming the first', async () => {
    seedServers(3);
    await start({ kind: 'drill' });
    const r = await start({ kind: 'drill' });
    expect(r.statusCode).toBe(409);
    expect(r.json().leaseId).toBe(1);
  });

  it('rejects an unknown kind', async () => {
    expect((await start({ kind: 'ranked' })).statusCode).toBe(400);
  });
});

describe('GET /api/practice/park', () => {
  it('lists parks without host or password, and tells a logged-in viewer their own lease', async () => {
    seedServers(3);
    await start({ kind: 'park' });
    const anon = await app.inject({ method: 'GET', url: '/api/practice/park' });
    expect(anon.json()).toMatchObject({ available: true, mine: null, parks: [{ id: 1, server: 'Box 3', humans: 0, capacity: 8 }] });
    const body = anon.body;
    expect(body).not.toContain(getLease(db, 1)!.password);
    expect(body).not.toContain('10.0.0.3');
    // A park is nobody's: starting one is not having a server.
    const mine = await app.inject({ method: 'GET', url: '/api/practice/park', cookies: owner });
    expect(mine.json().mine).toBeNull();
    await start({ kind: 'drill' }, owner);
    const drill = await app.inject({ method: 'GET', url: '/api/practice/park', cookies: owner });
    expect(drill.json().mine).toEqual({ id: 2, kind: 'drill' });
  });
});

describe('GET /api/practice/leases/:id', () => {
  it('shows the connect line and password to any logged-in player, not to the signed out', async () => {
    seedServers(2);
    await start({ kind: 'drill' });
    expect((await app.inject({ method: 'GET', url: '/api/practice/leases/1' })).statusCode).toBe(401);
    const r = await app.inject({ method: 'GET', url: '/api/practice/leases/1', cookies: friend });
    expect(r.json()).toMatchObject({
      isOwner: false, canEnd: false,
      connect: { host: '10.0.0.2', port: 27015, password: getLease(db, 1)!.password },
    });
    expect((await app.inject({ method: 'GET', url: '/api/practice/leases/9', cookies: friend })).statusCode).toBe(404);
  });
});

describe('POST /api/practice/leases/:id/end', () => {
  it('only the owner or an admin may end it; an admin end is audited', async () => {
    seedServers(2);
    await start({ kind: 'drill' });
    await flush();
    const end = (c: Record<string, string>) => app.inject({ method: 'POST', url: '/api/practice/leases/1/end', cookies: c });
    expect((await end(friend)).statusCode).toBe(403);
    const r = await end(admin);
    expect(r.statusCode).toBe(200);
    expect(getLease(db, 1)!.end_reason).toBe('admin');
    expect((await end(owner)).statusCode).toBe(409);
    expect(db.prepare("SELECT action, target FROM admin_actions WHERE action = 'practice_end'").all())
      .toEqual([{ action: 'practice_end', target: '1' }]);
  });
});

describe('parks are ownerless', () => {
  it('whoever started a park can start a drill server straight away, and only an admin ends the park', async () => {
    seedServers(4);
    await start({ kind: 'park' });
    const d = await start({ kind: 'drill' });
    expect(d.statusCode).toBe(200);
    expect(d.json().lease.kind).toBe('drill');
    const endPark = (c: Record<string, string>) => app.inject({ method: 'POST', url: '/api/practice/leases/1/end', cookies: c });
    const r = await endPark(owner);
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('Only an admin can close the Practice Park. It closes on its own 5 minutes after everyone leaves.');
    expect((await endPark(admin)).statusCode).toBe(200);
    expect(getLease(db, 1)!.end_reason).toBe('admin');
  });

  it('a second drill server of your own is still refused', async () => {
    seedServers(4);
    await start({ kind: 'drill' });
    const r = await start({ kind: 'drill' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('You already have a drill server open. Close it before starting another.');
  });
});

describe('GET /api/admin/practice/leases', () => {
  it('is admin only', async () => {
    seedServers(2);
    await start({ kind: 'park' });
    expect((await app.inject({ method: 'GET', url: '/api/admin/practice/leases', cookies: friend })).statusCode).toBe(403);
    const r = await app.inject({ method: 'GET', url: '/api/admin/practice/leases', cookies: admin });
    expect(r.json().leases).toMatchObject([{ id: 1, kind: 'park', owner: { steamid: OWNER } }]);
  });
});

describe('POST /api/practice/leases/:id/drill', () => {
  const load = (id: number, code: string, c: Record<string, string>) =>
    app.inject({ method: 'POST', url: `/api/practice/leases/${id}/drill`, payload: { code }, cookies: c });

  it('sends sm_drill_load to the owner\'s ready drill server and records the drill', async () => {
    seedServers(2);
    db.prepare("INSERT INTO practice_drills (code, spec_json, ordinal, half, t_ms) VALUES ('K7QX', '{}', 0, 1, 0), ('M2PB', '{}', 0, 1, 100)").run();
    await start({ kind: 'drill', drillCode: 'K7QX' });
    await flush();
    sent = [];
    const r = await load(1, 'm2pb', owner);
    expect(r.statusCode).toBe(200);
    expect(r.json().drillCode).toBe('M2PB');
    expect(sent).toEqual([['sm_drill_load M2PB']]);
  });

  it('refuses anyone but the owner, unknown codes, the park, and a server still setting up', async () => {
    seedServers(3);
    db.prepare("INSERT INTO practice_drills (code, spec_json, ordinal, half, t_ms) VALUES ('K7QX', '{}', 0, 1, 0)").run();
    await start({ kind: 'drill' });
    await flush();
    expect((await load(1, 'K7QX', friend)).statusCode).toBe(403);
    expect((await load(1, 'ZZZZ', owner)).statusCode).toBe(404);
    db.prepare('UPDATE practice_leases SET ready_at = NULL WHERE id = 1').run();
    expect((await load(1, 'K7QX', owner)).json().error).toMatch(/still setting up/);
    await start({ kind: 'park' }, friend);
    await flush();
    expect((await load(2, 'K7QX', friend)).json().error).toMatch(/not the Practice Park/);
  });

  it('is rate limited per owner', async () => {
    seedServers(2);
    db.prepare("INSERT INTO practice_drills (code, spec_json, ordinal, half, t_ms) VALUES ('K7QX', '{}', 0, 1, 0)").run();
    await start({ kind: 'drill' });
    await flush();
    for (let i = 0; i < 6; i++) expect((await load(1, 'K7QX', owner)).statusCode).toBe(200);
    expect((await load(1, 'K7QX', owner)).statusCode).toBe(429);
  });

  it('passes on the plugin\'s refusal', async () => {
    seedServers(2);
    db.prepare("INSERT INTO practice_drills (code, spec_json, ordinal, half, t_ms) VALUES ('K7QX', '{}', 0, 1, 0)").run();
    await start({ kind: 'drill' });
    await flush();
    const real = leases;
    (real as unknown as { deps: { rcon: unknown } }).deps.rcon = async () => ['PRACTICEERR practice not enabled'];
    const r = await load(1, 'K7QX', owner);
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toBe('Your server refused it: practice not enabled.');
  });
});

describe('the practice_leasing rollout switch', () => {
  it('defaults to admins: only admins can start or join, and nobody else is shown the park', async () => {
    const fresh = openDb(':memory:');
    expect(fresh.prepare("SELECT value FROM settings WHERE key = 'practice_leasing'").get()).toEqual({ value: 'admins' });
    seedServers(3);
    setSetting(db, 'practice_leasing', 'admins');
    const r = await start({ kind: 'park' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('Practice servers are being tried out by admins first. They open to everyone soon.');
    expect((await start({ kind: 'park' }, admin)).statusCode).toBe(200);
    // A player (or a visitor) is shown nothing; an admin sees the park.
    expect((await app.inject({ method: 'GET', url: '/api/practice/park', cookies: owner })).json())
      .toEqual({ available: false, parks: [], mine: null });
    expect((await app.inject({ method: 'GET', url: '/api/practice/park' })).json().available).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/api/practice/park', cookies: admin })).json().parks).toHaveLength(1);
    // Joining follows the switch too.
    expect((await app.inject({ method: 'GET', url: '/api/practice/leases/1', cookies: owner })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/practice/leases/1', cookies: admin })).statusCode).toBe(200);
  });

  it('off keeps everyone out, admins included', async () => {
    seedServers(3);
    setSetting(db, 'practice_leasing', 'off');
    const r = await start({ kind: 'park' }, admin);
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('Practice servers are turned off right now.');
    expect((await app.inject({ method: 'GET', url: '/api/practice/park', cookies: admin })).json().available).toBe(false);
  });

  it('everyone shows the park list to signed-out visitors too', async () => {
    seedServers(3);
    await start({ kind: 'park' });
    const anon = (await app.inject({ method: 'GET', url: '/api/practice/park' })).json();
    expect(anon.available).toBe(true);
    expect(anon.parks).toHaveLength(1);
  });
});

describe('admin: players on a practice server, and kicking one', () => {
  const STATUS = [
    '# userid name uniqueid connected ping loss state rate adr',
    `#  7 1 "Dust" STEAM_1:1:35074132 05:09 33 0 active 128000 192.168.4.85:27005`,
    '# 3 "Bill" BOT active',
    '#  9 2 "Rolling "Six"" STEAM_ID_LAN 1:02:03 61 0 active 30000 10.0.0.9:27005',
    '#end',
  ].join('\n');
  const players = (c: Record<string, string> | undefined) =>
    app.inject({ method: 'GET', url: '/api/admin/practice/1/players', cookies: c });
  const kick = (payload: object, c: Record<string, string> | undefined = admin) =>
    app.inject({ method: 'POST', url: '/api/admin/practice/1/kick', payload, cookies: c });

  async function parkWithPeople() {
    seedServers(2);
    await start({ kind: 'park' });
    await flush();
    statusLines = STATUS;
  }

  it('lists the humans only, with team and trainer when the plugin says, and who the site knows', async () => {
    await parkWithPeople();
    upsertPlayer(db, { steamid: '76561198030413993', name: 'dust on site', avatar: null }, []);
    whoReply = 'WHO 1 Dust team=2 bot=0 alive=1 trainer=1 target=0\nWHO 3 Bill team=2 bot=1 trainer=0\nWHO 2 Rolling "Six" team=1';
    const r = await players(admin);
    expect(r.statusCode).toBe(200);
    expect(r.json().players).toEqual([
      { userid: 7, name: 'Dust', steamid64: '76561198030413993', connectedFor: '05:09', ping: 33, team: 2, trainer: 1, onSite: true },
      { userid: 9, name: 'Rolling "Six"', steamid64: null, connectedFor: '1:02:03', ping: 61, team: 1, trainer: null, onSite: false },
    ]);
  });

  it('still lists them, without teams, where the plugin has no sm_practice_who', async () => {
    await parkWithPeople();
    const r = await players(admin);
    expect(r.json().players.map((p: { name: string; team: number | null }) => [p.name, p.team])).toEqual([['Dust', null], ['Rolling "Six"', null]]);
  });

  it('is admin only', async () => {
    await parkWithPeople();
    expect((await players(undefined)).statusCode).toBe(401);
    expect((await players(owner)).statusCode).toBe(403);
    expect((await kick({ userid: 7 }, owner)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/admin/practice/99/players', cookies: admin })).statusCode).toBe(404);
  });

  it('kicks by userid with a cleaned reason, and logs who was kicked from where', async () => {
    await parkWithPeople();
    sent = [];
    const r = await kick({ userid: 7, reason: 'spawn "camping"; quit\nnow' });
    expect(r.statusCode).toBe(200);
    expect(sent).toEqual([['status'], ['sm_kick #7 "spawn camping quit now"']]);
    const row = db.prepare("SELECT target, detail FROM admin_actions WHERE action = 'practice_kick'").get() as { target: string; detail: string };
    expect(row.target).toBe('76561198030413993');
    expect(JSON.parse(row.detail)).toMatchObject({ name: 'Dust', server: 'Box 2', kind: 'park', reason: 'spawn camping quit now' });
  });

  it('defaults the reason, and refuses a userid not on the box or a closed lease', async () => {
    await parkWithPeople();
    sent = [];
    await kick({ userid: 9 });
    expect(sent.at(-1)).toEqual(['sm_kick #9 "Removed by an admin"']);
    const gone = await kick({ userid: 42 });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error).toBe('That player is not on this server any more.');
    expect((await kick({ userid: 'x' })).statusCode).toBe(400);
    leases.end(1, 'admin');
    await flush();
    expect((await kick({ userid: 7 })).statusCode).toBe(409);
  });
});
