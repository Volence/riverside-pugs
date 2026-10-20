import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';

const { mockNews } = vi.hoisted(() => ({ mockNews: { list: vi.fn() } }));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, newsApi: { ...actual.newsApi, ...mockNews } };
});
const { NewsStrip, NEWS_DISMISS_KEY } = await import('./NewsStrip');

const latest = (id: number, title: string) => ({
  posts: [{ id, kind: 'news', title, body: '', excerpt: '', publishedAt: '2026-11-03T18:00:00.000Z', updatedAt: '', author: null }],
  page: 1, pages: 1, total: 1,
});

beforeEach(() => { localStorage.clear(); mockNews.list.mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('NewsStrip', () => {
  it('links the latest post, asking for one post only', async () => {
    mockNews.list.mockResolvedValue(latest(4, 'Season 1 is live'));
    render(<NewsStrip />);
    const link = await screen.findByRole('link', { name: 'Season 1 is live' });
    expect(link.getAttribute('href')).toBe('/news/4');
    expect(mockNews.list).toHaveBeenCalledWith(expect.anything(), 1, 1);
  });

  it('stays closed for that post once closed, and a newer post shows again', async () => {
    mockNews.list.mockResolvedValue(latest(4, 'Season 1 is live'));
    const first = render(<NewsStrip />);
    fireEvent.click(await screen.findByRole('button', { name: 'Hide this post' }));
    expect(screen.queryByRole('link', { name: 'Season 1 is live' })).toBeNull();
    expect(localStorage.getItem(NEWS_DISMISS_KEY)).toBe('4');
    first.unmount();

    render(<NewsStrip />);
    await waitFor(() => expect(mockNews.list).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('link', { name: 'Season 1 is live' })).toBeNull();
    cleanup();

    mockNews.list.mockResolvedValue(latest(5, 'Patch notes Nov 10'));
    render(<NewsStrip />);
    await screen.findByRole('link', { name: 'Patch notes Nov 10' });
  });

  it('still works, and closes for the visit, when storage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    mockNews.list.mockResolvedValue(latest(4, 'Season 1 is live'));
    render(<NewsStrip />);
    fireEvent.click(await screen.findByRole('button', { name: 'Hide this post' }));
    expect(screen.queryByRole('link', { name: 'Season 1 is live' })).toBeNull();
  });

  it('shows nothing when there is no post or the read fails', async () => {
    mockNews.list.mockRejectedValue(new Error('down'));
    const { container } = render(<NewsStrip />);
    await waitFor(() => expect(mockNews.list).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
