import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/preact';
import { ReplayHud, liveStatusText } from './ReplayHud';
import type { LivePhase } from '../api';
import { DEFAULT_TOGGLES } from './useToggles';

afterEach(cleanup);

describe('ReplayHud', () => {
  it('shows the clock, the counts and one chip per toggle', () => {
    const toggle = vi.fn();
    render(
      <ReplayHud
        tMs={6000} endMs={69000}
        counts={{ survivors: 4, commons: 14, specials: 3 }}
        live={false} closed
        toggles={DEFAULT_TOGGLES} toggle={toggle}
      />,
    );
    expect(screen.getByText('0:06')).toBeTruthy();
    expect(screen.getByText('of 1:09')).toBeTruthy();
    expect(screen.getByText('4 alive · 14 common · 3 special')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Guns' }));
    expect(toggle).toHaveBeenCalledWith('guns');
    expect(screen.getByRole('button', { name: 'HP' }).classList.contains('is-on')).toBe(true);
    expect(screen.getByRole('button', { name: 'Guns' }).classList.contains('is-on')).toBe(false);
  });

  it('flags a live, still-recording round', () => {
    render(
      <ReplayHud tMs={0} endMs={0} counts={{ survivors: 0, commons: 0, specials: 0 }}
        live closed={false} toggles={DEFAULT_TOGGLES} toggle={() => {}} />,
    );
    expect(screen.getByText(/live, 10s delayed/i)).toBeTruthy();
  });

  it('says the round is over once a live file closes, and whether the tail is still playing', () => {
    const counts = { survivors: 0, commons: 0, specials: 0 };
    const { rerender } = render(
      <ReplayHud tMs={5000} endMs={10_000} counts={counts}
        live closed toggles={DEFAULT_TOGGLES} toggle={() => {}} />,
    );
    expect(screen.queryByText(/live, 10s delayed/i)).toBeNull();
    expect(screen.getByText(/round over, catching up/i)).toBeTruthy();
    rerender(
      <ReplayHud tMs={10_000} endMs={10_000} counts={counts}
        live closed toggles={DEFAULT_TOGGLES} toggle={() => {}} />,
    );
    expect(screen.getByText(/round over, waiting for the next round/i)).toBeTruthy();
  });

  it('offers a theater chip when given one, lit while on', () => {
    const t = vi.fn();
    render(
      <ReplayHud tMs={0} endMs={0} counts={{ survivors: 0, commons: 0, specials: 0 }}
        live={false} closed toggles={DEFAULT_TOGGLES} toggle={() => {}}
        theater={{ on: true, toggle: t }} />,
    );
    const chip = screen.getByRole('button', { name: 'Theater' });
    expect(chip.classList.contains('is-on')).toBe(true);
    fireEvent.click(chip);
    expect(t).toHaveBeenCalledTimes(1);
  });
});

// The words under the clock, as a pure function of what the server said.
// `now` is passed in so the pause countdown is deterministic.
describe('liveStatusText', () => {
  const NOW = 1_700_000_000_000;
  const phase = (over: Partial<LivePhase>): LivePhase => ({ state: 'live', team: null, limit: 0, leave: false, unready: [], sinceMs: NOW - 30_000, ...over });

  it('names the pausing team and counts down the ceiling', () => {
    expect(liveStatusText(true, false, 0, 0, phase({ state: 'paused', team: 'b', limit: 120 }), NOW))
      .toBe('Paused by Team B, 1:30 left');
  });

  it('says only who paused when there is no ceiling', () => {
    expect(liveStatusText(true, false, 0, 0, phase({ state: 'paused', team: 'a' }), NOW))
      .toBe('Paused by Team A');
  });

  it('never counts below zero once the ceiling has passed', () => {
    expect(liveStatusText(true, false, 0, 0, phase({ state: 'paused', team: 'a', limit: 10 }), NOW))
      .toBe('Paused by Team A, 0:00 left');
  });

  it('explains a pause the plugin called for a dropped player', () => {
    expect(liveStatusText(true, false, 0, 0, phase({ state: 'paused', leave: true }), NOW))
      .toBe('Paused, waiting for a player to reconnect');
  });

  it('says paused with no blame when nobody is charged', () => {
    expect(liveStatusText(true, false, 0, 0, phase({ state: 'paused' }), NOW)).toBe('Paused');
  });

  it('says readying up and loading', () => {
    expect(liveStatusText(true, true, 0, 0, phase({ state: 'readyup' }), NOW)).toBe('Readying up');
    expect(liveStatusText(true, true, 0, 0, phase({ state: 'loading' }), NOW)).toBe('Loading the next map');
  });

  it('names who everyone is waiting on during a ready-up', () => {
    const names = { '76561198000000001': 'killshot', '76561198000000004': 'goober' };
    expect(liveStatusText(true, true, 0, 0, phase({ state: 'readyup', unready: ['76561198000000001', '76561198000000004'] }), NOW, names))
      .toBe('Readying up, waiting on killshot, goober');
    // An id with no name known falls back to the id rather than a blank.
    expect(liveStatusText(true, true, 0, 0, phase({ state: 'readyup', unready: ['76561198000000009'] }), NOW, names))
      .toBe('Readying up, waiting on 76561198000000009');
  });

  it('falls back to the file state when the phase is live or unknown', () => {
    expect(liveStatusText(true, false, 0, 0, phase({ state: 'live' }), NOW)).toBe('Live, 10s delayed');
    expect(liveStatusText(true, true, 10, 10, null, NOW)).toBe('Round over, waiting for the next round');
    expect(liveStatusText(true, true, 5, 10, phase({ state: 'roundover' }), NOW)).toBe('Round over, catching up');
  });

  it('says nothing for a saved replay whatever the phase', () => {
    expect(liveStatusText(false, true, 0, 0, phase({ state: 'paused', team: 'a' }), NOW)).toBeNull();
  });
});

describe('liveStatusText while the view is behind the round being played', () => {
  const NOW = 1_700_000_000_000;
  const phase = (over: Partial<LivePhase>): LivePhase => ({ state: 'live', team: null, limit: 0, leave: false, unready: [], sinceMs: NOW - 5_000, ...over });

  it('says catching up for thirty seconds, then that the view is not available', () => {
    expect(liveStatusText(true, true, 10, 10, phase({}), NOW, {}, NOW - 5_000)).toBe('Live view is catching up');
    expect(liveStatusText(true, false, 10, 10, null, NOW, {}, NOW - 29_999)).toBe('Live view is catching up');
    expect(liveStatusText(true, true, 10, 10, phase({}), NOW, {}, NOW - 30_000))
      .toBe("Live view isn't available for this server right now");
  });

  it('treats a live phase over a finished file as behind, timed from the phase', () => {
    expect(liveStatusText(true, true, 10, 10, phase({ sinceMs: NOW - 5_000 }), NOW)).toBe('Live view is catching up');
    expect(liveStatusText(true, true, 5, 10, phase({ sinceMs: NOW - 40_000 }), NOW))
      .toBe("Live view isn't available for this server right now");
  });

  it('never says Round over while the phase is live', () => {
    for (const closed of [true, false]) {
      for (const [t, end] of [[0, 10], [10, 10]]) {
        for (const behind of [null, NOW - 1_000, NOW - 60_000]) {
          const text = liveStatusText(true, closed, t, end, phase({}), NOW, {}, behind);
          expect(text).not.toMatch(/Round over/);
        }
      }
    }
  });

  it('lets a pause, a ready-up and a load speak over being behind', () => {
    expect(liveStatusText(true, true, 0, 0, phase({ state: 'paused' }), NOW, {}, NOW - 5_000)).toBe('Paused');
    expect(liveStatusText(true, true, 0, 0, phase({ state: 'loading' }), NOW, {}, NOW - 5_000)).toBe('Loading the next map');
  });

  it('still says Round over between rounds', () => {
    expect(liveStatusText(true, true, 10, 10, phase({ state: 'roundover' }), NOW)).toBe('Round over, waiting for the next round');
  });
});
