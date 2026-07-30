export const SERVERDATA_AUTH = 3;
export const SERVERDATA_AUTH_RESPONSE = 2;
export const SERVERDATA_EXECCOMMAND = 2;
export const SERVERDATA_RESPONSE_VALUE = 0;

export interface RconPacket {
  id: number;
  type: number;
  body: string;
}

export function encodePacket(id: number, type: number, body: string): Buffer {
  const bodyBuf = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(bodyBuf.length + 14);
  buf.writeInt32LE(bodyBuf.length + 10, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBuf.copy(buf, 12);
  return buf;
}

/** Pull all complete packets from a stream buffer; return leftover bytes. */
export function decodePackets(buf: Buffer): { packets: RconPacket[]; rest: Buffer } {
  const packets: RconPacket[] = [];
  let off = 0;
  while (buf.length - off >= 4) {
    const size = buf.readInt32LE(off);
    if (buf.length - off - 4 < size) break;
    const id = buf.readInt32LE(off + 4);
    const type = buf.readInt32LE(off + 8);
    const body = buf.toString('utf8', off + 12, off + 4 + size - 2);
    packets.push({ id, type, body });
    off += 4 + size;
  }
  return { packets, rest: buf.subarray(off) };
}
