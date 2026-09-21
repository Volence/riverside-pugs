import { useState } from 'preact/hooks';
import { api, ApiError, type ReportEligibility } from '../api';

const CATEGORIES = [
  ['griefing', 'Griefing / throwing'],
  ['cheating', 'Cheating'],
  ['toxicity', 'Toxicity / harassment'],
  ['afk', 'AFK / left the game'],
  ['unsafe', 'Safety concern (handled privately)'],
  ['other', 'Something else'],
] as const;

/**
 * "Report a player". Two homes: a match page (pass matchId, pick someone from
 * that match's roster) and a profile (pass target, no match). Moderators see
 * reports as tickets; the reported player is never told who filed one.
 */
export function ReportPlayer({ matchId, target: fixed }: { matchId?: number; target?: { steamid: string; name: string } }) {
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
    if (fixed || matchId === undefined) return;
    try {
      setElig(await api.reportEligibility(matchId));
    } catch {
      setElig({ canReport: false, reason: 'Could not load the players in this match.' });
    }
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      if (fixed) await api.fileReport({ targetId: fixed.steamid, category, text });
      else await api.report(matchId!, target, category, text);
      setMsg({ ok: true, text: 'Thanks. The moderators will look at it.' });
      setTarget('');
      setCategory('');
      setText('');
      if (!fixed && matchId !== undefined) setElig(await api.reportEligibility(matchId));
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Could not send the report.' });
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return <button class="chip report" type="button" onClick={start}>{fixed ? `Report ${fixed.name}` : 'Report a player'}</button>;
  }

  const ready = fixed ? true : elig?.canReport === true;
  const needsText = category === 'unsafe';
  return (
    <div class="report">
      <h3>{fixed ? `Report ${fixed.name}` : 'Report a player'}</h3>
      {!fixed && !elig && <p class="muted">Checking...</p>}
      {!fixed && elig && !elig.canReport && <p class="muted">{capitalise(elig.reason ?? 'You cannot report on this match')}.</p>}
      {ready && (
        <form class="report__form" onSubmit={submit}>
          {!fixed && (
            <select value={target} aria-label="Player" onChange={(e) => setTarget((e.target as HTMLSelectElement).value)}>
              <option value="">Who?</option>
              {elig!.targets!.map((t) => (
                <option key={t.steamid} value={t.steamid} disabled={t.alreadyReported}>
                  {t.name}{t.alreadyReported ? ' (reported)' : ''}
                </option>
              ))}
            </select>
          )}
          <select value={category} aria-label="Reason" onChange={(e) => setCategory((e.target as HTMLSelectElement).value)}>
            <option value="">What happened?</option>
            {CATEGORIES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
          {needsText && <p class="muted">This is seen only by the people who run the community, not by the whole moderator team. Say what happened in as much detail as you are comfortable with.</p>}
          <textarea value={text} maxLength={1000} aria-label="Details"
            placeholder={needsText ? 'What happened (required)' : 'Details (optional): when, which map, what they did'}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
          <div class="admin-form">
            <button class="btn" type="submit" disabled={busy || (!fixed && !target) || !category || (needsText && !text.trim())}>Send report</button>
            <button class="chip" type="button" onClick={() => setOpen(false)}>Close</button>
          </div>
        </form>
      )}
      {msg && <p class={msg.ok ? 'muted' : 'error'}>{msg.text}</p>}
    </div>
  );
}

const capitalise = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
