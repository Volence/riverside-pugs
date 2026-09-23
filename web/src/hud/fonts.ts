/**
 * The preview's text: which face a scheme font names, and how big the game
 * draws it.
 *
 * VGUI's `tall` is not a CSS font size. The Source surface on the PC makes
 * each font with GDI's CreateFont, whose height is the whole cell (ascent
 * plus descent), and draws text from the top of that cell. So the preview
 * turns a tall into the em size and ascent the game gets, from each face's
 * own metrics, baked into art/index.ts by scripts/export-hud-art.py so no font
 * is parsed here. A face with a VDMX table (both stock faces) is read the way
 * GDI reads it: the largest ppem whose cell fits the tall. That makes
 * HudAmmo at 1080p (a 40 cell) 32 ppem, and the owner's screenshot agrees,
 * where the usual winAscent + winDescent rule gives 33.4 and digits a pixel
 * or two too big. A face without one is scaled by that rule.
 *
 * Preview only, like the art: it loads Valve's fonts, and nothing under
 * build.ts may import it (art.test.ts walks those imports).
 */
import { FONT_FILES, FONT_METRICS, type FontMetrics } from './art/index';
import { baseFile, importedFiles, type BaseKey } from './base';
import { parseKv, kvFind, pcApplies } from './kv';
import { decodeVfont, isVfont, readFont } from './ttf';
import regularUrl from './base/fonts/RobotoCondensed-Regular.ttf?url';
import boldUrl from './base/fonts/RobotoCondensed-Bold.ttf?url';

const URLS = import.meta.glob('./art/*.ttf', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

/** The face the preview falls back to, for sizing and drawing a face it does not know. */
const FALLBACK = 'Roboto Condensed';
const FALLBACK_STACK = '"Roboto Condensed", "Arial Narrow", sans-serif';

/** A face's name as the metrics table spells it, matched without regard to case as the scheme's names are. */
function known(face: string): string | undefined {
  const f = face.trim().toLowerCase();
  return Object.keys(FONT_METRICS).find((k) => k.toLowerCase() === f);
}

/** A face's file at one weight: a URL for a bundled face, the bytes themselves for an imported one. */
interface FaceFile { url?: string; data?: ArrayBuffer; weight: string }

/**
 * Faces an imported HUD carries (spec, "Fonts"): the .ttf, .otf or .vfont
 * files its schemes' CustomFontFiles name, read at runtime by ttf.ts. Each
 * is registered under an alias that holds the import's id, so two imports
 * with a face of the same name never share it, and fontCell sizes it from
 * its own metrics by the same VDMX-first rule as the stock faces.
 */
const EXTRA_METRICS = new Map<string, FontMetrics>();
const EXTRA_FILES = new Map<string, FaceFile[]>();
const IMPORT_FACES = new Map<BaseKey, Map<string, string>>();

/** The alias for a scheme face on an imported HUD, when the upload carries that face. */
export function importedFace(key: BaseKey, face: string): string | undefined {
  if (!key.startsWith('imported:')) return undefined;
  let faces = IMPORT_FACES.get(key);
  if (!faces) { faces = readImportFaces(key); IMPORT_FACES.set(key, faces); }
  return faces.get(face.trim().toLowerCase());
}

function readImportFaces(key: BaseKey): Map<string, string> {
  const out = new Map<string, string>();
  const files = importedFiles(key)!;
  const tag = key.slice('imported:'.length, 'imported:'.length + 12);
  const paths = new Set<string>();
  for (const scheme of ['resource/clientscheme.res', 'resource/chatscheme.res']) {
    const root = parseKv(baseFile(key, scheme))[0];
    const list = root && typeof root.value !== 'string' ? kvFind(root.value, ['CustomFontFiles']) : undefined;
    if (!list || typeof list.value === 'string') continue;
    for (const n of list.value) {
      // "1" "resource/x.ttf", or the block form "1" { "font" "resource/x.ttf" ... }.
      const v = typeof n.value === 'string' ? (pcApplies(n.cond) ? n.value : undefined)
        : n.value.find((c) => c.key.toLowerCase() === 'font' && typeof c.value === 'string')?.value as string | undefined;
      if (v) paths.add(v.replace(/\\/g, '/').toLowerCase());
    }
  }
  for (const path of [...paths].sort()) {
    const raw = files.get(path);
    if (!raw) continue;                                        // a stock face, or one the upload lacks: the fallback as today
    let ttf: Uint8Array;
    let info: ReturnType<typeof readFont>;
    try { ttf = isVfont(raw) ? decodeVfont(raw) : raw; info = readFont(ttf); }
    catch { console.warn(`HUD preview: could not read the font ${path} in the imported HUD`); continue; }
    for (const name of info.names) {
      const lower = name.toLowerCase();
      const alias = out.get(lower) ?? `HudImp_${tag}_${name.replace(/[^A-Za-z0-9]/g, '_')}`;
      out.set(lower, alias);
      if (!EXTRA_METRICS.has(alias)) EXTRA_METRICS.set(alias, info.metrics);
      EXTRA_FILES.set(alias, [...(EXTRA_FILES.get(alias) ?? []), { data: ttf.slice().buffer, weight: String(cssWeight(info.weight)) }]);
    }
  }
  return out;
}

/** Tests only: forget every imported face. */
export function _resetImportFaces(): void { IMPORT_FACES.clear(); EXTRA_METRICS.clear(); EXTRA_FILES.clear(); }

export interface FontCell { em: number; ascent: number; cell: number }

/**
 * A scheme font's tall, in canvas pixels, to the em size the game draws at,
 * the ascent (the baseline's depth below the cell's top) and the cell height,
 * all in pixels. The tall is truncated first, as VGUI scales a proportional
 * tall to an int. A VDMX row gives the ppem and the cell's ascent and
 * descent; a tall outside the table's rows is scaled by winAscent +
 * winDescent, as is a face without one.
 */
export function fontCell(face: string, tallPx: number): FontCell {
  const m: FontMetrics = EXTRA_METRICS.get(face) ?? FONT_METRICS[known(face) ?? FALLBACK];
  const tall = Math.floor(tallPx + 1e-9);
  const v = m.vdmx;
  if (v && v.length >= 3 && tall >= v[1] - v[2] && tall <= v[v.length - 2] - v[v.length - 1]) {
    let best = -1;
    for (let i = 0; i < v.length; i += 3) if (v[i + 1] - v[i + 2] <= tall && (best < 0 || v[i] > v[best])) best = i;
    return { em: v[best], ascent: v[best + 1], cell: v[best + 1] - v[best + 2] };
  }
  const sum = m.winAscent + m.winDescent;
  return { em: tall * m.unitsPerEm / sum, ascent: tall * m.winAscent / sum, cell: tall };
}

/**
 * The CSS font-family for a scheme face. The stock faces (the two Trade
 * Gothics and the ToolBox icon face) are the exported fonts and Roboto
 * Condensed the preset's own file, each registered under its own name
 * (loadFace); Windows' faces are asked for by name, with the nearest
 * common stand-ins after them for a viewer without them.
 */
export function cssFamily(face: string): string {
  if (EXTRA_METRICS.has(face)) return `"${face}", ${FALLBACK_STACK}`;   // an imported HUD's own face, under its alias
  const name = known(face);
  if (name && name in FONT_FILES) return `"${name}", ${FALLBACK_STACK}`;   // an exported face: Trade Gothic, its bold, ToolBox
  switch (name) {
    case 'Roboto Condensed': return FALLBACK_STACK;
    case 'Verdana': return 'Verdana, "DejaVu Sans", "Bitstream Vera Sans", sans-serif';
    case 'Tahoma': return 'Tahoma, Verdana, "DejaVu Sans", sans-serif';
    case 'Arial': return 'Arial, "Liberation Sans", Helvetica, sans-serif';
    default: return FALLBACK_STACK;
  }
}

/**
 * The scheme's weight as a CSS weight. 0 is GDI's "don't care", which draws
 * the face regular; the stock "Trade Gothic Bold" is regular weight in a bold
 * face, so its boldness comes from the face, not from here.
 */
export function cssWeight(weight: number): number {
  if (!(weight > 0)) return 400;
  return Math.min(900, Math.max(100, Math.round(weight / 100) * 100));
}

/** The canvas font for a scheme face at a weight and a tall in pixels. */
export function canvasFont(face: string, weight: number, tallPx: number): string {
  return `${cssWeight(weight)} ${fontCell(face, tallPx).em}px ${cssFamily(face)}`;
}

// --- loading the faces ---

/** Each face the preview registers: its files, one per weight. */
const FILES: Record<string, FaceFile[]> = {
  ...Object.fromEntries(Object.entries(FONT_FILES).map(([face, file]) => [face, [{ url: URLS[`./art/${file}`], weight: '400' }]])),
  'Roboto Condensed': [{ url: regularUrl, weight: '400' }, { url: boldUrl, weight: '700' }],
};
const loads = new Map<string, { ready: boolean; waiting: Set<() => void> }>();

/**
 * Asks for a face the preview draws, the first time it is drawn, and calls
 * onAsset once it is ready so the canvas redraws in it; until then the
 * canvas draws the fallback stack. Every caller's onAsset is kept until the
 * load, as urlImage does, since the main canvas and the zoom each need their
 * own redraw. A face with no file (Windows' own) needs no load. Without
 * FontFace (happy-dom), or if a load fails, the fallback stays.
 */
export function loadFace(face: string, onAsset?: () => void): void {
  const name = EXTRA_FILES.has(face) ? face : known(face);
  const files = name ? EXTRA_FILES.get(name) ?? FILES[name] : undefined;
  if (!name || !files) return;
  let hit = loads.get(name);
  if (!hit) {
    const entry = { ready: false, waiting: new Set<() => void>() };
    loads.set(name, entry);
    hit = entry;
    try {
      const faces = files.filter((f) => f.data || f.url).map((f) => new FontFace(name, f.data ?? `url(${f.url})`, { weight: f.weight }));
      for (const f of faces) document.fonts.add(f);
      Promise.all(faces.map((f) => f.load())).then(() => {
        entry.ready = true;
        const fns = [...entry.waiting];
        entry.waiting.clear();
        for (const fn of fns) fn();
      }).catch(() => { console.warn(`HUD preview: the ${name} font did not load, drawing a stand-in`); });
    } catch { /* no FontFace here: the fallback stack stays */ }
  }
  if (!hit.ready && onAsset) hit.waiting.add(onAsset);
}

/** Tests only: forget every face asked for. */
export function _resetFaces(): void { loads.clear(); }
