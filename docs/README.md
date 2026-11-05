# pug docs

What is here, and which of it is still current. Updated 2026-11-05.

## Root docs

| File | What it is | State |
|---|---|---|
| [CUSTOM_CAMPAIGNS.md](CUSTOM_CAMPAIGNS.md) | Setting up and checking custom campaign installs (env, per-server transport rows, verify steps, stop points) | Current. Server section rewritten 2026-11-05 for Dallas + Riverside #3 to #6 |
| [season-wrapped.md](season-wrapped.md) | What `src/seasonWrapped.ts` computes at season close, and the data study behind it | Current |
| [season1-launch-runbook.md](season1-launch-runbook.md) | Season 1 launch checklist | Done (Season 1 started 2026-11-03); the template for Season 2 |
| [data-feeds-2026-10-10.md](data-feeds-2026-10-10.md) | The connection funnel, flow and cause, and SI life feeds | Shipped 2026-10-10; still the field reference (code cites it) |
| [ship-abandon-rating.md](ship-abandon-rating.md) | Abandon rating build note and the owner's rulings | Shipped 2026-10-10; kept for the rulings (code cites it) |
| [REPLAY_VIEWER_STATUS.md](REPLAY_VIEWER_STATUS.md) | Replay viewer build record from 2026-09-12 | History; the viewer is live |
| [news/season1-launch-draft.md](news/season1-launch-draft.md) | Draft news post for the Season 1 launch | History |
| [archive/](archive/) | Finished ship notes and idea notes nothing links to any more | History |

## superpowers/: design history

`superpowers/specs/` (designs) and `superpowers/plans/` (build plans) are dated design history.
Source code cites these paths, so they stay where they are. Many "Status:" lines were written
before the build and never updated; where a line was clearly wrong it now says when the work
shipped and which commit (dates are commit dates from git log).

Every plan has been built and merged. Every spec has too, except two drafts that wait for an owner call
(keep or drop):

- `specs/2026-09-24-bigger-knob-panel-draft.md` (sub-project 5, not approved, not built)
- `specs/2026-09-25-site-balance-layer-design.md` (agent draft of the same idea, not approved, not built)

Two partial cases: `specs/2026-09-22-hud-editor-panel-internals-design.md` shipped its plan 1
(honest preview), and whether its plan 2 was built is unverified; the balance control panel's
release stages are on master but have never been used.

The four architecture specs cited from the repo README (2026-07-30 system design, 2026-07-30
sub-project 2, 2026-09-06 dual surface, 2026-09-06 frontend 4a) are still the best overview
of how the pieces fit.

Other folders: `superpowers/notes/` (overnight notes and a ship checklist, done),
`superpowers/research/` (research records; the 2026-09-24 balance value inventory is superseded
by the site's Game values page), `superpowers/verification/` (a 2026-09-24 point-in-time check).
