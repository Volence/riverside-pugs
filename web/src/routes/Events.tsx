import { useEffect, useState } from 'preact/hooks';
import { ApiError, bannerUrl, eventsApi, type EventListItem } from '../api';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import { CompeteTabs } from '../components/CompeteTabs';
import type { Session } from '../hooks/useLiveState';
import { STATUS_LABEL, roundWhenText } from '../eventFormat';

const OVER = new Set(['finished', 'cancelled']);

const KIND_LABEL: Record<string, string> = { draft: 'Draft tournament', team: 'Team tournament' };

function EventRow({ ev, past = false }: { ev: EventListItem; past?: boolean }) {
  const count = ev.entryKind === 'draft' ? `${ev.entries} signup${ev.entries === 1 ? '' : 's'}` : ev.entryKind === 'team' ? `${ev.entries} team${ev.entries === 1 ? '' : 's'}` : `${ev.entries} entr${ev.entries === 1 ? 'y' : 'ies'}`;
  const meta = [ev.format.join(', then '), ev.entries > 0 ? count : ''].filter(Boolean).join(' · ');
  return (
    <li class={`evcard${past ? ' evcard--past' : ''}`}>
      <a class="evcard__link eventrow" href={`/event/${ev.slug}`}>
        {ev.bannerKey
          ? <img class="evcard__banner eventrow__banner" src={bannerUrl(ev.bannerKey)} alt="" width={640} height={160} loading="lazy" />
          : !past && <span class="evcard__band" aria-hidden="true" data-name={ev.name} />}
        <span class="evcard__body">
          <span class="evcard__top">
            <span class="eyebrow">{ev.official ? 'Official' : 'Community'} · {KIND_LABEL[ev.entryKind] ?? 'Tournament'}</span>
            <span class={`teamchip eventstatus eventstatus--${ev.status}`}>{ev.statusLabel ?? STATUS_LABEL[ev.status]}</span>
          </span>
          <span class="evcard__name eventrow__name">{ev.name}</span>
          <span class="evcard__when">{roundWhenText(ev.startsAt)}</span>
          {meta && <span class="evcard__meta eventrow__meta">{meta}</span>}
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

  const header = <PageHeader eyebrow="Competitive" title="Events" />;
  if (closed) return <main class="page page--list eventspage">{header}<Empty>Events are not open yet.</Empty></main>;
  const head = <><CompeteTabs active="events" session={session} />{header}</>;
  if (failed) return <main class="page page--list eventspage">{head}<p class="error" role="alert">Could not load events. Try again in a moment.</p></main>;
  if (!events) return <main class="page page--list eventspage">{head}</main>;
  const upcoming = events.filter((e) => !OVER.has(e.status));
  const past = events.filter((e) => OVER.has(e.status));

  return (
    <main class="page page--list eventspage">
      {head}
      <Panel>
        <h3>Upcoming and running</h3>
        {upcoming.length === 0 ? <Empty>Nothing is scheduled yet.</Empty>
          : <ul class="evcards">{upcoming.map((ev) => <EventRow key={ev.slug} ev={ev} />)}</ul>}
      </Panel>
      {past.length > 0 && (
        <Panel>
          <h3>Past</h3>
          <ul class="evcards evcards--past">{past.map((ev) => <EventRow key={ev.slug} ev={ev} past />)}</ul>
        </Panel>
      )}
    </main>
  );
}

export default Events;
