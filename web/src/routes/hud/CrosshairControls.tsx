/**
 * The crosshair's controls, in two places. The side panel holds the choice
 * (whether this HUD carries its own crosshair), a small preview and the
 * Hide the game's crosshair box: with nothing selected as its own Crosshair
 * group, so the crosshair can be turned on even while it is the game's own
 * and there is no element on the canvas to click; with the crosshair
 * selected inside that element's group. The crosshair itself is built in a
 * wide panel under the canvas, open only while the crosshair is selected:
 * the Crosshair page's own controls (crosshair/Builder.tsx) beside a large
 * zoomed preview, and an upload for a crosshair made elsewhere, any
 * crosshair addon's .vpk or an image. The side panel is too narrow for the
 * builder: its sliders shrank to nubs there.
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

/** The large preview's side in CSS pixels: the whole texture, sized so two groups of controls still fit beside it. */
const BIG = 176;
/** The side panel's small preview. */
const SMALL = 96;

/**
 * The crosshair as its texture holds it, on a dark square, drawn by the same
 * drawArt as the canvas and the download. The backing store is `size`
 * pixels, so the large preview is drawn sharp rather than scaled up.
 */
function CrosshairZoom({ art, size, label, cls }: { art: CrosshairArt; size: number; label: string; cls: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#17161a';
    ctx.fillRect(0, 0, size, size);
    const img = art.kind === 'image' ? urlImage(art.png, () => setTick((t) => t + 1)) ?? null : null;
    drawArt(ctx, size / 2, size / 2, size, art, img);
  }, [art, tick, size]);
  return <canvas ref={ref} width={size} height={size} class={cls} aria-label={label} />;
}

const CHOICES: { id: CrosshairChoice; label: string; says: string }[] = [
  { id: 'bundle', label: 'Custom', says: 'Your crosshair ships inside this HUD. No crosshair addon needed.' },
  { id: 'none', label: 'Game default', says: "No custom crosshair: the game's own crosshair shows." },
  { id: 'addon', label: 'Separate crosshair addon (legacy)', says: 'Leaves room for a crosshair addon you already use to draw it.' },
];

/** The crosshair a design draws: only a Custom one has any. */
const artOf = (design: HudDesign) => (design.crosshair === 'bundle' ? design.xhairArt : undefined);

/** Custom, Game default (and the legacy addon choice, only for a design that already has it), one line each. */
function Choice({ design, edit }: { design: HudDesign; edit: Edit }) {
  // Custom with no crosshair yet starts from the builder's defaults, so a 'bundle' always has one.
  const choose = (c: CrosshairChoice) => edit((d) => (d.crosshair === c ? d : {
    ...d, crosshair: c, ...(c === 'bundle' && !d.xhairArt ? { xhairArt: { kind: 'built', state: { ...DEFAULT_STATE } } } : {}),
  }));
  return (
    <>
      {CHOICES.filter((c) => c.id !== 'addon' || design.crosshair === 'addon').map((c) => (
        <div key={c.id}>
          <label class="hud__check">
            <input type="radio" name="hud-crosshair" value={c.id} checked={design.crosshair === c.id} onChange={() => choose(c.id)} />
            <span>{c.label}</span>
          </label>
          <p class="muted hud__note">{c.says}</p>
        </div>
      ))}
    </>
  );
}

/** The addon load-order warning, the Hide the game's crosshair box and its warning. */
function HideGame({ design, edit }: { design: HudDesign; edit: Edit }) {
  return (
    <>
      {design.crosshair === 'addon' && (
        <p class="muted hud__note hud__warn">
          {/* Advanced mode mounts ahead of every addon from gameinfo.txt, so there the order takes care of itself. */}
          {!design.advanced && <>The crosshair addon ships its own layout file, so this HUD must be listed above it in{' '}
          <code>left4dead/addonlist.txt</code>; the in-game Add-ons menu cannot change the order. </>}
          Without the addon the crosshair shows as a magenta and black checker. Choose Custom to put your crosshair in
          this HUD instead.
        </p>
      )}

      <label class="hud__check hud__xhairhide">
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
    </>
  );
}

/**
 * The side panel's part. `selected` is the crosshair element selected: then
 * this sits inside that element's own group (one group box, one legend) and
 * points at the builder under the canvas; otherwise it is its own Crosshair
 * group and says how to open the builder.
 */
export function CrosshairControls(
  { design, edit, selected = false }: { design: HudDesign; edit: Edit; selected?: boolean },
) {
  const art = artOf(design);
  if (!selected) {
    return (
      <Field legend="Crosshair">
        <Choice design={design} edit={edit} />
        {art && <p class="muted hud__note">Select the crosshair, on the canvas or in Layers, to change it or upload one.</p>}
        <HideGame design={design} edit={edit} />
      </Field>
    );
  }
  return (
    <>
      <p class="muted hud__note">The game always centres the crosshair.</p>
      <Choice design={design} edit={edit} />
      {art && <CrosshairZoom art={art} size={SMALL} label="Your crosshair" cls="hud__xhairpreview hud__xhairpreview--small" />}
      <HideGame design={design} edit={edit} />
      <p class="muted hud__note">Edit the crosshair below the preview.</p>
    </>
  );
}

/**
 * The wide panel under the canvas, open while the crosshair is selected:
 * the large preview on the left, the builder's groups in a grid on the
 * right (Presets across the top, then Shape, Colour and Outline side by
 * side, wrapping as the width runs out), then the upload. Its close button
 * deselects the crosshair, which is what closes it.
 */
export function CrosshairBuilderPanel(
  { design, edit, end, onClose }: { design: HudDesign; edit: Edit; end: () => void; onClose: () => void },
) {
  const [error, setError] = useState('');
  const art = artOf(design);
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
    <section class="hud__xhairbelow" aria-labelledby="hud-xhairbelow-title">
      <div class="hud__xhairhead">
        <h3 id="hud-xhairbelow-title">Crosshair</h3>
        <button type="button" class="btn btn--ghost btn--sm" aria-label="Close the crosshair builder" onClick={onClose}>Close</button>
      </div>
      <div class="hud__xhairbody">
        {art && <CrosshairZoom art={art} size={BIG} label="Your crosshair, zoomed" cls="hud__xhairpreview hud__xhairpreview--big" />}
        <div class="hud__xhaircontrols">
          {art?.kind === 'image' && (
            <div>
              <p class="muted hud__note">Your uploaded crosshair, as the game will draw it.</p>
              <button type="button" class="btn btn--ghost btn--sm" onClick={() => build({})}>Build one instead</button>
            </div>
          )}
          {!art && <p class="muted hud__note">Choose Custom in the side panel to build a crosshair here, or upload one.</p>}
          <div class="hud__xhairgrid">
            {art?.kind === 'built' && <CrosshairBuilder state={art.state} set={build} end={end} />}
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
          </div>
          {error && <p class="error">{error}</p>}
        </div>
      </div>
    </section>
  );
}
