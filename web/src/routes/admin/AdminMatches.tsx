import { useState } from 'preact/hooks';
import { adminApi, type AdminOverview } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { campaignName } from '../../format';
import { Empty, Panel } from '../../components/bits';
import { fmtTime, useAction } from './useAction';

export function AdminMatches() {
  const { data, reload } = useFetch((s) => adminApi.overview(s), []);
  const { busy, error, run } = useAction(reload);
  const [voiding, setVoiding] = useState<number | null>(null);
  const [reason, setReason] = useState('');

  if (!data) return <Panel><p class="muted">Loading...</p></Panel>;

  return (
    <div class="stack">
      {error && <p class="error">{error}</p>}
      <Panel class="panel--table">
        <h3>Open matches</h3>
        {data.open.length === 0 ? <Empty>No match is configuring or live.</Empty> : (
          <div class="table-wrap">
            <table class="admin-table">
              <thead><tr><th>Match</th><th>State</th><th>Server</th><th class="num">Connected</th><th>Live since</th><th /></tr></thead>
              <tbody>
                {data.open.map((m) => (
                  <tr key={m.id}>
                    <td><a href={`/match/${m.id}`}>#{m.id}</a> {campaignName(m.campaign)}</td>
                    <td>{m.state}{m.state === 'configuring' && m.serverId === null ? ' (waiting for a server)' : ''}</td>
                    <td>{m.serverId ?? <span class="muted">none</span>}</td>
                    <td class="num">{m.connected}/{m.rostered}</td>
                    <td>{fmtTime(m.wentLiveAt) || <span class="muted">not yet</span>}</td>
                    <td><button class="chip" disabled={busy}
                      onClick={() => run(() => adminApi.abortMatch(m.id), `Abort match #${m.id}? The server is freed and nothing is rated.`)}>Abort</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div class="admin-split admin-split--even">
        <Panel class="panel--table">
          <h3>Servers</h3>
          {data.servers.length === 0 ? <Empty>No servers.</Empty> : (
            <table class="admin-table">
              <thead><tr><th>Server</th><th>Status</th><th>In pool</th><th>SourceTV</th><th /></tr></thead>
              <tbody>
                {data.servers.map((s) => (
                  <tr key={s.id} class={s.enabled === 1 ? undefined : 'is-dim'}>
                    <td>{s.name} <span class="muted mono">{s.host}:{s.port}</span></td>
                    <td><span class={`admin-status admin-status--${s.status}`}>{s.status}</span></td>
                    {/* Eligibility, not lifecycle. A disabled box keeps whatever
                        status it has and simply stops being claimed, so a match
                        already on it plays out untouched. */}
                    <td>
                      {s.enabled === 1 ? (
                        <button class="chip" disabled={busy}
                          onClick={() => run(
                            () => adminApi.serverEnabled(s.id, false),
                            `Take ${s.name} out of the pool? Any match already on it finishes normally; it just will not be picked for the next one.`,
                          )}>Take out</button>
                      ) : (
                        <>
                          <span class="admin-status admin-status--offline">out of pool</span>
                          <button class="chip" disabled={busy}
                            onClick={() => run(() => adminApi.serverEnabled(s.id, true))}>Put back</button>
                        </>
                      )}
                    </td>
                    <td><SourceTvCell server={s} busy={busy} run={run} /></td>
                    <td>{s.status !== 'idle' && (
                      <button class="chip" disabled={busy}
                        onClick={() => run(() => adminApi.serverIdle(s.id), `Set ${s.name} idle? Only do this when no match is really running on it.`)}>Set idle</button>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <Panel class="panel--table">
          <h3>Queue</h3>
          {data.queue.length === 0 ? <Empty>The queue is empty.</Empty> : (
            <table class="admin-table">
              <tbody>
                {data.queue.map((p) => (
                  <tr key={p.steamid}>
                    <td>{p.name}</td>
                    <td><button class="chip" disabled={busy} onClick={() => run(() => adminApi.queueRemove(p.steamid))}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <Panel class="panel--table">
        <h3>Recent results</h3>
        <p class="muted">Voiding removes a match from every stat and rebuilds the season's ratings without it. It cannot be undone from here.</p>
        {data.recent.length === 0 ? <Empty>No completed matches.</Empty> : (
          <div class="table-wrap">
            <table class="admin-table">
              <thead><tr><th>Match</th><th class="num">Score</th><th>Ended</th><th /></tr></thead>
              <tbody>
                {data.recent.map((m) => (
                  <tr key={m.id}>
                    <td><a href={`/match/${m.id}`}>#{m.id}</a> {campaignName(m.campaign)}</td>
                    <td class="num">{m.teamAScore} - {m.teamBScore}</td>
                    <td>{fmtTime(m.endedAt)}</td>
                    <td>
                      {voiding === m.id ? (
                        <form class="admin-form" onSubmit={(e) => {
                          e.preventDefault();
                          void run(() => adminApi.voidMatch(m.id, reason), `Void match #${m.id}? Ratings for the whole season are recomputed.`)
                            .then(() => { setVoiding(null); setReason(''); });
                        }}>
                          <input value={reason} placeholder="Why" aria-label="Void reason" onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
                          <button class="btn" type="submit" disabled={busy || !reason.trim()}>Void</button>
                          <button class="chip" type="button" onClick={() => setVoiding(null)}>Cancel</button>
                        </form>
                      ) : <button class="chip" onClick={() => { setVoiding(m.id); setReason(''); }}>Void</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.voided.length > 0 && (
          <>
            <h4>Voided</h4>
            <ul class="admin-list">
              {data.voided.map((v) => <li key={v.id}>#{v.id} {campaignName(v.campaign)}: {v.voidReason} <span class="muted">({fmtTime(v.voidedAt)})</span></li>)}
            </ul>
          </>
        )}
      </Panel>
    </div>
  );
}

/** Per-server SourceTV: the port people spectate on, and its password.
 *  Public once enabled: the broadcast delay is what keeps it fair. */
function SourceTvCell(
  { server, busy, run }: {
    server: AdminOverview['servers'][number];
    busy: boolean;
    run: (fn: () => Promise<unknown>, confirmText?: string) => Promise<void>;
  },
) {
  const [port, setPort] = useState(server.tvPort ? String(server.tvPort) : '27020');
  const [password, setPassword] = useState(server.tvPassword ?? '');
  return (
    <form
      class="admin-form"
      onSubmit={(e) => { e.preventDefault(); void run(() => adminApi.serverSourcetv(server.id, true, port, password)); }}
    >
      <input value={port} aria-label={`SourceTV port for ${server.name}`} placeholder="port"
        onInput={(e) => setPort((e.target as HTMLInputElement).value)} />
      <input value={password} aria-label={`SourceTV password for ${server.name}`} placeholder="password"
        onInput={(e) => setPassword((e.target as HTMLInputElement).value)} />
      {server.tvEnabled === 1 ? (
        <>
          <span class="admin-status admin-status--active">on</span>
          <button class="btn" type="submit" disabled={busy}>Save</button>
          <button class="chip" type="button" disabled={busy}
            onClick={() => run(() => adminApi.serverSourcetv(server.id, false, port, password))}>Turn off</button>
        </>
      ) : (
        <button class="btn" type="submit" disabled={busy}>Enable</button>
      )}
    </form>
  );
}
