import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/preact';

const { mockApi } = vi.hoisted(() => ({ mockApi: { duoAccept: vi.fn(async () => ({})), duoDecline: vi.fn(), duoCancel: vi.fn(), duoEnd: vi.fn(async () => ({})) } }));
vi.mock('../api', async (orig) => ({ ...(await orig<Record<string, unknown>>()), api: mockApi }));
const { DuoPanel } = await import('./DuoPanel');

const P = (name: string) => ({ steamid: `id-${name}`, name, avatar: null });

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('DuoPanel', () => {
  it('renders nothing with no duo and no invites', () => {
    const { container } = render(<DuoPanel duo={{ partner: null, incoming: [], outgoing: null }} refresh={() => {}} />);
    expect(container.textContent).toBe('');
  });

  it('shows an incoming invite and accepts it', async () => {
    render(<DuoPanel duo={{ partner: null, incoming: [{ id: 7, from: P('Zed') }], outgoing: null }} refresh={() => {}} />);
    expect(screen.getByText(/Zed/)).toBeTruthy();
    fireEvent.click(screen.getByText('Accept'));
    expect(mockApi.duoAccept).toHaveBeenCalledWith(7);
  });

  it('shows the partner and an End duo button', () => {
    render(<DuoPanel duo={{ partner: P('Amy'), incoming: [], outgoing: null }} refresh={() => {}} />);
    expect(screen.getByText(/Amy/)).toBeTruthy();
    fireEvent.click(screen.getByText('End duo'));
    expect(mockApi.duoEnd).toHaveBeenCalled();
  });
});
