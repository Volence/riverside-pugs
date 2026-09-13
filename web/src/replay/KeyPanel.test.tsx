import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/preact';
import { KeyPanel } from './KeyPanel';
import { STATE_RINGS } from './stateRing';
import { MARKER_KINDS } from './markers';

afterEach(cleanup);

describe('KeyPanel', () => {
  it('lists every state, every marker letter, the ghost and the dead treatment, from the tables', () => {
    render(<KeyPanel onClose={() => {}} />);
    for (const r of STATE_RINGS) expect(screen.getByText(r.label)).toBeTruthy();
    for (const k of MARKER_KINDS) expect(screen.getAllByText(k.label).length).toBeGreaterThan(0);
    expect(screen.getByText('Unspawned infected')).toBeTruthy();
    expect(screen.getByText('Dead')).toBeTruthy();
    expect(screen.getByText('S1')).toBeTruthy();
    expect(screen.getByText('I4')).toBeTruthy();
  });
  it('closes on Escape and on its button', () => {
    const onClose = vi.fn();
    render(<KeyPanel onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close key' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
