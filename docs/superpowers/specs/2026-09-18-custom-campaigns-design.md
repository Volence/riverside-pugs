# Custom campaigns: upload, pool, stats, and a page that tells people how to install them

Status: **design approved 2026-09-18, not started.** Spec written 2026-09-18.

Related:
- `docs/superpowers/specs/2026-08-13-passifice-l4d1-design.md` — the precedent that decides
  how chapter selection works here. Read it before touching mission files.
- `docs/superpowers/specs/2026-09-18-file-consistency-design.md` — explicitly **out of scope**,
  see Open questions.

## Why

Today the site can only ever run the four stock L4D1 campaigns. They are hardcoded twice, in
`src/campaigns.ts:1` and again in `firstMapOf()` at `src/orchestrator.ts:302`. A custom
campaign cannot be voted for, cannot be started, and would not have its stats attributed:
`campaignForMap()` deliberately returns `null` for anything it does not recognise rather than
guessing.

The ask is that an admin can upload a custom campaign VPK and from that point it behaves like
any other campaign — pool, vote, match, stats, replays — plus a public page telling players
how to install it and where to get it.

## What is already true

Worth knowing before designing anything, because it removes work:

| Fact | Where |
|---|---|
| The front end already expects custom campaigns. `campaignTint()` hashes an unknown slug to a stable colour at the same visual weight as the stock four | `web/src/format.ts` |
| A map with no overview art already renders in the replay viewer, by fitting the world bounds from the replay itself | `autoFitTransform()`, `src/mapTransform.ts` |
| The Campaigns page already groups unrecognised campaigns rather than dropping them | `web/src/routes/Maps.tsx` |
| The plugin has **no** hardcoded four-map limit. It ends when the engine reports the finale loaded | `plugin/pug-match.sp:2574`, `L4D_IsMissionFinalMap(true)` |
| The web app already has group write access to the game directory, set up so demo pruning would work | `ops/README.md:44` |
| An S3/R2 client already exists | `src/r2.ts` |

## The Passifice finding, and why it decides chapter selection

The first design for per-chapter include/exclude had the plugin force a `changelevel` between
chapters, writing Rotoblin's `nextMap` in `l4dscores.sp`. That machinery exists — it even
handles the campaign score swap and team placement across a forced jump — but **nothing in the
tree has ever written `nextMap`**. It is complete, dead, and unproven code sitting in the
middle of live match flow.

None of that is necessary. `deploy/overrides/left4dead_dlc4/missions/ThePassing.txt` already
stitches chapters from two different campaigns into one arbitrary five-chapter versus list, and
its header records the reason it works:

> Score carries across all five chapters natively: the engine treats a mission's chapter list
> as one campaign and accumulates m_iCampaignScore across chapter changes. No plugin is
> involved.

So chapter selection, and chapter **ordering**, is a mission-file authoring problem. The engine
plays the list it is given, in the order it is given, and scores it as one campaign. No plugin
change, nothing near live match flow.

Passifice also supplies the warning, and it is in capitals in the original for a reason:

> An addon VPK ... was tried first and MEASURABLY DID NOT WORK on 2026-08-14: with
> passifice.vpk in `left4dead/addons/`, versus still went c6m2_bedlam -> c6m3_port, i.e. the
> stock 3-chapter mission won. Do not retry the VPK route without new evidence.

That failure was an addon trying to override a **built-in** mission, which a custom campaign is
not, so it does not directly apply here. What it establishes is that search-path precedence in
this engine is not intuitive and must be measured, never assumed. Hence the spike below.

## Architecture

Nine pieces. Each is independently testable and only the spike is uncertain.

### 1. Data model

`src/db.ts` has no migration framework by design — `CREATE TABLE IF NOT EXISTS` plus the
`addColumn` helper, idempotent and cheap. Follow that, do not introduce one.

```sql
CREATE TABLE IF NOT EXISTS custom_campaigns (
  slug          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  vpk_filename  TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  state         TEXT NOT NULL,        -- 'draft' | 'published'
  enabled       INTEGER NOT NULL DEFAULT 0,
  uploaded_by   TEXT,
  uploaded_at   INTEGER NOT NULL,
  notes         TEXT
);

CREATE TABLE IF NOT EXISTS custom_campaign_chapters (
  slug       TEXT NOT NULL,
  ordinal    INTEGER NOT NULL,        -- position in the ORIGINAL mission file, 1-based
  map        TEXT NOT NULL,
  display    TEXT,
  is_finale  INTEGER NOT NULL DEFAULT 0,
  included   INTEGER NOT NULL DEFAULT 1,
  play_order INTEGER,                 -- position in the GENERATED mission; NULL when excluded
  PRIMARY KEY (slug, ordinal)
);

CREATE TABLE IF NOT EXISTS custom_campaign_installs (
  slug       TEXT NOT NULL,
  server_id  INTEGER NOT NULL,
  state      TEXT NOT NULL,           -- 'pending' | 'installed' | 'failed'
  sha256     TEXT,                    -- what is actually on that server
  error      TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (slug, server_id)
);
```

`ordinal` and `play_order` are separate columns on purpose. The admin can reorder and exclude,
so position in the generated mission is not position in the uploaded file; keying on `ordinal`
keeps every chapter the VPK declared, including excluded ones, so the confirm screen can always
show what the file actually said. `included = 0` and `play_order IS NULL` always agree —
`play_order` carries the order, `included` carries the intent, and the write path sets both.

`state` and `enabled` are also distinct: `state` is how far through the upload wizard a campaign
got, `enabled` is whether an admin wants it in the vote pool. A published campaign can sit
disabled indefinitely.

New columns on `servers`, via `addColumn`: `addons_transport` (`local` | `ftp`), `addons_dir`,
`ftp_host`, `ftp_port`, `ftp_user`, `ftp_password`. Credentials in that table have precedent —
`rcon_password` is already there.

### 2. Campaign registry

One registry replacing two hardcoded tables.

- `CAMPAIGNS` in `src/campaigns.ts` stays exactly as it is: a pure const, no DB dependency. It
  is what `tests/config.test.ts:40` asserts on and what the Discord bot reads at module scope.
- New `campaignRegistry(db)` returns stock entries merged with published custom ones, each as
  `{ slug, name, firstMap, maps, custom }`.
- `campaignForMap(map, db?)` keeps its pure prefix logic for stock maps and falls back to a
  chapter lookup for custom ones. **Cached**, because it is called per round in the log parser;
  invalidated whenever a campaign is published, edited, or deleted.
- `firstMapOf()` in `src/orchestrator.ts` consults the registry. For a custom campaign it is the
  first *included* chapter, not the first chapter in the file.

### 3. VPK parsing — `src/vpk.ts`

Read the VPK directory tree, locate `missions/*.txt`, parse its KeyValues for `DisplayTitle` and
the ordered `modes.versus` chapter list, each with `Map` and `DisplayName`.

This is the least certain component. Mission files vary in the wild and finale marking is not
always explicit — the working rule is that the last versus chapter is the finale, which the
admin can correct on the confirm screen. Treat the parser as a spike before building on it, and
write it against real campaign VPKs rather than only a synthetic fixture.

### 4. Mission generation

From the included chapters in admin-chosen order, generate a mission file listing exactly those
chapters and nothing else. Two rules:

- **Included means played**, including the last one. No terminal padding chapter. What ends the
  match is the plugin, not the engine's idea of a finale — see below.
- Per-chapter versus tuning (`VersusModifier`, `versus_boss_spawning`, `VersusConvertPills`) is
  copied verbatim from the source chapter. Passifice's header records what happens otherwise:
  copying the wrong source silently undid a deliberate competitive setting.

Delivery of the generated file is the open spike — see below.

### 4b. Match end moves to the last included map

Owner decision, 2026-09-18: **the last enabled map in the list is the last map.**

Today the plugin ends when the engine reports the finale map has *loaded*
(`plugin/pug-match.sp:2574`, `L4D_IsMissionFinalMap(true)`). That definition cannot express "play
this campaign's finale", and it makes the end condition a property of the mission file rather
than of the match.

The new rule: the backend tells the plugin which map is the last one, and the plugin ends the
match when that map *completes*.

This is a smaller change than it sounds, because the plugin already has this exact path. `!endpug`
is documented at `plugin/pug-match.sp:1730` as "finish the match here, without loading the
finale", and it already mirrors the finale branch including the pending-finalize failsafe. The
change is to fire that same `EndMatchNow()` automatically once the designated last map is
finalized, rather than only on command.

Two things it improves for stock campaigns as well, and neither should be treated as a
regression to guard against:

- The finale map no longer loads at all. Today chapter 5 loads and is immediately thrown away.
- The end is triggered by a map completing, which is a moment the plugin already fully owns
  (`FinalizeMap`, `g_bPendingFinalize`), rather than by a subsequent level load.

Delivery: extend `sm_pug_match` with the ordered included map list, so the plugin knows both
which map is last and that it is in a backend-driven match. Keep the finale-load trigger as a
failsafe for self-started and auto-tracked matches, which have no backend-supplied list.

### 5. Upload and install

`POST /api/admin/campaigns`, multipart. New dependency: `@fastify/multipart`.

1. Check free disk **before** accepting. Refuse below a floor. See Constraints.
2. Stream to a temp file on the same filesystem as the addons directory, so the final move is
   atomic.
3. Hash, parse, write a `draft` row plus its chapters, return the parse for confirmation.
4. Admin corrects name, picks and orders chapters, publishes.
5. Install to every enabled server: local copy where `addons_transport` is `local`, FTP where it
   is `ftp`. Record per-server state and the sha256 actually landed.

Install is a background job with retry, never blocking the request, and never able to fail a
match — the same rule `src/r2.ts` already follows for demo upload.

### 6. Pool

`settingsSchema.ts:96` validates `map_pool` against the hardcoded const today. It moves to the
registry.

A custom campaign may enter the pool only when it is `published`, `enabled`, and `installed` on
every enabled server. The orchestrator **re-checks at match start** against the claimed server
rather than trusting the flag; a vote landing on a map the server does not have is a dead match,
and the flag can be stale by exactly the window that matters.

### 7. Stats parity

Mostly falls out of `campaignForMap()` resolving custom maps: `match_maps` attributes correctly,
the Campaigns page groups them under a real name instead of "Other", `campaignTint()` colours
them, and the replay viewer falls back to `autoFitTransform()` where there is no overview art.

Check `mapName()` in `web/src/format.ts` handles an unknown map without mangling it.

Overview art for custom maps is not in scope; the fallback is by design and already works.

### 8. Public page

`/custom-campaigns`, nav label **"Custom"**, alongside the existing "Campaigns" entry. The paths
stay distinct because the jobs are distinct: `/maps` is stats about maps played, this is "how do
I get this thing working". `NAV_LINKS` in `web/src/components/Nav.tsx` is the one place to edit;
note its comment about `target` on links that are real files rather than routes.

Per campaign: name, chapter list, file size, sha256, download button, install instructions (drop
the `.vpk` in `left4dead/addons/`).

- `GET /api/campaigns/custom` — public, published and enabled only.
- `GET /download/campaign/:slug` — resolves the path from the DB row, verifies the file still
  matches its recorded size and hash, then streams it.

Never by a filename from the URL, and never by listing that directory: it also holds metamod,
stripper, l4dtoolz and `l4d1_mission_nav.vpk`. A drifted file reports the campaign as missing in
the admin panel rather than serving a surprise.

### 9. Testing

- `vpk.ts` against real campaign VPKs, not only a synthetic fixture.
- Mission generation: chapter order, no padding chapter, verbatim tuning copy.
- Match end on the last included map, including the case where it *is* the campaign's finale,
  and the failsafe still firing for a self-started match with no backend-supplied list.
- Registry merge; `campaignForMap()` on custom maps; cache invalidation on edit.
- `map_pool` validation accepting custom slugs and rejecting uninstalled ones.
- Upload: disk-space refusal, hash mismatch, traversal refusal.
- Download: 404 when the file has drifted from its recorded hash.
- Install state machine against a fake FTP transport — precedent in `tests/fakes/fakeTransport.ts`.

## Constraints, measured 2026-09-18

**Disk was measured at 33G used of 47G, 12G free**, with `/home/l4d` alone at 20G. Most of that
is demos, and demos are moving to R2 (owner, 2026-09-18), which reclaims the bulk of it. So disk
is no longer expected to bind.

It is still the resource this feature consumes, and R2 cannot relieve it: the server must have
the VPK in `addons/` to run the map at all, so offloading the download copy saves nothing. VPKs
are 50-500 MB each and permanent.

So the guards stay, sized as prudence rather than as a crisis: the uploader checks headroom and
refuses below a floor, the panel shows current free space rather than letting an admin discover
it at 100%, and disabling a campaign is distinct from deleting it — deleting reclaims the VPK
from every server. Re-measure once the demo offload has actually run before setting the floor.

**Bandwidth is not a constraint.** 95.1 GB used is 3% of the allowance, so roughly 3 TB/month
with ~3 TB of headroom. A full rollout (8 players × 300 MB) is 2.4 GB, 0.08% of a cycle. Daily
outbound runs 4-7 GB with a 9.3 GB peak.

**Downloads during a live match should not hurt.** The NIC runs `fq`
(`net.core.default_qdisc = fq`), which schedules per-flow and favours sparse flows over
backlogged ones — a game's steady small-packet UDP stream over a bulk TCP download — and caps
any single flow at `flow_limit 100p`, so one download cannot build the deep queue that causes
jitter. vCPU sits at 10% idle and peaks near 35% during a match on 2 vCPUs, so there is CPU
headroom too. This is measurable rather than assumed: `l4d_tickstats` writes per-frame CSVs with
a known baseline p99 of 11.25 ms. Pull a large file during a live match and compare.

Serving from `addons/` rather than a second copy means the file players install is byte-for-byte
the file the server runs. Hence no R2 in this design at all.

## Spike, before implementation

**Where must the generated mission file live to win?** Measure on `/home/volence/l4d1-ds`, never
on Dallas. Candidates, in order of preference:

1. Loose in `left4dead/missions/`.
2. Rewritten inside the uploaded VPK — no collision to lose, but the distributed file then
   differs from the community's copy, and whether a client/server mission mismatch matters in
   dedicated-server versus needs checking in the same spike.
3. A companion VPK. Least preferred: closest to the arrangement Passifice measured as failing.

The spike answers which, and settles the client-mismatch question. It cannot break anything
live, and no plugin work depends on the result.

## Open questions

- ~~Playing the finale as a scored map.~~ **Resolved 2026-09-18** by the owner: the last enabled
  map is the last map, and the plugin ends when it completes. See 4b.
- **File consistency is out of scope,** deferred by the owner on 2026-09-18. `consistency/`
  force-exacts files to block content swaps, and a custom VPK adds hundreds of files installed
  by hand. That interaction is its own design problem and would hold up a feature that is useful
  without it.
- **Overview art for custom maps** is not in scope. `autoFitTransform()` is the fallback and
  already works.

## Decisions, and why

| Decision | Reason |
|---|---|
| Automatic install to both servers | Owner, 2026-09-18. The two servers are identical besides ping, so no per-server pool gating is needed, only install status and a warning if they drift |
| Parse the VPK, admin confirms | Authoritative source with a human check. Mission files vary and a hand-typed BSP name is a silent failure |
| Chapter selection via generated mission file | Passifice proved the engine scores an arbitrary chapter list as one campaign with no plugin. The alternative revived dead code inside live match flow |
| Last enabled map ends the match | Owner, 2026-09-18. Lets a finale be played, moves the end condition off the mission file, and reuses the proven `!endpug` path rather than the finale-load trigger |
| Serve downloads from `addons/` | One copy, so the installed file and the downloaded file cannot drift. Bandwidth measured as a non-issue and `fq` handles the latency case |
| No R2 | The server needs the VPK locally regardless, so it saves neither disk nor correctness |
| `/custom-campaigns`, nav "Custom" | `/maps` is stats about maps played; this is installation. Merging muddles both and breaks bookmarks |
