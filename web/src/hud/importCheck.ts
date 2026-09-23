/**
 * Whether an imported HUD can be shown and built at all: the second of the
 * two checks an import passes (upload.ts's file checks are the first).
 *
 * The file checks list the shapes the editor is known to walk; this one
 * does not rely on a list. It builds the HUD the way the page first shows
 * it (a fresh design on the import, Normal and Advanced downloads) and draws
 * it once into a context that discards everything, for both sides, every
 * teammate card state and every weapon held. Whatever throws there would
 * have thrown on the page, so the page refuses the import (or, for one
 * stored before these checks, shows it locked with a way to remove it)
 * instead of freezing.
 *
 * A throw is traced to a file by trying the import once more without each
 * file it overrides, each on a throwaway id that is removed again at once:
 * the file whose removal makes the HUD draw is the one named. The answer is
 * kept per import id, which is the files' hash, so it never changes.
 */
import { registerImport, unregisterImport, onUnregister, importedFiles, BASE_PATHS, type BaseKey } from './base';
import { newDesign } from './design';
import { withImport } from './edit';
import { buildHud, importedHasXhair, teamLayout, teamCardRects, cardFrame, elementRect } from './build';
import { drawHud, visibleElements } from './mock';
import { elementById } from './elements';
import { fileProblem } from './upload';
import type { CardState } from './render';
import type { WeaponHeld } from './weapons';

const STATES: CardState[] = ['healthy', 'down', 'dead'];
const HELD: WeaponHeld[] = ['primary', 'pistol', 'item'];

/**
 * A 2D context that keeps nothing: every method is a no-op, measureText
 * measures nothing, and its canvas has no size (so render.ts's additive
 * paint takes its fallback rather than reading pixels back).
 */
function nullCtx(): CanvasRenderingContext2D {
  const state: Record<string | symbol, unknown> = { canvas: {} };
  const noop = (): undefined => undefined;
  return new Proxy(state, {
    get: (t, k) => (k in t ? t[k] : k === 'measureText' ? () => ({ width: 0 }) : noop),
    set: (t, k, v) => { t[k] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
}

/** Throws whatever the page would throw showing this import on a fresh design. */
function dryRun(id: string): void {
  const key: BaseKey = `imported:${id}`;
  const d = withImport(newDesign(null), { id, name: 'check' }, { art: null, hasXhair: importedHasXhair(key), reset: true });
  buildHud(d);
  buildHud({ ...d, advanced: true });
  teamLayout(d, elementById('teamColumn')!);
  teamCardRects(d, d.aspect);
  cardFrame(d);
  const ctx = nullCtx();
  for (const side of ['survivor', 'infected'] as const) {
    for (const el of visibleElements(side, d)) elementRect(d, el.id, d.aspect);
    for (const state of STATES) for (const held of HELD) drawHud(ctx, 1280, 720, d, side, null, undefined, { state, held });
  }
}

/** The file whose removal lets the HUD draw, or undefined when no single file does. */
function culprit(id: string, files: ReadonlyMap<string, Uint8Array>): string | undefined {
  for (const path of BASE_PATHS) {
    if (!files.has(path)) continue;
    const without = new Map(files);
    without.delete(path);
    const probe = `check-${id}-${path}`;
    registerImport(probe, without);
    try { dryRun(probe); return path; } catch { /* not this file alone */ } finally { unregisterImport(probe); }
  }
  return undefined;
}

const PROBLEMS = new Map<string, string | null>();
onUnregister((key) => { PROBLEMS.delete(key.slice('imported:'.length)); });

/**
 * Null when the import draws and builds, else one line saying why, naming
 * the file where one can be found. The import must be registered.
 */
export function importProblem(id: string): string | null {
  const known = PROBLEMS.get(id);
  if (known !== undefined) return known;
  const files = importedFiles(`imported:${id}`)!;
  let problem = fileProblem(files);
  if (!problem) {
    try { dryRun(id); }
    catch (e) {
      const why = (e as Error).message;
      const path = culprit(id, files);
      problem = path ? `This HUD's ${path} could not be shown (${why})` : `This HUD could not be shown (${why})`;
    }
  }
  PROBLEMS.set(id, problem);
  return problem;
}
