import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/preact';
import Hud from './Hud';
import { ConfirmHost } from '../components/Confirm';
import { communityApi, ApiError, type CommunityEntryDetail } from '../api';
import { encodeVPK } from '../vpk';
import { memoryStore, _setHudStore, type HudStore } from '../hud/hudStore';
import { unregisterImport, registerImport, isCommunityImport } from '../hud/base';
import { hudId } from '../hud/upload';
import { sampleHud, asList } from '../hud/importFixtures';
import { validateDesign } from '../hud/design';
import { shareableHudFiles } from '../../../src/hudFiles';

// openCommunityImport runs for real unless a test hands in its own.
const opener = vi.hoisted(() => ({ fn: null as null | ((e: unknown) => Promise<unknown>) }));
vi.mock('../community/open', async (original) => {
  const m = await original<typeof import('../community/open')>();
  return { ...m, openCommunityImport: (e: never) => (opener.fn ? opener.fn(e) : m.openCommunityImport(e)) };
});

// A HUD whose every file passes the allowlist, so it can carry the community flag and still build.
const files = shareableHudFiles(sampleHud()).kept;
let id = '';
let store: HudStore;

beforeEach(async () => {
  localStorage.clear();
  location.hash = '';
  store = memoryStore();
  _setHudStore(store);
  id = await hudId(files);
  opener.fn = null;
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  history.replaceState(null, '', '/');
  _setHudStore(null);
  unregisterImport(id);
  vi.restoreAllMocks();
});

const preset = () => screen.getByRole('combobox', { name: /preset/i }) as HTMLSelectElement;
const shareBtn = () => screen.getByRole('button', { name: 'Share to community...' }) as HTMLButtonElement;
const saved = () => JSON.parse(localStorage.getItem('hud') ?? 'null');
const detail = (over: Partial<CommunityEntryDetail>): CommunityEntryDetail => ({
  id: 5, kind: 'hud', title: 'Clean Modern', description: '', createdAt: '2026-09-24T01:00:00.000Z',
  author: { steamid: '76561190000000001', name: 'alice', avatar: null }, likes: 0, likedByMe: false, ...over,
});
/** A saved design with an edit, so loading another asks first. */
const MINE = { v: 1, name: 'mine', crosshair: 'none', elements: { chat: { x: 5 } } };
const show = () => render(<><ConfirmHost /><Hud /></>);

describe('Share to community in the HUD editor', () => {
  it('is on the toolbar, and off while the design is locked', async () => {
    show();
    expect(shareBtn().disabled).toBe(false);
    cleanup();
    localStorage.setItem('hud', JSON.stringify({ v: 1, name: 'mine', preset: 'imported', imported: { id, name: 'edgehud' } }));
    show();
    await screen.findByText(/Import it again to edit or download it/);
    expect(shareBtn().disabled).toBe(true);
  });

  it('opens the dialog, which asks an anonymous viewer to sign in', () => {
    show();
    fireEvent.click(shareBtn());
    expect(screen.getByText('Sign in with Steam to share.')).toBeTruthy();
  });
});

describe('/hud?community=', () => {
  const MODERN = { v: 1, name: 'theirs', preset: 'modern', crosshair: 'none', elements: { chat: { x: 40 } } };

  it('asks, loads the design as one undoable step, and strips the parameter', async () => {
    localStorage.setItem('hud', JSON.stringify(MINE));
    vi.spyOn(communityApi, 'get').mockResolvedValue(detail({ design: MODERN }));
    history.replaceState(null, '', '/hud?community=5');
    show();
    await screen.findByText('Load the HUD design from this link? It will replace the one saved on this browser.');
    expect(communityApi.get).toHaveBeenCalledWith(5);
    expect(location.search).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Load link' }));
    await waitFor(() => expect(preset().value).toBe('modern'));
    await waitFor(() => expect(saved()).toEqual(JSON.parse(JSON.stringify(validateDesign(MODERN)))));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(preset().value).toBe('stock'));
    await waitFor(() => expect(saved().elements.chat.x).toBe(5));
  });

  it('leaves the design alone on Keep mine', async () => {
    localStorage.setItem('hud', JSON.stringify(MINE));
    vi.spyOn(communityApi, 'get').mockResolvedValue(detail({ design: MODERN }));
    history.replaceState(null, '', '/hud?community=5');
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Keep mine' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(preset().value).toBe('stock');
  });

  it('says so when the entry was removed', async () => {
    vi.spyOn(communityApi, 'get').mockRejectedValue(new ApiError(404, 'Not found'));
    history.replaceState(null, '', '/hud?community=9');
    show();
    await screen.findByText('That community entry was removed.');
    expect(location.search).toBe('');
  });

  describe('an entry on an imported HUD', () => {
    const onImport = () => ({ v: 1, name: 'theirs', preset: 'imported', imported: { id, name: 'edgehud' }, crosshair: 'none' });

    it('opens its import before the design applies', async () => {
      const seen: string[] = [];
      opener.fn = async (e) => {
        seen.push(preset().value);
        expect(e).toMatchObject({ id: 6, importId: id });
        registerImport(id, files, { community: true });
        await store.put({ id, name: 'Clean Modern', files, bytes: 1, added: 1, community: { entryId: 6 } });
        return { id, name: 'Clean Modern', kept: true };
      };
      vi.spyOn(communityApi, 'get').mockResolvedValue(detail({ id: 6, design: onImport(), importId: id }));
      history.replaceState(null, '', '/hud?community=6');
      show();
      await waitFor(() => expect(preset().value).toBe(`imported:${id}`));
      expect(seen).toHaveLength(1);
      expect(seen[0]).toBe('stock');
      expect(screen.getByRole('option', { name: 'Imported: Clean Modern' })).toBeTruthy();
      expect(isCommunityImport(`imported:${id}`)).toBe(true);
    });

    it('on a refusal shows the sentence and leaves the design as it was', async () => {
      localStorage.setItem('hud', JSON.stringify(MINE));
      opener.fn = () => Promise.reject(new Error('This community HUD failed its safety check, so nothing from it was used.'));
      vi.spyOn(communityApi, 'get').mockResolvedValue(detail({ id: 6, design: onImport(), importId: id }));
      history.replaceState(null, '', '/hud?community=6');
      show();
      await screen.findByText('This community HUD failed its safety check, so nothing from it was used.');
      expect(preset().value).toBe('stock');
      expect(saved().elements.chat.x).toBe(5);
    });

    it('refuses a design that names another import than the entry', async () => {
      opener.fn = vi.fn();
      vi.spyOn(communityApi, 'get').mockResolvedValue(detail({ id: 6, design: onImport(), importId: 'b'.repeat(64) }));
      history.replaceState(null, '', '/hud?community=6');
      show();
      await screen.findByText('This community HUD failed its safety check, so nothing from it was used.');
      expect(opener.fn).not.toHaveBeenCalled();
      expect(preset().value).toBe('stock');
    });
  });
});

describe('/hud?xhair=', () => {
  const ART = { kind: 'built', state: { shape: 'circle', radius: 9, color: '#ffe14d', len: 7, thick: 2, gap: 3, dot: 2, round: false, alpha: 100, outline: 1, oalpha: 80, backdrop: 'scene', res: '1080' } };

  it("sets the entry's crosshair as one undoable step, selected", async () => {
    localStorage.setItem('hud', JSON.stringify(MINE));
    vi.spyOn(communityApi, 'get').mockResolvedValue(detail({ id: 7, kind: 'crosshair', title: 'Ring', art: ART }));
    history.replaceState(null, '', '/hud?xhair=7');
    show();
    await waitFor(() => expect((screen.getByRole('slider', { name: 'Radius' }) as HTMLInputElement).value).toBe('9'));
    expect(location.search).toBe('');
    expect((screen.getByRole('radio', { name: /^custom/i }) as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect(saved().xhairArt).toEqual(ART));
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    expect((screen.getByRole('radio', { name: /game default/i }) as HTMLInputElement).checked).toBe(true);
  });

  it('says so when the crosshair cannot be drawn', async () => {
    vi.spyOn(communityApi, 'get').mockResolvedValue(detail({ id: 7, kind: 'crosshair', art: { kind: 'nope' } }));
    history.replaceState(null, '', '/hud?xhair=7');
    show();
    await screen.findByText('This crosshair cannot be drawn.');
  });
});

describe('the community flag across reloads', () => {
  const vpkFile = () => new File([encodeVPK(asList(files))], 'edgehud.vpk');
  const onImport = () => validateDesign({ v: 1, name: 'theirs', preset: 'imported', imported: { id, name: 'edgehud' }, crosshair: 'none' });
  beforeEach(async () => {
    await store.put({ id, name: 'edgehud', files, bytes: 1, added: 1, community: { entryId: 5 } });
  });

  it('re-registers a stored community import with the flag after reload', async () => {
    localStorage.setItem('hud', JSON.stringify(onImport()));
    show();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Teammates' })).toBeTruthy());
    expect(isCommunityImport(`imported:${id}`)).toBe(true);

    cleanup();
    unregisterImport(id);
    localStorage.clear();
    show();
    await screen.findByRole('option', { name: 'Imported: edgehud' });
    fireEvent.change(preset(), { target: { value: `imported:${id}` } });
    await waitFor(() => expect(preset().value).toBe(`imported:${id}`));
    expect(isCommunityImport(`imported:${id}`)).toBe(true);
  });

  it('a private re-import keeps the stored community marker', async () => {
    show();
    fireEvent.change(screen.getByLabelText('Import a HUD file'), { target: { files: [vpkFile()] } });
    await screen.findByText(/^Imported edgehud\./);
    expect((await store.get(id))?.community).toEqual({ entryId: 5 });
    expect(isCommunityImport(`imported:${id}`)).toBe(true);
  });
});
