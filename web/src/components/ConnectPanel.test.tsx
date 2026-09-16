import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/preact';
import { ConnectPanel } from './ConnectPanel';

afterEach(cleanup);

const CONNECT = { host: '45.32.199.85', port: 27015, password: 'pug_a1b2c3d4' };

describe('ConnectPanel', () => {
  it('links straight into the game with the match password', () => {
    render(<ConnectPanel connect={CONNECT} />);
    const link = screen.getByRole('link', { name: /join server/i });
    expect(link.getAttribute('href')).toBe('steam://connect/45.32.199.85:27015/pug_a1b2c3d4');
  });

  it('shows the console line as a fallback', () => {
    render(<ConnectPanel connect={CONNECT} />);
    expect(screen.getByText('connect 45.32.199.85:27015; password pug_a1b2c3d4')).toBeTruthy();
  });
});
