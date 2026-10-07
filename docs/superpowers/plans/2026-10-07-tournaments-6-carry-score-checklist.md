# pug-match 0.3.27: the owner's in-game checklist (Tournaments T6)

The owner stages pug-match 0.3.27 only after every row passes on a box of their choosing (not by the plan). Every expected string below was read from the plugin source at the branch head (`plugin/pug-match.sp`: `Cmd_Carry`, `SeedL4dscoresTally`, `SeedNewMapSides`, the go-live block in `OnRoundIsLive`) and from l4dscores 8.5.9-riverside3 (`Command_SeedScores`). Chat colour codes are left out. `<...>` is a value that depends on timing or on the box.

## Setup

On the local test box (`/home/volence/l4d1-ds`), by rcon or the server console. `TOKEN1` to `TOKEN4` are any 32 lowercase hex characters, a fresh one per game. `P1` is your own SteamID64 (Team A). Team B can be empty: Rotoblin then counts it as ready.

```
exec rotoblin_cheats_4v4
sv_lan 0
sm_pug_tournament 1
log on
```

`sv_lan 0` gives the client a SteamID64. `sm_pug_match` does not load a map by itself (the site's runner does), so the rows below `changelevel` where a map is needed.

"SourceMod log" is `addons/sourcemod/logs/L<date>.log` (LogMessage lines, both pug-match's and l4dscores'). "Log line the site receives" is the console with `log on`; this plan adds no new `PUG TOKEN` line, so that column is mostly `none`.

The rows run in order unless a row says otherwise.

| # | Who types what | Expected in chat / console | Log line the site receives |
|---|---|---|---|
| 1 | console, no match configured: `sm_pug_carry 9101 500 300` | console: `PUGERR no pending match 9101` | none |
| 2 | console: `sm_pug_match 9101 TOKEN1 hospital`, then `sm_pug_carry 9999 1 1` | console: `PUGOK match=9101`, then `PUGERR no pending match 9999` | none |
| 3 | console: `sm_pug_carry 9101 500 300` | console: `PUGOK carry a=500 b=300`; SourceMod log: `[pug] match 9101 carries game 1's score: a=500 b=300` | none |
| 4 | console: `sm_pug_roster "P1:a"`, `changelevel l4d_hospital01_apartment`; P1 joins survivors and readies up; half 1 goes live | SourceMod log, at go-live: `[l4dscores] seeded: survivors=500 infected=300 mapCounter=1` and `[pug] carried match 9101 live: l4dscores seeded survivors=500 infected=300 (pug team a on survivors, carry a=500 b=300)`. P1: `!scores` shows 500 for survivors and 300 for infected | `PUG TOKEN1 MATCH_START map=l4d_hospital01_apartment`, `PUG TOKEN1 ROUND_START map=l4d_hospital01_apartment half=1 ...` as today |
| 5 | After half 1 is live: an admin restart of the map (console or admin: `sm_restartmap`, l4dready's changelevel to the current map), then P1 readies and half 1 goes live again | the same two seed lines appear again with the same values (`survivors=500 infected=300 mapCounter=1`); `!scores` shows 500 and 300 again | `ROUND_START ... half=1` again, as today |
| 6 | Play half 1 to its end; half 2 goes live on chapter 1 (pug team a is now infected) | NO new `[l4dscores] seeded` line and no new `[pug] carried match 9101 live` line at half 2's go-live. `!scores` shows team a at 500 plus its half-1 round score and team b at 300 | `ROUND_END ... half=1`, `ROUND_START ... half=2` as today |
| 7 | Finish map 1 with team b ahead on the map but behind overall (for example, a scores 200 and b scores 300: totals a=700, b=600); map 2 loads | at map 2 load, pug team a survives first. SourceMod log: `[pug] map l4d_hospital02_subway: seeded sides, pug team a survives first (totals a=700 b=600)` (with your real scores). `logs/errors_*.log` has no `following l4dscores` line. No seed line at map 2's go-live | `MAP_RESULT map=l4d_hospital01_apartment a=<a> b=<b>` as today (map scores only; the carry is not in it) |
| 8 | console: `sm_pug_tournament 0`, then `sm_pug_match 9104 TOKEN4 hospital`, then `sm_pug_carry 9104 500 300`; then `sm_pug_tournament 1` again | console: `PUGOK match=9104`, then `PUGERR not a tournament box`; no `carries` line in the SourceMod log | none |
| 9 | Resume: console `sm_pug_resume 9102 TOKEN2 l4d_hospital01_apartment a 1`, `sm_pug_carry 9102 500 300`, `sm_pug_resume_map l4d_hospital01_apartment 100 150`, `sm_pug_roster "P1:a"`, `sm_pug_resume_commit`, `changelevel l4d_hospital02_subway`; P1 on survivors; half 1 goes live | console: `PUGOK resume=9102`, `PUGOK carry a=500 b=300`, `PUGOK resume_map=1`, `PUGOK resumed maps=1 roster=1`. At map load: `[pug] map l4d_hospital02_subway: resumed match, pug team a survives first`. At go-live: `[l4dscores] seeded: survivors=600 infected=450 mapCounter=2` and `[pug] resumed match 9102 live: l4dscores seeded survivors=600 infected=450 (pug team a on survivors, carry a=500 b=300)` | `MATCH_START`, `ROUND_START` as today |
| 10 | After a carried game: console `sm_pug_match 9103 TOKEN3 hospital`, no `sm_pug_carry`, `sm_pug_roster "P1:a"`, `changelevel l4d_hospital01_apartment`; half 1 goes live | no `[l4dscores] seeded` line and no `[pug] ... live: l4dscores seeded` line at go-live (the carry from game 9101 or 9102 is gone) | `MATCH_START`, `ROUND_START` as today |

**Owner action:** stage pug-match 0.3.27 on all five pool boxes (stage-on-restart) before any event's ruleset turns the Carry score into game 2 switch on. An older plugin answers `sm_pug_carry` with an unknown command, so game 2 would start at 0-0.
