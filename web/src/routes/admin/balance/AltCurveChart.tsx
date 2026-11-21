import { useState } from 'preact/hooks';
import type { AltReportHalf } from '../../../api';

/** Health-run scoring's health curve for one map: team health % (y) against
 *  % of the map covered (x), one line per half in the team's colour (team A
 *  in the win chart's team A colour, team B in its team B colour), gaps where the half
 *  never reached a point, and a band for each half's tank fight. Plain inline
 *  SVG in the site's chart style (see WinChart); every point carries a title
 *  with its exact numbers. */

/** The x of curve point i: 0, 5, .., 100 (% of the map covered). */
export const CURVE_STEP = 5;

const W = 600;
const H = 230;
const PAD = { left: 40, right: 12, top: 12, bottom: 34 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;
const TICKS = [0, 25, 50, 75, 100];

const x = (covered: number) => PAD.left + (covered / 100) * PLOT_W;
const y = (health: number) => PAD.top + PLOT_H - (health / 100) * PLOT_H;

/** The runs of reached points (value >= 0) as [covered, health] pairs: a -1
 *  ends a run, so the line has a gap there instead of dropping to zero. */
export function curveSegments(curve: number[]): [number, number][][] {
  const runs: [number, number][][] = [];
  let run: [number, number][] = [];
  curve.forEach((v, i) => {
    if (v < 0) {
      if (run.length) runs.push(run);
      run = [];
      return;
    }
    run.push([i * CURVE_STEP, v]);
  });
  if (run.length) runs.push(run);
  return runs;
}

function teamLabel(h: AltReportHalf): string {
  return `Team ${h.survTeam.toUpperCase()} (half ${h.half})`;
}

/** What the tank band's title says, or null when the half had no tank fight
 *  (or none was recorded). */
export function tankText(h: AltReportHalf): string | null {
  const open = h.tankOpen ?? -1;
  const close = h.tankClose ?? -1;
  if (open < 0) return null;
  if (close < 0) return `${teamLabel(h)}: tank came at ${open}% of the map and was still up when the half ended`;
  return `${teamLabel(h)}: tank fight from ${open}% to ${close}% of the map`;
}

function HalfLine({ h }: { h: AltReportHalf }) {
  const team = h.survTeam;
  const label = teamLabel(h);
  const curve = h.curve ?? [];
  return (
    <g data-testid={`alt-curve-line-${team}-${h.half}`}>
      {curveSegments(curve).map((run, i) =>
        run.length > 1 ? (
          <polyline
            key={i}
            class={`altcurve__line altcurve__line--${team}`}
            points={run.map(([c, v]) => `${x(c).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}
          />
        ) : null,
      )}
      {curve.map((v, i) =>
        v < 0 ? null : (
          <circle key={i} class={`altcurve__dot altcurve__dot--${team}`} cx={x(i * CURVE_STEP)} cy={y(v)} r={3}>
            <title>{`${label}: ${i * CURVE_STEP}% of the map covered, team health ${v}%`}</title>
          </circle>
        ),
      )}
    </g>
  );
}

function TankMark({ h }: { h: AltReportHalf }) {
  const text = tankText(h);
  if (text === null) return null;
  const team = h.survTeam;
  const open = h.tankOpen ?? 0;
  const close = h.tankClose ?? -1;
  if (close < 0) {
    return (
      <line class={`altcurve__tankend altcurve__tankend--${team}`} data-testid={`alt-curve-tank-${team}-${h.half}`}
        x1={x(open)} x2={x(open)} y1={PAD.top} y2={PAD.top + PLOT_H}>
        <title>{text}</title>
      </line>
    );
  }
  // A fight that opened and closed at the same figure still shows as a thin band.
  const x0 = x(Math.min(open, close));
  const width = Math.max(3, x(Math.max(open, close)) - x0);
  return (
    <rect class={`altcurve__tank altcurve__tank--${team}`} data-testid={`alt-curve-tank-${team}-${h.half}`}
      x={x0} y={PAD.top} width={width} height={PLOT_H}>
      <title>{text}</title>
    </rect>
  );
}

/** One map's chart. `halves` are that map's halves (one or two). */
export function AltCurveChart({ map, halves }: { map: string; halves: AltReportHalf[] }) {
  const withCurve = halves.filter((h) => Array.isArray(h.curve) && h.curve.length > 0);
  if (withCurve.length === 0) {
    return <p class="muted" data-testid="alt-curve-none">No curve recorded for {map}.</p>;
  }
  const missing = halves.filter((h) => !withCurve.includes(h));
  const [hover, setHover] = useState<number | null>(null);
  const points = Math.max(...withCurve.map((h) => h.curve!.length));
  const onMove = (e: PointerEvent) => {
    const svg = (e.currentTarget as SVGElement).ownerSVGElement;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    if (r.width === 0) return;
    const covered = ((((e.clientX - r.left) / r.width) * W - PAD.left) / PLOT_W) * 100;
    setHover(Math.min(points - 1, Math.max(0, Math.round(covered / CURVE_STEP))));
  };
  const hx = hover === null ? 0 : x(hover * CURVE_STEP);
  return (
    <figure class="altcurve" data-testid="alt-curve">
      <figcaption class="altcurve__title">
        {map}: team health as the map goes on
        <span class="altcurve__legend">
          {halves.map((h) => (
            <span key={`${h.survTeam}-${h.half}`} class="altcurve__key">
              <span class={`altcurve__swatch altcurve__swatch--${h.survTeam}`} aria-hidden="true" />
              {teamLabel(h)}
              {missing.includes(h) && <span class="muted"> (no curve recorded)</span>}
            </span>
          ))}
        </span>
      </figcaption>
      <div class="altcurve__plot">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${map}: team health % against % of the map covered, per half`}>
        {withCurve.map((h) => <TankMark key={`t${h.survTeam}${h.half}`} h={h} />)}
        {TICKS.map((t) => (
          <g key={t}>
            <line class="altcurve__grid" x1={PAD.left} x2={PAD.left + PLOT_W} y1={y(t)} y2={y(t)} />
            <text class="altcurve__axis" x={PAD.left - 6} y={y(t) + 4} text-anchor="end">{t}%</text>
            <text class="altcurve__axis" x={x(t)} y={PAD.top + PLOT_H + 16} text-anchor="middle">{t}%</text>
          </g>
        ))}
        <text class="altcurve__axis" x={PAD.left + PLOT_W / 2} y={H - 2} text-anchor="middle">Map covered</text>
        {hover !== null && <line class="altcurve__cross" x1={hx} x2={hx} y1={PAD.top} y2={PAD.top + PLOT_H} />}
        {withCurve.map((h) => <HalfLine key={`l${h.survTeam}${h.half}`} h={h} />)}
        {hover !== null && withCurve.map((h) => {
          const v = h.curve![hover] ?? -1;
          return v < 0 ? null : (
            <circle key={`h${h.survTeam}${h.half}`} class={`altcurve__hot altcurve__dot--${h.survTeam}`} cx={hx} cy={y(v)} r={5} />
          );
        })}
        <rect class="altcurve__hit" data-testid="alt-curve-hit" x={PAD.left - 6} y={PAD.top} width={PLOT_W + 12} height={PLOT_H}
          onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {hover !== null && (
        <div class="altcurve__tip" data-testid="alt-curve-tip"
          style={{ left: `${Math.min(Math.max((hx / W) * 100, 18), 82)}%` }}>
          <div class="altcurve__tiphead">{hover * CURVE_STEP}% of the map covered</div>
          {withCurve.map((h) => {
            const v = h.curve![hover] ?? -1;
            const c = hover * CURVE_STEP;
            const open = h.tankOpen ?? -1;
            const close = h.tankClose ?? -1;
            const inTank = open >= 0 && (close < 0 ? c >= open : c >= Math.min(open, close) && c <= Math.max(open, close));
            return (
              <div key={`${h.survTeam}-${h.half}`} class="altcurve__tiprow">
                <span class={`altcurve__swatch altcurve__swatch--${h.survTeam}`} aria-hidden="true" />
                <span>{teamLabel(h)}</span>
                <span class="altcurve__tipval">{v < 0 ? 'not reached' : `${v}%`}{inTank ? ' (tank)' : ''}</span>
              </div>
            );
          })}
        </div>
      )}
      </div>
      <p class="muted altcurve__foot">
        Up: team health (the "Team health" figure !healthalt shows). Across: how much of the map the team had covered.
        Gaps are ground the half never reached; a band is where the tank fight was. Hover the chart for the numbers.
      </p>
    </figure>
  );
}
