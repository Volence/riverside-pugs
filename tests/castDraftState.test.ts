import { describe, it, expect } from 'vitest';
import { cleanState } from '../src/cast/studio.js';
import { obsCollection, obsSceneName } from '../src/cast/obsCollection.js';
import { DRAFT_SCENES, LAYERS, SCENES, SCENE_HOTKEYS, SCENE_LABELS, defaultStudioState } from '../src/cast/types.js';

/** Drafts plan D2b2 Rulings 1, 4 and 11. */
describe('studio state: the draft on air', () => {
  it('defaults to no draft and the reveal strip on', () => {
    expect(defaultStudioState()).toMatchObject({ draftEventId: null, draftStrip: true });
    expect(cleanState({})).toMatchObject({ draftEventId: null, draftStrip: true });
  });

  it('keeps a positive integer id and an explicit strip off, nothing else', () => {
    expect(cleanState({ draftEventId: 12, draftStrip: false })).toMatchObject({ draftEventId: 12, draftStrip: false });
    for (const bad of [0, -4, 1.5, '12', null, 2 ** 31]) expect(cleanState({ draftEventId: bad }).draftEventId).toBeNull();
    expect(cleanState({ draftStrip: 'no' }).draftStrip).toBe(true);
  });

  it('is independent of the match on air', () => {
    expect(cleanState({ matchId: 7, draftEventId: 12 })).toMatchObject({ matchId: 7, bookingId: null, draftEventId: 12 });
  });

  it('accepts the draft scenes, and never the reveal layer as a scene', () => {
    expect(cleanState({ scene: 'draftboard' }).scene).toBe('draftboard');
    expect(cleanState({ scene: 'draftclock' }).scene).toBe('draftclock');
    expect(cleanState({ scene: 'draftreveal' }).scene).toBe('starting');
  });
});

describe('draft scene keys', () => {
  it('appends the draft scenes after the run of show, with letter hotkeys', () => {
    expect(SCENES.slice(0, 11)).toEqual(['starting', 'casters', 'gameplay', 'mapintro', 'maps', 'lineups', 'stats', 'brb', 'winner', 'ending', 'results']);
    expect(DRAFT_SCENES).toEqual(['draftboard', 'draftclock']);
    expect(SCENE_HOTKEYS.draftboard).toBe('B');
    expect(SCENE_HOTKEYS.draftclock).toBe('C');
    expect(SCENE_HOTKEYS.starting).toBe('1');
    expect(SCENE_HOTKEYS.ending).toBe('0');
    expect(SCENE_HOTKEYS.results).toBe('R');
    expect(new Set(Object.values(SCENE_HOTKEYS)).size).toBe(SCENES.length);
    expect(LAYERS).toContain('draftreveal');
    expect(SCENE_LABELS.draftboard).toBe('Draft board');
    expect(SCENE_LABELS.draftclock).toBe('On the clock');
    expect(SCENE_LABELS.draftreveal).toBe('Pick reveal');
  });

  it('keeps every overlay key to lower-case letters (the /overlay/<key> route pattern)', () => {
    for (const k of [...SCENES, ...LAYERS]) expect(k).toMatch(/^[a-z]+$/);
  });

  it('puts both draft scenes in the OBS scene collection', () => {
    const c = obsCollection({ overlayUrl: (k) => `https://x/overlay/${k}?k=K`, casters: [] }) as {
      scene_order: { name: string }[]; sources: { id: string; settings: { url?: string } }[];
    };
    const names = c.scene_order.map((s) => s.name);
    expect(obsSceneName('draftboard')).toBe('RS Draft board');
    expect(obsSceneName('draftclock')).toBe('RS On the clock');
    expect(names).toContain('RS Draft board');
    expect(names).toContain('RS On the clock');
    const urls = c.sources.filter((s) => s.id === 'browser_source').map((s) => s.settings.url);
    expect(urls).toContain('https://x/overlay/draftboard?k=K');
    expect(urls).toContain('https://x/overlay/draftclock?k=K');
  });
});
