# Tournaments plan T3a: the match room (ready check, veto, lineup lock)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Once both teams of a tournament match are known, a match room opens on the site. Both teams get a DM. A captain or co-captain of each team presses Ready within 10 minutes; a team that does not loses by forfeit. Then the teams run the stage's veto live: bans, picks and side choices, each on a 60 second timer that acts from the captain's saved preferences when it runs out. Then each captain locks a lineup of 4 from the roster, hidden from the other team until both are in. The match then waits for its server: staff set the server up and enter the result by hand, as in T2, until rollout plan T3b books servers and reads results automatically. Every stage gets veto settings: four presets plus every knob (owner, 2026-10-06).

**Architecture:** Two new pure modules. `vetoConfig.ts` holds a stage's veto settings, the presets, their validation and their one-line summary, and is shared with the web stage editor. `veto.ts` is the step engine: it replays a match's stored veto actions over the stage's settings and answers what has been decided and whose turn it is next. A new writer, `room.ts`, owns the room columns of `event_matches` and the new tables (`event_vetoes`, `event_games`, `event_lineups`, `event_entry_prefs`, `event_campaign_prefs`). Like `events.ts`, `entries.ts` and `play.ts`, each mutation is one transaction with exactly one `event_log` row. A new `RoomClock` runs every 5 seconds: it opens rooms for rolling stages, and acts on every deadline that has passed (ready forfeits, automatic veto steps, automatic lineups). A forfeit goes through the T2 flow (`forfeitMatch` in `flow.ts`), so the bracket advances in the same way as an admin result. Browsers of the two teams and staff hear a hub event `event_room` on every change; other viewers poll.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Fastify 5, better-sqlite3, vitest (`npm test`, `npx vitest run <file>`), `npm run typecheck` (server and web), `npm run build`; Preact + preact-iso + @testing-library/preact (happy-dom) for the web. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-30-competitive-tournaments-design.md`, section 4 (match flow: states, start time, veto room, lineup lock, no-show for the ready check), Error handling (timers re-armed from stored deadlines), Testing (veto step engine for every type with timeouts), Rollout item 3 (first third). T2 (`docs/superpowers/plans/2026-10-05-tournaments-2-brackets.md`) built `event_matches`, `play.ts`, `flow.ts`, the runner and the desk's Play section this plan extends. Read its "Rulings" first, then this plan's.

## Global Constraints

- Team events only (`entry_kind = 'team'`).
- Every write to `events`, `event_stages` and `event_log` stays in `src/events/events.ts`; `event_entries` and `event_entry_players` in `src/events/entries.ts`; `event_matches` in `src/events/play.ts` and, from this plan, `src/events/room.ts` (room columns and room statuses only). The new tables are written only by `src/events/room.ts`. Every mutation in those files is one transaction that writes exactly one `event_log` row on success and nothing on refusal (`tests/eventLogGuard.test.ts`). Admin routes also `logAdmin`.
- The ready check, veto and lineup run only for stages with `scheduling = 'rolling'` on their own. A window stage (leagues) opens a room only when an admin presses Open room (rollout plan 4 adds windows).
- Public routes follow `competitive_enabled` exactly as T1a's do. A draft is a 404 to anyone but staff.
- Lineups are secret until both are locked: no route, view, DM, log detail or hub event may carry a lineup's players before then, except to that team's own roster and to staff.
- Preferences (campaign order, side, default four) are never shown to anyone but the team's managers and staff.
- Never write em dashes in code, comments, copy, commits or docs.
- Commit messages follow the repo style (a plain sentence). Do not push. Do not deploy, restart, stage or rcon any live box.
- Several Claude sessions use `/home/volence/l4d/pug`: work in a worktree branch (`tournaments-t3a`, made with superpowers:using-git-worktrees). Run `npm ci` inside the worktree (never symlink `node_modules`). Check `git reflog -10` and `git status` before any write on master.

## Rulings this plan makes (for the owner to confirm)

1. **Three plans (owner, 2026-10-06).** T3a: the match room (this plan). T3b: booking, connect, automatic results, no-show on the server, tiebreak games, between-game picks, the confirm window and disputes. T3c: in-game `!sub` and `!admin`, and the desk tools (replay a chapter, reopen the veto, move server).
2. **Ready check (owner, 2026-10-06).** In a rolling stage, a match's room opens as soon as both teams are known, its `not_before` (if any) has passed, and neither team is in another open room. A team plays its matches in order: its earliest unplayed match of the stage (round, then group, then slot) opens first. Both teams' rosters (starters, subs and coach) get a DM. A captain or co-captain of each team presses Ready within `event_ready_minutes` (setting, default 10). At the deadline: if exactly one team is ready, it wins by forfeit; if neither is, the match goes to admin hold for staff.
3. **Veto settings per stage (owner, 2026-10-06: "having defaults is nice but so is versatility").** A stage's veto is a set of knobs: series length (Bo1, Bo2 total score, Bo3, Bo5), ban down to N campaigns, who bans first (higher seed chooses first or second, higher seed, lower seed, coin), who picks game 1 (higher seed, lower seed, the team that went first, the team that went second, coin), later games (loser of the previous game picks, or the teams take turns), extra bans before the last game (taking turns only), and sides (the team that did not pick chooses, higher seed chooses, coin). Four presets fill the knobs: **Ban to one** (Bo1), **Home and away** (Bo2 total score, each team picks one), **Pick and ban** (Bo3, ban ban pick pick ban ban, decider), **Ban to three, loser picks** (Bo3: bans down to 3, the higher seed picks game 1, the loser of each game picks the next from what is left, the last one is the decider). Editing a knob after picking a preset makes it Custom.
4. **Bo2 is always total score**, so "loser picks" is refused there (there is no game loser). A tie on total score is T3b's tiebreak game.
5. **Higher seed.** In an elimination bracket, the better stage seed (the order teams entered the stage). In Swiss, a league or round robin, the better current standing when the room opens, then the stage seed.
6. **Sides.** "The team that did not pick chooses" means: for a picked campaign, the other team; for a decider (the last campaign left), the team that did not make the last ban, as the spec says; with no bans at all, the higher seed. The chooser picks survivors first or infected first. "Coin" decides who starts as survivors directly, with no step.
7. **Timers act from preferences.** Every veto step has `event_veto_step_seconds` (setting, default 60). On timeout the room acts for the team from its saved campaign order for this stage (most wanted first; campaigns not in the list come after, in pool order): a ban takes the least wanted campaign left, a pick the most wanted, a side choice the saved side or survivors first, and "first or second" goes first. The log marks these as automatic.
8. **Loser picks happen between games.** With "loser picks", the room settles game 1 (bans, its pick, its sides) and then the lineups. Game 2's pick needs game 1's result, so it is a short pick step between games, which T3b adds when games are played on our servers. In T3a such a match shows "Game 2 is picked after game 1" and an admin enters the whole match result as in T2.
9. **Lineups.** After the veto, each captain or co-captain picks exactly 4 from the team's starters and subs (never the coach) within `event_lineup_minutes` (setting, default 5). Lineups are hidden until both are locked, then shown to everyone. On timeout the room uses the team's default four (set by a manager on the event page) if all four are still on the roster, else the last four that team locked in this event, else its starters (then subs) in roster order. A team with fewer than 4 players left goes to admin hold.
10. **Who acts.** The team's captain and co-captains (`managersOf`) press Ready, act in the veto, lock the lineup and save preferences. Staff watch every room; they do not act for a team in T3a (T3c's desk tools reopen a veto).
11. **After the lineups, the match waits for its server** (status `booking`, shown as "Lineups locked. Waiting for the server"). In T3a staff set the server up by hand (a scrim booking between the two teams, or any server) with the campaign, sides and lineups the room shows, and enter the result on the desk. T3b replaces this.
12. **Admins can enter a result at any point of the room** (ready, veto, lineup, waiting for the server, hold). The room closes. A forfeit or result is never taken from a match whose room is mid-flight by the clock: the clock's ready forfeit checks the match is still in the same state inside the event's chain.
13. **Admin tools in T3a.** On the desk's Play section: Open room (any waiting match with both teams, including window stages), Reset room (back to waiting: clears ready, veto, games and lineups; a rolling stage reopens it within 5 seconds, with new DMs), Hold (put a match on admin hold with a reason). A held match is released by Reset room or by entering a result.
14. **A correction upstream cannot change the teams of a match whose room is open.** It is refused ("A later match already has its match room open; reset that room first."). A bracket sync otherwise keeps a room's status (a ready bracket match stays `veto`, `lineup` or `booking`, never drops back to `waiting`).
15. **Disqualification.** A team disqualified while a room of theirs is open forfeits that match on the next settle, exactly like a waiting one (T2 Ruling 9 widened).
16. **Restart.** Deadlines live in the database. When the web starts, every room deadline that already passed is moved to now plus that phase's full length, so downtime never forfeits or auto-acts for a team. Then the 5 second clock carries on.
17. **Live updates.** Every room change sends the hub event `event_room` to the two teams' rosters and to staff only (the root socket refetches player state on every message, so a site-wide broadcast at veto speed would be wasteful). The room page refetches on it, and every 10 seconds while the room is open, which is how everyone else watching follows along.
18. **DMs.** Two new types: `event_match_room` (your match room is open, ready up) and `event_match_forfeit` (the ready check ended in a forfeit), to both rosters. Players can turn them off on their notification settings like the others.

## Not in this plan (and why)

- Bookings, connect lines, automatic results, the on-server no-show, tiebreak games, between-game picks for "loser picks", the 15 minute confirm window and disputes: T3b.
- `!sub`, `!admin`, admin pause, replay a chapter, reopen a veto, move server, act for a team: T3c.
- Windows, reschedules and opening rooms on a schedule: rollout plan 4.
- Discord channel posts for rooms and pairings: rollout plan 5.

## Review Focus

- **Two managers of one team acting on the same veto step at once, or a manager and the clock.** Each action carries the step number it was made on; the second is refused with `step_taken` and writes nothing. Task 4 tests both orders.
- **A team readying up at the exact moment the ready deadline passes.** Ready is refused at or after the deadline, so the clock's decision never races a late Ready. The forfeit itself re-checks the match is still in its ready phase inside the event's chain, so an admin result entered in between is never overwritten by a forfeit. Tasks 4 and 5 test.
- **A bracket correction or another match's result while a room is open.** The room keeps its status through the bracket sync, and a correction that would change its teams is refused. Task 3 tests.
- **The web restarting in the middle of a veto, for longer than a step.** Overdue deadlines get a fresh full length at start, no automatic action fires for the downtime. Task 5 tests.
- **A roster change after a default four was saved** (a sub removed, a starter swapped). The automatic lineup skips a default four that is no longer all on the roster. Task 4 tests.

---

## File map

| File | Responsibility |
|---|---|
| `src/events/vetoConfig.ts` | Pure: `VetoConfig`, presets, `checkVeto`, `parseVetoConfig`, `presetOf`, `vetoFamily`, `vetoSummary`. Shared with the web. |
| `src/events/veto.ts` | Pure: the step engine (`vetoState`, `applyVeto`, `autoAction`, `coin`). |
| `src/events/validate.ts` | `StageSettings.veto`; `parseStage` reads `veto` (or a preset name); new error keys. |
| `src/events/events.ts` | `event_stages.veto_json` written and read; `stageSettingsOf` fills `veto` for older stages from `veto_type`. |
| `src/events/format.ts`, `src/events/views.ts` | The stage panel's veto line comes from `vetoSummary`. |
| `src/db.ts` | New tables, `event_matches` room columns, `event_stages.veto_json`, three settings. |
| `src/settingsSchema.ts` | The three room timers in the Competitive group. |
| `src/events/play.ts` | `MatchRow` room columns; `recordResult` takes a result from any room state; `syncBracket` keeps room statuses and refuses to change an open room's teams. |
| `src/events/room.ts` | Writer: open, ready, veto actions, lineups, hold, reset, resume a deadline, preferences. Reads for the views and the clock. |
| `src/events/flow.ts` | `forfeitMatch`; settle forfeits a disqualified team's open room too. |
| `src/events/roomClock.ts` | The 5 second clock: open due rooms, act on deadlines, resume on start. |
| `src/events/messages.ts`, `src/events/notices.ts`, `src/notify/notify.ts` | Two DM types. |
| `src/events/roomViews.ts` | `matchRoomView`, `prefsView`. |
| `src/events/playViews.ts` | `PlayMatch.room` phase for the bracket cards and the desk. |
| `src/routes/events.ts` | Room read, ready, veto, lineup; preferences read and save. |
| `src/routes/adminEvents.ts` | Open room, reset room, hold. |
| `src/server.ts` | Builds the `RoomClock`, resumes it, ticks it every 5 s, pushes `event_room`. |
| `tests/roomFixture.ts` | Two real teams entered in a live rolling event, one waiting match. |
| `web/src/api.ts` | Room, preferences and veto config types and calls. |
| `web/src/routes/EventMatch.tsx` + `web/src/routes/event/room/*` | The match room page. |
| `web/src/routes/event/PrepPanel.tsx` | Default four, side and campaign order on the event page. |
| `web/src/routes/event/Bracket.tsx`, `StagePlay.tsx`, `web/src/routes/Event.tsx` | Match cards link to their room and show its phase. |
| `web/src/routes/admin/events/StageForm.tsx`, `stageDraft.ts`, `VetoFields.tsx` | Veto preset and knobs. |
| `web/src/routes/admin/events/PlayPanel.tsx` | Room phases, Open room, Reset room, Hold. |
| `web/src/AppRoutes.tsx` | `/event/:slug/match/:id`. |
| `web/src/styles/app.css` | `.room*`, `.vetoboard*`, `.lineup*`, `.prep*`. |

---
### Task 1: Veto settings on a stage

**Files:**
- Create: `src/events/vetoConfig.ts`
- Modify: `src/db.ts` (the `ensureColumn` block after the T2 lines), `src/events/validate.ts`, `src/events/events.ts` (`StageRow`, `stageSettingsOf`, `insertStage`, `writeStage`), `src/events/format.ts`, `src/events/views.ts:96`
- Test: `tests/vetoConfig.test.ts` (new), `tests/eventsValidate.test.ts`, `tests/events.test.ts`

**Interfaces:**
- Produces in `vetoConfig.ts` (no imports from server-only modules; the web imports it as `../../../../../src/events/vetoConfig`, like `league.ts`):
  - `type VetoGames = 1 | 2 | 3 | 5`
  - `interface VetoConfig { games: VetoGames; banTo: number; firstBan: FirstBan; firstPick: FirstPick; laterPicks: LaterPicks; lateBans: number; sides: SideRule }` with `FirstBan = 'higher_chooses' | 'higher' | 'lower' | 'coin'`, `FirstPick = 'higher' | 'lower' | 'first' | 'second' | 'coin'`, `LaterPicks = 'loser' | 'alternate'`, `SideRule = 'non_picker' | 'higher' | 'coin'`
  - `VETO_PRESETS = ['ban_to_one', 'home_away', 'pick_ban', 'loser_picks']`, `type VetoPreset`, `PRESET_LABEL: Record<VetoPreset | 'custom', string>`, `PRESET_MIN_POOL: Record<VetoPreset, number>`
  - `presetConfig(p: VetoPreset, poolSize: number): VetoConfig`
  - `checkVeto(c: VetoConfig, poolSize: number): 'ok' | 'bad_veto' | 'bad_pool_for_veto'`
  - `parseVetoConfig(raw: unknown, poolSize: number): { ok: true; value: VetoConfig } | { ok: false; error: 'bad_veto' | 'bad_pool_for_veto' }`
  - `presetOf(c: VetoConfig, poolSize: number): VetoPreset | 'custom'`
  - `vetoFamily(c: VetoConfig): 'ban_to_one' | 'home_away' | 'pick_ban'`
  - `vetoSummary(c: VetoConfig, poolSize: number): string`
- Produces in `validate.ts`: `StageSettings.veto: VetoConfig` (and `vetoType` stays, always `vetoFamily(veto)`, for the `event_stages.veto_type` CHECK column); `parseStage` accepts `veto` (an object, wins) or `vetoType` (a preset name, as the T2 desk sends).
- Produces in `events.ts`: `StageRow.veto_json: string | null`.

- [ ] **Step 1: Write the failing pure tests**

Create `tests/vetoConfig.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { checkVeto, parseVetoConfig, presetConfig, presetOf, vetoFamily, vetoSummary, type VetoConfig } from '../src/events/vetoConfig.js';

const base: VetoConfig = { games: 1, banTo: 1, firstBan: 'higher_chooses', firstPick: 'first', laterPicks: 'alternate', lateBans: 0, sides: 'non_picker' };

describe('veto presets', () => {
  it('fills the knobs for each preset from the pool size', () => {
    expect(presetConfig('ban_to_one', 7)).toEqual(base);
    expect(presetConfig('home_away', 7)).toEqual({ ...base, games: 2, banTo: 7 });
    expect(presetConfig('pick_ban', 7)).toEqual({ ...base, games: 3, banTo: 5, lateBans: 2 });
    expect(presetConfig('pick_ban', 5)).toEqual({ ...base, games: 3, banTo: 3, lateBans: 0 });
    expect(presetConfig('loser_picks', 7)).toEqual({ ...base, games: 3, banTo: 3, firstPick: 'higher', laterPicks: 'loser' });
  });

  it('recognises a preset and calls anything else custom', () => {
    expect(presetOf(presetConfig('loser_picks', 7), 7)).toBe('loser_picks');
    expect(presetOf(presetConfig('pick_ban', 7), 7)).toBe('pick_ban');
    expect(presetOf({ ...presetConfig('loser_picks', 7), banTo: 4 }, 7)).toBe('custom');
  });

  it('maps every config to the old veto_type family', () => {
    expect(vetoFamily(base)).toBe('ban_to_one');
    expect(vetoFamily(presetConfig('home_away', 4))).toBe('home_away');
    expect(vetoFamily(presetConfig('loser_picks', 7))).toBe('pick_ban');
    expect(vetoFamily({ ...base, games: 5, banTo: 5 })).toBe('pick_ban');
  });
});

describe('checkVeto', () => {
  it('accepts every preset on a pool big enough for it', () => {
    for (const p of ['ban_to_one', 'home_away', 'pick_ban', 'loser_picks'] as const) expect(checkVeto(presetConfig(p, 7), 7)).toBe('ok');
  });

  it('needs at least one campaign per game left after the bans, and no more than the pool', () => {
    expect(checkVeto({ ...base, games: 3, banTo: 2 }, 7)).toBe('bad_veto');
    expect(checkVeto({ ...base, banTo: 8 }, 7)).toBe('bad_pool_for_veto');
    expect(checkVeto({ ...base, games: 3, banTo: 3 }, 2)).toBe('bad_pool_for_veto');
  });

  it('refuses loser picks in a total score Bo2, and late bans that leave nothing to play', () => {
    expect(checkVeto({ ...base, games: 2, banTo: 2, laterPicks: 'loser' }, 7)).toBe('bad_veto');
    expect(checkVeto({ ...base, games: 3, banTo: 5, lateBans: 3 }, 7)).toBe('bad_veto');
    expect(checkVeto({ ...base, games: 3, banTo: 5, lateBans: 2 }, 7)).toBe('ok');
    expect(checkVeto({ ...base, games: 3, banTo: 3, laterPicks: 'loser', lateBans: 1 }, 7)).toBe('bad_veto');
  });

  it('refuses unknown values', () => {
    expect(checkVeto({ ...base, games: 4 as 1 }, 7)).toBe('bad_veto');
    expect(checkVeto({ ...base, sides: 'nobody' as 'coin' }, 7)).toBe('bad_veto');
    expect(checkVeto({ ...base, banTo: 1.5 }, 7)).toBe('bad_veto');
  });
});

describe('parseVetoConfig', () => {
  it('reads a whole config and normalises a Bo1 (no later picks, no late bans)', () => {
    const r = parseVetoConfig({ ...base, banTo: 3, firstPick: 'higher', laterPicks: 'loser' }, 7);
    expect(r).toEqual({ ok: true, value: { ...base, banTo: 3, firstPick: 'higher', laterPicks: 'alternate', lateBans: 0 } });
  });

  it('refuses a non-object or a missing knob', () => {
    expect(parseVetoConfig('ban_to_one', 7)).toEqual({ ok: false, error: 'bad_veto' });
    const { sides: _drop, ...noSides } = base;
    expect(parseVetoConfig(noSides, 7)).toEqual({ ok: false, error: 'bad_veto' });
  });
});

describe('vetoSummary', () => {
  it('says the owner\'s format in one sentence', () => {
    expect(vetoSummary(presetConfig('loser_picks', 7), 7)).toBe(
      'Bo3: ban down to 3, the higher seed chooses to go first or second, the higher seed picks game 1, the loser of each game picks the next, the team that did not pick chooses sides.',
    );
  });

  it('says a Bo1 ban to one and a home and away', () => {
    expect(vetoSummary(base, 7)).toBe('Bo1: ban down to 1, the higher seed chooses to go first or second, the team that did not pick chooses sides.');
    expect(vetoSummary(presetConfig('home_away', 4), 4)).toBe(
      'Bo2, total score: no bans, the higher seed chooses to go first or second, the team that goes first picks game 1, the teams take turns picking the rest, the team that did not pick chooses sides.',
    );
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/vetoConfig.test.ts`
Expected: FAIL, cannot find module `../src/events/vetoConfig.js`.

- [ ] **Step 3: Write `src/events/vetoConfig.ts`**

```ts
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
  if (c.lateBans > 0 && (c.games === 1 || c.laterPicks === 'loser')) return 'bad_veto';
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
```

- [ ] **Step 4: Run the pure tests**

Run: `npx vitest run tests/vetoConfig.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing stage tests**

Append to `tests/eventsValidate.test.ts` (inside its top-level `describe`; it already builds a `StageContext` called `ctx` with the campaigns `no_mercy`, `dead_air` and more, and a valid stage body; reuse whatever helper the file uses to make a stage body, here called `stage(over)`):

```ts
  it('reads a stage veto as knobs, or as a preset name, and keeps veto_type as its family (plan T3a)', () => {
    const pool7 = ['no_mercy', 'dead_air', 'death_toll', 'blood_harvest', 'crash_course', 'the_sacrifice', 'swamp_fever'].filter((c) => ctx.campaigns.has(c));
    expect(pool7).toHaveLength(7);
    const knobs = { games: 3, banTo: 3, firstBan: 'higher_chooses', firstPick: 'higher', laterPicks: 'loser', lateBans: 0, sides: 'non_picker' };
    const r = V.parseStage(stage({ campaignPool: pool7, veto: knobs }), ctx);
    expect(r.ok && r.value.veto).toEqual(knobs);
    expect(r.ok && r.value.vetoType).toBe('pick_ban');
    const legacy = V.parseStage(stage({ campaignPool: pool7, vetoType: 'pick_ban' }), ctx);
    expect(legacy.ok && legacy.value.veto).toMatchObject({ games: 3, banTo: 5, lateBans: 2 });
    const preset = V.parseStage(stage({ campaignPool: pool7, vetoType: 'loser_picks' }), ctx);
    expect(preset.ok && preset.value.veto).toEqual(knobs);
  });

  it('refuses a veto the pool cannot run (plan T3a)', () => {
    const r = V.parseStage(stage({ campaignPool: ['no_mercy', 'dead_air'], veto: { games: 3, banTo: 3, firstBan: 'higher', firstPick: 'higher', laterPicks: 'loser', lateBans: 0, sides: 'coin' } }), ctx);
    expect(r).toEqual({ ok: false, error: 'bad_pool_for_veto' });
    expect(V.parseStage(stage({ vetoType: 'nonsense' }), ctx)).toEqual({ ok: false, error: 'bad_veto' });
  });
```

If the swamp_fever or the_sacrifice slugs are not poolable in the test context, take the first seven slugs of `ctx.campaigns` instead (`[...ctx.campaigns].slice(0, 7)`); the test only needs seven.

Append to `tests/events.test.ts` (it uses `eventFixture` and `stageBody`):

```ts
  it('stores a stage veto and reads an older stage (no veto_json) from its veto_type (plan T3a)', () => {
    const f = eventFixture();
    const knobs = { games: 1, banTo: 2, firstBan: 'coin', firstPick: 'lower', laterPicks: 'alternate', lateBans: 0, sides: 'higher' };
    must(E.updateStage(f.db, { eventId: f.eventId, stageId: f.s1, by: ADMIN, stage: stageBody(f.db, { veto: knobs }), now: NOW }));
    const s = E.getStage(f.db, f.s1)!;
    expect(JSON.parse(s.veto_json!)).toEqual(knobs);
    expect(s.veto_type).toBe('ban_to_one');
    expect(E.stageSettingsOf(s).veto).toEqual(knobs);
    f.db.prepare("UPDATE event_stages SET veto_json = NULL, veto_type = 'home_away' WHERE id = ?").run(f.s1);
    expect(E.stageSettingsOf(E.getStage(f.db, f.s1)!).veto).toMatchObject({ games: 2, banTo: 2 });
  });
```

- [ ] **Step 6: Run them to see them fail**

Run: `npx vitest run tests/eventsValidate.test.ts tests/events.test.ts`
Expected: FAIL (`veto` is undefined; no `veto_json` column).

- [ ] **Step 7: Schema, validation and storage**

In `src/db.ts`, in the `ensureColumn` block after the T2 lines:

```ts
  // Tournaments plan T3a: a stage's veto knobs (src/events/vetoConfig.ts).
  // Null on stages made before it; stageSettingsOf reads those from veto_type.
  ensureColumn(db, 'event_stages', 'veto_json', 'TEXT');
```

In `src/events/validate.ts`:
- `import { parseVetoConfig, presetConfig, vetoFamily, VETO_PRESETS, PRESET_MIN_POOL, type VetoConfig, type VetoPreset } from './vetoConfig.js';`
- `StageSettings` gains `veto: VetoConfig;`.
- Replace the two error texts:

```ts
  bad_pool_for_veto: { status: 400, text: 'The campaign pool is too small for this veto: it needs at least as many campaigns as the veto bans down to.' },
  bad_veto: { status: 400, text: 'Those veto settings do not fit together. Pick a preset, or check the series length, the bans and who picks.' },
```

- In `parseStage`, replace the three lines from `const vetoType = raw.vetoType ?? 'ban_to_one';` to `if (!poolFitsVeto(...)) return fail('bad_pool_for_veto');` with:

```ts
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
```

  and add `veto,` to the returned settings object next to `vetoType`.
- Delete `poolFitsVeto` and `PICK_BAN_POOL` if nothing else uses them (`grep -rn "poolFitsVeto\|PICK_BAN_POOL" src web/src tests`); update any test that imported them to the new rules.

In `src/events/events.ts`:
- `StageRow` gains `veto_json: string | null;`.
- `import { presetConfig, type VetoConfig } from './vetoConfig.js';`
- In `stageSettingsOf`, before the return:

```ts
  const pool = JSON.parse(s.campaign_pool_json) as string[];
  // Stages made before plan T3a have no veto_json: their veto_type names a preset.
  const veto: VetoConfig = s.veto_json ? JSON.parse(s.veto_json) as VetoConfig : presetConfig(s.veto_type, pool.length);
```

  and return `campaignPool: pool, ..., veto`.
- `insertStage` and `writeStage` write `veto_json = JSON.stringify(s.veto)` next to `veto_type`.

In `src/events/format.ts`, drop `VETO_LABEL` if `views.ts` was its only user, and in `src/events/views.ts:96` set `veto: vetoSummary(st.veto, st.campaignPool.length)` (import from `./vetoConfig.js`). Fix any test that asserted the old label text (`grep -rn "Ban to one (Bo1)\|VETO_LABEL" tests src`) to the new sentence.

- [ ] **Step 8: Run the event tests and the typecheck**

Run: `npx vitest run tests/vetoConfig.test.ts tests/eventsValidate.test.ts tests/events.test.ts tests/eventRoutes.test.ts tests/adminEventRoutes.test.ts && npm run typecheck`
Expected: PASS. The web typecheck may fail on `StageSettings.veto` being missing in `web/src/api.ts`; add `veto?: VetoConfig` there now (import the type from the shared module) and make it required in Task 9.

- [ ] **Step 9: Commit**

```bash
git add src/events/vetoConfig.ts src/events/validate.ts src/events/events.ts src/events/format.ts src/events/views.ts src/db.ts web/src/api.ts tests/vetoConfig.test.ts tests/eventsValidate.test.ts tests/events.test.ts
git commit -m "Tournaments T3a: a stage's veto is a set of knobs with four presets, stored as veto_json, and the event page states it in one sentence"
```

---

### Task 2: The veto step engine

**Files:**
- Create: `src/events/veto.ts`
- Test: `tests/veto.test.ts` (new)

**Interfaces:**
- Consumes: `VetoConfig` (Task 1).
- Produces in `veto.ts`:
  - `type Side = 'a' | 'b'`; `other(s: Side): Side`
  - `type VetoActionKind = 'first' | 'second' | 'ban' | 'pick' | 'survivors' | 'infected'`
  - `interface VetoAction { side: Side; action: VetoActionKind; campaign: string | null; auto: boolean }`
  - `type Step = { kind: 'order'; by: Side } | { kind: 'ban'; by: Side } | { kind: 'pick'; by: Side; game: number } | { kind: 'side'; by: Side; game: number } | { kind: 'wait'; game: number } | { kind: 'done' }`
  - `interface GameSlot { game: number; campaign: string; pickedBy: Side | null; sideBy: Side | null; firstSurvivors: Side | null }`
  - `interface VetoState { first: Side | null; remaining: string[]; bans: { side: Side; campaign: string }[]; games: GameSlot[]; next: Step; used: number }`
  - `interface VetoInput { config: VetoConfig; pool: string[]; higher: Side; seed: number; actions: VetoAction[]; winners: Side[] }`
  - `coin(seed: number, k: number): Side`
  - `vetoState(inp: VetoInput): VetoState` (throws `VetoError` on an action that does not fit; stored actions always fit)
  - `applyVeto(inp: VetoInput, a: VetoAction): { ok: true; state: VetoState } | { ok: false; code: 'not_your_turn' | 'bad_veto_action' }`
  - `isHumanStep(s: Step): s is Extract<Step, { by: Side }>`
  - `autoAction(st: VetoState, pool: string[], prefs: { campaigns: string[]; side: 'survivors' | 'infected' | null }): VetoAction`
  - `class VetoError extends Error { code: 'not_your_turn' | 'bad_veto_action' }`

The engine is a replay: the same input always gives the same state, so the database stores only the actions (and the match's coin seed), and a restart loses nothing. `winners[i]` is who won game i+1; T3a always passes `[]`, T3b fills it.

- [ ] **Step 1: Write the failing tests**

Create `tests/veto.test.ts`:

```ts
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
    expect(st.remaining).toEqual(['c7']);
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
    actions.push(act('a', 'pick', 'c6'), act('b', 'survivors'));
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/veto.test.ts`
Expected: FAIL, cannot find module `../src/events/veto.js`.

- [ ] **Step 3: Write `src/events/veto.ts`**

```ts
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
      st.remaining = st.remaining.filter((x) => x !== campaign);
      const slot: GameSlot = { game: g, campaign, pickedBy, sideBy: null, firstSurvivors: null };
      st.games.push(slot);
      if (c.sides === 'coin') {
        slot.firstSurvivors = coin(inp.seed, 2 + g);
      } else {
        // Ruling 6: the non-picker; for a decider, the team that did not make
        // the last ban; with no bans at all, the higher seed.
        const by: Side = c.sides === 'higher' ? higher : pickedBy ? other(pickedBy) : lastBanner ? other(lastBanner) : higher;
        slot.sideBy = by;
        slot.firstSurvivors = take({ kind: 'side', by, game: g }).action === 'survivors' ? by : other(by);
      }
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
```

Note the late-bans test: in pick and ban, game 2's picker is `b`, so the late bans start with `a` (the team after the last picker), as the classic order has it.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/veto.test.ts`
Expected: PASS. If the "1-1 decider" case fails, check that a decider's side chooser is the team that did not make the last opening ban (`b` banned `c4` last, so `a` chooses).

- [ ] **Step 5: Commit**

```bash
git add src/events/veto.ts tests/veto.test.ts
git commit -m "Tournaments T3a: the veto step engine replays a match's actions over the stage's veto knobs, with loser picks, late bans, deciders, coin sides and timed-out actions from preferences"
```

---
### Task 3: Room schema and writer, part 1 (open, ready, hold, reset, resume)

**Files:**
- Modify: `src/db.ts` (event SQL block after `event_matches`; `ensureColumn` block; `DEFAULT_SETTINGS`), `src/settingsSchema.ts`, `src/events/play.ts`, `src/events/validate.ts` (error keys)
- Create: `src/events/room.ts`, `tests/roomFixture.ts`
- Test: `tests/room.test.ts` (new), `tests/eventsSchema.test.ts`, `tests/eventLogGuard.test.ts`, `tests/eventFlow.test.ts`

**Interfaces:**
- Consumes: `vetoState`, `isHumanStep`, `Side` (Task 2); `E.stageSettingsOf(stage).veto` (Task 1).
- Produces tables `event_vetoes`, `event_games`, `event_lineups`, `event_entry_prefs`, `event_campaign_prefs`; `event_matches` columns `room_opened_at`, `room_higher`, `room_seed`, `ready_a_at`, `ready_b_at`, `deadline`, `hold_reason`; settings `event_ready_minutes` (10), `event_veto_step_seconds` (60), `event_lineup_minutes` (5).
- Produces in `play.ts`: `MatchRow` gains `room_opened_at: string | null; room_higher: 'a' | 'b' | null; room_seed: number | null; ready_a_at: string | null; ready_b_at: string | null; deadline: string | null; hold_reason: string | null`; `ROOM_OPEN: ReadonlySet<MatchStatus>` = veto, lineup, booking, connect, live, confirming, admin_hold (the states T3b fills too); `recordResult` takes a result from `waiting` or any `ROOM_OPEN` state as a first result, and refuses with `room_open_downstream` a bracket change that would alter the teams of a match in `ROOM_OPEN`.
- Produces in `room.ts`:
  - `interface RoomTimers { readyMinutes: number; stepSeconds: number; lineupMinutes: number }`
  - `roomTimers(db: DB): RoomTimers`
  - reads: `vetoActions(db, matchId): VetoAction[]`, `vetoInput(db, m: P.MatchRow): VetoInput`, `roomState(db, m): VetoState`, `gamesOf(db, matchId): GameRow[]`, `lineupsOf(db, matchId): LineupRow[]`, `sideOf(db, m, steamid): Side | null`, `entryOn(m, side): number`, `playableOf(db, entryId): string[]`, `busyEntries(db, eventId): Set<number>`, `isParticipant(db, m, steamid): boolean`
  - mutations (each `V.Checked<P.MatchRow>` unless said): `openRoom(db, { matchId, by: string | null, higher: Side, seed: number, timers, now? })`, `readyUp(db, { matchId, steamid, timers, now? })`, `holdMatch(db, { matchId, by: string | null, reason: string, now? })`, `resetRoom(db, { matchId, by: string, now? })`, `resumeDeadline(db, { matchId, timers, now? })`
  - `RoomTimers` is passed in, not read inside, so tests fix it.
- Produces in `tests/roomFixture.ts`: `roomFixture(o?: { veto?: object; pool?: string[]; startsAt?: string; now?: Date }): RoomFixture` with `{ db, eventId, stageId, matchId, entryA, entryB, slug }`; teams from `entryFixture` (Rats: A[0] captain, A[1] co-captain; Bats: B[0] captain); `TIMERS: RoomTimers = { readyMinutes: 10, stepSeconds: 60, lineupMinutes: 5 }`.

- [ ] **Step 1: Write the fixture**

Create `tests/roomFixture.ts`:

```ts
import type { DB } from '../src/db.js';
import * as E from '../src/events/events.js';
import * as N from '../src/events/entries.js';
import * as P from '../src/events/play.js';
import { startEventFlow } from '../src/events/flow.js';
import type { RoomTimers } from '../src/events/room.js';
import { ADMIN, NOW } from './eventFixture.js';
import { entryFixture, rosterA, rosterB } from './entryFixture.js';

/** Rats (A) and Bats (B) entered in a live one-stage Swiss event played
 *  rolling, with their round 1 match waiting (plan T3a). Rats is seed 1 and
 *  entry_a. pool and veto overwrite the stage before it starts (test setup
 *  only; the stage editor is tested elsewhere). HTTP tests pass a startsAt
 *  relative to Date.now() and now = new Date(), as entryFixture explains. */
export interface RoomFixture { db: DB; eventId: number; stageId: number; matchId: number; entryA: number; entryB: number; slug: string }
export const TIMERS: RoomTimers = { readyMinutes: 10, stepSeconds: 60, lineupMinutes: 5 };
export const POOL7 = ['no_mercy', 'dead_air', 'death_toll', 'blood_harvest', 'crash_course', 'the_sacrifice', 'no_mercy_2'];

export async function roomFixture(o: { veto?: object; pool?: string[]; startsAt?: string; now?: Date } = {}): Promise<RoomFixture> {
  const now = o.now ?? NOW;
  const f = entryFixture({ checkin: false, startsAt: o.startsAt });
  const reg = (teamId: number, by: string, roster: object) => {
    const r = N.registerEntry(f.db, { eventId: f.eventId, teamId, by, roster, now });
    if (!r.ok) throw new Error(r.error);
    return r.value.entry.id;
  };
  const entryA = reg(f.teamA, '76561199000000801', rosterA());
  const entryB = reg(f.teamB, '76561199000000811', rosterB());
  const stageId = E.stagesOf(f.db, f.eventId)[0]!.id;
  if (o.pool) f.db.prepare('UPDATE event_stages SET campaign_pool_json = ? WHERE id = ?').run(JSON.stringify(o.pool), stageId);
  if (o.veto) f.db.prepare('UPDATE event_stages SET veto_json = ? WHERE id = ?').run(JSON.stringify(o.veto), stageId);
  const lock = N.lockEntries(f.db, { eventId: f.eventId, by: ADMIN, now });
  if (!lock.ok) throw new Error(lock.error);
  f.db.prepare('UPDATE event_entries SET seed = CASE id WHEN ? THEN 1 ELSE 2 END WHERE event_id = ?').run(entryA, f.eventId);
  const started = await startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now });
  if (!started.ok) throw new Error(started.error);
  const m = P.matchesOf(f.db, stageId).find((x) => x.status === 'waiting')!;
  return { db: f.db, eventId: f.eventId, stageId, matchId: m.id, entryA: m.entry_a!, entryB: m.entry_b!, slug: E.getEvent(f.db, f.eventId)!.slug };
}
```

POOL7's slugs must all be poolable in a fresh database. Before using it, run `node -e` or a scratch test printing `poolableCampaigns(openDb(':memory:')).map(c => c.slug)` and replace POOL7 with the first seven slugs it prints (keep `no_mercy` and `dead_air` first). If `lockEntries` reorders seeds by SR, the `UPDATE ... seed` line pins Rats as seed 1 (test setup only).

- [ ] **Step 2: Write the failing tests**

Append to `tests/eventsSchema.test.ts`:

```ts
  it('has the match room tables and columns (plan T3a)', () => {
    const db = openDb(':memory:');
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('event_matches')).toEqual(expect.arrayContaining(['room_opened_at', 'room_higher', 'room_seed', 'ready_a_at', 'ready_b_at', 'deadline', 'hold_reason']));
    expect(cols('event_vetoes')).toEqual(['id', 'event_match_id', 'step', 'side', 'entry_id', 'action', 'campaign', 'by_steamid', 'auto', 'at']);
    expect(cols('event_games')).toEqual(['id', 'event_match_id', 'ordinal', 'campaign', 'picked_by', 'side_by', 'first_survivors', 'match_id', 'tiebreak_of', 'created_at']);
    expect(cols('event_lineups')).toEqual(['id', 'event_match_id', 'game', 'entry_id', 'steamids', 'locked_by', 'auto', 'locked_at']);
    expect(cols('event_entry_prefs')).toEqual(['entry_id', 'default_four', 'side', 'updated_by', 'updated_at']);
    expect(cols('event_campaign_prefs')).toEqual(['entry_id', 'stage_id', 'campaigns', 'updated_by', 'updated_at']);
    const setting = (k: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string }).value;
    expect([setting('event_ready_minutes'), setting('event_veto_step_seconds'), setting('event_lineup_minutes')]).toEqual(['10', '60', '5']);
  });
```

Create `tests/room.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as P from '../src/events/play.js';
import * as R from '../src/events/room.js';
import * as E from '../src/events/events.js';
import { recordResultFlow } from '../src/events/flow.js';
import { ADMIN, NOW } from './eventFixture.js';
import { A, B } from './entryFixture.js';
import { TIMERS, roomFixture, type RoomFixture } from './roomFixture.js';

const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value; };
const open = (f: RoomFixture, now = NOW) => ok(R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS, now }));
const lastAction = (f: RoomFixture) => (f.db.prepare('SELECT action, actor FROM event_log ORDER BY id DESC LIMIT 1').get() as { action: string; actor: string | null });

describe('openRoom', () => {
  it('moves a waiting match to the ready phase with a deadline, the higher seed and the coin seed', async () => {
    const f = await roomFixture();
    const m = open(f);
    expect(m).toMatchObject({ status: 'veto', room_higher: 'a', room_seed: 0, ready_a_at: null, ready_b_at: null, deadline: at(10).toISOString() });
    expect(lastAction(f)).toEqual({ action: 'room_opened', actor: null });
  });

  it('refuses a match that is not waiting, and a team already in another open room', async () => {
    const f = await roomFixture();
    open(f);
    expect(R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS, now: NOW })).toEqual({ ok: false, error: 'wrong_status' });
    expect(R.busyEntries(f.db, f.eventId)).toEqual(new Set([f.entryA, f.entryB]));
  });
});

describe('readyUp', () => {
  it('takes a captain or co-captain of either team, and starts the veto once both are ready', async () => {
    const f = await roomFixture();
    open(f);
    expect(R.readyUp(f.db, { matchId: f.matchId, steamid: A[3], timers: TIMERS, now: at(1) })).toEqual({ ok: false, error: 'not_manager' });
    const m1 = ok(R.readyUp(f.db, { matchId: f.matchId, steamid: A[1], timers: TIMERS, now: at(1) }));
    expect(m1.ready_a_at).toBe(at(1).toISOString());
    expect(m1.deadline).toBe(at(10).toISOString());
    expect(R.readyUp(f.db, { matchId: f.matchId, steamid: A[0], timers: TIMERS, now: at(2) })).toEqual({ ok: false, error: 'already_ready' });
    const m2 = ok(R.readyUp(f.db, { matchId: f.matchId, steamid: B[0], timers: TIMERS, now: at(3) }));
    // The default veto (ban to one) asks the higher seed first: a 60 s step.
    expect(m2).toMatchObject({ status: 'veto', deadline: new Date(at(3).getTime() + 60_000).toISOString() });
    expect(lastAction(f)).toEqual({ action: 'room_ready', actor: B[0] });
  });

  it('refuses a Ready at or after the deadline', async () => {
    const f = await roomFixture();
    open(f);
    expect(R.readyUp(f.db, { matchId: f.matchId, steamid: A[0], timers: TIMERS, now: at(10) })).toEqual({ ok: false, error: 'room_closed' });
  });

  it('goes straight to lineups when the veto has no step for a person', async () => {
    const f = await roomFixture({ pool: ['no_mercy'], veto: { games: 1, banTo: 1, firstBan: 'coin', firstPick: 'higher', laterPicks: 'alternate', lateBans: 0, sides: 'coin' } });
    open(f);
    R.readyUp(f.db, { matchId: f.matchId, steamid: A[0], timers: TIMERS, now: at(1) });
    const m = ok(R.readyUp(f.db, { matchId: f.matchId, steamid: B[0], timers: TIMERS, now: at(1) }));
    expect(m).toMatchObject({ status: 'lineup', deadline: at(6).toISOString() });
    expect(R.gamesOf(f.db, f.matchId)).toEqual([expect.objectContaining({ ordinal: 1, campaign: 'no_mercy', picked_by: null, first_survivors: f.entryA })]);
  });
});

describe('holdMatch and resetRoom', () => {
  it('holds an open room with a reason, and a reset takes it back to waiting with nothing left behind', async () => {
    const f = await roomFixture();
    open(f);
    expect(ok(R.holdMatch(f.db, { matchId: f.matchId, by: null, reason: 'nobody_ready', now: at(10) }))).toMatchObject({ status: 'admin_hold', hold_reason: 'nobody_ready', deadline: null });
    const m = ok(R.resetRoom(f.db, { matchId: f.matchId, by: ADMIN, now: at(11) }));
    expect(m).toMatchObject({ status: 'waiting', room_opened_at: null, room_higher: null, ready_a_at: null, deadline: null, hold_reason: null });
    expect(lastAction(f)).toEqual({ action: 'room_reset', actor: ADMIN });
    expect(R.resetRoom(f.db, { matchId: f.matchId, by: ADMIN, now: at(12) })).toEqual({ ok: false, error: 'wrong_status' });
  });
});

describe('resumeDeadline', () => {
  it('gives an overdue deadline its full length again from now, and leaves a future one alone', async () => {
    const f = await roomFixture();
    open(f);
    expect(ok(R.resumeDeadline(f.db, { matchId: f.matchId, timers: TIMERS, now: at(30) })).deadline).toBe(at(40).toISOString());
    expect(R.resumeDeadline(f.db, { matchId: f.matchId, timers: TIMERS, now: at(31) })).toEqual({ ok: false, error: 'changed' });
  });
});

describe('results and the room (play.ts)', () => {
  it('takes an admin result from any room state as a first result, not a correction', async () => {
    const f = await roomFixture();
    open(f);
    const r = await recordResultFlow(f.db, { eventId: f.eventId, matchId: f.matchId, by: ADMIN, result: { winner: 'a', scoreA: 900, scoreB: 400 }, now: at(5) });
    expect(r.ok && r.value).toMatchObject({ status: 'done', result_source: 'admin' });
    const log = f.db.prepare("SELECT detail FROM event_log WHERE action = 'result_recorded'").get() as { detail: string };
    expect(JSON.parse(log.detail).correction).toBe(false);
  });

  it('keeps an open room through a bracket sync, and refuses a correction that would change its teams', async () => {
    // Covered against a real bracket in tests/eventFlow.test.ts (Step 3 below).
    expect(P.ROOM_OPEN.has('veto')).toBe(true);
  });
});
```

Append to `tests/eventFlow.test.ts` (it already has `playFixture` with SE and a `report`-style helper; adapt names to the file):

```ts
  it('keeps a bracket match\'s room status through another match\'s result, and refuses a correction that would change its teams (plan T3a)', async () => {
    const f = playFixture({ stages: [SE()], entries: 4 });
    must(await startEventFlow(f.db, { eventId: f.eventId, by: ADMIN, now: NOW }));
    const semis = P.matchesOf(f.db, f.stages[0]!).filter((m) => m.status === 'waiting');
    must(await recordResultFlow(f.db, { eventId: f.eventId, matchId: semis[0]!.id, by: ADMIN, result: { winner: 'a', scoreA: 10, scoreB: 5 }, now: NOW }));
    must(await recordResultFlow(f.db, { eventId: f.eventId, matchId: semis[1]!.id, by: ADMIN, result: { winner: 'a', scoreA: 10, scoreB: 5 }, now: NOW }));
    const final = P.matchesOf(f.db, f.stages[0]!).find((m) => m.round === 2 && m.status === 'waiting')!;
    must(R.openRoom(f.db, { matchId: final.id, by: null, higher: 'a', seed: 0, timers: TIMERS, now: NOW }));
    const fix = await recordResultFlow(f.db, { eventId: f.eventId, matchId: semis[0]!.id, by: ADMIN, result: { winner: 'b', scoreA: 5, scoreB: 10 }, now: NOW });
    expect(fix).toEqual({ ok: false, error: 'room_open_downstream' });
    expect(P.getMatch(f.db, final.id)!.status).toBe('veto');
    const same = await recordResultFlow(f.db, { eventId: f.eventId, matchId: semis[0]!.id, by: ADMIN, result: { winner: 'a', scoreA: 12, scoreB: 5 }, now: NOW });
    expect(same.ok).toBe(true);
    expect(P.getMatch(f.db, final.id)!.status).toBe('veto');
  });
```

(`R` is `import * as R from '../src/events/room.js'`, `TIMERS` from `./roomFixture.js`; `playFixture` entries have no teams, which `openRoom` does not need.)

In `tests/eventLogGuard.test.ts`, inside `describe('play guard ...')`:
- change the `only src/events/play.ts writes event_matches` test to allow `src/events/play.ts` and `src/events/room.ts`;
- add a new `describe('room guard (src/events/room.ts)')` block shaped like the play guard: `ROOM_TABLES = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(?:event_vetoes|event_games|event_lineups|event_entry_prefs|event_campaign_prefs)\b/gi` written only by `src/events/room.ts`; `ROOM_READS = new Set(['roomTimers', 'vetoActions', 'vetoInput', 'roomState', 'gamesOf', 'lineupsOf', 'sideOf', 'entryOn', 'playableOf', 'busyEntries', 'isParticipant'])` (Task 4 adds its own reads); and `ROOM_MUTATIONS` with, for each, `{ action, actor, setup, run }` on a `roomFixture()`:
  - `openRoom`: action `room_opened`, actor null, setup none.
  - `readyUp`: `room_ready`, actor `A[0]`, setup `open`.
  - `holdMatch`: `match_held`, actor null, setup `open`.
  - `resetRoom`: `room_reset`, actor `ADMIN`, setup `open`.
  - `resumeDeadline`: `room_resumed`, actor null, setup `open`, run at `now = at(30)`.
  Each gets the same two tests the play guard has (exactly one `event_log` row with that action and actor; nothing written when a trigger blocks that action), with `rows(f)` covering `event_matches` and the five new tables. Because `roomFixture` is async, make the `it` callbacks async and `await` the fixture.

Leave the "every exported function is a read or a mutation" check of the room guard for Task 4 to complete (it adds `actVeto`, `lockLineup`, `savePrefs`); add it now with the Task 3 lists so it fails loudly if a function is missed.

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run tests/eventsSchema.test.ts tests/room.test.ts tests/eventFlow.test.ts tests/eventLogGuard.test.ts`
Expected: FAIL (no tables, no `room.ts`).

- [ ] **Step 4: Schema and settings**

In `src/db.ts`, after the `event_matches` indexes:

```sql
-- The match room (tournaments plan T3a). Only src/events/room.ts writes
-- these. event_vetoes is the replayable log of a match's veto (src/events/
-- veto.ts reads it back); step numbers run 0, 1, 2 ... with no gaps.
-- event_games are the games the veto settled, rewritten from the replay
-- after each action; match_id and tiebreak_of are filled by plan T3b.
-- event_lineups.steamids is a JSON array of exactly four steamids; game is
-- 1 in T3a. The two prefs tables hold what a team's managers saved for the
-- timers to act from (Ruling 7) and the default four (Ruling 9).
CREATE TABLE IF NOT EXISTS event_vetoes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  event_match_id INTEGER NOT NULL REFERENCES event_matches(id),
  step           INTEGER NOT NULL,
  side           TEXT NOT NULL CHECK (side IN ('a','b')),
  entry_id       INTEGER NOT NULL REFERENCES event_entries(id),
  action         TEXT NOT NULL CHECK (action IN ('first','second','ban','pick','survivors','infected')),
  campaign       TEXT,
  by_steamid     TEXT,
  auto           INTEGER NOT NULL DEFAULT 0 CHECK (auto IN (0,1)),
  at             TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS event_vetoes_step ON event_vetoes (event_match_id, step);
CREATE TABLE IF NOT EXISTS event_games (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_match_id  INTEGER NOT NULL REFERENCES event_matches(id),
  ordinal         INTEGER NOT NULL,
  campaign        TEXT NOT NULL,
  picked_by       INTEGER REFERENCES event_entries(id),
  side_by         INTEGER REFERENCES event_entries(id),
  first_survivors INTEGER REFERENCES event_entries(id),
  match_id        INTEGER REFERENCES matches(id),
  tiebreak_of     INTEGER REFERENCES event_games(id),
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS event_games_ordinal ON event_games (event_match_id, ordinal);
CREATE TABLE IF NOT EXISTS event_lineups (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  event_match_id INTEGER NOT NULL REFERENCES event_matches(id),
  game           INTEGER NOT NULL,
  entry_id       INTEGER NOT NULL REFERENCES event_entries(id),
  steamids       TEXT NOT NULL,
  locked_by      TEXT,
  auto           INTEGER NOT NULL DEFAULT 0 CHECK (auto IN (0,1)),
  locked_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS event_lineups_one ON event_lineups (event_match_id, game, entry_id);
CREATE TABLE IF NOT EXISTS event_entry_prefs (
  entry_id     INTEGER PRIMARY KEY REFERENCES event_entries(id),
  default_four TEXT,
  side         TEXT CHECK (side IN ('survivors','infected')),
  updated_by   TEXT,
  updated_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS event_campaign_prefs (
  entry_id   INTEGER NOT NULL REFERENCES event_entries(id),
  stage_id   INTEGER NOT NULL REFERENCES event_stages(id),
  campaigns  TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (entry_id, stage_id)
);
```

In the `ensureColumn` block:

```ts
  // Tournaments plan T3a: the match room. room_higher is the higher seed's
  // side when the room opened (Ruling 5); room_seed the coin bits
  // (src/events/veto.ts coin); deadline the current phase's (ready, a veto
  // step, lineups) and null otherwise.
  ensureColumn(db, 'event_matches', 'room_opened_at', 'TEXT');
  ensureColumn(db, 'event_matches', 'room_higher', "TEXT CHECK (room_higher IN ('a','b'))");
  ensureColumn(db, 'event_matches', 'room_seed', 'INTEGER');
  ensureColumn(db, 'event_matches', 'ready_a_at', 'TEXT');
  ensureColumn(db, 'event_matches', 'ready_b_at', 'TEXT');
  ensureColumn(db, 'event_matches', 'deadline', 'TEXT');
  ensureColumn(db, 'event_matches', 'hold_reason', 'TEXT');
```

In `DEFAULT_SETTINGS`, after the booking lines:

```ts
  // Tournaments plan T3a: the match room's timers.
  event_ready_minutes: '10',
  event_veto_step_seconds: '60',
  event_lineup_minutes: '5',
```

In `src/settingsSchema.ts`, after `booking_recover_wait_minutes`:

```ts
  { key: 'event_ready_minutes', group: 'Competitive', label: 'Tournament ready check (minutes)', help: 'When a tournament match room opens, a captain or co-captain of each team has this long to press Ready. A team that does not loses by forfeit; if neither does, staff decide.', type: { kind: 'int', min: 2, max: 30 } },
  { key: 'event_veto_step_seconds', group: 'Competitive', label: 'Tournament veto step (seconds)', help: 'Time for each ban, pick or side choice. When it runs out the room acts for the team from its saved campaign order.', type: { kind: 'int', min: 20, max: 300 } },
  { key: 'event_lineup_minutes', group: 'Competitive', label: 'Tournament lineup lock (minutes)', help: 'Time for each team to lock its four players after the veto. When it runs out the room uses the team\'s default four, or its last lineup, or its starters.', type: { kind: 'int', min: 1, max: 15 } },
```

In `src/events/validate.ts` `EVENT_ERRORS`, add:

```ts
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
```

- [ ] **Step 5: play.ts**

- Add the seven room fields to `MatchRow`.
- Export `ROOM_OPEN`:

```ts
/** States of a match whose room is open (plan T3a; T3b uses connect, live
 *  and confirming). A result may be entered from any of them. */
export const ROOM_OPEN: ReadonlySet<MatchStatus> = new Set<MatchStatus>(['veto', 'lineup', 'booking', 'connect', 'live', 'confirming', 'admin_hold']);
```

- In `syncBracket`, keep a room's status while its bracket match is still ready:

```ts
    const keep = ROOM_OPEN.has(row.status) && b.state === 'ready';
    upd.run(b.a, b.b, keep ? row.status : status, b.winner, b.scoreA, b.scoreB, resolved ? row.result_source : null, resolved ? row.finished_at ?? at : null, row.id);
```

- In `recordResult`:

```ts
    const first = m.status === 'waiting' || ROOM_OPEN.has(m.status);
    if (m.entry_a === null || m.entry_b === null || !(first || m.status === 'done' || m.status === 'forfeit')) return V.fail('match_not_open');
    if ((m.bm_match_id === null) !== (o.bracket === null)) return V.fail('bad_request');
    const correction = !first;
```

  and before writing the bracket (inside `if (o.bracket)`, after the `baseRev` check):

```ts
      // Ruling 14: never change the teams of a match whose room is open.
      const byBm = new Map(bracketMatches(o.bracket.data).map((b) => [b.bmId, b]));
      for (const row of matchesOf(db, stage.id)) {
        if (row.id === m.id || !ROOM_OPEN.has(row.status) || row.bm_match_id === null) continue;
        const b = byBm.get(row.bm_match_id);
        if (!b || b.a !== row.entry_a || b.b !== row.entry_b) return V.fail('room_open_downstream');
      }
```

  and add `deadline = NULL` to its final `UPDATE event_matches SET status = ?, ...` so a closed room has no deadline.

- [ ] **Step 6: Write `src/events/room.ts` (part 1)**

```ts
import type { DB } from '../db.js';
import { settingNumber } from '../settings.js';
import * as E from './events.js';
import * as N from './entries.js';
import * as P from './play.js';
import * as V from './validate.js';
import { isHumanStep, vetoState, type Side, type VetoAction, type VetoInput, type VetoState } from './veto.js';

/**
 * The match room (tournaments plan T3a): the only writer of the room
 * columns of event_matches and of event_vetoes, event_games, event_lineups,
 * event_entry_prefs and event_campaign_prefs. Same shape as play.ts: each
 * mutation is one synchronous transaction that re-reads, checks, writes and
 * adds exactly one event_log row; a refusal writes nothing
 * (tests/eventLogGuard.test.ts). Timers come in as RoomTimers so tests fix
 * them; src/events/roomClock.ts reads them from settings.
 */

export interface RoomTimers { readyMinutes: number; stepSeconds: number; lineupMinutes: number }
export interface GameRow {
  id: number; event_match_id: number; ordinal: number; campaign: string; picked_by: number | null; side_by: number | null;
  first_survivors: number | null; match_id: number | null; tiebreak_of: number | null; created_at: string;
}
export interface LineupRow { id: number; event_match_id: number; game: number; entry_id: number; steamids: string; locked_by: string | null; auto: number; locked_at: string }

const iso = (now?: Date): string => (now ?? new Date()).toISOString();
const plus = (now: Date, ms: number): string => new Date(now.getTime() + ms).toISOString();
/** Statuses where an entry counts as busy for opening another room. */
const BUSY_SQL = "('veto','lineup','booking','connect','live','confirming','admin_hold')";

export function roomTimers(db: DB): RoomTimers {
  return {
    readyMinutes: settingNumber(db, 'event_ready_minutes', 10, { min: 2, max: 30, integer: true }),
    stepSeconds: settingNumber(db, 'event_veto_step_seconds', 60, { min: 20, max: 300, integer: true }),
    lineupMinutes: settingNumber(db, 'event_lineup_minutes', 5, { min: 1, max: 15, integer: true }),
  };
}

export const entryOn = (m: P.MatchRow, side: Side): number => (side === 'a' ? m.entry_a! : m.entry_b!);

export function vetoActions(db: DB, matchId: number): VetoAction[] {
  return (db.prepare('SELECT side, action, campaign, auto FROM event_vetoes WHERE event_match_id = ? ORDER BY step').all(matchId) as
    { side: Side; action: VetoAction['action']; campaign: string | null; auto: number }[])
    .map((r) => ({ side: r.side, action: r.action, campaign: r.campaign, auto: r.auto === 1 }));
}

/** T3a has no game results yet, so winners is always empty (Ruling 8). */
export function vetoInput(db: DB, m: P.MatchRow): VetoInput {
  const s = E.stageSettingsOf(E.getStage(db, m.stage_id)!);
  return { config: s.veto, pool: s.campaignPool, higher: m.room_higher ?? 'a', seed: m.room_seed ?? 0, actions: vetoActions(db, m.id), winners: [] };
}
export function roomState(db: DB, m: P.MatchRow): VetoState {
  return vetoState(vetoInput(db, m));
}
export function gamesOf(db: DB, matchId: number): GameRow[] {
  return db.prepare('SELECT * FROM event_games WHERE event_match_id = ? ORDER BY ordinal').all(matchId) as GameRow[];
}
export function lineupsOf(db: DB, matchId: number): LineupRow[] {
  return db.prepare('SELECT * FROM event_lineups WHERE event_match_id = ? ORDER BY game, id').all(matchId) as LineupRow[];
}
/** The side this player manages in this match, or null (Ruling 10). */
export function sideOf(db: DB, m: P.MatchRow, steamid: string): Side | null {
  for (const side of ['a', 'b'] as const) {
    const id = side === 'a' ? m.entry_a : m.entry_b;
    const e = id !== null ? N.getEntry(db, id) : undefined;
    if (e && N.managersOf(db, e.team_id).includes(steamid)) return side;
  }
  return null;
}
/** Who may play: the entry's starters, then its subs (never the coach). */
export function playableOf(db: DB, entryId: number): string[] {
  const r = N.rosterOf(db, entryId);
  return [...r.starters, ...r.subs];
}
/** Anyone on either roster (coach included): who hears the room's pushes. */
export function isParticipant(db: DB, m: P.MatchRow, steamid: string): boolean {
  return [m.entry_a, m.entry_b].some((id) => {
    if (id === null) return false;
    const r = N.rosterOf(db, id);
    return [...r.starters, ...r.subs, ...(r.coach ? [r.coach] : [])].includes(steamid);
  });
}
export function busyEntries(db: DB, eventId: number): Set<number> {
  const rows = db.prepare(`SELECT entry_a, entry_b FROM event_matches WHERE event_id = ? AND status IN ${BUSY_SQL}`).all(eventId) as
    { entry_a: number | null; entry_b: number | null }[];
  return new Set(rows.flatMap((r) => [r.entry_a, r.entry_b]).filter((x): x is number => x !== null));
}

/** The match, its event and stage, both live, both teams known and in. */
function liveMatch(db: DB, matchId: number): V.Checked<{ m: P.MatchRow; ev: E.EventRow }> {
  const m = P.getMatch(db, matchId);
  if (!m) return V.fail('match_not_found');
  const ev = E.getEvent(db, m.event_id)!;
  const stage = E.getStage(db, m.stage_id)!;
  if (ev.status !== 'live' || stage.status !== 'live') return V.fail('not_live');
  if (m.entry_a === null || m.entry_b === null) return V.fail('match_not_open');
  if (![m.entry_a, m.entry_b].every((id) => N.isActive(N.getEntry(db, id)!))) return V.fail('entry_out');
  return V.ok({ m, ev });
}

/** event_games from the replay: one row per settled game, updated as sides
 *  are chosen. Inside the caller's transaction. */
function syncGames(db: DB, m: P.MatchRow, st: VetoState, at: string): void {
  const up = db.prepare(
    `INSERT INTO event_games (event_match_id, ordinal, campaign, picked_by, side_by, first_survivors, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (event_match_id, ordinal) DO UPDATE SET campaign = excluded.campaign, picked_by = excluded.picked_by,
       side_by = excluded.side_by, first_survivors = excluded.first_survivors`,
  );
  const id = (s: Side | null) => (s === null ? null : entryOn(m, s));
  for (const g of st.games) up.run(m.id, g.game, g.campaign, id(g.pickedBy), id(g.sideBy), id(g.firstSurvivors), at);
}

/** After both teams are ready or after a veto action: the next step's
 *  deadline, or the lineups once nothing is left for a person to do. */
function advance(db: DB, matchId: number, timers: RoomTimers, now: Date): void {
  const m = P.getMatch(db, matchId)!;
  const st = roomState(db, m);
  syncGames(db, m, st, iso(now));
  if (isHumanStep(st.next)) {
    db.prepare('UPDATE event_matches SET deadline = ? WHERE id = ?').run(plus(now, timers.stepSeconds * 1000), m.id);
  } else {
    db.prepare("UPDATE event_matches SET status = 'lineup', deadline = ? WHERE id = ?").run(plus(now, timers.lineupMinutes * 60_000), m.id);
  }
}

export function openRoom(db: DB, o: { matchId: number; by: string | null; higher: Side; seed: number; timers: RoomTimers; now?: Date }): V.Checked<P.MatchRow> {
  const now = o.now ?? new Date();
  const at = iso(now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (m.status !== 'waiting') return V.fail('wrong_status');
    const busy = busyEntries(db, ev.id);
    if (busy.has(m.entry_a!) || busy.has(m.entry_b!)) return V.fail('entry_busy');
    db.prepare(
      `UPDATE event_matches SET status = 'veto', room_opened_at = ?, room_higher = ?, room_seed = ?, ready_a_at = NULL, ready_b_at = NULL,
         deadline = ?, hold_reason = NULL WHERE id = ?`,
    ).run(at, o.higher, o.seed, plus(now, o.timers.readyMinutes * 60_000), m.id);
    E.logEvent(db, ev.id, o.by, 'room_opened', at, { matchId: m.id, higher: o.higher });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

export function readyUp(db: DB, o: { matchId: number; steamid: string; timers: RoomTimers; now?: Date }): V.Checked<P.MatchRow> {
  const now = o.now ?? new Date();
  const at = iso(now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (m.status !== 'veto' || (m.ready_a_at !== null && m.ready_b_at !== null)) return V.fail('not_ready_phase');
    if (m.deadline !== null && at >= m.deadline) return V.fail('room_closed');
    const side = sideOf(db, m, o.steamid);
    if (!side) return V.fail('not_manager');
    if ((side === 'a' ? m.ready_a_at : m.ready_b_at) !== null) return V.fail('already_ready');
    db.prepare(`UPDATE event_matches SET ${side === 'a' ? 'ready_a_at' : 'ready_b_at'} = ? WHERE id = ?`).run(at, m.id);
    if ((side === 'a' ? m.ready_b_at : m.ready_a_at) !== null) advance(db, m.id, o.timers, now);
    E.logEvent(db, ev.id, o.steamid, 'room_ready', at, { matchId: m.id, side });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

const HOLDABLE: ReadonlySet<P.MatchStatus> = new Set<P.MatchStatus>(['veto', 'lineup', 'booking']);

export function holdMatch(db: DB, o: { matchId: number; by: string | null; reason: string; now?: Date }): V.Checked<P.MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const m = P.getMatch(db, o.matchId);
    if (!m) return V.fail('match_not_found');
    if (!HOLDABLE.has(m.status)) return V.fail('wrong_status');
    db.prepare("UPDATE event_matches SET status = 'admin_hold', hold_reason = ?, deadline = NULL WHERE id = ?").run(o.reason.slice(0, 300), m.id);
    E.logEvent(db, m.event_id, o.by, 'match_held', at, { matchId: m.id, reason: o.reason.slice(0, 300) });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

const RESETTABLE: ReadonlySet<P.MatchStatus> = new Set<P.MatchStatus>(['veto', 'lineup', 'booking', 'admin_hold']);

export function resetRoom(db: DB, o: { matchId: number; by: string; now?: Date }): V.Checked<P.MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const m = P.getMatch(db, o.matchId);
    if (!m) return V.fail('match_not_found');
    if (!RESETTABLE.has(m.status)) return V.fail('wrong_status');
    for (const t of ['event_vetoes', 'event_games', 'event_lineups']) db.prepare(`DELETE FROM ${t} WHERE event_match_id = ?`).run(m.id);
    db.prepare(
      `UPDATE event_matches SET status = 'waiting', room_opened_at = NULL, room_higher = NULL, room_seed = NULL, ready_a_at = NULL,
         ready_b_at = NULL, deadline = NULL, hold_reason = NULL WHERE id = ?`,
    ).run(m.id);
    E.logEvent(db, m.event_id, o.by, 'room_reset', at, { matchId: m.id, from: m.status });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

/** Ruling 16: an overdue deadline found at start gets its phase's full
 *  length from now; anything else is refused as 'changed' and left alone. */
export function resumeDeadline(db: DB, o: { matchId: number; timers: RoomTimers; now?: Date }): V.Checked<P.MatchRow> {
  const now = o.now ?? new Date();
  const at = iso(now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const m = P.getMatch(db, o.matchId);
    if (!m || (m.status !== 'veto' && m.status !== 'lineup') || m.deadline === null || m.deadline > at) return V.fail('changed');
    const ready = m.status === 'veto' && (m.ready_a_at === null || m.ready_b_at === null);
    const ms = m.status === 'lineup' ? o.timers.lineupMinutes * 60_000 : ready ? o.timers.readyMinutes * 60_000 : o.timers.stepSeconds * 1000;
    db.prepare('UPDATE event_matches SET deadline = ? WHERE id = ?').run(plus(now, ms), m.id);
    E.logEvent(db, m.event_id, null, 'room_resumed', at, { matchId: m.id, was: m.deadline });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}
```

The `DELETE FROM ${t}` loop must still match the guard's regex for room tables; if the template literal hides the table names from the regex scan, write the three DELETE statements out in full instead.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/eventsSchema.test.ts tests/room.test.ts tests/eventFlow.test.ts tests/eventLogGuard.test.ts tests/eventPlayRoutes.test.ts`
Expected: PASS. If a T2 test fails because `recordResult` now writes `deadline = NULL`, that is only a missing column in an old assertion: update it.

- [ ] **Step 8: Commit**

```bash
git add src/db.ts src/settingsSchema.ts src/events/play.ts src/events/room.ts src/events/validate.ts tests/roomFixture.ts tests/room.test.ts tests/eventsSchema.test.ts tests/eventFlow.test.ts tests/eventLogGuard.test.ts
git commit -m "Tournaments T3a: match room tables, timers and the room writer's open, ready, hold, reset and resume; results close a room and a bracket sync never drops one"
```

---
### Task 4: Room writer, part 2 (veto actions, lineups, preferences)

**Files:**
- Modify: `src/events/room.ts`
- Test: `tests/room.test.ts`, `tests/eventLogGuard.test.ts`

**Interfaces:**
- Consumes: Task 3's `room.ts`, `applyVeto`, `isHumanStep` (Task 2).
- Produces in `room.ts`:
  - reads: `entryPrefs(db, entryId): { defaultFour: string[] | null; side: 'survivors' | 'infected' | null }`, `campaignPrefs(db, entryId, stageId): string[]`, `lastFour(db, entryId): string[] | null`, `autoFour(o: { defaultFour: string[] | null; lastFour: string[] | null; playable: string[] }): string[]`
  - mutations: `actVeto(db, { matchId, steamid: string | null, step: number, action: unknown, campaign: unknown, timers, now? }): V.Checked<P.MatchRow>` (steamid null is the clock acting for the team whose turn it is; the row is marked auto), `lockLineup(db, { matchId, steamid: string | null, side?: Side, steamids: unknown, timers, now? }): V.Checked<P.MatchRow>` (steamid null needs `side`; marked auto), `savePrefs(db, { entryId, by: string, staff: boolean, prefs: unknown, now? }): V.Checked<null>` where prefs is `{ defaultFour: string[] | null; side: 'survivors' | 'infected' | null; campaigns: Record<string, string[]> }` (stage id as the key).

- [ ] **Step 1: Write the failing tests**

Append to `tests/room.test.ts`:

```ts
const bothReady = (f: RoomFixture) => {
  open(f);
  ok(R.readyUp(f.db, { matchId: f.matchId, steamid: A[0], timers: TIMERS, now: at(1) }));
  ok(R.readyUp(f.db, { matchId: f.matchId, steamid: B[0], timers: TIMERS, now: at(1) }));
};
const veto = (f: RoomFixture, steamid: string | null, step: number, action: string, campaign: string | null = null, min = 2) =>
  R.actVeto(f.db, { matchId: f.matchId, steamid, step, action, campaign, timers: TIMERS, now: at(min) });

describe('actVeto', () => {
  it('runs a ban to one between the managers of each team and moves to lineups', async () => {
    const f = await roomFixture();
    bothReady(f);
    expect(veto(f, B[0], 0, 'first')).toEqual({ ok: false, error: 'not_your_turn' });
    ok(veto(f, A[1], 0, 'first'));
    expect(veto(f, A[0], 0, 'first')).toEqual({ ok: false, error: 'step_taken' });
    expect(veto(f, A[0], 1, 'ban', 'nowhere')).toEqual({ ok: false, error: 'bad_veto_action' });
    ok(veto(f, A[0], 1, 'ban', 'dead_air'));
    // Bats did not make the last ban, so Bats chooses sides on no_mercy.
    const m = ok(veto(f, B[0], 2, 'infected', null, 3));
    expect(m).toMatchObject({ status: 'lineup', deadline: at(8).toISOString() });
    expect(R.gamesOf(f.db, f.matchId)).toEqual([expect.objectContaining({ ordinal: 1, campaign: 'no_mercy', picked_by: null, side_by: f.entryB, first_survivors: f.entryA })]);
    const rows = f.db.prepare('SELECT step, side, entry_id, action, campaign, by_steamid, auto FROM event_vetoes ORDER BY step').all();
    expect(rows).toEqual([
      { step: 0, side: 'a', entry_id: f.entryA, action: 'first', campaign: null, by_steamid: A[1], auto: 0 },
      { step: 1, side: 'a', entry_id: f.entryA, action: 'ban', campaign: 'dead_air', by_steamid: A[0], auto: 0 },
      { step: 2, side: 'b', entry_id: f.entryB, action: 'infected', campaign: null, by_steamid: B[0], auto: 0 },
    ]);
  });

  it('acts for the team whose turn it is when the clock passes no steamid, marked auto', async () => {
    const f = await roomFixture();
    bothReady(f);
    ok(veto(f, null, 0, 'first'));
    expect(f.db.prepare('SELECT side, auto, by_steamid FROM event_vetoes').get()).toEqual({ side: 'a', auto: 1, by_steamid: null });
  });

  it('refuses before both teams are ready', async () => {
    const f = await roomFixture();
    open(f);
    expect(veto(f, A[0], 0, 'first')).toEqual({ ok: false, error: 'not_veto_phase' });
  });
});

describe('lockLineup', () => {
  const toLineups = async () => {
    const f = await roomFixture();
    bothReady(f);
    ok(veto(f, A[0], 0, 'first'));
    ok(veto(f, A[0], 1, 'ban', 'dead_air'));
    ok(veto(f, B[0], 2, 'survivors'));
    return f;
  };

  it('locks four from the starters and subs, hides nothing from the writer, and waits for the server once both are in', async () => {
    const f = await toLineups();
    expect(R.lockLineup(f.db, { matchId: f.matchId, steamid: A[0], steamids: [A[0], A[1], A[2]], timers: TIMERS, now: at(4) })).toEqual({ ok: false, error: 'bad_lineup' });
    expect(R.lockLineup(f.db, { matchId: f.matchId, steamid: A[0], steamids: [A[0], A[1], A[2], A[5]], timers: TIMERS, now: at(4) })).toEqual({ ok: false, error: 'bad_lineup' });
    expect(R.lockLineup(f.db, { matchId: f.matchId, steamid: A[0], steamids: [A[0], A[0], A[1], A[2]], timers: TIMERS, now: at(4) })).toEqual({ ok: false, error: 'bad_lineup' });
    ok(R.lockLineup(f.db, { matchId: f.matchId, steamid: A[0], steamids: [A[1], A[2], A[3], A[4]], timers: TIMERS, now: at(4) }));
    expect(R.lockLineup(f.db, { matchId: f.matchId, steamid: A[1], steamids: [A[0], A[1], A[2], A[3]], timers: TIMERS, now: at(4) })).toEqual({ ok: false, error: 'lineup_locked' });
    const m = ok(R.lockLineup(f.db, { matchId: f.matchId, steamid: null, side: 'b', steamids: B.slice(0, 4), timers: TIMERS, now: at(5) }));
    expect(m).toMatchObject({ status: 'booking', deadline: null });
    const log = f.db.prepare("SELECT detail FROM event_log WHERE action = 'lineup_locked' ORDER BY id").all() as { detail: string }[];
    // The audit row never names the players (Global Constraints: lineups are secret).
    expect(log.map((l) => JSON.parse(l.detail))).toEqual([{ matchId: f.matchId, side: 'a', auto: false }, { matchId: f.matchId, side: 'b', auto: true }]);
  });
});

describe('autoFour', () => {
  const playable = ['s1', 's2', 's3', 's4', 'sub1'];
  it('takes the default four, else the last four, else the roster order, skipping any that left the roster', () => {
    expect(R.autoFour({ defaultFour: ['s2', 's3', 's4', 'sub1'], lastFour: null, playable })).toEqual(['s2', 's3', 's4', 'sub1']);
    expect(R.autoFour({ defaultFour: ['s2', 's3', 's4', 'gone'], lastFour: ['s1', 's2', 's3', 'sub1'], playable })).toEqual(['s1', 's2', 's3', 'sub1']);
    expect(R.autoFour({ defaultFour: ['gone', 's2', 's3', 's4'], lastFour: ['gone', 's1', 's2', 's3'], playable })).toEqual(['s1', 's2', 's3', 's4']);
    expect(R.autoFour({ defaultFour: null, lastFour: null, playable: ['s1', 's2'] })).toEqual(['s1', 's2']);
  });
});

describe('savePrefs', () => {
  it('saves a default four, a side and a campaign order for a stage, for the team\'s managers only', async () => {
    const f = await roomFixture();
    const prefs = { defaultFour: [A[1], A[2], A[3], A[4]], side: 'infected', campaigns: { [String(f.stageId)]: ['dead_air', 'no_mercy'] } };
    expect(R.savePrefs(f.db, { entryId: f.entryA, by: A[3], staff: false, prefs, now: NOW })).toEqual({ ok: false, error: 'not_manager' });
    ok(R.savePrefs(f.db, { entryId: f.entryA, by: A[1], staff: false, prefs, now: NOW }));
    expect(R.entryPrefs(f.db, f.entryA)).toEqual({ defaultFour: [A[1], A[2], A[3], A[4]], side: 'infected' });
    expect(R.campaignPrefs(f.db, f.entryA, f.stageId)).toEqual(['dead_air', 'no_mercy']);
    ok(R.savePrefs(f.db, { entryId: f.entryA, by: ADMIN, staff: true, prefs: { defaultFour: null, side: null, campaigns: {} }, now: NOW }));
    expect(R.entryPrefs(f.db, f.entryA)).toEqual({ defaultFour: null, side: null });
    expect(R.campaignPrefs(f.db, f.entryA, f.stageId)).toEqual(['dead_air', 'no_mercy']);
  });

  it('refuses a coach in the four, a campaign outside the pool, a repeat, or another event\'s stage', async () => {
    const f = await roomFixture();
    const save = (prefs: object) => R.savePrefs(f.db, { entryId: f.entryA, by: A[0], staff: false, prefs, now: NOW });
    expect(save({ defaultFour: [A[0], A[1], A[2], 'nobody'], side: null, campaigns: {} })).toEqual({ ok: false, error: 'bad_prefs' });
    expect(save({ defaultFour: null, side: 'left', campaigns: {} })).toEqual({ ok: false, error: 'bad_prefs' });
    expect(save({ defaultFour: null, side: null, campaigns: { [String(f.stageId)]: ['dead_air', 'dead_air'] } })).toEqual({ ok: false, error: 'bad_prefs' });
    expect(save({ defaultFour: null, side: null, campaigns: { [String(f.stageId)]: ['swamp_fever_nope'] } })).toEqual({ ok: false, error: 'bad_prefs' });
    expect(save({ defaultFour: null, side: null, campaigns: { 99999: ['dead_air'] } })).toEqual({ ok: false, error: 'bad_prefs' });
  });
});
```

In `tests/eventLogGuard.test.ts`'s room guard, add to `ROOM_READS`: `'entryPrefs', 'campaignPrefs', 'lastFour', 'autoFour'`; and to `ROOM_MUTATIONS`:
- `actVeto`: action `veto_action`, actor `A[0]`, setup: open and both ready, run `actVeto(... steamid: A[0], step: 0, action: 'first' ...)`.
- `lockLineup`: `lineup_locked`, actor `A[0]`, setup: open, both ready, and the three veto actions of the ban to one test, run with `[A[1], A[2], A[3], A[4]]`.
- `savePrefs`: `prefs_saved`, actor `A[0]`, setup none, run with `{ defaultFour: null, side: 'survivors', campaigns: {} }`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/room.test.ts tests/eventLogGuard.test.ts`
Expected: FAIL (`R.actVeto` is not a function).

- [ ] **Step 3: Add the mutations and reads to `src/events/room.ts`**

Add `applyVeto` and `VetoActionKind` to the `./veto.js` import, then:

```ts
const ACTIONS: ReadonlySet<string> = new Set(['first', 'second', 'ban', 'pick', 'survivors', 'infected']);

export function actVeto(
  db: DB, o: { matchId: number; steamid: string | null; step: number; action: unknown; campaign: unknown; timers: RoomTimers; now?: Date },
): V.Checked<P.MatchRow> {
  const now = o.now ?? new Date();
  const at = iso(now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (m.status !== 'veto' || m.ready_a_at === null || m.ready_b_at === null) return V.fail('not_veto_phase');
    const inp = vetoInput(db, m);
    const st = vetoState(inp);
    if (o.step !== inp.actions.length || !isHumanStep(st.next)) return V.fail('step_taken');
    let side: Side;
    if (o.steamid === null) {
      side = st.next.by;
    } else {
      const s = sideOf(db, m, o.steamid);
      if (!s) return V.fail('not_manager');
      side = s;
    }
    if (typeof o.action !== 'string' || !ACTIONS.has(o.action) || !(o.campaign === null || o.campaign === undefined || typeof o.campaign === 'string')) {
      return V.fail('bad_veto_action');
    }
    const a: VetoAction = { side, action: o.action as VetoActionKind, campaign: (o.campaign as string | null | undefined) ?? null, auto: o.steamid === null };
    const r = applyVeto(inp, a);
    if (!r.ok) return V.fail(r.code);
    db.prepare(
      `INSERT INTO event_vetoes (event_match_id, step, side, entry_id, action, campaign, by_steamid, auto, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(m.id, o.step, side, entryOn(m, side), a.action, a.campaign, o.steamid, a.auto ? 1 : 0, at);
    advance(db, m.id, o.timers, now);
    E.logEvent(db, ev.id, o.steamid, 'veto_action', at, { matchId: m.id, step: o.step, side, action: a.action, campaign: a.campaign, auto: a.auto });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

/** Exactly four different players from the playable list, or null. */
function readFour(raw: unknown, playable: string[]): string[] | null {
  if (!Array.isArray(raw) || raw.length !== 4 || new Set(raw).size !== 4) return null;
  return raw.every((s) => typeof s === 'string' && playable.includes(s)) ? (raw as string[]) : null;
}

export function lastFour(db: DB, entryId: number): string[] | null {
  const row = db.prepare('SELECT steamids FROM event_lineups WHERE entry_id = ? ORDER BY locked_at DESC, id DESC LIMIT 1').get(entryId) as
    { steamids: string } | undefined;
  return row ? JSON.parse(row.steamids) as string[] : null;
}

/** Ruling 9: the default four, else the last four, else the roster order.
 *  May return fewer than four when the roster is short; lockLineup then
 *  refuses it and the clock holds the match. */
export function autoFour(o: { defaultFour: string[] | null; lastFour: string[] | null; playable: string[] }): string[] {
  for (const four of [o.defaultFour, o.lastFour]) if (four && four.length === 4 && four.every((s) => o.playable.includes(s))) return four;
  return o.playable.slice(0, 4);
}

export function lockLineup(
  db: DB, o: { matchId: number; steamid: string | null; side?: Side; steamids: unknown; timers: RoomTimers; now?: Date },
): V.Checked<P.MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (m.status !== 'lineup') return V.fail('not_lineup_phase');
    const side = o.steamid === null ? o.side ?? null : sideOf(db, m, o.steamid);
    if (!side) return V.fail('not_manager');
    const entryId = entryOn(m, side);
    if (lineupsOf(db, m.id).some((l) => l.game === 1 && l.entry_id === entryId)) return V.fail('lineup_locked');
    const four = readFour(o.steamids, playableOf(db, entryId));
    if (!four) return V.fail('bad_lineup');
    db.prepare('INSERT INTO event_lineups (event_match_id, game, entry_id, steamids, locked_by, auto, locked_at) VALUES (?, 1, ?, ?, ?, ?, ?)')
      .run(m.id, entryId, JSON.stringify(four), o.steamid, o.steamid === null ? 1 : 0, at);
    if (lineupsOf(db, m.id).filter((l) => l.game === 1).length === 2) {
      db.prepare("UPDATE event_matches SET status = 'booking', deadline = NULL WHERE id = ?").run(m.id);
    }
    E.logEvent(db, ev.id, o.steamid, 'lineup_locked', at, { matchId: m.id, side, auto: o.steamid === null });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

export function entryPrefs(db: DB, entryId: number): { defaultFour: string[] | null; side: 'survivors' | 'infected' | null } {
  const row = db.prepare('SELECT default_four, side FROM event_entry_prefs WHERE entry_id = ?').get(entryId) as
    { default_four: string | null; side: 'survivors' | 'infected' | null } | undefined;
  return { defaultFour: row?.default_four ? JSON.parse(row.default_four) as string[] : null, side: row?.side ?? null };
}
export function campaignPrefs(db: DB, entryId: number, stageId: number): string[] {
  const row = db.prepare('SELECT campaigns FROM event_campaign_prefs WHERE entry_id = ? AND stage_id = ?').get(entryId, stageId) as
    { campaigns: string } | undefined;
  return row ? JSON.parse(row.campaigns) as string[] : [];
}

const PREFS_OPEN: ReadonlySet<string> = new Set(['announced', 'registration', 'checkin', 'live']);

/** A team's managers (or staff) save what the timers act from. Stages not
 *  named keep their saved order. */
export function savePrefs(db: DB, o: { entryId: number; by: string; staff: boolean; prefs: unknown; now?: Date }): V.Checked<null> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<null> => {
    const entry = N.getEntry(db, o.entryId);
    if (!entry) return V.fail('entry_not_found');
    const ev = E.getEvent(db, entry.event_id)!;
    if (!PREFS_OPEN.has(ev.status) || !N.isActive(entry)) return V.fail('entry_out');
    if (!o.staff && !N.managersOf(db, entry.team_id).includes(o.by)) return V.fail('not_manager');
    const p = o.prefs as { defaultFour?: unknown; side?: unknown; campaigns?: unknown } | null;
    if (typeof p !== 'object' || p === null) return V.fail('bad_prefs');
    const four = p.defaultFour === null || p.defaultFour === undefined ? null : readFour(p.defaultFour, playableOf(db, entry.id));
    if (four === null && p.defaultFour !== null && p.defaultFour !== undefined) return V.fail('bad_prefs');
    const side = p.side ?? null;
    if (side !== null && side !== 'survivors' && side !== 'infected') return V.fail('bad_prefs');
    const campaigns = p.campaigns ?? {};
    if (typeof campaigns !== 'object' || campaigns === null || Array.isArray(campaigns)) return V.fail('bad_prefs');
    const stages = new Map(E.stagesOf(db, ev.id).map((s) => [String(s.id), E.stageSettingsOf(s).campaignPool]));
    const orders: [number, string[]][] = [];
    for (const [key, list] of Object.entries(campaigns as Record<string, unknown>)) {
      const pool = stages.get(key);
      if (!pool || !Array.isArray(list) || new Set(list).size !== list.length || !list.every((c) => typeof c === 'string' && pool.includes(c))) {
        return V.fail('bad_prefs');
      }
      orders.push([Number(key), list as string[]]);
    }
    db.prepare(
      `INSERT INTO event_entry_prefs (entry_id, default_four, side, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (entry_id) DO UPDATE SET default_four = excluded.default_four, side = excluded.side,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).run(entry.id, four ? JSON.stringify(four) : null, side, o.by, at);
    const up = db.prepare(
      `INSERT INTO event_campaign_prefs (entry_id, stage_id, campaigns, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (entry_id, stage_id) DO UPDATE SET campaigns = excluded.campaigns, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    );
    for (const [stageId, list] of orders) up.run(entry.id, stageId, JSON.stringify(list), o.by, at);
    E.logEvent(db, ev.id, o.by, 'prefs_saved', at, { entryId: entry.id, stages: orders.map(([s]) => s) });
    return V.ok(null);
  })();
}
```

Note the `savePrefs` test's first refusal: `A[3]` is a member, not a manager, so `not_manager`. A[5] is on team A but not on the entry's roster in `rosterA()` (starters A[0..3], sub A[4]), which is why `[A[0], A[1], A[2], A[5]]` is a `bad_lineup`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/room.test.ts tests/eventLogGuard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/events/room.ts tests/room.test.ts tests/eventLogGuard.test.ts
git commit -m "Tournaments T3a: veto actions by step with the clock acting for a team, secret four-player lineups, and team preferences for the timers"
```

---
### Task 5: The room clock, forfeits and the two DMs

**Files:**
- Create: `src/events/roomClock.ts`
- Modify: `src/events/flow.ts` (`forfeitMatch`; settle's disqualification loop), `src/events/messages.ts`, `src/events/notices.ts`, `src/notify/notify.ts`, `src/server.ts` (next to the `EventRunner` lines near 2062)
- Test: `tests/roomClock.test.ts` (new), `tests/eventFlow.test.ts`, `tests/notify.test.ts` (or wherever `NOTIFY_TYPES` is pinned; `grep -rln NOTIFY_TYPES tests`)

**Interfaces:**
- Consumes: Task 3 and 4 `room.ts`; `autoAction`, `isHumanStep` (Task 2); `serialize`, `report`, `settleEvent`, `stageTable` (flow.ts).
- Produces in `flow.ts`: `forfeitMatch(db, { eventId, matchId, winner: 'a' | 'b', expect: (m: P.MatchRow) => boolean, now? }): Promise<V.Checked<P.MatchRow>>`. `expect` is checked inside the event's chain right before the result, and a false answer is `changed` (Ruling 12).
- Produces in `roomClock.ts`:
  - `ROOM_TICK_MS = 5_000`
  - `higherSide(db, m: P.MatchRow): Side`
  - `dueRooms(db, now: Date): P.MatchRow[]`
  - `class RoomClock { constructor(deps: { db: DB; notifier?: Notifier; publicUrl?: string; push?: (matchId: number) => void; now?: () => number; seed?: () => number }); resume(): void; tick(): Promise<void> }`
- Produces in `notices.ts`: `tellRoomOpen(d, eventId, matchId)`, `tellReadyForfeit(d, eventId, matchId)`; in `messages.ts` the types `event_match_room` and `event_match_forfeit` with `extra.matchId`.

- [ ] **Step 1: Write the failing tests**

Create `tests/roomClock.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import * as P from '../src/events/play.js';
import * as R from '../src/events/room.js';
import { RoomClock, dueRooms, higherSide } from '../src/events/roomClock.js';
import type { Notifier } from '../src/notify/notify.js';
import { NOW } from './eventFixture.js';
import { A, B } from './entryFixture.js';
import { TIMERS, roomFixture, type RoomFixture } from './roomFixture.js';
import { SE, playFixture } from './playFixture.js';

const at = (min: number) => NOW.getTime() + min * 60_000;
const clockAt = (f: RoomFixture, ms: { t: number }) => {
  const send = vi.fn(() => 1);
  const push = vi.fn();
  const clock = new RoomClock({ db: f.db, notifier: { send } as unknown as Notifier, publicUrl: 'https://x', push, now: () => ms.t, seed: () => 5 });
  return { clock, send, push };
};
const match = (f: RoomFixture) => P.getMatch(f.db, f.matchId)!;

describe('RoomClock: opening rooms', () => {
  it('opens a waiting rolling match, DMs both rosters, and pushes', async () => {
    const f = await roomFixture();
    const t = { t: at(0) };
    const { clock, send, push } = clockAt(f, t);
    await clock.tick();
    expect(match(f)).toMatchObject({ status: 'veto', room_higher: 'a', room_seed: 5 });
    expect(send).toHaveBeenCalledWith(expect.arrayContaining([A[0], A[4], B[0], B[3]]), 'event_match_room', expect.anything());
    expect(push).toHaveBeenCalledWith(f.matchId);
  });

  it('does not open a window stage, or a match whose not_before is still ahead', async () => {
    const f = await roomFixture();
    f.db.prepare("UPDATE event_stages SET scheduling = 'window' WHERE id = ?").run(f.stageId);
    expect(dueRooms(f.db, new Date(at(0)))).toEqual([]);
    f.db.prepare("UPDATE event_stages SET scheduling = 'rolling' WHERE id = ?").run(f.stageId);
    f.db.prepare('UPDATE event_matches SET not_before = ? WHERE id = ?').run(new Date(at(30)).toISOString(), f.matchId);
    expect(dueRooms(f.db, new Date(at(0)))).toEqual([]);
    expect(dueRooms(f.db, new Date(at(30))).map((m) => m.id)).toEqual([f.matchId]);
  });

  it('opens only each team\'s earliest match, one room per team at a time', async () => {
    const f = playFixture({ stages: [{ type: 'round_robin', config: { groups: 1 }, advanceCount: null }], entries: 4 });
    const { startEventFlow } = await import('../src/events/flow.js');
    await startEventFlow(f.db, { eventId: f.eventId, by: null, now: new Date(at(0)) });
    const due = dueRooms(f.db, new Date(at(0)));
    const teams = due.flatMap((m) => [m.entry_a, m.entry_b]);
    expect(new Set(teams).size).toBe(teams.length);
    expect(due.every((m) => m.round === 1)).toBe(true);
  });

  it('picks the higher seed by stage seed in a bracket, by standing in a table stage', async () => {
    const f = playFixture({ stages: [SE()], entries: 4 });
    const { startEventFlow } = await import('../src/events/flow.js');
    await startEventFlow(f.db, { eventId: f.eventId, by: null, now: new Date(at(0)) });
    const first = P.matchesOf(f.db, f.stages[0]!).find((m) => m.status === 'waiting')!;
    const seedA = f.entries.indexOf(first.entry_a!);
    const seedB = f.entries.indexOf(first.entry_b!);
    expect(higherSide(f.db, first)).toBe(seedA < seedB ? 'a' : 'b');
  });
});

describe('RoomClock: deadlines', () => {
  it('forfeits the team that did not ready up, and tells both rosters', async () => {
    const f = await roomFixture();
    const t = { t: at(0) };
    const { clock, send } = clockAt(f, t);
    await clock.tick();
    R.readyUp(f.db, { matchId: f.matchId, steamid: B[0], timers: TIMERS, now: new Date(at(1)) });
    t.t = at(10);
    await clock.tick();
    expect(match(f)).toMatchObject({ status: 'forfeit', winner_entry: f.entryB, result_source: 'forfeit' });
    expect(send).toHaveBeenCalledWith(expect.arrayContaining([A[0], B[0]]), 'event_match_forfeit', expect.anything());
  });

  it('holds a match nobody readied up for', async () => {
    const f = await roomFixture();
    const t = { t: at(0) };
    const { clock } = clockAt(f, t);
    await clock.tick();
    t.t = at(10);
    await clock.tick();
    expect(match(f)).toMatchObject({ status: 'admin_hold', hold_reason: 'nobody_ready' });
  });

  it('acts for a team that ran out of time on a veto step, from its saved order', async () => {
    const f = await roomFixture();
    R.savePrefs(f.db, { entryId: f.entryA, by: A[0], staff: false, prefs: { defaultFour: null, side: null, campaigns: { [String(f.stageId)]: ['dead_air', 'no_mercy'] } }, now: new Date(at(0)) });
    const t = { t: at(0) };
    const { clock } = clockAt(f, t);
    await clock.tick();
    R.readyUp(f.db, { matchId: f.matchId, steamid: A[0], timers: TIMERS, now: new Date(at(1)) });
    R.readyUp(f.db, { matchId: f.matchId, steamid: B[0], timers: TIMERS, now: new Date(at(1)) });
    t.t = at(2);
    await clock.tick(); // order step: goes first
    t.t = at(3);
    await clock.tick(); // a bans its least wanted: no_mercy
    const rows = f.db.prepare('SELECT action, campaign, auto FROM event_vetoes ORDER BY step').all();
    expect(rows).toEqual([{ action: 'first', campaign: null, auto: 1 }, { action: 'ban', campaign: 'no_mercy', auto: 1 }]);
  });

  it('locks a default four for a team that ran out of time on its lineup, and holds a team that is short', async () => {
    const f = await roomFixture();
    R.savePrefs(f.db, { entryId: f.entryA, by: A[0], staff: false, prefs: { defaultFour: [A[1], A[2], A[3], A[4]], side: null, campaigns: {} }, now: new Date(at(0)) });
    const t = { t: at(0) };
    const { clock } = clockAt(f, t);
    await clock.tick();
    R.readyUp(f.db, { matchId: f.matchId, steamid: A[0], timers: TIMERS, now: new Date(at(1)) });
    R.readyUp(f.db, { matchId: f.matchId, steamid: B[0], timers: TIMERS, now: new Date(at(1)) });
    for (const min of [2, 3, 4]) { t.t = at(min); await clock.tick(); }
    expect(match(f).status).toBe('lineup');
    // Bats lose a starter from the roster: three left, no subs.
    f.db.prepare("UPDATE event_entry_players SET removed_at = 'x' WHERE entry_id = ? AND steamid = ?").run(f.entryB, B[3]);
    t.t = at(20);
    await clock.tick();
    expect(R.lineupsOf(f.db, f.matchId).map((l) => JSON.parse(l.steamids))).toEqual([[A[1], A[2], A[3], A[4]]]);
    expect(match(f)).toMatchObject({ status: 'admin_hold', hold_reason: 'lineup_short' });
  });

  it('gives overdue deadlines their full length on resume, so downtime acts for nobody', async () => {
    const f = await roomFixture();
    const t = { t: at(0) };
    const { clock } = clockAt(f, t);
    await clock.tick();
    t.t = at(60);
    clock.resume();
    expect(match(f).deadline).toBe(new Date(at(70)).toISOString());
    await clock.tick();
    expect(match(f).status).toBe('veto');
  });
});
```

Append to `tests/eventFlow.test.ts`:

```ts
  it('forfeitMatch refuses when the match moved on before its turn in the chain (plan T3a Ruling 12)', async () => {
    const f = await roomFixture();
    must(R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS, now: NOW }));
    must(await recordResultFlow(f.db, { eventId: f.eventId, matchId: f.matchId, by: ADMIN, result: { winner: 'a', scoreA: 9, scoreB: 1 }, now: NOW }));
    const r = await forfeitMatch(f.db, { eventId: f.eventId, matchId: f.matchId, winner: 'b', expect: (m) => m.status === 'veto', now: NOW });
    expect(r).toEqual({ ok: false, error: 'changed' });
    expect(P.getMatch(f.db, f.matchId)).toMatchObject({ status: 'done', winner_entry: f.entryA });
  });

  it('forfeits a disqualified team\'s open room on settle (plan T3a Ruling 15)', async () => {
    const f = await roomFixture();
    must(R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS, now: NOW }));
    f.db.prepare("UPDATE event_entries SET status = 'disqualified' WHERE id = ?").run(f.entryB);
    await settleEvent(f.db, { eventId: f.eventId, now: NOW });
    expect(P.getMatch(f.db, f.matchId)).toMatchObject({ status: 'forfeit', winner_entry: f.entryA });
  });
```

(Use the real disqualify mutation from `entries.ts` instead of the raw UPDATE if the file's other disqualification tests do; the raw UPDATE is test setup only.)

Pin the two new notify types where `NOTIFY_TYPES` is tested.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/roomClock.test.ts tests/eventFlow.test.ts`
Expected: FAIL (no `roomClock.ts`, no `forfeitMatch`).

- [ ] **Step 3: flow.ts**

Add:

```ts
/** A forfeit the room's clock decides (plan T3a Ruling 2). expect re-checks
 *  the match inside the event's chain, so an admin result or a reset that
 *  landed first is never overwritten (Ruling 12). Settles after, as a
 *  result does. */
export async function forfeitMatch(
  db: DB, o: { eventId: number; matchId: number; winner: 'a' | 'b'; expect: (m: P.MatchRow) => boolean; now?: Date },
): Promise<V.Checked<P.MatchRow>> {
  const r = await serialize(o.eventId, async (): Promise<V.Checked<P.MatchRow>> => {
    const m = P.getMatch(db, o.matchId);
    if (!m || m.event_id !== o.eventId) return V.fail('match_not_found');
    if (!o.expect(m)) return V.fail('changed');
    return report(db, m, null, { winner: o.winner, scoreA: null, scoreB: null, forfeit: true }, o.now);
  });
  if (r.ok) {
    try {
      await settleEvent(db, { eventId: o.eventId, now: o.now });
    } catch (err) {
      console.error(`[events] settle after a forfeit in event ${o.eventId} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return r;
}
```

In `settleOnce`, widen both `status !== 'waiting'` checks of the disqualification loop to `!(m.status === 'waiting' || P.ROOM_OPEN.has(m.status))` (same for `snap`).

- [ ] **Step 4: Messages, notices, notify types**

In `src/notify/notify.ts`, add `| 'event_match_room' | 'event_match_forfeit'` to `NotifyType`, and to `NOTIFY_TYPES`:

```ts
  { type: 'event_match_room', label: 'My tournament match room opens: ready up and veto' },
  { type: 'event_match_forfeit', label: 'A tournament match of mine is a forfeit because a team did not ready up' },
```

In `src/events/messages.ts`, add the two types to `EventNotifyType`, `matchId?: number` to `extra`, and the cases (with `import * as P from './play.js'` and `import { roomTimers } from './room.js'`):

```ts
    case 'event_match_room':
    case 'event_match_forfeit': {
      const m = extra.matchId !== undefined ? P.getMatch(db, extra.matchId) : undefined;
      if (!m || m.entry_a === null || m.entry_b === null) return null;
      const a = escapeName(getEntry(db, m.entry_a)?.name ?? 'Team A');
      const b = escapeName(getEntry(db, m.entry_b)?.name ?? 'Team B');
      if (type === 'event_match_room') {
        content = `${a} vs ${b} in ${event}: the match room is open. A captain or co-captain of each team presses Ready within ${roomTimers(db).readyMinutes} minutes; a team that does not loses by forfeit.`;
      } else {
        const winner = m.winner_entry === m.entry_a ? a : b;
        const loser = m.winner_entry === m.entry_a ? b : a;
        content = `${a} vs ${b} in ${event} is a forfeit win for ${winner}: ${loser} did not ready up in time.`;
      }
      return {
        content, embeds: [],
        components: [[{ kind: 'link', url: `${publicUrl}/event/${ev.slug}/match/${m.id}`, label: 'Open the match room' }]],
        mentionUserIds: [],
      };
    }
```

(`content` is declared with `let` above the switch already; the early `return` is fine for these two cases.)

In `src/events/notices.ts`:

```ts
/** Everyone on either roster of a match: starters, subs and coach (Ruling 2). */
function rostersOf(d: NoticeDeps, matchId: number): string[] {
  const m = P.getMatch(d.db, matchId);
  if (!m) return [];
  return [m.entry_a, m.entry_b].flatMap((id) => {
    if (id === null) return [];
    const r = N.rosterOf(d.db, id);
    return [...r.starters, ...r.subs, ...(r.coach ? [r.coach] : [])];
  });
}

export function tellRoomOpen(d: NoticeDeps, eventId: number, matchId: number): void {
  tell(d, rostersOf(d, matchId), eventId, 'event_match_room', { matchId });
}
export function tellReadyForfeit(d: NoticeDeps, eventId: number, matchId: number): void {
  tell(d, rostersOf(d, matchId), eventId, 'event_match_forfeit', { matchId });
}
```

- [ ] **Step 5: Write `src/events/roomClock.ts`**

```ts
import { randomInt } from 'node:crypto';
import type { DB } from '../db.js';
import type { Notifier } from '../notify/notify.js';
import * as E from './events.js';
import * as N from './entries.js';
import * as P from './play.js';
import * as R from './room.js';
import { forfeitMatch, stageTable } from './flow.js';
import { tellReadyForfeit, tellRoomOpen } from './notices.js';
import { autoAction, isHumanStep, type Side } from './veto.js';

export const ROOM_TICK_MS = 5_000;

/**
 * The match room's clock (tournaments plan T3a), every 5 seconds. It opens
 * rooms in rolling stages (Ruling 2) and acts on every passed deadline: the
 * ready check (forfeit or hold), a veto step (from the team's saved order,
 * Ruling 7), the lineups (Ruling 9). resume() runs once at start (Ruling
 * 16). Each match is caught on its own, so one bad row never stops the rest;
 * every change is pushed so the room page refetches.
 */

/** Ruling 5. */
export function higherSide(db: DB, m: P.MatchRow): Side {
  const stage = E.getStage(db, m.stage_id)!;
  const entrants = P.stageEntrants(stage);
  const seed = (id: number) => (entrants.indexOf(id) < 0 ? 1_000_000 : entrants.indexOf(id));
  let rank = seed;
  if (stage.type === 'swiss' || stage.type === 'league' || stage.type === 'round_robin') {
    const pos = new Map(stageTable(db, stage).map((r) => [r.entryId, r.rank]));
    rank = (id) => (pos.get(id) ?? 1_000_000) * 1000 + seed(id);
  }
  return rank(m.entry_a!) <= rank(m.entry_b!) ? 'a' : 'b';
}

/** Rolling-stage matches whose room may open now: both teams known and
 *  still in, not_before passed, each team's earliest unresolved match of the
 *  stage, neither team busy, at most one room per team. */
export function dueRooms(db: DB, now: Date): P.MatchRow[] {
  const rows = db.prepare(
    `SELECT m.* FROM event_matches m JOIN event_stages s ON s.id = m.stage_id JOIN events e ON e.id = m.event_id
     WHERE e.status = 'live' AND s.status = 'live' AND s.scheduling = 'rolling' AND m.status = 'waiting'
       AND m.entry_a IS NOT NULL AND m.entry_b IS NOT NULL AND (m.not_before IS NULL OR m.not_before <= ?)
     ORDER BY m.event_id, m.round, m.grp, m.slot`,
  ).all(now.toISOString()) as P.MatchRow[];
  const out: P.MatchRow[] = [];
  const taken = new Map<number, Set<number>>();
  for (const m of rows) {
    if (!taken.has(m.event_id)) taken.set(m.event_id, R.busyEntries(db, m.event_id));
    const busy = taken.get(m.event_id)!;
    const ids = [m.entry_a!, m.entry_b!];
    if (ids.some((id) => busy.has(id) || !N.isActive(N.getEntry(db, id)!))) continue;
    if (ids.some((id) => earliestOf(db, m.stage_id, id) !== m.id)) continue;
    ids.forEach((id) => busy.add(id));
    out.push(m);
  }
  return out;
}

function earliestOf(db: DB, stageId: number, entryId: number): number | undefined {
  const row = db.prepare(
    `SELECT id FROM event_matches WHERE stage_id = ? AND (entry_a = ? OR entry_b = ?) AND status NOT IN ('done','forfeit','bye')
     ORDER BY round, grp, slot LIMIT 1`,
  ).get(stageId, entryId, entryId) as { id: number } | undefined;
  return row?.id;
}

export class RoomClock {
  private ticking = false;
  private readonly now: () => number;

  constructor(private readonly deps: {
    db: DB; notifier?: Notifier; publicUrl?: string; push?: (matchId: number) => void; now?: () => number; seed?: () => number;
  }) {
    this.now = deps.now ?? Date.now;
  }

  private push(matchId: number): void {
    try { this.deps.push?.(matchId); } catch (err) { console.warn('[rooms] push failed:', err instanceof Error ? err.message : err); }
  }

  /** Ruling 16, once at start. */
  resume(): void {
    const { db } = this.deps;
    const now = new Date(this.now());
    const timers = R.roomTimers(db);
    const rows = db.prepare(
      "SELECT id FROM event_matches WHERE status IN ('veto','lineup') AND deadline IS NOT NULL AND deadline <= ?",
    ).all(now.toISOString()) as { id: number }[];
    for (const { id } of rows) {
      try { R.resumeDeadline(db, { matchId: id, timers, now }); } catch (err) { console.error(`[rooms] resume of match ${id} failed:`, err); }
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = new Date(this.now());
      this.openDue(now);
      await this.expire(now);
    } catch (err) {
      console.error('[rooms] tick failed:', err instanceof Error ? err.message : err);
    } finally {
      this.ticking = false;
    }
  }

  private openDue(now: Date): void {
    const { db } = this.deps;
    const timers = R.roomTimers(db);
    for (const m of dueRooms(db, now)) {
      try {
        const r = R.openRoom(db, { matchId: m.id, by: null, higher: higherSide(db, m), seed: this.deps.seed?.() ?? randomInt(2 ** 31), timers, now });
        if (!r.ok) continue;
        tellRoomOpen(this.deps, m.event_id, m.id);
        this.push(m.id);
      } catch (err) {
        console.error(`[rooms] open of match ${m.id} failed:`, err instanceof Error ? err.message : err);
      }
    }
  }

  private async expire(now: Date): Promise<void> {
    const { db } = this.deps;
    const rows = db.prepare(
      "SELECT * FROM event_matches WHERE status IN ('veto','lineup') AND deadline IS NOT NULL AND deadline <= ? ORDER BY deadline, id",
    ).all(now.toISOString()) as P.MatchRow[];
    for (const m of rows) {
      try {
        await this.expireOne(m, now);
      } catch (err) {
        console.error(`[rooms] deadline of match ${m.id} failed:`, err instanceof Error ? err.message : err);
      }
    }
  }

  private async expireOne(m: P.MatchRow, now: Date): Promise<void> {
    const { db } = this.deps;
    const timers = R.roomTimers(db);
    if (m.status === 'veto' && (m.ready_a_at === null || m.ready_b_at === null)) {
      const a = m.ready_a_at !== null;
      const b = m.ready_b_at !== null;
      if (a !== b) {
        const r = await forfeitMatch(db, {
          eventId: m.event_id, matchId: m.id, winner: a ? 'a' : 'b', now,
          expect: (x) => x.status === 'veto' && x.ready_a_at === m.ready_a_at && x.ready_b_at === m.ready_b_at,
        });
        if (r.ok) tellReadyForfeit(this.deps, m.event_id, m.id);
      } else {
        R.holdMatch(db, { matchId: m.id, by: null, reason: 'nobody_ready', now });
      }
      this.push(m.id);
      return;
    }
    if (m.status === 'veto') {
      const st = R.roomState(db, m);
      if (!isHumanStep(st.next)) return;
      const stage = E.getStage(db, m.stage_id)!;
      const entryId = R.entryOn(m, st.next.by);
      const pool = E.stageSettingsOf(stage).campaignPool;
      const a = autoAction(st, pool, { campaigns: R.campaignPrefs(db, entryId, stage.id), side: R.entryPrefs(db, entryId).side });
      R.actVeto(db, { matchId: m.id, steamid: null, step: st.used, action: a.action, campaign: a.campaign, timers, now });
      this.push(m.id);
      return;
    }
    const locked = new Set(R.lineupsOf(db, m.id).filter((l) => l.game === 1).map((l) => l.entry_id));
    for (const side of ['a', 'b'] as const) {
      const entryId = R.entryOn(m, side);
      if (locked.has(entryId)) continue;
      const four = R.autoFour({ defaultFour: R.entryPrefs(db, entryId).defaultFour, lastFour: R.lastFour(db, entryId), playable: R.playableOf(db, entryId) });
      const r = R.lockLineup(db, { matchId: m.id, steamid: null, side, steamids: four, timers, now });
      if (!r.ok && r.error === 'bad_lineup') {
        R.holdMatch(db, { matchId: m.id, by: null, reason: 'lineup_short', now });
        break;
      }
    }
    this.push(m.id);
  }
}
```

- [ ] **Step 6: Wire it into the server**

In `src/server.ts`, right after the `EventRunner` lines:

```ts
  // Tournaments plan T3a: the match room clock. Overdue deadlines from
  // before this start get their full length again (Ruling 16), then every
  // 5 s it opens rooms and acts on deadlines. Pushes go to the two rosters
  // and staff only (Ruling 17).
  const roomClock = new RoomClock({
    db: deps.db, notifier, publicUrl: deps.config.publicUrl,
    push: (matchId) => {
      const m = getEventMatch(deps.db, matchId);
      if (m) hub.sendTo('event_room', (id) => isActiveStaff(deps.db, id) || isRoomParticipant(deps.db, m, id));
    },
  });
  roomClock.resume();
  const roomTick = setInterval(() => { void roomClock.tick(); }, ROOM_TICK_MS);
  roomTick.unref();
```

with imports `import { RoomClock, ROOM_TICK_MS } from './events/roomClock.js';`, `import { getMatch as getEventMatch } from './events/play.js';`, `import { isParticipant as isRoomParticipant } from './events/room.js';`. `isActiveStaff` is already imported (server chat uses it). Pass `roomClock` to `eventRoutes` and `adminEventRoutes` options as `rooms: roomClock` (Task 6 uses its `push`); make `RoomClock.push` public for that (rename the private method to `pushChange(matchId)` and expose it).

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/roomClock.test.ts tests/eventFlow.test.ts tests/room.test.ts tests/eventRunner.test.ts && npm run typecheck`
Expected: PASS. In the veto timeout test, the stage pool is `['no_mercy', 'dead_air']` and Rats saved `['dead_air', 'no_mercy']`, so the least wanted is `no_mercy`.

- [ ] **Step 8: Commit**

```bash
git add src/events/roomClock.ts src/events/flow.ts src/events/messages.ts src/events/notices.ts src/notify/notify.ts src/server.ts tests/roomClock.test.ts tests/eventFlow.test.ts tests/notify.test.ts
git commit -m "Tournaments T3a: a 5 second room clock opens rolling match rooms, forfeits or holds at the ready deadline, acts for teams that run out of time, and resumes deadlines after a restart"
```

---
### Task 6: Room views and routes

**Files:**
- Create: `src/events/roomViews.ts`
- Modify: `src/events/playViews.ts` (`PlayMatch.phase`), `src/routes/events.ts`, `src/routes/adminEvents.ts`, `src/server.ts` (pass `rooms`)
- Test: `tests/roomViews.test.ts` (new), `tests/eventRoomRoutes.test.ts` (new), `tests/adminEventRoutes.test.ts`

**Interfaces:**
- Consumes: `room.ts` reads (Tasks 3, 4), `RoomClock.pushChange`, `higherSide`, `roomTimers`.
- Produces in `playViews.ts`: `type RoomPhase = 'pending' | 'waiting' | 'ready' | 'veto' | 'lineup' | 'server' | 'hold' | 'done'`, `phaseOf(m): RoomPhase`, and `PlayMatch.phase: RoomPhase` (`roomViews.ts` re-exports `RoomPhase` and `phaseOf`).
- Produces in `roomViews.ts`:

```ts
export interface RoomCampaign { slug: string; name: string; state: 'open' | 'banned' | 'picked' | 'decider'; by: 'a' | 'b' | null; game: number | null }
export interface RoomLogLine { step: number; side: 'a' | 'b'; action: VetoActionKind; campaign: string | null; campaignName: string | null; auto: boolean; at: string }
export interface RoomGame { game: number; campaign: string; campaignName: string; pickedBy: 'a' | 'b' | null; sideBy: 'a' | 'b' | null; firstSurvivors: 'a' | 'b' | null }
export interface RoomPlayer { steamid: string; name: string }
export interface MatchRoomView {
  id: number; eventSlug: string; eventName: string; roundLabel: string; a: PlayEntry; b: PlayEntry; phase: RoomPhase;
  higher: 'a' | 'b' | null; deadline: string | null; serverNow: string; ready: { a: boolean; b: boolean };
  vetoSummary: string; pool: RoomCampaign[]; log: RoomLogLine[]; games: RoomGame[];
  next: { kind: 'order' | 'ban' | 'pick' | 'side'; by: 'a' | 'b'; game: number | null; step: number } | { kind: 'wait'; game: number } | null;
  lineups: { a: RoomPlayer[] | null; b: RoomPlayer[] | null; aLocked: boolean; bLocked: boolean };
  holdReason: string | null;
  result: { winner: 'a' | 'b'; scoreA: number | null; scoreB: number | null; forfeit: boolean } | null;
  me: { side: 'a' | 'b'; manager: boolean; playable: RoomPlayer[]; defaultFour: string[] | null } | null;
}
export function matchRoomView(db: DB, ev: E.EventRow, m: P.MatchRow, viewer: string | null, staff: boolean, now?: Date): MatchRoomView
export interface PrefsView { entryId: number; defaultFour: string[] | null; side: 'survivors' | 'infected' | null; roster: RoomPlayer[]; stages: { stageId: number; ordinal: number; pool: { slug: string; name: string }[]; order: string[] }[] }
export function prefsView(db: DB, ev: E.EventRow, entryId: number): PrefsView
```

- Routes (public, `competitive_enabled` as the others, draft 404 to non-staff):
  - `GET /api/events/:slug/matches/:id` → `MatchRoomView` (signed out allowed).
  - `POST /api/events/:slug/matches/:id/ready` → `{}`
  - `POST /api/events/:slug/matches/:id/veto` body `{ step: number, action: string, campaign?: string | null }` → `{}`
  - `POST /api/events/:slug/matches/:id/lineup` body `{ steamids: string[] }` → `{}`
  - `GET /api/events/:slug/entries/:id/prefs` (the entry's managers and staff) → `PrefsView`
  - `POST /api/events/:slug/entries/:id/prefs` body `{ defaultFour, side, campaigns }` → `{}`
- Admin routes (admins; mods read only, as T2):
  - `POST /api/admin/events/:id/matches/:matchId/open-room` → `{}`
  - `POST /api/admin/events/:id/matches/:matchId/reset-room` → `{}`
  - `POST /api/admin/events/:id/matches/:matchId/hold` body `{ reason: string }` → `{}`

Visibility rules for `matchRoomView` (Global Constraints):
- `lineups.a` / `lineups.b` are the players once both are locked; before that, a side's list is shown only to staff and to that side's own roster (`isParticipant` restricted to that entry), else null. `aLocked` / `bLocked` are always shown.
- `me` is set for anyone on either roster (`side` from roster membership), with `manager` from `sideOf`. `playable` and `defaultFour` only when `manager` is true (else `[]` and null).
- Preferences never appear in this view.

- [ ] **Step 1: Write the failing view tests**

Create `tests/roomViews.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as E from '../src/events/events.js';
import * as P from '../src/events/play.js';
import * as R from '../src/events/room.js';
import { matchRoomView, phaseOf, prefsView } from '../src/events/roomViews.js';
import { NOW } from './eventFixture.js';
import { A, B, OUTSIDER } from './entryFixture.js';
import { TIMERS, roomFixture, type RoomFixture } from './roomFixture.js';

const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
const view = (f: RoomFixture, viewer: string | null, staff = false) =>
  matchRoomView(f.db, E.getEvent(f.db, f.eventId)!, P.getMatch(f.db, f.matchId)!, viewer, staff, at(5));
const toLineups = (f: RoomFixture) => {
  R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS, now: NOW });
  R.readyUp(f.db, { matchId: f.matchId, steamid: A[0], timers: TIMERS, now: at(1) });
  R.readyUp(f.db, { matchId: f.matchId, steamid: B[0], timers: TIMERS, now: at(1) });
  R.actVeto(f.db, { matchId: f.matchId, steamid: A[0], step: 0, action: 'first', campaign: null, timers: TIMERS, now: at(2) });
  R.actVeto(f.db, { matchId: f.matchId, steamid: A[0], step: 1, action: 'ban', campaign: 'dead_air', timers: TIMERS, now: at(2) });
  R.actVeto(f.db, { matchId: f.matchId, steamid: B[0], step: 2, action: 'survivors', campaign: null, timers: TIMERS, now: at(2) });
};

describe('matchRoomView', () => {
  it('shows the ready phase with the deadline and who is ready, to anyone', async () => {
    const f = await roomFixture();
    R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS, now: NOW });
    R.readyUp(f.db, { matchId: f.matchId, steamid: B[0], timers: TIMERS, now: at(1) });
    const v = view(f, null);
    expect(v).toMatchObject({ phase: 'ready', higher: 'a', deadline: at(10).toISOString(), serverNow: at(5).toISOString(), ready: { a: false, b: true }, me: null });
    expect(v.a.name).toBe('Rats');
    expect(v.vetoSummary).toMatch(/^Bo1: ban down to 1/);
  });

  it('shows the pool with bans and the decider, the log, the games and the next step', async () => {
    const f = await roomFixture();
    toLineups(f);
    const v = view(f, null);
    expect(v.phase).toBe('lineup');
    expect(v.pool.map((c) => [c.slug, c.state, c.by, c.game])).toEqual([['no_mercy', 'decider', null, 1], ['dead_air', 'banned', 'a', null]]);
    expect(v.log.map((l) => [l.step, l.side, l.action, l.campaign, l.auto])).toEqual([[0, 'a', 'first', null, false], [1, 'a', 'ban', 'dead_air', false], [2, 'b', 'survivors', null, false]]);
    expect(v.games).toEqual([expect.objectContaining({ game: 1, campaign: 'no_mercy', pickedBy: null, sideBy: 'b', firstSurvivors: 'b' })]);
    expect(v.next).toBeNull();
  });

  it('keeps a locked lineup secret from the other team and outsiders until both are locked', async () => {
    const f = await roomFixture();
    toLineups(f);
    R.lockLineup(f.db, { matchId: f.matchId, steamid: A[0], steamids: [A[1], A[2], A[3], A[4]], timers: TIMERS, now: at(3) });
    expect(view(f, B[2]).lineups).toEqual({ a: null, b: null, aLocked: true, bLocked: false });
    expect(view(f, OUTSIDER).lineups.a).toBeNull();
    expect(view(f, A[3]).lineups.a!.map((p) => p.steamid)).toEqual([A[1], A[2], A[3], A[4]]);
    expect(view(f, '76561199000000700', true).lineups.a).not.toBeNull();
    R.lockLineup(f.db, { matchId: f.matchId, steamid: B[0], steamids: B.slice(0, 4), timers: TIMERS, now: at(4) });
    const after = view(f, OUTSIDER);
    expect(after.phase).toBe('server');
    expect(after.lineups.b!.map((p) => p.steamid)).toEqual(B.slice(0, 4));
  });

  it('gives a manager their playable roster and default four, a member only their side', async () => {
    const f = await roomFixture();
    toLineups(f);
    R.savePrefs(f.db, { entryId: f.entryA, by: A[0], staff: false, prefs: { defaultFour: [A[1], A[2], A[3], A[4]], side: null, campaigns: {} }, now: NOW });
    expect(view(f, A[1]).me).toMatchObject({ side: 'a', manager: true, defaultFour: [A[1], A[2], A[3], A[4]] });
    expect(view(f, A[1]).me!.playable.map((p) => p.steamid)).toEqual(A.slice(0, 5));
    expect(view(f, A[3]).me).toEqual({ side: 'a', manager: false, playable: [], defaultFour: null });
  });

  it('maps every status to a phase', () => {
    const m = (status: P.MatchStatus, extra: Partial<P.MatchRow> = {}) => ({ status, ready_a_at: null, ready_b_at: null, ...extra }) as P.MatchRow;
    expect(phaseOf(m('veto'))).toBe('ready');
    expect(phaseOf(m('veto', { ready_a_at: 'x', ready_b_at: 'y' }))).toBe('veto');
    expect(['pending', 'waiting', 'lineup', 'booking', 'admin_hold', 'done', 'forfeit', 'bye'].map((s) => phaseOf(m(s as P.MatchStatus))))
      .toEqual(['pending', 'waiting', 'lineup', 'server', 'hold', 'done', 'done', 'done']);
  });
});

describe('prefsView', () => {
  it('lists the roster (no coach), each stage\'s pool and the saved order', async () => {
    const f = await roomFixture();
    R.savePrefs(f.db, { entryId: f.entryA, by: A[0], staff: false, prefs: { defaultFour: null, side: 'infected', campaigns: { [String(f.stageId)]: ['dead_air'] } }, now: NOW });
    const v = prefsView(f.db, E.getEvent(f.db, f.eventId)!, f.entryA);
    expect(v).toMatchObject({ entryId: f.entryA, defaultFour: null, side: 'infected' });
    expect(v.roster.map((p) => p.steamid)).toEqual(A.slice(0, 5));
    expect(v.stages).toEqual([{ stageId: f.stageId, ordinal: 1, pool: [expect.objectContaining({ slug: 'no_mercy' }), expect.objectContaining({ slug: 'dead_air' })], order: ['dead_air'] }]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/roomViews.test.ts`
Expected: FAIL (no `roomViews.ts`).

- [ ] **Step 3: Write `src/events/roomViews.ts`**

```ts
import type { DB } from '../db.js';
import { campaignDisplayName } from '../campaignRegistry.js';
import { getPlayer } from '../players.js';
import * as E from './events.js';
import * as N from './entries.js';
import * as P from './play.js';
import * as R from './room.js';
import { stagePlayViews, type PlayEntry } from './playViews.js';
import { vetoSummary } from './vetoConfig.js';
import { isHumanStep, type VetoActionKind } from './veto.js';

/** What the match room page shows (tournaments plan T3a). Lineups stay
 *  secret until both are locked, and preferences never appear here
 *  (Global Constraints). */

export type RoomPhase = 'pending' | 'waiting' | 'ready' | 'veto' | 'lineup' | 'server' | 'hold' | 'done';
// The interfaces RoomCampaign, RoomLogLine, RoomGame, RoomPlayer,
// MatchRoomView and PrefsView exactly as in this task's Interfaces block.

export function phaseOf(m: Pick<P.MatchRow, 'status' | 'ready_a_at' | 'ready_b_at'>): RoomPhase {
  switch (m.status) {
    case 'pending': return 'pending';
    case 'waiting': return 'waiting';
    case 'veto': return m.ready_a_at !== null && m.ready_b_at !== null ? 'veto' : 'ready';
    case 'lineup': return 'lineup';
    case 'admin_hold': return 'hold';
    case 'done': case 'forfeit': case 'bye': return 'done';
    default: return 'server';
  }
}

const player = (db: DB, steamid: string): RoomPlayer => ({ steamid, name: getPlayer(db, steamid)?.name ?? steamid });
const rosterSet = (db: DB, entryId: number): Set<string> => {
  const r = N.rosterOf(db, entryId);
  return new Set([...r.starters, ...r.subs, ...(r.coach ? [r.coach] : [])]);
};

export function matchRoomView(db: DB, ev: E.EventRow, m: P.MatchRow, viewer: string | null, staff: boolean, now = new Date()): MatchRoomView {
  const stage = E.getStage(db, m.stage_id)!;
  const settings = E.stageSettingsOf(stage);
  const card = stagePlayViews(db, ev).flatMap((s) => s.rounds.map((r) => ({ r, s })))
    .flatMap(({ r }) => r.matches.map((pm) => ({ pm, label: r.label }))).find((x) => x.pm.id === m.id)!;
  const sideOfEntry = (id: number | null): 'a' | 'b' | null => (id === null ? null : id === m.entry_a ? 'a' : id === m.entry_b ? 'b' : null);
  const name = (slug: string | null) => (slug === null ? null : campaignDisplayName(db, slug));
  const roomOpen = m.room_opened_at !== null;
  const st = roomOpen && m.entry_a !== null && m.entry_b !== null ? R.roomState(db, m) : null;
  const vetoRows = db.prepare('SELECT step, side, action, campaign, auto, at FROM event_vetoes WHERE event_match_id = ? ORDER BY step').all(m.id) as
    { step: number; side: 'a' | 'b'; action: VetoActionKind; campaign: string | null; auto: number; at: string }[];
  const games = R.gamesOf(db, m.id);
  const pool: RoomCampaign[] = settings.campaignPool.map((slug) => {
    const ban = st?.bans.find((b) => b.campaign === slug);
    const game = games.find((g) => g.campaign === slug);
    if (ban) return { slug, name: name(slug)!, state: 'banned', by: ban.side, game: null };
    if (game) return { slug, name: name(slug)!, state: game.picked_by === null ? 'decider' : 'picked', by: sideOfEntry(game.picked_by), game: game.ordinal };
    return { slug, name: name(slug)!, state: 'open', by: null, game: null };
  });
  const locked = R.lineupsOf(db, m.id).filter((l) => l.game === 1);
  const lineupOf = (side: 'a' | 'b') => locked.find((l) => l.entry_id === (side === 'a' ? m.entry_a : m.entry_b));
  const both = locked.length === 2;
  const mySide: 'a' | 'b' | null = viewer === null ? null
    : m.entry_a !== null && rosterSet(db, m.entry_a).has(viewer) ? 'a' : m.entry_b !== null && rosterSet(db, m.entry_b).has(viewer) ? 'b' : null;
  const showLineup = (side: 'a' | 'b'): RoomPlayer[] | null => {
    const l = lineupOf(side);
    if (!l || !(both || staff || mySide === side)) return null;
    return (JSON.parse(l.steamids) as string[]).map((s) => player(db, s));
  };
  const manager = mySide !== null && viewer !== null && R.sideOf(db, m, viewer) === mySide;
  const myEntry = mySide === null ? null : R.entryOn(m, mySide);
  const next: MatchRoomView['next'] = !st || m.status !== 'veto' || m.ready_a_at === null || m.ready_b_at === null ? null
    : isHumanStep(st.next) ? { kind: st.next.kind, by: st.next.by, game: 'game' in st.next ? st.next.game : null, step: st.used }
      : st.next.kind === 'wait' ? { kind: 'wait', game: st.next.game } : null;
  const resolved = P.RESOLVED.has(m.status) && m.status !== 'bye' && m.winner_entry !== null;
  return {
    id: m.id, eventSlug: ev.slug, eventName: ev.name, roundLabel: card.label, a: card.pm.a!, b: card.pm.b!, phase: phaseOf(m),
    higher: m.room_higher, deadline: m.deadline, serverNow: now.toISOString(), ready: { a: m.ready_a_at !== null, b: m.ready_b_at !== null },
    vetoSummary: vetoSummary(settings.veto, settings.campaignPool.length), pool,
    log: vetoRows.map((r) => ({ step: r.step, side: r.side, action: r.action, campaign: r.campaign, campaignName: name(r.campaign), auto: r.auto === 1, at: r.at })),
    games: games.map((g) => ({
      game: g.ordinal, campaign: g.campaign, campaignName: name(g.campaign)!, pickedBy: sideOfEntry(g.picked_by), sideBy: sideOfEntry(g.side_by),
      firstSurvivors: sideOfEntry(g.first_survivors),
    })),
    next,
    lineups: { a: showLineup('a'), b: showLineup('b'), aLocked: !!lineupOf('a'), bLocked: !!lineupOf('b') },
    holdReason: m.status === 'admin_hold' ? m.hold_reason : null,
    result: resolved ? { winner: m.winner_entry === m.entry_a ? 'a' : 'b', scoreA: m.score_a, scoreB: m.score_b, forfeit: m.status === 'forfeit' } : null,
    me: mySide === null ? null : {
      side: mySide, manager,
      playable: manager && myEntry !== null ? R.playableOf(db, myEntry).map((s) => player(db, s)) : [],
      defaultFour: manager && myEntry !== null ? R.entryPrefs(db, myEntry).defaultFour : null,
    },
  };
}

export function prefsView(db: DB, ev: E.EventRow, entryId: number): PrefsView {
  const p = R.entryPrefs(db, entryId);
  return {
    entryId, defaultFour: p.defaultFour, side: p.side, roster: R.playableOf(db, entryId).map((s) => player(db, s)),
    stages: E.stagesOf(db, ev.id).map((s) => ({
      stageId: s.id, ordinal: s.ordinal,
      pool: E.stageSettingsOf(s).campaignPool.map((slug) => ({ slug, name: campaignDisplayName(db, slug) })),
      order: R.campaignPrefs(db, entryId, s.id),
    })),
  };
}
```

`PlayEntry` for a match's `a`/`b` comes from `stagePlayViews`, so names, tags and logos match the bracket exactly. If calling `stagePlayViews` per room read proves slow in the route test (it builds every stage), factor its per-entry map into an exported `playEntriesOf(db, ev)` and its round labelling into `matchLabel(db, ev, m)`, and use those here instead.

`roomViews.ts` imports `playViews.ts`, so to avoid an import cycle, `RoomPhase` and `phaseOf` live in `src/events/playViews.ts` (move them there from the block above) and `roomViews.ts` re-exports them: `export { phaseOf, type RoomPhase } from './playViews.js';`. In `playViews.ts`, add `phase: RoomPhase` to `PlayMatch` and set `phase: phaseOf(m)` where each `PlayMatch` is built.

- [ ] **Step 4: Run the view tests**

Run: `npx vitest run tests/roomViews.test.ts tests/eventPlayRoutes.test.ts`
Expected: PASS. Update any `PlayMatch` literal in older tests that now lacks `phase`.

- [ ] **Step 5: Write the failing route tests**

Create `tests/eventRoomRoutes.test.ts`, set up like `tests/eventEntryRoutes.test.ts` (same `buildServer` call, cookies for `A`, `B`, `OUTSIDER`, `ADMIN`):

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import * as P from '../src/events/play.js';
import * as R from '../src/events/room.js';
import { ADMIN } from './eventFixture.js';
import { A, B, OUTSIDER } from './entryFixture.js';
import { TIMERS, roomFixture, type RoomFixture } from './roomFixture.js';

let f: RoomFixture;
let app: FastifyInstance;
const cookies: Record<string, Record<string, string>> = {};
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

beforeEach(async () => {
  f = await roomFixture({ startsAt: days(9), now: new Date() });
  app = await buildServer({
    config: { ...loadConfig({}), communityDir: mkdtempSync(join(tmpdir(), 'rooms-')) }, db: f.db, orchestrator: stubOrchestrator(),
    serverCleaner: async () => {}, serverExec: async () => {},
  });
  for (const s of [...A, ...B, OUTSIDER, ADMIN]) cookies[s] = authedCookie(app, f.db, s);
});
afterEach(async () => { await app.close(); });

const get = (url: string, as?: string) => app.inject({ method: 'GET', url, cookies: as ? cookies[as] : undefined });
const post = (url: string, as: string, body: object = {}) => app.inject({ method: 'POST', url, cookies: cookies[as], payload: body });
const room = () => `/api/events/${f.slug}/matches/${f.matchId}`;

describe('match room over HTTP', () => {
  it('reads a room signed out, and 404s a match of another event or an unknown id', async () => {
    R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS });
    const res = await get(room());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: f.matchId, phase: 'ready', me: null });
    expect((await get(`/api/events/${f.slug}/matches/999999`)).statusCode).toBe(404);
  });

  it('runs ready, veto and lineup through the routes, refusing with sentences', async () => {
    R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS });
    expect((await post(`${room()}/ready`, OUTSIDER)).json()).toEqual({ error: 'Only the team captain or a co-captain can do that.' });
    expect((await post(`${room()}/ready`, A[0])).statusCode).toBe(200);
    expect((await post(`${room()}/ready`, B[0])).statusCode).toBe(200);
    expect((await post(`${room()}/veto`, B[0], { step: 0, action: 'first' })).json()).toEqual({ error: 'It is the other team\'s turn.' });
    expect((await post(`${room()}/veto`, A[0], { step: 0, action: 'first' })).statusCode).toBe(200);
    expect((await post(`${room()}/veto`, A[0], { step: 1, action: 'ban', campaign: 'dead_air' })).statusCode).toBe(200);
    expect((await post(`${room()}/veto`, B[0], { step: 2, action: 'survivors' })).statusCode).toBe(200);
    expect((await post(`${room()}/lineup`, A[0], { steamids: [A[0], A[1], A[2], A[3]] })).statusCode).toBe(200);
    const mid = (await get(room(), B[1])).json();
    expect(mid.lineups).toEqual({ a: null, b: null, aLocked: true, bLocked: false });
    expect((await post(`${room()}/lineup`, B[0], { steamids: B.slice(0, 4) })).statusCode).toBe(200);
    expect(P.getMatch(f.db, f.matchId)!.status).toBe('booking');
  });

  it('reads and saves preferences for the team\'s managers only', async () => {
    const url = `/api/events/${f.slug}/entries/${f.entryA}/prefs`;
    expect((await get(url, A[3])).statusCode).toBe(403);
    expect((await get(url, B[0])).statusCode).toBe(403);
    expect((await get(url, A[1])).json()).toMatchObject({ entryId: f.entryA, side: null });
    expect((await post(url, A[1], { defaultFour: null, side: 'infected', campaigns: { [String(f.stageId)]: ['dead_air'] } })).statusCode).toBe(200);
    expect((await get(url, ADMIN)).json()).toMatchObject({ side: 'infected' });
  });
});

describe('admin room tools', () => {
  it('opens, holds and resets a room, admin only', async () => {
    const base = `/api/admin/events/${f.eventId}/matches/${f.matchId}`;
    expect((await post(`${base}/open-room`, A[0])).statusCode).toBe(403);
    expect((await post(`${base}/open-room`, ADMIN)).statusCode).toBe(200);
    expect(P.getMatch(f.db, f.matchId)!.status).toBe('veto');
    expect((await post(`${base}/hold`, ADMIN, { reason: 'Server trouble' })).statusCode).toBe(200);
    expect(P.getMatch(f.db, f.matchId)).toMatchObject({ status: 'admin_hold', hold_reason: 'Server trouble' });
    expect((await post(`${base}/reset-room`, ADMIN)).statusCode).toBe(200);
    expect(P.getMatch(f.db, f.matchId)!.status).toBe('waiting');
    const log = f.db.prepare("SELECT action FROM admin_actions WHERE action LIKE 'event_room%' OR action = 'event_hold' ORDER BY id").all();
    expect(log).toEqual([{ action: 'event_room_open' }, { action: 'event_hold' }, { action: 'event_room_reset' }]);
  });
});
```

(`ADMIN` must be an active admin in this fixture: `entryFixture` passes `[ADMIN]` as the admin list to `upsertPlayer`; if `requireAdmin` also wants `status = 'active'`, activate it in the test's `beforeEach`. Check the table and column `logAdmin` writes, `grep -n "INSERT INTO" src/admin/audit.ts`, and adjust the last query to match.)

- [ ] **Step 6: Write the routes**

In `src/routes/events.ts`, extend the options with `rooms?: { pushChange(matchId: number): void }`, import `* as P`, `* as R from '../events/room.js'`, `{ matchRoomView, prefsView } from '../events/roomViews.js'`, and add:

```ts
  const matchIn = (ev: E.EventRow, raw: string): P.MatchRow | undefined => {
    const id = Number(raw);
    const m = Number.isInteger(id) ? P.getMatch(db, id) : undefined;
    return m && m.event_id === ev.id ? m : undefined;
  };
  const pushed = (matchId: number) => opts.rooms?.pushChange(matchId);

  app.get('/api/events/:slug/matches/:id', async (req, reply) => {
    const v = allowedViewer(req, reply);
    if (!v) return;
    const p = req.params as SlugId;
    const ev = visibleEvent(p.slug, v.viewer);
    const m = ev && matchIn(ev, p.id);
    if (!ev || !m) return reply.code(404).send(NOT_FOUND);
    return matchRoomView(db, ev, m, v.viewer, isStaff(v.viewer));
  });

  app.post('/api/events/:slug/matches/:id/:action', async (req, reply) => {
    const me = allowedActive(req, reply);
    if (!me) return;
    const p = req.params as SlugId & { action: string };
    const ev = visibleEvent(p.slug, me);
    const m = ev && matchIn(ev, p.id);
    if (!ev || !m) return refuse(reply, { error: 'match_not_found' });
    const body = (req.body ?? {}) as { step?: unknown; action?: unknown; campaign?: unknown; steamids?: unknown };
    const timers = R.roomTimers(db);
    let r: V.Checked<unknown>;
    if (p.action === 'ready') r = R.readyUp(db, { matchId: m.id, steamid: me, timers });
    else if (p.action === 'veto') {
      if (!Number.isInteger(body.step)) return refuse(reply, { error: 'bad_veto_action' });
      r = R.actVeto(db, { matchId: m.id, steamid: me, step: body.step as number, action: body.action, campaign: body.campaign ?? null, timers });
    } else if (p.action === 'lineup') r = R.lockLineup(db, { matchId: m.id, steamid: me, steamids: body.steamids, timers });
    else return reply.code(404).send(NOT_FOUND);
    if (!r.ok) return refuse(reply, r);
    pushed(m.id);
    return {};
  });

  const prefsEntry = (req: FastifyRequest, reply: FastifyReply): { me: string; ev: E.EventRow; entry: N.EntryRow } | null => {
    const me = allowedActive(req, reply);
    if (!me) return null;
    const p = req.params as SlugId;
    const ev = visibleEvent(p.slug, me);
    const entry = ev && entryIn(ev, p.id);
    if (!ev || !entry) { refuse(reply, { error: 'entry_not_found' }); return null; }
    if (!isStaff(me) && !N.managersOf(db, entry.team_id).includes(me)) { refuse(reply, { error: 'not_manager' }); return null; }
    return { me, ev, entry };
  };

  app.get('/api/events/:slug/entries/:id/prefs', async (req, reply) => {
    const c = prefsEntry(req, reply);
    if (!c) return;
    return prefsView(db, c.ev, c.entry.id);
  });

  app.post('/api/events/:slug/entries/:id/prefs', async (req, reply) => {
    const c = prefsEntry(req, reply);
    if (!c) return;
    const r = R.savePrefs(db, { entryId: c.entry.id, by: c.me, staff: isStaff(c.me), prefs: req.body ?? null });
    if (!r.ok) return refuse(reply, r);
    return {};
  });
```

The ready test expects the `not_manager` sentence for an outsider: `readyUp` returns `not_manager` because `sideOf` finds no side, which is the T1b text "Only the team captain or a co-captain can do that.".

In `src/routes/adminEvents.ts`, extend the options with `rooms?: { pushChange(matchId: number): void }` and add after the result route:

```ts
  /** Plan T3a Ruling 13: open a room by hand (any waiting match with both
   *  teams, window stages included), reset one to waiting, or hold one. */
  const roomAction = (action: 'open-room' | 'reset-room' | 'hold', audit: string) =>
    app.post(`/api/admin/events/:id/matches/:matchId/${action}`, async (req, reply) => {
      const me = requireAdmin(req, reply);
      if (!me) return;
      const p = req.params as { id: string; matchId: string };
      const ev = eventOf(p.id);
      const matchId = idOf(p.matchId);
      const m = ev && matchId !== null ? P.getMatch(db, matchId) : undefined;
      if (!ev || !m || m.event_id !== ev.id) return refuse(reply, 'match_not_found');
      const reason = String(((req.body ?? {}) as { reason?: unknown }).reason ?? '').trim();
      if (action === 'hold' && (reason.length < 3 || reason.length > 300)) return refuse(reply, 'bad_reason');
      const r = action === 'open-room'
        ? R.openRoom(db, { matchId: m.id, by: me, higher: higherSide(db, m), seed: randomInt(2 ** 31), timers: R.roomTimers(db) })
        : action === 'reset-room' ? R.resetRoom(db, { matchId: m.id, by: me }) : R.holdMatch(db, { matchId: m.id, by: me, reason });
      if (!r.ok) return refuse(reply, r.error);
      if (action === 'open-room') tellRoomOpen(opts, ev.id, m.id);
      opts.rooms?.pushChange(m.id);
      logAdmin(db, me, audit, ev.id, { matchId: m.id, ...(action === 'hold' ? { reason } : {}) });
      return {};
    });
  roomAction('open-room', 'event_room_open');
  roomAction('reset-room', 'event_room_reset');
  roomAction('hold', 'event_hold');
```

with imports `randomInt` from `node:crypto`, `* as R from '../events/room.js'`, `higherSide` from `../events/roomClock.js`, `tellRoomOpen` from `../events/notices.js`. If `refuse` here takes only an error key (as the result route suggests), keep it that way.

In `src/server.ts`, pass `rooms: roomClock` to both `eventRoutes` and `adminEventRoutes`. The admin routes are registered before the clock is built (line ~2043 vs ~2062): move the `RoomClock` construction above the `adminEventRoutes` registration.

- [ ] **Step 7: Run the route tests**

Run: `npx vitest run tests/eventRoomRoutes.test.ts tests/roomViews.test.ts tests/adminEventRoutes.test.ts tests/eventEntryRoutes.test.ts tests/eventGating.test.ts`
Expected: PASS. `tests/eventGating.test.ts` walks the public event routes with the switch off; add the new GET routes to its list if it enumerates them.

- [ ] **Step 8: Commit**

```bash
git add src/events/roomViews.ts src/events/playViews.ts src/routes/events.ts src/routes/adminEvents.ts src/server.ts tests/roomViews.test.ts tests/eventRoomRoutes.test.ts tests/adminEventRoutes.test.ts tests/eventGating.test.ts
git commit -m "Tournaments T3a: the match room view with secret lineups, the ready, veto, lineup and preferences routes, and the admin open, reset and hold tools"
```

---
### Task 7: The match room page

**Files:**
- Modify: `web/src/api.ts`, `web/src/AppRoutes.tsx`, `web/src/styles/app.css`
- Create: `web/src/routes/EventMatch.tsx`, `web/src/routes/event/room/VetoBoard.tsx`, `web/src/routes/event/room/LineupPanel.tsx`, `web/src/routes/event/room/roomText.ts`
- Test: `web/src/routes/EventMatch.test.tsx`, `web/src/routes/event/room/VetoBoard.test.tsx`, `web/src/routes/event/room/LineupPanel.test.tsx`, `web/src/routes/event/room/roomText.test.ts`

**Interfaces:**
- Consumes: the Task 6 routes and `MatchRoomView` / `PrefsView` shapes.
- Produces in `web/src/api.ts`: the types `RoomPhase`, `RoomCampaign`, `RoomLogLine`, `RoomGame`, `RoomPlayer`, `MatchRoomView`, `PrefsView` copied from `src/events/roomViews.ts` (the web keeps its own copies of server types, as it does for `StagePlayView`); `PlayMatch.phase: RoomPhase`; `StageSettings.veto: VetoConfig` (now required; `import type { VetoConfig } from '../../src/events/vetoConfig'`, re-exported); and on `eventsApi`:

```ts
  room: (slug: string, id: number, signal?: AbortSignal) => get<MatchRoomView>(`/api/events/${enc(slug)}/matches/${id}`, signal),
  ready: (slug: string, id: number) => post(`/api/events/${enc(slug)}/matches/${id}/ready`),
  veto: (slug: string, id: number, step: number, action: string, campaign: string | null = null) =>
    post(`/api/events/${enc(slug)}/matches/${id}/veto`, { step, action, campaign }),
  lineup: (slug: string, id: number, steamids: string[]) => post(`/api/events/${enc(slug)}/matches/${id}/lineup`, { steamids }),
  prefs: (slug: string, entryId: number, signal?: AbortSignal) => get<PrefsView>(`/api/events/${enc(slug)}/entries/${entryId}/prefs`, signal),
  savePrefs: (slug: string, entryId: number, body: { defaultFour: string[] | null; side: 'survivors' | 'infected' | null; campaigns: Record<string, string[]> }) =>
    post(`/api/events/${enc(slug)}/entries/${entryId}/prefs`, body),
```

  and on `adminApi`: `openEventRoom(id, matchId)`, `resetEventRoom(id, matchId)`, `holdEventMatch(id, matchId, reason)` posting to the three admin routes.
- Produces in `roomText.ts` (pure): `PHASE_TEXT: Record<RoomPhase, string>`, `stepText(v: MatchRoomView): string` (whose turn and what, by team name), `logText(v: MatchRoomView, l: RoomLogLine): string`, `clockText(ms: number): string` (`m:ss`, `0:00` at or below zero).
- Produces `EventMatchPage({ slug, id, session })`, mounted at `/event/:slug/match/:id`.

Page layout, top to bottom, one column at phone width (16 px gutters, no sideways scroll):
1. Header: event name (link back to `/event/:slug`), round label, "Rats vs Bats" with logos, the phase as a chip, and the countdown to `deadline` when there is one.
2. Ready panel (phase `ready`): each team with Ready / Waiting; a Ready button for a manager whose team is not ready yet.
3. Veto board (phases `veto` and later, whenever `pool` has any state): one tile per campaign (name, Banned by X / Game N picked by X / Decider), whose turn it is with a sentence ("Rats: ban a campaign"), and for the manager whose turn it is: on a ban or pick step each open tile is a button; on an order step two buttons, "Go first" / "Go second"; on a side step two buttons, "Survivors first" / "Infected first". A `wait` step says "Game 2 is picked after game 1."
4. Games: "Game 1: No Mercy · Rats start as survivors".
5. Lineups (phase `lineup` and later): for a manager whose team has not locked, a picker of the playable roster (checkboxes, exactly 4, preselected with the default four if set), a Lock button; otherwise each team's four or "Locked" / "Picking" when hidden.
6. Phase `server`: "Lineups locked. Staff are setting up the server; the connect details come from them." Phase `hold`: "On hold: staff are looking at this match" plus the reason. Phase `done`: the result or "Forfeit win for X".
7. The veto log, newest last: "Rats banned Dead Air", "Bats chose survivors first on No Mercy (automatic)".

Every action button asks nothing more (no confirm dialog) except Lock lineup, which uses the site's `confirm` ("Lock Rats' lineup? You cannot change it for this match."). Errors from the server show in a `role="alert"` line above the board. After an action the page refetches.

- [ ] **Step 1: Write the failing tests**

`web/src/routes/event/room/roomText.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { clockText, logText, stepText } from './roomText';
import type { MatchRoomView } from '../../../api';

const v = (over: Partial<MatchRoomView>): MatchRoomView => ({
  id: 1, eventSlug: 'cup', eventName: 'Cup', roundLabel: 'Round 1',
  a: { id: 1, name: 'Rats', tag: 'RAT', logoKey: null, seed: 1, out: false }, b: { id: 2, name: 'Bats', tag: 'BAT', logoKey: null, seed: 2, out: false },
  phase: 'veto', higher: 'a', deadline: null, serverNow: '2026-10-06T00:00:00.000Z', ready: { a: true, b: true }, vetoSummary: '',
  pool: [], log: [], games: [], next: null, lineups: { a: null, b: null, aLocked: false, bLocked: false }, holdReason: null, result: null, me: null,
  ...over,
});

describe('roomText', () => {
  it('says whose turn it is and what', () => {
    expect(stepText(v({ next: { kind: 'ban', by: 'b', game: null, step: 3 } }))).toBe('Bats: ban a campaign');
    expect(stepText(v({ next: { kind: 'pick', by: 'a', game: 2, step: 5 } }))).toBe('Rats: pick game 2');
    expect(stepText(v({ next: { kind: 'order', by: 'a', game: null, step: 0 } }))).toBe('Rats: go first or second');
    expect(stepText(v({ next: { kind: 'side', by: 'b', game: 1, step: 4 } }))).toBe('Bats: choose sides for game 1');
    expect(stepText(v({ next: { kind: 'wait', game: 2 } }))).toBe('Game 2 is picked after game 1.');
  });

  it('writes the log in plain sentences, marking automatic steps', () => {
    const view = v({ games: [{ game: 1, campaign: 'no_mercy', campaignName: 'No Mercy', pickedBy: null, sideBy: 'b', firstSurvivors: 'b' }] });
    expect(logText(view, { step: 1, side: 'a', action: 'ban', campaign: 'dead_air', campaignName: 'Dead Air', auto: false, at: '' })).toBe('Rats banned Dead Air');
    expect(logText(view, { step: 0, side: 'a', action: 'second', campaign: null, campaignName: null, auto: true, at: '' })).toBe('Rats chose to go second (automatic)');
    expect(logText(view, { step: 2, side: 'b', action: 'survivors', campaign: null, campaignName: null, auto: false, at: '' })).toBe('Bats chose survivors first');
  });

  it('formats the countdown', () => {
    expect(clockText(65_000)).toBe('1:05');
    expect(clockText(-3)).toBe('0:00');
  });
});
```

`web/src/routes/event/room/VetoBoard.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import type { MatchRoomView } from '../../../api';
import { VetoBoard } from './VetoBoard';

afterEach(cleanup);
const base = (over: Partial<MatchRoomView>): MatchRoomView => ({
  id: 1, eventSlug: 'cup', eventName: 'Cup', roundLabel: 'Round 1',
  a: { id: 1, name: 'Rats', tag: 'RAT', logoKey: null, seed: 1, out: false }, b: { id: 2, name: 'Bats', tag: 'BAT', logoKey: null, seed: 2, out: false },
  phase: 'veto', higher: 'a', deadline: null, serverNow: '2026-10-06T00:00:00.000Z', ready: { a: true, b: true }, vetoSummary: 'Bo1: ban down to 1.',
  pool: [
    { slug: 'no_mercy', name: 'No Mercy', state: 'open', by: null, game: null },
    { slug: 'dead_air', name: 'Dead Air', state: 'banned', by: 'b', game: null },
  ],
  log: [], games: [], next: { kind: 'ban', by: 'a', game: null, step: 2 }, lineups: { a: null, b: null, aLocked: false, bLocked: false },
  holdReason: null, result: null, me: { side: 'a', manager: true, playable: [], defaultFour: null }, ...over,
});

describe('VetoBoard', () => {
  it('lets the manager whose turn it is ban an open campaign, sending the step it saw', () => {
    const act = vi.fn();
    render(<VetoBoard v={base({})} busy={false} onAct={act} />);
    expect(screen.getByText('Rats: ban a campaign')).toBeTruthy();
    expect(screen.getByText('Banned by Bats')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ban No Mercy' }));
    expect(act).toHaveBeenCalledWith(2, 'ban', 'no_mercy');
  });

  it('shows no buttons to the other team, a member, or a viewer', () => {
    for (const me of [{ side: 'b' as const, manager: true, playable: [], defaultFour: null }, { side: 'a' as const, manager: false, playable: [], defaultFour: null }, null]) {
      render(<VetoBoard v={base({ me })} busy={false} onAct={() => {}} />);
      expect(screen.queryByRole('button', { name: 'Ban No Mercy' })).toBeNull();
      cleanup();
    }
  });

  it('offers go first or second, and survivors or infected first', () => {
    const act = vi.fn();
    const { rerender } = render(<VetoBoard v={base({ next: { kind: 'order', by: 'a', game: null, step: 0 } })} busy={false} onAct={act} />);
    fireEvent.click(screen.getByRole('button', { name: 'Go second' }));
    expect(act).toHaveBeenCalledWith(0, 'second', null);
    rerender(<VetoBoard v={base({ next: { kind: 'side', by: 'a', game: 1, step: 3 } })} busy={false} onAct={act} />);
    fireEvent.click(screen.getByRole('button', { name: 'Infected first' }));
    expect(act).toHaveBeenCalledWith(3, 'infected', null);
  });
});
```

`web/src/routes/event/room/LineupPanel.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import type { MatchRoomView } from '../../../api';
import { LineupPanel } from './LineupPanel';

vi.mock('../../../components/Confirm', () => ({ confirm: vi.fn(async () => true) }));
afterEach(cleanup);
const players = ['p1', 'p2', 'p3', 'p4', 'p5'].map((n) => ({ steamid: n, name: n.toUpperCase() }));
const v = (over: Partial<MatchRoomView>): MatchRoomView => ({
  id: 1, eventSlug: 'cup', eventName: 'Cup', roundLabel: 'Round 1',
  a: { id: 1, name: 'Rats', tag: 'RAT', logoKey: null, seed: 1, out: false }, b: { id: 2, name: 'Bats', tag: 'BAT', logoKey: null, seed: 2, out: false },
  phase: 'lineup', higher: 'a', deadline: null, serverNow: '', ready: { a: true, b: true }, vetoSummary: '', pool: [], log: [], games: [], next: null,
  lineups: { a: null, b: null, aLocked: false, bLocked: true }, holdReason: null, result: null,
  me: { side: 'a', manager: true, playable: players, defaultFour: ['p2', 'p3', 'p4', 'p5'] }, ...over,
});

describe('LineupPanel', () => {
  it('preselects the default four and locks exactly four', async () => {
    const lock = vi.fn(async () => {});
    render(<LineupPanel v={v({})} busy={false} onLock={lock} />);
    const box = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement;
    expect(box('P1').checked).toBe(false);
    expect(box('P5').checked).toBe(true);
    fireEvent.click(box('P5'));
    expect((screen.getByRole('button', { name: 'Lock lineup' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(box('P1'));
    fireEvent.click(screen.getByRole('button', { name: 'Lock lineup' }));
    await vi.waitFor(() => expect(lock).toHaveBeenCalledWith(['p1', 'p2', 'p3', 'p4']));
  });

  it('shows the other team as locked but not who, and both fours once revealed', () => {
    render(<LineupPanel v={v({ me: null })} busy={false} onLock={async () => {}} />);
    expect(screen.getByText('Bats: locked')).toBeTruthy();
    expect(screen.getByText('Rats: picking')).toBeTruthy();
    cleanup();
    render(<LineupPanel v={v({ me: null, phase: 'server', lineups: { a: players.slice(0, 4), b: players.slice(1), aLocked: true, bLocked: true } })} busy={false} onLock={async () => {}} />);
    expect(screen.getAllByText('P2')).toHaveLength(2);
  });
});
```

`web/src/routes/EventMatch.test.tsx` (mock `eventsApi.room`, `ready`, `veto`, `lineup` with `vi.hoisted` as `EntryPanel.test.tsx` does; mock `../hooks/useHubEvent` to a no-op):

```tsx
  it('loads the room, shows the ready check, and readies up', async () => {
    mockEvents.room.mockResolvedValue(view({ phase: 'ready', ready: { a: false, b: true }, deadline: '2026-10-06T00:05:00.000Z', serverNow: '2026-10-06T00:00:00.000Z' }));
    mockEvents.ready.mockResolvedValue({});
    render(<EventMatchPage slug="cup" id="1" session={{ kind: 'active' } as never} />);
    expect(await screen.findByText('Rats vs Bats')).toBeTruthy();
    expect(screen.getByText('Bats: ready')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ready' }));
    await waitFor(() => expect(mockEvents.ready).toHaveBeenCalledWith('cup', 1));
    expect(mockEvents.room).toHaveBeenCalledTimes(2);
  });

  it('shows a refusal as an alert', async () => {
    mockEvents.room.mockResolvedValue(view({ phase: 'ready', ready: { a: false, b: false } }));
    mockEvents.ready.mockRejectedValue(new ApiError(409, 'The ready check for this match has closed.'));
    render(<EventMatchPage slug="cup" id="1" session={{ kind: 'active' } as never} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ready' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The ready check for this match has closed.');
  });

  it('says the match is not found', async () => {
    mockEvents.room.mockRejectedValue(new ApiError(404, 'not found'));
    render(<EventMatchPage slug="cup" id="9" session={{ kind: 'guest' } as never} />);
    expect(await screen.findByText('No such match.')).toBeTruthy();
  });
```

with `view()` the same builder as in the other tests and `me: { side: 'a', manager: true, playable: [], defaultFour: null }`. Check how `ApiError` is constructed (`grep -n "class ApiError" -A6 web/src/api.ts`) and build it the same way.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run web/src/routes/event/room web/src/routes/EventMatch.test.tsx`
Expected: FAIL (modules missing).

- [ ] **Step 3: Write the pieces**

`web/src/routes/event/room/roomText.ts`:

```ts
import type { MatchRoomView, RoomLogLine, RoomPhase } from '../../../api';

export const PHASE_TEXT: Record<RoomPhase, string> = {
  pending: 'Waiting for teams', waiting: 'Not started', ready: 'Ready check', veto: 'Veto', lineup: 'Lineups',
  server: 'Waiting for the server', hold: 'On hold', done: 'Finished',
};

const team = (v: MatchRoomView, s: 'a' | 'b'): string => (s === 'a' ? v.a.name : v.b.name);

export function stepText(v: MatchRoomView): string {
  const n = v.next;
  if (!n) return '';
  if (n.kind === 'wait') return `Game ${n.game} is picked after game ${n.game - 1}.`;
  const who = team(v, n.by);
  switch (n.kind) {
    case 'order': return `${who}: go first or second`;
    case 'ban': return `${who}: ban a campaign`;
    case 'pick': return `${who}: pick game ${n.game}`;
    case 'side': return `${who}: choose sides for game ${n.game}`;
  }
}

export function logText(v: MatchRoomView, l: RoomLogLine): string {
  const who = team(v, l.side);
  const what = l.action === 'ban' ? `banned ${l.campaignName}` : l.action === 'pick' ? `picked ${l.campaignName}`
    : l.action === 'first' ? 'chose to go first' : l.action === 'second' ? 'chose to go second'
      : l.action === 'survivors' ? 'chose survivors first' : 'chose infected first';
  return `${who} ${what}${l.auto ? ' (automatic)' : ''}`;
}

export function clockText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
```

`web/src/routes/event/room/VetoBoard.tsx`:

```tsx
import type { MatchRoomView, RoomCampaign } from '../../../api';
import { stepText } from './roomText';

const tileText = (v: MatchRoomView, c: RoomCampaign): string => {
  const who = c.by === 'a' ? v.a.name : c.by === 'b' ? v.b.name : '';
  if (c.state === 'banned') return `Banned by ${who}`;
  if (c.state === 'picked') return `Game ${c.game} picked by ${who}`;
  if (c.state === 'decider') return `Game ${c.game}, the decider`;
  return 'Open';
};

/** The pool, whose turn it is, and the buttons for the manager whose turn
 *  it is. onAct sends the step the page saw, so a step someone else took in
 *  the meantime is refused by the server, not applied twice. */
export function VetoBoard({ v, busy, onAct }: { v: MatchRoomView; busy: boolean; onAct: (step: number, action: string, campaign: string | null) => void }) {
  const n = v.next;
  const mine = !!n && n.kind !== 'wait' && v.me?.manager === true && v.me.side === n.by;
  const choosing = mine && n && (n.kind === 'ban' || n.kind === 'pick') ? n : null;
  return (
    <section class="vetoboard" aria-label="Veto">
      <p class="muted">{v.vetoSummary}</p>
      {n && <p class="vetoboard__turn"><strong>{stepText(v)}</strong></p>}
      <ul class="vetoboard__pool">
        {v.pool.map((c) => (
          <li key={c.slug} class={`vetotile vetotile--${c.state}`}>
            <span class="vetotile__name">{c.name}</span>
            <span class="vetotile__state">{tileText(v, c)}</span>
            {choosing && c.state === 'open' && (
              <button class="btn btn--small" type="button" disabled={busy} onClick={() => onAct(choosing.step, choosing.kind, c.slug)}>
                {`${choosing.kind === 'ban' ? 'Ban' : 'Pick'} ${c.name}`}
              </button>
            )}
          </li>
        ))}
      </ul>
      {mine && n && n.kind === 'order' && (
        <div class="vetoboard__choice">
          <button class="btn" type="button" disabled={busy} onClick={() => onAct(n.step, 'first', null)}>Go first</button>
          <button class="btn" type="button" disabled={busy} onClick={() => onAct(n.step, 'second', null)}>Go second</button>
        </div>
      )}
      {mine && n && n.kind === 'side' && (
        <div class="vetoboard__choice">
          <button class="btn" type="button" disabled={busy} onClick={() => onAct(n.step, 'survivors', null)}>Survivors first</button>
          <button class="btn" type="button" disabled={busy} onClick={() => onAct(n.step, 'infected', null)}>Infected first</button>
        </div>
      )}
    </section>
  );
}
```

`web/src/routes/event/room/LineupPanel.tsx`:

```tsx
import { useState } from 'preact/hooks';
import type { MatchRoomView, RoomPlayer } from '../../../api';
import { confirm } from '../../../components/Confirm';

function Four({ name, players, locked }: { name: string; players: RoomPlayer[] | null; locked: boolean }) {
  if (players) return <div class="lineup"><strong>{name}</strong><ul>{players.map((p) => <li key={p.steamid}>{p.name}</li>)}</ul></div>;
  return <p class="lineup lineup--hidden">{`${name}: ${locked ? 'locked' : 'picking'}`}</p>;
}

/** Ruling 9: a manager whose team has not locked picks exactly four;
 *  everyone else sees each team's four once shown, or locked / picking. */
export function LineupPanel({ v, busy, onLock }: { v: MatchRoomView; busy: boolean; onLock: (steamids: string[]) => Promise<void> }) {
  const me = v.me;
  const myLocked = me ? (me.side === 'a' ? v.lineups.aLocked : v.lineups.bLocked) : true;
  const picking = v.phase === 'lineup' && me?.manager === true && !myLocked;
  const [chosen, setChosen] = useState<string[]>(() => me?.defaultFour ?? []);
  const toggle = (s: string) => setChosen((c) => (c.includes(s) ? c.filter((x) => x !== s) : [...c, s]));
  const myName = me?.side === 'b' ? v.b.name : v.a.name;
  const lock = async () => {
    if (!await confirm({ title: `Lock ${myName}' lineup?`, body: 'You cannot change it for this match.', confirmLabel: 'Lock lineup' })) return;
    await onLock(chosen);
  };
  return (
    <section class="lineups" aria-label="Lineups">
      {picking && me && (
        <div class="lineup lineup--pick">
          <p>{`Pick your four (${chosen.length} of 4)`}</p>
          {me.playable.map((p) => (
            <label key={p.steamid}>
              <input type="checkbox" aria-label={p.name} checked={chosen.includes(p.steamid)} onChange={() => toggle(p.steamid)} /> {p.name}
            </label>
          ))}
          <button class="btn" type="button" disabled={busy || chosen.length !== 4} onClick={() => { void lock(); }}>Lock lineup</button>
        </div>
      )}
      <Four name={v.a.name} players={v.lineups.a} locked={v.lineups.aLocked} />
      <Four name={v.b.name} players={v.lineups.b} locked={v.lineups.bLocked} />
    </section>
  );
}
```

Check `confirm`'s real signature (`web/src/components/Confirm.tsx`) and pass the title, body and button label the way other callers do. Use a typographic-free apostrophe as above ("Lock Rats' lineup?"); a team name ending in s reads fine and others read "Lock Bats' lineup?", which is acceptable copy. If the owner prefers, change it to "Lock this lineup?".

`web/src/routes/EventMatch.tsx`:

```tsx
import { useEffect, useState } from 'preact/hooks';
import { ApiError, entryLogoUrl, eventsApi, type MatchRoomView, type PlayEntry } from '../api';
import { Empty, Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import { useHubEvent } from '../hooks/useHubEvent';
import type { Session } from '../hooks/useLiveState';
import { PHASE_TEXT, clockText, logText } from './event/room/roomText';
import { VetoBoard } from './event/room/VetoBoard';
import { LineupPanel } from './event/room/LineupPanel';

const LIVE = new Set(['ready', 'veto', 'lineup']);

function Team({ e }: { e: PlayEntry }) {
  return (
    <span class="room__team">
      {e.logoKey ? <img class="evententry__logo" src={entryLogoUrl(e.logoKey)} alt="" width={28} height={28} /> : null}
      {e.name}
    </span>
  );
}

/** One tournament match's room (plan T3a): ready check, veto, lineups. */
export function EventMatchPage({ slug, id, session }: { slug: string; id: string; session: Session }) {
  const matchId = Number(id);
  const [v, setV] = useState<MatchRoomView | null>(null);
  const [missing, setMissing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(Date.now());

  const load = () => eventsApi.room(slug, matchId).then((x) => {
    setV(x);
    setOffset(Date.parse(x.serverNow) - Date.now());
  }, (e) => { if (e instanceof ApiError && e.status === 404) setMissing(true); });

  useEffect(() => { void load(); }, [slug, id, session.kind]);
  useHubEvent(['event_room'], () => { void load(); });
  useEffect(() => {
    if (!v || !LIVE.has(v.phase)) return undefined;
    const poll = setInterval(() => { void load(); }, 10_000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(poll); clearInterval(clock); };
  }, [v?.phase]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await fn();
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : 'That did not go through. Try again.');
    } finally {
      setBusy(false);
      await load();
    }
  };

  if (missing || !Number.isInteger(matchId)) return <main class="page page--profile"><PageHeader title="Match" /><Empty>No such match.</Empty></main>;
  if (!v) return <main class="page page--profile"><PageHeader title="Match" /></main>;

  const left = v.deadline ? Date.parse(v.deadline) - (now + offset) : null;
  const me = v.me;
  const myReady = me ? v.ready[me.side] : true;
  const showVeto = v.phase === 'veto' || v.pool.some((c) => c.state !== 'open');
  return (
    <main class="page page--profile room">
      <PageHeader
        eyebrow={<a href={`/event/${v.eventSlug}`}>{v.eventName}</a>}
        title={`${v.a.name} vs ${v.b.name}`}
        aside={<span class={`teamchip roomphase roomphase--${v.phase}`}>{PHASE_TEXT[v.phase]}</span>}
      >
        <p class="room__sub">{v.roundLabel}{left !== null && <span class="room__clock"> · {clockText(left)} left</span>}</p>
      </PageHeader>
      {problem && <p class="error" role="alert">{problem}</p>}
      {v.phase === 'ready' && (
        <Panel>
          <h3>Ready check</h3>
          <ul class="room__ready">
            {(['a', 'b'] as const).map((s) => (
              <li key={s}><Team e={v[s]} /><span>{`${v[s].name}: ${v.ready[s] ? 'ready' : 'waiting'}`}</span></li>
            ))}
          </ul>
          {me?.manager && !myReady && <button class="btn" type="button" disabled={busy} onClick={() => run(() => eventsApi.ready(slug, matchId))}>Ready</button>}
        </Panel>
      )}
      {showVeto && (
        <Panel>
          <h3>Veto</h3>
          <VetoBoard v={v} busy={busy} onAct={(step, action, campaign) => { void run(() => eventsApi.veto(slug, matchId, step, action, campaign)); }} />
          {v.games.length > 0 && (
            <ul class="room__games">
              {v.games.map((g) => (
                <li key={g.game}>{`Game ${g.game}: ${g.campaignName}${g.firstSurvivors ? ` · ${g.firstSurvivors === 'a' ? v.a.name : v.b.name} start as survivors` : ''}`}</li>
              ))}
            </ul>
          )}
        </Panel>
      )}
      {(v.phase === 'lineup' || v.phase === 'server' || v.lineups.aLocked || v.lineups.bLocked) && (
        <Panel>
          <h3>Lineups</h3>
          <LineupPanel v={v} busy={busy} onLock={(ids) => run(() => eventsApi.lineup(slug, matchId, ids))} />
        </Panel>
      )}
      {v.phase === 'server' && <Panel><p>Lineups locked. Staff are setting up the server; the connect details come from them.</p></Panel>}
      {v.phase === 'hold' && <Panel><p class="warning">{`On hold: staff are looking at this match.${v.holdReason ? ` (${v.holdReason})` : ''}`}</p></Panel>}
      {v.phase === 'done' && v.result && (
        <Panel>
          <p>{v.result.forfeit
            ? `Forfeit win for ${v.result.winner === 'a' ? v.a.name : v.b.name}.`
            : `${v.result.winner === 'a' ? v.a.name : v.b.name} won ${v.result.scoreA} to ${v.result.scoreB}.`}</p>
        </Panel>
      )}
      {v.log.length > 0 && (
        <Panel>
          <h3>Veto log</h3>
          <ol class="room__log">{v.log.map((l) => <li key={l.step}>{logText(v, l)}</li>)}</ol>
        </Panel>
      )}
    </main>
  );
}

export default EventMatchPage;
```

If `PageHeader`'s `eyebrow` takes only a string, render the event link inside the header's children instead. In the ready list, `Team` shows the logo and name and the sentence sits in its own `<span>`, which is the exact text the test finds ("Bats: ready"); if that reads twice on screen, drop the name from `Team` there and keep only its logo.

In `web/src/AppRoutes.tsx`, next to the event route:

```tsx
const EventMatchPage = lazy(() => import('./routes/EventMatch'));
...
      <Route path="/event/:slug/match/:id" component={EventMatchPage} session={session} />
```

In `web/src/styles/app.css`, add styles for `.room`, `.room__sub`, `.room__clock`, `.room__ready`, `.room__games`, `.room__log`, `.roomphase--*` (reuse the `eventstatus--*` chip colours: ready and veto as live, lineup as checkin, server and hold as warning, done as finished), `.vetoboard`, `.vetoboard__pool` (a grid: `grid-template-columns: repeat(auto-fill, minmax(150px, 1fr))`, gap from the existing spacing tokens), `.vetotile` and its `--open` / `--banned` (muted, struck name) / `--picked` / `--decider` (accent border) modifiers, `.vetoboard__choice` (two buttons in a row that wrap), `.lineups`, `.lineup`, `.lineup--hidden`, `.lineup--pick`. Use the existing CSS custom properties for colour (look at how `.matchcard--done` and `.eventstatus--live` are coloured) so dark and light both work. Nothing may be wider than the viewport at 390 px.

- [ ] **Step 4: Run the tests and the build**

Run: `npx vitest run web/src/routes/event/room web/src/routes/EventMatch.test.tsx && npm run typecheck && npm run build`
Expected: PASS and a clean build.

- [ ] **Step 5: Commit**

```bash
git add web/src/api.ts web/src/AppRoutes.tsx web/src/styles/app.css web/src/routes/EventMatch.tsx web/src/routes/EventMatch.test.tsx web/src/routes/event/room
git commit -m "Tournaments T3a: the match room page with the ready check, a live veto board, secret lineups and the veto log"
```

---
### Task 8: Match prep on the event page (default four, side, campaign order)

**Files:**
- Create: `web/src/routes/event/PrepPanel.tsx`, `web/src/routes/event/prepOrder.ts`
- Modify: `web/src/routes/Event.tsx`, `web/src/styles/app.css`
- Test: `web/src/routes/event/PrepPanel.test.tsx`, `web/src/routes/event/prepOrder.test.ts`

**Interfaces:**
- Consumes: `eventsApi.prefs`, `eventsApi.savePrefs`, `PrefsView` (Task 7); `MyEntryView.manage` (T1b).
- Produces in `prepOrder.ts` (pure): `fullOrder(pool: string[], saved: string[]): string[]` (the saved order first, then the rest of the pool in pool order, dropping saved slugs no longer in the pool) and `moveIn(list: string[], i: number, by: -1 | 1): string[]`.
- Produces `PrepPanel({ slug, entryId, teamName })`.

The panel sits under the T1b `EntryPanel`, once per entry the viewer manages (`mine.entries.filter((e) => e.manage && (e.status === 'registered' || e.status === 'checked_in'))`), and only while the event is not finished or cancelled. Title: "Match prep: Rats". Three parts:
1. **Default four**: checkboxes over the roster (starters and subs). Help line: "Locked for you when your lineup timer runs out." Pick exactly 4, or none.
2. **Side**: a select, "No preference (survivors first)", "Survivors first", "Infected first". Help: "Used when your side-choice timer runs out."
3. **Campaign order**, one block per stage ("Stage 1"): the stage's pool as a numbered list, most wanted first, each row with Up and Down buttons (aria-labels "Move No Mercy up" / "Move No Mercy down"). Help: "When a ban timer runs out, the room bans your lowest campaign; when a pick timer runs out, it picks your highest."
One Save button sends everything (every stage's full displayed order). A saved line ("Saved.") or the server's refusal sentence in `role="alert"`.

- [ ] **Step 1: Write the failing tests**

`web/src/routes/event/prepOrder.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { fullOrder, moveIn } from './prepOrder';

describe('prepOrder', () => {
  it('puts the saved order first, then the rest of the pool, dropping campaigns that left the pool', () => {
    expect(fullOrder(['a', 'b', 'c', 'd'], ['c', 'gone', 'a'])).toEqual(['c', 'a', 'b', 'd']);
    expect(fullOrder(['a', 'b'], [])).toEqual(['a', 'b']);
  });
  it('moves an item up or down and ignores a move off either end', () => {
    expect(moveIn(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveIn(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveIn(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });
});
```

`web/src/routes/event/PrepPanel.test.tsx` (mock `eventsApi.prefs` and `savePrefs` with `vi.hoisted`, as `EntryPanel.test.tsx` does):

```tsx
const prefs: PrefsView = {
  entryId: 5, defaultFour: null, side: null,
  roster: ['p1', 'p2', 'p3', 'p4', 'p5'].map((s) => ({ steamid: s, name: s.toUpperCase() })),
  stages: [{ stageId: 9, ordinal: 1, pool: [{ slug: 'no_mercy', name: 'No Mercy' }, { slug: 'dead_air', name: 'Dead Air' }, { slug: 'death_toll', name: 'Death Toll' }], order: ['dead_air'] }],
};

describe('PrepPanel', () => {
  it('loads the saved order, reorders, and saves the whole thing', async () => {
    mockEvents.prefs.mockResolvedValue(prefs);
    mockEvents.savePrefs.mockResolvedValue({});
    render(<PrepPanel slug="cup" entryId={5} teamName="Rats" />);
    const rows = await screen.findAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('Dead Air'), expect.stringContaining('No Mercy'), expect.stringContaining('Death Toll')]);
    fireEvent.click(screen.getByRole('button', { name: 'Move Death Toll up' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Side' }), { target: { value: 'infected' } });
    ['P1', 'P2', 'P3', 'P5'].forEach((n) => fireEvent.click(screen.getByRole('checkbox', { name: n })));
    fireEvent.click(screen.getByRole('button', { name: 'Save match prep' }));
    await waitFor(() => expect(mockEvents.savePrefs).toHaveBeenCalledWith('cup', 5, {
      defaultFour: ['p1', 'p2', 'p3', 'p5'], side: 'infected', campaigns: { 9: ['dead_air', 'death_toll', 'no_mercy'] },
    }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });

  it('will not save a default four of three', async () => {
    mockEvents.prefs.mockResolvedValue(prefs);
    render(<PrepPanel slug="cup" entryId={5} teamName="Rats" />);
    ['P1', 'P2', 'P3'].forEach(async (n) => fireEvent.click(await screen.findByRole('checkbox', { name: n })));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save match prep' }) as HTMLButtonElement).disabled).toBe(true));
  });
});
```

The default four's order in the saved body is the roster order of the ticked boxes.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run web/src/routes/event/prepOrder.test.ts web/src/routes/event/PrepPanel.test.tsx`
Expected: FAIL (modules missing).

- [ ] **Step 3: Write the pieces**

`web/src/routes/event/prepOrder.ts`:

```ts
/** A stage's campaign order as the prep panel shows it: what was saved,
 *  then the rest of the pool, so every campaign has a place. */
export function fullOrder(pool: string[], saved: string[]): string[] {
  const kept = saved.filter((s) => pool.includes(s));
  return [...kept, ...pool.filter((s) => !kept.includes(s))];
}

export function moveIn(list: string[], i: number, by: -1 | 1): string[] {
  const j = i + by;
  if (j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}
```

`web/src/routes/event/PrepPanel.tsx`:

```tsx
import { useEffect, useState } from 'preact/hooks';
import { ApiError, eventsApi, type PrefsView } from '../../api';
import { Panel } from '../../components/bits';
import { fullOrder, moveIn } from './prepOrder';

/** Plan T3a Rulings 7 and 9: what the match room's timers act from. */
export function PrepPanel({ slug, entryId, teamName }: { slug: string; entryId: number; teamName: string }) {
  const [p, setP] = useState<PrefsView | null>(null);
  const [four, setFour] = useState<string[]>([]);
  const [side, setSide] = useState<'' | 'survivors' | 'infected'>('');
  const [orders, setOrders] = useState<Record<number, string[]>>({});
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    eventsApi.prefs(slug, entryId, ctl.signal).then((x) => {
      setP(x);
      setFour(x.defaultFour ?? []);
      setSide(x.side ?? '');
      setOrders(Object.fromEntries(x.stages.map((s) => [s.stageId, fullOrder(s.pool.map((c) => c.slug), s.order)])));
    }, () => { /* the panel stays hidden */ });
    return () => ctl.abort();
  }, [slug, entryId]);

  if (!p) return null;
  const toggle = (s: string) => setFour((f) => (f.includes(s) ? f.filter((x) => x !== s) : [...f, s]));
  const fourOk = four.length === 0 || four.length === 4;
  const save = async () => {
    setBusy(true);
    setNote(null);
    try {
      await eventsApi.savePrefs(slug, entryId, {
        defaultFour: four.length === 4 ? p.roster.map((r) => r.steamid).filter((s) => four.includes(s)) : null,
        side: side === '' ? null : side,
        campaigns: Object.fromEntries(Object.entries(orders)),
      });
      setNote({ ok: true, text: 'Saved.' });
    } catch (e) {
      setNote({ ok: false, text: e instanceof ApiError ? e.message : 'Could not save. Try again.' });
    } finally {
      setBusy(false);
    }
  };
  const nameOf = (stageId: number, slugName: string) => p.stages.find((s) => s.stageId === stageId)?.pool.find((c) => c.slug === slugName)?.name ?? slugName;

  return (
    <Panel class="prep">
      <h3>{`Match prep: ${teamName}`}</h3>
      <section>
        <h4>Default four</h4>
        <p class="muted">Locked for you when your lineup timer runs out. Pick exactly 4, or none.</p>
        <div class="admin-checks">
          {p.roster.map((r) => (
            <label key={r.steamid}><input type="checkbox" aria-label={r.name} checked={four.includes(r.steamid)} onChange={() => toggle(r.steamid)} /> {r.name}</label>
          ))}
        </div>
      </section>
      <section>
        <h4>Side</h4>
        <p class="muted">Used when your side-choice timer runs out.</p>
        <select aria-label="Side" value={side} onChange={(e) => setSide((e.target as HTMLSelectElement).value as typeof side)}>
          <option value="">No preference (survivors first)</option>
          <option value="survivors">Survivors first</option>
          <option value="infected">Infected first</option>
        </select>
      </section>
      {p.stages.map((s) => (
        <section key={s.stageId}>
          <h4>{`Stage ${s.ordinal}: campaign order`}</h4>
          <p class="muted">When a ban timer runs out, the room bans your lowest campaign; when a pick timer runs out, it picks your highest.</p>
          <ol class="prep__order">
            {(orders[s.stageId] ?? []).map((slugName, i, list) => {
              const name = nameOf(s.stageId, slugName);
              const move = (by: -1 | 1) => setOrders((o) => ({ ...o, [s.stageId]: moveIn(list, i, by) }));
              return (
                <li key={slugName}>
                  <span>{name}</span>
                  <button class="btn btn--small btn--ghost" type="button" aria-label={`Move ${name} up`} disabled={i === 0} onClick={() => move(-1)}>Up</button>
                  <button class="btn btn--small btn--ghost" type="button" aria-label={`Move ${name} down`} disabled={i === list.length - 1} onClick={() => move(1)}>Down</button>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
      {note && <p class={note.ok ? 'muted' : 'error'} role={note.ok ? undefined : 'alert'}>{note.text}</p>}
      <button class="btn" type="button" disabled={busy || !fourOk} onClick={() => { void save(); }}>Save match prep</button>
    </Panel>
  );
}
```

The test reads `listitem`s and expects only the campaign rows: the default-four checkboxes are labels in a div (not list items), so that holds; if another list renders inside the panel later, scope the query with `within`.

In `web/src/routes/Event.tsx`, after the `EntryPanel` line:

```tsx
      {mine && ev.entryKind === 'team' && !['finished', 'cancelled'].includes(ev.status) && mine.entries
        .filter((e) => e.manage && (e.status === 'registered' || e.status === 'checked_in'))
        .map((e) => <PrepPanel key={e.id} slug={ev.slug} entryId={e.id} teamName={e.name} />)}
```

CSS: `.prep section + section { margin-top: ... }`, `.prep__order li { display: flex; gap; align-items: center }` with the name taking the free space; buttons wrap under the name at 390 px if needed.

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run web/src/routes/event && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/event/PrepPanel.tsx web/src/routes/event/PrepPanel.test.tsx web/src/routes/event/prepOrder.ts web/src/routes/event/prepOrder.test.ts web/src/routes/Event.tsx web/src/styles/app.css
git commit -m "Tournaments T3a: match prep on the event page, a team's default four, side and campaign order for the room's timers"
```

---

### Task 9: Veto knobs in the stage editor

**Files:**
- Create: `web/src/routes/admin/events/VetoFields.tsx`
- Modify: `web/src/routes/admin/events/StageForm.tsx`, `web/src/routes/admin/events/stageDraft.ts`
- Test: `web/src/routes/admin/events/VetoFields.test.tsx`, `web/src/routes/admin/events/StageForm.test.tsx`

**Interfaces:**
- Consumes: `vetoConfig.ts` (shared, Task 1): `VETO_PRESETS`, `PRESET_LABEL`, `PRESET_MIN_POOL`, `presetConfig`, `presetOf`, `checkVeto`, `vetoSummary`, `VetoConfig`.
- Produces: `StageDraft.veto: VetoConfig` (replacing `vetoType`); `settingsFrom` sends `veto` (the server derives `vetoType`); `VetoFields({ value, poolSize, onChange })`.

The "Veto" row of the Matches group becomes a block:
1. **Format**: a select of the four presets plus Custom (`PRESET_LABEL`). Choosing a preset fills every knob from `presetConfig(p, poolSize)`. A preset whose `PRESET_MIN_POOL` is above the current pool size is shown disabled with "(needs N campaigns)".
2. The knobs, always visible under it (owner: "versatility"): Series (Bo1, Bo2 total score, Bo3, Bo5), Ban down to (a number, 1 to the pool size), Who goes first (Higher seed chooses first or second, Higher seed, Lower seed, Coin flip), Game 1 is picked by (Higher seed, Lower seed, Team that goes first, Team that goes second, Coin flip; hidden for a Bo1 that bans down to 1), Later games (Loser of the previous game picks, Teams take turns; hidden for Bo1), Extra bans before the last game (a number; shown only with Teams take turns and Bo3 or Bo5), Sides (Team that did not pick chooses, Higher seed chooses, Coin flip).
3. A live sentence under the knobs: `vetoSummary(value, poolSize)`, or, when `checkVeto` says no, the reason in plain words: "Ban down to at least one campaign per game.", "The pool needs at least N campaigns for this.", "A total score Bo2 has no loser to pick next.", "Too many extra bans: nothing would be left for the last game."
The preset select shows `presetOf(value, poolSize)`, so a knob change that leaves the preset's values reads Custom on its own.

When the pool changes size, a preset-backed config is refilled from its preset for the new size (so "Pick and ban" on 7 then 5 campaigns stays the classic order); a Custom config is left as it is and the sentence shows any problem.

- [ ] **Step 1: Write the failing tests**

`web/src/routes/admin/events/VetoFields.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { presetConfig } from '../../../../../src/events/vetoConfig';
import { VetoFields } from './VetoFields';

afterEach(cleanup);

describe('VetoFields', () => {
  it('fills the knobs from a preset and states the format in one sentence', () => {
    const change = vi.fn();
    render(<VetoFields value={presetConfig('ban_to_one', 7)} poolSize={7} onChange={change} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Veto format' }), { target: { value: 'loser_picks' } });
    expect(change).toHaveBeenCalledWith(presetConfig('loser_picks', 7));
  });

  it('reads Custom after a knob changes, and explains a config that cannot run', () => {
    const change = vi.fn();
    const { rerender } = render(<VetoFields value={presetConfig('loser_picks', 7)} poolSize={7} onChange={change} />);
    expect((screen.getByRole('combobox', { name: 'Veto format' }) as HTMLSelectElement).value).toBe('loser_picks');
    expect(screen.getByText(/the loser of each game picks the next/)).toBeTruthy();
    rerender(<VetoFields value={{ ...presetConfig('loser_picks', 7), banTo: 4 }} poolSize={7} onChange={change} />);
    expect((screen.getByRole('combobox', { name: 'Veto format' }) as HTMLSelectElement).value).toBe('custom');
    rerender(<VetoFields value={{ ...presetConfig('loser_picks', 7), banTo: 2 }} poolSize={7} onChange={change} />);
    expect(screen.getByText('Ban down to at least one campaign per game.')).toBeTruthy();
  });

  it('hides the knobs a Bo1 does not use', () => {
    render(<VetoFields value={presetConfig('ban_to_one', 7)} poolSize={7} onChange={() => {}} />);
    expect(screen.queryByRole('combobox', { name: 'Later games' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Game 1 is picked by' })).toBeNull();
  });

  it('disables a preset the pool is too small for', () => {
    render(<VetoFields value={presetConfig('ban_to_one', 2)} poolSize={2} onChange={() => {}} />);
    expect((screen.getByRole('option', { name: /Pick and ban \(Bo3\) \(needs 5 campaigns\)/ }) as HTMLOptionElement).disabled).toBe(true);
  });
});
```

In `web/src/routes/admin/events/StageForm.test.tsx`, add: saving a new stage after choosing "Ban to three, loser picks (Bo3)" on a pool of at least 3 sends `veto: presetConfig('loser_picks', n)` and no `vetoType` (pick three or more campaigns first so the preset is enabled).

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run web/src/routes/admin/events/VetoFields.test.tsx web/src/routes/admin/events/StageForm.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write `VetoFields.tsx` and wire it**

```tsx
import { useId } from 'preact/hooks';
import {
  PRESET_LABEL, PRESET_MIN_POOL, VETO_PRESETS, checkVeto, presetConfig, presetOf, vetoSummary, type VetoConfig, type VetoPreset,
} from '../../../../../src/events/vetoConfig';
import { FormRow } from './FormRow';

const pick = (e: Event): string => (e.target as HTMLSelectElement).value;

/** Plan T3a Ruling 3: a preset, then every knob. */
export function VetoFields({ value, poolSize, onChange }: { value: VetoConfig; poolSize: number; onChange: (v: VetoConfig) => void }) {
  const uid = useId();
  const id = (k: string) => `${uid}-${k}`;
  const set = (patch: Partial<VetoConfig>) => onChange({ ...value, ...patch });
  const preset = presetOf(value, poolSize);
  const verdict = checkVeto(value, poolSize);
  const problem = verdict === 'ok' ? null
    : verdict === 'bad_pool_for_veto' ? `The pool needs at least ${value.banTo} campaigns for this.`
      : value.banTo < value.games ? 'Ban down to at least one campaign per game.'
        : value.games === 2 && value.laterPicks === 'loser' ? 'A total score Bo2 has no loser to pick next.'
          : 'Too many extra bans: nothing would be left for the last game.';
  const bo1 = value.games === 1;
  return (
    <>
      <FormRow label="Veto format" help="A preset fills the settings below; change any of them for a custom veto." for={id('preset')}>
        <select id={id('preset')} aria-label="Veto format" value={preset} onChange={(e) => {
          const p = pick(e);
          if (p !== 'custom') onChange(presetConfig(p as VetoPreset, poolSize));
        }}>
          {VETO_PRESETS.map((p) => {
            const short = PRESET_MIN_POOL[p] > poolSize;
            return <option key={p} value={p} disabled={short}>{`${PRESET_LABEL[p]}${short ? ` (needs ${PRESET_MIN_POOL[p]} campaigns)` : ''}`}</option>;
          })}
          <option value="custom">{PRESET_LABEL.custom}</option>
        </select>
      </FormRow>
      <FormRow label="Series" for={id('games')}>
        <select id={id('games')} aria-label="Series" value={String(value.games)} onChange={(e) => {
          const games = Number(pick(e)) as VetoConfig['games'];
          set({ games, laterPicks: games === 2 ? 'alternate' : value.laterPicks, lateBans: games === 1 ? 0 : value.lateBans, banTo: Math.max(value.banTo, games) });
        }}>
          <option value="1">Bo1</option>
          <option value="2">Bo2, total score</option>
          <option value="3">Bo3</option>
          <option value="5">Bo5</option>
        </select>
      </FormRow>
      <FormRow label="Ban down to" help={`Campaigns left after the opening bans (1 to ${poolSize}; ${poolSize} means no bans).`} for={id('banTo')}>
        <input id={id('banTo')} aria-label="Ban down to" type="number" min={1} max={poolSize} value={String(value.banTo)}
          onInput={(e) => { const n = Number((e.target as HTMLInputElement).value); if (Number.isInteger(n)) set({ banTo: n }); }} />
      </FormRow>
      <FormRow label="Who goes first" for={id('firstBan')}>
        <select id={id('firstBan')} aria-label="Who goes first" value={value.firstBan} onChange={(e) => set({ firstBan: pick(e) as VetoConfig['firstBan'] })}>
          <option value="higher_chooses">Higher seed chooses first or second</option>
          <option value="higher">Higher seed</option>
          <option value="lower">Lower seed</option>
          <option value="coin">Coin flip</option>
        </select>
      </FormRow>
      {!(bo1 && value.banTo === 1) && (
        <FormRow label="Game 1 is picked by" for={id('firstPick')}>
          <select id={id('firstPick')} aria-label="Game 1 is picked by" value={value.firstPick} onChange={(e) => set({ firstPick: pick(e) as VetoConfig['firstPick'] })}>
            <option value="higher">Higher seed</option>
            <option value="lower">Lower seed</option>
            <option value="first">Team that goes first</option>
            <option value="second">Team that goes second</option>
            <option value="coin">Coin flip</option>
          </select>
        </FormRow>
      )}
      {!bo1 && (
        <FormRow label="Later games" for={id('laterPicks')}>
          <select id={id('laterPicks')} aria-label="Later games" value={value.laterPicks}
            onChange={(e) => set({ laterPicks: pick(e) as VetoConfig['laterPicks'], lateBans: pick(e) === 'loser' ? 0 : value.lateBans })}>
            <option value="loser" disabled={value.games === 2}>Loser of the previous game picks</option>
            <option value="alternate">Teams take turns</option>
          </select>
        </FormRow>
      )}
      {!bo1 && value.games !== 2 && value.laterPicks === 'alternate' && (
        <FormRow label="Extra bans before the last game" for={id('lateBans')}>
          <input id={id('lateBans')} aria-label="Extra bans before the last game" type="number" min={0} max={poolSize} value={String(value.lateBans)}
            onInput={(e) => { const n = Number((e.target as HTMLInputElement).value); if (Number.isInteger(n)) set({ lateBans: n }); }} />
        </FormRow>
      )}
      <FormRow label="Sides" for={id('sides')}>
        <select id={id('sides')} aria-label="Sides" value={value.sides} onChange={(e) => set({ sides: pick(e) as VetoConfig['sides'] })}>
          <option value="non_picker">Team that did not pick chooses</option>
          <option value="higher">Higher seed chooses</option>
          <option value="coin">Coin flip</option>
        </select>
      </FormRow>
      <p class={problem ? 'error' : 'muted'} role={problem ? 'alert' : undefined}>{problem ?? vetoSummary(value, poolSize)}</p>
    </>
  );
}
```

In `stageDraft.ts`: replace `vetoType: VetoType` with `veto: VetoConfig`; `draftFrom` takes `s?.veto ?? presetConfig('ban_to_one', pool.length)`; `settingsFrom` sends `veto: d.veto` (keep a `vetoType` only if `StageSettings` still requires one on the web type; the server ignores it when `veto` is present).

In `StageForm.tsx`: remove `VETOES` and the Veto select; render `<VetoFields value={d.veto} poolSize={d.campaignPool.length} onChange={(veto) => set({ veto })} />` in the Matches group; in `toggle` (the pool checkbox handler), after computing the new pool, refill a preset-backed veto:

```ts
  const toggle = (slug: string) => {
    const pool = d.campaignPool.includes(slug) ? d.campaignPool.filter((s) => s !== slug) : [...d.campaignPool, slug];
    const was = presetOf(d.veto, d.campaignPool.length);
    set({ campaignPool: pool, veto: was === 'custom' ? d.veto : presetConfig(was, pool.length) });
  };
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run web/src/routes/admin/events && npm run typecheck`
Expected: PASS. Fix older StageForm and EventEditor tests that selected the old "Veto" combobox.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/admin/events/VetoFields.tsx web/src/routes/admin/events/VetoFields.test.tsx web/src/routes/admin/events/StageForm.tsx web/src/routes/admin/events/stageDraft.ts web/src/routes/admin/events/StageForm.test.tsx web/src/routes/admin/events/EventEditor.test.tsx
git commit -m "Tournaments T3a: the stage editor offers four veto presets and every knob, with the format in one live sentence"
```

---

### Task 10: Bracket cards link to rooms, the desk's room tools, and the whole-branch check

**Files:**
- Modify: `web/src/routes/event/Bracket.tsx`, `web/src/routes/event/StagePlay.tsx`, `web/src/routes/Event.tsx`, `web/src/routes/admin/events/PlayPanel.tsx`, `web/src/styles/app.css`
- Test: `web/src/routes/event/StagePlay.test.tsx`, `web/src/routes/admin/events/PlayPanel.test.tsx`

**Interfaces:**
- Consumes: `PlayMatch.phase` (Task 6), `adminApi.openEventRoom`, `resetEventRoom`, `holdEventMatch` (Task 7), `PHASE_TEXT` (Task 7).
- Produces: `MatchCard({ m, slug })` and `StagePlay({ stage, slug })`, `Bracket({ stage, slug })`.

- [ ] **Step 1: Write the failing tests**

In `web/src/routes/event/StagePlay.test.tsx`, pass `slug="cup"` to every `StagePlay` render (the `match()` builder gains `phase: 'waiting'`), and add:

```tsx
  it('links a match with both teams to its room and shows the room phase', () => {
    const stage: StagePlayView = {
      ordinal: 1, type: 'single_elim', status: 'live', layout: 'bracket', groups: [{ number: 1, label: 'Bracket' }], standings: [], advanceCount: null, pairsAsItGoes: false,
      rounds: [{ group: 1, round: 1, label: 'Final', dates: null, matches: [match({ id: 7, status: 'veto', phase: 'veto' }), match({ id: 8, b: null, status: 'pending', phase: 'pending' })] }],
    };
    render(<StagePlay stage={stage} slug="cup" />);
    const link = screen.getByRole('link', { name: /Rats.*Bats/ });
    expect(link.getAttribute('href')).toBe('/event/cup/match/7');
    expect(within(link).getByText('Veto')).toBeTruthy();
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });
```

In `web/src/routes/admin/events/PlayPanel.test.tsx`: add `openEventRoom: vi.fn(), resetEventRoom: vi.fn(), holdEventMatch: vi.fn()` to the hoisted `mockAdmin`, give the `m()` builder `phase: 'waiting'`, and add:

```tsx
  const twoMatches = () => play({
    stages: [{ ordinal: 1, type: 'single_elim', status: 'live', layout: 'bracket', groups: [{ number: 1, label: 'Bracket' }], standings: [], advanceCount: null, pairsAsItGoes: false,
      rounds: [{ group: 1, round: 1, label: 'Semifinals', dates: null, matches: [
        m(),
        m({ id: 8, slot: 2, a: team(3, 'Cats'), b: team(4, 'Dogs'), status: 'lineup', phase: 'lineup' }),
      ] }] }],
  });

  it('opens a waiting match\'s room, and resets or holds an open one (plan T3a)', async () => {
    mockAdmin.eventPlay.mockResolvedValue(twoMatches());
    for (const f of [mockAdmin.openEventRoom, mockAdmin.resetEventRoom, mockAdmin.holdEventMatch]) f.mockResolvedValue({});
    render(<PlayPanel eventId={9} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open room: Rats vs Bats' }));
    await waitFor(() => expect(mockAdmin.openEventRoom).toHaveBeenCalledWith(9, 7));
    fireEvent.click(await screen.findByRole('button', { name: 'Reset room: Cats vs Dogs' }));
    await waitFor(() => expect(mockAdmin.resetEventRoom).toHaveBeenCalledWith(9, 8));
    fireEvent.click(await screen.findByRole('button', { name: 'Hold: Cats vs Dogs' }));
    fireEvent.input(screen.getByRole('textbox', { name: 'Hold reason' }), { target: { value: 'Server trouble' } });
    fireEvent.click(screen.getByRole('button', { name: 'Put on hold' }));
    await waitFor(() => expect(mockAdmin.holdEventMatch).toHaveBeenCalledWith(9, 8, 'Server trouble'));
  });

  it('offers the result form on a match in a room phase, and no room buttons to a mod (plan T3a)', async () => {
    mockAdmin.eventPlay.mockResolvedValue(twoMatches());
    render(<PlayPanel eventId={9} canEdit />);
    expect(await screen.findByLabelText('Cats score')).toBeTruthy();
    cleanup();
    render(<PlayPanel eventId={9} canEdit={false} />);
    await screen.findByText('Semifinals');
    expect(screen.queryByRole('button', { name: /Open room|Reset room|Hold:/ })).toBeNull();
  });
```

`canEdit` is the admin flag the panel already takes (mods get `false`).

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run web/src/routes/event/StagePlay.test.tsx web/src/routes/admin/events/PlayPanel.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`Bracket.tsx`:

```tsx
import { PHASE_TEXT } from './room/roomText';
...
export function MatchCard({ m, slug }: { m: PlayMatch; slug: string }) {
  const body = (
    <>
      <Side e={m.a} score={m.scoreA} won={m.winner === 'a'} forfeitLoss={m.forfeit && m.winner === 'b'} bye={false} />
      <Side e={m.b} score={m.scoreB} won={m.winner === 'b'} forfeitLoss={m.forfeit && m.winner === 'a'} bye={m.bye} />
      {m.phase !== 'done' && m.phase !== 'pending' && m.phase !== 'waiting' && <span class="matchcard__phase">{PHASE_TEXT[m.phase]}</span>}
    </>
  );
  if (!m.a || !m.b || m.bye) return <div class={`matchcard matchcard--${m.status}`}>{body}</div>;
  return <a class={`matchcard matchcard--${m.status} matchcard--link`} href={`/event/${slug}/match/${m.id}`}>{body}</a>;
}
```

Thread `slug` through `Bracket` and `StagePlay` to every `MatchCard`, and in `Event.tsx` render `<StagePlay key={s.ordinal} stage={s} slug={ev.slug} />`.

`PlayPanel.tsx`:
- `OPEN` becomes every status where a result may be entered as a first result: `new Set(['waiting', 'veto', 'lineup', 'booking', 'admin_hold'])`.
- `STATUS` labels come from the match's `phase` through `PHASE_TEXT`, with T2's labels kept for `pending`, `waiting` ("To play"), `done`, `forfeit`, `bye`.
- Per match, admin only (the panel already knows whether the viewer is an admin; mods see the labels and no buttons):
  - phase `waiting` with both teams: a button "Open room: A vs B".
  - phase `ready`, `veto`, `lineup`, `server` or `hold`: "Reset room: A vs B" (with the site's `confirm`: "Reset this match room? Ready, veto and lineups are cleared and the room opens again."), and, unless already on hold, "Hold: A vs B", which shows a one-line text box (aria-label "Hold reason") and a "Put on hold" button.
  - phase `hold`: the hold reason under the match.
  - a link "Open the room" to `/event/<slug>/match/<id>` for any match with both teams (the play view gives the event slug, or pass it in from `EventEditor`).
- Each action goes through the panel's existing `run` from `useAction` and refetches the play view after.

CSS: `.matchcard--link` keeps the card's look, no underline, a focus ring from the site's focus style, and a hover state like other card links; `.matchcard__phase` a small chip in the card's corner.

- [ ] **Step 4: Run every test, the typecheck and the build**

Run: `npm test && npm run typecheck && npm run build`
Expected: the whole suite passes (the known wall-clock flake `tests/scrimPoster.test.ts` scrim night reminder may fail on master too; check it fails the same way on master before calling it unrelated), and the build is clean.

- [ ] **Step 5: Walk it on a scratch server**

Start a dev server on a scratch copy of the database (never the live one) as the T2 walk did: make a Swiss event of 4 teams with the "Ban to three, loser picks" veto on a 7-campaign pool, finalise the list, start it. With two browsers signed in as captains of the round 1 pair (dev login), check:
1. Both rooms open within 5 seconds, and the cards on the event page link to them with the Ready check chip.
2. Ready on one side only, wait out the ready timer (set `event_ready_minutes` to 2 on the scratch database): the other team wins by forfeit and the Swiss table counts it.
3. A full veto: 4 bans, the higher seed's pick, the other team's side, then let one lineup time out with a saved default four.
4. Lineups: the other captain sees "locked", not names, until both are in.
5. On the desk: Reset room on a match in lineups reopens it with a fresh ready check; Hold shows the reason on the room page.
6. Restart the dev server mid-veto for longer than a step: the step's timer starts over and nothing was auto-banned for the downtime.
7. At 390 px wide: the room, the veto board, the lineup picker and the prep panel fit with no sideways scroll, in light and dark.

Take screenshots of the room in each phase (`npm run shoot` if it covers the route, else the browser) and keep them in the session scratchpad for the owner.

- [ ] **Step 6: Commit**

```bash
git add web/src/routes/event/Bracket.tsx web/src/routes/event/StagePlay.tsx web/src/routes/event/StagePlay.test.tsx web/src/routes/Event.tsx web/src/routes/admin/events/PlayPanel.tsx web/src/routes/admin/events/PlayPanel.test.tsx web/src/styles/app.css
git commit -m "Tournaments T3a: bracket and round cards link to their match room with its phase, and the desk opens, resets and holds rooms"
```

---

## After the last task

- Final whole-branch review (most capable model), then merge only with the owner's go-ahead. Deploy only with the owner's go-ahead, through `deploy-web.sh`, and verify with the deploy verification recipe (tree hash, bundle strings such as "Match prep" and "Veto format", the new tables and `event_matches` columns, the three settings rows, `NRestarts=0`).
- Production stays behind `competitive_enabled = 'admins'`, so only staff see rooms until the owner opens events up.
