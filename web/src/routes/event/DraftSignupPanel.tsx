import { useState } from 'preact/hooks';
import { ApiError, eventsApi, type CaptainPref, type EventDraftView, type EventStatus, type MyEventView } from '../../api';
import { Panel } from '../../components/bits';
import { confirm } from '../../components/Confirm';
import { whenText } from '../../eventFormat';

const PREF_LABEL: Record<CaptainPref, string> = {
  want: 'I want to captain',
  willing: 'I\'ll captain if needed',
  no: 'I don\'t want to captain',
};
const NOTE_MAX = 80;

/** The server's sentence, then one line per named player (as EntryPanel does). */
function errorLines(err: unknown): string[] {
  if (!(err instanceof ApiError)) return ['Something went wrong.'];
  return [err.message, ...(err.problems ?? []).map((p) => `${p.name}: ${p.problems.join(', ')}`)];
}

function roleLine(role: 'captain' | 'pool' | 'bench', draftAt: string): string {
  const when = whenText(draftAt);
  if (role === 'captain') return `You are a captain. The draft is ${when}. Build your pick list before then.`;
  if (role === 'pool') return `You are in the draft pool. The draft is ${when}; captains pick you live.`;
  return 'You are on the free-agent bench. Captains can call on you as a stand-in, so keep the night free if you can.';
}

/** The signed-in player's part of a draft event page (drafts plan D1, Task 6):
 *  sign up, withdraw, see their role once the cut is published, and answer a
 *  captaincy offer. Everything shown here is the viewer's own. */
export function DraftSignupPanel({ slug, eventName, status, lockedAt, draft, view, onChange }: {
  slug: string; eventName: string; status: EventStatus; lockedAt: string | null; draft: EventDraftView; view: MyEventView; onChange: () => void;
}) {
  const [pref, setPref] = useState<CaptainPref>('no');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string[]>([]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError([]);
    try {
      await fn();
      onChange();
    } catch (err) {
      setError(errorLines(err));
    } finally {
      setBusy(false);
    }
  };

  const signup = view.signup ?? null;
  const offer = view.offer ?? null;
  const published = draft.cut !== null;
  // Signups close on the clock even before the tick stamps the lock.
  const open = status === 'registration' && lockedAt === null && Date.now() < Date.parse(draft.signupsCloseAt);
  const notOpenYet = (status === 'announced' || status === 'draft') && lockedAt === null && Date.now() < Date.parse(draft.signupsCloseAt);

  if (!signup && !open && !offer && !notOpenYet) return null;

  return (
    <Panel class="entrypanel draftpanel">
      {offer && (
        <div class="draftoffer" role="group" aria-label="Captaincy offer">
          <p><strong>{eventName} needs another captain. Accept by {whenText(offer.expiresAt)}?</strong></p>
          <div class="inlinerow">
            <button class="btn" disabled={busy} onClick={() => run(() => eventsApi.answerCaptainOffer(slug, true))}>Accept</button>
            <button class="btn btn--ghost" disabled={busy} onClick={() => run(() => eventsApi.answerCaptainOffer(slug, false))}>Decline</button>
          </div>
        </div>
      )}
      {signup && published && signup.role && (
        <>
          <h3>Your role: {signup.role === 'captain' ? 'Captain' : signup.role === 'pool' ? 'Pool' : 'Bench'}</h3>
          <p>{roleLine(signup.role, draft.draftAt)}</p>
        </>
      )}
      {signup && !(published && signup.role) && (
        <>
          {open ? (
            <>
              <h3>You are signed up</h3>
              <p>{PREF_LABEL[signup.captainPref]}{signup.note && <span class="muted"> · {signup.note}</span>}</p>
              <div class="inlinerow">
                <button class="btn btn--ghost" disabled={busy} onClick={async () => {
                  if (await confirm({ title: 'Withdraw your signup?', body: 'You leave the draft. You can sign up again until signups close.', confirmLabel: 'Withdraw' })) {
                    void run(() => eventsApi.withdrawSignup(slug));
                  }
                }}>Withdraw</button>
              </div>
            </>
          ) : (
            <>
              <h3>You are signed up</h3>
              <p class="muted">{PREF_LABEL[signup.captainPref]}{signup.note && ` · ${signup.note}`}</p>
              <p>Signups are closed. Staff are making the cut; you will get a DM with your role.</p>
            </>
          )}
        </>
      )}
      {!signup && open && (
        <>
          <h3>Sign up</h3>
          <div class="draftpanel__prefs" role="radiogroup" aria-label="Captain choice">
            {(['want', 'willing', 'no'] as const).map((p) => (
              <label key={p} class="draftpanel__pref">
                <input type="radio" name="captainPref" value={p} checked={pref === p} onChange={() => setPref(p)} /> {PREF_LABEL[p]}
              </label>
            ))}
          </div>
          <input
            class="draftpanel__note" type="text" maxLength={NOTE_MAX} value={note} aria-label="Note"
            placeholder="e.g. prefer infected, can't play after 02:00 UTC"
            onInput={(e) => setNote((e.target as HTMLInputElement).value)}
          />
          <button class="btn" disabled={busy} onClick={() => run(() => eventsApi.signUp(slug, { captainPref: pref, note: note.trim() }))}>Sign up</button>
        </>
      )}
      {!signup && notOpenYet && <p class="muted">Signups are not open yet.</p>}
      {error.length > 0 && <div class="error" role="alert">{error.map((l) => <p key={l}>{l}</p>)}</div>}
    </Panel>
  );
}
