# l4d_skypounce

`../l4d_skypounce.sp` stops hunters chaining pounces along the map's sky ceiling
("ceiling pouncing"). Live on all four servers since 2026-09-21.

## The rule

`l4d_skypounce_mode` picks one of two.

**1, the default: Zen's rule.** Copied from the `AntiCeilingPounce` module inside Zen's
`_zenserver.smx` (read out of the compiled plugin). When a human hunter begins a pounce
while its view pitch is strictly between 10 and 14 degrees, looking slightly down, the
flat angle a ceiling run is done at, it cannot attack again in the air for half a
second. Landing, dying or the half second ends it. No surface is looked at. The owner
chose it because it is the rule the community already plays under on Zen.
Tunables: `l4d_skypounce_pitch_min`, `_pitch_max`, `_cooldown`, `_bots`.

**2: the surface rule,** built and tested here first. The plugin tracks the last surface
an airborne hunter touched, by short player-hull sweeps. A pounce that begins in the
air while that surface is the sky CEILING (a sky face whose normal points down; vertical
sky faces are the invisible walls at the map's edge and count as walls) is a pounce off
the sky. `l4d_skypounce_allow` of those per flight (default 1), then attack is dropped
for as long as sky is still the last thing touched. `l4d_skypounce_touch` is the sweep
distance.

Either way: `l4d_skypounce_enable 0` turns it off, `l4d_skypounce_debug 1` tells the
affected player in chat, and every block that removed at least one press writes a line
to `addons/sourcemod/logs/skypounce.log` (name, SteamID, map, position, presses).

What was measured on the way, and is easy to get wrong:

- Dropping the press only while sky is in reach is not enough: the game still allowed a
  pounce 134 units below the ceiling, after the contact.
- Waiting for the ability's `m_isLunging` to fall is useless: the re-pounce fires while
  it is still 1.
- `SURF_NODRAW` must not be treated as sky. On Blood Harvest 1 the rig's control wall
  turned out to be a `TOOLS/TOOLSPLAYERCLIP` face, and bouncing off it is ordinary play.
- A live `sm plugins reload` keeps an existing cvar's value AND bounds. Rename a cvar
  when its meaning changes.

## Staging

    ./stage.sh <dallas|riverside-a|riverside-b|chicago> [--status|--force|--remove]

No restart. Refuses when anyone is connected. Secrets come from the deploy repo, which
is not part of this one.

## Testing without anyone who can ceiling pounce

`rig/skyrig.sp` drives an AI hunter: it overrides the bot's buttons every tick, makes it
pounce, moves it mid-lunge to just under a sky face (or next to a plain wall, the
control), spams attack and counts the pounces that begin in the air. It contains no
blocking logic; it only flips the plugin's cvars between cells.

    rig/run.sh <map> <bare|roto> <allow> <mode> <pitch>

`roto` loads the whole Rotoblin-AZMod plugin set beside it. It runs on an isolated
hardlink copy of the local test server (`/home/volence/l4d1-ds-skyprobe`, port 27045).

An empty L4D1 server freezes game time until somebody joins, so the rig adds a fake
client. AI survivor bots are kicked whenever no human is connected, so nothing on the
survivor side can be bot tested.

The rig cannot show Zen's rule breaking a chain: a bot holding 12 degrees down only gets
one ceiling pounce even with the plugin off. That took a player who can really do it.

## Playtest helpers (never for a live server)

`playtest/start.sh` runs a local versus instance where a lone human is always a hunter
(`alwayshunter.sp`, because L4D1 ignores `z_gas_limit` / `z_exploding_limit` for
players). `firemeter.sp` reports real shots per second and has `sm_autofire`, which
presses attack for you; it is how Rotoblin's `l4d_pistol_delay_dualies 0.1` was shown
to cap dual pistols at about 9 shots a second on L4D1.
