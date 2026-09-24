import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { Crosshair } from './Crosshair';
import Hud from './Hud';
import { TEX, resetGameBackdrops } from '../crosshair/draw';
import { ConfirmHost } from '../components/Confirm';
import { communityApi, type CommunityEntryDetail } from '../api';

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
  resetGameBackdrops();
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

  it('carries a saved image over straight after a reload, before the page has decoded it again', () => {
    localStorage.setItem('xhair', JSON.stringify({ shape: 'image' }));
    localStorage.setItem('xhairImage', JSON.stringify({ png: PNG, w: TEX, h: TEX }));
    // Images that never finish loading: the page's own copy is still on its way.
    vi.stubGlobal('Image', class { onload = null; onerror = null; set src(_v: string) {} });
    render(<Crosshair />);
    let followed = false;
    const see = (e: Event) => { followed = !e.defaultPrevented; };
    document.removeEventListener('click', stay);
    document.addEventListener('click', see);
    try {
      fireEvent.click(openInHud());
    } finally {
      document.removeEventListener('click', see);
    }
    expect(followed).toBe(true);
    expect(screen.queryByText('Import an image first, or pick a shape.')).toBeNull();
  });

  it('downloads a saved image straight after a reload, before the page has decoded it again', () => {
    stubCanvas();
    localStorage.setItem('xhair', JSON.stringify({ shape: 'image' }));
    localStorage.setItem('xhairImage', JSON.stringify({ png: PNG, w: TEX, h: TEX }));
    // Images that never finish loading: the page's own copy is still on its way.
    vi.stubGlobal('Image', class { onload = null; onerror = null; set src(_v: string) {} });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:vpk');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    render(<Crosshair />);
    fireEvent.click(screen.getByRole('button', { name: 'Download .vpk' }));
    expect(screen.queryByText('Import an image first, or pick a shape.')).toBeNull();
    expect(screen.getByText(/^Saved /)).toBeTruthy();
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

describe('the Crosshair page backdrop', () => {
  const pick = () => screen.getByRole('combobox', { name: /backdrop/i }) as HTMLSelectElement;
  const drawsOn = (calls: ReturnType<typeof stubCanvas>, cls: string) =>
    calls.filter((c) => c.canvas.classList.contains(cls) && c.m === 'drawImage');

  it('offers the in-game shots, then the drawn saferoom and the flat ones, and opens on the forest', () => {
    render(<Crosshair />);
    const group = pick().querySelector('optgroup[label="In game"]')!;
    expect([...group.querySelectorAll('option')].map((o) => o.value))
      .toEqual(['survivor-hilltop', 'survivor-subway', 'infected-hunter', 'infected-ghost']);
    expect([...pick().options].map((o) => o.textContent)).toContain('Drawn saferoom');
    expect(pick().value).toBe('survivor-hilltop');
  });

  it('keeps the drawn saferoom for a browser that saved it before', () => {
    localStorage.setItem('xhair', JSON.stringify({ shape: 'dot', backdrop: 'scene' }));
    render(<Crosshair />);
    expect(pick().value).toBe('scene');
    expect(pick().selectedOptions[0]!.textContent).toBe('Drawn saferoom');
  });

  it('paints the shot once it loads, and the 4x zoom copies the same middle of the preview', async () => {
    const calls = stubCanvas();
    const loaded = stubImages();
    render(<Crosshair />);
    expect(loaded).toContain('/hud-backdrops/survivor-hilltop.jpg');
    await waitFor(() => expect(drawsOn(calls, 'xh__canvas').length).toBeGreaterThan(0));
    const zooms = drawsOn(calls, 'xh__zoom');
    const last = zooms[zooms.length - 1]!.a;
    expect(last[0]).toBeInstanceOf(HTMLCanvasElement);
    expect((last[0] as HTMLElement).classList.contains('xh__canvas')).toBe(true);
    expect(last.slice(3)).toEqual([64, 64, 0, 0, 256, 256]);
  });

  it('switches to the drawn saferoom and back', () => {
    render(<Crosshair />);
    fireEvent.change(pick(), { target: { value: 'scene' } });
    expect(JSON.parse(localStorage.getItem('xhair')!).backdrop).toBe('scene');
    fireEvent.change(pick(), { target: { value: 'survivor-subway' } });
    expect(JSON.parse(localStorage.getItem('xhair')!).backdrop).toBe('survivor-subway');
  });
});

describe('the Crosshair page and the community page', () => {
  const entry = (art: unknown): CommunityEntryDetail => ({
    id: 7, kind: 'crosshair', title: 'Ring', description: '', createdAt: '2026-09-24T01:00:00.000Z',
    author: { steamid: '76561190000000001', name: 'alice', avatar: null }, likes: 0, likedByMe: false, art,
  });
  const BUILT = { kind: 'built', state: { shape: 'circle', radius: 9, color: '#ffe14d', len: 7, thick: 2, gap: 3, dot: 2, round: false, alpha: 100, outline: 1, oalpha: 80, backdrop: 'scene', res: '1080' } };
  const show = () => render(<><ConfirmHost /><Crosshair /></>);

  it('has Share to community..., which asks a signed-out viewer to sign in', () => {
    render(<Crosshair />);
    fireEvent.click(screen.getByRole('button', { name: 'Share to community...' }));
    expect(screen.getByText('Sign in with Steam to share.')).toBeTruthy();
  });

  it('with ?community= asks before replacing the saved crosshair, then shows and saves the entry', async () => {
    localStorage.setItem('xhair', JSON.stringify({ shape: 'dot', color: '#ffffff' }));
    vi.spyOn(communityApi, 'get').mockResolvedValue(entry(BUILT));
    history.replaceState(null, '', '/crosshair?community=7');
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Use this one' }));
    await waitFor(() => expect((screen.getByRole('slider', { name: 'Radius' }) as HTMLInputElement).value).toBe('9'));
    expect(communityApi.get).toHaveBeenCalledWith(7);
    expect(location.search).toBe('');
    await waitFor(() => expect(JSON.parse(localStorage.getItem('xhair')!)).toMatchObject({ shape: 'circle', radius: 9, color: '#ffe14d' }));
  });

  it('with ?community= keeps the saved crosshair on Keep mine', async () => {
    localStorage.setItem('xhair', JSON.stringify({ shape: 'dot', color: '#ffffff' }));
    vi.spyOn(communityApi, 'get').mockResolvedValue(entry(BUILT));
    history.replaceState(null, '', '/crosshair?community=7');
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Keep mine' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse(localStorage.getItem('xhair')!)).toMatchObject({ shape: 'dot' });
  });

  it('with ?community= on an image keeps the PNG as the saved image, on the image shape', async () => {
    stubCanvas();
    const loaded = stubImages();
    vi.spyOn(communityApi, 'get').mockResolvedValue(entry({ kind: 'image', png: PNG, w: 64, h: 64 }));
    history.replaceState(null, '', '/crosshair?community=7');
    show();
    await waitFor(() => expect(JSON.parse(localStorage.getItem('xhair')!).shape).toBe('image'));
    expect(JSON.parse(localStorage.getItem('xhairImage')!)).toEqual({ png: PNG, w: 64, h: 64 });
    await waitFor(() => expect(loaded).toContain(PNG));
  });
});
