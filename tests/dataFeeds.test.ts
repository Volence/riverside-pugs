import { describe, it, expect, beforeEach } from 'vitest';
import { parseLogDatagram } from '../src/logParse.js';
import { openDb, type DB } from '../src/db.js';
import { recordLiveEvent } from '../src/liveView.js';
import { siLifeOf } from '../src/dataFeedParse.js';
import {
  funnelFor, isL4d2PortMap, isMissingReason, packStatus, recordDataFeed, resetRoundFeeds,
} from '../src/dataFeeds.js';
import type { DataFeedEvent } from '../src/dataFeedParse.js';

const T = 'c'.repeat(32);
const A = '76561198000000001';
const B = '76561198000000002';
const NOW_S = 1_791_000_000; // 2026-10-03, a plausible server clock

function framed(body: string): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]),
    Buffer.from(`L 10/10/2026 - 01:00:00: ${body}\n`, 'utf8'),
  ]);
}
const parse = (body: string) => parseLogDatagram(framed(`PUG ${T} ${body}`));
const feed = (body: string) => parse(body) as DataFeedEvent;

describe('data feed grammar', () => {
  it('parses each CONN stage', () => {
    expect(parse(`CONN steamid=${A} stage=connect t=${NOW_S} map=c1m1_hotel`)).toEqual({
      kind: 'conn', token: T, steamid: A, stage: 'connect', at: NOW_S, map: 'c1m1_hotel',
      team: null, pre: null, secs: null, reason: null,
    });
    expect(parse(`CONN steamid=${A} stage=team t=${NOW_S} map=c1m1_hotel team=3`)).toMatchObject({ stage: 'team', team: 3 });
    expect(parse(`CONN steamid=${A} stage=ready t=${NOW_S} map=c1m1_hotel`)).toMatchObject({ stage: 'ready' });
  });

  it('takes the drop reason as the rest of the line and reads no key out of it', () => {
    // A client writes its own disconnect reason. One that spells out keys
    // must not move the steamid, the stage or the pre flag.
    const ev = parse(`CONN steamid=${A} stage=drop t=${NOW_S} map=c1m1_hotel pre=1 secs=41 reason=Missing map maps/c1m1_hotel.bsp, disconnecting steamid=${B} pre=0 stage=ready`);
    expect(ev).toMatchObject({
      kind: 'conn', steamid: A, stage: 'drop', pre: true, secs: 41,
      reason: `Missing map maps/c1m1_hotel.bsp, disconnecting steamid=${B} pre=0 stage=ready`,
    });
  });

  it('refuses a CONN with a bad id, stage, clock or map', () => {
    expect(parse(`CONN steamid=123 stage=connect t=${NOW_S} map=c1m1_hotel`)).toBeNull();
    expect(parse(`CONN steamid=${A} stage=loading t=${NOW_S} map=c1m1_hotel`)).toBeNull();
    expect(parse(`CONN steamid=${A} stage=connect t=12 map=c1m1_hotel`)).toBeNull();
    expect(parse(`CONN steamid=${A} stage=connect t=${NOW_S} map=c1m1;quit`)).toBeNull();
  });

  it('parses MAPLOAD', () => {
    expect(parse(`MAPLOAD map=l4d_vs_farm01_hilltop t=${NOW_S}`)).toEqual({ kind: 'map_load', token: T, map: 'l4d_vs_farm01_hilltop', at: NOW_S });
  });

  it('parses DOWN, with -1 flow read as unknown and an unknown attacker as null', () => {
    expect(parse(`DOWN half=2 t=91234 steamid=${A} kind=incap cause=punch by=${B} flow=47 prog=52 pinned=0`)).toEqual({
      kind: 'down', token: T, half: 2, tMs: 91234, steamid: A, down: 'incap', cause: 'punch', by: B, flow: 47, prog: 52, pinned: false,
    });
    expect(parse(`DOWN half=1 t=5 steamid=${A} kind=death cause=bleed by=0 flow=-1 prog=-1 pinned=1`)).toMatchObject({
      down: 'death', cause: 'bleed', by: null, flow: null, prog: null, pinned: true,
    });
    expect(parse(`DOWN half=1 t=5 steamid=${A} kind=ledge cause=fall by=0 flow=1 prog=1 pinned=0`)).toBeNull();
  });

  it('parses ROUND_FLOW', () => {
    expect(parse(`ROUND_FLOW half=1 prog=88 p=${A}:88,${B}:-1`)).toEqual({
      kind: 'round_flow', token: T, half: 1, prog: 88, flows: [{ steamid: A, flow: 88 }, { steamid: B, flow: null }],
    });
  });

  it('parses SILIFE records and refuses a line with a malformed one', () => {
    const rec1 = `${A}:3:12000:19500:40:35:21000:25:6:30500:skeet:${B}:16`;
    const rec2 = `${A}:5:-1:60000:55:50:61000:300:0:90000:pass:0:-1`;
    const ev = parse(`SILIFE half=2 i=4 l=${rec1},${rec2}`);
    expect(ev).toMatchObject({ kind: 'si_lives', half: 2, first: 4 });
    expect((ev as Extract<DataFeedEvent, { kind: 'si_lives' }>).lives).toEqual([
      { steamid: A, zc: 3, ghostMs: 12000, spawnMs: 19500, spawnFlow: 40, spawnProg: 35, firstHitMs: 21000, dmg: 25, dmgIncapped: 6, endMs: 30500, end: 'skeet', killer: B, respawnS: 16 },
      { steamid: A, zc: 5, ghostMs: null, spawnMs: 60000, spawnFlow: 55, spawnProg: 50, firstHitMs: 61000, dmg: 300, dmgIncapped: 0, endMs: 90000, end: 'pass', killer: null, respawnS: null },
    ]);
    expect(parse(`SILIFE half=2 i=0 l=${rec1},${A}:3:1:2`)).toBeNull();
    expect(siLifeOf(`${A}:3:1:2:3:4:5:-6:0:9:shot:0:1`)).toBeNull();
  });

  it('parses SILIFE_END', () => {
    expect(parse('SILIFE_END half=1 lives=37 dropped=0')).toEqual({ kind: 'si_lives_end', token: T, half: 1, lives: 37, dropped: 0 });
  });

  it('adds flow, prog and cause to an EVENT and leaves an old EVENT exactly as it was', () => {
    const old = parse(`EVENT seq=7 kind=incap actor=${A} target=${B} value=0 half=1 t=1000`);
    expect(old).toEqual({ kind: 'live_event', token: T, seq: 7, event: 'incap', actor: A, target: B, value: 0, half: 1, tMs: 1000 });
    expect(parse(`EVENT seq=7 kind=incap actor=${A} target=${B} value=0 half=1 t=1000 flow=33 prog=41 cause=rock`))
      .toEqual({ kind: 'live_event', token: T, seq: 7, event: 'incap', actor: A, target: B, value: 0, half: 1, tMs: 1000, flow: 33, prog: 41, cause: 'rock' });
    expect(parse(`EVENT seq=8 kind=tank_spawn actor=${A} target=0 value=0 half=1 t=1000 flow=-1 prog=60`))
      .toMatchObject({ flow: null, prog: 60 });
  });

  it('keeps an unknown verb unknown', () => {
    expect(parse('SILIFE_SOMETHING half=1')).toBeNull();
  });
});

describe('map pack helpers', () => {
  it('knows an L4D2-port map from a stock one', () => {
    expect(isL4d2PortMap('c1m1_hotel')).toBe(true);
    expect(isL4d2PortMap('c13m2_southpinestream')).toBe(true);
    expect(isL4d2PortMap('l4d_river01_docks')).toBe(false); // Passifice, but stock L4D1
    expect(isL4d2PortMap('l4d_vs_hospital01_apartment')).toBe(false);
    expect(isL4d2PortMap('c9m1_alleys')).toBe(false); // not a campaign on the site
  });

  it('reads a missing-map reason and not an ordinary leave', () => {
    expect(isMissingReason('Missing map maps/c1m1_hotel.bsp,  disconnecting')).toBe(true);
    expect(isMissingReason("Couldn't load map c2m1_highway")).toBe(true);
    expect(isMissingReason('Disconnect by user.')).toBe(false);
    expect(isMissingReason(null)).toBe(false);
  });
});

describe('data feed storage', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, token) VALUES (1, 1, 'live', 'dead_center', ?)").run(T);
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team) VALUES (1, 0, 1, 'a')").run();
  });

  it('stores funnel rows once each, and a configuring match counts', () => {
    db.prepare("UPDATE matches SET state = 'configuring'").run();
    const ev = feed(`CONN steamid=${A} stage=connect t=${NOW_S} map=c1m1_hotel`);
    expect(recordDataFeed(db, ev)).toBe(true);
    expect(recordDataFeed(db, ev)).toBe(false); // the duplicate datagram
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_connect_funnel').get()).toEqual({ n: 1 });
  });

  it('marks the pack ok on an in-game port map and missing on a loading drop with a missing reason', () => {
    recordDataFeed(db, feed(`CONN steamid=${A} stage=drop t=${NOW_S} map=c1m1_hotel pre=1 secs=30 reason=Missing map maps/c1m1_hotel.bsp, disconnecting`));
    expect(packStatus(db, A)).toBe('missing');
    recordDataFeed(db, feed(`CONN steamid=${A} stage=ingame t=${NOW_S + 600} map=c1m1_hotel`));
    expect(packStatus(db, A)).toBe('ok');
    // A generic loading drop only makes someone never seen on a port map a suspect.
    recordDataFeed(db, feed(`CONN steamid=${A} stage=drop t=${NOW_S + 700} map=c1m2_streets pre=1 secs=9 reason=Disconnect by user.`));
    expect(packStatus(db, A)).toBe('ok');
    recordDataFeed(db, feed(`CONN steamid=${B} stage=drop t=${NOW_S} map=c1m1_hotel pre=1 secs=9 reason=Disconnect by user.`));
    expect(packStatus(db, B)).toBe('suspect');
    // Nothing on a stock map says anything about the pack.
    const C = '76561198000000003';
    recordDataFeed(db, feed(`CONN steamid=${C} stage=drop t=${NOW_S} map=l4d_vs_farm01_hilltop pre=1 secs=9 reason=Missing map maps/x.bsp`));
    expect(packStatus(db, C)).toBe('unknown');
  });

  it('reads the funnel stage per player for the newest map', () => {
    const lines = [
      `MAPLOAD map=c1m1_hotel t=${NOW_S}`,
      `CONN steamid=${A} stage=connect t=${NOW_S + 1} map=c1m1_hotel`,
      `CONN steamid=${B} stage=connect t=${NOW_S + 2} map=c1m1_hotel`,
      `CONN steamid=${A} stage=ingame t=${NOW_S + 40} map=c1m1_hotel`,
      `CONN steamid=${A} stage=team t=${NOW_S + 41} map=c1m1_hotel team=2`,
    ];
    for (const l of lines) recordDataFeed(db, feed(l));
    let f = funnelFor(db, 1, null);
    expect(f.get(A)).toEqual({ stage: 'on_team', pack: 'ok' });
    expect(f.get(B)).toEqual({ stage: 'loading', pack: 'unknown' });
    // Map 2: no new connect, so A is loading it until its ingame arrives.
    recordDataFeed(db, feed(`MAPLOAD map=c1m2_streets t=${NOW_S + 900}`));
    f = funnelFor(db, 1, null);
    expect(f.get(A)?.stage).toBe('loading');
    recordDataFeed(db, feed(`CONN steamid=${A} stage=ingame t=${NOW_S + 930} map=c1m2_streets`));
    recordDataFeed(db, feed(`CONN steamid=${A} stage=ready t=${NOW_S + 950} map=c1m2_streets`));
    recordDataFeed(db, feed(`CONN steamid=${B} stage=drop t=${NOW_S + 960} map=c1m2_streets pre=1 secs=3 reason=Disconnect by user.`));
    f = funnelFor(db, 1, null);
    expect(f.get(A)?.stage).toBe('ready');
    expect(f.get(B)?.stage).toBe('dropped');
  });

  it('stores downs, round flow and SI lives on the round, idempotently', () => {
    const down = feed(`DOWN half=1 t=91234 steamid=${A} kind=incap cause=rock by=${B} flow=47 prog=52 pinned=0`);
    recordDataFeed(db, down);
    recordDataFeed(db, down);
    expect(db.prepare('SELECT ordinal, half, steamid, kind, cause, attacker, flow, prog FROM match_survivor_downs').all())
      .toEqual([{ ordinal: 0, half: 1, steamid: A, kind: 'incap', cause: 'rock', attacker: B, flow: 47, prog: 52 }]);

    recordDataFeed(db, feed(`ROUND_FLOW half=1 prog=60 p=${A}:47`));
    recordDataFeed(db, feed('SILIFE_END half=1 lives=2 dropped=0'));
    expect(db.prepare('SELECT end_prog, end_flows, si_lives, si_dropped FROM match_round_feeds').get())
      .toEqual({ end_prog: 60, end_flows: JSON.stringify({ [A]: 47 }), si_lives: 2, si_dropped: 0 });

    const lives = feed(`SILIFE half=1 i=0 l=${B}:3:0:9000:20:18:9500:30:0:15000:shot:${A}:12,${B}:1:20000:26000:30:25:-1:0:0:40000:open:0:-1`);
    recordDataFeed(db, lives);
    recordDataFeed(db, lives);
    expect(db.prepare('SELECT idx, zc, ghost_ms, spawn_ms, first_hit_ms, end_cause, killer, respawn_s FROM match_si_lives ORDER BY idx').all()).toEqual([
      { idx: 0, zc: 3, ghost_ms: 0, spawn_ms: 9000, first_hit_ms: 9500, end_cause: 'shot', killer: A, respawn_s: 12 },
      { idx: 1, zc: 1, ghost_ms: 20000, spawn_ms: 26000, first_hit_ms: null, end_cause: 'open', killer: null, respawn_s: null },
    ]);

    resetRoundFeeds(db, 1, 0, 1);
    for (const t of ['match_survivor_downs', 'match_si_lives', 'match_round_feeds']) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
    }
  });

  it('ignores lines for a token it does not know', () => {
    const other = parseLogDatagram(framed(`PUG ${'d'.repeat(32)} DOWN half=1 t=1 steamid=${A} kind=death cause=fall by=0 flow=1 prog=1 pinned=0`)) as DataFeedEvent;
    expect(recordDataFeed(db, other)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_survivor_downs').get()).toEqual({ n: 0 });
  });

  it('writes flow, prog and cause onto the live event, and NULLs from an older plugin', () => {
    const ev = parse(`EVENT seq=1 kind=death actor=${A} target=0 value=0 half=1 t=500 flow=12 prog=30 cause=bleed`);
    recordLiveEvent(db, T, ev as Extract<ReturnType<typeof parse>, { kind: 'live_event' }>);
    const old = parse(`EVENT seq=2 kind=incap actor=${A} target=0 value=0 half=1 t=400`);
    recordLiveEvent(db, T, old as Extract<ReturnType<typeof parse>, { kind: 'live_event' }>);
    expect(db.prepare('SELECT seq, flow, prog, cause FROM match_live_events ORDER BY seq').all()).toEqual([
      { seq: 1, flow: 12, prog: 30, cause: 'bleed' },
      { seq: 2, flow: null, prog: null, cause: null },
    ]);
  });
});
