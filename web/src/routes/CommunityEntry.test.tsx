import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import { ApiError, type CommunityEntryDetail } from '../api';
import type { Session } from '../hooks/useLiveState';

const { mockCommunity } = vi.hoisted(() => ({ mockCommunity: { get: vi.fn() } }));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, communityApi: { ...actual.communityApi, ...mockCommunity } };
});

const { CommunityEntry } = await import('./CommunityEntry');
const { LocationProvider } = await import('preact-iso');

const entry = (over: Partial<CommunityEntryDetail> = {}): CommunityEntryDetail => ({
  id: 11, kind: 'hud', title: 'Clean Modern', description: 'Low and tidy.', createdAt: '2026-09-24T01:00:00.000Z',
  author: { steamid: '76561190000000001', name: 'alice', avatar: null }, likes: 2, likedByMe: false,
  preset: 'modern', aspect: '16:9', advanced: false, importName: null,
  previewUrl: `/api/community/files/previews/${'a'.repeat(64)}.png`, design: { v: 1 }, importId: null, ...over,
});
const ANON: Session = { kind: 'anonymous' };
const MOD: Session = { kind: 'active', me: { steamid: '9', name: 'mod', avatar: null, status: 'active', isAdmin: false, isMod: true } };
const show = (session: Session, id = '11') =>
  render(<LocationProvider><CommunityEntry id={id} session={session} /></LocationProvider>);

beforeEach(() => { mockCommunity.get.mockReset(); });
afterEach(cleanup);

describe('the community entry page', () => {
  it('shows one entry, large', async () => {
    mockCommunity.get.mockResolvedValue(entry());
    const { container } = show(ANON);
    expect(await screen.findByRole('heading', { name: 'Clean Modern' })).toBeTruthy();
    expect(mockCommunity.get).toHaveBeenCalledWith(11, expect.anything());
    expect(container.querySelector('.ccard--large')).toBeTruthy();
  });

  it('says a removed or missing entry was removed', async () => {
    mockCommunity.get.mockRejectedValue(new ApiError(404, 'no such entry'));
    show(ANON);
    expect(await screen.findByText('This entry was removed.')).toBeTruthy();
  });

  it('says the same for an id that is not one, without asking', async () => {
    show(ANON, 'abc');
    expect(await screen.findByText('This entry was removed.')).toBeTruthy();
    expect(mockCommunity.get).not.toHaveBeenCalled();
  });

  it('shows staff who removed it and why', async () => {
    mockCommunity.get.mockResolvedValue(entry({ removed: { by: '9', reason: 'offensive preview', at: '2026-09-24T02:00:00.000Z' } }));
    show(MOD);
    expect(await screen.findByText(/offensive preview/)).toBeTruthy();
    expect(screen.getByText(/Removed by/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('shows staff a removed entry as evidence only: no open, download or like', async () => {
    mockCommunity.get.mockResolvedValue(entry({ removed: { by: '9', reason: 'offensive preview', at: '2026-09-24T02:00:00.000Z' } }));
    show(MOD);
    expect(await screen.findByRole('heading', { name: 'Clean Modern' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Open in the HUD editor' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Like/ })).toBeNull();
  });

  it("names the staff member who removed it when the server knows the name", async () => {
    mockCommunity.get.mockResolvedValue(entry({ removed: { by: '9', byName: 'ModMan', reason: 'offensive preview', at: '2026-09-24T02:00:00.000Z' } }));
    show(MOD);
    expect((await screen.findByRole('link', { name: 'ModMan' })).getAttribute('href')).toBe('/player/9');
  });

  it('says an author deleted their own entry', async () => {
    mockCommunity.get.mockResolvedValue(entry({ removed: { by: '76561190000000001', reason: null, at: '2026-09-24T02:00:00.000Z' } }));
    show(MOD);
    expect(await screen.findByText('Deleted by its author.')).toBeTruthy();
  });

  it("shows staff an updated entry's earlier versions, and a kept version the live one", async () => {
    mockCommunity.get.mockResolvedValue(entry({ versions: [{ id: 30, replacedAt: '2026-09-25T03:00:00.000Z' }] }));
    show(MOD);
    const link = await screen.findByRole('link', { name: '#30' });
    expect(link.getAttribute('href')).toBe('/community/30');
    expect(screen.getByText(/replaced 2026-09-25/)).toBeTruthy();
    cleanup();
    mockCommunity.get.mockResolvedValue(entry({
      id: 30, versionOf: 11, removed: { by: '76561190000000001', reason: 'Replaced by its author with a newer version.', at: '2026-09-25T03:00:00.000Z' },
    }));
    show(MOD, '30');
    expect((await screen.findByRole('link', { name: '#11' })).getAttribute('href')).toBe('/community/11');
    expect(screen.queryByText('Deleted by its author.')).toBeNull();
  });
});
