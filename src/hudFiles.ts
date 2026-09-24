/**
 * The community HUD allowlist: which files a shared HUD may carry, and what
 * each may contain.
 *
 * An addon VPK installed into left4dead/addons can carry anything, including
 * an autoexec.cfg full of binds or a game menu whose buttons run console
 * commands. A community HUD is someone else's addon landing in a player's
 * game, so it may carry HUD files and nothing else. The server refuses an
 * upload that breaks these rules, every browser checks a download against
 * them again, and the builder refuses to emit a path outside them.
 *
 * No imports, on purpose: the server and the web both use this file, the web
 * through a relative path, so it must not pull in either side's modules.
 */

export const HUD_CAPS = {
  files: 400,
  totalBytes: 20 * 1024 * 1024,
  text: 512 * 1024,
  vmt: 16 * 1024,
  font: 4 * 1024 * 1024,
  texture: 8 * 1024 * 1024,
  textureSide: 2048,
} as const;

export type HudFileKind = 'text' | 'animations' | 'vmt' | 'font' | 'texture';

/** The HUD scripts and schemes, allowed by exact path. */
const EXACT_TEXT = new Set([
  'scripts/hudlayout.res',
  'scripts/hud_textures.txt',
  'scripts/mod_textures.txt',
  'resource/clientscheme.res',
  'resource/chatscheme.res',
  // The resource/ui/*.res panels the editor's own bases carry. The rest of
  // resource/ui/ is refused: it also holds game dialogs whose buttons can
  // send commands.
  'resource/ui/basechat.res',
  'resource/ui/hudghostpanel.res',
  'resource/ui/scoreboard.res',
  'resource/ui/scoreboardsurvivor.res',
  'resource/ui/scoreboardinfectedplayer.res',
  'resource/ui/versusmodescoreboard.res',
  'resource/ui/zombiepanel.res',
]);
const ANIMATIONS = 'scripts/hudanimations.txt';
const HUD_PANEL = /^resource\/ui\/hud\/([a-z0-9_]+\/)*[a-z0-9_]+\.res$/;
const FONT = /^resource\/([a-z0-9_.-]+\/)*[a-z0-9_.-]+\.(ttf|otf|vfont)$/;
const VGUI = /^materials\/vgui\/([a-z0-9_.-]+\/)*[a-z0-9_.-]+\.(vtf|vmt)$/;
const SEGMENT = /^[a-z0-9_.-]+$/;

/** Which rule allows a path, or null when none does. */
function kindOf(path: string): HudFileKind | null {
  const segments = path.split('/');
  if (segments.some((s) => !SEGMENT.test(s) || s === '.' || s === '..')) return null;
  if (path === ANIMATIONS) return 'animations';
  if (EXACT_TEXT.has(path) || HUD_PANEL.test(path)) return 'text';
  if (FONT.test(path)) return 'font';
  if (VGUI.test(path)) return path.endsWith('.vmt') ? 'vmt' : 'texture';
  return null;
}

/** Null when allowed, else "cfg/autoexec.cfg is not a HUD file". */
export function hudPathProblem(path: string): string | null {
  return kindOf(path) === null ? `${path} is not a HUD file` : null;
}

const MB = 1024 * 1024;
const capText = (n: number) => (n >= MB ? `${n / MB} MB` : `${n / 1024} KB`);

type Token = { value: string; quoted: boolean };

/**
 * A line split into the tokens a KeyValues reader sees: quoted strings
 * (without their quotes), braces, and bare words. As in the game, `//` starts
 * a comment only where a new token would start; inside a bare word it is part
 * of the word, so `v//x "k"` is a word and then a quoted string, not a word
 * and a comment. A bare word ends at whitespace, a quote or a brace. With
 * `escapes`, a backslash escapes the next character inside quotes, which is
 * how a reader that honours escapes sees it.
 *
 * The game reads a quoted string across line ends, and a string that runs
 * over one would make this line-by-line reading disagree with it about what
 * is a comment, so such a string is refused: null.
 */
function tokenize(line: string, escapes: boolean): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && line[i + 1] === '/') break;
    if (c === '{' || c === '}') { out.push({ value: c, quoted: false }); i++; continue; }
    if (c === '"') {
      let v = '';
      i++;
      while (i < line.length && line[i] !== '"') {
        if (escapes && line[i] === '\\' && i + 1 < line.length) i++;
        v += line[i];
        i++;
      }
      if (i >= line.length) return null;
      i++;
      out.push({ value: v, quoted: true });
      continue;
    }
    let v = '';
    while (i < line.length && !/[\s"{}]/.test(line[i]!)) v += line[i++];
    out.push({ value: v, quoted: false });
  }
  return out;
}

/**
 * Tokens per line, read both with and without escapes: a file must pass
 * whichever way the game reads it. Null when either reading has a quoted
 * string that does not close on its own line.
 */
function readings(src: string): Token[][][] | null {
  const lines = src.split(/\r\n|\r|\n/);
  const out: Token[][][] = [];
  for (const escapes of [false, true]) {
    const reading: Token[][] = [];
    for (const line of lines) {
      const tokens = tokenize(line, escapes);
      if (tokens === null) return null;
      reading.push(tokens);
    }
    out.push(reading);
  }
  return out;
}

// A value starting with "engine " is the VGUI prefix that turns a button
// command into a console command. Neither the editor nor the stock files
// write it. A bare `engine` is refused outright: bare words cannot hold a
// space, so it can only be the start of a command split across tokens.
const ENGINE_QUOTED = /^\s*engine\s/i;

/**
 * The animation commands a HUD may use, each with the number of arguments
 * the controller reads after it. Animate reads panel, variable, value and
 * interpolator, one more when the interpolator is Pulse or Flicker, then a
 * start time and a duration. L4D1's controller knows Animate, RunEvent,
 * StopEvent, StopAnimation, StopPanelAnimations, SetFont, SetTexture and
 * SetString; RunEventChild and SetVisible come from later engines, where they
 * are display-only too, and L4D1 fails to parse a file that uses them.
 */
const ANIMATION_ARGS: Record<string, number> = {
  animate: 6, runevent: 2, runeventchild: 3, stopevent: 2, stopanimation: 3, stoppanelanimations: 2,
  setvisible: 3, setfont: 4, settexture: 4, setstring: 4,
};
const INTERPOLATOR_WITH_ARG = new Set(['pulse', 'flicker']);
// Other engines' controllers also know these, which run console commands,
// play sounds or take the mouse. They are refused anywhere in the file, as a
// raw substring in any case, comments included, so no reading of the file
// can reach one: no stock file holds any of them, so nothing real is lost.
const ANIMATION_DENIED = ['firecommand', 'playsound', 'setinputenabled'];

/**
 * hudanimations.txt as the controller's tokenizer (Source's ParseFile) reads
 * it, which is not the KeyValues one: whitespace is any byte up to a space;
 * `//` where a token would start runs to the end of the line; a quoted
 * string runs to the next quote; the break characters { } ( ) ' : are tokens
 * of their own; and a word runs to whitespace or a break character, straight
 * through a quote or a `//`. Everything this reading could get wrong is
 * refused instead: ( ) ' : outside comments (the stock files have none), a
 * byte above 0x7f outside comments and strings (the game's signed char makes
 * it whitespace), and a quoted string that does not close on its line.
 * Then the tokens must be a run of `event <name> { <commands> }`, each
 * command one on ANIMATION_ARGS with its full count of arguments, so every
 * token the controller would run as a command is checked, wherever it sits
 * on a line.
 */
function animationProblem(path: string, src: string): string | null {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const code = src.charCodeAt(i);
    if (code <= 0x20) { i++; continue; }
    if (src[i] === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (src[i] === '"') {
      const end = src.indexOf('"', i + 1);
      const line = src.slice(i + 1, end < 0 ? src.length : end);
      if (end < 0 || /[\r\n]/.test(line)) return `${path} has a quoted string that does not close on its line`;
      tokens.push(line);
      i = end + 1;
      continue;
    }
    if (src[i] === '{' || src[i] === '}') { tokens.push(src[i]!); i++; continue; }
    let word = '';
    while (i < src.length && src.charCodeAt(i) > 0x20 && src[i] !== '{' && src[i] !== '}') {
      const c = src[i]!;
      if (c === '(' || c === ')' || c === "'" || c === ':') return `${path} has a ${c} outside a comment, which a HUD may not`;
      if (src.charCodeAt(i) > 0x7f) return `${path} has a character outside ASCII outside a comment or string`;
      word += c;
      i++;
    }
    tokens.push(word);
  }

  let t = 0;
  const notEvents = `${path} is not a run of animation events`;
  while (t < tokens.length) {
    if (tokens[t++]!.toLowerCase() !== 'event') return notEvents;
    if (t + 2 > tokens.length || tokens[t + 1] !== '{') return notEvents;
    t += 2;
    for (;;) {
      if (t >= tokens.length) return notEvents;
      const word = tokens[t++]!;
      if (word === '}') break;
      let args = ANIMATION_ARGS[word.toLowerCase()];
      if (args === undefined) return `${path} uses ${word}, which a HUD may not`;
      if (word.toLowerCase() === 'animate' && t + 3 < tokens.length && INTERPOLATOR_WITH_ARG.has(tokens[t + 3]!.toLowerCase())) args++;
      if (t + args > tokens.length) return notEvents;
      t += args;
    }
  }
  return null;
}

function textProblem(path: string, data: Uint8Array, animations: boolean): string | null {
  if (data.includes(0)) return `${path} has a NUL byte`;
  let src = '';
  for (let i = 0; i < data.length; i += 0x8000) src += String.fromCharCode(...data.subarray(i, i + 0x8000));
  if (animations) {
    const lower = src.toLowerCase();
    for (const w of ANIMATION_DENIED) {
      const at = lower.indexOf(w);
      if (at >= 0) return `${path} uses ${src.slice(at, at + w.length)}, which a HUD may not`;
    }
    return animationProblem(path, src);
  }
  const all = readings(src);
  if (all === null) return `${path} has a quoted string that does not close on its line`;
  for (const reading of all) {
    for (const tokens of reading) {
      for (const t of tokens) {
        if (t.quoted ? ENGINE_QUOTED.test(t.value) : t.value.toLowerCase() === 'engine') {
          return `${path} runs a console command`;
        }
      }
    }
  }
  return null;
}

const startsWith = (b: Uint8Array, magic: number[]) => magic.every((m, i) => b[i] === m);
const TTF = [0x00, 0x01, 0x00, 0x00];
const OTTO = [0x4f, 0x54, 0x54, 0x4f];
const TRUE = [0x74, 0x72, 0x75, 0x65];
const VFONT1 = [0x56, 0x46, 0x4f, 0x4e, 0x54, 0x31];

function fontProblem(path: string, data: Uint8Array): string | null {
  if (path.endsWith('.vfont')) {
    const tail = data.subarray(Math.max(0, data.length - VFONT1.length));
    return tail.length === VFONT1.length && startsWith(tail, VFONT1) ? null : `${path} is not a font`;
  }
  return startsWith(data, TTF) || startsWith(data, OTTO) || startsWith(data, TRUE) ? null : `${path} is not a font`;
}

function textureProblem(path: string, data: Uint8Array): string | null {
  if (data.length < 20 || !startsWith(data, [0x56, 0x54, 0x46, 0x00])) return `${path} is not a VTF texture`;
  const w = data[16]! | (data[17]! << 8);
  const h = data[18]! | (data[19]! << 8);
  const side = HUD_CAPS.textureSide;
  if (w < 1 || h < 1 || w > side || h > side) return `${path} is ${w}x${h}; each side must be 1 to ${side}`;
  return null;
}

/** hudPathProblem, then the size and content checks for that kind. */
export function hudFileProblem(path: string, data: Uint8Array): string | null {
  const kind = kindOf(path);
  if (kind === null) return `${path} is not a HUD file`;
  const cap = kind === 'vmt' ? HUD_CAPS.vmt : kind === 'font' ? HUD_CAPS.font : kind === 'texture' ? HUD_CAPS.texture : HUD_CAPS.text;
  if (data.length > cap) return `${path} is over the ${capText(cap)} limit`;
  switch (kind) {
    case 'text':
    case 'vmt': return textProblem(path, data, false);
    case 'animations': return textProblem(path, data, true);
    case 'font': return fontProblem(path, data);
    case 'texture': return textureProblem(path, data);
  }
}

/** Every file's problem, then the set caps and hudlayout.res. The first problem, or null. */
export function hudSetProblem(files: ReadonlyMap<string, Uint8Array>): string | null {
  for (const path of [...files.keys()].sort()) {
    const p = hudFileProblem(path, files.get(path)!);
    if (p) return p;
  }
  if (files.size > HUD_CAPS.files) return `A shared HUD may hold at most ${HUD_CAPS.files} files.`;
  let total = 0;
  for (const data of files.values()) total += data.length;
  if (total > HUD_CAPS.totalBytes) return `A shared HUD may be at most ${capText(HUD_CAPS.totalBytes)}.`;
  if (!files.has('scripts/hudlayout.res')) return 'A shared HUD must have scripts/hudlayout.res.';
  return null;
}

/** The allowed files, and the refused ones as "path: reason", sorted. Set caps are NOT applied here. */
export function shareableHudFiles(files: ReadonlyMap<string, Uint8Array>): { kept: Map<string, Uint8Array>; left: string[] } {
  const kept = new Map<string, Uint8Array>();
  const left: string[] = [];
  for (const path of [...files.keys()].sort()) {
    const data = files.get(path)!;
    const p = hudFileProblem(path, data);
    if (p === null) kept.set(path, data);
    // Every problem starts with the path; the list shows it once.
    else left.push(`${path}: ${p.startsWith(`${path} `) ? p.slice(path.length + 1).replace(/^is /, '') : p}`);
  }
  return { kept, left };
}

/**
 * The HUD's identity: SHA-256 of its canonical file list, every path in
 * sorted order followed by its length and its bytes. The same HUD imported
 * twice, from a .vpk or a zip, is one id, so it is one stored entry, and a
 * design that names an id can never open against different files.
 */
export async function hudId(files: ReadonlyMap<string, Uint8Array>): Promise<string> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const path of [...files.keys()].sort()) {
    const data = files.get(path)!;
    parts.push(enc.encode(`${path}\0${data.length}\0`), data);
  }
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', all));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = [0x49, 0x48, 0x44, 0x52];

/** Width and height from a PNG's IHDR, or null when the bytes are not a PNG. */
export function pngSize(b: Uint8Array): { w: number; h: number } | null {
  if (b.length < 24 || !startsWith(b, PNG_SIGNATURE) || !startsWith(b.subarray(12), IHDR)) return null;
  const be = (o: number) => ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
  const w = be(16);
  const h = be(20);
  return w > 0 && h > 0 ? { w, h } : null;
}
