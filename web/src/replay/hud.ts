import { STATE, SURVIVOR_CHARACTERS } from '../../../src/replayFormat';

export function healthColor(health: number, alive: boolean): string {
  if (!alive) return '#6b6b6b';
  if (health > 40) return '#7ec95e';
  if (health > 20) return '#e8b04b';
  // Not the same red as tokens.css's --loss (#e35d5d): this is the in-game
  // HUD's danger red, unrelated to match win/loss, so it stays a literal
  // rather than borrowing a token that means something else here.
  return '#d9534f';
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
