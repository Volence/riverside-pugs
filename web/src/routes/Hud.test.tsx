import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/preact';
import {
  snap, nudge, nudgeCard, toUnits, hasOverrides, elementsTouched, resetElement, withTeamDir, placeCard, patchChild,
  placeChild, nudgeChild, resizeChild,
} from './Hud';
import Hud from './Hud';
import { DEFAULT_DESIGN } from '../hud/design';
import { teamCardRects } from '../hud/build';

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
    expect(nudge(DEFAULT_DESIGN, 'targetId', 5, 5)).toBe(DEFAULT_DESIGN);
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

describe('what counts as an edit', () => {
  // A fresh design already fits the teammate card, so "has elements" is not
  // "has edits": a share link must not ask to replace an untouched design.
  it('treats a fresh design as untouched and a moved element as an edit', () => {
    expect(elementsTouched(DEFAULT_DESIGN)).toBe(false);
    expect(hasOverrides(DEFAULT_DESIGN)).toBe(false);
    const moved = { ...DEFAULT_DESIGN, elements: { ...DEFAULT_DESIGN.elements, chat: { x: 5 } } };
    expect(elementsTouched(moved)).toBe(true);
    expect(hasOverrides({ ...DEFAULT_DESIGN, hideGameCrosshair: true })).toBe(true);
  });

  it('resets an element to what a fresh design has for it', () => {
    const d = { ...DEFAULT_DESIGN, elements: { teamColumn: { gap: 40 }, chat: { x: 5 } } };
    expect(resetElement(d, 'teamColumn').elements.teamColumn).toEqual({ fit: true });
    expect(resetElement(d, 'chat').elements.chat).toBeUndefined();
  });
});

describe('the teammate layout helpers', () => {
  // A slot is the card's unfitted origin: the fitted stock card is drawn
  // (13, 36) in from it, so the card drawn at (13, 441) has its slot at (0, 405).
  it('fills the four Free positions from where the cards sit, only the first time', () => {
    const free = withTeamDir(DEFAULT_DESIGN, 'free');
    expect(free.elements.teamColumn).toEqual({ fit: true, dir: 'free',
      slots: [{ x: 0, y: 405 }, { x: 140, y: 405 }, { x: 280, y: 405 }, { x: 420, y: 405 }] });
    expect(teamCardRects(free, free.aspect)[0]).toMatchObject({ x: 13, y: 441 });
    const moved = placeCard(free, 0, 50, 60);
    expect(withTeamDir(withTeamDir(moved, 'row'), 'free').elements.teamColumn!.slots![0]).toEqual({ x: 37, y: 24 });
  });

  it('places a card by where it is drawn, so the card lands under the pointer fitted or not', () => {
    const free = withTeamDir(DEFAULT_DESIGN, 'free');
    expect(teamCardRects(placeCard(free, 1, 200, 100), free.aspect)[1]).toMatchObject({ x: 200, y: 100 });
    const unfitted = { ...free, elements: { teamColumn: { ...free.elements.teamColumn!, fit: false } } };
    expect(teamCardRects(placeCard(unfitted, 1, 200, 100), free.aspect)[1]).toMatchObject({ x: 200, y: 100 });
  });

  it('clamps a placed card like an element position', () => {
    const free = withTeamDir(DEFAULT_DESIGN, 'free');
    expect(placeCard(free, 2, 5000, -900).elements.teamColumn!.slots![2]).toEqual({ x: 1000, y: -200 });
    expect(placeCard(DEFAULT_DESIGN, 0, 5, 5)).toBe(DEFAULT_DESIGN);           // not Free: nothing to place
  });
});

describe('patchChild', () => {
  it('merges into one child of the teammate card and leaves the rest alone', () => {
    const a = patchChild(DEFAULT_DESIGN, 'Head', { w: 30, h: 30 });
    const b = patchChild(a, 'Head', { x: 5 });
    expect(b.children.teamColumn).toEqual({ Head: { w: 30, h: 30, x: 5 } });
    expect(resetElement(b, 'teamColumn').children.teamColumn).toBeUndefined();
    expect(hasOverrides(b)).toBe(true);
  });
});

describe('moving a teammate card child', () => {
  it('clamps a placed child inside the unfitted card, not the fitted one, or nothing could grow', () => {
    // Stock unfitted card 150 x 150; Head is 23 square.
    expect(placeChild(DEFAULT_DESIGN, 'Head', 500, -20).children.teamColumn!.Head).toEqual({ x: 127, y: 0 });
    expect(placeChild(DEFAULT_DESIGN, 'Head', 40.4, 50.6).children.teamColumn!.Head).toEqual({ x: 40, y: 51 });
  });

  it('nudges from where the child is now', () => {
    expect(nudgeChild(DEFAULT_DESIGN, 'Head', 1, 0).children.teamColumn!.Head).toEqual({ x: 14, y: 38 });
    // The down picture starts where the fit rule drew it: (13, 36) in the unfitted frame.
    expect(nudgeChild(DEFAULT_DESIGN, 'Incapacitated', 0, 1).children.teamColumn!.Incapacitated).toEqual({ x: 13, y: 37 });
  });

  it('resizes square art keeping it square, and anything else freely, inside the card', () => {
    expect(resizeChild(DEFAULT_DESIGN, 'Head', { x: 13, y: 38, w: 23, h: 23 }, 5, 2).children.teamColumn!.Head).toEqual({ w: 28, h: 28 });
    expect(resizeChild(DEFAULT_DESIGN, 'Head', { x: 13, y: 38, w: 23, h: 23 }, 500, 0).children.teamColumn!.Head).toEqual({ w: 112, h: 112 });
    expect(resizeChild(DEFAULT_DESIGN, 'Health', { x: 37, y: 52, w: 96, h: 7 }, -48, 0).children.teamColumn!.Health).toEqual({ w: 48, h: 7 });
    expect(resizeChild(DEFAULT_DESIGN, 'Items', { x: 39, y: 36, w: 50, h: 14 }, 5, 5)).toBe(DEFAULT_DESIGN);
  });
});

describe('nudgeCard', () => {
  it('moves a Free card from its slot and keeps 8 units of it on screen, like a drag', () => {
    const free = withTeamDir(DEFAULT_DESIGN, 'free');
    // The slot is the unfitted origin, 13 left of the drawn card.
    expect(nudgeCard(free, 0, 5, 0).elements.teamColumn!.slots![0]).toEqual({ x: 5, y: 405 });
    let d = free;
    for (let i = 0; i < 200; i++) d = nudgeCard(d, 0, -10, 0);
    expect(teamCardRects(d, d.aspect)[0].x).toBe(8 - 121);
  });

  it('leaves the element position alone in Free, where it moves nothing', () => {
    const free = withTeamDir(DEFAULT_DESIGN, 'free');
    expect(nudge(free, 'teamColumn', 5, 5)).toBe(free);
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

  it('drags a Free teammate card on the canvas', () => {
    const { container } = render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    fireEvent.change(screen.getByRole('combobox', { name: /^Layout/ }), { target: { value: 'free' } });
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    // happy-dom lays nothing out: give the canvas a 1:1 box so client pixels are HUD units.
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 853, height: 480, right: 853, bottom: 480, x: 0, y: 0, toJSON() {} }) as DOMRect;
    // Card 1 sits at (13, 441), 121 x 36. (133, 442) is on the card but on no
    // child (only the splatter, which is decoration), so even with the
    // teammates already selected this grabs the card, not a child.
    fireEvent.pointerDown(canvas, { clientX: 133, clientY: 442, pointerId: 1 });
    expect(screen.getByText('Teammate card 1')).toBeTruthy();
    fireEvent.pointerMove(canvas, { clientX: 233, clientY: 242, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 233, clientY: 242, pointerId: 1 });
    expect((screen.getByLabelText('Card 1 X') as HTMLInputElement).value).toBe('113');
    expect((screen.getByLabelText('Card 1 Y') as HTMLInputElement).value).toBe('241');
  });

  it('in Free, drags an unselected card even over its children, and reaches children only in the selected card', () => {
    const { container } = render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    fireEvent.change(screen.getByRole('combobox', { name: /^Layout/ }), { target: { value: 'free' } });
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 853, height: 480, right: 853, bottom: 480, x: 0, y: 0, toJSON() {} }) as DOMRect;
    // Card 2 sits at (153, 441); (160, 450) is on its portrait. The card is
    // not the selected one, so the press picks and drags the card.
    fireEvent.pointerDown(canvas, { clientX: 160, clientY: 450, pointerId: 1 });
    expect(screen.getByText('Teammate card 2')).toBeTruthy();
    fireEvent.pointerMove(canvas, { clientX: 260, clientY: 250, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 260, clientY: 250, pointerId: 1 });
    expect((screen.getByLabelText('Card 2 X') as HTMLInputElement).value).toBe('253');
    expect((screen.getByLabelText('Card 2 Y') as HTMLInputElement).value).toBe('241');
    // Inside the selected card, the same spot is its portrait.
    fireEvent.pointerDown(canvas, { clientX: 260, clientY: 250, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 260, clientY: 250, pointerId: 1 });
    expect(screen.getByText('Portrait', { selector: 'legend' })).toBeTruthy();
    // A press on another card's portrait picks that card instead.
    fireEvent.pointerDown(canvas, { clientX: 20, clientY: 450, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 20, clientY: 450, pointerId: 1 });
    expect(screen.getByText('Teammate card 1')).toBeTruthy();
    expect(screen.queryByText('Portrait', { selector: 'legend' })).toBeNull();
  });

  it('picks a child inside the selected teammates on the canvas, drags it, and steps back up with Escape', () => {
    const { container } = render(<Hud />);
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 853, height: 480, right: 853, bottom: 480, x: 0, y: 0, toJSON() {} }) as DOMRect;
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    // Card 1 at (13, 441); the fitted Head is (0, 2, 23, 23) inside it, so its centre is (24.5, 454.5).
    fireEvent.pointerDown(canvas, { clientX: 24, clientY: 454, pointerId: 1 });
    expect(screen.getByText('Portrait', { selector: 'legend' })).toBeTruthy();
    fireEvent.pointerMove(canvas, { clientX: 34, clientY: 454, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 34, clientY: 454, pointerId: 1 });
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('23');
    expect((screen.getByLabelText('Y') as HTMLInputElement).value).toBe('38');
    fireEvent.keyDown(canvas, { key: 'ArrowRight' });
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('24');
    fireEvent.keyDown(canvas, { key: 'Escape' });
    expect(screen.getByText('Reset this element')).toBeTruthy();
    fireEvent.keyDown(canvas, { key: 'Escape' });
    expect(screen.getByText(/select an element/i)).toBeTruthy();
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
});
