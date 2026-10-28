import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { Team, WinLine, WinPoint } from '../api';
import { fmtClock, mapName } from '../format';

/**
 * Win chance after every half of a match (src/winProb.ts), and with
 * win_chance_live every 5 s during each half too. One line, team A's chance:
 * above the 50% rule is team A's side and is tinted with the versus header's
 * team A color, below is team B's. Position carries the meaning and the tint
 * only repeats it, so the two team colors never have to be told apart on
 * their own. Straight segments between points, never a smoothed curve: a
 * cliff on the line is something that happened.
 */

const TEAM_NAME: Record<Team, string> = { a: 'Team A', b: 'Team B' };

type Moment = NonNullable<WinPoint['moment']>;

/** Each moment as a headline names it ("Tank on map 3"), as a point's
 *  description says it, and as the chart marks it. `rank` picks the glyph
 *  when marks crowd together: the one that says most about the fight. */
const MOMENT: Record<Moment, { headline: string; happened: string; glyph: string; rank: number }> = {
  wipe: { headline: 'Wipe', happened: 'wiped', glyph: '\u2715', rank: 4 },
  tank_spawn: { headline: 'Tank', happened: 'tank spawned', glyph: 'T', rank: 3 },
  tank_death: { headline: 'Tank killed', happened: 'tank killed', glyph: '\u2020', rank: 2 },
  saferoom: { headline: 'Saferoom', happened: 'reached the saferoom', glyph: '\u2302', rank: 1 },
};

/** How long a half is taken to be when the line has none finished to go by. */
const DEFAULT_HALF_MS = 6 * 60_000;

/**
 * Where each point sits along the x axis, in halves: every half gets the same
 * width (so maps line up with their labels however long a half ran), a
 * half-end point closes its half at a whole number, and a point during a half
 * sits by its time, as a share of the half's last point. A half still being
 * played is spread over what the finished halves took (their median, six
 * minutes before any), stretching only if it runs longer. `span` is the
 * whole axis: the halves played or being played and those still to come.
 */
export function chartSlots(line: WinLine): { at: number[]; span: number } {
  const pts = line.points;
  const at = pts.map(() => 0);
  const lengths: number[] = [];
  const place = (run: number[], slot: number, length: number) => {
    for (const i of run) at[i] = slot + (length > 0 ? Math.min(1, pts[i].tMs! / length) : 0);
  };
  let slot = 0;
  let run: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].tMs !== undefined) { run.push(i); continue; }
    if (run.length > 0) {
      const length = Math.max(...run.map((j) => pts[j].tMs!));
      lengths.push(length);
      place(run, slot, length);
      run = [];
    }
    at[i] = ++slot;
  }
  if (run.length > 0) {
    const sorted = [...lengths].sort((a, b) => a - b);
    const typical = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : DEFAULT_HALF_MS;
    place(run, slot, Math.max(typical, ...run.map((j) => pts[j].tMs!)));
  }
  return { at, span: slot + (line.halvesLeft ?? 0) };
}

/** The biggest swing's two ends, and the moment inside it, its start point
 *  included (a tank's point is where the fight it brings begins). With more
 *  than one, the likeliest cause by MOMENT rank (a wipe over the tank that
 *  brought it), the first on a tie. */
function swingOf(line: WinLine): { before: WinPoint; at: WinPoint; moment: WinPoint | null } | null {
  if (line.turning === null) return null;
  const pts = line.points;
  const from = line.turningFrom ?? line.turning - 1;
  let moment: WinPoint | null = null;
  for (const pt of pts.slice(from, line.turning + 1)) {
    if (pt.moment && (!moment || MOMENT[pt.moment].rank > MOMENT[moment.moment!].rank)) moment = pt;
  }
  return { before: pts[from], at: pts[line.turning], moment };
}

/** A chance as the page says it. The ends of a finished match are exact; a
 *  chance along the way never claims certainty it does not have. */
export function fmtChance(p: number, exact = false): string {
  if (exact) return `${wholePercent(p)}%`;
  if (p < 0.01) return 'under 1%';
  if (p > 0.99) return 'over 99%';
  return `${wholePercent(p)}%`;
}

/** A whole percent that rounds p and 1 - p the same way, so the two teams'
 *  numbers always add up to 100 (plain rounding gives 74% and 27% for 0.735). */
export function wholePercent(p: number): number {
  return p < 0.5 ? 100 - Math.round((1 - p) * 100) : Math.round(p * 100);
}

/** What a point was, in words: "Map 2 Offices, Team B survivors scored 640".
 *  `prev` is the point before it, which the half's own score is the step from. */
export function describePoint(pt: WinPoint, prev?: WinPoint, names: Record<Team, string> = TEAM_NAME): string {
  if (pt.ordinal === null || pt.survTeam === null) return 'Before the first half';
  const map = pt.map ? ` ${mapName(pt.map)}` : '';
  // A point during a half: "Map 3 The Crane, Team B survivors, 2:00 in: tank spawned".
  if (pt.tMs !== undefined) {
    return `Map ${pt.ordinal + 1}${map}, ${names[pt.survTeam]} survivors, ${fmtClock(pt.tMs / 1000)} in${
      pt.moment ? `: ${MOMENT[pt.moment].happened}` : ''}`;
  }
  const total = pt.survTeam === 'a' ? pt.scoreA : pt.scoreB;
  const before = prev ? (pt.survTeam === 'a' ? prev.scoreA : prev.scoreB) : 0;
  return `Map ${pt.ordinal + 1}${map}, ${names[pt.survTeam]} survivors scored ${total - before}`;
}

/** The one or two sentences above the chart. Pure, so it is tested without a DOM.
 *  `names` are what the two teams are called: Team A and Team B for a PUG,
 *  the teams' own names for a scrim or tournament game. */
export function winSummary(line: WinLine, names: Record<Team, string> = TEAM_NAME): string[] {
  const out: string[] = [];
  const pts = line.points;
  const last = pts[pts.length - 1];
  if ((line.halvesLeft ?? 0) > 0) {
    const left = line.halvesLeft!;
    out.push(`Right now: ${names.a} ${fmtChance(last.pA)}, ${names.b} ${fmtChance(1 - last.pA)}, with ${left} survivor ${left === 1 ? 'half' : 'halves'} left to play.`);
    const swing = swingOf(line);
    if (swing) out.push(swingSentence('Biggest swing so far', swing, false, names));
    return out;
  }
  const winner: Team | null = last.pA === 1 ? 'a' : last.pA === 0 ? 'b' : null;
  if (winner && line.winnerLow) {
    const low = line.winnerLow.p;
    if (low < 0.25) {
      const at = pts[line.winnerLow.index];
      // A low during a half is during it; a half-end low came after it.
      out.push(`Comeback: ${names[winner]} won from ${fmtChance(low)}, ${at.tMs !== undefined ? 'during' : 'after'} ${
        line.winnerLow.index === 0 ? 'the start' : describeShort(at, names)}.`);
    } else if (line.winnerLow.index === 0) {
      out.push(`${names[winner]} were ahead on the odds from the first half to the last.`);
    } else {
      out.push(`${names[winner]} won; their chance never fell below ${fmtChance(low)}.`);
    }
  } else if (!winner) {
    out.push('A draw.');
  }
  const swing = swingOf(line);
  if (swing) out.push(swingSentence('Biggest swing', swing, line.turning === pts.length - 1, names));
  return out;
}

/** The biggest swing as a sentence. With a moment inside it, the moment and
 *  the survivors' chance: "Tank on map 3: 68% to 31% for Team B". Otherwise
 *  the half, told from the side the swing went toward: "took Team B from 38%
 *  to 71%". `exact` when it ends on a finished match's last point. */
function swingSentence(
  lead: string, { before, at, moment }: NonNullable<ReturnType<typeof swingOf>>, exact: boolean, names: Record<Team, string>,
): string {
  const chanceOf = (t: Team, p: number) => (t === 'a' ? p : 1 - p);
  if (moment && moment.moment && moment.survTeam && moment.ordinal !== null) {
    const t = moment.survTeam;
    return `${lead}: ${MOMENT[moment.moment].headline} on map ${moment.ordinal + 1}: ${
      fmtChance(chanceOf(t, before.pA))} to ${fmtChance(chanceOf(t, at.pA), exact)} for ${names[t]}.`;
  }
  const toward: Team = at.pA > before.pA ? 'a' : 'b';
  return `${lead}: ${describeShort(at, names)}, which took ${names[toward]} from ${
    fmtChance(chanceOf(toward, before.pA))} to ${fmtChance(chanceOf(toward, at.pA), exact)}.`;
}

/** "Team B's", "Poop Packers'". */
function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

function describeShort(pt: WinPoint, names: Record<Team, string>): string {
  if (pt.ordinal === null || pt.survTeam === null) return 'the start';
  const map = pt.map ? ` (${mapName(pt.map)})` : '';
  return `${possessive(names[pt.survTeam])} survivor half on map ${pt.ordinal + 1}${map}`;
}

const H = 220;
const PAD = { top: 14, right: 12, bottom: 34, left: 64 };
/** The top margin when the line marks moments: their icons sit above the plot. */
const MOMENT_TOP = 32;
/** Moment icons (14 px across) closer than this share one, so none touch. */
const MARK_MERGE_PX = 18;

/** `names` call the teams by name (a scrim or tournament game); the axis
 *  uses `short`, which has to fit the 64 px left margin. Both default to Team
 *  A and Team B. */
export function WinChart({ line, names = TEAM_NAME, short = names }: { line: WinLine; names?: Record<Team, string>; short?: Record<Team, string> }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<number | null>(null);
  // Per chart: the Live page can hold several, and a shared id would point
  // one chart's fills at another's clip paths.
  const clip = `winchart-${useId()}`;

  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pts = line.points;
  const n = pts.length;
  // Points during halves (win_chance_live): the line flows through each half
  // and the half-end points become markers along it.
  const during = pts.some((pt) => pt.tMs !== undefined);
  const hasMoments = pts.some((pt) => pt.moment);
  const top = hasMoments ? MOMENT_TOP : PAD.top;
  // A live line's last point is a chance, not a result.
  const finished = (line.halvesLeft ?? 0) === 0;
  const plotW = width - PAD.left - PAD.right;
  const plotH = H - top - PAD.bottom;
  // A live line keeps room for the halves still to come, so the line grows
  // across the match instead of stretching to fill the width.
  const { at, span } = chartSlots(line);
  const xAt = (slot: number) => PAD.left + (span === 0 ? 0 : (slot / span) * plotW);
  const x = (i: number) => xAt(at[i]);
  const y = (p: number) => top + (1 - p) * plotH;
  const mid = y(0.5);
  // A note sits on the far side of its dot from the 50% rule, where the line
  // never runs (both noted points are extremes of the stretch around them),
  // kept inside the plot so it never meets the map labels.
  const noteY = (p: number) => Math.min(top + plotH - 4, Math.max(top + 10, p >= 0.5 ? y(p) - 10 : y(p) + 18));

  const pathOf = (from: number, to: number) => {
    let d = '';
    for (let i = from; i <= to; i++) d += `${i > from ? 'L' : 'M'}${x(i).toFixed(1)},${y(pts[i].pA).toFixed(1)}`;
    return d;
  };
  const linePath = pathOf(0, n - 1);
  const areaPath = `${linePath}L${x(n - 1).toFixed(1)},${mid}L${x(0).toFixed(1)},${mid}Z`;

  // One band per map, two halves wide: every map with a point so far. A live
  // line standing between halves ends on a lone half 1; its band still runs
  // to where half 2 will land.
  const maps: { ordinal: number; map: string | null; x0: number; x1: number }[] = [];
  for (const pt of pts) {
    if (pt.ordinal === null || maps.some((m) => m.ordinal === pt.ordinal)) continue;
    maps.push({ ordinal: pt.ordinal, map: pt.map, x0: xAt(pt.ordinal * 2), x1: xAt(pt.ordinal * 2 + 2) });
  }
  const bandLabel = (m: typeof maps[number]) => {
    const name = m.map ? mapName(m.map) : '';
    // A name only where the band has room for it; the number always fits.
    return m.x1 - m.x0 > 90 && name ? `${m.ordinal + 1} · ${name}` : `Map ${m.ordinal + 1}`;
  };

  // Moments as icons above the plot, each over its point with a thin guide
  // down to the line. Icons that would touch share one (the weightiest kind
  // shows; its title and tooltip list them all).
  const marks: { x: number; items: number[] }[] = [];
  pts.forEach((pt, i) => {
    if (!pt.moment) return;
    const prev = marks[marks.length - 1];
    if (prev && x(i) - prev.x < MARK_MERGE_PX) prev.items.push(i);
    else marks.push({ x: x(i), items: [i] });
  });
  const markKind = (items: number[]): Moment =>
    items.map((i) => pts[i].moment!).reduce((a, b) => (MOMENT[b].rank > MOMENT[a].rank ? b : a));
  const chanceLine = (pt: WinPoint) => `${names.a} ${fmtChance(pt.pA)}, ${names.b} ${fmtChance(1 - pt.pA)}`;

  const turning = line.turning;
  const swingFrom = turning === null ? null : line.turningFrom ?? turning - 1;
  const low = line.winnerLow && line.winnerLow.p < 0.25 && line.winnerLow.index > 0 ? line.winnerLow : null;
  const summary = winSummary(line, names);
  const hovered = hover === null ? null : pts[hover];
  // A point under a moment icon shows every moment that icon stands for.
  const hoverMark = hover === null ? null : marks.find((m) => m.items.includes(hover)) ?? null;
  const exactAt = (i: number) => finished && i === n - 1;
  // The table keeps one row per half: the points during halves are the line's.
  const rows = pts.map((pt, i) => ({ pt, i })).filter(({ pt }) => pt.tMs === undefined);

  /** The point nearest the pointer, read off the x axis. A half-end point
   *  shares its x with its half's last point and wins the tie, so the half's
   *  score and a finished match's final 100% stay reachable. */
  const pick = (clientX: number, el: SVGElement) => {
    const box = (el.ownerSVGElement ?? el).getBoundingClientRect();
    const px = clientX - box.left;
    let best = 0;
    for (let i = 1; i < n; i++) {
      const d = Math.abs(x(i) - px);
      const bd = Math.abs(x(best) - px);
      if (d < bd - 1e-6 || (d <= bd + 1e-6 && pts[i].tMs === undefined && pts[best].tMs !== undefined)) best = i;
    }
    setHover(best);
  };

  return (
    <div class="winchart">
      {summary.map((s) => <p key={s} class="winchart__summary">{s}</p>)}
      <div class="winchart__plot" ref={wrap}>
        <svg width={width} height={H} role="img"
             aria-label={`Win chance ${during ? 'through the match' : 'after every half'}. ${summary.join(' ')}`}
             onMouseLeave={() => setHover(null)}>
          <defs>
            <clipPath id={`${clip}-above`}><rect x="0" y="0" width={width} height={mid} /></clipPath>
            <clipPath id={`${clip}-below`}><rect x="0" y={mid} width={width} height={H - mid} /></clipPath>
          </defs>
          {maps.map((m, k) => (
            <g key={k}>
              {m.ordinal % 2 === 1 && <rect class="winchart__band" x={m.x0} y={top} width={m.x1 - m.x0} height={plotH} />}
              {/* Between a map's two halves, once the line runs through them. */}
              {during && <line class="winchart__halfsep" x1={(m.x0 + m.x1) / 2} x2={(m.x0 + m.x1) / 2} y1={top} y2={top + plotH} />}
              <text class="winchart__maplabel" x={(m.x0 + m.x1) / 2} y={H - PAD.bottom + 18} text-anchor="middle">
                {bandLabel(m)}
              </text>
            </g>
          ))}
          <line class="winchart__mid" x1={PAD.left} x2={width - PAD.right} y1={mid} y2={mid} />
          <line class="winchart__edge" x1={PAD.left} x2={width - PAD.right} y1={y(1)} y2={y(1)} />
          <line class="winchart__edge" x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} />
          <rect class="winchart__swatch winchart__swatch--a" x={6} y={y(1) - 4} width={8} height={8} />
          <text class="winchart__axis" x={18} y={y(1) + 4}>{short.a}</text>
          <text class="winchart__axis" x={18} y={mid + 4}>50%</text>
          <rect class="winchart__swatch winchart__swatch--b" x={6} y={y(0) - 4} width={8} height={8} />
          <text class="winchart__axis" x={18} y={y(0) + 4}>{short.b}</text>

          <path class="winchart__fill winchart__fill--a" d={areaPath} clip-path={`url(#${clip}-above)`} />
          <path class="winchart__fill winchart__fill--b" d={areaPath} clip-path={`url(#${clip}-below)`} />
          <path class="winchart__line" d={linePath} />
          {/* The swing's stretch of line, when it spans points during a half. */}
          {during && turning !== null && swingFrom !== null && (
            <path class="winchart__swing" d={pathOf(swingFrom, turning)} />
          )}

          {hover !== null && (
            <line class="winchart__cross" x1={x(hover)} x2={x(hover)} y1={top} y2={top + plotH} />
          )}
          {pts.map((pt, i) => {
            // Dots mark the half ends; a point during a half shows one only
            // when it is the swing, the low or under the pointer.
            const marked = i === turning || i === low?.index;
            if (pt.tMs !== undefined && !marked && hover !== i) return null;
            return (
              <circle key={i} class={`winchart__dot${i === turning ? ' winchart__dot--turn' : ''}${hover === i ? ' is-hover' : ''}`}
                      cx={x(i)} cy={y(pt.pA)} r={i === turning ? 6 : pt.tMs !== undefined && !marked ? 3 : 4} />
            );
          })}
          {turning !== null && (
            <text class="winchart__note" x={x(turning)} text-anchor={x(turning) > width / 2 ? 'end' : 'start'}
                  dx={x(turning) > width / 2 ? -10 : 10} y={noteY(pts[turning].pA)}>
              biggest swing
            </text>
          )}
          {low && low.index !== turning && (
            <text class="winchart__note" x={x(low.index)} text-anchor={x(low.index) > width / 2 ? 'end' : 'start'}
                  dx={x(low.index) > width / 2 ? -10 : 10} y={noteY(pts[low.index].pA)}>
              {pts[n - 1].pA >= 0.5 ? names.a : names.b} at {fmtChance(low.p)}
            </text>
          )}
          {!finished && (() => {
            // From the end of the last band the line has reached.
            const from = Math.max(x(n - 1), ...maps.map((m) => m.x1));
            return from < width - PAD.right - 40 && (
              <text class="winchart__maplabel" x={(from + width - PAD.right) / 2} y={H - PAD.bottom + 18} text-anchor="middle">
                still to play
              </text>
            );
          })()}
          {/* One hit target over the plot: the pointer picks the nearest point. */}
          <rect class="winchart__hit" x={PAD.left} y={0} width={plotW} height={H}
                onMouseMove={(e) => pick(e.clientX, e.currentTarget)}
                onTouchStart={(e) => e.touches[0] && pick(e.touches[0].clientX, e.currentTarget)}
                onTouchMove={(e) => e.touches[0] && pick(e.touches[0].clientX, e.currentTarget)} />
          {/* Above the hit target, so each icon's title shows on hover. */}
          {marks.map((m) => {
            const kind = markKind(m.items);
            const last = pts[m.items[m.items.length - 1]];
            const cy = top - 14;
            return (
              // Tapped, clicked or chosen from the keyboard, an icon shows its
              // moments in the tooltip (a title alone needs a mouse).
              <g key={m.items[0]} class={`winchart__moment winchart__moment--${kind}`} tabindex={0}
                 role="button" aria-label={m.items.map((i) => describePoint(pts[i], pts[i - 1], names)).join('; ')}
                 onClick={() => setHover(m.items[0])}
                 onKeyDown={(e) => {
                   if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setHover(m.items[0]); }
                 }}>
                <title>{m.items.map((i) => `${describePoint(pts[i], pts[i - 1], names)}. ${chanceLine(pts[i])}`).join('\n')}</title>
                <line class="winchart__momentguide" x1={m.x} x2={m.x} y1={cy + 7} y2={y(last.pA)} />
                <circle cx={m.x} cy={cy} r={7} />
                <text x={m.x} y={cy + 4} text-anchor="middle">{MOMENT[kind].glyph}</text>
              </g>
            );
          })}

        </svg>
        {hovered && hover !== null && (
          <div class="winchart__tip" style={{
            left: `${Math.min(Math.max(x(hover), 110), width - 110)}px`,
            top: `${hovered.pA > 0.5 ? y(hovered.pA) + 14 : y(hovered.pA) - 70}px`,
          }}>
            {hoverMark && hoverMark.items.length > 1 ? (
              <>
                {hoverMark.items.map((i) => (
                  <div key={i}>
                    <div class="winchart__tiphead">{describePoint(pts[i], pts[i - 1], names)}</div>
                    <div>{names.a} {fmtChance(pts[i].pA)}{' · '}{names.b} {fmtChance(1 - pts[i].pA)}</div>
                  </div>
                ))}
                <div>Score at the start of the half {hovered.scoreA} - {hovered.scoreB}</div>
              </>
            ) : (
              <>
                <div class="winchart__tiphead">{describePoint(hovered, pts[hover - 1], names)}</div>
                <div>{hovered.tMs !== undefined ? 'Score at the start of the half' : 'Score'} {hovered.scoreA} - {hovered.scoreB}</div>
                <div>
                  {names.a} {fmtChance(hovered.pA, exactAt(hover))}
                  {' · '}{names.b} {fmtChance(1 - hovered.pA, exactAt(hover))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
      <details class="winchart__table">
        <summary>Every half as a table</summary>
        <div class="table-wrap">
          <table>
            <thead><tr><th>After</th><th>Score</th><th>{names.a}</th><th>{names.b}</th></tr></thead>
            <tbody>
              {rows.map(({ pt, i }) => (
                <tr key={i}>
                  <td>{describePoint(pt, pts[i - 1], names)}</td>
                  <td class="num">{pt.scoreA} - {pt.scoreB}</td>
                  <td class="num">{fmtChance(pt.pA, finished && i === n - 1)}</td>
                  <td class="num">{fmtChance(1 - pt.pA, finished && i === n - 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <p class="muted winchart__foot">
        {during ? 'After each half the line comes from the scoreboard alone: ' : 'From the scoreboard alone: '}
        both teams start at 50%, and every half still to play is priced
        from the {line.halves.toLocaleString('en-US')} PUG halves played so far, map by map. Ratings
        play no part. Checked against past matches: halves it called 80-90% were won 83% of the time.
        {during && ' During each half it also moves every 5 seconds with how far the survivors have got, time into the half, deaths, downs, health lost and how much of the tank has been beaten; the icons mark tank spawns, tank kills, wipes and saferooms.'}
      </p>
    </div>
  );
}
