/**
 * A stage's veto settings (tournaments plan T3a Ruling 3, owner 2026-10-06:
 * presets plus every knob). Pure, with no server-only imports, because the
 * web stage editor imports it too. src/events/veto.ts runs a match's veto
 * from these settings.
 *
 * games 2 is always total score (Ruling 4). banTo is how many campaigns are
 * left after the opening bans (the pool size means no bans). lateBans are
 * extra bans before the last game, only when the teams take turns picking.
 */

export const VETO_GAMES = [1, 2, 3, 5] as const;
export type VetoGames = (typeof VETO_GAMES)[number];
export const FIRST_BANS = ['higher_chooses', 'higher', 'lower', 'coin'] as const;
export type FirstBan = (typeof FIRST_BANS)[number];
export const FIRST_PICKS = ['higher', 'lower', 'first', 'second', 'coin'] as const;
export type FirstPick = (typeof FIRST_PICKS)[number];
export const LATER_PICKS = ['loser', 'alternate'] as const;
export type LaterPicks = (typeof LATER_PICKS)[number];
export const SIDE_RULES = ['non_picker', 'higher', 'coin'] as const;
export type SideRule = (typeof SIDE_RULES)[number];

export interface VetoConfig {
  games: VetoGames; banTo: number; firstBan: FirstBan; firstPick: FirstPick; laterPicks: LaterPicks; lateBans: number; sides: SideRule;
}

export const VETO_PRESETS = ['ban_to_one', 'home_away', 'pick_ban', 'loser_picks'] as const;
export type VetoPreset = (typeof VETO_PRESETS)[number];
export const PRESET_LABEL: Record<VetoPreset | 'custom', string> = {
  ban_to_one: 'Ban to one (Bo1)',
  home_away: 'Home and away (Bo2, total score)',
  pick_ban: 'Pick and ban (Bo3)',
  loser_picks: 'Ban to three, loser picks (Bo3)',
  custom: 'Custom',
};
/** The smallest pool each preset runs on. */
export const PRESET_MIN_POOL: Record<VetoPreset, number> = { ban_to_one: 1, home_away: 2, pick_ban: 5, loser_picks: 3 };
/** The most campaigns a pool holds (validate.ts POOL_MAX). */
const POOL_LIMIT = 12;

const DEFAULTS: VetoConfig = {
  games: 1, banTo: 1, firstBan: 'higher_chooses', firstPick: 'first', laterPicks: 'alternate', lateBans: 0, sides: 'non_picker',
};

export function presetConfig(p: VetoPreset, poolSize: number): VetoConfig {
  switch (p) {
    case 'ban_to_one': return { ...DEFAULTS };
    case 'home_away': return { ...DEFAULTS, games: 2, banTo: poolSize };
    // B B P P B B, then the decider: two opening bans, a pick each, then
    // late bans until one campaign is left.
    case 'pick_ban': return { ...DEFAULTS, games: 3, banTo: Math.max(3, poolSize - 2), lateBans: Math.max(0, poolSize - 5) };
    case 'loser_picks': return { ...DEFAULTS, games: 3, banTo: 3, firstPick: 'higher', laterPicks: 'loser' };
  }
}

/** A Bo1 has no later picks and no late bans, so they read as the defaults
 *  and two configs that play the same compare equal. */
function normalize(c: VetoConfig): VetoConfig {
  return c.games === 1 ? { ...c, laterPicks: 'alternate', lateBans: 0 } : c;
}

const isInt = (v: unknown): v is number => Number.isInteger(v);
const has = <T extends string | number>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v);

export function checkVeto(c: VetoConfig, poolSize: number): 'ok' | 'bad_veto' | 'bad_pool_for_veto' {
  if (!has(VETO_GAMES, c.games) || !has(FIRST_BANS, c.firstBan) || !has(FIRST_PICKS, c.firstPick)
    || !has(LATER_PICKS, c.laterPicks) || !has(SIDE_RULES, c.sides)) return 'bad_veto';
  if (!isInt(c.banTo) || !isInt(c.lateBans) || c.banTo < c.games || c.banTo > POOL_LIMIT || c.lateBans < 0) return 'bad_veto';
  if (c.games === 2 && c.laterPicks === 'loser') return 'bad_veto';
  if (c.lateBans > 0 && (c.games === 1 || c.games === 2 || c.laterPicks === 'loser')) return 'bad_veto';
  // After the picks of every game but the last, at least one campaign must
  // be left for it once the late bans are made.
  if (c.lateBans > c.banTo - (c.games - 1) - 1) return 'bad_veto';
  if (c.banTo > poolSize) return 'bad_pool_for_veto';
  return 'ok';
}

export function parseVetoConfig(raw: unknown, poolSize: number):
  { ok: true; value: VetoConfig } | { ok: false; error: 'bad_veto' | 'bad_pool_for_veto' } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'bad_veto' };
  const r = raw as Record<string, unknown>;
  const c = {
    games: r.games, banTo: r.banTo, firstBan: r.firstBan, firstPick: r.firstPick, laterPicks: r.laterPicks, lateBans: r.lateBans, sides: r.sides,
  } as VetoConfig;
  if (Object.values(c).some((v) => v === undefined)) return { ok: false, error: 'bad_veto' };
  const n = normalize(c);
  const verdict = checkVeto(n, poolSize);
  return verdict === 'ok' ? { ok: true, value: n } : { ok: false, error: verdict };
}

const same = (x: VetoConfig, y: VetoConfig): boolean => JSON.stringify(normalize(x)) === JSON.stringify(normalize(y));

export function presetOf(c: VetoConfig, poolSize: number): VetoPreset | 'custom' {
  return VETO_PRESETS.find((p) => same(c, presetConfig(p, poolSize))) ?? 'custom';
}

/** The event_stages.veto_type CHECK column only knows three values. */
export function vetoFamily(c: VetoConfig): 'ban_to_one' | 'home_away' | 'pick_ban' {
  return c.games === 1 ? 'ban_to_one' : c.games === 2 ? 'home_away' : 'pick_ban';
}

const WHO: Record<FirstPick, string> = {
  higher: 'the higher seed', lower: 'the lower seed', first: 'the team that goes first', second: 'the team that goes second', coin: 'a coin flip',
};
const FIRST_TEXT: Record<Exclude<FirstBan, 'higher_chooses'>, string> = {
  higher: 'the higher seed goes first', lower: 'the lower seed goes first', coin: 'a coin flip decides who goes first',
};

/** One sentence for the event page and the stage editor. */
export function vetoSummary(c: VetoConfig, poolSize: number): string {
  const parts: string[] = [];
  parts.push(poolSize > c.banTo ? `ban down to ${c.banTo}` : 'no bans');
  parts.push(c.firstBan === 'higher_chooses' ? 'the higher seed chooses to go first or second' : FIRST_TEXT[c.firstBan]);
  if (c.games === 1) {
    if (c.banTo > 1) parts.push(`${WHO[c.firstPick]} picks the campaign`);
  } else {
    parts.push(`${WHO[c.firstPick]} picks game 1`);
    parts.push(c.laterPicks === 'loser' ? 'the loser of each game picks the next' : 'the teams take turns picking the rest');
    if (c.lateBans > 0) parts.push(`${c.lateBans} more ban${c.lateBans === 1 ? '' : 's'} before the last game`);
  }
  parts.push(c.sides === 'non_picker' ? 'the team that did not pick chooses sides' : c.sides === 'higher' ? 'the higher seed chooses sides' : 'a coin flip sets the sides');
  return `${c.games === 2 ? 'Bo2, total score' : `Bo${c.games}`}: ${parts.join(', ')}.`;
}
