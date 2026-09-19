import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import { HelpConsistency } from './HelpConsistency';

afterEach(cleanup);

/* Shallow on purpose, like routes.test.tsx: this asserts that the page says the
 * things the spec requires it to say, not how it is marked up. */
describe('HelpConsistency', () => {
  it('shows the dialog text a dropped player is looking at', () => {
    render(<HelpConsistency />);
    expect(screen.getByText(/Server is enforcing consistency for this file:/)).toBeTruthy();
  });

  it('names the three usual causes', () => {
    render(<HelpConsistency />);
    expect(screen.getByText('A skin.')).toBeTruthy();
    expect(screen.getByText('A no-trees or foliage pack.')).toBeTruthy();
    expect(screen.getByText('Silenced weapons or a sound pack.')).toBeTruthy();
  });

  it('explains removing an addon and verifying game files', () => {
    render(<HelpConsistency />);
    expect(screen.getByRole('heading', { name: 'Remove the addon' })).toBeTruthy();
    expect(screen.getByText('left4dead/addons')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Verify your game files' })).toBeTruthy();
    expect(screen.getByText('Verify integrity of game files')).toBeTruthy();
  });

  it('says the detail-grass cvars are not part of it', () => {
    render(<HelpConsistency />);
    expect(screen.getByText('cl_detaildist')).toBeTruthy();
    expect(screen.getByText('r_drawdetailprops')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Grass settings are not part of this' })).toBeTruthy();
  });

  it('contains no em dash', () => {
    const { container } = render(<HelpConsistency />);
    // Built from its code point so this file does not contain one either.
    expect(container.textContent).not.toContain(String.fromCharCode(0x2014));
  });
});
