import { afterEach, describe, expect, it } from 'vitest';
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { addServer } from '../src/serverPool.js';
import { fingerprintOf, withoutIgnored } from '../src/balancePatches.js';
import { loadBalanceKnobs } from '../src/balanceKnobs.js';

// Copied verbatim from tests/logAuthWiring.test.ts.
function freeUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.on('error', reject);
    s.bind(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

function send(port: number, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = dgram.createSocket('udp4');
    const pkt = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]), Buffer.from(`L 09/21/2026 - 14:23:01: ${body}\n`, 'utf8')]);
    c.send(pkt, port, '127.0.0.1', (err) => { c.close(); err ? reject(err) : resolve(); });
  });
}

const settle = () => new Promise((r) => setTimeout(r, 80));

const T = 'c'.repeat(32);

describe('balance lines end to end', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); });

  it('tags the round, stores per-round stats and markers', async () => {
    const port = await freeUdpPort();
    const db = openDb(':memory:');
    const sid = addServer(db, { name: 'dallas', host: '127.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, server_id, token) VALUES (1, 1, 'live', 'x', ?, ?)").run(sid, T);
    db.prepare("INSERT INTO match_live (match_id, current_map, last_seen) VALUES (1, 'm', datetime('now'))").run();
    const app = await buildServer({ config: { ...loadConfig({}), devMode: false, logListenPort: port }, db });
    close = () => app.close();

    await send(port, `PUG ${T} ROUND_START map=m half=1 surv=a`);
    await settle();
    await send(port, `PUG ${T} BALANCE half=1 part=0 c:z_tank_health=4000`);
    await send(port, `PUG ${T} BALANCE half=1 part=1 p:l4d_skypounce.smx=100.aaaa0001`);
    await send(port, `PUG ${T} BALANCE_END half=1 parts=2 items=2`);
    await send(port, `PUG ${T} ROUND_MARK half=1 kind=panic t=5000`);
    await send(port, `PUG ${T} ROUND_STAT half=1 steamid=76561198000000001 crowns=1`);
    await send(port, `PUG ${T} ROUND_STATS_END half=1 players=1 sd=1`);
    await settle();

    const round = db.prepare('SELECT patch_id, skill_detect FROM match_rounds WHERE match_id = 1').get() as { patch_id: number; skill_detect: number };
    expect(round.patch_id).toBeGreaterThan(0);
    expect(round.skill_detect).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_round_marks').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT value FROM match_round_stats').get()).toEqual({ value: 1 });
    expect(db.prepare('SELECT server_id FROM balance_server_state').get()).toEqual({ server_id: sid });
  });

  it('a replayed ROUND_START for the same half clears its stale round lines', async () => {
    const port = await freeUdpPort();
    const db = openDb(':memory:');
    const sid = addServer(db, { name: 'dallas', host: '127.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, server_id, token) VALUES (1, 1, 'live', 'x', ?, ?)").run(sid, T);
    db.prepare("INSERT INTO match_live (match_id, current_map, last_seen) VALUES (1, 'm', datetime('now'))").run();
    const app = await buildServer({ config: { ...loadConfig({}), devMode: false, logListenPort: port }, db });
    close = () => app.close();

    await send(port, `PUG ${T} ROUND_START map=m half=1 surv=a`);
    await settle();
    await send(port, `PUG ${T} ROUND_STAT half=1 steamid=76561198000000001 crowns=1`);
    await settle();
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_round_stats').get()).toEqual({ n: 1 });

    // A replayed half re-sends ROUND_START; its stale per-round lines must not survive.
    await send(port, `PUG ${T} ROUND_START map=m half=1 surv=a`);
    await settle();

    expect(db.prepare('SELECT COUNT(*) AS n FROM match_round_stats').get()).toEqual({ n: 0 });
  });

  it('still boots and ignores BALANCE_END when balance/knobs.json fails to load', async () => {
    const port = await freeUdpPort();
    const db = openDb(':memory:');
    const sid = addServer(db, { name: 'dallas', host: '127.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, server_id, token) VALUES (1, 1, 'live', 'x', ?, ?)").run(sid, T);
    db.prepare("INSERT INTO match_live (match_id, current_map, last_seen) VALUES (1, 'm', datetime('now'))").run();

    // Points at a file that does not exist, standing in for a missing or
    // corrupt balance/knobs.json. buildServer must not throw.
    const app = await buildServer({
      config: { ...loadConfig({}), devMode: false, logListenPort: port },
      db,
      balanceKnobsPath: '/nonexistent/balance-knobs-for-testing.json',
    });
    close = () => app.close();

    await send(port, `PUG ${T} ROUND_START map=m half=1 surv=a`);
    await settle();
    await send(port, `PUG ${T} BALANCE half=1 part=0 c:z_tank_health=4000`);
    await send(port, `PUG ${T} BALANCE_END half=1 parts=1 items=1`);
    await settle();

    const round = db.prepare('SELECT patch_id FROM match_rounds WHERE match_id = 1').get() as { patch_id: number | null };
    expect(round.patch_id).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM balance_server_state').get()).toEqual({ n: 0 });
  });

  it('refingerprints stored patches at boot with the loaded knobs', async () => {
    const port = await freeUdpPort();
    const db = openDb(':memory:');
    // Two detected patches recorded before l4d2_spec_stays_spec.smx was on
    // the ignored list: the only difference between them is that plugin.
    const inv = { 'c:z_tank_health': '4000' };
    const withSpec = { ...inv, 'p:l4d2_spec_stays_spec.smx': '10.aaaa0001' };
    const ins = db.prepare("INSERT INTO balance_patches (fingerprint, source, inputs_json, first_seen_at) VALUES (?, 'detected', ?, ?)");
    ins.run(fingerprintOf(inv, []), JSON.stringify(inv), '2026-09-01 00:00:00');
    ins.run(fingerprintOf(withSpec, []), JSON.stringify(withSpec), '2026-09-02 00:00:00');
    const app = await buildServer({ config: { ...loadConfig({}), devMode: false, logListenPort: port }, db });
    close = () => app.close();
    const knobs = loadBalanceKnobs();
    expect(db.prepare('SELECT id, fingerprint FROM balance_patches ORDER BY id').all()).toEqual([
      { id: 1, fingerprint: fingerprintOf(withoutIgnored(inv, knobs.ignored ?? []), knobs.versionless) },
      { id: 2, fingerprint: null },
    ]);
  });

  it('a sighting of the rollout patch confirms the written server', async () => {
    const port = await freeUdpPort();
    const db = openDb(':memory:');
    const sid = addServer(db, { name: 'dallas', host: '127.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    // A queue match: only those confirm a rollout (see confirmOnSighting).
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, server_id, token, origin) VALUES (1, 1, 'live', 'x', ?, ?, 'queue')").run(sid, T);
    db.prepare("INSERT INTO match_live (match_id, current_map, last_seen) VALUES (1, 'm', datetime('now'))").run();
    const knobs = loadBalanceKnobs();
    const inv = { 'c:z_tank_health': '7500' };
    const fp = fingerprintOf(withoutIgnored(inv, knobs.ignored ?? []), knobs.versionless);
    db.prepare("INSERT INTO balance_patches (id, fingerprint, source, inputs_json, first_seen_at) VALUES (5, ?, 'announced', ?, '2026-09-24 00:00:00')")
      .run(fp, JSON.stringify(inv));
    db.prepare("INSERT INTO balance_rollouts (id, patch_id, values_json, content, created_by, created_at) VALUES (1, 5, '{}', 'x', 'a', 'now')").run();
    db.prepare("INSERT INTO balance_rollout_servers (rollout_id, server_id, state, written_at) VALUES (1, ?, 'written', 'now')").run(sid);
    const app = await buildServer({ config: { ...loadConfig({}), devMode: false, logListenPort: port }, db,
      serverCleaner: async () => {}, serverExec: async () => {} });
    close = () => app.close();

    await send(port, `PUG ${T} ROUND_START map=m half=1 surv=a`);
    await settle();
    await send(port, `PUG ${T} BALANCE half=1 part=0 c:z_tank_health=7500`);
    await send(port, `PUG ${T} BALANCE_END half=1 parts=1 items=1`);
    await settle();

    expect(db.prepare('SELECT state FROM balance_rollout_servers WHERE rollout_id = 1').get()).toEqual({ state: 'confirmed' });
  });
});
