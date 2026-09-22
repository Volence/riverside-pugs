import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/preact';
import { snap, nudge, toUnits } from './Hud';
import Hud from './Hud';
import { DEFAULT_DESIGN } from '../hud/design';

describe('snap', () => {
  it('snaps edges and centre, and otherwise leaves the value alone', () => {
    expect(snap(3, 100, 853)).toBe(0);
    expect(snap(750, 100, 853)).toBe(753);
    expect(snap(375, 100, 853)).toBe(376.5);
    expect(snap(200, 100, 853)).toBe(200);
  });
});

describe('nudge', () => {
  it('starts from the base position the first time', () => {
    const d = nudge(DEFAULT_DESIGN, 'ownHealth', -10, 0);
    expect(d.elements.ownHealth).toEqual({ x: 718, y: 389 });
  });
  it('does nothing to an element that cannot move', () => {
    expect(nudge(DEFAULT_DESIGN, 'killFeed', 5, 5)).toBe(DEFAULT_DESIGN);
  });
});

describe('toUnits', () => {
  it('converts a pointer position to HUD units', () => {
    const rect = { left: 100, top: 50, width: 1706, height: 960 } as DOMRect;
    expect(toUnits({ clientX: 100 + 853, clientY: 50 + 480 }, rect)).toEqual({ ux: 426.5, uy: 240 });
  });
});

afterEach(cleanup);

/* Shallow on purpose, like routes.test.tsx: happy-dom's canvas 2D context is
 * a stub (getContext returns null), so the draw effect is a no-op here and
 * there is nothing to assert about pixels. This just pins that the shell
 * renders and that picking a side changes which elements are offered. */
describe('Hud page', () => {
  it('lists the current side elements and swaps them when the side toggle changes', () => {
    render(<Hud />);
    expect(screen.getByText('Your health')).toBeTruthy();
    expect(screen.queryByText('Ability timer')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Infected' }));
    expect(screen.queryByText('Your health')).toBeNull();
    expect(screen.getByText('Ability timer')).toBeTruthy();
  });

  it('shows an element panel only once something is selected', () => {
    render(<Hud />);
    expect(screen.getByText(/select an element/i)).toBeTruthy();
    fireEvent.click(screen.getByText('Your health'));
    expect(screen.queryByText(/select an element/i)).toBeNull();
    expect(screen.getByText('Reset this element')).toBeTruthy();
  });
});
