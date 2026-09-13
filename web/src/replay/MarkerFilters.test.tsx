import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/preact';
import { MarkerFilters } from './MarkerFilters';
import { FREE } from './camera';
import type { TimelineEntry } from './timeline';

const T: TimelineEntry[] = [
  { seq: 1, tMs: 1000, kind: 'event', event: 'boom', actor: 'B', target: 'A', value: 0 },
  { seq: 2, tMs: 2000, kind: 'event', event: 'boom', actor: 'B', target: 'C', value: 0 },
  { seq: 3, tMs: 3000, kind: 'event', event: 'dp', actor: 'H', target: 'A', value: 20 },
  { seq: 4, tMs: 4000, kind: 'event', event: 'si_spawn', actor: 'H', target: null, value: 3 },
];
const slots = ['A', 'B', '', '', 'H', '', '', ''];
const names = { A: 'alice', B: 'bob', H: 'hunterman' };

afterEach(cleanup);

describe('MarkerFilters', () => {
  it('lists All events plus the kinds present with counts, and the rostered players', () => {
    render(<MarkerFilters timeline={T} showKind="all" setShowKind={() => {}} slots={slots} names={names} follow={FREE} setFollow={() => {}} />);
    const show = screen.getByLabelText('Show') as HTMLSelectElement;
    expect([...show.options].map((o) => o.textContent)).toEqual(['All events', 'Boom (2)', 'Pounce (1)']);
    const who = screen.getByLabelText('for') as HTMLSelectElement;
    expect([...who.options].map((o) => o.textContent)).toEqual(['Everyone', 'alice', 'bob', 'hunterman']);
  });

  it('choosing a player follows that slot, and Everyone frees the camera', () => {
    const setFollow = vi.fn();
    render(<MarkerFilters timeline={T} showKind="all" setShowKind={() => {}} slots={slots} names={names} follow={{ kind: 'slot', slot: 1 }} setFollow={setFollow} />);
    const who = screen.getByLabelText('for') as HTMLSelectElement;
    expect(who.value).toBe('1');
    fireEvent.change(who, { target: { value: '4' } });
    expect(setFollow).toHaveBeenCalledWith({ kind: 'slot', slot: 4 });
    fireEvent.change(who, { target: { value: '' } });
    expect(setFollow).toHaveBeenCalledWith(FREE);
  });

  it('choosing a kind reports it', () => {
    const setShowKind = vi.fn();
    render(<MarkerFilters timeline={T} showKind="all" setShowKind={setShowKind} slots={slots} names={names} follow={FREE} setFollow={() => {}} />);
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'dp' } });
    expect(setShowKind).toHaveBeenCalledWith('dp');
  });
});
