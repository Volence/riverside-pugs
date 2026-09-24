import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/preact';

// happy-dom cannot decode an image, so the page's decoder is stood in for:
// it hands back blank pixels at the size the page asks for.
const decode = vi.hoisted(() => ({ calls: [] as { w: number; h: number }[] }));
vi.mock('./hud/decode', async (original) => ({
  ...(await original<typeof import('./hud/decode')>()),
  decodeUpload: async (_file: Blob, a: number | ((w: number, h: number) => { w: number; h: number }), b?: number) => {
    const { w, h } = typeof a === 'function' ? a(300, 100) : { w: a, h: b! };
    decode.calls.push({ w, h });
    return { rgba: new Uint8ClampedArray(w * h * 4), png: 'AAAA', w, h };
  },
}));

import Hud, { assetSize } from './Hud';
import type { HudDesign } from '../hud/design';
import { TEAM_PANEL } from '../hud/children';
import { _setProbe } from '../hud/probes';

beforeEach(() => { localStorage.clear(); location.hash = ''; decode.calls = []; });
afterEach(() => { cleanup(); localStorage.clear(); location.hash = ''; _setProbe('P2', null); });

const stored = () => JSON.parse(localStorage.getItem('hud') ?? '{}') as HudDesign;
const file = () => new File([new Uint8Array(8)], 'pic.png', { type: 'image/png' });
const layer = (label: string) => within(screen.getByRole('group', { name: `Layers: ${label}` }));

/** The voice icon uploads on the page (plan task T2). */
describe('the voice icon uploads', () => {
  it('offers only your microphone icon while gate P2 is closed: the teammate icon was never seen in game', async () => {
    render(<Hud />);
    fireEvent.click(layer('Your microphone').getByRole('button', { name: 'Your microphone' }));
    expect(screen.getByLabelText('Your microphone icon picture')).toBeTruthy();
    expect(screen.queryByLabelText('Teammate talking icon picture')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset Teammate talking icon' })).toBeNull();
  });

  it('stores your microphone and the teammate talking icon (P2 open) at 64 x 64 from the microphone panel, then resets them', async () => {
    _setProbe('P2', true);
    render(<Hud />);
    fireEvent.click(layer('Your microphone').getByRole('button', { name: 'Your microphone' }));
    for (const [label, id] of [['Your microphone icon', 'voiceSelf'], ['Teammate talking icon', 'voicePlayer']]) {
      const reset = screen.getByRole('button', { name: `Reset ${label}` }) as HTMLButtonElement;
      expect(reset.disabled).toBe(true);
      fireEvent.change(screen.getByLabelText(`${label} picture`), { target: { files: [file()] } });
      await waitFor(() => expect(stored().images?.[id]).toEqual({ w: 64, h: 64, png: 'AAAA' }));
    }
    expect(decode.calls).toEqual([{ w: 64, h: 64 }, { w: 64, h: 64 }]);
    expect(screen.getByText('Shown when a teammate talks; not seen in our tests (needs a second player).')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset Your microphone icon' }));
    await waitFor(() => expect(stored().images?.voiceSelf).toBeUndefined());
    expect(stored().images?.voicePlayer).toBeDefined();
  });

  it('redraws a voice icon at 64 x 64 when building, and says when the teammate icon shows on the card', () => {
    expect(assetSize('voiceSelf', { w: 64, h: 64 })).toEqual({ w: 64, h: 64 });
    expect(assetSize('voicePlayer')).toEqual({ w: 64, h: 64 });
    expect(TEAM_PANEL.children.find((c) => c.name === 'Voice')!.note).toMatch(/^Shown when a teammate talks; not seen in our tests \(needs a second player\)/);
  });
});
