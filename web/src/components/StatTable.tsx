import { useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { EndorseKind, LiveEvent, StatDef } from '../api';
import { deriveLiveStats, labelFor, liveGroupStarts } from '../format';
import { PlayerLink } from './bits';
import { TitleTag } from './TitleTag';
import { markColumn, directionOf, type Mark } from '../outliers';
import { EVENT_KINDS, valueText } from '../replay/eventText';
import { enrichEvents, enrichmentText, fromLiveEvents } from '../eventEnrich';

/** A player row for any stat table: live, per-map, or match totals. */
export interface StatRow {
  steamid: string;
  name: string;
  /** Their linked Discord display name, only when it reads differently from
   *  `name`. Absent on the live scoreboard's derived rows, which is the same
   *  as null to PlayerLink. */
  discordName?: string | null;
  stats: Record<string, number>;
  /** False when nothing was ever recorded for this player (rostered too late
   *  for the dump, match 18). Their bag is then fixed-column zeros, which
   *  would read as the worst numbers in the match; the row renders dashes
   *  instead and takes no part in marks or totals. Absent means captured. */
  captured?: boolean;
  /** The endorsement title they have earned, if any. The match page passes
   *  it; the live scoreboard does not. */
  title?: EndorseKind | null;
}

/** What an uncaptured cell reads. An en dash, not a zero and not "n/a":
 *  n/a means "this stat was not measured for anyone". */
const UNCAPTURED = '–';
const UNCAPTURED_TITLE = 'stats were not captured for this player';

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
  { teamA, teamB, cols, statDefs, showTotals, groupStarts }: {
    teamA: StatRow[]; teamB: StatRow[]; cols: string[];
    /** When present, cells that stand out across all players are marked.
     *  Absent on the live page, which is a running scoreboard rather than a
     *  post-match comparison. */
    statDefs?: StatDef[];
    /** Adds a "Team total" row to the end of each team's group. Off by
     *  default so the live page's running scoreboard is unchanged. */
    showTotals?: boolean;
    /** Which columns begin a group, so the table can rule a line before them.
     *  Defaults to the live card's own grouping. The match page passes
     *  statGroupStarts instead, because it splits columns into finer families
     *  than the live scoreboard does. */
    groupStarts?: (cols: string[]) => Set<string>;
  },
) {
  const starts = (groupStarts ?? liveGroupStarts)(cols);
  const cls = (k: string) => `num${starts.has(k) ? ' is-groupstart' : ''}`;

  const all = [...teamA, ...teamB];
  // Marks are computed across every player in the match, not per team. The
  // question is "was I the weak link in this game", and over a full map both
  // teams play both sides, so all eight are comparable.
  const marks = new Map<string, (Mark | null)[]>();
  if (statDefs) {
    for (const k of cols) {
      // An uncaptured row contributes "absent" to every column, so its zeros
      // can never be the column's low end.
      marks.set(k, markColumn(all.map((r) => (r.captured === false ? undefined : r.stats?.[k])), directionOf(k, statDefs)));
    }
  }

  /** Column totals for one team. A column nobody recorded stays absent rather
   *  than summing to a fabricated zero, and an uncaptured player adds nothing. */
  const totalsFor = (players: StatRow[]) => {
    const out: Record<string, number> = {};
    const counted = players.filter((p) => p.captured !== false);
    for (const k of cols) {
      const vals = counted.map((p) => p.stats?.[k]).filter((v): v is number => v !== undefined);
      if (vals.length > 0) out[k] = vals.reduce((a, b) => a + b, 0);
    }
    // A rate cannot be summed: four 100% boomers are a 100% team, not 400%.
    // Re-derive it from the team's summed inputs, which are summed here even
    // when their own columns are not shown.
    if ('boomer_rate' in out) {
      const sum = (key: string) => counted.reduce((a, p) => a + (p.stats?.[key] ?? 0), 0);
      const rate = deriveLiveStats({ boomer_spawns: sum('boomer_spawns'), boom_successes: sum('boom_successes') }).boomer_rate;
      if (rate === undefined) delete out.boomer_rate;
      else out.boomer_rate = rate;
    }
    return out;
  };

  const rows = (label: string, players: StatRow[], indexOffset: number) => {
    // Only computed when the row is actually rendered below: this is a full
    // players-by-columns scan, and the live page polls this component with
    // showTotals unset, so it must not pay for a result it then discards.
    const totals = showTotals ? totalsFor(players) : null;
    return [
      <tr class="live__teamrow" key={`h-${label}`}>
        <th class="live__pcol" scope="rowgroup">Team {label}</th>
        {cols.map((k) => <td class={cls(k)} key={k} />)}
      </tr>,
      ...players.map((p, i) => (
        <tr key={p.steamid} title={p.captured === false ? UNCAPTURED_TITLE : undefined}>
          <td class="live__pcol pname"><PlayerLink steamid={p.steamid} name={p.name} discordName={p.discordName} /><TitleTag kind={p.title} /></td>
          {cols.map((k) => {
            if (p.captured === false) {
              return <td class={`${cls(k)} is-dim`} key={k}>{UNCAPTURED}</td>;
            }
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
      ...(totals
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
/** How much of the feed shows before "Show all". The live page never has
 *  more than its 40-newest window; a finished match carries the whole night,
 *  about a thousand lines, and the page should not be that tall by default. */
export const FEED_INITIAL = 60;

export function EventFeed(
  { events: all, maps }: { events: LiveEvent[]; maps: FeedMap[] },
) {
  const [expanded, setExpanded] = useState(false);
  const events = expanded ? all : all.slice(0, FEED_INITIAL);
  const hidden = all.length - events.length;
  // Newest first, so a map heading is emitted whenever the ordinal changes as
  // we walk down. Grouping rather than a per-row badge: consecutive entries
  // are almost always from the same map, and repeating it on every line is
  // noise.
  const nameOfMap = (ordinal: number) =>
    maps.find((mp) => mp.ordinal === ordinal)?.map ?? null;

  // Class, who-from and pin outcomes, read off the stream itself. Computed
  // over ALL events, not the folded window, because a pin that ended after
  // the fold still ended.
  const enriched = enrichEvents(fromLiveEvents(all));
  const nameOf = (id: string) => all.find((x) => x.actor.steamid === id)?.actor.name
    ?? all.find((x) => x.target?.steamid === id)?.target?.name ?? 'unknown';

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
    const verb = EVENT_KINDS[e.kind];
    rows.push(
      <li key={e.seq}>
        <span class="feed__line">
          <strong>{e.actor.name}</strong>
          {' '}
          <span class="muted">{verb?.verb ?? e.kind}{verb?.link && e.target ? ` ${verb.link}` : ''}</span>
          {e.target && <> <strong>{e.target.name}</strong></>}
          {(() => {
            // The same reading the rail gives: a spawn's value is a class
            // code and reads as its name, everything else is a quantity
            // with its unit. This used to print "spawned as for 3".
            const v = valueText(e.kind, e.value);
            if (!v) return null;
            if (e.kind === 'si_spawn') return <> <span class="feed__val">{v}</span></>;
            // A quantity: its own unit when the kind has one, else "for".
            const unit = verb?.unit ?? 'for';
            const num = v.startsWith(`${unit} `) ? v.slice(unit.length + 1) : v;
            return <> <span class="muted">{unit}</span> <span class="feed__val num">{num}</span></>;
          })()}
          {(() => {
            const extra = enrichmentText(e.kind, enriched.get(e.seq), nameOf, e.target?.name ?? null);
            return extra ? <> <span class="muted feed__detail">{extra}</span></> : null;
          })()}
        </span>
      </li>,
    );
  }

  return (
    <div class="feed">
      <h4>Feed</h4>
      <ul>{rows}</ul>
      {hidden > 0 && (
        <button class="chip feed__more" onClick={() => setExpanded(true)}>
          Show all {all.length} events
        </button>
      )}
    </div>
  );
}

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
