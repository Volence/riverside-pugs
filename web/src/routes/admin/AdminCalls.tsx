import { useState } from 'preact/hooks';
import { modApi, type ModCallView } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel, Tabs } from '../../components/bits';
import { ticketUrl } from './adminRoutes';
import { fmtTime } from './useAction';

const FILTERS: { key: 'open' | 'all'; label: string }[] = [
  { key: 'open', label: 'Open' }, { key: 'all', label: 'All' },
];

/** Who or what the call is about, as the card says it. A server problem
 *  (`none`) is about nobody, so it says nothing. */
function About({ c }: { c: ModCallView }) {
  if (c.target.kind === 'player' && c.target.steamid) {
    return <span>about <a href={`/player/${c.target.steamid}`}>{c.target.name ?? c.target.steamid}</a></span>;
  }
  if (c.target.kind === 'team') return <span>about their team</span>;
  if (c.target.kind === 'general') return <span>about the whole server</span>;
  return null;
}

/** One call. Folded calls are the same row one level in, and carry no
 *  folded calls of their own. */
function CallRow({ c }: { c: ModCallView }) {
  const where = [c.serverName ?? 'unknown server', c.map].filter(Boolean).join(' · ');
  return (
    <div class="call-row">
      <p>
        <span class="muted">{fmtTime(c.createdAt)}</span>
        {' '}<strong>{c.reasonLabel}</strong>
        {' '}from <a href={`/player/${c.caller.steamid}`}>{c.caller.name}</a>
        {c.via === 'tv' && <span class="admin-tag">SourceTV</span>}
        {' '}<About c={c} />
        <span class="muted"> · {where}</span>
        {c.matchId !== null && <> · <a href={`/match/${c.matchId}`}>#{c.matchId}</a></>}
        {c.matchId !== null && c.moment && (
          <> · <a href={`/match/${c.matchId}?ordinal=${c.moment.ordinal}&half=${c.moment.half}&t=${c.moment.tMs}`}>replay moment</a></>
        )}
        {c.ticketId !== null && <> · <a href={ticketUrl(c.ticketId)}>ticket #{c.ticketId}</a></>}
      </p>
      {c.text && <blockquote>{c.text}</blockquote>}
      {(c.note || c.handledAt) && (
        <p class="muted">
          {c.note}
          {c.note && c.handledAt && ' · '}
          {c.handledAt && `Handled by ${c.handledBy ?? 'someone'} ${fmtTime(c.handledAt)}`}
        </p>
      )}
    </div>
  );
}

/**
 * Every in-game /mod call, newest first. The Discord card is where staff are
 * pinged; this is the record, including calls that never reached Discord
 * (a banned caller, calls turned off, or no admin channel set), which is why
 * the page says so plainly when nothing is posting.
 */
export function AdminCalls() {
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const { data } = useFetch((s) => modApi.calls(filter, s), [filter]);

  return (
    <Panel>
      <Tabs active={filter} onSelect={(k) => setFilter(k as typeof filter)} tabs={FILTERS} />
      {data && !data.discordReady && (
        <p class="admin-warning">Calls are not reaching Discord: set the Admin channel id and turn on In-game mod calls in Settings.</p>
      )}
      {data && data.calls.length === 0 && <Empty>No {filter === 'open' ? 'open ' : ''}calls.</Empty>}
      <ul class="calls">
        {data?.calls.map((c) => (
          <li key={c.id}>
            <CallRow c={c} />
            {c.folded.length > 0 && (
              <ul class="calls calls--folded" aria-label={`Folded into call ${c.id}`}>
                {c.folded.map((f) => <li key={f.id}><CallRow c={f} /></li>)}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
