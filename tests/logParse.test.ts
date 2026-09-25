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

  // The plugin's one-second phase tracker: what the game is doing between
  // frames, so the live page can say "paused" or "readying up" instead of
  // sitting on a frozen frame. team is the plugin's 1/2 for pug a/b, 0 for a
  // pause nobody is charged for (a disconnect pause, an admin).
  it('parses PHASE with the pause fields', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} PHASE state=paused team=2 limit=120 leave=0`));
    expect(ev).toEqual({
      kind: 'phase', token: TOKEN,
      phase: { state: 'paused', team: 'b', limit: 120, leave: false, unready: [] },
    });
  });

  it('parses who called a pause, and drops a caller that is not a SteamID64', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} PHASE state=paused team=1 limit=120 leave=0 by=76561198000000042`));
    expect(ev).toMatchObject({ kind: 'phase', phase: { state: 'paused', team: 'a', by: '76561198000000042' } });
    const bad = parseLogDatagram(framed(`PUG ${TOKEN} PHASE state=paused team=1 limit=120 leave=0 by=BOT`));
    expect(bad && bad.kind === 'phase' ? bad.phase.by : 'x').toBeUndefined();
  });

  it('parses a PHASE with no team or limit as an unattributed, uncapped state', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} PHASE state=readyup`));
    expect(ev).toEqual({
      kind: 'phase', token: TOKEN,
      phase: { state: 'readyup', team: null, limit: 0, leave: false, unready: [] },
    });
  });

  // Who has not readied yet, so the page can say who everyone is waiting on
  // and the ready-up ledger can charge the seconds to the right players.
  it('parses the not-ready roster on a ready-up PHASE', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} PHASE state=readyup unready=76561198000000001,76561198000000004`));
    expect(ev).toEqual({
      kind: 'phase', token: TOKEN,
      phase: { state: 'readyup', team: null, limit: 0, leave: false, unready: ['76561198000000001', '76561198000000004'] },
    });
  });

  it('drops malformed ids from the not-ready roster rather than the whole line', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} PHASE state=readyup unready=76561198000000001,bogus,`));
    expect(ev).toMatchObject({ phase: { unready: ['76561198000000001'] } });
  });

  it('drops a PHASE whose state it does not know rather than storing a word it cannot render', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} PHASE state=teleporting`))).toBeNull();
  });

  // The heartbeat carries the phase too, so a lost PHASE datagram is corrected
  // within thirty seconds. A heartbeat from an older plugin has no phase and
  // parses exactly as before.
  it('parses the phase riding on a HEARTBEAT', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} HEARTBEAT phase=paused team=0 limit=0 leave=1`));
    expect(ev).toEqual({
      kind: 'heartbeat', token: TOKEN,
      phase: { state: 'paused', team: null, limit: 0, leave: true, unready: [] },
    });
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

  it('parses PROBLEM with a code', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} PROBLEM code=unpause_timeout`));
    expect(ev).toEqual({ kind: 'problem', token: TOKEN, code: 'unpause_timeout' });
  });

  it('rejects PROBLEM without a well-formed code', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} PROBLEM`))).toBeNull();
    expect(parseLogDatagram(framed(`PUG ${TOKEN} PROBLEM code=Bad Code`))).toBeNull();
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
      joinedMap: 0,
    });
  });

  it('reads joined_map on a MATCH_ROSTER line, before the name', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} MATCH_ROSTER steamid=76561198005192652 team=b joined_map=2 name=mayhem`));
    expect(ev).toMatchObject({ kind: 'match_roster', team: 'b', name: 'mayhem', joinedMap: 2 });
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

  // name= is the player's own text. Everything structured is read from the
  // part of the line before it, so nothing in a name can stand in for a field.
  describe('a name cannot forge a roster field', () => {
    const REAL = '76561198030413993';
    const VICTIM = '76561198000000009';
    const roster = (name: string, head = `steamid=${REAL} team=a joined_map=0`) =>
      parseLogDatagram(framed(`PUG ${TOKEN} MATCH_ROSTER ${head} name=${name}`));

    it('not the steamid', () => {
      const name = `x steamid=${VICTIM}`;
      expect(roster(name)).toEqual({
        kind: 'match_roster', token: TOKEN, steamid: REAL, team: 'a', name, joinedMap: 0,
      });
    });

    it('not the team', () => {
      expect(roster('x team=b')).toMatchObject({ steamid: REAL, team: 'a', name: 'x team=b' });
    });

    it('not joined_map', () => {
      expect(roster('x joined_map=9')).toMatchObject({ steamid: REAL, joinedMap: 0, name: 'x joined_map=9' });
    });

    it('not all three at once', () => {
      const name = `x steamid=${VICTIM} team=b joined_map=9`;
      expect(roster(name)).toEqual({
        kind: 'match_roster', token: TOKEN, steamid: REAL, team: 'a', name, joinedMap: 0,
      });
    });

    it('not a field the real line left out', () => {
      // An older plugin sends no joined_map; the name must not supply one.
      expect(roster('x joined_map=9', `steamid=${REAL} team=a`)).toMatchObject({ joinedMap: 0 });
      // And a line with no real steamid is malformed, whatever the name says.
      expect(roster(`x steamid=${VICTIM}`, 'team=a')).toBeNull();
    });

    it('not with a second name= either', () => {
      const name = `x name=y steamid=${VICTIM}`;
      expect(roster(name)).toMatchObject({ steamid: REAL, name });
    });
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
    expect(parseLogDatagram(framed(`PUG ${TOKEN} ROUND_END map=l4d_hospital01_apartment half=2 surv=b score=412 alive=3`))).toEqual({
      kind: 'round_end', token: TOKEN, map: 'l4d_hospital01_apartment', half: 2, surv: 'b', score: 412, alive: 3,
    });
  });

  it('carries the demo tick and tickrate on both round lines (0.3.12)', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} ROUND_START map=m half=2 surv=a demotick=41870 hz=100`))).toEqual({
      kind: 'round_start', token: TOKEN, map: 'm', half: 2, surv: 'a', demo: { tick: 41870, hz: 100 },
    });
    expect(parseLogDatagram(framed(`PUG ${TOKEN} ROUND_END map=m half=2 surv=b score=412 alive=3 demotick=41870 hz=100`)))
      .toMatchObject({ kind: 'round_end', score: 412, demo: { tick: 41870, hz: 100 } });
  });

  it('drops a malformed demo sync but keeps the round', () => {
    for (const bad of ['demotick=12', 'hz=100', 'demotick=-5 hz=100', 'demotick=12 hz=0', 'demotick=x hz=100']) {
      const ev = parseLogDatagram(framed(`PUG ${TOKEN} ROUND_START map=m half=1 surv=a ${bad}`));
      expect(ev).toEqual({ kind: 'round_start', token: TOKEN, map: 'm', half: 1, surv: 'a' });
    }
  });

  it('parses a ROUND_END from an older plugin that carries no map', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} ROUND_END half=2 surv=b score=412`))).toEqual({
      kind: 'round_end', token: TOKEN, map: null, half: 2, surv: 'b', score: 412, alive: null,
    });
  });

  it('carries alive=0 as a wipe, not as an absent reading', () => {
    // Nobody left standing is the single most interesting survival result, and
    // 0 is falsy: a truthiness check anywhere on this path would turn every
    // wipe into "not measured" and bias survival rate upward forever.
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} ROUND_END map=m half=1 surv=a score=50 alive=0`));
    expect(ev).toEqual({
      kind: 'round_end', token: TOKEN, map: 'm', half: 1, surv: 'a', score: 50, alive: 0,
    });
  });

  it('treats a ROUND_END with no alive= as unmeasured rather than a wipe', () => {
    // An older plugin staged mid-season omits the field. That must read as
    // "we do not know", never as zero survivors, which would be a false wipe.
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} ROUND_END map=m half=1 surv=a score=50`));
    expect(ev).toMatchObject({ kind: 'round_end', alive: null });
  });

  it('drops a negative alive, which no real reading can be', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} ROUND_END map=m half=1 surv=a score=50 alive=-1`)))
      .toMatchObject({ kind: 'round_end', score: 50, alive: null });
  });

  it('drops a malformed alive rather than rejecting the whole line', () => {
    // The score and side are what the match record depends on; a corrupt
    // survival reading must not cost us the round entirely.
    expect(parseLogDatagram(framed(`PUG ${TOKEN} ROUND_END map=m half=1 surv=a score=50 alive=x`)))
      .toMatchObject({ kind: 'round_end', score: 50, alive: null });
  });

  it('accepts a ROUND_START with no side, rather than one that invents one', () => {
    // The plugin omits surv= when its orientation mapping has not settled.
    // Dropping the line would lose started_at, which every event's t_ms is
    // measured from, so the absence is carried through as null instead.
    expect(parseLogDatagram(framed(`PUG ${TOKEN} ROUND_START map=m half=1`))).toEqual({
      kind: 'round_start', token: TOKEN, map: 'm', half: 1, surv: null,
    });
  });

  it('rejects a survivor team that is not a or b', () => {
    // Present but malformed is a corrupt line, which is not the same thing as
    // the plugin admitting it does not know.
    expect(parseLogDatagram(framed(`PUG ${TOKEN} ROUND_START map=m half=1 surv=c`))).toBeNull();
    expect(parseLogDatagram(framed(`PUG ${TOKEN} ROUND_END map=m half=1 surv=c score=1`))).toBeNull();
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

describe('CHAT', () => {
  const T = 'a'.repeat(32);
  const line = (s: string) => parseLogDatagram(Buffer.from(`L 09/11/2026 - 20:00:00: PUG ${T} ${s}\n`));

  it('parses a chat line', () => {
    expect(line('CHAT seq=7 half=1 t=4321 steamid=76561198000000001 team=a msg=rushing left')).toEqual({
      kind: 'chat', token: T, seq: 7, half: 1, tMs: 4321,
      steamid: '76561198000000001', team: 'a', message: 'rushing left',
    });
  });

  it('keeps a message containing spaces and equals signs intact', () => {
    // The attack this defends against: if msg were tokenized, a message of
    // "gg steamid=76561198000000009" could overwrite the speaker. Taking the
    // remainder of the line after the FIRST ' msg=' makes that impossible.
    const ev = line('CHAT seq=8 half=1 t=1 steamid=76561198000000001 team=b msg=gg steamid=76561198000000009 team=a');
    expect(ev).toMatchObject({
      steamid: '76561198000000001', team: 'b',
      message: 'gg steamid=76561198000000009 team=a',
    });
  });

  it('accepts an empty team as null rather than dropping the line', () => {
    expect(line('CHAT seq=9 half=1 t=1 steamid=76561198000000001 team= msg=hi')).toMatchObject({ team: null, message: 'hi' });
  });

  it('rejects a line with no msg field at all', () => {
    expect(line('CHAT seq=9 half=1 t=1 steamid=76561198000000001 team=a')).toBeNull();
  });

  it('rejects a bad steamid', () => {
    expect(line('CHAT seq=9 half=1 t=1 steamid=nope team=a msg=hi')).toBeNull();
  });

  it('rejects a non-positive seq', () => {
    expect(line('CHAT seq=0 half=1 t=1 steamid=76561198000000001 team=a msg=hi')).toBeNull();
  });
});

/* A `say` line leaves the game server from the same address as the plugin's
 * own lines, so the sender gate cannot tell them apart. The marker has to be
 * the first thing after the engine's stamp, which player text never is: every
 * engine line about a player opens with a quote. */
describe('parseLogDatagram: PUG text a player typed is not a PUG line', () => {
  const FORGED = '00000000000000000000000000000bad';
  const who = '"mallory<7><STEAM_1:0:5><Survivor>"';

  it('ignores a PUG line carried in chat', () => {
    for (const verb of [
      'MATCH_CREATE map=l4d_vs_hospital01_apartment players=1',
      'MATCH_ROSTER steamid=76561198000000001 team=a name=victim',
      'MATCH_CREATE_END players=1',
      'MATCH_END a=0 b=9999 winner=b',
      'HEARTBEAT',
    ]) {
      expect(parseLogDatagram(framed(`${who} say "PUG ${FORGED} ${verb} x"`))).toBeNull();
      expect(parseLogDatagram(framed(`${who} say_team "PUG ${FORGED} ${verb} x"`))).toBeNull();
    }
  });

  it('ignores a PUG line carried in a player name', () => {
    // The trailing word keeps the engine's `<7><STEAM...` suffix off winner=.
    const name = `PUG ${FORGED} MATCH_END a=0 b=9999 winner=b x`;
    expect(parseLogDatagram(framed(`"${name}<7><STEAM_1:0:5><>" connected, address "1.2.3.4:27005"`))).toBeNull();
    expect(parseLogDatagram(framed(`"${name}<7><STEAM_1:0:5><Survivor>" say "gg"`))).toBeNull();
  });

  it('ignores chat that carries its own fake engine stamp', () => {
    // Likewise: the trailing word takes the closing quote.
    const fake = `L 09/21/2026 - 15:04:05: PUG ${FORGED} MATCH_CREATE map=l4d_vs_hospital01_apartment players=1 x`;
    expect(parseLogDatagram(framed(`${who} say "${fake}"`))).toBeNull();
  });

  it('ignores PUG text that is not at the start of the line', () => {
    expect(parseLogDatagram(framed(`[basechat.smx] ${who} triggered sm_say (text PUG ${FORGED} HEARTBEAT)`))).toBeNull();
    expect(parseLogDatagram(framed(` PUG ${FORGED} HEARTBEAT`))).toBeNull();
  });

  it('reads only the first line of a datagram', () => {
    expect(parseLogDatagram(framed(`${who} say "x"\nPUG ${FORGED} HEARTBEAT`))).toBeNull();
  });

  it('still parses the real line when a forged one rides along inside it', () => {
    const ev = parseLogDatagram(framed(
      `PUG ${TOKEN} CHAT seq=4 half=1 t=900 steamid=76561198000000001 team=a msg=PUG ${FORGED} MATCH_END a=0 b=1 winner=b`,
    ));
    expect(ev).toMatchObject({ kind: 'chat', token: TOKEN, message: `PUG ${FORGED} MATCH_END a=0 b=1 winner=b` });
  });
});

describe('balance and per-round lines', () => {
  it('parses a BALANCE part, decoding %20 and %25 and keeping only prefixed items', () => {
    const ev = parseLogDatagram(framed(
      `PUG ${TOKEN} BALANCE half=1 part=0 c:z_tank_health=4000 c:sv_tags=a%20b%25 p:l4d_skypounce.smx=1234.0a0b0c0d x:l4d_nope=missing junk=1`,
    ));
    expect(ev).toEqual({
      kind: 'balance_part', token: TOKEN, half: 1, part: 0, sent: 4,
      items: {
        'c:z_tank_health': '4000', 'c:sv_tags': 'a b%',
        'p:l4d_skypounce.smx': '1234.0a0b0c0d', 'x:l4d_nope': 'missing',
      },
    });
  });

  it('counts a BALANCE item sent twice on one line', () => {
    const ev = parseLogDatagram(framed(`PUG ${TOKEN} BALANCE half=1 part=0 f:a.cfg=1.a c:x=1 f:a.cfg=1.a`));
    expect(ev).toMatchObject({ kind: 'balance_part', sent: 3, items: { 'f:a.cfg': '1.a', 'c:x': '1' } });
  });

  it('parses BALANCE_END', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} BALANCE_END half=2 parts=3 items=71`))).toEqual({
      kind: 'balance_end', token: TOKEN, half: 2, parts: 3, items: 71,
    });
  });

  it('rejects BALANCE with a bad half', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} BALANCE half=3 part=0 c:a=1`))).toBeNull();
  });

  it('parses ROUND_STAT and drops non-integer values', () => {
    const ev = parseLogDatagram(framed(
      `PUG ${TOKEN} ROUND_STAT half=1 steamid=76561198000000001 crowns=1 w_pumpshotgun_sidmg=250 bad=x`,
    ));
    expect(ev).toEqual({
      kind: 'round_stat', token: TOKEN, half: 1, steamid: '76561198000000001',
      stats: { crowns: 1, w_pumpshotgun_sidmg: 250 },
    });
  });

  it('parses ROUND_STATS_END', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} ROUND_STATS_END half=1 players=8 sd=1`))).toEqual({
      kind: 'round_stats_end', token: TOKEN, half: 1, players: 8, skillDetect: true,
    });
  });

  it('parses ROUND_MARK and rejects an unknown mark', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} ROUND_MARK half=2 kind=panic t=91234`))).toEqual({
      kind: 'round_mark', token: TOKEN, half: 2, mark: 'panic', tMs: 91234,
    });
    expect(parseLogDatagram(framed(`PUG ${TOKEN} ROUND_MARK half=2 kind=boom t=1`))).toBeNull();
  });
});
