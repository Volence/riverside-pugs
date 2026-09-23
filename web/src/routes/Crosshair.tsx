import { useEffect, useRef, useState } from 'preact/hooks';
import { Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import {
  DEFAULT_STATE, PRESETS, PX_AT_1080, RES_SCALE, SWATCHES, TEX,
  drawBackdrop, drawCrosshair,
  type Backdrop, type CrosshairState, type Res, type Shape,
} from '../crosshair/draw';
import { buildVPK } from '../crosshair/vpk';
import { CROSSHAIR_KEY, crosshairPixels } from '../crosshair/saved';
import HUDLAYOUT from '../crosshair/hudlayout.res?raw';

const STORAGE_KEY = CROSSHAIR_KEY;

/** Per-viewer convenience only, so every access is guarded: a private window
 *  or blocked site data makes these throw rather than return null. */
function loadState(): CrosshairState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULT_STATE, ...JSON.parse(raw) } : DEFAULT_STATE;
  } catch {
    return DEFAULT_STATE;
  }
}

const SHAPES: [Shape, string][] = [
  ['cross', 'Cross'], ['crossdot', 'Cross + dot'], ['t', 'T'],
  ['dot', 'Dot'], ['circle', 'Circle'], ['circledot', 'Circle + dot'],
  ['image', 'Imported image'],
];
const BACKDROPS: [Backdrop, string][] = [
  ['scene', 'Saferoom'], ['dark', 'Dark'], ['bright', 'Bright'],
  ['grey', 'Grey'], ['shot', 'My screenshot'],
];
const RESOLUTIONS: [Res, string][] = [
  ['1080', '1920 x 1080'], ['1440', '2560 x 1440'],
  ['2160', '3840 x 2160'], ['768', '1366 x 768'],
];

/** One labelled slider with a live readout. */
function Slider(
  { label, value, min, max, step, onInput }:
  { label: string; value: number; min: number; max: number; step: number; onInput: (n: number) => void },
) {
  return (
    <label class="xh__row">
      <span>{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onInput={(e) => onInput(parseFloat((e.target as HTMLInputElement).value))}
      />
      <output class="num">{value}</output>
    </label>
  );
}

function Field({ legend, children }: { legend: string; children: preact.ComponentChildren }) {
  return (
    <fieldset class="xh__group">
      <legend class="eyebrow">{legend}</legend>
      {children}
    </fieldset>
  );
}

export function Crosshair() {
  const [state, setState] = useState<CrosshairState>(loadState);
  const [name, setName] = useState('my_crosshair');
  const [status, setStatus] = useState('');

  const preview = useRef<HTMLCanvasElement>(null);
  const zoom = useRef<HTMLCanvasElement>(null);
  const tex = useRef<HTMLCanvasElement>(null);
  // Images live in refs, not state: they are large, never rendered directly,
  // and a re-render on load is triggered by the counter below instead.
  const imported = useRef<HTMLImageElement | null>(null);
  const shot = useRef<HTMLImageElement | null>(null);
  const [imgTick, setImgTick] = useState(0);

  const set = (patch: Partial<CrosshairState>) => setState((s) => ({ ...s, ...patch }));

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* not important enough to surface */ }
  }, [state]);

  // One effect draws everything, so the texture and the preview can never
  // disagree about what the current settings are.
  useEffect(() => {
    const t = tex.current;
    const p = preview.current;
    const z = zoom.current;
    if (!t || !p || !z) return;

    const tctx = t.getContext('2d');
    const pctx = p.getContext('2d');
    const zctx = z.getContext('2d');
    if (!tctx || !pctx || !zctx) return;

    tctx.clearRect(0, 0, TEX, TEX);
    drawCrosshair(tctx, TEX / 2, TEX / 2, TEX / PX_AT_1080, state, imported.current);

    // 1:1 pixels: the backing store matches the CSS size, so what you see is
    // what the game draws at the chosen resolution.
    const rect = p.getBoundingClientRect();
    const w = Math.max(320, Math.round(rect.width));
    const h = Math.round(w * 9 / 16);
    if (p.width !== w || p.height !== h) { p.width = w; p.height = h; }
    const sz = shot.current ? { w: shot.current.width, h: shot.current.height } : null;
    drawBackdrop(pctx, w, h, state.backdrop, shot.current, sz);
    pctx.imageSmoothingEnabled = true;
    drawCrosshair(pctx, w / 2, h / 2, RES_SCALE[state.res], state, imported.current);

    zctx.imageSmoothingEnabled = false;
    zctx.clearRect(0, 0, 256, 256);
    zctx.drawImage(p, w / 2 - 32, h / 2 - 32, 64, 64, 0, 0, 256, 256);
  }, [state, imgTick]);

  const pickImage = (e: Event, into: typeof imported, patch: Partial<CrosshairState>) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    const img = new Image();
    const url = URL.createObjectURL(f);
    img.onload = () => {
      into.current = img;
      set(patch);
      setImgTick((n) => n + 1);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  const download = () => {
    if (state.shape === 'image' && !imported.current) {
      setStatus('Import an image first, or pick a shape.');
      return;
    }
    // The same pixels the HUD editor bundles from this page's saved state.
    const px = crosshairPixels(state, imported.current);
    if (!px) return;
    const safe = (name.trim() || 'my_crosshair').replace(/[^A-Za-z0-9_-]+/g, '_');
    const vpk = buildVPK(safe, TEX, TEX, px, HUDLAYOUT);
    const blob = new Blob([vpk], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${safe}.vpk`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    setStatus(`Saved ${safe}.vpk (${(vpk.length / 1024).toFixed(0)} KB). Put it in left4dead/addons/ and restart the game.`);
  };

  const showArms = ['cross', 'crossdot', 't'].includes(state.shape);
  const showDot = ['dot', 'crossdot', 'circledot'].includes(state.shape);
  const showCircle = ['circle', 'circledot'].includes(state.shape);

  return (
    <div class="page page--wide">
      <PageHeader eyebrow="Tool" title="Crosshair Maker" />

      <div class="xh">
        <Panel class="xh__controls">
          <Field legend="Presets">
            <div class="xh__presets">
              {Object.entries(PRESETS).map(([label, p]) => (
                <button key={label} class="btn btn--ghost btn--sm" onClick={() => set(p)}>{label}</button>
              ))}
            </div>
          </Field>

          <Field legend="Shape">
            <label class="xh__row">
              <span>Shape</span>
              <select
                value={state.shape}
                onChange={(e) => set({ shape: (e.target as HTMLSelectElement).value as Shape })}
              >
                {SHAPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <span />
            </label>
            {showArms && <Slider label="Length" value={state.len} min={0} max={30} step={0.5} onInput={(len) => set({ len })} />}
            {(showArms || showCircle) && <Slider label="Thickness" value={state.thick} min={0.5} max={10} step={0.5} onInput={(thick) => set({ thick })} />}
            {showArms && <Slider label="Gap" value={state.gap} min={0} max={30} step={0.5} onInput={(gap) => set({ gap })} />}
            {showDot && <Slider label="Dot size" value={state.dot} min={0.5} max={16} step={0.5} onInput={(dot) => set({ dot })} />}
            {showCircle && <Slider label="Radius" value={state.radius} min={1} max={40} step={0.5} onInput={(radius) => set({ radius })} />}
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
                type="color" value={state.color}
                onInput={(e) => set({ color: (e.target as HTMLInputElement).value })}
              />
              <span />
            </label>
            <div class="xh__swatches">
              {SWATCHES.map((c) => (
                <button
                  key={c} class="xh__swatch" style={{ background: c }}
                  title={c} aria-label={c} onClick={() => set({ color: c })}
                />
              ))}
            </div>
            <Slider label="Opacity" value={state.alpha} min={10} max={100} step={1} onInput={(alpha) => set({ alpha })} />
          </Field>

          <Field legend="Outline">
            <Slider label="Width" value={state.outline} min={0} max={4} step={0.5} onInput={(outline) => set({ outline })} />
            <Slider label="Opacity" value={state.oalpha} min={0} max={100} step={1} onInput={(oalpha) => set({ oalpha })} />
          </Field>

          <Field legend="Import">
            <label class="xh__file">
              <span>Use your own image</span>
              <input type="file" accept="image/*" onChange={(e) => pickImage(e, imported, { shape: 'image' })} />
            </label>
          </Field>

          <Field legend="Export">
            <label class="xh__row">
              <span>Name</span>
              <input
                type="text" value={name}
                onInput={(e) => setName((e.target as HTMLInputElement).value)}
              />
              <span />
            </label>
            <button class="btn btn--block" onClick={download}>Download .vpk</button>
            {status && <p class="muted xh__status">{status}</p>}
          </Field>
        </Panel>

        <Panel class="xh__stage">
          <div class="xh__toolbar">
            <label>
              Backdrop{' '}
              <select
                value={state.backdrop}
                onChange={(e) => set({ backdrop: (e.target as HTMLSelectElement).value as Backdrop })}
              >
                {BACKDROPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label class="xh__file xh__file--inline">
              <span class="btn btn--ghost btn--sm">Load screenshot</span>
              <input type="file" accept="image/*" onChange={(e) => pickImage(e, shot, { backdrop: 'shot' })} />
            </label>
            <label>
              Resolution{' '}
              <select
                value={state.res}
                onChange={(e) => set({ res: (e.target as HTMLSelectElement).value as Res })}
              >
                {RESOLUTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <span class="muted xh__note">Preview is 1:1 pixels. Sizes are screen pixels at 1080p.</span>
          </div>

          <div class="xh__preview">
            <canvas ref={preview} class="xh__canvas" />
            <div class="xh__zoomcol">
              <canvas ref={zoom} width={256} height={256} class="xh__zoom" />
              <small class="muted">4x zoom</small>
              <canvas ref={tex} width={TEX} height={TEX} class="xh__tex" />
              <small class="muted">the actual texture</small>
            </div>
          </div>
        </Panel>
      </div>

      <Panel>
        <h3>Install</h3>
        <ol class="xh__help">
          <li>Click <b>Download .vpk</b>.</li>
          <li>
            Put the file in your game's addons folder:<br />
            Windows: <code>C:\Program Files (x86)\Steam\steamapps\common\left 4 dead\left4dead\addons\</code><br />
            Linux: <code>~/.steam/steam/steamapps/common/left 4 dead/left4dead/addons/</code>
          </li>
          <li>Remove any other crosshair .vpk you had in there, only one can win.</li>
          <li>Restart the game. If it does not show, check Extras then Add-ons in the main menu and make sure it is ticked.</li>
        </ol>
        <p class="muted">
          To hide the stock crosshair underneath, put <code>crosshair 0</code> in your console or autoexec.
          The addon crosshair is drawn as a fixed 26-unit HUD image, so it stays the same size and never
          spreads while you move.
        </p>
        <h3>How it works</h3>
        <p class="muted">
          The .vpk contains the crosshair texture (<code>materials/vgui/hud/altcrosshair</code>) and a copy
          of the stock HUD layout with one extra image element that draws it at screen centre. The
          Modern HUD addon already has that element, so if you run it the layout in this file is ignored
          and only the texture is used.
        </p>
      </Panel>
    </div>
  );
}
