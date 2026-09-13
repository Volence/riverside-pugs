import { ZOMBIE_CLASSES } from '../../../src/replayFormat';

export type PictogramName = 'smoker' | 'boomer' | 'hunter' | 'tank' | 'witch';

/** Every figure is drawn in a 0..20 box, feet at the bottom, and is scaled
 *  to the medallion's disc by the caller. Kept as path data rather than PNGs
 *  so a pictogram costs one `fill` and no image load. */
export const PICTOGRAM_BOX = 20;

/** Simplified side-view silhouettes: tall and thin with a tongue for the
 *  smoker, round for the boomer, crouched for the hunter, hulking for the
 *  tank, thin with raised claws for the witch. Recognisable at 16px, which is
 *  all a pictogram inside a 22px medallion gets. */
export const PICTOGRAMS: Record<PictogramName, string> = {
  smoker: 'M8.5 6 h3 a1.4 1.4 0 0 1 1.4 1.4 v7.2 a1.4 1.4 0 0 1 -1.4 1.4 h-3 a1.4 1.4 0 0 1 -1.4 -1.4 v-7.2 a1.4 1.4 0 0 1 1.4 -1.4 Z M10 1.8 a2.2 2.2 0 1 0 0.01 0 Z M11 9 Q17 8 18 14 L16.6 14.4 Q15.8 9.8 11 10.6 Z',
  boomer: 'M10 6 a6.5 5.5 0 1 0 0.01 0 Z M10 2.1 a2.4 2.4 0 1 0 0.01 0 Z',
  hunter: 'M4 15 Q6 7 12 6 Q15 5 16 8 Q14 9 12 10 Q9 12 9 16 Z M14.5 2.8 a2.2 2.2 0 1 0 0.01 0 Z',
  tank: 'M3 17 L4 9 Q6 5 10 5.5 Q14 5 16 9 L17 17 Z M10 1.5 a2 2 0 1 0 0.01 0 Z',
  witch: 'M6 17 Q7 9 10 7 Q13 9 14 17 Z M10 2.1 a2.4 2.4 0 1 0 0.01 0 Z M4 10 Q7 8 8 11 L6.8 11.6 Q6.2 9.8 4.4 11 Z M16 10 Q13 8 12 11 L13.2 11.6 Q13.8 9.8 15.6 11 Z',
};

/** Zombie class byte (`m_zombieClass`, recorded in `cls` for every infected
 *  player in every format version) to figure. 0 is "no class yet". */
export function pictogramFor(cls: number): PictogramName | null {
  const name = ZOMBIE_CLASSES[cls];
  return name && name in PICTOGRAMS ? (name as PictogramName) : null;
}

let cache = new Map<string, Path2D>();

/** For tests: happy-dom has no Path2D, so tests install a stub and must be
 *  able to drop anything built under a previous stub. */
export function resetPictogramCache(): void { cache = new Map(); }

export function pictogramPath(name: string): Path2D | null {
  const d = (PICTOGRAMS as Record<string, string>)[name];
  if (!d || typeof Path2D === 'undefined') return null;
  let p = cache.get(name);
  if (!p) { p = new Path2D(d); cache.set(name, p); }
  return p;
}
