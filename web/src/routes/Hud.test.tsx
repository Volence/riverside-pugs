import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor, within, act } from '@testing-library/preact';
import { _setImageFactory, _resetAssetCache, childRects } from '../hud/render';
import { panelBoxes } from '../hud/mock';
import { _setProbe } from '../hud/probes';
import { panelChild, elementRect } from '../hud/build';
import { toUnits } from './Hud';
import Hud from './Hud';
import { _setFoldDefault } from './hud/LayersPanel';
import { readFileSync } from 'node:fs';
import { crosshairFiles } from '../crosshair/vpk';
import { TEX, PX_AT_1080 } from '../crosshair/draw';
import { encodeVPK, encodeVTF } from '../vpk';
import { join } from 'node:path';
import { readVPK } from '../vpk/read';
import { memoryStore, _setHudStore, type HudStore } from '../hud/hudStore';
import { unregisterImport, baseFile } from '../hud/base';
import { hudId } from '../hud/upload';
import { sampleHud, asList, dropBlock } from '../hud/importFixtures';
import { encodeShare, validateDesign, type HudDesign } from '../hud/design';

// A switch for the tests of the page's own safety net: with it on, the
// import checks find nothing wrong, so a broken import gets as far as the
// draw, as one the checks miss would.
const checks = vi.hoisted(() => ({ skip: false }));
vi.mock('../hud/importCheck', async (original) => {
  const m = await original<typeof import('../hud/importCheck')>();
  return { ...m, importProblem: (id: string) => (checks.skip ? null : m.importProblem(id)) };
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
  // Most tests reach a piece in Layers directly; the folding tests turn this off.
  _setFoldDefault(true);
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
/** One element's rows in Layers: your own health lists pieces named like the teammate card's. */
const layer = (label: string) => within(screen.getByRole('group', { name: `Layers: ${label}` }));
const team = () => layer('Teammates');

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
      expect(team().getByRole('button', { name: label }), label).toBeTruthy();
    }
    expect(team().getByText('shown when down')).toBeTruthy();
    expect(team().queryByRole('button', { name: 'Health number' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '＋ Health number' }));
    expect(team().getByRole('button', { name: 'Health number' })).toBeTruthy();
    expect(screen.getByText('Health number', { selector: 'legend' })).toBeTruthy();
    expect(screen.getByText("Edits inside a card apply to every teammate's card.")).toBeTruthy();
  });

  it('steps back to the teammates when the selected piece is removed', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: '＋ Health number' }));
    expect(screen.getByText('Reset health number')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove the health number' }));
    expect(screen.getByText('Reset this element')).toBeTruthy();
    expect(screen.getByRole('button', { name: '＋ Health number' })).toBeTruthy();
  });

  it('drops a picked child when the preset changes', async () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    fireEvent.click(team().getByRole('button', { name: 'Portrait' }));
    expect(screen.getByText('Reset portrait')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: /preset/i }), { target: { value: 'modern' } });
    await waitFor(() => expect(screen.getByText('Reset this element')).toBeTruthy());
  });

  it('keeps an added health number added when its child is reset', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: '＋ Health number' }));
    fireEvent.input(screen.getByLabelText('X'), { target: { value: '90' } });
    fireEvent.click(screen.getByText('Reset health number'));
    // The move is gone and the number is still there: back at the template's x 103.
    expect(team().getByRole('button', { name: 'Health number' })).toBeTruthy();
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('103');
  });

  it('shows one Size box for the portrait and writes both sides', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    fireEvent.click(team().getByRole('button', { name: 'Portrait' }));
    expect(screen.queryByLabelText('W')).toBeNull();
    fireEvent.input(screen.getByLabelText('Size'), { target: { value: '30' } });
    fireEvent.click(team().getByRole('button', { name: 'Name' }));
    fireEvent.click(team().getByRole('button', { name: 'Portrait' }));
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

  it('offers the splatter Opacity alone, no colour swatch, with a note pointing to the Splatter panel, and X, Y, W and H', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Damage splatter' }));
    // The splatter art is pure black: an RGB tint would draw no visible difference, so there is no swatch.
    expect(screen.getByLabelText('Damage splatter opacity')).toBeTruthy();
    expect(screen.queryByLabelText('Damage splatter tint')).toBeNull();
    expect(screen.queryByLabelText('Damage splatter colour')).toBeNull();
    expect(screen.getByText(/Opacity fades whatever art the splatter shows/)).toBeTruthy();
    expect(screen.getByText(/Change the art itself under Splatter/)).toBeTruthy();
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
    fireEvent.click(team().getByRole('button', { name: 'Hide Portrait' }));
    expect(team().getByRole('button', { name: 'Portrait' }).closest('.hud__layer')!.classList.contains('hud__layer--hidden')).toBe(true);
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

  it('says which class your infected health is shown as, and that edits reach every special infected', () => {
    // The game hides the panel while you pin or throw: /home/volence/l4d/hud/probe-phase2-infected/b9/shots/b9/b9-d.png, b9-h, b9-m.
    render(<Hud />);
    fireEvent.click(screen.getByRole('tab', { name: 'Infected' }));
    fireEvent.click(screen.getByRole('button', { name: 'Your infected health' }));
    const note = (c: string) => `Shown as the ${c}. Edits apply to every special infected; the Boomer's smaller bar moves the same and sizes in proportion. The game hides this panel while you pin a survivor or throw a rock.`;
    expect(screen.getByText(note('Hunter'))).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Boomer' }));
    expect(screen.getByText(note('Boomer'))).toBeTruthy();
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

    // The builder is too wide for the side panel, so it opens under the canvas instead.
    const below = (container: Element) => container.querySelector('.hud__stage .hud__xhairbelow');

    it('opens the crosshair builder below the canvas only while the crosshair is selected', () => {
      localStorage.setItem('xhair', JSON.stringify(SAVED));
      stubCanvas();
      const { container } = render(<Hud />);
      expect(below(container)).toBeNull();
      selectCrosshair();
      const panel = below(container)!;
      expect(panel).toBeTruthy();
      expect(within(panel as HTMLElement).getByRole('heading', { name: 'Crosshair' })).toBeTruthy();
      expect(within(panel as HTMLElement).getByRole('slider', { name: 'Dot size' })).toBeTruthy();
      expect(within(panel as HTMLElement).getByRole('combobox', { name: 'Shape' })).toBeTruthy();
      expect(within(panel as HTMLElement).getByLabelText('Upload a crosshair')).toBeTruthy();
      // Selecting something else closes it.
      fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
      expect(below(container)).toBeNull();
    });

    it("closes the builder below the canvas with its close button, which deselects", () => {
      localStorage.setItem('xhair', JSON.stringify(SAVED));
      stubCanvas();
      const { container } = render(<Hud />);
      selectCrosshair();
      fireEvent.click(screen.getByRole('button', { name: 'Close the crosshair builder' }));
      expect(below(container)).toBeNull();
      expect(screen.getByText(/Select an element on the canvas or in Layers/)).toBeTruthy();
    });

    it('keeps the side panel to the choice, a small preview and the hide box while the crosshair is selected', () => {
      localStorage.setItem('xhair', JSON.stringify(SAVED));
      stubCanvas();
      const { container } = render(<Hud />);
      selectCrosshair();
      const side = container.querySelector('.hud__side') as HTMLElement;
      const s = within(side);
      expect(s.getByRole('radio', { name: /^custom/i })).toBeTruthy();
      expect(s.getByRole('radio', { name: /game default/i })).toBeTruthy();
      expect(s.getByLabelText("Hide the game's crosshair")).toBeTruthy();
      expect(s.getByLabelText('Your crosshair')).toBeTruthy();
      expect(s.getByText('Edit the crosshair in the Crosshair panel under the preview.')).toBeTruthy();
      expect(s.getByText('The game always centres the crosshair.')).toBeTruthy();
      expect(s.queryByText(/The game places this one/)).toBeNull();
      // One group box, with one legend: no nested Crosshair group inside Custom crosshair.
      expect([...side.querySelectorAll('legend')].map((l) => l.textContent)).toEqual(['Custom crosshair']);
      expect(s.queryByRole('slider')).toBeNull();
      expect(s.queryByRole('combobox', { name: 'Shape' })).toBeNull();
      expect(s.queryByLabelText('Upload a crosshair')).toBeNull();
      expect(s.queryByRole('button', { name: /reset this element/i })).toBeNull();
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

    /**
     * The preview's image seam: every image the canvas asks for is handed
     * out unloaded, and `load` finishes one later, as a data URL's decode
     * would, firing whatever onload the page set.
     */
    const lateImages = () => {
      const made: { src: string; complete: boolean; naturalWidth: number; naturalHeight: number; onload: (() => void) | null }[] = [];
      // An earlier test's decoded copy of the same URL would otherwise be handed back already loaded.
      _resetAssetCache();
      _setImageFactory((url) => {
        const img = { src: url, complete: false, naturalWidth: 0, naturalHeight: 0, onload: null as (() => void) | null, onerror: null };
        made.push(img);
        return img as unknown as HTMLImageElement;
      });
      const load = (url: string) => act(() => {
        for (const img of made.filter((m) => m.src === url)) {
          img.complete = true; img.naturalWidth = TEX; img.naturalHeight = TEX;
          img.onload?.();
        }
      });
      return { made, load };
    };
    const drewImage = (calls: { canvas: HTMLCanvasElement; m: string; a: unknown[] }[], main: HTMLCanvasElement, url: string) =>
      calls.some((c) => c.canvas === main && c.m === 'drawImage' && (c.a[0] as { src?: string }).src === url);

    it('draws an uploaded crosshair on the main canvas once its image loads, with the crosshair selected', async () => {
      const calls = stubCanvas();
      const { made, load } = lateImages();
      try {
        const { container } = render(<Hud />);
        const main = container.querySelector('canvas.hud__canvas') as HTMLCanvasElement;
        selectCrosshair();
        const vpk = new File([encodeVPK([{ path: 'materials/vgui/hud/altcrosshair.vtf', data: encodeVTF(2, 2, new Uint8ClampedArray(16).fill(255)) }])], 'theirs.vpk');
        fireEvent.change(screen.getByLabelText('Upload a crosshair'), { target: { files: [vpk] } });
        await screen.findByText(/your uploaded crosshair/i);
        // Both the zoom and the main canvas ask for it once their effects run; neither can draw it yet.
        await waitFor(() => expect(made.some((m) => m.src === PNG)).toBe(true));
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
        expect(drewImage(calls, main, PNG)).toBe(false);
        await load(PNG);
        expect(drewImage(calls, main, PNG)).toBe(true);
      } finally {
        _setImageFactory(null);
        _resetAssetCache();
      }
    });

    it('draws a stored image crosshair on the main canvas once its image loads, on a fresh page', async () => {
      localStorage.setItem('hud', JSON.stringify({ v: 1, crosshair: 'bundle', xhairArt: { kind: 'image', png: PNG, w: TEX, h: TEX } }));
      const calls = stubCanvas();
      const { load } = lateImages();
      try {
        const { container } = render(<Hud />);
        const main = container.querySelector('canvas.hud__canvas') as HTMLCanvasElement;
        expect(drewImage(calls, main, PNG)).toBe(false);
        await load(PNG);
        expect(drewImage(calls, main, PNG)).toBe(true);
      } finally {
        _setImageFactory(null);
        _resetAssetCache();
      }
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

    it('says Undo brings back the crosshair the design had, only when it had a different one', () => {
      localStorage.setItem('xhair', JSON.stringify(SAVED));
      localStorage.setItem('hud', JSON.stringify({ v: 1, crosshair: 'bundle', xhairArt: { kind: 'built', state: { shape: 'dot' } } }));
      history.replaceState(null, '', '/hud?from=crosshair');
      render(<Hud />);
      expect(screen.getByText(/is in this HUD now/)).toBeTruthy();
      expect(screen.getByText(/Undo brings back the one it had/)).toBeTruthy();
      cleanup();
      localStorage.setItem('hud', JSON.stringify({ v: 1, crosshair: 'none' }));
      history.replaceState(null, '', '/hud?from=crosshair');
      render(<Hud />);
      expect(screen.getByText(/is in this HUD now/)).toBeTruthy();
      expect(screen.queryByText(/Undo brings back/)).toBeNull();
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

  // Plan Task 11: the infected row is spaced by the gap between cards, and can be fitted.
  it('offers the infected row a Gap slider and a Fit box, and no Spacing box', async () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('tab', { name: 'Infected' }));
    fireEvent.click(screen.getByRole('button', { name: 'Infected teammates' }));
    expect(screen.queryByLabelText('Spacing')).toBeNull();
    fireEvent.click(screen.getByLabelText('Fit the card to its contents'));
    const gap = screen.getByRole('slider', { name: /^Gap/ }) as HTMLInputElement;
    expect(gap.value).toBe('7');                       // stock's 140 pitch less the fitted 133 card
    fireEvent.input(gap, { target: { value: '12' } });
    await waitFor(() => expect((JSON.parse(localStorage.getItem('hud') ?? '{}') as HudDesign).elements?.infectedRow).toMatchObject({ fit: true, gap: 12 }));
  });

  it('offers a Gap slider for the teammates, starting at the gap the fitted stock row already has', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    expect(screen.queryByLabelText('Spacing')).toBeNull();
    const gap = screen.getByRole('slider', { name: /^Gap/ }) as HTMLInputElement;
    // Stock's pitch 140 less the fitted card, 122 wide with the bar where the game draws it (probe X15).
    expect(gap.value).toBe('18');
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

  it('survives a browser without FontFace', async () => {
    // happy-dom has no FontFace; the page must not throw and must still render
    // the canvas. The preview asks for each face as it first draws in it
    // (loadFace in hud/fonts.ts, which fonts.test.ts covers).
    const { container } = render(<Hud />);
    expect(container.querySelector('canvas')).not.toBeNull();
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
    // Moved 12 right the portrait's centre is 2.5 short of the health bar's left edge (39, where the game
    // draws it: the item row's x, probe X15), so it snaps there: 39 - 11.5 = 27.5, rounded to 28.
    dragFrom(canvas, [24, 454], [36, 454], {});
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('28');
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
    // Your health, fitted by default (slice 2.F G2), is framed (728, 421) to (858, 474); its top-left corner
    // out by half, to (663, 394.5), keeps the bottom-right corner put. The element's own place is the
    // frame less LocalPlayer's fitted offset (0, 32) at scale 1.5: (663, 346.5), kept as whole units.
    dragFrom(canvas, [728, 421], [663, 394.5]);
    expect((screen.getByRole('slider', { name: /^Scale/ }) as HTMLInputElement).value).toBe('1.5');
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('663');
    expect((screen.getByLabelText('Y') as HTMLInputElement).value).toBe('346');
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
    // Card 1's fitted splatter runs (13, 441) to (135, 502): its east handle sits at (135, 471.5).
    dragFrom(canvas, [135, 471.5], [145, 471.5]);
    expect((screen.getByLabelText('W') as HTMLInputElement).value).toBe('132');
    undoKey();
    expect((screen.getByLabelText('W') as HTMLInputElement).value).toBe('122');
    fireEvent.input(screen.getByLabelText('Damage splatter opacity'), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText('Damage splatter opacity'));
    expect((screen.getByLabelText('Damage splatter opacity') as HTMLInputElement).value).toBe('50');
  });

  it('picks the splatter on the canvas where no other piece is, drags it, and undoes with Ctrl+Z', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    // Card 3 (Zoey) is drawn at (293, 441), 122 x 36: (323, 456) is inside it, in the splatter, but
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
    fireEvent.click(team().getByRole('button', { name: 'Portrait' }));
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

  it('warns that hiding the game\'s crosshair removes the ability marker too (probe Q16b)', () => {
    // /home/volence/l4d/hud/probe-phase2-infected/b10/shots/crops/centre-bcef.png: never_draw, no marker.
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Custom crosshair' }));
    const warning = 'This also removes the ability marker on the infected side.';
    expect(screen.queryByText(warning)).toBeNull();
    fireEvent.click(screen.getByLabelText("Hide the game's crosshair"));
    expect(screen.getByText(warning)).toBeTruthy();
  });

  it('offers the ability marker\'s size in pixels and its colours, and says when the game shows it', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('tab', { name: 'Infected' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ability marker' }));
    expect(screen.getByText("Shown only with the game's crosshair on (crosshair 1). Sized in screen pixels: smaller on a bigger screen. The attack colours show when a survivor is in reach.")).toBeTruthy();
    expect(screen.getByText('Size (pixels)')).toBeTruthy();
    expect(screen.getByLabelText('Attack colour colour')).toBeTruthy();
    expect(screen.queryByText('X')).toBeNull();                   // the game centres it
  });

  it('lets any file be picked for Import a HUD, so a renamed one like my_hud.vpk.orig is not hidden', () => {
    render(<Hud />);
    // No accept filter: a file that is not a HUD is refused by the import's own error message.
    expect((screen.getByLabelText('Import a HUD file') as HTMLInputElement).hasAttribute('accept')).toBe(false);
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
    expect(gap().value).toBe('18');
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
    // The health bar moved too: drawn at the item row's x (probe X15), it now starts at 44.
    clickAt(canvas, 65, 460);
    expect(screen.getByText('Health bar', { selector: 'legend' })).toBeTruthy();
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('44');
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
    // The weapons (y 165 to 325) and your health, fitted by default to y 421 to 474 (slice 2.F G2).
    dragFrom(canvas, [700, 300], [860, 430], { shiftKey: true });
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
    // Five: ownHealth, teamColumn, weaponSelection, chat and killNotices (the
    // use bar is an occasional panel, not drawn with the toggle off); with no
    // crosshair saved on the Crosshair page, a new design has crosshair 'none',
    // and no xHair to select.
    expect(screen.getByText('5 elements', { selector: 'legend' })).toBeTruthy();
  });

  it('aligns several pieces, and hides them all', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    clickAt(canvas, 24, 454);
    clickAt(canvas, 60, 460, { shiftKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Align right' }));
    // Their box ends at 135 (the bar's right edge, drawn from the item row's 39): the portrait moves to 112.
    fireEvent.click(screen.getByLabelText('Visible'));
    fireEvent.click(team().getByRole('button', { name: 'Portrait' }));
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('112');
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

  it('previews each side on its own in-game shot until a backdrop is picked, then keeps the pick', () => {
    const { container } = render(<Hud />);
    const bar = within(container.querySelector('.hud__toolbar') as HTMLElement);
    const pick = () => bar.getByRole('combobox', { name: /backdrop/i }) as HTMLSelectElement;
    expect(pick().value).toBe('survivor-hilltop');
    const values = [...pick().querySelectorAll('option')].map((o) => o.value);
    for (const v of ['survivor-hilltop', 'survivor-subway', 'infected-hunter', 'infected-ghost', 'scene', 'dark', 'bright', 'grey', 'shot']) {
      expect(values, v).toContain(v);
    }
    fireEvent.click(screen.getByRole('tab', { name: 'Infected' }));
    expect(pick().value).toBe('infected-hunter');
    fireEvent.change(pick(), { target: { value: 'survivor-subway' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Survivor' }));
    expect(pick().value).toBe('survivor-subway');
    fireEvent.click(screen.getByRole('tab', { name: 'Infected' }));
    expect(pick().value).toBe('survivor-subway');
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

  const hiddenRow = (label: string, scope: Pick<typeof screen, 'getByRole'> = screen) => scope.getByRole('button', { name: label }).closest('.hud__layer')!.classList.contains('hud__layer--hidden');

  it('opens a menu on right-click for the piece under the pointer, and Hide hides it', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    fireEvent.contextMenu(canvas, { clientX: 24, clientY: 454 });
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Hide', 'Reset', 'Bring to front', 'Send to back', 'Select whole card', 'Select Teammates']);
    expect(screen.getByText('Portrait', { selector: 'legend' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(hiddenRow('Portrait', team())).toBe(true);
    expect((screen.getByLabelText('Visible') as HTMLInputElement).checked).toBe(false);
  });

  it('acts on the whole selection when the right-click is on part of it', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    clickAt(canvas, 24, 454);
    clickAt(canvas, 60, 460, { shiftKey: true });
    fireEvent.contextMenu(canvas, { clientX: 60, clientY: 460 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }));
    expect(hiddenRow('Portrait', team())).toBe(true);
    expect(hiddenRow('Health bar', team())).toBe(true);
  });

  it('offers Select whole card for a piece, and only Select Teammates for a card, in any layout', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    fireEvent.contextMenu(canvas, { clientX: 24, clientY: 454 });
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Hide', 'Reset', 'Bring to front', 'Send to back', 'Select whole card', 'Select Teammates']);
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
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Hide', 'Reset', 'Bring to front', 'Send to back', 'Select whole card', 'Select Teammates']);
  });

  it('offers Bring to front and Send to back for a piece, and Send to back saves a zpos under the lowest in the card file', async () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    fireEvent.contextMenu(canvas, { clientX: 24, clientY: 454 });
    const items = screen.getAllByRole('menuitem').map((b) => b.textContent);
    expect(items).toContain('Bring to front');
    expect(items).toContain('Send to back');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Send to back' }));
    // Stock teammatepanel.res: BackgroundImage at -1 is the lowest zpos; one below it is the card background's -2,
    // which no piece may reach (review M1), so the piece goes to -1.
    await waitFor(() => expect(JSON.parse(localStorage.getItem('hud') ?? '{}').children?.teamColumn?.Head?.z).toBe(-1));
  });

  it('lists the survivor Layers under their headings, the card pieces under In every card, with your own health pieces under it', () => {
    const { container } = render(<Hud />);
    const titles = Array.from(container.querySelectorAll('.hud__layergroup-title')).map((t) => t.textContent);
    expect(titles).toEqual(['You', 'Team', 'Messages', 'Finales and Survival']);
    const rows = Array.from(container.querySelectorAll('.hud__layer')).map((r) => [r.className.replace('hud__layer ', ''), r.textContent]);
    expect(rows).toEqual([
      ['hud__layer--d0', 'Your health'],
      ['hud__layer--d1', 'Portrait'], ['hud__layer--d1', 'Health bar'], ['hud__layer--d1', 'Health cross'], ['hud__layer--d1', 'Health number'],
      ['hud__layer--d1', 'Scratches, top'], ['hud__layer--d1', 'Scratches, bottom'],
      ['hud__layer--d1', 'Down pictureshown when down'], ['hud__layer--d1', 'Crouch iconshown when crouched'],
      ['hud__layer--d0', 'Weapons'], ['hud__layer--d0', 'Use / revive bar'],
      ['hud__layer--d1', 'Label'], ['hud__layer--d1', 'Bar'], ['hud__layer--d1', 'Icon'], ['hud__layer--d1', 'Subtext'],
      ['hud__layer--d0 hud__layer--hidden', 'Custom crosshair'],
      ['hud__layer--d0', 'Your microphone'],
      ['hud__layer--d0', 'Teammates'],
      ['hud__layer--d1', 'Card 1'], ['hud__layer--d1', 'Card 2'], ['hud__layer--d1', 'Card 3'],
      ['hud__layer--d1 hud__layersub', 'In every card'],
      ['hud__layer--d2', 'Portrait'], ['hud__layer--d2', 'Health bar'], ['hud__layer--d2', 'Name'], ['hud__layer--d2', '＋ Health number'],
      ['hud__layer--d2', 'Item icons'], ['hud__layer--d2', 'Status text'], ['hud__layer--d2', 'Damage splatter'],
      ['hud__layer--d2', 'Down pictureshown when down'], ['hud__layer--d2', 'Dead pictureshown when dead'],
      ['hud__layer--d2 hud__layer--hidden', 'Voice iconshown when talking'],
      ['hud__layer--d0', 'Teammate in trouble'], ['hud__layer--d0', 'Wait for teammates'],
      ['hud__layer--d0', 'Chat'], ['hud__layer--d0', 'Kill / incap notices'], ['hud__layer--d0', 'Vote'], ['hud__layer--d0', 'Voice list'],
      ['hud__layer--d0', 'Survival timer'], ['hud__layer--d0', 'Finale meter'],
    ]);
  });

  it('shows a close-up of the selection in the side panel only while something is selected', () => {
    render(<Hud />);
    expect(screen.queryByLabelText('Close-up of the selection')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Your microphone' }));
    expect(screen.getByLabelText('Close-up of the selection')).toBeTruthy();
  });

  it('folds each element\'s pieces away until opened, and opens the one being edited on its own', () => {
    _setFoldDefault(false);
    render(<Hud />);
    expect(layer('Teammates').queryByRole('button', { name: 'Card 1' })).toBeNull();
    expect(layer('Your health').queryByRole('button', { name: 'Portrait' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Unfold Chat' })).toBeNull();          // no pieces, no arrow
    fireEvent.click(screen.getByRole('button', { name: 'Unfold Teammates' }));
    expect(layer('Teammates').getByRole('button', { name: 'Card 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fold Teammates' }).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Fold Teammates' }));
    expect(layer('Teammates').queryByRole('button', { name: 'Card 1' })).toBeNull();
    // Selecting an element opens it; its arrow still folds it.
    fireEvent.click(layer('Your health').getByRole('button', { name: 'Your health' }));
    expect(layer('Your health').getByRole('button', { name: 'Portrait' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Fold Your health' }));
    expect(layer('Your health').queryByRole('button', { name: 'Portrait' })).toBeNull();
  });

  it('edits a piece of your own health from Layers, offering none of the controls its probes have not proven', () => {
    render(<Hud />);
    fireEvent.click(layer('Your health').getByRole('button', { name: 'Health bar' }));
    expect(screen.getByText('Health bar', { selector: 'legend' })).toBeTruthy();
    expect(screen.getByText('The game fills the bar by health.', { exact: false })).toBeTruthy();
    expect(screen.getByText(/^While you are down/)).toBeTruthy();   // folded behind More (Note)
    expect(screen.queryByText("Edits inside a card apply to every teammate's card.")).toBeNull();
    for (const l of ['X', 'Y', 'W', 'H']) expect(screen.getByLabelText(l), l).toBeTruthy();
    expect(screen.getByText('Panel colour: Game colour (by health)')).toBeTruthy();   // probe Q1 passed (slice 2.F G1)
    expect(screen.getByLabelText('Inset')).toBeTruthy();                // probe Q3 passed (slice 2.F G3)
    // Probe B1 Q5: the game colours the cross by health whatever the file says.
    fireEvent.click(layer('Your health').getByRole('button', { name: 'Health cross' }));
    expect(screen.getByLabelText('Text size')).toBeTruthy();
    expect(screen.queryByLabelText('Health cross colour')).toBeNull();
    // Probe Q8 passed (slice 2.F G5): the crouch icon keeps a file tint, so its Tint is offered.
    fireEvent.click(layer('Your health').getByRole('button', { name: 'Crouch icon' }));
    expect(screen.getByLabelText('Crouch icon tint')).toBeTruthy();
  });

  it('hides the crouch icon tint again if gate Q8 is closed', () => {
    _setProbe('Q8', false);
    try {
      render(<Hud />);
      fireEvent.click(layer('Your health').getByRole('button', { name: 'Crouch icon' }));
      expect(screen.queryByLabelText('Crouch icon tint')).toBeNull();
    } finally { _setProbe('Q8', null); }
  });

  it('keeps the teammate child controls saying the edit applies to every card, and going back to the Teammates', () => {
    render(<Hud />);
    fireEvent.click(team().getByRole('button', { name: 'Portrait' }));
    expect(screen.getByText("Edits inside a card apply to every teammate's card.")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Teammates' }));
    expect(screen.getByText('Teammates', { selector: 'legend' })).toBeTruthy();
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
    // The team is 555 wide (fitted cards 122 wide, the bar where the game draws it): 853 - 555 = 298.
    expect(x().value).toBe('298');
    expect(y().value).toBe('300');
    // Scaled up, the wider team is drawn further left still.
    fireEvent.input(screen.getByRole('slider', { name: /^Scale/ }), { target: { value: '1.5' } });
    expect(x().value).toBe('21');
    // A typed value inside the reach lands where it is typed.
    fireEvent.input(x(), { target: { value: '10' } });
    expect(x().value).toBe('10');
  });

  // Plan decision 8 (task L4): the Scale slider moves a panel it grows off screen back inside.
  it('moves your health back on screen when its Scale slider grows it past the edge', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Your health' }));
    const x = () => Number((screen.getByLabelText('X') as HTMLInputElement).value);
    expect(x()).toBe(728);
    fireEvent.input(screen.getByRole('slider', { name: /^Scale/ }), { target: { value: '2' } });
    expect(x()).toBeLessThan(728);
  });

  // Task L5: your health's stock frame runs 5 units past the right edge (728..858 on 853), so its
  // bottom-right handle is pinned inside the canvas, and a press there scales rather than moves.
  it('finds a handle pinned inside the canvas where the frame runs past the edge', () => {
    const { container } = render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Your health' }));
    const canvas = unitCanvas(container);
    const scale = () => Number((screen.getByRole('slider', { name: /^Scale/ }) as HTMLInputElement).value);
    const x = () => Number((screen.getByLabelText('X') as HTMLInputElement).value);
    dragFrom(canvas, [850, 474], [790, 450]);
    expect(scale()).toBeLessThan(1);
    expect(x()).toBe(728);
  });

  it('shows every Layers row its name, with a state note on its own line under it', () => {
    render(<Hud />);
    for (const [label, note] of [['Down picture', 'shown when down'], ['Dead picture', 'shown when dead'], ['Voice icon', 'shown when talking']]) {
      const name = team().getByRole('button', { name: label });
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

  describe('the weapon selection', () => {
    const pick = () => fireEvent.click(screen.getByRole('button', { name: 'Weapons' }));
    const box = (name: string) => screen.getByRole('spinbutton', { name }) as HTMLInputElement;
    const slider = (name: string) => screen.getByRole('slider', { name }) as HTMLInputElement;

    it('shows the keys the game reads, with the preset values, and says what cannot change', () => {
      render(<Hud />);
      pick();
      expect(screen.getByRole('button', { name: 'Ammo only' })).toBeTruthy();
      expect([
        'Inset from right', 'Start height', 'Gun box W', 'Gun box H', 'Pistol box W', 'Pistol box H', 'Gun picture height',
        'Item size', 'Numbers in from box edge', 'Reserve lower by', 'Clip text size', 'Reserve and pistol text size',
      ].map((n) => box(n).value)).toEqual(['10', '10', '53', '24', '53', '24', '20', '24', '28', '5', '24', '18']);
      expect(slider('Gun box W').value).toBe('53');
      expect((screen.getByRole('checkbox', { name: 'Weapon pictures' }) as HTMLInputElement).checked).toBe(true);
      expect((screen.getByRole('checkbox', { name: 'Item pictures' }) as HTMLInputElement).checked).toBe(true);
      expect(screen.getByText(/clip numbers are always white/i)).toBeTruthy();
      expect(screen.getByText(/pistol always sits just under the main gun/i)).toBeTruthy();
      expect(screen.getByText(/nudges its numbers a little left/i)).toBeTruthy();
    });

    it('applies Ammo only in one undo step', () => {
      render(<Hud />);
      pick();
      fireEvent.click(screen.getByRole('button', { name: 'Ammo only' }));
      expect(box('Numbers in from box edge').value).toBe('42'); // AmmoX 48 less the inset of 6
      expect(box('Item size').value).toBe('0');
      expect((screen.getByRole('combobox', { name: 'Active box' }) as HTMLSelectElement).value).toBe('hidden');
      expect((screen.getByRole('checkbox', { name: 'Weapon pictures' }) as HTMLInputElement).checked).toBe(false);
      expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('417');
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(box('Numbers in from box edge').value).toBe('28');
      expect((screen.getByRole('combobox', { name: 'Active box' }) as HTMLSelectElement).value).toBe('stock');
      expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('755');
    });

    it('moves a slider and its number box together, clamped as the download is', () => {
      render(<Hud />);
      pick();
      fireEvent.input(slider('Gun box W'), { target: { value: '80' } });
      fireEvent.change(slider('Gun box W'));
      expect(box('Gun box W').value).toBe('80');
      fireEvent.input(box('Numbers in from box edge'), { target: { value: '999' } });
      fireEvent.blur(box('Numbers in from box edge'));
      // The file's PrimaryWeaponAmmoX caps at 200; the row counts from the inset of 10.
      expect(box('Numbers in from box edge').value).toBe('190');
      fireEvent.input(box('Clip text size'), { target: { value: '' } });
      expect(box('Clip text size').value).toBe('');
      fireEvent.blur(box('Clip text size'));
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(box('Numbers in from box edge').value).toBe('28');
    });

    it('keeps the ammo numbers with the boxes when the inset changes', () => {
      render(<Hud />);
      pick();
      fireEvent.input(box('Inset from right'), { target: { value: '40' } });
      fireEvent.blur(box('Inset from right'));
      // The game measures PrimaryWeaponAmmoX from the panel's edge, not the box's, so
      // the editor moves it with the inset: 38 + 30 in the file, still 28 in from the box.
      expect(box('Numbers in from box edge').value).toBe('28');
      fireEvent.input(box('Numbers in from box edge'), { target: { value: '20' } });
      fireEvent.blur(box('Numbers in from box edge'));
      expect(box('Inset from right').value).toBe('40');
      expect(box('Numbers in from box edge').value).toBe('20');
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(box('Inset from right').value).toBe('10');
      expect(box('Numbers in from box edge').value).toBe('28');
    });

    it('lets a number box be typed one digit at a time, clamping only when typing ends', () => {
      render(<Hud />);
      pick();
      // "1" alone is under the minimum of 6; it must stay "1" so "12" can be typed.
      fireEvent.input(box('Clip text size'), { target: { value: '1' } });
      expect(box('Clip text size').value).toBe('1');
      fireEvent.input(box('Clip text size'), { target: { value: '12' } });
      expect(box('Clip text size').value).toBe('12');
      fireEvent.blur(box('Clip text size'));
      expect(box('Clip text size').value).toBe('12');
      expect(slider('Clip text size').value).toBe('12');
      // A value left under the minimum snaps to it when typing ends.
      fireEvent.input(box('Clip text size'), { target: { value: '2' } });
      fireEvent.keyDown(box('Clip text size'), { key: 'Enter' });
      expect(box('Clip text size').value).toBe('6');
    });

    it('previews each slot being held, from the toolbar, on the survivor side only', () => {
      render(<Hud />);
      const held = screen.getByRole('tablist', { name: 'Holding' });
      expect(within(held).getByRole('tab', { name: 'Gun' }).getAttribute('aria-selected')).toBe('true');
      fireEvent.click(within(held).getByRole('tab', { name: 'Pistol' }));
      expect(within(held).getByRole('tab', { name: 'Pistol' }).getAttribute('aria-selected')).toBe('true');
      expect(within(held).getByRole('tab', { name: 'Item' })).toBeTruthy();
      fireEvent.click(screen.getByRole('tab', { name: 'Infected' }));
      expect(screen.queryByRole('tablist', { name: 'Holding' })).toBeNull();
    });

    it('offers a colour only for a flat or rounded box', () => {
      render(<Hud />);
      pick();
      const select = () => screen.getByRole('combobox', { name: 'Other boxes' }) as HTMLSelectElement;
      expect(screen.queryByLabelText('Other boxes colour')).toBeNull();
      fireEvent.change(select(), { target: { value: 'rounded' } });
      expect((screen.getByLabelText('Other boxes colour') as HTMLInputElement).value).toBe('#000000');
      fireEvent.change(select(), { target: { value: 'hidden' } });
      expect(screen.queryByLabelText('Other boxes colour')).toBeNull();
      fireEvent.change(select(), { target: { value: 'stock' } });
      expect(select().value).toBe('stock');
    });

    it('clears every weapon edit with Reset this element', () => {
      render(<Hud />);
      pick();
      fireEvent.click(screen.getByRole('checkbox', { name: 'Item pictures' }));
      expect((screen.getByRole('checkbox', { name: 'Item pictures' }) as HTMLInputElement).checked).toBe(false);
      fireEvent.click(screen.getByText('Reset this element'));
      expect((screen.getByRole('checkbox', { name: 'Item pictures' }) as HTMLInputElement).checked).toBe(true);
    });
  });
});

describe('Importing a HUD', () => {
  const files = sampleHud();
  const vpkFile = () => new File([encodeVPK(asList(files))], 'edgehud.vpk');
  let id = '';
  beforeEach(async () => { _setHudStore(memoryStore()); id = await hudId(files); });
  afterEach(() => { _setHudStore(null); unregisterImport(id); });
  const preset = () => screen.getByRole('combobox', { name: /preset/i }) as HTMLSelectElement;
  const importFile = (f: File) => fireEvent.change(screen.getByLabelText('Import a HUD file'), { target: { files: [f] } });
  const BANNER = "This design was made on the imported HUD 'edgehud'. Import it again to edit or download it.";
  /** Click Download and hand back the bytes it saved. */
  const downloaded = async (): Promise<Uint8Array> => {
    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { blobs.push(b as Blob); return 'blob:hud'; });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: /download/i }));
    await waitFor(() => expect(blobs).toHaveLength(1));
    return new Uint8Array(await blobs[0].arrayBuffer());
  };

  it('imports a .vpk from the Preset select and switches the design to it', async () => {
    render(<Hud />);
    expect(screen.getByRole('option', { name: 'Import a HUD...' })).toBeTruthy();
    importFile(vpkFile());
    await screen.findByText('Imported edgehud.');
    expect(preset().value).toBe(`imported:${id}`);
    expect(screen.getByRole('option', { name: 'Imported: edgehud' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Teammates' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Kill / incap notices' })).toBeTruthy();
  });

  it('says in one line why a file is not a HUD, and leaves the design as it was', async () => {
    render(<Hud />);
    importFile(new File([encodeVPK([{ path: 'materials/x.vtf', data: new Uint8Array(4) }])], 'x.vpk'));
    await screen.findByText('This file has no scripts/hudlayout.res, so it is not a HUD');
    expect(preset().value).toBe('stock');
  });

  it("downloads the imported HUD with the upload's own files in it", async () => {
    render(<Hud />);
    importFile(vpkFile());
    await screen.findByText('Imported edgehud.');
    const got = readVPK(await downloaded());
    expect(got.get('sound/ui/edge.wav')).toEqual(files.get('sound/ui/edge.wav'));
  });

  it('opens a design whose HUD is not in this browser read-only, with Download off, until the HUD is imported again', async () => {
    localStorage.setItem('hud', JSON.stringify({ v: 1, name: 'mine', preset: 'imported', imported: { id, name: 'edgehud' } }));
    render(<Hud />);
    await screen.findByText(BANNER);
    expect((screen.getByRole('button', { name: /download/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Teammates' })).toBeNull();
    expect(preset().value).toBe(`imported:${id}`);
    importFile(vpkFile());
    await waitFor(() => expect(screen.queryByText(BANNER)).toBeNull());
    expect((screen.getByRole('button', { name: /download/i }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Teammates' })).toBeTruthy();
  });

  it('removes an imported HUD from this browser, and a design on it then shows the banner', async () => {
    render(<Hud />);
    importFile(vpkFile());
    await screen.findByText('Imported edgehud.');
    fireEvent.change(preset(), { target: { value: 'remove' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Imported HUD to remove' }), { target: { value: id } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await screen.findByText(BANNER);
    expect(screen.queryByRole('option', { name: 'Imported: edgehud' })).toBeNull();
  });

  it('switches back to Stock and onto an import again from the Preset select', async () => {
    render(<Hud />);
    importFile(vpkFile());
    await screen.findByText('Imported edgehud.');
    fireEvent.change(preset(), { target: { value: 'stock' } });
    await waitFor(() => expect(preset().value).toBe('stock'));
    fireEvent.change(preset(), { target: { value: `imported:${id}` } });
    await waitFor(() => expect(preset().value).toBe(`imported:${id}`));
  });

  it('undoes a switch onto an import and a switch off it, back to the design and preset each started from', async () => {
    // Each switch is one undo step that holds the whole design: the import
    // empties the layout edits and the switch to Stock brings the fitted
    // teammates back, so Undo has to restore those as well as the preset.
    const saved = async (preset: string) => {
      await waitFor(() => expect(JSON.parse(localStorage.getItem('hud') ?? '{}').preset).toBe(preset));
      return JSON.parse(localStorage.getItem('hud')!);
    };
    const undo = () => fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    render(<Hud />);
    const onStock = await saved('stock');
    importFile(vpkFile());
    await screen.findByText('Imported edgehud.');
    const onImport = await saved('imported');
    expect(onImport.elements).toEqual({});
    expect(onStock.elements).not.toEqual({});

    undo();
    await waitFor(() => expect(preset().value).toBe('stock'));
    expect(await saved('stock')).toEqual(onStock);

    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    await waitFor(() => expect(preset().value).toBe(`imported:${id}`));
    expect(await saved('imported')).toEqual(onImport);

    fireEvent.change(preset(), { target: { value: 'stock' } });
    await waitFor(() => expect(preset().value).toBe('stock'));
    expect((await saved('stock')).elements).toEqual(onStock.elements);

    undo();
    await waitFor(() => expect(preset().value).toBe(`imported:${id}`));
    expect(await saved('imported')).toEqual(onImport);
    expect(screen.getByRole('button', { name: 'Teammates' })).toBeTruthy();
  });

  it('still imports when this browser will not store it, and says it lasts only while the page is open', async () => {
    _setHudStore({ ...memoryStore(), put: () => Promise.reject(new Error('quota')) });
    render(<Hud />);
    importFile(vpkFile());
    await screen.findByText(/kept only until this page closes/);
    expect(preset().value).toBe(`imported:${id}`);
  });

  it('still imports, switches and downloads when this browser has no working storage at all', async () => {
    const no = () => Promise.reject(new Error('blocked'));
    const broken: HudStore = { get: no, put: no, list: no, delete: no };
    _setHudStore(broken);
    render(<Hud />);
    importFile(vpkFile());
    await screen.findByText(/kept only until this page closes/);
    expect(screen.getByRole('option', { name: 'Imported: edgehud' })).toBeTruthy();
    fireEvent.change(preset(), { target: { value: 'stock' } });
    await waitFor(() => expect(preset().value).toBe('stock'));
    fireEvent.change(preset(), { target: { value: `imported:${id}` } });
    await waitFor(() => expect(preset().value).toBe(`imported:${id}`));
    expect(readVPK(await downloaded()).get('sound/ui/edge.wav')).toEqual(files.get('sound/ui/edge.wav'));
  });

  it("lists in the download note what the import left out and which of the HUD's files the editor replaced", async () => {
    // A design with a crosshair of its own keeps it on an upload that has no
    // crosshair texture, so the download writes altcrosshair.vmt over the
    // upload's own. gameinfo.txt is never imported.
    localStorage.setItem('hud', JSON.stringify({ v: 1, crosshair: 'bundle', xhairArt: { kind: 'built', state: { shape: 'dot' } } }));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => new Proxy({}, {
      get: (_t, k) => (...a: unknown[]) => {
        if (k === 'getImageData') return { data: new Uint8ClampedArray(TEX * TEX * 4) };
        if (k === 'createImageData') return { data: new Uint8ClampedArray((a[0] as number) * (a[1] as number) * 4) };
        if (k === 'measureText') return { width: 10 };
        if (k === 'createLinearGradient' || k === 'createRadialGradient') return { addColorStop() {} };
        return undefined;
      },
      set: () => true,
    }) as never);
    const withExtras = new Map(files);
    withExtras.set('gameinfo.txt', new Uint8Array([1]));
    withExtras.set('materials/vgui/hud/altcrosshair.vmt', new Uint8Array([2]));
    const extrasId = await hudId(new Map([...withExtras].filter(([p]) => p !== 'gameinfo.txt')));
    try {
      render(<Hud />);
      importFile(new File([encodeVPK(asList(withExtras))], 'edgehud.vpk'));
      await screen.findByText('Imported edgehud. Left out: gameinfo.txt.');
      await downloaded();
      await screen.findByText(
        "Saved my_hud.vpk. The editor's own copies replaced these files from your HUD: materials/vgui/hud/altcrosshair.vmt."
        + ' Left out when it was imported: gameinfo.txt.',
        { exact: false },
      );
    } finally { unregisterImport(extrasId); }
  });

  describe('an import the editor cannot show', () => {
    const TEAM = 'resource/ui/hud/teamdisplayhud.res';
    const broken = sampleHud({ [TEAM]: '// blank\r\n' });
    let badId = '';
    let store: HudStore;
    beforeEach(async () => { badId = await hudId(broken); store = memoryStore(); _setHudStore(store); });
    afterEach(() => { unregisterImport(badId); checks.skip = false; });
    /** A broken import already in this browser's store, as one made before the checks were, with the saved design on it. */
    const storedBroken = async () => {
      await store.put({ id: badId, name: 'blank', files: broken, bytes: 1, added: 1 });
      localStorage.setItem('hud', JSON.stringify({ v: 1, name: 'mine', preset: 'imported', imported: { id: badId, name: 'blank' } }));
    };

    it('is refused at import in one line naming the file, and is neither stored nor listed', async () => {
      render(<Hud />);
      importFile(new File([encodeVPK(asList(broken))], 'blank.vpk'));
      await screen.findByText(/^This HUD's resource\/ui\/hud\/teamdisplayhud\.res /);
      expect(preset().value).toBe('stock');
      expect(await store.list()).toEqual([]);
      expect(screen.queryByRole('option', { name: 'Imported: blank' })).toBeNull();
    });

    it('is refused at import when it cannot be drawn, though every file has the right shape', async () => {
      const LOCAL = 'resource/ui/hud/localplayerdisplay.res';
      const noLocal = sampleHud({ [LOCAL]: dropBlock(baseFile('stock', LOCAL), 'LocalPlayer') });
      const noLocalId = await hudId(noLocal);
      try {
        render(<Hud />);
        importFile(new File([encodeVPK(asList(noLocal))], 'nolocal.vpk'));
        await screen.findByText(/^This HUD's resource\/ui\/hud\/localplayerdisplay\.res could not be shown \(/);
        expect(preset().value).toBe('stock');
        expect(await store.list()).toEqual([]);
      } finally { unregisterImport(noLocalId); }
    });

    it('when stored before the checks, opens locked with the reason and a way to remove it, and Stock still works', async () => {
      await storedBroken();
      render(<Hud />);
      await screen.findByText(/^The imported HUD 'blank' cannot be shown: This HUD's resource\/ui\/hud\/teamdisplayhud\.res /);
      expect((screen.getByRole('button', { name: /download/i }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(preset(), { target: { value: 'stock' } });
      await waitFor(() => expect(preset().value).toBe('stock'));
      expect(screen.getByRole('button', { name: 'Teammates' })).toBeTruthy();
    });

    it('when stored before the checks, is removed from the banner', async () => {
      await storedBroken();
      render(<Hud />);
      fireEvent.click(await screen.findByRole('button', { name: 'Remove this imported HUD' }));
      await waitFor(async () => expect(await store.get(badId)).toBeUndefined());
      await screen.findByText('Removed blank from this browser.');
    });

    it('is caught by the page when it throws while drawing, and the page keeps working', async () => {
      checks.skip = true;
      await storedBroken();
      render(<Hud />);
      await screen.findByText(/^The imported HUD 'blank' cannot be shown: /);
      expect(screen.getByRole('button', { name: 'Remove this imported HUD' })).toBeTruthy();
      fireEvent.change(preset(), { target: { value: 'stock' } });
      await waitFor(() => expect(preset().value).toBe('stock'));
      expect(screen.getByRole('button', { name: 'Teammates' })).toBeTruthy();
    });
  });

  describe('a design on an import this browser already has', () => {
    let store: HudStore;
    beforeEach(async () => {
      store = memoryStore(); _setHudStore(store);
      await store.put({ id, name: 'edgehud', files, bytes: 1, added: 1 });
    });
    const onImport = () => validateDesign({ v: 1, name: 'theirs', preset: 'imported', imported: { id, name: 'edgehud' }, crosshair: 'none' });
    const unlocked = async () => {
      await waitFor(() => expect(preset().value).toBe(`imported:${id}`));
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Teammates' })).toBeTruthy());
      expect(screen.queryByText(BANNER)).toBeNull();
    };

    it('opens from a share link with the HUD loaded', async () => {
      location.hash = `#d=${await encodeShare(onImport())}`;
      render(<Hud />);
      await unlocked();
    });

    it('opens from a design file with the HUD loaded', async () => {
      render(<Hud />);
      await waitFor(() => expect(preset().value).toBe('stock'));
      const input = screen.getByLabelText('Import a HUD design file');
      fireEvent.change(input, { target: { files: [new File([JSON.stringify(onImport())], 'theirs.hud.json')] } });
      await screen.findByText('Imported theirs.');
      await unlocked();
    });

    it('comes back loaded on Undo after the HUD left memory', async () => {
      render(<Hud />);
      importFile(vpkFile());
      await screen.findByText('Imported edgehud.');
      fireEvent.change(preset(), { target: { value: 'stock' } });
      await waitFor(() => expect(preset().value).toBe('stock'));
      unregisterImport(id);
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      await unlocked();
    });

    it('is loaded by picking it in the Preset select when the design already names it', async () => {
      localStorage.setItem('hud', JSON.stringify(onImport()));
      // The store read at load fails once, so the design opens with the banner.
      const get = store.get.bind(store);
      let first = true;
      store.get = (x) => { if (first) { first = false; return Promise.reject(new Error('busy')); } return get(x); };
      render(<Hud />);
      await screen.findByText(BANNER);
      fireEvent.change(preset(), { target: { value: `imported:${id}` } });
      await unlocked();
    });
  });
});

describe('Splatter', () => {
  const stored = () => JSON.parse(localStorage.getItem('hud') ?? '{}');
  const row = (label: string) => within(screen.getByRole('group', { name: label }));
  const kindOf = (label: string) => screen.getByRole('combobox', { name: `${label} style` }) as HTMLSelectElement;
  const TEAM = 'Teammate card splatter';
  const TOP = 'Your health: top scratches';
  const BOTTOM = 'Your health: bottom scratches';

  it('shows three rows by label, each offering Stock, None, Fade and Image', () => {
    render(<Hud />);
    expect(screen.getByRole('heading', { name: 'Splatter' })).toBeTruthy();
    for (const label of [TEAM, TOP, BOTTOM]) {
      expect([...kindOf(label).options].map((o) => o.textContent), label).toEqual(['Stock', 'None', 'Fade', 'Image']);
    }
  });

  it("saves a Fade, and saves the teammate splatter's None as the child's hide", async () => {
    render(<Hud />);
    fireEvent.change(kindOf(TEAM), { target: { value: 'fade' } });
    await waitFor(() => expect(stored().splatters?.splatTeam?.kind).toBe('fade'));
    fireEvent.change(kindOf(TEAM), { target: { value: 'none' } });
    await waitFor(() => expect(stored().children?.teamColumn?.BackgroundImage?.visible).toBe(false));
    expect(stored().splatters?.splatTeam?.kind).not.toBe('none');
    expect(kindOf(TEAM).value).toBe('none');
  });

  it('Reset to stock after a Fade removes the splatters', async () => {
    render(<Hud />);
    const reset = () => row(TOP).getByRole('button', { name: 'Reset to stock' }) as HTMLButtonElement;
    expect(reset().disabled).toBe(true);
    fireEvent.change(kindOf(TOP), { target: { value: 'fade' } });
    await waitFor(() => expect(stored().splatters?.splatTop?.kind).toBe('fade'));
    expect(reset().disabled).toBe(false);
    fireEvent.click(reset());
    await waitFor(() => expect(stored().splatters).toBeUndefined());
    expect(kindOf(TOP).value).toBe('stock');
  });

  it('disables the scratch rows on Modern and says why, and leaves the teammate row enabled', async () => {
    render(<Hud />);
    fireEvent.change(screen.getByRole('combobox', { name: /preset/i }), { target: { value: 'modern' } });
    await waitFor(() => expect(kindOf(TOP).disabled).toBe(true));
    expect(kindOf(BOTTOM).disabled).toBe(true);
    expect(row(TOP).getByText('This preset hides the scratches.')).toBeTruthy();
    expect(kindOf(TEAM).disabled).toBe(false);
  });

  it('offers Colour by health on a scratch Fade only, and unticking it keeps the colours', async () => {
    render(<Hud />);
    fireEvent.change(kindOf(TEAM), { target: { value: 'fade' } });
    expect(row(TEAM).queryByLabelText('Colour by health')).toBeNull();
    expect(row(TOP).queryByLabelText('Colour by health')).toBeNull();
    fireEvent.change(kindOf(TOP), { target: { value: 'fade' } });
    const box = row(TOP).getByLabelText('Colour by health') as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(stored().splatters?.splatTop?.keepColours).toBe(true));
  });

  it('draws the tint strip for a scratch Fade: Healthy, Hurt and Critical', () => {
    render(<Hud />);
    fireEvent.change(kindOf(TOP), { target: { value: 'fade' } });
    for (const name of ['Healthy', 'Hurt', 'Critical']) {
      expect(row(TOP).getByRole('img', { name }).tagName).toBe('CANVAS');
    }
  });

  it('says so when the design is too big for this browser to keep', async () => {
    render(<Hud />);
    // Restored here, not left to the file's vi.restoreAllMocks: that does not
    // undo a spy on happy-dom's localStorage, and every later test's saves failed.
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    try {
      fireEvent.change(kindOf(TOP), { target: { value: 'fade' } });
      await waitFor(() => expect(screen.getByText(
        'This design is too big for this browser to keep. Remove an uploaded image, or use Export to save it as a file.',
      )).toBeTruthy());
    } finally { spy.mockRestore(); }
  });

  it('keeps the too-big warning through a share link copy and a download, until a save succeeds', async () => {
    const TOO_BIG = 'This design is too big for this browser to keep. Remove an uploaded image, or use Export to save it as a file.';
    render(<Hud />);
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    const write = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: write } });
    const url = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:hud');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      fireEvent.change(kindOf(TOP), { target: { value: 'fade' } });
      await waitFor(() => expect(screen.getByText(TOO_BIG)).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Copy share link' }));
      await waitFor(() => expect(screen.getByText('Copied.')).toBeTruthy());
      expect(screen.getByText(TOO_BIG)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /download/i }));
      await waitFor(() => expect(screen.getByText(/^Saved /)).toBeTruthy());
      expect(screen.getByText(TOO_BIG)).toBeTruthy();
      spy.mockRestore();
      fireEvent.change(kindOf(TOP), { target: { value: 'stock' } });
      await waitFor(() => expect(screen.queryByText(TOO_BIG)).toBeNull());
      expect(screen.getByText(/^Saved /)).toBeTruthy();
    } finally { spy.mockRestore(); url.mockRestore(); click.mockRestore(); vi.unstubAllGlobals(); }
  });

  it('says an Image with no picture shows stock, with no tint strip or Colour by health', () => {
    render(<Hud />);
    fireEvent.change(kindOf(TOP), { target: { value: 'image' } });
    expect(row(TOP).getByText('No picture yet (share links do not carry pictures), showing stock.')).toBeTruthy();
    expect(row(TOP).queryByLabelText('Colour by health')).toBeNull();
    expect(row(TOP).queryByRole('img', { name: 'Healthy' })).toBeNull();
  });

  it('tells a scratch row that light art works best, as the game multiplies it by the health colour', () => {
    render(<Hud />);
    fireEvent.change(kindOf(TOP), { target: { value: 'image' } });
    expect(row(TOP).getByText(/Light or white art works best/)).toBeTruthy();
    fireEvent.change(kindOf(TEAM), { target: { value: 'image' } });
    expect(row(TEAM).queryByText(/Light or white art works best/)).toBeNull();
  });

  it('clears an upload error on Reset, on a change of kind and on Undo', async () => {
    render(<Hud />);
    const MSG = 'That image is over 4 MB.';
    const big = () => new File([new Uint8Array(4_000_001)], 'big.png', { type: 'image/png' });
    const fail = async () => {
      fireEvent.change(kindOf(TOP), { target: { value: 'image' } });
      fireEvent.change(row(TOP).getByLabelText(`${TOP} image`), { target: { files: [big()] } });
      await waitFor(() => expect(row(TOP).getByText(MSG)).toBeTruthy());
    };
    await fail();
    fireEvent.click(row(TOP).getByRole('button', { name: 'Reset to stock' }));
    await waitFor(() => expect(row(TOP).queryByText(MSG)).toBeNull());
    await fail();
    fireEvent.change(kindOf(TOP), { target: { value: 'fade' } });
    await waitFor(() => expect(row(TOP).queryByText(MSG)).toBeNull());
    await fail();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(row(TOP).queryByText(MSG)).toBeNull());
  });

  it('keeps Reset usable on a row a preset switch disabled, so a stale entry can be cleared', async () => {
    render(<Hud />);
    fireEvent.change(kindOf(TOP), { target: { value: 'fade' } });
    fireEvent.change(screen.getByRole('combobox', { name: /preset/i }), { target: { value: 'modern' } });
    await waitFor(() => expect(kindOf(TOP).disabled).toBe(true));
    const reset = row(TOP).getByRole('button', { name: 'Reset to stock' }) as HTMLButtonElement;
    expect(reset.disabled).toBe(false);
    fireEvent.click(reset);
    await waitFor(() => expect(stored().splatters?.splatTop).toBeUndefined());
  });

  it('Undo after choosing Fade brings the row back to Stock', () => {
    render(<Hud />);
    fireEvent.change(kindOf(BOTTOM), { target: { value: 'fade' } });
    expect(kindOf(BOTTOM).value).toBe('fade');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(kindOf(BOTTOM).value).toBe('stock');
  });
});

describe('Your own health on the page', () => {
  afterEach(() => { for (const id of ['Q1', 'Q2', 'Q3', 'Q8'] as const) _setProbe(id, null); _resetAssetCache(); });
  const own = () => layer('Your health');
  const saved = () => JSON.parse(localStorage.getItem('hud') ?? '{}') as HudDesign;
  /** A 2D context stand-in recording what the page draws: fillText strings and positions, drawImage sources. */
  const recordDraws = () => {
    _resetAssetCache();
    _setImageFactory((url) => ({ src: url, complete: true, naturalWidth: 64, naturalHeight: 64, onload: null, onerror: null }) as unknown as HTMLImageElement);
    const texts: { s: string; x: number; y: number }[] = [];
    const images: string[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      const canvas = this;
      return new Proxy({}, {
        get: (_t, k) => {
          if (k === 'canvas') return canvas;
          return (...a: unknown[]) => {
            if (k === 'fillText') texts.push({ s: a[0] as string, x: a[1] as number, y: a[2] as number });
            if (k === 'drawImage') images.push((a[0] as HTMLImageElement).src);
            if (k === 'getImageData') return { data: new Uint8ClampedArray(4) };
            if (k === 'measureText') return { width: 10 };
            if (k === 'createLinearGradient' || k === 'createRadialGradient') return { addColorStop() {} };
            return undefined;
          };
        },
        set: () => true,
      }) as never;
    } as never);
    return { texts, images };
  };
  /** Where your own health's Health bar sits on the unit canvas, as the page's default design draws it. */
  const ownBar = () => {
    const d = validateDesign({ v: 1 });
    const [box] = panelBoxes(d, 'ownHealth');
    return childRects(d, 'ownHealth', box, 1).find((r) => r.name === 'Health')!;
  };

  it('offers Healthy, Hurt, Down and Dead, and Hurt draws your health number as 40', () => {
    const { texts } = recordDraws();
    render(<Hud />);
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(expect.arrayContaining(['Healthy', 'Hurt', 'Down', 'Dead']));
    expect(tabs.indexOf('Hurt')).toBe(tabs.indexOf('Healthy') + 1);
    expect(texts.some((t) => t.s === '40')).toBe(false);
    fireEvent.click(screen.getByRole('tab', { name: 'Hurt' }));
    expect(screen.getByRole('tab', { name: 'Hurt' }).getAttribute('aria-selected')).toBe('true');
    expect(texts.some((t) => t.s === '40')).toBe(true);
  });

  it('toggles Crouched, and the preview draws the crouch icon while it is on', () => {
    const { images } = recordDraws();
    render(<Hud />);
    const crouched = () => screen.getByRole('button', { name: 'Crouched' });
    expect(crouched().getAttribute('aria-pressed')).toBe('false');
    expect(images.some((s) => /crouch_survivor/.test(s))).toBe(false);
    fireEvent.click(crouched());
    expect(crouched().getAttribute('aria-pressed')).toBe('true');
    expect(images.some((s) => /crouch_survivor/.test(s))).toBe(true);
    fireEvent.click(screen.getByRole('tab', { name: 'Infected' }));
    // The infected side has a crouch icon of its own (your infected health's), so the toggle stays.
    expect(crouched().getAttribute('aria-pressed')).toBe('true');
  });

  it('lists every piece of your own health in Layers, with the state notes', () => {
    render(<Hud />);
    for (const label of ['Portrait', 'Health bar', 'Health cross', 'Health number', 'Scratches, top', 'Scratches, bottom', 'Down picture', 'Crouch icon']) {
      expect(own().getByRole('button', { name: label }), label).toBeTruthy();
    }
    expect(own().getByText('shown when down')).toBeTruthy();
    expect(own().getByText('shown when crouched')).toBeTruthy();
  });

  it('shows the bar its box and note, and the Panel colour and Inset only once their probes pass', async () => {
    _setProbe('Q1', false); _setProbe('Q3', false);
    render(<Hud />);
    fireEvent.click(own().getByRole('button', { name: 'Health bar' }));
    for (const l of ['X', 'Y', 'W', 'H']) expect(screen.getByLabelText(l), l).toBeTruthy();
    expect(screen.getByText('The game fills the bar by health.', { exact: false })).toBeTruthy();
    expect(screen.getByText(/^While you are down/)).toBeTruthy();   // folded behind More (Note)
    expect(screen.queryByText(/^Panel colour/)).toBeNull();
    expect(screen.queryByLabelText('Inset')).toBeNull();
    cleanup();
    _setProbe('Q1', true); _setProbe('Q3', true);
    render(<Hud />);
    fireEvent.click(layer('Your health').getByRole('button', { name: 'Health bar' }));
    expect(screen.getByText('Panel colour: Game colour (by health)')).toBeTruthy();
    expect(screen.getByLabelText('Panel colour colour')).toBeTruthy();
    const inset = screen.getByLabelText('Inset') as HTMLInputElement;
    expect(inset.min).toBe('0');
    expect(inset.max).toBe('4');                                        // stock own bar 10 tall: 2 * 4 < 10 (review L1)
    fireEvent.input(inset, { target: { value: '3' } });
    fireEvent.blur(inset);
    await waitFor(() => expect(saved().children?.ownHealth?.Health?.keys?.inset).toBe('3'));
    fireEvent.input(screen.getByLabelText('Panel colour colour'), { target: { value: '#ff00ff' } });
    await waitFor(() => expect(saved().children?.ownHealth?.Health?.keys?.monochrome_color).toBe('255 0 255 255'));
  });

  it('offers the Panel colour on your health bar and on the teammate bar, each with its note (probe Q1)', () => {
    // /home/volence/l4d/hud/probe-phase2/RESULTS.md Q1: the whole own panel; on cards the bar and the number.
    render(<Hud />);
    fireEvent.click(own().getByRole('button', { name: 'Health bar' }));
    expect(screen.getByLabelText('Panel colour colour')).toBeTruthy();
    expect(screen.getByText('Recolours the whole panel: bar, number, cross and scratches, in every health state.')).toBeTruthy();
    fireEvent.click(layer('Teammates').getByRole('button', { name: 'Health bar' }));
    expect(screen.getByLabelText('Panel colour colour')).toBeTruthy();
    expect(screen.getByText('Recolours the bar and the number on every card.')).toBeTruthy();
  });

  it('shows the game colour of the state previewed on an unset health colour, with its three bands', () => {
    render(<Hud />);
    fireEvent.click(layer('Teammates').getByRole('button', { name: 'Health bar' }));
    const swatch = () => (screen.getByLabelText('Panel colour colour') as HTMLInputElement).value;
    const lit = () => screen.getByLabelText("The game's health colours").querySelector('.hud__band--on')!.textContent;
    expect(screen.getByLabelText("The game's health colours").querySelectorAll('li')).toHaveLength(3);
    expect([swatch(), lit()]).toEqual(['#0ab132', 'Above 50']);
    fireEvent.click(screen.getByRole('tab', { name: 'Hurt' }));
    expect([swatch(), lit()]).toEqual(['#d8920c', '16 to 50']);
    fireEvent.click(screen.getByRole('tab', { name: 'Down' }));
    expect([swatch(), lit()]).toEqual(['#a11919', '15 or less, or down']);
  });

  it('offers the Inset on your health bar and on the teammate bar, and saves it (probe Q3)', async () => {
    // /home/volence/l4d/hud/probe-phase2/RESULTS.md Q3: inset 3 moves the fill 6 px inside the outline (b1v2 a).
    render(<Hud />);
    fireEvent.click(own().getByRole('button', { name: 'Health bar' }));
    expect((screen.getByLabelText('Inset') as HTMLInputElement).max).toBe('4');
    fireEvent.click(layer('Teammates').getByRole('button', { name: 'Health bar' }));
    const inset = screen.getByLabelText('Inset') as HTMLInputElement;
    expect(inset.max).toBe('3');                                        // stock card bar 7 tall (review L1)
    fireEvent.input(inset, { target: { value: '3' } });
    fireEvent.blur(inset);
    await waitFor(() => expect(saved().children?.teamColumn?.Health?.keys?.inset).toBe('3'));
  });

  it('shows the inset and Panel colour the game draws, and puts one key back to the file\'s value (review M2)', async () => {
    render(<Hud />);
    fireEvent.click(own().getByRole('button', { name: 'Health bar' }));
    // Neither the design nor the file sets them: the game draws inset 2 and the health colour.
    expect((screen.getByLabelText('Inset') as HTMLInputElement).value).toBe('2');
    expect(screen.getByText('Panel colour: Game colour (by health)')).toBeTruthy();
    expect(screen.queryByLabelText('Panel colour opacity')).toBeNull();   // no opacity to write white with
    expect(screen.queryByRole('button', { name: /use the file's value/ })).toBeNull();
    fireEvent.input(screen.getByLabelText('Panel colour colour'), { target: { value: '#ff00ff' } });
    await waitFor(() => expect(saved().children?.ownHealth?.Health?.keys?.monochrome_color).toBe('255 0 255 255'));
    expect(screen.getByLabelText('Panel colour opacity')).toBeTruthy();
    const inset = screen.getByLabelText('Inset') as HTMLInputElement;
    fireEvent.input(inset, { target: { value: '3' } });
    fireEvent.blur(inset);
    await waitFor(() => expect(saved().children?.ownHealth?.Health?.keys?.inset).toBe('3'));
    fireEvent.click(screen.getByRole('button', { name: "Panel colour: use the file's value" }));
    await waitFor(() => expect(saved().children?.ownHealth?.Health?.keys).toEqual({ inset: '3' }));
    expect(screen.getByText('Panel colour: Game colour (by health)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: "Inset: use the file's value" }));
    await waitFor(() => expect(saved().children?.ownHealth?.Health).toBeUndefined());
    expect((screen.getByLabelText('Inset') as HTMLInputElement).value).toBe('2');
  });

  it('draws your health number in the Panel colour once it is set', async () => {
    _resetAssetCache();
    _setImageFactory((url) => ({ src: url, complete: true, naturalWidth: 64, naturalHeight: 64, onload: null, onerror: null }) as unknown as HTMLImageElement);
    const texts: { s: string; fill: string }[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      const canvas = this;
      const state: Record<string | symbol, unknown> = { fillStyle: '' };
      return new Proxy(state, {
        get: (t, k) => {
          if (k === 'canvas') return canvas;
          if (k in t) return t[k];
          return (...a: unknown[]) => {
            if (k === 'fillText') texts.push({ s: a[0] as string, fill: String(t.fillStyle) });
            if (k === 'getImageData') return { data: new Uint8ClampedArray(4) };
            if (k === 'measureText') return { width: 10 };
            if (k === 'createLinearGradient' || k === 'createRadialGradient') return { addColorStop() {} };
            return undefined;
          };
        },
        set: (t, k, v) => { t[k] = v; return true; },
      }) as never;
    } as never);
    render(<Hud />);
    expect(texts.filter((t) => t.s === '100').at(-1)!.fill).toBe('rgba(10,177,50,1)');
    fireEvent.click(own().getByRole('button', { name: 'Health bar' }));
    fireEvent.input(screen.getByLabelText('Panel colour colour'), { target: { value: '#ff00ff' } });
    await waitFor(() => expect(texts.filter((t) => t.s === '100').at(-1)!.fill).toBe('rgba(255,0,255,1)'));
  });

  it('offers the crouch icon tint and saves it as the piece colour (probe Q8)', async () => {
    // /home/volence/l4d/hud/probe-phase2/b1v2/shots/crops/ownbig-b.png: a magenta drawColor held, shown only crouched.
    render(<Hud />);
    fireEvent.click(own().getByRole('button', { name: 'Crouch icon' }));
    fireEvent.input(screen.getByLabelText('Crouch icon tint'), { target: { value: '#ff00ff' } });
    await waitFor(() => expect(saved().children?.ownHealth?.DuckingIcon?.color).toMatch(/^255 0 255 /));
  });

  it('never offers the health cross a colour, whatever gate is open: probe Q5 showed the game ignores it', () => {
    // Plumbing Task 16 asked for a Colour control here once Q5 passed; Q5 failed (slice 2.F G4), so it never shows.
    for (const id of ['Q1', 'Q2', 'Q3', 'Q8'] as const) _setProbe(id, true);
    render(<Hud />);
    fireEvent.click(own().getByRole('button', { name: 'Health cross' }));
    expect(screen.getByLabelText('Text size')).toBeTruthy();
    expect(screen.queryByLabelText('Health cross colour')).toBeNull();
    expect(screen.getByText("The game colours this with the panel's health colour, or the Panel colour when one is set.")).toBeTruthy();
  });

  it('offers Fit only once probe Q2 passes, and fitting moves nothing on the canvas', async () => {
    _setProbe('Q2', false);
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Your health' }));
    expect(screen.queryByLabelText('Fit the panel to its contents')).toBeNull();
    cleanup();
    _setProbe('Q2', null);                                           // passed (slice 2.F G2)
    // A design saved before the own panel fitted by default, so the toggle starts off.
    localStorage.setItem('hud', JSON.stringify({ v: 1, crosshair: 'none', elements: { teamColumn: { fit: true } } }));
    const { texts } = recordDraws();
    const { container } = render(<Hud />);
    unitCanvas(container);
    fireEvent.click(screen.getByRole('button', { name: 'Your health' }));
    const number = () => texts.filter((t) => t.s === '100').at(-1)!;
    const before = number();
    const fit = screen.getByLabelText('Fit the panel to its contents') as HTMLInputElement;
    expect(fit.checked).toBe(false);
    fireEvent.click(fit);
    await waitFor(() => expect(saved().elements?.ownHealth?.fit).toBe(true));
    expect((screen.getByLabelText('Fit the panel to its contents') as HTMLInputElement).checked).toBe(true);
    const after = number();
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('starts a new design with your own health fitted (probe Q2)', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Your health' }));
    expect((screen.getByLabelText('Fit the panel to its contents') as HTMLInputElement).checked).toBe(true);
  });

  it('drags the Health bar on the canvas, saving its place in the file frame, and offers the piece menu for one panel', async () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    const r = ownBar();
    // A quarter in, clear of the selection's resize handles (the mid-edge ones sit over a thin bar's centre).
    const at: [number, number] = [r.x + r.w / 4, r.y + r.h / 2];
    clickAt(canvas, ...at);
    expect(screen.getByText('Health bar', { selector: 'legend' })).toBeTruthy();
    dragFrom(canvas, at, [at[0] + 10, at[1] - 5]);
    const stock = panelChild(validateDesign({ v: 1 }), 'ownHealth', 'Health')!;
    await waitFor(() => expect(saved().children?.ownHealth?.Health).toMatchObject({ x: stock.x + 10, y: stock.y - 5 }));
    fireEvent.contextMenu(canvas, { clientX: at[0] + 10, clientY: at[1] - 5 });
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Hide', 'Reset', 'Bring to front', 'Send to back', 'Select Your health']);
  });

  it('lists the scratches as hidden on Modern, which ships them at visible 0, and their Visible box off', async () => {
    render(<Hud />);
    fireEvent.change(screen.getByRole('combobox', { name: /preset/i }), { target: { value: 'modern' } });
    await waitFor(() => expect(own().getByRole('button', { name: 'Scratches, top' }).closest('.hud__layer')!.classList.contains('hud__layer--hidden')).toBe(true));
    expect(own().getByRole('button', { name: 'Scratches, bottom' }).closest('.hud__layer')!.classList.contains('hud__layer--hidden')).toBe(true);
    fireEvent.click(own().getByRole('button', { name: 'Scratches, top' }));
    expect((screen.getByLabelText('Visible') as HTMLInputElement).checked).toBe(false);
  });
});

describe('Your infected health on the page', () => {
  const saved = () => JSON.parse(localStorage.getItem('hud') ?? '{}') as HudDesign;
  const si = () => layer('Your infected health');
  const toInfected = () => fireEvent.click(screen.getByRole('tab', { name: 'Infected' }));

  it('offers the class, Alive / Ghost / Dead and Crouched on the infected side only', () => {
    render(<Hud />);
    const infectedOnly = ['Hunter', 'Smoker', 'Boomer', 'Tank', 'Alive', 'Ghost'];
    for (const name of infectedOnly) expect(screen.queryByRole('tab', { name }), name).toBeNull();
    toInfected();
    for (const name of [...infectedOnly, 'Dead']) expect(screen.getByRole('tab', { name }), name).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Hunter' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Alive' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: 'Crouched' })).toBeTruthy();
    for (const name of ['Healthy', 'Hurt']) expect(screen.queryByRole('tab', { name }), name).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Tank' }));
    expect(screen.getByRole('tab', { name: 'Tank' }).getAttribute('aria-selected')).toBe('true');
  });

  it('lists its pieces in Layers', () => {
    render(<Hud />);
    toInfected();
    for (const label of ['Frame', 'Health bar', 'Health number', 'Crouch icon']) expect(si().getByRole('button', { name: label }), label).toBeTruthy();
    expect(si().getByText('shown when crouched')).toBeTruthy();
  });

  it('offers Fit, and a fitted panel keeps its X where it is drawn', async () => {
    render(<Hud />);
    toInfected();
    fireEvent.click(screen.getByRole('button', { name: 'Your infected health' }));
    const x = () => (screen.getByLabelText('X') as HTMLInputElement).value;
    const fit = () => screen.getByLabelText('Fit the panel to its contents') as HTMLInputElement;
    expect(fit().checked).toBe(false);
    fireEvent.click(fit());
    await waitFor(() => expect(saved().elements?.siHealth?.fit).toBe(true));
    const d = saved();
    const drawn = elementRect(validateDesign(d), 'siHealth', d.aspect ?? '16:9');
    expect(Math.round(drawn.x)).toBe(Number(x()));
    fireEvent.input(screen.getByLabelText('X'), { target: { value: String(Number(x()) - 20) } });
    await waitFor(() => expect(Math.round(elementRect(validateDesign(saved()), 'siHealth', '16:9').x)).toBe(Math.round(drawn.x) - 20));
  });

  it('drags the Boomer\'s bar on the canvas and stores the move in the Hunter\'s frame', async () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    toInfected();
    fireEvent.click(screen.getByRole('tab', { name: 'Boomer' }));
    const r = elementRect(validateDesign({ v: 1 }), 'siHealth', '16:9');
    // The Boomer's bar is 322..386 by 69..82: a quarter in, clear of the handles.
    const at: [number, number] = [r.x + 338, r.y + 75.5];
    clickAt(canvas, ...at);
    expect(screen.getByText('Health bar', { selector: 'legend' })).toBeTruthy();
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('322');
    dragFrom(canvas, at, [at[0] + 10, at[1]]);
    await waitFor(() => expect(saved().children?.siHealth?.Health).toMatchObject({ x: 262 }));
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('332');
    fireEvent.input(screen.getByLabelText('W'), { target: { value: '74' } });
    await waitFor(() => expect(saved().children?.siHealth?.Health?.w).toBe(132 + Math.round(10 * 132 / 64)));
  });
});

describe('The ability timer on the page', () => {
  const saved = () => JSON.parse(localStorage.getItem('hud') ?? '{}') as HudDesign;
  it('shows the three state colours from the file, writes a pick, and lists its pieces', async () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('tab', { name: 'Infected' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ability timer' }));
    expect(screen.getAllByLabelText('Scale').length).toBeGreaterThan(0);
    const ready = screen.getByLabelText('Ready colour colour') as HTMLInputElement;
    expect(ready.value).toBe('#ffffff');
    expect((screen.getByLabelText('Charging colour colour') as HTMLInputElement).value).toBe('#7f7f7f');
    expect(screen.getByText('Rarely shown: no probe produced the suppressed state.')).toBeTruthy();
    fireEvent.input(ready, { target: { value: '#ff00ff' } });
    await waitFor(() => expect(saved().elements?.abilityRing?.keys?.ability_ready_color).toBe('255 0 255 255'));
    fireEvent.click(screen.getByRole('button', { name: "Ready colour: use the file's value" }));
    await waitFor(() => expect(saved().elements?.abilityRing?.keys).toBeUndefined());
    for (const label of ['Backdrop', 'Class icon', 'Recharge meter']) expect(layer('Ability timer').getByRole('button', { name: label }), label).toBeTruthy();
  });

  it('previews Ready, Not ready or Recharging, and says when a Hunter is which', () => {
    // Probe Q15 (/home/volence/l4d/hud/probe-phase2-infected/RESULTS.md): a standing Hunter is in the
    // charging colour with no lit meter (b10/shots/crops/ring-b.png), crouched it is ready; the meter
    // refills from 12 o'clock after an ability is used (progress-f-zoom.png).
    render(<Hud />);
    expect(screen.queryByRole('tab', { name: 'Ready' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Infected' }));
    expect(screen.getByRole('tab', { name: 'Ready' }).getAttribute('aria-selected')).toBe('true');
    for (const tab of ['Not ready', 'Recharging']) {
      fireEvent.click(screen.getByRole('tab', { name: tab }));
      expect(screen.getByRole('tab', { name: tab }).getAttribute('aria-selected')).toBe('true');
    }
    expect(screen.queryByRole('tab', { name: 'Charging' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ability timer' }));
    expect(screen.getByText('Hunter: not ready while standing (no meter), ready while crouched. After any ability the icon takes the charging colour while the meter refills.')).toBeTruthy();
  });
});

describe('The infected cards on the page (plan Task 13)', () => {
  const saved = () => JSON.parse(localStorage.getItem('hud') ?? '{}') as HudDesign;
  const toInfected = () => fireEvent.click(screen.getByRole('tab', { name: 'Infected' }));

  it('lists Card 1 to 3 under Infected teammates, then the pieces', () => {
    render(<Hud />);
    toInfected();
    const row = layer('Infected teammates');
    for (const label of ['Card 1', 'Card 2', 'Card 3', 'Backdrop', 'Class icon', 'Health bar', 'Name', 'Spawn time']) {
      expect(row.getByRole('button', { name: label }), label).toBeTruthy();
    }
    expect(row.queryByRole('button', { name: 'Card 4' })).toBeNull();
    fireEvent.click(row.getByRole('button', { name: 'Card 2' }));
    expect(screen.getByText('Infected card 2', { selector: 'legend' })).toBeTruthy();
    expect(screen.getByText(/The game places every infected card itself/)).toBeTruthy();
    // Back up to the row from the card.
    fireEvent.click(screen.getByRole('button', { name: 'Select Infected teammates' }));
    expect(screen.getByLabelText('Fit the card to its contents')).toBeTruthy();
  });

  it('says in the row\'s panel that a column is impossible and that bots never get a card', () => {
    render(<Hud />);
    toInfected();
    fireEvent.click(screen.getByRole('button', { name: 'Infected teammates' }));
    expect(screen.getByText('The game lays infected cards in a row; a column is impossible.')).toBeTruthy();
    expect(screen.getByText('The game shows only human teammates here, at most 3 cards; bots never get one.')).toBeTruthy();
  });

  it('nudges the whole row when an infected card is picked', async () => {
    render(<Hud />);
    toInfected();
    fireEvent.click(layer('Infected teammates').getByRole('button', { name: 'Card 2' }));
    fireEvent.keyDown(layer('Infected teammates').getByRole('button', { name: 'Card 2' }), { key: 'ArrowRight' });
    await waitFor(() => expect(saved().elements?.infectedRow).toMatchObject({ x: 1 }));
  });

  it('offers Show yourself on the infected side, a preview of hud_zombieteam_showself 1 and not part of the file', () => {
    render(<Hud />);
    expect(screen.queryByRole('button', { name: 'Show yourself' })).toBeNull();
    toInfected();
    const b = screen.getByRole('button', { name: 'Show yourself' });
    expect(b.getAttribute('aria-pressed')).toBe('false');
    expect(b.getAttribute('title')).toBe('Preview only: the game shows your own card with the console setting hud_zombieteam_showself 1, which is not part of the HUD file.');
    fireEvent.click(b);
    expect(screen.getByRole('button', { name: 'Show yourself' }).getAttribute('aria-pressed')).toBe('true');
    expect(saved().elements?.infectedRow).toBeUndefined();
  });
});

describe('The infected bar colour once Q24 passed (plan Task F1)', () => {
  const saved = () => JSON.parse(localStorage.getItem('hud') ?? '{}') as HudDesign;
  it('offers Bar colour on your infected health\'s bar and the card\'s bar, and writes the pick', async () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('tab', { name: 'Infected' }));
    fireEvent.click(layer('Your infected health').getByRole('button', { name: 'Health bar' }));
    fireEvent.input(screen.getByLabelText('Bar colour colour'), { target: { value: '#ff00ff' } });
    await waitFor(() => expect(saved().children?.siHealth?.Health?.keys?.monochrome_color).toBe('255 0 255 255'));
    fireEvent.click(layer('Infected teammates').getByRole('button', { name: 'Health bar' }));
    fireEvent.input(screen.getByLabelText('Bar colour colour'), { target: { value: '#00ffff' } });
    await waitFor(() => expect(saved().children?.infectedRow?.HealthPanel?.keys?.monochrome_color).toBe('0 255 255 255'));
  });
});

describe('The kill notices on the page (plan tasks K1, K2)', () => {
  const saved = () => JSON.parse(localStorage.getItem('hud') ?? '{}') as HudDesign;
  afterEach(() => { _setProbe('K5', null); });
  it('picks the alignment and the text colour, and keeps the text size hidden while K5 is closed', async () => {
    _setProbe('K5', false);
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Kill / incap notices' }));
    const align = screen.getByLabelText('Alignment') as HTMLSelectElement;
    expect(align.value).toBe('west');
    expect([...align.options].map((o) => o.textContent)).toEqual(['Left', 'Centre', 'Right']);
    fireEvent.change(align, { target: { value: 'east' } });
    await waitFor(() => expect(saved().elements?.killNotices?.keys?.label_textalign).toBe('east'));
    const colour = screen.getByLabelText('Text colour colour') as HTMLInputElement;
    expect(colour.value).toBe('#f60505');                       // the stock row's red
    fireEvent.input(colour, { target: { value: '#00ffff' } });
    await waitFor(() => expect(saved().elements?.killNotices?.color).toBe('0 255 255 255'));
    expect(screen.queryByLabelText('Text size')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Text colour: use the game colour' }));
    await waitFor(() => expect(saved().elements?.killNotices?.color).toBeUndefined());
  });
});

describe('The kill notice text size on the page (gate K5 passed, V1a)', () => {
  const saved = () => JSON.parse(localStorage.getItem('hud') ?? '{}') as HudDesign;
  it('offers the text size and saves it', async () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Kill / incap notices' }));
    const size = screen.getByRole('slider', { name: 'Text size' }) as HTMLInputElement;
    expect(size.value).toBe('12');                               // recordlabel0's Default font
    fireEvent.input(size, { target: { value: '24' } });
    await waitFor(() => expect(saved().elements?.killNotices?.fontSize).toBe(24));
  });
});

describe('The kill notice box on the page (plan task K2)', () => {
  const saved = () => JSON.parse(localStorage.getItem('hud') ?? '{}') as HudDesign;
  it('switches the box between the game art, a flat colour and none', async () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Kill / incap notices' }));
    const box = screen.getByLabelText('Notice box') as HTMLSelectElement;
    expect(box.value).toBe('stock');
    expect([...box.options].map((o) => o.textContent)).toEqual(['Game art', 'Flat colour', 'None']);
    fireEvent.change(box, { target: { value: 'flat' } });
    await waitFor(() => expect(saved().elements?.killNotices?.noticeBox).toEqual({ kind: 'flat' }));
    fireEvent.input(screen.getByLabelText('Box colour colour'), { target: { value: '#0000ff' } });
    await waitFor(() => expect(saved().elements?.killNotices?.noticeBox).toEqual({ kind: 'flat', color: '0 0 255 160' }));
    fireEvent.change(screen.getByLabelText('Notice box'), { target: { value: 'none' } });
    await waitFor(() => expect(saved().elements?.killNotices?.noticeBox).toEqual({ kind: 'none' }));
    expect(screen.queryByLabelText('Box colour colour')).toBeNull();
    fireEvent.change(screen.getByLabelText('Notice box'), { target: { value: 'stock' } });
    await waitFor(() => expect(saved().elements?.killNotices).toBeUndefined());
  });
});

describe('The chat text size on the page (plan task C1)', () => {
  const saved = () => JSON.parse(localStorage.getItem('hud') ?? '{}') as HudDesign;
  it('shows the ChatFont size from the file, writes a new one, and offers no box colour while C2 is closed', async () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    const size = screen.getByRole('slider', { name: 'Text size' }) as HTMLInputElement;
    expect(size.value).toBe('12');
    fireEvent.input(size, { target: { value: '20' } });
    await waitFor(() => expect(saved().elements?.chat?.fontSize).toBe(20));
    expect(screen.getByText("Sizes the chat's lines at every screen size, from this size at 480 lines.")).toBeTruthy();
    expect(screen.queryByLabelText('Box colour colour')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Text size: use the game size' }));
    await waitFor(() => expect(saved().elements?.chat?.fontSize).toBeUndefined());
  });
});

describe('The item pickup animation switch (plan task M3)', () => {
  const saved = () => JSON.parse(localStorage.getItem('hud') ?? '{}') as HudDesign;
  it('sits with the weapons and stores only the off state', async () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Weapons' }));
    const box = screen.getByRole('checkbox', { name: 'Item pickup animation' }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(saved().pickupFlyIn).toBe(false));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Item pickup animation' }));
    await waitFor(() => expect(saved().pickupFlyIn).toBeUndefined());
  });
});

describe('The use bar pieces on the page (plan task U1)', () => {
  const saved = () => JSON.parse(localStorage.getItem('hud') ?? '{}') as HudDesign;
  it('edits the label colour, the icon size and the bar colours from Layers', async () => {
    render(<Hud />);
    fireEvent.click(layer('Use / revive bar').getByRole('button', { name: 'Label' }));
    fireEvent.input(screen.getByLabelText('Label colour'), { target: { value: '#ff00ff' } });
    await waitFor(() => expect(saved().children?.progressBar?.BarLabel?.color).toBe('255 0 255 255'));
    fireEvent.click(layer('Use / revive bar').getByRole('button', { name: 'Icon' }));
    expect(screen.getByText('The game picks healing or reviving.')).toBeTruthy();
    fireEvent.click(layer('Use / revive bar').getByRole('button', { name: 'Bar' }));
    fireEvent.input(screen.getByLabelText('Fill colour colour'), { target: { value: '#00ff00' } });
    await waitFor(() => expect(saved().children?.progressBar?.Bar?.keys?.fill_color).toBe('0 255 0 255'));
  });
});

describe('The spawn and too-far panels on the page (plan tasks G1, Z2)', () => {
  const saved = () => JSON.parse(localStorage.getItem('hud') ?? '{}') as HudDesign;
  it('colours the spawn panel\'s text from the panel and lists its lines with no colour of their own', async () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('tab', { name: 'Infected' }));
    fireEvent.click(layer('Spawn / ghost panel').getByRole('button', { name: 'Spawn / ghost panel' }));
    fireEvent.input(screen.getByLabelText('Text colour colour'), { target: { value: '#00ffff' } });
    await waitFor(() => expect(saved().elements?.ghostPanel?.keys?.WhiteText).toBe('0 255 255 255'));
    fireEvent.click(layer('Spawn / ghost panel').getByRole('button', { name: 'Title' }));
    expect(screen.queryByLabelText('Title colour')).toBeNull();
  });

  it('edits the too-far title colour and lists no Tank offer piece while its probe is closed', async () => {
    _setProbe('Z3', false);
    render(<Hud />);
    fireEvent.click(screen.getByRole('tab', { name: 'Infected' }));
    const row = layer('Too far / Tank offer');
    expect(row.queryByRole('button', { name: 'Tank offer title' })).toBeNull();
    fireEvent.click(row.getByRole('button', { name: 'Title' }));
    fireEvent.input(screen.getByLabelText('Title colour'), { target: { value: '#ff00ff' } });
    await waitFor(() => expect(saved().children?.zombiePanel?.['TooFarFromSurvivors/TooFarTitle']?.color).toBe('255 0 255 255'));
    _setProbe('Z3', null);
  });

  it('edits the Tank offer title colour now that Z3 passed (V1b)', async () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('tab', { name: 'Infected' }));
    fireEvent.click(layer('Too far / Tank offer').getByRole('button', { name: 'Tank offer title' }));
    expect(screen.getByText(/^Shown when you are offered the Tank\./)).toBeTruthy();
    expect(screen.getByText('The preview draws the too-far box only, so this shows in the game, not on the canvas.')).toBeTruthy();
    fireEvent.input(screen.getByLabelText('Tank offer title colour'), { target: { value: '#ff00ff' } });
    await waitFor(() => expect(saved().children?.zombiePanel?.['TankTakeover/Title']?.color).toBe('255 0 255 255'));
  });
});

describe('The spawn countdown on the page (plan task M4)', () => {
  const saved = () => JSON.parse(localStorage.getItem('hud') ?? '{}') as HudDesign;
  it('colours and sizes the countdown line', async () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('tab', { name: 'Infected' }));
    fireEvent.click(layer('Spawn countdown').getByRole('button', { name: 'Spawn countdown' }));
    fireEvent.input(screen.getByLabelText('Countdown colour colour'), { target: { value: '#ff00ff' } });
    await waitFor(() => expect(saved().elements?.spawnCountdown?.color).toBe('255 0 255 255'));
    expect(screen.getByText('"You will enter Spawn Mode in N seconds", shown while you are dead. "YOU ARE DEAD" moves and hides with it.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Countdown colour: use the file colour' }));
    await waitFor(() => expect(saved().elements?.spawnCountdown?.color).toBeUndefined());
  });
});

describe('The occasional panels on the page (plan task M1)', () => {
  const saved = () => JSON.parse(localStorage.getItem('hud') ?? '{}') as HudDesign;
  it('toggles the occasional panels on both sides, a preview choice that is not part of the file', () => {
    render(<Hud />);
    const b = screen.getByRole('button', { name: 'Occasional panels' });
    expect(b.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(b);
    expect(screen.getByRole('button', { name: 'Occasional panels' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Infected' }));
    expect(screen.getByRole('button', { name: 'Occasional panels' }).getAttribute('aria-pressed')).toBe('true');
    expect(saved().elements?.vote).toBeUndefined();
  });

  it('says when the game shows the vote, and colours its box', async () => {
    render(<Hud />);
    fireEvent.click(layer('Vote').getByRole('button', { name: 'Vote' }));
    expect(screen.getByText('Shown while a vote runs (someone called one from the Esc menu or the console).')).toBeTruthy();
    fireEvent.input(screen.getByLabelText('Box colour colour'), { target: { value: '#800080' } });
    await waitFor(() => expect(saved().elements?.vote?.bg).toMatch(/^128 0 128 \d+$/));
    fireEvent.click(screen.getByRole('button', { name: 'Box colour: use the file colour' }));
    await waitFor(() => expect(saved().elements?.vote?.bg).toBeUndefined());
  });

  it('lists the survival timer on the survivor side only, with its note', () => {
    render(<Hud />);
    fireEvent.click(layer('Survival timer').getByRole('button', { name: 'Survival timer' }));
    expect(screen.getByText('Survival only: the round time and the next medal. Never shown in campaign or versus.')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Infected' }));
    expect(screen.queryByRole('group', { name: 'Layers: Survival timer' })).toBeNull();
  });
});

describe('The panels seen only with other players on the page (plan task M2)', () => {
  const saved = () => JSON.parse(localStorage.getItem('hud') ?? '{}') as HudDesign;
  it('offers only Y on the peril notice, with its note', async () => {
    render(<Hud />);
    fireEvent.click(layer('Teammate in trouble').getByRole('button', { name: 'Teammate in trouble' }));
    expect(screen.queryByLabelText('X')).toBeNull();
    expect(screen.getByText(/^Shown when a teammate hangs from a ledge; not seen in our tests/)).toBeTruthy();
    fireEvent.input(screen.getByLabelText('Y'), { target: { value: '90' } });
    await waitFor(() => expect(saved().elements?.perilNotice).toEqual({ y: 90 }));
  });

  afterEach(() => { _setProbe('P2', null); });
  it('offers the voice list move and hide only while gate P2 is closed (decision 3)', () => {
    render(<Hud />);
    fireEvent.click(layer('Voice list').getByRole('button', { name: 'Voice list' }));
    expect(screen.getByText(/^Lists the other players while they talk; not seen in our tests/)).toBeTruthy();
    expect(screen.queryByLabelText('Row height')).toBeNull();
    expect(screen.getByLabelText('Y')).toBeTruthy();
  });

  it('edits the voice list row height with P2 open', async () => {
    _setProbe('P2', true);
    render(<Hud />);
    fireEvent.click(layer('Voice list').getByRole('button', { name: 'Voice list' }));
    fireEvent.input(screen.getByLabelText('Row height'), { target: { value: '30' } });
    await waitFor(() => expect(saved().elements?.voiceList?.keys?.item_tall).toBe('30'));
  });
});
