import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { adminApi, type CompareQuery, type CompareRow, type PatchSummary, type Verdict } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty, Panel } from '../../../components/bits';
import { fmtChange, fmtMoreMatches, fmtValue, GROUP_LABEL, readCompareQuery, VERDICT_LABEL, writeCompareQuery } from './format';
import { QuickCheck } from './QuickCheck';

type CompareQueryWithView = CompareQuery & { view: 'ranked' | 'topic' };

const VERDICTS: Verdict[] = ['real', 'too_early', 'noise', 'no_data'];
const PHASE_FILTERS = ['any', 'all', 'tank', 'witch', 'event', 'normal'] as const;
const patchName = (p: PatchSummary) => p.name ?? `Unnamed patch ${p.number}`;
/** The picker shows the rounds the comparison would actually use, not every
 *  tagged round (the Patches tab keeps that raw total). */
const patchLabel = (p: PatchSummary) =>
  `${patchName(p)} (${p.countedRounds} rounds counted)${p.triage === 'pending' ? ' · needs triage' : ''}`;

/** Picks two groups of patches and shows every metric's verdict against them,
 *  Ranked or grouped By topic. The row-click expansion (QuickCheck) is a
 *  stub until Task 8 lands; this page only wires up the open/close state and
 *  passes it the query and row it needs.
 *
 *  Deviations from the brief, recorded for the report:
 *  - `key` for useFetch is built from the same fields as the brief's example,
 *    but `ready`/`same` are folded into the loader itself (returning
 *    Promise.resolve(null) when not ready) rather than only gating the deps,
 *    matching the brief's own sample exactly.
 *  - Phase filter state resets are NOT persisted to the URL (kept as brief
 *    specifies: local useState), so it does not survive a reload; only the
 *    controls the brief calls out as URL state (a, b, origin, phases, view)
 *    go through readCompareQuery/writeCompareQuery. */
export function Compare() {
  const { route } = useLocation();
  const patches = useFetch((s) => adminApi.balancePatches(s), []);
  // A folded patch is not offered at all: its rounds count for the patch it
  // was folded into. A pending one is offered, tagged, so a change can be
  // looked at before deciding, but is never a default side.
  const list = (patches.data?.patches ?? []).filter((p) => p.triage !== 'folded' && !p.merged);
  const oldestFirst = list.map((p) => p.id);
  const q = readCompareQuery(location.search, oldestFirst, list.filter((p) => p.countedRounds > 0 && p.triage !== 'pending').map((p) => p.id));
  const set = (next: Partial<CompareQueryWithView>) => route(`/admin/balance${writeCompareQuery({ ...q, ...next })}`, true);
  const ready = list.length > 0 && q.a.length > 0 && q.b.length > 0;
  const same = ready && q.a.length === q.b.length && q.a.every((id) => q.b.includes(id));
  const key = JSON.stringify([q.a, q.b, q.origin, q.maps, q.phases]);
  const cmp = useFetch((s) => (ready && !same ? adminApi.balanceCompare(q, s) : Promise.resolve(null)), [key, ready, same]);
  const [only, setOnly] = useState<Verdict | null>(null);
  const [phaseFilter, setPhaseFilter] = useState<(typeof PHASE_FILTERS)[number]>('any');
  const [open, setOpen] = useState<string | null>(null);

  // The Show select only exists while phases is split; a value picked there
  // (e.g. "Tank alive") must not keep hiding whole-round rows once Phases is
  // switched back to "Whole round only", or every row silently vanishes with
  // no control visible to explain why.
  useEffect(() => {
    if (q.phases !== 'split') setPhaseFilter('any');
  }, [q.phases]);

  if (patches.error) return <Empty>Could not load patches.</Empty>;
  if (!patches.data) return <p class="muted">Loading...</p>;

  const toggle = (sideKey: 'a' | 'b', id: number) => {
    const cur = q[sideKey];
    set({ [sideKey]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] } as Partial<CompareQueryWithView>);
  };
  const newestFirst = [...list].reverse();
  const byId = new Map(list.map((p) => [p.id, p]));
  const nameOf = (id: number) => { const p = byId.get(id); return p ? patchName(p) : `patch ${id}`; };
  const onBoth = same ? [] : q.a.filter((id) => q.b.includes(id));
  const result = cmp.data;
  const rows = (result?.rows ?? []).filter((r) => (only ? r.verdict === only : true)
    && (q.phases === 'split' && phaseFilter !== 'any' ? r.phase === phaseFilter : true));

  const table = (rs: CompareRow[]) => (
    <div class={`table-wrap balance-table${cmp.loading ? ' is-stale' : ''}`} aria-busy={cmp.loading}>
      <table class="admin-table">
        <thead><tr><th>Metric</th><th>Phase</th><th>A</th><th>B</th><th>Change</th><th>Verdict</th></tr></thead>
        <tbody>
          {rs.flatMap((r) => {
            const k = `${r.metric}|${r.phase}`;
            const ch = fmtChange(r.metric, r);
            const toggleOpen = () => setOpen(open === k ? null : k);
            const main = (
              <tr
                key={k}
                class="is-clickable"
                tabIndex={0}
                onClick={toggleOpen}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    if (e.key === ' ') e.preventDefault();
                    toggleOpen();
                  }
                }}
              >
                <td>{r.description}</td>
                <td>{r.phase === 'all' ? 'whole round' : r.phase}</td>
                <td>{fmtValue(r.metric, r.a)}</td>
                <td>{fmtValue(r.metric, r.b)}</td>
                <td>{ch.main} <span class="muted">{ch.range}</span></td>
                <td class={`verdict verdict--${r.verdict}`}>
                  {r.noSharedMaps ? 'no shared maps' : VERDICT_LABEL[r.verdict]}
                  {r.verdict === 'too_early' && r.moreMatches !== null && <span class="muted">, about {fmtMoreMatches(r.moreMatches)}</span>}
                </td>
              </tr>
            );
            return open === k
              ? [main, <tr key={`${k}-check`}><td colSpan={6}><QuickCheck query={q} row={r} /></td></tr>]
              : [main];
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <div class="stack">
      <Panel>
        <div class="balance-controls">
          {(['a', 'b'] as const).map((sk) => (
            <fieldset class="balance-side" key={sk}>
              <legend>Side {sk.toUpperCase()}</legend>
              {newestFirst.map((p) => (
                <label key={p.id}>
                  <input type="checkbox" checked={q[sk].includes(p.id)} onChange={() => toggle(sk, p.id)} /> {patchLabel(p)}
                </label>
              ))}
            </fieldset>
          ))}
          <label>Games
            <select value={q.origin} onChange={(e) => set({ origin: (e.target as HTMLSelectElement).value as CompareQueryWithView['origin'] })}>
              <option value="all">All rated</option><option value="queue">Queue only</option><option value="in_game">In-game only</option>
            </select>
          </label>
          <label>Phases
            <select value={q.phases} onChange={(e) => set({ phases: (e.target as HTMLSelectElement).value as CompareQueryWithView['phases'] })}>
              <option value="all">Whole round only</option><option value="split">Include phase splits</option>
            </select>
          </label>
          {q.phases === 'split' && (
            <label>Show
              <select value={phaseFilter} onChange={(e) => setPhaseFilter((e.target as HTMLSelectElement).value as (typeof PHASE_FILTERS)[number])}>
                <option value="any">Every phase</option><option value="all">Whole round</option><option value="tank">Tank alive</option>
                <option value="witch">Witch near</option><option value="event">Event</option><option value="normal">Normal play</option>
              </select>
            </label>
          )}
          <div class="admin-sections">
            <button type="button" class={`chip${q.view === 'ranked' ? ' is-on' : ''}`} onClick={() => set({ view: 'ranked' })}>Ranked</button>
            <button type="button" class={`chip${q.view === 'topic' ? ' is-on' : ''}`} onClick={() => set({ view: 'topic' })}>By topic</button>
          </div>
        </div>
      </Panel>

      {!ready && <p class="balance-banner">Pick at least one patch on each side.</p>}
      {same && <p class="balance-banner">Side A and side B are the same.</p>}
      {onBoth.map((id) => (
        <p class="balance-banner" key={`both-${id}`}>Patch {nameOf(id)} is on both sides; the sides are no longer independent.</p>
      ))}
      {!same && (['a', 'b'] as const).filter((sk) => q[sk].length > 1).map((sk) => (
        <p class="balance-banner" key={`pool-${sk}`}>
          Side {sk.toUpperCase()} pools {q[sk].length} patches ({q[sk].map(nameOf).join(', ')}). A change between them is averaged in
          and can show here as a real change; open a row and check the trend at the patch lines to see where it moved.
        </p>
      ))}
      {cmp.error && <Empty>Could not load the comparison.</Empty>}
      {result && (result.a.matches === 0 || result.b.matches === 0) && (
        (['a', 'b'] as const).filter((sk) => result[sk].matches === 0).map((sk) => (
          <p class="balance-banner" key={`empty-${sk}`}>
            Side {sk.toUpperCase()} has no finished matches yet (live, voided and unfinished matches are not counted).
          </p>
        ))
      )}
      {result && result.a.matches > 0 && result.b.matches > 0 && (
        <>
          {result.banners.skill && <p class="balance-banner">{result.banners.skill}</p>}
          {result.banners.approximate && <p class="balance-banner">Includes historical patches: their dates are approximate.</p>}
          <p class="muted">
            {(['a', 'b'] as const).map((sk) => {
              const s = result[sk];
              return <span key={sk}>{sk.toUpperCase()}: {s.matches} matches, {s.rounds} rounds{s.olderEngineRounds > 0 && ` (${s.olderEngineRounds} rounds use an older metric definition)`}. </span>;
            })}
          </p>
          <div class="admin-sections">
            {VERDICTS.map((v) => (
              <button key={v} type="button" class={`chip${only === v ? ' is-on' : ''}`} onClick={() => setOnly(only === v ? null : v)}>
                {result.counts[v]} {v === 'real' ? 'real changes' : VERDICT_LABEL[v]}
              </button>
            ))}
          </div>
          <Panel class="panel--table">
            {rows.length === 0 && result.rows.length > 0
              ? <p class="muted">No rows match these filters.</p>
              : q.view === 'ranked'
                ? table(rows)
                : Object.keys(GROUP_LABEL).map((g) => {
                  const rs = rows.filter((r) => r.group === g);
                  if (rs.length === 0) return null;
                  const c = VERDICTS.map((v) => [v, rs.filter((r) => r.verdict === v).length] as const).filter(([, n]) => n > 0)
                    .map(([v, n]) => `${n} ${v === 'real' ? 'real' : VERDICT_LABEL[v]}`).join(', ');
                  return <section key={g}><h3>{GROUP_LABEL[g]} ({c})</h3>{table(rs)}</section>;
                })}
          </Panel>
        </>
      )}
    </div>
  );
}
