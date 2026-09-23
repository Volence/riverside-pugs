import { useEffect, useRef, useState } from 'preact/hooks';
import { Panel, Tabs } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import { confirm } from '../components/Confirm';
import { drawBackdrop, type Backdrop } from '../crosshair/draw';
import {
  loadDesign, saveDesign, validateDesign, safeName, encodeShare, decodeShare, DEFAULT_DESIGN, baseTeam,
  type HudDesign, type StyleOverride,
} from '../hud/design';
import { elementRect, teamLayout, teamCardRects, isFreeTeam, cardChild, packHud, type BuildAssets } from '../hud/build';
import { teamChild } from '../hud/children';
import { clampSpan, nudge, elementsTouched, hasOverrides, placeCard, nudgeCard, placeChild, nudgeChild, resizeChild } from '../hud/edit';
import { screenW, SCREEN_H, type Aspect } from '../hud/units';
import { elementById } from '../hud/elements';
import { drawHud, hitTest, freeCardAt, childAt, childCornerAt, visibleElements, type Side } from '../hud/mock';
import { NONE, selectionFrames, type Selection } from '../hud/selection';
import type { CardState } from '../hud/render';
import { SLOTS, type StyleSlot } from '../hud/slots';
import type { Preset } from '../hud/base';
import { ElementControls, ChildList, ChildControls } from './hud/ContextPanel';
import { hexOf, alphaPct, withHex, withAlphaPct, endsOn, typedInto, type Edit, type EditMode } from './hud/controls';
import * as undoStack from '../hud/history';
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

const BACKDROPS: [Backdrop, string][] = [
  ['scene', 'Saferoom'], ['dark', 'Dark'], ['bright', 'Bright'], ['grey', 'Grey'], ['shot', 'My screenshot'],
];

/**
 * One row of the styles panel: a kind, a colour and an opacity slider that
 * together edit `design.styles[slot.id]`, and for the Image kind a file
 * input that runs the upload through `decodeUpload`. `slot.defaultColor` is
 * only ever shown, never written back, until the reader actually touches
 * something.
 */
function StyleRow(
  { slot, style, error, onChange, onEnd, onUpload }: {
    slot: StyleSlot; style: StyleOverride | undefined; error: string | undefined;
    onChange: (p: Partial<StyleOverride>, mode?: EditMode) => void;
    onEnd: () => void;
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
        onInput={(e) => onChange({ color: withHex(color, (e.target as HTMLInputElement).value) }, 'gesture')}
        onChange={onEnd}
      />
      <input
        type="range" min={0} max={100} step={1} aria-label={`${slot.label} opacity`} value={alphaPct(color)}
        onInput={(e) => onChange({ color: withAlphaPct(color, parseFloat((e.target as HTMLInputElement).value)) }, 'gesture')}
        onChange={onEnd}
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
  const [design, setDesignState] = useState<HudDesign>(loadDesign);
  // The design as of the last edit, read synchronously: two edits in one
  // event (a gesture's end, then a step) must each see the other's result,
  // which a state value only shows on the next render.
  const current = useRef(design);
  // The undo stacks. A ref, like `current`, so recording a step never waits
  // for a render; `histTick` re-renders the Undo and Redo buttons.
  const hist = useRef(undoStack.emptyHistory<HudDesign>());
  const [, setHistTick] = useState(0);
  const apply = (next: HudDesign) => { current.current = next; setDesignState(next); };

  /**
   * The page's one way to change the design. A step records the value it
   * replaced; a gesture records its start once and is closed by endGesture;
   * a nudge coalesces with the last one on the same selection. A step or a
   * nudge first closes any gesture still open, so a control that never
   * signalled its end still cannot merge into the next edit. An edit that
   * changes nothing records nothing.
   */
  const edit: Edit = (fn, mode: EditMode = 'step') => {
    const cur = current.current;
    const next = fn(cur);
    if (next === cur) return;
    if (mode === 'gesture') {
      hist.current = undoStack.begin(hist.current, cur);
    } else {
      hist.current = undoStack.commit(hist.current, cur, undoStack.sameJson);
      if (undoStack.sameJson(cur, next)) return;
      hist.current = typeof mode === 'object'
        ? undoStack.nudgeStep(hist.current, cur, mode.nudge, Date.now())
        : undoStack.push(hist.current, cur);
    }
    apply(next);
    setHistTick((t) => t + 1);
  };
  const endGesture = () => {
    if (hist.current.pending === null) return;
    hist.current = undoStack.commit(hist.current, current.current, undoStack.sameJson);
    setHistTick((t) => t + 1);
  };
  /** Escape or a lost pointer mid-drag: put the design back where the gesture began, recording nothing. */
  const cancelGesture = () => {
    const { h, restore } = undoStack.cancel(hist.current);
    hist.current = h;
    if (restore) apply(restore);
  };
  const doUndo = () => {
    endGesture();
    const r = undoStack.undo(hist.current, current.current);
    if (!r) return;
    hist.current = r.h;
    apply(r.value);
    setHistTick((t) => t + 1);
  };
  const doRedo = () => {
    endGesture();
    const r = undoStack.redo(hist.current, current.current);
    if (!r) return;
    hist.current = r.h;
    apply(r.value);
    setHistTick((t) => t + 1);
  };

  // Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo (Cmd on macOS), anywhere on
  // the page but inside a typing box, where the browser's own undo applies.
  // Registered once: the handlers read only refs and state setters.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || typedInto(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); doRedo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [side, setSide] = useState<Side>('survivor');
  const [selected, setSelected] = useState<string | null>(null);
  // In Free, the teammate card the canvas or the card list picked.
  const [selectedCard, setSelectedCard] = useState<number | null>(null);
  // The teammate card child picked in the list or on the canvas: the second selection level.
  const [selectedChild, setSelectedChild] = useState<string | null>(null);
  // Selecting an element (or nothing) always drops a picked card and child.
  const selectEl = (id: string | null) => { setSelected(id); setSelectedCard(null); setSelectedChild(null); };
  // A whole new design (another preset, an import, a share link) drops them too.
  const dropPicks = () => { setSelectedCard(null); setSelectedChild(null); };
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
    // The page still keeps three picks; they map onto one Selection for drawing.
    const picked: Selection = selectedChild ? { kind: 'children', names: [selectedChild], card: selectedCard ?? 0 }
      : selectedCard !== null ? { kind: 'card', card: selectedCard }
        : selected ? { kind: 'elements', ids: [selected] } : NONE;
    drawHud(ctx, w, h, design, side, selected, () => setImgTick((t) => t + 1), { state: cardState, frames: selectionFrames(design, picked) });
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

  // A pick the design no longer has is dropped: a child that stopped existing
  // (the health number unticked while selected) or a card once the team
  // left Free. The side panel falls back to the teammates meanwhile, so it
  // is never blank for the render in between.
  const childShown = selected === 'teamColumn' && selectedChild && cardChild(design, selectedChild) ? selectedChild : null;
  useEffect(() => {
    if (selectedChild && !cardChild(design, selectedChild)) setSelectedChild(null);
    if (selectedCard !== null && !isFreeTeam(design)) setSelectedCard(null);
  }, [design]);

  // Debounced rather than immediate: a drag changes the design on every
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
        let load = true;
        if (hasOverrides(design)) {
          load = await confirm({
            title: 'Load the HUD design from this link? It will replace the one saved on this browser.',
            confirmLabel: 'Load link', cancelLabel: 'Keep mine',
          });
        }
        if (!cancelled && load) { edit(() => decoded); dropPicks(); }
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
    // Free has three levels: the teammates, then one card, then its children.
    // A fitted card is almost all children, so a press on any card but the
    // picked one picks and drags that card, and only the picked card's
    // children are reachable. Row and Column reach children in every card.
    if (selected === 'teamColumn') {
      const free = isFreeTeam(design);
      if (free) {
        const card = freeCardAt(design, ux, uy);
        if (card !== null && card !== selectedCard) {
          setSelectedCard(card);
          setSelectedChild(null);
          drag.current = { kind: 'card', card, startUx: ux, startUy: uy, startRect: teamCardRects(design, design.aspect)[card] };
          return;
        }
      }
      const only = free ? selectedCard ?? undefined : undefined;
      const reach = !free || selectedCard !== null;
      if (reach && selectedChild && childCornerAt(design, cardState, selectedChild, ux, uy, only)) {
        const start = cardChild(design, selectedChild);
        if (start) { drag.current = { kind: 'child', name: selectedChild, mode: 'resize', startUx: ux, startUy: uy, start }; return; }
      }
      const child = reach ? childAt(design, cardState, ux, uy, only) : null;
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
      edit((cur) => (d.mode === 'resize'
        ? resizeChild(cur, d.name, { ...s, visible: true }, 'se', dux / scale, duy / scale)
        : placeChild(cur, d.name, snap(s.x + dux / scale, s.w, parent.w), snap(s.y + duy / scale, s.h, parent.h))), 'gesture');
      return;
    }

    if (d.kind === 'card') {
      const r = d.startRect;
      edit((cur) => placeCard(cur, d.card,
        clampSpan(snap(r.x + dux, r.w, extentW), r.w, extentW, 8),
        clampSpan(snap(r.y + duy, r.h, SCREEN_H), r.h, SCREEN_H, 8)), 'gesture');
      return;
    }
    edit((cur) => {
      const old = cur.elements[d.id] ?? {};
      if (d.mode === 'resize') {
        const w = Math.max(20, d.startRect.w + dux);
        const h = Math.max(20, d.startRect.h + duy);
        return { ...cur, elements: { ...cur.elements, [d.id]: { ...old, w, h } } };
      }
      const x = clampSpan(snap(d.startRect.x + dux, d.startRect.w, extentW), d.startRect.w, extentW, 8);
      const y = clampSpan(snap(d.startRect.y + duy, d.startRect.h, SCREEN_H), d.startRect.h, SCREEN_H, 8);
      return { ...cur, elements: { ...cur.elements, [d.id]: { ...old, x, y } } };
    }, 'gesture');
  };

  const onPointerUp = (e: PointerEvent) => {
    const c = canvas.current;
    if (c && c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
    drag.current = null;
    endGesture();
  };

  // Arrows nudge, Escape deselects, Tab/Shift+Tab cycle the current side's
  // elements: the whole editor stays usable without a mouse.
  const onKeyDown = (e: KeyboardEvent) => {
    // Escape steps up one level: a child or a picked card to the teammates, the teammates to nothing.
    if (e.key === 'Escape') {
      if (drag.current) { cancelGesture(); drag.current = null; return; }
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
    // Which selection this nudge moves: a run of nudges on the same one is one undo step.
    const key = [selected, selectedCard, selectedChild].join(':');
    if (selected === 'teamColumn' && selectedChild) {
      const name = selectedChild;
      edit((d) => nudgeChild(d, name, delta[0], delta[1]), { nudge: key });
    } else if (selected === 'teamColumn' && selectedCard !== null && isFreeTeam(design)) {
      const card = selectedCard;
      edit((d) => nudgeCard(d, card, delta[0], delta[1]), { nudge: key });
    } else if (selected) edit((d) => nudge(d, selected, delta[0], delta[1]), { nudge: key });
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
    edit((d) => ({ ...d, preset, ...(resetElements ? { elements: structuredClone(DEFAULT_DESIGN.elements), children: {} } : {}) }));
    dropPicks();
  };

  const patchStyle = (id: string, p: Partial<StyleOverride>, mode: EditMode = 'step') => edit((d) => ({
    ...d, styles: { ...d.styles, [id]: { ...(d.styles[id] ?? { kind: 'stock' }), ...p } },
  }), mode);

  const onSlotUpload = async (slot: StyleSlot, file: File) => {
    try {
      const { png } = await decodeUpload(file, slot.size.w, slot.size.h);
      setUploadErrors((u) => {
        if (!(slot.id in u)) return u;
        const n = { ...u }; delete n[slot.id]; return n;
      });
      edit((d) => ({
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
      edit(() => next);
      dropPicks();
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
            <button
              type="button" class="btn btn--ghost btn--sm" aria-label="Undo" title="Undo (Ctrl+Z)"
              disabled={!hist.current.past.length} onClick={doUndo}
            >
              ↶ Undo
            </button>
            <button
              type="button" class="btn btn--ghost btn--sm" aria-label="Redo" title="Redo (Ctrl+Shift+Z)"
              disabled={!hist.current.future.length} onClick={doRedo}
            >
              ↷ Redo
            </button>
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
                onChange={(e) => edit((d) => ({ ...d, aspect: (e.target as HTMLSelectElement).value as Aspect }))}
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
                onChange={(e) => edit((d) => ({ ...d, font: (e.target as HTMLSelectElement).value as 'preset' | 'roboto' }))}
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
          {childShown
            ? <ChildControls design={design} edit={edit} end={endGesture} name={childShown} onBack={() => setSelectedChild(null)} />
            : selected
              ? <ElementControls design={design} edit={edit} end={endGesture} id={selected} />
              : <p class="muted">Select an element on the canvas or in the list below it.</p>}
          {selected === 'teamColumn' && (
            <ChildList design={design} edit={edit} selectedChild={selectedChild} onPick={setSelectedChild} />
          )}
        </Panel>
      </div>

      <Panel>
        <h3>Styles</h3>
        {basicSlots.map((slot) => (
          <StyleRow
            key={slot.id} slot={slot} style={design.styles[slot.id]} error={uploadErrors[slot.id]}
            onChange={(p, mode) => patchStyle(slot.id, p, mode)} onEnd={endGesture}
            onUpload={(f) => { void onSlotUpload(slot, f); }}
          />
        ))}

        <button
          type="button" class="btn btn--ghost btn--sm hud__advtoggle"
          onClick={() => edit((d) => ({ ...d, advanced: !d.advanced }))}
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
            onChange={(p, mode) => patchStyle(slot.id, p, mode)} onEnd={endGesture}
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
            onInput={(e) => edit((d) => ({ ...d, name: (e.target as HTMLInputElement).value }), 'gesture')}
            {...endsOn(endGesture)}
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
