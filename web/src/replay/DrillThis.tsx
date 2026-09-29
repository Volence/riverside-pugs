import { useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError, type DrillActor, type DrillSpec, type PracticeLease } from '../api';
import { formatTime } from './ReplayControls';
import { leasePath, setupText } from '../practice';
import { ConnectPanel } from '../components/ConnectPanel';
import { CopyRow } from '../components/CopyRow';

/** How often the panel re-reads a server that is still setting up. */
const SERVER_POLL_MS = 4_000;

type ServerState =
  | { kind: 'checking' }
  | { kind: 'unavailable' }
  | { kind: 'none' }
  /** The viewer's one owned server is a Hunter Training server: a drill
   *  server would be refused until they close it. */
  | { kind: 'hunter'; leaseId: number }
  | { kind: 'own'; lease: PracticeLease; loaded: boolean }
  | { kind: 'started'; lease: PracticeLease };

/** A drill server's way in: the connect line (password first), the password
 *  and the invite link on their own with Copy, and its page. */
function LeaseConnect({ lease }: { lease: PracticeLease }) {
  if (!lease.connect) return null;
  return (
    <div class="drill__lease">
      <ConnectPanel connect={lease.connect} />
      <CopyRow label="Password" value={lease.connect.password} />
      {lease.isOwner && (
        <CopyRow label="Invite link" value={`${location.origin}${leasePath(lease.id)}`}
          hint="Anyone logged in who opens it gets the connect line. Only you run the drill." />
      )}
      <p class="drill__page"><a href={leasePath(lease.id)}>Server page</a> (time left, close it)</p>
    </div>
  );
}

/** What the panel says for each survivor character and infected class. */
const CLASS_LABEL: Record<string, string> = {
  bill: 'Bill', zoey: 'Zoey', francis: 'Francis', louis: 'Louis',
  smoker: 'Smoker', boomer: 'Boomer', hunter: 'Hunter', tank: 'Tank',
};

/** One actor's health as the panel prints it: permanent plus temp when there
 *  is any, and the state that changes what that number means. */
export function actorHealth(a: DrillActor): string {
  const hp = a.temp > 0 ? `${a.health}+${a.temp}` : String(a.health);
  if (a.ghost) return `${hp} HP, ghost`;
  if (a.incap) return `${hp} HP, down`;
  return `${hp} HP`;
}

type State =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'signin' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; code: string; spec: DrillSpec };

/**
 * "Drill this": turn the moment on screen into a replay drill.
 *
 * The site stores the moment as a drill spec and answers with a short code;
 * a player types `!drill <code>` in any server running practice mode and the
 * practice plugin rebuilds the situation from it (l4d/practice/DESIGN.md).
 * What the result leads with depends on the viewer (owner, 2026-09-28).
 * Without a drill server of their own, the primary button starts one with
 * the drill preloaded (src/practiceLeases.ts) and the panel turns into its
 * connect line, password and invite link while it sets up. With one, the
 * primary button loads this drill on it (sm_drill_load over rcon) and shows
 * its connect line. Either way the code and its `!drill` line follow as the
 * secondary way in, for any other practice server, and the actors close it.
 * A signed-out viewer cannot make a drill at all and is asked to log in.
 *
 * Only offered on a finished match, and the server refuses anything else
 * regardless: a frame carries ghost positions. The moment comes from the
 * viewer's own clock through `momentRef`, the same way "Report this moment"
 * reads it, so pausing on the setup and pressing the button drills exactly
 * what is on screen. A timeline bookmark already seeks three seconds before
 * its event (BOOKMARK_LEAD_MS), so "click the bookmark, then Drill this" is
 * the bookmark flow, with no second button per entry.
 *
 * A signed-out viewer sees the button too, and is told to sign in when they
 * press it, rather than never learning the feature exists.
 */
export function DrillThis(
  { matchId, ordinal, half, momentRef, signedIn, autoStart = false, onHide }: {
    matchId: number; ordinal: number; half: number;
    momentRef: { current: number };
    signedIn: boolean;
    /** Make the drill on mount, as if the button had been pressed. Theater
     *  mode's own "Drill this" chip opens this panel already meaning "drill
     *  what is on screen now", so a second press inside it would be noise. */
    autoStart?: boolean;
    /** Given by a container that closes (theater's overlay): Hide becomes
     *  Close and calls this, and the sign-in and error states get a Close
     *  too, since the overlay has no other way out but its toolbar chip. */
    onHide?: () => void;
  },
) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [copied, setCopied] = useState(false);
  // Where this drill can be played, once there is one. `checking` while the
  // panel asks whether the viewer already has a drill server of their own;
  // `none` when they do not (the primary action starts one); `own` when they
  // do (the primary action loads this drill on it); `started` for the server
  // this panel just leased. `loaded` says the drill was sent to `own`.
  const [server, setServer] = useState<ServerState>({ kind: 'checking' });
  const [serverBusy, setServerBusy] = useState(false);
  const [serverError, setServerError] = useState('');

  // A round switch keeps this component mounted, and a code for the other
  // round must not stay on screen as if it were this one's. Compared against
  // the round it was last rendered for rather than reset on every effect run:
  // effects run after paint, so a reset on mount could land after a fast
  // first click and wipe its answer.
  const round = `${matchId}/${ordinal}/${half}`;
  const shownFor = useRef(round);
  useEffect(() => {
    if (shownFor.current === round) return;
    shownFor.current = round;
    setState({ kind: 'idle' });
    setServer({ kind: 'checking' });
    setServerError('');
  }, [round]);

  // Tracked so a navigation within the 2 s "Copied" window cannot set state
  // on an unmounted component (same as ConnectPanel).
  const resetTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (resetTimeout.current !== null) clearTimeout(resetTimeout.current);
  }, []);

  const create = async () => {
    if (!signedIn) { setState({ kind: 'signin' }); return; }
    setState({ kind: 'busy' });
    // An answer that arrives after the round switched belongs to the old one.
    const asked = round;
    try {
      const { code, spec } = await api.createDrill({ matchId, ordinal, half, tMs: Math.round(momentRef.current) });
      if (shownFor.current !== asked) return;
      setState({ kind: 'done', code, spec });
    } catch (err) {
      if (shownFor.current !== asked) return;
      if (err instanceof ApiError && err.status === 401) { setState({ kind: 'signin' }); return; }
      setState({ kind: 'error', message: err instanceof Error ? err.message : 'Could not make a drill.' });
    }
  };

  const copy = async (line: string) => {
    try {
      await navigator.clipboard.writeText(line);
      setCopied(true);
      resetTimeout.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied. The line is on screen to type by hand.
    }
  };

  // Once a drill exists: does the viewer already have a drill server? The
  // park list carries the viewer's own open lease; only a drill server takes
  // a drill from here (the park is shared, and a drill there would pull
  // everyone into it).
  const done = state.kind === 'done';
  useEffect(() => {
    if (!done) return;
    let alive = true;
    setServer({ kind: 'checking' });
    (async () => {
      try {
        const { available, mine } = await api.practiceParks();
        // Practice servers are not open to this viewer (the rollout switch):
        // the panel is the code alone, as it was before servers existed.
        if (!available) { if (alive) setServer({ kind: 'unavailable' }); return; }
        if (mine?.kind === 'hunter') { if (alive) setServer({ kind: 'hunter', leaseId: mine.id }); return; }
        if (!mine || mine.kind !== 'drill') { if (alive) setServer({ kind: 'none' }); return; }
        const lease = await api.practiceLease(mine.id);
        if (alive) setServer(lease.state === 'ready' || lease.state === 'setting_up' ? { kind: 'own', lease, loaded: false } : { kind: 'none' });
      } catch {
        if (alive) setServer({ kind: 'unavailable' });
      }
    })();
    return () => { alive = false; };
  }, [done]);

  // While a server this panel shows is setting up, follow it until it is
  // ready (or gone), so the status line tells the truth.
  const watched = server.kind === 'own' || server.kind === 'started' ? server.lease : null;
  useEffect(() => {
    if (!watched || watched.state !== 'setting_up') return;
    const t = setTimeout(async () => {
      try {
        const fresh = await api.practiceLease(watched.id);
        setServer((cur) => (cur.kind === 'own' || cur.kind === 'started') && cur.lease.id === fresh.id
          ? { ...cur, lease: fresh } : cur);
      } catch {
        // The next render keeps the last reading; nothing to recover.
      }
    }, SERVER_POLL_MS);
    return () => clearTimeout(t);
  }, [watched]);

  /** Lease a private drill server with this code preloaded
   *  (src/practiceLeases.ts). Answers once the box is reserved and checked
   *  empty; the setup carries on and the status follows it. */
  const startServer = async (code: string) => {
    setServerBusy(true);
    setServerError('');
    try {
      const { lease } = await api.startPractice({ kind: 'drill', drillCode: code });
      setServer({ kind: 'started', lease });
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Could not start a drill server.');
    } finally {
      setServerBusy(false);
    }
  };

  /** Send this drill to the viewer's own drill server (sm_drill_load). */
  const loadOnOwn = async (lease: PracticeLease, code: string) => {
    setServerBusy(true);
    setServerError('');
    try {
      const fresh = await api.loadDrillOnLease(lease.id, code);
      setServer({ kind: 'own', lease: fresh, loaded: true });
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Could not load the drill on your server.');
    } finally {
      setServerBusy(false);
    }
  };

  // Once, on mount; never again on a re-render.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStarted.current) return;
    autoStarted.current = true;
    void create();
  }, []);

  const button = (
    <button class="chip" type="button" disabled={state.kind === 'busy'}
      title="Pause on the setup you want to practise, then press this" onClick={create}>
      {state.kind === 'busy' ? 'Making drill...' : 'Drill this'}
    </button>
  );

  if (state.kind === 'idle' || state.kind === 'busy') return button;

  if (state.kind === 'signin') {
    const next = typeof location === 'undefined' ? '/' : location.pathname + location.search + location.hash;
    return (
      <span class="drill__note">
        {button}{' '}
        {/* target _top: /auth/steam is a backend route, see Play.tsx. */}
        <a href={`/auth/steam?next=${encodeURIComponent(next)}`} target="_top" rel="noopener">Log in to start a drill server</a>
        {onHide && <button class="chip" type="button" onClick={onHide}>Close</button>}
      </span>
    );
  }

  if (state.kind === 'error') {
    return (
      <span class="drill__note">
        {button} <span class="drill__error" role="alert">{state.message}</span>
        {onHide && <button class="chip" type="button" onClick={onHide}>Close</button>}
      </span>
    );
  }

  const { code, spec } = state;
  const line = `!drill ${code}`;
  const leased = server.kind === 'own' || server.kind === 'started';
  const serverless = server.kind === 'unavailable';
  return (
    <div class="drill" role="region" aria-label="Replay drill">
      <div class="drill__head">
        <p class="eyebrow">Replay drill · {formatTime(spec.source.tMs)}</p>
        <button class="chip" type="button" onClick={() => { setState({ kind: 'idle' }); onHide?.(); }}>{onHide ? 'Close' : 'Hide'}</button>
      </div>

      {!serverless && <div class="drill__primary">
        {server.kind === 'checking' && <p class="muted">Checking for a practice server of yours...</p>}
        {server.kind === 'none' && (
          <>
            <button class="btn btn--block" type="button" disabled={serverBusy} onClick={() => startServer(code)}>
              {serverBusy ? 'Starting a drill server...' : 'Start a drill server'}
            </button>
            <p class="muted drill__hint">A private server with this drill loaded. Share its invite link to bring friends; only you run the drill.</p>
          </>
        )}
        {server.kind === 'hunter' && (
          <p class="muted drill__hint">
            Close <a href={leasePath(server.leaseId)}>your Hunter Training server</a> first to start a drill server:
            you can have one of your own at a time.
          </p>
        )}
        {server.kind === 'own' && !server.loaded && (
          <button class="btn btn--block" type="button" disabled={serverBusy || server.lease.state !== 'ready'}
            onClick={() => loadOnOwn(server.lease, code)}>
            {serverBusy ? 'Loading...' : server.lease.state === 'ready' ? 'Load this drill on your server' : 'Your server is still setting up...'}
          </button>
        )}
        {server.kind === 'own' && server.loaded && (
          <p class="drill__status" role="status">Sent to {server.lease.server}. The drill loads in a few seconds.</p>
        )}
        {server.kind === 'started' && server.lease.state === 'setting_up' && (
          <p class="drill__status" role="status">{setupText(server.lease)}</p>
        )}
        {server.kind === 'started' && server.lease.state === 'ready' && (
          <p class="drill__status" role="status">{server.lease.server} is ready with this drill loaded.</p>
        )}
        {serverError && <p class="drill__error" role="alert">{serverError}</p>}
        {leased && <LeaseConnect lease={server.lease} />}
      </div>}

      <div class={serverless ? 'drill__only' : `drill__secondary${leased ? ' drill__secondary--quiet' : ''}`}>
        <p class={`drill__code${leased ? ' drill__code--small' : ''}`} aria-label={`Drill code ${code}`}>{code}</p>
        <p class="drill__how">{serverless ? 'Type' : 'Or type'} <code>{line}</code> in {serverless ? 'a' : 'any'} practice server</p>
        <div class="connect__line drill__line">
          <code>{line}</code>
          <button class="btn btn--block btn--ghost" type="button" onClick={() => copy(line)}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
      </div>
      <p class="muted drill__title">{spec.title}</p>
      {spec.actors.length === 0
        ? <p class="muted">Nobody was alive at this moment.</p>
        : (
          <ul class="drill__actors">
            {spec.actors.map((a, i) => (
              <li key={i} class={`drill__actor drill__actor--${a.side}`}>
                <span class="drill__side">{a.side === 'survivor' ? 'Survivor' : 'Infected'}</span>
                <span class="drill__cls">{CLASS_LABEL[a.cls] ?? a.cls}</span>
                <span class="drill__name">{a.name || <span class="muted">bot</span>}</span>
                <span class="drill__hp num">{actorHealth(a)}</span>
              </li>
            ))}
          </ul>
        )}
      {spec.entities.length > 0 && (
        <p class="muted drill__entities">
          Also: {spec.entities.map((e) => `${e.kind === 'witch' ? 'Witch' : `AI ${CLASS_LABEL[e.kind] ?? e.kind}`} (${e.health} HP)`).join(', ')}
        </p>
      )}
    </div>
  );
}
