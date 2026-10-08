import { useState } from 'preact/hooks';
import { ApiError, appealApi, type MyAppeals, type PlayerAppealItem } from '../api';
import { useFetch } from '../hooks/useFetch';

const what = (it: PlayerAppealItem) => (it.hold ? 'Account hold'
  : it.sanctionKind === 'timeout' ? 'Discord timeout'
    : it.sanctionKind === 'ban' ? 'Discord ban' : 'Ban');

/**
 * Everything a banned person can do about it: one entry per ban, hold or
 * Discord sanction, each with the form, the refusal, or where its appeal
 * stands. Used on the Play page (Steam session) and on /appeal (either).
 * `fallback` is what the page said before appeals existed, shown while the
 * feature is off.
 */
export function AppealBox({ fallback }: { fallback: string }) {
  const fetched = useFetch((s) => appealApi.mine(s), []);
  const data = fetched.data;
  if (!data) return fetched.error ? <p class="muted">{fallback}</p> : null;
  if (!data.enabled) return <p class="muted">{fallback}</p>;
  if (data.items.length === 0) return <p class="muted">You have nothing to appeal.</p>;
  return <div class="stack">{data.items.map((it) => <Item key={`${it.ref.kind}:${it.ref.id}`} it={it} data={data} reload={fetched.reload} />)}</div>;
}

function Item({ it, data, reload }: { it: PlayerAppealItem; data: MyAppeals; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const send = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await fn(); setOpen(false); reload(); } catch (err) { setError(err instanceof ApiError ? err.message : 'Something went wrong.'); } finally { setBusy(false); }
  };
  const ap = it.appeal;
  // The status line and the refusal say the same thing after a denial in
  // cooldown ("You can appeal again after X"): showing both is a double-up,
  // not two pieces of information, so the refusal is suppressed whenever
  // the status line is already on screen.
  const statusShown = !!(ap && (!it.canAppeal || ap.state === 'asked') && ap.line);
  const settled = ap && !['open', 'asked', 'answered'].includes(ap.state);
  return (
    <div class="appeal-item">
      <p><strong>{what(it)}</strong>: {it.reason}{it.endsAt ? `, ends ${new Date(it.endsAt).toLocaleString()}` : ''}</p>
      {statusShown && <p>{ap!.line}</p>}
      {ap && !settled && ap.messages.length > 0 && (
        <ol class="appeal-thread">
          {ap.messages.map((m, i) => (
            <li key={i} class={m.fromStaff ? 'appeal-msg appeal-msg--staff' : 'appeal-msg'}>
              <p class="appeal-msg__who">{m.fromStaff ? 'Staff' : 'You'} · {new Date(m.at).toLocaleString()}</p>
              <blockquote class="appeal-text">{m.body}</blockquote>
            </li>
          ))}
        </ol>
      )}
      {ap && ap.canWrite && (
        <>
          <label>{ap.state === 'asked' ? 'Your reply' : 'Add to your appeal'}
            <textarea maxLength={data.answerMax} value={answer} onInput={(e) => setAnswer((e.target as HTMLTextAreaElement).value)} />
          </label>
          <button class="btn" disabled={busy || !answer.trim()} onClick={() => send(() => appealApi.message(ap.id, answer).then(() => setAnswer('')))}>Send</button>
        </>
      )}
      {it.refusal && !statusShown && <p class="muted">{it.refusal}</p>}
      {it.canAppeal && !open && <button class="btn" onClick={() => setOpen(true)}>Appeal this ban</button>}
      {it.canAppeal && open && (
        <>
          <p class="muted">You get one appeal at a time. Staff may write back with questions, and you can reply here; keep it to what happened.</p>
          <label>What happened?
            <textarea maxLength={data.textMax} value={a} onInput={(e) => setA((e.target as HTMLTextAreaElement).value)} />
          </label>
          <label>Why should it be lifted or shortened?
            <textarea maxLength={data.textMax} value={b} onInput={(e) => setB((e.target as HTMLTextAreaElement).value)} />
          </label>
          <button class="btn" disabled={busy || !a.trim() || !b.trim()} onClick={() => send(() => appealApi.file(it.ref, a, b))}>Send appeal</button>
        </>
      )}
      {error && <p class="error">{error}</p>}
    </div>
  );
}
