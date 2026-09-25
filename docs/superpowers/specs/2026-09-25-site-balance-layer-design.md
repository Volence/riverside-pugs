# The site's balance layer (sub-project 5: the bigger knob panel)

Date: 2026-09-25. Status: **draft written overnight by an agent, not approved,
nothing built.** It turns `2026-09-24-bigger-knob-panel-draft.md` and the owner's
answers there (Q6 to Q9) into a design, and connects it to the config audit of
2026-09-25 (settings spread over 15 cfg files, 61 cvars set more than once, 23 of
them to different values in one PUG match start). Every decision the owner still
has to make is marked **Owner:**.

Builds on: the catalogue (sub-project 4), the watch file (3), releases and the
fleet view (2a, 2b), triage (1) and the knob panel (piece 4), all on branch
`balance-integration`.

## Goal

The site becomes the one place balance values are changed, and git stays the one
record of what the servers run. An admin picks new values or toggles a balance
plugin on the site; the site writes a commit to the deploy repo; that commit is a
release like any other (review, canary, backup, undo); the patch it creates is
announced with its name and notes before any box runs it.

Along the way the hand-written cfg files stop carrying balance numbers: each value
has exactly one owner, the site layer, which runs last.

## What is already decided (owner, 2026-09-24)

- Any catalogue value can be adjustable; each needs a safe range (Q6).
- Every balance plugin that can be toggled, plus its own settings, is a knob (Q7).
- Changes reach the servers through the release pipeline and are pushed to git;
  an apply is a deploy, not a quick tweak (Q8).
- The site takes over `l4d_info_editor_weapons.cfg` once weapon knobs exist (Q9).

## Design

### 1. One source of truth: the catalogue

- A catalogue value gains an optional `knob`:
  `{ "type": "int" | "float" | "bool", "min", "max", "step", "pairMax"? }`.
  No `baseline`: the current value is whatever the site layer holds (see 3), and
  the vanilla value is already in the catalogue.
- A new catalogue `plugins` list: `{ "file", "label", "description",
  "toggleable": bool, "settings": [value ids] }`. The settings are ordinary
  catalogue values (plugin cvars), so they get knobs the same way.
- `knobs.json` keeps only what is not a value: `files`, `dirs`, `versionless`,
  `ignored`. Its `cvars` list becomes a derived view (watch list = every catalogue
  cvar plus the old list), as the watch file already does.
- The loader refuses a knob whose range does not contain the current value, a
  `pairMax` that points at a value without a knob, and a toggleable plugin that
  is versionless or ignored (a toggle must be visible to the fingerprint).

### 2. The site-owned tree in the deploy repo

A new top layer in the deploy repo, written only by the site:

```
site/left4dead/cfg/pug_balance.cfg                              every knob value
site/left4dead/addons/sourcemod/data/l4d_info_editor_weapons.cfg  whole file
site/plugins.json                                                toggle state
```

- Layer order for a box becomes `overrides/`, then `boxes/<slug>/`, then `site/`.
  `site/` wins.
- `site/plugins.json` is `{ "disabled": ["l4d_tank_burn_cap.smx", ...] }`. The
  release stage turns it into paths: a disabled plugin is wanted at
  `plugins/disabled/<file>` and not at `plugins/<file>`, so the existing planner
  moves it (remove plus add, both backed up).
- Staging refuses a human commit that touches `site/` (the commit author must be
  the site's identity), and refuses a site commit that touches anything outside
  `site/`. This replaces the per-path site-owned denylist added on 2026-09-25 for
  `pug_balance.cfg`: the file stops being site-owned-on-the-box and becomes
  site-owned-in-git, shipped by releases like everything else.
- The weapon file leaves `overrides/` in the same commit that first writes it
  under `site/` (Q9), so there is never a moment with two owners.

### 3. Apply = commit + release

1. The admin edits values and toggles on the Knobs tab (grouped like the public
   Game values page, vanilla and current beside each). Preview shows the cfg
   lines, the weapon file diff, plugin moves, and the predicted fingerprint and
   patch (existing prediction, extended to weapon keys and plugin presence).
2. Apply asks for the patch name and notes (as today), then the site:
   - fetches the deploy repo, renders the `site/` files, commits them as
     `Balance: <patch name>` with the site identity and pushes to `master`;
   - stages that commit as a release with the balance decision already set to
     that name and notes;
   - opens the release's review page. **Deploying stays a separate click**
     (canary or all), so a knob apply can never reach a box without the same
     review a human commit gets.
3. The release engine does the rest: write between matches, restart when empty,
   confirm on the first sighting, undo per box.

A push that loses a race with a human commit (non-fast-forward) is retried after
a rebase; since the site only touches `site/` and humans are refused there, a
rebase cannot conflict.

**Owner:** the write credential. Recommended: a second deploy key on
`Volence/l4d-deploy` with write access, stored on Dallas as user `pug`, used only
for pushes from `site/` renders. The alternative, a GitHub bot account with a
fine-grained token, gives a separate author name in history but is one more
account to keep. Both are revocable; neither can touch other repos.

### 4. The direct writer retires

The piece 4 writer (`balanceWriter.ts`, writing `pug_balance.cfg` straight to
idle boxes) has its own hold, abort and verify logic that duplicates the release
engine's. Once the release path is live, the Knobs tab uses only releases and
the writer is removed, so there is one path and one undo for everything sent to
a server. Until then both exist and the writer's 2026-09-25 fixes (hold the box,
count players, abort late writes) keep it safe.

### 5. Plugin toggles and their settings

- A toggle is part of the same release; it takes effect at the box's restart
  after the write (the release engine already restarts written boxes when empty).
- The Knobs tab shows each toggleable plugin with its settings nested under it;
  settings of a disabled plugin are kept in `pug_balance.cfg` but greyed out
  (a disabled plugin's cvars do not exist, and the watch file already reports a
  missing cvar as such, so the fingerprint stays honest).
- Candidates from the survey (**Owner:** confirm the list): `l4d_skypounce`,
  `l4d_saferoom_lock`, `l4d_tank_burn_cap`, `l4d_remove_pipebombs`,
  `l4d_witch_unstuck`, `l4d_tank_stumble_door`, `QuadCaps`, `l4d_antibaiter`,
  `l4d_no_hunter_deadstops`, `l4d_tongue_timer`.

### 6. Consolidating the hand-written configs (the audit's option c)

With `exec pug_balance.cfg` as the last line of the PUG map chain, every balance
value can move from the hand files into the site layer one at a time:

1. Add the value's knob to the catalogue with a range around today's value.
2. In one deploy-repo commit: the site layer gains the line, the hand file loses
   it (`local_4v4.cfg`, `server_custom_convars.cfg`, the triplicated map cfgs).
3. The balance fingerprint must not change at the next go-live: that is the proof
   nothing moved. The cfg lint (`deploy/tools/lint-cfg.py`, branch `cfg-lint`)
   must show one fewer conflict.

What stays hand-written: Rotoblin's own files (never forked), per-box files
(`boxes/<slug>/`), rates, lobby and SourceTV settings, and anything a plugin sets
at runtime (QuadCaps limits, drag damage, `sv_gravity`), which the catalogue marks
as "set by plugin X" and never offers as a knob.

Two leaks the audit found are fixed for free once their values are knobs:
`z_ghost_delay_minspawn` (practice and 1v1 set it, the PUG chain never does) and
the casual/ranked coupling through `local_4v4.cfg` (the site layer is exec'd by
the PUG chain only, so ranked values stop following casual edits).

### 7. Safe ranges

**Owner:** ranges are gameplay calls. Proposal for the first release of this
work: keep the 16 existing knobs and their ranges, add weapon Damage for the
pump shotgun, Uzi and pistol (range: vanilla to today plus or minus 20 percent),
and the tank and witch values already in `knobs.json` without ranges. Every other
catalogue value stays read-only on the Knobs tab until it is given a range, so
the panel grows by owner decision, not by default.

## Safety

- Everything in the release engine applies: no write or restart with players on
  a box, backups before every write, verify, canary, per-box undo, a half-written
  box never returns to the pool.
- Rendering is pure and tested: values are validated against the catalogue range
  and step before rendering; the cfg renderer only emits `name "value"` lines for
  catalogue cvars (names held to `[a-z0-9_]`), and the weapon renderer only keys
  the catalogue lists.
- A render that would change nothing (same bytes) makes no commit.
- The site's git identity can only push; it never force-pushes (a
  non-fast-forward is rebased and retried, at most three times, then reported).

## Build order

1. Catalogue `knob` and `plugins` fields, loader checks; migrate the 16 knobs out
   of `knobs.json` (no behaviour change; same watch list, same fingerprint).
2. `site/` layer in the release stage (read-only first: a human-seeded `site/`
   tree with today's values proves the layering and the fingerprint stays the
   same).
3. Write credential and the apply-as-commit path; Knobs tab switches to it.
4. Weapon file ownership and weapon knobs.
5. Plugin toggles.
6. Retire the direct writer.
7. Consolidation: move hand-file balance lines into the site layer, a few per
   release, each proven by an unchanged fingerprint and a shorter lint report.

Each step gets its own plan. Steps 1 and 2 need no owner decision beyond approving
this design; step 3 needs the credential choice; steps 4 and 5 need the ranges and
the plugin list.

## Owner decisions, in one list

1. Approve this shape (git-first, `site/` layer, apply opens a release that still
   needs a Deploy click).
2. ~~Write credential~~ **Decided 2026-09-25: a second deploy key** with write access on `Volence/l4d-deploy`.
3. Which plugins are toggleable.
4. Ranges for weapon knobs, and which other values get ranges first.
5. Whether the direct writer is removed right after step 3, or kept a while as a
   fallback.
