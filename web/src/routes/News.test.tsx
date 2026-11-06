import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import { ApiError, type NewsPost } from '../api';

const { mockNews, loc } = vi.hoisted(() => ({
  mockNews: { list: vi.fn(), post: vi.fn() },
  loc: { query: {} as Record<string, string> },
}));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, newsApi: { ...actual.newsApi, ...mockNews } };
});
vi.mock('preact-iso', async (importOriginal) => {
  const actual = await importOriginal<typeof import('preact-iso')>();
  return { ...actual, useLocation: () => ({ path: '/news', url: '/news', query: loc.query, route: () => {} }) };
});
const { News, NewsPostPage, PatchNotes } = await import('./News');

const post = (over: Partial<NewsPost> = {}): NewsPost => ({
  id: 3, kind: 'news', title: 'Season 1 starts Nov 3', body: 'Hello', excerpt: 'Hello',
  publishedAt: '2026-11-03T18:00:00.000Z', updatedAt: '2026-11-03T18:00:00.000Z',
  author: { steamid: '76561198000000001', name: 'Volence' }, ...over,
});

beforeEach(() => { mockNews.list.mockReset(); mockNews.post.mockReset(); loc.query = {}; });
afterEach(cleanup);

describe('the news list', () => {
  it('shows each post with its kind, a link and its excerpt', async () => {
    mockNews.list.mockResolvedValue({
      posts: [post(), post({ id: 2, kind: 'patch', title: 'Patch notes Oct 21', excerpt: 'Uzi back to 20' })],
      page: 1, pages: 1, total: 2,
    });
    render(<News />);
    const link = await screen.findByRole('link', { name: 'Season 1 starts Nov 3' });
    expect(link.getAttribute('href')).toBe('/news/3');
    expect(screen.getByText('Patch notes', { selector: '.news__kind' })).toBeTruthy();
    expect(screen.getByText('Uzi back to 20')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Pages' })).toBeNull();
  });

  it('pages with ?page=', async () => {
    loc.query = { page: '2' };
    mockNews.list.mockResolvedValue({ posts: [post()], page: 2, pages: 3, total: 21 });
    render(<News />);
    await screen.findByText('Page 2 of 3');
    expect(mockNews.list).toHaveBeenCalledWith(expect.anything(), 2, undefined, undefined);
    expect(screen.getByRole('link', { name: 'Newer' }).getAttribute('href')).toBe('/news');
    expect(screen.getByRole('link', { name: 'Older' }).getAttribute('href')).toBe('/news?page=3');
  });

  it('/patch-notes lists only patch notes, pages under its own path, and links the full change log', async () => {
    loc.query = { page: '2' };
    mockNews.list.mockResolvedValue({ posts: [post()], page: 2, pages: 3, total: 21 });
    render(<PatchNotes />);
    await screen.findByText('Page 2 of 3');
    expect(mockNews.list).toHaveBeenCalledWith(expect.anything(), 2, undefined, 'patch');
    expect(screen.getByRole('link', { name: 'Older' }).getAttribute('href')).toBe('/patch-notes?page=3');
    expect(screen.getByRole('link', { name: 'full change log' }).getAttribute('href')).toBe('/balance');
  });

  it('says so when nothing is posted', async () => {
    mockNews.list.mockResolvedValue({ posts: [], page: 1, pages: 1, total: 0 });
    render(<News />);
    await screen.findByText('Nothing posted yet.');
  });
});

describe('one news post', () => {
  it('renders the markdown subset and never raw HTML or a javascript: link', async () => {
    mockNews.post.mockResolvedValue({ post: post({
      body: '## What changes\n- **Ranks** from Bronze\n- [Rules](https://riversidepug.com/how-to-play)\n\n<script>window.pwned = 1</script> <b>bold?</b>\n[click](javascript:alert(1))',
    }) });
    const { container } = render(<NewsPostPage id="3" />);
    await screen.findByText('What changes');
    expect(container.querySelector('h4')?.textContent).toBe('What changes');
    expect(container.querySelector('li strong')?.textContent).toBe('Ranks');
    expect(screen.getByRole('link', { name: 'Rules' }).getAttribute('href')).toBe('https://riversidepug.com/how-to-play');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('.news__body b')).toBeNull();
    expect(container.textContent).toContain('<script>window.pwned = 1</script>');
    for (const a of Array.from(container.querySelectorAll('a'))) expect(a.getAttribute('href') ?? '').not.toMatch(/^javascript:/i);
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it('says a missing post is not found', async () => {
    mockNews.post.mockRejectedValue(new ApiError(404, 'no such post'));
    render(<NewsPostPage id="9" />);
    await screen.findByText('Post not found');
    await waitFor(() => expect(screen.getByRole('link', { name: 'All news' })).toBeTruthy());
  });
});
