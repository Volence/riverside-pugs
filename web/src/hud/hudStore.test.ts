import { describe, it, expect } from 'vitest';
import { memoryStore, indexedDbStore, type StoredHud } from './hudStore';

const hud = (id: string, added: number): StoredHud => ({
  id, name: `hud ${id}`, files: new Map([['scripts/hudlayout.res', new Uint8Array([1, 2, 3])]]), bytes: 3, added,
});

describe('the imported HUD store', () => {
  it('gives back the files it was given, and a copy, not the same object', async () => {
    const s = memoryStore();
    const h = hud('a', 1);
    await s.put(h);
    const got = await s.get('a');
    expect(got).toEqual(h);
    got!.files.set('x', new Uint8Array(1));
    expect((await s.get('a'))!.files.has('x')).toBe(false);
    expect(await s.get('nope')).toBeUndefined();
  });

  it('keeps one entry per id, lists them oldest first without their files, and deletes', async () => {
    const s = memoryStore();
    await s.put(hud('b', 2)); await s.put(hud('a', 1)); await s.put({ ...hud('a', 1), name: 'renamed' });
    expect(await s.list()).toEqual([{ id: 'a', name: 'renamed', bytes: 3, added: 1 }, { id: 'b', name: 'hud b', bytes: 3, added: 2 }]);
    await s.delete('a');
    expect((await s.list()).map((m) => m.id)).toEqual(['b']);
  });

  it("lists what an import left out, so the download note can name it after a reload", async () => {
    const s = memoryStore();
    await s.put({ ...hud('a', 1), dropped: ['gameinfo.txt'] });
    expect((await s.list())[0].dropped).toEqual(['gameinfo.txt']);
    await s.put(hud('b', 2));
    expect('dropped' in (await s.list())[1]).toBe(false);
  });

  it('keeps which community entry an import came from, and lists it', async () => {
    const s = memoryStore();
    await s.put({ ...hud('a', 1), community: { entryId: 7 } });
    expect((await s.get('a'))!.community).toEqual({ entryId: 7 });
    expect((await s.list())[0].community).toEqual({ entryId: 7 });
    await s.put(hud('b', 2));
    expect('community' in (await s.list())[1]).toBe(false);
  });

  it('passes on the reason when IndexedDB will not open', async () => {
    const failing = { open: () => { const r: Record<string, unknown> = {}; queueMicrotask(() => { r.error = new Error('blocked'); (r.onerror as () => void)?.(); }); return r; } } as unknown as IDBFactory;
    await expect(indexedDbStore(failing).list()).rejects.toThrow('blocked');
  });
});
