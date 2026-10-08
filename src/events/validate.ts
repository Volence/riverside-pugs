import { findSlurs } from '../slurs.js';
import { DEFAULT_IGNORABLE, hasUnsafeChars } from '../profileFields.js';
import { NOTE_MAX, PICK_SECONDS_MAX, PICK_SECONDS_MIN } from './draftRules.js';
import { parseVetoConfig, presetConfig, vetoFamily, VETO_PRESETS, PRESET_MIN_POOL, type VetoConfig, type VetoPreset } from './vetoConfig.js';

/**
 * Every rule about an event's and a stage's settings (tournaments spec part
 * 2, sections 1 and 2; plan T1a). Pure: the lists a stage is checked against
 * (poolable campaigns, live rulesets, enabled game configs, the site pool)
 * come in as a StageContext, so the whole module is tested without a
 * database. src/events/events.ts calls it on every write, and again at
 * publish with the lists of that moment.
 */

export const EVENT_STATUSES = ['draft', 'announced', 'registration', 'checkin', 'live', 'finished', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];
export const ENTRY_KINDS = ['team', 'draft'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];
export const STAGE_TYPES = ['single_elim', 'double_elim', 'round_robin', 'swiss', 'league'] as const;
export type StageType = (typeof STAGE_TYPES)[number];
export const VETO_TYPES = ['ban_to_one', 'home_away', 'pick_ban'] as const;
export type VetoType = (typeof VETO_TYPES)[number];
export const SCHEDULING_KINDS = ['rolling', 'window'] as const;
export type Scheduling = (typeof SCHEDULING_KINDS)[number];

export const NAME_MIN = 3;
export const NAME_MAX = 60;
export const DESCRIPTION_MAX = 4000;
export const CANCEL_REASON_MAX = 300;
export const POOL_MAX = 12;
export const LEAGUE_MATCHES_MAX = 40;
export const STAGES_MAX = 5;
/** The staff-only note on a draft replace (drafts plan D2c Ruling 4). */
export const REPLACE_NOTE_MAX = 200;
/** Words the routes use for themselves, or may later. */
export const RESERVED_EVENT_SLUGS: ReadonlySet<string> = new Set(['new', 'edit', 'mine', 'admin', 'logos', 'banners', 'options']);

export const EVENT_ERRORS = {
  bad_request: { status: 400, text: 'That request is not one this form sends.' },
  missing_fields: { status: 400, text: 'An event needs a name, a start time and an entry kind.' },
  bad_name: { status: 400, text: `An event name is ${NAME_MIN} to ${NAME_MAX} characters of plain text.` },
  name_not_allowed: { status: 400, text: 'That name is not allowed here.' },
  bad_description: { status: 400, text: `The description is at most ${DESCRIPTION_MAX} characters, with no control characters.` },
  bad_start: { status: 400, text: 'The start time is not a date and time.' },
  start_passed: { status: 400, text: 'The start time has to be in the future.' },
  bad_entry_kind: { status: 400, text: 'Entries are teams or a draft.' },
  bad_team_cap: { status: 400, text: 'A team cap is 2 to 256 teams, or none.' },
  bad_eligibility: { status: 400, text: 'Eligibility: minimum PUGs 0 to 1000, and an SR floor below the SR ceiling.' },
  bad_checkin: { status: 400, text: 'Check-in opens 10 to 1440 minutes before the start and closes at least 5 minutes after it opens.' },
  bad_roster: { status: 400, text: 'Roster rules: 4 starters, 0 to 4 subs, and a lock that points at a real stage and round.' },
  bad_stage_type: { status: 400, text: 'A stage is single elimination, double elimination, round robin, Swiss or league.' },
  bad_stage_config: { status: 400, text: 'Those stage settings are out of range.' },
  bad_ruleset: { status: 400, text: 'Pick a ruleset that is not archived.' },
  pug_ruleset: { status: 400, text: 'PUG rules are for PUGs; copy them into a new ruleset for scrims and events.' },
  bad_game_config: { status: 400, text: 'Pick a game config that is turned on.' },
  bad_pool: { status: 400, text: `A campaign pool is 1 to ${POOL_MAX} different campaigns from the poolable list.` },
  bad_pool_for_veto: { status: 400, text: 'The campaign pool is too small for this veto: it needs at least as many campaigns as the veto bans down to.' },
  bad_veto: { status: 400, text: 'Those veto settings do not fit together. Pick a preset, or check the series length, the bans and who picks.' },
  bad_chapters: { status: 400, text: 'Chapters is standard, or 1 to 5.' },
  bad_scheduling: { status: 400, text: 'Scheduling is rolling or in windows.' },
  league_needs_window: { status: 400, text: 'A league stage is played in scheduled windows.' },
  bad_advance: { status: 400, text: 'An advance count is 2 to 128 teams.' },
  bad_chain: { status: 400, text: 'Every stage but the last needs an advance count, smaller than the stage before it and the team cap; the last stage has none.' },
  bad_order: { status: 400, text: 'The new order must list every stage of this event once.' },
  bad_reason: { status: 400, text: `A reason is one line of at most ${CANCEL_REASON_MAX} characters.` },
  no_stages: { status: 409, text: 'Add at least one stage first.' },
  too_many_stages: { status: 409, text: `An event has at most ${STAGES_MAX} stages.` },
  not_found: { status: 404, text: 'No such event.' },
  stage_not_found: { status: 404, text: 'No such stage on this event.' },
  wrong_status: { status: 409, text: 'The event is not at a step that allows that.' },
  stages_locked: { status: 409, text: 'Stages cannot change once the event is live.' },
  kind_locked: { status: 409, text: 'The entry kind can only change while the event is a draft.' },
  bad_draft_times: { status: 400, text: 'A draft event needs a signup close time and a draft night.' },
  draft_times_order: { status: 400, text: 'Signups must close before the draft, and the draft must not be after the event start.' },
  draft_signups_later: { status: 409, text: 'Signups for a draft event arrive with the draft plan.' },
  not_draft: { status: 409, text: 'This event takes team entries, not draft signups.' },
  team_only: { status: 409, text: 'This event takes draft signups, not team entries.' },
  draft_close_passed: { status: 409, text: 'The signup close time has passed; move it later before opening signups.' },
  draft_times_locked: { status: 409, text: 'The cut is published, so the signup close and draft times no longer change.' },
  closed: { status: 409, text: 'Signups for this draft are closed.' },
  already_signed_up: { status: 409, text: 'You are already signed up for this draft.' },
  not_signed_up: { status: 409, text: 'There is no active signup for this draft to change.' },
  bad_note: { status: 400, text: `A note is at most ${NOTE_MAX} characters of plain text, on one line.` },
  bad_captain_pref: { status: 400, text: 'Captaincy is want, willing or no.' },
  ineligible: { status: 409, text: 'You do not meet the entry rules for this event.' },
  cut_published: { status: 409, text: 'The cut is published, so signups no longer change.' },
  not_closed: { status: 409, text: 'Close signups before working on the cut.' },
  bad_team_count: { status: 409, text: 'A draft has at least 2 teams and at most one team per 4 signups.' },
  bad_swap: { status: 409, text: 'A swap moves one pool player to the bench and one bench player into the pool.' },
  cut_changed: { status: 409, text: 'The cut is not ready to publish, or changed since it was built. See the problems listed.' },
  cut_not_published: { status: 409, text: 'Publish the cut before making teams.' },
  teams_made: { status: 409, text: 'The teams are published, so they no longer change.' },
  bad_team_mode: { status: 400, text: 'Teams are made by auto-balance or a live captains\' draft.' },
  not_auto_mode: { status: 409, text: 'Choose Auto-balance before balancing the teams.' },
  teams_not_made: { status: 409, text: "Make and publish the draft's teams first." },
  teams_changed: { status: 409, text: 'The teams no longer match the published cut (a team is short or a player is missing). Rebalance if a pool player is unassigned; a missing player needs staff help.' },
  bad_move: { status: 409, text: 'A move swaps two pool players who are on different teams.' },
  room_started: { status: 409, text: 'The live draft has started. Reset the room on the desk before changing the method or its settings.' },
  live_mode: { status: 409, text: 'Captains are picking these teams live. Undo a pick in the draft room instead of swapping players.' },
  bad_room_settings: { status: 400, text: `First pick is lowest SR, highest SR or random, and the pick clock is ${PICK_SECONDS_MIN} to ${PICK_SECONDS_MAX} seconds.` },
  not_live_mode: { status: 409, text: 'Choose Let captains pick before starting the draft room.' },
  room_not_ready: { status: 409, text: 'The draft room has already started.' },
  room_not_running: { status: 409, text: 'The draft is not running right now.' },
  room_not_paused: { status: 409, text: 'The draft is not paused.' },
  not_your_pick: { status: 403, text: 'It is not your turn to pick.' },
  pick_moved: { status: 409, text: 'That pick was already made. The room has moved on.' },
  not_available: { status: 409, text: 'That player is not in the pool, or was already picked.' },
  no_picks: { status: 409, text: 'There is no pick to undo.' },
  no_delegate: { status: 409, text: 'That captain has not drafted anyone yet, so there is nobody to hand picking to.' },
  bad_captain: { status: 400, text: 'That player is not a captain of this draft.' },
  not_a_captain: { status: 403, text: 'Only a captain of this draft can do that.' },
  lists_closed: { status: 409, text: 'The draft is over, so pick lists no longer change.' },
  bad_list: { status: 400, text: 'A pick list is an ordered list of players from the pool.' },
  draft_not_done: { status: 409, text: 'The live draft is not finished yet.' },
  not_due: { status: 409, text: 'No pick is due yet.' },
  offers_on: { status: 409, text: 'Captaincy offers are already running.' },
  offers_off: { status: 409, text: 'Captaincy offers are not running.' },
  offers_not_needed: { status: 409, text: 'The draft already has a captain for every team.' },
  offer_open: { status: 409, text: 'A captaincy offer is already waiting for an answer.' },
  no_offer: { status: 409, text: 'You have no open captaincy offer for this draft.' },
  offer_expired: { status: 409, text: 'This captaincy offer expired before your answer.' },
  has_entries: { status: 409, text: 'This draft has entries, so it cannot be deleted.' },
  bad_entry_roster: { status: 400, text: 'A roster is exactly 4 starters, no more subs than the event allows and at most one coach, each player once.' },
  not_registration: { status: 409, text: 'Registration is not open for this event.' },
  team_not_found: { status: 404, text: 'No such team.' },
  not_manager: { status: 403, text: 'Only the team captain or a co-captain can do that.' },
  already_entered: { status: 409, text: 'This team already has an entry in this event.' },
  not_on_team: { status: 400, text: 'Everyone added to the roster has to be on the team.' },
  player_ineligible: { status: 409, text: 'Someone on the roster does not meet the entry rules.' },
  player_entered: { status: 409, text: 'Someone on the roster is already on another entry in this event.' },
  entry_not_found: { status: 404, text: 'No such entry in this event.' },
  entry_out: { status: 409, text: 'This entry is no longer in the event.' },
  roster_locked: { status: 409, text: 'Rosters are locked for this event; ask staff to change yours.' },
  additions_used: { status: 409, text: 'This entry has used all the roster additions the event allows.' },
  not_on_entry: { status: 400, text: 'You are not on this roster.' },
  bad_entry_name: { status: 400, text: 'A team name is 3 to 24 characters of plain text, with at least one letter or digit.' },
  not_draft_entry: { status: 409, text: 'Only a draft entry has a name, tag and logo of its own.' },
  not_captain: { status: 403, text: 'Only the entry\'s captain can do that.' },
  name_taken: { status: 409, text: 'Another entry in this event already has that name.' },
  bad_tag: { status: 400, text: 'A tag is 2 to 5 letters or digits.' },
  tag_not_allowed: { status: 400, text: 'That tag is not allowed here.' },
  entries_locked: { status: 409, text: 'The entry list is final now.' },
  identity_locked: { status: 409, text: 'Team names and logos are final once the event is live.' },
  no_checkin: { status: 409, text: 'This event has no check-in.' },
  not_checkin: { status: 409, text: 'Check-in is not open.' },
  need_starters: { status: 409, text: 'Check-in needs 4 starters on the roster.' },
  seeds_locked: { status: 409, text: 'Seeds can change only once the entry list is final and before the event goes live.' },
  bad_seed_order: { status: 400, text: 'The new seed order must list every seeded entry once.' },
  not_restorable: { status: 409, text: 'Only a dropped or disqualified entry can be restored, before the entry list is final.' },
  list_not_final: { status: 409, text: 'The entry list is not final yet.' },
  too_few_entries: { status: 409, text: 'A stage needs at least 2 teams to start.' },
  not_live: { status: 409, text: 'That stage is not being played.' },
  match_not_found: { status: 404, text: 'No such match in this event.' },
  match_not_open: { status: 409, text: 'That match does not have two teams to report on yet.' },
  bad_result: { status: 400, text: 'A result names the winner and gives both campaign scores with the winner ahead, or is a forfeit.' },
  result_locked: { status: 409, text: 'Later matches already depend on this result, so it can no longer be changed here.' },
  winner_out: { status: 409, text: 'That team is out of the event, so it cannot win a match.' },
  changed: { status: 409, text: 'The event changed while this was being saved. Reload and try again.' },
  elim_not_last: { status: 400, text: 'An elimination bracket is always the last stage.' },
  bad_group_advance: { status: 400, text: 'With groups, the advance count has to split evenly across the groups.' },
  entry_busy: { status: 409, text: 'One of these teams is already in another match room.' },
  not_ready_phase: { status: 409, text: 'This match is not waiting for teams to ready up.' },
  room_closed: { status: 409, text: 'The ready check for this match has closed.' },
  already_ready: { status: 409, text: 'Your team is already ready.' },
  not_veto_phase: { status: 409, text: 'The veto is not running for this match.' },
  step_taken: { status: 409, text: 'That step was already taken. The room has moved on.' },
  not_your_turn: { status: 409, text: 'It is the other team\'s turn.' },
  bad_veto_action: { status: 400, text: 'That is not a choice this step allows.' },
  not_lineup_phase: { status: 409, text: 'Lineups are not open for this match.' },
  lineup_locked: { status: 409, text: 'Your lineup is already locked.' },
  bad_lineup: { status: 400, text: 'A lineup is exactly four different players from your starters and subs.' },
  bad_prefs: { status: 400, text: 'Preferences: a default four from your starters and subs (or none), a side, and campaigns from each stage\'s pool, each once.' },
  room_open_downstream: { status: 409, text: 'A later match already has its match room open; reset that room first.' },
  booking_open: { status: 409, text: 'This match still holds a server booking. Cancel it first (Reset room does).' },
  not_connect_phase: { status: 409, text: 'This match is not waiting for the teams to connect.' },
  not_live_phase: { status: 409, text: 'This match is not being played.' },
  not_confirm_phase: { status: 409, text: 'This match is not in its confirm window.' },
  confirm_closed: { status: 409, text: 'The confirm window for this match has closed.' },
  game_not_found: { status: 404, text: 'No such game in this match.' },
  already_confirmed: { status: 409, text: 'Your team has already confirmed the result.' },
  game_started: { status: 409, text: 'A game of this match was already sent to a server; reset the room or enter the result instead.' },
  hold_not_releasable: { status: 409, text: 'This hold cannot be released to where it came from (the server is gone, the game on it was aborted or lost, or the hold predates release). Enter the result or reset the room.' },
  not_held: { status: 409, text: 'This match is not on hold.' },
  not_in_lineup: { status: 400, text: 'That player is not in a locked lineup of this match.' },
  sub_not_member: { status: 400, text: 'A sub must be a starter or sub of the same entry who is not already playing.' },
  sub_limit: { status: 409, text: 'That team has used every substitution the rules allow for this match.' },
  bad_minutes: { status: 400, text: 'Minutes is a whole number from 1 to 60.' },
  no_live_game: { status: 409, text: 'No game of this match is being played right now.' },
  chapter_not_replayable: { status: 409, text: 'That chapter cannot be replayed (the finale, or a chapter this game has not reached).' },
  no_box: { status: 409, text: 'This match has no running server to send that to.' },
  replay_failed: { status: 502, text: 'The server did not take the replay. The game was aborted and the match is on hold.' },
  replay_no_answer: { status: 502, text: 'The server did not answer the replay. Nothing was aborted and the game is still live on the site; try again, or move the match to another server.' },
  cannot_move_finale: { status: 409, text: 'The game is on its finale, which cannot be restored on another server. Let it finish, or reset the room.' },
  replay_dropped: { status: 502, text: 'The server dropped the game while replaying; it is being restored at its current chapter, and the freeze was lifted. Replay the chapter again once it is back.' },
  not_frozen: { status: 409, text: 'The game is not frozen.' },
  already_frozen: { status: 409, text: 'The game is already frozen.' },
  bad_side: { status: 400, text: 'A side is a or b.' },
  pause_not_found: { status: 404, text: 'No such technical pause in this match.' },
  already_penalized: { status: 409, text: 'Staff already ruled on this technical pause.' },
  bad_penalty: { status: 400, text: 'A penalty is a warning or a forfeit of the game.' },
  emergency_off: { status: 409, text: 'Emergency subs are off in this event: subs are made between chapters.' },
  captain_replace: { status: 409, text: 'That player is the team\'s captain. Make another player captain first (Make captain), then replace this player.' },
  already_captain: { status: 409, text: 'That player is already the captain.' },
  replace_in_game: { status: 409, text: 'That player is in a game on a server and the server did not take the change. Use the in-game tools first (the staff freeze, !sub), or try again between chapters.' },
  replace_not_possible: { status: 409, text: 'The match is not in a state where a player can be swapped right now; the detail says why.' },
  replace_not_starter: { status: 409, text: 'That player is not a starter of this team.' },
  replace_ineligible: { status: 409, text: 'The replacement does not meet this event\'s entry rules.' },
  replace_bad_note: { status: 400, text: `A staff note is at most ${REPLACE_NOTE_MAX} characters of plain text, on one line.` },
  replace_not_draft: { status: 409, text: 'Only a player on a draft team can be replaced.' },
  replace_bad_reason: { status: 400, text: 'A reason is one of: conduct, cheating, no-show, left the event, other.' },
  bad_schedule: { status: 400, text: 'A round schedule lists rounds, each with a default time and, on a window stage, a window that starts before it ends and holds the default time; a rolling stage takes a date only.' },
  schedule_locked: { status: 409, text: 'The schedule of a finished stage or event cannot change.' },
  not_schedulable: { status: 409, text: 'This match cannot be rescheduled now: it is not waiting in a window stage with a scheduling window, or its window has passed.' },
  bad_time: { status: 400, text: 'A proposed time is a date and time inside the match window, at least an hour ahead, and not the time already set.' },
  proposal_open: { status: 409, text: 'A proposal is already open for this match. Answer it or withdraw it first.' },
  no_proposal: { status: 409, text: 'There is no open proposal for this match.' },
  own_proposal: { status: 409, text: 'The other team answers your proposal. You can withdraw it.' },
  not_your_proposal: { status: 409, text: 'Only the team that made the proposal can withdraw it.' },
} as const satisfies Record<string, { status: number; text: string }>;
export type EventError = keyof typeof EVENT_ERRORS;

/** One player a roster refusal is about, with the sentences of what is wrong
 *  (src/events/entryRules.ts problemText). The routes add the player's name. */
export interface EntryProblem { steamid: string; problems: string[] }
export type Checked<T> = { ok: true; value: T } | { ok: false; error: EventError; detail?: EntryProblem[] };
export const ok = <T>(value: T): Checked<T> => ({ ok: true, value });
export const fail = (error: EventError, detail?: EntryProblem[]): { ok: false; error: EventError; detail?: EntryProblem[] } =>
  (detail ? { ok: false, error, detail } : { ok: false, error });

export interface Eligibility { minPugs: number; requireDiscord: boolean; srFloor: number | null; srCeiling: number | null }
export interface Checkin { enabled: boolean; opensMinutes: number; closesMinutes: number }
export type RosterLock = { kind: 'none' } | { kind: 'at'; at: string } | { kind: 'after_round'; stage: number; round: number };
export interface RosterRules { starters: 4; maxSubs: number; lock: RosterLock; maxAdditions: number | null }

export interface StageConfigs {
  single_elim: { thirdPlace: boolean };
  double_elim: { grandFinalReset: boolean };
  round_robin: { groups: number };
  swiss: { rounds: number };
  league: { matches: number; matchesPerWeek: number; pairing: 'swiss' | 'round_robin'; seasonStart: string | null };
}
export type StageConfig = StageConfigs[StageType];

export interface StageSettings {
  type: StageType; config: StageConfig; rulesetId: number; gameConfig: string; campaignPool: string[];
  vetoType: VetoType; veto: VetoConfig; chapters: number | null; scheduling: Scheduling; advanceCount: number | null;
}

/** One round's schedule (plan T4 Ruling 2): the default time, and on a
 *  window stage the window it sits in; on a rolling stage a date only,
 *  stamped as the round's not_before (Ruling 3). ISO UTC strings. */
export interface RoundSchedule { round: number; at: string | null; from: string | null; to: string | null }
export const SCHEDULE_ROUNDS_MAX = 60;
export interface StageContext {
  campaigns: ReadonlySet<string>; rulesetIds: ReadonlySet<number>; pugRulesetId: number | null;
  gameConfigs: ReadonlySet<string>; defaultPool: string[];
}
/** A draft-kind event's two times (plan D1 Ruling 3), ISO UTC. */
export interface DraftFields { signupsCloseAt: string; draftAt: string }
export interface EventFields {
  name: string; startsAt: string; entryKind: EntryKind; official: boolean; teamCap: number | null; description: string;
  eligibility: Eligibility; checkin: Checkin; roster: RosterRules;
  /** Null for a team event. */
  draft: DraftFields | null;
}

export const SCORE_MAX = 100000;
/** A match result as an admin enters it (plan T2 Ruling 1). */
export interface ResultInput { winner: 'a' | 'b'; scoreA: number | null; scoreB: number | null; forfeit: boolean }

export const defaultEligibility = (): Eligibility => ({ minPugs: 5, requireDiscord: true, srFloor: null, srCeiling: null });
export const defaultCheckin = (): Checkin => ({ enabled: true, opensMinutes: 60, closesMinutes: 15 });
export const defaultRoster = (): RosterRules => ({ starters: 4, maxSubs: 2, lock: { kind: 'none' }, maxAdditions: null });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/** Winner a or b. A forfeit carries no scores (any sent are dropped);
 *  otherwise both scores are integers 0..SCORE_MAX with the winner strictly
 *  ahead, as ties are replayed (spec section 3). */
export function parseResult(raw: unknown): Checked<ResultInput> {
  if (!isObj(raw) || (raw.winner !== 'a' && raw.winner !== 'b')) return fail('bad_result');
  const forfeit = raw.forfeit ?? false;
  if (typeof forfeit !== 'boolean') return fail('bad_result');
  if (forfeit) return ok({ winner: raw.winner, scoreA: null, scoreB: null, forfeit: true });
  if (!isInt(raw.scoreA, 0, SCORE_MAX) || !isInt(raw.scoreB, 0, SCORE_MAX)) return fail('bad_result');
  const ahead = raw.winner === 'a' ? raw.scoreA > raw.scoreB : raw.scoreB > raw.scoreA;
  return ahead ? ok({ winner: raw.winner, scoreA: raw.scoreA, scoreB: raw.scoreB, forfeit: false }) : fail('bad_result');
}

/** null (or absent) is null; an integer in range is itself; anything else undefined. */
const intOrNull = (v: unknown, min: number, max: number): number | null | undefined =>
  v === null || v === undefined ? null : isInt(v, min, max) ? v : undefined;
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

/** An ISO date and time with a zone (Z or +HH:MM / -HH:MM), as UTC; null
 *  for anything else. A time with no zone is refused, not read in the
 *  server's own zone. */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
export function parseTime(v: unknown): string | null {
  if (typeof v !== 'string' || !ISO_WITH_ZONE.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function normalizeEventName(raw: unknown): Checked<string> {
  if (typeof raw !== 'string') return fail('bad_name');
  const name = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (name.length < NAME_MIN || name.length > NAME_MAX || hasUnsafeChars(name) || DEFAULT_IGNORABLE.test(name) || !/[\p{L}\p{N}]/u.test(name)) {
    return fail('bad_name');
  }
  if (findSlurs(name).length > 0) return fail('name_not_allowed');
  return ok(name);
}

/** Stored as typed, line breaks kept; the web formats it with the safe
 *  markdown subset (Ruling 1), so nothing here interprets it. */
export function normalizeDescription(raw: unknown): Checked<string> {
  if (raw === undefined || raw === null) return ok('');
  if (typeof raw !== 'string') return fail('bad_description');
  const text = raw.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  if (text.length > DESCRIPTION_MAX || hasUnsafeChars(text, true)) return fail('bad_description');
  return ok(text);
}

export function normalizeReason(raw: unknown): Checked<string | null> {
  if (raw === undefined || raw === null) return ok(null);
  if (typeof raw !== 'string') return fail('bad_reason');
  const text = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (text.length > CANCEL_REASON_MAX || hasUnsafeChars(text)) return fail('bad_reason');
  return ok(text === '' ? null : text);
}

/** The slug a name would like; src/events/events.ts makes it unique. */
export function eventSlugBase(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 48).replace(/-+$/, '') || 'event';
}

export function parseEligibility(raw: unknown): Checked<Eligibility> {
  if (raw === undefined) return ok(defaultEligibility());
  if (!isObj(raw)) return fail('bad_eligibility');
  const d = defaultEligibility();
  const minPugs = raw.minPugs ?? d.minPugs;
  const requireDiscord = raw.requireDiscord ?? d.requireDiscord;
  const srFloor = intOrNull(raw.srFloor, 0, 10000);
  const srCeiling = intOrNull(raw.srCeiling, 0, 10000);
  if (!isInt(minPugs, 0, 1000) || typeof requireDiscord !== 'boolean' || srFloor === undefined || srCeiling === undefined) {
    return fail('bad_eligibility');
  }
  if (srFloor !== null && srCeiling !== null && srFloor >= srCeiling) return fail('bad_eligibility');
  return ok({ minPugs, requireDiscord, srFloor, srCeiling });
}

export function parseCheckin(raw: unknown): Checked<Checkin> {
  if (raw === undefined) return ok(defaultCheckin());
  if (!isObj(raw)) return fail('bad_checkin');
  const d = defaultCheckin();
  const enabled = raw.enabled ?? d.enabled;
  const opensMinutes = raw.opensMinutes ?? d.opensMinutes;
  const closesMinutes = raw.closesMinutes ?? d.closesMinutes;
  if (typeof enabled !== 'boolean' || !isInt(opensMinutes, 10, 1440) || !isInt(closesMinutes, 0, 1440)) return fail('bad_checkin');
  if (closesMinutes > opensMinutes - 5) return fail('bad_checkin');
  return ok({ enabled, opensMinutes, closesMinutes });
}

function parseLock(raw: unknown): RosterLock | null {
  if (raw === undefined) return { kind: 'none' };
  if (!isObj(raw)) return null;
  if (raw.kind === 'none') return { kind: 'none' };
  if (raw.kind === 'at') {
    const at = parseTime(raw.at);
    return at ? { kind: 'at', at } : null;
  }
  if (raw.kind === 'after_round') {
    const stage = raw.stage;
    const round = raw.round;
    return isInt(stage, 1, STAGES_MAX) && isInt(round, 1, 20) ? { kind: 'after_round', stage, round } : null;
  }
  return null;
}

export function parseRoster(raw: unknown): Checked<RosterRules> {
  if (raw === undefined) return ok(defaultRoster());
  if (!isObj(raw)) return fail('bad_roster');
  if ((raw.starters ?? 4) !== 4) return fail('bad_roster');
  const maxSubs = raw.maxSubs ?? defaultRoster().maxSubs;
  const maxAdditions = intOrNull(raw.maxAdditions, 0, 20);
  const lock = parseLock(raw.lock);
  if (!isInt(maxSubs, 0, 4) || maxAdditions === undefined || lock === null) return fail('bad_roster');
  return ok({ starters: 4, maxSubs, lock, maxAdditions });
}

/**
 * A whole EventFields from a request body. With base null it is a create:
 * name, startsAt and entryKind are required and the rest take their
 * defaults. With a base it is an edit: only the keys present change.
 */
export function parseEventFields(raw: unknown, base: EventFields | null): Checked<EventFields> {
  if (!isObj(raw)) return fail('bad_request');
  const has = (k: string) => raw[k] !== undefined;
  if (!base && (!has('name') || !has('startsAt') || !has('entryKind'))) return fail('missing_fields');
  const out: EventFields = base ? { ...base } : {
    name: '', startsAt: '', entryKind: 'team', official: true, teamCap: null, description: '',
    eligibility: defaultEligibility(), checkin: defaultCheckin(), roster: defaultRoster(), draft: null,
  };
  if (has('name')) {
    const r = normalizeEventName(raw.name);
    if (!r.ok) return r;
    out.name = r.value;
  }
  if (has('startsAt')) {
    const t = parseTime(raw.startsAt);
    if (!t) return fail('bad_start');
    out.startsAt = t;
  }
  if (has('entryKind')) {
    const k = raw.entryKind;
    if (!oneOf(ENTRY_KINDS, k)) return fail('bad_entry_kind');
    out.entryKind = k;
  }
  if (has('official')) {
    const o = raw.official;
    if (typeof o !== 'boolean') return fail('bad_request');
    out.official = o;
  }
  if ('teamCap' in raw && out.entryKind !== 'draft') {
    const c = intOrNull(raw.teamCap, 2, 256);
    if (c === undefined) return fail('bad_team_cap');
    out.teamCap = c;
  }
  if (has('description')) {
    const r = normalizeDescription(raw.description);
    if (!r.ok) return r;
    out.description = r.value;
  }
  if (has('eligibility')) {
    const r = parseEligibility(raw.eligibility);
    if (!r.ok) return r;
    out.eligibility = r.value;
  }
  if (has('checkin')) {
    const r = parseCheckin(raw.checkin);
    if (!r.ok) return r;
    out.checkin = r.value;
  }
  if (has('roster')) {
    const r = parseRoster(raw.roster);
    if (!r.ok) return r;
    out.roster = r.value;
  }
  if (out.entryKind !== 'draft') {
    out.draft = null;
  } else {
    // A draft's team count comes from the cut, so no cap applies, whatever was sent.
    out.teamCap = null;
    if (has('draft')) {
      const d = raw.draft;
      const close = isObj(d) ? parseTime(d.signupsCloseAt) : null;
      const at = isObj(d) ? parseTime(d.draftAt) : null;
      if (!close || !at) return fail('bad_draft_times');
      out.draft = { signupsCloseAt: close, draftAt: at };
    }
    if (!out.draft) return fail('bad_draft_times');
    if (out.draft.signupsCloseAt > out.draft.draftAt || out.draft.draftAt > out.startsAt) return fail('draft_times_order');
  }
  return ok(out);
}

/** A real calendar day written YYYY-MM-DD. Day 30 of February parses but
 *  rolls over to March, so the round trip refuses it; month 13 does not
 *  parse at all. Never throws. */
function isDay(v: unknown): boolean {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00.000Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}

export function parseStageConfig(type: StageType, raw: unknown): Checked<StageConfig> {
  const c = raw === undefined ? {} : raw;
  if (!isObj(c)) return fail('bad_stage_config');
  switch (type) {
    case 'single_elim': {
      const thirdPlace = c.thirdPlace ?? false;
      return typeof thirdPlace === 'boolean' ? ok({ thirdPlace }) : fail('bad_stage_config');
    }
    case 'double_elim': {
      const grandFinalReset = c.grandFinalReset ?? true;
      return typeof grandFinalReset === 'boolean' ? ok({ grandFinalReset }) : fail('bad_stage_config');
    }
    case 'round_robin': {
      const groups = c.groups ?? 1;
      return isInt(groups, 1, 8) ? ok({ groups }) : fail('bad_stage_config');
    }
    case 'swiss': {
      const rounds = c.rounds ?? 4;
      return isInt(rounds, 1, 9) ? ok({ rounds }) : fail('bad_stage_config');
    }
    case 'league': {
      const matches = c.matches ?? 16;
      const matchesPerWeek = c.matchesPerWeek ?? 1;
      const pairing = c.pairing ?? 'swiss';
      const seasonStart = c.seasonStart ?? null;
      return isInt(matches, 1, LEAGUE_MATCHES_MAX) && isInt(matchesPerWeek, 1, 3) && oneOf(['swiss', 'round_robin'] as const, pairing)
        && (seasonStart === null || isDay(seasonStart))
        ? ok({ matches, matchesPerWeek, pairing, seasonStart: seasonStart as string | null })
        : fail('bad_stage_config');
    }
  }
}

export function parsePool(raw: unknown, allowed: ReadonlySet<string>): Checked<string[]> {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > POOL_MAX) return fail('bad_pool');
  const out: string[] = [];
  for (const c of raw) {
    if (typeof c !== 'string' || !allowed.has(c) || out.includes(c)) return fail('bad_pool');
    out.push(c);
  }
  return ok(out);
}

/** A stage's round schedule as the desk sends it. A row with nothing set
 *  clears that round and is dropped; rounds come back sorted. On a window
 *  stage a default time comes with its window, except on a league, whose
 *  week is the window when a row names none (play.ts roundTimes). */
export function parseRoundSchedule(raw: unknown, scheduling: Scheduling, o: { league?: boolean } = {}): Checked<RoundSchedule[]> {
  if (!Array.isArray(raw) || raw.length > SCHEDULE_ROUNDS_MAX) return fail('bad_schedule');
  const time = (v: unknown): string | null | undefined => (v === null || v === undefined ? null : parseTime(v) ?? undefined);
  const out: RoundSchedule[] = [];
  const seen = new Set<number>();
  for (const row of raw) {
    if (!isObj(row) || !isInt(row.round, 1, 999) || seen.has(row.round)) return fail('bad_schedule');
    seen.add(row.round);
    const at = time(row.at);
    const from = time(row.from);
    const to = time(row.to);
    if (at === undefined || from === undefined || to === undefined) return fail('bad_schedule');
    if (scheduling === 'rolling' && (from !== null || to !== null)) return fail('bad_schedule');
    if ((from === null) !== (to === null)) return fail('bad_schedule');
    if (scheduling === 'window' && !o.league && at !== null && from === null) return fail('bad_schedule');
    if (from !== null && to !== null && (from >= to || (at !== null && (at < from || at > to)))) return fail('bad_schedule');
    if (at === null && from === null) continue;
    out.push({ round: row.round, at, from, to });
  }
  return ok(out.sort((x, y) => x.round - y.round));
}

export function parseStage(raw: unknown, ctx: StageContext): Checked<StageSettings> {
  if (!isObj(raw)) return fail('bad_request');
  const type = raw.type;
  if (!oneOf(STAGE_TYPES, type)) return fail('bad_stage_type');
  const config = parseStageConfig(type, raw.config);
  if (!config.ok) return config;
  const rulesetId = raw.rulesetId;
  if (ctx.pugRulesetId !== null && rulesetId === ctx.pugRulesetId) return fail('pug_ruleset');
  if (!Number.isInteger(rulesetId) || !ctx.rulesetIds.has(rulesetId as number)) return fail('bad_ruleset');
  const gameConfig = raw.gameConfig ?? 'standard';
  if (typeof gameConfig !== 'string' || !ctx.gameConfigs.has(gameConfig)) return fail('bad_game_config');
  const pool = parsePool(raw.campaignPool ?? ctx.defaultPool, ctx.campaigns);
  if (!pool.ok) return pool;
  // Plan T3a: knobs win; a preset name (the T2 desk sends vetoType) is
  // filled from the pool size; nothing at all is ban to one.
  let veto: VetoConfig;
  if (raw.veto !== undefined) {
    const v = parseVetoConfig(raw.veto, pool.value.length);
    if (!v.ok) return fail(v.error);
    veto = v.value;
  } else {
    const name = raw.vetoType ?? 'ban_to_one';
    if (!oneOf(VETO_PRESETS, name)) return fail('bad_veto');
    if (pool.value.length < PRESET_MIN_POOL[name as VetoPreset]) return fail('bad_pool_for_veto');
    veto = presetConfig(name as VetoPreset, pool.value.length);
  }
  const vetoType = vetoFamily(veto);
  const chapters = intOrNull(raw.chapters, 1, 5);
  if (chapters === undefined) return fail('bad_chapters');
  const scheduling = raw.scheduling ?? (type === 'league' ? 'window' : 'rolling');
  if (!oneOf(SCHEDULING_KINDS, scheduling)) return fail('bad_scheduling');
  if (type === 'league' && scheduling !== 'window') return fail('league_needs_window');
  const advanceCount = intOrNull(raw.advanceCount, 2, 128);
  if (advanceCount === undefined) return fail('bad_advance');
  if (type === 'round_robin' && advanceCount !== null && advanceCount % (config.value as StageConfigs['round_robin']).groups !== 0) {
    return fail('bad_group_advance');
  }
  return ok({
    type, config: config.value, rulesetId: rulesetId as number, gameConfig, campaignPool: pool.value,
    vetoType, veto, chapters, scheduling, advanceCount,
  });
}

/** The chain of stages as a whole (Ruling 16): checked at publish and at
 *  open registration, not on every edit. */
export function checkChain(stages: { type?: StageType; advanceCount: number | null }[], o: { teamCap: number | null; roster: RosterRules }): Checked<null> {
  if (stages.length === 0) return fail('no_stages');
  for (let i = 0; i < stages.length; i++) {
    const t = stages[i].type;
    if (i < stages.length - 1 && (t === 'single_elim' || t === 'double_elim')) return fail('elim_not_last');
    const a = stages[i].advanceCount;
    if (i === stages.length - 1) {
      if (a !== null) return fail('bad_chain');
      continue;
    }
    if (a === null) return fail('bad_chain');
    const before = i > 0 ? stages[i - 1].advanceCount : null;
    if (before !== null && a >= before) return fail('bad_chain');
    if (o.teamCap !== null && a >= o.teamCap) return fail('bad_chain');
  }
  if (o.roster.lock.kind === 'after_round' && o.roster.lock.stage > stages.length) return fail('bad_roster');
  return ok(null);
}

export const EVENT_EDITABLE: ReadonlySet<EventStatus> = new Set<EventStatus>(['draft', 'announced', 'registration']);
export const STAGES_LOCKED: ReadonlySet<EventStatus> = new Set<EventStatus>(['live', 'finished', 'cancelled']);

/** Where an event can be cancelled from. Never a draft: nobody outside
 *  staff has seen it, so it is deleted instead (deleteDraftEvent), and a
 *  cancelled event is public under Past. */
const CANCELLABLE: ReadonlySet<EventStatus> = new Set<EventStatus>(['announced', 'registration', 'checkin', 'live']);

/** The moves made so far: T1a's publish, open registration and cancel,
 *  T1b's open check-in, and T2's going live from registration or check-in
 *  and finishing once live. */
export function nextStatusAllowed(from: EventStatus, to: EventStatus): boolean {
  if (to === 'cancelled') return CANCELLABLE.has(from);
  return (from === 'draft' && to === 'announced') || (from === 'announced' && to === 'registration')
    || (from === 'registration' && to === 'checkin')
    || ((from === 'registration' || from === 'checkin') && to === 'live')
    || (from === 'live' && to === 'finished');
}
