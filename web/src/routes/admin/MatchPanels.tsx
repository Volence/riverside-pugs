import { useState } from 'preact/hooks';
import { adminApi, type AdminOverview, type Forecast, type LogAuthMode, type ServerLogAuth } from '../../api';
import { campaignName } from '../../format';
import { Empty, Panel } from '../../components/bits';
import { fmtTime, useAction, type Run } from './useAction';
import { formatTime } from '../../replay/ReplayControls';
import { SlowToReadyTable } from './SlowToReady';
import type { MatchPause, MatchReadyup } from '../../api';

/**
 * The panels of the Live desk: open matches, the servers, the queue and the
 * recent results. They lived inline in the old Matches screen until the live
 * board needed the same ones underneath it, and two copies of the void form
 * is how one of them stops working unnoticed.
 */

/**
 * Team SR gap and the paper odds, in one table cell.
 *
 * For a live match this is built from current ratings, which while a match is
 * in flight ARE the pre-match ratings. For a completed one it is read from the
 * ratings as they stood before it, so it is a forecast rather than hindsight.
 */
export function Odds({ f, winner }: { f: Forecast | null; winner?: string | null }) {
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

export function AdminServersPanel({ servers, busy, run }: { servers: AdminOverview['servers']; busy: boolean; run: Run }) {
  return (
    <Panel class="panel--table">
      <h3>Servers</h3>
      {servers.length === 0 ? <Empty>No servers.</Empty> : (
        <div class="table-wrap">
        <table class="admin-table admin-table--servers">
          <thead><tr><th>Server</th><th>Status</th><th>In pool</th><th>Restart after match</th><th>SourceTV</th><th>Log signing</th><th /></tr></thead>
          <tbody>
            {servers.map((s) => (
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
                        {
                          title: `Take ${s.name} out of the pool?`,
                          body: 'Any match already on it finishes normally. It just will not be picked for the next one.',
                          confirmLabel: 'Take out',
                        },
                      )}>Take out</button>
                  ) : (
                    <>
                      <span class="admin-status admin-status--offline">out of pool</span>
                      <button class="chip" disabled={busy}
                        onClick={() => run(() => adminApi.serverEnabled(s.id, true))}>Put back</button>
                    </>
                  )}
                </td>
                <td><RestartCell server={s} busy={busy} run={run} /></td>
                <td><SourceTvCell server={s} busy={busy} run={run} /></td>
                <td><LogAuthCell server={s} busy={busy} run={run} /></td>
                <td>{s.status !== 'idle' && (
                  <button class="chip" disabled={busy}
                    onClick={() => run(() => adminApi.serverIdle(s.id), {
                      title: `Set ${s.name} idle?`,
                      body: 'Only do this when no match is really running on it. An idle server can be claimed by the next queue pop.',
                      confirmLabel: 'Set idle',
                    })}>Set idle</button>
                )}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      <AdminSyncButton />
    </Panel>
  );
}

/**
 * Every match that is configuring or live, as a table.
 *
 * The live board above it says who is missing and holds the clocks; this
 * says what an admin needs about the match itself, the console line for the
 * real server included. Abort stays here until the cancel dialog with its
 * penalty choice replaces it, which is a later plan.
 */
export function OpenMatchesPanel({ open, busy, run }: { open: AdminOverview['open']; busy: boolean; run: Run }) {
  return (
    <Panel class="panel--table">
      <h3>Open matches</h3>
      {open.length === 0 ? <Empty>No match is configuring or live.</Empty> : (
        <div class="table-wrap">
          <table class="admin-table">
            <thead><tr><th>Match</th><th>State</th><th>Server</th><th class="num">Connected</th><th>Odds</th><th>Join</th><th>Live since</th><th /></tr></thead>
            <tbody>
              {open.map((m) => (
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
  );
}

export function AdminQueuePanel({ queue, busy, run }: { queue: AdminOverview['queue']; busy: boolean; run: Run }) {
  return (
    <Panel class="panel--table">
      <h3>Queue</h3>
      {queue.length === 0 ? <Empty>The queue is empty.</Empty> : (
        <div class="table-wrap">
        <table class="admin-table">
          <tbody>
            {queue.map((p) => (
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
  );
}

export function RecentResultsPanel({ data, busy, run }: { data: AdminOverview; busy: boolean; run: Run }) {
  const [voiding, setVoiding] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  return (
    <Panel class="panel--table">
      <h3>Recent results</h3>
      <p class="muted">Voiding removes a match from every stat and rebuilds the season's ratings without it. It cannot be undone from here.</p>
      {data.recent.length === 0 ? <Empty>No completed matches.</Empty> : (
        <div class="table-wrap">
          <table class="admin-table admin-table--recent admin-table--pin-last">
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
                        void run(() => adminApi.voidMatch(m.id, reason), {
                          title: `Void match #${m.id}?`,
                          body: 'It stops counting anywhere and every rating for the season is recomputed without it.',
                          confirmLabel: 'Void match',
                          danger: true,
                        })
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
      <SlowToReadyTable rows={data.slowToReady ?? []} />
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
  );
}

/**
 * Whether this box cycles srcds after each match.
 *
 * Off is the safe state and the default. Turning it on asks the box to `quit`
 * and trusts its supervisor to start it again; where nothing does, the box is
 * gone until someone opens its host's control panel. Hence the confirm, and
 * hence doing it one box at a time.
 */
function RestartCell({ server: s, busy, run }: {
  server: { id: number; name: string; restartAfterMatch?: number };
  busy: boolean;
  run: Run;
}) {
  const on = s.restartAfterMatch === 1;
  return (
    <>
      <span class={`admin-status admin-status--${on ? 'idle' : 'offline'}`}>{on ? 'on' : 'off'}</span>{' '}
      <button class="chip" disabled={busy}
        onClick={() => run(
          () => adminApi.serverRestartAfterMatch(s.id, !on),
          on
            ? {
              title: `Stop restarting ${s.name} after each match?`,
              body: 'It will keep whatever uptime it has between matches, as it did before.',
              confirmLabel: 'Turn off',
            }
            : {
              title: `Restart ${s.name} after every match?`,
              body: 'It is asked to quit and its supervisor starts it again, about 10 to 20 seconds with '
                + 'nobody connected. If nothing restarts it, the server stays down until someone brings it '
                + 'back from its host. Watch the first one.',
              confirmLabel: 'Turn on',
            },
        )}>{on ? 'Turn off' : 'Turn on'}</button>
    </>
  );
}

/**
 * Signed log lines, per server.
 *
 * Everything a game server reports arrives as UDP log lines, and a UDP sender
 * address can be forged. A server that has been given a secret signs its
 * lines, and the mode says what happens to one that fails the check: `off`
 * believes everything as before, `log` counts failures and still believes
 * them, `enforce` drops them.
 *
 * The order that works, one box at a time: give it a secret, stage the new
 * plugins, set `log`, play a match and watch `unsigned` stop climbing, then
 * `enforce`. The counters are since the website last restarted.
 */
function LogAuthCell({ server: s, busy, run }: {
  server: { id: number; name: string; logAuth?: ServerLogAuth };
  busy: boolean;
  run: Run;
}) {
  const la = s.logAuth;
  if (!la) return null;
  const c = la.counters;
  const tone = la.mode === 'enforce' ? 'idle' : la.mode === 'log' ? 'reserved' : 'offline';
  return (
    <div class="admin-logauth">
      <span class={`admin-status admin-status--${tone}`}>{la.mode}</span>{' '}
      {!la.hasSecret ? (
        <button class="chip" disabled={busy}
          onClick={() => run(() => adminApi.serverLogSecret(s.id), {
            title: `Give ${s.name} a log secret?`,
            body: 'A secret is generated and pushed to the server over rcon. Nothing is checked until you change the mode, '
              + 'and servers still on the old plugins ignore it.',
            confirmLabel: 'Generate and push',
          })}>Set up</button>
      ) : (
        <>
          <select aria-label={`Log signing mode for ${s.name}`} disabled={busy} value={la.mode}
            onChange={(e) => {
              const mode = (e.currentTarget as HTMLSelectElement).value as LogAuthMode;
              void run(() => adminApi.serverLogAuth(s.id, mode), mode === 'enforce' ? {
                title: `Drop unsigned log lines from ${s.name}?`,
                body: 'Every line that is unsigned, badly signed or replayed will be ignored, including evidence. '
                  + 'Only do this once the unsigned count has stopped climbing in log mode with the new plugins staged.',
                confirmLabel: 'Enforce',
              } : undefined);
            }}>
            <option value="off">off</option>
            <option value="log">log</option>
            <option value="enforce">enforce</option>
          </select>{' '}
          <button class="chip" disabled={busy} title="Send the same secret to the server again, for one that lost it"
            onClick={() => run(() => adminApi.serverLogSecret(s.id))}>Push again</button>
        </>
      )}
      {la.hasSecret && c && (
        <div class="muted mono" title="Since the website last restarted">
          ok {c.ok} · unsigned {c.missing} · bad {c.badMac} · replayed {c.replay}
        </div>
      )}
    </div>
  );
}

/**
 * Push every website admin onto every game box, now.
 *
 * The push is automatic: it runs whenever someone is made or unmade an admin,
 * on a sweep, and at boot. This button exists for the moment that automation
 * cannot help with, which is a box that was down when its turn came. It shows
 * a line per server rather than one "done", because the answer worth having
 * is which box did NOT take it.
 */
function AdminSyncButton() {
  const [results, setResults] = useState<{ server: string; ok: boolean; error?: string }[] | null>(null);
  const { busy, error, run } = useAction(() => {});
  return (
    <div class="admin-setting__notice">
      <p>
        Every admin on this site gets admin on every server in the list. That happens by itself
        whenever admin is given or taken away; push it again here if a server was offline at the time.
      </p>
      <button class="btn" type="button" disabled={busy}
        onClick={() => void run(() => adminApi.syncServerAdmins().then((r) => setResults(r.results)))}>
        {busy ? 'Pushing...' : 'Push admins to servers'}
      </button>
      {error && <span class="error">{error}</span>}
      {results && (
        <ul class="admin-list">
          {results.length === 0 ? <li class="muted">No servers are in the pool.</li> : results.map((r) => (
            <li key={r.server}>
              {r.server}: {r.ok ? 'up to date' : <span class="error">{r.error ?? 'failed'}</span>}
            </li>
          ))}
        </ul>
      )}
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
    run: Run;
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
