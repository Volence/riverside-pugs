import { describe, it, expect } from 'vitest';
import { WIDGET_KINDS } from '../../../src/widgetTypes';
import { DEFAULT_STYLE, STYLES_FOR, SUGGESTED_PX, parseWidgetUrl, widgetUrl, type WidgetParams } from './params';

const ID = '76561198000000001';
const ORIGIN = 'https://pug.example';

function split(url: string) {
  const u = new URL(url);
  return { pathname: u.pathname, search: u.search };
}

describe('widget URL params', () => {
  it('round-trips widgetUrl and parseWidgetUrl for every kind, style, size and idle choice', () => {
    for (const kind of WIDGET_KINDS) {
      for (const style of STYLES_FOR[kind]) {
        for (const size of ['s', 'm', 'l'] as const) {
          for (const idle of ['hide', 'note'] as const) {
            const p: WidgetParams = { steamid: ID, kind, style, size, idle };
            const { pathname, search } = split(widgetUrl(ORIGIN, p));
            expect(parseWidgetUrl(pathname, search)).toEqual(p);
          }
        }
      }
    }
  });

  it('omits the defaults from the URL', () => {
    expect(widgetUrl(ORIGIN, { steamid: ID, kind: 'live', style: DEFAULT_STYLE.live, size: 'm', idle: 'hide' }))
      .toBe(`${ORIGIN}/widget/${ID}/live`);
    expect(widgetUrl(ORIGIN, { steamid: ID, kind: 'rating', style: 'bar', size: 'l', idle: 'hide' }))
      .toBe(`${ORIGIN}/widget/${ID}/rating?style=bar&size=l`);
  });

  it('fills in the defaults when the query is empty', () => {
    expect(parseWidgetUrl(`/widget/${ID}/queue`, '')).toEqual({ steamid: ID, kind: 'queue', style: 'corner', size: 'm', idle: 'hide' });
    expect(parseWidgetUrl(`/widget/${ID}/live/`, '')).toEqual({ steamid: ID, kind: 'live', style: 'bar', size: 'm', idle: 'hide' });
  });

  it('rejects a 16-digit id and an unknown kind', () => {
    expect(parseWidgetUrl('/widget/7656119800000000/live', '')).toBeNull();
    expect(parseWidgetUrl(`/widget/${ID}/kills`, '')).toBeNull();
    expect(parseWidgetUrl(`/widget/${ID}`, '')).toBeNull();
    expect(parseWidgetUrl(`/overlay/${ID}/live`, '')).toBeNull();
  });

  it('falls back to the default style when the style does not suit the kind', () => {
    expect(parseWidgetUrl(`/widget/${ID}/queue`, '?style=board')?.style).toBe(DEFAULT_STYLE.queue);
    expect(parseWidgetUrl(`/widget/${ID}/rating`, '?style=nonsense')?.style).toBe(DEFAULT_STYLE.rating);
  });

  it('falls back to size m and idle hide for garbage values', () => {
    const p = parseWidgetUrl(`/widget/${ID}/live`, '?size=xl&idle=maybe');
    expect(p?.size).toBe('m');
    expect(p?.idle).toBe('hide');
  });

  it('lists the styles each kind allows, with the default among them', () => {
    expect(STYLES_FOR.live).toEqual(['bar', 'card', 'corner', 'board']);
    for (const k of ['rating', 'session', 'last'] as const) expect(STYLES_FOR[k]).toEqual(['card', 'corner', 'bar']);
    expect(STYLES_FOR.queue).toEqual(['corner', 'bar']);
    for (const k of WIDGET_KINDS) expect(STYLES_FOR[k]).toContain(DEFAULT_STYLE[k]);
  });

  it('suggests bigger OBS sizes for bigger presets', () => {
    for (const style of ['bar', 'card', 'corner', 'board'] as const) {
      const { s, m, l } = SUGGESTED_PX[style];
      expect(s[0]).toBeLessThan(m[0]);
      expect(m[0]).toBeLessThan(l[0]);
      expect(s[1]).toBeLessThan(m[1]);
      expect(m[1]).toBeLessThan(l[1]);
    }
  });
});
