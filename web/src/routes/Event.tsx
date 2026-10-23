import { useEffect, useState } from 'preact/hooks';
import { ApiError, bannerUrl, entryLogoUrl, eventsApi, type EventDraftView, type EventView, type MyEventView } from '../api';
import { RichText } from '../components/RichText';
import { Empty, PageSkeleton, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import type { Session } from '../hooks/useLiveState';
import { STATUS_LABEL, placementText, untilText, whenText } from '../eventFormat';
import { DraftSignupPanel } from './event/DraftSignupPanel';
import { DraftIdentityPanel } from './event/DraftIdentityPanel';
import { StandinPanel } from './event/StandinPanel';
import { KeepTeamPanel } from './event/KeepTeamPanel';
import { EntryPanel } from './event/EntryPanel';
import { PrepPanel } from './event/PrepPanel';
import { StagePlay } from './event/StagePlay';
import { EventFigures, EventTimeline, StageRulesCard, TeamsGrid } from './event/EventOverview';

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
  // Check-in is a team-event step; a draft has none until plan D2.
  if (ev.entryKind === 'team') {
    lines.push(ev.checkin.enabled
      ? `Check-in opens ${ev.checkin.opensMinutes} minutes before the start and closes ${ev.checkin.closesMinutes} minutes before`
      : 'No check-in');
  }
  return lines;
}

function NameChips({ names }: { names: string[] }) {
  // Player names keep their own case: upper-casing turned "P $tache" into "P STACHE" and made look-alike names harder to tell apart.
  return <p class="eventpool">{names.map((n, i) => <span key={`${i}:${n}`} class="teamchip teamchip--name">{n}</span>)}</p>;
}

/** The public draft section (drafts plan D1 Ruling 9): the clock line, then
 *  the signup count and names, or once the cut is published the three lists.
 *  Names only, never SR, notes or preferences. */
function DraftSection({ ev, draft, session }: { ev: EventView; draft: EventDraftView; session: Session }) {
  const cut = draft.cut;
  const closed = ev.lockedAt !== null || Date.now() >= Date.parse(draft.signupsCloseAt);
  const open = !cut && ev.status === 'registration' && !closed;
  return (
    <Panel class="draftsection">
      <div class="draftsection__head">
        <h3>Draft</h3>
        {cut && (
          <a class={`btn${ev.status === 'registration' ? '' : ' btn--ghost'}`} href={`/event/${ev.slug}/draft`}>Draft room</a>
        )}
      </div>
      {open && session.kind === 'anonymous' && (
        <p class="draftsection__cta">
          <a class="btn" href={`/auth/steam?next=${encodeURIComponent(`/event/${ev.slug}`)}`} target="_top" rel="noopener">Sign in through Steam</a>
          <span class="muted">to sign up.</span>
        </p>
      )}
      {open && session.kind === 'pending' && (
        <p class="muted">Your account is not active yet, so you cannot sign up.</p>
      )}
      {cut && ev.entries.length > 0 ? (
        <details class="draftsection__done">
          <summary>Teams are drafted. Show who was captain, in the pool and on the bench</summary>
          <DraftGroups cut={cut} />
        </details>
      ) : cut ? (
        <>
          <p class="muted">Player cards, captains' pick lists and the live draft are in the draft room.</p>
          <DraftGroups cut={cut} />
        </>
      ) : (
        <>
          <p class="draftsection__signed"><strong>{draft.signups} signed up</strong></p>
          {draft.names.length > 0 && <NameChips names={draft.names} />}
        </>
      )}
    </Panel>
  );
}

/** The published cut's three lists, each with its count. */
function DraftGroups({ cut }: { cut: NonNullable<EventDraftView['cut']> }) {
  return (
    <div class="draftsection__groups">
      {([['Captains', cut.captains], ['Pool', cut.pool], ['Bench', cut.bench]] as const).map(([label, names]) => (
        <div key={label} class="draftsection__group">
          <div class="draftsection__grouphead"><h4>{label}</h4><span class="draftsection__count num">{names.length}</span></div>
          {names.length === 0 ? <Empty>Nobody.</Empty> : <NameChips names={names} />}
        </div>
      ))}
    </div>
  );
}

/** One event, read only (spec section 7, T1a part): status and countdown,
 *  format strip, rules and pools per stage, who may enter, entries. */
export function EventPage({ slug, session }: { slug: string; session: Session }) {
  const [ev, setEv] = useState<EventView | null>(null);
  const [mine, setMine] = useState<MyEventView | null>(null);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [gen, setGen] = useState(0);
  const now = useNow();
  const bump = () => setGen((g) => g + 1);

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
    if (session.kind === 'active') {
      eventsApi.mine(slug, ctl.signal).then(setMine, () => { /* the panel just stays hidden */ });
    } else {
      setMine(null);
    }
    return () => ctl.abort();
  }, [slug, session.kind, gen]);

  // Plan T2 Ruling 16: while the event is live, refetch once a minute
  // without clearing the page, so brackets and standings move on their own.
  useEffect(() => {
    if (ev?.status !== 'live') return;
    const t = setInterval(() => { eventsApi.get(slug).then(setEv, () => { /* keep what is shown */ }); }, 60_000);
    return () => clearInterval(t);
  }, [slug, ev?.status]);

  if (missing) return <main class="page page--profile"><PageHeader title="Event" /><Empty>No such event, or events are not open yet.</Empty></main>;
  if (failed) {
    return (
      <main class="page page--profile">
        <PageHeader title="Event" />
        <p class="error" role="alert">Could not load this event. <button class="btn btn--ghost btn--sm" type="button" onClick={bump}>Try again</button></p>
      </main>
    );
  }
  if (!ev) return <PageSkeleton variant="profile" panels={3} />;

  const draftEvent = ev.entryKind === 'draft' && ev.draft;
  const myPanels = (
    <>
      {mine && draftEvent && (
        <DraftSignupPanel slug={ev.slug} eventName={ev.name} status={ev.status} lockedAt={ev.lockedAt} draft={ev.draft!} view={mine} onChange={bump} />
      )}
      {mine?.captainOf && ev.entryKind === 'draft' && <DraftIdentityPanel slug={ev.slug} mine={mine.captainOf} onChange={bump} />}
      {mine && ev.entryKind === 'draft' && <StandinPanel slug={ev.slug} />}
      {mine && ev.entryKind === 'draft' && ev.status === 'finished' && <KeepTeamPanel slug={ev.slug} />}
      {mine && ev.entryKind === 'team' && <EntryPanel slug={ev.slug} view={mine} maxSubs={ev.roster.maxSubs} onChange={bump} />}
      {mine && !['finished', 'cancelled'].includes(ev.status) && mine.entries
        .filter((e) => e.manage && (e.status === 'registered' || e.status === 'checked_in'))
        .map((e) => <PrepPanel key={e.id} slug={ev.slug} entryId={e.id} teamName={e.name} />)}
    </>
  );

  return (
    <main class="page page--list eventpage">
      {ev.bannerKey && <img class="eventbanner" src={bannerUrl(ev.bannerKey)} alt="" width={1600} height={400} />}
      <PageHeader
        eyebrow={ev.official ? 'Official event' : 'Community event'}
        title={ev.name}
        aside={<span class={`teamchip eventstatus eventstatus--${ev.status}`}>{ev.statusLabel ?? STATUS_LABEL[ev.status]}</span>}
      >
        <p class="eventpage__when">
          Starts {whenText(ev.startsAt)}
          {BEFORE_START.has(ev.status) && <span class="eventpage__countdown"> · {untilText(ev.startsAt, now)}</span>}
          {ev.organizerName && <span class="muted"> · organized by {ev.organizerName}</span>}
        </p>
        <EventFigures ev={ev} />
      </PageHeader>
      {ev.status === 'draft' && <p class="warning">Draft: only staff can see this page.</p>}
      {ev.status === 'cancelled' && <p class="warning">This event was cancelled{ev.cancelReason ? `: ${ev.cancelReason}` : '.'}</p>}
      <EventTimeline ev={ev} now={now} />
      {/* Once play starts the bracket is what people come for, so it leads and the description follows. */}
      {ev.play.map((s) => <StagePlay key={s.ordinal} stage={s} slug={ev.slug} />)}
      {myPanels}
      {draftEvent && ev.entries.length === 0 && <DraftSection ev={ev} draft={ev.draft!} session={session} />}
      {(ev.entryKind !== 'draft' || ev.entries.length > 0) && <Panel class="evteamspanel">
        <h3>Teams</h3>
        {ev.entries.length === 0
          ? <Empty>{ev.entryKind === 'team' ? 'No teams have entered yet.' : 'No entries yet.'}</Empty>
          : <TeamsGrid ev={ev} />}
      </Panel>}
      {draftEvent && ev.entries.length > 0 && <DraftSection ev={ev} draft={ev.draft!} session={session} />}
      <div class="evcols">
        <div class="evcols__main">
          {ev.description
            ? <Panel class="evabout"><RichText class="eventdesc" text={ev.description} /></Panel>
            : <Panel class="evabout"><Empty>No description yet.</Empty></Panel>}
        </div>
        <aside class="evcols__side">
          {ev.stages.length === 0 && <Panel class="evside"><h3>Format</h3><Empty>The format is not set yet.</Empty></Panel>}
          {ev.stages.length > 1 && (
            <Panel class="evside">
              <h3>Format</h3>
              <ol class="eventstrip">
                {ev.stages.map((s) => (
                  <li key={s.ordinal} class="eventstrip__stage">
                    <span class="eyebrow">Stage {s.ordinal}</span>
                    <strong>{s.summary}</strong>
                  </li>
                ))}
              </ol>
            </Panel>
          )}
          {ev.stages.map((s) => <StageRulesCard key={s.ordinal} s={s} only={ev.stages.length === 1} />)}
          <Panel class="evside">
            <h3>Who can enter</h3>
            <ul class="evchecks">{entryLines(ev).map((l) => <li key={l}>{l}</li>)}</ul>
            {ev.entryKind === 'team' && ev.checkinOpensAt && BEFORE_START.has(ev.status) && (
              <p class="muted">Check-in {whenText(ev.checkinOpensAt)} to {whenText(ev.checkinClosesAt!)}</p>
            )}
            {ev.lockedAt && <p class="muted">The entry list is final.</p>}
          </Panel>
        </aside>
      </div>
    </main>
  );
}

export default EventPage;
