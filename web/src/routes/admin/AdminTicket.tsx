import { useState } from 'preact/hooks';
import { modApi, type TicketDetail, type TicketEvent } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { campaignName } from '../../format';
import { Empty, Panel } from '../../components/bits';
import { fmtTime, useAction } from './useAction';
import { reportLine } from './AdminTickets';
import { FileSummary } from './file/FileSummary';

const OUTCOMES = [['action_taken', 'Action taken'], ['warned', 'Warned'], ['no_action', 'No action'], ['invalid', 'Invalid report']] as const;
const LENGTHS: [minutes: number | null, label: string][] = [
  [60, '1 hour'], [1440, '1 day'], [4320, '3 days'], [10080, '7 days'], [43200, '30 days'], [null, 'Permanent'],
];

const eventText = (e: TicketEvent): string => {
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
    default: return `${who}: ${e.kind.replace(/_/g, ' ')}`;
  }
};

export function AdminTicket({ id, onBack, onOpen }: { id: number; onBack: () => void; onOpen: (id: number) => void }) {
  const { data, error, reload } = useFetch((s) => modApi.ticket(id, s), [id]);
  const { busy, error: actionError, run } = useAction(reload);
  const [outcome, setOutcome] = useState('');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState('1440');
  const [grant, setGrant] = useState('');

  if (error) return <Panel><button class="chip" type="button" onClick={onBack}>Back to tickets</button><Empty>No such ticket.</Empty></Panel>;
  if (!data) return <Panel><p class="muted">Loading...</p></Panel>;
  const { ticket: t, caseFile: c } = data;
  const cap = data.viewer.banCapMinutes;
  const lengths = LENGTHS.filter(([m]) => cap === null || (m !== null && m <= cap));
  const open = t.status === 'open';

  return (
    <Panel>
      <button class="chip" type="button" onClick={onBack}>Back to tickets</button>
      <h3>
        #{t.id} <a href={`/player/${t.targetId}`}>{t.targetName ?? t.targetId}</a>
        {t.restricted && <span class="admin-tag">Restricted</span>}
        <span class="admin-tag">{open ? 'open' : `closed: ${(t.outcome ?? '').replace(/_/g, ' ')}`}</span>
      </h3>
      <p class="muted">{reportLine(t)} · {t.claimedByName ? `claimed by ${t.claimedByName}` : 'unclaimed'} · opened {fmtTime(t.createdAt)}</p>
      {actionError && <p class="error">{actionError}</p>}

      {t.restricted && (
        <section class="ticket-restricted">
          <p>Only the people listed here can see this ticket. Anyone with the Discord Administrator permission can read every channel on the Discord server, so keep the discussion of this one off Discord if that includes the accused.</p>
          <ul class="admin-list">{data.access.map((a) => <li key={a.steamid}>{a.name}</li>)}</ul>
          {data.accessCandidates.length > 0 && (
            <div class="admin-form">
              <select value={grant} aria-label="Give access to" onChange={(e) => setGrant((e.target as HTMLSelectElement).value)}>
                <option value="">Give access to...</option>
                {data.accessCandidates.map((a) => <option key={a.steamid} value={a.steamid}>{a.name}</option>)}
              </select>
              <button class="chip" type="button" disabled={busy || !grant} onClick={() => run(() => modApi.access(t.id, grant)).then(() => setGrant(''))}>Give access</button>
            </div>
          )}
        </section>
      )}

      <section>
        <h4>Reports</h4>
        {data.reports.length === 0 && <p class="muted">None. This ticket was opened by staff.</p>}
        <ul class="admin-reports">
          {data.reports.map((r) => (
            <li key={r.id} class="admin-report">
              <p>
                <strong>{r.category}</strong> from <a href={`/player/${r.reporterId}`}>{r.reporterName ?? r.reporterId}</a>
                <span class="muted"> · {fmtTime(r.createdAt)}</span>
                {r.matchId !== null && <> · <a href={`/match/${r.matchId}`}>#{r.matchId}{r.campaign ? ` ${campaignName(r.campaign)}` : ''}</a></>}
                {r.matchId !== null && r.moment && <> · <a href={`/match/${r.matchId}?ordinal=${r.moment.ordinal}&half=${r.moment.half}&t=${r.moment.tMs}`}>replay moment</a></>}
              </p>
              {r.text && <blockquote>{r.text}</blockquote>}
            </li>
          ))}
        </ul>
      </section>

      {data.summary && <FileSummary s={data.summary} />}

      {c && (
        <section>
          <h4>About {c.name}</h4>
          <p class="muted">{c.status} · SR {c.sr ?? 'n/a'} · {c.games} games{c.activeBan ? ` · banned: ${c.activeBan.reason}` : ''}{c.timeout ? ` · queue timeout, ${c.timeout.offenses} offenses` : ''}</p>
          <ul class="admin-list">
            <li>{c.bans.length} ban{c.bans.length === 1 ? '' : 's'} on record, {c.penalties.length} penalt{c.penalties.length === 1 ? 'y' : 'ies'}, {c.inputFlags.length} input flag{c.inputFlags.length === 1 ? '' : 's'}</li>
            {c.aliases.length > 0 && <li>{c.aliases.length} merged second account{c.aliases.length === 1 ? '' : 's'}</li>}
            {c.sharesAddressWith.length > 0 && <li>Shares a connection with: {c.sharesAddressWith.map((s) => s.name).join(', ')}</li>}
          </ul>
          {c.tickets.filter((o) => o.id !== t.id).length > 0 && (
            <>
              <h4>Earlier tickets</h4>
              <ul class="admin-list">
                {c.tickets.filter((o) => o.id !== t.id).map((o) => (
                  <li key={o.id}>
                    <button class="chip" type="button" onClick={() => onOpen(o.id)}>#{o.id}</button>
                    {' '}{o.categories.join(', ')} · {o.status === 'open' ? 'open' : (o.outcome ?? 'closed').replace(/_/g, ' ')} · {fmtTime(o.createdAt)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      <section>
        <h4>Timeline</h4>
        <ul class="admin-list">
          {data.events.map((e) => <li key={e.id}><span class="muted">{fmtTime(e.createdAt)}</span> {eventText(e)}</li>)}
        </ul>
        <p class="muted">The moderators' discussion will appear here once the Discord forum is connected.</p>
      </section>

      <section>
        <h4>Actions</h4>
        <div class="admin-actions">
          {open && <button class="chip" type="button" disabled={busy} onClick={() => run(() => modApi.claim(t.id, t.claimedBy === null))}>{t.claimedBy === null ? 'Claim' : 'Release'}</button>}
          <button class="chip" type="button" disabled={busy}
            onClick={() => run(() => modApi.restrict(t.id, !t.restricted), t.restricted ? undefined : {
              title: 'Restrict this ticket?',
              body: 'Only you and the owners will be able to see it until someone is given access.',
              confirmLabel: 'Restrict',
            })}>
            {t.restricted ? 'Lift restriction' : 'Restrict'}
          </button>
          {!open && <button class="chip" type="button" disabled={busy} onClick={() => run(() => modApi.reopen(t.id))}>Reopen</button>}
        </div>

        {open && (
          <>
            {t.restricted && (
              <p class="muted">The ban reason is shown to the player and in the ban list, so keep it general and leave the details in this ticket.</p>
            )}
            <div class="admin-form">
              <input value={reason} maxLength={500} placeholder="Ban reason" aria-label="Ban reason" onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
              <select value={minutes} aria-label="Ban length" onChange={(e) => setMinutes((e.target as HTMLSelectElement).value)}>
                {lengths.map(([m, label]) => <option key={label} value={m === null ? '' : String(m)}>{label}</option>)}
              </select>
              <button class="btn" type="button" disabled={busy || !reason.trim()}
                onClick={() => run(() => modApi.ban(t.id, reason.trim(), minutes === '' ? null : Number(minutes)), {
                  title: `Ban ${t.targetName ?? t.targetId}?`,
                  body: 'They are removed from the queue and banned on every game server. The ban is linked to this ticket.',
                  confirmLabel: 'Ban',
                  danger: true,
                }).then(() => setReason(''))}>
                Ban
              </button>
            </div>
            <div class="admin-form">
              <select value={outcome} aria-label="Outcome" onChange={(e) => setOutcome((e.target as HTMLSelectElement).value)}>
                <option value="">Outcome...</option>
                {OUTCOMES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
              <input value={note} maxLength={1000} placeholder="Closing note (staff only)" aria-label="Closing note" onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
              <button class="btn" type="button" disabled={busy || !outcome} onClick={() => run(() => modApi.close(t.id, outcome, note))}>Close ticket</button>
            </div>
          </>
        )}
      </section>
    </Panel>
  );
}
