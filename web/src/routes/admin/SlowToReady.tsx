import { useState } from 'preact/hooks';
import type { SlowToReady } from '../../api';
import { formatTime } from '../../replay/ReplayControls';

/** Below this many ready-ups a share is noise: one of two is 50 percent. A
 *  match is about eight ready-ups, so this is two or three matches. */
export const MIN_READYUPS = 20;

type SortKey = 'last' | 'avg' | 'total';
const VALUE: Record<SortKey, (p: SlowToReady) => number> = {
  // The share, not the count: somebody last 20 times in 68 holds the lobby up
  // more often than somebody last 22 times in 114.
  last: (p) => (p.readyups > 0 ? p.timesLast / p.readyups : 0),
  avg: (p) => p.avgSeconds,
  total: (p) => p.totalSeconds,
};
const LABEL: Record<SortKey, string> = { last: 'Last', avg: 'Avg unready', total: 'Total unready' };

export function SlowToReadyTable({ rows }: { rows: SlowToReady[] }) {
  const [sort, setSort] = useState<SortKey>('last');
  const [desc, setDesc] = useState(true);
  const [all, setAll] = useState(false);
  if (rows.length === 0) return null;

  const enough = rows.filter((p) => p.readyups >= MIN_READYUPS);
  // Early in a season nobody has enough; an empty table would say less than
  // a noisy one.
  const canFilter = enough.length > 0 && enough.length < rows.length;
  const shown = all || enough.length === 0 ? rows : enough;
  const sorted = [...shown].sort((a, b) => {
    const d = VALUE[sort](b) - VALUE[sort](a);
    // Ties by sample size, then id, so the order never shuffles between polls.
    return (desc ? d : -d) || b.readyups - a.readyups || a.steamid.localeCompare(b.steamid);
  });
  const pick = (k: SortKey) => {
    if (k === sort) setDesc(!desc);
    else { setSort(k); setDesc(true); }
  };
  const head = (k: SortKey) => (
    <th class="num" aria-sort={sort === k ? (desc ? 'descending' : 'ascending') : 'none'}>
      <button class="linklike" type="button" onClick={() => pick(k)}>
        {LABEL[k]}{sort === k ? (desc ? ' ▾' : ' ▴') : ''}
      </button>
    </th>
  );

  return (
    <>
      <h3>Slow to ready</h3>
      <p class="muted">
        Across every counted match. "Last" is the share of their ready-ups where they were the one
        everybody was waiting on when the round went live. Click a column to sort by it.
      </p>
      {canFilter && (
        <label class="muted">
          <input type="checkbox" checked={all} onChange={(e) => setAll((e.target as HTMLInputElement).checked)} />
          {' '}Include players with fewer than {MIN_READYUPS} ready-ups
        </label>
      )}
      <div class="table-wrap">
        <table class="admin-table">
          <thead><tr><th>Player</th>{head('last')}{head('avg')}{head('total')}</tr></thead>
          <tbody>
            {sorted.map((p) => (
              <tr key={p.steamid}>
                <td><a href={`/player/${p.steamid}`}>{p.name}</a></td>
                <td class="num">
                  {Math.round(VALUE.last(p) * 100)}% <span class="muted">{p.timesLast} of {p.readyups}</span>
                </td>
                <td class="num">{formatTime(p.avgSeconds * 1000)}</td>
                <td class="num">{formatTime(p.totalSeconds * 1000)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
