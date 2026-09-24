# Catalogue and public game values page (sub-project 4 of the balance catalogue roadmap)

Date: 2026-09-24. Status: **written while the owner was away**, from the
direction in `2026-09-24-balance-catalogue-and-triage-design.md` ("The
catalogue"). Decisions the direction did not make are marked **(proposed)**.

## What it is

A public page, **/balance/values**, where a player asks "how much damage does a
hunter pounce do?" and finds the current value, the vanilla L4D1 value and when
it last changed, grouped by entity (Survivors, Common, Tank, Witch, Hunter,
Smoker, Boomer, Special infected, Items, Weapon stats, Bosses, Scoring, Maps),
with short rules under each group ("Hunters cannot be deadstopped
mid-pounce") that appear and disappear with the plugins that make them true.
Model: the Rotoblin-AZMod README's "Gameplay / Balance Changes".

## The catalogue: `balance/catalogue.json`

- `groups`: id and public label, in page order.
- `values`: `id` (a cvar name, or `<weapon>.<key>` for weapon stats), `group`,
  `label`, `source` (`cvar` | `weapon`), optional `unit`, optional `vanilla`,
  optional `note`, optional `hideLive` (the live cvar misreports, e.g.
  `tongue_drag_damage_amount` reads 0 because a plugin applies drag damage
  itself: the page shows the note instead of the number).
- `rules`: `id`, `group`, `text`, `when` (`{ plugin: <file> }` or
  `{ cvar, equals }`), and **`reviewed` (proposed)**: only reviewed rules are
  public. The first 23 rules were drafted from the 2026-09-24 value survey and
  are all `reviewed: false` until the owner reads them.
- **Vanilla values (proposed source):** for game cvars, the engine's registered
  default read on a local L4D1 dedicated server (`ConVar.GetDefault`,
  2026-09-24). Plugin cvars have no vanilla value (the feature does not exist in
  vanilla). Weapon vanilla values from the AZMod README via the survey.
- 108 values (104 cvars, 4 Uzi weapon keys) in this first version.

**Relationship to `knobs.json` (proposed):** the catalogue sits **beside**
`knobs.json` for now. `knobs.json` keeps the knob panel's safe ranges, the
watched files and dirs, and the versionless/ignored lists. The watch file
(sub-project 3) lists the union of both files' cvars plus the catalogue's weapon
keys. Merging `knobs.json` into the catalogue (knob ranges as catalogue fields)
belongs to sub-project 5, the bigger knob panel.

## Where values come from

- **Current value:** the inventory of the patch on the most recent queue-match
  round, as sighted (the same base the knob panel predicts from). A value the
  servers do not report yet shows "not reported yet": the extra cvars and the
  weapon keys only arrive once pug-match 0.3.12 and the watch file are live.
- **Last changed:** walk every balance or folded patch with inputs in time
  order; the last time the value differs from the one before is its last
  change. The page names that patch only if it is **published** (and links to
  its entry on /balance); otherwise it shows the date alone (proposed). A value
  that never changed since tracking began says "unchanged since tracking began".
- **Rules:** a rule is active when its plugin is in the current inventory
  (`p:<file>`) or its cvar has the given value.

## API

- `GET /api/balance/values` (public): groups with values and **reviewed,
  active** rules; published patch names only.
- `GET /api/admin/balance/values` (admin): the same with every rule (draft ones
  tagged) and unpublished patch names, for the owner's review.

## Pages

- `/balance/values` (public), linked from the top of `/balance` ("Game values")
  and back. Each group a panel: a table of label / ours / vanilla / last changed,
  a value differing from vanilla marked, then the group's rules as a list.
- Admin > Balance > **Values**: the same component with the admin data, drafts
  tagged "draft rule".

## Testing

- Catalogue loader: valid file loads; bad group, duplicate id, bad rule
  condition, bad weapon id refuse.
- Watch file includes the catalogue's cvars (deduplicated with knobs) and weapon
  keys.
- Values: current values from the latest queue round's sighted patch; not
  reported; hideLive; last change across three patches with published and
  unpublished names; rules active by plugin and by cvar; drafts hidden publicly.
- Routes: public shape, admin shape. Pages: render tests.

## Open questions for the owner

1. **Rule wording.** Every rule is a draft (`reviewed: false`) and several
   paraphrase terse survey notes (tank rage, bash kills, tank stumble door, sky
   pounce): please read and correct them, then set `reviewed: true`.
2. Which values to show at all: 108 is everything balance-relevant the survey
   found; some (bot, scoring) may be noise for players.
3. Unpublished last changes: date only (proposed) or hidden entirely?
