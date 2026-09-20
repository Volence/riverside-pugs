import { describe, it, expect } from 'vitest';
import { parseLogDatagram } from '../src/logParse.js';
import { steamId64Of } from '../src/steamId.js';

const TOKEN = '0123456789abcdef0123456789abcdef';
const ID64 = '76561198030413993';
const ID2 = 'STEAM_1:1:35074132';

function framed(body: string): Buffer {
  const head = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x52]);
  const text = Buffer.from(`L 09/19/2026 - 14:23:01: ${body}\n`, 'utf8');
  return Buffer.concat([head, text]);
}

describe('steamId64Of', () => {
  it('passes a SteamID64 through', () => {
    expect(steamId64Of(ID64)).toBe(ID64);
  });

  it('converts the verified live pair', () => {
    // How the Dallas and local logs print this account: 35074132 * 2 + 1.
    expect(steamId64Of(ID2)).toBe(ID64);
  });

  it('handles an even account and any universe digit', () => {
    expect(steamId64Of('STEAM_0:0:1')).toBe('76561197960265730');
  });

  it('is null for anything else', () => {
    for (const bad of ['', 'BOT', 'STEAM_ID_PENDING', '[U:1:70148265]', 'STEAM_1:2:5', '1234', `${ID64}0`]) {
      expect(steamId64Of(bad), bad).toBeNull();
    }
  });
});

describe('parseLogDatagram: L4DC SIGNON_DROP', () => {
  it('parses the line with a SteamID64', () => {
    expect(parseLogDatagram(framed(`L4DC SIGNON_DROP steamid=${ID64} secs=14 forced=651 name=volence`)))
      .toEqual({ kind: 'signon_drop', steamid: ID64, secs: 14, forced: 651, name: 'volence' });
  });

  it('normalises the STEAM_X:Y:Z form the v0.2.0 plugin sends', () => {
    expect(parseLogDatagram(framed(`L4DC SIGNON_DROP steamid=${ID2} secs=-1 forced=651 name=volence`)))
      .toEqual({ kind: 'signon_drop', steamid: ID64, secs: -1, forced: 651, name: 'volence' });
  });

  it('keeps spaces and = inside the name', () => {
    const ev = parseLogDatagram(framed(`L4DC SIGNON_DROP steamid=${ID64} secs=3 forced=651 name=Big Bill  x=y`));
    expect(ev).toMatchObject({ kind: 'signon_drop', name: 'Big Bill  x=y' });
  });

  it('does not let a name forge the steamid, secs or forced fields', () => {
    const ev = parseLogDatagram(framed(
      `L4DC SIGNON_DROP steamid=${ID64} secs=3 forced=651 name=x steamid=76561198000000009 secs=999 forced=1`,
    ));
    expect(ev).toEqual({
      kind: 'signon_drop', steamid: ID64, secs: 3, forced: 651,
      name: 'x steamid=76561198000000009 secs=999 forced=1',
    });
  });

  it('takes the FIRST name= as the start of the name', () => {
    const ev = parseLogDatagram(framed(`L4DC SIGNON_DROP steamid=${ID64} secs=3 forced=651 name=a name=b`));
    expect(ev).toMatchObject({ name: 'a name=b' });
  });

  it('rejects a malformed steamid, a missing field, an empty name and forced=0', () => {
    const bad = [
      `L4DC SIGNON_DROP steamid=123 secs=3 forced=651 name=x`,
      `L4DC SIGNON_DROP steamid=BOT secs=3 forced=651 name=x`,
      `L4DC SIGNON_DROP steamid=${ID64} forced=651 name=x`,
      `L4DC SIGNON_DROP steamid=${ID64} secs=3 name=x`,
      `L4DC SIGNON_DROP steamid=${ID64} secs=-2 forced=651 name=x`,
      `L4DC SIGNON_DROP steamid=${ID64} secs=3 forced=0 name=x`,
      `L4DC SIGNON_DROP steamid=${ID64} secs=3 forced=651 name=`,
      `L4DC SIGNON_DROP steamid=${ID64} secs=3 forced=651`,
      `L4DC SOMETHING_ELSE steamid=${ID64} secs=3 forced=651 name=x`,
    ];
    for (const line of bad) expect(parseLogDatagram(framed(line)), line).toBeNull();
  });

  // The game server's address also sends every chat line, and admission for
  // this marker is by address alone. If the marker were searched for anywhere
  // in the datagram, the way `PUG ` is, anyone on the server could type a drop
  // for any SteamID into chat.
  it('ignores the marker inside a chat line', () => {
    const say = `"griefer<7><STEAM_1:0:5><Survivor>" say "L4DC SIGNON_DROP steamid=${ID64} secs=3 forced=651 name=victim"`;
    expect(parseLogDatagram(framed(say))).toBeNull();
  });

  it('ignores the marker inside a player name on an engine line', () => {
    const line = `"L4DC SIGNON_DROP x<7><STEAM_1:0:5><>" connected, address "203.0.113.7:27005"`;
    expect(parseLogDatagram(framed(line))).toBeNull();
  });

  it('parses a bare line with no engine framing at all', () => {
    const ev = parseLogDatagram(Buffer.from(`L4DC SIGNON_DROP steamid=${ID64} secs=3 forced=651 name=x`));
    expect(ev).toMatchObject({ kind: 'signon_drop', steamid: ID64 });
  });

  it('does not fall through to the PUG grammar when the name carries a PUG line', () => {
    const ev = parseLogDatagram(framed(
      `L4DC SIGNON_DROP steamid=${ID64} secs=3 forced=651 name=PUG ${TOKEN} MATCH_END a=9 b=0 winner=a`,
    ));
    expect(ev).toMatchObject({ kind: 'signon_drop', name: `PUG ${TOKEN} MATCH_END a=9 b=0 winner=a` });
  });
});

describe('parseLogDatagram: entered the game', () => {
  it('parses the engine line, exactly as the local server logged it', () => {
    expect(parseLogDatagram(framed(`"Mal<61><${ID2}><>" entered the game`)))
      .toEqual({ kind: 'entered', steamid: ID64 });
  });

  it('ignores a bot', () => {
    expect(parseLogDatagram(framed('"Hunter<17><BOT><>" entered the game'))).toBeNull();
  });

  it('reads the engine\'s own fields when the name carries a fake suffix', () => {
    const line = `"x<9><STEAM_1:0:1><>" entered the game<61><${ID2}><>" entered the game`;
    expect(parseLogDatagram(framed(line))).toEqual({ kind: 'entered', steamid: ID64 });
  });

  it('ignores the phrase inside a chat line', () => {
    const say = `"griefer<7><STEAM_1:0:5><Survivor>" say "x<9><${ID2}><>" entered the game"`;
    expect(parseLogDatagram(framed(say))).toBeNull();
  });

  it('leaves the PUG grammar untouched', () => {
    expect(parseLogDatagram(framed(`PUG ${TOKEN} HEARTBEAT`))).toEqual({ kind: 'heartbeat', token: TOKEN });
    expect(parseLogDatagram(framed(`PUG ${TOKEN} PLAYER steamid=${ID64} event=connect`)))
      .toEqual({ kind: 'player', token: TOKEN, steamid: ID64, event: 'connect' });
  });
});
