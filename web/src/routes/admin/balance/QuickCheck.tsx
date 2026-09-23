import { adminApi, type CompareQuery, type CompareRow } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty } from '../../../components/bits';
import { rolling, trendGeometry } from './charts';
import { fmtChange, fmtValue } from './format';

const W = 800;
const H = 160;
/** Matches the backend's own TREND_WINDOW (src/balance.ts), which is not
 *  importable from the web bundle, so it is restated here as a named
 *  constant rather than a bare 10 in the rolling() call. */
const TREND_WINDOW = 10;

/** SQLite timestamps here are UTC but carry no offset, so Date.parse needs an
 *  explicit Z or every browser not in UTC reads them as local time. */
const time = (s: string) => Date.parse(`${s.replace(' ', 'T')}Z`);

/** The row expanded under a clicked Compare metric: its own numbers plus a
 *  trend chart, per-map bars and example replays fetched from
 *  adminApi.balanceMetric. `row` already carries the metric and phase to ask
 *  for (Task 7); this only needs `query` for the patch/origin/map filters. */
export function QuickCheck({ query, row }: { query: CompareQuery; row: CompareRow }) {
  const d = useFetch(
    (s) => adminApi.balanceMetric(query, row.metric, row.phase, s),
    [JSON.stringify(query), row.metric, row.phase],
  );
  const ch = fmtChange(row.metric, row);
  const detail = d.data;
  const pts = (detail?.trend ?? []).map((p) => ({ t: time(p.endedAt), v: p.value, side: p.side }));
  const boundaryTimes = (detail?.boundaries ?? []).map((b) => time(b.at));
  // A patch's first_seen_at is usually before its first match, so the x
  // domain has to widen to cover it or the oldest boundary line draws with
  // a negative x, off the left edge of the chart.
  const g = trendGeometry(pts, W, H, 6, boundaryTimes);
  const mean = rolling(pts.map((p) => p.v), TREND_WINDOW);
  const maxBar = Math.max(1e-9, ...(detail?.perMap ?? []).flatMap((m) => [m.a, m.b]));

  return (
    <div class="balance-check stack">
      <p>
        A {fmtValue(row.metric, row.a)} ({row.nA} matches) vs B {fmtValue(row.metric, row.b)} ({row.nB} matches).
        {' '}Change {ch.main}{ch.range && <>, likely range {ch.range}</>}.
        {row.verdict === 'too_early' && row.moreMatches !== null && (
          <> Needs about {row.moreMatches >= 500 ? '500+' : row.moreMatches} more matches.</>
        )}
      </p>
      {row.excludedMaps.length > 0 && (
        <p class="muted">Excluded maps (only on one side): {row.excludedMaps.join(', ')}</p>
      )}
      {d.error && <Empty>Could not load the detail.</Empty>}
      {detail && (
        <>
          {g ? (
            <svg
              class="spark"
              viewBox={`0 0 ${W} ${H}`}
              preserveAspectRatio="none"
              role="img"
              aria-label={`${row.description} over time`}
            >
              {detail.boundaries.map((b) => (
                <line
                  key={b.patchId}
                  x1={g.x(time(b.at))}
                  x2={g.x(time(b.at))}
                  y1={0}
                  y2={H}
                  stroke="var(--border-strong)"
                  stroke-dasharray="4 4"
                >
                  <title>{b.label}</title>
                </line>
              ))}
              {pts.map((p, i) => (
                <circle
                  key={i}
                  cx={g.x(p.t)}
                  cy={g.y(p.v)}
                  r={3}
                  fill={p.side === 'a' ? 'var(--text-muted)' : 'var(--rating)'}
                />
              ))}
              <polyline points={pts.map((p, i) => `${g.x(p.t).toFixed(1)},${g.y(mean[i]).toFixed(1)}`).join(' ')} />
            </svg>
          ) : (
            <p class="muted">Not enough matches for a trend yet.</p>
          )}
          {detail.perMap.length > 0 && (
            <div class="balance-map" data-testid="balance-map">
              {detail.perMap.map((m) => (
                <div class="balance-map__row" key={m.map}>
                  <div>{m.map} <span class="muted">({m.roundsA} vs {m.roundsB} rounds)</span></div>
                  <div class="bar__track"><div class="bar__fill bar__fill--neutral" style={{ width: `${(m.a / maxBar) * 100}%` }} /></div>
                  <div class="bar__track"><div class="bar__fill bar__fill--good" style={{ width: `${(m.b / maxBar) * 100}%` }} /></div>
                  <div class="muted">A {fmtValue(row.metric, m.a)}, B {fmtValue(row.metric, m.b)}</div>
                </div>
              ))}
            </div>
          )}
          {detail.examples.length > 0 && (
            <ul class="admin-list">
              {detail.examples.map((e) => (
                <li key={`${e.matchId}-${e.ordinal}-${e.half}`}>
                  <a href={`/match/${e.matchId}?ordinal=${e.ordinal}&half=${e.half}`}>
                    Match #{e.matchId}, {e.map ?? 'unknown map'}, half {e.half}: {fmtValue(row.metric, e.value)}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
