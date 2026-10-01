import { describe, it, expect } from 'vitest';
import { campaignsLabel, estimateLine, estimateSlot, mergedPlaylist, playMinutes, slotLabel, slotSummary, nightRangeLabel, toUtcIso } from './bookingTime';

describe('booking time helpers', () => {
  it('reads a datetime-local value in the viewer zone', () => {
    const iso = toUtcIso('2026-10-02T20:00');
    expect(iso).toBe(new Date(2026, 9, 2, 20, 0).toISOString());
    expect(toUtcIso('')).toBeNull();
    expect(toUtcIso('nonsense')).toBeNull();
  });

  const EST = { perCampaign: { no_mercy: 70, death_toll: 45 }, base: 15, slack: 10, step: 30, min: 60 };

  it('estimates the slot the way the server does: 15, each campaign plus 10, up to the step, raised to the minimum', () => {
    expect(estimateSlot(EST, [])).toBe(60);
    expect(estimateSlot(EST, ['no_mercy'])).toBe(120);
    expect(estimateSlot(EST, ['no_mercy', 'death_toll'])).toBe(150);
    // A campaign the options do not list counts as 60, the server's default.
    expect(estimateSlot(EST, ['no_mercy', 'unknown'])).toBe(180);
  });

  it('labels slots and counts', () => {
    expect(slotLabel(150)).toBe('2 h 30');
    expect(slotLabel(120)).toBe('2 h');
    expect(slotLabel(30)).toBe('30 min');
    expect(campaignsLabel(1)).toBe('1 campaign');
    expect(campaignsLabel(2)).toBe('2 campaigns');
    expect(estimateLine(115, 150, 2)).toBe('About 1 h 55 of play for 2 campaigns. The server is held for up to 2 h 30 and closes when you finish.');
    // Play is the campaigns alone, to the nearest 5 minutes; unknown ones count 60.
    const e = { perCampaign: { no_mercy: 48, dead_air: 49, suicide_blitz: 62 }, base: 15, slack: 10, step: 30, min: 60 };
    expect(playMinutes(e, ['no_mercy', 'dead_air', 'suicide_blitz', 'death_aboard'])).toBe(220);
    expect(estimateSlot(e, ['no_mercy', 'dead_air', 'suicide_blitz', 'death_aboard'])).toBe(300);
    expect(slotSummary(2, 150)).toBe('2 campaigns · about 2 h 30');
  });

  it('merges an accept the way the server does: alternating, poster first, no repeats, capped', () => {
    expect(mergedPlaylist(['a', 'b'], ['c', 'a', 'd'], 4)).toEqual(['a', 'c', 'b', 'd']);
    expect(mergedPlaylist(['a', 'b'], ['c', 'd'], 3)).toEqual(['a', 'c', 'b']);
  });

  it('labels the scrim night window with its weekday and local start-end', () => {
    const start = new Date(2026, 9, 1, 17, 0);
    const end = new Date(2026, 9, 1, 21, 0);
    const time = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    expect(nightRangeLabel(start.toISOString(), end.toISOString()))
      .toBe(`${start.toLocaleDateString(undefined, { weekday: 'long' })} ${time(start)}-${time(end)}`);
  });
});
