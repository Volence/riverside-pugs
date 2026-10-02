import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/preact';
import { Overlay } from './Scenes';
import { defaultStudioState, type CastMatchView, type CastTeam, type OverlayFeed } from '../../../src/cast/types';

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
  survivors: [{ slot: 0, steamid: '1', name: 'Survivor One', character: 'bill', health: 80, temp: 0, alive: true, incap: false, ledge: false, pinned: false, weapon: 'Pump Shotgun' }],
  infected: [{ slot: 4, steamid: '2', name: 'Hunter Main', cls: 'hunter', ghost: false, alive: true, health: 250 }],
  tank: { health: 3000, maxHealth: 6000, controller: 'Tank Guy' },
  witches: 0,
};
const feed = (patch: Partial<ReturnType<typeof defaultStudioState>> = {}): OverlayFeed => ({
  rev: 1, serverNow: Date.now(), studio: { ...defaultStudioState(), ...patch }, match, live,
});

describe('gameplay overlay', () => {
  it('shows only what the game does not, by default', () => {
    const { container } = render(<Overlay which="gameplay" feed={feed()} now={Date.now()} />);
    expect(container.textContent).toContain('RAT');
    expect(container.textContent).toContain('Tank Guy');
    expect(container.textContent).not.toContain('Survivor One');
    expect(container.textContent).not.toContain('Hunter Main');
  });

  it('adds the survivor row and infected lineup when switched on', () => {
    const { container } = render(<Overlay which="gameplay" feed={feed({ elements: { survivors: true, infected: true, tank: false, bosses: true } })} now={Date.now()} />);
    expect(container.textContent).toContain('Survivor One');
    expect(container.textContent).toContain('Hunter Main');
    expect(container.textContent).not.toContain('Tank Guy');
  });

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
