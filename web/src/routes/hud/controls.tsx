/**
 * The small pieces every HUD editor control is built from: a labelled
 * slider, a fieldset, the guarded number-box patch, and the colour helpers
 * that turn design.ts's "r g b a" strings into what a colour input and an
 * opacity slider need.
 */
import type { ComponentChildren } from 'preact';
import { clampOverride, type HudDesign, type ElementOverride, type RangeKey } from '../../hud/design';

export type SetDesign = (fn: (d: HudDesign) => HudDesign) => void;

/** One labelled slider with a live readout, matching Crosshair.tsx's. */
export function Slider(
  { label, value, min, max, step, onInput }:
  { label: string; value: number; min: number; max: number; step: number; onInput: (n: number) => void },
) {
  return (
    <label class="hud__row">
      <span>{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onInput={(e) => onInput(parseFloat((e.target as HTMLInputElement).value))}
      />
      <output class="num">{value}</output>
    </label>
  );
}

export function Field({ legend, children }: { legend: string; children: ComponentChildren }) {
  return (
    <fieldset class="hud__group">
      <legend class="eyebrow">{legend}</legend>
      {children}
    </fieldset>
  );
}

export type Patch = (p: Partial<ElementOverride>) => void;

/**
 * Apply a number box's value, clamped, or ignore it.
 *
 * An emptied box gives parseFloat('') === NaN, and nothing between here and
 * the generator would reject it: a NaN position comes out of formatPos as the
 * literal token "rNaN" and lands in a shipped .res file, which the game
 * cannot read and the canvas reads back as 0. A non-finite entry patches
 * nothing, so the box can be cleared and retyped while the design keeps its
 * last good value.
 *
 * Clamping through design.ts's clampOverride, the same table validateDesign
 * clamps against, means the design can never hold a value the downloaded
 * file would not: the box visibly snaps to the cap on the next render
 * instead of the canvas and the file quietly disagreeing.
 */
export function patchNum(
  patch: Patch, e: Event, key: RangeKey, to: (n: number) => Partial<ElementOverride>,
): void {
  const n = parseFloat((e.target as HTMLInputElement).value);
  if (Number.isFinite(n)) patch(to(clampOverride(key, n)));
}

/** design.ts's colours are always the raw four-byte "r g b a" string; these
 *  just pull enough out of that to drive a colour input and an opacity
 *  slider, without ever changing the stored representation itself. */
export function hexOf(rgba: string): string {
  const [r, g, b] = rgba.split(' ').map(Number);
  return `#${[r, g, b].map((n) => (Number.isFinite(n) ? n : 0).toString(16).padStart(2, '0')).join('')}`;
}
export function alphaPct(rgba: string): number {
  const a = Number(rgba.split(' ')[3]);
  return Math.round(((Number.isFinite(a) ? a : 255) / 255) * 100);
}
export function withHex(rgba: string, hex: string): string {
  const a = rgba.split(' ')[3] ?? '255';
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `${r} ${g} ${b} ${a}`;
}
export function withAlphaPct(rgba: string, pct: number): string {
  const [r, g, b] = rgba.split(' ');
  return `${r} ${g} ${b} ${Math.round((pct / 100) * 255)}`;
}
