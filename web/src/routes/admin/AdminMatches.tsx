import { useState } from 'preact/hooks';
import { adminApi, type AdminOverview, type Forecast } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { campaignName } from '../../format';
import { Empty, Panel } from '../../components/bits';
import { fmtTime, useAction } from './useAction';
import { formatTime } from '../../replay/ReplayControls';
import type { MatchPause, MatchReadyup } from '../../api';

/**
 * Team SR gap and the paper odds, in one table cell.
 *
 * For a live match this is built from current ratings, which while a match is
 * in flight ARE the pre-match ratings. For a completed one it is read from the
 * ratings as they stood before it, so it is a forecast rather than hindsight.
 */
function Odds({ f, winner }: { f: Forecast | null; winner?: string | null }) {
  if (!f) return <span class="muted">n/a</span>;
  const favoured = f.srGap === 0 ? null : f.srGap > 0 ? 'A' : 'B';
  const decided = favoured !== null && winner != null && winner !== 'draw';
  const upset = decided && winner!.toUpperCase() !== favoured;
  // The counterpart tag. Without it a row with no tag is ambiguous between
  // "the favourite won" and "we have no result to compare against", and a run
  // of expecteds is as much of a balance signal as a run of upsets.
  const expected = decided && !upset;
  return (
    <>
      <span>{Math.round(Math.max(f.winProbA, f.winProbB) * 100)}%</span>{' '}
      <span class="muted">
        {favoured === null ? 'even' : `${Math.abs(f.srGap)} SR to ${favoured}`}
      </span>
      {upset && <span class="admin-tag"> upset</span>}
      {expected && <span class="muted"> expected</span>}
    </>
  );
}

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
            <div class="table-wrap">
            <table class="admin-table admin-table--servers">
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
            </div>
          )}
        </Panel>
        <Panel class="panel--table">
          <h3>Queue</h3>
          {data.queue.length === 0 ? <Empty>The queue is empty.</Empty> : (
            <div class="table-wrap">
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
            </div>
          )}
        </Panel>
      </div>

      <Panel class="panel--table">
        <h3>Recent results</h3>
        <p class="muted">Voiding removes a match from every stat and rebuilds the season's ratings without it. It cannot be undone from here.</p>
        {data.recent.length === 0 ? <Empty>No completed matches.</Empty> : (
          <div class="table-wrap">
            <table class="admin-table">
              <thead><tr><th>Match</th><th class="num">Score</th><th>Odds</th><th>Pauses</th><th>Ready-ups</th><th>Ended</th><th /></tr></thead>
              <tbody>
                {data.recent.map((m) => (
                  <tr key={m.id}>
                    <td><a href={`/match/${m.id}`}>#{m.id}</a> {campaignName(m.campaign)}</td>
                    <td class="num">{m.teamAScore} - {m.teamBScore}</td>
                    {/* Was the result the odds expected? The upset marker is
                        the point of the column: a run of them is what tells
                        you the balancer needs looking at. */}
                    <td><Odds f={m.forecast} winner={m.winner} /></td>
                    <td>
                      {(m.pauses ?? []).length === 0 ? <span class="muted">none</span> : (
                        <ul class="admin-pauses">
                          {m.pauses.map((p, i) => <li key={i}>{pauseText(p)}</li>)}
                        </ul>
                      )}
                    </td>
                    <td>
                      {(m.readyups ?? []).length === 0 ? <span class="muted">none</span> : (
                        <ul class="admin-pauses">
                          {m.readyups.map((r, i) => <li key={i}>{readyupText(r)}</li>)}
                        </ul>
                      )}
                    </td>
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
        {(data.slowToReady ?? []).length > 0 && (
          <>
            <h3>Slow to ready</h3>
            <p class="muted">Across every counted match. "Last" is how often they were the one everybody was waiting on when the round went live.</p>
            <div class="table-wrap">
              <table class="admin-table">
                <thead><tr><th>Player</th><th class="num">Last</th><th class="num">Avg unready</th><th class="num">Total unready</th></tr></thead>
                <tbody>
                  {data.slowToReady.map((p) => (
                    <tr key={p.steamid}>
                      <td><a href={`/player/${p.steamid}`}>{p.name}</a></td>
                      <td class="num">{p.timesLast} of {p.readyups}</td>
                      <td class="num">{formatTime(p.avgSeconds * 1000)}</td>
                      <td class="num">{formatTime(p.totalSeconds * 1000)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {(data.aborted ?? []).length > 0 && (
          <>
            <h4>Aborted</h4>
            <p class="muted">
              Ended with no result, so nothing counted. The scoreline is how far they got; the
              roster, stats and replays are on the match page.
            </p>
            <ul class="admin-list">
              {data.aborted.map((m) => (
                <li key={m.id}>
                  <a href={`/match/${m.id}`}>#{m.id}</a> {campaignName(m.campaign)} {m.teamAScore} - {m.teamBScore}
                  {m.abandonedBy ? <> · left: {m.abandonedBy}</> : null}
                  {' '}<span class="muted">({fmtTime(m.endedAt)})</span>
                </li>
              ))}
            </ul>
          </>
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
/** One pause, in the words an admin settling a dispute wants: who, how long,
 *  which map. A disconnect pause is the plugin's, not a team's. */
export function pauseText(p: MatchPause): string {
  const who = p.team ? `Team ${p.team.toUpperCase()}` : p.leave ? 'Reconnect' : 'Admin';
  const length = p.seconds === null ? 'still open' : formatTime(p.seconds * 1000);
  return `${who} ${length} on map ${p.mapOrdinal + 1}`;
}

/** One ready-up: how long it took, which map, and who readied last. */
export function readyupText(r: MatchReadyup): string {
  const length = r.seconds === null ? 'still open' : formatTime(r.seconds * 1000);
  const last = r.lastUnreadyNames.length ? `, last ${r.lastUnreadyNames.join(', ')}` : '';
  return `${length} on map ${r.mapOrdinal + 1}${last}`;
}

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
