import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/preact';
import { Widget } from './Widgets';
import { setCampaignNames } from '../format';
import { STYLES_FOR, type WidgetParams, type WidgetStyle } from './params';
import { WIDGET_KINDS, type WidgetKind, type WidgetPayload } from '../../../src/widgetTypes';

/** The streamer (Mox) is on team b and trailing: No Mercy, two maps done
 *  (480-512 and 590-610), map 3 at half-time with the opponents on 438.
 *  Totals include the half: 1,070 to 1,560. */
const payload = (patch: Partial<WidgetPayload> = {}): WidgetPayload => ({
  serverNow: Date.parse('2026-11-04T20:00:00Z'),
  theme: null,
  player: { steamid: '76561198000000001', name: 'Mox' },
  live: {
    matchId: 42, campaign: 'no_mercy', currentMap: 'l4d_vs_hospital03_sewers',
    mapsPlayed: 2, mapsTotal: 4,
    mine: { side: 'b', names: ['Mox', 'B2', 'B3', 'B4'], score: 1070, mine: true },
    theirs: { side: 'a', names: ['Rex', 'A2', 'A3', 'A4'], score: 1560, mine: false },
    maps: [
      { ordinal: 0, map: 'l4d_vs_hospital01_apartment', mine: 480, theirs: 512 },
      { ordinal: 1, map: 'l4d_vs_hospital02_subway', mine: 590, theirs: 610 },
    ],
    halfTime: { ordinal: 2, mineSurvived: false, score: 438 },
    final: false,
  },
  rating: { sr: 1842, rank: 'Gold II', placing: null, position: 12, wins: 34, losses: 21, todayDelta: 38 },
  session: { since: Date.parse('2026-11-04T18:00:00Z'), srDelta: 52, wins: 3, losses: 1 },
  last: {
    matchId: 41, campaign: 'death_toll', endedAt: '2026-11-04 19:00:00', result: 'loss',
    mine: 1210, theirs: 1388, srDelta: -21, stats: { siDamage: 1430, skeets: 2, commons: 211 },
  },
  queue: { count: 6, size: 8, inQueue: true },
  ...patch,
});

const params = (kind: WidgetKind, style: WidgetStyle, patch: Partial<WidgetParams> = {}): WidgetParams => ({
  steamid: '76561198000000001', kind, style, size: 'm', idle: 'hide', ...patch,
});

const live = (patch: Partial<NonNullable<WidgetPayload['live']>>) => payload({ live: { ...payload().live!, ...patch } });

describe('live widget', () => {
  it("every live style lists the streamer's team first with is-mine and their name", () => {
    for (const style of STYLES_FOR.live) {
      const { container, unmount } = render(<Widget params={params('live', style)} data={payload()} />);
      const teams = container.querySelectorAll('[data-team]');
      expect(teams.length, style).toBe(2);
      expect(teams[0].getAttribute('data-team'), style).toBe('mine');
      expect(teams[0].classList.contains('is-mine'), style).toBe(true);
      expect(teams[0].textContent, style).toContain('Mox');
      expect(teams[1].classList.contains('is-mine'), style).toBe(false);
      expect(teams[1].textContent, style).toContain('Opponents');
      unmount();
    }
  });

  it('the leader is marked with is-leading, not is-mine', () => {
    for (const style of STYLES_FOR.live) {
      const { container, unmount } = render(<Widget params={params('live', style)} data={payload()} />);
      const theirs = container.querySelector('[data-team="theirs"] .w-total')!;
      const mine = container.querySelector('[data-team="mine"] .w-total')!;
      expect(theirs.classList.contains('is-leading'), style).toBe(true);
      expect(theirs.classList.contains('is-mine'), style).toBe(false);
      expect(theirs.textContent, style).toContain('1,560');
      expect(mine.classList.contains('is-leading'), style).toBe(false);
      expect(mine.textContent, style).toContain('1,070');
      unmount();
    }
  });

  it('nobody leads on a tie', () => {
    const data = live({ mine: { ...payload().live!.mine, score: 900 }, theirs: { ...payload().live!.theirs, score: 900 } });
    const { container } = render(<Widget params={params('live', 'card')} data={data} />);
    expect(container.querySelector('.is-leading')).toBeNull();
  });

  it('half-time shows the score and "playing"', () => {
    for (const style of ['card', 'board'] as const) {
      const { container, unmount } = render(<Widget params={params('live', style)} data={payload()} />);
      const t = container.textContent ?? '';
      expect(t, style).toContain('438');
      expect(t, style).toContain('playing');
      unmount();
    }
    const { container } = render(<Widget params={params('live', 'bar')} data={payload()} />);
    expect(container.textContent).toContain('M3 live');
  });

  it('labels maps from 1 and says which of how many', () => {
    const card = render(<Widget params={params('live', 'card')} data={payload()} />);
    expect(card.container.textContent).toContain('No Mercy · map 3 of 4');
    expect(card.container.textContent).toContain('Map 1');
    card.unmount();
    const corner = render(<Widget params={params('live', 'corner')} data={payload()} />);
    expect(corner.container.textContent).toContain('No Mercy 3/4');
    corner.unmount();
    const board = render(<Widget params={params('live', 'board')} data={payload()} />);
    const heads = [...board.container.querySelectorAll('th')].map((th) => th.textContent);
    expect(heads).toEqual(['No Mercy', 'M1', 'M2', 'M3', 'M4', 'Total']);
  });

  it('a custom campaign shows its registered name, not its slug', () => {
    setCampaignNames({ widget_test_custom: 'Widget Test Custom' });
    const data = live({ campaign: 'widget_test_custom' });
    for (const style of STYLES_FOR.live) {
      const { container, unmount } = render(<Widget params={params('live', style)} data={data} />);
      expect(container.textContent, style).not.toContain('widget_test_custom');
      if (style !== 'bar') expect(container.textContent, style).toContain('Widget Test Custom');
      unmount();
    }
    const card = render(<Widget params={params('live', 'card')} data={data} />);
    expect(card.container.textContent).toContain('Widget Test Custom · map 3 of 4');
  });

  it('an unknown map count shows "map N" and no columns past the current map', () => {
    const data = live({ mapsTotal: null });
    const card = render(<Widget params={params('live', 'card')} data={data} />);
    expect(card.container.textContent).toContain('No Mercy · map 3');
    expect(card.container.textContent).not.toContain(' of ');
    card.unmount();
    const corner = render(<Widget params={params('live', 'corner')} data={data} />);
    expect(corner.container.textContent).toContain('No Mercy map 3');
    expect(corner.container.textContent).not.toContain('/');
    corner.unmount();
    const board = render(<Widget params={params('live', 'board')} data={data} />);
    expect([...board.container.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['No Mercy', 'M1', 'M2', 'M3', 'Total']);
    board.unmount();
    const bar = render(<Widget params={params('live', 'bar')} data={data} />);
    expect(bar.container.querySelectorAll('.w-chip')).toHaveLength(3);
  });

  it('bar chips name who won each map', () => {
    const { container } = render(<Widget params={params('live', 'bar')} data={payload()} />);
    const chips = [...container.querySelectorAll('.w-chip')].map((c) => c.textContent);
    expect(chips).toEqual(['M1 Opponents', 'M2 Opponents', 'M3 live', 'M4']);
  });

  it('final match shows Final', () => {
    const data = live({ final: true, halfTime: null, currentMap: null, mapsPlayed: 4, maps: [
      ...payload().live!.maps,
      { ordinal: 2, map: 'l4d_vs_hospital03_sewers', mine: 500, theirs: 438 },
      { ordinal: 3, map: 'l4d_vs_hospital04_interior', mine: 700, theirs: 650 },
    ], mine: { ...payload().live!.mine, score: 2270 }, theirs: { ...payload().live!.theirs, score: 2210 } });
    for (const style of STYLES_FOR.live) {
      const { container, unmount } = render(<Widget params={params('live', style)} data={data} />);
      expect(container.textContent, style).toContain('Final');
      expect(container.textContent, style).not.toContain('playing');
      expect(container.textContent, style).not.toContain('live');
      unmount();
    }
  });

  it('live renders nothing when live is null, and "Not in a match" with idle=note', () => {
    for (const style of STYLES_FOR.live) {
      const hidden = render(<Widget params={params('live', style)} data={payload({ live: null })} />);
      expect(hidden.container.innerHTML, style).toBe('');
      hidden.unmount();
      const note = render(<Widget params={params('live', style, { idle: 'note' })} data={payload({ live: null })} />);
      expect(note.container.textContent, style).toBe('Not in a match');
      note.unmount();
    }
  });
});

describe('rating widget', () => {
  it('shows SR, rank, position, W-L and the day', () => {
    const { container } = render(<Widget params={params('rating', 'card')} data={payload()} />);
    const t = container.textContent ?? '';
    for (const s of ['1,842', 'Gold II', '#12', '34-21', '+38 today']) expect(t).toContain(s);
  });

  it('rating shows Placing 3/5 when sr is null', () => {
    const data = payload({ rating: { sr: null, rank: null, placing: { played: 3, of: 5 }, position: null, wins: 2, losses: 1, todayDelta: 0 } });
    for (const style of STYLES_FOR.rating) {
      const { container, unmount } = render(<Widget params={params('rating', style)} data={data} />);
      const t = container.textContent ?? '';
      expect(t, style).toContain('Placing 3/5');
      expect(t, style).not.toContain('NaN');
      expect(t, style).not.toContain('0 SR');
      expect(t, style).not.toContain('null');
      expect(t, style).not.toContain('#');
      unmount();
    }
  });

  it('rating shows a signed today change', () => {
    const up = render(<Widget params={params('rating', 'corner')} data={payload()} />);
    expect(up.container.textContent).toContain('+38 today');
    up.unmount();
    const down = render(<Widget params={params('rating', 'corner')} data={payload({ rating: { ...payload().rating!, todayDelta: -12 } })} />);
    expect(down.container.textContent).toContain('-12 today');
  });

  it('renders nothing without a rating', () => {
    const { container } = render(<Widget params={params('rating', 'card', { idle: 'note' })} data={payload({ rating: null })} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('session, last and queue widgets', () => {
  it('session reads "+52 SR · 3-1 this stream"', () => {
    for (const style of STYLES_FOR.session) {
      const { container, unmount } = render(<Widget params={params('session', style)} data={payload()} />);
      expect(container.textContent, style).toContain('+52 SR · 3-1 this stream');
      unmount();
    }
  });

  it('last match shows the result, score, SR change and three stats, a loss in red', () => {
    for (const style of STYLES_FOR.last) {
      const { container, unmount } = render(<Widget params={params('last', style)} data={payload()} />);
      const t = container.textContent ?? '';
      for (const s of ['Loss', '1,210-1,388', '-21 SR', '1,430', '2', '211']) expect(t, style).toContain(s);
      expect(container.querySelector('.w-result.is-loss')?.textContent, style).toBe('Loss');
      unmount();
    }
    const win = render(<Widget params={params('last', 'card')} data={payload({ last: { ...payload().last!, result: 'win', srDelta: 18 } })} />);
    expect(win.container.querySelector('.w-result.is-win')?.textContent).toBe('Win');
    expect(win.container.textContent).toContain('+18 SR');
  });

  it('queue reads "Queueing on Riverside · 6/8", and hides or notes when not queueing', () => {
    for (const style of STYLES_FOR.queue) {
      const on = render(<Widget params={params('queue', style)} data={payload()} />);
      expect(on.container.textContent, style).toContain('Queueing on Riverside · 6/8');
      on.unmount();
      const off = payload({ queue: { count: 6, size: 8, inQueue: false } });
      const hidden = render(<Widget params={params('queue', style)} data={off} />);
      expect(hidden.container.innerHTML, style).toBe('');
      hidden.unmount();
      const note = render(<Widget params={params('queue', style, { idle: 'note' })} data={off} />);
      expect(note.container.textContent, style).toBe('Not queueing');
      note.unmount();
    }
  });
});

describe('every widget', () => {
  it('copy has no em dash', () => {
    const datas = [payload(), live({ final: true }), live({ mapsTotal: null, halfTime: null }),
      payload({ rating: { sr: null, rank: null, placing: { played: 1, of: 5 }, position: null, wins: 0, losses: 1, todayDelta: -12 } })];
    for (const kind of WIDGET_KINDS) {
      for (const style of STYLES_FOR[kind]) {
        for (const data of datas) {
          const { container, unmount } = render(<Widget params={params(kind, style)} data={data} />);
          expect(container.textContent, `${kind} ${style}`).not.toContain('—');
          unmount();
        }
      }
    }
  });

  it('sizes by --wsize and draws a stand-in game in preview', () => {
    const { container, unmount } = render(<Widget params={params('rating', 'card', { size: 'l' })} data={payload()} />);
    expect((container.querySelector('.w-root') as HTMLElement).style.getPropertyValue('--wsize')).toBe('1.3');
    expect(container.querySelector('.w-game')).toBeNull();
    unmount();
    const p = render(<Widget params={params('rating', 'card', { size: 's' })} data={payload()} preview />);
    expect(p.container.querySelector('.w-game')).not.toBeNull();
    expect((p.container.querySelector('.w-root') as HTMLElement).style.getPropertyValue('--wsize')).toBe('0.8');
  });
});
