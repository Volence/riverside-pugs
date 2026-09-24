I didn't create `value-inventory.md`. My session is read-only and can't create files, even in the scratchpad, so the full inventory is below. You can save it as-is.

**Where the values come from.** The live set is the 2026-09-21 `state/dallas` snapshot plus the newer `overrides/` layer. Their cfg files match, apart from the `sm_pug_live_push` line and the SourceTV lines. Note that `rotoblin_pug_4v4_map.cfg` runs `exec Reloadables.cfg`, and that file is what runs `Reloadables/server_custom_convars.cfg`. The file order is: reset → `rotoblin_pug_4v4.cfg` → `rotoblin_pug_4v4_map.cfg` → `server_shared_convars.cfg` → `server_custom_convars.cfg` → `local_4v4.cfg` (all under `/home/volence/l4d/deploy/state/dallas/left4dead/cfg/`). Plugin sources are in `/home/volence/l4d/Rotoblin-AZMod/SourceCode/scripting-az/`, `/home/volence/l4d/deploy/plugins-src/`, `/home/volence/l4d/pug/plugin/` and `/home/volence/l4d/witchfix/`.

## 1. Cvars: final value after the whole chain (K = already in knobs.json)
**Survivors:** `survivor_limit` 4 · `pain_pills_decay_rate` 0.25 (vanilla 0.27) · `ammo_buckshot_max` **128** (local_4v4 overrides shared's 96) · `ammo_smg_max` 800 · `l4d2_reload_speed_uzi` 1.9 · `l4d_smg_reload_clip_time` 1.43 (plugin default 1.65) · rifle / hunting rifle / pistol / dual-pistol clip times 1.2 / 2.6 / 1.5 / 2.1 · `rotoblin_melee_penalty` 2 · `z_gun_survivor_friend_push` 0 · `anti_friendly_fire_enable` 0 · `simple_antibhop_enable` 1, `bhop_except_si_flags` 4, `bhop_allow_survivor` 0 · `no_bot_use_pills` 1 · 31 `sb_*` bot cvars (`sb_stop` 0, `sb_all_bot_team` 1, plus 29 bot-AI tweaks).
- The K knobs `survivor_max_incapacitated_count`, `survivor_revive_duration` and `survivor_ledge_grab_health` are only reset to vanilla. Nothing in the chain sets them.

**Common/horde:** `l4d_ready_common_limit` 30 and `l4d_ready_mega_mob_size` 50 (see runtime values in section 5) · `z_mob_spawn_min/max_size` 28/28 K · `z_mob_spawn_min/max_interval_normal` 30/30 K · `l4d_antibaiter_delay` 15 K, `horde_timer` 30 K (set in both shared and custom; plugin default 60), `progress` 0.03 · `z_brawl_chance` 0 · `z_must_wander` 1 · `car_alarm_distance` 99999.

**Tank:**
- `z_tank_health` **8000** K. local_4v4 overrides the map cfg's 7000.
- `versus_tank_bonus_health` 1 K. The cfg comment claims this means ×1.5; that is unverified.
- `z_tank_speed_vs` 210 K · `z_tank_burning_lifetime` 125 · `z_frustration_spawn_delay` 25 · `z_frustration_los_delay` 1.2 · `tank_ground_pound_duration` 0.1 · `director_tank_lottery_selection_time` 3
- AI tank: `tank_throw_allow_range` 150, `tank_throw_min_interval` 8, `tank_stuck_time_suicide` 99999999999
- `tank_control_disable` **1**. Custom overrides shared's 0, so tank pick is vanilla random.
- `l4d_tank_burn_cap` 0 K · `rotoblin_enable_2v2` 0 · `z_tank_footstep_shake_duration` 0
- `z_tank_damage_slow_min/max_range` K are reset only (vanilla).

**Witch:** `z_witch_anger_rate` **0.25** (local_4v4 overrides 0.35) · `z_witch_personal_space` 500 · `z_witch_flashlight_range` 800 · `z_witch_damage_per_kill_hit` 30 K.
- `z_witch_speed` K is reset only. `z_witch_health` K is never set.
- `l4d_witch_unstuck_mode` 2 (cfg in overrides). This file and the witch corner fix are **untracked in git**, so whether they are live is unverified.

**Hunter:** `z_pounce_damage` 2 K · `z_pounce_damage_interval` 0.2 · `hunter_pz_claw_dmg` 6 · `versus_shove_hunter_fov` 70 · `versus_shove_hunter_fov_pouncing` 0 K · `z_pounce_damage_interrupt` 150 K · `z_pounce_stumble_radius` 160 K · `z_hunter_lunge_stagger_time` 0 · `z_pounce_silence_range` 999999 · `z_pounce_door_damage` 500 · `pounceuncap_maxdamage` 35 · `stop_wallkicking_enable` 0 (wallkicks allowed) · AI `hunter_pounce_ready_range` 1000 / `hunter_committed_attack_range` 600.
- `l4d_skypounce_enable` / `_mode` K are never set in any cfg, so they run at the plugin defaults 1/1. The plugin was added through overrides after the snapshot.

**Smoker:** `tongue_hit_delay` 13 K · `tongue_drag_damage_amount` 1 K · `tongue_choke_damage_amount` 1 K · `tongue_drag_first_damage_interval` 1.0 · `tongue_drag_first_damage` 3.0 · `tongue_drag_damage_interval` 0.33 · `tongue_choke_damage_interval` 0.2 · `tongue_break_from_damage_amount` 300 K · `tongue_release_fatigue_penalty` 0 · `tongue_vertical_choke_height` 99999.9 · AI `smoker_tongue_delay` 0.1 · `z_versus_smoker_limit` 1.

**Boomer:** `z_vomit_interval` 20 K · `z_exploding_shove_min/max` 3/3 · `z_vomit_range` 150 · AI `boomer_exposed_time_tolerance` 0.2 / `boomer_vomit_delay` 0.1 · `z_versus_boomer_limit` 1.

**SI general:** `z_max_player_zombies` 4 · `z_ghost_delay_min/max` 10/10 · `z_respawn_interval` 20 · `z_max_stagger_duration` 0.9 · `z_door_pound_damage` 300 · `rotoblin_finalspawn_range` 1.
- `z_ghost_delay_minspawn` K is **never set by the PUG chain and not in the reset cfg**. The practice and 1v1 map cfgs set it to 1, so that value can carry over into a PUG.

**Items/weapon limits:** `rotoblin_health_style` **3** K (local_4v4 overrides the 4 set in `rotoblin_pug_4v4.cfg`) · `rotoblin_weapon_style` 1 K · `rotoblin_enable_throwables` 0 · `rotoblin_enable_cannisters` 0.
- Limits: hunting rifle **0** (custom overrides 1) K, auto shotgun 0 K, rifle 0 K, SMG 3 K, pump -1 K.
- `director_convert_pills` / `director_vs_convert_pills` 0 · `director_pain_pill_density` 6 K · `director_scavenge_item_override` 1 · propane/gas/oxygen/molotov/pipe density 1 each · `director_pistol_density` 3 · `l4d_remove_pipebombs` 0.

**Director/bosses:** `versus_tank_chance` and `versus_witch_chance` 1 K (intro/finale variants 1, not in knobs) · boss flow min/max: intro .20/.90, regular .10/.90 K, finale .20/.80 · tank/witch team flow variation 0 · `versus_boss_spawning` 1 · `no_final_first_tank` 1 · `no_escape_tank` 1 · `director_min_start_players` 1 · `director_no_survivor_bots` 0.

**Scoring:** `vs_score_pp_health` 0.65 · `vs_score_pp_healthbuffer` 0.25 · plugin defaults: 15 per pill, 25 per kit · per-map `VersusModifier` in `data/mapinfo.txt`.

**Map:** `stripper_cfg_path` = `addons/stripper/Roto-AZMod` (139 cfgs) · `l4d_saferoom_lock` K is never set in a cfg, so it runs at the plugin defaults (lock 1, tank 1, witch 1).

**Non-gameplay cvars skipped:** about 75 (roughly 44 in the chain files, plus about 31 rate cvars from `server_rates.cfg` / `local_rates.cfg`).

## 2. Weapon data file
Path: `/home/volence/l4d/deploy/overrides/left4dead/addons/sourcemod/data/l4d_info_editor_weapons.cfg`, identical to the one in state.
- **Format:** Valve KeyValues with `//` comments: `"weapon_info" { "all" { "<weapon classname>" { "<key>" "<value>" } } }`. Sections named after maps (partial name match) override `"all"`.
- **Entries (all `weapon_smg`):**

| Key | Our value | Vanilla (per README) |
|---|---|---|
| SpreadPerShot | 0.22 | 0.32 |
| MaxMovementSpread | 2.0 | 3.0 |
| RangeModifier | 0.78 | 0.84 |

- Upstream's `"Damage" "24"` (vanilla 20) was deliberately removed on 2026-08-25.
- `l4d_info_editor_mission.cfg` is empty. The suffix cvars are "".

## 3. Plugins
230 plugins autoload from the root plugins dir, plus the overrides. The chain loads `l4d2_skill_detect`, `optional/l4d_tankhud`, `l4d_versus_nerf_huntingrifle` and `l4d_huntingrifle_damagemodify`. It unloads `l4d2_spec_stays_spec` and 19 `optional/*` plugins.

**Balance-relevant plugins (values are source defaults unless a cfg sets them):**
- **rotoblin-az:** limits, health/weapon style, melee fatigue, and it keeps `director_no_mobs` at 1.
- **l4dready:** sets `z_common_limit` and `z_mega_mob_size` at go-live.
- **l4d_QuadCaps:** `sm_3ht1s_percent_chance` 90. It sets the boomer and smoker limits to 0 after a boomer dies.
- **pounce_maxdamage:** 35.
- **l4d_godframes_and_hittable_control:** hunter godframes 1.5, smoker 0, common extra time 0.6, friendly-fire extra time 0.8, a list of hittable damage values, SMG/pistol FF protection interval 0.3.
- **l4d_no_hunter_deadstops:** `hunter_ground_m2_godframes` 0.25.
- **l4d_tongue_timer:** cooldown 8 after tank clears, 4 after survivor clears.
- **l4d_smoker_drag_damage_interval**
- **l4d_weapon_csgo_reload** and **l4d2_smg_reload_tweak**
- **l4d_versus_nerf_huntingrifle:** fire rate 0.20, switch time 1.8, empty reload 1.25.
- **l4d_huntingrifle_damagemodify:** 120 to tank, ×2.8 hunter chest, ×1.5 hunter stomach.
- **l4d_slowdown_control:** water 170 / 220 during tank, no gunfire slowdown on SI, per-weapon slowdown values.
- **l4d_antibaiter**
- **l4d2_tankrage:** 7% flow, 4 s freeze.
- **l4d_static_punch_getup:** 0.5.
- **l4d_rock_lagcomp:** rock godframes 1.7, hitbox 30, per-weapon damage values.
- **l4d2_tank_spawn_antirock_protect:** 1.5.
- **l4d_versus_despawn_health:** 0.5.
- **l4d_bash_kills:** hunter 1, smoker 1, boomer 0.
- **l4d2_si_ffblock**
- **l4d_nobhaps**
- **l4d2_pistol_delay:** dual pistols 0.1, single 0.175.
- **l4d_tank_rock_ignition**
- **l4d_tank_hittable_refill**
- **l4d_NoEscapeTank** and **l4d_NoRescueFirstTank**
- **l4d_collision_adjustments**
- **l4d_stagger_gravity:** its autoexec cfg sets **0**.
- **TickrateFixes:** forces **`sv_gravity` 750** (vanilla 800) and `tick_door_speed` 1.3.
- **Ours:** skypounce, saferoom_lock, tank_burn_cap, remove_pipebombs, witch_unstuck, witch_corner_fix, tank_stumble_door, lagcomp_skeet. `l4d_lagcomp_skeet` has no source anywhere in the repos.

**Infrastructure:** lilac, l4d_lilac_report, smd_hackers_block, l4d_consistency, lerptracker, ratemonitor, pug-match, l4d_cvarwatch, l4d_inputstats, l4d_tickstats, l4d_tvwatch, skill_detect (stats), all HUD/announce/glow/sound plugins, votes3, l4d_mix, admin plugins, comp_loader / server_loader.

## 4. AZMod README vs our values
**Matches:** Uzi ammo 800, reload 1.9, quick reload 1.43, limit 3 · pump limit none · boss flows · pounce 2 @ 0.2, max 35, shove FOV 70 · smoker 13 / 8 / 4 · boomer interval 20, horde 28, 3 shoves, 90% quad caps · tank speed 210, burn 125 · witch personal space 500, flashlight 800 · anti-bait 30/15 · 10 s spawn timer · pill decay 4 s · water slowdown 170/220 · shove fatigue 2.

**Differs:**
- Uzi damage: README 24, ours stock 20.
- Pump ammo: README 96, ours 128.
- Hunting rifle limit: README 1, ours 0.
- Tank HP: README 7000, ours 8000.
- Witch anger rate: README 0.35, ours 0.25.
- Health: README scatters pills, ours uses style 3 (saferoom and finale only).
- Tank rotation: README forces each player to tank, ours is random.
- Hunter godframes: README 1.8 s, plugin default 1.5.
- M2 godframes: README 0.75 s, default 0.25.
- Common extra time: README 1.8 for smoker, default 0.6.
- Stagger gravity: README lists it, but it is disabled.
- Pump pellet spread (3.0/5.0) and static spread: I found no config or plugin for these in the repo.

## 5. Parsing concerns
- **The weapon file parses cleanly** into (weapon, key, value) rows with a VDF parser. It must ignore `//` comments and apply map sections over `"all"`.
- **Live cvars differ from the cfg text:**
  - `tongue_drag_damage_amount` reads **0** live, because the plugin zeroes it and applies the damage itself.
  - The boomer/smoker limits flip to 0 mid-round because of QuadCaps.
  - `z_common_limit` and `z_mega_mob_size` are only set when the round goes live.
  - `z_hunter_max_pounce_bonus_damage` is derived to 34 and `z_pounce_damage_range_max` to 980 + `z_pounce_damage_range_min`, both by `pounce_maxdamage`.
  - `sv_gravity` is 750.
  - `director_no_mobs` is 1.
- **Files not in knobs.json `files`** that still change balance: `local_4v4.cfg`, `server_reset_convars.cfg`, `cfg/sourcemod/*.cfg`, `data/mapinfo.txt`.
- **Leak and snapshot gaps:** the `z_ghost_delay_minspawn` leak above. `server_custom_convars.cfg` runs `sm plugins load_unlock` and never locks again. Several plugins from overrides (skypounce, saferoom_lock, cvarwatch, the witch fixes) are missing from the 09-21 snapshot.