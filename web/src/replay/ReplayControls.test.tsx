import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import { ReplayControls } from './ReplayControls';
import { FREE, TEAM } from './camera';
import type { TimelineEntry } from './timeline';

afterEach(cleanup);

const playback = {
  tRef: { current: 0 }, tMs: 0, playing: true, speed: 1, following: false,
  play() {}, pause() {}, toggle() {}, seek() {}, setSpeed() {}, follow() {},
};

const SLOTS = ['A', 'B', '', '', 'H', '', '', ''];
const NAMES = { A: 'volence', B: 'tino', H: 'hunter' };
const T: TimelineEntry[] = [
  { seq: 1, tMs: 25000, kind: 'event', event: 'dp', actor: 'H', target: 'A', value: 12 },
  { seq: 2, tMs: 50000, kind: 'chat', actor: 'B', team: 'survivor', text: 'gg' },
  { seq: 3, tMs: 75000, kind: 'event', event: 'skeet', actor: 'A', target: 'H', value: 0 },
];

function mount(over: Partial<Parameters<typeof ReplayControls>[0]> = {}) {
  return render(
    <ReplayControls
      playback={playback} endMs={100000} live={false}
      follow={FREE} setFollow={() => {}} slots={SLOTS} names={NAMES}
      timeline={T}
      {...over}
    />,
  );
}

describe('ReplayControls ticks', () => {
  it('places one tick per timeline entry at its fraction of the round', () => {
    const { container } = mount();
    const ticks = container.querySelectorAll('.scrub__tick');
    expect(ticks).toHaveLength(3);
    expect((ticks[0] as HTMLElement).style.left).toBe('25%');
    expect(ticks[0].classList.contains('scrub__tick--event')).toBe(true);
    expect((ticks[1] as HTMLElement).style.left).toBe('50%');
    expect(ticks[1].classList.contains('scrub__tick--chat')).toBe(true);
  });

  it('renders no tick layer without a timeline', () => {
    const { container } = mount({ timeline: undefined });
    expect(container.querySelector('.scrub__tick')).toBeNull();
  });

  it('seeks to the entry when a tick is clicked, and says what it is', () => {
    const seek = vi.fn();
    const { container } = mount({ playback: { ...playback, seek } });
    const tick = container.querySelectorAll('.scrub__tick')[0] as HTMLButtonElement;
    expect(tick.tagName).toBe('BUTTON');
    expect(tick.getAttribute('aria-label')).toBe('0:25 hunter pounced volence for 12');
    fireEvent.click(tick);
    expect(seek).toHaveBeenCalledWith(25000);
  });

  // Spec 7.2: the follow row is the selector. Slot 0 is 'A'.
  it('filters and colours the ticks by the followed player and their side', () => {
    const { container } = mount({ follow: { kind: 'slot', slot: 0 } });
    const ticks = [...container.querySelectorAll('.scrub__tick')];
    expect(ticks).toHaveLength(2);
    expect(ticks[0].classList.contains('scrub__tick--suffered')).toBe(true);
    expect(ticks[1].classList.contains('scrub__tick--did')).toBe(true);
  });

  it('shows nothing for a followed slot with no roster entry', () => {
    const { container } = mount({ follow: { kind: 'slot', slot: 2 } });
    expect(container.querySelectorAll('.scrub__tick')).toHaveLength(0);
  });

  it('sizes the progress fill as a percentage of the round, browser-independently', () => {
    const { container } = mount({ playback: { ...playback, tMs: 25000 } });
    const progress = container.querySelector('.scrub__progress') as HTMLElement;
    expect(progress.style.width).toBe('25%');
  });
});

describe('ReplayControls follow row', () => {
  it('offers free, the survivor centroid and every slot', () => {
    const setFollow = vi.fn();
    // No timeline here: with `follow` not on a slot, ticks render unfiltered
    // (bookmarks.tickEntries with a null selection), and T's own chat line is
    // from 'tino', which would collide with the slot chip of the same name
    // under the same `/tino/` query. This test is about the follow row, not
    // the ticks, so leaving the timeline out sidesteps the coincidence.
    const { getByRole } = mount({ setFollow, follow: TEAM, timeline: undefined });
    expect(getByRole('button', { name: 'Survivors' }).classList.contains('is-on')).toBe(true);
    fireEvent.click(getByRole('button', { name: 'Free' }));
    expect(setFollow).toHaveBeenCalledWith(FREE);
    fireEvent.click(getByRole('button', { name: /tino/ }));
    expect(setFollow).toHaveBeenCalledWith({ kind: 'slot', slot: 1 });
  });
});
