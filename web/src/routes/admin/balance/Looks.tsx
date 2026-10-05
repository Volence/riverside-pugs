import { useState } from 'preact/hooks';
import { adminApi, type LookStatRow } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty } from '../../../components/bits';
import { campaignName } from '../../../format';

const WINDOWS = [7, 14, 30, 90, 365];

/** Whether a row is the campaign's stock look, the one the others are read against. */
export const isDefaultLook = (title: string): boolean => title.trim().toLowerCase() === 'default';

/** A look's mean survivor score against the campaign's Default, as a signed
 *  percentage; blank for the Default row itself or with nothing to compare to. */
export function deltaLabel(row: LookStatRow, base: LookStatRow | null): string {
  if (!base || row === base || isDefaultLook(row.title) || base.avgScore <= 0) return '';
  const pct = Math.round(((row.avgScore - base.avgScore) / base.avgScore) * 100);
  return pct === 0 ? '0%' : `${pct > 0 ? '+' : ''}${pct}%`;
}

/** Share of halves that ended with a survivor in the saferoom. */
export function finishLabel(rate: number | null): string {
  return rate === null ? 'n/a' : `${Math.round(rate * 100)}%`;
}

export function groupByCampaign(rows: LookStatRow[]): [string, LookStatRow[]][] {
  const out = new Map<string, LookStatRow[]>();
  for (const r of rows) {
    const list = out.get(r.campaign) ?? [];
    list.push(r);
    out.set(r.campaign, list);
  }
  // Default first in each campaign, then by how much was played under each look.
  for (const list of out.values()) {
    list.sort((a, b) => Number(isDefaultLook(b.title)) - Number(isDefaultLook(a.title)) || b.rounds - a.rounds || a.title.localeCompare(b.title));
  }
  return [...out.entries()].sort((a, b) => campaignName(a[0]).localeCompare(campaignName(b[0])));
}

/** Survival by look: how survivors fared under each time of day and weather
 *  night mode rolled, per campaign, against that campaign's Default. Asked
 *  for on 2026-10-04, the day the L4D1 rotation went live and the storm got
 *  argued about in chat. Read within a campaign only: maps differ too much
 *  across them for one look's number to mean anything fleet-wide. */
export function Looks() {
  const [days, setDays] = useState(30);
  const { data, error } = useFetch((s) => adminApi.looks(days, s), [days]);
  const picker = (
    <label>Window{' '}
      <select value={days} onChange={(e) => setDays(Number((e.target as HTMLSelectElement).value))}>
        {WINDOWS.map((d) => <option key={d} value={d}>{d} days</option>)}
      </select>
    </label>
  );
  if (error) return <Empty>Could not load survival by look.</Empty>;
  if (!data) return <p class="muted">Loading...</p>;
  const groups = groupByCampaign(data.rows);
  return (
    <div class="stack">
      <p class="balance-banner">
        Survivor results under each look night mode rolled, from completed matches since {data.since} UTC.
        A half's score is what the survivors scored in it; "reached saferoom" is the share of halves that
        ended with at least one survivor standing, over the halves where that was recorded. Compare a look
        with the same campaign's Default row: the maps differ too much between campaigns for anything else.
        Small samples swing; the match and half counts are on every row for that reason.
      </p>
      {picker}
      {groups.length === 0 && <Empty>No looks were logged for a completed match in this window.</Empty>}
      {groups.map(([slug, rows]) => {
        const base = rows.find((r) => isDefaultLook(r.title)) ?? null;
        return (
          <section key={slug} class="stack">
            <h3>{campaignName(slug)}</h3>
            <table class="admin-table">
              <thead>
                <tr><th>Look</th><th>Matches</th><th>Halves</th><th>Avg survivor score</th><th>vs Default</th><th>Reached saferoom</th><th>Avg alive at end</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.title}>
                    <td>{r.title}</td>
                    <td class="num">{r.matches}</td>
                    <td class="num">{r.rounds}</td>
                    <td class="num">{Math.round(r.avgScore)}</td>
                    <td class="num">{deltaLabel(r, base)}</td>
                    <td class="num">{finishLabel(r.finishRate)}</td>
                    <td class="num">{r.avgAlive === null ? 'n/a' : r.avgAlive.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
    </div>
  );
}
