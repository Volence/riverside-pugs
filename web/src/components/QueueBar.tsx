import { useEffect } from 'preact/hooks';
import type { StateSnapshot } from '../api';
import { QUEUE_SIZE } from '../queueSize';
import { campaignName, fmtClock, secondsLeft } from '../format';
import { useSecondsLeft } from './Countdown';

const URGENT_AT = 10;

export interface QueueBarStatus {
  kind: 'queue' | 'ready_check' | 'map_vote' | 'match';
  text: string;
  /** Drives the red nav border and the tab title. Reserved for states where
   *  looking at another page can actually cost you the game. */
  urgent: boolean;
  /** Epoch ms, for the states that run on a clock. */
  deadline: number | null;
  /** Tab title prefix while a clock is running, null when there is none. */
  title: string | null;
}

/**
 * What the bar should say, as a pure function of the viewer's state.
 *
 * Split out from the component so the precedence rules are testable without a
 * DOM. The order below deliberately mirrors `Live` in routes/Play.tsx: match,
 * then ready check, then map vote, then queue. Two different answers to "what
 * is happening to me right now" on the same screen would be worse than either.
 */
export function queueBarStatus(state: StateSnapshot | null): QueueBarStatus | null {
  if (!state) return null;
  const { queue, lobby, match } = state;

  if (match) {
    if (match.waitingForServer) {
      // Deliberately not urgent. With one server this can last an entire
      // other match, and a bar that shouts for twenty minutes is a bar people
      // learn to ignore by the time it matters.
      return {
        kind: 'match', text: `Waiting for a server · ${campaignName(match.campaign)}`,
        urgent: false, deadline: null, title: null,
      };
    }
    if (match.state === 'live') {
      return {
        kind: 'match', text: `Match live · ${campaignName(match.campaign)}`,
        urgent: true, deadline: null, title: null,
      };
    }
    return {
      kind: 'match', text: `Setting up · ${campaignName(match.campaign)}`,
      urgent: false, deadline: null, title: null,
    };
  }

  if (lobby && lobby.phase === 'ready_check') {
    return {
      kind: 'ready_check', text: 'Ready check', urgent: true,
      deadline: lobby.deadline, title: 'Ready check',
    };
  }
  if (lobby && lobby.phase === 'map_vote') {
    // Not urgent: missing the vote costs you a preference, not the match.
    return {
      kind: 'map_vote', text: 'Campaign vote', urgent: false,
      deadline: lobby.deadline, title: 'Campaign vote',
    };
  }

  // Only when the viewer is actually in it. This is a personal status line,
  // not a site-wide ticker: showing a queue someone has not joined would make
  // every page nag about a game they are not playing.
  if (queue.joined) {
    return {
      kind: 'queue', text: `In queue ${queue.count}/${QUEUE_SIZE}`,
      urgent: false, deadline: null, title: null,
    };
  }
  return null;
}

/**
 * A persistent status line for the viewer's own queue, lobby or match.
 *
 * Mounted in the app shell rather than in a route, which is the entire point:
 * before this, `useCountdownChrome` was only ever called from inside
 * routes/Play.tsx, so navigating to the leaderboard unmounted it and its
 * cleanup stripped `data-urgent` from the body. The red nav border its own
 * comment describes as "visible from the leaderboard page" was therefore
 * dead on exactly the pages it existed to serve. Being always mounted is what
 * fixes that, and it is why this component owns the body flag and the tab
 * title outright instead of sharing them with the route.
 *
 * Hidden on the play page, never unmounted there: that page already renders
 * all of this at full size, so a duplicate bar is noise, but the chrome still
 * needs a single owner everywhere.
 */
export function QueueBar({ state, path }: { state: StateSnapshot | null; path: string }) {
  const status = queueBarStatus(state);
  const deadline = status?.deadline ?? null;
  // Hooks cannot be conditional, so the clock always runs; with no deadline it
  // is handed a resolved one and simply reads zero.
  const left = useSecondsLeft(deadline ?? 0);
  const urgent = (status?.urgent ?? false) && (deadline === null || left <= URGENT_AT);
  const title = status?.title ?? null;

  useEffect(() => {
    if (!urgent) return;
    document.body.setAttribute('data-urgent', 'true');
    return () => document.body.removeAttribute('data-urgent');
  }, [urgent]);

  useEffect(() => {
    if (title === null) return;
    document.title = `(${fmtClock(secondsLeft(deadline ?? 0))}) ${title}`;
    return () => { document.title = 'Riverside'; };
  }, [title, left, deadline]);

  if (!status || path === '/') return null;

  return (
    <a
      class={`queuebar queuebar--${status.kind}${urgent ? ' is-urgent' : ''}`}
      href="/"
      aria-live={status.urgent ? 'assertive' : 'polite'}
    >
      <span class="queuebar__dot" aria-hidden="true" />
      <span class="queuebar__text">{status.text}</span>
      {deadline !== null && <span class="queuebar__clock">{fmtClock(left)}</span>}
      <span class="queuebar__cta">Open</span>
    </a>
  );
}
