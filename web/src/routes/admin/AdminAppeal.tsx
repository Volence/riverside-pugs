import { useState } from 'preact/hooks';
import { appealStaffApi } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel } from '../../components/bits';
import { fmtTime, useAction } from './useAction';
import { fileUrl, ticketUrl } from './adminRoutes';

export function AdminAppeal({ id }: { id: number }) {
  const { data: a, error: loadError, reload } = useFetch((s) => appealStaffApi.get(id, s), [id]);
  const { busy, error, run } = useAction(reload);
  const [question, setQuestion] = useState('');
  const [endsAt, setEndsAt] = useState('');
  if (loadError) return <Empty>No such appeal.</Empty>;
  if (!a) return null;
  const open = a.state === 'open' || a.state === 'asked' || a.state === 'answered';

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
        <blockquote>{a.whatHappened}</blockquote>
        <h4>Why it should be lifted or shortened</h4>
        <blockquote>{a.whyLift}</blockquote>
        {a.question && <><h4>Question from {a.askedByName}</h4><blockquote>{a.question}</blockquote></>}
        {a.state === 'asked' && a.answerBy && <p class="muted">Waiting for an answer until {fmtTime(a.answerBy)}.</p>}
        {a.answer && <><h4>Answer</h4><blockquote>{a.answer}</blockquote></>}
        {a.slurs.length > 0 && <p class="error">Denied automatically: {a.slurs.join(', ')}.</p>}
        {!open && <p><strong>{a.state}</strong>{a.decidedByName ? ` by ${a.decidedByName}` : ''}{a.decidedAt ? `, ${fmtTime(a.decidedAt)}` : ''}{a.newExpiresAt ? `; now ends ${fmtTime(a.newExpiresAt)}` : ''}</p>}
      </Panel>

      {open && a.canDecide && (
        <Panel>
          {error && <p class="error">{error}</p>}
          {a.state === 'open' && (
            <p>
              <label>One question (you only get one)
                <input type="text" maxLength={500} value={question} onInput={(e) => setQuestion((e.target as HTMLInputElement).value)} />
              </label>
              <button class="btn" disabled={busy || !question.trim()} onClick={() => run(() => appealStaffApi.ask(a.id, question))}>Ask one question</button>
            </p>
          )}
          <p class="admin-actions">
            <button class="btn" disabled={busy} onClick={() => run(() => appealStaffApi.decide(a.id, 'accept'), {
              title: 'Accept this appeal?', body: 'The ban is lifted now. The player is told their appeal was accepted.', confirmLabel: 'Accept',
            })}>Accept</button>
            {a.canShorten && (
              <>
                <input type="datetime-local" value={endsAt} onInput={(e) => setEndsAt((e.target as HTMLInputElement).value)} />
                <button class="btn" disabled={busy || !endsAt} onClick={() => run(() => appealStaffApi.decide(a.id, 'shorten', new Date(endsAt).toISOString()), {
                  title: 'Shorten this ban?', body: `It will end ${new Date(endsAt).toLocaleString()}. The player is told the new end.`, confirmLabel: 'Shorten',
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
