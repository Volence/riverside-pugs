# Balance catalogue roadmap, and patch triage (sub-project 1)

Date: 2026-09-24. Status: decisions made with the owner in brainstorming; spec
awaiting owner review.

Builds on pieces 1 to 5 (`2026-09-23-balance-analytics-design.md`,
`2026-09-24-balance-control-panel-design.md`,
`2026-09-24-balance-public-page-design.md`), all on branch `balance-integration`.

## Why

After seeing pieces 4 and 5 running locally the owner wants two things:

1. **Less patch noise.** Every config change mints a patch, including SourceTV and
   spectator plugins that have nothing to do with balance. Today the only fix is a
   code change to the `ignored` list in `knobs.json` plus a deploy (that is how
   `l4d_tvwatch` and `l4d2_spec_stays_spec` were handled, and why patch 7 exists).
2. **"What are the numbers?"** A public reference where a player asks "how much
   damage does a hunter pounce do?" and finds the current value, the vanilla value
   and when it last changed. The knob panel should line up with that page and
   cover far more: more knobs, weapon stats, balance plugins on/off, history.
   Model: the Rotoblin-AZMod README ("Weapon Adjustments", "Gameplay / Balance
   Changes"), which lists numbers and rules per entity.

## Decisions (owner, 2026-09-24)

- Values page shows **numbers and rules**. Rules are short lines tied to a
  balance plugin being loaded, so they appear and disappear with patches.
- Each number shows the **vanilla** L4D1 value next to ours where known.
- Values page covers **cvars and weapon stats**.
- The plugin reads its watch list **from a file** the site pushes, not a compiled
  include. After one pug-match rebuild, adding a value is a site-only change.
- The **site owns `l4d_info_editor_weapons.cfg`**: it leaves the deploy repo and the
  site writes the whole file, like `pug_balance.cfg`.
- Balance plugins are toggled by **moving the .smx** between `plugins/` and
  `plugins/disabled/`, effective at the post-match restart.
- Patch triage offers **"fold just this once"** and **"ignore this plugin from now
  on"** as two buttons, with no default.
- **Game server changes go through the site** (release pipeline, below): a
  release is staged from a deploy repo git commit, reviewed as a diff, marked
  balance patch or not, then deployed from the site. Deploys can go to one canary
  box and then to all, or to boxes picked per release. An idle box is restarted
  right away (existing between-matches restarter); a busy box gets the release
  after its match.
- Build order: **(1) triage as a safety net, (2) release pipeline, (3) plugin reads
  its list from a file, (4) catalogue and public values page, (5) bigger knob
  panel.** Each gets its own plan; 2 to 5 get their own spec before planning.
  Sub-projects 3 to 5 ship their server-side files as releases through 2.

## Release pipeline (direction for sub-project 2)

Today changes go from the owner's machine (or an agent) straight to the boxes
(`deploy.sh`, `nfo/ftpsync.py`, the Riverside env), and the site learns about them
only when a new fingerprint appears. Instead the site becomes the one door to the
game servers:

1. **Stage.** A `push-release` script bundles the deploy repo's `overrides/` tree at
   a git commit and uploads it to the site. Staging touches no box. Agents stage
   releases; they no longer deploy to live servers.
2. **Review.** The site diffs the release against what each box has now and
   against the previous release, in plain words (plugin added / updated / removed,
   cvar lines changed in cfg files, data and stripper files changed), and shows
   which boxes differ from each other.
3. **Decide.** Balance patch (name and notes, announced before any box runs it) or
   not balance. The next new fingerprint seen on a box after the deploy belongs to
   that release's decision, so no whole-release fingerprint prediction is needed
   (plugins change cvars at runtime, which the site cannot predict from files).
4. **Deploy.** To a canary box, then the rest with one click, or to boxes picked
   for this release. Per-box state as in the knob panel (pending, written,
   confirmed on the first match), written only between matches, followed by a
   restart when the box is empty.

The knob panel becomes one kind of release (values only), with one history of
everything sent to the servers and rollback to any earlier release. Risks to
design for: the site gains write access to whole game server trees, so it needs a
path allowlist, a backup of every replaced file, a dry-run diff and per-box
failure isolation; Chicago is FTP-only and slow; Dallas is the site's own box.
The web app keeps deploying with `deploy-web.sh`. Triage (sub-project 1) remains
the safety net for changes that bypass the site.

## The catalogue (direction for sub-projects 3 to 5)

One hand-curated file, `balance/catalogue.json`, replaces the cvar part of
`knobs.json` and is the single source for the plugin's watch list, the values page
and the knob panel. The survey (`value-inventory` notes, 2026-09-24) found about
150 gameplay values.

- **Value entry:** id, entity group (Survivors, Common/horde, Tank, Witch, Hunter,
  Smoker, Boomer, SI general, Weapons, Items, Director/bosses, Scoring, Map), public
  label, unit, vanilla value (optional), source (`cvar` for a game or plugin cvar,
  `weapon` for a weapon / key in the weapon file), optional display rule ("set by
  plugin X at runtime", for values the live cvar misreports, such as
  `tongue_drag_damage_amount`, which reads 0 because a plugin applies drag damage
  itself), optional safe range (which makes it a knob).
- **Rule entry:** id, entity group, text, condition (a plugin is loaded, or a cvar
  has a value). Text drafted from the AZMod README and plugin sources; owner
  reviews it.
- **Plugin entry:** file, label, description, balance-relevant flag, toggleable
  flag.
- Values come from what the servers report at go-live (the patch inventory), never
  from config text. History per value = the patches where it changed.
- Findings to act on along the way: `cfg/local_4v4.cfg` (tank HP, pump ammo, witch
  anger) and `server_reset_convars.cfg` are not in the watched files;
  `z_ghost_delay_minspawn` is not set by the PUG chain and can leak in from the
  practice and 1v1 configs.

## Sub-project 1: patch triage

### Goal

Once the release pipeline exists, most patches are decided at deploy time. Triage
covers everything else: changes made outside the site (a manual edit, the NFO
panel, a direct `deploy.sh`) and the backlog on production today. When a new
config version appears unannounced, an admin decides in one click whether it is a
balance patch. Non-balance changes stop cluttering Compare, the Patches tab and
the public page, with no code change or deploy.

### States

Every **detected** patch gets a triage state: `pending` (new, undecided),
`balance` (a real patch) or `folded` (not a balance change; its rounds count as
another patch). Announced patches (from the knob panel) are `balance` from the
start. Existing patches are backfilled: historical, announced and detected
patches with a name are `balance`; merged detected patches (fingerprint NULL) are
`folded` into the patch they were merged into when that can be determined, else
left `balance`; patch 6 on production becomes `pending`.

### The triage card

A pending patch shows a card at the top of the Patches tab:

- What changed against the patch the reporting server was on before, in plain
  words ("plugin added: l4d_tvwatch", "z_tank_health 8000 -> 7500", "file changed:
  global_filters.cfg"), and which servers run it.
- A hint when only plugins differ (no cvar values, no files): "Only plugins
  changed. Probably not a balance change, but plugin updates can be (sky pounce
  0.4.0 was)." It never decides by itself.
- Three buttons:
  1. **Balance patch**: asks for a name (required) and notes; state `balance`.
  2. **Not balance, fold just this once**: pick the target (default: the patch
     the servers were on before; any `balance` patch can be chosen). State
     `folded`, `folded_into` = target.
  3. **Not balance, ignore these plugins from now on**: offered only when every
     difference against the target is a plugin (added, removed or changed). Adds
     those plugins to the site's ignore list and folds the patch.

The existing drift alert gains "(needs triage)" and a link to the Patches tab.

### Folding

- New column `match_rounds.sighted_patch_id`: the patch whose fingerprint a round
  actually reported. Set at sighting beside `patch_id`; backfilled to `patch_id`
  for existing rounds. `patch_id` stays the effective patch everything else reads.
- Folding sets `patch_id` (and `round_metric_context.patch_id`) of every round
  whose `sighted_patch_id` is the folded patch to the target. A new sighting of a
  folded patch's fingerprint tags the round with the target directly
  (`sighted_patch_id` stays the folded patch). Folding into a folded patch follows
  the chain to its end; a fold that would form a loop is refused.
- **Unfold** (a button on a folded patch) restores `patch_id` from
  `sighted_patch_id` and sets the state back to `pending`.
- The compare cache is invalidated by the patch_id change (its data stamp gains
  the triage generation).
- `balance_patch_servers` rows stay on the folded patch; the Patches tab lists a
  folded patch collapsed under its target ("includes 1 folded config: plugin
  added l4d_tvwatch").
- Only `balance` patches appear in the Compare pickers, the public page and the
  knob panel's "restore from". Pending patches appear in Compare pickers with a
  "needs triage" tag, so a change can be looked at before deciding.

### Site-managed ignore list

- New table `balance_ignored_plugins(file PRIMARY KEY, reason, added_by,
  added_at)`. The effective ignore list = `knobs.json` `ignored` plus this table.
  Every place that reads the ignored list (sighting, refingerprint at boot,
  drift, expected-fingerprint prediction in the knob panel, public change list)
  reads the effective list.
- Adding plugins runs the existing refingerprint immediately (not only at boot),
  which merges patches that now hash the same, exactly as a `knobs.json` change
  does today. The patch being triaged is then folded into the target if the merge
  did not already make them one.
- The Patches tab gets a small "Ignored plugins" list with remove. Removing a
  plugin runs the refingerprint too; past folds are not undone (their rounds keep
  their effective patch), and the next sighting that includes the plugin opens a
  new pending patch.

### API (admin only, audited)

- `POST /api/admin/balance/patches/:id/triage` body
  `{ decision: 'balance', name, notes }` | `{ decision: 'fold', into }` |
  `{ decision: 'ignore', into, plugins }`.
- `POST /api/admin/balance/patches/:id/unfold`.
- `GET/DELETE /api/admin/balance/ignored-plugins[/:file]`.
- `PatchSummary` gains `triage`, `foldedInto`, `onlyPluginsChanged`.

### Interactions

- Knob panel (piece 4): the expected-fingerprint prediction uses the effective
  ignore list; an announced patch is `balance`; a rollout's patch cannot be
  folded while the rollout is active.
- Public page (piece 5): only `balance` patches can be published; publishing a
  pending patch is refused ("triage it first"); folding a published patch
  unpublishes it.
- Merged patches from the refingerprint become `folded` into the patch that kept
  the fingerprint, so the existing `merged` flag reads from the triage state.

### Testing

- Backfill of states and `sighted_patch_id` on a copy of production.
- Fold retags rounds and metric context; new sightings of a folded fingerprint
  land on the target; unfold restores; chain resolution; loop refused.
- Ignore adds to the effective list, refingerprints, merges, folds; remove
  reopens on the next sighting; every reader uses the effective list.
- `onlyPluginsChanged` hint; ignore button offered only for plugin-only diffs.
- Compare cache invalidated by fold/unfold; Compare, public and restore pickers
  show only `balance` patches.
- API admin/non-admin; Patches tab render tests for the card, the folded
  collapse and the ignored list.
- Before ship: on a copy of production, triage patch 6 as balance ("Fingerprinted
  config") and check Compare and the public page by eye.
