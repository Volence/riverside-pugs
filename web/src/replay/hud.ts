import { STATE, SURVIVOR_CHARACTERS } from '../../../src/replayFormat';

export function healthColor(health: number, alive: boolean): string {
  if (!alive) return '#958770';
  if (health > 40) return '#45b39c';
  if (health > 20) return '#c9a45c';
  // The site's red. It is the infected color as well, which is fine here: a
  // survivor this low is about to become their problem.
  return '#de4e40';
}

export function statusFlags(state: number): string[] {
  if ((state & STATE.ALIVE) === 0) return ['Dead'];
  const out: string[] = [];
  if (state & STATE.INCAP) out.push('Incapped');
  if (state & STATE.LEDGED) out.push('Hanging');
  if (state & STATE.PINNED) out.push('Pinned');
  if (state & STATE.BILED) out.push('Biled');
  if (state & STATE.BURNING) out.push('Burning');
  return out;
}

/**
 * Which portrait to show.
 *
 * Version 1 files hardcoded `cls` to 0 for every survivor, so the character
 * genuinely is not recorded there and the silhouette is the honest answer.
 * Believing the field anyway would put Bill's face on all four of them, which
 * looks like a bug in the viewer rather than a gap in the recording.
 */
export function portraitFor(cls: number, version: number, survivor: boolean): string {
  if (!survivor || version < 2) return '/portraits/unknown.png';
  const name = SURVIVOR_CHARACTERS[cls];
  return name ? `/portraits/${name}.png` : '/portraits/unknown.png';
}

/**
 * The two-tone bar, as fractions of the bar's width.
 *
 * Temporary health sits on top of permanent health rather than beside it, and
 * the pair is clamped so a player with 90 permanent and 90 temporary does not
 * draw a bar wider than the panel.
 */
export function barSegments(
  health: number, temp: number, max = 100,
): { perm: number; temp: number } {
  const perm = Math.max(0, Math.min(1, health / max));
  const tempFrac = Math.max(0, Math.min(1 - perm, temp / max));
  return { perm, temp: tempFrac };
}

/** The temporary health colour, shared by the map ring and the panel bar.
 *
 *  Kept in step with `.hudp__bar-temp` in app.css by hand, because CSS cannot
 *  import this and the map cannot read a stylesheet. The panel's old value was
 *  a much darker green, which was fine as a five pixel bar on the panel's own
 *  dark background and invisible as a two pixel arc over bright map art. This
 *  is light enough for the map and still reads as "not real health" against
 *  the permanent green beside it: 38 dE from it, and 61 or more from every
 *  colour in `healthColor`'s ramp. */
export const TEMP_HEALTH_COLOR = '#5f9d78';

/** The incapacitation pool a downed L4D survivor's health reads out of.
 *
 *  It starts here and bleeds towards zero. It is NOT a 0-100 health value,
 *  which is the trap both the map ring and this panel's bar used to fall
 *  into: health/100 clamped to 1 is a full bar, and healthColor(300) is
 *  green, so the moment a survivor hit the floor both surfaces agreed that
 *  they were perfectly fine. */
export const INCAP_POOL = 300;
/** How much of the bar or ring a downed survivor is allowed to fill. Small
 *  at every point, so it can never be mistaken for a healthy reading, but
 *  not fixed: it still shrinks as the pool bleeds out, so it carries the
 *  bleed-out clock instead of carrying nothing. */
export const INCAP_ARC_MIN = 0.06;
export const INCAP_ARC_MAX = 0.18;

export interface HealthBar {
  /** Permanent health, as a fraction of the whole bar or ring. */
  perm: number;
  /** Temporary health, stacked on top of `perm` and clamped so the two
   *  together never exceed the whole. */
  temp: number;
  /** What to draw the permanent segment in. */
  color: string;
  /** Whether `perm` is a downed survivor's bleed-out sliver rather than a
   *  health reading, which is the one case where the number beside the bar
   *  means something different from the bar. */
  downed: boolean;
}

/**
 * The single reading the map ring and the HUD panel both draw.
 *
 * They exist as one function because they were drifting as two. The ring read
 * PERMANENT health only while the panel drew permanent plus temporary through
 * `barSegments`, so a survivor on 20 permanent and 70 temporary showed a red
 * sliver on the map and a nearly full bar in the panel. The map, whose whole
 * purpose is to save a viewer looking down at the panel, was the less accurate
 * of the two. Agreement is now structural rather than a coincidence that a
 * later edit to one call site could quietly end.
 */
export function healthBar(
  health: number, temp: number, max: number, state: number,
): HealthBar {
  const alive = (state & STATE.ALIVE) !== 0;
  if (!alive) return { perm: 0, temp: 0, color: healthColor(0, false), downed: true };
  if ((state & (STATE.INCAP | STATE.LEDGED)) !== 0) {
    const pool = Math.max(0, Math.min(1, health / INCAP_POOL));
    return {
      perm: INCAP_ARC_MIN + (INCAP_ARC_MAX - INCAP_ARC_MIN) * pool,
      // A downed survivor has no temporary health, and the record's `temp`
      // is whatever it was before they went down.
      temp: 0,
      // Not healthColor(health): that would ask "is 300 more than 40?".
      color: healthColor(0, alive),
      downed: true,
    };
  }
  return {
    ...barSegments(health, temp, max),
    // Normalised by max, so a tank's 8000 reads as full rather than as a
    // number far off the end of the 0-100 ramp.
    color: healthColor((health / max) * 100, alive),
    downed: false,
  };
}
