import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import { PeoplePings } from './PeoplePings';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const stub = (body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json' },
})));

describe('PeoplePings', () => {
  it('shows a column per host, bolds the lowest, and dashes the unknown', async () => {
    stub({
      hosts: [{ host: 'dal', label: 'Dallas' }, { host: 'chi', label: 'Chicago' }],
      players: [{ steamid: '76561198000000001', name: 'amy', cells: { dal: { ms: 48, rounds: 12, loss: 1 }, chi: { ms: 31, rounds: 2, loss: 0 } } },
        { steamid: '76561198000000002', name: 'bob', cells: { dal: { ms: 70, rounds: 5, loss: 0 } } }],
      pickByPing: false,
    });
    render(<PeoplePings />);
    expect(await screen.findByText('Dallas')).toBeTruthy();
    expect(screen.getByText('31 ms').tagName).toBe('STRONG');
    expect(screen.getByText('48 ms').tagName).not.toBe('STRONG');
    expect(screen.getByText('-')).toBeTruthy();
    expect(screen.getByText(/recorded but not used/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'bob' }).getAttribute('href')).toBe('/admin/people/76561198000000002');
  });
});
