import { adminApi, type AdminBookingPriority, type AdminBookingRow } from '../../api';
import { Panel } from '../../components/bits';
import { useFetch } from '../../hooks/useFetch';
import { localLabel } from '../../bookingTime';
import { eventAdminUrl } from './adminRoutes';
import { useAction, type Run } from './useAction';

/** Mirrors STATE_LABEL in routes/Bookings.tsx, the chip a captain sees. */
const STATE_LABEL: Record<AdminBookingRow['state'], string> = {
  scheduled: 'Booked', held: 'Server taken', setup: 'Setting up', ready: 'Ready', active: 'Playing',
  ended: 'Over', cancelled: 'Cancelled', no_show: 'No-show',
};

const PURPOSE_LABEL: Record<AdminBookingRow['purpose'], string> = { tournament: 'Tournament match', scrim: 'Scrim' };

/** Every end_reason the server writes (src/bookings close and closeBooking
 *  callers, and the runner's endNow), in words. */
const END_REASON_TEXT: Record<string, string> = {
  time: 'time ran out', idle: 'nobody was on it', done: 'played out', captain: 'a captain ended it', staff: 'staff ended it',
  cancelled: 'a side cancelled', declined: 'declined', bumped: 'bumped by a match', no_show: 'a side did not show',
  unconfirmed: 'never confirmed', setup_failed: 'setup failed', no_server: 'no free server', server_lost: 'the server went down',
};

/** Why a booking ended, in words; an unknown code with its underscores as spaces. */
export function endReasonText(reason: string): string {
  return END_REASON_TEXT[reason] ?? reason.replace(/_/g, ' ');
}

/** The state cell: a chip, then why it ended (a bumped scrim says what bumped
 *  it, server priority Ruling 9). A no-show's reason only repeats the chip. */
function StateCell({ b }: { b: AdminBookingRow }) {
  const why = b.endReason && !(b.state === 'no_show' && b.endReason === 'no_show') ? endReasonText(b.endReason) : null;
  return (
    <>
      <span class={`teamchip teamchip--${b.state}`}>{STATE_LABEL[b.state] ?? b.state}</span>
      {why && <>{' '}<span class="muted">{why}</span></>}
    </>
  );
}

/** How many of the scrim cap's servers scrims hold. The cap is per region:
 *  with one region (every box today is NA) the line names none, as nothing
 *  else on the site shows a region while only one exists; with more, each
 *  region gets its own count. */
const scrimLine = (p: AdminBookingPriority): string => {
  const of = `of ${p.scrimMax} server${p.scrimMax === 1 ? '' : 's'}`;
  const [first, ...rest] = p.regions;
  if (!first) return `Scrims hold 0 ${of} they may hold at once`;
  if (rest.length === 0) return `Scrims hold ${first.scrimsHolding} ${of} they may hold at once`;
  return `Scrims hold ${first.scrimsHolding} ${of} they may hold at once in ${first.region.toUpperCase()}, `
    + rest.map((r) => `${r.scrimsHolding} of ${p.scrimMax} in ${r.region.toUpperCase()}`).join(', ');
};

/**
 * Booked servers on the live board (plan 4a; the spec's "calendar of bookings
 * on the admin Live desk"): every open booking and those that ended in the
 * last day, soonest first, with the box each one holds and the most people
 * of each side seen on it. Cancel here counts against neither side. Omits
 * itself when there is nothing to show.
 */
const isOpen = (b: AdminBookingRow): boolean => !b.ending && ['scheduled', 'held', 'setup', 'ready', 'active'].includes(b.state);

export function BookingsPanel({ nudge }: { nudge: number }) {
  const list = useFetch((s) => adminApi.bookings(s), [nudge]);
  const { busy, error, run } = useAction(() => list.reload());
  const rows = list.data?.bookings ?? [];
  const priority = list.data?.priority ?? null;
  if (rows.length === 0) return null;
  // The board's top is for what is happening. Bookings that already ended
  // (kept for a day) fold into one line instead of a panel of old rows.
  const open = rows.filter(isOpen);
  const done = rows.filter((b) => !isOpen(b));
  const table = (list: AdminBookingRow[]) => (
    <div class="table-wrap">
      <table class="admin-table bookings-table">
        <thead><tr><th>Booking</th><th>When</th><th>State</th><th>Server</th><th>On it (peak)</th><th /></tr></thead>
        <tbody>
          {list.map((b) => <BookingRow key={b.id} b={b} busy={busy} run={run} />)}
        </tbody>
      </table>
    </div>
  );
  return (
    <Panel class={`panel--table bookings${open.length === 0 ? ' bookings--quiet' : ''}`}>
      {open.length > 0 && (
        <>
          <h3>Booked servers</h3>
          {error && <p class="error" role="alert">{error}</p>}
          {table(open)}
        </>
      )}
      {done.length > 0 && (
        <details class="bookings__done">
          <summary>
            {open.length === 0 && <span class="bookings__label">Booked servers</span>}
            {done.length} finished in the last day{open.length === 0 ? ', none open' : ''}
          </summary>
          {open.length === 0 && error && <p class="error" role="alert">{error}</p>}
          {table(done)}
        </details>
      )}
      {priority && open.length > 0 && (
        <details class="bookings__rules">
          <summary>How servers are shared</summary>
          <p class="muted" data-testid="booking-priority">
            Priority: Match, then Scrim, then PUG, then practice and side games. {scrimLine(priority)}; {priority.pugReserve} always left for PUGs. A match with no free server bumps a scrim that has not started.
          </p>
        </details>
      )}
    </Panel>
  );
}

function BookingRow({ b, busy, run }: { b: AdminBookingRow; busy: boolean; run: Run }) {
  const open = isOpen(b);
  const running = open && (b.state === 'ready' || b.state === 'active');
  return (
    <tr>
      <td>
        <span class={`teamchip teamchip--${b.purpose}`}>{PURPOSE_LABEL[b.purpose]}</span>{' '}
        <a href={`/booking/${b.id}`}>{b.aName} vs {b.bName}</a>
        {b.toxic.a && <>{' '}<span class="teamchip teamchip--toxic" title={`${b.aName}: repeated toxic tags`}>Toxic tags</span></>}
        {b.toxic.b && <>{' '}<span class="teamchip teamchip--toxic" title={`${b.bName}: repeated toxic tags`}>Toxic tags</span></>}
      </td>
      {/* A tournament match has no booked end: it runs until its result. */}
      <td>{b.purpose === 'tournament' ? <>From {localLabel(b.startsAt)}</> : <>{localLabel(b.startsAt)} to {localLabel(b.endsAt)}</>}</td>
      <td><StateCell b={b} /></td>
      <td>{b.server ?? ''}</td>
      <td>{b.peak.a} / {b.peak.b}</td>
      <td>
        {b.purpose === 'tournament' ? (
          // The event runs a tournament match: hold, reset, move
          // server and results live on its desk, not here.
          open && b.eventId !== null && <a class="btn btn--ghost btn--sm" href={eventAdminUrl(b.eventId)}>Event desk</a>
        ) : (
          <>
            {open && <button class="btn btn--ghost btn--sm" disabled={busy}
              onClick={() => run(() => adminApi.cancelBooking(b.id, ''), { title: `Cancel ${b.aName} vs ${b.bName}?`, body: 'Both sides are told. It counts against neither side.', confirmLabel: 'Cancel booking', danger: true })}>Cancel</button>}
            {open && <button class="btn btn--ghost btn--sm" disabled={busy} onClick={() => run(() => adminApi.extendBooking(b.id))}>+1 campaign</button>}
            {running && <button class="btn btn--ghost btn--sm" disabled={busy}
              onClick={() => run(() => adminApi.endBooking(b.id), { title: `End ${b.aName} vs ${b.bName} now?`, body: 'Everyone on the server is kicked and the box restarts.', confirmLabel: 'End now', danger: true })}>End</button>}
          </>
        )}
      </td>
    </tr>
  );
}
