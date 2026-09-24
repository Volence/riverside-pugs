/**
 * Sharing a HUD to the community page, on the author's side: the files it
 * will carry, the preview it will show, and the form it is sent as.
 *
 * An imported HUD's files go through the allowlist here first
 * (shareableHudFiles): what it refuses is left out and listed, so the author
 * sees it before confirming, and the design is moved onto the kept set's own
 * id. The server refuses rather than filters, so what is sent must already
 * pass.
 */
import { drawBackdrop, loadGameBackdrop, SIDE_BACKDROP, type Backdrop } from '../crosshair/draw';
import { drawHud, type Side } from '../hud/mock';
import { DEFAULT_PREVIEW } from '../hud/render';
import { importedFiles, baseOf, registerImport, unregisterImport, hasImport } from '../hud/base';
import { importProblem } from '../hud/importCheck';
import { encodeVPK } from '../vpk';
import type { HudDesign } from '../hud/design';
import type { Aspect } from '../hud/units';
import { shareableHudFiles, hudSetProblem, hudId } from '../../../src/hudFiles';
import { communityApi } from '../api';
import type { CrosshairArt } from '../crosshair/model';

export interface PreparedHud {
  /** The design as it will be shared: on an import, moved onto the kept set's id. */
  design: HudDesign;
  /** The import's files to upload, or null for a Stock or Modern design. */
  importFiles: Map<string, Uint8Array> | null;
  /** What the allowlist left out, as "path: reason". */
  left: string[];
}

/**
 * The design and files a share will send. Throws one line when the kept set
 * breaks a cap or no longer draws. The kept set is left registered (as a
 * plain import: it is the author's own files) because the preview draws the
 * prepared design, which names it.
 */
export async function prepareHudShare(design: HudDesign): Promise<PreparedHud> {
  if (design.preset !== 'imported' || !design.imported) return { design, importFiles: null, left: [] };
  const files = importedFiles(baseOf(design))!;
  const { kept, left } = shareableHudFiles(files);
  const cap = hudSetProblem(kept);
  if (cap) throw new Error(cap);
  const id = await hudId(kept);
  const was = hasImport(id);
  if (!was) registerImport(id, kept);
  const problem = importProblem(id);
  if (problem) {
    if (!was) unregisterImport(id);
    throw new Error(`Without the files left out, this HUD cannot be shown: ${problem}`);
  }
  return { design: { ...design, imported: { ...design.imported, id } }, importFiles: kept, left };
}

/** The preview's size by aspect: 540 tall, as the server checks it. */
export const PREVIEW_SIZE: Record<Aspect, { w: number; h: number }> = {
  '16:9': { w: 960, h: 540 },
  '16:10': { w: 864, h: 540 },
  '4:3': { w: 720, h: 540 },
};

/** How each side is previewed: the editor's defaults for it, nothing selected. */
const SIDE_STATE: Record<Side, Parameters<typeof drawHud>[7]> = {
  survivor: { state: 'healthy', held: 'primary' },
  infected: { state: DEFAULT_PREVIEW },
};

/**
 * One side's preview PNG, drawn off screen as the editor's canvas draws: the
 * side's in-game shot (SIDE_BACKDROP: the forest for survivors, a spawned
 * Hunter for infected), then the HUD in the editor's default state for that
 * side: a Healthy survivor holding the gun, or a spawned Hunter with its
 * ability Ready. The shot is waited for before anything is drawn; if it
 * cannot load, the drawn saferoom stands in. Style images and fonts load as
 * they are asked for, so it repaints on each one and finishes once none has
 * arrived for `quietMs`, or at `maxMs` whatever is still loading.
 */
export async function renderPreview(
  design: HudDesign, side: Side = 'survivor', o: { quietMs?: number; maxMs?: number } = {},
): Promise<Blob> {
  const quietMs = o.quietMs ?? 300;
  const maxMs = o.maxMs ?? 3000;
  await (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts?.ready;
  const backdrop: Backdrop = (await loadGameBackdrop(SIDE_BACKDROP[side])) ? SIDE_BACKDROP[side] : 'scene';
  const { w, h } = PREVIEW_SIZE[design.aspect];
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot draw the preview.');

  return new Promise<Blob>((resolve, reject) => {
    let done = false;
    let quiet: ReturnType<typeof setTimeout>;
    let queued = false;
    const paint = () => {
      drawBackdrop(ctx, w, h, backdrop, null, null);
      drawHud(ctx, w, h, design, side, null, onAsset, SIDE_STATE[side]);
    };
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(quiet);
      clearTimeout(cap);
      try { paint(); } catch (e) { reject(e); return; }
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('This browser would not save the preview.'))), 'image/png');
    };
    // One repaint per burst of loads, never from inside drawHud's own call.
    function onAsset() {
      if (done) return;
      if (!queued) { queued = true; setTimeout(() => { queued = false; if (!done) paint(); }, 0); }
      clearTimeout(quiet);
      quiet = setTimeout(finish, quietMs);
    }
    const cap = setTimeout(finish, maxMs);
    try { paint(); } catch (e) { done = true; clearTimeout(cap); reject(e); return; }
    quiet = setTimeout(finish, quietMs);
  });
}

/** Both sides' previews, one after the other (each holds a 960 x 540 canvas). */
export async function renderPreviews(
  design: HudDesign, o: { quietMs?: number; maxMs?: number } = {},
): Promise<{ survivor: Blob; infected: Blob }> {
  const survivor = await renderPreview(design, 'survivor', o);
  const infected = await renderPreview(design, 'infected', o);
  return { survivor, infected };
}

/**
 * The multipart body POST /api/community/huds takes: `meta` is a JSON
 * string whose `design` is itself the design's JSON string, as the editor
 * saves it; `preview` is the survivor side's PNG and `previewInfected` the
 * infected side's; `import` is sent only for a design on an imported HUD,
 * with its id in meta.
 */
export function buildHudForm(o: {
  title: string; description: string; permission: boolean; prepared: PreparedHud; preview: Blob; previewInfected?: Blob;
}): FormData {
  const { design, importFiles } = o.prepared;
  const meta: Record<string, unknown> = {
    title: o.title, description: o.description, permission: o.permission, design: JSON.stringify(design),
  };
  if (importFiles && design.imported) meta.importId = design.imported.id;
  const form = new FormData();
  form.set('meta', JSON.stringify(meta));
  form.set('preview', o.preview, 'preview.png');
  if (o.previewInfected) form.set('previewInfected', o.previewInfected, 'preview-infected.png');
  if (importFiles) {
    const vpk = encodeVPK([...importFiles].map(([path, data]) => ({ path, data })));
    form.set('import', new Blob([vpk], { type: 'application/octet-stream' }), 'import.vpk');
  }
  return form;
}

/** Send a prepared HUD share. Resolves to the new entry's id; throws the server's one line. */
export async function shareHud(o: Parameters<typeof buildHudForm>[0]): Promise<{ id: number }> {
  return communityApi.shareHud(buildHudForm(o));
}

/** Send a crosshair share: its art as the page carries it. */
export async function shareCrosshair(o: { title: string; description: string; permission: boolean; art: CrosshairArt }): Promise<{ id: number }> {
  return communityApi.shareCrosshair({ title: o.title, description: o.description, art: o.art, permission: o.permission });
}
