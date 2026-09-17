import { useState } from 'preact/hooks';
import { adminApi } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { campaignName } from '../../format';
import { Empty, Panel, Tabs } from '../../components/bits';
import { fmtTime, useAction } from './useAction';

export function AdminReports() {
  const [status, setStatus] = useState('open');
  const { data, reload } = useFetch((s) => adminApi.reports(status, s), [status]);
  const { busy, error, run } = useAction(reload);
  const [notes, setNotes] = useState<Record<number, string>>({});

  return (
    <Panel>
      <Tabs active={status} onSelect={setStatus}
        tabs={[{ key: 'open', label: 'Open' }, { key: 'resolved', label: 'Resolved' }, { key: 'dismissed', label: 'Dismissed' }]} />
      {error && <p class="error">{error}</p>}
      {data && data.reports.length === 0 && <Empty>No {status} reports.</Empty>}
      <ul class="admin-reports">
        {data?.reports.map((r) => (
          <li key={r.id} class="admin-report">
            <p>
              <strong>{r.targetName ?? r.targetId}</strong> reported for <strong>{r.category}</strong> by {r.reporterName ?? r.reporterId}
              {' '}in <a href={`/match/${r.matchId}`}>#{r.matchId}{r.campaign ? ` ${campaignName(r.campaign)}` : ''}</a>
              <span class="muted"> · {fmtTime(r.createdAt)}</span>
            </p>
            {r.text && <blockquote>{r.text}</blockquote>}
            {r.status === 'open' ? (
              <div class="admin-form">
                <input value={notes[r.id] ?? ''} placeholder="Resolution note" aria-label="Resolution note"
                  onInput={(e) => setNotes({ ...notes, [r.id]: (e.target as HTMLInputElement).value })} />
                <button class="btn" disabled={busy} onClick={() => run(() => adminApi.resolveReport(r.id, 'resolved', notes[r.id] ?? ''))}>Resolve</button>
                <button class="chip" disabled={busy} onClick={() => run(() => adminApi.resolveReport(r.id, 'dismissed', notes[r.id] ?? ''))}>Dismiss</button>
              </div>
            ) : (
              <p class="muted">{r.status} by {r.resolvedBy} {fmtTime(r.resolvedAt)}{r.resolutionNote ? `: ${r.resolutionNote}` : ''}</p>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
