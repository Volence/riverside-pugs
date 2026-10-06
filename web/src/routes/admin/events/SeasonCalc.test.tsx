import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { SeasonCalc } from './SeasonCalc';

afterEach(cleanup);

describe('SeasonCalc', () => {
  it('turns matches and matches a week into weeks, and with a start date into an end date', () => {
    render(<SeasonCalc matches={16} perWeek={2} seasonStart="2026-10-12" teamCap={8} onUsePerWeek={() => {}} />);
    expect(screen.getByText('16 matches at 2 a week: 8 weeks, Oct 12 to Dec 6.')).toBeTruthy();
  });

  it('without a start date says the season starts with the stage', () => {
    render(<SeasonCalc matches={16} perWeek={3} seasonStart={null} teamCap={null} onUsePerWeek={() => {}} />);
    expect(screen.getByText('16 matches at 3 a week: 6 weeks from the day the stage starts.')).toBeTruthy();
  });

  it('from an end date, offers the matches a week that fit, or says nothing fits', () => {
    const use = vi.fn();
    render(<SeasonCalc matches={16} perWeek={1} seasonStart="2026-10-12" teamCap={8} onUsePerWeek={use} />);
    fireEvent.input(screen.getByLabelText('Season ends by'), { target: { value: '2026-11-29' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use 3 a week' }));
    expect(use).toHaveBeenCalledWith(3);
    fireEvent.input(screen.getByLabelText('Season ends by'), { target: { value: '2026-10-25' } });
    expect(screen.getByText('16 matches do not fit by then, even at 3 a week.')).toBeTruthy();
  });

  it('with an odd team count says how byes fall and which counts split them evenly', () => {
    render(<SeasonCalc matches={16} perWeek={2} seasonStart={null} teamCap={8} onUsePerWeek={() => {}} />);
    fireEvent.input(screen.getByLabelText('Expected teams'), { target: { value: '7' } });
    expect(screen.getByText('With 7 teams each team gets 2 or 3 byes (a bye is a win). 14 or 21 matches gives everyone the same.')).toBeTruthy();
    fireEvent.input(screen.getByLabelText('Expected teams'), { target: { value: '8' } });
    expect(screen.queryByText(/byes/)).toBeNull();
  });

  it('says nothing while matches or matches a week is not a whole number', () => {
    const { container } = render(<SeasonCalc matches={null} perWeek={2} seasonStart={null} teamCap={8} onUsePerWeek={() => {}} />);
    expect(container.querySelector('.seasoncalc__line')).toBeNull();
  });
});
