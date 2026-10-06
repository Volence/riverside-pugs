import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import type { MatchRoomView, RoomSchedule } from '../../../api';
import { SchedulePanel } from './SchedulePanel';
import { whenText } from '../../../eventFormat';

afterEach(cleanup);

const TIME = '2026-10-14T21:00:00.000Z';
const schedule = (over: Partial<RoomSchedule> = {}): RoomSchedule => ({
  scheduledAt: null, source: null, windowStart: '2026-10-12T00:00:00.000Z', windowEnd: '2026-10-18T23:59:59.000Z', opensAt: null, leadMinutes: 20,
  proposal: null, log: [], canPropose: false, canAnswer: false, canWithdraw: false, ...over,
});
const view = (s: RoomSchedule): MatchRoomView => ({
  id: 1, eventSlug: 'cup', eventName: 'Cup', roundLabel: 'Week 1',
  a: { id: 1, name: 'Rats', tag: 'RAT', logoKey: null, seed: 1, out: false }, b: { id: 2, name: 'Bats', tag: 'BAT', logoKey: null, seed: 2, out: false },
  phase: 'waiting', higher: null, deadline: null, serverNow: TIME, ready: { a: false, b: false }, vetoSummary: '', pool: [], log: [], games: [], next: null,
  lineups: { a: null, b: null, aLocked: false, bLocked: false }, holdReason: null, result: null, me: null, series: null, server: null, confirm: null, dispute: null, frozen: false,
  schedule: s,
});
const handlers = () => ({ onPropose: vi.fn(), onRespond: vi.fn(), onCounter: vi.fn(), onWithdraw: vi.fn() });

describe('SchedulePanel', () => {
  it('shows no time yet and the window, and a propose form for a manager', () => {
    const h = handlers();
    render(<SchedulePanel v={view(schedule({ canPropose: true }))} busy={false} {...h} />);
    expect(screen.getByText(/No time is set yet/)).toBeTruthy();
    expect(screen.getByText(new RegExp(whenText('2026-10-18T23:59:59.000Z').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeTruthy();
    fireEvent.input(screen.getByLabelText('Proposed time'), { target: { value: '2026-10-14T21:00' } });
    fireEvent.input(screen.getByLabelText('Note'), { target: { value: 'after work' } });
    fireEvent.click(screen.getByRole('button', { name: 'Propose this time' }));
    expect(h.onPropose).toHaveBeenCalledWith(new Date('2026-10-14T21:00').toISOString(), 'after work');
  });

  it('shows the locked time with when the room opens, and the open proposal with Accept, Decline and Counter for the other side', () => {
    const h = handlers();
    const p = { id: 5, side: 'a' as const, byName: 'alice', time: TIME, note: 'late', createdAt: '2026-10-10T10:00:00.000Z', autoAcceptAt: '2026-10-11T10:00:00.000Z', status: 'open' as const, respondedByName: null, respondedAt: null };
    render(<SchedulePanel v={view(schedule({ scheduledAt: '2026-10-13T20:00:00.000Z', source: 'default', opensAt: '2026-10-13T19:40:00.000Z', proposal: p, canAnswer: true }))} busy={false} {...h} />);
    expect(screen.getByText(/room opens 20 minutes before/)).toBeTruthy();
    expect(screen.getByText(/alice \(Rats\) proposes/)).toBeTruthy();
    expect(screen.getByText(/locks on/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(h.onRespond).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(h.onRespond).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: 'Counter' }));
    fireEvent.input(screen.getByLabelText('Proposed time'), { target: { value: '2026-10-15T21:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Counter with this time' }));
    expect(h.onCounter).toHaveBeenCalledWith(new Date('2026-10-15T21:00').toISOString(), '');
  });

  it('offers Withdraw to the proposing side and lists the log', () => {
    const h = handlers();
    const p = { id: 5, side: 'b' as const, byName: 'bob', time: TIME, note: '', createdAt: '2026-10-10T10:00:00.000Z', autoAcceptAt: null, status: 'open' as const, respondedByName: null, respondedAt: null };
    const old = { ...p, id: 4, status: 'declined' as const, respondedByName: 'alice', respondedAt: '2026-10-10T11:00:00.000Z' };
    render(<SchedulePanel v={view(schedule({ proposal: p, canWithdraw: true, log: [old] }))} busy={false} {...h} />);
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    expect(h.onWithdraw).toHaveBeenCalled();
    expect(screen.getByText(/declined by alice/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });
});
