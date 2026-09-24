import type { FileSummaryData } from '../../../api';
import { fmtTime } from '../useAction';
import { SOURCE_LABEL } from './GlanceRow';

/**
 * The accused, beside a ticket.
 *
 * Rendered from the same builder as the Player File's glance row, so a new
 * evidence source appears in both places the day its adapter lands. Compact
 * on purpose: the whole record is one click away, unless this viewer may not
 * open it, in which case there is no link and the counts are what they get.
 */
export function FileSummary({ s }: { s: FileSummaryData }) {
  return (
    <section class="file-summary">
      <h4>About {s.name}</h4>
      <p class="muted">
        {s.status} · SR {s.sr ?? 'n/a'} · {s.games} games
        {s.activeBan ? ` · banned: ${s.activeBan.reason}` : ''}
        {s.timeout ? ` · queue timeout, ${s.timeout.offenses} offenses` : ''}
      </p>
      <ul class="admin-list">
        <li>
          {s.bans} ban{s.bans === 1 ? '' : 's'} on record, {s.penalties} penalt{s.penalties === 1 ? 'y' : 'ies'},
          {' '}{s.openTickets} open ticket{s.openTickets === 1 ? '' : 's'}
        </li>
        <li>
          {s.evidence.length === 0 ? 'Nothing recorded in the last 30 days.' : (
            <>
              Last 30 days: {s.evidence.map((e) => `${e.count} ${SOURCE_LABEL[e.source]}`).join(', ')}.
              {' '}Context, not a verdict.
            </>
          )}
        </li>
        {s.aliases > 0 && <li>{s.aliases} merged second account{s.aliases === 1 ? '' : 's'}</li>}
        {s.sharesAddressWith.length > 0 && (
          <li>Shares a connection with: {s.sharesAddressWith.map((o) => o.name).join(', ')}</li>
        )}
        {s.steamFlags.map((f) => <li key={f.kind} class="muted">{f.text}</li>)}
        <li class="muted">
          {s.lastReview
            ? `Looked at by ${s.lastReview.reviewedByName ?? s.lastReview.reviewedBy} ${fmtTime(s.lastReview.reviewedAt)}`
            : 'Nobody has marked this file looked at.'}
        </li>
      </ul>
      {s.fileUrl && <p><a class="chip" href={s.fileUrl}>Open full file</a></p>}
    </section>
  );
}
