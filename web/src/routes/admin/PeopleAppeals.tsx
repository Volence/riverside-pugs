import { useState } from 'preact/hooks';
import { appealStaffApi } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel, Tabs } from '../../components/bits';
import { fmtTime } from './useAction';
import { fmtAgo } from '../../format';
import { appealUrl } from './adminRoutes';

const STATE: Record<string, string> = {
  open: 'waiting', asked: 'waiting on player', answered: 'player replied', accepted: 'accepted', shortened: 'shortened',
  denied: 'denied', auto_denied: 'denied (slur)', lapsed: 'no answer', moot: 'ban ended',
};

/** How each state reads at a glance: ours to act on, theirs, or settled
 *  for or against them. */
const TONE: Record<string, 'act' | 'wait' | 'won' | 'lost' | 'quiet'> = {
  open: 'act', answered: 'act', asked: 'wait', accepted: 'won', shortened: 'won',
  denied: 'lost', auto_denied: 'lost', lapsed: 'quiet', moot: 'quiet',
};

/** Appeals waiting for staff, oldest first; or settled ones, newest first. */
export function PeopleAppeals() {
  const [which, setWhich] = useState<'open' | 'closed'>('open');
  const { data, error } = useFetch((s) => appealStaffApi.list(which, s), [which]);
  return (
    <Panel class="panel--table">
      <h3>Appeals</h3>
      <p class="muted">
        One appeal per ban at a time. Write back and forth with the player as needed, then accept, shorten or deny.
        The player sees you as "Staff" and the outcome as a fixed sentence. <a href="/admin/people/guide#appeals">How appeals work</a>
      </p>
      <Tabs active={which} onSelect={(k) => setWhich(k as typeof which)} label="Appeals"
        tabs={[{ key: 'open', label: 'Waiting' }, { key: 'closed', label: 'Settled' }]} />
      {error && <Empty>Could not load the appeals.</Empty>}
      {data && data.appeals.length === 0 && <Empty>{which === 'open' ? 'Nothing waiting.' : 'No settled appeals yet.'}</Empty>}
      {data && data.appeals.length > 0 && (
        <div class="table-wrap">
          <table class="admin-table">
            <thead><tr><th>#</th><th>Who</th><th>About</th><th>State</th><th>Filed</th></tr></thead>
            <tbody>
              {data.appeals.map((a) => (
                <tr key={a.id}>
                  <td><a href={appealUrl(a.id)}>#{a.id}</a></td>
                  <td><strong>{a.name}</strong></td>
                  <td>{a.about}</td>
                  <td><span class={`appeal-state appeal-state--${TONE[a.state] ?? 'quiet'}`}>{STATE[a.state]}</span></td>
                  <td class="muted" title={fmtTime(a.filedAt)}>{fmtAgo(a.filedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
