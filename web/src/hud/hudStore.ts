/**
 * The HUDs a player imported, kept in this browser.
 *
 * An import is up to 50 MB of files, far past what localStorage holds, so it
 * lives in IndexedDB, one record per id (upload.ts's hudId): importing the
 * same HUD twice overwrites one record. The design itself stores only the
 * id and name. The page reads the design's import from here into base's
 * in-memory registry before it first draws.
 *
 * The backend is injectable: tests, and a browser without IndexedDB (happy-dom,
 * or a private window that refuses it), use memoryStore, which keeps imports
 * for as long as the page is open. No fake-indexeddb dependency is needed.
 */
export interface StoredHud { id: string; name: string; files: Map<string, Uint8Array>; bytes: number; added: number }
export type HudMeta = Omit<StoredHud, 'files'>;
export interface HudStore {
  get(id: string): Promise<StoredHud | undefined>;
  put(hud: StoredHud): Promise<void>;
  /** Every import, oldest first, without its files. */
  list(): Promise<HudMeta[]>;
  delete(id: string): Promise<void>;
}

const meta = ({ id, name, bytes, added }: StoredHud): HudMeta => ({ id, name, bytes, added });
const byAdded = (a: HudMeta, b: HudMeta) => a.added - b.added || (a.id < b.id ? -1 : 1);

export function memoryStore(): HudStore {
  const rows = new Map<string, StoredHud>();
  return {
    async get(id) { const r = rows.get(id); return r && structuredClone(r); },
    async put(h) { rows.set(h.id, structuredClone(h)); },
    async list() { return [...rows.values()].map(meta).sort(byAdded); },
    async delete(id) { rows.delete(id); },
  };
}

const DB = 'hud-editor';
const STORE = 'imports';

export function indexedDbStore(idb: IDBFactory = indexedDB): HudStore {
  let db: Promise<IDBDatabase> | null = null;
  const open = () => (db ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = idb.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE, { keyPath: 'id' }); };
    r.onsuccess = () => resolve(r.result);
    // Forget the failed open, so a later call tries again rather than
    // failing for ever on one refusal.
    r.onerror = () => { db = null; reject(r.error ?? new Error('This browser would not open its storage')); };
  }));
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const store = (await open()).transaction(STORE, mode).objectStore(STORE);
    return new Promise<T>((resolve, reject) => {
      const q = fn(store);
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error ?? new Error('This browser would not store the HUD'));
    });
  };
  return {
    get: (id) => run('readonly', (s) => s.get(id)) as Promise<StoredHud | undefined>,
    put: async (h) => { await run('readwrite', (s) => s.put(h)); },
    list: async () => ((await run('readonly', (s) => s.getAll())) as StoredHud[]).map(meta).sort(byAdded),
    delete: async (id) => { await run('readwrite', (s) => s.delete(id)); },
  };
}

let current: HudStore | null = null;
/** The page's store: IndexedDB where the browser has it, memory otherwise. */
export function hudStore(): HudStore {
  return (current ??= typeof indexedDB === 'undefined' ? memoryStore() : indexedDbStore());
}
/** Test seam: use this store, or (null) go back to the default. */
export function _setHudStore(s: HudStore | null): void { current = s; }
