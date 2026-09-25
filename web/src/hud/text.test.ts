import { describe, it, expect } from 'vitest';
import { decodeText, encodeText } from './text';

describe('text files as the game stores them', () => {
  it('round-trips every byte of a file with no byte order mark, 0x80 to 0x9f included', () => {
    const b = Uint8Array.from({ length: 256 }, (_, i) => i);
    const { text, encoding } = decodeText(b);
    expect(encoding).toBe('latin1');
    expect(text.length).toBe(256);
    expect(encodeText(text, encoding)).toEqual(b);
  });

  it('strips a UTF-8 byte order mark for reading and puts it back on writing', () => {
    const b = Uint8Array.from([0xef, 0xbb, 0xbf, 0x22, 0x61, 0x22]);
    expect(decodeText(b)).toEqual({ text: '"a"', encoding: 'utf8bom' });
    expect(encodeText('"a"', 'utf8bom')).toEqual(b);
  });

  it('reads and writes a UTF-16 file with its byte order mark', () => {
    const b = Uint8Array.from([0xff, 0xfe, 0x22, 0, 0x61, 0, 0x22, 0]);
    expect(decodeText(b)).toEqual({ text: '"a"', encoding: 'utf16le' });
    expect(encodeText('"a"', 'utf16le')).toEqual(b);
  });
});
