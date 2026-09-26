import { describe, it, expect } from 'vitest';
import { dlc4MapsDir, serverHasDlc4, DLC4_PROBE_FILE, DLC4_PROBE_VPK } from '../src/dlc4.js';
import type { ServerRow } from '../src/serverPool.js';

const base = {
  id: 1, name: 'Test', host: '127.0.0.1', port: 27015, enabled: 1,
} as unknown as ServerRow;

describe('dlc4MapsDir', () => {
  it.each([
    ['/home/l4d/l4d1-server/left4dead/addons', '/home/l4d/l4d1-server/left4dead_dlc4/maps'],
    ['/left4dead/addons', '/left4dead_dlc4/maps'],
    ['/home/l4d/l4d1-a/left4dead/addons', '/home/l4d/l4d1-a/left4dead_dlc4/maps'],
  ])('derives %s to %s', (addons, expected) => {
    expect(dlc4MapsDir(addons)).toBe(expected);
  });

  it('tolerates a trailing slash', () => {
    expect(dlc4MapsDir('/left4dead/addons/')).toBe('/left4dead_dlc4/maps');
  });

  // Returning null rather than guessing: a path we cannot reason about must
  // read as "cannot prove it", which fails the gate closed.
  it.each([
    ['', null],
    [null, null],
    [undefined, null],
    ['/somewhere/else', null],
    ['/left4dead/addons/nested', null],
  ])('returns null for %s', (addons, expected) => {
    expect(dlc4MapsDir(addons as string | null | undefined)).toBe(expected);
  });
});

describe('serverHasDlc4', () => {
  it('is true when the pack VPK is in the addons folder', async () => {
    const server = { ...base, addons_transport: 'local', addons_dir: '/left4dead/addons' } as ServerRow;
    const seen: string[] = [];
    const got = await serverHasDlc4(server, (_s, dir) => ({
      put: async () => {},
      size: async (name: string) => { seen.push(`${dir}/${name}`); return 137; },
      remove: async () => {},
      readText: async () => null,
    }));
    expect(got).toBe(true);
    expect(seen).toEqual([`/left4dead/addons/${DLC4_PROBE_VPK}`]);
  });

  // A box still on the old left4dead_dlc4 folder install proves too, so the
  // switch to VPKs can go one server at a time.
  it('falls back to the left4dead_dlc4 folder when the VPK is absent', async () => {
    const server = { ...base, addons_transport: 'local', addons_dir: '/left4dead/addons/' } as ServerRow;
    const seen: string[] = [];
    const got = await serverHasDlc4(server, (_s, dir) => ({
      put: async () => {},
      size: async (name: string) => { seen.push(`${dir}/${name}`); return name === DLC4_PROBE_FILE ? 137 : null; },
      remove: async () => {},
      readText: async () => null,
    }));
    expect(got).toBe(true);
    expect(seen).toEqual([`/left4dead/addons/${DLC4_PROBE_VPK}`, `/left4dead_dlc4/maps/${DLC4_PROBE_FILE}`]);
  });

  it('is false when neither the VPK nor the folder is there', async () => {
    const server = { ...base, addons_transport: 'local', addons_dir: '/left4dead/addons' } as ServerRow;
    const got = await serverHasDlc4(server, () => ({
      put: async () => {}, size: async () => null, remove: async () => {},
      readText: async () => null,
    }));
    expect(got).toBe(false);
  });

  // A server we cannot reach is not a server we may assume is fine.
  it('is false when there is no usable transport', async () => {
    const server = { ...base, addons_transport: 'local', addons_dir: '' } as ServerRow;
    expect(await serverHasDlc4(server, () => null)).toBe(false);
  });

  // A dead box throws rather than returning null, and an exception must not
  // take down whatever is iterating servers.
  it('is false when the transport throws', async () => {
    const server = { ...base, addons_transport: 'local', addons_dir: '/left4dead/addons' } as ServerRow;
    const got = await serverHasDlc4(server, () => ({
      put: async () => {},
      size: async () => { throw new Error('host unreachable'); },
      remove: async () => {},
      readText: async () => null,
    }));
    expect(got).toBe(false);
  });
});
