import { peopleApi, type FileAction, type PlayerFileData } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty, Panel } from '../../../components/bits';
import { campaignName } from '../../../format';
import { fmtTime, useAction } from '../useAction';
import { ticketUrl } from '../adminRoutes';
import { FileHeader } from './FileHeader';
import { GlanceRow } from './GlanceRow';
import { IdentitySection } from './IdentitySection';
import { StandingSection } from './StandingSection';
import { ConductSection } from './ConductSection';
import { NotesSection } from './NotesSection';
import { Timeline } from './Timeline';
import { EvidenceDetail } from './EvidenceDetail';

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

  return (
    <div class="file">
      <Panel class="file-section">
        <FileHeader d={d} me={me} busy={busy} run={run} can={can} />
        {actionError && <p class="error">{actionError}</p>}
        <GlanceRow d={d} />
      </Panel>

      <Panel class="file-section">
        <h3>Evidence timeline</h3>
        <Timeline items={d.timeline} />
      </Panel>

      <IdentitySection d={d} busy={busy} run={run} can={can} />
      <StandingSection d={d} busy={busy} run={run} can={can} />
      <ConductSection d={d} />
      <EvidenceDetail d={d} busy={busy} run={run} canReview={canReview} />

      <Panel class="file-section">
        <h3>Tickets</h3>
        {d.sections.tickets.length === 0 ? <p class="muted">None.</p> : (
          <ul class="admin-list">
            {d.sections.tickets.map((t) => (
              <li key={t.id}>
                <a href={ticketUrl(t.id)}>#{t.id}</a> · {t.categories.join(', ') || 'opened by staff'}
                {' · '}{t.status === 'open' ? 'open' : (t.outcome ?? 'closed').replace(/_/g, ' ')}
                {' · '}{fmtTime(t.createdAt)}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <NotesSection d={d} busy={busy} run={run} can={can} />

      <Panel class="file-section">
        <h3>Recent matches</h3>
        {d.sections.matches.length === 0 ? <p class="muted">None.</p> : (
          <ul class="admin-list">
            {d.sections.matches.map((m) => (
              <li key={m.id}>
                <a href={`/match/${m.id}`}>#{m.id}</a> {campaignName(m.campaign)} · {m.state} · team {m.team.toUpperCase()}
                {(m.state === 'completed' || m.state === 'aborted') && (
                  <> · <a href={`/match/${m.id}?chat=${d.steamid}#chat`}>chat</a></>
                )}
                {m.state === 'aborted' && !m.connectedAt && <span class="admin-warn"> · never connected</span>}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
