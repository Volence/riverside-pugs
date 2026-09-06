# Dual-Surface PUG: Website + Discord Bot Design

**Date:** 2026-09-06
**Status:** Approved direction (topology + decomposition), pre-implementation
**Supersedes:** the "Discord: webhook notifications only. No bot." row in
`2026-07-30-l4d1-pug-system-design.md`

## What this is

Sub-project 4 of the PUG system: turning the one-way Discord webhook into a real
bot, and turning the placeholder frontend into a site people want to sit on
between matches. The two are one design because the decision that shapes both is
**dual-surface**. A player can queue, ready up, and vote from either the website
or Discord, and both views stay live and identical.

This document records the decisions and the decomposition. Each sub-project below
gets its own design doc, implementation plan, and build.

## Prior art considered

- **[InHouseQueue](https://docs.inhousequeue.xyz/docs)**: Discord-first in-house
  queue bot (seasons, captain draft, MMR decay, map ban/vote, suspensions, role
  promotions, admin logs, and a secondary "Website Queue"). The feature list is
  the closest thing to a spec for what a friend group actually uses; the shape
  (Discord primary, web secondary) is the inverse of what we built.
- **[l4dpug.com](https://www.l4dpug.com)**: EU-focused L4D pug site. Same
  problem domain, web-first.

We are neither: we are both surfaces at parity.

## Decisions made during brainstorming

| Topic | Decision |
|---|---|
| Surface parity | **True dual-surface.** Queue, ready-up, and campaign vote all work identically from the website and from Discord, synced live. Not "web-first with a megaphone", not "Discord-first with a web scoreboard". |
| Identity | Steam remains the canonical account (it has to, since rosters are SteamID64). Discord is *linked* to it, by either flow: "Connect Discord" (OAuth) on the profile page, or `/link` in Discord issuing a short code to paste on the site. |
| Gate | **Discord guild membership (optionally a role) replaces the invite code.** `settings.invite_code` stays in the schema as a fallback for people not in the server, but membership is the normal path to `active`. |
| Process topology | **Bot runs in-process** with Fastify. One Node process, one SQLite writer, one `Matchmaker`. See below. |
| Frontend stack | **Vite + Preact**, built to static output that Fastify serves exactly as it serves `public/` today. Replaces no-build vanilla JS + hand-rolled hash routing. |
| Feature set | Live-updating lobby embed, captains draft, suspensions/no-show penalties, and admin tooling. All four wanted, all four sequenced separately. |
| Lobby durability | **Out of scope, deliberately.** Lobby state stays in memory. See "Rejected" below. |

## Why the bot runs in-process

`Matchmaker` holds the live `Lobby` object (phase, ready-set, votes, and
`setTimeout` deadlines) entirely **in memory**. Nothing about an in-flight lobby
is in SQLite. `Hub.broadcast(event)` sends only an event *name*; clients re-fetch
state over HTTP.

That single fact decides the topology. A separate bot process cannot see lobby
state without either IPC or persisting the lobby, so "separate service" is not a
free choice. It is a prerequisite refactor wearing a topology costume.

In-process instead means both surfaces call the same `Matchmaker` methods.
Dual-surface parity stops being an invariant somebody has to maintain by hand and
becomes true by construction: there is only one state machine, and a Discord
button press and a website click enter it through the same door.

### The seam

`Matchmaker` already takes injected `broadcast` and `notify` hooks, and
`buildServer` already wires them. The bot hangs off a generalized version of
that seam rather than a new one:

```
Matchmaker / Lobby / orchestrator
        │  emits typed events (queue_changed, lobby_phase, match_live, ...)
        ▼
   PugEvents (small typed emitter)
        ├──────────────► Hub.broadcast()        → browsers re-fetch (unchanged)
        └──────────────► DiscordPresenter       → debounced message edit
```

`DiscordPresenter` owns exactly one concern: keeping the Discord lobby message a
faithful rendering of current state. It never mutates state. Interactions travel
the other way, through a thin `commands/` layer that validates the Discord user,
resolves them to a linked SteamID64, and calls the same `Matchmaker` method the
HTTP route calls.

The discord.js client is behind a config flag (`DISCORD_BOT_TOKEN` unset = no
bot), so tests, CI, and `npm run dev` need no token and no network.

### Costs accepted

- One process does more; a bot crash restarts the web app. At friend-group scale,
  with systemd restart already in place, this is cheaper than API drift.
- discord.js is a heavy dependency relative to the rest of the tree.

## Rejected

**Separate bot process over a service API.** Needs a new service-auth surface,
requires WS payloads to start carrying real state, makes every button press an
HTTP round-trip, and gives two components independent views of a state machine
that must agree. Real cost, theoretical benefit at eight players.

**Persisting lobby state to SQLite first.** Genuinely fixes a real bug (a backend
restart mid-ready-check drops the lobby) and would unlock either topology. But it
is the largest refactor of the best-tested code in the repo, in service of
durability nobody has complained about. It stays separable: if restarts start
hurting, it can be done later as its own change without touching the bot.

## Decomposition and build order

| | Sub-project | Delivers |
|---|---|---|
| **4a** | Frontend migration + redesign | Vite + Preact, existing pages ported, real visual design |
| **4b** | Identity: Discord linking + gate | `players.discord_id`, OAuth link, membership gate (see its own design; the `/link` code flow moved to 4c, since it needs a running bot) |
| **4c** | Bot core + live lobby embed | discord.js in-process, slash commands, self-editing lobby message, so dual-surface goes live |
| **4d** | Captains draft | New lobby phase, both surfaces |
| **4e** | Suspensions / no-show penalties | Ready-fail and leaver tracking, escalating queue bans |
| **4f** | Admin tooling + settings UI | Web admin page + admin slash commands, replacing `sqlite3`-by-hand |

**4a is first despite the bot being the interesting part.** 4b's link UI, 4d's
draft board, and 4f's admin page are all new pages; building them on the vanilla
stack means porting them a week later. Migrating first means every later UI is
written once, in the stack it will live in.

The order after 4a follows dependencies: 4c needs 4b's identity resolution, 4d
needs 4c's interaction plumbing, 4e needs 4c's ready-fail signal, and 4f is a
cleanup pass that benefits from everything above it.

## Open questions (resolve at each sub-project's own design stage)

1. Whether the Discord lobby embed is one persistent message per queue or a fresh
   message per pop. (Leaning fresh-per-pop with a persistent queue-status message.)
2. Whether captains draft is a per-match choice, an admin setting, or triggered by
   a vote. (4d.)
3. Whether suspensions block the Discord surface, the website, or both, and how
   escalation resets. (4e.)
4. Voice-channel moves on match start. InHouseQueue does this; unclear whether
   the group wants it. Not in the accepted feature set; revisit after 4c.
