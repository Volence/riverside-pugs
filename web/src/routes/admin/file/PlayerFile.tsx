import { peopleApi, type BlockEntry, type FileAction, type PlayerFileData } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty, Panel } from '../../../components/bits';
import { campaignName, campaignTint } from '../../../format';
import { fmtTime, useAction } from '../useAction';
import { ticketUrl } from '../adminRoutes';
import { FileActions, FileHeader } from './FileHeader';
import { GlanceRow } from './GlanceRow';
import { IdentitySection } from './IdentitySection';
import { StandingBanner, StandingSection } from './StandingSection';
import { ConductSection } from './ConductSection';
import { NotesSection } from './NotesSection';
import { Timeline } from './Timeline';
import { EvidenceDetail } from './EvidenceDetail';
import { RecordLine, recordText } from '../../../components/ScrimRecord';
import { reviewSummaryText } from '../../../components/ReviewSummary';

/** One party's block list (scrim blocks plan), read-only on the People desk:
 *  each entry's target by name, or "None." for an empty list. */
function blockListText(blocks: BlockEntry[]): string {
  if (blocks.length === 0) return 'None.';
  return blocks.map((b) => (b.target.kind === 'team' ? `[${b.target.tag}] ${b.target.name}` : b.target.name)).join(', ');
}

/**
 * Everything known about one player, at one URL.
 *
 * What a viewer may do arrives with the data as `actions`, decided by the
 * server, and every control asks that list rather than the session: the UI
 * only hides what the API would refuse anyway.
 */
export function PlayerFile({ steamid, me }: { steamid: string; me: string }) {
  const { data, error, reload } = useFetch((s) => peopleApi.file(steamid, s), [steamid]);
  const { busy, error: actionError, run } = useAction(reload);

  if (error) {
    return (
      <Panel>
        <Empty>No such player, or not a file you can open.</Empty>
        <p class="muted"><a href="/admin/people">Back to People</a></p>
      </Panel>
    );
  }
  if (!data) return <Panel><p class="muted">Loading...</p></Panel>;
  const d: PlayerFileData = data;
  const can = (action: FileAction) => d.actions.includes(action);
  // review_round is its own admin-only permission (src/admin/fileAccess.ts),
  // asked directly rather than inferred from another action like 'ban'.
  const canReview = can('review_round');

  const jumps: [href: string, label: string, show: boolean][] = [
    ['#timeline', 'Timeline', true],
    ['#standing', 'Bans and penalties', true],
    ['#evidence', 'Evidence', true],
    ['#conduct', 'Conduct', !!d.sections.conduct],
    ['#identity', 'Identity', true],
    ['#notes', 'Notes', true],
    ['#tickets', 'Tickets', true],
    ['#scrims', 'Scrims', !!d.sections.scrims],
    ['#matches', 'Matches', true],
  ];

  return (
    <div class="file">
      <Panel class="file-hero">
        <div class="file-hero__top">
          <FileHeader d={d} />
          <FileActions d={d} me={me} busy={busy} run={run} can={can} />
        </div>
        <StandingBanner d={d} busy={busy} run={run} can={can} />
        {actionError && <p class="error">{actionError}</p>}
        <GlanceRow d={d} />
      </Panel>

      <nav class="file-jump" aria-label="Sections of this file">
        {jumps.filter(([, , show]) => show).map(([href, label]) => <a key={href} class="chip" href={href}>{label}</a>)}
      </nav>

      {/* Reading on the left, the record staff act on (standing, notes,
          tickets) on the right; one column under 1100px, in that order. */}
      <div class="file-cols">
        <div class="file-main">
          <Panel class="file-section" id="timeline">
            <h3>Evidence timeline</h3>
            <Timeline items={d.timeline} />
          </Panel>
          <EvidenceDetail d={d} busy={busy} run={run} canReview={canReview} />
          <ConductSection d={d} />
          <IdentitySection d={d} busy={busy} run={run} can={can} />
          <Panel class="file-section" id="matches">
            <h3>Recent matches</h3>
            {d.sections.matches.length === 0 ? <p class="muted">None.</p> : (
              <ul class="file-matches">
                {d.sections.matches.map((m) => (
                  <li key={m.id} class="file-match" style={{ '--campaign': campaignTint(m.campaign) } as Record<string, string>}>
                    <a class="file-match__id" href={`/match/${m.id}`}>#{m.id}</a>
                    <span class="file-match__camp">{campaignName(m.campaign)}</span>
                    <span class={`file-pill file-pill--${m.state === 'completed' ? 'ok' : m.state === 'aborted' ? 'warn' : 'lifted'}`}>{m.state}</span>
                    <span class="file-match__team">team {m.team.toUpperCase()}</span>
                    {m.state === 'aborted' && !m.connectedAt && <span class="file-pill file-pill--warn">never connected</span>}
                    {(m.state === 'completed' || m.state === 'aborted') && (
                      <a class="file-match__chat" href={`/match/${m.id}?chat=${d.steamid}#chat`}>chat</a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <aside class="file-side">
          <StandingSection d={d} busy={busy} run={run} can={can} />
          <NotesSection d={d} busy={busy} run={run} can={can} />
          <Panel class="file-section" id="tickets">
            <h3>Tickets <span class="file-count">{d.sections.tickets.length}</span></h3>
            {d.sections.tickets.length === 0 ? <p class="muted">None.</p> : (
              <ul class="file-rows">
                {d.sections.tickets.map((t) => (
                  <li key={t.id} class={`file-row${t.status === 'open' ? '' : ' is-past'}`}>
                    <div class="file-row__main">
                      <span><a href={ticketUrl(t.id)}>#{t.id}</a> {t.categories.join(', ') || 'opened by staff'}</span>
                      <span class={`file-pill file-pill--${t.status === 'open' ? 'active' : 'lifted'}`}>
                        {t.status === 'open' ? 'open' : (t.outcome ?? 'closed').replace(/_/g, ' ')}
                      </span>
                    </div>
                    <div class="file-row__meta">{fmtTime(t.createdAt)}</div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          {d.sections.scrims && (
            <Panel class="file-section" id="scrims">
              <h3>Scrims</h3>
              <RecordLine record={d.sections.scrims.pickup} label="As a pickup captain" />
              {d.sections.scrimReviews && (
                <p class="scrimrecord">
                  <span class="muted">Reviews as a pickup captain: </span>
                  <span>{reviewSummaryText(d.sections.scrimReviews.pickup.summary)}</span>
                  {d.sections.scrimReviews.pickup.toxic && <span class="admin-warn"> · Toxic tags</span>}
                </p>
              )}
              {d.sections.scrims.teams.map((t) => {
                const rt = d.sections.scrimReviews?.teams.find((x) => x.teamId === t.teamId);
                return (
                  <p key={t.teamId} class="scrimrecord">
                    <a href={`/team/${t.slug}`}>[{t.tag}] {t.name}</a>
                    <span class="muted">: </span>
                    <span>{recordText(t.record)}</span>
                    {rt && <span class="muted"> · Reviews: </span>}
                    {rt && <span>{reviewSummaryText(rt.summary)}</span>}
                    {rt?.toxic && <span class="admin-warn"> · Toxic tags</span>}
                  </p>
                );
              })}
              {d.sections.scrimBlocks && (
                <>
                  <h4>Blocks</h4>
                  <p class="scrimrecord">
                    <span class="muted">As a pickup captain: </span>
                    <span>{blockListText(d.sections.scrimBlocks.pickup)}</span>
                  </p>
                  {d.sections.scrimBlocks.teams.map((t) => (
                    <p key={t.teamId} class="scrimrecord">
                      <a href={`/team/${t.slug}`}>[{t.tag}] {t.name}</a>
                      <span class="muted">: </span>
                      <span>{blockListText(t.blocks)}</span>
                    </p>
                  ))}
                </>
              )}
            </Panel>
          )}
        </aside>
      </div>
    </div>
  );
}
