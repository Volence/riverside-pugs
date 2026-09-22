import { useEffect, useRef, useState } from 'preact/hooks';
import { Panel, Tabs } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import { drawBackdrop, type Backdrop } from '../crosshair/draw';
import {
  loadDesign, saveDesign, type HudDesign, type ElementOverride,
} from '../hud/design';
import { screenW, SCREEN_H } from '../hud/units';
import { elementById, type HudElement } from '../hud/elements';
import { elementRect, teamLayout } from '../hud/build';
import { drawHud, hitTest, visibleElements, type Side } from '../hud/mock';

/**
 * Convert a pointer position (client coordinates, as PointerEvent carries
 * them) to HUD units, using the canvas's own bounding box. The HUD grid is
 * always 480 units tall regardless of aspect, so height alone gives the
 * scale; width follows from it because the canvas is drawn 1:1 with its CSS
 * box, which is itself locked to the design's aspect ratio.
 */
export function toUnits(e: { clientX: number; clientY: number }, rect: DOMRect): { ux: number; uy: number } {
  const k = SCREEN_H / rect.height;
  return { ux: (e.clientX - rect.left) * k, uy: (e.clientY - rect.top) * k };
}

/**
 * Snap a dragged position to the near edge (0), the far edge (`extent`) or
 * the centre (`extent / 2`), each within a 4-unit tolerance, so a drag that
 * lands close to a natural position locks onto it instead of leaving the
 * element one unit off. Anything else is left exactly where the pointer put it.
 */
export function snap(v: number, size: number, extent: number): number {
  const targets = [0, extent - size, extent / 2 - size / 2];
  for (const t of targets) if (Math.abs(v - t) <= 4) return t;
  return v;
}

/** Keeps at least `min` units of a span on screen, whichever side it drifts to. */
function clampSpan(v: number, size: number, extent: number, min: number): number {
  return Math.min(extent - min, Math.max(min - size, v));
}

/**
 * Move an element by (dx, dy), starting from its base position the first
 * time it is touched. Goes through `elementRect`, the same function the
 * canvas and the generator use, so a nudge before any drag starts from
 * exactly where the element is drawn. An element the game places itself
 * cannot move, so it is returned unchanged, `===` and all, which is what
 * lets a caller skip a re-render when nothing happened.
 */
export function nudge(design: HudDesign, id: string, dx: number, dy: number): HudDesign {
  const el = elementById(id);
  if (!el || !el.move) return design;
  const o = design.elements[id];
  const base = elementRect(design, id, design.aspect);
  const x = (o?.x ?? base.x) + dx;
  const y = (o?.y ?? base.y) + dy;
  return { ...design, elements: { ...design.elements, [id]: { ...o, x, y } } };
}

const BACKDROPS: [Backdrop, string][] = [
  ['scene', 'Saferoom'], ['dark', 'Dark'], ['bright', 'Bright'], ['grey', 'Grey'],
];

/** One labelled slider with a live readout, matching Crosshair.tsx's. */
function Slider(
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

function Field({ legend, children }: { legend: string; children: preact.ComponentChildren }) {
  return (
    <fieldset class="hud__group">
      <legend class="eyebrow">{legend}</legend>
      {children}
    </fieldset>
  );
}

type Patch = (p: Partial<ElementOverride>) => void;

/** Row/column and per-card spacing, offered only for elements with a team layout.
 *  Column is offered only when the registry says the element supports it: the
 *  infected row is a single line and has no column mode to switch to. */
function TeamControls(
  { design, el, o, patch }: { design: HudDesign; el: HudElement; o: ElementOverride; patch: Patch },
) {
  if (!el.team) return null;
  const { dir, spacing } = teamLayout(design, el);
  return (
    <>
      <label class="hud__row">
        <span>Layout</span>
        <select
          value={o.dir ?? dir}
          onChange={(e) => patch({ dir: (e.target as HTMLSelectElement).value as 'row' | 'column' })}
        >
          <option value="row">Row</option>
          {el.team.dirs.includes('column') && <option value="column">Column</option>}
        </select>
        <span />
      </label>
      <label class="hud__row">
        <span>Spacing</span>
        <input
          type="number" value={Math.round(o.spacing ?? spacing)}
          onInput={(e) => patch({ spacing: parseFloat((e.target as HTMLInputElement).value) })}
        />
        <span />
      </label>
    </>
  );
}

/**
 * The controls for whichever element is selected, built only from what its
 * registry entry allows. `elementRect` supplies every default shown when the
 * design has no override yet, so a freshly reset element shows real numbers
 * rather than blanks.
 */
function ElementControls(
  { design, setDesign, id }: { design: HudDesign; setDesign: (fn: (d: HudDesign) => HudDesign) => void; id: string },
) {
  const el = elementById(id);
  if (!el) return null;
  const o = design.elements[id] ?? {};
  const rect = elementRect(design, id, design.aspect);
  const patch: Patch = (p) => setDesign((d) => (
    { ...d, elements: { ...d.elements, [id]: { ...(d.elements[id] ?? {}), ...p } } }
  ));
  const reset = () => setDesign((d) => {
    const elements = { ...d.elements };
    delete elements[id];
    return { ...d, elements };
  });
  const num = (e: Event) => parseFloat((e.target as HTMLInputElement).value);

  return (
    <Field legend={el.label}>
      {el.props.includes('visible') && (
        <label class="hud__check">
          <input
            type="checkbox" checked={o.visible ?? rect.visible}
            onChange={(e) => patch({ visible: (e.target as HTMLInputElement).checked })}
          />
          <span>Visible</span>
        </label>
      )}

      {!el.move && (
        <p class="muted hud__note">The game places this one. It can be hidden but not moved.</p>
      )}

      {el.move && (
        <div class="hud__row2">
          <label class="hud__field">
            <span>X</span>
            <input type="number" value={Math.round(o.x ?? rect.x)} onInput={(e) => patch({ x: num(e) })} />
          </label>
          <label class="hud__field">
            <span>Y</span>
            <input type="number" value={Math.round(o.y ?? rect.y)} onInput={(e) => patch({ y: num(e) })} />
          </label>
        </div>
      )}

      {el.resize === 'free' && (
        <div class="hud__row2">
          <label class="hud__field">
            <span>W</span>
            <input
              type="number" min={20} value={Math.round(o.w ?? rect.w)}
              onInput={(e) => patch({ w: Math.max(20, num(e)) })}
            />
          </label>
          <label class="hud__field">
            <span>H</span>
            <input
              type="number" min={20} value={Math.round(o.h ?? rect.h)}
              onInput={(e) => patch({ h: Math.max(20, num(e)) })}
            />
          </label>
        </div>
      )}

      {el.resize === 'scale' && (
        <Slider label="Scale" value={o.scale ?? 1} min={0.5} max={2} step={0.05} onInput={(scale) => patch({ scale })} />
      )}

      <TeamControls design={design} el={el} o={o} patch={patch} />

      <button type="button" class="btn btn--ghost btn--sm hud__reset" onClick={reset}>Reset this element</button>
    </Field>
  );
}

export default function Hud() {
  const [design, setDesign] = useState<HudDesign>(loadDesign);
  const [side, setSide] = useState<Side>('survivor');
  const [selected, setSelected] = useState<string | null>(null);
  const [backdrop, setBackdrop] = useState<Backdrop>('scene');

  const canvas = useRef<HTMLCanvasElement>(null);
  // Which element a pointer-down grabbed, and whether it is moving or
  // resizing it; null between drags. A ref rather than state because it
  // changes every pointermove and must never itself trigger a re-render.
  const drag = useRef<{
    id: string; mode: 'move' | 'resize';
    startUx: number; startUy: number;
    startRect: { x: number; y: number; w: number; h: number };
  } | null>(null);

  // One effect draws everything, so the canvas can never disagree with the
  // design it is supposed to be showing.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;

    // 1:1 pixels: the backing store matches the CSS box, which is itself
    // locked to the design's aspect ratio by the inline aspect-ratio style.
    const rect = c.getBoundingClientRect();
    const w = Math.max(320, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }

    drawBackdrop(ctx, w, h, backdrop, null, null);
    drawHud(ctx, w, h, design, side, selected);
  }, [design, side, selected, backdrop]);

  useEffect(() => { saveDesign(design); }, [design]);

  const pointerUnits = (e: PointerEvent) => {
    const c = canvas.current!;
    return toUnits(e, c.getBoundingClientRect());
  };

  const onPointerDown = (e: PointerEvent) => {
    const c = canvas.current;
    if (!c) return;
    c.setPointerCapture(e.pointerId);
    const { ux, uy } = pointerUnits(e);
    const hit = hitTest(design, side, ux, uy);
    if (!hit) {
      setSelected(null);
      drag.current = null;
      return;
    }
    setSelected(hit);
    const el = elementById(hit)!;
    const rect = elementRect(design, hit, design.aspect);
    const nearCorner = Math.hypot(ux - (rect.x + rect.w), uy - (rect.y + rect.h)) <= 6;
    if (el.resize === 'free' && nearCorner) {
      drag.current = { id: hit, mode: 'resize', startUx: ux, startUy: uy, startRect: rect };
    } else if (el.move) {
      drag.current = { id: hit, mode: 'move', startUx: ux, startUy: uy, startRect: rect };
    } else {
      drag.current = null;
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const { ux, uy } = pointerUnits(e);
    const dux = ux - d.startUx;
    const duy = uy - d.startUy;
    const extentW = screenW(design.aspect);

    setDesign((cur) => {
      const old = cur.elements[d.id] ?? {};
      if (d.mode === 'resize') {
        const w = Math.max(20, d.startRect.w + dux);
        const h = Math.max(20, d.startRect.h + duy);
        return { ...cur, elements: { ...cur.elements, [d.id]: { ...old, w, h } } };
      }
      const x = clampSpan(snap(d.startRect.x + dux, d.startRect.w, extentW), d.startRect.w, extentW, 8);
      const y = clampSpan(snap(d.startRect.y + duy, d.startRect.h, SCREEN_H), d.startRect.h, SCREEN_H, 8);
      return { ...cur, elements: { ...cur.elements, [d.id]: { ...old, x, y } } };
    });
  };

  const onPointerUp = (e: PointerEvent) => {
    const c = canvas.current;
    if (c && c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
    drag.current = null;
  };

  // Arrows nudge, Escape deselects, Tab/Shift+Tab cycle the current side's
  // elements: the whole editor stays usable without a mouse.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { setSelected(null); return; }

    if (e.key === 'Tab') {
      e.preventDefault();
      const list = visibleElements(side).map((el) => el.id);
      if (list.length === 0) return;
      const forward = !e.shiftKey;
      if (!selected) { setSelected(forward ? list[0] : list[list.length - 1]); return; }
      const idx = list.indexOf(selected);
      const base = idx === -1 ? (forward ? -1 : 0) : idx;
      const next = (base + (forward ? 1 : -1) + list.length) % list.length;
      setSelected(list[next]);
      return;
    }

    const amount = e.shiftKey ? 10 : 1;
    const deltas: Record<string, [number, number]> = {
      ArrowUp: [0, -amount], ArrowDown: [0, amount], ArrowLeft: [-amount, 0], ArrowRight: [amount, 0],
    };
    const delta = deltas[e.key];
    if (!delta) return;
    e.preventDefault();
    if (selected) setDesign((d) => nudge(d, selected, delta[0], delta[1]));
  };

  const sideElements = visibleElements(side);

  return (
    <div class="page page--wide">
      <PageHeader eyebrow="Tool" title="HUD Editor" />

      <div class="hud">
        <Panel class="hud__stage">
          <div class="hud__toolbar">
            <Tabs
              tabs={[{ key: 'survivor', label: 'Survivor' }, { key: 'infected', label: 'Infected' }]}
              active={side}
              onSelect={(k) => { setSide(k as Side); setSelected(null); }}
            />
            <label>
              Backdrop{' '}
              <select
                value={backdrop}
                onChange={(e) => setBackdrop((e.target as HTMLSelectElement).value as Backdrop)}
              >
                {BACKDROPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
          </div>

          <canvas
            ref={canvas}
            tabIndex={0}
            class="hud__canvas"
            style={{ aspectRatio: `${screenW(design.aspect)} / ${SCREEN_H}` }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onKeyDown={onKeyDown}
          />

          {/* The only way to reach an element that is hidden or off screen. */}
          <div class="hud__list">
            {sideElements.map((el) => {
              const visible = elementRect(design, el.id, design.aspect).visible;
              return (
                <button
                  key={el.id}
                  type="button"
                  class={`hud__pill${el.id === selected ? ' is-active' : ''}${visible ? '' : ' hud__pill--hidden'}`}
                  onClick={() => setSelected(el.id)}
                >
                  {el.label}
                </button>
              );
            })}
          </div>
        </Panel>

        <Panel class="hud__side">
          {selected
            ? <ElementControls design={design} setDesign={setDesign} id={selected} />
            : <p class="muted">Select an element on the canvas or in the list below it.</p>}
        </Panel>
      </div>
    </div>
  );
}
