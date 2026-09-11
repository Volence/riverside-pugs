import { describe, it, expect } from 'vitest';
import { parseLogDatagram } from '../src/logParse.js';

const TOKEN = '0123456789abcdef0123456789abcdef';

function framed(body: string): Buffer {
  const head = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]);
  const text = Buffer.from(`L 07/30/2026 - 14:23:01: ${body}\n`, 'utf8');
  return Buffer.concat([head, text]);
}

describe('parseLogDatagram', () => {
  it('parses MATCH_START', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} MATCH_START map=l4d_hospital01_apartment`));
    expect(ev).toEqual({ kind: 'match_start', token: TOKEN, map: 'l4d_hospital01_apartment' });
  });

  it('parses MAP_RESULT with numeric scores', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} MAP_RESULT map=l4d_garage b=310 a=245`));
    expect(ev).toEqual({ kind: 'map_result', token: TOKEN, map: 'l4d_garage', a: 245, b: 310 });
  });

  it('parses HEARTBEAT', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} HEARTBEAT`));
    expect(ev).toEqual({ kind: 'heartbeat', token: TOKEN });
  });

  it('parses PLAYER connect/disconnect', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} PLAYER steamid=76561198000000001 event=disconnect`));
    expect(ev).toEqual({ kind: 'player', token: TOKEN, steamid: '76561198000000001', event: 'disconnect' });
  });

  it('parses MATCH_END', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} MATCH_END a=812 b=1044 winner=b`));
    expect(ev).toEqual({ kind: 'match_end', token: TOKEN, a: 812, b: 1044, winner: 'b' });
  });

  it('parses an unframed body (raw text without engine header)', () => {
    const ev = parseLogDatagram(Buffer.from(`PUG ${TOKEN} HEARTBEAT`, 'utf8'));
    expect(ev).toEqual({ kind: 'heartbeat', token: TOKEN });
  });

  it('returns null for a non-PUG log line', () => {
    expect(parseLogDatagram(framed('"Alice<2><STEAM_1:0:1><Survivor>" say "hi"'))).toBeNull();
  });

  it('returns null for a bad token', () => {
    expect(parseLogDatagram(framed('PUG not-a-token HEARTBEAT'))).toBeNull();
  });

  it('returns null for an unknown verb', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} FROBNICATE x=1`))).toBeNull();
  });

  it('returns null for a MATCH_END with a bad winner', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} MATCH_END a=1 b=2 winner=x`))).toBeNull();
  });

  /* Byte-for-byte framing captured from the live L4D1 box on 2026-08-29 via
   * `logaddress_add` + a UDP sink:
   *   b'\xff\xff\xff\xffRL 08/29/2026 - 15:29:00: PUG <token> HEARTBEAT\n\x00'
   * The synthetic `framed()` above matched reality except for the trailing NUL
   * terminator, which these cases pin explicitly. */
  const liveFramed = (body: string): Buffer =>
    Buffer.concat([
      Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]),
      Buffer.from(`L 08/29/2026 - 15:29:00: ${body}\n`, 'utf8'),
      Buffer.from([0x00]),
    ]);

  it('parses a heartbeat in the exact live wire framing (trailing NUL)', () => {
    expect(parseLogDatagram(liveFramed(`PUG ${TOKEN} HEARTBEAT`)))
      .toEqual({ kind: 'heartbeat', token: TOKEN });
  });

  it('parses every verb in the live framing', () => {
    expect(parseLogDatagram(liveFramed(`PUG ${TOKEN} MATCH_START map=l4d_hospital01_apartment`)))
      .toEqual({ kind: 'match_start', token: TOKEN, map: 'l4d_hospital01_apartment' });
    expect(parseLogDatagram(liveFramed(`PUG ${TOKEN} MAP_RESULT map=l4d_hospital01_apartment a=412 b=380`)))
      .toEqual({ kind: 'map_result', token: TOKEN, map: 'l4d_hospital01_apartment', a: 412, b: 380 });
    expect(parseLogDatagram(liveFramed(`PUG ${TOKEN} PLAYER steamid=76561198000000001 event=connect`)))
      .toEqual({ kind: 'player', token: TOKEN, steamid: '76561198000000001', event: 'connect' });
    expect(parseLogDatagram(liveFramed(`PUG ${TOKEN} MATCH_END a=412 b=380 winner=a`)))
      .toEqual({ kind: 'match_end', token: TOKEN, a: 412, b: 380, winner: 'a' });
  });

  it('ignores the engine\'s own rcon echo lines', () => {
    // Real capture: the server echoes every rcon command back over the same
    // stream, including our own sm_pug_* commands. Those must not parse as events.
    expect(parseLogDatagram(liveFramed(
      `rcon from "45.32.199.85:46706": command "sm_pug_roster "76561198000000001:a""`,
    ))).toBeNull();
  });
});

describe('parseLogDatagram: self-started match lines', () => {
  it('parses MATCH_CREATE', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} MATCH_CREATE map=l4d_vs_hospital01_apartment players=8`));
    expect(ev).toEqual({
      kind: 'match_create',
      token: TOKEN,
      map: 'l4d_vs_hospital01_apartment',
      players: 8,
    });
  });

  it('parses MATCH_ROSTER', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} MATCH_ROSTER steamid=76561198030413993 team=a name=volence`));
    expect(ev).toEqual({
      kind: 'match_roster',
      token: TOKEN,
      steamid: '76561198030413993',
      team: 'a',
      name: 'volence',
    });
  });

  // name= is emitted last precisely so that spaces are safe. If this ever
  // regresses, names get silently truncated at the first space.
  it('keeps everything after name= including spaces', () => {
    const ev = parseLogDatagram(
      framed(`PUG ${TOKEN} MATCH_ROSTER steamid=76561198030413993 team=b name=Big Bill  Overbeck`),
    );
    expect(ev).toMatchObject({ kind: 'match_roster', name: 'Big Bill  Overbeck' });
  });

  it('does not let an = inside a name break parsing', () => {
    const ev = parseLogDatagram(
      framed(`PUG ${TOKEN} MATCH_ROSTER steamid=76561198030413993 team=a name=x=y z`),
    );
    expect(ev).toMatchObject({ kind: 'match_roster', name: 'x=y z', team: 'a' });
  });

  it('rejects MATCH_ROSTER with a bad team letter', () => {
    expect(
      parseLogDatagram(framed(`PUG ${TOKEN} MATCH_ROSTER steamid=76561198030413993 team=c name=x`)),
    ).toBeNull();
  });

  it('rejects MATCH_ROSTER with a malformed steamid', () => {
    expect(
      parseLogDatagram(framed(`PUG ${TOKEN} MATCH_ROSTER steamid=123 team=a name=x`)),
    ).toBeNull();
  });

  it('rejects MATCH_ROSTER with an empty name', () => {
    expect(
      parseLogDatagram(framed(`PUG ${TOKEN} MATCH_ROSTER steamid=76561198030413993 team=a name=`)),
    ).toBeNull();
  });

  it('parses MATCH_CREATE_END', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} MATCH_CREATE_END players=8`));
    expect(ev).toEqual({ kind: 'match_create_end', token: TOKEN, players: 8 });
  });

  it('rejects MATCH_CREATE without a map', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} MATCH_CREATE players=8`))).toBeNull();
  });
});

describe('parseLogDatagram: LIVESTAT', () => {
  it('parses the core counters', () => {
    const ev = parseLogDatagram(framed(
      `PUG ${TOKEN} LIVESTAT steamid=76561198030413993 hp=88 ck=142 sidmg=930 sikill=4 ff=12 rev=2`,
    ));
    expect(ev).toEqual({
      kind: 'live_stat',
      token: TOKEN,
      steamid: '76561198030413993',
      stats: { hp: 88, ck: 142, sidmg: 930, sikill: 4, ff: 12, rev: 2 },
    });
  });

  it('carries tank and skill keys when present', () => {
    const ev = parseLogDatagram(framed(
      `PUG ${TOKEN} LIVESTAT steamid=76561198030413993 hp=-1 ck=0 tank_damage=2400 skeets=3 boomer_pops=1 dps_landed=650`,
    ));
    expect(ev).toMatchObject({
      kind: 'live_stat',
      stats: { hp: -1, tank_damage: 2400, skeets: 3, boomer_pops: 1, dps_landed: 650 },
    });
  });

  // skill_detect keys are omitted entirely when it is not loaded, so that a
  // missing stat never reaches the page as a fabricated zero.
  it('accepts a line with the skill keys absent', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} LIVESTAT steamid=76561198030413993 hp=50 ck=7`));
    expect(ev).toMatchObject({ kind: 'live_stat', stats: { hp: 50, ck: 7 } });
    expect((ev as any).stats.skeets).toBeUndefined();
  });

  it('rejects a bad steamid or a line with no numeric stats', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} LIVESTAT steamid=123 hp=1`))).toBeNull();
    expect(parseLogDatagram(framed(`PUG ${TOKEN} LIVESTAT steamid=76561198030413993`))).toBeNull();
  });
})

describe('parseLogDatagram: EVENT', () => {
  const A = '76561198030413993';
  const B = '76561198000000002';

  it('parses a deadly pounce with actor, target and damage', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} EVENT seq=7 kind=dp actor=${A} target=${B} value=34`));
    expect(ev).toEqual({
      kind: 'live_event', token: TOKEN, seq: 7, event: 'dp', actor: A, target: B, value: 34,
      half: -1, tMs: -1,
    });
  });

  it('treats target=0 as no second party', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} EVENT seq=1 kind=crown actor=${A} target=0 value=0`));
    expect(ev).toMatchObject({ kind: 'live_event', target: null, value: 0 });
  });

  it('rejects a malformed seq, actor or kind', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} EVENT seq=0 kind=dp actor=${A} target=0 value=1`))).toBeNull();
    expect(parseLogDatagram(framed(`PUG ${TOKEN} EVENT seq=1 kind=dp actor=123 target=0 value=1`))).toBeNull();
    expect(parseLogDatagram(framed(`PUG ${TOKEN} EVENT seq=1 kind=DP! actor=${A} target=0 value=1`))).toBeNull();
    expect(parseLogDatagram(framed(`PUG ${TOKEN} EVENT seq=1 kind=dp actor=${A} target=0`))).toBeNull();
  });
});

describe('round lines', () => {
  const ACTOR = '76561198030413993';
  const TARGET = '76561198000000002';

  it('parses ROUND_START', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} ROUND_START map=l4d_hospital01_apartment half=1 surv=a`))).toEqual({
      kind: 'round_start', token: TOKEN, map: 'l4d_hospital01_apartment', half: 1, surv: 'a',
    });
  });

  it('parses ROUND_END', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} ROUND_END half=2 surv=b score=412`))).toEqual({
      kind: 'round_end', token: TOKEN, half: 2, surv: 'b', score: 412,
    });
  });

  it('rejects a survivor team that is not a or b', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} ROUND_START map=m half=1 surv=c`))).toBeNull();
  });

  it('rejects a half that is not 1 or 2', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} ROUND_START map=m half=3 surv=a`))).toBeNull();
    expect(parseLogDatagram(framed(`PUG ${TOKEN} ROUND_END half=0 surv=a score=1`))).toBeNull();
  });

  it('carries half and t_ms on an EVENT line', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} EVENT seq=7 kind=pinned actor=${ACTOR} target=${TARGET} value=0 half=1 t=4320`));
    expect(ev).toMatchObject({ kind: 'live_event', event: 'pinned', half: 1, tMs: 4320 });
  });

  it('defaults half and t_ms to -1 on an EVENT line from an older plugin', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} EVENT seq=7 kind=dp actor=${ACTOR} target=${TARGET} value=22`));
    expect(ev).toMatchObject({ kind: 'live_event', half: -1, tMs: -1 });
  });
});
