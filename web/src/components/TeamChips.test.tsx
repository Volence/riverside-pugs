import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import { TeamChips } from './TeamChips';

afterEach(cleanup);

describe('TeamChips', () => {
  it('links each team to its page, with the logo or the tag, and names captains and co-captains only', () => {
    const { container } = render(<TeamChips teams={[
      { slug: 'rats', name: 'Riverside Rats', tag: 'RR', logoKey: 'a'.repeat(64), role: 'captain' },
      { slug: 'owls', name: 'Night Owls', tag: 'OWL', logoKey: null, role: 'cocaptain' },
      { slug: 'cats', name: 'Alley Cats', tag: 'CAT', logoKey: null, role: 'member' },
    ]} />);
    const links = screen.getAllByRole('link') as HTMLAnchorElement[];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/team/rats', '/team/owls', '/team/cats']);
    expect(links[0].textContent).toBe('Riverside RatsCaptain');
    expect(links[1].textContent).toBe('OWLNight OwlsCo-captain');
    expect(links[2].textContent).toBe('CATAlley Cats');
    expect(container.querySelector('img.teambadge')?.getAttribute('src')).toBe(`/api/teams/logos/${'a'.repeat(64)}.png`);
  });

  it('renders nothing for a player on no team', () => {
    const { container } = render(<TeamChips teams={[]} />);
    expect(container.innerHTML).toBe('');
  });
});
