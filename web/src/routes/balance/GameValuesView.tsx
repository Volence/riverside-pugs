import type { GameValues, GameValueView } from '../../api';
import { Panel } from '../../components/bits';

const fmtDate = (at: string) => {
  const t = Date.parse(`${at.replace(' ', 'T')}Z`);
  return Number.isNaN(t) ? at : new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

function valueCell(v: GameValueView) {
  if (v.status === 'hidden') return <span class="muted">{v.note ?? 'set by a plugin'}</span>;
  if (v.status === 'not_reported') return <span class="muted">not reported yet</span>;
  return <>{v.value}{v.unit && <span class="muted"> {v.unit}</span>}</>;
}

function changeCell(v: GameValueView, admin: boolean) {
  if (!v.lastChange) return <span class="muted">unchanged since tracking began</span>;
  const date = fmtDate(v.lastChange.at);
  const p = v.lastChange.patch;
  if (!p) return date;
  return admin ? <>{p.name}, {date}</> : <><a href={`/balance#patch-${p.id}`}>{p.name}</a>, {date}</>;
}

/** The Game values tables, one panel per group, with that group's rules.
 *  Shared by the public page and the admin preview (which also shows draft
 *  and inactive rules, tagged). */
export function GameValuesView({ data, admin }: { data: GameValues; admin: boolean }) {
  return (
    <div class="stack">
      {data.groups.map((g) => (
        <Panel key={g.id} class="panel--table">
          <h2 class="values-group">{g.label}</h2>
          {g.values.length > 0 && (
            <div class="table-wrap">
              <table class="admin-table values-table">
                <thead><tr><th>Setting</th><th>Ours</th><th>Vanilla</th><th>Last changed</th></tr></thead>
                <tbody>
                  {g.values.map((v) => (
                    <tr key={v.id} class={v.differsFromVanilla ? 'values-differs' : ''}>
                      <td>{v.label}{v.note && v.status !== 'hidden' && <div class="muted values-note">{v.note}</div>}</td>
                      <td>{valueCell(v)}</td>
                      <td>{v.vanilla ?? <span class="muted">-</span>}</td>
                      <td>{changeCell(v, admin)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {g.rules.length > 0 && (
            <ul class="values-rules">
              {g.rules.map((r) => (
                <li key={r.id} class={r.active ? '' : 'muted'}>
                  {r.text}
                  {admin && r.draft && <> <span class="admin-tag">draft rule</span></>}
                  {admin && !r.active && <> <span class="admin-tag">not active</span></>}
                  {admin && (r.missing?.length ?? 0) > 0 && <> <span class="admin-tag">waiting for {r.missing!.join(', ')}</span></>}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      ))}
    </div>
  );
}
