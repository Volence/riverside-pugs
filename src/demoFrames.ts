// Frame boundaries of a SourceTV .dem (L4D1: demo protocol 4), without parsing the frames: enough to
// know where a growing file ends a frame and how much demo time it holds. A copy of the theatre spike's
// research/theatre-spike/live/demo-frames.ts (the layout is the spike parser's parseFrameInner): a
// 1072-byte header, then frames of cmd (1 byte), tick (int32), player slot (1 byte) and a
// command-specific body.
export const HEADER_BYTES = 1072;
/** The part of the header that is fixed when recording starts: magic, demo and network protocol,
 *  server name, client name, map name and game directory. The last 16 bytes (playback time, ticks,
 *  frames, signon length) are rewritten by srcds when the recording stops, so they must not be what
 *  tells one recording from another. */
export const STABLE_HEADER_BYTES = 8 + 4 + 4 + 260 * 4;
const CMDINFO = 4 * (4 + 6 * 12);   // dem_signon / dem_packet: 4 split-screen cmdinfo slots
export const DEM_STOP = 7;
const MAGIC = 'HL2DEMO\0';

export function hasDemoMagic(b: Uint8Array): boolean {
  if (b.length < MAGIC.length) return false;
  for (let i = 0; i < MAGIC.length; i++) if (b[i] !== MAGIC.charCodeAt(i)) return false;
  return true;
}

export interface DemoHeaderInfo { mapName: string; playbackTime: number; ticks: number; frames: number; tickInterval: number }
export function readHeader(b: Uint8Array): DemoHeaderInfo | null {
  if (b.length < HEADER_BYTES || !hasDemoMagic(b)) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const str = (o: number, n: number) => { let e = o; while (e < o + n && b[e]) e++; return new TextDecoder().decode(b.subarray(o, e)); };
  const playbackTime = dv.getFloat32(8 + 4 + 4 + 260 * 4, true), ticks = dv.getInt32(8 + 4 + 4 + 260 * 4 + 4, true), frames = dv.getInt32(8 + 4 + 4 + 260 * 4 + 8, true);
  return { mapName: str(8 + 4 + 4 + 260 * 2, 260), playbackTime, ticks, frames, tickInterval: ticks > 0 && playbackTime > 0 ? playbackTime / ticks : 0 };
}

/** The end offset of the frame at off, or -1 when the bytes stop before it is complete. Throws on a
 *  command byte no L4D1 demo has (the bytes are not a demo, or are corrupt). */
export function frameEnd(b: Uint8Array, off: number): number {
  if (off + 6 > b.length) return -1;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const cmd = b[off];
  let p = off + 6;
  const len32 = (at: number) => (at + 4 <= b.length ? dv.getInt32(at, true) : -1);
  switch (cmd) {
    case 1: case 2: { const n = len32(p + CMDINFO + 8); if (n < 0) return -1; p += CMDINFO + 12 + n; break; }
    case 3: case 7: break;                               // synctick, stop
    case 4: case 6: case 9: { const n = len32(p); if (n < 0) return -1; p += 4 + n; break; }   // consolecmd, datatables, stringtables
    case 5: case 8: { const n = len32(p + 4); if (n < 0) return -1; p += 8 + n; break; }      // usercmd, customdata
    default: throw new Error(`unknown demo command ${cmd}`);
  }
  return p <= b.length ? p : -1;
}

/** Walks the frames of bytes that grow: scan(b) advances over every complete frame. */
export class FrameScanner {
  off = HEADER_BYTES;
  tick0 = -1;           // tick of the first dem_packet
  lastTick = 0;         // tick of the last complete dem_packet
  frames = 0;
  stopped = false;      // a dem_stop frame was reached
  scan(b: Uint8Array): void {
    while (!this.stopped && this.off < b.length) {
      const cmd = b[this.off];
      if (cmd === DEM_STOP) { this.stopped = true; this.off = b.length; break; }
      const end = frameEnd(b, this.off);
      if (end < 0) break;
      const tick = new DataView(b.buffer, b.byteOffset + this.off + 1, 4).getInt32(0, true);
      if (cmd === 2) { if (this.tick0 < 0) this.tick0 = tick; this.lastTick = tick; }
      this.off = end; this.frames++;
    }
  }
}
