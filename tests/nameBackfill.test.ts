import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { addAlias } from '../src/aliases.js';
import { applyNameBackfill, planNameBackfill, sightingsFromLog } from '../src/nameBackfill.js';
import { nameHistory, takeRenameDigest } from '../src/playerNames.js';

const AMOUR = '76561199014394259'; // STEAM_1:1:527064265
const ALT = '76561198000000003';
const TOKEN = 'ab'.repeat(16);

const LOG = [
  'L 09/19/2026 - 22:30:00: "amour plastique<273><STEAM_1:1:527064265><>" connected, address "1.2.3.4:27005"',
  'L 09/19/2026 - 22:30:05: PUG ' + TOKEN + ' HEARTBEAT phase=loading',
  'L 09/19/2026 - 22:33:25: "amour plastique<273><STEAM_1:1:527064265><Infected>" say "gl"',
  'L 09/19/2026 - 22:34:00: "(S)Amour Plastique<273><STEAM_1:1:527064265><Spectator>" joined team',
  'L 09/19/2026 - 22:35:00: PUGNAME steamid=' + AMOUR + ' event=change name=amour x',
  'L 09/19/2026 - 22:36:00: "Smoker<3><BOT><Infected>" killed "x"',
].join('\n');

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  upsertPlayer(db, { steamid: AMOUR, name: 'v', avatar: 'a.jpg' }, []);
  db.prepare("INSERT INTO matches (id, season_id, state, campaign, token) VALUES (5, 1, 'completed', 'dead_air', ?)").run(TOKEN);
  db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (5, ?, 'a')").run(AMOUR);
});

describe('sightingsFromLog', () => {
  it('reads engine entities and PUGNAME lines, tagging each with the file\'s token', () => {
    const s = sightingsFromLog(LOG);
    expect(s.map((x) => [x.name, x.token === TOKEN, x.at])).toEqual([
      ['amour plastique', true, '2026-09-19 22:30:00'],
      ['amour plastique', true, '2026-09-19 22:33:25'],
      ['(S)Amour Plastique', true, '2026-09-19 22:34:00'],
      ['amour x', true, '2026-09-19 22:35:00'],
    ]);
    expect(s.every((x) => x.steamid === AMOUR)).toBe(true);
  });

  it('skips a LAN placeholder id and two lines run together', () => {
    const text = [
      'L 09/01/2026 - 10:00:00: "Mal<2><STEAM_1:0:0><Survivor>" say "hi"',
      'L 09/21/2026 - 02:37:21: "Francis<37><BOT><Survivor><Biker>" used pills on "FrancisL 09/21/2026 - 02:37:21: "(S)Mal<3><STEAM_1:1:527064265><>" say "x"',
    ].join('\n');
    expect(sightingsFromLog(text)).toEqual([]);
  });

  it('leaves the token null in a file that never had one', () => {
    expect(sightingsFromLog('L 09/01/2026 - 10:00:00: "pub<2><STEAM_1:1:527064265><Survivor>" say "hi"')[0].token).toBeNull();
  });
});

describe('planNameBackfill', () => {
  it('counts a name once per match, only for rostered players in completed matches', () => {
    const other = 'L 09/19/2026 - 22:30:00: "stranger<9><STEAM_1:0:1><Survivor>" say "x"';
    const unknown = 'L 09/20/2026 - 22:30:00: PUG ' + 'cd'.repeat(16) + ' HEARTBEAT\nL 09/20/2026 - 22:31:00: "zz<273><STEAM_1:1:527064265><>" say "y"';
    const plan = planNameBackfill(db, [...sightingsFromLog(LOG + '\n' + other), ...sightingsFromLog(unknown)], { byDay: false });
    expect(plan.uses.map((u) => [u.name, u.matchKey, u.at])).toEqual([
      ['amour plastique', 'm:5', '2026-09-19 22:30:00'],
      ['amour x', 'm:5', '2026-09-19 22:35:00'],
    ]);
    expect(plan.skipped).toEqual({ unknownToken: 1, notRostered: 1, noToken: 0 });
    expect(applyNameBackfill(db, plan)).toBe(2);
    // Twice is the same as once.
    expect(applyNameBackfill(db, plan)).toBe(0);
    expect(nameHistory(db, AMOUR).map((r) => [r.name, r.matches])).toEqual(expect.arrayContaining([['amour plastique', 1], ['amour x', 1]]));
    expect(takeRenameDigest(db, new Date('2026-09-30T00:00:00Z'))).toBeNull();
  });

  it('with byDay, counts token-less play once per day', () => {
    const pub = [
      'L 09/01/2026 - 10:00:00: "pubname<2><STEAM_1:1:527064265><Survivor>" say "hi"',
      'L 09/01/2026 - 23:00:00: "pubname<2><STEAM_1:1:527064265><Survivor>" say "hi"',
      'L 09/02/2026 - 10:00:00: "pubname<2><STEAM_1:1:527064265><Survivor>" say "hi"',
    ].join('\n');
    expect(planNameBackfill(db, sightingsFromLog(pub), { byDay: false }).uses).toEqual([]);
    const plan = planNameBackfill(db, sightingsFromLog(pub), { byDay: true });
    expect(plan.uses.map((u) => u.matchKey)).toEqual(['log:2026-09-01', 'log:2026-09-02']);
    // Somebody the site has never seen has no history here to add to.
    const stranger = pub.replaceAll('STEAM_1:1:527064265', 'STEAM_1:0:77');
    expect(planNameBackfill(db, sightingsFromLog(stranger), { byDay: true }).uses).toEqual([]);
  });

  it('files an alt\'s names under the main account', () => {
    upsertPlayer(db, { steamid: ALT, name: 'alt', avatar: null }, []);
    addAlias(db, { steamid: ALT, canonical: AMOUR, by: 'test' });
    const line = `L 09/19/2026 - 22:40:00: PUGNAME steamid=${ALT} event=connect name=alt name`;
    const plan = planNameBackfill(db, sightingsFromLog(`L 09/19/2026 - 22:30:05: PUG ${TOKEN} HEARTBEAT\n${line}`), { byDay: false });
    expect(plan.uses).toEqual([{ steamid: AMOUR, matchKey: 'm:5', name: 'alt name', at: '2026-09-19 22:40:00' }]);
  });
});
