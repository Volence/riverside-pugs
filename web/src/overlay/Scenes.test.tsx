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
  hud: { progress: 41, tank: 70, witch: 30, rivalReach: 74 },
};
const feed = (patch: Partial<ReturnType<typeof defaultStudioState>> = {}): OverlayFeed => ({
  rev: 1, serverNow: Date.now(), studio: { ...defaultStudioState(), ...patch }, match, live, tankRecap: null, witchRecap: null,
});

const allOn = { survivors: true, infected: true, tank: true, bosses: true, progress: true, tankRecap: true, witchRecap: true, rival: true, dots: true };

describe('gameplay overlay: the broadcast looks', () => {
  it('by default (plate) shows only what a spectator never sees: infected yes, survivors no', () => {
    const { container } = render(<Overlay which="gameplay" feed={feed()} now={Date.now()} />);
    const t = container.textContent ?? '';
    for (const s of ['Rats', 'Crows', '512', '448', 'Tank Guy', '41%', '70%', '30%', 'Hunter Main']) expect(t).toContain(s);
    expect(container.querySelector('.ov-plate')).not.toBeNull();
    expect(t).not.toContain('Survivor One');
    // The boss pins and the tank use the game's own icons.
    const srcs = [...container.querySelectorAll('img')].map((i) => i.getAttribute('src'));
    expect(srcs).toContain('/cast-art/si-tank.png');
    expect(srcs).toContain('/cast-art/witch.png');
  });

  for (const style of ['plate', 'corners', 'rail'] as const) {
    it(`${style}: rows on draw medallions with the released portraits, items and SI icons`, () => {
      const { container } = render(<Overlay which="gameplay" feed={feed({ hudStyle: style, elements: allOn })} now={Date.now()} />);
      const t = container.textContent ?? '';
      for (const s of ['Rats', 'Crows', 'Survivor One', 'Hunter Main', 'Spawning', 'Tank Guy']) expect(t).toContain(s);
      const srcs = [...container.querySelectorAll('img')].map((i) => i.getAttribute('src'));
      expect(srcs).toContain('/cast-art/survivor-bill.png');
      expect(srcs).toContain('/cast-art/si-hunter.png');
      expect(srcs).toContain('/cast-art/item-kit.png');
      expect(srcs).toContain('/cast-art/item-pills.png');
      expect(srcs.some((x) => x?.startsWith('/portraits/'))).toBe(false);
      expect(t).toContain('Dmg 57');
    });
  }

  it('frame: frames the bottom-band survivor cards and draws the infected beside them', () => {
    const { container } = render(<Overlay which="gameplay" feed={feed({ hudStyle: 'frame', elements: allOn })} now={Date.now()} />);
    const surv = container.querySelector('[data-side="survivor"]') as HTMLElement;
    expect(surv.style.left).toBe('40px');
    expect(surv.style.top).toBe('966px');
    expect(surv.textContent).toContain('Rats');
    expect(container.querySelector('[data-side="infected"]')).toBeNull();
    const band = container.querySelector('.ov-band') as HTMLElement;
    expect(band.textContent).toContain('Crows');
    expect(band.textContent).toContain('Hunter Main');
    expect(band.textContent).toContain('Spawning');
    // No medallions in frame mode, whatever the switches say.
    expect(container.querySelector('.ov-mrow')).toBeNull();
    // An infected hole when the producer adds one.
    const withHole = render(<Overlay which="gameplay" feed={feed({ hudStyle: 'frame', frame: { survivor: { x: 40, y: 966, w: 1270, h: 110 }, infected: { x: 1340, y: 20, w: 560, h: 150 } } })} now={Date.now()} />).container;
    expect(withHole.querySelector('[data-side="infected"]')?.textContent).toContain('Crows');
  });

  it("marks the opponent's reach and each survivor's own progress on the strip", () => {
    const { container } = render(<Overlay which="gameplay" feed={feed()} now={Date.now()} />);
    expect(container.querySelector('.ov-pg__rival')?.textContent).toBe('CRW 74%');
    expect((container.querySelector('.ov-pg__dot') as HTMLElement).style.left).toBe('41%');
    const off = render(<Overlay which="gameplay" feed={feed({ elements: { ...allOn, survivors: false, infected: false, rival: false, dots: false } })} now={Date.now()} />).container;
    expect(off.querySelector('.ov-pg__rival')).toBeNull();
    expect(off.querySelector('.ov-pg__dot')).toBeNull();
  });

  it('shows the tank damage card with shares after a tank dies', () => {
    const r = { agoMs: 500, aliveS: 84, controller: 'Tank Guy', dealt: 312, tanks: 1, passes: 1, end: 'dead' as const, players: [{ name: 'Survivor One', dmg: 4200, share: 70 }, { name: 'Two', dmg: 1800, share: 30 }] };
    const { container } = render(<Overlay which="gameplay" feed={{ ...feed(), tankRecap: r }} now={Date.now()} />);
    const t = container.querySelector('.ov-recap')!.textContent ?? '';
    for (const x of ['Tank down', 'Tank Guy', '1:24', '312', 'Passed once', 'Survivor One', '4,200', '70%', '30%']) expect(t).toContain(x);
    const two = render(<Overlay which="gameplay" feed={{ ...feed(), tankRecap: { ...r, tanks: 2, passes: 0 } }} now={Date.now()} />).container.querySelector('.ov-recap')!.textContent ?? '';
    expect(two).toContain('Tanks down');
    expect(two).toContain('2 tanks, combined');
    expect(two).not.toContain('Passed');
    const off = render(<Overlay which="gameplay" feed={{ ...feed({ elements: { ...allOn, tankRecap: false } }), tankRecap: r }} now={Date.now()} />).container;
    expect(off.querySelector('.ov-recap')).toBeNull();
    // A wipe ends the round, so the card must not need a live round.
    const wipe = render(<Overlay which="gameplay" feed={{ ...feed(), live: null, tankRecap: { ...r, end: 'wipe' } }} now={Date.now()} />).container.querySelector('.ov-recap')!.textContent ?? '';
    expect(wipe).toContain('Team wiped');
    expect(wipe).toContain('4,200');
    const safe = render(<Overlay which="gameplay" feed={{ ...feed(), tankRecap: { ...r, end: 'safe' } }} now={Date.now()} />).container.querySelector('.ov-recap')!.textContent ?? '';
    expect(safe).toContain('Tank still up');
  });

  it('shows the witch card, and the tank card wins when both are up', () => {
    const w = { agoMs: 300, aliveS: null, startled: null, killer: 'Survivor One', crown: true, incaps: 0, players: [{ name: 'Survivor One', dmg: 1000, share: 100 }] };
    const t = render(<Overlay which="gameplay" feed={{ ...feed(), witchRecap: w }} now={Date.now()} />).container.querySelector('.ov-recap--witch')!.textContent ?? '';
    for (const x of ['Witch crowned', 'Survivor One', 'Startled', 'No', '1,000', '100%']) expect(t).toContain(x);
    expect(t).not.toContain('Lasted');
    const down = render(<Overlay which="gameplay" feed={{ ...feed(), witchRecap: { ...w, crown: false, startled: 'Two', aliveS: 14, incaps: 2 } }} now={Date.now()} />).container.textContent ?? '';
    for (const x of ['Witch down', 'Two', '0:14', 'Incaps2']) expect(down.replace(/\s+/g, '')).toContain(x.replace(/\s+/g, ''));
    const tank = { agoMs: 0, aliveS: 10, controller: null, dealt: 0, tanks: 1, passes: 0, end: 'dead' as const, players: [] };
    const both = render(<Overlay which="gameplay" feed={{ ...feed(), witchRecap: w, tankRecap: tank }} now={Date.now()} />).container;
    expect(both.querySelectorAll('.ov-recap')).toHaveLength(1);
    expect(both.querySelector('.ov-recap--witch')).toBeNull();
    const off = render(<Overlay which="gameplay" feed={{ ...feed({ elements: { ...allOn, witchRecap: false } }), witchRecap: w }} now={Date.now()} />).container;
    expect(off.querySelector('.ov-recap')).toBeNull();
  });

  it('hides the strip and item icons cleanly without LIVEHUD (an older plugin)', () => {
    const old = { ...live!, hud: null, survivors: live!.survivors.map((s) => ({ ...s, flow: null, items: null, dmg: null })) };
    const { container } = render(<Overlay which="gameplay" feed={{ ...feed({ elements: allOn }), live: old }} now={Date.now()} />);
    expect(container.querySelector('.ov-pg')).toBeNull();
    expect(container.querySelector('.ov-item')).toBeNull();
    expect(container.textContent).toContain('Survivor One');
  });

  it('a boss % the producer typed for this map wins over the server', () => {
    const f = feed({ bosses: { tank: 55, witch: null, map: 'l4d_vs_airport02_offices' } });
    const t = render(<Overlay which="gameplay" feed={f} now={Date.now()} />).container.textContent ?? '';
    expect(t).toContain('55%');
    expect(t).not.toContain('70%');
  });

  it('is empty with nothing on air', () => {
    const { container } = render(<Overlay which="gameplay" feed={{ ...feed(), match: null, live: null }} now={Date.now()} />);
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

  it('the card is compact by default and big when asked', () => {
    const at = new Date().toISOString();
    const c = { title: 'Skeet', text: 'nice', team: 'a' as const, at };
    const compact = render(<Overlay which="gameplay" feed={feed({ callout: c })} now={Date.parse(at) + 1000} />).container;
    expect(compact.querySelector('.ov-callout--compact')).not.toBeNull();
    const big = render(<Overlay which="gameplay" feed={feed({ callout: c, calloutSize: 'normal' })} now={Date.parse(at) + 1000} />).container;
    expect(big.querySelector('.ov-callout--normal')).not.toBeNull();
  });

  it('auto-fire shows a new live event as a card, never the backlog', () => {
    const on = { autoCallouts: { on: true, kinds: ['dp'] } };
    const dp = { seq: 5, kind: 'dp', actor: 'carl', actorTeam: 'b' as const, target: 'stew', value: 25 };
    const at = (events: CastMatchView['events']): OverlayFeed => ({ ...feed(on), match: { ...match, events } });
    const t = Date.now();
    const { container, rerender } = render(<Overlay which="gameplay" feed={at([{ ...dp, seq: 4 }])} now={t} />);
    expect(container.querySelector('.ov-callout')).toBeNull();
    rerender(<Overlay which="gameplay" feed={at([dp, { ...dp, seq: 4 }])} now={t + 500} />);
    expect(container.textContent).toContain('carl pounced stew for 25');
  });

  it('program follows the producer scene', () => {
    const { container } = render(<Overlay which="program" feed={feed({ scene: 'brb' })} now={Date.now()} />);
    expect(container.querySelector('[data-scene="brb"]')).not.toBeNull();
  });
});

describe('match stats and lineups', () => {
  const pl = (name: string, stats: Record<string, number>, career: Partial<CastPlayer['career']> = {}): CastPlayer => ({
    steamid: name, name, avatar: null, stats, sr: null, role: null,
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

  it('a scrim lineup is the roster: role and tag, no PUG numbers, avatar when known', () => {
    const f = withPlayers([{ ...pl('Cap', {}), role: 'captain', avatar: 'https://avatars.example/cap.jpg', career: null }], [{ ...pl('Mem', {}), role: 'member', career: null }]);
    const scrim = { ...f, match: { ...f.match!, kind: 'scrim' as const } };
    const { container } = render(<Overlay which="lineups" feed={scrim} now={Date.now()} />);
    const t = container.textContent ?? '';
    expect(t).toContain('Captain');
    expect(t).not.toMatch(/\d PUGs|Skeets|Boomer|\d SR/);
    expect(container.querySelector('img.ov-card__avatar')?.getAttribute('src')).toBe('https://avatars.example/cap.jpg');
    expect(container.querySelector('.ov-card__avatar--none')?.textContent).toBe('M');
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
