import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/preact';
import Hud from './Hud';
import { ConfirmHost } from '../components/Confirm';
import { readVPK } from '../vpk/read';

beforeEach(() => { localStorage.clear(); location.hash = ''; });
afterEach(() => { cleanup(); localStorage.clear(); location.hash = ''; vi.restoreAllMocks(); });

const saved = () => JSON.parse(localStorage.getItem('hud') ?? 'null');
const show = () => render(<><ConfirmHost /><Hud /></>);
const resetBtn = () => screen.getByRole('button', { name: 'Reset to game default' }) as HTMLButtonElement;
/** A design with edits all over it. */
const MINE = {
  v: 1, name: 'mine', preset: 'modern', font: 'roboto', aspect: '16:10', crosshair: 'addon', pickupFlyIn: false,
  elements: { chat: { x: 5 }, teamColumn: { fit: true } }, children: { teamColumn: { Name: { x: 3 } } },
  styles: { panelBg: { kind: 'flat', color: '1 2 3 255' } }, weapons: { primaryY: 10 },
};
const STOCK = {
  v: 1, name: 'mine', preset: 'stock', advanced: false, aspect: '16:10', font: 'preset', crosshair: 'none',
  elements: {}, styles: {}, images: {}, children: {},
};

describe('Reset to game default', () => {
  it('asks first, and Keep my design changes nothing', async () => {
    localStorage.setItem('hud', JSON.stringify(MINE));
    show();
    fireEvent.click(resetBtn());
    fireEvent.click(await screen.findByRole('button', { name: 'Keep my design' }));
    await new Promise((r) => setTimeout(r, 350));
    expect(saved().preset).toBe('modern');
    expect(saved().elements.chat).toEqual({ x: 5 });
  });

  it('gives the untouched game HUD as one undoable step, keeping the name', async () => {
    localStorage.setItem('hud', JSON.stringify(MINE));
    show();
    fireEvent.click(resetBtn());
    expect(await screen.findByText("Reset to the game's own HUD?")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(saved()).toEqual(STOCK));
    expect((screen.getByRole('combobox', { name: /preset/i }) as HTMLSelectElement).value).toBe('stock');
    expect(resetBtn().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(saved().preset).toBe('modern'));
    expect(saved().elements.chat).toEqual({ x: 5 });
    expect(saved().weapons).toEqual({ primaryY: 10 });
    expect(saved().pickupFlyIn).toBe(false);
  });

  it('is off on a design that is the game default already, and a fresh design is not (it fits the cards)', () => {
    show();
    expect(resetBtn().disabled).toBe(false);
    cleanup();
    localStorage.setItem('hud', JSON.stringify(STOCK));
    show();
    expect(resetBtn().disabled).toBe(true);
  });

  it('downloads a file with no HUD in it, and says there is nothing to install', async () => {
    localStorage.setItem('hud', JSON.stringify(STOCK));
    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { blobs.push(b as Blob); return 'blob:hud'; });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    show();
    fireEvent.click(screen.getByRole('button', { name: /download/i }));
    await screen.findByText(/^Saved mine\.vpk\. This is the game's own HUD; you don't need to install anything\./);
    const vpk = readVPK(new Uint8Array(await blobs[0].arrayBuffer()));
    expect([...vpk.keys()]).toEqual(['addoninfo.txt']);
  });
});

describe('the Riverside Modern preset', () => {
  it('is named Riverside Modern to players, stored as modern', async () => {
    localStorage.setItem('hud', JSON.stringify({ v: 1, name: 'mine', preset: 'modern', crosshair: 'none' }));
    show();
    const select = screen.getByRole('combobox', { name: /preset/i }) as HTMLSelectElement;
    expect([...select.options].find((o) => o.value === 'modern')?.textContent).toBe('Riverside Modern');
    expect(screen.getByText('Riverside Modern already uses Roboto Condensed.')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 350));
    expect(saved().preset).toBe('modern');
  });
});
