import { useState } from 'preact/hooks';
import type { MatchRoomView } from '../../../api';
import { confirm } from '../../../components/Confirm';
import { clockText, resultLine } from './roomText';

/** The confirm window: the result, who confirmed, the countdown, and a
 *  manager's Confirm or Dispute (with a reason, behind the site's confirm
 *  dialog). */
export function ConfirmPanel({ v, now, busy, onConfirm, onDispute }: {
  v: MatchRoomView; now: number; busy: boolean; onConfirm: () => void; onDispute: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const c = v.confirm;
  const left = c?.deadline ? Date.parse(c.deadline) - now : null;
  const me = v.me;
  const aName = v.a?.name ?? 'TBD';
  const bName = v.b?.name ?? 'TBD';
  const mineDone = me ? (me.side === 'a' ? c?.a : c?.b) : false;
  const who = c ? [c.a ? `${aName} confirmed.` : '', c.b ? `${bName} confirmed.` : ''].filter(Boolean).join(' ') : '';
  const pending = c ? [c.a ? '' : aName, c.b ? '' : bName].filter(Boolean) : [];
  const dispute = async () => {
    if (await confirm('Dispute the result? The match goes on hold until staff look at it.')) onDispute(reason.trim());
  };
  const status = `${who}${who && pending.length ? ' ' : ''}${pending.length ? `${pending.join(' and ')} have not confirmed yet.` : ''}`.trim();
  return (
    <div class="roomconfirm">
      <p class="roomconfirm__result">{resultLine(v)}</p>
      {status && <p>{status}</p>}
      {left !== null && <p>{`${clockText(left)} left. With no dispute the result stands.`}</p>}
      {me?.manager && (mineDone ? <p>Your team has confirmed.</p> : (
        <div class="roomconfirm__actions">
          <button class="btn" type="button" disabled={busy} onClick={onConfirm}>Confirm the result</button>
          <label class="roomconfirm__reason">
            <span>Why you dispute the result</span>
            <textarea aria-label="Why you dispute the result" value={reason} maxLength={300} onInput={(e) => setReason((e.target as HTMLTextAreaElement).value)} />
          </label>
          <button class="btn btn--danger" type="button" disabled={busy || reason.trim().length < 3} onClick={() => { void dispute(); }}>
            Dispute the result
          </button>
        </div>
      ))}
    </div>
  );
}
