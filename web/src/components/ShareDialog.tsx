import { useEffect, useRef, useState } from 'preact/hooks';
import { communityApi, ApiError, type CommunityKind, type CommunityMine } from '../api';
import type { Session } from '../hooks/useLiveState';
import { shareHud, shareCrosshair, type PreparedHud } from '../community/publish';
import type { CrosshairArt } from '../crosshair/model';
import { SidePreviews } from './SidePreviews';

/**
 * Share to community: the one dialog both editors open, a HUD from the HUD
 * editor's toolbar and a crosshair from the crosshair maker or the HUD
 * editor's crosshair panel.
 *
 * It asks the editor for what it would share (`prepare`) only once it knows
 * the viewer can share, and reads the viewer's live entries first, so a
 * player at the cap is told before typing anything rather than refused
 * after. The server checks every rule again; the checks here only save the
 * round trip. The modal is the site's own (Confirm.tsx's classes), with
 * Escape and the backdrop closing it.
 */

/** What an editor hands the dialog to share. */
export type SharePrepared =
  | {
    kind: 'hud';
    /** The title to start from: the design's name. */
    name: string;
    hud: PreparedHud;
    /** The survivor side's preview PNG the share uploads, as the dialog shows it. */
    preview: Blob;
    /** The infected side's. */
    previewInfected?: Blob;
  }
  | { kind: 'crosshair'; name: string; art: CrosshairArt };

const TITLE_MIN = 3;
const TITLE_MAX = 40;
const DESCRIPTION_MAX = 280;

const NOUN: Record<CommunityKind, string> = { hud: 'HUD', crosshair: 'crosshair' };

export function ShareDialog(
  { kind, session, prepare, onShared, onClose }: {
    kind: CommunityKind;
    session: Session;
    prepare: () => Promise<SharePrepared>;
    onShared: (id: number) => void;
    onClose: () => void;
  },
) {
  const canShare = session.kind === 'active';
  const [mine, setMine] = useState<CommunityMine | null>(null);
  const [prepared, setPrepared] = useState<SharePrepared | null>(null);
  const [previewUrls, setPreviewUrls] = useState<{ survivor: string; infected: string | null } | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [permission, setPermission] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shared, setShared] = useState<number | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const noun = NOUN[kind];

  useEffect(() => {
    if (!canShare) return undefined;
    let live = true;
    const urls: string[] = [];
    communityApi.mine().then((m) => { if (live) setMine(m); }, () => { /* the server says the cap on Share anyway */ });
    prepare().then((p) => {
      if (!live) return;
      setPrepared(p);
      setTitle((t) => t || p.name.slice(0, TITLE_MAX));
      if (p.kind === 'hud') {
        const survivor = URL.createObjectURL(p.preview);
        const infected = p.previewInfected ? URL.createObjectURL(p.previewInfected) : null;
        urls.push(survivor, ...(infected ? [infected] : []));
        setPreviewUrls({ survivor, infected });
      }
    }, (e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; for (const u of urls) URL.revokeObjectURL(u); };
  }, []);

  useEffect(() => {
    panel.current?.querySelector<HTMLElement>('input, a, button')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  // Live entries of this kind: one staff removed no longer counts toward the cap.
  const live = mine ? mine.entries.filter((e) => e.kind === kind && e.removedByStaff === null) : [];
  const cap = mine ? (kind === 'hud' ? mine.caps.huds : mine.caps.crosshairs) : Infinity;
  const atCap = mine !== null && live.length >= cap;
  const len = [...title.trim()].length;
  const ready = prepared !== null && !atCap && permission && len >= TITLE_MIN && len <= TITLE_MAX && !busy;

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!ready || !prepared) return;
    setBusy(true);
    setError(null);
    try {
      const text = { title: title.trim(), description: description.trim(), permission: true };
      const { id } = prepared.kind === 'hud'
        ? await shareHud({ ...text, prepared: prepared.hud, preview: prepared.preview, previewInfected: prepared.previewInfected })
        : await shareCrosshair({ ...text, art: prepared.art });
      setShared(id);
      onShared(id);
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : 'Could not share it.');
    } finally {
      setBusy(false);
    }
  };

  const signIn = `/auth/steam?next=${encodeURIComponent(location.pathname + location.search)}`;

  return (
    <div class="modal" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="modal__panel share" ref={panel} role="dialog" aria-modal="true" aria-labelledby="share-title">
        <h2 class="modal__title" id="share-title">Share to community</h2>

        {!canShare ? (
          <>
            <p class="modal__body">
              {session.kind === 'pending'
                ? 'Your account is not active yet, so it cannot share.'
                : 'Sign in with Steam to share.'}
            </p>
            <div class="modal__actions">
              <button class="btn--ghost" type="button" onClick={onClose}>Close</button>
              {session.kind !== 'pending' && <a class="btn" href={signIn} target="_top">Sign in through Steam</a>}
            </div>
          </>
        ) : shared !== null ? (
          <>
            <p class="modal__body">Shared. See it on the <a href={`/community/${shared}`}>community page</a>.</p>
            <div class="modal__actions">
              <button class="btn" type="button" onClick={onClose}>Done</button>
            </div>
          </>
        ) : (
          <form class="share__form" onSubmit={submit}>
            {atCap && (
              <div class="share__cap">
                <p>{`You are sharing ${cap} ${noun}${cap === 1 ? '' : 's'} already. Delete one to share another.`}</p>
                <ul>{live.map((e) => <li key={e.id}><a href={`/community/${e.id}`}>{e.title}</a></li>)}</ul>
              </div>
            )}
            {kind === 'hud' && (
              previewUrls
                ? (
                  <div>
                    <SidePreviews survivor={previewUrls.survivor} infected={previewUrls.infected}
                      alt="The preview that will be shared" imgClass="share__preview" shotClass="share__shot" />
                  </div>
                )
                : !error && <p class="muted">Drawing the previews...</p>
            )}
            {prepared?.kind === 'hud' && prepared.hud.left.length > 0 && (
              <div class="share__left">
                <p>Left out when sharing:</p>
                <ul>{prepared.hud.left.map((l) => <li key={l}><code>{l}</code></li>)}</ul>
              </div>
            )}
            <label class="share__field">
              <span>Title</span>
              <input type="text" value={title} maxLength={TITLE_MAX}
                onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
            </label>
            <label class="share__field">
              <span>Description</span>
              <textarea rows={3} value={description} maxLength={DESCRIPTION_MAX}
                onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)} />
            </label>
            <label class="share__check">
              <input type="checkbox" checked={permission} onChange={(e) => setPermission((e.target as HTMLInputElement).checked)} />
              <span>I made this, or its author said I may share it.</span>
            </label>
            {error && <p class="error">{error}</p>}
            <div class="modal__actions">
              <button class="btn--ghost" type="button" onClick={onClose}>Cancel</button>
              <button class="btn" type="submit" disabled={!ready}>{busy ? 'Sharing...' : 'Share'}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
