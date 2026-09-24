import { useEffect, useRef, useState } from 'preact/hooks';
import { Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import {
  DEFAULT_STATE, GAME_BACKDROPS, PX_AT_1080, RES_SCALE, TEX,
  drawBackdrop, drawCrosshair,
  type Backdrop, type CrosshairState, type GameBackdrop, type Res,
} from '../crosshair/draw';
import { CrosshairBuilder, Field } from '../crosshair/Builder';
import { crosshairAddonFromPixels, saveBytes } from '../crosshair/download';
import { CROSSHAIR_KEY, crosshairPixels, savedArt, saveImage } from '../crosshair/saved';
import { readArt, type CrosshairArt } from '../crosshair/model';
import { communityApi, ApiError } from '../api';
import type { Session } from '../hooks/useLiveState';
import { confirm } from '../components/Confirm';
import { ShareDialog } from '../components/ShareDialog';

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

/**
 * Keep an imported image in this browser as the texture this page exports
 * from it (the image drawn into the TEX square), so it survives a reload and
 * the HUD editor can take it in (savedArt). Storage failing only loses that.
 */
function saveTexture(img: HTMLImageElement) {
  const c = document.createElement('canvas');
  c.width = TEX; c.height = TEX;
  const ctx = c.getContext('2d');
  if (!ctx) return;
  drawCrosshair(ctx, TEX / 2, TEX / 2, TEX / PX_AT_1080, { ...DEFAULT_STATE, shape: 'image' }, img);
  saveImage({ png: c.toDataURL('image/png'), w: TEX, h: TEX });
}

/** The HUD editor's backdrops: its real in-game shots first (the default is CROSSHAIR_BACKDROP), then the drawn and flat ones. */
const GAME: GameBackdrop[] = ['survivor-hilltop', 'survivor-subway', 'infected-hunter', 'infected-ghost'];
const BACKDROPS: [Backdrop, string][] = [
  ['scene', 'Drawn saferoom'], ['dark', 'Dark'], ['bright', 'Bright'],
  ['grey', 'Grey'], ['shot', 'My screenshot'],
];
const RESOLUTIONS: [Res, string][] = [
  ['1080', '1920 x 1080'], ['1440', '2560 x 1440'],
  ['2160', '3840 x 2160'], ['768', '1366 x 768'],
];

/** The session is optional so the page still renders on its own: no session reads as signed out. */
export function Crosshair({ session = { kind: 'anonymous' } }: { session?: Session } = {}) {
  // Whether this browser had a crosshair saved when the page opened, read
  // before the page's own save effect writes one: a community crosshair asks
  // before replacing it.
  const [hadSaved] = useState(() => savedArt() !== null);
  const [state, setState] = useState<CrosshairState>(loadState);
  const [name, setName] = useState('my_crosshair');
  const [status, setStatus] = useState('');
  const [sharing, setSharing] = useState(false);

  const preview = useRef<HTMLCanvasElement>(null);
  const zoom = useRef<HTMLCanvasElement>(null);
  const tex = useRef<HTMLCanvasElement>(null);
  // Images live in refs, not state: they are large, never rendered directly,
  // and a re-render on load is triggered by the counter below instead.
  const imported = useRef<HTMLImageElement | null>(null);
  const shot = useRef<HTMLImageElement | null>(null);
  const [imgTick, setImgTick] = useState(0);

  const set = (patch: Partial<CrosshairState>) => setState((s) => ({ ...s, ...patch }));

  const save = (s: CrosshairState) => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* not important enough to surface */ }
  };
  useEffect(() => save(state), [state]);

  // Mount only: on the image shape, the image imported last time, saved as its texture.
  useEffect(() => {
    const art = state.shape === 'image' ? savedArt() : null;
    if (art?.kind !== 'image') return;
    const img = new Image();
    img.onload = () => { imported.current = img; setImgTick((n) => n + 1); };
    img.src = art.png;
  }, []);

  // Mount only: a community crosshair's Open in the crosshair maker lands
  // here with ?community=<id>. The art is read like any stored crosshair
  // (readArt); the parameter is used once, as the HUD editor's are.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const raw = q.get('community');
    if (raw === null) return undefined;
    q.delete('community');
    const rest = q.toString();
    history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
    if (!/^[1-9][0-9]{0,15}$/.test(raw)) { setStatus('That community link is damaged.'); return undefined; }
    let cancelled = false;
    (async () => {
      try {
        const entry = await communityApi.get(Number(raw));
        if (cancelled) return;
        const art = entry.kind === 'crosshair' ? readArt(entry.art) : null;
        if (!art) throw new Error('This crosshair cannot be drawn.');
        if (hadSaved && !await confirm({
          title: 'Replace the crosshair saved on this browser with this one?',
          confirmLabel: 'Use this one', cancelLabel: 'Keep mine',
        })) return;
        if (cancelled) return;
        if (art.kind === 'built') {
          // The viewer's own backdrop and resolution stay: they only change this page's preview.
          setState((s) => ({ ...art.state, backdrop: s.backdrop, res: s.res }));
        } else {
          saveImage({ png: art.png, w: art.w, h: art.h });
          const img = new Image();
          img.onload = () => { if (!cancelled) { imported.current = img; setImgTick((n) => n + 1); } };
          img.src = art.png;
          set({ shape: 'image' });
        }
        setStatus(`Loaded ${entry.title} from the community page.`);
      } catch (err) {
        if (!cancelled) {
          setStatus(err instanceof ApiError && err.status === 404 ? 'That community entry was removed.' : (err as Error).message);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /** What Share to community sends: the drawn crosshair, or on the image shape the saved image. */
  const prepareShare = async () => {
    let art: CrosshairArt | null = { kind: 'built', state };
    if (state.shape === 'image') {
      art = savedArt();
      if (art?.kind !== 'image') throw new Error('Import an image first, or pick a shape.');
    }
    return { kind: 'crosshair' as const, name: name === 'my_crosshair' ? '' : name, art };
  };

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
    // The shot at its own size on the chosen screen, like the crosshair; once
    // an in-game shot has loaded, the tick paints again.
    drawBackdrop(pctx, w, h, state.backdrop, shot.current, sz, () => setImgTick((n) => n + 1), RES_SCALE[state.res]);
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
      if (into === imported) saveTexture(img);
      set(patch);
      setImgTick((n) => n + 1);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  /**
   * The Open in the HUD editor link: save the crosshair as it is now (the
   * image was saved when it was imported), and let the link take the player
   * to /hud?from=crosshair, where the editor takes it into the HUD design.
   * On the image shape what counts is the saved image, which is what the
   * editor reads: straight after a reload the page's own decoded copy may
   * not be back yet, and the saved one is already there.
   */
  const openInHud = (e: Event) => {
    if (state.shape === 'image' && savedArt()?.kind !== 'image') {
      e.preventDefault();
      setStatus('Import an image first, or pick a shape.');
      return;
    }
    save(state);
  };

  const download = () => {
    if (state.shape === 'image' && savedArt()?.kind !== 'image') {
      setStatus('Import an image first, or pick a shape.');
      return;
    }
    // The same pixels the HUD editor bundles from this page's saved state.
    const px = crosshairPixels(state, imported.current);
    if (!px) return;
    const { filename, bytes } = crosshairAddonFromPixels(name, px);
    saveBytes(filename, bytes);
    setStatus(`Saved ${filename} (${(bytes.length / 1024).toFixed(0)} KB). Put it in left4dead/addons/ and restart the game.`);
  };

  return (
    <div class="page page--wide">
      <PageHeader eyebrow="Tool" title="Crosshair Maker" />
      {sharing && (
        <ShareDialog kind="crosshair" session={session} prepare={prepareShare} onShared={() => {}} onClose={() => setSharing(false)} />
      )}

      <div class="xh">
        <Panel class="xh__controls">
          <CrosshairBuilder state={state} set={(p) => set(p)} withImage />

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
            <p class="muted xh__status">
              Planning a custom HUD too? A crosshair addon and a HUD addon fight over the same file, so bring your
              crosshair into the HUD editor instead: it goes into the HUD's download.
            </p>
            <a class="btn btn--ghost btn--block xh__tohud" href="/hud?from=crosshair" onClick={openInHud}>Open in the HUD editor</a>
            <button type="button" class="btn btn--ghost btn--block xh__share" onClick={() => setSharing(true)}>Share to community...</button>
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
                <optgroup label="In game">
                  {GAME.map((v) => <option key={v} value={v}>{GAME_BACKDROPS[v].label}</option>)}
                </optgroup>
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
