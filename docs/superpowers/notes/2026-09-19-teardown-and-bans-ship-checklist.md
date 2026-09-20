# Teardown and server bans: what to check before it goes live

Spec: `docs/superpowers/specs/2026-09-19-cancel-teardown-and-server-bans-design.md`.
Plan: `docs/superpowers/plans/2026-09-19-cancel-teardown-and-server-bans.md`.

Nothing below touches Dallas without the owner's explicit go-ahead and an empty server.

## Read-only checks on Dallas (ask first, then one RCON session)

1. `sm plugins list` must show `Base Bans`. If it does not, half 2 does not work
   and has to move into the pug plugin; stop and re-plan.
2. `sv_banid_enabled` must be 1.
3. `sm_cvar sv_pausable` for the record.

## Local, with a real client

4. `plugin/TESTING.md`, section "Teardown", steps 3 to 6. Record whether
   changelevel ran while paused in the spec's spike table.

## Deploy order (audit-hardening precedent)

5. Web first: `deploy-web.sh`. The sweep starts pushing bans on boot. Watch the
   log for `[serverBans]` errors; expect none if basebans is loaded.
6. Then the plugin, on an EMPTY server: `plugin/stage.sh`.
7. Re-assert `sm_pug_auto_track` and `sm_pug_roster_at_live` afterwards, as the
   hardening notes require after any plugin stage.

## First real cancel afterwards

8. Check the admin feed: an abandon should show the ban, and no PROBLEM line.
9. `status` on the box within a minute: 0 humans, `map : <reset_map>`.
10. Check `banned_user.cfg` on the box contains the STEAM_1 id of the leaver.
