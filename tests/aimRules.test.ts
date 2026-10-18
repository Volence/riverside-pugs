import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { getSetting, setSetting } from '../src/settings.js';
import { SETTINGS_SCHEMA, validateSetting } from '../src/settingsSchema.js';
import { recordIntegrityFlag } from '../src/integrityFlags.js';
import { aimRulesMode, evaluateAimMatch, recordSiKill, scanAimMatches } from '../src/aimRules.js';

const A = '76561198129925325';
const B = '76561198000000001';
const NOW = new Date('2026-10-17T22:00:00.000Z');
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO matches (id, season_id, state, campaign, ended_at) VALUES (722, 1, 'completed', 'farm', '2026-10-17 21:48:22')").run();
});

const at = (i: number) => new Date(Date.parse('2026-10-17T21:00:00.000Z') + i * 60_000);
/** 16 smg kills, `hs` of them headshots, `flicks` of them flick-and-return. */
function play(steamid: string, hs: number, flicks: number, matchId = 722): void {
  for (let i = 0; i < 16; i++) {
    const flick = i < flicks;
    recordSiKill(db, {
      matchId, serverId: 1, steamid, weapon: 'smg', headshot: i < hs, dist: 500,
      pre: flick ? 143.5 : 8, back: flick ? 12 : 3, victimClass: 'hunter',
    }, at(i));
  }
}
const bigSnap = (steamid: string, matchId = 722) => recordIntegrityFlag(db, {
  matchId, serverId: 1, steamid, source: 'lilac', kind: 'aimbot', severity: 'high',
  detail: 'lflags=4 ldelta=143.5 ltd=200 maxd=143.5 totd=300 taps=3 taps1=1',
}, at(3));
const aimRows = () => db.prepare(
  "SELECT steamid, match_id AS matchId, kind, severity FROM integrity_flags WHERE source = 'aim' ORDER BY id",
).all();

describe('the aim_rules setting', () => {
  it('ships as log and only takes off, log or on', () => {
    expect(getSetting(db, 'aim_rules')).toBe('log');
    expect(SETTINGS_SCHEMA.some((d) => d.key === 'aim_rules')).toBe(true);
    for (const v of ['off', 'log', 'on']) expect(validateSetting('aim_rules', v).ok, v).toBe(true);
    expect(validateSetting('aim_rules', 'loud').ok).toBe(false);
  });

  it('reads anything unreadable as log', () => {
    setSetting(db, 'aim_rules', '');
    expect(aimRulesMode(db)).toBe('log');
    setSetting(db, 'aim_rules', 'on');
    expect(aimRulesMode(db)).toBe('on');
  });
});

describe('evaluateAimMatch', () => {
  it('writes one rule alone as its own flag, posted', () => {
    play(A, 14, 0);
    const out = evaluateAimMatch(db, 722, NOW);
    expect(out.map((f) => [f.kind, f.post])).toEqual([['hs_share', true]]);
    expect(aimRows()).toEqual([{ steamid: A, matchId: 722, kind: 'hs_share', severity: 'suspected' }]);
  });

  it('escalates nepmir\'s match: A and C make one high aimbot_multi, and only it posts', () => {
    play(A, 14, 2);
    const out = evaluateAimMatch(db, 722, NOW);
    expect(out.map((f) => [f.kind, f.post])).toEqual([['hs_share', false], ['flick_return', false], ['aimbot_multi', true]]);
    expect(aimRows()).toEqual([
      { steamid: A, matchId: 722, kind: 'hs_share', severity: 'suspected' },
      { steamid: A, matchId: 722, kind: 'flick_return', severity: 'suspected' },
      { steamid: A, matchId: 722, kind: 'aimbot_multi', severity: 'high' },
    ]);
    expect(out[2].detail).toMatch(/^hs_share \+ flick_return\. hs_share: auto weapons: 14 of 16/);
  });

  it('counts B from the LilAC row in the same match', () => {
    play(A, 14, 0);
    bigSnap(A);
    const multi = evaluateAimMatch(db, 722, NOW).find((f) => f.kind === 'aimbot_multi');
    expect(multi?.detail).toMatch(/^hs_share \+ big_snap\./);
    expect(multi?.detail).toMatch(/big_snap: LilAC aim-snap 143\.5 degrees/);
  });

  it('does not count B from another match or another player', () => {
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, ended_at) VALUES (700, 1, 'completed', 'farm', '2026-10-16 21:00:00')").run();
    play(A, 14, 0);
    bigSnap(A, 700);
    bigSnap(B);
    expect(evaluateAimMatch(db, 722, NOW).map((f) => f.kind)).toEqual(['hs_share']);
  });

  it('writes nothing for an honest match', () => {
    play(B, 6, 1);
    expect(evaluateAimMatch(db, 722, NOW)).toEqual([]);
    expect(aimRows()).toEqual([]);
  });

  it('never writes a row twice', () => {
    play(A, 14, 2);
    evaluateAimMatch(db, 722, NOW);
    expect(evaluateAimMatch(db, 722, NOW)).toEqual([]);
    expect(aimRows()).toHaveLength(3);
  });
});

describe('scanAimMatches', () => {
  it('posts nothing in log mode but keeps the rows', () => {
    play(A, 14, 2);
    expect(scanAimMatches(db, NOW)).toEqual([]);
    expect(aimRows()).toHaveLength(3);
  });

  it('posts what fired in on mode, once per match', () => {
    setSetting(db, 'aim_rules', 'on');
    play(A, 14, 2);
    play(B, 14, 0);
    const posts = scanAimMatches(db, NOW);
    expect(posts.map((p) => [p.steamid, p.kind])).toEqual([[A, 'aimbot_multi'], [B, 'hs_share']]);
    // Review Focus 2: the next sweep, or the first after a restart.
    expect(scanAimMatches(db, NOW)).toEqual([]);
    expect(aimRows()).toHaveLength(4);
  });

  // Review Focus 3.
  it('does not post the log week when the setting goes on', () => {
    play(A, 14, 2);
    scanAimMatches(db, NOW);
    setSetting(db, 'aim_rules', 'on');
    expect(scanAimMatches(db, NOW)).toEqual([]);
  });

  it('writes nothing when off, and still settles the match', () => {
    setSetting(db, 'aim_rules', 'off');
    play(A, 14, 2);
    expect(scanAimMatches(db, NOW)).toEqual([]);
    expect(aimRows()).toEqual([]);
    expect(db.prepare('SELECT match_id FROM aim_match_scans').all()).toEqual([{ match_id: 722 }]);
  });

  it('waits for the match to end and ignores old ones', () => {
    setSetting(db, 'aim_rules', 'on');
    db.prepare("INSERT INTO matches (id, season_id, state, campaign) VALUES (723, 1, 'live', 'farm')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, ended_at) VALUES (600, 1, 'completed', 'farm', '2026-10-10 21:00:00')").run();
    play(A, 14, 2, 723);
    play(B, 14, 2, 600);
    expect(scanAimMatches(db, NOW)).toEqual([]);
    expect(aimRows()).toEqual([]);
  });

  it('judges an aborted match too', () => {
    setSetting(db, 'aim_rules', 'on');
    db.prepare("UPDATE matches SET state = 'aborted' WHERE id = 722").run();
    play(A, 14, 0);
    expect(scanAimMatches(db, NOW).map((p) => p.kind)).toEqual(['hs_share']);
  });
});
