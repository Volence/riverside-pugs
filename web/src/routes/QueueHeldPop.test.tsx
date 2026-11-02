import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { QueuePanel } from './Play';

/**
 * Adversarial review 2026-11-02: a held pop (7 solos, then a duo) leaves 9 in
 * the queue. Eight fixed slots hid the ninth, the duo's second member, so the
 * pair showed as half a duo and that player could not see themselves queued.
 */

const p = (i: number) => ({ steamid: `7656119800000040${i}`, name: `player${i}`, avatar: null });

afterEach(cleanup);

describe('queue panel with a held pop', () => {
  it('shows all nine, including the duo partner in the ninth place', () => {
    const players = Array.from({ length: 9 }, (_, i) => p(i));
    render(<QueuePanel count={9} joined={false} players={players} refresh={() => {}} duos={[[players[7].steamid, players[8].steamid]]} />);
    const body = document.body.textContent ?? '';
    expect(body).toContain('player7');
    expect(body).toContain('player8');
  });
});
