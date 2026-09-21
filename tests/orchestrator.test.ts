import { subscribeAdminEvents } from '../src/adminFeed.js';
import { setLogSecret } from '../src/logAuth.js';
import { setSetting } from '../src/settings.js';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import net from 'node:net';
import { openDb, type DB } from '../src/db.js';
import { RealOrchestrator } from '../src/orchestrator.js';
import { ServerReleaser } from '../src/serverRelease.js';
import { addServer, getServer, setHasDlc4 } from '../src/serverPool.js';
import { LogListener } from '../src/logListener.js';
import { currentSeasonId } from '../src/players.js';
import {
  decodePackets, encodePacket, SERVERDATA_AUTH, SERVERDATA_AUTH_RESPONSE,
  SERVERDATA_EXECCOMMAND, SERVERDATA_RESPONSE_VALUE,
} from '../src/rconPacket.js';
import { pugReply } from './helpers.js';
import { deleteCampaign, insertDraft, publishCampaign, setInstall } from '../src/customCampaigns.js';
import { invalidateCampaignCache, setMissionsDirs } from '../src/campaignRegistry.js';

function fakeServer(
  dumpBody: string | ((cmd: string) => string),
  overrides: Record<string, string> = {},
): Promise<{ port: number; cmds: string[]; close: () => Promise<void> }> {
  const cmds: string[] = [];
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf: Buffer = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk as Buffer]);
        const { packets, rest } = decodePackets(buf);
        buf = rest;
        for (const p of packets) {
          if (p.type === SERVERDATA_AUTH) {
            sock.write(encodePacket(0, SERVERDATA_RESPONSE_VALUE, ''));
            sock.write(encodePacket(p.id, SERVERDATA_AUTH_RESPONSE, ''));
          } else if (p.type === SERVERDATA_EXECCOMMAND) {
            cmds.push(p.body);
            // Keyed by command name: how a test stands in for a plugin too old
            // to know a command, which srcds answers with "Unknown command".
            const canned = overrides[p.body.split(' ')[0]];
            sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, canned ?? pugReply(p.body, dumpBody)));
          } else if (p.type === SERVERDATA_RESPONSE_VALUE) {
            // The client's multi-packet terminator. Source answers it with an
            // empty packet and then four junk bytes, both under the marker id.
            sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, ''));
            sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, '\u0000\u0001\u0000\u0000'));
          }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        cmds,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

const IDS = Array.from({ length: 8 }, (_, i) => `7656119800000000${i + 1}`);

function seedMatch(db: DB, campaign = 'no_mercy'): number {
  const season = currentSeasonId(db);
  for (const id of IDS) db.prepare('INSERT INTO players (steamid, name) VALUES (?, ?)').run(id, `p${id.slice(-1)}`);
  const mid = Number(
    db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (?, 'configuring', ?)")
      .run(season, campaign).lastInsertRowid,
  );
  IDS.forEach((id, i) => db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)')
    .run(mid, id, i < 4 ? 'a' : 'b'));
  return mid;
}

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanup) await c(); cleanup = []; });

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

describe('RealOrchestrator', () => {
  it('setupMatch reserves a server, configures it over RCON, marks match live', async () => {
    const srv = await fakeServer('');
    cleanup.push(srv.close);
    const serverId = addServer(db, { name: 's', host: '127.0.0.1', port: 27015, rconPort: srv.port, rconPassword: 'secret' });
    const listener = new LogListener(() => {});
    await listener.listen(0);
    cleanup.push(() => listener.close());

    const releaser = new ServerReleaser(db, async () => {});
    const orch = new RealOrchestrator({
      db, listener,
      logPublicAddress: '127.0.0.1:27500',
      releaser,
      makeRcon: (o) => o,
    });
    const mid = seedMatch(db);
    await orch.setupMatch(mid);

    expect(getServer(db, serverId)!.status).toBe('live');
    const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(mid) as any;
    expect(m.state).toBe('live');
    expect(m.server_id).toBe(serverId);
    expect(m.token).toMatch(/^[0-9a-f]{32}$/);

    expect(srv.cmds.some((c) => c.startsWith('logaddress_add 127.0.0.1:27500'))).toBe(true);
    expect(srv.cmds.filter((c) => c.startsWith('sm_pug_roster'))).toHaveLength(8);
    expect(srv.cmds.some((c) => c.startsWith(`sm_pug_match ${mid} ${m.token} no_mercy`))).toBe(true);
    expect(srv.cmds.some((c) => c.startsWith('changelevel'))).toBe(true);
    // Shown on the ready-up panel; must follow pug_match, which sets the generic one.
    const notice = srv.cmds.indexOf(`l4d_ready_league_notice "Riverside PUG #${mid}"`);
    expect(notice).toBeGreaterThan(srv.cmds.indexOf('exec pug_match'));
    // The leaver rules come from the settings, after pug_match.
    expect(srv.cmds.indexOf('sm_pug_leave_budget 300')).toBeGreaterThan(srv.cmds.indexOf('exec pug_match'));
    expect(srv.cmds).toContain('sm_pug_leave_autounpause 1');
    // The hold ceiling, from clock_hold_max_minutes (30), and what its reply
    // says about the plugin: anything but "Unknown command" is 0.3.4 or later.
    expect(srv.cmds).toContain('sm_pug_leave_hold_max 1800');
    expect(m.leave_control).toBe(1);
  });

  it('notices a plugin too old for clock control, and sets the match up anyway', async () => {
    const srv = await fakeServer('', { sm_pug_leave_hold_max: 'Unknown command "sm_pug_leave_hold_max"' });
    cleanup.push(srv.close);
    addServer(db, { name: 's', host: '127.0.0.1', port: 27015, rconPort: srv.port, rconPassword: 'secret' });
    const listener = new LogListener(() => {});
    await listener.listen(0);
    cleanup.push(() => listener.close());
    const orch = new RealOrchestrator({
      db, listener, logPublicAddress: '127.0.0.1:27500', releaser: new ServerReleaser(db, async () => {}), makeRcon: (o) => o,
    });
    const mid = seedMatch(db);
    await orch.setupMatch(mid);

    const m = db.prepare('SELECT state, leave_control FROM matches WHERE id = ?').get(mid) as { state: string; leave_control: number | null };
    expect(m).toEqual({ state: 'live', leave_control: 0 });
  });

  it('pushes the DEFAULT leaver rules when their settings rows are blank, never 0', async () => {
    // These rows are hand-edited in sqlite, and Number('') is 0, not NaN, so
    // a blank one sails past an integer check. The same bug once aborted every
    // live match through noshow_minutes (src/noShow.ts). Here it is quieter
    // and worse: `sm_pug_leave_hold_max 0` is clamped by the cvar to its own
    // lower bound of 10, so every Hold on that match releases itself after ten
    // seconds while the board's tooltip promises thirty minutes, and
    // `sm_pug_leave_budget 0` turns leave tracking off for the match.
    setSetting(db, 'clock_hold_max_minutes', '');
    setSetting(db, 'leave_budget_seconds', '   ');
    const srv = await fakeServer('');
    cleanup.push(srv.close);
    addServer(db, { name: 's', host: '127.0.0.1', port: 27015, rconPort: srv.port, rconPassword: 'secret' });
    const listener = new LogListener(() => {});
    await listener.listen(0);
    cleanup.push(() => listener.close());
    const orch = new RealOrchestrator({
      db, listener, logPublicAddress: '127.0.0.1:27500', releaser: new ServerReleaser(db, async () => {}), makeRcon: (o) => o,
    });
    await orch.setupMatch(seedMatch(db));

    expect(srv.cmds).toContain('sm_pug_leave_budget 300');
    expect(srv.cmds).toContain('sm_pug_leave_hold_max 1800');
  });

  it('unrelated "Unknown command" console noise in the same reply is not read as an old plugin', async () => {
    // A real console can answer an unrelated command with "Unknown command"
    // in the same window an rcon reply is collected from; the probe must key
    // on the cvar it actually asked about, not on the words anywhere in the body.
    const srv = await fakeServer('', { sm_pug_leave_hold_max: 'Unknown command "sm_cvar"' });
    cleanup.push(srv.close);
    addServer(db, { name: 's', host: '127.0.0.1', port: 27015, rconPort: srv.port, rconPassword: 'secret' });
    const listener = new LogListener(() => {});
    await listener.listen(0);
    cleanup.push(() => listener.close());
    const orch = new RealOrchestrator({
      db, listener, logPublicAddress: '127.0.0.1:27500', releaser: new ServerReleaser(db, async () => {}), makeRcon: (o) => o,
    });
    const mid = seedMatch(db);
    await orch.setupMatch(mid);

    const m = db.prepare('SELECT state, leave_control FROM matches WHERE id = ?').get(mid) as { state: string; leave_control: number | null };
    expect(m).toEqual({ state: 'live', leave_control: 1 });
  });


  it('stamps went_live_at when the match goes live', async () => {
    const srv = await fakeServer('');
    cleanup.push(srv.close);
    addServer(db, { name: 's', host: '127.0.0.1', port: 27015, rconPort: srv.port, rconPassword: 'secret' });
    const listener = new LogListener(() => {});
    await listener.listen(0);
    cleanup.push(() => listener.close());

    const releaser = new ServerReleaser(db, async () => {});
    const orch = new RealOrchestrator({
      db, listener,
      logPublicAddress: '127.0.0.1:27500',
      releaser,
      makeRcon: (o) => o,
    });
    const mid = seedMatch(db);
    await orch.setupMatch(mid);

    const row = db.prepare('SELECT state, went_live_at FROM matches WHERE id = ?').get(mid) as
      { state: string; went_live_at: string | null };
    expect(row.state).toBe('live');
    expect(row.went_live_at).not.toBeNull();
  });

  it('waits rather than aborting when no server is idle', async () => {
    const orch = new RealOrchestrator({
      db, listener: new LogListener(() => {}),
      logPublicAddress: '127.0.0.1:27500', releaser: new ServerReleaser(db, async () => {}), makeRcon: (o) => o,
    });
    const mid = seedMatch(db);
    const pended: number[] = [];
    orch.onNoServer = (id: number) => pended.push(id);

    await orch.setupMatch(mid);

    expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(mid) as any).state)
      .toBe('configuring');
    expect(pended).toEqual([mid]);
  });

  it('setupMatch aborts (and does not pend) when the rcon setup itself fails', async () => {
    const cmds: string[] = [];
    const srv = await new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
      const server = net.createServer((sock) => {
        let buf: Buffer = Buffer.alloc(0);
        sock.on('data', (chunk) => {
          buf = Buffer.concat([buf, chunk as Buffer]);
          const { packets, rest } = decodePackets(buf);
          buf = rest;
          for (const p of packets) {
            if (p.type === SERVERDATA_AUTH) {
              sock.write(encodePacket(0, SERVERDATA_RESPONSE_VALUE, ''));
              sock.write(encodePacket(p.id, SERVERDATA_AUTH_RESPONSE, ''));
            } else if (p.type === SERVERDATA_EXECCOMMAND) {
              cmds.push(p.body);
              // The plugin refuses the match itself, the way it does on the real
              // box for a bad arg: PUGERR rather than PUGOK. expectPugOk throws,
              // and setupMatch must take the catch-block abort path here, not the
              // no-idle-server path: this test is what tells those two apart.
              if (p.body.startsWith('sm_pug_match')) {
                sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, 'PUGERR bad campaign'));
              } else {
                sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, pugReply(p.body, '')));
              }
            } else if (p.type === SERVERDATA_RESPONSE_VALUE) {
              sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, ''));
              sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, '\u0000\u0001\u0000\u0000'));
            }
          }
        });
      });
      server.listen(0, '127.0.0.1', () => {
        resolve({
          port: (server.address() as net.AddressInfo).port,
          close: () => new Promise((r) => server.close(() => r())),
        });
      });
    });
    cleanup.push(srv.close);
    const serverId = addServer(db, { name: 's', host: '127.0.0.1', port: 27015, rconPort: srv.port, rconPassword: 'secret' });
    const listener = new LogListener(() => {});
    await listener.listen(0);
    cleanup.push(() => listener.close());

    const pended: number[] = [];
    const orch = new RealOrchestrator({
      db, listener, logPublicAddress: '127.0.0.1:27500',
      releaser: new ServerReleaser(db, async () => {}),
      makeRcon: (o) => o,
      onNoServer: (id) => pended.push(id),
    });
    const mid = seedMatch(db);

    await orch.setupMatch(mid);

    expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(mid) as any).state).toBe('aborted');
    expect(getServer(db, serverId)!.status).toBe('idle');
    // The invariant this task introduces: a broken setup must never be
    // mistaken for "no server was free" and pended, or a permanently broken
    // box would pin the queue retrying a setup that can never succeed.
    expect(pended).toEqual([]);
  });

  it('finishMatch pulls the dump, persists scores/stats, resets server, completes match', async () => {
    const mid = 1;
    const dump = [
      `DUMP match=${mid}`,
      'MAP map=l4d_hospital01 a=245 b=310',
      ...IDS.map((id, i) => `STAT steamid=${id} team=${i < 4 ? 'a' : 'b'} sidmg=${100 + i} sikill=${i} ck=${i * 10} ff=${i} rev=${i}`),
      'END winner=b a=245 b=310',
    ].join('\n');
    const srv = await fakeServer(dump);
    cleanup.push(srv.close);
    const serverId = addServer(db, { name: 's', host: '127.0.0.1', port: 27015, rconPort: srv.port, rconPassword: 'secret' });
    const listener = new LogListener(() => {});
    await listener.listen(0);
    cleanup.push(() => listener.close());
    const orch = new RealOrchestrator({ db, listener, logPublicAddress: '127.0.0.1:27500', releaser: new ServerReleaser(db, async () => {}), makeRcon: (o) => o });

    const realMid = seedMatch(db);
    expect(realMid).toBe(mid);
    await orch.setupMatch(realMid);
    await orch.finishMatch(realMid);

    const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(realMid) as any;
    expect(m.state).toBe('completed');
    expect(m.winner).toBe('b');
    expect(m.team_a_score).toBe(245);
    expect(m.team_b_score).toBe(310);
    expect(getServer(db, serverId)!.status).toBe('idle');
    const mp = db.prepare('SELECT * FROM match_players WHERE match_id = ? AND player_id = ?').get(realMid, IDS[0]) as any;
    expect(mp.si_damage).toBe(100);
    expect(JSON.parse(mp.stats_json).sidmg).toBe('100');
  });

  it('finishMatch still releases the server and completes the match when sm_pug_abort fails', async () => {
    const mid = 1;
    const dump = [
      `DUMP match=${mid}`,
      'MAP map=l4d_hospital01 a=245 b=310',
      ...IDS.map((id, i) => `STAT steamid=${id} team=${i < 4 ? 'a' : 'b'} sidmg=${100 + i} sikill=${i} ck=${i * 10} ff=${i} rev=${i}`),
      'END winner=b a=245 b=310',
    ].join('\n');

    const cmds: string[] = [];
    const srv = await new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
      const server = net.createServer((sock) => {
        let buf: Buffer = Buffer.alloc(0);
        sock.on('data', (chunk) => {
          buf = Buffer.concat([buf, chunk as Buffer]);
          const { packets, rest } = decodePackets(buf);
          buf = rest;
          for (const p of packets) {
            if (p.type === SERVERDATA_AUTH) {
              sock.write(encodePacket(0, SERVERDATA_RESPONSE_VALUE, ''));
              sock.write(encodePacket(p.id, SERVERDATA_AUTH_RESPONSE, ''));
            } else if (p.type === SERVERDATA_EXECCOMMAND) {
              cmds.push(p.body);
              if (p.body.startsWith('sm_pug_abort')) {
                sock.destroy();
              } else {
                sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, pugReply(p.body, dump)));
              }
            } else if (p.type === SERVERDATA_RESPONSE_VALUE) {
              sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, ''));
              sock.write(encodePacket(p.id, SERVERDATA_RESPONSE_VALUE, '\u0000\u0001\u0000\u0000'));
            }
          }
        });
      });
      server.listen(0, '127.0.0.1', () => {
        resolve({
          port: (server.address() as net.AddressInfo).port,
          close: () => new Promise((r) => server.close(() => r())),
        });
      });
    });
    cleanup.push(srv.close);
    const serverId = addServer(db, { name: 's', host: '127.0.0.1', port: 27015, rconPort: srv.port, rconPassword: 'secret' });
    const listener = new LogListener(() => {});
    await listener.listen(0);
    cleanup.push(() => listener.close());
    const orch = new RealOrchestrator({
      db, listener, logPublicAddress: '127.0.0.1:27500',
      releaser: new ServerReleaser(db, async () => {}),
      // sm_pug_abort never gets a response once the fake server destroys the socket;
      // use a short rcon exec timeout so the test doesn't wait out the default 5s.
      makeRcon: (o) => ({ ...o, timeoutMs: 300 }),
    });

    const realMid = seedMatch(db);
    expect(realMid).toBe(mid);
    await orch.setupMatch(realMid);
    await orch.finishMatch(realMid);

    const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(realMid) as any;
    expect(m.state).toBe('completed');
    expect(getServer(db, serverId)!.status).toBe('idle');
  });

  it('finishMatch is a no-op when called again after the match already completed', async () => {
    const mid = 1;
    const dump = [
      `DUMP match=${mid}`,
      'MAP map=l4d_hospital01 a=245 b=310',
      ...IDS.map((id, i) => `STAT steamid=${id} team=${i < 4 ? 'a' : 'b'} sidmg=${100 + i} sikill=${i} ck=${i * 10} ff=${i} rev=${i}`),
      'END winner=b a=245 b=310',
    ].join('\n');
    const srv = await fakeServer(dump);
    cleanup.push(srv.close);
    const serverId = addServer(db, { name: 's', host: '127.0.0.1', port: 27015, rconPort: srv.port, rconPassword: 'secret' });
    const listener = new LogListener(() => {});
    await listener.listen(0);
    cleanup.push(() => listener.close());
    const orch = new RealOrchestrator({ db, listener, logPublicAddress: '127.0.0.1:27500', releaser: new ServerReleaser(db, async () => {}), makeRcon: (o) => o });

    const realMid = seedMatch(db);
    expect(realMid).toBe(mid);
    await orch.setupMatch(realMid);
    await orch.finishMatch(realMid);

    const before = db.prepare('SELECT * FROM matches WHERE id = ?').get(realMid) as any;
    expect(before.state).toBe('completed');
    expect(getServer(db, serverId)!.status).toBe('idle');

    await expect(orch.finishMatch(realMid)).resolves.not.toThrow();

    const after = db.prepare('SELECT * FROM matches WHERE id = ?').get(realMid) as any;
    expect(after.state).toBe('completed');
    expect(after.ended_at).toBe(before.ended_at);
    expect(getServer(db, serverId)!.status).toBe('idle');
  });

  // pug-match 0.3.3 echoes the nonce and its state. WriteDump answers in ANY
  // state, so before this a forged MATCH_END (it needs the token, which crosses
  // the cleartext log stream) completed and rated a match at its current score.
  describe('finishMatch against a plugin that echoes the nonce', () => {
    const echoDump = (state: string, nonceOf: (cmd: string) => string) => (cmd: string): string => {
      const n = nonceOf(cmd);
      return [
        `DUMP match=1 skilldetect=0 nonce=${n} state=${state}`,
        'MAP map=l4d_hospital01 a=245 b=310',
        ...IDS.map((id, i) => `STAT steamid=${id} team=${i < 4 ? 'a' : 'b'} joined_map=0 sidmg=${100 + i} sikill=${i} ck=${i * 10} ff=${i} rev=${i}`),
        `END winner=b a=245 b=310 nonce=${n} state=${state}`,
      ].join('\n');
    };
    const sentNonce = (cmd: string): string => cmd.split(' ')[2] ?? '';

    async function rig(dump: (cmd: string) => string) {
      const srv = await fakeServer(dump);
      cleanup.push(srv.close);
      const serverId = addServer(db, { name: 's', host: '127.0.0.1', port: 27015, rconPort: srv.port, rconPassword: 'secret' });
      const listener = new LogListener(() => {});
      await listener.listen(0);
      cleanup.push(() => listener.close());
      const orch = new RealOrchestrator({ db, listener, logPublicAddress: '127.0.0.1:27500', releaser: new ServerReleaser(db, async () => {}), makeRcon: (o) => o });
      const mid = seedMatch(db);
      await orch.setupMatch(mid);
      return { srv, serverId, orch, mid };
    }

    it('sends a fresh nonce after the token, and completes on state=ended', async () => {
      const { srv, orch, mid } = await rig(echoDump('ended', sentNonce));
      expect(await orch.finishMatch(mid)).toBe('completed');
      const dumps = srv.cmds.filter((c) => c.startsWith('sm_pug_dump '));
      expect(dumps).toHaveLength(1);
      expect(dumps[0]).toMatch(/^sm_pug_dump [0-9a-f]{32} [0-9a-f]{16}$/);
      expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(mid) as any).state).toBe('completed');
    });

    it('does NOT complete, rate or release a match the plugin says is still live, and tells an admin', async () => {
      const problems: string[] = [];
      const unsub = subscribeAdminEvents((e) => { if (e.kind === 'problem') problems.push(e.text); });
      cleanup.push(async () => unsub());
      const { srv, serverId, orch, mid } = await rig(echoDump('live', sentNonce));
      expect(await orch.finishMatch(mid)).toBe('not_ended');
      expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(mid) as any).state).toBe('live');
      expect(db.prepare('SELECT COUNT(*) AS n FROM rating_history').get()).toEqual({ n: 0 });
      expect(getServer(db, serverId)!.status).toBe('live');
      // The plugin must keep the match: no abort behind a dump we refused.
      expect(srv.cmds.some((c) => c.startsWith('sm_pug_abort'))).toBe(false);
      expect(problems.some((t) => t.includes(`#${mid}`))).toBe(true);
    });

    it('leaves the match live for a retry when the answer carries somebody else\'s nonce', async () => {
      const { orch, mid } = await rig(echoDump('ended', () => 'ffffffffffffffff'));
      expect(await orch.finishMatch(mid)).toBe('retry');
      expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(mid) as any).state).toBe('live');
    });
  });

  // Audit 2026-09-21 item 15: a server with a log secret is given it on the
  // setup connection, so its plugins sign every line of the match.
  describe('the log secret', () => {
    const SECRET = 'a'.repeat(32);
    async function rig(secret: string | null) {
      const srv = await fakeServer('');
      cleanup.push(srv.close);
      const serverId = addServer(db, { name: 's', host: '127.0.0.1', port: 27015, rconPort: srv.port, rconPassword: 'secret' });
      if (secret) setLogSecret(db, serverId, secret);
      const listener = new LogListener(() => {});
      await listener.listen(0);
      cleanup.push(() => listener.close());
      const orch = new RealOrchestrator({ db, listener, logPublicAddress: '127.0.0.1:27500', releaser: new ServerReleaser(db, async () => {}), makeRcon: (o) => o });
      return { srv, serverId, orch };
    }

    it('is pushed during setup with rcon logging off around it, since srcds logs every rcon command onto the very stream this protects', async () => {
      const { srv, orch } = await rig(SECRET);
      await orch.setupMatch(seedMatch(db));
      const at = srv.cmds.indexOf(`sm_pug_log_secret "${SECRET}"`);
      expect(at).toBeGreaterThan(-1);
      expect(srv.cmds[at - 1]).toBe('sv_rcon_log 0');
      expect(srv.cmds[at + 1]).toBe('sv_rcon_log 1');
      // Before the match is configured, so MATCH lines are signed from the first.
      expect(at).toBeLessThan(srv.cmds.findIndex((c) => c.startsWith('sm_pug_match')));
    });

    it('is not mentioned to a server that has none', async () => {
      const { srv, orch } = await rig(null);
      await orch.setupMatch(seedMatch(db));
      expect(srv.cmds.some((c) => c.includes('sm_pug_log_secret') || c.includes('sv_rcon_log'))).toBe(false);
    });

    it('goes along with sm_pug_setid too, which is the only rcon a match started in game ever gets', async () => {
      const { srv, serverId, orch } = await rig(SECRET);
      await orch.assignMatchId(serverId, '0123456789abcdef0123456789abcdef', 7).catch(() => {});
      expect(srv.cmds).toContain(`sm_pug_log_secret "${SECRET}"`);
    });
  });

  it('runs beforeLive on the setup connection after the roster and before the changelevel', async () => {
    const srv = await fakeServer('');
    cleanup.push(srv.close);
    addServer(db, { name: 's', host: '127.0.0.1', port: 27015, rconPort: srv.port, rconPassword: 'secret' });
    const listener = new LogListener(() => {});
    await listener.listen(0);
    cleanup.push(() => listener.close());
    const orch = new RealOrchestrator({
      db, listener, logPublicAddress: '127.0.0.1:27500',
      releaser: new ServerReleaser(db, async () => {}), makeRcon: (o) => o,
      beforeLive: async (rcon) => { await rcon.exec('sm_addban 0 "STEAM_1:1:35074132" "probe"'); },
    });
    const mid = seedMatch(db);
    await orch.setupMatch(mid);
    const ban = srv.cmds.indexOf('sm_addban 0 "STEAM_1:1:35074132" "probe"');
    const lastRoster = srv.cmds.map((c) => c.startsWith('sm_pug_roster')).lastIndexOf(true);
    const change = srv.cmds.findIndex((c) => c.startsWith('changelevel'));
    expect(ban).toBeGreaterThan(lastRoster);
    expect(ban).toBeLessThan(change);
  });

  it('a failing beforeLive does not cost the match its server', async () => {
    const srv = await fakeServer('');
    cleanup.push(srv.close);
    const serverId = addServer(db, { name: 's', host: '127.0.0.1', port: 27015, rconPort: srv.port, rconPassword: 'secret' });
    const listener = new LogListener(() => {});
    await listener.listen(0);
    cleanup.push(() => listener.close());
    const orch = new RealOrchestrator({
      db, listener, logPublicAddress: '127.0.0.1:27500',
      releaser: new ServerReleaser(db, async () => {}), makeRcon: (o) => o,
      beforeLive: async () => { throw new Error('ban push exploded'); },
    });
    const mid = seedMatch(db);
    await orch.setupMatch(mid);
    expect(getServer(db, serverId)!.status).toBe('live');
    expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(mid) as { state: string }).state).toBe('live');
  });
});

describe('custom campaign availability', () => {
  // Same rcon fake and orchestrator wiring as the RealOrchestrator suite
  // above, factored out here because every test in this block needs it.
  async function setup(): Promise<{ orch: RealOrchestrator; cmds: string[]; serverId: number }> {
    const srv = await fakeServer('');
    cleanup.push(srv.close);
    const serverId = addServer(db, { name: 's', host: '127.0.0.1', port: 27015, rconPort: srv.port, rconPassword: 'secret' });
    const listener = new LogListener(() => {});
    await listener.listen(0);
    cleanup.push(() => listener.close());
    const orch = new RealOrchestrator({
      db, listener,
      logPublicAddress: '127.0.0.1:27500',
      releaser: new ServerReleaser(db, async () => {}),
      makeRcon: (o) => o,
    });
    return { orch, cmds: srv.cmds, serverId };
  }

  function publishCustom(serverId: number, installed: boolean): void {
    insertDraft(db, {
      slug: 'dbd', name: 'DBD', vpkFilename: 'dbd.vpk',
      sizeBytes: 9, sha256: 'a'.repeat(64), uploadedBy: null,
    }, [{ map: 'dbd1_alley', display: null, isFinale: true }]);
    publishCampaign(db, 'dbd', 'DBD');
    if (installed) setInstall(db, 'dbd', serverId, 'installed');
    invalidateCampaignCache();
  }

  // The pool flag can be stale by exactly the window that matters: a server
  // rebuilt between the vote and the changelevel has no VPK, and changelevel
  // into a map it does not have strands the match on a black screen with no
  // error anyone sees. Refusing the setup is the visible failure. setupMatch
  // catches its own setup errors (see the "aborts" test above), so the
  // observable result is an aborted match, not a rejected promise.
  it('refuses a custom campaign the claimed server does not have', async () => {
    const { orch, cmds, serverId } = await setup();
    publishCustom(serverId, false);
    const mid = seedMatch(db, 'dbd');

    await orch.setupMatch(mid);

    expect(cmds.some((c) => c.startsWith('changelevel'))).toBe(false);
    expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(mid) as any).state).toBe('aborted');
  });

  it('allows it once that server reports installed', async () => {
    const { orch, cmds, serverId } = await setup();
    publishCustom(serverId, true);
    const mid = seedMatch(db, 'dbd');

    await orch.setupMatch(mid);

    expect(cmds).toContain('changelevel dbd1_alley');
    expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(mid) as any).state).toBe('live');
  });

  // Defence in depth. parseMission refuses such a name at upload, but a row
  // can predate that check or be written some other way, and changelevel is
  // an rcon command line: ';' starts a second command.
  it('refuses to changelevel to a first map that is not a map name', async () => {
    const { orch, cmds, serverId } = await setup();
    insertDraft(db, {
      slug: 'evil', name: 'Evil', vpkFilename: 'evil.vpk',
      sizeBytes: 9, sha256: 'e'.repeat(64), uploadedBy: null,
    }, [{ map: 'x;rcon_password pwned', display: null, isFinale: true }]);
    publishCampaign(db, 'evil', 'Evil');
    setInstall(db, 'evil', serverId, 'installed');
    invalidateCampaignCache();
    const mid = seedMatch(db, 'evil');

    await orch.setupMatch(mid);

    expect(cmds.some((c) => c.startsWith('changelevel'))).toBe(false);
    expect(cmds.some((c) => c.includes('rcon_password'))).toBe(false);
    expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(mid) as any).state).toBe('aborted');
  });

  // Stock campaigns have no VPK to install, so they must not be gated by a
  // table that will never have a row for them.
  it('never gates a stock campaign on an install row', async () => {
    const { orch, cmds } = await setup();
    const mid = seedMatch(db, 'dead_air');

    await orch.setupMatch(mid);

    expect(cmds).toContain('changelevel l4d_vs_airport01_greenhouse');
    expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(mid) as any).state).toBe('live');
  });

  // A deleted campaign has no registry entry at all, so entry?.custom used
  // to read as undefined and skip the guard entirely: firstMapOf then fell
  // back to No Mercy while the match row still said 'dbd'. map_pool pruning
  // is supposed to keep this from ever being voted for, but this match row
  // already exists (queued before the delete, say), so the guard has to
  // catch it on its own rather than trust the pool was kept clean.
  it('refuses a campaign the registry has lost, not just an uninstalled custom one', async () => {
    const { orch, cmds, serverId } = await setup();
    publishCustom(serverId, true);
    const mid = seedMatch(db, 'dbd');
    deleteCampaign(db, 'dbd');
    invalidateCampaignCache();

    await orch.setupMatch(mid);

    expect(cmds.some((c) => c.startsWith('changelevel'))).toBe(false);
    expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(mid) as any).state).toBe('aborted');
  });
});

describe('dlc4 campaign availability', () => {
  // Same rcon fake and orchestrator wiring as the custom-campaign suite above.
  async function setup(): Promise<{ orch: RealOrchestrator; cmds: string[]; serverId: number }> {
    const srv = await fakeServer('');
    cleanup.push(srv.close);
    const serverId = addServer(db, { name: 's', host: '127.0.0.1', port: 27015, rconPort: srv.port, rconPassword: 'secret' });
    const listener = new LogListener(() => {});
    await listener.listen(0);
    cleanup.push(() => listener.close());
    const orch = new RealOrchestrator({
      db, listener,
      logPublicAddress: '127.0.0.1:27500',
      releaser: new ServerReleaser(db, async () => {}),
      makeRcon: (o) => o,
    });
    return { orch, cmds: srv.cmds, serverId };
  }

  // The pool flag can be stale the same way the custom-campaign one can: a
  // server added or re-enabled after the vote has no mappack, and
  // changelevel into c1m1_hotel with no left4dead_dlc4 strands the match on
  // a black screen with no error anyone sees.
  it('refuses a dlc4 campaign on a server that does not have the mappack', async () => {
    const { orch, cmds, serverId } = await setup();
    setHasDlc4(db, serverId, false);
    const mid = seedMatch(db, 'dead_center');

    await orch.setupMatch(mid);

    expect(cmds.some((c) => c.startsWith('changelevel'))).toBe(false);
    expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(mid) as any).state).toBe('aborted');
  });

  it('allows a dlc4 campaign once that server reports the mappack installed', async () => {
    const { orch, cmds, serverId } = await setup();
    setHasDlc4(db, serverId, true);
    const mid = seedMatch(db, 'dead_center');

    await orch.setupMatch(mid);

    expect(cmds).toContain('changelevel c1m1_hotel');
    expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(mid) as any).state).toBe('live');
  });
});

describe('stop-after map', () => {
  // Same rcon fake and orchestrator wiring as the other describe blocks in
  // this file.
  async function setup(): Promise<{ orch: RealOrchestrator; cmds: string[] }> {
    const srv = await fakeServer('');
    cleanup.push(srv.close);
    addServer(db, { name: 's', host: '127.0.0.1', port: 27015, rconPort: srv.port, rconPassword: 'secret' });
    const listener = new LogListener(() => {});
    await listener.listen(0);
    cleanup.push(() => listener.close());
    const orch = new RealOrchestrator({
      db, listener,
      logPublicAddress: '127.0.0.1:27500',
      releaser: new ServerReleaser(db, async () => {}),
      makeRcon: (o) => o,
    });
    return { orch, cmds: srv.cmds };
  }

  function publishFive(): void {
    insertDraft(db, {
      slug: 'five', name: 'Five', vpkFilename: 'five.vpk',
      sizeBytes: 1, sha256: 'a'.repeat(64), uploadedBy: null,
    }, [1, 2, 3, 4, 5].map((n) => ({ map: `m${n}`, display: null, isFinale: n === 5 })));
    publishCampaign(db, 'five', 'Five');
    invalidateCampaignCache();
  }

  const matchCmd = (cmds: string[]) => cmds.find((c) => c.startsWith('sm_pug_match')) ?? '';

  it('sends the stop map as a fourth argument when one is known', async () => {
    const { orch, cmds } = await setup();
    publishFive();
    const mid = seedMatch(db, 'five');

    await orch.setupMatch(mid);

    // Default rule: one before the last, so the fourth of five. Quoted like
    // the roster arg above it, since a chapter map name is uploaded data, not
    // something the backend can trust to be one bare token.
    expect(matchCmd(cmds).endsWith(' "m4"')).toBe(true);
  });

  // A map name out of an uploaded VPK is refused at upload now (parseMission),
  // and the orchestrator asserts it again rather than trust every row to have
  // come through that door. Quotes would carry a space, but they do not stop
  // a newline ending the command, so there is one rule for every name: the
  // match is refused before the line is ever sent.
  it.each([['a space', 'm two'], ['a newline', 'm2\nrcon_password pwned']])(
    'refuses a stop map whose name contains %s', async (_what, bad) => {
      const { orch, cmds } = await setup();
      insertDraft(db, {
        slug: 'spacey', name: 'Spacey', vpkFilename: 'spacey.vpk',
        sizeBytes: 1, sha256: 'b'.repeat(64), uploadedBy: null,
      }, [1, 2, 3].map((n) => ({ map: n === 2 ? bad : `m${n}`, display: null, isFinale: n === 3 })));
      publishCampaign(db, 'spacey', 'Spacey');
      invalidateCampaignCache();
      const mid = seedMatch(db, 'spacey');

      await orch.setupMatch(mid);

      expect(matchCmd(cmds)).toBe('');
      expect(cmds.some((c) => c.includes('rcon_password'))).toBe(false);
      expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(mid) as any).state).toBe('aborted');
    });

  // This is the regression guard for every match the site already runs. A
  // stock campaign has no known chapters until a missions directory is
  // configured, so the command must keep its exact old shape: three
  // arguments, no trailing anything.
  it('sends three arguments when no stop map is known', async () => {
    const { orch, cmds } = await setup();
    setMissionsDirs([]);
    invalidateCampaignCache();
    const mid = seedMatch(db, 'dead_air');

    await orch.setupMatch(mid);

    expect(matchCmd(cmds)).toMatch(/^sm_pug_match \d+ \S+ dead_air$/);
  });
});

describe('firstMapOf', () => {
  // Base game campaigns use l4d_vs_ BSPs (the versus variants, since the plain
  // l4d_ ones are co-op-only). Dlc4 campaigns use plain map names like c1m1_hotel
  // because those BSPs serve both modes.
  it('returns the correct first map for each campaign', async () => {
    const { firstMapOf } = await import('../src/campaignRegistry.js');
    const { CAMPAIGNS, DLC4_CAMPAIGNS } = await import('../src/campaigns.js');
    const db = openDb(':memory:');
    for (const slug of Object.keys(CAMPAIGNS)) {
      const map = firstMapOf(db, slug);
      if (DLC4_CAMPAIGNS.has(slug)) {
        // dlc4 campaigns use plain names like c1m1_hotel
        expect(map).toMatch(/^c\d+m\d+/);
      } else {
        // base game campaigns use l4d_vs_ BSPs
        expect(map).toMatch(/^l4d_vs_/);
      }
    }
    expect(firstMapOf(db, 'unknown')).toMatch(/^l4d_vs_/);
  });
});
