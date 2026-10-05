import { useState } from 'preact/hooks';
import type { GameValues, GameValueView } from '../../api';
import { Panel } from '../../components/bits';

type Group = GameValues['groups'][number];

const fmtDate = (at: string) => {
  const t = Date.parse(`${at.replace(' ', 'T')}Z`);
  return Number.isNaN(t) ? at : new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

function valueCell(v: GameValueView) {
  if (v.status === 'hidden') return <span class="muted">{v.note ?? 'set by a plugin'}</span>;
  // Not reported by the servers yet: a question mark, so it never reads as
  // "same as vanilla" or as differing from vanilla.
  if (v.status === 'not_reported') return <span class="muted" title="Not reported by the servers yet">?</span>;
  // Same as vanilla: the number still shows (people look it up), muted.
  if (isVanilla(v)) return <span class="muted" title="Same as vanilla">{withUnit(v.value!, v.unit)}</span>;
  return <>{withUnit(v.value!, v.unit)}{v.noEffect && <span class="values-tag" title="The game never reads this setting">no effect</span>}</>;
}

const withUnit = (value: string, unit: string | null) => <span class="values-num">{value}{unit && <span class="muted"> {unit}</span>}</span>;
const isVanilla = (v: GameValueView) => v.status === 'reported' && v.vanilla !== null && !v.differsFromVanilla && !v.noEffect;

function changeCell(v: GameValueView, admin: boolean) {
  if (!v.lastChange) return <span class="muted">unchanged since tracking began</span>;
  const date = fmtDate(v.lastChange.at);
  const p = v.lastChange.patch;
  if (!p) return date;
  return admin ? <>{p.name}, {date}</> : <><a href={`/balance#patch-${p.id}`}>{p.name}</a>, {date}</>;
}

/** Changed rows first, then our own settings (no vanilla), then the rest
 *  under a "Same as vanilla" divider. */
function ordered(values: GameValueView[]) {
  const changed = values.filter((v) => v.differsFromVanilla);
  const ours = values.filter((v) => !v.differsFromVanilla && v.vanilla === null);
  const rest = values.filter((v) => !v.differsFromVanilla && v.vanilla !== null);
  return { top: [...changed, ...ours], rest };
}

const matches = (q: string, ...texts: (string | null | undefined)[]) => texts.some((t) => t?.toLowerCase().includes(q));

function Row({ v, admin }: { v: GameValueView; admin: boolean }) {
  return (
    <tr class={v.differsFromVanilla ? 'values-differs' : ''}>
      <td class="values-table__setting" data-label="Setting">{v.label}{admin && v.conditionOff && <> <span class="admin-tag">hidden publicly: condition off</span></>}{v.note && v.status !== 'hidden' && <div class="muted values-note">{v.note}</div>}</td>
      <td data-label="Ours">{valueCell(v)}</td>
      <td data-label="Vanilla">{v.vanilla !== null ? withUnit(v.vanilla, v.unit) : <span class="muted">-</span>}</td>
      <td data-label="Last changed">{changeCell(v, admin)}</td>
    </tr>
  );
}

function Table({ values, admin }: { values: GameValueView[]; admin: boolean }) {
  const { top, rest } = ordered(values);
  return (
    <div class="table-wrap">
      <table class="admin-table values-table">
        <thead><tr><th>Setting</th><th>Ours</th><th>Vanilla versus</th><th>Last changed</th></tr></thead>
        <tbody>
          {top.map((v) => <Row key={v.id} v={v} admin={admin} />)}
          {top.length > 0 && rest.length > 0 && <tr class="values-divider"><td colSpan={4}>Same as vanilla</td></tr>}
          {rest.map((v) => <Row key={v.id} v={v} admin={admin} />)}
        </tbody>
      </table>
    </div>
  );
}

function GroupPanel({ g, admin, searching }: { g: Group; admin: boolean; searching: boolean }) {
  // While searching, a matching detail row shows in the main table.
  const main = searching ? g.values : g.values.filter((v) => !v.detail);
  const detail = searching ? [] : g.values.filter((v) => v.detail);
  return (
    <Panel class="panel--table values-panel" id={`values-${g.id}`}>
      <h2 class="values-group">{g.label}</h2>
      {main.length > 0 && <Table values={main} admin={admin} />}
      {g.rules.length > 0 && (<>
        <h3 class="values-rules-head">How it plays</h3>
        <ul class="values-rules">
          {g.rules.map((r) => (
            <li key={r.id} class={r.active ? '' : 'muted'}>
              {r.text}
              {admin && r.draft && <> <span class="admin-tag">draft rule</span></>}
              {admin && !r.active && <> <span class="admin-tag">not active</span></>}
              {admin && (r.missing?.length ?? 0) > 0 && <> <span class="admin-tag">waiting for {r.missing!.join(', ')}</span></>}
            </li>
          ))}
        </ul>
      </>)}
      {detail.length > 0 && (
        <details class="values-details">
          <summary>Fine tuning ({detail.length})</summary>
          <Table values={detail} admin={admin} />
        </details>
      )}
    </Panel>
  );
}

/** The Game values tables, one panel per group, with that group's rules.
 *  A search box filters every table, and a bar of group names jumps between
 *  them. Shared by the public page and the admin preview (which also shows
 *  draft and inactive rules, tagged). */
export function GameValuesView({ data, admin }: { data: GameValues; admin: boolean }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const groups = !q ? data.groups : data.groups.map((g) => {
    if (matches(q, g.label)) return g;
    return {
      ...g,
      values: g.values.filter((v) => matches(q, v.label, v.note, v.id)),
      rules: g.rules.filter((r) => matches(q, r.text)),
    };
  }).filter((g) => g.values.length > 0 || g.rules.length > 0);
  return (
    <div class="stack">
      {data.reviewing && (
        <p class="muted values-reviewing">
          {data.unsettled
            ? 'These values come from a server config that is still being reviewed.'
            : 'A newer server config is being reviewed. These are the values of the last settled one.'}
        </p>
      )}
      <div class="values-toolbar">
        <input type="search" class="values-search" placeholder="Search settings, e.g. pounce, vomit, tank" value={query}
          aria-label="Search game values" onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
        <nav class="values-jump" aria-label="Jump to a group">
          {groups.map((g) => <a key={g.id} class="chip" href={`#values-${g.id}`}>{g.label}</a>)}
        </nav>
      </div>
      {groups.length === 0 && <p class="muted">Nothing matches "{query.trim()}".</p>}
      {groups.map((g) => <GroupPanel key={g.id} g={g} admin={admin} searching={q !== ''} />)}
    </div>
  );
}
