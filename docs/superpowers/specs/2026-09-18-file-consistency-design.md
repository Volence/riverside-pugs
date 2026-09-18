# File consistency for L4D1: killing the content-swap class

Status: **Phase 1 PASSED 2026-09-17**. ForceExactFile enforces on L4D1, confirmed with a real
client. Phase 2 (the file list) is not started. Spec written 2026-09-18.

Related: `docs/superpowers/specs/2026-09-17-integrity-design.md` (the replay analyzer,
which targets a different class of cheating entirely and does not touch this one).

## Why

The admin's own words, 2026-09-17:

> "i think the most pervasive things we need to fix is like players running no trees &
> silenced shotguns & custom skins that brighten colors. im thinking of like good l4d2
> players coming to play and just getting cheesed out by that / theyll just go back to
> l4d2 pugs and not think twice."

That names the **content-swap** class, not the aimbot/wallhack class, as the thing driving
recruitment away. The integrity analyzer already built detects a survivor tracking an
invisible ghost. It does nothing at all about a player who has deleted the trees, brightened
the hunter, or silenced a shotgun.

Those swaps are all the same mechanism: the client loads a modified model, material or sound
in place of the server's. Source has a built-in answer, and L4D1's engine still has it.

## The finding, corrected

An earlier probe concluded this needed binding the exported symbol
`_ZN22CDownloadListGenerator14ForceExactFileEPKc15ConsistencyType`, calling it "half a day,
not an hour". **That symbol is not exported.** It appears in `strings` output on
`bin/engine.so` but not in `nm -D`, so it is not dynamically linkable and binding it would
need a signature scan.

It does not need to be bound at all. Verified 2026-09-18 against
`/home/volence/l4d1-ds/server`:

| Fact | Evidence |
|---|---|
| `ForceExactFile` is a **public virtual on `IVEngineServer`** | `hl2sdk-l4d/public/eiface.h:306`, `virtual void ForceExactFile( const char *s ) = 0;` with the comment "Marks the filename for consistency checking. This should be called after precaching the file." |
| The SDK's vtable matches this engine exactly | SDK `INTERFACEVERSION_VENGINESERVER` is `"VEngineServer022"`; `strings bin/engine.so` yields exactly `VEngineServer022` and nothing else |
| `sv_consistency` is real, not a leftover | help string "Whether the server enforces file consistency for critical files" |
| The client half exists | `CClientState::ConsistencyCheck` plus the client string "Your string table differs from the server's." |
| SourceMod does not already expose it | no hit for `ForceExactFile` anywhere in the vendored SourceMod 1.12 source |
| **Nothing turns it on** | `bin/server.so` contains no reference to `ForceExactFile`. The L4D1 game DLL asks for zero files to be checked |

That last row is the whole story, and it answers the owner's reasonable objection ("I doubt
it works, lots of l4d servers would do it already right?"). The feature is not broken. Out
of the box it enforces an empty list, so `sv_consistency 1` visibly does nothing and people
conclude it is dead. Nobody has written the piece that populates the list, for L4D1.

Because it is a public virtual on a version-matched interface, an extension holds `engine`
already and calls `engine->ForceExactFile(path)` directly. No signature scan, no gamedata
file, no `dlsym`, nothing to re-verify after a game update short of an interface bump.

## Scope

**In:** a SourceMod extension exposing one native; a companion plugin that reads a file list
and applies it on map start; the file list itself; a documented on/off switch.

**Out:** anything that bans, kicks by our own hand, or reports. The engine either disconnects
a mismatched client or it does not. We add no policy on top in this version.

## Phase 1 result: it works

Confirmed 2026-09-17 on the local test server with a real client running a real hunter skin.

**Q1, does the L4D1 client enforce and disconnect? YES.** The client was rejected at connect
with:

> Server is enforcing consistency for this file:
> materials/models/infected/hunter/hunter_01.vmt

Better than expected in one respect: the message **names the offending file**. The prediction
was the generic "Your string table differs from the server's.", which tells a player nothing.
Naming the file means a legitimate player who trips this can see exactly what to remove, which
materially changes how safe this is to enable.

**The mismatch that finally tested it was the `.vmt`, not the `.vtf`.** Three attempts were
needed and the first two proved nothing, which is worth recording because the same trap will
catch anyone extending this:

| forced | client copy | result |
|---|---|---|
| `models/infected/hunter.mdl` | stock | no mismatch, correctly silent |
| `materials/.../hunter_01.vtf` | stock, still in the VPK | no mismatch, correctly silent |
| `materials/.../hunter_01.vmt` | modified | **rejected** |

The skin in question does not replace a texture in place. It ships a loose `hunter_02.vtf` and
has you edit the `$baseTexture` line **inside `pak01_dir.vpk`** to point at it, because the
`.vmt` is stored as plain text in the archive's preload section. So the file that differs is
the material definition, not the texture.

That has a direct consequence for the Phase 2 list: **force the `.vmt` as well as the `.vtf`**.
Forcing only textures misses every skin installed this way, which appears to be the common way.

**`sv_pure` did NOT catch the same client.** The test server logged `Server using sv_pure 2`
with `sv_pure_kick_clients 1` and cached CRCs, and a client with a modified `pak01_dir.vpk`
AND an extra loose file connected untouched. Caveat: that server runs `sv_lan 1`, and
`sv_pure 2` means "force all client files to come from Steam", which plausibly cannot run
without Steam auth. Untested on an authenticating server. Either way the received wisdom that
sv_pure is unreliable on L4D1 held, and ForceExactFile is the mechanism that demonstrably works.

**Q2, does it cover sounds? STILL UNANSWERED.** Silenced weapons are a sound swap and a third
of the stated problem. Test before claiming this solves it.

## The two questions this must answer before it is worth building out

**Q1. Does the L4D1 client actually enforce and disconnect?** `CClientState::ConsistencyCheck`
existing is strong evidence, not proof. Nothing in the server binary can settle it.

**Q2. Does it cover sounds, or only models and materials?** Source's documented behaviour is
models and materials. Silenced weapons are a sound swap, and they are a third of the stated
problem. If sounds are not covered, this feature solves two thirds of it and that should be
said plainly rather than discovered later.

Both are answered by the Phase 1 probe below, which is deliberately the smallest thing that
can answer them.

## Design

### The extension: `l4d_consistency`

One file of consequence. Built against the vendored `hl2sdk-l4d`, Metamod 1.12 and
SourceMod 1.12 already in `sourcetv/deps/`, using the same Docker Ubuntu 22.04 build as
`sourcetv/build.sh` so the `.so` needs at most GLIBC 2.34 (the Dallas box is 2.39). A host
build is not shippable; `sourcetv/README.md` records that an Arch build wanted GLIBC 2.43.

It grabs the engine interface the normal way:

```cpp
GET_V_IFACE_CURRENT(GetEngineFactory, engine, IVEngineServer, INTERFACEVERSION_VENGINESERVER);
```

and exposes exactly one native:

```
native bool ForceExactFile(const char[] path);
```

Nothing more. The extension is a thin bridge to one engine call, so that the decisions
about *which* files and *when* live in a plugin that can be reloaded without a rebuild.

### The plugin: `l4d_consistency.sp`

On `OnMapStart`, after precache has run, it reads
`addons/sourcemod/configs/l4d_consistency.cfg` and calls the native for each path. The cfg
is a plain list, one path per line, `#` for comments, grouped by what it defends against:

```
# Bright / high-visibility SI skins
models/infected/hunter.mdl
materials/models/infected/hunter_*.vmt
...
# No-trees
models/props_foliage/*.mdl
...
```

Wildcards are expanded by the plugin against the game's own file system, not passed to the
engine, so a pattern that matches nothing is a logged warning rather than a silent no-op.

**Timing matters and is the most likely way this fails quietly.** The SDK comment says "after
precaching the file". A path forced before it is precached may be ignored. The plugin logs a
count of what it forced, so "it did nothing" is distinguishable from "it forced 40 files and
the client did not care", which are very different problems.

### The switch

`sv_consistency 0` turns the enforcement off engine-side without unloading anything, and the
plugin has its own `l4d_consistency_enabled` so the file list can be made inert without
touching a server cvar. Two switches on purpose: this feature's failure mode is
**disconnecting legitimate players**, and the recovery path must not require a rebuild, a
restart, or a person who knows C++.

## Phasing

**Phase 1, the probe.** Extension plus native plus a plugin that forces exactly ONE file, a
single SI model. Load it on the local test server, not Dallas. Then, and this part needs the
owner:

1. Join with a stock client. Expect: nothing happens, you play normally.
2. Join with that one model modified. Expect: disconnect, "Your string table differs from
   the server's."
3. Repeat with a modified *sound* file, to answer Q2.

If step 2 does not disconnect, the feature does not work on L4D1 and this spec stops here.
Everything after depends on it, and no amount of extra file paths changes the answer.

**Phase 2, the list.** Only if Phase 1 disconnects. Build the real file list from the three
named problems, tune it against a stock client to drive false positives to zero, then stage
on Dallas during an empty server.

**Phase 3, the mismatch signal.** Optional. A disconnected client is invisible to us right
now; the admin feed could learn about consistency kicks so a wave of them is noticed rather
than mistaken for a server problem.

## Risks

**Disconnecting legitimate players** is the one that matters. A stock install must never trip
this, and the only way to be sure is to test against one before the list grows. Phase 2 does
not ship until a stock client has joined and played a full map with the full list applied.

**A partial answer.** If Q2 says sounds are not covered, silenced weapons survive this
entirely and need a different approach. Say so rather than implying the problem is solved.

**Custom campaigns collide with this.** A forced path that a custom campaign legitimately
overrides would disconnect everyone on that map. The file list must stay to base-game assets,
and this needs re-checking when the custom-maps admin tool lands.

**It is a deterrent, not a wall.** Consistency compares what the client reports. It raises the
cost of a content swap from "drop a VPK in addons" to something much harder, which for this
problem is the whole point, but it is not an anti-cheat.

## What this does not do

It does not detect aimbots, wallhacks, or scripts. That is the integrity analyzer's job and
the two do not overlap. It also does not tell anyone they were kicked for it; the engine
handles the disconnect and the player sees a string-table message that does not name a file.
