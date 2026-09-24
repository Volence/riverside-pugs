import { useEffect, useRef, useState } from 'preact/hooks';
import { communityApi, ApiError, type CommunityEntry, type CommunityEntryDetail } from '../api';
import type { Session } from '../hooks/useLiveState';
import { PlayerLink } from './bits';
import { ReportPlayer } from './ReportPlayer';
import { confirm } from './Confirm';
import { drawBackdrop } from '../crosshair/draw';
import { drawArt, readArt } from '../crosshair/model';

/**
 * One shared HUD or crosshair: the gallery's card, the entry page's larger
 * one, and (compact) the profile's.
 *
 * Everything the author typed (title, description, their name) renders as
 * Preact text, never HTML. Image and file URLs come from the server, built
 * from ids and hex hashes it validated; the page never builds one out of
 * anything the author typed.
 */

const BASE_LABEL: Record<string, string> = { stock: 'Stock', modern: 'Modern' };
const baseBadge = (e: CommunityEntry) =>
  e.preset === 'imported' ? `Imported: ${e.importName ?? 'a HUD'}` : BASE_LABEL[e.preset ?? ''] ?? null;

/** The crosshair square: 96 pixels, drawn as the maker's zoom draws it, over the saferoom backdrop. */
const XHAIR_PX = 96;
/** The square the crosshair fills, at 1.5 times its size on a 1080p screen, so a small one still reads. */
const XHAIR_SQUARE = 88;

function CrosshairSwatch({ art: raw, title }: { art: unknown; title: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return undefined;
    const art = readArt(raw);
    const paint = (img: CanvasImageSource | null) => {
      drawBackdrop(ctx, XHAIR_PX, XHAIR_PX, 'scene', null, null);
      if (art) drawArt(ctx, XHAIR_PX / 2, XHAIR_PX / 2, XHAIR_SQUARE, art, img);
    };
    paint(null);
    if (art?.kind !== 'image') return undefined;
    let live = true;
    const img = new Image();
    img.onload = () => { if (live) paint(img); };
    img.src = art.png;
    return () => { live = false; };
  }, [raw]);
  return <canvas ref={canvas} class="ccard__xhair" width={XHAIR_PX} height={XHAIR_PX} role="img" aria-label={`The crosshair ${title}`} />;
}

function Likes({ entry, session }: { entry: CommunityEntry; session: Session }) {
  const [likes, setLikes] = useState({ n: entry.likes, mine: entry.likedByMe });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setLikes({ n: entry.likes, mine: entry.likedByMe }); }, [entry.id, entry.likes, entry.likedByMe]);
  const count = `${likes.n} ${likes.n === 1 ? 'like' : 'likes'}`;
  const own = session.kind !== 'loading' && session.kind !== 'anonymous' && session.me.steamid === entry.author.steamid;
  if (own) return <span class="ccard__likes muted">{count}</span>;
  const active = session.kind === 'active';
  const title = active ? undefined : session.kind === 'pending' ? 'Your account is not active yet' : 'Sign in to like';
  const toggle = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = likes.mine ? await communityApi.unlike(entry.id) : await communityApi.like(entry.id);
      setLikes({ n: r.likes, mine: r.likedByMe });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save that like.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <span class="ccard__likes">
      <button type="button" class={`chip ccard__like${likes.mine ? ' is-on' : ''}`} disabled={!active || busy} title={title}
        aria-pressed={likes.mine} onClick={toggle}>
        {likes.mine ? `Liked, ${likes.n}` : `Like, ${likes.n}`}
      </button>
      {err && <span class="error"> {err}</span>}
    </span>
  );
}

/** Staff take-down: a reason, then the tombstone. The reason is what the author sees. */
function RemoveEntry({ entry, onGone }: { entry: CommunityEntry; onGone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!open) return <button class="chip" type="button" onClick={() => setOpen(true)}>Remove</button>;
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await communityApi.remove(entry.id, reason.trim());
      onGone();
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : 'Could not remove it.');
      setBusy(false);
    }
  };
  return (
    <form class="ccard__remove" onSubmit={submit}>
      <input type="text" maxLength={200} value={reason} aria-label="Reason for removal"
        placeholder="Why (the author is shown this)" onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
      <button class="btn btn--danger" type="submit" disabled={busy || !reason.trim()}>Remove entry</button>
      <button class="chip" type="button" onClick={() => setOpen(false)}>Cancel</button>
      {err && <p class="error">{err}</p>}
    </form>
  );
}

export function CommunityCard(
  { entry, session, size = 'card' }: {
    entry: CommunityEntry | CommunityEntryDetail;
    session: Session;
    /** card: the gallery. large: the entry page. compact: the profile's panel, a link and little else. */
    size?: 'card' | 'large' | 'compact';
  },
) {
  const [gone, setGone] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const isHud = entry.kind === 'hud';
  const noun = isHud ? 'HUD' : 'crosshair';
  const viewer = session.kind === 'active' || session.kind === 'pending' ? session.me : null;
  const own = viewer?.steamid === entry.author.steamid;
  const staff = session.kind === 'active' && (session.me.isAdmin || session.me.isMod === true);
  const href = `/community/${entry.id}`;
  const badge = isHud ? baseBadge(entry) : null;

  // The build code is most of the HUD editor, so it loads on the first
  // Download, never with the gallery. A HUD needs its design, which the
  // list leaves out.
  const download = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const m = await import('../community/download');
      const out = isHud
        ? await m.downloadCommunityHud('design' in entry && entry.design !== undefined ? entry : await communityApi.get(entry.id))
        : await m.downloadCommunityCrosshair(entry);
      setStatus({ ok: true, text: `Saved ${out.filename}. Put it in left4dead/addons/ and restart the game.` });
    } catch (e) {
      setStatus({ ok: false, text: e instanceof ApiError && e.status === 404 ? 'This entry was removed.' : (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (!await confirm({ title: `Delete your shared ${noun}?`, body: 'It leaves the community page at once. Likes on it are lost.', confirmLabel: 'Delete', danger: true })) return;
    try {
      await communityApi.delete(entry.id);
      setGone('Deleted.');
    } catch (e) {
      setStatus({ ok: false, text: e instanceof ApiError ? e.message : 'Could not delete it.' });
    }
  };

  if (gone) {
    return <article class={`ccard ccard--${size} ccard--gone`}><p class="muted">{gone}</p></article>;
  }

  const shot = isHud
    ? (entry.previewUrl
      ? <img class={`ccard__preview ccard__preview--${(entry.aspect ?? '16:9').replace(':', 'x')}`} src={entry.previewUrl} alt={`Preview of ${entry.title}`} loading="lazy" />
      : <div class="ccard__nopreview" />)
    : <CrosshairSwatch art={entry.art} title={entry.title} />;

  if (size === 'compact') {
    return (
      <a class="ccard ccard--compact" href={href}>
        <div class="ccard__shot">{shot}</div>
        <div class="ccard__body">
          <span class="ccard__kind">{isHud ? 'HUD' : 'Crosshair'}</span>
          <span class="ccard__title">{entry.title}</span>
        </div>
      </a>
    );
  }

  return (
    <article class={`ccard ccard--${size}`}>
      <div class="ccard__shot">
        {shot}
        {badge && <span class="ccard__badge">{badge}</span>}
        {isHud && entry.advanced && <span class="ccard__badge ccard__badge--adv">Advanced install</span>}
      </div>
      <div class="ccard__body">
        {size === 'large'
          ? <h2 class="ccard__title">{entry.title}</h2>
          : <h3 class="ccard__title"><a href={href}>{entry.title}</a></h3>}
        {entry.description && <p class="ccard__desc">{entry.description}</p>}
        <div class="ccard__who">
          {entry.author.avatar
            ? <img class="ccard__avatar" src={entry.author.avatar} alt="" loading="lazy" />
            : <span class="ccard__avatar ccard__avatar--blank" />}
          <PlayerLink steamid={entry.author.steamid} name={entry.author.name} />
          <Likes entry={entry} session={session} />
        </div>
        <div class="ccard__actions">
          {isHud ? (
            <>
              <a class="btn btn--sm" href={`/hud?community=${entry.id}`}>Open in the HUD editor</a>
              <button class="btn btn--ghost btn--sm" type="button" disabled={busy} onClick={download}>Download</button>
            </>
          ) : (
            <>
              <button class="btn btn--sm" type="button" disabled={busy} onClick={download}>Download .vpk</button>
              <a class="btn btn--ghost btn--sm" href={`/crosshair?community=${entry.id}`}>Open in the crosshair maker</a>
              <a class="btn btn--ghost btn--sm" href={`/hud?xhair=${entry.id}`}>Use in my HUD</a>
            </>
          )}
        </div>
        {status && <p class={status.ok ? 'muted ccard__status' : 'error ccard__status'}>{status.text}</p>}
        {(session.kind === 'active' && !own) || staff || own ? (
          <div class="ccard__mod">
            {session.kind === 'active' && !own && (
              <ReportPlayer target={{ steamid: entry.author.steamid, name: entry.author.name }}
                entry={{ id: entry.id, kind: entry.kind, title: entry.title }} />
            )}
            {own && <button class="chip" type="button" onClick={del}>Delete</button>}
            {staff && !own && <RemoveEntry entry={entry} onGone={() => setGone('Removed.')} />}
          </div>
        ) : null}
      </div>
    </article>
  );
}
