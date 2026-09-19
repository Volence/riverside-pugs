import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/preact';
import { TheaterStatus, zoomLabel } from './TheaterStatus';

afterEach(cleanup);

describe('TheaterStatus', () => {
  it('reads time of end, the counts and the zoom', () => {
    render(
      <TheaterStatus tMs={65000} endMs={200000} counts={{ survivors: 3, commons: 12, specials: 2 }}
        zoom={2} live={false} closed />,
    );
    expect(screen.getByText('1:05')).toBeTruthy();
    expect(screen.getByText('of 3:20')).toBeTruthy();
    expect(screen.getByText('3 alive')).toBeTruthy();
    expect(screen.getByText('12 common')).toBeTruthy();
    expect(screen.getByText('2 specials')).toBeTruthy();
    expect(screen.getByText('2x')).toBeTruthy();
  });

  it('flags a live round', () => {
    render(
      <TheaterStatus tMs={0} endMs={0} counts={{ survivors: 0, commons: 0, specials: 0 }}
        zoom={1} live closed={false} />,
    );
    expect(screen.getByText(/live, 10s delayed/i)).toBeTruthy();
  });
  it('says the round is over once a live file closes', () => {
    const counts = { survivors: 0, commons: 0, specials: 0 };
    const { rerender } = render(
      <TheaterStatus tMs={5000} endMs={10_000} counts={counts} zoom={1} live closed />,
    );
    expect(screen.queryByText(/live, 10s delayed/i)).toBeNull();
    expect(screen.getByText(/round over, catching up/i)).toBeTruthy();
    rerender(<TheaterStatus tMs={10_000} endMs={10_000} counts={counts} zoom={1} live closed />);
    expect(screen.getByText(/round over, waiting for the next round/i)).toBeTruthy();
  });
});

describe('zoomLabel', () => {
  it('says fit at 1 and one decimal otherwise, trimmed', () => {
    expect(zoomLabel(1)).toBe('fit');
    expect(zoomLabel(2)).toBe('2x');
    expect(zoomLabel(2.4414)).toBe('2.4x');
  });
});
