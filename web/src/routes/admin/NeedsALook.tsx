import { useState } from 'preact/hooks';
import { peopleApi, type AnalyzerRank } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel } from '../../components/bits';
import { fmtTime, useAction } from './useAction';
import { fileUrl } from './adminRoutes';
import { SOURCE_LABEL } from './file/GlanceRow';
import { AnalysisPanel } from './AnalysisPanel';

type SortKey = 'rank' | 'tracking';

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
 * Two tabs, split 2026-09-22 because one screen holding the queue, the
 * analyzer's ranking and a pipeline health line read as confusing. The queue
 * says in words what arrived and shows no scores: a rank beside a flag read
 * like a verdict. The ranking keeps its own tab because retiring it left a
 * real gap: a player the analyzer ranks high with nothing else attached was on
 * no list at all. Capture health moved to the Servers panel on Live.
 */
export function NeedsALook({ isAdmin }: { isAdmin: boolean }) {
  const { data, reload } = useFetch((s) => peopleApi.review(s), []);
  const { busy, error, run } = useAction(reload);
  const [tab, setTab] = useState<'queue' | 'ranking'>('queue');
  const [sort, setSort] = useState<SortKey>('rank');

  const players = [...(data?.players ?? [])].sort((a, b) => (a.newestEvidenceAt < b.newestEvidenceAt ? 1 : -1));
  // The server sends this in the board's own order, by composite, so an
  // untouched sort key leaves it exactly as the analyzer ranked it.
  const measured = [...(data?.measured ?? [])].sort((a, b) => byAnalyzer(sort, a, b));

  const sortHead = (key: 'rank' | 'tracking', label: string) => (
    <th aria-sort={sort === key ? 'descending' : 'none'}>
      <button class="linklike" type="button" onClick={() => setSort(key)}>{label}</button>
    </th>
  );

  return (
    <>
      <div class="replay__rounds" role="tablist" aria-label="Needs a look">
        <button class={`chip ${tab === 'queue' ? 'is-on' : ''}`} role="tab" aria-selected={tab === 'queue'}
          onClick={() => setTab('queue')}>
          To read{data ? ` (${players.length})` : ''}
        </button>
        <button class={`chip ${tab === 'ranking' ? 'is-on' : ''}`} role="tab" aria-selected={tab === 'ranking'}
          onClick={() => setTab('ranking')}>
          Analyzer ranking
        </button>
      </div>
      {error && <p class="error">{error}</p>}

      {tab === 'queue' ? (
        <Panel class="panel--table">
          <p class="muted">
            Players with something new on their file that nobody has read yet, newest first. Marking one
            looked at takes it off this list until something else arrives.
          </p>
          {data && players.length === 0 && <Empty>Nothing is waiting to be looked at.</Empty>}
          {players.length > 0 && (
            <div class="table-wrap">
              <table class="admin-table admin-table--pin-last">
                <thead>
                  <tr>
                    <th>Player</th>
                    <th>What arrived</th>
                    <th>Newest</th>
                    <th>Tickets</th>
                    <th>Last looked at</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {players.map((p) => (
                    <tr key={p.steamid}>
                      <td><a href={fileUrl(p.steamid)}>{p.name}</a></td>
                      <td>{p.arrived || p.sources.map((s) => SOURCE_LABEL[s]).join(', ')}</td>
                      <td class="muted">{fmtTime(p.newestEvidenceAt)}</td>
                      <td>
                        {p.openTickets === 0 ? <span class="muted">none</span>
                          : <a href="/admin/people/tickets">{p.openTickets} open</a>}
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
        </Panel>
      ) : (
        <>
          <Panel class="panel--table">
            <p class="muted">
              Everyone the replay analyzer has measured, by its composite. A sort key, not a claim: the top
              of this list is also a list of your best players. Open a file and watch the rounds before
              thinking anything.
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
          </Panel>
          {/* Admins only: it asks an admin-only endpoint, and a moderator would
              get a 403 for a control they may not use anyway. */}
          {isAdmin && <AnalysisPanel />}
        </>
      )}
    </>
  );
}
