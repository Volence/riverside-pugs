import { useEffect, useState } from 'preact/hooks';
import { ApiError, bannerUrl, eventsApi, type EventView } from '../api';
import { RichText } from '../components/RichText';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import type { Session } from '../hooks/useLiveState';
import { STATUS_LABEL, untilText, whenText } from '../eventFormat';

const BEFORE_START = new Set(['draft', 'announced', 'registration', 'checkin']);

/** The clock for the countdown. Minutes are the finest unit it shows, so a
 *  30 s tick is enough. */
function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** Who may enter, as sentences. */
function entryLines(ev: EventView): string[] {
  const e = ev.eligibility;
  const lines = [`At least ${e.minPugs} completed PUG${e.minPugs === 1 ? '' : 's'}, account in good standing`];
  if (e.requireDiscord) lines.push('Discord linked to the site');
  if (e.srFloor !== null && e.srCeiling !== null) lines.push(`SR ${e.srFloor} to ${e.srCeiling}`);
  else if (e.srFloor !== null) lines.push(`SR ${e.srFloor} or more`);
  else if (e.srCeiling !== null) lines.push(`SR ${e.srCeiling} or less`);
  if (ev.entryKind === 'team') {
    lines.push(`4 starters and up to ${ev.roster.maxSubs} sub${ev.roster.maxSubs === 1 ? '' : 's'}`);
    if (ev.teamCap !== null) lines.push(`Up to ${ev.teamCap} teams`);
  }
  lines.push(ev.checkin.enabled
    ? `Check-in opens ${ev.checkin.opensMinutes} minutes before the start and closes ${ev.checkin.closesMinutes} minutes before`
    : 'No check-in');
  return lines;
}

/** One event, read only (spec section 7, T1a part): status and countdown,
 *  format strip, rules and pools per stage, who may enter, entries. */
export function EventPage({ slug, session }: { slug: string; session: Session }) {
  const [ev, setEv] = useState<EventView | null>(null);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);
  const now = useNow();

  useEffect(() => {
    const ctl = new AbortController();
    setEv(null);
    setMissing(false);
    setFailed(false);
    eventsApi.get(slug, ctl.signal).then(setEv, (e) => {
      if (ctl.signal.aborted) return;
      if (e instanceof ApiError && e.status === 404) setMissing(true);
      else setFailed(true);
    });
    return () => ctl.abort();
  }, [slug, session.kind]);

  if (missing) return <main class="page page--profile"><PageHeader title="Event" /><Empty>No such event, or events are not open yet.</Empty></main>;
  if (failed) return <main class="page page--profile"><PageHeader title="Event" /><p class="error" role="alert">Could not load this event. Try again in a moment.</p></main>;
  if (!ev) return <main class="page page--profile"><PageHeader title="Event" /></main>;

  return (
    <main class="page page--profile eventpage">
      {ev.bannerKey && <img class="eventbanner" src={bannerUrl(ev.bannerKey)} alt="" width={1600} height={400} />}
      <PageHeader
        eyebrow={ev.official ? 'Official event' : 'Community event'}
        title={ev.name}
        aside={<span class={`teamchip eventstatus eventstatus--${ev.status}`}>{STATUS_LABEL[ev.status]}</span>}
      >
        <p class="eventpage__when">
          Starts {whenText(ev.startsAt)}
          {BEFORE_START.has(ev.status) && <span class="eventpage__countdown"> · {untilText(ev.startsAt, now)}</span>}
          {ev.organizerName && <span class="muted"> · organized by {ev.organizerName}</span>}
        </p>
      </PageHeader>
      {ev.status === 'draft' && <p class="warning">Draft: only staff can see this page.</p>}
      {ev.status === 'cancelled' && <p class="warning">This event was cancelled{ev.cancelReason ? `: ${ev.cancelReason}` : '.'}</p>}
      {ev.description && <Panel><RichText class="eventdesc" text={ev.description} /></Panel>}
      <Panel>
        <h3>Format</h3>
        {ev.stages.length === 0 ? <Empty>The format is not set yet.</Empty> : (
          <ol class="eventstrip">
            {ev.stages.map((s) => (
              <li key={s.ordinal} class="eventstrip__stage">
                <span class="eyebrow">Stage {s.ordinal}</span>
                <strong>{s.summary}</strong>
              </li>
            ))}
          </ol>
        )}
      </Panel>
      {ev.stages.map((s) => (
        <Panel key={s.ordinal}>
          <h3>Stage {s.ordinal}: rules and campaigns</h3>
          <p class="muted">
            {s.rulesetName ?? 'Ruleset'} · {s.veto} · {s.chapters} · {s.scheduling === 'window' ? 'played in scheduled windows' : 'played in one session'} · {s.gameConfig}
          </p>
          {s.rules.length > 0 && <ul class="eventrules">{s.rules.map((r) => <li key={r}>{r}</li>)}</ul>}
          <p class="eventpool">{s.campaigns.map((c) => <span key={c.slug} class="chip">{c.name}</span>)}</p>
        </Panel>
      ))}
      <Panel>
        <h3>Entry</h3>
        {ev.entryKind === 'draft' && <p>Draft event: individual signups open later.</p>}
        <ul class="eventrules">{entryLines(ev).map((l) => <li key={l}>{l}</li>)}</ul>
      </Panel>
      <Panel>
        <h3>{ev.entryKind === 'team' ? 'Teams' : 'Entries'}</h3>
        {ev.entries.length === 0
          ? <Empty>{ev.entryKind === 'team' ? 'No teams have entered yet.' : 'No entries yet.'}</Empty>
          : (
            <ul class="eventlist">
              {ev.entries.map((e) => (
                <li key={`${e.seed ?? ''}-${e.name}`}>
                  {e.seed !== null && <span class="muted">#{e.seed} </span>}{e.name}{e.tag && <span class="muted"> [{e.tag}]</span>}
                </li>
              ))}
            </ul>
          )}
      </Panel>
    </main>
  );
}

export default EventPage;
