import { adminApi } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { campaignName } from '../../format';
import { Empty, Panel } from '../../components/bits';
import { fmtTime, useAction } from './useAction';
import { AdminQueuePanel, AdminServersPanel, Odds, RecentResultsPanel } from './MatchPanels';

export function AdminMatches() {
  const { data, reload } = useFetch((s) => adminApi.overview(s), []);
  const { busy, error, run } = useAction(reload);

  if (!data) return <Panel><p class="muted">Loading...</p></Panel>;

  return (
    <div class="stack">
      {error && <p class="error">{error}</p>}
      <Panel class="panel--table">
        <h3>Open matches</h3>
        {data.open.length === 0 ? <Empty>No match is configuring or live.</Empty> : (
          <div class="table-wrap">
            <table class="admin-table">
              <thead><tr><th>Match</th><th>State</th><th>Server</th><th class="num">Connected</th><th>Odds</th><th>Join</th><th>Live since</th><th /></tr></thead>
              <tbody>
                {data.open.map((m) => (
                  <tr key={m.id}>
                    <td><a href={`/match/${m.id}`}>#{m.id}</a> {campaignName(m.campaign)}</td>
                    <td>{m.state}{m.state === 'configuring' && m.serverId === null ? ' (waiting for a server)' : ''}</td>
                    <td>{m.serverId ?? <span class="muted">none</span>}</td>
                    <td class="num">{m.connected}/{m.rostered}</td>
                    <td><Odds f={m.forecast} /></td>
                    {/* The real game server, not SourceTV. An admin watching a
                        match they are not in has no Connect button anywhere,
                        because the match card is the roster's. */}
                    <td>{m.connect
                      ? <code class="mono">{`password ${m.connect.password}; connect ${m.connect.host}:${m.connect.port}`}</code>
                      : <span class="muted">no server yet</span>}</td>
                    <td>{fmtTime(m.wentLiveAt) || <span class="muted">not yet</span>}</td>
                    <td><button class="chip" disabled={busy}
                      onClick={() => run(() => adminApi.abortMatch(m.id), {
                        title: `Abort match #${m.id}?`,
                        body: 'The server is freed and nothing is rated. The roster and how far it got stay on the match page.',
                        confirmLabel: 'Abort match',
                        danger: true,
                      })}>Abort</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div class="admin-split admin-split--even">
        <AdminServersPanel servers={data.servers} busy={busy} run={run} />
        <AdminQueuePanel queue={data.queue} busy={busy} run={run} />
      </div>

      <RecentResultsPanel data={data} busy={busy} run={run} />
    </div>
  );
}
