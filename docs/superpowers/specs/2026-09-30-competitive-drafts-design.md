# Competitive platform, part 3: draft events

Date: 2026-09-30. Status: design approved in conversation, awaiting written-spec review.
Depends on part 1 (foundation) and part 2 (tournament engine). Research:
`~/l4d/research/competitive-2026-09-30/draft-tournaments.md`.

## Goal

Most players are solo PUG players with no team. A draft event turns individual signups into
teams on one live, cast-able night, then runs as a normal tournament. It is expected to be the
first thing played on the platform, and the main way teams are born.

### Owner decisions

- Captains: players volunteer, staff pick; if too few volunteers, captaincy is offered down the SR
  list to signups who ticked "willing to captain".
- Snake draft; round 1 in captain SR order, lowest first (a setting).
- Live draft night with a pick timer; auto-pick from the captain's pre-ranked list on timeout or
  absence.
- 4 per team (captain + 3 picks); everyone else is a free-agent bench.
- Drafts are one-night or short events. A season with hand-picked teams is a normal event where
  staff create the entries; no draft machinery.
- The fairness readout goes to staff and the event organizer only.

## 1. Signups

`draft_signups`: event_id, steamid, willing_to_captain, note (short free text, e.g. "prefer
infected", "can't play after 02:00 UTC"), created_at, withdrawn_at, role after the cut (`captain`,
`pool`, `bench`).

- The event has `entry_kind = draft` (part 2). Its eligibility rules apply at signup and at the cut.
- Signups can be withdrawn freely until the cutoff.
- The event page shows the signup count and the list of names (not SR ranks, not notes).

## 2. The cut

At signup close (event setting), staff run the cut on the Events desk:

1. Teams = floor(signups / 4); staff may lower it.
2. Captains: staff choose from the volunteers. The desk suggests the top volunteers by SR with their
   reliability (abandons, no-shows) next to each. If there are too few volunteers, the desk offers
   captaincy to the highest-SR signups who ticked "willing to captain" beyond those already chosen,
   one at a time by DM, with a 30-minute answer window.
3. Pool: the first (teams x 3) non-captain signups by signup time; staff can swap people between
   pool and bench.
4. Everyone else becomes the **free-agent bench**. Nobody who signed up is turned away.

The cut is published: captains, pool and bench appear on the event page, and everyone gets a DM
with their role and the draft time.

## 3. Player cards and captain prep

A player card shows SR and its trend, survivor vs infected performance, best special infected class,
skill stats (skeets, levels, crowns and the other existing skill counters), recent form, and the
player's signup note.

**Chemistry with you**: for a captain looking at a card, how that captain and that player have done
together in PUGs (from the existing chemistry data). Shown only to that captain.

Captains build a **pre-ranked list** of the pool any time between the cut and the draft. The list is
private to the captain (and staff). It drives auto-picks.

## 4. The draft room

`/event/:slug/draft`, live over the websocket.

- Snake order; round 1 in captain SR order, lowest first (event setting `draft_first_pick`:
  `lowest_sr` | `highest_sr` | `random`).
- Pick timer per pick (event setting, default 75 s). On timeout the room picks the highest-ranked
  available player on that captain's list; with no list, the highest-SR available player. Auto
  picks are marked in the log.
- A captain who is absent at start is auto-picked for all their turns until they arrive.
- Each pick is announced with a card reveal. Anyone can watch the room; chemistry and captains'
  lists are never sent to viewers.
- Staff controls: start, pause, resume, undo the last pick, hand a team's picking to its first
  drafted player if the captain is gone.
- The caster studio (part 2, v1.1) gets draft scenes: pick reveal, board, on-the-clock.
- `draft_picks`: event_id, round, pick_no, captain_steamid, steamid, auto, at, undone_at.

The room state lives in the database and every timer runs from a stored deadline, so a web restart
resumes the draft where it was.

## 5. After the draft

- **Fairness readout**, visible to staff and the event organizer only: team SR totals, spread, and
  a pairwise forecast using the existing match forecast. Never shown to players or posted publicly.
- **Team identity**: each captain names the team and uploads a logo before the first match (slur
  filter applies). With nothing set by the deadline, the team is "Team <captain name>".
- The draft creates the event's entries (part 2): one entry per captain, starters = captain + 3
  picks, no subs. The event then runs as a normal tournament.

## 6. Bench and stand-ins

- When a drafted player cannot play a match (or drops out of the event), the captain requests a
  stand-in on the site or with a Discord button.
- The bench is offered one at a time, closest SR first, and only players whose SR is at most
  `standin_sr_margin` (event setting, default 100) above the player being replaced. Each offer is a
  DM with Accept and a 10-minute window, then the next.
- The stand-in is added to the entry as a sub for that match (or for the rest of the event after a
  dropout). Staff can override the margin.
- A player who leaves a drafted team stranded (drops after the draft without a stand-in found) gets
  a staff-visible profile note; repeated cases are a staff matter.

## 7. Keep this team

After the event finishes, the captain gets a "Keep this team" button. The drafted players
(captain + 3 picks) get an Accept. When a majority accept (3 of 4), a real team is created
(foundation `teams`, origin `draft`, origin_ref the event) with the draft name and logo, the players
who accepted as members, and the event and any trophy as its first entry. The 3-team cap applies;
a player at the cap is asked to leave a team first or is left out.

## Error handling

- The cut and the draft are transactions with audit rows; undo is a flagged row, never a delete.
- Captain disconnects: auto-pick keeps the draft moving; staff can hand picking over.
- A stand-in offer with no takers alerts staff; the match can then be delayed, played short-handed
  if both captains agree, or forfeited by staff.

## Testing

- Unit: team count and pool cut, captain fallback offers, snake order with each first-pick mode,
  auto-pick from list and from SR, undo, stand-in eligibility and offer order, keep-team majority.
- Integration: a 20-signup event from signups to cut to draft to entries, with one absent captain
  and one web restart mid-draft; the resulting entries run through part 2's 8-entry flow test.
- Privacy: chemistry, captains' lists and the fairness readout never appear in any response for a
  non-staff, non-organizer viewer other than the owning captain.

## Rollout

Behind `competitive_enabled`, after part 2 plans 1-3. Plans:

1. Signups, cut, captain selection, event page draft sections.
2. Player cards, captain prep list, draft room, fairness readout.
3. Bench and stand-ins, keep this team.
