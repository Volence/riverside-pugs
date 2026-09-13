import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/preact';
import { ReplayControls } from './ReplayControls';

afterEach(cleanup);

const playback = {
  tRef: { current: 0 }, tMs: 0, playing: true, speed: 1, following: false,
  play() {}, pause() {}, toggle() {}, seek() {}, setSpeed() {}, follow() {},
};

describe('ReplayControls ticks', () => {
  it('places one tick per timeline entry at its fraction of the round', () => {
    const { container } = render(
      <ReplayControls
        playback={playback} endMs={100000} live={false}
        followSlot={null} setFollowSlot={() => {}} slots={[]} names={{}}
        timeline={[
          { seq: 1, tMs: 25000, kind: 'event', text: 'pounced', actor: 'x', team: null },
          { seq: 2, tMs: 50000, kind: 'chat', text: 'gg', actor: 'y', team: 'survivor' },
        ]}
      />,
    );
    const ticks = container.querySelectorAll('.scrub__tick');
    expect(ticks).toHaveLength(2);
    expect((ticks[0] as HTMLElement).style.left).toBe('25%');
    expect(ticks[0].classList.contains('scrub__tick--event')).toBe(true);
    expect((ticks[1] as HTMLElement).style.left).toBe('50%');
    expect(ticks[1].classList.contains('scrub__tick--chat')).toBe(true);
  });

  it('renders no tick layer without a timeline', () => {
    const { container } = render(
      <ReplayControls playback={playback} endMs={1000} live={false}
        followSlot={null} setFollowSlot={() => {}} slots={[]} names={{}} />,
    );
    expect(container.querySelector('.scrub__tick')).toBeNull();
  });

  it('sizes the progress fill as a percentage of the round, browser-independently', () => {
    const { container } = render(
      <ReplayControls
        playback={{ ...playback, tMs: 25000 }} endMs={100000} live={false}
        followSlot={null} setFollowSlot={() => {}} slots={[]} names={{}}
      />,
    );
    const progress = container.querySelector('.scrub__progress') as HTMLElement;
    expect(progress.style.width).toBe('25%');
  });
});
