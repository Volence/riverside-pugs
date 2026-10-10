import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/preact';
import { RestoreRating, abandonOutcome, restoredText } from './RestoreRating';
import { resultLabel } from '../../format';

afterEach(cleanup);

describe('RestoreRating', () => {
  it('asks for a reason before it can be sent, then runs the restore', async () => {
    const run = vi.fn(async () => {});
    render(<RestoreRating matchId={42} steamid="76561199000000001" who="p1" busy={false} run={run} />);
    fireEvent.click(screen.getByRole('button', { name: 'Restore rating' }));
    const send = screen.getByRole('button', { name: 'Restore' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.input(screen.getByLabelText('Restore reason'), { target: { value: 'our crash' } });
    expect(send.disabled).toBe(false);
    fireEvent.submit(send.closest('form')!);
    expect(run).toHaveBeenCalledTimes(1);
    expect((run.mock.calls[0] as unknown[])[1]).toMatchObject({ title: "Restore p1's rating from match #42?" });
  });

  it('words an abandon and a restore', () => {
    expect(abandonOutcome({ matchId: 1, decided: 'b' })).toBe('decided, Team B won and it was rated');
    expect(abandonOutcome({ matchId: 1, decided: null })).toBe('aborted, nobody else rated');
    expect(restoredText({ restoredAt: null, restoredByName: null, restoreReason: null })).toBe('');
    expect(restoredText({ restoredAt: '2026-10-10T12:00:00Z', restoredByName: 'admin', restoreReason: 'crash' })).toContain('by admin: crash');
  });
});

describe('resultLabel', () => {
  it('names a decided abandon before a forfeit', () => {
    expect(resultLabel('a', null, 'Quitter')).toBe('Team A (decided, Quitter abandoned)');
    expect(resultLabel('a', 'b')).toBe('Team A (B forfeited)');
  });
});
