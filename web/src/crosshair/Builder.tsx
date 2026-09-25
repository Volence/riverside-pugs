/**
 * The crosshair builder's controls: presets, shape and its sizes, colour and
 * outline. One component for both places a crosshair is built, the
 * Crosshair Maker page and the HUD editor's side panel, so the two can
 * never offer different ranges or presets. Every range is model.ts's
 * LIMITS, the one readState clamps a stored crosshair to.
 *
 * `set` takes a patch. Sliders and the colour picker fire on every step of
 * a drag, so they pass `gesture` and call `end` when let go: the HUD editor
 * records the whole drag as one undo step. Everything else is one step.
 */
import type { ComponentChildren } from 'preact';
import { PRESETS, SWATCHES, type CrosshairState, type Shape } from './draw';
import { LIMITS } from './model';

const SHAPES: [Shape, string][] = [
  ['cross', 'Cross'], ['crossdot', 'Cross + dot'], ['t', 'T'],
  ['dot', 'Dot'], ['circle', 'Circle'], ['circledot', 'Circle + dot'],
];

/** One labelled slider with a live readout. */
export function Slider(
  { label, value, range, onInput, onEnd }:
  { label: string; value: number; range: readonly [number, number, number]; onInput: (n: number) => void; onEnd?: () => void },
) {
  return (
    <label class="xh__row">
      <span>{label}</span>
      <input
        type="range" aria-label={label} min={range[0]} max={range[1]} step={range[2]} value={value}
        onInput={(e) => onInput(parseFloat((e.target as HTMLInputElement).value))}
        onChange={onEnd}
      />
      <output class="num">{value}</output>
    </label>
  );
}

export function Field({ legend, children }: { legend: string; children: ComponentChildren }) {
  return (
    <fieldset class="xh__group">
      <legend class="eyebrow">{legend}</legend>
      {children}
    </fieldset>
  );
}

export function CrosshairBuilder(
  { state, set, end, withImage = false }: {
    state: CrosshairState;
    set: (patch: Partial<CrosshairState>, gesture?: boolean) => void;
    end?: () => void;
    /** Offer the Imported image shape: the Crosshair page's own import. */
    withImage?: boolean;
  },
) {
  const showArms = ['cross', 'crossdot', 't'].includes(state.shape);
  const showDot = ['dot', 'crossdot', 'circledot'].includes(state.shape);
  const showCircle = ['circle', 'circledot'].includes(state.shape);
  const slide = (key: keyof typeof LIMITS, label: string) => (
    <Slider label={label} value={state[key]} range={LIMITS[key]} onInput={(n) => set({ [key]: n }, true)} onEnd={end} />
  );
  const shapes = withImage ? [...SHAPES, ['image', 'Imported image'] as [Shape, string]] : SHAPES;

  return (
    <>
      <Field legend="Presets">
        <div class="xh__presets">
          {Object.entries(PRESETS).map(([label, p]) => (
            <button key={label} type="button" class="btn btn--ghost btn--sm" onClick={() => set(p)}>{label}</button>
          ))}
        </div>
      </Field>

      <Field legend="Shape">
        <label class="xh__row">
          <span>Shape</span>
          <select
            aria-label="Shape" value={state.shape}
            onChange={(e) => set({ shape: (e.target as HTMLSelectElement).value as Shape })}
          >
            {shapes.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <span />
        </label>
        {showArms && slide('len', 'Length')}
        {(showArms || showCircle) && slide('thick', 'Thickness')}
        {showArms && slide('gap', 'Gap')}
        {showDot && slide('dot', 'Dot size')}
        {showCircle && slide('radius', 'Radius')}
        {showArms && (
          <label class="xh__check">
            <input
              type="checkbox" checked={state.round}
              onChange={(e) => set({ round: (e.target as HTMLInputElement).checked })}
            />
            <span>Rounded ends</span>
          </label>
        )}
      </Field>

      <Field legend="Colour">
        <label class="xh__row">
          <span>Colour</span>
          <input
            type="color" aria-label="Colour" value={state.color}
            onInput={(e) => set({ color: (e.target as HTMLInputElement).value }, true)}
            onChange={end}
          />
          <span />
        </label>
        <div class="xh__swatches">
          {SWATCHES.map((c) => (
            <button
              key={c} type="button" class="xh__swatch" style={{ background: c }}
              title={c} aria-label={c} onClick={() => set({ color: c })}
            />
          ))}
        </div>
        {slide('alpha', 'Opacity')}
      </Field>

      <Field legend="Outline">
        {slide('outline', 'Width')}
        {slide('oalpha', 'Opacity')}
      </Field>
    </>
  );
}
