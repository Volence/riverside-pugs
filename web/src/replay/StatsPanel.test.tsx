import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/preact';
import { STATE, type PlayerSample } from '../../../src/replayFormat';
import { StatsPanel } from './StatsPanel';
import type { TimelineEntry } from './timeline';

afterEach(cleanup);

const SLOTS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const NAMES = { A: 'bill', B: 'zoey', C: 'francis', D: 'louis', E: 'smk', F: 'boom', G: 'hunt', H: 'tank' };

function players(): PlayerSample[] {
  return Array.from({ length: 8 }, (_, slot) => ({
    slot, x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
    state: slot === 7 ? 0 : STATE.PRESENT | STATE.ALIVE,
    health: 100, temp: 0, cls: slot < 4 ? slot : 1, weapon: 0, clip: 0, reserve: 0,
  }));
}

const T: TimelineEntry[] = [
  { seq: 1, tMs: 10000, kind: 'event', event: 'pinned', actor: 'E', target: 'A', value: 0 },
  { seq: 2, tMs: 12000, kind: 'event', event: 'cleared', actor: 'B', target: 'A', value: 0 },
  { seq: 3, tMs: 20000, kind: 'event', event: 'dp', actor: 'G', target: 'B', value: 12 },
  { seq: 4, tMs: 30000, kind: 'event', event: 'skeet', actor: 'A', target: 'G', value: 0 },
  { seq: 5, tMs: 40000, kind: 'event', event: 'ff', actor: 'A', target: 'B', value: 7 },
];

function mount(tMs: number, onClose = () => {}) {
  return render(
    <StatsPanel timeline={T} tMs={tMs} players={players()} slots={SLOTS} names={NAMES} onClose={onClose} />,
  );
}

const rowOf = (container: Element, name: string) => {
  const cell = [...container.querySelectorAll('.box__name')].find((n) => n.textContent === name);
  if (!cell) throw new Error(`no row for ${name}`);
  return cell.closest('tr') as HTMLTableRowElement;
};
const cells = (tr: HTMLTableRowElement) => [...tr.querySelectorAll('td.num')].map((td) => td.textContent);

describe('StatsPanel', () => {
  it('lays out one table per side, present players only, in slot order', () => {
    const { container } = mount(60000);
    const tables = container.querySelectorAll('table');
    expect(tables).toHaveLength(2);
    const names = (t: Element) => [...t.querySelectorAll('.box__name')].map((n) => n.textContent);
    expect(names(tables[0])).toEqual(['bill', 'zoey', 'francis', 'louis']);
    // slot 7 (tank) is not present this frame
    expect(names(tables[1])).toEqual(['smk', 'boom', 'hunt']);
  });

  it('shows only the columns the round has, and the numbers as of the playhead', () => {
    const { container } = mount(25000);
    const heads = [...container.querySelectorAll('table')[0].querySelectorAll('th')].map((h) => h.textContent);
    expect(heads).toEqual(['', 'Skeets', 'Clears', 'FF dmg', 'Pinned']);
    // bill: at 25s he has been pinned once and cleared nobody; his skeet is at 30s.
    expect(cells(rowOf(container, 'bill'))).toEqual(['0', '0', '0', '1']);
    expect(cells(rowOf(container, 'zoey'))).toEqual(['0', '1', '0', '0']);
    const infHeads = [...container.querySelectorAll('table')[1].querySelectorAll('th')].map((h) => h.textContent);
    expect(infHeads).toEqual(['', 'Pins', 'Pounces', 'DP dmg', 'Skeeted', 'Cleared']);
    expect(cells(rowOf(container, 'hunt'))).toEqual(['0', '1', '12', '0', '0']);
  });

  it('fills in as the playhead moves and dims zeros', () => {
    const { container } = mount(60000);
    expect(cells(rowOf(container, 'bill'))).toEqual(['1', '0', '7', '1']);
    const zero = rowOf(container, 'bill').querySelectorAll('td.num')[1];
    expect((zero as HTMLElement).classList.contains('is-zero')).toBe(true);
  });

  it('closes on Escape and on its button, and shows the clock', () => {
    const onClose = vi.fn();
    mount(25000, onClose);
    expect(screen.getByText('0:25')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close stats' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
