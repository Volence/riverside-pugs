import { useEffect, useRef, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { adminApi, bookingsApi, scrimsApi, teamsApi, type BookingOptions, type BookingRole, type BookingSide, type BookingView, type ReviewTag } from '../api';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import type { Session } from '../hooks/useLiveState';
import { localLabel } from '../bookingTime';
import { campaignName } from '../format';
import { confirm } from '../components/Confirm';
import { RecordLine } from '../components/ScrimRecord';
import { REVIEW_TAGS, REVIEW_TAG_LABELS } from '../components/ReviewSummary';

const STATE_LINE: Record<BookingView['state'], string> = {
  scheduled: 'Booked. The server is taken and set up 15 minutes before the start.',
  held: 'Taking the server.', setup: 'Setting the server up.', ready: 'The server is ready.', active: 'Playing.',
  ended: 'Over.', cancelled: 'Cancelled.', no_show: 'Ended: a side did not show.',
};
const ROLE_LABEL: Record<BookingRole, string> = { player: 'Player', ringer: 'Ringer', spectator: 'Spectator' };

function AddPerson({ id, side, onDone }: { id: number; side: BookingSide; onDone: (v: BookingView) => void }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ steamid: string; name: string }[]>([]);
  const [role, setRole] = useState<BookingRole>('player');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return; }
    const ctl = new AbortController();
    teamsApi.search(q.trim(), ctl.signal).then((r) => setFound(r.players), () => {});
    return () => ctl.abort();
  }, [q]);
  const add = async (steamid: string) => {
    setError(null);
    try { onDone(await bookingsApi.addPerson(id, side, steamid, role)); setQ(''); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <div class="bookingadd">
      <input aria-label="Add a player" value={q} placeholder="Add someone by name" onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      <select aria-label="Role" value={role} onChange={(e) => setRole((e.target as HTMLSelectElement).value as BookingRole)}>
        {(['player', 'ringer', 'spectator'] as const).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
      </select>
      <ul>{found.map((p) => <li key={p.steamid}><button class="btn btn--ghost" onClick={() => add(p.steamid)}>{p.name}</button></li>)}</ul>
      {error && <p class="error" role="alert">{error}</p>}
    </div>
  );
}

/** Staff's excuse for one side's mark (plan 2): a late cancel or a no-show,
 *  with an optional note. Excused marks count nowhere, not in the record and
 *  not in the booking allowance. */
function StaffExcuse({ v, side, busy, staffAct }: {
  v: BookingView; side: BookingView['sides'][number]; busy: boolean; staffAct: (fn: () => Promise<unknown>) => void;
}) {
  const [note, setNote] = useState('');
  return (
    <p class="bookingexcuse">
      <input aria-label={`Excuse note (${side.name})`} value={note} maxLength={200} placeholder="Note (optional, staff only)"
        onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
      <button class="btn btn--ghost" disabled={busy} onClick={() => staffAct(() => adminApi.excuseBooking(v.id, side.side, note))}>Excuse</button>
    </p>
  );
}

/** Casters for a booked scrim (plan 4c): a caster sees the games, live feed
 *  and relay only once both sides invite them, so each side's manager sets or
 *  takes back their own side's half here. */
function Casters({ v, mySide, open, busy, act }: {
  v: BookingView; mySide: BookingSide; open: boolean; busy: boolean; act: (fn: () => Promise<BookingView>) => void;
}) {
  const [choices, setChoices] = useState<{ steamid: string; name: string }[]>([]);
  const [pick, setPick] = useState('');
  useEffect(() => {
    if (!open) return;
    const ctl = new AbortController();
    bookingsApi.casters(ctl.signal).then((r) => setChoices(r.casters), () => {});
    return () => ctl.abort();
  }, [open]);
  const nameOf = (side: BookingSide) => v.sides.find((s) => s.side === side)!.name;
  const mine = (c: BookingView['casters'][number]) => (mySide === 'a' ? c.a : c.b);
  const invitable = choices.filter((c) => !v.casters.some((x) => x.steamid === c.steamid && mine(x)));
  return (
    <Panel>
      <h3>Casters</h3>
      <p class="muted">A caster sees this scrim's games, live feed and SourceTV only once both sides invite them.</p>
      {v.casters.length > 0 && (
        <ul class="bookingcasters">
          {v.casters.map((c) => (
            <li key={c.steamid}>
              <span>{c.name}</span>
              <span class="muted"> · {nameOf('a')} {c.a ? '✓' : 'pending'} / {nameOf('b')} {c.b ? '✓' : 'pending'}</span>
              {/* Withdraw stays after the booking closes: taking back an
                  invite is always this side's to do, and the API allows it. */}
              {mine(c) && (
                <button class="btn btn--ghost" disabled={busy} onClick={() => act(() => bookingsApi.withdrawCaster(v.id, c.steamid))}>Withdraw</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {open && (
        <p>
          <select aria-label="Caster" value={pick} onChange={(e) => setPick((e.target as HTMLSelectElement).value)}>
            <option value="">Pick a caster</option>
            {invitable.map((c) => <option key={c.steamid} value={c.steamid}>{c.name}</option>)}
          </select>
          <button class="btn" disabled={busy || !pick} onClick={() => { act(() => bookingsApi.inviteCaster(v.id, pick)); setPick(''); }}>Invite</button>
        </p>
      )}
    </Panel>
  );
}

/** The viewer's own private review of the other side (plan 2 Ruling 5): a
 *  thumbs up or down plus tags, pre-filled from `mine`, editable until the
 *  7 day window closes. Only this side's own review is ever in this card. */
function ReviewCard({ v, mySide, busy, act }: {
  v: BookingView; mySide: BookingSide; busy: boolean; act: (fn: () => Promise<BookingView>) => void;
}) {
  const other = v.sides.find((s) => s.side !== mySide)!;
  const mine = v.review?.mine ?? null;
  const [thumbs, setThumbs] = useState<1 | -1 | null>(mine?.thumbs ?? null);
  const [tags, setTags] = useState<ReviewTag[]>(mine?.tags ?? []);
  const [saved, setSaved] = useState(false);
  const pick = (t: 1 | -1) => { setSaved(false); setThumbs(t); };
  const toggleTag = (t: ReviewTag) => { setSaved(false); setTags((ts) => (ts.includes(t) ? ts.filter((x) => x !== t) : [...ts, t])); };
  const save = () => {
    if (thumbs === null) return;
    act(async () => { const r = await bookingsApi.review(v.id, thumbs, tags); setSaved(true); return r; });
  };
  return (
    <Panel>
      <h3>Review {other.name}</h3>
      <p class="bookingreview">
        <button type="button" class={`chip${thumbs === 1 ? ' is-on' : ''}`} aria-pressed={thumbs === 1} disabled={busy} onClick={() => pick(1)}>Thumbs up</button>
        <button type="button" class={`chip${thumbs === -1 ? ' is-on' : ''}`} aria-pressed={thumbs === -1} disabled={busy} onClick={() => pick(-1)}>Thumbs down</button>
      </p>
      <p class="bookingreview">
        {REVIEW_TAGS.map((t) => (
          <button key={t} type="button" class={`chip${tags.includes(t) ? ' is-on' : ''}`} aria-pressed={tags.includes(t)} disabled={busy} onClick={() => toggleTag(t)}>
            {REVIEW_TAG_LABELS[t]}
          </button>
        ))}
      </p>
      <p class="bookingreview">
        <button class="btn" disabled={busy || thumbs === null} onClick={save}>Save</button>
        {saved && <span class="muted">Saved. Only staff see single reviews.</span>}
      </p>
    </Panel>
  );
}

/** Both sides' single reviews, staff only (plan 2 Ruling 5). Shown whenever
 *  the server sends `reviews` at all, even empty, since only a staff viewer
 *  ever gets the key. */
function StaffReviews({ v }: { v: BookingView }) {
  return (
    <Panel>
      <h3>Reviews (staff only)</h3>
      {v.reviews!.length === 0 ? <p class="muted">No reviews yet.</p> : (
        <ul class="bookingreviews">
          {v.reviews!.map((r) => (
            <li key={r.side}>
              <span>{v.sides.find((s) => s.side === r.side)?.name ?? r.side}</span>
              <span>{r.thumbs === 1 ? 'Thumbs up' : 'Thumbs down'}</span>
              {r.tags.length > 0 && <span class="muted">{r.tags.map((t) => REVIEW_TAG_LABELS[t]).join(', ')}</span>}
              <span class="muted">by {r.reviewerName}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function Booking({ id, session }: { id: string; session: Session }) {
  const { route, query } = useLocation();
  /** The reminder DM's Cancel link (`?cancel=1`) asks once per page load. */
  const askedCancel = useRef(false);
  const [v, setV] = useState<BookingView | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [campaigns, setCampaigns] = useState<BookingOptions['campaigns']>([]);
  const [pick, setPick] = useState('');

  const load = () => { bookingsApi.get(id).then(setV, () => setMissing(true)); };
  useEffect(load, [id]);
  // The campaign pool, for the "Play this next" select. Loaded once; nobody
  // needs it until the booking is running anyway, and it costs nothing to
  // have it ready before then.
  useEffect(() => { bookingsApi.options().then((o) => setCampaigns(o.campaigns), () => {}); }, []);
  useEffect(() => {
    // The state moves on its own (held, ready, active): re-read while it can.
    if (!v || v.ending || ['ended', 'cancelled', 'no_show'].includes(v.state)) return;
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [v?.state, v?.ending]);

  // Most actions always return the fresh view, since the viewer is still part
  // of the booking afterward. Leaving is the one that can take the viewer out
  // of it entirely; the server then answers with a null body (no view left to
  // show them), and this sends them back to the list instead of blanking the
  // page out from under them.
  const act = async (fn: () => Promise<BookingView>) => {
    setError(null);
    setBusy(true);
    try {
      const result = await fn();
      if (result) setV(result); else route('/bookings');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // The admin routes (used by staff who do not themselves manage a confirmed
  // side) answer { ok: true }, not a fresh view: the view is keyed to a side
  // the viewer manages, which a staff-only viewer has none of. Reload it
  // separately instead of trying to read one out of the action's result.
  const staffAct = async (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
      setV(await bookingsApi.get(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // The reminder DM's Cancel link lands here with ?cancel=1 (plan 2 Ruling 3):
  // open the cancel confirm at once, but only for a viewer who may cancel.
  // Anyone else just sees the page.
  useEffect(() => {
    if (!v || askedCancel.current || query?.cancel !== '1') return;
    askedCancel.current = true;
    const open = !v.ending && ['scheduled', 'held', 'setup', 'ready', 'active'].includes(v.state);
    const player = open && v.viewer.manages.some((s) => v.sides.find((side) => side.side === s)?.confirmed);
    const staff = open && v.viewer.staff && !player;
    if (!player && !staff) return;
    (async () => {
      const ok = await confirm({
        title: 'Cancel this booking?', body: 'Both sides are told. A cancel close to the start counts as a late cancel on your side.',
        confirmLabel: 'Cancel booking', cancelLabel: 'Keep it', danger: true,
      });
      if (!ok) return;
      if (player) act(() => bookingsApi.cancel(v.id, '')); else staffAct(() => adminApi.cancelBooking(v.id, ''));
    })();
  }, [v, query?.cancel]);

  if (missing || session.kind !== 'active') return <main class="page page--profile bookingpage"><PageHeader title="Booking" /><Empty>No such booking.</Empty></main>;
  if (!v) return null;
  // Re-posting a cancelled scrim (plan 2): unlike act(), this returns the
  // new post's id, not a fresh BookingView, so success routes to the board
  // instead of re-rendering this page; a refusal just shows its text here.
  const repost = async () => {
    setError(null);
    setBusy(true);
    try {
      const { id } = await scrimsApi.repost(v.id);
      route(`/scrims?post=${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const open = !v.ending && ['scheduled', 'held', 'setup', 'ready', 'active'].includes(v.state);
  const running = open && (v.state === 'ready' || v.state === 'active');
  const [a, b] = v.sides;
  const unconfirmedB = !b.confirmed;
  // A side's captain or co-captain may only Cancel, Extend or End once their
  // own side has confirmed; an unconfirmed side gets Confirm/Decline instead
  // (below), never the run of the booking. A side manager always goes
  // through the player routes, even when they are also staff. A staff
  // viewer who manages no confirmed side (the admin desk case) has to go
  // through the admin routes instead: the player routes never pass a staff
  // flag, so those buttons would just fail with "not a manager".
  const managesConfirmedSide = v.viewer.manages.some((s) => v.sides.find((side) => side.side === s)?.confirmed);
  // The side this viewer acts for, as the server picks it (actingSides()[0]).
  const actingSide = v.viewer.manages.find((s) => v.sides.find((side) => side.side === s)?.confirmed) ?? null;
  const playerManage = open && managesConfirmedSide;
  const staffOnly = open && v.viewer.staff && !playerManage;
  const canManage = playerManage || staffOnly;
  // Between-games controls (plan 4b): shown once the booking is actually
  // running, with nothing live right now, to whoever may call `!nextmap` /
  // `!stay` on the box itself (a manager of a confirmed side, or staff). Both
  // player routes take a staff caller too, so there is no admin-only variant
  // here the way Extend/End/Cancel have one.
  const liveGame = v.games.some((g) => g.state === 'live');
  const canPlayGames = running && !liveGame && (managesConfirmedSide || v.viewer.staff);

  return (
    <main class="page page--profile bookingpage">
      <PageHeader eyebrow="Booked server" title={`${a.name} vs ${b.name}`}>
        <p>{localLabel(v.startsAt)} to {localLabel(v.endsAt)}{v.extendedMinutes > 0 ? ` (extended ${v.extendedMinutes} min)` : ''} · {v.playlist.map((c) => c.name).join(', ')}</p>
      </PageHeader>
      {error && <p class="error" role="alert">{error}</p>}
      <Panel>
        <p>{v.ending && v.state !== 'cancelled' && v.state !== 'no_show' ? 'Closing.' : STATE_LINE[v.state]}{v.cancel?.reason ? ` Reason: ${v.cancel.reason}` : ''}</p>
        {v.connect && (
          <p class="bookingconnect">In the game console: <code>{`connect ${v.connect.host}:${v.connect.port}; password ${v.connect.password}`}</code></p>
        )}
        {v.repost.allowed && (
          <p><button class="btn" disabled={busy} onClick={repost}>Re-post this scrim</button></p>
        )}
        {v.viewer.invited && v.viewer.manages.length === 0 && open && (
          <p>
            <button class="btn" disabled={busy} onClick={() => act(() => bookingsApi.act(v.id, 'accept'))}>Accept</button>
            <button class="btn btn--ghost" disabled={busy} onClick={() => act(() => bookingsApi.act(v.id, 'leave'))}>Decline</button>
          </p>
        )}
        {unconfirmedB && v.viewer.manages.includes('b') && open && (
          <p>
            <button class="btn" disabled={busy} onClick={() => act(() => bookingsApi.act(v.id, 'confirm'))}>Confirm</button>
            <button class="btn btn--ghost" disabled={busy} onClick={() => act(() => bookingsApi.act(v.id, 'decline'))}>Decline</button>
          </p>
        )}
      </Panel>
      {v.sides.map((s) => (
        <Panel key={s.side}>
          <h3>{s.name}{!s.confirmed ? ' (not confirmed yet)' : ''}{s.noShow ? ' · no-show' : ''}</h3>
          {s.record && <RecordLine record={s.record} label="Record" />}
          {s.lateCancel && (
            <p class="bookinglate">
              <span>Late cancel by {s.name}</span>
              {s.excused ? <span class="teamchip">Excused</span>
                : s.canExcuse && <button class="btn btn--ghost" disabled={busy} onClick={() => act(() => bookingsApi.excuse(v.id))}>All good, no hard feelings</button>}
            </p>
          )}
          {s.noShow && s.excused && !s.lateCancel && <p class="bookinglate"><span class="teamchip">Excused</span></p>}
          {v.viewer.staff && (s.lateCancel || s.noShow) && !s.excused && <StaffExcuse v={v} side={s} busy={busy} staffAct={staffAct} />}
          <ul class="bookingpeople">
            {s.people.map((p) => (
              <li key={p.steamid}>
                <span>{p.name}</span>
                <span class="muted"> · {ROLE_LABEL[p.role]}{p.status === 'invited' ? ' · invited' : ''}{p.steamid === s.captain.steamid ? ' · captain' : ''}</span>
                {open && v.viewer.manages.includes(s.side) && p.steamid !== s.captain.steamid && (
                  <button class="btn btn--ghost" disabled={busy} onClick={() => act(() => bookingsApi.removePerson(v.id, p.steamid))}>Remove</button>
                )}
              </li>
            ))}
          </ul>
          {open && s.confirmed && v.viewer.manages.includes(s.side) && <AddPerson id={v.id} side={s.side} onDone={setV} />}
        </Panel>
      ))}
      {v.games.length > 0 && (
        <Panel>
          <h3>Games</h3>
          <ul class="bookinggames">
            {v.games.map((g) => {
              const sideA = v.sides.find((s) => s.side === 'a')!;
              const sideB = v.sides.find((s) => s.side === 'b')!;
              const scoreA = g.sideA === 'b' ? g.scoreB : g.scoreA;
              const scoreB = g.sideA === 'b' ? g.scoreA : g.scoreB;
              return (
                <li key={g.matchId}>
                  <span>{campaignName(g.campaign)}</span>
                  <span>{sideA.name} {scoreA} : {scoreB} {sideB.name}</span>
                  <span class="muted">{g.state}</span>
                  <a href={`/match/${g.matchId}`}>View</a>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}
      {actingSide && <Casters v={v} mySide={actingSide} open={open} busy={busy} act={act} />}
      {actingSide && v.review?.open && <ReviewCard v={v} mySide={actingSide} busy={busy} act={act} />}
      {v.reviews && <StaffReviews v={v} />}
      {canPlayGames && (
        <Panel>
          <h3>Next campaign</h3>
          <p class="muted">Picking an earlier playlist campaign moves the playlist back to it.</p>
          <p>
            <select aria-label="Campaign" value={pick} onChange={(e) => setPick((e.target as HTMLSelectElement).value)}>
              <option value="">Next on the playlist</option>
              {campaigns.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
            </select>
            <button class="btn" disabled={busy} onClick={() => act(() => bookingsApi.next(v.id, pick || undefined))}>Play this next</button>
            <button class="btn btn--ghost" disabled={busy} onClick={() => act(() => bookingsApi.stay(v.id))}>Replay last campaign</button>
          </p>
        </Panel>
      )}
      {canManage && (
        <Panel>
          <h3>Booking</h3>
          <p>
            {/* A player may only extend a booking that has actually taken a
                server; staff may extend any open booking, through the admin
                route, since the player route has no staff bypass. */}
            {playerManage && running && (
              <button class="btn btn--ghost" disabled={busy} onClick={() => act(() => bookingsApi.act(v.id, 'extend'))}>Extend {v.extendMinutes} min</button>
            )}
            {staffOnly && (
              <button class="btn btn--ghost" disabled={busy} onClick={() => staffAct(() => adminApi.extendBooking(v.id))}>Extend {v.extendMinutes} min</button>
            )}
            {playerManage && running && <button class="btn btn--ghost" disabled={busy} onClick={() => act(() => bookingsApi.act(v.id, 'end'))}>End now</button>}
            {staffOnly && running && <button class="btn btn--ghost" disabled={busy} onClick={() => staffAct(() => adminApi.endBooking(v.id))}>End now</button>}
            {/* No-show is a side's own call on its opponent; staff clean up
                through Cancel or End instead, never this button. */}
            {playerManage && running && Date.now() >= Date.parse(v.noShowFrom) && (
              <button class="btn btn--ghost" disabled={busy} onClick={() => act(() => bookingsApi.act(v.id, 'no-show'))}>They did not show</button>
            )}
          </p>
          <p>
            <input aria-label="Cancel reason" value={reason} maxLength={300} placeholder="Reason (optional, only the two sides and staff see it)"
              onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
            <button class="btn btn--danger" disabled={busy}
              onClick={() => playerManage ? act(() => bookingsApi.cancel(v.id, reason)) : staffAct(() => adminApi.cancelBooking(v.id, reason))}>
              Cancel booking
            </button>
          </p>
        </Panel>
      )}
    </main>
  );
}

export default Booking;
