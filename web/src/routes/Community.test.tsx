import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import type { CommunityEntry } from '../api';
import type { Session } from '../hooks/useLiveState';
import { TEX, resetGameBackdrops } from '../crosshair/draw';

const { mockCommunity, mockApi, mockDownload } = vi.hoisted(() => ({
  mockCommunity: { list: vi.fn(), get: vi.fn(), like: vi.fn(), unlike: vi.fn(), remove: vi.fn(), delete: vi.fn(), mine: vi.fn() },
  mockApi: { fileReport: vi.fn() },
  mockDownload: { downloadCommunityHud: vi.fn(), downloadCommunityCrosshair: vi.fn() },
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: { ...actual.api, ...mockApi }, communityApi: { ...actual.communityApi, ...mockCommunity } };
});
vi.mock('../community/download', () => mockDownload);

const { Community } = await import('./Community');
const { LocationProvider } = await import('preact-iso');

const PREVIEW = `/api/community/files/previews/${'a'.repeat(64)}.png`;
const hud = (over: Partial<CommunityEntry> = {}): CommunityEntry => ({
  id: 11, kind: 'hud', title: 'Clean Modern', description: 'Low and tidy.', createdAt: '2026-09-24T01:00:00.000Z',
  author: { steamid: '76561190000000001', name: 'alice', avatar: null }, likes: 2, likedByMe: false,
  preset: 'modern', aspect: '16:9', advanced: false, importName: null, previewUrl: PREVIEW, ...over,
});
const xhair = (over: Partial<CommunityEntry> = {}): CommunityEntry => ({
  id: 21, kind: 'crosshair', title: 'Tiny dot', description: '', createdAt: '2026-09-24T01:00:00.000Z',
  author: { steamid: '76561190000000001', name: 'alice', avatar: null }, likes: 0, likedByMe: false,
  art: { kind: 'built', state: { shape: 'dot' } }, ...over,
});
const page = (entries: CommunityEntry[], total = entries.length) => ({ entries, page: 0, pageSize: 24, total });

const me = (over: Record<string, unknown> = {}) => ({ steamid: '76561190000000009', name: 'bob', avatar: null, status: 'active', isAdmin: false, ...over });
const ACTIVE: Session = { kind: 'active', me: me() };
const ANON: Session = { kind: 'anonymous' };

const show = (session: Session) => render(<LocationProvider><Community session={session} /></LocationProvider>);

/** happy-dom has no 2D context: one that does nothing, remembering what it was asked. */
function stubCanvas() {
  const calls: string[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => new Proxy({}, {
    get: (_t, k) => (..._a: unknown[]) => {
      calls.push(String(k));
      if (k === 'getImageData') return { data: new Uint8ClampedArray(TEX * TEX * 4) };
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return { addColorStop() {} };
      return undefined;
    },
    set: () => true,
  }) as never);
  return calls;
}

const stay = (e: Event) => { if ((e.target as Element).closest?.('a')) e.preventDefault(); };
beforeEach(() => {
  for (const fn of [...Object.values(mockCommunity), ...Object.values(mockApi), ...Object.values(mockDownload)]) fn.mockReset();
  mockCommunity.list.mockResolvedValue(page([hud()]));
  document.addEventListener('click', stay);
});
afterEach(() => {
  cleanup();
  document.removeEventListener('click', stay);
  history.replaceState(null, '', '/');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetGameBackdrops();
});

describe('the community page', () => {
  it('offers All, Yours and Liked to a signed-in viewer only, and asks the list for each', async () => {
    show(ANON);
    await screen.findByText('Clean Modern');
    expect(screen.queryByRole('tab', { name: 'Yours' })).toBeNull();
    cleanup();
    mockCommunity.list.mockClear();
    show(ACTIVE);
    await screen.findByText('Clean Modern');
    fireEvent.click(screen.getByRole('tab', { name: 'Yours' }));
    await waitFor(() => expect(mockCommunity.list).toHaveBeenLastCalledWith(
      { kind: 'hud', sort: 'new', page: 0, author: '76561190000000009' }, expect.anything()));
    mockCommunity.list.mockResolvedValue(page([]));
    fireEvent.click(screen.getByRole('tab', { name: 'Liked' }));
    await waitFor(() => expect(mockCommunity.list).toHaveBeenLastCalledWith(
      { kind: 'hud', sort: 'new', page: 0, liked: true }, expect.anything()));
    expect(await screen.findByText('You have not liked any HUDs yet.')).toBeTruthy();
  });

  it('lists HUD cards: title, author link, preview and base badge', async () => {
    const { container } = show(ANON);
    expect(await screen.findByText('Clean Modern')).toBeTruthy();
    expect(mockCommunity.list).toHaveBeenCalledWith({ kind: 'hud', sort: 'new', page: 0 }, expect.anything());
    expect(screen.getByText('Low and tidy.')).toBeTruthy();
    expect((screen.getByRole('link', { name: 'alice' }) as HTMLAnchorElement).getAttribute('href')).toBe('/player/76561190000000001');
    expect(container.querySelector(`img[src="${PREVIEW}"]`)).toBeTruthy();
    expect(screen.getByText('Riverside Modern')).toBeTruthy();
  });

  it('names an imported base and an Advanced install', async () => {
    mockCommunity.list.mockResolvedValue(page([hud({ preset: 'imported', importName: 'edgehud', advanced: true })]));
    show(ANON);
    expect(await screen.findByText('Imported: edgehud')).toBeTruthy();
    expect(screen.getByText('Advanced install')).toBeTruthy();
  });

  it('renders a hostile title as text', async () => {
    mockCommunity.list.mockResolvedValue(page([hud({ title: '<img src=x onerror=alert(1)>' })]));
    const { container } = show(ANON);
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(container.querySelector('img[src="x"]')).toBeNull();
  });

  it('switches to crosshairs and draws each one', async () => {
    const calls = stubCanvas();
    const { container } = show(ANON);
    await screen.findByText('Clean Modern');
    mockCommunity.list.mockResolvedValue(page([xhair(), xhair({ id: 22, title: 'Big cross' })]));
    fireEvent.click(screen.getByRole('tab', { name: 'Crosshairs' }));
    await screen.findByText('Big cross');
    expect(mockCommunity.list).toHaveBeenLastCalledWith({ kind: 'crosshair', sort: 'new', page: 0 }, expect.anything());
    expect(container.querySelectorAll('canvas.ccard__xhair').length).toBe(2);
    await waitFor(() => expect(calls).toContain('arc'));
  });

  it('draws crosshairs on the drawn saferoom until the forest shot loads, then on the shot', async () => {
    const calls = stubCanvas();
    const images: { src: string; onload: (() => void) | null }[] = [];
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 1920; naturalHeight = 1080;
      src = '';
      constructor() { images.push(this); }
    });
    mockCommunity.list.mockResolvedValue(page([xhair()]));
    history.replaceState(null, '', '/community?kind=crosshair');
    show(ANON);
    await screen.findByText('Tiny dot');
    await waitFor(() => expect(calls).toContain('createLinearGradient'));
    expect(calls).not.toContain('drawImage');
    const shot = images.find((i) => i.src === '/hud-backdrops/survivor-hilltop.jpg');
    expect(shot).toBeTruthy();
    calls.length = 0;
    shot!.onload!();
    await waitFor(() => expect(calls).toContain('drawImage'));
    expect(calls).not.toContain('createLinearGradient');
    expect(calls).toContain('arc');
  });

  it('sorts by Top', async () => {
    show(ANON);
    await screen.findByText('Clean Modern');
    fireEvent.click(screen.getByRole('tab', { name: 'Top' }));
    await waitFor(() => expect(mockCommunity.list).toHaveBeenLastCalledWith({ kind: 'hud', sort: 'top', page: 0 }, expect.anything()));
  });

  it('pages with Next and Previous', async () => {
    mockCommunity.list.mockResolvedValue(page([hud()], 30));
    show(ANON);
    await screen.findByText('Clean Modern');
    expect((screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(mockCommunity.list).toHaveBeenLastCalledWith({ kind: 'hud', sort: 'new', page: 1 }, expect.anything()));
  });

  describe('likes', () => {
    it('are disabled for a visitor who is not signed in', async () => {
      show(ANON);
      const like = await screen.findByRole('button', { name: /Like/ }) as HTMLButtonElement;
      expect(like.disabled).toBe(true);
      expect(like.title).toBe('Sign in to like');
    });

    it('count one more once an active player likes', async () => {
      mockCommunity.like.mockResolvedValue({ likes: 3, likedByMe: true });
      show(ACTIVE);
      fireEvent.click(await screen.findByRole('button', { name: /Like/ }));
      await waitFor(() => expect(mockCommunity.like).toHaveBeenCalledWith(11));
      expect(await screen.findByRole('button', { name: /Liked, 3/ })).toBeTruthy();
    });

    it('are not offered on your own entry', async () => {
      show({ kind: 'active', me: me({ steamid: '76561190000000001' }) });
      await screen.findByText('Clean Modern');
      expect(screen.queryByRole('button', { name: /Like/ })).toBeNull();
      expect(screen.getByText('2 likes')).toBeTruthy();
    });
  });

  it('offers Remove to staff only, asks for a reason, and removes', async () => {
    const first = show(ACTIVE);
    await screen.findByText('Clean Modern');
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    first.unmount();
    mockCommunity.remove.mockResolvedValue({ ok: true });
    show({ kind: 'active', me: me({ isMod: true }) });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    const confirmBtn = screen.getByRole('button', { name: 'Remove entry' }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    fireEvent.input(screen.getByLabelText('Reason for removal'), { target: { value: 'offensive preview' } });
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(mockCommunity.remove).toHaveBeenCalledWith(11, 'offensive preview'));
    expect(await screen.findByText('Removed.')).toBeTruthy();
  });

  it('reports the author about the entry', async () => {
    mockApi.fileReport.mockResolvedValue({ ok: true });
    show(ACTIVE);
    fireEvent.click(await screen.findByRole('button', { name: 'Report' }));
    expect(screen.getByText("About their shared HUD 'Clean Modern'")).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'toxicity' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(mockApi.fileReport).toHaveBeenCalledWith(
      { targetId: '76561190000000001', category: 'toxicity', text: '', entryId: 11 }));
  });

  it('opens a HUD in the editor by link', async () => {
    show(ANON);
    const open = await screen.findByRole('link', { name: 'Open in the HUD editor' }) as HTMLAnchorElement;
    expect(open.getAttribute('href')).toBe('/hud?community=11');
  });

  it('offers the crosshair maker and the HUD editor for a crosshair', async () => {
    stubCanvas();
    history.replaceState(null, '', '/community?kind=crosshair');
    mockCommunity.list.mockResolvedValue(page([xhair()]));
    show(ANON);
    const card = (await screen.findByText('Tiny dot')).closest('article')!;
    expect((within(card as HTMLElement).getByRole('link', { name: 'Open in the crosshair maker' }) as HTMLAnchorElement).getAttribute('href')).toBe('/crosshair?community=21');
    expect((within(card as HTMLElement).getByRole('link', { name: 'Use in my HUD' }) as HTMLAnchorElement).getAttribute('href')).toBe('/hud?xhair=21');
    mockDownload.downloadCommunityCrosshair.mockResolvedValue({ filename: 'Tiny_dot.vpk' });
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: 'Download .vpk' }));
    await waitFor(() => expect(mockDownload.downloadCommunityCrosshair).toHaveBeenCalledWith(expect.objectContaining({ id: 21 })));
  });

  it('downloads a HUD through the lazy module, with its design', async () => {
    const detail = { ...hud(), design: { v: 1 } };
    mockCommunity.get.mockResolvedValue(detail);
    mockDownload.downloadCommunityHud.mockResolvedValue({ filename: 'Clean Modern.vpk' });
    show(ANON);
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    await waitFor(() => expect(mockDownload.downloadCommunityHud).toHaveBeenCalledWith(detail));
    expect(await screen.findByText(/Saved Clean Modern.vpk/)).toBeTruthy();
  });

  it('says so when nothing is shared yet', async () => {
    mockCommunity.list.mockResolvedValue(page([]));
    show(ANON);
    expect(await screen.findByText(/No HUDs shared yet/)).toBeTruthy();
  });
});
