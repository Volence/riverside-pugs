import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { openCommunityImport, SAFETY_FAILED, FILES_GONE } from './open';
import { _setHudStore, memoryStore, hudStore } from '../hud/hudStore';
import { hasImport, isCommunityImport, unregisterImport } from '../hud/base';
import { encodeVPK } from '../vpk';
import { sampleHud, latin1, asList } from '../hud/importFixtures';
import { hudId, shareableHudFiles } from '../../../src/hudFiles';

/** A HUD a community entry can hold: the fixture's shareable part. */
const good = () => shareableHudFiles(sampleHud()).kept;
const withCfg = () => { const f = good(); f.set('cfg/autoexec.cfg', latin1('bind x quit\n')); return f; };

const used = new Set<string>();
const serve = (bytes: Uint8Array, status = 200) => {
  const fetchMock = vi.fn(async () => new Response(status === 200 ? bytes.slice() : 'gone', { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

beforeEach(() => { _setHudStore(memoryStore()); });
afterEach(() => {
  for (const id of used) unregisterImport(id);
  used.clear();
  _setHudStore(null);
  vi.unstubAllGlobals();
});

async function entryFor(files: Map<string, Uint8Array>, over: Partial<{ importId: string }> = {}) {
  const id = await hudId(files);
  used.add(id);
  return { id: 5, title: 'Edge <HUD>!', importId: id, ...over };
}

describe('openCommunityImport', () => {
  it('fetches, verifies, registers with the community flag, and stores with the entry', async () => {
    const files = good();
    const entry = await entryFor(files);
    const fetchMock = serve(encodeVPK(asList(files)));
    const out = await openCommunityImport(entry);
    expect(out).toEqual({ id: entry.importId, name: 'Edge HUD', kept: true });
    expect(fetchMock).toHaveBeenCalledWith(`/api/community/files/imports/${entry.importId}.vpk`);
    expect(isCommunityImport(`imported:${entry.importId}`)).toBe(true);
    const stored = await hudStore().get(entry.importId);
    expect(stored?.community).toEqual({ entryId: 5 });
    expect(stored?.name).toBe('Edge HUD');
    expect([...stored!.files.keys()].sort()).toEqual([...files.keys()].sort());
  });

  it('does not fetch a blob already in the store', async () => {
    const files = good();
    const entry = await entryFor(files);
    await hudStore().put({ id: entry.importId, name: 'mine', files, bytes: 1, added: 1, community: { entryId: 5 } });
    const fetchMock = serve(new Uint8Array());
    await openCommunityImport(entry);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isCommunityImport(`imported:${entry.importId}`)).toBe(true);
  });

  it('openCommunityImport rechecks and flags files already in the store', async () => {
    const files = good();
    const entry = await entryFor(files);
    // Imported privately earlier: no community marker.
    await hudStore().put({ id: entry.importId, name: 'mine', files, bytes: 1, added: 1 });
    const fetchMock = serve(new Uint8Array());
    await openCommunityImport(entry);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isCommunityImport(`imported:${entry.importId}`)).toBe(true);
    const stored = await hudStore().get(entry.importId);
    expect(stored?.community).toEqual({ entryId: 5 });
    expect(stored?.name).toBe('mine');

    const bad = withCfg();
    const badEntry = await entryFor(bad);
    await hudStore().put({ id: badEntry.importId, name: 'bad', files: bad, bytes: 1, added: 1 });
    await expect(openCommunityImport(badEntry)).rejects.toThrow(SAFETY_FAILED);
    expect(hasImport(badEntry.importId)).toBe(false);
    expect((await hudStore().get(badEntry.importId))?.community).toBeUndefined();
  });

  it('refuses a blob with a file outside the allowlist, and keeps nothing', async () => {
    const bad = withCfg();
    const entry = await entryFor(bad);
    serve(encodeVPK(asList(bad)));
    await expect(openCommunityImport(entry)).rejects.toThrow(SAFETY_FAILED);
    expect(hasImport(entry.importId)).toBe(false);
    expect(await hudStore().get(entry.importId)).toBeUndefined();
  });

  it("refuses a blob whose hash is not the entry's import id", async () => {
    const files = good();
    const other = 'a'.repeat(64);
    const entry = await entryFor(files, { importId: other });
    used.add(other);
    serve(encodeVPK(asList(files)));
    await expect(openCommunityImport(entry)).rejects.toThrow(SAFETY_FAILED);
    expect(hasImport(other)).toBe(false);
    expect(await hudStore().get(other)).toBeUndefined();
  });

  it('refuses bytes that are not a VPK, and an entry with no import id', async () => {
    const entry = await entryFor(good());
    serve(latin1('<html>not a vpk</html>'));
    await expect(openCommunityImport(entry)).rejects.toThrow(SAFETY_FAILED);
    await expect(openCommunityImport({ id: 1, title: 'x', importId: null })).rejects.toThrow(SAFETY_FAILED);
  });

  it('says the files are gone on a 404', async () => {
    const entry = await entryFor(good());
    serve(new Uint8Array(), 404);
    await expect(openCommunityImport(entry)).rejects.toThrow(FILES_GONE);
  });

  it('still opens the import when this browser will not store it, and says so', async () => {
    const files = good();
    const entry = await entryFor(files);
    const store = memoryStore();
    _setHudStore({ ...store, put: async () => { throw new Error('quota'); } });
    serve(encodeVPK(asList(files)));
    const out = await openCommunityImport(entry);
    expect(out.kept).toBe(false);
    expect(isCommunityImport(`imported:${entry.importId}`)).toBe(true);
  });
});
