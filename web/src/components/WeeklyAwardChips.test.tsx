import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { WeeklyAwardChips } from './WeeklyAwardChips';

afterEach(cleanup);
const a = (award: string, label: string, count: number) => ({ award, label, count, weeks: Array.from({ length: count }, (_, i) => `2026-09-${String(21 - i * 7).padStart(2, '0')}`) });

describe('WeeklyAwardChips', () => {
  it('renders nothing without awards', () => {
    const { container } = render(<WeeklyAwardChips awards={[]} />);
    expect(container.textContent).toBe('');
  });

  it('shows at most four chips with counts, then expands the rest', () => {
    const awards = [a('skeets', 'Skeets', 3), a('crowns', 'Witch crowns', 2), a('revives', 'Revives', 1), a('wins', 'Most wins', 1), a('rocks', 'Tank rocks landed', 1), a('booms', 'Booms landed', 1)];
    render(<WeeklyAwardChips awards={awards} />);
    expect(screen.getByText('Skeets x3')).toBeTruthy();
    expect(screen.getByText('Revives')).toBeTruthy();
    expect(screen.queryByText('Tank rocks landed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '+2 more' }));
    expect(screen.getByText('Tank rocks landed')).toBeTruthy();
  });
});
