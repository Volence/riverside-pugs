/**
 * Style slots: one texture the player can restyle, and everywhere it has to be wired in.
 *
 * In normal mode a texture gets a new name and the .res `image` keys in
 * `targets` are pointed at it, because an addon cannot replace a texture that
 * ships in pak01. `stockNames` are the pak01 names themselves; they are only
 * written in advanced mode, where the VPK mounts ahead of pak01. A slot with
 * no targets (the health bar fills, which game code names directly) has no
 * normal-mode route at all, so it must be advancedOnly.
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

const team = (n: number) => ({ file: 'resource/ui/hud/teamdisplayhud.res', path: [`TeamPlayer${n}`], key: 'image' });

export const SLOTS: StyleSlot[] = [
  { id: 'panelBg', label: 'Survivor panel background', advancedOnly: false, size: { w: 32, h: 32 },
    targets: [team(1), team(2), team(3), team(4)], stockNames: [], defaultColor: '0 0 0 140' },
  { id: 'weaponBoxActive', label: 'Active weapon box', advancedOnly: true, size: { w: 32, h: 32 },
    targets: [], stockNames: ['vgui/hud/scalablepanel_bgmidgrey_glow'], defaultColor: '40 40 40 215' },
  { id: 'weaponBoxInactive', label: 'Other weapon boxes', advancedOnly: true, size: { w: 32, h: 32 },
    targets: [], stockNames: ['vgui/hud/scalablepanel_bgmidgrey'], defaultColor: '0 0 0 130' },
  { id: 'barGreen', label: 'Health bar: healthy', advancedOnly: true, size: { w: 256, h: 16 },
    targets: [], stockNames: ['vgui/healthbar_green'], defaultColor: '80 200 80 255' },
  { id: 'barOrange', label: 'Health bar: hurt', advancedOnly: true, size: { w: 256, h: 16 },
    targets: [], stockNames: ['vgui/healthbar_orange'], defaultColor: '230 150 40 255' },
  { id: 'barRed', label: 'Health bar: critical', advancedOnly: true, size: { w: 256, h: 16 },
    targets: [], stockNames: ['vgui/healthbar_red'], defaultColor: '210 40 40 255' },
  { id: 'barWhite', label: 'Health bar: temporary', advancedOnly: true, size: { w: 256, h: 16 },
    targets: [], stockNames: ['vgui/healthbar_white'], defaultColor: '235 235 235 255' },
  { id: 'incapPanel', label: 'Incapacitated panel', advancedOnly: true, size: { w: 256, h: 256 },
    targets: [], stockNames: ['biker', 'manager', 'namvet', 'teenangst'].map((c) => `vgui/s_panel_${c}_incap`),
    defaultColor: '95 22 22 205' },
  { id: 'deadPanel', label: 'Dead panel', advancedOnly: true, size: { w: 256, h: 256 },
    targets: [], stockNames: ['vgui/s_panel_dead'], defaultColor: '70 70 70 190' },
];
