import { useEffect, useState } from 'preact/hooks';
import { ApiError, bannerUrl, eventsApi, type EventListItem } from '../api';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import type { Session } from '../hooks/useLiveState';
import { STATUS_LABEL, whenText } from '../eventFormat';

const OVER = new Set(['finished', 'cancelled']);

function EventRow({ ev }: { ev: EventListItem }) {
  const count = ev.entryKind === 'draft' ? `${ev.entries} signup${ev.entries === 1 ? '' : 's'}` : ev.entryKind === 'team' ? `${ev.entries} team${ev.entries === 1 ? '' : 's'}` : `${ev.entries} entr${ev.entries === 1 ? 'y' : 'ies'}`;
  return (
    <li>
      <a class="eventrow" href={`/event/${ev.slug}`}>
        {ev.bannerKey && <img class="eventrow__banner" src={bannerUrl(ev.bannerKey)} alt="" width={160} height={40} loading="lazy" />}
        <span class="eventrow__name">{ev.name}</span>
        <span class={`teamchip eventstatus eventstatus--${ev.status}`}>{STATUS_LABEL[ev.status]}</span>
        <span class="eventrow__meta">
          {whenText(ev.startsAt)}
          {ev.format.length > 0 && <> · {ev.format.join(', then ')}</>}
          {ev.entries > 0 && <> · {count}</>}
        </span>
      </a>
    </li>
  );
}

/** Every event, upcoming first then past (spec section 7). */
export function Events({ session }: { session: Session }) {
  const [events, setEvents] = useState<EventListItem[] | null>(null);
  const [closed, setClosed] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    setFailed(false);
    eventsApi.list(ctl.signal).then((r) => setEvents(r.events), (e) => {
      if (ctl.signal.aborted) return;
      if (e instanceof ApiError && e.status === 404) setClosed(true);
      else setFailed(true);
    });
    return () => ctl.abort();
  }, [session.kind]);

  const head = <PageHeader eyebrow="Competitive" title="Events" />;
  if (closed) return <main class="page page--list">{head}<Empty>Events are not open yet.</Empty></main>;
  if (failed) return <main class="page page--list">{head}<p class="error" role="alert">Could not load events. Try again in a moment.</p></main>;
  if (!events) return <main class="page page--list">{head}</main>;
  const upcoming = events.filter((e) => !OVER.has(e.status));
  const past = events.filter((e) => OVER.has(e.status));

  return (
    <main class="page page--list">
      {head}
      <Panel>
        <h3>Upcoming and running</h3>
        {upcoming.length === 0 ? <Empty>Nothing is scheduled yet.</Empty>
          : <ul class="eventlist">{upcoming.map((ev) => <EventRow key={ev.slug} ev={ev} />)}</ul>}
      </Panel>
      {past.length > 0 && (
        <Panel>
          <h3>Past</h3>
          <ul class="eventlist">{past.map((ev) => <EventRow key={ev.slug} ev={ev} />)}</ul>
        </Panel>
      )}
    </main>
  );
}

export default Events;
