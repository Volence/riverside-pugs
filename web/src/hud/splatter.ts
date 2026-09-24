/*
 * The damage splatters: the art behind a teammate card and the two scratch
 * strips around the player's own health bar. A player picks, for each one,
 * the stock art, none, a generated Fade, or their own image. This registry
 * lists the three and is a leaf: it must not import render.ts, art.ts or art/.
 *
 * - splatTeam, the teammate card splatter, is a stand-in. client.dll calls
 *   SetImage("hud/healthbar_bg_N") on each card's BackgroundImage by card slot,
 *   after the .res is applied, so the file's `image` key never wins, and an
 *   addon cannot replace a pak01 texture. The build therefore injects its own
 *   ImagePanel (SPLAT_STAND_IN) over the stock one and draws that at alpha 0.
 *   See "What the game does" in
 *   docs/superpowers/specs/2026-09-24-hud-editor-custom-splatter-design.md.
 * - splatTop and splatBottom, the own-health scratches, are repointed: their
 *   texture names come only from localplayerpanel.res, so the build rewrites
 *   the `image` key. Code tints them by health, hence `healthTint`.
 */
import { fadeTexture } from './textures';

export type SplatterId = 'splatTeam' | 'splatTop' | 'splatBottom';
export type SplatterKind = 'stock' | 'none' | 'fade' | 'image';
export interface SplatterStyle { kind: SplatterKind; color?: string; keepColours?: boolean }
export interface SplatterDef {
  id: SplatterId; label: string; file: string; block: string;
  size: { w: number; h: number };
  route: 'standIn' | 'repoint';
  healthTint: boolean;
  defaultColor: string;
  /** The texture's shape, for the upload hint. */
  aspect: string;
}

const TEAM_FILE = 'resource/ui/hud/teammatepanel.res';
const OWN_FILE = 'resource/ui/hud/localplayerpanel.res';

export const SPLATTERS: readonly SplatterDef[] = [
  { id: 'splatTeam', label: 'Teammate card splatter', file: TEAM_FILE, block: 'BackgroundImage',
    size: { w: 512, h: 256 }, route: 'standIn', healthTint: false, defaultColor: '0 0 0 170', aspect: '2:1' },
  { id: 'splatTop', label: 'Your health: top scratches', file: OWN_FILE, block: 'HealthbarTextureTop',
    size: { w: 256, h: 64 }, route: 'repoint', healthTint: true, defaultColor: '255 255 255 255', aspect: '4:1' },
  { id: 'splatBottom', label: 'Your health: bottom scratches', file: OWN_FILE, block: 'HealthbarTextureBottom',
    size: { w: 256, h: 64 }, route: 'repoint', healthTint: true, defaultColor: '255 255 255 255', aspect: '4:1' },
];
export const SPLAT_STAND_IN = 'HudEdSplatter';
export const splatterDef = (id: string): SplatterDef | undefined => SPLATTERS.find((s) => s.id === id);
export const splatterMaterial = (id: SplatterId): string => `vgui/hud/hudeditor/${id.toLowerCase()}`;
/** The .res `image` value: an ImagePanel prefixes `vgui/` itself. */
export const splatterImageKey = (id: SplatterId): string => `hud/hudeditor/${id.toLowerCase()}`;
export const splatterForMaterial = (material: string): SplatterDef | undefined =>
  SPLATTERS.find((s) => splatterMaterial(s.id) === material);

/**
 * Whether a splatter draws custom art: a Fade always, an Image only with its
 * picture stored (a share link carries the kind but no picture, so it shows Stock).
 */
export function splatterActive(d: { splatters?: Partial<Record<SplatterId, SplatterStyle>>; images: Record<string, unknown> }, id: SplatterId): boolean {
  const s = d.splatters?.[id];
  return s?.kind === 'fade' || (s?.kind === 'image' && d.images[id] !== undefined);
}

export function fadePixels(def: SplatterDef, style: SplatterStyle): Uint8ClampedArray {
  return fadeTexture(def.size.w, def.size.h, style.color ?? def.defaultColor);
}
