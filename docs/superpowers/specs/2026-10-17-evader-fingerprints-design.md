# Evader person records and press fingerprints

Date: 2026-10-17. Owner-approved design (brainstorm in session dc6aec01).

## Why

dethisa has now evaded bans on five Steam accounts: telltale (09-23), sleepmark (09-25), ne (10-02),
indianstreetfood (10-06) and nepmir (10-16, hard aimbot in match 722, banned 2026-10-17). The first
four were caught by Discord moves or by a shared home connection (`player_networks`, `src/ipWatch.ts`).
nepmir used neither: a new Discord and only a Datacamp VPN exit that no account had used before. The
same-connection checks had nothing to see.

What did identify nepmir is how long they hold infected buttons. On infected claw, pounce and smoker
presses (which no aimbot drives), their median hold times are 12 / 12 / 14 / 10 ticks. That matches
every dethisa account. The pooled dethisa accounts rank #2 closest of 224 players; shove ranks #204.

What the fingerprint cannot do alone: across the first match of 183 honest players, dethisa's pooled
accounts landed in the top 5 for 6 (3%) and were closer than to nepmir for 2. A fingerprint says "could
be them", not "is them". The design therefore holds an account only on a fingerprint match plus an
independent second sign, and alerts on a fingerprint alone.

## Scope

In: person records grouping a known evader's accounts, a VPN/hosting tag on connections, a per-person
press fingerprint, an end-of-match check of new accounts, alerts and alt holds, admin UI in People >
Alts, the seed data, a history replay that reports what the rules would have done.

Out: the aimbot rules (SMG/pistol headshot binomial, LilAC ldelta >= 60, replay flick-and-return). They
get their own spec. The coupling point is second sign 3 below, which reads aimbot/wallhack flags from
`integrity_flags`. Whichever ships second wires it up. No game plugin change: holds are already
recorded in `input_bursts.holds` by l4d_inputstats on every pool server.

## 1. Data

### Person records (replace per-account evader flags)

```sql
CREATE TABLE evader_people (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  label       TEXT NOT NULL UNIQUE,      -- 'dethisa'
  note        TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  closed_by   TEXT,                       -- closed = no longer watched or matched
  closed_at   TEXT
);
CREATE TABLE evader_members (
  person_id   INTEGER NOT NULL REFERENCES evader_people(id),
  kind        TEXT NOT NULL CHECK (kind IN ('steam','discord')),
  ident       TEXT NOT NULL,              -- SteamID64 or Discord user id
  added_by    TEXT NOT NULL,              -- admin steamid or 'system'
  added_at    TEXT NOT NULL,
  how         TEXT NOT NULL DEFAULT '',   -- 'seed', 'manual', 'ban as same person'
  PRIMARY KEY (kind, ident)               -- an account belongs to at most one person
);
```

`evader_flags` is migrated: every open flag becomes a Steam member of a person record. All four
current flags are dethisa accounts, so the migration creates one person `dethisa` from them. The
migration refuses to guess for any other open flag: each becomes its own person labelled by the
account's name, and staff can merge records later. `isFlagged(db, steamid)` in `src/ipWatch.ts`
becomes "is a Steam member of an open person record". Everything that uses it (watching every
connection an evader uses, the 'watch' alert) keeps working unchanged. The `evader_flags` table is
left in place, read-only, for one release, then dropped.

### Connections and the network tag

There is no new connections table. A person's connections are the `player_networks` rows of their Steam
members.

`player_networks` gains `asn INTEGER` and `as_org TEXT`. They are set on each recorded connect from an
offline IP-to-ASN table: the iptoasn.com ip2asn-v4 TSV, loaded into memory and refreshed weekly by the
web app. The address itself is still never stored; the ASN names a provider, not a person.

A connection counts as VPN/hosting when its ASN is in `src/networkKinds.ts`. That module holds a
curated list (seeded with AS212238 Datacamp, AS62240 Clouvider, AS9009 M247, AS60068 Datacamp/CDN77,
AS20473 Vultr, AS14061 DigitalOcean, AS16509 Amazon, AS24940 Hetzner, AS16276 OVH, and the others
already seen in our logs) plus a name heuristic on `as_org` (hosting, datacenter, cloud, VPN, server).
Staff can add an ASN by hand, which is stored in `settings` as `vpn_asns_extra`.

Backfill: past rows have no address to look up, but the in-game chat logs on every box carry raw IPs
next to SteamIDs. A one-off script hashes each logged IP with the install salt, matches it to
`player_networks` and fills `asn`/`as_org`. Unmatched rows stay NULL ("unknown", never "residential").

### Fingerprint

A fingerprint is a hold-length histogram per press class. Holds of 2 to 20 ticks are used; 1-tick
presses are excluded, because a cheat or a scroll wheel produces those. Base classes: `fire` and
`pounce` on the hunter, smoker and boomer claws (the infected inputs that no aimbot drives). Distance
between two fingerprints is the mean over shared classes of the total-variation distance between
histograms, counting only classes where the candidate has >= 15 holds and the reference has >= 30.
At least 2 shared classes are required.

Since 2026-10-20 the bins are time, 10 ms wide from 20 to 200 ms, so a hand reads the same at any
tick rate: at 100 tick each bin is one tick (2 to 20, exactly as calibrated), and a 128 tick hold is
spread over the bins its 7.8 ms window covers (`addHolds` in src/fingerprint.ts says why).

Survivor classes (jump, crouch, melee shove, reload holds) are added ONLY if the build measures that
they lower the honest false-match rate below the 3% baseline. The measurement goes in the PR.

`src/fingerprint.ts` computes the histograms from `input_bursts` on demand. A person's pooled
fingerprint, and each fingerprinted player's whole-history fingerprint (needed for ranking), are cached
in `fingerprint_cache (subject TEXT PRIMARY KEY, classes_json TEXT, holds INTEGER, built_at TEXT)`.
`subject` is `steam:<id>` or `person:<id>`. A row is rebuilt when its subject has played a match since
`built_at`.

## 2. Matching

### When

The check runs inside the existing end-of-match sweep (`scanEndedMatches`, `src/inputBursts.ts`), once
per ended match, after the auto-bhop signature. It runs only when the `evader_fingerprint` setting is
`alert` or `full` (default `off`).

### Who

Each player in the ended match who is NOT a member of any person record, has no active ban, and is
new: fewer than 15 rated matches OR a site account under 30 days old. Established regulars are
skipped on purpose; at ~3% honest overlap per person they would produce a steady stream of false
alerts. The candidate's fingerprint uses ALL their matches to date, so evidence firms up with each
match.

### A fingerprint match

All three must hold:

1. **Enough data:** at least 150 infected holds in base classes. nepmir had about 220 after one match.
2. **Top 5:** ranked against every fingerprinted player's cached fingerprint plus every open person's
   pooled fingerprint, the person is in the top 5 nearest. The person's own member accounts are
   removed from the field, so the person counts once.
3. **Close enough:** the distance is at most that person's own threshold. The threshold is the 90th
   percentile of the distances between each single member-match (>= 100 holds) and the person pooled
   WITHOUT that match. If a person has fewer than 3 such member-matches, the global fallback 0.25 is
   used. For scale: nepmir to dethisa was 0.203, and honest first matches to dethisa had a p5 of 0.250.

### Second signs

Any one of these, observed on the candidate, lifts an alert to a hold:

1. **VPN/hosting:** any of the candidate's connections is tagged VPN/hosting.
2. **Fresh identity:** the Steam account is under a year old or its profile is private
   (`player_steam_signals`), or the linked Discord account was created under 90 days ago (from the
   snowflake), or the Discord ID has never been linked to another account of ours AND the site
   account is under 7 days old.
3. **Cheat flag:** any `integrity_flags` row for the candidate in a match they played, with kind
   aimbot, aimlock, newcomer_esp, or a high-severity kind added by the aimbot spec.
4. **Two members close:** two or more of the person's member accounts, ranked individually, are in
   the candidate's top 10.
5. **Shared connection:** the candidate shares any `player_networks` hash with any member. This is
   already its own 'watch' alert in `ipWatch.ts`; here it also counts toward the hold.

Sign 2's "private profile" is weak on its own; many honest players are private. It counts only
together with the fingerprint, which is the point of the design.

### What happens

Each outcome fires once per (candidate, person, level). It fires again only when the level goes UP
(alert to hold). Stored in `fingerprint_alerts (steamid, person_id, level, distance, rank, signs_json,
created_at, PRIMARY KEY (steamid, person_id, level))`.

- **Fingerprint only** (setting `alert` or `full`): `publishAdminEvent({ kind: 'fingerprint_match',
  level: 'alert', ... })`. This goes to the mod channel with the person label, rank and distance
  against the threshold, a side-by-side table of hold medians per class, and the candidate's
  connections with VPN tags.
- **Fingerprint plus a sign** (setting `full`): an alt hold through `src/altHolds.ts`. The event is
  `kind: 'fingerprint_match', level: 'hold'`, it pings the mod role, and it lists which signs fired.
  In `alert` mode the same case posts as a loud alert with no hold.
- **Ban as same person:** when a mod bans a candidate from a fingerprint hold or alert using "Ban as
  same person", the account (and its Discord ID, if linked) becomes a member of that person with
  `how = 'ban as same person'`. The person's cached fingerprint is marked stale.

`alt_holds` today requires a `discord_id` and an `other_steamid`. It gains `source TEXT NOT NULL
DEFAULT 'discord' CHECK (source IN ('discord','fingerprint'))` and `person_id INTEGER`. For a
fingerprint hold, `discord_id` is the candidate's Discord ID or '', and `other_steamid` is the
nearest member account. The resolutions (`cleared`, `banned`, `merged`) and the release path stay as
they are. A cleared fingerprint hold suppresses future fingerprint holds for that (account, person)
pair, matching how a cleared Discord hold works today.

### Failure handling

The check runs inside the sweep's own try/catch. A failure logs `fingerprint check failed` with the
match id and never blocks the sweep or another check. A missing ASN table means sign 1 is not counted
(logged once per hour), never "counts as VPN".

## 3. Staff UI (People > Alts)

- The **Flagged ban evaders** list becomes **Known evaders**. One card per person shows the label and
  note; the Steam accounts with name, banned/held state and last seen; the Discord IDs; the
  connections (country, provider, VPN tag, last seen); and the person's hold medians per class next to
  the population medians.
- The player file's Identity section swaps "Flag as ban evader" for **Add to person**: pick an existing
  person or create one. **Remove from person** sits on the card.
- **Fingerprint holds** show in the existing Alt holds list with a "fingerprint" badge, the person, rank,
  distance and fired signs. **Ban as same person** is one of the hold's actions.
- **IP watch list:** stays as it is. A person's member connections are watched automatically, as
  flagged evaders' are now.
- **Staff guide:** `/admin/people/guide` gains a section on reading a fingerprint alert: what the
  numbers mean, why a fingerprint alone is not proof, and what each second sign means.

## 4. Seed data

- **Person `dethisa`:** Steam 76561199238804333 (telltale), 76561198990547138 (sleepmark),
  76561198373680118 (ne/dethisa), 76561198032482558 (indianstreetfood), 76561198129925325 (nepmir),
  and every players row named "dethisa (pre-ban)" (76561198869884852 today; the script selects them by name); Discord 286250932470153217,
  852912263160791060, 617660733718659083.
- **Person `shove`:** Steam 76561198422117946, 76561199794242897 (Bella<3); Discord 173483060682031104,
  1547058677121421372. shove is not evading now. The record exists so that a return is caught.
- The seed runs as a one-off script with an owner go-ahead, after a DB backup.

## 5. Testing

Unit tests (vitest), all with synthetic data:
- Histogram building and the 1-tick and > 20-tick exclusions.
- Distance, including the minimum-shared-classes rule.
- The per-person threshold, including the fallback.
- Each second sign on its own.
- The once-per-level alert logic, including escalation.
- Cleared-hold suppression.
- The `evader_flags` migration.
- `isFlagged` parity: everything that used flags still sees members.

History replay (`scripts/fingerprint-replay.ts`), run on a local COPY of the production DB, never
against the live one. It replays every match end in order and reports what each rule would have done.
Required before it is switched on: it alerts or holds indianstreetfood (as a dethisa candidate, with
indianstreetfood excluded from the seed) and nepmir (likewise). It also reports total honest alerts
and holds per week; target is near zero holds. The numbers go to the owner before anything is turned
on.

## 6. Rollout

1. Ship with `evader_fingerprint = off`. This is a web-only deploy through `deploy-web.sh`.
2. Back up the DB, run the seed and the ASN backfill.
3. Switch to `alert` for one week. Review every alert with the owner.
4. Switch to `full` if the alerts are sane.
