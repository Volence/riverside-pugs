import dgram from 'node:dgram';

/**
 * One A2S_INFO query (Valve server query protocol), for crash recovery
 * (plan 5): a second way to ask "is that box there", on a UDP path separate
 * from rcon. Since 2020 servers may answer the first request with
 * S2C_CHALLENGE (0x41) and want it repeated with the 4 challenge bytes
 * appended. Never throws. Note: some hosts never answer A2S (NFO's Chicago
 * box did not), and to the recovery that looks exactly like a box that is gone.
 */
const HEADER = [0xff, 0xff, 0xff, 0xff];
const REQUEST = Buffer.from([...HEADER, 0x54, ...Buffer.from('Source Engine Query\0', 'latin1')]);

export type A2sFn = typeof a2sInfo;

export function a2sInfo(host: string, port: number, timeoutMs = 2_000): Promise<{ players: number; map: string } | null> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (v: { players: number; map: string } | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* already closed */ }
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    sock.on('error', () => finish(null));
    sock.on('message', (msg) => {
      if (msg.length < 5 || msg.readInt32LE(0) !== -1) return;
      const kind = msg[4];
      if (kind === 0x41 && msg.length >= 9) {
        sock.send(Buffer.concat([REQUEST, msg.subarray(5, 9)]), port, host);
        return;
      }
      if (kind !== 0x49) return;
      finish(parseInfo(msg));
    });
    sock.send(REQUEST, port, host, (err) => { if (err) finish(null); });
  });
}

/** The players and map of an A2S_INFO answer, or null for a short one. */
function parseInfo(msg: Buffer): { players: number; map: string } | null {
  let at = 6; // header (4), 0x49, protocol (1)
  const str = (): string | null => {
    const end = msg.indexOf(0, at);
    if (end < 0) return null;
    const s = msg.toString('utf8', at, end);
    at = end + 1;
    return s;
  };
  if (str() === null) return null; // name
  const map = str();
  if (map === null || str() === null || str() === null) return null; // folder, game
  at += 2; // app id
  if (at >= msg.length) return null;
  return { players: msg[at], map };
}
