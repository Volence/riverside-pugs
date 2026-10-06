import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { RoundScheduleForm } from './RoundScheduleForm';

afterEach(cleanup);

describe('RoundScheduleForm', () => {
  it('fills a league from a weekly pattern and saves the rows as UTC', () => {
    const onSave = vi.fn();
    render(<RoundScheduleForm scheduling="window" league={{ matches: 3, matchesPerWeek: 2 }} seasonStart="2026-10-12" roundsKnown={3} initial={[]} busy={false} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText('Match 1 weekday'), { target: { value: '3' } });
    fireEvent.input(screen.getByLabelText('Match 1 time (UTC)'), { target: { value: '21:00' } });
    fireEvent.change(screen.getByLabelText('Match 2 weekday'), { target: { value: '0' } });
    fireEvent.input(screen.getByLabelText('Match 2 time (UTC)'), { target: { value: '19:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fill from the pattern' }));
    expect(screen.getAllByLabelText(/^Round \d default time$/)).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    expect(onSave).toHaveBeenCalledWith([
      { round: 1, at: '2026-10-14T21:00:00.000Z', from: '2026-10-12T00:00:00.000Z', to: '2026-10-18T23:59:59.000Z' },
      { round: 2, at: '2026-10-18T19:30:00.000Z', from: '2026-10-12T00:00:00.000Z', to: '2026-10-18T23:59:59.000Z' },
      { round: 3, at: '2026-10-21T21:00:00.000Z', from: '2026-10-19T00:00:00.000Z', to: '2026-10-25T23:59:59.000Z' },
    ]);
  });

  it('takes a date only per round on a rolling stage, adding rounds by hand, and clears a row', () => {
    const onSave = vi.fn();
    render(<RoundScheduleForm scheduling="rolling" league={null} seasonStart={null} roundsKnown={null} initial={[{ round: 1, at: '2026-10-24T21:00:00.000Z', from: null, to: null }]} busy={false} onSave={onSave} />);
    expect(screen.queryByLabelText('Round 1 window start')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add a round' }));
    fireEvent.input(screen.getByLabelText('Round 2 default time'), { target: { value: '2026-10-25T21:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear round 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    expect(onSave).toHaveBeenCalledWith([{ round: 2, at: new Date('2026-10-25T21:00').toISOString(), from: null, to: null }]);
  });
});
