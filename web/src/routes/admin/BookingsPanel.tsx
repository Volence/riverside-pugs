import { adminApi, type AdminBookingRow } from '../../api';
import { Panel } from '../../components/bits';
import { useFetch } from '../../hooks/useFetch';
import { localLabel } from '../../bookingTime';
import { useAction } from './useAction';

const STATE_LABEL: Record<AdminBookingRow['state'], string> = {
  scheduled: 'booked', held: 'server taken', setup: 'setting up', ready: 'ready', active: 'playing',
  ended: 'over', cancelled: 'cancelled', no_show: 'no-show',
};

/**
 * Booked servers on the live board (plan 4a; the spec's "calendar of bookings
 * on the admin Live desk"): every open booking and those that ended in the
 * last day, soonest first, with the box each one holds and the most people
 * of each side seen on it. Cancel here counts against neither side. Omits
 * itself when there is nothing to show.
 */
export function BookingsPanel({ nudge }: { nudge: number }) {
  const list = useFetch((s) => adminApi.bookings(s), [nudge]);
  const { busy, error, run } = useAction(() => list.reload());
  const rows = list.data?.bookings ?? [];
  if (rows.length === 0) return null;
  return (
    <Panel class="panel--table">
      <h3>Booked servers</h3>
      {error && <p class="error" role="alert">{error}</p>}
      <div class="table-wrap">
        <table class="admin-table">
          <thead><tr><th>Booking</th><th>When</th><th>State</th><th>Server</th><th>On it (peak)</th><th /></tr></thead>
          <tbody>
            {rows.map((b) => {
              const open = !b.ending && ['scheduled', 'held', 'setup', 'ready', 'active'].includes(b.state);
              const running = open && (b.state === 'ready' || b.state === 'active');
              return (
                <tr key={b.id}>
                  <td>
                    <a href={`/booking/${b.id}`}>{b.aName} vs {b.bName}</a>
                    {b.toxic.a && <span class="teamchip teamchip--toxic" title={`${b.aName}: repeated toxic tags`}>Toxic tags</span>}
                    {b.toxic.b && <span class="teamchip teamchip--toxic" title={`${b.bName}: repeated toxic tags`}>Toxic tags</span>}
                  </td>
                  <td>{localLabel(b.startsAt)} to {localLabel(b.endsAt)}</td>
                  <td>{STATE_LABEL[b.state]}{b.endReason ? ` (${b.endReason})` : ''}</td>
                  <td>{b.server ?? ''}</td>
                  <td>{b.peak.a} / {b.peak.b}</td>
                  <td>
                    {open && <button class="btn btn--ghost" disabled={busy}
                      onClick={() => run(() => adminApi.cancelBooking(b.id, ''), { title: `Cancel ${b.aName} vs ${b.bName}?`, body: 'Both sides are told. It counts against neither side.', confirmLabel: 'Cancel booking', danger: true })}>Cancel</button>}
                    {open && <button class="btn btn--ghost" disabled={busy} onClick={() => run(() => adminApi.extendBooking(b.id))}>Extend</button>}
                    {running && <button class="btn btn--ghost" disabled={busy}
                      onClick={() => run(() => adminApi.endBooking(b.id), { title: `End ${b.aName} vs ${b.bName} now?`, body: 'Everyone on the server is kicked and the box restarts.', confirmLabel: 'End now', danger: true })}>End</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
