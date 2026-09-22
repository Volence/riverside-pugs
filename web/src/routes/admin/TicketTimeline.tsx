import { useState } from 'preact/hooks';
import { modApi, ticketAttachmentUrl, type TicketAttachment, type TicketEvent, type TicketMessage } from '../../api';
import { fmtBytes } from '../../format';
import { fmtTime, type Run } from './useAction';

/** A friendly label for a length of minutes, matching AdminTicket.tsx's
 *  LENGTHS labels for the values a moderator can actually pick ("1 hour",
 *  "3 days"), with a plain fallback for anything else. */
function fmtMinutes(m: number): string {
  if (m >= 1440 && m % 1440 === 0) { const d = m / 1440; return `${d} day${d === 1 ? '' : 's'}`; }
  if (m >= 60 && m % 60 === 0) { const h = m / 60; return `${h} hour${h === 1 ? '' : 's'}`; }
  return `${m} minute${m === 1 ? '' : 's'}`;
}

export const eventText = (e: TicketEvent): string => {
  const who = e.actorName ?? 'A player';
  switch (e.kind) {
    case 'opened': return e.actorId ? `${who} opened the ticket` : 'Opened by a report';
    case 'report_attached': return 'Another report came in';
    case 'note': return `${who}: ${String(e.detail.text ?? '')}`;
    case 'claimed': return `${who} claimed it`;
    case 'unclaimed': return `${who} released it`;
    case 'restricted': return `${who} restricted it`;
    case 'unrestricted': return `${who} lifted the restriction`;
    case 'access_added': return `${who} gave someone access`;
    case 'banned': return `${who} banned the player: ${String(e.detail.reason ?? '')}`;
    case 'closed': return `${who} closed it: ${String(e.detail.outcome ?? '').replace(/_/g, ' ')}${e.detail.note ? ` (${String(e.detail.note)})` : ''}`;
    case 'reopened': return `${who} reopened it`;
    case 'folded': return `Ticket #${String(e.detail.from ?? '')} about the same player was folded into this one`;
    case 'discord_sanction': return e.detail.kind === 'ban'
      ? `${who} banned them from the Discord: ${String(e.detail.reason ?? '')}`
      : `${who} timed them out in Discord for ${fmtMinutes(Number(e.detail.minutes))}: ${String(e.detail.reason ?? '')}`;
    case 'discord_sanction_lifted': return `${who} lifted the Discord ${e.detail.kind === 'ban' ? 'ban' : 'timeout'}`;
    case 'removed': return e.detail.mirrored === false
      ? `${who} deleted a message in Discord that had not been copied here`
      : `${who} removed a message for good${Number(e.detail.files) > 0 ? `, with ${Number(e.detail.files)} file${Number(e.detail.files) === 1 ? '' : 's'}` : ''}`;
    default: return `${who}: ${e.kind.replace(/_/g, ' ')}`;
  }
};

export interface TimelineItem { key: string; at: string; event?: TicketEvent; message?: TicketMessage }

/** Events and messages in one list, oldest first. Ties keep the order they
 *  came in, events before messages. */
export function interleave(events: TicketEvent[], messages: TicketMessage[]): TimelineItem[] {
  const items: TimelineItem[] = [
    ...events.map((e) => ({ key: `e${e.id}`, at: e.createdAt, event: e })),
    ...messages.map((m) => ({ key: `m${m.id}`, at: m.createdAt, message: m })),
  ];
  return items.map((item, i) => ({ item, i }))
    .sort((a, b) => Date.parse(a.item.at) - Date.parse(b.item.at) || a.i - b.i)
    .map((x) => x.item);
}

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
/** mov is left out on purpose: it is served, but browsers mostly cannot play
 *  it, and a broken player is worse than a link. */
const VIDEO = /\.(mp4|webm)$/i;
const NOT_STORED: Record<string, string> = {
  too_large: 'it was too large to store',
  type: 'this type of file is not stored',
  quota: 'attachment storage was full',
  disabled: 'storing attachments is switched off',
  fetch_failed: 'the download failed; it is tried again when the bot next starts',
};

function File({ ticketId, a }: { ticketId: number; a: TicketAttachment }) {
  const size = fmtBytes(a.size);
  if (a.removed) {
    // Informational only, not a real list item: it links to nothing and shows
    // no thumbnail, so it should not read to assistive tech (or a role query)
    // as another entry alongside the timeline's own <li>s.
    return <li class="ticket-file ticket-file--gone" role="presentation">{a.filename} ({size}), removed{a.sha256 ? <>, sha256 <code title={a.sha256}>{a.sha256.slice(0, 16)}</code></> : null}</li>;
  }
  if (!a.stored) return <li class="ticket-file">{a.filename} ({size}), not stored: {NOT_STORED[a.skipReason ?? ''] ?? 'it could not be kept'}</li>;
  const url = ticketAttachmentUrl(ticketId, a.id);
  if (IMAGE.test(a.filename)) {
    return <li class="ticket-file"><a href={url} target="_blank" rel="noreferrer"><img class="ticket-thumb" src={url} alt={a.filename} loading="lazy" /></a></li>;
  }
  if (VIDEO.test(a.filename)) {
    return <li class="ticket-file"><video class="ticket-thumb" src={url} controls preload="none" aria-label={a.filename} /></li>;
  }
  return <li class="ticket-file"><a href={url} target="_blank" rel="noreferrer">{a.filename}</a> ({size})</li>;
}

/**
 * A message's files. From the staff channel they show at once. From the
 * reporter channel NOTHING is rendered, so nothing is fetched, until a
 * moderator asks: a reporter is a stranger, and what a stranger attaches is
 * not put in front of someone who only opened the ticket to read it.
 *
 * A removed file is no exception. Its bytes are gone, but its name is still
 * the reporter's own words, and the click it needed a moment before Remove is
 * the click it needs after.
 */
function Files({ ticketId, m }: { ticketId: number; m: TicketMessage }) {
  const [shown, setShown] = useState(m.channel === 'staff');
  if (m.attachments.length === 0) return null;
  if (!shown) {
    const n = m.attachments.length;
    return <p><button class="chip" type="button" onClick={() => setShown(true)}>Show {n} file{n === 1 ? '' : 's'} from the reporter</button></p>;
  }
  return <ul class="ticket-files">{m.attachments.map((a) => <File key={a.id} ticketId={ticketId} a={a} />)}</ul>;
}

function Message({ ticketId, m, reason, busy, run }: { ticketId: number; m: TicketMessage; reason: string; busy: boolean; run: Run }) {
  const marks = `${m.editedAt ? ' · edited' : ''}${m.deletedAt ? ' · deleted in Discord' : ''}`;
  return (
    <li class={`ticket-msg ticket-msg--${m.channel}`}>
      <p>
        <span class="admin-tag">{m.channel}</span>{' '}
        <strong>{m.authorPlayerId ? <a href={`/player/${m.authorPlayerId}`}>{m.authorName}</a> : m.authorName}</strong>
        <span class="muted"> · {fmtTime(m.createdAt)}{marks}</span>
      </p>
      {m.removed
        ? <p class="muted">Removed by {m.removed.byName ?? m.removed.by ?? 'staff'} on {fmtTime(m.removed.at)}{m.removed.reason ? `: ${m.removed.reason}` : ''}. The text and any files are gone for good.</p>
        : (
          <>
            {m.content && <blockquote>{m.content}</blockquote>}
            {m.history.length > 0 && (
              <details>
                <summary>{m.history.length} earlier version{m.history.length === 1 ? '' : 's'}</summary>
                <ol>{m.history.map((h, i) => <li key={i}><blockquote>{h}</blockquote></li>)}</ol>
              </details>
            )}
          </>
        )}
      <Files ticketId={ticketId} m={m} />
      {!m.removed && (
        <button class="chip" type="button" disabled={busy}
          onClick={() => run(() => modApi.removeMessage(ticketId, m.id, reason), {
            title: 'Remove this message for good?',
            body: 'Its text, its edit history and every file attached to it are deleted from the server, and the message is deleted in Discord. Only a note that something was removed is kept. This cannot be undone.',
            confirmLabel: 'Remove for good',
            danger: true,
          })}>
          Remove
        </button>
      )}
    </li>
  );
}

export function TicketTimeline(
  { ticketId, events, messages, busy, run }: { ticketId: number; events: TicketEvent[]; messages: TicketMessage[]; busy: boolean; run: Run },
) {
  const [reason, setReason] = useState('');
  const removable = messages.some((m) => !m.removed);
  return (
    <>
      {removable && (
        <div class="admin-form">
          <input value={reason} maxLength={200} placeholder="Reason for a removal (optional, staff only)" aria-label="Reason for a removal"
            onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
        </div>
      )}
      <ul class="ticket-timeline">
        {interleave(events, messages).map((item) => (item.message
          ? <Message key={item.key} ticketId={ticketId} m={item.message} reason={reason.trim()} busy={busy} run={run} />
          : <li key={item.key} class="ticket-event"><span class="muted">{fmtTime(item.event!.createdAt)}</span> {eventText(item.event!)}</li>))}
      </ul>
    </>
  );
}
