import { useEffect, useRef, useState } from 'preact/hooks';
import type { Team, WinLine, WinPoint } from '../api';
import { mapName } from '../format';

/**
 * Win chance after every half of a finished match, from the scoreboard alone
 * (src/winProb.ts). One line, team A's chance: above the 50% rule is team A's
 * side and is tinted with the versus header's team A color, below is team
 * B's. Position carries the meaning and the tint only repeats it, so the two
 * team colors never have to be told apart on their own.
 */

const TEAM_NAME: Record<Team, string> = { a: 'Team A', b: 'Team B' };

/** A chance as the page says it. The ends of a finished match are exact; a
 *  chance along the way never claims certainty it does not have. */
export function fmtChance(p: number, exact = false): string {
  if (exact) return `${Math.round(p * 100)}%`;
  if (p < 0.01) return 'under 1%';
  if (p > 0.99) return 'over 99%';
  return `${Math.round(p * 100)}%`;
}

/** What a point was, in words: "Map 2 Offices, Team B survivors scored 640".
 *  `prev` is the point before it, which the half's own score is the step from. */
export function describePoint(pt: WinPoint, prev?: WinPoint): string {
  if (pt.ordinal === null || pt.survTeam === null) return 'Before the first half';
  const map = pt.map ? ` ${mapName(pt.map)}` : '';
  const total = pt.survTeam === 'a' ? pt.scoreA : pt.scoreB;
  const before = prev ? (pt.survTeam === 'a' ? prev.scoreA : prev.scoreB) : 0;
  return `Map ${pt.ordinal + 1}${map}, ${TEAM_NAME[pt.survTeam]} survivors scored ${total - before}`;
}

/** The one or two sentences above the chart. Pure, so it is tested without a DOM. */
export function winSummary(line: WinLine): string[] {
  const out: string[] = [];
  const pts = line.points;
  const last = pts[pts.length - 1];
  const chanceOf = (t: Team, p: number) => (t === 'a' ? p : 1 - p);
  if ((line.halvesLeft ?? 0) > 0) {
    const left = line.halvesLeft!;
    out.push(`Right now: Team A ${fmtChance(last.pA)}, Team B ${fmtChance(1 - last.pA)}, with ${left} survivor ${left === 1 ? 'half' : 'halves'} left to play.`);
    if (line.turning !== null) {
      const before = pts[line.turning - 1];
      const at = pts[line.turning];
      const toward: Team = at.pA > before.pA ? 'a' : 'b';
      out.push(`Biggest swing so far: ${describeShort(at)}, which took ${TEAM_NAME[toward]} from ${
        fmtChance(chanceOf(toward, before.pA))} to ${fmtChance(chanceOf(toward, at.pA))}.`);
    }
    return out;
  }
  const winner: Team | null = last.pA === 1 ? 'a' : last.pA === 0 ? 'b' : null;
  if (winner && line.winnerLow) {
    const low = line.winnerLow.p;
    if (low < 0.25) {
      out.push(`Comeback: ${TEAM_NAME[winner]} won from ${fmtChance(low)}, after ${
        line.winnerLow.index === 0 ? 'the start' : describeShort(pts[line.winnerLow.index])}.`);
    } else if (line.winnerLow.index === 0) {
      out.push(`${TEAM_NAME[winner]} were ahead on the odds from the first half to the last.`);
    } else {
      out.push(`${TEAM_NAME[winner]} won; their chance never fell below ${fmtChance(low)}.`);
    }
  } else if (!winner) {
    out.push('A draw.');
  }
  if (line.turning !== null) {
    const before = pts[line.turning - 1];
    const at = pts[line.turning];
    // Told from the side the swing went toward: "took Team B from 38% to 71%".
    const toward: Team = at.pA > before.pA ? 'a' : 'b';
    const exact = line.turning === pts.length - 1;
    out.push(`Biggest swing: ${describeShort(at)}, which took ${TEAM_NAME[toward]} from ${
      fmtChance(chanceOf(toward, before.pA))} to ${fmtChance(chanceOf(toward, at.pA), exact)}.`);
  }
  return out;
}

function describeShort(pt: WinPoint): string {
  if (pt.ordinal === null || pt.survTeam === null) return 'the start';
  const map = pt.map ? ` (${mapName(pt.map)})` : '';
  return `${TEAM_NAME[pt.survTeam]}'s survivor half on map ${pt.ordinal + 1}${map}`;
}

const H = 220;
const PAD = { top: 14, right: 12, bottom: 34, left: 64 };

export function WinChart({ line }: { line: WinLine }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pts = line.points;
  const n = pts.length;
  // A live line's last point is a chance, not a result.
  const finished = (line.halvesLeft ?? 0) === 0;
  const plotW = width - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  // A live line keeps room for the halves still to come, so the line grows
  // across the match instead of stretching to fill the width.
  const span = n - 1 + (line.halvesLeft ?? 0);
  const x = (i: number) => PAD.left + (span === 0 ? 0 : (i / span) * plotW);
  const y = (p: number) => PAD.top + (1 - p) * plotH;
  const mid = y(0.5);
  // A note sits on the far side of its dot from the 50% rule, where the line
  // never runs (both noted points are extremes of the stretch around them),
  // kept inside the plot so it never meets the map labels.
  const noteY = (p: number) => Math.min(PAD.top + plotH - 4, Math.max(PAD.top + 10, p >= 0.5 ? y(p) - 10 : y(p) + 18));

  const linePath = pts.map((pt, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(pt.pA).toFixed(1)}`).join('');
  const areaPath = `${linePath}L${x(n - 1).toFixed(1)},${mid}L${x(0).toFixed(1)},${mid}Z`;

  // One band per map: from the point before its first half to its second.
  const maps: { ordinal: number; map: string | null; x0: number; x1: number }[] = [];
  for (let i = 1; i + 1 < n; i += 2) {
    maps.push({ ordinal: pts[i].ordinal ?? maps.length, map: pts[i].map, x0: x(i - 1), x1: x(i + 1) });
  }
  const bandLabel = (m: typeof maps[number]) => {
    const name = m.map ? mapName(m.map) : '';
    // A name only where the band has room for it; the number always fits.
    return m.x1 - m.x0 > 90 && name ? `${m.ordinal + 1} · ${name}` : `Map ${m.ordinal + 1}`;
  };

  const turning = line.turning;
  const low = line.winnerLow && line.winnerLow.p < 0.25 && line.winnerLow.index > 0 ? line.winnerLow : null;
  const summary = winSummary(line);
  const hovered = hover === null ? null : pts[hover];

  return (
    <div class="winchart">
      {summary.map((s) => <p key={s} class="winchart__summary">{s}</p>)}
      <div class="winchart__plot" ref={wrap}>
        <svg width={width} height={H} role="img"
             aria-label={`Win chance after every half. ${summary.join(' ')}`}
             onMouseLeave={() => setHover(null)}>
          <defs>
            <clipPath id="winchart-above"><rect x="0" y="0" width={width} height={mid} /></clipPath>
            <clipPath id="winchart-below"><rect x="0" y={mid} width={width} height={H - mid} /></clipPath>
          </defs>
          {maps.map((m, k) => (
            <g key={k}>
              {k % 2 === 1 && <rect class="winchart__band" x={m.x0} y={PAD.top} width={m.x1 - m.x0} height={plotH} />}
              <text class="winchart__maplabel" x={(m.x0 + m.x1) / 2} y={H - PAD.bottom + 18} text-anchor="middle">
                {bandLabel(m)}
              </text>
            </g>
          ))}
          <line class="winchart__mid" x1={PAD.left} x2={width - PAD.right} y1={mid} y2={mid} />
          <line class="winchart__edge" x1={PAD.left} x2={width - PAD.right} y1={y(1)} y2={y(1)} />
          <line class="winchart__edge" x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} />
          <rect class="winchart__swatch winchart__swatch--a" x={6} y={y(1) - 4} width={8} height={8} />
          <text class="winchart__axis" x={18} y={y(1) + 4}>Team A</text>
          <text class="winchart__axis" x={18} y={mid + 4}>50%</text>
          <rect class="winchart__swatch winchart__swatch--b" x={6} y={y(0) - 4} width={8} height={8} />
          <text class="winchart__axis" x={18} y={y(0) + 4}>Team B</text>

          <path class="winchart__fill winchart__fill--a" d={areaPath} clip-path="url(#winchart-above)" />
          <path class="winchart__fill winchart__fill--b" d={areaPath} clip-path="url(#winchart-below)" />
          <path class="winchart__line" d={linePath} />

          {hover !== null && (
            <line class="winchart__cross" x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} />
          )}
          {pts.map((pt, i) => (
            <circle key={i} class={`winchart__dot${i === turning ? ' winchart__dot--turn' : ''}${hover === i ? ' is-hover' : ''}`}
                    cx={x(i)} cy={y(pt.pA)} r={i === turning ? 6 : 4} />
          ))}
          {turning !== null && (
            <text class="winchart__note" x={x(turning)} text-anchor={turning > n / 2 ? 'end' : 'start'}
                  dx={turning > n / 2 ? -10 : 10} y={noteY(pts[turning].pA)}>
              biggest swing
            </text>
          )}
          {low && low.index !== turning && (
            <text class="winchart__note" x={x(low.index)} text-anchor={low.index > n / 2 ? 'end' : 'start'}
                  dx={low.index > n / 2 ? -10 : 10} y={noteY(pts[low.index].pA)}>
              {pts[n - 1].pA >= 0.5 ? 'Team A' : 'Team B'} at {fmtChance(low.p)}
            </text>
          )}
          {!finished && (
            <text class="winchart__maplabel" x={(x(n - 1) + width - PAD.right) / 2} y={H - PAD.bottom + 18} text-anchor="middle">
              still to play
            </text>
          )}
          {/* Hit targets: a full-height column per point, wider than the dot. */}
          {pts.map((_, i) => {
            const half = span === 0 ? plotW / 2 : plotW / span / 2;
            return (
              <rect key={i} class="winchart__hit" x={x(i) - half} y={0} width={half * 2} height={H}
                    onMouseEnter={() => setHover(i)} onTouchStart={() => setHover(i)} />
            );
          })}
        </svg>
        {hovered && hover !== null && (
          <div class="winchart__tip" style={{
            left: `${Math.min(Math.max(x(hover), 110), width - 110)}px`,
            top: `${hovered.pA > 0.5 ? y(hovered.pA) + 14 : y(hovered.pA) - 70}px`,
          }}>
            <div class="winchart__tiphead">{describePoint(hovered, pts[hover - 1])}</div>
            <div>Score {hovered.scoreA} - {hovered.scoreB}</div>
            <div>
              Team A {fmtChance(hovered.pA, finished && hover === n - 1)}
              {' · '}Team B {fmtChance(1 - hovered.pA, finished && hover === n - 1)}
            </div>
          </div>
        )}
      </div>
      <details class="winchart__table">
        <summary>Every half as a table</summary>
        <div class="table-wrap">
          <table>
            <thead><tr><th>After</th><th>Score</th><th>Team A</th><th>Team B</th></tr></thead>
            <tbody>
              {pts.map((pt, i) => (
                <tr key={i}>
                  <td>{describePoint(pt, pts[i - 1])}</td>
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
        From the scoreboard alone: both teams start at 50%, and every half still to play is priced
        from the {line.halves.toLocaleString('en-US')} PUG halves played so far, map by map. Ratings
        play no part. Checked against past matches: halves it called 80-90% were won 83% of the time.
      </p>
    </div>
  );
}
