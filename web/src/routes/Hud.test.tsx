import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { toUnits } from './Hud';
import Hud from './Hud';

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
  it('lists the teammate card children and adds the health number on stock', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    for (const label of ['Portrait', 'Health bar', 'Name', 'Item icons', 'Status text', 'Damage splatter', 'Down picture', 'Dead picture', 'Voice icon']) {
      expect(screen.getByRole('button', { name: label }), label).toBeTruthy();
    }
    expect(screen.queryByRole('button', { name: 'Health number' })).toBeNull();
    const add = screen.getByLabelText('Health number') as HTMLInputElement;
    expect(add.checked).toBe(false);
    fireEvent.click(add);
    expect(screen.getByRole('button', { name: 'Health number' })).toBeTruthy();
    expect(screen.getByText("Edits inside a card apply to every teammate's card.")).toBeTruthy();
  });

  it('steps back to the teammates when the selected child stops existing', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    fireEvent.click(screen.getByLabelText('Health number'));
    fireEvent.click(screen.getByRole('button', { name: 'Health number' }));
    expect(screen.getByText('Reset this child')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Health number'));               // untick it while selected
    expect(screen.getByText('Reset this element')).toBeTruthy();
    // Ticking it again does not bring back the old selection.
    fireEvent.click(screen.getByLabelText('Health number'));
    expect(screen.getByText('Reset this element')).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    fireEvent.click(screen.getByLabelText('Health number'));
    fireEvent.click(screen.getByRole('button', { name: 'Health number' }));
    fireEvent.input(screen.getByLabelText('X'), { target: { value: '90' } });
    fireEvent.click(screen.getByText('Reset this child'));
    // The move is gone and the number is still there: back at the template's x 103.
    expect((screen.getByLabelText('Health number') as HTMLInputElement).checked).toBe(true);
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
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    fireEvent.click(screen.getByLabelText('Health number'));
    fireEvent.click(screen.getByRole('button', { name: 'Health number' }));
    expect(screen.getByText('The game colours this by health.')).toBeTruthy();
    expect(screen.queryByLabelText('Health number colour')).toBeNull();
    expect(screen.getByLabelText('Text size')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(screen.getByLabelText('Name colour')).toBeTruthy();
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
    expect(screen.getByText(/stand-in icons/)).toBeTruthy();
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
    render(<Hud />);
    expect(screen.getByText(/addonlist\.txt/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /advanced mode/i }));
    expect(screen.queryByText(/addonlist\.txt/i)).toBeNull();
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
    fireEvent.keyDown(canvas, { key: 'Escape' });
    expect(screen.getByText('Teammates', { selector: 'legend' })).toBeTruthy();
    fireEvent.keyDown(canvas, { key: 'Escape' });
    expect(screen.getByText(/select an element/i)).toBeTruthy();
  });

  it('picks one level up with Ctrl+click, and from the breadcrumb', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    clickAt(canvas, 24, 454, { ctrlKey: true });
    expect(screen.getByText('Teammates', { selector: 'legend' })).toBeTruthy();
    clickAt(canvas, 24, 454);
    expect(screen.getByText('Portrait', { selector: 'legend' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Up to Teammates' }));
    expect(screen.getByText('Teammates', { selector: 'legend' })).toBeTruthy();
  });

  it('moves the whole team when a drag starts on a piece not yet picked', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    dragFrom(canvas, [24, 454], [24, 404]);
    expect(screen.getByText('Teammates', { selector: 'legend' })).toBeTruthy();
    expect((screen.getByLabelText('Y') as HTMLInputElement).value).toBe('355');
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

  it('in Free, picks a piece of any card in one click, and a drag on another card moves that card', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    fireEvent.change(screen.getByRole('combobox', { name: /^Layout/ }), { target: { value: 'free' } });
    // Card 2 sits at (153, 441); (160, 450) is its portrait.
    clickAt(canvas, 160, 450);
    expect(screen.getByText('Portrait', { selector: 'legend' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Up to Card 2' })).toBeTruthy();
    // (133, 442) is on card 1 but on none of its pieces.
    dragFrom(canvas, [133, 442], [233, 242]);
    // The side panel's own card note arrives with Task 15; the breadcrumb names the card meanwhile.
    expect(screen.getByText('Card 1', { selector: '.hud__crumbs span' })).toBeTruthy();
    expect((screen.getByLabelText('Card 1 X') as HTMLInputElement).value).toBe('113');
    expect((screen.getByLabelText('Card 1 Y') as HTMLInputElement).value).toBe('241');
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
    expect((screen.getByLabelText('Card 1 X') as HTMLInputElement).value).toBe('113');
    undoKey();
    expect((screen.getByLabelText('Card 1 X') as HTMLInputElement).value).toBe('13');
    // The Layout change before it is its own step.
    undoKey();
    expect(screen.queryByLabelText('Card 1 X')).toBeNull();
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
});
