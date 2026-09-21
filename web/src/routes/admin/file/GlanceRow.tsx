import type { PlayerFileData, TimelineSource } from '../../../api';
import { fmtTime } from '../useAction';

/** One word per source, in the panel's own vocabulary. The badge is the same
 *  neutral shape for every source on purpose: colouring "LilAC" differently
 *  from "note" would read as a severity, and none of these is a verdict. */
export const SOURCE_LABEL: Record<TimelineSource, string> = {
  input: 'Input timing',
  lilac: 'Little Anti-Cheat',
  analyzer: 'Replay analyzer',
  drop: 'Connect drop',
  ticket: 'Ticket',
  penalty: 'Penalty',
  ban: 'Ban',
  note: 'Note',
  steam: 'Steam',
  discord_link: 'Discord',
};

export function SourceBadge({ source }: { source: TimelineSource }) {
  return <span class="source-badge">{SOURCE_LABEL[source]}</span>;
}

/** Is there anything here. One row, read before anything else on the page. */
export function GlanceRow({ d }: { d: PlayerFileData }) {
  const g = d.glance;
  return (
    <section class="file-glance">
      <p>
        {/* Each figure bolded as one phrase, not just the digit: a count and
            its noun split across elements is unfindable by its own text, and
            reads no better bold-then-plain than bold as a whole. */}
        <strong>{g.openTickets} open ticket{g.openTickets === 1 ? '' : 's'}</strong>
        {' · '}<strong>{g.bans} ban{g.bans === 1 ? '' : 's'} on record</strong>
        {' · '}<strong>{g.penalties} penalt{g.penalties === 1 ? 'y' : 'ies'}</strong>
        {g.aliases > 0 && <> · <strong>{g.aliases} merged second account{g.aliases === 1 ? '' : 's'}</strong></>}
        {g.sharesAddressWith.length > 0 && <> · shares a connection with {g.sharesAddressWith.map((s) => s.name).join(', ')}</>}
      </p>
      <p>
        {g.evidence.length === 0
          ? <span class="muted">Nothing recorded in the last 30 days.</span>
          : (
            <>
              Last 30 days:{' '}
              {g.evidence.map((e, i) => (
                <span key={e.source}>
                  {i > 0 ? ', ' : ''}{e.count} {SOURCE_LABEL[e.source]}{e.count === 1 ? '' : 's'}
                </span>
              ))}
              . Context to weigh, not a verdict.
            </>
          )}
      </p>
      {g.activeBan && (
        <p class="admin-warn">
          Banned: {g.activeBan.reason}
          {g.activeBan.expiresAt ? `, until ${fmtTime(g.activeBan.expiresAt)}` : ', permanently'}.
        </p>
      )}
      {g.timeout && <p class="admin-warn">Queue timeout until {fmtTime(g.timeout.until)}, {g.timeout.offenses} offenses this week.</p>}
      {g.steamFlags.map((f) => <p key={f.kind} class="muted">{f.text}</p>)}
      <p class="muted">
        {d.lastReview
          ? `Looked at by ${d.lastReview.reviewedByName ?? d.lastReview.reviewedBy} ${fmtTime(d.lastReview.reviewedAt)}${d.lastReview.note ? `: ${d.lastReview.note}` : ''}`
          : 'Nobody has marked this file looked at.'}
      </p>
    </section>
  );
}
