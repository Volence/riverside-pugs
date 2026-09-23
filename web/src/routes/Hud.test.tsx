import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/preact';
import { toUnits } from './Hud';
import Hud from './Hud';
import { readFileSync } from 'node:fs';
import { crosshairFiles } from '../crosshair/vpk';
import { TEX, PX_AT_1080 } from '../crosshair/draw';
import { encodeVPK, encodeVTF } from '../vpk';
import { join } from 'node:path';

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
  // A spy restored on the last line of its own test stays installed if an
  // earlier assertion throws, and every later test in the file then runs
  // against it. Restoring here happens either way.
  vi.restoreAllMocks();
});

/** Where `needle` first occurs in `hay`, or -1. */
function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** happy-dom lays nothing out: a 1:1 box makes client pixels HUD units. */
const unitCanvas = (container: Element) => {
  const canvas = container.querySelector('canvas') as HTMLCanvasElement;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 853, height: 480, right: 853, bottom: 480, x: 0, y: 0, toJSON() {} }) as DOMRect;
  return canvas;
};
type Keys = { shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean };
/** A press and release on one spot: a click. */
const clickAt = (canvas: HTMLElement, x: number, y: number, keys: Keys = {}) => {
  fireEvent.pointerDown(canvas, { clientX: x, clientY: y, pointerId: 1, ...keys });
  fireEvent.pointerUp(canvas, { clientX: x, clientY: y, pointerId: 1, ...keys });
};
/** A drag, with Alt held unless told otherwise, so the numbers are the pointer's and not a snap's. */
const dragFrom = (canvas: HTMLElement, from: [number, number], to: [number, number], keys: Keys = { altKey: true }) => {
  fireEvent.pointerDown(canvas, { clientX: from[0], clientY: from[1], pointerId: 1, ...keys });
  fireEvent.pointerMove(canvas, { clientX: to[0], clientY: to[1], pointerId: 1, ...keys });
  fireEvent.pointerUp(canvas, { clientX: to[0], clientY: to[1], pointerId: 1, ...keys });
};

/* Shallow on purpose, like routes.test.tsx: happy-dom's canvas 2D context is
 * a stub (getContext returns null), so the draw effect is a no-op here and
 * there is nothing to assert about pixels. This just pins that the shell
 * renders and that picking a side changes which elements are offered. */
describe('Hud page', () => {
  it('lists the teammate card pieces in Layers, and adds the health number on stock', () => {
    render(<Hud />);
    for (const label of ['Portrait', 'Health bar', 'Name', 'Item icons', 'Status text', 'Damage splatter', 'Down picture', 'Dead picture', 'Voice icon']) {
      expect(screen.getByRole('button', { name: label }), label).toBeTruthy();
    }
    expect(screen.getByText('shown when down')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Health number' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '＋ Health number' }));
    expect(screen.getByRole('button', { name: 'Health number' })).toBeTruthy();
    expect(screen.getByText('Health number', { selector: 'legend' })).toBeTruthy();
    expect(screen.getByText("Edits inside a card apply to every teammate's card.")).toBeTruthy();
  });

  it('steps back to the teammates when the selected piece is removed', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: '＋ Health number' }));
    expect(screen.getByText('Reset this child')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove the health number' }));
    expect(screen.getByText('Reset this element')).toBeTruthy();
    expect(screen.getByRole('button', { name: '＋ Health number' })).toBeTruthy();
  });

  it('drops a picked child when the preset changes', async () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    fireEvent.click(screen.getByRole('button', { name: 'Portrait' }));
    expect(screen.getByText('Reset this child')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: /preset/i }), { target: { value: 'modern' } });
    await waitFor(() => expect(screen.getByText('Reset this element')).toBeTruthy());
  });

  it('keeps an added health number added when its child is reset', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: '＋ Health number' }));
    fireEvent.input(screen.getByLabelText('X'), { target: { value: '90' } });
    fireEvent.click(screen.getByText('Reset this child'));
    // The move is gone and the number is still there: back at the template's x 103.
    expect(screen.getByRole('button', { name: 'Health number' })).toBeTruthy();
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('103');
  });

  it('shows one Size box for the portrait and writes both sides', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    fireEvent.click(screen.getByRole('button', { name: 'Portrait' }));
    expect(screen.queryByLabelText('W')).toBeNull();
    fireEvent.input(screen.getByLabelText('Size'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    fireEvent.click(screen.getByRole('button', { name: 'Portrait' }));
    expect((screen.getByLabelText('Size') as HTMLInputElement).value).toBe('30');
  });

  it('offers no colour for the health number and says why, and a colour for the name', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: '＋ Health number' }));
    expect(screen.getByText('The game colours this by health.')).toBeTruthy();
    expect(screen.queryByLabelText('Health number colour')).toBeNull();
    expect(screen.getByLabelText('Text size')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(screen.getByLabelText('Name colour')).toBeTruthy();
  });

  it('offers the splatter Opacity alone, no colour swatch, with a note why, and X, Y, W and H', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Damage splatter' }));
    // The splatter art is pure black: an RGB tint would draw no visible difference, so there is no swatch.
    expect(screen.getByLabelText('Damage splatter opacity')).toBeTruthy();
    expect(screen.queryByLabelText('Damage splatter tint')).toBeNull();
    expect(screen.queryByLabelText('Damage splatter colour')).toBeNull();
    expect(screen.getByText(/splatter art is black/)).toBeTruthy();
    expect(screen.getByText(/Styles, Survivor panel background/)).toBeTruthy();
    expect(screen.getByLabelText('X')).toBeTruthy();
    expect(screen.getByLabelText('Y')).toBeTruthy();
    expect(screen.getByLabelText('W')).toBeTruthy();
    expect(screen.getByLabelText('H')).toBeTruthy();
  });

  it('hides and shows from the eye in Layers, struck through while hidden', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide Chat' }));
    const row = () => screen.getByRole('button', { name: 'Chat' }).closest('.hud__layer')!;
    expect(row().classList.contains('hud__layer--hidden')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Show Chat' }));
    expect(row().classList.contains('hud__layer--hidden')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Hide Portrait' }));
    expect(screen.getByRole('button', { name: 'Portrait' }).closest('.hud__layer')!.classList.contains('hud__layer--hidden')).toBe(true);
  });

  it('selects from Layers, Shift+click adding, and lists the cards in every layout, card 4 in Free only', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Your health' }), { shiftKey: true });
    expect(screen.getByText('2 elements', { selector: 'legend' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Card 2' }));
    expect(screen.getByText('Teammate card 2', { selector: 'legend' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Card 3' }), { shiftKey: true });
    expect(screen.getByText('2 cards', { selector: 'legend' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Card 4' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    fireEvent.change(screen.getByRole('combobox', { name: /^Layout/ }), { target: { value: 'free' } });
    fireEvent.click(screen.getByRole('button', { name: 'Card 4' }));
    expect(screen.getByText('Teammate card 4', { selector: 'legend' })).toBeTruthy();
  });

  it("snaps a child's X box to its cap, and goes back to the teammates", () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    fireEvent.input(screen.getByLabelText('X'), { target: { value: '9999' } });
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('512');
    fireEvent.click(screen.getByRole('button', { name: 'Back to Teammates' }));
    expect(screen.getByText('Reset this element')).toBeTruthy();
  });

  it('gives the item icons an Icon size and no W or H', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    fireEvent.click(screen.getByRole('button', { name: 'Item icons' }));
    expect((screen.getByLabelText('Icon size') as HTMLInputElement).value).toBe('18');
    expect(screen.queryByLabelText('W')).toBeNull();
    expect(screen.getByText(/the game's own item icons, a full loadout/)).toBeTruthy();
  });

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

  it('says the infected health card is shown as the Hunter and that the Tank uses the same file', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('tab', { name: 'Infected' }));
    fireEvent.click(screen.getByRole('button', { name: 'Your infected health' }));
    expect(screen.getByText('Shown as the Hunter; the Tank uses the same file.')).toBeTruthy();
  });

  it('reveals the advanced-only style rows and switches the download button to a zip', () => {
    render(<Hud />);
    expect(screen.queryByText('Incapacitated panel')).toBeNull();
    expect(screen.getByRole('button', { name: /download/i }).textContent).toMatch(/vpk/i);

    fireEvent.click(screen.getByRole('button', { name: /advanced mode/i }));

    expect(screen.getByText('Incapacitated panel')).toBeTruthy();
    expect(screen.queryByText('Health bar: healthy')).toBeNull();
    expect(screen.getByRole('button', { name: /download/i }).textContent).toMatch(/zip/i);
    // The advanced install copy has to carry the same two facts the normal
    // one does (spec's Output section): a restart is needed, and custom
    // HUDs are allowed on the Riverside servers.
    expect(screen.getByText(/game restart/i)).toBeTruthy();
    expect(screen.getByText(/Riverside servers/i)).toBeTruthy();
  });

  it('shows the crosshair/addonlist note only in normal mode, since the advanced zip does not have that conflict', () => {
    localStorage.setItem('hud', JSON.stringify({ v: 1, crosshair: 'addon' }));
    render(<Hud />);
    expect(screen.getAllByText(/addonlist\.txt/i).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /advanced mode/i }));
    expect(screen.queryByText(/addonlist\.txt/i)).toBeNull();
  });

  describe('the crosshair', () => {
    const SAVED = { shape: 'dot', dot: 4, color: '#ffffff', alpha: 100, outline: 0 };
    const radio = (name: RegExp) => screen.getByRole('radio', { name }) as HTMLInputElement;
    const PNG = 'data:image/png;base64,UE5H';

    /**
     * happy-dom has no 2D context. Every canvas gets a stand-in that records
     * its arcs and drawImages, and the texture canvas (TEX x TEX) hands back
     * PIXELS from getImageData, so the download's texture is known.
     */
    const PIXELS = new Uint8ClampedArray(TEX * TEX * 4).map((_, i) => (i * 13) & 0xff);
    const stubCanvas = () => {
      const calls: { canvas: HTMLCanvasElement; m: string; a: unknown[] }[] = [];
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
        const canvas = this;
        return new Proxy({}, {
          get: (_t, k) => (...a: unknown[]) => {
            calls.push({ canvas, m: String(k), a });
            if (k === 'getImageData') return { data: PIXELS };
            if (k === 'createImageData') return { data: new Uint8ClampedArray((a[0] as number) * (a[1] as number) * 4) };
            if (k === 'measureText') return { width: 10 };
            if (k === 'createLinearGradient' || k === 'createRadialGradient') return { addColorStop() {} };
            return undefined;
          },
          set: () => true,
        }) as never;
      } as never);
      vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(PNG);
      return calls;
    };
    /** Images that decode at once, as a data URL's would. */
    const stubImages = () => vi.stubGlobal('Image', class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      complete = false; naturalWidth = 0; naturalHeight = 0; width = 0; height = 0;
      set src(_v: string) {
        queueMicrotask(() => { this.complete = true; this.naturalWidth = this.width = TEX; this.naturalHeight = this.height = TEX; this.onload?.(); });
      }
    });
    afterEach(() => { vi.unstubAllGlobals(); });
    /** Click Download and hand back the bytes it saved. */
    const downloaded = async (): Promise<Uint8Array> => {
      const blobs: Blob[] = [];
      vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { blobs.push(b as Blob); return 'blob:hud'; });
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      fireEvent.click(screen.getByRole('button', { name: /download/i }));
      await waitFor(() => expect(blobs).toHaveLength(1));
      return new Uint8Array(await blobs[0].arrayBuffer());
    };
    const hasTexture = (bytes: Uint8Array) => crosshairFiles(TEX, TEX, PIXELS).every((f) => indexOf(bytes, f.data) > 0);
    const selectCrosshair = () => fireEvent.click(screen.getByRole('button', { name: 'Custom crosshair' }));

    it('starts a new design with the crosshair saved on the Crosshair page, and the download carries its texture', async () => {
      localStorage.setItem('xhair', JSON.stringify(SAVED));
      stubCanvas();
      render(<Hud />);
      expect(radio(/^custom/i).checked).toBe(true);
      expect(screen.getByText(/disable any separate crosshair addon/i)).toBeTruthy();
      expect(hasTexture(await downloaded())).toBe(true);
    });

    it('starts a new design on the game default when none is saved, and Custom gives it the default crosshair', async () => {
      stubCanvas();
      render(<Hud />);
      expect(radio(/game default/i).checked).toBe(true);
      expect(screen.queryByRole('radio', { name: /legacy/i })).toBeNull();
      const none = new TextDecoder('latin1').decode(await downloaded());
      expect(none).not.toContain('altcrosshair');
      expect(none).not.toContain('xHair');
      vi.mocked(URL.createObjectURL).mockRestore();
      vi.mocked(HTMLAnchorElement.prototype.click).mockRestore();
      fireEvent.click(radio(/^custom/i));
      expect(radio(/^custom/i).checked).toBe(true);
      selectCrosshair();
      expect((screen.getByRole('slider', { name: 'Length' }) as HTMLInputElement).value).toBe('7');
      expect(hasTexture(await downloaded())).toBe(true);
    });

    it('keeps a design saved with a separate crosshair addon, offering that choice only to it', () => {
      localStorage.setItem('xhair', JSON.stringify(SAVED));
      localStorage.setItem('hud', JSON.stringify({ v: 1, xhair: true }));
      render(<Hud />);
      expect(radio(/separate crosshair addon \(legacy\)/i).checked).toBe(true);
      expect(screen.getByText(/magenta/i)).toBeTruthy();
      expect(screen.getAllByText(/Add-ons menu cannot/i).length).toBeGreaterThan(0);
    });

    it('says so on the status line when a stored bundle loses its crosshair to empty storage, on load', () => {
      localStorage.setItem('hud', JSON.stringify({ v: 1, crosshair: 'bundle' }));
      render(<Hud />);
      expect(radio(/game default/i).checked).toBe(true);
      expect(screen.getByText(/no longer saved/i)).toBeTruthy();
    });

    it('says nothing on the status line when the design never asked for a bundle', () => {
      render(<Hud />);
      expect(radio(/game default/i).checked).toBe(true);
      expect(screen.queryByText(/no longer saved/i)).toBeNull();
    });

    it("adopts the saved crosshair into a stored bundle that has none of its own, once", () => {
      localStorage.setItem('xhair', JSON.stringify(SAVED));
      localStorage.setItem('hud', JSON.stringify({ v: 1, crosshair: 'bundle' }));
      render(<Hud />);
      expect(radio(/^custom/i).checked).toBe(true);
      selectCrosshair();
      expect((screen.getByRole('combobox', { name: 'Shape' }) as HTMLSelectElement).value).toBe('dot');
    });

    it('turns an imported bundle with no crosshair into the game default when none is saved', async () => {
      render(<Hud />);
      const file = new File([JSON.stringify({ v: 1, name: 'theirs', crosshair: 'bundle' })], 'theirs.hud.json', { type: 'application/json' });
      fireEvent.change(screen.getByLabelText('Import a HUD design file'), { target: { files: [file] } });
      await screen.findByText('Imported theirs.');
      expect(radio(/game default/i).checked).toBe(true);
    });

    it('warns when there will be no crosshair at all', () => {
      render(<Hud />);
      expect(screen.queryByText(/no crosshair at all/i)).toBeNull();
      fireEvent.click(screen.getByRole('checkbox', { name: /hide the game's crosshair/i }));
      expect(screen.getByText(/no crosshair at all/i)).toBeTruthy();
    });

    it('shows the builder for the selected crosshair; a slider redraws the canvas and is one undo step', () => {
      localStorage.setItem('xhair', JSON.stringify(SAVED));
      const calls = stubCanvas();
      const { container } = render(<Hud />);
      const main = container.querySelector('canvas.hud__canvas') as HTMLCanvasElement;
      selectCrosshair();
      const dot = () => screen.getByRole('slider', { name: 'Dot size' }) as HTMLInputElement;
      expect(dot().value).toBe('4');
      // The xHair's 26 units are 26 * height / 480 canvas pixels (happy-dom
      // lays nothing out, so the height is the page's minimum), and a dot of
      // size n is radius n / 2 of their PX_AT_1080.
      const radius = (n: number) => (n / 2) * (26 * main.height / 480) / PX_AT_1080;
      const drewDot = (n: number) => calls.some((c) => c.canvas === main && c.m === 'arc' && Math.abs((c.a[2] as number) - radius(n)) < 1e-9);
      expect(drewDot(4)).toBe(true);
      fireEvent.input(dot(), { target: { value: '6' } });
      fireEvent.input(dot(), { target: { value: '8' } });
      fireEvent.change(dot());
      expect(drewDot(8)).toBe(true);
      fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
      expect(dot().value).toBe('4');
      fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true, shiftKey: true });
      expect(dot().value).toBe('8');
    });

    it('takes an uploaded crosshair .vpk as the crosshair, and the download carries it', async () => {
      stubCanvas();
      stubImages();
      render(<Hud />);
      selectCrosshair();
      const vpk = new File([encodeVPK([{ path: 'materials/vgui/hud/altcrosshair.vtf', data: encodeVTF(2, 2, new Uint8ClampedArray(16).fill(255)) }])], 'theirs.vpk');
      fireEvent.change(screen.getByLabelText('Upload a crosshair'), { target: { files: [vpk] } });
      await screen.findByText(/your uploaded crosshair/i);
      expect(radio(/^custom/i).checked).toBe(true);
      expect(hasTexture(await downloaded())).toBe(true);
      // And back to building one, as one more step.
      fireEvent.click(screen.getByRole('button', { name: /build one instead/i }));
      expect(screen.getByRole('slider', { name: 'Length' })).toBeTruthy();
    });

    it('says so when an uploaded .vpk has no crosshair, and keeps the crosshair it had', async () => {
      localStorage.setItem('xhair', JSON.stringify(SAVED));
      stubCanvas();
      render(<Hud />);
      selectCrosshair();
      const vpk = new File([encodeVPK([{ path: 'scripts/hudlayout.res', data: new Uint8Array(1) }])], 'hud.vpk');
      fireEvent.change(screen.getByLabelText('Upload a crosshair'), { target: { files: [vpk] } });
      await screen.findByText('No crosshair found in this file.');
      expect((screen.getByRole('slider', { name: 'Dot size' }) as HTMLInputElement).value).toBe('4');
    });
  });

  describe('from the Crosshair page', () => {
    const SAVED = { shape: 'circle', radius: 9, color: '#ffe14d' };
    afterEach(() => { history.replaceState(null, '', '/'); });

    it("brings the page's crosshair into a design that already exists, selected, as one undo step", () => {
      localStorage.setItem('hud', JSON.stringify({ v: 1, name: 'mine', crosshair: 'none', elements: { chat: { x: 5 } } }));
      localStorage.setItem('xhair', JSON.stringify(SAVED));
      history.replaceState(null, '', '/hud?from=crosshair');
      render(<Hud />);
      expect(screen.getByText('Custom crosshair', { selector: 'legend' })).toBeTruthy();
      expect((screen.getByRole('radio', { name: /^custom/i }) as HTMLInputElement).checked).toBe(true);
      expect((screen.getByRole('slider', { name: 'Radius' }) as HTMLInputElement).value).toBe('9');
      expect(location.search).toBe('');
      fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
      expect((screen.getByRole('radio', { name: /game default/i }) as HTMLInputElement).checked).toBe(true);
    });

    it("brings the page's imported image too", () => {
      localStorage.setItem('xhair', JSON.stringify({ shape: 'image' }));
      localStorage.setItem('xhairImage', JSON.stringify({ png: 'data:image/png;base64,UE5H', w: TEX, h: TEX }));
      history.replaceState(null, '', '/hud?from=crosshair');
      render(<Hud />);
      expect(screen.getByText(/your uploaded crosshair/i)).toBeTruthy();
    });
  });

  it('names the font file in the status line when the font fetch fails, rather than shipping a corrupt file silently', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 404 } as Response);
    render(<Hud />);

    fireEvent.change(screen.getByRole('combobox', { name: /preset/i }), { target: { value: 'modern' } });
    await waitFor(() => {
      expect((screen.getByRole('combobox', { name: /preset/i }) as HTMLSelectElement).value).toBe('modern');
    });

    fireEvent.click(screen.getByRole('button', { name: /download/i }));
    expect(await screen.findByText(/RobotoCondensed-Regular\.ttf/)).toBeTruthy();
  });

  // parseFloat('') is NaN, and a NaN x would reach the generator and land in
  // a shipped .res file as the literal token "rNaN". Clearing the box must
  // leave the design alone, not patch it with a number the file cannot hold.
  it('ignores an emptied number box rather than patching the design with NaN', () => {
    render(<Hud />);
    fireEvent.click(screen.getByText('Your health'));
    const x = screen.getByLabelText('X') as HTMLInputElement;
    const before = x.value;
    expect(before).not.toBe('');

    fireEvent.input(x, { target: { value: '' } });
    // Reselecting rebuilds the controls from the design, so this reads back
    // what the design actually holds: the untouched base position, not the
    // Math.round(NaN) a patched design would render as "NaN".
    fireEvent.click(screen.getByText('Chat'));
    fireEvent.click(screen.getByText('Your health'));
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe(before);

    fireEvent.input(screen.getByLabelText('X'), { target: { value: '42' } });
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('42');
  });

  // design.ts's RANGES caps the infected row spacing at 400. Typing past the
  // cap must snap the design to it immediately, not just at download time:
  // otherwise the canvas would draw a value the packed file could never
  // carry.
  it('snaps an out-of-range number box to the clamp used at download time', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('tab', { name: 'Infected' }));
    fireEvent.click(screen.getByRole('button', { name: 'Infected teammates' }));
    const spacing = screen.getByLabelText('Spacing') as HTMLInputElement;
    fireEvent.input(spacing, { target: { value: '500' } });
    expect(spacing.value).toBe('400');
  });

  it('offers a Gap slider for the teammates, starting at the gap the fitted stock row already has', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    expect(screen.queryByLabelText('Spacing')).toBeNull();
    const gap = screen.getByRole('slider', { name: /^Gap/ }) as HTMLInputElement;
    expect(gap.value).toBe('19');
    fireEvent.input(gap, { target: { value: '30' } });
    expect((screen.getByRole('slider', { name: /^Gap/ }) as HTMLInputElement).value).toBe('30');
  });

  it('offers Row, Column and Free for the teammates, and Free lists the four cards where they sit', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    expect(screen.getByLabelText('X')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: /^Layout/ }), { target: { value: 'free' } });
    expect(screen.getByText(/Drag each card/)).toBeTruthy();
    expect((screen.getByLabelText('Card 1 X') as HTMLInputElement).value).toBe('13');
    expect((screen.getByLabelText('Card 1 Y') as HTMLInputElement).value).toBe('441');
    expect((screen.getByLabelText('Card 4 X') as HTMLInputElement).value).toBe('433');
    // The element's own X and Y give way to the cards'.
    expect(screen.queryByLabelText('X')).toBeNull();
    expect(screen.queryByRole('slider', { name: /^Gap/ })).toBeNull();
  });

  it('keeps the card positions when switching out of Free and back', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    const layout = () => screen.getByRole('combobox', { name: /^Layout/ });
    fireEvent.change(layout(), { target: { value: 'free' } });
    fireEvent.input(screen.getByLabelText('Card 1 X'), { target: { value: '50' } });
    fireEvent.change(layout(), { target: { value: 'column' } });
    expect(screen.queryByLabelText('Card 1 X')).toBeNull();
    fireEvent.change(layout(), { target: { value: 'free' } });
    expect((screen.getByLabelText('Card 1 X') as HTMLInputElement).value).toBe('50');
  });

  it('starts a new design fitted and lets the player untick it', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    const fit = () => screen.getByLabelText('Fit the card to its contents') as HTMLInputElement;
    expect(fit().checked).toBe(true);
    fireEvent.click(fit());
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    expect(fit().checked).toBe(false);
  });

  it('says on the status line when fit finds nothing to fit', () => {
    const hidden = Object.fromEntries(['Head', 'Health', 'Name', 'Items', 'Status'].map((n) => [n, { visible: false }]));
    localStorage.setItem('hud', JSON.stringify({ v: 1, elements: { teamColumn: { fit: true } }, children: { teamColumn: hidden } }));
    render(<Hud />);
    expect(screen.getByText(/keeps its full size/)).toBeTruthy();
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

  it('registers the preview font once on mount and survives a browser without FontFace', async () => {
    // happy-dom has no FontFace; the page must not throw and must still render the canvas.
    const { container } = render(<Hud />);
    expect(container.querySelector('canvas')).not.toBeNull();
  });

  it('registers both Roboto Condensed faces once on mount', async () => {
    // Stand in for a browser that does have FontFace, so the mount effect's
    // happy path (the try branch, not the catch) gets covered too.
    class FakeFontFace {
      descriptors?: { weight?: string };
      constructor(public family: string, public source: string, descriptors?: { weight?: string }) {
        this.descriptors = descriptors;
      }
      load() { return Promise.resolve(this); }
    }
    const add = vi.fn();
    vi.stubGlobal('FontFace', FakeFontFace);
    const hadFonts = 'fonts' in document;
    const originalFonts = (document as unknown as { fonts?: unknown }).fonts;
    (document as unknown as { fonts: { add: typeof add } }).fonts = { add };

    try {
      render(<Hud />);
      await waitFor(() => expect(add).toHaveBeenCalledTimes(2));
      // Regular first, bold at weight 700 second, matching the two ttf imports.
      expect(add.mock.calls[0][0].descriptors?.weight).toBeUndefined();
      expect(add.mock.calls[1][0].descriptors?.weight).toBe('700');
    } finally {
      vi.unstubAllGlobals();
      if (hadFonts) (document as unknown as { fonts: unknown }).fonts = originalFonts;
      else delete (document as unknown as { fonts?: unknown }).fonts;
    }
  });

  // The stock fitted row: card 1 at (13, 441), its portrait (13, 443) to (36, 466).
  it('picks a piece in one click, shows its path, and climbs back up with Escape', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    clickAt(canvas, 24, 454);
    expect(screen.getByText('Portrait', { selector: 'legend' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Up to Teammates' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Up to Card 1' })).toBeTruthy();
    fireEvent.keyDown(canvas, { key: 'Escape' });
    expect(screen.getByText('Teammate card 1', { selector: 'legend' })).toBeTruthy();
    fireEvent.keyDown(canvas, { key: 'Escape' });
    expect(screen.getByText('Teammates', { selector: 'legend' })).toBeTruthy();
    fireEvent.keyDown(canvas, { key: 'Escape' });
    expect(screen.getByText(/select an element/i)).toBeTruthy();
  });

  it('picks one level up with Ctrl+click, and from the breadcrumb', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    clickAt(canvas, 24, 454, { ctrlKey: true });
    expect(screen.getByText('Teammate card 1', { selector: 'legend' })).toBeTruthy();
    clickAt(canvas, 24, 454, { ctrlKey: true });
    expect(screen.getByText('Teammates', { selector: 'legend' })).toBeTruthy();
    clickAt(canvas, 24, 454);
    expect(screen.getByText('Portrait', { selector: 'legend' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Up to Teammates' }));
    expect(screen.getByText('Teammates', { selector: 'legend' })).toBeTruthy();
  });

  // Card 3 of the stock row is drawn at (293, 441); (304, 454) is its portrait.
  it('moves only the card a drag starts on in the default Row, going Free, and one Ctrl+Z puts the Row back', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    dragFrom(canvas, [304, 454], [354, 354]);
    expect(screen.getByText('Teammate card 3', { selector: 'legend' })).toBeTruthy();
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('343');
    expect((screen.getByLabelText('Y') as HTMLInputElement).value).toBe('341');
    expect(screen.getByText('Teammates switched to Free layout')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    expect((screen.getByRole('combobox', { name: /^Layout/ }) as HTMLSelectElement).value).toBe('free');
    const at = (n: number) => ['X', 'Y'].map((k) => (screen.getByLabelText(`Card ${n} ${k}`) as HTMLInputElement).value);
    expect(at(1)).toEqual(['13', '441']);
    expect(at(2)).toEqual(['153', '441']);
    expect(at(3)).toEqual(['343', '341']);
    undoKey();
    expect((screen.getByRole('combobox', { name: /^Layout/ }) as HTMLSelectElement).value).toBe('row');
    expect(screen.queryByLabelText('Card 1 X')).toBeNull();
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('0');
    expect((screen.getByLabelText('Y') as HTMLInputElement).value).toBe('405');
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('moves two cards picked with Ctrl+click and Shift+click together', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    const crumbs = () => container.querySelector('.hud__crumbs')!.textContent;
    // Ctrl+Shift+click on a portrait adds its card too, and takes it away again.
    clickAt(canvas, 304, 454, { ctrlKey: true });
    expect(crumbs()).toBe('Teammates›Card 3');
    clickAt(canvas, 164, 454, { ctrlKey: true, shiftKey: true });
    expect(crumbs()).toBe('Teammates›2 cards');
    clickAt(canvas, 164, 454, { ctrlKey: true, shiftKey: true });
    expect(crumbs()).toBe('Teammates›Card 3');
    // A plain Shift+click on a portrait, with a card picked, adds that portrait's card.
    clickAt(canvas, 24, 454, { ctrlKey: true });
    clickAt(canvas, 164, 454, { shiftKey: true });
    expect(crumbs()).toBe('Teammates›2 cards');
    expect(screen.getByText('2 cards', { selector: 'legend' })).toBeTruthy();
    expect(screen.getByText('2 cards', { selector: '.hud__crumbs span' })).toBeTruthy();
    dragFrom(canvas, [164, 454], [174, 434]);
    expect(screen.getByText('2 cards', { selector: 'legend' })).toBeTruthy();
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('23');
    expect((screen.getByLabelText('Y') as HTMLInputElement).value).toBe('421');
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    expect((screen.getByLabelText('Card 1 X') as HTMLInputElement).value).toBe('23');
    expect((screen.getByLabelText('Card 2 X') as HTMLInputElement).value).toBe('163');
    expect((screen.getByLabelText('Card 2 Y') as HTMLInputElement).value).toBe('421');
    expect((screen.getByLabelText('Card 3 X') as HTMLInputElement).value).toBe('293');
    expect((screen.getByLabelText('Card 3 Y') as HTMLInputElement).value).toBe('441');
  });

  it('moves the whole Row team when the Teammates are picked from Layers', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    dragFrom(canvas, [304, 454], [304, 404]);
    expect(screen.getByText('Teammates', { selector: 'legend' })).toBeTruthy();
    expect((screen.getByRole('combobox', { name: /^Layout/ }) as HTMLSelectElement).value).toBe('row');
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('0');
    expect((screen.getByLabelText('Y') as HTMLInputElement).value).toBe('355');
    expect(screen.queryByText('Teammates switched to Free layout')).toBeNull();
  });

  it('moves just the picked piece when the drag starts on it', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    clickAt(canvas, 24, 454);
    dragFrom(canvas, [24, 454], [34, 454]);
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('23');
    expect((screen.getByLabelText('Y') as HTMLInputElement).value).toBe('38');
  });

  it('snaps a moving piece to the others unless Alt is held', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    clickAt(canvas, 24, 454);
    // Moved 10 right the portrait's centre is 2.5 short of the health bar's left edge (37), so it snaps there.
    dragFrom(canvas, [24, 454], [34, 454], {});
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('26');
  });

  it('cancels a drag with Escape, putting everything back and recording nothing', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    clickAt(canvas, 24, 454);
    fireEvent.pointerDown(canvas, { clientX: 24, clientY: 454, pointerId: 1, altKey: true });
    fireEvent.pointerMove(canvas, { clientX: 44, clientY: 454, pointerId: 1, altKey: true });
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('33');
    fireEvent.keyDown(canvas, { key: 'Escape' });
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('13');
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('resizes the chat box from its right handle and from its left, which moves it', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    // Chat is (10, 275) to (290, 395), basechat.res's 280 x 120 window: its right handle is at (290, 335).
    dragFrom(canvas, [290, 335], [320, 335]);
    expect((screen.getByLabelText('W') as HTMLInputElement).value).toBe('310');
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('10');
    dragFrom(canvas, [10, 335], [0, 335]);
    expect((screen.getByLabelText('W') as HTMLInputElement).value).toBe('320');
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('0');
  });

  it('scales an element from a corner handle, the opposite corner staying put', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    fireEvent.click(screen.getByRole('button', { name: 'Your health' }));
    // Your health is (728, 389) to (853, 480); its top-left corner out by half.
    dragFrom(canvas, [728, 389], [665.5, 343.5]);
    expect((screen.getByRole('slider', { name: /^Scale/ }) as HTMLInputElement).value).toBe('1.5');
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('666');
    expect((screen.getByLabelText('Y') as HTMLInputElement).value).toBe('344');
  });

  it('resizes a piece by its side handle, and a portrait by its corner keeping it square', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    // Card 1's health bar runs (37, 457) to (133, 464): its right handle sits between two corners 3.5 away.
    clickAt(canvas, 60, 460);
    expect(screen.getByText('Health bar', { selector: 'legend' })).toBeTruthy();
    dragFrom(canvas, [133, 460.5], [143, 460.5]);
    expect((screen.getByLabelText('W') as HTMLInputElement).value).toBe('106');
    clickAt(canvas, 24, 454);
    dragFrom(canvas, [36, 466], [41, 471]);
    expect((screen.getByLabelText('Size') as HTMLInputElement).value).toBe('28');
  });

  it('selects the splatter from Layers, resizes it by a handle, undoes the resize, then sets Opacity', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    // Layers still works too: every teammate-card row is listed there, splatter included.
    fireEvent.click(screen.getByRole('button', { name: 'Damage splatter' }));
    expect(screen.getByText('Damage splatter', { selector: 'legend' })).toBeTruthy();
    // Card 1's fitted splatter runs (13, 441) to (134, 502): its east handle sits at (134, 471.5).
    dragFrom(canvas, [134, 471.5], [144, 471.5]);
    expect((screen.getByLabelText('W') as HTMLInputElement).value).toBe('131');
    undoKey();
    expect((screen.getByLabelText('W') as HTMLInputElement).value).toBe('121');
    fireEvent.input(screen.getByLabelText('Damage splatter opacity'), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText('Damage splatter opacity'));
    expect((screen.getByLabelText('Damage splatter opacity') as HTMLInputElement).value).toBe('50');
  });

  it('picks the splatter on the canvas where no other piece is, drags it, and undoes with Ctrl+Z', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    // Card 3 (Zoey) is drawn at (293, 441), 121 x 36: (323, 456) is inside it, in the splatter, but
    // on none of Head, Health, Name, Status or Items, so a plain click there now picks the splatter,
    // the lowest-priority piece.
    clickAt(canvas, 323, 456);
    expect(screen.getByText('Damage splatter', { selector: 'legend' })).toBeTruthy();
    const crumbs = () => container.querySelector('.hud__crumbs')!.textContent;
    expect(crumbs()).toBe('Teammates›Card 3›Damage splatter');
    // A real piece on the same card still wins: (304, 454) is Zoey's portrait.
    clickAt(canvas, 304, 454);
    expect(screen.getByText('Portrait', { selector: 'legend' })).toBeTruthy();
    // Re-pick the splatter and drag it: it moves, not the card.
    clickAt(canvas, 323, 456);
    dragFrom(canvas, [323, 456], [333, 466]);
    expect(screen.getByText('Damage splatter', { selector: 'legend' })).toBeTruthy();
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('23');
    expect((screen.getByLabelText('Y') as HTMLInputElement).value).toBe('46');
    undoKey();
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('13');
    expect((screen.getByLabelText('Y') as HTMLInputElement).value).toBe('36');
  });

  it('picks the splatter under a blank label, not the label, at the top right of a card', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    // Card 3 (Zoey) is at (293, 441): (398, 447) is card-relative (105, 6), Status text's own box,
    // but Status draws no text in the preview, so the click falls through to the splatter under it.
    clickAt(canvas, 398, 447);
    expect(screen.getByText('Damage splatter', { selector: 'legend' })).toBeTruthy();
  });

  it('scales several pieces together by a corner of their box', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    clickAt(canvas, 24, 454);
    clickAt(canvas, 60, 460, { shiftKey: true });
    // Portrait and bar together span (13, 443) to (133, 466): drag the bottom-right corner to half size.
    dragFrom(canvas, [133, 466], [73, 454.5]);
    fireEvent.click(screen.getByRole('button', { name: 'Portrait' }));
    expect((screen.getByLabelText('Size') as HTMLInputElement).value).toBe('12');
  });

  it('in Free, picks a piece of any card in one click, and a drag on another card moves that card', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    fireEvent.change(screen.getByRole('combobox', { name: /^Layout/ }), { target: { value: 'free' } });
    // Card 2 sits at (153, 441); (160, 450) is its portrait.
    clickAt(canvas, 160, 450);
    expect(screen.getByText('Portrait', { selector: 'legend' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Up to Card 2' })).toBeTruthy();
    // (133, 442) is on card 1, on the splatter but no other piece; a drag there is not a click first,
    // so nothing on card 1 is picked yet and the drag still moves the card, not the splatter.
    dragFrom(canvas, [133, 442], [233, 242]);
    expect(screen.getByText('Teammate card 1', { selector: 'legend' })).toBeTruthy();
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('113');
    expect((screen.getByLabelText('Y') as HTMLInputElement).value).toBe('241');
  });

  it('clears the selection with a click on empty screen', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    clickAt(canvas, 24, 454);
    clickAt(canvas, 426, 100);
    expect(screen.getByText(/select an element/i)).toBeTruthy();
  });

  it('cancels a drag the browser takes away, recording nothing', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    clickAt(canvas, 24, 454);
    fireEvent.pointerDown(canvas, { clientX: 24, clientY: 454, pointerId: 1, altKey: true });
    fireEvent.pointerMove(canvas, { clientX: 44, clientY: 454, pointerId: 1, altKey: true });
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('33');
    fireEvent.pointerCancel(canvas, { pointerId: 1 });
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('13');
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('undoes a drag still under way with Ctrl+Z, and the pointer moves nothing after it', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    clickAt(canvas, 24, 454);
    fireEvent.pointerDown(canvas, { clientX: 24, clientY: 454, pointerId: 1, altKey: true });
    fireEvent.pointerMove(canvas, { clientX: 44, clientY: 454, pointerId: 1, altKey: true });
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('13');
    fireEvent.pointerMove(canvas, { clientX: 54, clientY: 454, pointerId: 1, altKey: true });
    fireEvent.pointerUp(canvas, { clientX: 54, clientY: 454, pointerId: 1, altKey: true });
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('13');
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('33');
  });

  it('offers the Healthy, Down and Dead preview on the survivor side only', () => {
    render(<Hud />);
    expect(screen.getByRole('tab', { name: 'Healthy' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Down' }));
    expect(screen.getByRole('tab', { name: 'Down' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Infected' }));
    expect(screen.queryByRole('tab', { name: 'Down' })).toBeNull();
  });

  it("hides the game's crosshair from the Custom crosshair panel", () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Custom crosshair' }));
    const box = () => screen.getByLabelText("Hide the game's crosshair") as HTMLInputElement;
    expect(box().checked).toBe(false);
    expect(screen.getByText(/so an image crosshair can replace it/)).toBeTruthy();
    fireEvent.click(box());
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Custom crosshair' }));
    expect(box().checked).toBe(true);
  });

  const undoKey = (extra: Partial<KeyboardEventInit> = {}) =>
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true, ...extra });

  it('undoes and redoes with Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    const x = () => screen.getByLabelText('X') as HTMLInputElement;
    fireEvent.input(x(), { target: { value: '42' } });
    fireEvent.blur(x());
    undoKey();
    expect(x().value).toBe('10');
    undoKey({ shiftKey: true });
    expect(x().value).toBe('42');
    undoKey();
    fireEvent.keyDown(document.body, { key: 'y', ctrlKey: true });
    expect(x().value).toBe('42');
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    expect(x().value).toBe('10');
  });

  it('undoes and redoes with the toolbar buttons, which are off when there is nothing to do', () => {
    render(<Hud />);
    const undoBtn = () => screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement;
    const redoBtn = () => screen.getByRole('button', { name: 'Redo' }) as HTMLButtonElement;
    expect(undoBtn().disabled).toBe(true);
    expect(redoBtn().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    fireEvent.click(screen.getByLabelText('Visible'));
    expect(undoBtn().disabled).toBe(false);
    fireEvent.click(undoBtn());
    expect((screen.getByLabelText('Visible') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(redoBtn());
    expect((screen.getByLabelText('Visible') as HTMLInputElement).checked).toBe(false);
  });

  it('leaves Ctrl+Z to the browser while typing in a number box', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    const x = () => screen.getByLabelText('X') as HTMLInputElement;
    fireEvent.input(x(), { target: { value: '42' } });
    fireEvent.keyDown(x(), { key: 'z', ctrlKey: true });
    expect(x().value).toBe('42');
    fireEvent.blur(x());
    undoKey();
    expect(x().value).toBe('10');
  });

  it('makes typing into a number box one step, however many edits it takes', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    const x = () => screen.getByLabelText('X') as HTMLInputElement;
    for (const v of ['4', '42', '420']) fireEvent.input(x(), { target: { value: v } });
    fireEvent.keyDown(x(), { key: 'Enter' });
    undoKey();
    expect(x().value).toBe('10');
  });

  it('makes a slider drag one step', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    const gap = () => screen.getByRole('slider', { name: /^Gap/ }) as HTMLInputElement;
    for (const v of ['20', '25', '30']) fireEvent.input(gap(), { target: { value: v } });
    fireEvent.change(gap());
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(gap().value).toBe('19');
  });

  it('makes one canvas drag one step', () => {
    const { container } = render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    fireEvent.change(screen.getByRole('combobox', { name: /^Layout/ }), { target: { value: 'free' } });
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 853, height: 480, right: 853, bottom: 480, x: 0, y: 0, toJSON() {} }) as DOMRect;
    // Alt keeps snapping out of it, so the numbers are the pointer's.
    fireEvent.pointerDown(canvas, { clientX: 133, clientY: 442, pointerId: 1, altKey: true });
    fireEvent.pointerMove(canvas, { clientX: 183, clientY: 342, pointerId: 1, altKey: true });
    fireEvent.pointerMove(canvas, { clientX: 233, clientY: 242, pointerId: 1, altKey: true });
    fireEvent.pointerUp(canvas, { clientX: 233, clientY: 242, pointerId: 1, altKey: true });
    expect(screen.getByText('Teammate card 1', { selector: 'legend' })).toBeTruthy();
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('113');
    undoKey();
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('13');
    // The Layout change before it is its own step; card 1 stays picked, as cards are a level in Row too.
    undoKey();
    expect(screen.getByText('Teammate card 1', { selector: 'legend' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    expect((screen.getByRole('combobox', { name: /^Layout/ }) as HTMLSelectElement).value).toBe('row');
  });

  it('coalesces a run of arrow-key nudges into one step', () => {
    const { container } = render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    for (let i = 0; i < 3; i++) fireEvent.keyDown(canvas, { key: 'ArrowRight' });
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('13');
    undoKey();
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('10');
  });

  it('picks several pieces with Shift+click and moves them together', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    clickAt(canvas, 24, 454);
    clickAt(canvas, 60, 460, { shiftKey: true });
    expect(screen.getByText('2 pieces in the teammate card', { selector: 'legend' })).toBeTruthy();
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('13');
    dragFrom(canvas, [24, 454], [29, 454]);
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('18');
    // The health bar moved too: it now starts at 42.
    clickAt(canvas, 65, 460);
    expect(screen.getByText('Health bar', { selector: 'legend' })).toBeTruthy();
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('42');
  });

  it('picks the pieces a Shift+drag box touches', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    dragFrom(canvas, [60, 456], [100, 470], { shiftKey: true });
    expect(screen.getByText('2 pieces in the teammate card', { selector: 'legend' })).toBeTruthy();
  });

  // Task 11's review found no page-level test wired a Shift+drag box across
  // plain elements (only across teammate-card pieces): ownHealth (728, 389)
  // to (853, 480) and Weapons (755, 165) to (855, 325) both sit inside this
  // box, and nothing else on the survivor side does.
  it('picks two elements with a Shift+drag box outside the teammate card', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    dragFrom(canvas, [700, 300], [860, 400], { shiftKey: true });
    expect(screen.getByText('2 elements', { selector: 'legend' })).toBeTruthy();
  });

  it('selects every drawn piece of the card, or every visible element, with Ctrl+A', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    clickAt(canvas, 24, 454);
    fireEvent.keyDown(canvas, { key: 'a', ctrlKey: true });
    expect(screen.getByText('5 pieces in the teammate card', { selector: 'legend' })).toBeTruthy();
    clickAt(canvas, 426, 100);
    fireEvent.keyDown(canvas, { key: 'a', ctrlKey: true });
    // Five: with no crosshair saved on the Crosshair page, a new design has crosshair 'none', and no xHair to select.
    expect(screen.getByText('5 elements', { selector: 'legend' })).toBeTruthy();
  });

  it('aligns several pieces, and hides them all', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    clickAt(canvas, 24, 454);
    clickAt(canvas, 60, 460, { shiftKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Align right' }));
    // Their box ends at 133 (the bar's right edge): the portrait moves to 110.
    fireEvent.click(screen.getByLabelText('Visible'));
    fireEvent.click(screen.getByRole('button', { name: 'Portrait' }));
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('110');
    expect((screen.getByLabelText('Visible') as HTMLInputElement).checked).toBe(false);
  });

  it('aligns several elements picked with Shift+click in the list', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Your health' }), { shiftKey: true });
    expect(screen.getByText('2 elements', { selector: 'legend' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Align left' }));
    fireEvent.click(screen.getByRole('button', { name: 'Your health' }));
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('10');
  });

  it('puts every page control in one toolbar, Download on it', () => {
    const { container } = render(<Hud />);
    const bar = within(container.querySelector('.hud__toolbar') as HTMLElement);
    for (const name of ['Undo', 'Redo']) expect(bar.getByRole('button', { name }), name).toBeTruthy();
    for (const name of ['Survivor', 'Infected', 'Healthy', 'Down', 'Dead']) expect(bar.getByRole('tab', { name }), name).toBeTruthy();
    for (const name of [/preset/i, /aspect/i, /backdrop/i, /font/i]) expect(bar.getByRole('combobox', { name }), String(name)).toBeTruthy();
    const download = bar.getByRole('button', { name: /download/i });
    expect(download.classList.contains('hud__download')).toBe(true);
    expect(download.textContent).toBe('Download .vpk');
    expect(screen.getAllByRole('button', { name: /download/i })).toHaveLength(1);
  });

  it('shows a Free card its own X and Y, placing the card where it is drawn', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    fireEvent.change(screen.getByRole('combobox', { name: /^Layout/ }), { target: { value: 'free' } });
    fireEvent.click(screen.getByRole('button', { name: 'Card 3' }));
    expect(screen.getByText('Teammate card 3', { selector: 'legend' })).toBeTruthy();
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('293');
    fireEvent.input(screen.getByLabelText('X'), { target: { value: '500' } });
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('500');
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    expect((screen.getByLabelText('Card 3 X') as HTMLInputElement).value).toBe('500');
  });

  it('shows a hint, then Styles and Save, with nothing selected', () => {
    render(<Hud />);
    expect(screen.getByText(/a drag moves the card or element under it/)).toBeTruthy();
    expect(screen.getByText('Styles')).toBeTruthy();
    expect(screen.getByText('Save your HUD')).toBeTruthy();
  });

  const hiddenRow = (label: string) => screen.getByRole('button', { name: label }).closest('.hud__layer')!.classList.contains('hud__layer--hidden');

  it('opens a menu on right-click for the piece under the pointer, and Hide hides it', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    fireEvent.contextMenu(canvas, { clientX: 24, clientY: 454 });
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Hide', 'Reset', 'Select whole card', 'Select Teammates']);
    expect(screen.getByText('Portrait', { selector: 'legend' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(hiddenRow('Portrait')).toBe(true);
    expect((screen.getByLabelText('Visible') as HTMLInputElement).checked).toBe(false);
  });

  it('acts on the whole selection when the right-click is on part of it', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    clickAt(canvas, 24, 454);
    clickAt(canvas, 60, 460, { shiftKey: true });
    fireEvent.contextMenu(canvas, { clientX: 60, clientY: 460 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }));
    expect(hiddenRow('Portrait')).toBe(true);
    expect(hiddenRow('Health bar')).toBe(true);
  });

  it('offers Select whole card for a piece, and only Select Teammates for a card, in any layout', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    fireEvent.contextMenu(canvas, { clientX: 24, clientY: 454 });
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Hide', 'Reset', 'Select whole card', 'Select Teammates']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Select whole card' }));
    expect(screen.getByText('Teammate card 1', { selector: 'legend' })).toBeTruthy();
    // (133, 442) is on card 1, on the splatter but no other piece: with the card already the
    // selection, isPicked only checks which card was hit, so the menu still acts on the whole card.
    fireEvent.contextMenu(canvas, { clientX: 133, clientY: 442 });
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Select Teammates']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Select Teammates' }));
    expect(screen.getByText('Teammates', { selector: 'legend' })).toBeTruthy();
    // A card cannot be hidden alone: Delete on one does nothing. Picked from Layers, since a plain
    // click at (133, 442) now picks the splatter there instead (its own test covers that).
    fireEvent.click(screen.getByRole('button', { name: 'Card 1' }));
    expect(screen.getByText('Teammate card 1', { selector: 'legend' })).toBeTruthy();
    fireEvent.keyDown(canvas, { key: 'Delete' });
    expect(hiddenRow('Teammates')).toBe(false);
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    fireEvent.change(screen.getByRole('combobox', { name: /^Layout/ }), { target: { value: 'free' } });
    fireEvent.contextMenu(canvas, { clientX: 24, clientY: 454 });
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Hide', 'Reset', 'Select whole card', 'Select Teammates']);
  });

  it('closes the menu with Escape or a press elsewhere, and opens none over empty screen', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    fireEvent.contextMenu(canvas, { clientX: 24, clientY: 454 });
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Hide' }), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.contextMenu(canvas, { clientX: 24, clientY: 454 });
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.contextMenu(canvas, { clientX: 426, clientY: 100 });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('hides the selection with Delete or Backspace, one undo step each', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    fireEvent.keyDown(canvas, { key: 'Delete' });
    expect(hiddenRow('Chat')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Your health' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Your health' }), { key: 'Backspace' });
    expect(hiddenRow('Your health')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(hiddenRow('Your health')).toBe(false);
    expect(hiddenRow('Chat')).toBe(true);
  });

  // The on-screen team clamp can draw (and write) the team away from its
  // stored X and Y, so the Teammates' boxes read where the team is drawn.
  it('shows the Teammates where the clamp draws them, and places a typed value there', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    const x = () => screen.getByLabelText('X') as HTMLInputElement;
    const y = () => screen.getByLabelText('Y') as HTMLInputElement;
    fireEvent.input(x(), { target: { value: '600' } });
    fireEvent.blur(x());
    fireEvent.input(y(), { target: { value: '300' } });
    fireEvent.blur(y());
    expect(x().value).toBe('299');
    expect(y().value).toBe('300');
    // Scaled up, the wider team is drawn further left still.
    fireEvent.input(screen.getByRole('slider', { name: /^Scale/ }), { target: { value: '1.5' } });
    expect(x().value).toBe('22');
    // A typed value inside the reach lands where it is typed.
    fireEvent.input(x(), { target: { value: '10' } });
    expect(x().value).toBe('10');
  });

  it('shows every Layers row its name, with a state note on its own line under it', () => {
    render(<Hud />);
    for (const [label, note] of [['Down picture', 'shown when down'], ['Dead picture', 'shown when dead'], ['Voice icon', 'shown when talking']]) {
      const name = screen.getByRole('button', { name: label });
      const text = name.closest('.hud__layertext');
      expect(text, label).toBeTruthy();
      expect(within(text as HTMLElement).getByText(note)).toBeTruthy();
    }
    // The 190px column must never cut a name short.
    const css = readFileSync(join(__dirname, '../styles/app.css'), 'utf8');
    const rule = css.slice(css.indexOf('.hud__layername {'), css.indexOf('}', css.indexOf('.hud__layername {')));
    expect(rule).not.toMatch(/ellipsis|nowrap/);
  });

  it('redraws on a hover only when what the pointer is over changes', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    // happy-dom's canvas has no 2D context; the draw effect asks for one once per run.
    const draws = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
    fireEvent.pointerMove(canvas, { clientX: 24, clientY: 454, pointerId: 1 });
    const after = draws.mock.calls.length;
    expect(after).toBeGreaterThan(0);
    fireEvent.pointerMove(canvas, { clientX: 25, clientY: 455, pointerId: 1 });
    expect(draws.mock.calls.length).toBe(after);
    fireEvent.pointerMove(canvas, { clientX: 60, clientY: 460, pointerId: 1 });
    expect(draws.mock.calls.length).toBeGreaterThan(after);
  });

  it('offers Undo while the first edit is still being typed into a number box', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    const x = () => screen.getByLabelText('X') as HTMLInputElement;
    const undoBtn = () => screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement;
    expect(undoBtn().disabled).toBe(true);
    fireEvent.input(x(), { target: { value: '42' } });
    expect(undoBtn().disabled).toBe(false);
    fireEvent.click(undoBtn());
    expect(x().value).toBe('10');
  });

  it('ignores a right-click while a left drag is under way', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    clickAt(canvas, 24, 454);
    fireEvent.pointerDown(canvas, { clientX: 24, clientY: 454, pointerId: 1, altKey: true });
    fireEvent.pointerMove(canvas, { clientX: 34, clientY: 454, pointerId: 1, altKey: true });
    fireEvent.contextMenu(canvas, { clientX: 30, clientY: 300 });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.pointerUp(canvas, { clientX: 34, clientY: 454, pointerId: 1, altKey: true });
    expect(screen.getByText('Portrait', { selector: 'legend' })).toBeTruthy();
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('23');
  });

  it('gives the keys back to the canvas once a menu item runs, or Escape closes the menu', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    fireEvent.contextMenu(canvas, { clientX: 24, clientY: 454 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }));
    expect(document.activeElement).toBe(canvas);
    fireEvent.contextMenu(canvas, { clientX: 60, clientY: 460 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Select Teammates' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Delete' });
    expect(hiddenRow('Teammates')).toBe(true);
    fireEvent.contextMenu(canvas, { clientX: 30, clientY: 300 });
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Hide' }), { key: 'Escape' });
    expect(document.activeElement).toBe(canvas);
  });

  it('clears the Free note once an undo, a redo back out or a cancelled drag leaves the team in Row', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    const note = () => screen.queryByText('Teammates switched to Free layout');
    dragFrom(canvas, [304, 454], [354, 354]);
    expect(note()).toBeTruthy();
    undoKey();
    expect(note()).toBeNull();
    // Redo brings Free back; the note is not needed for it, and a second undo leaves it clear.
    undoKey({ shiftKey: true });
    undoKey();
    expect(note()).toBeNull();
    // A drag cancelled with Escape puts the Row back, and the note goes with it.
    fireEvent.pointerDown(canvas, { clientX: 304, clientY: 454, pointerId: 1, altKey: true });
    fireEvent.pointerMove(canvas, { clientX: 354, clientY: 354, pointerId: 1, altKey: true });
    expect(note()).toBeTruthy();
    fireEvent.keyDown(canvas, { key: 'Escape' });
    expect(note()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    expect((screen.getByRole('combobox', { name: /^Layout/ }) as HTMLSelectElement).value).toBe('row');
  });

  it('nudges a card picked in Row with the arrows, going Free, one undo step for the run', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    fireEvent.click(screen.getByRole('button', { name: 'Card 2' }));
    for (let i = 0; i < 3; i++) fireEvent.keyDown(canvas, { key: 'ArrowRight' });
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('156');
    expect(screen.getByText('Teammates switched to Free layout')).toBeTruthy();
    undoKey();
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    expect((screen.getByRole('combobox', { name: /^Layout/ }) as HTMLSelectElement).value).toBe('row');
  });

  it("types a Row card's X and Y, going Free with the others where they were", () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Card 2' }));
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('153');
    expect((screen.getByLabelText('Y') as HTMLInputElement).value).toBe('441');
    fireEvent.input(screen.getByLabelText('Y'), { target: { value: '300' } });
    expect((screen.getByLabelText('Y') as HTMLInputElement).value).toBe('300');
    expect(screen.getByText('Teammates switched to Free layout')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    expect((screen.getByLabelText('Card 1 Y') as HTMLInputElement).value).toBe('441');
    expect((screen.getByLabelText('Card 2 X') as HTMLInputElement).value).toBe('153');
    expect((screen.getByLabelText('Card 2 Y') as HTMLInputElement).value).toBe('300');
    undoKey();
    expect((screen.getByRole('combobox', { name: /^Layout/ }) as HTMLSelectElement).value).toBe('row');
  });

  it('places and aligns several cards from their panel', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Card 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Card 3' }), { shiftKey: true });
    expect(screen.getByText('2 cards', { selector: 'legend' })).toBeTruthy();
    expect(screen.queryByText('Visible')).toBeNull();
    fireEvent.input(screen.getByLabelText('Y'), { target: { value: '200' } });
    fireEvent.blur(screen.getByLabelText('Y'));
    fireEvent.click(screen.getByRole('button', { name: 'Card 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Card 3' }), { shiftKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Align top' }));
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    expect((screen.getByLabelText('Card 1 Y') as HTMLInputElement).value).toBe('200');
    expect((screen.getByLabelText('Card 2 Y') as HTMLInputElement).value).toBe('200');
    expect((screen.getByLabelText('Card 3 Y') as HTMLInputElement).value).toBe('200');
    expect((screen.getByLabelText('Card 3 X') as HTMLInputElement).value).toBe('293');
  });
});
