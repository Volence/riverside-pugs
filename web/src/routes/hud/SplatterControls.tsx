/*
 * The Splatter panel's rows: for each damage splatter (hud/splatter.ts) the
 * stock art, none, a generated Fade or the player's own picture. What a row
 * shows comes from the design alone (splatterKind, splatterSource), so Undo,
 * a preset switch or an import land here with nothing of the row's own to
 * go stale.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { HudDesign } from '../../hud/design';
import type { SplatterDef, SplatterKind, SplatterStyle } from '../../hud/splatter';
import { splatterKind } from '../../hud/edit';
import { splatterSource, tinted, healthRgb } from '../../hud/render';
import { hexOf, alphaPct, withHex, withAlphaPct, type EditMode } from './controls';

/**
 * The three health colours the game multiplies a scratch by (healthRgb), at
 * sample healths that land in each band.
 */
const TINTS: { label: string; rgb: [number, number, number] }[] = [
  { label: 'Healthy', rgb: healthRgb(100, 100, false) },
  { label: 'Hurt', rgb: healthRgb(40, 100, false) },
  { label: 'Critical', rgb: healthRgb(10, 100, false) },
];
/** A strip canvas's backing size; CSS shows it at half, 64 x 16, so it stays sharp on a dense screen. */
const STRIP_W = 128;
const STRIP_H = 32;

/**
 * A scratch's picture as the game shows it at each health band: the same
 * source the preview draws (splatterSource), multiplied by the health
 * colour, or untinted when Keep my colours is on. Where there is no 2D
 * context (happy-dom) or the picture is still loading, the canvases stay
 * blank; a stored picture that finishes loading redraws them.
 */
export function TintStrip({ design, def }: { design: HudDesign; def: SplatterDef }) {
  const refs = useRef<(HTMLCanvasElement | null)[]>([]);
  const [loaded, setLoaded] = useState(0);
  const keep = design.splatters?.[def.id]?.keepColours === true;

  useEffect(() => {
    const source = splatterSource(design, def.id, () => setLoaded((n) => n + 1));
    TINTS.forEach(({ rgb }, i) => {
      const c = refs.current[i];
      const ctx = c?.getContext('2d');
      if (!c || !ctx) return;
      ctx.clearRect(0, 0, c.width, c.height);
      if (!source) return;
      const img = keep ? source.src : tinted(source.src, source.key, rgb[0], rgb[1], rgb[2], def.size.w, def.size.h);
      ctx.drawImage(img, 0, 0, c.width, c.height);
    });
  }, [design, def, keep, loaded]);

  return (
    <div class="hud__tintstrip">
      {TINTS.map(({ label }, i) => (
        <figure key={label}>
          <canvas
            ref={(el) => { refs.current[i] = el; }} width={STRIP_W} height={STRIP_H}
            role="img" aria-label={label}
          />
          <figcaption>{label}</figcaption>
        </figure>
      ))}
    </div>
  );
}

/**
 * One splatter. `problem` (splatterProblem) disables every control but Reset
 * and says why: the base has no such block, or its preset hides the
 * scratches. Reset stays on there, so an entry a preset switch left behind
 * can still be cleared; it is off only while there is nothing to reset: no
 * stored style, and for the teammate splatter no hide.
 */
export function SplatterRow(
  { def, design, imported, problem, error, onChange, onEnd, onUpload, onReset }: {
    def: SplatterDef; design: HudDesign; imported: boolean; problem: string | null; error: string | undefined;
    onChange: (p: Partial<SplatterStyle>, mode?: EditMode) => void;
    onEnd: () => void;
    onUpload: (file: File) => void;
    onReset: () => void;
  },
) {
  const kind = splatterKind(design, def.id);
  const style = design.splatters?.[def.id];
  const color = style?.color ?? def.defaultColor;
  const off = problem !== null;
  // An Image with no picture stored (a share link carries none) draws stock,
  // so there is nothing to tint yet.
  const noPicture = kind === 'image' && design.images[def.id] === undefined;
  const custom = kind === 'fade' || (kind === 'image' && !noPicture);

  return (
    <div class="hud__stylerow" role="group" aria-label={def.label}>
      <span class="hud__stylerow-label">{def.label}</span>
      <select
        aria-label={`${def.label} style`} value={kind} disabled={off}
        onChange={(e) => onChange({ kind: (e.target as HTMLSelectElement).value as SplatterKind })}
      >
        <option value="stock">{imported ? 'As imported' : 'Stock'}</option>
        <option value="none">None</option>
        <option value="fade">Fade</option>
        <option value="image">Image</option>
      </select>
      {kind === 'fade' && (
        <>
          <input
            type="color" aria-label={`${def.label} colour`} value={hexOf(color)} disabled={off}
            onInput={(e) => onChange({ color: withHex(color, (e.target as HTMLInputElement).value) }, 'gesture')}
            onChange={onEnd}
          />
          <input
            type="range" min={0} max={100} step={1} aria-label={`${def.label} opacity`} value={alphaPct(color)} disabled={off}
            onInput={(e) => onChange({ color: withAlphaPct(color, parseFloat((e.target as HTMLInputElement).value)) }, 'gesture')}
            onChange={onEnd}
          />
        </>
      )}
      {kind === 'image' && (
        <label class="hud__file hud__file--inline">
          <span class="btn btn--ghost btn--sm">Choose image</span>
          <input
            type="file" accept="image/*" aria-label={`${def.label} image`} disabled={off}
            onChange={(e) => {
              const input = e.target as HTMLInputElement;
              const f = input.files?.[0];
              if (f) onUpload(f);
              input.value = '';
            }}
          />
        </label>
      )}
      <button
        type="button" class="btn btn--ghost btn--sm" onClick={onReset}
        disabled={style === undefined && kind !== 'none'}
      >
        Reset to stock
      </button>
      {kind === 'image' && (
        <p class="muted hud__splatfull">
          Stretched to {def.aspect}, {def.size.w} x {def.size.h} is ideal.
          {def.healthTint && ' Light or white art works best: the game multiplies it by the health colour, unless you untick Colour by health.'}
        </p>
      )}
      {noPicture && (
        <p class="muted hud__splatfull">No picture yet (share links do not carry pictures), showing stock.</p>
      )}
      {def.healthTint && custom && (
        <div class="hud__splatfull">
          <label class="hud__check">
            <input
              type="checkbox" checked={!style?.keepColours} disabled={off}
              onChange={(e) => onChange({ keepColours: !(e.target as HTMLInputElement).checked })}
            />
            <span>Colour by health</span>
          </label>
          <TintStrip design={design} def={def} />
        </div>
      )}
      {error && <p class="error hud__splatfull">{error}</p>}
      {problem && <p class="muted hud__splatfull">{problem}</p>}
    </div>
  );
}
