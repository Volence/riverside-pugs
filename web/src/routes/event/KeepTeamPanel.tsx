import { useState } from 'preact/hooks';
import { ApiError, eventsApi } from '../../api';
import { Panel } from '../../components/bits';
import { whenText } from '../../eventFormat';
import { useFetch } from '../../hooks/useFetch';

const ANSWER = { accept: 'Accepted', decline: 'Declined' } as const;

/** Keep this team on a finished draft event (plan D3b), for the team's four
 *  only: the captain's Keep form, everyone's answers, Accept and Decline, and
 *  the team page once it is made. */
export function KeepTeamPanel({ slug }: { slug: string }) {
  const { data, reload } = useFetch((s) => eventsApi.keep(slug, s), [slug]);
  const [name, setName] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      const r = await fn();
      if (r && typeof r === 'object' && (r as { closed?: unknown }).closed === true) setNote('This keep was closed and no team was made.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
      reload();
    }
  };
  const k = data?.keep ?? null;
  if (!k) return null;
  const canAnswer = !k.captain && k.myAnswer === null && !k.closed;
  return (
    <Panel class="entrypanel keeppanel">
      <h3>Keep this team</h3>
      {k.status === 'offered' && !k.closed && (k.captain ? (
        <>
          <p>Keep {k.team} together as a real team. Your three are asked; it is made when 3 of the 4 of you accept.</p>
          <div class="inlinerow">
            <label>Team name <input value={name ?? k.defaults.name} maxLength={24} onInput={(e) => setName((e.target as HTMLInputElement).value)} /></label>
            <label>Tag <input placeholder="2 to 5 letters" value={tag ?? k.defaults.tag} maxLength={5} onInput={(e) => setTag((e.target as HTMLInputElement).value)} /></label>
            <button class="btn" disabled={busy} onClick={() => run(() => eventsApi.startKeep(slug, { name: (name ?? k.defaults.name).trim(), tag: (tag ?? k.defaults.tag).trim() }))}>Keep this team</button>
          </div>
        </>
      ) : <p class="muted">Your captain can keep {k.team} together as a real team until {whenText(k.expiresAt)}.</p>)}
      {k.status === 'made' && k.made && (
        <p>
          <a href={`/team/${k.made.slug}`}>{k.made.name} [{k.made.tag}]</a> is a team now{canAnswer ? `. Accept to join by ${whenText(k.expiresAt)}.` : '.'}
        </p>
      )}
      {k.status === 'voting' && <p>{k.name} [{k.tag}]: made when 3 of the 4 of you accept{k.closed ? '' : `, by ${whenText(k.expiresAt)}`}.</p>}
      {(k.status === 'voting' || k.status === 'made') && (
        <>
          <ul class="admin-list">
            {k.players.map((p) => <li key={p.steamid}>{p.name}{p.captain ? ' (captain)' : ''} · {p.answer ? ANSWER[p.answer] : 'No answer yet'}</li>)}
          </ul>
          {canAnswer && (
            <div class="inlinerow">
              <button class="btn" disabled={busy} onClick={() => run(() => eventsApi.answerKeep(slug, true))}>Accept</button>
              <button class="btn btn--ghost" disabled={busy} onClick={() => run(() => eventsApi.answerKeep(slug, false))}>Decline</button>
            </div>
          )}
        </>
      )}
      {(k.status === 'lapsed' || (k.status === 'offered' && k.closed)) && <p class="muted">Keep this team has closed.</p>}
      {note && <p class="muted">{note}</p>}
      {error && <p class="error" role="alert">{error}</p>}
    </Panel>
  );
}
