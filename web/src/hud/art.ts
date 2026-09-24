/**
 * The preview's picture of the game's HUD art.
 *
 * `art/` holds PNGs exported once from the owner's pak01 by
 * scripts/export-hud-art.py, plus a generated index. They exist so the canvas
 * can draw a portrait or a bar with the real texture instead of a grey box.
 * They are for the preview only: nothing under build.ts imports this module,
 * and art.test.ts fails if that ever changes, because a generated HUD must
 * never ship Valve's textures back to a player who already owns them.
 */
import { ART } from './art/index';

const URLS = import.meta.glob('./art/*.png', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

/**
 * VGUI resolves an ImagePanel's `image` relative to materials/vgui/, so
 * `hud/x` is `vgui/hud/x`, and a leading `../vgui/` is the same folder spelled
 * from inside it. Case is folded because pak01 names are lower case while the
 * .res files are not consistent.
 */
export function normaliseMaterial(image: string): string {
  let s = image.trim().replace(/\\/g, '/').toLowerCase();
  if (s.startsWith('../vgui/')) s = s.slice('../'.length);
  else if (!s.startsWith('vgui/')) s = 'vgui/' + s;
  return s.replace(/\.(vtf|vmt)$/, '');
}

export function artUrl(material: string): string | undefined {
  const file = ART[material];
  return file ? URLS[`./art/${file}`] : undefined;
}

/**
 * The teammate card's item icons. They are glyphs of the game's ToolBox icon
 * font, not textures, so they are named icon/item/* rather than by a material;
 * the export script draws each to a PNG. Medkit, pills, molotov, pipe bomb:
 * the characters '!', '"', '#' and '$'.
 */
export const ITEM_ICONS: readonly string[] = ['icon/item/medkit', 'icon/item/pills', 'icon/item/molotov', 'icon/item/pipebomb'];

/**
 * The weapon selection's icons, the sample loadout the preview shows. The
 * game's weapon selection draws cells of vgui/hud/iconsheet that
 * mod_textures.txt names (icon_equip_*), looked up by client.dll, not the
 * ToolBox glyphs the weapon scripts name; the export script cuts each cell to
 * a PNG, and EQUIP_ICON_SIZE in the index keeps each cell's size.
 */
export const EQUIP_ICONS: readonly string[] = [
  'icon/equip/pumpshotgun', 'icon/equip/dualpistols', 'icon/equip/molotov', 'icon/equip/medkit', 'icon/equip/pills',
];

/** The use/heal bar's icon: mod_textures.txt icon_healing, cut from vgui/hud/iconsheet by the export script. */
export const HEALING_ICON = 'icon/healing';

/** Every material the renderer can ask for, and the item and weapon icons. art.test.ts holds the index to this list. */
export const NEEDED_MATERIALS: readonly string[] = [
  'vgui/s_panel_biker', 'vgui/s_panel_manager', 'vgui/s_panel_namvet', 'vgui/s_panel_teenangst',
  // Stock names this as the card block's image, which the game never paints (probe T6); kept so the index stays complete.
  'vgui/s_panel_background',
  'vgui/hud/healthbar_bg_1', 'vgui/hud/healthbar_bg_2', 'vgui/hud/healthbar_bg_3', 'vgui/hud/healthbar_bg_4',
  'vgui/hud/infected_healthbar_bg_1',
  'vgui/hud/pz_healthbar_50', 'vgui/hud/pz_healthbar_250', 'vgui/hud/pz_healthbar_3000',
  'vgui/hud/detail_scratches_top_1', 'vgui/hud/detail_scratches_bottom_1',
  'vgui/hud/overlay_dead',
  'vgui/healthbar_green', 'vgui/healthbar_orange', 'vgui/healthbar_red', 'vgui/healthbar_white', 'vgui/healthbar_grey',
  'vgui/hud/scalablepanel_bgmidgrey', 'vgui/hud/scalablepanel_bgmidgrey_glow',
  'vgui/s_panel_dead',
  'vgui/s_panel_biker_incap', 'vgui/s_panel_manager_incap', 'vgui/s_panel_namvet_incap', 'vgui/s_panel_teenangst_incap',
  // The own health panel: DuckingIcon's art (named by localplayerpanel.res), and HealthPanel's
  // bar outline (named by client.dll; probe B1 Q3 showed the fill sits inset inside it).
  'vgui/hud/crouch_survivor', 'vgui/hud/s_healthbar_outline',
  // The kill notice box: pzdamagerecordpanel.res label4background names it, and the game draws
  // it behind a notice (probe B2, probe-phase2/b2/shots-kill/b2-killnotice/b2-f.png).
  'vgui/hud/scalablepanel_bgblack_outlinegrey',
  // The ability timer: code sets pz_charge_bg on AbilityTimerHud.res BackgroundImage (the black
  // splat behind the ring, probe-phase2/b3/shots-rerun/b3-rerun/b3-b.png), each class's icon on
  // AbilityImage (the red rings are part of those textures), and the file names the meter as
  // Progress's fg_image. The Hunter's is pz_charge_lunge: the unused pz_charge_pounce is not it.
  'vgui/hud/pz_charge_bg', 'vgui/hud/pz_charge_meter',
  'vgui/hud/pz_charge_lunge', 'vgui/hud/pz_charge_smoker', 'vgui/hud/pz_charge_boomer', 'vgui/hud/pz_charge_tank',
  // The use/heal bar's AwardIcon (progressbar.res "icon" "icon_healing", a cell of vgui/hud/iconsheet).
  HEALING_ICON,
  ...ITEM_ICONS,
  ...EQUIP_ICONS,
];
