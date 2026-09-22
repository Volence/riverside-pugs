import { useState } from 'preact/hooks';
import { peopleApi, type AnalyzerRank } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel } from '../../components/bits';
import { fmtTime, useAction } from './useAction';
import { fileUrl } from './adminRoutes';
import { SOURCE_LABEL } from './file/GlanceRow';
import { AnalysisPanel } from './AnalysisPanel';

type SortKey = 'newest' | 'rank' | 'tracking';

const num = (v: number | null): string => (v == null ? 'n/a' : v.toFixed(2));
const num3 = (v: number | null): string => (v == null ? 'n/a' : v.toFixed(3));

/** The rank cell, in both views.
 *
 *  `ranked` and a rank of null are separate facts on the wire, and only the
 *  first was being asked: a ranked row with no number printed "null of 82". */
function rankText(a: AnalyzerRank | null) {
  if (a === null) return <span class="muted">not analysed</span>;
  if (!a.ranked || a.rank === null) return <span class="muted">too few rounds</span>;
  return `${a.rank} of ${a.of}`;
}

/** Rank first, then tracking, with nothing-to-sort-on last either way. */
function byAnalyzer(sort: SortKey, a: AnalyzerRank | null, b: AnalyzerRank | null): number {
  if (sort === 'tracking') return (b?.trackShare ?? -1) - (a?.trackShare ?? -1);
  return (a?.rank ?? Number.MAX_SAFE_INTEGER) - (b?.rank ?? Number.MAX_SAFE_INTEGER);
}

/**
 * Everyone with evidence nobody has read yet, newest first.
 *
 * This replaces the integrity board, and deliberately is not one: the board
 * ranked every player who had ever been measured, which is a list of your
 * best players by another name. This lists only files where something has
 * arrived since the last time a person looked, and it empties as they are
 * worked through, which is the whole point.
 *
 * The board's population is still reachable, behind the toggle, because
 * retiring it left a real gap: a player the analyzer ranks high who has no
 * flagged clip and nothing else attached was on no list at all. It is a
 * second view of the same request, not a second screen, so the framing above
 * it travels with it.
 */
export function NeedsALook({ isAdmin }: { isAdmin: boolean }) {
  const { data, reload } = useFetch((s) => peopleApi.review(s), []);
  const { busy, error, run } = useAction(reload);
  const [sort, setSort] = useState<SortKey>('newest');
  const [everyone, setEveryone] = useState(false);

  const players = [...(data?.players ?? [])].sort((a, b) => {
    if (sort === 'newest') return a.newestEvidenceAt < b.newestEvidenceAt ? 1 : -1;
    return byAnalyzer(sort, a.analyzer, b.analyzer);
  });
  // The server sends this in the board's own order, by composite, so an
  // untouched sort key leaves it exactly as the analyzer ranked it.
  const measured = [...(data?.measured ?? [])].sort((a, b) => (
    sort === 'newest' ? 0 : byAnalyzer(sort, a, b)
  ));

  const sortHead = (key: 'rank' | 'tracking', label: string) => (
    <th aria-sort={sort === key ? 'descending' : 'none'}>
      <button class="linklike" type="button" onClick={() => setSort(key)}>{label}</button>
    </th>
  );

  return (
    <>
      <Panel class="panel--table">
        <p class="muted">
          Files with something on them that nobody has read yet. Marking one looked at takes it off
          this list until something new arrives. The columns are a way of deciding what to read
          first, never a finding.
        </p>
        <p>
          <button class="linklike" type="button" onClick={() => setEveryone(!everyone)}>
            {everyone ? 'Back to what needs a look' : 'Everyone the analyzer has measured'}
          </button>
        </p>
        {error && <p class="error">{error}</p>}

        {everyone ? (
          <>
            <p class="muted">
              Sorted by the analyzer's composite. A sort key, not a claim: the top of this list is
              also a list of your best players. Open a file and watch the rounds before thinking
              anything.
            </p>
            {data && measured.length === 0 && <Empty>The analyzer has measured nobody yet.</Empty>}
            {measured.length > 0 && (
              <div class="table-wrap">
                <table class="admin-table">
                  <thead>
                    <tr>
                      <th>Player</th>
                      {sortHead('rank', 'Analyzer rank')}
                      {sortHead('tracking', 'Tracking')}
                      <th>Occupancy</th>
                      <th>Team gap</th>
                    </tr>
                  </thead>
                  <tbody>
                    {measured.map((m) => (
                      <tr key={m.steamid}>
                        <td>
                          <a href={fileUrl(m.steamid)}>{m.name}</a>
                          <div class="mono muted">{m.steamid}</div>
                        </td>
                        <td>{rankText(m)}</td>
                        <td>{num3(m.trackShare)}</td>
                        <td>{num(m.occZ)}</td>
                        <td>{num(m.teamGap)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <>
            {data && players.length === 0 && <Empty>Nothing is waiting to be looked at.</Empty>}
            {players.length > 0 && (
              <div class="table-wrap">
                <table class="admin-table admin-table--pin-last">
                  <thead>
                    <tr>
                      <th>Player</th>
                      <th><button class="linklike" type="button" onClick={() => setSort('newest')}>Newest</button></th>
                      <th>What arrived</th>
                      {sortHead('rank', 'Analyzer rank')}
                      {sortHead('tracking', 'Tracking')}
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
                        <td>{rankText(p.analyzer)}</td>
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
          </>
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
