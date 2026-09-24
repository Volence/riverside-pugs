/**
 * How far the weapon selection's column reaches inside its HudWeaponSelection
 * panel, from the panel's own keys alone: the build (weaponsPass) sizes the
 * panel to it, and the preview (weapons.ts weaponSlots) lays the same column
 * out slot by slot. A leaf module, so build.ts can use it without importing
 * the preview.
 *
 * Why: the game right-aligns the column to the panel's right edge and clips
 * the numbers and icons (not the boxes) at the panel's edges
 * (/home/volence/l4d/hud/probe-phase2-rest/r2/shots/crops/weap-ab.png), and a
 * 4:1 gun upload was cut at the stock panel's left edge
 * (/home/volence/l4d/hud/probe-phase2-rest/w-verify/crops/game-0de.png). So
 * the panel grows to whatever the column needs (plan decision 1).
 *
 * The layout is weapons.ts's (its header has the client.dll source): every
 * slot right-aligned RightSideIndent in, the held slot 1.2 times its size,
 * each slot two 640-units under the last, box art grown by a pad of 4
 * 640-units (held) or 2 (the rest).
 */

/** The defaults client.dll registers for each key, used when a file leaves one out. */
export const WEAPON_KEY_DEFAULTS: Record<string, string> = {
  PrimaryWeaponsYPos: '0', PrimaryWeaponBoxWide: '0', PrimaryWeaponBoxTall: '0', PrimaryWeaponTall: '0',
  PrimaryWeaponAmmoX: '0', ReserveAmmoYPos: '0', PistolBoxWide: '0', PistolBoxTall: '0',
  RightSideIndent: '10', IconSize: '32',
  PrimaryAmmoFont: 'FrameTitle', PistolAmmoFont: 'HudAmmo',
  ReserveAmmoColor: '128 128 128 255', InactiveItemColor: '100 100 100 255',
};

/** The held slot's size, against the others. */
export const WEAPON_GROW = 1.2;

export interface ColumnInput {
  /** A HudWeaponSelection key's number, the default when absent. */
  n: (key: string) => number;
  panelWide: number;
  /** ScreenWidth / 640 in HUD units (weapons.ts unit640). */
  u: number;
  /** The widest gun picture the column can hold, width over height (the cells of every gun entry). */
  gunAspect: number;
  /** The clip font's and the pistol font's tall. */
  clipTall: number;
  pistolTall: number;
}

/**
 * The column's reach in panel units over the three held states: `left` the
 * smallest x anything is drawn at (below 0 is past the panel's left edge),
 * `bottom` the lowest edge. The clip numbers are estimated two digits wide
 * at 0.6 of their font's tall each, a digit's usual width in these faces;
 * the reserve number starts right of the clip and runs toward the right
 * edge, so it never sets the left reach.
 */
export function columnExtent(c: ColumnInput): { left: number; bottom: number } {
  const { n, panelWide: W, u } = c;
  const indent = n('RightSideIndent');
  const right = W - indent;
  let left = Infinity;
  let bottom = -Infinity;
  for (const held of ['primary', 'pistol', 'item'] as const) {
    let y = n('PrimaryWeaponsYPos');
    /** One slot's box, w x h, at y; returns its drawn height. */
    const slot = (w: number, h: number, active: boolean) => {
      const f = active ? WEAPON_GROW : 1;
      const pad = (active ? 4 : 2) * u;
      left = Math.min(left, right - w * f - pad);
      bottom = Math.max(bottom, y + h * f + pad);
      return h * f;
    };
    const gunActive = held === 'primary';
    const gunH = slot(n('PrimaryWeaponBoxWide'), n('PrimaryWeaponBoxTall'), gunActive);
    const iconH = n('PrimaryWeaponTall') * (gunActive ? WEAPON_GROW : 1);
    left = Math.min(left, right - c.gunAspect * iconH, W - n('PrimaryWeaponAmmoX') - (gunActive ? 5 : 0) - u - 1.2 * c.clipTall);
    bottom = Math.max(bottom, y + iconH / 2);
    y += gunH + 2 * u;
    const pistolH = slot(n('PistolBoxWide'), n('PistolBoxTall'), held === 'pistol');
    left = Math.min(left, right - pistolH - u - 2 * u - 1.2 * c.pistolTall);
    bottom = Math.max(bottom, y + pistolH);
    y += pistolH + 2 * u;
    const size = n('IconSize');
    if (size <= 0) continue;
    for (let i = 0; i < 3; i++) y += slot(size, size, held === 'item' && i === 0) + 2 * u;
  }
  return { left, bottom };
}
