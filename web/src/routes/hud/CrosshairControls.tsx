/**
 * The Crosshair group: whether this HUD carries its own crosshair, and the
 * crosshair itself. With the crosshair element selected it is the whole
 * builder (the Crosshair page's own controls, crosshair/Builder.tsx), a
 * zoomed preview, and an upload for a crosshair made elsewhere: any
 * crosshair addon's .vpk, or an image. With nothing selected it is just the
 * choice, so the crosshair can be turned on even while it is the game's own
 * and there is no element on the canvas to click.
 *
 * The crosshair ships inside the HUD because a crosshair addon ships a whole
 * scripts/hudlayout.res (the xHair ImagePanel that draws it lives there),
 * so a crosshair addon and a HUD addon fight over that file and the first in
 * addonlist.txt wins; the in-game Add-ons menu cannot reorder them. The
 * legacy 'addon' choice still writes the element for such an addon, and is
 * offered only to a design that already has it. Without the addon its
 * texture, vgui/hud/altcrosshair, is in no pak01, so the element shows the
 * magenta and black missing-texture checker, as the owner saw in game on
 * 2026-09-23.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { DEFAULT_STATE, type CrosshairState } from '../../crosshair/draw';
import { drawArt, readArt, type CrosshairArt } from '../../crosshair/model';
import { uploadArt } from '../../crosshair/texture';
import { CrosshairBuilder } from '../../crosshair/Builder';
import { urlImage } from '../../hud/render';
import type { CrosshairChoice, HudDesign } from '../../hud/design';
import { Field, type Edit } from './controls';

/** The zoomed preview's side in CSS pixels: the whole texture, a little over twice the size the game draws it at 1080p. */
const ZOOM = 128;

/** The crosshair as its texture holds it, on a dark square, drawn by the same drawArt as the canvas and the download. */
function CrosshairZoom({ art }: { art: CrosshairArt }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#17161a';
    ctx.fillRect(0, 0, ZOOM, ZOOM);
    const img = art.kind === 'image' ? urlImage(art.png, () => setTick((t) => t + 1)) ?? null : null;
    drawArt(ctx, ZOOM / 2, ZOOM / 2, ZOOM, art, img);
  }, [art, tick]);
  return <canvas ref={ref} width={ZOOM} height={ZOOM} class="hud__xhairpreview" aria-label="Your crosshair, zoomed" />;
}

const CHOICES: { id: CrosshairChoice; label: string; says: string }[] = [
  { id: 'bundle', label: 'Custom', says: 'Your crosshair ships inside this HUD. No crosshair addon needed.' },
  { id: 'none', label: 'Game default', says: "No custom crosshair: the game's own crosshair shows." },
  { id: 'addon', label: 'Separate crosshair addon (legacy)', says: 'Leaves room for a crosshair addon you already use to draw it.' },
];

export function CrosshairControls(
  { design, edit, end, full = false }: { design: HudDesign; edit: Edit; end: () => void; full?: boolean },
) {
  const [error, setError] = useState('');
  // Custom with no crosshair yet starts from the builder's defaults, so a 'bundle' always has one.
  const choose = (c: CrosshairChoice) => edit((d) => (d.crosshair === c ? d : {
    ...d, crosshair: c, ...(c === 'bundle' && !d.xhairArt ? { xhairArt: { kind: 'built', state: { ...DEFAULT_STATE } } } : {}),
  }));
  const art = design.crosshair === 'bundle' ? design.xhairArt : undefined;
  const build = (patch: Partial<CrosshairState>, gesture?: boolean) => edit((d) => {
    const from = d.xhairArt?.kind === 'built' ? d.xhairArt.state : DEFAULT_STATE;
    return { ...d, xhairArt: { kind: 'built', state: { ...from, ...patch } } };
  }, gesture ? 'gesture' : 'step');

  const upload = async (file: File) => {
    try {
      // Checked like any stored crosshair before it goes in: a design is always one the build takes.
      const got = readArt(await uploadArt(file));
      if (!got) throw new Error('That crosshair could not be read.');
      setError('');
      edit((d) => ({ ...d, crosshair: 'bundle', xhairArt: got }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Field legend="Crosshair">
      {CHOICES.filter((c) => c.id !== 'addon' || design.crosshair === 'addon').map((c) => (
        <div key={c.id}>
          <label class="hud__check">
            <input type="radio" name="hud-crosshair" value={c.id} checked={design.crosshair === c.id} onChange={() => choose(c.id)} />
            <span>{c.label}</span>
          </label>
          <p class="muted hud__note">{c.says}</p>
        </div>
      ))}

      {!full && art && (
        <p class="muted hud__note">Select the crosshair, on the canvas or in Layers, to change it or upload one.</p>
      )}

      {full && art && (
        <div class="hud__xhair">
          <CrosshairZoom art={art} />
          {art.kind === 'built'
            ? <CrosshairBuilder state={art.state} set={build} end={end} />
            : (
              <div>
                <p class="muted hud__note">Your uploaded crosshair, as the game will draw it.</p>
                <button type="button" class="btn btn--ghost btn--sm" onClick={() => build({})}>Build one instead</button>
              </div>
            )}
        </div>
      )}

      {full && (
        <label class="hud__file">
          <span>Upload a crosshair: a crosshair addon's .vpk, or an image</span>
          <input
            type="file" accept=".vpk,image/*" aria-label="Upload a crosshair"
            onChange={(e) => {
              const input = e.target as HTMLInputElement;
              const f = input.files?.[0];
              input.value = '';
              if (f) void upload(f);
            }}
          />
        </label>
      )}
      {error && <p class="error">{error}</p>}

      {design.crosshair === 'addon' && (
        <p class="muted hud__note hud__warn">
          {/* Advanced mode mounts ahead of every addon from gameinfo.txt, so there the order takes care of itself. */}
          {!design.advanced && <>The crosshair addon ships its own layout file, so this HUD must be listed above it in{' '}
          <code>left4dead/addonlist.txt</code>; the in-game Add-ons menu cannot change the order. </>}
          Without the addon the crosshair shows as a magenta and black checker. Choose Custom to put your crosshair in
          this HUD instead.
        </p>
      )}

      <label class="hud__check">
        <input
          type="checkbox" checked={design.hideGameCrosshair === true}
          onChange={(e) => {
            const on = (e.target as HTMLInputElement).checked;
            edit((d) => {
              const next = { ...d };
              if (on) next.hideGameCrosshair = true; else delete next.hideGameCrosshair;
              return next;
            });
          }}
        />
        <span>Hide the game's crosshair</span>
      </label>
      <p class="muted hud__note">Hides the game's own crosshair so an image crosshair can replace it.</p>
      {design.crosshair === 'none' && design.hideGameCrosshair && (
        <p class="muted hud__note hud__warn">With no custom crosshair and the game's hidden, there will be no crosshair at all.</p>
      )}
    </Field>
  );
}
