import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { NewsAdminPost, NewsEditorState } from '../../api';

const { mockNews } = vi.hoisted(() => ({
  mockNews: { editor: vi.fn(), create: vi.fn(), update: vi.fn(), publish: vi.fn(), unpublish: vi.fn(), remove: vi.fn() },
}));
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, newsApi: { ...actual.newsApi, ...mockNews } };
});
vi.mock('../../components/Confirm', () => ({ confirm: async () => true }));
const { AdminNews, PATCH_TEMPLATE, patchTitle } = await import('./AdminNews');

const saved = (over: Partial<NewsAdminPost> = {}): NewsAdminPost => ({
  id: 1, kind: 'news', title: 'Season 1', body: 'Hello', excerpt: 'Hello', publishedAt: null,
  updatedAt: '2026-10-20T12:00:00.000Z', createdAt: '2026-10-20T12:00:00.000Z', author: null,
  discord: 'none', discordError: null, ...over,
});
const state = (over: Partial<NewsEditorState> = {}): NewsEditorState => ({ posts: [], channelSet: true, botConnected: true, ...over });

const type = (label: string, value: string) =>
  fireEvent.input(screen.getByLabelText(label), { target: { value } });

beforeEach(() => { for (const f of Object.values(mockNews)) f.mockReset(); });
afterEach(cleanup);

describe('AdminNews', () => {
  it('says Discord is skipped when no news channel is set', async () => {
    mockNews.editor.mockResolvedValue(state({ channelSet: false }));
    render(<AdminNews />);
    await screen.findByText(/No news channel is set/);
  });

  it('prefills a dated title and the bullet template for patch notes', async () => {
    mockNews.editor.mockResolvedValue(state());
    render(<AdminNews />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Patch notes' }));
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe(patchTitle());
    expect((screen.getByLabelText('Body') as HTMLTextAreaElement).value).toBe(PATCH_TEMPLATE);
    expect(patchTitle(new Date(2026, 9, 21))).toBe('Patch notes Oct 21');
  });

  it('previews the body as the site shows it, with no raw HTML', async () => {
    mockNews.editor.mockResolvedValue(state());
    const { container } = render(<AdminNews />);
    await screen.findByLabelText('Body');
    type('Body', '**Big** news <img src=x onerror=alert(1)>');
    const preview = container.querySelector('.newsadmin__preview')!;
    expect(preview.querySelector('strong')?.textContent).toBe('Big');
    expect(preview.querySelector('img')).toBeNull();
    expect(preview.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('saves a new post and then publishes it', async () => {
    mockNews.editor.mockResolvedValue(state());
    const draft = saved();
    mockNews.create.mockResolvedValue(state({ posts: [draft], post: draft }));
    const live = saved({ publishedAt: '2026-10-20T12:01:00.000Z', discord: 'posted' });
    mockNews.publish.mockResolvedValue(state({ posts: [live], post: live }));
    render(<AdminNews />);
    await screen.findByLabelText('Title');
    type('Title', 'Season 1');
    type('Body', 'Hello');
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await screen.findByText(/Posted to Discord/, { selector: '.newsadmin__state' });
    expect(mockNews.create).toHaveBeenCalledWith({ kind: 'news', title: 'Season 1', body: 'Hello' });
    expect(mockNews.publish).toHaveBeenCalledWith(1);
    expect(screen.getByRole('button', { name: 'Unpublish' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
  });

  it('opens a post from the list and shows a Discord error', async () => {
    const p = saved({ publishedAt: '2026-10-20T12:01:00.000Z', discord: 'pending', discordError: 'Missing Access' });
    mockNews.editor.mockResolvedValue(state({ posts: [p] }));
    render(<AdminNews />);
    fireEvent.click(await screen.findByRole('button', { name: 'Season 1' }));
    await waitFor(() => expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Season 1'));
    expect(screen.getByText(/Discord said: Missing Access/)).toBeTruthy();
  });

  it('deletes and goes back to a blank post', async () => {
    const p = saved();
    mockNews.editor.mockResolvedValue(state({ posts: [p] }));
    mockNews.remove.mockResolvedValue(state({ posts: [], post: null }));
    render(<AdminNews />);
    fireEvent.click(await screen.findByRole('button', { name: 'Season 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await screen.findByText('Nothing written yet.');
    expect(mockNews.remove).toHaveBeenCalledWith(1);
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('');
  });
});
