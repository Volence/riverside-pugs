import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { addServer, getServer, markLive } from '../src/serverPool.js';
import { ServerReleaser, type PasswordClearer } from '../src/serverRelease.js';

function seedServer(db: ReturnType<typeof openDb>): number {
  return addServer(db, {
    name: 'test', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x',
  });
}

describe('ServerReleaser', () => {
  it('marks the server idle and clears the password', async () => {
    const db = openDb(':memory:');
    const id = seedServer(db);
    markLive(db, id);
    const cleared: string[] = [];
    const clear: PasswordClearer = async (s) => { cleared.push(s.name); };

    const releaser = new ServerReleaser(db, clear);
    releaser.release(id);

    expect(getServer(db, id)!.status).toBe('idle');
    await new Promise((r) => setImmediate(r));
    expect(cleared).toEqual(['test']);
  });

  it('notifies every registered waiter that a box freed', () => {
    const db = openDb(':memory:');
    const id = seedServer(db);
    markLive(db, id);
    const calls: number[] = [];
    const releaser = new ServerReleaser(db, async () => {});
    releaser.onFreed(() => calls.push(1));
    releaser.onFreed(() => calls.push(2));

    releaser.release(id);

    expect(calls).toEqual([1, 2]);
  });

  it('still frees the row when clearing the password throws', async () => {
    const db = openDb(':memory:');
    const id = seedServer(db);
    markLive(db, id);
    const releaser = new ServerReleaser(db, async () => { throw new Error('rcon down'); });

    releaser.release(id);

    expect(getServer(db, id)!.status).toBe('idle');
    await new Promise((r) => setImmediate(r));
  });

  it('is a no-op for a server id that does not exist', () => {
    const db = openDb(':memory:');
    const releaser = new ServerReleaser(db, async () => {});
    expect(() => releaser.release(999)).not.toThrow();
  });
});
