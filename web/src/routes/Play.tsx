import { useState } from 'preact/hooks';
import { api, ApiError, type LobbySnapshot, type StateSnapshot } from '../api';
import { campaignName, campaignTint } from '../format';
import { Countdown, useCountdownChrome, useSecondsLeft } from '../components/Countdown';
import { Empty, Panel } from '../components/bits';
import type { Session } from '../hooks/useLiveState';

const QUEUE_SIZE = 8;

export function Play(
  { session, state, refresh }: { session: Session; state: StateSnapshot | null; refresh: () => void },
) {
  if (session.kind === 'loading') return <div class="page page--play" />;
  if (session.kind === 'anonymous') return <SignIn />;
  if (session.kind === 'pending') return <Register onDone={refresh} />;
  if (!state) return <div class="page page--play" />;

  const wide = state.match !== null;
  return (
    <div class={`page ${wide ? 'page--play-teams' : 'page--play'}`}>
      <Live state={state} me={session.me.steamid} refresh={refresh} />
    </div>
  );
}

function SignIn() {
  return (
    <div class="page page--play">
      <Panel class="hero-panel">
        <p class="eyebrow">Left 4 Dead</p>
        <h1>Ranked 4v4 pick-up games</h1>
        <p class="muted">Sign in to join the queue.</p>
        <a class="btn" href="/auth/steam">Sign in through Steam</a>
      </Panel>
    </div>
  );
}

function Register({ onDone }: { onDone: () => void }) {
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
      <Panel>
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
      </Panel>
    </div>
  );
}

function Live(
  { state, me, refresh }: { state: StateSnapshot; me: string; refresh: () => void },
) {
  const { queue, lobby, match } = state;

  if (match) {
    return (
      <Panel>
        <p class="eyebrow">{match.state === 'live' ? 'Match in progress' : 'Setting up server'}</p>
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
      </Panel>
    );
  }

  if (lobby && lobby.phase === 'ready_check') return <ReadyCheck lobby={lobby} me={me} refresh={refresh} />;
  if (lobby && lobby.phase === 'map_vote') return <MapVote lobby={lobby} refresh={refresh} />;
  return <QueuePanel count={queue.count} joined={queue.joined} refresh={refresh} />;
}

function QueuePanel(
  { count, joined, refresh }: { count: number; joined: boolean; refresh: () => void },
) {
  const [error, setError] = useState('');
  useCountdownChrome(null, 0);

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
      <Slots filled={count} />
      {joined ? (
        <button class="btn btn--block btn--ghost" onClick={() => act(api.leaveQueue)}>Leave queue</button>
      ) : (
        <button class="btn btn--block" onClick={() => act(api.joinQueue)}>Join queue</button>
      )}
      {error && <p class="error">{error}</p>}
    </Panel>
  );
}

/** Eight fixed slots rather than a list that grows. A half-full queue should
 *  look like a half-full queue: the empty slots are the information. */
function Slots({ filled }: { filled: number }) {
  return (
    <div class="slots">
      {Array.from({ length: QUEUE_SIZE }, (_, i) => (
        <div key={i} class={`slot ${i < filled ? 'slot--filled' : ''}`} />
      ))}
    </div>
  );
}

function ReadyCheck(
  { lobby, me, refresh }: { lobby: LobbySnapshot; me: string; refresh: () => void },
) {
  const left = useSecondsLeft(lobby.deadline);
  useCountdownChrome('Ready check', left);
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
  useCountdownChrome('Campaign vote', left);
  const total = Object.values(lobby.votes).reduce((a, b) => a + b, 0);
  const leader = Math.max(0, ...Object.values(lobby.votes));

  return (
    <Panel>
      <p class="eyebrow">Vote for a campaign</p>
      <Countdown deadline={lobby.deadline} left={left} />
      <div class="votes">
        {lobby.options.map((c) => {
          const n = lobby.votes[c] ?? 0;
          const mine = lobby.myVote === c;
          return (
            <button
              key={c}
              class={`vote ${mine ? 'vote--mine' : ''} ${n > 0 && n === leader ? 'vote--leading' : ''}`}
              style={{ '--campaign': campaignTint(c) } as Record<string, string>}
              onClick={() => api.vote(c).catch(() => {}).then(refresh)}
            >
              <span class="vote__name">{campaignName(c)}</span>
              <span class="vote__count num">{n}</span>
              <span
                class="vote__bar"
                style={{ width: total === 0 ? '0%' : `${(n / total) * 100}%` }}
              />
            </button>
          );
        })}
      </div>
      {total === 0 && <Empty>No votes yet. A random campaign is picked if nobody votes.</Empty>}
    </Panel>
  );
}
