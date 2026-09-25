/**
 * An imported HUD's text files, as bytes in and bytes out.
 *
 * The editor reads a .res file as text and, when it did not change it,
 * ships the upload's own bytes; when it did, it writes the text back in the
 * encoding the file came in. Latin-1 is read by hand, not with
 * TextDecoder('latin1'), which is really windows-1252 and would turn bytes
 * 0x80 to 0x9f into other characters: read this way, any 8-bit file
 * (UTF-8 included) round-trips byte for byte. A UTF-8 byte order mark is
 * taken off so KeyValues does not read it as a key; a UTF-16 file (Valve's
 * tools write some) is decoded properly.
 */
export type TextEncoding = 'latin1' | 'utf8bom' | 'utf16le';

function latin1(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
}

export function decodeText(bytes: Uint8Array): { text: string; encoding: TextEncoding } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: latin1(bytes.subarray(3)), encoding: 'utf8bom' };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf16le' };
  return { text: latin1(bytes), encoding: 'latin1' };
}

export function encodeText(text: string, encoding: TextEncoding): Uint8Array {
  if (encoding === 'utf16le') {
    const out = new Uint8Array(2 + text.length * 2);
    out[0] = 0xff; out[1] = 0xfe;
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); out[2 + i * 2] = c & 0xff; out[3 + i * 2] = c >> 8; }
    return out;
  }
  const body = Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
  if (encoding === 'latin1') return body;
  const out = new Uint8Array(3 + body.length);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out;
}
