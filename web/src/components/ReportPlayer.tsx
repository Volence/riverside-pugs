import { useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError, type ReportEligibility, type ReportMoment } from '../api';
import { fmtClock } from '../format';

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
export function ReportPlayer(
  { matchId, target: fixed, moment, onClearMoment }: {
    matchId?: number; target?: { steamid: string; name: string };
    /** A replay moment picked in the viewer above. Match pages only. */
    moment?: ReportMoment | null;
    onClearMoment?: () => void;
  },
) {
  const [open, setOpen] = useState(false);
  const [elig, setElig] = useState<ReportEligibility | null>(null);
  const [target, setTarget] = useState('');
  const [category, setCategory] = useState('');
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);

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

  // Picking a moment in the viewer is asking to report it: open the form...
  useEffect(() => {
    if (moment) void start();
  }, [moment]);
  // ...and bring it into view, once it exists: the form's wrapper is only
  // rendered when `open` is true, so this waits for that render. Keyed on the
  // moment object too, so picking a second moment scrolls back. jsdom has no
  // scrollIntoView, hence the optional call.
  useEffect(() => {
    if (open && moment) root.current?.scrollIntoView?.({ block: 'nearest' });
  }, [open, moment]);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      if (fixed) await api.fileReport({ targetId: fixed.steamid, category, text });
      else if (moment) await api.report(matchId!, target, category, text, moment);
      else await api.report(matchId!, target, category, text);
      setMsg({ ok: true, text: 'Thanks. The moderators will look at it.' });
      setTarget('');
      setCategory('');
      setText('');
      if (moment) onClearMoment?.();
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
    <div class="report" ref={root}>
      <h3>{fixed ? `Report ${fixed.name}` : 'Report a player'}</h3>
      {!fixed && !elig && <p class="muted">Checking...</p>}
      {!fixed && elig && !elig.canReport && <p class="muted">{capitalise(elig.reason ?? 'You cannot report on this match')}.</p>}
      {ready && (
        <form class="report__form" onSubmit={submit}>
          {!fixed && (
            <select value={target} aria-label="Player" onChange={(e) => setTarget((e.target as HTMLSelectElement).value)}>
              <option value="">Who?</option>
              {/* Marked, never disabled: a safety report about someone you
                  already reported for this match is a different report, and
                  the server refuses the true duplicates. */}
              {elig!.targets!.map((t) => (
                <option key={t.steamid} value={t.steamid}>
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
          {moment && (
            <p class="muted">
              Attached: map {moment.ordinal + 1}, round {moment.half}, at {fmtClock(Math.floor(moment.tMs / 1000))}.{' '}
              <button class="chip" type="button" onClick={onClearMoment}>Detach</button>
            </p>
          )}
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
