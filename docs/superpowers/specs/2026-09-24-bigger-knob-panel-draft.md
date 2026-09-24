# The bigger knob panel (sub-project 5): draft for the owner

Date: 2026-09-24. Status: **draft, not approved, not built.** Written while the
owner was away as a starting point for brainstorming. Sub-project 5 decides which
settings admins can change from the site and within what ranges, and gives the
site write access to plugin files and the weapon file on live servers. Those are
gameplay and risk calls for the owner, so nothing here has been implemented.

## What the direction already decided (2026-09-24)

- The knob panel lines up with the public Game values page and covers far more:
  more knobs, weapon stats, balance plugins on/off, history.
- The site owns `addons/sourcemod/data/l4d_info_editor_weapons.cfg`: it leaves
  the deploy repo and the site writes the whole file, like `pug_balance.cfg`.
- Balance plugins are toggled by moving the `.smx` between `plugins/` and
  `plugins/disabled/`, effective at the post-match restart.

## What exists now to build on

- The knob panel (piece 4): about 14 adjustable cvars from `knobs.json`, written
  as `cfg/pug_balance.cfg`, predicted fingerprint, rollout per box.
- The catalogue (sub-project 4): 108 values with groups, labels, vanilla values.
- The watch file (sub-project 3): any catalogue value is reported at go-live
  once pug-match 0.3.12 is live, weapon keys included.
- Releases (2b): per-box write, verify, backup, undo, canary, balance link.

## Proposed shape

1. **One source of truth.** Safe ranges move from `knobs.json` into the
   catalogue as an optional `knob: { type, min, max, step, baseline, pairMax? }`
   on a value. `knobs.json` keeps only files, dirs, versionless and ignored. The
   panel lists every catalogue value that has a `knob`, grouped like the public
   page, with the vanilla value beside each.
2. **Weapon stats as knobs.** A weapon value with a `knob` is written into the
   site-owned `l4d_info_editor_weapons.cfg` (rendered whole, `"all"` section
   only) in the same rollout as `pug_balance.cfg`. The deploy repo drops its
   copy in the same change (a release removes it from its shipped list, so the
   release engine never deletes the site's file).
3. **Plugin toggles.** A catalogue `plugins` list (file, label, description,
   toggleable). A toggle is part of the rollout: move to `plugins/disabled/`
   (or back) between matches, then the restart loads the new set. The
   fingerprint prediction treats a disabled plugin as absent.
4. **One history.** Knob rollouts and releases in one list on the Deploy page
   (the direction's "one history of everything sent to the servers"), each
   with its undo.

## Questions for the owner (needed before a spec)

1. Which values become knobs, and what are their safe ranges? (The current 14
   are a starting point; the catalogue has 108 values.)
2. Which plugins may be toggled from the site? (Candidates from the survey:
   skypounce, saferoom_lock, tank_burn_cap, remove_pipebombs, witch_unstuck,
   tank_stumble_door, QuadCaps, antibaiter, no_hunter_deadstops, tongue_timer.)
3. Should knob changes go through the release engine (backup, verify, undo,
   canary) instead of the balance writer, now that 2b exists? Recommended: yes,
   as "site-generated sources" in a release, so everything sent to a server has
   one path and one undo.
4. Weapon file: take ownership now (deploy repo drops it) or keep it in the repo
   until weapon knobs exist?
