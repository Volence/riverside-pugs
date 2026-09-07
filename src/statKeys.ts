/** Single source of truth for skill stat keys.
 *
 *  Storage is a narrow key/value table (`match_player_stats`) rather than one
 *  column per stat, so adding a stat needs no migration. The cost of that choice
 *  is that a typo'd key is not a DB error, it is a silently empty leaderboard.
 *  This registry plus tests/statKeys.test.ts is the mitigation: the plugin, the
 *  parser and the API all resolve keys through here. */

export type StatSide = 'survivor' | 'infected';

/** `self` stats are shown only to the player they describe and are never
 *  eligible for a leaderboard. Used for stats where a high number is bad. */
export type StatVisibility = 'public' | 'self';

export interface StatDef {
  key: string;
  side: StatSide;
  visibility: StatVisibility;
  label: string;
  /** True when the value comes from an l4d2_skill_detect forward, and is
   *  therefore absent (not zero) from a dump whose header says skilldetect=0. */
  needsSkillDetect: boolean;
}

const def = (
  key: string, side: StatSide, label: string,
  needsSkillDetect = true, visibility: StatVisibility = 'public',
): StatDef => ({ key, side, label, needsSkillDetect, visibility });

export const STAT_DEFS: readonly StatDef[] = [
  // Survivor, from skill_detect. A team skeet is not also a skeet.
  def('skeets', 'survivor', 'Skeets'),
  def('team_skeets', 'survivor', 'Team skeets'),
  def('skeets_hurt', 'survivor', 'Hurt skeets'),
  def('skeet_assists', 'survivor', 'Skeet assists'),
  def('skeets_shotgun', 'survivor', 'Shotgun skeets'),
  def('skeets_sniper', 'survivor', 'Sniper skeets'),
  def('skeets_melee', 'survivor', 'Melee skeets'),
  def('deadstops', 'survivor', 'Deadstops'),
  def('boomer_pops', 'survivor', 'Boomer pops'),
  def('crowns', 'survivor', 'Crowns'),
  def('draw_crowns', 'survivor', 'Draw crowns'),
  def('tongue_cuts', 'survivor', 'Tongue cuts'),
  def('self_clears', 'survivor', 'Self clears'),
  def('rock_skeets', 'survivor', 'Rock skeets'),
  def('clears', 'survivor', 'Clears'),
  def('insta_clears', 'survivor', 'Insta clears'),

  // Infected, from skill_detect.
  def('dps_landed', 'infected', 'DPs landed'),
  def('pounce_damage_high', 'infected', 'High pounce damage'),
  def('biles_landed', 'infected', 'Biles landed'),
  def('survivors_biled', 'infected', 'Survivors biled'),
  def('tank_rocks_landed', 'infected', 'Tank rocks landed'),

  // Infected, private. High is bad, so shown only to the player themselves and
  // never rankable. See the spec's "Stat visibility" section.
  def('times_skeeted', 'infected', 'Times skeeted', true, 'self'),
  def('times_deadstopped', 'infected', 'Times deadstopped', true, 'self'),

  // Captured by pug-match's own hooks, so always available even with no
  // skill_detect on the server.
  def('tank_damage', 'survivor', 'Tank damage', false),
  def('damage_as_si', 'infected', 'Damage as SI', false),
  def('tank_punches', 'infected', 'Tank punches', false),
];

const BY_KEY = new Map(STAT_DEFS.map((d) => [d.key, d]));

export function statDef(key: string): StatDef | undefined {
  return BY_KEY.get(key);
}

export function isKnownStat(key: string): boolean {
  return BY_KEY.has(key);
}

export function publicStatKeys(): string[] {
  return STAT_DEFS.filter((d) => d.visibility === 'public').map((d) => d.key);
}

export function skillDetectStatKeys(): string[] {
  return STAT_DEFS.filter((d) => d.needsSkillDetect).map((d) => d.key);
}
