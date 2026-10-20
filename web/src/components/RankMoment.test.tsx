import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';

const { rankMoment, play } = vi.hoisted(() => ({ rankMoment: vi.fn(), play: vi.fn(async () => {}) }));
vi.mock('../api', async (orig) => ({ ...(await orig<typeof import('../api')>()), api: { rankMoment } }));
vi.mock('../rankMomentFx', () => ({ playMoment: play }));
const { RankMoment } = await import('./RankMoment');

const ME = '76561190000000001';
const UP = { kind: 'up', matchId: 42, tierUp: false, from: 'Gold II', to: 'Gold I', srBefore: 1902, srAfter: 1943, floor: 1933, fromFloor: 1767, next: 2100, nextName: 'Platinum III' };

beforeEach(() => { localStorage.clear(); rankMoment.mockReset(); play.mockClear(); });
afterEach(cleanup);

describe('RankMoment', () => {
  it('plays a rank-up once, and Continue remembers the match', async () => {
    rankMoment.mockResolvedValue({ moment: UP });
    render(<RankMoment me={ME} state={null} />);
    expect(await screen.findByRole('dialog', { name: 'Ranked up to Gold I' })).toBeTruthy();
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    cleanup();
    render(<RankMoment me={ME} state={null} />);
    await Promise.resolve(); await Promise.resolve();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('waits while the viewer is in a ready check or a match', () => {
    rankMoment.mockResolvedValue({ moment: UP });
    render(<RankMoment me={ME} state={{ match: { id: 9 } } as never} />);
    expect(rankMoment).not.toHaveBeenCalled();
  });

  it('shows nothing when there is no moment or nobody is signed in', async () => {
    rankMoment.mockResolvedValue({ moment: null });
    render(<RankMoment me={ME} state={null} />);
    await Promise.resolve(); await Promise.resolve();
    expect(screen.queryByRole('dialog')).toBeNull();
    cleanup();
    render(<RankMoment me={null} state={null} />);
    expect(rankMoment).toHaveBeenCalledTimes(1);
  });
});
