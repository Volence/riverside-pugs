/**
 * Style slots: one texture the player can restyle, and everywhere it has to be wired in.
 *
 * In normal mode a texture gets a new name and the .res `image` keys in
 * `targets` are pointed at it, because an addon cannot replace a texture that
 * ships in pak01. `stockNames` are the pak01 names themselves; they are only
 * written in advanced mode, where the VPK mounts ahead of pak01. A slot with
 * no targets (the weapon boxes and the incapacitated and dead panels, which
 * game code names directly) has no normal-mode route at all, so it must be
 * advancedOnly. There are no health bar slots: the game draws bar fills in
 * code and never reads the healthbar_* textures (probe T8).
 */
export interface StyleSlot {
  id: string; label: string;
  advancedOnly: boolean;
  size: { w: number; h: number };
  /** .res image keys to point at the new texture: file, path to the panel, key. */
  targets: { file: string; path: string[]; key: string }[];
  /** Advanced mode: stock material names (no extension, lower case) to overwrite as well. */
  stockNames: string[];
  defaultColor: string;
}

/**
 * The survivor card background. The card block's own `image`
 * (TeamPlayerN in teamdisplayhud.res) is never painted (probe T6), so the
 * slot targets a child fitPass injects into the card file instead:
 * HudEdCardBg, which exists only when this slot is restyled.
 */
const CARD_BG = { file: 'resource/ui/hud/teammatepanel.res', path: ['HudEdCardBg'], key: 'image' };

export const SLOTS: StyleSlot[] = [
  { id: 'panelBg', label: 'Survivor panel background', advancedOnly: false, size: { w: 32, h: 32 },
    targets: [CARD_BG], stockNames: [], defaultColor: '0 0 0 140' },
  { id: 'weaponBoxActive', label: 'Active weapon box', advancedOnly: true, size: { w: 32, h: 32 },
    targets: [], stockNames: ['vgui/hud/scalablepanel_bgmidgrey_glow'], defaultColor: '40 40 40 215' },
  { id: 'weaponBoxInactive', label: 'Other weapon boxes', advancedOnly: true, size: { w: 32, h: 32 },
    targets: [], stockNames: ['vgui/hud/scalablepanel_bgmidgrey'], defaultColor: '0 0 0 130' },
  { id: 'incapPanel', label: 'Incapacitated panel', advancedOnly: true, size: { w: 256, h: 256 },
    targets: [], stockNames: ['biker', 'manager', 'namvet', 'teenangst'].map((c) => `vgui/s_panel_${c}_incap`),
    defaultColor: '95 22 22 205' },
  { id: 'deadPanel', label: 'Dead panel', advancedOnly: true, size: { w: 256, h: 256 },
    targets: [], stockNames: ['vgui/s_panel_dead'], defaultColor: '70 70 70 190' },
];
