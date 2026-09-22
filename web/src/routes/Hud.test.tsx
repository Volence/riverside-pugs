import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/preact';
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

  // Dragging clamps to an 8-unit floor via clampSpan; a plain x + dx nudge
  // would not, so repeated arrow presses could walk an element arbitrarily
  // far off screen. This pins that nudge shares the same floor, the same
  // way repeated arrow-key presses would call it.
  it('keeps at least 8 units of the element on screen, however far it is pushed, matching the drag clamp', () => {
    let d = DEFAULT_DESIGN;
    for (let i = 0; i < 200; i++) d = nudge(d, 'ownHealth', -10, -10);
    // ownHealth is 125x91 HUD units at 16:9 (853 wide): clampSpan's 8-unit
    // floor caps x at 8 - 125 and y at 8 - 91.
    expect(d.elements.ownHealth).toEqual({ x: 8 - 125, y: 8 - 91 });
  });

  it('also clamps on the far side', () => {
    let d = DEFAULT_DESIGN;
    for (let i = 0; i < 200; i++) d = nudge(d, 'ownHealth', 10, 10);
    expect(d.elements.ownHealth).toEqual({ x: 853 - 8, y: 480 - 8 });
  });
});

describe('toUnits', () => {
  it('converts a pointer position to HUD units', () => {
    const rect = { left: 100, top: 50, width: 1706, height: 960 } as DOMRect;
    expect(toUnits({ clientX: 100 + 853, clientY: 50 + 480 }, rect)).toEqual({ ux: 426.5, uy: 240 });
  });
});

beforeEach(() => {
  // Each test starts from a clean slate: a saved design or a leftover hash
  // from one test must not change what the next one sees.
  localStorage.clear();
  location.hash = '';
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  location.hash = '';
});

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

  it('shows the preset select and the download button', () => {
    render(<Hud />);
    expect(screen.getByRole('combobox', { name: /preset/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /download/i })).toBeTruthy();
  });

  it('reveals the advanced-only style rows and switches the download button to a zip', () => {
    render(<Hud />);
    expect(screen.queryByText('Health bar: healthy')).toBeNull();
    expect(screen.getByRole('button', { name: /download/i }).textContent).toMatch(/vpk/i);

    fireEvent.click(screen.getByRole('button', { name: /advanced mode/i }));

    expect(screen.getByText('Health bar: healthy')).toBeTruthy();
    expect(screen.getByRole('button', { name: /download/i }).textContent).toMatch(/zip/i);
  });

  it('shows a damaged-link message for a hash that will not decode', async () => {
    location.hash = '#d=garbage';
    render(<Hud />);
    expect(await screen.findByText('That link is damaged.')).toBeTruthy();
  });

  it('imports a design and selects its preset', async () => {
    render(<Hud />);
    const file = new File(['{"v":1,"preset":"modern"}'], 'my.hud.json', { type: 'application/json' });
    fireEvent.change(screen.getByLabelText('Import a HUD design file'), { target: { files: [file] } });

    await waitFor(() => {
      expect((screen.getByRole('combobox', { name: /preset/i }) as HTMLSelectElement).value).toBe('modern');
    });
  });
});
