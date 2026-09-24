import { Fragment, type ComponentChildren } from 'preact';
import { useEffect, useRef, useState, useErrorBoundary } from 'preact/hooks';
import { Panel } from '../components/bits';
import { HudTabs } from '../components/HudTabs';
import { confirm } from '../components/Confirm';
import { drawBackdrop, SIDE_BACKDROP, type Backdrop } from '../crosshair/draw';
import { savedArt } from '../crosshair/saved';
import { importedCrosshair } from '../crosshair/texture';
import { readArt, type CrosshairArt } from '../crosshair/model';
import {
  loadDesign, saveDesign, validateDesign, safeName, encodeShare, decodeShare, newDesign, usableCrosshair,
  type HudDesign, type StyleOverride, type Box,
} from '../hud/design';
import { screenW, SCREEN_H } from '../hud/units';
import { elementById } from '../hud/elements';
import {
  elementRect, teamLayout, teamCardRects, panelFrame, isFreeTeam, packHud, importedHasXhair, splatterProblem,
  type BuildReport, type CardChild,
} from '../hud/build';
import { drawHud, visibleElements, panelBoxes, HANDLE_PX, type Side } from '../hud/mock';
import { DEFAULT_PREVIEW, panelFile, type PreviewState } from '../hud/render';
import type { WeaponHeld } from '../hud/weapons';
import { closeUpRegion } from '../hud/closeup';
import { SLOTS, type StyleSlot } from '../hud/slots';
import { SPLATTERS, type SplatterDef } from '../hud/splatter';
import { registerImport, unregisterImport, hasImport, importedFiles } from '../hud/base';
import { readHudUpload, hudId } from '../hud/upload';
import { importProblem } from '../hud/importCheck';
import { hudStore, type HudMeta } from '../hud/hudStore';
import * as undoStack from '../hud/history';
import { childDef } from '../hud/children';
import {
  hasOverrides, withImport, withPreset, hasLayoutEdits,
  moveElements, moveCards, cardStarts, freeInPlace, moveChildren, startsOf, nudgeSelection,
  resizeBox, resizeElement, scaleElement, resizeChild, scaleChildren, cornerFactor, anchorOf,
  setSelectionVisible, patchChild, hideSelection, resetSelection, raiseChild,
  patchSplatter, withSplatterImage, resetSplatter, splatterKind, gameDefault, isGameDefault,
} from '../hud/edit';
import { snapMove, snapEdges, unionBox, type Guide, type Snap, type Handle } from '../hud/guides';
import {
  NONE, TEAMMATES, cardsOf, hitAt, targetOf, pick, clickSelect, dragIntent, boxSelect, selectAll, climb, breadcrumb, selectionLabel,
  sanitize, selectionKey, selectedIds, selectionFrames, sectionTargets, pieceTargets, pieceGuideToScreen,
  selectionBox, handlesFor, handlePoints, handleAt, isPicked, menuActions, elementFrame, panelOf,
  type Selection, type Hit, type Mods, type Crumb, type MenuAction,
} from '../hud/selection';
import { ContextMenu } from './hud/ContextMenu';
import { ContextPanel } from './hud/ContextPanel';
import { CrosshairBuilderPanel } from './hud/CrosshairControls';
import { LayersPanel } from './hud/LayersPanel';
import { SplatterRow } from './hud/SplatterControls';
import { Toolbar, type PresetChoice } from './hud/Toolbar';
import { endsOn, typedInto, hexOf, alphaPct, withHex, withAlphaPct, type Edit, type EditMode } from './hud/controls';
import { assetsFor, assetSize } from '../hud/assets';
import { decodeUpload } from './hud/decode';
import { communityApi, ApiError } from '../api';
import type { Session } from '../hooks/useLiveState';
import { ShareDialog, type SharePrepared } from '../components/ShareDialog';
import { prepareHudShare, renderPreviews } from '../community/publish';
import { openCommunityImport, SAFETY_FAILED, KEPT_FOR_SESSION } from '../community/open';

// assetsFor and assetSize moved to hud/assets.ts so the community page can
// build a download without this page; re-exported so existing imports keep
// working. decodeUpload and halvingSteps live in ./hud/decode.
export { assetsFor, assetSize };
export { halvingSteps, decodeUpload } from './hud/decode';

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

/** How wide the close-up's sharp render may get, in pixels: past this a redraw costs more than it shows. */
const CLOSEUP_RENDER_W = 2600;

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

/** A press on the canvas: where it started, what was under it, and the handle it caught, until it becomes a click or a drag. */
interface Press { cx: number; cy: number; ux: number; uy: number; mods: Mods; hit: Hit; handle: Handle | null; moved: boolean }

/**
 * What a drag is doing, with where everything started: each pointer move
 * applies the whole delta to the start, so rounding and clamps never drift
 * over a long drag.
 */
type Drag =
  | { kind: 'elements'; ids: string[]; starts: Record<string, Box> }
  | { kind: 'cards'; cards: number[]; starts: Record<number, Box> }
  | { kind: 'children'; names: string[]; card: number; panel: string; starts: Record<string, CardChild> }
  | { kind: 'box' }
  | { kind: 'resizeElement'; id: string; handle: Handle; start: Box }
  | { kind: 'scaleElement'; id: string; handle: Handle; start: Box; scale: number }
  | { kind: 'resizePiece'; name: string; card: number; panel: string; handle: Handle; start: CardChild }
  | { kind: 'scalePieces'; names: string[]; panel: string; handle: Handle; starts: Record<string, CardChild>; box: Box };

/**
 * The screen box a piece's guides are drawn in: its teammate card (every
 * card, the fourth included, which Free lists, as selectionBox has it), or
 * a single panel's one box.
 */
const pieceBox = (d: HudDesign, panel: string, card: number): Box | undefined =>
  (panel === 'teamColumn' ? teamCardRects(d, d.aspect)[card] : panelBoxes(d, panel)[card]);

/** A press and release within this many screen pixels is a click; anything further is a drag. */
const CLICK_PX = 3;
const NO_SNAP: Snap = { dx: 0, dy: 0, guides: [] };
/** How near a handle the pointer must be, in screen pixels, whatever the canvas scale. */
const HANDLE_SLACK_PX = 5;
/**
 * The canvas in HUD units and a handle square's half size there (mock.ts
 * HANDLE_PX, fixed in canvas pixels), so the handles are drawn and hit-tested
 * pinned inside the canvas (selection.ts handlePoints, task L5).
 */
const handleBounds = (pxW: number, pxH: number) => {
  const h = pxH || 1;
  return { w: (pxW * SCREEN_H) / h, h: SCREEN_H, half: (HANDLE_PX / 2) * SCREEN_H / h };
};
const RESIZE_CURSOR: Record<Handle, string> = {
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize',
};
const MENU_LABELS: Record<MenuAction, string> = {
  hide: 'Hide', reset: 'Reset', front: 'Bring to front', back: 'Send to back', selectCard: 'Select whole card', selectTeam: 'Select Teammates',
};
/** A menu item's text: 'selectTeam' names the element another panel's cards or pieces climb to. */
const menuLabel = (a: MenuAction, s: Selection): string => (a === 'selectTeam' && (s.kind === 'children' || s.kind === 'cards') && panelOf(s) !== 'teamColumn'
  ? `Select ${elementById(panelOf(s))?.label ?? 'panel'}`
  : MENU_LABELS[a]);
/** Said on the status line when moving a card takes a Row or Column team into Free. */
const WENT_FREE = 'Teammates switched to Free layout';
/** Said on the status line when localStorage refuses the design, most often over its quota with uploads in it. */
const TOO_BIG = 'This design is too big for this browser to keep. Remove an uploaded image, or use Export to save it as a file.';
/** Said on the status line when the Crosshair page's button brings its crosshair in. */
const FROM_PAGE = 'Your crosshair from the Crosshair page is in this HUD now, and goes into its download.';
/** Said on the status line when a stored 'bundle' choice loses its crosshair, below. */
/** Said on the status line after Reset to game default. */
const RESET_DONE = "This design is the game's own HUD now, with nothing changed. Undo brings back your design.";
/** Added to the download's status line when the file holds no HUD file. */
const GAME_OWN = "This is the game's own HUD; you don't need to install anything. The file holds only its name, so it just replaces an older HUD file of the same name.";
const BUNDLE_LOST = "This design's crosshair is no longer saved on this browser, so it now uses the game default. Choose Custom to make one.";

/** The selection's path at the canvas corner. Each ancestor is a button that selects its level; the last is where you are. */
function Crumbs({ crumbs, onSelect }: { crumbs: Crumb[]; onSelect: (s: Selection) => void }) {
  if (!crumbs.length) return null;
  return (
    <nav class="hud__crumbs" aria-label="Selection path">
      {crumbs.map((c, i) => (
        <Fragment key={i}>
          {i > 0 && <span aria-hidden="true">›</span>}
          {i < crumbs.length - 1
            ? <button type="button" aria-label={`Up to ${c.label}`} onClick={() => onSelect(c.sel)}>{c.label}</button>
            : <span>{c.label}</span>}
        </Fragment>
      ))}
    </nav>
  );
}

/**
 * A side panel that reads the design's base files. What it throws on an
 * imported HUD the checks missed is handed to onError (the page then locks
 * the design and says why) instead of taking the whole page down, since
 * Preact unmounts everything above an uncaught render error. Keyed by the
 * design's base, so switching to another HUD starts it afresh.
 */
function Guard({ onError, children }: { onError: (e: unknown) => void; children: ComponentChildren }) {
  const [err] = useErrorBoundary(onError);
  return err ? null : <>{children}</>;
}

/** A status sentence naming up to three of an upload's left-out paths, or nothing when there are none. */
function leftOut(paths: string[], lead: string): string {
  const n = paths.length;
  return n ? ` ${lead}: ${paths.slice(0, 3).join(', ')}${n > 3 ? ` and ${n - 3} more` : ''}.` : '';
}

const modsOf = (e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): Mods => ({ shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });

/** A community entry id from the query string, or null when it is not one. */
function entryParam(name: string): { raw: string | null; id: number | null } {
  const q = new URLSearchParams(location.search);
  const raw = q.get(name);
  if (raw === null) return { raw, id: null };
  q.delete(name);
  const rest = q.toString();
  // Used once, like #d= and ?from=crosshair: a reload must not ask again.
  history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
  return { raw, id: /^[1-9][0-9]{0,15}$/.test(raw) ? Number(raw) : null };
}

/** An entry fetch's failure, as one status line. */
const entryError = (err: unknown) => (err instanceof ApiError && err.status === 404
  ? 'That community entry was removed.'
  : err instanceof Error ? err.message : String(err));

/** The session is optional so the page still renders on its own (tests, and a route that passes none): no session reads as signed out. */
export default function Hud({ session = { kind: 'anonymous' } }: { session?: Session } = {}) {
  // The crosshair saved on the Crosshair page, read once: a new design
  // carries a copy of it, and a design saved before designs carried their
  // own adopts it (usableCrosshair). From then on the design's own
  // `xhairArt` is the one crosshair the preview draws and the download packs.
  const [saved] = useState<CrosshairArt | null>(savedArt);
  const [design, setDesignState] = useState<HudDesign>(
    () => usableCrosshair(loadDesign(() => newDesign(saved)), saved),
  );
  // The design as of the last edit, read synchronously: two edits in one
  // event (a gesture's end, then a step) must each see the other's result,
  // which a state value only shows on the next render.
  const current = useRef(design);
  // The undo stacks. A ref, like `current`, so recording a step never waits
  // for a render; `histTick` re-renders the Undo and Redo buttons.
  const hist = useRef(undoStack.emptyHistory<HudDesign>());
  const [, setHistTick] = useState(0);
  const apply = (next: HudDesign) => { current.current = next; setDesignState(next); };

  // This browser's imports, for the Preset select. `importTick` re-renders
  // when the in-memory registry changes, since hasImport is not state.
  const [imports, setImports] = useState<HudMeta[]>([]);
  const [, setImportTick] = useState(0);
  // The import whose load from this browser's store has finished, found or
  // not: until then the banner says Loading rather than Import it again.
  const [triedLoad, setTriedLoad] = useState<string | null>(null);
  // An import that threw while the page built or drew it, and what it threw:
  // the checks (importCheck.ts) should have caught it, but if they did not,
  // the page locks that design and says why rather than freezing.
  const [failed, setFailed] = useState<{ id: string; why: string } | null>(null);
  const imp = design.preset === 'imported' ? design.imported : undefined;
  const loaded = imp !== undefined && hasImport(imp.id);
  // Why the design's import cannot be shown, when it cannot: what the page
  // caught, or what the checks say (kept per import, so this is a lookup
  // after the first time).
  const broken = !loaded ? null : failed?.id === imp.id ? failed.why : importProblem(imp.id);
  // The design's imported HUD is not loaded (yet, or at all in this browser),
  // or cannot be shown: nothing reads its files, so nothing draws, edits or
  // downloads. Undo, Redo and the Preset select stay live, so the player can
  // leave it.
  const locked = imp !== undefined && (!loaded || broken !== null);
  const banner = !locked ? '' : broken !== null
    ? `The imported HUD '${imp!.name}' cannot be shown: ${broken}. Choose another preset to keep editing, or remove it.`
    : triedLoad === imp!.id
      ? `This design was made on the imported HUD '${imp!.name}'. Import it again to edit or download it.`
      : `Loading the imported HUD '${imp!.name}'...`;

  /**
   * Something threw while building or drawing the design. On an imported
   * HUD that is the HUD's doing: lock the design and say why. On Stock or
   * Modern it is the editor's own bug, and is thrown on as before.
   */
  const designFailed = (e: unknown) => {
    const d = current.current;
    if (d.preset !== 'imported' || !d.imported) throw e;
    const id = d.imported.id;
    setFailed({ id, why: e instanceof Error ? e.message : String(e) });
  };
  /** An event handler that reads the base files, with designFailed catching what it throws. */
  const safely = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => {
    try { fn(...a); } catch (e) { designFailed(e); }
  };

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
    if (restore) { apply(restore); dropFreeNote(); }
  };
  // Undo or redo mid-drag first lets go of the drag: its moves so far
  // become a step (so Ctrl+Z takes back the drag itself, and Redo brings it
  // back), and the pointer, still down, moves nothing more.
  const doUndo = () => {
    letGoOfDrag();
    endGesture();
    const r = undoStack.undo(hist.current, current.current);
    if (!r) return;
    hist.current = r.h;
    apply(r.value);
    dropFreeNote();
    setHistTick((t) => t + 1);
  };
  const doRedo = () => {
    letGoOfDrag();
    endGesture();
    const r = undoStack.redo(hist.current, current.current);
    if (!r) return;
    hist.current = r.h;
    apply(r.value);
    dropFreeNote();
    setHistTick((t) => t + 1);
  };

  const [side, setSide] = useState<Side>('survivor');
  const [sel, setSel] = useState<Selection>(NONE);
  /** The crosshair alone is selected: its builder is open under the canvas. */
  const xhairSelected = sel.kind === 'elements' && sel.ids.length === 1 && sel.ids[0] === 'xhair';
  // A new design wholesale (another preset, an import, a share link) keeps
  // an element selection and climbs cards or pieces to the Teammates.
  const dropPicks = () => setSel((s) => ((s.kind === 'children' || s.kind === 'cards') && panelOf(s) !== 'teamColumn'
    ? { kind: 'elements', ids: [panelOf(s)] }
    : s.kind === 'cards' || s.kind === 'children' ? TEAMMATES : s));
  // Which state the survivor panels are previewed in (health, crouched, and
  // the infected side's states). Game code picks it in game; this only
  // changes the picture, never the design or the file.
  const [preview, setPreview] = useState<PreviewState>(DEFAULT_PREVIEW);
  const [held, setHeld] = useState<WeaponHeld>('primary');
  // Null until the player picks one: each side is then previewed on its own
  // in-game shot (the forest for survivors, a spawned Hunter for infected),
  // the same ones the community previews are drawn on. A pick sticks across
  // sides, since a player who chose one wants it.
  const [picked, setBackdrop] = useState<Backdrop | null>(null);
  const backdrop: Backdrop = picked ?? SIDE_BACKDROP[side];
  const backdropLoaded = () => setImgTick((t) => t + 1);
  // On load only: a design's own crosshair choice is loaded and coerced
  // twice (here and in `design`, above), rather than threading the loaded
  // value through, so the two reads stay obviously in sync with each other.
  // A stored 'bundle' with no crosshair of its own (saved before designs
  // carried one) silently becomes 'none' when this browser's Crosshair page
  // storage is empty too (usableCrosshair); the player never asked for
  // that, unlike picking Game default themselves, so it is worth a word.
  const [status, setStatus] = useState(() => {
    const d = loadDesign(() => newDesign(saved));
    return d.crosshair === 'bundle' && !d.xhairArt && !saved ? BUNDLE_LOST : '';
  });
  // Moving cards of a Row or Column team makes it Free (edit.ts's moveCards
  // and freeInPlace do it inside the same edit); say so, since the Layout
  // select that changed is out of sight.
  const noteFree = () => { if (!isFreeTeam(current.current)) setStatus(WENT_FREE); };
  // And once an undo, a redo or a cancelled drag has put the team back in
  // Row or Column, the note is no longer true, so it goes. Any other status
  // (a download, an import) is left alone.
  // An undo can land on a design whose import is not loaded, which cannot
  // say whether it is free; the note then goes too, since nothing shows.
  function dropFreeNote() {
    setStatus((m) => {
      if (m !== WENT_FREE) return m;
      try { return isFreeTeam(current.current) ? m : ''; } catch { return ''; }
    });
  }
  const [tooBig, setTooBig] = useState(false);
  const [uploadErrors, setUploadErrors] = useState<Record<string, string>>({});
  // A splatter's upload error is about the picture that failed; once the
  // row's entry changes (Reset, a new kind, an Undo or a successful upload)
  // it no longer applies, so it goes. A failed upload changes no design, so
  // it does not clear its own error.
  const splatSeen = useRef<Record<string, unknown[]>>({});
  useEffect(() => {
    const gone: string[] = [];
    for (const def of SPLATTERS) {
      const now = [splatterKind(design, def.id), design.splatters?.[def.id], design.images[def.id]];
      const was = splatSeen.current[def.id];
      if (was && now.some((v, i) => v !== was[i])) gone.push(def.id);
      splatSeen.current[def.id] = now;
    }
    if (gone.length) {
      setUploadErrors((u) => {
        if (!gone.some((id) => id in u)) return u;
        const n = { ...u }; for (const id of gone) delete n[id]; return n;
      });
    }
  }, [design]);
  // What the pointer is over while nothing is pressed, and whether Ctrl is
  // held: the hover outline shows exactly what a click would pick.
  const [hover, setHover] = useState<{ hit: Hit; ctrl: boolean } | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [marquee, setMarquee] = useState<Box | null>(null);
  // The right-click menu, where it opened (in the canvas wrapper's pixels) and what it acts on.
  const [menu, setMenu] = useState<{ x: number; y: number; sel: Selection } | null>(null);

  const canvas = useRef<HTMLCanvasElement>(null);
  // The close-up of the selection in the side panel, and the sharp full-size render it crops from.
  const zoom = useRef<HTMLCanvasElement>(null);
  const zoomBuf = useRef<HTMLCanvasElement | null>(null);
  // The reader's own screenshot for the "My screenshot" backdrop. A ref
  // rather than state, like Crosshair.tsx's `shot`: it is never rendered
  // directly, only drawn into the canvas, so a re-render is driven by the
  // tick counter below instead of by the image itself.
  const shot = useRef<HTMLImageElement | null>(null);
  const [imgTick, setImgTick] = useState(0);

  // The press and the drag under way, if any. Refs rather than state: they
  // change on every pointermove and must never themselves trigger a render.
  const press = useRef<Press | null>(null);
  const drag = useRef<Drag | null>(null);

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

  // One effect draws everything, so the canvas can never disagree with the
  // design it is supposed to be showing, and every outline in it comes from
  // selection.ts's measurements of the generated trees.
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
    drawBackdrop(ctx, w, h, backdrop, shot.current, shotSize, backdropLoaded);
    if (locked) return;
    try {
      const hovered = hover && !press.current ? targetOf(design, hover.hit, hover.ctrl, sel) : NONE;
      const box = selectionBox(design, sel, preview);
      drawHud(ctx, w, h, design, side, selectedIds(sel), () => setImgTick((t) => t + 1), {
        state: preview,
        held,
        frames: selectionFrames(design, sel, preview),
        box,
        handles: box ? handlePoints(box, handlesFor(design, sel), handleBounds(w, h)) : [],
        hover: hovered.kind === 'none' ? null : { rects: selectionFrames(design, hovered, preview), label: selectionLabel(hovered) },
        marquee,
        guides,
      });
    } catch (e) {
      // A half-drawn HUD is wiped back to the backdrop before the banner says why.
      drawBackdrop(ctx, w, h, backdrop, shot.current, shotSize);
      designFailed(e);
    }
  }, [design, side, sel, backdrop, imgTick, preview, held, hover, guides, marquee, locked]);

  // The close-up: the HUD drawn again, sharp, at up to CLOSEUP_RENDER_W wide (the
  // additive text painter works only untransformed, so no zoomed transform),
  // and the part around the selection copied into the side panel's view.
  // Debounced, so a drag redraws it once it pauses, not every frame.
  const hasCloseUp = !locked && !xhairSelected && sel.kind !== 'none';
  useEffect(() => {
    if (!hasCloseUp) return;
    const t = setTimeout(() => {
      const z = zoom.current, c = canvas.current;
      const zctx = z?.getContext('2d');
      if (!z || !c || !zctx) return;
      const box = selectionBox(design, sel, preview);
      if (!box) return;
      const zr = z.getBoundingClientRect();
      const vw = Math.max(1, Math.round(zr.width)), vh = Math.max(1, Math.round(zr.height));
      if (z.width !== vw || z.height !== vh) { z.width = vw; z.height = vh; }
      const k = c.height / SCREEN_H;
      const r = closeUpRegion({ x: box.x * k, y: box.y * k, w: box.w * k, h: box.h * k }, c.width, c.height, vw, vh);
      const scale = Math.max(1, Math.min(r.zoom, CLOSEUP_RENDER_W / c.width));
      const bw = Math.round(c.width * scale), bh = Math.round(c.height * scale);
      const buf = zoomBuf.current ?? (zoomBuf.current = document.createElement('canvas'));
      if (buf.width !== bw || buf.height !== bh) { buf.width = bw; buf.height = bh; }
      const bctx = buf.getContext('2d');
      if (!bctx) return;
      try {
        const shotSize = shot.current ? { w: shot.current.naturalWidth, h: shot.current.naturalHeight } : null;
        drawBackdrop(bctx, bw, bh, backdrop, shot.current, shotSize);
        drawHud(bctx, bw, bh, design, side, selectedIds(sel), undefined, { state: preview, held, frames: selectionFrames(design, sel, preview) });
      } catch { return; }                                              // the main canvas reports it
      zctx.fillStyle = '#000';
      zctx.fillRect(0, 0, vw, vh);
      zctx.imageSmoothingQuality = 'high';
      zctx.drawImage(buf, r.x * scale, r.y * scale, r.w * scale, r.h * scale, 0, 0, vw, vh);
    }, 60);
    return () => clearTimeout(t);
  }, [hasCloseUp, design, side, sel, backdrop, imgTick, preview, held]);

  // A selection the design or the side no longer has is trimmed or dropped:
  // after an undo, an import, a removed health number, a layout change.
  // A locked design has nothing to select.
  useEffect(() => {
    if (locked) { setSel(NONE); return; }
    try { setSel((s) => sanitize(design, side, s)); } catch (e) { designFailed(e); }
  }, [design, side, locked]);

  // Debounced rather than immediate: a drag changes the design on every
  // pointermove, and an undebounced save would run a synchronous
  // JSON.stringify plus localStorage.setItem on every one of those ticks.
  // Resetting this timer on each change coalesces a burst (a drag, a
  // held-down arrow key, a slider) into one write once motion settles,
  // while a single change still lands within 300ms either way.
  // A refused save (over quota, most often from uploaded images) is said on
  // a line of its own, so a download or a copied link, which set the status
  // line, cannot hide it; it goes once a later save succeeds.
  useEffect(() => {
    const t = setTimeout(() => { setTooBig(!saveDesign(design)); }, 300);
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
        if (hasOverrides(design, saved)) {
          apply = await confirm({
            title: 'Load the HUD design from this link? It will replace the one saved on this browser.',
            confirmLabel: 'Load link', cancelLabel: 'Keep mine',
          });
        }
        if (!cancelled && apply) { edit(() => usableCrosshair(decoded, saved)); dropPicks(); }
      }
      if (!cancelled) history.replaceState(null, '', location.pathname + location.search);
    })();
    return () => { cancelled = true; };
    // `design` is deliberately read only from the closure captured at mount:
    // this effect must run exactly once, not on every subsequent edit.
  }, []);

  // Mount only: list this browser's imports for the Preset select. A browser
  // whose storage is missing or refuses lists none; an import made in this
  // page session is still listed, from memory.
  useEffect(() => {
    let live = true;
    hudStore().list().then((list) => {
      if (live) setImports((l) => [...list, ...l.filter((m) => !list.some((n) => n.id === m.id))]);
    }, () => { /* no storage: nothing to list */ });
    return () => { live = false; };
  }, []);

  // Whenever the design names an import that is not in memory, load it from
  // this browser's store: at load, and after a share link, a design file,
  // Undo or Redo brings in a design on it. Only an import the store does not
  // have leaves the banner asking for it to be imported again.
  useEffect(() => {
    if (!imp || hasImport(imp.id)) return;
    const id = imp.id;
    let live = true;
    (async () => {
      const hud = await hudStore().get(id).catch(() => undefined);
      // A community import registers with its flag again: the registry forgot it on reload.
      if (hud && !hasImport(id)) registerImport(id, hud.files, { community: !!hud.community });
      if (live) { setTriedLoad(id); setImportTick((t) => t + 1); }
    })();
    return () => { live = false; };
  }, [imp?.id, loaded]);

  // Mount only: the Crosshair page's Open in the HUD editor button lands
  // here with ?from=crosshair, having just saved its crosshair. It goes into
  // the design as one step (so Undo gives back the crosshair the design had)
  // and is selected, showing the builder. A new design already carries it,
  // and then the step changes nothing and records nothing.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get('from') !== 'crosshair') return;
    q.delete('from');
    const rest = q.toString();
    history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
    if (!saved) { setStatus('No crosshair was saved on the Crosshair page, so there was nothing to bring in.'); return; }
    // A design that had a crosshair of its own loses it to this one, so say how to get it back.
    const had = current.current.xhairArt;
    const replaced = had !== undefined && JSON.stringify(had) !== JSON.stringify(saved);
    edit((d) => ({ ...d, crosshair: 'bundle', xhairArt: structuredClone(saved) }));
    setSel({ kind: 'elements', ids: ['xhair'] });
    setStatus(replaced ? `${FROM_PAGE} Undo brings back the one it had.` : FROM_PAGE);
  }, []);

  // Mount only: the community page's Open in the HUD editor lands here with
  // ?community=<id>. The entry's design is read like any design (validateDesign),
  // and one on an imported HUD first has its files fetched and checked
  // (openCommunityImport), so nothing applies until the base it names is in.
  // Then the same question a share link asks, and one undoable step.
  useEffect(() => {
    const { raw, id } = entryParam('community');
    if (raw === null) return undefined;
    if (id === null) { setStatus('That community link is damaged.'); return undefined; }
    let cancelled = false;
    (async () => {
      try {
        const entry = await communityApi.get(id);
        if (cancelled) return;
        if (entry.kind !== 'hud') throw new Error('That community entry is not a HUD.');
        const next = usableCrosshair(validateDesign(entry.design), saved);
        let note = '';
        if (next.preset === 'imported') {
          // The server tied the design to the entry's import; a design naming
          // any other id could reach a HUD this browser imported privately.
          if (!next.imported || next.imported.id !== entry.importId) throw new Error(SAFETY_FAILED);
          const opened = await openCommunityImport(entry);
          if (cancelled) return;
          const bytes = [...(importedFiles(`imported:${opened.id}`)?.values() ?? [])].reduce((n, d) => n + d.length, 0);
          const meta: HudMeta = { id: opened.id, name: opened.name, bytes, added: Date.now(), community: { entryId: entry.id } };
          setImports((l) => (l.some((m) => m.id === opened.id) ? l : [...l, meta]));
          setImportTick((t) => t + 1);
          if (!opened.kept) note = KEPT_FOR_SESSION;
        }
        let load = true;
        if (hasOverrides(current.current, saved)) {
          load = await confirm({
            title: 'Load the HUD design from this link? It will replace the one saved on this browser.',
            confirmLabel: 'Load link', cancelLabel: 'Keep mine',
          });
        }
        if (cancelled || !load) return;
        edit(() => next);
        dropPicks();
        setStatus(`Opened ${entry.title} from the community page. Undo brings back the design you had.${note}`);
      } catch (err) {
        if (!cancelled) setStatus(entryError(err));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Mount only: a community crosshair's Use in my HUD lands here with
  // ?xhair=<id>. It goes into the design as ?from=crosshair's does: one step,
  // selected, so Undo gives back the crosshair the design had.
  useEffect(() => {
    const { raw, id } = entryParam('xhair');
    if (raw === null) return undefined;
    if (id === null) { setStatus('That community link is damaged.'); return undefined; }
    let cancelled = false;
    (async () => {
      try {
        const entry = await communityApi.get(id);
        if (cancelled) return;
        const art = entry.kind === 'crosshair' ? readArt(entry.art) : null;
        if (!art) throw new Error('This crosshair cannot be drawn.');
        edit((d) => ({ ...d, crosshair: 'bundle', xhairArt: art }));
        setSel({ kind: 'elements', ids: ['xhair'] });
        setStatus(`${entry.title} is in this HUD now, and goes into its download. Undo brings back the crosshair it had.`);
      } catch (err) {
        if (!cancelled) setStatus(entryError(err));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Share to community: which dialog is open, and the kept set a HUD share
  // registered to draw its preview (see closeShare).
  const [sharing, setSharing] = useState<'hud' | 'crosshair' | null>(null);
  const shareKept = useRef<string | null>(null);
  const prepareShare = async (): Promise<SharePrepared> => {
    const d = current.current;
    const hud = await prepareHudShare(validateDesign(d));
    if (hud.design.imported) shareKept.current = hud.design.imported.id;
    const shots = await renderPreviews(hud.design);
    return { kind: 'hud', name: d.name, hud, preview: shots.survivor, previewInfected: shots.infected };
  };
  const prepareCrosshair = async (): Promise<SharePrepared> => {
    const d = current.current;
    const art = d.crosshair === 'bundle' ? readArt(d.xhairArt) : null;
    if (!art) throw new Error('Choose Custom and make a crosshair to share one.');
    return { kind: 'crosshair', name: '', art };
  };
  // prepareHudShare leaves an import's filtered set registered, for the
  // preview. The design never moves onto it, so once the dialog closes it is
  // dropped again, unless the page uses it anyway: the design's own import,
  // or one of this browser's.
  const closeShare = () => {
    const kept = shareKept.current;
    shareKept.current = null;
    setSharing(null);
    const cur = current.current;
    if (kept && cur.imported?.id !== kept && !imports.some((m) => m.id === kept)) unregisterImport(kept);
  };

  const pointerUnits = (e: { clientX: number; clientY: number }) => toUnits(e, canvas.current!.getBoundingClientRect());

  /** The selection's handle under the point, if any: the nearest within HANDLE_SLACK_PX screen pixels. */
  const handleUnder = (d: HudDesign, ux: number, uy: number): Handle | null => {
    const box = selectionBox(d, sel, preview);
    const c = canvas.current;
    if (!box || !c) return null;
    // The backing store is 1:1 with the CSS box (the draw effect), so the box's size is the canvas's.
    const rect = c.getBoundingClientRect();
    const slack = (HANDLE_SLACK_PX * SCREEN_H) / rect.height;
    return handleAt(box, handlesFor(d, sel), ux, uy, slack, handleBounds(rect.width, rect.height));
  };

  /** What a handle drag resizes, from where everything is now. */
  const handleDrag = (handle: Handle, d: HudDesign): Drag | null => {
    if (sel.kind === 'elements' && sel.ids.length === 1) {
      const id = sel.ids[0];
      const { x, y, w, h } = elementRect(d, id, d.aspect);
      // A corner scales from the frame the handles sit on (the Teammates' drawn cards), so the corner follows the pointer.
      return elementById(id)!.resize === 'free'
        ? { kind: 'resizeElement', id, handle, start: { x, y, w, h } }
        : { kind: 'scaleElement', id, handle, start: elementFrame(d, id), scale: d.elements[id]?.scale ?? 1 };
    }
    if (sel.kind === 'children') {
      const panel = panelOf(sel);
      const starts = startsOf(d, sel.names, panel, panelFile(panel, preview));
      if (sel.names.length === 1) {
        const start = starts[sel.names[0]];
        return start ? { kind: 'resizePiece', name: sel.names[0], card: sel.card, panel, handle, start } : null;
      }
      const box = unionBox(Object.values(starts));
      return box ? { kind: 'scalePieces', names: sel.names, panel, handle, starts, box } : null;
    }
    return null;
  };

  const onPointerDown = (e: PointerEvent) => {
    if (locked) return;
    if (e.button !== 0) return;                            // the right button opens the menu instead
    const c = canvas.current;
    if (!c) return;
    c.setPointerCapture(e.pointerId);
    endGesture();
    const { ux, uy } = pointerUnits(e);
    const d = current.current;
    press.current = { cx: e.clientX, cy: e.clientY, ux, uy, mods: modsOf(e), hit: hitAt(d, side, preview, ux, uy), handle: handleUnder(d, ux, uy), moved: false };
    drag.current = null;
    setHover(null);
  };

  /** What a drag of this selection starts from: every position read back from the generator. */
  const dragFor = (s: Selection, d: HudDesign): Drag | null => {
    switch (s.kind) {
      case 'elements':
        return { kind: 'elements', ids: s.ids, starts: Object.fromEntries(s.ids.map((id) => {
          const { x, y, w, h } = elementRect(d, id, d.aspect);
          return [id, { x, y, w, h }];
        })) };
      case 'cards': return { kind: 'cards', cards: s.cards, starts: cardStarts(d, s.cards) };
      case 'children': return { kind: 'children', names: s.names, card: s.card, panel: panelOf(s), starts: startsOf(d, s.names, panelOf(s), panelFile(panelOf(s), preview)) };
      default: return null;
    }
  };

  /**
   * The pointer has left the click radius: decide what the drag moves,
   * selecting a section it picks up. Cards of a Row or Column team go Free
   * first, as the first edit of the drag's gesture, so the switch and the
   * move are one undo step and every move after it starts from Free.
   */
  const startDrag = (p: Press): Drag | null => {
    const intent = dragIntent(current.current, sel, p.hit, p.mods, p.handle, { x: p.ux, y: p.uy });
    switch (intent.kind) {
      case 'box': return { kind: 'box' };
      case 'move':
        if (intent.sel !== sel) setSel(intent.sel);
        if (intent.sel.kind === 'cards') { noteFree(); edit(freeInPlace, 'gesture'); }
        return dragFor(intent.sel, current.current);
      case 'resize': return handleDrag(intent.handle, current.current);
      case 'none': return null;
    }
  };

  const moveDrag = (d: Drag, p: Press, ux: number, uy: number, alt: boolean, shift: boolean) => {
    const dux = ux - p.ux, duy = uy - p.uy;
    const cur = current.current;
    if (d.kind === 'box') {
      setMarquee({ x: Math.min(p.ux, ux), y: Math.min(p.uy, uy), w: Math.abs(ux - p.ux), h: Math.abs(uy - p.uy) });
      return;
    }
    if (d.kind === 'resizeElement') {
      // A free size snaps the edges the handle drags, unless Alt, or Shift's ratio lock, says not to.
      const raw = resizeBox(d.start, d.handle, dux, duy, false, 20);
      const s = alt || shift ? NO_SNAP : snapEdges(raw, d.handle, sectionTargets(cur, side, { kind: 'elements', ids: [d.id] }));
      setGuides(s.guides);
      edit((x) => resizeElement(x, d.id, d.start, d.handle, dux + s.dx, duy + s.dy, shift), 'gesture');
      return;
    }
    if (d.kind === 'scaleElement') {
      edit((x) => scaleElement(x, d.id, { rect: d.start, scale: d.scale }, d.handle, dux, duy), 'gesture');
      return;
    }
    if (d.kind === 'resizePiece') {
      const f = panelFrame(cur, d.panel);
      const dx = dux / f.k, dy = duy / f.k;
      const snaps = childDef(d.panel, d.name)?.box === 'wh' && !alt && !shift;
      const s = snaps ? snapEdges(resizeBox(d.start, d.handle, dx, dy, false, 1), d.handle, pieceTargets(cur, preview, [d.name], d.panel)) : NO_SNAP;
      const card = pieceBox(cur, d.panel, d.card);
      setGuides(card ? s.guides.map((g) => pieceGuideToScreen(g, card, f)) : []);
      edit((x) => resizeChild(x, d.name, d.start, d.handle, dx + s.dx, dy + s.dy, shift, d.panel, panelFile(d.panel, preview)), 'gesture');
      return;
    }
    if (d.kind === 'scalePieces') {
      const f = panelFrame(cur, d.panel);
      const k = cornerFactor(d.box, d.handle, dux / f.k, duy / f.k);
      edit((x) => scaleChildren(x, d.names, d.starts, anchorOf(d.box, d.handle), k, d.panel, panelFile(d.panel, preview)), 'gesture');
      return;
    }
    if (d.kind === 'children') {
      // Pieces are stored unscaled in the card file's unfitted frame: the
      // pointer delta is divided by the scale, the snap is found in that
      // frame, and its guides are drawn where the pieces are drawn.
      const f = panelFrame(cur, d.panel);
      const dx = dux / f.k, dy = duy / f.k;
      const start = unionBox(Object.values(d.starts));
      if (!start) return;
      const s = alt ? NO_SNAP : snapMove({ ...start, x: start.x + dx, y: start.y + dy }, pieceTargets(cur, preview, d.names, d.panel));
      const card = pieceBox(cur, d.panel, d.card);
      setGuides(card ? s.guides.map((g) => pieceGuideToScreen(g, card, f)) : []);
      edit((x) => moveChildren(x, d.names, d.starts, dx + s.dx, dy + s.dy, d.panel, panelFile(d.panel, preview)), 'gesture');
      return;
    }
    const moving: Selection = d.kind === 'cards' ? cardsOf(d.cards) : { kind: 'elements', ids: d.ids };
    const start = unionBox(Object.values(d.starts));
    if (!start) return;
    const s = alt ? NO_SNAP : snapMove({ ...start, x: start.x + dux, y: start.y + duy }, sectionTargets(cur, side, moving));
    setGuides(s.guides);
    edit((x) => (d.kind === 'cards'
      ? moveCards(x, d.cards, d.starts, dux + s.dx, duy + s.dy)
      : moveElements(x, d.ids, d.starts, dux + s.dx, duy + s.dy)), 'gesture');
  };

  const onPointerMove = (e: PointerEvent) => {
    if (locked) return;                                     // hover reads the base files too
    const { ux, uy } = pointerUnits(e);
    const p = press.current;
    if (!p) {
      const d = current.current;
      // The previous object back when nothing it names changed, so a pointer
      // wandering over one piece does not redraw the canvas on every move.
      const hit = hitAt(d, side, preview, ux, uy), ctrl = e.ctrlKey || e.metaKey;
      setHover((h) => (h && h.ctrl === ctrl && h.hit.element === hit.element && h.hit.card === hit.card && h.hit.child === hit.child
        ? h : { hit, ctrl }));
      const over = handleUnder(d, ux, uy);
      if (canvas.current) canvas.current.style.cursor = over ? RESIZE_CURSOR[over] : '';
      return;
    }
    if (!p.moved) {
      if (Math.hypot(e.clientX - p.cx, e.clientY - p.cy) <= CLICK_PX) return;
      p.moved = true;
      drag.current = startDrag(p);
    }
    if (drag.current) moveDrag(drag.current, p, ux, uy, e.altKey, e.shiftKey);
  };

  const onPointerUp = (e: PointerEvent) => {
    const p = press.current, d = drag.current;
    // Cleared before the capture is released, so the lostpointercapture that
    // release fires is not mistaken for a drag lost mid-way.
    press.current = null;
    drag.current = null;
    const c = canvas.current;
    if (c && c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
    setGuides([]);
    setMarquee(null);
    if (!p) return;
    if (!p.moved) { setSel((s) => clickSelect(current.current, s, p.hit, p.mods)); return; }
    if (d?.kind === 'box') {
      const { ux, uy } = pointerUnits(e);
      setSel(boxSelect(current.current, side, preview, { x: p.ux, y: p.uy }, { x: ux, y: uy }));
      return;
    }
    endGesture();
  };

  /** Forget the press and drag under way, and clear what they drew. */
  function letGoOfDrag() {
    press.current = null;
    drag.current = null;
    setGuides([]);
    setMarquee(null);
  }

  /** A drag that cannot finish (Escape, a cancelled or lost pointer) puts the design back and records nothing. */
  const abortDrag = () => {
    if (drag.current && drag.current.kind !== 'box') cancelGesture();
    letGoOfDrag();
  };

  /**
   * Right-click: a menu for the thing under the pointer. When that thing is
   * part of the selection the menu acts on the whole selection; otherwise it
   * selects the thing (the deepest level, as a click would) and acts on it.
   */
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    if (locked) return;
    // A right-click in the middle of a left press or drag would reselect
    // under the drag and open a menu over it; the drag goes on instead.
    if (press.current) return;
    const d = current.current;
    const { ux, uy } = pointerUnits(e);
    const hit = hitAt(d, side, preview, ux, uy);
    const target = targetOf(d, hit);
    if (target.kind === 'none') { setMenu(null); return; }
    const acting = isPicked(d, sel, hit) ? sel : target;
    setSel(acting);
    const r = canvas.current!.getBoundingClientRect();
    setMenu({ x: e.clientX - r.left, y: e.clientY - r.top, sel: acting });
  };

  const runMenu = (a: MenuAction, s: Selection) => {
    if (a === 'hide') edit((d) => hideSelection(d, s));
    else if (a === 'reset') edit((d) => resetSelection(d, s));
    else if ((a === 'front' || a === 'back') && s.kind === 'children') edit((d) => raiseChild(d, s.names, a, panelOf(s)));
    else if (a === 'selectCard' && s.kind === 'children') setSel(cardsOf([s.card], panelOf(s)));
    else if (a === 'selectTeam') setSel((s.kind === 'children' || s.kind === 'cards') && panelOf(s) !== 'teamColumn' ? { kind: 'elements', ids: [panelOf(s)] } : TEAMMATES);
  };

  // Arrows nudge (Shift by 10), Escape climbs or cancels a drag, Tab and
  // Shift+Tab cycle the side's elements: the editor works without a mouse.
  const onKeyDown = (e: KeyboardEvent) => {
    if (locked) return;
    if (e.key === 'Escape') {
      if (press.current) { abortDrag(); return; }
      setSel(climb);
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (sel.kind === 'none') return;
      e.preventDefault();
      const s = sel;
      edit((d) => hideSelection(d, s));
      return;
    }

    if (e.key === 'Tab' && e.target === canvas.current) {
      e.preventDefault();
      const list = visibleElements(side, design).map((el) => el.id);
      if (list.length === 0) return;
      const forward = !e.shiftKey;
      const at = sel.kind === 'elements' && sel.ids.length === 1 ? list.indexOf(sel.ids[0]) : -1;
      const next = at === -1 ? (forward ? 0 : list.length - 1) : (at + (forward ? 1 : -1) + list.length) % list.length;
      setSel({ kind: 'elements', ids: [list[next]] });
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setSel((s) => selectAll(current.current, side, preview, s));
      return;
    }

    const amount = e.shiftKey ? 10 : 1;
    const deltas: Record<string, [number, number]> = {
      ArrowUp: [0, -amount], ArrowDown: [0, amount], ArrowLeft: [-amount, 0], ArrowRight: [amount, 0],
    };
    const delta = deltas[e.key];
    if (!delta || sel.kind === 'none') return;
    e.preventDefault();
    const s = sel;
    // Only the survivor cards go Free; an infected card's nudge moves its row (edit.ts nudgeSelection).
    if (s.kind === 'cards' && panelOf(s) === 'teamColumn') noteFree();
    edit((d) => nudgeSelection(d, s, delta[0], delta[1], s.kind === 'children' ? panelFile(panelOf(s), preview) : undefined), { nudge: selectionKey(s) });
  };

  /**
   * Switching base keeps whatever moves the reader made, but they were placed
   * for the other layout's own panel sizes, so a design with any layout edits
   * asks first whether to drop them. Either answer switches; only whether the
   * edits survive it differs.
   */
  const askReset = (d: HudDesign) => (hasLayoutEdits(d)
    ? confirm({
      title: 'Switching preset keeps your moves and inside edits, but they were placed for the other layout. Reset them as well?',
      confirmLabel: 'Reset', cancelLabel: 'Keep',
    })
    : Promise.resolve(false));

  const changePreset = async (choice: PresetChoice) => {
    const cur = current.current;
    if (typeof choice === 'string') {
      if (choice === cur.preset) return;
      const reset = await askReset(cur);
      edit((d) => withPreset(d, choice, reset));
    } else {
      const meta = imports.find((m) => m.id === choice.id);
      if (!meta) return;
      // Loaded first, even when the design is on it already: picking the
      // import is also how a design that opened locked gets it back.
      if (!hasImport(choice.id)) {
        const hud = await hudStore().get(choice.id).catch(() => undefined);
        if (!hud) { setStatus('That imported HUD is no longer in this browser.'); return; }
        registerImport(hud.id, hud.files, { community: !!hud.community });
        setImportTick((t) => t + 1);
      }
      if (cur.preset === 'imported' && cur.imported?.id === choice.id) return;
      // One stored before the import checks, that the editor cannot show, is not switched onto.
      const problem = importProblem(choice.id);
      if (problem) { setStatus(`${meta.name} cannot be shown: ${problem}. Remove it from the Preset select.`); return; }
      const reset = await askReset(cur);
      // Switching back onto an import keeps the design's crosshair: the
      // upload's own texture was offered once, when it was imported.
      edit((d) => withImport(d, { id: choice.id, name: meta.name }, { art: null, hasXhair: importedHasXhair(`imported:${choice.id}`), reset }));
    }
    dropPicks();
  };

  /**
   * Import a HUD: read it, name it by its contents, keep it in this browser
   * and in the registry, then move the design onto it. Every failure is one
   * line on the status and leaves the design as it was. A browser that will
   * not store it (no IndexedDB, blocked, over quota) still gets the import
   * for this page session, and the status says so. Importing the HUD a
   * design already names (the missing-import banner's own advice) only
   * loads it: the design is already on it.
   */
  const importHud = async (file: File) => {
    try {
      const upload = await readHudUpload(file.name, new Uint8Array(await file.arrayBuffer()));
      const id = await hudId(upload.files);
      // The same bytes may be stored already as a community import (an id is
      // its files' hash): a private re-import keeps that marker, and with it
      // the build's allowlist check, rather than quietly dropping both.
      const community = (await hudStore().get(id).catch(() => undefined))?.community;
      registerImport(id, upload.files, { community: !!community });
      // Built and drawn once, off screen, before it is kept: a HUD that
      // would throw on the page is refused here, and freed again.
      const problem = importProblem(id);
      if (problem) { unregisterImport(id); throw new Error(problem); }
      const bytes = [...upload.files.values()].reduce((n, d) => n + d.length, 0);
      const meta: HudMeta = { id, name: upload.name, bytes, added: Date.now(), dropped: upload.dropped, ...(community ? { community } : {}) };
      let kept = true;
      try { await hudStore().put({ ...meta, files: upload.files }); } catch { kept = false; }
      // This session's list is the store's plus anything only in memory.
      setImports((l) => [...l.filter((m) => m.id !== id), meta]);
      setImportTick((t) => t + 1);
      const cur = current.current;
      const again = cur.preset === 'imported' && cur.imported?.id === id;
      if (!again) {
        const reset = await askReset(cur);
        const art = importedCrosshair(upload.files);
        edit((d) => withImport(d, { id, name: upload.name }, { art, hasXhair: importedHasXhair(`imported:${id}`), reset }));
        dropPicks();
      }
      const lasting = kept ? '' : ' This browser could not store it, so it is kept only until this page closes.';
      setStatus(`${again ? `Imported ${upload.name} again; this design can be edited and downloaded.` : `Imported ${upload.name}.`}${leftOut(upload.dropped, 'Left out')}${lasting}`);
    } catch (err) {
      setStatus((err as Error).message);
    }
  };

  /** Remove an imported HUD from this browser. A design on it keeps its data and shows the banner. */
  const removeImport = async (id: string) => {
    const name = imports.find((m) => m.id === id)?.name ?? 'that HUD';
    await hudStore().delete(id).catch(() => {});
    unregisterImport(id);
    setImports((l) => l.filter((m) => m.id !== id));
    setImportTick((t) => t + 1);
    setStatus(`Removed ${name} from this browser.`);
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

  // As onSlotUpload: drawn at the splatter's texture size, errors kept per row.
  const onSplatterUpload = async (def: SplatterDef, file: File) => {
    try {
      const { png } = await decodeUpload(file, def.size.w, def.size.h);
      setUploadErrors((u) => {
        if (!(def.id in u)) return u;
        const n = { ...u }; delete n[def.id]; return n;
      });
      edit((d) => withSplatterImage(d, def.id, png));
    } catch (err) {
      setUploadErrors((u) => ({ ...u, [def.id]: (err as Error).message }));
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
    if (locked) return;
    try {
      const assets = await assetsFor(design);
      // Nothing that reaches a player's game skips the validator. Every
      // control already guards its own input, but this is the one place the
      // design turns into files, so a future control that forgets cannot put
      // an out-of-range or non-finite number into a shipped .res file.
      const report: BuildReport = { replaced: [] };
      const p = packHud(validateDesign({ ...design, name: safeName(design.name) }), assets, report);
      // A design that changes nothing (Reset to game default) packs no HUD
      // file, only addoninfo.txt: the game's own HUD needs no addon. It still
      // downloads, since a file of the same name replaces an older one.
      const nothing = p.files.every((f) => f === 'addoninfo.txt') ? ` ${GAME_OWN}` : '';
      const blob = new Blob([p.bytes], { type: p.mime });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = p.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      // An imported HUD's download is not quite the upload: say which of its
      // files the editor wrote over, and what the import left out.
      const replaced = report.replaced.length ? ` The editor's own copies replaced these files from your HUD: ${report.replaced.join(', ')}.` : '';
      const dropped = imp ? imports.find((m) => m.id === imp.id)?.dropped ?? [] : [];
      setStatus(`Saved ${p.filename}.${nothing}${replaced}${leftOut(dropped, 'Left out when it was imported')}`);
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

  /**
   * Reset to game default: every edit goes and the design becomes the game's
   * own HUD (edit.ts gameDefault), asked first, one step for Undo. It lives
   * in Save your HUD beside Export, far from the toolbar and the canvas,
   * so a stray click cannot reach it, and Export is right there to keep a
   * copy first. A locked design (an import this browser lacks) can use it
   * too: it is a way out.
   */
  const resetToGame = async () => {
    const ok = await confirm({
      title: "Reset to the game's own HUD?",
      body: 'Every change in this design goes: layout, sizes, styles, pictures, splatters, weapons, notices and the crosshair. '
        + 'The name stays. Undo brings it all back.',
      confirmLabel: 'Reset', cancelLabel: 'Keep my design', danger: true,
    });
    if (!ok) return;
    letGoOfDrag();
    endGesture();
    edit(gameDefault);
    setSel(NONE);
    setUploadErrors({});
    setStatus(RESET_DONE);
  };

  const importDesign = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    try {
      const text = await f.text();
      const next = usableCrosshair(validateDesign(JSON.parse(text)), saved);
      edit(() => next);
      dropPicks();
      setStatus(`Imported ${next.name}.`);
    } catch {
      setStatus('That file is not a HUD design.');
    }
  };

  // A gesture still open (a number box not yet left) has not recorded its
  // step, but Undo would close and take it back, so it counts once it has
  // changed something. By reference, not sameJson: this runs on every render
  // of a drag, and a design can carry megabytes of image data.
  const pending = hist.current.pending;
  const canUndo = hist.current.past.length > 0 || (pending !== null && pending !== design);

  // Read during render, so a throw here is caught and handed on after it.
  const fitEmpty = () => {
    try { return teamLayout(design, elementById('teamColumn')!).fitEmpty; }
    catch (e) { queueMicrotask(() => designFailed(e)); return false; }
  };

  const basicSlots = SLOTS.filter((s) => !s.advancedOnly);
  const advancedSlots = SLOTS.filter((s) => s.advancedOnly);

  return (
    <div class="page page--wide">
      {/* The tab strip names the page, so the title is for screen readers only. */}
      <HudTabs active="hud" />
      <h2 class="sr-only">HUD editor</h2>
      {sharing && (
        <ShareDialog
          kind={sharing} session={session}
          prepare={sharing === 'hud' ? prepareShare : prepareCrosshair}
          onShared={() => {}} onClose={closeShare}
        />
      )}

      <div class="hud">
        <Panel class="hud__layerpanel">
          {!locked && <Guard key={imp?.id ?? design.preset} onError={designFailed}><LayersPanel
            design={design} side={side} sel={sel}
            onPick={(t, shift) => setSel((s) => pick(s, t, shift))}
            onVisible={(t, v) => edit((d) => setSelectionVisible(d, t, v))}
            onAdd={(name, panel) => { edit((d) => patchChild(d, name, { on: true }, panel)); setSel({ kind: 'children', names: [name], card: 0, ...(panel === 'teamColumn' ? {} : { panel }) }); }}
            onKeyDown={onKeyDown}
          /></Guard>}
        </Panel>

        <Panel class="hud__stage">
          <Toolbar
            design={design} side={side} preview={preview} held={held} backdrop={backdrop} shotError={uploadErrors.shot}
            canUndo={canUndo} canRedo={hist.current.future.length > 0}
            onUndo={doUndo} onRedo={doRedo}
            onSide={(s) => { setSide(s); setSel(NONE); }}
            onPreview={setPreview}
            onHeld={setHeld}
            onPreset={(p) => { void changePreset(p); }}
            onAspect={(a) => edit((d) => ({ ...d, aspect: a }))}
            onBackdrop={setBackdrop}
            onShot={pickShot}
            onFont={(f) => edit((d) => ({ ...d, font: f }))}
            onDownload={() => { void download(); }}
            imports={imports} locked={locked}
            onImportFile={(f) => { void importHud(f); }}
            onRemoveImport={(id) => { void removeImport(id); }}
            onShare={() => setSharing('hud')}
          />
          {banner && (
            <p class="hud__warn" role="status">
              {banner}
              {broken !== null && (
                <> <button type="button" class="btn btn--ghost btn--sm" onClick={() => { void removeImport(imp!.id); }}>Remove this imported HUD</button></>
              )}
            </p>
          )}

          <div class="hud__canvaswrap">
            <canvas
              ref={canvas}
              tabIndex={0}
              class="hud__canvas"
              style={{ aspectRatio: `${screenW(design.aspect)} / ${SCREEN_H}` }}
              onPointerDown={safely(onPointerDown)}
              onPointerMove={safely(onPointerMove)}
              onPointerUp={safely(onPointerUp)}
              onPointerCancel={() => { if (press.current) abortDrag(); }}
              onLostPointerCapture={() => { if (press.current) abortDrag(); }}
              onPointerLeave={() => setHover(null)}
              onKeyDown={safely(onKeyDown)}
              onContextMenu={safely(onContextMenu)}
            />
            <Crumbs crumbs={breadcrumb(sel)} onSelect={setSel} />
            {menu && (
              <ContextMenu
                x={menu.x} y={menu.y} onClose={(refocus) => { setMenu(null); if (refocus) canvas.current?.focus(); }}
                items={menuActions(menu.sel).map((a) => ({ label: menuLabel(a, menu.sel), run: () => runMenu(a, menu.sel) }))}
              />
            )}
          </div>

          {/* The crosshair builder is too wide for the side panel, so while the crosshair is selected it opens here, under the canvas. */}
          {!locked && xhairSelected && (
            <Guard key={imp?.id ?? design.preset} onError={designFailed}>
              <CrosshairBuilderPanel design={design} edit={edit} end={endGesture} onClose={() => setSel(NONE)} onShare={() => setSharing('crosshair')} />
            </Guard>
          )}
        </Panel>

        <Panel class="hud__side">
          {hasCloseUp && (
            <figure class="hud__closeup">
              <canvas ref={zoom} aria-label="Close-up of the selection" />
              <figcaption class="muted">Close-up</figcaption>
            </figure>
          )}
          {!locked && (
            <Guard key={imp?.id ?? design.preset} onError={designFailed}>
              <ContextPanel design={design} sel={sel} edit={edit} end={endGesture} onSelect={setSel} onWentFree={() => setStatus(WENT_FREE)} preview={preview} onPreview={setPreview} />
            </Guard>
          )}
        </Panel>
      </div>

      <Panel>
        <h3>Styles</h3>
        <fieldset class="hud__fieldset" disabled={locked}>
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
          Advanced mode also restyles the incapacitated and dead panels. The game only allows
          that from a folder you add to gameinfo.txt, so the download becomes a zip with instructions.
        </p>

        {design.advanced && advancedSlots.map((slot) => (
          <StyleRow
            key={slot.id} slot={slot} style={design.styles[slot.id]} error={uploadErrors[slot.id]}
            onChange={(p, mode) => patchStyle(slot.id, p, mode)} onEnd={endGesture}
            onUpload={(f) => { void onSlotUpload(slot, f); }}
          />
        ))}
        </fieldset>
      </Panel>

      <Panel>
        <h3>Splatter</h3>
        <p class="muted hud__note">
          Splatter art is flat in the game's files: pick None, a Fade, or your own picture. Your own picture shows on
          all four teammate cards, and also while a teammate is down or dead.
        </p>
        <fieldset class="hud__fieldset" disabled={locked}>
        {SPLATTERS.map((def) => (
          <SplatterRow
            key={def.id} def={def} design={design} imported={design.preset === 'imported'}
            problem={locked ? null : splatterProblem(design, def.id)} error={uploadErrors[def.id]}
            onChange={(p, mode) => edit((d) => patchSplatter(d, def.id, p), mode)} onEnd={endGesture}
            onUpload={(f) => { void onSplatterUpload(def, f); }}
            onReset={() => edit((d) => resetSplatter(d, def.id))}
          />
        ))}
        </fieldset>
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

        <p class="muted hud__note">
          {design.advanced
            ? 'Unzip it and follow README.txt. A rebuilt HUD only shows after a game restart. Custom HUDs are allowed on the Riverside servers.'
            : <>Put the file in <code>left4dead/addons/</code> and restart the game. Custom HUDs are allowed on the Riverside servers.</>}
        </p>
        {design.crosshair === 'bundle' && (
          <p class="muted hud__note">
            Your crosshair is inside this HUD, so disable any separate crosshair addon: it uses the same texture name,
            and whichever loads first wins.
          </p>
        )}
        {design.crosshair === 'addon' && !design.advanced && (
          <p class="muted hud__note">
            The game keeps only one layout file, and a crosshair addon ships its own, so this HUD's positions would not
            show. Open <code>left4dead/addonlist.txt</code> and move this HUD's line above the crosshair's; the in-game
            Add-ons menu cannot change the order. Your crosshair keeps working.
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
          <button
            type="button" class="btn btn--ghost btn--sm" style={{ marginLeft: 'auto' }}
            disabled={isGameDefault(design)}
            title={isGameDefault(design) ? "This design is already the game's own HUD." : "Clear every edit and start from the game's own HUD"}
            onClick={() => { void resetToGame(); }}
          >Reset to game default</button>
        </div>

        {tooBig && <p class="muted hud__status">{TOO_BIG}</p>}
        {status && <p class="muted hud__status">{status}</p>}
        {!locked && fitEmpty() && (
          <p class="muted hud__status">Every part of the teammate card is hidden, so it keeps its full size instead of fitting.</p>
        )}
      </Panel>
    </div>
  );
}
