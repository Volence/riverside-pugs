import { describe, it, expect } from 'vitest';
import { kickReason, parseStatusPlayers, parseWho, practicePlayers } from '../src/practicePlayers.js';

const STATUS = `hostname: Riverside #4
version : 1.0.4.5 9225 secure
map     : l4d_vs_hospital01_apartment at: 0 x, 0 y, 0 z
players : 2 humans, 4 bots (31 max) (not hibernating) (unreserved)

# userid name uniqueid connected ping loss state rate adr
#  2 1 "Mal" STEAM_1:1:35074132 01:12 33 0 active 128000 192.168.4.85:27005
# 3 "Bill" BOT active
# 4 "SourceTV" BOT active
# 11 5 "a "quoted" name" STEAM_1:0:7 1:02:03 120 4 spawning 30000 10.1.1.1:27005
#end`;

describe('parseStatusPlayers', () => {
  it('reads humans with userid, client index, name, SteamID64, time and ping; leaves bots and SourceTV out', () => {
    expect(parseStatusPlayers(STATUS)).toEqual([
      { userid: 2, index: 1, name: 'Mal', steamid64: '76561198030413993', connectedFor: '01:12', ping: 33 },
      { userid: 11, index: 5, name: 'a "quoted" name', steamid64: '76561197960265742', connectedFor: '1:02:03', ping: 120 },
    ]);
  });

  it('keeps a player whose id is not validated yet, without a SteamID64', () => {
    const p = parseStatusPlayers('#  3 2 "lan" STEAM_ID_LAN 00:04 5 0 active 30000 loopback');
    expect(p).toEqual([{ userid: 3, index: 2, name: 'lan', steamid64: null, connectedFor: '00:04', ping: 5 }]);
  });

  it('reads nothing from an empty or unrelated reply', () => {
    expect(parseStatusPlayers('')).toEqual([]);
    expect(parseStatusPlayers('Unknown command "status"')).toEqual([]);
  });
});

describe('parseWho', () => {
  it('reads team, bot and trainer by client index, names with spaces included', () => {
    const who = parseWho([
      'WHO 1 Mal team=3 bot=0 alive=1 zc=3 trainer=0 target=-1',
      'WHO 5 a "quoted" name team=2 bot=0 trainer=2 wep=weapon_pumpshotgun',
      'WHO 6 Spec Tator team=1',
      'noise',
    ].join('\n'));
    expect(who.get(1)).toEqual({ team: 3, bot: false, trainer: null, station: null });
    expect(who.get(5)).toEqual({ team: 2, bot: false, trainer: 2, station: null });
    expect(who.get(6)).toEqual({ team: 1, bot: false, trainer: null, station: null });
    expect(who.size).toBe(3);
  });

  it('is empty when the command is missing', () => {
    expect(parseWho('Unknown command "sm_practice_who"').size).toBe(0);
  });
});

describe('practicePlayers', () => {
  it('joins team and trainer onto the status rows by client index', () => {
    const out = practicePlayers(STATUS, 'WHO 5 a "quoted" name team=2 bot=0 trainer=3\nWHO 1 Mal team=1');
    expect(out.map((p) => [p.name, p.team, p.trainer])).toEqual([['Mal', 1, null], ['a "quoted" name', 2, 3]]);
  });
});

describe('kickReason', () => {
  it('drops quotes, semicolons and line breaks, and defaults when empty', () => {
    expect(kickReason('bad "name"; quit\nnow')).toBe('bad name quit now');
    expect(kickReason('   ')).toBe('Removed by an admin');
    expect(kickReason(undefined)).toBe('Removed by an admin');
    expect(kickReason(42)).toBe('Removed by an admin');
    expect(kickReason('x'.repeat(300))).toHaveLength(120);
  });
});

describe('station', () => {
  it('reads the station the plugin prints before team=', () => {
    const who = 'WHO 3 Dust station=pit team=2 bot=0 alive=1 zc=-1 trainer=0 target=-1\nWHO 4 Six station=none team=3 bot=0 alive=1 zc=3 trainer=0 target=-1';
    const m = parseWho(who);
    expect(m.get(3)?.station).toBe('pit');
    expect(m.get(4)?.station).toBeNull();
  });
  it('is null for a plugin that predates it', () => {
    expect(parseWho('WHO 3 Dust team=2 bot=0 trainer=1').get(3)?.station).toBeNull();
  });
});
