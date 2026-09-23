import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { Crosshair } from './Crosshair';
import Hud from './Hud';
import { TEX } from '../crosshair/draw';

const PNG = 'data:image/png;base64,UE5H';

/** happy-dom has no 2D context: every canvas gets one that does nothing, and toDataURL gives PNG. */
function stubCanvas() {
  const calls: { canvas: HTMLCanvasElement; m: string; a: unknown[] }[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    const canvas = this;
    return new Proxy({}, {
      get: (_t, k) => (...a: unknown[]) => {
        calls.push({ canvas, m: String(k), a });
        if (k === 'getImageData') return { data: new Uint8ClampedArray(TEX * TEX * 4) };
        if (k === 'measureText') return { width: 10 };
        if (k === 'createLinearGradient' || k === 'createRadialGradient') return { addColorStop() {} };
        return undefined;
      },
      set: () => true,
    }) as never;
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(PNG);
  return calls;
}

/** Images that load at once, remembering what they were asked to load. */
function stubImages() {
  const loaded: string[] = [];
  vi.stubGlobal('Image', class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    complete = false; naturalWidth = 0; naturalHeight = 0; width = 0; height = 0;
    set src(v: string) {
      loaded.push(v);
      queueMicrotask(() => { this.complete = true; this.naturalWidth = this.width = 64; this.naturalHeight = this.height = 64; this.onload?.(); });
    }
  });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:img');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  return loaded;
}

/** The link would navigate; the SPA router does that in the app, and here nothing should. */
const stay = (e: Event) => e.preventDefault();
beforeEach(() => { localStorage.clear(); document.addEventListener('click', stay); });
afterEach(() => {
  cleanup();
  localStorage.clear();
  document.removeEventListener('click', stay);
  history.replaceState(null, '', '/');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const openInHud = () => screen.getByRole('link', { name: 'Open in the HUD editor' });

describe('Crosshair page', () => {
  it('warns that a crosshair addon and a HUD addon fight, and offers the HUD editor instead', () => {
    render(<Crosshair />);
    expect(screen.getByText(/Planning a custom HUD too\?/)).toBeTruthy();
    expect(screen.getByText(/fight over the same file/)).toBeTruthy();
    expect(openInHud().getAttribute('href')).toBe('/hud?from=crosshair');
  });

  it('saves the crosshair as it is when the button is pressed', () => {
    render(<Crosshair />);
    fireEvent.click(screen.getByRole('button', { name: 'T yellow' }));
    localStorage.removeItem('xhair');
    fireEvent.click(openInHud());
    expect(JSON.parse(localStorage.getItem('xhair')!)).toMatchObject({ shape: 't', color: '#ffe14d' });
  });

  it('saves an imported image as the texture it exports, and gets it back on the next visit', async () => {
    stubCanvas();
    const loaded = stubImages();
    render(<Crosshair />);
    const file = new File([new Uint8Array(8)], 'mine.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText(/use your own image/i), { target: { files: [file] } });
    await waitFor(() => expect(JSON.parse(localStorage.getItem('xhair')!).shape).toBe('image'));
    expect(JSON.parse(localStorage.getItem('xhairImage')!)).toEqual({ png: PNG, w: TEX, h: TEX });
    cleanup();
    render(<Crosshair />);
    await waitFor(() => expect(loaded).toContain(PNG));
  });

  it('asks for an image first, rather than open the editor with nothing, on the image shape', () => {
    render(<Crosshair />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Shape' }), { target: { value: 'image' } });
    // Without the test's own guard, so the page's own refusal is what stops the link.
    document.removeEventListener('click', stay);
    expect(fireEvent.click(openInHud())).toBe(false);
    expect(screen.getByText('Import an image first, or pick a shape.')).toBeTruthy();
  });

  it('carries a built crosshair into the HUD editor, selected', () => {
    localStorage.setItem('hud', JSON.stringify({ v: 1, name: 'mine', crosshair: 'none' }));
    render(<Crosshair />);
    fireEvent.click(screen.getByRole('button', { name: 'Circle + dot' }));
    fireEvent.click(openInHud());
    cleanup();
    history.replaceState(null, '', '/hud?from=crosshair');
    render(<Hud />);
    expect(screen.getByText('Custom crosshair', { selector: 'legend' })).toBeTruthy();
    expect((screen.getByRole('combobox', { name: 'Shape' }) as HTMLSelectElement).value).toBe('circledot');
  });

  it('carries an imported image into the HUD editor, selected', async () => {
    stubCanvas();
    stubImages();
    localStorage.setItem('hud', JSON.stringify({ v: 1, name: 'mine', crosshair: 'none' }));
    render(<Crosshair />);
    fireEvent.change(screen.getByLabelText(/use your own image/i), { target: { files: [new File([new Uint8Array(8)], 'm.png')] } });
    await waitFor(() => expect(localStorage.getItem('xhairImage')).not.toBeNull());
    fireEvent.click(openInHud());
    cleanup();
    history.replaceState(null, '', '/hud?from=crosshair');
    render(<Hud />);
    expect(screen.getByText('Custom crosshair', { selector: 'legend' })).toBeTruthy();
    expect(screen.getByText(/your uploaded crosshair/i)).toBeTruthy();
  });
});
