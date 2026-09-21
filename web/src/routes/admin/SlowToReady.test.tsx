import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/preact';
import { SlowToReadyTable, MIN_READYUPS } from './SlowToReady';
import type { SlowToReady } from '../../api';

afterEach(cleanup);

const row = (name: string, readyups: number, timesLast: number, avgSeconds: number): SlowToReady => ({
  steamid: `7656119800000${name.length}${readyups}`, name, readyups, timesLast, avgSeconds, totalSeconds: avgSeconds * readyups,
});
const names = () => screen.getAllByRole('row').slice(1).map((r) => r.querySelector('td')!.textContent);

describe('SlowToReadyTable', () => {
  // zero is last 22 times and pstache 20, but pstache has played far less:
  // a third of the time against a fifth. The count alone ranks them wrong.
  const rows = [row('zero', 114, 22, 42), row('pstache', 68, 20, 40), row('happy', 59, 16, 27), row('double', 59, 17, 45)];

  it('ranks by the share of ready-ups they were last for, and shows it as a percentage', () => {
    render(<SlowToReadyTable rows={rows} />);
    expect(names()).toEqual(['pstache', 'double', 'happy', 'zero']);
    const r = screen.getByText('pstache').closest('tr')!;
    expect(r.textContent).toContain('29%');
    expect(r.textContent).toContain('20 of 68');
  });

  it('sorts by average and by total on request, and flips on a second click', () => {
    render(<SlowToReadyTable rows={rows} />);
    fireEvent.click(screen.getByRole('button', { name: /Avg unready/ }));
    expect(names()).toEqual(['double', 'zero', 'pstache', 'happy']);
    fireEvent.click(screen.getByRole('button', { name: /Avg unready/ }));
    expect(names()).toEqual(['happy', 'pstache', 'zero', 'double']);
    fireEvent.click(screen.getByRole('button', { name: /Total unready/ }));
    expect(names()[0]).toBe('zero');
  });

  it('says which column it is sorted by', () => {
    render(<SlowToReadyTable rows={rows} />);
    expect(screen.getByRole('columnheader', { name: /Last/ }).getAttribute('aria-sort')).toBe('descending');
    fireEvent.click(screen.getByRole('button', { name: /Avg unready/ }));
    expect(screen.getByRole('columnheader', { name: /Avg unready/ }).getAttribute('aria-sort')).toBe('descending');
    expect(screen.getByRole('columnheader', { name: /Last/ }).getAttribute('aria-sort')).toBe('none');
  });

  // One of two is 50 percent and means nothing.
  it('leaves out players with too few ready-ups to mean anything, and can show them', () => {
    render(<SlowToReadyTable rows={[...rows, row('newbie', MIN_READYUPS - 1, MIN_READYUPS - 1, 300)]} />);
    expect(names()).not.toContain('newbie');
    fireEvent.click(screen.getByRole('checkbox'));
    expect(names()[0]).toBe('newbie');
  });

  it('shows everybody when nobody has enough ready-ups yet', () => {
    render(<SlowToReadyTable rows={[row('a', 6, 5, 100), row('b', 4, 0, 10)]} />);
    expect(names()).toEqual(['a', 'b']);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});
