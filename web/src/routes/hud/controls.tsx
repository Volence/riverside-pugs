/**
 * The small pieces every HUD editor control is built from: a labelled
 * slider, a fieldset, the guarded number-box patch, and the colour helpers
 * that turn design.ts's "r g b a" strings into what a colour input and an
 * opacity slider need.
 */
import type { ComponentChildren } from 'preact';
import { clampOverride, type HudDesign, type ElementOverride, type RangeKey } from '../../hud/design';

/**
 * How a control's change is recorded in the undo history: a discrete
 * `step`, part of a `gesture` that ends when the control lets go (a slider
 * released, a number box blurred), or an arrow-key nudge that coalesces with
 * the previous one on the same selection.
 */
export type EditMode = 'step' | 'gesture' | { nudge: string };
/** The page's one way to change the design: every control calls it. */
export type Edit = (fn: (d: HudDesign) => HudDesign, mode?: EditMode) => void;

/** A number box's gesture ends where typing ends: on blur, or on Enter. */
export function endsOn(end: () => void): { onBlur: () => void; onKeyDown: (e: KeyboardEvent) => void } {
  return { onBlur: end, onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter') end(); } };
}

/**
 * Whether a key press lands in a box the browser keeps its own undo for.
 * There Ctrl+Z undoes the typing, not the design; everywhere else (the
 * canvas, a checkbox, a slider, a button) the editor's undo applies.
 */
export function typedInto(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable || t.tagName === 'TEXTAREA') return true;
  return t.tagName === 'INPUT' && ['text', 'number', 'search', 'email', 'url'].includes((t as HTMLInputElement).type);
}

/** One labelled slider with a live readout, matching Crosshair.tsx's. A drag is one gesture: `onEnd` fires on release. */
export function Slider(
  { label, value, min, max, step, onInput, onEnd }:
  { label: string; value: number; min: number; max: number; step: number; onInput: (n: number) => void; onEnd?: () => void },
) {
  return (
    <label class="hud__row">
      <span>{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onInput={(e) => onInput(parseFloat((e.target as HTMLInputElement).value))}
        onChange={onEnd}
      />
      <output class="num">{value}</output>
    </label>
  );
}

/**
 * A slider with a number box beside it, both editing one value: the slider
 * for a quick drag, the box for an exact number. Both carry `label` as
 * their name, told apart by role (slider, spinbutton). A drag or a typed
 * run is one gesture, ended on release, blur or Enter; an emptied box
 * patches nothing, like patchNum.
 */
export function SliderNum(
  { label, value, min, max, onInput, onEnd }:
  { label: string; value: number; min: number; max: number; onInput: (n: number) => void; onEnd: () => void },
) {
  const typed = (e: Event) => {
    const n = parseFloat((e.target as HTMLInputElement).value);
    if (Number.isFinite(n)) onInput(n);
  };
  return (
    <div class="hud__row hud__row--num">
      <span>{label}</span>
      <input type="range" aria-label={label} min={min} max={max} step={1} value={value} onInput={typed} onChange={onEnd} />
      <input type="number" aria-label={label} min={min} max={max} value={value} onInput={typed} {...endsOn(onEnd)} />
    </div>
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

export type Patch = (p: Partial<ElementOverride>, mode?: EditMode) => void;

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
  if (Number.isFinite(n)) patch(to(clampOverride(key, n)), 'gesture');
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
