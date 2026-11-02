import { useState } from 'preact/hooks';
import { modApi, type TicketSummary } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { useTicketNudge } from '../../hooks/useTicketNudge';
import { Empty, Panel, Tabs } from '../../components/bits';
import { fmtTime } from './useAction';
import { fmtAgo } from '../../format';

const FILTERS: { key: 'open' | 'mine' | 'closed'; label: string }[] = [
  { key: 'open', label: 'Open' }, { key: 'mine', label: 'Mine' }, { key: 'closed', label: 'Closed' },
];
const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;

/** "2 reports from 2 people", or what a hand-opened ticket has instead. */
export const reportLine = (t: TicketSummary) =>
  t.reports === 0 ? 'Opened by staff, no reports' : `${t.reports} report${t.reports === 1 ? '' : 's'} from ${people(t.reporters)}`;

/** The list, and nothing else: which ticket is open is a URL the shell
 *  reads, so opening one is the caller's business. */
export function AdminTickets({ onOpen }: { onOpen: (id: number) => void }) {
  const [filter, setFilter] = useState<'open' | 'mine' | 'closed'>('open');
  const { data, reload } = useFetch((s) => modApi.tickets(filter, s), [filter]);
  useTicketNudge(reload);

  return (
    <Panel>
      <Tabs active={filter} onSelect={(k) => setFilter(k as typeof filter)}
        tabs={FILTERS.map((f) => ({ ...f, count: data?.counts[f.key] }))} />
      {data && data.tickets.length === 0 && <Empty>No {filter === 'mine' ? 'tickets claimed by you' : `${filter} tickets`}.</Empty>}
      <ul class="tickets">
        {data?.tickets.map((t) => (
          <li key={t.id}>
            <button type="button" class={`ticket-row${t.status === 'open' ? '' : ' is-closed'}`} onClick={() => onOpen(t.id)}>
              <span class="ticket-row__id">#{t.id}</span>
              <span class="ticket-row__who">
                <strong>{t.targetName ?? t.targetId ?? 'Discord member'}</strong>
                {t.restricted && <span class="admin-tag">restricted</span>}
                <span class="ticket-row__cats">{t.categories.join(', ')}</span>
              </span>
              <span class="muted ticket-row__reports">{reportLine(t)}</span>
              <span class={`ticket-row__claim${t.claimedByName ? ' is-claimed' : ''}`}>{t.claimedByName ? `claimed by ${t.claimedByName}` : 'unclaimed'}</span>
              <time class="muted ticket-row__when" title={fmtTime(t.lastReportAt ?? t.createdAt)}>{fmtAgo(t.lastReportAt ?? t.createdAt)}</time>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
