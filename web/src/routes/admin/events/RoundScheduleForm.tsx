import { useState } from 'preact/hooks';
import type { RoundSchedule, Scheduling } from '../../../api';
import { weeklyRoundTimes, type WeeklySlot } from '../../../../../src/events/league';
import { fromLocalInput, toLocalInput } from '../../../eventFormat';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** Each field holds the canonical UTC ISO (or null for "not set"), never the
 *  local display string: a datetime-local input only shows minutes, and
 *  round-tripping a value through it would silently drop a week window's
 *  :59 seconds on every unedited round. The input's value is derived at
 *  render time (toLocalInput) and a keystroke is read back at once
 *  (fromLocalInput), so a row nobody touches keeps its exact source time. */
interface Row { round: number; at: string | null; from: string | null; to: string | null }
const rowOf = (r: RoundSchedule): Row => ({ round: r.round, at: r.at, from: r.from, to: r.to });
const blank = (round: number): Row => ({ round, at: null, from: null, to: null });

/** A stage's per-round schedule (plan T4 Rulings 2 and 3): one row per
 *  round with a default time and, on a window stage, the window. A league
 *  fills every round from a weekly pattern against its season start, then
 *  any row may be edited. Times are typed in the viewer's zone and sent as
 *  UTC; a rolling stage takes a date only. */
export function RoundScheduleForm({ scheduling, league, seasonStart, roundsKnown, initial, busy, onSave }: {
  scheduling: Scheduling; league: { matches: number; matchesPerWeek: number } | null; seasonStart: string | null; roundsKnown: number | null;
  initial: RoundSchedule[]; busy: boolean; onSave: (rows: RoundSchedule[]) => void;
}) {
  const count = Math.max(roundsKnown ?? 0, ...initial.map((r) => r.round), 1);
  const [rows, setRows] = useState<Row[]>(() => Array.from({ length: count }, (_, i) => { const r = initial.find((x) => x.round === i + 1); return r ? rowOf(r) : blank(i + 1); }));
  const [slots, setSlots] = useState<WeeklySlot[]>(() => Array.from({ length: league?.matchesPerWeek ?? 0 }, () => ({ day: 3, time: '' })));
  const set = (i: number, patch: Partial<Row>) => setRows((xs) => xs.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const fill = () => {
    if (!league || !seasonStart) return;
    const out = weeklyRoundTimes({ seasonStart, matches: league.matches, perWeek: league.matchesPerWeek, slots });
    setRows(out.map((r) => rowOf(r)));
  };
  const submit = (e: Event) => {
    e.preventDefault();
    const out: RoundSchedule[] = [];
    for (const r of rows) {
      const from = scheduling === 'window' ? r.from : null;
      const to = scheduling === 'window' ? r.to : null;
      if (r.at === null && from === null && to === null) continue;
      out.push({ round: r.round, at: r.at, from, to });
    }
    onSave(out);
  };
  return (
    <form class="eventform eventform--schedule" onSubmit={submit}>
      {league && (
        <div class="inlinerow">
          {slots.map((s, i) => (
            <span key={i} class="inlinerow">
              <label>{`Match ${i + 1} weekday`}
                <select aria-label={`Match ${i + 1} weekday`} value={String(s.day)} onChange={(e) => setSlots((xs) => xs.map((x, k) => (k === i ? { ...x, day: Number((e.target as HTMLSelectElement).value) } : x)))}>
                  {DAYS.map((d, k) => <option key={d} value={String(k)}>{d}</option>)}
                </select>
              </label>
              <label>{`Match ${i + 1} time (UTC)`}
                <input type="time" aria-label={`Match ${i + 1} time (UTC)`} value={s.time} onInput={(e) => setSlots((xs) => xs.map((x, k) => (k === i ? { ...x, time: (e.target as HTMLInputElement).value } : x)))} />
              </label>
            </span>
          ))}
          <button class="btn btn--ghost btn--sm" type="button" disabled={!seasonStart || slots.some((s) => s.time === '')} onClick={fill}>Fill from the pattern</button>
          {!seasonStart && <span class="muted">Set the season start on the stage to fill from a pattern.</span>}
        </div>
      )}
      <ol class="admin-list">
        {rows.map((r, i) => (
          <li key={r.round} class="inlinerow">
            <strong>{`Round ${r.round}`}</strong>
            <label>Default time <input type="datetime-local" aria-label={`Round ${r.round} default time`} value={r.at ? toLocalInput(r.at) : ''} onInput={(e) => set(i, { at: fromLocalInput((e.target as HTMLInputElement).value) })} /></label>
            {scheduling === 'window' && (
              <>
                <label>Window from <input type="datetime-local" aria-label={`Round ${r.round} window start`} value={r.from ? toLocalInput(r.from) : ''} onInput={(e) => set(i, { from: fromLocalInput((e.target as HTMLInputElement).value) })} /></label>
                <label>to <input type="datetime-local" aria-label={`Round ${r.round} window end`} value={r.to ? toLocalInput(r.to) : ''} onInput={(e) => set(i, { to: fromLocalInput((e.target as HTMLInputElement).value) })} /></label>
              </>
            )}
            <button class="btn btn--ghost btn--sm" type="button" aria-label={`Clear round ${r.round}`} onClick={() => set(i, { at: null, from: null, to: null })}>Clear</button>
          </li>
        ))}
      </ol>
      <div class="eventform__actions">
        <button class="btn btn--ghost btn--sm" type="button" onClick={() => setRows((xs) => [...xs, blank(xs.length + 1)])}>Add a round</button>
        <button class="btn" type="submit" disabled={busy}>Save schedule</button>
      </div>
    </form>
  );
}
