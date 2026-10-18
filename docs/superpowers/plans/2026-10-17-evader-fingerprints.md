# Evader Person Records and Press Fingerprints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group a known ban evader's accounts into one person record, fingerprint each person by how long they hold infected buttons, and at every match end check new accounts against those fingerprints: alert on a fingerprint match, alt-hold on a fingerprint match plus an independent second sign.

**Architecture:** Pure math in `src/fingerprint.ts` (histograms, total-variation distance, per-person threshold, ranking). DB reads and the `fingerprint_cache` in `src/fingerprintData.ts`. Person records in `src/evaderPeople.ts` replace `evader_flags` behind the unchanged `isFlagged` in `src/ipWatch.ts`. Second signs in `src/fingerprintSigns.ts`, the end-of-match decision in `src/fingerprintCheck.ts`, called through a new hook on `scanEndedMatches`. Connections gain an ASN tag from an in-memory iptoasn.com table (`src/asnTable.ts`, `src/networkKinds.ts`). Holds reuse `src/altHolds.ts` with a new `source = 'fingerprint'`. Staff UI lives in People > Alts. Three scripts (history replay, seed, ASN backfill) are written and tested here but never run against production.

**Tech Stack:** TypeScript (NodeNext ESM), better-sqlite3, Fastify, vitest (server project on node, web project on happy-dom), Preact. No new npm dependency.

**Spec:** `docs/superpowers/specs/2026-10-17-evader-fingerprints-design.md` (companion: `docs/superpowers/specs/2026-10-17-aimbot-rules-design.md`, whose flag kinds `hs_share`, `flick_return`, `aimbot_multi` feed second sign 3).

## Global Constraints

- Never use em dashes anywhere: code, comments, docs, commit messages, UI text. Use a colon, a comma or two sentences.
- No new npm dependency. The ASN download uses the built-in `fetch` and `node:zlib`; nothing else is installed.
- The IP address itself is never stored: not in `player_networks`, not in a log line, not in script output. Only the existing salted HMAC (`hashIp`) and the ASN/provider name.
- `evader_fingerprint` setting: values `off` | `alert` | `full`, default `off`. It ships `off`.
- Fingerprint constants are exactly: holds 2..20 ticks (1-tick and > 20-tick holds excluded); base classes `fire` and `pounce` on `weapon_hunter_claw`, `weapon_smoker_claw`, `weapon_boomer_claw`; distance = mean over shared classes of total-variation distance (sum |a-b| / 2 of the normalised histograms); a shared class needs candidate >= 15 and reference >= 30 holds; >= 2 shared classes; enough data = >= 150 base holds; top 5; threshold = 90th percentile of leave-one-out distances of member-matches with >= 100 holds, fallback 0.25 when fewer than 3; new = fewer than 15 rated matches OR site account under 30 days.
- Second signs exactly as the spec: VPN/hosting connection; Steam account under 1 year or private, Discord account under 90 days (snowflake), or Discord never linked to another account AND site account under 7 days; cheat flag (`integrity_flags` kind aimbot, aimlock, newcomer_esp, hs_share, flick_return, aimbot_multi); two member accounts in the candidate's top 10; shared `player_networks` hash with a member.
- A missing ASN table means sign 1 is not counted (logged once per hour), never "counts as VPN". An unmatched or unknown ASN is "unknown", never "residential".
- Failures in the check log `fingerprint check failed` with the match id and never block the sweep.
- Scripts: `scripts/fingerprint-replay.ts` runs only on a COPY (it copies with SQLite's backup API from a read-only handle). The seed and ASN backfill scripts default to a dry run and need `--commit`. None of them is run against production by this plan.
- Deploy is web-only (`deploy-web.sh`), not part of this plan. Do not touch production, rcon or any box.
- This checkout is shared: other sessions have uncommitted edits (`ops/README.md`, `ops/pug-db-backup.sh`) and another agent works on the aimbot plan. Commit ONLY the files a task names, with `git add <files> && git commit -m "..." -- <files>`. Never `git commit -a`, never `git add -A` or `git add .`.
- A query over completed matches uses `completedPug()` from `src/matchKinds.ts`; `tests/matchKindGuard.test.ts` fails on any raw `state = 'completed'` / `state IN (... 'completed' ...)` outside its allowlist.
- Match surrounding style: long explanatory doc comments on why, `now = new Date()` injectable clocks, `db.transaction(() => { ... })()`, ISO strings from `toISOString()`.

## Review Focus

1. The first check after the setting turns on builds `fingerprint_cache` for every player with infected holds, synchronously inside the one-minute sweep. A large `input_bursts` table could hold the event loop. Expected: one slow first run, then only players who played since are rebuilt. Pinned by the "second call rebuilds nothing" test in Task 7; the replay (Task 18) prints its run time on a DB copy as the real-size measurement.
2. A person with no Steam members, or members with no infected holds (a Discord-only record such as a fresh manual entry), must be skipped cleanly: no crash, no alert, no hold with an empty `other_steamid`. Pinned in Task 11.
3. A hold that cannot be placed (the account is staff, or has no players row) must still tell the mods (`loud`), and an account staff already released from a fingerprint hold must post nothing more and never be re-held, even after it plays again. Pinned in Task 11. (An account already on a Discord hold never reaches the check: a hold is a bans row, so it is skipped as banned.)
4. A failed or truncated ASN download must never replace a working table file, and the app must keep the table it already has. Pinned in Task 2.
5. Time formats are mixed in this schema: `matches.ended_at` and `players.created_at` are `YYYY-MM-DD HH:MM:SS`, while `bans.created_at`, `integrity_flags.at`, `player_networks.first_seen` and `input_bursts.at` are ISO. A comparison across formats silently gives wrong answers. Pinned by the rated-match and site-age tests in Task 9, which use real column formats.

---

## File Structure

Create:
- `src/fingerprint.ts`: pure. Constants, `Fingerprint` type, histogram building, distance, medians, percentile, per-person threshold, `matchPersons` ranking, `SecondSign` type and `SIGN_TEXT` (pure so the web can import it).
- `src/asnTable.ts`: parse ip2asn-v4 TSV, binary-search lookup, the process-wide current table, load from disk, weekly refresh.
- `src/networkKinds.ts`: curated VPN/hosting ASN list, `as_org` name heuristic, staff extras from `vpn_asns_extra`.
- `src/evaderSeed.ts`: seed person constants (dethisa, shove), replay's required accounts, `seedPeople`.
- `src/evaderPeople.ts`: schema for `evader_people`, `evader_members`, `fingerprint_cache`, `fingerprint_alerts`; the `evader_flags` migration; membership functions.
- `src/fingerprintData.ts`: fingerprints from `input_bursts`, member-match fingerprints, the cache, `fingerprintWorld`.
- `src/fingerprintSigns.ts`: candidate selection ("who"), time-aware ban and age checks, the five second signs.
- `src/fingerprintCheck.ts`: mode, levels, once-per-level storage, hold placement, admin event, `runFingerprintCheck`.
- `src/evaderBan.ts`: "Ban as same person".
- `src/admin/knownEvaders.ts`: the Known evaders view model.
- `src/asnBackfill.ts`: chat-log join-line parser and the ASN backfill core.
- `src/fingerprintReplay.ts`: the history replay core.
- `scripts/fingerprint-replay.ts`, `scripts/seed-evader-people.ts`, `scripts/backfill-network-asn.ts`.
- `web/src/routes/admin/KnownEvaders.tsx`.
- Tests: `tests/fingerprintFixtures.ts`, `tests/fingerprint.test.ts`, `tests/asnTable.test.ts`, `tests/fixtures/ip2asn-v4-sample.tsv`, `tests/networkKinds.test.ts`, `tests/evaderPeople.test.ts`, `tests/evaderRoutes.test.ts`, `tests/fingerprintData.test.ts`, `tests/fingerprintHolds.test.ts`, `tests/fingerprintSigns.test.ts`, `tests/fingerprintCheck.test.ts`, `tests/evaderBan.test.ts`, `tests/evaderSeed.test.ts`, `tests/asnBackfill.test.ts`, `tests/fingerprintReplay.test.ts`, `web/src/routes/admin/KnownEvaders.test.tsx`.

Modify:
- `src/db.ts`: `player_networks.asn`/`as_org`, `alt_holds.source`/`person_id`, two DEFAULT_SETTINGS, call `ensureEvaderSchema`.
- `src/settingsSchema.ts`: `evader_fingerprint`, `vpn_asns_extra`.
- `src/playerNetworks.ts`: `recordPlayerNet` stores the ASN.
- `src/index.ts`: start the ASN refresh.
- `src/ipWatch.ts`: `isFlagged` reads person records; flag functions replaced by `watchAccount`/`unwatchAccount`.
- `src/altHolds.ts`: fingerprint holds, source-aware cleared suppression, richer rows.
- `src/inputBursts.ts`: `scanEndedMatches` gains an `afterMatch` hook.
- `src/server.ts`: pass the hook.
- `src/adminFeed.ts`, `src/discord/feedRouting.ts`, `src/discord/adminFeedPoster.ts`: the `fingerprint_match` event.
- `src/routes/people.ts`, `src/admin/playerFile.ts`: person routes and file data.
- `web/src/api.ts`, `web/src/routes/admin/PeopleAlts.tsx`, `web/src/routes/admin/file/IdentitySection.tsx`, `web/src/routes/admin/StaffGuide.tsx`.
- Tests: `tests/ipWatch.test.ts`, `tests/playerNetworks.test.ts`, `tests/db.test.ts`, `tests/feedRouting.test.ts`, `tests/discordAdminFeed.test.ts`, `tests/adminSettings.test.ts` (only if it enumerates keys), `web/src/routes/admin/PeopleAlts.test.tsx`, `web/src/routes/admin/StaffGuide.test.tsx`.

Before Task 1, record the starting commit (`git rev-parse HEAD`) as START and run `npm test` once to note which tests already fail; Task 19 checks against both. Run commands from `/home/volence/l4d/pug`. A single test file: `npx vitest run tests/<file>.test.ts`. Typecheck: `npm run typecheck`.

---

### Task 1: Fingerprint math

**Files:**
- Create: `src/fingerprint.ts`
- Create: `tests/fingerprintFixtures.ts`
- Test: `tests/fingerprint.test.ts`

**Interfaces:**
- Consumes: `decodeIntervals(s, maxLength)`, `MAX_HOLDS` from `src/inputStats.ts` (base-48 alphabet, `'0'` = 1 tick).
- Produces (all exported from `src/fingerprint.ts`):
  - constants `HOLD_MIN = 2`, `HOLD_MAX = 20`, `BINS = 19`, `BASE_KINDS`, `BASE_WEAPONS`, `BASE_WEAPON_NAMES`, `MIN_CANDIDATE_CLASS = 15`, `MIN_REFERENCE_CLASS = 30`, `MIN_SHARED_CLASSES = 2`, `MIN_CANDIDATE_HOLDS = 150`, `MIN_MEMBER_MATCH_HOLDS = 100`, `FALLBACK_THRESHOLD = 0.25`, `THRESHOLD_PERCENTILE = 0.9`, `MIN_THRESHOLD_SAMPLES = 3`, `TOP_RANK = 5`, `MEMBERS_WINDOW = 10`
  - `type Fingerprint = Record<string, number[]>` (class key `"<kind>:<weapon>"` to 19 bin counts, bin i = hold of i + 2 ticks)
  - `interface BurstHoldRow { kind: string; weapon: string; holds: string | null }`
  - `classOf(kind: string, weapon: string): string | null`, `classLabel(cls: string): string`
  - `addHolds(fp, cls, holds: readonly number[]): void`, `addBurst(fp, row: BurstHoldRow): void`, `fingerprintOf(rows: Iterable<BurstHoldRow>): Fingerprint`
  - `mergeInto(target, src): Fingerprint`, `pooled(fps: Iterable<Fingerprint>): Fingerprint`, `without(total, part): Fingerprint`
  - `countOf(counts?: readonly number[]): number`, `holdTotal(fp): number`
  - `tvDistance(a, b): number`, `distance(candidate, reference): number | null`
  - `medianHold(counts?: readonly number[]): number | null`, `percentile(values: readonly number[], p: number): number`
  - `personThreshold(memberMatches: readonly Fingerprint[]): number`
  - `interface FieldEntry { subject: string; fp: Fingerprint }` (`subject` is `steam:<id>` or `person:<id>`)
  - `interface PersonModel { id: number; label: string; members: readonly string[]; pooled: Fingerprint; threshold: number }`
  - `interface PersonHit { personId: number; distance: number; threshold: number; rank: number; nearestMember: string | null; membersInTop10: number; matched: boolean }`
  - `matchPersons(candidate, candidateId, field, persons): PersonHit[]`
  - `type SecondSign = 'vpn' | 'fresh_identity' | 'cheat_flag' | 'two_members' | 'shared_connection'`, `SIGN_ORDER: readonly SecondSign[]`, `SIGN_TEXT: Record<SecondSign, string>`
- Produces (test helpers, `tests/fingerprintFixtures.ts`): `HUNTER`, `POUNCE`, `SMOKER` class keys; `spread(peak, n): number[]`; `fpOf(classes): Fingerprint`; `player(db, steamid, name?)`; `endedMatch(db, id, endedAt?)`; `playMatch(db, steamid, matchId, peak, n, at?)`.

- [ ] **Step 1: Write the shared test fixtures**

Create `tests/fingerprintFixtures.ts`:

```ts
import type { DB } from '../src/db.js';
import { encodeIntervals } from '../src/inputStats.js';
import { addHolds, type Fingerprint } from '../src/fingerprint.js';
import { upsertPlayer } from '../src/players.js';

/** Synthetic hold data for the fingerprint tests. Nothing here is a real
 *  player's numbers: the real ones live only in the production database. */

export const HUNTER = 'fire:weapon_hunter_claw';
export const POUNCE = 'pounce:weapon_hunter_claw';
export const SMOKER = 'fire:weapon_smoker_claw';

/** n holds spread over peak-1, peak, peak, peak+1: a hand that "holds about
 *  `peak` ticks". Two spreads more than 2 apart share no bin at all. */
export function spread(peak: number, n: number): number[] {
  const pattern = [peak - 1, peak, peak, peak + 1];
  return Array.from({ length: n }, (_, i) => pattern[i % 4]);
}

export function fpOf(classes: Record<string, number[]>): Fingerprint {
  const out: Fingerprint = {};
  for (const [cls, holds] of Object.entries(classes)) addHolds(out, cls, holds);
  return out;
}

export function player(db: DB, steamid: string, name = `p${steamid.slice(-3)}`): void {
  upsertPlayer(db, { steamid, name, avatar: null }, []);
}

/** A completed match. ended_at is in the column's own format (SQLite
 *  datetime, a space and no zone), as the app writes it. */
export function endedMatch(db: DB, id: number, endedAt = '2026-10-17 20:00:00'): void {
  db.prepare("INSERT INTO matches (id, season_id, state, campaign, ended_at) VALUES (?, 1, 'completed', 'death_toll', ?)")
    .run(id, endedAt);
}

/** One hunter claw burst and one hunter pounce burst in `matchId`, n holds
 *  each around `peak`, so 2n base-class holds in all. */
export function playMatch(
  db: DB, steamid: string, matchId: number | null, peak: number, n: number, at = '2026-10-17T19:00:00.000Z',
): void {
  const ins = db.prepare(
    `INSERT INTO input_bursts (match_id, server_id, steamid, kind, weapon, n, ground_ticks, air_presses,
       server_tick, client_tick, intervals, at, wire, holds)
     VALUES (?, 1, ?, ?, 'weapon_hunter_claw', ?, 0, 0, 1, 1, ?, ?, 2, ?)`,
  );
  for (const kind of ['fire', 'pounce']) {
    ins.run(matchId, steamid, kind, n - 1, encodeIntervals(Array(n - 1).fill(8)), at, encodeIntervals(spread(peak, n)));
  }
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/fingerprint.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  BINS, FALLBACK_THRESHOLD, addBurst, classLabel, classOf, distance, fingerprintOf, holdTotal, matchPersons,
  medianHold, percentile, personThreshold, pooled, tvDistance, without, type FieldEntry, type PersonModel,
} from '../src/fingerprint.js';
import { encodeIntervals } from '../src/inputStats.js';
import { HUNTER, POUNCE, SMOKER, fpOf, spread } from './fingerprintFixtures.js';

describe('press classes', () => {
  it('keys fire and pounce on the three infected claws, either weapon spelling', () => {
    expect(classOf('fire', 'weapon_hunter_claw')).toBe(HUNTER);
    expect(classOf('pounce', 'hunter_claw')).toBe(POUNCE);
    expect(classOf('fire', 'weapon_boomer_claw')).toBe('fire:weapon_boomer_claw');
    expect(classOf('bhop', '')).toBeNull();
    expect(classOf('fire', 'weapon_smg')).toBeNull();
    expect(classLabel(HUNTER)).toBe('hunter claw');
    expect(classLabel(POUNCE)).toBe('hunter air attack');
  });
});

describe('histograms', () => {
  it('drops 1-tick and over-20-tick holds', () => {
    const fp = {};
    addBurst(fp, { kind: 'fire', weapon: 'weapon_hunter_claw', holds: encodeIntervals([1, 1, 2, 20, 21, 30]) });
    expect(holdTotal(fp)).toBe(2);
    const counts = (fp as Record<string, number[]>)[HUNTER];
    expect(counts).toHaveLength(BINS);
    expect(counts[0]).toBe(1); // 2 ticks
    expect(counts[BINS - 1]).toBe(1); // 20 ticks
  });

  it('skips rows with no holds, corrupt holds or a non-base class', () => {
    const fp = fingerprintOf([
      { kind: 'fire', weapon: 'weapon_hunter_claw', holds: null },
      { kind: 'fire', weapon: 'weapon_hunter_claw', holds: '\u0001' },
      { kind: 'fire', weapon: 'weapon_pistol', holds: encodeIntervals([8, 8]) },
    ]);
    expect(holdTotal(fp)).toBe(0);
  });

  it('pools and subtracts', () => {
    const a = fpOf({ [HUNTER]: spread(10, 20) });
    const b = fpOf({ [HUNTER]: spread(12, 20), [SMOKER]: spread(9, 8) });
    const both = pooled([a, b]);
    expect(holdTotal(both)).toBe(48);
    expect(holdTotal(without(both, b))).toBe(20);
  });
});

describe('distance', () => {
  it('total variation: 0 for the same shape, 1 for disjoint, 0.5 for half', () => {
    const at = (bin: number, n: number) => { const c = Array(BINS).fill(0); c[bin] = n; return c; };
    expect(tvDistance(at(5, 10), at(5, 40))).toBe(0);
    expect(tvDistance(at(5, 10), at(9, 10))).toBe(1);
    const half = Array(BINS).fill(0); half[5] = 5; half[9] = 5;
    expect(tvDistance(at(5, 10), half)).toBeCloseTo(0.5);
  });

  it('is the mean over shared classes', () => {
    const cand = fpOf({ [HUNTER]: spread(10, 20), [POUNCE]: spread(10, 20) });
    const ref = fpOf({ [HUNTER]: spread(10, 40), [POUNCE]: spread(16, 40) });
    expect(distance(cand, ref)).toBeCloseTo(0.5);
  });

  it('needs 15 candidate and 30 reference holds in at least two classes', () => {
    const ref = fpOf({ [HUNTER]: spread(10, 30), [POUNCE]: spread(10, 30) });
    expect(distance(fpOf({ [HUNTER]: spread(10, 15), [POUNCE]: spread(10, 15) }), ref)).not.toBeNull();
    expect(distance(fpOf({ [HUNTER]: spread(10, 15), [POUNCE]: spread(10, 14) }), ref)).toBeNull();
    const thin = fpOf({ [HUNTER]: spread(10, 30), [POUNCE]: spread(10, 29) });
    expect(distance(fpOf({ [HUNTER]: spread(10, 15), [POUNCE]: spread(10, 15) }), thin)).toBeNull();
  });
});

describe('medians and percentiles', () => {
  it('median hold in ticks, lower median on an even count', () => {
    expect(medianHold(fpOf({ [HUNTER]: [3, 5, 5, 9] })[HUNTER])).toBe(5);
    expect(medianHold(fpOf({ [HUNTER]: [4, 6] })[HUNTER])).toBe(4);
    expect(medianHold(undefined)).toBeNull();
  });

  it('nearest-rank percentile', () => {
    expect(percentile([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0], 0.9)).toBeCloseTo(0.9);
    expect(percentile([0.3], 0.9)).toBe(0.3);
  });
});

describe('per-person threshold', () => {
  const match = (peak: number, n = 60) => fpOf({ [HUNTER]: spread(peak, n), [POUNCE]: spread(peak, n) });

  it('falls back to 0.25 under three usable member-matches', () => {
    expect(personThreshold([])).toBe(FALLBACK_THRESHOLD);
    expect(personThreshold([match(10), match(10)])).toBe(FALLBACK_THRESHOLD);
    // 98 holds each: under the 100-hold floor, so none is usable.
    expect(personThreshold([match(10, 49), match(10, 49), match(10, 49)])).toBe(FALLBACK_THRESHOLD);
  });

  it('is the 90th percentile of each match against the person without it', () => {
    const ms = [match(10), match(10), match(12)];
    const all = pooled(ms);
    const loo = ms.map((m) => distance(m, without(all, m))!);
    expect(personThreshold(ms)).toBe(percentile(loo, 0.9));
    expect(personThreshold([match(10), match(10), match(10)])).toBe(0);
  });
});

describe('matchPersons', () => {
  const big = (peak: number) => fpOf({ [HUNTER]: spread(peak, 80), [POUNCE]: spread(peak, 80) });
  const honest: FieldEntry[] = [5, 6, 7, 14, 15, 16].map((p, i) => ({ subject: `steam:h${i}`, fp: big(p) }));
  const person = (pooledPeak: number, threshold = 0.25): PersonModel =>
    ({ id: 1, label: 'dethisa', members: ['A', 'B'], pooled: big(pooledPeak), threshold });

  it('ranks the person first and matches under its threshold', () => {
    const p = person(10);
    const field = [...honest, { subject: 'steam:A', fp: big(10) }, { subject: 'steam:B', fp: big(10) }, { subject: 'person:1', fp: p.pooled }];
    const [hit] = matchPersons(big(10), 'CAND', field, [p]);
    expect(hit).toMatchObject({ personId: 1, distance: 0, rank: 1, matched: true, membersInTop10: 2, nearestMember: 'A' });
  });

  it('needs 150 base holds before it says anything', () => {
    const thin = fpOf({ [HUNTER]: spread(10, 74), [POUNCE]: spread(10, 75) });
    expect(matchPersons(thin, 'CAND', honest, [person(10)])).toEqual([]);
  });

  it('does not match a person past their threshold', () => {
    const [hit] = matchPersons(big(10), 'CAND', honest, [person(16)]);
    expect(hit.matched).toBe(false);
  });

  it('does not match outside the top 5 even under the threshold', () => {
    const twins: FieldEntry[] = [0, 1, 2, 3, 4].map((i) => ({ subject: `steam:t${i}`, fp: big(10) }));
    const [hit] = matchPersons(big(10), 'CAND', [...honest, ...twins], [person(11, 0.9)]);
    expect(hit.rank).toBe(6);
    expect(hit.matched).toBe(false);
  });

  it('takes the person\'s own accounts and the candidate out of the field', () => {
    const p = person(11, 0.9);
    const field = [...honest, { subject: 'steam:A', fp: big(10) }, { subject: 'steam:CAND', fp: big(10) }];
    const [hit] = matchPersons(big(10), 'CAND', field, [p]);
    expect(hit.rank).toBe(1);
    expect(hit.nearestMember).toBe('A');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/fingerprint.test.ts`
Expected: FAIL, `Failed to resolve import "../src/fingerprint.js"`.

- [ ] **Step 4: Write the implementation**

Create `src/fingerprint.ts`:

```ts
import { decodeIntervals, MAX_HOLDS } from './inputStats.js';

/**
 * Press fingerprints: how long a player holds infected buttons down.
 *
 * Design: docs/superpowers/specs/2026-10-17-evader-fingerprints-design.md
 *
 * dethisa's fifth account (nepmir, 2026-10-16) came on a new Discord and a
 * VPN exit nobody had used, so the Discord-move hold and the shared
 * connection check had nothing to see. What did match was how long they hold
 * the claw, pounce and smoker buttons, which no aimbot drives: their median
 * holds sat where every earlier dethisa account's did.
 *
 * A fingerprint is one histogram per press class of holds 2 to 20 ticks long.
 * 1-tick presses are a scroll wheel or a script, and over 20 is a held button
 * (30 is the plugin's "30 or more"), so neither says anything about a hand.
 *
 * Pure: no database, so the live check, the history replay and the web can
 * all use it. It says "could be them", never "is them": across first matches
 * of 183 honest players, the dethisa pool landed in the top 5 for 3%.
 */

export const HOLD_MIN = 2;
export const HOLD_MAX = 20;
export const BINS = HOLD_MAX - HOLD_MIN + 1;
export const BASE_KINDS = ['fire', 'pounce'] as const;
export const BASE_WEAPONS = ['weapon_hunter_claw', 'weapon_smoker_claw', 'weapon_boomer_claw'] as const;
/** Both spellings, for SQL. The plugin sends weapon_*, but the parser accepts
 *  a bare name too (an early parser test feeds `hunter_claw`). */
export const BASE_WEAPON_NAMES: readonly string[] = BASE_WEAPONS.flatMap((w) => [w, w.slice('weapon_'.length)]);

export const MIN_CANDIDATE_CLASS = 15;
export const MIN_REFERENCE_CLASS = 30;
export const MIN_SHARED_CLASSES = 2;
/** Enough data to check anyone at all. nepmir had about 220 after one match. */
export const MIN_CANDIDATE_HOLDS = 150;
export const MIN_MEMBER_MATCH_HOLDS = 100;
/** For scale: nepmir to dethisa was 0.203, honest first matches had a p5 of 0.250. */
export const FALLBACK_THRESHOLD = 0.25;
export const THRESHOLD_PERCENTILE = 0.9;
export const MIN_THRESHOLD_SAMPLES = 3;
export const TOP_RANK = 5;
export const MEMBERS_WINDOW = 10;

/** Class key ("fire:weapon_hunter_claw") to BINS counts; bin i is a hold of
 *  i + HOLD_MIN ticks. Counts, not shares, so pooling is addition. */
export type Fingerprint = Record<string, number[]>;

export interface BurstHoldRow { kind: string; weapon: string; holds: string | null }

export function classOf(kind: string, weapon: string): string | null {
  const w = weapon.startsWith('weapon_') ? weapon : `weapon_${weapon}`;
  if (!(BASE_KINDS as readonly string[]).includes(kind)) return null;
  if (!(BASE_WEAPONS as readonly string[]).includes(w)) return null;
  return `${kind}:${w}`;
}

/** "hunter claw", "smoker air attack": for a moderator, not a programmer. */
export function classLabel(cls: string): string {
  const [kind, weapon = ''] = cls.split(':');
  const who = weapon.replace(/^weapon_/, '').replace(/_claw$/, '');
  return kind === 'fire' ? `${who} claw` : `${who} air attack`;
}

export function addHolds(fp: Fingerprint, cls: string, holds: readonly number[]): void {
  for (const h of holds) {
    if (h < HOLD_MIN || h > HOLD_MAX) continue;
    (fp[cls] ??= new Array<number>(BINS).fill(0))[h - HOLD_MIN] += 1;
  }
}

/** One stored burst. A corrupt holds string decodes to null and is skipped
 *  rather than guessed at, as everywhere else holds are read. */
export function addBurst(fp: Fingerprint, row: BurstHoldRow): void {
  if (!row.holds) return;
  const cls = classOf(row.kind, row.weapon);
  if (!cls) return;
  const holds = decodeIntervals(row.holds, MAX_HOLDS);
  if (holds) addHolds(fp, cls, holds);
}

export function fingerprintOf(rows: Iterable<BurstHoldRow>): Fingerprint {
  const fp: Fingerprint = {};
  for (const r of rows) addBurst(fp, r);
  return fp;
}

export function mergeInto(target: Fingerprint, src: Fingerprint): Fingerprint {
  for (const [cls, counts] of Object.entries(src)) {
    const t = (target[cls] ??= new Array<number>(BINS).fill(0));
    counts.forEach((n, i) => { t[i] += n; });
  }
  return target;
}

export function pooled(fps: Iterable<Fingerprint>): Fingerprint {
  const out: Fingerprint = {};
  for (const f of fps) mergeInto(out, f);
  return out;
}

/** `total` with `part` taken out, for leave-one-out. */
export function without(total: Fingerprint, part: Fingerprint): Fingerprint {
  const out: Fingerprint = {};
  for (const [cls, counts] of Object.entries(total)) {
    const p = part[cls];
    out[cls] = counts.map((n, i) => Math.max(0, n - (p?.[i] ?? 0)));
  }
  return out;
}

export const countOf = (counts?: readonly number[]): number => (counts ? counts.reduce((a, b) => a + b, 0) : 0);

export function holdTotal(fp: Fingerprint): number {
  return Object.values(fp).reduce((s, c) => s + countOf(c), 0);
}

/** Total-variation distance of the two normalised histograms: half the sum
 *  of absolute differences, 0 for the same shape, 1 for no overlap. Callers
 *  guarantee both are non-empty. */
export function tvDistance(a: readonly number[], b: readonly number[]): number {
  const na = countOf(a);
  const nb = countOf(b);
  let sum = 0;
  for (let i = 0; i < BINS; i++) sum += Math.abs((a[i] ?? 0) / na - (b[i] ?? 0) / nb);
  return sum / 2;
}

/** Mean total-variation distance over the classes both sides have enough of,
 *  or null when fewer than MIN_SHARED_CLASSES qualify. */
export function distance(candidate: Fingerprint, reference: Fingerprint): number | null {
  const ds: number[] = [];
  for (const [cls, c] of Object.entries(candidate)) {
    const r = reference[cls];
    if (countOf(c) >= MIN_CANDIDATE_CLASS && r && countOf(r) >= MIN_REFERENCE_CLASS) ds.push(tvDistance(c, r));
  }
  return ds.length >= MIN_SHARED_CLASSES ? ds.reduce((a, b) => a + b, 0) / ds.length : null;
}

/** Median hold in ticks (the lower one on an even count), or null. */
export function medianHold(counts?: readonly number[]): number | null {
  const total = countOf(counts);
  if (!counts || total === 0) return null;
  const target = Math.floor((total - 1) / 2);
  let cum = 0;
  for (let i = 0; i < counts.length; i++) {
    cum += counts[i];
    if (cum > target) return i + HOLD_MIN;
  }
  return null;
}

/** Nearest-rank percentile of a non-empty list. */
export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

/**
 * How close is close enough for this person: the 90th percentile of how far
 * each of their own single matches (>= 100 holds) sits from the rest of them.
 * A person who plays consistently gets a tight threshold, one who does not
 * gets a loose one. Under three usable matches there is nothing to take a
 * percentile of, so the global fallback applies.
 */
export function personThreshold(memberMatches: readonly Fingerprint[]): number {
  const usable = memberMatches.filter((m) => holdTotal(m) >= MIN_MEMBER_MATCH_HOLDS);
  if (usable.length < MIN_THRESHOLD_SAMPLES) return FALLBACK_THRESHOLD;
  const all = pooled(usable);
  const ds = usable.map((m) => distance(m, without(all, m))).filter((d): d is number => d !== null);
  return ds.length >= MIN_THRESHOLD_SAMPLES ? percentile(ds, THRESHOLD_PERCENTILE) : FALLBACK_THRESHOLD;
}

/** One comparable fingerprint in the field: `steam:<id>` (a player's whole
 *  history) or `person:<id>` (a person's pooled accounts). */
export interface FieldEntry { subject: string; fp: Fingerprint }

export interface PersonModel {
  id: number;
  label: string;
  /** Steam members. */
  members: readonly string[];
  pooled: Fingerprint;
  threshold: number;
}

export interface PersonHit {
  personId: number;
  distance: number;
  threshold: number;
  /** 1 + how many field entries are strictly closer, with this person's own
   *  accounts and the candidate taken out so the person counts once. */
  rank: number;
  /** The closest member account, for alt_holds.other_steamid. */
  nearestMember: string | null;
  /** Member accounts among the candidate's MEMBERS_WINDOW nearest
   *  individual entries (second sign 4). */
  membersInTop10: number;
  /** Top 5 and within the person's threshold. */
  matched: boolean;
}

/** Score `candidate` against every person. Empty when the candidate has too
 *  little data to be checked at all. A person the candidate cannot be
 *  compared with (no shared classes) is left out. */
export function matchPersons(
  candidate: Fingerprint, candidateId: string, field: readonly FieldEntry[], persons: readonly PersonModel[],
): PersonHit[] {
  if (holdTotal(candidate) < MIN_CANDIDATE_HOLDS) return [];
  const self = `steam:${candidateId}`;
  const scored: { subject: string; d: number }[] = [];
  for (const e of field) {
    if (e.subject === self) continue;
    const d = distance(candidate, e.fp);
    if (d !== null) scored.push({ subject: e.subject, d });
  }
  const out: PersonHit[] = [];
  for (const p of persons) {
    const dP = distance(candidate, p.pooled);
    if (dP === null) continue;
    const own = new Set(p.members.map((m) => `steam:${m}`));
    const subject = `person:${p.id}`;
    const rank = 1 + scored.filter((e) => e.subject !== subject && !own.has(e.subject) && e.d < dP).length;
    const nearest = scored.filter((e) => e.subject !== subject).sort((a, b) => a.d - b.d).slice(0, MEMBERS_WINDOW);
    let nearestMember: string | null = null;
    let best = Infinity;
    for (const e of scored) {
      if (own.has(e.subject) && e.d < best) { best = e.d; nearestMember = e.subject.slice('steam:'.length); }
    }
    out.push({
      personId: p.id, distance: dP, threshold: p.threshold, rank, nearestMember,
      membersInTop10: nearest.filter((e) => own.has(e.subject)).length,
      matched: rank <= TOP_RANK && dP <= p.threshold,
    });
  }
  return out;
}

/** What else, seen on the candidate, lifts a fingerprint alert to a hold.
 *  Here rather than in fingerprintSigns.ts so the web can import the words. */
export type SecondSign = 'vpn' | 'fresh_identity' | 'cheat_flag' | 'two_members' | 'shared_connection';
export const SIGN_ORDER: readonly SecondSign[] = ['vpn', 'fresh_identity', 'cheat_flag', 'two_members', 'shared_connection'];
export const SIGN_TEXT: Record<SecondSign, string> = {
  vpn: 'a VPN or hosting connection',
  fresh_identity: 'a fresh identity',
  cheat_flag: 'a cheat flag',
  two_members: 'two of their accounts among the 10 nearest',
  shared_connection: 'a connection shared with one of their accounts',
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/fingerprint.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 6: Commit**

```bash
git add src/fingerprint.ts tests/fingerprintFixtures.ts tests/fingerprint.test.ts
git commit -m "Fingerprint math: hold histograms, TV distance, per-person threshold, ranking" -- src/fingerprint.ts tests/fingerprintFixtures.ts tests/fingerprint.test.ts
```

---

### Task 2: ASN table (iptoasn.com ip2asn-v4)

**Files:**
- Create: `src/asnTable.ts`
- Create: `tests/fixtures/ip2asn-v4-sample.tsv`
- Test: `tests/asnTable.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (`src/asnTable.ts`):
  - `IP2ASN_URL = 'https://iptoasn.com/data/ip2asn-v4.tsv.gz'`, `ASN_MAX_AGE_MS`, `MIN_RANGES = 1000`
  - `interface AsnHit { asn: number; org: string }`, `interface AsnLookup { lookup(ip: string): AsnHit | null }`
  - `ipToU32(ip: string): number | null`
  - `class AsnTable implements AsnLookup { get size(): number; lookup(ip): AsnHit | null }`
  - `parseIp2AsnTsv(text: string): AsnTable`, `loadAsnFile(path: string): AsnTable`
  - `currentAsnTable(): AsnTable | null`, `setAsnTable(t: AsnTable | null): void`
  - `refreshAsnTable(opts: { path: string; url?: string; fetchFn?: typeof fetch; now?: Date; maxAgeMs?: number; minRanges?: number }): Promise<'fresh' | 'downloaded' | 'failed'>`
  - `startAsnRefresh(opts: { path: string; download: boolean }): () => void`

The ip2asn-v4 TSV format (no header, tab separated): `range_start range_end AS_number country_code AS_description`, dotted IPv4, AS 0 means "Not routed".

- [ ] **Step 1: Create the fixture with real tabs**

```bash
printf '1.0.0.0\t1.0.0.255\t13335\tUS\tCLOUDFLARENET\n1.0.1.0\t1.0.3.255\t0\tNone\tNot routed\n45.76.0.0\t45.76.255.255\t20473\tUS\tAS-CHOOPA\n198.51.100.0\t198.51.100.255\t212238\tGB\tDATACAMP-LIMITED\n203.0.113.0\t203.0.113.127\t64500\tUS\tEXAMPLE-CABLE-RESIDENTIAL\nnot a line\n' > tests/fixtures/ip2asn-v4-sample.tsv
```

The rows are synthetic (documentation ranges and invented providers), in the real file's shape.

- [ ] **Step 2: Write the failing tests**

Create `tests/asnTable.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  currentAsnTable, ipToU32, loadAsnFile, parseIp2AsnTsv, refreshAsnTable, setAsnTable,
} from '../src/asnTable.js';

const SAMPLE = readFileSync(join(import.meta.dirname, 'fixtures/ip2asn-v4-sample.tsv'), 'utf8');
const gz = gzipSync(Buffer.from(SAMPLE));
const okFetch = (async () => new Response(gz as unknown as BodyInit)) as unknown as typeof fetch;

beforeEach(() => setAsnTable(null));

describe('ipToU32', () => {
  it('reads a dotted address and refuses anything else', () => {
    expect(ipToU32('1.0.0.0')).toBe(16777216);
    expect(ipToU32('255.255.255.255')).toBe(4294967295);
    expect(ipToU32('256.1.1.1')).toBeNull();
    expect(ipToU32('::1')).toBeNull();
  });
});

describe('parseIp2AsnTsv', () => {
  const t = parseIp2AsnTsv(SAMPLE);

  it('keeps routed ranges and skips "Not routed" and junk', () => {
    expect(t.size).toBe(4);
    expect(t.lookup('1.0.2.1')).toBeNull();
  });

  it('finds an address inside a range, at both edges', () => {
    expect(t.lookup('198.51.100.7')).toEqual({ asn: 212238, org: 'DATACAMP-LIMITED' });
    expect(t.lookup('45.76.0.0')?.asn).toBe(20473);
    expect(t.lookup('45.76.255.255')?.asn).toBe(20473);
  });

  it('returns null between ranges, past the last, and for a bad address', () => {
    expect(t.lookup('203.0.113.200')).toBeNull();
    expect(t.lookup('250.0.0.1')).toBeNull();
    expect(t.lookup('not an ip')).toBeNull();
  });
});

describe('loading and refreshing', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'asn-'));

  it('loads a gzipped file from disk', () => {
    const path = join(dir(), 'ip2asn-v4.tsv.gz');
    writeFileSync(path, gz);
    expect(loadAsnFile(path).lookup('1.0.0.9')?.asn).toBe(13335);
  });

  it('downloads when there is no file, then is fresh for a week', async () => {
    const path = join(dir(), 'ip2asn-v4.tsv.gz');
    expect(await refreshAsnTable({ path, fetchFn: okFetch, minRanges: 1 })).toBe('downloaded');
    expect(existsSync(path)).toBe(true);
    expect(currentAsnTable()?.lookup('198.51.100.1')?.asn).toBe(212238);
    let called = false;
    const spy = (async () => { called = true; return new Response(gz as unknown as BodyInit); }) as unknown as typeof fetch;
    expect(await refreshAsnTable({ path, fetchFn: spy, minRanges: 1 })).toBe('fresh');
    expect(called).toBe(false);
  });

  it('never replaces a working file with a bad download', async () => {
    const path = join(dir(), 'ip2asn-v4.tsv.gz');
    writeFileSync(path, gz);
    const old = readFileSync(path);
    const bad = (async () => new Response('<html>rate limited</html>')) as unknown as typeof fetch;
    const r = await refreshAsnTable({ path, fetchFn: bad, maxAgeMs: 0, minRanges: 1 });
    expect(r).toBe('failed');
    expect(readFileSync(path).equals(old)).toBe(true);
    expect(currentAsnTable()?.lookup('1.0.0.1')?.asn).toBe(13335); // fell back to the file
  });

  it('refuses a download with too few ranges', async () => {
    const path = join(dir(), 'ip2asn-v4.tsv.gz');
    expect(await refreshAsnTable({ path, fetchFn: okFetch })).toBe('failed'); // 4 < MIN_RANGES
    expect(existsSync(path)).toBe(false);
    expect(currentAsnTable()).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/asnTable.test.ts`
Expected: FAIL, cannot resolve `../src/asnTable.js`.

- [ ] **Step 4: Write the implementation**

Create `src/asnTable.ts`:

```ts
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

/**
 * Which network (autonomous system) an address belongs to, offline.
 *
 * For the evader fingerprint's first second sign: a connection from a VPN or
 * hosting provider (src/networkKinds.ts). The table is iptoasn.com's free
 * ip2asn-v4 file, public domain, one line per routed range:
 *
 *   range_start  range_end  AS_number  country_code  AS_description
 *
 * It is held in memory as sorted typed arrays and looked up by binary search,
 * so a connect costs a few dozen comparisons and no network call. The address
 * itself is never kept: the lookup happens on the way into player_networks,
 * next to the salted hash, and only the AS number and provider name are
 * stored. An AS number names a provider, not a person.
 *
 * No dependency: fetch and node:zlib do the download. A download that fails
 * or looks truncated never replaces the file that works.
 */

export const IP2ASN_URL = 'https://iptoasn.com/data/ip2asn-v4.tsv.gz';
export const ASN_MAX_AGE_MS = 7 * 86_400_000;
/** A real file has several hundred thousand ranges. Fewer than this is an
 *  error page or a cut-off download. */
export const MIN_RANGES = 1000;

export interface AsnHit { asn: number; org: string }
export interface AsnLookup { lookup(ip: string): AsnHit | null }

export function ipToU32(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return null;
  return o[0] * 16777216 + o[1] * 65536 + o[2] * 256 + o[3];
}

export class AsnTable implements AsnLookup {
  constructor(
    private readonly starts: Uint32Array,
    private readonly ends: Uint32Array,
    private readonly asns: Uint32Array,
    private readonly orgIndex: Uint32Array,
    private readonly orgs: readonly string[],
  ) {}

  get size(): number {
    return this.starts.length;
  }

  lookup(ip: string): AsnHit | null {
    const n = ipToU32(ip);
    if (n === null) return null;
    let lo = 0;
    let hi = this.starts.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.starts[mid] <= n) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (found < 0 || n > this.ends[found]) return null;
    return { asn: this.asns[found], org: this.orgs[this.orgIndex[found]] };
  }
}

/** Unroutable ranges (AS 0) and malformed lines are dropped, not guessed at. */
export function parseIp2AsnTsv(text: string): AsnTable {
  const rows: [number, number, number, string][] = [];
  for (const line of text.split('\n')) {
    const f = line.split('\t');
    if (f.length < 5) continue;
    const start = ipToU32(f[0]);
    const end = ipToU32(f[1]);
    const asn = Number(f[2]);
    if (start === null || end === null || end < start || !Number.isInteger(asn) || asn <= 0) continue;
    rows.push([start, end, asn, f[4].trim()]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  const orgs: string[] = [];
  const orgId = new Map<string, number>();
  const starts = new Uint32Array(rows.length);
  const ends = new Uint32Array(rows.length);
  const asns = new Uint32Array(rows.length);
  const orgIndex = new Uint32Array(rows.length);
  rows.forEach(([s, e, a, org], i) => {
    let id = orgId.get(org);
    if (id === undefined) { id = orgs.length; orgs.push(org); orgId.set(org, id); }
    starts[i] = s; ends[i] = e; asns[i] = a; orgIndex[i] = id;
  });
  return new AsnTable(starts, ends, asns, orgIndex, orgs);
}

export function loadAsnFile(path: string): AsnTable {
  const buf = readFileSync(path);
  return parseIp2AsnTsv((path.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8'));
}

let current: AsnTable | null = null;

/** The table connects are tagged with, or null before one has loaded. */
export function currentAsnTable(): AsnTable | null {
  return current;
}

export function setAsnTable(t: AsnTable | null): void {
  current = t;
}

/**
 * Download a new table when the file on disk is missing or a week old.
 * 'fresh': nothing to do (the file is loaded if nothing is yet). 'failed':
 * the old file and the table in memory are kept.
 */
export async function refreshAsnTable(opts: {
  path: string; url?: string; fetchFn?: typeof fetch; now?: Date; maxAgeMs?: number; minRanges?: number;
}): Promise<'fresh' | 'downloaded' | 'failed'> {
  const now = opts.now ?? new Date();
  const maxAge = opts.maxAgeMs ?? ASN_MAX_AGE_MS;
  if (existsSync(opts.path) && now.getTime() - statSync(opts.path).mtimeMs < maxAge) {
    if (!current) current = loadAsnFile(opts.path);
    return 'fresh';
  }
  try {
    const res = await (opts.fetchFn ?? fetch)(opts.url ?? IP2ASN_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const gz = Buffer.from(await res.arrayBuffer());
    const table = parseIp2AsnTsv(gunzipSync(gz).toString('utf8'));
    if (table.size < (opts.minRanges ?? MIN_RANGES)) throw new Error(`only ${table.size} ranges`);
    const tmp = `${opts.path}.tmp`;
    writeFileSync(tmp, gz);
    renameSync(tmp, opts.path);
    current = table;
    return 'downloaded';
  } catch (err) {
    console.error('[asn] table refresh failed, keeping the one we have:', err);
    if (!current && existsSync(opts.path)) {
      try { current = loadAsnFile(opts.path); } catch (e) { console.error('[asn] the table on disk does not load either:', e); }
    }
    return 'failed';
  }
}

/**
 * Load the file on disk now, then (when `download`) refresh it at once and
 * check once a day, downloading when it is a week old. Returns a stop
 * function. The web process calls this from src/index.ts only, never from
 * buildServer, so tests never reach the network.
 */
export function startAsnRefresh(opts: { path: string; download: boolean }): () => void {
  if (existsSync(opts.path)) {
    try { current = loadAsnFile(opts.path); } catch (err) { console.error('[asn] could not load the table on disk:', err); }
  }
  if (!opts.download) return () => {};
  const tick = () => { void refreshAsnTable({ path: opts.path }); };
  tick();
  const timer = setInterval(tick, 86_400_000);
  timer.unref();
  return () => clearInterval(timer);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/asnTable.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/asnTable.ts tests/asnTable.test.ts tests/fixtures/ip2asn-v4-sample.tsv
git commit -m "ASN table: offline iptoasn.com lookup with a weekly refresh that never replaces a good file" -- src/asnTable.ts tests/asnTable.test.ts tests/fixtures/ip2asn-v4-sample.tsv
```

---

### Task 3: VPN/hosting network kinds and the vpn_asns_extra setting

**Files:**
- Create: `src/networkKinds.ts`
- Modify: `src/db.ts` (DEFAULT_SETTINGS, after `input_pistol_min_rate: '12',`)
- Modify: `src/settingsSchema.ts` (SETTINGS_SCHEMA, after the `input_pistol_min_rate` entry)
- Test: `tests/networkKinds.test.ts`

**Interfaces:**
- Consumes: `getSetting` from `src/settings.ts`; `validateSetting` from `src/settingsSchema.ts`.
- Produces (`src/networkKinds.ts`): `KNOWN_VPN_ASNS: ReadonlyMap<number, string>`, `extraVpnAsns(db): Set<number>`, `isVpnNetwork(asn: number | null, asOrg: string | null, extra: ReadonlySet<number>): boolean`. Setting `vpn_asns_extra` (JSON int list, default `'[]'`).

- [ ] **Step 1: Write the failing tests**

Create `tests/networkKinds.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { validateSetting } from '../src/settingsSchema.js';
import { extraVpnAsns, isVpnNetwork, KNOWN_VPN_ASNS } from '../src/networkKinds.js';

const none = new Set<number>();

describe('isVpnNetwork', () => {
  it('knows the providers seen in our logs', () => {
    for (const asn of [212238, 62240, 9009, 60068, 20473, 14061, 16509, 24940, 16276]) {
      expect(KNOWN_VPN_ASNS.has(asn), String(asn)).toBe(true);
      expect(isVpnNetwork(asn, 'whatever', none)).toBe(true);
    }
  });

  it('reads hosting words in the provider name', () => {
    expect(isVpnNetwork(64501, 'ACME-HOSTING-LTD', none)).toBe(true);
    expect(isVpnNetwork(64502, 'Example Cloud Services', none)).toBe(true);
    expect(isVpnNetwork(64503, 'FASTVPN', none)).toBe(true);
    expect(isVpnNetwork(64504, 'EXAMPLE-CABLE-RESIDENTIAL', none)).toBe(false);
  });

  it('never calls an unknown network a VPN', () => {
    expect(isVpnNetwork(null, null, none)).toBe(false);
    expect(isVpnNetwork(null, 'HOSTING', none)).toBe(false);
  });

  it('takes ASNs staff added by hand', () => {
    const db = openDb(':memory:');
    expect(extraVpnAsns(db).size).toBe(0);
    setSetting(db, 'vpn_asns_extra', '[64505]');
    expect(isVpnNetwork(64505, 'PLAIN-NAME', extraVpnAsns(db))).toBe(true);
    setSetting(db, 'vpn_asns_extra', 'not json');
    expect(extraVpnAsns(db).size).toBe(0);
  });

  it('validates the setting as a list of AS numbers', () => {
    expect(validateSetting('vpn_asns_extra', [212238, 9009])).toEqual({ ok: true, value: '[212238,9009]' });
    expect(validateSetting('vpn_asns_extra', [0]).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/networkKinds.test.ts`
Expected: FAIL, cannot resolve `../src/networkKinds.js`.

- [ ] **Step 3: Write the implementation**

Create `src/networkKinds.ts`:

```ts
import type { DB } from './db.js';
import { getSetting } from './settings.js';

/**
 * Which networks count as VPN or hosting, for the fingerprint's first second
 * sign. A residential connection is somebody's house; a hosting range is a
 * VPN exit or a rented server, which is how nepmir connected (Datacamp).
 *
 * Two parts: a curated list of AS numbers we have seen evaders use, and a
 * guess from the provider's name. Staff add an ASN by hand through the
 * vpn_asns_extra setting. An unknown network (no lookup) is never a VPN:
 * "we do not know" must not read as a sign against anyone.
 */

export const KNOWN_VPN_ASNS: ReadonlyMap<number, string> = new Map([
  [212238, 'Datacamp'],
  [62240, 'Clouvider'],
  [9009, 'M247'],
  [60068, 'Datacamp / CDN77'],
  [20473, 'Vultr'],
  [14061, 'DigitalOcean'],
  [16509, 'Amazon'],
  [24940, 'Hetzner'],
  [16276, 'OVH'],
]);

const ORG_HINT = /hosting|datacent(er|re)|data cent(er|re)|cloud|vpn|server/i;

export function extraVpnAsns(db: DB): Set<number> {
  try {
    const v: unknown = JSON.parse(getSetting(db, 'vpn_asns_extra') ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n) && n > 0) : []);
  } catch {
    return new Set();
  }
}

export function isVpnNetwork(asn: number | null, asOrg: string | null, extra: ReadonlySet<number>): boolean {
  if (asn === null) return false;
  if (KNOWN_VPN_ASNS.has(asn) || extra.has(asn)) return true;
  return asOrg !== null && ORG_HINT.test(asOrg);
}
```

In `src/db.ts`, DEFAULT_SETTINGS, insert after the line `  input_pistol_min_rate: '12',`:

```ts
  // Evader fingerprints (src/fingerprintCheck.ts): 'off', 'alert' (mod channel
  // only) or 'full' (alert, and an alt hold on a second sign). Ships off.
  evader_fingerprint: 'off',
  // AS numbers staff count as VPN or hosting on top of src/networkKinds.ts.
  vpn_asns_extra: '[]',
```

(`evader_fingerprint` is used from Task 11; adding both defaults now keeps the settings test green when Task 11 adds its schema entry.)

In `src/settingsSchema.ts`, insert after the `input_pistol_min_rate` entry:

```ts
  { key: 'vpn_asns_extra', group: 'Stats', label: 'Extra VPN and hosting networks (AS numbers)', help: 'AS numbers that count as a VPN or hosting connection for the evader fingerprint, on top of the built-in list (Datacamp, M247, Vultr and others) and provider names with hosting, cloud, VPN or server in them. A connection from one is a second sign, never a verdict on its own.', type: { kind: 'intList', min: 1, max: 4294967295, maxItems: 100 } },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/networkKinds.test.ts tests/adminSettings.test.ts`
Expected: PASS (adminSettings' "every schema key has a seeded default" stays green).

- [ ] **Step 5: Commit**

```bash
git add src/networkKinds.ts src/db.ts src/settingsSchema.ts tests/networkKinds.test.ts
git commit -m "Network kinds: curated VPN/hosting ASNs, provider-name hints, staff extras" -- src/networkKinds.ts src/db.ts src/settingsSchema.ts tests/networkKinds.test.ts
```

---

### Task 4: Tag connections with their ASN

**Files:**
- Modify: `src/db.ts` (after `db.exec('CREATE INDEX IF NOT EXISTS idx_player_networks_hash ON player_networks (ip_hash)');`)
- Modify: `src/playerNetworks.ts` (`recordPlayerNet`)
- Modify: `src/index.ts`
- Test: `tests/playerNetworks.test.ts` (append)

**Interfaces:**
- Consumes: `AsnLookup`, `currentAsnTable`, `startAsnRefresh` from Task 2.
- Produces: `player_networks.asn INTEGER`, `player_networks.as_org TEXT`; `recordPlayerNet(db, ev, now = new Date(), asn: AsnLookup | null = currentAsnTable()): string | null` (same return as today).

- [ ] **Step 1: Write the failing tests**

Append to `tests/playerNetworks.test.ts` (it already has `db`, `MAIN`, `recordPlayerNet` in scope; add the import line at the top of the file):

```ts
import type { AsnLookup } from '../src/asnTable.js';
```

```ts
describe('network tag', () => {
  const table: AsnLookup = {
    lookup: (ip) => (ip === '198.51.100.4' ? { asn: 212238, org: 'DATACAMP-LIMITED' } : null),
  };
  const row = () => db.prepare('SELECT asn, as_org FROM player_networks WHERE player_id = ?').get(MAIN) as { asn: number | null; as_org: string | null };

  it('stores the provider next to the hash, never the address', () => {
    recordPlayerNet(db, { steamid: MAIN, ip: '198.51.100.4', country: 'GB' }, new Date(), table);
    expect(row()).toEqual({ asn: 212238, as_org: 'DATACAMP-LIMITED' });
    expect(JSON.stringify(db.prepare('SELECT * FROM player_networks').all())).not.toContain('198.51.100.4');
  });

  it('keeps a known provider when a later lookup has none', () => {
    recordPlayerNet(db, { steamid: MAIN, ip: '198.51.100.4', country: 'GB' }, new Date(), table);
    recordPlayerNet(db, { steamid: MAIN, ip: '198.51.100.4', country: 'GB' }, new Date(), null);
    expect(row().asn).toBe(212238);
  });

  it('leaves it unknown without a table', () => {
    recordPlayerNet(db, { steamid: MAIN, ip: '203.0.113.9', country: 'US' }, new Date(), null);
    expect(row()).toEqual({ asn: null, as_org: null });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/playerNetworks.test.ts`
Expected: FAIL, `no such column: asn`.

- [ ] **Step 3: Write the implementation**

In `src/db.ts`, after `db.exec('CREATE INDEX IF NOT EXISTS idx_player_networks_hash ON player_networks (ip_hash)');` add:

```ts
  // Which network a connection came from (src/asnTable.ts, iptoasn.com), for
  // telling a VPN or hosting exit from a house. The AS number and provider
  // name only: the address is still never stored. NULL is "unknown", never
  // "residential".
  ensureColumn(db, 'player_networks', 'asn', 'INTEGER');
  ensureColumn(db, 'player_networks', 'as_org', 'TEXT');
```

In `src/playerNetworks.ts`, add the import:

```ts
import { currentAsnTable, type AsnLookup } from './asnTable.js';
```

and replace the whole `recordPlayerNet` function with:

```ts
/** Record one sighting. Repeats bump a counter rather than adding rows.
 *  Returns the address's hash, or null for one that identifies nobody.
 *  `asn` tags the row with its network; it defaults to the table the web
 *  process loaded, and tests pass their own. */
export function recordPlayerNet(
  db: DB, ev: { steamid: string; ip: string; country: string | null }, now = new Date(),
  asn: AsnLookup | null = currentAsnTable(),
): string | null {
  if (!usable(ev.ip)) return null;
  const at = now.toISOString();
  const ipHash = hashIp(db, ev.ip);
  const net = asn?.lookup(ev.ip) ?? null;
  db.prepare(
    `INSERT INTO player_networks (player_id, ip_hash, country, first_seen, last_seen, seen_count, asn, as_org)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(player_id, ip_hash) DO UPDATE SET
       last_seen  = excluded.last_seen,
       seen_count = player_networks.seen_count + 1,
       -- A later lookup wins only when it actually resolved. A country that
       -- was read once should not be erased by a sighting that could not
       -- read one. The network likewise.
       country    = COALESCE(excluded.country, player_networks.country),
       asn        = COALESCE(excluded.asn, player_networks.asn),
       as_org     = COALESCE(excluded.as_org, player_networks.as_org)`,
  ).run(ev.steamid, ipHash, ev.country, at, at, net?.asn ?? null, net?.org ?? null);
  return ipHash;
}
```

In `src/index.ts`, replace:

```ts
const config = loadConfig();
const db = openDb(config.dbPath);
```

with:

```ts
const config = loadConfig();
const db = openDb(config.dbPath);
// The network tag on connects (src/asnTable.ts). Here and not in buildServer,
// so no test ever downloads anything. Dev mode loads a file already on disk
// but never fetches.
startAsnRefresh({ path: join(dirname(config.dbPath), 'ip2asn-v4.tsv.gz'), download: !config.devMode });
```

and add the imports at the top of `src/index.ts`:

```ts
import { dirname, join } from 'node:path';
import { startAsnRefresh } from './asnTable.js';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/playerNetworks.test.ts tests/ipWatch.test.ts tests/sourcetvSessions.test.ts tests/stats.test.ts`
Expected: PASS. Then `npm run typecheck`, expected no errors.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/playerNetworks.ts src/index.ts tests/playerNetworks.test.ts
git commit -m "player_networks: tag each connect with its AS number and provider, never the address" -- src/db.ts src/playerNetworks.ts src/index.ts tests/playerNetworks.test.ts
```

---
### Task 5: Person records replace evader flags

**Files:**
- Create: `src/evaderSeed.ts` (seed constants only; `seedPeople` comes in Task 16)
- Create: `src/evaderPeople.ts`
- Modify: `src/ipWatch.ts`
- Modify: `src/db.ts` (call `ensureEvaderSchema` right after `ensureIpWatchSchema(db);`)
- Modify: `tests/ipWatch.test.ts`, `tests/db.test.ts`
- Test: `tests/evaderPeople.test.ts`

**Interfaces:**
- Consumes: `hashIp`, `recordPlayerNet` (Task 4 signature) for tests.
- Produces:
  - `src/evaderSeed.ts`: `interface SeedPerson { label: string; note: string; steam: readonly string[]; steamByName: readonly string[]; discord: readonly string[] }`, `DETHISA: SeedPerson`, `SHOVE: SeedPerson`, `SEED_PEOPLE: readonly SeedPerson[]`, `REPLAY_REQUIRED: readonly { steamid: string; name: string }[]`
  - `src/evaderPeople.ts`: `type MemberKind = 'steam' | 'discord'`, `interface PersonRow { id: number; label: string; note: string; createdBy: string; createdAt: string; closedAt: string | null }`, `class EvaderError extends Error`, `ensureEvaderSchema(db)`, `migrateEvaderFlags(db)`, `createPerson(db, label, note, by, now?): number`, `personByLabel(db, label): PersonRow | null`, `personById(db, id): PersonRow | null`, `type AddResult = 'added' | 'already' | 'other_person' | 'no_person' | 'invalid'`, `addMember(db, personId, kind, ident, by, how, now?): AddResult`, `removeMember(db, kind, ident, by, now?): boolean`, `closePerson(db, personId, by, now?): boolean`, `personOf(db, kind, ident): { id: number; label: string; closed: boolean } | null`, `isOpenMember(db, steamid): boolean`, `openPeople(db): PersonRow[]`, `steamMembersOf(db, personId): string[]`, `membersOf(db, personId): { kind: MemberKind; ident: string; addedBy: string; addedAt: string; how: string }[]`, `markPersonStale(db, personId)`
  - Tables: `evader_people`, `evader_members`, `fingerprint_cache (subject, classes_json, holds, built_at)`, `fingerprint_alerts (steamid, person_id, level IN ('alert','loud','hold'), distance, threshold, rank, signs_json, match_id, created_at, PRIMARY KEY (steamid, person_id, level))`
  - `src/ipWatch.ts`: `isFlagged(db, steamid)` unchanged signature (now "Steam member of an open person"), new `watchAccount(db, steamid, by, at: string)`, `unwatchAccount(db, steamid, by, at: string)`, `ipWatchView(db, now?): { entries: WatchEntry[] }`. REMOVED: `flagEvader`, `clearEvader`, `evaderFlagOf`, `EvaderFlag`, `ipWatchView().flags`.

- [ ] **Step 1: Write the seed constants**

Create `src/evaderSeed.ts`:

```ts
/**
 * The known evaders at launch (spec section 4), owner-confirmed 2026-10-17.
 *
 * dethisa: five Steam accounts banned for evasion between 2026-09-23 and
 * 2026-10-17, plus every account still named "dethisa (pre-ban)". shove is
 * not evading: the record exists so a return is caught.
 *
 * The migration (src/evaderPeople.ts) reads DETHISA to know which evader
 * flags are the same person. The one-off seed (seedPeople, scripts/
 * seed-evader-people.ts) writes all of it, with an owner go-ahead and after a
 * DB backup.
 */

export interface SeedPerson {
  label: string;
  note: string;
  steam: readonly string[];
  /** Every players row with exactly this name is a member too. */
  steamByName: readonly string[];
  discord: readonly string[];
}

export const DETHISA: SeedPerson = {
  label: 'dethisa',
  note: 'Ban evader: telltale (09-23), sleepmark (09-25), ne (10-02), indianstreetfood (10-06), nepmir (10-16, aimbot in match 722).',
  steam: [
    '76561199238804333', // telltale
    '76561198990547138', // sleepmark
    '76561198373680118', // ne / dethisa
    '76561198032482558', // indianstreetfood
    '76561198129925325', // nepmir
  ],
  steamByName: ['dethisa (pre-ban)'],
  discord: ['286250932470153217', '852912263160791060', '617660733718659083'],
};

export const SHOVE: SeedPerson = {
  label: 'shove',
  note: 'Not evading. Recorded so a return is caught.',
  steam: ['76561198422117946', '76561199794242897'], // shove, Bella<3
  steamByName: [],
  discord: ['173483060682031104', '1547058677121421372'],
};

export const SEED_PEOPLE: readonly SeedPerson[] = [DETHISA, SHOVE];

/** The history replay must catch each of these as a dethisa candidate with
 *  that account taken out of the seed (spec section 5). */
export const REPLAY_REQUIRED: readonly { steamid: string; name: string }[] = [
  { steamid: '76561198032482558', name: 'indianstreetfood' },
  { steamid: '76561198129925325', name: 'nepmir' },
];
```

- [ ] **Step 2: Write the failing tests**

Create `tests/evaderPeople.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { recordPlayerNet } from '../src/playerNetworks.js';
import {
  addMember, closePerson, createPerson, ensureEvaderSchema, EvaderError, isOpenMember, openPeople,
  personByLabel, personOf, removeMember, steamMembersOf,
} from '../src/evaderPeople.js';
import { ipWatchView, isFlagged } from '../src/ipWatch.js';
import { DETHISA } from '../src/evaderSeed.js';
import { player } from './fingerprintFixtures.js';

const STAFF = '76561198000000009';
const OTHER = '76561198000000005';
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  player(db, STAFF, 'staff');
});

describe('person records', () => {
  it('one person per label, trimmed, never blank', () => {
    const id = createPerson(db, ' dethisa ', 'five accounts', STAFF);
    expect(personByLabel(db, 'dethisa')?.id).toBe(id);
    expect(() => createPerson(db, 'dethisa', '', STAFF)).toThrow(EvaderError);
    expect(() => createPerson(db, '   ', '', STAFF)).toThrow(EvaderError);
  });

  it('an account belongs to at most one person', () => {
    const a = createPerson(db, 'dethisa', '', STAFF);
    const b = createPerson(db, 'shove', '', STAFF);
    expect(addMember(db, a, 'steam', DETHISA.steam[0], STAFF, 'manual')).toBe('added');
    expect(addMember(db, a, 'steam', DETHISA.steam[0], STAFF, 'manual')).toBe('already');
    expect(addMember(db, b, 'steam', DETHISA.steam[0], STAFF, 'manual')).toBe('other_person');
    expect(addMember(db, 999, 'steam', OTHER, STAFF, 'manual')).toBe('no_person');
    expect(addMember(db, a, 'steam', 'not-a-steamid', STAFF, 'manual')).toBe('invalid');
    expect(addMember(db, a, 'discord', '286250932470153217', STAFF, 'manual')).toBe('added');
    expect(steamMembersOf(db, a)).toEqual([DETHISA.steam[0]]);
    expect(personOf(db, 'discord', '286250932470153217')?.label).toBe('dethisa');
  });

  it('marks the cached pooled fingerprint stale on a membership change', () => {
    const id = createPerson(db, 'dethisa', '', STAFF);
    db.prepare("INSERT INTO fingerprint_cache (subject, classes_json, holds, built_at) VALUES (?, '{}', 0, '2026-10-17T00:00:00.000Z')")
      .run(`person:${id}`);
    addMember(db, id, 'steam', OTHER, STAFF, 'manual');
    const row = db.prepare('SELECT built_at FROM fingerprint_cache WHERE subject = ?').get(`person:${id}`) as { built_at: string };
    expect(row.built_at).toBe('');
  });
});

describe('isFlagged parity', () => {
  it('a Steam member of an open person is flagged; of a closed one, or removed, is not', () => {
    const id = createPerson(db, 'dethisa', '', STAFF);
    addMember(db, id, 'steam', OTHER, STAFF, 'manual');
    expect(isFlagged(db, OTHER)).toBe(true);
    expect(isOpenMember(db, OTHER)).toBe(true);
    expect(closePerson(db, id, STAFF)).toBe(true);
    expect(isFlagged(db, OTHER)).toBe(false);
    expect(openPeople(db)).toEqual([]);
  });

  it('adding a member watches every address they used; removing them stops it', () => {
    recordPlayerNet(db, { steamid: OTHER, ip: '8.8.8.8', country: 'US' }, new Date(), null);
    const id = createPerson(db, 'dethisa', '', STAFF);
    addMember(db, id, 'steam', OTHER, STAFF, 'manual');
    const entries = ipWatchView(db).entries;
    expect(entries.map((e) => e.steamid)).toEqual([OTHER]);
    expect(entries[0].accounts[0].flagged).toBe(true);
    expect(removeMember(db, 'steam', OTHER, STAFF)).toBe(true);
    expect(ipWatchView(db).entries).toEqual([]);
  });

  it('closing a person stops watching their addresses', () => {
    recordPlayerNet(db, { steamid: OTHER, ip: '8.8.8.8', country: 'US' }, new Date(), null);
    const id = createPerson(db, 'dethisa', '', STAFF);
    addMember(db, id, 'steam', OTHER, STAFF, 'manual');
    closePerson(db, id, STAFF);
    expect(ipWatchView(db).entries).toEqual([]);
  });
});

describe('the evader_flags migration', () => {
  /** Re-run the schema as if this were the first boot with person records. */
  const firstBoot = () => {
    db.exec('DROP TABLE evader_members; DROP TABLE evader_people;');
    ensureEvaderSchema(db);
  };
  const flag = (steamid: string, reason: string, cleared = false) => db.prepare(
    `INSERT INTO evader_flags (steamid, reason, created_by, created_at, cleared_by, cleared_at)
     VALUES (?, ?, ?, '2026-10-08T00:00:00.000Z', ?, ?)`,
  ).run(steamid, reason, STAFF, cleared ? STAFF : null, cleared ? '2026-10-09T00:00:00.000Z' : null);

  it('puts every open dethisa flag on one person dethisa', () => {
    for (const id of DETHISA.steam.slice(0, 4)) flag(id, 'dethisa');
    firstBoot();
    const p = personByLabel(db, 'dethisa')!;
    expect(steamMembersOf(db, p.id).sort()).toEqual([...DETHISA.steam.slice(0, 4)].sort());
    for (const id of DETHISA.steam.slice(0, 4)) expect(isFlagged(db, id)).toBe(true);
  });

  it('gives any other open flag its own person named after the account, and skips cleared flags', () => {
    player(db, OTHER, 'someone');
    flag(OTHER, 'another evader');
    flag('76561198000000006', 'cleared one', true);
    firstBoot();
    expect(openPeople(db).map((p) => p.label)).toEqual(['someone']);
    expect(personOf(db, 'steam', '76561198000000006')).toBeNull();
  });

  it('runs once and leaves evader_flags in place', () => {
    flag(DETHISA.steam[0], 'dethisa');
    firstBoot();
    ensureEvaderSchema(db);
    expect(openPeople(db)).toHaveLength(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM evader_flags').get() as { n: number }).n).toBe(1);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/evaderPeople.test.ts`
Expected: FAIL, cannot resolve `../src/evaderPeople.js`.

- [ ] **Step 4: Write `src/evaderPeople.ts`**

```ts
import type { DB } from './db.js';
import { unwatchAccount, watchAccount } from './ipWatch.js';
import { DETHISA } from './evaderSeed.js';

/**
 * Known evaders as PEOPLE: one record per person, grouping every Steam and
 * Discord account they have been caught on.
 *
 * Design: docs/superpowers/specs/2026-10-17-evader-fingerprints-design.md
 *
 * Replaces the per-account evader_flags (src/ipWatch.ts). dethisa had four
 * flagged accounts that nothing tied together; as one person they have one
 * pooled press fingerprint to match a sixth account against, and one card on
 * People > Alts. An account belongs to at most one person.
 *
 * isFlagged in src/ipWatch.ts now means "a Steam member of an OPEN person",
 * so everything built on flags (watching every connection an evader uses,
 * the loud watch-list alert) carries on unchanged. A closed person is no
 * longer watched or matched; the record stays for history.
 *
 * evader_flags is left in place, read-only, for one release, then dropped.
 */

export type MemberKind = 'steam' | 'discord';

export interface PersonRow {
  id: number; label: string; note: string; createdBy: string; createdAt: string; closedAt: string | null;
}

export class EvaderError extends Error {}

const PERSON_SELECT = `SELECT id, label, note, created_by AS createdBy, created_at AS createdAt, closed_at AS closedAt
  FROM evader_people`;

export function ensureEvaderSchema(db: DB): void {
  const isNew = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'evader_people'").get() === undefined;
  db.exec(`
    CREATE TABLE IF NOT EXISTS evader_people (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      label       TEXT NOT NULL UNIQUE,
      note        TEXT NOT NULL DEFAULT '',
      created_by  TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      -- closed = no longer watched or matched
      closed_by   TEXT,
      closed_at   TEXT
    );
    CREATE TABLE IF NOT EXISTS evader_members (
      person_id   INTEGER NOT NULL REFERENCES evader_people(id),
      kind        TEXT NOT NULL CHECK (kind IN ('steam','discord')),
      -- SteamID64 or Discord user id
      ident       TEXT NOT NULL,
      -- admin steamid or 'system'
      added_by    TEXT NOT NULL,
      added_at    TEXT NOT NULL,
      -- 'seed', 'manual', 'migrated flag', 'ban as same person'
      how         TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (kind, ident)
    );
    CREATE INDEX IF NOT EXISTS evader_members_person ON evader_members (person_id);
    -- Fingerprints built from input_bursts (src/fingerprintData.ts). subject is
    -- steam:<id> (whole history) or person:<id> (pooled members). built_at ''
    -- means stale: rebuilt on the next check.
    CREATE TABLE IF NOT EXISTS fingerprint_cache (
      subject      TEXT PRIMARY KEY,
      classes_json TEXT NOT NULL,
      holds        INTEGER NOT NULL,
      built_at     TEXT NOT NULL
    );
    -- One row per (candidate, person, level) that fired (src/fingerprintCheck.ts).
    -- A candidate is told about again only when the level goes up.
    CREATE TABLE IF NOT EXISTS fingerprint_alerts (
      steamid     TEXT NOT NULL,
      person_id   INTEGER NOT NULL,
      level       TEXT NOT NULL CHECK (level IN ('alert','loud','hold')),
      distance    REAL NOT NULL,
      threshold   REAL NOT NULL,
      rank        INTEGER NOT NULL,
      signs_json  TEXT NOT NULL DEFAULT '[]',
      match_id    INTEGER,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (steamid, person_id, level)
    );
  `);
  if (isNew) migrateEvaderFlags(db);
}

function insertPerson(db: DB, label: string, note: string, by: string, at: string): number {
  return Number(db.prepare('INSERT INTO evader_people (label, note, created_by, created_at) VALUES (?, ?, ?, ?)')
    .run(label, note, by, at).lastInsertRowid);
}

/** A label nobody has: the account's name, or the name and the id. */
function freeLabel(db: DB, name: string, steamid: string): string {
  return personByLabel(db, name) ? `${name} (${steamid})` : name;
}

/**
 * Every open evader flag becomes a Steam member of a person. The dethisa
 * accounts (src/evaderSeed.ts) go on one person `dethisa`. Any other flag is
 * NOT guessed at: it becomes its own person named after the account, and
 * staff merge records by hand. Runs once, on the boot that creates
 * evader_people. It writes no watch rows: the flags already put them there.
 */
export function migrateEvaderFlags(db: DB): void {
  const flags = db.prepare(
    `SELECT f.steamid, f.reason, f.created_by AS createdBy, f.created_at AS createdAt, p.name
       FROM evader_flags f LEFT JOIN players p ON p.steamid = f.steamid
      WHERE f.cleared_at IS NULL ORDER BY f.created_at, f.steamid`,
  ).all() as { steamid: string; reason: string; createdBy: string; createdAt: string; name: string | null }[];
  if (flags.length === 0) return;
  const dethisa = new Set(DETHISA.steam);
  db.transaction(() => {
    for (const f of flags) {
      const known = dethisa.has(f.steamid) || (f.name !== null && DETHISA.steamByName.includes(f.name));
      const label = known ? DETHISA.label : freeLabel(db, f.name ?? f.steamid, f.steamid);
      const id = personByLabel(db, label)?.id
        ?? insertPerson(db, label, known ? 'Made from the evader flags.' : f.reason, f.createdBy, f.createdAt);
      db.prepare(
        `INSERT OR IGNORE INTO evader_members (person_id, kind, ident, added_by, added_at, how)
         VALUES (?, 'steam', ?, ?, ?, 'migrated flag')`,
      ).run(id, f.steamid, f.createdBy, f.createdAt);
    }
  })();
}

export function createPerson(db: DB, label: string, note: string, by: string, now = new Date()): number {
  const l = label.trim();
  if (!l || l.length > 40) throw new EvaderError('a label is 1 to 40 characters');
  if (note.length > 500) throw new EvaderError('a note is up to 500 characters');
  if (personByLabel(db, l)) throw new EvaderError('a person with that label already exists');
  return insertPerson(db, l, note.trim(), by, now.toISOString());
}

export function personByLabel(db: DB, label: string): PersonRow | null {
  return (db.prepare(`${PERSON_SELECT} WHERE label = ?`).get(label) as PersonRow | undefined) ?? null;
}

export function personById(db: DB, id: number): PersonRow | null {
  return (db.prepare(`${PERSON_SELECT} WHERE id = ?`).get(id) as PersonRow | undefined) ?? null;
}

export function openPeople(db: DB): PersonRow[] {
  return db.prepare(`${PERSON_SELECT} WHERE closed_at IS NULL ORDER BY id`).all() as PersonRow[];
}

export function personOf(db: DB, kind: MemberKind, ident: string): { id: number; label: string; closed: boolean } | null {
  const r = db.prepare(
    `SELECT p.id, p.label, p.closed_at FROM evader_members m JOIN evader_people p ON p.id = m.person_id
      WHERE m.kind = ? AND m.ident = ?`,
  ).get(kind, ident) as { id: number; label: string; closed_at: string | null } | undefined;
  return r ? { id: r.id, label: r.label, closed: r.closed_at !== null } : null;
}

export function isOpenMember(db: DB, steamid: string): boolean {
  const p = personOf(db, 'steam', steamid);
  return p !== null && !p.closed;
}

export function steamMembersOf(db: DB, personId: number): string[] {
  return (db.prepare("SELECT ident FROM evader_members WHERE person_id = ? AND kind = 'steam' ORDER BY added_at, ident")
    .all(personId) as { ident: string }[]).map((r) => r.ident);
}

export function membersOf(db: DB, personId: number): { kind: MemberKind; ident: string; addedBy: string; addedAt: string; how: string }[] {
  return db.prepare(
    'SELECT kind, ident, added_by AS addedBy, added_at AS addedAt, how FROM evader_members WHERE person_id = ? ORDER BY kind, added_at',
  ).all(personId) as { kind: MemberKind; ident: string; addedBy: string; addedAt: string; how: string }[];
}

/** The pooled fingerprint no longer describes the person: rebuild it next time. */
export function markPersonStale(db: DB, personId: number): void {
  db.prepare("UPDATE fingerprint_cache SET built_at = '' WHERE subject = ?").run(`person:${personId}`);
}

export type AddResult = 'added' | 'already' | 'other_person' | 'no_person' | 'invalid';

/** Add an account to a person. A Steam account on an open person has every
 *  connection it has used put on the IP watch list, as a flag did. */
export function addMember(
  db: DB, personId: number, kind: MemberKind, ident: string, by: string, how: string, now = new Date(),
): AddResult {
  if (kind === 'steam' ? !/^\d{17}$/.test(ident) : !/^\d{17,20}$/.test(ident)) return 'invalid';
  const person = personById(db, personId);
  if (!person) return 'no_person';
  const existing = personOf(db, kind, ident);
  if (existing) return existing.id === personId ? 'already' : 'other_person';
  const at = now.toISOString();
  db.transaction(() => {
    db.prepare('INSERT INTO evader_members (person_id, kind, ident, added_by, added_at, how) VALUES (?, ?, ?, ?, ?, ?)')
      .run(personId, kind, ident, by, at, how);
    markPersonStale(db, personId);
    if (kind === 'steam' && !person.closedAt) watchAccount(db, ident, by, at);
  })();
  return 'added';
}

/** Take an account off its person, and stop watching what it put on the
 *  list. Addresses added by hand, or by another member, stay. */
export function removeMember(db: DB, kind: MemberKind, ident: string, by: string, now = new Date()): boolean {
  const p = personOf(db, kind, ident);
  if (!p) return false;
  db.transaction(() => {
    db.prepare('DELETE FROM evader_members WHERE kind = ? AND ident = ?').run(kind, ident);
    markPersonStale(db, p.id);
    if (kind === 'steam') unwatchAccount(db, ident, by, now.toISOString());
  })();
  return true;
}

/** No longer watched or matched. Every member's watched addresses go. */
export function closePerson(db: DB, personId: number, by: string, now = new Date()): boolean {
  const at = now.toISOString();
  let closed = false;
  db.transaction(() => {
    closed = db.prepare('UPDATE evader_people SET closed_by = ?, closed_at = ? WHERE id = ? AND closed_at IS NULL')
      .run(by, at, personId).changes > 0;
    if (closed) for (const steamid of steamMembersOf(db, personId)) unwatchAccount(db, steamid, by, at);
  })();
  return closed;
}
```

- [ ] **Step 5: Rewire `src/ipWatch.ts`**

Add the import below the existing ones:

```ts
import { isOpenMember } from './evaderPeople.js';
```

In `ensureIpWatchSchema`, put this comment directly above `CREATE TABLE IF NOT EXISTS evader_flags (`:

```sql
    -- Read-only since person records (src/evaderPeople.ts) took over: kept
    -- for one release so the migration can be checked, then dropped.
```

Replace:

```ts
export function isFlagged(db: DB, steamid: string): boolean {
  return db.prepare('SELECT 1 FROM evader_flags WHERE steamid = ? AND cleared_at IS NULL').get(steamid) !== undefined;
}
```

with:

```ts
/** A Steam member of an open person record (src/evaderPeople.ts). The name
 *  is kept from the evader flags it replaced, so every caller still reads
 *  "is this a known evader's account". */
export function isFlagged(db: DB, steamid: string): boolean {
  return isOpenMember(db, steamid);
}
```

Replace the whole `flagEvader` function and the whole `clearEvader` function (from `/** Flag an account as a ban evader:` down to the end of `clearEvader`) with:

```ts
/** Watch every address this account has used: it has just become a member
 *  of a known evader's record. Later addresses join through checkConnection. */
export function watchAccount(db: DB, steamid: string, by: string, at: string): void {
  for (const { ip_hash } of db.prepare('SELECT ip_hash FROM player_networks WHERE player_id = ?').all(steamid) as { ip_hash: string }[]) {
    watch(db, ip_hash, steamid, '', by, at);
  }
}

/** Stop watching the addresses this account put on the list. Addresses
 *  added by hand, or by another evader's account, stay. */
export function unwatchAccount(db: DB, steamid: string, by: string, at: string): void {
  db.prepare('UPDATE ip_watch SET removed_by = ?, removed_at = ? WHERE steamid = ? AND removed_at IS NULL').run(by, at, steamid);
}
```

Delete the `EvaderFlag` interface and the `evaderFlagOf` function. In `ipWatchView`, change the signature and body so it no longer reads `evader_flags`:

```ts
export function ipWatchView(db: DB, now = new Date()): { entries: WatchEntry[] } {
  const rows = db.prepare(
    `SELECT w.ip_hash AS ipHash, w.note, w.steamid, p.name, w.created_at AS createdAt, c.name AS createdByName
       FROM ip_watch w LEFT JOIN players p ON p.steamid = w.steamid LEFT JOIN players c ON c.steamid = w.created_by
      WHERE w.removed_at IS NULL ORDER BY w.created_at DESC`,
  ).all() as Omit<WatchEntry, 'accounts' | 'country'>[];
  const seen = db.prepare(
    `SELECT n.player_id AS steamid, COALESCE(p.name, n.player_id) AS name, n.last_seen AS lastSeen, n.country
       FROM player_networks n LEFT JOIN players p ON p.steamid = n.player_id
      WHERE n.ip_hash = ? ORDER BY n.last_seen DESC`,
  );
  const entries = rows.map((r) => {
    const accts = seen.all(r.ipHash) as { steamid: string; name: string; lastSeen: string; country: string | null }[];
    return {
      ...r,
      country: accts.find((a) => a.country)?.country ?? null,
      accounts: accts.map((a) => ({
        steamid: a.steamid, name: a.name, lastSeen: a.lastSeen,
        banned: hasActiveBan(db, a.steamid, now), flagged: isFlagged(db, a.steamid),
      })),
    };
  });
  return { entries };
}
```

In `src/db.ts`, add the import next to the ipWatch one:

```ts
import { ensureEvaderSchema } from './evaderPeople.js';
```

and right after `ensureIpWatchSchema(db);` add:

```ts
  // Known evaders as people, their press fingerprints and fingerprint alerts
  // (src/evaderPeople.ts). After the watch list: the first boot migrates the
  // open evader_flags into person records.
  ensureEvaderSchema(db);
```

- [ ] **Step 6: Point the existing watch-list tests at person records**

In `tests/ipWatch.test.ts` replace the import line

```ts
import { checkConnection, clearEvader, flagEvader, ipWatchView, unwatch, watchAddress } from '../src/ipWatch.js';
```

with

```ts
import { checkConnection, ipWatchView, isFlagged, unwatch, watchAddress } from '../src/ipWatch.js';
import { addMember, createPerson, personByLabel, removeMember } from '../src/evaderPeople.js';
```

add this helper after the `connect` helper:

```ts
/** Flag `steamid` the way staff now do: make it a member of the person dethisa. */
function flagEvader(steamid: string) {
  const id = personByLabel(db, 'dethisa')?.id ?? createPerson(db, 'dethisa', '', STAFF);
  addMember(db, id, 'steam', steamid, STAFF, 'manual');
}
```

then make these exact replacements (every occurrence):
- `flagEvader(db, EVADER, 'dethisa', STAFF);` becomes `flagEvader(EVADER);`
- `expect(clearEvader(db, EVADER, STAFF)).toBe(true);` becomes `expect(removeMember(db, 'steam', EVADER, STAFF)).toBe(true);`
- `expect(ipWatchView(db).flags).toEqual([]);` becomes `expect(isFlagged(db, EVADER)).toBe(false);`
- the test title `'clearing a flag stops watching what it added, but not what staff added'` becomes `'removing a member stops watching what it added, but not what staff added'`

These are now the parity tests: every watch-list behaviour that worked on flags works on members.

In `tests/db.test.ts`, in the expected table list, replace `'evader_flags', 'event_campaign_prefs',` with `'evader_flags', 'evader_members', 'evader_people', 'event_campaign_prefs',` and replace `'events', 'fleet_files',` with `'events', 'fingerprint_alerts', 'fingerprint_cache', 'fleet_files',`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/evaderPeople.test.ts tests/ipWatch.test.ts tests/db.test.ts`
Expected: PASS. `npm run typecheck` still FAILS at this point in `src/routes/people.ts` and `src/admin/playerFile.ts`, which import the removed functions. That is expected: Task 6 fixes both and is the next task, so commit now and go straight on.

- [ ] **Step 8: Commit**

```bash
git add src/evaderSeed.ts src/evaderPeople.ts src/ipWatch.ts src/db.ts tests/evaderPeople.test.ts tests/ipWatch.test.ts tests/db.test.ts
git commit -m "Known evaders as person records: migrate evader_flags, isFlagged reads open members" -- src/evaderSeed.ts src/evaderPeople.ts src/ipWatch.ts src/db.ts tests/evaderPeople.test.ts tests/ipWatch.test.ts tests/db.test.ts
```

---

### Task 6: Person routes and the player file

**Files:**
- Modify: `src/routes/people.ts`
- Modify: `src/admin/playerFile.ts`
- Modify: `src/discord/adminFeedPoster.ts` (audit lines in `actionText`)
- Modify: `src/discord/feedRouting.ts` (`MOD_ACTIONS`)
- Test: `tests/evaderRoutes.test.ts`

**Interfaces:**
- Consumes: Task 5 (`createPerson`, `addMember`, `removeMember`, `closePerson`, `personOf`, `openPeople`, `personById`, `EvaderError`).
- Produces HTTP (all behind `makeRequireMod`):
  - `POST /api/admin/people/evaders` `{ label: string, note?: string }` -> `{ ok: true, id }` | 400
  - `POST /api/admin/people/:steamid/evader-person` `{ personId: number } | { label: string }` -> `{ ok: true, personId }` | 400 | 404 | 409
  - `POST /api/admin/people/evaders/:id/members/remove` `{ kind: 'steam' | 'discord', ident: string }` -> `{ ok: true }` | 404
  - `POST /api/admin/people/evaders/:id/close` -> `{ ok: true }` | 404
  - REMOVED: `POST /api/admin/people/:steamid/evader`, `POST /api/admin/people/:steamid/evader/clear`
  - Player file `sections.identity`: `evaderPerson: { id: number; label: string; closed: boolean } | null`, `evaderOptions: { id: number; label: string }[]` (replaces `evaderFlag`)
  - Audit actions: `evader_person_create`, `evader_member_add`, `evader_member_remove`, `evader_person_close`

- [ ] **Step 1: Write the failing tests**

Create `tests/evaderRoutes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { upsertPlayer } from '../src/players.js';
import { personByLabel, personOf } from '../src/evaderPeople.js';
import { fakeDiscordApi } from './fakes/fakeDiscordApi.js';

const EVADER = '76561198000000001';
const PLAYER = '76561198000000004';
const MOD = '76561198000000008';

let db: DB;
let app: FastifyInstance;
let mod: Record<string, string>;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({
    config: loadConfig({
      PUBLIC_URL: 'https://pug.test',
      DISCORD_CLIENT_ID: 'cid', DISCORD_CLIENT_SECRET: 'secret', DISCORD_BOT_TOKEN: 'bot', DISCORD_GUILD_ID: 'guild',
    }),
    db, orchestrator: stubOrchestrator(),
    discordApi: fakeDiscordApi({ users: {}, members: {} }),
    serverExec: async () => {}, serverCleaner: async () => {},
  });
  upsertPlayer(db, { steamid: EVADER, name: 'nepmir', avatar: null }, []);
  mod = authedCookie(app, db, MOD);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
});
afterEach(async () => { await app.close(); });

const post = (url: string, payload: object = {}, cookies = mod) => app.inject({ method: 'POST', url, cookies, payload });

describe('person routes', () => {
  it('a moderator creates a person, once per label', async () => {
    expect((await post('/api/admin/people/evaders', { label: 'dethisa', note: 'five accounts' })).statusCode).toBe(200);
    expect(personByLabel(db, 'dethisa')).not.toBeNull();
    expect((await post('/api/admin/people/evaders', { label: 'dethisa' })).statusCode).toBe(400);
  });

  it('adds an account to an existing person or a new one', async () => {
    const created = (await post('/api/admin/people/evaders', { label: 'dethisa' })).json() as { id: number };
    expect((await post(`/api/admin/people/${EVADER}/evader-person`, { personId: created.id })).statusCode).toBe(200);
    expect(personOf(db, 'steam', EVADER)?.label).toBe('dethisa');
    upsertPlayer(db, { steamid: PLAYER, name: 'other', avatar: null }, []);
    expect((await post(`/api/admin/people/${PLAYER}/evader-person`, { label: 'shove' })).statusCode).toBe(200);
    expect(personOf(db, 'steam', PLAYER)?.label).toBe('shove');
    expect((await post(`/api/admin/people/${PLAYER}/evader-person`, { personId: created.id })).statusCode).toBe(409);
    expect((await post(`/api/admin/people/${PLAYER}/evader-person`, { personId: 999 })).statusCode).toBe(404);
  });

  it('removes a member and closes a person', async () => {
    const { id } = (await post('/api/admin/people/evaders', { label: 'dethisa' })).json() as { id: number };
    await post(`/api/admin/people/${EVADER}/evader-person`, { personId: id });
    expect((await post(`/api/admin/people/evaders/${id}/members/remove`, { kind: 'steam', ident: EVADER })).statusCode).toBe(200);
    expect(personOf(db, 'steam', EVADER)).toBeNull();
    expect((await post(`/api/admin/people/evaders/${id}/members/remove`, { kind: 'steam', ident: EVADER })).statusCode).toBe(404);
    expect((await post(`/api/admin/people/evaders/${id}/close`)).statusCode).toBe(200);
    expect((await post(`/api/admin/people/evaders/${id}/close`)).statusCode).toBe(404);
  });

  it('is staff only, and the old flag routes are gone', async () => {
    const player = authedCookie(app, db, PLAYER);
    expect((await post('/api/admin/people/evaders', { label: 'x' }, player)).statusCode).toBe(403);
    expect((await post(`/api/admin/people/${EVADER}/evader`, { reason: 'x' })).statusCode).toBe(404);
  });

  it('the player file says which person an account belongs to, and offers the open ones', async () => {
    const { id } = (await post('/api/admin/people/evaders', { label: 'dethisa' })).json() as { id: number };
    await post(`/api/admin/people/${EVADER}/evader-person`, { personId: id });
    const file = (await app.inject({ method: 'GET', url: `/api/admin/people/${EVADER}`, cookies: mod })).json() as {
      sections: { identity: { evaderPerson: unknown; evaderOptions: unknown } };
    };
    expect(file.sections.identity.evaderPerson).toEqual({ id, label: 'dethisa', closed: false });
    expect(file.sections.identity.evaderOptions).toEqual([{ id, label: 'dethisa' }]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/evaderRoutes.test.ts`
Expected: FAIL at import time: `src/routes/people.ts` still imports the removed functions ("does not provide an export named 'clearEvader'").

- [ ] **Step 3: Write the implementation**

In `src/routes/people.ts`, replace the import

```ts
import { clearEvader, flagEvader, ipWatchView, unwatch, watchAddress } from '../ipWatch.js';
```

with

```ts
import { ipWatchView, unwatch, watchAddress } from '../ipWatch.js';
import { EvaderError, addMember, closePerson, createPerson, personById, personOf } from '../evaderPeople.js';
```

Replace the two route handlers `app.post('/api/admin/people/:steamid/evader', ...)` and `app.post('/api/admin/people/:steamid/evader/clear', ...)` with:

```ts
  /**
   * Known evaders (src/evaderPeople.ts): one record per person, grouping the
   * accounts they have been caught on. Moderators run it, like the watch list
   * it feeds: a member's connections are watched, and the person's pooled
   * press fingerprint is what new accounts are checked against.
   */
  app.post('/api/admin/people/evaders', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const { label, note } = (req.body ?? {}) as { label?: unknown; note?: unknown };
    if (typeof label !== 'string' || (note !== undefined && typeof note !== 'string')) {
      return reply.code(400).send({ error: 'a person needs a label' });
    }
    try {
      const id = createPerson(db, label, typeof note === 'string' ? note : '', me);
      logAdmin(db, me, 'evader_person_create', '', { personId: id, label: label.trim() });
      return { ok: true, id };
    } catch (err) {
      if (err instanceof EvaderError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/admin/people/:steamid/evader-person', async (req, reply) => {
    const t = onFile(req, reply, 'looked_at');
    if (!t) return reply;
    const { personId, label } = (req.body ?? {}) as { personId?: unknown; label?: unknown };
    let id: number;
    if (typeof personId === 'number' && Number.isInteger(personId)) {
      id = personId;
    } else if (typeof label === 'string') {
      if (personOf(db, 'steam', t.steamid)) return reply.code(409).send({ error: 'that account already belongs to a person' });
      try {
        id = createPerson(db, label, '', t.me);
      } catch (err) {
        if (err instanceof EvaderError) return reply.code(400).send({ error: err.message });
        throw err;
      }
      logAdmin(db, t.me, 'evader_person_create', '', { personId: id, label: label.trim() });
    } else {
      return reply.code(400).send({ error: 'pick a person or name a new one' });
    }
    const r = addMember(db, id, 'steam', t.steamid, t.me, 'manual');
    if (r === 'no_person') return reply.code(404).send({ error: 'no such person' });
    if (r === 'other_person') return reply.code(409).send({ error: 'that account already belongs to another person' });
    if (r === 'invalid') return reply.code(400).send({ error: 'not a Steam account' });
    if (r === 'added') logAdmin(db, t.me, 'evader_member_add', t.steamid, { personId: id, label: personById(db, id)?.label });
    return { ok: true, personId: id };
  });

  app.post('/api/admin/people/evaders/:id/members/remove', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const id = Number((req.params as { id: string }).id);
    const { kind, ident } = (req.body ?? {}) as { kind?: unknown; ident?: unknown };
    if ((kind !== 'steam' && kind !== 'discord') || typeof ident !== 'string') {
      return reply.code(400).send({ error: 'name the account to remove' });
    }
    if (personOf(db, kind, ident)?.id !== id) return reply.code(404).send({ error: 'that account is not on this person' });
    removeMember(db, kind, ident, me);
    logAdmin(db, me, 'evader_member_remove', kind === 'steam' ? ident : '', { personId: id, kind });
    return { ok: true };
  });

  app.post('/api/admin/people/evaders/:id/close', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const id = Number((req.params as { id: string }).id);
    if (!closePerson(db, id, me)) return reply.code(404).send({ error: 'no open person with that id' });
    logAdmin(db, me, 'evader_person_close', '', { personId: id, label: personById(db, id)?.label });
    return { ok: true };
  });
```

and add `removeMember` to the evaderPeople import (`import { EvaderError, addMember, closePerson, createPerson, personById, personOf, removeMember } from '../evaderPeople.js';`).

Route order matters in Fastify only for identical shapes; `/api/admin/people/evaders` (static) wins over `/api/admin/people/:steamid` (param) by Fastify's router, so no reordering is needed.

In `src/admin/playerFile.ts`, replace

```ts
import { evaderFlagOf } from '../ipWatch.js';
```

with

```ts
import { openPeople, personOf } from '../evaderPeople.js';
```

and replace

```ts
    // Flagged as a ban evader: their connections are on the IP watch list.
    evaderFlag: evaderFlagOf(db, steamid),
```

with

```ts
    // A known evader's account (src/evaderPeople.ts): its connections are on
    // the IP watch list. The open people are what "Add to person" offers.
    evaderPerson: personOf(db, 'steam', steamid),
    evaderOptions: openPeople(db).map((p) => ({ id: p.id, label: p.label })),
```

In `src/discord/adminFeedPoster.ts` `actionText`, after the `case 'evader_clear':` line add:

```ts
      case 'evader_person_create': return `${who} recorded a known evader: **${escapeName(String(d.label ?? ''))}**`;
      case 'evader_member_add': return `${who} added ${target} to known evader **${escapeName(String(d.label ?? ''))}**`;
      case 'evader_member_remove': return `${who} removed ${d.kind === 'steam' ? target : 'a Discord account'} from a known evader`;
      case 'evader_person_close': return `${who} closed the known evader record **${escapeName(String(d.label ?? ''))}**`;
```

In `src/discord/feedRouting.ts` `MOD_ACTIONS`, after `'evader_flag', 'evader_clear',` add `'evader_person_create', 'evader_member_add', 'evader_member_remove', 'evader_person_close', 'evader_ban_same',` (the last is used by Task 13).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/evaderRoutes.test.ts tests/ipWatch.test.ts tests/feedRouting.test.ts && npm run typecheck`
Expected: PASS, and typecheck clean for the server project. The web project may still compile because `web/src/api.ts` keeps its own `EvaderFlag` type until Task 14.

- [ ] **Step 5: Commit**

```bash
git add src/routes/people.ts src/admin/playerFile.ts src/discord/adminFeedPoster.ts src/discord/feedRouting.ts tests/evaderRoutes.test.ts
git commit -m "People routes: create a known evader, add or remove accounts, close; file shows the person" -- src/routes/people.ts src/admin/playerFile.ts src/discord/adminFeedPoster.ts src/discord/feedRouting.ts tests/evaderRoutes.test.ts
```

---

### Task 7: Fingerprints from input_bursts and the cache

**Files:**
- Create: `src/fingerprintData.ts`
- Test: `tests/fingerprintData.test.ts`

**Interfaces:**
- Consumes: Task 1 (`fingerprintOf`, `holdTotal`, `pooled`, `personThreshold`, constants, types); Task 5 (`openPeople`, `steamMembersOf`, `fingerprint_cache`).
- Produces (`src/fingerprintData.ts`):
  - `BASE_BURST_SQL: string` (a WHERE fragment over `input_bursts` columns, no parameters)
  - `playerFingerprint(db, steamid): Fingerprint` (whole history)
  - `memberMatchFingerprints(db, steamids: readonly string[]): Fingerprint[]` (one per account per match)
  - `interface FingerprintWorld { field: FieldEntry[]; persons: PersonModel[]; rebuilt: number }`
  - `fingerprintWorld(db, now?): FingerprintWorld`: refreshes stale `fingerprint_cache` rows; `field` = every player with >= 150 base holds plus every open person's pooled fingerprint; `persons` = open persons with pooled fingerprint and threshold.
  - `cachedPopulation(db): Fingerprint` (all cached player fingerprints pooled, for the UI's population medians; reads the cache only)

- [ ] **Step 1: Write the failing tests**

Create `tests/fingerprintData.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { holdTotal } from '../src/fingerprint.js';
import { cachedPopulation, fingerprintWorld, memberMatchFingerprints, playerFingerprint } from '../src/fingerprintData.js';
import { addMember, createPerson } from '../src/evaderPeople.js';
import { encodeIntervals } from '../src/inputStats.js';
import { endedMatch, playMatch } from './fingerprintFixtures.js';

const A = '76561198000000001';
const B = '76561198000000002';
const C = '76561198000000003';
const D = '76561198000000004';
const STAFF = '76561198000000009';
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [1, 2, 3]) endedMatch(db, id);
});

describe('playerFingerprint', () => {
  it('reads base-class holds only', () => {
    playMatch(db, A, 1, 10, 80);
    db.prepare(
      `INSERT INTO input_bursts (match_id, server_id, steamid, kind, weapon, n, ground_ticks, air_presses, server_tick, client_tick, intervals, at, wire, holds)
       VALUES (1, 1, ?, 'fire', 'weapon_pistol', 1, 0, 0, 1, 1, '7', '2026-10-17T19:00:00.000Z', 2, ?)`,
    ).run(A, encodeIntervals([8, 8]));
    db.prepare(
      `INSERT INTO input_bursts (match_id, server_id, steamid, kind, weapon, n, ground_ticks, air_presses, server_tick, client_tick, intervals, at, wire, holds)
       VALUES (1, 1, ?, 'fire', 'weapon_hunter_claw', 1, 0, 0, 1, 1, '7', '2026-10-17T19:00:00.000Z', 1, NULL)`,
    ).run(A);
    expect(holdTotal(playerFingerprint(db, A))).toBe(160);
  });

  it('splits a member\'s history per match', () => {
    playMatch(db, A, 1, 10, 60);
    playMatch(db, A, 2, 10, 60);
    playMatch(db, B, 2, 12, 60);
    expect(memberMatchFingerprints(db, [A]).map(holdTotal)).toEqual([120, 120]);
    expect(memberMatchFingerprints(db, [A, B])).toHaveLength(3);
    expect(memberMatchFingerprints(db, [])).toEqual([]);
  });
});

describe('fingerprintWorld', () => {
  it('builds every player once, then only who played since', () => {
    for (const [id, peak] of [[A, 10], [B, 14], [C, 6]] as const) playMatch(db, id, 1, peak, 80, '2026-10-17T10:00:00.000Z');
    expect(fingerprintWorld(db, new Date('2026-10-17T11:00:00Z')).rebuilt).toBe(3);
    expect(fingerprintWorld(db, new Date('2026-10-17T11:05:00Z')).rebuilt).toBe(0);
    playMatch(db, B, 2, 14, 80, '2026-10-17T12:00:00.000Z');
    expect(fingerprintWorld(db, new Date('2026-10-17T12:30:00Z')).rebuilt).toBe(1);
  });

  it('puts only players with 150 base holds in the field', () => {
    playMatch(db, A, 1, 10, 80); // 160
    playMatch(db, D, 1, 10, 70); // 140
    const { field } = fingerprintWorld(db, new Date('2026-10-17T21:00:00Z'));
    expect(field.map((e) => e.subject)).toEqual([`steam:${A}`]);
  });

  it('pools an open person from their members and rebuilds it when membership changes', () => {
    playMatch(db, A, 1, 10, 80);
    playMatch(db, B, 1, 10, 80);
    const id = createPerson(db, 'dethisa', '', STAFF);
    addMember(db, id, 'steam', A, STAFF, 'manual');
    let w = fingerprintWorld(db, new Date('2026-10-17T21:00:00Z'));
    expect(holdTotal(w.persons[0].pooled)).toBe(160);
    expect(w.field.map((e) => e.subject)).toContain(`person:${id}`);
    addMember(db, id, 'steam', B, STAFF, 'manual');
    w = fingerprintWorld(db, new Date('2026-10-17T21:01:00Z'));
    expect(w.rebuilt).toBe(1);
    expect(holdTotal(w.persons[0].pooled)).toBe(320);
  });

  it('gives a person their own threshold from three member-matches', () => {
    for (const m of [1, 2, 3]) playMatch(db, A, m, 10, 60);
    const id = createPerson(db, 'dethisa', '', STAFF);
    addMember(db, id, 'steam', A, STAFF, 'manual');
    expect(fingerprintWorld(db).persons[0].threshold).toBe(0);
  });

  it('a person with no data is in persons with an empty pool, and the population reads the cache', () => {
    createPerson(db, 'empty', '', STAFF);
    playMatch(db, A, 1, 10, 80);
    const w = fingerprintWorld(db);
    expect(holdTotal(w.persons[0].pooled)).toBe(0);
    expect(holdTotal(cachedPopulation(db))).toBe(160);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/fingerprintData.test.ts`
Expected: FAIL, cannot resolve `../src/fingerprintData.js`.

- [ ] **Step 3: Write the implementation**

Create `src/fingerprintData.ts`:

```ts
import type { DB } from './db.js';
import {
  BASE_KINDS, BASE_WEAPON_NAMES, MIN_CANDIDATE_HOLDS, fingerprintOf, holdTotal, personThreshold, pooled,
  type BurstHoldRow, type FieldEntry, type Fingerprint, type PersonModel,
} from './fingerprint.js';
import { openPeople, steamMembersOf } from './evaderPeople.js';

/**
 * Fingerprints read from input_bursts, and the cache that keeps the check
 * cheap.
 *
 * Ranking a candidate needs every fingerprinted player's whole history. Built
 * from scratch that is every infected burst on record, every match. So each
 * player's histogram (and each person's pooled one) is cached in
 * fingerprint_cache and rebuilt only when that player has a burst newer than
 * the row (or, for a person, when a member played or the membership changed,
 * which blanks built_at). The first check after the setting is turned on
 * builds everyone; every check after that rebuilds the handful who played.
 */

/** The base classes, as a WHERE fragment. Literal constants, no parameters. */
export const BASE_BURST_SQL = `holds IS NOT NULL
  AND kind IN (${BASE_KINDS.map((k) => `'${k}'`).join(', ')})
  AND weapon IN (${BASE_WEAPON_NAMES.map((w) => `'${w}'`).join(', ')})`;

export function playerFingerprint(db: DB, steamid: string): Fingerprint {
  return fingerprintOf(
    db.prepare(`SELECT kind, weapon, holds FROM input_bursts WHERE steamid = ? AND ${BASE_BURST_SQL}`)
      .iterate(steamid) as IterableIterator<BurstHoldRow>,
  );
}

/** One fingerprint per (account, match), for a person's own threshold. */
export function memberMatchFingerprints(db: DB, steamids: readonly string[]): Fingerprint[] {
  if (steamids.length === 0) return [];
  const rows = db.prepare(
    `SELECT steamid, match_id AS matchId, kind, weapon, holds FROM input_bursts
      WHERE match_id IS NOT NULL AND steamid IN (${steamids.map(() => '?').join(', ')}) AND ${BASE_BURST_SQL}
      ORDER BY steamid, match_id`,
  ).all(...steamids) as (BurstHoldRow & { steamid: string; matchId: number })[];
  const groups = new Map<string, BurstHoldRow[]>();
  for (const r of rows) {
    const key = `${r.steamid}/${r.matchId}`;
    const g = groups.get(key);
    if (g) g.push(r); else groups.set(key, [r]);
  }
  return [...groups.values()].map((g) => fingerprintOf(g));
}

interface CacheRow { subject: string; classes_json: string; holds: number; built_at: string }

export interface FingerprintWorld {
  /** Every fingerprinted player and every open person's pool. */
  field: FieldEntry[];
  persons: PersonModel[];
  /** Cache rows rebuilt by this call. */
  rebuilt: number;
}

export function fingerprintWorld(db: DB, now = new Date()): FingerprintWorld {
  const at = now.toISOString();
  const last = new Map(
    (db.prepare(`SELECT steamid, MAX(at) AS last FROM input_bursts WHERE ${BASE_BURST_SQL} GROUP BY steamid`)
      .all() as { steamid: string; last: string }[]).map((r) => [r.steamid, r.last]),
  );
  const cache = new Map(
    (db.prepare('SELECT subject, classes_json, holds, built_at FROM fingerprint_cache').all() as CacheRow[])
      .map((r) => [r.subject, r]),
  );
  const write = db.prepare(
    `INSERT INTO fingerprint_cache (subject, classes_json, holds, built_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(subject) DO UPDATE SET classes_json = excluded.classes_json, holds = excluded.holds,
       built_at = excluded.built_at`,
  );
  let rebuilt = 0;
  const store = (subject: string, fp: Fingerprint): void => {
    const row = { subject, classes_json: JSON.stringify(fp), holds: holdTotal(fp), built_at: at };
    write.run(row.subject, row.classes_json, row.holds, row.built_at);
    cache.set(subject, row);
    rebuilt += 1;
  };
  const fpOf = (subject: string): Fingerprint => JSON.parse(cache.get(subject)?.classes_json ?? '{}') as Fingerprint;
  const people = openPeople(db).map((p) => ({ id: p.id, label: p.label, members: steamMembersOf(db, p.id) }));

  db.transaction(() => {
    for (const [steamid, played] of last) {
      const c = cache.get(`steam:${steamid}`);
      if (!c || c.built_at < played) store(`steam:${steamid}`, playerFingerprint(db, steamid));
    }
    for (const p of people) {
      const subject = `person:${p.id}`;
      const c = cache.get(subject);
      const played = p.members.map((m) => last.get(m) ?? '').sort().pop() ?? '';
      if (!c || c.built_at === '' || c.built_at < played) store(subject, pooled(p.members.map((m) => fpOf(`steam:${m}`))));
    }
  })();

  const field: FieldEntry[] = [];
  for (const steamid of last.keys()) {
    const row = cache.get(`steam:${steamid}`);
    if (row && row.holds >= MIN_CANDIDATE_HOLDS) field.push({ subject: `steam:${steamid}`, fp: JSON.parse(row.classes_json) as Fingerprint });
  }
  const persons: PersonModel[] = people.map((p) => ({
    id: p.id, label: p.label, members: p.members,
    pooled: fpOf(`person:${p.id}`),
    threshold: personThreshold(memberMatchFingerprints(db, p.members)),
  }));
  for (const p of persons) field.push({ subject: `person:${p.id}`, fp: p.pooled });
  return { field, persons, rebuilt };
}

/** Every cached player fingerprint pooled, for "how does everyone hold".
 *  Reads the cache only: a page view must never trigger a rebuild. */
export function cachedPopulation(db: DB): Fingerprint {
  return pooled(
    (db.prepare("SELECT classes_json FROM fingerprint_cache WHERE subject LIKE 'steam:%'").all() as { classes_json: string }[])
      .map((r) => JSON.parse(r.classes_json) as Fingerprint),
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/fingerprintData.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fingerprintData.ts tests/fingerprintData.test.ts
git commit -m "Fingerprint data: per-player and per-person fingerprints from input_bursts, cached" -- src/fingerprintData.ts tests/fingerprintData.test.ts
```

---

### Task 8: Fingerprint alt holds

**Files:**
- Modify: `src/db.ts` (after `db.exec('CREATE INDEX IF NOT EXISTS idx_alt_holds_steamid ON alt_holds (steamid)');`)
- Modify: `src/altHolds.ts`
- Test: `tests/fingerprintHolds.test.ts`

**Interfaces:**
- Consumes: Task 5 (`evader_people`, `fingerprint_alerts`); `insertBan`, `publishBanChange` (existing).
- Produces:
  - Columns `alt_holds.source TEXT NOT NULL DEFAULT 'discord' CHECK (source IN ('discord','fingerprint'))`, `alt_holds.person_id INTEGER`
  - `FINGERPRINT_HOLD_REASON: string`
  - `type FingerprintHoldResult = { id: number } | { refused: 'cleared' | 'open_hold' | 'staff' | 'unknown' }`
  - `placeFingerprintHold(db, steamid, personId, otherSteamid, now?): FingerprintHoldResult`
  - `AltHoldRow` gains `source: 'discord' | 'fingerprint'`, `personId: number | null`, `personLabel: string | null`, `fingerprint: { distance: number; rank: number; threshold: number; signs: string[] } | null`
  - `holdById` result gains `source` and `personId`
  - `placeAltHold`'s cleared suppression now reads only Discord holds (`source = 'discord'`)

- [ ] **Step 1: Write the failing tests**

Create `tests/fingerprintHolds.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { linkDiscord } from '../src/players.js';
import { hasActiveBan } from '../src/banState.js';
import { altHolds, holdById, liftAltHold, placeAltHold, placeFingerprintHold } from '../src/altHolds.js';
import { addMember, createPerson } from '../src/evaderPeople.js';
import { fileViewer } from '../src/admin/fileAccess.js';
import { player } from './fingerprintFixtures.js';

const OLD = '76561198000000001';
const NEW = '76561198000000002';
const ADMIN = '76561198000000009';
let db: DB;
let personId: number;

beforeEach(() => {
  db = openDb(':memory:');
  for (const [id, name] of [[OLD, 'nepmir'], [NEW, 'fresh'], [ADMIN, 'admin']]) player(db, id, name);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  personId = createPerson(db, 'dethisa', '', ADMIN);
  addMember(db, personId, 'steam', OLD, ADMIN, 'seed');
});

const idOf = (r: ReturnType<typeof placeFingerprintHold>): number => {
  if (!('id' in r)) throw new Error(`refused: ${r.refused}`);
  return r.id;
};

describe('fingerprint holds', () => {
  it('blocks like a ban, as an alt hold', () => {
    const id = idOf(placeFingerprintHold(db, NEW, personId, OLD));
    expect(hasActiveBan(db, NEW)).toBe(true);
    const ban = db.prepare('SELECT kind FROM bans WHERE player_id = ?').get(NEW) as { kind: string };
    expect(ban.kind).toBe('alt_hold');
    expect(holdById(db, id)).toMatchObject({ source: 'fingerprint', personId });
  });

  it('lists with the person and the numbers behind it', () => {
    idOf(placeFingerprintHold(db, NEW, personId, OLD));
    db.prepare(
      `INSERT INTO fingerprint_alerts (steamid, person_id, level, distance, threshold, rank, signs_json, created_at)
       VALUES (?, ?, 'hold', 0.203, 0.25, 2, '["vpn"]', '2026-10-17T00:00:00.000Z')`,
    ).run(NEW, personId);
    const [h] = altHolds(db, fileViewer(db, ADMIN)).open;
    expect(h).toMatchObject({
      source: 'fingerprint', personId, personLabel: 'dethisa', otherSteamid: OLD,
      fingerprint: { distance: 0.203, threshold: 0.25, rank: 2, signs: ['vpn'] },
    });
  });

  it('takes the candidate\'s Discord when one is linked', () => {
    linkDiscord(db, NEW, '777000000000000001', 'newd');
    const id = idOf(placeFingerprintHold(db, NEW, personId, OLD));
    const row = db.prepare('SELECT discord_id, discord_name FROM alt_holds WHERE id = ?').get(id);
    expect(row).toEqual({ discord_id: '777000000000000001', discord_name: 'newd' });
  });

  it('a cleared pair is never held again, for that person only', () => {
    const id = idOf(placeFingerprintHold(db, NEW, personId, OLD));
    liftAltHold(db, id, ADMIN);
    expect(placeFingerprintHold(db, NEW, personId, OLD)).toEqual({ refused: 'cleared' });
    const other = createPerson(db, 'shove', '', ADMIN);
    expect('id' in placeFingerprintHold(db, NEW, other, OLD)).toBe(true);
  });

  it('a cleared Discord pair does not stop a fingerprint hold, nor the other way round', () => {
    const d = placeAltHold(db, NEW, OLD, '111', 'dethisa')!;
    liftAltHold(db, d, ADMIN);
    const f = idOf(placeFingerprintHold(db, NEW, personId, OLD));
    liftAltHold(db, f, ADMIN);
    expect(placeAltHold(db, NEW, OLD, '111', 'dethisa')).toBeNull(); // the Discord pair's own clear
    const db2 = openDb(':memory:');
    for (const [id, name] of [[OLD, 'nepmir'], [NEW, 'fresh'], [ADMIN, 'admin']]) player(db2, id, name);
    const p2 = createPerson(db2, 'dethisa', '', ADMIN);
    const f2 = placeFingerprintHold(db2, NEW, p2, OLD);
    liftAltHold(db2, (f2 as { id: number }).id, ADMIN);
    expect(placeAltHold(db2, NEW, OLD, '111', 'dethisa')).not.toBeNull();
  });

  it('refuses an account already on hold, staff, and an account the site has never seen', () => {
    placeAltHold(db, NEW, OLD, '111', 'dethisa');
    expect(placeFingerprintHold(db, NEW, personId, OLD)).toEqual({ refused: 'open_hold' });
    expect(placeFingerprintHold(db, ADMIN, personId, OLD)).toEqual({ refused: 'staff' });
    expect(placeFingerprintHold(db, '76561198000000077', personId, OLD)).toEqual({ refused: 'unknown' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/fingerprintHolds.test.ts`
Expected: FAIL, `placeFingerprintHold` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/db.ts`, after `db.exec('CREATE INDEX IF NOT EXISTS idx_alt_holds_steamid ON alt_holds (steamid)');` add:

```ts
  // Where a hold came from: a Discord account moving ('discord'), or a new
  // account's press fingerprint matching a known evader plus a second sign
  // ('fingerprint', src/fingerprintCheck.ts). A cleared pair is suppressed
  // per source: lifting a Discord hold says nothing about a fingerprint.
  ensureColumn(db, 'alt_holds', 'source', "TEXT NOT NULL DEFAULT 'discord' CHECK (source IN ('discord', 'fingerprint'))");
  ensureColumn(db, 'alt_holds', 'person_id', 'INTEGER');
```

`ensureEvaderSchema` runs later in `openDb` than this line; that is fine because nothing here references `evader_people`.

In `src/altHolds.ts`:

1. In `placeAltHold`, change the cleared query to

```ts
  const cleared = db.prepare(
    "SELECT 1 FROM alt_holds WHERE steamid = ? AND other_steamid = ? AND source = 'discord' AND resolution = 'cleared'",
  ).get(steamid, otherSteamid);
```

2. After `placeAltHold`, add:

```ts
/** Shown to the held player. Deliberately says nothing about how: telling an
 *  evader which signal caught them is telling them what to change. */
export const FINGERPRINT_HOLD_REASON = 'On hold for review: a moderator needs to check this account before it can play';

export type FingerprintHoldResult = { id: number } | { refused: 'cleared' | 'open_hold' | 'staff' | 'unknown' };

/**
 * Hold `steamid` because its press fingerprint matches person `personId`
 * and a second sign fired (src/fingerprintCheck.ts). `otherSteamid` is the
 * person's nearest member account, which the Alts list shows as "plays like".
 * The bans row and the release path are exactly those of a Discord hold.
 *
 * Refused when staff cleared this (account, person) pair before, when a hold
 * is already open on the account, for staff, and for an account with no
 * players row (a bans row needs one). The caller tells the mods either way.
 */
export function placeFingerprintHold(
  db: DB, steamid: string, personId: number, otherSteamid: string, now = new Date(),
): FingerprintHoldResult {
  const cleared = db.prepare(
    "SELECT 1 FROM alt_holds WHERE steamid = ? AND person_id = ? AND source = 'fingerprint' AND resolution = 'cleared'",
  ).get(steamid, personId);
  if (cleared) return { refused: 'cleared' };
  if (openHoldOf(db, steamid)) return { refused: 'open_hold' };
  const p = getPlayer(db, steamid);
  if (!p) return { refused: 'unknown' };
  if (p.is_admin === 1 || p.is_mod === 1) return { refused: 'staff' };
  let id = 0;
  db.transaction(() => {
    const banId = insertBan(db, steamid, 'system', FINGERPRINT_HOLD_REASON, null, now, 'alt_hold');
    id = Number(db.prepare(
      `INSERT INTO alt_holds (steamid, other_steamid, discord_id, discord_name, ban_id, created_at, source, person_id)
       VALUES (?, ?, ?, ?, ?, ?, 'fingerprint', ?)`,
    ).run(steamid, otherSteamid, p.discord_id ?? '', p.discord_name ?? '', banId, now.toISOString(), personId).lastInsertRowid);
  })();
  publishBanChange({ kind: 'ban', steamid, reason: FINGERPRINT_HOLD_REASON });
  return { id };
}
```

3. Extend `AltHoldRow` (add after `resolution`):

```ts
  /** 'fingerprint': placed by the evader fingerprint check, not a Discord move. */
  source: 'discord' | 'fingerprint';
  personId: number | null;
  personLabel: string | null;
  /** The numbers behind a fingerprint hold, from fingerprint_alerts. */
  fingerprint: { distance: number; rank: number; threshold: number; signs: string[] } | null;
```

4. Replace `holdById` with:

```ts
export function holdById(db: DB, id: number): {
  id: number; steamid: string; otherSteamid: string; banId: number; resolvedAt: string | null;
  source: 'discord' | 'fingerprint'; personId: number | null;
} | null {
  const r = db.prepare('SELECT id, steamid, other_steamid, ban_id, resolved_at, source, person_id FROM alt_holds WHERE id = ?').get(id) as
    | { id: number; steamid: string; other_steamid: string; ban_id: number; resolved_at: string | null; source: 'discord' | 'fingerprint'; person_id: number | null }
    | undefined;
  return r ? {
    id: r.id, steamid: r.steamid, otherSteamid: r.other_steamid, banId: r.ban_id, resolvedAt: r.resolved_at,
    source: r.source, personId: r.person_id,
  } : null;
}
```

5. Replace `HOLD_SELECT`, `HoldDbRow` and `toHold` with:

```ts
const HOLD_SELECT = `SELECT h.*, p.name AS name, o.name AS other_name, r.name AS resolved_by_name,
    ep.label AS person_label, fa.distance AS fp_distance, fa.rank AS fp_rank, fa.threshold AS fp_threshold,
    fa.signs_json AS fp_signs
  FROM alt_holds h
  LEFT JOIN players p ON p.steamid = h.steamid
  LEFT JOIN players o ON o.steamid = h.other_steamid
  LEFT JOIN players r ON r.steamid = h.resolved_by
  LEFT JOIN evader_people ep ON ep.id = h.person_id
  LEFT JOIN fingerprint_alerts fa ON fa.steamid = h.steamid AND fa.person_id = h.person_id AND fa.level = 'hold'`;

interface HoldDbRow {
  id: number; steamid: string; other_steamid: string; discord_id: string; discord_name: string;
  created_at: string; resolved_at: string | null; resolved_by: string | null; resolution: AltHoldRow['resolution'];
  name: string | null; other_name: string | null; resolved_by_name: string | null;
  source: 'discord' | 'fingerprint'; person_id: number | null; person_label: string | null;
  fp_distance: number | null; fp_rank: number | null; fp_threshold: number | null; fp_signs: string | null;
}

function signsOf(json: string | null): string[] {
  try {
    const v: unknown = JSON.parse(json ?? '[]');
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function toHold(db: DB, r: HoldDbRow, now: Date): AltHoldRow {
  return {
    id: r.id, steamid: r.steamid, name: r.name ?? r.steamid,
    otherSteamid: r.other_steamid, otherName: r.other_name ?? r.other_steamid,
    otherBanned: hasActiveBan(db, r.other_steamid, now),
    discordId: r.discord_id, discordName: r.discord_name,
    createdAt: r.created_at, resolvedAt: r.resolved_at,
    resolvedByName: r.resolved_by === 'system' ? 'system' : r.resolved_by_name, resolution: r.resolution,
    source: r.source, personId: r.person_id, personLabel: r.person_label,
    fingerprint: r.fp_distance === null || r.fp_rank === null || r.fp_threshold === null ? null
      : { distance: r.fp_distance, rank: r.fp_rank, threshold: r.fp_threshold, signs: signsOf(r.fp_signs) },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/fingerprintHolds.test.ts tests/altHolds.test.ts`
Expected: PASS (the existing Discord-hold tests are unchanged in behaviour).

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/altHolds.ts tests/fingerprintHolds.test.ts
git commit -m "Alt holds: a fingerprint source, cleared pairs suppressed per source, numbers on the row" -- src/db.ts src/altHolds.ts tests/fingerprintHolds.test.ts
```

---
### Task 9: Who is checked, and the second signs

**Files:**
- Create: `src/fingerprintSigns.ts`
- Test: `tests/fingerprintSigns.test.ts`

**Interfaces:**
- Consumes: Task 1 (`SecondSign`, `SIGN_ORDER`); Task 3 (`isVpnNetwork`); Task 5 (`personOf`); `resolveAlias`, `completedPug` (existing, `src/matchKinds.ts`; `tests/matchKindGuard.test.ts` fails the build on a raw `state = 'completed'` filter).
- Produces (`src/fingerprintSigns.ts`):
  - constants `NEW_RATED_MATCHES = 15`, `NEW_SITE_ACCOUNT_MS` (30 days), `YOUNG_STEAM_MS` (365 days), `YOUNG_DISCORD_MS` (90 days), `YOUNG_SITE_MS` (7 days), `CHEAT_FLAG_KINDS`
  - `dbTimeMs(s: string | null): number | null` (reads both `YYYY-MM-DD HH:MM:SS` and ISO), `sqlTime(at: Date): string`
  - `discordCreatedMs(id: string): number | null`
  - `activeBanAt(db, steamid, at: Date): boolean`, `ratedMatchesAt(db, steamid, at: Date): number`, `isNewAccount(db, steamid, at: Date): boolean`
  - `candidatesOf(db, matchId, at: Date): string[]`
  - `interface SignContext { members: readonly string[]; membersInTop10: number; asnLoaded: boolean; extraVpn: ReadonlySet<number> }`
  - `secondSigns(db, steamid, ctx: SignContext, at: Date): SecondSign[]` (in `SIGN_ORDER`)

Every check takes `at`, so the history replay (Task 18) asks "as of that match end" with the same code the live check uses with `now`.

- [ ] **Step 1: Write the failing tests**

Create `tests/fingerprintSigns.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { linkDiscord } from '../src/players.js';
import { recordPlayerNet } from '../src/playerNetworks.js';
import { addAlias } from '../src/aliases.js';
import { addMember, createPerson } from '../src/evaderPeople.js';
import type { AsnLookup } from '../src/asnTable.js';
import {
  activeBanAt, candidatesOf, dbTimeMs, discordCreatedMs, isNewAccount, ratedMatchesAt, secondSigns, type SignContext,
} from '../src/fingerprintSigns.js';
import { endedMatch, playMatch, player } from './fingerprintFixtures.js';

const MEMBER = '76561198000000001';
const CAND = '76561198000000002';
const OTHER = '76561198000000003';
const STAFF = '76561198000000009';
const AT = new Date('2026-10-17T21:00:00Z');
const DAY = 86_400_000;
let db: DB;

const ctx = (over: Partial<SignContext> = {}): SignContext =>
  ({ members: [MEMBER], membersInTop10: 0, asnLoaded: true, extraVpn: new Set(), ...over });
const net = (asn: number, org: string): AsnLookup => ({ lookup: () => ({ asn, org }) });
const snowflakeAt = (ms: number): string => ((BigInt(ms) - 1420070400000n) << 22n).toString();
const sqliteTime = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [MEMBER, CAND, OTHER, STAFF]) player(db, id);
});

describe('time helpers', () => {
  it('reads both column formats', () => {
    expect(dbTimeMs('2026-10-17 20:00:00')).toBe(Date.parse('2026-10-17T20:00:00Z'));
    expect(dbTimeMs('2026-10-17T20:00:00.000Z')).toBe(Date.parse('2026-10-17T20:00:00Z'));
    expect(dbTimeMs(null)).toBeNull();
  });

  it('dates a Discord account from its id', () => {
    // Discord's own documented example.
    expect(discordCreatedMs('175928847299117063')).toBe(1462015105796);
    expect(discordCreatedMs('nope')).toBeNull();
  });
});

describe('who is new', () => {
  it('counts completed, rated, unvoided PUGs that ended by then', () => {
    endedMatch(db, 1, '2026-10-17 10:00:00');
    endedMatch(db, 2, '2026-10-17 11:00:00');
    endedMatch(db, 3, '2026-10-17 12:00:00');
    endedMatch(db, 4, '2026-10-17 22:00:00');
    endedMatch(db, 5, '2026-10-17 14:00:00');
    db.prepare("UPDATE matches SET voided_at = '2026-10-17 13:00:00' WHERE id = 3").run();
    db.prepare("UPDATE matches SET kind = 'scrim' WHERE id = 5").run();
    const ins = db.prepare("INSERT INTO match_players (match_id, player_id, team, rated) VALUES (?, ?, 'a', ?)");
    ins.run(1, CAND, 1); ins.run(2, CAND, 0); ins.run(3, CAND, 1); ins.run(4, CAND, 1); ins.run(5, CAND, 1);
    expect(ratedMatchesAt(db, CAND, AT)).toBe(1);
  });

  it('is new under 15 rated matches or under 30 days on the site', () => {
    for (let i = 0; i < 15; i++) {
      endedMatch(db, 100 + i, '2026-10-01 20:00:00');
      db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, 'a')").run(100 + i, CAND);
    }
    db.prepare('UPDATE players SET created_at = ? WHERE steamid = ?').run(sqliteTime(AT.getTime() - 60 * DAY), CAND);
    expect(isNewAccount(db, CAND, AT)).toBe(false);
    db.prepare('DELETE FROM match_players WHERE match_id = 114').run();
    expect(isNewAccount(db, CAND, AT)).toBe(true);
    db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (114, ?, 'a')").run(CAND);
    db.prepare('UPDATE players SET created_at = ? WHERE steamid = ?').run(sqliteTime(AT.getTime() - 10 * DAY), CAND);
    expect(isNewAccount(db, CAND, AT)).toBe(true);
  });

  it('reads a ban as of a moment, not as of now', () => {
    const ban = db.prepare(
      "INSERT INTO bans (player_id, reason, created_by, created_at, expires_at, lifted_by, lifted_at, kind) VALUES (?, 'x', ?, ?, ?, ?, ?, 'ban')",
    );
    ban.run(CAND, STAFF, '2026-10-18T00:00:00.000Z', null, null, null); // after AT
    expect(activeBanAt(db, CAND, AT)).toBe(false);
    ban.run(CAND, STAFF, '2026-10-16T00:00:00.000Z', null, STAFF, '2026-10-17T22:00:00.000Z'); // lifted later
    expect(activeBanAt(db, CAND, AT)).toBe(true);
    ban.run(OTHER, STAFF, '2026-10-10T00:00:00.000Z', '2026-10-11T00:00:00.000Z', null, null); // expired
    expect(activeBanAt(db, OTHER, AT)).toBe(false);
  });

  it('checks the new, unbanned players of the match who belong to no person', () => {
    endedMatch(db, 900);
    const ALIASED = '76561198000000004';
    const BANNED = '76561198000000005';
    for (const id of [ALIASED, BANNED]) player(db, id);
    for (const id of [MEMBER, CAND, ALIASED, BANNED]) playMatch(db, id, 900, 10, 20);
    const p = createPerson(db, 'dethisa', '', STAFF);
    addMember(db, p, 'steam', MEMBER, STAFF, 'seed');
    addAlias(db, { steamid: ALIASED, canonical: MEMBER, by: STAFF });
    db.prepare("INSERT INTO bans (player_id, reason, created_by, created_at, kind) VALUES (?, 'x', ?, '2026-10-01T00:00:00.000Z', 'ban')").run(BANNED, STAFF);
    expect(candidatesOf(db, 900, AT)).toEqual([CAND]);
  });
});

describe('second signs', () => {
  it('nothing on a plain account', () => {
    expect(secondSigns(db, CAND, ctx(), AT)).toEqual([]);
  });

  it('a VPN or hosting connection, only with a table loaded and only one seen by then', () => {
    recordPlayerNet(db, { steamid: CAND, ip: '198.51.100.4', country: 'GB' }, new Date('2026-10-17T20:00:00Z'), net(212238, 'DATACAMP-LIMITED'));
    expect(secondSigns(db, CAND, ctx(), AT)).toEqual(['vpn']);
    expect(secondSigns(db, CAND, ctx({ asnLoaded: false }), AT)).toEqual([]);
    expect(secondSigns(db, CAND, ctx(), new Date('2026-10-17T19:00:00Z'))).toEqual([]);
  });

  it('a residential connection is not a sign', () => {
    recordPlayerNet(db, { steamid: CAND, ip: '203.0.113.9', country: 'US' }, new Date('2026-10-17T20:00:00Z'), net(64500, 'EXAMPLE-CABLE'));
    expect(secondSigns(db, CAND, ctx(), AT)).toEqual([]);
  });

  it('a fresh identity: young or private Steam account', () => {
    const steam = db.prepare("INSERT INTO player_steam_signals (steamid, time_created, visibility, checked_at) VALUES (?, ?, ?, '2026-10-17T00:00:00.000Z')");
    steam.run(CAND, Math.floor((AT.getTime() - 100 * DAY) / 1000), 3);
    expect(secondSigns(db, CAND, ctx(), AT)).toEqual(['fresh_identity']);
    db.prepare('UPDATE player_steam_signals SET time_created = ?, visibility = 1 WHERE steamid = ?')
      .run(Math.floor((AT.getTime() - 900 * DAY) / 1000), CAND);
    expect(secondSigns(db, CAND, ctx(), AT)).toEqual(['fresh_identity']);
    db.prepare('UPDATE player_steam_signals SET visibility = 3 WHERE steamid = ?').run(CAND);
    expect(secondSigns(db, CAND, ctx(), AT)).toEqual([]);
  });

  it('a fresh identity: a Discord account under 90 days old', () => {
    linkDiscord(db, CAND, snowflakeAt(AT.getTime() - 20 * DAY), 'newd');
    expect(secondSigns(db, CAND, ctx(), AT)).toEqual(['fresh_identity']);
  });

  it('a fresh identity: a Discord new to us on a site account under 7 days old', () => {
    db.prepare('UPDATE players SET created_at = ? WHERE steamid = ?').run(sqliteTime(AT.getTime() - 3 * DAY), CAND);
    linkDiscord(db, CAND, '175928847299117063', 'oldd');
    expect(secondSigns(db, CAND, ctx(), AT)).toEqual(['fresh_identity']);
    db.prepare(
      `INSERT INTO discord_link_history (steamid, discord_id, discord_name, linked_at, linked_by, unlinked_at, unlinked_by)
       VALUES (?, '175928847299117063', 'oldd', '2026-01-01T00:00:00.000Z', 'x', '2026-02-01T00:00:00.000Z', 'x')`,
    ).run(OTHER);
    expect(secondSigns(db, CAND, ctx(), AT)).toEqual([]);
    db.prepare('DELETE FROM discord_link_history WHERE steamid = ?').run(OTHER);
    db.prepare('UPDATE players SET created_at = ? WHERE steamid = ?').run(sqliteTime(AT.getTime() - 30 * DAY), CAND);
    expect(secondSigns(db, CAND, ctx(), AT)).toEqual([]);
  });

  it('a cheat flag of an aimbot or wallhack kind, in a match, by then', () => {
    const flag = db.prepare("INSERT INTO integrity_flags (match_id, steamid, source, kind, severity, at) VALUES (?, ?, 'lilac', ?, 'suspected', ?)");
    flag.run(900, CAND, 'bhop', '2026-10-17T20:00:00.000Z');
    flag.run(null, CAND, 'aimbot', '2026-10-17T20:00:00.000Z');
    flag.run(900, CAND, 'aimbot', '2026-10-17T22:00:00.000Z');
    expect(secondSigns(db, CAND, ctx(), AT)).toEqual([]);
    flag.run(900, CAND, 'aimbot_multi', '2026-10-17T20:00:00.000Z');
    expect(secondSigns(db, CAND, ctx(), AT)).toEqual(['cheat_flag']);
  });

  it('two member accounts among the 10 nearest', () => {
    expect(secondSigns(db, CAND, ctx({ membersInTop10: 1 }), AT)).toEqual([]);
    expect(secondSigns(db, CAND, ctx({ membersInTop10: 2 }), AT)).toEqual(['two_members']);
  });

  it('a connection shared with a member', () => {
    recordPlayerNet(db, { steamid: MEMBER, ip: '203.0.113.9', country: 'US' }, new Date('2026-10-17T19:00:00Z'), null);
    recordPlayerNet(db, { steamid: CAND, ip: '203.0.113.9', country: 'US' }, new Date('2026-10-17T20:00:00Z'), null);
    expect(secondSigns(db, CAND, ctx(), AT)).toEqual(['shared_connection']);
    expect(secondSigns(db, CAND, ctx({ members: [] }), AT)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/fingerprintSigns.test.ts`
Expected: FAIL, cannot resolve `../src/fingerprintSigns.js`.

- [ ] **Step 3: Write the implementation**

Create `src/fingerprintSigns.ts`:

```ts
import type { DB } from './db.js';
import { personOf } from './evaderPeople.js';
import { resolveAlias } from './aliases.js';
import { isVpnNetwork } from './networkKinds.js';
import { SIGN_ORDER, type SecondSign } from './fingerprint.js';
import { completedPug } from './matchKinds.js';

/**
 * Who the fingerprint check looks at, and the independent second signs that
 * lift a fingerprint alert to a hold.
 *
 * Design: docs/superpowers/specs/2026-10-17-evader-fingerprints-design.md
 *
 * Only NEW accounts are checked: at about 3% honest overlap per person, an
 * established regular would be a steady stream of false alerts, and evaders
 * arrive as new accounts. A fingerprint says "could be them"; a hold needs
 * one more thing seen on the account that a fingerprint cannot produce.
 *
 * Every function takes the moment to answer for, so the history replay
 * (src/fingerprintReplay.ts) asks "as of that match end" with this same code.
 * Columns come in two formats here, so every comparison uses the column's
 * own: matches.ended_at and players.created_at are SQLite datetimes
 * ('YYYY-MM-DD HH:MM:SS'), bans, flags, networks and bursts are ISO.
 */

const DAY = 86_400_000;
export const NEW_RATED_MATCHES = 15;
export const NEW_SITE_ACCOUNT_MS = 30 * DAY;
export const YOUNG_STEAM_MS = 365 * DAY;
export const YOUNG_DISCORD_MS = 90 * DAY;
export const YOUNG_SITE_MS = 7 * DAY;
const DISCORD_EPOCH = 1420070400000n;

/** The aimbot and wallhack kinds in integrity_flags. hs_share, flick_return
 *  and aimbot_multi come from the aimbot rules
 *  (docs/superpowers/specs/2026-10-17-aimbot-rules-design.md); listing them
 *  before they exist matches nothing and costs nothing. */
export const CHEAT_FLAG_KINDS = ['aimbot', 'aimlock', 'newcomer_esp', 'hs_share', 'flick_return', 'aimbot_multi'] as const;

export function dbTimeMs(s: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(t) ? null : t;
}

export const sqlTime = (at: Date): string => at.toISOString().replace('T', ' ').slice(0, 19);

/** A Discord id is a snowflake: its top bits are milliseconds since 2015. */
export function discordCreatedMs(id: string): number | null {
  if (!/^\d{17,20}$/.test(id)) return null;
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

/** hasActiveBan, at a moment: placed by then and not yet lifted or expired. */
export function activeBanAt(db: DB, steamid: string, at: Date): boolean {
  const iso = at.toISOString();
  return db.prepare(
    `SELECT 1 FROM bans WHERE player_id = ? AND created_at <= ?
       AND (lifted_at IS NULL OR lifted_at > ?) AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`,
  ).get(steamid, iso, iso, iso) !== undefined;
}

/** Rated PUGs only (completedPug, as tests/matchKindGuard.test.ts requires):
 *  a scrim or a tournament match does not make an account established. */
export function ratedMatchesAt(db: DB, steamid: string, at: Date): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM match_players mp JOIN matches m ON m.id = mp.match_id
      WHERE mp.player_id = ? AND mp.rated = 1 AND ${completedPug('m')} AND m.voided_at IS NULL
        AND COALESCE(m.ended_at, m.created_at) <= ?`,
  ).get(steamid, sqlTime(at)) as { n: number }).n;
}

export function isNewAccount(db: DB, steamid: string, at: Date): boolean {
  if (ratedMatchesAt(db, steamid, at) < NEW_RATED_MATCHES) return true;
  const row = db.prepare('SELECT created_at FROM players WHERE steamid = ?').get(steamid) as { created_at: string } | undefined;
  const created = dbTimeMs(row?.created_at ?? null);
  return created !== null && at.getTime() - created < NEW_SITE_ACCOUNT_MS;
}

/** The players of this match the check looks at: no member of any person
 *  (open or closed, or an alias of one), no ban or hold, and new. */
export function candidatesOf(db: DB, matchId: number, at: Date): string[] {
  const ids = (db.prepare('SELECT DISTINCT steamid FROM input_bursts WHERE match_id = ? ORDER BY steamid').all(matchId) as { steamid: string }[])
    .map((r) => r.steamid);
  return ids.filter((id) =>
    !personOf(db, 'steam', id) && !personOf(db, 'steam', resolveAlias(db, id))
    && !activeBanAt(db, id, at) && isNewAccount(db, id, at));
}

export interface SignContext {
  /** The person's Steam members. */
  members: readonly string[];
  /** From matchPersons: member accounts among the candidate's 10 nearest. */
  membersInTop10: number;
  /** False when no ASN table is loaded: then sign 1 is not counted at all. */
  asnLoaded: boolean;
  extraVpn: ReadonlySet<number>;
}

function freshIdentity(db: DB, steamid: string, atMs: number): boolean {
  const s = db.prepare('SELECT time_created, visibility FROM player_steam_signals WHERE steamid = ?').get(steamid) as
    | { time_created: number | null; visibility: number | null } | undefined;
  if (s && s.time_created !== null && atMs - s.time_created * 1000 < YOUNG_STEAM_MS) return true;
  // Weak on its own (many honest players are private): it only ever counts
  // next to a fingerprint match, which is the point of the design.
  if (s && s.visibility !== null && s.visibility !== 3) return true;
  const p = db.prepare('SELECT discord_id, created_at FROM players WHERE steamid = ?').get(steamid) as
    | { discord_id: string | null; created_at: string } | undefined;
  if (!p?.discord_id) return false;
  const born = discordCreatedMs(p.discord_id);
  if (born !== null && atMs - born < YOUNG_DISCORD_MS) return true;
  const elsewhere = db.prepare('SELECT 1 FROM discord_link_history WHERE discord_id = ? AND steamid <> ? LIMIT 1')
    .get(p.discord_id, steamid);
  const joined = dbTimeMs(p.created_at);
  return !elsewhere && joined !== null && atMs - joined < YOUNG_SITE_MS;
}

/** The second signs seen on `steamid` by `at`, in SIGN_ORDER. */
export function secondSigns(db: DB, steamid: string, ctx: SignContext, at: Date): SecondSign[] {
  const iso = at.toISOString();
  const found = new Set<SecondSign>();
  if (ctx.asnLoaded) {
    const nets = db.prepare('SELECT asn, as_org FROM player_networks WHERE player_id = ? AND first_seen <= ?')
      .all(steamid, iso) as { asn: number | null; as_org: string | null }[];
    if (nets.some((n) => isVpnNetwork(n.asn, n.as_org, ctx.extraVpn))) found.add('vpn');
  }
  if (freshIdentity(db, steamid, at.getTime())) found.add('fresh_identity');
  const cheat = db.prepare(
    `SELECT 1 FROM integrity_flags WHERE steamid = ? AND match_id IS NOT NULL AND at <= ?
       AND kind IN (${CHEAT_FLAG_KINDS.map(() => '?').join(', ')}) LIMIT 1`,
  ).get(steamid, iso, ...CHEAT_FLAG_KINDS);
  if (cheat) found.add('cheat_flag');
  if (ctx.membersInTop10 >= 2) found.add('two_members');
  if (ctx.members.length > 0) {
    const shared = db.prepare(
      `SELECT 1 FROM player_networks a JOIN player_networks b ON b.ip_hash = a.ip_hash
        WHERE a.player_id = ? AND a.first_seen <= ?
          AND b.player_id IN (${ctx.members.map(() => '?').join(', ')}) AND b.first_seen <= ? LIMIT 1`,
    ).get(steamid, iso, ...ctx.members, iso);
    if (shared) found.add('shared_connection');
  }
  return SIGN_ORDER.filter((s) => found.has(s));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/fingerprintSigns.test.ts tests/matchKindGuard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fingerprintSigns.ts tests/fingerprintSigns.test.ts
git commit -m "Fingerprint candidates and second signs, every check answered as of a moment" -- src/fingerprintSigns.ts tests/fingerprintSigns.test.ts
```

---

### Task 10: The fingerprint_match admin event and its Discord post

**Files:**
- Modify: `src/adminFeed.ts` (AdminEvent union, FEED_SETTING)
- Modify: `src/discord/feedRouting.ts` (FEED_DESTINATION)
- Modify: `src/discord/adminFeedPoster.ts` (`line()`)
- Modify: `tests/feedRouting.test.ts`
- Test: `tests/discordAdminFeed.test.ts` (append one test)

**Interfaces:**
- Consumes: Task 1 (`SIGN_TEXT`, `SecondSign`).
- Produces: the event shape every later task publishes:

```ts
| {
  kind: 'fingerprint_match'; level: 'alert' | 'loud' | 'hold'; steamid: string; matchId: number;
  personId: number; personLabel: string; distance: number; threshold: number; rank: number;
  signs: string[]; holdId: number | null;
  medians: { cls: string; candidate: number | null; person: number | null }[];
  connections: { country: string | null; asOrg: string | null; vpn: boolean }[];
}
```

Routing: mod channel; `loud` and `hold` ping the mod call role; `alert` does not.

- [ ] **Step 1: Write the failing tests**

Append inside the `describe('admin feed', ...)` block of `tests/discordAdminFeed.test.ts`:

```ts
  it('a fingerprint hold pings the mod role with the numbers; a fingerprint-only alert does not ping', async () => {
    setSetting(db, 'mod_call_role_id', '123456789012345678');
    const base = {
      steamid: IDS[1], matchId, personId: 1, personLabel: 'dethisa', distance: 0.2031, threshold: 0.25, rank: 2,
      medians: [{ cls: 'hunter claw', candidate: 12, person: 12 }],
      connections: [{ country: 'GB', asOrg: 'DATACAMP-LIMITED', vpn: true }],
    };
    publishAdminEvent({ kind: 'fingerprint_match', level: 'alert', signs: [], holdId: null, ...base });
    publishAdminEvent({ kind: 'fingerprint_match', level: 'hold', signs: ['vpn'], holdId: 4, ...base });
    await settled();
    const [alert, hold] = inFeed().map((m) => m.payload);
    const a = JSON.stringify(alert);
    expect(alert.content).toBeUndefined();
    expect(a).toContain('plays like known evader **dethisa**');
    expect(a).toContain('#2 nearest');
    expect(a).toContain('distance 0.203');
    expect(a).toContain('limit of 0.250');
    expect(a).toContain('No second sign');
    expect(a).toContain('hunter claw');
    expect(a).toContain('DATACAMP-LIMITED (VPN or hosting)');
    expect(a).toContain('not proof');
    expect(hold.content).toBe('<@&123456789012345678>');
    expect(JSON.stringify(hold)).toContain('**on hold**');
    expect(JSON.stringify(hold)).toContain('a VPN or hosting connection');
  });
```

In `tests/feedRouting.test.ts`, replace

```ts
    expect(mod).toEqual(['alt', 'appeal', 'conduct_flag', 'ip_match', 'newcomer_flag', 'report', 'sourcetv_watch', 'spray_exploit', 'staff_message']);
```

with

```ts
    expect(mod).toEqual(['alt', 'appeal', 'conduct_flag', 'fingerprint_match', 'ip_match', 'newcomer_flag', 'report', 'sourcetv_watch', 'spray_exploit', 'staff_message']);
```

(If the aimbot-rules work has already added a kind to this list, keep theirs and insert `'fingerprint_match'` in sorted position.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/discordAdminFeed.test.ts tests/feedRouting.test.ts`
Expected: FAIL (typecheck aside, vitest runs it: the fingerprint post is missing, and `fingerprint_match` is not in FEED_DESTINATION).

- [ ] **Step 3: Write the implementation**

In `src/adminFeed.ts`, add to the `AdminEvent` union, after the `ip_match` member:

```ts
  // A new account's infected button holds match a known evader's
  // (src/fingerprintCheck.ts). 'alert': the fingerprint alone. 'loud': the
  // fingerprint and a second sign, with no hold (setting evader_fingerprint
  // is 'alert', or the hold was refused). 'hold': the account is on an alt
  // hold. loud and hold ping the mod call role. Once per account, person and
  // level, and again only when the level goes up. A fingerprint is "could be
  // them", never proof, and every post says so.
  | {
    kind: 'fingerprint_match'; level: 'alert' | 'loud' | 'hold'; steamid: string; matchId: number;
    personId: number; personLabel: string; distance: number; threshold: number; rank: number;
    signs: string[]; holdId: number | null;
    medians: { cls: string; candidate: number | null; person: number | null }[];
    connections: { country: string | null; asOrg: string | null; vpn: boolean }[];
  }
```

and to `FEED_SETTING`, after `ip_match: 'admin_feed_problems',`:

```ts
  fingerprint_match: 'admin_feed_problems',
```

In `src/discord/feedRouting.ts` `FEED_DESTINATION`, after `ip_match: 'mod',`:

```ts
  fingerprint_match: 'mod',
```

In `src/discord/adminFeedPoster.ts`, add the import:

```ts
import { SIGN_TEXT, type SecondSign } from '../fingerprint.js';
```

and in `line()`, after the whole `case 'ip_match': { ... }` block, add:

```ts
      case 'fingerprint_match': {
        const desk = `${this.deps.publicUrl}/admin/people/alts`;
        const label = `**${escapeName(e.personLabel)}**`;
        const head = e.level === 'hold' ? '**Fingerprint hold:**'
          : e.level === 'loud' ? '**Fingerprint match with a second sign:**' : 'Fingerprint match:';
        const numbers = `#${e.rank} nearest of everyone on record, distance ${e.distance.toFixed(3)} against `
          + `${label}'s limit of ${e.threshold.toFixed(3)}`;
        const signs = e.signs.length
          ? ` Second signs: ${e.signs.map((s) => SIGN_TEXT[s as SecondSign] ?? s).join(', ')}.`
          : ' No second sign.';
        const outcome = e.level === 'hold'
          ? ' The account is **on hold** and cannot queue or play until a moderator looks.'
          : e.level === 'loud' ? ' No hold was placed.' : ' Nothing was done to the account.';
        // A code block shows the medians as a table. Backticks in a label
        // would close it early.
        const plain = (s: string) => s.replace(/`/g, "'");
        const rows = e.medians.map((m) =>
          `${plain(m.cls).padEnd(20)}${String(m.candidate ?? '-').padStart(6)}${String(m.person ?? '-').padStart(9)}`);
        const table = rows.length
          ? `\nMedian hold, ticks:\n\`\`\`\n${'class'.padEnd(20)}${'this'.padStart(6)}${plain(e.personLabel).slice(0, 8).padStart(9)}\n${rows.join('\n')}\n\`\`\``
          : '';
        const conns = e.connections.length
          ? `\nConnections: ${e.connections.map((c) => `${c.country ?? '??'} ${escapeName(c.asOrg ?? 'unknown provider')}${c.vpn ? ' (VPN or hosting)' : ''}`).join(', ')}`
          : '';
        return {
          text: `${head} ${this.name(e.steamid)} plays like known evader ${label} in match `
            + `[#${e.matchId}](${this.deps.publicUrl}/match/${e.matchId}). ${numbers}.${signs}${outcome} `
            + `A fingerprint alone is not proof. [File](${this.file(e.steamid)}) · [Alts](${desk})${table}${conns}`,
          color: COLOR.problem,
          ping: e.level !== 'alert',
        };
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/discordAdminFeed.test.ts tests/feedRouting.test.ts && npm run typecheck`
Expected: PASS and a clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/adminFeed.ts src/discord/feedRouting.ts src/discord/adminFeedPoster.ts tests/discordAdminFeed.test.ts tests/feedRouting.test.ts
git commit -m "Admin feed: fingerprint_match posts to the mod channel, holds and loud matches ping" -- src/adminFeed.ts src/discord/feedRouting.ts src/discord/adminFeedPoster.ts tests/discordAdminFeed.test.ts tests/feedRouting.test.ts
```

---

### Task 11: The end-of-match fingerprint check

**Files:**
- Create: `src/fingerprintCheck.ts`
- Modify: `src/settingsSchema.ts` (add `evader_fingerprint` after the `vpn_asns_extra` entry)
- Modify: `src/inputBursts.ts` (`scanEndedMatches`)
- Modify: `src/server.ts` (the `scanEndedMatches` call near line 1691)
- Test: `tests/fingerprintCheck.test.ts`

**Interfaces:**
- Consumes: Task 2 (`currentAsnTable`), Task 3 (`extraVpnAsns`, `isVpnNetwork`), Task 1 (`matchPersons`, `medianHold`, `classLabel`), Task 7 (`fingerprintWorld`, `playerFingerprint`), Task 8 (`placeFingerprintHold`), Task 9 (`candidatesOf`, `secondSigns`), Task 10 (event shape).
- Produces (`src/fingerprintCheck.ts`):
  - `type FingerprintMode = 'off' | 'alert' | 'full'`, `fingerprintMode(db): FingerprintMode`
  - `type AlertLevel = 'alert' | 'loud' | 'hold'`, `levelFor(mode: 'alert' | 'full', signs): AlertLevel`
  - `interface FingerprintOutcome { matchId: number; steamid: string; personId: number; level: AlertLevel; signs: SecondSign[]; holdId: number | null }`
  - `checkMatchFingerprints(db, matchId, now?): FingerprintOutcome[]` (throws on a DB error)
  - `runFingerprintCheck(db, matchId, now?): FingerprintOutcome[]` (never throws; logs `fingerprint check failed`)
  - `scanEndedMatches(db, thresholds?, now?, withinMs?, afterMatch?: (matchId: number) => void)`: the hook runs once per newly claimed match, after that match's input signatures.

- [ ] **Step 1: Write the failing tests**

Create `tests/fingerprintCheck.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { banPlayer } from '../src/admin/players.js';
import { hasActiveBan } from '../src/banState.js';
import { liftAltHold } from '../src/altHolds.js';
import { setAsnTable } from '../src/asnTable.js';
import { addMember, createPerson } from '../src/evaderPeople.js';
import { checkMatchFingerprints, runFingerprintCheck } from '../src/fingerprintCheck.js';
import { scanEndedMatches } from '../src/inputBursts.js';
import { subscribeAdminEvents, type AdminEvent } from '../src/adminFeed.js';
import { endedMatch, playMatch, player } from './fingerprintFixtures.js';

const MEMBER = '76561198000000001';
const CAND = '76561198000000002';
const STAFF = '76561198000000009';
const HONEST = [5, 6, 7, 14, 15, 16].map((peak, i) => ({ id: `765611980000001${10 + i}`, peak }));
const NOW = new Date('2026-10-17T21:00:00Z');

let db: DB;
let personId: number;
let events: Extract<AdminEvent, { kind: 'fingerprint_match' }>[];
let off: () => void;

const cheatFlag = () => db.prepare(
  "INSERT INTO integrity_flags (match_id, steamid, source, kind, severity, at) VALUES (900, ?, 'lilac', 'aimbot', 'suspected', '2026-10-17T20:30:00.000Z')",
).run(CAND);

beforeEach(() => {
  db = openDb(':memory:');
  setAsnTable(null);
  for (const id of [MEMBER, CAND, STAFF, ...HONEST.map((h) => h.id)]) player(db, id);
  endedMatch(db, 800, '2026-10-16 20:00:00');
  endedMatch(db, 900, '2026-10-17 20:00:00');
  playMatch(db, MEMBER, 800, 10, 100, '2026-10-16T19:00:00.000Z');
  for (const h of HONEST) playMatch(db, h.id, 800, h.peak, 80, '2026-10-16T19:00:00.000Z');
  playMatch(db, CAND, 900, 10, 80, '2026-10-17T19:00:00.000Z');
  personId = createPerson(db, 'dethisa', '', STAFF);
  addMember(db, personId, 'steam', MEMBER, STAFF, 'seed');
  setSetting(db, 'evader_fingerprint', 'alert');
  events = [];
  off = subscribeAdminEvents((e) => { if (e.kind === 'fingerprint_match') events.push(e); });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { off(); vi.restoreAllMocks(); });

describe('checkMatchFingerprints', () => {
  it('does nothing while the setting is off', () => {
    setSetting(db, 'evader_fingerprint', 'off');
    expect(checkMatchFingerprints(db, 900, NOW)).toEqual([]);
    expect(events).toEqual([]);
  });

  it('alerts on a fingerprint alone, once, and holds nobody', () => {
    const [o] = checkMatchFingerprints(db, 900, NOW);
    expect(o).toMatchObject({ steamid: CAND, personId, level: 'alert', signs: [], holdId: null });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ personLabel: 'dethisa', rank: 1, distance: 0, threshold: 0.25, matchId: 900 });
    expect(events[0].medians.map((m) => m.cls)).toEqual(['hunter claw', 'hunter air attack']);
    expect(hasActiveBan(db, CAND)).toBe(false);
    expect(checkMatchFingerprints(db, 900, NOW)).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it('in alert mode, a fingerprint with a second sign is loud, never a hold', () => {
    cheatFlag();
    const [o] = checkMatchFingerprints(db, 900, NOW);
    expect(o).toMatchObject({ level: 'loud', signs: ['cheat_flag'], holdId: null });
    expect(hasActiveBan(db, CAND)).toBe(false);
  });

  it('in full mode, a fingerprint with a second sign holds the account', () => {
    setSetting(db, 'evader_fingerprint', 'full');
    cheatFlag();
    const [o] = checkMatchFingerprints(db, 900, NOW);
    expect(o.level).toBe('hold');
    expect(o.holdId).toEqual(expect.any(Number));
    expect(hasActiveBan(db, CAND)).toBe(true);
    expect(events[0]).toMatchObject({ level: 'hold', holdId: o.holdId });
  });

  it('fires again only when the level goes up', () => {
    expect(checkMatchFingerprints(db, 900, NOW)[0].level).toBe('alert');
    cheatFlag();
    setSetting(db, 'evader_fingerprint', 'full');
    expect(checkMatchFingerprints(db, 900, NOW)[0].level).toBe('hold');
    expect(events.map((e) => e.level)).toEqual(['alert', 'hold']);
  });

  it('a released fingerprint hold stays released when the account plays again', () => {
    setSetting(db, 'evader_fingerprint', 'full');
    cheatFlag();
    const [o] = checkMatchFingerprints(db, 900, NOW);
    liftAltHold(db, o.holdId!, STAFF, new Date('2026-10-17T20:50:00Z'));
    endedMatch(db, 901, '2026-10-17 20:40:00');
    playMatch(db, CAND, 901, 10, 80, '2026-10-17T20:30:00.000Z');
    expect(checkMatchFingerprints(db, 901, NOW)).toEqual([]);
    expect(hasActiveBan(db, CAND)).toBe(false);
    expect(events).toHaveLength(1);
  });

  it('posts loud when the hold is refused (staff)', () => {
    setSetting(db, 'evader_fingerprint', 'full');
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(CAND);
    cheatFlag();
    expect(checkMatchFingerprints(db, 900, NOW)[0]).toMatchObject({ level: 'loud', holdId: null });
  });

  it('skips established players and banned ones', () => {
    for (let i = 0; i < 15; i++) {
      endedMatch(db, 100 + i, '2026-09-01 20:00:00');
      db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, 'a')").run(100 + i, CAND);
    }
    db.prepare("UPDATE players SET created_at = '2026-08-01 00:00:00' WHERE steamid = ?").run(CAND);
    expect(checkMatchFingerprints(db, 900, NOW)).toEqual([]);
    db.prepare('DELETE FROM match_players WHERE player_id = ?').run(CAND);
    // Dated before NOW: the check reads bans as of the moment it answers for.
    banPlayer(db, CAND, STAFF, 'toxic', null, new Date('2026-10-17T10:00:00Z'));
    expect(checkMatchFingerprints(db, 900, NOW)).toEqual([]);
  });

  it('a person with no Steam accounts or no data is skipped without a fuss', () => {
    const ghost = createPerson(db, 'ghost', '', STAFF);
    addMember(db, ghost, 'discord', '286250932470153217', STAFF, 'manual');
    createPerson(db, 'empty', '', STAFF);
    const out = checkMatchFingerprints(db, 900, NOW);
    expect(out.map((o) => o.personId)).toEqual([personId]);
  });
});

describe('wiring', () => {
  it('runFingerprintCheck logs a failure and returns nothing', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.exec('DROP TABLE fingerprint_cache');
    expect(runFingerprintCheck(db, 900, NOW)).toEqual([]);
    expect(String(err.mock.calls[0]?.[0])).toContain('fingerprint check failed for match 900');
  });

  it('the end-of-match sweep hands each newly ended match to the hook once', () => {
    const seen: number[] = [];
    scanEndedMatches(db, undefined, NOW, undefined, (id) => seen.push(id));
    scanEndedMatches(db, undefined, NOW, undefined, (id) => seen.push(id));
    expect(seen).toEqual([900]); // 800 ended more than six hours before NOW
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/fingerprintCheck.test.ts`
Expected: FAIL, cannot resolve `../src/fingerprintCheck.js`.

- [ ] **Step 3: Write the implementation**

Create `src/fingerprintCheck.ts`:

```ts
import type { DB } from './db.js';
import { getSetting } from './settings.js';
import { publishAdminEvent, type AdminEvent } from './adminFeed.js';
import { placeFingerprintHold } from './altHolds.js';
import { currentAsnTable } from './asnTable.js';
import {
  classLabel, matchPersons, medianHold, type Fingerprint, type PersonHit, type PersonModel, type SecondSign,
} from './fingerprint.js';
import { fingerprintWorld, playerFingerprint } from './fingerprintData.js';
import { candidatesOf, secondSigns } from './fingerprintSigns.js';
import { extraVpnAsns, isVpnNetwork } from './networkKinds.js';

/**
 * The evader fingerprint check, run once per ended match from the end-of-match
 * sweep (scanEndedMatches in src/inputBursts.ts), after the auto-bhop
 * signature.
 *
 * Design: docs/superpowers/specs/2026-10-17-evader-fingerprints-design.md
 *
 * For each new player in the match: rank their whole-history fingerprint
 * against every fingerprinted player and every open person. A person in the
 * top 5 and within their own threshold is a fingerprint match. Then:
 *
 *   - no second sign: 'alert', a mod channel post, nothing done;
 *   - a second sign, setting 'full': 'hold', an alt hold, a pinged post;
 *   - a second sign, setting 'alert' (or the hold refused): 'loud', a pinged
 *     post and no hold.
 *
 * Each (account, person, level) fires once, and again only when the level
 * goes up. A cleared fingerprint hold is never placed again for that pair.
 */

export type FingerprintMode = 'off' | 'alert' | 'full';
export type AlertLevel = 'alert' | 'loud' | 'hold';
const LEVEL_RANK: Record<AlertLevel, number> = { alert: 1, loud: 2, hold: 3 };

export function fingerprintMode(db: DB): FingerprintMode {
  const v = getSetting(db, 'evader_fingerprint');
  return v === 'alert' || v === 'full' ? v : 'off';
}

export function levelFor(mode: 'alert' | 'full', signs: readonly SecondSign[]): AlertLevel {
  if (signs.length === 0) return 'alert';
  return mode === 'full' ? 'hold' : 'loud';
}

function storedLevel(db: DB, steamid: string, personId: number): AlertLevel | null {
  const rows = db.prepare('SELECT level FROM fingerprint_alerts WHERE steamid = ? AND person_id = ?')
    .all(steamid, personId) as { level: AlertLevel }[];
  let best: AlertLevel | null = null;
  for (const r of rows) if (!best || LEVEL_RANK[r.level] > LEVEL_RANK[best]) best = r.level;
  return best;
}

export interface FingerprintOutcome {
  matchId: number; steamid: string; personId: number; level: AlertLevel; signs: SecondSign[]; holdId: number | null;
}

/** Logged at most hourly: "sign 1 is not being counted" is worth knowing, not
 *  worth a line every minute. */
let asnMissingLoggedAt = Number.NEGATIVE_INFINITY;

function eventFor(
  db: DB, matchId: number, steamid: string, person: PersonModel, fp: Fingerprint, hit: PersonHit,
  signs: SecondSign[], level: AlertLevel, holdId: number | null, extraVpn: ReadonlySet<number>,
): AdminEvent {
  const classes = [...new Set([...Object.keys(fp), ...Object.keys(person.pooled)])].sort();
  const nets = db.prepare('SELECT country, asn, as_org FROM player_networks WHERE player_id = ? ORDER BY last_seen DESC LIMIT 6')
    .all(steamid) as { country: string | null; asn: number | null; as_org: string | null }[];
  return {
    kind: 'fingerprint_match', level, steamid, matchId,
    personId: person.id, personLabel: person.label,
    distance: hit.distance, threshold: hit.threshold, rank: hit.rank,
    signs: [...signs], holdId,
    medians: classes.map((cls) => ({ cls: classLabel(cls), candidate: medianHold(fp[cls]), person: medianHold(person.pooled[cls]) })),
    connections: nets.map((n) => ({ country: n.country, asOrg: n.as_org, vpn: isVpnNetwork(n.asn, n.as_org, extraVpn) })),
  };
}

export function checkMatchFingerprints(db: DB, matchId: number, now = new Date()): FingerprintOutcome[] {
  const mode = fingerprintMode(db);
  if (mode === 'off') return [];
  const candidates = candidatesOf(db, matchId, now);
  if (candidates.length === 0) return [];
  const { field, persons } = fingerprintWorld(db, now);
  if (persons.length === 0) return [];
  const asnLoaded = currentAsnTable() !== null;
  if (!asnLoaded && now.getTime() - asnMissingLoggedAt >= 3_600_000) {
    asnMissingLoggedAt = now.getTime();
    console.warn('[fingerprint] no ASN table is loaded: the VPN sign is not counted until one is');
  }
  const extraVpn = extraVpnAsns(db);
  const out: FingerprintOutcome[] = [];
  for (const steamid of candidates) {
    const fp = playerFingerprint(db, steamid);
    for (const hit of matchPersons(fp, steamid, field, persons)) {
      if (!hit.matched) continue;
      const person = persons.find((p) => p.id === hit.personId);
      if (!person || person.members.length === 0) continue;
      const signs = secondSigns(db, steamid, { members: person.members, membersInTop10: hit.membersInTop10, asnLoaded, extraVpn }, now);
      const before = storedLevel(db, steamid, person.id);
      let level = levelFor(mode, signs);
      if (before && LEVEL_RANK[before] >= LEVEL_RANK[level]) continue;
      let holdId: number | null = null;
      if (level === 'hold') {
        const placed = placeFingerprintHold(db, steamid, person.id, hit.nearestMember ?? person.members[0], now);
        if ('id' in placed) {
          holdId = placed.id;
        } else if (placed.refused === 'cleared') {
          continue; // staff already said no to this pair
        } else {
          level = 'loud';
          if (before && LEVEL_RANK[before] >= LEVEL_RANK.loud) continue;
        }
      }
      db.prepare(
        `INSERT OR IGNORE INTO fingerprint_alerts (steamid, person_id, level, distance, threshold, rank, signs_json, match_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(steamid, person.id, level, hit.distance, hit.threshold, hit.rank, JSON.stringify(signs), matchId, now.toISOString());
      publishAdminEvent(eventFor(db, matchId, steamid, person, fp, hit, signs, level, holdId, extraVpn));
      out.push({ matchId, steamid, personId: person.id, level, signs, holdId });
    }
  }
  return out;
}

/** The sweep's entry point: a failure is logged with the match id and never
 *  reaches the sweep, which carries on with its other checks. */
export function runFingerprintCheck(db: DB, matchId: number, now = new Date()): FingerprintOutcome[] {
  try {
    return checkMatchFingerprints(db, matchId, now);
  } catch (err) {
    console.error(`[fingerprint] fingerprint check failed for match ${matchId}:`, err);
    return [];
  }
}
```

In `src/inputBursts.ts`, change the `scanEndedMatches` signature and loop. Replace

```ts
export function scanEndedMatches(
  db: DB, thresholds: Thresholds = DEFAULT_THRESHOLDS, now = new Date(), withinMs = 6 * 3_600_000,
): { matchId: number; steamid: string; signature: string; note: string }[] {
```

with

```ts
export function scanEndedMatches(
  db: DB, thresholds: Thresholds = DEFAULT_THRESHOLDS, now = new Date(), withinMs = 6 * 3_600_000,
  afterMatch?: (matchId: number) => void,
): { matchId: number; steamid: string; signature: string; note: string }[] {
```

and directly after the per-match `db.transaction(() => { ... })();` (inside the `for (const { id } of matches)` loop) add:

```ts
    // Other once-per-ended-match checks (the evader fingerprint), after this
    // match's own signatures and outside their transaction. The hook owns its
    // errors: runFingerprintCheck never throws.
    afterMatch?.(id);
```

Update the doc comment above `scanEndedMatches` with one sentence at the end: `afterMatch is called once per match claimed here, after its signatures.`

In `src/server.ts`, add the import:

```ts
import { runFingerprintCheck } from './fingerprintCheck.js';
```

and replace

```ts
      for (const d of scanEndedMatches(deps.db, inputThresholds(deps.db))) {
```

with

```ts
      // The evader fingerprint check rides the same once-per-ended-match claim.
      for (const d of scanEndedMatches(deps.db, inputThresholds(deps.db), new Date(), undefined,
        (matchId) => { runFingerprintCheck(deps.db, matchId); })) {
```

In `src/settingsSchema.ts`, after the `vpn_asns_extra` entry add:

```ts
  { key: 'evader_fingerprint', group: 'Stats', label: 'Evader fingerprint', help: 'Checks every new account at the end of each match against known evaders\' infected button hold times (People > Alts > Known evaders). Off: nothing runs. Alert: a match posts to the mod channel; with a second sign (VPN, fresh account, cheat flag, shared connection) it pings the mod role, but nobody is held. Full: the same, and a match with a second sign puts the account on an alt hold. A fingerprint alone never holds anyone.', type: { kind: 'choice', options: [{ value: 'off', label: 'Off' }, { value: 'alert', label: 'Alert only' }, { value: 'full', label: 'Alert and hold' }] } },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/fingerprintCheck.test.ts tests/autobhop.test.ts tests/adminSettings.test.ts && npm run typecheck`
Expected: PASS and a clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/fingerprintCheck.ts src/settingsSchema.ts src/inputBursts.ts src/server.ts tests/fingerprintCheck.test.ts
git commit -m "Evader fingerprint check at every match end: alert, loud or hold, once per level" -- src/fingerprintCheck.ts src/settingsSchema.ts src/inputBursts.ts src/server.ts tests/fingerprintCheck.test.ts
```

---
### Task 12: Ban as same person

**Files:**
- Create: `src/evaderBan.ts`
- Test: `tests/evaderBan.test.ts`

**Interfaces:**
- Consumes: Task 5 (`addMember`, `personById`), Task 8 (`banFromHold`, `placeFingerprintHold`); `banPlayer` (existing, `src/admin/players.ts`).
- Produces (`src/evaderBan.ts`): `sameReason(label: string): string`, `type BanSameResult = 'banned' | 'no_person' | 'closed' | 'hold_settled'`, `banAsSamePerson(db, opts: { steamid: string; personId: number; by: string; holdId?: number; now?: Date }): BanSameResult`

- [ ] **Step 1: Write the failing tests**

Create `tests/evaderBan.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { linkDiscord } from '../src/players.js';
import { hasActiveBan } from '../src/banState.js';
import { subscribeBanChanges } from '../src/banEvents.js';
import { liftAltHold, placeFingerprintHold } from '../src/altHolds.js';
import { addMember, closePerson, createPerson, personOf } from '../src/evaderPeople.js';
import { banAsSamePerson } from '../src/evaderBan.js';
import { player } from './fingerprintFixtures.js';

const OLD = '76561198000000001';
const NEW = '76561198000000002';
const ADMIN = '76561198000000009';
const DISCORD = '777000000000000001';
let db: DB;
let personId: number;

beforeEach(() => {
  db = openDb(':memory:');
  for (const [id, name] of [[OLD, 'nepmir'], [NEW, 'fresh'], [ADMIN, 'admin']]) player(db, id, name);
  linkDiscord(db, NEW, DISCORD, 'freshd');
  personId = createPerson(db, 'dethisa', '', ADMIN);
  addMember(db, personId, 'steam', OLD, ADMIN, 'seed');
});

describe('banAsSamePerson', () => {
  it('bans from an alert and adds the account and its Discord to the person', () => {
    db.prepare("INSERT INTO fingerprint_cache (subject, classes_json, holds, built_at) VALUES (?, '{}', 0, 'x')").run(`person:${personId}`);
    const changes: string[] = [];
    const off = subscribeBanChanges((c) => { changes.push(`${c.kind}:${c.steamid}`); });
    expect(banAsSamePerson(db, { steamid: NEW, personId, by: ADMIN })).toBe('banned');
    off();
    expect(hasActiveBan(db, NEW)).toBe(true);
    const ban = db.prepare("SELECT reason FROM bans WHERE player_id = ? AND kind = 'ban'").get(NEW) as { reason: string };
    expect(ban.reason).toBe('Ban evasion: another account of dethisa');
    expect(personOf(db, 'steam', NEW)?.label).toBe('dethisa');
    expect(personOf(db, 'discord', DISCORD)?.label).toBe('dethisa');
    const how = db.prepare("SELECT how FROM evader_members WHERE kind = 'steam' AND ident = ?").get(NEW) as { how: string };
    expect(how.how).toBe('ban as same person');
    expect((db.prepare('SELECT built_at FROM fingerprint_cache WHERE subject = ?').get(`person:${personId}`) as { built_at: string }).built_at).toBe('');
    expect(changes).toContain(`ban:${NEW}`);
  });

  it('turns a fingerprint hold into a ban and closes the hold', () => {
    const placed = placeFingerprintHold(db, NEW, personId, OLD);
    const holdId = (placed as { id: number }).id;
    expect(banAsSamePerson(db, { steamid: NEW, personId, by: ADMIN, holdId })).toBe('banned');
    const hold = db.prepare('SELECT resolution FROM alt_holds WHERE id = ?').get(holdId) as { resolution: string };
    expect(hold.resolution).toBe('banned');
    const kinds = db.prepare('SELECT kind, lifted_at FROM bans WHERE player_id = ? ORDER BY id').all(NEW) as { kind: string; lifted_at: string | null }[];
    expect(kinds.map((k) => [k.kind, k.lifted_at === null])).toEqual([['alt_hold', false], ['ban', true]]);
  });

  it('refuses a missing or closed person and a settled hold', () => {
    expect(banAsSamePerson(db, { steamid: NEW, personId: 999, by: ADMIN })).toBe('no_person');
    const placed = placeFingerprintHold(db, NEW, personId, OLD) as { id: number };
    liftAltHold(db, placed.id, ADMIN);
    expect(banAsSamePerson(db, { steamid: NEW, personId, by: ADMIN, holdId: placed.id })).toBe('hold_settled');
    closePerson(db, personId, ADMIN);
    expect(banAsSamePerson(db, { steamid: NEW, personId, by: ADMIN })).toBe('closed');
    expect(hasActiveBan(db, NEW)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/evaderBan.test.ts`
Expected: FAIL, cannot resolve `../src/evaderBan.js`.

- [ ] **Step 3: Write the implementation**

Create `src/evaderBan.ts`:

```ts
import type { DB } from './db.js';
import { addMember, personById } from './evaderPeople.js';
import { banFromHold } from './altHolds.js';
import { banPlayer } from './admin/players.js';
import { getPlayer } from './players.js';

/**
 * "Ban as same person": a moderator looked at a fingerprint hold or alert and
 * agrees the account is that known evader. It becomes an ordinary permanent
 * ban (the public list shows it), and the account, with its Discord if one is
 * linked, joins the person's record: its connections are watched from now on
 * and its presses join the pooled fingerprint (the cache is marked stale by
 * addMember), so the next account is checked against everything they have
 * played on.
 */

export function sameReason(label: string): string {
  return `Ban evasion: another account of ${label}`;
}

export type BanSameResult = 'banned' | 'no_person' | 'closed' | 'hold_settled';

export function banAsSamePerson(
  db: DB, opts: { steamid: string; personId: number; by: string; holdId?: number; now?: Date },
): BanSameResult {
  const now = opts.now ?? new Date();
  const person = personById(db, opts.personId);
  if (!person) return 'no_person';
  if (person.closedAt) return 'closed';
  const reason = sameReason(person.label);
  if (opts.holdId !== undefined) {
    if (!banFromHold(db, opts.holdId, opts.by, reason, now)) return 'hold_settled';
  } else {
    banPlayer(db, opts.steamid, opts.by, reason, null, now);
  }
  addMember(db, opts.personId, 'steam', opts.steamid, opts.by, 'ban as same person', now);
  const discord = getPlayer(db, opts.steamid)?.discord_id;
  if (discord) addMember(db, opts.personId, 'discord', discord, opts.by, 'ban as same person', now);
  return 'banned';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/evaderBan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/evaderBan.ts tests/evaderBan.test.ts
git commit -m "Ban as same person: ban the account and add it and its Discord to the evader's record" -- src/evaderBan.ts tests/evaderBan.test.ts
```

---

### Task 13: Known evaders view and the remaining routes

**Files:**
- Create: `src/admin/knownEvaders.ts`
- Modify: `src/routes/people.ts`
- Modify: `src/discord/adminFeedPoster.ts` (`actionText`: `evader_ban_same`)
- Test: `tests/evaderRoutes.test.ts` (append)

**Interfaces:**
- Consumes: Task 5 (`openPeople`, `membersOf`, `personById`), Task 7 (`playerFingerprint`, `cachedPopulation`), Task 3, Task 12 (`banAsSamePerson`), Task 8 (`holdById` with `source`/`personId`).
- Produces:
  - `src/admin/knownEvaders.ts`: `interface KnownEvader` (below), `knownEvaders(db, viewer: FileViewer, now?): KnownEvader[]`
  - `GET /api/admin/people/evaders` -> `{ people: KnownEvader[] }` (mods)
  - `POST /api/admin/people/evaders/:id/ban-same-person` `{ steamid }` -> `{ ok: true }` (needs the `ban` file action, i.e. admin)
  - `POST /api/admin/people/alts/:id/ban-same-person` -> `{ ok: true }` (fingerprint holds only, `ban` action)
  - Audit action `evader_ban_same`

```ts
export interface KnownEvader {
  id: number; label: string; note: string; createdAt: string; createdByName: string | null;
  steam: { steamid: string; name: string; banned: boolean; held: boolean; lastSeen: string | null; how: string }[];
  discord: { id: string; how: string }[];
  connections: { ipHash: string; steamid: string; country: string | null; asOrg: string | null; vpn: boolean; lastSeen: string }[];
  medians: { cls: string; person: number | null; population: number | null }[];
  alerts: {
    steamid: string; name: string; level: 'alert' | 'loud' | 'hold'; distance: number; threshold: number; rank: number;
    signs: string[]; matchId: number | null; createdAt: string; banned: boolean;
  }[];
}
```

- [ ] **Step 1: Write the failing tests**

Append to `tests/evaderRoutes.test.ts` (add these imports at the top of the file):

```ts
import { addMember, createPerson } from '../src/evaderPeople.js';
import { placeFingerprintHold, placeAltHold } from '../src/altHolds.js';
import { hasActiveBan } from '../src/banState.js';
import { recordPlayerNet } from '../src/playerNetworks.js';
import { playMatch } from './fingerprintFixtures.js';
```

```ts
describe('known evaders view and ban as same person', () => {
  const ADMIN = '76561198000000009';
  const NEW = '76561198000000002';
  let admin: Record<string, string>;
  let personId: number;

  beforeEach(() => {
    admin = authedCookie(app, db, ADMIN);
    db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
    upsertPlayer(db, { steamid: NEW, name: 'fresh', avatar: null }, []);
    personId = createPerson(db, 'dethisa', 'five accounts', ADMIN);
    addMember(db, personId, 'steam', EVADER, ADMIN, 'seed');
    addMember(db, personId, 'discord', '286250932470153217', ADMIN, 'seed');
    recordPlayerNet(db, { steamid: EVADER, ip: '198.51.100.4', country: 'GB' }, new Date(), { lookup: () => ({ asn: 212238, org: 'DATACAMP-LIMITED' }) });
    playMatch(db, EVADER, null, 12, 40);
  });

  it('lists each person with accounts, Discords, tagged connections and hold medians', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/people/evaders', cookies: mod });
    const [p] = (res.json() as { people: import('../src/admin/knownEvaders.js').KnownEvader[] }).people;
    expect(p).toMatchObject({ id: personId, label: 'dethisa', note: 'five accounts' });
    expect(p.steam.map((s) => s.name)).toEqual(['nepmir']);
    expect(p.discord.map((d) => d.id)).toEqual(['286250932470153217']);
    expect(p.connections[0]).toMatchObject({ country: 'GB', asOrg: 'DATACAMP-LIMITED', vpn: true });
    expect(JSON.stringify(p)).not.toContain('198.51.100.4');
    expect(p.medians.find((m) => m.cls === 'hunter claw')?.person).toBe(12);
  });

  it('only an admin bans as same person from an alert', async () => {
    const url = `/api/admin/people/evaders/${personId}/ban-same-person`;
    expect((await post(url, { steamid: NEW })).statusCode).toBe(404); // a moderator
    expect((await post(url, { steamid: NEW }, admin)).statusCode).toBe(200);
    expect(hasActiveBan(db, NEW)).toBe(true);
    expect(personOf(db, 'steam', NEW)?.label).toBe('dethisa');
  });

  it('bans as same person from a fingerprint hold, never from a Discord hold', async () => {
    const f = placeFingerprintHold(db, NEW, personId, EVADER) as { id: number };
    expect((await post(`/api/admin/people/alts/${f.id}/ban-same-person`, {}, admin)).statusCode).toBe(200);
    expect(personOf(db, 'steam', NEW)?.label).toBe('dethisa');
    upsertPlayer(db, { steamid: PLAYER, name: 'other', avatar: null }, []);
    const d = placeAltHold(db, PLAYER, EVADER, '111', 'dethisa')!;
    expect((await post(`/api/admin/people/alts/${d}/ban-same-person`, {}, admin)).statusCode).toBe(409);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/evaderRoutes.test.ts`
Expected: FAIL, `GET /api/admin/people/evaders` is not a route yet (the `GET /api/admin/people/:steamid` handler answers 404 "no such player").

- [ ] **Step 3: Write the view**

Create `src/admin/knownEvaders.ts`:

```ts
import type { DB } from '../db.js';
import { hasActiveBan } from '../banState.js';
import { getPlayer } from '../players.js';
import { membersOf, openPeople } from '../evaderPeople.js';
import { extraVpnAsns, isVpnNetwork } from '../networkKinds.js';
import { BASE_KINDS, BASE_WEAPONS, classLabel, medianHold, pooled } from '../fingerprint.js';
import { cachedPopulation, playerFingerprint } from '../fingerprintData.js';
import { canOpenFile, type FileViewer } from './fileAccess.js';

/**
 * People > Alts > Known evaders: one card per open person.
 *
 * A moderator is shown a person only when every Steam member's file is open
 * to them, as with related-account groups: leaving one member out would
 * point straight at a staff account. Connections are the members'
 * player_networks rows, shown by a hash prefix, country and provider, never
 * an address. The person's hold medians are read live from their members'
 * bursts; the population's come from the fingerprint cache only, so a page
 * view never rebuilds anything (they read "-" until the check has run).
 */

export interface KnownEvader {
  id: number; label: string; note: string; createdAt: string; createdByName: string | null;
  steam: { steamid: string; name: string; banned: boolean; held: boolean; lastSeen: string | null; how: string }[];
  discord: { id: string; how: string }[];
  connections: { ipHash: string; steamid: string; country: string | null; asOrg: string | null; vpn: boolean; lastSeen: string }[];
  medians: { cls: string; person: number | null; population: number | null }[];
  alerts: {
    steamid: string; name: string; level: 'alert' | 'loud' | 'hold'; distance: number; threshold: number; rank: number;
    signs: string[]; matchId: number | null; createdAt: string; banned: boolean;
  }[];
}

function signsOf(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export function knownEvaders(db: DB, viewer: FileViewer, now = new Date()): KnownEvader[] {
  const extra = extraVpnAsns(db);
  const population = cachedPopulation(db);
  const held = new Set((db.prepare('SELECT steamid FROM alt_holds WHERE resolved_at IS NULL').all() as { steamid: string }[]).map((r) => r.steamid));
  const lastSeen = db.prepare('SELECT MAX(last_seen) AS t FROM player_networks WHERE player_id = ?');
  const out: KnownEvader[] = [];
  for (const p of openPeople(db)) {
    const members = membersOf(db, p.id);
    const steamIds = members.filter((m) => m.kind === 'steam').map((m) => m.ident);
    if (!steamIds.every((id) => canOpenFile(db, viewer, id))) continue;
    const nets = steamIds.length === 0 ? [] : db.prepare(
      `SELECT player_id, ip_hash, country, asn, as_org, last_seen FROM player_networks
        WHERE player_id IN (${steamIds.map(() => '?').join(', ')}) ORDER BY last_seen DESC LIMIT 30`,
    ).all(...steamIds) as { player_id: string; ip_hash: string; country: string | null; asn: number | null; as_org: string | null; last_seen: string }[];
    const fp = pooled(steamIds.map((id) => playerFingerprint(db, id)));
    const medians = BASE_KINDS.flatMap((kind) => BASE_WEAPONS.map((w) => `${kind}:${w}`))
      .map((cls) => ({ cls: classLabel(cls), person: medianHold(fp[cls]), population: medianHold(population[cls]) }))
      .filter((m) => m.person !== null || m.population !== null);
    const alerts = (db.prepare(
      `SELECT a.steamid, COALESCE(pl.name, a.steamid) AS name, a.level, a.distance, a.threshold, a.rank, a.signs_json,
              a.match_id, a.created_at
         FROM fingerprint_alerts a LEFT JOIN players pl ON pl.steamid = a.steamid
        WHERE a.person_id = ? ORDER BY a.created_at DESC LIMIT 20`,
    ).all(p.id) as { steamid: string; name: string; level: 'alert' | 'loud' | 'hold'; distance: number; threshold: number; rank: number; signs_json: string; match_id: number | null; created_at: string }[])
      .filter((a) => canOpenFile(db, viewer, a.steamid));
    out.push({
      id: p.id, label: p.label, note: p.note, createdAt: p.createdAt,
      createdByName: p.createdBy === 'system' ? 'system' : getPlayer(db, p.createdBy)?.name ?? null,
      steam: members.filter((m) => m.kind === 'steam').map((m) => ({
        steamid: m.ident, name: getPlayer(db, m.ident)?.name ?? m.ident, how: m.how,
        banned: hasActiveBan(db, m.ident, now) && !held.has(m.ident), held: held.has(m.ident),
        lastSeen: (lastSeen.get(m.ident) as { t: string | null }).t,
      })),
      discord: members.filter((m) => m.kind === 'discord').map((m) => ({ id: m.ident, how: m.how })),
      connections: nets.map((n) => ({
        ipHash: n.ip_hash, steamid: n.player_id, country: n.country, asOrg: n.as_org,
        vpn: isVpnNetwork(n.asn, n.as_org, extra), lastSeen: n.last_seen,
      })),
      medians,
      alerts: alerts.map((a) => ({
        steamid: a.steamid, name: a.name, level: a.level, distance: a.distance, threshold: a.threshold, rank: a.rank,
        signs: signsOf(a.signs_json), matchId: a.match_id, createdAt: a.created_at, banned: hasActiveBan(db, a.steamid, now),
      })),
    });
  }
  return out;
}
```

- [ ] **Step 4: Write the routes**

In `src/routes/people.ts` add imports:

```ts
import { knownEvaders } from '../admin/knownEvaders.js';
import { banAsSamePerson } from '../evaderBan.js';
```

and add after the `/api/admin/people/evaders/:id/close` route:

```ts
  app.get('/api/admin/people/evaders', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    return { people: knownEvaders(db, fileViewer(db, me)) };
  });

  /** "Ban as same person" from a fingerprint alert: an ordinary ban, and the
   *  account (with its Discord) joins the person. An admin's call, like every
   *  ban outside a ticket, so a moderator gets the same 404 as a missing
   *  player. */
  app.post('/api/admin/people/evaders/:id/ban-same-person', async (req, reply) => {
    const me = requireMod(req, reply);
    if (!me) return reply;
    const viewer = fileViewer(db, me);
    const personId = Number((req.params as { id: string }).id);
    const { steamid } = (req.body ?? {}) as { steamid?: unknown };
    if (typeof steamid !== 'string' || !getPlayer(db, steamid) || !canDo(db, viewer, steamid, 'ban')) {
      return reply.code(404).send({ error: 'no such player' });
    }
    const r = banAsSamePerson(db, { steamid, personId, by: me });
    if (r === 'no_person') return reply.code(404).send({ error: 'no such person' });
    if (r !== 'banned') return reply.code(409).send({ error: 'that person record is closed' });
    logAdmin(db, me, 'evader_ban_same', steamid, { personId, label: personById(db, personId)?.label });
    return { ok: true };
  });

  app.post('/api/admin/people/alts/:id/ban-same-person', async (req, reply) => {
    const t = onHold(req, reply, 'ban');
    if (!t) return reply;
    if (t.hold.source !== 'fingerprint' || t.hold.personId === null) {
      return reply.code(409).send({ error: 'only a fingerprint hold names a person' });
    }
    const r = banAsSamePerson(db, { steamid: t.hold.steamid, personId: t.hold.personId, by: t.me, holdId: t.hold.id });
    if (r !== 'banned') return reply.code(409).send({ error: r === 'closed' ? 'that person record is closed' : 'that hold could not be turned into a ban' });
    logAdmin(db, t.me, 'evader_ban_same', t.hold.steamid, { personId: t.hold.personId, holdId: t.hold.id, label: personById(db, t.hold.personId)?.label });
    return { ok: true };
  });
```

In `src/discord/adminFeedPoster.ts` `actionText`, after the `evader_person_close` line from Task 6:

```ts
      case 'evader_ban_same': return `${who} banned ${target} as another account of known evader **${escapeName(String(d.label ?? ''))}**`;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/evaderRoutes.test.ts tests/altHolds.test.ts && npm run typecheck`
Expected: PASS, clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add src/admin/knownEvaders.ts src/routes/people.ts src/discord/adminFeedPoster.ts tests/evaderRoutes.test.ts
git commit -m "Known evaders view with tagged connections and hold medians; ban as same person routes" -- src/admin/knownEvaders.ts src/routes/people.ts src/discord/adminFeedPoster.ts tests/evaderRoutes.test.ts
```

---

### Task 14: Staff UI in People > Alts and the player file

**Files:**
- Create: `web/src/routes/admin/KnownEvaders.tsx`
- Modify: `web/src/api.ts`
- Modify: `web/src/routes/admin/PeopleAlts.tsx`
- Modify: `web/src/routes/admin/file/IdentitySection.tsx`
- Test: `web/src/routes/admin/KnownEvaders.test.tsx`, `web/src/routes/admin/PeopleAlts.test.tsx` (append)

**Interfaces:**
- Consumes: the HTTP routes of Tasks 6 and 13; `SIGN_TEXT`, `SecondSign` from `src/fingerprint.ts` (pure, imported as `'../../../../src/fingerprint'`).
- Produces (web): `KnownEvader` type (mirror of Task 13's), `AltHold` optional fields `source`, `personId`, `personLabel`, `fingerprint`; `peopleApi.evaders`, `createEvader`, `addToPerson`, `removeFromPerson`, `closePerson`, `banSamePerson`, `banHoldSamePerson`; `peopleApi.ipWatch` returns `{ entries }`; `KnownEvaders({ isAdmin })` component. REMOVED: `peopleApi.flagEvader`, `peopleApi.clearEvader`, `EvaderFlag`.

- [ ] **Step 1: Update the API client**

In `web/src/api.ts`:

Replace

```ts
      /** Set while flagged as a ban evader. Optional for an older server. */
      evaderFlag?: EvaderFlag | null;
```

with

```ts
      /** The known evader this account belongs to. Optional for an older server. */
      evaderPerson?: { id: number; label: string; closed: boolean } | null;
      /** Open known evaders, which "Add to person" offers. */
      evaderOptions?: { id: number; label: string }[];
```

In `peopleApi`, replace the three entries `ipWatch`, `flagEvader`, `clearEvader` with:

```ts
  ipWatch: (signal?: AbortSignal) =>
    get<{ entries: WatchEntry[] }>('/api/admin/people/ipwatch', signal),
  evaders: (signal?: AbortSignal) => get<{ people: KnownEvader[] }>('/api/admin/people/evaders', signal),
  createEvader: (label: string, note: string) =>
    post<{ ok: true; id: number }>('/api/admin/people/evaders', { label, note }),
  addToPerson: (steamid: string, to: { personId: number } | { label: string }) =>
    post<{ ok: true; personId: number }>(`/api/admin/people/${encodeURIComponent(steamid)}/evader-person`, to),
  removeFromPerson: (personId: number, kind: 'steam' | 'discord', ident: string) =>
    post<{ ok: true }>(`/api/admin/people/evaders/${personId}/members/remove`, { kind, ident }),
  closePerson: (personId: number) => post<{ ok: true }>(`/api/admin/people/evaders/${personId}/close`),
  banSamePerson: (personId: number, steamid: string) =>
    post<{ ok: true }>(`/api/admin/people/evaders/${personId}/ban-same-person`, { steamid }),
  banHoldSamePerson: (holdId: number) => post<{ ok: true }>(`/api/admin/people/alts/${holdId}/ban-same-person`),
```

(keep `watchIp` and `unwatchIp` as they are).

Replace the `EvaderFlag` interface (and its doc comment) with:

```ts
/** A known evader: one person, every account they were caught on. See
 *  src/evaderPeople.ts and src/admin/knownEvaders.ts. */
export interface KnownEvader {
  id: number; label: string; note: string; createdAt: string; createdByName: string | null;
  steam: { steamid: string; name: string; banned: boolean; held: boolean; lastSeen: string | null; how: string }[];
  discord: { id: string; how: string }[];
  connections: { ipHash: string; steamid: string; country: string | null; asOrg: string | null; vpn: boolean; lastSeen: string }[];
  medians: { cls: string; person: number | null; population: number | null }[];
  alerts: {
    steamid: string; name: string; level: 'alert' | 'loud' | 'hold'; distance: number; threshold: number; rank: number;
    signs: string[]; matchId: number | null; createdAt: string; banned: boolean;
  }[];
}
```

In `export interface AltHold`, after `resolution: ...;` add:

```ts
  /** 'fingerprint': held by the evader fingerprint check. Optional for an older server. */
  source?: 'discord' | 'fingerprint';
  personId?: number | null;
  personLabel?: string | null;
  fingerprint?: { distance: number; rank: number; threshold: number; signs: string[] } | null;
```

- [ ] **Step 2: Write the failing tests**

Create `web/src/routes/admin/KnownEvaders.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import type { KnownEvader } from '../../api';

const { mockPeople } = vi.hoisted(() => ({
  mockPeople: { evaders: vi.fn(), removeFromPerson: vi.fn(), closePerson: vi.fn(), banSamePerson: vi.fn(), createEvader: vi.fn() },
}));

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, peopleApi: { ...actual.peopleApi, ...mockPeople } };
});

const { KnownEvaders } = await import('./KnownEvaders');

const person: KnownEvader = {
  id: 1, label: 'dethisa', note: 'five accounts', createdAt: '2026-10-17T00:00:00.000Z', createdByName: 'system',
  steam: [{ steamid: '76561198129925325', name: 'nepmir', banned: true, held: false, lastSeen: null, how: 'seed' }],
  discord: [{ id: '286250932470153217', how: 'seed' }],
  connections: [{ ipHash: 'abcdef0123456789', steamid: '76561198129925325', country: 'GB', asOrg: 'DATACAMP-LIMITED', vpn: true, lastSeen: '2026-10-16T00:00:00.000Z' }],
  medians: [{ cls: 'hunter claw', person: 12, population: 9 }],
  alerts: [{
    steamid: '76561198000000002', name: 'fresh', level: 'alert', distance: 0.21, threshold: 0.25, rank: 2,
    signs: [], matchId: 900, createdAt: '2026-10-17T21:00:00.000Z', banned: false,
  }],
};

beforeEach(() => {
  for (const f of Object.values(mockPeople)) f.mockReset();
  mockPeople.evaders.mockResolvedValue({ people: [person] });
});
afterEach(() => { cleanup(); });

describe('KnownEvaders', () => {
  it('shows one card per person with accounts, Discords, tagged connections and medians', async () => {
    render(<KnownEvaders isAdmin={false} />);
    expect(await screen.findByText('nepmir')).toBeTruthy();
    // The label heads the card and the medians column.
    expect(screen.getAllByText('dethisa').length).toBe(2);
    expect(screen.getByText('286250932470153217')).toBeTruthy();
    expect(screen.getByText(/DATACAMP-LIMITED/)).toBeTruthy();
    expect(screen.getByText('VPN or hosting')).toBeTruthy();
    expect(screen.getByText('hunter claw')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove from person' })).toBeTruthy();
  });

  it('offers Ban as same person on an alert to admins only', async () => {
    render(<KnownEvaders isAdmin={false} />);
    await screen.findByText('nepmir');
    expect(screen.queryByRole('button', { name: 'Ban as same person' })).toBeNull();
    cleanup();
    render(<KnownEvaders isAdmin />);
    await screen.findByText('nepmir');
    expect(screen.getByRole('button', { name: 'Ban as same person' })).toBeTruthy();
  });
});
```

Append to `web/src/routes/admin/PeopleAlts.test.tsx`: first extend the hoisted mock so the new panel does not reach the network. Replace

```ts
const { mockPeople } = vi.hoisted(() => ({ mockPeople: { alts: vi.fn(), liftHold: vi.fn(), banFromHold: vi.fn() } }));
```

with

```ts
const { mockPeople } = vi.hoisted(() => ({
  mockPeople: { alts: vi.fn(), liftHold: vi.fn(), banFromHold: vi.fn(), banHoldSamePerson: vi.fn(), evaders: vi.fn(), ipWatch: vi.fn() },
}));
```

and in `beforeEach`, after the `alts` line, add:

```ts
  mockPeople.evaders.mockResolvedValue({ people: [] });
  mockPeople.ipWatch.mockResolvedValue({ entries: [] });
```

then add inside `describe('PeopleAlts', ...)`:

```tsx
  it('marks a fingerprint hold, says who it plays like, and offers Ban as same person to admins', async () => {
    const fp: AltHold = {
      ...hold, id: 8, source: 'fingerprint', personId: 1, personLabel: 'dethisa', discordId: '', discordName: '',
      fingerprint: { distance: 0.203, rank: 2, threshold: 0.25, signs: ['vpn'] },
    };
    mockPeople.alts.mockResolvedValue({ open: [fp], settled: [], clusters: [] });
    render(<PeopleAlts isAdmin />);
    expect(await screen.findByText('fingerprint')).toBeTruthy();
    expect(screen.getAllByText('dethisa').length).toBeGreaterThan(0);
    expect(screen.getByText(/distance 0\.203 \(limit 0\.250\)/)).toBeTruthy();
    expect(screen.getByText(/a VPN or hosting connection/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ban as same person' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ban' })).toBeNull();
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run web/src/routes/admin/KnownEvaders.test.tsx web/src/routes/admin/PeopleAlts.test.tsx`
Expected: FAIL, `./KnownEvaders` does not exist, and the fingerprint row is not rendered.

- [ ] **Step 4: Write `web/src/routes/admin/KnownEvaders.tsx`**

```tsx
import { useState } from 'preact/hooks';
import { peopleApi, type KnownEvader } from '../../api';
import { SIGN_TEXT, type SecondSign } from '../../../../src/fingerprint';
import { countryName } from '../../countries';
import { useFetch } from '../../hooks/useFetch';
import { Empty, Panel } from '../../components/bits';
import { fmtTime, useAction, type Run } from './useAction';
import { fileUrl, guideUrl } from './adminRoutes';

const LEVEL_LABEL = { alert: 'fingerprint only', loud: 'fingerprint and a second sign', hold: 'held' } as const;
const signText = (s: string): string => SIGN_TEXT[s as SecondSign] ?? s;

/**
 * Known evaders (src/evaderPeople.ts): one card per person, grouping every
 * account they have been caught on. Members' connections are on the IP watch
 * list, and the person's pooled hold times are what every new account is
 * checked against at the end of each match. A fingerprint alert says "could
 * be them": the guide explains how to read one.
 */
export function KnownEvaders({ isAdmin }: { isAdmin: boolean }) {
  const { data, error: loadError, reload } = useFetch((s) => peopleApi.evaders(s), []);
  const { busy, error, run } = useAction(reload);
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');

  const create = () => run(async () => {
    await peopleApi.createEvader(label.trim(), note.trim());
    setLabel('');
    setNote('');
  });

  return (
    <Panel class="panel--table">
      <h3>Known evaders</h3>
      <p class="muted">
        One card per person who has evaded a ban, with every account they were caught on. Their connections are
        watched, and every new account is checked against how they hold infected buttons at the end of each
        match. <a href={guideUrl('fingerprint')}>How to read a fingerprint alert</a>
      </p>
      {error && <p class="error">{error}</p>}
      {loadError && <Empty>Could not load the known evaders.</Empty>}
      {data && data.people.length === 0 && <Empty>No known evaders.</Empty>}
      {data?.people.map((p) => <EvaderCard key={p.id} p={p} busy={busy} run={run} isAdmin={isAdmin} />)}
      <form class="admin-merge" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <input value={label} placeholder="New person (e.g. dethisa)" aria-label="New person label" maxLength={40}
          onInput={(e) => setLabel((e.target as HTMLInputElement).value)} />
        <input value={note} placeholder="Note" aria-label="Note" maxLength={500}
          onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
        <button class="btn" type="submit" disabled={busy || !label.trim()}>Add person</button>
      </form>
    </Panel>
  );
}

function EvaderCard({ p, busy, run, isAdmin }: { p: KnownEvader; busy: boolean; run: Run; isAdmin: boolean }) {
  return (
    <div class="admin-cluster">
      <p>
        <strong>{p.label}</strong>{p.note && <span class="muted"> {p.note}</span>}{' '}
        <button class="chip" type="button" disabled={busy}
          onClick={() => run(() => peopleApi.closePerson(p.id), {
            title: `Close the record for ${p.label}?`,
            body: 'Their connections stop being watched and new accounts stop being checked against them. The record is kept.',
            confirmLabel: 'Close record',
          })}>Close record</button>
      </p>
      <ul class="admin-list">
        {p.steam.map((s) => (
          <li key={s.steamid}>
            <a href={fileUrl(s.steamid)}>{s.name}</a> <span class="mono muted">{s.steamid}</span>
            {s.held && <> <span class="chip">on hold</span></>}
            {s.banned && <> <span class="admin-status admin-status--banned">banned</span></>}
            <span class="muted"> {s.how}{s.lastSeen ? `, last seen ${fmtTime(s.lastSeen)}` : ''}</span>{' '}
            <button class="chip" type="button" disabled={busy}
              onClick={() => run(() => peopleApi.removeFromPerson(p.id, 'steam', s.steamid), {
                title: `Take ${s.name} off ${p.label}?`,
                body: 'The connections this account put on the watch list stop being watched.',
                confirmLabel: 'Remove',
              })}>Remove from person</button>
          </li>
        ))}
        {p.discord.map((d) => (
          <li key={d.id}>Discord <code>{d.id}</code> <span class="muted">{d.how}</span></li>
        ))}
      </ul>
      {p.connections.length > 0 && (
        <div class="table-wrap">
          <table class="admin-table">
            <thead><tr><th>Connection</th><th>Country</th><th>Provider</th><th>Last seen</th></tr></thead>
            <tbody>
              {p.connections.map((c) => (
                <tr key={`${c.steamid}-${c.ipHash}`}>
                  <td class="mono">{c.ipHash.slice(0, 10)}</td>
                  <td>{c.country ? countryName(c.country) : 'unknown'}</td>
                  <td>{c.asOrg ?? 'unknown'}{c.vpn && <> <span class="chip">VPN or hosting</span></>}</td>
                  <td class="muted">{fmtTime(c.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {p.medians.length > 0 && (
        <div class="table-wrap">
          <table class="admin-table">
            <thead><tr><th>Median hold (ticks)</th><th>{p.label}</th><th>Everyone</th></tr></thead>
            <tbody>
              {p.medians.map((m) => (
                <tr key={m.cls}><td>{m.cls}</td><td>{m.person ?? '-'}</td><td>{m.population ?? '-'}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {p.alerts.length > 0 && (
        <>
          <p><strong>Fingerprint alerts</strong></p>
          <ul class="admin-list">
            {p.alerts.map((a) => (
              <li key={`${a.steamid}-${a.level}`}>
                <a href={fileUrl(a.steamid)}>{a.name}</a>{' '}
                <span class="muted">
                  {LEVEL_LABEL[a.level]}, #{a.rank} nearest, distance {a.distance.toFixed(3)} (limit {a.threshold.toFixed(3)})
                  {a.signs.length > 0 ? `, ${a.signs.map(signText).join(', ')}` : ''}
                  {a.matchId ? `, match #${a.matchId}` : ''}, {fmtTime(a.createdAt)}
                </span>
                {a.banned && <> <span class="admin-status admin-status--banned">banned</span></>}
                {isAdmin && !a.banned && (
                  <>{' '}<button class="btn btn--danger" type="button" disabled={busy}
                    onClick={() => run(() => peopleApi.banSamePerson(p.id, a.steamid), {
                      title: `Ban ${a.name} as ${p.label}?`,
                      body: `A permanent ban, shown on the public ban list as ban evasion. ${a.name} and their Discord join ${p.label}'s record.`,
                      confirmLabel: 'Ban as same person',
                      danger: true,
                    })}>Ban as same person</button></>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Update `web/src/routes/admin/PeopleAlts.tsx`**

Add imports:

```tsx
import { KnownEvaders } from './KnownEvaders';
import { SIGN_TEXT, type SecondSign } from '../../../../src/fingerprint';
```

and below `RESOLUTION_LABEL`:

```tsx
const signText = (s: string): string => SIGN_TEXT[s as SecondSign] ?? s;
```

Inside `PeopleAlts`, after the `ban` action, add:

```tsx
  const banSame = (h: AltHold) => run(() => peopleApi.banHoldSamePerson(h.id), {
    title: `Ban ${h.name} as ${h.personLabel ?? 'the known evader'}?`,
    body: `A permanent ban, shown on the public ban list as ban evasion. ${h.name} and their Discord join `
      + `${h.personLabel ?? 'that person'}'s record, so their connections are watched and their presses join the fingerprint. The hold is closed.`,
    confirmLabel: 'Ban as same person',
    danger: true,
  });
```

Replace `<IpWatchPanel />` with:

```tsx
      <KnownEvaders isAdmin={isAdmin} />

      <IpWatchPanel />
```

Replace the On hold intro paragraph text with:

```tsx
        <p class="muted">
          Held because their Discord account came from another Steam account, or because they hold infected
          buttons like a known evader and a second sign fired (marked fingerprint). They cannot queue or play, and
          the hold is not on the public ban list. Lift it once they have explained, or ban it if it is an alt.
        </p>
```

Replace the table header row with:

```tsx
                <tr><th>Held account</th><th>Why</th><th>Discord</th><th>Held</th><th /></tr>
```

Replace the second `<td>` of each open-hold row (the one showing `h.otherName`) with:

```tsx
                    <td>
                      {h.source === 'fingerprint' ? (
                        <>
                          <span class="chip">fingerprint</span> plays like <strong>{h.personLabel ?? 'a known evader'}</strong>,
                          nearest account <a href={fileUrl(h.otherSteamid)}>{h.otherName}</a>
                          {h.otherBanned && <> <span class="admin-status admin-status--banned">banned</span></>}
                          {h.fingerprint && (
                            <div class="muted">
                              #{h.fingerprint.rank} nearest, distance {h.fingerprint.distance.toFixed(3)} (limit {h.fingerprint.threshold.toFixed(3)})
                              {h.fingerprint.signs.length > 0 ? `; ${h.fingerprint.signs.map(signText).join(', ')}` : ''}
                            </div>
                          )}
                        </>
                      ) : (
                        <>
                          Discord came from <a href={fileUrl(h.otherSteamid)}>{h.otherName}</a>
                          {h.otherBanned && <> <span class="admin-status admin-status--banned">banned</span></>}
                          <div class="mono muted">{h.otherSteamid}</div>
                        </>
                      )}
                    </td>
```

Replace the actions cell's admin button with:

```tsx
                      {isAdmin && (h.source === 'fingerprint'
                        ? <button class="btn btn--danger" disabled={busy} onClick={() => banSame(h)}>Ban as same person</button>
                        : <button class="btn btn--danger" disabled={busy} onClick={() => ban(h)}>Ban</button>)}
```

In `IpWatchPanel`, replace the intro paragraph with:

```tsx
      <p class="muted">
        Every connection a known evader's account uses is watched, including new ones (add an account to a person
        from the Identity section of its file, or on the Known evaders card). Any other account connecting from a
        watched connection pings the mod role in the mod channel. Separately, any account sharing a connection with
        a banned account gets a plain alert. Nothing here bans or holds anyone.
      </p>
```

and delete the whole `{data && data.flags.length > 0 && ( ... )}` block (the "Flagged ban evaders" list).

- [ ] **Step 6: Update `web/src/routes/admin/file/IdentitySection.tsx`**

Replace `const [evaderReason, setEvaderReason] = useState('');` with:

```tsx
  const [personChoice, setPersonChoice] = useState('');
  const [newLabel, setNewLabel] = useState('');
```

Replace the whole `{id.evaderFlag ? ( ... ) : can('looked_at') && ( ... )}` expression with:

```tsx
      {id.evaderPerson ? (
        <p>
          <span class="admin-status admin-status--banned">known evader</span>{' '}
          One of <a href="/admin/people/alts">{id.evaderPerson.label}</a>'s accounts
          {id.evaderPerson.closed ? ' (record closed)' : '. Every connection it uses is on the IP watch list.'}{' '}
          <span class="muted">Remove it from the Known evaders card on Alts.</span>
        </p>
      ) : can('looked_at') && (
        <form class="admin-merge" onSubmit={(e) => {
          e.preventDefault();
          const to = personChoice === 'new' ? { label: newLabel.trim() } : { personId: Number(personChoice) };
          const who = personChoice === 'new' ? newLabel.trim() : (id.evaderOptions ?? []).find((o) => String(o.id) === personChoice)?.label;
          void run(() => peopleApi.addToPerson(d.steamid, to), {
            title: `Add ${d.header.name} to ${who ?? 'that person'}?`,
            body: 'Every connection they have used, and any they use later, goes on the IP watch list, and their presses join the person\'s fingerprint. It does not ban anyone.',
            confirmLabel: 'Add to person',
          }).then(() => { setPersonChoice(''); setNewLabel(''); });
        }}>
          <select value={personChoice} aria-label="Known evader"
            onChange={(e) => setPersonChoice((e.target as HTMLSelectElement).value)}>
            <option value="">Add to person...</option>
            {(id.evaderOptions ?? []).map((o) => <option key={o.id} value={String(o.id)}>{o.label}</option>)}
            <option value="new">New person</option>
          </select>
          {personChoice === 'new' && (
            <input value={newLabel} placeholder="Label (e.g. dethisa)" aria-label="New person label" maxLength={40}
              onInput={(e) => setNewLabel((e.target as HTMLInputElement).value)} />
          )}
          <button class="btn" type="submit"
            disabled={busy || !personChoice || (personChoice === 'new' && !newLabel.trim())}>Add to person</button>
        </form>
      )}
```

In the alt holds list of the same file, replace the `{h.steamid === d.steamid ? ... : ...}` expression inside each `<li>` with:

```tsx
                {h.source === 'fingerprint'
                  ? (h.steamid === d.steamid
                    ? <>Held on a press fingerprint match with <strong>{h.personLabel ?? 'a known evader'}</strong> (nearest account <a href={fileUrl(h.otherSteamid)}>{h.otherName}</a>)</>
                    : <>The nearest account to <a href={fileUrl(h.steamid)}>{h.name}</a>, held on a fingerprint match with {h.personLabel ?? 'a known evader'}</>)
                  : h.steamid === d.steamid
                    ? <>Held because Discord {h.discordName || h.discordId} came from <a href={fileUrl(h.otherSteamid)}>{h.otherName}</a></>
                    : <>Discord {h.discordName || h.discordId} moved from here to <a href={fileUrl(h.steamid)}>{h.name}</a>, which was held</>}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run web/src/routes/admin/ && npm run typecheck`
Expected: PASS, and both typecheck projects clean (no leftover `EvaderFlag`, `flagEvader` or `clearEvader` anywhere: `grep -rnw "EvaderFlag\|flagEvader\|clearEvader\|evaderFlagOf\|evaderFlag" web/src src` prints nothing; `-w` so `migrateEvaderFlags` does not count).

- [ ] **Step 8: Commit**

```bash
git add web/src/api.ts web/src/routes/admin/KnownEvaders.tsx web/src/routes/admin/KnownEvaders.test.tsx web/src/routes/admin/PeopleAlts.tsx web/src/routes/admin/PeopleAlts.test.tsx web/src/routes/admin/file/IdentitySection.tsx
git commit -m "People > Alts: Known evaders cards, fingerprint holds with Ban as same person, Add to person on the file" -- web/src/api.ts web/src/routes/admin/KnownEvaders.tsx web/src/routes/admin/KnownEvaders.test.tsx web/src/routes/admin/PeopleAlts.tsx web/src/routes/admin/PeopleAlts.test.tsx web/src/routes/admin/file/IdentitySection.tsx
```

---

### Task 15: Staff guide section on fingerprint alerts

**Files:**
- Modify: `web/src/routes/admin/StaffGuide.tsx`
- Test: `web/src/routes/admin/StaffGuide.test.tsx` (append)

**Interfaces:**
- Consumes: `SIGN_TEXT`, `SIGN_ORDER`, `SecondSign` from `src/fingerprint.ts`; the post headings from Task 10 ("Fingerprint match", "Fingerprint match with a second sign", "Fingerprint hold").
- Produces: a `#fingerprint` section on `/admin/people/guide` (linked from Known evaders as `guideUrl('fingerprint')`).

- [ ] **Step 1: Write the failing test**

Append inside `describe('StaffGuide', ...)` of `web/src/routes/admin/StaffGuide.test.tsx` (add `import { SIGN_TEXT } from '../../../../src/fingerprint';` at the top):

```tsx
  // A second sign or a fingerprint level the guide cannot explain would reach
  // the mod channel with nothing for a moderator to read.
  it('explains every second sign and every fingerprint post', () => {
    const text = render(<StaffGuide />).container.textContent!;
    for (const s of Object.values(SIGN_TEXT)) expect(text, s).toContain(s);
    for (const head of ['Fingerprint match', 'Fingerprint match with a second sign', 'Fingerprint hold']) {
      expect(text, head).toContain(head);
    }
    expect(text).toContain('not proof');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run web/src/routes/admin/StaffGuide.test.tsx`
Expected: FAIL on the new test.

- [ ] **Step 3: Write the section**

In `web/src/routes/admin/StaffGuide.tsx` add the import:

```tsx
import { SIGN_ORDER, SIGN_TEXT, type SecondSign } from '../../../../src/fingerprint';
```

and above `export function StaffGuide()`:

```tsx
/** One line per second sign. A Record, so a new sign does not compile until
 *  it is explained here. */
const SIGN_HELP: Record<SecondSign, string> = {
  vpn: 'One of their connections comes from a VPN or hosting provider (Datacamp, M247, Vultr and the like). Evaders hide behind these; so do some honest players.',
  fresh_identity: 'The Steam account is under a year old or private, the Discord account is under 90 days old, or the Discord is new to us on a site account under a week old. Private profiles are common: this counts only next to a fingerprint.',
  cheat_flag: 'They have an aimbot, aimlock or newcomer wallhack flag from a match they played.',
  two_members: 'Two or more of the known evader\'s own accounts are among their 10 nearest fingerprints, not just the pooled record.',
  shared_connection: 'They have used a connection one of the evader\'s accounts used. This also posts its own watch-list alert.',
};
```

In the nav list, after `<li><a href="#steam">Steam</a></li>` add:

```tsx
          <li><a href="#fingerprint">Fingerprint alerts</a></li>
```

and after the closing `</Panel>` of `<Panel id="steam">` add:

```tsx
      <Panel id="fingerprint">
        <h3>Fingerprint alerts</h3>
        <p>
          The site times how long every player holds infected buttons: the hunter, smoker and boomer claw, and
          attacks in the air. A hand holds them for a typical length of its own, and no aimbot drives these
          presses, so the pattern follows a person from one Steam account to the next. At the end of every match,
          each new account (under 15 rated matches, or a site account under 30 days old) is compared with every
          known evader on People &gt; Alts.
        </p>
        <dl class="howto-cmds">
          <dt>Fingerprint match</dt>
          <dd>
            The account holds buttons like that evader, and nothing else points at them. Nothing is done to the
            account. Look at the file, the matches and the connections before you decide anything.
          </dd>
          <dt>Fingerprint match with a second sign</dt>
          <dd>The same, plus one of the signs below. It pings the mod role, and nobody is held.</dd>
          <dt>Fingerprint hold</dt>
          <dd>
            A fingerprint match plus a second sign while holds are switched on. The account is on hold until a
            moderator looks: lift it, or (admins) use <strong>Ban as same person</strong>, which bans it and adds it
            and its Discord to the evader's record.
          </dd>
        </dl>
        <p>
          <strong>Reading the numbers.</strong> The distance is 0 for identical hold patterns and 1 for nothing in
          common. "#2 nearest" means one fingerprint on record, out of everyone, is closer to this account than the
          evader's is. The limit is the evader's own: how far their accounts' single matches sit from the rest of
          them. A match needs the evader in the 5 nearest and under that limit.
        </p>
        <p>
          <strong>A fingerprint alone is not proof.</strong> Across the first matches of 183 honest players, the
          evader's record landed in the 5 nearest for about 3% of them. That is why a fingerprint alone only posts,
          and a hold needs one of these as well:
        </p>
        <dl class="howto-cmds">
          {SIGN_ORDER.flatMap((s) => [
            <dt key={`${s}-t`}>{SIGN_TEXT[s]}</dt>,
            <dd key={`${s}-d`}>{SIGN_HELP[s]}</dd>,
          ])}
        </dl>
      </Panel>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run web/src/routes/admin/StaffGuide.test.tsx && npm run typecheck`
Expected: PASS (the existing "every index link lands on a section" test also covers the new anchor).

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/admin/StaffGuide.tsx web/src/routes/admin/StaffGuide.test.tsx
git commit -m "Staff guide: how to read a fingerprint alert, the limit, and each second sign" -- web/src/routes/admin/StaffGuide.tsx web/src/routes/admin/StaffGuide.test.tsx
```

---
### Task 16: Seed the known evaders (script written, not run)

**Files:**
- Create: `src/seedEvaders.ts`
- Create: `scripts/seed-evader-people.ts`
- Test: `tests/evaderSeed.test.ts`

**Interfaces:**
- Consumes: Task 5 (`SEED_PEOPLE`, `SeedPerson`, `createPerson`, `personByLabel`, `addMember`, `AddResult`).
- Produces (`src/seedEvaders.ts`): `interface SeedReport { created: string[]; added: string[]; already: string[]; conflicts: string[] }`, `seedPeople(db, people: readonly SeedPerson[], opts?: { by?: string; now?: Date; dryRun?: boolean }): SeedReport`

`seedPeople` lives in its own file, not in `src/evaderSeed.ts`, because `src/evaderPeople.ts` imports `src/evaderSeed.ts` for the migration and the seed needs `src/evaderPeople.ts`.

- [ ] **Step 1: Write the failing tests**

Create `tests/evaderSeed.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { DETHISA, SEED_PEOPLE, SHOVE } from '../src/evaderSeed.js';
import { seedPeople } from '../src/seedEvaders.js';
import { addMember, createPerson, ensureEvaderSchema, personByLabel, personOf, steamMembersOf } from '../src/evaderPeople.js';
import { player } from './fingerprintFixtures.js';

const PREBAN = '76561198869884852';
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  player(db, PREBAN, 'dethisa (pre-ban)');
});

describe('seedPeople', () => {
  it('writes dethisa and shove with their Steam accounts, the pre-ban name, and Discords', () => {
    const r = seedPeople(db, SEED_PEOPLE);
    expect(r.created).toEqual(['dethisa', 'shove']);
    expect(r.conflicts).toEqual([]);
    const d = personByLabel(db, 'dethisa')!;
    expect(steamMembersOf(db, d.id).sort()).toEqual([...DETHISA.steam, PREBAN].sort());
    for (const id of DETHISA.discord) expect(personOf(db, 'discord', id)?.label).toBe('dethisa');
    for (const id of SHOVE.steam) expect(personOf(db, 'steam', id)?.label).toBe('shove');
  });

  it('is safe to run twice', () => {
    seedPeople(db, SEED_PEOPLE);
    const again = seedPeople(db, SEED_PEOPLE);
    expect(again.created).toEqual([]);
    expect(again.added).toEqual([]);
    expect(again.already.length).toBe(DETHISA.steam.length + 1 + DETHISA.discord.length + SHOVE.steam.length + SHOVE.discord.length);
  });

  it('a dry run reports and writes nothing', () => {
    const r = seedPeople(db, SEED_PEOPLE, { dryRun: true });
    expect(r.created).toEqual(['dethisa', 'shove']);
    expect(personByLabel(db, 'dethisa')).toBeNull();
  });

  it('reports an account already on another person and never moves it', () => {
    const other = createPerson(db, 'someone', '', 'system');
    addMember(db, other, 'steam', DETHISA.steam[0], 'system', 'manual');
    const r = seedPeople(db, SEED_PEOPLE);
    expect(r.conflicts).toEqual([`dethisa steam ${DETHISA.steam[0]}: other_person`]);
    expect(personOf(db, 'steam', DETHISA.steam[0])?.label).toBe('someone');
  });

  it('builds on the person the evader_flags migration made', () => {
    db.prepare("INSERT INTO evader_flags (steamid, reason, created_by, created_at) VALUES (?, 'dethisa', 'x', '2026-10-08T00:00:00.000Z')")
      .run(DETHISA.steam[0]);
    db.exec('DROP TABLE evader_members; DROP TABLE evader_people;');
    ensureEvaderSchema(db);
    const r = seedPeople(db, SEED_PEOPLE);
    expect(r.created).toEqual(['shove']);
    expect(r.already).toContain(`dethisa steam ${DETHISA.steam[0]}`);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/evaderSeed.test.ts`
Expected: FAIL, cannot resolve `../src/seedEvaders.js`.

- [ ] **Step 3: Write the implementation**

Create `src/seedEvaders.ts`:

```ts
import type { DB } from './db.js';
import { addMember, createPerson, personByLabel, type AddResult } from './evaderPeople.js';
import type { SeedPerson } from './evaderSeed.js';

/**
 * Write the seed people (src/evaderSeed.ts). One transaction; a dry run rolls
 * it back and only reports. Idempotent: a person that exists is built on (the
 * evader_flags migration may already have made dethisa), and an account
 * already on a DIFFERENT person is reported as a conflict, never moved.
 */

export interface SeedReport { created: string[]; added: string[]; already: string[]; conflicts: string[] }

export function seedPeople(
  db: DB, people: readonly SeedPerson[], opts: { by?: string; now?: Date; dryRun?: boolean } = {},
): SeedReport {
  const by = opts.by ?? 'system';
  const now = opts.now ?? new Date();
  const report: SeedReport = { created: [], added: [], already: [], conflicts: [] };
  const note = (r: AddResult, what: string) => {
    if (r === 'added') report.added.push(what);
    else if (r === 'already') report.already.push(what);
    else report.conflicts.push(`${what}: ${r}`);
  };
  const ROLLBACK = Symbol('dry run');
  const run = db.transaction(() => {
    for (const p of people) {
      let id = personByLabel(db, p.label)?.id;
      if (id === undefined) {
        id = createPerson(db, p.label, p.note, by, now);
        report.created.push(p.label);
      }
      const byName = p.steamByName.flatMap((n) =>
        (db.prepare('SELECT steamid FROM players WHERE name = ? ORDER BY steamid').all(n) as { steamid: string }[]).map((r) => r.steamid));
      for (const steamid of [...new Set([...p.steam, ...byName])]) note(addMember(db, id, 'steam', steamid, by, 'seed', now), `${p.label} steam ${steamid}`);
      for (const d of p.discord) note(addMember(db, id, 'discord', d, by, 'seed', now), `${p.label} discord ${d}`);
    }
    if (opts.dryRun) throw ROLLBACK;
  });
  try {
    run();
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
  return report;
}
```

Create `scripts/seed-evader-people.ts`:

```ts
// One-off: write the known evaders in src/evaderSeed.ts (dethisa, shove) as
// person records. Spec: docs/superpowers/specs/2026-10-17-evader-fingerprints-design.md
//
//   # dry run: prints what it would do and changes nothing
//   sudo -u pug bash -c 'set -a; . .env; set +a; node_modules/.bin/tsx scripts/seed-evader-people.ts'
//
//   # do it: only with the owner's go-ahead, and after a DB backup
//   ... scripts/seed-evader-people.ts --commit
//
// --db PATH points it at another database (a local copy, for a rehearsal).
// Safe to run twice. Exit code 1 when an account was already on a different
// person (reported, never moved).
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { SEED_PEOPLE } from '../src/evaderSeed.js';
import { seedPeople } from '../src/seedEvaders.js';

const args = process.argv.slice(2);
const commit = args.includes('--commit');
const at = args.indexOf('--db');
const path = at >= 0 && args[at + 1] ? args[at + 1] : loadConfig().dbPath;
const db = openDb(path);
const r = seedPeople(db, SEED_PEOPLE, { dryRun: !commit });
console.log(`${commit ? 'Seeded' : 'Dry run, nothing written'}: ${path}`);
for (const [k, v] of Object.entries(r) as [string, string[]][]) {
  console.log(`  ${k}: ${v.length}`);
  for (const line of v) console.log(`    ${line}`);
}
db.close();
if (r.conflicts.length > 0) process.exitCode = 1;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/evaderSeed.test.ts`
Expected: PASS. Rehearse the script on a throwaway database only: `npx tsx scripts/seed-evader-people.ts --db "$(mktemp -d)/rehearsal.db"` prints a dry run with `created: 2`. Do NOT run it against production.

- [ ] **Step 5: Commit**

```bash
git add src/seedEvaders.ts scripts/seed-evader-people.ts tests/evaderSeed.test.ts
git commit -m "Seed script for the known evaders (dethisa, shove): dry run by default, idempotent" -- src/seedEvaders.ts scripts/seed-evader-people.ts tests/evaderSeed.test.ts
```

---

### Task 17: ASN backfill from the in-game chat logs (script written, not run)

**Files:**
- Create: `src/asnBackfill.ts`
- Create: `scripts/backfill-network-asn.ts`
- Test: `tests/asnBackfill.test.ts`

**Interfaces:**
- Consumes: Task 2 (`AsnLookup`, `loadAsnFile`, `parseIp2AsnTsv`), Task 4 (`asn`/`as_org` columns); `hashIp` (`src/playerNetworks.ts`), `steamId64Of` (`src/steamId.ts`), `getSetting`.
- Produces (`src/asnBackfill.ts`): `CHAT_LOG_NAME: RegExp`, `parseChatJoinLine(line): { steamid: string; ip: string } | null`, `chatLogLines(dir): Generator<string>`, `interface BackfillReport { lines: number; joins: number; addresses: number; matchedAddresses: number; updatedRows: number; unresolved: number }`, `backfillNetworkAsn(db, lines: Iterable<string>, table: AsnLookup, opts?: { dryRun?: boolean }): BackfillReport`

Chat log lines look like `[23:16:32] (STEAM_1:1:84829798   | 142.111.152.210) name has joined.` in `addons/sourcemod/logs/chat/server_27015_chat_YYYY_MM_DD.log` (or `.log.gz`) on each box. Addresses live only in memory while the script runs; nothing it prints or writes contains one.

- [ ] **Step 1: Write the failing tests**

Create `tests/asnBackfill.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { openDb, type DB } from '../src/db.js';
import { recordPlayerNet } from '../src/playerNetworks.js';
import { parseIp2AsnTsv } from '../src/asnTable.js';
import { backfillNetworkAsn, chatLogLines, parseChatJoinLine } from '../src/asnBackfill.js';

const table = parseIp2AsnTsv(readFileSync(join(import.meta.dirname, 'fixtures/ip2asn-v4-sample.tsv'), 'utf8'));
const A = '76561198000000001';
const B = '76561198000000002';
const C = '76561198000000003';
const joinLine = (steam2: string, ip: string) => `[23:16:32] (${steam2}   | ${ip}) somebody has joined.`;
let db: DB;

beforeEach(() => { db = openDb(':memory:'); });

const asnOf = (steamid: string) =>
  (db.prepare('SELECT asn, as_org FROM player_networks WHERE player_id = ?').get(steamid) as { asn: number | null; as_org: string | null });

describe('parseChatJoinLine', () => {
  it('reads the SteamID and address off a join line', () => {
    expect(parseChatJoinLine('[23:16:32] (STEAM_1:1:84829798   | 142.111.152.210) name has joined.'))
      .toEqual({ steamid: '76561198129925325', ip: '142.111.152.210' });
  });

  it('ignores chat and malformed lines', () => {
    expect(parseChatJoinLine('[23:17:01] name: gg')).toBeNull();
    expect(parseChatJoinLine('[23:17:01] (STEAM_1:0:1 | not-an-ip) name has joined.')).toBeNull();
  });
});

describe('backfillNetworkAsn', () => {
  beforeEach(() => {
    recordPlayerNet(db, { steamid: A, ip: '198.51.100.4', country: 'GB' }, new Date(), null);
    recordPlayerNet(db, { steamid: B, ip: '198.51.100.4', country: 'GB' }, new Date(), null);
    recordPlayerNet(db, { steamid: C, ip: '203.0.113.200', country: 'US' }, new Date(), null);
  });
  const lines = [joinLine('STEAM_1:0:1', '198.51.100.4'), joinLine('STEAM_1:0:2', '203.0.113.200'), joinLine('STEAM_1:0:3', '45.76.1.1'), 'noise'];

  it('fills every row on a logged address and leaves the rest unknown', () => {
    const r = backfillNetworkAsn(db, lines, table);
    expect(r).toEqual({ lines: 4, joins: 3, addresses: 3, matchedAddresses: 2, updatedRows: 2, unresolved: 1 });
    expect(asnOf(A)).toEqual({ asn: 212238, as_org: 'DATACAMP-LIMITED' });
    expect(asnOf(B).asn).toBe(212238);
    expect(asnOf(C)).toEqual({ asn: null, as_org: null }); // logged, but no range covers it
    expect(JSON.stringify(db.prepare('SELECT * FROM player_networks').all())).not.toContain('198.51.100.4');
  });

  it('never overwrites a provider already known, and a dry run writes nothing', () => {
    expect(backfillNetworkAsn(db, lines, table, { dryRun: true }).updatedRows).toBe(2);
    expect(asnOf(A).asn).toBeNull();
    db.prepare("UPDATE player_networks SET asn = 1, as_org = 'KEPT' WHERE player_id = ?").run(A);
    expect(backfillNetworkAsn(db, lines, table).updatedRows).toBe(1);
    expect(asnOf(A)).toEqual({ asn: 1, as_org: 'KEPT' });
  });

  it('refuses a database that has never hashed an address', () => {
    expect(() => backfillNetworkAsn(openDb(':memory:'), lines, table)).toThrow(/ip_hash_salt/);
  });
});

describe('chatLogLines', () => {
  it('reads plain and gzipped chat logs and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-'));
    writeFileSync(join(dir, 'server_27015_chat_2026_10_16.log'), 'one\ntwo\n');
    writeFileSync(join(dir, 'server_27015_chat_2026_10_17.log.gz'), gzipSync('three\n'));
    writeFileSync(join(dir, 'errors_20261017.log'), 'nope\n');
    expect([...chatLogLines(dir)].filter(Boolean)).toEqual(['one', 'two', 'three']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/asnBackfill.test.ts`
Expected: FAIL, cannot resolve `../src/asnBackfill.js`.

- [ ] **Step 3: Write the implementation**

Create `src/asnBackfill.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { DB } from './db.js';
import type { AsnLookup } from './asnTable.js';
import { hashIp } from './playerNetworks.js';
import { getSetting } from './settings.js';
import { steamId64Of } from './steamId.js';

/**
 * One-off backfill of player_networks.asn / as_org for connections recorded
 * before the network tag existed (spec section 1, "Backfill").
 *
 * Those rows have no address to look up: only the salted hash was ever kept.
 * The in-game chat logs on every box do carry raw addresses on each join line,
 * so each logged address is hashed with THIS install's salt, matched to
 * player_networks, and every row on that hash gets the provider. A row no log
 * line matches stays NULL, which reads as "unknown", never "residential".
 *
 * Addresses are held in memory for the run and never written or printed.
 */

const JOIN_LINE = /\((STEAM_\d:[01]:\d{1,10})\s*\|\s*(\d{1,3}(?:\.\d{1,3}){3})\)/;
export const CHAT_LOG_NAME = /^server_\d+_chat_\d{4}_\d{2}_\d{2}\.log(\.gz)?$/;

export function parseChatJoinLine(line: string): { steamid: string; ip: string } | null {
  const m = JOIN_LINE.exec(line);
  if (!m) return null;
  const steamid = steamId64Of(m[1]);
  return steamid ? { steamid, ip: m[2] } : null;
}

export function* chatLogLines(dir: string): Generator<string> {
  for (const name of readdirSync(dir).filter((n) => CHAT_LOG_NAME.test(n)).sort()) {
    const buf = readFileSync(join(dir, name));
    yield* (name.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8').split('\n');
  }
}

export interface BackfillReport {
  lines: number; joins: number;
  /** Distinct addresses in the logs. */
  addresses: number;
  /** Of those, how many match a player_networks hash. */
  matchedAddresses: number;
  updatedRows: number;
  /** Matched, but no range in the table covers the address. */
  unresolved: number;
}

export function backfillNetworkAsn(
  db: DB, lines: Iterable<string>, table: AsnLookup, opts: { dryRun?: boolean } = {},
): BackfillReport {
  // hashIp would mint a fresh salt on a database without one, and every hash
  // would then match nothing while looking like it worked.
  if (!getSetting(db, 'ip_hash_salt')) {
    throw new Error('this database has no ip_hash_salt: it has never recorded a connection, so nothing can match');
  }
  const report: BackfillReport = { lines: 0, joins: 0, addresses: 0, matchedAddresses: 0, updatedRows: 0, unresolved: 0 };
  const ips = new Set<string>();
  for (const line of lines) {
    report.lines += 1;
    const j = parseChatJoinLine(line);
    if (!j) continue;
    report.joins += 1;
    ips.add(j.ip);
  }
  report.addresses = ips.size;
  const count = db.prepare('SELECT COUNT(*) AS n FROM player_networks WHERE ip_hash = ?');
  const update = db.prepare('UPDATE player_networks SET asn = ?, as_org = ? WHERE ip_hash = ? AND asn IS NULL');
  const ROLLBACK = Symbol('dry run');
  const run = db.transaction(() => {
    for (const ip of ips) {
      const h = hashIp(db, ip);
      if ((count.get(h) as { n: number }).n === 0) continue;
      report.matchedAddresses += 1;
      const hit = table.lookup(ip);
      if (!hit) { report.unresolved += 1; continue; }
      report.updatedRows += update.run(hit.asn, hit.org, h).changes;
    }
    if (opts.dryRun) throw ROLLBACK;
  });
  try {
    run();
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  } finally {
    ips.clear();
  }
  return report;
}
```

Create `scripts/backfill-network-asn.ts`:

```ts
// One-off: tag connections recorded before the network tag with their AS
// number and provider, from the raw addresses in the game servers' chat logs.
// Spec: docs/superpowers/specs/2026-10-17-evader-fingerprints-design.md
//
//   # 1. copy each box's chat logs here first (read-only on the box), e.g.
//   #    rsync -a <box>:<srcds>/left4dead/addons/sourcemod/logs/chat/ chatlogs/<box>/
//   # 2. dry run against the site database (owner go-ahead, after a DB backup)
//   sudo -u pug bash -c 'set -a; . .env; set +a; node_modules/.bin/tsx scripts/backfill-network-asn.ts \
//       --asn data/ip2asn-v4.tsv.gz --logs chatlogs/dallas --logs chatlogs/riverside1 --logs chatlogs/riverside2'
//   # 3. the same with --commit
//
// It must run against the database whose salt hashed the rows (the site's,
// or a copy of it): any other salt matches nothing. --db PATH overrides the
// configured database. No address is ever printed or written.
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { loadAsnFile } from '../src/asnTable.js';
import { backfillNetworkAsn, chatLogLines } from '../src/asnBackfill.js';

const args = process.argv.slice(2);
const values = (name: string): string[] => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
const asnPath = values('--asn')[0];
const dirs = values('--logs');
if (!asnPath || dirs.length === 0) {
  console.error('usage: backfill-network-asn.ts --asn <ip2asn-v4.tsv.gz> --logs <dir> [--logs <dir>...] [--db PATH] [--commit]');
  process.exit(2);
}
const commit = args.includes('--commit');
const path = values('--db')[0] ?? loadConfig().dbPath;
const db = openDb(path);
const table = loadAsnFile(asnPath);
function* allLines(): Generator<string> { for (const d of dirs) yield* chatLogLines(d); }
const r = backfillNetworkAsn(db, allLines(), table, { dryRun: !commit });
console.log(`${commit ? 'Backfilled' : 'Dry run, nothing written'}: ${path} (${table.size} ranges)`);
console.log(`  ${r.lines} log lines, ${r.joins} joins, ${r.addresses} distinct addresses`);
console.log(`  ${r.matchedAddresses} match a recorded connection, ${r.unresolved} of them in no range`);
console.log(`  ${r.updatedRows} rows ${commit ? 'tagged' : 'would be tagged'}`);
db.close();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/asnBackfill.test.ts`
Expected: PASS. Do NOT run the script against production.

- [ ] **Step 5: Commit**

```bash
git add src/asnBackfill.ts scripts/backfill-network-asn.ts tests/asnBackfill.test.ts
git commit -m "ASN backfill from chat-log join lines: hashes with the install salt, never keeps an address" -- src/asnBackfill.ts scripts/backfill-network-asn.ts tests/asnBackfill.test.ts
```

---

### Task 18: History replay (script written, run only on a local copy)

**Files:**
- Create: `src/fingerprintReplay.ts`
- Create: `scripts/fingerprint-replay.ts`
- Modify: `tests/matchKindGuard.test.ts` (allowlist the replay's one raw filter)
- Test: `tests/fingerprintReplay.test.ts`

**Interfaces:**
- Consumes: Task 1 (`addBurst`, `mergeInto`, `pooled`, `holdTotal`, `matchPersons`, `personThreshold`, `MIN_CANDIDATE_HOLDS`, `TOP_RANK`), Task 7 (`BASE_BURST_SQL`), Task 9 (`activeBanAt`, `isNewAccount`, `secondSigns`, `dbTimeMs`), Task 3 (`extraVpnAsns`), Task 5 (`SEED_PEOPLE`, `REPLAY_REQUIRED`).
- Produces (`src/fingerprintReplay.ts`):
  - `weekOf(at: Date): string` (Monday, `YYYY-MM-DD`, UTC)
  - `interface ReplayPerson { label: string; steam: readonly string[] }`
  - `interface ReplayOptions { people: readonly ReplayPerson[]; exclude: ReadonlySet<string>; asnLoaded: boolean }`
  - `interface ReplayEvent { matchId: number; at: string; steamid: string; person: string; level: 'alert' | 'hold'; distance: number; threshold: number; rank: number; signs: SecondSign[]; honest: boolean }`
  - `interface ReplayWeek { week: string; alerts: number; holds: number; honestAlerts: number; honestHolds: number }`
  - `interface ReplayReport { matches: number; candidateChecks: number; events: ReplayEvent[]; weeks: ReplayWeek[]; excluded: { steamid: string; level: 'alert' | 'hold' | null; matchId: number | null }[]; honestTop5Rate: number | null; ms: number }`
  - `replayHistory(db, opts): ReplayReport`

The replay walks match ends in order and accumulates fingerprints as it goes, so every decision sees only what existed at that match end. It reports as if the setting were `full`. People are the seed minus `exclude`. Known limits, printed with the report: membership is the seed as of today (not as accounts were discovered); Steam privacy and Discord links are as of today.

- [ ] **Step 1: Write the failing tests**

Create `tests/fingerprintReplay.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { replayHistory, weekOf } from '../src/fingerprintReplay.js';
import { endedMatch, playMatch } from './fingerprintFixtures.js';

// One member only: two identical members would both sit in ALT's top 10 and
// fire second sign 4 on their own.
const M1 = '76561198000000001';
const ALT = '76561198000000003';
const HONEST = [5, 6, 15, 16].map((peak, i) => ({ id: `765611980000001${10 + i}`, peak }));
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  for (const m of [1, 2, 3]) {
    endedMatch(db, m, `2026-10-0${m} 20:00:00`);
    playMatch(db, M1, m, 10, 60, `2026-10-0${m}T19:00:00.000Z`);
    for (const h of HONEST) playMatch(db, h.id, m, h.peak, 40, `2026-10-0${m}T19:00:00.000Z`);
  }
  endedMatch(db, 4, '2026-10-04 20:00:00');
  playMatch(db, ALT, 4, 10, 80, '2026-10-04T19:00:00.000Z');
});

const people = [{ label: 'dethisa', steam: [M1, ALT] }];

describe('weekOf', () => {
  it('names the Monday of the week, UTC', () => {
    expect(weekOf(new Date('2026-10-04T20:00:00Z'))).toBe('2026-09-28'); // a Sunday
    expect(weekOf(new Date('2026-10-05T00:00:00Z'))).toBe('2026-10-05'); // a Monday
  });
});

describe('replayHistory', () => {
  it('catches an account taken out of the seed, at the match it first qualified', () => {
    const r = replayHistory(db, { people, exclude: new Set([ALT]), asnLoaded: false });
    expect(r.matches).toBe(4);
    expect(r.excluded).toEqual([{ steamid: ALT, level: 'alert', matchId: 4 }]);
    expect(r.events.filter((e) => e.honest)).toEqual([]);
    expect(r.weeks).toContainEqual({ week: '2026-09-28', alerts: 1, holds: 0, honestAlerts: 0, honestHolds: 0 });
    expect(r.honestTop5Rate === null || (r.honestTop5Rate >= 0 && r.honestTop5Rate <= 1)).toBe(true);
  });

  it('a second sign seen by then makes it a hold', () => {
    db.prepare("INSERT INTO integrity_flags (match_id, steamid, source, kind, severity, at) VALUES (4, ?, 'lilac', 'aimbot', 'suspected', '2026-10-04T19:30:00.000Z')").run(ALT);
    const r = replayHistory(db, { people, exclude: new Set([ALT]), asnLoaded: false });
    expect(r.excluded[0].level).toBe('hold');
    expect(r.events[0].signs).toEqual(['cheat_flag']);
  });

  it('a member is never a candidate, and an account banned by then is skipped', () => {
    expect(replayHistory(db, { people, exclude: new Set(), asnLoaded: false }).events).toEqual([]);
    db.prepare("INSERT INTO players (steamid, name) VALUES (?, 'alt')").run(ALT);
    db.prepare("INSERT INTO bans (player_id, reason, created_by, created_at, kind) VALUES (?, 'x', 'x', '2026-10-03T00:00:00.000Z', 'ban')").run(ALT);
    expect(replayHistory(db, { people, exclude: new Set([ALT]), asnLoaded: false }).excluded[0].level).toBeNull();
  });

  it('never writes to the database it reads', () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM fingerprint_cache').get();
    replayHistory(db, { people, exclude: new Set([ALT]), asnLoaded: false });
    expect(db.prepare('SELECT COUNT(*) AS n FROM fingerprint_cache').get()).toEqual(before);
    expect((db.prepare('SELECT COUNT(*) AS n FROM fingerprint_alerts').get() as { n: number }).n).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/fingerprintReplay.test.ts`
Expected: FAIL, cannot resolve `../src/fingerprintReplay.js`.

- [ ] **Step 3: Write the implementation**

Create `src/fingerprintReplay.ts`:

```ts
import type { DB } from './db.js';
import {
  MIN_CANDIDATE_HOLDS, TOP_RANK, addBurst, holdTotal, matchPersons, mergeInto, personThreshold, pooled,
  type BurstHoldRow, type FieldEntry, type Fingerprint, type PersonModel, type SecondSign,
} from './fingerprint.js';
import { BASE_BURST_SQL } from './fingerprintData.js';
import { activeBanAt, dbTimeMs, isNewAccount, secondSigns } from './fingerprintSigns.js';
import { extraVpnAsns } from './networkKinds.js';

/**
 * What the evader fingerprint rules would have done over everything on
 * record (spec section 5). Required before the setting goes on: with
 * indianstreetfood taken out of the dethisa seed, the replay must alert or
 * hold indianstreetfood; likewise nepmir. It also counts honest alerts and
 * holds per week, where the target is near zero holds.
 *
 * Read-only: fingerprints are accumulated in memory as match ends go by, so
 * each decision sees only what existed then, and nothing is written. It is
 * still only ever run on a COPY (scripts/fingerprint-replay.ts makes one).
 * Decisions are as if the setting were 'full'.
 */

export interface ReplayPerson { label: string; steam: readonly string[] }
export interface ReplayOptions { people: readonly ReplayPerson[]; exclude: ReadonlySet<string>; asnLoaded: boolean }
export interface ReplayEvent {
  matchId: number; at: string; steamid: string; person: string; level: 'alert' | 'hold';
  distance: number; threshold: number; rank: number; signs: SecondSign[]; honest: boolean;
}
export interface ReplayWeek { week: string; alerts: number; holds: number; honestAlerts: number; honestHolds: number }
export interface ReplayReport {
  matches: number;
  candidateChecks: number;
  events: ReplayEvent[];
  weeks: ReplayWeek[];
  /** Each excluded account: the highest level it reached and the match it first fired at. */
  excluded: { steamid: string; level: 'alert' | 'hold' | null; matchId: number | null }[];
  /** Share of honest candidates (first check with enough data) that had any
   *  person in their top 5, threshold aside. The spec's baseline is 3%. */
  honestTop5Rate: number | null;
  ms: number;
}

export function weekOf(at: Date): string {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function entry<K, V>(map: Map<K, V>, key: K, init: () => V): V {
  let v = map.get(key);
  if (v === undefined) { v = init(); map.set(key, v); }
  return v;
}

export function replayHistory(db: DB, opts: ReplayOptions): ReplayReport {
  const started = Date.now();
  const matches = db.prepare(
    `SELECT id, COALESCE(ended_at, created_at) AS endedAt FROM matches
      WHERE state IN ('completed', 'aborted') ORDER BY COALESCE(ended_at, created_at), id`,
  ).all() as { id: number; endedAt: string }[];
  const burstsOf = db.prepare(`SELECT steamid, kind, weapon, holds FROM input_bursts WHERE match_id = ? AND ${BASE_BURST_SQL}`);
  const whole = new Map<string, Fingerprint>();
  const perMatch = new Map<string, Fingerprint[]>();
  const people = opts.people.map((p, i) => ({ id: i + 1, label: p.label, members: p.steam.filter((s) => !opts.exclude.has(s)) }));
  const members = new Set(people.flatMap((p) => p.members));
  const known = new Set(opts.people.flatMap((p) => p.steam));
  const extraVpn = extraVpnAsns(db);
  const fired = new Map<string, { level: 'alert' | 'hold'; matchId: number }>();
  const events: ReplayEvent[] = [];
  const firstChecked = new Set<string>();
  let candidateChecks = 0;
  let honestChecks = 0;
  let honestTop5 = 0;

  for (const m of matches) {
    const ms = dbTimeMs(m.endedAt);
    if (ms === null) continue;
    const at = new Date(ms);
    const thisMatch = new Map<string, Fingerprint>();
    for (const r of burstsOf.iterate(m.id) as IterableIterator<BurstHoldRow & { steamid: string }>) {
      addBurst(entry(thisMatch, r.steamid, () => ({})), r);
    }
    for (const [id, fp] of thisMatch) {
      mergeInto(entry(whole, id, () => ({})), fp);
      entry(perMatch, id, () => []).push(fp);
    }
    const models: PersonModel[] = people.map((p) => ({
      id: p.id, label: p.label, members: p.members,
      pooled: pooled(p.members.map((id) => whole.get(id) ?? {})),
      threshold: personThreshold(p.members.flatMap((id) => perMatch.get(id) ?? [])),
    }));
    const field: FieldEntry[] = [
      ...[...whole].filter(([, fp]) => holdTotal(fp) >= MIN_CANDIDATE_HOLDS).map(([id, fp]) => ({ subject: `steam:${id}`, fp })),
      ...models.map((p) => ({ subject: `person:${p.id}`, fp: p.pooled })),
    ];
    for (const steamid of thisMatch.keys()) {
      if (members.has(steamid) || activeBanAt(db, steamid, at) || !isNewAccount(db, steamid, at)) continue;
      const hits = matchPersons(whole.get(steamid)!, steamid, field, models);
      if (hits.length === 0) continue;
      candidateChecks += 1;
      const honest = !known.has(steamid);
      if (honest && !firstChecked.has(steamid)) {
        firstChecked.add(steamid);
        honestChecks += 1;
        if (hits.some((h) => h.rank <= TOP_RANK)) honestTop5 += 1;
      }
      for (const hit of hits) {
        if (!hit.matched) continue;
        const person = models.find((p) => p.id === hit.personId)!;
        if (person.members.length === 0) continue;
        const signs = secondSigns(db, steamid, { members: person.members, membersInTop10: hit.membersInTop10, asnLoaded: opts.asnLoaded, extraVpn }, at);
        const level: 'alert' | 'hold' = signs.length > 0 ? 'hold' : 'alert';
        const key = `${steamid}/${person.id}`;
        const before = fired.get(key);
        if (before && (before.level === 'hold' || before.level === level)) continue;
        fired.set(key, { level, matchId: before?.matchId ?? m.id });
        events.push({
          matchId: m.id, at: at.toISOString(), steamid, person: person.label, level,
          distance: hit.distance, threshold: hit.threshold, rank: hit.rank, signs, honest,
        });
      }
    }
  }

  const weeks = new Map<string, ReplayWeek>();
  for (const e of events) {
    const w = entry(weeks, weekOf(new Date(e.at)), () => ({ week: weekOf(new Date(e.at)), alerts: 0, holds: 0, honestAlerts: 0, honestHolds: 0 }));
    if (e.level === 'alert') { w.alerts += 1; if (e.honest) w.honestAlerts += 1; }
    else { w.holds += 1; if (e.honest) w.honestHolds += 1; }
  }
  const excluded = [...opts.exclude].map((steamid) => {
    const mine = events.filter((e) => e.steamid === steamid);
    const level = mine.some((e) => e.level === 'hold') ? 'hold' as const : mine.length > 0 ? 'alert' as const : null;
    return { steamid, level, matchId: mine[0]?.matchId ?? null };
  });
  return {
    matches: matches.length, candidateChecks, events,
    weeks: [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week)),
    excluded, honestTop5Rate: honestChecks > 0 ? honestTop5 / honestChecks : null, ms: Date.now() - started,
  };
}
```

Create `scripts/fingerprint-replay.ts`:

```ts
// History replay for the evader fingerprint (spec section 5): what every rule
// would have done at every match end on record, as if the setting were 'full'.
// Spec: docs/superpowers/specs/2026-10-17-evader-fingerprints-design.md
//
// NEVER against the live database. Give it a backup copy; it then copies that
// again through SQLite's backup API from a read-only handle, works only on the
// second copy, and deletes it at the end. It refuses the path in DB_PATH.
//
//   npx tsx scripts/fingerprint-replay.ts --db /path/to/pug-backup.db --required
//   npx tsx scripts/fingerprint-replay.ts --db /path/to/pug-backup.db [--exclude <steamid>]... [--json]
//
// --required runs the two checks the spec needs before the setting goes on:
// indianstreetfood and nepmir, each taken out of the dethisa seed, must come
// out at least as an alert. Exit code 1 if either does not. The numbers go to
// the owner before anything is turned on.
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb } from '../src/db.js';
import { REPLAY_REQUIRED, SEED_PEOPLE } from '../src/evaderSeed.js';
import { replayHistory, type ReplayReport } from '../src/fingerprintReplay.js';

const args = process.argv.slice(2);
const values = (name: string): string[] => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
const src = values('--db')[0];
if (!src) {
  console.error('usage: fingerprint-replay.ts --db <backup copy> [--required] [--exclude <steamid>]... [--json]');
  process.exit(2);
}
if (process.env.DB_PATH && resolve(src) === resolve(process.env.DB_PATH)) {
  console.error(`refusing: ${src} is DB_PATH, the live database. Give it a backup copy.`);
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'fp-replay-'));
const copy = join(dir, 'replay.db');
const source = new Database(src, { readonly: true, fileMustExist: true });
await source.backup(copy);
source.close();
const db = openDb(copy);

const byName = (names: readonly string[]) => names.flatMap((n) =>
  (db.prepare('SELECT steamid FROM players WHERE name = ?').all(n) as { steamid: string }[]).map((r) => r.steamid));
const people = SEED_PEOPLE.map((p) => ({ label: p.label, steam: [...new Set([...p.steam, ...byName(p.steamByName)])] }));
const asnLoaded = (db.prepare('SELECT COUNT(*) AS n FROM player_networks WHERE asn IS NOT NULL').get() as { n: number }).n > 0;
const runs = args.includes('--required')
  ? REPLAY_REQUIRED.map((r) => ({ title: `${r.name} taken out of the seed`, exclude: [r.steamid], expect: r.steamid as string | null }))
  : [{ title: 'replay', exclude: values('--exclude'), expect: null as string | null }];

let failed = false;
for (const run of runs) {
  const r = replayHistory(db, { people, exclude: new Set(run.exclude), asnLoaded });
  print(run.title, r);
  if (run.expect) {
    const caught = r.excluded.find((e) => e.steamid === run.expect);
    if (caught?.level) {
      console.log(`PASS: caught as ${caught.level} at match ${caught.matchId}`);
    } else {
      console.log('FAIL: never alerted');
      failed = true;
    }
  }
}
db.close();
rmSync(dir, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;

function print(title: string, r: ReplayReport): void {
  if (args.includes('--json')) {
    console.log(JSON.stringify({ title, ...r }, null, 2));
    return;
  }
  console.log(`\n== ${title} ==`);
  console.log(`${r.matches} match ends, ${r.candidateChecks} candidate checks, ${(r.ms / 1000).toFixed(1)} s`
    + (asnLoaded ? '' : ' (no ASN data in this copy: the VPN sign never counts)'));
  console.log(`honest top-5 rate on first check: ${r.honestTop5Rate === null ? 'n/a' : `${(r.honestTop5Rate * 100).toFixed(1)}%`} (spec baseline 3%)`);
  console.log('limits: membership is the seed as of today; Steam privacy and Discord links are as of today');
  console.log('week        alerts holds honest-alerts honest-holds');
  for (const w of r.weeks) {
    console.log(`${w.week}  ${String(w.alerts).padStart(6)} ${String(w.holds).padStart(5)} ${String(w.honestAlerts).padStart(13)} ${String(w.honestHolds).padStart(12)}`);
  }
  for (const e of r.events) {
    console.log(`  match ${e.matchId} ${e.at.slice(0, 10)} ${e.steamid} ${e.level} vs ${e.person}: #${e.rank}, `
      + `${e.distance.toFixed(3)} <= ${e.threshold.toFixed(3)}${e.signs.length ? `, ${e.signs.join(', ')}` : ''}${e.honest ? '' : ' (known)'}`);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

The replay reads every ended match of every kind, as the sweep it replays does, so its `state IN ('completed', 'aborted')` is one raw filter `tests/matchKindGuard.test.ts` must be told about. In that file's `ALLOWED`, after the `'src/inputBursts.ts': 1, ...` line, add:

```ts
  'src/fingerprintReplay.ts': 1,    // replays every match end, every kind, as the end-of-match sweep does
```

Run: `npx vitest run tests/fingerprintReplay.test.ts tests/matchKindGuard.test.ts`
Expected: PASS. Rehearse the script only on a throwaway database: `d=$(mktemp -d) && npx tsx -e "import('./src/db.js').then(m => m.openDb('$d/x.db').close())" && npx tsx scripts/fingerprint-replay.ts --db "$d/x.db"` prints `0 match ends`. Running it on a real backup copy is the owner's call after this plan; never on the live file.

- [ ] **Step 5: Commit**

```bash
git add src/fingerprintReplay.ts scripts/fingerprint-replay.ts tests/fingerprintReplay.test.ts tests/matchKindGuard.test.ts
git commit -m "Fingerprint history replay: as-of decisions over every match end, on a copy only" -- src/fingerprintReplay.ts scripts/fingerprint-replay.ts tests/fingerprintReplay.test.ts tests/matchKindGuard.test.ts
```

---

### Task 19: Whole-branch verification

**Files:** none new.

- [ ] **Step 1: Full suite and typecheck**

Run: `npm test && npm run typecheck && npm run build`
Expected: both typecheck projects are clean, the web build succeeds, and every test passes except those that already failed at START. On 2026-10-17 these failed in this checkout before any of this work: `web/src/replay/Viewer.test.tsx` (portrait layout) and the upload tests in `tests/eventBanners.test.ts`, `tests/teamRoutes.test.ts`, `tests/draftIdentity.test.ts` (HTTP 507, a free-disk check). Run the suite once at START to get the current list, and compare against it.

- [ ] **Step 2: Leftovers and the dash rule**

Run:

```bash
grep -rnw "EvaderFlag\|flagEvader\|clearEvader\|evaderFlagOf\|evaderFlag" src web/src; \
grep -rnP "\x{2014}|\x{2013}" src web/src tests scripts docs/superpowers/plans/2026-10-17-evader-fingerprints.md
```

Expected: no output from either command.

- [ ] **Step 3: Confirm nothing outside this plan's files was committed**

Run: `git log --stat START..HEAD -- ops/` (START is the commit recorded before Task 1)
Expected: no output. `ops/README.md` and `ops/pug-db-backup.sh` belong to another session and stay uncommitted.

- [ ] **Step 4: Hand-off note for the owner (no deploy here)**

Rollout per spec section 6, each step an owner decision and none part of this plan: deploy web with `deploy-web.sh` (setting ships `off`); back up the DB; run `scripts/seed-evader-people.ts` then `scripts/backfill-network-asn.ts` (dry runs first); run `scripts/fingerprint-replay.ts --required` on a backup copy and send the numbers; switch `evader_fingerprint` to `alert` for a week; then `full` if the alerts are sane.

---

## Spec coverage

| Spec item | Task |
|---|---|
| `evader_people`, `evader_members`, migration of `evader_flags`, `isFlagged` parity, flags kept read-only | 5 |
| Add to person / Remove from person / close, file Identity swap | 6, 14 |
| `player_networks.asn`/`as_org`, iptoasn ip2asn-v4 in memory, weekly refresh | 2, 4 |
| `src/networkKinds.ts` curated list + name heuristic + `vpn_asns_extra` | 3 |
| ASN backfill from chat logs | 17 |
| Fingerprint: classes, 2..20 ticks, TV distance, 15/30/2 rule | 1 |
| `fingerprint_cache`, rebuild on new play | 5, 7 |
| Hook after auto-bhop in `scanEndedMatches`, `evader_fingerprint` setting | 11 |
| Who: non-member, no ban, new (15 rated / 30 days) | 9 |
| Enough data 150, top 5, per-person threshold p90 / fallback 0.25 | 1, 7 |
| Second signs 1 to 5 | 9 |
| Once per level, escalation, `fingerprint_alerts` | 11 |
| Alert / hold posts, mod channel, mod-role ping, medians table, VPN-tagged connections | 10, 11 |
| `alt_holds.source`/`person_id`, cleared suppression, release path unchanged | 8 |
| Ban as same person (+ Discord), cache marked stale | 12, 13, 14 |
| Known evaders cards, fingerprint badge on holds | 13, 14 |
| Staff guide section | 15 |
| Seed (dethisa incl. "dethisa (pre-ban)" by name, shove) | 5, 16 |
| Failure handling: logged, never blocks; missing ASN table not counted, logged hourly | 11 |
| Unit tests listed in spec section 5 | 1, 5, 7, 8, 9, 11 |
| History replay with indianstreetfood and nepmir checks, honest per-week counts | 18 |
| Rollout | 19 (hand-off only) |

Not built, on purpose: survivor press classes. The spec adds them only if a measurement shows they lower the honest false-match rate below 3%; the replay's `honestTop5Rate` is the number that measurement would be compared against.
