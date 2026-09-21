import { api } from '../api';
import { useFetch } from '../hooks/useFetch';
import { Panel } from './bits';
import { fmtDate } from '../format';

/**
 * What you have reported, and whether the ticket is still open. Nothing about
 * the outcome: that stays with the moderators. This is also the fallback for
 * people whose Discord DMs are closed, who never get the closing message.
 */
export function MyReports() {
  const { data } = useFetch((s) => api.myReports(s), []);
  if (!data || data.reports.length === 0) return null;
  return (
    <Panel>
      <h3>Your reports</h3>
      <ul class="admin-list">
        {data.reports.map((r) => (
          <li key={r.id}>
            <a href={`/player/${r.targetId}`}>{r.targetName ?? r.targetId}</a> · {r.category}
            {r.matchId !== null && <> · <a href={`/match/${r.matchId}`}>#{r.matchId}</a></>}
            {' '}· {fmtDate(r.createdAt)} · <span class="muted">{r.status === 'open' ? 'open' : 'closed, thank you'}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
