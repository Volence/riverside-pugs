import { describe, it, expect } from 'vitest';
import { applyVeto, autoAction, coin, isHumanStep, vetoState, type Side, type VetoAction, type VetoInput } from '../src/events/veto.js';
import { presetConfig, type VetoConfig } from '../src/events/vetoConfig.js';

const POOL = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];
const act = (side: Side, action: VetoAction['action'], campaign: string | null = null): VetoAction => ({ side, action, campaign, auto: false });
const input = (config: VetoConfig, actions: VetoAction[], over: Partial<VetoInput> = {}): VetoInput =>
  ({ config, pool: POOL, higher: 'a', seed: 0, actions, winners: [], ...over });

describe('ban to one (Bo1)', () => {
  const cfg = presetConfig('ban_to_one', 7);

  it('asks the higher seed for first or second, then alternates bans down to one, then the non-banner picks sides', () => {
    let st = vetoState(input(cfg, []));
    expect(st.next).toEqual({ kind: 'order', by: 'a' });
    const actions = [act('a', 'second')];
    st = vetoState(input(cfg, actions));
    expect(st.first).toBe('b');
    expect(st.next).toEqual({ kind: 'ban', by: 'b' });
    const bans: Side[] = ['b', 'a', 'b', 'a', 'b', 'a'];
    bans.forEach((s, i) => actions.push(act(s, 'ban', POOL[i]!)));
    st = vetoState(input(cfg, actions));
    expect(st.remaining).toEqual([]);
    expect(st.games).toEqual([{ game: 1, campaign: 'c7', pickedBy: null, sideBy: 'b', firstSurvivors: null }]);
    // a made the last ban, so b chooses sides for the decider.
    expect(st.next).toEqual({ kind: 'side', by: 'b', game: 1 });
    actions.push(act('b', 'infected'));
    st = vetoState(input(cfg, actions));
    expect(st.games).toEqual([{ game: 1, campaign: 'c7', pickedBy: null, sideBy: 'b', firstSurvivors: 'a' }]);
    expect(st.next).toEqual({ kind: 'done' });
  });

  it('refuses the wrong team, a banned campaign, and the wrong kind of action', () => {
    const inp = input(cfg, [act('a', 'first')]);
    expect(applyVeto(inp, act('b', 'ban', 'c1'))).toEqual({ ok: false, code: 'not_your_turn' });
    expect(applyVeto(inp, act('a', 'pick', 'c1'))).toEqual({ ok: false, code: 'bad_veto_action' });
    const after = input(cfg, [act('a', 'first'), act('a', 'ban', 'c1')]);
    expect(applyVeto(after, act('b', 'ban', 'c1'))).toEqual({ ok: false, code: 'bad_veto_action' });
    expect(applyVeto(after, act('b', 'ban', 'nope'))).toEqual({ ok: false, code: 'bad_veto_action' });
  });

  it('takes a fixed or coin first team without asking', () => {
    expect(vetoState(input({ ...cfg, firstBan: 'lower' }, [])).next).toEqual({ kind: 'ban', by: 'b' });
    expect(coin(0b1, 0)).toBe('b');
    expect(coin(0b10, 0)).toBe('a');
    expect(vetoState(input({ ...cfg, firstBan: 'coin' }, [], { seed: 1 })).next).toEqual({ kind: 'ban', by: 'b' });
  });
});

describe('ban to three, loser picks (Bo3, the owner\'s format)', () => {
  const cfg = presetConfig('loser_picks', 7);
  const opening = (): VetoAction[] => [act('a', 'first'), act('a', 'ban', 'c1'), act('b', 'ban', 'c2'), act('a', 'ban', 'c3'), act('b', 'ban', 'c4')];

  it('bans down to three, the higher seed picks game 1, the other team picks its sides, then waits for game 1', () => {
    const actions = opening();
    let st = vetoState(input(cfg, actions));
    expect(st.remaining).toEqual(['c5', 'c6', 'c7']);
    expect(st.next).toEqual({ kind: 'pick', by: 'a', game: 1 });
    actions.push(act('a', 'pick', 'c6'));
    st = vetoState(input(cfg, actions));
    expect(st.games).toEqual([{ game: 1, campaign: 'c6', pickedBy: 'a', sideBy: 'b', firstSurvivors: null }]);
    actions.push(act('b', 'survivors'));
    st = vetoState(input(cfg, actions));
    expect(st.games[0]).toEqual({ game: 1, campaign: 'c6', pickedBy: 'a', sideBy: 'b', firstSurvivors: 'b' });
    expect(st.next).toEqual({ kind: 'wait', game: 2 });
  });

  it('lets the loser of each game pick the next, and plays the last campaign as the decider', () => {
    const actions = [...opening(), act('a', 'pick', 'c6'), act('b', 'survivors')];
    // b won game 1, so a (the loser) picks game 2.
    let st = vetoState(input(cfg, actions, { winners: ['b'] }));
    expect(st.next).toEqual({ kind: 'pick', by: 'a', game: 2 });
    actions.push(act('a', 'pick', 'c5'), act('b', 'infected'));
    st = vetoState(input(cfg, actions, { winners: ['b'] }));
    expect(st.next).toEqual({ kind: 'wait', game: 3 });
    // 1-1: game 3 is the decider; b made the last ban, so a chooses sides.
    st = vetoState(input(cfg, actions, { winners: ['b', 'a'] }));
    expect(st.next).toEqual({ kind: 'side', by: 'a', game: 3 });
    actions.push(act('a', 'survivors'));
    st = vetoState(input(cfg, actions, { winners: ['b', 'a'] }));
    expect(st.games.map((g) => g.campaign)).toEqual(['c6', 'c5', 'c7']);
    expect(st.next).toEqual({ kind: 'done' });
  });

  it('stops once a team has won the series', () => {
    const actions = [...opening(), act('a', 'pick', 'c6'), act('b', 'survivors'), act('a', 'pick', 'c5'), act('b', 'infected')];
    expect(vetoState(input(cfg, actions, { winners: ['b', 'b'] })).next).toEqual({ kind: 'done' });
  });
});

describe('pick and ban (Bo3, B B P P B B decider)', () => {
  it('runs the classic order with the late bans before the decider', () => {
    const cfg = presetConfig('pick_ban', 7);
    const actions = [act('a', 'first'), act('a', 'ban', 'c1'), act('b', 'ban', 'c2')];
    let st = vetoState(input(cfg, actions));
    expect(st.next).toEqual({ kind: 'pick', by: 'a', game: 1 });
    actions.push(act('a', 'pick', 'c3'), act('b', 'survivors'));
    st = vetoState(input(cfg, actions));
    expect(st.next).toEqual({ kind: 'pick', by: 'b', game: 2 });
    actions.push(act('b', 'pick', 'c4'), act('a', 'infected'));
    st = vetoState(input(cfg, actions));
    expect(st.next).toEqual({ kind: 'ban', by: 'a' });
    actions.push(act('a', 'ban', 'c5'), act('b', 'ban', 'c6'));
    st = vetoState(input(cfg, actions));
    expect(st.next).toEqual({ kind: 'side', by: 'a', game: 3 });
    actions.push(act('a', 'survivors'));
    st = vetoState(input(cfg, actions));
    expect(st.games.map((g) => [g.campaign, g.pickedBy])).toEqual([['c3', 'a'], ['c4', 'b'], ['c7', null]]);
    expect(st.next).toEqual({ kind: 'done' });
  });
});

describe('home and away (Bo2 total score)', () => {
  it('has no bans: the team that goes first picks game 1, the other picks game 2', () => {
    const cfg = presetConfig('home_away', 4);
    const inp = (actions: VetoAction[]) => ({ ...input(cfg, actions), pool: POOL.slice(0, 4) });
    const actions = [act('a', 'second')];
    expect(vetoState(inp(actions)).next).toEqual({ kind: 'pick', by: 'b', game: 1 });
    actions.push(act('b', 'pick', 'c2'), act('a', 'survivors'), act('a', 'pick', 'c4'), act('b', 'infected'));
    const st = vetoState(inp(actions));
    expect(st.games.map((g) => [g.campaign, g.pickedBy, g.firstSurvivors])).toEqual([['c2', 'b', 'a'], ['c4', 'a', 'a']]);
    expect(st.next).toEqual({ kind: 'done' });
  });
  it('gives a decider\'s sides to the team that did not make the last pick when nobody banned (pool of 2)', () => {
    const cfg = presetConfig('home_away', 2);
    const inp = (actions: VetoAction[]) => ({ ...input(cfg, actions), pool: POOL.slice(0, 2) });
    const actions = [act('a', 'first'), act('a', 'pick', 'c1'), act('b', 'survivors')];
    const st = vetoState(inp(actions));
    // game 2 is the decider: a picked game 1, so b chooses its sides.
    expect(st.games[1]).toEqual({ game: 2, campaign: 'c2', pickedBy: null, sideBy: 'b', firstSurvivors: null });
    expect(st.next).toEqual({ kind: 'side', by: 'b', game: 2 });
  });
});

describe('coin sides and fixed pickers', () => {
  it('sets sides by coin with no step, and asks no order question when nothing uses it', () => {
    const cfg: VetoConfig = { games: 1, banTo: 7, firstBan: 'higher_chooses', firstPick: 'lower', laterPicks: 'alternate', lateBans: 0, sides: 'coin' };
    const st0 = vetoState(input(cfg, []));
    expect(st0.next).toEqual({ kind: 'pick', by: 'b', game: 1 });
    const st = vetoState(input(cfg, [act('b', 'pick', 'c3')], { seed: 0b1000 }));
    // coin k = 2 + game = 3 reads bit 3.
    expect(st.games[0]!.firstSurvivors).toBe('b');
    expect(st.next).toEqual({ kind: 'done' });
  });
});

describe('order step only when something uses it', () => {
  it('asks no order question for a Bo1 ban to one on a pool of 1, even with firstPick first', () => {
    const cfg = presetConfig('ban_to_one', 1);
    expect(cfg.firstPick).toBe('first');
    const st = vetoState({ ...input(cfg, []), pool: ['c1'] });
    expect(st.first).toBeNull();
    expect(st.next).toEqual({ kind: 'side', by: 'a', game: 1 });
  });
});

describe('autoAction', () => {
  const cfg = presetConfig('loser_picks', 7);
  it('goes first, bans the least wanted, picks the most wanted, and takes the saved side', () => {
    let st = vetoState(input(cfg, []));
    expect(autoAction(st, POOL, { campaigns: [], side: null })).toEqual({ side: 'a', action: 'first', campaign: null, auto: true });
    st = vetoState(input(cfg, [act('a', 'first')]));
    // Saved order c7, c1; the rest follow in pool order, so c6 is least wanted.
    expect(autoAction(st, POOL, { campaigns: ['c7', 'c1'], side: null })).toEqual({ side: 'a', action: 'ban', campaign: 'c6', auto: true });
    const actions = [act('a', 'first'), act('a', 'ban', 'c1'), act('b', 'ban', 'c2'), act('a', 'ban', 'c3'), act('b', 'ban', 'c4')];
    st = vetoState(input(cfg, actions));
    expect(autoAction(st, POOL, { campaigns: ['c7'], side: null }).campaign).toBe('c7');
    st = vetoState(input(cfg, [...actions, act('a', 'pick', 'c6')]));
    expect(autoAction(st, POOL, { campaigns: [], side: 'infected' })).toEqual({ side: 'b', action: 'infected', campaign: null, auto: true });
    expect(autoAction(st, POOL, { campaigns: [], side: null }).action).toBe('survivors');
  });

  it('marks only order, ban, pick and side as steps a person takes', () => {
    expect(isHumanStep({ kind: 'wait', game: 2 })).toBe(false);
    expect(isHumanStep({ kind: 'done' })).toBe(false);
    expect(isHumanStep({ kind: 'ban', by: 'a' })).toBe(true);
  });
});
