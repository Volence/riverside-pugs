import { useEffect, useState } from 'preact/hooks';
import {
  api, ApiError, type Me, type LobbySnapshot, type NamedPlayer, type PublicQueue, type ReadyBlock, type StateSnapshot,
} from '../api';
import { campaignName, fmtClock, winnerLabel } from '../format';
import { Countdown, useSecondsLeft } from '../components/Countdown';
import { QUEUE_SIZE } from '../queueSize';
import { Empty, Panel, PlayerLink } from '../components/bits';
import { useFetch } from '../hooks/useFetch';
import { CampaignTiles } from '../components/CampaignTiles';
import { ConnectPanel } from '../components/ConnectPanel';
import { SpectatePanel } from '../components/SpectatePanel';
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
          {session.me.ban && <p>Reason: <strong>{session.me.ban.reason}</strong></p>}
          {session.me.ban?.expiresAt && <p>Ends {new Date(session.me.ban.expiresAt).toLocaleString()}.</p>}
          <p class="muted">To appeal, message an admin in the Discord.</p>
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
      <Landing />
    </div>
  );
}

/**
 * What a signed-out visitor sees below the sign-in box.
 *
 * Before this the front door was a title, a Steam button and an empty 0 / 8,
 * which says nothing about whether the thing is alive. Almost everyone arriving
 * here has followed a link from Discord and has never seen the site, so the job
 * of this block is to show that matches actually happen and that other people
 * play them, using data that is already public on three endpoints.
 *
 * Every section omits itself when it has no data rather than rendering an empty
 * shell, so a brand new install shows the hero alone instead of three headings
 * over nothing.
 */
function Landing() {
  const { data: live } = useFetch((s) => api.live(s), []);
  const { data: recent } = useFetch((s) => api.matches(s), []);
  const { data: board } = useFetch((s) => api.leaderboard(s), []);

  const liveMatch = live?.matches?.[0] ?? null;
  const matches = (recent?.matches ?? []).slice(0, 5);
  // Ranked only: a provisional player at the top of an empty board would
  // misrepresent the ladder to the one audience with no context for it.
  const top = (board?.rows ?? []).filter((r) => r.ranked).slice(0, 5);

  return (
    <>
      {liveMatch && (
        <Panel class="landing__live">
          <p class="eyebrow">Live now</p>
          <p class="landing__liveline">
            <a href="/live">{campaignName(liveMatch.campaign)}</a>
            {' · '}
            <span class="num">{liveMatch.teamAScore} - {liveMatch.teamBScore}</span>
          </p>
          <p class="muted">Anyone can watch. No account needed.</p>
        </Panel>
      )}

      {matches.length > 0 && (
        <Panel class="panel--table">
          <div class="panel__head"><h3>Recent matches</h3><a class="eyebrow" href="/matches">All</a></div>
          <table class="landing__table">
            <tbody>
              {matches.map((m) => (
                <tr key={m.id}>
                  <td class="campaign-cell"><a href={`/match/${m.id}`}>{campaignName(m.campaign)}</a></td>
                  <td class="num">{m.teamAScore} - {m.teamBScore}</td>
                  <td class="num muted">{m.winner ? winnerLabel(m.winner) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      {top.length > 0 && (
        <Panel class="panel--table">
          <div class="panel__head"><h3>Top rated</h3><a class="eyebrow" href="/leaderboard">Full ladder</a></div>
          <table class="landing__table">
            <tbody>
              {top.map((r, i) => (
                <tr key={r.steamid}>
                  <td class="num muted">{i + 1}</td>
                  <td class="pname"><PlayerLink steamid={r.steamid} name={r.name} /></td>
                  <td class="num">{r.sr}</td>
                  <td class="num muted">{r.wins}W {r.losses}L</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </>
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
        {match.spectate && <SpectatePanel spectate={match.spectate} />}
        {match.waitingForServer && (
          <Empty>Waiting for a free server. The match starts as soon as one opens up.</Empty>
        )}
      </Panel>
    );
  }

  if (lobby && lobby.phase === 'ready_check') {
    return <ReadyCheck lobby={lobby} me={me} refresh={refresh} readyBlock={state.readyBlock ?? null} />;
  }
  if (lobby && lobby.phase === 'map_vote') return <MapVote lobby={lobby} refresh={refresh} />;
  return (
    <>
      {state.lobbyNotice && <LobbyNotice notice={state.lobbyNotice} refresh={refresh} />}
      <QueuePanel
        count={queue.count} joined={queue.joined} players={queue.players} refresh={refresh}
        timeout={state.timeout ?? null} queueBlock={state.queueBlock ?? null} me={sessionMe}
      />
    </>
  );
}

/**
 * "The pop you were just in died, and here is why."
 *
 * The lobby card in #queue-here used to become this message. It is deleted
 * now and the detail goes to the admin channel instead (2026-09-20), so
 * without this the eight people in a failed ready check would watch the pop
 * simply disappear with no explanation anywhere they can see.
 *
 * Dismissing is a server call rather than local state, because the state it
 * is clearing lives on the server: hiding it in the browser alone would put
 * it back on the next refresh.
 */
export function LobbyNotice(
  { notice, refresh }: {
    notice: NonNullable<StateSnapshot['lobbyNotice']>;
    refresh: () => void;
  },
) {
  const [going, setGoing] = useState(false);
  const missing = notice.notReady.map((p) => p.name).join(', ');
  const dismiss = async () => {
    setGoing(true);
    try {
      await api.dismissNotice();
      refresh();
    } catch {
      // Nothing to recover: the notice is cosmetic, and it clears itself the
      // moment they queue again.
      setGoing(false);
    }
  };
  return (
    <Panel>
      <div class="lobby-notice">
        <div>
          <h3>{notice.removed ? 'Pop cancelled' : 'Ready check failed'}</h3>
          <p>
            {notice.removed ? (
              <>The pop was cancelled because {notice.removed.name} was removed from it by an admin.
                You went back to the front of the queue.</>
            ) : notice.youWereReady ? (
              <>You readied up. The pop was cancelled because {missing || 'someone'} did not,
                and you went back to the front of the queue.</>
            ) : (
              <>You did not ready up in time, so the pop was cancelled for everyone.
                That is a queue timeout; it gets longer each time within a week.</>
            )}
          </p>
        </div>
        <button type="button" class="btn btn--ghost" onClick={dismiss} disabled={going}>
          Dismiss
        </button>
      </div>
    </Panel>
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

/** Why a roster row cannot press Ready yet, short enough to sit on the row. */
const READY_BLOCK_TAG: Record<ReadyBlock, string> = {
  join_voice: 'not in voice',
  link_discord: 'no Discord',
};

/** The viewer's own block, spelled out under the button. */
const READY_BLOCK_NOTICE: Record<ReadyBlock, string> = {
  join_voice: 'Join a voice channel in the Riverside Discord to ready up.',
  link_discord: 'Link your Discord account to ready up.',
};

function ReadyCheck(
  { lobby, me, refresh, readyBlock = null }:
    { lobby: LobbySnapshot; me: string; refresh: () => void; readyBlock?: ReadyBlock | null },
) {
  const left = useSecondsLeft(lobby.deadline);
  const iAmReady = lobby.ready.includes(me);

  return (
    <Panel class="urgent-panel">
      <p class="eyebrow">Match found, ready up</p>
      <Countdown deadline={lobby.deadline} left={left} />
      <ul class="roster roster--ready">
        {lobby.players.map((p) => {
          const ready = lobby.ready.includes(p.steamid);
          const block = p.readyBlock ?? null;
          return (
            <li key={p.steamid} class={ready ? 'is-ready' : block ? 'is-blocked' : ''}>
              <span>{p.name}</span>
              {!ready && block && <span class="blocked-why">{READY_BLOCK_TAG[block]}</span>}
              <span class="tick" aria-label={ready ? 'ready' : 'not ready'}>{ready ? '✓' : '·'}</span>
            </li>
          );
        })}
      </ul>
      <button
        class="btn btn--block"
        disabled={iAmReady || readyBlock !== null}
        onClick={() => api.ready().catch(() => {}).then(refresh)}
      >
        {iAmReady ? `Ready, waiting for ${lobby.players.length - lobby.ready.length}` : 'Ready'}
      </button>
      {!iAmReady && readyBlock && <p class="ready-notice">{READY_BLOCK_NOTICE[readyBlock]}</p>}
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
