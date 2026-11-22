// web/src/overlay/RoomScene.test.tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/preact';
import { Overlay } from './Scenes';
import { sampleRoom } from './sample';
import type { MatchRoomView } from '../api';
import { defaultStudioState, type OverlayFeed } from '../../../src/cast/types';

/** Owner 2026-11-22 (DT2): the tournament room scene. sampleRoom: Sample A
 *  vs Sample B, a total-score Bo2, game 1 2211 - 2480, game 2 live at 930 - 148. */
const N = Date.parse('2026-11-22T02:00:00.000Z');
const feedWith = (room: MatchRoomView | null): OverlayFeed => ({
  rev: 1, serverNow: N, studio: { ...defaultStudioState(), scene: 'room' }, match: null, live: null, tankRecap: null, witchRecap: null,
  casterAvatars: [], draft: null, room: room as unknown as OverlayFeed['room'],
});
const text = (el: Element, sel: string) => [...el.querySelectorAll(sel)].map((n) => n.textContent);

describe('room scene', () => {
  it('shows the teams, the series total with the live game in it, and what the trailing team needs', () => {
    const { container } = render(<Overlay which="room" feed={feedWith(sampleRoom(N))} now={N} />);
    expect(text(container, '.ov-room__name')).toEqual(['Sample A', 'Sample B']);
    expect(container.querySelector('.ov-room__score')!.textContent).toBe('3141:2628');
    expect(container.querySelector('.ov-room__format')!.textContent).toBe('Total score so far');
    expect(container.querySelector('.ov-room__needs')!.textContent).toBe('Sample B must outscore Sample A by 513 to tie, 514 to lead');
  });

  it('marks each campaign banned, picked or open, and each game with its picker, sides and score', () => {
    const { container } = render(<Overlay which="room" feed={feedWith(sampleRoom(N))} now={N} />);
    expect(text(container, '.ov-room__tile.is-banned .ov-room__tilename')).toEqual(['Dead Air', 'Death Toll', 'Dead Center']);
    expect(text(container, '.ov-room__tile.is-picked .ov-room__tilestate')).toEqual(['Game 1 · SMA pick', 'Game 2 · SMA pick']);
    expect(text(container, '.ov-room__tile.is-open .ov-room__tilename')).toEqual(['Dark Carnival']);
    expect(text(container, '.ov-room__campaign')).toEqual(['No Mercy', 'Blood Harvest']);
    expect(text(container, '.ov-room__facts')).toEqual(['Sample A picked · Sample B start survivors', 'Sample A picked · Sample B start survivors']);
    expect(text(container, '.ov-room__gamescore')).toEqual(['SMA 22112480 SMB', 'SMA 930148 SMB']);
    expect(text(container, '.ov-room__gamestate')).toEqual(['Final', 'Live · l4d_vs_farm03_bridge']);
  });

  it('during the veto names whose turn it is with the room clock, never "your turn"', () => {
    const r = sampleRoom(N);
    const veto: MatchRoomView = {
      ...r, phase: 'veto', games: [], series: null, deadline: new Date(N + 42_000).toISOString(),
      pool: r.pool.map((c) => (c.state === 'picked' ? { ...c, state: 'open', by: null, game: null } : c)),
      next: { kind: 'ban', by: 'a', game: null, step: 4 },
      // A viewer block on the feed must never turn the banner into "Your turn".
      me: { side: 'a', manager: true, playable: [], defaultFour: null },
      log: [{ step: 3, side: 'b', action: 'ban', campaign: 'dead_center', campaignName: 'Dead Center', auto: false, at: '' }],
    };
    const { container } = render(<Overlay which="room" feed={feedWith(veto)} now={N} />);
    expect(container.querySelector('.ov-room__statustext')!.textContent).toBe('Sample A is banning a campaign');
    expect(container.querySelector('.ov-room__clock')!.textContent).toBe('00:42');
    expect(container.querySelector('.ov-room__last')!.textContent).toBe('Last: Sample B banned Dead Center');
    expect(container.querySelector('.ov-room__vs')!.textContent).toBe('vs');
    expect(container.querySelector('.ov-room__needs')).toBeNull();
  });

  it('with no room on the feed, shows a clean title card', () => {
    const { container } = render(<Overlay which="room" feed={feedWith(null)} now={N} />);
    expect(container.querySelector('.ov-title__main')!.textContent).toBe('Tournament room');
    expect(container.querySelector('.ov-room__band')).toBeNull();
  });

  it('on the program link it follows the producer to the room scene', () => {
    const { container } = render(<Overlay which="program" feed={feedWith(sampleRoom(N))} now={N} />);
    expect(container.querySelector('.ov--room')).toBeTruthy();
  });
});
