import type { JSX } from 'preact';
import type { LiveEvent, StatDef } from '../api';
import { labelFor, liveGroupStarts } from '../format';
import { PlayerLink } from './bits';
import { markColumn, directionOf, type Mark } from '../outliers';

/** A player row for any stat table: live, per-map, or match totals. */
export interface StatRow {
  steamid: string;
  name: string;
  stats: Record<string, number>;
}

/** A map heading needs a name; a map still in progress has none yet. */
export interface FeedMap { ordinal: number; map: string }

/** Both teams in ONE table rather than two.
 *
 *  With this many numeric columns the table scrolls horizontally, and two
 *  separate scroll containers meant the teams slid out of alignment and could
 *  not be compared. One table means one scrollbar and one set of headers. The
 *  player column is sticky so it never scrolls out of view, which is what made
 *  the first version unreadable: a wall of numbers with no names attached. */
export function StatTable(
  { teamA, teamB, cols, statDefs, showTotals }: {
    teamA: StatRow[]; teamB: StatRow[]; cols: string[];
    /** When present, cells that stand out across all players are marked.
     *  Absent on the live page, which is a running scoreboard rather than a
     *  post-match comparison. */
    statDefs?: StatDef[];
    /** Adds a "Team total" row to the end of each team's group. Off by
     *  default so the live page's running scoreboard is unchanged. */
    showTotals?: boolean;
  },
) {
  const starts = liveGroupStarts(cols);
  const cls = (k: string) => `num${starts.has(k) ? ' is-groupstart' : ''}`;

  const all = [...teamA, ...teamB];
  // Marks are computed across every player in the match, not per team. The
  // question is "was I the weak link in this game", and over a full map both
  // teams play both sides, so all eight are comparable.
  const marks = new Map<string, (Mark | null)[]>();
  if (statDefs) {
    for (const k of cols) {
      marks.set(k, markColumn(all.map((r) => r.stats?.[k]), directionOf(k, statDefs)));
    }
  }

  /** Column totals for one team. A column nobody recorded stays absent rather
   *  than summing to a fabricated zero. */
  const totalsFor = (players: StatRow[]) => {
    const out: Record<string, number> = {};
    for (const k of cols) {
      const vals = players.map((p) => p.stats?.[k]).filter((v): v is number => v !== undefined);
      if (vals.length > 0) out[k] = vals.reduce((a, b) => a + b, 0);
    }
    return out;
  };

  const rows = (label: string, players: StatRow[], indexOffset: number) => {
    const totals = totalsFor(players);
    return [
      <tr class="live__teamrow" key={`h-${label}`}>
        <th class="live__pcol" scope="rowgroup">Team {label}</th>
        {cols.map((k) => <td class={cls(k)} key={k} />)}
      </tr>,
      ...players.map((p, i) => (
        <tr key={p.steamid}>
          <td class="live__pcol"><PlayerLink steamid={p.steamid} name={p.name} /></td>
          {cols.map((k) => {
            const v = p.stats?.[k];
            const dim = v === 0 || v === undefined ? ' is-dim' : '';
            const m = marks.get(k)?.[indexOffset + i] ?? null;
            const markCls = m ? ` is-${m}` : '';
            return <td class={cls(k) + dim + markCls} key={k}>{renderStat(k, v)}</td>;
          })}
        </tr>
      )),
      // The totals row is never marked: it is a sum, not a player competing
      // with the others.
      ...(showTotals
        ? [
          <tr key={`t-${label}`}>
            <td class="live__pcol">Team total</td>
            {cols.map((k) => {
              const v = totals[k];
              const dim = v === 0 || v === undefined ? ' is-dim' : '';
              return <td class={cls(k) + dim} key={k}>{renderStat(k, v)}</td>;
            })}
          </tr>,
        ]
        : []),
    ];
  };

  return (
    <div class="table-wrap live__stats">
      <table>
        <thead>
          <tr>
            <th class="live__pcol">Player</th>
            {cols.map((k) => <th class={cls(k)} key={k}>{labelFor(k)}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows('A', teamA, 0)}
          {rows('B', teamB, teamA.length)}
        </tbody>
      </table>
    </div>
  );
}

/** Discrete events, newest first.
 *
 *  Rendered as a sentence rather than a label plus operands, because the feed
 *  is read as a narrative: "volence pounced tino for 22" parses at a glance in
 *  a way that "DP volence on tino 22" does not.
 *
 *  An unknown kind still renders, falling back to its raw slug, because a
 *  silently dropped event is worse than an ugly one. */
export function EventFeed(
  { events, maps }: { events: LiveEvent[]; maps: FeedMap[] },
) {
  // Newest first, so a map heading is emitted whenever the ordinal changes as
  // we walk down. Grouping rather than a per-row badge: consecutive entries
  // are almost always from the same map, and repeating it on every line is
  // noise.
  const nameOfMap = (ordinal: number) =>
    maps.find((mp) => mp.ordinal === ordinal)?.map ?? null;

  const rows: JSX.Element[] = [];
  let lastOrdinal: number | null = null;
  for (const e of events) {
    if (e.mapOrdinal !== lastOrdinal) {
      lastOrdinal = e.mapOrdinal;
      const name = nameOfMap(e.mapOrdinal);
      rows.push(
        <li class="feed__map" key={`m-${e.mapOrdinal}-${e.seq}`}>
          Map {e.mapOrdinal + 1}
          {/* A map still in progress has no row yet, so no name to show. */}
          {name ? ` · ${name}` : ' · in progress'}
        </li>,
      );
    }
    const verb = KIND_VERBS[e.kind];
    rows.push(
      <li key={e.seq}>
        <span class="feed__line">
          <strong>{e.actor.name}</strong>
          {' '}
          <span class="muted">{verb?.verb ?? e.kind}</span>
          {e.target && <> <strong>{e.target.name}</strong></>}
          {e.value > 0 && (
            <>
              {' '}
              <span class="muted">{verb?.unit ?? 'for'}</span>
              {' '}
              <span class="feed__val num">{e.value}</span>
            </>
          )}
        </span>
      </li>,
    );
  }

  return (
    <div class="feed">
      <h4>Feed</h4>
      <ul>{rows}</ul>
    </div>
  );
}

/** How each event kind reads. `verb` sits between actor and target, `unit`
 *  between target and value. Adding a kind here is the only frontend change
 *  needed when the plugin starts emitting a new one. */
const KIND_VERBS: Record<string, { verb: string; unit?: string }> = {
  dp: { verb: 'pounced', unit: 'for' },
};

/** Absent must read as "not measured", never as a fabricated 0. hp carries -1
 *  from the plugin to mean "not applicable" (infected, or disconnected), which
 *  is a real value on the wire but nonsense to show as a number. */
function renderStat(key: string, value: number | undefined) {
  if (value === undefined) return <span class="muted">n/a</span>;
  if (key === 'hp' && value < 0) return <span class="muted">-</span>;
  if (key === 'boomer_rate') return `${value}%`;
  return value;
}

/**
 * How to play these back without crashing.
 *
 * Loading a demo straight from the main menu initialises CO-OP gamerules. A
 * versus demo carries infected players and versus entities that co-op has no
 * instance baseline for, so the client dereferences null and dies (verified
 * 2026-09-11: EXCEPTION_ACCESS_VIOLATION reading 0x0 at client.dll+0x2DA520,
 * identical every time). Loading any versus map first fixes it.
 *
 * Shown next to the download links because it looks exactly like a corrupt
 * demo, and the first instinct is to blame the recording rather than the
 * playback procedure. It cost us a couple of hours.
 */
export function DemoPlaybackHint() {
  return (
    <details class="demohint">
      <summary>Demos crash on playback? Read this</summary>
      <p>
        Load a versus map <strong>before</strong> playing the demo, or the game
        will crash. From the main menu the client loads co-op gamerules, which
        cannot represent a versus demo.
      </p>
      <pre>{`map <the demo's map> versus
playdemo <filename without .dem>`}</pre>
      <p class="muted">
        Put the .dem in <code>left 4 dead/left4dead/</code> and load the map it
        was recorded on. Downloads are named <code>pug&lt;match&gt;-&lt;map&gt;.dem</code>,
        so match 8 map 1 is <code>playdemo pug8-1</code>.
      </p>
      <p class="muted">
        No arms in first person is a known SourceTV limitation, not a broken
        demo: the viewmodel is client-side and was never recorded. Spectate in
        third person.
      </p>
    </details>
  );
}
