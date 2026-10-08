// web/src/overlay/DraftScenes.test.tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/preact';
import { Overlay } from './Scenes';
import { sampleDraft } from './sample';
import { defaultStudioState, type CastDraftView, type OverlayFeed, type StudioState } from '../../../src/cast/types';

/** Drafts plan D2b2 Rulings 4, 7, 8 and 12. sampleDraft: five teams
 *  (Captain One to Captain Five), seven picks, pick 8 (round 2) on the clock
 *  for Captain Three with 42 s left, best available Player 8, 9 and 10. */
const N = Date.parse('2026-10-08T20:00:00.000Z');
const feedWith = (draft: CastDraftView | null, patch: Partial<StudioState> = {}): OverlayFeed => ({
  rev: 1, serverNow: N, studio: { ...defaultStudioState(), ...patch }, match: null, live: null, tankRecap: null, witchRecap: null, casterAvatars: [], draft,
});
/** sampleDraft with pick 8 made at N + 500. */
function withPick8(d: CastDraftView): CastDraftView {
  const p = d.best[0]!;
  return {
    ...d,
    picks: [...d.picks, { pickNo: 8, round: 2, captain: d.onClock!.captain, steamid: p.steamid, name: p.name, auto: false, at: new Date(N + 500).toISOString() }],
    cards: { ...d.cards, [p.steamid]: p },
  };
}

describe('draft board', () => {
  it('shows every team, captains on top, picks filled in and the pick on the clock', () => {
    const { container } = render(<Overlay which="draftboard" feed={feedWith(sampleDraft(N))} now={N} />);
    const t = container.textContent ?? '';
    for (const s of ['Captain One', 'Captain Three', 'Captain Five', 'Player 1', 'Player 7']) expect(t).toContain(s);
    expect(container.querySelectorAll('.ov-dboard__team')).toHaveLength(5);
    const up = container.querySelectorAll('.ov-dboard__slot.is-up');
    expect(up).toHaveLength(1);
    expect(up[0]!.textContent).toContain('#8');
    expect(up[0]!.textContent).toContain('On the clock');
    expect(container.querySelector('.ov-dboard__foot')?.textContent).toBe('Pick 8 of 15 · Round 2 · 00:42');
    // Pick 5 was an auto pick.
    expect(t).toContain('Auto');
  });

  it('shows the studio title and nothing else with no draft on air', () => {
    const { container } = render(<Overlay which="draftboard" feed={feedWith(null)} now={N} />);
    expect(container.querySelector('.ov-dboard')).toBeNull();
    expect(container.textContent).toContain('Draft board');
  });
});

describe('on the clock', () => {
  it('shows the captain up, a countdown from the server deadline, their team so far and the best three by SR', () => {
    const d = sampleDraft(N);
    const { container, rerender } = render(<Overlay which="draftclock" feed={feedWith(d)} now={N} />);
    const t = container.textContent ?? '';
    expect(container.querySelector('.ov-dclock__name')?.textContent).toBe('Captain Three');
    expect(container.querySelector('.ov-dclock__clock')?.textContent).toBe('00:42');
    expect(t).toContain('Pick 8 of 15 · Round 2');
    expect([...container.querySelectorAll('.ov-dclock__team li')].map((li) => li.querySelector('.ov-dclock__tname')?.textContent)).toEqual(['Captain Three', 'Player 3']);
    expect([...container.querySelectorAll('.ov-dmini__name')].map((e) => e.textContent)).toEqual(['Player 8', 'Player 9', 'Player 10']);
    rerender(<Overlay which="draftclock" feed={feedWith(d)} now={N + 40_000} />);
    const clock = container.querySelector('.ov-dclock__clock');
    expect(clock?.textContent).toBe('00:02');
    expect(clock?.classList.contains('is-low')).toBe(true);
  });

  it('freezes the clock while paused', () => {
    const paused: CastDraftView = { ...sampleDraft(N), status: 'paused', deadlineAt: null, pausedLeftMs: 31_000, onClock: null };
    for (const now of [N, N + 20_000]) {
      const { container, unmount } = render(<Overlay which="draftclock" feed={feedWith(paused)} now={now} />);
      expect(container.textContent).toContain('Paused · 00:31 left on the clock');
      unmount();
    }
  });

  it('names a delegate who picks for the team', () => {
    const d = sampleDraft(N);
    const delegate = d.teams[2]!.players[0]!.steamid;
    const { container } = render(<Overlay which="draftclock" feed={feedWith({ ...d, onClock: { ...d.onClock!, picker: delegate } })} now={N} />);
    expect(container.textContent).toContain('Player 3 picks for the team');
  });
});

describe('pick reveal', () => {
  it('reveals a new pick with a card on the draft scenes, never one already made', () => {
    const d = sampleDraft(N);
    const { container, rerender } = render(<Overlay which="draftboard" feed={feedWith(d)} now={N} />);
    expect(container.querySelector('.ov-dreveal')).toBeNull();
    rerender(<Overlay which="draftboard" feed={feedWith(withPick8(d))} now={N + 1000} />);
    const card = container.querySelector('.ov-dreveal');
    expect(card?.textContent).toContain('Player 8');
    expect(card?.textContent).toContain('Pick 8 · Round 2');
    expect(card?.textContent).toContain("to Captain Three's team");
    expect(container.querySelector('.ov-dstrip')).toBeNull();
  });

  it('lays the strip over another scene on Program unless the producer turned it off', () => {
    const d = sampleDraft(N);
    for (const draftStrip of [true, false]) {
      const { container, rerender, unmount } = render(<Overlay which="program" feed={feedWith(d, { scene: 'casters', draftStrip })} now={N} />);
      rerender(<Overlay which="program" feed={feedWith(withPick8(d), { scene: 'casters', draftStrip })} now={N + 1000} />);
      const strip = container.querySelector('.ov-dstrip');
      if (draftStrip) expect(strip?.textContent).toContain('Player 8');
      else expect(strip).toBeNull();
      unmount();
    }
  });

  it('shows the strip on the Pick reveal layer link', () => {
    const d = sampleDraft(N);
    const { container, rerender } = render(<Overlay which="draftreveal" feed={feedWith(d)} now={N} />);
    expect(container.querySelector('.ov-dstrip')).toBeNull();
    rerender(<Overlay which="draftreveal" feed={feedWith(withPick8(d))} now={N + 1000} />);
    expect(container.querySelector('.ov-dstrip')?.textContent).toContain("to Captain Three's team");
  });
});
