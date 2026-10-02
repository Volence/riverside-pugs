import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/preact';
import { Overlay } from './Scenes';
import { defaultStudioState, type CastMatchView, type CastPlayer, type CastTeam, type OverlayFeed } from '../../../src/cast/types';

const team = (key: 'a' | 'b', side: CastTeam['side']): CastTeam => ({
  key, name: key === 'a' ? 'Rats' : 'Crows', tag: key === 'a' ? 'RAT' : 'CRW', color: '#123456', logoUrl: null, score: key === 'a' ? 512 : 448,
  overridden: [], side, players: [],
});
const match: CastMatchView = {
  id: 7, kind: 'pug', state: 'live', campaign: 'dead_air', campaignName: 'Dead Air', currentMap: 'l4d_vs_airport02_offices',
  mapNumber: 2, mapCount: 4, half: 1, phase: 'live', phaseSinceMs: 0, winner: null,
  teams: { a: team('a', 'survivor'), b: team('b', 'infected') },
  chapters: [], events: [], game: null,
};
const live: OverlayFeed['live'] = {
  ordinal: 1, half: 1, map: 'l4d_vs_airport02_offices', tMs: 1000, ageMs: 100,
  survivors: [{ slot: 0, steamid: '1', name: 'Survivor One', character: 'bill', health: 80, temp: 0, alive: true, incap: false, ledge: false, pinned: false, weapon: 'Pump Shotgun', biled: false, flow: 41, items: 3, dmg: 120 }],
  infected: [
    { slot: 4, steamid: '2', name: 'Hunter Main', cls: 'hunter', ghost: false, alive: true, health: 250, dmg: 57 },
    { slot: 5, steamid: '3', name: 'Ghosty', cls: 'smoker', ghost: true, alive: true, health: 0, dmg: 0 },
  ],
  tank: { health: 3000, maxHealth: 6000, controller: 'Tank Guy' },
  witches: 0,
  hud: { progress: 41, tank: 70, witch: 30 },
};
const feed = (patch: Partial<ReturnType<typeof defaultStudioState>> = {}): OverlayFeed => ({
  rev: 1, serverNow: Date.now(), studio: { ...defaultStudioState(), ...patch }, match, live,
});

const allOn = { survivors: true, infected: true, tank: true, bosses: true, progress: true };

describe('gameplay overlay: broadcast bar (default)', () => {
  it('by default shows only what the game does not: compact, no player rows', () => {
    const { container } = render(<Overlay which="gameplay" feed={feed()} now={Date.now()} />);
    const t = container.textContent ?? '';
    for (const s of ['Rats', 'Crows', '512', '448', 'Tank Guy', '41%', '70%', '30%']) expect(t).toContain(s);
    expect(container.querySelector('.ov-hud--compact')).not.toBeNull();
    expect(t).not.toContain('Survivor One');
    expect(t).not.toContain('Hunter Main');
  });

  it('draws both teams, the rows, progress and boss points from the live round', () => {
    const { container } = render(<Overlay which="gameplay" feed={feed({ elements: allOn })} now={Date.now()} />);
    expect(container.querySelector('.ov-hud--compact')).toBeNull();
    const t = container.textContent ?? '';
    for (const s of ['Rats', 'Crows', 'Survivors', 'Infected', '512', '448', 'Survivor One', 'Hunter Main', 'Spawning', 'Tank Guy', '41%', '70%', '30%']) expect(t).toContain(s);
    expect(container.querySelector('.ov-item--kit')).not.toBeNull();
    expect(container.querySelector('.ov-item--pills')).not.toBeNull();
    expect(t).toContain('Dmg 57');
  });

  it('hides the strip and item icons cleanly without LIVEHUD (an older plugin)', () => {
    const old = { ...live!, hud: null, survivors: live!.survivors.map((s) => ({ ...s, flow: null, items: null, dmg: null })) };
    const { container } = render(<Overlay which="gameplay" feed={{ ...feed({ elements: allOn }), live: old }} now={Date.now()} />);
    expect(container.querySelector('.ov-prog')).toBeNull();
    expect(container.querySelector('.ov-item')).toBeNull();
    expect(container.textContent).toContain('Survivor One');
  });

  it('a boss % the producer typed for this map wins over the server', () => {
    const f = feed({ bosses: { tank: 55, witch: null, map: 'l4d_vs_airport02_offices' } });
    const t = render(<Overlay which="gameplay" feed={f} now={Date.now()} />).container.textContent ?? '';
    expect(t).toContain('55%');
    expect(t).not.toContain('70%');
  });

  it('shows rosters while no round is running', () => {
    const m = { ...match, teams: { a: { ...match.teams.a, players: [{ steamid: '9', name: 'Waiting Wally', avatar: null, stats: {}, sr: null, career: { matches: 0, wins: 0, losses: 0, skeets: 0, dps: 0, boomerRate: null } }] }, b: match.teams.b } };
    const t = render(<Overlay which="gameplay" feed={{ ...feed({ elements: allOn }), match: m, live: null }} now={Date.now()} />).container.textContent ?? '';
    expect(t).toContain('Waiting Wally');
  });

  it('is empty with nothing on air', () => {
    const { container } = render(<Overlay which="gameplay" feed={{ ...feed(), match: null, live: null }} now={Date.now()} />);
    expect(container.querySelector('.ov-hud')).toBeNull();
    expect(container.textContent).toBe('');
  });
});

describe('gameplay overlay: scorebug style', () => {
  it('shows only the switched-on elements', () => {
    const { container } = render(<Overlay which="gameplay" feed={feed({ hudStyle: 'scorebug', elements: { ...allOn, survivors: false, infected: false } })} now={Date.now()} />);
    expect(container.textContent).toContain('RAT');
    expect(container.textContent).toContain('Tank Guy');
    expect(container.textContent).not.toContain('Survivor One');
    expect(container.textContent).not.toContain('Hunter Main');
  });

  it('adds the survivor row and infected lineup when switched on', () => {
    const { container } = render(<Overlay which="gameplay" feed={feed({ hudStyle: 'scorebug', elements: { ...allOn, tank: false } })} now={Date.now()} />);
    expect(container.textContent).toContain('Survivor One');
    expect(container.textContent).toContain('Hunter Main');
    expect(container.textContent).not.toContain('Tank Guy');
  });

});

describe('overlay basics', () => {
  it('shows a callout for eight seconds only', () => {
    const at = new Date().toISOString();
    const f = feed({ callout: { title: 'Skeet', text: 'nice', team: 'a', at } });
    expect(render(<Overlay which="gameplay" feed={f} now={Date.parse(at) + 1000} />).container.textContent).toContain('Skeet');
    expect(render(<Overlay which="gameplay" feed={f} now={Date.parse(at) + 9000} />).container.textContent).not.toContain('Skeet');
  });

  it('program follows the producer scene', () => {
    const { container } = render(<Overlay which="program" feed={feed({ scene: 'brb' })} now={Date.now()} />);
    expect(container.querySelector('[data-scene="brb"]')).not.toBeNull();
  });
});

describe('match stats and lineups', () => {
  const pl = (name: string, stats: Record<string, number>, career: Partial<CastPlayer['career']> = {}): CastPlayer => ({
    steamid: name, name, avatar: null, stats, sr: null,
    career: { matches: 10, wins: 6, losses: 4, skeets: 0, dps: 0, boomerRate: null, ...career },
  });
  const withPlayers = (a: CastPlayer[], b: CastPlayer[]): OverlayFeed => ({
    ...feed(), match: { ...match, teams: { a: { ...match.teams.a, players: a }, b: { ...match.teams.b, players: b } } },
  });

  it('shows the owner\'s columns, skeets counted once, boomer % only with boomers', () => {
    const f = withPlayers(
      [pl('Ana', { sidmg: 812, sikill: 9, ck: 140, skeets: 2, team_skeets: 1, skeets_shotgun: 3, tank_damage: 1500, dps_landed: 2, boomer_spawns: 4, boom_successes: 3 })],
      [pl('Bo', { sidmg: 300, sikill: 3, ck: 90, dps_landed: 0 })],
    );
    const { container } = render(<Overlay which="stats" feed={f} now={Date.now()} />);
    const head = [...container.querySelectorAll('thead tr:last-child th')].map((th) => th.textContent);
    expect(head).toEqual(['', 'SI dmg', 'SI kills', 'Commons', 'Skeets', 'Tank dmg', 'DPs', 'Boomer %']);
    const cells = (name: string) => [...[...container.querySelectorAll('tbody tr')].find((r) => r.textContent?.startsWith(name))!.querySelectorAll('td')].map((td) => td.textContent);
    expect(cells('Ana')).toEqual(['812', '9', '140', '3', '1,500', '2', '75%']);
    expect(cells('Bo')).toEqual(['300', '3', '90', '-', '-', '0', '-']);
    expect(container.textContent).not.toMatch(/Deadstops|Dmg as SI/);
  });

  it('lineup cards show skeets, DPs and boomer %', () => {
    const f = withPlayers([pl('Ana', {}, { skeets: 31, dps: 12, boomerRate: 38 })], [pl('Bo', {}, { boomerRate: null })]);
    const { container } = render(<Overlay which="lineups" feed={f} now={Date.now()} />);
    const cards = [...container.querySelectorAll('.ov-card')].map((c) => c.textContent);
    expect(cards[0]).toContain('Skeets31');
    expect(cards[0]).toContain('DPs12');
    expect(cards[0]).toContain('Boomer %38%');
    expect(cards[1]).toContain('Boomer %-');
  });
});
