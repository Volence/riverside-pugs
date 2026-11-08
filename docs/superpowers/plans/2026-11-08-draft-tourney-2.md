# Draft Tourney #2 prep (2026-11-08)

Goal: run a second draft event to try the systems Draft Tourney #1 didn't touch. Draft on the weekend of
Nov 14/15, a scrim week for the draft teams only (Nov 15-20), then a one-night tourney on Nov 21/22.

## Findings (master 18aa40b9)

- **Draft teams can scrim as pickup sides now.** A scrim or booking side is `{ teamId } | { captain }`
  (src/scrims/rules.ts ScrimSide, src/bookings/rules.ts Party). The draft captain posts or accepts as a
  pickup side and invites their drafted players. No `teams` rows needed, so Keep this team
  (src/events/keepTeam.ts, after the event) stays as it is. Cost: scrims count toward the captain's
  personal pickup reliability and reviews, and the card shows the captain, not the draft team name.
- **There's no gate for draft teams only.** `scrims_enabled` is off|admins|everyone
  (src/teams/access.ts scrimsAccess). Needs a new mode.
- **Desk tools missing on the 10-24 night:**
  - Direct swap of two players after publish: BUILT (POST /api/admin/events/:id/draft/swap-players).
  - Pause all rooms: PARTLY. hold-all holds only matches not on a box yet (waiting/veto/lineup/booking).
    Games already on a server play on; freeze is per match (deskTool 'freeze').
  - Late signup after close: MISSING. signUp refuses once `locked_at` is set (closeSignups), there's no
    staff add, and the close time can't be moved after it passes (draft_close_passed). Today the only
    late add is Replace player, which needs someone to replace.

## Work

Owner 2026-11-08: no pickup route. The draft teams scrim as teams, and only they can scrim.

1. **Event teams.** createDraftEntries (src/events/entries.ts) also makes one `teams` row per entry:
   origin 'draft', origin_ref the event, new column `teams.event_entry_id`. The entry's four are members
   and the entry captain is captain. `event_entries.team_id` stays NULL: events code reads team_id to mean
   a team-entry event.
   - They don't count toward the membership cap (activeMembershipCount skips teams with event_entry_id set).
   - Captains can't edit them on the team page (invites, join link, kick, leave, rename, roles, disband)
     while they're bound. Refusal: the team belongs to the event, and staff change it on the Events desk.
   - Kept in step by `syncEventTeam(db, entryId)` in the same transaction as each draft roster write:
     swap-players, replace, captain transfer, merge players. Per-match stand-ins don't touch the team.
   - When the event finishes (or is cancelled or deleted) the team is disbanded. Keep this team makes
     its own new team as it does now, and the scrim records stay on the disbanded one.
2. **`scrims_enabled = event`** plus a `scrims_event_id` setting. Scrims are open to staff and to members
   of that event's teams. In that mode, posting, accepting and challenging only take one of those teams:
   no pickup sides, and no site teams. Discord scrim cards and the night reminder stay off.
3. Desk: "Freeze all games": freeze every match of the live event that is on a box, with a matching
   "Unfreeze all". Built from the existing per-match freeze.
4. Desk: "Add signup" for staff after the close and before the cut is published. The player goes to the
   end of signup order (so the bench, unless staff swap them in). Eligibility still checked. Logged.

## Test list for the event

- Draft night: captains pick in the live draft room (if #1 used auto-balance), bench stand-ins.
- Scrim week: post/accept/confirm, Start now, l4d_booking allowlist, `!allow`/`!sub`, placement, re-tell,
  countdowns, late cancel + excuse, reviews, blocks, private per-side voice, caster invites + /cast relay.
- Casters: caster studio and stream widgets in real OBS; send SND the cast HUD.
- Tourney night: match rules (`!tech` budgets, disconnect pool, emergency bench sub, desk Warn/Forfeit),
  the new desk tools, Keep this team after the final.

## Open owner calls

- Format for one night. Single elim Bo1 + 3rd place fits one night with ~8 teams (3 rounds). Double elim
  or Bo2 won't fit.
- Is the pickup-side route fine for the scrim week, or do the draft teams need real team rows?
