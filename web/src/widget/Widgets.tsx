import type { ComponentChildren, JSX } from 'preact';
import type { WidgetLastMatch, WidgetLive, WidgetPayload, WidgetRating, WidgetSession } from '../../../src/widgetTypes';
import { campaignName, mapName } from '../format';
import type { WidgetParams, WidgetSize, WidgetStyle } from './params';
import './widget.css';

/**
 * The stream widget presets: one kind (live, rating, session, last, queue)
 * drawn in one style (bar, card, corner, board) at one size. Shared by the
 * OBS page (main.tsx) and the profile preview, which passes `preview` to get
 * a stand-in game behind the panel.
 *
 * Every panel is a solid dark --surface panel with tabular numbers. The
 * streamer's team is listed first, in the season accent, under the
 * streamer's name; the leading total is marked separately (bold and a
 * triangle), so the accent never reads as "winning". Losses stay red.
 */

const WSIZE: Record<WidgetSize, string> = { s: '0.8', m: '1', l: '1.3' };

const num = (v: number) => v.toLocaleString('en-US');
/** "+38", "-12", "0". */
const signed = (v: number) => (v > 0 ? `+${num(v)}` : v < 0 ? `-${num(-v)}` : '0');
const cls = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ');
const plural = (v: number, one: string, many: string) => `${num(v)} ${v === 1 ? one : many}`;

export function Widget({ params, data, preview }: { params: WidgetParams; data: WidgetPayload; preview?: boolean }): JSX.Element | null {
  const body = panelFor(params, data);
  if (!body) return null;
  const root = (
    <div
      class={`w-root w-style-${params.style} w-kind-${params.kind}`}
      style={{ '--wsize': WSIZE[params.size] } as JSX.CSSProperties}
    >
      {body}
    </div>
  );
  return preview ? <div class="w-game">{root}</div> : root;
}

function panelFor(p: WidgetParams, d: WidgetPayload): JSX.Element | null {
  switch (p.kind) {
    case 'live':
      if (d.live) return <LivePanel style={p.style} live={d.live} name={d.player.name} />;
      return p.idle === 'note' ? <Note style={p.style} text="Not in a match" /> : null;
    case 'rating':
      return d.rating ? <RatingPanel style={p.style} r={d.rating} /> : null;
    case 'session':
      return d.session ? <SessionPanel style={p.style} s={d.session} name={d.player.name} /> : null;
    case 'last':
      return d.last ? <LastPanel style={p.style} m={d.last} /> : null;
    case 'queue':
      if (d.queue?.inQueue) {
        return <Panel style={p.style}><span class="w-line">Queueing on Riverside · <span class="w-num">{d.queue.count}/{d.queue.size}</span></span></Panel>;
      }
      return p.idle === 'note' ? <Note style={p.style} text="Not queueing" /> : null;
  }
}

function Panel({ style, extra, children }: { style: WidgetStyle; extra?: string; children: ComponentChildren }) {
  return <div class={cls('w-panel', `w-${style}`, extra)}>{children}</div>;
}

function Note({ style, text }: { style: WidgetStyle; text: string }) {
  return <Panel style={style} extra="w-note"><span>{text}</span></Panel>;
}

const FinalTag = () => <span class="w-tag">Final</span>;

/* ---------------------------------------------------------------- live */

type Side = 'mine' | 'theirs';

/** One map of the match as a column: finished, being played, or still to come. */
interface MapCol {
  ordinal: number;
  state: 'done' | 'now' | 'next';
  map: string | null;
  /** Cell text per side; null for a map still to come. */
  mine: string | null;
  theirs: string | null;
  winner: Side | 'tie' | null;
}

/** The maps to draw. Ordinals are 0-based (labels add one). With an unknown
 *  map count there are no columns past the played maps and the current one. */
function mapColumns(l: WidgetLive): MapCol[] {
  const cols: MapCol[] = [...l.maps].sort((a, b) => a.ordinal - b.ordinal).map((m) => ({
    ordinal: m.ordinal, state: 'done', map: m.map, mine: num(m.mine), theirs: num(m.theirs),
    winner: m.mine > m.theirs ? 'mine' : m.theirs > m.mine ? 'theirs' : 'tie',
  }));
  let next = l.mapsPlayed;
  const room = l.mapsTotal === null || l.mapsPlayed < l.mapsTotal;
  if (!l.final && room && (l.halfTime || l.currentMap)) {
    const ordinal = l.halfTime?.ordinal ?? l.mapsPlayed;
    const ht = l.halfTime;
    // The team that survived the first half has a score; the other is still playing.
    const survived: Side | null = ht ? (ht.mineSurvived ? 'mine' : 'theirs') : null;
    cols.push({
      ordinal, state: 'now', map: l.currentMap, winner: null,
      mine: survived === 'mine' ? num(ht!.score) : 'playing',
      theirs: survived === 'theirs' ? num(ht!.score) : 'playing',
    });
    next = ordinal + 1;
  }
  if (!l.final && l.mapsTotal !== null) {
    for (let o = next; o < l.mapsTotal; o++) cols.push({ ordinal: o, state: 'next', map: null, mine: null, theirs: null, winner: null });
  }
  return cols;
}

function leader(l: WidgetLive): Side | null {
  return l.mine.score > l.theirs.score ? 'mine' : l.theirs.score > l.mine.score ? 'theirs' : null;
}

/** "map 3 of 4", or "map 3" when the count is unknown. */
function whichMap(l: WidgetLive, short: boolean): string {
  const n = l.halfTime ? l.halfTime.ordinal + 1 : Math.min(l.mapsPlayed + 1, l.mapsTotal ?? Infinity);
  if (l.mapsTotal === null) return `map ${n}`;
  return short ? `${n}/${l.mapsTotal}` : `map ${n} of ${l.mapsTotal}`;
}

function Total({ score, leading }: { score: number; leading: boolean }) {
  return (
    <span class={cls('w-total', 'w-num', leading && 'is-leading')}>
      {leading && <span class="w-lead" aria-hidden="true">▲</span>}{num(score)}
    </span>
  );
}

function LivePanel({ style, live: l, name }: { style: WidgetStyle; live: WidgetLive; name: string }) {
  const lead = leader(l);
  const cols = mapColumns(l);
  const label = (s: Side) => (s === 'mine' ? name : 'Opponents');
  const score = (s: Side) => (s === 'mine' ? l.mine.score : l.theirs.score);
  const campaign = campaignName(l.campaign);
  const sides: Side[] = ['mine', 'theirs'];

  if (style === 'bar') {
    return (
      <Panel style="bar">
        <span class="w-team is-mine" data-team="mine"><span class="w-name">{name}</span><Total score={l.mine.score} leading={lead === 'mine'} /></span>
        <span class="w-dim">vs</span>
        <span class="w-team" data-team="theirs"><Total score={l.theirs.score} leading={lead === 'theirs'} /><span class="w-name">Opponents</span></span>
        <span class="w-sep" />
        <span class="w-chips">
          {cols.map((c) => (
            <span class={cls('w-chip', c.state === 'now' && 'is-now', c.state === 'next' && 'is-next', c.winner === 'mine' && 'is-mine')}>
              {`M${c.ordinal + 1}`}{c.state === 'now' ? ' live' : c.winner === 'tie' ? ' tie' : c.winner ? ` ${label(c.winner)}` : ''}
            </span>
          ))}
        </span>
        {l.final && <FinalTag />}
      </Panel>
    );
  }

  if (style === 'corner') {
    return (
      <Panel style="corner">
        {sides.map((s) => (
          <div class={cls('w-row', s === 'mine' && 'is-mine')} data-team={s}>
            <span class="w-name">{label(s)}</span><Total score={score(s)} leading={lead === s} />
          </div>
        ))}
        <div class="w-foot">
          <span class="w-dim">{l.final ? campaign : `${campaign} ${whichMap(l, true)}`}</span>{l.final && <FinalTag />}
        </div>
      </Panel>
    );
  }

  if (style === 'board') {
    return (
      <Panel style="board">
        {l.final && <div class="w-foot"><FinalTag /></div>}
        <table>
          <thead>
            <tr>
              <th>{campaign}</th>
              {cols.map((c) => <th class={cls(c.state === 'now' && 'is-now')}>{`M${c.ordinal + 1}`}</th>)}
              <th class="w-tot">Total</th>
            </tr>
          </thead>
          <tbody>
            {sides.map((s) => (
              <tr class={cls(s === 'mine' && 'is-mine')} data-team={s}>
                <td class="w-name">{label(s)}</td>
                {cols.map((c) => <Cell col={c} side={s} />)}
                <td class="w-tot"><Total score={score(s)} leading={lead === s} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    );
  }

  // card
  return (
    <Panel style="card">
      <div class="w-head">
        <span class="w-dim">{l.final ? campaign : `${campaign} · ${whichMap(l, false)}`}</span>{l.final && <FinalTag />}
      </div>
      {sides.map((s) => (
        <div class={cls('w-row', s === 'mine' && 'is-mine')} data-team={s}>
          <span class="w-name">{label(s)}</span><Total score={score(s)} leading={lead === s} />
        </div>
      ))}
      <div class="w-maps">
        {cols.filter((c) => c.state !== 'next').map((c) => [
          <span class="w-maplabel">
            <span class="w-dim">{`Map ${c.ordinal + 1}`}</span>
            {c.map && <span class="w-mapname">{mapName(c.map)}</span>}
          </span>,
          <Cell col={c} side="mine" tag="span" />,
          <Cell col={c} side="theirs" tag="span" />,
        ])}
      </div>
    </Panel>
  );
}

function Cell({ col, side, tag = 'td' }: { col: MapCol; side: Side; tag?: 'td' | 'span' }) {
  const text = col[side];
  const Tag = tag;
  if (text === null) return <Tag class="w-cell w-dim">–</Tag>;
  if (text === 'playing') return <Tag class="w-cell w-dim w-playing">playing</Tag>;
  return <Tag class={cls('w-cell', 'w-num', col.winner === side && 'is-won')}>{text}</Tag>;
}

/* -------------------------------------------------------------- rating */

function RatingPanel({ style, r }: { style: WidgetStyle; r: WidgetRating }) {
  const main = r.sr !== null
    ? <span class="w-big w-num">{num(r.sr)} <span class="w-unit">SR</span></span>
    : <span class="w-big">{r.placing ? `Placing ${r.placing.played}/${r.placing.of}` : 'Unranked'}</span>;
  const facts = [
    r.rank && <span class="w-rank">{r.rank}</span>,
    r.position !== null && <span class="w-num">#{num(r.position)}</span>,
    <span class="w-num">{`${r.wins}-${r.losses}`}</span>,
    r.todayDelta !== 0 && <span class={cls('w-num', r.todayDelta > 0 ? 'is-up' : 'is-down')}>{`${signed(r.todayDelta)} today`}</span>,
  ].filter(Boolean) as JSX.Element[];

  if (style === 'card') {
    return (
      <Panel style="card">
        <div class="w-head"><span class="w-dim">Rating</span></div>
        <div>{main}</div>
        <div class="w-facts">{dotted(facts)}</div>
      </Panel>
    );
  }
  return <Panel style={style}>{style === 'bar' ? [main, <span class="w-sep" />, ...dotted(facts)] : [<div>{main}</div>, <div class="w-facts">{dotted(facts)}</div>]}</Panel>;
}

/** Items with a " · " between them. */
function dotted(items: JSX.Element[]): (JSX.Element | string)[] {
  return items.flatMap((el, i) => (i === 0 ? [el] : [' · ', el])) as (JSX.Element | string)[];
}

/* ------------------------------------------------------------- session */

function SessionPanel({ style, s, name }: { style: WidgetStyle; s: WidgetSession; name: string }) {
  const line = (
    <span class="w-line">
      <span class={cls('w-num', 'w-strong', s.srDelta > 0 && 'is-up', s.srDelta < 0 && 'is-down')}>{`${signed(s.srDelta)} SR`}</span>
      {` · ${s.wins}-${s.losses} this stream`}
    </span>
  );
  if (style === 'card') {
    return (
      <Panel style="card">
        <div class="w-head"><span class="w-dim">{name}</span></div>
        <div class="w-session">{line}</div>
      </Panel>
    );
  }
  return <Panel style={style}>{line}</Panel>;
}

/* ---------------------------------------------------------- last match */

const RESULT_WORD = { win: 'Win', loss: 'Loss', draw: 'Draw' } as const;

function LastPanel({ style, m }: { style: WidgetStyle; m: WidgetLastMatch }) {
  const result = (
    <span class="w-line">
      <span class={`w-result is-${m.result}`}>{RESULT_WORD[m.result]}</span>
      {' '}<span class="w-num">{`${num(m.mine)}-${num(m.theirs)}`}</span>
      {m.srDelta !== null && <>{' '}<span class={cls('w-num', m.srDelta > 0 && 'is-up', m.srDelta < 0 && 'is-down')}>{`${signed(m.srDelta)} SR`}</span></>}
    </span>
  );
  const stats = (
    <span class="w-stats">
      {`${num(m.stats.siDamage)} SI damage · ${plural(m.stats.skeets, 'skeet', 'skeets')} · ${plural(m.stats.commons, 'common', 'commons')}`}
    </span>
  );
  if (style === 'bar') {
    return <Panel style="bar"><span class="w-dim">Last match</span>{result}<span class="w-sep" />{stats}</Panel>;
  }
  return (
    <Panel style={style}>
      {style === 'card' && <div class="w-head"><span class="w-dim">{`Last match · ${campaignName(m.campaign)}`}</span></div>}
      <div>{result}</div>
      <div class="w-facts">{stats}</div>
    </Panel>
  );
}
