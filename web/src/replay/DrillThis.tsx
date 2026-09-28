import { useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError, type DrillActor, type DrillSpec } from '../api';
import { formatTime } from './ReplayControls';

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
 * There is no server to reserve and nothing to join from here, so the whole
 * result is the code, a line to copy, and who will be where.
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
  { matchId, ordinal, half, momentRef, signedIn }: {
    matchId: number; ordinal: number; half: number;
    momentRef: { current: number };
    signedIn: boolean;
  },
) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [copied, setCopied] = useState(false);

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
        <a href={`/auth/steam?next=${encodeURIComponent(next)}`} target="_top" rel="noopener">Log in to create drills</a>
      </span>
    );
  }

  if (state.kind === 'error') {
    return <span class="drill__note">{button} <span class="drill__error" role="alert">{state.message}</span></span>;
  }

  const { code, spec } = state;
  const line = `!drill ${code}`;
  return (
    <div class="drill" role="region" aria-label="Replay drill">
      <div class="drill__head">
        <p class="eyebrow">Replay drill · {formatTime(spec.source.tMs)}</p>
        <button class="chip" type="button" onClick={() => setState({ kind: 'idle' })}>Hide</button>
      </div>
      <p class="drill__code" aria-label={`Drill code ${code}`}>{code}</p>
      <p class="drill__how">Type <code>{line}</code> in a practice server</p>
      <div class="connect__line drill__line">
        <code>{line}</code>
        <button class="btn btn--block" type="button" onClick={() => copy(line)}>{copied ? 'Copied' : 'Copy'}</button>
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
