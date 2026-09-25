/**
 * The crosshair addon download: the texture, its material, the HUD layout
 * with the xHair element, and the addon manifest, in one .vpk. The
 * Crosshair page and the community page both build it here, so a shared
 * crosshair downloads as the same bytes its author would have saved.
 */
import { TEX } from './draw';
import { buildVPK } from './vpk';
import { artPixels } from './texture';
import type { CrosshairArt } from './model';
import HUDLAYOUT from './hudlayout.res?raw';

export interface CrosshairAddon { filename: string; bytes: Uint8Array<ArrayBuffer> }

/** The addon's name as a file name: letters, digits, _ and -, never empty. */
export const addonName = (name: string): string => (name.trim() || 'my_crosshair').replace(/[^A-Za-z0-9_-]+/g, '_');

/** The addon from texture pixels already drawn (TEX x TEX RGBA). */
export function crosshairAddonFromPixels(name: string, px: Uint8ClampedArray): CrosshairAddon {
  const safe = addonName(name);
  return { filename: `${safe}.vpk`, bytes: buildVPK(safe, TEX, TEX, px, HUDLAYOUT) };
}

/** The addon for a crosshair as a design or a community entry carries it. */
export async function crosshairAddon(name: string, art: CrosshairArt): Promise<CrosshairAddon> {
  const px = await artPixels(art);
  if (!px) throw new Error('This browser cannot draw the crosshair.');
  return crosshairAddonFromPixels(name, px);
}

/** Hand the browser a file to save. */
export function saveBytes(filename: string, bytes: Uint8Array<ArrayBuffer>, mime = 'application/octet-stream'): void {
  const blob = new Blob([bytes], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
