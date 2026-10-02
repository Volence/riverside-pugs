import type { CastLiveRound, CastMatchView, CastPlayer, CastTeam, OverlayFeed, StudioState } from '../../../src/cast/types';

/**
 * A made-up match for the producer panel's preview while nothing is on air,
 * so a caster can see and set up every scene before a match exists. Never
 * sent to OBS: the overlay pages draw only the real feed (nothing on air is
 * a transparent frame there), and the panel labels the preview as a sample.
 */

const player = (steamid: string, name: string): CastPlayer => ({
  steamid, name, avatar: null, stats: { sidmg: 412, sikill: 7, ck: 96, skeets: 2, team_skeets: 1, dps_landed: 1, tank_damage: 940, boomer_spawns: 5, boom_successes: 2 }, sr: null,
  career: { matches: 42, wins: 23, losses: 19, skeets: 31, dps: 12, boomerRate: 38 },
});

const team = (key: 'a' | 'b', name: string, tag: string, color: string, score: number, side: CastTeam['side'], names: string[]): CastTeam => ({
  key, name, tag, color, logoUrl: null, score, overridden: [], side,
  players: names.map((n, i) => player(`0000000000000${key === 'a' ? 1 : 2}00${i}`, n)),
});

export function sampleFeed(studio: StudioState, now: number): OverlayFeed {
  const a = team('a', 'Sample A', 'SMA', '#5b8fd9', 512, 'survivor', ['Survivor One', 'Survivor Two', 'Survivor Three', 'Survivor Four']);
  const b = team('b', 'Sample B', 'SMB', '#d9913f', 448, 'infected', ['Infected One', 'Infected Two', 'Infected Three', 'Infected Four']);
  const match: CastMatchView = {
    id: 0, kind: 'pug', state: 'live', campaign: 'dead_air', campaignName: 'Dead Air', currentMap: 'l4d_vs_airport02_offices',
    mapNumber: 2, mapCount: 4, half: 1, phase: 'live', phaseSinceMs: now - 180_000, winner: null,
    teams: { a, b },
    chapters: [
      { number: 1, map: 'l4d_vs_airport01_greenhouse', a: 512, b: 448, firstSurvivor: 'b', state: 'done' },
      { number: 2, map: 'l4d_vs_airport02_offices', a: null, b: null, firstSurvivor: 'a', state: 'playing' },
      { number: 3, map: 'l4d_vs_airport03_garage', a: null, b: null, firstSurvivor: null, state: 'next' },
      { number: 4, map: 'l4d_vs_airport04_terminal', a: null, b: null, firstSurvivor: null, state: 'next' },
    ],
    events: [], game: null,
  };
  const s = (i: number, character: string, health: number, temp: number, extra: Partial<CastLiveRound['survivors'][number]> = {}) => ({
    slot: i, steamid: a.players[i]!.steamid, name: a.players[i]!.name, character, health, temp, alive: true,
    incap: false, ledge: false, pinned: false, biled: false, weapon: 'Auto Shotgun', flow: 52, items: 3, dmg: 120, ...extra,
  });
  const live: CastLiveRound = {
    ordinal: 1, half: 1, map: 'l4d_vs_airport02_offices', tMs: 180_000, ageMs: 200,
    survivors: [
      s(0, 'bill', 71, 0, { items: 1 | 2 | 8 }),
      s(1, 'zoey', 38, 22, { items: 2 }),
      s(2, 'francis', 210, 0, { incap: true, items: 4 }),
      s(3, 'louis', 100, 0, { items: 1 }),
    ],
    infected: [
      { slot: 4, steamid: b.players[0]!.steamid, name: b.players[0]!.name, cls: 'hunter', ghost: false, alive: true, health: 250, dmg: 157 },
      { slot: 5, steamid: b.players[1]!.steamid, name: b.players[1]!.name, cls: 'tank', ghost: false, alive: true, health: 4200, dmg: 61 },
      { slot: 6, steamid: b.players[2]!.steamid, name: b.players[2]!.name, cls: 'smoker', ghost: true, alive: true, health: 0, dmg: 58 },
      { slot: 7, steamid: b.players[3]!.steamid, name: b.players[3]!.name, cls: '', ghost: false, alive: false, health: 0, dmg: 30 },
    ],
    tank: { health: 4200, maxHealth: 6000, controller: b.players[1]!.name },
    witches: 1,
    hud: { progress: 52, tank: 74, witch: 31 },
  };
  return { rev: 0, serverNow: now, studio, match, live };
}
