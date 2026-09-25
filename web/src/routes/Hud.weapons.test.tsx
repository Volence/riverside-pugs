import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/preact';

// happy-dom cannot decode an image, so the page's decoder is stood in for: it
// sizes the upload the way the page asks (a fixed size, or from a 300 x 100
// picture's own shape) and hands back blank pixels at that size.
const decode = vi.hoisted(() => ({ calls: [] as { w: number; h: number }[] }));
vi.mock('./hud/decode', async (original) => ({
  ...(await original<typeof import('./hud/decode')>()),
  decodeUpload: async (_file: Blob, a: number | ((w: number, h: number) => { w: number; h: number }), b?: number) => {
    const { w, h } = typeof a === 'function' ? a(300, 100) : { w: a, h: b! };
    decode.calls.push({ w, h });
    return { rgba: new Uint8ClampedArray(w * h * 4), png: 'AAAA', w, h };
  },
}));

import Hud from './Hud';
import type { HudDesign } from '../hud/design';

beforeEach(() => { localStorage.clear(); location.hash = ''; decode.calls = []; });
afterEach(() => { cleanup(); localStorage.clear(); location.hash = ''; });

const stored = () => JSON.parse(localStorage.getItem('hud') ?? '{}') as HudDesign;
const pick = () => fireEvent.click(screen.getByRole('button', { name: 'Weapons' }));
const file = () => new File([new Uint8Array(8)], 'pic.png', { type: 'image/png' });
const LABELS = ['Pump shotgun', 'Uzi', 'Auto shotgun', 'Hunting rifle', 'M16 (assault rifle)', 'Dual pistols', 'Pistol',
  'Molotov', 'Pipe bomb', 'Medkit', 'Pills'];

describe('the weapon picture uploads', () => {
  it('lists every gun and item with an upload and a reset, the pistols drawn square', () => {
    render(<Hud />);
    pick();
    const rows = screen.getAllByRole('group').filter((g) => g.classList.contains('hud__weaponpic'));
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual(LABELS);
    for (const label of LABELS) {
      expect(screen.getByLabelText(`${label} picture`)).toBeTruthy();
      expect((screen.getByRole('button', { name: `Reset ${label} picture` }) as HTMLButtonElement).disabled).toBe(true);
    }
    for (const label of ['Dual pistols', 'Pistol']) expect(within(rows[LABELS.indexOf(label)]).getByText(/Drawn square/)).toBeTruthy();
    expect(within(rows[0]).queryByText(/Drawn square/)).toBeNull();
  });

  it('stores a gun picture at 64 tall in its own shape, then resets it', async () => {
    render(<Hud />);
    pick();
    fireEvent.change(screen.getByLabelText('M16 (assault rifle) picture'), { target: { files: [file()] } });
    await waitFor(() => expect(stored().weapons?.icons).toEqual({ icon_equip_machinegun: 'wiconMachinegun' }));
    expect(decode.calls).toEqual([{ w: 192, h: 64 }]);
    expect(stored().images.wiconMachinegun).toEqual({ w: 192, h: 64, png: 'AAAA' });
    const reset = screen.getByRole('button', { name: 'Reset M16 (assault rifle) picture' }) as HTMLButtonElement;
    expect(reset.disabled).toBe(false);
    fireEvent.click(reset);
    await waitFor(() => expect(stored().weapons).toBeUndefined());
    expect(stored().images).toEqual({});
  });

  it('stores a pistol or item picture 64 square whatever its shape', async () => {
    render(<Hud />);
    pick();
    fireEvent.change(screen.getByLabelText('Pistol picture'), { target: { files: [file()] } });
    fireEvent.change(screen.getByLabelText('Pills picture'), { target: { files: [file()] } });
    await waitFor(() => expect(Object.keys(stored().weapons?.icons ?? {}).sort()).toEqual(['icon_equip_pills', 'icon_equip_pistol']));
    expect(decode.calls).toEqual([{ w: 64, h: 64 }, { w: 64, h: 64 }]);
  });

  it('offers Image as a box style, with an upload drawn at 128 square', async () => {
    render(<Hud />);
    pick();
    const kind = screen.getByRole('combobox', { name: 'Active box' }) as HTMLSelectElement;
    expect([...kind.options].map((o) => o.textContent)).toContain('Image');
    fireEvent.change(kind, { target: { value: 'image' } });
    expect(screen.getByText(/No picture yet/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Active box image'), { target: { files: [file()] } });
    await waitFor(() => expect(stored().weapons?.boxActive).toEqual({ kind: 'image' }));
    expect(stored().images.weaponBoxActive).toEqual({ w: 128, h: 128, png: 'AAAA' });
    expect(decode.calls).toEqual([{ w: 128, h: 128 }]);
    expect(screen.queryByText(/No picture yet/)).toBeNull();
  });
});
