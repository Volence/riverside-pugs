import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { _setImageFactory, _resetAssetCache, childRects } from '../hud/render';
import { panelBoxes } from '../hud/mock';
import { _setProbe } from '../hud/probes';
import { panelChild, elementRect } from '../hud/build';
import { canvasDpr, watchDpr } from './Hud';
import Hud from './Hud';
import { validateDesign, type HudDesign } from '../hud/design';
import { setupHudTests, indexOf, layer, unitCanvas, clickAt, dragFrom } from './hudTestKit';

setupHudTests();

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
    // A pill previews its band, as the state tab would.
    fireEvent.click(screen.getByRole('button', { name: /^16 to 50/ }));
    expect(screen.getByRole('tab', { name: 'Hurt' }).getAttribute('aria-selected')).toBe('true');
    expect([swatch(), lit()]).toEqual(['#d8920c', '16 to 50']);
    // A picked colour is one for every health, and one click puts the game's three back.
    fireEvent.input(screen.getByLabelText('Panel colour colour'), { target: { value: '#ff00ff' } });
    expect(screen.getByText("Same at every health: this replaces the game's green, orange and red.")).toBeTruthy();
    expect(screen.queryByLabelText("The game's health colours")).toBeNull();
    expect(screen.getByRole('button', { name: "Panel colour: use the file's value" }).textContent).toBe("Use the game's health colours");
    fireEvent.click(screen.getByRole('button', { name: "Panel colour: use the file's value" }));
    expect(screen.getByLabelText("The game's health colours")).toBeTruthy();
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

describe('canvasDpr', () => {
  it('draws at the display\'s own pixel density', () => {
    expect(canvasDpr(1200, 1.5)).toBe(1.5);
    expect(canvasDpr(1200, 1)).toBe(1);
  });
  it('stops a wide canvas at 3200 device pixels, and never goes under 1', () => {
    expect(canvasDpr(2000, 2)).toBe(1.6);
    expect(canvasDpr(4000, 2)).toBe(1);
    expect(canvasDpr(800, 0.9)).toBe(1);
  });
});

describe('watchDpr', () => {
  /** A window whose matchMedia hands back queries the test can fire, as a monitor change does. */
  const fakeWindow = (ratio: number) => {
    const queries: { media: string; listeners: Set<() => void> }[] = [];
    const win = {
      devicePixelRatio: ratio,
      matchMedia: (media: string) => {
        const q = { media, listeners: new Set<() => void>() };
        queries.push(q);
        return {
          media,
          addEventListener: (_: string, f: () => void) => q.listeners.add(f),
          removeEventListener: (_: string, f: () => void) => q.listeners.delete(f),
        };
      },
    };
    return { win, queries };
  };

  it('redraws when the pixel density changes, and listens again at the new one', () => {
    const { win, queries } = fakeWindow(1);
    let draws = 0;
    const stop = watchDpr(win as unknown as Window, () => { draws += 1; });
    expect(queries.map((q) => q.media)).toEqual(['(resolution: 1dppx)']);
    win.devicePixelRatio = 1.5;
    for (const f of [...queries[0].listeners]) f();
    expect(draws).toBe(1);
    expect(queries[0].listeners.size).toBe(0);
    expect(queries.map((q) => q.media)).toEqual(['(resolution: 1dppx)', '(resolution: 1.5dppx)']);
    stop();
    expect(queries[1].listeners.size).toBe(0);
  });

  it('does nothing where there is no matchMedia (a test page)', () => {
    let draws = 0;
    const stop = watchDpr({ devicePixelRatio: 2 } as unknown as Window, () => { draws += 1; });
    stop();
    expect(draws).toBe(0);
  });
});
