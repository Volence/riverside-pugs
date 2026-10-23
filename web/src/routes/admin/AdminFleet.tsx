import { useState } from 'preact/hooks';
import { adminApi, type FleetCellView, type FleetRowView, type FleetSig } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel } from '../../components/bits';
import { fmtTime, useAction } from './useAction';
import { fmtAgo } from '../../format';

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
  const unreadBoxes = d.boxes.filter((b) => b.enabled && b.readAt === null);
  const quiet = differing.length === 0
    ? unreadBoxes.length === d.boxes.filter((b) => b.enabled).length
      ? 'No box has been read yet: Check all to compare them.'
      : unreadBoxes.length > 0
        ? `No differences among the boxes read so far (not read yet: ${unreadBoxes.map((b) => b.name).join(', ')}).`
        : 'No differences.'
    : null;
  const rows = d.rows.filter((r) => (!diffOnly || r.differs) && (area === 'all' || r.area === area));
  // With neither reference pushed, both columns would be empty on every row.
  const refs = d.repo !== null || d.base !== null;

  const cellLines = (r: FleetRowView, c: FleetCellView | undefined): [string, string] => {
    if (!c) return ['', ''];
    if (c.label === 'unread') return ['', LABEL.unread];
    if (c.label === 'missing') return ['', r.removedEverywhere ? 'removed on all boxes' : LABEL.missing];
    const tag = r.perBox ? 'per box' : r.patchedEverywhere ? 'base, patched on all boxes' : LABEL[c.label];
    return [short(c.sig), `${tag}${c.origin != null ? `, release ${c.origin}` : ''}${c.sizeOnly ? ', size only' : ''}`];
  };

  return (
    <div class="stack">
      <Panel>
        <div class="fleet-head">
          <div>
            <h3>Fleet</h3>
            <p class="muted">
              Repo: {d.repo ? `${d.repo.label}, pushed ${fmtTime(d.repo.at)}` : 'no repo manifest yet (run scripts/push-manifest.ts)'}
              {' · '}Base: {d.base ? d.base.label : 'no base manifest yet'}
            </p>
          </div>
          <button class="btn" type="button" disabled={busy} onClick={() => void run(() => adminApi.fleetCheck({ all: true }))}>Check all</button>
        </div>
        {error && <p class="error">{error}</p>}
        <ul class="fleet-boxes">
          {d.boxes.map((b) => (
            <li key={b.serverId} class={`fleet-box${b.error ? ' has-error' : ''}${b.enabled ? '' : ' is-off'}`}>
              <span class="fleet-box__name">{b.name}</span>
              <span class="fleet-box__when" title={b.readAt ? fmtTime(b.readAt) : undefined}>
                {b.readAt ? `read ${fmtAgo(b.readAt)}` : 'never read'}
              </span>
              {b.error && <span class="error">last attempt failed: {b.error}</span>}
              <button class="chip" type="button" disabled={busy || b.pending || !b.enabled}
                aria-label={`Check ${b.name} now`} onClick={() => void run(() => adminApi.fleetCheck({ serverId: b.serverId }))}>
                {b.pending ? 'Queued' : 'Check now'}
              </button>
            </li>
          ))}
        </ul>
        {quiet !== null ? <p class="fleet-quiet">{quiet}</p> : (
          <>
            <h4>{differing.length} difference{differing.length === 1 ? '' : 's'}</h4>
            <ul class="fleet-diffs">
              {differing.slice(0, 8).map((r) => (
                <li key={r.path} title={r.path}>
                  <span class="fleet-diffs__file">{fileName(r.path)}</span>
                  <span class="muted">{d.boxes.filter((b) => r.cells[b.serverId]?.highlight).map((b) => b.name).join(', ')}</span>
                </li>
              ))}
              {differing.length > 8 && <li class="muted">and {differing.length - 8} more in the table below</li>}
            </ul>
          </>
        )}
      </Panel>
      <Panel class="panel--table">
        <div class="fleet-tools">
          <label><input type="checkbox" checked={diffOnly} aria-label="Differences only"
            onChange={() => setDiffOnly(!diffOnly)} /> Differences only</label>
          <label>Area{' '}
            <select value={area} aria-label="Area" onChange={(e) => setArea((e.target as HTMLSelectElement).value)}>
              {AREAS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <span class="muted">{rows.length} file{rows.length === 1 ? '' : 's'}</span>
        </div>
        {rows.length === 0 ? <p class="muted">Nothing to show.</p> : (
          <div class="table-wrap">
            <table class="admin-table fleet-table">
              <thead><tr><th>File</th>{refs && <><th>Repo</th><th>Base</th></>}{d.boxes.map((b) => <th key={b.serverId}>{b.name}</th>)}</tr></thead>
              <tbody>
                {rows.map((r) => {
                  const cut = r.path.lastIndexOf('/');
                  return (
                    <tr key={r.path}>
                      <td class="fleet-file" title={r.path}>
                        <span class="fleet-file__name">{fileName(r.path)}</span>
                        <span class="fleet-file__dir">{cut > 0 ? r.path.slice(0, cut) : ''}</span>
                      </td>
                      {refs && <><td class="fleet-sig">{short(r.repo)}</td><td class="fleet-sig">{short(r.base)}</td></>}
                      {d.boxes.map((b) => {
                        const c = r.cells[b.serverId];
                        const [sig, tag] = cellLines(r, c);
                        return (
                          <td key={b.serverId} class={`fleet-cell${c?.highlight ? ' fleet-cell--diff' : ''}`}>
                            {sig && <span class="fleet-sig">{sig}</span>}
                            {tag && <span class="fleet-cell__tag">{tag}</span>}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
