import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/preact';
import { Headliner } from './Headliner';

afterEach(cleanup);

describe('Headliner', () => {
  it('shows the name, the gold rating, a signed delta and the small stats', () => {
    render(
      <Headliner
        eyebrow="Top rated" name="fake_11" rating={1151} delta={151}
        stats={[{ label: 'SI dmg / rd', value: 1125 }, { label: 'FF dealt', value: 153, tone: 'loss' }]}
      />,
    );
    expect(screen.getByText('fake_11')).toBeTruthy();
    expect(screen.getByText('1151').classList.contains('headliner__rating')).toBe(true);
    expect(screen.getByText('+151')).toBeTruthy();
    expect(screen.getByText('153').classList.contains('headliner__stat-value--loss')).toBe(true);
  });

  it('says Unrated when there is no rating', () => {
    render(<Headliner eyebrow="Rating" name="bob" rating={null} stats={[]} />);
    expect(screen.getByText(/unrated/i)).toBeTruthy();
  });

  it('reserves a gutter for the avatar only when one is given', () => {
    const { container, rerender } = render(<Headliner eyebrow="Rating" name="bob" rating={1000} stats={[]} avatar="/a.png" />);
    expect(container.querySelector('.headliner')?.classList.contains('headliner--avatar')).toBe(true);
    rerender(<Headliner eyebrow="Rating" name="bob" rating={1000} stats={[]} />);
    expect(container.querySelector('.headliner')?.classList.contains('headliner--avatar')).toBe(false);
  });
});
