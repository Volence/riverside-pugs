import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type EndorseKind, type EndorseState } from '../api';
import { ENDORSE_KINDS, ENDORSE_LABEL, hoursLeft } from '../endorse';
import { Panel } from './bits';

/**
 * The same endorse panel the Discord result card opens, on the match page.
 *
 * It is a panel on a page somebody chose to open, not a notification. A
 * viewer who may not endorse here (signed out, not on the roster, window
 * closed) gets no panel at all rather than an explanation of a feature they
 * cannot use.
 *
 * Anonymous by construction: `given` is the viewer's own choices, and that is
 * the only giver-side fact the server ever sends anybody.
 */
export function EndorsePanel({ matchId }: { matchId: number }) {
  const [state, setState] = useState<EndorseState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ac = new AbortController();
    setState(null);
    api.endorseState(matchId, ac.signal).then(setState).catch(() => setState(null));
    return () => ac.abort();
  }, [matchId]);

  // The quiet bar links here as /match/N#endorse. The panel arrives after the
  // page, so the browser's own jump to the fragment has already missed it.
  const eligible = state?.eligible === true;
  useEffect(() => {
    if (eligible && window.location.hash === '#endorse') root.current?.scrollIntoView?.({ block: 'center' });
  }, [eligible]);

  if (!state || !state.eligible) return null;

  const givenTo = new Map(state.given.map((g) => [g.to, g.kind]));
  const left = hoursLeft(state.closesAt);

  const give = async (to: string, kind: EndorseKind) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.endorse(matchId, to, kind);
      setState(r.state);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that endorsement.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div id="endorse" ref={root}>
      <Panel>
        <h3>Endorse your lobby</h3>
        <p class="muted">
          {state.remaining > 0
            ? `${state.remaining} of ${state.budget} left.`
            : 'You have given all your endorsements for this match.'}
          {' '}It is anonymous: nobody sees who endorsed them.
          {left !== null && state.remaining > 0 ? ` Closes in about ${left} hour${left === 1 ? '' : 's'}.` : ''}
        </p>
        {error && <p class="endorse__error" role="alert">{error}</p>}
        <ul class="endorse">
          {state.candidates.map((c) => {
            const kind = givenTo.get(c.steamid);
            return (
              <li class="endorse__row" key={c.steamid}>
                <span class="endorse__name">{c.name}</span>
                {kind
                  ? <span class={`titletag titletag--${kind}`}>{ENDORSE_LABEL[kind]}</span>
                  : (
                    <span class="endorse__kinds">
                      {ENDORSE_KINDS.map((k) => (
                        <button
                          type="button" class="chip" key={k}
                          disabled={busy || state.remaining <= 0}
                          onClick={() => give(c.steamid, k)}
                        >
                          {ENDORSE_LABEL[k]}
                        </button>
                      ))}
                    </span>
                  )}
              </li>
            );
          })}
        </ul>
      </Panel>
    </div>
  );
}
