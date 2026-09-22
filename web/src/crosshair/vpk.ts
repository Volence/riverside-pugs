/**
 * Binary encoders for the crosshair addon: a VTF texture, a VPK archive.
 *
 * Ported from the standalone crosshair.html, which carried these in an inline
 * <script id="lib"> ending in a `module.exports` guard for a node test that
 * was never written. Now a real module, and tested: every field below is a
 * byte offset into a format Source parses without complaining when it is
 * wrong, so a mistake here shows up as an invisible crosshair in game rather
 * than as an error anywhere.
 */

import { encodeVPK, encodeVTF } from '../vpk';
export { crc32, encodeVTF, encodeVPK, type VpkFile } from '../vpk';
const enc = new TextEncoder();

const VMT = 'UnlitGeneric\n{\n\t$basetexture "vgui/hud/altcrosshair"\n\t$translucent 1\n\t$vertexcolor 1\n\t$vertexalpha 1\n\t$ignorez 1\n\t$no_fullbright 1\n\t$nomip 1\n}\n';

function addonInfo(name: string): string {
  return '"AddonInfo"\n{\n\taddonSteamAppID\t\t500\n\taddontitle\t\t"'
    + name.replace(/"/g, '')
    + '"\n\taddonversion\t\t1.0\n\taddontagline\t\t"Custom crosshair (Crosshair Maker)"\n\taddonauthor\t\t"Crosshair Maker"\n\taddonDescription\t\t"Custom crosshair image drawn at screen center."\n}\n';
}

/** The complete addon: texture, material, HUD layout and addon manifest. */
export function buildVPK(
  name: string, width: number, height: number,
  rgba: Uint8ClampedArray, hudlayout: string,
  // Uint8Array<ArrayBuffer>, not a bare Uint8Array: TypeScript 7 made the
  // backing-buffer parameter significant, and the default ArrayBufferLike (which
  // admits SharedArrayBuffer) is not a BlobPart. Without this the one caller,
  // the crosshair downloader, cannot put the bytes in a Blob and `npm run
  // typecheck` fails. Every array here is built with `new Uint8Array(n)`, so the
  // buffer genuinely is an ArrayBuffer; only the annotation was too loose.
): Uint8Array<ArrayBuffer> {
  return encodeVPK([
    { path: 'materials/vgui/hud/altcrosshair.vtf', data: encodeVTF(width, height, rgba) },
    { path: 'materials/vgui/hud/altcrosshair.vmt', data: enc.encode(VMT) },
    { path: 'scripts/hudlayout.res', data: enc.encode(hudlayout) },
    { path: 'addoninfo.txt', data: enc.encode(addonInfo(name)) },
  ]);
}
