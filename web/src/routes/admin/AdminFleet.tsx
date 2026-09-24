import { useState } from 'preact/hooks';
import { adminApi, type FleetCellView, type FleetRowView, type FleetSig } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel } from '../../components/bits';
import { fmtTime, useAction } from './useAction';

const AREAS = [['all', 'Everything'], ['plugins', 'Plugins'], ['configs', 'Configs'], ['data', 'Data'], ['gamedata', 'Gamedata'],
  ['extensions', 'Extensions'], ['stripper', 'Stripper'], ['other', 'Everything else']] as const;
const short = (s: FleetSig | null) => (s ? `${s.size} · ${s.sha256 ? s.sha256.slice(0, 8) : 'too large'}` : '');
const fileName = (p: string) => p.split('/').pop() ?? p;
const LABEL: Record<FleetCellView['label'], string> = { repo: 'repo', base: 'base', neither: 'neither', missing: 'missing', unread: 'not read yet' };

/** Admin > Setup > Fleet: what every game server has, file by file, against
 *  the deploy repo and the Rotoblin base. Read-only. */
export function AdminFleet() {
  const fleet = useFetch((s) => adminApi.fleet(s), []);
  const { busy, error, run } = useAction(fleet.reload);
  const [diffOnly, setDiffOnly] = useState(true);
  const [area, setArea] = useState<string>('all');
  if (fleet.error) return <Empty>Could not load the fleet view.</Empty>;
  const d = fleet.data;
  if (!d) return <p class="muted">Loading...</p>;

  const differing = d.rows.filter((r) => r.differs);
  const summary = differing.length === 0
    ? 'No differences.'
    : `${differing.length} difference${differing.length === 1 ? '' : 's'}: ${differing.slice(0, 5).map((r) =>
      `${fileName(r.path)} (${d.boxes.filter((b) => r.cells[b.serverId]?.highlight).map((b) => b.name).join(', ')})`).join('; ')}${differing.length > 5 ? '; ...' : ''}`;
  const rows = d.rows.filter((r) => (!diffOnly || r.differs) && (area === 'all' || r.area === area));

  const cellText = (r: FleetRowView, c: FleetCellView | undefined) => {
    if (!c) return '';
    if (c.label === 'unread' || c.label === 'missing') return LABEL[c.label];
    const tag = r.patchedEverywhere ? 'base, patched on all boxes' : LABEL[c.label];
    return `${short(c.sig)} (${tag}${c.sizeOnly ? ', size only' : ''})`;
  };

  return (
    <div class="stack">
      <Panel>
        <h3>Fleet</h3>
        <p class="muted">
          Repo: {d.repo ? `${d.repo.label}, pushed ${fmtTime(d.repo.at)}` : 'no repo manifest yet (run scripts/push-manifest.ts)'}
          {' · '}Base: {d.base ? d.base.label : 'no base manifest yet'}
        </p>
        {error && <p class="error">{error}</p>}
        <div class="fleet-boxes">
          {d.boxes.map((b) => (
            <div key={b.serverId} class="fleet-box">
              <strong>{b.name}</strong>{' '}
              <span class="muted">{b.readAt ? `read ${fmtTime(b.readAt)}` : 'never read'}</span>
              {b.error && <span class="error"> · last attempt failed: {b.error}</span>}
              {' '}
              <button class="btn btn--ghost btn--sm" type="button" disabled={busy || b.pending || !b.enabled}
                aria-label={`Check ${b.name} now`} onClick={() => void run(() => adminApi.fleetCheck({ serverId: b.serverId }))}>
                {b.pending ? 'Queued' : 'Check now'}
              </button>
            </div>
          ))}
          <button class="btn" type="button" disabled={busy} onClick={() => void run(() => adminApi.fleetCheck({ all: true }))}>Check all</button>
        </div>
        <p>{summary}</p>
      </Panel>
      <Panel class="panel--table">
        <div class="admin-form">
          <label><input type="checkbox" checked={diffOnly} aria-label="Differences only"
            onChange={() => setDiffOnly(!diffOnly)} /> Differences only</label>
          <label>Area{' '}
            <select value={area} aria-label="Area" onChange={(e) => setArea((e.target as HTMLSelectElement).value)}>
              {AREAS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
        </div>
        {rows.length === 0 ? <p class="muted">Nothing to show.</p> : (
          <div class="table-wrap">
            <table class="admin-table fleet-table">
              <thead><tr><th>File</th><th>Repo</th><th>Base</th>{d.boxes.map((b) => <th key={b.serverId}>{b.name}</th>)}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.path}>
                    <td><code>{r.path}</code></td>
                    <td>{short(r.repo)}</td>
                    <td>{short(r.base)}</td>
                    {d.boxes.map((b) => {
                      const c = r.cells[b.serverId];
                      return <td key={b.serverId} class={c?.highlight ? 'admin-warn' : ''}>{cellText(r, c)}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
