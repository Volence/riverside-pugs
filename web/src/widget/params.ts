import { WIDGET_KINDS, type WidgetKind } from '../../../src/widgetTypes';

/**
 * A stream widget's URL: /widget/<steamid>/<kind>?style=&size=&idle=.
 * Presets only. The query carries what differs from the defaults, so the
 * link a player copies stays short; anything unknown falls back to a default
 * rather than breaking a browser source that is already on air.
 */

export type WidgetStyle = 'bar' | 'card' | 'corner' | 'board';
export type WidgetSize = 's' | 'm' | 'l';
export interface WidgetParams { steamid: string; kind: WidgetKind; style: WidgetStyle; size: WidgetSize; idle: 'hide' | 'note' }

const SIZES: readonly WidgetSize[] = ['s', 'm', 'l'];
const DEFAULT_SIZE: WidgetSize = 'm';
const DEFAULT_IDLE: WidgetParams['idle'] = 'hide';

/** The styles each kind can be drawn in. */
export const STYLES_FOR: Record<WidgetKind, WidgetStyle[]> = {
  live: ['bar', 'card', 'corner', 'board'],
  rating: ['card', 'corner', 'bar'],
  session: ['card', 'corner', 'bar'],
  last: ['card', 'corner', 'bar'],
  queue: ['corner', 'bar'],
};

export const DEFAULT_STYLE: Record<WidgetKind, WidgetStyle> = {
  live: 'bar', rating: 'card', session: 'card', last: 'card', queue: 'corner',
};

/** Browser source width x height to suggest in OBS. Medium is the base;
 *  small and large scale it by the --wsize factors (0.8, 1.3). */
const BASE_PX: Record<WidgetStyle, [number, number]> = {
  bar: [900, 64],
  card: [420, 260],
  corner: [320, 110],
  board: [760, 160],
};
const SCALE: Record<WidgetSize, number> = { s: 0.8, m: 1, l: 1.3 };
const scaled = (style: WidgetStyle) => Object.fromEntries(
  SIZES.map((sz) => [sz, BASE_PX[style].map((v) => Math.round(v * SCALE[sz])) as [number, number]]),
) as Record<WidgetSize, [number, number]>;
export const SUGGESTED_PX: Record<WidgetStyle, Record<WidgetSize, [number, number]>> = {
  bar: scaled('bar'), card: scaled('card'), corner: scaled('corner'), board: scaled('board'),
};

const PATH = /^\/widget\/(\d{17})\/([a-z]+)\/?$/;

export function parseWidgetUrl(pathname: string, search: string): WidgetParams | null {
  const m = PATH.exec(pathname);
  if (!m) return null;
  const [, steamid, k] = m;
  if (!(WIDGET_KINDS as readonly string[]).includes(k)) return null;
  const kind = k as WidgetKind;
  const q = new URLSearchParams(search);
  const style = q.get('style');
  const size = q.get('size');
  return {
    steamid,
    kind,
    style: (STYLES_FOR[kind] as string[]).includes(style ?? '') ? style as WidgetStyle : DEFAULT_STYLE[kind],
    size: (SIZES as string[]).includes(size ?? '') ? size as WidgetSize : DEFAULT_SIZE,
    idle: q.get('idle') === 'note' ? 'note' : DEFAULT_IDLE,
  };
}

/** The link for these settings; the inverse of parseWidgetUrl. */
export function widgetUrl(origin: string, p: WidgetParams): string {
  const q = new URLSearchParams();
  if (p.style !== DEFAULT_STYLE[p.kind]) q.set('style', p.style);
  if (p.size !== DEFAULT_SIZE) q.set('size', p.size);
  if (p.idle !== DEFAULT_IDLE) q.set('idle', p.idle);
  const s = q.toString();
  return `${origin}/widget/${p.steamid}/${p.kind}${s ? `?${s}` : ''}`;
}
