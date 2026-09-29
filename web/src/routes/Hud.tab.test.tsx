import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/preact';
import { _setProbe } from '../hud/probes';
import { teamCardRects } from '../hud/build';
import Hud from './Hud';
import { DEFAULT_DESIGN, type HudDesign } from '../hud/design';
import { setupHudTests, layer, team, unitCanvas, clickAt, dragFrom } from './hudTestKit';

setupHudTests();

/**
 * The Tab screen on the page (tab screen spec 3.1 and task 16; probe
 * answers in section 7, /home/volence/l4d/hud/probe-tab/RESULTS.md): the
 * Tab held preview, the Tab screen group in Layers and in Styles, the side
 * panel's controls from the registry, and picking on the canvas while the
 * Tab screen shows. Points are HUD units (unitCanvas): row 2's health bar at
 * (55, 218), "Your Team" at (60, 60) on the stock file.
 */
describe('The Tab screen on the page', () => {
  const saved = () => JSON.parse(localStorage.getItem('hud') ?? '{}') as HudDesign;
  const legend = (text: string) => screen.queryByText(text, { selector: 'legend' });
  const tabHeld = () => screen.getByRole('button', { name: 'Tab held' });

  it('toggles Tab held on both sides, a preview choice that is never saved in the design', async () => {
    render(<Hud />);
    expect(tabHeld().getAttribute('aria-pressed')).toBe('false');
    expect(tabHeld().getAttribute('title')).toBe(
      'Preview only: draw the Tab screen (scoreboard and versus score) as the game shows it while you hold Tab in versus.');
    fireEvent.click(tabHeld());
    expect(tabHeld().getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Infected' }));
    expect(tabHeld().getAttribute('aria-pressed')).toBe('true');
    // A real edit so the design is saved, then nothing of the toggle in it.
    fireEvent.change(screen.getByRole('combobox', { name: 'Versus score box style' }), { target: { value: 'flat' } });
    await waitFor(() => expect(saved().styles?.tabStatBox?.kind).toBe('flat'));
    expect(JSON.stringify(saved())).not.toMatch(/"tab":/);
  });

  it('lists the Tab screen group in Layers: the four elements on the infected side, the rows\' pieces under In every row', () => {
    render(<Hud />);
    const group = () => within(screen.getByRole('region', { name: 'Tab screen' }));
    expect(screen.getAllByText('Tab screen', { selector: '.hud__layergroup-title' })).toHaveLength(1);
    expect(group().getByRole('button', { name: 'Versus score' })).toBeTruthy();
    expect(group().getByRole('button', { name: 'Survivor rows' })).toBeTruthy();
    expect(group().queryByRole('button', { name: 'Infected rows' })).toBeNull();
    expect(layer('Versus score').getByRole('button', { name: '"Your Team"' })).toBeTruthy();
    expect(layer('Survivor rows').getByText('In every row')).toBeTruthy();
    expect(layer('Survivor rows').queryByRole('button', { name: 'Card 1' })).toBeNull();
    // Your row is code's to show: listed shown, not dimmed as its file's visible 0 would say.
    expect(layer('Survivor rows').getByRole('button', { name: 'Hide Your row' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Infected' }));
    expect(group().getByRole('button', { name: 'Infected rows' })).toBeTruthy();
    expect(layer('Infected rows').getByRole('button', { name: 'Player name' })).toBeTruthy();
  });

  it('shows the three Tab slots under Styles and edits them', async () => {
    render(<Hud />);
    expect(screen.getByText('Tab screen', { selector: '.eyebrow' })).toBeTruthy();
    for (const label of ['Versus score box', 'Team score box', 'Teammate rows']) {
      expect(screen.getByRole('combobox', { name: `${label} style` }), label).toBeTruthy();
    }
    fireEvent.input(screen.getByLabelText('Team score box colour'), { target: { value: '#ff00ff' } });
    await waitFor(() => expect(saved().styles?.tabTeamBox).toMatchObject({ kind: 'flat', color: expect.stringMatching(/^255 0 255 \d+$/) }));
  });

  it('colours "Your Team" from its piece, and selecting it draws the Tab screen', async () => {
    const { container } = render(<Hud />);
    fireEvent.click(layer('Versus score').getByRole('button', { name: '"Your Team"' }));
    expect(legend('"Your Team"')).toBeTruthy();
    expect(container.querySelector('.hud__crumbs')!.textContent).toBe('Versus score›"Your Team"');
    fireEvent.input(screen.getByLabelText('"Your Team" colour'), { target: { value: '#ffff00' } });
    await waitFor(() => expect(saved().children?.tabVersus?.TeamYours?.color).toMatch(/^255 255 0 \d+$/));
    // Picked, the Tab screen is on the canvas though Tab held is off: a click there picks from it.
    expect(tabHeld().getAttribute('aria-pressed')).toBe('false');
    clickAt(unitCanvas(container), 55, 218);
    expect(legend('Health bar')).toBeTruthy();
  });

  it('says which pieces the game colours itself, offering no colour there', () => {
    render(<Hud />);
    fireEvent.click(layer('Versus score').getByRole('button', { name: 'Your score' }));
    expect(screen.getByText(/The game writes the score here and colours it itself/)).toBeTruthy();
    expect(screen.queryByLabelText('Your score colour')).toBeNull();
    fireEvent.click(layer('Survivor rows').getByRole('button', { name: 'Bot name' }));
    expect(screen.getByText(/The game draws the names white whatever the file says/)).toBeTruthy();
    expect(screen.queryByLabelText('Bot name colour')).toBeNull();
    expect(screen.getByText('Edits apply to every row.')).toBeTruthy();
  });

  it('hides "Health Bonus:" with its number, and says so', async () => {
    render(<Hud />);
    fireEvent.click(layer('Versus score').getByRole('button', { name: '"Health Bonus:"' }));
    expect(screen.getByText(/Hiding it hides its number too/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Visible' }));
    // Only the label's hide is stored: the game and the preview take its number along.
    await waitFor(() => expect(saved().children?.tabVersus).toEqual({ HealthLabel: { visible: false } }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Visible' }));
    await waitFor(() => expect(saved().children?.tabVersus).toBeUndefined());
  });

  it('lists a piece pinned to a hidden one as hidden with it, with no Visible control, until the head is shown', async () => {
    render(<Hud />);
    fireEvent.click(layer('Versus score').getByRole('button', { name: '"Average Distance:"' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Visible' }));
    await waitFor(() => expect(saved().children?.tabVersus).toEqual({ DistanceLabel: { visible: false } }));
    // Layers: dimmed, no eye, and the note naming what hides it.
    expect(layer('Versus score').queryByRole('button', { name: /^(Show|Hide) Health bonus$/ })).toBeNull();
    expect(layer('Versus score').getAllByText('Hidden with "Average Distance:"')).toHaveLength(3);
    fireEvent.click(layer('Versus score').getByRole('button', { name: 'Health bonus' }));
    expect(screen.queryByRole('checkbox', { name: 'Visible' })).toBeNull();
    expect(screen.getByText(/Hidden with "Average Distance:"\. Show it to bring this back\./)).toBeTruthy();
    // Showing the head from Layers brings the line back.
    fireEvent.click(layer('Versus score').getByRole('button', { name: 'Show "Average Distance:"' }));
    await waitFor(() => expect(saved().children?.tabVersus).toBeUndefined());
    expect(screen.getByRole('checkbox', { name: 'Visible' })).toBeTruthy();
    expect(layer('Versus score').getByRole('button', { name: 'Hide Health bonus' })).toBeTruthy();
  });

  it('offers the row bars grey as the file has it, by health, or one colour', async () => {
    render(<Hud />);
    fireEvent.click(layer('Survivor rows').getByRole('button', { name: 'Health bar' }));
    const choice = () => screen.getByRole('combobox', { name: 'Row bars' }) as HTMLSelectElement;
    expect(Array.from(choice().options).map((o) => o.textContent)).toEqual(['As the file has it', 'By health', 'One colour']);
    expect(choice().value).toBe('file');
    expect(screen.queryByLabelText('Row bars colour')).toBeNull();
    fireEvent.change(choice(), { target: { value: 'clear' } });
    await waitFor(() => expect(saved().children?.tabSurvivors?.SurvivorStatsHealth?.keys).toEqual({ monochrome_color: '' }));
    fireEvent.change(choice(), { target: { value: 'one' } });
    await waitFor(() => expect(saved().children?.tabSurvivors?.SurvivorStatsHealth?.keys?.monochrome_color).toMatch(/^\d+ \d+ \d+ \d+$/));
    fireEvent.input(screen.getByLabelText('Row bars colour'), { target: { value: '#ff0000' } });
    await waitFor(() => expect(saved().children?.tabSurvivors?.SurvivorStatsHealth?.keys?.monochrome_color).toMatch(/^255 0 0 \d+$/));
    fireEvent.change(choice(), { target: { value: 'file' } });
    await waitFor(() => expect(saved().children?.tabSurvivors).toBeUndefined());
  });

  it('picks a Tab piece on the canvas while Tab is held, with its outline and no handles', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    fireEvent.click(tabHeld());
    clickAt(canvas, 55, 218);
    expect(legend('Health bar')).toBeTruthy();
    expect(container.querySelector('.hud__crumbs')!.textContent).toBe('Survivor rows›Health bar');
    clickAt(canvas, 60, 60);
    expect(legend('"Your Team"')).toBeTruthy();
    // Ctrl+click climbs to the versus panel.
    clickAt(canvas, 60, 60, { ctrlKey: true });
    expect(legend('Versus score')).toBeTruthy();
  });

  it('moves a picked versus piece from a drag (PIECES-1), the versus panel once climbed to, and records nothing for a drag on the board', async () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    const undo = () => screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement;
    fireEvent.click(tabHeld());
    clickAt(canvas, 60, 60);
    expect(legend('"Your Team"')).toBeTruthy();
    // "Your Team" is drawn at its if_embedded x 20 in the panel at 15, 25: the drag moves it 20 across, 10 down.
    dragFrom(canvas, [60, 60], [80, 70]);
    await waitFor(() => expect(saved().children?.tabVersus?.TeamYours).toEqual({ x: 40, y: 40 }));
    expect(legend('"Your Team"')).toBeTruthy();
    expect(saved().elements?.tabVersus).toBeUndefined();
    fireEvent.click(undo());
    expect(undo().disabled).toBe(true);
    // Ctrl+click climbs to the panel, which a drag then moves.
    clickAt(canvas, 60, 60, { ctrlKey: true });
    expect(legend('Versus score')).toBeTruthy();
    dragFrom(canvas, [60, 60], [80, 70]);
    await waitFor(() => expect(saved().elements?.tabVersus).toEqual({ x: 35, y: 35 }));
    fireEvent.click(undo());
    expect(undo().disabled).toBe(true);
    // The backdrop, then the board: neither moves, and nothing up from them does.
    clickAt(canvas, 100, 400);
    expect(legend('Backdrop')).toBeTruthy();
    dragFrom(canvas, [100, 400], [150, 420]);
    expect(undo().disabled).toBe(true);
    expect(legend('Backdrop')).toBeTruthy();
    clickAt(canvas, 100, 400, { ctrlKey: true });
    expect(legend('Tab screen')).toBeTruthy();
    dragFrom(canvas, [100, 400], [150, 420]);
    expect(undo().disabled).toBe(true);
  });

  it('nudges a picked versus piece with the arrows and shows its drawn place in X and Y', async () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    fireEvent.click(tabHeld());
    clickAt(canvas, 60, 60);
    expect(legend('"Your Team"')).toBeTruthy();
    // The embedded place the game reads (if_embedded xpos 20), not the standalone panel's 25.
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('20');
    expect((screen.getByLabelText('Y') as HTMLInputElement).value).toBe('30');
    fireEvent.keyDown(canvas, { key: 'ArrowRight' });
    fireEvent.keyDown(canvas, { key: 'ArrowDown' });
    await waitFor(() => expect(saved().children?.tabVersus?.TeamYours).toEqual({ x: 21, y: 31 }));
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('21');
    fireEvent.input(screen.getByLabelText('X'), { target: { value: '360' } });
    await waitFor(() => expect(saved().children?.tabVersus?.TeamYours).toEqual({ x: 360, y: 31 }));
  });

  it('moves "Health Bonus:" on its own from its X box, keeping its drawn Y, and says it leaves the line', async () => {
    render(<Hud />);
    fireEvent.click(tabHeld());
    fireEvent.click(layer('Versus score').getByRole('button', { name: '"Health Bonus:"' }));
    expect(screen.getByText(/Moved on its own, it stops following the distance/)).toBeTruthy();
    const y = (screen.getByLabelText('Y') as HTMLInputElement).value;
    expect(y).toBe('80');
    fireEvent.input(screen.getByLabelText('X'), { target: { value: '200' } });
    await waitFor(() => expect(saved().children?.tabVersus?.HealthLabel).toEqual({ x: 200, y: 80 }));
  });

  it('offers no X or Y on the Survival Multiplier line, which the probe never saw, and says why', () => {
    render(<Hud />);
    fireEvent.click(layer('Versus score').getByRole('button', { name: '"Survival Multiplier:"' }));
    expect(screen.getByText(/never seen in game when the Tab pieces were tested/)).toBeTruthy();
    expect(screen.queryByLabelText('X')).toBeNull();
  });

  it('drops the Teammates from the selection when Tab held turns on, and skips them in the Tab-key cycle', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    fireEvent.click(team().getByRole('button', { name: 'Teammates' }));
    expect(legend('Teammates')).toBeTruthy();
    fireEvent.click(tabHeld());
    expect(legend('Teammates')).toBeNull();
    expect(container.querySelector('.hud__crumbs')?.textContent ?? '').not.toMatch(/Teammates/);
    const seenIds: string[] = [];
    for (let i = 0; i < 40; i++) {
      fireEvent.keyDown(canvas, { key: 'Tab' });
      seenIds.push(container.querySelector('.hud__crumbs')?.textContent ?? '');
    }
    expect(seenIds.some((t) => /Versus score/.test(t))).toBe(true);
    expect(seenIds.some((t) => /Teammates/.test(t))).toBe(false);
  });

  it('holds the versus panel on screen when the aspect narrows, as the download does', async () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    fireEvent.click(tabHeld());
    clickAt(canvas, 60, 60, { ctrlKey: true });
    expect(legend('Versus score')).toBeTruthy();
    dragFrom(canvas, [60, 60], [60 + 484, 60]);
    await waitFor(() => expect(saved().elements?.tabVersus?.x).toBe(499));
    fireEvent.change(screen.getByRole('combobox', { name: /aspect/i }), { target: { value: '4:3' } });
    await waitFor(() => expect(saved().elements?.tabVersus?.x).toBe(640 - 354));
  });

  it('offers X, Y and Align on several versus pieces, and none on several row pieces, which do not move; Visible and Reset all on both', () => {
    render(<Hud />);
    fireEvent.click(layer('Versus score').getByRole('button', { name: '"Your Team"' }));
    fireEvent.click(layer('Versus score').getByRole('button', { name: '"Enemy Team"' }), { shiftKey: true });
    expect(screen.getByText('2 pieces in Versus score', { selector: 'legend' })).toBeTruthy();
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('20');
    expect(screen.getByRole('group', { name: 'Align' })).toBeTruthy();
    fireEvent.click(layer('Survivor rows').getByRole('button', { name: 'Bot name' }));
    fireEvent.click(layer('Survivor rows').getByRole('button', { name: 'Ping' }), { shiftKey: true });
    expect(screen.getByText('2 pieces in Survivor rows', { selector: 'legend' })).toBeTruthy();
    expect(screen.queryByLabelText('X')).toBeNull();
    expect(screen.queryByLabelText('Y')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Align' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Visible' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reset all' })).toBeTruthy();
  });

  it('offers no Visible on several elements while the only one that hides has its hide gated (TS7)', () => {
    _setProbe('TS7', false);
    try {
      render(<Hud />);
      fireEvent.click(layer('Versus score').getByRole('button', { name: 'Versus score' }));
      fireEvent.click(layer('Tab screen').getByRole('button', { name: 'Tab screen' }), { shiftKey: true });
      expect(screen.getByText('2 elements', { selector: 'legend' })).toBeTruthy();
      expect(screen.queryByRole('checkbox', { name: 'Visible' })).toBeNull();
    } finally { _setProbe('TS7', null); }
  });

  it('never picks the teammate cards under the Tab screen', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    const [c] = teamCardRects(DEFAULT_DESIGN, DEFAULT_DESIGN.aspect);
    clickAt(canvas, c.x + c.w / 2, c.y + c.h / 2, { ctrlKey: true });
    expect(container.querySelector('.hud__crumbs')!.textContent).toMatch(/^Teammates/);
    fireEvent.keyDown(canvas, { key: 'Escape' });
    fireEvent.keyDown(canvas, { key: 'Escape' });
    fireEvent.click(tabHeld());
    clickAt(canvas, c.x + c.w / 2, c.y + c.h / 2, { ctrlKey: true });
    expect(container.querySelector('.hud__crumbs')!.textContent).not.toMatch(/Teammates/);
    expect(legend('Tab screen')).toBeTruthy();
  });

  it('picks nothing of the Tab screen while Tab held is off and nothing Tab is picked', () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    for (const [x, y] of [[55, 218], [60, 60], [10, 300]]) {
      clickAt(canvas, x, y);
      const crumbs = container.querySelector('.hud__crumbs')?.textContent ?? '';
      expect(crumbs, `${x},${y}`).not.toMatch(/Tab screen|Versus score|Survivor rows/);
      fireEvent.keyDown(canvas, { key: 'Escape' });
      fireEvent.keyDown(canvas, { key: 'Escape' });
    }
  });

  it('moves the versus panel by its number boxes, the arrow keys and a drag, inside the screen', async () => {
    const { container } = render(<Hud />);
    const canvas = unitCanvas(container);
    fireEvent.click(layer('Versus score').getByRole('button', { name: 'Versus score' }));
    expect(screen.getByRole('checkbox', { name: 'Visible' })).toBeTruthy();
    fireEvent.input(screen.getByLabelText('X'), { target: { value: '100' } });
    await waitFor(() => expect(saved().elements?.tabVersus).toEqual({ x: 100, y: 25 }));
    fireEvent.keyDown(canvas, { key: 'ArrowRight' });
    await waitFor(() => expect(saved().elements?.tabVersus).toEqual({ x: 101, y: 25 }));
    // Drawn while picked: a drag on it moves it (from 101, 25 by 50, 10).
    dragFrom(canvas, [150, 60], [200, 70]);
    await waitFor(() => expect(saved().elements?.tabVersus).toEqual({ x: 151, y: 35 }));
    fireEvent.input(screen.getByLabelText('X'), { target: { value: '900' } });
    await waitFor(() => expect(saved().elements?.tabVersus?.x).toBe(853 - 354));
  });
});

describe('the selection path over the Tab screen', () => {
  afterEach(cleanup);
  it('moves to the top right while the Tab screen is drawn, off its title', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    expect(screen.getByRole('navigation', { name: 'Selection path' }).className).toBe('hud__crumbs');
    fireEvent.click(screen.getByRole('button', { name: /tab held/i }));
    expect(screen.getByRole('navigation', { name: 'Selection path' }).className).toContain('hud__crumbs--right');
  });
});
