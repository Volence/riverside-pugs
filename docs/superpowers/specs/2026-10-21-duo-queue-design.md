# Duo queue (trial)

Owner request 2026-10-21. Players have asked to queue with a friend. This is a
trial: build it behind a switch, run it, then review how duos affect the game
(section 9) before deciding to keep it.

## 1. Goals and rulings

- Two players form a duo and are **always** on the same team. A hard rule, not
  best effort (owner: "let us always play together").
- No cap on duos per lobby or per team. The balancer always has a legal split
  (15 of 35 with one duo, 7 with two, 3 with three or four).
- No preference for putting two duos on opposite teams. A strong duo plus a
  weak duo against four middle players can be the best split (owner example).
- No rating gap cap inside a duo. Carrying a friend is fine: the balancer
  would often pair them anyway.
- The worry is two high players together beating a team that never felt it
  had a chance. Answer: a **sliding duo bonus** (section 5) that both
  balances teams and changes rating, bigger the higher the duo.
- **Ships with Season 1 exactly** (owner 2026-10-21). Built on the `season1`
  branch and gated by `seasonOneLive(db)` like requeue and end notes, so it
  can deploy with the ~10-27 web deploy and stays invisible and unusable
  until the 11-03 flip. Add a line to `docs/season1-launch-runbook.md`.
- Kill switch: `duo_queue_enabled` (on / off, default on). Duos work only
  when `seasonOneLive(db)` AND the switch is on. Off hides every duo surface
  and the queue treats any existing duo as two solos. Nothing is deleted.

Out of scope: 2v2/3v3 side games (duos ignored, partners may be split),
drafts, scrims, tournaments.

## 2. Forming a duo

- **Site:** "Duo with" button on a profile and in the queue panel sends an
  invite. The invitee sees a banner with Accept / Decline.
- **Discord:** `/duo user:@friend` sends the invite; the bot posts it with
  Accept / Decline buttons that only the invitee can press. `/duo end` ends
  your duo. Both players need a linked Discord for the Discord path.
- Invites expire after 10 minutes. One pending invite per sender.
- A player is in at most one duo. Accepting fails if either player is
  already in one, is banned, held, in a lobby or in a match.
- A duo lasts until either player ends it (site button or `/duo end`). It
  does not reset after a match.
- Ending a duo while queued leaves both players queued as solos.

## 3. Queue

- `Queue` keeps its order of steamids but knows partners. A duo is one entry
  of size 2 for counting and popping.
- Joining (site or Discord button) by either member adds both. Leaving by
  either removes both.
- If a duo forms while one or both members are queued, the pair takes the
  **later** of their two positions, so a duo can never jump the line.
- `takeBatch(8)` walks the order and takes entries that fit. If 7 are taken
  and the next entry is a duo, it is skipped for this pop and keeps its spot
  at the front; the next solo fills the slot. A duo never falls behind people
  who joined after it.
- When there is no solo behind it (the usual case: a duo joining behind 7
  solos makes 9), the pop waits for one more player; the duo never bumps a
  solo who queued before it (owner 2026-10-21: a solo who waited 30 minutes
  must not wait through a second fill because a duo just joined).
- Queue display shows the pair bracketed together (site and Discord card).

## 4. Ready check

- If one member misses ready, both leave the queue. Only the one who missed
  gets the `ready_fail` penalty. The partner sees "your duo missed ready".
- If both were ready and someone else failed, the duo goes back to the front
  together, as `requeueFront` does today.

## 5. Sliding duo bonus

Each duo member counts as `b` mu stronger than their rating:

```
b = duo_bonus_min + (duo_bonus_max - duo_bonus_min) * pct
pct = percentile of the pair's average hidden rating (mu) among players
      with a rating row this season (0 = bottom, 1 = top)
```

- Hidden mu, not display SR: Season 1 hides SR for the first 5 games
  (placement) and the soft reset keeps everyone's order, so mu is a sound
  ranking from the first day while SR is not. The balancer already uses mu.
- Two settings, `duo_bonus_min` and `duo_bonus_max` (mu units). Starting
  values come from the calibration in section 8, set before the switch goes on.
- `b` is computed when the lobby completes and stored on `match_players`
  (`duo_bonus`), so balancing, rating and any season recompute all use the
  same number even after the settings change.

### 5a. Balancing

`balanceTeams` takes an optional `groups` list (pairs that must share a team).
It skips any split that separates a pair and scores the rest with each duo
member's mu raised by `b` (after `balanceMu`, so the newcomer offset still
applies). Everything else is unchanged; with no groups the result is
identical to today, which a test pins.

### 5b. Rating

`applyMatchRatings` runs OpenSkill `rate()` with duo members' mu raised by `b`,
then subtracts `b` back off. Who reads from which run:

| Player | Run used |
|---|---|
| Duo member | every duo inflated |
| Solo on team A | only team B's duos inflated |
| Solo on team B | only team A's duos inflated |

So a top duo gains little for a win and loses more for a loss. Opponents of a
duo gain more for beating it and lose less to it. Solos who land with a duo
are rated as if the duo were just two players (they did not choose it). At
most three `rate()` calls; with no duos it is exactly today's single call.
Quitters keep `quitterLoss` unchanged.

## 6. Data

- `duos` (id, player_a, player_b, created_at, ended_at, ended_by).
- `duo_invites` (id, from_id, to_id, source 'site'|'discord', created_at,
  resolved_at, outcome).
- `match_players.duo_partner` (TEXT NULL) and `match_players.duo_bonus`
  (REAL NULL).
- No stored prediction column: `matchForecast` rebuilds the plain chance from
  `rating_history` and gains `winProbAWithDuo` from `match_players.duo_bonus`,
  so the review can compare both from one source.

## 7. Surfaces

- Site: profile button, queue panel button and bracket, invite banner, "End
  duo" button, a duo tag on the match page roster.
- Discord: `/duo`, invite card with buttons, bracket on the queue card.
- Admin: the two bonus settings and the switch in the settings page
  (Competitive group).

## 8. Calibration (before switching on)

A read-only script over existing matches: for pairs that already landed on
the same team often (the chemistry self join), compare their actual win rate
with the predicted one. The excess gives a first `duo_bonus_max`;
`duo_bonus_min` starts near zero. Also replay past lobbies with a random pair
forced together to show how far the best split drifts from 50%. Results go to
the owner with the proposed numbers.

## 9. Trial review

`scripts/duo-review.ts`, read-only, run at about 2 weeks after the 11-03 flip for a first look and
again at 40 duo matches (or 4 weeks, whichever is later) for the keep/change
decision. It reports, duo matches against non-duo matches over the same
period:

- **Fairness:** duo team actual win rate vs predicted, with and without the
  bonus, split by bonus band (low / mid / high duos). This is the main
  number for tuning `duo_bonus_min` / `max`.
- **How it felt for the other side:** score margin (lopsided games), `!gg`
  forfeits and abandons in duo games vs baseline.
- **4-stacks:** games with two duos on one team, reported separately.
- **Rating:** SR movement of duo players vs their solo games, and of
  their opponents.
- **Queue health:** share of queued players in a duo, wait times
  (`queue_stints`), ready-fail rate for duos vs solos, how often a duo was
  skipped at a pop.
- **Use:** duos formed, how long they last, site vs Discord invites.

Baseline is Season 1 non-duo matches only (the new SR scale and placement
change the numbers, so Season 0 is not a fair comparison).

Output is a short report for the owner with a recommendation: keep, retune
the bonus, or switch off.

## 10. Testing

- Balance: groups never split; no groups gives byte-identical results to
  today; the strong-plus-weak two-duo example picks the same-side split.
- Queue: pop skips a duo at slot 8 and keeps its place; join/leave moves
  both; forming a duo while queued takes the later spot.
- Ready check: partner removed, penalty only on the one who missed.
- Rating: no duos equals the current single `rate()` exactly; duo win gains
  less than the same win without a bonus; opponents gain more; solos on the
  duo's team are rated as without the duo; recompute reproduces the stored
  `duo_bonus`.
- Switch off: no duo surfaces, queue treats duos as solos.
