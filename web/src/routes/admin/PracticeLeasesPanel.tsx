import { adminApi, api, type AdminPracticeLease } from '../../api';
import { mapName } from '../../format';
import { Panel } from '../../components/bits';
import { useFetch } from '../../hooks/useFetch';
import { KIND_LABEL, leasePath } from '../../practice';
import { useAction } from './useAction';

const STATE_LABEL: Record<AdminPracticeLease['state'], string> = {
  setting_up: 'setting up', ready: 'ready', ending: 'closing', ended: 'closed',
};

/**
 * Practice servers on the live board (src/practiceLeases.ts): which pool
 * boxes are lent out right now, to whom, and an End for each.
 *
 * On the board because a leased box is one the queue cannot have, and the
 * board is where an admin looks when a PUG is waiting for a server. Ending
 * here is the same wind-down the owner's own button runs: goodbye in chat,
 * kick, restart, back to the pool. A PUG that needs a box takes one back on
 * its own after a minute's warning, so this is for the cases that cannot
 * wait for that, or a lease someone forgot. Omits itself when none is open.
 *
 * `nudge` is the board's own refresh counter, so this refetches whenever
 * the board does.
 */
export function PracticeLeasesPanel({ nudge }: { nudge: number }) {
  const leases = useFetch((s) => adminApi.practiceLeases(s), [nudge]);
  const { busy, error, run } = useAction(() => leases.reload());
  const rows = leases.data?.leases ?? [];
  if (rows.length === 0) return null;
  return (
    <Panel class="panel--table">
      <h3>Practice servers</h3>
      <div class="table-wrap">
        <table class="admin-table">
          <thead><tr><th>Server</th><th>Kind</th><th>Started by</th><th>State</th><th>Players</th><th>Map</th><th /></tr></thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id}>
                <td><a href={leasePath(l.id)}>{l.server}</a></td>
                <td>{KIND_LABEL[l.kind]}</td>
                <td><a href={`/player/${l.owner.steamid}`}>{l.owner.name}</a></td>
                <td>
                  <span class={`admin-status admin-status--${l.state === 'ready' ? 'live' : 'reserved'}`}>{STATE_LABEL[l.state]}</span>
                  {l.warnedAt && l.state === 'ready' && <span class="muted"> PUG waiting, closing</span>}
                </td>
                <td class="num">{l.humans}</td>
                <td class="muted">{l.map ? mapName(l.map) : ''}</td>
                <td>{(l.state === 'setting_up' || l.state === 'ready') && (
                  <button class="chip" type="button" disabled={busy}
                    onClick={() => run(() => api.endPractice(l.id), {
                      title: `Close ${l.owner.name}'s ${KIND_LABEL[l.kind].toLowerCase()} on ${l.server}?`,
                      body: 'Everyone on it is kicked, and the server restarts and goes back to the PUG pool.',
                      confirmLabel: 'Close it',
                      danger: true,
                    })}>End</button>
                )}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <p class="error">{error}</p>}
    </Panel>
  );
}
