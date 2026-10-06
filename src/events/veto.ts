import type { VetoConfig } from './vetoConfig.js';

/**
 * The veto step engine (tournaments plan T3a). Pure and deterministic: the
 * state is a replay of the stored actions over the stage's settings, the
 * match's coin seed and the winners of the games played so far (T3b), so the
 * database keeps only event_vetoes and a restart loses nothing.
 *
 * The order: who goes first (asked of the higher seed when the settings say
 * so, and only when something uses it), the opening bans taking turns down
 * to banTo, then each game: its campaign (picked, or the decider when one is
 * left for the last game), then its sides. With "the teams take turns", the
 * late bans come before the last game. With "loser picks", game 2 on waits
 * for the previous game's winner, and the series stops once a team has won
 * more than half (games 2 is total score and never stops early).
 * Coin k reads bit k of the seed: 0 who goes first, 1 who picks game 1,
 * 2 + g the sides of game g.
 */

export type Side = 'a' | 'b';
export const other = (s: Side): Side => (s === 'a' ? 'b' : 'a');
export type VetoActionKind = 'first' | 'second' | 'ban' | 'pick' | 'survivors' | 'infected';
export interface VetoAction { side: Side; action: VetoActionKind; campaign: string | null; auto: boolean }
export type Step =
  | { kind: 'order'; by: Side }
  | { kind: 'ban'; by: Side }
  | { kind: 'pick'; by: Side; game: number }
  | { kind: 'side'; by: Side; game: number }
  | { kind: 'wait'; game: number }
  | { kind: 'done' };
export interface GameSlot { game: number; campaign: string; pickedBy: Side | null; sideBy: Side | null; firstSurvivors: Side | null }
export interface VetoState { first: Side | null; remaining: string[]; bans: { side: Side; campaign: string }[]; games: GameSlot[]; next: Step; used: number }
export interface VetoInput { config: VetoConfig; pool: string[]; higher: Side; seed: number; actions: VetoAction[]; winners: Side[] }

export class VetoError extends Error {
  constructor(readonly code: 'not_your_turn' | 'bad_veto_action') { super(code); }
}

export const coin = (seed: number, k: number): Side => (((seed >>> k) & 1) === 0 ? 'a' : 'b');

export const isHumanStep = (s: Step): s is Extract<Step, { by: Side }> =>
  s.kind === 'order' || s.kind === 'ban' || s.kind === 'pick' || s.kind === 'side';

const STOP = Symbol('stop');

function fits(step: Extract<Step, { by: Side }>, a: VetoAction, remaining: string[]): void {
  if (a.side !== step.by) throw new VetoError('not_your_turn');
  const ok = step.kind === 'order' ? (a.action === 'first' || a.action === 'second') && a.campaign === null
    : step.kind === 'side' ? (a.action === 'survivors' || a.action === 'infected') && a.campaign === null
      : a.action === step.kind && a.campaign !== null && remaining.includes(a.campaign);
  if (!ok) throw new VetoError('bad_veto_action');
}

export function vetoState(inp: VetoInput): VetoState {
  const c = inp.config;
  const higher = inp.higher;
  const st: VetoState = { first: null, remaining: [...inp.pool], bans: [], games: [], next: { kind: 'done' }, used: 0 };
  let lastBanner: Side | null = null;
  const take = (step: Extract<Step, { by: Side }>): VetoAction => {
    const a = inp.actions[st.used];
    if (!a) {
      st.next = step;
      throw STOP;
    }
    fits(step, a, st.remaining);
    st.used++;
    return a;
  };
  const ban = (by: Side): void => {
    const a = take({ kind: 'ban', by });
    st.remaining = st.remaining.filter((x) => x !== a.campaign);
    st.bans.push({ side: by, campaign: a.campaign! });
    lastBanner = by;
  };
  try {
    const openingBans = inp.pool.length - c.banTo;
    const usesOrder = openingBans > 0 || c.lateBans > 0 || c.firstPick === 'first' || c.firstPick === 'second';
    if (usesOrder) {
      if (c.firstBan === 'higher_chooses') st.first = take({ kind: 'order', by: higher }).action === 'first' ? higher : other(higher);
      else st.first = c.firstBan === 'higher' ? higher : c.firstBan === 'lower' ? other(higher) : coin(inp.seed, 0);
    }
    for (let i = 0; i < openingBans; i++) ban(i % 2 === 0 ? st.first! : other(st.first!));
    const picker1: Side = c.firstPick === 'higher' ? higher : c.firstPick === 'lower' ? other(higher)
      : c.firstPick === 'first' ? st.first! : c.firstPick === 'second' ? other(st.first!) : coin(inp.seed, 1);
    const pickerOf = (g: number): Side => (g % 2 === 1 ? picker1 : other(picker1));
    for (let g = 1; g <= c.games; g++) {
      let picker: Side = pickerOf(g);
      if (g > 1 && c.laterPicks === 'loser') {
        if (inp.winners.length < g - 1) {
          st.next = { kind: 'wait', game: g };
          throw STOP;
        }
        const won = inp.winners.slice(0, g - 1);
        if (won.filter((w) => w === 'a').length > c.games / 2 || won.filter((w) => w === 'b').length > c.games / 2) break;
        picker = other(inp.winners[g - 2]!);
      }
      if (g === c.games && c.games > 1 && c.laterPicks === 'alternate') {
        const lastPicker = pickerOf(g - 1);
        for (let i = 0; i < c.lateBans; i++) ban(i % 2 === 0 ? other(lastPicker) : lastPicker);
      }
      let campaign: string;
      let pickedBy: Side | null = null;
      if (g === c.games && st.remaining.length === 1) {
        campaign = st.remaining[0]!;
      } else {
        campaign = take({ kind: 'pick', by: picker, game: g }).campaign!;
        pickedBy = picker;
      }
      let firstSurvivors: Side | null = null;
      let sideBy: Side | null = null;
      if (c.sides === 'coin') {
        firstSurvivors = coin(inp.seed, 2 + g);
      } else {
        // Ruling 6: the non-picker; for a decider, the team that did not make
        // the last ban; with no bans at all, the higher seed.
        const by: Side = c.sides === 'higher' ? higher : pickedBy ? other(pickedBy) : lastBanner ? other(lastBanner) : higher;
        sideBy = by;
        firstSurvivors = take({ kind: 'side', by, game: g }).action === 'survivors' ? by : other(by);
      }
      st.remaining = st.remaining.filter((x) => x !== campaign);
      const slot: GameSlot = { game: g, campaign, pickedBy, sideBy, firstSurvivors };
      st.games.push(slot);
    }
    st.next = { kind: 'done' };
  } catch (err) {
    if (err !== STOP) throw err;
  }
  if (st.used < inp.actions.length) throw new VetoError('bad_veto_action');
  return st;
}

export function applyVeto(inp: VetoInput, a: VetoAction):
  { ok: true; state: VetoState } | { ok: false; code: 'not_your_turn' | 'bad_veto_action' } {
  try {
    return { ok: true, state: vetoState({ ...inp, actions: [...inp.actions, a] }) };
  } catch (err) {
    if (err instanceof VetoError) return { ok: false, code: err.code };
    throw err;
  }
}

/** Ruling 7: what the room does for a team whose time ran out. */
export function autoAction(st: VetoState, pool: string[], prefs: { campaigns: string[]; side: 'survivors' | 'infected' | null }): VetoAction {
  const n = st.next;
  const left = new Set(st.remaining);
  const ranked = [...prefs.campaigns.filter((x) => left.has(x)), ...pool.filter((x) => left.has(x) && !prefs.campaigns.includes(x))];
  switch (n.kind) {
    case 'order': return { side: n.by, action: 'first', campaign: null, auto: true };
    case 'ban': return { side: n.by, action: 'ban', campaign: ranked[ranked.length - 1]!, auto: true };
    case 'pick': return { side: n.by, action: 'pick', campaign: ranked[0]!, auto: true };
    case 'side': return { side: n.by, action: prefs.side ?? 'survivors', campaign: null, auto: true };
    default: throw new Error(`no automatic action for a ${n.kind} step`);
  }
}
