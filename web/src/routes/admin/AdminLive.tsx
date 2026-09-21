import { useEffect, useRef, useState } from 'preact/hooks';
import { adminApi, type LiveBoard, type LiveBoardMatch, type LiveBoardPlayer } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { useHubEvent } from '../../hooks/useHubEvent';
import { useElapsedSince } from '../../hooks/useElapsedSince';
import { campaignName, fmtClock, mapName } from '../../format';
import { Empty, Panel } from '../../components/bits';
import { SpectatePanel } from '../../components/SpectatePanel';
import { useAction, type Run } from './useAction';
import { AdminQueuePanel, AdminServersPanel, OpenMatchesPanel, RecentResultsPanel } from './MatchPanels';
import { OLD_PLUGIN_REASON, SELF_STARTED_REASON, countdown, countUp, isLow, liveFromUrl, reasonText } from '../../liveBoard';

/** A safety net under the websocket, not the mechanism: a nudge lost while
 *  the socket was reconnecting must not leave a countdown wrong for long. */
const FALLBACK_POLL_MS = 15_000;
const ADD_SECONDS = 300;

/**
 * The admin landing page: every ongoing match, who is missing from it, and
 * the clock that is about to end it.
 *
 * Built for one moment. A player has dropped, the abandon timer is running,
 * and an admin has seconds to stop it (the owner lost a ranked match to
 * exactly that, 2026-09-21). So Hold is one click with no dialog, it sits on
 * the row with the red countdown, and the only thing that asks first is the
 * one that cannot be taken back.
 *
 * The page does no clock arithmetic against the server's time. The payload
 * gives every figure in seconds as of its own `now`; this counts on from the
 * moment the payload arrived, with one ticker for the whole board.
 */
export function AdminLive() {
  const [nudge, setNudge] = useState(0);
  useHubEvent(['refresh'], () => setNudge((n) => n + 1));
  useEffect(() => {
    const t = setInterval(() => setNudge((n) => n + 1), FALLBACK_POLL_MS);
    return () => clearInterval(t);
  }, []);

  const live = useFetch((s) => adminApi.live(s), [nudge]);
  const overview = useFetch((s) => adminApi.overview(s), [nudge]);

  // The last board that loaded, with when it arrived. A failed re-fetch keeps
  // the old one up rather than blanking the screen mid-emergency, and the
  // arrival time is what every countdown on the page is measured from.
  const [board, setBoard] = useState<{ data: LiveBoard; at: number } | null>(null);
  useEffect(() => {
    if (live.data) setBoard({ data: live.data, at: Date.now() });
  }, [live.data]);
  const elapsedS = useElapsedSince(board?.at ?? null);

  const panels = useAction(() => overview.reload());
  const target = useRef(liveFromUrl()).current;

  if (!board) return <Panel><p class="muted">Loading...</p></Panel>;

  return (
    <div class="stack">
      {live.error && <p class="error">Could not refresh the board. Showing the last one that loaded.</p>}
      {board.data.matches.length === 0 ? (
        <Panel><Empty>No match is running.</Empty></Panel>
      ) : board.data.matches.map((m) => (
        <MatchCard key={m.id} match={m} elapsedS={elapsedS} holdMaxMinutes={board.data.holdMaxMinutes}
          lowAlertSeconds={board.data.lowAlertSeconds} reload={live.reload} isTarget={m.id === target} />
      ))}

      {overview.data && (
        <>
          {panels.error && <p class="error">{panels.error}</p>}
          {/* The same overview the panels below are built from, so the table
              and the cards above it can never disagree about a match. */}
          <OpenMatchesPanel open={overview.data.open} busy={panels.busy} run={panels.run} />
          <div class="admin-split admin-split--even">
            <AdminServersPanel servers={overview.data.servers} busy={panels.busy} run={panels.run} />
            <AdminQueuePanel queue={overview.data.queue} busy={panels.busy} run={panels.run} />
          </div>
          <RecentResultsPanel data={overview.data} busy={panels.busy} run={panels.run} />
        </>
      )}
    </div>
  );
}

function MatchCard({ match: m, elapsedS, holdMaxMinutes, lowAlertSeconds, reload, isTarget }: {
  match: LiveBoardMatch; elapsedS: number; holdMaxMinutes: number; lowAlertSeconds: number;
  reload: () => void; isTarget: boolean;
}) {
  // The error is per card, so a failure shows on the match it happened to.
  // Busy is per PLAYER: an rcon call can take the whole rcon timeout against
  // a slow box, and for that window the one thing that must stay pressable is
  // Hold for the other player whose clock is still running.
  const { error, run } = useAction(reload);
  const [busyId, setBusyId] = useState<string | null>(null);
  const runFor = (steamid: string): Run => async (fn, ask) => {
    setBusyId(steamid);
    try {
      await run(fn, ask);
    } finally {
      setBusyId(null);
    }
  };
  const el = useRef<HTMLElement>(null);
  useEffect(() => {
    if (isTarget) el.current?.scrollIntoView?.({ block: 'start' });
  }, [isTarget]);
  // Why the clock controls are off, or null when they are live. Both reasons
  // are facts about the server, not about this admin, so they are said on the
  // card rather than discovered by pressing a button and reading a PUGERR.
  const blocked = m.leaveControl === 'old_plugin' ? OLD_PLUGIN_REASON
    : !m.leaveTracking ? SELF_STARTED_REASON
    : null;

  return (
    <section class={`panel live-card${isTarget ? ' is-target' : ''}`} ref={el}>
      <header class="live-card__line">
        <h3><a href={`/match/${m.id}`}>#{m.id}</a> {campaignName(m.campaign)}</h3>
        <span class="muted">{m.map ? mapName(m.map) : 'no map yet'}</span>
        <span class={`admin-status admin-status--${m.state === 'live' ? 'idle' : 'reserved'}`}>
          {m.state === 'waiting' ? 'waiting for a server' : m.state}
        </span>
        <span class="mono">{m.teamAScore} - {m.teamBScore}</span>
        <span class="muted">{m.server ? m.server.name : 'no server'}</span>
        <span class="muted mono" title="Since it went live, or since the pop while it has not">{fmtClock(countUp(m.elapsedS, elapsedS))}</span>
        {m.spectate && <SpectatePanel spectate={m.spectate} />}
      </header>

      <p class="live-card__clocks">
        {m.clocks.length === 0 ? <span class="muted">No clocks running.</span> : m.clocks.map((c) => {
          const left = countdown(c.remainingS, !c.held, elapsedS) ?? 0;
          return (
            <span key={c.steamid} class={`live-clock${c.held ? ' is-held' : isLow(left, lowAlertSeconds) ? ' is-low' : ''}`}>
              {c.name} <span class="mono">{fmtClock(left)}</span> {c.held ? 'on hold' : 'to reconnect'}
            </span>
          );
        })}
      </p>

      {blocked && <p class="error">{blocked}</p>}
      {error && <p class="error">{error}</p>}

      <div class="live-card__teams">
        {([['Team A', m.teamA], ['Team B', m.teamB]] as const).map(([label, team]) => (
          <div key={label}>
            <h4>{label}</h4>
            <ul class="live-roster">
              {team.map((p) => (
                <PlayerRow key={p.steamid} match={m} player={p} elapsedS={elapsedS}
                  holdMaxMinutes={holdMaxMinutes} lowAlertSeconds={lowAlertSeconds}
                  busy={busyId === p.steamid} run={runFor(p.steamid)} blocked={blocked} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function PlayerRow({ match: m, player: p, elapsedS, holdMaxMinutes, lowAlertSeconds, busy, run, blocked }: {
  match: LiveBoardMatch; player: LiveBoardPlayer; elapsedS: number; holdMaxMinutes: number;
  lowAlertSeconds: number; busy: boolean; run: Run; blocked: string | null;
}) {
  const s = p.status;
  const off = busy || blocked !== null;
  const why = blocked ?? undefined;
  const add = (
    <button class="chip" type="button" disabled={off} title={why ?? 'Five more minutes of reconnect time'}
      onClick={() => run(() => adminApi.leaveClock(m.id, p.steamid, 'add', ADD_SECONDS))}>+5 min</button>
  );

  return (
    <li class={`live-row live-row--${s.kind}`}>
      <a class="live-row__name" href={`/player/${p.steamid}`}>{p.name}</a>

      <span class="live-row__status">
        {s.kind === 'connected' && (
          <>On the server{s.remainingS !== null && <span class="muted">, {fmtClock(s.remainingS)} of reconnect time left</span>}</>
        )}
        {s.kind === 'never_connected' && <>Never connected, {fmtClock(countUp(s.sincePopS, elapsedS))} since the pop</>}
        {s.kind === 'dropped' && (() => {
          const left = countdown(s.remainingS, !s.held, elapsedS);
          const holdLeft = countdown(s.holdLeftS, s.held, elapsedS);
          return (
            <>
              Dropped {fmtClock(countUp(s.sinceS, elapsedS))} ago
              {left !== null && (
                <span class={`live-row__left mono${s.held ? ' is-held' : isLow(left, lowAlertSeconds) ? ' is-low' : ''}`}> {fmtClock(left)} left</span>
              )}
              {s.held && (
                <span class="admin-tag"> on hold{holdLeft !== null ? `, releases itself in ${fmtClock(holdLeft)}` : ''}</span>
              )}
            </>
          );
        })()}
        {p.reason && <span class="live-row__reason muted">{reasonText(p.reason)}</span>}
      </span>

      <span class="live-row__actions">
        {s.kind === 'dropped' && (
          <>
            {s.held ? (
              <button class="btn" type="button" disabled={off} title={why}
                onClick={() => run(() => adminApi.leaveClock(m.id, p.steamid, 'release'))}>Release</button>
            ) : (
              // No dialog, on purpose. This is the button that has to beat a
              // countdown, and it is undone by the one next to it.
              <button class="btn" type="button" disabled={off}
                title={why ?? `Stops this clock until you release it, for up to ${holdMaxMinutes} minutes`}
                onClick={() => run(() => adminApi.leaveClock(m.id, p.steamid, 'hold'))}>Hold</button>
            )}
            {add}
            <button class="chip" type="button" disabled={off} title={why}
              onClick={() => run(() => adminApi.leaveClock(m.id, p.steamid, 'end'), {
                title: `End ${p.name}'s reconnect time now?`,
                body: `Match #${m.id} ends as an abandon within a second. Nobody's rating changes and ${p.name} is banned `
                  + 'on the usual ladder. This cannot be taken back from here.',
                confirmLabel: 'End now',
                danger: true,
              })}>End now</button>
          </>
        )}
        {/* Someone who is back but has already spent allowance: the player
            whose connection keeps dropping, given time before the next one. */}
        {s.kind === 'connected' && s.remainingS !== null && add}
      </span>

      {/* Reserved: "Bring in a sub". The owner has not designed substitutes
          yet (spec, decision 4: leave room, build nothing). The empty cell
          holds the row's last column so adding the button later moves
          nothing. Do not put anything in here until that design exists. */}
      <span class="live-row__sub" aria-hidden="true" />
    </li>
  );
}
