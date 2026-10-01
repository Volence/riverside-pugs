import { describe, it, expect, vi } from 'vitest';
import { bookingCommandServerId } from '../src/server.js';
import type { LogMeta } from '../src/logListener.js';

/**
 * Task 6 fix round 1, ruling 3: a booking command acts only when the PUGBOOK
 * line's signature verified. `meta.serverId` is set by LogAuth (src/logAuth.ts)
 * only for a verified line; the address-and-port fallback `serverOf` uses for
 * every other log line must never decide this. This is the small helper
 * src/server.ts's dispatch calls instead of `serverOf` for 'booking_cmd'.
 */
describe('bookingCommandServerId', () => {
  it('returns the signed server id, and logs nothing', () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const meta: LogMeta = { port: 27015, serverId: 7 };
    expect(bookingCommandServerId(meta, '76561198000000001', 'nextmap')).toBe(7);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('refuses an unsigned line (meta.serverId null) and logs one line naming the steamid and cmd', () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const meta: LogMeta = { port: 27015, serverId: null };
    expect(bookingCommandServerId(meta, '76561198000000001', 'end')).toBeNull();
    // mockRestore() also clears mock.calls, so assert the call count and read
    // the call's arguments before restoring.
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0].map(String).join(' ');
    log.mockRestore();
    expect(line).toContain('unsigned PUGBOOK ignored');
    expect(line).toContain('76561198000000001');
    expect(line).toContain('end');
  });
});
