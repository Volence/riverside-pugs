import { readFileSync } from 'node:fs';

/**
 * Just enough VPK to find a campaign's mission file, and just enough
 * KeyValues to read it.
 *
 * Hand-rolled for the same reason src/rconPacket.ts is: the surface actually
 * used is one archive layout and one text format, read once at upload time,
 * against files that are never written back. A general VPK library would be a
 * large dependency for a header, a string tree and a struct.
 *
 * Deliberately does NOT open the numbered archive files (pak01_001.vpk and
 * friends). Mission files are a few kilobytes and live in the directory file
 * or its preload area in every campaign seen so far. A campaign that hides its
 * mission in an archive parses as "no mission", which the upload path reports
 * as a rejection rather than a crash.
 */

export type KvNode = { [key: string]: string | KvNode };

const VPK_MAGIC = 0x55aa1234;

/** Tokenise KeyValues: quoted strings, bare tokens, braces, // comments. */
function tokenize(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '"') {
      let s = '';
      i++;
      while (i < text.length && text[i] !== '"') { s += text[i]; i++; }
      i++;
      out.push(s);
      continue;
    }
    if (c === '{' || c === '}') { out.push(c); i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    let s = '';
    while (i < text.length && !/[\s{}"]/.test(text[i])) { s += text[i]; i++; }
    out.push(s);
  }
  return out;
}

export function parseKeyValues(text: string): KvNode {
  const tokens = tokenize(text);
  let i = 0;

  const block = (): KvNode => {
    const node: KvNode = {};
    while (i < tokens.length && tokens[i] !== '}') {
      const key = tokens[i++];
      if (i >= tokens.length) break;
      if (tokens[i] === '{') { i++; node[key] = block(); i++; }
      else node[key] = tokens[i++];
    }
    return node;
  };

  const root: KvNode = {};
  while (i < tokens.length) {
    const key = tokens[i++];
    if (i >= tokens.length) break;
    if (tokens[i] === '{') { i++; root[key] = block(); i++; }
    else root[key] = tokens[i++];
  }
  return root;
}

export interface MissionChapter { map: string; display: string | null }
export interface Mission { name: string; displayTitle: string; chapters: MissionChapter[] }

const isNode = (v: string | KvNode | undefined): v is KvNode =>
  typeof v === 'object' && v !== null;

/** Read a mission file's versus chapter list, in play order. */
export function parseMission(text: string): Mission | null {
  const root = parseKeyValues(text);
  const mission = Object.entries(root).find(([k]) => k.toLowerCase() === 'mission')?.[1];
  if (!isNode(mission)) return null;

  const modes = mission['modes'];
  if (!isNode(modes)) return null;
  const versus = Object.entries(modes).find(([k]) => k.toLowerCase() === 'versus')?.[1];
  if (!isNode(versus)) return null;

  // Chapter keys are "1", "2", ... "10". String order puts 10 before 2, which
  // would play the campaign out of sequence, so sort numerically.
  const chapters = Object.entries(versus)
    .filter((e): e is [string, KvNode] => isNode(e[1]) && /^\d+$/.test(e[0]))
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, ch]) => {
      const map = typeof ch['Map'] === 'string' ? ch['Map'] : null;
      const display = typeof ch['DisplayName'] === 'string' ? ch['DisplayName'] : null;
      return map ? { map, display } : null;
    })
    .filter((c): c is MissionChapter => c !== null);

  if (chapters.length === 0) return null;

  const name = typeof mission['Name'] === 'string' ? mission['Name'] : '';
  const displayTitle = typeof mission['DisplayTitle'] === 'string'
    ? mission['DisplayTitle'] : name;
  return { name, displayTitle, chapters };
}

/** Locate `missions/<something>.txt` in a VPK and return its text. */
export function readMissionFromVpk(vpkPath: string): { file: string; text: string } | null {
  const buf = readFileSync(vpkPath);
  if (buf.length < 12 || buf.readUInt32LE(0) !== VPK_MAGIC) return null;

  const version = buf.readUInt32LE(4);
  const treeLength = buf.readUInt32LE(8);
  // v2 adds four uint32 fields after the common header.
  const treeStart = version === 2 ? 28 : 12;
  if (treeStart + treeLength > buf.length) return null;
  const dataStart = treeStart + treeLength;

  let p = treeStart;
  const readCString = (): string => {
    let s = '';
    while (p < buf.length && buf[p] !== 0) { s += String.fromCharCode(buf[p]); p++; }
    p++;
    return s;
  };

  for (;;) {
    const ext = readCString();
    if (ext === '') break;
    for (;;) {
      const dir = readCString();
      if (dir === '') break;
      for (;;) {
        const name = readCString();
        if (name === '') break;
        const preloadBytes = buf.readUInt16LE(p + 4);
        const archiveIndex = buf.readUInt16LE(p + 6);
        const offset = buf.readUInt32LE(p + 8);
        const length = buf.readUInt32LE(p + 12);
        p += 18;
        const preload = buf.subarray(p, p + preloadBytes);
        p += preloadBytes;

        if (ext === 'txt' && dir.toLowerCase() === 'missions') {
          // 0x7fff means the bytes are in this file, after the tree. Anything
          // else is a numbered archive this reader deliberately does not open.
          if (archiveIndex !== 0x7fff && preloadBytes === 0) return null;
          const body = archiveIndex === 0x7fff
            ? Buffer.concat([preload, buf.subarray(dataStart + offset, dataStart + offset + length)])
            : preload;
          return { file: `${dir}/${name}.${ext}`, text: body.toString('utf8') };
        }
      }
    }
  }
  return null;
}

export function missionFromVpk(vpkPath: string): Mission | null {
  let found: { file: string; text: string } | null;
  try {
    found = readMissionFromVpk(vpkPath);
  } catch {
    // A truncated or malformed VPK reads past its own buffer. That is a
    // rejected upload, not a crashed request.
    return null;
  }
  return found ? parseMission(found.text) : null;
}
