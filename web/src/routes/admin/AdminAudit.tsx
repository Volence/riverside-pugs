import { adminApi } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel } from '../../components/bits';
import { fmtTime } from './useAction';

export function AdminAudit() {
  const { data } = useFetch((s) => adminApi.audit(s), []);
  return (
    <Panel class="panel--table">
      {data && data.actions.length === 0 && <Empty>Nothing yet.</Empty>}
      {data && data.actions.length > 0 && (
        <div class="table-wrap">
          <table class="admin-table">
            <thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
            <tbody>
              {data.actions.map((a) => (
                <tr key={a.id}>
                  <td>{fmtTime(a.createdAt)}</td>
                  <td>{a.adminName ?? a.adminId}</td>
                  <td>{a.action.replace(/_/g, ' ')}</td>
                  <td>{a.targetName ?? a.target}</td>
                  <td class="muted mono">{Object.keys(a.detail).length ? JSON.stringify(a.detail) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
