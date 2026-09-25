/**
 * Style slots: one texture the player can restyle, and everywhere it has to be wired in.
 *
 * In normal mode a texture gets a new name and the .res `image` keys in
 * `targets` are pointed at it, because an addon cannot replace a texture that
 * ships in pak01. `stockNames` are the pak01 names themselves; they are only
 * written in advanced mode, where the VPK mounts ahead of pak01. A slot with
 * no targets (the incapacitated and dead panels, which game code names
 * directly) has no normal-mode route at all, so it must be advancedOnly. The
 * weapon boxes were slots like that until probe B (2026-09-23) showed that
 * repointing mod_textures.txt restyles them from a normal addon: they are
 * the weapon selection's own setting now (HudDesign.weapons). There are no health bar slots: the game draws bar fills in
 * code and never reads the healthbar_* textures (probe T8).
 */
export interface StyleSlot {
  id: string; label: string;
  advancedOnly: boolean;
  size: { w: number; h: number };
  /**
   * .res image keys to point at the new texture: file, path to the panel,
   * key, and what goes before `hud/hudeditor/<id>` in the value (nothing by
   * default: an image key is relative to materials/vgui/).
   */
  targets: { file: string; path: string[]; key: string; prefix?: string }[];
  /** Advanced mode: stock material names (no extension, lower case) to overwrite as well. */
  stockNames: string[];
  defaultColor: string;
  /**
   * A Tab screen slot (tab screen spec 4.1): the page lists these under a
   * Tab screen heading of their own in Styles, as Layers groups the Tab
   * elements.
   */
  tab?: true;
}

/**
 * The survivor card background. The card block's own `image`
 * (TeamPlayerN in teamdisplayhud.res) is never painted (probe T6), so the
 * slot targets a child fitPass injects into the card file instead:
 * HudEdCardBg, which exists only when this slot is restyled.
 */
const CARD_BG = { file: 'resource/ui/hud/teammatepanel.res', path: ['HudEdCardBg'], key: 'image' };

/**
 * Your own health background, the same way. LocalPlayer's own `image`
 * (localplayerdisplay.res) is never painted (probe Q2, B1 a: the magenta
 * image did not show), so the slot targets a child the build injects into
 * the panel file: HudEdOwnBg, which exists only when this slot is restyled.
 * Modern's ModBg is the proof that a child there paints.
 */
const OWN_BG = { file: 'resource/ui/hud/localplayerpanel.res', path: ['HudEdOwnBg'], key: 'image' };

/**
 * The Tab screen's boxes and rows (tab screen spec 2.1 items 2, 3 and 6,
 * 4.1; confirmed open by TAB-1, /home/volence/l4d/hud/probe-tab/RESULTS.md,
 * tab1/runs/tab-survivor/tab-a.png: probe_green, probe_magenta and
 * probe_purple drew flat in these exact blocks). The boxes are
 * ScalableImagePanels, which take no tint, so a box's colour can only be its
 * texture. The value is written ../vgui/hud/hudeditor/<id>, the form TAB-1
 * drew and the stock files use for their own. The stock box art is shared
 * with the kill notices, so no stock name is ever written (stockNames []).
 * A 64-texel box keeps a rounded style's radius (16) inside the file's
 * 16-texel source corners.
 */
const TAB_IMAGE = { key: 'image', prefix: '../vgui/' };
const VERSUS_FILE = 'resource/ui/versusmodescoreboard.res';
const TAB_SLOTS: StyleSlot[] = [
  { id: 'tabStatBox', label: 'Versus score box', advancedOnly: false, size: { w: 64, h: 64 }, tab: true,
    targets: [{ file: VERSUS_FILE, path: ['StatBreakdownHighlightImage'], ...TAB_IMAGE }], stockNames: [], defaultColor: '0 0 0 160' },
  // One slot for both teams' boxes: the game shows one at a time (the enemy's to the infected side, TAB-1 tab-c).
  { id: 'tabTeamBox', label: 'Team score box', advancedOnly: false, size: { w: 64, h: 64 }, tab: true,
    targets: [{ file: VERSUS_FILE, path: ['YourTeamHighlightImage'], ...TAB_IMAGE }, { file: VERSUS_FILE, path: ['EnemyTeamHighlightImage'], ...TAB_IMAGE }],
    stockNames: [], defaultColor: '140 0 0 200' },
  { id: 'tabRowBg', label: 'Teammate rows', advancedOnly: false, size: { w: 256, h: 32 }, tab: true,
    targets: [{ file: 'resource/ui/scoreboardsurvivor.res', path: ['PlayerBackground'], ...TAB_IMAGE }], stockNames: [], defaultColor: '60 80 90 230' },
];

export const SLOTS: StyleSlot[] = [
  { id: 'panelBg', label: 'Survivor panel background', advancedOnly: false, size: { w: 32, h: 32 },
    targets: [CARD_BG], stockNames: [], defaultColor: '0 0 0 140' },
  { id: 'ownBg', label: 'Your health background', advancedOnly: false, size: { w: 32, h: 32 },
    targets: [OWN_BG], stockNames: [], defaultColor: '0 0 0 140' },
  { id: 'incapPanel', label: 'Incapacitated panel', advancedOnly: true, size: { w: 256, h: 256 },
    targets: [], stockNames: ['biker', 'manager', 'namvet', 'teenangst'].map((c) => `vgui/s_panel_${c}_incap`),
    defaultColor: '95 22 22 205' },
  { id: 'deadPanel', label: 'Dead panel', advancedOnly: true, size: { w: 256, h: 256 },
    targets: [], stockNames: ['vgui/s_panel_dead'], defaultColor: '70 70 70 190' },
  ...TAB_SLOTS,
];
