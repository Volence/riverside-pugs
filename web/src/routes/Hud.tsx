import { useEffect, useRef, useState } from 'preact/hooks';
import { Panel, Tabs } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import { confirm } from '../components/Confirm';
import { drawBackdrop, type Backdrop } from '../crosshair/draw';
import {
  loadDesign, saveDesign, validateDesign, safeName, encodeShare, decodeShare, clampOverride, clampChild, DEFAULT_DESIGN, baseTeam,
  type HudDesign, type ElementOverride, type StyleOverride, type RangeKey, type TeamDir, type ChildOverride, type ChildRangeKey,
} from '../hud/design';
import { screenW, SCREEN_H, type Aspect } from '../hud/units';
import { elementById, type HudElement } from '../hud/elements';
import { elementRect, teamLayout, teamCardRects, isFreeTeam, cardChild, baseHasChild, packHud, type BuildAssets } from '../hud/build';
import { TEAM_PANEL, teamChild } from '../hud/children';
import { drawHud, hitTest, freeCardAt, childAt, childCornerAt, visibleElements, type Side } from '../hud/mock';
import type { CardState } from '../hud/render';
import { SLOTS, type StyleSlot } from '../hud/slots';
import type { Preset } from '../hud/base';
import regularUrl from '../hud/base/fonts/RobotoCondensed-Regular.ttf?url';
import boldUrl from '../hud/base/fonts/RobotoCondensed-Bold.ttf?url';

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
 *
 * Runs the result through the same `clampSpan` a drag uses, at the same
 * 8-unit floor, so repeated arrow presses cannot walk an element arbitrarily
 * far off screen the way a plain `x + dx` would; a drag and the keyboard
 * agree on how far off screen is too far because they share this call.
 * `design.aspect` (not a hardcoded 16:9) gives the screen width, since a
 * design can be 16:10 or 4:3.
 */
export function nudge(design: HudDesign, id: string, dx: number, dy: number): HudDesign {
  const el = elementById(id);
  // In Free each card places itself: the element's own position would move nothing.
  if (!el || !el.move || (id === 'teamColumn' && isFreeTeam(design))) return design;
  const o = design.elements[id];
  const base = elementRect(design, id, design.aspect);
  const extentW = screenW(design.aspect);
  const x = clampSpan((o?.x ?? base.x) + dx, base.w, extentW, 8);
  const y = clampSpan((o?.y ?? base.y) + dy, base.h, SCREEN_H, 8);
  return { ...design, elements: { ...design.elements, [id]: { ...o, x, y } } };
}

/**
 * Decode any image the browser can read, fit it to the slot, and keep a PNG
 * copy for the saved design.
 */
export async function decodeUpload(file: Blob, w: number, h: number) {
  if (file.size > 4_000_000) throw new Error('That image is over 4 MB.');
  const bmp = await createImageBitmap(file).catch(() => { throw new Error('That file is not an image the browser can read.'); });
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0, w, h);
  const png = c.toDataURL('image/png').split(',')[1];
  if (png.length > 1_400_000) throw new Error('That image is too detailed to store. Try a smaller one.');
  return { rgba: ctx.getImageData(0, 0, w, h).data, png };
}

/** `fetch` only rejects on a network error, not on a 404 or 500: an unchecked
 *  response would let an error page's HTML sail through as if it were the
 *  font's own bytes, ending up written into the shipped VPK as
 *  resource/robotocondensed-regular.ttf with nothing catching it until the
 *  game refuses to load a corrupt font. Named after the file so a failure
 *  here tells a bug report exactly what to look at, the same as every other
 *  fetch in this codebase (see web/src/api.ts). */
async function fontBytes(u: string, filename: string): Promise<Uint8Array> {
  const res = await fetch(u);
  if (!res.ok) throw new Error(`${filename}: failed to load (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Rebuild `BuildAssets` from a design: decoded pixels for every uploaded
 * style image, plus the Roboto Condensed files when the design needs them.
 *
 * A design's `images[id].w/h` are untrusted metadata: nothing has ever
 * cross-checked them against the PNG they came with, and a share link or an
 * imported .json file could claim anything. So every image is redrawn at its
 * SLOT's real size, never the stored one; that size is what the generator
 * actually encodes, and it is the only thing here that comes from the
 * registry rather than from the design itself.
 */
export async function assetsFor(design: HudDesign): Promise<BuildAssets> {
  const assets: BuildAssets = {};
  const entries = Object.entries(design.images);
  if (entries.length) {
    const images: Record<string, Uint8ClampedArray> = {};
    for (const [id, stored] of entries) {
      const slot = SLOTS.find((s) => s.id === id);
      if (!slot) continue;
      const { w, h } = slot.size;
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error(`${slot.label}: the stored image will not decode`));
        img.src = `data:image/png;base64,${stored.png}`;
      });
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0, w, h);
      images[id] = ctx.getImageData(0, 0, w, h).data;
    }
    assets.images = images;
  }
  if (design.font === 'roboto' || design.preset === 'modern') {
    assets.fonts = {
      regular: await fontBytes(regularUrl, 'RobotoCondensed-Regular.ttf'),
      bold: await fontBytes(boldUrl, 'RobotoCondensed-Bold.ttf'),
    };
  }
  return assets;
}

/** Whether the elements differ from a fresh design's. Not the same as having
 *  none: a fresh design already fits the teammate card. */
export function elementsTouched(d: HudDesign): boolean {
  return JSON.stringify(d.elements) !== JSON.stringify(DEFAULT_DESIGN.elements);
}

/** Whether a design holds anything beyond the untouched defaults: decides
 *  whether loading a share link needs to ask first rather than silently
 *  overwriting whatever a reader already had going. */
export function hasOverrides(d: HudDesign): boolean {
  return elementsTouched(d)
    || Object.keys(d.children).length > 0
    || Object.keys(d.styles).length > 0
    || Object.keys(d.images).length > 0
    || d.hideGameCrosshair === true
    || d.preset !== DEFAULT_DESIGN.preset
    || d.aspect !== DEFAULT_DESIGN.aspect
    || d.font !== DEFAULT_DESIGN.font
    || d.advanced !== DEFAULT_DESIGN.advanced;
}

/** "Reset this element": back to what a fresh design has for it, which for
 *  the teammates is a fitted card with no inside edits, not nothing. */
export function resetElement(d: HudDesign, id: string): HudDesign {
  const elements = { ...d.elements };
  const fresh = DEFAULT_DESIGN.elements[id];
  if (fresh) elements[id] = structuredClone(fresh); else delete elements[id];
  const children = { ...d.children };
  delete children[id];
  return { ...d, elements, children };
}

/**
 * Where a Free card is drawn relative to its slot: the fit offset, scaled,
 * straight from teamLayout. A slot stores the card's unfitted origin, so every
 * control that thinks in drawn positions (the drag, the arrows, the X and Y
 * boxes) adds this to show a slot and takes it off to store one.
 */
export function cardOffset(design: HudDesign): { x: number; y: number } {
  return teamLayout(design, elementById('teamColumn')!).offset ?? { x: 0, y: 0 };
}

/**
 * Switch the survivor team's layout. Going into Free for the first time
 * copies where each card sits now into `slots`, read from the generated file
 * like everything the canvas draws, less the fit offset, so nothing jumps;
 * leaving Free keeps them, so coming back restores the cards where the
 * player left them.
 */
export function withTeamDir(d: HudDesign, dir: TeamDir): HudDesign {
  const cur = d.elements.teamColumn ?? {};
  const next: ElementOverride = { ...cur, dir };
  if (dir === 'free' && !cur.slots) {
    const off = cardOffset({ ...d, elements: { ...d.elements, teamColumn: next } });
    next.slots = teamCardRects(d, d.aspect).map((r) => ({ x: Math.round(r.x - off.x), y: Math.round(r.y - off.y) }));
  }
  return { ...d, elements: { ...d.elements, teamColumn: next } };
}

/**
 * Draw one Free card's top-left at (x, y): its slot becomes that less the fit
 * offset, clamped through the same table as an element's position.
 */
export function placeCard(design: HudDesign, card: number, x: number, y: number): HudDesign {
  const o = design.elements.teamColumn;
  if (!o?.slots || !o.slots[card]) return design;
  const off = cardOffset(design);
  const at = { x: clampOverride('x', x - off.x), y: clampOverride('y', y - off.y) };
  const slots = o.slots.map((s, i) => (i === card ? at : s));
  return { ...design, elements: { ...design.elements, teamColumn: { ...o, slots } } };
}

/**
 * Nudge a Free card by (dx, dy) from where it is drawn, through the same
 * clampSpan and 8-unit floor a drag uses, so repeated arrow presses cannot
 * walk it off screen. Its place and size come from the generated file.
 */
export function nudgeCard(design: HudDesign, card: number, dx: number, dy: number): HudDesign {
  if (!design.elements.teamColumn?.slots?.[card]) return design;
  const r = teamCardRects(design, design.aspect)[card];
  const extentW = screenW(design.aspect);
  return placeCard(design, card, clampSpan(r.x + dx, r.w, extentW, 8), clampSpan(r.y + dy, r.h, SCREEN_H, 8));
}

/** Merge into one teammate-card child's override. */
export function patchChild(design: HudDesign, name: string, p: Partial<ChildOverride>): HudDesign {
  const kids = design.children.teamColumn ?? {};
  return { ...design, children: { ...design.children, teamColumn: { ...kids, [name]: { ...(kids[name] ?? {}), ...p } } } };
}

/**
 * Place a teammate-card child at (x, y): unscaled units in the card file's
 * own unfitted frame, rounded, clamped inside the unfitted card (150 x 150
 * on stock). The clamp is the unfitted card, not the fitted one, or a child
 * could never move past the card it currently makes and nothing could grow.
 */
export function placeChild(design: HudDesign, name: string, x: number, y: number): HudDesign {
  const r = cardChild(design, name);
  if (!r || !teamChild(name)?.move) return design;
  const p = baseTeam(design.preset).card;
  const cx = Math.round(Math.min(Math.max(0, p.w - r.w), Math.max(0, x)));
  const cy = Math.round(Math.min(Math.max(0, p.h - r.h), Math.max(0, y)));
  return patchChild(design, name, { x: clampChild('x', cx), y: clampChild('y', cy) });
}

/** Nudge a child from where it is now, through the same clamp as a drag. */
export function nudgeChild(design: HudDesign, name: string, dx: number, dy: number): HudDesign {
  const r = cardChild(design, name);
  return r ? placeChild(design, name, r.x + dx, r.y + dy) : design;
}

/**
 * Resize a child from `start` by (dw, dh), unscaled, inside the unfitted
 * card. Square art keeps its ratio: the side grows by the larger of the two
 * deltas. A child with no size of its own (the item icons) is unchanged.
 */
export function resizeChild(
  design: HudDesign, name: string, start: { x: number; y: number; w: number; h: number }, dw: number, dh: number,
): HudDesign {
  const def = teamChild(name);
  if (!def || def.box === 'none') return design;
  const p = baseTeam(design.preset).card;
  const fit = (v: number, room: number, key: 'w' | 'h') => clampChild(key, Math.round(Math.min(Math.max(1, room), Math.max(1, v))));
  if (def.box === 'square') {
    const side = fit(start.w + Math.max(dw, dh), Math.min(p.w - start.x, p.h - start.y), 'w');
    return patchChild(design, name, { w: side, h: side });
  }
  return patchChild(design, name, { w: fit(start.w + dw, p.w - start.x, 'w'), h: fit(start.h + dh, p.h - start.y, 'h') });
}

const BACKDROPS: [Backdrop, string][] = [
  ['scene', 'Saferoom'], ['dark', 'Dark'], ['bright', 'Bright'], ['grey', 'Grey'], ['shot', 'My screenshot'],
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
function patchNum(
  patch: Patch, e: Event, key: RangeKey, to: (n: number) => Partial<ElementOverride>,
): void {
  const n = parseFloat((e.target as HTMLInputElement).value);
  if (Number.isFinite(n)) patch(to(clampOverride(key, n)));
}

const LAYOUT_LABELS: Record<TeamDir, string> = { row: 'Row', column: 'Column', free: 'Free' };

/**
 * Layout controls for a team element. One Layout select serves both: the
 * survivor team offers Row, Column and Free, the infected row (whose cards
 * the game places itself) only what its registry entry lists, and only the
 * onChange branches, not the select itself. The survivor team's cards step
 * by the Gap between them (0 to 200, units at scale 1) outside Free, plus
 * Fit, and in Free one X and Y per card, card 4 included, since it shows
 * only while spectating a full team and is otherwise unreachable. The
 * infected row keeps its single spacing number.
 */
function TeamControls(
  { design, setDesign, el, o, patch, selectedCard, onPickCard }: {
    design: HudDesign; setDesign: (fn: (d: HudDesign) => HudDesign) => void; el: HudElement; o: ElementOverride;
    patch: Patch; selectedCard: number | null; onPickCard: (card: number | null) => void;
  },
) {
  if (!el.team) return null;
  const team = el.team;
  const t = teamLayout(design, el);
  const options = team.file ? (['row', 'column', 'free'] as const) : team.dirs;
  const onLayoutChange = (e: Event) => {
    const dir = (e.target as HTMLSelectElement).value as TeamDir;
    if (team.file) { onPickCard(null); setDesign((d) => withTeamDir(d, dir)); }
    else patch({ dir: dir as 'row' | 'column' });
  };
  // The boxes show and take where the card is drawn, the slot plus the fit offset.
  const off = cardOffset(design);
  const setSlot = (i: number, key: 'x' | 'y', e: Event) => {
    const n = parseFloat((e.target as HTMLInputElement).value);
    if (!Number.isFinite(n)) return;
    setDesign((d) => {
      const cur = d.elements.teamColumn?.slots?.[i];
      if (!cur) return d;
      const o2 = cardOffset(d);
      return placeCard(d, i, key === 'x' ? n : cur.x + o2.x, key === 'y' ? n : cur.y + o2.y);
    });
  };
  return (
    <>
      <label class="hud__row">
        <span>Layout</span>
        <select value={t.dir} onChange={onLayoutChange}>
          {options.map((d) => <option key={d} value={d}>{LAYOUT_LABELS[d]}</option>)}
        </select>
        <span />
      </label>
      {team.file ? (
        <>
          {t.dir !== 'free' && (
            <Slider
              label="Gap" value={Math.max(0, Math.round(t.gap ?? 0))} min={0} max={200} step={1}
              onInput={(gap) => patch({ gap: clampOverride('gap', gap) })}
            />
          )}
          <label class="hud__check">
            <input
              type="checkbox" checked={o.fit === true}
              onChange={(e) => patch({ fit: (e.target as HTMLInputElement).checked })}
            />
            <span>Fit the card to its contents</span>
          </label>
          {t.dir === 'free' && o.slots && (
            <>
              <p class="muted hud__note">
                Drag each card on the canvas, or type its position. Card 4 shows only while you spectate a full team.
              </p>
              {selectedCard !== null && <p class="hud__note">{`Teammate card ${selectedCard + 1}`}</p>}
              {o.slots.map((s, i) => (
                <div class="hud__row2" key={i}>
                  <label class="hud__field">
                    <span>{`Card ${i + 1} X`}</span>
                    <input type="number" value={Math.round(s.x + off.x)} onFocus={() => onPickCard(i)} onInput={(e) => setSlot(i, 'x', e)} />
                  </label>
                  <label class="hud__field">
                    <span>{`Card ${i + 1} Y`}</span>
                    <input type="number" value={Math.round(s.y + off.y)} onFocus={() => onPickCard(i)} onInput={(e) => setSlot(i, 'y', e)} />
                  </label>
                </div>
              ))}
            </>
          )}
        </>
      ) : (
        <label class="hud__row">
          <span>Spacing</span>
          <input
            type="number" value={t.spacing}
            onInput={(e) => patchNum(patch, e, 'spacing', (n) => ({ spacing: n }))}
          />
          <span />
        </label>
      )}
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
  { design, setDesign, id, selectedCard, onPickCard }: {
    design: HudDesign; setDesign: (fn: (d: HudDesign) => HudDesign) => void; id: string;
    selectedCard: number | null; onPickCard: (card: number | null) => void;
  },
) {
  const el = elementById(id);
  if (!el) return null;
  const o = design.elements[id] ?? {};
  const rect = elementRect(design, id, design.aspect);
  // In Free each card places itself, so the element's own X and Y would move nothing.
  const free = !!el.team?.file && teamLayout(design, el).dir === 'free';
  const patch: Patch = (p) => setDesign((d) => (
    { ...d, elements: { ...d.elements, [id]: { ...(d.elements[id] ?? {}), ...p } } }
  ));
  const reset = () => setDesign((d) => resetElement(d, id));

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

      {id === 'xhair' && (
        <>
          <label class="hud__check">
            <input
              type="checkbox" checked={design.hideGameCrosshair === true}
              onChange={(e) => {
                const on = (e.target as HTMLInputElement).checked;
                setDesign((d) => {
                  const next = { ...d };
                  if (on) next.hideGameCrosshair = true; else delete next.hideGameCrosshair;
                  return next;
                });
              }}
            />
            <span>Hide the game's crosshair</span>
          </label>
          <p class="muted hud__note">Hides the game's own crosshair so an image crosshair can replace it.</p>
        </>
      )}

      {id === 'siHealth' && (
        <p class="muted hud__note">Shown as the Hunter; the Tank uses the same file.</p>
      )}

      {el.move && !free && (
        <div class="hud__row2">
          <label class="hud__field">
            <span>X</span>
            <input type="number" value={Math.round(o.x ?? rect.x)} onInput={(e) => patchNum(patch, e, 'x', (x) => ({ x }))} />
          </label>
          <label class="hud__field">
            <span>Y</span>
            <input type="number" value={Math.round(o.y ?? rect.y)} onInput={(e) => patchNum(patch, e, 'y', (y) => ({ y }))} />
          </label>
        </div>
      )}

      {el.resize === 'free' && (
        <div class="hud__row2">
          <label class="hud__field">
            <span>W</span>
            <input
              type="number" min={20} value={Math.round(o.w ?? rect.w)}
              onInput={(e) => patchNum(patch, e, 'w', (n) => ({ w: Math.max(20, n) }))}
            />
          </label>
          <label class="hud__field">
            <span>H</span>
            <input
              type="number" min={20} value={Math.round(o.h ?? rect.h)}
              onInput={(e) => patchNum(patch, e, 'h', (n) => ({ h: Math.max(20, n) }))}
            />
          </label>
        </div>
      )}

      {el.resize === 'scale' && (
        <Slider label="Scale" value={o.scale ?? 1} min={0.5} max={2} step={0.05} onInput={(scale) => patch({ scale })} />
      )}

      <TeamControls design={design} setDesign={setDesign} el={el} o={o} patch={patch} selectedCard={selectedCard} onPickCard={onPickCard} />

      <button type="button" class="btn btn--ghost btn--sm hud__reset" onClick={reset}>Reset this element</button>
    </Field>
  );
}

/** design.ts's colours are always the raw four-byte "r g b a" string; these
 *  just pull enough out of that to drive a colour input and an opacity
 *  slider, without ever changing the stored representation itself. */
function hexOf(rgba: string): string {
  const [r, g, b] = rgba.split(' ').map(Number);
  return `#${[r, g, b].map((n) => (Number.isFinite(n) ? n : 0).toString(16).padStart(2, '0')).join('')}`;
}
function alphaPct(rgba: string): number {
  const a = Number(rgba.split(' ')[3]);
  return Math.round(((Number.isFinite(a) ? a : 255) / 255) * 100);
}
function withHex(rgba: string, hex: string): string {
  const a = rgba.split(' ')[3] ?? '255';
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `${r} ${g} ${b} ${a}`;
}
function withAlphaPct(rgba: string, pct: number): string {
  const [r, g, b] = rgba.split(' ');
  return `${r} ${g} ${b} ${Math.round((pct / 100) * 255)}`;
}

/**
 * One row of the styles panel: a kind, a colour and an opacity slider that
 * together edit `design.styles[slot.id]`, and for the Image kind a file
 * input that runs the upload through `decodeUpload`. `slot.defaultColor` is
 * only ever shown, never written back, until the reader actually touches
 * something.
 */
function StyleRow(
  { slot, style, error, onChange, onUpload }: {
    slot: StyleSlot; style: StyleOverride | undefined; error: string | undefined;
    onChange: (p: Partial<StyleOverride>) => void;
    onUpload: (file: File) => void;
  },
) {
  const kind = style?.kind ?? 'stock';
  const color = style?.color ?? slot.defaultColor;

  return (
    <div class="hud__stylerow">
      <span class="hud__stylerow-label">{slot.label}</span>
      <select
        aria-label={`${slot.label} style`} value={kind}
        onChange={(e) => onChange({ kind: (e.target as HTMLSelectElement).value as StyleOverride['kind'] })}
      >
        <option value="stock">Stock</option>
        <option value="flat">Flat</option>
        <option value="rounded">Rounded</option>
        <option value="image">Image</option>
      </select>
      <input
        type="color" aria-label={`${slot.label} colour`} value={hexOf(color)}
        onInput={(e) => onChange({ color: withHex(color, (e.target as HTMLInputElement).value) })}
      />
      <input
        type="range" min={0} max={100} step={1} aria-label={`${slot.label} opacity`} value={alphaPct(color)}
        onInput={(e) => onChange({ color: withAlphaPct(color, parseFloat((e.target as HTMLInputElement).value)) })}
      />
      {kind === 'image' && (
        <label class="hud__file hud__file--inline">
          <span class="btn btn--ghost btn--sm">Choose image</span>
          <input
            type="file" accept="image/*" aria-label={`${slot.label} image`}
            onChange={(e) => {
              const input = e.target as HTMLInputElement;
              const f = input.files?.[0];
              if (f) onUpload(f);
              input.value = '';
            }}
          />
        </label>
      )}
      {error && <p class="error">{error}</p>}
    </div>
  );
}

/**
 * The teammate card's insides: one pill per registry child, struck through
 * when hidden, and the only way to reach a hidden or tiny one, as the
 * element list is for elements. A child the preset's file lacks (the stock
 * health number) is a checkbox that adds it; once added it gets a pill too.
 */
function ChildList(
  { design, setDesign, selectedChild, onPick }: {
    design: HudDesign; setDesign: (fn: (d: HudDesign) => HudDesign) => void;
    selectedChild: string | null; onPick: (name: string) => void;
  },
) {
  return (
    <Field legend="Inside the card">
      <div class="hud__list">
        {TEAM_PANEL.children.map((def) => {
          const info = cardChild(design, def.name);
          if (!info) return null;                              // an addable child that is off: its checkbox is below
          return (
            <button
              key={def.name} type="button"
              class={`hud__pill${def.name === selectedChild ? ' is-active' : ''}${info.visible ? '' : ' hud__pill--hidden'}`}
              onClick={() => onPick(def.name)}
            >
              {def.label}
            </button>
          );
        })}
      </div>
      {TEAM_PANEL.children.filter((def) => def.addable && !baseHasChild(design.preset, def.name)).map((def) => (
        <label key={def.name} class="hud__check">
          <input
            type="checkbox" checked={design.children.teamColumn?.[def.name]?.on === true}
            onChange={(e) => { const on = (e.target as HTMLInputElement).checked; setDesign((d) => patchChild(d, def.name, { on })); }}
          />
          <span>{def.label}</span>
        </label>
      ))}
      <p class="muted hud__note">Edits inside a card apply to every teammate's card.</p>
    </Field>
  );
}

/**
 * The controls for one child of the teammate card, built only from its
 * registry entry. Numbers are unscaled units in the card file's own frame
 * (what a ChildOverride stores), read back through cardChild so a child
 * with no edits shows real numbers. Square art gets one Size; labels a text
 * size and, where the game honours it, a colour.
 */
function ChildControls(
  { design, setDesign, name, onBack }: {
    design: HudDesign; setDesign: (fn: (d: HudDesign) => HudDesign) => void; name: string; onBack: () => void;
  },
) {
  const def = teamChild(name);
  const info = cardChild(design, name);
  if (!def || !info) return null;
  const o = design.children.teamColumn?.[name] ?? {};
  const patch = (p: Partial<ChildOverride>) => setDesign((d) => patchChild(d, name, p));
  // The same guard and clamp as patchNum, through the child table.
  const num = (e: Event, key: ChildRangeKey, to: (n: number) => Partial<ChildOverride>) => {
    const n = parseFloat((e.target as HTMLInputElement).value);
    if (Number.isFinite(n)) patch(to(clampChild(key, n)));
  };
  const colour = o.color ?? info.color ?? '255 255 255 255';
  const reset = () => setDesign((d) => {
    const kids = { ...(d.children.teamColumn ?? {}) };
    const on = kids[name]?.on;
    delete kids[name];
    // Resetting an added child keeps it added: the checkbox, not this button, takes it away.
    if (def.addable && on !== undefined) kids[name] = { on };
    const children: HudDesign['children'] = { ...d.children, teamColumn: kids };
    if (Object.keys(kids).length === 0) delete children.teamColumn;
    return { ...d, children };
  });

  return (
    <Field legend={def.label}>
      <label class="hud__check">
        <input type="checkbox" checked={o.visible ?? info.visible} onChange={(e) => patch({ visible: (e.target as HTMLInputElement).checked })} />
        <span>Visible</span>
      </label>
      {def.move && (
        <div class="hud__row2">
          <label class="hud__field">
            <span>X</span>
            <input type="number" value={Math.round(info.x)} onInput={(e) => num(e, 'x', (x) => ({ x }))} />
          </label>
          <label class="hud__field">
            <span>Y</span>
            <input type="number" value={Math.round(info.y)} onInput={(e) => num(e, 'y', (y) => ({ y }))} />
          </label>
        </div>
      )}
      {def.box === 'wh' && (
        <div class="hud__row2">
          <label class="hud__field">
            <span>W</span>
            <input type="number" value={Math.round(info.w)} onInput={(e) => num(e, 'w', (w) => ({ w }))} />
          </label>
          <label class="hud__field">
            <span>H</span>
            <input type="number" value={Math.round(info.h)} onInput={(e) => num(e, 'h', (h) => ({ h }))} />
          </label>
        </div>
      )}
      {def.box === 'square' && (
        <label class="hud__row">
          <span>Size</span>
          <input type="number" value={Math.round(info.w)} onInput={(e) => num(e, 'w', (s) => ({ w: s, h: s }))} />
          <span />
        </label>
      )}
      {def.font && (
        <label class="hud__row">
          <span>{def.box === 'none' ? 'Icon size' : 'Text size'}</span>
          <input type="number" min={6} max={64} value={o.fontSize ?? info.fontTall ?? 12} onInput={(e) => num(e, 'fontSize', (fontSize) => ({ fontSize }))} />
          <span />
        </label>
      )}
      {def.colour && (
        <div class="hud__stylerow">
          <span class="hud__stylerow-label">Colour</span>
          <input
            type="color" aria-label={`${def.label} colour`} value={hexOf(colour)}
            onInput={(e) => patch({ color: withHex(colour, (e.target as HTMLInputElement).value) })}
          />
          <input
            type="range" min={0} max={100} step={1} aria-label={`${def.label} opacity`} value={alphaPct(colour)}
            onInput={(e) => patch({ color: withAlphaPct(colour, parseFloat((e.target as HTMLInputElement).value)) })}
          />
        </div>
      )}
      {def.note && <p class="muted hud__note">{def.note}</p>}
      <button type="button" class="btn btn--ghost btn--sm hud__reset" onClick={reset}>Reset this child</button>
      <button type="button" class="btn btn--ghost btn--sm hud__reset" onClick={onBack}>Back to Teammates</button>
    </Field>
  );
}

type Rect4 = { x: number; y: number; w: number; h: number };
/** What a pointer-down grabbed: an element (moved or resized), one Free teammate card, or a teammate card child. */
type Drag =
  | { kind: 'element'; id: string; mode: 'move' | 'resize'; startUx: number; startUy: number; startRect: Rect4 }
  | { kind: 'card'; card: number; startUx: number; startUy: number; startRect: Rect4 }
  | { kind: 'child'; name: string; mode: 'move' | 'resize'; startUx: number; startUy: number; start: Rect4 };

const CARD_STATES: { key: CardState; label: string }[] = [
  { key: 'healthy', label: 'Healthy' }, { key: 'down', label: 'Down' }, { key: 'dead', label: 'Dead' },
];

export default function Hud() {
  const [design, setDesign] = useState<HudDesign>(loadDesign);
  const [side, setSide] = useState<Side>('survivor');
  const [selected, setSelected] = useState<string | null>(null);
  // In Free, the teammate card the canvas or the card list picked.
  const [selectedCard, setSelectedCard] = useState<number | null>(null);
  // The teammate card child picked in the list or on the canvas: the second selection level.
  const [selectedChild, setSelectedChild] = useState<string | null>(null);
  // Selecting an element (or nothing) always drops a picked card and child.
  const selectEl = (id: string | null) => { setSelected(id); setSelectedCard(null); setSelectedChild(null); };
  // Which state the teammate cards are previewed in. Game code picks it in
  // game; this only changes the picture, never the design or the file.
  const [cardState, setCardState] = useState<CardState>('healthy');
  const [backdrop, setBackdrop] = useState<Backdrop>('scene');
  const [status, setStatus] = useState('');
  const [uploadErrors, setUploadErrors] = useState<Record<string, string>>({});

  const canvas = useRef<HTMLCanvasElement>(null);
  // The reader's own screenshot for the "My screenshot" backdrop. A ref
  // rather than state, like Crosshair.tsx's `shot`: it is never rendered
  // directly, only drawn into the canvas, so a re-render is driven by the
  // tick counter below instead of by the image itself.
  const shot = useRef<HTMLImageElement | null>(null);
  const [imgTick, setImgTick] = useState(0);

  // Which element a pointer-down grabbed, and whether it is moving or
  // resizing it; null between drags. A ref rather than state because it
  // changes every pointermove and must never itself trigger a re-render.
  const drag = useRef<Drag | null>(null);

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

    const shotSize = shot.current ? { w: shot.current.naturalWidth, h: shot.current.naturalHeight } : null;
    drawBackdrop(ctx, w, h, backdrop, shot.current, shotSize);
    drawHud(ctx, w, h, design, side, selected, () => setImgTick((t) => t + 1), { state: cardState, card: selectedCard, child: selectedChild });
  }, [design, side, selected, backdrop, imgTick, cardState, selectedCard, selectedChild]);

  // The preview draws labels in Roboto Condensed, the Modern preset's real
  // font and the closest shipped stand-in for stock's Trade Gothic. Canvas
  // text only uses a web font once the browser has it, so register the two
  // faces on mount and redraw when they arrive. happy-dom has no FontFace,
  // and a browser that refuses is left drawing the fallback stack.
  useEffect(() => {
    try {
      const faces = [new FontFace('Roboto Condensed', `url(${regularUrl})`),
                     new FontFace('Roboto Condensed', `url(${boldUrl})`, { weight: '700' })];
      for (const f of faces) document.fonts.add(f);
      Promise.all(faces.map((f) => f.load())).then(() => setImgTick((t) => t + 1)).catch(() => { /* fallback stack stays */ });
    } catch { /* no FontFace here: the fallback stack stays */ }
  }, []);

  // Debounced rather than immediate: a drag calls setDesign on every
  // pointermove, and an undebounced save would run a synchronous
  // JSON.stringify plus localStorage.setItem on every one of those ticks.
  // Resetting this timer on each change coalesces a burst (a drag, a
  // held-down arrow key, a slider) into one write once motion settles,
  // while a single change still lands within 300ms either way.
  useEffect(() => {
    const t = setTimeout(() => saveDesign(design), 300);
    return () => clearTimeout(t);
  }, [design]);

  // Mount only: a share link is meant to be consumed once. Re-running this
  // whenever `design` changes would try to re-import the same link every
  // time the reader so much as drags an element.
  useEffect(() => {
    if (!location.hash.startsWith('#d=')) return;
    const raw = location.hash.slice(3);
    let cancelled = false;
    (async () => {
      const decoded = await decodeShare(raw);
      if (cancelled) return;
      if (!decoded) {
        setStatus('That link is damaged.');
      } else {
        let apply = true;
        if (hasOverrides(design)) {
          apply = await confirm({
            title: 'Load the HUD design from this link? It will replace the one saved on this browser.',
            confirmLabel: 'Load link', cancelLabel: 'Keep mine',
          });
        }
        if (!cancelled && apply) setDesign(decoded);
      }
      if (!cancelled) history.replaceState(null, '', location.pathname + location.search);
    })();
    return () => { cancelled = true; };
    // `design` is deliberately read only from the closure captured at mount:
    // this effect must run exactly once, not on every subsequent edit.
  }, []);

  const pointerUnits = (e: PointerEvent) => {
    const c = canvas.current!;
    return toUnits(e, c.getBoundingClientRect());
  };

  const onPointerDown = (e: PointerEvent) => {
    const c = canvas.current;
    if (!c) return;
    c.setPointerCapture(e.pointerId);
    const { ux, uy } = pointerUnits(e);
    // Second level: inside the selected teammates, a child under the pointer
    // is picked before the panel, and the picked child's corner resizes it.
    if (selected === 'teamColumn') {
      if (selectedChild && childCornerAt(design, cardState, selectedChild, ux, uy)) {
        const start = cardChild(design, selectedChild);
        if (start) { drag.current = { kind: 'child', name: selectedChild, mode: 'resize', startUx: ux, startUy: uy, start }; return; }
      }
      const child = childAt(design, cardState, ux, uy);
      if (child) {
        setSelectedChild(child.name);
        const start = cardChild(design, child.name);
        drag.current = start && teamChild(child.name)?.move
          ? { kind: 'child', name: child.name, mode: 'move', startUx: ux, startUy: uy, start } : null;
        return;
      }
    }
    const hit = hitTest(design, side, ux, uy);
    if (!hit) {
      selectEl(null);
      drag.current = null;
      return;
    }
    selectEl(hit);
    if (hit === 'teamColumn' && isFreeTeam(design)) {
      // In Free each card is its own target, and dragging it moves only that card.
      const card = freeCardAt(design, ux, uy);
      setSelectedCard(card);
      drag.current = card === null ? null
        : { kind: 'card', card, startUx: ux, startUy: uy, startRect: teamCardRects(design, design.aspect)[card] };
      return;
    }
    const el = elementById(hit)!;
    const rect = elementRect(design, hit, design.aspect);
    const nearCorner = Math.hypot(ux - (rect.x + rect.w), uy - (rect.y + rect.h)) <= 6;
    if (el.resize === 'free' && nearCorner) {
      drag.current = { kind: 'element', id: hit, mode: 'resize', startUx: ux, startUy: uy, startRect: rect };
    } else if (el.move) {
      drag.current = { kind: 'element', id: hit, mode: 'move', startUx: ux, startUy: uy, startRect: rect };
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

    if (d.kind === 'child') {
      // Pointer units are screen units; the stored numbers are unscaled.
      const scale = design.elements.teamColumn?.scale ?? 1;
      const parent = baseTeam(design.preset).card;
      const s = d.start;
      setDesign((cur) => (d.mode === 'resize'
        ? resizeChild(cur, d.name, s, dux / scale, duy / scale)
        : placeChild(cur, d.name, snap(s.x + dux / scale, s.w, parent.w), snap(s.y + duy / scale, s.h, parent.h))));
      return;
    }

    if (d.kind === 'card') {
      const r = d.startRect;
      setDesign((cur) => placeCard(cur, d.card,
        clampSpan(snap(r.x + dux, r.w, extentW), r.w, extentW, 8),
        clampSpan(snap(r.y + duy, r.h, SCREEN_H), r.h, SCREEN_H, 8)));
      return;
    }
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
    // Escape steps up one level: a child or a picked card to the teammates, the teammates to nothing.
    if (e.key === 'Escape') {
      if (selectedChild) setSelectedChild(null);
      else if (selectedCard !== null) setSelectedCard(null);
      else selectEl(null);
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      const list = visibleElements(side).map((el) => el.id);
      if (list.length === 0) return;
      const forward = !e.shiftKey;
      if (!selected) { selectEl(forward ? list[0] : list[list.length - 1]); return; }
      const idx = list.indexOf(selected);
      const base = idx === -1 ? (forward ? -1 : 0) : idx;
      const next = (base + (forward ? 1 : -1) + list.length) % list.length;
      selectEl(list[next]);
      return;
    }

    const amount = e.shiftKey ? 10 : 1;
    const deltas: Record<string, [number, number]> = {
      ArrowUp: [0, -amount], ArrowDown: [0, amount], ArrowLeft: [-amount, 0], ArrowRight: [amount, 0],
    };
    const delta = deltas[e.key];
    if (!delta) return;
    e.preventDefault();
    if (selected === 'teamColumn' && selectedChild) {
      const name = selectedChild;
      setDesign((d) => nudgeChild(d, name, delta[0], delta[1]));
    } else if (selected === 'teamColumn' && selectedCard !== null && isFreeTeam(design)) {
      const card = selectedCard;
      setDesign((d) => nudgeCard(d, card, delta[0], delta[1]));
    } else if (selected) setDesign((d) => nudge(d, selected, delta[0], delta[1]));
  };

  /** Switching preset keeps whatever moves the reader made, but they were
   *  placed for the other layout's own panel sizes, so a design with any
   *  moved elements asks first whether to drop them. Either answer switches
   *  the preset; only whether the moves survive it differs. */
  const changePreset = async (preset: Preset) => {
    if (preset === design.preset) return;
    let resetElements = false;
    if (elementsTouched(design) || Object.keys(design.children).length > 0) {
      resetElements = await confirm({
        title: 'Switching preset keeps your moves and inside edits, but they were placed for the other layout. Reset them as well?',
        confirmLabel: 'Reset', cancelLabel: 'Keep',
      });
    }
    setDesign((d) => ({ ...d, preset, ...(resetElements ? { elements: structuredClone(DEFAULT_DESIGN.elements), children: {} } : {}) }));
  };

  const patchStyle = (id: string, p: Partial<StyleOverride>) => setDesign((d) => ({
    ...d, styles: { ...d.styles, [id]: { ...(d.styles[id] ?? { kind: 'stock' }), ...p } },
  }));

  const onSlotUpload = async (slot: StyleSlot, file: File) => {
    try {
      const { png } = await decodeUpload(file, slot.size.w, slot.size.h);
      setUploadErrors((u) => {
        if (!(slot.id in u)) return u;
        const n = { ...u }; delete n[slot.id]; return n;
      });
      setDesign((d) => ({
        ...d,
        images: { ...d.images, [slot.id]: { w: slot.size.w, h: slot.size.h, png } },
        styles: { ...d.styles, [slot.id]: { ...(d.styles[slot.id] ?? { kind: 'stock' }), kind: 'image' } },
      }));
    } catch (err) {
      setUploadErrors((u) => ({ ...u, [slot.id]: (err as Error).message }));
    }
  };

  const pickShot = (e: Event) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    const img = new Image();
    const url = URL.createObjectURL(f);
    img.onload = () => {
      shot.current = img;
      setBackdrop('shot');
      setImgTick((n) => n + 1);
      setUploadErrors((u) => {
        if (!('shot' in u)) return u;
        const n2 = { ...u }; delete n2.shot; return n2;
      });
      URL.revokeObjectURL(url);
    };
    // Without this, a non-image file picked here fails silently (no status,
    // no error, the old backdrop just stays) and leaks the object URL, since
    // revocation otherwise only ever happens inside onload.
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setUploadErrors((u) => ({ ...u, shot: 'That file is not an image the browser can read.' }));
    };
    img.src = url;
  };

  const download = async () => {
    try {
      const assets = await assetsFor(design);
      // Nothing that reaches a player's game skips the validator. Every
      // control already guards its own input, but this is the one place the
      // design turns into files, so a future control that forgets cannot put
      // an out-of-range or non-finite number into a shipped .res file.
      const p = packHud(validateDesign({ ...design, name: safeName(design.name) }), assets);
      const blob = new Blob([p.bytes], { type: p.mime });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = p.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      setStatus(`Saved ${p.filename}.`);
    } catch (err) {
      // The generator's own errors name the file and panel that broke, which
      // is exactly what is needed to file a useful bug report.
      setStatus((err as Error).message);
    }
  };

  const copyShareLink = async () => {
    const link = `${location.origin}/hud#d=${await encodeShare(design)}`;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      setStatus(`Could not copy automatically. Here is the link: ${link}`);
      return;
    }
    setStatus(Object.keys(design.images).length
      ? 'Copied. Uploaded images are not in a link; use Export to share those.'
      : 'Copied.');
  };

  const exportDesign = () => {
    const blob = new Blob([JSON.stringify(design)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${safeName(design.name)}.hud.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  const importDesign = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    try {
      const text = await f.text();
      const next = validateDesign(JSON.parse(text));
      setDesign(next);
      setStatus(`Imported ${next.name}.`);
    } catch {
      setStatus('That file is not a HUD design.');
    }
  };

  const sideElements = visibleElements(side);
  const basicSlots = SLOTS.filter((s) => !s.advancedOnly);
  const advancedSlots = SLOTS.filter((s) => s.advancedOnly);

  return (
    <div class="page page--wide">
      <PageHeader eyebrow="Tool" title="HUD Editor" />

      <div class="hud">
        <Panel class="hud__stage">
          <div class="hud__toolbar">
            <label>
              Preset{' '}
              <select
                value={design.preset}
                onChange={(e) => { void changePreset((e.target as HTMLSelectElement).value as Preset); }}
              >
                <option value="stock">Stock</option>
                <option value="modern">Modern</option>
              </select>
            </label>

            <Tabs
              tabs={[{ key: 'survivor', label: 'Survivor' }, { key: 'infected', label: 'Infected' }]}
              active={side}
              onSelect={(k) => { setSide(k as Side); selectEl(null); }}
            />

            {side === 'survivor' && (
              <Tabs
                tabs={CARD_STATES.map((s) => ({ key: s.key, label: s.label }))}
                active={cardState}
                onSelect={(k) => setCardState(k as CardState)}
              />
            )}

            <label>
              Aspect{' '}
              <select
                value={design.aspect}
                onChange={(e) => setDesign((d) => ({ ...d, aspect: (e.target as HTMLSelectElement).value as Aspect }))}
              >
                <option value="16:9">16:9</option>
                <option value="16:10">16:10</option>
                <option value="4:3">4:3</option>
              </select>
            </label>

            <label>
              Backdrop{' '}
              <select
                value={backdrop}
                onChange={(e) => setBackdrop((e.target as HTMLSelectElement).value as Backdrop)}
              >
                {BACKDROPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            {backdrop === 'shot' && (
              <label class="hud__file hud__file--inline">
                <span class="btn btn--ghost btn--sm">Load screenshot</span>
                <input type="file" accept="image/*" aria-label="Load a screenshot for the backdrop" onChange={pickShot} />
              </label>
            )}
            {backdrop === 'shot' && uploadErrors.shot && <span class="error">{uploadErrors.shot}</span>}

            <label>
              Font{' '}
              <select
                value={design.font} disabled={design.preset === 'modern'}
                onChange={(e) => setDesign((d) => ({ ...d, font: (e.target as HTMLSelectElement).value as 'preset' | 'roboto' }))}
              >
                <option value="preset">Preset default</option>
                <option value="roboto">Roboto Condensed</option>
              </select>
            </label>
            {design.preset === 'modern' && <span class="muted hud__note">Modern already uses Roboto Condensed.</span>}
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
                  onClick={() => selectEl(el.id)}
                >
                  {el.label}
                </button>
              );
            })}
          </div>
        </Panel>

        <Panel class="hud__side">
          {selected === 'teamColumn' && selectedChild
            ? <ChildControls design={design} setDesign={setDesign} name={selectedChild} onBack={() => setSelectedChild(null)} />
            : selected
              ? <ElementControls design={design} setDesign={setDesign} id={selected} selectedCard={selectedCard} onPickCard={setSelectedCard} />
              : <p class="muted">Select an element on the canvas or in the list below it.</p>}
          {selected === 'teamColumn' && (
            <ChildList design={design} setDesign={setDesign} selectedChild={selectedChild} onPick={setSelectedChild} />
          )}
        </Panel>
      </div>

      <Panel>
        <h3>Styles</h3>
        {basicSlots.map((slot) => (
          <StyleRow
            key={slot.id} slot={slot} style={design.styles[slot.id]} error={uploadErrors[slot.id]}
            onChange={(p) => patchStyle(slot.id, p)}
            onUpload={(f) => { void onSlotUpload(slot, f); }}
          />
        ))}

        <button
          type="button" class="btn btn--ghost btn--sm hud__advtoggle"
          onClick={() => setDesign((d) => ({ ...d, advanced: !d.advanced }))}
        >
          {design.advanced ? 'Turn off advanced mode' : 'Turn on advanced mode'}
        </button>
        <p class="muted hud__note">
          Advanced mode also restyles the incapacitated and dead panels and the weapon boxes. The game only allows
          that from a folder you add to gameinfo.txt, so the download becomes a zip with instructions.
        </p>

        {design.advanced && advancedSlots.map((slot) => (
          <StyleRow
            key={slot.id} slot={slot} style={design.styles[slot.id]} error={uploadErrors[slot.id]}
            onChange={(p) => patchStyle(slot.id, p)}
            onUpload={(f) => { void onSlotUpload(slot, f); }}
          />
        ))}
      </Panel>

      <Panel>
        <h3>Save your HUD</h3>
        <label class="hud__row">
          <span>Name</span>
          <input
            type="text" value={design.name}
            onInput={(e) => setDesign((d) => ({ ...d, name: (e.target as HTMLInputElement).value }))}
          />
          <span />
        </label>

        <button type="button" class="btn btn--block" onClick={() => { void download(); }}>
          {design.advanced ? 'Download .zip' : 'Download .vpk'}
        </button>
        <p class="muted hud__note">
          {design.advanced
            ? 'Unzip it and follow README.txt. It works alongside a crosshair addon. A rebuilt HUD only shows after a game restart. Custom HUDs are allowed on the Riverside servers.'
            : <>Put the file in <code>left4dead/addons/</code> and restart the game. It works alongside a crosshair from the Crosshair page. Custom HUDs are allowed on the Riverside servers.</>}
        </p>
        {!design.advanced && (
          <p class="muted hud__note">
            Also using a crosshair addon? The game keeps only one layout file, and it is usually the
            crosshair's, so this HUD's positions would not show. Open <code>left4dead/addonlist.txt</code> and
            move this HUD's line above the crosshair's. Your crosshair keeps working.
          </p>
        )}

        <div class="hud__sharebar">
          <button type="button" class="btn btn--ghost btn--sm" onClick={() => { void copyShareLink(); }}>Copy share link</button>
          <button type="button" class="btn btn--ghost btn--sm" onClick={exportDesign}>Export</button>
          <label class="hud__file hud__file--inline">
            <span class="btn btn--ghost btn--sm">Import</span>
            <input
              type="file" accept="application/json,.json" aria-label="Import a HUD design file"
              onChange={(e) => { void importDesign(e); }}
            />
          </label>
        </div>

        {status && <p class="muted hud__status">{status}</p>}
        {teamLayout(design, elementById('teamColumn')!).fitEmpty && (
          <p class="muted hud__status">Every part of the teammate card is hidden, so it keeps its full size instead of fitting.</p>
        )}
      </Panel>
    </div>
  );
}
