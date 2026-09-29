import { useEffect, useState } from 'preact/hooks';
import { adminApi, api, ApiError, type AdminPracticeLease, type AdminPracticePlayer } from '../../api';
import { mapName } from '../../format';
import { Panel } from '../../components/bits';
import { useFetch } from '../../hooks/useFetch';
import { KIND_LABEL, leasePath } from '../../practice';
import { useAction, type Run } from './useAction';
import { fileUrl } from './adminRoutes';

/** How often a row re-reads who is on its server. Each read is one rcon
 *  `status` on that box, so not faster than the board's own fallback poll. */
export const PLAYERS_POLL_MS = 15_000;

const TEAM_LABEL: Record<number, string> = { 1: 'Spectator', 2: 'Survivor', 3: 'Infected' };
const TRAINER_LABEL: Record<number, string> = { 1: 'Skeet trainer', 2: 'Crown trainer', 3: 'Rocks trainer' };
const STATION_LABEL: Record<string, string> = {
  pit: 'Hunter pit', lane: 'Skeet lane', dp: 'DP yard', climb: 'Wall-kick climb',
  skeet: 'Skeet trainer', crown: 'Witch crown', rocks: 'Tank rocks', drill: 'In the drill',
};

/** "2: Dust, RollingSix", or the lease's last minute count until the first
 *  read answers, or "0" for an empty server. */
export function playersCell(players: AdminPracticePlayer[] | null, fallback: number): string {
  if (!players) return String(fallback);
  if (players.length === 0) return '0';
  return `${players.length}: ${players.map((p) => p.name).join(', ')}`;
}

const STATE_LABEL: Record<AdminPracticeLease['state'], string> = {
  setting_up: 'setting up', ready: 'ready', ending: 'closing', ended: 'closed',
};

/**
 * Practice servers on the live board (src/practiceLeases.ts): which pool
 * boxes are lent out right now, to whom, and an End for each.
 *
 * On the board because a leased box is one the queue cannot have, and the
 * board is where an admin looks when a PUG is waiting for a server. Ending
 * here is the same wind-down the owner's own button runs: goodbye in chat,
 * kick, restart, back to the pool. A PUG that needs a box takes one back on
 * its own after a minute's warning, so this is for the cases that cannot
 * wait for that, or a lease someone forgot. Omits itself when none is open.
 *
 * `nudge` is the board's own refresh counter, so this refetches whenever
 * the board does. Each row also reads who is on its server (LeaseRow), and
 * opens into a table of them with a Kick for each. `onChat` opens a server's
 * chat drawer on the Live board.
 */
export function PracticeLeasesPanel({ nudge, onChat }: { nudge: number; onChat?: (serverId: number) => void }) {
  const leases = useFetch((s) => adminApi.practiceLeases(s), [nudge]);
  const { busy, error, run } = useAction(() => leases.reload());
  const rows = leases.data?.leases ?? [];
  if (rows.length === 0) return null;
  return (
    <Panel class="panel--table">
      <h3>Practice servers</h3>
      <div class="table-wrap">
        <table class="admin-table">
          <thead><tr><th>Server</th><th>Kind</th><th>Started by</th><th>State</th><th>Players</th><th>Map</th><th /></tr></thead>
          <tbody>
            {rows.map((l) => (
              <LeaseRow key={l.id} lease={l} busy={busy} run={run} onChat={onChat} />
            ))}
          </tbody>
        </table>
      </div>
      {error && <p class="error">{error}</p>}
    </Panel>
  );
}

/**
 * One practice server's row, and the table of who is on it when opened.
 *
 * The players cell reads the box itself (GET /api/admin/practice/:id/players)
 * on mount and every PLAYERS_POLL_MS, so the names are there without
 * opening anything. Clicking the row opens the table below it: team,
 * trainer, time connected, ping, and a Kick with an optional reason typed
 * inline. No confirm dialog: the reason box is the pause, and a kick is
 * undone by the player reconnecting.
 */
function LeaseRow({ lease: l, busy, run, onChat }: {
  lease: AdminPracticeLease; busy: boolean; run: Run; onChat?: (serverId: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [players, setPlayers] = useState<AdminPracticePlayer[] | null>(null);
  const [readError, setReadError] = useState('');
  const [tick, setTick] = useState(0);
  const live = l.state === 'setting_up' || l.state === 'ready';

  useEffect(() => {
    if (!live) return;
    const ctl = new AbortController();
    adminApi.practicePlayers(l.id, ctl.signal)
      .then((r) => { setPlayers(r.players); setReadError(''); })
      .catch((err) => {
        if (ctl.signal.aborted) return;
        setReadError(err instanceof ApiError ? err.message : 'Could not read the players.');
      });
    const t = setTimeout(() => setTick((n) => n + 1), PLAYERS_POLL_MS);
    return () => { ctl.abort(); clearTimeout(t); };
  }, [l.id, live, tick]);

  const toggle = () => {
    // Opening reads at once rather than waiting out the poll.
    if (!open) setTick((n) => n + 1);
    setOpen(!open);
  };

  return (
    <>
      <tr class={`practice-row${open ? ' is-open' : ''}`} onClick={toggle} aria-expanded={open}>
        <td><a href={leasePath(l.id)} onClick={(e) => e.stopPropagation()}>{l.server}</a></td>
        <td>{KIND_LABEL[l.kind]}</td>
        <td><a href={`/player/${l.owner.steamid}`} onClick={(e) => e.stopPropagation()}>{l.owner.name}</a></td>
        <td>
          <span class={`admin-status admin-status--${l.state === 'ready' ? 'live' : 'reserved'}`}>{STATE_LABEL[l.state]}</span>
          {l.warnedAt && l.state === 'ready' && <span class="muted"> PUG waiting, closing</span>}
        </td>
        <td class="practice-row__players">{playersCell(players, l.humans)}</td>
        <td class="muted">{l.map ? mapName(l.map) : ''}</td>
        <td>
          {onChat && (
            <button class="chip" type="button" onClick={(e) => { e.stopPropagation(); onChat(l.serverId); }}>Chat</button>
          )}{' '}
          {live && (
            <button class="chip" type="button" disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                void run(() => api.endPractice(l.id), {
                  title: `Close ${l.owner.name}'s ${KIND_LABEL[l.kind].toLowerCase()} on ${l.server}?`,
                  body: 'Everyone on it is kicked, and the server restarts and goes back to the PUG pool.',
                  confirmLabel: 'Close it',
                  danger: true,
                });
              }}>End</button>
          )}
        </td>
      </tr>
      {open && (
        <tr class="practice-row__detail">
          <td colSpan={7}>
            {readError && <p class="error">{readError}</p>}
            {players === null ? <p class="muted">Reading the server...</p>
              : players.length === 0 ? <p class="muted">Nobody is on this server.</p>
              : (
                <table class="admin-table practice-players">
                  <thead><tr><th>Name</th><th>Team</th><th>Station</th><th>Connected</th><th>Ping</th><th /></tr></thead>
                  <tbody>
                    {players.map((p) => (
                      <PlayerRow key={p.userid} leaseId={l.id} player={p} onKicked={() => setTick((n) => n + 1)} />
                    ))}
                  </tbody>
                </table>
              )}
          </td>
        </tr>
      )}
    </>
  );
}

function PlayerRow({ leaseId, player: p, onKicked }: { leaseId: number; player: AdminPracticePlayer; onKicked: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const kick = async () => {
    setBusy(true);
    setError('');
    try {
      await adminApi.practiceKick(leaseId, p.userid, reason);
      onKicked();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not kick them.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <tr>
      <td>
        {p.onSite && p.steamid64 ? <a href={`/player/${p.steamid64}`}>{p.name}</a> : p.name}
        {p.onSite && p.steamid64 && <> <a class="muted" href={fileUrl(p.steamid64)}>file</a></>}
      </td>
      <td>{p.team !== null ? TEAM_LABEL[p.team] ?? `team ${p.team}` : <span class="muted">unknown</span>}</td>
      <td>{p.station ? STATION_LABEL[p.station] ?? p.station
        : p.trainer !== null ? TRAINER_LABEL[p.trainer] ?? `trainer ${p.trainer}` : <span class="muted">none</span>}</td>
      <td class="num">{p.connectedFor}</td>
      <td class="num">{p.ping}</td>
      <td>
        <span class="practice-kick">
          <input value={reason} placeholder="Reason (optional)" aria-label={`Reason to kick ${p.name}`} maxLength={120}
            onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
          <button class="chip" type="button" disabled={busy} onClick={kick}>{busy ? 'Kicking...' : 'Kick'}</button>
        </span>
        {error && <span class="error" role="alert"> {error}</span>}
      </td>
    </tr>
  );
}
