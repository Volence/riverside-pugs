import type { CompareQuery, CompareRow } from '../../../api';

/** Stub for Task 8: the expanded row under a clicked metric will hold the
 *  trend chart, per-map bars and example rounds (using row.metric and
 *  row.phase, already carried on `row`). Until then this keeps Compare's
 *  row-expand behaviour wired up and compiling. */
export function QuickCheck(_: { query: CompareQuery; row: CompareRow }) {
  return <div class="balance-check">Quick check</div>;
}
