import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { Session } from '../hooks/useLiveState';
import type { CommunityEntry, CommunityMine } from '../api';
import { validateDesign } from '../hud/design';
import type { SharePrepared } from './ShareDialog';

const { mockCommunity } = vi.hoisted(() => ({
  mockCommunity: { mine: vi.fn(), shareHud: vi.fn(), shareCrosshair: vi.fn() },
}));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, communityApi: { ...actual.communityApi, ...mockCommunity } };
});

const { ShareDialog } = await import('./ShareDialog');
const { ApiError } = await import('../api');

const me = { steamid: '76561190000000009', name: 'bob', avatar: null, status: 'active', isAdmin: false } as never;
const ACTIVE: Session = { kind: 'active', me };
const ANON: Session = { kind: 'anonymous' };

const entry = (id: number, title: string, kind: 'hud' | 'crosshair' = 'hud'): CommunityEntry & { removedByStaff: string | null } => ({
  id, kind, title, description: '', createdAt: '2026-09-24T01:00:00.000Z',
  author: { steamid: '76561190000000009', name: 'bob', avatar: null }, likes: 0, likedByMe: false, removedByStaff: null,
});
const mine = (entries: CommunityMine['entries'] = []): CommunityMine => ({
  entries, caps: { huds: 2, crosshairs: 2, perDay: 5, sharedToday: 0 },
});

const hudPrepared = (left: string[] = []): SharePrepared => ({
  kind: 'hud', name: '',
  hud: { design: validateDesign({ v: 1, name: 'mine', preset: 'modern' }), importFiles: null, left },
  preview: new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }),
  previewInfected: new Blob([new Uint8Array([137, 80, 78, 71, 1])], { type: 'image/png' }),
});

beforeEach(() => {
  for (const fn of Object.values(mockCommunity)) fn.mockReset();
  mockCommunity.mine.mockResolvedValue(mine());
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => ((b as Blob).size === 5 ? 'blob:infected' : 'blob:preview'));
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const open = (o: { session?: Session; prepare?: () => Promise<SharePrepared>; kind?: 'hud' | 'crosshair'; onShared?: (id: number) => void } = {}) =>
  render(
    <ShareDialog
      kind={o.kind ?? 'hud'} session={o.session ?? ACTIVE}
      prepare={o.prepare ?? (() => Promise.resolve(hudPrepared()))}
      onShared={o.onShared ?? (() => {})} onClose={() => {}}
    />,
  );
const title = () => screen.getByLabelText('Title') as HTMLInputElement;
const tick = () => fireEvent.click(screen.getByRole('checkbox'));
const shareBtn = () => screen.getByRole('button', { name: 'Share' }) as HTMLButtonElement;

describe('the share dialog', () => {
  it('asks an anonymous viewer to sign in with Steam, and reads nothing', async () => {
    const prepare = vi.fn(() => Promise.resolve(hudPrepared()));
    open({ session: ANON, prepare });
    expect(screen.getByText('Sign in with Steam to share.')).toBeTruthy();
    const link = screen.getByRole('link', { name: /sign in/i }) as HTMLAnchorElement;
    expect(link.getAttribute('href')!.startsWith('/auth/steam')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
    expect(mockCommunity.mine).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('at the cap says so, links to both entries and disables Share', async () => {
    mockCommunity.mine.mockResolvedValue(mine([entry(4, 'First one'), entry(5, 'Second one'), entry(6, 'A crosshair', 'crosshair')]));
    open();
    await screen.findByText('You are sharing 2 HUDs already. Delete one to share another.');
    expect(screen.getByRole('link', { name: 'First one' }).getAttribute('href')).toBe('/community/4');
    expect(screen.getByRole('link', { name: 'Second one' }).getAttribute('href')).toBe('/community/5');
    expect(screen.queryByRole('link', { name: 'A crosshair' })).toBeNull();
    fireEvent.input(title(), { target: { value: 'Third one' } });
    tick();
    expect(shareBtn().disabled).toBe(true);
  });

  it('does not count an entry staff removed toward the cap', async () => {
    mockCommunity.mine.mockResolvedValue(mine([entry(4, 'First one'), { ...entry(5, 'Gone one'), removedByStaff: 'rude' }]));
    open();
    await screen.findByAltText(/preview that will be shared/);
    expect(screen.queryByText(/already/)).toBeNull();
  });

  it('lists what the allowlist left out', async () => {
    open({ prepare: () => Promise.resolve(hudPrepared(['cfg/autoexec.cfg: not a HUD file'])) });
    await screen.findByText('Left out when sharing:');
    expect(screen.getByText('cfg/autoexec.cfg: not a HUD file')).toBeTruthy();
  });

  it('shows the preview it will upload', async () => {
    open();
    const img = await screen.findByAltText(/preview that will be shared/) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('blob:preview');
    fireEvent.click(screen.getByRole('button', { name: 'Infected' }));
    expect((screen.getByAltText(/preview that will be shared, infected side/) as HTMLImageElement).getAttribute('src')).toBe('blob:infected');
  });

  it('keeps Share off until the title has 3 characters and the box is ticked', async () => {
    open();
    await screen.findByAltText(/preview that will be shared/);
    expect(shareBtn().disabled).toBe(true);
    fireEvent.input(title(), { target: { value: 'ab' } });
    tick();
    expect(shareBtn().disabled).toBe(true);
    fireEvent.input(title(), { target: { value: 'abc' } });
    expect(shareBtn().disabled).toBe(false);
    tick();
    expect(shareBtn().disabled).toBe(true);
  });

  it('pre-fills the title from the name it was given', async () => {
    open({ prepare: () => Promise.resolve({ ...hudPrepared(), name: 'Low and tidy' }) });
    await waitFor(() => expect(title().value).toBe('Low and tidy'));
  });

  it('shares the HUD as a form, then links to the new entry', async () => {
    mockCommunity.shareHud.mockResolvedValue({ id: 42 });
    const onShared = vi.fn();
    open({ onShared });
    await screen.findByAltText(/preview that will be shared/);
    fireEvent.input(title(), { target: { value: 'Clean one' } });
    fireEvent.input(screen.getByLabelText('Description'), { target: { value: 'Tidy.' } });
    tick();
    fireEvent.click(shareBtn());
    await screen.findByText(/Shared\. See it on the/);
    expect(screen.getByRole('link', { name: 'community page' }).getAttribute('href')).toBe('/community/42');
    const form = mockCommunity.shareHud.mock.calls[0][0] as FormData;
    expect(form).toBeInstanceOf(FormData);
    const meta = JSON.parse(form.get('meta') as string);
    expect(meta).toMatchObject({ title: 'Clean one', description: 'Tidy.', permission: true });
    expect((form.get('preview') as Blob).size).toBe(4);
    expect((form.get('previewInfected') as Blob).size).toBe(5);
    expect(onShared).toHaveBeenCalledWith(42);
  });

  it('shares a crosshair as JSON with its art', async () => {
    mockCommunity.shareCrosshair.mockResolvedValue({ id: 7 });
    const art = { kind: 'built', state: { shape: 'dot' } } as never;
    open({ kind: 'crosshair', prepare: () => Promise.resolve({ kind: 'crosshair', name: '', art }) });
    await waitFor(() => expect(mockCommunity.mine).toHaveBeenCalled());
    fireEvent.input(title(), { target: { value: 'Tiny dot' } });
    tick();
    await waitFor(() => expect(shareBtn().disabled).toBe(false));
    fireEvent.click(shareBtn());
    await screen.findByText(/Shared\. See it on the/);
    expect(mockCommunity.shareCrosshair).toHaveBeenCalledWith({ title: 'Tiny dot', description: '', art, permission: true });
    expect(screen.queryByAltText(/preview that will be shared/)).toBeNull();
  });

  it("shows the server's refusal in .error", async () => {
    mockCommunity.shareHud.mockRejectedValue(new ApiError(400, 'That title is not allowed here.'));
    const { container } = open();
    await screen.findByAltText(/preview that will be shared/);
    fireEvent.input(title(), { target: { value: 'Clean one' } });
    tick();
    fireEvent.click(shareBtn());
    await waitFor(() => expect(container.querySelector('.error')?.textContent).toBe('That title is not allowed here.'));
  });

  it("shows prepare's refusal and keeps Share off", async () => {
    const { container } = open({ prepare: () => Promise.reject(new Error('This HUD is over the 50 MB cap.')) });
    await waitFor(() => expect(container.querySelector('.error')?.textContent).toBe('This HUD is over the 50 MB cap.'));
    fireEvent.input(title(), { target: { value: 'Clean one' } });
    tick();
    expect(shareBtn().disabled).toBe(true);
  });
});
