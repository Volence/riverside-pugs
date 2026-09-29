import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { _resetAssetCache } from '../hud/render';
import { elementRect } from '../hud/build';
import Hud from './Hud';
import { LayersPanel } from './hud/LayersPanel';
import { ElementControls } from './hud/ContextPanel';
import { registerImport, unregisterImport, baseFile } from '../hud/base';
import { sampleHud } from '../hud/importFixtures';
import { validateDesign, DEFAULT_DESIGN, type HudDesign } from '../hud/design';
import { setupHudTests, layer, unitCanvas, dragFrom } from './hudTestKit';

setupHudTests();

describe('Your items on the page', () => {
  const saved = () => JSON.parse(localStorage.getItem('hud') ?? '{}') as HudDesign;
  const OWN = 'resource/ui/hud/localplayerpanel.res';

  /**
   * A canvas context that records what the page draws: every fillText, and
   * each pink snap guide (mock.ts drawGuides: strokeStyle #ff4fa3, one
   * moveTo and lineTo per guide) as its axis and place in canvas pixels.
   */
  const recordCanvas = () => {
    _resetAssetCache();
    const texts: string[] = [];
    const guides: { axis: 'x' | 'y'; at: number }[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      const canvas = this;
      let stroke: unknown = '';
      const stack: unknown[] = [];
      let from: [number, number] | null = null;
      return new Proxy({}, {
        get: (_t, k) => {
          if (k === 'canvas') return canvas;
          if (k === 'strokeStyle') return stroke;
          return (...a: unknown[]) => {
            if (k === 'fillText') texts.push(a[0] as string);
            if (k === 'save') stack.push(stroke);
            if (k === 'restore') stroke = stack.pop() ?? '';
            if (k === 'moveTo') from = [a[0] as number, a[1] as number];
            if (k === 'lineTo' && stroke === '#ff4fa3' && from) {
              guides.push(from[0] === a[0] ? { axis: 'x', at: from[0] } : { axis: 'y', at: from[1] });
            }
            if (k === 'getImageData') return { data: new Uint8ClampedArray(4) };
            if (k === 'measureText') return { width: 10 };
            if (k === 'createLinearGradient' || k === 'createRadialGradient') return { addColorStop() {} };
            return undefined;
          };
        },
        set: (_t, k, v) => { if (k === 'strokeStyle') stroke = v; return true; },
      }) as never;
    } as never);
    return { texts, guides };
  };

  it('turns on from the Layers eye with the item slots, and one Undo takes both back', async () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Show Your items' }));
    await waitFor(() => expect(saved().elements?.yourItems?.visible).toBe(true));
    expect(saved().weapons).toMatchObject({ itemSize: 0, itemIcons: false });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(saved().elements?.yourItems?.visible).not.toBe(true));
    expect(saved().weapons?.itemSize).toBeUndefined();
    expect(saved().weapons?.itemIcons).toBeUndefined();
  });

  it('turns off from the Layers eye, Delete and Hide, each leaving the item slot settings alone', async () => {
    const { container } = render(<Hud />);
    const on = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show Your items' }));
      await waitFor(() => expect(saved().elements?.yourItems?.visible).toBe(true));
    };
    const offKept = async () => {
      await waitFor(() => expect(saved().elements?.yourItems?.visible).toBe(false));
      expect(saved().weapons).toMatchObject({ itemSize: 0, itemIcons: false });
    };
    await on();
    fireEvent.click(screen.getByRole('button', { name: 'Hide Your items' }));
    await offKept();

    await on();
    fireEvent.click(screen.getByRole('button', { name: 'Your items' }));
    fireEvent.keyDown(unitCanvas(container), { key: 'Delete' });
    await offKept();

    await on();
    fireEvent.contextMenu(unitCanvas(container), { clientX: 821, clientY: 242 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }));
    await offKept();
  });

  it('turns on and off from the Visible box too, the same one edit', async () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Your items' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Visible' }));
    await waitFor(() => expect(saved().elements?.yourItems?.visible).toBe(true));
    expect(saved().weapons).toMatchObject({ itemSize: 0, itemIcons: false });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Visible' }));
    await waitFor(() => expect(saved().elements?.yourItems?.visible).toBe(false));
    expect(saved().weapons).toMatchObject({ itemSize: 0, itemIcons: false });
  });

  it('shows its controls, and a typed X stops at your health bar\'s edge', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Show Your items' }));
    fireEvent.click(screen.getByRole('button', { name: 'Your items' }));
    expect(screen.getByText(/only sit level with or right of your health bar/)).toBeTruthy();
    expect((screen.getByRole('combobox', { name: 'Icon size' }) as HTMLSelectElement).value).toBe('L4D_Icons_medium');
    expect((screen.getByRole('combobox', { name: 'Alignment' }) as HTMLSelectElement).value).toBe('right');
    const x = screen.getByLabelText('X') as HTMLInputElement;
    expect(x.value).toBe('805');
    fireEvent.input(x, { target: { value: '600' } });
    fireEvent.blur(x);
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('754');
  });

  it('changes the font, the alignment and the colour, and the colour goes back to the game\'s', async () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Show Your items' }));
    fireEvent.click(screen.getByRole('button', { name: 'Your items' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Icon size' }), { target: { value: 'L4D_Icons_large' } });
    await waitFor(() => expect(saved().elements?.yourItems?.itemFont).toBe('L4D_Icons_large'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Alignment' }), { target: { value: 'center' } });
    await waitFor(() => expect(saved().elements?.yourItems?.itemAlign).toBe('center'));
    expect(screen.queryByRole('button', { name: 'Icons colour: use the game colour' })).toBeNull();
    fireEvent.input(screen.getByLabelText('Icons colour'), { target: { value: '#ff0000' } });
    await waitFor(() => expect(saved().elements?.yourItems?.color).toBe('255 0 0 255'));
    fireEvent.click(screen.getByRole('button', { name: 'Icons colour: use the game colour' }));
    await waitFor(() => expect(saved().elements?.yourItems?.color).toBeUndefined());
  });

  it('holds a drag at the line: the row stops while the pointer keeps going', async () => {
    const { container } = render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Show Your items' }));
    const canvas = unitCanvas(container);
    dragFrom(canvas, [821, 242], [500, 250]);
    await waitFor(() => expect(saved().elements?.yourItems).toMatchObject({ x: 754, y: 241 }));
  });

  // Snapping on (no Alt). The row starts drawn at x 805.35, 39.65 wide, 18 tall.
  describe('snap guides while it is dragged', () => {
    /** The row's drawn lines along an axis, from the design as saved. */
    const drawnLines = (axis: 'x' | 'y') => {
      const r = elementRect(validateDesign(saved()), 'yourItems', DEFAULT_DESIGN.aspect);
      return axis === 'x' ? [r.x, r.x + r.w / 2, r.x + r.w] : [r.y, r.y + r.h / 2, r.y + r.h];
    };
    const expectOnRow = (guides: { axis: 'x' | 'y'; at: number }[], k: number) => {
      for (const g of guides) {
        expect(drawnLines(g.axis).some((l) => Math.abs(l - g.at / k) < 0.01), `${g.axis} guide at ${g.at / k}`).toBe(true);
      }
    };

    it('draws no guide where the row is held from', async () => {
      const rec = recordCanvas();
      const { container } = render(<Hud />);
      fireEvent.click(screen.getByRole('button', { name: 'Show Your items' }));
      const canvas = unitCanvas(container);
      await waitFor(() => expect(rec.texts.length).toBeGreaterThan(0));
      // Asked 69 left, the row (its left edge at 736.35) is past the bar's edge, so it is held at 754: no x guide may
      // show where it was asked, such as the pistol icon's right edge at 752.
      fireEvent.pointerDown(canvas, { clientX: 821, clientY: 242, pointerId: 1 });
      rec.guides.length = 0;
      fireEvent.pointerMove(canvas, { clientX: 752, clientY: 242, pointerId: 1 });
      await waitFor(() => expect(saved().elements?.yourItems?.x).toBe(754));
      const k = canvas.height / 480;
      expect(rec.guides.filter((g) => g.axis === 'x' && Math.abs(g.at / k - 752) < 0.01)).toEqual([]);
      expectOnRow(rec.guides, k);
      fireEvent.pointerUp(canvas, { clientX: 752, clientY: 242, pointerId: 1 });
    });

    it('draws a guide only on the row as drawn, never half a unit off it', async () => {
      const rec = recordCanvas();
      const { container } = render(<Hud />);
      fireEvent.click(screen.getByRole('button', { name: 'Show Your items' }));
      const canvas = unitCanvas(container);
      await waitFor(() => expect(rec.texts.length).toBeGreaterThan(0));
      // Asked 10 left, the row's left edge (795.35) snaps to 793, a centre line; the row is drawn at 793.35.
      // Its bottom (251) snaps to 250, which the drawn row does reach: that guide stays.
      fireEvent.pointerDown(canvas, { clientX: 821, clientY: 242, pointerId: 1 });
      rec.guides.length = 0;
      fireEvent.pointerMove(canvas, { clientX: 811, clientY: 242, pointerId: 1 });
      await waitFor(() => expect(saved().elements?.yourItems).toMatchObject({ x: 793, y: 232 }));
      const k = canvas.height / 480;
      expect(rec.guides.some((g) => g.axis === 'y' && Math.abs(g.at / k - 250) < 0.01)).toBe(true);
      expect(rec.guides.filter((g) => g.axis === 'x' && Math.abs(g.at / k - 793) < 0.01)).toEqual([]);
      expectOnRow(rec.guides, k);
      fireEvent.pointerUp(canvas, { clientX: 811, clientY: 242, pointerId: 1 });
    });
  });

  it('draws the limit only while the row is selected', async () => {
    const { texts } = recordCanvas();
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Show Your items' }));
    await waitFor(() => expect(texts.length).toBeGreaterThan(0));
    expect(texts).not.toContain("Your health bar's edge");
    fireEvent.click(screen.getByRole('button', { name: 'Your items' }));
    await waitFor(() => expect(texts).toContain("Your health bar's edge"));
    texts.length = 0;
    fireEvent.click(screen.getByRole('button', { name: 'Weapons' }));
    await waitFor(() => expect(texts.length).toBeGreaterThan(0));
    expect(texts).not.toContain("Your health bar's edge");
  });

  describe('on an import that places its own items', () => {
    const ID = 'e'.repeat(64);
    afterEach(() => { unregisterImport(ID); });
    const blockedDesign = () => {
      const own = baseFile('stock', OWN).replace(/\}\s*$/, '\t"Items"\r\n\t{\r\n\t\t"ControlName"\t"Label"\r\n\t\t"fieldName"\t"Items"\r\n\t\t"xpos"\t"26"\r\n\t}\r\n}\r\n');
      registerImport(ID, sampleHud({ [OWN]: own }));
      return validateDesign({ v: 1, preset: 'imported', imported: { id: ID, name: 'x' } });
    };
    it('lists it in Layers with the note and no eye', () => {
      render(<LayersPanel design={blockedDesign()} side="survivor" sel={{ kind: 'none' }} onPick={() => {}} onVisible={() => {}} onAdd={() => {}} onKeyDown={() => {}} />);
      const row = layer('Your items');
      expect(row.getByText('This HUD already places your items itself.')).toBeTruthy();
      expect(row.queryByRole('button', { name: 'Show Your items' })).toBeNull();
    });
    it('offers no controls but the note', () => {
      render(<ElementControls design={blockedDesign()} edit={() => {}} end={() => {}} id="yourItems" />);
      expect(screen.getByText('This HUD already places your items itself.')).toBeTruthy();
      expect(screen.queryByText(/only sit level with or right of your health bar/)).toBeNull();
      expect(screen.queryByRole('checkbox', { name: 'Visible' })).toBeNull();
      expect(screen.queryByLabelText('X')).toBeNull();
      expect(screen.queryByLabelText('Y')).toBeNull();
      expect(screen.queryByRole('combobox', { name: 'Icon size' })).toBeNull();
      expect(screen.queryByRole('combobox', { name: 'Alignment' })).toBeNull();
      expect(screen.queryByLabelText('Icons colour')).toBeNull();
    });
    it('moves nowhere on the page: picked in Layers, an arrow writes no place', async () => {
      localStorage.setItem('hud', JSON.stringify({ ...blockedDesign(), name: 'mine' }));
      render(<Hud />);
      fireEvent.click(layer('Your items').getByRole('button', { name: 'Your items' }));
      expect(screen.getByText('This HUD already places your items itself.', { selector: '.hud__note' })).toBeTruthy();
      fireEvent.keyDown(screen.getByRole('button', { name: 'Your items' }), { key: 'ArrowRight' });
      fireEvent.keyDown(screen.getByRole('button', { name: 'Your items' }), { key: 'ArrowDown', shiftKey: true });
      // Past the page's 300 ms save debounce (Hud.tsx), which a written place would have gone through.
      await new Promise((r) => setTimeout(r, 400));
      const o = saved().elements?.yourItems;
      expect(o?.x).toBeUndefined();
      expect(o?.y).toBeUndefined();
    });
  });
});
