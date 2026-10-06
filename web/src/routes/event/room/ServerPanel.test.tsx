import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import type { MatchRoomView } from '../../../api';
import { ServerPanel } from './ServerPanel';

afterEach(cleanup);
const base = (over: Partial<MatchRoomView>): MatchRoomView => ({
  id: 1, eventSlug: 'cup', eventName: 'Cup', roundLabel: 'Round 1',
  a: { id: 1, name: 'Rats', tag: 'RAT', logoKey: null, seed: 1, out: false }, b: { id: 2, name: 'Bats', tag: 'BAT', logoKey: null, seed: 2, out: false },
  phase: 'connect', higher: 'a', deadline: '2026-10-06T00:15:00.000Z', serverNow: '2026-10-06T00:00:00.000Z', ready: { a: true, b: true }, vetoSummary: '',
  pool: [], log: [], games: [], next: null, lineups: { a: null, b: null, aLocked: true, bLocked: true }, holdReason: null, result: null, me: null,
  series: null, server: null, confirm: null, dispute: null, frozen: false, schedule: null, ...over,
});
const NOW = Date.parse('2026-10-06T00:05:00.000Z');

describe('ServerPanel', () => {
  it('says it is waiting for a server, with when since', () => {
    render(<ServerPanel v={base({ phase: 'server', server: { state: 'waiting', name: null, since: '2026-10-06T00:00:00.000Z', connect: null, present: null, graceEndsAt: null } })} now={NOW} />);
    expect(screen.getByText(/Waiting for a server/)).toBeTruthy();
  });

  it('shows the connect line, who is on and the grace to those who may see it, and only the counts to others', () => {
    const server = { state: 'ready' as const, name: 'box', since: '2026-10-06T00:00:00.000Z', connect: { host: '10.0.0.1', port: 27015, password: 'pw' }, present: { a: 4, b: 3 }, graceEndsAt: '2026-10-06T00:15:00.000Z' };
    render(<ServerPanel v={base({ server })} now={NOW} />);
    expect(screen.getByText('connect 10.0.0.1:27015; password pw')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
    expect(screen.getByText('On the server: Rats 4 of 4, Bats 3 of 4')).toBeTruthy();
    expect(screen.getByText(/Both teams need four on the server within 10:00/)).toBeTruthy();
    cleanup();
    render(<ServerPanel v={base({ server: { ...server, connect: null } })} now={NOW} />);
    expect(screen.queryByText(/password/)).toBeNull();
    expect(screen.getByText(/The teams are connecting/)).toBeTruthy();
  });

  it('warns that staff have frozen the game', () => {
    const server = { state: 'ready' as const, name: 'box', since: '2026-10-06T00:00:00.000Z', connect: { host: '10.0.0.1', port: 27015, password: 'pw' }, present: { a: 4, b: 3 }, graceEndsAt: null };
    render(<ServerPanel v={base({ server, frozen: true })} now={NOW} />);
    expect(screen.getByText('Staff have frozen the game. Only staff can unfreeze it.')).toBeTruthy();
  });
});
