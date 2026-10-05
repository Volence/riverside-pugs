import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeServerCleaner, type CleanerRcon } from '../src/serverCleaner.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import type { ServerRow } from '../src/serverPool.js';

const SERVER = { id: 1, name: 'Dallas', host: '10.0.0.1', rcon_port: 27015, rcon_password: 'pw' } as unknown as ServerRow;

/** A scripted rcon: one entry per connection, in order. */
function fakeRcon(script: Array<Partial<CleanerRcon> & { log: string[] }>) {
  let n = 0;
  return (): CleanerRcon => {
    const me = script[n++];
    if (!me) throw new Error('more connections than scripted');
    return {
      connect: me.connect ?? (async () => { me.log.push('connect'); }),
      exec: me.exec ?? (async (cmd) => { me.log.push(`exec ${cmd}`); return ''; }),
      send: me.send ?? (async (cmd) => { me.log.push(`send ${cmd}`); }),
      waitClosed: me.waitClosed ?? (async (ms) => { me.log.push(`waitClosed ${ms}`); return true; }),
      close: me.close ?? (() => { me.log.push('close'); }),
    };
  };
}
const passwordReply = (v: string) => `"sv_password" = "${v}" ( def. "" )\n notify\n - Server password`;

let unsub: (() => void) | null = null;
afterEach(() => { unsub?.(); unsub = null; vi.restoreAllMocks(); });

describe('makeServerCleaner', () => {
  it('reloads the spec plugin, aborts the match, sends secrets.cfg without waiting for an answer, then reads the password back on a fresh connection', async () => {
    const first = { log: [] as string[] };
    const second = { log: [] as string[], exec: async (cmd: string) => { second.log.push(`exec ${cmd}`); return passwordReply('njd'); } };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const clean = makeServerCleaner({ rcon: fakeRcon([first, second]), resetMap: () => 'l4d_hospital01_apartment', dropWaitMs: 1500 });
    await clean(SERVER, 'tok', { teardown: false, restart: false, force: false } as any);
    expect(first.log).toEqual([
      'connect',
      'exec sm plugins load_unlock; sm plugins load l4d2_spec_stays_spec.smx; sm plugins load_lock',
      'exec sm_pug_abort tok',
      'send exec secrets.cfg',
      'waitClosed 1500',
      'close',
    ]);
    expect(second.log).toEqual(['connect', 'exec sv_password', 'close']);
    expect(errors).not.toHaveBeenCalled();
  });

  it('skips the abort without a token and still restores and checks the password', async () => {
    const first = { log: [] as string[] };
    const second = { log: [] as string[], exec: async () => passwordReply('x') };
    const clean = makeServerCleaner({ rcon: fakeRcon([first, second]), resetMap: () => 'm' });
    await clean(SERVER, null, { teardown: false, restart: false, force: false } as any);
    expect(first.log).toEqual([
      'connect',
      'exec sm plugins load_unlock; sm plugins load l4d2_spec_stays_spec.smx; sm plugins load_lock',
      'send exec secrets.cfg',
      'waitClosed 2000',
      'close',
    ]);
  });

  it('raises an admin problem when the password reads back empty, and only logs when it cannot be read', async () => {
    const events: AdminEvent[] = [];
    unsub = subscribeAdminEvents((e) => { events.push(e); });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const clean = makeServerCleaner({
      rcon: fakeRcon([{ log: [] }, { log: [], exec: async () => passwordReply('') }, { log: [] }, { log: [], exec: async () => 'Unknown command' }]),
      resetMap: () => 'm',
    });
    await clean(SERVER, null, { teardown: false, restart: false, force: false } as any);
    expect(events).toEqual([{ kind: 'problem', text: expect.stringContaining('Dallas has no server password') }]);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0][0])).toContain('EMPTY');

    await clean(SERVER, null, { teardown: false, restart: false, force: false } as any);
    expect(events).toHaveLength(1);
    expect(errors).toHaveBeenCalledTimes(2);
    expect(String(errors.mock.calls[1][0])).toContain('could not read sv_password back');
  });

  it('a failed abort or reload is logged and does not stop the password restore; a failed connect propagates and skips the read-back', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = {
      log: [] as string[],
      exec: async (cmd: string) => { first.log.push(`exec ${cmd}`); throw new Error('rcon exec timeout: ' + cmd); },
    };
    const second = { log: [] as string[], exec: async () => passwordReply('x') };
    const clean = makeServerCleaner({ rcon: fakeRcon([first, second]), resetMap: () => 'm' });
    await clean(SERVER, 'tok', { teardown: true, restart: false, force: false } as any);
    expect(first.log.slice(-3)).toEqual(['send exec secrets.cfg', 'waitClosed 2000', 'close']);
    expect(errors).toHaveBeenCalledTimes(2);

    const down = { log: [] as string[], connect: async () => { throw new Error('ECONNREFUSED'); } };
    const never = { log: [] as string[] };
    const clean2 = makeServerCleaner({ rcon: fakeRcon([down, never]), resetMap: () => 'm' });
    await expect(clean2(SERVER, null, { teardown: false, restart: false, force: false } as any)).rejects.toThrow('ECONNREFUSED');
    expect(down.log).toEqual(['close']);
    expect(never.log).toEqual([]);
  });

  it('a read-back that cannot connect is logged, never thrown: the release already happened', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const clean = makeServerCleaner({
      rcon: fakeRcon([{ log: [] }, { log: [], connect: async () => { throw new Error('box restarting'); } }]),
      resetMap: () => 'm',
    });
    await expect(clean(SERVER, null, { teardown: false, restart: false, force: false } as any)).resolves.toBeUndefined();
    expect(String(errors.mock.calls[0][0])).toContain('could not confirm sv_password');
  });
});
