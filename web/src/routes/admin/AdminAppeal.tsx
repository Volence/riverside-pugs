import { useState } from 'preact/hooks';
import { appealStaffApi } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel } from '../../components/bits';
import { fmtTime, useAction } from './useAction';
import { fileUrl, ticketUrl } from './adminRoutes';
import { BAN_LENGTHS } from './banLengths';

export function AdminAppeal({ id }: { id: number }) {
  const { data: a, error: loadError, reload } = useFetch((s) => appealStaffApi.get(id, s), [id]);
  const { busy, error, run } = useAction(reload);
  const [message, setMessage] = useState('');
  // Minutes from BAN_LENGTHS, or 'date' for the hand-picked end below it.
  const [shortenTo, setShortenTo] = useState('');
  const [endsAt, setEndsAt] = useState('');
  if (loadError) return <Empty>No such appeal.</Empty>;
  if (!a) return null;
  const open = a.state === 'open' || a.state === 'asked' || a.state === 'answered';
  // Staff lower a ban to a new total length, counted from when it was issued,
  // the same lengths the ban forms offer. Only the ones that still end in the
  // future and before the ban ends now are offered (the server refuses the rest).
  const issued = Date.parse(a.target.createdAt);
  const endsNow = a.target.endsAt ? Date.parse(a.target.endsAt) : Infinity;
  const shorter = BAN_LENGTHS.flatMap(([m, label]) => {
    const end = m === null ? NaN : issued + m * 60_000;
    return end > Date.now() + 60_000 && end < endsNow ? [{ m: String(m), label, end: new Date(end).toISOString() }] : [];
  });
  const newEnd = shortenTo === 'date' ? (endsAt ? new Date(endsAt).toISOString() : '') : shorter.find((o) => o.m === shortenTo)?.end ?? '';

  return (
    <div class="stack">
      <Panel>
        <p class="eyebrow">Appeal #{a.id} · {a.about}</p>
        <h3>{a.steamid ? <a href={fileUrl(a.steamid)}>{a.name}</a> : a.name}</h3>
        <p>
          <strong>Ban:</strong> {a.target.reason}, by {a.target.createdByName} on {fmtTime(a.target.createdAt)},{' '}
          {a.target.endsAt ? `ends ${fmtTime(a.target.endsAt)}` : 'permanent'}
          {a.target.ticketId !== null && <> · <a href={ticketUrl(a.target.ticketId)}>ticket #{a.target.ticketId}</a></>}
          {!a.target.inForce && <> · <em>no longer in force</em></>}
        </p>
        {a.earlier.length > 0 && <p class="muted">Earlier appeals on this ban: {a.earlier.map((e) => `#${e.id} ${e.state}`).join(', ')}</p>}
        <h4>What happened</h4>
        <blockquote class="appeal-text">{a.whatHappened}</blockquote>
        <h4>Why it should be lifted or shortened</h4>
        <blockquote class="appeal-text">{a.whyLift}</blockquote>
        {a.messages.length > 0 && (
          <>
            <h4>Conversation</h4>
            <ol class="appeal-thread">
              {a.messages.map((m, i) => (
                <li key={i} class={m.fromStaff ? 'appeal-msg appeal-msg--staff' : 'appeal-msg'}>
                  <p class="appeal-msg__who">{m.fromStaff ? `${m.authorName ?? 'Staff'} (staff)` : a.name} · {fmtTime(m.at)}</p>
                  <blockquote class="appeal-text">{m.body}</blockquote>
                </li>
              ))}
            </ol>
          </>
        )}
        {a.state === 'asked' && a.answerBy && <p class="muted">Waiting on the player until {fmtTime(a.answerBy)}; no reply by then closes it as denied.</p>}
        {a.slurs.length > 0 && <p class="error">Denied automatically: {a.slurs.join(', ')}.</p>}
        {!open && <p><strong>{a.state}</strong>{a.decidedByName ? ` by ${a.decidedByName}` : ''}{a.decidedAt ? `, ${fmtTime(a.decidedAt)}` : ''}{a.newExpiresAt ? `; now ends ${fmtTime(a.newExpiresAt)}` : ''}</p>}
      </Panel>

      {open && a.canDecide && (
        <Panel>
          {error && <p class="error">{error}</p>}
          <div class="appeal-reply">
            <label>Message to the player (they see it as from "Staff", never your name)
              <textarea maxLength={1500} value={message} onInput={(e) => setMessage((e.target as HTMLTextAreaElement).value)} />
            </label>
            <button class="btn" disabled={busy || !message.trim()} onClick={() => run(() => appealStaffApi.message(a.id, message).then(() => setMessage('')))}>Send to player</button>
          </div>
          <p class="admin-actions">
            <button class="btn" disabled={busy} onClick={() => run(() => appealStaffApi.decide(a.id, 'accept'), {
              title: 'Accept this appeal?', body: 'The ban is lifted now. The player is told their appeal was accepted.', confirmLabel: 'Accept',
            })}>Accept</button>
            {a.canShorten && (
              <>
                <select value={shortenTo} aria-label="Shorten the ban to" onChange={(e) => setShortenTo((e.target as HTMLSelectElement).value)}>
                  <option value="">Shorten to...</option>
                  {shorter.map((o) => <option key={o.m} value={o.m}>{o.label} in total (ends {fmtTime(o.end)})</option>)}
                  <option value="date">Pick an end date</option>
                </select>
                {shortenTo === 'date' && (
                  <input type="datetime-local" aria-label="New end" value={endsAt} onInput={(e) => setEndsAt((e.target as HTMLInputElement).value)} />
                )}
                <button class="btn" disabled={busy || !newEnd} onClick={() => run(() => appealStaffApi.decide(a.id, 'shorten', newEnd), {
                  title: 'Shorten this ban?', body: `It will end ${new Date(newEnd).toLocaleString()}. The player is told the new end.`, confirmLabel: 'Shorten',
                })}>Shorten</button>
              </>
            )}
            <button class="btn btn--danger" disabled={busy} onClick={() => run(() => appealStaffApi.decide(a.id, 'deny'), {
              title: 'Deny this appeal?', body: 'The ban stands. The player is told so, and when they may appeal again.', confirmLabel: 'Deny', danger: true,
            })}>Deny</button>
          </p>
        </Panel>
      )}

      {a.canMarkFinal && (
        <Panel>
          <button class="btn" disabled={busy} onClick={() => run(() => appealStaffApi.markFinal(a.id, !a.target.noAppeal))}>
            {a.target.noAppeal ? 'Allow appeals on this ban again' : 'No more appeals on this ban'}
          </button>
        </Panel>
      )}
    </div>
  );
}
