import { useState } from 'preact/hooks';
import { peopleApi } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel } from '../../components/bits';
import { fmtTime, useAction } from './useAction';
import { fileUrl } from './adminRoutes';
import { SOURCE_LABEL } from './file/GlanceRow';
import { AnalysisPanel } from './AnalysisPanel';

type SortKey = 'newest' | 'rank' | 'tracking';

const num3 = (v: number | null): string => (v == null ? 'n/a' : v.toFixed(3));

/**
 * Everyone with evidence nobody has read yet, newest first.
 *
 * This replaces the integrity board, and deliberately is not one: the board
 * ranked every player who had ever been measured, which is a list of your
 * best players by another name. This lists only files where something has
 * arrived since the last time a person looked, and it empties as they are
 * worked through, which is the whole point.
 */
export function NeedsALook({ isAdmin }: { isAdmin: boolean }) {
  const { data, reload } = useFetch((s) => peopleApi.review(s), []);
  const { busy, error, run } = useAction(reload);
  const [sort, setSort] = useState<SortKey>('newest');

  const players = [...(data?.players ?? [])].sort((a, b) => {
    if (sort === 'rank') {
      // Unranked players have nothing to rank on and go last, whichever way
      // the column is read.
      const ra = a.analyzer?.rank ?? Number.MAX_SAFE_INTEGER;
      const rb = b.analyzer?.rank ?? Number.MAX_SAFE_INTEGER;
      return ra - rb;
    }
    if (sort === 'tracking') return (b.analyzer?.trackShare ?? -1) - (a.analyzer?.trackShare ?? -1);
    return a.newestEvidenceAt < b.newestEvidenceAt ? 1 : -1;
  });

  return (
    <>
      <Panel class="panel--table">
        <p class="muted">
          Files with something on them that nobody has read yet. Marking one looked at takes it off
          this list until something new arrives. The columns are a way of deciding what to read
          first, never a finding.
        </p>
        {error && <p class="error">{error}</p>}
        {data && players.length === 0 && <Empty>Nothing is waiting to be looked at.</Empty>}
        {players.length > 0 && (
          <div class="table-wrap">
            <table class="admin-table admin-table--pin-last">
              <thead>
                <tr>
                  <th>Player</th>
                  <th><button class="linklike" type="button" onClick={() => setSort('newest')}>Newest</button></th>
                  <th>What arrived</th>
                  <th><button class="linklike" type="button" onClick={() => setSort('rank')}>Analyzer rank</button></th>
                  <th><button class="linklike" type="button" onClick={() => setSort('tracking')}>Tracking</button></th>
                  <th>Open tickets</th>
                  <th>Last looked at</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {players.map((p) => (
                  <tr key={p.steamid}>
                    <td>
                      <a href={fileUrl(p.steamid)}>{p.name}</a>
                      <div class="mono muted">{p.steamid}</div>
                    </td>
                    <td class="muted">{fmtTime(p.newestEvidenceAt)}</td>
                    <td>{p.sources.map((s) => SOURCE_LABEL[s]).join(', ')}</td>
                    <td>
                      {p.analyzer === null ? <span class="muted">not analysed</span>
                        : p.analyzer.ranked ? `${p.analyzer.rank} of ${p.analyzer.of}`
                          : <span class="muted">too few rounds</span>}
                    </td>
                    <td>{num3(p.analyzer?.trackShare ?? null)}</td>
                    <td>
                      {p.openTickets === 0 ? <span class="muted">none</span>
                        : <a href="/admin/people/tickets">{p.openTickets} open ticket{p.openTickets === 1 ? '' : 's'}</a>}
                    </td>
                    <td class="muted">
                      {p.lastReviewAt ? `${fmtTime(p.lastReviewAt)} by ${p.lastReviewBy}` : 'never'}
                    </td>
                    <td>
                      <button class="chip" type="button" disabled={busy}
                        onClick={() => run(() => peopleApi.lookedAt(p.steamid, ''))}>Looked at</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data?.health && (
          // Rendered even when everything is zero: an empty list cannot
          // otherwise tell "nobody flagged" apart from "silently broken".
          <p class="muted">
            {data.health.bursts === 0
              ? 'No input bursts captured yet. Bursts are only recorded during a live match, so this stays empty until a PUG runs.'
              : `${data.health.bursts.toLocaleString()} input bursts across ${data.health.matchesWithBursts} match${data.health.matchesWithBursts === 1 ? '' : 'es'}, most recent ${fmtTime(data.health.lastBurstAt)}.`}
            {' '}
            {data.health.detections === 0 && data.health.lilacFlags === 0
              ? 'Nothing flagged.'
              : `${data.health.detections} input detection${data.health.detections === 1 ? '' : 's'}, ${data.health.lilacFlags} Little Anti-Cheat flag${data.health.lilacFlags === 1 ? '' : 's'}.`}
            {data.health.caps > 0 && ` Capture was truncated ${data.health.caps} time${data.health.caps === 1 ? '' : 's'} by the per-round budget; each file says where.`}
          </p>
        )}
      </Panel>
      {/* Admins only: it asks an admin-only endpoint, and a moderator would
          get a 403 for a control they may not use anyway. */}
      {isAdmin && <AnalysisPanel />}
    </>
  );
}
