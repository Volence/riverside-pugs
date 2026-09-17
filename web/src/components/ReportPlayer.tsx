import { useState } from 'preact/hooks';
import { api, ApiError, type ReportEligibility } from '../api';

const CATEGORIES = [
  ['griefing', 'Griefing / throwing'],
  ['cheating', 'Cheating'],
  ['toxicity', 'Toxicity / harassment'],
  ['afk', 'AFK / left the game'],
  ['other', 'Something else'],
] as const;

/**
 * "Report a player" on a match page. Shown only to signed-in players; whether
 * they may report (on the roster, within 48 hours) is asked of the server when
 * they open it, since only the server knows the roster rules. Admins see
 * reports in the admin panel; the reported player is never told who filed one.
 */
export function ReportPlayer({ matchId }: { matchId: number }) {
  const [open, setOpen] = useState(false);
  const [elig, setElig] = useState<ReportEligibility | null>(null);
  const [target, setTarget] = useState('');
  const [category, setCategory] = useState('');
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setOpen(true);
    setMsg(null);
    try {
      setElig(await api.reportEligibility(matchId));
    } catch {
      setElig({ canReport: false, reason: 'Could not check whether you can report on this match.' });
    }
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.report(matchId, target, category, text);
      setMsg({ ok: true, text: 'Thanks. An admin will look at it.' });
      setTarget('');
      setCategory('');
      setText('');
      setElig(await api.reportEligibility(matchId));
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Could not send the report.' });
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return <button class="chip report" type="button" onClick={start}>Report a player</button>;
  }

  return (
    <div class="report">
      <h3>Report a player</h3>
      {!elig && <p class="muted">Checking...</p>}
      {elig && !elig.canReport && <p class="muted">{elig.reason}.</p>}
      {elig?.canReport && (
        <form class="report__form" onSubmit={submit}>
          <select value={target} aria-label="Player" onChange={(e) => setTarget((e.target as HTMLSelectElement).value)}>
            <option value="">Who?</option>
            {elig.targets!.map((t) => (
              <option key={t.steamid} value={t.steamid} disabled={t.alreadyReported}>
                {t.name}{t.alreadyReported ? ' (reported)' : ''}
              </option>
            ))}
          </select>
          <select value={category} aria-label="Reason" onChange={(e) => setCategory((e.target as HTMLSelectElement).value)}>
            <option value="">What happened?</option>
            {CATEGORIES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
          <textarea value={text} maxLength={1000} placeholder="Details (optional): when, which map, what they did"
            aria-label="Details" onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
          <div class="admin-form">
            <button class="btn" type="submit" disabled={busy || !target || !category}>Send report</button>
            <button class="chip" type="button" onClick={() => setOpen(false)}>Close</button>
          </div>
        </form>
      )}
      {msg && <p class={msg.ok ? 'muted' : 'error'}>{msg.text}</p>}
    </div>
  );
}
