import type { AddonsTransport } from '../../src/addonsTransport.js';

/** An in-memory addons directory, plus a way to make any call fail.
 *  Install is a retrying background job, so its tests need a transport that
 *  fails on demand and then stops failing.
 *
 *  `onPut` runs inside the (real, awaited) async `put` call, which is the
 *  same await window a slow FTP transfer would occupy in production. Tests
 *  that need something to happen concurrently with an in-flight install (an
 *  admin deleting the campaign, say) hook it there rather than racing real
 *  timers. */
export function fakeAddonsTransport(opts: { failPut?: boolean; onPut?: () => void } = {}) {
  const files = new Map<string, number>();
  const state = { failPut: opts.failPut ?? false, puts: 0 };
  const transport: AddonsTransport = {
    async put(_localPath, remoteName) {
      state.puts++;
      opts.onPut?.();
      if (state.failPut) throw new Error('connection refused');
      files.set(remoteName, 9);
    },
    async size(remoteName) { return files.get(remoteName) ?? null; },
    async remove(remoteName) { files.delete(remoteName); },
  };
  return { transport, files, state };
}
