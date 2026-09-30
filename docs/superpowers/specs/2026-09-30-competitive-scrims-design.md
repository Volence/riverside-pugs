# Competitive platform, part 4: scrim board

Date: 2026-09-30. Status: design approved in conversation, awaiting written-spec review.
Depends on part 1 (foundation: teams, pickup groups, bookings, scrim rules, privacy, voice,
allowlist, approved spectators, caster invites). Research:
`~/l4d/research/competitive-2026-09-30/scrims.md`.

## Goal

Finding a scrim on Discord works; what Discord cannot do is tie the post to a reserved server,
private replays and stats, and a reliability record built from who actually connected. That is the
reason to use the board (scrim.tf died because it offered nothing Discord did not).

### Owner decisions

- Teams and pickup groups can both post and accept.
- The accepting side can ask for campaigns of its own.
- Reliability is public as a factual badge; reviews are private.
- Casters can cast a scrim only when both captains invite them (foundation, visibility).

## 1. Looking-for-scrim posts

`scrim_posts`: id, side kind (`team` | `pickup`), team_id (null for pickup), captain_steamid,
region, starts_at, block_minutes, campaigns_json (the poster's picks, up to 4), sr_range (± around
the side's average, or open), note, status (`open`, `pending`, `booked`, `expired`, `withdrawn`),
created_at, target_team_id (null = public; set = a direct challenge).

- Posting checks capacity for the slot (foundation capacity rule) and the side's booking allowance
  up front, so a post can always be booked.
- Board `/scrims`: open posts filtered by time (viewer's time zone) and by SR range fit. Each post
  shows the side (Team badge with logo, or Pickup), average SR, reliability badge, time, length and
  campaigns.
- Discord: each public post gets a card in a `#scrims` channel (setting), with an Accept button
  that deep-links to the site.
- A direct challenge goes only to the target team's captain and co-captain by DM and site notice.
- Posts expire at their start time; the poster can withdraw any time before acceptance.

## 2. Accepting and campaign requests

- The accepting captain picks their side (a team they captain, or a pickup group they form on the
  spot) and **may add up to 2 campaigns of their own** (setting), or accept the poster's list as is.
- The post goes `pending`. The poster sees the proposed playlist: campaigns alternate between the
  two sides' picks (poster first), trimmed to what fits the block, with the time warning from the
  foundation. The poster confirms or declines.
- On confirm the booking is created (foundation, purpose `scrim`) and both sides get connect details
  closer to the start, voice channels, and reminders.
- Several sides can accept the same post; the poster picks one and the others are told it is taken.
- A pending acceptance times out after 2 hours without an answer, or at 30 minutes before the start.

## 3. Reliability

Computed from bookings, never from opinions. Per side (team, or captain for pickup groups):

- **Shown**: bookings where the side had at least 4 players on the server within the grace.
- **No-show**: the grace ran out with the side short (foundation no-show path).
- **Late cancel**: cancelled less than 2 hours before the start (setting).

Badge, public on posts and team pages: "Reliable: 14 of 15 shown" plus a late-cancel count when
nonzero. Sides with fewer than 3 bookings show "New". The same numbers drive the foundation's
booking allowance (each no-show in 30 days lowers it).

For pickup groups the record belongs to the captain who booked, so a player cannot escape a bad
record by forming a new group.

## 4. Private reviews

After a booking ends, each side's captain gets a one-tap review of the opponent: thumbs up or down
plus optional tags (`on time`, `good comms`, `good sport`, `left early`, `toxic`).

- Individual reviews are visible only to staff.
- A team sees only its own aggregate (for example "92% positive, top tag: on time").
- Nothing about reviews is shown on posts or public pages, which stops revenge-rating.
- Repeated `toxic` tags raise a staff-visible flag on the admin People desk.

## 5. Scrim night

An optional weekly banner on the board ("Scrim night: Thursdays 21:00-01:00 UTC", a setting) and a
Discord reminder, to cluster activity while the scene is small. Posts inside the window are
highlighted.

## Error handling

- Accept, confirm and booking creation are one transaction; a capacity change between posting and
  confirm (for example staff lowering the reserve) re-checks and, if the slot is gone, offers the
  nearest free slot to both captains instead of failing silently.
- Reliability is recomputed from booking rows, never incremented in place, so a staff correction to
  a booking (for example marking a crash as nobody's fault) fixes the badge automatically.

## Testing

- Unit: SR range fit, playlist alternation and trimming, acceptance timeouts, reliability counts
  (including crash-excused bookings and the pickup-captain rule), review aggregation.
- Integration: post, two accepts, confirm one, booking created, both sides notified; a no-show
  updates the badge and the allowance.
- Privacy: individual reviews never appear in any non-staff response.

## Rollout

Behind `competitive_enabled`, after foundation plan 4 (bookings). Plans:

1. Posts, board, accept with campaign requests, confirm into bookings, Discord cards.
2. Reliability badge and reviews, scrim night banner.

## Later

Standing (recurring) scrims, one-click rebook, private replay notes per team, "teams you haven't
played" suggestions.
