import { describe, it, expect } from 'vitest';
import { vetoPlan, type VetoAction } from '../src/events/veto.js';
import { legacyPresetConfig, presetConfig } from '../src/events/vetoConfig.js';

/**
 * The room's step list (owner 2026-10-23): every step of the veto in order,
 * done / now / later, so a captain sees a pick coming after the bans.
 */
const POOL9 = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9'];
const brief = (p: ReturnType<typeof vetoPlan>) => p.map((s) => `${s.kind}:${s.by ?? '-'}:${s.state}${s.tentative ? '?' : ''}`);

describe('vetoPlan', () => {
  it('lists six bans, the pick and the side choice on the new standard (Bo1 ban to 3 of 9): higher seed a bans first and picks', () => {
    const config = { ...presetConfig('ban_to_one', 9), banTo: 3 };
    const plan = vetoPlan({ config, pool: POOL9, higher: 'a', seed: 0, actions: [], winners: [] });
    expect(brief(plan)).toEqual([
      'ban:a:now', 'ban:b:later', 'ban:a:later', 'ban:b:later', 'ban:a:later', 'ban:b:later', 'pick:a:later', 'side:b:later',
    ]);
  });

  it('marks the steps taken as done and moves now along', () => {
    const config = { ...presetConfig('ban_to_one', 9), banTo: 3 };
    const actions: VetoAction[] = [{ side: 'a', action: 'ban', campaign: 'c1', auto: false }, { side: 'b', action: 'ban', campaign: 'c2', auto: false }];
    expect(brief(vetoPlan({ config, pool: POOL9, higher: 'a', seed: 0, actions, winners: [] })).slice(0, 3)).toEqual(['ban:a:done', 'ban:b:done', 'ban:a:now']);
  });

  it('with the higher seed choosing the order, the steps after it are tentative until they choose', () => {
    const config = { ...legacyPresetConfig('ban_to_one', 9), banTo: 3 };
    const plan = vetoPlan({ config, pool: POOL9, higher: 'b', seed: 0, actions: [], winners: [] });
    expect(brief(plan)[0]).toBe('order:b:now');
    expect(plan.slice(1).every((s) => s.tentative)).toBe(true);
    const chosen = vetoPlan({ config, pool: POOL9, higher: 'b', seed: 0, actions: [{ side: 'b', action: 'second', campaign: null, auto: false }], winners: [] });
    expect(brief(chosen).slice(0, 3)).toEqual(['order:b:done', 'ban:a:now', 'ban:b:later']);
  });

  it('ends a loser-picks series at the game that waits for a result', () => {
    const plan = vetoPlan({ config: presetConfig('loser_picks', 7), pool: POOL9.slice(0, 7), higher: 'a', seed: 0, actions: [], winners: [] });
    expect(plan.at(-1)).toMatchObject({ kind: 'wait', game: 2, state: 'later' });
    expect(plan.filter((s) => s.kind === 'pick')).toEqual([{ kind: 'pick', by: 'a', game: 1, state: 'later', tentative: false }]);
  });
});
