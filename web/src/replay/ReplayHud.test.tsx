import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/preact';
import { ReplayHud } from './ReplayHud';
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
});
