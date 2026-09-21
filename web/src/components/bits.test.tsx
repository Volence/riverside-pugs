import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/preact';
import { PlayerLink } from './bits';

afterEach(cleanup);

describe('PlayerLink', () => {
  it('links the steam name to the player page', () => {
    render(<PlayerLink steamid="123" name="mira" />);
    const link = screen.getByText('mira') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/player/123');
  });

  it('shows nothing extra when there is no linked discord name', () => {
    const { container } = render(<PlayerLink steamid="123" name="mira" discordName={null} />);
    expect(container.textContent).toBe('mira');
  });

  it('shows nothing extra when the discord name matches the steam name', () => {
    const { container } = render(<PlayerLink steamid="123" name="mira" discordName="Mira" />);
    expect(container.textContent).toBe('mira');
  });

  it('shows the discord name alongside when it reads differently', () => {
    const { container } = render(<PlayerLink steamid="123" name="mira" discordName="br1" />);
    expect(container.textContent).toBe('mira (Discord: br1)');
  });
});
