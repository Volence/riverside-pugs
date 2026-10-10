import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { balanceMu, careerMatchCounts, configuredOffset, newcomerOffset } from '../src/newcomerPrior.js';
import { balanceTeams } from '../src/balance.js';
import { upsertPlayer } from '../src/players.js';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

function finished(players: string[], opts: { state?: string; kind?: string; voided?: boolean } = {}): void {
  const id = Number(db.prepare(
    "INSERT INTO matches (season_id, state, campaign, kind, voided_at) VALUES (1, ?, 'no_mercy', ?, ?)",
  ).run(opts.state ?? 'completed', opts.kind ?? 'pug', opts.voided ? '2026-10-01 00:00:00' : null).lastInsertRowid);
  for (const p of players) upsertPlayer(db, { steamid: p, name: p, avatar: null }, []);
  players.forEach((p, i) => db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)').run(id, p, i % 2 ? 'b' : 'a'));
}

describe('newcomer balance offset', () => {
  it('is off by default and changes nobody', () => {
    expect(configuredOffset(db)).toBe(0);
    const mus = balanceMu(db, new Map([['new', { mu: 25 }], ['vet', { mu: 30 }]]));
    expect([...mus]).toEqual([['new', 25], ['vet', 30]]);
  });

  it('applies only to a player with no finished, unvoided PUG', () => {
    finished(['vet']);
    finished(['voidonly'], { voided: true });
    finished(['scrimonly'], { kind: 'scrim' });
    finished(['abortonly'], { state: 'aborted' });
    expect(careerMatchCounts(db, ['vet', 'voidonly', 'scrimonly', 'abortonly', 'new']))
      .toEqual(new Map([['vet', 1], ['voidonly', 0], ['scrimonly', 0], ['abortonly', 0], ['new', 0]]));
    setSetting(db, 'newcomer_balance_offset', '6');
    const mus = balanceMu(db, new Map([['vet', { mu: 25 }], ['new', { mu: 25 }], ['voidonly', { mu: 25 }]]));
    expect(mus.get('vet')).toBe(25);
    expect(mus.get('new')).toBe(19);
    expect(mus.get('voidonly')).toBe(19);
  });

  it('clamps a hand-edited value to the panel range', () => {
    setSetting(db, 'newcomer_balance_offset', '40');
    expect(configuredOffset(db)).toBe(12);
    setSetting(db, 'newcomer_balance_offset', 'nonsense');
    expect(configuredOffset(db)).toBe(0);
    expect(newcomerOffset(3, 6)).toBe(0);
  });

  it('pairs two first-timers with the strongest players rather than on one team', () => {
    // Six regulars at 25 and two players at 25 in their first match: without
    // the offset any split is even, so the newcomers can land together.
    const ids = ['n1', 'n2', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6'];
    for (const v of ids.slice(2)) finished([v]);
    setSetting(db, 'newcomer_balance_offset', '8');
    const mus = balanceMu(db, new Map(ids.map((s) => [s, { mu: s === 'v1' || s === 'v2' ? 30 : 25 }])));
    const { teamA, teamB } = balanceTeams(ids.map((s) => ({ steamid: s, mu: mus.get(s)!, sigma: 4 })));
    const sameTeam = (a: string, b: string) => teamA.includes(a) === teamA.includes(b);
    expect(sameTeam('n1', 'n2')).toBe(false);
    expect(sameTeam('v1', 'v2')).toBe(false);
    expect(teamA.length + teamB.length).toBe(8);
  });
});
