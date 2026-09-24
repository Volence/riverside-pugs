/**
 * Downloads from the community page, built in the downloader's browser.
 *
 * A shared HUD is never served as a built .vpk: the design goes through
 * validateDesign, an imported base through openCommunityImport's checks,
 * and the addon comes out of the same buildHud/packHud the editor uses. So
 * what lands in the addons folder is files the editor writes, or import
 * files that passed the allowlist, and nothing else.
 *
 * This module pulls in the whole HUD builder, so the gallery imports it
 * lazily, on the first Download click, and never on its first load.
 */
import { validateDesign, safeName, usableCrosshair } from '../hud/design';
import { packHud } from '../hud/build';
import { assetsFor } from '../hud/assets';
import { readArt } from '../crosshair/model';
import { crosshairAddon, saveBytes } from '../crosshair/download';
import { openCommunityImport, SAFETY_FAILED } from './open';
import type { CommunityEntryDetail } from '../api';

export interface Downloaded { filename: string; bytes: Uint8Array<ArrayBuffer> }

/** Build and save a HUD entry's addon: a .vpk, or the Advanced .zip. */
export async function downloadCommunityHud(entry: CommunityEntryDetail): Promise<Downloaded> {
  if (entry.design === undefined || entry.design === null) throw new Error('This HUD has no design to build.');
  let design = usableCrosshair(validateDesign(entry.design), null);
  if (design.preset === 'imported') {
    // The server tied the design to the entry's import; a design naming any
    // other id could reach a HUD this browser imported privately.
    if (design.imported?.id !== entry.importId) throw new Error(SAFETY_FAILED);
    await openCommunityImport(entry);
  }
  design = validateDesign({ ...design, name: safeName(entry.title) });
  const p = packHud(design, await assetsFor(design));
  saveBytes(p.filename, p.bytes, p.mime);
  return { filename: p.filename, bytes: p.bytes };
}

/** Build and save a crosshair entry's addon, the same files the Crosshair page saves. */
export async function downloadCommunityCrosshair(entry: { title: string; art?: unknown }): Promise<Downloaded> {
  const art = readArt(entry.art);
  if (!art) throw new Error('This crosshair cannot be drawn.');
  const addon = await crosshairAddon(safeName(entry.title).replace(/ /g, '_'), art);
  saveBytes(addon.filename, addon.bytes);
  return addon;
}
