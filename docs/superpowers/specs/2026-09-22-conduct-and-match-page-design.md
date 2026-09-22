# Conduct history, staff chat log, MMR on the match page

Approved by the owner in chat, 2026-09-22.

## Owner's rulings

- Scroll-wheel binds for `+attack` / `+jump` are LEGAL in ranked.
- The full chat log is visible to admins and moderators only.
- Tickets, penalties and failed connects already show on the Player File; not repeated.

## 1. Wheel-like input flags stop putting players on Needs a look

A detection whose note says `wheel-like` stays on the file's timeline but is not
evidence for Needs a look, unless its bursts are flat in rate: a script tapping with
one-tick holds looks like a wheel, but a real wheel's rate wobbles.

## 2. Country names

Identity shows "United States", not "US", via `Intl.DisplayNames`, falling back to the
code when the browser cannot name it.

## 3. MMR change on the finished match page

`/api/matches/:id` already sends `srDelta`. Show it beside each player in the
scoreboard, with the profile's `SrDelta` style. A player with no rating row for the
match (unrated) shows nothing rather than "+0", so the API sends `srDelta: null` then.

## 4. Staff chat log on the match page

New staff-only endpoint returning every `match_chat` line of a completed match,
INCLUDING the 27% with `t_ms = -1` (ready-up, pauses, between halves) that the replay
timeline filters out. Match page shows it, in seq order, labelled by map and phase,
to admins and mods. `?chat=<steamid>` highlights one player's lines and scrolls to it.

## 5. Conduct block on the Player File

- Ready-ups: average seconds not ready vs the league average, "last to ready in X of
  Y", and the five slowest with links to their match. From existing tables.
- Pauses: pauses called and total seconds paused, "tracked since <date>". Needs the
  caller, see 6. Rows with no caller are never attributed to anyone.
- Chat: each match in the list links to `/match/<id>?chat=<steamid>`.

## 6. Who called a pause

pug-match's `!pause` listener already knows the client. It appends `by=<steamid64>`
to the pause phase report; the web stores it in `match_pauses.called_by` (nullable,
NULL for every older row and for disconnect pauses). Old plugins without `by=` keep
working. Plugin deploy needed, on empty servers.
