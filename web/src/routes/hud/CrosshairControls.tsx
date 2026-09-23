/**
 * The Crosshair group: where the HUD's crosshair comes from, and whether the
 * game's own one is hidden. Shown when nothing is selected and when the
 * crosshair element is, so it can be reached even while the choice is
 * 'none' and there is no element on the canvas to click.
 *
 * The three choices exist because the xHair element's texture,
 * vgui/hud/altcrosshair, is in no pak01: a HUD that writes the element with
 * nothing behind it shows the magenta and black missing-texture checker, which
 * is what the owner saw in game on 2026-09-23 with the crosshair addon off.
 */
import { useEffect, useRef } from 'preact/hooks';
import { PX_AT_1080, drawCrosshair, type CrosshairState } from '../../crosshair/draw';
import type { CrosshairChoice, HudDesign } from '../../hud/design';
import { Field, type Edit } from './controls';

/** The preview's side in CSS pixels; the whole exported texture is drawn into it. */
const PREVIEW = 64;

/** The bundled crosshair as its texture holds it, on a dark square. */
function CrosshairPreview({ crosshair }: { crosshair: CrosshairState }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#17161a';
    ctx.fillRect(0, 0, PREVIEW, PREVIEW);
    drawCrosshair(ctx, PREVIEW / 2, PREVIEW / 2, PREVIEW / PX_AT_1080, crosshair, null);
  }, [crosshair]);
  return <canvas ref={ref} width={PREVIEW} height={PREVIEW} class="hud__xhairpreview" aria-label="Your crosshair" />;
}

const CHOICES: { id: CrosshairChoice; label: string; says: string }[] = [
  { id: 'bundle', label: 'Bundle my crosshair', says: 'Ships the crosshair from the Crosshair page inside this HUD. No crosshair addon needed.' },
  { id: 'addon', label: 'Crosshair addon', says: 'Leaves room for a crosshair addon you already use to draw it.' },
  { id: 'none', label: 'None', says: "No custom crosshair: the game's own crosshair shows." },
];

export function CrosshairControls(
  { design, edit, crosshair }: { design: HudDesign; edit: Edit; crosshair: CrosshairState | null },
) {
  const choose = (c: CrosshairChoice) => edit((d) => (d.crosshair === c ? d : { ...d, crosshair: c }));
  return (
    <Field legend="Crosshair">
      {CHOICES.map((c) => {
        const off = c.id === 'bundle' && !crosshair;
        return (
          <div key={c.id}>
            <label class="hud__check">
              <input
                type="radio" name="hud-crosshair" value={c.id} checked={design.crosshair === c.id} disabled={off}
                onChange={() => choose(c.id)}
              />
              <span>{c.label}</span>
            </label>
            <p class="muted hud__note">{c.says}</p>
          </div>
        );
      })}

      {/* Reachable from every choice, not only Bundle: the bundled preview
          below already carries its own link, so this one steps aside for it. */}
      {design.crosshair !== 'bundle' && (
        <p class="muted hud__note">
          {crosshair
            ? <>See or change it on the <a href="/crosshair">Crosshair page</a>.</>
            : <>Make one on the <a href="/crosshair">Crosshair page</a> first; it is saved in this browser.</>}
        </p>
      )}

      {design.crosshair === 'bundle' && crosshair && (
        <div class="hud__xhairbundle">
          <CrosshairPreview crosshair={crosshair} />
          <p class="muted hud__note">Change it on the <a href="/crosshair">Crosshair page</a>, then download again.</p>
        </div>
      )}
      {design.crosshair === 'addon' && (
        <p class="muted hud__note hud__warn">
          {/* Advanced mode mounts ahead of every addon from gameinfo.txt, so there the order takes care of itself. */}
          {!design.advanced && <>The crosshair addon ships its own layout file, so this HUD must be listed above it in{' '}
          <code>left4dead/addonlist.txt</code>; the in-game Add-ons menu cannot change the order. </>}
          Without the addon the crosshair shows as a magenta and black checker.
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
