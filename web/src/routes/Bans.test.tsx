import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import { Bans } from './Bans';

afterEach(cleanup);

/* The list is admins only for now. The API refuses everyone else; this checks
 * the page says so plainly instead of showing a failed load. */
describe('Bans', () => {
  it('tells a visitor the list is for admins, and never asks the API', () => {
    render(<Bans session={{ kind: 'anonymous' }} />);
    expect(screen.getByText('The ban list is for admins only right now.')).toBeTruthy();
    expect(screen.queryByLabelText('Search bans')).toBeNull();
  });
});
