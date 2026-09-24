/**
 * The server's checks on a community share, run before anything touches the
 * disk. See "Checks on the server" in
 * docs/superpowers/specs/2026-09-24-hud-community-design.md.
 *
 * The server cannot run the editor's validateDesign (it needs the base files
 * Vite bundles), and it does not need to: every browser runs a community
 * design through validateDesign before using it. What the server owns is
 * what a browser cannot check for everyone else: sizes, that every image is
 * a real PNG, that the crosshair is one the builder could have made, and
 * that an imported HUD carries nothing but HUD files.
 *
 * Every function returns a value or a one-line refusal with its HTTP status,
 * so a route can hand the refusal straight back.
 */
import { findSlurs } from '../slurs.js';
import { hasUnsafeChars, LINKISH } from '../profileFields.js';
import { readVPK, isVpk, canonicalVpkProblem, VPK_CASE_CLASH } from '../vpkRead.js';
import { hudSetProblem, hudId, pngSize } from '../hudFiles.js';

export type Checked<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 413; error: string };

const pass = <T>(value: T): Checked<T> => ({ ok: true, value });
const bad = (error: string): Checked<never> => ({ ok: false, status: 400, error });
const tooBig = (error: string): Checked<never> => ({ ok: false, status: 413, error });

const MB = 1024 * 1024;
export const TITLE_MIN = 3;
export const TITLE_MAX = 40;
export const DESCRIPTION_MAX_CHARS = 280;
export const DESCRIPTION_MAX_LINES = 4;
export const DESIGN_MAX_BYTES = 2 * MB;
export const PREVIEW_MAX_BYTES = 1.5 * MB;
/** The editor's own import cap is 50 MB; sharing has the allowlist's lower one. */
export const IMPORT_MAX_BYTES = 20 * MB;

/** Characters as a reader counts them, so an emoji is one and not two. */
const length = (s: string) => [...s].length;

/** A title: one line of 3 to 40 plain characters. */
export function checkTitle(raw: unknown): Checked<string> {
  if (typeof raw !== 'string') return bad('The title must be text.');
  const v = raw.trim();
  if (length(v) < TITLE_MIN || length(v) > TITLE_MAX) return bad(`The title must be ${TITLE_MIN} to ${TITLE_MAX} characters.`);
  if (hasUnsafeChars(v)) return bad('The title must be one line of plain text.');
  // Not logged as a conduct flag: it never reaches anyone, so there is
  // nothing for staff to act on.
  if (findSlurs(v).length > 0) return bad('That title is not allowed here.');
  return pass(v);
}

/** A description: optional, at most 280 characters and 4 lines, no links. */
export function checkDescription(raw: unknown): Checked<string> {
  if (raw === undefined || raw === null) return pass('');
  if (typeof raw !== 'string') return bad('The description must be text.');
  // As profileFields' bio: line endings, trailing spaces and runs of blank
  // lines are normalised before counting, so the caps measure what shows.
  const v = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (length(v) > DESCRIPTION_MAX_CHARS) return bad(`The description is limited to ${DESCRIPTION_MAX_CHARS} characters.`);
  if (v.split('\n').length > DESCRIPTION_MAX_LINES) return bad(`The description is limited to ${DESCRIPTION_MAX_LINES} lines.`);
  if (hasUnsafeChars(v, true)) return bad('The description must be plain text.');
  if (LINKISH.test(v)) return bad('The description cannot contain links.');
  if (findSlurs(v).length > 0) return bad('That description is not allowed here.');
  return pass(v);
}

/** The editor's safeName (web/src/hud/design.ts), ported; a web test keeps the two equal. */
export function safeName(name: string): string {
  const s = name.replace(/[^A-Za-z0-9_ -]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return s || 'my_hud';
}

// ---- Crosshair art ---------------------------------------------------------
//
// Copied from web/src/crosshair/model.ts and draw.ts (readState, readArt,
// LIMITS, DRAWN, DEFAULT_STATE), which the server cannot import. The parity
// test in web/src/community/validate.test.ts runs both over the same cases.

type Shape = 'cross' | 'crossdot' | 't' | 'dot' | 'circle' | 'circledot';
type NumKey = 'len' | 'thick' | 'gap' | 'dot' | 'radius' | 'alpha' | 'outline' | 'oalpha';
export interface CrosshairState {
  shape: Shape; len: number; thick: number; gap: number; dot: number; radius: number; round: boolean;
  color: string; alpha: number; outline: number; oalpha: number; backdrop: string; res: string;
}
export type CrosshairArt =
  | { kind: 'built'; state: CrosshairState }
  | { kind: 'image'; png: string; w: number; h: number };

const DRAWN: readonly Shape[] = ['cross', 'crossdot', 't', 'dot', 'circle', 'circledot'];
const LIMITS: Record<NumKey, readonly [number, number]> = {
  len: [0, 30], thick: [0.5, 10], gap: [0, 30], dot: [0.5, 16],
  radius: [1, 40], alpha: [10, 100], outline: [0, 4], oalpha: [0, 100],
};
const BACKDROPS: readonly string[] = ['scene', 'dark', 'bright', 'grey', 'shot'];
const RESES: readonly string[] = ['768', '1080', '1440', '2160'];
const DEFAULT_STATE: CrosshairState = {
  shape: 'cross', len: 7, thick: 2, gap: 3, dot: 2, radius: 8, round: false,
  color: '#39ff5a', alpha: 100, outline: 1, oalpha: 80, backdrop: 'scene', res: '1080',
};
const PNG_PREFIX = 'data:image/png;base64,';

/** Image caps: a crosshair entry's own, and the larger ones a design's crosshair has. */
export interface ImageCaps { side: number; b64: number }
export const COMMUNITY_XHAIR_CAPS: ImageCaps = { side: 128, b64: 100_000 };
/** web/src/hud/limits.ts: MAX_IMAGE_SIDE and MAX_IMAGE_B64. */
export const DESIGN_XHAIR_CAPS: ImageCaps = { side: 512, b64: 1_400_000 };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Width and height of a base64 PNG, when it is one: strict base64 within
 * `maxB64` characters whose signature and IHDR read as a PNG. Only the head
 * is decoded, since that is all pngSize reads.
 */
function b64PngSize(b64: string, maxB64: number): { w: number; h: number } | null {
  if (b64.length > maxB64 || !BASE64.test(b64)) return null;
  const head = atob(b64.slice(0, 32));
  return pngSize(Uint8Array.from(head, (c) => c.charCodeAt(0)));
}

function readState(raw: unknown): CrosshairState | null {
  if (!isObj(raw)) return null;
  const s = { ...DEFAULT_STATE, ...raw } as Record<string, unknown>;
  if (!DRAWN.includes(s.shape as Shape)) return null;
  if (typeof s.round !== 'boolean' || typeof s.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(s.color)) return null;
  const out: CrosshairState = {
    ...DEFAULT_STATE,
    shape: s.shape as Shape, round: s.round, color: s.color,
    backdrop: BACKDROPS.includes(s.backdrop as string) ? s.backdrop as string : DEFAULT_STATE.backdrop,
    res: RESES.includes(s.res as string) ? s.res as string : DEFAULT_STATE.res,
  };
  for (const [k, [lo, hi]] of Object.entries(LIMITS) as [NumKey, readonly [number, number]][]) {
    const v = s[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    out[k] = Math.min(hi, Math.max(lo, v));
  }
  return out;
}

/**
 * A crosshair the builder could have made, rebuilt field by field, or a
 * refusal. Stricter than readArt for images: the PNG's own IHDR must say the
 * w and h the art claims, so the gallery never draws a picture at a size its
 * metadata lied about.
 */
export function checkCrosshairArt(raw: unknown, caps: ImageCaps): Checked<CrosshairArt> {
  if (!isObj(raw)) return bad('The crosshair is not one the crosshair maker can make.');
  if (raw.kind === 'built') {
    const state = readState(raw.state);
    return state ? pass({ kind: 'built', state }) : bad('The crosshair is not one the crosshair maker can make.');
  }
  if (raw.kind === 'image') {
    const { png, w, h } = raw;
    if (typeof png !== 'string' || !png.startsWith(PNG_PREFIX)) return bad('The crosshair image must be a PNG.');
    const side = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= caps.side;
    if (!side(w) || !side(h)) return bad(`The crosshair image must be at most ${caps.side} x ${caps.side}.`);
    const size = b64PngSize(png.slice(PNG_PREFIX.length), caps.b64);
    if (!size) return bad('The crosshair image must be a PNG within the size limit.');
    if (size.w !== w || size.h !== h) return bad('The crosshair image is not the size it says it is.');
    return pass({ kind: 'image', png, w, h });
  }
  return bad('The crosshair is not one the crosshair maker can make.');
}

// ---- HUD design ------------------------------------------------------------

export type Preset = 'stock' | 'modern' | 'imported';
export type Aspect = '16:9' | '16:10' | '4:3';
const PRESETS: readonly Preset[] = ['stock', 'modern', 'imported'];
const ASPECTS: readonly Aspect[] = ['16:9', '16:10', '4:3'];
const HUD_ID = /^[0-9a-f]{64}$/;

export interface CheckedDesign {
  /** The design re-serialized, with its name rewritten from the title. */
  json: string;
  preset: Preset;
  aspect: Aspect;
  advanced: boolean;
  /** The imported base's name, through safeName; null on a stock or Modern base. */
  importName: string | null;
}

/**
 * A HUD design's structure and sizes. `importId` is the hudId of the VPK
 * uploaded beside it, if any: an imported design must name exactly that
 * import, and a stock or Modern one must come with none, so an entry can
 * never point at a blob it did not bring.
 */
export function checkHudDesign(json: unknown, opts: { title: string; importId?: string }): Checked<CheckedDesign> {
  if (typeof json !== 'string') return bad('The design must be JSON.');
  if (new TextEncoder().encode(json).length > DESIGN_MAX_BYTES) return tooBig('The design is over 2 MB.');
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return bad('The design is not valid JSON.'); }
  if (!isObj(raw) || raw.v !== 1) return bad('The design is not one the HUD editor saves.');
  if (!PRESETS.includes(raw.preset as Preset)) return bad('The design has an unknown preset.');
  if (!ASPECTS.includes(raw.aspect as Aspect)) return bad('The design has an unknown aspect.');
  if (typeof raw.advanced !== 'boolean') return bad('The design has no advanced setting.');
  const preset = raw.preset as Preset;

  let importName: string | null = null;
  if (preset === 'imported') {
    const ref = raw.imported;
    if (!isObj(ref) || typeof ref.id !== 'string' || !HUD_ID.test(ref.id) || typeof ref.name !== 'string') {
      return bad('The design is on an imported HUD but does not say which.');
    }
    if (opts.importId === undefined) return bad('The design is on an imported HUD, and it was not uploaded.');
    if (ref.id !== opts.importId) return bad('The design names a different imported HUD from the one uploaded.');
    importName = safeName(ref.name);
    raw.imported = { id: ref.id, name: importName };
  } else {
    if (raw.imported !== undefined) return bad('Only a design on an imported HUD may name one.');
    if (opts.importId !== undefined) return bad('An imported HUD was uploaded for a design that does not use one.');
  }

  if (raw.images !== undefined) {
    if (!isObj(raw.images)) return bad('The design\'s images are not readable.');
    for (const [id, img] of Object.entries(raw.images)) {
      if (!isObj(img) || typeof img.png !== 'string') return bad(`The design's image ${id} is not a PNG.`);
      const { w, h } = img;
      const side = (n: unknown): n is number =>
        typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= DESIGN_XHAIR_CAPS.side;
      if (!side(w) || !side(h)) return bad(`The design's image ${id} must be at most ${DESIGN_XHAIR_CAPS.side} a side.`);
      const size = b64PngSize(img.png, DESIGN_XHAIR_CAPS.b64);
      if (!size) return bad(`The design's image ${id} is not a PNG within the size limit.`);
      if (size.w !== w || size.h !== h) return bad(`The design's image ${id} is not the size it says it is.`);
    }
  }

  if (raw.xhairArt !== undefined) {
    const art = checkCrosshairArt(raw.xhairArt, DESIGN_XHAIR_CAPS);
    if (!art.ok) return art;
  }

  raw.name = safeName(opts.title);
  return pass({ json: JSON.stringify(raw), preset, aspect: raw.aspect as Aspect, advanced: raw.advanced, importName });
}

// ---- Preview ---------------------------------------------------------------

/** The preview's size per aspect: 540 tall, as the share dialog draws it. */
export const PREVIEW_SIZE: Record<Aspect, { w: number; h: number }> = {
  '16:9': { w: 960, h: 540 },
  '16:10': { w: 864, h: 540 },
  '4:3': { w: 720, h: 540 },
};

/** A preview PNG of the design's aspect at 540 tall, at most 1.5 MB. */
export function checkPreview(bytes: Uint8Array, aspect: Aspect): Checked<{ w: number; h: number }> {
  if (bytes.length > PREVIEW_MAX_BYTES) return tooBig('The preview is over 1.5 MB.');
  const size = pngSize(bytes);
  if (!size) return bad('The preview is not a PNG.');
  const want = PREVIEW_SIZE[aspect];
  if (size.w !== want.w || size.h !== want.h) return bad(`The preview must be ${want.w} x ${want.h} for ${aspect}.`);
  return pass(size);
}

// ---- Imported HUD ----------------------------------------------------------

/**
 * The imported HUD's VPK, exactly as the author's browser built it: one
 * file, no split parts, no two paths that differ only in case, and byte for
 * byte what encodeVPK writes for the files it holds (so no bytes that no
 * entry reads, no overlapping entries, no preload bytes, nothing a reader
 * other than ours could see differently); every file on the allowlist; and
 * a hudId equal to both the id the request claims and the design's.
 *
 * Nothing is filtered: anything outside the allowlist is refused, naming the
 * path, because the author's browser already left such files out and a
 * request that still carries one was not made by the site.
 */
export async function checkImport(
  bytes: Uint8Array, claimedId: unknown, designImportId: string | undefined,
): Promise<Checked<{ id: string; files: Map<string, Uint8Array> }>> {
  if (bytes.length > IMPORT_MAX_BYTES) return tooBig('The imported HUD is over 20 MB.');
  if (bytes.length < 12 || !isVpk(bytes)) return bad('The imported HUD is not a .vpk file.');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(4, true) !== 1) return bad('The imported HUD must be a version 1 .vpk, as the editor writes.');

  const split = new Set<string>();
  let files: Map<string, Uint8Array>;
  try {
    files = readVPK(bytes, split);
  } catch (e) {
    if (e instanceof Error && e.message === VPK_CASE_CLASH) return bad('The imported HUD holds two files whose names differ only in case.');
    return bad('The imported HUD is not a .vpk file the site can read.');
  }
  if (split.size > 0) return bad('The imported HUD is a split archive; it must be one file.');
  if (canonicalVpkProblem(bytes, files)) return bad('The imported HUD is not laid out as the editor writes it.');

  const problem = hudSetProblem(files);
  if (problem) return bad(problem);
  const id = await hudId(files);
  if (claimedId !== id) return bad('The imported HUD is not the one the request names.');
  if (designImportId !== id) return bad('The imported HUD is not the one the design names.');
  return pass({ id, files });
}
