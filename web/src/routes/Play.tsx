import { useEffect, useState } from 'preact/hooks';
import { api, ApiError, type Me, type LobbySnapshot, type NamedPlayer, type PublicQueue, type StateSnapshot } from '../api';
import { campaignName, fmtClock } from '../format';
import { Countdown, useSecondsLeft } from '../components/Countdown';
import { QUEUE_SIZE } from '../queueSize';
import { Empty, Panel } from '../components/bits';
import { CampaignTiles } from '../components/CampaignTiles';
import { ConnectPanel } from '../components/ConnectPanel';
import { PageHeader } from '../components/PageHeader';
import { SetupChecklist } from '../components/SetupChecklist';
import type { Session } from '../hooks/useLiveState';



export function Play(
  { session, state, refresh }: { session: Session; state: StateSnapshot | null; refresh: () => void },
) {
  if (session.kind === 'loading') return <div class="page page--play" />;
  if (session.kind === 'anonymous') return <SignIn />;
  if (session.kind === 'pending' && session.me.status === 'banned') {
    return (
      <div class="page page--play">
        <Panel>
          <p class="eyebrow">Banned</p>
          <h2>You are banned from the PUG</h2>
          <p class="muted">If you think this is a mistake, talk to an admin in the Discord.</p>
        </Panel>
      </div>
    );
  }
  if (session.kind === 'pending') return <Register me={session.me} onDone={refresh} />;
  if (!state) return <div class="page page--play" />;

  const wide = state.match !== null;
  return (
    <div class={`page ${wide ? 'page--play-teams' : 'page--play'}`}>
      <PageHeader eyebrow="Riverside" title="Ranked 4v4" />
      <Live state={state} me={session.me.steamid} sessionMe={session.me} refresh={refresh} />
    </div>
  );
}

function SignIn() {
  const [q, setQ] = useState<PublicQueue | null>(null);
  useEffect(() => {
    let alive = true;
    // Polled rather than pushed over the websocket: the socket nudge is
    // session-scoped and an anonymous visitor has no session, same as why the
    // live match page polls.
    const tick = () => api.queue().then((r) => { if (alive) setQ(r); }).catch(() => {});
    tick();
    const t = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  return (
    <div class="page page--play">
      <Panel class="hero-panel">
        <p class="eyebrow">Riverside</p>
        <h1>Ranked 4v4 pick-up games</h1>
        <p class="muted">Sign in to join the queue.</p>
        {/* target is load bearing, exactly as it is for the .html links in
            Nav: preact-iso intercepts a same-origin click unless the target
            is set to something other than _self (router.js:45). /auth/steam
            is a BACKEND route, not an SPA route, so without this the router
            swallows the click and renders its own "No such page", and only a
            manual refresh reaches the server. That is what happened between
            2b42626 and 2026-09-16, during which nobody could sign in at all.
            _top rather than _blank: the Steam redirect has to come back to
            this tab, not orphan itself in a new one. */}
        <a class="btn" href="/auth/steam" target="_top" rel="noopener">Sign in through Steam</a>
        <p class="muted">First time? Read <a href="/how-to-play">How to play</a>.</p>
      </Panel>
      {q && (
        <Panel>
          <p class="eyebrow">Queue</p>
          <div class="queue-count">
            <span class="hero">{q.count}</span>
            <span class="queue-count__of">/ {QUEUE_SIZE}</span>
          </div>
          <Slots players={q.players} />
        </Panel>
      )}
    </div>
  );
}

function Register({ me, onDone }: { me: Me; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.register(code.trim());
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="page page--play">
      {me.discordEnabled && (
        <Panel class="hero-panel">
          <p class="eyebrow">Almost there</p>
          <h2>Two quick steps to play</h2>
          <SetupChecklist me={me} />
          <p class="muted">
            Done both and still here? <button class="chip" type="button" onClick={onDone}>Check again</button>
            {' '}New to this? Read <a href="/how-to-play">How to play</a>.
          </p>
        </Panel>
      )}
      {!me.discordEnabled && <Panel>
        <p class="eyebrow">Invite only</p>
        <h2>You need an invite code</h2>
        <form class="register" onSubmit={submit}>
          <input
            value={code}
            placeholder="invite code"
            aria-label="Invite code"
            onInput={(e) => setCode((e.target as HTMLInputElement).value)}
          />
          <button class="btn" type="submit" disabled={busy || code.trim() === ''}>Register</button>
        </form>
        {error && <p class="error">{error}</p>}
      </Panel>}
    </div>
  );
}

function Live(
  { state, me, sessionMe, refresh }: { state: StateSnapshot; me: string; sessionMe: Me; refresh: () => void },
) {
  const { queue, lobby, match } = state;

  if (match) {
    return (
      <Panel>
        <p class="eyebrow">
          {/* waitingForServer and state === 'live' are mutually exclusive
              (the server only sets waitingForServer while configuring), so
              checking waitingForServer first is defensive rather than
              required: either order produces the same result today. */}
          {match.waitingForServer ? 'Waiting for a server'
            : match.state === 'live' ? 'Match in progress'
            : 'Setting up server'}
        </p>
        <h2>{campaignName(match.campaign)}</h2>
        <div class="teams">
          {(['A', 'B'] as const).map((label) => {
            const roster = label === 'A' ? match.teamA : match.teamB;
            return (
              <div key={label}>
                <h3>Team {label}</h3>
                <ul class="roster">
                  {roster.map((p) => (
                    <li key={p.steamid} class={p.steamid === me ? 'is-me' : ''}>{p.name}</li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
        {match.connect && <ConnectPanel connect={match.connect} />}
        {match.waitingForServer && (
          <Empty>Waiting for a free server. The match starts as soon as one opens up.</Empty>
        )}
      </Panel>
    );
  }

  if (lobby && lobby.phase === 'ready_check') return <ReadyCheck lobby={lobby} me={me} refresh={refresh} />;
  if (lobby && lobby.phase === 'map_vote') return <MapVote lobby={lobby} refresh={refresh} />;
  return (
    <QueuePanel
      count={queue.count} joined={queue.joined} players={queue.players} refresh={refresh}
      timeout={state.timeout ?? null} queueBlock={state.queueBlock ?? null} me={sessionMe}
    />
  );
}

export function QueuePanel(
  { count, joined, players, refresh, timeout = null, queueBlock = null, me = null }:
    {
      count: number; joined: boolean; players: NamedPlayer[]; refresh: () => void;
      /** A queue timeout being served; the join button is disabled until it ends. */
      timeout?: { until: string; offenses: number } | null;
      /** A Discord step still missing; replaces the join button with the checklist. */
      queueBlock?: 'link_discord' | 'join_discord' | null;
      me?: Me | null;
    },
) {
  const [error, setError] = useState('');

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    }
    refresh();
  };

  return (
    <Panel>
      <p class="eyebrow">Queue</p>
      <div class="queue-count">
        <span class="hero">{count}</span>
        <span class="queue-count__of">/ {QUEUE_SIZE}</span>
      </div>
      <Slots players={players} />
      {joined ? (
        <button class="btn btn--block btn--ghost" onClick={() => act(api.leaveQueue)}>Leave queue</button>
      ) : queueBlock ? (
        <div class="queue-block">
          <p class="queue-timeout">
            {queueBlock === 'link_discord'
              ? 'To queue you need your Discord linked and to be in the Riverside Discord server.'
              : 'Your linked Discord account is not in the Riverside Discord server. Join it to queue.'}
          </p>
          <SetupChecklist me={me} compact />
          <button class="chip" type="button" onClick={refresh}>Check again</button>
        </div>
      ) : timeout && Date.parse(timeout.until) > Date.now() ? (
        <>
          <button class="btn btn--block" disabled>Join queue</button>
          <TimeoutNotice until={Date.parse(timeout.until)} onDone={refresh} />
        </>
      ) : (
        <button class="btn btn--block" onClick={() => act(api.joinQueue)}>Join queue</button>
      )}
      {error && <p class="error">{error}</p>}
    </Panel>
  );
}

/** Eight fixed slots rather than a list that grows. A half-full queue should
 *  look like a half-full queue: the empty slots are the information. Filled
 *  ones now name who is in them, which is what a friend group actually wants
 *  to know before deciding to join. */
function Slots({ players }: { players: NamedPlayer[] }) {
  return (
    <div class="slots">
      {Array.from({ length: QUEUE_SIZE }, (_, i) => {
        const p = players[i];
        return (
          <div key={i} class={`slot ${p ? 'slot--filled' : ''}`} title={p?.name}>
            {p && (
              <>
                {p.avatar
                  ? <img class="slot__avatar" src={p.avatar} alt="" />
                  : <span class="slot__avatar slot__avatar--none" aria-hidden="true" />}
                <span class="slot__name">{p.name}</span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ReadyCheck(
  { lobby, me, refresh }: { lobby: LobbySnapshot; me: string; refresh: () => void },
) {
  const left = useSecondsLeft(lobby.deadline);
  const iAmReady = lobby.ready.includes(me);

  return (
    <Panel class="urgent-panel">
      <p class="eyebrow">Match found, ready up</p>
      <Countdown deadline={lobby.deadline} left={left} />
      <ul class="roster roster--ready">
        {lobby.players.map((p) => (
          <li key={p.steamid} class={lobby.ready.includes(p.steamid) ? 'is-ready' : ''}>
            <span>{p.name}</span>
            <span class="tick" aria-label={lobby.ready.includes(p.steamid) ? 'ready' : 'not ready'}>
              {lobby.ready.includes(p.steamid) ? '✓' : '·'}
            </span>
          </li>
        ))}
      </ul>
      <button
        class="btn btn--block"
        disabled={iAmReady}
        onClick={() => api.ready().catch(() => {}).then(refresh)}
      >
        {iAmReady ? `Ready, waiting for ${lobby.players.length - lobby.ready.length}` : 'Ready'}
      </button>
    </Panel>
  );
}

function MapVote({ lobby, refresh }: { lobby: LobbySnapshot; refresh: () => void }) {
  const left = useSecondsLeft(lobby.deadline);
  const total = Object.values(lobby.votes).reduce((a, b) => a + b, 0);
  const leader = Math.max(0, ...Object.values(lobby.votes));

  return (
    <Panel>
      <p class="eyebrow">Vote for a campaign</p>
      <Countdown deadline={lobby.deadline} left={left} />
      <CampaignTiles
        onPick={(c) => api.vote(c).catch(() => {}).then(refresh)}
        items={lobby.options.map((c) => {
          const n = lobby.votes[c] ?? 0;
          const leading = n > 0 && n === leader;
          return {
            slug: c,
            sub: n === 0 ? 'No votes' : `${n} vote${n === 1 ? '' : 's'}${leading ? ' · leading' : ''}`,
            active: lobby.myVote === c,
          };
        })}
      />
      {total === 0 && <Empty>No votes yet. A random campaign is picked if nobody votes.</Empty>}
    </Panel>
  );
}

/** "You can queue again in 12:04", ticking, then a refresh when it runs out so
 *  the join button comes back without a reload. */
function TimeoutNotice({ until, onDone }: { until: number; onDone: () => void }) {
  const left = useSecondsLeft(until);
  useEffect(() => {
    if (left === 0) onDone();
  }, [left === 0]);
  const h = Math.floor(left / 3600);
  const clock = h > 0 ? `${h}h ${String(Math.floor((left % 3600) / 60)).padStart(2, '0')}m` : fmtClock(left);
  return (
    <p class="queue-timeout">
      Queue timeout for missed ready checks or no-shows. You can queue again in {clock}.
    </p>
  );
}
