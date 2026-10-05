import { useState } from 'preact/hooks';
import { appealStaffApi } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel } from '../../components/bits';
import { fmtTime } from './useAction';
import { appealUrl } from './adminRoutes';

const STATE: Record<string, string> = {
  open: 'waiting', asked: 'question asked', answered: 'answered', accepted: 'accepted', shortened: 'shortened',
  denied: 'denied', auto_denied: 'denied (slur)', lapsed: 'no answer', moot: 'ban ended',
};

/** Appeals waiting for staff, oldest first; or settled ones, newest first. */
export function PeopleAppeals() {
  const [which, setWhich] = useState<'open' | 'closed'>('open');
  const { data, error } = useFetch((s) => appealStaffApi.list(which, s), [which]);
  return (
    <Panel class="panel--table">
      <h3>Appeals</h3>
      <p class="muted">
        One appeal per ban at a time. You may ask one question, then accept, shorten or deny. The player only ever
        sees a fixed sentence for the outcome. <a href="/admin/people/guide#appeals">How appeals work</a>
      </p>
      <p>
        <button class={`chip${which === 'open' ? ' is-on' : ''}`} onClick={() => setWhich('open')}>Waiting</button>{' '}
        <button class={`chip${which === 'closed' ? ' is-on' : ''}`} onClick={() => setWhich('closed')}>Settled</button>
      </p>
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
                  <td>{a.name}</td>
                  <td>{a.about}</td>
                  <td>{STATE[a.state]}</td>
                  <td class="muted">{fmtTime(a.filedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
