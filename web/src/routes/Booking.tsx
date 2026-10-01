import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { adminApi, bookingsApi, teamsApi, type BookingRole, type BookingSide, type BookingView } from '../api';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import type { Session } from '../hooks/useLiveState';
import { localLabel } from '../bookingTime';

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

export function Booking({ id, session }: { id: string; session: Session }) {
  const { route } = useLocation();
  const [v, setV] = useState<BookingView | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');

  const load = () => { bookingsApi.get(id).then(setV, () => setMissing(true)); };
  useEffect(load, [id]);
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

  if (missing || session.kind !== 'active') return <main class="page page--profile bookingpage"><PageHeader title="Booking" /><Empty>No such booking.</Empty></main>;
  if (!v) return null;
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
  const playerManage = open && managesConfirmedSide;
  const staffOnly = open && v.viewer.staff && !playerManage;
  const canManage = playerManage || staffOnly;

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
